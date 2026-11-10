/**
 * 验收（QA 独立）：取消语义 / M9 资源回收 / 降级与参数校验的完整链路。
 *
 * 三条口径（与 lead 的验收要求一致，报告里逐条引用）：
 * 1. 取消：`cancel(id)` 后同 id 立刻 reject（0ms 量级）、pending 清空、
 *    且**不产生第二次 tools/call**（只发 `notifications/cancelled`）。
 * 2. M9：`close()` 后 `process.kill(pid, 0)` 抛 ESRCH（轮询上限 2s）；
 *    连续 5 次 connect/close 后活跃句柄数不增长。
 * 3. 降级：8 KiB 超大 schema → `properties={}` + `degraded:true` +
 *    `degradationNotes` 非空，**且降级后仍能成功 call**（真子进程往返）。
 */

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { JsonRpcPeer, ERR } = require('../../app/mcp/client/rpc')
const { StdioTransport } = require('../../app/mcp/client/stdio-transport')
const { McpSession } = require('../../app/mcp/client/session')
const { McpClientManager } = require('../../app/mcp/client/manager')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-mcp-server.js')

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

/**
 * 轮询等待进程消失。
 * @param {number} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForDead (pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

/**
 * @param {object[]} [tools]
 * @param {object} [opts]
 * @returns {{manager: McpClientManager, transport: ScriptedTransport}}
 */
function makeScriptedManager (tools, opts = {}) {
  const transport = new ScriptedTransport({ tools, ...opts.transport })
  const manager = new McpClientManager({ transportFactory: () => transport })
  return { manager, transport }
}

/**
 * @param {object} [extra]
 * @returns {object}
 */
function stdioConfig (extra = {}) {
  return {
    id: 'srv1',
    name: 'Fake server',
    transport: 'stdio',
    command: 'node',
    args: ['fake.js'],
    trust: 'ask',
    ...extra
  }
}

const echoTool = {
  name: 'echo',
  description: 'echo the arguments',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a']
  },
  annotations: {}
}

const createdManagers = []

after(async () => {
  for (const manager of createdManagers) {
    try {
      await manager.shutdownAll()
    } catch (_) {
      // teardown only
    }
  }
})

describe('验收 · 取消语义', () => {
  it('rpc.cancel(id) → 立刻 reject（mcp_aborted），pending 清空', async () => {
    const sent = []
    const peer = new JsonRpcPeer({
      send: (msg) => {
        sent.push(msg)
      },
      defaultTimeoutMs: 30000
    })
    let rpcId = null
    const promise = peer.request('tools/call', { name: 'x', arguments: {} }, {
      timeoutMs: 30000,
      onStart: (id) => {
        rpcId = id
      }
    })
    assert.equal(peer.pendingCount, 1)
    assert.ok(rpcId !== null)

    const started = Date.now()
    const cancelled = peer.cancel(rpcId, 'user')
    assert.equal(cancelled, true)
    await assert.rejects(promise, (err) => {
      assert.equal(err.code, ERR.ABORTED)
      return true
    })
    assert.ok(Date.now() - started < 50, `取消后 ${Date.now() - started}ms 才 reject，应为 0ms 量级`)
    assert.equal(peer.pendingCount, 0, 'pending 表必须清空')
    assert.equal(sent.filter(msg => msg.method === 'tools/call').length, 1, '不得重发请求')
    peer.dispose()
  })

  it('会话级取消（AbortSignal）→ mcp_aborted，只发 1 次 tools/call + 1 条 cancelled 通知', async () => {
    const transport = new ScriptedTransport({
      tools: [echoTool],
      hangMethods: ['tools/call']
    })
    const session = new McpSession({
      serverConfig: { id: 'cancel1', transport: 'stdio', timeoutMs: 30000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    await session.connect()

    const controller = new AbortController()
    const started = Date.now()
    const promise = session.callTool('echo', { a: 'x' }, {
      timeoutMs: 30000,
      signal: controller.signal
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()

    await assert.rejects(promise, (err) => {
      assert.equal(err.code, ERR.ABORTED)
      return true
    })
    assert.ok(Date.now() - started < 1000, '取消应当立刻生效，不等 30s 超时')

    // 给「可能的重发」留一个事件循环窗口
    await new Promise(resolve => setTimeout(resolve, 150))
    const calls = transport.received.filter(msg => msg.method === 'tools/call')
    assert.equal(calls.length, 1, `取消后不得产生第二次 tools/call，实际 ${calls.length} 次`)
    const cancelledNotes = transport.received.filter(msg => msg.method === 'notifications/cancelled')
    assert.equal(cancelledNotes.length, 1, '应通知 server 停止处理')
    assert.equal(cancelledNotes[0].params.requestId, calls[0].id, 'requestId 必须是那条 tools/call 的 id')
    assert.equal(session.peer.pendingCount, 0, 'pending 必须清空')
    await session.close()
  })
})

describe('验收 · M9 资源回收', () => {
  it('close() 后 kill(pid,0) 抛 ESRCH（轮询上限 2s）', async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [FIXTURE, '--stdio'],
      label: 'm9-single'
    })
    const session = new McpSession({
      serverConfig: { id: 'm9a', name: 'm9', transport: 'stdio', timeoutMs: 5000 },
      transport
    })
    transport.onMessage = msg => session.handleMessage(msg)
    transport.onClose = info => session.handleTransportClosed(info)
    await session.connect()
    const pid = transport.pid
    assert.ok(pid > 0)
    assert.equal(isAlive(pid), true)

    await session.close()
    assert.equal(await waitForDead(pid, 2000), true, `pid ${pid} 在 2s 内仍未退出`)
  })

  it('连续 5 次 connect/close 后活跃句柄数不增长，且所有子进程都已消失', async () => {
    // 先跑一轮预热，把「首次 require / DNS / 定时器池」的一次性句柄吃掉
    const warmup = new StdioTransport({
      command: process.execPath,
      args: [FIXTURE, '--stdio'],
      label: 'm9-warmup'
    })
    const warmSession = new McpSession({
      serverConfig: { id: 'm9w', name: 'warm', transport: 'stdio', timeoutMs: 5000 },
      transport: warmup
    })
    warmup.onMessage = msg => warmSession.handleMessage(msg)
    warmup.onClose = info => warmSession.handleTransportClosed(info)
    await warmSession.connect()
    await warmSession.close()
    await new Promise(resolve => setTimeout(resolve, 50))

    const handlesBefore = process._getActiveHandles().length
    const pids = []
    for (let i = 0; i < 5; i++) {
      const transport = new StdioTransport({
        command: process.execPath,
        args: [FIXTURE, '--stdio'],
        label: `m9-cycle-${i}`
      })
      const session = new McpSession({
        serverConfig: { id: `m9c${i}`, name: `cycle${i}`, transport: 'stdio', timeoutMs: 5000 },
        transport
      })
      transport.onMessage = msg => session.handleMessage(msg)
      transport.onClose = info => session.handleTransportClosed(info)
      await session.connect()
      pids.push(transport.pid)
      await session.close()
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    const handlesAfter = process._getActiveHandles().length

    assert.ok(
      handlesAfter <= handlesBefore + 3,
      `活跃句柄从 ${handlesBefore} 涨到 ${handlesAfter}（+3 容差内才算不泄漏）`
    )
    for (const pid of pids) {
      assert.equal(await waitForDead(pid, 2000), true, `pid ${pid} 仍存活`)
    }
  })
})

describe('验收 · 降级与参数校验（manager 完整链路，真子进程）', () => {
  /**
   * @returns {Promise<McpClientManager>}
   */
  async function connectRealFake () {
    const manager = new McpClientManager({})
    createdManagers.push(manager)
    await manager.syncConfig([{
      id: 'srv1',
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE, '--stdio', '--huge'],
      trust: 'ask'
    }])
    return manager
  }

  it('8 KiB+ schema → properties={} + degraded + notes，且降级后仍能成功 call', async () => {
    const manager = await connectRealFake()
    const toolSet = manager.getToolSet()
    const alias = 'mcp__srv1__huge'
    const tool = toolSet.openaiTools.find(item => item.function.name === alias)
    assert.ok(tool, `注册表里没有 ${alias}：${JSON.stringify(toolSet.openaiTools.map(t => t.function.name))}`)

    const parameters = tool.function.parameters
    assert.deepEqual(parameters.properties, {}, '超预算 schema 必须降级为空 properties')
    assert.equal(parameters.additionalProperties, true, '降级后必须接受任意参数，否则永远调不通')

    const meta = toolSet.meta[alias]
    assert.equal(meta.degraded, true)
    assert.ok(Array.isArray(meta.degradationNotes) && meta.degradationNotes.length > 0,
      '降级原因要能被 UI 徽章读到')

    const args = { filter: 'anything', extra: { nested: [1, 2] } }
    const result = await manager.callTool(alias, args)
    assert.equal(result.ok, true, `降级后调用失败：${JSON.stringify(result)}`)
    assert.match(result.text, /^huge:/)
    const echoed = JSON.parse(result.text.slice('huge:'.length))
    assert.deepEqual(echoed, args, '参数必须原样到达 server（真子进程往返）')
  })

  it('未声明键（含 __proto__x）一路放行到 server 侧', async () => {
    const manager = await connectRealFake()
    const args = { text: 'x', b: 1, __proto__x: 2 }
    const result = await manager.callTool('mcp__srv1__echo', args)
    assert.equal(result.ok, true, JSON.stringify(result))
    // 假 server 的 echo 把收到的 arguments 原样 JSON 回来
    assert.deepEqual(JSON.parse(result.text), args)
  })

  it('已声明键类型错 → invalid_tool_arguments，且零 tools/call 往返', async () => {
    const { manager, transport } = makeScriptedManager([echoTool])
    createdManagers.push(manager)
    await manager.syncConfig([stdioConfig()])

    const before = transport.received.filter(msg => msg.method === 'tools/call').length
    const result = await manager.callTool('mcp__srv1__echo', { a: 42 })

    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.INVALID_ARGS)
    assert.equal(result.error.errors[0].path, '$.a')
    const after = transport.received.filter(msg => msg.method === 'tools/call').length
    assert.equal(after, before, '参数不合法时不得产生网络往返')
  })

  it('超时错误经 manager 返回时是 IPC 安全对象（无 stack）', async () => {
    const { manager } = makeScriptedManager([echoTool], {
      transport: { hangMethods: ['tools/call'] }
    })
    createdManagers.push(manager)
    await manager.syncConfig([stdioConfig({ timeoutMs: 5000 })])

    const result = await manager.callTool('mcp__srv1__echo', { a: 'x' }, { timeoutMs: 200 })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.TIMEOUT)
    assert.equal('stack' in result.error, false, `IPC 对象不得带 stack：${JSON.stringify(result.error)}`)
    assert.ok(!/\n\s+at /.test(result.error.message), 'message 不带堆栈')
  })
})
