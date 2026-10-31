/**
 * G8 审计中心（主进程侧）：会话日志目录里 `*.log` / `*.cast` 的列目录与尾部读取。
 *
 * 只搬文件，不解读内容：终端日志是原始字节流（带 ANSI 转义、进度条的裸 `\r`），
 * 在这里切命令既不可靠也会把口令一类的内容抄进审计行——去色与呈现都在渲染层
 * （`stripAnsi`），设计 §14.9 的「不做命令级解析」就落在这条线上。
 *
 * 防越界沿用 G2 那一把闸（session-recordings 的 resolveInDir），只是把扩展名
 * 换成 `.log`：两处各写一遍路径校验，迟早漂移成两套。
 *
 * dir 由调用方（ipc.js）传入，单测用临时目录隔离。
 */

const fs = require('fs')
const path = require('path')
const { resolveInDir, readRange, LIST_MAX } = require('./session-recordings')

const LOG_EXT = '.log'
const CAST_EXT = '.cast'
const EXTS = [LOG_EXT, CAST_EXT]

// 默认尾部行数（设计 §14.9 的「日志尾部 500 行」）；渲染层可以要更少，不能要更多
const TAIL_LINES = 500
const TAIL_LINES_MAX = 2000
// 一次最多搬多少字节：先够凑出行数，超出的部分标 truncated 而不是无限读进内存
const TAIL_WINDOW = 1024 * 1024

const LINE_RE = /\r\n|\n|\r/

/** 审计视图要的两种文件都收：`.log` 与 `.cast`，且必须是目录内的裸文件名。 */
function resolveAny (dir, name) {
  const s = String(name || '')
  const ext = EXTS.find(e => s.endsWith(e))
  if (!ext) {
    throw new Error('name must end with ' + EXTS.join(' or '))
  }
  return resolveInDir(dir, s, ext)
}

function listAuditFiles (dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    // 目录还没建（从没开过日志/录制）不是错误，是空列表
    return { dir, files: [], total: 0, exists: false }
  }
  const files = []
  for (const name of names) {
    if (!EXTS.some(e => name.endsWith(e))) {
      continue
    }
    let st
    try {
      st = fs.statSync(path.join(dir, name))
    } catch (e) {
      // 列完就被删了：跳过这一条，不影响整页
      continue
    }
    if (!st.isFile()) {
      continue
    }
    files.push({ name, size: st.size, mtimeMs: st.mtimeMs })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { dir, files: files.slice(0, LIST_MAX), total: files.length, exists: true }
}

/**
 * 读日志尾部。三个边界：
 * - 字节窗口切在第一行中间时**丢掉那半行**（首行缺字符比首行多出半个 ANSI 转义好读）；
 * - 行数上限钳在 TAIL_LINES_MAX：审计面板不是日志 `tail -f`，给更多只会卡渲染层；
 * - `omitted` 只统计窗口里没给出的行，窗口之前的字节有多少行不知道，
 *   靠 `truncated` 说明"这份文件我只读了末尾一段"。
 */
function readLogTail (dir, name, lines = TAIL_LINES) {
  const full = resolveInDir(dir, name, LOG_EXT)
  const st = fs.statSync(full)
  if (!st.isFile()) {
    throw new Error('not a file: ' + name)
  }
  // 只认"至少 1 行"的请求，其余（0/NaN/字符串）一律回落到默认行数
  const n = Number.isFinite(lines) && lines >= 1 ? Math.floor(lines) : TAIL_LINES
  const want = Math.min(n, TAIL_LINES_MAX)
  const window = Math.min(st.size, TAIL_WINDOW)
  const from = st.size - window
  const rows = readRange(full, from, st.size).text.split(LINE_RE)
  if (from > 0) {
    rows.shift()
  }
  // 文件以换行结尾时 split 会多出一个空尾元素
  if (rows.length && rows[rows.length - 1] === '') {
    rows.pop()
  }
  const out = rows.slice(-want)
  return {
    name,
    size: st.size,
    mtimeMs: st.mtimeMs,
    lines: out,
    omitted: Math.max(0, rows.length - out.length),
    truncated: from > 0 || rows.length > out.length
  }
}

module.exports = {
  LOG_EXT,
  CAST_EXT,
  EXTS,
  TAIL_LINES,
  TAIL_LINES_MAX,
  TAIL_WINDOW,
  resolveAny,
  listAuditFiles,
  readLogTail
}
