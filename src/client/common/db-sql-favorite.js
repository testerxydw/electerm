/**
 * SQL 查询收藏（B 批）前端接口。与 db-sql-history.js 同构：
 * 存储在主进程固定文件（userData/db-sql-favorites.json），
 * 经 IPC 白名单通道 dbSqlFavoriteOp 读写，跨启动稳定、不含凭据。
 * 全接口异步；列表/删除失败静默降级（辅助功能，不干扰主流程）。
 */

// 列表：失败/空时返回 []
export async function listFavorites () {
  try {
    const r = await window.pre.runGlobalAsync('dbSqlFavoriteOp', 'list')
    return Array.isArray(r) ? r : []
  } catch (e) {
    console.warn('load sql favorites failed:', e)
    return []
  }
}

// 保存（upsert，带 id 即覆盖）：失败抛给调用方——编辑弹窗需要感知保存失败
export function saveFavorite (entry) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'save', entry)
}

// 删除：返回删除后的列表；失败静默（下次打开会再出现，同历史策略）
export function removeFavorite (id) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'remove', { id })
    .catch(() => null)
}

// 导出：filePath 来自渲染层 window.api.saveDialog（用户自选），主进程写文件。
// 返回写入条数
export function exportFavorites (filePath, items) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'exportFile', {
    filePath,
    items
  })
}

// 导入：filePath 来自渲染层 window.api.openDialog；主进程读文件 + id upsert 合并。
// 返回 { list, imported, overwritten }
export function importFavorites (filePath) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'importFile', {
    filePath
  })
}
