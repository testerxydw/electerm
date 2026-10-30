/**
 * G4 远程归档：把「打包 / 列清单 / 解压」翻译成一条远端命令字符串。
 *
 * 这里只做字符串与文本，不碰连接——`session-sftp.js` 负责执行，
 * 判据因此能在假 client 上跑（同 session-sftp-remote-command.spec.js 的思路）。
 *
 * 两条硬规则：
 * 1. 路径永不裸着进命令行。posix 走双引号转义（与 session-sftp 的
 *    escapePosixPath 同规则，改一处要改两处）；Windows 走 base64 塞进固定
 *    PowerShell 脚本（GHSA-ch82-q8wq-2gfv，文件名来自远端目录列表 = 不可信输入）。
 * 2. 文件名不能操纵「选项」。`-czf` 后面跟的第一个东西到底是参数还是开关，
 *    取决于文件名叫什么，所以：解压/打包的操作对象一律要求绝对路径（`/` 或
 *    `C:\` 开头，天然不会以 `-` 起头），成员名用 `--`（tar）或 `./`（zip）兜住。
 *    实测 Info-ZIP 3.0 不认 `--`（`can't use -- before archive name`），
 *    所以 zip 那一支不能用 `--`，只能 `./` 前缀。
 */

// zip 缺失回退 tar.gz 时打在原样命令的 stdout 里，主进程据此换报产出路径
const NO_ZIP_MARKER = 'ELECTERM_ARCHIVE_NO_ZIP'

// 清单一次最多回多少条：远端可能是十万文件的目录
const LIST_MAX_ENTRIES = 2000

const KIND_TAR_GZ = 'tar.gz'
const KIND_ZIP = 'zip'

const escapePosixPath = (value) => {
  return `"${String(value).replace(/["\\$`]/g, '\\$&')}"`
}

// 与 session-sftp.js buildPowerShellCommand 同一构造：路径 base64 后进脚本，
// 命令行里只剩固定模板，cmd.exe / PowerShell 的元字符都碰不到真实文件名
const buildPowerShellCommand = (paths, script) => {
  const decoders = paths
    .map((path, i) =>
      `$p${i}=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(path), 'utf8').toString('base64')}'))`
    )
    .join(';')
  return `powershell.exe -NoLogo -NonInteractive -NoProfile -Command "${decoders};${script}"`
}

const badPath = (value, label) => {
  const s = typeof value === 'string' ? value : ''
  if (!s) {
    throw new Error(`${label} must be a non-empty path`)
  }
  // 换行能结束引号外的注释/命令；控制字符里其余的没有正当理由
  if (/[\n\r]/.test(s)) {
    throw new Error(`${label} must not contain newline`)
  }
  return s
}

/**
 * SFTP 侧的远端 Windows 路径写成 `/C:/data`（协议要求前导 /），但 exec 落到
 * cmd/PowerShell 手里就得是 `C:/data`，否则 `/C:` 被当成根下的一个叫 C: 的目录。
 * 与 session-sftp.js normalizeWindowsExecPath 同一规则，改一处要记得改另一处。
 */
const toExecPath = (value, platform) => {
  const s = String(value || '')
  return platform === 'windows' ? s.replace(/^\/([a-zA-Z]:)/, '$1') : s
}

const assertAbsolute = (value, label, platform) => {
  const s = badPath(toExecPath(value, platform), label)
  if (platform === 'windows') {
    const win = /^[a-zA-Z]:[\\/]|^\\\\[^\\]+\\/
    if (!win.test(s)) {
      throw new Error(`${label} must be an absolute Windows path: ${s}`)
    }
    return s
  }
  if (!s.startsWith('/')) {
    throw new Error(`${label} must be an absolute path: ${s}`)
  }
  return s
}

/**
 * 拆成 { dir, base }。分隔符按平台认：posix 的 `\` 是合法文件名字符
 * （`a\b` 就是一个名字），按 `\` 拆会把父目录拆错、tar 直接 chdir 失败；
 * Windows 两种分隔符都出现（SFTP 列举常用 `/`），所以都认。
 */
function splitPath (value, label, platform = 'posix') {
  const s = badPath(value, label)
  const i = platform === 'windows'
    ? Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    : s.lastIndexOf('/')
  if (i <= 0) {
    // i === 0 是 `/name`：dir 取 '/'，不然根下的文件就没法打包
    if (i < 0) {
      throw new Error(`${label} must be an absolute path: ${s}`)
    }
    return { dir: '/', base: s.slice(1) }
  }
  const dir = s.slice(0, i)
  const sep = s[i]
  const base = s.slice(i + 1)
  if (!base) {
    throw new Error(`${label} must not end with a separator: ${s}`)
  }
  if (base === '.' || base === '..') {
    throw new Error(`${label} must not be a dot entry: ${s}`)
  }
  // 盘符根 `C:\` 拆出来 dir 是 `C:`，回 `C:\` 才拼得回去
  return {
    dir: /^[a-zA-Z]:$/.test(dir) ? dir + sep : dir,
    base
  }
}

// 分隔符按字符串里出现的那种挑，没有就默认 '/'（posix）
const sepOf = (value) => {
  return value.indexOf('\\') > value.indexOf('/') ? '\\' : '/'
}

const joinPath = (dir, base) => {
  if (dir === '/' || /^[a-zA-Z]:[\\/]$/.test(dir)) {
    return dir + base
  }
  return `${dir}${sepOf(dir)}${base}`
}

/**
 * 从文件名认归档类型。认不出来返回 null，由调用方决定报什么。
 */
function archiveKindFromName (name) {
  const s = String(name || '').toLowerCase()
  if (s.endsWith('.tar.gz') || s.endsWith('.tgz')) {
    return 'tar-gz'
  }
  if (s.endsWith('.tar')) {
    return 'tar'
  }
  if (s.endsWith('.zip')) {
    return 'zip'
  }
  return null
}

/**
 * 选中项所在目录 + 首个文件名 → 默认归档落点。
 * 后缀用 `.tar.gz`/`.zip`，与 kind 对齐；已存在的同名归档不覆盖判断（交给远端
 * tar/zip 自己报，Compress-Archive 走 -Force）。
 */
function defaultArchivePath ({ sources, kind, platform = 'posix' }) {
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error('sources must be a non-empty array')
  }
  const first = splitPath(assertAbsolute(sources[0], 'sources[0]', platform), 'sources[0]', platform)
  const ext = kind === KIND_ZIP ? '.zip' : '.tar.gz'
  // 已经带对应后缀就别再叠一层 a.tar.gz.tar.gz
  const base = first.base.toLowerCase().endsWith(ext) ? first.base : first.base + ext
  return joinPath(first.dir, base)
}

// 所有源必须在同一个目录：tar 只有一个 -C，成员名才是 basename
function sameParent (sources, platform) {
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error('sources must be a non-empty array')
  }
  // 源必须绝对：`tar -C rel -- x` 里的 rel 是相对 shell 的 cwd（= SSH 用户的
  // home）解析的，不挡的话会闷声打包错目录里的东西
  const abs = sources.map((s, i) => assertAbsolute(s, `sources[${i}]`, platform))
  const parts = abs.map((s, i) => splitPath(s, `sources[${i}]`, platform))
  const dir = parts[0].dir
  // 分隔符按出现的那种归一：`C:\a` 与 `C:/a` 是同一目录，
  // SFTP 列出来的远端 Windows 路径两种写法都有，不该影响能不能打包
  const norm = (d) => d.replace(/[\\/]/g, '/')
  for (let i = 1; i < parts.length; i++) {
    if (norm(parts[i].dir) !== norm(dir)) {
      throw new Error('all sources must be in the same directory')
    }
  }
  if (parts.some(p => !p.base)) {
    throw new Error('sources must not have an empty base name')
  }
  return { dir, abs, bases: parts.map(p => p.base) }
}

// 归档不能写进被自己打包的目录里：tar 会 "file is the archive; not dumped"
const assertDestOutsideSources = (dest, sources) => {
  for (const src of sources) {
    if (dest === src) {
      throw new Error('destination must not be one of the sources')
    }
    const prefix = src.endsWith('/') || src.endsWith('\\') ? src : src + sepOf(src)
    if (dest.startsWith(prefix)) {
      throw new Error('destination must not be inside a source directory')
    }
  }
}

/**
 * 打包。返回 { cmd, producedPath, fallback }。
 *
 * posix 的 zip 一条命令里带 if/else：远端没有 zip 二进制时整包降级成 tar.gz，
 * 并打出 NO_ZIP_MARKER。多一次 `command -v` 往返不值得，且探测与执行之间
 * 装/卸了 zip 也会漂移，所以判定和执行放在同一条命令里。
 * 调用方看到 fallback 命中后要如实告诉用户产出文件换了后缀。
 */
function planArchiveCreate ({ platform = 'posix', kind = KIND_TAR_GZ, sources, dest }) {
  if (kind !== KIND_TAR_GZ && kind !== KIND_ZIP) {
    throw new Error(`unsupported archive kind: ${kind}`)
  }
  const isWin = platform === 'windows'
  const target = assertAbsolute(dest, 'dest', platform)
  // 归一化后的源路径再拿去比"归档是不是装在待打包目录里"：
  // `/C:/x` 与 `C:/x` 混着比会漏判，命令也就带病发出去了
  const { dir, abs, bases } = sameParent(sources, platform)
  assertDestOutsideSources(target, abs)
  if (isWin) {
    if (kind === KIND_ZIP) {
      if (!/\.zip$/i.test(target)) {
        throw new Error('Windows zip destination must end with .zip')
      }
      // $pN 依次是 dest 与各 basename：Compress-Archive 的 -LiteralPath 收数组
      const paths = [target, ...bases]
      const items = bases.map((b, i) => `$p${i + 1}`).join(',')
      const script = `Compress-Archive -LiteralPath ${items} -DestinationPath $p0 -Force`
      return {
        cmd: buildPowerShellCommand(paths, script),
        producedPath: target,
        fallback: null
      }
    }
    const script = `$ErrorActionPreference='Stop';$a=@(${bases.map((b, i) => `$p${i + 2}`).join(',')});& tar -czf $p0 -C $p1 -- $a;exit $LASTEXITCODE`
    const scriptCmd = buildPowerShellCommand([target, dir, ...bases], script)
    return { cmd: scriptCmd, producedPath: target, fallback: null }
  }
  const q = escapePosixPath
  if (kind === KIND_ZIP) {
    // 回退名是「去掉 .zip 换成 .tar.gz」，所以 .zip 后缀是契约的一部分
    if (!/\.zip$/i.test(target)) {
      throw new Error('zip destination must end with .zip')
    }
    const produced = target
    const fallbackPath = target.replace(/\.zip$/i, '') + '.tar.gz'
    // 成员名一律 ./ 前缀：zip 3.0 不认 --，而 ./-weird 天然不是选项
    const members = bases.map(b => q('./' + b)).join(' ')
    const tgz = `tar -czf ${q(fallbackPath)} -C ${q(dir)} -- ${bases.map(q).join(' ')}`
    const cmd = `if command -v zip >/dev/null 2>&1; then cd ${q(dir)} && zip -q -r ${q(produced)} ${members}; else ${tgz} && echo ${NO_ZIP_MARKER}; fi`
    return {
      cmd,
      producedPath: produced,
      fallback: {
        producedPath: fallbackPath,
        marker: NO_ZIP_MARKER,
        noticeKey: 'remoteArchiveNoZip'
      }
    }
  }
  const cmd = `tar -czf ${q(target)} -C ${q(dir)} -- ${bases.map(q).join(' ')}`
  return { cmd, producedPath: target, fallback: null }
}

/**
 * 列清单（解压前的确认依据）。返回 { cmd, kind }；kind 给 parse 用不上，
 * 但调用方要按它选 tar/unzip 之外的展示，所以原样带回。
 */
function planArchiveList ({ platform = 'posix', archivePath }) {
  const target = assertAbsolute(archivePath, 'archivePath', platform)
  const kind = archiveKindFromName(target)
  if (!kind) {
    throw new Error(`unsupported archive type: ${target}`)
  }
  if (platform === 'windows') {
    if (kind === 'zip') {
      const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[System.IO.Compression.ZipFile]::OpenRead($p0);try{$z.Entries|ForEach-Object{$_.FullName}}finally{$z.Dispose()}'
      return { cmd: buildPowerShellCommand([target], script), kind }
    }
    const flag = kind === 'tar-gz' ? '-tzf' : '-tf'
    return {
      cmd: buildPowerShellCommand([target], `$ErrorActionPreference='Stop';& tar ${flag} $p0;exit $LASTEXITCODE`),
      kind
    }
  }
  const q = escapePosixPath
  if (kind === 'zip') {
    // zipinfo -1（= unzip -Z1）只吐名字，比 unzip -l 的表格少一遍解析
    return { cmd: `unzip -Z1 ${q(target)}`, kind }
  }
  const flag = kind === 'tar-gz' ? '-tzf' : '-tf'
  return { cmd: `tar ${flag} ${q(target)}`, kind }
}

/**
 * 清单文本 → 条目。PowerShell 换行是 CRLF，tar 偶尔补空行，都在这清掉。
 * 超过上限只截断不报错：确认框看前 N 条够用，全量列表没人会读。
 */
function parseArchiveListing (stdout, max = LIST_MAX_ENTRIES) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    // 只清尾部：CRLF 的 \r 和 tar 的填充都落在那儿。前导空格不清——
    // " README" 这种名字是合法的，清了就等于少报一个文件
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.length > 0)
    // zip/tar 的目录条目以 / 结尾，列出来只会占地方。
    // 不按 `\` 过滤：反斜杠在 posix 是合法文件名字符，滤了会少报一条。
    .filter(l => !l.endsWith('/'))
  return {
    entries: lines.slice(0, max),
    total: lines.length,
    truncated: lines.length > max
  }
}

/**
 * 解压。只往给定目录里解，绝不自动建目录（destDir 必须是已存在的目录，
 * 由文件管理器当前所在目录给出，少一个「解到随便什么路径」的口子）。
 */
function planArchiveExtract ({ platform = 'posix', archivePath, destDir }) {
  const target = assertAbsolute(archivePath, 'archivePath', platform)
  const dir = assertAbsolute(destDir, 'destDir', platform)
  const kind = archiveKindFromName(target)
  if (!kind) {
    throw new Error(`unsupported archive type: ${target}`)
  }
  if (platform === 'windows') {
    if (kind === 'zip') {
      const script = 'Expand-Archive -LiteralPath $p0 -DestinationPath $p1 -Force'
      return { cmd: buildPowerShellCommand([target, dir], script), kind }
    }
    const script = '$ErrorActionPreference=\'Stop\';& tar -xf $p0 -C $p1;exit $LASTEXITCODE'
    return { cmd: buildPowerShellCommand([target, dir], script), kind }
  }
  const q = escapePosixPath
  if (kind === 'zip') {
    // -o 覆盖不询问：exec 是无交互通道，问也没人答，会一直挂着
    return { cmd: `unzip -q -o ${q(target)} -d ${q(dir)}`, kind }
  }
  return { cmd: `tar -xf ${q(target)} -C ${q(dir)}`, kind }
}

/**
 * 失败详情只回最后几行：tar 找不到目录时能把整页 usage 吐进 stderr，
 * 原文回传会把确认弹层撑爆，也读不出重点。
 */
function errorTail (text, maxLines = 3, maxChars = 600) {
  const s = String(text || '')
  if (!s.trim()) {
    return ''
  }
  return s
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')
    .slice(-maxChars)
}

module.exports = {
  NO_ZIP_MARKER,
  LIST_MAX_ENTRIES,
  KIND_TAR_GZ,
  KIND_ZIP,
  escapePosixPath,
  buildPowerShellCommand,
  splitPath,
  joinPath,
  archiveKindFromName,
  defaultArchivePath,
  planArchiveCreate,
  planArchiveList,
  planArchiveExtract,
  parseArchiveListing,
  errorTail
}
