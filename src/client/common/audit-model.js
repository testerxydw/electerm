/**
 * G8 审计中心的数据层（纯函数：不碰磁盘、不读 store、不 import 组件）。
 *
 * 三个来源合成一条时间线：
 * - `history`  连接历史（`store.history`，`{ time, count, tab }`）——只证明"连过"；
 * - `transfers` 传输历史（`store.transferHistory`）——一次上传/下载的起止与字节数；
 * - `files`    会话日志目录里的 `*.log` / `*.cast`（主进程列目录给）。
 *
 * 为什么不把"连接历史"和"它的日志文件"并成一行：`updateHistory`
 * （src/client/store/tab.js）把 `id`/`srcId` 列进了 tabPropertiesExcludes，
 * 历史里根本没留 tab id，而日志文件名的尾巴正是 tab id。没有可靠的键可以 join，
 * 靠"主机 + 时间接近"猜出来的合并会把两次会话算成一次——审计视图里宁可分行。
 *
 * 主机名从文件名反解是**启发式**（见 parseSessionLogName），解不出来就留空，
 * 不拿整段文件名当主机显示；产物列始终是真文件名，用户可以自己核对。
 *
 * 边界（设计 §14.9）：纯本机，不做服务端采集，不做命令级解析——日志是原始字节流，
 * 逐条切命令既不可靠也会把口令之类的内容抄进审计行。
 */
import time from './time.js'

export const KIND = {
  session: 'session',
  transfer: 'transfer',
  log: 'log',
  recording: 'recording'
}

export const KIND_ORDER = [KIND.session, KIND.transfer, KIND.log, KIND.recording]

// tab id 是 nanoid(7)；日志文件名 = sanitize(`标题_主机_id`) + '.log'
const SESSION_ID_LEN = 7
const NANOID_RE = /^[A-Za-z0-9_-]+$/
const CAST_EXT = '.cast'

const isNum = (v) => Number.isFinite(v)

// 空标题/空主机会留成 `__id` 这种连续下划线，解析时段落为空即"这一项没有"
const clean = (s) => (typeof s === 'string' && s ? s : '')

/**
 * 会话日志文件名 → `{ base, ext, title, host, sessionId }`。
 *
 * 只在末尾能切成"分隔符 + 恰好 7 个 nanoid 字符"时认为拿到了 tab id，然后从剩下
 * 的前缀里取最后一段当主机。两个已知会解错/解不出的形状，都如实标出来而不是硬猜：
 * - 标题里带 `_`（`sanitizeFilename` 把 `:` `/` 都换成了 `_`）：主机会取到标题的末段；
 *   所以只有 `sessionId` 解出来时才给 host，否则界面显示 `—`（原始文件名仍在产物列）。
 * - 名字超过 255 字节被 `sanitizeFilename` 从头截断：尾巴上的 id 直接没了，
 *   此时 `sessionId` 为空，这一行不参与按主机过滤。
 */
export function parseSessionLogName (name) {
  const s = clean(name)
  const dot = s.lastIndexOf('.')
  const ext = dot > 0 ? s.slice(dot) : ''
  const base = ext ? s.slice(0, dot) : s
  const cut = base.length - (SESSION_ID_LEN + 1)
  const tail = base.slice(base.length - SESSION_ID_LEN)
  const hasSeparator = cut >= 0 && base[cut] === '_'
  const sessionId = hasSeparator && NANOID_RE.test(tail) ? tail : ''
  const prefix = sessionId ? base.slice(0, cut) : ''
  const at = prefix.lastIndexOf('_')
  return {
    name: s,
    base,
    ext,
    sessionId,
    host: sessionId ? clean(at >= 0 ? prefix.slice(at + 1) : prefix) : '',
    title: sessionId && at > 0 ? prefix.slice(0, at) : ''
  }
}

const msFrom = (v) => (isNum(v) ? v : null)

const durationOf = (start, end) => {
  if (!isNum(start) || !isNum(end) || end < start) {
    return null
  }
  return end - start
}

/** 连接历史 → 行。时长未知（历史只记最后一次连接的时刻与次数），留 null。 */
function fromHistory (item) {
  const tab = (item && item.tab) || {}
  return {
    key: 'session:' + clean(item && item.id),
    kind: KIND.session,
    time: msFrom(item && item.time),
    end: null,
    duration: null,
    host: clean(tab.host),
    user: clean(tab.username),
    connType: clean(tab.type),
    artifact: '',
    size: null,
    count: isNum(item && item.count) ? item.count : 1,
    detail: clean(tab.title || tab.tab)
  }
}

/** 传输历史 → 行。方向并进 connType，起止都在时给时长。 */
function fromTransfer (item) {
  const t = item || {}
  const start = msFrom(t.startTime)
  const end = msFrom(t.finishTime)
  const to = clean(t.toPath)
  return {
    key: 'transfer:' + clean(t.id),
    kind: KIND.transfer,
    time: start === null ? end : start,
    end,
    duration: durationOf(start, end),
    host: clean(t.host),
    user: clean(t.username),
    // 口径抄 transferFile()：起点在本地就算上传；两端都在远端是第三种（remote2remote）
    connType: t.typeFrom === 'local'
      ? 'upload'
      : (t.typeTo === 'remote' ? 'remote' : 'download'),
    artifact: '',
    size: isNum(t.size) ? t.size : null,
    count: 1,
    // 路径可能很长，完整值留在这里由界面省略 + tooltip 兜底，导出不截断
    detail: [clean(t.fromPath), to].filter(Boolean).join(' → ') +
      (clean(t.error) ? ' (' + clean(t.error) + ')' : '')
  }
}

/** 目录里的一个文件 → 行。`.cast` 算录制，其余按日志——列目录那侧只放行这两种扩展名。 */
function fromFile (file) {
  const f = file || {}
  const parsed = parseSessionLogName(f.name)
  const isCast = parsed.ext === CAST_EXT
  // 探测到录制起始时刻（cast header 的 timestamp）时用它，mtime 只是"文件被写过"
  const start = isNum(f.time) ? f.time : msFrom(f.mtimeMs)
  const durSec = isNum(f.duration) ? f.duration : null
  return {
    key: (isCast ? 'cast:' : 'log:') + parsed.name,
    kind: isCast ? KIND.recording : KIND.log,
    time: start,
    end: start !== null && durSec !== null ? start + durSec * 1000 : null,
    duration: durSec === null ? null : Math.round(durSec * 1000),
    host: parsed.host,
    user: '',
    connType: '',
    artifact: parsed.name,
    size: isNum(f.size) ? f.size : null,
    count: 1,
    detail: isCast
      ? clean(f.firstCommand)
      : parsed.title
  }
}

/**
 * 三来源 → 一条按时间倒序的时间线。
 * 没有时刻的行（mtime 拿不到、历史缺 time）排在最后：时间线不能为了对齐把未知当 0。
 */
export function buildAuditRows ({ history, transfers, files } = {}) {
  const rows = [
    ...(Array.isArray(history) ? history : []).map(fromHistory),
    ...(Array.isArray(transfers) ? transfers : []).map(fromTransfer),
    ...(Array.isArray(files) ? files : []).map(fromFile)
  ]
  const seen = new Set()
  return rows
    .filter((r) => {
      if (!r.key || seen.has(r.key)) {
        return false
      }
      seen.add(r.key)
      return true
    })
    .sort((a, b) => {
      const at = a.time === null ? -1 : a.time
      const bt = b.time === null ? -1 : b.time
      if (at !== bt) {
        return bt - at
      }
      return a.key < b.key ? -1 : 1
    })
}

/**
 * 过滤。空数组 / 空串 = 该维度不限制（不是"什么都不要"）。
 * `text` 匹配主机、用户、产物与详情，不区分大小写。
 */
export function filterAuditRows (rows, filter = {}) {
  const { kinds, hosts, from, to, text } = filter
  const k = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null
  const h = Array.isArray(hosts) && hosts.length ? new Set(hosts) : null
  const q = clean(text).toLowerCase()
  const fromMs = isNum(from) ? from : null
  const toMs = isNum(to) ? to : null
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (k && !k.has(r.kind)) {
      return false
    }
    // 解不出主机的行在任何主机筛选下都不出现：审计里"筛了就漏"比"筛了没显示"危险
    if (h && !h.has(r.host)) {
      return false
    }
    if (fromMs !== null && (r.time === null || r.time < fromMs)) {
      return false
    }
    if (toMs !== null && (r.time === null || r.time > toMs)) {
      return false
    }
    if (q) {
      const hay = [r.host, r.user, r.artifact, r.detail].join('\n').toLowerCase()
      if (hay.indexOf(q) < 0) {
        return false
      }
    }
    return true
  })
}

/** 按列统计（过滤器的两栏候选项用它：只列真实出现过的值，带上条数）。 */
export function facetCounts (rows, field) {
  const map = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = clean(r[field])
    if (!v) {
      continue
    }
    map.set(v, (map.get(v) || 0) + 1)
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 按本地日期分桶（时间线左栏）。无时刻的行归到 `''`，由界面单独显示。 */
export function groupByDay (rows) {
  const buckets = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const day = r.time === null ? '' : time(r.time, 'YYYY-MM-DD')
    if (!buckets.has(day)) {
      buckets.set(day, [])
    }
    buckets.get(day).push(r)
  }
  return [...buckets.entries()]
    .map(([day, list]) => ({ day: DAY_RE.test(day) ? day : '', rows: list }))
    .sort((a, b) => {
      if (!a.day) {
        return 1
      }
      if (!b.day) {
        return -1
      }
      return a.day < b.day ? 1 : -1
    })
}

const DEFAULT_LABELS = {
  time: 'time',
  kind: 'type',
  host: 'host',
  user: 'user',
  duration: 'duration',
  artifact: 'artifact',
  size: 'size',
  count: 'count',
  detail: 'detail'
}

const COLUMNS = [
  ['time', DEFAULT_LABELS.time],
  ['kind', DEFAULT_LABELS.kind],
  ['host', DEFAULT_LABELS.host],
  ['user', DEFAULT_LABELS.user],
  ['duration', DEFAULT_LABELS.duration],
  ['artifact', DEFAULT_LABELS.artifact],
  ['size', DEFAULT_LABELS.size],
  ['count', DEFAULT_LABELS.count],
  ['detail', DEFAULT_LABELS.detail]
]

// 单元格的取值口径：导出给人看，所以空值写 `—` 而不是留空（留空在表格里像"没填"）
const cellOf = (row, field) => {
  if (field === 'time') {
    return row.time === null ? '—' : time(row.time)
  }
  if (field === 'duration') {
    return row.duration === null ? '—' : Math.round(row.duration / 1000) + 's'
  }
  if (field === 'size') {
    return row.size === null ? '—' : String(row.size)
  }
  const v = row[field]
  return v === null || v === undefined || v === '' ? '—' : String(v)
}

/**
 * RFC 4180：含 `, " 换行回车的字段加引号，内部 `"` 翻倍。
 * 审计列里没有二进制信封，所以不复用 db-csv.js（那边还得处理 `__bin` 截断报错）。
 */
const csvField = (s) => {
  const v = String(s)
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

const labelsOf = (opt) => ({ ...DEFAULT_LABELS, ...(opt && opt.labels) })

// 同一份行、同一次导出时刻 → 字节相同的文件；测试钉住这个，导出内容才可复核
export function auditToCsv (rows, opt = {}) {
  const labels = labelsOf(opt)
  const head = COLUMNS.map(([f, key]) => csvField(labels[key] || f))
  const lines = [head.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push(COLUMNS.map(([f]) => csvField(cellOf(r, f))).join(','))
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

export function auditToMarkdown (rows, opt = {}) {
  const labels = labelsOf(opt)
  const at = opt && opt.at
  const lines = [
    '# ' + (clean(opt && opt.title) || 'electerm audit'),
    '',
    '- ' + (at === undefined ? time(Date.now()) : (isNum(at) ? time(at) : String(at))),
    '- ' + (Array.isArray(rows) ? rows.length : 0) + ' rows',
    '',
    '|' + COLUMNS.map(([f]) => ' ' + (labels[f] || f) + ' |').join('')
  ]
  lines.push('|' + COLUMNS.map(() => ' --- |').join(''))
  for (const r of Array.isArray(rows) ? rows : []) {
    // 表格里的换行会把一行撑成多行，压平；竖线要转义，否则列会错位
    lines.push('|' + COLUMNS.map(([f]) => {
      const v = cellOf(r, f).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
      return ' ' + v + ' |'
    }).join(''))
  }
  return lines.join('\n') + '\n'
}

export default {
  KIND,
  KIND_ORDER,
  parseSessionLogName,
  buildAuditRows,
  filterAuditRows,
  facetCounts,
  groupByDay,
  auditToCsv,
  auditToMarkdown
}
