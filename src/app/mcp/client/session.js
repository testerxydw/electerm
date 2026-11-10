/**
 * MCP client — one session per configured server.
 *
 * A session owns the handshake, the tool table and the small state machine. It
 * is the only place that knows what "connected" means:
 *
 *   idle → connecting → initializing → ready ⇄ degraded → closed
 *                                  ↘ failed ↗
 *
 * `connect()` rejects on failure but always leaves the session in a terminal,
 * inspectable state with no child process and no pending requests behind it —
 * the caller (manager) turns that into a UI badge, not into a crash.
 */

const { JsonRpcPeer, McpRpcError, normalizeError, ERR } = require('./rpc')
const { buildInitializeParams, negotiateVersion, contentToText } = require('./protocol')

const INIT_TIMEOUT_MS = 10000
const LIST_TIMEOUT_MS = 10000
const MAX_LIST_PAGES = 5
const MAX_TOOLS = 200
// 分页总预算：`LIST_TIMEOUT_MS × MAX_LIST_PAGES` 最坏 50s，没有总预算的话一个
// 「每页都慢」的服务端会把首连拖满 50s 才失败。有了预算，单页 timeout 会被压到
// 剩余预算以内，整体耗时可预期。
const LIST_BUDGET_MS = 15000
const FAILURE_THRESHOLD = 2

class McpSession {
  /**
   * @param {{
   *   serverConfig: object, transport: object, clientInfo?: object,
   *   log?: Function
   * }} opts
   */
  constructor ({ serverConfig, transport, clientInfo = {}, log = null, listTimeoutMs = 0 } = {}) {
    this.serverConfig = serverConfig || {}
    this.transport = transport
    this.clientInfo = clientInfo || {}
    this.log = log
    // Per-page tools/list timeout, injectable so tests can simulate a hanging
    // page without waiting the full LIST_TIMEOUT_MS. Clamped by LIST_BUDGET_MS
    // either way (see listTools).
    this.listTimeoutMs = Number(listTimeoutMs) > 0 ? Number(listTimeoutMs) : LIST_TIMEOUT_MS
    this.peer = null
    this.state = 'idle'
    this.protocolVersion = ''
    this.serverInfo = {}
    this.capabilities = {}
    this.tools = []
    this.toolsTruncated = false
    this.lastError = ''
    this.lastNotification = null
    this.consecutiveFailures = 0
  }

  /** @returns {string} */
  get id () {
    return this.serverConfig.id
  }

  /**
   * Run the handshake: initialize → notifications/initialized → tools/list.
   * @returns {Promise<object>} session state snapshot
   */
  async connect () {
    if (this.state === 'ready') {
      return this.getState()
    }
    this._setState('connecting')
    try {
      await this.transport.start()
      this._setState('initializing')
      this.peer = new JsonRpcPeer({
        send: msg => this.transport.send(msg),
        defaultTimeoutMs: this.serverConfig.timeoutMs || 30000,
        onNotification: (msg) => {
          this.lastNotification = msg
        },
        onProtocolError: (err) => {
          this.lastError = err.message
          this._degrade()
        }
      })
      const initResult = await this.peer.request(
        'initialize',
        buildInitializeParams(this.clientInfo),
        { timeoutMs: INIT_TIMEOUT_MS }
      )
      const negotiated = negotiateVersion(initResult)
      if (!negotiated.ok) {
        throw new McpRpcError(negotiated.error.code, negotiated.error.message)
      }
      this.protocolVersion = negotiated.protocolVersion
      this.serverInfo = (initResult && initResult.serverInfo) || {}
      this.capabilities = (initResult && initResult.capabilities) || {}
      await this.peer.notify('notifications/initialized')
      await this.listTools()
      this.consecutiveFailures = 0
      if (this.toolsTruncated && this.lastError) {
        // Connected with a PARTIAL tool table (a page failed mid-listing).
        // Resetting lastError to '' here would erase the only trace of why the
        // table is incomplete — "degraded: <reason>" is the honest state, and
        // `toolsTruncated` stays true so the UI never claims "you see it all".
        this._setState('degraded')
      } else {
        this.lastError = ''
        this._setState('ready')
      }
      return this.getState()
    } catch (err) {
      const error = normalizeError(err)
      this.lastError = error.message
      await this._teardown()
      this._setState('failed')
      throw error
    }
  }

  /**
   * Read the whole tool table, cursor-paged, bounded by MAX_LIST_PAGES/MAX_TOOLS
   * and a total wall-clock budget (LIST_BUDGET_MS).
   *
   * Partial-result tolerance: a failure on page >= 2 must NOT throw away the
   * pages we already hold. Losing them turns a degraded-but-working session
   * into "connection failed" even though every tool we did receive is perfectly
   * callable. Only a failure on page 1 (nothing usable yet) really fails the
   * connect.
   * @returns {Promise<Array<object>>}
   */
  async listTools () {
    if (!this.peer) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, 'session is not connected')
    }
    const tools = []
    let cursor = null
    let truncated = false
    const deadline = Date.now() + LIST_BUDGET_MS
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        truncated = true
        break
      }
      const params = cursor ? { cursor } : {}
      let result
      try {
        result = await this._requestWithSessionRetry('tools/list', params, {
          timeoutMs: Math.min(this.listTimeoutMs, remaining)
        })
      } catch (err) {
        if (!tools.length) {
          // Nothing usable yet → this really is a failed connect.
          throw err
        }
        this.lastError = normalizeError(err).message
        truncated = true
        if (this.state === 'ready') {
          this._setState('degraded')
        }
        console.warn(`[mcp-session] tools/list page ${page + 1} failed, keeping ${tools.length} tools: ${this.lastError}`)
        break
      }
      const batch = result && Array.isArray(result.tools) ? result.tools : []
      for (const tool of batch) {
        if (!tool || typeof tool.name !== 'string' || !tool.name) {
          continue
        }
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema || tool.input_schema || null,
          annotations: tool.annotations && typeof tool.annotations === 'object'
            ? tool.annotations
            : {}
        })
        if (tools.length >= MAX_TOOLS) {
          truncated = true
          break
        }
      }
      cursor = result && result.nextCursor ? result.nextCursor : null
      if (!cursor || truncated) {
        break
      }
    }
    // Hitting the page cap while the server still offers a cursor means the
    // table is incomplete. Reporting `toolsTruncated: false` there would make
    // the UI claim "you see everything" — the one thing a truncation flag must
    // never do.
    if (cursor && !truncated) {
      truncated = true
    }
    this.tools = tools
    this.toolsTruncated = truncated
    return tools
  }

  /**
   * Call one tool. Always resolves the tool's content or throws a structured
   * McpRpcError; never leaves a request dangling.
   * @param {string} name original tool name
   * @param {object} args
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<{content: Array, text: string, isError: boolean}>}
   */
  async callTool (name, args, opts = {}) {
    if (!this.peer) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, 'session is not connected')
    }
    let rpcId = null
    const onStart = (id) => {
      rpcId = id
    }
    try {
      const result = await this._requestWithSessionRetry(
        'tools/call',
        { name, arguments: args || {} },
        {
          timeoutMs: opts.timeoutMs || this.serverConfig.timeoutMs || 30000,
          signal: opts.signal,
          onStart
        }
      )
      return this._toolResult(result)
    } catch (err) {
      const error = normalizeError(err)
      // Tell the server we gave up, so it can stop working on a result nobody
      // will read. Failure to notify is not worth surfacing.
      if (rpcId !== null && (error.code === ERR.TIMEOUT || error.code === ERR.ABORTED)) {
        Promise.resolve(
          this.peer.notify('notifications/cancelled', {
            requestId: rpcId,
            reason: error.code === ERR.TIMEOUT ? 'timeout' : 'aborted'
          })
        ).catch(() => {})
      }
      if (error.code === ERR.TIMEOUT || error.code === ERR.PROTOCOL || error.code === ERR.RPC) {
        this.consecutiveFailures++
        this.lastError = error.message
        if (this.state === 'ready') {
          this._setState('degraded')
        }
        if (this.state === 'degraded' && this.consecutiveFailures >= FAILURE_THRESHOLD) {
          this._setState('failed')
        }
      }
      throw error
    }
  }

  /**
   * Send one request, and if the server answers "I forgot this session" (404 +
   * our session id), re-run the handshake **once** and retry the same request
   * (design §2.3). A second 404 is a real error and reaches the caller.
   * @param {string} method
   * @param {object} params
   * @param {object} [opts]
   * @returns {Promise<*>}
   * @private
   */
  async _requestWithSessionRetry (method, params, opts = {}) {
    try {
      return await this.peer.request(method, params, opts)
    } catch (err) {
      const error = normalizeError(err)
      if (error.code !== ERR.SESSION_EXPIRED) {
        throw error
      }
      await this._rehandshake()
      return this.peer.request(method, params, opts)
    }
  }

  /**
   * Normalize a `tools/call` result and keep the health counters honest.
   * @param {object} result
   * @returns {{content: Array, text: string, isError: boolean}}
   * @private
   */
  _toolResult (result) {
    this.consecutiveFailures = 0
    if (this.state === 'degraded') {
      this._setState('ready')
    }
    const content = result && Array.isArray(result.content) ? result.content : []
    return {
      content,
      text: contentToText(content),
      isError: !!(result && result.isError)
    }
  }

  /**
   * Re-run `initialize` + `notifications/initialized` on the existing transport
   * (session id changed, socket is still fine).
   * @returns {Promise<void>}
   * @private
   */
  async _rehandshake () {
    const initResult = await this.peer.request(
      'initialize',
      buildInitializeParams(this.clientInfo),
      { timeoutMs: INIT_TIMEOUT_MS }
    )
    const negotiated = negotiateVersion(initResult)
    if (!negotiated.ok) {
      throw new McpRpcError(negotiated.error.code, negotiated.error.message)
    }
    this.protocolVersion = negotiated.protocolVersion
    this.serverInfo = (initResult && initResult.serverInfo) || {}
    this.capabilities = (initResult && initResult.capabilities) || {}
    await this.peer.notify('notifications/initialized')
  }

  /**
   * Close the session and make sure no process/handle survives it.
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async close (reason = 'user') {
    if (this.state === 'closed') {
      return
    }
    await this._teardown(reason)
    this._setState('closed')
  }

  /**
   * Transport-level message sink (wired by the manager).
   * @param {object} msg
   * @returns {boolean}
   */
  handleMessage (msg) {
    if (!this.peer) {
      return false
    }
    return this.peer.handleMessage(msg)
  }

  /**
   * The child process died / the socket closed.
   * @param {{code?: number, signal?: string}} [info]
   */
  handleTransportClosed (info = {}) {
    if (this.state === 'closed') {
      return
    }
    const detail = info.signal ? `signal ${info.signal}` : `code ${info.code}`
    this.lastError = `transport closed (${detail})`
    if (this.peer) {
      this.peer.dispose(this.lastError)
    }
    this._setState('failed')
  }

  /**
   * @param {Error} err
   */
  handleProtocolError (err) {
    const error = normalizeError(err)
    this.lastError = error.message
    this._degrade()
  }

  /** @returns {object} state snapshot safe to hand to the renderer */
  getState () {
    return {
      id: this.id,
      name: this.serverConfig.name || this.id,
      transport: this.serverConfig.transport || '',
      trust: this.serverConfig.trust || 'ask',
      state: this.state,
      protocolVersion: this.protocolVersion,
      toolCount: this.tools.length,
      toolsTruncated: this.toolsTruncated,
      lastError: this.lastError,
      serverInfo: {
        name: this.serverInfo.name || '',
        version: this.serverInfo.version || ''
      },
      pending: this.peer ? this.peer.pendingCount : 0
    }
  }

  /**
   * @param {string} [reason]
   * @returns {Promise<void>}
   * @private
   */
  async _teardown (reason = 'teardown') {
    if (this.peer) {
      this.peer.dispose(reason)
    }
    try {
      await this.transport.close(reason)
    } catch (_) {
      // a transport that fails to close is already gone from our point of view
    }
  }

  /**
   * @private
   */
  _degrade () {
    if (this.state === 'ready') {
      this._setState('degraded')
    }
  }

  /**
   * @param {string} state
   * @private
   */
  _setState (state) {
    if (this.state === state) {
      return
    }
    this.state = state
    if (this.log) {
      this.log(`[mcp] ${this.serverConfig.name || this.id} → ${state}`)
    }
  }
}

module.exports = {
  McpSession,
  INIT_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  LIST_BUDGET_MS,
  MAX_LIST_PAGES,
  MAX_TOOLS
}
