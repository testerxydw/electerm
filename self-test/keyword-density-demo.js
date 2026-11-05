#!/usr/bin/env node
/**
 * 关键字高亮密度探针（V2 §1 / §9 的可复现版）
 *
 * 文档 §9 原计划用 CDP 实机 + 15 行语料验收。这里把「同一份语料 + 同一条生效链路」
 * 固化成纯 Node 脚本：不依赖 Electron/xvfb，可在任意时刻重跑、可与 CI 对齐口径。
 * 真实终端渲染（ANSI → xterm 单元格前景色）仍由 kw-preset-merge-demo.js 那类
 * CDP 脚本承担；本脚本负责给出密度数字，并断言 §9 的两条硬门槛。
 *
 * 链路与线上完全一致：
 *   applySemanticTier / setTierOn → activeKeywords → compileKeywords
 *   → buildScan + collectMatches → applyCoverageGate
 *
 * 用法： node --experimental-detect-module self-test/keyword-density-demo.js
 */
const assert = require('node:assert/strict')

// 与 src/test/unit-ci/keyword-density.spec.js 完全相同的固定语料
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

const dirtyLine = '/var/log/electerm/sessions/2026-11-05/worker.log'
const cleanLines = Array.from({ length: 9 }, (_, i) =>
  `the quick brown fox jumps over the lazy dog near 10.1.2.${10 + i} on a quiet afternoon`
)
const multiLineChunk = [dirtyLine, ...cleanLines].join('\n')

const pct = n => (n * 100).toFixed(1).padStart(5) + '%'
const median = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]

const main = async () => {
  const { applySemanticTier, activeKeywords, setTierOn, isStructureTierOn } =
    await import('../src/client/common/keyword-groups.js')
  const { compileKeywords, clearKeywordCache } =
    await import('../src/client/common/keyword-compile.js')
  const { buildScan, collectMatches, applyCoverageGate } =
    await import('../src/client/common/keyword-scan.js')

  const prepare = withStructure => {
    clearKeywordCache()
    const list = withStructure
      ? setTierOn(applySemanticTier([]), 'structure', true)
      : applySemanticTier([])
    const patterns = compileKeywords(activeKeywords(list))
    return { list, patterns, scan: buildScan(patterns) }
  }

  const ratios = (patterns, scan, gate) => corpus.map(line => {
    let hits = collectMatches(line, patterns, scan, 512)
    if (gate) {
      hits = applyCoverageGate(line, hits)
    }
    return hits.reduce((n, h) => n + (h.end - h.start), 0) / (line.length || 1)
  })

  console.log('=== 关键字高亮密度报告（V2 批次 3）===\n')

  const semantic = prepare(false)
  const semanticRatios = ratios(semantic.patterns, semantic.scan, true)
  console.log('A) 默认「全部应用」= 应用语义档')
  console.log('   生效规则:', activeKeywords(semantic.list).length,
    '| structure:', activeKeywords(semantic.list).filter(k => k.tier === 'structure').length,
    '| 结构档开关:', isStructureTierOn(semantic.list))
  console.log('   逐行染色率:', semanticRatios.map(r => (r * 100).toFixed(0) + '%').join(' '))
  console.log('   中位单行染色率:', pct(median(semanticRatios)), '(门槛 ≤ 20%)\n')

  const full = prepare(true)
  const rawRatios = ratios(full.patterns, full.scan, false)
  const gatedRatios = ratios(full.patterns, full.scan, true)
  console.log('B) 手动打开结构档（100 条全上）')
  console.log('   未过闸逐行:', rawRatios.map(r => (r * 100).toFixed(0) + '%').join(' '))
  console.log('   未过闸中位:', pct(median(rawRatios)))
  console.log('   过闸后逐行:', gatedRatios.map(r => (r * 100).toFixed(0) + '%').join(' '))
  console.log('   过闸后中位:', pct(median(gatedRatios)), '(门槛 ≤ 20%)\n')

  console.log('C) 93% 脏行 + 1 脏 9 净多行片段（按行算，不能被净行平均掉）')
  const all = collectMatches(multiLineChunk, full.patterns, full.scan, 512)
  const gated = applyCoverageGate(multiLineChunk, all)
  const wholeRatio = all.reduce((n, h) => n + (h.end - h.start), 0) / multiLineChunk.length
  const dirtyEnd = dirtyLine.length
  console.log('   脏行染色率:', pct(collectMatches(dirtyLine, full.patterns, full.scan, 512)
    .reduce((n, h) => n + (h.end - h.start), 0) / dirtyLine.length),
  '→ 闸后', pct(applyCoverageGate(dirtyLine,
    collectMatches(dirtyLine, full.patterns, full.scan, 512))
    .reduce((n, h) => n + (h.end - h.start), 0) / dirtyLine.length))
  console.log('   整片段平均:', pct(wholeRatio), '(< 35%：按片段算会漏掉脏行)')
  console.log('   脏行 structure 残留:', gated.filter(h => h.start < dirtyEnd && h.tier === 'structure').length)
  console.log('   ' + cleanLines.length + ' 行净 structure 保留:', gated.filter(h => h.start > dirtyEnd && h.tier === 'structure').length, '\n')

  // §9 还要求「错误/警告词仍染色」：用真实终端 addon 验证 signal 永不被闸丢弃
  const { KeywordHighlighterAddon } = await import('../src/client/components/terminal/highlight-addon.js')
  clearKeywordCache()
  const terminal = new KeywordHighlighterAddon(activeKeywords(full.list))
  const errorLine = terminal.highlightKeywords('ERROR 1146: Table users does not exist')
  const warnLine = terminal.highlightKeywords('WARNING: deprecated API in use')
  assert.ok(errorLine.includes('\u001b[31mERROR'), 'error word must stay coloured')
  assert.ok(warnLine.includes('\u001b[33mWARNING'), 'warning word must stay coloured')
  console.log('D) 语义信号保底：ERROR → 红 / WARNING → 黄 ✓\n')

  // §9 硬门槛
  assert.ok(median(semanticRatios) <= 0.20, '默认全选中位染色率必须 ≤ 20%')
  assert.ok(median(gatedRatios) <= 0.20, '结构档开启且过闸后中位染色率必须 ≤ 20%')
  assert.ok(median(rawRatios) > 0.35, '未过闸时应明显偏密（证明闸确实起了作用）')
  assert.equal(activeKeywords(semantic.list).filter(k => k.tier === 'structure').length, 0)
  assert.equal(gated.filter(h => h.start < dirtyEnd && h.tier === 'structure').length, 0)
  assert.equal(gated.filter(h => h.start > dirtyEnd && h.tier === 'structure').length, cleanLines.length)
  console.log('✓ §9 密度回归门槛全部通过')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
