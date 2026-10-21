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
