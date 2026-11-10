/**
 * MCP client · JSON-RPC 配对 / 超时 / 取消（M8 的底层）。
 *
 * 最重要的一条是「挂起的请求一定会结束」：超时、abort、transport 关闭、
 * dispose 都走同一条收敛路径。agent 循环不会因为一个不吭声的 server 挂住。
 * `cancel(id)` 是 agent 侧「用户点了停止」的路径，必须立刻 reject 同一个 id。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  JsonRpcPeer,
  McpRpcError,
  normalizeError,
  ERR
} = require('../../app/mcp/client/rpc')

/**
 * 造一个 peer：`send` 只记录报文，由测试决定何时、以什么回包。
 * @param {object} [opts]
 * @returns {{peer: JsonRpcPeer, sent: Array}}
 */
function makePeer (opts = {}) {
  const sent = []
  const peer = new JsonRpcPeer({
    send: (msg) => {
      sent.push(msg)
    },
    defaultTimeoutMs: opts.defaultTimeoutMs || 1000,
    onNotification: opts.onNotification,
    onProtocolError: opts.onProtocolError
  })
  return { peer, sent }
}

describe('mcp-client rpc', () => {
  it('请求按 id 配对，乱序回包也能对上', async () => {
    const { peer, sent } = makePeer()
    const first = peer.request('a', {})
    const second = peer.request('b', {})
    assert.equal(sent.length, 2)
    const [msgA, msgB] = sent
    peer.handleMessage({ jsonrpc: '2.0', id: msgB.id, result: 'B' })
    peer.handleMessage({ jsonrpc: '2.0', id: msgA.id, result: 'A' })
    assert.equal(await first, 'A')
    assert.equal(await second, 'B')
    assert.equal(peer.pendingCount, 0)
  })

  it('不吭声的 server：超时后 reject，code=mcp_timeout', async () => {
    const { peer } = makePeer()
    const started = Date.now()
    await assert.rejects(
      peer.request('tools/call', {}, { timeoutMs: 50 }),
      (err) => {
        assert.ok(err instanceof McpRpcError)
        assert.equal(err.code, ERR.TIMEOUT)
        assert.equal(err.details.timeoutMs, 50)
        return true
      }
    )
    assert.ok(Date.now() - started < 1000)
    assert.equal(peer.pendingCount, 0)
  })

  it('cancel(id) 立刻让同一个 id 的 pending reject（用户点停止）', async () => {
    const { peer } = makePeer()
    let rpcId = null
    const pending = peer.request('tools/call', {}, {
      timeoutMs: 30000,
      onStart: (id) => {
        rpcId = id
      }
    })
    assert.equal(peer.pendingCount, 1)
    const started = Date.now()
    const found = peer.cancel(rpcId, 'user stopped')
    assert.equal(found, true)
    await assert.rejects(pending, (err) => {
      assert.equal(err.code, ERR.ABORTED)
      assert.match(err.message, /cancelled/)
      return true
    })
    assert.ok(Date.now() - started < 200, '取消必须是同步生效的，不能等超时')
    assert.equal(peer.pendingCount, 0)
    assert.equal(peer.cancel(rpcId), false, '重复取消同一个 id 应返回 false，不抛错')
  })

  it('AbortSignal 触发时也按 mcp_aborted 收敛', async () => {
    const { peer } = makePeer()
    const controller = new AbortController()
    const pending = peer.request('tools/call', {}, {
      timeoutMs: 30000,
      signal: controller.signal
    })
    controller.abort()
    await assert.rejects(pending, err => err.code === ERR.ABORTED)
    assert.equal(peer.pendingCount, 0)
  })

  it('dispose 把所有 pending 变成 mcp_transport_closed，新请求直接拒', async () => {
    const { peer } = makePeer()
    const pending = peer.request('x', {}, { timeoutMs: 30000 })
    peer.dispose('child exited')
    await assert.rejects(pending, (err) => {
      assert.equal(err.code, ERR.TRANSPORT_CLOSED)
      assert.match(err.message, /child exited/)
      return true
    })
    await assert.rejects(peer.request('y', {}), err => err.code === ERR.TRANSPORT_CLOSED)
  })

  it('JSON-RPC error 响应 → mcp_rpc_error，保留 rpcCode', async () => {
    const { peer, sent } = makePeer()
    const pending = peer.request('tools/call', {}, { timeoutMs: 1000 })
    peer.handleMessage({
      jsonrpc: '2.0',
      id: sent[0].id,
      error: { code: -32602, message: 'Tool not found: nope' }
    })
    await assert.rejects(pending, (err) => {
      assert.equal(err.code, ERR.RPC)
      assert.equal(err.details.rpcCode, -32602)
      assert.match(err.message, /Tool not found/)
      return true
    })
  })

  it('server→client 请求回 -32601（P0 不支持任何 server 请求）', () => {
    const { peer, sent } = makePeer()
    const handled = peer.handleMessage({
      jsonrpc: '2.0',
      id: 'srv-req-1',
      method: 'sampling/createMessage',
      params: {}
    })
    assert.equal(handled, true)
    const reply = sent[sent.length - 1]
    assert.equal(reply.id, 'srv-req-1')
    assert.equal(reply.error.code, -32601)
  })

  it('通知进 onNotification，不占 pending', () => {
    const received = []
    const { peer } = makePeer({ onNotification: msg => received.push(msg) })
    peer.handleMessage({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
    assert.equal(received.length, 1)
    assert.equal(peer.pendingCount, 0)
  })

  it('迟到/多余的响应被丢弃，不抛错（超时后 server 才回包）', () => {
    const { peer } = makePeer()
    assert.equal(peer.handleMessage({ jsonrpc: '2.0', id: 999, result: {} }), true)
    assert.equal(peer.pendingCount, 0)
  })

  it('transport send 抛错 → 请求立刻失败，不等超时', async () => {
    const peer = new JsonRpcPeer({
      send: () => {
        throw new Error('EPIPE')
      },
      defaultTimeoutMs: 30000
    })
    await assert.rejects(peer.request('x', {}), err => err.code === ERR.TRANSPORT_CLOSED)
    assert.equal(peer.pendingCount, 0)
  })

  it('normalizeError 把网络错误压成可读文本（不带堆栈）', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:1')
    err.code = 'ECONNREFUSED'
    const normalized = normalizeError(err)
    assert.equal(normalized.code, ERR.TRANSPORT_CLOSED)
    assert.match(normalized.message, /ECONNREFUSED/)
    assert.ok(!/\n\s+at /.test(normalized.message))
  })
})
