const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadCompile = () => import('../../client/common/keyword-compile.js')
const loadAddon = () => import('../../client/components/terminal/highlight-addon.js')

const rules = (...pairs) => pairs.map(([keyword, color]) => ({ keyword, color }))
const countCodes = (s, code) => s.split(code).length - 1

describe('shared keyword pattern cache', () => {
  test('the same rule set compiles once and is reused by identity', async () => {
    const { compileKeywords, clearKeywordCache, keywordCacheSize } = await loadCompile()
    clearKeywordCache()
    const kw = rules(['\\bdown\\b', 'red'], ['\\bup\\b', 'green'])
    const first = compileKeywords(kw)
    assert.equal(keywordCacheSize(), 1)
    // 换一个新的数组实例、同样的内容：仍按内容摘要命中缓存
    const again = compileKeywords(rules(['\\bdown\\b', 'red'], ['\\bup\\b', 'green']))
    assert.equal(again, first)
    assert.equal(keywordCacheSize(), 1)
    // 同一正则换配色是另一份规则集，不能共用
    assert.notEqual(compileKeywords(rules(['\\bdown\\b', 'blue'])), first)
  })

  test('entry shape carries both consumers needs: re for scanning, color and colorCode', async () => {
    const { compileKeywords, clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const [entry] = compileKeywords(rules(['\\bx\\b', 'cyan']))
    assert.equal(entry.color, 'cyan')
    assert.equal(entry.colorCode, '\u001b[36m')
    assert.equal(entry.re.flags, 'gi')
    // 未知配色按红处理（与终端原口径一致）
    const [odd] = compileKeywords(rules(['\\by\\b', 'chartreuse']))
    assert.equal(odd.colorCode, '\u001b[31m')
  })

  test('invalid user regex is skipped, not thrown', async () => {
    const { compileKeywords, clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const original = console.error
    console.error = () => {}
    const patterns = compileKeywords(rules(['\\bok\\b', 'red'], ['(', 'red'], ['', 'red']))
    console.error = original
    assert.equal(patterns.length, 1)
    assert.equal(patterns[0].color, 'red')
  })

  test('empty rule set never enters the cache', async () => {
    const { compileKeywords, clearKeywordCache, keywordCacheSize } = await loadCompile()
    clearKeywordCache()
    assert.deepEqual(compileKeywords([]), [])
    assert.deepEqual(compileKeywords(undefined), [])
    assert.equal(keywordCacheSize(), 0)
  })

  test('cache is bounded: the least recently used set is dropped', async () => {
    const { compileKeywords, clearKeywordCache, keywordCacheSize } = await loadCompile()
    clearKeywordCache()
    const sets = [1, 2, 3, 4, 5].map(n => rules(['\\bk' + n + '\\b', 'red']))
    const first = compileKeywords(sets[0])
    for (const s of sets.slice(1)) compileKeywords(s)
    assert.equal(keywordCacheSize(), 4)
    // 第一个已被挤出：内容相同也重新编译，不再持有旧引用
    assert.notEqual(compileKeywords(sets[0]), first)
    assert.equal(keywordCacheSize(), 4)
    // 仍在缓存里的那份按身份返回
    assert.equal(compileKeywords(sets[2]), compileKeywords(sets[2]))
  })

  test('terminals with the same config share one compiled set', async () => {
    const { clearKeywordCache } = await loadCompile()
    const { KeywordHighlighterAddon } = await loadAddon()
    clearKeywordCache()
    const kw = rules(['\\bdown\\b', 'red'], ['\\bup\\b', 'green'])
    // 真实场景：每个页签的 config 是 deepCopy 出来的，规则对象不同但内容相同
    const copied = kw.map(k => ({ ...k }))
    const a = new KeywordHighlighterAddon(kw)
    const b = new KeywordHighlighterAddon(copied)
    assert.equal(a.compiledPatterns, b.compiledPatterns)
    assert.equal(a.compiledPatterns.length, 2)
  })

  test('shared RegExp stays correct across instances (lastIndex is reset per scan)', async () => {
    const { clearKeywordCache } = await loadCompile()
    const { KeywordHighlighterAddon } = await loadAddon()
    clearKeywordCache()
    const kw = rules(['\\bdown\\b', 'red'])
    const a = new KeywordHighlighterAddon(kw)
    const b = new KeywordHighlighterAddon(kw)
    // 交替扫描：任何一侧没把 lastIndex 归零都会在另一侧漏掉命中
    assert.equal(countCodes(a.highlightKeywords('link down'), '\u001b[31m'), 1)
    assert.equal(countCodes(b.highlightKeywords('link down'), '\u001b[31m'), 1)
    assert.equal(countCodes(a.highlightKeywords('down down down'), '\u001b[31m'), 3)
    assert.equal(countCodes(b.highlightKeywords('down down down'), '\u001b[31m'), 3)
  })

  test('a flooded line stops collecting matches at the cap', async () => {
    const { clearKeywordCache } = await loadCompile()
    const { KeywordHighlighterAddon } = await loadAddon()
    clearKeywordCache()
    const addon = new KeywordHighlighterAddon(rules(['error', 'red']))
    addon.maxMatchesPerSegment = 8
    const out = addon.highlightKeywords('error '.repeat(40))
    assert.equal(countCodes(out, '\u001b[31m'), 8)
    // 默认上限存在且远小于「整行洪泛」的命中数
    const plain = new KeywordHighlighterAddon(rules(['error', 'red']))
    assert.ok(plain.maxMatchesPerSegment > 8)
    assert.equal(countCodes(plain.highlightKeywords('error '.repeat(plain.maxMatchesPerSegment + 50)), '\u001b[31m'), plain.maxMatchesPerSegment)
  })
})
