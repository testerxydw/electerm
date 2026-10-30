/**
 * G2：会话录制（`.cast`）文件的列目录 / 读取 / 删除。
 *
 * 格式解析不在这里——那是渲染层 `cast-parser.js` 唯一的出口，
 * 两边各懂一遍 cast 格式必然漂移，这里只搬字节。
 *
 * dir 由调用方（ipc.js）传入，便于单测用临时目录隔离。
 * 渲染层只递文件名：`resolveInDir` 是防越界的唯一位置（取 basename + 认 .cast
 * + 解析后仍在目录内），少一道都可能被 `../../` 或别的盘外路径钻过去。
 */

const fs = require('fs')
const path = require('path')

const EXT = '.cast'
// 一次最多列出多少个文件：目录里可能堆了几千个录制
const LIST_MAX = 500
// 整份读取上限：超过只取前段并标 truncated，播放器按"尾部半行"降级处理
const READ_MAX = 30 * 1024 * 1024
// 列表页的探测窗口：首段够拿 header 与首条命令，末段够拿时长
const PROBE_HEAD = 64 * 1024
const PROBE_TAIL = 8 * 1024
// 单次探测的文件数上限（列表分页大小远小于它）
const PROBE_MAX = 100

function resolveInDir (dir, name) {
  const s = String(name || '')
  // 只收裸文件名：带分隔符（含绝对路径）直接拒。
  // 不"顺手取 basename"——那会把 ../x/secret.cast 变成目录里的 secret.cast，
  // 读错文件还不报错，报错才诚实。
  if (!s || s !== path.basename(s)) {
    throw new Error('recording name must be a bare file name')
  }
  if (!s.endsWith(EXT)) {
    throw new Error('recording name must end with ' + EXT)
  }
  const full = path.resolve(dir, s)
  const rel = path.relative(path.resolve(dir), full)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('recording path escapes the log dir')
  }
  return full
}

function listRecordings (dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    // 目录还没建（从没录过）不是错误，是空列表
    return { dir, files: [], total: 0 }
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith(EXT)) {
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
  return { dir, files: files.slice(0, LIST_MAX), total: files.length }
}

// 按字节区间读：切片可能落在多字节字符中间，边界那半个字符会成替换符——
// 对探测来说正是要跳过的"坏行"，对整份读（0..size）则不会发生
function readRange (full, from, to) {
  const fd = fs.openSync(full, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, Math.min(from, size))
    const len = Math.max(0, Math.min(to, size) - start)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, start)
    return { size, text: buf.toString('utf8', 0, n) }
  } finally {
    fs.closeSync(fd)
  }
}

function readRecording (dir, name, maxBytes = READ_MAX) {
  const full = resolveInDir(dir, name)
  const st = fs.statSync(full)
  if (st.size <= maxBytes) {
    return { name, size: st.size, truncated: false, text: fs.readFileSync(full, 'utf8') }
  }
  return { name, size: st.size, truncated: true, text: readRange(full, 0, maxBytes).text }
}

/**
 * 列表页列用的轻量探测：只读首尾两段，不整份进内存。
 * 单个文件读失败只标在该文件上（一个坏文件不该让整页空白）。
 */
function probeRecordings (dir, names, limit = PROBE_MAX) {
  const out = {}
  for (const name of (Array.isArray(names) ? names : []).slice(0, limit)) {
    try {
      const full = resolveInDir(dir, name)
      const size = fs.statSync(full).size
      const head = readRange(full, 0, PROBE_HEAD).text
      const tail = size > PROBE_HEAD ? readRange(full, size - PROBE_TAIL, size).text : ''
      out[name] = { size, head, tail }
    } catch (e) {
      out[name] = { error: e && e.message ? e.message : String(e) }
    }
  }
  return out
}

function deleteRecording (dir, name) {
  const full = resolveInDir(dir, name)
  if (!fs.existsSync(full)) {
    throw new Error('recording not found: ' + name)
  }
  fs.rmSync(full, { force: true })
  return { name, deleted: true }
}

module.exports = {
  EXT,
  LIST_MAX,
  READ_MAX,
  PROBE_HEAD,
  PROBE_TAIL,
  resolveInDir,
  listRecordings,
  readRecording,
  probeRecordings,
  deleteRecording
}
