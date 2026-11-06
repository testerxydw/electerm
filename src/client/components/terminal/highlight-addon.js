import { compileKeywords } from '../../common/keyword-compile.js'
import { activeKeywords } from '../../common/keyword-groups.js'
import { buildScan, collectMatches, applyCoverageGate } from '../../common/keyword-scan.js'

// 单遍扫描 + 家族 rank 裁决（V3：最左起点 → rank 小者胜 → 同 rank 取更长）已抽到
// common/keyword-scan.js，终端与网格共用同一套实现；
// 行级覆盖率闸（V2 §7.3）也在那一层，两端同实现。

const ESC_CHAR = '\u001b'
const BEL_CHAR = '\u0007'

// CSI 参数字节：'0'-'9' 与 ';'；终结字节：A-Z / a-z
const isParamByte = (code) => (code >= 48 && code <= 57) || code === 59
const isFinalByte = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122)

/**
 * 收集所有位于控制序列之外的换行下标。
 *
 * highlightKeywords 把 OSC（ESC ] ... BEL / ESC \）与 CSI（ESC [ ... letter）视作零宽
 * 段；一次写入超过 maxHighlightLength 时，highlightChunk 会把它按行拆开逐段扫描。
 * 朴素的 split('\n') 不认识控制序列：OSC 负载里带字面 \n 时，一条完整序列被切成
 * 两个半截序列分别送进 highlightKeywords，负载字节被当纯文本染色（ANSI 码插进
 * OSC 内部、序列被破坏），覆盖率闸也被压成「半行」窗口。
 *
 * 这里用轻量状态机跳过 OSC / CSI / 其它两字节 ESC 序列，只在序列之外记录 \n；
 * 序列内部的 \n 原样留在同一段里，由 highlightKeywords 一次看到完整 OSC，并对
 * 拼接后的整段 plain 只跑一次 applyCoverageGate（不退化成逐片段裁决）。
 * 未闭合的 OSC（写入被截断，缺 BEL / ESC \）一路保护到文本末尾，同样不切。
 *
 * @param {string} text 一次写入
 * @returns {number[]} 可安全切分的 \n 下标（升序）
 */
const plainNewlineIndexes = (text) => {
  const points = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === ESC_CHAR) {
      const next = text[i + 1]
      if (next === ']') {
        // OSC：直到 BEL 或 ESC \ 结束；未闭合则保护到末尾
        i += 2
        while (i < text.length) {
          if (text[i] === BEL_CHAR) {
            i++
            break
          }
          if (text[i] === ESC_CHAR && text[i + 1] === '\\') {
            i += 2
            break
          }
          i++
        }
        continue
      }
      if (next === '[') {
        // CSI：ESC [ 可选 '?' + 参数字节 + 一个终结字母
        let j = i + 2
        if (text[j] === '?') {
          j++
        }
        while (j < text.length && isParamByte(text.charCodeAt(j))) {
          j++
        }
        if (j < text.length && isFinalByte(text.charCodeAt(j))) {
          j++
        }
        i = j
        continue
      }
      // 其它两字节 ESC 序列（ESC c / ESC 7 / ESC P ...）：整体跳过。
      // DCS 已在 activate 里由 containsDcsSequence 早退，直接调 highlightChunk
      // 时保持与旧实现一致（负载按普通文本处理），不改变既有行为。
      i += 2
      continue
    }
    if (ch === '\n') {
      points.push(i)
    }
    i++
  }
  return points
}

export class KeywordHighlighterAddon {
  constructor (keywords, opts = {}) {
    // 密度闸默认开；纯「规则形状/配色」契约探针可传 { coverageGate: false } 关掉，
    // 断言「某正则染成某色」时不受密度策略干扰（密度策略由 keyword-density.spec.js 单独验收）。
    this.coverageGate = opts.coverageGate !== false
    this.coverageThreshold = opts.coverageThreshold
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

  // 热更新规则：设置面板勾/取消预设后，config.keywords 变化不会触发
  // Terminal 重新 mount（Term 是 react.Component 不是 manate，订阅不到 store），
  // 所以调用方在 componentDidUpdate 里 diff 后调这里；重新 compile + rebuild scan，
  // terminal.write 包装指向 this.highlightChunk → 自动读到新 patterns
  update (keywords) {
    const active = activeKeywords(keywords)
    this.compiledPatterns = compileKeywords(active)
    this._scan = buildScan(this.compiledPatterns)
  }

  escape = str => {
    return str.replace(/\\x1B/g, '\\x1B')
      .replace(/\033/g, '\\033')
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

    // V2 §7.3：覆盖率闸必须按「物理行」算，不能按写入片段算。ANSI/OSC 序列在
    // 终端里不占可见列，却会把一条物理行切成多个 text segment —— 若逐段独立跑闸，
    // 一段 88% + 一段 7% 的行会被当成两行，脏段被误丢或净段被误伤（QA 实证）。
    // 做法：先把所有纯文本段按序拼成 plain（ANSI 视作零宽），记录每段在 plain 里的
    // 偏移；逐段扫描后把命中平移到 plain 坐标系统一裁决；最后按段回写 ANSI。
    // 这样既保持原有「逐段扫描 + 每段命中上限」的语义，又让闸看到完整物理行。
    let plain = ''
    const plainSegments = []
    for (const seg of segments) {
      if (seg.type === 'ansi') {
        continue
      }
      seg.plainOffset = plain.length
      plain += seg.content
      plainSegments.push(seg)
    }
    if (plain.length === 0) {
      return text
    }

    const globalHits = []
    for (const seg of plainSegments) {
      const matches = collectMatches(seg.content, this.compiledPatterns, this._scan, this.maxMatchesPerSegment)
      if (matches.length === 0) {
        continue
      }
      // collectMatches 已经按家族 rank 裁决过去重叠（见 common/keyword-scan.js
      // selectByRank），这里只做坐标平移，不再重复排一遍——重复的「同起点取最短」
      // 会把 rank 裁决的结果按长度改回去。
      for (const m of matches) {
        globalHits.push({
          start: seg.plainOffset + m.start,
          end: seg.plainOffset + m.end,
          tier: m.tier,
          colorCode: m.colorCode,
          text: m.text,
          seg,
          localStart: m.start,
          localEnd: m.end
        })
      }
    }
    if (globalHits.length === 0) {
      return text
    }
    globalHits.sort((a, b) => a.start - b.start || a.end - b.end)
    const ordered = [globalHits[0]]
    for (let i = 1; i < globalHits.length; i++) {
      if (globalHits[i].start >= ordered[ordered.length - 1].end) {
        ordered.push(globalHits[i])
      }
    }
    // 一次裁决：按 plain 的 \n 逐行算占比，超阈值行只保留 signal 命中
    const kept = applyCoverageGate(plain, ordered, {
      enabled: this.coverageGate,
      threshold: this.coverageThreshold
    })
    const keptBySeg = new Map()
    for (const h of kept) {
      if (!keptBySeg.has(h.seg)) {
        keptBySeg.set(h.seg, [])
      }
      keptBySeg.get(h.seg).push(h)
    }

    return segments.map(seg => {
      if (seg.type === 'ansi') {
        return seg.content
      }
      const hits = keptBySeg.get(seg)
      if (!hits || hits.length === 0) {
        return seg.content
      }
      let highlighted = ''
      let pos = 0
      for (const h of hits) {
        highlighted += seg.content.slice(pos, h.localStart)
        highlighted += h.colorCode + h.text + '\u001b[0m'
        pos = h.localEnd
      }
      highlighted += seg.content.slice(pos)
      return highlighted
    }).join('')
  }

  // Highlight a write of any size: small writes in one pass, larger ones line
  // by line so a long line can't make the whole chunk skip highlighting.
  // 切分只在「控制序列之外」的 \n 处进行（见 plainNewlineIndexes）：OSC 负载里的
  // 字面 \n 不再是切点，一条跨行 OSC 完整留给同一次 highlightKeywords 处理。
  highlightChunk = (text) => {
    if (this.compiledPatterns.length === 0 || text.length > this.maxHighlightChunkLength) {
      return text
    }
    if (text.length <= this.maxHighlightLength) {
      return this.highlightKeywords(text)
    }
    const points = plainNewlineIndexes(text)
    if (points.length === 0) {
      // 没有序列外换行：整段就是一段超长行，沿用「超长单段原样跳过」
      return text
    }
    const parts = []
    let start = 0
    for (const p of points) {
      parts.push(text.slice(start, p))
      start = p + 1
    }
    parts.push(text.slice(start))
    return parts.map(part => {
      return part.length > this.maxHighlightLength
        ? part
        : this.highlightKeywords(part)
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
