/**
 * MCP client — the IPC façade.
 *
 * Everything the renderer can do with external MCP servers goes through these
 * functions, and every one of them is a **total function**: it returns a
 * structured object and never throws. `ipc.js` forwards the return value
 * straight to `ipcRenderer.invoke`, so a thrown error would surface in the
 * renderer as "Error invoking remote method" — a message that tells neither the
 * user nor the model what to do next.
 *
 * The façade deliberately owns no logic of its own: it reads the configuration
 * from the single source of truth (`globalState.config.mcpServersAI`), hands it
 * to the singleton manager and formats errors. Connection lifecycle, aliasing
 * and call routing live in `manager.js`.
 */

const globalState = require('../../lib/glob-state')
const { getManager, resetManager } = require('./manager')
const { normalizeError, McpRpcError, ERR } = require('./rpc')

const MAX_BUILTIN_NAMES = 200
const MAX_WARNINGS = 20

let loggerAttached = false

/**
 * `../common/log` pulls in `runtime-constants`, which resolves a packaged-only
 * `package.json` — requiring it at module load would break unit tests that only
 * want the façade. Resolved lazily and never allowed to fail the call path.
 * @param {string} message
 */
function writeLog (message) {
  if (loggerAttached) {
    return
  }
  loggerAttached = true
  try {
    const log = require('../../common/log')
    if (log && typeof log.info === 'function') {
      log.info(message)
      return
    }
  } catch (_) {
    // logging is never a reason to fail an MCP call
  }
  // eslint-disable-next-line no-console
  console.info(message)
}

/**
 * Read `mcpServersAI` from the live config.
 *
 * The value is returned **as-is** (only null/undefined become "no servers"):
 * deciding whether it is a valid list is `config-validate.js`'s job, and
 * swallowing `{a:1}` / `"nope"` here would turn a broken config into "you have
 * no servers" — the exact silent-downgrade the validator exists to prevent.
 * @returns {Array|object|string|number}
 */
function readServers () {
  const config = globalState.get('config')
  const raw = config && config.mcpServersAI
  if (raw === undefined || raw === null) {
    return []
  }
  return raw
}

/**
 * @returns {import('./manager').McpClientManager}
 */
function ensureManager () {
  return getManager({ getServers: readServers, log: writeLog })
}

/**
 * @param {*} list
 * @returns {string[]}
 */
function normalizeBuiltinNames (list) {
  if (Array.isArray(list)) {
    return list
      .filter(name => typeof name === 'string' && name)
      .slice(0, MAX_BUILTIN_NAMES)
  }
  if (list && typeof list.forEach === 'function' && typeof list.has === 'function') {
    return Array.from(list).filter(name => typeof name === 'string' && name).slice(0, MAX_BUILTIN_NAMES)
  }
  return []
}

/**
 * @param {*} err
 * @param {string} [fallbackCode]
 * @returns {{code: string, message: string}}
 */
function toErrorObject (err, fallbackCode = ERR.INTERNAL) {
  const error = normalizeError(err)
  const object = error.toErrorObject()
  if (!object.code) {
    object.code = fallbackCode
  }
  return object
}

/**
 * The external tool set, ready to be concatenated with the built-in tools.
 *
 * `syncConfig()` runs here on purpose: it is idempotent (a signature comparison
 * decides whether a connection must be restarted), so "user saved a server,
 * renderer refreshed the list" works without a second IPC round trip and
 * without the renderer having to know about connection state.
 *
 * @param {{builtinToolNames?: string[]|Set<string>}} [opts]
 * @returns {Promise<{tools: Array, meta: object, servers: Array,
 *   truncated: {perServer: number, global: number}, warnings: string[],
 *   configErrors: Array<{index: number, field: string, message: string}>}>}
 */
exports.mcpClientGetTools = async (opts = {}) => {
  const empty = {
    tools: [],
    meta: {},
    servers: [],
    truncated: { perServer: 0, global: 0 },
    warnings: [],
    configErrors: []
  }
  try {
    const manager = ensureManager()
    const servers = readServers()
    const states = await manager.syncConfig(servers)
    if (opts && opts.force) {
      // Refresh 按钮（渲染侧 `mcpClientRefresh` / 重试路径都传 force:true）。
      // 连接签名只覆盖配置，服务端运行期新增的工具只有显式重拉 tools/list
      // 才能看见——这个参数之前是个死参数，等于按钮刷新不出新工具。
      await manager.refreshTools()
    }
    const toolSet = manager.getToolSet({
      builtinToolNames: normalizeBuiltinNames(opts && opts.builtinToolNames)
    })
    return {
      tools: toolSet.openaiTools,
      meta: toolSet.meta,
      servers: states,
      truncated: toolSet.truncated,
      warnings: manager.warnings.slice(-MAX_WARNINGS),
      // 结构化错误（index + field）供设置页高亮具体那一行；字符串版在 warnings
      configErrors: manager.configErrors.slice(0, MAX_WARNINGS)
    }
  } catch (err) {
    return {
      ...empty,
      error: toErrorObject(err)
    }
  }
}

/**
 * Route one external tool call. The agent loop renders the returned object as
 * the tool result, so a failure is data, never an exception.
 * @param {string} alias
 * @param {object} [args]
 * @param {{runId?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<object>}
 */
exports.mcpClientCallTool = async (alias, args = {}, opts = {}) => {
  try {
    if (typeof alias !== 'string' || !alias) {
      return {
        ok: false,
        error: {
          code: ERR.UNKNOWN_TOOL,
          message: 'external tool name is missing'
        }
      }
    }
    if (args === null || args === undefined) {
      args = {}
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
      return {
        ok: false,
        error: {
          code: ERR.INVALID_ARGS,
          message: 'tool arguments must be a JSON object'
        }
      }
    }
    const manager = ensureManager()
    return await manager.callTool(alias, args, {
      timeoutMs: opts && opts.timeoutMs,
      runId: opts && opts.runId
    })
  } catch (err) {
    return { ok: false, error: toErrorObject(err) }
  }
}

/**
 * One entry per configured server, for the status badges.
 *
 * `syncConfig()` runs here too (same idempotent path as `mcpClientGetTools`):
 * without it, `manager.configs` is empty until the first `getTools`, so a UI
 * that renders badges before fetching tools would claim "no servers" while the
 * user is looking at three configured ones (defect Q-1, 2026-11-10).
 *
 * The catch keeps the `Array` contract (design §3.4) but must NOT be silent:
 * a thrown manager and "no servers" would otherwise look identical in the UI.
 * @returns {Promise<Array<object>>} one entry per configured server
 */
exports.mcpClientGetState = async () => {
  try {
    const manager = ensureManager()
    await manager.syncConfig(readServers())
    return manager.getState()
  } catch (err) {
    writeLog('[mcp-client] getState failed: ' + (err && err.message ? err.message : String(err)))
    return []
  }
}

/**
 * Restart one server (the "Retry" button next to a failed badge).
 * @param {string} serverId
 * @returns {Promise<{ok: boolean, state?: object, error?: object}>}
 */
exports.mcpClientRestart = async (serverId) => {
  try {
    if (typeof serverId !== 'string' || !serverId) {
      return {
        ok: false,
        error: { code: ERR.UNAVAILABLE, message: 'serverId is required' }
      }
    }
    const manager = ensureManager()
    if (!isKnownServer(manager, serverId)) {
      // The renderer may be looking at a list the manager has not synced yet.
      await manager.syncConfig(readServers())
    }
    if (!isKnownServer(manager, serverId)) {
      throw new McpRpcError(ERR.UNAVAILABLE, `unknown MCP server: ${serverId}`)
    }
    const state = await manager.restart(serverId)
    return { ok: true, state }
  } catch (err) {
    return { ok: false, error: toErrorObject(err) }
  }
}

/**
 * @param {import('./manager').McpClientManager} manager
 * @param {string} serverId
 * @returns {boolean}
 */
function isKnownServer (manager, serverId) {
  const configs = Array.isArray(manager.configs) ? manager.configs : []
  return configs.some(config => config.id === serverId)
}

/**
 * Reconciliation entry point after a settings save.
 * @param {Array} [servers] the list the renderer just saved; omitted = re-read
 *   from the main-process config
 * @returns {Promise<{ok: boolean, servers: Array, error?: object}>}
 */
exports.mcpClientOnConfigChange = async (servers = null) => {
  try {
    const manager = ensureManager()
    const states = await manager.syncConfig(
      Array.isArray(servers) ? servers : readServers()
    )
    return { ok: true, servers: states }
  } catch (err) {
    return { ok: false, servers: [], error: toErrorObject(err) }
  }
}

/**
 * Abort every in-flight external tool call of one agent run (M30).
 * Wired from the renderer's stop button via `store.mcpClientCancelRun`.
 * Unknown runId is a no-op (returns cancelled: 0), never a throw.
 * @param {string} runId
 * @returns {Promise<{ok: boolean, cancelled: number, error?: object}>}
 */
exports.mcpClientCancelRun = async (runId) => {
  try {
    const manager = ensureManager()
    return { ok: true, cancelled: manager.cancelRun(runId) }
  } catch (err) {
    return { ok: false, cancelled: 0, error: toErrorObject(err) }
  }
}

/**
 * App shutdown (wired to `will-quit` in `ipc.js`): no child process may outlive
 * the app (M9).
 *
 * `killAllNow()` runs first and synchronously, because `will-quit` handlers
 * cannot await anything: if the event loop never comes back, the SIGTERM has
 * still been delivered. The await below is the tidy path (wait for the real
 * exit, close HTTP sessions).
 * @returns {Promise<void>}
 */
exports.shutdownMcpClients = async () => {
  try {
    const manager = getManager()
    manager.killAllNow()
    await manager.shutdownAll()
  } catch (_) {
    // nothing left to do while the app is going away
  } finally {
    resetManager()
  }
}
