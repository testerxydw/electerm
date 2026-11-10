/**
 * MCP client — Streamable HTTP transport.
 *
 * One instance == one endpoint. A POST carries exactly one JSON-RPC message and
 * the server may answer three ways, all of which are normal:
 *
 *   202/204                     → notification accepted, no body
 *   application/json            → one response message
 *   text/event-stream           → SSE frames; the response we want is the one
 *                                 whose `id` matches, after which the stream is
 *                                 abandoned (we never open the GET listening
 *                                 stream, see design §2.3)
 *
 * Failures are translated to structured codes here: `401` must not read as a
 * generic transport error (the user has a fixable problem), and a refused TCP
 * connection must not surface as a raw ECONNREFUSED stack.
 */

const { SseDecoder } = require('./sse')
const { McpRpcError, ERR, normalizeError } = require('./rpc')
const { isResponse } = require('./protocol')

const DEFAULT_TIMEOUT_MS = 30000
const SESSION_HEADER = 'mcp-session-id'

class HttpTransport {
  /**
   * @param {{
   *   url: string, headers?: object, timeoutMs?: number,
   *   onMessage?: Function, fetchImpl?: Function, label?: string,
   *   protocolVersion?: string
   * }} opts
   */
  constructor ({
    url,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onMessage = null,
    fetchImpl = null,
    label = '',
    protocolVersion = ''
  } = {}) {
    this.url = url
    this.headers = headers || {}
    this.timeoutMs = timeoutMs
    this.onMessage = onMessage
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args))
    this.label = label
    this.protocolVersion = protocolVersion
    this.sessionId = ''
    this.closed = false
  }

  /**
   * Validate the endpoint before any request goes out.
   * @returns {Promise<{url: string}>}
   */
  async start () {
    let parsed
    try {
      parsed = new URL(this.url)
    } catch (_) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, `invalid MCP server url: ${this.url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new McpRpcError(
        ERR.TRANSPORT_CLOSED,
        `unsupported MCP server url protocol: ${parsed.protocol}`
      )
    }
    return { url: this.url }
  }

  /**
   * POST one JSON-RPC message.
   * @param {object} msg
   * @returns {Promise<void>} resolves once the answer (if any) was handed to
   *   `onMessage`; rejects with a structured McpRpcError on transport failure
   */
  async send (msg) {
    if (this.closed) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, 'http transport is closed')
    }
    if (msg && msg.method === 'initialize' && this.sessionId) {
      // `initialize` establishes a NEW session. Re-playing a stale
      // `Mcp-Session-Id` on it is exactly what a strict server rejects with
      // 400/404 ("unknown session id") — which would make the session-expired
      // re-handshake retry loop fail forever, i.e. the exact situation §2.3
      // exists to recover from. Drop it and adopt whatever the server hands
      // back below.
      this.sessionId = null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    let res
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this._requestHeaders(),
        body: JSON.stringify(msg),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
      throw this._transportError(err)
    }

    try {
      const sessionId = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get(SESSION_HEADER)
        : null
      if (sessionId) {
        this.sessionId = sessionId
      }

      if (res.status === 401 || res.status === 403) {
        // The URL is part of the message on purpose: with several servers
        // configured, "check the headers" alone gives the user no way to tell
        // which one to fix (the unreachable branch below already names it).
        throw new McpRpcError(
          ERR.HTTP_UNAUTHORIZED,
          `MCP server at ${this.url} rejected the credentials (HTTP ${res.status}) — check the headers for this server`
        )
      }
      if (res.status === 404 && this.sessionId && msg.method !== 'initialize') {
        throw new McpRpcError(
          ERR.SESSION_EXPIRED,
          `MCP session expired at ${this.url} (HTTP 404) — re-running the handshake once`
        )
      }
      if (res.status === 202 || res.status === 204) {
        return
      }
      if (!res.ok) {
        const body = await this._readText(res)
        throw new McpRpcError(
          ERR.TRANSPORT_CLOSED,
          `MCP server answered HTTP ${res.status}: ${truncate(body)}`
        )
      }

      const contentType = (res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-type')
        : '') || ''
      if (contentType.includes('text/event-stream')) {
        await this._consumeSse(res, msg)
        return
      }
      const text = await this._readText(res)
      if (!text) {
        return
      }
      let payload
      try {
        payload = JSON.parse(text)
      } catch (_) {
        throw new McpRpcError(
          ERR.PROTOCOL,
          `MCP server returned a non-JSON body: ${truncate(text)}`
        )
      }
      this._deliver(payload, msg)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Tell the server this session is over. Failures are ignored on purpose: the
   * connection is going away either way.
   * @returns {Promise<void>}
   */
  async close () {
    if (this.closed) {
      return
    }
    this.closed = true
    if (!this.sessionId) {
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    try {
      await this.fetchImpl(this.url, {
        method: 'DELETE',
        headers: this._requestHeaders(),
        signal: controller.signal
      })
    } catch (_) {
      // best effort
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @returns {object}
   * @private
   */
  _requestHeaders () {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers
    }
    if (this.sessionId) {
      headers[SESSION_HEADER] = this.sessionId
    }
    return headers
  }

  /**
   * Read an SSE body until our response arrives.
   * @param {Response} res
   * @param {object} msg the request we are answering
   * @returns {Promise<void>}
   * @private
   */
  async _consumeSse (res, msg) {
    const decoder = new SseDecoder()
    if (!res.body) {
      throw new McpRpcError(ERR.PROTOCOL, 'MCP server sent an empty event-stream')
    }
    let delivered = false
    for await (const chunk of res.body) {
      let events
      try {
        events = decoder.push(chunk)
      } catch (err) {
        throw new McpRpcError(ERR.PROTOCOL, err.message)
      }
      for (const event of events) {
        if (event.event !== 'message' || !event.data) {
          continue
        }
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch (_) {
          continue
        }
        if (this._deliver(payload, msg)) {
          delivered = true
          break
        }
      }
      if (delivered) {
        break
      }
    }
    if (!delivered) {
      for (const event of decoder.flush()) {
        if (event.event !== 'message' || !event.data) {
          continue
        }
        try {
          if (this._deliver(JSON.parse(event.data), msg)) {
            delivered = true
            break
          }
        } catch (_) {
          // ignore a broken final frame; the missing response is reported below
        }
      }
    }
    if (!delivered && msg.id !== undefined && msg.id !== null) {
      throw new McpRpcError(
        ERR.PROTOCOL,
        'event-stream ended before the response arrived'
      )
    }
  }

  /**
   * Hand a payload to the session if it belongs to `msg` (or if `msg` carries no
   * id, i.e. it was a notification and any server message is unsolicited).
   * @param {*} payload
   * @param {object} msg
   * @returns {boolean} whether the payload was accepted
   * @private
   */
  _deliver (payload, msg) {
    if (!payload || typeof payload !== 'object') {
      return false
    }
    const hasId = msg.id !== undefined && msg.id !== null
    if (hasId && isResponse(payload) && payload.id !== msg.id) {
      return false
    }
    if (this.onMessage) {
      this.onMessage(payload)
    }
    return true
  }

  /**
   * @param {Response} res
   * @returns {Promise<string>}
   * @private
   */
  async _readText (res) {
    try {
      return await res.text()
    } catch (_) {
      return ''
    }
  }

  /**
   * @param {*} err
   * @returns {McpRpcError}
   * @private
   */
  _transportError (err) {
    if (err instanceof McpRpcError) {
      return err
    }
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return new McpRpcError(
        ERR.TIMEOUT,
        `MCP server did not answer within ${this.timeoutMs} ms`
      )
    }
    const code = err && (err.code || (err.cause && err.cause.code))
    if (code) {
      return new McpRpcError(
        ERR.TRANSPORT_CLOSED,
        `cannot reach MCP server at ${this.url}: ${code}`
      )
    }
    const normalized = normalizeError(err)
    return new McpRpcError(
      ERR.TRANSPORT_CLOSED,
      `cannot reach MCP server at ${this.url}: ${normalized.message}`
    )
  }
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncate (text, max = 200) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max) + '…' : s
}

module.exports = { HttpTransport, SESSION_HEADER, truncate }
