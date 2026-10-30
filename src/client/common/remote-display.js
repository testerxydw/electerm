/**
 * 远程会话（RDP / VNC / SPICE）顶栏的显示层纯函数。
 *
 * 与 remote-adapt.js 分开：那边管"尺寸/时机怎么决定"，这边只管"栏里那几个字段
 * 怎么拼"。抽出来的原因见 doc/分析-远程会话顶栏差异与统一-2026-10-30.md：三端原来
 * 各写各的连接信息，缺字段时会渲染出 `@host:port` 这种半截内容。
 */

const text = (v) => {
  if (v === null || v === undefined) {
    return ''
  }
  return String(v).trim()
}

// 端口只在是正数时才算"有"：旧书签可能存了空串或 0，不能拼出 `:0` 这种端口
const portText = (v) => {
  const s = text(v)
  if (!s) {
    return ''
  }
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? s : ''
}

/**
 * 连接信息：`[桌面名] [user@]host[:port]`
 *
 * 每一段都是可选的 —— 没有的字段直接不渲染，而不是留下孤零的分隔符（旧 VNC 在
 * username 为空时会渲染出 `@host:port`）。port 为空/0/非数字视为未指定。
 */
export const formatConnInfo = ({ name, username, host, port } = {}) => {
  const h = text(host)
  const user = text(username)
  const p = portText(port)
  const conn = h
    ? `${user ? user + '@' : ''}${h}${p ? ':' + p : ''}`
    : ''
  return {
    name: text(name),
    conn
  }
}
