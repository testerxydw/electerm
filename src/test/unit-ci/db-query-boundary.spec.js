// T7 hasMore 边界回归：真实适配器源码 + vm 假驱动
//  - MySQL/PG 查询 pageSize + 1 行，只返回前 pageSize 行
//  - 恰好整页时 hasMore=false，多 1 行时 hasMore=true
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')

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
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

const conn = { dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'p', dbName: 'd' }

// 假 mysql pool：按 rows 数量返回；记录 SQL
function makeMysql (rows, execResult = [[]]) {
  const calls = { queries: [], executes: [] }
  const pool = {
    async query (sql) {
      calls.queries.push(sql)
      return [rows]
    },
    async execute (sql, params) {
      calls.executes.push({ sql, params })
      return execResult
    }
  }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      'mysql2/promise': { createPool () { return pool } }
    },
    'mysql.js'
  )
  return { mod, calls }
}

// 假 pg Client：rowsOrFn 为数组时固定返回，为函数时按 SQL 路由；记录 SQL/参数
function makePostgres (rowsOrFn) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      if (typeof rowsOrFn === 'function') {
        return rowsOrFn(sql, params)
      }
      return { rows: rowsOrFn }
    }

    async end () {}
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client } },
    'postgres.js'
  )
  return { mod, calls }
}

const makeRows = n => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('T7 hasMore boundary: mysql', () => {
  test('恰好整页 → hasMore false，只回 pageSize 行', async () => {
    const { mod, calls } = makeMysql(makeRows(20))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, false)
    assert.match(calls.queries[0], /LIMIT 21 OFFSET 0/, '多取 1 行判定边界')
  })

  test('多 1 行 → hasMore true，多余行不返回', async () => {
    const { mod } = makeMysql(makeRows(21))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, true)
    assert.equal(res.rows[19].id, 19, '返回前 pageSize 行')
  })

  test('末页不足整页 → hasMore false', async () => {
    const { mod } = makeMysql(makeRows(5))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 3, pageSize: 20 })
    assert.equal(res.rows.length, 5)
    assert.equal(res.hasMore, false)
  })
})

describe('T11 exact row count', () => {
  test('mysql countRows 走限定表名并返回数字', async () => {
    const { mod, calls } = makeMysql([{ c: 1234 }])
    const res = await mod.countRows(conn, { database: 'db', table: 't' })
    assert.equal(res.count, 1234)
    assert.match(calls.queries[0], /SELECT COUNT\(\*\) AS c FROM `db`\.`t`/)
  })

  test('postgres countRows 限定 schema，默认 public', async () => {
    const { mod, calls } = makePostgres(() => ({ rows: [{ c: '42' }] }))
    const res = await mod.countRows(conn, { database: 'd', schema: 'analytics', table: 'events' })
    assert.equal(res.count, 42)
    assert.match(calls.queries[0].sql, /FROM "analytics"\."events"/)
    await mod.countRows(conn, { database: 'd', table: 't' })
    assert.match(calls.queries[1].sql, /FROM "public"\."t"/)
  })

  test('postgres 跨库计数拒绝', async () => {
    const { mod } = makePostgres(() => ({ rows: [{ c: 1 }] }))
    await assert.rejects(
      mod.countRows(conn, { database: 'other', table: 't' }),
      /cross-database/
    )
  })

  test('op 注册与超时：countRows 60s、redis 不注册', async () => {
    const INDEX = path.join(ROOT, 'src/app/lib/db-client/index.js')
    const src = fs.readFileSync(INDEX, 'utf8')
    const mapHits = src.match(/countRows: 'countRows'/g) || []
    assert.equal(mapHits.length, 2, 'mysql/postgres must register countRows')
    assert.match(src, /countRows: 60000/, 'countRows needs a 60s timeout')
    const redisMap = src.match(/redis: \{[\s\S]*?\n\s{2}\}/)[0]
    assert.ok(!redisMap.includes('countRows'), 'redis has no total row count')
  })

  test('前端点击才计数，切表/排序/页大小/刷新重置', async () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes("dbClientOp', tabId, 'countRows'"), 'must call countRows op')
    const resets = src.match(/resetExactRows\(\)/g) || []
    assert.ok(resets.length >= 4, 'expected reset on table/sort/pageSize/refresh, got ' + resets.length)
    assert.ok(src.includes('exactRows.value === null'), 'exact value replaces the estimate')
  })
})

describe('批次 E：MySQL 近似行数只在首页查询', () => {
  test('首页查 information_schema，翻页不再查', async () => {
    const { mod, calls } = makeMysql([{ id: 1 }], [[{ c: 10 }]])
    const p1 = await mod.getPageData(conn, { database: 'db', table: 't', page: 1, pageSize: 20 })
    assert.equal(p1.totalRows, 10)
    assert.equal(calls.executes.length, 1)
    const p2 = await mod.getPageData(conn, { database: 'db', table: 't', page: 2, pageSize: 20 })
    assert.equal(p2.totalRows, undefined)
    assert.equal(calls.executes.length, 1, 'page 2 must reuse the page-1 estimate')
  })

  test('前端翻页沿用上一页的近似值', () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes('page > 1 ? g.totalRows : undefined'), 'totalRows fallback missing')
  })
})

describe('T3 postgres schema hierarchy', () => {
  test('当前库返回 schema 层级，非当前库仍为空', async () => {
    const { mod } = makePostgres(sql => {
      if (/pg_database/.test(sql)) {
        return { rows: [{ datname: 'd' }, { datname: 'other' }] }
      }
      if (/pg_namespace/.test(sql)) {
        return { rows: [{ nspname: 'analytics' }, { nspname: 'public' }] }
      }
      if (/pg_tables/.test(sql)) {
        return {
          rows: [
            { schemaname: 'public', tablename: 'users' },
            { schemaname: 'analytics', tablename: 'events' }
          ]
        }
      }
      return { rows: [] }
    })
    const meta = await mod.getMetadata(conn)
    assert.deepEqual([...meta].map(d => d.name), ['d', 'other'])
    assert.deepEqual([...meta[0].children].map(s => s.name), ['analytics', 'public'])
    assert.equal(meta[0].children[0].type, 'schema')
    assert.deepEqual([...meta[0].children[0].children].map(t => t.name), ['events'])
    assert.deepEqual([...meta[0].children[1].children].map(t => t.name), ['users'])
    assert.deepEqual([...meta[1].children], [], '非当前库不展开')
  })

  test('空 schema 也保留在树中', async () => {
    const { mod } = makePostgres(sql => {
      if (/pg_database/.test(sql)) {
        return { rows: [{ datname: 'd' }] }
      }
      if (/pg_namespace/.test(sql)) {
        return { rows: [{ nspname: 'empty_schema' }, { nspname: 'public' }] }
      }
      if (/pg_tables/.test(sql)) {
        return { rows: [{ schemaname: 'public', tablename: 't' }] }
      }
      return { rows: [] }
    })
    const meta = await mod.getMetadata(conn)
    assert.deepEqual([...meta[0].children].map(s => s.name), ['empty_schema', 'public'])
    assert.deepEqual([...meta[0].children[0].children], [])
  })

  test('getPageData 显式限定 schema，默认 public', async () => {
    const { mod, calls } = makePostgres(makeRows(1))
    await mod.getPageData(conn, { database: 'd', schema: 'analytics', table: 'events', page: 1, pageSize: 20 })
    assert.match(calls.queries[0].sql, /FROM "analytics"\."events"/)
    await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.match(calls.queries[1].sql, /FROM "public"\."t"/)
  })

  test('渲染层传递 schema 并生成 S 标记 / schema.table 标题', async () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes('const nodeKey = (database, schema, table)'), 'node key must carry 3 parts')
    const schemaArgs = src.match(/schema: target\.schema \|\| ''/g) || []
    assert.ok(schemaArgs.length >= 2, 'loadPage / findLastPage must pass schema')
    assert.ok(src.includes('db-tree-schema-mark'), 'schema node needs S mark')
    assert.ok(
      /sel\.schema \? `\$\{sel\.schema\}\.\$\{sel\.table\}`/.test(src),
      'grid title must show schema.table'
    )
  })
})

describe('T7 hasMore boundary: postgres', () => {
  test('恰好整页 → hasMore false，只回 pageSize 行', async () => {
    const { mod, calls } = makePostgres(makeRows(20))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, false)
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 0/)
  })

  test('多 1 行 → hasMore true，偏移按页计算', async () => {
    const { mod, calls } = makePostgres(makeRows(21))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 2, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, true)
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 20/)
  })

  test('末页不足整页 → hasMore false', async () => {
    const { mod } = makePostgres(makeRows(3))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 5, pageSize: 20 })
    assert.equal(res.hasMore, false)
  })
})
