/**
 * MCP client · `tools/list` 分页上限。
 *
 * 背景：MCP 允许服务端用 `nextCursor` 分页。如果服务端**永远**给游标（恶意或
 * 有 bug），一个没有上限的客户端会一直请求下去 —— 表现为「连上了但永远不 ready」
 * 或者几万次请求把 server 打死。自然结束的分页假 server 抓不到这种 bug（测试
 * 只会绿），所以这里用 `nextCursorLoop: true` 造一个永不终止的对端。
 *
 * 本实现的约定：最多 `MAX_LIST_PAGES` 页、最多 `MAX_TOOLS` 个工具，然后**照常
 * 进入 ready**（工具表是能用的，只是不全）。判据不是"等于某个数"，而是
 * 「请求次数落在声明的上限内，且会话最终仍然可用」——上限放宽或收紧都不会让
 * 这条测试变成假绿。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { McpSession, MAX_LIST_PAGES, MAX_TOOLS } = require('../../app/mcp/client/session')
const { ScriptedTransport } = require('../fixtures/scripted-mcp-transport')

/**
 * @param {object} [opts]
 * @returns {{session: McpSession, transport: ScriptedTransport}}
 */
function makeSession (opts = {}) {
  const transport = new ScriptedTransport({
    tools: opts.tools || [{ name: 'echo', description: '', inputSchema: { type: 'object', properties: {} } }],
    nextCursorLoop: opts.nextCursorLoop !== false
  })
  const session = new McpSession({
    serverConfig: { id: 'loop1', name: 'loop', transport: 'stdio', timeoutMs: 2000 },
    transport
  })
  transport.onMessage = msg => session.handleMessage(msg)
  transport.onClose = info => session.handleTransportClosed(info)
  return { session, transport }
}

/**
 * @param {ScriptedTransport} transport
 * @returns {number}
 */
function listRequests (transport) {
  return transport.received.filter(msg => msg.method === 'tools/list').length
}

describe('mcp-client tools/list paging bound', () => {
  it('服务端永远给 nextCursor：请求次数有上限，会话仍然 ready', async () => {
    const { session, transport } = makeSession()
    await session.connect()

    const requests = listRequests(transport)
    assert.ok(
      requests <= MAX_LIST_PAGES,
      `tools/list 请求了 ${requests} 次，超过上限 ${MAX_LIST_PAGES}（没有上限就是死循环）`
    )
    assert.ok(requests >= 2, `应当真的跟了分页，实际只请求 ${requests} 次`)
    assert.equal(session.state, 'ready', '追到上限也必须进入 ready，不能把连接判死')
    assert.ok(session.tools.length <= MAX_TOOLS)
    assert.ok(session.tools.length > 0)
    assert.equal(
      session.toolsTruncated,
      true,
      '页数上限打满 = 工具表不完整，必须置 toolsTruncated（静默截断会让 UI 骗用户）'
    )
  })

  it('每页都拿到工具时，工具总数不超过 MAX_TOOLS', async () => {
    // 每页 60 个工具，5 页 = 300 > 200，必须被 MAX_TOOLS 截断
    const tools = Array.from({ length: 60 }, (_, index) => ({
      name: `tool_${index}`,
      description: '',
      inputSchema: { type: 'object', properties: {} }
    }))
    const { session, transport } = makeSession({ tools })
    await session.connect()

    assert.ok(
      listRequests(transport) <= MAX_LIST_PAGES,
      `请求次数 ${listRequests(transport)} 超过 ${MAX_LIST_PAGES}`
    )
    assert.ok(
      session.tools.length <= MAX_TOOLS,
      `工具数 ${session.tools.length} 超过 ${MAX_TOOLS}`
    )
    assert.equal(session.toolsTruncated, true, '被截断要能被 UI 读到')
  })

  it('一次性返回全部工具（服务端不分页）→ 只请求一次', async () => {
    const { session, transport } = makeSession({ nextCursorLoop: false })
    await session.connect()
    assert.equal(listRequests(transport), 1)
    assert.equal(session.state, 'ready')
  })
})
