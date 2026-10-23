/**
 * listColumns（阶段4 §4.3）单测
 *
 * 三层各测一段：
 * 1. 适配器纯函数 groupColumns —— 分组/列序/pk 标记，MySQL 与 PG 行结构不同
 * 2. 适配器 IO —— SQL 与参数（DB 名走占位符而不是拼字符串）、无库名时不触网
 * 3. 分发层缓存 —— 同键命中、跨库不串、getMetadata 失效、并发去重、Redis 不注册
 *
 * 用 vm 打桩跑真实源码，不依赖 electron / 真实驱动 / 网络。
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const PG_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

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
    setTimeout,
    clearTimeout,
    Promise,
    Buffer
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

// ---------------------------------------------------------------- 1. 分组纯函数

describe('MySQL groupColumns：行 → 表分组', () => {
  const api = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    { '../../common/log': LOG_STUB, 'mysql2/promise': {} },
    'mysql.js'
  )

  test('同一表的多列归到一块，列序保持查询顺序', () => {
    const out = api.groupColumns([
      { t: 'users', c: 'id', ty: 'bigint', k: 'PRI' },
      { t: 'users', c: 'name', ty: 'varchar(64)', k: '' },
      { t: 'orders', c: 'id', ty: 'bigint', k: 'PRI' }
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0].table, 'users')
    assert.deepEqual(Array.from(out[0].columns.map(c => c.name)), ['id', 'name'])
    assert.equal(out[1].table, 'orders')
  })

  test('pk 只认 COLUMN_KEY === PRI（UNI/MUL 不算主键）', () => {
    const out = api.groupColumns([
      { t: 't', c: 'a', ty: 'int', k: 'PRI' },
      { t: 't', c: 'b', ty: 'int', k: 'UNI' },
      { t: 't', c: 'c', ty: 'int', k: 'MUL' },
      { t: 't', c: 'd', ty: 'int', k: '' }
    ])
    assert.deepEqual(Array.from(out[0].columns.map(c => c.pk)), [true, false, false, false])
  })

  test('type 用 COLUMN_TYPE（带长度/unsigned），空值降级为空串', () => {
    const out = api.groupColumns([
      { t: 't', c: 'a', ty: 'int unsigned', k: '' },
      { t: 't', c: 'b', ty: undefined, k: '' }
    ])
    assert.equal(out[0].columns[0].type, 'int unsigned')
    assert.equal(out[0].columns[1].type, '')
  })

  test('空结果 / null 返回空数组，不抛错', () => {
    assert.equal(api.groupColumns([]).length, 0)
    assert.equal(api.groupColumns(null).length, 0)
  })
})

describe('PG groupColumns：库→schema→表分组', () => {
  const api = runInVm(fs.readFileSync(PG_JS, 'utf8'), { pg: {} }, 'postgres.js')

  test('同名表在不同 schema 下不合并', () => {
    const out = api.groupColumns([
      { s: 'public', t: 'users', c: 'id', ty: 'int4', is_pk: true },
      { s: 'audit', t: 'users', c: 'id', ty: 'int4', is_pk: true }
    ])
    assert.equal(out.length, 2)
    assert.deepEqual(Array.from(out.map(t => t.schema)), ['public', 'audit'])
  })

  test('同一 schema 下同表多列归一组，含 pk 标记', () => {
    const out = api.groupColumns([
      { s: 'public', t: 'users', c: 'id', ty: 'int4', is_pk: true },
      { s: 'public', t: 'users', c: 'email', ty: 'varchar', is_pk: false }
    ])
    assert.equal(out.length, 1)
    assert.deepEqual(Array.from(out[0].columns.map(c => c.name)), ['id', 'email'])
    assert.equal(out[0].columns[0].pk, true)
    assert.equal(out[0].columns[1].pk, false)
  })
})

// ---------------------------------------------------------------- 2. 适配器 IO

function loadMysqlWithRows (rows) {
  const calls = { queries: [], params: [] }
  const pool = {
    async query (sql, params) {
      calls.queries.push(sql)
      calls.params.push(params)
      return [rows, []]
    }
  }
  const api = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      'mysql2/promise': { createPool: () => pool, createConnection: () => ({ ping: async () => {} }) }
    },
    'mysql.js'
  )
  return { api, calls }
}

const mysqlConn = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbName: 'shop' }

describe('MySQL listColumns IO', () => {
  test('库名走占位符参数，不拼进 SQL（防注入）', async () => {
    const { api, calls } = loadMysqlWithRows([{ t: 'users', c: 'id', ty: 'bigint', k: 'PRI' }])
    await api.listColumns(mysqlConn, { database: 'shop2' })
    assert.equal(calls.params[0].length, 1)
    assert.equal(calls.params[0][0], 'shop2')
    assert.ok(calls.queries[0].includes('information_schema.COLUMNS'))
    assert.ok(calls.queries[0].includes('TABLE_SCHEMA = ?'))
    assert.ok(calls.queries[0].includes('ORDER BY TABLE_NAME, ORDINAL_POSITION'))
  })

  test('未传 database 时回落到连接自带库名', async () => {
    const { api, calls } = loadMysqlWithRows([])
    await api.listColumns(mysqlConn, {})
    assert.equal(calls.params[0][0], 'shop')
  })

  test('库名缺失时直接返回空，不发查询（降级不抛错）', async () => {
    const { api, calls } = loadMysqlWithRows([])
    const res = await api.listColumns({ dbHost: 'h', dbPort: 3306, dbUser: 'u' }, {})
    assert.equal(res.tables.length, 0)
    assert.equal(calls.queries.length, 0)
  })
})

function loadPgWithRows (rows) {
  const calls = { queries: [], params: [] }
  class FakeClient {
    async connect () {}
    async end () {}
    async query (sql, params) {
      calls.queries.push(sql)
      calls.params.push(params)
      return { rows }
    }
  }
  const api = runInVm(fs.readFileSync(PG_JS, 'utf8'), { pg: { Client: FakeClient } }, 'postgres.js')
  return { api, calls }
}

const pgConn = { dbHost: 'h', dbPort: 5432, dbUser: 'u', dbName: 'app' }

describe('PG listColumns IO', () => {
  test('按 table_catalog 圈定当前库，主键用 LEFT JOIN 约束视图', async () => {
    const { api, calls } = loadPgWithRows([])
    await api.listColumns(pgConn, {})
    const sql = calls.queries[0]
    assert.ok(sql.includes('information_schema.columns'))
    assert.ok(sql.includes('table_catalog = $1'))
    assert.ok(sql.includes('PRIMARY KEY'))
    assert.ok(/LEFT JOIN/.test(sql), '主键必须 LEFT JOIN，否则无主键表会丢行')
    assert.equal(calls.params[0][0], 'app')
  })

  test('传 schema 时在前端侧过滤（不重复请求）', async () => {
    const { api, calls } = loadPgWithRows([
      { s: 'public', t: 'users', c: 'id', ty: 'int4', is_pk: true },
      { s: 'audit', t: 'trail', c: 'id', ty: 'int4', is_pk: true }
    ])
    const res = await api.listColumns(pgConn, { schema: 'audit' })
    assert.equal(res.tables.length, 1)
    assert.equal(res.tables[0].table, 'trail')
    assert.equal(calls.queries.length, 1)
  })
})

// ---------------------------------------------------------------- 3. 分发层缓存

function loadDbClient (adapter) {
  const stubs = {
    '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
    '../../common/log': LOG_STUB,
    './redis': adapter.redis,
    './mysql': adapter.mysql,
    './postgres': adapter.postgres
  }
  return runInVm(fs.readFileSync(INDEX_JS, 'utf8'), stubs, 'db-client/index.js')
}

function makeMysqlAdapter () {
  const calls = { listColumns: [], metadata: 0, acquire: 0, release: 0 }
  let fail = false
  return {
    calls,
    failNext () { fail = true },
    async acquire () { calls.acquire++ },
    async release () { calls.release++ },
    async getMetadata () { calls.metadata++ },
    async listColumns (conn, args) {
      calls.listColumns.push((args && args.database) || '')
      if (fail) {
        fail = false
        throw new Error('boom')
      }
      return { tables: [{ table: 'users', columns: [{ name: 'id', type: 'int', pk: true }] }] }
    },
    async closeMysqlConnection () {}
  }
}

const mysqlBookmark = id => ({
  id,
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'u',
  dbName: 'shop'
})

describe('listColumns 缓存（分发层）', () => {
  test('同库重复请求只查一次', async () => {
    const mysql = makeMysqlAdapter()
    const api = loadDbClient({ mysql, postgres: {}, redis: {} })
    await api.openDbTab(mysqlBookmark('c1'), null)
    await api.dbClientOp('c1', 'listColumns', { database: 'shop' })
    await api.dbClientOp('c1', 'listColumns', { database: 'shop' })
    assert.equal(mysql.calls.listColumns.length, 1)
    await api.closeDbTab('c1')
  })

  test('不同库各查一次（键含库名）', async () => {
    const mysql = makeMysqlAdapter()
    const api = loadDbClient({ mysql, postgres: {}, redis: {} })
    await api.openDbTab(mysqlBookmark('c2'), null)
    await api.dbClientOp('c2', 'listColumns', { database: 'a' })
    await api.dbClientOp('c2', 'listColumns', { database: 'b' })
    assert.deepEqual(Array.from(mysql.calls.listColumns), ['a', 'b'])
    await api.closeDbTab('c2')
  })

  test('getMetadata（刷新树/切库）后缓存失效', async () => {
    const mysql = makeMysqlAdapter()
    const api = loadDbClient({ mysql, postgres: {}, redis: {} })
    await api.openDbTab(mysqlBookmark('c3'), null)
    await api.dbClientOp('c3', 'listColumns', { database: 'shop' })
    await api.dbClientOp('c3', 'getMetadata', {})
    await api.dbClientOp('c3', 'listColumns', { database: 'shop' })
    assert.equal(mysql.calls.listColumns.length, 2)
    await api.closeDbTab('c3')
  })

  test('并发同键合并为一次查询', async () => {
    const mysql = makeMysqlAdapter()
    const api = loadDbClient({ mysql, postgres: {}, redis: {} })
    await api.openDbTab(mysqlBookmark('c4'), null)
    await Promise.all([
      api.dbClientOp('c4', 'listColumns', { database: 'shop' }),
      api.dbClientOp('c4', 'listColumns', { database: 'shop' }),
      api.dbClientOp('c4', 'listColumns', { database: 'shop' })
    ])
    assert.equal(mysql.calls.listColumns.length, 1)
    await api.closeDbTab('c4')
  })

  test('失败不写入缓存，下次请求会重试', async () => {
    const mysql = makeMysqlAdapter()
    const api = loadDbClient({ mysql, postgres: {}, redis: {} })
    await api.openDbTab(mysqlBookmark('c5'), null)
    mysql.failNext()
    await assert.rejects(api.dbClientOp('c5', 'listColumns', { database: 'shop' }), /boom/)
    const res = await api.dbClientOp('c5', 'listColumns', { database: 'shop' })
    assert.equal(res.tables.length, 1)
    assert.equal(mysql.calls.listColumns.length, 2)
    await api.closeDbTab('c5')
  })

  test('Redis 未注册该 op：前端传了也只会收到 unsupported（不能静默成功）', async () => {
    const redis = { async acquire () {}, async release () {}, async getMetadata () {} }
    const api = loadDbClient({ mysql: {}, postgres: {}, redis })
    await api.openDbTab({ id: 'r1', dbType: 'redis', dbHost: 'h', dbPort: 6379 }, null)
    await assert.rejects(
      api.dbClientOp('r1', 'listColumns', {}),
      /unsupported op for redis: listColumns/
    )
    await api.closeDbTab('r1')
  })
})
