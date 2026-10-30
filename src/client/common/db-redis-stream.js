/**
 * Redis Stream 原始回包 → 界面事实（纯函数，零依赖）
 *
 * 为什么单独一层：XINFO / XRANGE 回到的都是「嵌套数组」，层级随 RESP 版本变
 * （RESP2 是 `[k, v, k, v]` 扁平数组，RESP3 是 map），字段也随 Redis 版本增删
 * （7.0 起才有 `max-deleted-entry-id` / `recorded-first-entry-id`）。
 * 写死在组件里按下标取，换个版本就静默错位 —— 这里只出**事实**，
 * 缺就是 null（不是 0、不是空串），由界面显示「—」。
 *
 * 与慢日志/INFO 同一口径：0 在计数/滞后量里都是合法值，
 * 混进"没拿到"就分不清了。
 */

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

// RESP2 的扁平数组 → 普通对象；RESP3 直接给 map，原样收下
function flatToMap (raw) {
  if (!raw) {
    return {}
  }
  if (!Array.isArray(raw)) {
    return typeof raw === 'object' ? raw : {}
  }
  const map = {}
  for (let i = 0; i + 1 < raw.length; i += 2) {
    map[String(raw[i])] = raw[i + 1]
  }
  return map
}

/**
 * `XINFO STREAM` → 概览事实。
 * firstId 优先取 `recorded-first-entry-id`（7.0+，流被裁剪过时与 first-entry 不同），
 * 老版本回落到 `first-entry` 的 ID。
 */
export function parseXinfoStream (raw) {
  const map = flatToMap(raw)
  const firstEntry = Array.isArray(map['first-entry']) ? map['first-entry'] : null
  return {
    length: num(map.length),
    lastId: str(map['last-generated-id']),
    firstId: str(map['recorded-first-entry-id']) ||
      (firstEntry ? str(firstEntry[0]) : null),
    entriesAdded: num(map['entries-added']),
    groups: num(map.groups),
    maxDeletedId: str(map['max-deleted-entry-id'])
  }
}

/**
 * `XINFO GROUPS` → 消费组列表。任何一条不成形就跳过（不丢形状好的那些），
 * lag/entries-read 在 7.0 之前不存在 → null，界面出「—」而不是 0
 * （lag=0 是"组已追平"这个真实结论，不能与"不知道落后多少"混为一谈）。
 */
export function parseXinfoGroups (raw) {
  if (!Array.isArray(raw)) {
    return []
  }
  const list = []
  for (const group of raw) {
    const map = flatToMap(group)
    const name = str(map.name)
    if (name === null) {
      continue
    }
    list.push({
      name,
      consumers: num(map.consumers),
      pending: num(map.pending),
      lastDeliveredId: str(map['last-delivered-id']),
      entriesRead: num(map['entries-read']),
      lag: num(map.lag)
    })
  }
  return list
}

// 条目预览：字段多/值长的 stream 一条能有几十个字段，
// 表格只放得下一行的摘要，完整内容走单击后的值面板
const FIELD_PREVIEW = 3
const FIELD_CHARS = 80

/**
 * `XRANGE key start + COUNT n` → 表格行。
 * 一条原始条目形如 `[id, [field, value, field, ...]]`，
 * 字段值里可以带换行（业务常把 JSON 塞进去）—— 预览把它们压成单行，
 * 完整文本保留在 text 里给值面板。
 */
export function parseXrangeEntries (raw, { maxFields = FIELD_PREVIEW, chars = FIELD_CHARS } = {}) {
  if (!Array.isArray(raw)) {
    return []
  }
  const rows = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (!Array.isArray(entry)) {
      continue
    }
    const id = str(entry[0])
    const flat = Array.isArray(entry[1]) ? entry[1] : []
    const pairs = []
    for (let j = 0; j + 1 < flat.length; j += 2) {
      pairs.push([String(flat[j]), flat[j + 1] === null || flat[j + 1] === undefined ? '' : String(flat[j + 1])])
    }
    const text = pairs.map(([f, v]) => f + '=' + v).join('\n')
    let preview = pairs.slice(0, maxFields).map(([f, v]) => f + '=' + v).join(' · ')
    if (pairs.length > maxFields) {
      preview += ` …(+${pairs.length - maxFields})`
    }
    preview = preview.replace(/\s*\r?\n\s*/g, ' ')
    if (preview.length > chars) {
      preview = preview.slice(0, chars) + '…'
    }
    rows.push({
      __rowKey: i,
      id,
      fieldCount: pairs.length,
      preview,
      text
    })
  }
  return rows
}
