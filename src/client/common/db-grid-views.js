/**
 * 结果集视角配置（数据库页 E2）前端接口。
 * 存储在主进程固定文件（userData/db-grid-views.json），经 IPC 白名单通道
 * `dbGridViewOp` 读写——不用渲染层 localStorage：UI server 动态端口导致
 * origin 漂移，localStorage 跨启动互相隔离，视角配置会读空
 * （同 db-sql-history.js 记下的那条教训）。
 *
 * 存的是"怎么查"（条件/排序/页大小/列布局），不是查询结果：
 * 结果无界、会过期、可能含敏感行数据。
 *
 * 键格式 `<conn>|<db>|<schema>|<table>`，由 db-grid-view.js 的 viewKey 生成，
 * 本层原样透传给主进程，不做任何改写（两边必须逐字符一致）。
 *
 * 全接口异步；失败静默降级（视角属辅助功能，不能让结果集渲染崩掉），
 * 失败时 console.warn 留痕便于现场排查。
 */

// 全量视角表：返回 { '<conn>|<db>|<schema>|<table>': view }。
// 失败与成功同形态（都是 {}）——调用方不需要区分"空数组"与"空对象"，
// 否则边界判断会出现两套写法，而 `Object.keys([])` 恰好也对，
// 这种不对称永远不会在测试里暴露，只会在某天 `views[key]` 静默拿到 undefined。
export async function listGridViews () {
  try {
    const r = await window.pre.runGlobalAsync('dbGridViewOp', 'list')
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {}
  } catch (e) {
    console.warn('load db grid views failed:', e)
    return {}
  }
}

// 单条视角：未命中/失败返回 null（调用方据此使用默认视图）
export async function getGridView (key) {
  if (!key) {
    return null
  }
  try {
    const r = await window.pre.runGlobalAsync('dbGridViewOp', 'get', { key })
    return r && typeof r === 'object' ? r : null
  } catch (e) {
    console.warn('load db grid view failed:', e)
    return null
  }
}

// 保存：主进程做白名单裁剪 + updatedAt 覆盖 + LRU 淘汰，返回落盘后的 view。
// 失败返回 null，调用方保留内存里的乐观结果（本会话仍可用，只是下次启动记不住）
export async function saveGridView (key, view) {
  if (!key) {
    return null
  }
  try {
    const r = await window.pre.runGlobalAsync('dbGridViewOp', 'save', { key, view })
    return r && typeof r === 'object' ? r : null
  } catch (e) {
    console.warn('save db grid view failed:', e)
    return null
  }
}

// 删除：返回是否真的删掉（键不存在时主进程返回 false，属幂等成功）
export async function removeGridView (key) {
  if (!key) {
    return false
  }
  try {
    const r = await window.pre.runGlobalAsync('dbGridViewOp', 'remove', { key })
    return r === true
  } catch (e) {
    console.warn('remove db grid view failed:', e)
    return false
  }
}
