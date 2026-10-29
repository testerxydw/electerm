/**
 * Redis 键树（H7a）：把一堆平铺键名按分隔符折成树。纯函数，不碰 IPC/组件状态。
 *
 * 为什么要单独一层：键名分层这件事看着简单，坑全在边界上 ——
 * SCAN 会重复返回同一个键（游标只保证"至少一次"）、键里可能有空段（`a::b`）、
 * 一个键可能同时是另一个键的前缀（`user:1` 和 `user:1:profile` 都在）、
 * 分隔符是用户可配的（配成空串时 split('') 会把键拆成一个个字符）。
 * 这些都在这一层处理掉，渲染层只管把节点画出来。
 */

export const DEFAULT_SEPARATOR = ':'

// 段排序：数字感知（user:2 排在 user:10 前面，不是字典序的 10 在前）
const cmpSeg = (a, b) => String(a).localeCompare(String(b), undefined, {
  numeric: true,
  sensitivity: 'base'
})

// 名称 → 字符串：既收裸键名数组，也收 getPageData 的 { name } 行
const nameOf = (v) => {
  if (typeof v === 'string') return v
  if (v && typeof v.name === 'string') return v.name
  return ''
}

// 一个 trie 节点：{ seg, children: Map, count, keyName }
const mkNode = (seg) => ({ seg, children: null, count: 0, keyName: null })

/**
 * @param {Array<string|{name:string}>} names 键名（可含重复）
 * @param {{separator?: string}} opts separator 默认 ':'；空串/空白 = 不分层
 * @returns {{ nodes: Array, total: number }}
 *   节点：{ key, title, keyName, count, children }
 *   - key      从根到本节点的完整路径（分隔符连接），全树唯一，直接当 antd Tree 的 key
 *   - keyName  这个路径本身就是一个真实键时 = 键全名，否则 null（纯目录节点不可选）
 *   - count    本节点之下（含自身）的键数，用于节点右侧显示计数
 *   - children 只在有子节点时存在；目录排在叶子前，各自按数字感知字典序
 */
export function buildRedisKeyTree (names, opts = {}) {
  const raw = opts.separator === undefined ? DEFAULT_SEPARATOR : String(opts.separator)
  // 分隔符留空按"不分层"处理：split('') 会把 'abc' 拆成 a/b/c 三层，是纯粹的意外
  const sep = raw.trim() === '' ? null : raw
  const root = mkNode('')

  const seen = new Set()
  let total = 0
  for (const item of names || []) {
    const name = nameOf(item)
    if (!name || seen.has(name)) continue
    seen.add(name)
    total++
    let segs = sep ? name.split(sep) : [name]
    // 空段（'a::b'、':lead'、'trail:'）不参与分层：留着的后果是同名空 key 打架
    segs = segs.filter(s => s !== '')
    // 全是分隔符的键（':'、'::'）没有可用段 → 整名当一个叶子
    if (!segs.length) segs = [name]
    let node = root
    for (const seg of segs) {
      if (!node.children) node.children = new Map()
      let next = node.children.get(seg)
      if (!next) {
        next = mkNode(seg)
        node.children.set(seg, next)
      }
      node = next
      node.count++
    }
    // 键全名挂在最深节点上：前缀键（user:1）与它的子键（user:1:profile）
    // 落在同一棵树上时，这个节点既是叶子也是目录
    node.keyName = name
  }

  const toNode = (n, path) => {
    const kids = n.children ? [...n.children.values()] : []
    const children = kids
      .map(k => toNode(k, path === null ? k.seg : path + sep + k.seg))
      .sort((a, b) => (
        (b.children ? 1 : 0) - (a.children ? 1 : 0) || cmpSeg(a.title, b.title)
      ))
    const out = {
      key: path,
      title: n.seg,
      keyName: n.keyName,
      count: n.count
    }
    if (children.length) out.children = children
    return out
  }

  const nodes = (root.children ? [...root.children.values()] : [])
    .map(k => toNode(k, k.seg))
    .sort((a, b) => (b.children ? 1 : 0) - (a.children ? 1 : 0) || cmpSeg(a.title, b.title))

  return { nodes, total }
}

/**
 * 收集树里所有"目录"节点的 key（默认展开到第一层用）。
 * 只给一层内的目录：上万键全展开会把 DOM 撑爆，也不是用户想看的。
 */
export function collectFolderKeys (nodes, depth = 1) {
  const out = []
  const walk = (list, d) => {
    for (const n of list || []) {
      if (!n.children) continue
      if (d < depth) out.push(n.key)
      walk(n.children, d + 1)
    }
  }
  walk(nodes, 0)
  return out
}
