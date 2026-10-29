// H7b-1 Redis 慢日志后端：getRedisSlowlog（SLOWLOG GET + 条数上限）
//
// 这层薄，但错一处就是"看着正常其实拿错"：
//   · count=0 在 RESP 语义里是"取全部"，不是"取 0 条" —— 归一必须回落到默认 128，
//     否则一次误传就把整段慢日志拷回弹层
//   · SLOWLOG 被禁用/被副本拒绝时报错必须原样上抛 —— 吞成空数组等于把
//     "拿不到慢日志"伪装成"这个实例没有慢查询"，后者是个会被当成结论的假信号
//   · 与 INFO 同为实例级：不 select db（跟着当前库走会多一次往返和状态副作用）
//   · op 必须同时挂进 index.js 的 redis 方法表，漏一边前端就是 "unsupported op"
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// 与 db-redis-info.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { slowlog: [], select: [], info: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async info () {
      return ''
    },
    async slowlog (...a) {
      calls.slowlog.push(a)
      if (opts.slowlogThrows) throw new Error(opts.slowlogThrows)
      return opts.slowlog === undefined ? [] : opts.slowlog
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

// 真条目形状（Redis 7.2：id / 秒时间戳 / 微秒耗时 / 参数数组 / 客户端地址 / 客户端名）
const SAMPLE = [
  [12, 1730192000, 42130, ['SET', 'k', 'v'], '10.0.0.5:53212', 'cli-a'],
  [13, 1730192060, 120, ['GET', 'k'], '10.0.0.5:53212', '']
]

describe('H7b-1 getRedisSlowlog（后端）', () => {
  test('只发一发 SLOWLOG GET，不传 count 时用默认 128', async () => {
    const { mod, calls } = loadRedis({ slowlog: SAMPLE })
    const res = await mod.getRedisSlowlog(CONN, {})
    assert.deepEqual(res, SAMPLE, '原始条目数组原样回传，归一在渲染侧')
    assert.deepEqual(calls.slowlog, [['get', 128]])
  })

  test('count=0 不是"取 0 条"也不是"取全部"：回落到默认 128', async () => {
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN, { count: 0 })
    assert.deepEqual(calls.slowlog, [['get', 128]])
  })

  test('负数 / NaN / 空串 / null 都回落到默认，不抛也不发 0', async () => {
    for (const bad of [-5, 'abc', null, undefined, {}, NaN]) {
      const { mod, calls } = loadRedis()
      await mod.getRedisSlowlog(CONN, { count: bad })
      assert.deepEqual(calls.slowlog, [['get', 128]], `count=${String(bad)} 应回落默认`)
    }
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN)
    assert.deepEqual(calls.slowlog, [['get', 128]], '整个第二参数缺省')
  })

  test('count 夹到上限 512：小数向下取整', async () => {
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN, { count: 99999 })
    await mod.getRedisSlowlog(CONN, { count: '50.7' })
    assert.deepEqual(calls.slowlog, [['get', 512], ['get', 50]])
  })

  test('不 select db：慢日志是实例级信息', async () => {
    const { mod, calls } = loadRedis({ slowlog: SAMPLE })
    await mod.getRedisSlowlog(CONN, { count: 20 })
    assert.deepEqual(calls.select, [])
  })

  test('服务端禁用 SLOWLOG：报错原样上抛，不吞成空数组', async () => {
    const { mod } = loadRedis({ slowlogThrows: "ERR unknown command 'SLOWLOG'" })
    await assert.rejects(() => mod.getRedisSlowlog(CONN, {}), /unknown command 'SLOWLOG'/)
  })

  test('服务端回非数组（异常形状）时归一成空数组，不把 undefined 递给渲染侧', async () => {
    const { mod } = loadRedis({ slowlog: null })
    const res = await mod.getRedisSlowlog(CONN, {})
    // 不用 deepEqual：兜底的那个 [] 是在 vm 沙箱里 new 的，跨 realm 原型不同、结构相同
    assert.ok(Array.isArray(res) && res.length === 0, '应归一成空数组')
  })

  test('op 已挂进 redis 方法表（漏一边就是前端 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /getRedisSlowlog: 'getRedisSlowlog'/)
  })
})
