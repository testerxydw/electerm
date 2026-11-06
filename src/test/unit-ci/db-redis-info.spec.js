// H7a-4 Redis 服务器信息：后端 getRedisInfo + 渲染侧 INFO 解析
//
// 后端这一层薄到几乎没逻辑，但有三条一旦写错就静默坏掉的点，钉住：
//   · 只发一次全量 INFO（带 section 参数就要发两发；概览 + keyspace 同一次往返拿齐）
//   · INFO 被服务端禁用时报错必须原样上抛 —— 吞成空串，弹层就成了一张"全 0"的假概览
//     （0 在 INFO 里是合法值，用户分不清"真的是 0"还是"没拿到"）
//   · 不 select db：INFO 是实例级信息，跟着当前库走会莫名多一次往返与状态副作用
//
// 解析那半截钉的是"一个字符串里塞了十几个小节"的边界：值里带冒号、CRLF、空值、
// 缺小节、`*_human` 不是数字；还有两条"看着像数据其实是猜"的口径 ——
// 命中率分母为 0 或只拿到一半时给 null（0.00% 会被当成结论去查），
// keyspace 一行都没有时合计是 null（不是"这个实例 0 个键"）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
// N1：适配器新增依赖 './db-tls'（只依赖 fs/crypto），沙箱给真模块，顺带钉住委托关系
const DB_TLS = require(path.join(ROOT, 'src/app/lib/db-client/db-tls.js'))
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// 与 db-redis-keys-jump.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { info: [], select: [], scan: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async info (...a) {
      calls.info.push(a)
      if (opts.infoThrows) throw new Error(opts.infoThrows)
      return opts.info === undefined ? undefined : opts.info
    },
    async scan () {
      return ['0', []]
    },
    pipeline () {
      return { type () { return this }, ttl () { return this }, async exec () { return [] } }
    }
  }
  const Redis = function () {
    return inst
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (spec === './db-tls') return DB_TLS
      assert.equal(spec, 'ioredis', 'redis.js 多了新依赖，这个假沙箱得跟着补')
      return Redis
    },
    console,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(REDIS_JS, 'utf8'), sandbox, { filename: 'redis.js' })
  return { mod: mod.exports, calls }
}

const CONN = { dbHost: 'h', dbPort: 6379 }

const SAMPLE = [
  '# Server',
  'redis_version:7.2.6',
  'os:Linux 6.18.48 x86_64',
  '',
  '# Keyspace',
  'db0:keys=6,expires=0,avg_ttl=0',
  'db1:keys=20,expires=5,avg_ttl=47537',
  ''
].join('\r\n')

describe('H7a-4 getRedisInfo（后端）', () => {
  test('原样回传 INFO 文本：后端不解析、不裁剪', async () => {
    const { mod, calls } = loadRedis({ info: SAMPLE })
    const text = await mod.getRedisInfo(CONN)
    assert.equal(text, SAMPLE)
    assert.equal(calls.info.length, 1, '只发一次 INFO')
    assert.deepEqual(calls.info[0], [], '全量 INFO：不带 section 参数（概览 + keyspace 一发拿齐）')
  })

  test('不 select db：INFO 是实例级信息', async () => {
    const { mod, calls } = loadRedis({ info: SAMPLE })
    await mod.getRedisInfo(CONN)
    assert.deepEqual(calls.select, [])
  })

  test('服务端禁用 INFO：报错原样上抛，不吞成空串', async () => {
    const { mod } = loadRedis({ infoThrows: 'ERR unknown command INFO' })
    await assert.rejects(() => mod.getRedisInfo(CONN), /unknown command INFO/)
  })

  test('INFO 回空（undefined）时归一成空串，不把 undefined 递给渲染侧', async () => {
    const { mod } = loadRedis({ info: undefined })
    assert.equal(await mod.getRedisInfo(CONN), '')
  })

  test('op 已挂进 redis 方法表（漏一边就是前端 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /getRedisInfo: 'getRedisInfo'/)
  })
})

// ── 渲染侧解析（src/client/common/db-redis-info.js）──────────────────────
const load = () => import('../../client/common/db-redis-info.js')

// 真 Redis 7.2.6 的字段形状（节选）：值里带冒号、有空值、有 CRLF，全在这里喂进去
const REAL = [
  '# Server',
  'redis_version:7.2.6',
  'redis_mode:standalone',
  'os:Linux 6.18.48 x86_64',
  'executable_path:/usr/bin/redis-server',
  'config_file:',
  'uptime_in_seconds:1234567',
  '',
  '# Clients',
  'connected_clients:12',
  'blocked_clients:0',
  'maxclients:10000',
  '',
  '# Memory',
  'used_memory:1048576',
  'used_memory_human:1.05M',
  'used_memory_rss:2097152',
  'mem_fragmentation_ratio:2.00',
  'maxmemory:0',
  'maxmemory_policy:noeviction',
  '',
  '# Stats',
  'instantaneous_ops_per_sec:8',
  'total_commands_processed:100',
  'keyspace_hits:97',
  'keyspace_misses:3',
  'evicted_keys:0',
  'expired_keys:41',
  'rejected_connections:0',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:2',
  '',
  '# Keyspace',
  'db10:keys=3,expires=0,avg_ttl=0',
  'db2:keys=7,expires=1',
  'db0:keys=6,expires=0,avg_ttl=47537',
  ''
].join('\r\n')

describe('H7a-4 parseRedisInfo：原文 → 小节', () => {
  test('小节名归一化、键值按第一个冒号切（值里的冒号保留）', async () => {
    const { parseRedisInfo, infoString } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoString(p, 'server', 'redis_version'), '7.2.6')
    assert.equal(infoString(p, 'server', 'executable_path'), '/usr/bin/redis-server',
      '值里带冒号：只能在第一个冒号处切')
    assert.equal(infoString(p, 'replication', 'role'), 'master')
    assert.ok(p.sections.keyspace, '# Keyspace → keyspace')
    assert.ok(p.sections.stats, '# Stats → stats')
  })

  test('CRLF、空行、无冒号行、冒号在行首都不会把解析带歪', async () => {
    const { parseRedisInfo } = await load()
    const p = parseRedisInfo('# Server\r\n\r\nredis_version:1.2.3\nnot-a-pair\n:leading\nbroken')
    assert.deepEqual(p.sections, { server: { redis_version: '1.2.3' } })
  })

  test('小节头之前的散行不猜归属；空文本/undefined 出空小节不抛', async () => {
    const { parseRedisInfo } = await load()
    assert.deepEqual(parseRedisInfo('stray:1\n# Server\na:2').sections, { server: { a: '2' } })
    assert.deepEqual(parseRedisInfo('').sections, {})
    assert.deepEqual(parseRedisInfo(undefined).sections, {})
    assert.deepEqual(parseRedisInfo(null).sections, {})
  })

  test('同名键后写覆盖（INFO 里同小节重复行以最后一行为准）', async () => {
    const { parseRedisInfo, infoString } = await load()
    const p = parseRedisInfo('# Server\nredis_version:1\nredis_version:2')
    assert.equal(infoString(p, 'server', 'redis_version'), '2')
  })
})

describe('H7a-4 infoString / infoNumber：缺就是缺', () => {
  test('0 是合法值必须原样返回（判"有没有"只能用 null）', async () => {
    const { parseRedisInfo, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoNumber(p, 'clients', 'blocked_clients'), 0)
    assert.equal(infoNumber(p, 'memory', 'maxmemory'), 0,
      'maxmemory:0 = 没配上限，这个 0 是信息本身，不能当"没拿到"')
    assert.equal(infoNumber(p, 'stats', 'evicted_keys'), 0)
  })

  test('数字转换只认真数字：1.05M 这类 *_human 一律 null', async () => {
    const { parseRedisInfo, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoNumber(p, 'memory', 'used_memory'), 1048576)
    assert.equal(infoNumber(p, 'memory', 'used_memory_human'), null)
    assert.equal(infoNumber(p, 'memory', 'mem_fragmentation_ratio'), 2)
  })

  test('空值（config_file:）与缺小节、缺键都归成 null', async () => {
    const { parseRedisInfo, infoString, infoNumber } = await load()
    const p = parseRedisInfo(REAL)
    assert.equal(infoString(p, 'server', 'config_file'), null, '"没配"和"空"在界面上是同一件事')
    assert.equal(infoString(p, 'cluster', 'cluster_enabled'), null)
    assert.equal(infoNumber(p, 'nowhere', 'x'), null)
    assert.equal(infoString(parseRedisInfo(''), 'server', 'redis_version'), null)
  })
})

describe('H7a-4 keyspaceRows：db 统计', () => {
  test('按 db 序号排（db2 在 db10 前面），字段缺就 null', async () => {
    const { parseRedisInfo, keyspaceRows } = await load()
    const rows = keyspaceRows(parseRedisInfo(REAL))
    assert.deepEqual(rows.map(r => r.db), ['db0', 'db2', 'db10'])
    assert.deepEqual(rows[0], { db: 'db0', index: 0, keys: 6, expires: 0, avgTtlMs: 47537 })
    // db2 那行没有 avg_ttl：null 而不是 0（0 是"平均没有过期"，两回事）
    assert.equal(rows[1].avgTtlMs, null)
    assert.equal(rows[1].expires, 1)
  })

  test('非 dbN 行忽略；没有 keyspace 小节出空数组', async () => {
    const { parseRedisInfo, keyspaceRows } = await load()
    assert.deepEqual(keyspaceRows(parseRedisInfo('# Keyspace\ndbx:keys=1\nweird')), [])
    assert.deepEqual(keyspaceRows(parseRedisInfo('# Server\na:1')), [])
  })
})

describe('H7a-4 redisOverview：概览事实与命中率', () => {
  test('一次取全概览要的字段（含跨小节与派生合计）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo(REAL))
    assert.equal(o.version, '7.2.6')
    assert.equal(o.mode, 'standalone')
    assert.equal(o.uptimeSeconds, 1234567)
    assert.equal(o.connectedClients, 12)
    assert.equal(o.maxClients, 10000)
    assert.equal(o.role, 'master')
    assert.equal(o.connectedReplicas, 2)
    assert.equal(o.usedMemory, 1048576)
    assert.equal(o.maxMemory, 0)
    assert.equal(o.maxMemoryPolicy, 'noeviction')
    assert.equal(o.fragmentation, 2)
    assert.equal(o.instantaneousOpsPerSec, 8)
    assert.equal(o.expiredKeys, 41)
    assert.equal(o.evictedKeys, 0)
    assert.equal(o.totalKeys, 16, '6+7+3')
    assert.equal(o.totalExpires, 1)
  })

  test('命中率：97/(97+3) = 0.97', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    assert.equal(redisOverview(parseRedisInfo(REAL)).hitRate, 0.97)
  })

  test('一次查询都没有 → null，不是 0.00%（0% 命中率会被当成结论去查）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo('# Stats\nkeyspace_hits:0\nkeyspace_misses:0'))
    assert.equal(o.hitRate, null)
  })

  test('只拿到 hits 或只拿到 misses → null（不按 0 补另一半）', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    assert.equal(redisOverview(parseRedisInfo('# Stats\nkeyspace_hits:97')).hitRate, null)
    assert.equal(redisOverview(parseRedisInfo('# Stats\nkeyspace_misses:3')).hitRate, null)
    assert.equal(redisOverview(parseRedisInfo('# Stats')).hitRate, null)
  })

  test('全空 INFO 出"一个字段都没有"的对象，不抛', async () => {
    const { parseRedisInfo, redisOverview } = await load()
    const o = redisOverview(parseRedisInfo(''))
    assert.equal(o.version, null)
    assert.equal(o.totalKeys, null, '没有任何 db 行时合计是"不知道"，不是 0 个键')
    assert.equal(o.usedMemory, null)
  })
})

describe('H7a-4 formatPercent', () => {
  test('两位小数、null 出 null（占位由界面给）', async () => {
    const { formatPercent } = await load()
    assert.equal(formatPercent(0.9708), '97.08%')
    assert.equal(formatPercent(1), '100.00%')
    assert.equal(formatPercent(0), '0.00%')
    assert.equal(formatPercent(0.5, 0), '50%')
    assert.equal(formatPercent(null), null)
    assert.equal(formatPercent(Number.NaN), null)
  })
})

// ── 弹层与接线（src/client/components/database/db-redis-info.jsx + db-session.jsx）──
//
// 这一节钉的是"看得到但没人测就会悄悄坏"的界面口径：
//   · null 出「—」不出 0 —— 与解析层同一套约定，界面破功就等于把"没拿到"说成"是 0"
//   · maxmemory 0 是"不限制"，不是"上限 0 字节"（唯一一处 0 需要转译成话）
//   · avg_ttl 单位是毫秒，忘了 /1000 会把"3 天"显示成"3 秒"
//   · 不轮询：INFO 是实例级全量统计，常驻定时器会给每台连着的 Redis 加负载
//   · 组件不碰 IPC：取数留在 db-session，弹层才是可单测的纯呈现
const MODAL = path.join(ROOT, 'src/client/components/database/db-redis-info.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a 簇 C：INFO 取数 / 开关弹层已迁到 use-db-redis-keys.js（已接线）。
const USE_DB_REDIS_KEYS = path.join(ROOT, 'src/client/components/database/use-db-redis-keys.js')
const sessionSrc = () => fs.readFileSync(SESSION, 'utf8') + '\n' + fs.readFileSync(USE_DB_REDIS_KEYS, 'utf8')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// 取一个函数/代码块：从 anchor 起，到第一个 `depth-1 缩进的 }` 为止
function blockOf (src, anchor, endRe) {
  const at = src.indexOf(anchor)
  assert.notEqual(at, -1, `anchor not found: ${anchor}`)
  const m = endRe.exec(src.slice(at))
  assert.ok(m, `block end not found for: ${anchor}`)
  return src.slice(at, at + m.index + m[0].length)
}

describe('H7a-4 弹层呈现（db-redis-info.jsx）', () => {
  test('组件不碰 IPC：取数归 db-session，弹层只做呈现', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.equal(
      /runGlobalAsync|dbClientOp|window\.pre/.test(src),
      false,
      '弹层里不该出现 IPC 调用（有它就没法脱离 store 单测）'
    )
  })

  test('缺值出「—」：show() 只把 null/undefined/空串当没有，0 照出', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    const show = blockOf(src, 'function show (v)', /\n\}/)
    assert.match(show, /v === null \|\| v === undefined \|\| v === ''/)
    assert.match(show, /return NA/)
    // 不是 if (!v) —— 那样 0 也会变「—」，"命中率 0"“0 个键”全被吞掉
    assert.equal(/if \(!v\)/.test(show), false, '真假判定会把 0 当缺失')
  })

  test('maxmemory 0 说成"未设上限"（0 在 INFO 里是"不限"，不是"上限 0 字节"）', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /ov\.maxMemory === 0 \? e\('dbRedisInfoNoLimit'\) : formatBytes\(ov\.maxMemory\)/)
  })

  test('avg_ttl 毫秒 → 秒再交给 formatDuration', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /formatDuration\(v \/ 1000\)/)
    assert.equal(/formatDuration\(v\)/.test(src), false, '直接喂毫秒会把 3 天显示成 3 秒')
  })

  test('字节走 formatBytes，不读 Redis 自己的 *_human', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.equal(/_human/.test(src), false, '*_human 用 K/M/G，与监控条 KiB/MiB 对不上')
    assert.match(src, /import \{ formatBytes, formatDuration \} from '\.\.\/remote-monitor\/monitor-model'/)
  })

  test('三页签：概览 / 键空间 / 原始 INFO', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /key: 'overview'/)
    assert.match(src, /key: 'keyspace'/)
    assert.match(src, /key: 'raw'/)
    // 原文页是"概览没列出的字段"唯一的去处，删掉它就没有兜底了
    assert.match(src, /<pre className='db-redis-info-raw'>/)
  })

  test('首帧才转圈：带旧数据刷新不闪成空板', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /const firstLoading = loading && !hasText/)
    // 首帧之外一律出 Tabs（H7b-2 起门禁从"有没有 INFO"改成"是不是首帧"：
    // 慢日志是另一条命令，INFO 失败时它仍然该看得到）
    assert.match(src, /firstLoading\n {12}\? null\n {12}: \(\n {14}<Tabs/)
    // INFO 那三页仍然只认原文：没有原文就不摆三张空页
    assert.match(src, /\.\.\.\(hasText \? infoTabItems\(ov, rows, text\) : \[\]\)/)
  })

  test('footer 三个动作齐全，且没有可复制内容时不给复制', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /key='copy'[\s\S]*disabled=\{slowlogOn \? !slRows\.length : !hasText\}/)
    assert.match(src, /key='refresh' size='small' loading=\{refreshLoading\} onClick=\{onRefreshClick\}/)
    assert.match(src, /key='close'/)
  })

  test('失败态不叠加空态提示（"这次没读到"≠"这个实例是空的"）', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /!loading && !hasText && !error && !slowlogOn\n {12}\? <div className='db-redis-info-empty'/)
  })
})

describe('H7a-4 顶栏接线（db-session.jsx）', () => {
  test('入口只在 Redis tab 出现', () => {
    const src = sessionSrc()
    const at = src.indexOf('icon={<InfoCircleOutlined />}')
    assert.notEqual(at, -1, 'Redis 没有信息入口')
    const btn = src.slice(at, at + 260)
    assert.match(btn, /onClick=\{openRedisInfo\}/)
    assert.match(btn, /\{e\('dbRedisInfo'\)\}/)
    // 按钮在顶栏，与当前在哪个 tab（键列表/键树）无关
    assert.match(src.slice(at - 260, at), /isRedis/, '非 Redis 连接不该有这个按钮')
  })

  test('op 名与参数：getRedisInfo 走 dbClientOp，不带任何参数', () => {
    const src = sessionSrc()
    assert.match(
      src,
      /runGlobalAsync\('dbClientOp', tabId, 'getRedisInfo', \{\}\)/,
      'op 名写错就是主进程 "unsupported op"'
    )
  })

  test('打开时拉一次，不做轮询', () => {
    const src = sessionSrc()
    const open = blockOf(src, 'const openRedisInfo = () => {', /\n {2}\}/)
    assert.match(open, /setRedisInfo\(s => \(\{ \.\.\.s, open: true \}\)\)/)
    assert.match(open, /loadRedisInfo\(\)/)
    // 轮询会给每台连着的 Redis 挂个定时任务；刷新只能靠按钮
    const timer = src.match(/setInterval\([\s\S]{0,120}loadRedisInfo/)
    assert.equal(timer, null, 'INFO 不许定时轮询')
  })

  test('在途响应有令牌守卫：连点刷新时旧的慢响应不覆盖新的', () => {
    const src = sessionSrc()
    const load = blockOf(src, 'const loadRedisInfo = () => {', /\n {2}\}/)
    assert.match(load, /redisInfoTokenRef\.current\+\+/)
    assert.match(load, /const token = redisInfoTokenRef\.current/)
    // then 与 catch 各一次判定：少一处就会在"失败后又被旧响应填上数据"
    assert.equal((load.match(/token !== redisInfoTokenRef\.current/g) || []).length, 2, 'then/catch 都要判令牌')
  })

  test('响应回来只写数据，不改 open：加载中关弹层不该被重新打开', () => {
    const src = sessionSrc()
    const load = blockOf(src, 'const loadRedisInfo = () => {', /\n {2}\}/)
    assert.equal(/setRedisInfo\(\{ open: true/.test(load), false, '响应里不该硬置 open: true')
    assert.match(load, /setRedisInfo\(s => \(\{[\s\S]*?\.\.\.s,[\s\S]*?loading: false/)
  })

  test('关闭即清原文：下次打开不能先闪上一次 INFO', () => {
    const src = sessionSrc()
    const close = blockOf(src, 'const closeRedisInfo = () => {', /\n {2}\}/)
    assert.match(close, /redisInfoTokenRef\.current\+\+/)
    assert.match(close, /open: false, loading: false, text: '', error: ''/)
  })

  test('取数失败留在弹层提示，不置顶"连接断开"横幅', () => {
    const src = sessionSrc()
    const load = blockOf(src, 'const loadRedisInfo = () => {', /\n {2}\}/)
    assert.equal(/onOpError\(err\)/.test(load), false, '走 onOpError 会把"这一次没看到信息"说成"连接断了"')
    assert.match(load, /error: cleanDbError\(/)
  })

  test('弹层挂载且 props 与状态同源', () => {
    const src = sessionSrc()
    const at = src.indexOf('<DbRedisInfoModal')
    assert.notEqual(at, -1, '弹层未挂载')
    const modal = src.slice(at, at + 420)
    assert.match(modal, /open=\{redisInfo\.open\}/)
    assert.match(modal, /loading=\{redisInfo\.loading\}/)
    assert.match(modal, /text=\{redisInfo\.text\}/)
    assert.match(modal, /error=\{redisInfo\.error\}/)
    assert.match(modal, /onClose=\{closeRedisInfo\}/)
    assert.match(modal, /onRefresh=\{loadRedisInfo\}/)
    const guard = src.slice(at - 120, at)
    assert.match(guard, /isRedis/, '非 Redis 不渲染弹层')
  })
})

describe('H7a-4 文案与样式', () => {
  test('弹层用到的文案键全部有词条（自造键必须双语）', () => {
    const modal = fs.readFileSync(MODAL, 'utf8')
    const extra = require(LOCALES)
    // 上游语言包 + 本地补丁：复用现成 key（close/copy/refresh/os/uptime/memory）靠它们兜底
    const upstream = require('@electerm/electerm-locales').en_us.lang
    // 只认真正的取词调用：`useState('overview')` 结尾也是 `e('...')`，
    // 不设边界就会把状态初值当文案键，报出一个根本不存在的缺词条
    const re = /(?:^|[^A-Za-z0-9_$.])e\('([A-Za-z]+)'\)/g
    const keys = [...new Set((modal.match(re) || []).map(s => {
      const m = /e\('([A-Za-z]+)'\)$/.exec(s)
      return m ? m[1] : s
    }))]
    assert.ok(keys.length >= 25, `弹层文案键应有 25+ 个，实际 ${keys.length} 个`)
    let own = 0
    for (const k of keys) {
      if (!/^dbRedis(Info|Slowlog)/.test(k)) {
        const known = k in upstream || extra.en[k] !== undefined
        assert.ok(known, `${k} 既不是自造键也没有现成词条（界面会直接露出 key 原文）`)
        continue
      }
      own++
      assert.ok(extra.en[k] !== undefined, `${k} 缺英文词条`)
      assert.ok(extra.zh_cn[k] !== undefined, `${k} 缺中文词条`)
    }
    assert.ok(own >= 25, `自造键应覆盖弹层全部标签，实际 ${own} 个`)
  })

  test('样式用主题 token，不写死颜色', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const at = styl.indexOf('.db-redis-info\n')
    assert.notEqual(at, -1, '弹层样式块缺失')
    const b = styl.slice(at, at + 1800)
    assert.match(b, /var\(--text-muted\)/)
    assert.match(b, /var\(--border\)/)
    // 数据面字体必须走 --db-code-font 回落链（css-tokens.spec.js 的仓库级契约）：
    // 只写 var(--font-mono) 会绕过"终端 tab 字体"，而回落链里也含 --font-mono，
    // 所以这里钉的是整条链，不是"有没有 mono"
    assert.match(b, /font-family var\(--db-code-font, var\(--font-mono\)\)/)
    assert.equal(/font-family var\(--font-mono\)/.test(b), false,
      '数据面不得用裸 --font-mono')
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(b), false, '不许硬编码颜色')
    // 值右对齐 + 等宽 + tabular-nums：概览要能竖着扫
    assert.match(b, /text-align right/)
    assert.match(b, /font-variant-numeric tabular-nums/)
  })
})
