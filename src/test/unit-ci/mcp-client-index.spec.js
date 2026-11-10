/**
 * MCP client · IPC 门面（T01 判据 ② + 「永不 throw」契约）。
 *
 * 门面是渲染层唯一能碰到的表面，所以它的契约是：**任何入参、任何内部异常都
 * 返回结构化对象**。`ipcRenderer.invoke` 的 reject 在渲染层显示为
 * "Error invoking remote method"，对用户和模型都没有信息量。
 */

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const globalState = require('../../app/lib/glob-state')
const facade = require('../../app/mcp/client/index')
const { resetManager } = require('../../app/mcp/client/manager')
const { ERR } = require('../../app/mcp/client/rpc')

beforeEach(() => {
  resetManager()
  globalState.set('config', { mcpServersAI: [] })
})

describe('mcp-client ipc facade', () => {
  it('没有任何 server：mcpClientGetTools 返回 tools: [] 与 servers: []（T01 ②）', async () => {
    const result = await facade.mcpClientGetTools()
    assert.deepEqual(result.tools, [])
    assert.deepEqual(result.meta, {})
    assert.deepEqual(result.servers, [])
    assert.deepEqual(result.truncated, { perServer: 0, global: 0 })
    assert.deepEqual(result.warnings, [])
    assert.equal(result.error, undefined)
  })

  it('配置里 mcpServersAI 缺失 / null 都不崩（老配置没有这个键）', async () => {
    for (const config of [{}, { mcpServersAI: null }, { mcpServersAI: [] }]) {
      globalState.set('config', config)
      const result = await facade.mcpClientGetTools()
      assert.deepEqual(result.tools, [])
      assert.equal(result.error, undefined)
    }
  })

  it('配置非法：仍返回结构化结果，并带 configErrors（不静默丢弃）', async () => {
    globalState.set('config', {
      mcpServersAI: [{ id: 'x', transport: 'stdio' }]
    })
    const result = await facade.mcpClientGetTools()
    assert.deepEqual(result.tools, [])
    assert.ok(
      result.warnings.some(line => /config error/.test(line)),
      JSON.stringify(result.warnings)
    )
    assert.ok(result.configErrors.length > 0, '结构化错误要能指到行与字段')
    assert.equal(result.configErrors[0].index, 0)
    assert.ok(['id', 'command'].includes(result.configErrors[0].field))
  })

  it('mcpServersAI 不是数组 → 报错而不是静默当成「没有 server」', async () => {
    for (const value of [{ a: 1 }, 'nope', 42]) {
      globalState.set('config', { mcpServersAI: value })
      const result = await facade.mcpClientGetTools()
      assert.deepEqual(result.tools, [])
      assert.ok(
        result.configErrors.some(error => error.field === 'mcpServersAI'),
        `mcpServersAI=${JSON.stringify(value)} 必须报错`
      )
      assert.ok(
        result.error || result.warnings.length > 0,
        '非法配置必须给用户可定位的信息'
      )
    }
  })

  it('mcpClientGetState 无 server → []', async () => {
    assert.deepEqual(await facade.mcpClientGetState(), [])
  })

  it('mcpClientCallTool 未知别名 → ok:false，不 throw', async () => {
    const result = await facade.mcpClientCallTool('mcp__nope__tool', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.UNKNOWN_TOOL)
  })

  it('mcpClientCallTool 非法入参 → ok:false，不 throw', async () => {
    const missing = await facade.mcpClientCallTool('', {})
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, ERR.UNKNOWN_TOOL)

    const arrayArgs = await facade.mcpClientCallTool('mcp__a__b', [1, 2])
    assert.equal(arrayArgs.ok, false)
    assert.equal(arrayArgs.error.code, ERR.INVALID_ARGS)

    const stringArgs = await facade.mcpClientCallTool('mcp__a__b', 'not-json')
    assert.equal(stringArgs.ok, false)
    assert.equal(stringArgs.error.code, ERR.INVALID_ARGS)
  })

  it('mcpClientRestart 未知 server → ok:false，不 throw', async () => {
    const result = await facade.mcpClientRestart('nope')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, ERR.UNAVAILABLE)
  })

  it('mcpClientOnConfigChange 空列表 → ok:true', async () => {
    const result = await facade.mcpClientOnConfigChange([])
    assert.equal(result.ok, true)
    assert.deepEqual(result.servers, [])
  })

  it('shutdownMcpClients 在没有连接时也能安全调用', async () => {
    await facade.shutdownMcpClients()
    const result = await facade.mcpClientGetTools()
    assert.deepEqual(result.tools, [])
  })
})
