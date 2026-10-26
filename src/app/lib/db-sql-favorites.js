/**
 * SQL 查询收藏（B 批 B-1/B-2/B-4）主进程文件存储。
 * 与 db-sql-history 同策略：存 userData 固定 JSON 文件（userData/db-sql-favorites.json），
 * 不用渲染层 localStorage——UI server 动态端口导致 origin 漂移，跨启动互相隔离。
 * 仅存 id/标题/语句/引擎/更新时间——白名单过滤，密码/连接串等任何额外字段一律丢弃。
 * 上限 500 条；filePath 由调用方（ipc.js）传入，便于测试用临时目录隔离。
 * B-4 导入导出：JSON 文件往返（团队共享），重复 id 覆盖而非追加。
 */

const fs = require('fs')
const path = require('path')

const MAX = 500

function readFile (filePath) {
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    // 不存在/损坏/半截写：视作无收藏（辅助功能，不干扰主流程）
    return []
  }
}

function writeFile (filePath, list) {
  // 原子写：先写临时文件再 rename，避免写一半崩溃留半截 JSON
  const tmp = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(list))
  fs.renameSync(tmp, filePath)
}

// 白名单字段过滤：收藏是"标题 + 语句"两条信息，多余字段（连接串/密码/任意大对象）
// 一律不落盘——这也是 B-4 团队共享 JSON 不含凭据的保障点
function pickEntry (entry) {
  return {
    id: String(entry.id || ''),
    title: String(entry.title || '').slice(0, 200),
    sql: String(entry.sql || ''),
    dbType: entry.dbType || '',
    ts: Number(entry.ts) || Date.now()
  }
}

function listFavorites (filePath) {
  return readFile(filePath)
}

// 无 id 时生成：毫秒 ts + 随机后缀，同毫秒多次保存也不撞
function genId () {
  return 'fav-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

// 保存（upsert）：有 id 且已存在则整体覆盖（ts 刷新为更新时间），
// 否则插到最前。返回更新后的完整列表，渲染层直接 setState 免二次 list
function saveFavorite (entry, filePath) {
  if (!entry || !entry.sql) {
    return listFavorites(filePath)
  }
  const list = readFile(filePath)
  const item = pickEntry(entry)
  if (!item.id) {
    item.id = genId()
  }
  item.ts = Number(entry.ts) || Date.now()
  const idx = list.findIndex(x => x.id === item.id)
  if (idx > -1) {
    list.splice(idx, 1)
  }
  list.unshift(item)
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 磁盘满等：静默降级，返回内存结果（下次启动可能丢这条，同历史的已知代价）
  }
  return list
}

function removeFavorite (id, filePath) {
  const list = readFile(filePath)
  const key = String(id || '')
  const idx = list.findIndex(x => x.id === key)
  if (idx > -1) {
    list.splice(idx, 1)
    try {
      writeFile(filePath, list)
    } catch (e) {
      // 静默降级
    }
  }
  return list
}

// B-4 导入：合法条目按 id upsert——重复 id 覆盖（整体替换，以导入文件为准），
// 新 id 追加到头部；非法条目（无 sql / 非对象）跳过。
// 返回 { list, imported, overwritten }，渲染层用于提示"导入 N 条（覆盖 M 条）"
function importFavorites (items, filePath) {
  const list = readFile(filePath)
  const arr = Array.isArray(items) ? items : []
  let imported = 0
  let overwritten = 0
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || !raw.sql) {
      continue
    }
    const item = pickEntry(raw)
    if (!item.id) {
      item.id = genId()
    }
    const idx = list.findIndex(x => x.id === item.id)
    if (idx > -1) {
      list.splice(idx, 1)
      overwritten++
    } else {
      imported++
    }
    list.unshift(item)
  }
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 静默降级
  }
  return { list: list.slice(0, MAX), imported, overwritten }
}

// B-4 导出：把渲染层给的收藏列表（通常就是当前 list）写成 JSON 文件。
// 过 pickEntry 白名单——即使用户手改过内存对象，落盘文件也绝不含凭据类字段。
// 返回写入条数
function exportFavorites (items, filePath) {
  const arr = Array.isArray(items) ? items : []
  const cleaned = arr
    .filter(x => x && typeof x === 'object' && x.sql)
    .map(x => pickEntry(x))
  const tmp = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2))
  fs.renameSync(tmp, filePath)
  return cleaned.length
}

// 读外部导入文件：解析失败/结构不对返回 null（渲染层提示文件无效）
function readImportFile (filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(data) ? data : null
  } catch (e) {
    return null
  }
}

module.exports = {
  MAX,
  listFavorites,
  saveFavorite,
  removeFavorite,
  importFavorites,
  exportFavorites,
  readImportFile
}
