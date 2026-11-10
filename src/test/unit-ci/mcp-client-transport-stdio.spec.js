/**
 * MCP client · stdio 传输（契约测试，M2 / M9 / 超时）。
 *
 * 假 server 是 `src/test/fixtures/fake-mcp-server.js`（独立实现换行分帧，
 * 只借用本仓 `McpServer` 当工具表容器）。全程不联网。
 */

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { StdioTransport } = require('../../app/mcp/client/stdio-transport')
const { McpSession } = require('../../app/mcp/client/session')
const { ERR } = require('../../app/mcp/client/rpc')
const {
  isProcessAlive,
  waitForProcessExit
} = require('../fixtures/fake-mcp-server')

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-mcp-server.js')
const SUPPORTED = ['2025-11-25', '2025-06-18', '2024-11-05']

const created = []

/**
 * 拉起一个假 server 会话并把 transport.onMessage 接好。
 * @param {string[]} [flags]
 * @param {object} [serverConfig]
 * @returns {{transport: StdioTransport, session: McpSession}}
 */
function spawnSession (flags = ['--stdio'], serverConfig = {}) {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [FIXTURE, ...flags],
    label: 'fake-stdio'
  })
  const session = new McpSession({
    serverConfig: {
      id: 'stdio1',
      name: 'fake-stdio',
      transport: 'stdio',
      timeoutMs: 8000,
      ...serverConfig
    },
    transport
  })
  transport.onMessage = msg => session.handleMessage(msg)
  transport.onClose = info => session.handleTransportClosed(info)
  created.push({ transport, session })
  return { transport, session }
}

/**
 * `ps -o pid=` 是否有输出（Linux/macOS）。没有 ps 的平台返回 null。
 * @param {number} pid
 * @returns {string|null}
 */
function psPid (pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (_) {
    return null
  }
}

after(async () => {
  for (const { transport, session } of created) {
    try {
      await session.close('test-teardown')
    } catch (_) {
      // teardown only
    }
    // kill() 返回不等于进程已经消失；不轮询到底会让 node:test 一直等管道句柄
    if (transport.pid) {
      await waitForProcessExit(transport.pid)
    }
  }
})

describe('mcp-client stdio transport', () => {
  it('M2：spawn → initialize → tools/list 拿到工具，协议版本在允许表内', async () => {
    const { transport, session } = spawnSession(['--stdio', '--tools=3', '--huge'])
    const started = Date.now()
    await session.connect()
    const elapsed = Date.now() - started

    assert.equal(session.state, 'ready')
    assert.ok(
      SUPPORTED.includes(session.protocolVersion),
      `unexpected protocolVersion: ${session.protocolVersion}`
    )
    assert.ok(session.tools.length > 0, 'tools/list 必须返回工具')
    assert.deepEqual(
      session.tools.map(tool => tool.name).sort(),
      // --tools=3 是精确总数（echo + tool_1 + tool_2），huge 由 --huge 额外给出
      ['echo', 'huge', 'tool_1', 'tool_2']
    )
    assert.ok(elapsed < 5000, `握手耗时 ${elapsed}ms，超出 5s`)
    assert.ok(transport.pid > 0)
  })

  it('M2：tools/call 真的把参数送达 server，并把 content 折成文本', async () => {
    const { session } = spawnSession()
    await session.connect()
    const result = await session.callTool('echo', { text: 'ping' }, { timeoutMs: 3000 })
    assert.equal(result.isError, false)
    assert.deepEqual(JSON.parse(result.text), { text: 'ping' })
  })

  it('M9：close() 之后子进程真的没了（轮询 kill(pid,0) → ESRCH，ps 无输出）', async () => {
    const { transport, session } = spawnSession()
    await session.connect()
    const pid = transport.pid
    assert.ok(pid > 0)
    assert.equal(isProcessAlive(pid), true, '连接期间进程必须活着')
    const before = psPid(pid)
    if (before !== null) {
      assert.equal(before, String(pid))
    }

    await session.close()

    assert.equal(session.state, 'closed')
    // 轮询而不是"睡一下再查"：SIGTERM 到真实退出之间有一个真实的窗口
    const exited = await waitForProcessExit(pid)
    assert.equal(exited, true, `pid ${pid} 在 2s 内没有退出（M9 失败）`)
    assert.equal(isProcessAlive(pid), false, `pid ${pid} 仍然存活（M9 失败）`)
    const after = psPid(pid)
    assert.equal(after, null, `ps 仍能看到 pid ${pid}: "${after}"`)
  })

  it('超时：server 收到 tools/call 但不回包 → timeoutMs + 1s 内返回 mcp_timeout', async () => {
    const { session } = spawnSession(['--stdio', '--hang'])
    await session.connect()
    const timeoutMs = 300
    const started = Date.now()
    await assert.rejects(
      session.callTool('echo', { text: 'x' }, { timeoutMs }),
      (err) => {
        assert.equal(err.code, ERR.TIMEOUT)
        assert.match(err.message, /tools\/call timed out after 300 ms/)
        return true
      }
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < timeoutMs + 1000, `耗时 ${elapsed}ms 超过 ${timeoutMs + 1000}ms`)
  })

  it('server 回不支持的协议版本 → 握手失败，错误可读且带版本号', async () => {
    const { session } = spawnSession(['--stdio', '--bad-version'])
    await assert.rejects(session.connect(), (err) => {
      assert.equal(err.code, ERR.VERSION_UNSUPPORTED)
      assert.match(err.message, /2020-01-01/)
      return true
    })
    assert.equal(session.state, 'failed')
  })

  it('command 不存在 → 可读错误（不把裸堆栈丢给 IPC）', async () => {
    const transport = new StdioTransport({
      command: '/nonexistent/definitely-not-a-real-mcp-server',
      args: [],
      label: 'missing'
    })
    const session = new McpSession({
      serverConfig: { id: 'missing', name: 'missing', transport: 'stdio', timeoutMs: 2000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    created.push({ transport, session })
    await assert.rejects(session.connect(), (err) => {
      assert.equal(err.code, ERR.TRANSPORT_CLOSED)
      assert.match(err.message, /cannot start MCP server/)
      assert.match(err.message, /not found|install it/)
      assert.ok(!/\n\s+at /.test(err.message), '不能带堆栈')
      return true
    })
  })

  it('子进程中途退出 → 会话进入 failed 且 pending 请求收敛', async () => {
    const { session } = spawnSession(['--stdio', '--exit-on-init'])
    await assert.rejects(session.connect())
    assert.equal(session.state, 'failed')
    assert.ok(session.lastError.length > 0)
  })
})
