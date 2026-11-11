/**
 * M10 基线锚点（T03 配套）· 内置工具 36 锁 + 别名前缀契约 + 边界块包装形状。
 *
 * 三件事，全是指向「将来谁改坏了别让它绿着」的护栏：
 *   1. `agentTools` 恰好 36 个（设计 §1-S6：36 项工具 ↔ 36 个 case），名字
 *      全部 `[a-z0-9_]`、不重复、没有一个以 `mcp__` 开头（S7：前缀隔离是
 *      executeToolCall 外部分支的唯一路由依据）；
 *   2. `executeToolCall` 的 switch 对 36 个名字逐个有 case（源码文本断言）；
 *   3. 渲染层 `external-tool-guard.js` 的前缀与主进程 `tool-name.js` 的
 *      `PREFIX` 一致 —— 任何一边单独改前缀，别名就路由不进外部分支。
 *
 * 加载方式：agent-tools.js 是渲染层 ESM 且 import 不带扩展名，Node 直连会
 * ERR_MODULE_NOT_FOUND —— 用 `agent-esm-sandbox` 夹具（拷贝闭包 + 补 .js）。
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildAgentSandbox } = require('../fixtures/agent-esm-sandbox')

const ROOT = path.join(__dirname, '..', '..')
const AGENT_TOOLS = path.join(ROOT, 'client/components/ai/agent-tools.js')
const TOOL_NAME = path.join(ROOT, 'app/mcp/client/tool-name.js')
const GUARD = path.join(ROOT, 'client/common/external-tool-guard.js')

// F1（判据文档 §0）：内置工具 36 个，这是 M10 基线的数字
const BUILTIN_COUNT = 36

let mod = null
let sandbox = null
let toolsSandbox = null

before(async () => {
  sandbox = buildAgentSandbox()
  mod = await import(sandbox.url)
  // agent.js 不转出 agentTools —— 以 agent-tools.js 为入口再建一个沙箱
  toolsSandbox = buildAgentSandbox(AGENT_TOOLS)
  mod = await import(toolsSandbox.url)
})

after(() => {
  if (sandbox) {
    sandbox.cleanup()
  }
  if (toolsSandbox) {
    toolsSandbox.cleanup()
  }
})

describe('builtin tool baseline (M10 / F1)', () => {
  it('agentTools 恰好 36 个，agentToolNames 与之一一对应', () => {
    const { agentTools, agentToolNames } = mod
    assert.equal(agentTools.length, BUILTIN_COUNT, `内置工具数从 ${BUILTIN_COUNT} 漂了`)
    assert.equal(agentToolNames.length, BUILTIN_COUNT)
    assert.deepEqual(
      agentToolNames,
      agentTools.map(tool => tool.function.name),
      'agentToolNames 必须与 agentTools 的名字一一对应'
    )
  })

  it('36 个名字全部 [a-z0-9_]、唯一、且不以 mcp__ 开头（S7）', () => {
    const names = mod.agentToolNames
    assert.equal(new Set(names).size, BUILTIN_COUNT, '内置工具名出现重复')
    for (const name of names) {
      assert.match(name, /^[a-z0-9_]+$/, `内置工具名 ${name} 含非法字符`)
      assert.ok(!name.startsWith('mcp__'), `内置工具名 ${name} 侵入了外部别名前缀`)
    }
  })

  it('executeToolCall 对 36 个名字逐个有 case（源码文本断言）', () => {
    const source = fs.readFileSync(AGENT_TOOLS, 'utf8')
    const missing = mod.agentToolNames.filter(name => !source.includes(`case '${name}'`))
    assert.deepEqual(
      missing,
      [],
      `executeToolCall 缺少这些内置 case（工具加了、实现没加，模型会拿到 Unknown agent tool）：${missing.join(', ')}`
    )
  })

  it('渲染层前缀常量与主进程 tool-name.js 的 PREFIX 一致', () => {
    const toolNameSource = fs.readFileSync(TOOL_NAME, 'utf8')
    const guardSource = fs.readFileSync(GUARD, 'utf8')
    const mainMatch = toolNameSource.match(/const PREFIX = '([^']+)'/)
    const rendererMatch = guardSource.match(/const EXTERNAL_TOOL_PREFIX = '([^']+)'/)
    assert.ok(mainMatch, 'tool-name.js 的 PREFIX 常量被改名/删除')
    assert.ok(rendererMatch, 'external-tool-guard.js 的 EXTERNAL_TOOL_PREFIX 常量被改名/删除')
    assert.equal(
      rendererMatch[1],
      mainMatch[1],
      `两边前缀不一致：渲染层 ${rendererMatch[1]} vs 主进程 ${mainMatch[1]} —— executeToolCall 会路由不到外部工具`
    )
  })

  it('isExternalAlias 行为：mcp__ 前缀才判定为外部', async () => {
    const guardUrl = sandbox.url.replace('components/ai/agent.js', 'common/external-tool-guard.js')
    const guard = await import(guardUrl)
    assert.equal(guard.isExternalAlias('mcp__a1b2c3d__echo'), true)
    assert.equal(guard.isExternalAlias('db_insert_sql'), false)
    assert.equal(guard.isExternalAlias('mcp_'), false)
    assert.equal(guard.isExternalAlias(''), false)
    assert.equal(guard.isExternalAlias(null), false)
    assert.equal(guard.isExternalAlias(42), false)
  })
})

describe('untrusted-block wrap shape (M27 配套)', () => {
  it('wrapUntrusted 产出 <untrusted-tool-result server/tool> 结构', async () => {
    const blockUrl = sandbox.url.replace('components/ai/agent.js', 'common/untrusted-block.js')
    const block = await import(blockUrl)
    const wrapped = block.wrapUntrusted('hello', {
      serverLabel: 'fs-server',
      toolName: 'read_file'
    })
    assert.equal(
      wrapped,
      '<untrusted-tool-result server="fs-server" tool="read_file">\nhello\n</untrusted-tool-result>'
    )
    // T03 故意不转义（消毒是 T04 SEC-1）：这里钉住"包装层现在是什么样"，
    // T04 落地消毒时**由 T04 的 spec 钉消毒行为**，两边不会互相顶掉
    const raw = block.wrapUntrusted('a"b', { serverLabel: 'x', toolName: 'y' })
    assert.ok(raw.includes('a"b'), 'T03 包装层保持原样透传（消毒归 T04）')
  })

  it('truncateResult 超预算截断并留痕，未超预算原样返回', async () => {
    const blockUrl = sandbox.url.replace('components/ai/agent.js', 'common/untrusted-block.js')
    const block = await import(blockUrl)
    const small = block.truncateResult('abc')
    assert.equal(small, 'abc')
    const big = block.truncateResult('x'.repeat(200), 100)
    assert.ok(big.startsWith('x'))
    assert.match(big, /\n…\[truncated \d+ bytes\]$/, '截断必须留痕，模型要知道文本不完整')
  })
})
