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
    callToolResult: opts.callToolResult || null,
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
    getLangName: () => 'english',
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
        world.providerRequests.push({ messages: args[0], tools: args[6] })
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

beforeEach(() => {
  resetManager()
})
