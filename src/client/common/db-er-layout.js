/**
 * H3b：ER 图布局（纯函数，零依赖）
 *
 * 输入是后端 listForeignKeys 的归一图 { schema, tables, edges }，输出是可直接画的
 * 节点坐标 + 边上端点 id。不测量 DOM：节点宽按表名长度估算，高度固定，
 * 这样同一份 schema 每次打开都得到同一张图（可单测、可复现）。
 *
 * 分层：按"入度 0"逐层剥离（Kahn）。边方向是 子表 → 被引用表，所以入度 =
 * 引用它的表数；没人引用的表先出现。同层按总度数降序、名称升序 —— 关联多的
 * 表离图中心更近，名字稳定的排前面。剩余的环（A→B→A）按名称最小的节点破环
 * 后继续，保证任何输入都能排完。
 *
 * 每层最多 6 个节点一行，超了换行：宽图变成"层内多行"，不会拉成一条长带子。
 */

const NODE_H = 46
const CHAR_W = 7.2
const MIN_W = 150
const MAX_W = 320
const PAD = 32
const GAP_X = 36
const GAP_Y = 44
const MAX_PER_ROW = 6
export const ER_MAX_NODES = 200

export function erNodeId (t) {
  return String((t && t.schema) || '') + '.' + String((t && t.name) || '')
}

// 表名宽度估算：名字短也留 150（要放得下"n 个外键"这类副标题），长名封顶 320
export function erNodeWidth (name) {
  const w = Math.round(String(name || '').length * CHAR_W) + 56
  return Math.max(MIN_W, Math.min(MAX_W, w))
}

function sortLayer (list, degree) {
  return list.slice().sort((a, b) => {
    const da = degree.get(a) || 0
    const db = degree.get(b) || 0
    if (da !== db) {
      return db - da
    }
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * 分层：非自环边参与 Kahn，环上的节点按名称最小破环。
 * 返回层数组（每层是节点 id 数组，层内已排序）。
 */
function layerize (ids, edges, degree) {
  const incoming = new Map(ids.map(id => [id, 0]))
  const out = new Map(ids.map(id => [id, []]))
  for (const e of edges) {
    if (!incoming.has(e.fromId) || !incoming.has(e.toId) || e.fromId === e.toId) {
      continue
    }
    incoming.set(e.toId, incoming.get(e.toId) + 1)
    out.get(e.fromId).push(e.toId)
  }
  const left = new Set(ids)
  const layers = []
  while (left.size) {
    let ready = []
    for (const id of left) {
      if (!incoming.get(id)) {
        ready.push(id)
      }
    }
    // 全都在环上：按名称最小的那个破环（同层只放它，下一轮它的后继可能就解锁了）
    if (!ready.length) {
      ready = [Array.from(left).sort()[0]]
    }
    const layer = sortLayer(ready, degree)
    layers.push(layer)
    for (const id of layer) {
      left.delete(id)
      for (const to of out.get(id) || []) {
        if (left.has(to)) {
          incoming.set(to, Math.max(0, incoming.get(to) - 1))
        }
      }
      incoming.set(id, 0)
    }
  }
  return layers
}

/**
 * @param {{tables: Array, edges: Array}} graph  后端归一图
 * @param {{maxNodes?: number, maxPerRow?: number}} [opts]
 * @returns {{nodes: Array, edges: Array, width: number, height: number,
 *           truncated: boolean, total: number, kept: number, isolated: number}}
 */
export function layoutErGraph (graph, opts = {}) {
  const maxNodes = Number.isInteger(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : ER_MAX_NODES
  const perRow = Number.isInteger(opts.maxPerRow) && opts.maxPerRow > 0 ? opts.maxPerRow : MAX_PER_ROW
  const rawTables = (graph && Array.isArray(graph.tables)) ? graph.tables : []
  const rawEdges = (graph && Array.isArray(graph.edges)) ? graph.edges : []

  const nodesById = new Map()
  for (const t of rawTables) {
    const id = erNodeId(t)
    if (!id || nodesById.has(id)) {
      continue
    }
    nodesById.set(id, { id, schema: String(t.schema || ''), name: String(t.name || ''), x: 0, y: 0, w: 0, h: NODE_H, layer: 0, degree: 0 })
  }
  const allIds = Array.from(nodesById.keys())
  const allEdges = rawEdges
    .map(e => ({ ...e, fromId: erNodeId(e.from), toId: erNodeId(e.to) }))
    .filter(e => nodesById.has(e.fromId) && nodesById.has(e.toId))

  // 超限：先只留有外键关联的表；还不够就按名称截断（确定性）
  let keptIds = allIds
  let truncated = false
  let isolated = 0
  if (allIds.length > maxNodes) {
    const linked = new Set()
    for (const e of allEdges) {
      linked.add(e.fromId)
      linked.add(e.toId)
    }
    isolated = allIds.filter(id => !linked.has(id)).length
    keptIds = Array.from(linked).sort()
    if (keptIds.length > maxNodes) {
      keptIds = keptIds.slice(0, maxNodes)
    }
    truncated = true
  }
  const kept = new Set(keptIds)
  const edges = allEdges.filter(e => kept.has(e.fromId) && kept.has(e.toId))

  const degree = new Map()
  for (const e of edges) {
    // 自环只算一次：两条端点都是同一张表时 +2 会把它画成"关联最多的表"
    for (const id of new Set([e.fromId, e.toId])) {
      degree.set(id, (degree.get(id) || 0) + 1)
    }
  }

  const layers = layerize(keptIds, edges, degree)
  const nodes = []
  let y = PAD
  let maxX = 0
  layers.forEach((layer, li) => {
    const widths = layer.map(id => erNodeWidth(nodesById.get(id).name))
    // 同层同一列宽：宽度按层内最宽节点取，否则一层的行会错位成阶梯
    const colW = Math.max(...widths)
    layer.forEach((id, i) => {
      const node = nodesById.get(id)
      const row = Math.floor(i / perRow)
      const col = i % perRow
      node.w = erNodeWidth(node.name)
      node.h = NODE_H
      node.layer = li
      node.degree = degree.get(id) || 0
      node.x = PAD + col * (colW + GAP_X)
      node.y = y + row * (NODE_H + GAP_Y)
      maxX = Math.max(maxX, node.x + node.w)
      nodes.push(node)
    })
    const rows = Math.ceil(layer.length / perRow)
    y += rows * (NODE_H + GAP_Y)
  })

  return {
    nodes,
    edges,
    width: nodes.length ? maxX + PAD : 0,
    height: nodes.length ? y - GAP_Y + PAD : 0,
    truncated,
    total: allIds.length,
    kept: nodes.length,
    isolated
  }
}
