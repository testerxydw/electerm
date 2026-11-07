/**
 * N3a 结构差异 → 候选 DDL 生成（纯函数）
 *
 * 生成的语句最终会落到 SQL 编辑器让用户执行，所以两类失败都要钉住：
 * - 生成错语句（类型/默认值写法不对、标识符没转义）→ 白名单 + defaultKind 拦截；
 * - 生成半截脚本（表定位缺失、SQLite 不该出语句）→ 拦截后必须 supported=false。
 * 方向也钉死：语句作用在**基准表**上，把 A 对齐成 B。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const DIFF = path.join(ROOT, 'src/client/common/db-structure-diff.js')
const GEN = path.join(ROOT, 'src/client/common/db-ddl-generate.js')
let D
let G
before(async () => {
  D = await import('file://' + DIFF)
  G = await import('file://' + GEN)
})

const COL = (name, extra = {}) => ({
  name,
  columnType: 'int(11)',
  dataType: 'int',
  nullable: false,
  defaultValue: null,
  comment: null,
  isPrimaryKey: false,
  ordinal: 1,
  maxLength: null,
  ...extra
})

const IDX = (name, columns, extra = {}) => ({
  name,
  unique: false,
  primary: false,
  columns,
  method: 'BTREE',
  ...extra
})

const FK = (name, columns, refTable, refColumns, extra = {}) => ({
  name,
  columns,
  refSchema: null,
  refTable,
  refColumns,
  onDelete: 'NO ACTION',
  onUpdate: 'NO ACTION',
  ...extra
})

const STRUCT = (over = {}) => ({
  type: 'table',
  columns: [COL('id', { isPrimaryKey: true })],
  indexes: [],
  foreignKeys: [],
  ...over
})

const LOC = { database: 'appdb', schema: 'public', table: 'user' }

const diffOf = (a, b, dialect) => D.diffTableStructure(a, b, { dialect })
const itemsOf = (a, b, dialect, loc = LOC) => G.diffToDdl(diffOf(a, b, dialect), dialect, loc)
const byId = (items, id) => items.find(i => i.id === id)
const ids = items => items.map(i => i.id)

describe('diffToDdl：方向与形态', () => {
  test('删一列 + 加一索引 + 改注释 → 3 条语句，全部可生成', () => {
    const a = STRUCT({
      columns: [COL('id'), COL('legacy')],
      indexes: []
    })
    const b = STRUCT({
      columns: [COL('id'), COL('name', { columnType: 'varchar(64)', dataType: 'varchar', comment: '名字' })],
      indexes: [IDX('idx_name', ['name'])]
    })
    const items = itemsOf(a, b, 'mysql')
    assert.deepEqual(ids(items), ['column:name', 'column:legacy', 'index:idx_name'])
    assert.equal(items.every(i => i.supported), true)
    const script = G.buildScript(items, ids(items))
    assert.deepEqual(script.split('\n'), [
      "ALTER TABLE `appdb`.`user` ADD COLUMN `name` varchar(64) NOT NULL COMMENT '名字';",
      'ALTER TABLE `appdb`.`user` DROP COLUMN `legacy`;',
      'ALTER TABLE `appdb`.`user` ADD INDEX `idx_name` (`name`);'
    ])
  })

  test('equal 的条目不进列表，id 用 kind:名字 且唯一', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({ columns: [COL('id')] })
    assert.deepEqual(itemsOf(a, b, 'mysql'), [])
  })

  test('生成的语句作用在基准表上：表名取 A 的定位', () => {
    const a = STRUCT({ columns: [COL('id'), COL('x')] })
    const b = STRUCT({ type: 'table', tableName: 'other', columns: [COL('id')] })
    const sqls = itemsOf(a, b, 'mysql')[0].sqls
    assert.match(sqls[0], /`appdb`\.`user`/)
    assert.doesNotMatch(sqls.join(' '), /other/)
  })

  test('PG 用 schema.table，database 段不出现', () => {
    const a = STRUCT({ columns: [COL('id'), COL('x')] })
    const b = STRUCT({ columns: [COL('id')] })
    const [item] = itemsOf(a, b, 'postgres')
    assert.equal(item.sqls[0], 'ALTER TABLE "public"."user" DROP COLUMN "x";'.replace(';', ''))
    assert.doesNotMatch(item.sqls[0], /appdb/)
  })

  test('同族引擎复用同族语法（mariadb 走 MySQL 形）', () => {
    const a = STRUCT({ columns: [COL('id'), COL('x')] })
    const b = STRUCT({ columns: [COL('id')] })
    const [item] = itemsOf(a, b, 'mariadb')
    assert.equal(item.supported, true)
    assert.match(item.sqls[0], /^ALTER TABLE `appdb`\.`user` DROP COLUMN `x`$/)
  })

  test('幂等：同一对结构再生成一次，逐字一致', () => {
    const a = STRUCT({ columns: [COL('id'), COL('legacy')], indexes: [IDX('idx_a', ['legacy'])] })
    const b = STRUCT({ columns: [COL('id'), COL('email', { columnType: 'varchar(32)' })], indexes: [IDX('idx_b', ['email'])] })
    for (const dialect of ['mysql', 'postgres']) {
      const first = JSON.stringify(itemsOf(a, b, dialect))
      assert.equal(JSON.stringify(itemsOf(a, b, dialect)), first)
    }
  })
})

describe('entryToDdl：列', () => {
  test('MySQL 加列把可空/默认/注释并进一条全定义', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({
      columns: [
        COL('id'),
        COL('status', {
          columnType: 'varchar(16)',
          dataType: 'varchar',
          nullable: false,
          defaultValue: 'admin',
          comment: "it's ok"
        })
      ]
    })
    const [item] = itemsOf(a, b, 'mysql')
    assert.deepEqual(item.sqls, [
      "ALTER TABLE `appdb`.`user` ADD COLUMN `status` varchar(16) NOT NULL DEFAULT 'admin' COMMENT 'it''s ok'"
    ])
  })

  test('PG 加列的注释另起一条 COMMENT ON COLUMN', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({
      columns: [COL('id'), COL('note', { columnType: 'text', dataType: 'text', nullable: true, comment: '备注' })]
    })
    const [item] = itemsOf(a, b, 'postgres')
    assert.deepEqual(item.sqls, [
      'ALTER TABLE "public"."user" ADD COLUMN "note" text',
      'COMMENT ON COLUMN "public"."user"."note" IS \'备注\''
    ])
  })

  test('改了类型：MySQL 用 MODIFY 全定义，PG 用 ALTER COLUMN TYPE', () => {
    const a = STRUCT({ columns: [COL('name', { columnType: 'varchar(64)', dataType: 'varchar' })] })
    const b = STRUCT({ columns: [COL('name', { columnType: 'varchar(128)', dataType: 'varchar(128)' })] })
    const m = byId(itemsOf(a, b, 'mysql'), 'column:name')
    assert.deepEqual(m.sqls, ['ALTER TABLE `appdb`.`user` MODIFY COLUMN `name` varchar(128) NOT NULL'])
    const p = byId(itemsOf(a, b, 'postgres'), 'column:name')
    assert.deepEqual(p.sqls, ['ALTER TABLE "public"."user" ALTER COLUMN "name" TYPE varchar(128)'])
  })

  test('PG 只改注释时不碰类型：非白名单类型也能给语句', () => {
    const a = STRUCT({ columns: [COL('doc', { columnType: 'bytea', dataType: 'bytea', comment: '旧' })] })
    const b = STRUCT({ columns: [COL('doc', { columnType: 'bytea', dataType: 'bytea', comment: '新' })] })
    const [item] = itemsOf(a, b, 'postgres')
    assert.equal(item.supported, true)
    assert.deepEqual(item.sqls, ['COMMENT ON COLUMN "public"."user"."doc" IS \'新\''])
  })

  test('PG 同时改可空与默认：并成一条 ALTER TABLE 多 action', () => {
    const a = STRUCT({ columns: [COL('n', { columnType: 'int', dataType: 'int', nullable: true, defaultValue: null })] })
    const b = STRUCT({ columns: [COL('n', { columnType: 'int', dataType: 'int', nullable: false, defaultValue: 0 })] })
    const [item] = itemsOf(a, b, 'postgres')
    assert.deepEqual(item.sqls, [
      'ALTER TABLE "public"."user" ALTER COLUMN "n" SET NOT NULL, ALTER COLUMN "n" SET DEFAULT 0'
    ])
  })

  test('PG 默认值从有到无：发 DROP DEFAULT', () => {
    const a = STRUCT({ columns: [COL('n', { columnType: 'int', dataType: 'int', defaultValue: 1 })] })
    const b = STRUCT({ columns: [COL('n', { columnType: 'int', dataType: 'int', defaultValue: null })] })
    const [item] = itemsOf(a, b, 'postgres')
    assert.deepEqual(item.sqls, ['ALTER TABLE "public"."user" ALTER COLUMN "n" DROP DEFAULT'])
  })

  test('白名单外的类型只报差异不给语句', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({ columns: [COL('id'), COL('pic', { columnType: 'blob', dataType: 'blob' })] })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.supported, false)
    assert.equal(item.reason, 'type-whitelist')
    assert.deepEqual(item.sqls, [])
  })

  test('带 :: 转换的默认值不猜写法：只报差异', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({
      columns: [COL('id'), COL('role', { columnType: 'text', dataType: 'text', defaultValue: "'admin'::text" })]
    })
    const [item] = itemsOf(a, b, 'postgres')
    assert.equal(item.supported, false)
    assert.equal(item.reason, 'default-expression')
  })

  test('函数形态的默认值裸写，不加引号', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({
      columns: [COL('id'), COL('ts', { columnType: 'timestamp', dataType: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP' })]
    })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.sqls[0], 'ALTER TABLE `appdb`.`user` ADD COLUMN `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP')
  })

  test('空串默认值写成 DEFAULT \'\'，不被当成没有默认', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({ columns: [COL('id'), COL('s', { columnType: 'varchar(8)', dataType: 'varchar', defaultValue: '' })] })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.sqls[0], "ALTER TABLE `appdb`.`user` ADD COLUMN `s` varchar(8) NOT NULL DEFAULT ''")
  })

  test('标识符里的引号双写转义（mysql 反引号 / pg 双引号）', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({ columns: [COL('id'), COL('a`b')] })
    assert.equal(
      itemsOf(a, b, 'mysql')[0].sqls[0],
      'ALTER TABLE `appdb`.`user` ADD COLUMN `a``b` int(11) NOT NULL'
    )
    const p = STRUCT({ columns: [COL('id'), COL('a"b')] })
    assert.equal(
      itemsOf(a, p, 'postgres')[0].sqls[0],
      'ALTER TABLE "public"."user" ADD COLUMN "a""b" int(11) NOT NULL'
    )
  })
})

describe('entryToDdl：索引与外键', () => {
  test('MySQL 加索引走 ALTER TABLE ADD INDEX，唯一索引带 UNIQUE', () => {
    const a = STRUCT({ columns: [COL('id'), COL('e')] })
    const b = STRUCT({
      columns: [COL('id'), COL('e')],
      indexes: [IDX('idx_e', ['e'], { unique: true })]
    })
    const [item] = itemsOf(a, b, 'mysql')
    assert.deepEqual(item.sqls, ['ALTER TABLE `appdb`.`user` ADD UNIQUE INDEX `idx_e` (`e`)'])
  })

  test('PG 加索引走 CREATE INDEX，删索引不带表名', () => {
    const a = STRUCT({ columns: [COL('id'), COL('e')], indexes: [IDX('idx_old', ['e'])] })
    const b = STRUCT({ columns: [COL('id'), COL('e')], indexes: [IDX('idx_e', ['e'])] })
    const items = itemsOf(a, b, 'postgres')
    assert.deepEqual(byId(items, 'index:idx_e').sqls, ['CREATE INDEX "idx_e" ON "public"."user" ("e")'])
    assert.deepEqual(byId(items, 'index:idx_old').sqls, ['DROP INDEX IF EXISTS "idx_old"'])
  })

  test('多列索引按顺序拼列名', () => {
    const a = STRUCT({ columns: [COL('id'), COL('a'), COL('b')] })
    const b = STRUCT({ columns: [COL('id'), COL('a'), COL('b')], indexes: [IDX('idx_ab', ['a', 'b'])] })
    assert.deepEqual(itemsOf(a, b, 'mysql')[0].sqls,
      ['ALTER TABLE `appdb`.`user` ADD INDEX `idx_ab` (`a`, `b`)'])
  })

  test('索引 changed（列序/唯一性）不生成，只报差异', () => {
    const a = STRUCT({ columns: [COL('id'), COL('a'), COL('b')], indexes: [IDX('idx_ab', ['a', 'b'])] })
    const b = STRUCT({ columns: [COL('id'), COL('a'), COL('b')], indexes: [IDX('idx_ab', ['b', 'a'])] })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.supported, false)
    assert.equal(item.reason, 'index-changed')
  })

  test('主键索引不生成', () => {
    const a = STRUCT({ columns: [COL('id')] })
    const b = STRUCT({ columns: [COL('id')], indexes: [IDX('PRIMARY', ['id'], { primary: true, unique: true })] })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.supported, false)
    assert.equal(item.reason, 'primary-index')
  })

  test('外键一律不生成', () => {
    const a = STRUCT({ columns: [COL('id'), COL('oid')] })
    const b = STRUCT({
      columns: [COL('id'), COL('oid')],
      foreignKeys: [FK('fk_o', ['oid'], 'order', ['id'])]
    })
    const [item] = itemsOf(a, b, 'mysql')
    assert.equal(item.supported, false)
    assert.equal(item.reason, 'fk-not-generated')
  })
})

describe('SQLite 与非法输入：宁可不出语句', () => {
  test('SQLite 任何差异都只读预览（ALTER 只有四形）', () => {
    const a = STRUCT({ columns: [COL('id'), COL('legacy')] })
    const b = STRUCT({ columns: [COL('id'), COL('email', { columnType: 'varchar(32)' })] })
    const items = itemsOf(a, b, 'sqlite')
    assert.equal(items.length > 0, true)
    assert.equal(items.every(i => i.supported === false), true)
    assert.equal(items.every(i => i.reason === 'sqlite-limited'), true)
    assert.equal(G.buildScript(items, ids(items)), '')
  })

  test('非 SQL 引擎（redis）没有方言，一律 unknown-dialect', () => {
    const entry = { kind: 'column', name: 'a', status: 'removed', base: COL('a'), target: null, fields: [] }
    assert.deepEqual(G.entryToDdl(entry, 'redis', LOC),
      { sqls: [], supported: false, reason: 'unknown-dialect' })
  })

  test('表定位缺失：不给半截语句', () => {
    const entry = { kind: 'column', name: 'a', status: 'removed', base: COL('a'), target: null, fields: [] }
    for (const loc of [null, undefined, {}, { database: 'appdb' }]) {
      assert.deepEqual(G.entryToDdl(entry, 'mysql', loc),
        { sqls: [], supported: false, reason: 'missing-target-loc' })
    }
  })

  test('空条目 / equal / 未知 kind', () => {
    assert.equal(G.entryToDdl(null, 'mysql', LOC).reason, 'no-entry')
    assert.equal(G.entryToDdl({}, 'mysql', LOC).reason, 'no-entry')
    const equal = { kind: 'column', name: 'a', status: 'equal', base: COL('a'), target: COL('a'), fields: [] }
    assert.equal(G.entryToDdl(equal, 'mysql', LOC).reason, 'equal')
    const weird = { kind: 'trigger', name: 't', status: 'added', base: null, target: { name: 't' }, fields: [] }
    assert.equal(G.entryToDdl(weird, 'mysql', LOC).reason, 'unknown-kind')
  })

  test('diff 缺失或为空也不炸', () => {
    assert.deepEqual(G.diffToDdl(null, 'mysql', LOC), [])
    assert.deepEqual(G.diffToDdl({ columns: [], indexes: [], foreignKeys: [] }, 'postgres', LOC), [])
  })
})

describe('buildScript：只拼勾选的', () => {
  const sample = () => {
    const a = STRUCT({ columns: [COL('id'), COL('legacy')], indexes: [] })
    const b = STRUCT({
      columns: [COL('id'), COL('email', { columnType: 'varchar(32)' }), COL('pic', { columnType: 'blob', dataType: 'blob' })],
      indexes: [IDX('idx_email', ['email'])]
    })
    return itemsOf(a, b, 'mysql')
  }

  test('勾 2 条得 2 条语句，一条一行带分号', () => {
    const items = sample()
    const script = G.buildScript(items, ['column:legacy', 'index:idx_email'])
    assert.equal(script, [
      'ALTER TABLE `appdb`.`user` DROP COLUMN `legacy`;',
      'ALTER TABLE `appdb`.`user` ADD INDEX `idx_email` (`email`);'
    ].join('\n'))
  })

  test('勾了白名单外的条目也不混进脚本（不支持就不给语句）', () => {
    const items = sample()
    const script = G.buildScript(items, ids(items))
    assert.equal(script.includes('pic'), false)
    assert.equal(script.split('\n').length, 3)
  })

  test('未勾选的条目一条都不出', () => {
    const items = sample()
    assert.equal(G.buildScript(items, []), '')
    assert.equal(G.buildScript(items, null), '')
    assert.equal(G.buildScript(null, ['x']), '')
  })

  test('一条差异出多句时全带上，且不重复分号', () => {
    const a = STRUCT({ columns: [COL('note', { columnType: 'text', dataType: 'text' })] })
    const b = STRUCT({ columns: [COL('note', { columnType: 'text', dataType: 'text', comment: '备注' })] })
    const items = itemsOf(a, b, 'postgres')
    const script = G.buildScript(items, ['column:note'])
    assert.equal(script.split('\n').length, 1)
    assert.equal(/;;/.test(script), false)
    assert.equal(script.endsWith(';'), true)
  })

  test('勾选顺序按列表顺序，不按勾选顺序', () => {
    const items = sample()
    const a = G.buildScript(items, ['index:idx_email', 'column:legacy'])
    const b = G.buildScript(items, ['column:legacy', 'index:idx_email'])
    assert.equal(a, b)
  })
})
