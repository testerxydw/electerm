#!/usr/bin/env node
/**
 * 最小 RESP2 服务端 —— Redis 面板 CDP 验收用的「可控替身」。
 *
 * 本机没有 redis-server / docker，而 N11b 的 Redis 链路（use-db-redis-keys 的
 * 32→5 形参收拢、use-db-redis-browse 的状态搬迁）只有让 **真的 ioredis** 连上来
 * 才验得到。这里不做协议子集猜测：命令按 `src/app/lib/db-client/redis.js`
 * 实际会发的那些逐个实现（连接握手 PING/CLIENT SETINFO/INFO、键列表 SCAN、
 * 每键 TYPE+TTL 的 pipeline、详情 GET/LRANGE/SSCAN/HSCAN/ZRANGE、INFO、
 * SLOWLOG GET，以及写路径 SELECT/UNLINK/EXPIRE）。遇到没实现的命令回
 * `-ERR unknown command`，并记进 `stats().unknown` —— 方便按实测补，而不是
 * 让客户端把「没有返回」当成空结果。
 *
 * 两种用法：
 *   1) node self-test/fake-redis.js 6390        # 独立跑，每收到一条命令打一行
 *   2) const { startFakeRedis } = require('./fake-redis')
 *      const srv = await startFakeRedis(6390)   # 同进程内跑，可用 srv.stats()
 *
 * 夹具（每次启动重建，幂等）：
 *   db0 = 60 个 smoke:key:000..059（string，其中 005/006 带 TTL）
 *       + smoke:a:hash（3 字段）+ smoke:a:list（3 项）
 *       + smoke:a:set（3 成员）+ smoke:a:zset（3 成员带 score）
 *   db1..15 为空 —— 用于验证 SELECT 确实切库、且切回 db0 键列表不串。
 *
 * SCAN 的游标用「排序后键集合的下标」充当。真实 Redis 的 cursor 是不透明哈希值，
 * 但协议上允许任意字符串；use-db-redis-keys 只把它当不透明游标推进/回退，
 * 所以下标实现能覆盖「顺序翻页 / 跳页 / 末页不满页」这三条真实判据。
 */
const net = require('node:net')

const DEFAULT_PORT = 6390
const DB_COUNT = 16

// 一次握手/一次键列表刷新里能出现的命令都在这张表里；不在表里就回错误并记账
const KNOWN = new Set([
  // ioredis 6 默认先发 HELLO 3 尝试 RESP3；我们只做 RESP2，按老 Redis 的语义
  // 回 NOPROTO，客户端会自动降级（不是 unknown command，别记进「缺口」清单）
  'HELLO',
  'PING', 'AUTH', 'SELECT', 'CLIENT', 'CONFIG', 'INFO', 'DBSIZE',
  'SCAN', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'GET', 'SET', 'STRLEN',
  'DEL', 'UNLINK', 'EXPIRE', 'PERSIST', 'KEYS',
  'LLEN', 'LRANGE', 'LPUSH', 'RPUSH', 'LSET', 'LREM',
  'SMEMBERS', 'SCARD', 'SSCAN', 'SADD', 'SREM',
  'HGETALL', 'HLEN', 'HSCAN', 'HSET', 'HDEL',
  'ZRANGE', 'ZCARD', 'ZADD', 'ZREM',
  'SLOWLOG', 'QUIT'
])

const pad3 = n => String(n).padStart(3, '0')

// glob（SCAN MATCH）→ 正则。只处理 Redis glob 的常用子集：* ? [...] \
function globToRe (pattern) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '\\' && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end > i) {
        re += '[' + pattern.slice(i + 1, end) + ']'
        i = end
      } else {
        re += '\\['
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$')
}

class RespError extends Error {
  constructor (msg) {
    super(msg)
    this.name = 'RespError'
  }
}

// 值编码：number → :N，null → nil bulk，数组 → 递归 array，其余 → bulk string
function enc (v) {
  if (v instanceof RespError) {
    return '-' + v.message.replace(/[\r\n]/g, ' ') + '\r\n'
  }
  if (v === null || v === undefined) {
    return '$-1\r\n'
  }
  if (typeof v === 'number') {
    return ':' + v + '\r\n'
  }
  if (Array.isArray(v)) {
    return '*' + v.length + '\r\n' + v.map(enc).join('')
  }
  const s = String(v)
  return '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n'
}

function createStore () {
  const dbs = Array.from({ length: DB_COUNT }, () => new Map())
  // 过期时间按库存：`${db}\u0000${key}` → 绝对毫秒
  const expires = new Map()
  const expKey = (db, key) => db + '\u0000' + key

  const purge = (db, key) => {
    const e = expires.get(expKey(db, key))
    if (e !== undefined && e <= Date.now()) {
      expires.delete(expKey(db, key))
      dbs[db].delete(key)
      return true
    }
    return false
  }

  const purgeDb = db => {
    for (const key of [...dbs[db].keys()]) {
      purge(db, key)
    }
  }

  const alive = (db, key) => {
    purge(db, key)
    return dbs[db].get(key)
  }

  return {
    db: i => dbs[i],
    alive,
    purgeDb,
    keys: db => {
      purgeDb(db)
      return [...dbs[db].keys()].sort()
    },
    get ttlMap () {
      return expires
    },
    setTtl (db, key, ms) {
      expires.set(expKey(db, key), Date.now() + ms)
    },
    clearTtl (db, key) {
      return expires.delete(expKey(db, key))
    },
    ttlOf (db, key) {
      purge(db, key)
      if (!dbs[db].has(key)) {
        return -2
      }
      const e = expires.get(expKey(db, key))
      if (e === undefined) {
        return -1
      }
      return Math.max(0, Math.ceil((e - Date.now()) / 1000))
    },
    expireCount (db) {
      purgeDb(db)
      let n = 0
      for (const key of dbs[db].keys()) {
        if (expires.has(expKey(db, key))) {
          n++
        }
      }
      return n
    },
    del (db, key) {
      purge(db, key)
      expires.delete(expKey(db, key))
      return dbs[db].delete(key) ? 1 : 0
    }
  }
}

function seed (store) {
  const db0 = store.db(0)
  db0.clear()
  for (let i = 0; i < 60; i++) {
    db0.set(`smoke:key:${pad3(i)}`, { type: 'string', value: `value:${pad3(i)}` })
  }
  // 两个带 TTL 的键：INFO 的 expires 计数与键列表 TTL 列都要有真实来源
  store.setTtl(0, 'smoke:key:005', 3600 * 1000)
  store.setTtl(0, 'smoke:key:006', 600 * 1000)
  db0.set('smoke:a:hash', {
    type: 'hash',
    value: new Map([['f1', 'v1'], ['f2', 'v2'], ['f3', 'v3']])
  })
  db0.set('smoke:a:list', { type: 'list', value: ['l1', 'l2', 'l3'] })
  db0.set('smoke:a:set', { type: 'set', value: new Set(['m1', 'm2', 'm3']) })
  db0.set('smoke:a:zset', {
    type: 'zset',
    value: [['m1', 1], ['m2', 2], ['m3', 3]]
  })
}

function infoText (store, section) {
  const sec = String(section || '').toLowerCase()
  const keyspace = []
  for (let i = 0; i < DB_COUNT; i++) {
    store.purgeDb(i)
    const n = store.db(i).size
    if (n > 0) {
      keyspace.push(`db${i}:keys=${n},expires=${store.expireCount(i)},avg_ttl=0`)
    }
  }
  const parts = {}
  parts.server = [
    '# Server',
    'redis_version:7.2.6',
    'redis_git_sha1:00000000',
    'redis_mode:standalone',
    'os:Linux 6.1.0 x86_64 (fake-redis)',
    'arch_bits:64',
    'process_id:4242',
    'uptime_in_seconds:259200',
    'uptime_in_days:3',
    'loading:0'
  ]
  parts.clients = [
    '# Clients',
    'connected_clients:1',
    'blocked_clients:0',
    'maxclients:10000'
  ]
  parts.memory = [
    '# Memory',
    'used_memory:1048576',
    'used_memory_human:1.00M',
    'used_memory_rss:2097152',
    'maxmemory:0',
    'maxmemory_human:0B',
    'maxmemory_policy:noeviction',
    'mem_fragmentation_ratio:1.25'
  ]
  parts.stats = [
    '# Stats',
    'total_connections_received:7',
    'instantaneous_ops_per_sec:3',
    'keyspace_hits:970',
    'keyspace_misses:30',
    'evicted_keys:0',
    'expired_keys:0',
    'rejected_connections:0'
  ]
  parts.replication = [
    '# Replication',
    'role:master',
    'connected_slaves:0'
  ]
  parts.keyspace = ['# Keyspace', ...keyspace]
  if (sec && parts[sec]) {
    return parts[sec].join('\r\n') + '\r\n'
  }
  return [].concat(
    parts.server, [''],
    parts.clients, [''],
    parts.memory, [''],
    parts.stats, [''],
    parts.replication, [''],
    parts.keyspace
  ).join('\r\n') + '\r\n'
}

const SLOWLOG_ENTRIES = [
  [1, 1730192000, 42130, ['SET', 'user:1', 'x'.repeat(80)], '10.0.0.5:53212', 'cli-a'],
  [2, 1730192060, 1500000, ['KEYS', '*'], '10.0.0.5:53212', ''],
  [3, 1730192090, 421, ['GET', 'smoke:key:000'], '127.0.0.1:50000', 'app']
]

function makeStats () {
  return {
    commands: [],
    unknown: [],
    // 写路径对账：实际收到哪些键、被删掉几个
    unlinkKeys: [],
    delKeys: [],
    expireCalls: [],
    infoCalls: [],
    slowlogCalls: [],
    scanCalls: []
  }
}

// 命令分派。ctx = { store, stats, session, onQuit }
function handle (args, ctx) {
  const name = String(args[0] || '').toUpperCase()
  const a = args.slice(1)
  const { store, stats, session } = ctx
  const db = session.db
  const str = i => String(a[i] === undefined ? '' : a[i])

  switch (name) {
    case 'HELLO':
      // RESP2-only 服务端：真实的 Redis 5 也这么回，ioredis 据此降级到 RESP2
      throw new RespError('NOPROTO unsupported protocol version')
    case 'PING':
      return a.length ? str(0) : 'PONG'
    case 'AUTH':
      return 'OK'
    case 'SELECT': {
      const idx = Number(a[0])
      if (!Number.isInteger(idx) || idx < 0 || idx >= DB_COUNT) {
        throw new RespError('ERR DB index is out of range')
      }
      session.db = idx
      return 'OK'
    }
    case 'CLIENT':
      // SETINFO/SETNAME/GETNAME 都走这里；GETNAME 回空串更接近真实（无名字）
      return String(a[0] || '').toUpperCase() === 'GETNAME' ? '' : 'OK'
    case 'CONFIG': {
      if (String(a[0] || '').toUpperCase() === 'GET') {
        const pattern = str(1) || '*'
        const re = globToRe(pattern)
        const all = { databases: String(DB_COUNT), maxmemory: '0' }
        const out = []
        for (const [k, v] of Object.entries(all)) {
          if (re.test(k)) {
            out.push(k, v)
          }
        }
        return out
      }
      return 'OK'
    }
    case 'INFO': {
      stats.infoCalls.push(a[0] || '')
      return infoText(store, a[0])
    }
    case 'DBSIZE':
      store.purgeDb(db)
      return store.db(db).size
    case 'SCAN': {
      const cursor = Math.max(0, parseInt(str(0), 10) || 0)
      let match = '*'
      let count = 10
      for (let i = 1; i < a.length; i += 2) {
        const k = String(a[i] || '').toUpperCase()
        if (k === 'MATCH') {
          match = String(a[i + 1] === undefined ? '*' : a[i + 1])
        } else if (k === 'COUNT') {
          count = Math.max(1, Number(a[i + 1]) || 10)
        }
      }
      const re = globToRe(match)
      const all = store.keys(db).filter(k => re.test(k))
      const slice = all.slice(cursor, cursor + count)
      const next = cursor + count < all.length ? String(cursor + count) : '0'
      stats.scanCalls.push({ cursor: String(cursor), match, count, next, n: slice.length })
      return [next, slice]
    }
    case 'TYPE': {
      const rec = store.alive(db, str(0))
      return rec ? rec.type : 'none'
    }
    case 'TTL':
      return store.ttlOf(db, str(0))
    case 'PTTL': {
      const t = store.ttlOf(db, str(0))
      return t < 0 ? t : t * 1000
    }
    case 'EXISTS':
      return a.reduce((n, k) => n + (store.alive(db, String(k)) ? 1 : 0), 0)
    case 'GET': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'string' ? rec.value : null
    }
    case 'SET': {
      store.db(db).set(str(0), { type: 'string', value: str(1) })
      store.clearTtl(db, str(0))
      return 'OK'
    }
    case 'STRLEN': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'string' ? rec.value.length : 0
    }
    case 'DEL':
    case 'UNLINK': {
      let n = 0
      const removed = []
      for (const k of a) {
        const key = String(k)
        if (store.del(db, key)) {
          n++
          removed.push(key)
        }
      }
      if (name === 'UNLINK') {
        stats.unlinkKeys.push(...removed)
      } else {
        stats.delKeys.push(...removed)
      }
      return n
    }
    case 'EXPIRE': {
      const key = str(0)
      const sec = Number(a[1])
      stats.expireCalls.push({ db, key, seconds: sec })
      if (!store.alive(db, key)) {
        return 0
      }
      if (!Number.isFinite(sec) || sec <= 0) {
        store.clearTtl(db, key)
        return 1
      }
      store.setTtl(db, key, sec * 1000)
      return 1
    }
    case 'PERSIST': {
      const key = str(0)
      if (!store.alive(db, key)) {
        return 0
      }
      return store.clearTtl(db, key) ? 1 : 0
    }
    case 'KEYS': {
      const re = globToRe(str(0) || '*')
      return store.keys(db).filter(k => re.test(k))
    }
    case 'LLEN': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'list' ? rec.value.length : 0
    }
    case 'LRANGE': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'list') {
        return []
      }
      const len = rec.value.length
      let start = Number(a[1])
      let stop = Number(a[2])
      start = start < 0 ? Math.max(0, len + start) : start
      stop = stop < 0 ? len + stop : stop
      if (!Number.isFinite(start) || start >= len) {
        return []
      }
      return rec.value.slice(start, Math.min(stop + 1, len))
    }
    case 'LPUSH':
    case 'RPUSH': {
      const key = str(0)
      let rec = store.alive(db, key)
      if (!rec) {
        rec = { type: 'list', value: [] }
        store.db(db).set(key, rec)
      }
      if (rec.type !== 'list') {
        throw new RespError('WRONGTYPE Operation against a key holding the wrong kind of value')
      }
      const vals = a.slice(1).map(String)
      if (name === 'LPUSH') {
        for (const v of vals) {
          rec.value.unshift(v)
        }
      } else {
        rec.value.push(...vals)
      }
      return rec.value.length
    }
    case 'LSET': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'list') {
        throw new RespError('ERR no such key')
      }
      let idx = Number(a[1])
      if (idx < 0) {
        idx = rec.value.length + idx
      }
      if (idx < 0 || idx >= rec.value.length) {
        throw new RespError('ERR index out of range')
      }
      rec.value[idx] = str(2)
      return 'OK'
    }
    case 'LREM': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'list') {
        return 0
      }
      const count = Number(a[1]) || 0
      const target = str(2)
      let removed = 0
      if (count >= 0) {
        // count=0 表示删全部；用 while + 显式 limit，避免 lint 把 removed 当成循环不变量
        const limit = count === 0 ? Infinity : count
        let i = 0
        while (i < rec.value.length && removed < limit) {
          if (rec.value[i] === target) {
            rec.value.splice(i, 1)
            removed++
          } else {
            i++
          }
        }
      } else {
        let i = rec.value.length - 1
        while (i >= 0 && removed < -count) {
          if (rec.value[i] === target) {
            rec.value.splice(i, 1)
            removed++
          }
          i--
        }
      }
      return removed
    }
    case 'SMEMBERS': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'set' ? [...rec.value] : []
    }
    case 'SCARD': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'set' ? rec.value.size : 0
    }
    case 'SSCAN': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'set') {
        return ['0', []]
      }
      const cursor = Math.max(0, parseInt(str(1), 10) || 0)
      let count = 10
      for (let i = 2; i < a.length; i += 2) {
        if (String(a[i] || '').toUpperCase() === 'COUNT') {
          count = Math.max(1, Number(a[i + 1]) || 10)
        }
      }
      const all = [...rec.value]
      const slice = all.slice(cursor, cursor + count)
      return [cursor + count < all.length ? String(cursor + count) : '0', slice]
    }
    case 'SADD': {
      const key = str(0)
      let rec = store.alive(db, key)
      if (!rec) {
        rec = { type: 'set', value: new Set() }
        store.db(db).set(key, rec)
      }
      if (rec.type !== 'set') {
        throw new RespError('WRONGTYPE Operation against a key holding the wrong kind of value')
      }
      let n = 0
      for (const m of a.slice(1)) {
        const v = String(m)
        if (!rec.value.has(v)) {
          rec.value.add(v)
          n++
        }
      }
      return n
    }
    case 'SREM': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'set') {
        return 0
      }
      let n = 0
      for (const m of a.slice(1)) {
        if (rec.value.delete(String(m))) {
          n++
        }
      }
      return n
    }
    case 'HGETALL': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'hash') {
        return []
      }
      return [...rec.value.entries()].flat()
    }
    case 'HLEN': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'hash' ? rec.value.size : 0
    }
    case 'HSCAN': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'hash') {
        return ['0', []]
      }
      const cursor = Math.max(0, parseInt(str(1), 10) || 0)
      let count = 10
      for (let i = 2; i < a.length; i += 2) {
        if (String(a[i] || '').toUpperCase() === 'COUNT') {
          count = Math.max(1, Number(a[i + 1]) || 10)
        }
      }
      const all = [...rec.value.entries()].flat()
      const slice = all.slice(cursor, cursor + count * 2)
      return [cursor + count * 2 < all.length ? String(cursor + count * 2) : '0', slice]
    }
    case 'HSET': {
      const key = str(0)
      let rec = store.alive(db, key)
      if (!rec) {
        rec = { type: 'hash', value: new Map() }
        store.db(db).set(key, rec)
      }
      if (rec.type !== 'hash') {
        throw new RespError('WRONGTYPE Operation against a key holding the wrong kind of value')
      }
      let n = 0
      for (let i = 1; i + 1 < a.length; i += 2) {
        const f = String(a[i])
        if (!rec.value.has(f)) {
          n++
        }
        rec.value.set(f, String(a[i + 1]))
      }
      return n
    }
    case 'HDEL': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'hash') {
        return 0
      }
      let n = 0
      for (const f of a.slice(1)) {
        if (rec.value.delete(String(f))) {
          n++
        }
      }
      return n
    }
    case 'ZRANGE': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'zset') {
        return []
      }
      const sorted = [...rec.value].sort((x, y) => x[1] - y[1])
      const len = sorted.length
      let start = Number(a[1])
      let stop = Number(a[2])
      start = start < 0 ? Math.max(0, len + start) : start
      stop = stop < 0 ? len + stop : stop
      if (!Number.isFinite(start) || start >= len) {
        return []
      }
      const slice = sorted.slice(start, Math.min(stop + 1, len))
      const withScores = a.some(x => String(x).toUpperCase() === 'WITHSCORES')
      return withScores
        ? slice.flatMap(([m, s]) => [m, String(s)])
        : slice.map(([m]) => m)
    }
    case 'ZCARD': {
      const rec = store.alive(db, str(0))
      return rec && rec.type === 'zset' ? rec.value.length : 0
    }
    case 'ZADD': {
      const key = str(0)
      let rec = store.alive(db, key)
      if (!rec) {
        rec = { type: 'zset', value: [] }
        store.db(db).set(key, rec)
      }
      if (rec.type !== 'zset') {
        throw new RespError('WRONGTYPE Operation against a key holding the wrong kind of value')
      }
      let n = 0
      for (let i = 1; i + 1 < a.length; i += 2) {
        const score = Number(a[i])
        const member = String(a[i + 1])
        const hit = rec.value.find(x => x[0] === member)
        if (hit) {
          hit[1] = score
        } else {
          rec.value.push([member, score])
          n++
        }
      }
      return n
    }
    case 'ZREM': {
      const rec = store.alive(db, str(0))
      if (!rec || rec.type !== 'zset') {
        return 0
      }
      let n = 0
      for (const m of a.slice(1)) {
        const i = rec.value.findIndex(x => x[0] === String(m))
        if (i >= 0) {
          rec.value.splice(i, 1)
          n++
        }
      }
      return n
    }
    case 'SLOWLOG': {
      const sub = String(a[0] || '').toUpperCase()
      if (sub === 'GET') {
        const n = Number(a[1])
        stats.slowlogCalls.push({ sub: 'GET', count: a[1] === undefined ? null : n })
        // count 缺省/0 = 取全部（真实 Redis 语义）
        const limit = Number.isFinite(n) && n > 0 ? n : SLOWLOG_ENTRIES.length
        return SLOWLOG_ENTRIES.slice(0, limit)
      }
      if (sub === 'LEN') {
        return SLOWLOG_ENTRIES.length
      }
      if (sub === 'RESET') {
        return 'OK'
      }
      return 'OK'
    }
    case 'QUIT':
      return { quit: true }
    default:
      throw new RespError(`ERR unknown command '${String(args[0] || '')}'`)
  }
}

// 单连接：RESP 数组 + inline 两种解析；同一连接内串行分派
function attach (sock, ctx, opts) {
  let buf = Buffer.alloc(0)

  const write = v => {
    if (v && v.quit) {
      sock.write('+OK\r\n')
      sock.end()
      return
    }
    sock.write(enc(v))
  }

  const respond = args => {
    const name = String(args[0] || '')
    const up = name.toUpperCase()
    ctx.stats.commands.push({ cmd: up, args: args.slice(1).map(String) })
    if (opts.log) {
      console.log('[fake-redis] ' + up + ' ' + args.slice(1).map(String).join(' ').slice(0, 160))
    }
    if (!KNOWN.has(up)) {
      ctx.stats.unknown.push({ cmd: up, args: args.slice(1).map(String) })
    }
    let out
    try {
      out = handle(args.map(String), ctx)
    } catch (e) {
      out = e instanceof RespError ? e : new RespError('ERR ' + (e && e.message ? e.message : e))
    }
    write(out)
  }

  const parse = () => {
    for (;;) {
      if (!buf.length) {
        return
      }
      if (buf[0] !== 0x2a) {
        const eol = buf.indexOf('\r\n')
        if (eol < 0) {
          return
        }
        const line = buf.subarray(0, eol).toString()
        buf = buf.subarray(eol + 2)
        if (line.trim()) {
          respond(line.trim().split(/\s+/))
        }
        continue
      }
      const eol = buf.indexOf('\r\n', 1)
      if (eol < 0) {
        return
      }
      const n = Number(buf.subarray(1, eol).toString())
      let pos = eol + 2
      const args = []
      let complete = true
      for (let i = 0; i < n; i++) {
        if (buf.length <= pos || buf[pos] !== 0x24) {
          complete = false
          break
        }
        const le = buf.indexOf('\r\n', pos + 1)
        if (le < 0) {
          complete = false
          break
        }
        const len = Number(buf.subarray(pos + 1, le).toString())
        if (buf.length < le + 2 + len + 2) {
          complete = false
          break
        }
        args.push(buf.subarray(le + 2, le + 2 + len).toString())
        pos = le + 2 + len + 2
      }
      if (!complete) {
        return
      }
      buf = buf.subarray(pos)
      if (args.length) {
        respond(args)
      }
    }
  }

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    parse()
  })
  sock.on('error', () => {})
}

/**
 * 启动假 Redis。默认 6390（与 sqlite 冒烟的 9385 调试端口错开，不冲突）。
 * @param {number} port
 * @param {{log?: boolean}} [opts]
 */
function startFakeRedis (port = DEFAULT_PORT, opts = {}) {
  const store = createStore()
  seed(store)
  const stats = makeStats()
  const server = net.createServer(sock => {
    attach(sock, { store, stats, session: { db: 0 } }, opts)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        server,
        store,
        stats: () => stats,
        keyNames: (db = 0) => store.keys(db),
        ttlOf: (key, db = 0) => store.ttlOf(db, key),
        count: (db = 0) => {
          store.purgeDb(db)
          return store.db(db).size
        },
        close: () => new Promise(resolve => {
          // 已建立的连接会让 server.close 一直等：脚本收尾时主动断开，
          // 否则冒烟进程会挂在 "waiting for connections to close"
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections()
          }
          server.close(() => resolve())
          server.unref()
        })
      })
    })
  })
}

module.exports = {
  startFakeRedis,
  DEFAULT_PORT,
  // 单测/其它自测脚本可直接复用夹具
  createStore,
  seed,
  handle
}

if (require.main === module) {
  const port = Number(process.argv[2]) || DEFAULT_PORT
  startFakeRedis(port, { log: true }).then(srv => {
    console.log(`[fake-redis] RESP2 listening on 127.0.0.1:${srv.port}`)
    console.log(`[fake-redis] db0 keys=${srv.count(0)} (60 string + 1 hash/list/set/zset)`)
    const bye = () => {
      console.log('[fake-redis] commands:', srv.stats().commands.length,
        'unknown:', JSON.stringify(srv.stats().unknown.slice(0, 10)))
      srv.close().then(() => process.exit(0))
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
  }).catch(e => {
    console.error(e)
    process.exit(1)
  })
}
