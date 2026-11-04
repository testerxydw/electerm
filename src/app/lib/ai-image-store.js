/**
 * AI 图片本体的磁盘缓存（设计 §6-11 / 台账 S2-2）
 *
 * 为什么要落盘：渲染层的内存缓存（`ai-image-cache.js`）一重启就空，于是历史里的图片
 * 永远显示"已过期"，而再次提问时那条消息只会带上占位文本——用户以为模型又看了一次
 * 截图，其实一个字都没看。磁盘这一层让"上周那张图"在整个保留期里都真的还能被引用。
 *
 * 目录固定用 appData 下的独立子目录，不走渲染层 localStorage：UI 经
 * http://127.0.0.1:<动态端口> 加载，端口漂移会让 origin 变化（同 db-sql-history.js）。
 * 一张图一个 `<id>.data` 文件，内容就是那段 `data:image/...;base64,...` 文本；
 * 不建 index.json：清单靠 stat 目录就够（字节数 = 文件大小，LRU = mtime，读一次 touch 一次），
 * 多一份索引就多一个会和目录不一致的真相。名字/尺寸/宽高这些元数据在 AI 历史条目里已经有，
 * 这里只负责字节。
 *
 * 三道闸门（都按"最久没被引用先走"）：总量配额、条数上限、保留期。回收既在启动后第一次
 * 用到时补跑一次，也在每次写入后跑——写入是唯一天然知道"刚涨了多少"的时机。
 */

const fs = require('fs')
const path = require('path')

const EXT = '.data'

// 60 MB：按压缩后 1 MB/张算，够留几十张截图；上限存在的意义是"再用一年也不会把盘吃掉"
const MAX_STORE_BYTES = 60 * 1024 * 1024
// 条数上限独立于字节：一堆小图同样能把目录变成几千个文件，stat 也会变慢
const MAX_STORE_COUNT = 200
// 保留期：14 天没被任何一次请求引用过，就当作不再需要
const MAX_STORE_AGE_MS = 14 * 24 * 60 * 60 * 1000
// 单张兜底：渲染层归一化时已有 1 MB 闸门，这里防的是绕过它写进来的异常图
const MAX_SINGLE_BYTES = 4 * 1024 * 1024

// uid() 生成的 id 就是 [A-Za-z0-9_-] 加日期，但 id 来自渲染层：只允许"看起来像文件名"的串，
// 并且第一个字符不能是 . —— 挡掉 '..'、'.隐藏'、'.//x' 这一类，目录里也不会多出别的东西
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function safeId (id) {
  const s = String(id === undefined || id === null ? '' : id)
  return ID_RE.test(s) ? s : ''
}

function fileFor (dir, id) {
  const s = safeId(id)
  if (!s) {
    throw new Error('ai-image-store: invalid image id')
  }
  return path.join(dir, s + EXT)
}

function dataUrlBytes (dataUrl) {
  const s = String(dataUrl || '')
  const i = s.indexOf(',')
  const b64 = i >= 0 ? s.slice(i + 1) : s
  if (!b64.length) {
    return 0
  }
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0)
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad)
}

function toEntry (dir, name, st) {
  return {
    id: name.slice(0, -EXT.length),
    bytes: Number(st.size) || 0,
    // mtime 就是"最后一次被引用"：读一次会 touch 一次（见 readImage）
    mtimeMs: Math.round(Number(st.mtimeMs) || 0)
  }
}

/**
 * 目录清单（只 stat，不读内容）。按最久未引用 → 最近引用排序，
 * 与内存层 `cachedImageIds()` 的口径一致，调用方不用自己再排。
 */
function listImages (dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    // 目录还没建（一次图片都没存过）——空清单，不是错误
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith(EXT) || !safeId(name.slice(0, -EXT.length))) {
      continue
    }
    try {
      out.push(toEntry(dir, name, fs.statSync(path.join(dir, name))))
    } catch (e) {
      // 正在被并发回收的文件：跳过这一次
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

/**
 * 纯决策：给一批 {id, bytes, mtimeMs} 与闸门，算出该删哪些。
 * 不碰 fs，单测直接喂假条目与假时钟。
 * 顺序：先按保留期砍（过期的留着也没意义），再从"最久未引用"开始砍到配额与条数都满足。
 */
function planEvictions (entries, {
  now = Date.now(),
  budget = MAX_STORE_BYTES,
  maxCount = MAX_STORE_COUNT,
  maxAgeMs = MAX_STORE_AGE_MS
} = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(x => ({
      id: safeId(x && x.id),
      bytes: Math.max(0, Number(x && x.bytes) || 0),
      mtimeMs: Math.max(0, Number(x && x.mtimeMs) || 0)
    }))
    .filter(x => x.id)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  const remove = []
  const keep = []
  for (const x of list) {
    if (maxAgeMs > 0 && now - x.mtimeMs > maxAgeMs) {
      remove.push(x.id)
      continue
    }
    keep.push(x)
  }
  // 条数与字节都从最久未引用的开始丢；keep 已经是升序，直接从头切
  while (keep.length > maxCount) {
    remove.push(keep.shift().id)
  }
  let total = keep.reduce((s, x) => s + x.bytes, 0)
  // eslint-disable-next-line no-unmodified-loop-condition -- budget 是入参常量，收敛靠 total 递减
  while (budget > 0 && total > budget && keep.length) {
    const gone = keep.shift()
    total -= gone.bytes
    remove.push(gone.id)
  }
  return { remove, keep, bytes: total }
}

// 每个目录只补跑一次启动回收：第一次用到（含 list）时才扫，避免给启动加一次目录遍历
const swept = new Set()

function sweep (dir, opts = {}) {
  const entries = listImages(dir)
  const plan = planEvictions(entries, opts)
  for (const id of plan.remove) {
    try {
      fs.rmSync(fileFor(dir, id), { force: true })
    } catch (e) {
      // 删不掉（权限/正被占用）就留着，下次再试：回收是尽力而为，不阻断请求
    }
  }
  return {
    removed: plan.remove,
    count: plan.keep.length,
    bytes: plan.bytes
  }
}

function ensureSwept (dir, opts) {
  if (swept.has(dir)) {
    return null
  }
  swept.add(dir)
  return sweep(dir, opts)
}

function putImage (dir, record) {
  const rec = record || {}
  // id 来自渲染层：非法 id 走返回值而不是抛错，IPC 那层才能把它当"这一次没存上"
  let file
  try {
    file = fileFor(dir, rec.id)
  } catch (e) {
    return { ok: false, reason: 'invalid-id' }
  }
  const dataUrl = String(rec.dataUrl || '')
  if (!dataUrl.startsWith('data:')) {
    return { ok: false, reason: 'not-data-url' }
  }
  const bytes = dataUrlBytes(dataUrl)
  if (!bytes) {
    return { ok: false, reason: 'empty' }
  }
  if (bytes > MAX_SINGLE_BYTES) {
    return { ok: false, reason: 'over-single' }
  }
  ensureSwept(dir)
  if (bytes > MAX_STORE_BYTES) {
    // 一张就超总额：写进去会立刻把自己挤掉，用户看到的是"刚存就没了"
    return { ok: false, reason: 'over-budget' }
  }
  const tmp = file + '.tmp'
  fs.mkdirSync(dir, { recursive: true })
  // 原子写：半截 base64 比没写更糟——它会通过 startsWith('data:') 检查却解不出图
  fs.writeFileSync(tmp, dataUrl)
  fs.renameSync(tmp, file)
  const sweptNow = sweep(dir)
  return {
    ok: true,
    id: safeId(rec.id),
    bytes,
    count: sweptNow.count,
    totalBytes: sweptNow.bytes,
    evicted: sweptNow.removed
  }
}

function readImage (dir, id) {
  let file
  try {
    file = fileFor(dir, id)
  } catch (e) {
    return null
  }
  ensureSwept(dir)
  let dataUrl
  try {
    dataUrl = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
  const now = new Date()
  try {
    // 引用即续期：保留期按"最后一次被用到"算，而不是"哪天存进来的"
    fs.utimesSync(file, now, now)
  } catch (e) {
    // 续期失败不影响这次读取
  }
  return { id: safeId(id), dataUrl }
}

function deleteImage (dir, id) {
  let file
  try {
    file = fileFor(dir, id)
  } catch (e) {
    return false
  }
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch (e) {
    return false
  }
}

function clearImages (dir) {
  const removed = listImages(dir).map(x => x.id)
  for (const id of removed) {
    try {
      fs.rmSync(fileFor(dir, id), { force: true })
    } catch (e) {
      // 同上：清不掉就如实反映在返回值里
    }
  }
  swept.add(dir)
  return { removed: removed.length }
}

module.exports = {
  EXT,
  MAX_STORE_BYTES,
  MAX_STORE_COUNT,
  MAX_STORE_AGE_MS,
  MAX_SINGLE_BYTES,
  safeId,
  dataUrlBytes,
  listImages,
  planEvictions,
  sweep,
  putImage,
  readImage,
  deleteImage,
  clearImages
}
