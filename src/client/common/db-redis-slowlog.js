/**
 * Redis `SLOWLOG GET` 原始条目 → 表格行（纯函数，零依赖）
 *
 * 为什么单独一层：慢日志条目的**形状跨版本会变**（6.2 起尾部多了客户端地址与名，
 * 7.4 起又夹进微秒时间戳），把它写死成"按下标取 6 个"就会在新版本上静默错位。
 * 这里按类型识别：数组那个是命令参数，尾部数字里够大的是微秒时间戳，
 * 剩下的字符串按"像 host:port 才算地址"判定 —— 认不出的一律留 null，
 * 由界面显示「—」而不是猜一个。
 *
 * 与 db-redis-info.js 同一口径：缺就是 null（不是 0、不是空串），
 * 因为 0 在耗时/计数里都是合法值，混在一起就分不清"真的 0"和"没拿到"。
 */

// host:port / [::ffff:1.2.3.4]:port / [::1]:port —— 冒号后必须是纯数字才算地址
const ADDR_RE = /^(\[[^\]]*\]|[^[\s:]+):\d+$/
// 微秒时间戳（1e15 量级）与秒时间戳（1e9 量级）差 6 个数量级，不会撞
const MICRO_TS_MIN = 1e14

// 参数预览：慢日志里一条 KEYS/SET 的参数可能是几 MB 的 value，
// 表格既放不下也不该放（截断只是显示层的事，原文仍在 args 里可查）
const ARG_PREVIEW = 8
const ARG_CHARS = 80

function num (v) {
  if (v === null || v === undefined || v === '') {
    return null
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str (v) {
  if (v === null || v === undefined) {
    return null
  }
  const s = String(v)
  return s === '' ? null : s
}

/**
 * 一条原始条目 → 一行。永不抛错：读不出的字段留 null，整条不丢
 * （丢了就等于"服务端报了 100 条、界面只有 98 条"这种查不出来的缺数）。
 */
export function parseRedisSlowlog (entries) {
  const list = Array.isArray(entries) ? entries : []
  const rows = []
  for (const entry of list) {
    if (!Array.isArray(entry)) {
      continue
    }
    const id = num(entry[0])
    const atSec = num(entry[1])
    const durationUs = num(entry[2])
    const args = (Array.isArray(entry[3]) ? entry[3] : []).map(a => str(a))
    let atMs = atSec === null ? null : atSec * 1000
    let clientAddr = null
    let clientName = null
    for (const tail of entry.slice(4)) {
      const n = typeof tail === 'number' ? tail : (typeof tail === 'string' && /^\d+$/.test(tail) ? Number(tail) : null)
      if (n !== null && n >= MICRO_TS_MIN) {
        // 微秒时间戳比秒的更精确，覆盖掉前面那份
        atMs = Math.floor(n / 1000)
        continue
      }
      const s = str(tail)
      if (s === null) {
        continue
      }
      if (clientAddr === null && ADDR_RE.test(s)) {
        clientAddr = s
      } else if (clientName === null) {
        clientName = s
      }
    }
    rows.push({
      id,
      atMs,
      durationUs,
      // args[0] 是命令名（服务端按客户端发来的原样存，大小写不保证）
      command: args.length ? args[0] : null,
      args: args.slice(1),
      argText: previewArgs(args.slice(1)),
      clientAddr,
      clientName
    })
  }
  return rows
}

/**
 * 参数预览：最多 ARG_PREVIEW 个、总长超 ARG_CHARS 截断加省略号。
 * 返回 null（不是空串）表示"没有参数可显示"，界面据此出「—」。
 */
export function previewArgs (args, { max = ARG_PREVIEW, chars = ARG_CHARS } = {}) {
  const list = (Array.isArray(args) ? args : []).map(a => str(a))
  if (!list.length) {
    return null
  }
  const shown = list.slice(0, max)
  let text = shown.join(' ')
  if (list.length > max) {
    text += ` …(+${list.length - max})`
  }
  if (text.length > chars) {
    text = `${text.slice(0, chars)}…`
  }
  return text
}

/**
 * 耗时：慢日志的单位是微秒，直接摆 42130 这种数没法读，
 * 但也不复用 monitor-model 的 formatDuration —— 那个收的是秒，
 * 而且最细只到 1s 以下就归 0，慢日志恰恰全在毫秒档。
 */
export function formatSlowDuration (us) {
  const n = num(us)
  if (n === null) {
    return '—'
  }
  if (n < 1000) {
    return `${n} μs`
  }
  if (n < 1e6) {
    return `${(n / 1000).toFixed(2)} ms`
  }
  return `${(n / 1e6).toFixed(2)} s`
}

export function formatSlowTime (atMs) {
  const n = num(atMs)
  if (n === null) {
    return '—'
  }
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) {
    return '—'
  }
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 复制成 TSV：与表格同序同值，但**参数不截断**（截断只属于显示，
 * 复制出去是为了贴到别处看完整命令）。空字段留空而不是「—」，
 * 免得粘进表格后那串横杠被当成数据。
 */
export function slowlogTsv (rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = ['id\ttime\tduration_us\tcommand\targs\tclient']
  for (const r of list) {
    lines.push([
      r.id === null || r.id === undefined ? '' : r.id,
      r.atMs === null || r.atMs === undefined ? '' : formatSlowTime(r.atMs),
      r.durationUs === null || r.durationUs === undefined ? '' : r.durationUs,
      r.command === null || r.command === undefined ? '' : r.command,
      (Array.isArray(r.args) ? r.args : []).map(a => (a === null || a === undefined ? '' : a)).join(' '),
      [r.clientAddr, r.clientName].filter(Boolean).join(' ')
    ].join('\t'))
  }
  return lines.join('\n')
}

/**
 * 汇总：条数 + 最慢一条。空表回 null（"没有慢查询"与"没拿到慢日志"是两件事，
 * 但都绝不该显示成"最慢 0 μs" —— 那是个会被当成结论的假数）。
 */
export function slowlogStats (rows) {
  const list = Array.isArray(rows) ? rows : []
  let maxUs = null
  for (const r of list) {
    const n = num(r && r.durationUs)
    if (n !== null && (maxUs === null || n > maxUs)) {
      maxUs = n
    }
  }
  return {
    count: list.length,
    maxUs
  }
}
