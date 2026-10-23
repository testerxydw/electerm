// E2-2 结果集视角的持久化通道（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.4）
//
// 主进程存储在 src/app/lib/db-grid-views.js，纯 fs、无 electron 依赖，
// 用临时目录隔离 filePath 直接测；渲染层包装是 ESM，CJS 测试进程里 require 吃不下，
// 因此用 vm 执行 src 下的同一份源码（照 db-sql-risk.spec.js 的做法）——
// 禁止"测试拷贝实现"，否则实现漂移时测试会变成自证。
//
// 时间控制：updatedAt 由主进程 Date.now() 写入，同一毫秒内的多条目排序依赖
// Array#sort 的稳定性，不加控制会出现偶发红。这里临时替换 Date.now 为自增计数器，
// LRU 顺序断言才是确定性的（也才能真正杀掉"上限改了/排序方向反了"的变异）。
const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/app/lib/db-grid-views.js')
const FRONT = path.join(ROOT, 'src/client/common/db-grid-views.js')

const g = require(MOD)

// 键格式 `<conn>|<db>|<schema>|<table>`，由渲染层 db-grid-view.js 的 viewKey 生成
const viewKey = (conn, db, schema, table) => [conn, db, schema, table].join('|')

// 跨 realm 归一：vm 沙箱里 new 出来的对象原型不是测试进程这个 realm 的
// Object.prototype，断言深层相等时会因"结构相同但原型不同"报红。
// JSON 往返把它还原成本 realm 的普通对象——这恰好也是参数过 IPC 后的真实形态。
const plain = (x) => JSON.parse(JSON.stringify(x))

const seedView = (extra = {}) => ({
  conditions: [{ column: 'name', op: 'eq', value: 'alice' }],
  order: [{ column: 'id', desc: true }],
  pageSize: 100,
  hiddenColumns: ['blob_col'],
  columnWidths: { name: 180 },
  columnOrder: ['id', 'name'],
  ...extra
})

// 临时接管 Date.now：每次调用自增 1，保证 updatedAt 严格单调可比
function withClock (fn) {
  const real = Date.now
  let tick = 1700000000000
  Date.now = () => {
    tick += 1
    return tick
  }
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

// 在沙箱里执行前端包装源码，注入假的 window.pre.runGlobalAsync
function loadFront (runGlobalAsync) {
  const src = fs.readFileSync(FRONT, 'utf8').replace(/^export /gm, '')
  const warnings = []
  const sandbox = {
    window: { pre: { runGlobalAsync } },
    console: {
      warn: (...args) => warnings.push(args),
      log: () => {},
      error: () => {}
    },
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Promise,
    TypeError
  }
  vm.createContext(sandbox)
  const api = vm.runInContext(
    src + '\n({ listGridViews, getGridView, saveGridView, removeGridView })',
    sandbox
  )
  return { api, warnings }
}

// 渲染层视角模块（键的拼装方）：vm 加载同一份源码，只为校验"两边键逐字符一致"这一契约
function loadRendererViewModule () {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/client/common/db-grid-view.js'), 'utf8'
  ).replace(/^export /gm, '')
  // 沙箱只给纯计算需要的全局对象；逐个赋值而不是字面量，
  // 免得十几个属性挤在一行被 lint 拆散
  const sandbox = {}
  const names = [
    'Math', 'Number', 'String', 'Array', 'Object', 'RegExp', 'JSON',
    'Set', 'Map', 'Date', 'Boolean', 'Intl',
    'isNaN', 'parseInt', 'parseFloat', 'Error', 'TypeError', 'RangeError'
  ]
  for (const name of names) {
    sandbox[name] = global[name]
  }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n({ viewKey, normalizeView })', sandbox)
}

describe('db-grid-views (main-process file store)', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-grid-views-'))
    file = path.join(dir, 'db-grid-views.json')
  })

  const readRaw = () => fs.readFileSync(file, 'utf8')
  const readJson = () => JSON.parse(readRaw())

  // ---------------------------------------------------------------- LRU / 结构

  // 本条杀掉：上限常量被改动（200→201/199）、淘汰方向反转、淘汰不看 updatedAt 只看插入序
  test('LRU 上限 200：写第 201 个视角时淘汰 updatedAt 最旧者，总数仍为 200', () => {
    withClock(() => {
      for (let i = 0; i < 200; i++) {
        assert.ok(g.saveGridView(viewKey('c', 'd', 's', 't' + i), seedView(), file))
      }
      assert.equal(Object.keys(g.listGridViews(file)).length, 200)

      const newestKey = viewKey('c', 'd', 's', 't200')
      assert.ok(g.saveGridView(newestKey, seedView(), file))

      const views = g.listGridViews(file)
      assert.equal(Object.keys(views).length, 200, '总数必须卡死在 200')
      assert.equal(views[viewKey('c', 'd', 's', 't0')], undefined, '最旧键必须被淘汰')
      assert.ok(views[viewKey('c', 'd', 's', 't1')], '次旧键必须保留')
      assert.ok(views[newestKey], '新写入的视角不能被自己淘汰掉')
    })
  })

  test('LRU 按 updatedAt 而非写入顺序：重存旧键后，被淘汰的是次旧者', () => {
    withClock(() => {
      for (let i = 0; i < 200; i++) {
        g.saveGridView(viewKey('c', 'd', 's', 't' + i), seedView(), file)
      }
      // 重存 t0：它刚被访问，updatedAt 变成最新，不再是最旧者
      g.saveGridView(viewKey('c', 'd', 's', 't0'), seedView(), file)
      g.saveGridView(viewKey('c', 'd', 's', 't200'), seedView(), file)

      const views = g.listGridViews(file)
      assert.equal(Object.keys(views).length, 200)
      assert.ok(views[viewKey('c', 'd', 's', 't0')], '刚访问过的键不能被淘汰')
      assert.equal(views[viewKey('c', 'd', 's', 't1')], undefined, '此时最旧的是 t1')
    })
  })

  // 本条杀掉：updatedAt 改由调用方传入（LRU 顺序可被伪造，上限失守但表面无异常）
  test('updatedAt 由主进程写：调用方传入的 updatedAt 被覆盖成当前时间', () => {
    withClock(() => {
      const saved = g.saveGridView(
        viewKey('c', 'd', 's', 't'),
        seedView({ updatedAt: 1 }),
        file
      )
      assert.ok(saved, '保存应成功')
      assert.notEqual(saved.updatedAt, 1, '调用方传入的 updatedAt 必须被丢弃')
      assert.ok(saved.updatedAt > 1700000000000, 'updatedAt 必须是主进程当前时间')
      // 落盘文件里的值同样是被覆盖后的，不是调用方那个 1
      const onDisk = readJson().views[viewKey('c', 'd', 's', 't')]
      assert.notEqual(onDisk.updatedAt, 1)
      assert.equal(onDisk.updatedAt, saved.updatedAt)
    })
  })

  test('同键重复保存不增加条数，且后写覆盖前写', () => {
    const key = viewKey('c', 'd', 's', 't')
    withClock(() => {
      g.saveGridView(key, seedView({ pageSize: 50 }), file)
      g.saveGridView(key, seedView({ pageSize: 200 }), file)
      const views = g.listGridViews(file)
      assert.equal(Object.keys(views).length, 1, '同键必须合并成一条')
      assert.equal(views[key].pageSize, 200)
    })
  })

  test('文件结构为 {version:1, views:{...}}，键形如 <conn>|<db>|<schema>|<table>', () => {
    const key = viewKey('conn1', 'db1', '', 'orders')
    withClock(() => g.saveGridView(key, seedView(), file))
    const onDisk = readJson()
    assert.equal(onDisk.version, 1)
    assert.deepEqual(Object.keys(onDisk.views), [key])
    assert.equal(key, 'conn1|db1||orders', '四段式键，空段保留分隔符')
  })

  test('读取缺失文件返回 {}，get 返回 null', () => {
    assert.deepEqual({ ...g.listGridViews(file) }, {})
    assert.equal(g.getGridView(viewKey('c', 'd', 's', 't'), file), null)
  })

  test('文件内容损坏（半截 JSON）时 list 返回 {}、get 返回 null', () => {
    fs.writeFileSync(file, '{')
    assert.deepEqual({ ...g.listGridViews(file) }, {})
    assert.equal(g.getGridView(viewKey('c', 'd', 's', 't'), file), null)
    // 损坏后仍可正常写入（不被坏文件锁死）
    withClock(() => assert.ok(g.saveGridView(viewKey('c', 'd', 's', 't'), seedView(), file)))
    assert.equal(Object.keys(g.listGridViews(file)).length, 1)
  })

  test('顶层非对象 / views 非对象的容错', () => {
    fs.writeFileSync(file, '[]')
    assert.deepEqual({ ...g.listGridViews(file) }, {})
    fs.writeFileSync(file, '{"version":1,"views":[1,2]}')
    assert.deepEqual({ ...g.listGridViews(file) }, {})
  })

  test('原子写：落盘不残留 .tmp', () => {
    withClock(() => g.saveGridView(viewKey('c', 'd', 's', 't'), seedView(), file))
    assert.equal(fs.existsSync(file + '.tmp'), false)
  })

  test('键与渲染层 viewKey 逐字符一致：渲染层拼的键能直接存取（跨模块契约）', () => {
    const rv = loadRendererViewModule()
    const target = { connectionId: 'conn1', dbName: 'db1', schema: undefined, table: 'orders' }
    const key = rv.viewKey(target)
    // 四段 + undefined 归一成空串：'conn1|db1||orders'
    assert.equal(key, 'conn1|db1||orders')

    withClock(() => assert.ok(g.saveGridView(key, seedView(), file), '渲染层拼的键必须能直接存'))
    assert.deepEqual(Object.keys(readJson().views), [key])
    assert.ok(g.getGridView(key, file), '同一键必须能读回')
    // 全空 target 的键是 '|||'（非空，可存）——不能因为"看起来像空"被拒
    assert.equal(rv.viewKey({}), '|||')
    withClock(() => assert.ok(g.saveGridView('|||', seedView(), file)))
  })

  test('渲染层 normalizeView 能吃下本模块落盘的视角（字段名一一对应）', () => {
    const rv = loadRendererViewModule()
    const key = viewKey('conn1', 'db1', '', 'orders')
    const saved = withClock(() => g.saveGridView(key, seedView({
      conditions: [{ column: 'a', op: 'eq', value: 1 }]
    }), file))
    const normalized = plain(rv.normalizeView(g.getGridView(key, file)))
    assert.deepEqual(
      Object.keys(normalized).sort(),
      ['columnOrder', 'columnWidths', 'conditions', 'hiddenColumns', 'order', 'pageSize']
    )
    assert.deepEqual(normalized.conditions, [{ column: 'a', op: 'eq', value: 1 }])
    assert.deepEqual(normalized.order, saved.order)
    assert.equal(normalized.pageSize, saved.pageSize)
    assert.deepEqual(normalized.hiddenColumns, saved.hiddenColumns)
    assert.deepEqual(normalized.columnWidths, saved.columnWidths)
  })

  // ------------------------------------------------------------ 白名单 / 裁剪

  // 本条杀掉：白名单退化成"照抄整个对象"（凭据/结果行落盘是安全边界问题）
  test('字段白名单：password/rows 等非视角字段不落盘（读原文断言）', () => {
    const key = viewKey('c', 'd', 's', 't')
    const saved = withClock(() => g.saveGridView(key, {
      ...seedView(),
      password: 'super-secret',
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, v: 'row-payload' })),
      connection: { host: 'h', user: 'u', password: 'p@ss' },
      __proto__dummy: 'x',
      conditions: [{ column: 'a', op: 'eq', value: 1, secretExtra: 'zzz' }]
    }, file))

    assert.ok(saved, '合法视角应保存成功')
    const raw = readRaw()
    assert.ok(!raw.includes('super-secret'), '凭据不得落盘')
    assert.ok(!raw.includes('row-payload'), '结果行不得落盘')
    assert.ok(!raw.includes('"rows"'), 'rows 字段不得落盘')
    assert.ok(!raw.includes('"password"'), 'password 字段不得落盘')
    assert.ok(!raw.includes('"connection"'), '连接对象不得落盘')
    assert.ok(!raw.includes('secretExtra'), '条件里多余字段不得落盘')

    assert.deepEqual(
      Object.keys(readJson().views[key]).sort(),
      ['columnOrder', 'columnWidths', 'conditions', 'hiddenColumns', 'order',
        'pageSize', 'seq', 'updatedAt']
    )
    assert.deepEqual(
      Object.keys(readJson().views[key].conditions[0]).sort(),
      ['column', 'op', 'value']
    )
  })

  test('conditions 超过 20 条被截到 20（落盘文件同样只有 20 条）', () => {
    const key = viewKey('c', 'd', 's', 't')
    const many = Array.from({ length: 25 }, (_, i) => ({
      column: 'c' + i, op: 'eq', value: i
    }))
    const saved = withClock(() => g.saveGridView(key, seedView({ conditions: many }), file))
    assert.equal(saved.conditions.length, 20)
    assert.equal(readJson().views[key].conditions.length, 20, '截断必须发生在写盘前')
    assert.equal(saved.conditions[19].column, 'c19')
  })

  test('order 超过 3 条被截到 3，desc 只认严格 true', () => {
    const key = viewKey('c', 'd', 's', 't')
    const order = [
      { column: 'a', desc: true },
      { column: 'b', desc: 'false' },
      { column: 'c', desc: 1 },
      { column: 'd', desc: false },
      { column: 'e', desc: true }
    ]
    const saved = withClock(() => g.saveGridView(key, seedView({ order }), file))
    assert.equal(saved.order.length, 3, '排序项最多 3 条')
    assert.deepEqual(saved.order, [
      { column: 'a', desc: true },
      { column: 'b', desc: false },
      { column: 'c', desc: false }
    ])
    assert.equal(readJson().views[key].order.length, 3)
  })

  test('hiddenColumns/columnOrder 只留字符串，columnWidths 只留正数', () => {
    const key = viewKey('c', 'd', 's', 't')
    const saved = withClock(() => g.saveGridView(key, seedView({
      hiddenColumns: ['a', 1, null, 'b', {}, 'c'],
      columnOrder: ['x', undefined, 'y', 3],
      columnWidths: { a: 120, b: -5, c: 0, d: '200', e: Number.NaN, f: 88 }
    }), file))

    assert.deepEqual(saved.hiddenColumns, ['a', 'b', 'c'])
    assert.deepEqual(saved.columnOrder, ['x', 'y'])
    assert.deepEqual(saved.columnWidths, { a: 120, f: 88 })
    assert.deepEqual(readJson().views[key].columnWidths, { a: 120, f: 88 })
  })

  test('条件里的数组值最多 200 项', () => {
    const key = viewKey('c', 'd', 's', 't')
    const values = Array.from({ length: 500 }, (_, i) => 'v' + i)
    const saved = withClock(() => g.saveGridView(key, seedView({
      conditions: [{ column: 'a', op: 'in', value: values }]
    }), file))
    assert.equal(saved.conditions[0].value.length, 200)
    assert.equal(saved.conditions[0].value[0], 'v0')
  })

  test('非对象 view 不抛错，落盘为空视角', () => {
    const key = viewKey('c', 'd', 's', 't')
    const saved = withClock(() => g.saveGridView(key, null, file))
    assert.ok(saved, '非法 view 按空视角处理而不是崩')
    assert.deepEqual(saved.conditions, [])
    assert.deepEqual(saved.order, [])
    // 未设置页大小时不落该键：0 会被渲染层当成"设过 0"，
    // 与 normalizePageSize 的"未设置"语义（undefined）冲突
    assert.equal(saved.pageSize, undefined)
    assert.equal('pageSize' in readJson().views[key], false)
  })

  test('页大小只认正整数：字符串数字归一、小数/负数/0 一律视为未设置', () => {
    const key = viewKey('c', 'd', 's', 't')
    const cases = [
      ['100', 100],
      [500, 500],
      [0, undefined],
      [-20, undefined],
      [12.5, undefined],
      ['abc', undefined],
      [true, undefined],
      [null, undefined]
    ]
    for (const [input, expect] of cases) {
      const saved = withClock(() => g.saveGridView(key, seedView({ pageSize: input }), file))
      assert.equal(saved.pageSize, expect, 'pageSize 输入 ' + JSON.stringify(input))
    }
  })

  // ------------------------------------------------------------------ 键校验

  test('空 key / 纯空白 key 不写盘且返回 null', () => {
    for (const bad of ['', '   ', '\t']) {
      assert.equal(g.saveGridView(bad, seedView(), file), null, 'bad key: ' + JSON.stringify(bad))
    }
    assert.equal(fs.existsSync(file), false, '非法键不得创建文件')
    assert.equal(g.getGridView('', file), null)
    assert.equal(g.removeGridView('', file), false)
  })

  test('含换行的 key 被拒（不写盘、返回 null）', () => {
    for (const bad of ['a|b\nc|d', 'a|b\r\nc|d']) {
      assert.equal(g.saveGridView(bad, seedView(), file), null)
    }
    assert.equal(fs.existsSync(file), false)
    assert.equal(g.getGridView('a|b\nc|d', file), null)
    assert.equal(g.removeGridView('a|b\nc|d', file), false)
  })

  test('非字符串 key 被拒', () => {
    for (const bad of [undefined, null, 0, 123, {}, [], true]) {
      assert.equal(g.saveGridView(bad, seedView(), file), null, 'bad key: ' + String(bad))
    }
    assert.equal(fs.existsSync(file), false)
  })

  // ------------------------------------------------------------------ 删除

  test('remove 存在的键返回 true 并落盘；不存在的键返回 false 且不抛（幂等）', () => {
    const key = viewKey('c', 'd', 's', 't')
    withClock(() => {
      g.saveGridView(key, seedView(), file)
      assert.equal(g.removeGridView(key, file), true)
      assert.equal(g.getGridView(key, file), null)
      assert.deepEqual({ ...g.listGridViews(file) }, {}, '删除必须落盘，不能只改内存')

      // 再删一次：幂等成功语义，返回 false 表示"没删掉（本来就没有）"
      assert.equal(g.removeGridView(key, file), false)
      assert.equal(g.removeGridView(viewKey('x', 'y', 'z', 'w'), file), false)
    })
  })

  test('删到空后文件仍是合法结构', () => {
    const key = viewKey('c', 'd', 's', 't')
    withClock(() => {
      g.saveGridView(key, seedView(), file)
      g.removeGridView(key, file)
    })
    const onDisk = readJson()
    assert.equal(onDisk.version, 1)
    assert.deepEqual(onDisk.views, {})
    assert.equal(fs.existsSync(file + '.tmp'), false)
  })
})

describe('db-grid-views (renderer wrapper over dbGridViewOp IPC)', () => {
  test('正常路径：走 dbGridViewOp，action 与参数形态与主进程对齐', async () => {
    const calls = []
    const { api } = loadFront(async (name, action, arg) => {
      calls.push([name, action, arg])
      if (action === 'list') {
        return { k: { conditions: [] } }
      }
      if (action === 'save') {
        return { ...arg.view, updatedAt: 1 }
      }
      if (action === 'get') {
        return { conditions: [], updatedAt: 2 }
      }
      return true
    })

    const list = await api.listGridViews()
    assert.deepEqual(list, { k: { conditions: [] } }, 'list 原样返回主进程的视角表')

    const view = { conditions: [{ column: 'a', op: 'eq', value: 1 }], pageSize: 50 }
    const saved = await api.saveGridView('c|d|s|t', view)
    assert.equal(saved.pageSize, 50)

    const got = await api.getGridView('c|d|s|t')
    assert.equal(got.updatedAt, 2)

    const removed = await api.removeGridView('c|d|s|t')
    assert.equal(removed, true)

    assert.deepEqual(calls.map(c => c[0]), [
      'dbGridViewOp', 'dbGridViewOp', 'dbGridViewOp', 'dbGridViewOp'
    ])
    assert.deepEqual(calls.map(c => c[1]), ['list', 'save', 'get', 'remove'])
    // get / remove 传 {key}，save 传 {key, view}——主进程按 a.key / a.view 解构
    assert.deepEqual(plain(calls[1][2]), { key: 'c|d|s|t', view })
    assert.deepEqual(plain(calls[2][2]), { key: 'c|d|s|t' })
    assert.deepEqual(plain(calls[3][2]), { key: 'c|d|s|t' })
  })

  test('IPC 抛错时降级返回 {}/null/false，不把异常抛给调用方', async () => {
    const { api, warnings } = loadFront(async () => {
      throw new Error('ipc boom')
    })

    // list 失败与成功同形态（都是普通对象），调用方不必区分空数组与空对象
    const empty = await api.listGridViews()
    assert.equal(Array.isArray(empty), false, 'list 失败不得返回数组（形态要与成功路径一致）')
    assert.deepEqual(plain(empty), {}, 'list 失败返回 {}')
    assert.equal(await api.getGridView('k'), null, 'get 失败返回 null')
    assert.equal(await api.saveGridView('k', { conditions: [] }), null, 'save 失败返回 null')
    assert.equal(await api.removeGridView('k'), false, 'remove 失败返回 false')
    assert.equal(warnings.length, 4, '失败要 console.warn 留痕，便于现场排查')
  })

  test('返回值形态异常（null/字符串/数组）时不把脏数据透给 UI', async () => {
    const { api } = loadFront(async (name, action) => {
      if (action === 'list') {
        return 'oops'
      }
      if (action === 'remove') {
        return 'true'
      }
      return null
    })
    assert.deepEqual(plain(await api.listGridViews()), {}, 'list 非对象时回落到 {}')
    assert.equal(await api.getGridView('k'), null)
    assert.equal(await api.saveGridView('k', {}), null)
    assert.equal(await api.removeGridView('k'), false, '字符串 "true" 不算删除成功')

    // 数组同样不算合法视角表（主进程成功路径永远返回普通对象）
    const { api: apiArr } = loadFront(async (name, action) => {
      if (action === 'list') {
        return ['nope']
      }
      return null
    })
    const arr = await apiArr.listGridViews()
    assert.equal(Array.isArray(arr), false, '数组不得透传')
    assert.deepEqual(plain(arr), {})
  })

  test('空 key 不发 IPC（少发请求，且主进程侧也只是必然失败的调用）', async () => {
    const calls = []
    const { api } = loadFront(async (name, action, arg) => {
      calls.push([action, arg])
      return null
    })
    assert.equal(await api.getGridView(''), null)
    assert.equal(await api.saveGridView('', {}), null)
    assert.equal(await api.removeGridView(''), false)
    assert.deepEqual(calls, [], '空 key 不应产生 IPC 调用')
  })

  test('前端不走 localStorage（origin 漂移隔离），且只经 dbGridViewOp 通道', () => {
    const src = fs.readFileSync(FRONT, 'utf8')
    assert.ok(src.includes("runGlobalAsync('dbGridViewOp'"), '必须经主进程 IPC 通道')
    assert.ok(!/window\.localStorage|localStorage\./.test(src), '不得使用 localStorage')
    assert.ok(src.includes('<conn>|<db>|<schema>|<table>'), '键格式须与渲染层 viewKey 一致')
  })

  test('ipc.js 已注册 dbGridViewOp 白名单通道，惰性 require，未知 action 报错', () => {
    const ipc = fs.readFileSync(path.join(ROOT, 'src/app/lib/ipc.js'), 'utf8')
    const at = ipc.indexOf('dbGridViewOp: async')
    assert.ok(at > -1, 'asyncGlobals 必须导出 dbGridViewOp')
    const block = ipc.slice(at, ipc.indexOf('setPassword', at))
    assert.ok(
      block.includes("join(app.getPath('userData'), 'db-grid-views.json')"),
      '存储文件必须在 userData 下'
    )
    assert.ok(block.includes("require('./db-grid-views')"), '须惰性 require 存储模块')
    for (const action of ['list', 'get', 'save', 'remove']) {
      assert.ok(block.includes("action === '" + action + "'"), 'action 须白名单: ' + action)
    }
    assert.ok(
      block.includes("'unknown dbGridViewOp action: '"),
      '未知 action 须显式抛错（与兄弟通道同措辞）'
    )
    assert.ok(block.includes('arg || {}'), 'arg 缺省须兜住，避免直接调用时崩')
  })
})

// ---------------------------------------------------------------- 复审修复（QA 实测缺陷）
// 这三组对应 QA 独立验证挑出的问题：LRU 依据墙钟导致"保存成功但数据被立刻淘汰"、
// `{}` 当字符串映射让 __proto__ 穿透、以及 version 从未被读。
// 每条都必须能杀掉对应变异：把 LRU 改回按 updatedAt 排序 → 前两条必红；
// 把 views 换回 `{}` → 第三条必红；去掉 version 判断 → 第四条必红。
describe('db-grid-views: LRU 依据是单调 seq，不是墙钟', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-grid-views-'))
    file = path.join(dir, 'db-grid-views.json')
  })

  // 把 200 条写满：键名按序号排，写入顺序与序号一致
  const fill = (store, n = 200) => {
    withClock(() => {
      for (let i = 0; i < n; i++) {
        store.saveGridView('k' + String(i).padStart(4, '0'), { pageSize: 10 + i }, file)
      }
    })
  }

  test('时钟回拨 1 小时后保存：新键必须还在（按墙钟排会被立刻淘汰）', () => {
    const real = Date.now
    try {
      Date.now = () => 1700000000000
      fill(g, 200)
      // NTP 步进 / VM 快照恢复 / 手改系统时间都会让墙钟倒退
      Date.now = () => 1700000000000 - 3600 * 1000
      const saved = g.saveGridView('newest|a|b|c', { pageSize: 42 }, file)
      assert.equal(saved && saved.pageSize, 42, 'save 必须报成功')
      const after = g.listGridViews(file)
      assert.ok(
        Object.prototype.hasOwnProperty.call(after, 'newest|a|b|c'),
        '时钟回拨后刚保存的视角被立刻淘汰了 —— save 返回成功但什么都没记住'
      )
      assert.equal(Object.keys(after).length, 200, '条数仍在上限内')
    } finally {
      Date.now = real
    }
  })

  test('同一毫秒内更新已存在的键，再写入触发淘汰：刚更新的必须存活', () => {
    const real = Date.now
    try {
      // 冻结时钟：所有 updatedAt 相同，此时排序只能靠 seq
      Date.now = () => 1700000000000
      fill(g, 200)
      // 更新最早写入的那条（它的 updatedAt 与其它全部相同）
      g.saveGridView('k0000', { pageSize: 999 }, file)
      // 再写一条触发淘汰
      g.saveGridView('overflow|a|b|c', { pageSize: 7 }, file)
      const after = g.listGridViews(file)
      assert.ok(
        Object.prototype.hasOwnProperty.call(after, 'k0000'),
        '刚被更新过的视角被当成最旧淘汰了（墙钟同毫秒不可区分）'
      )
      assert.ok(Object.prototype.hasOwnProperty.call(after, 'overflow|a|b|c'), '刚写入的必须存活')
      assert.equal(Object.keys(after).length, 200)
    } finally {
      Date.now = real
    }
  })

  test('淘汰仍按最旧优先：seq 最小的先走，seq 最大的保留', () => {
    const real = Date.now
    try {
      Date.now = () => 1700000000000
      fill(g, 200)
      // k0000 最旧、k0199 最新
      g.saveGridView('k0000', { pageSize: 1 }, file)
      g.saveGridView('trigger|a|b|c', { pageSize: 2 }, file)
      const after = g.listGridViews(file)
      const seqs = Object.keys(after).map(k => Number(after[k].seq) || 0)
      // 200 条填满（seq 1..200）→ 重存 k0000（seq 201，但键数不变）
      // → 再写 trigger（seq 202）→ 共 201 键，淘汰 1 条 = seq 最小的 k0001
      assert.equal(Math.min(...seqs), 3, 'seq 最小的那条（k0001）应被淘汰')
      assert.ok(Math.max(...seqs) >= 201, '最新写入的 seq 最大')
      assert.equal(after.k0000.seq, 201, '刚被重存过的键 seq 最大之一，不得被淘汰')
    } finally {
      Date.now = real
    }
  })

  test('老文件（条目没有 seq）读入后 save 不报错，新条目 seq 从 1 开始', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      views: { 'legacy|a|b|c': { pageSize: 20, updatedAt: 1700000000000 } }
    }))
    const saved = g.saveGridView('fresh|a|b|c', { pageSize: 30 }, file)
    assert.equal(saved && saved.seq, 1, '无 seq 的旧条目按 0 计，新条目从 1 开始')
    assert.equal(g.getGridView('legacy|a|b|c', file).pageSize, 20, '旧视角仍可读')
  })
})

describe('db-grid-views: views 表必须是无原型对象（__proto__ 不许穿透）', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-grid-views-'))
    file = path.join(dir, 'db-grid-views.json')
  })

  test('返回对象的原型是 null，不是 Object.prototype', () => {
    g.saveGridView('a|b|c|d', { pageSize: 20 }, file)
    const out = g.listGridViews(file)
    assert.equal(Object.getPrototypeOf(out), null, '用 {} 当映射会让手改文件换掉返回对象的原型')
    assert.equal(out['a|b|c|d'].pageSize, 20)
  })

  test('全新文件上 getGridView(\'__proto__\') 返回 null，而不是 Object.prototype', () => {
    // 契约是"未命中/键非法返回 null"；`{}` 映射下这里会拿到 Object.prototype 本体
    assert.equal(g.getGridView('__proto__', file), null)
  })

  test('手改文件里的 __proto__ 不会变成可见的继承属性', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      views: {
        __proto__: { injected: 'YES' },
        'polluted|a|b|c': { pageSize: 999 }
      }
    }))
    const out = g.listGridViews(file)
    assert.equal(out.injected, undefined, '注入的继承属性不应可见')
    assert.ok(
      Object.prototype.hasOwnProperty.call(out, 'polluted|a|b|c'),
      '磁盘上真实存在的键仍要能读到'
    )
    assert.equal(Object.getPrototypeOf(out), null, '原型不得被换掉')
    // 再 save 一次后落盘仍然干净（自愈，且不把 __proto__ 写成可继承属性）
    g.saveGridView('new|a|b|c', { pageSize: 5 }, file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(Object.getPrototypeOf(raw.views), Object.prototype, '落盘 JSON 本身正常')
    assert.equal(raw.views['new|a|b|c'].pageSize, 5)
  })
})

describe('db-grid-views: version 不认识的整表视作空（注释与行为一致）', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-grid-views-'))
    file = path.join(dir, 'db-grid-views.json')
  })

  test('version: 99 → 空表', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 99, views: { 'a|b|c|d': { pageSize: 20 } } }))
    assert.deepEqual({ ...g.listGridViews(file) }, {})
    assert.equal(g.getGridView('a|b|c|d', file), null)
  })

  test('version 缺失 → 照常读（手改文件没有这个字段，不能因此清掉用户视角）', () => {
    fs.writeFileSync(file, JSON.stringify({ views: { 'a|b|c|d': { pageSize: 20 } } }))
    assert.equal(g.getGridView('a|b|c|d', file).pageSize, 20)
  })

  test('自己写出来的文件 version 恒为 1', () => {
    g.saveGridView('a|b|c|d', { pageSize: 20 }, file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(raw.version, 1)
  })
})
