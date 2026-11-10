/**
 * MCP client · 别名构造（M4 的命名面）。
 *
 * 这些断言全部钉在**纯函数**上，因为它们决定的是「模型看到的名字」：一旦别名
 * 不稳定（大小写、哈希、截断长度漂移），模型上一轮学到的名字下一轮就失效。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const {
  PREFIX,
  SEP,
  MAX_ALIAS_LENGTH,
  sanitizeSegment,
  shortHash,
  buildAlias,
  buildServerAliases
} = require('../../app/mcp/client/tool-name')

describe('mcp-client tool-name', () => {
  it('别名前缀固定为 mcp__，渲染层靠它分流', () => {
    assert.equal(PREFIX, 'mcp__')
    assert.equal(SEP, '__')
    const { alias } = buildAlias('abc1234', 'read_file')
    assert.equal(alias, 'mcp__abc1234__read_file')
    assert.ok(alias.startsWith(PREFIX))
  })

  it('serverId 与工具名都清洗到 [A-Za-z0-9_-]', () => {
    assert.equal(sanitizeSegment('a.b'), 'a_b')
    assert.equal(sanitizeSegment('a/b c'), 'a_b_c')
    assert.equal(sanitizeSegment('a__b'), 'a__b', '连续下划线不能被折叠，否则两个工具会撞成一个')
    assert.equal(sanitizeSegment(''), 'tool')
    assert.equal(sanitizeSegment(undefined), 'tool')
    const { alias } = buildAlias('srv.1', 'read:file')
    assert.match(alias, /^[A-Za-z0-9_-]+$/)
    assert.equal(alias, 'mcp__srv_1__read_file')
  })

  it('超长工具名截断到 64 字符以内，并带确定性哈希', () => {
    const longName = 'x'.repeat(200)
    const first = buildAlias('srv1', longName)
    const second = buildAlias('srv1', longName)
    assert.equal(first.truncated, true)
    assert.ok(first.alias.length <= MAX_ALIAS_LENGTH, `alias too long: ${first.alias.length}`)
    assert.equal(first.alias, second.alias, '同一工具必须每次得到同一别名（跨进程稳定）')
    assert.match(first.alias, /_[0-9a-z]{4}$/)
  })

  it('不同长名截断后仍可区分（哈希不同）', () => {
    const a = buildAlias('srv1', 'a'.repeat(120) + 'one')
    const b = buildAlias('srv1', 'a'.repeat(120) + 'two')
    assert.notEqual(a.alias, b.alias)
    assert.ok(a.alias.length <= MAX_ALIAS_LENGTH)
    assert.ok(b.alias.length <= MAX_ALIAS_LENGTH)
  })

  it('shortHash 稳定且定长', () => {
    assert.equal(shortHash('read_file'), shortHash('read_file'))
    assert.equal(shortHash('read_file').length, 4)
    assert.notEqual(shortHash('read_file'), shortHash('write_file'))
  })

  it('同 server 内清洗撞名：字典序首个保留原名，其余加 _2 并标记 deduped', () => {
    const built = buildServerAliases('srv1', ['a.b', 'a_b', 'c'])
    assert.equal(built.length, 3)
    const [dot, underscore, plain] = built
    // 'a.b' < 'a_b' 逐字符比较（'.' 0x2e < '_' 0x5f）
    assert.equal(dot.alias, 'mcp__srv1__a_b')
    assert.equal(dot.deduped, false)
    assert.equal(underscore.alias, 'mcp__srv1__a_b_2')
    assert.equal(underscore.deduped, true)
    assert.equal(plain.alias, 'mcp__srv1__c')
    assert.equal(plain.deduped, false)
    const aliases = built.map(item => item.alias)
    assert.equal(new Set(aliases).size, aliases.length, '别名必须唯一')
  })

  it('每个别名都在 64 字符内且带前缀（含截断 + 去重叠加的情况）', () => {
    const names = ['a'.repeat(200), 'a'.repeat(200) + 'x']
    const built = buildServerAliases('srv1', names)
    for (const item of built) {
      assert.ok(item.alias.startsWith(PREFIX), item.alias)
      assert.ok(item.alias.length <= MAX_ALIAS_LENGTH, `${item.alias} (${item.alias.length})`)
    }
    assert.equal(new Set(built.map(item => item.alias)).size, 2)
  })
})
