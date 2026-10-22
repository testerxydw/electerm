/**
 * 数据库页内查找 / 过滤的命中算法
 *
 * 与 db-highlight.jsx 的分工：
 * - db-highlight：按配置的正则规则给单元格文本上色（业务配置驱动）
 * - 本文件：顶栏查找、当前页过滤、元数据树过滤的「字面量命中」（UI 状态驱动）
 *
 * 命中标记的 class 隔离：顶栏查找用 db-kw-hit（命中数由 MutationObserver 统计），
 * 局部过滤用 db-tree-hit / db-page-hit，避免局部过滤污染查找计数。
 */

import React from 'react'

export function hlText (text, kw, hitClass = 'db-kw-hit') {
  const s = text === null || text === undefined ? '' : String(text)
  if (!kw) {
    return s
  }
  const lower = s.toLowerCase()
  const out = []
  let from = 0
  let n = 0
  let i = lower.indexOf(kw)
  while (i >= 0) {
    if (i > from) {
      out.push(s.slice(from, i))
    }
    out.push(<mark className={hitClass} key={n++}>{s.slice(i, i + kw.length)}</mark>)
    from = i + kw.length
    i = lower.indexOf(kw, from)
  }
  if (!out.length) {
    return s
  }
  if (from < s.length) {
    out.push(s.slice(from))
  }
  return out
}

// 单元格文本是「关键字高亮」产出的节点树（可能含多个 span），
// 需要递归到 children 里再套查找命中，二者才能叠加
export function hlNode (node, kw, hitClass = 'db-kw-hit') {
  if (!kw || node === null || node === undefined || typeof node === 'boolean') {
    return node
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return hlText(node, kw, hitClass)
  }
  if (Array.isArray(node)) {
    return node.map((n, i) => <React.Fragment key={i}>{hlNode(n, kw, hitClass)}</React.Fragment>)
  }
  if (React.isValidElement(node)) {
    const { children } = node.props
    return children === undefined || children === null
      ? node
      : React.cloneElement(node, {}, hlNode(children, kw, hitClass))
  }
  return node
}

// 文本命中扫描（大小写不敏感，顺序非重叠）：textarea 无法插 <mark>，
// 命中清单用偏移区间表达，导航轮到时 focus+setSelectionRange 定位
export function scanTextHits (text, kw) {
  const v = String(text || '')
  if (!kw) {
    return []
  }
  const lower = v.toLowerCase()
  const hits = []
  let i = lower.indexOf(kw)
  while (i >= 0) {
    hits.push({ start: i, end: i + kw.length })
    i = lower.indexOf(kw, i + kw.length)
  }
  return hits
}

// 循环导航序号（上一个/下一个）；n=0 时原地不动。
// 两段取模兜住任意步长（(i+delta+n)%n 在 |delta|>n 时会出负索引）
export function cycleIndex (i, delta, n) {
  if (!n) {
    return i
  }
  const r = (i + delta) % n
  return r < 0 ? r + n : r
}
