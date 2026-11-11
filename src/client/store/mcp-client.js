/**
 * 外部 MCP 工具（设计 P0-1）· 渲染层 store 扩展
 *
 * 职责边界：**只做转发与缓存**。别名反查、连接生命周期、审批判定都不在这里
 * ——反查只在主进程（截断/哈希后的名字渲染层无法反解），审批在
 * `common/external-tool-guard.js`（T04）。这样渲染层不持有第二份映射，
 * 也就不会出现两份映射漂移。
 *
 * 另一件事是**兜底超时**（M8）：主进程若因为 spawn 卡住、事件循环被占满而长
 * 时间不回包，`ipcRenderer.invoke` 的 promise 会一直挂着，agent 循环随之挂住。
 * 这里给每个 IPC 调用加了一个比业务超时更宽松的看门狗，超时返回结构化错误。
 */

// 看门狗常量（T04 审批路径会复用同一套，不许在调用点硬编码数字）：
// 两者都必须**大于主进程业务超时**——主进程的 mcp_timeout / 钳制值先到，
// 这里的看门狗只兜「主进程整个事件循环卡死」的底，先于它触发就会把主进程
// 还能收敛的结果误杀成超时。
const GET_TOOLS_TIMEOUT_MS = 20000
const CALL_TIMEOUT_PADDING_MS = 5000
const DEFAULT_CALL_TIMEOUT_MS = 60000
// M30：run 被 stop 时，renderer 侧挂起的外部调用立刻按这个码 settle，不等
// 主进程超时（主进程侧由 `mcpClientCancelRun` → manager.cancelRun abort）。
const ABORTED_CODE = 'mcp_aborted'
const ABORTED_MESSAGE = 'external tool call aborted (agent run stopped)'

// runId → Set<{settle}>：本次 run 仍挂着的 mcpClientCallTool。stop 时由
// mcpClientCancelRun 全部 settle 掉，保证 agent 循环的 await 收敛、不遗留
// 悬挂 promise/看门狗 timer。
const pendingByRun = new Map()

/**
 * @param {string} runId
 * @returns {{promise: Promise, settle: Function}}
 */
function registerPendingCall (runId) {
  let settle
  const promise = new Promise(resolve => {
    settle = resolve
  })
  let set = pendingByRun.get(runId)
  if (!set) {
    set = new Set()
    pendingByRun.set(runId, set)
  }
  const entry = { settle }
  set.add(entry)
  return { promise, entry }
}

/**
 * @param {string} runId
 * @param {{entry: object}} reg
 * @returns {void}
 */
function unregisterPendingCall (runId, reg) {
  const set = pendingByRun.get(runId)
  if (!set) {
    return
  }
  set.delete(reg.entry)
  if (!set.size) {
    pendingByRun.delete(runId)
  }
}

/**
 * 空工具集。每次返回新对象，避免调用方改到缓存。
 * @returns {{tools: Array, meta: object, servers: Array,
 *   truncated: {perServer: number, global: number}}}
 */
function emptyToolSet () {
  return {
    tools: [],
    meta: {},
    servers: [],
    truncated: { perServer: 0, global: 0 }
  }
}

/**
 * 结构化错误。
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
function failure (code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 取全局 store（组件外调用时 window.store 一定已存在；测试里可能没有）。
 * @returns {object|null}
 */
function getStore () {
  return (typeof window !== 'undefined' && window.store) || null
}

/**
 * 取 IPC 转发函数；web 版没有 pre 桥，返回 null 由调用方降级。
 * @returns {Function|null}
 */
function getInvoker () {
  if (typeof window === 'undefined') {
    return null
  }
  const pre = window.pre
  if (!pre || typeof pre.runGlobalAsync !== 'function') {
    return null
  }
  return (name, ...args) => pre.runGlobalAsync(name, ...args)
}

/**
 * 给一个 promise 加看门狗。超时**不**取消主进程的工作（那边有自己的超时），
 * 只是让调用方拿到结果继续走，避免整个 agent 循环被一个挂死的 IPC 拖住。
 * @param {Promise} promise
 * @param {number} ms
 * @param {Function} onTimeout
 * @returns {Promise<*>}
 */
function withWatchdog (promise, ms, onTimeout) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer)
    }
  })
}

/**
 * @param {object} Store
 */
export default Store => {
  /**
   * 拉取外部工具集并写入缓存。
   * @param {{builtinToolNames?: string[], force?: boolean}} [opts]
   * @returns {Promise<object>} 主进程返回的结构化结果
   */
  Store.prototype.mcpClientGetTools = async function (opts = {}) {
    const store = getStore()
    const invoke = getInvoker()
    if (!invoke) {
      return emptyToolSet()
    }
    const payload = {}
    if (Array.isArray(opts.builtinToolNames)) {
      payload.builtinToolNames = opts.builtinToolNames
    }
    let res
    try {
      res = await withWatchdog(
        invoke('mcpClientGetTools', payload),
        GET_TOOLS_TIMEOUT_MS,
        () => ({
          ...emptyToolSet(),
          error: {
            code: 'mcp_timeout',
            message: `loading MCP tools did not finish within ${GET_TOOLS_TIMEOUT_MS} ms`
          }
        })
      )
    } catch (err) {
      res = {
        ...emptyToolSet(),
        error: {
          code: 'mcp_internal_error',
          message: (err && err.message) || 'failed to load MCP tools'
        }
      }
    }
    const result = res || emptyToolSet()
    if (store) {
      store.mcpExternalTools = Array.isArray(result.tools) ? result.tools : []
      store.mcpExternalToolMeta = result.meta && typeof result.meta === 'object'
        ? result.meta
        : {}
      store.mcpServerStates = Array.isArray(result.servers) ? result.servers : []
    }
    return result
  }

  /**
   * 强制刷新（设置页的 Refresh tools 按钮）。
   * @returns {Promise<object>}
   */
  Store.prototype.mcpClientRefresh = async function () {
    return this.mcpClientGetTools({ force: true })
  }

  /**
   * 调用一个外部工具。**永不 reject**：失败也是 `{ok:false, error}`，
   * agent 循环把它当工具结果渲染即可（M8）。
   *
   * 收敛（M30）：`opts.signal` 中止或 `mcpClientCancelRun(runId)` 触发时，
   * 本 promise 立刻以 `mcp_aborted` settle（看门狗 timer 在 finally 清掉），
   * 并 best-effort 通知主进程 abort 真正的 tools/call。
   * @param {string} alias `mcp__<serverId>__<tool>`
   * @param {object} [args]
   * @param {{runId?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<object>}
   */
  Store.prototype.mcpClientCallTool = async function (alias, args = {}, opts = {}) {
    if (typeof alias !== 'string' || !alias) {
      return failure('unknown_external_tool', 'external tool name is missing')
    }
    const invoke = getInvoker()
    if (!invoke) {
      return failure(
        'mcp_server_unavailable',
        'MCP client is only available in the desktop app'
      )
    }
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_CALL_TIMEOUT_MS
    const watchdogMs = timeoutMs + CALL_TIMEOUT_PADDING_MS
    const runId = typeof opts.runId === 'string' && opts.runId ? opts.runId : ''
    const signal = opts.signal || null
    const reg = runId ? registerPendingCall(runId) : null
    // signal → 竞速 promise；不占 timer（事件监听挂在 signal 上，finally 移除）
    let onAbort = null
    const abortPromise = new Promise(resolve => {
      if (!signal) {
        return
      }
      if (signal.aborted) {
        resolve(true)
        return
      }
      onAbort = () => resolve(true)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const mainCall = withWatchdog(
        invoke('mcpClientCallTool', alias, args, {
          runId,
          timeoutMs
        }),
        watchdogMs,
        () => failure(
          'mcp_timeout',
          `MCP tool call did not finish within ${watchdogMs} ms`
        )
      )
      const racers = [mainCall, abortPromise]
      if (reg) {
        racers.push(reg.promise)
      }
      const winner = await Promise.race(racers)
      if (winner === true) {
        // signal 中止：best-effort 让主进程也停（真正的主进程侧取消由
        // stopAgentRun → mcpClientCancelRun 完成，这里是兜底）
        if (runId) {
          Promise.resolve(invoke('mcpClientCancelRun', runId)).catch(() => {})
        }
        return failure(ABORTED_CODE, ABORTED_MESSAGE)
      }
      const res = winner
      if (!res || typeof res !== 'object') {
        return failure('mcp_internal_error', 'MCP client returned an empty result')
      }
      return res
    } catch (err) {
      return failure(
        'mcp_internal_error',
        (err && err.message) || 'MCP tool call failed'
      )
    } finally {
      if (onAbort && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      if (reg) {
        unregisterPendingCall(runId, reg)
      }
    }
  }

  /**
   * 取消一次 run 挂着的全部外部工具调用（M30，stopAgentRun 调用）。
   * renderer 侧立刻 settle（agent 循环的 await 马上收敛），主进程侧由
   * manager.cancelRun 按 runId abort 真正的 tools/call。
   * @param {string} runId
   * @returns {Promise<{ok: boolean, settled: number, error?: object}>}
   */
  Store.prototype.mcpClientCancelRun = async function (runId) {
    const set = typeof runId === 'string' ? pendingByRun.get(runId) : null
    let settled = 0
    if (set) {
      for (const entry of set) {
        entry.settle(failure(ABORTED_CODE, ABORTED_MESSAGE))
        settled++
      }
      pendingByRun.delete(runId)
    }
    const invoke = getInvoker()
    if (invoke) {
      try {
        await invoke('mcpClientCancelRun', runId)
      } catch (err) {
        return { ok: false, settled, error: failure('mcp_internal_error', (err && err.message) || 'cancel failed').error }
      }
    }
    return { ok: true, settled }
  }

  /**
   * 每台 server 的状态徽章（同步返回缓存，不阻塞渲染）。
   * @returns {Array<object>}
   */
  Store.prototype.mcpClientState = function () {
    const store = getStore()
    return (store && Array.isArray(store.mcpServerStates))
      ? store.mcpServerStates
      : []
  }

  /**
   * 重连一台 server（状态徽章旁的 Retry）。
   * @param {string} serverId
   * @returns {Promise<object>}
   */
  Store.prototype.mcpClientRestart = async function (serverId) {
    const invoke = getInvoker()
    if (!invoke) {
      return failure(
        'mcp_server_unavailable',
        'MCP client is only available in the desktop app'
      )
    }
    try {
      const res = await invoke('mcpClientRestart', serverId)
      await this.mcpClientGetTools({ force: true })
      return res || failure('mcp_internal_error', 'restart returned no result')
    } catch (err) {
      return failure(
        'mcp_internal_error',
        (err && err.message) || 'restart failed'
      )
    }
  }

  /**
   * 配置保存后对齐连接（主进程按 signature 决定是否真的重连）。
   * @param {Array} [servers] 刚保存的列表；省略则由主进程自行读取
   * @returns {Promise<object>}
   */
  Store.prototype.mcpClientSyncConfig = async function (servers = null) {
    const invoke = getInvoker()
    if (!invoke) {
      return { ok: true, servers: [] }
    }
    try {
      const res = await invoke('mcpClientOnConfigChange', servers)
      return res || { ok: true, servers: [] }
    } catch (err) {
      return failure(
        'mcp_internal_error',
        (err && err.message) || 'config sync failed'
      )
    }
  }
}
