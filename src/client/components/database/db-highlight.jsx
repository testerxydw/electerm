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
import { compileKeywords, keywordsSignature } from '../../common/keyword-compile.js'
import { buildScan, collectMatches, applyCoverageGate } from '../../common/keyword-scan.js'

// 与终端高亮插件同口径的默认上限：超长文本/超多命中跳过（表格单元格性能考量）。
// 值预览（<pre>，单值专用查看区）通过 opts 放宽，见 highlightValue
const maxHighlightLength = 4096
const maxHits = 200

// 配置变化极少，按内容摘要缓存编译结果
export function useKeywordPatterns () {
  // ⚠️ 读 _config 而非 config getter：后者每次访问都 deepCopy 整个配置，
  // 在"每渲染一次"的 hook 里是稳定的内存/CPU 垃圾源（性能分析见
  // doc/已完成/分析-性能热点与优化总案-2026-10-21.md）。此处只读不写，安全。
  const raw = (window.store && window.store._config && window.store._config.keywords) || []
  // 与终端同一口径：被取消勾选（off）的规则不参与高亮
  const keywords = activeKeywords(raw)
  const sig = keywordsSignature(keywords)
  // compileKeywords 是进程级共享缓存：终端页签和本网格用同一份配置时，
  // RegExp 只编译一次、只存一份
  return useMemo(() => compileKeywords(keywords), [sig])
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
  // 与终端同一套单遍扫描 + 家族 rank 裁决（common/keyword-scan.js）：两端必然
  // 给出同一个着色跨度，不再出现"终端取短、网格取长"的结论分歧。
  const scan = buildScan(patterns)
  const matches = collectMatches(text, patterns, scan, hitLimit)
  if (!matches.length) {
    return text
  }
  // V2 §7.3：与终端同一套行级覆盖率闸。一个单元格即一行，超过阈值时只留 signal。
  // 纯配色契约探针可传 opts.coverageGate=false 关掉。
  const hits = applyCoverageGate(text, matches, {
    enabled: opts.coverageGate !== false,
    threshold: opts.coverageThreshold
  })
  if (!hits.length) {
    return text
  }
  const parts = []
  let last = 0
  for (const h of hits) {
    if (h.start < last) {
      continue
    }
    if (h.start > last) {
      parts.push(text.slice(last, h.start))
    }
    // 真彩色（#rrggbb）直接作为字体色；命名色走当前终端主题的对应色名映射，
    // 取不到就用继承色。两端最终看到的色一致。
    const color = (typeof h.color === 'string' && h.color.startsWith('#'))
      ? h.color
      : (themeConfig && themeConfig[h.color] ? themeConfig[h.color] : undefined)
    parts.push(
      <span
        key={h.start}
        className='db-kw'
        style={color ? { color } : undefined}
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
