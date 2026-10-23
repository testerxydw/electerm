/**
 * SQL 执行历史（数据库页 S3-C）主进程文件存储。
 * 为何不用渲染层 localStorage：UI 经 http://127.0.0.1:<动态端口> 加载，
 * 端口漂移导致 origin 变化、localStorage 互相隔离，历史跨启动读空；
 * 改存 userData 下固定 JSON 文件，与 origin 无关。
 * 仅存语句/引擎/库/时间/成败——不存结果、不存密码。
 * filePath 由调用方（ipc.js）传入，便于测试用临时目录隔离。
 */

const fs = require('fs')
const path = require('path')

const MAX = 200

function readFile (filePath) {
  try {
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]')
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    // 不存在/损坏/半截写：视作无历史（辅助功能，不干扰主流程）
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

// 白名单字段过滤：防渲染层塞任意大对象/敏感字段进存储文件
function pickEntry (entry) {
  return {
    sql: String(entry.sql || ''),
    dbType: entry.dbType || '',
    dbHost: entry.dbHost || '',
    dbName: entry.dbName || '',
    ok: entry.ok === true,
    ts: Number(entry.ts) || Date.now()
  }
}

function listSqlHistory (filePath) {
  return readFile(filePath)
}

// 归一化 SQL 作去重键：连续空白（含换行/缩进）压成单空格。
// 格式化只改空白布局，归一化后同一语句等价——格式化前后不产生两条历史
function normSql (sql) {
  return String(sql).replace(/\s+/g, ' ').trim()
}

// 全局去重 + MRU：归一化后命中的旧条目移除，新条目置顶（ts=最后执行时间）；
// 同语句换库重跑也按同一条合并（历史是"语句"维度，非"语句×库"维度）
function appendSqlHistory (entry, filePath) {
  if (!entry || !entry.sql) {
    return
  }
  const list = readFile(filePath)
  const item = pickEntry(entry)
  const key = normSql(item.sql)
  const idx = list.findIndex(x => normSql(x.sql) === key)
  if (idx > -1) {
    list.splice(idx, 1)
  }
  list.unshift(item)
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 磁盘满等：历史属辅助功能，静默降级
  }
}

// 单条删除：按 (ts + 归一化 sql) 定位，返回删除后的完整列表。
//
// 为什么不用下标：渲染层拿到的可能是"筛选后"的子集，下标对不上存储文件里的位置
// （筛选状态删第 2 条，存储里该删的可能是第 37 条）。ts 是"最后执行时间"，
// 经去重合并后天然唯一，可当主键；sql 归一化再比一次，防止 ts 被改成字符串/
// 丢精度后删掉隔壁那条。
function removeSqlHistory (entry, filePath) {
  const list = readFile(filePath)
  if (!entry || !entry.sql) {
    return list
  }
  const key = normSql(entry.sql)
  const ts = Number(entry.ts)
  let idx = list.findIndex(x => Number(x.ts) === ts && normSql(x.sql) === key)
  if (idx < 0) {
    // ts 对不上（旧文件被手改 / 精度丢失）：退化为只按语句删。
    // 宁可删到一条同语句的旧记录，也好过用户点了 X 毫无反应
    idx = list.findIndex(x => normSql(x.sql) === key)
  }
  if (idx < 0) {
    return list
  }
  list.splice(idx, 1)
  try {
    writeFile(filePath, list)
  } catch (e) {
    // 磁盘满等：静默降级。返回内存里的结果，UI 至少不会"点了没反应"；
    // 下次启动可能又读到这条（写失败的已知代价，不为它加补丁逻辑）
  }
  return list
}

function clearSqlHistory (filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (e) {
    // 同上：静默降级
  }
}

module.exports = {
  listSqlHistory,
  appendSqlHistory,
  removeSqlHistory,
  clearSqlHistory
}
