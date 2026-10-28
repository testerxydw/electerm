// H1a-1：5 处网格共用的单元格展示层纯函数
// （SQL 结果 / 数据页 / 表结构页 / Redis 键列表 / Redis 详情）
//
// 为什么不 import value-renderers 的 isBinEnvelope：那个模块属于组件层（带呈现器
// 注册表与 JSX 依赖），这里是可单测的 common 纯模块，只做形状判断即可。
export const COL_W_MIN = 90
export const COL_W_MAX = 360
export const COL_W_FALLBACK = 90
const CHAR_W = 12
const PAD = 32
const SAMPLE_ROWS = 100
const NULL_TEXT_LEN = 4

export function isBinEnvelope (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('__bin' in v)) {
    return false
  }
  const b = v.__bin
  return !!b && typeof b === 'object' &&
    typeof b.size === 'number' && typeof b.b64 === 'string' &&
    typeof b.truncated === 'boolean'
}

// 单元格文本（悬停预览 / 原生 title 的唯一来源）：与网格里"看到的"一致，
// 但对象不再截 200 字符 —— 预览存在的意义就是看全，截断由展示层决定
export function cellText (v) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    return '<binary ' + v.__bin.size + ' bytes>'
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch (e) {
      // 循环引用等序列化失败：回落 String，绝不抛（title 不该让表格崩）
      return String(v)
    }
  }
  return String(v)
}

// 采样量长度 → 像素宽：沿用数据页既有公式（90~360），只是抽成共用函数，
// 保证抽函数前后数据页列宽逐列一致
export function fitColumnWidths (rows, keys, opts = {}) {
  const {
    sample = SAMPLE_ROWS,
    min = COL_W_MIN,
    max = COL_W_MAX
  } = opts
  const list = rows || []
  const names = keys && keys.length
    ? keys
    : (list.length ? Object.keys(list[0]) : [])
  if (!list.length || !names.length) {
    return {}
  }
  const head = list.slice(0, sample)
  const widths = {}
  for (const k of names) {
    let maxLen = String(k).length
    for (const r of head) {
      const v = r ? r[k] : null
      const len = v === null || v === undefined ? NULL_TEXT_LEN : cellText(v).length
      if (len > maxLen) {
        maxLen = len
      }
    }
    widths[k] = Math.min(max, Math.max(min, maxLen * CHAR_W + PAD))
  }
  return widths
}
