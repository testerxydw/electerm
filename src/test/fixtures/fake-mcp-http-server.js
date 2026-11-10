/**
 * 假 MCP server（Streamable HTTP）——可复用测试夹具。
 *
 * 两种应答形态各用一套实现，这是故意的，**改动前请读这段**：
 *
 * - `json` 模式复用本仓 `src/app/mcp/server/streamableHttp.js`：electerm→electerm
 *   自连是最快也最贴近真实的一条路径，但它只能证明「**我们两边自洽**」，不能
 *   证明「符合 spec」—— 同一份误解会被两边互相印证成"通过"。
 * - `sse` 模式是本文件**独立**实现的 SSE 分帧 + JSON-RPC 分发，这才是 M3 里唯一
 *   能证明「客户端按 spec 解析事件流」的证据。**不要把 sse 也改成复用产品代码**，
 *   那会让 M3 静默退化成自洽测试，而且不会有人发现。
 *
 * 模式（`mode`）：
 *   json          普通 JSON 应答（默认）
 *   sse           每个请求回一帧 `event: message`，然后关流
 *   hang          收到请求后永不回包（客户端超时用例）
 *   unauthorized  一律 401（凭据错误用例）
 *   expireOnce    第一次 `tools/call` 回 404（模拟会话被服务端遗忘），之后正常。
 *                 用于验证「404 → 重握手一次 → 重试成功」（设计 §2.3）。
 *                 initialize 应答会带 `mcp-session-id`，否则客户端不会进入 404 分支。
 *
 * `apiKey` 非空时会校验 `Authorization: Bearer <apiKey>`，不匹配回 401。
 *
 * 用法：
 *   const srv = await startFakeHttpServer({ mode: 'json' })
 *   ... 用 srv.url 配置客户端 ...
 *   await srv.close()
 */

const http = require('node:http')
const { McpServer } = require('../../app/mcp/server/mcp')
const { StreamableHTTPServerTransport } = require('../../app/mcp/server/streamableHttp')

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05']

/**
 * @param {object} [opts]
 * @returns {McpServer}
 */
function buildServer (opts = {}) {
  const server = new McpServer({
    name: opts.name || 'fake-mcp-http',
    version: '1.0.0'
  })
  server.registerTool('echo', {
    description: 'echo back the arguments it received',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  }, (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }]
  }))
  return server
}

/**
 * 独立实现的 JSON-RPC 分发（只用于 sse 模式）。
 * @param {McpServer} server
 * @param {object} msg
 * @returns {object|null}
 */
function dispatchIndependently (server, msg) {
  const { id, method } = msg
  const params = msg.params || {}
  if (method === 'initialize') {
    const requested = params.protocolVersion
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version }
      }
    }
  }
  if (method === 'notifications/initialized') {
    return null
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: Array.from(server.tools.entries()).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      }
    }
  }
  if (method === 'tools/call') {
    const tool = server.tools.get(params.name)
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Tool not found: ${params.name}` }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      result: tool.handler(params.arguments || {})
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  }
}

/**
 * express 风格的最小响应垫片：本仓 transport 用 `res.status()/res.json()`。
 * @param {import('node:http').ServerResponse} res
 * @returns {object}
 */
function shimResponse (res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (data) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json')
    }
    res.end(JSON.stringify(data))
  }
  return res
}

/**
 * @param {object} [opts]
 * @param {'json'|'sse'|'hang'|'unauthorized'} [opts.mode]
 * @param {string} [opts.apiKey] 非空时校验 Authorization 头
 * @returns {Promise<{url: string, port: number, mode: string,
 *   requestCount: () => number, close: () => Promise<void>}>}
 */
async function startFakeHttpServer (opts = {}) {
  const mode = opts.mode || 'json'
  const apiKey = opts.apiKey || ''
  const mcpServer = buildServer(opts)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => 'fake-session-1'
  })
  await transport.connect(mcpServer)
  let requests = 0
  const methods = []
  let expiredOnce = false

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      requests++
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch (_) {
          // 400 时把原文带上（截断），否则「客户端发错帧」只能猜
          res.statusCode = 400
          res.end('bad request body: ' + String(raw).slice(0, 200))
          return
        }
        if (body && (typeof body !== 'object' || body.jsonrpc !== '2.0' ||
          (body.method !== undefined && typeof body.method !== 'string'))) {
          // 同 stdio 夹具：不合形状的入站消息不能静默吞，否则错帧会表现成不回包
          res.statusCode = 400
          res.end('bad inbound shape: ' + String(raw).slice(0, 200))
          return
        }
      }
      if (mode === 'unauthorized') {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (apiKey) {
        const auth = req.headers.authorization || ''
        if (auth !== `Bearer ${apiKey}`) {
          res.statusCode = 401
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
      }
      if (mode === 'hang') {
        // 故意不结束响应：客户端必须靠自己的超时收敛
        return
      }
      if (body && typeof body.method === 'string') {
        methods.push(body.method)
      }
      if (mode === 'expireOnce') {
        if (body && body.method === 'initialize') {
          // 客户端只有拿到过 session id 才会把 404 当成「会话过期」
          res.setHeader('mcp-session-id', 'fake-session-1')
        }
        if (body && body.method === 'tools/call' && !expiredOnce) {
          expiredOnce = true
          res.statusCode = 404
          res.end('{}')
          return
        }
      }
      if (mode === 'sse') {
        if (!body) {
          res.statusCode = 200
          res.end()
          return
        }
        if (body.id === undefined || body.id === null) {
          res.statusCode = 202
          res.end()
          return
        }
        const payload = dispatchIndependently(mcpServer, body)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        res.end()
        return
      }
      shimResponse(res)
      Promise.resolve(transport.handleRequest(req, res, body)).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500
        }
        res.end(String((err && err.message) || err))
      })
    })
  })

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    mode,
    requestCount: () => requests,
    /**
     * 某个 JSON-RPC 方法被请求了多少次（断言「重握手只发生一次」）。
     * @param {string} method
     * @returns {number}
     */
    methodCount: (method) => methods.filter(item => item === method).length,
    close: () => new Promise((resolve) => {
      server.closeAllConnections && server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

module.exports = {
  startFakeHttpServer,
  dispatchIndependently,
  buildServer
}
