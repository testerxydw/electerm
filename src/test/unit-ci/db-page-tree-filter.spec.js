const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a：isLeafNode / nodeKey 这类纯判定随常量段一起搬到 common/db-session-const.js
const SESSION_CONST = path.join(ROOT, 'src/client/common/db-session-const.js')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const loadJsx = () => fs.readFileSync(JSX, 'utf8')
const loadConst = () => fs.readFileSync(SESSION_CONST, 'utf8')
const loadStyl = () => fs.readFileSync(STYL, 'utf8')
const loadLocales = () => fs.readFileSync(LOCALES, 'utf8')

// 从真实源码抽 useMemo 回调体执行，避免测试拷贝一份过滤逻辑
// H2：过滤改成按 cellText（格子里的可见文本）比，沙箱里要给出同一个实现，
// 否则 JSON 列"看得见却搜不到"这条又会悄悄退化
const loadFilteredRows = () => {
  const src = loadJsx()
  const m = src.match(
    /const filteredRows = useMemo\(\(\) => \{([\s\S]*?)\n\s{2}\}, \[grid\.rows, pageFilterKw\]\)/
  )
  assert.ok(m, 'filteredRows derivation not found in db-session.jsx')
  const cw = fs.readFileSync(path.join(ROOT, 'src/client/common/db-column-width.js'), 'utf8')
  const fn = cw.match(/export function cellText \(v\) \{([\s\S]*?)\n\}/)
  assert.ok(fn, 'cellText not found in db-column-width.js')
  const isBin = cw.match(/export function isBinEnvelope \(v\) \{([\s\S]*?)\n\}/)
  assert.ok(isBin, 'isBinEnvelope not found in db-column-width.js')
  const cellText = vm.runInNewContext(
    '(function () {' +
      'const isBinEnvelope = (v) => {' + isBin[1] + '};' +
      'const cellText = (v) => {' + fn[1] + '};' +
      'return cellText' +
    '})()',
    {}
  )
  return vm.runInNewContext('(function (grid, pageFilterKw) {' + m[1] + '})', { cellText })
}

const loadVisibleMetadata = () => {
  const src = loadJsx()
  const m = src.match(
    /const visibleMetadata = useMemo\(\(\) => \{([\s\S]*?)\n\s{2}\}, \[metadata, isRedis, treeFilterKw\]\)/
  )
  assert.ok(m, 'visibleMetadata derivation not found in db-session.jsx')
  // F0：叶子判定提成了模块级 isLeafNode（table + view），
  // 抠函数体执行时要把它一起带上，否则 vm 里 ReferenceError
  const leaf = loadConst().match(/^const isLeafNode = .+$/m)
  assert.ok(leaf, 'isLeafNode not found in db-session-const.js')
  return vm.runInNewContext(
    '(() => {' + leaf[0] + '; return function (metadata, isRedis, treeFilterKw) {' + m[1] + '}; })()',
    {}
  )
}

const loadTreeFilterExpandKeys = () => {
  const src = loadJsx()
  const body = src.match(/ {4}(const keys = \[\][\s\S]*?)\n {4}setExpandedKeys\(keys\)/)
  assert.ok(body, 'tree filter auto-expand effect not found in db-session.jsx')
  // 展开键跟 isLeafNode / nodeKey 同源执行：测试里另抄一份 key 推导，就钉不住"两边是不是同一个形态"
  const leaf = loadConst().match(/^const isLeafNode = .+$/m)
  assert.ok(leaf, 'isLeafNode not found in db-session-const.js')
  const nk = loadConst().match(/const nodeKey = \(database, schema, table\) => JSON\.stringify\(\[[\s\S]*?\]\)/)
  assert.ok(nk, 'nodeKey not found in db-session-const.js')
  return vm.runInNewContext(
    '(() => {' + leaf[0] + ';' + nk[0] +
    '; return function (visibleMetadata) {' + body[1] + '\n return keys }; })()',
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

  test('JSON 列按格子里的文本匹配（原来是 [object Object]，右键按值过滤必然零命中）', () => {
    const jsonGrid = {
      rows: [
        { id: 1, payload: { uid: 1001, action: 'export' } },
        { id: 2, payload: { uid: 1002, action: 'import' } }
      ]
    }
    const byAction = filterRows(jsonGrid, 'export')
    assert.equal(byAction.length, 1)
    assert.equal(byAction[0].__rowKey, 0)
    const byUid = filterRows(jsonGrid, '1002')
    assert.equal(byUid.length, 1)
    assert.equal(byUid[0].__rowKey, 1)
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

  test('pg schema branch is filtered recursively (T3)', () => {
    const pgTree = [{
      name: 'shop',
      type: 'database',
      children: [{
        name: 'public',
        type: 'schema',
        children: [
          { name: 'orders', type: 'table' },
          { name: 'users', type: 'table' }
        ]
      }]
    }]
    const byTable = filterTree(pgTree, false, 'user')
    assert.equal(byTable.length, 1)
    assert.equal(byTable[0].children.length, 1)
    assert.equal(byTable[0].children[0].name, 'public')
    assert.deepEqual(byTable[0].children[0].children.map(t => t.name), ['users'])

    const bySchema = filterTree(pgTree, false, 'public')
    assert.equal(bySchema[0].children[0].children.length, 2, 'schema hit keeps all tables')
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

describe('T2 tree filter auto-expand keys (real source)', () => {
  const expandKeys = loadTreeFilterExpandKeys()
  // treeData 里节点 key 的两种形态，就是这里要对照的"标准答案"
  const treeKey = (database, schema, table) => JSON.stringify([database, schema || '', table || ''])

  test('mysql: 分组节点的展开键用三位形态（与 treeData 同一个 key）', () => {
    const metadata = [{
      name: 'app',
      type: 'database',
      children: [
        { name: 'orders', type: 'table' },
        { name: 'routines', type: 'group', group: 'routine', children: [{ name: 'p1', type: 'procedure' }] }
      ]
    }]
    const keys = expandKeys(metadata)
    assert.ok(keys.includes(treeKey('app')), '库节点要展开')
    assert.ok(keys.includes(treeKey('app', '', 'routines')), '分组节点要按 nodeKey(库, 空 schema, 组名) 展开')
    assert.ok(!keys.includes(treeKey('app', 'routines')), '分组不是 schema，不能写成两位形态')
  })

  test('pg: schema 用两位形态，schema 下的分组带上 schema 名', () => {
    const metadata = [{
      name: 'app',
      type: 'database',
      children: [{
        name: 'public',
        type: 'schema',
        children: [
          { name: 'orders', type: 'table' },
          { name: 'triggers', type: 'group', group: 'trigger', children: [{ name: 't1', type: 'trigger' }] }
        ]
      }]
    }]
    const keys = expandKeys(metadata)
    assert.ok(keys.includes(treeKey('app', 'public')), 'schema 节点要展开')
    assert.ok(keys.includes(treeKey('app', 'public', 'triggers')), 'schema 下的分组展开键要带上 schema')
  })

  test('叶子不进展开集，命中例程的分组不能只计数不展开', () => {
    const keys = expandKeys([{
      name: 'app',
      type: 'database',
      children: [
        { name: 'orders', type: 'table' },
        { name: 'routines', type: 'group', group: 'routine', children: [{ name: 'p1', type: 'procedure' }] }
      ]
    }])
    // vm 里造的是另一个 realm 的数组，deepStrictEqual 会比原型 → 先复制成本地数组
    assert.deepEqual(Array.from(keys), [treeKey('app'), treeKey('app', '', 'routines')])
  })
})

describe('T1/T2 wiring contract', () => {
  test('main grid uses filteredRows and preserves page-filter highlight class', () => {
    const src = loadJsx()
    assert.ok(src.includes('dataSource={filteredRows}'), 'grid dataSource must use filteredRows')
    // E2-3b：第三参是列类型（展示层格式化用），pageFilterKw 仍是第二参。
    // H1a-4：render 的喂入挪进列工厂，调用点只传 filterKw: pageFilterKw
    assert.ok(src.includes('filterKw: pageFilterKw'), 'cells must highlight page filter')
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
