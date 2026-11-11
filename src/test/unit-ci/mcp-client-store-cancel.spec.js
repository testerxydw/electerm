/**
 * T03 批次四 · M30 store 级：**真实扩展模块**（store/mcp-client.js，非 stub）
 * 的取消收敛。
 *
 * 覆盖：
 * - `mcpClientCancelRun(runId)`：renderer 侧 pendingByRun 注册表里挂着的
 *   mcpClientCallTool 立刻 settle 成 `mcp_aborted`（agent 循环的 await 收敛，
 *   不等主进程超时），并转发主进程；注册表清空后二次 cancel 幂等
 *   （settled=0，不再转发）。
 * - `opts.signal` 路径：AbortSignal 中止同样立刻 settle `mcp_aborted`，并
 *   best-effort 通知主进程（signal 是 run 级 AbortController 的兜底路径）。
 * - 正常完成路径不受取消机制影响：settle 后注册表清空，pendingByRun 不遗留。
 *
 * 加载方式：mcp-client.js 是零依赖 ESM（default export 一个 Store 扩展函数），
 * 动态 import 后挂到本地假 Store 类上，`window` 桩提供 pre/store。
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MCP_CLIENT = path.resolve(__dirname, '../../client/store/mcp-client.js')

const ABORTED_MESSAGE = 'external tool call aborted (agent run stopped)'

/**
 * 假 IPC 世界：`pre.runGlobalAsync(name, ...)` 记录调用；可注册挂起处理器。
 * @returns {object} world { window, calls, hang }
 */
function makeIpcWorld () {
  const world = {
    calls: [],
    resolvers: new Map(),
    store: {
      config: {},
      mcpExternalTools: [],
      mcpExternalToolMeta: {},
      mcpServerStates: []
    }
  }
  world.window = {
    store: world.store,
    pre: {
      runGlobalAsync: async (name, ...args) => {
        world.calls.push({ name, args })
        const resolver = world.resolvers.get(name)
        if (resolver) {
          return resolver(args)
        }
        return { ok: true }
      }
    }
  }
  return world
}

describe('M30 · store 级取消收敛（真实 mcp-client.js 扩展）', () => {
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

  it('挂起的外部调用被 mcpClientCancelRun 立刻 settle 成 mcp_aborted；二次 cancel 幂等', async () => {
    const world = makeIpcWorld()
    globalThis.window = world.window
    class Store {}
    extendStore(Store)
    const store = new Store()

    // 主进程侧 tools/call 挂死（agent 循环正卡在这里）；resolver 留着，
    // 测试尾部放行以清掉内层看门狗 timer（否则进程多等一个 60s 看门狗）
    let resolveMain = null
    world.resolvers.set('mcpClientCallTool', () => new Promise(resolve => {
      resolveMain = resolve
    }))
    const callPromise = store.mcpClientCallTool('mcp__srv1234__ext_read', {}, {
      runId: 'run-abc',
      timeoutMs: 1 // 看门狗 = timeoutMs + 5000，压短兜底等待
    })

    // promise 还没落定（挂起中）
    let settled = false
    callPromise.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(settled, false, '取消前调用必须还挂着')

    const res = await store.mcpClientCancelRun('run-abc')
    assert.equal(res.ok, true)
    assert.equal(res.settled, 1, '注册表里恰有 1 个挂起调用被 settle')

    const out = await callPromise
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'mcp_aborted', `取消码：${JSON.stringify(out.error)}`)
    assert.equal(out.error.message, ABORTED_MESSAGE)
    assert.equal(settled, true, 'cancelRun 必须**立刻**收敛挂起 promise（不等主进程）')
    assert.ok(
      world.calls.some(call => call.name === 'mcpClientCancelRun'),
      '取消要转发主进程（manager.cancelRun 才是真正 abort tools/call 的地方）'
    )

    // 注册表清空：二次 cancel 幂等（settled=0）。主进程转发**仍然发生**：
    // renderer 注册表只覆盖「renderer 侧挂起」的调用，主进程侧 in-flight 的
    // tools/call 要靠 manager.cancelRun 幂等 abort，转发不能省
    world.calls.length = 0
    const again = await store.mcpClientCancelRun('run-abc')
    assert.equal(again.ok, true)
    assert.equal(again.settled, 0, '注册表已清空，二次 cancel 幂等')
    assert.ok(
      world.calls.some(call => call.name === 'mcpClientCancelRun'),
      '主进程转发必须保留（renderer 幂等 ≠ 主进程没有 in-flight）'
    )

    // 放行挂死的 invoke，让内层看门狗 race 立刻收尾、timer 被清
    if (resolveMain) {
      resolveMain({ ok: true, text: 'late' })
      await callPromise.then(() => {}, () => {})
    }
  })

  it('signal 中止同样立刻 settle mcp_aborted，并 best-effort 通知主进程', async () => {
    const world = makeIpcWorld()
    globalThis.window = world.window
    class Store {}
    extendStore(Store)
    const store = new Store()

    let resolveMain = null
    world.resolvers.set('mcpClientCallTool', () => new Promise(resolve => {
      resolveMain = resolve
    }))
    const controller = new AbortController()
    const callPromise = store.mcpClientCallTool('mcp__srv1234__ext_read', {}, {
      runId: 'run-sig',
      timeoutMs: 1,
      signal: controller.signal
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    let settled = false
    callPromise.then(() => { settled = true })
    assert.equal(settled, false)

    controller.abort()
    const out = await callPromise
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'mcp_aborted')
    assert.equal(out.error.message, ABORTED_MESSAGE)
    assert.equal(settled, true, 'signal 中止必须立刻收敛')
    assert.ok(
      world.calls.some(call => call.name === 'mcpClientCancelRun'),
      'signal 路径也要 best-effort 通知主进程'
    )
    // 放行挂死的 invoke，清掉内层看门狗 timer
    if (resolveMain) {
      resolveMain({ ok: true, text: 'late' })
      await callPromise.then(() => {}, () => {})
    }
  })

  it('正常完成路径：注册表用后即清，取消机制不影响结果透传', async () => {
    const world = makeIpcWorld()
    globalThis.window = world.window
    class Store {}
    extendStore(Store)
    const store = new Store()

    world.resolvers.set('mcpClientCallTool', () => ({ ok: true, text: 'all good' }))
    const out = await store.mcpClientCallTool('mcp__srv1234__ext_read', {}, {
      runId: 'run-ok'
    })
    assert.deepEqual(out, { ok: true, text: 'all good' })

    // 用后即清：同 runId 的 cancel 不再 settle 任何东西
    const res = await store.mcpClientCancelRun('run-ok')
    assert.equal(res.settled, 0, '完成的调用不得残留在注册表')
  })

  it('abortAIRequest 不经过本模块（既有路径归 stopAgentRun 直调）——取消转发只发 mcpClientCancelRun', async () => {
    const world = makeIpcWorld()
    globalThis.window = world.window
    class Store {}
    extendStore(Store)
    const store = new Store()

    let resolveMain = null
    world.resolvers.set('mcpClientCallTool', () => new Promise(resolve => {
      resolveMain = resolve
    }))
    const callPromise = store.mcpClientCallTool('mcp__srv1234__ext_read', {}, {
      runId: 'r1',
      timeoutMs: 1
    })
    await store.mcpClientCancelRun('r1')
    await callPromise

    assert.ok(
      !world.calls.some(call => call.name === 'abortAIRequest'),
      'store 层不碰 provider 请求取消（那是 stopAgentRun → abortAIRequest 的职责）'
    )
    if (resolveMain) {
      resolveMain({ ok: true, text: 'late' })
    }
  })
})
