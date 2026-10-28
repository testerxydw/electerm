const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// B3-1 列聚合纯函数测试。
// 渲染层是 ESM，CJS 测试进程 require 吃不下；按 db-grid-views.spec.js 的做法
// 用 vm 跑 src 下同一份源码（禁止拷贝实现，否则实现漂移时测试会自证通过）。

const SRC = path.join(__dirname, '../../../src/client/common/db-grid-summary.js')

const load = () => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const sandbox = { module: { exports: {} }, JSON, Number, String, Array, Object, Math, console }
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(code + '\nmodule.exports = { toNumber, summarizeColumn, formatNumber, summaryText }', sandbox)
  return sandbox.module.exports
}

const mod = load()

describe('B3-1 summarizeColumn 数值口径', () => {
  test('整数/浮点混合：sum、avg、min、max 正确', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3.5 }]
    const s = mod.summarizeColumn(rows, 'a')
    assert.equal(s.numeric, true)
    assert.equal(s.count, 3)
    assert.equal(s.sum, 6.5)
    assert.equal(s.avg, 6.5 / 3)
    assert.equal(s.min, 1)
    assert.equal(s.max, 3.5)
  })

  test('DECIMAL 经 IPC 变字符串仍参与计算（金额列的真实现状）', () => {
    const s = mod.summarizeColumn([{ m: '10.50' }, { m: '20.25' }], 'm')
    assert.equal(s.numeric, true)
    assert.equal(s.sum, 30.75)
    assert.equal(s.count, 2)
  })

  test('null/空串不进分母，但计入 nulls', () => {
    const s = mod.summarizeColumn([{ a: 2 }, { a: null }, { a: '' }, { a: 4 }], 'a')
    assert.equal(s.nulls, 2)
    assert.equal(s.count, 2, 'count 是非空行数')
    assert.equal(s.sum, 6)
    assert.equal(s.avg, 3, 'avg 分母只算有值的行')
  })

  test('出现非数值字符串：整列降级为文本列（不给半个列求和）', () => {
    const s = mod.summarizeColumn([{ a: 1 }, { a: 2 }, { a: 'N/A' }, { a: 4 }], 'a')
    assert.equal(s.numeric, false)
    assert.equal(s.sum, undefined)
    assert.equal(s.count, 4, '文本列仍有计数')
  })

  test('全 null / 空行集：numeric=false，不产生 misleading 的 0 合计', () => {
    assert.equal(mod.summarizeColumn([{ a: null }], 'a').numeric, false)
    const empty = mod.summarizeColumn([], 'a')
    assert.equal(empty.numeric, false)
    assert.equal(empty.count, 0)
    assert.equal(empty.rows, 0)
  })

  test('缺失列（行里没有该键）按 null 处理', () => {
    const s = mod.summarizeColumn([{ b: 1 }, { a: 2 }], 'a')
    assert.equal(s.nulls, 1)
    assert.equal(s.count, 1)
    assert.equal(s.sum, 2)
  })

  test('非数组入参不炸', () => {
    assert.equal(mod.summarizeColumn(null, 'a').rows, 0)
  })
})

describe('B3-1 展示格式', () => {
  test('浮点精度收敛到两位（SUM(decimal) 的 0.30000000000000004）', () => {
    assert.equal(mod.formatNumber(0.1 + 0.2), '0.3')
    assert.equal(mod.formatNumber(1240), '1240')
    assert.equal(mod.formatNumber(NaN), '-')
  })

  test('数值列摘要含 Σ/⌀/n；文本列只给 n', () => {
    const num = mod.summarizeColumn([{ a: 2 }, { a: 4 }], 'a')
    assert.match(mod.summaryText(num), /^Σ 6 · ⌀ 3 · n 2$/)
    const txt = mod.summarizeColumn([{ a: 'x' }, { a: 'y' }], 'a')
    assert.equal(mod.summaryText(txt), 'n 2')
  })

  test('空摘要返回空串（组件据此不渲染）', () => {
    assert.equal(mod.summaryText(null), '')
    assert.equal(mod.summaryText({}), '')
  })
})

describe('B3-1 组件接线契约', () => {
  const JSX = fs.readFileSync(
    path.join(__dirname, '../../../src/client/components/database/db-session.jsx'),
    'utf8'
  )

  test('聚合依赖 filteredRows 而非 grid.rows（本页口径）', () => {
    const m = JSX.match(/const cellSummary = useMemo\(\s*\(\) => \([\s\S]*?\n {2}\)/)
    assert.ok(m, 'cellSummary memo not found')
    const deps = JSX.slice(JSX.indexOf('const cellSummary = useMemo'))
    assert.match(deps.slice(0, 400), /summarizeColumn\(filteredRows, selectedCell\.col\)/)
    assert.match(deps.slice(0, 400), /\[filteredRows, selectedCell\]/)
  })

  test('聚合必须声明在 selectedCell 之后（否则渲染期 TDZ 直接白屏）', () => {
    const iCell = JSX.indexOf('const [selectedCell, setSelectedCell] = useState(null)')
    const iSummary = JSX.indexOf('const cellSummary = useMemo')
    assert.ok(iCell > 0 && iSummary > 0)
    assert.ok(iSummary > iCell, 'cellSummary 引用了 selectedCell，必须排在其后')
    // 且必须在首个顶层提前 return 之前（hook 数量恒定）
    const iReturn = JSX.search(/^\s{2}if \((error|!ready)\) \{/m)
    assert.ok(iReturn > 0)
    assert.ok(iSummary < iReturn, 'hook 不得出现在提前 return 之后')
  })
})
