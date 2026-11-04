import { compileKeywords } from '../../common/keyword-compile.js'

// 单遍扫描结构缓存：compiledPatterns 由 keyword-compile 在进程内共享（同一份
// 配置开 N 个页签只编译一次），所以按数组身份把扫描结构也只建一次。
// 结构 = { combined, sticky, colorCodes }：
//   combined   每条规则源用非捕获组包一层后 | 连起来，一次 exec 从左到右找
//              「最早命中的起点」——整段只被这条主正则扫一遍
//   sticky     每条规则的 y(锚定) 版，用于在某个起点上精确裁决谁赢
//   colorCodes 与 compiledPatterns 同序的颜色码
const scanCache = new WeakMap()

// 合成单遍扫描结构
//
// 为什么这样做：旧实现是「每条规则各自把整段扫一遍」，成本 O(规则数 × 段长)，
// 被其它规则包含的子集规则也会各扫一遍整段。这里改成「单遍定位 + 起点精确裁决」：
//   1) 用合并大正则一次性找到当前最早命中的起点 s；
//   2) 只在 s 这一点用各规则的锚定版逐条试，取「跨度最短者、等跨度取原序最先者」
//      ——这正是旧终端的裁决口径（matches.sort((a,b)=>a.start-b.start||a.end-b.end)
//      再跳过重叠）；
//   3) 命中跨度 [s,e) 后从 e 继续找下一个起点。
// 主正则把整段扫成一遍，规则数不再乘以段长；被包含的短规则不会因为「另有一条
// 包含它的长规则」而重复扫整段——它只在真正竞争的起点上参与一次锚定比较。
function buildScan (patterns) {
  if (!patterns || patterns.length === 0) {
    return null
  }
  if (scanCache.has(patterns)) {
    // 可能是 null（合并失败的退化标记），也要命中缓存，避免每次重建
    return scanCache.get(patterns)
  }
  const colorCodes = []
  const sticky = []
  const sources = []
  let ok = true
  for (const p of patterns) {
    colorCodes.push(p.colorCode)
    try {
      // 锚定版：lastIndex=s 时只认「恰好在 s 起点」的命中，用来裁决同起点谁赢。
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
      struct = { combined, sticky, colorCodes }
    } catch (e) {
      // 用户规则里有重名命名分组等导致无法合并：退回逐规则扫描（_collectMatches 判断）
      console.error('Invalid combined keyword regex, falling back:', e)
      struct = null
    }
  }
  scanCache.set(patterns, struct)
  return struct
}

export class KeywordHighlighterAddon {
  constructor (keywords) {
    // 编译走进程级共享缓存（keyword-compile.js）：同一份配置开 N 个页签、
    // 断线重连 N 次都只编译一次，不再每个终端常驻一套 RegExp。
    // 缓存按内容摘要命中，所以这里不必保留 keywords 数组。
    this.compiledPatterns = compileKeywords(keywords)
    // 单遍扫描结构（同样按共享数组身份只建一次）
    this._scan = buildScan(this.compiledPatterns)
    // Lines longer than this are written without highlighting. Write coalescing
    // in the attach addon merges ordinary command output (e.g. `show running-config`)
    // into chunks well over this size, so large writes are highlighted line by
    // line instead of being skipped whole; only single huge lines are skipped.
    this.maxHighlightLength = 4096
    // Writes larger than this bypass keyword highlighting entirely: a command
    // flood or download progress, where scanning every byte (and rebuilding the
    // result string) is pure overhead.
    this.maxHighlightChunkLength = 256 * 1024
    // Upper bound on match objects collected per text segment. A flooded line
    // ("error error error...") otherwise allocates one record per hit; with the
    // DB grid the same rule of thumb (see db-highlight.jsx), hits past the cap
    // are simply not coloured.
    this.maxMatchesPerSegment = 512
    // Compile the ANSI/OSC splitter once instead of allocating a new RegExp on
    // every write (this was the #1 allocation in the hot path under load).
    const ESC = String.fromCharCode(27) // \x1b
    const BEL = String.fromCharCode(7) // \x07
    // eslint-disable-next-line no-control-regex
    this._ansiPattern = new RegExp('(' + ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)|' + ESC + '\\[\\??[0-9;]*[A-Za-z])', 'g')
  }

  containsDcsSequence = (text) => {
    const ESC = String.fromCharCode(27)
    return text.includes(ESC + 'P')
  }

  escape = str => {
    return str.replace(/\\x1B/g, '\\x1B')
      .replace(/\033/g, '\\033')
  }

  // 在「单遍定位」给出的起点 s 上做精确裁决：在所有恰好于 s 命中的规则里，取
  // 跨度最短者；跨度相同则取原序最先者（与旧终端 matches.sort 完全一致）。
  // 返回 { end, colorCode } 或 null（没有规则在 s 命中非空跨度）。
  _arbitrateAt = (content, s) => {
    const { sticky, colorCodes } = this._scan
    let bestEnd = -1
    let bestColor
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
        bestColor = colorCodes[i]
      }
    }
    if (bestEnd === -1) {
      return null
    }
    return { end: bestEnd, colorCode: bestColor }
  }

  // 单遍收集一段纯文本里的全部命中（坐标基于原文）。
  // 优先用「合并大正则定位 + 起点锚定裁决」；合并失败时退回逐规则扫描。
  _collectMatches = (content) => {
    const matches = []
    const cap = this.maxMatchesPerSegment
    if (this._scan) {
      const { combined } = this._scan
      let from = 0
      const len = content.length
      while (from < len) {
        combined.lastIndex = from
        const m = combined.exec(content)
        if (!m) {
          break
        }
        // 合并正则取到的是「最早命中的起点」，具体谁赢、跨度多少要锚定裁决
        const start = m.index
        const win = this._arbitrateAt(content, start)
        if (!win || win.end <= start) {
          // 理论上不会发生（合并命中说明有规则在此命中）；跳过一格防死循环
          from = start + 1
          continue
        }
        matches.push({
          start,
          end: win.end,
          text: content.slice(start, win.end),
          colorCode: win.colorCode
        })
        if (matches.length >= cap) {
          break
        }
        // 从裁决出的跨度末尾继续（合并正则 lastIndex 可能更远，以裁决为准）
        from = win.end
      }
      return matches
    }
    // 退化路径：逐规则扫描（保持旧行为），仅在合并失败时使用；后续仍需排序去重叠
    for (const { re, colorCode } of this.compiledPatterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(content)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++
          continue
        }
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
          colorCode
        })
        if (matches.length >= cap) {
          break
        }
      }
      if (matches.length >= cap) {
        break
      }
    }
    return matches
  }

  highlightKeywords = (text) => {
    // Early exit if no patterns
    if (this.compiledPatterns.length === 0) {
      return text
    }

    // Split text into segments: ANSI/OSC sequences vs plain text
    // Match OSC sequences (ESC ] ... BEL or ESC ] ... ESC \) and CSI sequences (ESC [ ... letter)
    const ansiPattern = this._ansiPattern
    ansiPattern.lastIndex = 0

    const segments = []
    let lastIndex = 0
    let match

    while ((match = ansiPattern.exec(text)) !== null) {
      // Add plain text before this sequence
      if (match.index > lastIndex) {
        segments.push({ type: 'text', content: text.slice(lastIndex, match.index) })
      }
      // Add the ANSI sequence (don't highlight)
      segments.push({ type: 'ansi', content: match[0] })
      lastIndex = ansiPattern.lastIndex
    }

    // Add remaining plain text
    if (lastIndex < text.length) {
      segments.push({ type: 'text', content: text.slice(lastIndex) })
    }

    // Highlight only plain text segments
    const result = segments.map(seg => {
      if (seg.type === 'ansi') {
        return seg.content
      }
      const content = seg.content
      const matches = this._collectMatches(content)
      if (matches.length === 0) {
        return content
      }
      // 合并正则已保证命中按左到右、互不重叠；这里仍按「起点升序、同起点取更短」
      // 排一遍并跳过重叠，兜住退化路径与任何边界情况，结论与旧实现一致
      matches.sort((a, b) => a.start - b.start || a.end - b.end)
      const filtered = [matches[0]]
      for (let i = 1; i < matches.length; i++) {
        if (matches[i].start >= filtered[filtered.length - 1].end) {
          filtered.push(matches[i])
        }
      }
      // Build result with ANSI codes inserted at correct positions
      let highlighted = ''
      let pos = 0
      for (const m of filtered) {
        highlighted += content.slice(pos, m.start)
        highlighted += m.colorCode + m.text + '\u001b[0m'
        pos = m.end
      }
      highlighted += content.slice(pos)
      return highlighted
    }).join('')

    return result
  }

  // Highlight a write of any size: small writes in one pass, larger ones line
  // by line so a long line can't make the whole chunk skip highlighting.
  highlightChunk = (text) => {
    if (this.compiledPatterns.length === 0 || text.length > this.maxHighlightChunkLength) {
      return text
    }
    if (text.length <= this.maxHighlightLength) {
      return this.highlightKeywords(text)
    }
    return text.split('\n').map(line => {
      return line.length > this.maxHighlightLength
        ? line
        : this.highlightKeywords(line)
    }).join('\n')
  }

  activate (terminal) {
    this.terminal = terminal
    // Store the original write method properly bound to terminal
    this.originalWrite = terminal.write.bind(terminal)
    const self = this
    terminal.write = function (data) {
      if (typeof data !== 'string') {
        return self.originalWrite(data)
      }
      if (self.containsDcsSequence(data)) {
        return self.originalWrite(data)
      }
      // displayRaw applies to every write regardless of size: raw mode shows
      // escape sequences as text, so skipping escape() for large chunks would
      // let raw ESC bytes be interpreted by xterm instead of displayed.
      if (terminal.displayRaw) {
        return self.originalWrite(self.escape(data))
      }
      self.originalWrite(self.highlightChunk(data))
    }
  }

  dispose () {
    // Restore the original write method when disposing the addon
    this.terminal.write = this.originalWrite
    this.originalWrite = null
    this.terminal = null
  }
}
