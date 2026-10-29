// H1 行详情：逐字段展示的纯函数层（渲染见 db-row-detail.jsx）。
// 独立成 .js 是为了单测能直接 import —— .jsx 在 node 里载不进来。
import { cellText, isBinEnvelope } from '../../common/db-column-width.js'

// 折叠阈值：超过 500 字符或 12 行就收起。与列宽量宽无关，取"一眼能扫完"的量级
export const ROW_DETAIL_INLINE_MAX = 500
const ROW_DETAIL_INLINE_LINES = 12

// 展示文本：对象/数组按 2 空格缩进重排（cellText 给的是单行 JSON，量宽要单行，
// 但定义列表里一坨单行 JSON 没法读）；二进制沿用信封占位符，不做文本化
export function rowDetailText (v) {
  if (isBinEnvelope(v)) {
    return cellText(v)
  }
  if (v !== null && typeof v === 'object') {
    try {
      return JSON.stringify(v, null, 2)
    } catch (err) {
      return cellText(v)
    }
  }
  return cellText(v)
}

// 复制口径：二进制复制 base64 原文（与单元格右键/值面板一致），其余与展示同源
export function rowDetailCopyText (v) {
  return isBinEnvelope(v) ? v.__bin.b64 : rowDetailText(v)
}

// 是否需要折叠：字符数与行数任一超限都收。只看字符数会漏掉"300 字符 20 行"的
// 缩进 JSON —— 那一条展开后照样占满整屏
export function isLongRowValue (text) {
  if (typeof text !== 'string') {
    return false
  }
  return text.length > ROW_DETAIL_INLINE_MAX ||
    text.split('\n').length > ROW_DETAIL_INLINE_LINES
}

// 只取给定列：复制整行 JSON 时把 __rowKey 这类内部键挡在外面
export function rowDetailObject (columns, row) {
  const out = {}
  for (const k of columns || []) {
    out[k] = row ? row[k] : undefined
  }
  return out
}
