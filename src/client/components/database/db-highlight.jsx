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
import { activeKeywords } from '../../common/keyword-groups.js'

// 与终端高亮插件同口径的默认上限：超长文本/超多命中跳过（表格单元格性能考量）。
// 值预览（<pre>，单值专用查看区）通过 opts 放宽，见 highlightValue
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
  // ⚠️ 读 _config 而非 config getter：后者每次访问都 deepCopy 整个配置，
  // 在"每渲染一次"的 hook 里是稳定的内存/CPU 垃圾源（性能分析见
  // doc/分析-数据库页性能热点与优化方案.md）。此处只读不写，安全。
  const raw = (window.store && window.store._config && window.store._config.keywords) || []
  // 与终端同一口径：被取消勾选（off）的规则不参与高亮
  const keywords = activeKeywords(raw)
  const sig = JSON.stringify(keywords)
  return useMemo(() => compilePatterns(keywords), [sig])
}

export function highlightValue (text, patterns, themeConfig, opts = {}) {
  const maxLength = opts.maxLength || maxHighlightLength
  const hitLimit = opts.maxHits || maxHits
  if (!patterns || !patterns.length) {
    return text
  }
  if (typeof text !== 'string' || !text || text.length > maxLength) {
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
      if (hits.length >= hitLimit) {
        break
      }
      m = re.exec(text)
    }
    if (hits.length >= hitLimit) {
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
      <span
        key={h.start}
        className='db-kw'
        // 颜色取自当前终端主题的对应色名（与终端里看到的一致）；取不到就用继承色
        style={themeConfig && themeConfig[h.color] ? { color: themeConfig[h.color] } : undefined}
      >
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
