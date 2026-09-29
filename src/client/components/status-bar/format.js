/**
 * 状态栏文本格式化（纯函数，供组件与单测共用）
 */

export const STATUS_TEXT = {
  success: '已连接',
  connecting: '连接中',
  error: '连接失败',
  disconnected: '未连接'
}

/**
 * 会话状态 → 文案
 * @param {string} status
 * @returns {string}
 */
export function statusText (status) {
  return STATUS_TEXT[status] || STATUS_TEXT.disconnected
}

/**
 * 会话类型 → 展示名
 * @param {object} tab
 * @returns {string}
 */
export function typeText (tab) {
  if (!tab) {
    return ''
  }
  if (tab.type === 'sftp') {
    return 'SFTP'
  }
  if (tab.authType) {
    return 'SSH'
  }
  if (tab.type === 'serial') {
    return 'Serial'
  }
  if (tab.type === 'telnet') {
    return 'Telnet'
  }
  return 'Local'
}

/**
 * 组装状态栏单行文本（便于测试与复用）
 * @param {object|null} tab
 * @returns {string}
 */
export function statusLine (tab) {
  if (!tab) {
    return ''
  }
  const parts = [typeText(tab), tab.host || tab.title || ''].filter(Boolean)
  return parts.join(' · ')
}
