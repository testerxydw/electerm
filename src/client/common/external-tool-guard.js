/**
 * 外部工具守卫（设计 P0-1 §3.4）· 纯函数，无 window。
 *
 * 前缀必须与主进程 `src/app/mcp/client/tool-name.js` 的 `PREFIX` 保持一致：
 * 那边是别名的唯一产地，这边只做路由判断。契约由
 * `mcp-agent-external-guard.spec.js` 用源码文本断言钉住（两边任何一边改前缀
 * 而不同步另一边，测试红）。
 *
 * T04（批准矩阵 / 污染门）补进本模块：
 *   - `decideToolApproval`：6 格决策表（F9），是渲染层审批的**唯一权威**
 *     （含 reason + readonly 取消-only 语义）；主进程 `needsApprovalFor`
 *     只返回布尔、仅作 UI 提示，不要反过来让渲染层只信赖它。
 *   - `requiresTaintApproval` + `TAINT_GATED_BUILTIN_TOOLS`：污染门——一旦本轮
 *     run 跑过外部工具结果（tainted），对内置写工具（sftp_*、db_insert_sql）的
 *     后续调用必须再确认一次。
 * `decideToolApproval` 签名**不含 `tainted`**：taint 是独立维度，由 agent 循环
 * 在调用点叠加（见 agent.js 的统一审批门）。
 */

const EXTERNAL_TOOL_PREFIX = 'mcp__'

/**
 * 判断一个工具名是不是外部 MCP 工具别名。
 * @param {string} name
 * @returns {boolean}
 */
function isExternalAlias (name) {
  return typeof name === 'string' && name.startsWith(EXTERNAL_TOOL_PREFIX)
}

/**
 * 被污染门拦住的内置写工具（设计 D3）。这些工具的"写"语义一旦被外部结果诱导，
 * 危害最大，所以 tainted 后每次都要再确认。
 * @type {ReadonlyArray<string>}
 */
const TAINT_GATED_BUILTIN_TOOLS = [
  'sftp_upload',
  'sftp_download',
  'sftp_del',
  'db_insert_sql'
]

/**
 * 批准矩阵（设计 §3.4 决策表，F9）。渲染层审批的**唯一权威**。
 *
 * 6 格，签名**不含 `tainted`**：`readOnlyHint` 取自 `meta.annotations.readOnlyHint`
 * （缺失按 false 处理）。返回值 `{ requireApproval, reason? }`：
 *   - readonly + 有 readOnlyHint → 放行（false）
 *   - readonly + 无 hint      → 拦截（true），reason='trust-readonly-blocks-write'
 *   - ask     + 有 readOnlyHint → 放行（false）
 *   - ask     + 无 hint      → 拦截（true），reason='no-readonly-hint'
 *   - auto    + 任意         → 放行（false，用户显式承担）
 * readonly 拦截态由渲染层渲染**只取消、无放行按钮**的弹窗（见
 * mcp-tool-approval.jsx）；reason 为空表示放行（"—" 列）。
 * @param {{meta?: object, trust?: string}} param0
 * @returns {{requireApproval: boolean, reason?: string}}
 */
function decideToolApproval ({ meta, trust } = {}) {
  const effectiveTrust = trust || 'ask'
  const annotations = (meta && meta.annotations) || {}
  const readOnlyHint = !!(annotations && annotations.readOnlyHint === true)
  if (effectiveTrust === 'readonly') {
    if (readOnlyHint) {
      return { requireApproval: false }
    }
    return { requireApproval: true, reason: 'trust-readonly-blocks-write' }
  }
  if (effectiveTrust === 'ask') {
    if (readOnlyHint) {
      return { requireApproval: false }
    }
    return { requireApproval: true, reason: 'no-readonly-hint' }
  }
  // auto：用户显式承担，永不拦截（无论是否声明 readOnlyHint）
  return { requireApproval: false }
}

/**
 * 污染门：本轮 run 已被外部工具结果污染（tainted）时，对内置写工具拦一次确认。
 * @param {string} toolName 工具名（内置原名，如 sftp_upload）
 * @param {boolean} tainted 本次 run 是否已跑过外部工具结果
 * @returns {boolean}
 */
function requiresTaintApproval (toolName, tainted) {
  return !!tainted && TAINT_GATED_BUILTIN_TOOLS.includes(toolName)
}

export {
  EXTERNAL_TOOL_PREFIX,
  isExternalAlias,
  TAINT_GATED_BUILTIN_TOOLS,
  decideToolApproval,
  requiresTaintApproval
}
