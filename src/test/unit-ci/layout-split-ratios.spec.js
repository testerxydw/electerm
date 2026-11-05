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

// CSS 语义：left/top 从容器左上角量，right/bottom 从对边往里量。
// 判据一律先把样式折算成"实际渲染出来的盒子"再断言：早先直接钉 right 的字面值，
// 等于把边界当宽度写反了也照样全绿，实机一拖就露馅（左格反而变宽、中间格塌成 0 宽）。
const px = v => Math.round((typeof v === 'string' ? parseFloat(v) : Number(v)) * 1000) / 1000
const boxOf = (w, h, s) => {
  const l = px(s.left)
  const t = px(s.top)
  return { l, t, w: px(w - l - px(s.right)), h: px(h - t - px(s.bottom)) }
}
const boxes = (layout, w, h, ratios) => layoutAlg(layout, w, h, ratios).wrapStyles.map(s => boxOf(w, h, s))

describe('layoutAlg with ratios', () => {
  it('keeps the 50/50 divider when no ratio is stored', () => {
    const r = layoutAlg('c2', 1000, 600, undefined)
    assert.equal(r.handleStyles[0].left, '498px')
    assert.deepEqual(boxes('c2', 1000, 600, undefined), [
      { l: 0, t: 0, w: 498, h: 600 },
      { l: 502, t: 0, w: 498, h: 600 }
    ])
  })

  it('honors a dragged boundary', () => {
    assert.equal(layoutAlg('c2', 1000, 600, [0.3]).handleStyles[0].left, '298px')
  })

  it('makes the left/top pane the ratio-sized one, not the complement', () => {
    // r=0.3 是左格占 30%：right 写成边界本身时左格会拿到 70%
    const c2 = boxes('c2', 1000, 600, [0.3])
    assert.deepEqual(c2, [
      { l: 0, t: 0, w: 298, h: 600 },
      { l: 302, t: 0, w: 698, h: 600 }
    ])
    const r2 = boxes('r2', 1000, 600, [0.7])
    assert.ok(r2[0].h > r2[1].h, 'r=0.7 时上格要比下格高：' + JSON.stringify(r2))
  })

  it('uses both boundaries of a three column layout', () => {
    assert.deepEqual(boxes('c3', 900, 600, [0.2, 0.6]), [
      { l: 0, t: 0, w: 178, h: 600 },
      { l: 182, t: 0, w: 356, h: 600 },
      { l: 542, t: 0, w: 358, h: 600 }
    ])
  })

  it('splits the grid on both axes', () => {
    const b = boxes('c2x2', 800, 500, [0.4, 0.7])
    assert.deepEqual(b[0], { l: 0, t: 0, w: 318, h: 348 })
    assert.deepEqual(b[3], { l: 322, t: 352, w: 478, h: 148 })
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

  it('tiles every layout: 每格有面积、互不重叠、并集铺满容器', () => {
    const W = 1000
    const H = 600
    const cases = {
      c1: [],
      c2: [0.3],
      c3: [0.2, 0.6],
      r2: [0.75],
      r3: [0.25, 0.7],
      c2x2: [0.4, 0.7],
      c1r2: [0.35, 0.5],
      r1c2: [0.4, 0.6]
    }
    for (const [layout, ratios] of Object.entries(cases)) {
      const bs = boxes(layout, W, H, ratios)
      for (const b of bs) {
        assert.ok(b.w > 0 && b.h > 0, layout + ' 每格都要有面积: ' + JSON.stringify(b))
        assert.ok(b.l >= 0 && b.t >= 0 && b.l + b.w <= W && b.t + b.h <= H, layout + ' 不能越出容器: ' + JSON.stringify(b))
      }
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i]
          const ow = Math.min(a.l + a.w, bs[j].l + bs[j].w) - Math.max(a.l, bs[j].l)
          const oh = Math.min(a.t + a.h, bs[j].t + bs[j].h) - Math.max(a.t, bs[j].t)
          assert.ok(!(ow > 0 && oh > 0), layout + ' 格子互不重叠: ' + JSON.stringify([a, bs[j]]))
        }
      }
      assert.equal(Math.max(...bs.map(b => b.l + b.w)), W, layout + ' 并集要铺满宽度')
      assert.equal(Math.max(...bs.map(b => b.t + b.h)), H, layout + ' 并集要铺满高度')
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
