/**
 * G4 远程归档的执行侧：把 remote-archive 产出的命令打到远端，再把结果整理成
 * 渲染层能直接展示的形态。
 *
 * 为什么不直接用现成的 runExec：它对「任何 stderr」一律抛错，而 tar/zip 在成功时
 * 也会写警告（`tar: Removing leading \`/'` 之类），一次正常打包会被判成失败。
 * 归档的成败只看退出码，stderr 只作为附注回传。
 *
 * 降级（远端无 zip → tar.gz）不额外探测一次：判定已经在命令的 if 里做了，
 * 这里只认 stdout 上的标记，避免「探测时有 zip、执行时没了」的漂移。
 */

const {
  planArchiveCreate,
  planArchiveList,
  planArchiveExtract,
  parseArchiveListing,
  errorTail
} = require('../common/remote-archive')

const failed = (res, action) => {
  const code = typeof res.code === 'number' ? res.code : -1
  const detail = String(res.stderr || res.stdout || '').trim()
  const err = new Error(
    detail || `archive ${action} failed (exit ${code})`
  )
  err.exitCode = code
  err.stderrTail = errorTail(detail)
  throw err
}

// execBuffered 的报错是按命令首词拼的，而归档命令首词是 `if`/`tar`/`powershell.exe`，
// 用户看了只知道"不支持"，不知道是不支持什么。归档全部依赖 exec 通道，先挡一道。
const requireExec = (inst) => {
  if (!inst.enableSsh) {
    throw new Error('archiving needs an SSH exec channel (this session is SFTP-only)')
  }
}

/**
 * sources 必须是同一目录下的绝对路径（tar 只有一个 -C，见 remote-archive）。
 * 返回 { producedPath, fallback, noticeKey, stderrTail }；fallback 为真时
 * producedPath 已经是 .tar.gz，noticeKey 给渲染层出那句「远端无 zip」的提示。
 */
async function archiveCreate (inst, { sources, dest, kind = 'tar.gz', platform } = {}) {
  requireExec(inst)
  const plat = platform || await inst.getRemoteExecPlatform()
  const plan = planArchiveCreate({ platform: plat, kind, sources, dest })
  const res = await inst.execBuffered(plan.cmd)
  if (res.code !== 0) {
    failed(res, 'create')
  }
  const hit = !!plan.fallback && String(res.stdout || '').includes(plan.fallback.marker)
  return {
    producedPath: hit ? plan.fallback.producedPath : plan.producedPath,
    kind: hit ? 'tar.gz' : kind,
    fallback: hit,
    noticeKey: hit ? plan.fallback.noticeKey : null,
    stderrTail: errorTail(res.stderr)
  }
}

/**
 * 解压前的确认依据：只列，不解。
 */
async function archiveList (inst, { archivePath, platform, max } = {}) {
  requireExec(inst)
  const plat = platform || await inst.getRemoteExecPlatform()
  const plan = planArchiveList({ platform: plat, archivePath })
  const res = await inst.execBuffered(plan.cmd)
  if (res.code !== 0) {
    failed(res, 'list')
  }
  const listing = parseArchiveListing(res.stdout, max)
  return {
    kind: plan.kind,
    entries: listing.entries,
    total: listing.total,
    truncated: listing.truncated,
    stderrTail: errorTail(res.stderr)
  }
}

/**
 * destDir 必须是已存在的目录：宁可让用户先建目录，也不在远端凭空造路径。
 */
async function archiveExtract (inst, { archivePath, destDir, platform } = {}) {
  requireExec(inst)
  const plat = platform || await inst.getRemoteExecPlatform()
  const plan = planArchiveExtract({ platform: plat, archivePath, destDir })
  const res = await inst.execBuffered(plan.cmd)
  if (res.code !== 0) {
    failed(res, 'extract')
  }
  return {
    ok: true,
    kind: plan.kind,
    producedPath: archivePath,
    destDir,
    stderrTail: errorTail(res.stderr)
  }
}

module.exports = {
  archiveCreate,
  archiveList,
  archiveExtract
}
