/**
 * MCP client — incremental Server-Sent Events parser.
 *
 * Streamable HTTP servers answer a POST either with plain JSON or with an SSE
 * stream, and the stream arrives in arbitrary chunks: an event can be split
 * mid-`data:` line, and a multi-line `data:` payload only becomes valid JSON
 * once the blank line terminates the event. This decoder keeps the partial
 * state between `push()` calls and is line-framed by `LineDecoder`, so UTF-8
 * split across chunks is handled in exactly one place.
 */

const { LineDecoder } = require('./line-decoder')

class SseDecoder {
  /**
   * @param {{maxLineBytes?: number}} [opts]
   */
  constructor (opts = {}) {
    // keepEmptyLines: the blank line *is* the event terminator in SSE, so the
    // framing layer must hand it through (see line-decoder.js).
    this.lines = new LineDecoder({ ...opts, keepEmptyLines: true })
    this.data = []
    this.event = ''
    this.id = ''
  }

  /**
   * Feed a chunk, get back the events it completed.
   * @param {Buffer|string|Uint8Array} chunk
   * @returns {Array<{event: string, data: string, id: string}>}
   */
  push (chunk) {
    return this._consume(this.lines.push(chunk))
  }

  /**
   * Dispatch whatever is pending at EOF. A server that closes the stream right
   * after `data:` (no trailing blank line) is common enough to accept.
   * @returns {Array<{event: string, data: string, id: string}>}
   */
  flush () {
    const events = this._consume(this.lines.flush())
    const last = this._dispatch()
    if (last) {
      events.push(last)
    }
    return events
  }

  /**
   * @param {string[]} lines
   * @returns {Array<{event: string, data: string, id: string}>}
   * @private
   */
  _consume (lines) {
    const events = []
    for (const line of lines) {
      if (line === '') {
        const event = this._dispatch()
        if (event) {
          events.push(event)
        }
        continue
      }
      if (line.startsWith(':')) {
        // comment / heartbeat
        continue
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
      if (field === 'data') {
        this.data.push(value)
      } else if (field === 'event') {
        this.event = value
      } else if (field === 'id') {
        this.id = value
      }
      // `retry:` and unknown fields are intentionally ignored
    }
    return events
  }

  /**
   * Turn the accumulated fields into one event, if there is anything pending.
   * `id` persists across events per the SSE spec; `data` and `event` reset.
   * @returns {{event: string, data: string, id: string}|null}
   * @private
   */
  _dispatch () {
    if (!this.data.length && !this.event) {
      return null
    }
    const event = {
      event: this.event || 'message',
      data: this.data.join('\n'),
      id: this.id
    }
    this.data = []
    this.event = ''
    return event
  }
}

module.exports = { SseDecoder }
