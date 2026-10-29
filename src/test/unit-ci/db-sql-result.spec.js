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

const EXPORTS = '({ SQL_FILTER_DEBOUNCE, SQL_SORT_BIG_ROWS, emptySqlView, sqlViewOf, patchSqlView, allRowIndexes, filterRowIndexes, nextSqlSort, sqlSortOf, looksNumericColumn, sortRowIndexes, visibleSqlKeys, toggleSqlHidden })'

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
const {
  SQL_FILTER_DEBOUNCE, SQL_SORT_BIG_ROWS, emptySqlView, sqlViewOf, patchSqlView,
  allRowIndexes, filterRowIndexes, nextSqlSort, sqlSortOf, looksNumericColumn, sortRowIndexes,
  visibleSqlKeys, toggleSqlHidden
} = mod

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

describe('db-sql-result: 排序是"下标数组"上的排列，NULL 恒最后', () => {
  const rows = [
    { id: 9, name: 'b', v: 30 },
    { id: 10, name: 'A', v: null },
    { id: 2, name: 'c', v: 10 },
    { id: 1, name: 'a', v: null }
  ]
  const idx = [0, 1, 2, 3]
  const byId = (order, numeric = true) => plain(sortRowIndexes(rows, idx, { key: 'id', order }, numeric ? ['id'] : []))
  test('数值列按数值比较，不按字符串（否则 10 < 9）', () => {
    assert.deepEqual(byId('ascend'), [3, 2, 0, 1])
    assert.deepEqual(byId('descend'), [1, 0, 2, 3])
  })
  test('数值判定为假时按字符串序（"10" 在 "9" 前）', () => {
    assert.deepEqual(byId('ascend', false), [3, 1, 2, 0])
  })
  test('NULL 恒排最后，升降都一样', () => {
    assert.deepEqual(plain(sortRowIndexes(rows, idx, { key: 'v', order: 'ascend' }, ['v'])), [2, 0, 1, 3])
    assert.deepEqual(plain(sortRowIndexes(rows, idx, { key: 'v', order: 'descend' }, ['v'])), [0, 2, 1, 3])
  })
  test('同值按结果内原始顺序稳定排列（两个 NULL 不互相换位）', () => {
    // 两个 NULL 的下标是 1 和 3，两个方向都必须保持 1 在前
    const asc = plain(sortRowIndexes(rows, idx, { key: 'v', order: 'ascend' }, ['v']))
    const desc = plain(sortRowIndexes(rows, idx, { key: 'v', order: 'descend' }, ['v']))
    assert.ok(asc.indexOf(1) < asc.indexOf(3))
    assert.ok(desc.indexOf(1) < desc.indexOf(3))
  })
  test('不改入参：原下标数组与行对象都原样', () => {
    const input = [3, 1, 0, 2]
    const out = sortRowIndexes(rows, input, { key: 'id', order: 'ascend' }, ['id'])
    assert.deepEqual(plain(input), [3, 1, 0, 2])
    assert.notEqual(out, input)
    assert.deepEqual(plain(rows.map(r => r.id)), [9, 10, 2, 1])
  })
  test('没排序（null/空 key/空 order）原样返回，不做无谓的复制', () => {
    assert.equal(sortRowIndexes(rows, idx, null, ['id']), idx)
    assert.equal(sortRowIndexes(rows, idx, { key: '', order: 'ascend' }, ['id']), idx)
    assert.equal(sortRowIndexes(rows, idx, { key: 'id', order: null }, ['id']), idx)
  })
  test('只在给定下标集合里排（过滤后的子集），行号仍是绝对下标', () => {
    // 过滤后的集合是 [3, 1]（id 1 和 10），排序只在这两个里换位
    assert.deepEqual(plain(sortRowIndexes(rows, [3, 1], { key: 'id', order: 'descend' }, ['id'])), [1, 3])
  })
  test('不存在的列 = 全是 NULL，保持原顺序；脏行跳过而不是抛', () => {
    assert.deepEqual(plain(sortRowIndexes(rows, idx, { key: 'nope', order: 'ascend' }, [])), [0, 1, 2, 3])
    const dirty = [null, { id: 2 }, 42, { id: 1 }]
    assert.deepEqual(plain(sortRowIndexes(dirty, [0, 1, 2, 3], { key: 'id', order: 'ascend' }, ['id'])), [3, 1, 0, 2])
  })
  test('数值列里混进非数字串时退回字符串比较，不产生 NaN 乱序', () => {
    const mixed = [{ v: 2 }, { v: 'abc' }, { v: 10 }]
    assert.deepEqual(plain(sortRowIndexes(mixed, [0, 1, 2], { key: 'v', order: 'ascend' }, ['v'])), [0, 2, 1])
  })
})

describe('db-sql-result: 排序状态（三档循环 + 每列独立）', () => {
  test('点击循环：无 → 升 → 降 → 无', () => {
    assert.equal(nextSqlSort(null), 'ascend')
    assert.equal(nextSqlSort(undefined), 'ascend')
    assert.equal(nextSqlSort('ascend'), 'descend')
    assert.equal(nextSqlSort('descend'), null)
    assert.equal(nextSqlSort('something'), 'ascend')
  })
  test('受控状态只认当前列：换一列时旧箭头不跟过去', () => {
    const views = { 0: { filter: '', sort: { key: 'id', order: 'descend' } } }
    assert.equal(sqlSortOf(views, 0, 'id'), 'descend')
    assert.equal(sqlSortOf(views, 0, 'name'), null)
    assert.equal(sqlSortOf(views, 1, 'id'), null)
    assert.equal(sqlSortOf({}, 0, 'id'), null)
  })
  test('order 不认识时按"没排序"处理，不把脏状态画成升序', () => {
    assert.equal(sqlSortOf({ 0: { sort: { key: 'id', order: 'sideways' } } }, 0, 'id'), null)
  })
  test('数值列兜底推断：全 number/bigint/数字串才算，混一个文本就不是', () => {
    assert.equal(looksNumericColumn([{ v: 1 }, { v: 2.5 }], 'v'), true)
    assert.equal(looksNumericColumn([{ v: '1' }, { v: '-2.5' }, { v: '3e4' }], 'v'), true)
    assert.equal(looksNumericColumn([{ v: 1 }, { v: 'abc' }], 'v'), false)
    assert.equal(looksNumericColumn([{ v: 1 }, { v: '' }], 'v'), false)
    // 空串不是数字：Mysql 的 decimal 不会给空串，但 text 列可能
    assert.equal(looksNumericColumn([{ v: '  ' }], 'v'), false)
  })
  test('全 NULL 的列不算数值列（没有可比的值，也不该把它当数排）', () => {
    assert.equal(looksNumericColumn([{ v: null }, { v: undefined }, {}], 'v'), false)
    assert.equal(looksNumericColumn([], 'v'), false)
    assert.equal(looksNumericColumn(null, 'v'), false)
  })
  test('采样上限生效：第 101 个值才出现文本时仍算数值列（只采前 100 个）', () => {
    const many = []
    for (let i = 0; i < 100; i++) {
      many.push({ v: i })
    }
    many.push({ v: 'abc' })
    assert.equal(looksNumericColumn(many, 'v'), true)
    assert.equal(looksNumericColumn(many, 'v', 500), false)
  })
  test('大结果提示阈值是 5 万行（设计口径）', () => {
    assert.equal(SQL_SORT_BIG_ROWS, 50000)
  })
})

describe('db-sql-result: 每个结果集一份状态，互不串味', () => {
  test('缺省状态是"没过滤、没排序、没藏列"', () => {
    assert.deepEqual(plain(emptySqlView()), { filter: '', sort: null, hidden: [] })
    assert.deepEqual(plain(sqlViewOf(undefined, 0)), { filter: '', sort: null, hidden: [] })
    assert.deepEqual(plain(sqlViewOf({}, 3)), { filter: '', sort: null, hidden: [] })
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

describe('db-sql-result: 列显隐（可见列 + 至少留一列）', () => {
  const keys = ['id', 'name', 'note']
  test('可见列按原顺序滤掉 hidden，顺序不能被重排', () => {
    assert.deepEqual(plain(visibleSqlKeys(keys, ['name'])), ['id', 'note'])
    assert.deepEqual(plain(visibleSqlKeys(keys, ['note', 'id'])), ['name'])
    assert.deepEqual(plain(visibleSqlKeys(keys, [])), keys)
  })
  test('hidden 不是数组 / keys 不是数组时不炸', () => {
    assert.deepEqual(plain(visibleSqlKeys(keys, undefined)), keys)
    assert.deepEqual(plain(visibleSqlKeys(keys, null)), keys)
    assert.deepEqual(plain(visibleSqlKeys(null, ['a'])), [])
  })
  test('勾掉一列：追加进 hidden（不就地改入参）', () => {
    const hid = toggleSqlHidden(keys, [], 'name', false)
    assert.deepEqual(plain(hid), ['name'])
    assert.deepEqual(plain(visibleSqlKeys(keys, hid)), ['id', 'note'])
  })
  test('勾回一列：从 hidden 里摘掉', () => {
    const hid = toggleSqlHidden(keys, ['name', 'note'], 'name', true)
    assert.deepEqual(plain(hid), ['note'])
  })
  test('不给勾掉最后一列：返回 null，调用方保留旧状态', () => {
    assert.equal(toggleSqlHidden(keys, ['name', 'note'], 'id', false), null)
    // 还剩两列时可勾
    assert.deepEqual(plain(toggleSqlHidden(keys, ['note'], 'id', false)), ['note', 'id'])
  })
  test('不存在的列不算数（返回 null，不往 hidden 塞脏键）', () => {
    assert.equal(toggleSqlHidden(keys, [], 'nope', false), null)
    assert.equal(toggleSqlHidden(keys, ['name'], 'NOPE', true), null)
  })
  test('单列结果集本来就没得藏', () => {
    assert.equal(toggleSqlHidden(['only'], [], 'only', false), null)
  })
  test('全部显示就是空数组（走同一个 patch 通道）', () => {
    const v = patchSqlView({ 0: { filter: 'a', sort: null, hidden: ['id'] } }, 0, { hidden: [] })
    assert.deepEqual(plain(v[0].hidden), [])
    assert.equal(v[0].filter, 'a', '显示全部不该动过滤')
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
  test('排序接在过滤之后、切页之前（先排全量再切页，不是只排当前页）', () => {
    const block = src.slice(
      src.indexOf('const sqlResultViews = useMemo('),
      src.indexOf('const renderSqlResults')
    )
    const iFilter = block.indexOf('filterRowIndexes(')
    const iSort = block.indexOf('sortRowIndexes(')
    const iSlice = block.indexOf('ordered.slice(start, start + sqlPageSize)')
    assert.ok(iFilter > -1 && iSort > iFilter, '排序没接在过滤之后')
    assert.ok(iSlice > iSort, '先切页后排序：只排当前页，跨页顺序是错的')
    assert.ok(/sortRowIndexes\(rows, indexes, sqlViewOf\(sqlViews, i\)\.sort, sqlSortNumeric\[i\]\)/.test(block),
      '排序没把"这一列是不是数值列"传进去')
  })
  test('表头点击受控：列头拿到 sort/onSort，三档由 nextSqlSort 决定，不重新执行 SQL', () => {
    assert.ok(/sort=\{sqlSortOf\(sqlViews, i, k\)\}/.test(src), '列头没拿到受控排序状态')
    assert.ok(/onSort=\{\(\) => onSqlSort\(i, k\)\}/.test(src), '列头没接点击')
    assert.ok(src.indexOf('nextSqlSort(') > -1, '三档循环没走共用函数')
    const fn = src.match(/const onSqlSort = \(i, key\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(fn, '找不到排序处理函数')
    assert.ok(/patchSqlView\(prev, i, \{ sort:/.test(fn[0]), '排序没写进每结果集的状态')
    assert.ok(/setSqlPages\(prev => \(\{ \.\.\.prev, \[i\]: 1 \}\)\)/.test(fn[0]), '换排序后没回第 1 页')
    assert.ok(!/runSql\(/.test(fn[0]), '点表头不该重新执行 SQL')
  })
  test('数值列判定与右对齐同源（isNumberType），驱动没给类型时才用值兜底', () => {
    assert.ok(/import \{[^}]*isNumberType[^}]*\} from '\.\.\/\.\.\/common\/db-format-value'/.test(src))
    const block = src.slice(src.indexOf('const sqlSortNumeric = useMemo('), src.indexOf('const sqlResultViews = useMemo('))
    assert.ok(/isNumberType\(dt\)/.test(block), '类型已知时没按类型判定')
    assert.ok(/looksNumericColumn\(rows, k\)/.test(block), '类型缺失时没有兜底推断')
  })
  test('大结果排序提示走词条，50k 阈值来自共用常量', () => {
    assert.ok(/SQL_SORT_BIG_ROWS/.test(src))
    assert.ok(/e\('dbSortLocal'\)/.test(src))
    const locales = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')
    assert.equal((locales.match(/dbSortLocal:/g) || []).length, 2, 'dbSortLocal 要 en + zh 各一条')
    assert.ok(/\{n\}/.test(locales.match(/dbSortLocal: '[^']*'/)[0]), '提示要留行数占位符')
  })
  test('列显隐接在两条派生链上：列定义与过滤都吃 visibleSqlKeys', () => {
    const colsBlock = src.slice(src.indexOf('const sqlResultColumns = useMemo('), src.indexOf('const sqlSortNumeric'))
    assert.ok(/visibleSqlKeys\(sqlColumnKeys\(r\), sqlViewOf\(sqlViews, i\)\.hidden\)/.test(colsBlock),
      '列定义没按 hidden 过滤')
    const viewsBlock = src.slice(src.indexOf('const sqlResultViews = useMemo('), src.indexOf('const renderSqlResults'))
    assert.ok(/visibleSqlKeys\(sqlColumnKeys\(r\), sqlViewOf\(sqlViews, i\)\.hidden\)/.test(viewsBlock),
      '过滤没只扫可见列（藏起来的列不该参与命中）')
    assert.ok(/toggleSqlHidden\(/.test(src), '切换没走共用函数（最后一列守卫会被绕过）')
  })
  test('列显隐菜单：勾选态只展示，切换统一走菜单 onClick（两处都接会互相抵消）', () => {
    assert.ok(/view\.total && keys\.length > 1/.test(src), '单列结果不该出列显隐按钮')
    const dd = src.slice(src.indexOf("overlayClassName='db-sql-cols-menu'"), src.indexOf("title={e('dbExportCsv')}"))
    assert.ok(/checked=\{!hidden\.includes\(k\)\}/.test(dd), '勾选态没跟 hidden 走')
    assert.ok(!/onChange=\{/.test(dd), 'Checkbox 不要再接 onChange，会跟菜单 onClick 打架')
    assert.ok(/key\.startsWith\('col::'\)/.test(dd), '列项没接切换')
    assert.ok(/onSqlToggleCol\(i, keys, k, hidden\.includes\(k\)\)/.test(dd), '切换没传"这一列现在是不是藏着的"')
    assert.ok(/hidden: \[\]/.test(dd), '"显示全部"没清 hidden')
    assert.ok(/disabled: !hidden\.length/.test(dd), '没有藏列时"显示全部"该是禁用的')
  })
  test('列显隐文案走词条，en + zh 各一条', () => {
    const locales = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')
    for (const k of ['dbShowHideCols', 'dbShowAllCols']) {
      assert.equal((locales.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
    }
    assert.ok(/e\('dbShowHideCols'\)/.test(src) && /e\('dbShowAllCols'\)/.test(src))
  })
})

describe('db-sql-result: 执行耗时状态（行数 + elapsedMs）', () => {
  const src = fs.readFileSync(SESSION, 'utf8')
  const locales = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')

  test('runSql 存 elapsedMs：后端没回传时存 null（不显示 NaN），回传了必须是有限数', () => {
    const block = src.match(/setSqlResult\(\{\s*loading: false,\s*results:[\s\S]*?\}\)/)
    assert.ok(block, '找不到 runSql 成功落状态的那一处')
    assert.ok(/elapsedMs/.test(block[0]), '成功结果没带耗时')
    assert.ok(/Number\.isFinite\(Number\(res\.elapsedMs\)\)/.test(block[0]), '必须先验证是有限数，旧后端没有这个字段')
    assert.ok(/: null/.test(block[0]), '没有耗时字段时落 null，前端按"不显示"处理')
  })

  test('状态行：行数用命中口径，词条 en + zh 各一条', () => {
    assert.ok(/className='db-sql-elapsed'/.test(src), '工具行右侧没有状态行')
    assert.ok(/replace\('\{rows\}', view\.matched\)/.test(src), '行数必须是命中口径（与网格所见一致），不是原始总数')
    for (const k of ['dbSqlRows', 'dbSqlRowsElapsed', 'dbSqlElapsedTotal']) {
      assert.equal((locales.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
    }
  })

  test('多结果页签旁标总耗时；旧后端（null）时页签标题保持原样', () => {
    const block = src.slice(src.indexOf("className='db-sql-results-tabs'"))
    assert.ok(/dbSqlElapsedTotal/.test(block), '页签标题没带总耗时')
    assert.ok(/sqlResult\.elapsedMs !== null/.test(block), 'null 时不能往页签标题拼 undefined')
  })
})
describe('db-sql-result: 单元格右键菜单（复制族 + 按值过滤）', () => {
  const src = fs.readFileSync(SESSION, 'utf8')
  const menuSrc = fs.readFileSync(
    path.join(ROOT, 'src/client/components/database/db-cell-menu.jsx'), 'utf8')
  const locales = fs.readFileSync(path.join(ROOT, 'src/app/common/locales-extra.js'), 'utf8')
  const fnStart = src.indexOf('const openSqlCellMenu')
  const fn = src.slice(fnStart, src.indexOf('const exportSqlCsv', fnStart))

  test('结果网格每格挂 onContextMenu → 单例菜单：不逐格挂 Dropdown，也不给列头另开一份', () => {
    const colsBlock = src.slice(
      src.indexOf('const sqlResultColumns = useMemo('),
      src.indexOf('const sqlSortNumeric')
    )
    // H1a-4：onCell 的接线在列工厂里，调用点只传 openCellMenu 适配器
    assert.ok(/openCellMenu: \(ev, row, k\) => openSqlCellMenu\(ev, i, k, row\)/.test(colsBlock),
      'SQL 结果的单元格没接右键')
    const colSrc = fs.readFileSync(path.join(ROOT, 'src/client/components/database/db-grid-columns.jsx'), 'utf8')
    assert.ok(/onContextMenu: ev => openCellMenu\(ev, row, k\)/.test(colSrc), '列工厂没把 onContextMenu 摊到格子上')
    // 全组件只挂一份浮层（1 万行 × 5 列逐格挂 Trigger 会拖垮渲染）
    assert.equal((src.match(/<DbCellMenu/g) || []).length, 1, '右键菜单必须是全站单例')
    assert.ok(!/Dropdown/.test(colsBlock), '列定义里不该出现逐格 Dropdown')
  })

  test('右键先 preventDefault（浏览器原生菜单不叠加），结果集拿不到就不开菜单', () => {
    assert.ok(fnStart > -1, '找不到 openSqlCellMenu')
    assert.ok(/ev\.preventDefault\(\)/.test(fn), '没拦原生右键菜单')
    assert.ok(/if \(!r \|\| !row\) \{\s*return/.test(fn), '结果集/行缺失时应直接不开菜单')
    assert.ok(/x: ev\.clientX/.test(fn) && /y: ev\.clientY/.test(fn), '落点用右键坐标（视口系）')
  })

  test('复制值口径与值面板同源：二进制信封复制 base64，其余复制 cellText', () => {
    assert.ok(/isBinEnvelope\(v\) \? v\.__bin\.b64 : cellText\(v\)/.test(fn),
      '复制值没走"信封→base64、其余→格子文本"这条口径')
    assert.ok(/copy\(col\)/.test(fn), '复制字段名该直接写列名')
  })

  test('整行 TSV/JSON 的列序与导出同源（sqlExportHeaders 以 fields 为准）', () => {
    assert.ok(/const headers = sqlExportHeaders\(r\)/.test(fn), '整行复制没和导出共用列序')
    assert.ok(/toTsv\(headers, \[row\]\)/.test(fn), '整行 TSV 没走 db-csv 的 toTsv')
    assert.ok(/buildCopyStatements\('json', \{ headers, rows: \[row\] \}\)/.test(fn),
      '整行 JSON 没走 buildCopyStatements（信封占位与 null 语义在那边）')
  })

  test('按值过滤复用手动输入那条路（防抖/命中口径/页码回第 1 页都在 onSqlFilterInput 里）', () => {
    assert.ok(/onSqlFilterInput\(rs, cellText\(v\)\)/.test(fn),
      '按值过滤应写进这一结果集的过滤状态，而不是另起一套')
    assert.ok(!/runSql\(/.test(fn), '右键动作不该重新执行 SQL')
  })

  test('菜单浮层的关闭通道与列宽菜单同一套（外点 capture / Escape / 滚动 / 点项即收）', () => {
    assert.ok(/document\.addEventListener\('pointerdown', onDown, true\)/.test(menuSrc))
    assert.ok(/ev\.key === 'Escape'/.test(menuSrc))
    assert.ok(/window\.addEventListener\('scroll', onHide, true\)/.test(menuSrc))
    assert.ok(/trigger=\{\[\]\}/.test(menuSrc), '浮层必须受控，不能让 Popover 自己开关')
    assert.ok(/destroyOnHidden/.test(menuSrc), '关闭即卸载，DOM 里不留隐藏浮层')
    assert.ok(/item\.onClick\(\)/.test(menuSrc) && /onHide\(\)/.test(menuSrc),
      '点菜单项要先执行动作再收起')
  })

  test('新结果到位就收起右键菜单（菜单闭包握着旧行对象与旧结果集下标）', () => {
    const eff = src.match(/useEffect\(\(\) => \{\s*setSqlPages\(\{\}\)[\s\S]*?\}, \[sqlResult\.results\]\)/)
    assert.ok(eff, '找不到"新结果到位就重置"的 effect')
    assert.ok(/setSqlCellMenu\(null\)/.test(eff[0]), '旧菜单留着就能抄旧行')
  })

  test('五条文案走词条，en + zh 各一条', () => {
    for (const k of ['dbCellCopyValue', 'dbCellCopyColName', 'dbCellCopyRowTsv',
      'dbCellCopyRowJson', 'dbCellFilterByValue']) {
      assert.equal((locales.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 要 en + zh 各一条')
    }
    for (const k of ['dbCellCopyValue', 'dbCellCopyColName', 'dbCellCopyRowTsv',
      'dbCellCopyRowJson', 'dbCellFilterByValue']) {
      assert.ok(new RegExp("e\\('" + k + "'\\)").test(fn), k + ' 没被用上')
    }
  })
})
