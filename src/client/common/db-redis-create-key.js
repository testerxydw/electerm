/**
 * N7 新建键（Redis 页面建键）—— 值解析 + op 调用计划（纯函数，node 单测可直接 import）
 *
 * 服务端写 op 全部齐备（T12 类型化写 hashSetField/setAdd/zsetAdd/listPush +
 * setKey + expireKey），且 Redis 写命令对不存在的键自动建键 —— 新建键不需要任何
 * 新 server op，本模块只负责把「界面上的行文本」解析成既有 op 的调用序列。
 *
 * 为什么解析放渲染层纯模块而不是组件里就地 split：错误要就地可读、口径要能被
 * 单测钉住（field=value 按第一个 = 分隔这类规则，散在 JSX 里没人测得到）。
 * 服务端各 op 自己还有一道参数校验（normalizeItems/requireKey），两边不靠彼此兜底。
 *
 * 值格式（统一行文本，类型决定形状）：
 * - string：原样（不经解析，整键 SET）
 * - hash：每行 `field=value`，按**第一个** = 分隔 —— field 不含 =，value 可以含
 * - zset：每行 `score member`，按第一个空白分隔，score 必须是有限数字
 * - list / set：每行一项（trim 后非空才算）
 */

// 行文本 → 行数组：trim 每行，丢空行
export function parseValueLines (text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

// hash：每行 field=value，按第一个 = 分隔（value 可含 =）。分隔失败的行给 null，
// 由调用方决定报错 —— 这里不静默跳过，静默会变成"建出来的键少了字段还看不出来"
export function parseHashLines (text) {
  return parseValueLines(text).map(l => {
    const i = l.indexOf('=')
    if (i <= 0) {
      return null
    }
    return { field: l.slice(0, i).trim(), value: l.slice(i + 1) }
  })
}

// zset：每行 score member（首个空白分隔）。score 不是有限数的行给 null
export function parseZsetLines (text) {
  return parseValueLines(text).map(l => {
    const m = l.match(/^(\S+)\s+(.+)$/)
    if (!m) {
      return null
    }
    const score = Number(m[1])
    return Number.isFinite(score) ? { score, member: m[2] } : null
  })
}

// 机器码错误（界面按码出文案，与 db-ddl-reason 同一口径）
const err = code => ({ calls: [], error: code })

/**
 * 新建键入参 → 既有 op 的调用计划。
 * @param {object} a { key, type, value, ttlSeconds }
 * @returns {{calls: Array<{op: string, args: object}>, error: string}}
 *   error 为空串表示计划合法；calls 按顺序执行即可（最后一步是可选的 expireKey）
 */
export function buildCreateKeyPlan ({ key, type, value, ttlSeconds } = {}) {
  const k = String((key || '')).trim()
  if (!k) {
    return err('dbRedisCreateKeyNeedName')
  }
  const calls = []
  if (type === 'string') {
    calls.push({ op: 'setKey', args: { value: String(value === null || value === undefined ? '' : value) } })
  } else if (type === 'hash') {
    const rows = parseHashLines(value)
    if (!rows.length || rows.some(r => !r)) {
      return err('dbRedisCreateKeyHashBad')
    }
    for (const r of rows) {
      calls.push({ op: 'hashSetField', args: { field: r.field, value: r.value } })
    }
  } else if (type === 'set') {
    const members = parseValueLines(value)
    if (!members.length) {
      return err('dbRedisCreateKeyEmpty')
    }
    calls.push({ op: 'setAdd', args: { members } })
  } else if (type === 'zset') {
    const rows = parseZsetLines(value)
    if (!rows.length || rows.some(r => !r)) {
      return err('dbRedisCreateKeyZsetBad')
    }
    for (const r of rows) {
      calls.push({ op: 'zsetAdd', args: { score: r.score, member: r.member } })
    }
  } else if (type === 'list') {
    const items = parseValueLines(value)
    if (!items.length) {
      return err('dbRedisCreateKeyEmpty')
    }
    for (const v of items) {
      // 统一 RPUSH：保持界面输入顺序（LPUSH 会倒序，用户看到的就是反的）
      calls.push({ op: 'listPush', args: { value: v, position: 'right' } })
    }
  } else {
    return err('dbRedisCreateKeyEmpty')
  }
  const ttl = Number(ttlSeconds)
  if (Number.isFinite(ttl) && ttl > 0) {
    calls.push({ op: 'expireKey', args: { seconds: ttl } })
  }
  return { calls, error: '' }
}
