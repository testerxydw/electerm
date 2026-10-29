// H7a-4 Redis 服务器信息：后端 getRedisInfo + 渲染侧 INFO 解析
//
// 后端这一层薄到几乎没逻辑，但有三条一旦写错就静默坏掉的点，钉住：
//   · 只发一次全量 INFO（带 section 参数就要发两发；概览 + keyspace 同一次往返拿齐）
//   · INFO 被服务端禁用时报错必须原样上抛 —— 吞成空串，弹层就成了一张"全 0"的假概览
//     （0 在 INFO 里是合法值，用户分不清"真的是 0"还是"没拿到"）
//   · 不 select db：INFO 是实例级信息，跟着当前库走会莫名多一次往返与状态副作用
//
// 解析那半截钉的是"一个字符串里塞了十几个小节"的边界：值里带冒号、CRLF、空值、
// 缺小节、`*_human` 不是数字；还有两条"看着像数据其实是猜"的口径 ——
// 命中率分母为 0 或只拿到一半时给 null（0.00% 会被当成结论去查），
// keyspace 一行都没有时合计是 null（不是"这个实例 0 个键"）。
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

// ── 渲染侧解析（src/client/common/db-redis-info.js）──────────────────────
const load = () => import('../../client/common/db-redis-info.js')

// 真 Redis 7.2.6 的字段形状（节选）：值里带冒号、有空值、有 CRLF，全在这里喂进去
const REAL = [
  '# Server',
  'redis_version:7.2.6',
  'redis_mode:standalone',
  'os:Linux 6.18.48 x86_64',
  'executable_path:/usr/bin/redis-server',
  'config_file:',
  'uptime_in_seconds:1234567',
  '',
  '# Clients',
  'connected_clients:12',
  'blocked_clients:0',
  'maxclients:10000',
  '',
  '# Memory',
  'used_memory:1048576',
  'used_memory_human:1.05M',
  'used_memory_rss:2097152',
  'mem_fragmentation_ratio:2.00',
  'maxmemory:0',
  'maxmemory_policy:noeviction',
  '',
  '# Stats',
  'instantaneous_ops_per_sec:8',
  'total_commands_processed:100',
  'keyspace_hits:97',
  'keyspace_misses:3',
  'evicted_keys:0',
  'expired_keys:41',
  'rejected_connections:0',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:2',
  '',
  '# Keyspace',
  'db10:keys=3,expires=0,avg_ttl=0',
  'db2:keys=7,expires=1',
  'db0:keys=6,expires=0,avg_ttl=47537',
  ''
].join('\r\n')

describe('H7a-4 parseRedisInfo：原文 → 小节', () => {
  test('小节名归一化、键值按第一个冒号切（值里的冒号保留）', async () => {
    const { parseRedisInfo, infoString } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoString(p, 'server', 'redis_version'), '7.2.6')
    assert.equal(infoString(p, 'server', 'executable_path'), '/usr/bin/redis-server',
      '值里带冒号：只能在第一个冒号处切')
    assert.equal(infoString(p, 'replication', 'role'), 'master')
    assert.ok(p.sections.keyspace, '# Keyspace → keyspace')
    assert.ok(p.sections.stats, '# Stats → stats')
  })

  test('CRLF、空行、无冒号行、冒号在行首都不会把解析带歪', async () => {
    const { parseRedisInfo } = await load()
    const p = parseRedisInfo('# Server\r\n\r\nredis_version:1.2.3\nnot-a-pair\n:leading\nbroken')
    assert.deepEqual(p.sections, { server: { redis_version: '1.2.3' } })
  })

  test('小节头之前的散行不猜归属；空文本/undefined 出空小节不抛', async () => {
    const { parseRedisInfo } = await load()
    assert.deepEqual(parseRedisInfo('stray:1\n# Server\na:2').sections, { server: { a: '2' } })
    assert.deepEqual(parseRedisInfo('').sections, {})
    assert.deepEqual(parseRedisInfo(undefined).sections, {})
    assert.deepEqual(parseRedisInfo(null).sections, {})
  })

  test('同名键后写覆盖（INFO 里同小节重复行以最后一行为准）', async () => {
    const { parseRedisInfo, infoString } = await load()
    const p = parseRedisInfo('# Server\nredis_version:1\nredis_version:2')
    assert.equal(infoString(p, 'server', 'redis_version'), '2')
  })
})

describe('H7a-4 infoString / infoNumber：缺就是缺', () => {
  test('0 是合法值必须原样返回（判"有没有"只能用 null）', async () => {
    const { parseRedisInfo, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoNumber(p, 'clients', 'blocked_clients'), 0)
    assert.equal(infoNumber(p, 'memory', 'maxmemory'), 0,
      'maxmemory:0 = 没配上限，这个 0 是信息本身，不能当"没拿到"')
    assert.equal(infoNumber(p, 'stats', 'evicted_keys'), 0)
  })

  test('数字转换只认真数字：1.05M 这类 *_human 一律 null', async () => {
    const { parseRedisInfo, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoNumber(p, 'memory', 'used_memory'), 1048576)
    assert.equal(infoNumber(p, 'memory', 'used_memory_human'), null)
    assert.equal(infoNumber(p, 'memory', 'mem_fragmentation_ratio'), 2)
  })

  test('空值（config_file:）与缺小节、缺键都归成 null', async () => {
    const { parseRedisInfo, infoString, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoString(p, 'server', 'config_file'), null, '"没配"和"空"在界面上是同一件事')
    assert.equal(infoString(p, 'cluster', 'cluster_enabled'), null)
    assert.equal(infoNumber(p, 'nowhere', 'x'), null)
    assert.equal(infoString(parseRedisInfo(''), 'server', 'redis_version'), null)
  })
})

describe('H7a-4 keyspaceRows：db 统计', () => {
  test('按 db 序号排（db2 在 db10 前面），字段缺就 null', async () => {
    const { parseRedisInfo, keyspaceRows } = await load()
    const rows = keyspaceRows(parseRedisInfo(REAL))
    assert.deepEqual(rows.map(r => r.db), ['db0', 'db2', 'db10'])
    assert.deepEqual(rows[0], { db: 'db0', index: 0, keys: 6, expires: 0, avgTtlMs: 47537 })
    // db2 那行没有 avg_ttl：null 而不是 0（0 是"平均没有过期"，两回事）
    assert.equal(rows[1].avgTtlMs, null)
    assert.equal(rows[1].expires, 1)
  })

  test('非 dbN 行忽略；没有 keyspace 小节出空数组', async () => {
    const { parseRedisInfo, keyspaceRows } = await load()
    assert.deepEqual(keyspaceRows(parseRedisInfo('# Keyspace\ndbx:keys=1\nweird')), [])
    assert.deepEqual(keyspaceRows(parseRedisInfo('# Server\na:1')), [])
  })
})

describe('H7a-4 redisOverview：概览事实与命中率', () => {
  test('一次取全概览要的字段（含跨小节与派生合计）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo(REAL))
    assert.equal(o.version, '7.2.6')
    assert.equal(o.mode, 'standalone')
    assert.equal(o.uptimeSeconds, 1234567)
    assert.equal(o.connectedClients, 12)
    assert.equal(o.maxClients, 10000)
    assert.equal(o.role, 'master')
    assert.equal(o.connectedReplicas, 2)
    assert.equal(o.usedMemory, 1048576)
    assert.equal(o.maxMemory, 0)
    assert.equal(o.maxMemoryPolicy, 'noeviction')
    assert.equal(o.fragmentation, 2)
    assert.equal(o.instantaneousOpsPerSec, 8)
    assert.equal(o.expiredKeys, 41)
    assert.equal(o.evictedKeys, 0)
    assert.equal(o.totalKeys, 16, '6+7+3')
    assert.equal(o.totalExpires, 1)
  })

  test('命中率：97/(97+3) = 0.97', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    assert.equal(redisOverview(parseRedisInfo(REAL)).hitRate, 0.97)
  })

  test('一次查询都没有 → null，不是 0.00%（0% 命中率会被当成结论去查）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo('# Stats\nkeyspace_hits:0\nkeyspace_misses:0'))
    assert.equal(o.hitRate, null)
  })

  test('只拿到 hits 或只拿到 misses → null（不按 0 补另一半）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    assert.equal(redisOverview(parseRedisInfo('# Stats\nkeyspace_hits:97')).hitRate, null)
    assert.equal(redisOverview(parseRedisInfo('# Stats\nkeyspace_misses:3')).hitRate, null)
    assert.equal(redisOverview(parseRedisInfo('# Stats')).hitRate, null)
  })

  test('全空 INFO 出"一个字段都没有"的对象，不抛', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo(''))
    assert.equal(o.version, null)
    assert.equal(o.totalKeys, null, '没有任何 db 行时合计是"不知道"，不是 0 个键')
    assert.equal(o.usedMemory, null)
  })
})

describe('H7a-4 formatPercent', () => {
  test('两位小数、null 出 null（占位由界面给）', async () => {
    const { formatPercent } = await load()
    assert.equal(formatPercent(0.9708), '97.08%')
    assert.equal(formatPercent(1), '100.00%')
    assert.equal(formatPercent(0), '0.00%')
    assert.equal(formatPercent(0.5, 0), '50%')
    assert.equal(formatPercent(null), null)
    assert.equal(formatPercent(Number.NaN), null)
  })
})
