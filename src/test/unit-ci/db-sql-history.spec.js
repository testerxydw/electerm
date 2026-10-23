const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/app/lib/db-sql-history.js')
const FRONT = path.join(ROOT, 'src/client/common/db-sql-history.js')

// S3-C SQL 执行历史（doc/设计-数据库阶段3-2026-10-22.md §2）：
// 存储已从渲染层 localStorage 迁至主进程固定文件（userData/db-sql-history.json）——
// UI server 动态端口导致 origin 漂移、localStorage 跨启动互相隔离，历史读空。
// 本 spec 测主进程实现（纯 fs，无 electron 依赖），文件路径用临时目录隔离。
const h = require(MOD)

const entry = (sql, extra = {}) => ({
  sql,
  dbType: 'mysql',
  dbHost: 'h1',
  dbName: 'db1',
  ok: true,
  ...extra
})

describe('db-sql-history (main-process file store)', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-sql-history-'))
    file = path.join(dir, 'db-sql-history.json')
  })

  test('append 后 list 返回最新在前（时间倒序），跨调用（跨启动）可读', () => {
    h.appendSqlHistory(entry('SELECT 1'), file)
    h.appendSqlHistory(entry('SELECT 2'), file)
    const list = h.listSqlHistory(file)
    assert.equal(list.length, 2)
    assert.equal(list[0].sql, 'SELECT 2')
    assert.equal(list[1].sql, 'SELECT 1')
  })

  test('环形上限 200：超出丢最旧', () => {
    for (let i = 0; i < 205; i++) {
      h.appendSqlHistory(entry('SELECT ' + i), file)
    }
    const list = h.listSqlHistory(file)
    assert.equal(list.length, 200)
    assert.equal(list[0].sql, 'SELECT 204')
    assert.equal(list[199].sql, 'SELECT 5')
  })

  test('全局去重 + MRU：任意位置命中即提升最前并刷新时间', () => {
    h.appendSqlHistory(entry('SELECT 1', { ts: 100 }), file)
    h.appendSqlHistory(entry('SELECT 2', { ts: 200 }), file)
    h.appendSqlHistory(entry('SELECT 3', { ts: 300 }), file)
    // 重跑最老的 SELECT 1：旧条目移除，新条目（新 ts）置顶
    h.appendSqlHistory(entry('SELECT 1', { ts: 400 }), file)
    const list = h.listSqlHistory(file)
    assert.deepEqual(list.map(x => x.sql), ['SELECT 1', 'SELECT 3', 'SELECT 2'])
    assert.equal(list[0].ts, 400)
  })

  test('格式化前后视为同一语句：空白差异归一化后去重', () => {
    h.appendSqlHistory(entry('SELECT * FROM t;', { ts: 100 }), file)
    // 格式化后的形态（换行/多空格缩进）归一化等价 → 合并不新增
    h.appendSqlHistory(entry('SELECT *\n  FROM t;', { ts: 200 }), file)
    const list = h.listSqlHistory(file)
    assert.equal(list.length, 1)
    assert.equal(list[0].ts, 200)
    // 存储保留最新原文（格式化后的形态），回填即最新写法
    assert.equal(list[0].sql, 'SELECT *\n  FROM t;')
  })

  test('失败语句也记录（ok:false）', () => {
    h.appendSqlHistory(entry('BAD SQL', { ok: false }), file)
    const list = h.listSqlHistory(file)
    assert.equal(list.length, 1)
    assert.equal(list[0].ok, false)
  })

  test('字段白名单：多余字段与敏感字段被剔除，空 sql 不写入', () => {
    h.appendSqlHistory({
      ...entry('SELECT 1'),
      password: 'secret',
      result: { big: 'payload' }
    }, file)
    h.appendSqlHistory(null, file)
    h.appendSqlHistory({ sql: '' }, file)
    const list = h.listSqlHistory(file)
    assert.equal(list.length, 1)
    const [item] = list
    assert.deepEqual(
      Object.keys(item).sort(),
      ['dbHost', 'dbName', 'dbType', 'ok', 'sql', 'ts']
    )
    assert.ok(!JSON.stringify(list).includes('secret'))
    assert.ok(!JSON.stringify(list).includes('payload'))
  })

  test('损坏 JSON 容错：返回空列表且后续可写', () => {
    fs.writeFileSync(file, '{broken json')
    assert.deepEqual(h.listSqlHistory(file), [])
    h.appendSqlHistory(entry('SELECT 1'), file)
    assert.equal(h.listSqlHistory(file).length, 1)
  })

  test('非数组 JSON 容错', () => {
    fs.writeFileSync(file, '{"a":1}')
    assert.deepEqual(h.listSqlHistory(file), [])
  })

  test('clearSqlHistory 清空', () => {
    h.appendSqlHistory(entry('SELECT 1'), file)
    h.clearSqlHistory(file)
    assert.deepEqual(h.listSqlHistory(file), [])
  })

  test('原子写：不残留 .tmp 文件', () => {
    h.appendSqlHistory(entry('SELECT 1'), file)
    assert.equal(fs.existsSync(file + '.tmp'), false)
  })

  test('前端接口已切 IPC 主进程通道（防回退 localStorage 实现）', () => {
    const src = fs.readFileSync(FRONT, 'utf8')
    assert.ok(src.includes("runGlobalAsync('dbSqlHistoryOp'"), 'frontend must call main-process IPC')
    // 反向断言匹配调用形式而非裸词（注释解释性提及不算）
    assert.ok(!/window\.localStorage|localStorage\./.test(src), 'frontend must not use localStorage (origin 漂移隔离)')
  })

  test('ipc.js 已注册 dbSqlHistoryOp 白名单通道', () => {
    const ipc = fs.readFileSync(path.join(ROOT, 'src/app/lib/ipc.js'), 'utf8')
    assert.ok(ipc.includes('dbSqlHistoryOp'), 'asyncGlobals must export dbSqlHistoryOp')
    assert.ok(ipc.includes("join(app.getPath('userData'), 'db-sql-history.json')"), 'store file must be under userData')
  })

  test('历史列表不得用 flex 1 1 0 + 不定高容器（塌陷为 0，test.247 实测）', () => {
    const styl = fs.readFileSync(
      path.join(ROOT, 'src/client/components/database/db-session.styl'), 'utf8'
    )
    const block = styl.match(/\.db-history-list\n([\s\S]*?)\n\./)
    assert.ok(block, 'db-history-list style block missing')
    // 早先弹层只有 max-height、高度不定，basis 0 会让列表塌成 0（test.247 实测）。
    // 现在高度由内联 style 钉死（可拖拽 + 持久化），列表必须改回 flex 1 1 0 + min-height 0：
    // 用 0 1 auto 会按内容撑高，把预览栏挤出去
    const pop = styl.match(/\.db-history-pop\n([\s\S]*?)\n\.db-history-head/)
    assert.ok(pop, 'db-history-pop style block missing')
    assert.ok(!/^ {2}max-height /m.test(pop[1]), 'pop 高度由 JS 内联给，不再用 max-height 限高')
    assert.ok(/^ {2}flex 1 1 0$/m.test(block[1]), 'list must fill remaining height (flex 1 1 0)')
    assert.ok(/^ {2}min-height 0$/m.test(block[1]), 'min-height 0 required for scroll inside flex')
  })

  test('弹层尺寸由内联 style 给（拖拽 + 持久化），CSS 只留兜底', () => {
    const jsx = fs.readFileSync(
      path.join(ROOT, 'src/client/components/database/db-session.jsx'), 'utf8'
    )
    assert.ok(jsx.includes('style={{ width: histSize.width, height: histSize.height }}'),
      'popover size must come from state')
    assert.ok(jsx.includes('data-split={splitMode(histSize.width)}'),
      'split mode must be derived from width')
    // 一次拖拽只落一次盘：setConfig 必须在 pointerup 之后，不能在 pointermove 里
    const drag = jsx.slice(jsx.indexOf('const startHistResize'), jsx.indexOf('const moveHist'))
    assert.ok(drag.includes("window.addEventListener('pointermove', move)"))
    assert.ok(/const up = \(\) => \{[\s\S]*?setConfig\(sizePatch/.test(drag),
      'setConfig must run on pointerup, not every frame')
  })
})
