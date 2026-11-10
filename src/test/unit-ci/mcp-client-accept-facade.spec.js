/**
 * 验收（QA 独立）：T01 的 IPC 门面契约（`src/app/mcp/client/index.js`）。
 *
 * 门面的唯一硬约束是**全函数**（total function）：无论渲染层传什么垃圾，
 * 都返回结构化对象、永不 throw。原因写在 index.js 头注释里——ipcRenderer.invoke
 * 抛错时渲染层只会看到 "Error invoking remote method"，用户与模型都无从下手。
 *
 * 另外锁定 T01 的接线：默认配置里有 `mcpServersAI: []`，门面导出 5 个
 * `mcpClient*` 函数（ipc.js 逐个挂到 handler 上）。
 */

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')

const facade = require('../../app/mcp/client')
const defaultSetting = require('../../app/common/default-setting')
const { shutdownMcpClients } = require('../../app/mcp/client')

/** 门面必须暴露的函数（ipc.js 逐个转发给渲染层）。 */
const FACADE_FUNCTIONS = [
  'mcpClientGetTools',
  'mcpClientCallTool',
  'mcpClientGetState',
  'mcpClientRestart',
  'mcpClientOnConfigChange'
]

/**
 * @param {*} value
 * @returns {boolean}
 */
function isStructured (value) {
  return !!value && typeof value === 'object'
}

after(async () => {
  await shutdownMcpClients()
})

describe('验收 · T01 IPC 门面（全函数 + 接线）', () => {
  it('导出 5 个 mcpClient* 函数与 shutdownMcpClients', () => {
    for (const name of FACADE_FUNCTIONS) {
      assert.equal(typeof facade[name], 'function', `缺少门面函数 ${name}`)
    }
    assert.equal(typeof facade.shutdownMcpClients, 'function')
  })

  it('默认配置含 mcpServersAI: []（未接入任何外部工具）', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(defaultSetting, 'mcpServersAI'),
      'default-setting.js 必须声明 mcpServersAI，否则老用户配置里没有这个键'
    )
    assert.deepEqual(defaultSetting.mcpServersAI, [])
  })

  it('垃圾输入不抛错，且返回对象不带 stack', async () => {
    const calls = [
      ['mcpClientGetTools', [{}]],
      ['mcpClientGetTools', [null]],
      ['mcpClientGetState', []],
      ['mcpClientCallTool', ['', {}]],
      ['mcpClientCallTool', ['mcp__nope__x', {}]],
      ['mcpClientCallTool', [42, {}]],
      ['mcpClientCallTool', ['mcp__nope__x', 'not-an-object']],
      ['mcpClientCallTool', ['mcp__nope__x', [1, 2]]],
      ['mcpClientRestart', ['nope']],
      ['mcpClientRestart', [null]],
      ['mcpClientOnConfigChange', [[]]],
      ['mcpClientOnConfigChange', [null]]
    ]
    for (const [name, args] of calls) {
      const result = await facade[name](...args)
      assert.ok(isStructured(result), `${name}(${JSON.stringify(args)}) 必须返回对象`)
      assert.equal('stack' in result, false, `${name} 的返回值不得带 stack`)
      if (result.error) {
        assert.equal(typeof result.error.code, 'string')
        assert.equal(typeof result.error.message, 'string')
        assert.equal('stack' in result.error, false)
      }
    }
  })

  it('空工具名 / 未知别名 / 非法参数类型给的是可读错误码', async () => {
    const empty = await facade.mcpClientCallTool('', {})
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'unknown_external_tool')

    const unknown = await facade.mcpClientCallTool('mcp__nope__x', {})
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_external_tool')
    assert.ok(Array.isArray(unknown.error.known))

    const badArgs = await facade.mcpClientCallTool('mcp__nope__x', 'oops')
    assert.equal(badArgs.ok, false)
    assert.equal(badArgs.error.code, 'invalid_tool_arguments')

    const unknownServer = await facade.mcpClientRestart('definitely-not-a-server')
    assert.equal(unknownServer.ok, false)
    assert.equal(unknownServer.error.code, 'mcp_server_unavailable')
  })

  it('没有配置 server 时 getTools/getState 给空集，不是错误', async () => {
    const toolSet = await facade.mcpClientGetTools({})
    assert.deepEqual(toolSet.tools, [])
    assert.deepEqual(toolSet.meta, {})
    assert.deepEqual(toolSet.truncated, { perServer: 0, global: 0 })
    assert.equal(toolSet.error, undefined)

    const states = await facade.mcpClientGetState()
    assert.ok(Array.isArray(states))
    assert.deepEqual(states, [])
  })

  it('回归（曾为缺陷 P0-1-F，2026-11-10 修复）：mcpServersAI 非数组必须报错，不能静默当成「没有 server」', async () => {
    const gs = require('../../app/lib/glob-state')
    const previous = gs.get('config')
    try {
      gs.set('config', { mcpServersAI: { a: 1 } })
      const result = await facade.mcpClientGetTools({})
      assert.ok(
        result.error || (result.warnings && result.warnings.length > 0),
        '非法配置必须给出可定位的错误/警告'
      )
    } finally {
      gs.set('config', previous || {})
    }
  })
})
