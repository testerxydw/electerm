/**
 * N7 新建表 / 新建键 + 方案 B 单流水线 —— 纯函数单测
 *
 * createTableDdl（db-ddl-generate）：吃 draftToStructure 产出的 **v2 结构** →
 * CREATE TABLE 候选脚本。列定义与 ALTER 共享 colDefTail，且归一化只允许在
 * draftToStructure 一处，所以这里直接构造 v2 结构而不是草稿。
 *
 * designPreview(mode:'create') / emptyDraft / draftAsNew（db-table-design）：
 * 新建、复制表与改表共用预览入口后的形状、校验与拒绝口径。
 *
 * buildCreateKeyPlan（db-redis-create-key）：Redis 新建键的行文本 → 既有 op
 * 调用序列。解析规则（field=value 首个 = 分隔、score member 首个空白分隔、
 * list 统一 RPUSH 保序）全部钉在这里。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
let G
let CK
let D

before(async () => {
  G = await import('file://' + path.join(ROOT, 'src/client/common/db-ddl-generate.js'))
  CK = await import('file://' + path.join(ROOT, 'src/client/common/db-redis-create-key.js'))
  D = await import('file://' + path.join(ROOT, 'src/client/common/db-table-design.js'))
})

// v2 结构列：columnType / defaultValue(null = 没有默认)，喂给 createTableDdl
const V2_COL = (name, extra = {}) => ({
  name,
  columnType: 'int(11)',
  nullable: true,
  defaultValue: null,
  comment: null,
  ...extra
})

const V2_IX = (name, columns, extra = {}) => ({
  name,
  columns,
  unique: false,
  primary: false,
  method: null,
  ...extra
})

// 设计器草稿列：喂给 designPreview / draftToStructure
const DRAFT_COL = (name, extra = {}) => ({
  key: name,
  origName: '',
  name,
  type: 'int(11)',
  nullable: true,
  hasDefault: false,
  defaultValue: '',
  comment: '',
  src: null,
  ...extra
})

const DRAFT_IX = (name, columns, extra = {}) => ({
  key: name,
  origName: '',
  name,
  columns,
  unique: false,
  primary: false,
  method: null,
  src: null,
  ...extra
})

describe('createTableDdl：v2 结构 → CREATE TABLE 候选脚本', () => {
  const baseStructure = () => ({
    type: 'table',
    comment: null,
    columns: [
      V2_COL('id', { nullable: false, defaultValue: '0' }),
      V2_COL('name', { columnType: 'varchar(64)', comment: '用户名' })
    ],
    indexes: [V2_IX('pk', ['id'], { primary: true })],
    foreignKeys: []
  })

  test('happy path：列/PK/表注释全进一条 CREATE，标识符反引号', () => {
    const structure = { ...baseStructure(), comment: '测试表' }
    structure.indexes.push(V2_IX('uk_name', ['name'], { unique: true }))
    const res = G.createTableDdl(structure, 'mysql', { database: 'mydb', table: 't_users' })
    assert.ok(res.supported, res.reason)
    assert.strictEqual(res.sqls.length, 1)
    const sql = res.sqls[0]
    assert.ok(sql.startsWith('CREATE TABLE `mydb`.`t_users` ('), sql)
    assert.ok(sql.includes('`id` int(11) NOT NULL DEFAULT 0'), sql)
    assert.ok(sql.includes("`name` varchar(64) COMMENT '用户名'"), sql)
    assert.ok(sql.includes('PRIMARY KEY (`id`)'), sql)
    assert.ok(sql.includes('UNIQUE KEY `uk_name` (`name`)'), sql)
    // 没有默认值的列（defaultValue=null）不许拼 DEFAULT ''
    assert.ok(!sql.includes("DEFAULT ''"), sql)
    // 表注释是表选项，必须挂在右括号之后；不许出现在括号内（那是列/索引列表，
    // 拼进去 MySQL 直接 syntax near '='）
    assert.ok(sql.endsWith(") COMMENT='测试表'"), sql)
    assert.ok(!/\n\s*COMMENT=/.test(sql), sql)
  })

  test('普通索引内联 INDEX，无索引时不出键行', () => {
    const structure = baseStructure()
    structure.indexes.push(V2_IX('ix1', ['name']))
    const res = G.createTableDdl(structure, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(res.supported, res.reason)
    assert.ok(res.sqls[0].includes('INDEX `ix1` (`name`)'), res.sqls[0])
    const noIx = G.createTableDdl({ ...baseStructure(), indexes: [] }, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(noIx.supported)
    assert.ok(!noIx.sqls[0].includes('INDEX'), noIx.sqls[0])
  })

  test('多列逗号分隔，主键列可多列', () => {
    const structure = baseStructure()
    structure.indexes = [V2_IX('pk', ['id', 'name'], { primary: true })]
    const res = G.createTableDdl(structure, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(res.supported)
    assert.ok(res.sqls[0].includes('PRIMARY KEY (`id`, `name`)'), res.sqls[0])
  })

  test('结构不对 → supported=false + 机器码 reason', () => {
    const t = 'mydb'
    assert.strictEqual(G.createTableDdl(baseStructure(), 'mysql', { database: t, table: 'a.b' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl(baseStructure(), 'mysql', { database: t, table: '' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl(baseStructure(), 'mysql', { database: t, table: '9t' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl({ ...baseStructure(), columns: [] }, 'mysql', { database: t, table: 't' }).reason, 'no-column')
    const badCol = baseStructure()
    badCol.columns[0] = { ...badCol.columns[0], name: 'a b' }
    assert.strictEqual(G.createTableDdl(badCol, 'mysql', { database: t, table: 't' }).reason, 'bad-column-name')
    const noType = baseStructure()
    noType.columns[0] = { ...noType.columns[0], columnType: '' }
    assert.strictEqual(G.createTableDdl(noType, 'mysql', { database: t, table: 't' }).reason, 'missing-column-type')
    const dup = baseStructure()
    dup.columns.push(V2_COL('id'))
    assert.strictEqual(G.createTableDdl(dup, 'mysql', { database: t, table: 't' }).reason, 'duplicate-column')
    const badIx = baseStructure()
    badIx.indexes.push(V2_IX('ix', ['ghost']))
    assert.strictEqual(G.createTableDdl(badIx, 'mysql', { database: t, table: 't' }).reason, 'index-column-missing')
  })

  test('能力位：sqlite / pg 不给语句（与 alterDdl 不同源）', () => {
    const res = G.createTableDdl(baseStructure(), 'sqlite', { database: 'd', table: 't' })
    assert.strictEqual(res.supported, false)
    assert.strictEqual(res.reason, 'create-unsupported-dialect')
    assert.strictEqual(G.createTableDdl(baseStructure(), 'postgres', { database: 'd', table: 't' }).reason, 'create-unsupported-dialect')
  })

  test('幂等：同一结构两次生成逐字一致', () => {
    const a = G.createTableDdl(baseStructure(), 'mysql', { database: 'd', table: 't' }).sqls[0]
    const b = G.createTableDdl(baseStructure(), 'mysql', { database: 'd', table: 't' }).sqls[0]
    assert.strictEqual(a, b)
  })
})

describe('方案 B：新建/复制/改表共用一条流水线', () => {
  const filledDraft = () => ({
    comment: '',
    columns: [
      DRAFT_COL('id', { nullable: false, hasDefault: true, defaultValue: '0' }),
      DRAFT_COL('name', { type: 'varchar(64)', comment: '用户名' })
    ],
    indexes: [DRAFT_IX('pk', ['id'], { primary: true })],
    foreignKeys: []
  })
  const target = { database: 'mydb', schema: '', table: 't_users' }

  test('emptyDraft 形状与 createDraft 同源（不会缺 foreignKeys）', () => {
    const blank = D.emptyDraft()
    assert.deepEqual(Object.keys(blank).sort(), ['columns', 'comment', 'foreignKeys', 'indexes'])
    assert.equal(blank.columns.length, 1)
    assert.equal(blank.columns[0].origName, '')
    assert.deepEqual(blank.foreignKeys, [])
    assert.deepEqual(Object.keys(D.createDraft({})).sort(), Object.keys(blank).sort())
  })

  test('create 模式也走 designIssues，不再有第二套校验口径', () => {
    const blank = D.designPreview({ mode: 'create', draft: D.emptyDraft(), dialect: 'mysql', target })
    assert.deepEqual(blank.issues.map(i => i.code), ['unnamed-column'])
    assert.deepEqual(blank.items, [])
    const dup = filledDraft()
    dup.columns.push(DRAFT_COL('id'))
    const r = D.designPreview({ mode: 'create', draft: dup, dialect: 'mysql', target })
    assert.ok(r.issues.some(i => i.code === 'duplicate-column'), JSON.stringify(r.issues))
  })

  test('designPreview(create) 与直调生成器逐字一致（唯一归一化出口）', () => {
    const draft = filledDraft()
    const r = D.designPreview({ mode: 'create', draft, dialect: 'mysql', target })
    assert.equal(r.issues.length, 0)
    assert.equal(r.items.length, 1)
    const direct = G.createTableDdl(D.draftToStructure(draft), 'mysql', target)
    assert.deepEqual(r.items[0].sqls, direct.sqls)
    // hasDefault=false 的列不许拼 DEFAULT ''
    assert.ok(!r.items[0].sqls[0].includes("DEFAULT ''"), r.items[0].sqls[0])
  })

  test('create 模式的能力位拒绝也走 item.reason 一套文案', () => {
    const r = D.designPreview({ mode: 'create', draft: filledDraft(), dialect: 'sqlite', target })
    assert.equal(r.items[0].supported, false)
    assert.equal(r.items[0].reason, 'create-unsupported-dialect')
  })

  test('draftAsNew：复制源结构重基线后全部可编辑，跨库前缀生效', () => {
    const src = {
      type: 'table',
      comment: '源表',
      columns: [{ name: 'id', columnType: 'bigint(20)', nullable: false, defaultValue: null, comment: '' }],
      indexes: [{ name: 'PRIMARY', columns: ['id'], primary: true, unique: false }],
      foreignKeys: [{ name: 'fk_x', columns: ['id'], refTable: 'other', refColumns: ['id'] }]
    }
    const copied = D.draftAsNew(D.createDraft(src))
    assert.equal(copied.columns[0].origName, '', '不清 origName 列名会被禁用')
    assert.equal(copied.columns[0].src, null)
    assert.equal(copied.foreignKeys.length, 1, '外键只读展示要留着')
    assert.equal(copied.comment, '源表')
    const r = D.designPreview({ mode: 'create', draft: copied, dialect: 'mysql', target: { database: 'otherdb', table: 't_copy' } })
    const sql = r.items[0].sqls[0]
    assert.ok(sql.startsWith('CREATE TABLE `otherdb`.`t_copy` ('), sql)
    assert.ok(sql.includes('`id` bigint(20) NOT NULL'), sql)
    assert.ok(sql.includes('PRIMARY KEY (`id`)'), sql)
    assert.ok(sql.endsWith(") COMMENT='源表'"), sql)
  })

  test('复制后仍可修改草稿：改列名/类型/加列，CREATE 跟着变', () => {
    const src = {
      type: 'table',
      comment: '',
      columns: [{ name: 'id', columnType: 'int(11)', nullable: false, defaultValue: null, comment: '' }],
      indexes: [],
      foreignKeys: []
    }
    const copied = D.draftAsNew(D.createDraft(src))
    copied.columns[0].name = 'uid'
    copied.columns[0].type = 'varchar(32)'
    copied.columns.push(DRAFT_COL('note', { type: 'text' }))
    const r = D.designPreview({ mode: 'create', draft: copied, dialect: 'mysql', target })
    assert.equal(r.issues.length, 0)
    const sql = r.items[0].sqls[0]
    assert.ok(sql.includes('`uid` varchar(32) NOT NULL'), sql)
    assert.ok(sql.includes('`note` text'), sql)
    assert.ok(!sql.includes('`id`'), sql)
  })
})

describe('buildCreateKeyPlan：新建键 op 调用计划', () => {
  const plan = a => CK.buildCreateKeyPlan({ key: 'k', type: 'string', value: 'v', ttlSeconds: '', ...a })

  test('string：单条 setKey，不经行解析', () => {
    const r = plan({ value: 'a\nb' })
    assert.strictEqual(r.error, '')
    assert.deepStrictEqual(r.calls, [{ op: 'setKey', args: { value: 'a\nb' } }])
  })

  test('hash：按第一个 = 分隔，value 可含 =；坏行给机器码', () => {
    const r = plan({ type: 'hash', value: 'f1=v=1\nf2 = v2\nf3=v3' })
    assert.strictEqual(r.error, '')
    assert.deepStrictEqual(r.calls, [
      { op: 'hashSetField', args: { field: 'f1', value: 'v=1' } },
      { op: 'hashSetField', args: { field: 'f2', value: ' v2' } },
      { op: 'hashSetField', args: { field: 'f3', value: 'v3' } }
    ])
    assert.strictEqual(plan({ type: 'hash', value: 'novalue' }).error, 'dbRedisCreateKeyHashBad')
    assert.strictEqual(plan({ type: 'hash', value: '' }).error, 'dbRedisCreateKeyHashBad')
  })

  test('zset：score member 首空白分隔，score 必须有限数字', () => {
    const r = plan({ type: 'zset', value: '90 alice\n-1.5 bob' })
    assert.strictEqual(r.error, '')
    assert.deepStrictEqual(r.calls, [
      { op: 'zsetAdd', args: { score: 90, member: 'alice' } },
      { op: 'zsetAdd', args: { score: -1.5, member: 'bob' } }
    ])
    assert.strictEqual(plan({ type: 'zset', value: 'abc x' }).error, 'dbRedisCreateKeyZsetBad')
    assert.strictEqual(plan({ type: 'zset', value: '90' }).error, 'dbRedisCreateKeyZsetBad')
  })

  test('list：多行按输入顺序逐条 RPUSH（right）', () => {
    const r = plan({ type: 'list', value: 'a\nb\nc' })
    assert.strictEqual(r.error, '')
    assert.deepStrictEqual(r.calls, [
      { op: 'listPush', args: { value: 'a', position: 'right' } },
      { op: 'listPush', args: { value: 'b', position: 'right' } },
      { op: 'listPush', args: { value: 'c', position: 'right' } }
    ])
    assert.strictEqual(plan({ type: 'list', value: '\n\n' }).error, 'dbRedisCreateKeyEmpty')
  })

  test('set：一条 setAdd 收全部成员', () => {
    const r = plan({ type: 'set', value: 'm1\nm2' })
    assert.strictEqual(r.error, '')
    assert.deepStrictEqual(r.calls, [{ op: 'setAdd', args: { members: ['m1', 'm2'] } }])
  })

  test('TTL：正数追加 expireKey，空/0 不追加', () => {
    const withTtl = plan({ ttlSeconds: '60' })
    assert.strictEqual(withTtl.calls[withTtl.calls.length - 1].op, 'expireKey')
    assert.strictEqual(withTtl.calls[withTtl.calls.length - 1].args.seconds, 60)
    assert.ok(!plan({ ttlSeconds: '' }).calls.some(c => c.op === 'expireKey'))
    assert.ok(!plan({ ttlSeconds: '0' }).calls.some(c => c.op === 'expireKey'))
    assert.ok(!plan({ ttlSeconds: '-5' }).calls.some(c => c.op === 'expireKey'))
  })

  test('键名缺失给机器码；未知类型拒绝', () => {
    assert.strictEqual(plan({ key: '  ' }).error, 'dbRedisCreateKeyNeedName')
    assert.ok(plan({ type: 'stream' }).error)
  })
})
