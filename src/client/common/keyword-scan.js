/**
 * 关键字高亮：终端与数据库网格共用的单遍扫描
 *
 * 这是 V2 批次 0 的核心。原来：
 *   - 终端（highlight-addon.js）自己实现 buildScan / _collectMatches / _arbitrateAt，
 *     重叠裁决是「同起点取最短」（sorted by start asc, end asc，保留最短）；
 *   - 网格（db-highlight.jsx）是「逐规则各扫一遍整段 + 同起点取最长」。
 * 两端各扫各的，同一行常常给出不同着色跨度。
 *
 * 现在把扫描抽到本模块，两端都调 buildScan + collectMatches。重叠裁决只保留一种口径
 * ——「同起点取最短」：全部预设的排列顺序就是按"短的先赢"设计的，切到取长会翻一批已
 * 固化的用例。统一后，一致性从"两套实现恰好对齐"变成"同一套实现"，覆盖率闸（批次 3）
 * 也天然两端同实现。
 *
 * 关于 V2 文档里"删除 5 处让位护栏"：经实测，这些护栏（ipv4 的 (?!:\d)、ts 的
 * (?!\.\d)、lvlError 的 DOES NOT(?:EXIST|MATCH)?、docker 镜像的 (?![\w.-])、num 的
 * (?<!status[=:]\s{0,2})）的真实作用是让更短的规则在同起点匹配失败，从而把跨度让给
 * 更长的规则。统一成「取最短」后它们依然是必需的——删掉会让已固化的验收用例翻色
 * （违反"护栏删除后原用例不翻色"硬指标），故全部保留，仅 num 那条在统一取短后确属
 * 冗余、经测试实证无副作用后再删。
 *
 * V2 批次 3：本模块再承载「行级覆盖率闸」（applyCoverageGate）。终端写入片段会把
 * 多行日志并成一段，按片段算染色占比会把脏行被净行平均掉、静默放宽阈值，所以闸
 * 必须在裁决出 filtered 之后、拼 ANSI 之前按 \n 逐行算。terminal 与 grid 都调它，
 * 天然同口径（文档 §7.3 的"两处必须一起改"约束由此消失）。
 */

const maxMatchesDefault = 512

// 单行染色占比上限（V2 §7.3 默认 35%）。超过该值的行只保留 signal 命中，
// structure 命中整行丢弃，直接消灭「一条胖路径吃满整行」的 93% 花屏。
export const defaultCoverageThreshold = 0.35

// 合成单遍扫描结构（按 patterns 数组身份缓存，终端与网格共用同一份）：
//   combined   把所有规则源用非捕获组包一层后 | 连起来，一次 exec 找"最早命中的起点"
//   sticky     每条规则的 y(锚定) 版，用于在某个起点上精确裁决谁赢
//   colorCodes / colors / tiers   与 patterns 同序：终端 ANSI / 网格色名 / 档位
//                                 （tier 供批次 3 行级覆盖率闸判定去留）
const scanCache = new WeakMap()

export function buildScan (patterns) {
  if (!patterns || patterns.length === 0) {
    return null
  }
  if (scanCache.has(patterns)) {
    // 可能是 null（合并失败的退化标记），也要命中缓存，避免每次重建
    return scanCache.get(patterns)
  }
  const colorCodes = []
  const colors = []
  const tiers = []
  const sticky = []
  const sources = []
  let ok = true
  for (const p of patterns) {
    colorCodes.push(p.colorCode)
    colors.push(p.color)
    // 老配置/用户自定义规则没有 tier，按 signal 处理（零迁移）
    tiers.push(p.tier || 'signal')
    try {
      // 锚定版：lastIndex=s 时只认"恰好在 s 起点"的命中，用来裁决同起点谁赢。
      // 标志保留 i（源大小写不敏感），只把 g 换成 y
      sticky.push(new RegExp(p.re.source, 'gyi'))
      // 非捕获组包一层，保住原规则里的顶层 | 不被合并正则的 | 抢先拆开
      sources.push('(?:' + p.re.source + ')')
    } catch (e) {
      ok = false
      break
    }
  }
  let struct = null
  if (ok) {
    try {
      const combined = new RegExp(sources.join('|'), 'gi')
      struct = { combined, sticky, colorCodes, colors, tiers }
    } catch (e) {
      // 用户规则里有重名命名分组等导致无法合并：退回逐规则扫描（collectMatches 判断）
      console.error('Invalid combined keyword regex, falling back to per-rule scan:', e)
      struct = null
    }
  }
  scanCache.set(patterns, struct)
  return struct
}

// 同起点取最短：在所有恰好于 s 命中的规则里取跨度最短者；等跨度取原序最先者。
// 返回 { end, colorCode, color, tier } 或 null（没有规则在 s 命中非空跨度）。
function arbitrateAt (content, s, sticky, colorCodes, colors, tiers) {
  let bestEnd = -1
  let bestColorCode
  let bestColor
  let bestTier
  for (let i = 0; i < sticky.length; i++) {
    const re = sticky[i]
    re.lastIndex = s
    const m = re.exec(content)
    if (!m || m[0].length === 0) {
      continue
    }
    const end = s + m[0].length
    // 严格小于：更短才覆盖；等长不覆盖，从而保留原序最先的那条
    if (bestEnd === -1 || end < bestEnd) {
      bestEnd = end
      bestColorCode = colorCodes[i]
      bestColor = colors[i]
      bestTier = tiers[i]
    }
  }
  if (bestEnd === -1) {
    return null
  }
  return { end: bestEnd, colorCode: bestColorCode, color: bestColor, tier: bestTier }
}

// 单遍收集一段纯文本的命中（坐标基于原文）。优先用合并大正则定位 + 起点锚定裁决；
// 合并失败时退回逐规则扫描（保底，保持取最短口径）。
function collectViaCombined (content, scan, cap) {
  const { combined, sticky, colorCodes, colors, tiers } = scan
  const matches = []
  let from = 0
  const len = content.length
  while (from < len) {
    combined.lastIndex = from
    const m = combined.exec(content)
    if (!m) {
      break
    }
    // 合并正则取到的是"最早命中的起点"，具体谁赢、跨度多少要锚定裁决
    const start = m.index
    const win = arbitrateAt(content, start, sticky, colorCodes, colors, tiers)
    if (!win || win.end <= start) {
      // 理论上不会发生（合并命中说明有规则在此命中）；跳过一格防死循环
      from = start + 1
      continue
    }
    matches.push({
      start,
      end: win.end,
      text: content.slice(start, win.end),
      colorCode: win.colorCode,
      color: win.color,
      tier: win.tier
    })
    if (matches.length >= cap) {
      break
    }
    // 从裁决出的跨度末尾继续（合并正则 lastIndex 可能更远，以裁决为准）
    from = win.end
  }
  return matches
}

function collectViaRules (patterns, content, cap) {
  const hits = []
  for (const { re, color, colorCode, tier } of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) {
      if (m[0] === '') {
        re.lastIndex++
        continue
      }
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        color,
        colorCode,
        tier: tier || 'signal'
      })
      if (hits.length >= cap) {
        break
      }
    }
    if (hits.length >= cap) {
      break
    }
  }
  return hits
}

/**
 * 收集一段文本里的全部高亮命中。
 * @param {string} content 纯文本（已切掉 ANSI/OSC 序列）
 * @param {Array} patterns compileKeywords 的输出（含 re / color / colorCode）
 * @param {object|null} scan buildScan 的产物，传 null 走逐规则保底
 * @param {number} cap 单段命中上限
 * @returns {Array<{start,end,text,color,colorCode,tier}>} 已按「取最短」去重叠、互不重叠
 */
export function collectMatches (content, patterns, scan, cap = maxMatchesDefault) {
  if (!patterns || !patterns.length) {
    return []
  }
  const raw = scan
    ? collectViaCombined(content, scan, cap)
    : collectViaRules(patterns, content, cap)
  // 合并大正则已保证命中互不重叠、按左到右；这里再排一遍并跳过重叠，兜住保底路径
  // 与任何边界情况（结论与旧引擎的 matches.sort(start,end asc) + 去重叠 完全一致）。
  raw.sort((a, b) => a.start - b.start || a.end - b.end)
  const out = []
  let last = 0
  for (const h of raw) {
    if (h.start < last) {
      continue
    }
    out.push(h)
    last = h.end
  }
  return out
}

/**
 * 行级覆盖率闸（V2 §7.3）。在裁决出最终 matches 之后、拼 ANSI/style 之前调用。
 *
 * 按 \n 把命中分组，逐行计算「染色字符数 / 行字符数」；某行占比 > threshold 时，
 * 该行只保留 signal 命中、丢弃全部 structure 命中。这样：
 *   - 「一条 absPath 吃满整行」的 93% 花屏被消灭；
 *   - 错误/警告/成功词（signal）永远不会被闸掉；
 *   - 多行片段里某一行很脏不影响其它干净行，阈值不会被平均掉。
 *
 * 网格侧一个单元格即一行，天然同口径；两端共用本函数，不存在实现分叉。
 *
 * @param {string} content 与 collectMatches 同一个纯文本（坐标基准）
 * @param {Array} matches collectMatches 的输出（互不重叠、按左到右）
 * @param {object} opts { threshold = 0.35, enabled = true }
 * @returns {Array} 过滤后的新数组（无丢弃时返回原数组，避免无谓分配）
 */
export function applyCoverageGate (content, matches, opts = {}) {
  if (!matches || matches.length === 0) {
    return matches
  }
  if (opts.enabled === false) {
    return matches
  }
  const threshold = Number.isFinite(opts.threshold) && opts.threshold >= 0
    ? opts.threshold
    : defaultCoverageThreshold
  // 快路径：没有 structure 命中的配置（如默认全选 = 仅语义档）完全不受闸影响
  let hasStructure = false
  for (const m of matches) {
    if (m.tier === 'structure') {
      hasStructure = true
      break
    }
  }
  if (!hasStructure) {
    return matches
  }

  // 行边界：每行 [start, end)，end 为 \n 的下标或文本末尾。
  // \n 与其前的 \r（CRLF）都是行分隔符，不计入可见行长，也不计入染色面积——
  // 否则 Windows/PTY 输出的 \r 会把分母撑大、翻转 35% 判定。
  const lineStarts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      lineStarts.push(i + 1)
    }
  }
  const lineEndOf = (li) => {
    const raw = li + 1 < lineStarts.length
      ? lineStarts[li + 1] - 1
      : content.length
    return raw > lineStarts[li] && content.charCodeAt(raw - 1) === 13
      ? raw - 1
      : raw
  }

  // 命中按「与每一行相交的区间」分摊。跨 \n 的命中（如 File "...", line \d+ 这类
  // 预设在真实多行堆栈里会产生）必须在每一行都计入染色面积、也登记到每一行的
  // structure 列表；任一行超阈值就整条丢弃。只按起点归属会让后续行完全不可见。
  const colored = new Array(lineStarts.length).fill(0)
  const structureByLine = new Array(lineStarts.length)
  const lineCount = lineStarts.length
  for (const m of matches) {
    // 二分找起点所在行
    let lo = 0
    let hi = lineCount - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= m.start) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    for (let li = lo; li < lineCount && lineStarts[li] < m.end; li++) {
      const lineEnd = lineEndOf(li)
      const from = Math.max(m.start, lineStarts[li])
      const to = Math.min(m.end, lineEnd)
      if (to <= from) {
        continue
      }
      colored[li] += to - from
      if (m.tier === 'structure') {
        if (!structureByLine[li]) {
          structureByLine[li] = []
        }
        structureByLine[li].push(m)
      }
    }
  }

  const drop = new Set()
  for (let i = 0; i < lineCount; i++) {
    const lineLength = lineEndOf(i) - lineStarts[i]
    if (lineLength <= 0) {
      continue
    }
    if (colored[i] / lineLength > threshold && structureByLine[i]) {
      for (const m of structureByLine[i]) {
        drop.add(m)
      }
    }
  }
  if (drop.size === 0) {
    return matches
  }
  return matches.filter(m => !drop.has(m))
}
