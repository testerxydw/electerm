/**
 * Redis 值预览的格式化（纯前端、零依赖）
 *
 * 现实里存进 Redis 的「JSON」经常是 Python 打印出来的 dict/list（单引号、
 * True/False/None），JSON.parse 直接失败 —— 所以这里按内容嗅探可用格式：
 *   raw     原文（不格式化）
 *   json    JSON（严格）
 *   python  Python 字面量（dict/list/tuple/set、单引号字符串、True/False/None）
 *   xml     XML/HTML 缩进
 *   url     URL / 查询串（每行一个参数，顺带解码 %XX）
 *
 * YAML 不在此列：项目没有直接依赖 yaml 库（js-yaml 只是传递依赖），
 * 引入等于给渲染层凭空加一个运行时依赖。
 */

// 超过该长度的值不格式化：格式化要整串解析 + 重建，长文本在界面上也没法读
const maxFormatLength = 512 * 1024

export const formatLabels = {
  raw: 'rawText',
  json: 'JSON',
  python: 'Python',
  xml: 'XML',
  url: 'URL'
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

function looksLikeJson (text) {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[')
}

function formatJson (text) {
  return JSON.stringify(JSON.parse(text), null, 2)
}

/* ------------------------------------------------------------------ *
 * Python 字面量
 * ------------------------------------------------------------------ */

// 只认字面量：dict/list/tuple、字符串（可带 b/u/r 前缀）、数字、True/False/None。
// 碰到函数调用等表达式就抛错，调用方据此判断「不可格式化」，不做猜测性转换。
function parsePythonLiteral (input) {
  const s = input.trim()
  let i = 0

  function skipWs () {
    while (i < s.length && /\s/.test(s[i])) {
      i++
    }
  }

  function parseString () {
    const quote = s[i]
    const triple = s.slice(i, i + 3) === quote.repeat(3)
    const end = triple ? quote.repeat(3) : quote
    i += end.length
    let out = ''
    while (i < s.length) {
      if (s.slice(i, i + end.length) === end) {
        i += end.length
        return out
      }
      if (s[i] === '\\') {
        const esc = s[i + 1]
        i += 2
        switch (esc) {
          case 'n': out += '\n'; break
          case 't': out += '\t'; break
          case 'r': out += '\r'; break
          case '\\': out += '\\'; break
          case "'": out += "'"; break
          case '"': out += '"'; break
          default: out += esc
        }
      } else {
        out += s[i]
        i++
      }
    }
    throw new Error('unterminated string')
  }

  function parseSequence (close) {
    i++
    const out = []
    skipWs()
    if (s[i] === close) {
      i++
      return out
    }
    while (i < s.length) {
      out.push(parseValue())
      skipWs()
      if (s[i] === ',') {
        i++
        skipWs()
        // 尾逗号：(1, 2,)
        if (s[i] === close) {
          i++
          return out
        }
        continue
      }
      if (s[i] === close) {
        i++
        return out
      }
      throw new Error('expected , or ' + close)
    }
    throw new Error('unterminated sequence')
  }

  function parseMapping () {
    i++
    const out = {}
    skipWs()
    if (s[i] === '}') {
      i++
      return out
    }
    while (i < s.length) {
      // 键通常是字符串，少数是数字/元组：按字面量解析后转成字符串键
      const key = parseValue()
      skipWs()
      if (s[i] !== ':') {
        throw new Error('expected :')
      }
      i++
      out[typeof key === 'string' ? key : JSON.stringify(key)] = parseValue()
      skipWs()
      if (s[i] === ',') {
        i++
        skipWs()
        // 尾逗号：{'a': 1,}
        if (s[i] === '}') {
          i++
          return out
        }
        continue
      }
      if (s[i] === '}') {
        i++
        return out
      }
      throw new Error('expected , or }')
    }
    throw new Error('unterminated mapping')
  }

  function parseValue () {
    skipWs()
    const c = s[i]
    if (c === '{') {
      return parseMapping()
    }
    if (c === '[') {
      return parseSequence(']')
    }
    if (c === '(') {
      return parseSequence(')')
    }
    if (c === "'" || c === '"') {
      return parseString()
    }
    // 字符串前缀：b'' / r'' / u'' / br'' 等
    const prefixed = /^[bBfFrRuU]{1,2}(['"])/.exec(s.slice(i))
    if (prefixed) {
      i += prefixed[0].length - 1
      return parseString()
    }
    const named = /^(True|False|None)\b/.exec(s.slice(i))
    if (named) {
      i += named[0].length
      return named[0] === 'True' ? true : (named[0] === 'False' ? false : null)
    }
    // 必须匹配到数字，否则会空匹配出 0（曾把 `(1,)` 的尾逗号误解析成 0）
    const num = /^[-+]?(0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(s.slice(i))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    throw new Error('unsupported python token at ' + i)
  }

  const value = parseValue()
  skipWs()
  if (i !== s.length) {
    throw new Error('trailing characters in python literal')
  }
  return value
}

export function parsePythonValue (text) {
  return parsePythonLiteral(text)
}

function formatPython (text) {
  return JSON.stringify(parsePythonLiteral(text), null, 2)
}

/* ------------------------------------------------------------------ *
 * XML / HTML
 * ------------------------------------------------------------------ */

function looksLikeXml (text) {
  return /^\s*<[a-zA-Z!?]/.test(text)
}

function formatXml (text) {
  const normalized = text.trim().replace(/>\s+</g, '><')
  const tokens = normalized.split(/(?=<)/).map(t => t.trim()).filter(Boolean)
  const countOpen = t => (t.match(/<[^/!?][^>]*>/g) || []).filter(x => !/\/>$/.test(x)).length
  const countClose = t => (t.match(/<\/[^>]+>/g) || []).length
  const lines = []
  let depth = 0
  for (const t of tokens) {
    const isClose = /^<\//.test(t)
    if (isClose) {
      // 「开标签 + 文本」后紧跟闭合标签 → 并回同一行（<a>1</a>），不拆成两行
      const last = lines[lines.length - 1]
      if (lines.length && /<[^/!?][^>]*>[^<]+$/.test(last)) {
        lines[lines.length - 1] = last + t
        depth = Math.max(0, depth - countClose(t))
        continue
      }
      depth = Math.max(0, depth - 1)
    }
    lines.push('  '.repeat(depth) + t)
    if (!isClose) {
      depth = Math.max(0, depth + countOpen(t) - countClose(t))
    }
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * URL / 查询串
 * ------------------------------------------------------------------ */

function looksLikeQuery (text) {
  return !/\s/.test(text.trim()) && /(^|[?&])[^=&]+=[^&]*/.test(text.trim())
}

function decodeSafe (s) {
  try {
    return decodeURIComponent(s)
  } catch (err) {
    return s
  }
}

function formatUrl (text) {
  const t = text.trim()
  const qi = t.indexOf('?')
  const prefix = qi >= 0 ? t.slice(0, qi + 1) : ''
  const qs = qi >= 0 ? t.slice(qi + 1) : t
  const lines = qs.split('&').filter(Boolean).map(p => {
    const eq = p.indexOf('=')
    return eq < 0
      ? decodeSafe(p)
      : `${decodeSafe(p.slice(0, eq))} = ${decodeSafe(p.slice(eq + 1))}`
  })
  return (prefix ? [prefix, ...lines] : lines).join('\n')
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

const formatters = {
  json: formatJson,
  python: formatPython,
  xml: formatXml,
  url: formatUrl
}

const detectors = {
  json: looksLikeJson,
  python: text => /^\s*[[{(]/.test(text),
  xml: looksLikeXml,
  url: looksLikeQuery
}

/**
 * 该值能用哪些格式显示（真实试算一次，失败即不提供）
 * @param {string} text
 * @returns {Array<{key: string, label: string}>}
 */
export function detectFormats (text) {
  if (typeof text !== 'string' || !text.trim() || text.length > maxFormatLength) {
    return []
  }
  const out = []
  for (const key of Object.keys(formatters)) {
    if (!detectors[key](text)) {
      continue
    }
    try {
      formatters[key](text)
      out.push({ key, label: formatLabels[key] })
    } catch (err) {
      // 试算失败：不提供该格式
    }
  }
  return out
}

/**
 * 格式化；key 为 'raw' 或不可用时原样返回
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function formatValue (text, key) {
  const fn = formatters[key]
  if (!fn || typeof text !== 'string' || text.length > maxFormatLength) {
    return text
  }
  try {
    return fn(text)
  } catch (err) {
    return text
  }
}
