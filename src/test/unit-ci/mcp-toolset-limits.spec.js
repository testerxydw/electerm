/**
 * T03 批次二/三 · 工具注册层判据（manager 直测，ScriptedTransport 假 server）。
 *
 * 覆盖：
 * - M20 别名契约 + warn 取证点（**选定 `manager.warnings`**，经
 *   `mcpClientGetTools().warnings` 暴露；`meta.degradationNotes` 只装 schema
 *   降级原因，不混装别名 warn —— 两处并存会让断言两头落空）
 * - M21 内置优先：外部提供 `db_insert_sql` / `DB_INSERT_SQL` 都被跳过 + warn
 *   （含 alias），内置定义逐字符不变（Function.prototype.toString）
 * - M24 路由与零网络：validateArgs 失败 → `invalid_tool_arguments` 且
 *   `tools/call` 往返为 0（transport.received 计数）；8KiB 降级 schema 放行
 *   任意入参（M4-④），且恰好一次 tools/call 往返
 * - M26 tools/list 触发条件：仅①会话建立②force 时发起；签名不变的
 *   syncConfig/getToolSet 不产生新请求
 * - M28 两层上限：200 个外部工具 → 注册层截到 `LIMITS.globalTools`（import
 *   常量，禁字面量）；协议层 MAX_LIST_PAGES/MAX_TOOLS 只体现在
 *   toolsTruncated，不影响本断言
 */

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const { McpClientManager, resetManager } = require('../../app/mcp/client/manager')
const { LIMITS } = require('../../app/mcp/client/schema-slim')
const { MAX_LIST_PAGES, MAX_TOOLS } = require('../../app/mcp/client/session')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')
const { buildHugeSchema } = require('../fixtures/fake-mcp-server')

const SERVER_ID = 'srv1234' // 7 字符，同生产 nanoid(7)

/**
 * 一个带 ScriptedTransport 的 manager + 一台假 server。
 * @param {Array<{name: string, inputSchema?: object, description?: string}>} tools
 * @returns {{manager: McpClientManager, transport: ScriptedTransport}}
 */
function makeManager (tools) {
  const transport = new ScriptedTransport({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description || 'desc ' + tool.name,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} }
    }))
  })
  const manager = new McpClientManager({
    transportFactory: () => transport
  })
  return { manager, transport }
}

/**
 * 连好一台启用的 server 并跑完握手/工具表。
 * @param {McpClientManager} manager
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
async function connectOne (manager, opts = {}) {
  await manager.syncConfig([{
    id: SERVER_ID,
    name: 'fake-srv',
    transport: 'stdio',
    command: 'node',
    args: ['-e', '0'],
    trust: 'ask',
    timeoutMs: opts.timeoutMs,
    enabled: true
  }])
}

function listCalls (transport) {
  return transport.received.filter(msg => msg.method === 'tools/list').length
}

function callCalls (transport) {
  return transport.received.filter(msg => msg.method === 'tools/call').length
}

beforeEach(() => {
  resetManager()
})

describe('M20 · alias contract + warn 取证点', () => {
  it('非法字符/超长/清洗撞名的工具逐条满足 §2.5，且 warn 全部落在 manager.warnings', async () => {
    const longName = 'very_long_tool_name_' + 'y'.repeat(60)
    const { manager, transport } = makeManager([
      { name: 'a.b' }, // 清洗成 a_b
      { name: 'a_b' }, // 与 a.b 撞名 → 字典序第二个加 _2
      { name: longName }, // 超长 → 截断 + 短哈希
      { name: 'ok_tool' } // 合法
    ])
    await connectOne(manager)

    const toolSet = manager.getToolSet({
      builtinToolNames: ['send_terminal_command']
    })
    const aliases = toolSet.openaiTools.map(item => item.function.name)

    assert.ok(aliases.includes('mcp__srv1234__a_b'), JSON.stringify(aliases))
    assert.ok(
      aliases.includes('mcp__srv1234__a_b_2'),
      '清洗撞名不折叠 `_`，按原始名字典序第二个加 _2：' + JSON.stringify(aliases)
    )
    for (const alias of aliases) {
      assert.ok(alias.length <= 64, `${alias} 超过 64 上限`)
      assert.equal(alias, alias.toLowerCase(), '别名必须全小写')
      assert.match(alias, /^mcp__[a-z0-9_-]+__[a-z0-9_-]+(_\d+)?$/)
      assert.ok(!/_+_{3,}/.test(alias.replace('mcp__', '')), '连续 _ 不许被折叠')
    }
    const longAlias = aliases.find(alias => alias.includes(longName.slice(0, 10).toLowerCase()))
    assert.ok(longAlias && longAlias.includes('_'), '超长名要截断')
    assert.ok(
      !aliases.includes('mcp__srv1234__' + longName.toLowerCase()),
      '超长名不得原样注册'
    )
    assert.equal(transport.received.length, 3, '握手+工具表请求不受别名影响')

    // warn 取证点：manager.warnings（经门面 warnings 暴露）
    const warnings = manager.warnings.join('\n')
    assert.match(warnings, /duplicate tool name after sanitizing/, '撞名要有 warn（含原名对）')
    assert.match(warnings, /tool name truncated/, '超长截断要有 warn')
    // 字典序：'a.b' < 'a_b' → 'a.b' 保留原名，'a_b' 是被去重的那个（warn 含其原名）
    assert.match(warnings, /"a_b" →/, '撞名 warn 要含被去重工具的原始名')
  })

  it('取证点写死：manager.warnings 存在且是字符串数组（断言不许两头落空）', async () => {
    const { manager } = makeManager([{ name: 'plain' }])
    await connectOne(manager)
    manager.getToolSet({})
    assert.ok(Array.isArray(manager.warnings), 'manager.warnings 必须是数组（M20 取证点）')
    for (const line of manager.warnings) {
      assert.equal(typeof line, 'string')
    }
  })
})

describe('M21 · builtin priority', () => {
  it('外部 db_insert_sql 与 DB_INSERT_SQL 都被跳过 + warn 各一条（含 alias）', async () => {
    const { manager } = makeManager([
      { name: 'db_insert_sql' },
      { name: 'DB_INSERT_SQL' },
      { name: 'harmless' }
    ])
    await connectOne(manager)
    const toolSet = manager.getToolSet({ builtinToolNames: ['db_insert_sql'] })
    const aliases = toolSet.openaiTools.map(item => item.function.name)
    assert.ok(!aliases.some(alias => alias.includes('db_insert_sql')),
      '外部 db_insert_sql（清洗后同名）不得注册：' + JSON.stringify(aliases))
    assert.ok(aliases.includes('mcp__srv1234__harmless'), '无关工具不受影响')
    const collideWarnings = manager.warnings.filter(line => /collides with a built-in tool/.test(line))
    assert.equal(
      collideWarnings.length,
      2,
      '大小写变体也要各 warn 一条（含 alias）：' + JSON.stringify(collideWarnings)
    )
    for (const line of collideWarnings) {
      assert.match(line, /mcp__srv1234__/, 'warn 必须含 alias')
    }
  })

  it('内置 db_insert_sql 的 function 定义与无外部时逐字符相同（toString）', async () => {
    // 以 agent-tools.js 为入口建沙箱（agent.js 不转出 agentTools）
    const { buildAgentSandbox } = require('../fixtures/agent-esm-sandbox')
    const sb = buildAgentSandbox(
      require('node:path').resolve(__dirname, '../../client/components/ai/agent-tools.js')
    )
    let agentTools
    try {
      const mod = await import(sb.url)
      agentTools = mod.agentTools
    } finally {
      sb.cleanup()
    }
    const builtinDef = agentTools.find(tool => tool.function.name === 'db_insert_sql')
    assert.ok(builtinDef, 'agentTools 里必须有 db_insert_sql')

    const withExternal = makeManager([{ name: 'db_insert_sql' }])
    await connectOne(withExternal.manager)
    const merged = withExternal.manager.getToolSet({ builtinToolNames: ['db_insert_sql'] })

    const externalDef = merged.openaiTools.find(tool => tool.function.name === 'db_insert_sql')
    assert.equal(externalDef, undefined, '外部分支不得覆盖内置')
    assert.equal(
      builtinDef.function.toString(),
      agentTools.find(tool => tool.function.name === 'db_insert_sql').function.toString(),
      '内置定义必须逐字符不变'
    )
    // 注册层跳过外部撞名项后，runTools 合并策略是 agentTools.concat(external)，
    // 内置项保持原引用（agent 面 spec 再钉引用相等）
    assert.ok(merged.openaiTools.every(item => item.function.name.startsWith('mcp__')))
  })
})

describe('M24 · routing & zero network', () => {
  it('validateArgs 失败 → invalid_tool_arguments，且 tools/call 往返为 0', async () => {
    const { manager, transport } = makeManager([{
      name: 'strict_tool',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a']
      }
    }])
    await connectOne(manager)
    const toolSet = manager.getToolSet({})
    const alias = 'mcp__srv1234__strict_tool'
    assert.ok(toolSet.meta[alias], '别名应已注册')

    const bad = await manager.callTool(alias, { a: 1 })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'invalid_tool_arguments')
    assert.equal(callCalls(transport), 0, '校验失败不得发 tools/call（零网络）')

    const missing = await manager.callTool(alias, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'invalid_tool_arguments')
    assert.equal(callCalls(transport), 0)

    const good = await manager.callTool(alias, { a: 'x', extra: 1 })
    assert.equal(good.ok, true, '未声明键必须放行（M4 宽松校验）')
    assert.equal(callCalls(transport), 1, '合法调用恰好一次往返')
  })

  it('8KiB 降级 schema 放行任意入参（M4-④ 显式钉住），且恰好一次往返', async () => {
    const { manager, transport } = makeManager([{
      name: 'huge_tool',
      inputSchema: buildHugeSchema()
    }])
    await connectOne(manager)
    const toolSet = manager.getToolSet({})
    const alias = 'mcp__srv1234__huge_tool'
    const meta = toolSet.meta[alias]
    assert.equal(meta.degraded, true, '超预算 schema 必须降级')
    assert.ok(meta.degradationNotes.length > 0, '降级原因要可读')

    const result = await manager.callTool(alias, { filter: 'anything', junk: { deep: [1, 2, 3] } })
    assert.equal(result.ok, true, `降级后必须放行并调通：${JSON.stringify(result)}`)
    assert.equal(callCalls(transport), 1)
  })
})

describe('M26 · tools/list 触发条件', () => {
  it('签名不变的 syncConfig / getToolSet 不产生新 tools/list；refreshTools（force）恰好 +1', async () => {
    const { manager, transport } = makeManager([{ name: 'echo' }])
    await connectOne(manager)
    assert.equal(listCalls(transport), 1, '会话建立时恰好一次 tools/list')

    await manager.syncConfig([{
      id: SERVER_ID,
      name: 'fake-srv',
      transport: 'stdio',
      command: 'node',
      args: ['-e', '0'],
      trust: 'ask',
      enabled: true
    }])
    manager.getToolSet({})
    assert.equal(listCalls(transport), 1, '签名不变的 syncConfig/getToolSet 不得再拉 tools/list')

    await manager.refreshTools()
    assert.equal(listCalls(transport), 2, 'force 路径恰好再拉一次')
  })

  it('门面无 force 的 getTools（幂等 syncConfig）不产生新 tools/list（index→manager 全链）', async () => {
    const { startFakeHttpServer } = require('../fixtures/fake-mcp-http-server')
    const globalState = require('../../app/lib/glob-state')
    const facade = require('../../app/mcp/client/index')
    const srv = await startFakeHttpServer({ mode: 'json' })
    try {
      resetManager()
      globalState.set('config', {
        mcpServersAI: [{
          id: 'srvhttp1',
          name: 'fake-http',
          transport: 'http',
          url: srv.url,
          trust: 'ask',
          enabled: true
        }]
      })
      await facade.mcpClientGetTools({ builtinToolNames: ['db_insert_sql'] })
      assert.equal(srv.methodCount('tools/list'), 1, '会话建立恰好一次')
      await facade.mcpClientGetTools({ builtinToolNames: ['db_insert_sql'] })
      assert.equal(srv.methodCount('tools/list'), 1, '非 force 重复调用不再拉')
      await facade.mcpClientGetTools({ builtinToolNames: ['db_insert_sql'], force: true })
      assert.equal(srv.methodCount('tools/list'), 2, 'force 恰好 +1')
      await facade.shutdownMcpClients()
    } finally {
      await srv.close()
      resetManager()
    }
  })
})

describe('M25 · per-call 超时绕钳制', () => {
  it('callTool 传 timeoutMs=150：server 级钳制值 ≥5000 被覆盖，挂死 transport ~150ms 收敛', async () => {
    const { manager, transport } = makeManager([{
      name: 'slow_tool',
      inputSchema: { type: 'object', properties: {} }
    }])
    // 挂死 tools/call：永不回包，只有 per-call 超时能救
    transport.hangMethods.add('tools/call')
    await connectOne(manager, { timeoutMs: 5000 })

    const started = Date.now()
    const res = await manager.callTool('mcp__srv1234__slow_tool', {}, { timeoutMs: 150 })
    const elapsed = Date.now() - started

    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'mcp_timeout',
      `per-call 覆盖必须生效（收敛码 mcp_timeout）：${JSON.stringify(res.error)}`)
    assert.ok(
      elapsed < 3000,
      `必须在 per-call 150ms 量级收敛（实际 ${elapsed}ms）——` +
      '若被 server 级 ≥5000 钳制值拖住，agent 循环每个挂死工具都要等 5 秒'
    )
  })

  it('不传 timeoutMs 时回落 server 级配置（默认路径不受影响）', async () => {
    const { manager, transport } = makeManager([{ name: 'slow_tool' }])
    transport.hangMethods.add('tools/call')
    await connectOne(manager, { timeoutMs: 5000 })
    const started = Date.now()
    const res = await manager.callTool('mcp__srv1234__slow_tool', {})
    const elapsed = Date.now() - started
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'mcp_timeout')
    assert.ok(elapsed >= 4500, `无覆盖时必须用 server 级 5000ms（实际 ${elapsed}ms）`)
  })
})

describe('M28 · 两层上限各司其职', () => {
  /**
   * 多台 server 各带一份工具表（全局上限要 ≥2 台 server 才触得到：
   * 单 server 会先撞 perServerTools=50，测不到 globalTools）。
   * @param {Record<string, Array<{name: string}>>} toolsById
   * @returns {{manager: McpClientManager}}
   */
  function makeMultiServerManager (toolsById) {
    const manager = new McpClientManager({
      transportFactory: (config) => new ScriptedTransport({
        tools: (toolsById[config.id] || []).map(tool => ({
          name: tool.name,
          description: 'desc ' + tool.name,
          inputSchema: { type: 'object', properties: {} }
        }))
      })
    })
    return { manager }
  }

  it('4×50=200 个外部工具 → 注册层截到 LIMITS.globalTools（import 常量），截断元数据暴露', async () => {
    const makeNames = prefix => Array.from(
      { length: LIMITS.perServerTools },
      (_, i) => ({ name: `${prefix}_${String(i).padStart(3, '0')}` })
    )
    const { manager } = makeMultiServerManager({
      srv0001: makeNames('a'),
      srv0002: makeNames('b'),
      srv0003: makeNames('c'),
      srv0004: makeNames('d')
    })
    await manager.syncConfig([
      { id: 'srv0001', name: 'srv1', transport: 'stdio', command: 'node', args: ['-e', '0'], trust: 'ask', enabled: true },
      { id: 'srv0002', name: 'srv2', transport: 'stdio', command: 'node', args: ['-e', '0'], trust: 'ask', enabled: true },
      { id: 'srv0003', name: 'srv3', transport: 'stdio', command: 'node', args: ['-e', '0'], trust: 'ask', enabled: true },
      { id: 'srv0004', name: 'srv4', transport: 'stdio', command: 'node', args: ['-e', '0'], trust: 'ask', enabled: true }
    ])
    const toolSet = manager.getToolSet({ builtinToolNames: ['db_insert_sql'] })

    assert.equal(
      toolSet.openaiTools.length,
      LIMITS.globalTools,
      `注册层必须恰好截到 LIMITS.globalTools=${LIMITS.globalTools}（实现若写死数字，改 LIMITS 就该红）`
    )
    assert.equal(
      toolSet.truncated.global,
      LIMITS.perServerTools * 4 - LIMITS.globalTools,
      '全局截断计数要暴露给 UI'
    )
    // 协议层上限只影响 toolsTruncated，不影响注册层数量
    assert.ok(MAX_LIST_PAGES > 0 && MAX_TOOLS > 0)
    assert.ok(toolSet.openaiTools.length <= MAX_TOOLS)
  })

  it('单 server 超 LIMITS.perServerTools → perServer 截断计数暴露', async () => {
    const tools = Array.from({ length: LIMITS.perServerTools + 10 }, (_, i) => ({ name: `tool_${String(i).padStart(3, '0')}` }))
    const { manager } = makeManager(tools)
    await connectOne(manager)
    const toolSet = manager.getToolSet({})
    assert.equal(toolSet.openaiTools.length, LIMITS.perServerTools)
    assert.equal(toolSet.truncated.perServer, 10, 'perServer 截断要暴露：' + JSON.stringify(toolSet.truncated))
  })
})
