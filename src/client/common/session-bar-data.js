/**
 * 会话顶栏数据汇聚 (session-bar-status.jsx 的唯一数据来源):
 * - 后端经 session socket 上报的 action 消息 (ssh-handshake-info / shell-info)
 *   由 attach addon 的 onMsg 拦截后交给 handleSessionControlMessage 写入
 *   store.sessionInfoMap, 全项目仅此一处写入
 * - tab 关闭时调 clearSessionInfo 清理, 防泄漏
 */

// 顶栏消费的 action 消息集合; 返回 true 表示消息已被消费 (调用方应停止透传)
export function handleSessionControlMessage (msg, tabId) {
  if (!msg || !msg.action || !tabId) {
    return false
  }
  const { store } = window
  if (!store || !store.sessionInfoMap) {
    return false
  }
  if (msg.action === 'ssh-handshake-info' && msg.update) {
    store.sessionInfoMap[tabId] = {
      ...store.sessionInfoMap[tabId],
      ...msg.update
    }
    return true
  }
  if (msg.action === 'shell-info' && msg.update) {
    store.sessionInfoMap[tabId] = {
      ...store.sessionInfoMap[tabId],
      ...msg.update
    }
    return true
  }
  return false
}

// tab 关闭 / 会话重建时清理该 tab 的全部顶栏数据
export function clearSessionInfo (tabId) {
  if (!tabId) {
    return
  }
  const { store } = window
  if (store?.sessionInfoMap?.[tabId]) {
    delete store.sessionInfoMap[tabId]
  }
}
