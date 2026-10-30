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
// B1：SSL/TLS 开关进签名 —— 同一 host:port 上切换 TLS 后必须拿到新 client，
// 否则旧 client（明文/TLS）会被继续复用，"改了不生效"
function sig (conn) {
  const sslTag = conn.dbSsl ? '|ssl=1' : '|ssl=0'
  return `${conn.dbHost}:${conn.dbPort}${sslTag}`
}

// B1：连接级 TLS 选项。ioredis 的 `tls` 原样透传给 node tls.connect，
// 内部自签证书场景用 rejectUnauthorized: false 跳过证书链校验
function tlsOptions (conn) {
  return conn.dbSsl ? { tls: { rejectUnauthorized: false } } : {}
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
    enableOfflineQueue: false,
    // B1：启用 TLS（rediss:// / TLS 端口）。测试连接与真实连接共用本函数，
    // 保证"测试通过"与实际连接参数一致
    ...tlsOptions(conn)
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
  try {
    await c.connect()
  } catch (e) {
    // 建连失败的 client 不进 clients 表，但它的 socket 与状态机已经建立：
    // 不主动 disconnect 就没人再持有它、也没人会关它
    c.disconnect()
    throw e
  }
  clients.set(key, c)
  return c
}

// acquire 失败回滚：refs 在 acquire 入口就 +1，而 openDbTab 只在 acquire **成功**
// 之后才置 acquired 标记、失败分支不会补 release —— 不回滚这次计数，失败一次就
// 永久多一个"看不见的引用"，同签名连接再也不会归零断开（连上后 ping 失败可复现）
function rollbackAcquire (key) {
  const n = (refs.get(key) || 0) - 1
  if (n > 0) {
    refs.set(key, n)
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

// openDbTab 时调用：计数 +1，首次建立真实连接并 ping 验证（失败上抛）
async function acquire (conn) {
  const key = sig(conn)
  refs.set(key, (refs.get(key) || 0) + 1)
  try {
    const c = await getClient(conn)
    await c.ping()
    return c
  } catch (e) {
    rollbackAcquire(key)
    throw e
  }
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
 * 服务器信息：一次全量 `INFO`（含 keyspace 段），只回原文。
 * 解析不放这里：`parseRedisInfo` 是纯函数，放渲染侧才能用 node:test 逐条钉死
 * （放主进程就得为一份字符串解析起一个假 RESP server）。
 * 不吞错也不降级：受管实例禁用 INFO 时把原始报错抛上去 —— 概览弹层宁可显示
 * "这个实例不允许 INFO"，也不能显示一张全是 0 的假概览（0 是合法值，分不清）。
 */
async function getRedisInfo (conn) {
  const c = await getClient(conn)
  return String(await c.info() || '')
}

// SLOWLOG GET 是一次性把整段日志拷回来，条数必须有上限：
// 慢日志阈值调低过的实例能攒到 server 端的上限 128 条以上（Redis 会截断到 slowlog-max-len），
// 但客户端传 count=0 在 RESP 语义里是"取全部"，所以 0/负数/NaN 一律回落到默认值。
const SLOWLOG_DEFAULT_COUNT = 128
const SLOWLOG_MAX_COUNT = 512

/**
 * 慢日志：`SLOWLOG GET count`，回服务端给的原始条目数组，归一放渲染侧纯函数
 * （条目形状跨 Redis 版本会变：7.4 起多了微秒时间戳，位置解析必须容错）。
 * 与 INFO 同为实例级：不 select db；SLOWLOG 被禁用/只读副本拒绝时原样抛错，
 * 吞成空数组就等于把"这个实例拿不到慢日志"伪装成"这个实例没有慢查询"。
 */
async function getRedisSlowlog (conn, { count } = {}) {
  const c = await getClient(conn)
  const n = clampSlowlogCount(count)
  const res = await c.slowlog('get', n)
  return Array.isArray(res) ? res : []
}

function clampSlowlogCount (count) {
  const n = Math.floor(Number(count))
  if (!Number.isFinite(n) || n <= 0) {
    return SLOWLOG_DEFAULT_COUNT
  }
  return Math.min(n, SLOWLOG_MAX_COUNT)
}

/**
 * SCAN 分页 —— 使用「游标」模型而非「页码」模型。
 * Redis 的 SCAN cursor 是不透明的哈希游标（不是 offset），
 * 用 (page-1)*pageSize 当游标会得到重复/遗漏的结果；
 * 因此这里回传 nextCursor 由前端推进，'0' 表示遍历结束。
 */
// 一次 pipeline 取回所有键的 type/ttl（原先每键 2 次往返）
async function buildKeyRows (c, keys) {
  const p = c.pipeline()
  for (const k of keys) {
    p.type(k)
    p.ttl(k)
  }
  const res = keys.length ? await p.exec() : []
  return keys.map((k, i) => {
    const t = res[i * 2]
    const ttl = res[i * 2 + 1]
    return {
      name: k,
      type: t && !t[0] ? t[1] : 'unknown',
      ttl: ttl && !ttl[0] ? ttl[1] : -1
    }
  })
}

// keysOnly：只要键名，跳过每键 TYPE + TTL 的 pipeline。
// 给"键树"这种上万键的全量遍历用 —— 树只需要名字就能分层，带上 type/ttl 会把
// 一次 SCAN 变成 2N 次命令，10k 键就是 20k 次往返。行仍是对象数组（{ name }），
// 前端两套消费方（列表表格 / 树）拿到的形状一致。
async function getPageData (conn, { dbIndex, match, cursor, pageSize, keysOnly }) {
  const c = await useDb(conn, dbIndex)
  const size = Math.min(Number(pageSize) || 100, 1000)
  const [next, keys] = await c.scan(
    String(cursor || '0'),
    'MATCH',
    match || '*',
    'COUNT',
    size
  )
  return {
    rows: keysOnly ? keys.map(k => ({ name: k })) : await buildKeyRows(c, keys),
    nextCursor: String(next),
    hasMore: String(next) !== '0'
  }
}

// 键列表任意跳页。SCAN 游标不透明（不是 offset），跳页只能从 cursor=0
// 前向步进 pageIndex 次（每次 = 一页，与 getPageData 单次 SCAN 的页定义一致）。
// 返回目标页 rows 与沿途每页的起始游标链：前端用它重建 prev 栈，
// 之后 prev/next 仍是顺序推进，不重复扫描。
// 页下标安全上限防极端跳页（如跳到百万页）把主进程卡死。
const KEY_JUMP_MAX_PAGES = 20000

async function scanKeysToPage (conn, { dbIndex, match, pageIndex, pageSize }) {
  const c = await useDb(conn, dbIndex)
  const size = Math.min(Number(pageSize) || 100, 1000)
  const pattern = match || '*'
  const target = Math.max(0, Math.min(Math.floor(Number(pageIndex) || 0), KEY_JUMP_MAX_PAGES))
  const cursors = []
  let cursor = '0'
  let lastKeys = null
  for (let i = 0; i < target; i++) {
    cursors.push(cursor)
    const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', size)
    lastKeys = keys || []
    cursor = String(next)
    if (cursor === '0') {
      // 目标页超出末页：夹到真实末页（返回上一轮扫到的键），
      // 与 MySQL 网格 goPage 的 min(p, totalPages) 同语义，避免页码显示末页却是空表
      return {
        rows: await buildKeyRows(c, lastKeys),
        nextCursor: '0',
        hasMore: false,
        cursors,
        pageIndex: cursors.length - 1
      }
    }
  }
  cursors.push(cursor)
  const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', size)
  return {
    rows: await buildKeyRows(c, keys),
    nextCursor: String(next),
    hasMore: String(next) !== '0',
    cursors,
    pageIndex: target
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

// XRANGE 的游标不是页码，而是"上一页最后一条之后"的 ID（闭区间起点）。
// 前端传回来的 ID 只做形状校验：认不出就退回第一页（'-'），
// 不把前端传来的任意字符串直接拼进命令参数。
const STREAM_ID_RE = /^(\d+)-(\d+)$/
const STREAM_SEQ_MAX = 18446744073709551615n

function streamRangeStart (cursor) {
  const s = String(cursor || '')
  return STREAM_ID_RE.test(s) ? s : '-'
}

// 下一页起点：XRANGE 是闭区间，最后一条必须推进一格（seq+1；seq 已满则 ms+1、seq 归 0），
// 原样传回会让每页的第一条重复上一页的末条。
// 不用 `(id` 开区间写法：那是 Redis 6.2 才有的语法，老实例直接报错。
function nextStreamStart (rows, size) {
  if (!Array.isArray(rows) || rows.length < size || !rows.length) {
    return '0'
  }
  const m = STREAM_ID_RE.exec(String(rows[rows.length - 1][0] || ''))
  if (!m) {
    return '0'
  }
  let ms = BigInt(m[1])
  let seq = BigInt(m[2])
  if (seq < STREAM_SEQ_MAX) {
    seq += 1n
  } else {
    ms += 1n
    seq = 0n
  }
  return `${ms}-${seq}`
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
  // stream 专用：XINFO 的原始结果（归一在渲染侧纯函数里做，与 INFO/慢日志同一口径）
  let streamInfo = null
  let streamGroups = null
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
    case 'stream': {
      // 元信息与条目是两条命令：XINFO 给长度/首末 ID/组数，XRANGE 给条目本体。
      // XINFO 被托管实例禁用时回 null（界面出「—」）而不是 0 —— 组数 0 是合法值，
      // 吞成 0 就分不清"没有消费组"和"拿不到组列表"。
      streamInfo = await c.xinfo('stream', key).catch(() => null)
      streamGroups = await c.xinfo('groups', key).catch(() => null)
      rows = await c.xrange(key, streamRangeStart(cursor), '+', 'COUNT', size)
      total = await c.xlen(key).catch(() => undefined)
      nextCursor = typeof total === 'number' && rows.length >= total
        ? '0'
        : nextStreamStart(rows, size)
      break
    }
    default:
      value = null
  }
  const ttl = await c.ttl(key).catch(() => -1)
  const detail = { type, value, fields, rows, ttl, nextCursor, total }
  if (type === 'stream') {
    detail.streamInfo = streamInfo
    detail.streamGroups = streamGroups
  }
  return detail
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

// 键数组归一：只收非空字符串，顺带去重。
// 不复用 normalizeItems（那里 String(x) 兜底）：`[null]` 被 String 成 "null" 就会删掉
// 一个名叫 null 的真键 —— 批量删除宁可报参数错，也不能猜用户想删哪个。
function normalizeKeys (fn, keys) {
  if (!Array.isArray(keys)) {
    throw new Error(`${fn} requires keys as an array`)
  }
  const uniq = new Set()
  for (const k of keys) {
    if (typeof k !== 'string' || !k) {
      throw new Error(`${fn} requires every key to be a non-empty string`)
    }
    uniq.add(k)
  }
  if (!uniq.size) {
    throw new Error(`${fn} requires at least one key`)
  }
  return [...uniq]
}

// 单次上限：渲染层按 500 分批是为了"进度可读"，这里 1000 是第二道闸 ——
// 一次误传整页/整树的键名不该变成一条几十万参数的命令（redis 单条命令也有长度上限）
const DEL_KEYS_MAX = 1000

/**
 * 批量删键：一条 UNLINK（不是 N 条 DEL，也不是一条超长 DEL）。
 * DEL 在超大 key（百万成员的 list/hash/zset）上是同步回收内存，会把 redis 的
 * 事件循环卡住几秒；UNLINK 只摘 keyspace 引用，内存交后台线程慢慢收。
 * 返回值是"实际删掉的键数"（不存在的键不计数），所以进度只能拿它累加，
 * 不能用"发出去几个"当已删除数。
 */
async function delKeys (conn, { dbIndex, keys, readOnly }) {
  checkWritable(readOnly)
  const list = normalizeKeys('delKeys', keys)
  if (list.length > DEL_KEYS_MAX) {
    throw new Error(`delKeys accepts at most ${DEL_KEYS_MAX} keys per call`)
  }
  const c = await useDb(conn, dbIndex)
  const res = await c.unlink(...list)
  return Number(res) || 0
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
  // H7a：服务器信息（全量 INFO 原文，解析在渲染侧纯函数）
  getRedisInfo,
  // H7b：慢日志（SLOWLOG GET 原始条目，归一在渲染侧纯函数）
  getRedisSlowlog,
  getKeyDetail,
  setKey,
  delKey,
  // H7b-3：批量删键（UNLINK，单次上限 1000，分批由渲染侧驱动）
  delKeys,
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
  // 键列表任意跳页（SCAN 从 0 前向步进 pageIndex 次）
  scanKeysToPage,
  // 纯函数导出仅供单测（HSCAN/SSCAN 游标循环）
  scanPage
}
