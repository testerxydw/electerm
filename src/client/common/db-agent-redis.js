import { parseRedisInfo, redisOverview, keyspaceRows } from './db-redis-info.js'
import { parseRedisSlowlog, slowlogStats } from './db-redis-slowlog.js'

export const REDIS_AGENT_SCAN_DEFAULT = 50
export const REDIS_AGENT_SCAN_MAX = 200
export const REDIS_AGENT_KEY_ITEMS_DEFAULT = 50
export const REDIS_AGENT_KEY_ITEMS_MAX = 200
export const REDIS_AGENT_VALUE_MAX_CHARS = 2000
export const REDIS_AGENT_NAME_MAX_CHARS = 200
export const REDIS_AGENT_SLOWLOG_DEFAULT = 20
export const REDIS_AGENT_SLOWLOG_MAX = 100
export const REDIS_AGENT_INFO_SECTION_MAX_KEYS = 60
export const REDIS_AGENT_DETAIL_MAX_CHARS = 16000
export const REDIS_AGENT_STREAM_FIELDS_MAX = 50

const CURSOR_SAMPLE_NOTE = 'Bounded sample, not exhaustive. nextCursor skips omitted batch items; hasMore only indicates server cursor continuation.'
const SAMPLE_NOTE = 'Bounded sample only, not exhaustive; the adapter may already have limited the fetched items.'

function text (value) {
  return value === undefined || value === null ? '' : String(value)
}

export function normalizeRedisAgentLimit (value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return fallback
  }
  return Math.min(Math.max(1, Math.floor(n)), max)
}

// Missing values are not zero; TTL=0 means expiry within the current second.
function numOr (value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function newStats (remaining = Infinity) {
  return { truncated: 0, binary: 0, remaining, budgetTruncated: false }
}

function clip (str, max, stats) {
  const allowed = Math.min(max, stats.remaining)
  if (str.length > allowed) {
    stats.truncated += 1
    stats.budgetTruncated = stats.budgetTruncated || Math.min(str.length, max) > stats.remaining
    str = allowed > 0 ? str.slice(0, allowed - 1) + '…' : ''
  }
  stats.remaining -= str.length
  return str
}

function identity (value, name, stats) {
  const str = text(value)
  return str.length <= REDIS_AGENT_NAME_MAX_CHARS
    ? { [name]: clip(str, REDIS_AGENT_NAME_MAX_CHARS, stats) }
    : {
        [name]: null,
        [name + 'Preview']: clip(str, REDIS_AGENT_NAME_MAX_CHARS, stats),
        [name + 'Truncated']: true
      }
}

// Adapter strings are UTF-8 previews, not binary detection of decoded values.
function shapeValue (value, maxChars, stats) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) {
      stats.binary += 1
      return clip(`<binary ${value.byteLength} bytes>`, maxChars, stats)
    }
    let json
    try {
      json = JSON.stringify(value)
    } catch (err) {
      json = String(value)
    }
    return clip(text(json), maxChars, stats)
  }
  return clip(String(value), maxChars, stats)
}

function sample (count, limit, stats, itemAt) {
  const shown = []
  for (let i = 0; i < Math.min(count, limit); i++) {
    if (stats.remaining === 0) {
      stats.budgetTruncated = true
      break
    }
    shown.push(itemAt(i))
  }
  return shown
}

function sampleCounts (out, unit, fetched, returned) {
  out['returned' + unit] = returned
  out['fetched' + unit] = fetched
  out['omitted' + unit] = fetched - returned
  out.truncated = out.truncated === true || fetched > returned
}

export function summarizeRedisKeys (page, { dbIndex = 0, match = '', limit = REDIS_AGENT_SCAN_DEFAULT } = {}) {
  const p = page || {}
  const rows = Array.isArray(p.rows) ? p.rows : []
  const take = normalizeRedisAgentLimit(limit, REDIS_AGENT_SCAN_DEFAULT, REDIS_AGENT_SCAN_MAX)
  const stats = newStats()
  let truncatedNames = 0
  const keys = rows.slice(0, take).map(r => {
    const row = r || {}
    const out = identity(row.name, 'name', stats)
    if (out.nameTruncated) truncatedNames += 1
    if (row.type !== undefined) {
      out.type = clip(text(row.type), REDIS_AGENT_NAME_MAX_CHARS, stats)
    }
    if (row.ttl !== undefined) {
      out.ttl = numOr(row.ttl, null)
    }
    return out
  })
  const cursor = text(p.nextCursor) || '0'
  const out = {
    dbIndex: numOr(dbIndex, 0),
    match: clip(text(match) || '*', REDIS_AGENT_NAME_MAX_CHARS, stats),
    keys,
    nextCursor: clip(cursor, REDIS_AGENT_NAME_MAX_CHARS, stats),
    hasMore: cursor !== '0',
    sampleOnly: true,
    note: CURSOR_SAMPLE_NOTE,
    truncated: stats.truncated > 0,
    truncatedNames
  }
  sampleCounts(out, 'Keys', rows.length, keys.length)
  return out
}

function streamEntry (entry, maxChars, stats) {
  const e = Array.isArray(entry) ? entry : []
  const pairs = Array.isArray(e[1]) ? e[1] : []
  const fetched = Math.floor(pairs.length / 2)
  const before = stats.truncated
  const id = clip(text(e[0]), REDIS_AGENT_NAME_MAX_CHARS, stats)
  const fields = sample(fetched, REDIS_AGENT_STREAM_FIELDS_MAX, stats, i => ({
    field: clip(text(pairs[i * 2]), REDIS_AGENT_NAME_MAX_CHARS, stats),
    value: shapeValue(pairs[i * 2 + 1], maxChars, stats)
  }))
  const out = { id, fields, truncated: stats.truncated > before }
  sampleCounts(out, 'Fields', fetched, fields.length)
  return out
}

export function summarizeRedisKeyDetail (detail, {
  key = '',
  dbIndex = 0,
  limit = REDIS_AGENT_KEY_ITEMS_DEFAULT,
  maxValueChars = REDIS_AGENT_VALUE_MAX_CHARS
} = {}) {
  const d = detail || {}
  const type = text(d.type)
  const take = normalizeRedisAgentLimit(limit, REDIS_AGENT_KEY_ITEMS_DEFAULT, REDIS_AGENT_KEY_ITEMS_MAX)
  const maxChars = normalizeRedisAgentLimit(maxValueChars, REDIS_AGENT_VALUE_MAX_CHARS, REDIS_AGENT_VALUE_MAX_CHARS)
  const stats = newStats(REDIS_AGENT_DETAIL_MAX_CHARS)
  const cursor = text(d.nextCursor) || '0'
  const out = {
    ...identity(key, 'key', stats),
    dbIndex: numOr(dbIndex, 0),
    type: clip(type, REDIS_AGENT_NAME_MAX_CHARS, stats),
    ttl: numOr(d.ttl, null),
    nextCursor: clip(cursor, REDIS_AGENT_NAME_MAX_CHARS, stats)
  }
  if (['hash', 'set', 'stream', 'list', 'zset'].includes(type)) {
    const cursorSample = ['hash', 'set', 'stream'].includes(type)
    out.sampleOnly = true
    out.note = clip(cursorSample ? CURSOR_SAMPLE_NOTE : SAMPLE_NOTE, REDIS_AGENT_VALUE_MAX_CHARS, stats)
    if (cursorSample) out.hasMore = cursor !== '0'
  }
  const rows = d.rows
  switch (type) {
    case 'string': {
      out.value = shapeValue(d.value, maxChars, stats)
      if (Array.isArray(d.fields) && d.fields.includes('truncated')) {
        out.totalBytes = numOr(d.total, null)
        out.serverTruncated = true
      }
      break
    }
    case 'hash': {
      const obj = rows && typeof rows === 'object' && !Array.isArray(rows) ? rows : {}
      const names = Object.keys(obj)
      out.fields = sample(names.length, take, stats, i => ({
        field: clip(names[i], REDIS_AGENT_NAME_MAX_CHARS, stats),
        value: shapeValue(obj[names[i]], maxChars, stats)
      }))
      sampleCounts(out, 'Fields', names.length, out.fields.length)
      out.totalFields = numOr(d.total, null)
      break
    }
    case 'set':
    case 'list': {
      const list = Array.isArray(rows) ? rows : []
      const shown = sample(list.length, take, stats, i => shapeValue(list[i], maxChars, stats))
      out[type === 'set' ? 'members' : 'items'] = shown
      sampleCounts(out, type === 'set' ? 'Members' : 'Items', list.length, shown.length)
      if (type === 'set') out.totalMembers = numOr(d.total, null)
      break
    }
    case 'zset': {
      const list = Array.isArray(rows) ? rows : []
      const fetched = Math.floor(list.length / 2)
      out.members = sample(fetched, take, stats, i => ({
        member: shapeValue(list[i * 2], maxChars, stats),
        score: numOr(list[i * 2 + 1], null)
      }))
      sampleCounts(out, 'Members', fetched, out.members.length)
      break
    }
    case 'stream': {
      const list = Array.isArray(rows) ? rows : []
      out.entries = sample(list.length, take, stats, i => streamEntry(list[i], maxChars, stats))
      out.truncated = out.entries.some(e => e.truncated)
      sampleCounts(out, 'Entries', list.length, out.entries.length)
      out.totalLength = numOr(d.total, null)
      break
    }
    default: {
      out.value = null
      out.note = clip('Key not found or unsupported type.', REDIS_AGENT_VALUE_MAX_CHARS, stats)
    }
  }
  out.truncatedValues = stats.truncated
  out.binaryValues = stats.binary
  out.textBudgetExhausted = stats.budgetTruncated
  out.truncated = out.truncated === true || stats.truncated > 0 || stats.budgetTruncated || out.serverTruncated === true
  return out
}

function infoRecord (record, stats) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [
    key, typeof value === 'string' ? clip(value, REDIS_AGENT_NAME_MAX_CHARS, stats) : value
  ]))
}

export function summarizeRedisInfo (raw, { section = '' } = {}) {
  const parsed = parseRedisInfo(raw)
  const stats = newStats()
  const sections = Object.keys(parsed.sections)
  const keyspace = keyspaceRows(parsed)
  const cap = REDIS_AGENT_INFO_SECTION_MAX_KEYS
  const result = {
    overview: infoRecord(redisOverview(parsed), stats),
    keyspace: keyspace.slice(0, cap).map(row => infoRecord(row, stats)),
    sections: sections.slice(0, cap).map(s => clip(s, REDIS_AGENT_NAME_MAX_CHARS, stats)),
    totalKeyspaceRows: keyspace.length,
    omittedKeyspaceRows: Math.max(0, keyspace.length - cap),
    totalSections: sections.length,
    omittedSections: Math.max(0, sections.length - cap)
  }
  const want = text(section).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (want) {
    const sec = Object.hasOwn(parsed.sections, want) ? parsed.sections[want] : null
    if (!sec) {
      const preview = clip(text(section), REDIS_AGENT_NAME_MAX_CHARS, stats)
      result.sectionError = clip(`Section "${preview}" not present. Available: ${result.sections.join(', ') || 'none'}`, REDIS_AGENT_VALUE_MAX_CHARS, stats)
    } else {
      const keys = Object.keys(sec)
      const before = stats.truncated
      result.section = {
        name: clip(want, REDIS_AGENT_NAME_MAX_CHARS, stats),
        entries: keys.slice(0, cap).map(k => ({
          key: clip(k, REDIS_AGENT_NAME_MAX_CHARS, stats),
          value: clip(text(sec[k]), REDIS_AGENT_NAME_MAX_CHARS, stats)
        })),
        totalKeys: keys.length,
        omittedKeys: Math.max(0, keys.length - cap),
        truncated: keys.length > cap || stats.truncated > before
      }
    }
  }
  result.truncatedStrings = stats.truncated
  result.truncated = stats.truncated > 0 || result.omittedKeyspaceRows > 0 || result.omittedSections > 0 || !!(result.section && result.section.truncated)
  return result
}

function slowlogArgsTruncated (row) {
  const preview = text(row.argText)
  const length = row.args.reduce((sum, arg) => sum + text(arg).length, Math.max(0, row.args.length - 1))
  return length !== preview.length || row.args.join(' ') !== preview
}

export function summarizeRedisSlowlog (raw, { limit = REDIS_AGENT_SLOWLOG_DEFAULT } = {}) {
  const rows = parseRedisSlowlog(raw)
  const take = normalizeRedisAgentLimit(limit, REDIS_AGENT_SLOWLOG_DEFAULT, REDIS_AGENT_SLOWLOG_MAX)
  const summary = slowlogStats(rows)
  const stats = newStats()
  const entries = rows.slice(0, take).map(r => {
    const before = stats.truncated
    if (slowlogArgsTruncated(r)) stats.truncated += 1
    const out = {
      id: numOr(r.id, null),
      atMs: numOr(r.atMs, null),
      durationUs: numOr(r.durationUs, null),
      command: clip(text(r.command), REDIS_AGENT_NAME_MAX_CHARS, stats) || null,
      args: r.argText == null ? null : clip(text(r.argText), REDIS_AGENT_VALUE_MAX_CHARS, stats),
      clientAddr: clip(text(r.clientAddr), REDIS_AGENT_NAME_MAX_CHARS, stats) || null,
      clientName: clip(text(r.clientName), REDIS_AGENT_NAME_MAX_CHARS, stats) || null
    }
    out.truncated = stats.truncated > before
    return out
  })
  return {
    returnedEntries: entries.length,
    totalFetched: rows.length,
    omittedEntries: rows.length - entries.length,
    truncated: rows.length > entries.length || stats.truncated > 0,
    truncatedValues: stats.truncated,
    maxDurationUs: summary.maxUs,
    entries
  }
}
