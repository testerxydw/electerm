/**
 * redis connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: keyspace / type detail
 *
 * 连接管理：按「连接签名」隔离（与 mysql/postgres 对齐）——
 * 不同 redis 书签各自持有独立 client，避免多 tab 共用同一连接导致串库。
 */

// sig → ioredis client
const clients = new Map()
// sig → per-tab 引用计数：同签名连接被多个 tab 共享，最后一个 tab 关闭时才真正断开
const refs = new Map()
// sig → 当前 SELECT 到的 db index（按连接记录，避免多连接互相干扰）
const currentDbMap = new Map()

// 签名不含密码，避免密码出现在日志/调试信息中（与 mysql/postgres 一致）
function sig (conn) {
  return `${conn.dbHost}:${conn.dbPort}`
}

function createClient (conn) {
  const Redis = require('ioredis')
  const c = new Redis({
    host: conn.dbHost,
    port: conn.dbPort,
    password: conn.dbPassword || undefined,
    connectTimeout: 8000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
    enableOfflineQueue: false
  })
  c.on('error', () => {})
  return c
}

async function getClient (conn) {
  const key = sig(conn)
  if (clients.has(key)) {
    return clients.get(key)
  }
  const c = createClient(conn)
  await c.connect()
  clients.set(key, c)
  return c
}

// openDbTab 时调用：计数 +1，首次建立真实连接并 ping 验证（失败上抛）
async function acquire (conn) {
  const key = sig(conn)
  refs.set(key, (refs.get(key) || 0) + 1)
  const c = await getClient(conn)
  await c.ping()
  return c
}

// closeDbTab 时调用：计数 -1，归零才 disconnect
async function release (conn) {
  const key = sig(conn)
  const n = (refs.get(key) || 0) - 1
  refs.set(key, n)
  if (n > 0) {
    return
  }
  refs.delete(key)
  currentDbMap.delete(key)
  const c = clients.get(key)
  if (c) {
    clients.delete(key)
    c.disconnect()
  }
}

// per-request select（SCAN / TYPE 等都在当前 db 上执行）
async function useDb (conn, dbIndex) {
  const key = sig(conn)
  const c = await getClient(conn)
  const target = Number(dbIndex) || 0
  if (currentDbMap.get(key) !== target) {
    await c.select(target)
    currentDbMap.set(key, target)
  }
  return c
}

async function testRedisConnection (conn) {
  const c = createClient(conn)
  try {
    await c.connect()
    const res = await c.ping()
    return `redis ${res}`
  } finally {
    c.disconnect()
  }
}

// ---- Phase2 methods ----

// 键个数统计：INFO keyspace 一次往返即返回所有「非空」db 的键数（空 db 不出现 → 计 0）。
// 受管 Redis（部分云实例）可能禁用 INFO → 返回 null，此时前端不显示计数（好过错误地显示 0）。
async function getKeyCounts (conn) {
  const c = await getClient(conn)
  let info
  try {
    info = await c.info('keyspace')
  } catch (e) {
    return null
  }
  const counts = {}
  for (const line of String(info || '').split(/\r?\n/)) {
    const m = /^db(\d+):keys=(\d+)/.exec(line.trim())
    if (m) {
      counts[Number(m[1])] = Number(m[2])
    }
  }
  return counts
}

/**
 * Redis 的「数据库」是 db0..dbN（默认 16 个，由 CONFIG databases 决定）。
 * 除默认 16 个外，再从 keyspace 探测是否出现更大的序号（有些实例调大了 databases）。
 */
async function getMetadata (conn) {
  const counts = await getKeyCounts(conn)
  let maxIdx = 15
  if (counts) {
    for (const k of Object.keys(counts)) {
      maxIdx = Math.max(maxIdx, Number(k))
    }
  }
  const dbs = []
  for (let i = 0; i <= maxIdx; i++) {
    const db = {
      name: 'db' + i,
      type: 'database'
    }
    if (counts) {
      db.count = counts[i] || 0
    }
    dbs.push(db)
  }
  return dbs
}

/**
 * SCAN 分页 —— 使用「游标」模型而非「页码」模型。
 * Redis 的 SCAN cursor 是不透明的哈希游标（不是 offset），
 * 用 (page-1)*pageSize 当游标会得到重复/遗漏的结果；
 * 因此这里回传 nextCursor 由前端推进，'0' 表示遍历结束。
 */
async function getPageData (conn, { dbIndex, match, cursor, pageSize }) {
  const c = await useDb(conn, dbIndex)
  const size = Math.min(Number(pageSize) || 100, 1000)
  const [next, keys] = await c.scan(
    String(cursor || '0'),
    'MATCH',
    match || '*',
    'COUNT',
    size
  )
  // 一次 pipeline 取回所有键的 type/ttl（原先每键 2 次往返）
  const p = c.pipeline()
  for (const k of keys) {
    p.type(k)
    p.ttl(k)
  }
  const res = keys.length ? await p.exec() : []
  const items = keys.map((k, i) => {
    const t = res[i * 2]
    const ttl = res[i * 2 + 1]
    return {
      name: k,
      type: t && !t[0] ? t[1] : 'unknown',
      ttl: ttl && !ttl[0] ? ttl[1] : -1
    }
  })
  return {
    rows: items,
    nextCursor: String(next),
    hasMore: String(next) !== '0'
  }
}

async function getKeyDetail (conn, { dbIndex, key }) {
  const c = await useDb(conn, dbIndex)
  const type = await c.type(key)
  let value = null
  let fields = []
  let rows = []
  switch (type) {
    case 'string':
      value = await c.get(key)
      break
    case 'hash':
      rows = await c.hgetall(key)
      fields = Object.keys(rows)
      break
    case 'list':
      rows = await c.lrange(key, 0, 1000)
      break
    case 'set':
      rows = await c.smembers(key)
      break
    case 'zset':
      rows = await c.zrange(key, 0, 1000, 'WITHSCORES')
      break
    default:
      value = null
  }
  const ttl = await c.ttl(key).catch(() => -1)
  return { type, value, fields, rows, ttl }
}

function checkWritable (readOnly) {
  if (readOnly) {
    throw new Error('read-only mode: key modification disabled')
  }
}

async function delKey (conn, { dbIndex, key, readOnly }) {
  checkWritable(readOnly)
  const c = await useDb(conn, dbIndex)
  return c.del(key)
}

async function expireKey (conn, { dbIndex, key, seconds, readOnly }) {
  checkWritable(readOnly)
  const c = await useDb(conn, dbIndex)
  const s = Number(seconds)
  if (s <= 0) {
    return c.persist(key)
  }
  return c.expire(key, s)
}

// 无参全清（app 退出兜底）
async function closeRedisConnection () {
  for (const c of clients.values()) {
    c.disconnect()
  }
  clients.clear()
  refs.clear()
  currentDbMap.clear()
}

module.exports = {
  testRedisConnection,
  acquire,
  release,
  getMetadata,
  getPageData,
  getKeyDetail,
  delKey,
  expireKey,
  closeRedisConnection
}
