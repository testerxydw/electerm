/**
 * MCP server 状态徽章的文案映射（纯函数层）。
 *
 * 「状态文案」是设计 §2.9 的一个面：设计文档
 * `doc/已完成/设计-MCP-client-P0-1-2026-11-10.md` 规定
 * `failed` → 「失败：<lastError> + 重试按钮」、`degraded` → 「不稳定：<lastError>」。
 * 这里只负责**文本**（含 lastError 截断）；重试按钮属组件层，图标/颜色
 * 也留在组件层，因为这两者依赖 React/antd，而本文件必须能被 `node:test`
 * 直接 import（无 window、无 antd、无副作用）。
 *
 * 翻译函数由调用方注入（组件传 `window.translate`），这样测试不必装配
 * i18n 运行时。测试钉在 `src/test/unit-ci/mcp-server-config.spec.js`。
 */

// 一行徽章装不下长错误：超过这个长度就截断，防止布局被撑爆
// （lastError 里常有整段堆栈或多行 stderr）。
export const MAX_MCP_ERROR_LENGTH = 120

// 截断后缀用单字符省略号（U+2026），避免 '...' 把行宽算错。
const ELLIPSIS = '…'

/**
 * 截断 lastError 到一行内可显示的宽度。
 * 非字符串（含 undefined/null/数字）统一转字符串；空白串视为空。
 * @param {*} value
 * @returns {string} 空串表示「没有可显示的错误」
 */
export function truncateMcpError (value) {
  if (value === undefined || value === null) {
    return ''
  }
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  if (text.length <= MAX_MCP_ERROR_LENGTH) {
    return text
  }
  // 留一个位置给省略号，保证总长恰好不超过上限
  return text.slice(0, MAX_MCP_ERROR_LENGTH - 1) + ELLIPSIS
}

/**
 * 状态 → 徽章文案。
 *
 * 形态约定（实机探针与既有断言按这个格式读）：
 *   - 无状态        → `''`
 *   - `ready`       → `就绪 (3)`（保留工具计数）
 *   - `failed`      → `失败：<lastError>`；lastError 为空时只给 `失败`
 *   - `degraded`    → `不稳定：<lastError>`；同上容错
 *   - 其它          → 原样回 `state`（idle / closed / connecting / initializing）
 *
 * lastError 为空时**不留孤零零的冒号**——「失败：」比「失败」更像渲染 bug。
 * @param {object|null|undefined} st 一台 server 的状态（mcpClientState 的元素）
 * @param {(key: string) => string} t 词条函数（组件传 window.translate）
 * @returns {{text: string}}
 */
export function mcpStatusText (st, t) {
  const tr = typeof t === 'function' ? t : key => key
  if (!st) {
    return { text: '' }
  }
  const state = st.state || ''
  if (state === 'ready') {
    // 保持既有格式 `${t('ready')} (${toolCount})`：探针与 UI 断言都按它读
    return { text: `${tr('ready')} (${st.toolCount || 0})` }
  }
  if (state === 'failed' || state === 'degraded') {
    const head = tr(state)
    const err = truncateMcpError(st.lastError)
    return { text: err ? `${head}: ${err}` : head }
  }
  return { text: state }
}
