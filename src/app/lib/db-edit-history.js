/**
 * 数据修改历史（N12c · query edit history）主进程文件存储。
 * 与 SQL 执行历史（db-sql-history.js）同策略：存 userData 固定 JSON 文件，
 * 不用渲染层 localStorage（UI server 动态端口导致 origin 漂移，跨启动互相隔离）。
 *
 * 与 db-sql-history 的关键语义差异（本项存在的原因）：
 * - SQL 历史是"语句"维度，同语句去重合并；编辑历史是"流水"维度——
 *   同一格改两次是两次真实修改，必须各留一条，**不做任何去重**。
 * - 只记写路径（UPDATE/INSERT/DELETE 的参数化 op），查询不进来。
 *
 * 仅存目标表/语句摘要/成败计数/连接识别（dbType/dbHost/dbFile/dbName），
 * 不存绑定值原文以外的结果、不存密码；sql 摘要截断（防大批次撑爆文件）。
 * 环形上限 MAX 条；原子写（tmp + rename）；filePath 由调用方（ipc.js）传入，
 * 便于测试用临时目录隔离。
 */

const fs = require('fs')
const path = require('path')

// 环形上限：编辑历史条目比 SQL 历史重（含目标表与多条语句摘要），取 300。
// 导出供单测跟随断言，避免硬编码
const MAX = 300

// 单条 sql 摘要上限：变更集应用一批可能拼出很长的合并文本，
// 历史是给人回溯的摘要不是全量审计日志，超长截断并留标记
const SQL_MAX = 2000

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

function clipSql (sql) {
  const s = String(sql || '')
  return s.length > SQL_MAX ? s.slice(0, SQL_MAX) + ' …[truncated]' : s
}

// 白名单字段过滤：防渲染层塞任意大对象/敏感字段进存储文件
function pickEntry (entry) {
  return {
    ts: Number(entry.ts) || Date.now(),
    kind: String(entry.kind || ''),
    database: entry.database || '',
    schema: entry.schema || '',
    table: entry.table || '',
    sql: clipSql(entry.sql),
    // n = 真实落库条数，fail = 其中失败/未定条数（0 表示全部成功）
    n: Number(entry.n) || 0,
    fail: Number(entry.fail) || 0,
    ok: entry.ok === true,
    dbType: entry.dbType || '',
    dbHost: entry.dbHost || '',
    // 本地文件引擎（sqlite）没有 host：导出/回溯时全靠这个路径认出是哪库
    dbFile: entry.dbFile || '',
    dbName: entry.dbName || ''
  }
}

function listEditHistory (filePath) {
  // 读侧自愈：过滤坏条目（无 sql 的旧数据/手改残留），仅确有坏条目时回写落盘
  const list = readFile(filePath)
  const cleaned = list.filter(x => x && typeof x === 'object' && x.sql)
  if (cleaned.length !== list.length) {
    try {
      writeFile(filePath, cleaned)
    } catch (e) {
      // 磁盘满等：不影响本次展示，下次读取再试
    }
  }
  return cleaned
}

// 追加：MRU 置顶 + 环形裁剪。刻意不做去重——编辑历史是修改流水，
// 同语句两次执行是两次真实修改（对比 db-sql-history 的语句合并语义）
function appendEditHistory (entry, filePath) {
  if (!entry || !entry.sql) {
    return
  }
  const list = readFile(filePath)
  list.unshift(pickEntry(entry))
  try {
    writeFile(filePath, list.slice(0, MAX))
  } catch (e) {
    // 磁盘满等：历史属辅助功能，静默降级
  }
}

// 单条删除：按 (ts + sql 原文) 定位，返回删除后的完整列表。
// 不用下标：渲染层拿到的可能是筛选后的子集，下标对不上存储位置。
// 编辑历史不去重，(ts, sql) 可能撞（同毫秒同语句摘要）——命中第一条即可，
// 用户连点 X 会把重复条目逐条删掉，行为符合直觉
function removeEditHistory (entry, filePath) {
  const list = readFile(filePath)
  if (!entry || !entry.sql) {
    return list
  }
  const ts = Number(entry.ts)
  const idx = list.findIndex(x => Number(x.ts) === ts && x.sql === entry.sql)
  if (idx < 0) {
    return list
  }
  list.splice(idx, 1)
  try {
    writeFile(filePath, list)
  } catch (e) {
    // 静默降级：返回内存结果，UI 至少不会"点了没反应"
  }
  return list
}

function clearEditHistory (filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (e) {
    // 同上：静默降级
  }
}

// 导出：把渲染层给的（全部/筛选后）列表按白名单清洗写 JSON 文件。
// 渲染层不碰 fs，路径经 saveDialog 在主进程侧由调用方传入，与 SQL 历史导出同策略。
// 返回写入条数
function exportEditHistory (items, filePath) {
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

module.exports = {
  MAX,
  SQL_MAX,
  listEditHistory,
  appendEditHistory,
  removeEditHistory,
  clearEditHistory,
  exportEditHistory
}
