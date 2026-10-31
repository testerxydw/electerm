/**
 * G5 目录镜像（采集层）：把两端一棵目录树拉平成 `diffTrees` 要的条目列表
 *
 * 两端字段长得不一样（本地 `readdirStatAsync` 给 `mtimeMs`，远端 `sftp.list` 给
 * 秒×1000 的 `modifyTime` 和 `type: 'd'|'l'|'-'`），所以这里只认一种中间形状，
 * 两边各写一个几十行的适配器，差异计算层（dir-mirror）永远不用知道路径从哪来。
 *
 * 三条口径：
 * - 广度优先 + 每层按名字排序：遍历顺序只由目录内容决定，不受服务端返回顺序影响，
 *   预演面板和单测才钉得住。
 * - 符号链接不进树、不跟随：跟进去可能绕成环（`a -> ..`），也可能把树外的东西
 *   算成"源目录里有"，镜像过去就是凭空造内容。
 * - `complete` 是执行资格，不是装饰：条目/深度截断、单个目录读失败、用户取消都
 *   会让树"缺一块"。缺一块的源树 + 勾选"删除远端多余项"= 把没扫到的文件当多余删掉。
 *   所以界面只在 complete 时放行删除勾选，执行前也要再看一眼这个标志。
 */

import resolve from './resolve.js'

export const DEFAULT_MAX_ENTRIES = 20000
export const DEFAULT_MAX_DEPTH = 12
const ERR_MSG_MAX = 200

const msg = e => {
  const m = e && (e.message || e.error || String(e))
  const s = String(m == null ? '' : m)
  return s.length > ERR_MSG_MAX ? s.slice(0, ERR_MSG_MAX) + '…' : s
}

const numOr0 = v => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// 权限只在拿得到的时候带：传输层 `options.mode` 认的是 stat 的原始 mode（含类型位），
// 拿不到就留给传输层用远端已有的值，别用 0 当"权限是 000"传过去。
const modeOf = v => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 本地 `readdirStatAsync` 的条目 -> 中间形状。 */
export function localEntryToNode (e) {
  const st = e || {}
  const node = {
    name: st.name,
    size: numOr0(st.size),
    mtimeMs: numOr0(st.mtimeMs),
    isDirectory: st.isDirectory === true,
    isSymbolicLink: st.isSymbolicLink === true
  }
  const mode = modeOf(st.mode)
  if (mode !== undefined) {
    node.mode = mode
  }
  return node
}

/**
 * 远端 `sftp.list` 的条目 -> 中间形状。
 * `modifyTime` 在 session-sftp 里已经归一到毫秒；仍兼容只有秒级 `mtime` 的后端
 * （小于 1e11 的数当秒处理：毫秒时间戳早就过了这个量级，秒时间戳还没）。
 */
export function remoteEntryToNode (e) {
  const it = e || {}
  const raw = it.modifyTime == null ? it.mtimeMs : it.modifyTime
  let mtimeMs = numOr0(raw)
  if (mtimeMs > 0 && mtimeMs < 1e11) {
    mtimeMs = mtimeMs * 1000
  }
  const node = {
    name: it.name,
    size: numOr0(it.size),
    mtimeMs,
    isDirectory: it.type === 'd' || it.isDirectory === true,
    isSymbolicLink: it.type === 'l' || it.isSymbolicLink === true || it.isSymbol === true
  }
  const mode = modeOf(it.mode)
  if (mode !== undefined) {
    node.mode = mode
  }
  return node
}

const byName = (a, b) => {
  const an = String(a && a.name == null ? '' : a.name)
  const bn = String(b && b.name == null ? '' : b.name)
  if (an === bn) {
    return 0
  }
  return an < bn ? -1 : 1
}

// `.` / `..` 不该出现在列表里，出现了也不能当成一个文件去镜像
const isRealName = n => typeof n === 'string' && n.length > 0 && n !== '.' && n !== '..'

// readdir 项可能是 null（悬链被采集端丢掉了），先滤掉再进 mapEntry
const isRealEntry = e => !!e && isRealName(e.name)

/** 采集压根没跑起来的返回值：和"跑完但缺一块"共用一个形状，界面不用分支。 */
function emptyWalk (root, message) {
  return {
    root: typeof root === 'string' ? root : '',
    entries: [],
    errors: [{ relPath: '', path: root, message }],
    partialReasons: ['read-error'],
    cancelled: false,
    truncated: false,
    depthCut: 0,
    symlinks: 0,
    dirs: 0,
    complete: false
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.root        树根（绝对路径）
 * @param {Function} opts.readDir   async absPath -> 条目数组（原始字段）
 * @param {Function} [opts.mapEntry] 条目 -> 中间形状，默认原样
 * @param {Function} [opts.joinPath] (base, name) -> 子绝对路径，默认走 resolve（两端通吃）
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxDepth]
 * @param {Function} [opts.isCancelled] 每个目录之间检查一次
 * @param {Function} [opts.onProgress]  ({entries, dirs, partial}) => void
 */
export async function walkTree (opts = {}) {
  const {
    root,
    readDir,
    mapEntry = e => e,
    joinPath = resolve,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxDepth = DEFAULT_MAX_DEPTH,
    isCancelled = () => false,
    onProgress = null
  } = opts

  const res = {
    root: typeof root === 'string' ? root : '',
    entries: [],
    errors: [],
    partialReasons: [],
    cancelled: false,
    truncated: false,
    depthCut: 0,
    symlinks: 0,
    dirs: 0,
    complete: false
  }

  if (typeof readDir !== 'function') {
    return emptyWalk(res.root, 'readDir is required')
  }
  if (!res.root) {
    return emptyWalk(res.root, 'root is required')
  }

  const addPartial = r => {
    if (!res.partialReasons.includes(r)) {
      res.partialReasons.push(r)
    }
  }

  // 队列里同时带 rel（给差异层当 key，恒用 `/`）与 abs（给 readDir 用，跟着平台走）
  const queue = [{ rel: '', abs: res.root, depth: 0 }]
  let stop = false

  while (queue.length && !stop) {
    if (isCancelled()) {
      res.cancelled = true
      addPartial('cancelled')
      break
    }
    const cur = queue.shift()
    let list
    try {
      list = await readDir(cur.abs)
    } catch (e) {
      // 一个目录读失败（权限、断连中途）不该带走整棵树：记在它自己那一条上
      res.errors.push({ relPath: cur.rel, path: cur.abs, message: msg(e) })
      addPartial('read-error')
      continue
    }
    if (!Array.isArray(list)) {
      res.errors.push({ relPath: cur.rel, path: cur.abs, message: 'not a directory' })
      addPartial('read-error')
      continue
    }
    res.dirs++
    const children = list.filter(isRealEntry).map(mapEntry).sort(byName)

    for (const it of children) {
      if (res.entries.length >= maxEntries) {
        res.truncated = true
        addPartial('max-entries')
        stop = true
        break
      }
      if (it.isSymbolicLink) {
        res.symlinks++
        continue
      }
      const rel = cur.rel ? cur.rel + '/' + it.name : String(it.name)
      const node = {
        relPath: rel,
        name: String(it.name),
        size: numOr0(it.size),
        mtimeMs: numOr0(it.mtimeMs),
        isDirectory: !!it.isDirectory
      }
      const mode = modeOf(it.mode)
      if (mode !== undefined) {
        node.mode = mode
      }
      res.entries.push(node)
      if (it.isDirectory) {
        if (cur.depth + 1 > maxDepth) {
          // 目录本身进树（不然界面看不见该建它），但它的内容不再往下读
          res.depthCut++
          addPartial('max-depth')
          continue
        }
        queue.push({ rel, abs: joinPath(cur.abs, String(it.name)), depth: cur.depth + 1 })
      }
    }
    if (onProgress) {
      onProgress({
        entries: res.entries.length,
        dirs: res.dirs,
        partial: res.partialReasons.length > 0
      })
    }
  }

  res.complete = res.partialReasons.length === 0
  return res
}

/** 本地树：`readDir` 走 `window.fs.readdirStatAsync`（一次往返拿全目录元信息）。 */
export async function walkLocalTree (opts = {}) {
  const fsMod = opts.fs || (typeof window !== 'undefined' ? window.fs : undefined)
  if (!fsMod || typeof fsMod.readdirStatAsync !== 'function') {
    return emptyWalk(opts.root, 'local fs listing unavailable')
  }
  return walkTree({
    ...opts,
    readDir: p => fsMod.readdirStatAsync(p),
    mapEntry: localEntryToNode
  })
}

/** 远端树：`readDir` 走 `sftp.list`（每项自带 size/modifyTime/type）。 */
export async function walkRemoteTree (opts = {}) {
  const sftp = opts.sftp
  if (!sftp || typeof sftp.list !== 'function') {
    return emptyWalk(opts.root, 'sftp client unavailable')
  }
  return walkTree({
    ...opts,
    readDir: p => sftp.list(p),
    mapEntry: remoteEntryToNode
  })
}

/** 采集回来的一句话说明：界面把它原样显示，不自己拼原因。 */
export function walkNote (walk) {
  if (!walk) {
    return ''
  }
  if (walk.complete) {
    return ''
  }
  const r = walk.partialReasons || []
  if (r.includes('cancelled')) {
    return 'cancelled'
  }
  if (r.includes('max-entries')) {
    return 'max-entries'
  }
  if (r.includes('max-depth')) {
    return 'max-depth'
  }
  if (r.includes('read-error')) {
    return 'read-error'
  }
  return r[0] || ''
}

export default {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  localEntryToNode,
  remoteEntryToNode,
  walkTree,
  walkLocalTree,
  walkRemoteTree,
  walkNote
}
