/**
 * T04 · store 审批接线（T04-02 的 store 面）· 真实 mcp-client.js 扩展直测。
 *
 * 加载方式同 mcp-client-store-cancel.spec.js：动态 import 真模块
 * （mcp-client.js 只 import 纯 external-tool-guard.js，node 可加载；
 * 确认弹窗组件经 `window.mcpConfirmExternalTool` 注入，本文件用可编排的
 * 假确认器替身——组件本体是 .jsx，node 导入链进不来，其形态由
 * mcp-tool-approval.jsx 的实现与源码契约保证）。
 *
 * 覆盖：
 * - 无需审批（auto 档 / requireApproval=false 的预决策）→ approved:true 且
 *   确认器**一次都不调**；
 * - 需要审批 + 用户确认 → approved:true，确认器实参字段正确
 *   （serverName/toolName/trust/readOnlyHint/reason）；
 * - 用户取消 → {approved:false, cancelled:true}；
 * - 确认器缺失 / 抛错 → fail-closed 视为取消（宁拦不放）；
 * - reason 覆盖（external-taint）走调用方预决策通道。
 *
 * 变异自证：把 fail-closed 改成"缺确认器直接放行"→ 缺失分支两条断言红；
 * 把决策从 decideToolApproval 挪走（store 自造第二份矩阵）→ auto 档断言红
 * （store 侧不允许出现第二份 6 格表）。
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MCP_CLIENT = path.resolve(__dirname, '../../client/store/mcp-client.js')

const META_ASK = {
  serverId: 'srv1234',
  serverName: 'fake-srv',
  originalName: 'ext_read',
  annotations: {},
  trust: 'ask'
}
const META_AUTO = { ...META_ASK, trust: 'auto' }

function makeWorld (confirmer) {
  const world = { confirmerCalls: [] }
  world.window = {
    store: {},
    pre: { runGlobalAsync: async () => ({ ok: true }) }
  }
  if (confirmer !== undefined) {
    world.window.mcpConfirmExternalTool = async (spec) => {
      world.confirmerCalls.push(spec)
      return confirmer
    }
  }
  return world
}

describe('T04-02（store 面）mcpClientRequestApproval', () => {
  let extendStore
  let previousWindow

  beforeEach(async () => {
    const mod = await import(pathToFileURL(MCP_CLIENT).href)
    extendStore = mod.default
    previousWindow = globalThis.window
  })

  afterEach(() => {
    if (previousWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = previousWindow
    }
  })

  function newStore () {
    class Store {}
    extendStore(Store)
    return new Store()
  }

  it('决策走 external-tool-guard：ask + 无 hint → 弹确认；确认后 approved:true 且实参正确', async () => {
    const world = makeWorld(true)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('mcp__srv1234__ext_read', META_ASK)
    assert.equal(res.approved, true)
    assert.equal(world.confirmerCalls.length, 1, '确认器必须恰好被调 1 次')
    const spec = world.confirmerCalls[0]
    assert.equal(spec.serverName, 'fake-srv')
    assert.equal(spec.toolName, 'ext_read')
    assert.equal(spec.trust, 'ask')
    assert.equal(spec.readOnlyHint, false)
    assert.equal(spec.reason, 'no-readonly-hint', 'reason 来自渲染层唯一权威 decideToolApproval')
  })

  it('auto 档（决策表第 6 格）→ 不弹确认，approved:true，确认器零调用', async () => {
    const world = makeWorld(true)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('mcp__srv1234__ext_read', META_AUTO)
    assert.equal(res.approved, true)
    assert.equal(res.requireApproval, false)
    assert.equal(world.confirmerCalls.length, 0, 'auto 档不得打扰用户')
  })

  it('用户取消 → {approved:false, cancelled:true}', async () => {
    const world = makeWorld(false)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('mcp__srv1234__ext_read', META_ASK)
    assert.equal(res.approved, false)
    assert.equal(res.cancelled, true)
    assert.equal(world.confirmerCalls.length, 1)
  })

  it('调用方预决策通道：reason=external-taint 原样透传给确认器', async () => {
    const world = makeWorld(false)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('db_insert_sql', {}, {
      requireApproval: true,
      reason: 'external-taint'
    })
    assert.equal(res.approved, false)
    assert.equal(res.cancelled, true)
    assert.equal(world.confirmerCalls[0].reason, 'external-taint')
    assert.equal(world.confirmerCalls[0].toolName, 'db_insert_sql')
  })

  it('预决策 requireApproval=false → 直接放行，确认器零调用', async () => {
    const world = makeWorld(true)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('x', META_ASK, { requireApproval: false })
    assert.equal(res.approved, true)
    assert.equal(world.confirmerCalls.length, 0)
  })

  it('fail-closed：window 上没有确认器 → 视为取消（宁拦不放）', async () => {
    const world = makeWorld(undefined)
    globalThis.window = world.window
    const store = newStore()

    const res = await store.mcpClientRequestApproval('mcp__srv1234__ext_read', META_ASK)
    assert.equal(res.approved, false, '确认入口缺失必须拦截——改放行即判据红')
    assert.equal(res.cancelled, true)
  })

  it('fail-closed：确认器抛错 → 视为取消，不向 agent 循环抛异常', async () => {
    const world = makeWorld(undefined)
    globalThis.window = world.window
    world.window.mcpConfirmExternalTool = async () => {
      throw new Error('boom')
    }
    const store = newStore()

    const res = await store.mcpClientRequestApproval('mcp__srv1234__ext_read', META_ASK)
    assert.equal(res.approved, false)
    assert.equal(res.cancelled, true)
  })
})
