/**
 * Redis `INFO` 原文 → 结构化事实（纯函数，零依赖）
 *
 * 为什么单独一层：INFO 是"一个字符串里塞了十几个小节"的格式，直接在组件里 split
 * 会把三种边界写丢（值里本身带冒号、CRLF、受管实例少小节）。这里只出**事实**
 * （数字就是数字、缺就是 null），单位与文案留给组件 —— 与监控条同源，
 * 字节/时长复用 remote-monitor/monitor-model 的 formatBytes / formatDuration。
 *
 * 刻意不用 INFO 的 *_human 字段：Redis 自己按 1024 折算却标成 K/M/G，
 * 和监控条的 KiB/MiB 对不上，同屏两种单位比"多算一次除法"更糟。
 */

const SECTION_NAME = /^#\s*(.+)$/

/**
 * `# Server` → 'server'；`# Command Stats` → 'commandstats'。
 * 小节名只用来寻址，不做白名单：Redis 版本间会加小节，写死名单就等于
 * "新版本多出来的信息一律看不见"。
 */
function sectionId (line) {
  const m = SECTION_NAME.exec(line)
  if (!m) {
    return null
  }
  return m[1].toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 解析整份 INFO。永不抛错：拿不到就是空小节，交给上层显示"这个实例没给这项信息"。
 * 值一律保留原文字符串（数字转换走 infoNumber，才知道谁是真数字）。
 */
export function parseRedisInfo (text) {
  const sections = {}
  let current = null
  for (const rawLine of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const sec = sectionId(line)
    if (sec) {
      current = sec
      if (!sections[current]) {
        sections[current] = {}
      }
      continue
    }
    const at = line.indexOf(':')
    if (at <= 0) {
      // 没有冒号（或冒号在行首）的行不是键值对：Redis 偶尔会在小节里塞注释
      continue
    }
    if (!current) {
      // 小节头之前的散行：没有归属就不猜，丢了比挂错小节好
      continue
    }
    if (!sections[current]) {
      sections[current] = {}
    }
    sections[current][line.slice(0, at)] = line.slice(at + 1)
  }
  return { sections }
}

function sectionOf (parsed, name) {
  const s = parsed && parsed.sections
  return (s && s[name]) || null
}

/**
 * 字符串事实：缺小节、缺键、空值（`config_file:`）都算没有。
 * 空值不当成 ''：界面上"空"和"没配"是同一件事，都不该占一格。
 */
export function infoString (parsed, name, key) {
  const sec = sectionOf(parsed, name)
  const v = sec && sec[key]
  if (v === undefined || v === null) {
    return null
  }
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * 数字事实：非数字（`used_memory_human:1.05M`）与 NaN/Infinity 一律 null。
 * 0 是合法值，必须原样返回 —— 判定"有没有"用 null，不能用真假。
 */
export function infoNumber (parsed, name, key) {
  const s = infoString(parsed, name, key)
  if (s === null) {
    return null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * `# Keyspace` 的 `db0:keys=6,expires=0,avg_ttl=47537`。
 * 字段按 k=v 取，缺哪个就是 null（老版本没有 avg_ttl；受管实例可能只给 keys）。
 * 非 dbN 的行不属于键空间统计，直接跳过而不是塞个 0 进去。
 */
export function keyspaceRows (parsed) {
  const sec = sectionOf(parsed, 'keyspace') || {}
  const out = []
  for (const key of Object.keys(sec)) {
    const m = /^db(\d+)$/.exec(key)
    if (!m) {
      continue
    }
    const fields = {}
    for (const pair of String(sec[key]).split(',')) {
      const at = pair.indexOf('=')
      if (at > 0) {
        fields[pair.slice(0, at).trim()] = pair.slice(at + 1)
      }
    }
    const num = k => {
      const n = Number(fields[k])
      return Number.isFinite(n) ? n : null
    }
    out.push({
      db: key,
      index: Number(m[1]),
      keys: num('keys'),
      expires: num('expires'),
      // INFO 里 avg_ttl 单位是毫秒
      avgTtlMs: num('avg_ttl')
    })
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

/**
 * 概览要的那几项，一次取全（组件不再到处 infoNumber(parsed, 'memory', ...)）。
 * 键名即"这一项是什么"，界面按 key 出标签；取不到就是 null。
 */
export function redisOverview (parsed) {
  const rows = keyspaceRows(parsed)
  const sum = k => {
    let total = 0
    let seen = false
    for (const r of rows) {
      if (typeof r[k] === 'number') {
        total += r[k]
        seen = true
      }
    }
    return seen ? total : null
  }
  const hits = infoNumber(parsed, 'stats', 'keyspace_hits')
  const misses = infoNumber(parsed, 'stats', 'keyspace_misses')
  // 命中率：两个数都拿到才算。缺一个就按 0 补会把"没统计"说成"命中率 0%"，
  // 而 0% 命中率在界面上是个结论（会让人去查为什么全 miss）。
  const hitTotal = hits + misses
  return {
    version: infoString(parsed, 'server', 'redis_version'),
    mode: infoString(parsed, 'server', 'redis_mode'),
    os: infoString(parsed, 'server', 'os'),
    config: infoString(parsed, 'server', 'config_file'),
    uptimeSeconds: infoNumber(parsed, 'server', 'uptime_in_seconds'),
    connectedClients: infoNumber(parsed, 'clients', 'connected_clients'),
    blockedClients: infoNumber(parsed, 'clients', 'blocked_clients'),
    maxClients: infoNumber(parsed, 'clients', 'maxclients'),
    role: infoString(parsed, 'replication', 'role'),
    connectedReplicas: infoNumber(parsed, 'replication', 'connected_slaves'),
    usedMemory: infoNumber(parsed, 'memory', 'used_memory'),
    usedMemoryRss: infoNumber(parsed, 'memory', 'used_memory_rss'),
    maxMemory: infoNumber(parsed, 'memory', 'maxmemory'),
    maxMemoryPolicy: infoString(parsed, 'memory', 'maxmemory_policy'),
    fragmentation: infoNumber(parsed, 'memory', 'mem_fragmentation_ratio'),
    hits,
    misses,
    hitRate: hits === null || misses === null
      ? null
      : hitTotal > 0 ? hits / hitTotal : null,
    opsPerSec: infoNumber(parsed, 'stats', 'ops_per_sec'),
    instantaneousOpsPerSec: infoNumber(parsed, 'stats', 'instantaneous_ops_per_sec'),
    evictedKeys: infoNumber(parsed, 'stats', 'evicted_keys'),
    expiredKeys: infoNumber(parsed, 'stats', 'expired_keys'),
    rejectedConnections: infoNumber(parsed, 'stats', 'rejected_connections'),
    totalKeys: sum('keys'),
    totalExpires: sum('expires')
  }
}

/**
 * 百分比：0.9708 → '97.08%'。null 交给界面出占位，这里不猜 0。
 */
export function formatPercent (rate, digits = 2) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return null
  }
  return (rate * 100).toFixed(digits) + '%'
}
