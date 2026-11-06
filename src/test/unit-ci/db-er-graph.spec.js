/**
 * H3b 只读 ER 图：后端整库外键查询 + 归一纯函数
 *
 * 覆盖：
 *   - er-graph 纯函数：MySQL 行式（每列一行）/ PG 数组式（conkey/confkey）两种输入
 *     归一成同一形状；跨库/跨 schema 与悬空端点（视图、无权限）的边必须丢掉
 *   - mysql.listForeignKeys / pg.listForeignKeys 走 vm 假驱动：两条 SQL 都带
 *     当前库/schema 参数，返回 { schema, tables, edges }
 *   - 接线契约：两个适配器都登记了 listForeignKeys（redis 没有这个概念）
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const PG_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const ER = require(path.join(ROOT, 'src/app/lib/db-client/er-graph.js'))
const TYPE_NORM = require(path.join(ROOT, 'src/app/common/db-type-normalize.js'))
// N1：适配器新增依赖 './db-tls'（只依赖 fs/crypto），沙箱给真模块，顺带钉住委托关系
const DB_TLS = require(path.join(ROOT, 'src/app/lib/db-client/db-tls.js'))

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

const plain = v => JSON.parse(JSON.stringify(v))

function runInVm (src, stubs, filename) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (spec === '../../common/db-type-normalize') return TYPE_NORM
      if (spec === './db-tls') return DB_TLS
      if (spec === './er-graph') return ER
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

// ---------------------------------------------------------------- 纯函数：MySQL

describe('er-graph fromMysql', () => {
  const tables = [{ name: 'parent' }, { name: 'child' }, { name: 'child2' }]

  test('单列外键：一条边，列对对得上', () => {
    const g = ER.fromMysql({
      tables,
      database: 'shop',
      fkRows: [{
        table_name: 'child',
        fk_name: 'fk_child_parent',
        column_name: 'parent_id',
        ref_schema: 'shop',
        ref_table: 'parent',
        ref_column: 'id'
      }]
    })
    assert.equal(g.schema, 'shop')
    assert.deepEqual(plain(g.tables), [
      { schema: 'shop', name: 'child' },
      { schema: 'shop', name: 'child2' },
      { schema: 'shop', name: 'parent' }
    ])
    assert.equal(g.edges.length, 1)
    assert.deepEqual(plain(g.edges[0]), {
      name: 'fk_child_parent',
      from: { schema: 'shop', name: 'child' },
      to: { schema: 'shop', name: 'parent' },
      columns: [{ from: 'parent_id', to: 'id' }]
    })
  })

  test('复合外键：两行聚成一条边，列对顺序按行序（ORDINAL_POSITION）', () => {
    const g = ER.fromMysql({
      tables,
      database: 'shop',
      fkRows: [
        { table_name: 'child2', fk_name: 'fk2', column_name: 'p_a', ref_schema: 'shop', ref_table: 'parent', ref_column: 'a' },
        { table_name: 'child2', fk_name: 'fk2', column_name: 'p_b', ref_schema: 'shop', ref_table: 'parent', ref_column: 'b' }
      ]
    })
    assert.equal(g.edges.length, 1, '复合外键不能拆成两条边')
    assert.deepEqual(plain(g.edges[0].columns), [
      { from: 'p_a', to: 'a' },
      { from: 'p_b', to: 'b' }
    ])
  })

  test('跨库引用丢掉（对端不在这张图里）', () => {
    const g = ER.fromMysql({
      tables,
      database: 'shop',
      fkRows: [{
        table_name: 'child',
        fk_name: 'fk_far',
        column_name: 'x',
        ref_schema: 'other',
        ref_table: 'far',
        ref_column: 'id'
      }]
    })
    assert.equal(g.edges.length, 0)
  })

  test('端点不在表清单里的边丢掉（视图 / 无权限的表）', () => {
    const g = ER.fromMysql({
      tables: [{ name: 'child' }],
      database: 'shop',
      fkRows: [{
        table_name: 'child',
        fk_name: 'fk_view',
        column_name: 'v_id',
        ref_schema: 'shop',
        ref_table: 'some_view',
        ref_column: 'id'
      }]
    })
    assert.equal(g.tables.length, 1)
    assert.equal(g.edges.length, 0)
  })

  test('表清单去重 + 名称排序；空输入返回空图不抛错', () => {
    const g = ER.fromMysql({
      tables: [{ name: 'b' }, { name: 'a' }, { name: 'b' }, { name: '' }],
      database: 'shop',
      fkRows: []
    })
    assert.deepEqual(plain(g.tables.map(t => t.name)), ['a', 'b'])
    assert.deepEqual(plain(ER.fromMysql({ tables: null, fkRows: null, database: 'shop' })), {
      schema: 'shop', tables: [], edges: []
    })
  })

  test('边按 from/to/name 排序，输出稳定（同样的库每次画同一张图）', () => {
    const rows = [
      { table_name: 'z', fk_name: 'fk_z', column_name: 'a', ref_schema: 's', ref_table: 'y', ref_column: 'id' },
      { table_name: 'a', fk_name: 'fk_a', column_name: 'b', ref_schema: 's', ref_table: 'b', ref_column: 'id' }
    ]
    const g = ER.fromMysql({ tables: [{ name: 'a' }, { name: 'b' }, { name: 'y' }, { name: 'z' }], fkRows: rows, database: 's' })
    assert.deepEqual(plain(g.edges.map(e => e.from.name)), ['a', 'z'])
  })
})

// ---------------------------------------------------------------- 纯函数：PG

describe('er-graph fromPg', () => {
  const tables = [{ name: 'orders' }, { name: 'customers' }]

  test('数组式列对按序号 zip', () => {
    const g = ER.fromPg({
      tables,
      schema: 'public',
      fkRows: [{
        fk_name: 'orders_customer_fk',
        table_name: 'orders',
        ref_schema: 'public',
        ref_table: 'customers',
        columns: ['tenant_id', 'customer_id'],
        ref_columns: ['tenant_id', 'id']
      }]
    })
    assert.equal(g.edges.length, 1)
    assert.deepEqual(plain(g.edges[0].columns), [
      { from: 'tenant_id', to: 'tenant_id' },
      { from: 'customer_id', to: 'id' }
    ])
  })

  test('列对长度不一致的边丢掉（半张列对比没有更误导）', () => {
    const g = ER.fromPg({
      tables,
      schema: 'public',
      fkRows: [{
        fk_name: 'bad',
        table_name: 'orders',
        ref_schema: 'public',
        ref_table: 'customers',
        columns: ['a', 'b'],
        ref_columns: ['a']
      }]
    })
    assert.equal(g.edges.length, 0)
  })

  test('跨 schema 引用丢掉；ref_schema 缺省时按当前 schema', () => {
    const g = ER.fromPg({
      tables,
      schema: 'public',
      fkRows: [
        { fk_name: 'far', table_name: 'orders', ref_schema: 'audit', ref_table: 'log', columns: ['x'], ref_columns: ['id'] },
        { fk_name: 'self', table_name: 'orders', ref_table: 'customers', columns: ['c'], ref_columns: ['id'] }
      ]
    })
    assert.equal(g.edges.length, 1)
    assert.equal(g.edges[0].name, 'self')
    assert.equal(g.edges[0].to.schema, 'public')
  })

  test('自引用（A→A）保留：布局层再决定怎么画环', () => {
    const g = ER.fromPg({
      tables: [{ name: 'employees' }],
      schema: 'public',
      fkRows: [{ fk_name: 'mgr', table_name: 'employees', ref_schema: 'public', ref_table: 'employees', columns: ['manager_id'], ref_columns: ['id'] }]
    })
    assert.equal(g.edges.length, 1)
    assert.deepEqual(plain(g.edges[0].from), plain(g.edges[0].to))
  })
})

// ---------------------------------------------------------------- 适配器（vm）

function makeMysqlPool (rows) {
  const calls = []
  const pool = {
    async query (sql, params) {
      calls.push({ sql, params })
      if (/FROM information_schema\.TABLES/.test(sql)) {
        return [rows.tables || [], []]
      }
      if (/FROM information_schema\.KEY_COLUMN_USAGE/.test(sql)) {
        return [rows.fks || [], []]
      }
      return [[], []]
    }
  }
  return { pool, calls }
}

function loadMysql (rows, conn) {
  const { pool, calls } = makeMysqlPool(rows)
  const api = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    { '../../common/log': LOG_STUB, 'mysql2/promise': { createPool: () => pool } },
    'mysql.js'
  )
  return { api, calls, conn }
}

describe('mysql.listForeignKeys（vm 假驱动）', () => {
  const CONN = { dbHost: 'er-host-1', dbPort: 3306, dbUser: 'u', dbName: 'shop' }

  test('两条 SQL 都带当前库参数，返回归一图', async () => {
    const { api, calls } = loadMysql({
      tables: [{ name: 'child' }, { name: 'parent' }],
      fks: [{ table_name: 'child', fk_name: 'fk1', column_name: 'pid', ref_schema: 'shop', ref_table: 'parent', ref_column: 'id' }]
    })
    const g = await api.listForeignKeys(CONN, { database: 'shop' })
    assert.equal(calls.length, 2)
    assert.ok(calls.every(c => plain(c.params)[0] === 'shop'), '两条 SQL 都要带库名')
    assert.equal(g.schema, 'shop')
    assert.equal(g.tables.length, 2)
    assert.equal(g.edges.length, 1)
  })

  test('database 缺省用连接上的库', async () => {
    const { api, calls } = loadMysql({ tables: [], fks: [] }, { dbHost: 'er-host-2', dbPort: 3306, dbUser: 'u', dbName: 'from-conn' })
    const g = await api.listForeignKeys({ dbHost: 'er-host-2', dbPort: 3306, dbUser: 'u', dbName: 'from-conn' }, {})
    assert.equal(g.schema, 'from-conn')
    assert.equal(calls[0].params[0], 'from-conn')
  })

  test('没有库名直接报错（不猜一个空 schema 去查全库）', async () => {
    const { api } = loadMysql({ tables: [], fks: [] })
    await assert.rejects(() => api.listForeignKeys({ dbHost: 'er-host-3', dbPort: 3306, dbUser: 'u' }, {}), /requires database/)
  })
})

describe('pg.listForeignKeys（vm 假驱动）', () => {
  function loadPg (rows) {
    const calls = []
    class Client {
      async connect () {}
      async end () {}
      async query (sql, params) {
        calls.push({ sql, params })
        if (/FROM pg_class c/.test(sql)) {
          return { rows: rows.tables || [] }
        }
        if (/FROM pg_constraint con/.test(sql)) {
          return { rows: rows.fks || [] }
        }
        return { rows: [] }
      }
    }
    const api = runInVm(fs.readFileSync(PG_JS, 'utf8'), { pg: { Client } }, 'postgres.js')
    return { api, calls }
  }

  test('schema 默认 public，两条 SQL 都带它', async () => {
    const { api, calls } = loadPg({
      tables: [{ name: 'orders' }, { name: 'customers' }],
      fks: [{ fk_name: 'fk1', table_name: 'orders', ref_schema: 'public', ref_table: 'customers', columns: ['cid'], ref_columns: ['id'] }]
    })
    const g = await api.listForeignKeys({ dbHost: 'er-pg-1', dbPort: 5432, dbUser: 'u', dbName: 'd' }, {})
    assert.equal(g.schema, 'public')
    assert.equal(g.tables.length, 2)
    assert.equal(g.edges.length, 1)
    assert.ok(calls.every(c => c.params[0] === 'public'), '两条 SQL 都要带 schema')
  })

  test('显式 schema 透传（不硬编码 public）', async () => {
    const { api, calls } = loadPg({ tables: [], fks: [] })
    const g = await api.listForeignKeys({ dbHost: 'er-pg-2', dbPort: 5432, dbUser: 'u', dbName: 'd' }, { schema: 'audit' })
    assert.equal(g.schema, 'audit')
    assert.equal(calls[0].params[0], 'audit')
  })
})

// ---------------------------------------------------------------- 接线契约

describe('H3b 接线契约', () => {
  test('mysql / postgres 都登记 listForeignKeys，redis 没有这个概念', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const mysqlMap = src.slice(src.indexOf('mysql: {'), src.indexOf('postgres: {'))
    const pgMap = src.slice(src.indexOf('postgres: {'), src.indexOf('redis: {'))
    assert.ok(/listForeignKeys: 'listForeignKeys'/.test(mysqlMap), 'mysql 缺 listForeignKeys')
    assert.ok(/listForeignKeys: 'listForeignKeys'/.test(pgMap), 'postgres 缺 listForeignKeys')
    assert.ok(!/listForeignKeys/.test(src.slice(src.indexOf('redis: {'))), 'redis 不该有外键 op')
  })

  test('两个适配器都导出 listForeignKeys，且只发 SELECT', () => {
    const mysql = fs.readFileSync(MYSQL_JS, 'utf8')
    const pg = fs.readFileSync(PG_JS, 'utf8')
    assert.match(mysql, /listForeignKeys,/)
    assert.match(pg, /listForeignKeys,/)
    const blocks = [
      mysql.slice(mysql.indexOf('const MY_ER_TABLES'), mysql.indexOf('async function listForeignKeys')),
      pg.slice(pg.indexOf('const PG_ER_TABLES'), pg.indexOf('async function listForeignKeys'))
    ]
    for (const b of blocks) {
      assert.ok(b.length > 0, 'ER 查询语句块没找到')
      assert.ok(!/(^|\s)(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)(\s|$)/i.test(b),
        'ER 查询只能是 SELECT')
    }
  })
})
