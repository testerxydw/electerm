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

// hash/set 详情分页：HSCAN/SSCAN 的 COUNT 只是提示，可能一次返回少于 pageSize，
// 这里循环到凑满一页或游标结束（最多 10 轮，避免异常实例下长时间占用）
const DETAIL_PAGE_DEFAULT = 200
const DETAIL_PAGE_MAX = 1000
const DETAIL_SCAN_MAX_ROUNDS = 10
// string 详情预览软上限（字节）：超过只回传截断预览，防 IPC 克隆内存翻倍
const MAX_STRING_PREVIEW_BYTES = 256 * 1024

async function scanPage (scan, pageSize, startCursor) {
  let cursor = String(startCursor || '0')
  let items = []
  for (let i = 0; i < DETAIL_SCAN_MAX_ROUNDS; i++) {
    const [next, list] = await scan(cursor)
    items = items.concat(list || [])
    cursor = String(next)
    if (cursor === '0' || items.length >= pageSize) {
      break
    }
  }
  return { cursor, items }
}

async function getKeyDetail (conn, { dbIndex, key, cursor, pageSize }) {
  const c = await useDb(conn, dbIndex)
  const type = await c.type(key)
  const size = Math.min(Number(pageSize) || DETAIL_PAGE_DEFAULT, DETAIL_PAGE_MAX)
  let value = null
  const fields = []
  // string 截断标记走 fields=['truncated']（total 复用为完整字节数），
  // hash/set 的 fields/total 语义不变
  let rows = []
  let nextCursor = '0'
  let total
  switch (type) {
    case 'string': {
      // 大 string 软上限：超过 256KB 只回传预览（防 IPC 结构化克隆内存翻倍），
      // truncated=true 时前端禁用编辑，防止截断值覆盖写回真实键（数据损坏）
      const raw = await c.get(key)
      if (typeof raw === 'string' && Buffer.byteLength(raw) > MAX_STRING_PREVIEW_BYTES) {
        value = Buffer.from(raw, 'utf8').subarray(0, MAX_STRING_PREVIEW_BYTES).toString('utf8')
        total = Buffer.byteLength(raw)
        fields.push('truncated')
      } else {
        value = raw
      }
      break
    }
    case 'hash': {
      // 大 hash 不再 hgetall 全量加载，按 HSCAN 游标分页
      // HSCAN 返回 field/value 成对元素：目标元素数是 pageSize × 2
      const page = await scanPage(
        cur => c.hscan(key, cur, 'COUNT', size),
        size * 2,
        cursor
      )
      nextCursor = page.cursor
      rows = {}
      for (let i = 0; i < page.items.length; i += 2) {
        const field = page.items[i]
        fields.push(field)
        rows[field] = page.items[i + 1]
      }
      total = await c.hlen(key)
      break
    }
    case 'list':
      rows = await c.lrange(key, 0, 1000)
      break
    case 'set': {
      // 大 set 不再 smembers 全量加载，按 SSCAN 游标分页
      const page = await scanPage(
        cur => c.sscan(key, cur, 'COUNT', size),
        size,
        cursor
      )
      nextCursor = page.cursor
      rows = page.items
      total = await c.scard(key)
      break
    }
    case 'zset':
      rows = await c.zrange(key, 0, 1000, 'WITHSCORES')
      break
    default:
      value = null
  }
  const ttl = await c.ttl(key).catch(() => -1)
  return { type, value, fields, rows, ttl, nextCursor, total }
}

function checkWritable (readOnly) {
  if (readOnly) {
    throw new Error('read-only mode: key modification disabled')
  }
}

// string 值编辑（值预览面板保存）：整键覆盖 SET
async function setKey (conn, { dbIndex, key, value, readOnly }) {
  checkWritable(readOnly)
  const c = await useDb(conn, dbIndex)
  return c.set(key, value)
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

// -------------------------------------------------- D 批：Redis 类型化写（T12） ----
// 范围严格按设计 §12.2（总览 §3.3 T12）：hash HSET/HDEL、set SADD/SREM、
// zset ZADD/ZREM、list LPUSH/RPUSH/LSET/LREM、key RENAMENX（string SET/TTL/DEL 为既有）。
// **不做**：FLUSHDB/FLUSHALL、KEYS、通用命令、二进制写。
// 全部 checkWritable 前置（与 setKey/delKey/expireKey 同一口径），
// readOnly 以主进程实例为权威（dbClientOp 注入），渲染层传参不可信。

// 键名必须是非空字符串（空 key 会让 redis 报错，提前给出可读信息且不发请求）
function requireKey (fn, key) {
  if (typeof key !== 'string' || !key) {
    throw new Error(`${fn} requires a non-empty key`)
  }
}

// members/fields 归一：非空字符串或非空字符串数组；
// 空数组直接抛参数错误（不发 redis），空串元素过滤后为空同样拒绝
function normalizeItems (fn, label, items) {
  if (typeof items === 'string') {
    if (!items) {
      throw new Error(`${fn} requires a non-empty ${label}`)
    }
    return [items]
  }
  if (Array.isArray(items)) {
    const list = items.map(x => String(x)).filter(x => x.length)
    if (!list.length) {
      throw new Error(`${fn} requires at least one non-empty ${label}`)
    }
    return list
  }
  throw new Error(`${fn} requires ${label} as string or array of strings`)
}

// 值归一：redis 只存字符串；undefined/null 存空串（与 setKey 透传语义保持宽松一致）
function toStr (v) {
  return v === undefined || v === null ? '' : String(v)
}

// hash 写字段：HSET
async function hashSetField (conn, { dbIndex, key, field, value, readOnly }) {
  checkWritable(readOnly)
  requireKey('hashSetField', key)
  if (typeof field !== 'string' || !field) {
    throw new Error('hashSetField requires a non-empty field')
  }
  const c = await useDb(conn, dbIndex)
  return c.hset(key, field, toStr(value))
}

// hash 删字段：HDEL（fields 支持数组）
async function hashDelField (conn, { dbIndex, key, fields, readOnly }) {
  checkWritable(readOnly)
  requireKey('hashDelField', key)
  const list = normalizeItems('hashDelField', 'fields', fields)
  const c = await useDb(conn, dbIndex)
  return c.hdel(key, ...list)
}

// set 加成员：SADD
async function setAdd (conn, { dbIndex, key, members, readOnly }) {
  checkWritable(readOnly)
  requireKey('setAdd', key)
  const list = normalizeItems('setAdd', 'members', members)
  const c = await useDb(conn, dbIndex)
  return c.sadd(key, ...list)
}

// set 删成员：SREM
async function setRem (conn, { dbIndex, key, members, readOnly }) {
  checkWritable(readOnly)
  requireKey('setRem', key)
  const list = normalizeItems('setRem', 'members', members)
  const c = await useDb(conn, dbIndex)
  return c.srem(key, ...list)
}

// zset 加成员：ZADD（score 必须有限数）
async function zsetAdd (conn, { dbIndex, key, score, member, readOnly }) {
  checkWritable(readOnly)
  requireKey('zsetAdd', key)
  const s = Number(score)
  if (!Number.isFinite(s)) {
    throw new Error('zsetAdd requires a finite numeric score')
  }
  if (typeof member !== 'string' || !member) {
    throw new Error('zsetAdd requires a non-empty member')
  }
  const c = await useDb(conn, dbIndex)
  return c.zadd(key, s, member)
}

// zset 删成员：ZREM
async function zsetRem (conn, { dbIndex, key, members, readOnly }) {
  checkWritable(readOnly)
  requireKey('zsetRem', key)
  const list = normalizeItems('zsetRem', 'members', members)
  const c = await useDb(conn, dbIndex)
  return c.zrem(key, ...list)
}

// list 推入：LPUSH / RPUSH（position: 'left' | 'right'）
async function listPush (conn, { dbIndex, key, value, position, readOnly }) {
  checkWritable(readOnly)
  requireKey('listPush', key)
  if (position !== 'left' && position !== 'right') {
    throw new Error('listPush requires position left or right')
  }
  const c = await useDb(conn, dbIndex)
  const v = toStr(value)
  if (position === 'left') {
    return c.lpush(key, v)
  }
  return c.rpush(key, v)
}

// list 按下标设置：LSET（index 越界 ioredis 抛错，让它冒泡）
async function listSetAt (conn, { dbIndex, key, index, value, readOnly }) {
  checkWritable(readOnly)
  requireKey('listSetAt', key)
  const idx = Number(index)
  if (!Number.isInteger(idx)) {
    throw new Error('listSetAt requires an integer index')
  }
  const c = await useDb(conn, dbIndex)
  return c.lset(key, idx, toStr(value))
}

// list 删元素：LREM（count: >0 头→尾删 count 个；<0 尾→头；0 删全部；默认 1）
async function listRemAt (conn, { dbIndex, key, index, count = 1, readOnly }) {
  checkWritable(readOnly)
  requireKey('listRemAt', key)
  const n = Number(count)
  if (!Number.isInteger(n)) {
    throw new Error('listRemAt requires an integer count')
  }
  const c = await useDb(conn, dbIndex)
  return c.lrem(key, n, toStr(index))
}

// key 重命名（不覆盖）：RENAMENX —— 目标已存在返回 0，
// 这里抛含 newKey 的可读错误而不是返回裸 0（前端据 message 提示）
async function renameKeyNx (conn, { dbIndex, key, newKey, readOnly }) {
  checkWritable(readOnly)
  requireKey('renameKeyNx', key)
  if (typeof newKey !== 'string' || !newKey) {
    throw new Error('renameKeyNx requires a non-empty newKey')
  }
  const c = await useDb(conn, dbIndex)
  const res = await c.renamenx(key, newKey)
  if (Number(res) !== 1) {
    throw new Error(`renamenx failed: target key already exists: ${newKey}`)
  }
  return { ok: true }
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
  setKey,
  delKey,
  expireKey,
  // D 批类型化写（T12）：全部 checkWritable 前置
  hashSetField,
  hashDelField,
  setAdd,
  setRem,
  zsetAdd,
  zsetRem,
  listPush,
  listSetAt,
  listRemAt,
  renameKeyNx,
  closeRedisConnection,
  // 纯函数导出仅供单测（HSCAN/SSCAN 游标循环）
  scanPage
}
