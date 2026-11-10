/**
 * MCP client · manager（注册表 / 工具集 / 调用路由）。
 *
 * 这里跑的是**完整链路**：syncConfig → 会话握手 → 别名注册表 → 工具集 →
 * callTool → transport。两条由 lead/QA 追加的硬判据必须在这一层证明：
 *
 *   1. schema 降级（超 8 KiB → `properties: {}`）之后**仍然能成功调用**；
 *   2. 未声明的参数键**一路放行到 server**（不是只在 validateArgs 里返回 ok）。
 *
 * transport 用 `src/test/fixtures/scripted-mcp-transport.js`（进程内、独立实现）。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  McpClientManager,
  needsApprovalFor
} = require('../../app/mcp/client/manager')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')
const { ERR } = require('../../app/mcp/client/rpc')

/**
 * 必被降级的 schema：200 条 80 字符 enum，任何档位都过不了 8 KiB 预算。
 * @returns {object}
 */
function hugeSchema () {
  const values = []
  for (let i = 0; i < 200; i++) {
    values.push(String(i).padStart(3, '0') + '-' + 'x'.repeat(77))
  }
  return {
    type: 'object',
    properties: { filter: { type: 'string', enum: values } },
    required: ['filter']
  }
}

/**
 * @param {Array} tools
 * @param {object} [opts]
 * @returns {{manager: McpClientManager, transport: ScriptedTransport, logs: string[]}}
 */
function makeManager (tools, opts = {}) {
  const transport = new ScriptedTransport({ tools, ...opts.transport })
  const logs = []
  const manager = new McpClientManager({
    transportFactory: () => transport,
    log: message => logs.push(message),
    limits: opts.limits
  })
  return { manager, transport, logs }
}

/**
 * @param {object} extra
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

describe('mcp-client manager', () => {
  it('没有任何 server：工具集为空，状态为空', async () => {
    const { manager } = makeManager([])
    await manager.syncConfig([])
    const toolSet = manager.getToolSet()
    assert.deepEqual(toolSet.openaiTools, [])
    assert.deepEqual(toolSet.meta, {})
    assert.deepEqual(toolSet.servers, [])
    assert.deepEqual(toolSet.truncated, { perServer: 0, global: 0 })
    assert.deepEqual(manager.getState(), [])
  })

  it('配置缺失（undefined / null）也当成没有 server，不抛错', async () => {
    const { manager } = makeManager([])
    for (const value of [undefined, null]) {
      const states = await manager.syncConfig(value)
      assert.deepEqual(states, [])
    }
  })

  it('注册表：别名带 mcp__ 前缀，meta 带 originalName / serverId / needsApproval', async () => {
    const { manager } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    const toolSet = manager.getToolSet({ builtinToolNames: ['send_terminal_command'] })
    assert.equal(toolSet.openaiTools.length, 1)
    const tool = toolSet.openaiTools[0]
    assert.equal(tool.type, 'function')
    assert.equal(tool.function.name, 'mcp__srv1__echo')
    const meta = toolSet.meta[tool.function.name]
    assert.equal(meta.serverId, 'srv1')
    assert.equal(meta.originalName, 'echo')
    assert.equal(meta.trust, 'ask')
    assert.equal(meta.needsApproval, true, 'D1：ask + 无 readOnlyHint → 需要确认')
    assert.equal(meta.degraded, false)
    assert.deepEqual(meta.degradationNotes, [])
  })

  it('内置优先（M5）：撞名的外部工具被跳过并留 warning，内置实现不受影响', async () => {
    const { manager, logs } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    const toolSet = manager.getToolSet({ builtinToolNames: ['mcp__srv1__echo'] })
    assert.deepEqual(toolSet.openaiTools, [])
    assert.deepEqual(toolSet.meta, {})
    assert.ok(
      logs.some(line => /collides with a built-in tool/.test(line)),
      JSON.stringify(logs)
    )
  })

  it('每 server / 全局截断都有计数（UI 徽章读它）', async () => {
    const tools = Array.from({ length: 5 }, (_, index) => ({
      name: `tool_${index}`,
      description: '',
      inputSchema: { type: 'object', properties: {} },
      annotations: {}
    }))
    const perServer = makeManager(tools, { limits: { perServerTools: 2 } })
    await perServer.manager.syncConfig([stdioConfig()])
    const limited = perServer.manager.getToolSet()
    assert.equal(limited.openaiTools.length, 2)
    assert.equal(limited.truncated.perServer, 3)

    const global = makeManager(tools, { limits: { globalTools: 2 } })
    await global.manager.syncConfig([stdioConfig()])
    const capped = global.manager.getToolSet()
    assert.equal(capped.openaiTools.length, 2)
    assert.equal(capped.truncated.global, 3)
  })

  it('未知别名 → 结构化 unknown_external_tool，不抛错', async () => {
    const { manager } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    const result = await manager.callTool('mcp__nope__whatever', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.UNKNOWN_TOOL)
    assert.ok(Array.isArray(result.error.known))
  })

  it('server 掉线（transport closed）→ mcp_server_unavailable，并给出可操作提示', async () => {
    const { manager, transport } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    // 进程没了：注册表还在（还没重建），但会话已经不是 ready
    transport.onClose({ code: 1, signal: null })
    assert.equal(manager.getState()[0].state, 'failed')
    const result = await manager.callTool('mcp__srv1__echo', { a: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.UNAVAILABLE)
    assert.match(result.error.hint, /Settings/)
  })

  it('未声明参数键一路放行到 server（完整链路，不只 validateArgs）', async () => {
    const { manager, transport } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    const args = { a: 'x', b: 1, __proto__x: 2 }
    const result = await manager.callTool('mcp__srv1__echo', args)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(
      transport.lastCallArguments(),
      args,
      '多余键必须真的送到 server，否则「接上了但永远失败」'
    )
    assert.deepEqual(JSON.parse(result.text), args)
  })

  it('schema 降级后仍能成功调用（完整链路），且 meta 带 degraded + notes', async () => {
    const hugeTool = {
      name: 'huge',
      description: 'schema too large',
      inputSchema: hugeSchema(),
      annotations: {},
      handler: (args) => ({
        content: [{ type: 'text', text: `huge:${JSON.stringify(args)}` }]
      })
    }
    const { manager, transport } = makeManager([hugeTool])
    await manager.syncConfig([stdioConfig()])

    const toolSet = manager.getToolSet()
    assert.equal(toolSet.openaiTools.length, 1)
    const parameters = toolSet.openaiTools[0].function.parameters
    assert.deepEqual(parameters.properties, {}, '超预算 schema 必须降级成空 properties')
    const meta = toolSet.meta[toolSet.openaiTools[0].function.name]
    assert.equal(meta.degraded, true)
    assert.ok(meta.degradationNotes.length > 0, '降级原因要能被 UI 徽章读到')

    const args = { filter: 'anything', extra: { nested: [1, 2] } }
    const result = await manager.callTool('mcp__srv1__huge', args)
    assert.equal(result.ok, true, `降级后调用失败: ${JSON.stringify(result)}`)
    assert.deepEqual(transport.lastCallArguments(), args)
    assert.match(result.text, /huge:/)
  })

  it('declared 键类型错误 → invalid_tool_arguments，且**不**发到 server', async () => {
    const { manager, transport } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    const before = transport.received.filter(msg => msg.method === 'tools/call').length
    const result = await manager.callTool('mcp__srv1__echo', { a: 42 })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.INVALID_ARGS)
    assert.equal(result.error.errors[0].path, '$.a')
    const after = transport.received.filter(msg => msg.method === 'tools/call').length
    assert.equal(after, before, '参数不合法时不应产生网络往返')
  })

  it('禁用 server 后不再注册工具', async () => {
    const { manager } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig({ enabled: false })])
    const toolSet = manager.getToolSet()
    assert.deepEqual(toolSet.openaiTools, [])
    assert.equal(manager.getState()[0].state, 'closed')
  })

  it('shutdownAll 之后注册表清空（M9 的 manager 面）', async () => {
    const { manager } = makeManager([echoTool])
    await manager.syncConfig([stdioConfig()])
    assert.equal(manager.getToolSet().openaiTools.length, 1)
    await manager.shutdownAll()
    assert.deepEqual(manager.getToolSet().openaiTools, [])
  })

  it('needsApprovalFor 的 6 格决策表（D1）', () => {
    const readOnly = { annotations: { readOnlyHint: true } }
    const write = { annotations: {} }
    const auto = { annotations: {} }

    assert.equal(needsApprovalFor({ trust: 'ask', ...write }), true)
    assert.equal(needsApprovalFor({ trust: 'ask', ...readOnly }), false)
    assert.equal(needsApprovalFor({ trust: 'auto', ...auto }), false)
    assert.equal(needsApprovalFor({ trust: 'auto', ...readOnly }), false)
    assert.equal(needsApprovalFor({ trust: 'readonly', ...write }), true)
    assert.equal(needsApprovalFor({ trust: 'readonly', ...readOnly }), false)
    // 缺省 trust 必须等价于 ask（fail-closed）
    assert.equal(needsApprovalFor({ annotations: {} }), true)
  })
})
