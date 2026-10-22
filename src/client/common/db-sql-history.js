/**
 * SQL 执行历史（数据库页 S3-C，设计见 doc/设计-数据库阶段3-2026-10-22.md）
 * 仅存本地 localStorage（环形上限 200 条，超出丢最旧）；
 * 条目 { sql, dbType, dbHost, dbName, ts, ok }——不存结果、不存密码；
 * 相邻重复语句不重复入栈；失败语句也记录（ok:false）。
 */

const KEY = 'electerm-db-sql-history'
const MAX = 200

// localStorage 取用统一容错（隐私模式/测试环境无 window 时降级为无存储）
function safeStore () {
  try {
    return window.localStorage
  } catch (e) {
    return null
  }
}

export function listSqlHistory () {
  const ls = safeStore()
  if (!ls) {
    return []
  }
  try {
    const arr = JSON.parse(ls.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    // 损坏的存储内容视作无历史（辅助功能，不干扰主流程）
    return []
  }
}

export function appendSqlHistory (entry) {
  if (!entry || !entry.sql) {
    return
  }
  const ls = safeStore()
  if (!ls) {
    return
  }
  const list = listSqlHistory()
  // 相邻重复不叠加（连续重跑同一语句只保留一条）
  if (list.length && list[0].sql === entry.sql) {
    return
  }
  list.unshift({
    ...entry,
    ts: entry.ts || Date.now()
  })
  try {
    ls.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch (e) {
    // 配额满等异常：历史属辅助功能，静默降级
  }
}

export function clearSqlHistory () {
  const ls = safeStore()
  if (!ls) {
    return
  }
  try {
    ls.removeItem(KEY)
  } catch (e) {
    // 同上：静默降级
  }
}
