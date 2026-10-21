// 批次 D：Redis hash/set 详情服务端游标分页
//  - hash 走 HSCAN、set 走 SSCAN，不再 hgetall/smembers 全量加载
//  - 返回 { fields, rows, nextCursor, total }；游标可继续翻页
//  - list/zset/string 行为不变
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')

function loadRedis (opts = {}) {
  const calls = { hscan: [], sscan: [], lrange: [], zrange: [], hlen: 0, scard: 0 }
  const queues = {
    hscan: [...(opts.hscan || [])],
    sscan: [...(opts.sscan || [])]
  }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select () {},
    async type () {
      return opts.type || 'hash'
    },
    async hscan (key, cursor, ...args) {
      calls.hscan.push({ key, cursor, args })
      return queues.hscan.shift() || ['0', []]
    },
    async sscan (key, cursor, ...args) {
      calls.sscan.push({ key, cursor, args })
      return queues.sscan.shift() || ['0', []]
    },
    async hlen () {
      calls.hlen++
      return opts.hlen || 0
    },
    async scard () {
      calls.scard++
      return opts.scard || 0
    },
    async get () {
      return 'v'
    },
    async lrange (...args) {
      calls.lrange.push(args)
      return opts.list || []
    },
    async zrange (...args) {
      calls.zrange.push(args)
      return opts.zset || []
    },
    async ttl () {
      return -1
    }
  }
  const Redis = function () {
    return inst
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.equal(spec, 'ioredis')
      return Redis
    },
    console,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(REDIS_JS, 'utf8'), sandbox, { filename: 'redis.js' })
  return { mod: mod.exports, calls }
}

const CONN = { dbHost: 'h', dbPort: 6379 }

describe('批次 D：Redis 详情分页（后端）', () => {
  test('hash 首页走 HSCAN，返回字段/值/游标/总数', async () => {
    const { mod, calls } = loadRedis({
      type: 'hash',
      hscan: [['17', ['a', '1', 'b', '2']]],
      hlen: 5
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'h', cursor: '0', pageSize: 2 })
    assert.equal(calls.hscan[0].cursor, '0')
    assert.deepEqual([...calls.hscan[0].args], ['COUNT', 2])
    assert.deepEqual([...res.fields], ['a', 'b'])
    assert.deepEqual({ ...res.rows }, { a: '1', b: '2' })
    assert.equal(res.nextCursor, '17')
    assert.equal(res.total, 5)
    assert.equal(calls.hlen, 1)
  })

  test('hash 下一页从传入游标继续', async () => {
    const { mod, calls } = loadRedis({
      type: 'hash',
      hscan: [['0', ['c', '3']]],
      hlen: 3
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'h', cursor: '17', pageSize: 2 })
    assert.equal(calls.hscan[0].cursor, '17')
    assert.deepEqual([...res.fields], ['c'])
    assert.equal(res.nextCursor, '0')
  })

  test('HSCAN 单次不足一页时循环补满（最多 10 轮）', async () => {
    const { mod, calls } = loadRedis({
      type: 'hash',
      hscan: [['9', ['a', '1']], ['0', ['b', '2']]],
      hlen: 2
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'h', pageSize: 2 })
    assert.equal(calls.hscan.length, 2)
    assert.deepEqual([...res.fields], ['a', 'b'])
    assert.equal(res.nextCursor, '0')
  })

  test('set 首页走 SSCAN，返回成员/游标/总数', async () => {
    const { mod, calls } = loadRedis({
      type: 'set',
      sscan: [['5', ['x', 'y']]],
      scard: 10
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 's', pageSize: 2 })
    assert.deepEqual([...res.rows], ['x', 'y'])
    assert.equal(res.nextCursor, '5')
    assert.equal(res.total, 10)
    assert.equal(calls.scard, 1)
  })

  test('pageSize 默认 200、上限 1000', async () => {
    const a = loadRedis({ type: 'hash', hscan: [['0', []]] })
    await a.mod.getKeyDetail(CONN, { dbIndex: 0, key: 'h' })
    assert.deepEqual([...a.calls.hscan[0].args], ['COUNT', 200])

    const b = loadRedis({ type: 'set', sscan: [['0', []]] })
    await b.mod.getKeyDetail(CONN, { dbIndex: 0, key: 's', pageSize: 5000 })
    assert.deepEqual([...b.calls.sscan[0].args], ['COUNT', 1000])
  })

  test('list/zset/string 行为不变（nextCursor 0）', async () => {
    const list = loadRedis({ type: 'list', list: ['a'] })
    const lr = await list.mod.getKeyDetail(CONN, { dbIndex: 0, key: 'l' })
    assert.deepEqual([...lr.rows], ['a'])
    assert.equal(lr.nextCursor, '0')
    assert.deepEqual([...list.calls.lrange[0]].slice(1), [0, 1000])

    const zset = loadRedis({ type: 'zset', zset: ['m', '1'] })
    const zr = await zset.mod.getKeyDetail(CONN, { dbIndex: 0, key: 'z' })
    assert.deepEqual([...zr.rows], ['m', '1'])
    assert.equal(zr.nextCursor, '0')
  })
})

describe('批次 D：Redis 详情分页（前端接线）', () => {
  const src = fs.readFileSync(JSX, 'utf8')

  test('请求带游标与页大小，加载更多按游标追加', () => {
    assert.ok(src.includes('cursor: String(cursor || \'0\')'), 'cursor must be sent')
    assert.ok(src.includes('pageSize: REDIS_DETAIL_PAGE'), 'page size must be sent')
    assert.ok(src.includes('selectRedisKey(redisKey, d.nextCursor, true)'), 'next page wiring missing')
    assert.ok(src.includes('...(prev.fields'), 'hash fields must be appended')
    assert.ok(src.includes('...(prev.rows'), 'rows must be appended')
  })

  test('hash/set 不再按 detailLimit 客户端切片', () => {
    assert.ok(src.includes('const hashFields = d.fields || []'), 'hash still client-sliced')
    assert.ok(src.includes('const setRows = d.rows || []'), 'set still client-sliced')
  })

  test('后端不再全量 hgetall / smembers', () => {
    const redis = fs.readFileSync(REDIS_JS, 'utf8')
    assert.ok(!redis.includes('hgetall('), 'hgetall must be removed')
    assert.ok(!redis.includes('smembers('), 'smembers must be removed')
    assert.ok(redis.includes('hscan('), 'HSCAN missing')
    assert.ok(redis.includes('sscan('), 'SSCAN missing')
  })
})
