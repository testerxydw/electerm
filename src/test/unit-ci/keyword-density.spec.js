const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadScan = () => import('../../client/common/keyword-scan.js')
const loadCompile = () => import('../../client/common/keyword-compile.js')
const loadGroups = () => import('../../client/common/keyword-groups.js')
const loadPresetsForCount = () => import('../../client/common/keyword-presets.js')
const loadAddon = () => import('../../client/components/terminal/highlight-addon.js')

/**
 * V2 §7 / §9 密度回归验收。
 *
 * 语料固定（不随预设增删而漂移）：
 *  - 15 行真实日志（沿用 highlight-equivalence.spec.js 的代表性混合语料）；
 *  - 93% 那行的等价形态：一条绝对路径吃满整行（实测 100%）；
 *  - 1 行脏 + 9 行净的多行片段（实测整片段平均仅 26%，低于 35% 阈值）——
 *    这正是文档 §7.3 / §11#10 要防的「按写入片段算占比会静默放宽阈值」：
 *    若按片段算，26% < 35%，脏行根本不会被闸掉。
 */

const corpus = [
  'drwxr-xr-x 2 root root 4096 Oct  9 08:57 nginx.service',
  'Oct  9 08:57:36 host systemd[1]: nginx.service: Failed with result exit-code',
  'a1b2c3d4e5f6   web-0     Up 3 hours          0.0.0.0:8080->80/tcp',
  'tcp   LISTEN 0  4096  0.0.0.0:22   0.0.0.0:*   sshd',
  'tcp  ESTAB  0  0  10.1.2.3:443  93.184.216.34:80  elapsed 1.2s',
  'ERROR 1146 (42S02): Table users does not exist',
  'df -h /dev/sda2  233G   98G  45%',
  'curl -sS --max-time=30 -o /tmp/out.json',
  'root:x:0:0:root:/root:/bin/bash',
  '"GET /api/x HTTP/1.1" 500 1234 request_time=0.012',
  '404 /favicon.ico',
  'ip addr show dev eth0: inet 10.1.2.3/24 scope global eth0',
  'lspci 0000:3b:00.0 VGA compatible controller',
  'SELECT id FROM users WHERE name IS NULL',
  'Query OK, 3 rows affected (0.01 sec)'
]

// §1 探针里「单行最惨 93%」的等价语料：一条 absPath 吃满整行（实测 100%）
const dirtyLine = '/var/log/electerm/sessions/2026-11-05/worker.log'
const cleanLines = Array.from({ length: 9 }, (_, i) =>
  `the quick brown fox jumps over the lazy dog near 10.1.2.${10 + i} on a quiet afternoon`
)
const multiLineChunk = [dirtyLine, ...cleanLines].join('\n')

const ratioOf = (line, patterns, scan, gate = true) => {
  const { collectMatches, applyCoverageGate } = gateCache
  let hits = collectMatches(line, patterns, scan, 512)
  if (gate) {
    hits = applyCoverageGate(line, hits)
  }
  const colored = hits.reduce((n, h) => n + (h.end - h.start), 0)
  return { ratio: colored / (line.length || 1), hits }
}

const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]

// 模块加载是异步的，用 before 钩子把纯函数缓存进闭包，测试体保持同步
let gateCache = null

const buildPatterns = async (withStructure) => {
  const { compileKeywords, clearKeywordCache } = await loadCompile()
  const { applySemanticTier, activeKeywords, setTierOn } = await loadGroups()
  clearKeywordCache()
  const list = withStructure
    ? setTierOn(applySemanticTier([]), 'structure', true)
    : applySemanticTier([])
  const keywords = activeKeywords(list)
  const patterns = compileKeywords(keywords)
  const { buildScan } = await loadScan()
  return { keywords, patterns, scan: buildScan(patterns) }
}

describe('V2 批次 3：行级覆盖率闸与档位语义', async () => {
  const scanMod = await loadScan()
  gateCache = scanMod

  test('默认「全部应用」= 语义档：中位单行染色率 ≤ 20%', async () => {
    const { patterns, scan } = await buildPatterns(false)
    const ratios = corpus.map(line => ratioOf(line, patterns, scan).ratio)
    assert.ok(median(ratios) <= 0.20, `median ${(median(ratios) * 100).toFixed(1)}% should be ≤ 20%`)
  })

  test('默认全选后结构档一条都不生效（structure 默认关）', async () => {
    const { keywords } = await buildPatterns(false)
    assert.ok(keywords.length > 0)
    assert.equal(keywords.filter(k => k.tier === 'structure').length, 0)
    assert.ok(keywords.every(k => (k.tier || 'signal') === 'signal'))
  })

  test('错误 / 警告词在默认全选后仍染色（signal 不受密度治理影响）', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const { keywords } = await buildPatterns(false)
    const addon = new KeywordHighlighterAddon(keywords)
    assert.ok(addon.highlightKeywords('ERROR: disk full').includes('\u001b[31mERROR'))
    assert.ok(addon.highlightKeywords('WARNING: deprecated API').includes('\u001b[33mWARNING'))
    assert.ok(addon.highlightKeywords('build succeeded').includes('\u001b[32m'))
  })

  test('结构档开关：默认关 → 打开 → 再关，幂等且老配置零迁移', async () => {
    const { applySemanticTier, activeKeywords, setTierOn, isStructureTierOn } = await loadGroups()
    const semantic = applySemanticTier([])
    assert.equal(isStructureTierOn(semantic), false)
    const opened = setTierOn(semantic, 'structure', true)
    assert.equal(isStructureTierOn(opened), true)
    // 条数一律现算（文档 §1 纪律）：预设增删不该让密度用例脆断
    const { keywordPresets } = await loadPresetsForCount()
    const expectedStructure = keywordPresets
      .reduce((n, p) => n + p.keywords.filter(k => k.tier === 'structure').length, 0)
    assert.ok(expectedStructure > 0)
    assert.equal(activeKeywords(opened).filter(k => k.tier === 'structure').length, expectedStructure)
    const closed = setTierOn(opened, 'structure', false)
    assert.equal(isStructureTierOn(closed), false)
    assert.deepEqual(activeKeywords(closed), activeKeywords(semantic))
    // 幂等
    assert.deepEqual(applySemanticTier(semantic), semantic)
    // 老配置没有 tier 字段，按 signal 处理，不会被丢弃也不会被误标 structure
    const legacy = [{ keyword: 'foo', color: 'red' }]
    const migrated = applySemanticTier(legacy)
    assert.ok(migrated.some(r => r.keyword === 'foo' && !r.off))
    assert.equal(migrated.find(r => r.keyword === 'foo').tier, undefined)
  })

  test('93% 脏行：整行被路径吃掉，闸后归零；signal 命中永远保留', async () => {
    const { patterns, scan } = await buildPatterns(true)
    const raw = ratioOf(dirtyLine, patterns, scan, false)
    const gated = ratioOf(dirtyLine, patterns, scan, true)
    assert.ok(raw.ratio > 0.9, `raw ${(raw.ratio * 100).toFixed(0)}% should be > 90%`)
    assert.equal(raw.hits[0].tier, 'structure')
    assert.equal(gated.ratio, 0, 'busy line keeps no structure hit')
    assert.equal(gated.hits.length, 0)

    const mixed = '2026-10-09T08:00:00Z ERROR failed to connect: permission denied'
    const before = ratioOf(mixed, patterns, scan, false)
    const after = ratioOf(mixed, patterns, scan, true)
    assert.ok(before.ratio > 0.35)
    assert.ok(after.ratio < before.ratio, 'gate must reduce coloring on busy lines')
    assert.ok(after.hits.every(h => h.tier !== 'structure'), 'only signal survives')
    assert.ok(after.hits.some(h => h.text === 'ERROR'), 'error word still coloured')
  })

  test('多行片段：按行算，脏行被闸、9 行净不受影响（按片段算会漏）', async () => {
    const { patterns, scan } = await buildPatterns(true)
    const { collectMatches, applyCoverageGate } = gateCache
    const all = collectMatches(multiLineChunk, patterns, scan, 512)
    const gated = applyCoverageGate(multiLineChunk, all)

    // 反证：整片段平均占比低于阈值，若按片段算则一行都不会被闸
    const wholeRatio = all.reduce((n, h) => n + (h.end - h.start), 0) / multiLineChunk.length
    assert.ok(wholeRatio < 0.35, `whole-chunk average ${(wholeRatio * 100).toFixed(0)}% must be < 35%`)

    const dirtyEnd = dirtyLine.length
    const dirtyStructure = gated.filter(h => h.start < dirtyEnd && h.tier === 'structure')
    const cleanStructure = gated.filter(h => h.start > dirtyEnd && h.tier === 'structure')
    assert.equal(dirtyStructure.length, 0, 'dirty line drops its structure hit')
    assert.equal(cleanStructure.length, cleanLines.length, 'each clean line keeps its IP colouring')
    assert.ok(gated.length < all.length, 'gate actually removed something')
  })

  test('阈值可配置、enabled:false 直通、无 structure 时零开销快路径', async () => {
    const { patterns, scan } = await buildPatterns(true)
    const { collectMatches, applyCoverageGate, defaultCoverageThreshold } = gateCache
    assert.equal(defaultCoverageThreshold, 0.35)
    const all = collectMatches(multiLineChunk, patterns, scan, 512)
    assert.equal(applyCoverageGate(multiLineChunk, all, { enabled: false }), all)
    // 阈值 1.0 = 永不触发
    assert.equal(applyCoverageGate(multiLineChunk, all, { threshold: 1 }), all)
    // 阈值 0 = 所有含 structure 的行都触发
    const strict = applyCoverageGate(multiLineChunk, all, { threshold: 0 })
    assert.ok(strict.length < all.length)
    // 全 signal 的规则集：tier 都是 signal，闸直接返回原数组
    const signalOnly = all.map(h => ({ ...h, tier: 'signal' }))
    assert.equal(applyCoverageGate(multiLineChunk, signalOnly), signalOnly)
    assert.equal(applyCoverageGate('', [], {}).length, 0)
  })

  test('阈值判定不含换行符：\\n 不计入行长度', () => {
    const { applyCoverageGate } = gateCache
    // 手工构造：10 字符行里 4 字符命中 = 40% > 35%，另一行 10 字符里 2 字符 = 20%
    const content = 'AB12xxxxxx\nCD3xxxxxxx'
    const hits = [
      { start: 0, end: 2, tier: 'structure' },
      { start: 2, end: 4, tier: 'structure' },
      { start: 11, end: 13, tier: 'structure' }
    ]
    const out = applyCoverageGate(content, hits)
    assert.equal(out.length, 1)
    assert.equal(out[0].start, 11, 'only the dirty line drops its structure hit')
  })

  test('tier 从预设一路透传到命中（buildScan.tiers / collectMatches.hit.tier）', async () => {
    const { collectMatches } = gateCache
    const { patterns, scan } = await buildPatterns(true)
    assert.equal(scan.tiers.length, patterns.length)
    const { keywordPresets } = await loadPresetsForCount()
    const expectedStructure = keywordPresets
      .reduce((n, p) => n + p.keywords.filter(k => k.tier === 'structure').length, 0)
    assert.equal(scan.tiers.filter(t => t === 'structure').length, expectedStructure)
    const hits = collectMatches('ERROR at 10.1.2.3', patterns, scan, 512)
    assert.ok(hits.some(h => h.tier === 'signal'))
    assert.ok(hits.some(h => h.tier === 'structure'))
  })

  test('用户自定义规则无 tier 时按 signal 处理，永不被闸丢弃', async () => {
    const { compileKeywords, clearKeywordCache } = await loadCompile()
    const { buildScan, collectMatches, applyCoverageGate } = gateCache
    clearKeywordCache()
    const patterns = compileKeywords([{ keyword: 'AB|CD|EF|GH|IJ', color: 'red' }])
    const scan = buildScan(patterns)
    const line = 'AB CD EF GH IJ KL'
    const hits = collectMatches(line, patterns, scan, 512)
    assert.ok(hits.every(h => h.tier === 'signal'))
    assert.equal(applyCoverageGate(line, hits), hits)
  })

  test('两端同源：终端与网格都调用 applyCoverageGate（源码契约）', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const root = path.join(__dirname, '../../..')
    const addon = fs.readFileSync(path.join(root, 'src/client/components/terminal/highlight-addon.js'), 'utf8')
    const grid = fs.readFileSync(path.join(root, 'src/client/components/database/db-highlight.jsx'), 'utf8')
    for (const [name, src] of [['terminal', addon], ['grid', grid]]) {
      assert.match(src, /applyCoverageGate/, `${name} must import the shared gate`)
      assert.match(src, /= applyCoverageGate\(/, `${name} must call the gate before rendering`)
    }
    // 终端必须把 ANSI 段拼成 plain 「物理行视图」再裁决，不能逐段独立跑闸
    assert.match(addon, /plain \+= seg\.content/, 'terminal must build a cross-segment plain view')
    assert.match(addon, /applyCoverageGate\(plain,/, 'terminal gate must judge the whole physical line')
  })

  test('结构档打开时，覆盖率闸把中位染色率压回 20% 以内', async () => {
    const { patterns, scan } = await buildPatterns(true)
    const raw = corpus.map(line => ratioOf(line, patterns, scan, false).ratio)
    const gated = corpus.map(line => ratioOf(line, patterns, scan, true).ratio)
    assert.ok(median(raw) > 0.35, `ungated median ${(median(raw) * 100).toFixed(1)}% should be noisy`)
    assert.ok(median(gated) <= 0.20, `gated median ${(median(gated) * 100).toFixed(1)}% should be ≤ 20%`)
  })

  // ---- QA Round 1 发现的缺陷回归守卫 ----

  test('老配置（无 tier / 旧组名）也能只读派生档位，闸真正生效', async () => {
    const { keywordPresets } = await import('../../client/common/keyword-presets.js')
    const { activeKeywords, applySemanticTier, setTierOn, isStructureTierOn } = await loadGroups()
    const { compileKeywords, clearKeywordCache } = await loadCompile()
    const { buildScan, collectMatches, applyCoverageGate } = gateCache
    // 批次 1/2 之前写入的存量配置：全量 preset 规则，没有 tier，带旧组名
    const legacy = keywordPresets.flatMap(p => p.keywords.map(k => ({
      keyword: k.keyword, color: k.color, source: 'preset', group: 'OLD-' + p.name
    })))
    assert.equal(legacy.filter(r => r.tier).length, 0, 'fixture must have no tier field')

    const measure = (list) => {
      clearKeywordCache()
      const keywords = activeKeywords(list)
      const patterns = compileKeywords(keywords)
      const scan = buildScan(patterns)
      const hits = applyCoverageGate(dirtyLine, collectMatches(dirtyLine, patterns, scan, 512))
      return {
        structure: keywords.filter(k => k.tier === 'structure').length,
        ratio: hits.reduce((n, h) => n + (h.end - h.start), 0) / dirtyLine.length,
        ui: isStructureTierOn(list)
      }
    }
    // 原样加载：档位必须被派生出来，否则闸走快路径、93% 花屏照旧
    const raw = measure(legacy)
    assert.ok(raw.structure > 0, 'legacy preset rules must derive structure tier')
    assert.equal(raw.ratio, 0, 'dirty line must be gated for legacy config too')
    assert.equal(raw.ui, true, 'UI toggle must agree with the effective tier')
    // 点「全部应用」→ 结构档关；再手动打开 → 结构档开且闸仍生效
    const semantic = applySemanticTier(legacy)
    assert.equal(measure(semantic).structure, 0)
    assert.equal(isStructureTierOn(semantic), false)
    const reopened = setTierOn(semantic, 'structure', true)
    const back = measure(reopened)
    assert.ok(back.structure > 0)
    assert.equal(back.ratio, 0)
    assert.equal(back.ui, true)
    assert.equal(isStructureTierOn(setTierOn(reopened, 'structure', false)), false)
  })

  test('ANSI/OSC 把物理行切成多段时，闸仍按整行算（不退化成片段级）', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { clearKeywordCache } = await loadCompile()
    const { collectMatches, applyCoverageGate } = gateCache
    clearKeywordCache()
    const { keywords, patterns, scan } = await buildPatterns(true)
    // 一行 199 字符：前半 10 个 IP（88.9%），后半 1 个 IP + 100 普通字符（7.3%）
    // 整行 88/199 = 44.2% > 35% → 整行 structure 命中都该丢
    const head = Array.from({ length: 10 }, (_, i) => '10.1.2.' + (i + 1)).join(' ')
    const line = head + ' ' + 'x'.repeat(100) + ' 10.1.2.99'
    const plainHits = applyCoverageGate(line, collectMatches(line, patterns, scan, 512))
    assert.equal(plainHits.filter(h => h.tier === 'structure').length, 0,
      'whole physical line is over threshold')

    // addon 构造函数要的是原始 keywords（内部自己编译），传已编译 patterns 会退化成
    // 空规则集，让断言变成假阳性。先自检无 ANSI 时确实有染色，再比对插入 SGR 的结果。
    const addon = new KeywordHighlighterAddon(keywords)
    // 自检：规则确实生效（净行里的 IP 会被染色），否则「0 命中」可能是空规则集的假阳性
    const sanity = addon.highlightKeywords('host 10.1.2.3 ' + 'y'.repeat(80))
    assert.ok(sanity.includes('\u001b[38;2;255;158;203m10.1.2.3'), 'fixture sanity: addon must be live')
    // 脏行整行 44% > 35%，无 ANSI 与有 ANSI 都必须把 structure 全丢掉
    assert.equal(addon.highlightKeywords(line).includes('\u001b[38;2;255;158;203m'), false,
      'plain dirty line drops all structure hits')
    const splitAt = head.length + 1
    const sgr = '\u001b[32m\u001b[0m'
    const withAnsi = line.slice(0, splitAt) + sgr + line.slice(splitAt)
    const out = addon.highlightKeywords(withAnsi)
    const ipColor = '\u001b[38;2;255;158;203m'
    const colored = out.split(ipColor).length - 1
    assert.equal(colored, 0, 'SGR must not shrink the physical line into two gate windows')
    assert.ok(out.includes(sgr), 'the ANSI sequence itself must be preserved verbatim')
  })

  test('净行夹带 ANSI 不会被误判成脏行', async () => {
    const { KeywordHighlighterAddon } = await loadAddon()
    const { clearKeywordCache } = await loadCompile()
    clearKeywordCache()
    const { keywords } = await buildPatterns(true)
    const addon = new KeywordHighlighterAddon(keywords)
    // 一个 IP + 大量普通字符：整行远低于 35%，IP 应保留
    const line = '10.1.2.3 ' + 'x'.repeat(160)
    const sgr = '\u001b[31m\u001b[0m'
    const out = addon.highlightKeywords(line.slice(0, 20) + sgr + line.slice(20))
    assert.ok(out.includes('\u001b[38;2;255;158;203m10.1.2.3'),
      'clean line must keep its IP colouring despite an embedded SGR')
  })

  test('跨 \\n 的命中按行分摊染色面积，任一行超阈值即整条丢弃', () => {
    const { applyCoverageGate } = gateCache
    const content = 'XXXXXXXXXX\nCD'
    const hit = { start: 9, end: 13, tier: 'structure' }
    // 第二行 CD 被 2/2=100% 染色；旧实现只把 1 字符算进第一行 → 命中存活
    assert.equal(applyCoverageGate(content, [hit]).length, 0,
      'cross-line hit must be attributed to every line it covers')
    const clean = 'XXXXXXXXXX\n' + 'y'.repeat(40) + '\nCD'
    const cleanHit = { start: 9, end: 12, tier: 'structure' }
    assert.equal(applyCoverageGate(clean, [cleanHit]).length, 1,
      'a cross-line hit with low coverage must survive')
  })

  test('CRLF 的 \\r 不计入可见行长（不翻转 35% 判定）', () => {
    const { applyCoverageGate } = gateCache
    const hit = { start: 0, end: 35, tier: 'structure' }
    const lf = 'x'.repeat(35) + 'y'.repeat(64) + '\n'
    const crlf = lf.replace('\n', '\r\n')
    assert.equal(applyCoverageGate(lf, [hit]).length, 0, 'LF: 35/99 > 35% → drop')
    assert.equal(applyCoverageGate(crlf, [hit]).length, 0, 'CRLF must give the same verdict')
  })

  test('opts 健壮性：非法 threshold 退回默认值，enabled=false 直通', () => {
    const { applyCoverageGate } = gateCache
    const line = 'x'.repeat(35) + 'y'.repeat(64)
    const hit = { start: 0, end: 35, tier: 'structure' }
    assert.equal(applyCoverageGate(line, [hit], { threshold: NaN }).length, 0)
    assert.equal(applyCoverageGate(line, [hit], { enabled: false }).length, 1)
    assert.equal(applyCoverageGate(line, [hit], { threshold: -1 }).length, 0)
  })
})
