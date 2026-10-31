/**
 * G5 目录镜像（单向、手动）的差异计算
 *
 * 输入是两端"已经拉平"的目录树：`{ relPath, size, mtimeMs, isDirectory }`，
 * `relPath` 用 `/` 拼接、相对各自的根，不带前导斜杠（采集见 dir-mirror-walk，
 * 两端的路径风格差异在那一层就抹平了，这一层只认 relPath 相等）。
 *
 * 三条口径，都是"宁可少动，不可动错"：
 * - 符号链接不参与镜像：链接指向的东西不在这棵树里，把链接当文件拷一次，
 *   等于在目标机上凭空造一份不属于源目录的内容；采集侧已经过滤，这里再挡一道。
 * - 删除只列**文件**：远端多出的目录留在 `remoteExtra` 里如实报数，
 *   但 `deleteCandidates` 一个目录都不列——递归删目录是另一把锤子，
 *   一次误勾选会把远端整棵子树带走，而镜像的本意是"文件对齐"。
 * - 时间戳拿不到时按大小判：SFTP 的 mtime 是秒级、有些服务端干脆不给；
 *   把它当"不一样"会把整棵树重传一遍，那就不是镜像是重装。
 *   这类跳过单独计数（`noTimestamp`），界面要能说清"这些项只比了大小"。
 *
 * 零依赖、纯函数：同一对输入永远得到逐字节相同的输出（分组内按 relPath 升序），
 * 预演面板才能被单测钉住。
 */

export const MIRROR_MODE = {
  sizeMtime: 'size-mtime',
  sizeOnly: 'size-only'
}

// 大小相同、mtime 差在这里面就算"同一个文件"：FAT 只有 2 秒精度、
// SFTP 协议层的时间戳是秒，两端各自取整后差 1 秒是常态而不是差异。
export const MTIME_TOLERANCE_MS = 2000

const isDir = e => e && (e.isDirectory === true || e.isDirectory === 'true')
const isSymbol = e => !!(e && (e.isSymbolicLink === true || e.isSymbol === true))

// 拿不到就用，拿不到返回 0（而不是 NaN 或 undefined）：后面只问"有没有时间戳"
const numOr0 = v => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const sizeOr = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * relPath 归一：反斜杠换正斜杠，去掉前导 `./` 与 `/`、去掉尾部 `/`。
 * 尾部斜杠要吞掉：本地采集器可能把目录写成 `logs/`，远端列目录给的是 `logs`，
 * 这一层不分隔符风格只认"同一个 relPath 就是同一个东西"。
 */
export function normalizeRelPath (p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  return s.replace(/^\.?\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * 建索引：relPath -> 条目。
 * 同一棵树里重复的 relPath（本地大小写不敏感目录被上游分成两条时会出现）
 * 只保留第一条并计数：后一条既没地方放，也不该悄悄覆盖前一条的判断。
 */
export function indexTree (entries) {
  const map = new Map()
  let duplicates = 0
  for (const e of entries || []) {
    const rel = normalizeRelPath(e && e.relPath)
    if (!rel) {
      continue
    }
    if (map.has(rel)) {
      duplicates++
      continue
    }
    map.set(rel, e)
  }
  return { map, duplicates }
}

const toFile = e => ({
  relPath: normalizeRelPath(e.relPath),
  size: sizeOr(e.size, 0),
  mtimeMs: numOr0(e.mtimeMs)
})

const toDir = e => ({
  relPath: normalizeRelPath(e.relPath),
  depth: normalizeRelPath(e.relPath).split('/').length,
  // 远端同路径上躺着一个文件：mkdir 一定失败，界面得单独说明这一条
  vsFile: false
})

// 父目录排在子目录前：mkdir 是按顺序执行的，反了就会"父目录还不存在"
const byDepthThenName = (a, b) => a.depth - b.depth || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)

const byName = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)

/**
 * 一个本地文件相对远端的同名项该怎么处理。
 * @returns {'create'|'overwrite'|'skip'}
 */
function decideFile (localEntry, remoteEntry, mode) {
  if (!remoteEntry) {
    return 'create'
  }
  const lsize = sizeOr(localEntry.size, NaN)
  const rsize = sizeOr(remoteEntry.size, NaN)
  // 任何一端报不出大小（远端权限不足、stat 失败）都不能算"一样"
  if (!Number.isFinite(lsize) || !Number.isFinite(rsize)) {
    return 'overwrite'
  }
  if (lsize !== rsize) {
    return 'overwrite'
  }
  if (mode === MIRROR_MODE.sizeOnly) {
    return 'skip'
  }
  const lt = numOr0(localEntry.mtimeMs)
  const rt = numOr0(remoteEntry.mtimeMs)
  if (!lt || !rt) {
    // 只比了大小就通过，界面要认这笔账
    return 'skip-size-only'
  }
  return Math.abs(lt - rt) < MTIME_TOLERANCE_MS ? 'skip' : 'overwrite'
}

/**
 * @param {Array} local  源端（要镜像出去的那一侧）拉平后的树
 * @param {Array} remote 目标端拉平后的树
 * @param {Object} opts  {mode=MIRROR_MODE.sizeMtime, deleteExtra=false}
 * @returns 分好组的差异 + 计数 + 待传字节数
 */
export function diffTrees (local, remote, opts = {}) {
  const mode = opts.mode === MIRROR_MODE.sizeOnly ? MIRROR_MODE.sizeOnly : MIRROR_MODE.sizeMtime
  const deleteExtra = opts.deleteExtra === true

  const out = {
    mode,
    deleteExtra,
    create: [],
    overwrite: [],
    skip: [],
    createDirs: [],
    blocked: [],
    remoteExtra: [],
    deleteCandidates: [],
    bytes: 0,
    noTimestamp: 0,
    unknownSize: 0,
    duplicates: 0
  }

  const lIdx = indexTree(local)
  const rIdx = indexTree(remote)
  out.duplicates = lIdx.duplicates + rIdx.duplicates

  for (const [rel, le] of lIdx.map) {
    if (isSymbol(le)) {
      continue
    }
    const re = rIdx.map.get(rel)
    if (isDir(le)) {
      // 远端没有这个目录（或远端同路径是个文件）→ 需要先建
      if (!re || !isDir(re)) {
        const d = toDir(le)
        d.vsFile = !!re
        out.createDirs.push(d)
      }
      continue
    }
    const re2 = re && !isSymbol(re) ? re : undefined
    if (re2 && isDir(re2)) {
      // 远端同路径是个目录：上传只会撞 "Not a file"，列出来让人看见，
      // 而不是塞进 overwrite 里等传输中途报错（那时批次已经开跑了）
      out.blocked.push({ ...toFile(le), reason: 'file-vs-dir' })
      continue
    }
    const verdict = decideFile(le, re2, mode)
    if (verdict === 'create') {
      out.create.push(toFile(le))
    } else if (verdict === 'overwrite') {
      if (!Number.isFinite(sizeOr(le.size, NaN))) {
        out.unknownSize++
      }
      out.overwrite.push(toFile(le))
    } else {
      if (verdict === 'skip-size-only') {
        out.noTimestamp++
      }
      out.skip.push(toFile(le))
    }
  }

  for (const [rel, re] of rIdx.map) {
    if (lIdx.map.has(rel) || isSymbol(re)) {
      continue
    }
    out.remoteExtra.push({ ...toFile(re), isDirectory: isDir(re) })
    // 只把文件列为待删：目录留在报数里，不交给删除那一把锤子
    if (deleteExtra && !isDir(re)) {
      out.deleteCandidates.push({ ...toFile(re), isDirectory: false })
    }
  }

  out.create.sort(byName)
  out.overwrite.sort(byName)
  out.skip.sort(byName)
  out.createDirs.sort(byDepthThenName)
  out.blocked.sort(byName)
  out.remoteExtra.sort(byName)
  out.deleteCandidates.sort(byName)

  out.bytes = out.create.reduce((s, f) => s + f.size, 0) +
    out.overwrite.reduce((s, f) => s + f.size, 0)

  return out
}

/**
 * 预演面板的行：分组 + relPath + 两端大小 + 差异说明。
 * `limit` 是面板的渲染上限（明细可能有几万个文件），`total` 回真实条数，
 * 截断要能被界面说清楚，不能悄悄只显示前 N 条当全部。
 */
export function planRows (diff, opt = {}) {
  const limit = Number.isFinite(opt.limit) && opt.limit > 0 ? Math.floor(opt.limit) : 500
  const rows = []
  const push = (group, items) => {
    for (const it of items) {
      rows.push({ group, ...it })
    }
  }
  push('create', diff.create)
  push('overwrite', diff.overwrite)
  push('createDirs', diff.createDirs)
  push('blocked', diff.blocked)
  push('delete', diff.deleteCandidates)
  push('skip', diff.skip)
  const total = rows.length
  return { rows: rows.slice(0, limit), total, truncated: total > limit, limit }
}

/** 面板顶部那句人话要的数：一次算好，界面不自己拼加总。 */
export function planSummary (diff) {
  const upload = diff.create.length + diff.overwrite.length
  return {
    upload,
    create: diff.create.length,
    overwrite: diff.overwrite.length,
    skip: diff.skip.length,
    createDirs: diff.createDirs.length,
    remoteExtra: diff.remoteExtra.length,
    extraDirs: diff.remoteExtra.filter(e => e.isDirectory).length,
    delete: diff.deleteCandidates.length,
    blocked: diff.blocked.length,
    bytes: diff.bytes,
    noTimestamp: diff.noTimestamp,
    unknownSize: diff.unknownSize,
    duplicates: diff.duplicates,
    // 什么都不用做的判定只在"上传/覆盖/建目录/删除"全空、且没有撞名阻碍时才成立
    clean: upload === 0 && diff.createDirs.length === 0 &&
      diff.deleteCandidates.length === 0 && diff.blocked.length === 0
  }
}

export default {
  MIRROR_MODE,
  MTIME_TOLERANCE_MS,
  normalizeRelPath,
  indexTree,
  diffTrees,
  planRows,
  planSummary
}
