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
})
