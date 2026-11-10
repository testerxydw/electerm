/**
 * 验收（QA 独立）：M1 配置校验。
 *
 * 与工程师的 `mcp-client-config-validate.spec.js` 的区别：
 * 1. 这里只从**用户能看到的契约**出发——每类非法输入必须同时满足
 *    ① 被拒绝（`ok === false`）② 错误可定位（带 index + field + 非空 message），
 *    不接受"返回了 false 就算过"。
 * 2. 额外探针：非法记录**不得**进入 `servers`（否则 manager 会拿空 command /
 *    非法 url 去真连，见 `mcp-client-accept-runtime.spec.js` 的慢连证据）。
 *
 * 非法输入的期望字段一律写死在本文件，不从产品代码里读常量推导——否则产品把
 * 常量改错，测试会跟着一起错。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  validateMcpServers,
  MAX_SERVERS,
  MAX_ARGS
} = require('../../app/mcp/client/config-validate')
const { McpClientManager } = require('../../app/mcp/client/manager')

const fixedId = () => 'abcdefg'

/**
 * @param {*} input
 * @returns {object}
 */
function validate (input) {
  return validateMcpServers(input, { generateId: fixedId })
}

/**
 * 一条非法输入 + 期望命中的字段。
 * @typedef {{name: string, raw: object, field: string}} BadCase
 * @type {BadCase[]}
 */
const BAD_CASES = [
  {
    name: 'id 含非法字符（空格）',
    raw: { id: 'bad id', transport: 'stdio', command: 'node' },
    field: 'id'
  },
  {
    name: 'id 含路径分隔符',
    raw: { id: 'a/b', transport: 'stdio', command: 'node' },
    field: 'id'
  },
  {
    name: 'id 少于 3 字符',
    raw: { id: 'ab', transport: 'stdio', command: 'node' },
    field: 'id'
  },
  {
    name: 'id 超过 32 字符',
    raw: { id: 'a'.repeat(33), transport: 'stdio', command: 'node' },
    field: 'id'
  },
  {
    name: 'id 非字符串',
    raw: { id: 42, transport: 'stdio', command: 'node' },
    field: 'id'
  },
  {
    name: 'transport 缺失',
    raw: { id: 'abc', command: 'node' },
    field: 'transport'
  },
  {
    name: 'transport 不在 stdio|http',
    raw: { id: 'abc', transport: 'websocket', command: 'node' },
    field: 'transport'
  },
  {
    name: 'stdio 缺 command',
    raw: { id: 'abc', transport: 'stdio' },
    field: 'command'
  },
  {
    name: 'stdio command 为空白串',
    raw: { id: 'abc', transport: 'stdio', command: '   ' },
    field: 'command'
  },
  {
    name: 'stdio command 超长（>512）',
    raw: { id: 'abc', transport: 'stdio', command: 'x'.repeat(513) },
    field: 'command'
  },
  {
    name: 'stdio command 含换行',
    raw: { id: 'abc', transport: 'stdio', command: 'node\nrm -rf /' },
    field: 'command'
  },
  {
    name: 'args 条数超过上限',
    raw: {
      id: 'abc',
      transport: 'stdio',
      command: 'node',
      args: Array.from({ length: MAX_ARGS + 1 }, () => 'a')
    },
    field: 'args'
  },
  {
    name: 'args 含非字符串项',
    raw: { id: 'abc', transport: 'stdio', command: 'node', args: ['ok', 42] },
    field: 'args'
  },
  {
    name: 'args 单项超长（>2048）',
    raw: { id: 'abc', transport: 'stdio', command: 'node', args: ['x'.repeat(2049)] },
    field: 'args'
  },
  {
    name: 'http 缺 url',
    raw: { id: 'abc', transport: 'http' },
    field: 'url'
  },
  {
    name: 'url 不是绝对 URL',
    raw: { id: 'abc', transport: 'http', url: 'not a url' },
    field: 'url'
  },
  {
    name: 'url 协议非 http(s)（ftp）',
    raw: { id: 'abc', transport: 'http', url: 'ftp://example.com/mcp' },
    field: 'url'
  },
  {
    name: 'url 协议非 http(s)（file）',
    raw: { id: 'abc', transport: 'http', url: 'file:///etc/passwd' },
    field: 'url'
  },
  {
    name: 'timeoutMs 低于下限（4999）',
    raw: { id: 'abc', transport: 'stdio', command: 'node', timeoutMs: 4999 },
    field: 'timeoutMs'
  },
  {
    name: 'timeoutMs 高于上限（300001）',
    raw: { id: 'abc', transport: 'stdio', command: 'node', timeoutMs: 300001 },
    field: 'timeoutMs'
  },
  {
    name: 'timeoutMs 非整数',
    raw: { id: 'abc', transport: 'stdio', command: 'node', timeoutMs: 10000.5 },
    field: 'timeoutMs'
  },
  {
    name: 'env 不是对象（字符串）',
    raw: { id: 'abc', transport: 'stdio', command: 'node', env: 'A=1' },
    field: 'env'
  },
  {
    name: 'env 值是数字',
    raw: { id: 'abc', transport: 'stdio', command: 'node', env: { OK: 1 } },
    field: 'env'
  },
  {
    name: 'env 含进程劫持键 NODE_OPTIONS',
    raw: {
      id: 'abc',
      transport: 'stdio',
      command: 'node',
      env: { NODE_OPTIONS: '--require=/tmp/evil.js' }
    },
    field: 'env'
  },
  {
    name: 'headers 不是对象（字符串）',
    raw: {
      id: 'abc',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: 'Authorization: Bearer x'
    },
    field: 'headers'
  },
  {
    name: 'headers 值是数字',
    raw: {
      id: 'abc',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 42 }
    },
    field: 'headers'
  }
]

describe('验收 · M1 配置校验：每条非法输入都被拒绝且错误可定位', () => {
  for (const testCase of BAD_CASES) {
    it(`拒绝并可定位：${testCase.name}`, () => {
      const result = validate([testCase.raw])

      assert.equal(result.ok, false, `应当拒绝：${testCase.name}`)

      const hit = result.errors.find(error =>
        error.index === 0 && error.field === testCase.field
      )
      assert.ok(
        hit,
        `错误必须能定位到 index=0 field=${testCase.field}，实际：${JSON.stringify(result.errors)}`
      )
      assert.ok(
        typeof hit.message === 'string' && hit.message.trim().length >= 8,
        `错误信息要能指导用户改什么，实际："${hit.message}"`
      )
    })
  }

  it('重复 id → 拒绝，错误指向 id 且说明 duplicate', () => {
    const result = validate([
      { id: 'dup1', transport: 'stdio', command: 'node' },
      { id: 'dup1', transport: 'stdio', command: 'node' }
    ])
    assert.equal(result.ok, false)
    const hit = result.errors.find(error => error.index === 1 && error.field === 'id')
    assert.ok(hit, JSON.stringify(result.errors))
    assert.match(hit.message, /duplicate/)
    assert.equal(result.servers.length, 1, '重复项只保留一条')
  })

  it(`enabled 数超过 MAX_SERVERS（${MAX_SERVERS}）→ 拒绝且信息含上限数字`, () => {
    const many = Array.from({ length: MAX_SERVERS + 1 }, (_, index) => ({
      id: `srv${index}`,
      transport: 'stdio',
      command: 'node'
    }))
    const result = validate(many)
    assert.equal(result.ok, false)
    const hit = result.errors.find(error => /at most 8/.test(error.message))
    assert.ok(hit, JSON.stringify(result.errors))
  })

  it('mcpServersAI 三态：undefined / null / [] 都等于「没有 server」，不报错', () => {
    for (const value of [undefined, null, []]) {
      const result = validate(value)
      assert.equal(result.ok, true, `值 ${JSON.stringify(value)} 不应报错`)
      assert.deepEqual(result.servers, [])
      assert.deepEqual(result.errors, [])
    }
  })

  it('合法记录不被改写：id/name/transport/command/args 原样保留，默认值补齐', () => {
    const result = validate([{
      id: 'srv_1',
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { TOKEN: 'abc' }
    }])
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    const server = result.servers[0]
    assert.equal(server.id, 'srv_1')
    assert.equal(server.name, 'Filesystem')
    assert.equal(server.transport, 'stdio')
    assert.equal(server.command, 'npx')
    assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
    assert.deepEqual(server.env, { TOKEN: 'abc' })
    assert.equal(server.trust, 'ask')
    assert.equal(server.timeoutMs, 30000)
    assert.equal(server.enabled, true)
  })

  it('回归（曾为缺陷 P0-1-A，2026-11-10 修复）：非法记录不得进入 servers', () => {
    const missingCommand = validate([{ id: 'abc', transport: 'stdio' }])
    assert.equal(
      missingCommand.servers.length,
      0,
      `stdio 缺 command 的记录不该进入可用列表，实际：${JSON.stringify(missingCommand.servers)}`
    )

    const badId = validate([{ id: 'bad id', transport: 'stdio', command: 'node' }])
    assert.equal(
      badId.servers.length,
      0,
      `id 非法的记录不该进入可用列表，实际：${JSON.stringify(badId.servers)}`
    )
  })

  it('回归（曾为缺陷 P0-1-A，2026-11-10 修复）：manager 不得为校验失败的记录创建 transport', async () => {
    let transports = 0
    const manager = new McpClientManager({
      transportFactory: () => {
        transports++
        return {
          start: async () => {
            throw new Error('invalid config must not be started')
          },
          send () {},
          close: async () => {}
        }
      }
    })
    await manager.syncConfig([{ id: 'bad1', transport: 'stdio' }])
    assert.equal(transports, 0, '校验失败的记录不应被连接')
    assert.equal(manager.configs.length, 0, '校验失败的记录不应进入 manager.configs')
    assert.ok(
      Array.isArray(manager.configErrors) && manager.configErrors.length > 0,
      '错误仍要能被 UI 读到（不能静默丢弃）'
    )
  })
})
