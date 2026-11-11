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
 *
 * N12d 补了层内重心排序（Sugiyama 的 order 阶段）：分层只决定"谁在第几层"，
 * 同层谁站左边原先只按度数/名称猜，20+ 表时连线会成片交叉。现在用相邻层
 * 站位反复求重心重排，且只在真实交叉数下降时采纳。没有引 dagre/elkjs ——
 * 它们为通用有向图带整套 rank + 虚拟节点 + 边路由，这里只缺一个排序决策，
 * 依赖体积与许可证都不划算（评估数据与实测见 §10.27）。
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

// 重心扫描最多 8 轮；边数超过这个量级时图本身就不可读，不开优化以免打开 ER 卡顿
const CROSSING_SWEEPS = 8
const MAX_CROSSING_EDGES = 400

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
 * 量一张布局图的连线交叉对数（渲染口径，供单测/CDP 与优化目标共用）。
 * db-er-view.jsx 的 edgePath 从「from 底部中心」连到「to 顶部中心」，
 * 这里用同一对端点算线段相交，数字即用户眼睛看到的交叉量级；共享端点与自环不算。
 */
export function countErCrossings (layout) {
  const byId = new Map(((layout && layout.nodes) || []).map(n => [n.id, n]))
  const segs = []
  for (const e of ((layout && layout.edges) || [])) {
    const a = byId.get(e.fromId)
    const b = byId.get(e.toId)
    if (!a || !b || a.id === b.id) continue
    segs.push({
      x1: a.x + a.w / 2,
      y1: a.y + a.h,
      x2: b.x + b.w / 2,
      y2: b.y,
      from: a.id,
      to: b.id
    })
  }
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]
      if (s.from === t.from || s.to === t.to || s.from === t.to || s.to === t.from) continue
      const p1 = { x: s.x1, y: s.y1 }
      const p2 = { x: s.x2, y: s.y2 }
      const p3 = { x: t.x1, y: t.y1 }
      const p4 = { x: t.x2, y: t.y2 }
      if (side(p1, p2, p3) * side(p1, p2, p4) < 0 &&
          side(p3, p4, p1) * side(p3, p4, p2) < 0) n++
    }
  }
  return n
}

/** 层数组 → 坐标。抽出来是为了让优化阶段用同一套坐标量交叉，而不是另造一个近似口径。 */
function placeNodes (layers, nodesById, degree, perRow) {
  const nodes = []
  let y = PAD
  let maxX = 0
  layers.forEach((layer, li) => {
    const widths = layer.map(id => erNodeWidth(nodesById.get(id).name))
    // 同层同一列宽：宽度按层内最宽节点取，否则一层的行会错位成阶梯
    const colW = layer.length ? Math.max(...widths) : 0
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
    width: nodes.length ? maxX + PAD : 0,
    height: nodes.length ? y - GAP_Y + PAD : 0
  }
}

/**
 * 按相邻层的站位重排一层：邻居的平均序号即重心，无邻居者留在原位。
 * 只看相邻层、不给长边插虚拟节点 —— 插了会改变层数，既有布局契约就破了。
 */
function reorderLayer (layers, li, refLi, neighbors, layerOf) {
  const refIndex = new Map(layers[refLi].map((id, i) => [id, i]))
  const weighted = layers[li].map((id, i) => {
    const ids = (neighbors.get(id) || []).filter(x => layerOf.get(x) === refLi)
    const bary = ids.length
      ? ids.reduce((s, x) => s + (refIndex.get(x) ?? 0), 0) / ids.length
      : i
    return { id, i, bary }
  })
  // 重心相同时保留上一轮顺序（稳定排序），同一份输入永远得到同一张图
  weighted.sort((a, b) => (a.bary - b.bary) || (a.i - b.i))
  layers[li] = weighted.map(x => x.id)
}

/**
 * 渲染口径的交叉数：直接用 placeNodes 的坐标量，优化目标与用户看到的图完全一致。
 * 试过拿"层内序号逆序对"当近似：层内换行时 x 会重置，两者脱节，40 表图整轮
 * 被几何复核回滚。节点上限 200 / 边上限 400，一次 O(E²) 不到毫秒级，不值得省。
 */
function crossingScore (layers, edges, nodesById, degree, perRow) {
  return countErCrossings({ ...placeNodes(layers, nodesById, degree, perRow), edges })
}

/**
 * Sugiyama order 阶段的最小版。三条纪律：
 * ① 初始顺序沿用 sortLayer（度数降序 + 名称升序），既有契约不破；
 * ② 逐层单步重排、只接受「严格下降」的那一步，优化永不劣化；
 * ③ 下行/上行交替扫描，避免只对齐一侧把另一侧挤乱；无改进即停。
 */
function orderLayers (layers, edges, nodesById, degree, perRow) {
  const best = layers.map(l => l.slice())
  if (best.length < 2 || edges.length > MAX_CROSSING_EDGES) return best
  const neighbors = new Map()
  for (const e of edges) {
    if (e.fromId === e.toId) continue
    if (!neighbors.has(e.fromId)) neighbors.set(e.fromId, [])
    if (!neighbors.has(e.toId)) neighbors.set(e.toId, [])
    neighbors.get(e.fromId).push(e.toId)
    neighbors.get(e.toId).push(e.fromId)
  }
  const layerOf = new Map()
  best.forEach((layer, li) => layer.forEach(id => layerOf.set(id, li)))
  let bestScore = crossingScore(best, edges, nodesById, degree, perRow)
  const tryStep = (li, refLi) => {
    const trial = best.map(l => l.slice())
    reorderLayer(trial, li, refLi, neighbors, layerOf)
    const s = crossingScore(trial, edges, nodesById, degree, perRow)
    if (s < bestScore) {
      bestScore = s
      best[li] = trial[li]
      return true
    }
    return false
  }
  for (let round = 0; round < CROSSING_SWEEPS; round++) {
    let improved = false
    for (let li = 1; li < best.length; li++) {
      improved = tryStep(li, li - 1) || improved
    }
    for (let li = best.length - 2; li >= 0; li--) {
      improved = tryStep(li, li + 1) || improved
    }
    if (!improved) break
  }
  return best
}

/**
 * @param {{tables: Array, edges: Array}} graph  后端归一图
 * @param {{maxNodes?: number, maxPerRow?: number, minimizeCrossings?: boolean}} [opts]
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

  const layered = layerize(keptIds, edges, degree)
  // minimizeCrossings:false 是留的回退开关（也供 A/B 对照量基线），默认开。
  // 内部按层内序号优化，收尾再用渲染口径复核：几何交叉数没降就保持原序，
  // 保证这层优化在任何输入下都不会把图画得更乱。
  let layers = layered
  if (opts.minimizeCrossings !== false && edges.length <= MAX_CROSSING_EDGES) {
    const ordered = orderLayers(layered, edges, nodesById, degree, perRow)
    const before = countErCrossings({ ...placeNodes(layered, nodesById, degree, perRow), edges })
    const after = countErCrossings({ ...placeNodes(ordered, nodesById, degree, perRow), edges })
    if (after <= before) layers = ordered
  }
  const placed = placeNodes(layers, nodesById, degree, perRow)
  const nodes = placed.nodes

  return {
    nodes,
    edges,
    width: placed.width,
    height: placed.height,
    truncated,
    total: allIds.length,
    kept: nodes.length,
    isolated
  }
}
