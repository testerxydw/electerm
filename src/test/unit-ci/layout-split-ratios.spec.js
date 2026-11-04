// 分屏比例模型（S2-4 / #4549）：几何（确实是按比例落位）与约束（拖不穿、
// 拖不没）都钉在纯函数上，DOM 那一层只剩事件接线。
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

let layoutAlg
let calcSessionSize
let split

before(async () => {
  layoutAlg = (await import('../../../src/client/components/layout/layout-alg.js')).default
  calcSessionSize = (await import('../../../src/client/components/layout/session-size-alg.js')).default
  split = await import('../../../src/client/components/layout/split-ratios.js')
})

describe('layoutAlg with ratios', () => {
  it('keeps the 50/50 divider when no ratio is stored', () => {
    const r = layoutAlg('c2', 1000, 600, undefined)
    assert.equal(r.wrapStyles[0].right, '498px')
    assert.equal(r.wrapStyles[1].left, '502px')
    assert.equal(r.handleStyles[0].left, '498px')
  })

  it('honors a dragged boundary', () => {
    const r = layoutAlg('c2', 1000, 600, [0.3])
    assert.equal(r.wrapStyles[0].right, '298px')
    assert.equal(r.wrapStyles[1].left, '302px')
    assert.equal(r.handleStyles[0].left, '298px')
  })

  it('uses both boundaries of a three column layout', () => {
    const r = layoutAlg('c3', 900, 600, [0.2, 0.6])
    assert.equal(r.wrapStyles[0].right, (900 * 0.2 - 2) + 'px')
    assert.equal(r.wrapStyles[1].left, (900 * 0.2 + 2) + 'px')
    assert.equal(r.wrapStyles[1].right, (900 * 0.6 - 2) + 'px')
    assert.equal(r.wrapStyles[2].left, (900 * 0.6 + 2) + 'px')
  })

  it('splits the grid on both axes', () => {
    const r = layoutAlg('c2x2', 800, 500, [0.4, 0.7])
    assert.equal(r.wrapStyles[0].right, (800 * 0.4 - 2) + 'px')
    assert.equal(r.wrapStyles[0].bottom, (500 * 0.7 - 2) + 'px')
    assert.equal(r.wrapStyles[3].left, (800 * 0.4 + 2) + 'px')
    assert.equal(r.wrapStyles[3].top, (500 * 0.7 + 2) + 'px')
  })

  it('keeps the right column divider inside its column', () => {
    const r = layoutAlg('c1r2', 1000, 600, [0.3, 0.5])
    assert.equal(r.handleStyles[1].left, (1000 * 0.3 + 2) + 'px')
    assert.equal(r.handleStyles[1].top, (600 * 0.5 - 2) + 'px')
  })

  it('falls back to defaults for stale ratio arrays', () => {
    for (const bad of [null, [0.5, 0.6, 0.7], [0, 0.5], [0.5, 0.2], ['x', 0.5]]) {
      const r = layoutAlg('c3', 900, 600, bad)
      assert.equal(r.handleStyles[0].left, (900 / 3 - 2) + 'px', String(bad))
    }
  })
})

describe('calcSessionSize with ratios', () => {
  // 像素是浮点乘出来的，比较时容差 0.001px 就够
  const close = (actual, expected) => {
    assert.deepEqual(actual.map(Math.round), expected.map(Math.round))
  }

  it('sums to the full width and matches the column boundaries', () => {
    const s = calcSessionSize('c3', 900, 600, [0.2, 0.6])
    close(s.map(x => x.width), [180, 360, 360])
    close(s.map(x => x.height), [600, 600, 600])
  })

  it('splits rows vertically', () => {
    const s = calcSessionSize('r3', 900, 600, [0.25, 0.75])
    close(s.map(x => x.height), [150, 300, 150])
  })

  it('builds the grid from both axes', () => {
    const s = calcSessionSize('c2x2', 800, 500, [0.4, 0.7])
    close(s.map(x => x.width), [320, 480, 320, 480])
    close(s.map(x => x.height), [350, 350, 150, 150])
  })

  it('gives the wide pane of c1r2 the full height', () => {
    const s = calcSessionSize('c1r2', 1000, 600, [0.3, 0.5])
    close([s[0].width, s[0].height], [300, 600])
    close([s[1].width, s[1].height], [700, 300])
    close([s[2].width, s[2].height], [700, 300])
  })

  it('gives the wide pane of r1c2 the full width', () => {
    const s = calcSessionSize('r1c2', 1000, 600, [0.25, 0.6])
    close([s[0].width, s[0].height], [1000, 150])
    close([s[1].width, s[1].height], [600, 450])
    close([s[2].width, s[2].height], [400, 450])
  })
})

describe('dragRatio', () => {
  it('turns a pixel delta into a fraction of the axis', () => {
    const out = split.dragRatio('c2', 0, [0.5], 100, { width: 1000, height: 600 })
    assert.deepEqual(out, [0.6])
  })

  it('never lets a pane fall below the minimum width', () => {
    const out = split.dragRatio('c2', 0, [0.5], -2000, { width: 1000, height: 600 })
    assert.equal(out[0], split.MIN_PANE_PX / 1000)
  })

  it('keeps two boundaries ordered with a pane between them', () => {
    const out = split.dragRatio('c3', 0, [0.3, 0.7], 900, { width: 1000, height: 600 })
    assert.ok(out[0] < out[1])
    assert.equal(out[1], 0.7)
    assert.equal(out[0], 0.7 - split.MIN_PANE_PX / 1000)
  })

  it('uses height for row layouts', () => {
    const out = split.dragRatio('r2', 0, [0.5], 60, { width: 1000, height: 600 })
    assert.deepEqual(out, [0.6])
  })

  it('does not mutate the input ratios', () => {
    const base = [0.5]
    split.dragRatio('c2', 0, base, 100, { width: 1000, height: 600 })
    assert.deepEqual(base, [0.5])
  })

  it('ignores unknown handles and broken geometry', () => {
    const base = [0.5]
    assert.deepEqual(split.dragRatio('c1', 0, base, 100, { width: 1000, height: 600 }), [])
    assert.deepEqual(split.dragRatio('c2', 0, base, 100, { width: 0, height: 600 }), base)
  })
})
