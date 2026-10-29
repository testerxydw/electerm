// H7a-4 Redis 服务器信息：后端 getRedisInfo（本文件另一半是渲染侧解析，见下）
//
// 后端这一层薄到几乎没逻辑，但有三条一旦写错就静默坏掉的点，钉住：
//   · 只发一次全量 INFO（带 section 参数就要发两发；概览 + keyspace 同一次往返拿齐）
//   · INFO 被服务端禁用时报错必须原样上抛 —— 吞成空串，弹层就成了一张"全 0"的假概览
//     （0 在 INFO 里是合法值，用户分不清"真的是 0"还是"没拿到"）
//   · 不 select db：INFO 是实例级信息，跟着当前库走会莫名多一次往返与状态副作用
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// 与 db-redis-keys-jump.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { info: [], select: [], scan: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async info (...a) {
      calls.info.push(a)
      if (opts.infoThrows) throw new Error(opts.infoThrows)
      return opts.info === undefined ? undefined : opts.info
    },
    async scan () {
      return ['0', []]
    },
    pipeline () {
      return { type () { return this }, ttl () { return this }, async exec () { return [] } }
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
      assert.equal(spec, 'ioredis', 'redis.js 多了新依赖，这个假沙箱得跟着补')
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

const SAMPLE = [
  '# Server',
  'redis_version:7.2.6',
  'os:Linux 6.18.48 x86_64',
  '',
  '# Keyspace',
  'db0:keys=6,expires=0,avg_ttl=0',
  'db1:keys=20,expires=5,avg_ttl=47537',
  ''
].join('\r\n')

describe('H7a-4 getRedisInfo（后端）', () => {
  test('原样回传 INFO 文本：后端不解析、不裁剪', async () => {
    const { mod, calls } = loadRedis({ info: SAMPLE })
    const text = await mod.getRedisInfo(CONN)
    assert.equal(text, SAMPLE)
    assert.equal(calls.info.length, 1, '只发一次 INFO')
    assert.deepEqual(calls.info[0], [], '全量 INFO：不带 section 参数（概览 + keyspace 一发拿齐）')
  })

  test('不 select db：INFO 是实例级信息', async () => {
    const { mod, calls } = loadRedis({ info: SAMPLE })
    await mod.getRedisInfo(CONN)
    assert.deepEqual(calls.select, [])
  })

  test('服务端禁用 INFO：报错原样上抛，不吞成空串', async () => {
    const { mod } = loadRedis({ infoThrows: 'ERR unknown command INFO' })
    await assert.rejects(() => mod.getRedisInfo(CONN), /unknown command INFO/)
  })

  test('INFO 回空（undefined）时归一成空串，不把 undefined 递给渲染侧', async () => {
    const { mod } = loadRedis({ info: undefined })
    assert.equal(await mod.getRedisInfo(CONN), '')
  })

  test('op 已挂进 redis 方法表（漏一边就是前端 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /getRedisInfo: 'getRedisInfo'/)
  })
})
