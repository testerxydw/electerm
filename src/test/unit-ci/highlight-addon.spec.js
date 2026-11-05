const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadAddon = () => import('../../client/components/terminal/highlight-addon.js')

const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const RESET = '\u001b[0m'

function fakeTerminal () {
  const written = []
  return {
    written,
    displayRaw: false,
    write (data) { written.push(data) }
  }
}

describe('keyword highlight addon', () => {
  test('highlights writes larger than the per-line limit line by line', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: '\\bdown\\b', color: 'red' }])
    const term = fakeTerminal()
    addon.activate(term)

    // a coalesced `show running-config`-sized write: many short lines, > 4096 chars
    const lines = Array.from({ length: 400 }, (_, i) => `interface Gi1/0/${i} status down`)
    const chunk = lines.join('\r\n')
    assert.ok(chunk.length > addon.maxHighlightLength)
    term.write(chunk)

    const out = term.written[0]
    assert.equal(out.split(`${RED}down${RESET}`).length - 1, 400)
  })

  test('leaves a single over-long line unhighlighted but still highlights its neighbours', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: 'up', color: 'green' }])
    const longLine = 'up ' + 'x'.repeat(addon.maxHighlightLength + 10)
    const out = addon.highlightChunk(`link up\n${longLine}\nlink up`)
    const [first, middle, last] = out.split('\n')

    assert.equal(first, `link ${GREEN}up${RESET}`)
    assert.equal(middle, longLine)
    assert.equal(last, `link ${GREEN}up${RESET}`)
  })

  test('skips writes over the chunk cap entirely', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: 'down', color: 'red' }])
    const flood = 'down\n'.repeat(Math.ceil(addon.maxHighlightChunkLength / 5) + 1)
    assert.equal(addon.highlightChunk(flood), flood)
  })

  test('small writes behave as before', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: 'down', color: 'red' }])
    assert.equal(addon.highlightChunk('link down'), `link ${RED}down${RESET}`)
  })

  test('热更新 update() 会替换规则数组，后续写入立刻用上新规则', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: '\\bERROR\\b', color: 'red' }])
    const term = fakeTerminal()
    addon.activate(term)

    // 初始化时：只有 ERROR 规则，WARN 不应被染色
    term.write('WARN something')
    assert.equal(term.written[0], 'WARN something', '初始只有 ERROR 规则时 WARN 应无色')

    // 热更新：加上 WARN 规则
    addon.update([
      { keyword: '\\bERROR\\b', color: 'red' },
      { keyword: '\\bWARN(?:ING)?\\b', color: 'yellow' }
    ])

    // 后续写入：WARN 被染色
    term.write('WARN warning again')
    const yellow = '\u001b[33m'
    assert.ok(
      term.written[1].includes(`${yellow}WARN${RESET}`),
      `热更新后 WARN 应被染色，实际: ${JSON.stringify(term.written[1])}`
    )
  })

  test('热更新到空数组 → compiledPatterns 清空 → highlightChunk 秒回不扫描', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: 'down', color: 'red' }])
    assert.equal(addon.highlightChunk('down'), `${RED}down${RESET}`)
    addon.update([])
    assert.equal(addon.compiledPatterns.length, 0)
    assert.equal(addon.highlightChunk('down'), 'down', '空规则应直接原样返回')
  })

  test('> 4096 且 OSC 负载内含字面 \\n：序列完整、字节逐字节保留、闸仍按物理行裁决', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const rules = [
      { keyword: '\\bERROR\\b', color: 'red' },
      { keyword: '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b', color: 'blue', tier: 'structure' }
    ]
    const addon = new KeywordHighlighterAddon(rules)
    const blue = '\u001b[34m'
    const osc = '\u001b]0;ERROR 10.1.2.3\nmore ERROR 10.1.2.4\u0007'
    const oscLine = 'osc ' + osc + ' ERROR ' + 'q'.repeat(80)
    const dirtyLine = Array.from({ length: 12 }, (_, i) => '10.1.2.' + (i + 1)).join(' ')
    const cleanLine = 'host 10.1.2.99 ' + 'z'.repeat(120)
    const filler = Array.from({ length: 200 }, (_, i) => 'plain line ' + i + ' ERROR').join('\n')
    const chunk = [filler, oscLine, dirtyLine, cleanLine].join('\n')

    assert.ok(chunk.length > addon.maxHighlightLength, 'fixture 必须走大写入切分路径')
    assert.ok(chunk.length < addon.maxHighlightChunkLength, 'fixture 不能触发整体绕过')

    // 自检：规则集确实生效（关闸时脏行的 structure 命中会被染色），否则
    // 「structure 命中 0」可能只是空规则集造成的假阳性。
    const noGate = new KeywordHighlighterAddon(rules, { coverageGate: false })
    assert.ok(noGate.highlightKeywords(dirtyLine).includes(blue + '10.1.2.1'))

    const out = addon.highlightChunk(chunk)
    // ① 完整 OSC 留在同一段，负载内部不得插入 ANSI 染色码
    assert.ok(out.includes(osc), 'OSC 序列必须完整，不能被 \\n 切成两半')
    // eslint-disable-next-line no-control-regex
    assert.equal(/\]0;[^\u0007]*\u001b\[[0-9;]*m/.test(out), false,
      'OSC 负载内部不得被当作纯文本染色')
    // ② 除新增 SGR 外，所有原始字节（含 OSC 内的 \\n / BEL / ESC）逐字节保留
    // eslint-disable-next-line no-control-regex
    const stripSgr = s => s.replace(/\u001b\[[0-9;]*m/g, '')
    assert.equal(stripSgr(out), chunk)
    // ③ 覆盖率闸仍按物理行裁决：超阈值行丢 structure、干净行保留、signal 永存
    assert.ok(out.includes(dirtyLine), '超阈值行的 structure 命中应被整行丢弃')
    assert.ok(out.includes(blue + '10.1.2.99' + RESET), '干净行的 IP 应保留染色')
    assert.ok(out.includes(RED + 'ERROR' + RESET), 'signal 命中不受闸影响')
  })

  test('不含 OSC 的普通长写入仍按 \\n 逐行高亮（既有行为不变）', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: '\\bdown\\b', color: 'red' }])
    const lines = Array.from({ length: 400 }, (_, i) => `interface Gi1/0/${i} status down`)
    const chunk = lines.join('\n')
    assert.ok(chunk.length > addon.maxHighlightLength)
    const expected = lines.map(l => l.replace(/\bdown\b/, `${RED}down${RESET}`)).join('\n')
    assert.equal(addon.highlightChunk(chunk), expected)
    assert.equal(addon.highlightChunk(chunk).split('\n').length, lines.length)

    // 单段超过 maxHighlightLength 仍原样跳过，邻居行照常染色
    const longLine = 'down ' + 'x'.repeat(addon.maxHighlightLength + 10)
    const mixed = [lines[0], lines[1], longLine, lines[2]].join('\n')
    const out = addon.highlightChunk(mixed)
    assert.ok(out.includes(longLine), '超长单行原样跳过')
    assert.equal(out.split(`${RED}down${RESET}`).length - 1, 3, '其余 3 行照常染色')
  })

  test('OSC 切分修复不破坏 containsDcsSequence 早退 / displayRaw / dispose 链路', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon([{ keyword: '\\bdown\\b', color: 'red' }])
    const term = fakeTerminal()
    addon.activate(term)

    const osc = '\u001b]0;title\ndown\u0007'
    term.write('link ' + osc + ' down')
    assert.ok(term.written[0].includes(osc))
    assert.ok(term.written[0].includes(`${RED}down${RESET}`))

    // DCS：整段原样写出，不进 highlightChunk
    const dcs = '\u001bP+q544e' + 'x'.repeat(addon.maxHighlightLength + 100) + '\u001b\\'
    term.write(dcs)
    assert.equal(term.written[1], dcs)

    // displayRaw：所有写入（无论大小）走 escape()，不做高亮
    term.displayRaw = true
    const raw = 'down ' + 'y'.repeat(addon.maxHighlightLength + 100)
    term.write(raw)
    assert.equal(term.written[2], addon.escape(raw))
    assert.equal(term.written[2].includes(RED), false)

    // dispose：恢复原始 write
    addon.dispose()
    term.write('plain down')
    assert.equal(term.written[3], 'plain down')
  })
})
