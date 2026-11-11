/**
 * T03 批次二 · agent 面（runAgentLoop 直测，agent ESM 沙箱 + 假 world）。
 *
 * 与 mcp-toolset-limits.spec.js（manager 直测）互补：那份钉「注册层产出什么」，
 * 这份钉「run 循环把什么交到 provider 手上」。
 *
 * 覆盖：
 * - M22 run 级冻结：
 *   ① 无外部工具时 runTools 是 `agentTools` **原引用**（provider 收到的数组
 *     `===` 沙箱内同一模块实例的 agentTools —— concat/slice 都会红）；
 *   ② 有外部时整个 run 的所有 provider 请求收到**同一个**合并数组（三轮
 *     同引用），且恰好在 run 开始取数一次（`store.mcpClientGetTools` 调用
 *     计数 === 1，run 中途换掉它的返回值也不产生第二次取数）；
 *   ③ 内置项按引用进入合并数组（不是复制品）。
 * - M20/M21 agent 面：runTools 经**真 McpClientManager**（ScriptedTransport）
 *   产出 —— 外部别名全部满足 §2.5 契约（mcp__ 前缀/小写/≤64）、外部提供的
 *   `db_insert_sql` 被 manager 跳过（provider 永远看不到第二个 db_insert_sql，
 *   合并进 runTools 的 db_insert_sql 与内置**同一引用**）、撞名 warn 落在
 *   manager.warnings（M20 取证点，lead 2026-11-10 批准）。
 *
 * 加载方式：`fixtures/agent-esm-sandbox.js` 拷贝 agent.js 的 import 闭包到
 * `node_modules/.cache/`（裸包名 nanoid 依赖仓库 node_modules 逐级解析），
 * 补 `.js` specifier 后动态 import。**同一次沙箱**里再 import 沙箱目录内的
 * agent-tools.js URL —— Node 按 URL 缓存模块，拿到的是 runAgentLoop 实际
 * 引用的同一个模块实例，`agentTools` 的引用比较才成立。换一次沙箱引用就断，
 * 这是本文件所有 `===` 断言的前提。
 */

const { describe, it, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { buildAgentSandbox } = require('../fixtures/agent-esm-sandbox')
const { McpClientManager, resetManager } = require('../../app/mcp/client/manager')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')

const SERVER_ID = 'srv1234'

/**
 * 沙箱加载 agent.js（runAgentLoop）+ 同实例的 agent-tools.js（agentTools）。
 * @returns {Promise<{mod: object, toolsMod: object, cleanup: Function}>}
 */
async function loadAgent () {
  const sb = buildAgentSandbox()
  const mod = await import(sb.url)
  const toolsUrl = pathToFileURL(
    // 沙箱目录布局以 src/ 为根（fixture 的 repoRoot 是 src/）
    path.join(sb.dir, 'client/components/ai/agent-tools.js')
  ).href
  const toolsMod = await import(toolsUrl)
  // 同实例的 ai-context：M23 要拿 runAgentLoop 实际用的 estimateToolsTokens /
  // CHARS_PER_TOKEN_VALUE（换一次沙箱引用就断，禁字面量系数也靠它）
  const ctxUrl = pathToFileURL(
    path.join(sb.dir, 'client/components/ai/ai-context.js')
  ).href
  const ctxMod = await import(ctxUrl)
  return { mod, toolsMod, ctxMod, cleanup: sb.cleanup }
}

const emptyToolSet = () => ({
  tools: [],
  meta: {},
  servers: [],
  truncated: { perServer: 0, global: 0 }
})

/**
 * 假 world：window 桩 + provider 脚本。
 *
 * - `window.pre.runGlobalAsync('AIchatWithTools', ...)`：记录每次请求
 *   （messages + tools —— tools 是第 7 个实参，见 agent.js 的
 *   callBackendAIchatWithTools），按 providerScript 队列出响应；脚本项可为
 *   函数（收到 requests 数组，可做 run 中途的状态翻转）。
 * - `store.mcpClientGetTools`：buildRunToolset 的取数点，返回
 *   `world.getToolsResult`（每次调用现读属性，测试可中途替换）；计数记在
 *   `world.getToolsCalls`，入参记在 `world.getToolsOpts`。
 * - `store.mcpClientCallTool`：executeToolCall 外部分支的落点，记录调用并
 *   返回 `{ok:true, text}`。
 * @param {object} [opts]
 * @returns {object} world
 */
function makeWorld (opts = {}) {
  const world = {
    getToolsCalls: 0,
    getToolsOpts: null,
    getToolsResult: opts.getToolsResult || emptyToolSet(),
    callToolCalls: [],
    approvalCalls: [],
    callToolResult: opts.callToolResult || null,
    hangingCalls: [],
    cancelRunCalls: [],
    providerRequests: [],
    providerScript: opts.providerScript || [],
    entries: [],
    chatEntry: { id: 'entry-t03', prompt: 'do the thing', images: [] },
    config: { languageAI: 'en', roleAI: '', modelAI: 'test-model' }
  }
  const store = {
    config: { contextLengthAI: 128000 },
    aiAutoCompress: false,
    agentRunning: false,
    // T04 生命周期字段（与 init-state.js 对齐；本文件只读不断言）
    agentTainted: false,
    agentTaintedServer: '',
    agentTaintedTool: '',
    aiMcpTaintLog: [],
    getLangName: () => 'english',
    // T04 统一审批门的落点：默认放行并记账——本文件只测 run 循环本身
    // （M22/M25/M27/M30），审批语义（计数 0/1、taint 门、取消态）由
    // agent-taint.spec.js 与 mcp-client-approval.spec.js 钉
    mcpClientRequestApproval: async (toolName, meta, decision) => {
      world.approvalCalls.push({ toolName, decision })
      return { approved: true, requireApproval: true }
    },
    updateAiHistoryEntry: (id, updates) => {
      world.entries.push({ id, updates })
      Object.assign(world.chatEntry, updates)
    },
    mcpClientGetTools: async (callOpts = {}) => {
      world.getToolsCalls++
      world.getToolsOpts = callOpts
      return world.getToolsResult
    },
    mcpClientCallTool: async (alias, args, callOpts = {}) => {
      world.callToolCalls.push({ alias, args, opts: callOpts })
      if (world.callToolResult) {
        return world.callToolResult
      }
      return { ok: true, text: 'external result for ' + alias }
    },
    // M30 agent 级：cancelRun 记账；挂起模式的调用由 cancelRun 亲自收敛
    // （真实 store 里就是 pendingByRun 注册表 → settle mcp_aborted）
    mcpClientCancelRun: async (runId) => {
      world.cancelRunCalls.push(runId)
      for (const resolve of world.hangingCalls.splice(0)) {
        resolve({
          ok: false,
          error: { code: 'mcp_aborted', message: 'external tool call aborted (agent run stopped)' }
        })
      }
      return { ok: true, settled: world.callToolCalls.length }
    }
  }
  if (opts.callToolMode === 'hang') {
    // 挂起模式：callTool 返回不落定 promise，resolver 交给 world.hangingCalls
    store.mcpClientCallTool = async (alias, args, callOpts = {}) => {
      world.callToolCalls.push({ alias, args, opts: callOpts })
      return new Promise(resolve => {
        world.hangingCalls.push(resolve)
      })
    }
  }
  // aiContextInfo 用访问器记账：runAgentLoop 的 finally 会把它清成 null，
  // 测试要能看到 run 期间最后一次 publishContext 的值（M23）
  world.lastContextInfo = null
  let currentContextInfo = null
  Object.defineProperty(store, 'aiContextInfo', {
    enumerable: true,
    get: () => currentContextInfo,
    set: value => {
      currentContextInfo = value
      if (value) {
        world.lastContextInfo = value
      }
    }
  })
  const pre = {
    runGlobalAsync: async (name, ...args) => {
      if (name === 'AIchatWithTools') {
        // messages 是活引用（响应后 runAgentLoop 还会 push），快照冻结请求时点
        world.providerRequests.push({ messages: [...args[0]], tools: args[6] })
        const next = world.providerScript.shift()
        if (next === undefined) {
          throw new Error('provider script exhausted at request #' +
            world.providerRequests.length)
        }
        return typeof next === 'function' ? next(world.providerRequests) : next
      }
      throw new Error('unexpected runGlobalAsync: ' + name)
    }
  }
  world.window = { et: {}, store, pre }
  return world
}

// 每个用例各建一次沙箱（模块实例互不影响），after 里统一收尾由用例自己
// finally —— 这里只清 globalThis.window，不留桩给同进程其它 spec。
after(() => {
  delete globalThis.window
})

describe('M22 · run 级冻结（runAgentLoop 直测）', () => {
  it('无外部工具：provider 收到的 tools 是 agentTools 原引用（M10 硬门），取数恰一次', async () => {
    const { mod, toolsMod, cleanup } = await loadAgent()
    const world = makeWorld({
      providerScript: [
        { message: { role: 'assistant', content: 'plain answer' } }
      ]
    })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      assert.equal(world.providerRequests.length, 1)
      assert.equal(
        world.getToolsCalls, 1,
        'buildRunToolset 必须恰好在 run 开始取数一次'
      )
      assert.deepEqual(
        world.getToolsOpts.builtinToolNames, toolsMod.agentToolNames,
        '取数必须传沙箱同一模块实例的 agentToolNames（内置优先名单不能是另一份拷贝）'
      )
      // 硬门：无外部工具不得 concat/slice —— provider 手上的数组与内置数组
      // 同一引用。改实现为 `agentTools.concat([])` 之类的"等价拷贝"这里必红。
      assert.equal(
        world.providerRequests[0].tools, toolsMod.agentTools,
        '无外部工具时 runTools 必须是 agentTools 原引用（不许无谓拷贝）'
      )
    } finally {
      cleanup()
    }
  })

  it('有外部工具：三轮 provider 请求的 tools 同一引用；run 中途换掉 getTools 返回值不影响', async () => {
    const { mod, toolsMod, cleanup } = await loadAgent()
    const alias = 'mcp__srv1234__ext_read'
    const world = makeWorld({
      getToolsResult: {
        tools: [{
          type: 'function',
          function: { name: alias, description: 'external read', parameters: { type: 'object', properties: {} } }
        }],
        meta: { [alias]: { serverName: 'fake-srv', originalName: 'ext_read' } },
        servers: [],
        truncated: { perServer: 0, global: 0 }
      },
      // 第 1 轮响应是函数：趁 run 进行中把取数点的返回值整个换掉 ——
      // 冻结的正确实现不会再取数，第 2/3 轮 tools 不受影响。
      providerScript: [
        requests => {
          world.getToolsResult = {
            tools: [{
              type: 'function',
              function: { name: 'mcp__srv1234__other', description: 'x', parameters: { type: 'object', properties: {} } }
            }],
            meta: {},
            servers: [],
            truncated: { perServer: 0, global: 0 }
          }
          return {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', function: { name: alias, arguments: '{}' } }]
            },
            usage: { promptTokens: 10 }
          }
        },
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c2', function: { name: alias, arguments: '{"x":1}' } }]
          }
        },
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      assert.equal(world.providerRequests.length, 3)
      assert.equal(
        world.getToolsCalls, 1,
        'run 中途换掉取数点返回值也不许产生第二次取数（M22 冻结）'
      )
      const first = world.providerRequests[0].tools
      assert.equal(world.providerRequests[1].tools, first, '第 2 轮 tools 必须与第 1 轮同引用')
      assert.equal(world.providerRequests[2].tools, first, '第 3 轮 tools 必须与第 1 轮同引用')
      // 合并数组是 concat 拷贝，但内置项按引用进入、外部项追加在尾部
      assert.equal(first.length, toolsMod.agentTools.length + 1)
      for (const builtin of toolsMod.agentTools) {
        assert.ok(first.includes(builtin), `内置 ${builtin.function.name} 必须按引用进入 runTools`)
      }
      assert.equal(first[first.length - 1].function.name, alias, '外部工具追加在尾部')
      assert.equal(world.callToolCalls.length, 2, '两轮 tool_calls 都经 executeToolCall 外部分支')
      assert.equal(world.callToolCalls[0].alias, alias)
    } finally {
      cleanup()
    }
  })
})

describe('M20/M21 · agent 面（runAgentLoop × 真 manager）', () => {
  /**
   * 真 manager（ScriptedTransport 假 server）+ 把 getToolSet 包成
   * store.mcpClientGetTools 的形状（index.js 门面在真实链路里做同样映射）。
   * @param {Array<{name: string}>} tools 假 server 的工具表
   * @returns {Promise<{manager: McpClientManager, getToolSet: Function}>}
   */
  async function makeRealManager (tools) {
    const transport = new ScriptedTransport({
      tools: tools.map(tool => ({
        name: tool.name,
        description: 'desc ' + tool.name,
        inputSchema: { type: 'object', properties: {} }
      }))
    })
    const manager = new McpClientManager({ transportFactory: () => transport })
    await manager.syncConfig([{
      id: SERVER_ID,
      name: 'fake-srv',
      transport: 'stdio',
      command: 'node',
      args: ['-e', '0'],
      trust: 'ask',
      enabled: true
    }])
    return { manager }
  }

  it('外部提供 db_insert_sql：provider 看不到第二个 db_insert_sql，合并的是内置原引用 + warn 取证', async () => {
    const { mod, toolsMod, cleanup } = await loadAgent()
    const { manager } = await makeRealManager([
      { name: 'db_insert_sql' },
      { name: 'ext_ok' }
    ])
    const world = makeWorld({
      providerScript: [
        { message: { role: 'assistant', content: 'ok, noted' } }
      ]
    })
    // 模拟 index.js 门面：getToolSet → {tools, meta}
    world.window.store.mcpClientGetTools = async (opts = {}) => {
      world.getToolsCalls++
      world.getToolsOpts = opts
      const toolSet = manager.getToolSet({
        builtinToolNames: opts.builtinToolNames || []
      })
      return {
        tools: toolSet.openaiTools,
        meta: toolSet.meta,
        servers: [],
        truncated: toolSet.truncated
      }
    }
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      const runTools = world.providerRequests[0].tools
      const names = runTools.map(tool => tool && tool.function && tool.function.name)
      assert.ok(names.includes('mcp__srv1234__ext_ok'),
        '无关外部工具正常注册：' + JSON.stringify(names))
      assert.equal(
        names.filter(name => name === 'db_insert_sql').length, 1,
        '内置 db_insert_sql 必须恰好出现一次：' + JSON.stringify(names)
      )
      assert.ok(!names.includes('mcp__srv1234__db_insert_sql'),
        '外部 db_insert_sql 不得注册（内置优先）：' + JSON.stringify(names))
      const builtinDef = toolsMod.agentTools.find(t => t.function.name === 'db_insert_sql')
      assert.equal(
        runTools.find(t => t.function.name === 'db_insert_sql'), builtinDef,
        'runTools 里的 db_insert_sql 必须是内置定义原引用（不是复制品）'
      )
      // M20 取证点（lead 批准：manager.warnings）
      assert.match(
        manager.warnings.join('\n'),
        /collides with a built-in tool[\s\S]*mcp__srv1234__db_insert_sql/,
        '撞名 warn 必须落在 manager.warnings 且含 alias'
      )
    } finally {
      cleanup()
    }
  })

  it('provider 看到的全部外部别名满足 §2.5 契约（前缀/小写/长度/字符集）', async () => {
    const { mod, toolsMod, cleanup } = await loadAgent()
    const longName = 'very_long_tool_name_' + 'y'.repeat(60)
    const { manager } = await makeRealManager([
      { name: 'a.b' }, // 清洗成 a_b
      { name: longName }, // 超长 → 截断 + 短哈希
      { name: 'ext_ok' }
    ])
    const world = makeWorld({
      providerScript: [
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    world.window.store.mcpClientGetTools = async (opts = {}) => {
      world.getToolsCalls++
      const toolSet = manager.getToolSet({
        builtinToolNames: opts.builtinToolNames || []
      })
      return { tools: toolSet.openaiTools, meta: toolSet.meta, servers: [], truncated: toolSet.truncated }
    }
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      const names = world.providerRequests[0].tools
        .map(tool => tool && tool.function && tool.function.name)
      const external = names.filter(name => name.startsWith('mcp__'))
      assert.ok(external.length >= 3, '三台工具都要注册：' + JSON.stringify(names))
      assert.ok(external.includes('mcp__srv1234__a_b'), '清洗名进 provider 视野')
      for (const alias of external) {
        assert.ok(alias.length <= 64, `${alias} 超过 64 上限`)
        assert.equal(alias, alias.toLowerCase(), '别名必须全小写')
        assert.match(alias, /^mcp__[a-z0-9_-]+__[a-z0-9_-]+(_\d+)?$/)
      }
      assert.ok(
        names.every(name => !/^mcp__/.test(name) || !toolsMod.agentToolNames.includes(name)),
        '外部别名不得与任何内置名重合（前缀隔离 + 内置优先）'
      )
    } finally {
      cleanup()
    }
  })
})

describe('M23 · publishContext 用 runTools 估算工具 token（S3）', () => {
  it('外部 schema 计入 toolsTokens，增量 ≥ floor(B / CHARS_PER_TOKEN_VALUE)（系数 import 常量）', async () => {
    const { mod, toolsMod, ctxMod, cleanup } = await loadAgent()
    const alias = 'mcp__srv1234__ext_read'
    const external = [{
      type: 'function',
      function: { name: alias, description: 'x'.repeat(200), parameters: { type: 'object', properties: {} } }
    }]
    const B = JSON.stringify(external).length
    const world = makeWorld({
      getToolsResult: {
        tools: external,
        meta: { [alias]: { serverName: 'fake-srv', originalName: 'ext_read' } },
        servers: [],
        truncated: { perServer: 0, global: 0 }
      },
      providerScript: [
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      const info = world.lastContextInfo
      assert.ok(info, 'run 期间 publishContext 必须写入 aiContextInfo')
      // 硬等式：面板看到的 toolsTokens 就是这次 run 的 runTools 估算值
      // （继续硬编码 agentTools 会低估外部工具的真实开销 —— 判据钉这一条）
      assert.equal(
        info.toolsTokens,
        ctxMod.estimateToolsTokens(world.providerRequests[0].tools),
        'toolsTokens 必须等于对 runTools 的估算（不许用模块级 agentTools）'
      )
      // 公式化下界：纯 ASCII 下每个字符的 token 估价不高于 1/CHARS_PER_TOKEN，
      // 外部工具带来的增量必须 ≥ floor(B / CHARS_PER_TOKEN_VALUE)。系数取自
      // 沙箱同一模块实例的导出常量，实现里写死 3.5 或改成别的数这里会红。
      const baseline = ctxMod.estimateToolsTokens(toolsMod.agentTools)
      const delta = info.toolsTokens - baseline
      const floor = Math.floor(B / ctxMod.CHARS_PER_TOKEN_VALUE)
      assert.ok(
        delta >= floor,
        `toolsTokens 增量 ${delta} 必须 ≥ floor(${B} / CHARS_PER_TOKEN_VALUE)=${floor}`
      )
    } finally {
      cleanup()
    }
  })
})

describe('M25 · agent 面：外部工具失败 → 结构化错误 + server 名', () => {
  it('store 返回 {ok:false} → toolCalls 记录 JSON {error}，message 补 (server "<name>")', async () => {
    const { mod, cleanup } = await loadAgent()
    const alias = 'mcp__srv1234__ext_read'
    const meta = { [alias]: { serverName: 'fake-srv', originalName: 'ext_read' } }
    const world = makeWorld({
      getToolsResult: {
        tools: [{ type: 'function', function: { name: alias, description: 'x', parameters: { type: 'object', properties: {} } } }],
        meta,
        servers: [],
        truncated: { perServer: 0, global: 0 }
      },
      // executeToolCall 失败路径读 store.mcpExternalToolMeta 取 server 名
      callToolResult: {
        ok: false,
        error: { code: 'mcp_timeout', message: 'MCP tool call did not finish within 5000 ms' }
      },
      providerScript: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', function: { name: alias, arguments: '{}' } }]
          }
        },
        { message: { role: 'assistant', content: 'got it, moving on' } }
      ]
    })
    world.window.store.mcpExternalToolMeta = meta
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)

      const card = world.chatEntry.toolCalls[0]
      assert.ok(card, 'tool call 卡片必须被记录')
      assert.equal(card.status, 'completed',
        'executeToolCall 永不 throw：失败也按 completed 收敛（结果本身是 JSON error）')
      const parsed = JSON.parse(card.result)
      assert.equal(parsed.error.code, 'mcp_timeout')
      assert.ok(
        parsed.error.message.includes('(server "fake-srv")'),
        `错误文案必须补 server 名：${parsed.error.message}`
      )
      assert.equal(world.callToolCalls[0].alias, alias)
      // 失败不得中断 run：第 2 轮照常发出（provider 收到 tool 结果消息）
      assert.equal(world.providerRequests.length, 2)
    } finally {
      cleanup()
    }
  })
})

describe('M27 · 边界包装（agent 面）', () => {
  it('外部工具结果包进 untrusted 块，server/tool 属性取 meta（主进程校验过 config.name）', async () => {
    const { mod, cleanup } = await loadAgent()
    const alias = 'mcp__srv1234__ext_read'
    const world = makeWorld({
      getToolsResult: {
        tools: [{ type: 'function', function: { name: alias, description: 'x', parameters: { type: 'object', properties: {} } } }],
        // 取值来源判据：meta.serverName 是主进程校验过的 config.name（'fake-srv'）；
        // 这里故意放一个不同的 serverInfo.name，实现若错取它就会红
        meta: { [alias]: { serverName: 'fake-srv', originalName: 'ext_read', serverInfo: { name: 'evil-self-reported' } } },
        servers: [],
        truncated: { perServer: 0, global: 0 }
      },
      callToolResult: { ok: true, text: 'SECRET-DATA' },
      providerScript: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', function: { name: alias, arguments: '{}' } }]
          }
        },
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)
      assert.equal(world.providerRequests.length, 2)

      const toolMsg = world.providerRequests[1].messages
        .find(msg => msg && msg.role === 'tool' && msg.tool_call_id === 'c1')
      assert.ok(toolMsg, '第 2 轮请求必须携带外部工具结果消息')
      assert.ok(
        toolMsg.content.startsWith('<untrusted-tool-result server="fake-srv" tool="ext_read">'),
        `包装块开头必须带 meta 来源的 server/tool 属性：${String(toolMsg.content).slice(0, 120)}`
      )
      assert.ok(toolMsg.content.includes('SECRET-DATA'), '结果正文必须还在块里')
      assert.ok(toolMsg.content.endsWith('</untrusted-tool-result>'), '包装块必须闭合')
      assert.ok(
        !toolMsg.content.includes('evil-self-reported'),
        'server 属性不许取 server 自报的 serverInfo.name（SEC-1 取值来源钉死 meta.serverName）'
      )
    } finally {
      cleanup()
    }
  })

  it('hasExternal=false：任何结果都不包装——内置原样透传，幻觉出的外部别名也不包', async () => {
    const { mod, cleanup } = await loadAgent()
    const world = makeWorld({
      providerScript: [
        {
          message: {
            role: 'assistant',
            content: '',
            // 幻觉：provider 未声明就调了外部别名——路由仍会走外部分支，
            // 但本次 run 没有外部工具，包装函数必须一次都不执行（M10 第 7 条）
            tool_calls: [
              { id: 'b1', function: { name: 'db_insert_sql', arguments: '{"sql":"select 1"}' } },
              { id: 'b2', function: { name: 'mcp__srv1234__hallucinated', arguments: '{}' } }
            ]
          }
        },
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    // 内置 db_insert_sql 走 executeToolCall 内置分支 → store.mcpDbInsertSql
    world.window.store.mcpDbInsertSql = (args) => ({ ok: true, echoed: args.sql })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(world.chatEntry, world.config, { current: false }, () => {}, null)
      const msgs = world.providerRequests[1].messages

      const builtinMsg = msgs.find(msg => msg && msg.role === 'tool' && msg.tool_call_id === 'b1')
      assert.ok(builtinMsg, '内置工具结果也要进 messages')
      assert.ok(
        !builtinMsg.content.includes('<untrusted-tool-result'),
        `无外部工具时不得包装（M10 第 7 条）：${String(builtinMsg.content).slice(0, 120)}`
      )
      assert.deepEqual(JSON.parse(builtinMsg.content), { ok: true, echoed: 'select 1' },
        '内置结果保持 JSON 原样')

      const ghostMsg = msgs.find(msg => msg && msg.role === 'tool' && msg.tool_call_id === 'b2')
      assert.ok(ghostMsg, '幻觉别名调用也要有结果消息（provider 需要一条 tool 结果才能继续）')
      assert.ok(
        !ghostMsg.content.includes('<untrusted-tool-result'),
        `无外部 run 里连幻觉别名的结果也不得包进 untrusted 块（包装零次）：${String(ghostMsg.content).slice(0, 120)}`
      )
    } finally {
      cleanup()
    }
  })
})

describe('M29 · 历史回放降级（stale 外部别名）', () => {
  it('指向已消失别名的历史 tool_call 改占位名 + 占位结果；非 stale 消息保持原引用', async () => {
    const { mod, cleanup } = await loadAgent()
    // 工具集为空 → declaredNames 只含内置名 → 历史里的外部别名全是 stale
    const staleCallMsg = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'old-1', function: { name: 'mcp__srv1234__gone', arguments: '{"q":1}' } },
        { id: 'old-2', function: { name: 'list_tabs', arguments: '{}' } }
      ]
    }
    const staleToolMsg = { role: 'tool', tool_call_id: 'old-1', content: 'old result' }
    const builtinToolMsg = { role: 'tool', tool_call_id: 'old-2', content: '[]' }
    const userMsg = { role: 'user', content: 'continue' }
    const world = makeWorld({
      providerScript: [
        { message: { role: 'assistant', content: 'done' } }
      ]
    })
    globalThis.window = world.window
    try {
      await mod.runAgentLoop(
        world.chatEntry, world.config, { current: false }, () => {},
        [staleCallMsg, staleToolMsg, builtinToolMsg, userMsg]
      )
      assert.equal(world.providerRequests.length, 1)
      const sent = world.providerRequests[0].messages
      // 消息结构：system + 全部 4 条历史（buildAgentMessages 过滤 system）
      assert.equal(sent[0].role, 'system')
      assert.equal(sent.length, 5, `system + 4 条历史：${sent.length}`)

      const callMsg = sent[1]
      assert.notEqual(callMsg, staleCallMsg, '含 stale 项的消息必须浅拷贝替换')
      assert.equal(callMsg.tool_calls[0].function.name, 'removed_external_tool',
        'stale 别名改占位名（provider 不会收到未声明工具名）')
      assert.equal(callMsg.tool_calls[0].function.arguments, '{"q":1}', 'arguments 保留')
      assert.equal(callMsg.tool_calls[1].function.name, 'list_tabs', '内置调用不受影响')
      assert.equal(callMsg.tool_calls[1], staleCallMsg.tool_calls[1], '非 stale tool_call 保持原引用')

      const tool1 = sent.find(msg => msg.role === 'tool' && msg.tool_call_id === 'old-1')
      assert.notEqual(tool1, staleToolMsg)
      assert.equal(tool1.content, 'tool no longer available: mcp__srv1234__gone',
        '占位结果正文（M29）')
      const tool2 = sent.find(msg => msg.role === 'tool' && msg.tool_call_id === 'old-2')
      assert.equal(tool2, builtinToolMsg, '非 stale 的 tool 消息保持原引用')
      assert.equal(sent.find(msg => msg === userMsg), userMsg, '无关消息保持原引用')
    } finally {
      cleanup()
    }
  })
})

describe('M30 · 取消收敛（agent 级）', () => {
  it('stopAgentRun：挂起的外部调用收敛、runId 接线正确、runAbort 真的 abort、run 正常收尾', async () => {
    const { mod, cleanup } = await loadAgent()
    const alias = 'mcp__srv1234__ext_read'
    const world = makeWorld({
      callToolMode: 'hang',
      getToolsResult: {
        tools: [{ type: 'function', function: { name: alias, description: 'x', parameters: { type: 'object', properties: {} } } }],
        meta: { [alias]: { serverName: 'fake-srv', originalName: 'ext_read' } },
        servers: [],
        truncated: { perServer: 0, global: 0 }
      },
      providerScript: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', function: { name: alias, arguments: '{}' } }]
          }
        },
        { message: { role: 'assistant', content: 'should never be read' } }
      ]
    })
    globalThis.window = world.window
    const abortRef = { current: false }
    try {
      // 与 3s 死线竞速：变异「stop 只置位不 abort」会让 run 永不收敛，
      // 用这条死线把挂死变成红，而不是拖死整个测试管线
      const DEADLINE_MS = 3000
      const runPromise = Promise.race([
        mod.runAgentLoop(world.chatEntry, world.config, abortRef, () => {}, null),
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error(
            `runAgentLoop ${DEADLINE_MS}ms 内未收敛——stopAgentRun 后挂起的外部调用没有被收敛（M30 变异形态：只置位 abortRef.current）`
          )), DEADLINE_MS)
        })
      ])

      // 等 callTool 真的挂起
      for (let waited = 0; world.hangingCalls.length === 0 && waited < DEADLINE_MS; waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(world.hangingCalls.length, 1, '外部调用必须已经挂起')

      await mod.stopAgentRun(abortRef)
      await runPromise

      assert.equal(abortRef.current, true)
      assert.equal(world.cancelRunCalls.length, 1, 'stopAgentRun 必须按 runId 通知取消')
      assert.ok(
        typeof world.cancelRunCalls[0] === 'string' && world.cancelRunCalls[0].length > 0,
        'cancelRun 的 runId 必须来自 abortRef.runId（run 级接线）'
      )
      assert.equal(world.callToolCalls[0].opts.signal.aborted, true,
        'runAbort（M30 run 级 AbortController）必须真的 abort，signal 传到了调用点')
      assert.ok(
        world.chatEntry.response.includes('Agent stopped by user'),
        `run 要按 stopped 收尾：${world.chatEntry.response}`
      )
      assert.equal(world.window.store.agentRunning, false, 'run 收敛后释放 agentRunning')
      assert.equal(world.providerRequests.length, 1, '中止后不得把挂起轮的响应再喂进循环')
    } finally {
      cleanup()
    }
  })
})

beforeEach(() => {
  resetManager()
})
