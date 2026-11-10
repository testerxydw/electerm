/**
 * MCP client — protocol constants and message-shape predicates.
 *
 * The client advertises the same version list as this repo's own MCP server
 * (`src/app/mcp/server/mcp.js:12-16`), so electerm→electerm self-connection
 * always agrees on a version. Anything the server answers that is outside the
 * list is refused with an explicit error naming both sides, because a silent
 * downgrade would surface later as an unexplainable "unknown method".
 */

// Newest first, same array as the server side.
const CLIENT_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05']

const CLIENT_NAME = 'electerm'
const DEFAULT_CLIENT_VERSION = '0.0.0'

/**
 * Parameters for the `initialize` request.
 * @param {{version?: string, capabilities?: object}} [opts]
 * @returns {{protocolVersion: string, capabilities: object,
 *   clientInfo: {name: string, version: string}}}
 */
function buildInitializeParams ({ version = DEFAULT_CLIENT_VERSION, capabilities = {} } = {}) {
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSIONS[0],
    capabilities: capabilities || {},
    clientInfo: {
      name: CLIENT_NAME,
      version: String(version || DEFAULT_CLIENT_VERSION)
    }
  }
}

/**
 * Check the server's chosen protocol version against what we advertise.
 * @param {object} result `initialize` result (may be undefined on a broken server)
 * @returns {{ok: boolean, protocolVersion: string, error?: {code: string, message: string}}}
 */
function negotiateVersion (result) {
  const version = result && result.protocolVersion
  if (typeof version !== 'string' || !version) {
    return {
      ok: false,
      protocolVersion: '',
      error: {
        code: 'mcp_protocol_error',
        message: 'initialize result has no protocolVersion'
      }
    }
  }
  if (!CLIENT_PROTOCOL_VERSIONS.includes(version)) {
    return {
      ok: false,
      protocolVersion: version,
      error: {
        code: 'mcp_protocol_version_unsupported',
        message: `unsupported protocol version ${version}; client supports ${CLIENT_PROTOCOL_VERSIONS.join(', ')}`
      }
    }
  }
  return { ok: true, protocolVersion: version }
}

/**
 * A JSON-RPC response carries an id and exactly one of result/error.
 * @param {*} msg
 * @returns {boolean}
 */
function isResponse (msg) {
  if (!msg || typeof msg !== 'object') {
    return false
  }
  if (msg.id === undefined || msg.id === null) {
    return false
  }
  return 'result' in msg || 'error' in msg
}

/**
 * A notification carries a method and no id (server→client pushes, acks).
 * @param {*} msg
 * @returns {boolean}
 */
function isNotification (msg) {
  return !!msg && typeof msg === 'object' &&
    typeof msg.method === 'string' &&
    (msg.id === undefined || msg.id === null)
}

/**
 * A server→client request (sampling/roots/elicitation). P0 does not implement
 * any of these, so the session answers -32601 instead of leaving the server
 * waiting forever.
 * @param {*} msg
 * @returns {boolean}
 */
function isServerRequest (msg) {
  return !!msg && typeof msg === 'object' &&
    typeof msg.method === 'string' &&
    msg.id !== undefined && msg.id !== null
}

/**
 * Build a JSON-RPC error response (used to refuse server→client requests).
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {*} [data]
 * @returns {{jsonrpc: string, id: *, error: {code: number, message: string, data?: *}}}
 */
function buildErrorResponse (id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) {
    error.data = data
  }
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
}

/**
 * Extract the text out of an MCP `content` array (text parts only).
 * Non-text parts are reported by type instead of being dropped silently, so the
 * model can tell "there was an image" from "there was nothing".
 * @param {Array} content
 * @returns {string}
 */
function contentToText (content) {
  if (!Array.isArray(content)) {
    return ''
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      return ''
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text
    }
    return `[${part.type || 'unknown'} content]`
  }).filter(Boolean).join('\n')
}

module.exports = {
  CLIENT_PROTOCOL_VERSIONS,
  CLIENT_NAME,
  DEFAULT_CLIENT_VERSION,
  buildInitializeParams,
  negotiateVersion,
  isResponse,
  isNotification,
  isServerRequest,
  buildErrorResponse,
  contentToText
}
