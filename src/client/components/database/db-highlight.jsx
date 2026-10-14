/**
 * 数据库页关键字高亮
 *
 * 复用终端「关键字高亮」配置（设置 → 终端 → keywordsHighlight，存于
 * `config.keywords: [{ keyword: '<正则>', color: 'red' }]`），把命中片段按配置
 * 配色渲染。与终端的唯一差别是上色方式：终端插 ANSI 转义，这里用 CSS class
 * （`.db-kw-<color>`，见 db-session.styl）。
 *
 * 长文本与超多命中直接跳过：单元格是按行 x 列渲染的，避免正则扫描拖慢整表。
 */

import { useMemo } from 'react'

// 与终端高亮插件同口径：超过该长度的文本不高亮
const maxHighlightLength = 4096
const maxHits = 200

function compilePatterns (keywords) {
  const out = []
  for (const item of keywords || []) {
    const { keyword, color = 'red' } = item || {}
    if (!keyword) {
      continue
    }
    try {
      // 与终端一致用 gi；用户正则可能不合法，跳过即可（不拖垮整表）
      out.push({ re: new RegExp(keyword, 'gi'), color })
    } catch (err) {
      // ignore invalid regex
    }
  }
  return out
}

// 配置变化极少，按内容摘要缓存编译结果
export function useKeywordPatterns () {
  const keywords = (window.store && window.store.config && window.store.config.keywords) || []
  const sig = JSON.stringify(keywords)
  return useMemo(() => compilePatterns(keywords), [sig])
}

export function highlightValue (text, patterns) {
  if (!patterns || !patterns.length) {
    return text
  }
  if (typeof text !== 'string' || !text || text.length > maxHighlightLength) {
    return text
  }
  const hits = []
  for (const { re, color } of patterns) {
    re.lastIndex = 0
    let m = re.exec(text)
    while (m) {
      if (m[0] === '') {
        // 零宽匹配（如 `\b*`）会让 lastIndex 原地不动
        re.lastIndex += 1
      } else {
        hits.push({ start: m.index, end: m.index + m[0].length, color })
      }
      if (hits.length >= maxHits) {
        break
      }
      m = re.exec(text)
    }
    if (hits.length >= maxHits) {
      break
    }
  }
  if (!hits.length) {
    return text
  }
  // 按起点排序；重叠时保留先命中的（配置里靠前的规则优先）
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const parts = []
  let last = 0
  for (const h of hits) {
    if (h.start < last) {
      continue
    }
    if (h.start > last) {
      parts.push(text.slice(last, h.start))
    }
    parts.push(
      <span key={h.start} className={`db-kw db-kw-${h.color}`}>
        {text.slice(h.start, h.end)}
      </span>
    )
    last = h.end
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts
}
