/**
 * command palette 过滤（纯函数，供组件与单测共用）
 */

export function filterItems (items, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) {
    return items
  }
  return items.filter(it => {
    const hay = `${it.label || ''} ${it.keywords || ''}`.toLowerCase()
    return hay.includes(q)
  })
}
