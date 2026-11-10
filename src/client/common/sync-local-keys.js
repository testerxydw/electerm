/**
 * 同步/导入侧的配置黑名单（**只用于「收」，不用于「发」**）。
 *
 * 换机、换账号、导入备份时，远端 `userConfig` 会覆盖本地配置。其中一部分键描述
 * 的是「**这台机器 / 这次安装**」，或者干脆是「**执行什么二进制**」——它们被远端
 * 覆盖的后果从「连接失败」一直到「远程代码执行」，所以统一在入口删掉。
 *
 * 拆成独立模块而不是留在 `store/sync.js` 里：那份文件是 1000 行的 ESM store，
 * 混着 window / manate / lodash，任何测试都 require 不动它。抽出来的这个文件是
 * 纯函数，行为测试可以直击断言，而不是去正则匹配源码（那种测试把守卫条件改成
 * `if (true)` 也照样通过）。
 */

/**
 * 覆盖即出事、且属于「本机」语义的键。
 *
 * 历史（保持原样，别删：每一条都是踩过的坑）
 * - `tokenElecterm`：覆盖后与服务器 JWT secret 不再匹配，之后每一条 WebSocket
 *   （终端 / sftp / 传输）都静默验签失败 —— 表现是「连上了但输入没反应」，直到
 *   重启 app；
 * - `sessionLogPath`：全量导入会把导出机器的 `C:\Users\<someone>\Documents\electerm`
 *   搬过来，写不进去的日志目录曾经把会话一起带崩（#4688）；本机没有配置时由
 *   `default-log-path.js` 给每个平台兜底。
 *
 * 本批追加（安全，见 P0-1 设计 §2.8 / 同步污染面）
 * - `execLinux` / `execMac` / `execWindows` 及各自的 `Args`：**这些是「要执行什么
 *   二进制」**。一个被篡改的 gist（或同账号下被接管的另一台设备推送）把它们改成
 *   任意路径 + 参数，用户下次开终端就是一次远程代码执行；顺带，它们本来就是
 *   per-machine 的（Windows 与 Linux 的 shell 根本不是同一个程序），跨设备同步
 *   在语义上也是错的。
 * - `mcpServersAI`：同形通道 —— 它允许 spawn 任意 command（见 `app/mcp/client/`），
 *   下载侧一旦接受，等于把「远程执行」写进配置。它当前**不在**上传白名单里，
 *   所以这条是防未来（有人把它加进 `getSyncConfig()` 时立刻有护栏）。
 * - `apiKeyAI`：`safeStorage` 的密文绑定本机 OS 用户（Keychain / DPAPI / libsecret），
 *   同步到别的机器**必然解不开**（`safeDecrypt` 返回 `''`），同步它没有收益；
 *   而它一旦被写入，还能把用户请求指向攻击者的中转站（所以下面 4 个「端点」键
 *   也在剥离清单里，见下一条）。
 *
 * **「端点」四键 + `roleAI`（D4/D5，2026-11-10 裁决）**
 * - `baseURLAI` / `apiPathAI` / `authHeaderNameAI` / `proxyAI`：这 4 个键合起来
 *   描述「**用户的 key 会被发到哪**」。`apiKeyAI` 本身不同步也已剥离——凭据不过去，
 *   目的地就不能过去：远端把 `baseURLAI` 改成攻击者域名，本机真实的 key 就会在
 *   下一次 AI 请求里被送出去（`sync.js` 上传白名单同步摘掉了 `baseURLAI`/`proxyAI`，
 *   但**剥离清单不能因此删这两键**——线上已有的旧 gist 里就写着它们，白名单管
 *   「我们发什么」，剥离清单管「我们收什么」，是两件事）。
 * - `roleAI`：它直接拼进 system prompt **头部**（`agent.js`），而
 *   `appendMandatoryGuardrails` 只在**其后追加**，覆盖不了前面的角色定义。
 *   远端改写它 = 立刻换掉 agent 的行为准则，不需要任何外发、不依赖用户操作。
 *   上传白名单保留它（用户自己的文本进自己的 gist 不是外发），收才是风险面。
 */
const LOCAL_CONFIG_KEYS = [
  'tokenElecterm',
  'host',
  'port',
  'server',
  'wsHost',
  'wsPort',
  'useSystemTitleBar',
  'sessionLogPath',
  // 本批追加：可执行向量 + 本机凭据
  'execLinux',
  'execMac',
  'execWindows',
  'execLinuxArgs',
  'execMacArgs',
  'execWindowsArgs',
  'mcpServersAI',
  'apiKeyAI',
  // 端点四键（key 的去向）+ 角色指令（agent 的行为准则）
  'baseURLAI',
  'apiPathAI',
  'authHeaderNameAI',
  'proxyAI',
  'roleAI'
]

/**
 * 返回一份删掉本机键的副本（不修改入参：调用方可能还要用原对象做对比/回滚）。
 * @param {*} conf 远端/导入的 userConfig
 * @returns {*} 去掉本机键的浅拷贝；非对象原样返回
 */
function stripLocalConfigKeys (conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) {
    return conf
  }
  const safe = { ...conf }
  for (const key of LOCAL_CONFIG_KEYS) {
    delete safe[key]
  }
  return safe
}

export { LOCAL_CONFIG_KEYS, stripLocalConfigKeys }
