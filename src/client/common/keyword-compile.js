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

const maxEntries = 4
// 摘要用不可打印分隔符拼接，规则文本里出现任何字符都不会和分隔符撞车
const patternSep = '\u0000'
const fieldSep = '\u0001'

// 编译产物：re 供扫描，color 给网格拼 CSS class，colorCode 给终端插 ANSI
const colorCodes = {
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m',
  red: '\u001b[31m'
}

const cache = new Map()

export const keywordsSignature = (keywords) => {
  let sig = ''
  for (const item of keywords || []) {
    const { keyword, color = 'red' } = item || {}
    if (!keyword) {
      continue
    }
    sig += keyword + patternSep + color + fieldSep
  }
  return sig
}

function build (keywords) {
  const out = []
  for (const item of keywords || []) {
    const { keyword, color = 'red' } = item || {}
    if (!keyword) {
      continue
    }
    try {
      // 用户自定义规则可能不合法，跳过即可，不要拖垮终端或整表
      out.push({ re: new RegExp(keyword, 'gi'), color, colorCode: colorCodes[color] || colorCodes.red })
    } catch (e) {
      console.error('Invalid keyword regex:', keyword, e)
    }
  }
  return out
}

/**
 * 取得（必要时才编译）这份规则集合的共享 RegExp 列表。
 * @param {Array<{keyword: string, color?: string}>} keywords
 * @returns {Array<{re: RegExp, color: string, colorCode: string}>} 只读，进程内共享
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
