/**
 * MCP server 配置表单的纯函数层（T05）· 无 window / 无 store。
 *
 * 规则镜像 `src/app/mcp/client/config-validate.js`（CJS，主进程唯一权威）。
 * **改任何一条规则必须两边同步**——`mcp-server-config.spec.js` 用真校验器对
 * 同一输入矩阵做逐字段一致性对照，漂移即红。客户端不直接 import 主进程
 * 模块：仓库没有 renderer→app 的 import 先例，不赌打包配置。
 *
 * 覆盖判据：
 *   - T05-01（M1 UI 面）：就地报错的文案与 `errorOf` 一致（一致由对照 spec
 *     保证）；
 *   - T04-09（SEC-12）：新增 server 默认 `trust` 来自代码常量
 *     `DEFAULT_MCP_TRUST = 'ask'`，**不沿用上一条 server 的设置**；三态徽章
 *     映射（只读灰 / 每次确认蓝 / 自动放行橙+警示）。
 */

// 与 config-validate.js:17-27 逐字同步（改动必须两边同步，spec 对照钉住）
const TRANSPORTS = ['stdio', 'http']
const TRUST_LEVELS = ['readonly', 'ask', 'auto']
const TIMEOUT_MIN_MS = 5000
const TIMEOUT_MAX_MS = 300000
const MAX_NAME_LENGTH = 128
const MAX_COMMAND_LENGTH = 512

// SEC-12/D1：新增 server 的默认信任级别——只能来自这个代码常量，
// 不许「沿用上一个 server 的设置」，也不许被配置导入静默改写（SEC-11a
// 从根上挡住远端下发 server 配置）。
export const DEFAULT_MCP_TRUST = 'ask'

// name 会拼进 SEC-1 边界块属性位（M7-③ 的入口半边），引号/尖括号在
// config-validate 就拒；这里镜像同一规则给表单就地报错。
const NAME_QUOTES = /[<>"]/

/**
 * True when the string has C0 控制字符（回车/换行/NUL）——与主进程
 * hasControlChars 同义（argv 与 header 值允许其他控制字节，故不照抄
 * C0/C1 全表；name 用更严的 printable，见下）。
 */
function hasControlChars (value) {
  return /[\r\n\0]/.test(String(value))
}

/**
 * name 专用：拒绝全部 C0/C1 控制字符（tab/newline/ESC…）——换行会破坏
 * 单行 UI 并伪造日志行（主进程 hasPrintableCharsOnly 同义）。
 */
function hasNonPrintable (value) {
  for (const ch of String(value)) {
    const code = ch.codePointAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

/**
 * 校验一条 server 草稿（新增/编辑表单就地报错）。
 * 只覆盖表单暴露的字段；env/args 深层校验仍由主进程保存路径兜底
 * （config-validate 的「非法输入绝不静默丢弃」契约不变）。
 * @param {object} draft
 * @returns {{errors: Array<{field: string, message: string}>}}
 */
export function validateMcpServerDraft (draft) {
  const errors = []
  const d = draft && typeof draft === 'object' ? draft : {}

  if (d.name !== undefined && d.name !== '') {
    if (typeof d.name !== 'string') {
      errors.push({ field: 'name', message: 'name must be a string' })
    } else if (d.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: 'name', message: `name must be at most ${MAX_NAME_LENGTH} characters` })
    } else if (hasNonPrintable(d.name)) {
      errors.push({ field: 'name', message: 'name must not contain control characters (newlines, tabs)' })
    } else if (NAME_QUOTES.test(d.name)) {
      errors.push({ field: 'name', message: 'name must not contain quotes or angle brackets (" < >)' })
    }
  }

  if (d.transport === undefined || d.transport === '') {
    errors.push({ field: 'transport', message: `transport is required, one of: ${TRANSPORTS.join(', ')}` })
  } else if (!TRANSPORTS.includes(d.transport)) {
    errors.push({ field: 'transport', message: `transport must be one of: ${TRANSPORTS.join(', ')}` })
  }

  if (d.timeoutMs !== undefined && d.timeoutMs !== '') {
    const n = Number(d.timeoutMs)
    if (!Number.isInteger(n) || n < TIMEOUT_MIN_MS || n > TIMEOUT_MAX_MS) {
      errors.push({ field: 'timeoutMs', message: `timeoutMs must be an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}` })
    }
  }

  if (d.trust !== undefined && d.trust !== '' && !TRUST_LEVELS.includes(d.trust)) {
    errors.push({ field: 'trust', message: `trust must be one of: ${TRUST_LEVELS.join(', ')}` })
  }

  if (d.transport === 'stdio') {
    if (d.command === undefined || typeof d.command !== 'string' || !d.command.trim()) {
      errors.push({ field: 'command', message: 'stdio server requires a non-empty command' })
    } else if (d.command.length > MAX_COMMAND_LENGTH) {
      errors.push({ field: 'command', message: `command must be at most ${MAX_COMMAND_LENGTH} characters` })
    } else if (hasControlChars(d.command)) {
      errors.push({ field: 'command', message: 'command must not contain newlines' })
    }
  }

  if (d.transport === 'http') {
    if (d.url === undefined || typeof d.url !== 'string' || !d.url.trim()) {
      errors.push({ field: 'url', message: 'http server requires a non-empty url' })
    } else {
      let parsed = null
      try {
        parsed = new URL(d.url)
      } catch (_) {
        parsed = null
      }
      if (!parsed) {
        errors.push({ field: 'url', message: 'url must be a valid absolute URL' })
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push({ field: 'url', message: `url protocol must be http: or https:, got ${parsed.protocol}` })
      }
    }
  }

  return { errors }
}

/**
 * 新增 server 的默认草稿。`trust` 只来自 `DEFAULT_MCP_TRUST` 常量——
 * 判据（T04-09）：构造上一条 trust='auto' 的列表，这里也必须给 'ask'
 * （不沿用），spec 用该场景钉死。
 * @param {Array} [servers] 既有列表（故意不读取其 trust）
 * @returns {object}
 */
export function newServerDraft (servers = []) {
  // servers 参数故意不读取其 trust（判据：默认值不沿用上一条）；保留形参
  // 是为了让调用点自文档化
  return {
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    timeoutMs: 60000,
    trust: DEFAULT_MCP_TRUST,
    enabled: true
  }
}

/**
 * SEC-12 三态信任徽章：只读（灰）/ 每次确认（蓝）/ 自动放行（橙 + 警示）。
 * 未知值回落 ask 档（fail-safe：显示成"每次确认"比显示成放行安全）。
 * @param {string} trust
 * @returns {{text: string, color: string, warn: boolean}}
 */
export function trustBadgeMeta (trust) {
  if (trust === 'readonly') {
    return { text: 'read-only', color: 'default', warn: false }
  }
  if (trust === 'auto') {
    return { text: 'auto-approve', color: 'orange', warn: true }
  }
  return { text: 'ask every time', color: 'blue', warn: false }
}

export {
  TRANSPORTS,
  TRUST_LEVELS,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  MAX_NAME_LENGTH,
  MAX_COMMAND_LENGTH
}
