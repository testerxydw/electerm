/**
 * MCP client · stdio 换行分帧。
 *
 * 分帧层的两个失败模式都会伪装成「server 不理我」：
 *   1. 一个 JSON 被切成两个 chunk，按 chunk 解析 → JSON.parse 抛错；
 *   2. 多字节字符被切开，用 chunk.toString() → 出现 U+FFFD 替换字符。
 * 所以这里既测跨 chunk 的 JSON，也测跨 chunk 的中文/emoji。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  LineDecoder,
  McpLineTooLongError,
  parseLine
} = require('../../app/mcp/client/line-decoder')

describe('mcp-client line-decoder', () => {
  it('一个 JSON 跨两个 chunk：第二个 chunk 补齐换行后才出整行', () => {
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.push('{"jsonrpc":"2.0",'), [])
    const lines = decoder.push('"id":1}\n')
    assert.equal(lines.length, 1)
    assert.deepEqual(parseLine(lines[0]), { jsonrpc: '2.0', id: 1 })
  })

  it('一个 chunk 里多行 → 一次返回多行；残留半行留在缓冲区', () => {
    const decoder = new LineDecoder()
    const lines = decoder.push('a\nb\nc')
    assert.deepEqual(lines, ['a', 'b'])
    assert.deepEqual(decoder.flush(), ['c'])
  })

  it('支持 CRLF，并剥掉行尾 \\r', () => {
    const decoder = new LineDecoder()
    const lines = decoder.push('{"a":1}\r\n{"b":2}\r\n')
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  })

  it('默认丢弃空行（空行不带 JSON-RPC 报文）', () => {
    const decoder = new LineDecoder()
    const lines = decoder.push('\n\n{"a":1}\n\n')
    assert.deepEqual(lines, ['{"a":1}'])
  })

  it('keepEmptyLines=true 时空行必须透传（SSE 用它做事件分隔）', () => {
    const decoder = new LineDecoder({ keepEmptyLines: true })
    const lines = decoder.push('data: x\n\n')
    assert.deepEqual(lines, ['data: x', ''])
  })

  it('多字节字符跨 chunk 不产生替换字符', () => {
    const decoder = new LineDecoder()
    const payload = JSON.stringify({ text: '中文🙂' }) + '\n'
    const buf = Buffer.from(payload, 'utf8')
    // 在「中」的字节中间切一刀
    const cut = buf.indexOf(Buffer.from('中', 'utf8')) + 1
    assert.deepEqual(decoder.push(buf.subarray(0, cut)), [])
    const lines = decoder.push(buf.subarray(cut))
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]).text, '中文🙂')
    assert.ok(!lines[0].includes('\uFFFD'), '不能出现 U+FFFD')
  })

  it('超长行抛 McpLineTooLongError（code=mcp_protocol_error），不让缓冲无限长', () => {
    const decoder = new LineDecoder({ maxLineBytes: 32 })
    assert.throws(
      () => decoder.push(Buffer.alloc(64, 0x61)),
      (err) => {
        assert.ok(err instanceof McpLineTooLongError)
        assert.equal(err.code, 'mcp_protocol_error')
        assert.equal(err.maxLineBytes, 32)
        return true
      }
    )
  })

  it('flush 返回残留内容，并清空状态', () => {
    const decoder = new LineDecoder()
    decoder.push('tail-without-newline')
    assert.deepEqual(decoder.flush(), ['tail-without-newline'])
    assert.deepEqual(decoder.flush(), [])
  })
})
