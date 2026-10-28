// F0 元数据契约 v2：映射层纯函数 + 两引擎适配器（vm 假驱动，不打真库）
// 核心验收是"同一张表，PG 与 MySQL 映射出同构结构"——
// 用同一份 fixture 分别喂 fromPg / fromMysql，逐字段比对形状与值。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '../../..')
const V2_JS = path.join(ROOT, 'src/app/lib/db-client/structure-v2.js')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

const v2 = require(V2_JS)
const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
const conn = { dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'p', dbName: 'db1' }

// ---- fixtures：同一张表在两种 catalog 里的原始行 ----

const PG_RAW = {
  columns: [
    {
      ordinal_position: 1,
      column_name: 'id',
      data_type: 'integer',
      udt_name: 'int4',
      is_nullable: 'NO',
      column_default: "nextval('t_id_seq'::regclass)",
      character_maximum_length: null,
      column_type: 'integer',
      comment: '主键'
    },
    {
      ordinal_position: 2,
      column_name: 'name',
      data_type: 'character varying',
      udt_name: 'varchar',
      is_nullable: 'YES',
      column_default: null,
      character_maximum_length: 64,
      column_type: 'character varying(64)',
      comment: null
    },
    {
      ordinal_position: 3,
      column_name: 'payload',
      data_type: 'bytea',
      udt_name: 'bytea',
      is_nullable: 'YES',
      column_default: null,
      character_maximum_length: null,
      column_type: 'bytea',
      comment: '原始字节'
    }
  ],
  indexes: [
    { index_name: 't_pkey', is_primary: true, is_unique: true, method: 'btree', columns: ['id'] },
    { index_name: 't_name_bucket_uniq', is_primary: false, is_unique: true, method: 'btree', columns: ['name', 'bucket'] }
  ],
  foreignKeys: [
    {
      name: 't_dept_fk',
      columns: ['dept_id'],
      ref_schema: 'public',
      ref_table: 'dept',
      ref_columns: ['id'],
      on_update_code: 'a',
      on_delete_code: 'c'
    }
  ],
  table: { relkind: 'r', comment: '任务表', estimated_rows: 1234 }
}

const MY_RAW = {
  columns: [
    {
      ORDINAL_POSITION: 1,
      COLUMN_NAME: 'id',
      DATA_TYPE: 'int',
      COLUMN_TYPE: 'int',
      IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      CHARACTER_OCTET_LENGTH: null,
      COLUMN_COMMENT: '主键',
      COLUMN_KEY: 'PRI'
    },
    {
      ORDINAL_POSITION: 2,
      COLUMN_NAME: 'name',
      DATA_TYPE: 'varchar',
      COLUMN_TYPE: 'varchar(64)',
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      CHARACTER_MAXIMUM_LENGTH: 64,
      CHARACTER_OCTET_LENGTH: 256,
      COLUMN_COMMENT: '',
      COLUMN_KEY: ''
    },
    {
      ORDINAL_POSITION: 3,
      COLUMN_NAME: 'payload',
      DATA_TYPE: 'blob',
      COLUMN_TYPE: 'blob',
      IS_NULLABLE: 'YES',
      COLUMN_DEFAULT: null,
      CHARACTER_MAXIMUM_LENGTH: null,
      CHARACTER_OCTET_LENGTH: 65535,
      COLUMN_COMMENT: '原始字节',
      COLUMN_KEY: ''
    }
  ],
  // STATISTICS 一行一列，且故意乱序给：聚合必须按 SEQ_IN_INDEX 排
  indexes: [
    { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id', INDEX_TYPE: 'BTREE' },
    { INDEX_NAME: 't_name_bucket_uniq', NON_UNIQUE: 0, SEQ_IN_INDEX: 2, COLUMN_NAME: 'bucket', INDEX_TYPE: 'BTREE' },
    { INDEX_NAME: 't_name_bucket_uniq', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'name', INDEX_TYPE: 'BTREE' }
  ],
  foreignKeys: [
    {
      CONSTRAINT_NAME: 't_dept_fk',
      COLUMN_NAME: 'dept_id',
      ORDINAL_POSITION: 1,
      REFERENCED_TABLE_SCHEMA: 'db1',
      REFERENCED_TABLE_NAME: 'dept',
      REFERENCED_COLUMN_NAME: 'id',
      UPDATE_RULE: 'NO ACTION',
      DELETE_RULE: 'CASCADE'
    }
  ],
  table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '任务表', TABLE_ROWS: 1234, ENGINE: 'InnoDB' }
}

const shapesOf = s => ({
  root: Object.keys(s).sort(),
  column: Object.keys(s.columns[0]).sort(),
  index: Object.keys(s.indexes[0]).sort(),
  fk: Object.keys(s.foreignKeys[0]).sort()
})

describe('F0 契约映射：两引擎同构', () => {
  test('同一张表：PG 与 MySQL 输出的键集合完全一致（验收 1）', () => {
    const pg = v2.fromPg(PG_RAW)
    const my = v2.fromMysql(MY_RAW)
    assert.deepEqual(shapesOf(pg), shapesOf(my))
    // 根对象必须是这 6 个键，多一个少一个都算契约漂移
    assert.deepEqual(Object.keys(pg).sort(), [
      'columns', 'comment', 'estimatedRows', 'foreignKeys', 'indexes', 'type'
    ])
  })

  test('列字段值与语义对齐（顺序/主键/长度/注释/二进制）', () => {
    for (const s of [v2.fromPg(PG_RAW), v2.fromMysql(MY_RAW)]) {
      assert.deepEqual(s.columns.map(c => c.name), ['id', 'name', 'payload'])
      assert.deepEqual(s.columns.map(c => c.ordinal), [1, 2, 3])
      assert.equal(s.columns[0].isPrimaryKey, true)
      assert.equal(s.columns[1].isPrimaryKey, false)
      assert.equal(s.columns[0].nullable, false)
      assert.equal(s.columns[1].nullable, true)
      assert.equal(s.columns[0].comment, '主键')
      // MySQL 空注释是 ''、PG 是 null → 统一 null（否则表头挂个空 tooltip）
      assert.equal(s.columns[1].comment, null)
      assert.equal(s.columns[1].maxLength, 64)
      // 二进制列：MySQL 没有字符长度，退到字节长度（blob=65535）；
      // PG 的 bytea 本身不记长度（catalog 只有 character_maximum_length=null）
      assert.equal(s.columns[2].isBinary, true)
      assert.equal(s.columns[1].isBinary, false)
    }
    const my = v2.fromMysql(MY_RAW)
    assert.equal(my.columns[2].maxLength, 65535)
    const pg = v2.fromPg(PG_RAW)
    assert.equal(pg.columns[2].maxLength, null)
  })

  test('复合索引列顺序正确（MySQL 乱序行按 SEQ_IN_INDEX 聚合）', () => {
    for (const s of [v2.fromPg(PG_RAW), v2.fromMysql(MY_RAW)]) {
      const ix = s.indexes.find(x => x.name === 't_name_bucket_uniq')
      assert.ok(ix, 'composite index missing')
      assert.deepEqual(ix.columns, ['name', 'bucket'])
      assert.equal(ix.unique, true)
      const pk = s.indexes.find(x => x.primary)
      assert.deepEqual(pk.columns, ['id'])
    }
  })

  test('外键动作归一：PG 单字符码与 MySQL 词法都得 CASCADE / NO ACTION', () => {
    for (const s of [v2.fromPg(PG_RAW), v2.fromMysql(MY_RAW)]) {
      const fk = s.foreignKeys[0]
      assert.equal(fk.name, 't_dept_fk')
      assert.deepEqual(fk.columns, ['dept_id'])
      assert.deepEqual(fk.refColumns, ['id'])
      assert.equal(fk.refTable, 'dept')
      assert.equal(fk.onDelete, 'CASCADE')
      assert.equal(fk.onUpdate, 'NO ACTION')
    }
  })

  test('表注释与估算行数', () => {
    for (const s of [v2.fromPg(PG_RAW), v2.fromMysql(MY_RAW)]) {
      assert.equal(s.comment, '任务表')
      assert.equal(s.estimatedRows, 1234)
      assert.equal(s.type, 'table')
    }
  })
})

describe('F0 契约映射：边界与降级（验收 2）', () => {
  test('空输入返回完整空结构，不是 undefined', () => {
    for (const s of [v2.finalizeStructure(), v2.finalizeStructure({}), v2.fromPg({}), v2.fromMysql({})]) {
      assert.deepEqual(s.columns, [])
      assert.deepEqual(s.indexes, [])
      assert.deepEqual(s.foreignKeys, [])
      assert.equal(s.comment, null)
      assert.equal(s.estimatedRows, null)
      assert.equal(s.type, 'table')
    }
  })

  test('行数估算：PG 未 analyze 的 -1 与非数字都变 null，真空表 0 保留', () => {
    assert.equal(v2.finalizeStructure({ estimatedRows: -1 }).estimatedRows, null)
    assert.equal(v2.finalizeStructure({ estimatedRows: 'abc' }).estimatedRows, null)
    assert.equal(v2.finalizeStructure({ estimatedRows: null }).estimatedRows, null)
    assert.equal(v2.finalizeStructure({ estimatedRows: 0 }).estimatedRows, 0)
    assert.equal(v2.finalizeStructure({ estimatedRows: '42' }).estimatedRows, 42)
  })

  test('注释空白串归 null；maxLength 只认正数', () => {
    const s = v2.finalizeStructure({
      comment: '   ',
      columns: [{ name: 'a', maxLength: 0 }, { name: 'b', maxLength: -1 }, { name: 'c', maxLength: 10 }]
    })
    assert.equal(s.comment, null)
    assert.equal(s.columns[0].maxLength, null)
    assert.equal(s.columns[1].maxLength, null)
    assert.equal(s.columns[2].maxLength, 10)
  })

  test('列按 ordinal 排序、无名行被丢弃', () => {
    const s = v2.finalizeStructure({
      columns: [
        { name: 'c', ordinal: 3 },
        { ordinal: 2 },
        { name: 'a', ordinal: 1 },
        { name: 'b', ordinal: 2 }
      ]
    })
    assert.deepEqual(s.columns.map(c => c.name), ['a', 'b', 'c'])
  })

  test('表达式索引（无列名）保留，无名索引/外键丢弃', () => {
    const pg = v2.fromPg({
      indexes: [
        { index_name: 't_lower_idx', is_unique: false, is_primary: false, method: 'btree', columns: null },
        { index_name: '', is_unique: false, is_primary: false, method: 'btree', columns: ['x'] }
      ],
      foreignKeys: [{ name: '', columns: ['a'] }, { name: 'fk1', columns: null }]
    })
    assert.deepEqual(pg.indexes.map(i => i.name), ['t_lower_idx'])
    assert.deepEqual(pg.indexes[0].columns, [])
    assert.deepEqual(pg.foreignKeys, [])
  })

  test('PG 列级无主键标记时从 primary 索引反推补到列上', () => {
    const s = v2.fromPg({
      columns: [{ column_name: 'id' }, { column_name: 'x' }],
      indexes: [{ index_name: 't_pkey', is_primary: true, is_unique: true, columns: ['id'] }]
    })
    assert.equal(s.columns[0].isPrimaryKey, true)
    assert.equal(s.columns[1].isPrimaryKey, false)
  })

  test('视图：PG relkind v/m 与 MySQL TABLE_TYPE=VIEW 都标 type:view', () => {
    assert.equal(v2.fromPg({ table: { relkind: 'v' } }).type, 'view')
    assert.equal(v2.fromPg({ table: { relkind: 'm' } }).type, 'view')
    assert.equal(v2.fromMysql({ table: { TABLE_TYPE: 'VIEW' } }).type, 'view')
    assert.equal(v2.fromMysql({ table: { TABLE_TYPE: 'BASE TABLE' } }).type, 'table')
    // 分区表父表按表处理（既不是视图也不是物化视图）
    assert.equal(v2.fromPg({ table: { relkind: 'p' } }).type, 'table')
  })

  test('视图的 TABLE_COMMENT 是字面量 "VIEW"，不能当表注释透传', () => {
    // 真库实测（MariaDB 10.3 / MySQL 8 同）：information_schema.TABLES 对视图
    // 的 TABLE_COMMENT 恒为字符串 'VIEW'。直接透传 → 表头/结构面板显示注释 "VIEW"
    const v = v2.fromMysql({
      table: { TABLE_TYPE: 'VIEW', TABLE_COMMENT: 'VIEW', TABLE_ROWS: null }
    })
    assert.equal(v.comment, null, 'view comment must not be the literal VIEW')
    // 视图没有真实行数统计，保持 null（不显示"约 0 行"这种假数据）
    assert.equal(v.estimatedRows, null)
    // 普通表的真实注释必须保留
    const t = v2.fromMysql({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '任务表', TABLE_ROWS: 12 }
    })
    assert.equal(t.comment, '任务表')
    assert.equal(t.estimatedRows, 12)
  })

  test('isBinary 覆盖 blob/bytea/geometry，不误伤 varchar/text/json', () => {
    for (const t of ['blob', 'longblob', 'bytea', 'geometry', 'varbinary', 'bit']) {
      assert.equal(v2.isBinaryType(t), true, t + ' should be binary')
    }
    for (const t of ['varchar', 'text', 'json', 'int', 'timestamp']) {
      assert.equal(v2.isBinaryType(t), false, t + ' should be text')
    }
    // 视图包装后 data_type 会变 USER-DEFINED，得靠 udt_name 兜住
    assert.equal(v2.isBinaryType('USER-DEFINED', 'bytea'), true)
  })
})

// ---- 适配器层：vm + 假驱动 ----

function runInVm (src, stubs, filename) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

function makeMysql (raw) {
  const calls = { queries: [] }
  const pool = {
    async query (sql, params) {
      calls.queries.push({ sql, params })
      if (/^SHOW DATABASES/.test(sql)) {
        return [[{ Database: 'db1' }]]
      }
      if (/information_schema\.COLUMNS/.test(sql)) {
        return [raw.columns]
      }
      if (/information_schema\.STATISTICS/.test(sql)) {
        return [raw.indexes]
      }
      if (/REFERENTIAL_CONSTRAINTS/.test(sql)) {
        return [raw.foreignKeys]
      }
      if (/TABLE_TYPE, TABLE_COMMENT/.test(sql)) {
        return [raw.table ? [raw.table] : []]
      }
      if (/TABLE_NAME, TABLE_TYPE/.test(sql)) {
        return [[
          { TABLE_NAME: 't', TABLE_TYPE: 'BASE TABLE' },
          { TABLE_NAME: 'v', TABLE_TYPE: 'VIEW' }
        ]]
      }
      throw new Error('unexpected sql: ' + sql)
    }
  }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      './structure-v2': v2,
      'mysql2/promise': { createPool () { return pool } }
    },
    'mysql.js'
  )
  return { mod, calls }
}

function makePostgres (rows) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      if (/FROM information_schema\.columns/.test(sql)) {
        return { rows: rows.columns || [] }
      }
      if (/FROM pg_index/.test(sql)) {
        return { rows: rows.indexes || [] }
      }
      if (/FROM pg_constraint/.test(sql)) {
        return { rows: rows.foreignKeys || [] }
      }
      if (/FROM pg_class c\n\s+JOIN pg_namespace n ON n\.oid = c\.relnamespace\n\s+WHERE n\.nspname = \$1/.test(sql)) {
        return { rows: rows.table ? [rows.table] : [] }
      }
      // getMetadata：库列表 / 表与视图 / schema 列表。
      // 顺序有讲究：表与视图那条 SQL 里也含 "JOIN pg_namespace"，
      // 放在 schema 判断之后会被误判成 schema 列表
      if (/FROM pg_database/.test(sql)) {
        return { rows: [{ datname: 'db1' }] }
      }
      if (/FROM pg_class c JOIN pg_namespace n/.test(sql)) {
        return {
          rows: [
            { schemaname: 'public', relname: 't', relkind: 'r' },
            { schemaname: 'public', relname: 'v', relkind: 'v' }
          ]
        }
      }
      if (/FROM pg_namespace/.test(sql)) {
        return { rows: [{ nspname: 'public' }] }
      }
      throw new Error('unexpected sql: ' + sql)
    }

    async end () {}
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client }, './structure-v2': v2 },
    'postgres.js'
  )
  return { mod, calls }
}

describe('F0 适配器：PG getTableStructure', () => {
  test('四条 catalog 查询并行发出并映射成契约', async () => {
    const { mod, calls } = makePostgres(PG_RAW)
    const s = await mod.getTableStructure(conn, { schema: 'public', table: 't' })
    assert.equal(calls.queries.length, 4)
    assert.deepEqual(s.columns.map(c => c.name), ['id', 'name', 'payload'])
    assert.equal(s.type, 'table')
    assert.equal(s.comment, '任务表')
    assert.equal(s.indexes.length, 2)
    assert.equal(s.foreignKeys[0].onDelete, 'CASCADE')
    // schema 缺省走 public（与 getPageData 一致）
    const { mod: m2, calls: c2 } = makePostgres(PG_RAW)
    await m2.getTableStructure(conn, { table: 't' })
    assert.equal(c2.queries[0].params[0], 'public')
  })

  test('表不存在时明确报错，不返回零列的空结构', async () => {
    const { mod } = makePostgres({ ...PG_RAW, table: null })
    await assert.rejects(
      mod.getTableStructure(conn, { schema: 'public', table: 'nope' }),
      /table not found/
    )
  })

  test('视图（relkind=v）标成 view', async () => {
    const { mod } = makePostgres({ ...PG_RAW, table: { relkind: 'v', comment: null, estimated_rows: -1 } })
    const s = await mod.getTableStructure(conn, { schema: 'public', table: 'v' })
    assert.equal(s.type, 'view')
    assert.equal(s.estimatedRows, null)
  })
})

describe('F0 适配器：MySQL getTableStructure', () => {
  test('四条 information_schema 查询，库名缺省取连接库', async () => {
    const { mod, calls } = makeMysql(MY_RAW)
    const s = await mod.getTableStructure(conn, { table: 't' })
    assert.equal(calls.queries.length, 4)
    // 每条都用占位符传 schema/table，不拼字符串
    calls.queries.forEach(q => {
      assert.deepEqual([...q.params], ['db1', 't'])
      assert.ok(!q.sql.includes('db1'), 'schema must not be inlined into SQL')
    })
    assert.deepEqual(s.columns.map(c => c.name), ['id', 'name', 'payload'])
    assert.equal(s.indexes.find(i => i.name === 't_name_bucket_uniq').columns.join(','), 'name,bucket')
  })

  test('无 database 且连接无 dbName 时拒绝', async () => {
    const { mod } = makeMysql(MY_RAW)
    await assert.rejects(
      mod.getTableStructure({ ...conn, dbName: '' }, { table: 't' }),
      /requires database/
    )
  })

  test('表不存在时报错', async () => {
    const { mod } = makeMysql({ ...MY_RAW, table: null })
    await assert.rejects(
      mod.getTableStructure(conn, { table: 'nope' }),
      /table not found/
    )
  })
})

describe('F0 元数据树：视图节点（验收 3）', () => {
  test('MySQL getMetadata 用 TABLE_TYPE 区分视图，SQL 不再用 SHOW TABLES', async () => {
    const { mod, calls } = makeMysql(MY_RAW)
    // vm 里的数组原型与宿主不同，deepStrictEqual 会因 [[Prototype]] 不等而报
    // "same structure but not reference-equal" → 过一遍 JSON 归一到宿主对象
    const tree = JSON.parse(JSON.stringify(await mod.getMetadata(conn, {})))
    const children = tree[0].children
    assert.deepEqual(children.map(c => [c.name, c.type]), [['t', 'table'], ['v', 'view']])
    assert.ok(calls.queries.every(q => !/SHOW TABLES/i.test(q.sql)), 'SHOW TABLES has no TABLE_TYPE')
    assert.ok(calls.queries.some(q => /TABLE_TYPE/.test(q.sql)))
  })

  test('PG getMetadata 用 pg_class relkind 区分视图', async () => {
    const { mod, calls } = makePostgres(PG_RAW)
    const tree = JSON.parse(JSON.stringify(await mod.getMetadata(conn)))
    const schema = tree[0].children.find(s => s.name === 'public')
    assert.deepEqual(schema.children.map(c => [c.name, c.type]), [['t', 'table'], ['v', 'view']])
    assert.ok(calls.queries.some(q => /relkind/.test(q.sql)))
    assert.ok(!calls.queries.some(q => /FROM pg_tables/.test(q.sql)), 'pg_tables has no views')
  })
})

describe('F0 接线：op 注册与缓存', () => {
  const indexSrc = fs.readFileSync(INDEX_JS, 'utf8')

  test('两个 SQL 引擎注册 getTableStructure，Redis 不注册（调用即报 unsupported）', () => {
    const hits = indexSrc.match(/getTableStructure: 'getTableStructure'/g) || []
    assert.equal(hits.length, 2)
    // 只取 OP_MAP 里的 redis 块（后面的 dbClientOp 分支当然会提到这个 op 名）
    const redisBlock = (indexSrc.match(/redis: \{[\s\S]*?\n {2}\}/) || [''])[0]
    assert.ok(!redisBlock.includes('getTableStructure'), 'redis must not advertise table structure')
    // 但适配器方法名必须真实存在，否则 op 注册成了空指针
    for (const f of [MYSQL_JS, POSTGRES_JS]) {
      assert.ok(fs.readFileSync(f, 'utf8').includes('async function getTableStructure'))
    }
  })

  test('结构缓存 60s + 同键并发去重 + executeSql 后失效', () => {
    assert.ok(/const STRUCTURE_TTL = 60000/.test(indexSrc), 'TTL must be 60s')
    // 2026-10-27 起带第 5 参 onTimeout：op 超时触发 adapter.evict 自愈（见 db-op-timeout-evict.spec.js）
    // F2 起追加第 6 参 opConn（事务钉住期间走专用连接）
    assert.ok(/structureCached\(inst, adapter, safeArgs, opMs, evictOnTimeout/.test(indexSrc))
    assert.ok(/cache\.inflight\.has\(key\)/.test(indexSrc), 'concurrent same-key must dedupe')
    // getMetadata 刷新后两套缓存一起清
    const metaBlock = indexSrc.slice(indexSrc.indexOf("if (op === 'getMetadata')"))
    assert.ok(metaBlock.slice(0, 400).includes('resetColumnsCache(inst)'))
    assert.ok(metaBlock.slice(0, 400).includes('resetStructureCache(inst)'))
    // executeSql 可能刚跑过 ALTER，必须丢结构缓存
    const execBlock = indexSrc.slice(indexSrc.indexOf("if (op === 'executeSql')"))
    assert.ok(/finally\(\(\) => resetStructureCache\(inst\)\)/.test(execBlock.slice(0, 400)))
  })
})

// ---- 前端消费侧：treeData 是 JSX，vm 跑不了，用源码守卫钉契约 ----
// 这几条对应真机验证时暴露的两个缺口：视图在树里认不出来、视图上还能点"添加行"
describe('视图在树里的呈现（源码守卫）', () => {
  const jsx = fs.readFileSync(
    path.join(ROOT, 'src/client/components/database/db-session.jsx'), 'utf8'
  )
  const styl = fs.readFileSync(
    path.join(ROOT, 'src/client/components/database/db-session.styl'), 'utf8'
  )

  // 注意不能直接抓第一个 `if (isLeafNode(node)) {`：过滤用的 filterNode 也是这个形状。
  // treeData 里的叶子是唯一带 isLeaf: true 的那个对象，以它为锚点取窗口
  const leafWin = () => {
    const i = jsx.indexOf('isLeaf: true')
    assert.ok(i > 0, 'leaf DataNode not found')
    return jsx.slice(Math.max(0, i - 500), i + 200)
  }

  test('叶子节点把 type 带成 nodeType，供按钮门控消费', () => {
    assert.ok(leafWin().includes('nodeType: node.type'), 'leaf must expose nodeType')
  })

  test('视图叶子有 V 标记，表没有', () => {
    assert.ok(leafWin().includes("node.type === 'view'"), 'view must be distinguished')
    assert.ok(leafWin().includes('db-tree-view-mark'), 'view must render a marker')
    // 样式必须真的存在（否则只是个没样式的 span，和表名连在一起更难读）
    assert.ok(/\.db-tree-view-mark/.test(styl), 'marker style missing')
    assert.ok(/\.db-tree-view\b/.test(styl), 'view wrapper style missing')
  })

  test('选中视图时 sel 带 nodeType:view，缺省按 table', () => {
    assert.ok(jsx.includes("nodeType: node.nodeType || 'table'"), 'sel must carry nodeType with table fallback')
  })

  test('视图不出现「添加行」入口（INSERT INTO 视图两引擎都可能拒绝）', () => {
    const m = jsx.match(/B1 添加行：([\s\S]{0,600}?)onClick=\{openInsertModal\}/)
    assert.ok(m, 'add-row button not found')
    assert.ok(m[1].includes("sel.nodeType !== 'view'"), 'view must not offer insert')
  })
})
