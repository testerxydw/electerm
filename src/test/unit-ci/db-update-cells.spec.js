/**
 * B3-2/B3-3 主进程层单测：mysql/postgres 适配器 updateCells 的真实源码行为。
 *
 * 用 vm 执行 src/app/lib/db-client/{mysql,postgres}.js，注入假的驱动模块
 * （mysql2/promise、pg），断言：
 * - 只读闸门（渲染层传参不可信，主进程权威拒绝）
 * - 行数上限 200（防误操作大范围 + IN/占位符过长）
 * - 快路径（同值）：一条 SET .. WHERE pk IN (..)，标识符引用安全
 * - 慢路径（散值）：mysql 逐行事务（START/COMMIT）；pg 逐行 query
 * - OP_MAP 在 mysql/postgres 登记 updateCells，redis 不登记
 *
 * 不依赖真库，但跑的是真实生产代码（非测试拷贝）。
 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { describe, test } from 'node:test'

const logStub = { debug () {}, warn () {}, error () {} }

function loadAdapter (filePath, fakeModules) {
  const src = fs.readFileSync(filePath, 'utf8')
  const mod = { exports: {} }
  const require = (name) => {
    if (Object.prototype.hasOwnProperty.call(fakeModules, name)) {
      return fakeModules[name]
    }
    throw new Error('unexpected require: ' + name)
  }
  const ctx = { module: mod, exports: mod.exports, require, console, setTimeout, clearTimeout }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return mod.exports
}

function makeMysql () {
  const calls = { execute: [], conn: [] }
  const pool = {
    execute (sql, params) {
      calls.execute.push({ sql, params })
      return Promise.resolve([{ affectedRows: params.length - 1 }])
    },
    getConnection () {
      const c = {
        query (sql) {
          calls.conn.push(sql)
          return Promise.resolve([{ affectedRows: 1 }])
        },
        release () {}
      }
      return Promise.resolve(c)
    }
  }
  return { fake: { '../../common/log': logStub, 'mysql2/promise': { createPool: () => pool } }, calls }
}

function makePg () {
  const calls = []
  class Client {
    constructor (o) { this.database = (o && o.database) || 'db' }
    connect () { return Promise.resolve() }
    query (sql, params) {
      calls.push({ sql, params })
      return Promise.resolve({ rowCount: 1 })
    }
  }
  return { fake: { pg: { Client } }, calls }
}

const CONN = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbName: 'db' }

describe('mysql.updateCells', () => {
  test('只读模式由主进程拒绝（渲染层传参不可信）', async () => {
    const { fake } = makeMysql()
    const m = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/mysql.js'), fake)
    await assert.rejects(
      m.updateCells(CONN, { database: 'db', table: 't', pkColumn: 'id', column: 'name', updates: [{ pk: 1, value: 'a' }], readOnly: true }),
      /read-only mode: cell update disabled/
    )
  })

  test('超过 200 行被拒', async () => {
    const { fake } = makeMysql()
    const m = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/mysql.js'), fake)
    const updates = Array.from({ length: 201 }, (_, i) => ({ pk: i, value: 'a' }))
    await assert.rejects(
      m.updateCells(CONN, { database: 'db', table: 't', pkColumn: 'id', column: 'name', updates, readOnly: false }),
      /supports up to 200/
    )
  })

  test('快路径（同值）：单条 SET .. WHERE pk IN (..)，标识符引用安全', async () => {
    const { fake, calls } = makeMysql()
    const m = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/mysql.js'), fake)
    const res = await m.updateCells(CONN, {
      database: 'db',
      table: 't',
      pkColumn: 'id',
      column: 'name',
      updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'a' }, { pk: 3, value: 'a' }],
      readOnly: false
    })
    assert.strictEqual(calls.execute.length, 1)
    assert.match(calls.execute[0].sql, /UPDATE `db`\.`t` SET `name` = \? WHERE `id` IN \(\?, \?, \?\)/)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.execute[0].params)), ['a', 1, 2, 3])
    assert.strictEqual(res.affected, 3)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(res.failed)), [])
  })

  test('慢路径（散值）：逐行事务，affected 逐行累加', async () => {
    const { fake, calls } = makeMysql()
    const m = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/mysql.js'), fake)
    const res = await m.updateCells(CONN, {
      database: 'db',
      table: 't',
      pkColumn: 'id',
      column: 'name',
      updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'b' }, { pk: 3, value: 'c' }],
      readOnly: false
    })
    // 每条一次 START TRANSACTION / UPDATE / COMMIT
    assert.ok(calls.conn.filter(s => /START TRANSACTION/.test(s)).length === 3)
    assert.ok(calls.conn.filter(s => /COMMIT/.test(s)).length === 3)
    const updates = calls.conn.filter(s => /UPDATE `db`\.`t` SET `name` = \? WHERE `id` = \?/.test(s))
    assert.strictEqual(updates.length, 3)
    assert.strictEqual(res.affected, 3)
  })
})

describe('postgres.updateCells', () => {
  test('只读模式由主进程拒绝', async () => {
    const { fake } = makePg()
    const p = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/postgres.js'), fake)
    await assert.rejects(
      p.updateCells(CONN, { database: 'db', schema: 'public', table: 't', pkColumn: 'id', column: 'name', updates: [{ pk: 1, value: 'a' }], readOnly: true }),
      /read-only mode: cell update disabled/
    )
  })

  test('快路径（同值）：单条带 $n 占位符 IN，标识符双引号引用', async () => {
    const { fake, calls } = makePg()
    const p = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/postgres.js'), fake)
    const res = await p.updateCells(CONN, {
      database: 'db',
      schema: 'public',
      table: 't',
      pkColumn: 'id',
      column: 'name',
      updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'a' }],
      readOnly: false
    })
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].sql, /UPDATE "public"\."t" SET "name" = \$1 WHERE "id" IN \(\$2, \$3\)/)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].params)), ['a', 1, 2])
    assert.strictEqual(res.failed.length, 0)
  })

  test('慢路径（散值）：逐行 query，失败行记录到 failed', async () => {
    const calls = []
    // 让第二个 UPDATE 抛错，验证失败行被收集、不影响其他行
    const fake2 = {
      pg: {
        Client: class {
          constructor (o) { this.database = (o && o.database) || 'db' }
          connect () { return Promise.resolve() }
          query (sql, params) {
            calls.push({ sql, params })
            if (params && params[1] === 2) {
              return Promise.reject(new Error('permission denied'))
            }
            return Promise.resolve({ rowCount: 1 })
          }
        }
      }
    }
    const p2 = loadAdapter(path.join(import.meta.dirname, '../../app/lib/db-client/postgres.js'), fake2)
    const res = await p2.updateCells(CONN, {
      database: 'db',
      schema: 'public',
      table: 't',
      pkColumn: 'id',
      column: 'name',
      updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'b' }, { pk: 3, value: 'c' }],
      readOnly: false
    })
    assert.strictEqual(res.affected, 2)
    assert.strictEqual(res.failed.length, 1)
    assert.strictEqual(res.failed[0].pk, 2)
  })
})

describe('OP_MAP 登记', () => {
  const idxSrc = fs.readFileSync(path.join(import.meta.dirname, '../../app/lib/db-client/index.js'), 'utf8')
  const mysqlBlock = idxSrc.slice(idxSrc.indexOf('mysql: {'), idxSrc.indexOf('postgres: {'))
  const postgresBlock = idxSrc.slice(idxSrc.indexOf('postgres: {'), idxSrc.indexOf('redis: {'))
  const redisBlock = idxSrc.slice(idxSrc.indexOf('redis: {'))

  test('mysql / postgres 各自登记 updateCells', () => {
    assert.match(mysqlBlock, /updateCells: 'updateCells'/)
    assert.match(postgresBlock, /updateCells: 'updateCells'/)
  })

  test('redis 不登记 updateCells（无行概念）', () => {
    assert.ok(!/updateCells/.test(redisBlock))
  })
})
