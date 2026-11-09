/**
 * N5a · Redis 命令控制台的渲染层纯函数（零依赖，不引 React）
 *
 * 这里只有"把主进程给的结论画出来"的部分：回复分型、补全候选归一、
 * 补全落点计算、拒绝原因 → 词条 key。**判定本身不在这条文件里** ——
 * 分词与放行/拒绝只发生在主进程（`redis-command-policy.js`），
 * 客户端就算把这里的函数改成一律返回"可以"，也改不动下一次 op 的结论。
 *
 * 四条口径（都是测试重点）：
 *
 * 1) **原因码到词条只认这一张表**。主进程回的是机器码（`readonly-refuse` 等），
 *    组件不许自己拼字符串；与 N3a/N3b 的 `db-ddl-reason.js` 同一套路。
 * 2) **回复分型不改数据**。主进程已经按节点数/长度封过顶（保护 IPC），这里再截一次
 *    只是"屏幕上一次别画五千行"，两者是不同的上限，所以标记也分开给
 *    （`mainTruncated` / `rowsTruncated`），文案不许混用。
 * 3) **补全候选走 `rankItems`**。打分、稳定排序、截断 30 条这些性质已经在
 *    `db-quick-open.js` 里钉死并测过，控制台没有理由再造一套排序。
 * 4) **补全只补命令名**。参数位（键名）需要当前库的键空间，等 N5b 的大 Key 列表
 *    一起做；现在给键名补全只会因 SCAN 而拖慢输入。
 * 5) **会写的命令在生产连接上走既有确认闸门**（AGENTS.md §5.2.6）：档位取自
 *    主进程随命令表交下来的 `write` 三态，客户端不复写一份风险名单。
 *    `firstWord` 只服务"要不要多问一句"，放行判定从不看它。
 */

import { rankItems } from './db-quick-open.js'
import { RISK_UNKNOWN, RISK_WRITE } from './db-sql-risk.js'

/** 拒绝/提示机器码 → i18n key（补全列表的徽标与执行后的横幅共用这一张表） */
export const ConsoleReasonKey = {
  ok: 'dbRedisConsoleHintOk',
  'empty-command': 'dbRedisConsoleHintEmpty',
  'unterminated-quote': 'dbRedisConsoleHintQuote',
  'bad-name': 'dbRedisConsoleHintName',
  'line-too-long': 'dbRedisConsoleHintTooLong',
  destructive: 'dbRedisConsoleBlockedDestructive',
  admin: 'dbRedisConsoleBlockedAdmin',
  streaming: 'dbRedisConsoleBlockedStreaming',
  pubsub: 'dbRedisConsoleBlockedPubsub',
  'connection-state': 'dbRedisConsoleBlockedConnState',
  scripting: 'dbRedisConsoleBlockedScripting',
  blocking: 'dbRedisConsoleBlockedBlocking',
  'readonly-refuse': 'dbRedisConsoleBlockedReadonly',
  'unknown-command': 'dbRedisConsoleBlockedUnknown',
  other: 'dbRedisConsoleHintOther'
}

export const consoleReasonKey = reason => ConsoleReasonKey[reason] || ConsoleReasonKey.other

/**
 * 屏幕上一次渲染的回复行数上限（与主进程的 IPC 封顶是两回事）。
 * 超过它不是"数据被丢了"，是"还没画到"，所以提示语必须说"仅显示前 N 行"。
 */
export const REPLY_VISIBLE_ROWS = 500

/**
 * 主进程下来的回复值 → 类型标签。
 *
 * RESP2 在 ioredis 里的形状只有五种：`null`（nil / 空 bulk）、`number`（整数）、
 * `string`（bulk / 简单字符串）、`Buffer`（仅 keyBuffer 类调用，这里不出现）、
 * `Array`（多值，集合与哈希摊平成偶/奇配对）。**数组内成对摊平**是 RESP2 哈希的
 * 固有形状，不是我们的猜测：所以 `isPairs` 由调用方按命令名给出，这里不猜。
 */
export function replyKind (value) {
  if (value === null || value === undefined) {
    return 'nil'
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'integer'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (typeof value === 'string') {
    return 'bulk'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return 'object'
}

/**
 * redis-cli 风格的头部：`(integer) 42` / `(nil)` / `(empty array)`。
 *
 * 记法本身是 redis-cli 的通用写法，不翻译；只有"几条"这个量词要跟着界面语言走，
 * 所以译函数由调用方注入（`t`）—— 纯模块不引 window，也不自带一份中文。
 */
export function replyHeader (value, t) {
  const kind = replyKind(value)
  if (kind === 'nil') {
    return '(nil)'
  }
  if (kind === 'integer') {
    return `(integer) ${String(value)}`
  }
  if (kind === 'boolean') {
    return `(boolean) ${value ? 'true' : 'false'}`
  }
  if (kind === 'array') {
    return value.length
      ? `(array) ${t('dbRedisConsoleItemCount').replace('{n}', String(value.length))}`
      : '(empty array)'
  }
  if (kind === 'object') {
    const n = Object.keys(value || {}).length
    return n ? `(map) ${t('dbRedisConsoleItemCount').replace('{n}', String(n))}` : '(empty map)'
  }
  return '(string)'
}

function cellText (v) {
  if (v === null || v === undefined) {
    return '(nil)'
  }
  if (typeof v === 'string') {
    return v
  }
  // 渲染进程没有 Node 的 Buffer 全局（nodeIntegration 关闭）：二进制值在主进程
  // capReply 里已经转成字符串才过 IPC，这里不再设二进制分支
  return String(v)
}

/**
 * 回复 → 行列表 `{ id, depth, label, kind, text }` + `rowsTruncated`。
 *
 * `depth` 只用于缩进：RESP2 的嵌套数组（如 XRANGE 的条目）会多一层，
 * 递归摊平并给每层编号，比把整棵子树 `JSON.stringify` 成一行更好读。
 * 环？ioredis 的回复是服务端构造的纯数据树，不存在环；这里也不做 visited
 * 检查，因为加了就等于承认我们不确定输入形状。
 */
export function flattenReply (value) {
  const rows = []
  let truncated = false
  let seq = 0
  const push = (depth, label, v) => {
    if (rows.length >= REPLY_VISIBLE_ROWS) {
      truncated = true
      return
    }
    const kind = replyKind(v)
    if (kind === 'array' || kind === 'object') {
      rows.push({ id: `n${seq++}`, depth, label, kind, text: '' })
      walk(v, depth + 1)
      return
    }
    rows.push({ id: `n${seq++}`, depth, label, kind, text: cellText(v) })
  }
  const walk = (v, depth) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => push(depth, String(i + 1), item))
      return
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        push(depth, k, v[k])
      }
    }
  }
  const top = replyKind(value)
  if (top === 'array' || top === 'object') {
    walk(value, 0)
    if (!rows.length) {
      truncated = false
    }
  } else {
    push(0, '', value)
  }
  return { rows, rowsTruncated: truncated, kind: top }
}

/**
 * 复制用的纯文本（近似 redis-cli 的输出）。
 *
 * 与 `flattenReply` 分开是有意的：复制到剪贴板的东西不该带"仅显示前 N 行"的截断，
 * 也不该带行号 —— 那是屏幕上的排版，不是数据。
 */
export function replyToText (value) {
  const kind = replyKind(value)
  if (kind === 'nil') {
    return '(nil)'
  }
  if (kind === 'integer') {
    return String(value)
  }
  if (kind === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (kind === 'bulk') {
    return value
  }
  if (kind === 'array') {
    return value.map(v => replyToText(v)).join('\n')
  }
  return JSON.stringify(value, null, 2)
}

/**
 * 当前输入光标所在的 token —— 补全的落点。
 *
 * 返回 `{ active, token, start, end, isCommand }`：
 * - `active=false`：光标在一个已加引号的段里（那是值，不是命令名），或压根没输入；
 * - `isCommand`：token 前面只剩空白 → 这是命令名位置，只在这一档才给命令补全；
 * - `start/end`：替换区间，`applyCompletion` 按它拼接，避免"整行被覆盖"这种粗暴替换。
 */
export function completionContext (line, caret) {
  const s = String(line === undefined || line === null ? '' : line)
  const at = Math.max(0, Math.min(Number.isFinite(caret) ? caret : s.length, s.length))
  const before = s.slice(0, at)
  const m = /(\S*)$/.exec(before)
  const token = m ? m[1] : ''
  const start = at - token.length
  if (token.startsWith('"') || token.startsWith("'")) {
    return { active: false, token, start, end: at, isCommand: false }
  }
  const isCommand = /^\s*$/.test(s.slice(0, start))
  return { active: token.length > 0 || isCommand, token, start, end: at, isCommand }
}

/**
 * 把候选文本写回输入行，返回新行与新的光标位置。
 *
 * 两个位置的语义不同：
 * - 命令位：只替换当前 token，大写 + 尾随空格，**保留光标后面的内容**
 *   （在 `HGETALL` 中间补 `HGET` 不该把 `ALL` 吃掉）；
 * - 参数位：候选是整行历史，接受它等于"重跑那一行"，所以整行替换。
 *   把整行历史塞进当前 token 会拼出 `GET HGETALL foo` 这种没人敲过的命令。
 */
export function applyCompletion (line, caret, insert) {
  const ctx = completionContext(line, caret)
  const s = String(line === undefined || line === null ? '' : line)
  const text = String(insert === undefined || insert === null ? '' : insert)
  if (!ctx.isCommand) {
    return { line: text, caret: text.length }
  }
  const value = text ? `${text.toUpperCase()} ` : text
  const next = s.slice(0, ctx.start) + value + s.slice(ctx.end)
  return { line: next, caret: ctx.start + value.length }
}

/**
 * 命令名表 → quick-open item。
 *
 * - `kind:'action'`：`db-quick-open` 只认三种 kind，命令是"可执行的东西"，归 action；
 * - `hint` 位放**词条 key**（不是译文）：`ok` 之外都是"这条在本实例现在会被拦"，
 *   结论由主进程 `readOnlyHint` 按权威只读位算出，客户端不再自己分类一遍
 *   （自己分类就等于在渲染层复制了一份策略，两份迟早分叉）；
 * - 大写标题：Redis 命令名习惯大写，`rankItems` 的匹配本身大小写不敏感，
 *   不影响命中，只是让列表与 redis-cli 的观感一致。
 */
export function commandItems ({ entries } = {}) {
  const list = Array.isArray(entries) ? entries : []
  return list.map(e => {
    if (!e || typeof e.name !== 'string' || !e.name) {
      return null
    }
    const hint = typeof e.hint === 'string' ? e.hint : 'ok'
    const blocked = hint !== 'ok'
    return {
      kind: 'action',
      id: `cmd:${e.name.toLowerCase()}`,
      title: e.name.toUpperCase(),
      subtitle: e.flags && e.flags.length ? e.flags.join(' · ') : '',
      hint: blocked ? consoleReasonKey(hint) : '',
      blocked,
      insert: e.name.toUpperCase(),
      arity: Number.isFinite(e.arity) ? e.arity : 0
    }
  }).filter(Boolean)
}

/** 历史条数上限：与命令面板的"历史前 20"同一档，再多就没人看得完 */
export const RECENT_MAX = 20

/** 历史命令 → quick-open item（`kind:'history'`，顺序即最近优先，rankItems 保稳定） */
export function recentItems (recent) {
  const list = Array.isArray(recent) ? recent : []
  const out = []
  const seen = new Set()
  for (const line of list) {
    const text = String(line === undefined || line === null ? '' : line).trim()
    if (!text || seen.has(text)) {
      continue
    }
    seen.add(text)
    out.push({ kind: 'history', id: `recent:${text}`, title: text, insert: text })
    if (out.length >= RECENT_MAX) {
      break
    }
  }
  return out
}

/**
 * 补全候选：命令位只出命令名，参数位只出整行历史。
 *
 * 为什么不在命令位混历史：历史项的标题是整行（`HGET k f`），在只打了 `hg` 的时候
 * 它匹配得上，但会跟命令名挤在同一批 30 条里 —— 用户此时想要的是命令名，
 * 混进来的整行只会把 `HGETALL` 顶出屏幕。参数位反过来：那里要的是"我刚才敲过的那行"。
 */
export function consoleCandidates ({ entries, recent, line, caret } = {}) {
  const ctx = completionContext(line, caret)
  if (!ctx.active) {
    return { ctx, items: [] }
  }
  const items = ctx.isCommand
    ? commandItems({ entries })
    : recentItems(recent)
  return { ctx, items: rankItems(items, ctx.token).map(r => r.item) }
}

/**
 * 首词（命令名）—— **只用于提示与生产确认**，不参与放行判定。
 *
 * 放行用的是主进程那份带引号规则的 `tokenize`；这里只取第一个空白/引号前的词，
 * 因为它只决定"要不要多问用户一句"。判错了最多是多一次确认；
 * 少确认的风险由主进程的只读位兜着（那边拿的是整行原文，不是这里的猜测）。
 */
export function firstWord (line) {
  const s = String(line === undefined || line === null ? '' : line).trim()
  if (!s) {
    return ''
  }
  return s.split(/[\s'"]/)[0].toLowerCase()
}

/**
 * 生产连接上的确认档位（复用 `useDbGuard` 的 Redis 闸门，AGENTS.md §5.2.6：
 * 新增写路径必须走既有护栏，不另造一套）。
 *
 * 返回 `null` = 不用问；否则给风险档。判据取自主进程随命令表一起交下来的
 * `write` 三态，而不是这里自己数一遍：
 * - 明确只读 → 不问（生产上查个键长也要弹窗，用户会开始闭眼点确认）；
 * - 明确会写 → `write` 档；
 * - 命令表里查不到这条（禁用 COMMAND 的实例上的新命令）→ `unknown` 档，保守多问。
 */
export function consoleRisk ({ line, entries, readOnly, isProduction } = {}) {
  if (!isProduction || readOnly) {
    return null
  }
  const word = firstWord(line)
  if (!word) {
    return null
  }
  const list = Array.isArray(entries) ? entries : []
  const hit = list.find(e => e && typeof e.name === 'string' && e.name.toLowerCase() === word)
  if (!hit) {
    return RISK_UNKNOWN
  }
  // write:false → 只读命令；true / 缺失（老数据）→ 按会写处理
  return hit.write === false ? null : RISK_WRITE
}
