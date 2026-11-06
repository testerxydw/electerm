/**
 * 关键字高亮：终端与数据库网格共用的单遍扫描
 *
 * 这是 V2 批次 0 的核心。原来：
 *   - 终端（highlight-addon.js）自己实现 buildScan / _collectMatches / _arbitrateAt，
 *     重叠裁决是「同起点取最短」（sorted by start asc, end asc，保留最短）；
 *   - 网格（db-highlight.jsx）是「逐规则各扫一遍整段 + 同起点取最长」。
 * 两端各扫各的，同一行常常给出不同着色跨度。
 *
 * 现在把扫描抽到本模块，两端都调 buildScan + collectMatches。一致性从"两套实现恰好
 * 对齐"变成"同一套实现"，覆盖率闸（批次 3）也天然两端同实现。
 *
 * V3 批次 A（2026-11-06）：裁决口径从「同起点取最短」换成**信号家族优先级**：
 *   1. 最左起点优先（合并大正则天然给出最早起点）
 *   2. 同起点 → rank 小者胜（rank 来自 FAMILY_RANK，是发布契约，不是数组顺序）
 *   3. 同 rank → 跨度长者胜（同族/同层内合并优先，不再跨族抢色）
 *   4. 仍相同 → 原序（确定性）
 * 「取最短」是没有家族概念时的权宜：它把"谁赢"交给跨度长度，于是必须再靠 lookahead
 * 让位，两条机制合起来才凑出今天这副颜色。批次 B/C 消灭重复家族之后，§keyword-presets
 * 头部列的让位护栏失去存在理由，按 v3 文档 §5 逐条删除。
 *
 * 这次改口的实测代价（冻结语料 = highlight-equivalence.spec.js 的 corpus，38 行）：
 * 只有 2 行结果变化，且两行都是"新法才对"——
 *   - `df -h … 45%`：45% 从裸数字 #79C0FF 改判给 percent 族（cyan）；
 *   - `HOST: 2001:0db8:…:7334`：整串 IPv6 不再被切成 4 段 magenta，ipv6-mac 族按 rank 10
 *     一次吃下完整地址。
 *
 * 关于那 5 处让位护栏（ipv4 的 (?!:\d)、ts 的 (?!\.\d)、lvlError 的 DOES NOT(?:…)、
 * Docker 镜像的 (?![\w.-])、num 的 (?<!status[=:]\s{0,2})）：批次 0 落地时实测"删掉会
 * 翻已固化用例"，当时的结论是全部保留。那个结论的前提在 V3 已经不成立——护栏补偿的是
 * **家族不唯一**（IPv4 形状同时写在 HTTP/Docker 的规则里，只能靠让位分胜负）。批次 A
 * 先不动任何一条正则，让 rank 裁决与旧口径共存；批次 C 把 host:port 拆成 host + port
 * 两个通用族之后，逐条删除（v3 文档 §5 表），不允许为了过测试把护栏加回来。
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
//   colorCodes / colors / tiers / ranks   与 patterns 同序：终端 ANSI / 网格色名 / 档位 /
//             家族优先级（rank 供同起点裁决决胜，tiers 供行级覆盖率闸判定去留）
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
  const ranks = []
  const sticky = []
  const sources = []
  let ok = true
  for (const p of patterns) {
    colorCodes.push(p.colorCode)
    colors.push(p.color)
    // 老配置/用户自定义规则没有 tier，按 signal 处理（零迁移）
    tiers.push(p.tier || 'signal')
    // 没有 rank 的规则（手搓配置、老缓存）按状态词层处理，行为可预期
    ranks.push(Number.isFinite(p.rank) ? p.rank : 50)
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
      struct = { combined, sticky, colorCodes, colors, tiers, ranks }
    } catch (e) {
      // 用户规则里有重名命名分组等导致无法合并：退回逐规则扫描（collectMatches 判断）
      console.error('Invalid combined keyword regex, falling back to per-rule scan:', e)
      struct = null
    }
  }
  scanCache.set(patterns, struct)
  return struct
}

// 家族优先级裁决：在 s 起点上，所有恰好命中的规则里
//   rank 小者胜 → 同 rank 取跨度更长 → 仍相同取原序最先。
// 返回 { end, colorCode, color, tier, rank, index } 或 null（没有规则在 s 命中非空跨度）。
function arbitrateAt (content, s, sticky, colorCodes, colors, tiers, ranks) {
  let best = null
  for (let i = 0; i < sticky.length; i++) {
    const re = sticky[i]
    re.lastIndex = s
    const m = re.exec(content)
    if (!m || m[0].length === 0) {
      continue
    }
    const end = s + m[0].length
    if (!best) {
      best = { end, index: i }
      continue
    }
    if (ranks[i] < ranks[best.index]) {
      best = { end, index: i }
    } else if (ranks[i] === ranks[best.index] && end > best.end) {
      // 同层才比长度：同族的多条异形规则里，能吃下完整信号的那条才是本意
      best = { end, index: i }
    }
  }
  if (!best) {
    return null
  }
  const i = best.index
  return {
    end: best.end,
    colorCode: colorCodes[i],
    color: colors[i],
    tier: tiers[i],
    rank: ranks[i],
    index: i
  }
}

// 单遍收集一段纯文本的命中（坐标基于原文）。优先用合并大正则定位 + 起点锚定裁决；
// 合并失败时退回逐规则扫描（保底，同一套 rank 口径）。
function collectViaCombined (content, scan, cap) {
  const { combined, sticky, colorCodes, colors, tiers, ranks } = scan
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
    const win = arbitrateAt(content, start, sticky, colorCodes, colors, tiers, ranks)
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
      tier: win.tier,
      rank: win.rank,
      index: win.index
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
  for (let i = 0; i < patterns.length; i++) {
    const { re, color, colorCode, tier, rank } = patterns[i]
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
        tier: tier || 'signal',
        rank: Number.isFinite(rank) ? rank : 50,
        index: i
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
 * 从一批（可能互相重叠的）命中里选出最终不重叠的一组 —— 与 collectViaCombined
 * 完全同一条裁决口径，保证「合并大正则失败」的保底路径不会退回旧行为：
 *   起点升序 → rank 升序 → 跨度降序 → 原序升序，然后从左到右贪心取不重叠者。
 */
function selectByRank (hits) {
  hits.sort((a, b) =>
    a.start - b.start ||
    a.rank - b.rank ||
    b.end - a.end ||
    a.index - b.index
  )
  const out = []
  let last = 0
  for (const h of hits) {
    if (h.start < last) {
      continue
    }
    out.push(h)
    last = h.end
  }
  return out
}

/**
 * 收集一段文本里的全部高亮命中。
 * @param {string} content 纯文本（已切掉 ANSI/OSC 序列）
 * @param {Array} patterns compileKeywords 的输出（含 re / color / colorCode / tier / rank）
 * @param {object|null} scan buildScan 的产物，传 null 走逐规则保底
 * @param {number} cap 单段命中上限
 * @returns {Array<{start,end,text,color,colorCode,tier,rank}>} 已按家族优先级去重叠、互不重叠
 */
export function collectMatches (content, patterns, scan, cap = maxMatchesDefault) {
  if (!patterns || !patterns.length) {
    return []
  }
  const raw = scan
    ? collectViaCombined(content, scan, cap)
    : collectViaRules(patterns, content, cap)
  // 合并大正则路径内部已按 rank 裁决；这里统一再排一次，兜住保底路径与任何边界
  return selectByRank(raw)
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
