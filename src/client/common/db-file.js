/**
 * H8a：本地文件引擎（SQLite）的路径、选择器与连接目标口径。纯函数零依赖，node 可直接单测。
 *
 * 为什么单独立一个模块而不是写在表单组件里：对话框参数、路径归一与"这个会话连的是哪儿"
 * 都要被单测钉死（表单组件依赖 window.api / antd，在 node 下不可测），而这几条恰恰是最容易
 * 悄悄改坏的：过滤器少一个扩展名 → 用户选不到 .sqlite3；路径没 trim → 保存后
 * 主进程按带空格的路径找不到文件；连接目标按 dbHost 有没有值来判 → sqlite 页签
 * 挂着它根本没用过的 127.0.0.1:3306。
 */

// 允许的库文件扩展名。`.db` 太泛（很多应用随手就叫 data.db），但用户确实只有这个
// 名字，所以照常收；对话框另有 "All files" 兜底，避免"我的库叫 mydb.dat 就选不了"
export const SQLITE_FILE_EXTS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db']

// 内存库标记：node:sqlite 支持 ':memory:'（临时/演示用，进程退出即丢）。
// 表单允许手填，但连接测试会拒绝写事务，见适配器 beginTx
export const MEMORY_DB_FILE = ':memory:'

// 本地文件引擎集合。定义放这里（纯数据、node 可 import），constants.js 只做再导出：
// constants.js 依赖 window 与图片资源，node 单测进不去，而"哪些引擎没有 host"
// 恰恰是要被单测钉死的口径（表单隐藏网络字段、连接目标改用库文件都靠它）。
// 新增本地引擎只加这一行，别在组件里另写 dbType === 'sqlite'。
export const dbFileTypes = new Set(['sqlite'])

export function isDbFileType (dbType) {
  return dbFileTypes.has(String(dbType === null || dbType === undefined ? '' : dbType))
}

// N1：CA 证书文件的常见扩展名。node tls 只吃 PEM（`ca` 传字符串/Buffer），
// 但用户手上的内网根证书叫 .crt/.cer/.pem/.ca-bundle 都有，一律放开由服务端解析报错兜底；
// 另加 All files，避免"我的根证书没有扩展名就选不了"。
export const CA_FILE_EXTS = ['pem', 'crt', 'cer', 'ca-bundle', 'bundle', 'txt']

/**
 * 文件选择器参数（preload 的 window.api.openDialog 直通 Electron
 * dialog.showOpenDialogSync，所以这里给的就是 Electron 选项）。
 * @param {string} title 对话框标题（已翻译的文案）
 * @returns {Object} openDialog 选项
 */
export function sqliteFileDialogOptions (title) {
  return {
    title,
    message: title,
    properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    filters: [
      { name: 'SQLite database', extensions: SQLITE_FILE_EXTS },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/**
 * N1：CA 证书选择器参数。与库文件选择器同构，只是 filters 换掉——
 * 单独一个函数而不是给上面那个加参数：两者会被不同字段各自钉死，
 * 合并成带开关的版本反而容易被后加的调用方漏传参数而静默走错分支。
 * @param {string} title 对话框标题（已翻译的文案）
 * @returns {Object} openDialog 选项
 */
export function caFileDialogOptions (title) {
  return {
    title,
    message: title,
    properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
    filters: [
      { name: 'CA certificate', extensions: CA_FILE_EXTS },
      { name: 'All files', extensions: ['*'] }
    ]
  }
}

/**
 * 路径归一：去首尾空白与用户从别处粘贴时带上的成对引号。
 * 不做 path.resolve —— 主进程按连接时的进程工作目录解析相对路径会指错文件，
 * 相对路径交给适配器统一 resolve（见 db-client/sqlite.js 的 fileOf）。
 * @param {string} p 原始输入
 * @returns {string} 归一后的路径（可能为空串）
 */
export function normalizeDbFilePath (p) {
  let s = String(p === null || p === undefined ? '' : p).trim()
  if (s.length >= 2) {
    const head = s[0]
    const tail = s[s.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      s = s.slice(1, -1).trim()
    }
  }
  return s
}

/**
 * 显示用短名：路径太长时表单/页签只需要最后一段。
 * 同时切 `/` 与 `\`（Windows 书签在 mac 上查看时的路径分隔符）。
 * @param {string} p 路径
 * @returns {string} 文件名；内存库返回 ':memory:'
 */
export function dbFilePathLabel (p) {
  const s = normalizeDbFilePath(p)
  if (!s) {
    return ''
  }
  if (s === MEMORY_DB_FILE) {
    return MEMORY_DB_FILE
  }
  const parts = s.split(/[/\\]/)
  return parts[parts.length - 1] || s
}

/**
 * 连接位置（"这个会话连的是哪儿"的唯一口径）：
 * 本地文件引擎 → 库文件名（`full` 为真时给完整路径）；其余 → `host:port`（无端口只出 host）。
 * 判引擎而不是判"有没有 dbFile"：切换引擎不会清掉另一侧字段（清了会误伤用户手填的
 * 真实地址），所以残留的 127.0.0.1:3306 必须被忽略，否则 sqlite 会话的页签提示、
 * 错误卡片、工具条都会显示一个它根本没用过的地址。
 * @param {Object} tab 会话 / 书签
 * @param {boolean} full 本地引擎是否返回完整路径，默认短文件名
 * @returns {string} 位置文本；拿不到时为空串（调用方自行决定兜底）
 */
export function dbConnTarget (tab, full = false) {
  const t = tab || {}
  if (isDbFileType(t.dbType)) {
    return full ? normalizeDbFilePath(t.dbFile) : dbFilePathLabel(t.dbFile)
  }
  if (!t.dbHost) {
    return ''
  }
  return t.dbPort ? `${t.dbHost}:${t.dbPort}` : String(t.dbHost)
}
