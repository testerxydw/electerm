/**
 * 完整输出归档（`lossless_output/*.bin`）的目录约定、统计与清理。
 *
 * 写入在 server 子进程的 `terminal-output-archive.js`；本模块只服务
 * 「看」与「清」——渲染层永远只递裸文件名与保留天数，不拼路径。
 * 越界判定复用 `session-recordings.resolveInDir`（全仓只此一道闸），
 * 目录名 `ARCHIVE_SUBDIR` 是唯一真源，session-server 建归档目录也用它。
 *
 * 删除走 `fs.rmSync(force)` 直删，不进回收站（AGENTS.md §1：可由代码
 * 再生 / 已归档的产物直删）。
 */

const fs = require('fs')
const path = require('path')
const { resolveInDir } = require('./session-recordings')

// 与 session-server 传给 TerminalOutputArchive 的子目录同名
const ARCHIVE_SUBDIR = 'lossless_output'
const ARCHIVE_EXT = '.bin'
const DAY_MS = 24 * 60 * 60 * 1000
// 设置页概览只需要计数与总量；明细只留最近的若干条，免得几千文件全量回传
const ARCHIVE_LIST_MAX = 200
// 默认保留天数（清理入口的初始值）
const DEFAULT_KEEP_DAYS = 30

function archiveDir (baseDir) {
  return path.join(baseDir, ARCHIVE_SUBDIR)
}

function resolveArchive (dir, name) {
  return resolveInDir(dir, name, ARCHIVE_EXT)
}

function scanArchive (dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    // 目录还没建（从没连过终端）不是错误，是空归档
    return []
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith(ARCHIVE_EXT)) {
      continue
    }
    let st
    try {
      st = fs.statSync(path.join(dir, name))
    } catch (e) {
      // 列完就被删了：跳过这一条
      continue
    }
    if (!st.isFile()) {
      continue
    }
    files.push({ name, size: st.size, mtimeMs: st.mtimeMs })
  }
  return files
}

function listArchive (dir, limit = ARCHIVE_LIST_MAX) {
  const files = scanArchive(dir)
  let bytes = 0
  for (const f of files) {
    bytes += f.size
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return {
    dir,
    count: files.length,
    bytes,
    files: limit > 0 ? files.slice(0, limit) : files
  }
}

// 纯函数：返回应当清理的文件。days <= 0 表示全部，非法值表示不清理。
function selectExpired (files, { now = Date.now(), days = DEFAULT_KEEP_DAYS } = {}) {
  const d = Number(days)
  if (!Number.isFinite(d)) {
    return []
  }
  const list = Array.isArray(files) ? files : []
  if (d <= 0) {
    return list.slice()
  }
  const cutoff = now - d * DAY_MS
  return list.filter(f => f.mtimeMs < cutoff)
}

function cleanArchive (dir, { days = DEFAULT_KEEP_DAYS, now = Date.now() } = {}) {
  const targets = selectExpired(scanArchive(dir), { now, days })
  let removed = 0
  let freedBytes = 0
  for (const f of targets) {
    try {
      fs.rmSync(resolveArchive(dir, f.name), { force: true })
      removed += 1
      freedBytes += f.size
    } catch (e) {
      // 单个文件删不掉不影响其余；失败数由 removed 与 targets 差额体现
    }
  }
  return {
    removed,
    freedBytes,
    failed: targets.length - removed
  }
}

module.exports = {
  ARCHIVE_SUBDIR,
  ARCHIVE_EXT,
  ARCHIVE_LIST_MAX,
  DEFAULT_KEEP_DAYS,
  archiveDir,
  resolveArchive,
  listArchive,
  selectExpired,
  cleanArchive
}
