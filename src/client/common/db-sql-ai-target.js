/**
 * 「AI → SQL 编辑器」目标登记表（按 tab id 索引）
 *
 * 为什么需要它：AI 侧（对话面板的代码块、生成弹层）要知道"把这段 SQL 落到哪个编辑器"，
 * 但编辑器句柄在数据库会话页组件内部。以前只有一条 setPrompt + setTimeout 的单行道，
 * 反向没有出口。这里放一张按 tab id 索引的表：会话页挂载时登记、卸载时注销，
 * AI 侧只按当前活动 tab 查，查不到就把动作禁用——不做"自动切到某个数据库 tab"
 * 这种带副作用的行为。
 *
 * 登记内容是一组回调（不是 React 节点），组件可以自由演进；契约里最关键的一条是
 * **只写编辑器、不执行**：没有 runSql，也就没有绕过危险 SQL 闸门的路径。
 */

const targets = new Map()

/**
 * 登记一个 SQL 编辑器目标。
 * @param {string|number} tabId 数据库会话 tab 的 id
 * @param {object} target {
 *   insertSql(text, plan)  按策略把文本落到编辑器（内部走 CM6 dispatch，保留撤销栈）
 *   getDocText()           当前编辑器全文（与选区区间同一份文档）
 *   getSelection()         { text, range: {start, end} | null }
 *   getContext()           { dbType, database, schema, table, columns, readOnly }
 *   getResultSnapshot()    屏幕上那份结果集（{source, results, ...}）；没有返回 null
 *   isAvailable()          编辑器是否已就绪（懒加载未完成时返回 false）
 * }
 */
export function registerSqlTarget (tabId, target) {
  if (tabId === undefined || tabId === null || !target) {
    return
  }
  targets.set(tabId, target)
}

/**
 * 注销。带 target 时只删"自己这一份"：React 严格模式/热更下会先注册新句柄再跑
 * 旧 effect 的清理，无条件按 tabId 删除会把刚登记的句柄删掉。
 */
export function unregisterSqlTarget (tabId, target) {
  if (targets.get(tabId) === target) {
    targets.delete(tabId)
  } else if (target === undefined) {
    targets.delete(tabId)
  }
}

export function getSqlTarget (tabId) {
  return targets.get(tabId) || null
}

/** 就绪判定：登记了不等于编辑器起来了（SqlCodeEditor 是懒挂载的） */
export function isSqlTargetReady (tabId) {
  const t = targets.get(tabId)
  if (!t) {
    return false
  }
  return typeof t.isAvailable !== 'function' ? true : !!t.isAvailable()
}

/**
 * 当前活动 tab 的目标。找不到返回 null——调用方据此禁用动作并说明原因。
 * 只在浏览器里读 window.store；单测可直接按 tabId 用 getSqlTarget。
 */
export function getActiveSqlTarget () {
  const store = typeof window !== 'undefined' ? window.store : null
  const tabId = store && store.activeTabId
  if (tabId === undefined || tabId === null) {
    return null
  }
  return targets.get(tabId) || null
}

export function getActiveSqlTargetReady () {
  const store = typeof window !== 'undefined' ? window.store : null
  const tabId = store && store.activeTabId
  if (tabId === undefined || tabId === null) {
    return null
  }
  return isSqlTargetReady(tabId) ? targets.get(tabId) : null
}
