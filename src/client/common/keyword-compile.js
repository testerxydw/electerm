/**
 * 关键字规则 → 已编译正则的共享缓存
 *
 * 终端（highlight-addon.js）与数据库网格（db-highlight.jsx）用同一份
 * `config.keywords`，但各自都曾经「每个实例编译一套 RegExp」：
 * - 终端：每个页签建一次，断线重连再来一次（term-socket.js 的 remoteInit）。
 *   全预设启用是 102 条规则，10 个页签 = 1020 个 RegExp 常驻。
 * - 网格：每个 DB 页签、每次配置摘要变化各编译一次。
 *
 * 这里按「规则内容摘要」缓存编译结果：同一份配置在进程内只编译一次，
 * 所有终端页签与数据库页签共用同一批 RegExp 对象。
 *
 * 共享 RegExp 是安全的：两个消费方都在扫描前把 lastIndex 归零，且整轮
 * exec 循环是同步的（不会在循环里被另一个实例重入），所以 lastIndex 不会
 * 被交叉改写。返回的数组是只读的，调用方不要就地修改。
 *
 * 缓存只留最近 maxEntries 份（用户切换 profile / 勾选不同预设会产生新摘要），
 * 避免"每改一次配置就永久留一套 RegExp"。
 */

import { COLOR_GROUPS } from './keyword-presets.js'

const maxEntries = 4
// 摘要用不可打印分隔符拼接，规则文本里出现任何字符都不会和分隔符撞车
const patternSep = '\u0000'
const fieldSep = '\u0001'

// 编译产物：re 供扫描，color 给网格拼 CSS（真彩色直接吃 hex，命名色走主题映射），
// colorCode 给终端插 ANSI（命名色走 colorCodes，真彩色走 38;2;r;g;b 真彩色序列）。
const colorCodes = {
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m',
  red: '\u001b[31m'
}

// 合法颜色：7 个 ANSI 命名色，或 #rrggbb 真彩色（大小写均可）。
const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const isHexColor = (c) => typeof c === 'string' && HEX_RE.test(c)

// #rrggbb → 真彩色 ANSI 序列 \x1b[38;2;r;g;bm
export const hexToTruecolor = (hex) => {
  const h = hex.slice(1)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `\u001b[38;2;${r};${g};${b}m`
}

// 把一条规则的 color 字段归一为「终端 ANSI 序列」：
// 命名色 → 查表；真彩色 → 真彩色序列；其它（含脏值）→ 退回 red。
export const colorToCode = (color) => {
  if (isHexColor(color)) {
    return hexToTruecolor(color)
  }
  return colorCodes[color] || colorCodes.red
}

// 设置面板取色器：ANSI 语义名（走主题映射，供 signal 档与用户自定义规则）+ 结构色组
// 的那批真彩色。真彩色条目直接由 keyword-presets.js 的 COLOR_GROUPS 派生——色板换色
// 时取色器自动跟上，不存在「预设色和可选手选色对不上」的第二种真相。
export const keywordPalette = [
  // 语义基线（命名色，走主题映射）
  { name: 'red', value: 'red', semantic: 'error' },
  { name: 'yellow', value: 'yellow', semantic: 'warn' },
  { name: 'green', value: 'green', semantic: 'ok' },
  { name: 'cyan', value: 'cyan', semantic: 'info' },
  { name: 'blue', value: 'blue', semantic: 'debug' },
  { name: 'magenta', value: 'magenta', semantic: 'null' },
  { name: 'white', value: 'white', semantic: 'misc' },
  // 结构真彩色（B-1 之后结构档一律离开语义名，色值只有一份）
  ...Object.entries(COLOR_GROUPS)
    .filter(([, def]) => isHexColor(def.color))
    .map(([group, def]) => ({ name: group, value: def.color, semantic: def.label }))
]

const cache = new Map()

export const keywordsSignature = (keywords) => {
  let sig = ''
  for (const item of keywords || []) {
    // tier 参与摘要：只改档位（signal ↔ structure）也必须重新编译，否则会命中
    // 旧缓存拿到过期 tier，行级覆盖率闸据此误判去留。
    // rank 同理：V3 的裁决按 rank 决胜，改了家族或 FAMILY_RANK 必须让缓存失效，
    // 否则新配置会拿旧 RegExp 的 rank 抢色，表现成"改了没生效"。
    const { keyword, color = 'red', tier = 'signal', rank = '' } = item || {}
    if (!keyword) {
      continue
    }
    sig += keyword + patternSep + color + patternSep + tier + patternSep + rank + fieldSep
  }
  return sig
}

function build (keywords) {
  const out = []
  for (const item of keywords || []) {
    const { keyword, color = 'red', tier, family, rank } = item || {}
    if (!keyword) {
      continue
    }
    try {
      // 用户自定义规则可能不合法，跳过即可，不要拖垮终端或整表
      // tier 透传：结构档（structure）命中在覆盖率闸里会被按需丢弃，语义档（signal）永远保留
      // family / rank 透传：重叠裁决按 rank 决胜（见 keyword-scan.js arbitrateAt）
      out.push({
        re: new RegExp(keyword, 'gi'),
        color,
        tier: tier || 'signal',
        family,
        rank: Number.isFinite(rank) ? rank : 50,
        colorCode: colorToCode(color)
      })
    } catch (e) {
      console.error('Invalid keyword regex:', keyword, e)
    }
  }
  return out
}

/**
 * 取得（必要时才编译）这份规则集合的共享 RegExp 列表。
 * @param {Array<{keyword: string, color?: string, tier?: string, family?: string, rank?: number}>} keywords
 * @returns {Array<{re: RegExp, color: string, colorCode: string, tier: string, rank: number}>} 只读，进程内共享
 */
export function compileKeywords (keywords) {
  const sig = keywordsSignature(keywords)
  if (!sig) {
    return []
  }
  const hit = cache.get(sig)
  if (hit) {
    // 命中即最近使用：删掉再插回，保持 Map 的插入顺序就是 LRU
    cache.delete(sig)
    cache.set(sig, hit)
    return hit
  }
  const patterns = build(keywords)
  if (cache.size >= maxEntries) {
    cache.delete(cache.keys().next().value)
  }
  cache.set(sig, patterns)
  return patterns
}

// 供测试与「设置里改了关键字」后的显式失效使用
export function clearKeywordCache () {
  cache.clear()
}

export const keywordCacheSize = () => cache.size
