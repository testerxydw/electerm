/**
 * N12d ER 层间交叉最小化 —— 契约 spec
 *
 * 布局纯函数的既有分层/换行/上限契约在 db-er-layout.spec.js，这里只钉新增的那一层：
 * ① countErCrossings 与渲染层 edgePath 的起终点口径一致（不是自造的近似指标）；
 * ② 默认布局比 minimizeCrossings:false 的旧口径交叉更少，且在任何输入下都不劣化；
 * ③ 优化是确定性的、不改返回结构、不破坏节点/层/坐标契约。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '../../..')
const LAYOUT_JS = path.join(ROOT, 'src/client/common/db-er-layout.js')
const VIEW_JSX = path.join(ROOT, 'src/client/components/database/db-er-view.jsx')
let LAYOUT
before(async () => {
  LAYOUT = await import('file://' + LAYOUT_JS)
})

const T = (name, schema = 'shop') => ({ schema, name })
const EDGE = (from, to, name = 'fk_' + from + '_' + to) => ({
  name,
  from: T(from),
  to: T(to),
  columns: [{ from: 'ref_id', to: 'id' }]
})

// 确定性伪随机：同一 seed 永远得到同一份外键图，断言才能写死数字
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function buildGraph (n, seed) {
  const r = rng(seed)
  const tables = []
  for (let i = 0; i < n; i++) tables.push(T('t' + String(i).padStart(3, '0')))
  const edges = []
  for (let i = 0; i < n; i++) {
    const k = 1 + Math.floor(r() * 3)
    for (let j = 0; j < k; j++) {
      const to = Math.min(n - 1, i + 1 + Math.floor(r() * Math.max(1, n - i - 1)))
      if (to <= i) continue
      edges.push(EDGE('t' + String(i).padStart(3, '0'), 't' + String(to).padStart(3, '0'), 'fk_' + i + '_' + to + '_' + j))
    }
  }
  return { schema: 'shop', tables, edges }
}

const node = (id, x, y, w = 100, h = 46) => ({ id, x, y, w, h, layer: 0 })
const seg = (fromId, toId) => ({ fromId, toId })

describe('countErCrossings 是渲染口径', () => {
  test('两条明确交叉的边 = 1；两条平行边 = 0', () => {
    const crossed = {
      nodes: [node('a', 0, 0), node('b', 200, 0), node('c', 200, 150), node('d', 0, 150)],
      edges: [seg('a', 'c'), seg('b', 'd')]
    }
    assert.equal(LAYOUT.countErCrossings(crossed), 1, 'a→c 与 b→d 在中间穿过')
    const parallel = {
      nodes: [node('a', 0, 0), node('b', 200, 0), node('c', 0, 150), node('d', 200, 150)],
      edges: [seg('a', 'c'), seg('b', 'd')]
    }
    assert.equal(LAYOUT.countErCrossings(parallel), 0, '两条竖线不相交')
  })

  test('共享端点不算交叉、自环跳过、空布局返回 0', () => {
    const shared = {
      nodes: [node('a', 100, 0), node('b', 0, 150), node('c', 200, 150)],
      edges: [seg('a', 'b'), seg('a', 'c')]
    }
    assert.equal(LAYOUT.countErCrossings(shared), 0, '同一起点的两条边不算交叉')
    const selfLoop = {
      nodes: [node('a', 100, 0)],
      edges: [seg('a', 'a')]
    }
    assert.equal(LAYOUT.countErCrossings(selfLoop), 0, '自引用不参与交叉计量')
    assert.equal(LAYOUT.countErCrossings(null), 0)
    assert.equal(LAYOUT.countErCrossings({ nodes: [], edges: [] }), 0)
  })

  test('起终点公式与 db-er-view.jsx 的 edgePath 同源', () => {
    const src = fs.readFileSync(VIEW_JSX, 'utf8')
    for (const expr of ['a.x + a.w / 2', 'a.y + a.h', 'b.x + b.w / 2', 'b.y']) {
      assert.ok(src.includes(expr), '渲染层公式缺 ' + expr + '——交叉指标会与用户看到的图脱节')
    }
    const layoutSrc = fs.readFileSync(LAYOUT_JS, 'utf8')
    for (const expr of ['a.x + a.w / 2', 'a.y + a.h', 'b.x + b.w / 2', 'b.y']) {
      assert.ok(layoutSrc.includes(expr), '布局侧公式缺 ' + expr)
    }
  })
})

describe('交叉最小化效果与回退开关', () => {
  test('24 表图：默认布局交叉数低于旧口径，且旧口径基线仍是 55', () => {
    const g = buildGraph(24, 20261111)
    const base = LAYOUT.layoutErGraph(g, { minimizeCrossings: false })
    const opt = LAYOUT.layoutErGraph(g)
    const b = LAYOUT.countErCrossings(base)
    const o = LAYOUT.countErCrossings(opt)
    assert.equal(b, 55, '旧口径基线不许漂（换算法时这条会先红）')
    assert.ok(o < b, '默认布局必须比旧口径更少交叉：' + o + ' vs ' + b)
    assert.ok(o <= b * 0.75, '至少降 25%，实得 ' + ((b - o) / b * 100).toFixed(1) + '%')
  })

  test('40 表图：交叉数至少降 45%（I6 点名的 20+ 表场景）', () => {
    const g = buildGraph(40, 20261111)
    const b = LAYOUT.countErCrossings(LAYOUT.layoutErGraph(g, { minimizeCrossings: false }))
    const o = LAYOUT.countErCrossings(LAYOUT.layoutErGraph(g))
    assert.equal(b, 283, '40 表基线固定为 283')
    assert.ok(o <= b * 0.55, '40 表降幅不足：' + o + ' vs ' + b)
  })

  test('多组规模/seed 下永不劣化（几何复核保险生效）', () => {
    for (const n of [2, 3, 7, 12, 24, 40, 80]) {
      for (const seed of [1, 20261111, 987654321]) {
        const g = buildGraph(n, seed)
        const b = LAYOUT.countErCrossings(LAYOUT.layoutErGraph(g, { minimizeCrossings: false }))
        const o = LAYOUT.countErCrossings(LAYOUT.layoutErGraph(g))
        assert.ok(o <= b, `n=${n} seed=${seed} 优化反而变乱：${o} > ${b}`)
      }
    }
  })
})

describe('优化不破坏既有布局契约', () => {
  test('同一份图两次布局逐字段一致（确定性，不是随机爬山）', () => {
    const g = buildGraph(40, 20261111)
    const a = LAYOUT.layoutErGraph(g)
    const b = LAYOUT.layoutErGraph(g)
    assert.deepEqual(a.nodes, b.nodes, '节点坐标/层号/度数必须完全一致')
    assert.deepEqual(a, b, '整个返回对象都要一致')
  })

  test('返回结构不变，节点数/边数/层号/坐标都不因优化而丢', () => {
    const g = buildGraph(40, 20261111)
    const base = LAYOUT.layoutErGraph(g, { minimizeCrossings: false })
    const opt = LAYOUT.layoutErGraph(g)
    assert.deepEqual(Object.keys(opt).sort(), Object.keys(base).sort(), '不许偷偷加字段（既有 spec 用 deepEqual 钉过返回结构）')
    assert.equal(opt.nodes.length, base.nodes.length)
    assert.equal(opt.edges.length, base.edges.length)
    assert.equal(opt.total, base.total)
    assert.equal(opt.kept, base.kept)
    assert.equal(opt.truncated, base.truncated)
    assert.ok(opt.width > 0 && opt.height > 0)
    const ids = new Set(opt.nodes.map(n => n.id))
    for (const e of opt.edges) {
      assert.ok(ids.has(e.fromId) && ids.has(e.toId), '边端点不能因重排丢掉')
    }
    for (const n of opt.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isInteger(n.layer) && n.layer >= 0,
        '节点坐标与层号必须是有效值：' + n.id)
    }
  })

  test('退化输入不抛错：空图 / 无边 / 单边 / 全环 / 自引用 / 超上限', () => {
    const cases = [
      null,
      { tables: [], edges: [] },
      { tables: [T('a'), T('b')], edges: [] },
      { tables: [T('a'), T('b')], edges: [EDGE('a', 'b')] },
      { tables: [T('a'), T('b')], edges: [EDGE('a', 'b'), EDGE('b', 'a')] },
      { tables: [T('a')], edges: [EDGE('a', 'a', 'self')] },
      buildGraph(260, 42)
    ]
    for (const g of cases) {
      const res = LAYOUT.layoutErGraph(g)
      assert.ok(Array.isArray(res.nodes) && Array.isArray(res.edges), '退化输入也要返回可画的结构')
      assert.ok(Number.isFinite(LAYOUT.countErCrossings(res)), '退化输入交叉数必须是数字')
    }
  })

  test('边数超过 400 时跳过优化，结果与旧口径完全一致', () => {
    const tables = []
    const edges = []
    for (let i = 0; i < 60; i++) tables.push(T('t' + String(i).padStart(3, '0')))
    for (let i = 0; i < 450; i++) {
      edges.push(EDGE('t' + String(i % 30).padStart(3, '0'), 't' + String(30 + (i % 30)).padStart(3, '0'), 'fk_' + i))
    }
    const base = LAYOUT.layoutErGraph({ tables, edges }, { minimizeCrossings: false })
    const opt = LAYOUT.layoutErGraph({ tables, edges })
    assert.equal(opt.edges.length, 450, '边没被节点上限截掉')
    assert.deepEqual(opt, base, '超边数护栏后应完全走旧路径，避免打开 ER 卡顿')
  })

  test('无重心信息的同层仍按度数降序 + 名称升序（既有口径不破）', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('b'), T('a'), T('hub')],
      edges: [EDGE('a', 'hub'), EDGE('b', 'hub')]
    })
    assert.deepEqual(res.nodes.filter(n => n.layer === 0).map(n => n.name), ['a', 'b'])
  })
})
