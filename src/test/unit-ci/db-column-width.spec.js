// H1a-1 · 网格可读性统一层：单元格文本与列宽自适应（纯函数契约）
//
// 背景（设计 §1A.1）：5 处网格的长内容"看不到"，根因之一是列宽按 String(v) 量。
// 数据页原实现对 JSON/对象列得到的是 "[object Object]"（15 字符）→ 量出来永远是
// 90~212px 这一档，而单元格里渲染的是几十 KB 的真实 JSON。抽成 common 纯函数后
// 必须证明：对象按真实文本量宽、上下限与数据页原公式逐列一致、采样有上界。
//
// 测的是 src/client/common/db-column-width.js 的同一份源码（vm + strip export），
// 不许出现"测试拷贝实现"。
const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/db-column-width.js')

const EXPORTS = '({ COL_W_MIN, COL_W_MAX, COL_W_FALLBACK, COL_W_WIDE, COL_W_DRAG_MIN, COL_W_DRAG_MAX, isBinEnvelope, cellText, fitColumnWidths, wideFitColumnWidths, wideColumnWidth, clampDragWidth, pickColumnWidth, withManualWidth, withoutManualWidth })'

function loadMod () {
  const src = fs.readFileSync(MOD, 'utf8').replace(/^export /gm, '')
  const sandbox = {
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Object,
    Array,
    TypeError,
    console,
    module: { exports: {} }
  }
  sandbox.module.exports = {}
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;module.exports = ' + EXPORTS, sandbox, { filename: 'db-column-width.js' })
  return sandbox.module.exports
}

const bin = (size, truncated = false) => ({
  __bin: { size, b64: Buffer.alloc(Math.min(size, 8)).toString('base64'), truncated }
})

// vm realm 出来的对象与测试 realm 的原型不同，deepStrictEqual 会因引用判不等
const plain = (x) => JSON.parse(JSON.stringify(x))

const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const read = () => fs.readFileSync(JSX, 'utf8')
// H1a-4（网格复用整合）：数据页 / SQL 结果页的列定义并入公共列工厂，
// 两处网格的接线契约（ColHead/onCell/CELL_ELLIPSIS/三源选宽）跟着挪进工厂
const COLS = path.join(ROOT, 'src/client/components/database/db-grid-columns.jsx')
const readCols = () => fs.readFileSync(COLS, 'utf8')

// 组件里这些列定义都是 2 空格缩进的顶层 const：截到下一个 const 即为一整块
const region = (src, name) => {
  const s = src.indexOf('const ' + name + ' = useMemo')
  assert.ok(s > 0, name + ' memo not found')
  const next = src.indexOf('\n  const ', s + 10)
  const body = src.slice(s, next > s ? next : src.length)
  assert.ok(body.length < 6000, name + ' region looks unbounded (drifted marker)')
  return body
}

// 列 memo 的依赖数组就是这一块里最后一个 [...]（依赖总在 memo 收尾处）。
// 先摘掉整行注释：memo 与下一个 const 之间可能夹着说明文字，里面的 `[]`/`[i]`
// 会把 lastIndexOf 带到注释里
const depsOf = (body) => {
  const code = body.replace(/^\s*\/\/.*$/gm, '')
  const s = code.lastIndexOf('[')
  const e = code.indexOf(']', s)
  assert.ok(s > 0 && e > s, 'deps array not found')
  return code.slice(s + 1, e).split(',').map(x => x.trim()).filter(Boolean)
}

describe('cellText：悬停预览与原生 title 的唯一文本来源', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('NULL / undefined 显示为 NULL 而非空串', () => {
    assert.equal(m.cellText(null), 'NULL')
    assert.equal(m.cellText(undefined), 'NULL')
  })

  test('标量原样成字符串（0 / false / 空串不得被当成 NULL）', () => {
    assert.equal(m.cellText(0), '0')
    assert.equal(m.cellText(false), 'false')
    assert.equal(m.cellText(''), '')
    assert.equal(m.cellText('a,b'), 'a,b')
    assert.equal(m.cellText(1.5), '1.5')
  })

  test('对象按真实文本序列化 —— 原实现的 "[object Object]" 是量错宽度的根因', () => {
    const v = { id: 1, note: 'x'.repeat(300) }
    assert.equal(m.cellText(v), JSON.stringify(v))
    assert.ok(m.cellText(v).length > 300, 'JSON 全文不得被截短')
    assert.ok(!m.cellText(v).includes('[object Object]'))
  })

  test('数组同样走 JSON（Redis 详情 list 的行值就是数组）', () => {
    assert.equal(m.cellText([1, 'a']), '[1,"a"]')
  })

  test('循环引用不得抛异常：title 不该让整张表格崩掉', () => {
    const a = { name: 'a' }
    a.self = a
    assert.doesNotThrow(() => m.cellText(a))
    assert.equal(typeof m.cellText(a), 'string')
  })

  test('二进制信封给可读占位，不把 base64 灌进预览', () => {
    assert.equal(m.cellText(bin(4096)), '<binary 4096 bytes>')
    assert.ok(!m.cellText(bin(4096)).includes('AA'))
  })
})

describe('isBinEnvelope：只认形状，不猜语义', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('完整形状才为真', () => {
    assert.equal(m.isBinEnvelope(bin(10)), true)
    assert.equal(m.isBinEnvelope(bin(10, true)), true)
  })

  test('字段缺失/类型不符/数组/null 一律为假', () => {
    assert.equal(m.isBinEnvelope(null), false)
    assert.equal(m.isBinEnvelope(undefined), false)
    assert.equal(m.isBinEnvelope('x'), false)
    assert.equal(m.isBinEnvelope({}), false)
    assert.equal(m.isBinEnvelope([]), false)
    assert.equal(m.isBinEnvelope({ __bin: null }), false)
    assert.equal(m.isBinEnvelope({ __bin: { size: 1, b64: 'AA' } }), false, 'truncated 必填')
    assert.equal(m.isBinEnvelope({ __bin: { size: 'x', b64: 'AA', truncated: false } }), false)
    assert.equal(m.isBinEnvelope({ __bin: { size: 1, b64: 2, truncated: false } }), false)
  })

  test('多带字段不影响判定（后端后续加元数据的兼容空间）', () => {
    assert.equal(m.isBinEnvelope({ __bin: { size: 1, b64: 'AA', truncated: false, mime: 'image/png' } }), true)
  })
})

describe('fitColumnWidths：与数据页原公式一致，且可预测', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('上下限就是 90 / 360（与拖拽、自适应共用同一组常量）', () => {
    assert.equal(m.COL_W_MIN, 90)
    assert.equal(m.COL_W_MAX, 360)
    assert.equal(m.COL_W_FALLBACK, 90)
  })

  test('短值列收敛到下限，不给大片空白', () => {
    const w = m.fitColumnWidths([{ flag: '一般' }], ['flag'])
    assert.equal(w.flag, m.COL_W_MIN, '原固定 220 会让短值列出现空白')
  })

  test('长值列饱和到上限', () => {
    const w = m.fitColumnWidths([{ big: 'x'.repeat(5000) }], ['big'])
    assert.equal(w.big, m.COL_W_MAX)
  })

  test('中段按 字符数×12 + 32 取值（沿用数据页既有公式，抽函数前后逐列一致）', () => {
    const v = 'x'.repeat(20)
    const w = m.fitColumnWidths([{ c: v }], ['c'])
    assert.equal(w.c, 20 * 12 + 32)
  })

  test('列名本身参与量宽：窄数据 + 长列名不会把表头挤断', () => {
    // 16 字符列名 > 3 字符数据 → 按列名量
    const w = m.fitColumnWidths([{ created_at_millis: 'abc' }], ['created_at_millis'])
    assert.equal(w.created_at_millis, 'created_at_millis'.length * 12 + 32)
  })

  test('JSON 列按真实文本量宽（修复前是 "[object Object]" 15 字符 → 212px）', () => {
    const rows = [{ parameter: { payload: '1234567890' } }]
    const w = m.fitColumnWidths(rows, ['parameter'])
    assert.equal(w.parameter, m.cellText(rows[0].parameter).length * 12 + 32)
    // 旧实现按 String(v) 得到 '[object Object]'
    assert.ok(w.parameter > '[object Object]'.length * 12 + 32, '必须宽于按 [object Object] 量出的宽度')
    // 超长 JSON 由上限封顶，长内容改由悬停预览/值面板承接
    assert.equal(m.fitColumnWidths([{ parameter: { payload: 'y'.repeat(1200) } }], ['parameter']).parameter, m.COL_W_MAX)
  })

  test('NULL 按 "NULL" 4 字符计；列名更长时由列名决定', () => {
    assert.equal(m.fitColumnWidths([{ a: null }, { a: null }], ['a']).a, m.COL_W_MIN)
    assert.equal(m.fitColumnWidths([{ created_at_millis: null }], ['created_at_millis']).created_at_millis,
      'created_at_millis'.length * 12 + 32)
  })

  test('采样有上界：2 万行只扫前 100 行（否则每次换页都全表扫描）', () => {
    const rows = []
    for (let i = 0; i < 200; i++) {
      rows.push({ c: i < 100 ? 'x'.repeat(5000) : 'x'.repeat(5) })
    }
    assert.equal(m.fitColumnWidths(rows, ['c']).c, m.COL_W_MAX)
    // 第 101 行之后的长值不参与采样：反过来放就把上限让给短值
    const reversed = rows.slice().reverse()
    assert.equal(m.fitColumnWidths(reversed, ['c']).c, 5 * 12 + 32)
    // 显式 sample=1 时只看首行，证明上界可调
    assert.equal(m.fitColumnWidths(rows, ['c'], { sample: 1 }).c, m.COL_W_MAX)
    assert.equal(m.fitColumnWidths(reversed, ['c'], { sample: 1 }).c, 5 * 12 + 32)
  })

  test('空行集 → 空对象（不得抛，供 memo 直接消费）', () => {
    for (const arg of [[[], ['a']], [null, ['a']], [null, null], [undefined, undefined], [null, undefined]]) {
      const out = m.fitColumnWidths(arg[0], arg[1])
      assert.equal(typeof out, 'object')
      assert.deepEqual(Object.keys(out), [], 'must be an empty map')
    }
  })

  test('keys 传空数组等同于省略：从首行推断，而不是返回空对象', () => {
    assert.deepEqual(
      Object.keys(m.fitColumnWidths([{ a: 'x'.repeat(20) }], [])),
      ['a']
    )
  })

  test('keys 省略时从首行推断，结果与显式传 keys 一致', () => {
    const rows = [{ name: 'x'.repeat(20), remark: 'y'.repeat(25) }]
    assert.equal(
      JSON.stringify(m.fitColumnWidths(rows)),
      JSON.stringify(m.fitColumnWidths(rows, ['name', 'remark']))
    )
    assert.equal(m.fitColumnWidths(rows).name, 20 * 12 + 32)
  })

  test('稀疏行（后续行缺列）不得抛，缺的列不参与加长', () => {
    const w = m.fitColumnWidths([{ name: 'x'.repeat(20) }, { remark: 'y'.repeat(25) }], ['name', 'remark'])
    assert.equal(w.name, 20 * 12 + 32)
    assert.equal(w.remark, 25 * 12 + 32)
  })

  test('自定义上下限（列头菜单"加宽 720"要用同一函数换上限）', () => {
    // 50 字符默认会被 360 封顶；放宽上限才量得出真实宽度
    assert.equal(m.fitColumnWidths([{ c: 'x'.repeat(50) }], ['c']).c, m.COL_W_MAX)
    assert.equal(m.fitColumnWidths([{ c: 'x'.repeat(50) }], ['c'], { max: 1200 }).c, 50 * 12 + 32)
    // min>max 时由 max 封顶，保证布局不溢出
    assert.equal(m.fitColumnWidths([{ c: 'ab' }], ['c'], { min: 500 }).c, m.COL_W_MAX)
  })
})

describe('H1a-2 列宽决策：拖拽夹取、四源优先级、手动宽增删', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('加宽档的上限是 720，且同一列恒不早于自适应档', () => {
    assert.equal(m.COL_W_WIDE, 720)
    assert.equal(m.COL_W_DRAG_MIN, 60)
    assert.equal(m.COL_W_DRAG_MAX, 1200)
    const rows = [{ c: 'x'.repeat(500) }, { c: 'y' }]
    const fit = m.fitColumnWidths(rows, ['c']).c
    const wide = m.wideFitColumnWidths(rows, ['c']).c
    assert.equal(fit, m.COL_W_MAX, '自适应仍按 360 封顶')
    assert.equal(wide, m.COL_W_WIDE, '加宽按 720 封顶，不是无限宽')
    assert.ok(wide >= fit, '点"加宽"绝不能把列变窄')
    // 短列两档一致：没内容可铺时不该出现"加宽反而多留白"
    const short = [{ c: 'ab' }]
    assert.equal(m.wideFitColumnWidths(short, ['c']).c, m.fitColumnWidths(short, ['c']).c)
  })

  test('单列加宽只量这一列，菜单里的数字就是点下去的宽度', () => {
    const rows = [{ a: 'x'.repeat(500), b: 'y' }]
    assert.equal(m.wideColumnWidth(rows, 'a'), m.COL_W_WIDE)
    assert.equal(m.wideColumnWidth(rows, 'b'), m.COL_W_MIN, '单字符列仍收敛到下限')
    // 一列的采样不影响另一列：不能因为隔壁有长值就把短列也撑到 720
    assert.ok(m.wideColumnWidth(rows, 'b') < m.COL_W_WIDE)
    // 量不到（空行集 / 没有行）才给整 720，用户要的就是"给空间"
    assert.equal(m.wideColumnWidth([], 'a'), m.COL_W_WIDE)
    assert.equal(m.wideColumnWidth(null, 'a'), m.COL_W_WIDE)
    assert.equal(m.wideColumnWidth(undefined, 'a'), m.COL_W_WIDE)
    // 列名参与量宽：行里没有这一列时按列名给下限宽，不抛也不给 0
    assert.equal(m.wideColumnWidth([{ a: 1 }], 'zzz'), m.COL_W_MIN)
  })

  test('拖拽按增量算并夹在 60~1200（超出边界取边界而不是越界）', () => {
    assert.equal(m.clampDragWidth(200, 50), 250)
    assert.equal(m.clampDragWidth(200, -50), 150)
    assert.equal(m.clampDragWidth(200, 5000), m.COL_W_DRAG_MAX)
    assert.equal(m.clampDragWidth(200, -5000), m.COL_W_DRAG_MIN)
    assert.equal(m.clampDragWidth(200, 12.6), 213, '必须取整，小数宽会让 th 抖动')
  })

  test('拖拽起点/位移是脏值时回落到兜底宽，绝不产出 NaN（NaN 写进 style 列就没了）', () => {
    for (const bad of [undefined, null, 0, -1, NaN, 'x', '']) {
      assert.equal(m.clampDragWidth(bad, 10), m.COL_W_FALLBACK + 10, '起点脏值 ' + String(bad))
    }
    for (const bad of [undefined, NaN, 'abc']) {
      assert.equal(m.clampDragWidth(200, bad), 200, '位移脏值 ' + String(bad) + ' 应保持原宽')
    }
    assert.equal(m.clampDragWidth('320', 10), 330, '数字字符串起点能用（视角配置里存过字符串）')
  })

  test('优先级：拖拽中 > 手动 > 自适应 > 兜底', () => {
    const all = { live: 500, manual: 300, fitted: 200, fallback: 90 }
    assert.equal(m.pickColumnWidth(all), 500)
    assert.equal(m.pickColumnWidth({ ...all, live: 0 }), 300)
    assert.equal(m.pickColumnWidth({ ...all, live: null, manual: 0 }), 200)
    assert.equal(m.pickColumnWidth({ live: 0, manual: 0, fitted: 0, fallback: 120 }), 120)
    assert.equal(m.pickColumnWidth({}), m.COL_W_FALLBACK, '全空也不能给出 0 宽')
    assert.equal(m.pickColumnWidth(), m.COL_W_FALLBACK)
  })

  test('脏源值被跳过而不是当成 0 宽（配置里的 -5 / "x" / NaN 都要落空）', () => {
    assert.equal(m.pickColumnWidth({ manual: -5, fitted: 240 }), 240)
    assert.equal(m.pickColumnWidth({ manual: 'x', fitted: 240 }), 240)
    assert.equal(m.pickColumnWidth({ manual: NaN, fitted: 240 }), 240)
    // 合法数字字符串（老配置文件里存过 '200'）要能用
    assert.equal(m.pickColumnWidth({ manual: '200', fitted: 240 }), 200)
    // pick 只做"取哪一源"，不做区间夹取：夹取发生在 clampDragWidth（写入手动态之前）
    assert.equal(m.pickColumnWidth({ live: 9999 }), 9999)
  })

  test('手动宽增删返回新对象（入参可能是持久化视角，就地改会跳过 diff）', () => {
    // plain()：vm 里造的对象原型来自另一个 realm，deepStrictEqual 会因为引用不同
    // 判失败（结构相同）→ 结构比对照走 JSON，引用是否新增一律比 raw 返回值
    const base = { a: 120, b: 240 }
    const added = m.withManualWidth(base, 'c', 300)
    assert.notEqual(added, base, '必须新引用')
    assert.deepEqual(plain(added), { a: 120, b: 240, c: 300 })
    assert.deepEqual(plain(base), { a: 120, b: 240 }, '入参不得被改')
    const cleared = m.withoutManualWidth(added, 'c')
    assert.notEqual(cleared, added)
    assert.deepEqual(plain(cleared), { a: 120, b: 240 })
    // 删不存在的键也应返回等价新对象（调用方不必先判断在不在）
    const noop = m.withoutManualWidth(base, 'zz')
    assert.notEqual(noop, base)
    assert.deepEqual(plain(noop), { a: 120, b: 240 })
  })

  test('手动宽写脏值等同删除（"自适应本列"就是清掉这一列）', () => {
    const base = { a: 120 }
    for (const bad of [0, -3, null, undefined, NaN, 'x']) {
      assert.deepEqual(plain(m.withManualWidth(base, 'a', bad)), {}, '脏值 ' + String(bad) + ' 应清掉')
      assert.deepEqual(plain(m.withManualWidth(base, 'b', bad)), { a: 120 })
    }
    assert.equal(plain(m.withManualWidth(base, 'a', '260.4')).a, 260, '数字字符串取整后写入')
  })

  test('空 map / 非对象入参不得抛（Redis 详情切类型时手动态可能是 undefined）', () => {
    assert.deepEqual(plain(m.withManualWidth(undefined, 'a', 100)), { a: 100 })
    assert.deepEqual(plain(m.withoutManualWidth(undefined, 'a')), {})
    assert.deepEqual(plain(m.withoutManualWidth(null, 'a')), {})
  })
})

describe('H1a-1 接线契约：5 处网格都走同一套宽度（长内容走值面板，无原生 title）', () => {
  test('数据页列宽改为委托 fitColumnWidths，原 String(v) 采样实现下线', () => {
    const src = read()
    // 多行 import 也要认（H1a-2 往同一行里加了 wideColumnWidth）
    assert.ok(
      /import \{[^}]*\bfitColumnWidths\b[^}]*\} from '\.\.\/\.\.\/common\/db-column-width'/.test(src),
      'import missing'
    )
    const memo = src.match(/const columnWidths = useMemo\([\s\S]*?\n {2}\)/)
    assert.ok(memo, 'columnWidths memo not found')
    assert.ok(memo[0].includes('fitColumnWidths(grid.rows, Object.keys(grid.rows[0]))'), 'must delegate')
    assert.ok(!memo[0].includes('String(v)'), 'old String(v) sampling must not return')
    assert.ok(memo[0].includes('[grid.rows]'), 'sampling must stay memoized on rows only')
  })

  test('单元格不设原生 title：长内容只在值面板里给全文', () => {
    const colSrc = readCols()
    // rc-table 在 ellipsis 为真时会给纯字符串格自动补 title（实测长达数千字符），
    // 所以光"自己不写 title"不够，必须显式 showTitle: false；同时格子里不做
    // per-render 的文本序列化（列 memo 依赖含 editValue，会在编辑热路径上重复算）
    // CELL_ELLIPSIS 随列工厂住在 db-grid-columns.jsx（数据页 / SQL 结果页共用）
    assert.ok(/const CELL_ELLIPSIS = \{ showTitle: false \}/.test(colSrc), 'CELL_ELLIPSIS must disable rc-table title')
    assert.ok(/ellipsis: CELL_ELLIPSIS/.test(colSrc), '列工厂必须实际挂 CELL_ELLIPSIS')
    const cell = colSrc.match(/onCell: row => \{[\s\S]*?\n {6}\}/)
    assert.ok(cell, '列工厂 onCell not found')
    // 序列化只允许出现在"选中一格"后的值面板元信息里（cellText 挂在选中值上 memo），
    // 绝不能进 onCell —— 列 memo 依赖含 editValue，行内编辑每敲一个字符都会重算
    assert.ok(!/cellText/.test(cell[0]), 'onCell 不做文本序列化（编辑热路径）')
    assert.ok(!/onMouseEnter|onMouseLeave/.test(cell[0]), '悬停浮层已撤，onCell 不该再挂鼠标进出')
  })

  test('4 处 memo 化网格的列依赖：列宽三态一个都不能漏', () => {
    const src = read()
    // 漏列宽三态（拖拽中 live / 手动宽 / 自适应 fitted）→ 拖完列不动、菜单点了
    // 没反应，而且是 memo 吞掉的静默失效
    const grids = [
      ['sqlResultColumns', ['sqlLive', 'sqlColWidths', 'sqlFitted']],
      ['structColumns', ['structLive', 'structColWidths', 'structFitted']],
      ['redisKeyColumns', ['redisKeysLive', 'redisColWidths', 'redisKeysFitted']],
      // 数据页的手动宽住在持久化视角里，所以那一源就是 view
      ['columns', ['dataLive', 'view', 'grid.rows']]
    ]
    for (const [name, need] of grids) {
      const deps = depsOf(region(src, name))
      for (const n of need) {
        assert.ok(deps.includes(n), name + ' deps missing ' + n + ': ' + deps.join(', '))
      }
      // 反向也要守住：把每轮渲染都新引用的 hook 返回值整个塞进依赖 = memo 白做
      for (const banned of ['widthOf', 'startResize', 'setCol', 'clearCol', 'clearAllCols', 'Widths']) {
        assert.ok(
          !new RegExp('\\b' + banned + '\\b').test(deps.join(',')),
          name + ' must not depend on ' + banned + ' (unstable 引用): ' + deps.join(', ')
        )
      }
    }
  })

  test('Redis 详情保留原有编辑回调：双击编辑不被列宽接线挤掉', () => {
    const src = read()
    for (const c of ['value', 'member', 'score']) {
      const cell = src.match(new RegExp("onDoubleClick: \\(\\) => editRedisCell\\(r, '" + c + "'"))
      assert.ok(cell, 'redis detail ' + c + ' lost its double-click handler')
      const block = src.slice(Math.max(0, src.indexOf(cell[0]) - 160), src.indexOf(cell[0]) + cell[0].length)
      // 单击选中与双击编辑共用同一个 onCell：合并写法里两个都得在，
      // 少一个就是"点了不出值面板"或"双击进不了行内编辑"
      assert.ok(/onCell: \(r, i\) => \(\{/.test(block), 'redis detail ' + c + ' must keep an onCell object')
      assert.ok(block.includes('...redisCellProps('), 'redis detail ' + c + ' lost the single-click selection')
    }
  })

  test('操作提示让给列头：td 不再被提示语占用', () => {
    const src = read()
    const colSrc = readCols()
    // 表头标题容器只有一份：工厂不再接 headClassName、调用点也不再传，
    // 五处网格（数据页 / SQL 结果 / 结构 / 键列表 / 详情）共用 ColHead 默认的
    // .db-col-head —— 两页两套容器就是"表头格式不统一"的一半来源
    assert.ok(!src.includes('headClassName'), '调用点还在传 headClassName（容器分叉没收敛）')
    assert.ok(!colSrc.includes('headClassName'), '列工厂还留着 headClassName 参数')
    assert.ok(!colSrc.includes('className={'), '工厂不该给 ColHead 传 className（用默认容器）')
    const styl = fs.readFileSync(path.join(ROOT, 'src/client/components/database/db-session.styl'), 'utf8')
    assert.ok(/^\.db-col-head$/m.test(styl), '共用标题容器规则缺失')
    assert.ok(!/^\.db-col-title$/m.test(styl), '.db-col-title 应已并进 .db-col-head')
    assert.ok(!src.includes('db-col-title'), '数据页表头还在用旧容器类名')
    assert.ok(!fs.readFileSync(path.join(ROOT, 'src/client/components/database/db-col-resize.jsx'), 'utf8').includes('db-col-title'), 'ColHead 里还留着旧容器类名')
    const cell = colSrc.match(/onCell: row => \{[\s\S]*?\n {6}\}/)
    assert.ok(cell, '列工厂 onCell not found')
    assert.ok(!/title: e\('dbPreview/.test(cell[0]), 'old td hint must not return')
  })
})

// H1a-2 · 列宽可控（设计 §1A.4）
//
// 4 处 memo 化网格原来是写死的 220 / 200 / 无 / 无 —— 短值列一片空白、长值列
// 看不全，两头都难受。这里钉的是"接线契约"：宽度都走同一套三源优先级、手柄与
// 菜单都来自 db-col-resize、手动宽的落点各归其位（数据页进持久化视角，其余只
// 进内存 —— 决策 11，结果集/键列表的列会变，存进视角只会攒脏宽）。
describe('H1a-2 接线契约：4 处网格可拖可菜单，手动宽的落点各归其位', () => {
  const RESIZE = path.join(ROOT, 'src/client/components/database/db-col-resize.jsx')
  const readResize = () => fs.readFileSync(RESIZE, 'utf8')
  const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

  // useColWidths 的调用点（2 空格缩进的顶层 const，收尾就是 \n  })）
  const hookOf = (src, name) => {
    const s = src.indexOf('const ' + name + ' = useColWidths({')
    assert.ok(s > 0, name + ' does not come from useColWidths')
    const e = src.indexOf('\n  })', s)
    assert.ok(e > s, name + ' useColWidths block unbounded')
    return src.slice(s, e)
  }

  test('4 处网格的列头都是 ColHead + 列宽菜单，写死宽度全部下线', () => {
    const src = read()
    const colSrc = readCols()
    // 数据页 / SQL 结果页已并入公共列工厂：调用点只负责传能力开关，
    // ColHead / onHeaderCell / 三源选宽在工厂里各保一份
    for (const name of ['columns', 'sqlResultColumns']) {
      const body = region(src, name)
      assert.ok(body.includes('buildGridColumns('), name + ' 必须走公共列工厂')
      assert.ok(!/width: \d+/.test(body), name + ' still has a hardcoded width')
    }
    assert.ok(colSrc.includes('<ColHead'), 'factory header is not ColHead (手柄/菜单/注释会各写一套)')
    assert.ok(colSrc.includes('onHeaderCell'), 'factory carries no header props (右键菜单进不去)')
    assert.ok(colSrc.includes('openColMenu'), 'factory is not bound to the column menu')
    assert.ok(!/width: \d+/.test(colSrc), 'factory still has a hardcoded width')
    assert.match(colSrc, /width: wg\.widthOf\(/, 'factory width must come from the 3-source picker')
    for (const name of ['structColumns', 'redisKeyColumns']) {
      const body = region(src, name)
      assert.ok(body.includes('<ColHead'), name + ' header is not ColHead (手柄/菜单/注释会各写一套)')
      assert.ok(body.includes('onHeaderCell'), name + ' carries no header props (右键菜单进不去)')
      assert.ok(body.includes('openColMenu'), name + ' is not bound to the column menu')
      assert.ok(!/width: \d+/.test(body), name + ' still has a hardcoded width')
      assert.match(body, /width: (?:\w*WidthOf|widthOf)\(/, name + ' width must come from the 3-source picker')
    }
  })

  test('手动宽的落点：数据页进持久化视角，SQL / 表结构 / Redis 只进内存', () => {
    const src = read()
    const data = hookOf(src, 'dataWidths')
    assert.ok(data.includes('manual: view.columnWidths'), '数据页手动宽必须读持久化视角')
    assert.ok(data.includes('patchViewColumns'), '数据页必须经 patchViewColumns 落盘（切表回来还在）')
    assert.ok(data.includes('viewRef.current.columnWidths'), '必须读最新视角，不能拿渲染闭包里的旧 map')

    // 其余四处：各自的 useState map，且一次都不能碰 patchViewColumns
    const memory = [
      ['sqlWidths', 'sqlColWidths'],
      ['structWidths', 'structColWidths'],
      ['redisKeysWidths', 'redisColWidths'],
      ['redisDetailWidths', 'redisDetailColWidths']
    ]
    for (const [hook, state] of memory) {
      const b = hookOf(src, hook)
      assert.ok(b.includes('manual: ' + state), hook + ' 的手动源应为内存态 ' + state)
      assert.ok(!b.includes('patchViewColumns'), hook + ' 不得写表视角（结果集列会变，存进去只会攒脏宽）')
    }
    // setter 只做 setState
    for (const [state, setter] of [['sqlColWidths', 'setSqlColWidths'], ['structColWidths', 'setStructColWidths'], ['redisColWidths', 'setRedisColWidths'], ['redisDetailColWidths', 'setRedisDetailColWidths']]) {
      assert.ok(
        new RegExp('const \\[' + state + ', ' + setter + '\\] = useState\\(\\{\\}\\)').test(src),
        state + ' 必须是本地 useState（不持久化）'
      )
    }
  })

  test('重新执行 = 新一轮列宽：新结果路径清 SQL 手动宽，且只清这一处', () => {
    const src = read()
    assert.equal((src.match(/setSqlColWidths\(\{\}\)/g) || []).length, 1, '清空只能出现在新结果集路径')
    const at = src.indexOf('setSqlColWidths({})')
    // 清空在"发请求"那个函数里（runSql 拆出 runSqlNow 后仍成立，按名字锚会误伤）
    const upto = src.slice(src.lastIndexOf('const runSql', at), at)
    assert.ok(upto.includes('setSqlResult({'), '清空必须挂在新结果落地之后（翻页/本地过滤不走这里，列宽要留住）')
    // 表结构 / Redis 键列表不共用 SQL 的那份 map，各自切数据时宽度自然重算
    assert.ok(!/setStructColWidths\(\{\}\)|setRedisColWidths\(\{\}\)/.test(src), '另外两处的自适应宽随行集重算，无需手动清')
  })

  test('工具行"自适应全部列"4 处齐全，列宽菜单全站只挂一份', () => {
    const src = read()
    for (const w of ['dataWidths', 'sqlWidths', 'structWidths', 'redisKeysWidths']) {
      assert.ok(src.includes('colFitAllBtn(' + w + ')'), w + ' 的网格没有自适应全部列按钮')
    }
    assert.equal((src.match(/colFitAllBtn\(/g) || []).length, 4, '一处网格一个按钮，定义本身不带括号')
    // 只在有手动宽时可点：没拖过时按下去不会有任何变化，禁用比"点了没反应"诚实
    const btn = src.match(/const colFitAllBtn = \(wg\) => \{[\s\S]*?\n {2}\}\)/)
    assert.ok(btn, 'colFitAllBtn not found')
    assert.ok(btn[0].includes('disabled={!wg.hasManual}'), 'fit-all must stay disabled without manual widths')
    assert.ok(!/onClick=\{\(\) => wg\./.test(btn[0]), '内联箭头 = 每轮新引用，标准也拦着')

    assert.equal((src.match(/<DbColMenu/g) || []).length, 1, '列宽菜单必须单例（每列一个 Dropdown 会随 200 列挂卸）')
    const mount = src.match(/<DbColMenu[\s\S]*?\/>/)
    assert.ok(mount[0].includes('target={colMenuTarget}'), '菜单落点没接')
    assert.ok(mount[0].includes('onHide={handleColMenuHide}'), '关闭回调要用解构出来的稳定引用')
    assert.ok(src.includes('const { target: colMenuTarget, hide: handleColMenuHide } = colMenu'), '未解构')
  })

  test('拖拽手柄只有一处实现：网格不再自带 resizer', () => {
    const resize = readResize()
    assert.ok(resize.includes("className='db-col-resizer'"), 'ColHead must own the resizer')
    assert.ok(!read().includes("'db-col-resizer'"), 'db-session 里不得再留一份手柄标记（两套手感必然漂移）')
    // 手柄不吃点击/双击/右键：点了会误触排序，右键要留给列头菜单
    const handle = resize.match(/className='db-col-resizer'[\s\S]*?\/>/)
    for (const ev of ['onClick', 'onDoubleClick', 'onContextMenu']) {
      assert.ok(handle[0].includes(ev), 'resizer must stop ' + ev + ' from reaching the th')
    }
    assert.ok(handle[0].includes('onMouseDown'), 'drag must start on mousedown')
  })

  test('拖拽：起点用 th 实测宽、过程中不提交、抬起才落一次手动宽', () => {
    const s = readResize()
    assert.ok(/getBoundingClientRect\(\)\.width/.test(s), 'must measure the th, not trust the configured width')
    const move = s.match(/const move = \(mouseEv\) => \{[\s\S]*?\n {4}\}/)
    assert.ok(move, 'move handler not found')
    assert.ok(!/commitRef/.test(move[0]), '拖每一帧都提交 = 一次拖拽放大成几十次写盘')
    assert.ok(move[0].includes('clampDragWidth'), '拖拽宽必须夹进 [60, 1200]')
    const up = s.match(/const up = \(\) => \{[\s\S]*?\n {4}\}/)
    assert.ok(up, 'up handler not found')
    assert.ok(up[0].includes('withManualWidth'), 'mouseup 才落手动宽')
    assert.ok(/if \(cur\)/.test(up[0]), '只按下没移动不该产生手动宽（点一下列头不该改宽）')
    assert.ok(up[0].includes('setLive(null)'), '拖拽结束必须清 live，否则永远盖住手动宽')
    assert.ok(s.includes("document.body.classList.add('db-col-resizing')"), '拖拽中的 body class 缺失（光标/选中态会乱）')
    assert.ok(s.includes("document.body.classList.remove('db-col-resizing')"), 'body class 没摘')
  })

  test('菜单三项动作明确，且只动"手动宽"这一层', () => {
    const s = readResize()
    const pick = s.match(/const pick = \(action\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(pick, 'pick() not found')
    assert.ok(/action === 'auto'/.test(pick[0]) && pick[0].includes('wg.clearCol(key)'), '自适应本列 = 删掉这一列的手动宽')
    assert.ok(/action === 'wide'/.test(pick[0]) && pick[0].includes('wg.setCol(key, wide)'), '加宽走目标宽')
    assert.ok(pick[0].includes('wg.clearAllCols()'), '第三项与工具行同动作')
    assert.equal((pick[0].match(/onHide\(\)/g) || []).length, 1, '选完收起一次（不放每个分支里，漏一条就关不掉）')
    assert.ok(!/patchViewColumns|localStorage|persist/i.test(pick[0]), '菜单不得自己碰持久化（落点由 commit 决定）')
    const actions = s.match(/const MENU_ACTIONS = \[[\s\S]*?\n\]/)
    assert.ok(actions, 'MENU_ACTIONS not found')
    assert.deepEqual(
      actions[0].match(/label: '(\w+)'/g).map(x => x.slice(8, -1)),
      ['dbColAutoFit', 'dbColWiden', 'dbColAutoFitAll']
    )
    // 加宽标签上的数字 = 点下去会变成的宽度（同一个 wide，不是重新算一遍）
    assert.ok(/e\('dbColWiden'\)\.replace\('\{n\}', target\.wide/.test(s), 'widen label must show the measured target width')
  })

  test('菜单关闭三通道：Esc / 任意滚动 / 在别处按下（capture，否则被表格吞掉）', () => {
    const s = readResize()
    assert.ok(/addEventListener\('pointerdown', onDown, true\)/.test(s), '按下外部需 capture')
    assert.ok(/addEventListener\('scroll', onHide, true\)/.test(s), '滚动需 capture（表格内滚动不冒泡到 window 的 bubble 阶段）')
    assert.ok(/addEventListener\('keydown', onKey\)/.test(s) && s.includes("ev.key === 'Escape'"), 'Esc 没接')
    // capture 监听必须用同样的第三个参数摘掉，否则关不掉 = 会话内越积越多
    assert.ok(/removeEventListener\('pointerdown', onDown, true\)/.test(s), 'pointerdown capture 未成对摘除')
    assert.ok(/removeEventListener\('scroll', onHide, true\)/.test(s), 'scroll capture 未成对摘除')
    assert.ok(s.includes('el.contains(ev.target)'), '点菜单自己不能关')
    // 受控 + 不自触发 + 关即卸载：DOM 里有没有这个节点才是可信的实测判据
    assert.ok(s.includes('trigger={[]}'), '菜单必须全受控')
    assert.ok(/open=\{!!target\}/.test(s), 'open 未受控')
    assert.ok(s.includes('destroyOnHidden'), '关闭后不留隐藏节点')
    // 落点矩形在 handler 里同步读（React 事件对象返回后即失效）
    const open = s.match(/const openColMenu = useCallback\([\s\S]*?\n {2}\}, \[\]\)/)
    assert.ok(open, 'openColMenu not found')
    assert.ok(open[0].includes('getBoundingClientRect'), '菜单落点必须实测 th')
    assert.ok(!/requestAnimationFrame|setTimeout/.test(open[0]), '落点读取不能延后')
  })

  test('锚点样式：fixed + 非零尺寸 + 不吃事件（rc-trigger 的可见性判据）', () => {
    const lines = fs.readFileSync(STYL, 'utf8').split('\n')
    const i = lines.findIndex(l => l.trim() === '.db-col-menu-anchor')
    assert.ok(i >= 0, '.db-col-menu-anchor rule missing')
    const body = lines.slice(i + 1, i + 8).join('\n')
    // fixed 元素 offsetParent 恒为 null，rc-trigger 只能靠宽高判可见；
    // 0×0 会被判成不可见 → 浮层永远停在 -1000vw/-1000vh 的待定位坐标
    for (const d of ['position fixed', 'width 1px', 'height 1px', 'pointer-events none']) {
      assert.ok(body.includes(d), 'anchor missing ' + d)
      assert.ok(!new RegExp('\\' + d + ' 0\\b').test(body), 'anchor must not be zeroed: ' + d)
    }
    for (const sel of ['.db-col-head', '.db-col-menu', '.db-col-menu-head', '.db-col-menu-item']) {
      assert.ok(lines.some(l => l.trim() === sel), sel + ' style missing')
    }
  })

  test('手柄几何：热区压在列边界上 + hover 点亮表头自己那道线（不再自画一条）', () => {
    const text = fs.readFileSync(STYL, 'utf8')
    const lines = text.split('\n')
    const i = lines.findIndex(l => l.trim() === '.db-col-resizer')
    assert.ok(i >= 0, '.db-col-resizer rule missing')
    // 取到本条规则结束（下一个顶格选择器/注释）为止
    const end = lines.findIndex((l, k) => k > i && l.trim() && !/^\s/.test(l))
    const body = lines.slice(i + 1, end < 0 ? lines.length : end)
    const prop = (name) => {
      const hit = body.find(l => l.trim().startsWith(name + ' '))
      return hit ? hit.trim().slice(name.length + 1) : null
    }
    // 热区右沿必须压在 **th 的边界**上（那才是列与列的分界，也是分隔线所在）。
    // 列头容器右沿离 th 边界差一格 cellPaddingInlineSM（size=small 时 8px），所以外扩
    // 8px；再往外就越过 th 的 padding box，被列的 ellipsis（overflow hidden）裁掉——
    // 裁掉的那半条既看不见也点不着。"仍然可命中"由 CDP 实测 elementFromPoint 钉死
    // （旧写法 right 0 依赖的是 .ant-table-column-title 的裁剪，那层包装随 col.sorter
    // 一起摘掉了，现在两页都不借 antd 的排序实现）
    assert.equal(prop('right'), '-8px', '热区右沿要与列边界重合')
    assert.equal(prop('top'), '-8px', '热区要覆盖整列头高：上沿外扩一格内边距')
    assert.equal(prop('bottom'), '-8px', '热区下沿同样外扩，否则列头下半截抓不住')
    assert.ok(Number(prop('z-index')) >= 1, '手柄需要正 z-index 才压得住列头里的浮层')
    // 热区宽度 = 可点宽度：12px 以下在触控板/高 DPI 上很难命中
    assert.ok(Number.parseInt(prop('width'), 10) >= 12, '热区太窄，实测点不到')
    assert.equal(prop('cursor'), 'col-resize', '光标不给 col-resize，用户不知道这里能拖')
    // 线由表头那道分隔线承担：手柄再自画一条就会与它错开（2026-10-29 用户反馈"两道线"）
    assert.ok(!body.some(l => l.trim().startsWith('&::after')), '手柄不该再自带一条竖线')
    assert.ok(!body.some(l => l.trim() === '&:hover::after'), '手柄不该再有 hover 自画的线')
    // hover 点亮的是 antd 那道线，选择器要把它的 :not() 链写全：antd 的 ::before
    // specificity 是 (0,5,2)，只加个 class 前缀压不住 → hover 了但线不变色
    assert.ok(/th:not\(:last-child\)[^{\n]*:has\(\.db-col-resizer:hover\)::before/.test(text),
      '缺"hover 热区点亮表头分隔线"的规则')
    // 末列 antd 不画分隔线（:not(:last-child) 排除），但它照样有热区，得自己补反馈
    assert.ok(/th:last-child:has\(\.db-col-resizer:hover\)::before/.test(text),
      '末列缺 hover 反馈规则')
    assert.ok((text.match(/background-color var\(--primary\)/g) || []).length >= 2,
      '点亮的线必须用主色 token（两条规则各一条）')
  })

  test('每处列头都带拖拽提示：手柄 hover 才显形，不写提示等于没做', () => {
    const src = read()
    const colSrc = readCols()
    // 数据页 / SQL 结果的 ColHead 并入列工厂（hint 由调用点按能力拼好传入），
    // db-session 里剩下的是表结构 / 键列表 / Redis 详情这 10 处
    const mounts = src.match(/<ColHead[\s\S]*?\/>/g) || []
    assert.ok(mounts.length >= 10, 'ColHead 挂载点少于预期')
    for (const m of mounts) {
      assert.ok(/hint=\{/.test(m), '有一处 ColHead 没带 hint：\n' + m.slice(0, 120))
      assert.ok(m.includes('dbColResizeHint'), '列头提示必须说到可以拖宽')
    }
    // 工厂里是唯一一份 ColHead 构造点：hint 必须是调用点传参，不能在工厂里写死
    const fm = colSrc.match(/<ColHead[\s\S]*?\/>/)
    assert.ok(fm, '列工厂缺 ColHead 挂载')
    assert.ok(/hint=\{hint\}/.test(fm[0]), '工厂 ColHead 没接调用点的 hint')
    // 数据页那一列同时要保留"单击预览 / 双击编辑"，拖拽提示是并进来不是替换掉。
    // 排序提示并到同一条里：箭头改由 ColHead 自己画之后，antd 那句内置 tooltip
    // （"Click to sort ascending"，在语言包之外）跟着没了，不补就等于没人知道能排序
    const data = src.match(/hint: `\$\{canEditCell \? e\('dbPreviewEditHint'\) : e\('dbPreviewHint'\)\} · \$\{e\('dbColResizeHint'\)\} · \$\{e\('dbColSortHint'\)\}`/)
    assert.ok(data, '数据页丢了预览/编辑提示')
  })

  test('4 条新文案 en / zh_cn 成对、占位符一致、且真被用到', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')
    const keys = ['dbColAutoFit', 'dbColWiden', 'dbColAutoFitAll', 'dbColResizeHint']
    const all = read() + readResize()
    for (const k of keys) {
      const hits = (src.match(new RegExp('^\\s*' + k + ': ', 'gm')) || []).length
      assert.equal(hits, 2, k + ' 必须 en / zh_cn 各一条')
      // 引用面：菜单标签或 ColHead 的 hint，写了不用 = 下个读的人以为是死文案
      assert.ok(all.includes("'" + k + "'"), k + ' 没有任何引用')
    }
    const widen = src.match(/^\s*dbColWiden: '[^']*'/gm) || []
    for (const w of widen) {
      assert.ok(w.includes('{n}'), '加宽文案必须保留 {n} 占位符：' + w)
    }
  })

  test('Redis 详情 8 个内容列已接列宽：列头与三源选宽同时到位，写入路径不受影响', () => {
    const src = read()
    // 12 处 = 表结构 1 + 键列表 3 + 详情 8（原有 6 + Stream 条目表 ID/字段 2；
    // 数据页 / SQL 结果的 ColHead 已并入列工厂，工厂里那份构造点 + 两个调用点
    // 覆盖两处网格）。消费组表是固定宽的窄表、序号列与删除按钮列不参与量宽，
    // 见下面两条例外
    assert.equal((src.match(/<ColHead/g) || []).length, 12, '详情 8 个内容列都要挂 ColHead')
    const colSrc = readCols()
    assert.equal((colSrc.match(/<ColHead/g) || []).length, 1, '列工厂只保一份 ColHead 构造点')
    assert.equal((src.match(/wg=\{redisDetailWidths\}/g) || []).length, 8, '详情列头缺一列')
    assert.equal((src.match(/width: redisDetailWidthOf\('/g) || []).length, 8,
      '详情 8 列的宽必须走三源 picker')
    assert.equal((src.match(/wg: redisDetailWidths,/g) || []).length, 8, '详情列缺右键菜单绑定')
    // 手动宽按**键类型分桶**存：hash 的 value 与 list 的 value 是同名字段，共用一份
    // 就是拖一处改另一处；分桶同时让列头菜单的"自适应全部列"只清当前这一张表
    const detailHook = hookOf(src, 'redisDetailWidths')
    assert.ok(/manual: redisDetailColWidths\[redisDetailType\]/.test(detailHook),
      '详情手动宽必须按 redisDetailType 取桶')
    assert.ok(/\[redisDetailType\]: upd\(cur\)/.test(detailHook),
      '提交必须写回当前类型那一份，不能整张 map 覆盖')
    // 分数列原来写死 150：数字列占 150，真正会长的是成员列反而没宽
    assert.ok(!/width: 150/.test(src), 'width: 150 应随详情接线一起下线')
    // 例外钉住：4 个删除按钮列 + 1 个序号列仍是写死宽（按钮列没有"内容"可量，
    // 序号列宽度由位数决定，交给自适应只会让操作列忽宽忽窄）
    assert.equal((src.match(/width: 60/g) || []).length, 4, '删除按钮列应保持 60 固定')
    assert.equal((src.match(/width: 80/g) || []).length, 2,
      '80 固定宽：序号列 + Stream 消费组的滞后列')
    // 接线不能碰写路径：双击行内编辑的每一列都还得在（D 批的 LSET/HSET/SREM/ZADD 入口）
    assert.equal((src.match(/onDoubleClick: \(\) => editRedisCell/g) || []).length, 4,
      '详情双击进编辑的那 4 列被接线弄丢了')
  })
})
