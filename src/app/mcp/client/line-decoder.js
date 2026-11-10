/**
 * MCP client — newline framing for stdio transports.
 *
 * A child process writes whatever it likes on stdout, including a JSON object
 * split across arbitrary chunk boundaries. Two things must not be lost here:
 *
 * 1. UTF-8 characters can be split across chunks too, so the byte→string
 *    conversion goes through `StringDecoder`, never `chunk.toString()`.
 * 2. A server that never emits a newline must not be able to grow our buffer
 *    without bound; crossing `maxLineBytes` is a protocol error and the caller
 *    closes the connection.
 */

const { StringDecoder } = require('node:string_decoder')

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

class McpLineTooLongError extends Error {
  constructor (maxLineBytes, bufferedBytes) {
    super(`incoming line exceeds ${maxLineBytes} bytes (buffered ${bufferedBytes} bytes without a newline)`)
    this.name = 'McpLineTooLongError'
    this.code = 'mcp_protocol_error'
    this.maxLineBytes = maxLineBytes
    this.bufferedBytes = bufferedBytes
  }
}

class LineDecoder {
  /**
   * @param {{maxLineBytes?: number, keepEmptyLines?: boolean}} [opts]
   */
  constructor ({ maxLineBytes = DEFAULT_MAX_LINE_BYTES, keepEmptyLines = false } = {}) {
    this.maxLineBytes = maxLineBytes
    // SSE needs the blank line: it is the event terminator, not noise. JSON-RPC
    // over stdio does not (an empty line carries no message), so it stays off
    // by default rather than forcing every caller to filter.
    this.keepEmptyLines = keepEmptyLines
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.pendingBytes = 0
  }

  /**
   * Feed one chunk, get back every complete line it finished.
   * Empty lines are dropped (they carry no JSON-RPC message), `\r\n` is
   * accepted, and a trailing `\r` is stripped.
   * @param {Buffer|string|Uint8Array} chunk
   * @returns {string[]}
   * @throws {McpLineTooLongError} when a single line exceeds the limit
   */
  push (chunk) {
    if (chunk === undefined || chunk === null) {
      return []
    }
    let text
    if (typeof chunk === 'string') {
      text = chunk
      this.pendingBytes += Buffer.byteLength(chunk, 'utf8')
    } else {
      // Uint8Array (fetch bodies) and Buffer both work here
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      text = this.decoder.write(buf)
      this.pendingBytes += buf.length
    }
    this.buffer += text
    const lines = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (line || this.keepEmptyLines) {
        lines.push(line)
      }
      index = this.buffer.indexOf('\n')
      this.pendingBytes = Buffer.byteLength(this.buffer, 'utf8')
    }
    if (this.pendingBytes > this.maxLineBytes) {
      throw new McpLineTooLongError(this.maxLineBytes, this.pendingBytes)
    }
    return lines
  }

  /**
   * Whatever is still buffered at EOF. A trailing partial line is returned so
   * the caller can decide (protocol error) instead of losing it; the decoder
   * state is reset either way.
   * @returns {string[]}
   */
  flush () {
    const rest = (this.buffer + this.decoder.end()).replace(/\r$/, '')
    this.buffer = ''
    this.pendingBytes = 0
    return rest ? [rest] : []
  }
}

/**
 * Convenience wrapper used by the stdio transport.
 * @param {string|Buffer} line
 * @returns {object}
 */
function parseLine (line) {
  return JSON.parse(line)
}

module.exports = {
  LineDecoder,
  McpLineTooLongError,
  DEFAULT_MAX_LINE_BYTES,
  parseLine
}
