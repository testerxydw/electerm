/**
 * N7 新建表 / 新建键 —— 纯函数单测
 *
 * createTableDdl（db-ddl-generate）：设计器 create 模式 → CREATE TABLE 候选脚本。
 * 与 ALTER 生成共享 colDefTail（建表/改表对"一列长什么样"必须同口径），
 * 所以默认值/注释的写法预期与 db-ddl-generate.spec 的 ALTER 断言一致。
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

before(async () => {
  G = await import('file://' + path.join(ROOT, 'src/client/common/db-ddl-generate.js'))
  CK = await import('file://' + path.join(ROOT, 'src/client/common/db-redis-create-key.js'))
})

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

describe('createTableDdl：CREATE TABLE 候选脚本', () => {
  const baseDraft = () => ({
    comment: '',
    columns: [
      DRAFT_COL('id', { nullable: false, hasDefault: true, defaultValue: '0' }),
      DRAFT_COL('name', { type: 'varchar(64)', comment: '用户名' })
    ],
    indexes: [DRAFT_IX('pk', ['id'], { primary: true })]
  })

  test('happy path：列/PK/表注释全进一条 CREATE，标识符反引号', () => {
    const draft = { ...baseDraft(), comment: '测试表' }
    draft.indexes.push(DRAFT_IX('uk_name', ['name'], { unique: true }))
    const res = G.createTableDdl(draft, 'mysql', { database: 'mydb', table: 't_users' })
    assert.ok(res.supported, res.reason)
    assert.strictEqual(res.sqls.length, 1)
    const sql = res.sqls[0]
    assert.ok(sql.startsWith('CREATE TABLE `mydb`.`t_users` ('), sql)
    assert.ok(sql.includes('`id` int(11) NOT NULL DEFAULT 0'), sql)
    assert.ok(sql.includes('`name` varchar(64) COMMENT \'用户名\''), sql)
    assert.ok(sql.includes('PRIMARY KEY (`id`)'), sql)
    assert.ok(sql.includes('UNIQUE KEY `uk_name` (`name`)'), sql)
    // hasDefault=false 的列不许拼 DEFAULT ''（与 ALTER 的 draftToStructure 同口径）
    assert.ok(!sql.includes("DEFAULT ''"), sql)
    // 表注释是表选项，必须挂在右括号之后；不许出现在括号内（那是列/索引列表，
    // 拼进去 MySQL 直接 syntax near '='）
    assert.ok(sql.endsWith(') COMMENT=\'测试表\''), sql)
    assert.ok(!/\n\s*COMMENT=/.test(sql), sql)
  })

  test('普通索引内联 INDEX，无索引时不出键行', () => {
    const draft = baseDraft()
    draft.indexes.push(DRAFT_IX('ix1', ['name']))
    const res = G.createTableDdl(draft, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(res.supported, res.reason)
    assert.ok(res.sqls[0].includes('INDEX `ix1` (`name`)'), res.sqls[0])
    const noIx = G.createTableDdl({ ...baseDraft(), indexes: [] }, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(noIx.supported)
    assert.ok(!noIx.sqls[0].includes('INDEX'), noIx.sqls[0])
  })

  test('多列逗号分隔，主键列可多列', () => {
    const draft = baseDraft()
    draft.indexes = [DRAFT_IX('pk', ['id', 'name'], { primary: true })]
    const res = G.createTableDdl(draft, 'mysql', { database: 'mydb', table: 't' })
    assert.ok(res.supported)
    assert.ok(res.sqls[0].includes('PRIMARY KEY (`id`, `name`)'), res.sqls[0])
  })

  test('结构不对 → supported=false + 机器码 reason', () => {
    const t = 'mydb'
    assert.strictEqual(G.createTableDdl(baseDraft(), 'mysql', { database: t, table: 'a.b' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl(baseDraft(), 'mysql', { database: t, table: '' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl(baseDraft(), 'mysql', { database: t, table: '9t' }).reason, 'bad-table-name')
    assert.strictEqual(G.createTableDdl({ ...baseDraft(), columns: [] }, 'mysql', { database: t, table: 't' }).reason, 'no-column')
    const badCol = baseDraft()
    badCol.columns[0] = { ...badCol.columns[0], name: 'a b' }
    assert.strictEqual(G.createTableDdl(badCol, 'mysql', { database: t, table: 't' }).reason, 'bad-column-name')
    const noType = baseDraft()
    noType.columns[0] = { ...noType.columns[0], type: '' }
    assert.strictEqual(G.createTableDdl(noType, 'mysql', { database: t, table: 't' }).reason, 'missing-column-type')
    const dup = baseDraft()
    dup.columns.push(DRAFT_COL('id'))
    assert.strictEqual(G.createTableDdl(dup, 'mysql', { database: t, table: 't' }).reason, 'duplicate-column')
    const badIx = baseDraft()
    badIx.indexes.push(DRAFT_IX('ix', ['ghost']))
    assert.strictEqual(G.createTableDdl(badIx, 'mysql', { database: t, table: 't' }).reason, 'index-column-missing')
  })

  test('方言白名单：sqlite 不给语句（与 ALTER 的能力位口径不同源）', () => {
    const res = G.createTableDdl(baseDraft(), 'sqlite', { database: 'd', table: 't' })
    assert.strictEqual(res.supported, false)
    assert.strictEqual(res.reason, 'create-unsupported-dialect')
    assert.strictEqual(G.createTableDdl(baseDraft(), 'postgres', { database: 'd', table: 't' }).reason, 'create-unsupported-dialect')
  })

  test('幂等：同一草稿两次生成逐字一致', () => {
    const a = G.createTableDdl(baseDraft(), 'mysql', { database: 'd', table: 't' }).sqls[0]
    const b = G.createTableDdl(baseDraft(), 'mysql', { database: 'd', table: 't' }).sqls[0]
    assert.strictEqual(a, b)
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
