/**
 * 验收（QA 独立）：门面的**返回形状契约**——`mcpClientGetState` 必须是数组。
 *
 * 为什么单独一个文件：`mcp-client-accept-facade.spec.js` 里的通用断言是
 * `isStructured(value) = !!value && typeof value === 'object'`，而
 * `typeof [] === 'object'`——**数组从来不会被它拦下**，所以"返回数组"这件事
 * 在本轮之前没有任何断言在管（写成 `{ servers: [] }` 也是绿的，而那会让
 * 渲染层的 `.map()` 直接炸）。
 *
 * 契约来源：设计 §3.4（`:402` / `:530`）+ 实现 `src/app/mcp/client/index.js`
 * 的 JSDoc（`@returns {Promise<Array<object>>}`）+ `manager.getState()`。
 * 异常路径必须返回 `[]`（而不是 `{ servers: [] }` 或 `null`）：调用方一律
 * 当数组用，形状变了就是运行时 TypeError。
 */

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const gs = require('../../app/lib/glob-state')
const facade = require('../../app/mcp/client')
const { shutdownMcpClients } = require('../../app/mcp/client')

let previousConfig = null

beforeEach(() => {
  previousConfig = gs.get('config')
})

afterEach(async () => {
  if (previousConfig === undefined) {
    gs.set('config', {})
  } else {
    gs.set('config', previousConfig)
  }
  await shutdownMcpClients()
})

describe('门面 getState 的返回形状（数组契约）', () => {
  it('没有配置 server 时返回空数组，而不是 { servers: [] } / null', async () => {
    gs.set('config', { mcpServersAI: [] })
    const states = await facade.mcpClientGetState()
    assert.ok(
      Array.isArray(states),
      `getState 必须返回数组（设计 §3.4），实际是 ${Object.prototype.toString.call(states)}`
    )
    assert.deepEqual(states, [])
  })

  it('配置里有一台（未启用）server 时，返回 1 条且字段可读', async () => {
    gs.set('config', {
      mcpServersAI: [
        {
          id: 'shape1',
          name: 'shape1',
          transport: 'stdio',
          command: process.execPath,
          args: [],
          enabled: false,
          trust: 'ask'
        }
      ]
    })
    // `mcpClientGetState` 自己不跑 syncConfig（只有 `getTools` 跑），所以先把
    // 配置灌进 manager，再验形状。冷启动只调 getState 的行为见
    // `test/unit-ci` 之外的缺陷记录（Q-1：冷启动返回 []，待修）。
    await facade.mcpClientGetTools({})
    const states = await facade.mcpClientGetState()
    assert.ok(Array.isArray(states), 'getState 必须返回数组')
    assert.equal(states.length, 1, `应返回 1 条 server 状态，实际 ${states.length}`)
    const entry = states[0]
    assert.equal(entry.id, 'shape1')
    assert.equal(typeof entry.state, 'string', 'state 必须是字符串枚举（idle/closed/ready/failed…）')
    assert.equal(typeof entry.lastError, 'string', 'lastError 必须是字符串（无错时为空串）')
    assert.equal(typeof entry.toolCount, 'number', 'toolCount 必须是数字，渲染层直接显示')
  })

  it('配置本身是非法形状时，仍返回数组且不抛错（全函数约束）', async () => {
    gs.set('config', { mcpServersAI: { notAnArray: true } })
    const states = await facade.mcpClientGetState()
    assert.ok(Array.isArray(states), '非法配置下也必须返回数组，不得返回对象/bool')
  })
})
