const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/client')
const read = p => fs.readFileSync(p, 'utf8')

// 起因：2026-11-14 终端切成「全部渲染」后，DB 网格仍各自硬编码 coverageGate 默认开，
// 纯 IP 单元格（染色占比 100% > 当时的 35% 闸）被整格丢命中、完全不高亮。
// 本 spec 锁死「限制开关只有一处定义，两端只读」这一结构约束。
describe('keyword-limits: SSOT 契约（两端不得各自实现限制开关）', async () => {
  const { HIGHLIGHT_LIMITS, resolveHighlightOptions } =
    await import('../../client/common/keyword-limits.js')

  test('所有默认值集中在一处且取值固定', () => {
    assert.ok(Object.isFrozen(HIGHLIGHT_LIMITS), 'limits table must be frozen')
    assert.equal(HIGHLIGHT_LIMITS.coverageGateDefault, false)
    assert.equal(HIGHLIGHT_LIMITS.coverageThreshold, 0.6)
    assert.equal(HIGHLIGHT_LIMITS.maxHighlightLength, 4096)
    assert.equal(HIGHLIGHT_LIMITS.maxHighlightChunkLength, 4 * 1024 * 1024)
    assert.equal(HIGHLIGHT_LIMITS.maxMatchesPerSegment, 512)
    assert.equal(HIGHLIGHT_LIMITS.maxHitsPerCell, 200)
    assert.equal(HIGHLIGHT_LIMITS.maxPreviewLength, 100000)
    assert.equal(HIGHLIGHT_LIMITS.maxHitsPerPreview, 2000)
  })

  test('终端与网格默认都关闸；显式覆盖仍生效', () => {
    const terminal = resolveHighlightOptions()
    const grid = resolveHighlightOptions({}, 'grid')
    assert.equal(terminal.coverageGate, false, 'terminal default gate off')
    assert.equal(grid.coverageGate, false, 'grid default gate off (pure IP cell must highlight)')
    assert.equal(terminal.coverageThreshold, 0.6)
    assert.equal(grid.coverageThreshold, 0.6)
    assert.equal(resolveHighlightOptions({ coverageGate: true }).coverageGate, true)
    assert.equal(resolveHighlightOptions({ coverageGate: false }).coverageGate, false)
    assert.equal(resolveHighlightOptions({ coverageThreshold: 0.8 }).coverageThreshold, 0.8)
  })

  test('profile 决定命中上限默认值；调用方可逐项覆盖', () => {
    assert.equal(resolveHighlightOptions().maxHits, 512)
    assert.equal(resolveHighlightOptions({}, 'grid').maxHits, 200)
    assert.equal(resolveHighlightOptions().maxLength, 4096)
    assert.equal(resolveHighlightOptions().maxChunkLength, 4 * 1024 * 1024)
    assert.equal(resolveHighlightOptions({ maxHits: 3 }).maxHits, 3)
    assert.equal(resolveHighlightOptions({ maxLength: 100000 }).maxLength, 100000)
  })

  test('引擎层阈值与 SSOT 同源', async () => {
    const { defaultCoverageThreshold } = await import('../../client/common/keyword-scan.js')
    assert.equal(defaultCoverageThreshold, HIGHLIGHT_LIMITS.coverageThreshold)
    assert.match(
      read(path.join(CLIENT, 'common/keyword-scan.js')),
      /defaultCoverageThreshold\s*=\s*HIGHLIGHT_LIMITS\.coverageThreshold/
    )
  })

  test('两端都从 SSOT 取配置，不再各写开关判定或裸阈值', () => {
    const addon = read(path.join(CLIENT, 'components/terminal/highlight-addon.js'))
    const grid = read(path.join(CLIENT, 'components/database/db-highlight.jsx'))
    const pane = read(path.join(CLIENT, 'components/database/db-value-pane.jsx'))

    for (const [name, src] of [['terminal', addon], ['grid', grid]]) {
      assert.match(src, /keyword-limits\.js/, `${name} must import SSOT`)
      assert.match(src, /resolveHighlightOptions\(/, `${name} must resolve options from SSOT`)
      assert.doesNotMatch(src, /opts\.coverageGate\s*(?:!==|===)/, `${name} must not implement its own gate switch`)
      assert.doesNotMatch(src, /=\s*4096\b/, `${name} must not hardcode maxHighlightLength`)
      assert.doesNotMatch(src, /=\s*0\.(?:35|6)\b/, `${name} must not hardcode coverageThreshold`)
      assert.doesNotMatch(src, /coverageThreshold\s*:/, `${name} must read the threshold from SSOT`)
    }
    assert.match(pane, /maxLength\s*=\s*HIGHLIGHT_LIMITS\.maxPreviewLength/, 'preview length must come from SSOT')
    assert.match(pane, /maxHits\s*=\s*HIGHLIGHT_LIMITS\.maxHitsPerPreview/, 'preview hits must come from SSOT')
  })
})
