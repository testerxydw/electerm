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

const EXPORTS = '({ COL_W_MIN, COL_W_MAX, COL_W_FALLBACK, isBinEnvelope, cellText, fitColumnWidths })'

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

describe('H1a-1 接线契约：5 处网格都走同一套宽度 + 悬停预览（不带原生 title）', () => {
  const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
  const read = () => fs.readFileSync(JSX, 'utf8')

  test('数据页列宽改为委托 fitColumnWidths，原 String(v) 采样实现下线', () => {
    const src = read()
    assert.ok(src.includes('import { fitColumnWidths } from \'../../common/db-column-width\''), 'import missing')
    const memo = src.match(/const columnWidths = useMemo\([\s\S]*?\n {2}\)/)
    assert.ok(memo, 'columnWidths memo not found')
    assert.ok(memo[0].includes('fitColumnWidths(grid.rows, Object.keys(grid.rows[0]))'), 'must delegate')
    assert.ok(!memo[0].includes('String(v)'), 'old String(v) sampling must not return')
    assert.ok(memo[0].includes('[grid.rows]'), 'sampling must stay memoized on rows only')
  })

  test('previewProps 是 useCallback，且只依赖悬停 handler 本身', () => {
    const src = read()
    const fn = src.match(/const previewProps = useCallback\([\s\S]*?\n {2}\}\), \[[^\]]*\]\)/)
    assert.ok(fn, 'previewProps useCallback not found')
    assert.ok(fn[0].includes('onMouseEnter:'), 'hover show not wired')
    assert.ok(fn[0].includes('onMouseLeave:'), 'hover hide not wired')
    const deps = fn[0].slice(fn[0].lastIndexOf(', ['))
    assert.ok(!deps.includes('cellPreview'), 'deps must not include the whole hook object (unstable → 列 memo 每次悬停重建)')
    // 依赖必须正好是 handler 体里引用的那两个标识符，改名也不漏
    const enter = fn[0].match(/onMouseEnter: ev => (\w+)\(/)
    const leave = fn[0].match(/onMouseLeave: (\w+)/)
    assert.ok(enter && leave, 'hover handlers not wired to stable locals')
    assert.ok(deps.includes(enter[1]) && deps.includes(leave[1]), 'deps drifted: ' + deps)
  })

  test('单元格不设原生 title：全文只在悬停时序列化一次', () => {
    // 列 memo 的依赖里有 editValue（行内编辑每敲一个字符重建一次），给每格算
    // cellText 会把 200 行 × 30KB JSON 的序列化挂在编辑热路径上；
    // 且原生 tooltip 与预览卡会同时弹出互相遮挡
    const src = read()
    const fn = src.match(/const previewProps = useCallback\([\s\S]*?\n {2}\}\), \[[^\]]*\]\)/)
    assert.ok(!/title:/.test(fn[0]), 'cell must not carry a per-render title')
    assert.ok(!src.includes('import { cellText'), 'cellText must not be imported by the grid (只在预览卡内用)')
  })

  // 组件里这些列定义都是 2 空格缩进的顶层 const：截到下一个 const 即为一整块
  const region = (src, name) => {
    const s = src.indexOf('const ' + name + ' = useMemo')
    assert.ok(s > 0, name + ' memo not found')
    const next = src.indexOf('\n  const ', s + 10)
    const body = src.slice(s, next > s ? next : src.length)
    assert.ok(body.length < 6000, name + ' region looks unbounded (drifted marker)')
    return body
  }

  test('5 处网格全部挂上 previewProps', () => {
    const src = read()
    // 1 数据页主网格（与行内编辑/键盘处理合并进同一个 onCell）
    assert.ok(src.includes('...previewProps(k, row)'), 'data grid missing')
    // 2 SQL 结果
    assert.ok(region(src, 'sqlResultColumns').includes('previewProps(k, row)'), 'sql result missing')
    // 3 表结构
    assert.ok(region(src, 'structColumns').includes('previewProps(k, row)'), 'struct grid missing')
    // 4 Redis 键列表（三列都要）
    const rk = region(src, 'redisKeyColumns')
    for (const c of ['name', 'type', 'ttl']) {
      assert.ok(rk.includes("previewProps('" + c + "', row)"), 'redis keys column ' + c + ' missing')
    }
    // 5 Redis 详情四张表（hash field/value、list value、set member、zset member/score）
    const detail = src.slice(src.indexOf('{ title: e(\'dbField\')'))
    for (const c of ['field', 'value', 'member', 'score']) {
      assert.ok(detail.includes("previewProps('" + c + "'"), 'redis detail column ' + c + ' missing')
    }
  })

  test('5 处网格的列 memo 都把 previewProps 放进依赖（漏了就永久用旧引用）', () => {
    const src = read()
    for (const name of ['sqlResultColumns', 'structColumns', 'redisKeyColumns']) {
      assert.ok(region(src, name).includes('previewProps]'), name + ' deps missing previewProps')
    }
    const dataGrid = src.slice(src.indexOf('const columns = useMemo'), src.indexOf('const redisKeyColumns'))
    assert.ok(dataGrid.includes('previewProps]'), 'data grid deps missing previewProps')
  })

  test('Redis 详情保留原有编辑回调：previewProps 走展开合并且放最后', () => {
    const src = read()
    for (const c of ['value', 'member', 'score']) {
      const cell = src.match(new RegExp("onCell: r => \\(\\{[\\s\\S]{0,200}?\\.\\.\\.previewProps\\('" + c + "', r\\)"))
      assert.ok(cell, 'redis detail ' + c + ' must merge into the existing onCell object')
      assert.ok(/onDoubleClick/.test(cell[0]), 'redis detail ' + c + ' lost its double-click handler')
    }
  })

  test('预览卡单例：整个会话只挂一处 DbCellPreview', () => {
    const src = read()
    const mounts = (src.match(/<DbCellPreview/g) || []).length
    assert.equal(mounts, 1, 'DbCellPreview must mount exactly once (单例，不随行数增长)')
    const mount = src.match(/<DbCellPreview[\s\S]*?\/>/)
    assert.ok(mount[0].includes('state={cellPreview.state}'), 'state not wired')
    assert.ok(mount[0].includes('patterns={keywordPatterns}'), 'keyword highlight not wired')
    // 三个 handler 走解构出来的稳定引用（包箭头函数 = 每轮渲染新引用，预览卡反复摘挂监听）
    assert.ok(mount[0].includes('onHide={handlePreviewHide}'), 'close not wired')
    assert.ok(mount[0].includes('onEnter={handlePreviewEnter}'), 'grace on enter not wired')
    assert.ok(mount[0].includes('onLeave={handlePreviewLeave}'), 'leave not wired')
    for (const n of ['handlePreviewHide', 'handlePreviewEnter', 'handlePreviewLeave']) {
      assert.ok(src.includes(n), n + ' must come from useCellPreview destructuring')
    }
  })

  test('操作提示让给列头：td 不再被提示语占用，悬停只看内容预览', () => {
    const src = read()
    assert.ok(src.includes('className=\'db-col-title\''), 'header hint span missing')
    const cell = src.match(/onCell: row => \(\{[\s\S]*?\.\.\.previewProps\(k, row\)[\s\S]*?\n {8}\}\)/)
    assert.ok(cell, 'data grid onCell not found')
    assert.ok(!/title: e\('dbPreview/.test(cell[0]), 'old td hint must not return')
  })
})
