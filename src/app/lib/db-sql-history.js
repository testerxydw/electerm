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

// 相邻重复不叠加（连续重跑同一语句只保留一条）
function appendSqlHistory (entry, filePath) {
  if (!entry || !entry.sql) {
    return
  }
  const list = readFile(filePath)
  const item = pickEntry(entry)
  if (list.length && list[0].sql === item.sql) {
    return
  }
  list.unshift(item)
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 磁盘满等：历史属辅助功能，静默降级
  }
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
  clearSqlHistory
}
