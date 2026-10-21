const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const loadJsx = () => fs.readFileSync(JSX, 'utf8')
const loadStyl = () => fs.readFileSync(STYL, 'utf8')
const loadLocales = () => fs.readFileSync(LOCALES, 'utf8')

// 从真实源码抽 useMemo 回调体执行，避免测试拷贝一份过滤逻辑
const loadFilteredRows = () => {
  const src = loadJsx()
  const m = src.match(
    /const filteredRows = useMemo\(\(\) => \{([\s\S]*?)\n\s{2}\}, \[grid\.rows, pageFilterKw\]\)/
  )
  assert.ok(m, 'filteredRows derivation not found in db-session.jsx')
  return vm.runInNewContext('(function (grid, pageFilterKw) {' + m[1] + '})', {})
}

const loadVisibleMetadata = () => {
  const src = loadJsx()
  const m = src.match(
    /const visibleMetadata = useMemo\(\(\) => \{([\s\S]*?)\n\s{2}\}, \[metadata, isRedis, treeFilterKw\]\)/
  )
  assert.ok(m, 'visibleMetadata derivation not found in db-session.jsx')
  return vm.runInNewContext(
    '(function (metadata, isRedis, treeFilterKw) {' + m[1] + '})',
    {}
  )
}

describe('T1 current-page row filter (real source)', () => {
  const filterRows = loadFilteredRows()
  const grid = {
    rows: [
      { id: 1, status: 'active', customer: 'Alice' },
      { id: 2, status: 'paid', customer: 'Bob' },
      { id: 3, status: null, customer: 'Carol' }
    ]
  }

  test('empty keyword returns all rows with original __rowKey', () => {
    const out = filterRows(grid, '')
    assert.equal(out.length, 3)
    assert.deepEqual(out.map(r => r.__rowKey), [0, 1, 2])
  })

  test('case-insensitive match across any visible column', () => {
    const byStatus = filterRows(grid, 'active')
    assert.equal(byStatus.length, 1)
    assert.equal(byStatus[0].id, 1)
    assert.equal(byStatus[0].__rowKey, 0)

    const byCustomer = filterRows(grid, 'bob')
    assert.equal(byCustomer.length, 1)
    assert.equal(byCustomer[0].id, 2)
    assert.equal(byCustomer[0].__rowKey, 1)
  })

  test('NULL cells match the rendered NULL text', () => {
    const out = filterRows(grid, 'null')
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 3)
    assert.equal(out[0].__rowKey, 2)
  })

  test('no match returns empty list (table empty state stays distinguishable)', () => {
    assert.equal(filterRows(grid, 'zzz').length, 0)
  })

  test('rowKey stays the original page index after filtering', () => {
    const out = filterRows(grid, 'carol')
    assert.equal(out.length, 1)
    // 选中/编辑/UPDATE 依赖 __rowKey 回到 grid.rows，不能改成过滤后的新索引
    assert.equal(out[0].__rowKey, 2)
  })
})

describe('T2 metadata tree filter (real source)', () => {
  const filterTree = loadVisibleMetadata()
  const mysqlTree = [
    { name: 'shop', children: [{ name: 'orders' }, { name: 'users' }] },
    { name: 'analytics', children: [{ name: 'events' }] }
  ]

  test('database hit keeps all its children, other databases drop out', () => {
    const out = filterTree(mysqlTree, false, 'shop')
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'shop')
    assert.deepEqual(out[0].children.map(t => t.name), ['orders', 'users'])
  })

  test('table-only hit keeps just matching tables under the parent', () => {
    const out = filterTree(mysqlTree, false, 'user')
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'shop')
    assert.deepEqual(out[0].children.map(t => t.name), ['users'])
  })

  test('no match drops all databases', () => {
    assert.equal(filterTree(mysqlTree, false, 'zzz').length, 0)
  })

  test('redis filters db nodes by name and keeps count', () => {
    const redisTree = [
      { name: 'db0', count: 12 },
      { name: 'db1', count: 0 }
    ]
    const out = filterTree(redisTree, true, 'db0')
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'db0')
    assert.equal(out[0].count, 12)
  })
})

describe('T1/T2 wiring contract', () => {
  test('main grid uses filteredRows and preserves page-filter highlight class', () => {
    const src = loadJsx()
    assert.ok(src.includes('dataSource={filteredRows}'), 'grid dataSource must use filteredRows')
    assert.ok(src.includes('return renderCell(v, pageFilterKw)'), 'cells must highlight page filter')
    assert.ok(src.includes("className='db-page-filter'"), 'page filter input missing')
    assert.ok(src.includes("'db-page-hit'"), 'page filter mark class must stay isolated')
  })

  test('page filter resets on table/sort/page-size/refresh', () => {
    const src = loadJsx()
    const resets = src.match(/resetPageFilter\(\)/g) || []
    assert.ok(resets.length >= 4, 'expected resetPageFilter on table/sort/pageSize/refresh, got ' + resets.length)
    assert.ok(
      !/runGlobalAsync\('dbClientOp', tabId, 'getPageData',[\s\S]{0,140}pageFilter/.test(src),
      'page filter must stay front-end only (no getPageData arg)'
    )
  })

  test('tree filter uses isolated mark class and keeps top search separate', () => {
    const src = loadJsx()
    assert.ok(src.includes('const visibleMetadata = useMemo'), 'visibleMetadata missing')
    assert.ok(src.includes("'db-tree-hit'"), 'tree filter mark class missing')
    assert.ok(src.includes('treeExpandedBeforeFilter'), 'expand snapshot missing')
    assert.ok(src.includes('db-tree-filter'), 'tree filter input missing')
    // 顶栏查找的计数仍只收 db-kw-hit
    assert.ok(src.includes("root.querySelectorAll('.db-kw-hit')"), 'top search count must not collect tree hits')
  })

  test('i18n keys exist for both en and zh_cn', () => {
    const locales = loadLocales()
    const keys = [
      'dbFilterPage',
      'dbFilterPageHint',
      'dbFilterTree',
      'dbFilterNoPageMatch',
      'dbFilterNoTreeMatch',
      'dbFilterClear',
      'dbFilterNodes'
    ]
    keys.forEach(key => {
      const hits = locales.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.ok(hits.length >= 2, key + ' must exist in en and zh_cn')
    })
  })
})

describe('T1/T2 css tokens', () => {
  test('filter/hit styles exist and use tokens (no hardcoded colors)', () => {
    const styl = loadStyl()
    ;['.db-page-filter', '.db-page-filter-count', '.db-tree-filter', '.db-tree-filter-count', '.db-page-hit', '.db-tree-hit'].forEach(sel => {
      assert.match(styl, new RegExp('^' + sel.replace('.', '\\.') + '$', 'm'), sel + ' block missing')
    })
    const blocks = [
      styl.match(/^\.db-page-hit\n(?:[ \t]+[^\n]*\n)+/m),
      styl.match(/^\.db-tree-hit\n(?:[ \t]+[^\n]*\n)+/m)
    ].filter(Boolean).map(m => m[0]).join('\n')
    assert.ok(blocks.includes('var(--accent-wash)'), 'hit marks must use theme tokens')
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(blocks), 'hit marks must not hardcode colors')
  })
})
