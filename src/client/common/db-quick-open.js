/**
 * 命令面板（Ctrl/Cmd+K）的纯函数层：打分 / 稳定排序 / 截断 / 分组。
 * （设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.5 附带项）
 *
 * UI 组件不在这条文件里：本模块只依赖"调用方已把四类来源（数据库对象 /
 * 动作 / 历史前 20 / 当前表相关）归一成 item"这一个前提 ——
 *   { kind: 'action' | 'object' | 'history', id, title, subtitle, hint, run }
 * 因此它可以被 node:test 用 vm 直接加载，组件层也可以整体替换而不动这里。
 *
 * 三条写死在注释里的边界（都是测试重点，改动前先读）：
 *
 * 1) **只匹配 title**。subtitle / hint 只参与展示。否则用户搜
 *    "public.users" 时会冒出一批"标题不含它、却排在前面"的幽灵结果 ——
 *    用户无法理解这些行为什么会命中，也不会信任这个面板。
 * 2) **同分稳定**。同分顺序 = 输入顺序（调用方保证动作表顺序即菜单顺序、
 *    历史即最近优先）。不许让比较函数同分返回 0 就完事：那种"稳定"
 *    取决于引擎排序算法的实现（V8 历史上对 >10 元素的数组用过不稳定
 *    快排）。这里装饰原始下标，把稳定变成比较函数自身的性质。
 * 3) **先排序后截断**。QUICK_OPEN_LIMIT 裁的是全局前 30，不是每组各 30。
 *
 * 另外两件本模块**不**做的事（调用方归一四类来源时的职责）：
 * 不去重（同一 id 可能同时出现在历史与当前表相关里，展示层合并）、
 * 不读任何 store / DOM —— 纯函数才能被上述方式测试。
 */

/** 面板最多展示条数（全局上限，排序之后才截断） */
export const QUICK_OPEN_LIMIT = 30

/** 分组顺序即默认展示顺序：动作 > 对象 > 历史 */
export const GROUP_ORDER = ['action', 'object', 'history']

/** 类型权重：动作 20 > 对象 10 > 历史 5（加在匹配分之上） */
const KIND_WEIGHT = {
  action: 20,
  object: 10,
  history: 5
}

/** 匹配分三档：前缀 > 子串 > 子序列 */
const MATCH_PREFIX = 100
const MATCH_SUBSTRING = 60
const MATCH_SUBSEQUENCE = 30

/**
 * 判断 query 的每个字符是否按顺序出现在 title 里（大小写不敏感的子序列）。
 *
 * 不做 trim：这是一个纯子序列判断，空白也是普通字符（query 'a b' 要求
 * title 里真的有一个空格）。调用方 scoreMatch 传入的已是 trim 后的值。
 *
 * 空 query 是任何字符串的子序列（数学上 vacuously true）—— rankItems
 * 不走这条路（空 query 直接给权重分），单独使用者自行留意。
 * 非字符串入参返回 false：脏 query 不该"匹配一切"，那会让一个
 * undefined 把整张表都算成命中。
 *
 * @param {string} query
 * @param {string} title
 * @returns {boolean}
 */
export function isSubsequence (query, title) {
  if (typeof query !== 'string' || typeof title !== 'string') {
    return false
  }
  const q = query.toLowerCase()
  const t = title.toLowerCase()
  let i = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      i++
    }
  }
  return i === q.length
}

/**
 * title 对非空 query 的匹配分（大小写不敏感，**只认 title**）。
 * @param {string} title 已 trim 的非空标题
 * @param {string} query 已 trim 的非空 query
 * @returns {number} 100 / 60 / 30；不命中 0
 */
function scoreMatch (title, query) {
  const t = title.toLowerCase()
  const q = query.toLowerCase()
  if (t.startsWith(q)) {
    return MATCH_PREFIX
  }
  if (t.includes(q)) {
    return MATCH_SUBSTRING
  }
  if (isSubsequence(q, t)) {
    return MATCH_SUBSEQUENCE
  }
  return 0
}

/**
 * 单个 item 对 query 的得分。
 *
 * 分数 = 匹配分 + 类型权重；**匹配分 0 时总分就是 0**，不因权重高而留下 ——
 * "不匹配却排前面"比"少了几个结果"更难排查。
 *
 * 空 query（trim 后为空）：不淘汰任何 item，分数 = 类型权重。这是面板
 * 刚打开时的默认清单，靠权重天然排出 动作→对象→历史。
 *
 * 容错口径：
 * - query 非字符串按空 query 处理（面板刚打开、输入框还没值的形态）；
 * - 脏 item（非对象 / title 非字符串 / title trim 后为空）返回 0 ——
 *   与"不匹配"同值，调用方的处理都是剔除，不需要区分原因；
 * - kind 不在三种之内时按权重 0 计分（rankItems 会直接当脏数据剔除，
 *   理由见 isRenderableItem 的注释）。
 *
 * @param {object} item { kind, id, title, subtitle, hint, run, ... }
 * @param {string} query 用户输入（允许 null / undefined / 带首尾空格）
 * @returns {number} 0 表示不匹配（调用方应剔除）
 */
export function scoreItem (item, query) {
  if (!item || typeof item !== 'object') {
    return 0
  }
  // 匹配用 trim 后的 title：标题首尾空白是数据噪声，用户眼睛看到的标题
  // 没有它，'  Select  ' 搜 'sel' 理应算前缀命中而不是掉到子串档。
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  if (title === '') {
    return 0
  }
  const weight = KIND_WEIGHT[item.kind] || 0
  const q = typeof query === 'string' ? query.trim() : ''
  if (q === '') {
    return weight
  }
  const match = scoreMatch(title, q)
  return match === 0 ? 0 : match + weight
}

/**
 * 可渲染的 item：title 是非空字符串（trim 后），kind 是三种之一。
 *
 * 为什么空 query 下也要这个检查（而不只是非空 query）：
 * 没有 title 的行画出来是一个空白行，用户既认不出也不敢点；而它在非空
 * query 下本来就被剔除。两个 query 下行为不一致，会让用户清空输入框的
 * 一瞬间凭空多出几行幽灵 —— 这比"少几行"更糟。统一剔除后，rankItems
 * 的返回值有一条不变式：每条都能直接渲染。
 *
 * kind 不在 GROUP_ORDER 里的同理：分组表只有三个 key，排进来也会在
 * groupItems 时凭空蒸发，"排了但看不见"比当场跳过更难查。
 *
 * @param {*} item
 * @returns {boolean}
 */
function isRenderableItem (item) {
  return !!item &&
    typeof item === 'object' &&
    typeof item.title === 'string' &&
    item.title.trim() !== '' &&
    GROUP_ORDER.includes(item.kind)
}

/**
 * 打分 → 稳定排序 → 截断到 QUICK_OPEN_LIMIT。
 *
 * 排序是**全局**的：高分可以插在不同 kind 之间（对象子串 70 压过动作
 * 子序列 50）。分组只发生在展示层（groupItems），不改变全局序。
 *
 * 容错：items 非数组、元素脏（null / 字符串 / 数字 / 缺 title）一律跳过，
 * 不抛错 —— 面板的输入来自四路异步来源，任何一路迟到或畸形都不该让
 * Ctrl+K 整个打不开。
 *
 * @param {Array<object>} items 四类来源归一后的 item 数组
 * @param {string} query 用户输入
 * @returns {Array<{item: object, score: number}>} 按分数降序，同分保持输入顺序
 */
export function rankItems (items, query) {
  if (!Array.isArray(items)) {
    return []
  }
  const q = typeof query === 'string' ? query.trim() : ''
  const scored = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!isRenderableItem(item)) {
      continue
    }
    const score = scoreItem(item, q)
    if (score <= 0) {
      continue
    }
    // index 只参与同分比较，不出现在返回值里
    scored.push({ item, score, index: i })
  }
  // 装饰原始下标：同分比下标，"稳定"不依赖引擎的排序算法实现
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  // 先排完 30 条，不是每组各留 30
  return scored
    .slice(0, QUICK_OPEN_LIMIT)
    .map(entry => ({ item: entry.item, score: entry.score }))
}

/**
 * 把 rankItems 的结果按 kind 分组（展示层用）。
 *
 * - 三个 key 恒在，空组给空数组：调用方可以直接 `groups.action.length`，
 *   不用先判 key 在不在 —— "缺 key"在 UI 里就是白屏；
 * - 组内保持 ranked 里的顺序（全局分数序在该组内的投影）；
 * - 元素原样搬运（同一个 { item, score } 引用），不复制对象 —— UI 要
 *   直接调 entry.item.run()。
 *
 * @param {Array<{item: object, score: number}>} ranked rankItems 的返回值
 * @returns {{action: Array<{item: object, score: number}>, object: Array, history: Array}}
 */
export function groupItems (ranked) {
  const groups = {}
  for (const kind of GROUP_ORDER) {
    groups[kind] = []
  }
  if (!Array.isArray(ranked)) {
    return groups
  }
  for (const entry of ranked) {
    if (!entry || typeof entry !== 'object' || !entry.item || typeof entry.item !== 'object') {
      continue
    }
    const kind = entry.item.kind
    if (GROUP_ORDER.includes(kind)) {
      groups[kind].push(entry)
    }
  }
  return groups
}
