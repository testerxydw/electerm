// N12c 后续：关系对象组（索引 / 序列）默认隐藏 + 顶栏开关 —— 契约 spec。
//
// 钉住四件事：
//   1) 纯函数 dropRelationGroups 的语义（递归、不改入参、只管 index/sequence）；
//   2) 树装配层：裁剪发生在关键字过滤**之前**，开关为真时短路；
//   3) owner 层：默认关闭的判定方向（=== true 才显示），toggle 写 config 并下发；
//   4) UI 与词条：head-bar 的 Switch 直连 toggle、redis 树不展示、en/zh 成对。
//
// 为什么"默认关闭"要单独钉方向：写成 `dbShowRelationGroups !== false` 就变成默认**显示**，
// 判据全绿（开关能切、树能裁），只有方向反了 —— 这正是本轮需求的核心，必须显式锁。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

// 与 db-tree-relations.spec.js 同一截取法：const 片段只依赖自身，vm 里可直接执行
const constSrc = read('src/client/common/db-session-const.js')
const constSeg = constSrc.slice(
  constSrc.indexOf('\nconst isLeafNode ='),
  constSrc.indexOf('// U1c：空态')
)
const { dropRelationGroups, RELATION_GROUPS } = vm.runInNewContext(
  constSeg + '; ({ dropRelationGroups, RELATION_GROUPS })'
)

const treeDataSrc = read('src/client/components/database/use-db-tree-data.jsx')
const sessionSrc = read('src/client/components/database/db-session.jsx')
const headBarSrc = read('src/client/components/database/db-session-head-bar.jsx')
const localesSrc = read('src/app/common/locales-extra.js')

// MySQL 形状：库 → 表 / 视图 / 五个对象组
const mysqlFixture = () => ({
  name: 'tgfsom',
  type: 'database',
  children: [
    { name: 'orders', type: 'table' },
    { name: 'v_orders', type: 'view' },
    { name: 'routines', type: 'group', group: 'routine', children: [{ name: 'p1', type: 'procedure' }] },
    { name: 'triggers', type: 'group', group: 'trigger', children: [{ name: 't1', type: 'trigger', table: 'orders' }] },
    { name: 'events', type: 'group', group: 'event', children: [] },
    {
      name: 'indexes',
      type: 'group',
      group: 'index',
      children: [
        { name: 'PRIMARY', type: 'index', table: 'orders' },
        { name: 'idx_name', type: 'index', table: 'orders' }
      ]
    },
    { name: 'sequences', type: 'group', group: 'sequence', children: [{ name: 'seq_a', type: 'sequence' }] }
  ]
})

// PG 形状：库 → schema → 表 / 对象组（裁剪必须递归到 schema 层）
const pgFixture = () => ({
  name: 'demo',
  type: 'database',
  children: [{
    name: 'public',
    type: 'schema',
    children: [
      { name: 'orders', type: 'table' },
      { name: 'sequences', type: 'group', group: 'sequence', children: [{ name: 's1', type: 'sequence' }] },
      { name: 'indexes', type: 'group', group: 'index', children: [{ name: 'i1', type: 'index', table: 'orders' }] }
    ]
  }]
})

const groupNames = nodes => (nodes || []).map(n => n.name)

describe('dropRelationGroups 纯函数语义', () => {
  test('顶层：index/sequence 组剔除，routine/trigger/event 与表/视图保留', () => {
    const out = dropRelationGroups([mysqlFixture()])
    const names = groupNames(out[0].children)
    assert.ok(!names.includes('indexes'), 'indexes 组应被剔除')
    assert.ok(!names.includes('sequences'), 'sequences 组应被剔除')
    for (const keep of ['orders', 'v_orders', 'routines', 'triggers', 'events']) {
      assert.ok(names.includes(keep), keep + ' 应保留')
    }
  })

  test('PG：递归到 schema 层（库 → schema → 组的裁剪生效）', () => {
    const out = dropRelationGroups([pgFixture()])
    const schema = out[0].children[0]
    assert.equal(schema.name, 'public')
    const names = groupNames(schema.children)
    assert.ok(!names.includes('indexes') && !names.includes('sequences'))
    assert.ok(names.includes('orders'))
  })

  test('只认 group 字段：同名的表/视图不受牵连', () => {
    const fixture = [{
      name: 'demo',
      type: 'database',
      children: [
        // 表恰好叫 indexes（PG 实测里真会出现这种表名，db-tree-relations.spec 的夹具就用过）
        { name: 'indexes', type: 'table' },
        { name: 'sequences', type: 'view' }
      ]
    }]
    const out = dropRelationGroups(fixture)
    assert.deepEqual(groupNames(out[0].children), ['indexes', 'sequences'])
  })

  test('不改入参（metadata 是主进程契约，只读）', () => {
    const fixture = [mysqlFixture()]
    const before = JSON.parse(JSON.stringify(fixture))
    dropRelationGroups(fixture)
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), before)
  })

  test('空 / undefined 容错', () => {
    // 跨 realm：vm 里的数组原型与宿主不同，deepEqual 会比原型 —— 用长度判
    assert.equal(dropRelationGroups([]).length, 0)
    assert.equal(dropRelationGroups(undefined).length, 0)
  })

  test('RELATION_GROUPS 恰为 index + sequence（防止被扩成 routines/triggers/events）', () => {
    assert.deepEqual(Array.from(RELATION_GROUPS).sort(), ['index', 'sequence'])
  })
})

describe('树装配接线（use-db-tree-data）', () => {
  test('裁剪在关键字过滤之前：先定节点集合，再谈命中（空态计数才不会算进隐藏组）', () => {
    const iDrop = treeDataSrc.indexOf('dropRelationGroups(metadata)')
    const iKw = treeDataSrc.indexOf('if (!treeFilterKw)')
    assert.ok(iDrop > 0, 'visibleMetadata 里应调用 dropRelationGroups(metadata)')
    assert.ok(iKw > 0, '应保留 treeFilterKw 短路分支')
    assert.ok(iDrop < iKw, '裁剪必须早于关键字过滤')
  })

  test('开关为真或 redis 树时短路（redis 没有对象组，不必裁）', () => {
    assert.match(treeDataSrc, /\(showRelationGroups \|\| isRedis\) \? metadata : dropRelationGroups\(metadata\)/)
  })

  test('deps 含 showRelationGroups（开关变化要重建树）', () => {
    assert.match(treeDataSrc, /\[metadata, isRedis, treeFilterKw, showRelationGroups\]/)
  })
})

describe('owner 接线（db-session）', () => {
  test('默认关闭：判定方向是 === true（写成 !== false 就变成默认显示）', () => {
    assert.match(sessionSrc, /const showRelationGroups = window\.store\._config\.dbShowRelationGroups === true/)
    assert.ok(!/dbShowRelationGroups !== false/.test(sessionSrc), '不允许 !== false 的反向判定')
  })

  test('toggle 取反读实时 config（连点不读闭包旧值），持久化由 watch.js autoRun 承担', () => {
    assert.match(sessionSrc, /dbShowRelationGroups: !\(window\.store\._config\.dbShowRelationGroups === true\)/)
  })

  test('下发两处：head-bar（UI）与 useDbTreeData（裁剪）', () => {
    const headBlock = sessionSrc.slice(
      sessionSrc.indexOf('<DbSessionHeadBar'),
      sessionSrc.indexOf('/>', sessionSrc.indexOf('<DbSessionHeadBar'))
    )
    assert.match(headBlock, /showRelationGroups=\{showRelationGroups\}/)
    assert.match(headBlock, /toggleRelationGroups=\{toggleRelationGroups\}/)
    const treeBlock = sessionSrc.slice(
      sessionSrc.indexOf('useDbTreeData({'),
      sessionSrc.indexOf('})', sessionSrc.indexOf('useDbTreeData({'))
    )
    assert.match(treeBlock, /showRelationGroups\b/)
  })
})

describe('head-bar UI 与词条', () => {
  test('Switch 直连 showRelationGroups / toggleRelationGroups', () => {
    assert.match(headBarSrc, /checked=\{showRelationGroups\}/)
    assert.match(headBarSrc, /onChange=\{toggleRelationGroups\}/)
  })

  test('Tooltip 说明含 hint 词条（默认关闭的理由要能看见）', () => {
    assert.match(headBarSrc,
      /Tooltip title=\{`\$\{e\('dbShowRelationGroups'\)\} — \$\{e\('dbShowRelationGroupsHint'\)\}`\}/)
  })

  test('redis 树不展示该开关（redis 没有对象组）', () => {
    const seg = headBarSrc.slice(
      headBarSrc.indexOf("dbShowRelationGroups')"),
      headBarSrc.indexOf('db-relation-toggle')
    )
    assert.ok(seg.length > 0, '应有 db-relation-toggle 分支')
    const guard = headBarSrc.slice(headBarSrc.lastIndexOf('isRedis', headBarSrc.indexOf('db-relation-toggle')))
    assert.match(guard, /^isRedis\s*\n?\s*\? null/, 'db-relation-toggle 前应有 isRedis ? null 守卫')
  })

  test('en / zh_cn 词条成对（值非空且各出现一次）', () => {
    for (const key of ['dbShowRelationGroups', 'dbShowRelationGroupsHint']) {
      const hits = localesSrc.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.equal(hits.length, 2, key + ' 应在 en 与 zh_cn 各出现一次')
    }
    assert.match(localesSrc, /dbShowRelationGroups: 'Indexes\/Seq\.'/)
    assert.match(localesSrc, /dbShowRelationGroups: '索引\/序列'/)
    // 误删相邻词条的自检：N12c 改动时踩过（dbFormatSql 被连带删掉）
    assert.match(localesSrc, /dbFormatSql: 'Format SQL/)
    assert.match(localesSrc, /dbFormatSql: '格式化 SQL/)
  })
})
