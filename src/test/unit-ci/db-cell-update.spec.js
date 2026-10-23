// T5 主键检测与参数化单元格更新：真实适配器源码 + vm 假驱动
//  - 主键检测：MySQL 看 Key='PRI'，PG 查 pg_index 加 is_primary_key 标记
//  - updateCell：占位符绑定+正确标识符引用、只读门控、跨库错误
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
// F0 起适配器顶部会 require('./structure-v2')：vm 里的 require 是白名单式，
// 必须把真实模块塞进 stubs，否则跑不到被测函数就 "unexpected require"
const STRUCTURE_V2 = require(path.join(ROOT, 'src/app/lib/db-client/structure-v2.js'))

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

describe('T5 cell update: mysql', () => {
  test('mysql updateCell 参数化查询不拼接', async () => {
    const { mod, calls } = makeMysql()
    await mod.updateCell(conn, {
      database: 'db',
      table: 't',
      pkColumn: 'id',
      pkValue: 42,
      column: 'status',
      value: 'active',
      readOnly: false
    })
    assert.equal(calls.executes.length, 1)
    const exec = calls.executes[0]
    assert.match(exec.sql, /UPDATE `db`.`t` SET `status` = \? WHERE `id` = \?/)
    // vm 里的数组原型与宿主不同，先摊平再比较
    assert.deepEqual([...exec.params], ['active', 42])
  })

  test('readOnly 直接拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.updateCell(conn, {
        database: 'db', table: 't', pkColumn: 'id', pkValue: 42, column: 'c', value: 'v', readOnly: true
      }),
      /read-only mode/
    )
  })

  test('缺少 pkColumn 时拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.updateCell(conn, {
        database: 'db', table: 't', pkColumn: '', pkValue: 42, column: 'c', value: 'v', readOnly: false
      }),
      /requires column and pkColumn/
    )
  })
})

describe('T5 cell update: postgres', () => {
  test('describeTable 包含 schema 参数和主键检测', async () => {
    const pg = makePostgres((sql) => {
      // 第一句：列列表
      if (/FROM information_schema/.test(sql)) {
        return {
          rows: [
            { column_name: 'id', data_type: 'int4' },
            { column_name: 'name', data_type: 'text' },
            { column_name: 'status', data_type: 'varchar' }
          ]
        }
      }
      // 第二句：主键查询
      if (/pg_index/.test(sql)) {
        return {
          rows: [{ column_name: 'id' }]
        }
      }
      return { rows: [] }
    })
    const res = await pg.mod.describeTable(conn, { schema: 'public', table: 't' })
    assert.equal(pg.calls.queries.length, 2)
    assert.equal(res.length, 3)
    assert.equal(res[0].is_primary_key, true)
    assert.equal(res[1].is_primary_key, false)
    assert.equal(res[0].column_name, 'id')
  })

  test('postgres updateCell 参数化查询不拼接', async () => {
    const { mod, calls } = makePostgres(() => ({ rowCount: 1 }))
    await mod.updateCell(conn, {
      database: 'd',
      schema: 'my_schema',
      table: 'my-table',
      pkColumn: 'user id',
      pkValue: 42,
      column: 'display name',
      value: "John O'Neil",
      readOnly: false
    })
    assert.equal(calls.queries.length, 1)
    const { sql, params } = calls.queries[0]
    assert.match(sql, /UPDATE "my_schema"."my-table" SET "display name" = \$1 WHERE "user id" = \$2/)
    assert.deepEqual([...params], ["John O'Neil", 42])
  })

  test('readOnly 直接拒绝', async () => {
    const { mod } = makePostgres(() => ({ rowCount: 1 }))
    await assert.rejects(
      mod.updateCell(conn, {
        table: 't', pkColumn: 'id', pkValue: 42, column: 'c', value: 'v', readOnly: true
      }),
      /read-only mode/
    )
  })

  test('cross database 连接拒绝', async () => {
    const { mod } = makePostgres(() => ({ rowCount: 1 }))
    // 当前 Client 绑定 d，query 要求 d2 → 抛出
    await assert.rejects(
      mod.updateCell({ ...conn, dbName: 'd' }, {
        database: 'd2',
        table: 't',
        pkColumn: 'id',
        pkValue: 42,
        column: 'c',
        value: 'v',
        readOnly: false
      }),
      /cross-database/
    )
  })

  test('default schema 回 public', async () => {
    const pg = makePostgres((sql) => {
      if (/pg_index/.test(sql)) {
        return { rows: [{ column_name: 'id' }] }
      }
      return { rows: [] }
    })
    await pg.mod.describeTable(conn, { table: 't' })
    const [info] = pg.calls.queries[0].params
    assert.equal(info, 'public')
  })
})

describe('T5 wiring: renderer no longer builds SQL', () => {
  test('前端走 updateCell op 并传主键值', async () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes("dbClientOp', tabId, 'updateCell'"), 'must call updateCell op')
    assert.ok(src.includes('pkValue: row[pkColumn]'), 'must send primary key value')
    assert.ok(!src.includes('quoteVal'), 'front-end value quoting must be removed')
    const block = src.match(/const runCellUpdate =[\s\S]*?\n\s{2}\}/)
    assert.ok(block, 'runCellUpdate not found')
    assert.ok(!block[0].includes('executeSql'), 'cell update must not run raw SQL')
    assert.ok(src.includes('is_primary_key'), 'PG primary key marker must be consumed')
  })

  test('db-client op map registers updateCell for both SQL engines', async () => {
    const INDEX = path.join(ROOT, 'src/app/lib/db-client/index.js')
    const src = fs.readFileSync(INDEX, 'utf8')
    const hits = src.match(/updateCell: 'updateCell'/g) || []
    assert.equal(hits.length, 2, 'mysql and postgres must register updateCell')
  })
})

function makeMysql () {
  const calls = { queries: [], executes: [] }
  const pool = {
    async query (sql) {
      calls.queries.push(sql)
      return [[]]
    },
    async execute (sql, params) {
      calls.executes.push({ sql, params })
      return [{ affectedRows: 1 }]
    }
  }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      './structure-v2': STRUCTURE_V2,
      'mysql2/promise': { createPool () { return pool } }
    },
    'mysql.js'
  )
  return { mod, calls }
}

function makePostgres (rowFn) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      return rowFn(sql, params)
    }

    async end () {}
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client }, './structure-v2': STRUCTURE_V2 },
    'postgres.js'
  )
  return { mod, calls }
}
