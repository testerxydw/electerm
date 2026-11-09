/**
 * N5a · Redis 命令控制台的策略层（纯函数，零依赖，可被 node:test 直接 require）
 *
 * 为什么单独一个文件而不是塞进 redis.js：redis.js 的职责是"按类型读写键"，
 * 控制台是"把任意一条命令安全地递出去"，两个变更理由不同；且这一层的判定
 * **必须**在主进程发生一次且只发生一次 —— 渲染层拿到的只是同一份结论的呈现。
 *
 * 三条口径（都是测试重点）：
 *
 * 1) **分词只信这里**。渲染层把整行原文发过来，主进程自己 tokenize。
 *    如果客户端发 `{command:'GET', args:[]}` 而原文是 `FLUSHALL`，照单执行
 *    就等于把护栏交给被护栏约束的那一方。
 * 2) **黑名单与只读是两件事**。BLOCKED 是无条件拒绝（只读开关再关也拦不住的那种：
 *    清库、KEYS 阻塞单线程、把共享连接带进 pubsub / MONITOR / 事务状态）；
 *    只读位管的是"这条命令会不会改动存储里的数据"。所以先查黑名单，再查只读。
 * 3) **认不出来的命令在只读下不放行**（"宁可不给"，与 N3a 的类型白名单同调）。
 *    命令的读写属性优先取服务端 `COMMAND` 自述（权威、跟版本走）；实例禁用 COMMAND
 *    时回落到下面两份名单，名单外一律 unknown-command。
 *
 * 只读的判据为什么是"flags 含 write/may-replicate/denyoom 就拒"而不是"含 readonly 才放"：
 * Redis 把 PING / INFO / COMMAND / TIME / SLOWLOG 归在 @server / @connection 类别，
 * 它们的 flags 里**没有** `readonly`，却确实不改任何数据。用"含 readonly 才放"会把
 * 只读诊断一起禁掉，用户只看到一串看不懂的拒绝。
 *
 * 黑名单条目都带原因码，UI 按码给词条（common/db-redis-console.js 是映射的唯一真源）。
 */

/** 无条件拒绝的命令 → 原因类别（reason） */
const BLOCKED = new Map([
  // —— 清库 / 阻塞单线程：§7 N5a 明确禁止，另加两条同量级的 ——
  ['flushdb', 'destructive'],
  ['flushall', 'destructive'],
  ['keys', 'destructive'],
  ['shutdown', 'destructive'],
  // 全量 RDB/AOF 落盘与复制关系变更：影响的是实例而不是一个键
  ['save', 'admin'],
  ['bgsave', 'admin'],
  ['bgrewriteaof', 'admin'],
  ['slaveof', 'admin'],
  ['replicaof', 'admin'],
  ['config', 'admin'],
  ['acl', 'admin'],
  ['debug', 'admin'],
  ['failover', 'admin'],
  // 注意 MEMORY 不在这里：它是只读诊断（N5b 还要用 MEMORY USAGE），拦掉等于把
  // 控制台最有用的一类命令一起禁了
  // —— 会把这条共享连接带离"普通请求"状态的命令 ——
  // 控制台与键树、详情、INFO 用的是同一条连接（按连接签名复用），
  // 进了 subscribe/monitor 模式后续所有 op 都会被当成消息流吞掉。
  ['monitor', 'streaming'],
  ['subscribe', 'pubsub'],
  ['unsubscribe', 'pubsub'],
  ['psubscribe', 'pubsub'],
  ['punsubscribe', 'pubsub'],
  // —— 改变连接自身协议/选中库/认证状态：与 currentDbMap、RESP 档位互相打脸 ——
  ['select', 'connection-state'],
  ['swapdb', 'connection-state'],
  ['hello', 'connection-state'],
  ['auth', 'connection-state'],
  ['quit', 'connection-state'],
  ['reset', 'connection-state'],
  ['client', 'connection-state'],
  // —— 事务族：连接级状态机，与控制台"一条命令一次往返"的模型冲突 ——
  ['multi', 'connection-state'],
  ['exec', 'connection-state'],
  ['discard', 'connection-state'],
  ['watch', 'connection-state'],
  ['unwatch', 'connection-state'],
  // —— 脚本可以做任何事，属性自述不可信（EVAL 的 flags 并不声明它会写）——
  ['eval', 'scripting'],
  ['evalsha', 'scripting'],
  ['eval_ro', 'scripting'],
  ['evalsha_ro', 'scripting'],
  ['fcall', 'scripting'],
  ['fcall_ro', 'scripting'],
  ['script', 'scripting'],
  ['function', 'scripting']
])

/**
 * 阻塞类命令：Redis 7 的 COMMAND 给 BLPOP 之类打 `blocking` flag，老版本没有，
 * 所以名字兜一层。XREAD/XREADGROUP 不带 BLOCK 时立即返回、带 BLOCK 时挂住连接，
 * 控制台不做参数级判断，一律拒。
 */
const BLOCKING_NAMES = new Set([
  'blpop', 'brpop', 'blmove', 'blmpop', 'bzmpop', 'bzpopmin', 'bzpopmax',
  'bpopmin', 'bpopmax', 'brpoplpush', 'wait', 'xread', 'xreadgroup'
])

/** flags 里出现这些词就算"会改动数据"（只读位据此拒绝） */
const WRITE_FLAGS = ['write', 'may-replicate', 'denyoom']

/**
 * COMMAND 拿不到时的回落名单：确定不改数据的常见读命令 + 只读诊断。
 * 名单外一律 unknown-command —— 拿不到权威属性时宁可给解释，也不猜"这条大概无害"。
 */
const FALLBACK_READ = new Set([
  // string / key
  'get', 'mget', 'getrange', 'substr', 'strlen', 'getbit', 'bitcount', 'bitpos',
  'bitfield_ro', 'exists', 'type', 'ttl', 'pttl', 'expiretime', 'pexpiretime',
  'dbsize', 'scan', 'randomkey', 'dump', 'object', 'sort_ro', 'lcs', 'echo', 'ping',
  // hash
  'hget', 'hmget', 'hgetall', 'hkeys', 'hlen', 'hvals', 'hscan', 'hstrlen', 'hrandfield',
  // list
  'lindex', 'lrange', 'llen', 'lpos',
  // set
  'smembers', 'scard', 'sismember', 'smismember', 'sscan', 'srandmember',
  'sdiff', 'sinter', 'sunion',
  // zset / geo / hyperloglog
  'zrange', 'zrangebyscore', 'zrangebylex', 'zrevrange', 'zrevrangebyscore',
  'zrevrangebylex', 'zcard', 'zcount', 'zscore', 'zmscore', 'zrank', 'zrevrank',
  'zscan', 'zlexcount', 'zdiff', 'zinter', 'zunion', 'zrandfield', 'geopos',
  'geodist', 'geohash', 'geosearch', 'pfcount',
  // stream
  'xlen', 'xrange', 'xrevrange', 'xinfo', 'xpending',
  // 实例级诊断（INFO/SLOWLOG 已有专用 op，这里让控制台也能手敲同一批只读命令）
  'memory', 'info', 'command', 'slowlog', 'latency', 'time', 'lastsave', 'cluster'
])

/** COMMAND 拿不到时的回落名单：会改动数据的命令（只读位据此拒绝） */
const FALLBACK_WRITE = new Set([
  'set', 'setnx', 'setex', 'psetex', 'setrange', 'setbit', 'append', 'getset', 'getdel',
  'getex', 'mset', 'msetnx', 'incr', 'decr', 'incrby', 'decrby', 'incrbyfloat',
  'bitfield', 'bitop', 'hset', 'hsetnx', 'hmset', 'hdel', 'hincrby', 'hincrbyfloat',
  'lset', 'linsert', 'lpush', 'rpush', 'lpushx', 'rpushx', 'lpop', 'rpop', 'ltrim',
  'lmove', 'rpoplpush', 'sadd', 'srem', 'spop', 'smove', 'sinterstore', 'sunionstore',
  'sdiffstore', 'zadd', 'zrem', 'zincrby', 'zpopmax', 'zpopmin', 'zrangestore',
  'zdiffstore', 'zinterstore', 'zunionstore', 'zremrangebyscore', 'zremrangebylex',
  'zremrangebyrank', 'xadd', 'xtrim', 'xdel', 'xgroup', 'xsetid', 'xack', 'xautoclaim',
  'xclaim', 'pfadd', 'pfmerge', 'geoadd', 'geosearchstore', 'restore', 'rename',
  'renamenx', 'del', 'unlink', 'expire', 'expireat', 'pexpire', 'pexpireat', 'persist',
  'sort', 'publish'
])

const NAME_RE = /^[a-z][a-z0-9_@.-]*$/i

/**
 * 整行 → `{ command, args }`。
 *
 * 引号规则（与 redis-cli 的行为一致）：
 * - 单/双引号包住的一段算一个 token，引号内 `\x` 取下一个字符本身；
 * - 引号外的反斜杠转义下一个字符（`\ ` 是含空格的参数）；
 * - 未闭合引号不当"参数到此为止"处理，直接报错 —— 半截 `SET k "a b` 静默执行成
 *   `SET k a` 是把用户的数据改掉，比报错糟得多。
 *
 * @param {string} line
 * @returns {{ok: boolean, command?: string, args?: string[], reason?: string}}
 */
function tokenize (line) {
  const s = String(line === undefined || line === null ? '' : line)
  const tokens = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    let token = ''
    let closed = true
    while (i < s.length) {
      const c = s[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        break
      }
      if (c === '"' || c === "'") {
        const quote = c
        i++
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\' && i + 1 < s.length) {
            token += s[i + 1]
            i += 2
            continue
          }
          token += s[i]
          i++
        }
        if (i >= s.length) {
          closed = false
          break
        }
        i++ // 收尾引号
        continue
      }
      if (c === '\\' && i + 1 < s.length) {
        token += s[i + 1]
        i += 2
        continue
      }
      token += c
      i++
    }
    if (!closed) {
      return { ok: false, reason: 'unterminated-quote' }
    }
    tokens.push(token)
  }
  if (!tokens.length) {
    return { ok: false, reason: 'empty-command' }
  }
  const command = tokens[0]
  if (!NAME_RE.test(command)) {
    return { ok: false, reason: 'bad-name' }
  }
  return { ok: true, command, args: tokens.slice(1) }
}

/**
 * 服务端 `COMMAND` 原始输出 → `Map<小写命令名, {arity, flags[]}>`。
 *
 * RESP2 的 COMMAND 是"每条命令一个数组"，形状跨版本会变（Redis 7 多了
 * key spec 等尾部元素），所以只取前三位固定的 name/arity/flags，
 * 位置解析容错、脏条目跳过（与慢日志条目同一口径）。
 */
function parseCommandReply (raw) {
  const out = new Map()
  if (!Array.isArray(raw)) {
    return out
  }
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      continue
    }
    const name = entry[0].toLowerCase()
    if (!name) {
      continue
    }
    const arity = Number.isFinite(Number(entry[1])) ? Number(entry[1]) : 0
    const flags = Array.isArray(entry[2])
      ? entry[2].filter(f => typeof f === 'string').map(f => f.toLowerCase())
      : []
    out.set(name, { arity, flags })
  }
  return out
}

function isWriteFlags (flags) {
  return flags.some(f => WRITE_FLAGS.includes(f))
}

/**
 * 只看命令名就能给出的拒绝：名字合法性 + 黑名单 + 阻塞名单。
 *
 * 执行层先过这一道，命中就不需要再取服务端属性（也就不会为一条注定被拒的命令
 * 多花一次 `COMMAND` 往返）。`evaluate` 的前三条规则直接复用它，两者不会分叉。
 */
function refuseByName ({ command } = {}) {
  const name = String(command || '').toLowerCase()
  if (!name || !NAME_RE.test(name)) {
    return { allow: false, reason: 'bad-name' }
  }
  if (BLOCKED.has(name)) {
    return { allow: false, reason: BLOCKED.get(name) }
  }
  if (BLOCKING_NAMES.has(name)) {
    return { allow: false, reason: 'blocking' }
  }
  return { allow: true }
}

/**
 * 一条命令能不能发出去。
 *
 * @param {object} opts
 * @param {string} opts.command 分词得到的命令名（原样大小写，判定的内部统一小写）
 * @param {string[]} [opts.args]
 * @param {boolean} opts.readOnly 主进程侧实例的只读位（dbClientOp 注入，不可由渲染层伪造）
 * @param {Map<string, {arity: number, flags: string[]}>} [opts.flagsByName] 服务端 COMMAND 结果
 * @returns {{allow: true, source: 'server'|'fallback'} | {allow: false, reason: string}}
 */
function evaluate ({ command, readOnly = false, flagsByName } = {}) {
  const byName = refuseByName({ command })
  if (!byName.allow) {
    return byName
  }
  const name = String(command || '').toLowerCase()
  const entry = flagsByName && flagsByName.get ? flagsByName.get(name) : undefined
  if (entry) {
    if (entry.flags.includes('blocking')) {
      return { allow: false, reason: 'blocking' }
    }
    if (readOnly && isWriteFlags(entry.flags)) {
      return { allow: false, reason: 'readonly-refuse' }
    }
    return { allow: true, source: 'server' }
  }
  // 属性未知（实例禁用 COMMAND，或这条命令比名单还新）：名单兜一层，名单外宁可给解释
  if (readOnly) {
    if (FALLBACK_WRITE.has(name)) {
      return { allow: false, reason: 'readonly-refuse' }
    }
    if (!FALLBACK_READ.has(name)) {
      return { allow: false, reason: 'unknown-command' }
    }
  }
  return { allow: true, source: 'fallback' }
}

/**
 * 这条命令会不会改动数据 —— 只给 UI 打"写"徽标用，不参与放行判定。
 *
 * 返回 `null` 表示"不知道"（COMMAND 拿不到且名单里也没有它）：
 * 不知道就什么都不标。猜"大概不写"会让用户以为刚执行的是一条读命令，
 * 而这条命令其实改了共享实例的数据。
 */
function isWriteCommand ({ command, flagsByName } = {}) {
  const name = String(command || '').toLowerCase()
  if (!name) {
    return null
  }
  const entry = flagsByName && flagsByName.get ? flagsByName.get(name) : undefined
  if (entry) {
    return isWriteFlags(entry.flags)
  }
  if (FALLBACK_WRITE.has(name)) {
    return true
  }
  return FALLBACK_READ.has(name) ? false : null
}

/**
 * 这条命令在**给定的只读位**下会不会被拦下来 —— `listRedisCommands` 用它给补全列表打提示。
 *
 * 与判定共用同一个 `evaluate`，所以"列表里标了可用"与"真按回车时被拦下"不可能各说一套。
 * readOnly 由调用方（主进程）传本实例的权威位，`ok` 就意味着这条实例现在能跑。
 */
function readOnlyHint ({ command, readOnly = false, flagsByName } = {}) {
  const r = evaluate({ command, readOnly, flagsByName })
  return r.allow ? 'ok' : r.reason
}

/** 补全候选的回落来源：COMMAND 被禁用时也给得出名字表（flags 留空，判定走名单） */
function fallbackCommandList () {
  const names = new Set([
    ...Array.from(FALLBACK_READ),
    ...Array.from(FALLBACK_WRITE),
    ...Array.from(BLOCKED.keys())
  ])
  return Array.from(names).sort().map(name => ({ name, arity: 0, flags: [] }))
}

module.exports = {
  BLOCKED_REASONS: Object.fromEntries(BLOCKED),
  BLOCKING_NAMES: Array.from(BLOCKING_NAMES),
  FALLBACK_READ: Array.from(FALLBACK_READ),
  FALLBACK_WRITE: Array.from(FALLBACK_WRITE),
  WRITE_FLAGS: WRITE_FLAGS.slice(),
  tokenize,
  parseCommandReply,
  refuseByName,
  evaluate,
  isWriteCommand,
  readOnlyHint,
  fallbackCommandList
}
