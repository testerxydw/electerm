/**
 * F2 事务安全带：适配器层真实源码行为（vm 注入假驱动，不打真库）
 *
 * - mysql beginTx 从池取专用连接 + START TRANSACTION；commit/rollback 后归还池
 * - mysql 钉住期间把单条连接包装成"单连接池"：getConnection 可用、release 空操作
 *   （真实 PoolConnection 没有 getConnection，且 release 会把钉住的连接提前还池）
 * - pg 事务用独立 Client（不进共享池），commit/rollback 后 end 关闭
 * - 提交失败销毁连接；回滚失败不上抛
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { describe, test } = require('node:test')

const ROOT = path.join(__dirname, '../../..')
const MYSQL = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const PG = path.join(ROOT, 'src/app/lib/db-client/postgres.js')

const logStub = { debug () {}, warn () {}, info () {}, error () {} }

function loadAdapter (file, fakeModules) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: name => {
      if (Object.prototype.hasOwnProperty.call(fakeModules, name)) {
        return fakeModules[name]
      }
      throw new Error('unexpected require: ' + name)
    },
    console,
    setTimeout,
    clearTimeout,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
  return mod.exports
}

// 假 mysql2 池：记录每条专用连接上跑过的 SQL 与 release/destroy
function makeMysql (opts = {}) {
  const state = { poolQuery: [], conns: [] }
  const pool = {
    query: (sql) => Promise.resolve([[{ ok: 1 }], []]),
    execute: (sql) => Promise.resolve([{ affectedRows: 1 }]),
    getConnection () {
      const c = {
        sqls: [],
        released: 0,
        destroyed: 0,
        query (sql) {
          c.sqls.push(sql)
          if (opts.failOn && sql.startsWith(opts.failOn)) {
            return Promise.reject(new Error('boom ' + sql))
          }
          return Promise.resolve([[{ ok: 1 }], []])
        },
        release () { c.released++ },
        destroy () { c.destroyed++ }
      }
      state.conns.push(c)
      return Promise.resolve(c)
    },
    end () { return Promise.resolve() }
  }
  return {
    state,
    mod: loadAdapter(MYSQL, {
      '../../common/log': logStub,
      'mysql2/promise': { createPool: () => pool }
    })
  }
}

const conn = {
  dbHost: 'h', dbPort: 3306, dbUser: 'u', dbName: 'db', dbPassword: 'p'
}

describe('F2 适配器：mysql 事务连接', () => {
  test('beginTx 从池取专用连接并 START TRANSACTION', async () => {
    const { state, mod } = makeMysql()
    const c = await mod.beginTx(conn)
    assert.equal(state.conns.length, 1)
    assert.deepEqual(c.sqls, ['START TRANSACTION'])
    assert.equal(c, state.conns[0])
  })

  test('commitTx 提交后归还池；提交失败销毁连接并上抛', async () => {
    const ok = makeMysql()
    const c = await ok.mod.beginTx(conn)
    await ok.mod.commitTx(c)
    assert.deepEqual(c.sqls, ['START TRANSACTION', 'COMMIT'])
    assert.equal(c.released, 1)
    assert.equal(c.destroyed, 0)

    const bad = makeMysql({ failOn: 'COMMIT' })
    const c2 = await bad.mod.beginTx(conn)
    await assert.rejects(bad.mod.commitTx(c2), /boom COMMIT/)
    assert.equal(c2.destroyed, 1, 'dead connection must be destroyed, not returned to pool')
    assert.equal(c2.released, 0)
  })

  test('rollbackTx 回滚后归还池；回滚失败销毁连接且不上抛', async () => {
    const ok = makeMysql()
    const c = await ok.mod.beginTx(conn)
    await ok.mod.rollbackTx(c)
    assert.deepEqual(c.sqls, ['START TRANSACTION', 'ROLLBACK'])
    assert.equal(c.released, 1)

    const bad = makeMysql({ failOn: 'ROLLBACK' })
    const c2 = await bad.mod.beginTx(conn)
    await bad.mod.rollbackTx(c2)
    assert.equal(c2.destroyed, 1)
  })

  test('钉住连接被包装成单连接池：executeSql 走该连接且 release 是空操作', async () => {
    const { state, mod } = makeMysql()
    const pinned = await mod.beginTx(conn)
    pinned.sqls.length = 0

    const res = await mod.executeSql(
      { ...conn, __txClient: pinned },
      { sql: 'UPDATE t SET a = 1', database: 'db', readOnly: false }
    )
    assert.ok(Array.isArray(res.results), 'executeSql result shape kept')
    assert.deepEqual(pinned.sqls, ['USE `db`', 'UPDATE t SET a = 1'])
    assert.equal(pinned.released, 0, 'pinned connection must not be released by ops')
    assert.equal(state.conns.length, 1, 'no extra connection taken from pool')
  })

  test('未钉住时 executeSql 仍从池取连接并正常归还', async () => {
    const { state, mod } = makeMysql()
    await mod.executeSql(conn, { sql: 'SELECT 1', readOnly: false })
    assert.equal(state.conns.length, 1)
    assert.equal(state.conns[0].released, 1)
  })
})

describe('F2 适配器：postgres 事务连接', () => {
  function makePg (opts = {}) {
    const created = []
    class Client {
      constructor (o) {
        this.opts = o
        this.sqls = []
        this.ended = 0
        created.push(this)
      }

      connect () { return Promise.resolve() }

      query (sql) {
        this.sqls.push(sql)
        if (opts.failOn && sql.startsWith(opts.failOn)) {
          return Promise.reject(new Error('boom ' + sql))
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      }

      end () {
        this.ended++
        return Promise.resolve()
      }
    }
    return {
      created,
      mod: loadAdapter(PG, { pg: { Client } })
    }
  }

  const pgConn = {
    dbHost: 'h', dbPort: 5432, dbUser: 'u', dbName: 'db', dbPassword: 'p'
  }

  test('beginTx 用独立 Client（不进共享池）并 BEGIN', async () => {
    const { created, mod } = makePg()
    const c = await mod.beginTx(pgConn)
    assert.equal(created.length, 1)
    assert.deepEqual(c.sqls, ['BEGIN'])
    // 共享连接仍是另一条：getPageData 只建一条、beginTx 又建一条
    await mod.getPageData(pgConn, { table: 't', pageSize: 1 })
    assert.equal(created.length, 2, 'shared client must not be reused as tx client')
  })

  test('commitTx / rollbackTx 结束事务并关闭连接', async () => {
    const a = makePg()
    const c1 = await a.mod.beginTx(pgConn)
    await a.mod.commitTx(c1)
    assert.deepEqual(c1.sqls, ['BEGIN', 'COMMIT'])
    assert.equal(c1.ended, 1)

    const b = makePg()
    const c2 = await b.mod.beginTx(pgConn)
    await b.mod.rollbackTx(c2)
    assert.deepEqual(c2.sqls, ['BEGIN', 'ROLLBACK'])
    assert.equal(c2.ended, 1)
  })

  test('回滚失败也不上抛，连接照样关闭', async () => {
    const bad = makePg({ failOn: 'ROLLBACK' })
    const c = await bad.mod.beginTx(pgConn)
    await bad.mod.rollbackTx(c)
    assert.equal(c.ended, 1)
  })
})
