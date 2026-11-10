/**
 * 验收（QA 独立）：T02 传输层 · M2 / M3 / M3′ / M8。
 *
 * 说明（口径，写进报告也要保持一致）：
 * - `json` 分支的假 server 复用了本仓 `streamableHttp.js`，因此这里只能表述为
 *   **自洽性验证**（electerm 客户端 ↔ electerm 服务端能互通），不能表述为
 *   "符合 MCP spec"。`sse` 分支用夹具自带的独立实现，才算对端独立。
 * - M2 额外加了一条工程师没做的断言：握手只发 3 条报文，且
 *   `notifications/initialized` 之后不得再有多余请求（用包装 `transport.send`
 *   记录真实出站报文，不依赖假 server 的日志）。
 * - M8 两条路径都用真子进程：`--hang`（永不回包，夹具自带）+ 慢响应
 *   （迟于 deadline，临时 server 写在 os.tmpdir() 并在 after 里删除）。
 *   两条都要证明「超时后会话仍可用」。
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { StdioTransport } = require('../../app/mcp/client/stdio-transport')
const { HttpTransport } = require('../../app/mcp/client/http-transport')
const {
  McpSession,
  MAX_LIST_PAGES,
  LIST_BUDGET_MS
} = require('../../app/mcp/client/session')
const { ERR } = require('../../app/mcp/client/rpc')
const { CLIENT_PROTOCOL_VERSIONS } = require('../../app/mcp/client/protocol')
const { startFakeHttpServer } = require('../fixtures/fake-mcp-http-server')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-mcp-server.js')
const SLOW_SERVER = path.join(os.tmpdir(), `mcp-accept-slow-server-${process.pid}.js`)

/**
 * 临时 stdio server：默认立刻回包，带开关时只拖慢/吞掉**第一次** tools/call。
 * 只用来验证「超时之后会话还能用」，因此保持最小实现（一行一条 JSON）。
 */
const SLOW_SERVER_SOURCE = [
  "const readline = require('node:readline')",
  'const flags = {}',
  'for (const arg of process.argv.slice(2)) {',
  '  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg)',
  '  if (m) flags[m[1]] = m[2] === undefined ? true : m[2]',
  '}',
  'let calls = 0',
  'function write (msg) { process.stdout.write(JSON.stringify(msg) + "\\n") }',
  'const rl = readline.createInterface({ input: process.stdin })',
  'rl.on("line", (line) => {',
  '  if (!line.trim()) return',
  '  let msg',
  '  try { msg = JSON.parse(line) } catch (_) { return }',
  '  const { id, method } = msg',
  '  const params = msg.params || {}',
  '  if (method === "initialize") {',
  '    write({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1.0.0" } } })',
  '    return',
  '  }',
  '  if (method === "notifications/initialized") return',
  '  if (method === "tools/list") {',
  '    write({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })',
  '    return',
  '  }',
  '  if (method === "tools/call") {',
  '    calls++',
  '    const first = calls === 1',
  '    if (first && flags["hang-first"]) return',
  '    const delay = first && flags["delay-once"] ? Number(flags["delay-once"]) : 0',
  '    const reply = () => write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok:" + JSON.stringify(params.arguments || {}) }] } })',
  '    if (delay > 0) setTimeout(reply, delay)',
  '    else reply()',
  '  }',
  '})'
].join('\n')

const created = []

/**
 * @param {string} scriptPath
 * @param {string[]} flags
 * @param {object} [serverConfig]
 * @returns {{transport: StdioTransport, session: McpSession, sent: object[]}}
 */
function spawnSession (scriptPath, flags, serverConfig = {}, sessionOpts = {}) {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [scriptPath, ...flags],
    label: 'accept-stdio'
  })
  const session = new McpSession({
    serverConfig: {
      id: 'accept1',
      name: 'accept-stdio',
      transport: 'stdio',
      timeoutMs: 5000,
      ...serverConfig
    },
    transport,
    ...sessionOpts
  })
  transport.onMessage = msg => session.handleMessage(msg)
  transport.onClose = info => session.handleTransportClosed(info)
  // 记录真实出站报文：M2 的「握手后不得多发请求」只能在这一层观察
  const sent = []
  const rawSend = transport.send.bind(transport)
  transport.send = (msg) => {
    sent.push(msg)
    return rawSend(msg)
  }
  created.push({ transport, session })
  return { transport, session, sent }
}

before(() => {
  fs.writeFileSync(SLOW_SERVER, SLOW_SERVER_SOURCE, 'utf8')
})

after(async () => {
  for (const { session } of created) {
    try {
      await session.close('accept-teardown')
    } catch (_) {
      // teardown only
    }
  }
  try {
    fs.unlinkSync(SLOW_SERVER)
  } catch (_) {
    // already gone
  }
})

describe('验收 · M2 stdio 握手（真子进程）', () => {
  it('state=ready + 版本在允许表 + tools.length>0 + 5s 内完成', async () => {
    const { transport, session } = spawnSession(FIXTURE, ['--stdio', '--tools=3'])
    const started = Date.now()
    await session.connect()
    const elapsed = Date.now() - started

    assert.equal(session.state, 'ready')
    assert.ok(
      CLIENT_PROTOCOL_VERSIONS.includes(session.protocolVersion),
      `协议版本 ${session.protocolVersion} 不在 ${CLIENT_PROTOCOL_VERSIONS.join('|')}`
    )
    assert.ok(session.tools.length > 0)
    // --tools=N 是精确总数（echo 恒在，huge 需独立 --huge）：`--tools=3`
    // → echo + tool_1 + tool_2 共 3 个。flag 的字面语义必须可信。
    assert.deepEqual(
      session.tools.map(tool => tool.name).sort(),
      ['echo', 'tool_1', 'tool_2']
    )
    assert.ok(elapsed < 5000, `握手耗时 ${elapsed}ms 超过 5s`)
    assert.ok(transport.pid > 0)
  })

  it('握手报文恰好 3 条，notifications/initialized 之后不得有多余请求', async () => {
    const { session, sent } = spawnSession(FIXTURE, ['--stdio'])
    await session.connect()

    assert.deepEqual(
      sent.map(msg => msg.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
      `握手报文序列不对：${JSON.stringify(sent)}`
    )
    const initialized = sent[1]
    assert.equal(initialized.id, undefined, 'notifications/initialized 必须是无 id 的通知')
    assert.ok(initialized.jsonrpc === '2.0')

    // 连接稳定后再等一轮事件循环：任何「补充 ping / 二次 initialize」都会暴露
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(sent.length, 3, `握手后多发了报文：${JSON.stringify(sent.slice(3))}`)
    await session.close()
  })
})

describe('验收 · M3 Streamable HTTP 双路径', () => {
  const servers = []
  const sessions = []

  after(async () => {
    for (const session of sessions) {
      try {
        await session.close('accept-teardown')
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

  /**
   * @param {object} [opts]
   * @returns {Promise<{server: object, session: McpSession, transport: HttpTransport}>}
   */
  async function connectTo (opts = {}) {
    const server = await startFakeHttpServer(opts)
    servers.push(server)
    const transport = new HttpTransport({
      url: server.url,
      headers: opts.headers || {},
      timeoutMs: opts.timeoutMs || 5000,
      label: opts.mode
    })
    const session = new McpSession({
      serverConfig: {
        id: 'http1',
        name: 'fake-http',
        transport: 'http',
        timeoutMs: opts.timeoutMs || 5000
      },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    transport.onClose = info => session.handleTransportClosed(info)
    sessions.push(session)
    await session.connect()
    return { server, session, transport }
  }

  it('json 分支（自洽性验证：复用本仓 streamableHttp.js）握手 + 调用', async () => {
    const { session, server } = await connectTo({ mode: 'json' })
    assert.equal(session.state, 'ready')
    assert.ok(CLIENT_PROTOCOL_VERSIONS.includes(session.protocolVersion))
    assert.deepEqual(session.tools.map(tool => tool.name), ['echo'])

    const result = await session.callTool('echo', { text: 'json' }, { timeoutMs: 3000 })
    assert.deepEqual(JSON.parse(result.text), { text: 'json' })
    assert.ok(server.requestCount() >= 4, `请求数 ${server.requestCount()}`)
  })

  it('sse 分支（夹具独立实现）握手 + 调用，请求数恰好 4', async () => {
    const { session, server } = await connectTo({ mode: 'sse' })
    assert.equal(session.state, 'ready')
    assert.deepEqual(session.tools.map(tool => tool.name), ['echo'])

    const result = await session.callTool('echo', { text: 'sse' }, { timeoutMs: 3000 })
    assert.deepEqual(JSON.parse(result.text), { text: 'sse' })
    assert.equal(
      server.requestCount(),
      4,
      'initialize + notifications/initialized + tools/list + tools/call'
    )
  })

  it('401 → mcp_http_unauthorized，无堆栈、不泄漏凭据', async () => {
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

    let captured = null
    await assert.rejects(session.connect(), (err) => {
      captured = err
      assert.equal(err.code, ERR.HTTP_UNAUTHORIZED)
      assert.match(err.message, /HTTP 401/)
      assert.ok(!err.message.includes(secret), '错误信息不能泄漏凭据')
      assert.ok(!/\n\s+at /.test(err.message), 'message 不能带堆栈')
      return true
    })
    const ipcObject = captured.toErrorObject()
    assert.deepEqual(Object.keys(ipcObject).sort(), ['code', 'message'])
    assert.equal('stack' in ipcObject, false, 'IPC 对象不得带 stack')
    assert.equal(session.state, 'failed')
  })

  it('回归（曾为缺陷 P0-1-B，2026-11-10 修复）：401 的错误信息必须含目标 URL（否则用户不知道连的是哪个 server）', async () => {
    const server = await startFakeHttpServer({ mode: 'unauthorized' })
    servers.push(server)
    const transport = new HttpTransport({ url: server.url, timeoutMs: 3000 })
    const session = new McpSession({
      serverConfig: { id: 'http401b', name: 'unauthorized', transport: 'http', timeoutMs: 3000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)

    await assert.rejects(session.connect(), (err) => {
      assert.ok(
        err.message.includes(server.url),
        `错误信息应包含目标 URL ${server.url}，实际："${err.message}"`
      )
      return true
    })
  })

  it('404 会话过期 → 自动重握手一次并重试同一请求（设计 §2.3），且 initialize 不得带旧 session id', async () => {
    let initializeCount = 0
    let listAttempts = 0
    // 每次initialize 请求带的 Mcp-Session-Id（修复后必须恒为 null）
    const initSessionIds = []
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
          initSessionIds.push(req.headers['mcp-session-id'] || null)
          if (req.headers['mcp-session-id']) {
            // 严格服务端语义：initialize 建立新会话，带着（已失效的）旧 id 来
            // 一律 400。宽容地回 200 会把「重握手携带旧 sid」这个 bug 洗成 PASS
            // ——而真实部署里这一 400 就是"会话过期后永远恢复不了"的直接原因。
            res.statusCode = 400
            res.end('{"error":"initialize must not carry a session id"}')
            return
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('mcp-session-id', `sess-${initializeCount}`)
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: body.params.protocolVersion,
              capabilities: {},
              serverInfo: { name: 'expire', version: '1.0.0' }
            }
          }))
          return
        }
        if (body.id === undefined || body.id === null) {
          res.statusCode = 202
          res.end()
          return
        }
        if (body.method === 'tools/list') {
          listAttempts++
          if (listAttempts === 1) {
            // 第一次声明"这个 session 我不认识"
            res.statusCode = 404
            res.end('{"error":"session not found"}')
            return
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
          }))
          return
        }
        res.statusCode = 404
        res.end('{"error":"session not found"}')
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/mcp`
    try {
      const transport = new HttpTransport({ url, timeoutMs: 2000 })
      const session = new McpSession({
        serverConfig: { id: 'expire1', name: 'expire', transport: 'http', timeoutMs: 2000 },
        transport
      })
      transport.onMessage = msg => session.handleMessage(msg)
      sessions.push(session)

      await session.connect()
      assert.equal(initializeCount, 2, '404 + sessionId → 必须重握手一次（仅一次）')
      assert.deepEqual(
        initSessionIds,
        [null, null],
        'initialize（含重握手那一次）都不得携带 Mcp-Session-Id——严格服务端对未知 sid 会 400'
      )
      assert.equal(session.state, 'ready')
      assert.deepEqual(session.tools.map(tool => tool.name), ['echo'], '重试的 tools/list 必须成功')
      assert.equal(listAttempts, 2)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('ECONNREFUSED → mcp_transport_closed + 可读原因 + 含 URL + 无堆栈', async () => {
    const dead = await startFakeHttpServer({ mode: 'json' })
    const deadUrl = dead.url
    await dead.close()

    const transport = new HttpTransport({ url: deadUrl, timeoutMs: 3000 })
    const session = new McpSession({
      serverConfig: { id: 'httpdead', name: 'dead', transport: 'http', timeoutMs: 3000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    sessions.push(session)

    let captured = null
    await assert.rejects(session.connect(), (err) => {
      captured = err
      assert.equal(err.code, ERR.TRANSPORT_CLOSED)
      assert.match(err.message, /ECONNREFUSED/)
      assert.ok(err.message.includes(deadUrl), `应含目标 URL：${err.message}`)
      assert.ok(!/\n\s+at /.test(err.message), 'message 不能带堆栈')
      return true
    })
    assert.equal('stack' in captured.toErrorObject(), false)
    assert.equal(session.state, 'failed')
  })
})

describe('验收 · M3′ tools/list 分页不得死循环（夹具 nextCursorLoop）', () => {
  /**
   * 用夹具的 `nextCursorLoop`：服务端**永远**返回不同 cursor，永不终止。
   * 自然结束的分页假 server 抓不到「没有上限」的 bug（测试只会绿）。
   * @returns {{session: McpSession, transport: ScriptedTransport}}
   */
  function loopingSession () {
    const transport = new ScriptedTransport({
      tools: [{ name: 'echo', description: '', inputSchema: { type: 'object', properties: {} } }],
      nextCursorLoop: true
    })
    const session = new McpSession({
      serverConfig: { id: 'loop1', name: 'loop', transport: 'stdio', timeoutMs: 2000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    transport.onClose = info => session.handleTransportClosed(info)
    return { session, transport }
  }

  /**
   * @param {ScriptedTransport} transport
   * @returns {number}
   */
  function listRequests (transport) {
    return transport.received.filter(msg => msg.method === 'tools/list').length
  }

  it('重复 cursor 时请求次数有上限，连接仍进入 ready（不死循环）', async () => {
    const { session, transport } = loopingSession()
    await session.connect()

    assert.equal(session.state, 'ready', '追到上限也必须进入 ready，不能把连接判死')
    const requests = listRequests(transport)
    assert.ok(requests <= 5, `tools/list 请求 ${requests} 次，超出页数上限`)
    assert.ok(requests >= 2, '应当真的跟了分页')
    await session.close()
  })

  it('重复 cursor 时请求次数恰为页数上限、截断可见、总耗时有预算（判据 import 常量）', async () => {
    const { session, transport } = loopingSession()
    const started = Date.now()
    await session.connect()
    const elapsed = Date.now() - started

    assert.equal(session.state, 'ready', '追到上限也必须进入 ready，不能把连接判死')
    // 恰好 MAX_LIST_PAGES 次：`<=` 单独用是弱断言，「只取 1 页就收工」的错误
    // 实现也满足它。工具数 == 1（每页 1 个）× 页数同时锁死「没少拿」。
    assert.equal(listRequests(transport), MAX_LIST_PAGES,
      `tools/list 请求 ${listRequests(transport)} 次，上限是 MAX_LIST_PAGES=${MAX_LIST_PAGES}`)
    assert.equal(session.tools.length, MAX_LIST_PAGES, '每页 1 个工具，页数即工具数')
    assert.equal(session.toolsTruncated, true, '有剩余 cursor 却因上限停下 = 截断，必须让 UI 知道')
    assert.ok(elapsed <= LIST_BUDGET_MS + 2000,
      `分页总耗时 ${elapsed}ms 超出 LIST_BUDGET_MS=${LIST_BUDGET_MS} 预算`)
    await session.close()
  })

  it('自然结束的分页 → 不误报截断、请求数恰为页数（反向判据）', async () => {
    // 不带 nextCursorLoop：一页拿完，无 cursor ——「打满即截断」的实现会把这种
    // 正常情形也标成截断，UI 会永远骗用户说工具不全。
    const transport = new ScriptedTransport({
      tools: [
        { name: 'echo', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool_1', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool_2', description: '', inputSchema: { type: 'object', properties: {} } }
      ]
    })
    const session = new McpSession({
      serverConfig: { id: 'nat1', name: 'natural', transport: 'stdio', timeoutMs: 2000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    transport.onClose = info => session.handleTransportClosed(info)
    await session.connect()
    assert.equal(listRequests(transport), 1, '一页拿完就停')
    assert.equal(session.tools.length, 3)
    assert.equal(session.toolsTruncated, false, '自然结束不得标截断')
    await session.close()
  })

  it('回归（曾为缺陷 P0-1-C，2026-11-10 修复）：打满页数上限必须置 toolsTruncated=true（不得静默截断）', async () => {
    const { session } = loopingSession()
    await session.connect()
    assert.equal(session.toolsTruncated, true, '因页数上限停止 = 截断，必须让 UI 知道')
    await session.close()
  })

  it('第 2 页 hang → connect 仍成功、保留第 1 页工具（部分结果不得整体丢弃）', async () => {
    // 曾为缺陷：listTools 的循环没有 try/catch，第 2 页超时会把整个 connect
    // 抛掉，第 1 页已拿到的工具全部作废——危害不是慢，是慢完之后全丢。
    const { session } = spawnSession(
      FIXTURE,
      ['--stdio', '--page-size=2', '--tools=6', '--hang-on-page=2'],
      {},
      { listTimeoutMs: 300 }
    )
    const started = Date.now()
    const state = await session.connect()
    const elapsed = Date.now() - started

    assert.ok(state, '部分结果时 connect 必须成功而不是抛错')
    assert.ok(['ready', 'degraded'].includes(session.state), `state=${session.state}`)
    assert.equal(session.tools.length, 2, `必须保留第 1 页的 2 个工具，实际 ${session.tools.length}`)
    assert.deepEqual(
      session.tools.map(tool => tool.name).sort(),
      ['echo', 'tool_1']
    )
    assert.equal(session.toolsTruncated, true, '没拿全就必须标截断')
    assert.ok(session.lastError, '失败的那页要留 lastError 供 UI/日志')
    assert.ok(elapsed < LIST_BUDGET_MS, `第 2 页 hang 时 ${elapsed}ms 内必须收敛，不得拖满预算`)
    // 拿到的工具必须真的可用
    const result = await session.callTool('echo', { text: 'partial-ok' }, { timeoutMs: 3000 })
    assert.equal(result.text, JSON.stringify({ text: 'partial-ok' }))
    await session.close()
  })
})

describe('验收 · M8 超时收敛且会话仍可用', () => {
  it('--hang（永不回包）→ timeoutMs+1s 内 mcp_timeout', async () => {
    const { session } = spawnSession(FIXTURE, ['--stdio', '--hang'])
    await session.connect()
    const timeoutMs = 300
    const started = Date.now()
    await assert.rejects(
      session.callTool('echo', { text: 'x' }, { timeoutMs }),
      (err) => {
        assert.equal(err.code, ERR.TIMEOUT)
        assert.match(err.message, /timed out after 300 ms/)
        return true
      }
    )
    assert.ok(Date.now() - started < timeoutMs + 1000)
  })

  it('--hang-first → 超时后同一会话还能成功调用一次（状态回到 ready）', async () => {
    const { session } = spawnSession(SLOW_SERVER, ['--hang-first'])
    await session.connect()
    const timeoutMs = 300

    await assert.rejects(
      session.callTool('echo', { text: 'first' }, { timeoutMs }),
      err => err.code === ERR.TIMEOUT
    )
    assert.equal(session.state, 'degraded', '单次超时后应降级但保持可用')

    const result = await session.callTool('echo', { text: 'second' }, { timeoutMs: 3000 })
    assert.equal(result.text, 'ok:{"text":"second"}')
    assert.equal(session.state, 'ready', '成功一次后回到 ready')
  })

  it('慢响应（700ms > deadline 300ms）→ mcp_timeout，且之后仍可正常调用', async () => {
    const { session } = spawnSession(SLOW_SERVER, ['--delay-once=700'])
    await session.connect()
    const timeoutMs = 300
    const started = Date.now()

    await assert.rejects(
      session.callTool('echo', { text: 'slow' }, { timeoutMs }),
      err => err.code === ERR.TIMEOUT
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < timeoutMs + 1000, `超时收敛耗时 ${elapsed}ms`)

    const result = await session.callTool('echo', { text: 'after' }, { timeoutMs: 3000 })
    assert.equal(result.text, 'ok:{"text":"after"}')
  })
})
