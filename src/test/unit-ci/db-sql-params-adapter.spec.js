// H6a-2：executeSql 接受 params —— 真实适配器源码 + vm 假驱动
//
// 判据只有一条：**值必须以参数形式到驱动**，主进程不出现拼接后的 SQL。
// 另外守住参数化模式的边界：只允许单条语句（多语句下参数归属无法确定），
// 只读与风险门仍按原始 SQL 判定（参数不改变语句类型）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
const STRUCTURE_V2 = require(path.join(ROOT, 'src/app/lib/db-client/structure-v2.js'))
const TYPE_NORM = require(path.join(ROOT, 'src/app/common/db-type-normalize.js'))

const conn = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbPassword: 'p', dbName: 'd' }

function runInVm (src, stubs, filename) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (spec === '../../common/db-type-normalize') return TYPE_NORM
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

// mysql2 的 pool.getConnection() 返回连接；USE 也走 connect.query
function makeMysql () {
  const calls = []
  const c = {
    async query (sql, params) {
      calls.push({ sql, params })
      return [[{ id: 1 }], [{ name: 'id' }]]
    },
    release () {}
  }
  const pool = {
    async getConnection () {
      return c
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

function makePostgres () {
  const calls = []
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (arg) {
      calls.push(arg)
      if (typeof arg === 'string') {
        return { rows: [], fields: [], command: 'SELECT', rowCount: 0 }
      }
      return { rows: [], fields: [], command: 'SELECT', rowCount: 0 }
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

describe('H6a executeSql：mysql', () => {
  test('params 原样交给驱动，SQL 里只有占位符', async () => {
    const { mod, calls } = makeMysql()
    const res = await mod.executeSql(conn, {
      sql: 'SELECT * FROM t WHERE id = ?',
      params: [42]
    })
    assert.equal(calls.length, 1, '参数化时不该多出一条 USE')
    assert.equal(calls[0].sql, 'SELECT * FROM t WHERE id = ?')
    assert.deepEqual([...calls[0].params], [42])
    assert.equal(res.results.length, 1)
    assert.equal(res.results[0].rows[0].id, 1)
  })

  test('带 database 时先 USE 再参数化执行', async () => {
    const { mod, calls } = makeMysql()
    await mod.executeSql(conn, { sql: 'SELECT ?', params: ['x'], database: 'demo' })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].sql, 'USE `demo`')
    assert.equal(calls[1].sql, 'SELECT ?')
    assert.deepEqual([...calls[1].params], ['x'])
  })

  test('没有 params 走原路径（只传一个参数给驱动）', async () => {
    const { mod, calls } = makeMysql()
    await mod.executeSql(conn, { sql: 'SELECT 1' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].params, undefined)
  })

  test('空数组等同于没参数（不改变旧行为）', async () => {
    const { mod, calls } = makeMysql()
    await mod.executeSql(conn, { sql: 'SELECT 1', params: [] })
    assert.equal(calls[0].params, undefined)
  })

  test('参数化模式拒绝多语句，且一条都不执行', async () => {
    const { mod, calls } = makeMysql()
    await assert.rejects(
      mod.executeSql(conn, { sql: 'SELECT 1; DELETE FROM t', params: [1] }),
      /single statement only/
    )
    assert.equal(calls.length, 0)
  })

  test('字符串/注释里的分号不算多语句', async () => {
    const { mod, calls } = makeMysql()
    await mod.executeSql(conn, {
      sql: "SELECT ';' AS a, :x -- ; 注释里的分号\n",
      params: []
    })
    assert.equal(calls.length, 1)
  })

  test('params 必须是数组', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.executeSql(conn, { sql: 'SELECT ?', params: { a: 1 } }),
      /params must be an array/
    )
  })

  test('只读仍按原始 SQL 判定（参数不改变语句类型）', async () => {
    const { mod, calls } = makeMysql()
    await assert.rejects(
      mod.executeSql(conn, { sql: 'DELETE FROM t WHERE id = ?', params: [1], readOnly: true }),
      /read-only mode/
    )
    assert.equal(calls.length, 0)
  })
})

describe('H6a executeSql：postgres', () => {
  test('params 走 { text, values }，不拼进 SQL', async () => {
    const { mod, calls } = makePostgres()
    const res = await mod.executeSql({ ...conn, dbPort: 5432 }, {
      sql: 'SELECT * FROM t WHERE id = $1',
      params: [42]
    })
    assert.equal(calls.length, 1)
    // vm 里的对象/数组原型与宿主不同，逐字段比并摊平数组
    assert.equal(calls[0].text, 'SELECT * FROM t WHERE id = $1')
    assert.deepEqual([...calls[0].values], [42])
    assert.equal(res.results.length, 1)
  })

  test('没有 params 仍用字符串形式调用（多语句照旧可用）', async () => {
    const { mod, calls } = makePostgres()
    await mod.executeSql({ ...conn, dbPort: 5432 }, { sql: 'SELECT 1; SELECT 2' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 'SELECT 1; SELECT 2')
  })

  test('参数化模式拒绝多语句', async () => {
    const { mod, calls } = makePostgres()
    await assert.rejects(
      mod.executeSql({ ...conn, dbPort: 5432 }, { sql: 'SELECT $1; SELECT $2', params: [1, 2] }),
      /single statement only/
    )
    assert.equal(calls.length, 0)
  })

  test('只读仍按原始 SQL 判定', async () => {
    const { mod, calls } = makePostgres()
    await assert.rejects(
      mod.executeSql({ ...conn, dbPort: 5432 }, {
        sql: 'UPDATE t SET a = $1', params: [1], readOnly: true
      }),
      /read-only mode/
    )
    assert.equal(calls.length, 0)
  })
})
