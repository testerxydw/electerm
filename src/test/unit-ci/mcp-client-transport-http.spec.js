/**
 * MCP client · Streamable HTTP 传输（契约测试，M3）。
 *
 * 假 server 三种形态都跑一遍：
 *   json  —— 复用本仓 `streamableHttp.js`（electerm→electerm 自连）
 *   sse   —— 夹具自己实现的最小事分流（避免与客户端共享同一份误解）
 *   401 / 断网 —— 断言错误**可读**：有 code、有人话、无堆栈、不含凭据
 */

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { startFakeHttpServer } = require('../fixtures/fake-mcp-http-server')
const { HttpTransport } = require('../../app/mcp/client/http-transport')
const { McpSession } = require('../../app/mcp/client/session')
const { ERR } = require('../../app/mcp/client/rpc')

const SUPPORTED = ['2025-11-25', '2025-06-18', '2024-11-05']

const servers = []
const sessions = []

/**
 * @param {object} [opts]
 * @returns {Promise<{server: object, transport: HttpTransport, session: McpSession}>}
 */
async function connectTo (opts = {}) {
  const server = await startFakeHttpServer(opts)
  servers.push(server)
  const transport = new HttpTransport({
    url: server.url,
    headers: opts.headers || {},
    timeoutMs: opts.timeoutMs || 5000,
    label: opts.label || opts.mode || 'json'
  })
  const session = new McpSession({
    serverConfig: {
      id: opts.id || 'http1',
      name: opts.label || 'fake-http',
      transport: 'http',
      timeoutMs: opts.timeoutMs || 5000
    },
    transport
  })
  transport.onMessage = msg => session.handleMessage(msg)
  transport.onClose = info => session.handleTransportClosed(info)
  sessions.push(session)
  await session.connect()
  return { server, transport, session }
}

after(async () => {
  for (const session of sessions) {
    try {
      await session.close('test-teardown')
    } catch (_) {
      // teardown only
    }
  }
  for (const server of servers) {
    try {
      await server.close()
    } catch (_) {
      // teardown only
    }
  }
})

describe('mcp-client http transport', () => {
  it('M3：application/json 应答路径 → initialize + tools/list 成功', async () => {
    const { session } = await connectTo({ mode: 'json' })
    assert.equal(session.state, 'ready')
    assert.ok(SUPPORTED.includes(session.protocolVersion))
    assert.equal(session.tools.length, 1)
    assert.equal(session.tools[0].name, 'echo')

    const result = await session.callTool('echo', { text: 'hi' }, { timeoutMs: 3000 })
    assert.deepEqual(JSON.parse(result.text), { text: 'hi' })
  })

  it('M3：text/event-stream 应答路径 → 握手与调用都成功', async () => {
    const { session, server } = await connectTo({ mode: 'sse' })
    assert.equal(session.state, 'ready')
    assert.equal(session.tools.length, 1)
    const result = await session.callTool('echo', { text: 'sse' }, { timeoutMs: 3000 })
    assert.deepEqual(JSON.parse(result.text), { text: 'sse' })
    assert.ok(server.requestCount() >= 3, 'initialize / initialized / tools/list / call 都应到达 server')
  })

  it('M3：401 → code=mcp_http_unauthorized，人话错误，不含凭据、不带堆栈', async () => {
    const secret = 'super-secret-token'
    const server = await startFakeHttpServer({ mode: 'unauthorized' })
    servers.push(server)
    const transport = new HttpTransport({
      url: server.url,
      headers: { Authorization: `Bearer ${secret}` },
      timeoutMs: 3000
    })
    const session = new McpSession({
      serverConfig: { id: 'http401', name: 'unauthorized', transport: 'http', timeoutMs: 3000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)

    await assert.rejects(session.connect(), (err) => {
      assert.equal(err.code, ERR.HTTP_UNAUTHORIZED)
      assert.match(err.message, /HTTP 401/)
      assert.match(err.message, /check the headers/)
      // 多 server 时，不给 URL 用户不知道该改哪一台
      assert.ok(err.message.includes(server.url), `错误信息必须含目标 URL: ${err.message}`)
      assert.ok(!err.message.includes(secret), '错误信息不能泄漏凭据')
      assert.ok(!/\n\s+at /.test(err.message), '不能带堆栈')
      return true
    })
    assert.equal(session.state, 'failed')
  })

  it('404（服务端忘了会话）→ 重握手一次后调用成功，且只重握手一次', async () => {
    const { server, session } = await connectTo({ mode: 'expireOnce', id: 'httpexpire' })
    assert.equal(server.methodCount('initialize'), 1, '握手一次进入 ready')

    const result = await session.callTool('echo', { text: 'after-expiry' }, { timeoutMs: 3000 })
    assert.deepEqual(JSON.parse(result.text), { text: 'after-expiry' })
    assert.equal(
      server.methodCount('initialize'),
      2,
      '404 之后必须重握手一次（不是零次，也不是无限次）'
    )
    assert.equal(session.state, 'ready')
  })

  it('M3：连接被拒 → mcp_transport_closed + ECONNREFUSED，可读且无堆栈', async () => {
    const deadServer = await startFakeHttpServer({ mode: 'json' })
    const deadUrl = deadServer.url
    await deadServer.close()

    const transport = new HttpTransport({ url: deadUrl, timeoutMs: 3000 })
    const session = new McpSession({
      serverConfig: { id: 'httpdead', name: 'dead', transport: 'http', timeoutMs: 3000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)

    await assert.rejects(session.connect(), (err) => {
      assert.equal(err.code, ERR.TRANSPORT_CLOSED)
      assert.match(err.message, /cannot reach MCP server at/)
      assert.match(err.message, /ECONNREFUSED/)
      assert.ok(!/\n\s+at /.test(err.message), '不能带堆栈')
      return true
    })
  })

  it('404 重试有界：每次都 404 → 只重握手一次（initialize 恰好 2 次）后判失败', async () => {
    let initializeCount = 0
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch (_) {
          res.statusCode = 400
          res.end()
          return
        }
        if (body.method === 'initialize') {
          initializeCount++
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('mcp-session-id', 'sess-1')
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: body.params.protocolVersion,
              capabilities: {},
              serverInfo: {}
            }
          }))
          return
        }
        if (body.id === undefined || body.id === null) {
          res.statusCode = 202
          res.end()
          return
        }
        res.statusCode = 404
        res.end('{"error":"session not found"}')
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/mcp`
    const transport = new HttpTransport({ url, timeoutMs: 2000 })
    const session = new McpSession({
      serverConfig: { id: 'expire2', name: 'expire', transport: 'http', timeoutMs: 2000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)
    try {
      await assert.rejects(session.connect(), (err) => {
        assert.equal(err.code, ERR.SESSION_EXPIRED)
        assert.ok(err.message.includes(url), `应含目标 URL：${err.message}`)
        return true
      })
      assert.equal(initializeCount, 2, '重握手必须只发生一次，不能无限重试')
      assert.equal(session.state, 'failed')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('server 接受连接但永不回包 → 超时收敛为 mcp_timeout', async () => {
    const server = await startFakeHttpServer({ mode: 'hang' })
    servers.push(server)
    // 会话层的 initialize 超时固定 10s，所以这里用小 timeoutMs 验证 transport
    // 自己的 AbortController 路径即可
    const transport = new HttpTransport({
      url: server.url,
      timeoutMs: 300
    })
    const session = new McpSession({
      serverConfig: { id: 'httphang', name: 'hang', transport: 'http', timeoutMs: 300 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)

    const started = Date.now()
    await assert.rejects(session.connect(), (err) => {
      assert.equal(err.code, ERR.TIMEOUT)
      assert.match(err.message, /did not answer within 300 ms/)
      return true
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1300, `耗时 ${elapsed}ms 超过 timeoutMs + 1s`)
  })
})
