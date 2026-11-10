/**
 * 数据修改历史（N12c · query edit history）前端接口。
 * 存储在主进程固定文件（userData/db-edit-history.json），经 IPC 白名单通道读写，
 * 策略与 SQL 执行历史（db-sql-history.js）完全一致——不用渲染层 localStorage：
 * UI server 动态端口导致 origin 漂移，跨启动互相隔离。
 *
 * 记录范围：SQL 表数据的写路径（单元格保存 / 插行 / 删行 / 批量改值 / 查找替换 /
 * 变更集统一应用），成功落库后 fire-and-forget 登记；查询、DDL、redis 不进历史。
 * 全接口异步；失败静默降级（历史属辅助功能，不干扰主流程）。
 */

// 与主进程 src/app/lib/db-edit-history.js 的 MAX 对齐。仅用于 UI 说明文案，
// 真正的裁剪在主进程侧；改主进程 MAX 时须同步此处
export const EDIT_HISTORY_MAX = 300

// 列表：失败/空时返回 []（失败时 console 留痕，便于现场排查）
export async function listEditHistory () {
  try {
    const r = await window.pre.runGlobalAsync('dbEditHistoryOp', 'list')
    return Array.isArray(r) ? r : []
  } catch (e) {
    console.warn('load edit history failed:', e)
    return []
  }
}

// 追加：主进程白名单清洗 + 环形裁剪（上限见 EDIT_HISTORY_MAX）；
// fire-and-forget，失败静默（写成功在前，历史登记绝不反向影响主流程）
export function appendEditHistory (entry) {
  if (!entry || !entry.sql) {
    return Promise.resolve()
  }
  return window.pre.runGlobalAsync('dbEditHistoryOp', 'append', entry)
    .catch(() => {})
}

// 单条删除：只传定位用的 (ts, sql)，不让渲染层传下标——
// 列表可能处于筛选状态，下标与存储文件里的位置对不上。
// 返回主进程删除后的完整列表（失败返回 null，调用方保留乐观结果）
export async function removeEditHistory (item) {
  if (!item || !item.sql) {
    return null
  }
  try {
    const r = await window.pre.runGlobalAsync('dbEditHistoryOp', 'remove', {
      ts: item.ts,
      sql: item.sql
    })
    return Array.isArray(r) ? r : null
  } catch (e) {
    console.warn('remove edit history failed:', e)
    return null
  }
}

// 清空
export function clearEditHistory () {
  return window.pre.runGlobalAsync('dbEditHistoryOp', 'clear')
    .catch(() => {})
}

// 导出：filePath 来自渲染层 window.api.saveDialog；主进程白名单清洗后写 JSON。
// 返回写入条数
export function exportEditHistory (filePath, items) {
  return window.pre.runGlobalAsync('dbEditHistoryOp', 'exportFile', {
    filePath,
    items
  })
}
