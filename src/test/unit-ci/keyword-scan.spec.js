const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const { buildScan, collectMatches } = require('../../client/common/keyword-scan.js')

const colorCodes = {
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m'
}
const mk = (keyword, color, rank) => ({
  keyword,
  color,
  colorCode: colorCodes[color] || colorCodes.red,
  re: new RegExp(keyword, 'gi'),
  rank
})

describe('keyword-scan: shared single-pass scanner', () => {
  test('buildScan returns a scan struct, null for empty input', () => {
    assert.equal(buildScan([]), null)
    assert.equal(buildScan(null), null)
    const scan = buildScan([mk('error', 'red')])
    assert.ok(scan)
    assert.ok(scan.combined instanceof RegExp)
    assert.equal(scan.combined.flags, 'gi')
    assert.equal(scan.sticky.length, 1)
    assert.equal(scan.sticky[0].flags, 'giy')
    assert.deepEqual(scan.colors, ['red'])
  })

  test('同 rank 取更长：同族异形规则里能吃下完整信号的那条赢', () => {
    const patterns = [mk('ab', 'red', 50), mk('abcd', 'blue', 50)]
    const scan = buildScan(patterns)
    const m = collectMatches('abcd', patterns, scan)
    assert.equal(m.length, 1)
    assert.equal(m[0].text, 'abcd')
    assert.equal(m[0].color, 'blue')
  })

  test('rank 小者胜：与长度无关（IP 家族 10 抢在端口映射 40 前面）', () => {
    // V3 契约取代旧的「同起点取最短」：ipv4 不再靠 (?!:\d) 让位，
    // 而是靠 rank —— 精确地址层 10 < 数值时间层 40，同起点短者也赢。
    const patterns = [mk('10\\.1\\.2\\.3', 'cyan', 10), mk('10\\.1\\.2\\.3:443', 'magenta', 40)]
    const scan = buildScan(patterns)
    const m = collectMatches('10.1.2.3:443', patterns, scan)
    assert.equal(m.length, 1)
    assert.equal(m[0].text, '10.1.2.3')
    assert.equal(m[0].color, 'cyan')
    assert.equal(m[0].rank, 10)
  })

  test('等长且同 rank 取原序最先', () => {
    const patterns = [mk('ab|cd', 'red', 30), mk('cd|ab', 'blue', 30)]
    const scan = buildScan(patterns)
    const m = collectMatches('cd', patterns, scan)
    assert.equal(m.length, 1)
    assert.equal(m[0].color, 'red')
  })

  test('未标 rank 的规则按 50（signal-word 层）保底，两条路径口径一致', () => {
    const patterns = [mk('ab', 'red'), mk('abcd', 'blue', 60)]
    const viaCombined = collectMatches('abcd', patterns, buildScan(patterns))
    const viaRules = collectMatches('abcd', patterns, null)
    assert.equal(viaCombined[0].rank, 50)
    assert.deepEqual(
      viaCombined.map(s => `${s.start}-${s.end}:${s.color}`),
      viaRules.map(s => `${s.start}-${s.end}:${s.color}`)
    )
  })

  test('单遍扫描与逐规则扫描结论一致（rank 裁决口径）', () => {
    const patterns = [
      mk('\\b\\d+\\b', 'cyan'),
      mk('error', 'red'),
      mk('foo\\d+', 'green'),
      mk('[a-z]+\\d+', 'yellow')
    ]
    const scan = buildScan(patterns)
    const text = 'error 123 foo42 and foo7 ok bar9'
    const viaCombined = collectMatches(text, patterns, scan)
    const viaRules = collectMatches(text, patterns, null)
    const norm = arr => arr.map(s => `${s.start}-${s.end}:${s.color}`)
    assert.deepEqual(norm(viaCombined), norm(viaRules), text)
  })

  test('命中互不重叠、按左到右排列', () => {
    const patterns = [mk('a', 'red'), mk('b', 'blue')]
    const scan = buildScan(patterns)
    const m = collectMatches('a b a b', patterns, scan)
    assert.deepEqual(m.map(s => s.text), ['a', 'b', 'a', 'b'])
    for (let i = 1; i < m.length; i++) {
      assert.ok(m[i].start >= m[i - 1].end, 'no overlap')
    }
  })

  test('合并失败时退回逐规则扫描（保底），结论不变', () => {
    // 故意制造无法合并的命名分组冲突（同名字分组），buildScan 返回 null
    const badA = '(?<x>\\d+)'
    const badB = '(?<x>\\w+)'
    const patterns = [
      { keyword: badA, color: 'red', colorCode: colorCodes.red, re: new RegExp(badA, 'gi') },
      { keyword: badB, color: 'blue', colorCode: colorCodes.blue, re: new RegExp(badB, 'gi') }
    ]
    assert.equal(buildScan(patterns), null)
    const m = collectMatches('abc123', patterns, null)
    // 仍能产出命中（退化为逐规则）
    assert.ok(m.length >= 1)
  })

  test('collectMatches 对空文本/无命中返回空数组', () => {
    const patterns = [mk('error', 'red')]
    const scan = buildScan(patterns)
    assert.deepEqual(collectMatches('', patterns, scan), [])
    assert.deepEqual(collectMatches('all quiet here', patterns, scan), [])
  })
})
