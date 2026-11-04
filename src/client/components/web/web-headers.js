// Web 会话的自定义请求头 / Cookie（S2-5）：书签里存的是人能读的多行文本，
// 交给主进程之前先在这里整形。纯函数，node 单测直接 import。
//
// 行格式：每行一条，`#` 开头是注释；头和 Cookie 都按"第一个冒号/等号"切，
// 值里再有冒号（如 `Authorization: Bearer a:b`）不会被切坏。
const HEADER_NAME = /^[A-Za-z0-9-]+$/

export function parseHeaderLines (text) {
  const out = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const i = line.indexOf(':')
    if (i <= 0) {
      continue
    }
    const name = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (!name || !value || !HEADER_NAME.test(name)) {
      continue
    }
    // 值里带换行就等于让用户能拼出额外的头，这类行整条丢弃
    if (/[\r\n]/.test(value)) {
      continue
    }
    out[name] = value
  }
  return out
}

export function buildCookieHeader (text) {
  const parts = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const i = line.indexOf('=')
    if (i <= 0) {
      continue
    }
    // 分号既是分隔符也可能被用来收尾，行内再出现分号就判为非法
    if (/[\r\n;]/.test(line)) {
      continue
    }
    parts.push(line)
  }
  return parts.join('; ')
}

export function hasWebCustomHeaders (tab) {
  const t = tab || {}
  return Object.keys(parseHeaderLines(t.webHeaders)).length > 0 ||
    buildCookieHeader(t.webCookies) !== ''
}
