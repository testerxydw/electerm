/**
 * H3b ER 布局纯函数：分层 / 同层排序 / 环与自引用 / 孤立表 / 200 节点上限 / 层内换行
 *
 * 布局是画图前唯一会"想错"的地方（分层反了就是父子颠倒，环没破就是死循环），
 * 所以全部用断言钉住：同一份输入永远得到同一张图。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const LAYOUT_JS = path.join(ROOT, 'src/client/common/db-er-layout.js')
let LAYOUT
before(async () => {
  LAYOUT = await import('file://' + LAYOUT_JS)
})

const T = (name, schema = 'db') => ({ schema, name })
const EDGE = (from, to, name = 'fk_' + from + '_' + to) => ({
  name,
  from: T(from),
  to: T(to),
  columns: [{ from: 'x', to: 'id' }]
})

function byId (res) {
  const m = new Map()
  for (const n of res.nodes) {
    m.set(n.name, n)
  }
  return m
}

describe('layoutErGraph 分层', () => {
  test('没人引用的表先出现，被引用的表逐层下沉', () => {
    // child -> parent -> grand：入度 0 的是 child
    const res = LAYOUT.layoutErGraph({
      tables: [T('child'), T('parent'), T('grand')],
      edges: [EDGE('child', 'parent'), EDGE('parent', 'grand')]
    })
    const m = byId(res)
    assert.equal(m.get('child').layer, 0)
    assert.equal(m.get('parent').layer, 1)
    assert.equal(m.get('grand').layer, 2)
    assert.ok(m.get('child').y < m.get('parent').y && m.get('parent').y < m.get('grand').y,
      '层号大的在下面（y 递增）')
  })

  test('同层按度数降序、名称升序', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('b'), T('a'), T('hub')],
      edges: [EDGE('a', 'hub'), EDGE('b', 'hub')]
    })
    // a / b 同层（入度 0），度数相同 → 名称升序
    const layer0 = res.nodes.filter(n => n.layer === 0).map(n => n.name)
    assert.deepEqual(layer0, ['a', 'b'])
    const res2 = LAYOUT.layoutErGraph({
      tables: [T('a'), T('b'), T('hub'), T('hub2')],
      edges: [EDGE('a', 'hub'), EDGE('a', 'hub2'), EDGE('b', 'hub')]
    })
    const l0 = res2.nodes.filter(n => n.layer === 0).map(n => n.name)
    assert.deepEqual(l0, ['a', 'b'], '度数高的 a 排到 b 前面')
  })

  test('孤立表也出图，单独一层不连线', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('child'), T('parent'), T('lonely')],
      edges: [EDGE('child', 'parent')]
    })
    const m = byId(res)
    assert.ok(m.get('lonely'), '孤立表不能丢')
    assert.equal(m.get('lonely').degree, 0)
    assert.equal(res.edges.length, 1)
  })
})

describe('layoutErGraph 环与自引用', () => {
  test('A→B→A 的环能排完，两个节点都在且层号不同', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('a'), T('b')],
      edges: [EDGE('a', 'b'), EDGE('b', 'a')]
    })
    const m = byId(res)
    assert.equal(res.nodes.length, 2)
    assert.equal(m.get('a').layer, 0, '破环先取名称最小的')
    assert.equal(m.get('b').layer, 1)
    assert.equal(res.edges.length, 2, '边不因破环被丢')
  })

  test('自引用边保留但不影响分层（否则永远排不完）', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('emp')],
      edges: [EDGE('emp', 'emp', 'mgr')]
    })
    assert.equal(res.nodes.length, 1)
    assert.equal(res.nodes[0].layer, 0)
    assert.equal(res.edges.length, 1)
    assert.equal(res.nodes[0].degree, 1, '自环算一条关联（节点角标用）')
  })

  test('所有节点都在环上也能排完（强连通三节点）', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('a'), T('b'), T('c')],
      edges: [EDGE('a', 'b'), EDGE('b', 'c'), EDGE('c', 'a')]
    })
    assert.equal(res.nodes.length, 3)
    assert.deepEqual(res.nodes.map(n => n.name).sort(), ['a', 'b', 'c'])
  })
})

describe('layoutErGraph 上限与换行', () => {
  const many = (n, linked) => {
    const tables = []
    const edges = []
    for (let i = 0; i < n; i++) {
      tables.push(T('t' + String(i).padStart(3, '0')))
    }
    for (let i = 0; i < linked; i++) {
      edges.push(EDGE('t' + String(i).padStart(3, '0'), 't' + String(i + 1).padStart(3, '0')))
    }
    return { tables, edges }
  }

  test('超过 200 个表只留有外键关联的，并被标记 truncated', () => {
    const g = many(260, 20)
    const res = LAYOUT.layoutErGraph(g)
    assert.equal(res.truncated, true)
    assert.equal(res.total, 260)
    assert.equal(res.kept, 21, '20 条边覆盖 21 个表')
    assert.equal(res.nodes.length, 21)
    assert.ok(res.isolated >= 239)
    assert.ok(res.edges.length === 20, '端点被截掉的边不再画')
  })

  test('关联表也超 200 时按名称截断，结果确定', () => {
    const tables = []
    const edges = []
    for (let i = 0; i < 240; i++) {
      tables.push(T('t' + String(i).padStart(3, '0')))
    }
    for (let i = 0; i < 239; i++) {
      edges.push(EDGE('t' + String(i).padStart(3, '0'), 't' + String(i + 1).padStart(3, '0')))
    }
    const res = LAYOUT.layoutErGraph({ tables, edges })
    assert.equal(res.kept, LAYOUT.ER_MAX_NODES)
    const again = LAYOUT.layoutErGraph({ tables, edges })
    assert.deepEqual(res.nodes.map(n => n.name), again.nodes.map(n => n.name), '两次布局完全一致')
  })

  test('一层超过 6 个节点换行，第二个 6 排在同一层更下方', () => {
    const tables = []
    const edges = []
    for (let i = 0; i < 7; i++) {
      tables.push(T('a' + i))
    }
    edges.push(EDGE('a0', 'hub'))
    tables.push(T('hub'))
    const res = LAYOUT.layoutErGraph({ tables, edges })
    const layer0 = res.nodes.filter(n => n.layer === 0)
    assert.equal(layer0.length, 7)
    const rows = new Set(layer0.map(n => n.y))
    assert.equal(rows.size, 2, '7 个节点分两行')
    const first = layer0.filter(n => n.y === Math.min(...rows))
    assert.equal(first.length, 6)
  })

  test('空图与空参数返回空布局，不抛错', () => {
    assert.deepEqual(LAYOUT.layoutErGraph(null), {
      nodes: [], edges: [], width: 0, height: 0, truncated: false, total: 0, kept: 0, isolated: 0
    })
    const res = LAYOUT.layoutErGraph({ tables: [], edges: [] })
    assert.equal(res.nodes.length, 0)
    assert.equal(res.width, 0)
  })

  test('节点宽按名长估算并夹在 150~320', () => {
    assert.equal(LAYOUT.erNodeWidth('a'), 150)
    assert.equal(LAYOUT.erNodeWidth('x'.repeat(100)), 320)
    const mid = LAYOUT.erNodeWidth('orders_item_history')
    assert.ok(mid > 150 && mid < 320, String(mid))
  })

  test('节点 id 是 schema.name，跨 schema 同名表不撞', () => {
    const res = LAYOUT.layoutErGraph({
      tables: [T('users', 'a'), T('users', 'b')],
      edges: []
    })
    assert.equal(res.nodes.length, 2)
    assert.deepEqual(res.nodes.map(n => n.id).sort(), ['a.users', 'b.users'])
  })
})
