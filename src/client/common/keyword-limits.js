/**
 * 关键字高亮：限制开关与阈值的单一真源（SSOT）。
 *
 * 终端（components/terminal/highlight-addon.js）与数据库网格
 * （components/database/db-highlight.jsx）过去各自硬编码默认值，改一端就会策略漂移：
 * 2026-11-14 终端切成「全部渲染」后，DB 网格仍开着覆盖率闸，纯 IP 单元格
 * （染色占比 100% > 当时的 35% 闸）被整格丢命中，完全不高亮。
 *
 * 现在所有默认值只在这里定义；两端统一调 resolveHighlightOptions 取配置，
 * 不再单独实现开关判定。调整策略只改本文件，两端同步生效。
 */

export const HIGHLIGHT_LIMITS = Object.freeze({
  // 覆盖率闸（密度治理）默认关闭 → 全部渲染；显式传 coverageGate: true 才开启
  coverageGateDefault: false,
  // 开闸时单物理行允许的最大染色字符占比
  coverageThreshold: 0.6,
  // 单个文本段超过此长度跳过扫描（防超长单行炸正则）
  maxHighlightLength: 4096,
  // 单次 write 整块超过此长度整块跳过（防下载进度 / 命令洪水）
  maxHighlightChunkLength: 4 * 1024 * 1024,
  // 终端单段命中上限
  maxMatchesPerSegment: 512,
  // DB 网格单元格命中上限（表格按行 x 列渲染，预算比终端小）
  maxHitsPerCell: 200,
  // DB 值预览区（<pre> 单值专用）放宽后的上限
  maxPreviewLength: 100000,
  maxHitsPerPreview: 2000
})

/**
 * 归一化调用方覆盖项，返回完整配置。默认值只来自 HIGHLIGHT_LIMITS。
 *
 * @param {object} opts 覆盖项：coverageGate / coverageThreshold / maxLength /
 *   maxHits / maxHighlightLength / maxMatchesPerSegment / maxHighlightChunkLength
 * @param {'terminal'|'grid'} profile 决定命中上限默认值（终端 512 / 网格 200）
 */
export function resolveHighlightOptions (opts = {}, profile = 'terminal') {
  const L = HIGHLIGHT_LIMITS
  const hitDefault = profile === 'grid' ? L.maxHitsPerCell : L.maxMatchesPerSegment
  return {
    coverageGate: typeof opts.coverageGate === 'boolean'
      ? opts.coverageGate
      : L.coverageGateDefault,
    coverageThreshold: Number.isFinite(opts.coverageThreshold) && opts.coverageThreshold >= 0
      ? opts.coverageThreshold
      : L.coverageThreshold,
    maxLength: opts.maxLength || opts.maxHighlightLength || L.maxHighlightLength,
    maxChunkLength: opts.maxHighlightChunkLength || L.maxHighlightChunkLength,
    maxHits: opts.maxHits || opts.maxMatchesPerSegment || hitDefault
  }
}
