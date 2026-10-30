/**
 * G4 归档：渲染层要的那一小段纯逻辑（认后缀、起默认名、取末段）。
 *
 * 为什么不复用主进程那份 `src/app/common/remote-archive.js`：那是"怎么把路径
 * 拼成一条不在本机执行的命令"，规则改动的判据在远端（tar/zip/PowerShell 各自
 * 的坑）。这里只回答"这个文件名看着像不像归档、默认存成什么名"，两边各管一段，
 * 谁也不会以为对方替自己校验过。
 */

const ARCHIVE_EXT_RE = /(\.tar\.gz|\.tgz|\.tar|\.zip)$/i

/**
 * 后缀只用来决定"右键要不要给这项操作"，真能不能解由远端的 tar/unzip 说了算：
 * 后缀骗人时远端会回 `This does not look like a tar archive`，那句比这里准。
 */
export function isArchiveName (name) {
  return ARCHIVE_EXT_RE.test(String(name || ''))
}

// 展示用末段：远端 Windows 的列举路径两种分隔符都出现过
export function baseName (p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? s : s.slice(i + 1)
}

const stripExt = (name) => String(name || '').replace(ARCHIVE_EXT_RE, '')

const pad = (n) => String(n).padStart(2, '0')

const stamp = (d = new Date()) => {
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const extOf = (kind) => kind === 'zip' ? '.zip' : '.tar.gz'

/**
 * 名字与格式对齐：换格式时尾巴跟着换。看到什么后缀就得到什么文件——
 * 远端 `tar -tf` / `unzip` 选哪条路靠的也是后缀，`.tgz` 归一成 `.tar.gz` 少一种漂移。
 */
export function alignArchiveName (name, kind) {
  const n = String(name || '').trim()
  if (!n) {
    return ''
  }
  return stripExt(n) + extOf(kind)
}

/**
 * 名字不能直接发出去的两种情况，返回 key 后缀让界面去翻文案。
 * 分隔符在渲染层就挡：`a/b` 会被拼进一个不存在的子目录，
 * 远端只回一句笼统的 tar 错，不如这里说清楚。
 */
export function archiveNameProblem (name) {
  const n = String(name || '').trim()
  if (!n) {
    return 'empty'
  }
  if (/[/\\\r\n]/.test(n) || n === '.' || n === '..') {
    return 'badChar'
  }
  return ''
}

/**
 * 默认归档名。
 *
 * 单选：沿用原名（`app.js` → `app.js.tar.gz`，`logs.tar.gz` → `logs.tar.gz`）。
 * 原名与产出名相同时必须岔开——主进程会拒「归档装在被打包的东西里面」，
 * 而给一个会报错的默认名不如给一个能直接点确定的名字。
 * 多选：用 `所在目录-n-时间戳`，不拿第一个文件的名字冒充整包（那样看着像只打了它）。
 */
export function defaultArchiveName ({ names = [], kind = 'tar.gz', dirName, at } = {}) {
  const ext = extOf(kind)
  const list = (Array.isArray(names) ? names : []).filter(n => typeof n === 'string' && n)
  if (list.length === 1) {
    const only = list[0]
    const cand = ARCHIVE_EXT_RE.test(only) && only.toLowerCase().endsWith(ext)
      ? only
      : only + ext
    // 打包 a.zip → a.zip.zip：源名与产出名相同会让命令自己咬自己，加时间戳岔开
    if (cand === only || list.includes(cand)) {
      return stripExt(only) + '-' + stamp(at) + ext
    }
    return cand
  }
  const dir = String(dirName || '').trim()
  const head = dir && dir !== '.' && dir !== '/' ? baseName(dir) : 'archive'
  return `${head}-${list.length}-${stamp(at)}${ext}`
}
