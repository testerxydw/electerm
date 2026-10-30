/**
 * H7b-3 批量删键的纯函数层：分块 / 预览截断 / 进度百分比 / 危险确认里的命令文本。
 * 不碰 IPC、不碰 locale —— 文案在 locales-extra，这里只算数。
 */

// 一批 500：一条 UNLINK 带 500 个键名对 redis 仍是毫秒级，而 500 一批意味着
// 删 5000 个键时进度条能走 10 格（1000 一批只有 5 格，看着像卡住了）。
export const REDIS_DEL_BATCH = 500

// 预览最多列 20 个键名：弹层是"让人确认自己删的是哪批"，不是逐条核对 500 个
export const DEL_PREVIEW_MAX = 20

/**
 * 按批切分。去重 + 丢弃非字符串/空串：
 * 同一个键在一页里出现两次（SCAN 语义允许）不该被删两次、也不该占两格进度。
 */
export function chunkRedisKeys (keys, size = REDIS_DEL_BATCH) {
  const n = Math.floor(Number(size))
  const step = Number.isFinite(n) && n > 0 ? n : REDIS_DEL_BATCH
  const out = []
  const seen = new Set()
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k !== 'string' || !k || seen.has(k)) {
      continue
    }
    seen.add(k)
    if (!out.length || out[out.length - 1].length >= step) {
      out.push([])
    }
    out[out.length - 1].push(k)
  }
  return out
}

/** 预览：前 max 个 + 剩下的条数（弹层据此决定那行"+N 个未列出"） */
export function delPreview (keys, max = DEL_PREVIEW_MAX) {
  const list = (Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k)
  const n = Math.floor(Number(max))
  const m = Number.isFinite(n) && n >= 0 ? n : DEL_PREVIEW_MAX
  return {
    shown: list.slice(0, m),
    rest: Math.max(0, list.length - m)
  }
}

/** 进度条百分比：total 为 0 时给 0 而不是 NaN（Progress 会画出空条并告警） */
export function delPercent (done, total) {
  const t = Number(total)
  const d = Number(done)
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(d) || d <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((d / t) * 100)))
}

/**
 * production 风险确认里的命令文本（E1 弹窗正文）。
 * 只列前 10 个键、单个键名截到 60 字符：确认框要让人一眼认出"删的是哪个前缀"，
 * 而不是把 500 个键名铺满一屏（那样谁都会直接点"仍要执行"）。
 */
export function delCommandText (keys, max = 10) {
  const { shown, rest } = delPreview(keys, max)
  const head = shown
    .map(k => (k.length > 60 ? k.slice(0, 57) + '…' : k))
    .join(' ')
  return `UNLINK ${head}${rest ? ` …(+${rest})` : ''}`
}
