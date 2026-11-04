/**
 * AI 面板的「会话来源上下文」提示（P-4，拍板口径：只做提示，不做绑定）
 *
 * 背景：右侧 AI 面板是全局单例，一次会话可以在数据库页问"这条 SQL / 这张表"，
 * 也可以切到别的页签接着问。会话内容里带着上一轮的库表名，切了页签之后这些名字
 * 就属于另一个连接了 —— 用户看不见"现在在说哪张表"，只能靠回忆。
 *
 * 为什么不绑定：把会话和页签绑死要动请求链路（每次发送按页签取连接、切页签自动换
 * 会话、多页签各自一份会话历史），代价与收益不匹配，而且用户拍板"只做提示"。
 * 这里只把递交那一刻的来源记成一条**只读快照**跟着历史条目走，界面据此提示；
 * 不改变"当前是哪个页签"，不参与任何请求组装。
 *
 * 快照记的是递交时的现值（页签标题、库/模式/表、方言），不是引用：
 * 页签后面被改名、关掉、表被刷新都不影响已经发生过的那次递交的说明。
 */

export const KIND_DB = 'db'
export const KIND_TERM = 'term'

// 递交方把自己的上下文压成快照。ctx 是数据库页那份 sqlAiCtx（dbType/database/
// schema/table），缺哪项就不显示哪项 —— "还没选表"是常态，不是错误。
export const buildDbAiSource = (tab, ctx = {}) => {
  if (!tab || !tab.id) {
    return null
  }
  return {
    kind: KIND_DB,
    tabId: tab.id,
    tabTitle: tab.title || tab.host || '',
    host: tab.host || '',
    dialect: ctx.dbType || tab.dbType || '',
    database: ctx.database || '',
    schema: ctx.schema || '',
    table: ctx.table || ''
  }
}

// 终端侧（"解释这段输出"）没有库表概念，来源就是那个页签本身
export const buildTermAiSource = tab => {
  if (!tab || !tab.id) {
    return null
  }
  return {
    kind: KIND_TERM,
    tabId: tab.id,
    tabTitle: tab.title || tab.host || '',
    host: tab.host || '',
    dialect: '',
    database: '',
    schema: '',
    table: ''
  }
}

// 库.模式.表：三段都可能为空（MySQL 没有模式层、Redis 只有库号），
// 只把非空的按顺序点起来，避免出现 "db..table" 或孤零零一个点
export const aiSourceScope = source => {
  if (!source) {
    return ''
  }
  return [source.database, source.schema, source.table].filter(Boolean).join('.')
}

/**
 * 本会话的来源上下文 = 最近一条带来源的历史条目。
 * 历史是追加式的，所以按数组顺序取最后一条命中，而不是比 timestamp
 * （压缩/重放会写 timestamp，条目顺序才是用户看到的顺序）。
 */
export const latestAiSource = (history, chatSessionId) => {
  if (!Array.isArray(history) || !chatSessionId) {
    return null
  }
  let hit = null
  for (const entry of history) {
    if (!entry || entry.chatSessionId !== chatSessionId) {
      continue
    }
    if (entry.source) {
      hit = entry.source
    }
  }
  return hit
}

// 只在"知道当前页签、且它确实不是来源那个页签"时报错位：
// 不知道当前页签（比如面板在设置页里）时把每条会话都说成错位，等于没有这条提示
export const isAiSourceStale = (source, currentTabId) => {
  if (!source || !currentTabId) {
    return false
  }
  return source.tabId !== currentTabId
}

/**
 * 展示文案。e 由调用方注入（window.translate），单测里传一张假词典即可断言
 * "用了哪些词条"，不必真加载语言包。返回分好的三段，由界面决定谁加粗谁换行。
 */
export const formatAiSource = (source, e) => {
  if (!source) {
    return null
  }
  const scope = aiSourceScope(source)
  const label = source.tabTitle || source.host
  return {
    title: e('aiSourceContext'),
    where: scope ? label + ' · ' + scope : label,
    // 方言只在数据库来源上出现，终端来源标出来没有信息量
    dialect: source.kind === KIND_DB && source.dialect ? source.dialect : ''
  }
}
