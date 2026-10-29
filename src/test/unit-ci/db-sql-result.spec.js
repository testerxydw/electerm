// H1 · SQL 结果工具行：本页过滤（纯函数契约 + 接线契约）
//
// 背景（设计 §2.3）：一次执行返回的行全留在 sqlResult 里（导出/复制要用整份），
// 过滤必须走"下标数组"而不是克隆行对象 —— 1 万行只为切出 200 行而整份克隆是白扔
// 的内存；且 __rowKey 要仍是**结果内绝对下标**，选中单元格与翻页才不指错行。
//
// 测的是 src/client/common/db-sql-result.js 的同一份源码（vm 加载，不复制实现）。
// 它 import 的 cellText 也取真实模块，不写桩 —— "过滤匹配的是格子里看到的文本"
// 这条语义就挂在 cellText 上，换成桩就等于没测。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/db-sql-result.js')
const WIDTH_MOD = path.join(ROOT, 'src/client/common/db-column-width.js')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')

const EXPORTS = '({ SQL_FILTER_DEBOUNCE, emptySqlView, sqlViewOf, patchSqlView, allRowIndexes, filterRowIndexes })'

function load (file, extra) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^import[^\n]*from '[^']*'\n/gm, '')
    .replace(/^export /gm, '')
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
    module: { exports: {} },
    ...extra
  }
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;module.exports = ' + EXPORTS, sandbox, { filename: path.basename(file) })
  return sandbox.module.exports
}

// 宽度模块只要 cellText 一个出口，单独取（它的导出名列表与本品模块不同）
function loadCellText () {
  const src = fs.readFileSync(WIDTH_MOD, 'utf8').replace(/^export /gm, '')
  const sandbox = { String, Number, Boolean, Math, JSON, Object, Array, TypeError, console }
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;({ cellText })', sandbox, { filename: 'db-column-width.js' })
  return sandbox.cellText
}

const mod = load(MOD, { cellText: loadCellText() })
const { SQL_FILTER_DEBOUNCE, emptySqlView, sqlViewOf, patchSqlView, allRowIndexes, filterRowIndexes } = mod

const bin = size => ({ __bin: { size, b64: 'AAECAwQFBgc=', truncated: false } })

// vm 里 `[...]`/`{...}` 走的是那个 realm 的原型，而 node:assert/strict 的 deepEqual
// 是 deepStrictEqual（比原型），直接和宿主字面量比必挂。断言前一律在宿主侧重物化。
const plain = (x) => JSON.parse(JSON.stringify(x))

describe('db-sql-result: 过滤是"下标数组"而不是行对象数组', () => {
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
  test('空过滤 = 全量下标（不是空数组）', () => {
    assert.deepEqual(plain(allRowIndexes(rows)), [0, 1, 2])
    assert.deepEqual(plain(filterRowIndexes(rows, ['a'], '')), [0, 1, 2])
    assert.deepEqual(plain(filterRowIndexes(rows, ['a'], '   ')), [0, 1, 2])
    assert.deepEqual(plain(filterRowIndexes(rows, ['a'], null)), [0, 1, 2])
  })
  test('返回的是下标，行对象一个都不克隆', () => {
    const out = filterRowIndexes(rows, ['a'], '2')
    assert.deepEqual(plain(out), [1])
    assert.equal(typeof out[0], 'number')
  })
  test('rows 缺失/非数组给空而不是抛', () => {
    assert.deepEqual(plain(filterRowIndexes(null, ['a'], 'x')), [])
    assert.deepEqual(plain(filterRowIndexes(undefined, ['a'], '')), [])
    assert.deepEqual(plain(filterRowIndexes('nope', ['a'], 'x')), [])
  })
})

describe('db-sql-result: 匹配语义（任意列 + 所见即所得）', () => {
  const rows = [
    { id: 1, name: 'admin', note: null },
    { id: 2, name: 'Guest', note: 'ok' },
    { id: 3, name: 'bob', note: 'ADMINISTRATOR' },
    { id: 12, name: 'admin12', note: 'x' }
  ]
  const keys = ['id', 'name', 'note']
  test('大小写不敏感，两侧都算', () => {
    assert.deepEqual(plain(filterRowIndexes(rows, keys, 'ADM')), [0, 2, 3])
    assert.deepEqual(plain(filterRowIndexes(rows, keys, 'administrator')), [2])
  })
  test('命中任意列；一行多列命中只出现一次', () => {
    // '12' 同时命中第 4 行的 id 和 name，下标只出现一次
    assert.deepEqual(plain(filterRowIndexes(rows, keys, '12')), [3])
    assert.deepEqual(plain(filterRowIndexes(rows, keys, '2')), [1, 3])
    assert.deepEqual(plain(filterRowIndexes(rows, ['name'], 'admin')), [0, 3])
  })
  test('只查指定列：keys 里没有的列命中也不算命中', () => {
    assert.deepEqual(plain(filterRowIndexes(rows, ['name'], 'ADMINISTRATOR')), [])
  })
  test('keys 为空 = 没有任何可匹配的地方（宁缺毋滥，不回落"全命中"）', () => {
    assert.deepEqual(plain(filterRowIndexes(rows, [], 'admin')), [])
    assert.deepEqual(plain(filterRowIndexes(rows, null, 'admin')), [])
  })
  test('NULL 按格子里看到的 "NULL" 筛（与网格一致，不是按空串）', () => {
    assert.deepEqual(plain(filterRowIndexes(rows, keys, 'null')), [0])
  })
  test('数字值按文本匹配（不需要用户先把列转成字符串再筛）', () => {
    assert.deepEqual(plain(filterRowIndexes(rows, ['id'], '3')), [2])
    assert.deepEqual(plain(filterRowIndexes(rows, ['id'], '1')), [0, 3])
  })
  test('JSON 列按键名/键值筛（cellText 走 JSON.stringify）', () => {
    const jsonRows = [{ p: { user: 'root', n: 1 } }, { p: { other: 2 } }]
    assert.deepEqual(plain(filterRowIndexes(jsonRows, ['p'], 'root')), [0])
    assert.deepEqual(plain(filterRowIndexes(jsonRows, ['p'], '"other"')), [1])
  })
  test('二进制列按 <binary N bytes> 筛，b64 内容不参与', () => {
    const b = [{ v: bin(8) }, { v: bin(16) }]
    assert.deepEqual(plain(filterRowIndexes(b, ['v'], '8 bytes')), [0])
    assert.deepEqual(plain(filterRowIndexes(b, ['v'], 'AAEC')), [])
  })
  test('行不是对象时跳过而不是抛（脏数据不该让工具行崩）', () => {
    assert.deepEqual(plain(filterRowIndexes([null, 42, { a: 'x' }], ['a'], 'x')), [2])
  })
})

describe('db-sql-result: 每个结果集一份状态，互不串味', () => {
  test('缺省状态是"没过滤"', () => {
    assert.deepEqual(plain(emptySqlView()), { filter: '' })
    assert.deepEqual(plain(sqlViewOf(undefined, 0)), { filter: '' })
    assert.deepEqual(plain(sqlViewOf({}, 3)), { filter: '' })
    assert.equal(sqlViewOf({ 1: { filter: 'x' } }, 0).filter, '')
    assert.equal(sqlViewOf({ 1: { filter: 'x' } }, 1).filter, 'x')
  })
  test('patch 只动指定下标，其余结果集原样', () => {
    const v1 = patchSqlView({}, 0, { filter: 'a' })
    const v2 = patchSqlView(v1, 1, { filter: 'b' })
    const v3 = patchSqlView(v2, 0, { filter: 'c' })
    assert.equal(v3[0].filter, 'c')
    assert.equal(v3[1].filter, 'b')
    assert.equal(v2[0].filter, 'a', '上一次的 state 不该被就地改掉')
    assert.deepEqual(Object.keys(plain(v3)).sort(), ['0', '1'])
  })
  test('防抖时长钉住设计值 150ms', () => {
    assert.equal(SQL_FILTER_DEBOUNCE, 150)
  })
})

describe('db-sql-result: 接线契约（纯函数对了还得真被用上）', () => {
  const src = fs.readFileSync(SESSION, 'utf8')
  test('派生链走 filterRowIndexes，且 memo 依赖含 sqlViews', () => {
    assert.ok(/filterRowIndexes\(/.test(src), 'SQL 结果没走共用的过滤函数')
    const start = src.indexOf('const sqlResultViews = useMemo(')
    assert.ok(start > -1, '找不到 SQL 结果的派生 memo')
    // memo 体里也出现 sqlViews（读状态），所以只认收尾那一个依赖数组：
    // 从"到 ) 之前"的末尾倒着匹配一段不含方括号的 [...]
    const block = src.slice(start, src.indexOf('\n  )', start))
    const deps = block.match(/\[([^[\]]*)\]\s*$/)
    assert.ok(deps, 'memo 收尾处没找到依赖数组')
    assert.ok(/\bsqlViews\b/.test(deps[1]), '过滤状态没进派生 memo 的依赖，改了不会重算')
  })
  test('分页器与网格都读过滤后的口径（matched / pageRows），不再读原始 rows', () => {
    const block = src.slice(src.indexOf('const renderOne = (r, i) =>'))
    assert.ok(/total=\{view\.matched\}/.test(block), '分页器 total 还是原始行数')
    assert.ok(/dataSource=\{view\.pageRows\}/.test(block), '网格数据源还是整份切片')
    assert.ok(!/dataSource=\{sqlResultRowMaps/.test(block), '旧的行数组变量该退役了')
  })
  test('重新执行清掉过滤（连同输入框的即时值）', () => {
    const eff = src.match(/useEffect\(\(\) => \{\s*setSqlPages\(\{\}\)[\s\S]*?\}, \[sqlResult\.results\]\)/)
    assert.ok(eff, '找不到"新结果到位就重置"的 effect')
    assert.ok(/setSqlViews\(\{\}\)/.test(eff[0]), '新结果留着旧过滤')
    assert.ok(/setSqlFilterDraft\(\{\}\)/.test(eff[0]), '输入框留着旧词，看着像没生效')
  })
  test('输入框受控：即时值优先，防抖到点才影响结果', () => {
    assert.ok(/sqlFilterDraft\[i\] === undefined \? filter : sqlFilterDraft\[i\]/.test(src))
    assert.ok(/onSqlFilterInput\(i, ev\.target\.value\)/.test(src))
    assert.ok(/SQL_FILTER_DEBOUNCE\)/.test(src), '防抖时长没走共用的那个常量')
  })
  test('换词回第 1 页（页码不能只被读时夹住），且新结果清掉"上次提交的词"', () => {
    const fn = src.match(/const onSqlFilterInput = \(i, v\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(fn, '找不到过滤输入的处理函数')
    assert.ok(/setSqlPages\(prev => \(\{ \.\.\.prev, \[i\]: 1 \}\)\)/.test(fn[0]), '换词后没把页码写回第 1 页')
    assert.ok(/committed\[i\] !== v/.test(fn[0]), '要认"词变了"才回第 1 页，否则每敲一下都跳页')
    assert.ok(/sqlFilterCommitted\.current = \{\}/.test(src), '重新执行后旧词还记着，下一次同词不会回第 1 页')
  })
  test('卸载清定时器（防抖挂着的定时器不该在组件没了之后 setState）', () => {
    assert.ok(/Object\.values\(timers\)\.forEach\(clearTimeout\)/.test(src))
  })
  test('文案走词条，不硬编码中文', () => {
    assert.ok(/e\('dbFilterResult'\)/.test(src))
    assert.ok(/e\('dbFilterHit'\)/.test(src))
    const locales = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')
    for (const k of ['dbFilterResult', 'dbFilterHit']) {
      assert.equal((locales.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
    }
    assert.ok(/\{m\}/.test(locales) && /\{t\}/.test(locales), '命中/总数要留两个占位符')
  })
})
