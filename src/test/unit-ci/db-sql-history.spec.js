const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-sql-history.js')

// S3-C SQL 执行历史（doc/设计-数据库阶段3-2026-10-22.md §2）：
// localStorage 环形 200 条、相邻去重、失败也记录、损坏 JSON 容错。
// vm 跑真实源码（strip ESM export），window.localStorage 用内存 mock 替换。

const makeStorage = () => {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  }
}

const loadFns = (storage) => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const ctx = { window: { localStorage: storage } }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.equal(typeof ctx.listSqlHistory, 'function', 'listSqlHistory missing')
  assert.equal(typeof ctx.appendSqlHistory, 'function', 'appendSqlHistory missing')
  assert.equal(typeof ctx.clearSqlHistory, 'function', 'clearSqlHistory missing')
  return ctx
}

const entry = (sql, extra = {}) => ({
  sql,
  dbType: 'mysql',
  dbHost: 'h1',
  dbName: 'db1',
  ok: true,
  ...extra
})

// vm realm 的数组原型与主 realm 不同，deepEqual 会误报
// "same structure but are not reference-equal"——统一 JSON 化后比较
const plain = v => JSON.parse(JSON.stringify(v))

describe('db-sql-history', () => {
  let storage
  let ctx

  beforeEach(() => {
    storage = makeStorage()
    ctx = loadFns(storage)
  })

  test('append 后 list 返回最新在前（时间倒序）', () => {
    ctx.appendSqlHistory(entry('SELECT 1'))
    ctx.appendSqlHistory(entry('SELECT 2'))
    const list = ctx.listSqlHistory()
    assert.equal(list.length, 2)
    assert.equal(list[0].sql, 'SELECT 2')
    assert.equal(list[1].sql, 'SELECT 1')
  })

  test('环形上限 200：超出丢最旧', () => {
    for (let i = 0; i < 205; i++) {
      ctx.appendSqlHistory(entry('SELECT ' + i))
    }
    const list = ctx.listSqlHistory()
    assert.equal(list.length, 200)
    assert.equal(list[0].sql, 'SELECT 204')
    assert.equal(list[199].sql, 'SELECT 5')
  })

  test('相邻重复不叠加，非相邻重复保留', () => {
    ctx.appendSqlHistory(entry('SELECT 1'))
    ctx.appendSqlHistory(entry('SELECT 1'))
    ctx.appendSqlHistory(entry('SELECT 2'))
    ctx.appendSqlHistory(entry('SELECT 1'))
    const list = ctx.listSqlHistory()
    assert.equal(list.length, 3)
    assert.deepEqual(plain(list.map(x => x.sql)), ['SELECT 1', 'SELECT 2', 'SELECT 1'])
  })

  test('失败语句也记录（ok:false）', () => {
    ctx.appendSqlHistory(entry('BAD SQL', { ok: false }))
    const list = ctx.listSqlHistory()
    assert.equal(list.length, 1)
    assert.equal(list[0].ok, false)
  })

  test('条目字段完整（sql/dbType/dbHost/dbName/ts/ok）', () => {
    ctx.appendSqlHistory(entry('SELECT 1'))
    const [item] = ctx.listSqlHistory()
    assert.equal(item.dbType, 'mysql')
    assert.equal(item.dbHost, 'h1')
    assert.equal(item.dbName, 'db1')
    assert.equal(typeof item.ts, 'number')
    assert.ok(item.ts > 0)
  })

  test('空 sql / 无 entry 不写入', () => {
    ctx.appendSqlHistory(null)
    ctx.appendSqlHistory({ sql: '' })
    assert.deepEqual(plain(ctx.listSqlHistory()), [])
  })

  test('损坏 JSON 容错：返回空列表且后续可写', () => {
    storage.setItem('electerm-db-sql-history', '{broken json')
    assert.deepEqual(plain(ctx.listSqlHistory()), [])
    ctx.appendSqlHistory(entry('SELECT 1'))
    assert.equal(ctx.listSqlHistory().length, 1)
  })

  test('非数组 JSON 容错', () => {
    storage.setItem('electerm-db-sql-history', '{"a":1}')
    assert.deepEqual(plain(ctx.listSqlHistory()), [])
  })

  test('clearSqlHistory 清空', () => {
    ctx.appendSqlHistory(entry('SELECT 1'))
    ctx.clearSqlHistory()
    assert.deepEqual(plain(ctx.listSqlHistory()), [])
  })

  test('无 localStorage（window 异常）静默降级不抛错', () => {
    const ctxNoLs = loadFns(undefined)
    ctxNoLs.appendSqlHistory(entry('SELECT 1'))
    assert.deepEqual(plain(ctxNoLs.listSqlHistory()), [])
    ctxNoLs.clearSqlHistory()
  })
})
