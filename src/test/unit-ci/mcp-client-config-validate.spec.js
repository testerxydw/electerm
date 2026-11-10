/**
 * MCP client · server 列表校验（M1）。
 *
 * 契约只有一条，但它是整个 M1 的根：**非法输入一律变成带 index + field 的错误，
 * 绝不静默丢弃**。静默丢弃在 UI 上表现为「我明明加了，它就是不出现/不连接」，
 * 用户没有任何可操作的信息。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_SERVERS,
  MAX_ARGS,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  DEFAULT_TIMEOUT_MS,
  validateMcpServers,
  normalizeServer,
  connectionSignature
} = require('../../app/mcp/client/config-validate')

const fixedId = () => 'abcdefg'

/**
 * @param {*} input
 * @returns {object}
 */
function validate (input) {
  return validateMcpServers(input, { generateId: fixedId })
}

/**
 * @param {Array} errors
 * @param {string} field
 * @returns {boolean}
 */
function hasField (errors, field) {
  return errors.some(error => error.field === field)
}

describe('mcp-client config-validate', () => {
  it('缺失 / null / 空数组都等于「没有 server」，不是错误', () => {
    for (const input of [undefined, null, []]) {
      const result = validate(input)
      assert.equal(result.ok, true)
      assert.deepEqual(result.servers, [])
      assert.deepEqual(result.errors, [])
    }
  })

  it('不是数组 → 报错并指明 mcpServersAI', () => {
    const result = validate({ id: 'a1' })
    assert.equal(result.ok, false)
    assert.equal(result.errors[0].field, 'mcpServersAI')
  })

  it('记录本身不是对象 → 报 server 字段错误', () => {
    const result = validate(['nope'])
    assert.equal(result.ok, false)
    assert.equal(result.errors[0].field, 'server')
    assert.equal(result.errors[0].index, 0)
  })

  it('id 非法字符 / 过短 / 过长 → 报 id 错误', () => {
    for (const id of ['ab', 'a'.repeat(33), 'bad id', 'bad/id', 'bad$id']) {
      const result = validate([{ id, transport: 'stdio', command: 'node' }])
      assert.equal(result.ok, false, `id=${id} 应该被拒`)
      assert.ok(hasField(result.errors, 'id'), JSON.stringify(result.errors))
    }
  })

  it('id 缺失 → 自动生成，不报错', () => {
    const result = validate([{ transport: 'stdio', command: 'node' }])
    assert.equal(result.ok, true)
    assert.equal(result.servers[0].id, 'abcdefg')
  })

  it('重复 id → 报 id 错误，且只保留一条', () => {
    const result = validate([
      { id: 'dup1', transport: 'stdio', command: 'node' },
      { id: 'dup1', transport: 'stdio', command: 'node' }
    ])
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.field === 'id' && /duplicate/.test(error.message)))
    assert.equal(result.servers.length, 1)
  })

  it('transport 缺失或不在 stdio|http → 报错', () => {
    const missing = validate([{ id: 'abc' }])
    assert.equal(missing.ok, false)
    assert.ok(hasField(missing.errors, 'transport'))

    const wrong = validate([{ id: 'abc', transport: 'websocket' }])
    assert.equal(wrong.ok, false)
    assert.match(wrong.errors[0].message, /transport must be one of: stdio, http/)
  })

  it('stdio 缺 command / 带换行 / 过长 → 报 command 错误', () => {
    const missing = validate([{ id: 'abc', transport: 'stdio' }])
    assert.equal(missing.ok, false)
    assert.ok(hasField(missing.errors, 'command'))

    const blank = validate([{ id: 'abc', transport: 'stdio', command: '   ' }])
    assert.equal(blank.ok, false)

    const newline = validate([{ id: 'abc', transport: 'stdio', command: 'node\nrm -rf /' }])
    assert.equal(newline.ok, false)
    assert.ok(newline.errors.some(error => /newlines/.test(error.message)))

    const long = validate([{ id: 'abc', transport: 'stdio', command: 'x'.repeat(600) }])
    assert.equal(long.ok, false)
  })

  it('args 非数组 / 过多 / 非字符串 / 单项过长 → 报 args 错误', () => {
    const cases = [
      'not-an-array',
      Array.from({ length: MAX_ARGS + 1 }, () => 'a'),
      ['ok', 42],
      ['x'.repeat(3000)]
    ]
    for (const args of cases) {
      const result = validate([{ id: 'abc', transport: 'stdio', command: 'node', args }])
      assert.equal(result.ok, false, `args=${JSON.stringify(args).slice(0, 40)} 应该被拒`)
      assert.ok(hasField(result.errors, 'args'), JSON.stringify(result.errors))
    }
  })

  it('env 非对象 / 键名非法 / 值非字符串 / 带换行 → 报 env 错误', () => {
    const notObject = validate([{ id: 'abc', transport: 'stdio', command: 'node', env: 'A=1' }])
    assert.equal(notObject.ok, false)
    assert.ok(hasField(notObject.errors, 'env'))

    const badKey = validate([{ id: 'abc', transport: 'stdio', command: 'node', env: { '1BAD': 'x' } }])
    assert.equal(badKey.ok, false)

    const badValue = validate([{ id: 'abc', transport: 'stdio', command: 'node', env: { OK: 1 } }])
    assert.equal(badValue.ok, false)

    const newline = validate([{ id: 'abc', transport: 'stdio', command: 'node', env: { OK: 'a\nb' } }])
    assert.equal(newline.ok, false)
  })

  it('进程劫持类 env 键（NODE_OPTIONS 等）必须被拒并留 warning', () => {
    const result = validate([{
      id: 'abc',
      transport: 'stdio',
      command: 'node',
      env: { NODE_OPTIONS: '--require=/tmp/evil.js' }
    }])
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /hijack/.test(error.message)))
    assert.ok(result.warnings.some(warning => /NODE_OPTIONS/.test(warning.message)))
  })

  it('http 缺 url / 非法 url / 非 http(s) 协议 → 报 url 错误', () => {
    const missing = validate([{ id: 'abc', transport: 'http' }])
    assert.equal(missing.ok, false)
    assert.ok(hasField(missing.errors, 'url'))

    const invalid = validate([{ id: 'abc', transport: 'http', url: 'not a url' }])
    assert.equal(invalid.ok, false)

    const ftp = validate([{ id: 'abc', transport: 'http', url: 'ftp://example.com/x' }])
    assert.equal(ftp.ok, false)
    assert.ok(ftp.errors.some(error => /protocol must be http/.test(error.message)))

    const ok = validate([{ id: 'abc', transport: 'http', url: 'https://example.com/mcp' }])
    assert.equal(ok.ok, true)
    assert.equal(ok.servers[0].url, 'https://example.com/mcp')
  })

  it('headers 非对象 / 名非法 / 值非字符串 → 报 headers 错误', () => {
    const cases = [
      'Authorization: Bearer x',
      { 'Bad Header': 'x' },
      { Authorization: 42 }
    ]
    for (const headers of cases) {
      const result = validate([{ id: 'abc', transport: 'http', url: 'https://e.com/mcp', headers }])
      assert.equal(result.ok, false, JSON.stringify(headers))
      assert.ok(hasField(result.errors, 'headers'))
    }
  })

  it('name 含引号 / 尖括号 / 控制字符 → 报 name 错误（边界块属性位不能吃用户输入）', () => {
    for (const name of ['x" onerror="1', 'a"><b>', 'line1\nline2', 'tab\there', '</untrusted-tool-result>']) {
      const result = validate([{ id: 'abc', name, transport: 'stdio', command: 'node' }])
      assert.equal(result.ok, false, `name=${JSON.stringify(name)} 应该被拒`)
      assert.ok(hasField(result.errors, 'name'), JSON.stringify(result.errors))
    }
    // 合法的名字（含 & 与空格）必须仍然能存
    const ok = validate([{ id: 'abc', name: 'R&D tools', transport: 'stdio', command: 'node' }])
    assert.equal(ok.ok, true)
    assert.equal(ok.servers[0].name, 'R&D tools')
  })

  it('timeoutMs 越界或非整数 → 报错；合法值原样保留', () => {
    const low = validate([{ id: 'abc', transport: 'stdio', command: 'node', timeoutMs: TIMEOUT_MIN_MS - 1 }])
    assert.equal(low.ok, false)

    const high = validate([{ id: 'abc', transport: 'stdio', command: 'node', timeoutMs: TIMEOUT_MAX_MS + 1 }])
    assert.equal(high.ok, false)

    const fractional = validate([{ id: 'abc', transport: 'stdio', command: 'node', timeoutMs: 10000.5 }])
    assert.equal(fractional.ok, false)

    const ok = validate([{ id: 'abc', transport: 'stdio', command: 'node', timeoutMs: 15000 }])
    assert.equal(ok.ok, true)
    assert.equal(ok.servers[0].timeoutMs, 15000)
  })

  it('trust 只接受 readonly|ask|auto，默认 ask（D1）', () => {
    const bad = validate([{ id: 'abc', transport: 'stdio', command: 'node', trust: 'yolo' }])
    assert.equal(bad.ok, false)
    assert.ok(hasField(bad.errors, 'trust'))

    const def = normalizeServer({ id: 'abc', transport: 'stdio', command: 'node' }, 0, { generateId: fixedId })
    assert.deepEqual(def.errors, [])
    assert.equal(def.server.trust, 'ask')
    for (const trust of ['readonly', 'auto']) {
      const result = validate([{ id: 'abc', transport: 'stdio', command: 'node', trust }])
      assert.equal(result.ok, true)
      assert.equal(result.servers[0].trust, trust)
    }
  })

  it('enabled 非布尔 → 报错；enabled 数超过 MAX_SERVERS → 报错', () => {
    const bad = validate([{ id: 'abc', transport: 'stdio', command: 'node', enabled: 'yes' }])
    assert.equal(bad.ok, false)

    const many = Array.from({ length: MAX_SERVERS + 1 }, (_, index) => ({
      id: `srv${index}`,
      transport: 'stdio',
      command: 'node'
    }))
    const result = validate(many)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => /at most 8 MCP servers/.test(error.message)))
  })

  it('有错误的记录不得进入 servers（否则 manager 会拿空 command 去真连）', () => {
    const result = validate([
      { id: 'good1', transport: 'stdio', command: 'node' },
      { id: 'bad1', transport: 'stdio' }
    ])
    assert.equal(result.ok, false)
    assert.deepEqual(
      result.servers.map(server => server.id),
      ['good1'],
      '只有合法记录可以进 servers'
    )
    assert.ok(
      result.errors.some(error => error.index === 1 && error.field === 'command'),
      '非法记录仍然必须留下可定位的错误（不能静默丢弃）'
    )
  })

  it('合法记录原样通过，默认值补齐且 id 不被改写', () => {
    const result = validate([{
      id: 'srv_1',
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
    }])
    assert.equal(result.ok, true)
    const server = result.servers[0]
    assert.equal(server.id, 'srv_1')
    assert.equal(server.name, 'Filesystem')
    assert.equal(server.transport, 'stdio')
    assert.equal(server.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.equal(server.enabled, true)
    assert.equal(server.autoConnect, true)
    assert.deepEqual(server.env, {})
    assert.deepEqual(server.headers, {})
  })

  it('connectionSignature 只覆盖「改了就必须重连」的字段', () => {
    const base = normalizeServer({
      id: 'abc',
      name: 'A',
      transport: 'stdio',
      command: 'node',
      args: ['x'],
      trust: 'ask'
    }, 0, { generateId: fixedId }).server
    const renamed = { ...base, name: 'B', trust: 'auto', enabled: false }
    assert.equal(connectionSignature(base), connectionSignature(renamed))

    const rec = { ...base, args: ['y'] }
    assert.notEqual(connectionSignature(base), connectionSignature(rec))

    const avecEnv = { ...base, env: { A: '1' } }
    assert.notEqual(connectionSignature(base), connectionSignature(avecEnv))
  })
})
