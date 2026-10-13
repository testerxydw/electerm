/**
 * redis connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: keyspace / type detail
 */

let client = null
// per-tab 引用计数：redis 单例被多个 tab 共享，最后一个 tab 关闭时才真正断开
let refCount = 0

async function getClient (conn) {
  if (client) {
    return client
  }
  const Redis = require('ioredis')
  client = new Redis({
    host: conn.dbHost,
    port: conn.dbPort,
    password: conn.dbPassword || undefined,
    connectTimeout: 8000,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
    enableOfflineQueue: false
  })
  client.on('error', () => {})
  return client
}

// openDbTab 时调用：计数 +1，首次建立真实连接并 ping 验证（失败上抛）
async function acquire (conn) {
  if (client) {
    refCount++
    return client
  }
  const Redis = require('ioredis')
  client = new Redis({
    host: conn.dbHost,
    port: conn.dbPort,
    password: conn.dbPassword || undefined,
    connectTimeout: 8000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
    enableOfflineQueue: false
  })
  client.on('error', () => {})
  refCount = 1
  await client.connect()
  await client.ping()
  return client
}

// closeDbTab 时调用：计数 -1，归零才 disconnect（redis 单例全局计数）
async function release () {
  refCount--
  if (refCount > 0) {
    return
  }
  refCount = 0
  if (client) {
    client.disconnect()
    client = null
  }
}

// per-request select (SCAN uses index numbers, TYPE etc need SELECT first)
let currentDb = -1
async function useDb (conn, dbIndex) {
  const c = await getClient(conn)
  const target = Number(dbIndex) || 0
  if (target !== currentDb) {
    await c.select(target)
    currentDb = target
  }
  return c
}

async function testRedisConnection (conn) {
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
  try {
    await c.connect()
    const res = await c.ping()
    return `redis ${res}`
  } finally {
    c.disconnect()
  }
}

// ---- Phase2 methods ----

async function getMetadata (conn) {
  const dbs = []
  for (let i = 0; i < 16; i++) {
    dbs.push({
      name: 'db' + i,
      type: 'database'
    })
  }
  return dbs
}

async function getPageData (conn, { dbIndex, match, page, pageSize }) {
  const c = await useDb(conn, dbIndex)
  const cursor = Math.max(0, ((Number(page) || 1) - 1) * pageSize)
  pageSize = Math.min(Number(pageSize) || 100, 1000)
  const [next, keys] = await c.scan(
    cursor,
    'MATCH',
    match || '*',
    'COUNT',
    pageSize
  )
  const items = []
  for (const k of keys) {
    const [type, ttl] = await Promise.all([
      c.type(k).catch(() => 'unknown'),
      c.ttl(k).catch(() => -1)
    ])
    items.push({ name: k, type, ttl })
  }
  return {
    rows: items,
    hasMore: (items.length >= pageSize) || (Number(next) !== 0)
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
  if (client) {
    client.disconnect()
    client = null
  }
  refCount = 0
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
