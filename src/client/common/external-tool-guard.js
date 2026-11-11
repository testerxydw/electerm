/**
 * 外部工具守卫（设计 P0-1 §3.4）· 纯函数，无 window。
 *
 * T03 只落 `isExternalAlias`：agent 循环与 `executeToolCall` 都靠「名字以
 * `mcp__` 开头」这一条把外部调用从 36 个内置 case 里分流出去。审批决策表
 * （`decideToolApproval`）与污染门（`requiresTaintApproval`）属 T04 的
 * 批准矩阵/污染门（设计 §5 T04 行），届时补进本模块 —— 现在写就是提前做
 * T04 的一半，lead 明确禁止。
 *
 * 前缀必须与主进程 `src/app/mcp/client/tool-name.js` 的 `PREFIX` 保持一致：
 * 那边是别名的唯一产地，这边只做路由判断。契约由
 * `mcp-agent-external-guard.spec.js` 用源码文本断言钉住（两边任何一边改前缀
 * 而不同步另一边，测试红）。
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

export { EXTERNAL_TOOL_PREFIX, isExternalAlias }
