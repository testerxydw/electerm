/**
 * redis connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: keyspace / type detail
 *
 * 连接管理：按「连接签名」隔离（与 mysql/postgres 对齐）——
 * 不同 redis 书签各自持有独立 client，避免多 tab 共用同一连接导致串库。
 */

// sig → ioredis client
const clients = new Map()

// N1：TLS 档位（校验模式）的唯一口径，与 mysql/postgres 同一份实现
const { resolveTlsProfile, tlsSigTag } = require('./db-tls')
// N5a：受限命令控制台的执行层（策略在 redis-command-policy.js，本模块只注入 useDb）
const redisConsole = require('./redis-console')
// sig → per-tab 引用计数：同签名连接被多个 tab 共享，最后一个 tab 关闭时才真正断开
const refs = new Map()
// sig → 当前 SELECT 到的 db index（按连接记录，避免多连接互相干扰）
const currentDbMap = new Map()

// 签名不含密码，避免密码出现在日志/调试信息中（与 mysql/postgres 一致）
// B1：SSL/TLS 开关进签名 —— 同一 host:port 上切换 TLS 后必须拿到新 client，
// 否则旧 client（明文/TLS）会被继续复用，"改了不生效"
// N1：校验模式与 CA 内容一起进签名，档位口径在 db-tls（三引擎共用）
function sig (conn) {
  return `${conn.dbHost}:${conn.dbPort}${tlsSigTag(conn)}`
}

// N1：连接级 TLS 选项。ioredis 的 `tls` 原样透传给 node tls.connect，
// 档位解析与 CA 读取都在 db-tls，这里只负责 tls 键的封装形状
function tlsOptions (conn) {
  const profile = resolveTlsProfile(conn)
  if (!profile) {
    return {}
  }
  if (profile.error) {
    // CA 选了却读不到 → 建连失败并给出原因，不降级成"不校验"
    throw new Error(profile.error)
  }
  // 证书身份校验不用另外开键：ioredis 把 tls 原样交给 node tls.connect，
  // rejectUnauthorized 为真时 node 默认就做（mysql2 才需要 verifyIdentity）
  const tls = { rejectUnauthorized: profile.rejectUnauthorized }
  if (profile.ca) {
    tls.ca = profile.ca
  }
  return { tls }
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

// ioredis 把建连失败统一包成 "Connection is closed."：真正的死因（证书校验不通过、
// 认证失败、端口不通）只出现在 error 事件上，而 createClient 里那个吞错监听是为了
// 不让 ioredis 因"未监听 error"抛未捕获异常。N1 的验收线要求"校验开启且证书有问题时
// **报证书错误**"，只报"连接已关闭"用户就分不清是自己选的档位拦住了还是网络故障，
// 所以建连这一步临时挂一个收集器，把真实原因取回来。
function withRealCause (e, lastError) {
  if (!lastError || lastError === e) {
    return e
  }
  const msg = String((e && e.message) || '')
  if (!/^Connection is closed\.?$/i.test(msg.trim())) {
    return e
  }
  const real = new Error('redis connect failed: ' + String((lastError && lastError.message) || lastError))
  real.code = (lastError && lastError.code) || (e && e.code)
  real.cause = lastError
  return real
}

async function connectClient (c) {
  let lastError = null
  // 不摘监听：createClient 出来的 client 只 connect 一次（失败即 disconnect 且不进
  // clients 表），所以这条收集器和 client 同生命周期，摘不摘都不会串到下一次连接
  c.on('error', e => { lastError = e })
  try {
    await c.connect()
  } catch (e) {
    throw withRealCause(e, lastError)
  }
}

async function getClient (conn) {
  const key = sig(conn)
  if (clients.has(key)) {
    return clients.get(key)
  }
  const c = createClient(conn)
  try {
    await connectClient(c)
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
    await connectClient(c)
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

// N5b 大 Key 扫描上限：对齐键树 10000 键上限的既有纪律，防 500 万键实例把主进程卡死
const BIGKEYS_MAX_SCAN = 10000
// N5b 大 Key 扫描每轮 SCAN COUNT：越大 pipeline 越大，越小往返越多；500 是折中
const BIGKEYS_SCAN_COUNT = 500
// N5b 大 Key 扫描 TOP-N 上限：IPC 传 100 条排序结果 + 元信息，前端够用；再多会克隆变慢
const BIGKEYS_TOP_N = 100

// N5b：大 Key / MEMORY USAGE 扫描 —— SCAN + TYPE + MEMORY USAGE 聚合的迷你 --bigkeys。
// 思路：ioredis MEMORY USAGE 会先 DUMP 再算占用，string 类型直接用 STRLEN 更准更快；
// 复杂类型（hash/list/set/zset/stream）才走 MEMORY USAGE。
// - cancelToken：每 SCAN 循环开头检查，非零值直接 break 并标记 cancelled，
//   主进程不等 pipeline 跑完就 return（pipeline 的结果会自然被 Promise 链忽略）
// - 返回 rows 已按 size 降序、最多 BIGKEYS_TOP_N 条
// - 不跨 dbIndex：渲染侧按"每个 db 单独一次扫描"调用方，本模块只管单库
async function scanBigKeys (conn, { dbIndex, match, maxScan, cancelToken }) {
  const c = await useDb(conn, dbIndex)
  const limit = Math.min(Number(maxScan) || BIGKEYS_MAX_SCAN, BIGKEYS_MAX_SCAN)
  const pattern = match || '*'
  let cursor = '0'
  let scanned = 0
  let cancelled = false
  const rows = []

  for (let round = 0; round < 10000; round++) {
    // cancelToken 检查：渲染侧 cancelToken++ 后这里立即停
    if (typeof cancelToken === 'number' && cancelToken !== 0 && !cancelled) {
      cancelled = true
      break
    }
    const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', BIGKEYS_SCAN_COUNT)
    cursor = String(next)
    if (!keys || !keys.length) {
      if (cursor === '0') break
      continue
    }

    // pipeline TYPE + MEMORY USAGE / STRLEN —— 1 pipeline 搞定这一小撮，
    // 避免 N 键 × 2 次往返把 RTT 放大
    const p = c.pipeline()
    for (const k of keys) {
      p.type(k)
      p.strlen(k) // 先假定 string，后根据 type 覆盖
    }
    const baseRes = await p.exec()

    // 第二轮 pipeline：对非 string 类型补 MEMORY USAGE
    const bigTypes = new Set()
    const bigKeys = []
    for (let i = 0; i < keys.length; i++) {
      const [typeErr, typeVal] = baseRes[i * 2] || []
      const type = typeErr ? 'unknown' : typeVal
      if (type !== 'string' && type !== 'none') {
        bigTypes.add(i)
        bigKeys.push(keys[i])
      }
    }
    let memRes = []
    if (bigKeys.length) {
      const p2 = c.pipeline()
      for (const k of bigKeys) p2.call('MEMORY', 'USAGE', k)
      memRes = await p2.exec()
    }

    // 合并：str 取 strlen，非 str 取 MEMORY USAGE
    let memIdx = 0
    for (let i = 0; i < keys.length; i++) {
      const [typeErr, typeVal] = baseRes[i * 2] || []
      const [, strSize] = baseRes[i * 2 + 1] || []
      const type = typeErr ? 'unknown' : typeVal
      let size = 0
      if (type === 'string') {
        size = Number(strSize) || 0
      } else if (bigTypes.has(i)) {
        const [memErr, memVal] = memRes[memIdx++] || []
        size = memErr ? 0 : (Number(memVal) || 0)
      }
      rows.push({ name: keys[i], type, size })
      scanned++
      if (scanned >= limit) break
    }
    if (scanned >= limit || cursor === '0') break
  }

  // 降序取 TOP-N
  rows.sort((a, b) => b.size - a.size)
  const top = rows.slice(0, BIGKEYS_TOP_N)

  return {
    rows: top,
    scanned,
    truncated: scanned >= limit,
    cancelled,
    totalInTop: rows.length
  }
}

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
// **本批不做**：FLUSHDB/FLUSHALL、KEYS、通用命令、二进制写。
// （"通用命令"在 N5a 另开一条**受限控制台**路径：见 redis-console.js +
//   redis-command-policy.js，分词与拦截都在主进程，FLUSHDB/FLUSHALL/KEYS 仍是无条件拒绝。）
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

// -------------------------------------------------- N5a：受限命令控制台 ----
// 这一层的职责是"把一条任意命令安全地递出去"，与上面"按类型读写键"是两个变更理由，
// 所以实现在 redis-console.js / redis-command-policy.js，这里只做句柄注入：
// `useDb` 由本模块传下去（控制台需要复用同一套 per-request SELECT 口径），
// 反过来 require 会形成循环依赖 —— 注入而不是互相引用。

async function runRedisCommand (conn, args) {
  return redisConsole.runRedisCommand(conn, args, { useDb })
}

async function listRedisCommands (conn, args) {
  return redisConsole.listRedisCommands(conn, args, { useDb })
}

// N5c：Profiler（MONITOR）环形缓冲上限。MONITOR 每秒几十上百行输出，
// 1000 行够用（200ms 拉一次的话 1000 行≈几秒窗口）；再多 IPC 克隆变慢
const PROFILER_RING_MAX = 1000
// N5c：同连接签名同一时刻只允许一个 profiler —— MONITOR 会把 client 切订阅模式，
// 第二个 PROFILER client 不会拿到第一个的流（ioredis monitor 是 per-client 独立的）
const profilers = new Map() // handleId -> { client, buffer, paused, ringStart, seq }
let nextProfilerHandle = 1

// N5c：Profiler 停止 —— 关 monitor client、清 buffer、删表项。
// 无论正常 stop 还是异常断连都走这里，保证 profilers 表不会漏项
function cleanupProfiler (handleId) {
  const p = profilers.get(handleId)
  if (!p) return
  try { p.client.disconnect() } catch (_) {}
  p.buffer.length = 0
  profilers.delete(handleId)
}

// N5c：Profiler 启动 —— 新建独立 monitor client（不碰控制台/扫描用的连接池），
// 跑 MONITOR 命令，每一行 append 到环形缓冲。buffer 是普通数组 + ringStart 指针，
// PROFILER_RING_MAX 以上时移动 ringStart 覆盖最老行，不做 splice（避免 O(n)）。
// 返回 handleId；渲染侧用 handleId 拉数据 / 停 profiler。
// - filter：主进程侧先过滤（渲染侧再二次过滤也行，但主进程先挡能少 clone）
// - 返回：handleId；失败抛异常（连接/认证错误一路冒给调用方）
async function startRedisProfiler (conn, { dbIndex, filter } = {}) {
  // 签名：复用 sig() 逻辑但加 '-monitor' 后缀区分；跟 clients Map 完全隔离，
  // 避免"同一个 conn 对象被 acquire() 重用"——acquire 返回的是主操作 client，
  // monitor client 独立存在 profilers Map，两者互不干扰
  const monitorClient = createClient(conn)
  monitorClient.on('error', () => {}) // 吞，避免 ioredis 未监听异常
  await connectClient(monitorClient)
  if (typeof dbIndex === 'number') {
    try { await monitorClient.select(dbIndex) } catch (_) {}
  }

  const p = {
    client: monitorClient,
    buffer: [],
    ringStart: 0, // 环形起始索引；buffer 本身不 shrink，覆盖老行靠这个指针
    paused: false,
    seq: 0, // 单调递增序号，渲染侧靠 seq 知道"拉到了哪"
    filter: filter ? String(filter) : ''
  }
  const handleId = nextProfilerHandle++
  profilers.set(handleId, p)

  // ioredis monitor API：client.monitor((time, args, rawline) => void)
  // time 是 "1731191234.123"（UNIX 秒+毫秒小数），args 是命令名+参数数组
  // rawline 是原始字符串（如 "1731191234.123 [0 ...] \"PING\""）
  monitorClient.monitor((time, args, rawline) => {
    if (p.paused) return
    const text = rawline || ((args && args.join && args.join(' ')) || String(args))
    if (p.filter && !text.includes(p.filter)) return

    // 环形：buffer 未满时直接 push；满了覆盖 ringStart 位置后 ringStart++
    const item = { id: p.seq++, t: time, text }
    if (p.buffer.length < PROFILER_RING_MAX) {
      p.buffer.push(item)
    } else {
      p.buffer[p.ringStart] = item
      p.ringStart = (p.ringStart + 1) % PROFILER_RING_MAX
    }
  }).catch(err => {
    // monitor 命令本身失败（权限/连接），cleanup 并让渲染侧下次 stop 时能拿到状态
    p._fatal = true
    p._fatalErr = String(err && err.message)
    cleanupProfiler(handleId)
  })

  return { handleId }
}

// N5c：Profiler 拉取数据 —— 渲染侧每次传上次的 lastSeq，返回之后的新行。
// 环形缓冲 + seq 单调递增 = 简单 diff：lastSeq 之后的都要。
// 如果 lastSeq 已在环形覆盖区间之前（意味着渲染侧太久没拉、丢了），
// 返回 _overflow=true + 全 buffer 内容让渲染侧重置。
function getRedisProfilerData (handleId, lastSeq = -1) {
  const p = profilers.get(handleId)
  if (!p) return { rows: [], overflow: false, stopped: true }

  // 从环形构造"当前有效窗口"—— ringStart 之后是老，之前是新（因为覆盖是循环的）
  const rows = []
  if (p.ringStart < p.buffer.length) {
    rows.push(...p.buffer.slice(p.ringStart))
    rows.push(...p.buffer.slice(0, p.ringStart))
  } else {
    rows.push(...p.buffer)
  }

  // filter：返回 lastSeq 之后的新行
  const since = rows.filter(r => r.id > lastSeq)

  // lastSeq 在环形之前 → overflow（buffer 覆盖过了）；返回全量让渲染侧重置
  const overflow = lastSeq >= 0 && rows.length > 0 && rows[0].id > lastSeq
  if (overflow) {
    return { rows, overflow: true, paused: p.paused, stopped: false }
  }
  return { rows: since, overflow: false, paused: p.paused, stopped: false }
}

// N5c：Profiler 暂停/恢复 —— 主进程侧"停止 append"，不影响 monitor client 持续接收
// （ioredis monitor 本身没法暂停；我们在回调里 skip 就行）
function toggleRedisProfilerPause (handleId, paused) {
  const p = profilers.get(handleId)
  if (!p) return false
  p.paused = !!paused
  return p.paused
}

// N5c：Profiler 停止 —— cleanupProfiler 的公开入口
function stopRedisProfiler (handleId) {
  if (!handleId) return
  cleanupProfiler(handleId)
}

// 无参全清（app 退出兜底）—— 额外把所有 profiler client 也关掉
async function closeRedisConnection () {
  for (const p of profilers.values()) {
    try { p.client.disconnect() } catch (_) {}
  }
  profilers.clear()
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
  // N5a：受限命令控制台（分词/判定/封顶都在 redis-console.js，只读位由 dbClientOp 注入）
  runRedisCommand,
  listRedisCommands,
  // N5b：大 Key 扫描 —— SCAN+TYPE+MEMORY USAGE 聚合，TOP-N 降序，带上限/取消
  scanBigKeys,
  // N5c：Profiler（MONITOR）—— 独立 monitor client + 环形缓冲 + start/stop/pull/pause
  startRedisProfiler,
  getRedisProfilerData,
  toggleRedisProfilerPause,
  stopRedisProfiler,
  closeRedisConnection,
  // 键列表任意跳页（SCAN 从 0 前向步进 pageIndex 次）
  scanKeysToPage,
  // 纯函数导出仅供单测（HSCAN/SSCAN 游标循环）
  scanPage
}
