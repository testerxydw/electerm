/**
 * N5a · Redis 命令控制台的执行层（主进程）
 *
 * 分工：判定在 redis-command-policy.js（纯函数），这一层只做三件事 ——
 * 把整行原文递到主进程来分词、按判定结果决定**发或不发**、把回复压到能安全过 IPC 的大小。
 *
 * 四条口径（都是测试重点）：
 *
 * 1) **拒绝不碰服务端**。黑名单/阻塞名单命中的命令在 `useDb` 之前就被挡掉，
 *    连 SELECT 都不会发生 —— 否则"拦住了"与"发出去了但没生效"在日志里看不出区别，
 *    而后者意味着我们其实已经把命令递给了 Redis。
 * 2) **两遍判定**。第一遍不带服务端属性（只查名字类规则：黑名单、阻塞名单、名字合法性），
 *    命中就立刻返回；第二遍才取 `COMMAND` 自述来回答只读位的问题。
 *    这样黑名单拒绝连一次额外的往返都不花，而属性判定仍然只用权威来源。
 * 3) **错误回复是结果，不是异常**。`ERR wrong number of arguments` 这类是 Redis 对这条
 *    命令的正常回答：控制台要把它作为红色回复画进历史，而不是让整个 op 抛出去
 *    （抛出去等于把"服务端说了什么"换成"IPC 调用失败"，用户看不到原文）。
 *    连接坏了仍按异常上抛 —— 那不是回复，是没法问。
 * 4) **只截大小，不改语义**。回复在过 IPC 前按节点数/深度/单值长度封顶，
 *    截断只以计数与 `truncated` 标记告知渲染层，不往数据里塞假元素。
 *
 * 已知边界（与 §10.12 的"局限"同一条）：
 * - 走 `call`（字符串解码）而不是 `callBuffer`，二进制值在这一版是有损的；
 * - 不在本地校验 arity：服务端自己报的 `ERR wrong number of arguments` 比我们的猜测准；
 * - 只读判定依赖服务端 `COMMAND` 自述，实例禁用 COMMAND 时回落到策略层的两份名单。
 */

const policy = require('./redis-command-policy')

/** 单行命令长度上限：超过它不是"用户在敲命令"，而是把整份数据贴进了输入框 */
const LINE_MAX_CHARS = 10000

/** 回复展平后的节点上限（数组元素 + Map 项都算节点） */
const REPLY_MAX_NODES = 3000
/** 嵌套深度上限：RESP2 里递归结构极少超过 5 层，到 8 已是异常形状 */
const REPLY_MAX_DEPTH = 8
/** 单个 bulk/string 值的字符上限 */
const REPLY_MAX_VALUE_CHARS = 32 * 1024

// sig 无关的 COMMAND 属性缓存：按 client 实例持有（WeakMap），连接断开即随之释放，
// 不需要额外清理通道，也不会出现"换了台同 host:port 的实例还拿旧属性"的串档
const flagsCache = new WeakMap()
const FLAGS_TTL = 60000

function cacheFlags (c, flagsByName) {
  try {
    flagsCache.set(c, { at: Date.now(), flagsByName })
  } catch (e) {
    // 缓存只是省一次 COMMAND 往返，存不进去（非对象等）不该影响判定
  }
  return flagsByName
}

/**
 * 服务端 `COMMAND` 自述 → `Map<名字, {arity, flags}>`；拿不到就返回 `null`，
 * 由策略层回落到名单。**取属性失败绝不等于"这条命令不安全"** ——
 * 禁用 COMMAND 的实例照样能用名单跑只读命令，这正是回落存在的理由。
 *
 * `force` 只由用户点「重新取命令表」传来：缓存是为了省掉每条命令一次往返，
 * 而用户主动要求重取时还给他 60 秒内的旧属性，那个按钮就等于不存在。
 */
async function loadFlagsByName (c, force) {
  const hit = flagsCache.get(c)
  if (!force && hit && Date.now() - hit.at < FLAGS_TTL) {
    return hit.flagsByName
  }
  let flagsByName = null
  try {
    flagsByName = policy.parseCommandReply(await c.call('COMMAND'))
    if (!flagsByName.size) {
      flagsByName = null
    }
  } catch (e) {
    flagsByName = null
  }
  return cacheFlags(c, flagsByName)
}

/** Buffer → 字符串（有损，见头部"已知边界"），其余原样 */
function toText (v) {
  return Buffer.isBuffer(v) ? v.toString('utf8') : v
}

/**
 * 回复封顶：返回 `{ value, truncated, droppedNodes, shortenedValues }`。
 *
 * 数组按广度截（保留前 N 项），因为控制台的典型回复是"一长串同类元素"；
 * 深度截断把超出的子树整个换成 `null` 并计数，避免把一层没见过的嵌套当真处理。
 */
function capReply (value) {
  let nodes = 0
  let droppedNodes = 0
  let shortenedValues = 0

  const walk = (v, depth) => {
    if (depth > REPLY_MAX_DEPTH) {
      droppedNodes++
      return null
    }
    if (v === null || v === undefined) {
      nodes++
      return null
    }
    if (Array.isArray(v)) {
      nodes++
      const out = []
      for (const item of v) {
        if (nodes >= REPLY_MAX_NODES) {
          droppedNodes++
          continue
        }
        out.push(walk(item, depth + 1))
      }
      return out
    }
    if (Buffer.isBuffer(v) || typeof v === 'string') {
      nodes++
      const text = toText(v)
      if (text.length > REPLY_MAX_VALUE_CHARS) {
        shortenedValues++
        return text.slice(0, REPLY_MAX_VALUE_CHARS)
      }
      return text
    }
    if (typeof v === 'object') {
      // RESP3 的 map / ioredis 的对象形状
      nodes++
      const out = {}
      for (const k of Object.keys(v)) {
        if (nodes >= REPLY_MAX_NODES) {
          droppedNodes++
          continue
        }
        out[k] = walk(v[k], depth + 1)
      }
      return out
    }
    nodes++
    return typeof v === 'number' || typeof v === 'boolean' ? v : String(v)
  }

  const shaped = walk(value, 1)
  return {
    value: shaped,
    truncated: droppedNodes > 0 || shortenedValues > 0,
    droppedNodes,
    shortenedValues
  }
}

/**
 * 服务端错误回复（RESP 的 `-ERR ...`）→ ioredis 抛 ReplyError。
 * 只认这个类：连接失败/超时等不是"回复"，必须继续上抛让前端走断连提示。
 */
function isReplyError (e) {
  if (!e) {
    return false
  }
  if (e.name === 'ReplyError') {
    return true
  }
  const ctor = e.constructor && e.constructor.name
  return ctor === 'ReplyError'
}

/**
 * 执行一条控制台命令。
 *
 * @param {object} conn 连接配置（dbClientOp 的 opConn）
 * @param {object} args `{ line, dbIndex, readOnly }`；readOnly 由 dbClientOp 从主进程
 *   实例配置注入，渲染层传什么都无效
 * @param {object} deps `{ useDb }`，由 redis.js 注入（避免与 redis.js 互相 require）
 * @returns {Promise<object>} 见文件头四条口径的结构化结果，**不抛**服务端错误
 */
async function runRedisCommand (conn, { line, dbIndex, readOnly } = {}, deps = {}) {
  const useDb = deps.useDb
  if (typeof useDb !== 'function') {
    throw new Error('runRedisCommand requires useDb injection')
  }
  const text = String(line === undefined || line === null ? '' : line)
  if (text.length > LINE_MAX_CHARS) {
    return { status: 'invalid', reason: 'line-too-long', readOnly: !!readOnly }
  }
  const parsed = policy.tokenize(text)
  if (!parsed.ok) {
    return { status: 'invalid', reason: parsed.reason, readOnly: !!readOnly }
  }
  const { command, args } = parsed
  const echo = { command, args, readOnly: !!readOnly }

  // 第一遍：只看命令名的规则（黑名单 / 阻塞名单 / 名字合法性）。
  // 命中即返回，绝不碰服务端 —— 也省掉一次 COMMAND 往返。
  const byName = policy.refuseByName({ command })
  if (!byName.allow) {
    return { status: 'blocked', reason: byName.reason, ...echo }
  }

  const c = await useDb(conn, dbIndex)
  const flagsByName = await loadFlagsByName(c)
  // 第二遍：带上服务端属性，回答"只读位下这条算不算写"
  const verdict = policy.evaluate({ command, readOnly, flagsByName })
  if (!verdict.allow) {
    return { status: 'blocked', reason: verdict.reason, ...echo }
  }

  const startedAt = Date.now()
  // "会不会改数据"只用于 UI 徽标（判定已经做完）；不知道就不标，见 isWriteCommand
  const write = policy.isWriteCommand({ command, flagsByName })
  try {
    const raw = await c.call(command, ...args)
    const shaped = capReply(raw)
    return {
      status: 'ok',
      ...echo,
      source: verdict.source,
      write,
      elapsedMs: Date.now() - startedAt,
      reply: shaped.value,
      truncated: shaped.truncated,
      droppedNodes: shaped.droppedNodes,
      shortenedValues: shaped.shortenedValues
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    // ReplyError（服务端给的错误回复）→ 作为结果展示；其余（连接/超时）继续抛
    if (isReplyError(e)) {
      return {
        status: 'error',
        ...echo,
        source: verdict.source,
        write,
        elapsedMs: Date.now() - startedAt,
        error: msg
      }
    }
    throw e
  }
}

/**
 * 命令名表 + 每条在**本实例当前只读位下**的提示，供渲染层做补全。
 *
 * 提示与执行判定共用 `readOnlyHint`（同一个 `evaluate`、同一个权威 readOnly），
 * 所以"补全里标了可用"与"真按回车时被拦下来"不可能各说一套 —— 渲染层不需要
 * 自己再分类一遍（那正是"两处真相"的开始）。
 */
async function listRedisCommands (conn, { dbIndex, readOnly, force } = {}, deps = {}) {
  const useDb = deps.useDb
  if (typeof useDb !== 'function') {
    throw new Error('listRedisCommands requires useDb injection')
  }
  const c = await useDb(conn, dbIndex)
  const flagsByName = await loadFlagsByName(c, force === true)
  const source = flagsByName ? 'server' : 'fallback'
  const list = []
  if (flagsByName) {
    for (const [name, entry] of flagsByName) {
      list.push({ name, arity: entry.arity, flags: entry.flags })
    }
  } else {
    list.push(...policy.fallbackCommandList())
  }
  const entries = list.map(e => ({
    ...e,
    hint: policy.readOnlyHint({ command: e.name, readOnly, flagsByName }),
    // 给 UI 的"写"徽标与生产确认用；null = 不知道（不标、按保守处理）
    write: policy.isWriteCommand({ command: e.name, flagsByName })
  }))
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  return { source, entries, readOnly: !!readOnly }
}

module.exports = {
  LINE_MAX_CHARS,
  REPLY_MAX_NODES,
  REPLY_MAX_DEPTH,
  REPLY_MAX_VALUE_CHARS,
  capReply,
  loadFlagsByName,
  runRedisCommand,
  listRedisCommands
}
