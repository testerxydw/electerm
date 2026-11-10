/**
 * MCP client — JSON-RPC 2.0 peer (id pairing, timeout, cancellation).
 *
 * Two properties matter more than completeness here:
 *
 * 1. **A pending request always settles.** Timeout, abort signal, transport
 *    error and `dispose()` all go through `_fail()`, which clears the timer and
 *    detaches the abort listener. The agent loop must never wait on a server
 *    that went silent (M8).
 * 2. **Errors are structured, never raw stacks.** Everything leaves this module
 *    as `{code, message}` so the IPC boundary can forward it verbatim.
 */

const {
  isResponse,
  isNotification,
  isServerRequest,
  buildErrorResponse
} = require('./protocol')

// Error codes are part of the contract with the renderer (see design §2.6).
const ERR = {
  TIMEOUT: 'mcp_timeout',
  ABORTED: 'mcp_aborted',
  TRANSPORT_CLOSED: 'mcp_transport_closed',
  PROTOCOL: 'mcp_protocol_error',
  RPC: 'mcp_rpc_error',
  HTTP_UNAUTHORIZED: 'mcp_http_unauthorized',
  SESSION_EXPIRED: 'mcp_session_expired',
  VERSION_UNSUPPORTED: 'mcp_protocol_version_unsupported',
  UNAVAILABLE: 'mcp_server_unavailable',
  UNKNOWN_TOOL: 'unknown_external_tool',
  BUSY: 'mcp_busy',
  INVALID_ARGS: 'invalid_tool_arguments',
  INTERNAL: 'mcp_internal_error'
}

const NETWORK_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
]

class McpRpcError extends Error {
  /**
   * @param {string} code one of ERR.*
   * @param {string} message human readable, must not contain credentials
   * @param {object} [details] extra structured fields (rpcCode, timeoutMs, …)
   */
  constructor (code, message, details = {}) {
    super(message)
    this.name = 'McpRpcError'
    this.code = code
    this.details = details || {}
  }

  /**
   * Plain object for IPC / tool-result JSON.
   * @returns {{code: string, message: string}}
   */
  toErrorObject () {
    return { code: this.code, message: this.message, ...this.details }
  }
}

/**
 * Convert anything thrown by a transport into a structured McpRpcError.
 * @param {*} err
 * @returns {McpRpcError}
 */
function normalizeError (err) {
  if (err instanceof McpRpcError) {
    return err
  }
  if (!err) {
    return new McpRpcError(ERR.TRANSPORT_CLOSED, 'transport closed')
  }
  const code = err.code || (err.cause && err.cause.code)
  if (err.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT') {
    return new McpRpcError(ERR.TIMEOUT, err.message || 'request timed out')
  }
  if (code && NETWORK_CODES.includes(code)) {
    // Keep the syscall code (it tells the user "refused" from "unknown host")
    // but drop the stack: the IPC boundary must not forward one.
    return new McpRpcError(
      ERR.TRANSPORT_CLOSED,
      `${code}: ${err.message || 'connection failed'}`
    )
  }
  return new McpRpcError(ERR.TRANSPORT_CLOSED, err.message || String(err))
}

class JsonRpcPeer {
  /**
   * @param {{
   *   send: (msg: object) => (void|Promise<void>),
   *   defaultTimeoutMs?: number,
   *   onNotification?: Function,
   *   onProtocolError?: Function,
   *   onServerRequest?: Function
   * }} opts
   */
  constructor ({
    send,
    defaultTimeoutMs = 30000,
    onNotification = null,
    onProtocolError = null,
    onServerRequest = null
  } = {}) {
    this.send = send
    this.defaultTimeoutMs = defaultTimeoutMs
    this.onNotification = onNotification
    this.onProtocolError = onProtocolError
    this.onServerRequest = onServerRequest
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this.closeReason = ''
  }

  /**
   * Send a request and wait for its response.
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal, onStart?: Function}} [opts]
   * @returns {Promise<*>} JSON-RPC `result`
   */
  request (method, params, opts = {}) {
    if (this.closed) {
      return Promise.reject(new McpRpcError(
        ERR.TRANSPORT_CLOSED,
        `transport is closed (${this.closeReason || 'closed'})`
      ))
    }
    const id = this.nextId++
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : this.defaultTimeoutMs

    let entry = null
    const promise = new Promise((resolve, reject) => {
      entry = { id, method, resolve, reject, timer: null, detach: null }
    })

    entry.timer = setTimeout(() => {
      this._fail(id, new McpRpcError(
        ERR.TIMEOUT,
        `${method} timed out after ${timeoutMs} ms`,
        { timeoutMs }
      ))
    }, timeoutMs)
    // Deliberately **not** unref'd: a pending request is real work, and the
    // timeout is the only thing that will ever settle it. Unref'ing here makes a
    // short-lived process exit with the promise silently unresolved (observable
    // as "the event loop resolved while a request was still pending").

    const signal = opts.signal
    if (signal) {
      if (signal.aborted) {
        entry.timer && clearTimeout(entry.timer)
        return Promise.reject(new McpRpcError(ERR.ABORTED, `${method} was aborted before it started`))
      }
      const onAbort = () => this.cancel(id, 'aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detach = () => signal.removeEventListener('abort', onAbort)
    }

    this.pending.set(id, entry)
    if (typeof opts.onStart === 'function') {
      opts.onStart(id)
    }
    this._dispatch({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  /**
   * Send a notification (no id, no response expected).
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<void>} resolves once the transport accepted it
   */
  notify (method, params) {
    if (this.closed) {
      return Promise.resolve()
    }
    const msg = { jsonrpc: '2.0', method }
    if (params !== undefined) {
      msg.params = params
    }
    return this._dispatch(msg)
  }

  /**
   * Abort one pending request right now (does not wait for the timeout).
   * @param {number} id
   * @param {string} [reason]
   * @returns {boolean} whether a pending request was found
   */
  cancel (id, reason = 'aborted') {
    return this._fail(id, new McpRpcError(ERR.ABORTED, `request ${id} cancelled: ${reason}`))
  }

  /**
   * Route one incoming message from the transport.
   * @param {object} msg
   * @returns {boolean} whether the message was understood
   */
  handleMessage (msg) {
    if (isResponse(msg)) {
      const entry = this.pending.get(msg.id)
      if (!entry) {
        // Response to a request we already timed out on: drop it, do not crash.
        return true
      }
      if (msg.error) {
        this._settle(msg.id, new McpRpcError(
          ERR.RPC,
          msg.error.message || 'JSON-RPC error',
          { rpcCode: msg.error.code, data: msg.error.data }
        ))
      } else {
        this._settle(msg.id, null, msg.result)
      }
      return true
    }
    if (isServerRequest(msg)) {
      // P0 implements no server→client requests; answering -32601 keeps the
      // server from waiting on us forever.
      const reply = buildErrorResponse(msg.id, -32601, `client does not support ${msg.method}`)
      this._dispatch(reply)
      if (this.onServerRequest) {
        this.onServerRequest(msg)
      }
      return true
    }
    if (isNotification(msg)) {
      if (this.onNotification) {
        this.onNotification(msg)
      }
      return true
    }
    if (this.onProtocolError) {
      this.onProtocolError(new McpRpcError(
        ERR.PROTOCOL,
        'incoming message is neither a response nor a notification'
      ))
    }
    return false
  }

  /**
   * Reject every pending request and refuse new ones (transport closed).
   * @param {string} [reason]
   */
  dispose (reason = 'closed') {
    if (this.closed) {
      return
    }
    this.closed = true
    this.closeReason = reason
    for (const id of Array.from(this.pending.keys())) {
      this._fail(id, new McpRpcError(
        ERR.TRANSPORT_CLOSED,
        `transport closed: ${reason}`
      ))
    }
  }

  /**
   * @returns {number} number of in-flight requests (test/debug aid)
   */
  get pendingCount () {
    return this.pending.size
  }

  /**
   * @param {object} msg
   * @returns {Promise<void>}
   * @private
   */
  _dispatch (msg) {
    let result
    try {
      result = this.send(msg)
    } catch (err) {
      this._failAfterSend(msg, err)
      return Promise.resolve()
    }
    if (result && typeof result.then === 'function') {
      return result.then(() => {}, (err) => {
        this._failAfterSend(msg, err)
      })
    }
    return Promise.resolve()
  }

  /**
   * A transport-level send failure settles the request immediately instead of
   * leaving it to the timeout.
   * @param {object} msg
   * @param {*} err
   * @private
   */
  _failAfterSend (msg, err) {
    if (msg.id === undefined || msg.id === null) {
      if (this.onProtocolError) {
        this.onProtocolError(normalizeError(err))
      }
      return
    }
    this._fail(msg.id, normalizeError(err))
  }

  /**
   * @param {number} id
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _fail (id, err) {
    return this._settle(id, err)
  }

  /**
   * @param {number} id
   * @param {Error|null} err
   * @param {*} [value]
   * @returns {boolean}
   * @private
   */
  _settle (id, err, value) {
    const entry = this.pending.get(id)
    if (!entry) {
      return false
    }
    this.pending.delete(id)
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    if (typeof entry.detach === 'function') {
      entry.detach()
    }
    if (err) {
      entry.reject(err)
    } else {
      entry.resolve(value)
    }
    return true
  }
}

module.exports = {
  JsonRpcPeer,
  McpRpcError,
  normalizeError,
  ERR,
  NETWORK_CODES
}
