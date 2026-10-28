// SQL 大结果分页契约
//
// 背景：30k 行结果整表渲染 + 全量行键克隆，实测一次查询堆上 +17MB（隔离复跑），
// DOM 挂出上万节点；隐藏页签场景还会叠加 antd 非虚拟化整页渲染。
// 方案：结果全量留在 sqlResult（导出/复制要全量），表格固定 50 行/页，
// 行键克隆只做当前页，翻页纯前端切片、不重新执行 SQL。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const read = () => fs.readFileSync(JSX, 'utf8')

// 跑真实源码里的页码夹取函数（不是拷贝）
const loadPageIndex = () => {
  const src = read()
  const m = src.match(/const sqlPageIndex = \(page, total\) => \{[\s\S]*?\n\}/)
  assert.ok(m, 'sqlPageIndex not found in db-session.jsx')
  const expr = m[0].slice(m[0].indexOf('(page, total)'))
  return vm.runInNewContext('(' + expr + ')', { SQL_RESULT_PAGE_SIZE: 50 })
}

describe('SQL 结果分页：页码夹取（真实源码）', () => {
  const idx = loadPageIndex()

  test('empty result stays on page 1', () => {
    assert.equal(idx(undefined, 0), 1)
    assert.equal(idx(3, 0), 1)
  })

  test('in-range page passes through', () => {
    assert.equal(idx(1, 100), 1)
    assert.equal(idx(3, 30000), 3)
  })

  test('page beyond the last is clamped to the last', () => {
    // 30000 行 / 50 行一页 = 600 页
    assert.equal(idx(999, 30000), 600)
    assert.equal(idx(2, 20), 1)
  })

  test('dirty page values fall back to 1', () => {
    assert.equal(idx(0, 100), 1)
    assert.equal(idx(-5, 100), 1)
    assert.equal(idx(NaN, 100), 1)
  })
})

describe('SQL 结果分页：接线契约', () => {
  test('page size is 50', () => {
    assert.ok(read().includes('const SQL_RESULT_PAGE_SIZE = 50'), 'page size drifted')
  })

  test('row-key clones only the current page (slice before map)', () => {
    const src = read()
    const memo = src.match(/const sqlResultRowMaps = useMemo\([\s\S]*?\n\s{2}\)/)
    assert.ok(memo, 'sqlResultRowMaps memo not found')
    const code = memo[0]
    assert.ok(code.includes('rows.slice(start, start + SQL_RESULT_PAGE_SIZE)'), 'must slice before cloning')
    assert.ok(/rows\.slice\([^)]*\)\.map\(/.test(code), 'clone must run on the page slice, not the full result')
    assert.ok(!/\(r && r\.rows\) \|\| \[\]\)\.map\(/.test(code), 'full-result clone must not return')
  })

  test('pager is wired to the per-result page state', () => {
    const src = read()
    assert.ok(src.includes('current={sqlPageIndex(sqlPages[i], rows.length)}'), 'current page not wired')
    assert.ok(src.includes('pageSize={SQL_RESULT_PAGE_SIZE}'), 'page size not wired')
    assert.ok(src.includes('total={rows.length}'), 'total not wired')
    assert.ok(src.includes('showSizeChanger={false}'), 'page size must stay fixed')
    assert.ok(src.includes('onChange={p => setSqlPages('), 'page change handler missing')
  })

  test('pager lives in the top tools row, not the table footer', () => {
    const src = read()
    assert.ok(src.includes('const pager = rows.length > SQL_RESULT_PAGE_SIZE'), 'pager threshold missing')
    // 表尾分页会被底部命令栏遮住 → 表格不再渲染自带底部分页器
    assert.ok(src.includes('pagination={false}'), 'table must not render the footer pager')
    const tools = src.match(/<div className='db-sql-result-tools'>[\s\S]*?\n\s{10}<\/div>/)
    assert.ok(tools, 'tools row not found')
    assert.ok(tools[0].includes('{pager}'), 'pager must render inside the tools row')
  })

  test('result grid has a visible frame (footer avoidance is obvious)', () => {
    const src = read()
    assert.ok(src.includes("className='db-sql-result-grid'"), 'grid frame class missing')
    const styl = fs.readFileSync(STYL, 'utf8')
    const block = styl.match(/\.db-grid-table-wrap\.db-sql-result-grid\n((?: {2}[^\n]*\n)+)/)
    assert.ok(block, '.db-sql-result-grid rule not found')
    assert.match(block[1], /^ {2}border 1px solid var\(--border\)$/m, 'grid frame border missing')
    assert.match(block[1], /^ {2}border-radius var\(--radius-sm\)$/m, 'grid frame radius missing')
  })

  test('tools row aligns left (pager + export on the same row)', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const block = styl.match(/\.db-sql-result-tools\n((?: {2}[^\n]*\n)+)/)
    assert.ok(block, '.db-sql-result-tools rule not found')
    assert.match(block[1], /^ {2}justify-content flex-start$/m, 'tools row must be left-aligned')
    assert.ok(!/justify-content flex-end/.test(block[1]), 'right alignment must not return')
  })

  test('new result resets to page 1', () => {
    const src = read()
    const reset = src.match(/useEffect\(\(\) => \{\s*setSqlPages\(\{\}\)\s*\}, \[sqlResult\.results\]\)/)
    assert.ok(reset, 'page reset effect missing')
  })

  test('export still exports the whole result, not the current page', () => {
    const src = read()
    assert.ok(src.includes('exportSqlJson(r, i)') && src.includes('exportSqlCsv(r, i)'), 'export must use the full result')
  })
})
