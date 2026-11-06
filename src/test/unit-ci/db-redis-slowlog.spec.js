// H7b-1/H7b-2 Redis 慢日志：后端 getRedisSlowlog + 纯函数解析/格式化 + 弹层与顶栏接线
//
// 这层薄，但错一处就是"看着正常其实拿错"：
//   · count=0 在 RESP 语义里是"取全部"，不是"取 0 条" —— 归一必须回落到默认 128，
//     否则一次误传就把整段慢日志拷回弹层
//   · SLOWLOG 被禁用/被副本拒绝时报错必须原样上抛 —— 吞成空数组等于把
//     "拿不到慢日志"伪装成"这个实例没有慢查询"，后者是个会被当成结论的假信号
//   · 与 INFO 同为实例级：不 select db（跟着当前库走会多一次往返和状态副作用）
//   · op 必须同时挂进 index.js 的 redis 方法表，漏一边前端就是 "unsupported op"
//
// H7b-2 在渲染侧多加的两条约定（所以后半截一起钉在这里）：
//   · 慢日志只在第一次切进页签时拉：SLOWLOG GET 把整段日志拷回来，只看概览的人不该付这笔
//   · entries 用 null 表示"从没拉过/这次没拉到"、[] 表示"拉到了且是空的"：把两者混成一个，
//     "读取失败"就会显示成"这个实例没有慢查询"，而切回页签也不会再试
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
const MODAL = path.join(ROOT, 'src/client/components/database/db-redis-info.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// 与 db-redis-info.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { slowlog: [], select: [], info: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async info () {
      return ''
    },
    async slowlog (...a) {
      calls.slowlog.push(a)
      if (opts.slowlogThrows) throw new Error(opts.slowlogThrows)
      return opts.slowlog === undefined ? [] : opts.slowlog
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

// 真条目形状（Redis 7.2：id / 秒时间戳 / 微秒耗时 / 参数数组 / 客户端地址 / 客户端名）
const SAMPLE = [
  [12, 1730192000, 42130, ['SET', 'k', 'v'], '10.0.0.5:53212', 'cli-a'],
  [13, 1730192060, 120, ['GET', 'k'], '10.0.0.5:53212', '']
]

describe('H7b-1 getRedisSlowlog（后端）', () => {
  test('只发一发 SLOWLOG GET，不传 count 时用默认 128', async () => {
    const { mod, calls } = loadRedis({ slowlog: SAMPLE })
    const res = await mod.getRedisSlowlog(CONN, {})
    assert.deepEqual(res, SAMPLE, '原始条目数组原样回传，归一在渲染侧')
    assert.deepEqual(calls.slowlog, [['get', 128]])
  })

  test('count=0 不是"取 0 条"也不是"取全部"：回落到默认 128', async () => {
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN, { count: 0 })
    assert.deepEqual(calls.slowlog, [['get', 128]])
  })

  test('负数 / NaN / 空串 / null 都回落到默认，不抛也不发 0', async () => {
    for (const bad of [-5, 'abc', null, undefined, {}, NaN]) {
      const { mod, calls } = loadRedis()
      await mod.getRedisSlowlog(CONN, { count: bad })
      assert.deepEqual(calls.slowlog, [['get', 128]], `count=${String(bad)} 应回落默认`)
    }
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN)
    assert.deepEqual(calls.slowlog, [['get', 128]], '整个第二参数缺省')
  })

  test('count 夹到上限 512：小数向下取整', async () => {
    const { mod, calls } = loadRedis()
    await mod.getRedisSlowlog(CONN, { count: 99999 })
    await mod.getRedisSlowlog(CONN, { count: '50.7' })
    assert.deepEqual(calls.slowlog, [['get', 512], ['get', 50]])
  })

  test('不 select db：慢日志是实例级信息', async () => {
    const { mod, calls } = loadRedis({ slowlog: SAMPLE })
    await mod.getRedisSlowlog(CONN, { count: 20 })
    assert.deepEqual(calls.select, [])
  })

  test('服务端禁用 SLOWLOG：报错原样上抛，不吞成空数组', async () => {
    const { mod } = loadRedis({ slowlogThrows: "ERR unknown command 'SLOWLOG'" })
    await assert.rejects(() => mod.getRedisSlowlog(CONN, {}), /unknown command 'SLOWLOG'/)
  })

  test('服务端回非数组（异常形状）时归一成空数组，不把 undefined 递给渲染侧', async () => {
    const { mod } = loadRedis({ slowlog: null })
    const res = await mod.getRedisSlowlog(CONN, {})
    // 不用 deepEqual：兜底的那个 [] 是在 vm 沙箱里 new 的，跨 realm 原型不同、结构相同
    assert.ok(Array.isArray(res) && res.length === 0, '应归一成空数组')
  })

  test('op 已挂进 redis 方法表（漏一边就是前端 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /getRedisSlowlog: 'getRedisSlowlog'/)
  })
})

// ── 渲染侧归一（src/client/common/db-redis-slowlog.js）────────────────────
const load = () => import('../../client/common/db-redis-slowlog.js')

describe('H7b-2 parseRedisSlowlog（条目形状容错）', () => {
  test('Redis 7.2 六元素形状：id/秒时间戳/微秒耗时/参数/地址/客户端名各归位', async () => {
    const { parseRedisSlowlog } = await load()
    const [row] = parseRedisSlowlog([
      [12, 1730192000, 42130, ['SET', 'k', 'v'], '10.0.0.5:53212', 'cli-a']
    ])
    assert.equal(row.id, 12)
    assert.equal(row.atMs, 1730192000 * 1000)
    assert.equal(row.durationUs, 42130)
    assert.equal(row.command, 'SET')
    assert.deepEqual(row.args, ['k', 'v'])
    assert.equal(row.clientAddr, '10.0.0.5:53212')
    assert.equal(row.clientName, 'cli-a')
  })

  test('服务端保持原序（最新在前是 SLOWLOG 的语义，解析不重排）', async () => {
    const { parseRedisSlowlog } = await load()
    const rows = parseRedisSlowlog([
      [3, 1730192000, 30, ['GET', 'a'], '1.2.3.4:1', ''],
      [1, 1730191000, 10, ['GET', 'b'], '1.2.3.4:1', '']
    ])
    assert.deepEqual(rows.map(r => r.id), [3, 1])
  })

  test('客户端名是空 bulk：留 null 而不是空串（界面出「—」）', async () => {
    const { parseRedisSlowlog } = await load()
    const [row] = parseRedisSlowlog([[1, 1730192000, 10, ['GET', 'k'], '1.2.3.4:1', '']])
    assert.equal(row.clientName, null)
  })

  test('IPv6 / 映射地址形状仍判为客户端地址', async () => {
    const { parseRedisSlowlog } = await load()
    for (const addr of ['[::1]:6379', '[::ffff:192.168.1.7]:53212', '192.168.1.7:53212']) {
      const [row] = parseRedisSlowlog([[1, 1730192000, 10, ['GET', 'k'], addr, 'n']])
      assert.equal(row.clientAddr, addr, `${addr} 应判为地址`)
      assert.equal(row.clientName, 'n')
    }
  })

  test('尾部多出的微秒时间戳（新版本形状）覆盖秒那份，且不冒充客户端名', async () => {
    const { parseRedisSlowlog } = await load()
    const [row] = parseRedisSlowlog([
      [9, 1730192000, 20, ['GET', 'k'], '1.2.3.4:1', 'cli', 1730192000123456]
    ])
    assert.equal(row.atMs, 1730192000123)
    assert.equal(row.clientName, 'cli')
    assert.equal(row.clientAddr, '1.2.3.4:1')
  })

  test('微秒时间戳以字符串回来时同样识别', async () => {
    const { parseRedisSlowlog } = await load()
    const [row] = parseRedisSlowlog([
      [9, 1730192000, 20, ['GET', 'k'], '1.2.3.4:1', 1730192000123456]
    ])
    assert.equal(row.atMs, 1730192000123)
    assert.equal(row.clientName, null)
  })

  test('条目不是数组就丢掉，数组缺参数段仍出行（字段留 null，不猜 0）', async () => {
    const { parseRedisSlowlog } = await load()
    const rows = parseRedisSlowlog([null, 'x', [1, 1730192000, 30]])
    assert.equal(rows.length, 1, '只丢真正认不出的一条')
    assert.equal(rows[0].command, null)
    assert.equal(rows[0].argText, null)
    assert.equal(rows[0].clientAddr, null)
  })

  test('整个入参不是数组（undefined/null/对象）时回空表，不抛', async () => {
    const { parseRedisSlowlog } = await load()
    for (const bad of [undefined, null, {}, 'x']) {
      assert.deepEqual(parseRedisSlowlog(bad), [])
    }
  })

  test('耗时/时间读不出时是「—」而不是 0', async () => {
    const { parseRedisSlowlog, formatSlowDuration, formatSlowTime } = await load()
    const [row] = parseRedisSlowlog([[1, 'abc', null, ['GET']]])
    assert.equal(formatSlowDuration(row.durationUs), '—')
    assert.equal(formatSlowTime(row.atMs), '—')
  })
})

describe('H7b-2 参数预览与格式化', () => {
  test('参数超过 8 个折叠成 …(+N)，不静默丢尾', async () => {
    const { previewArgs } = await load()
    const args = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const text = previewArgs(args)
    assert.ok(text.endsWith('…(+2)'), text)
    assert.ok(text.startsWith('a b c'), text)
  })

  test('总长超 80 字符截断加省略号（慢日志里一个参数可能就是几 MB 的 value）', async () => {
    const { previewArgs } = await load()
    const text = previewArgs(['x'.repeat(300)])
    assert.ok(text.length <= 81, `实际 ${text.length}`)
    assert.ok(text.endsWith('…'), text)
  })

  test('无参数回 null（不是空串）', async () => {
    const { previewArgs } = await load()
    assert.equal(previewArgs([]), null)
    assert.equal(previewArgs(undefined), null)
  })

  test('耗时按 μs / ms / s 三档出，边界不跨档', async () => {
    const { formatSlowDuration } = await load()
    assert.equal(formatSlowDuration(0), '0 μs')
    assert.equal(formatSlowDuration(999), '999 μs')
    assert.equal(formatSlowDuration(1000), '1.00 ms')
    assert.equal(formatSlowDuration(42130), '42.13 ms')
    assert.equal(formatSlowDuration(999999), '1000.00 ms')
    assert.equal(formatSlowDuration(1500000), '1.50 s')
  })

  test('时间是本地时区、零填充的 YYYY-MM-DD HH:mm:ss', async () => {
    const { formatSlowTime } = await load()
    // 用本地分量构造，避免把测试绑死在某个时区上
    const d = new Date(2026, 9, 29, 8, 5, 3)
    assert.equal(formatSlowTime(d.getTime()), '2026-10-29 08:05:03')
    assert.equal(formatSlowTime('abc'), '—')
  })
})

describe('H7b-2 slowlogStats（空表不冒充"最慢 0"）', () => {
  test('有条目：count 与最慢耗时', async () => {
    const { slowlogStats } = await load()
    assert.deepEqual(
      slowlogStats([{ durationUs: 100 }, { durationUs: 9000 }, { durationUs: 20 }]),
      { count: 3, maxUs: 9000 }
    )
  })

  test('耗时缺失的行不参与最大值，也不被算成 0', async () => {
    const { slowlogStats } = await load()
    assert.deepEqual(
      slowlogStats([{ durationUs: null }, { durationUs: 500 }]),
      { count: 2, maxUs: 500 }
    )
  })

  test('空表：count 0、maxUs null（"没有慢查询"不等于"最慢 0 μs"）', async () => {
    const { slowlogStats } = await load()
    assert.deepEqual(slowlogStats([]), { count: 0, maxUs: null })
    assert.deepEqual(slowlogStats(undefined), { count: 0, maxUs: null })
  })
})

describe('H7b-2 slowlogTsv（复制出去的该是原文，不是表格那份预览）', () => {
  test('表头 + 每行六列，Tab 分隔，顺序与表格一致', async () => {
    const { parseRedisSlowlog, slowlogTsv, formatSlowTime } = await load()
    const lines = slowlogTsv(parseRedisSlowlog(SAMPLE)).split('\n')
    assert.equal(lines[0], 'id\ttime\tduration_us\tcommand\targs\tclient')
    assert.equal(lines.length, 3)
    assert.deepEqual(lines[1].split('\t'), [
      '12', formatSlowTime(1730192000 * 1000), '42130', 'SET', 'k v', '10.0.0.5:53212 cli-a'
    ])
  })

  test('参数不截断：表格只给前 8 个 / 80 字符，复制给全量原文', async () => {
    const { parseRedisSlowlog, slowlogTsv } = await load()
    const big = Array.from({ length: 20 }, (_, i) => `p${i}${'x'.repeat(40)}`)
    const rows = parseRedisSlowlog([[1, 1730192000, 5000, ['MSET', ...big], '1.2.3.4:1', '']])
    assert.ok(rows[0].argText.length <= 90, '表格预览仍应被截住')
    const tsv = slowlogTsv(rows)
    assert.ok(tsv.includes(big[19]), '第 20 个参数没进 TSV：复制把尾巴丢了')
    assert.ok(!tsv.includes('…'), 'TSV 里出现省略号：复制用成了表格那份预览')
    assert.equal(tsv.split('\n')[1].split('\t')[4].split(' ').length, 20)
  })

  test('读不出的字段留空串而不是「—」（横杠粘进表格会被当成数据）', async () => {
    const { parseRedisSlowlog, slowlogTsv } = await load()
    const tsv = slowlogTsv(parseRedisSlowlog([[undefined, undefined, undefined]]))
    assert.equal(tsv.split('\n')[1], '\t\t\t\t\t')
    assert.ok(!tsv.includes('—'))
  })

  test('入参不是数组时只回表头，不抛', async () => {
    const { slowlogTsv } = await load()
    assert.equal(slowlogTsv(undefined), 'id\ttime\tduration_us\tcommand\targs\tclient')
    assert.equal(slowlogTsv([]), 'id\ttime\tduration_us\tcommand\targs\tclient')
  })

  test('客户端只有地址或只有名字时不留分隔符', async () => {
    const { parseRedisSlowlog, slowlogTsv } = await load()
    const onlyAddr = slowlogTsv(parseRedisSlowlog([[1, 1730192000, 1, ['GET', 'k'], '1.2.3.4:5', '']]))
    const onlyName = slowlogTsv(parseRedisSlowlog([[2, 1730192000, 1, ['GET', 'k'], '', 'app']]))
    assert.equal(onlyAddr.split('\n')[1].split('\t')[5], '1.2.3.4:5')
    assert.equal(onlyName.split('\n')[1].split('\t')[5], 'app')
  })
})

describe('H7b-2 弹层慢日志页签（db-redis-info.jsx）', () => {
  test('第一次切进页签才拉，且已经在途/已经有数据就不再发', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /const ensureSlowlog = \(\) => \{\n {4}if \(!Array\.isArray\(sl\.entries\) && !sl\.loading && onLoadSlowlog\) \{/)
    assert.match(src, /if \(k === 'slowlog'\) \{\n {6}ensureSlowlog\(\)/)
    // 不轮询：SLOWLOG GET 是把整段日志拷回来，定时去拉等于自己给自己加负载
    assert.doesNotMatch(src, /setInterval|setTimeout/)
    assert.equal((src.match(/onLoadSlowlog\(\)/g) || []).length, 1)
  })

  test('INFO 没回原文时拨到慢日志页：不能让弹顶着一个不存在的页签', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    // 三页不在 items 里时 tab='overview' 指不到任何东西，且首帧不触发（等 INFO 回来才判）
    assert.match(src, /if \(open && !loading && !hasText && tab === 'overview'\) \{\n {6}setTab\('slowlog'\)\n {6}ensureSlowlog\(\)/)
  })

  test('重开弹层回到概览：停在慢日志页签重开会先闪上一次的条目', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /useEffect\(\(\) => \{\n {4}if \(open\) \{\n {6}setTab\('overview'\)/)
  })

  test('慢日志页签常驻，INFO 那三页仍只认原文（两条命令的成败互不牵连）', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /\.\.\.\(hasText \? infoTabItems\(ov, rows, text\) : \[\]\)/)
    assert.match(src, /key: 'slowlog',\n {20}label: e\('dbRedisSlowlog'\)/)
  })

  test('INFO 报错条：三页还在时切走就收，三页没了就留在顶上（否则等于什么都不说）', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /error && !firstLoading && !\(slowlogOn && hasText\)/)
  })

  test('INFO 的空态提示不混进慢日志页签，慢日志有自己的报错条', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /!loading && !hasText && !error && !slowlogOn\n {12}\? <div className='db-redis-info-empty'/)
    assert.match(src, /sl\.error\n {28}\? \(\n {30}<Alert/)
    assert.match(src, /message=\{e\('dbRedisSlowlogFailed'\)\}/)
  })

  test('底部动作按当前页签分流：复制走 TSV、刷新走 SLOWLOG', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /if \(slowlogOn\) \{\n {6}copy\(slowlogTsv\(slRows\)\)/)
    assert.match(src, /if \(slowlogOn\) \{\n {6}if \(onRefreshSlowlog\) onRefreshSlowlog\(\)/)
    assert.match(src, /const refreshLoading = slowlogOn \? !!sl\.loading : loading/)
  })

  test('表格不分页（最多 512 条，交给内部滚动）、行键带下标兜底', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /columns=\{slowlogColumns\}\s*\n\s*dataSource=\{slRows\}/)
    assert.match(src, /scroll=\{\{ y: 340 \}\}\s*\n\s*pagination=\{false\}/)
    assert.match(src, /rowKey=\{\(r, i\) => `\$\{r\.id\}-\$\{i\}`\}/)
    // 0 条时不摆表和表头：状态行已经说过"没有"，表格再重复一遍只是多一块空白
    assert.match(src, /slStats\.count\s*\n\s*\? \(\s*\n\s*<Table/)
  })

  test('首帧转圈、带旧数据刷新不闪空板（与概览同一口径）', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /sl\.loading && !Array\.isArray\(sl\.entries\)/)
  })

  test('状态行：有条数才报最慢值，0 条说的是"没有慢日志"', () => {
    const src = fs.readFileSync(MODAL, 'utf8')
    assert.match(src, /slStats\.count\n {38}\? `\$\{e\('dbRedisSlowlogSummary'\)/)
    assert.match(src, /: e\('dbRedisSlowlogEmpty'\)/)
  })
})

describe('H7b-2 顶栏接线（db-session.jsx）', () => {
  test('op 名与后端一致，且不传 count（0 的"取全部"语义不该由前端碰出）', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    assert.match(src, /runGlobalAsync\('dbClientOp', tabId, 'getRedisSlowlog', \{\}\)/)
  })

  test('关闭弹层：令牌作废在途请求，条目清回"从没拉过"', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    assert.match(src, /redisInfoTokenRef\.current\+\+\n {4}redisSlowlogTokenRef\.current\+\+/)
    assert.match(src, /setRedisSlowlog\(\{ loading: false, error: '', entries: null \}\)/)
  })

  test('成功/失败分别归一：非数组回 []，失败回 null 并可重试', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    assert.match(src, /entries: Array\.isArray\(res\) \? res : \[\]/)
    assert.match(src, /entries: null,\n {8}error: cleanDbError/)
    // 两条回调都要过令牌门禁，否则关掉再打开会闪上一次的慢日志
    assert.equal((src.match(/token !== redisSlowlogTokenRef\.current/g) || []).length, 2)
  })

  test('三个 props 全挂上（漏一个就是页签永远转圈或永远空白）', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    assert.match(src, /slowlog=\{redisSlowlog\}\n {14}onLoadSlowlog=\{loadRedisSlowlog\}\n {14}onRefreshSlowlog=\{loadRedisSlowlog\}/)
  })
})

describe('H7b-2 样式与文案', () => {
  test('耗时/参数走数据面字体链，不写死 mono、不写死颜色', () => {
    const src = fs.readFileSync(STYL, 'utf8')
    const block = src.slice(src.indexOf('// H7b-2 慢日志页签'), src.indexOf('// 上下可拖拽分区'))
    assert.ok(block.length > 0, '慢日志样式块没找到')
    assert.match(block, /\.db-redis-slowlog-num\n {4}[\s\S]*?font-family var\(--db-code-font, var\(--font-mono\)\)/)
    assert.doesNotMatch(block, /font-family var\(--font-mono\)/)
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/)
    // 只右对齐数据格，表头跟着右对齐会和列名阅读顺序打架
    assert.match(block, /td\.db-redis-slowlog-num\n {4}text-align right/)
  })

  test('慢日志文案键全部双语齐备', () => {
    const extra = require(LOCALES)
    const modal = fs.readFileSync(MODAL, 'utf8')
    // 只认真正的取词调用：`useState('overview')` 尾巴也是 `e('...')`
    const re = /(?:^|[^A-Za-z0-9_$.])e\('(dbRedisSlowlog[A-Za-z]*)'\)/g
    const keys = [...new Set((modal.match(re) || []).map(s => /e\('([A-Za-z]+)'\)$/.exec(s)[1]))]
    assert.ok(keys.length >= 10, `慢日志自造键应有 10+，实际 ${keys.length}：${keys.join(',')}`)
    for (const k of keys) {
      assert.ok(extra.en[k] !== undefined, `${k} 缺英文词条`)
      assert.ok(extra.zh_cn[k] !== undefined, `${k} 缺中文词条`)
    }
  })
})
