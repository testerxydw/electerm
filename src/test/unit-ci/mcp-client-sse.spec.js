/**
 * MCP client · SSE 增量解析。
 *
 * Streamable HTTP 的响应可能是 `text/event-stream`，而事件是**逐步到达**的：
 * 一个事件可能被切成几个 chunk，也可能一个 chunk 里塞三个事件。这里钉住
 * 「边到边出」——只在整条流结束后才吐事件，等于长连接上永远收不到回应。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { SseDecoder } = require('../../app/mcp/client/sse')

describe('mcp-client sse', () => {
  it('一个完整事件到达即返回（不需要等流结束）', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'message')
    assert.deepEqual(JSON.parse(events[0].data), { jsonrpc: '2.0', id: 1, result: {} })
  })

  it('事件被切成多段：空行出现前不产出，出现后产出一次', () => {
    const decoder = new SseDecoder()
    assert.deepEqual(decoder.push('event: message\n'), [])
    assert.deepEqual(decoder.push('data: {"a":'), [])
    assert.deepEqual(decoder.push('1}\n'), [])
    const events = decoder.push('\n')
    assert.equal(events.length, 1)
    assert.deepEqual(JSON.parse(events[0].data), { a: 1 })
  })

  it('多行 data 用 \\n 拼接（SSE 规范）', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: line1\ndata: line2\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0].data, 'line1\nline2')
  })

  it('注释行（: ping 心跳）被忽略，不产生事件', () => {
    const decoder = new SseDecoder()
    assert.deepEqual(decoder.push(': ping\n\n'), [])
    const events = decoder.push('data: x\n\n')
    assert.equal(events.length, 1)
    assert.equal(events[0].data, 'x')
  })

  it('没有 event 字段时事件名默认 message', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: y\n\n')
    assert.equal(events[0].event, 'message')
  })

  it('一个 chunk 里三个事件 → 一次返回三个', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: 1\n\ndata: 2\n\ndata: 3\n\n')
    assert.deepEqual(events.map(item => item.data), ['1', '2', '3'])
  })

  it('流在 data 后直接结束（没有收尾空行）→ flush 补发', () => {
    const decoder = new SseDecoder()
    assert.deepEqual(decoder.push('data: tail'), [])
    const events = decoder.flush()
    assert.equal(events.length, 1)
    assert.equal(events[0].data, 'tail')
  })

  it('id 字段按规范跨事件保持', () => {
    const decoder = new SseDecoder()
    decoder.push('id: 42\ndata: a\n\n')
    const events = decoder.push('data: b\n\n')
    assert.equal(events[0].id, '42')
  })
})
