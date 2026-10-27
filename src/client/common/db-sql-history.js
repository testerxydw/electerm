/**
 * SQL 执行历史（数据库页 S3-C）前端接口。
 * 存储在主进程固定文件（userData/db-sql-history.json），经 IPC 白名单通道读写——
 * 不用渲染层 localStorage：UI server 动态端口导致 origin 漂移，跨启动互相隔离。
 * 仅存语句/引擎/库/时间/成败，不存结果、不存密码；环形上限 200 条（主进程侧裁剪）。
 * 全接口异步；失败静默降级（历史属辅助功能，不干扰主流程）。
 */

// 列表：失败/空时返回 []（失败时 console 留痕，便于现场排查）
export async function listSqlHistory () {
  try {
    const r = await window.pre.runGlobalAsync('dbSqlHistoryOp', 'list')
    return Array.isArray(r) ? r : []
  } catch (e) {
    console.warn('load sql history failed:', e)
    return []
  }
}

// 追加：主进程做相邻去重与 200 条环形裁剪；fire-and-forget，失败静默
export function appendSqlHistory (entry) {
  if (!entry || !entry.sql) {
    return Promise.resolve()
  }
  return window.pre.runGlobalAsync('dbSqlHistoryOp', 'append', entry)
    .catch(() => {})
}

// 单条删除：只传定位用的 (sql, ts)，不让渲染层传下标——
// 列表可能处于筛选状态，下标与存储文件里的位置对不上。
// 返回主进程删除后的完整列表（失败返回 null，调用方保留乐观结果）
export async function removeSqlHistory (item) {
  if (!item || !item.sql) {
    return null
  }
  try {
    const r = await window.pre.runGlobalAsync('dbSqlHistoryOp', 'remove', {
      sql: item.sql,
      ts: item.ts
    })
    return Array.isArray(r) ? r : null
  } catch (e) {
    console.warn('remove sql history failed:', e)
    return null
  }
}

// 清空
export function clearSqlHistory () {
  return window.pre.runGlobalAsync('dbSqlHistoryOp', 'clear')
    .catch(() => {})
}

// 导出：filePath 来自渲染层 window.api.saveDialog；主进程白名单清洗后写 JSON。
// 返回写入条数
export function exportSqlHistory (filePath, items) {
  return window.pre.runGlobalAsync('dbSqlHistoryOp', 'exportFile', {
    filePath,
    items
  })
}
