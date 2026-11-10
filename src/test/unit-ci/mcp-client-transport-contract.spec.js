/**
 * ScriptedTransport 的关闭契约（M9 面向夹具的那一半）。
 *
 * 背景（2026-11-10）：`killNow()` 曾只置 `closed = true`，不像 `close()` 那样
 * 触发 `onClose` —— 上层（session/manager）的 pending 请求没人叫醒，等 1s
 * 超时，对**正确实现**也会报假红。真实 SIGKILL 一定触发子进程 exit → 产品
 * onClose 照常响；夹具的 kill 模拟必须等价，所以 kill/close 共用 fireClose。
 *
 * 这里钉两条，且都能变红（把 killNow 改回"只置 closed"→ 两条全红）：
 *   1. killNow() 必须同步触发 onClose，携带 SIGKILL 语义；
 *   2. kill 之后的 in-flight 请求必须在 1s 内 settle（transport closed），
 *      而不是挂到请求自己的超时。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')
const { McpSession } = require('../../app/mcp/client/session')

/**
 * @returns {{session: McpSession, transport: ScriptedTransport, closeEvents: Array}}
 */
function makeSession () {
  const transport = new ScriptedTransport({
    tools: [{ name: 'echo', description: '', inputSchema: { type: 'object', properties: {} } }],
    hangMethods: ['tools/call']
  })
  const session = new McpSession({
    serverConfig: { id: 'kill1', name: 'kill', transport: 'stdio', timeoutMs: 30000 },
    transport
  })
  transport.onMessage = msg => session.handleMessage(msg)
  const closeEvents = []
  transport.onClose = info => closeEvents.push(info)
  transport.onClose = info => {
    closeEvents.push(info)
    session.handleTransportClosed(info)
  }
  return { session, transport, closeEvents }
}

describe('scripted transport close contract', () => {
  it('close() → onClose({code:0})，会话转 failed', async () => {
    const { session, transport, closeEvents } = makeSession()
    await session.connect()
    await transport.close('user')
    assert.equal(closeEvents.length, 1, 'close 必须触发恰好一次 onClose')
    assert.equal(closeEvents[0].code, 0)
    assert.equal(session.state, 'failed', 'transport 关闭 = 会话不可用，必须可见')
  })

  it('killNow() → onClose 带 SIGKILL 语义，in-flight 请求 1s 内收敛', async () => {
    const { session, transport, closeEvents } = makeSession()
    await session.connect()

    const inflight = session.callTool('echo', { text: 'x' }, { timeoutMs: 30000 })
    // 挂起确认：callTool 还没 settle（hangMethods 不回包）
    let settled = false
    inflight.catch(() => { settled = true })

    const started = Date.now()
    transport.killNow()

    await assert.rejects(
      Promise.race([
        inflight,
        new Promise((resolve, reject) => setTimeout(
          () => reject(new Error('in-flight request did not settle within 1s of killNow')), 1000)
        )
      ]),
      (err) => String(err && err.message).includes('transport closed'),
      'kill 之后的 pending 请求必须立刻收敛（transport closed），不能挂到自身超时'
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1000, `收敛耗时 ${elapsed}ms，超过 1s 即假红的形态`)

    assert.equal(closeEvents.length, 1, 'killNow 必须触发 onClose（与 close 同一出口）')
    assert.equal(closeEvents[0].signal, 'SIGKILL')
    assert.equal(settled, true)
    assert.equal(session.state, 'failed')
  })
})
