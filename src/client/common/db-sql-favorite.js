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

// 保存（upsert + 内容去重）：带 id 即覆盖；无 id 按归一化 SQL 去重——命中合并，
// 返回 { list, duplicate }（duplicate 为命中的旧条目，null 表示无重复）。
// 失败抛给调用方——编辑弹窗与一键收藏都需要感知保存结果
export function saveFavorite (entry) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'save', entry)
}

// 删除：返回删除后的列表；失败静默（下次打开会再出现，同历史策略）
export function removeFavorite (id) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'remove', { id })
    .catch(() => null)
}

// 分组统计：{ 分组名: 条数 }（默认分组 key 为 ''；含"登记了但还没有条目"的空分组）
export function listGroups () {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'listGroups')
    .catch(() => ({}))
}

// 新建（登记）分组：空分组也立即持久化可见。幂等，重名不报错。
// 返回登记表全量（失败 []）
export function createFavoriteGroup (name) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'createGroup', { name })
    .catch(() => [])
}

// 重命名分组：返回重命名后的完整列表（失败 null）
export function renameFavoriteGroup (old, next) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'renameGroup', { old, next })
    .catch(() => null)
}

// 删除分组：组内条目移回默认分组（''），不删收藏。返回完整列表（失败 null）
export function deleteFavoriteGroup (name) {
  return window.pre.runGlobalAsync('dbSqlFavoriteOp', 'deleteGroup', { name })
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

// SQL 归一化（与主进程 db-sql-favorites.js normSql 同规则）：
// 连续空白压成单空格 + 转小写 + 去结尾分号。渲染层用它做"是否已收藏"匹配，
// 保证与主进程去重判定同源——格式化（空白/分号/大小写差异）不产生假阴性
export function normSql (sql) {
  return String(sql)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .toLowerCase()
}
