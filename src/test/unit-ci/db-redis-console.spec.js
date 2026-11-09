// N5a · Redis 控制台渲染层纯函数：只测"把主进程的结论画出来"这一段。
// 判定本身在主进程（redis-command-policy.spec.js / redis-console.spec.js 已钉死），
// 这里额外钉一条同源关系：**主进程能给出的每个原因码，在这张表里都有词条 key，
// 且该 key 在 en 与 zh_cn 里都存在** —— 少一条就是界面上直接暴露英文 key 原文。
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-redis-console.js')
const policy = require(path.join(ROOT, 'src/app/lib/db-client/redis-command-policy'))
const locales = require(path.join(ROOT, 'src/app/common/locales-extra.js'))

let M
let RISK_WRITE
let RISK_UNKNOWN
before(async () => {
  M = await import(pathToFileURL(SRC).href)
  const risk = await import(pathToFileURL(path.join(ROOT, 'src/client/common/db-sql-risk.js')).href)
  RISK_WRITE = risk.RISK_WRITE
  RISK_UNKNOWN = risk.RISK_UNKNOWN
})

// 主进程 listRedisCommands 交下来的形状（name/arity/flags/hint/write）
const ENTRIES = [
  { name: 'get', arity: 2, flags: ['readonly', 'fast'], hint: 'ok', write: false },
  { name: 'getrange', arity: 4, flags: ['readonly'], hint: 'ok', write: false },
  { name: 'hgetall', arity: 2, flags: ['readonly'], hint: 'ok', write: false },
  { name: 'set', arity: -3, flags: ['write', 'denyoom'], hint: 'readonly-refuse', write: true },
  { name: 'flushall', arity: 1, flags: ['write'], hint: 'destructive', write: true },
  { name: 'keys', arity: 2, flags: ['readonly'], hint: 'destructive', write: false },
  { name: 'mycustom', arity: -1, flags: [], hint: 'ok', write: null }
]
const RECENT = ['GET k', 'HGETALL h', 'GET k', '  ', 'SET k v']

describe('db-redis-console: 原因码 → 词条（唯一真源）', () => {
  test('主进程能给出的每个原因码都有专属词条，不落到 other', () => {
    const codes = new Set([
      'ok',
      'empty-command',
      'unterminated-quote',
      'bad-name',
      'line-too-long',
      'blocking',
      'readonly-refuse',
      'unknown-command',
      ...Object.values(policy.BLOCKED_REASONS)
    ])
    for (const code of codes) {
      const key = M.consoleReasonKey(code)
      assert.ok(key, code)
      assert.notEqual(key, M.ConsoleReasonKey.other, `${code} 必须有专属词条`)
      assert.equal(M.ConsoleReasonKey[code], key)
    }
  })

  test('没见过的码落到 other（而不是 undefined 让界面画出空横幅）', () => {
    assert.equal(M.consoleReasonKey('brand-new-reason'), M.ConsoleReasonKey.other)
    assert.equal(M.consoleReasonKey(undefined), M.ConsoleReasonKey.other)
    assert.equal(M.consoleReasonKey(''), M.ConsoleReasonKey.other)
  })

  test('每个词条 key 在 en 与 zh_cn 里都有非空译文', () => {
    for (const [code, key] of Object.entries(M.ConsoleReasonKey)) {
      for (const lang of ['en', 'zh_cn']) {
        const text = locales[lang][key]
        assert.equal(typeof text, 'string', `${code} → ${key} 缺 ${lang}`)
        assert.ok(text.trim(), `${key} 的 ${lang} 译文为空`)
      }
    }
  })

  test('词条 key 不重复（两个原因码共用一句话就是"两处真相"的开始）', () => {
    const values = Object.values(M.ConsoleReasonKey)
    assert.equal(new Set(values).size, values.length)
  })
})

describe('db-redis-console: 回复分型与头部', () => {
  test('五种形状各归各类', () => {
    assert.equal(M.replyKind(null), 'nil')
    assert.equal(M.replyKind(undefined), 'nil')
    assert.equal(M.replyKind(42), 'integer')
    assert.equal(M.replyKind(true), 'boolean')
    assert.equal(M.replyKind('OK'), 'bulk')
    assert.equal(M.replyKind(['a']), 'array')
    assert.equal(M.replyKind({ a: 1 }), 'object')
  })

  test('头部是 redis-cli 风格，空容器与 nil 分得开', () => {
    const t = k => locales.en[k]
    assert.equal(M.replyHeader(null, t), '(nil)')
    assert.equal(M.replyHeader(42, t), '(integer) 42')
    assert.equal(M.replyHeader(0, t), '(integer) 0')
    assert.equal(M.replyHeader(true, t), '(boolean) true')
    assert.equal(M.replyHeader(false, t), '(boolean) false')
    assert.equal(M.replyHeader('OK', t), '(string)')
    assert.equal(M.replyHeader([], t), '(empty array)')
    assert.equal(M.replyHeader(['a', 'b'], t), '(array) count: 2')
    assert.equal(M.replyHeader({}, t), '(empty map)')
    assert.equal(M.replyHeader({ a: 1, b: 2 }, t), '(map) count: 2')
  })

  test('量词跟着界面语言走，记法本身不翻译（模块里不许自带一份中文）', () => {
    const en = k => locales.en[k]
    const zh = k => locales.zh_cn[k]
    assert.equal(M.replyHeader(['a', 'b'], zh), '(array) 2 项')
    assert.equal(M.replyHeader({ a: 1 }, zh), '(map) 1 项')
    assert.equal(M.replyHeader(['a', 'b'], en), '(array) count: 2')
    for (const v of [null, 42, true, 'OK', [], {}]) {
      assert.equal(M.replyHeader(v, zh), M.replyHeader(v, en))
    }
    assert.ok(!/[一-龥]/.test(M.replyHeader(['a'], en)))
  })
})

describe('db-redis-console: 回复摊平成行', () => {
  test('标量一行，无标签', () => {
    const r = M.flattenReply('OK')
    assert.equal(r.kind, 'bulk')
    assert.equal(r.rowsTruncated, false)
    assert.deepEqual(r.rows.map(x => [x.depth, x.label, x.kind, x.text]), [[0, '', 'bulk', 'OK']])
  })

  test('数组按 1 起编号，嵌套多一层缩进', () => {
    const r = M.flattenReply(['a', ['b', 'c']])
    assert.deepEqual(r.rows.map(x => [x.depth, x.label, x.text]), [
      [0, '1', 'a'],
      [0, '2', ''],
      [1, '1', 'b'],
      [1, '2', 'c']
    ])
    assert.equal(new Set(r.rows.map(x => x.id)).size, r.rows.length, 'id 必须唯一（React key）')
  })

  test('对象用键名当标签（RESP3 map / 摊平后的哈希）', () => {
    const r = M.flattenReply({ field1: 'v1', field2: null })
    assert.deepEqual(r.rows.map(x => [x.label, x.text]), [['field1', 'v1'], ['field2', '(nil)']])
  })

  test('空容器不给行，也不谎报截断', () => {
    for (const v of [[], {}]) {
      const r = M.flattenReply(v)
      assert.deepEqual(r.rows, [])
      assert.equal(r.rowsTruncated, false)
    }
  })

  test('屏幕行数上限：只画前 N 行并标记，数据本身不动', () => {
    const total = M.REPLY_VISIBLE_ROWS + 20
    const r = M.flattenReply(Array.from({ length: total }, (_, i) => 'v' + i))
    assert.equal(r.rows.length, M.REPLY_VISIBLE_ROWS)
    assert.equal(r.rows[0].text, 'v0')
    assert.equal(r.rowsTruncated, true)
  })

  test('渲染层不碰 Node 全局：回复里没有 Buffer 也能画（主进程已转成字符串）', () => {
    // 渲染进程 nodeIntegration 关闭，Buffer.isBuffer 会 ReferenceError 把整个页签打没
    const src = require('fs').readFileSync(SRC, 'utf8')
    assert.ok(!/\bBuffer\s*\./.test(src), '渲染层纯函数不许引用 Buffer')
    assert.equal(M.flattenReply({ a: 1 }).rows[0].text, '1')
  })
})

describe('db-redis-console: 复制文本', () => {
  test('近似 redis-cli 输出，不带行号与排版', () => {
    assert.equal(M.replyToText(null), '(nil)')
    assert.equal(M.replyToText(42), '42')
    assert.equal(M.replyToText(true), 'true')
    assert.equal(M.replyToText('OK'), 'OK')
    assert.equal(M.replyToText(['a', 'b']), 'a\nb')
    assert.equal(M.replyToText(['a', ['b', 'c']]), 'a\nb\nc')
    assert.equal(M.replyToText({ a: 1 }), JSON.stringify({ a: 1 }, null, 2))
  })

  test('复制不受屏幕行数上限影响（截的是"没画出来"，不是"没拿回来"）', () => {
    const total = M.REPLY_VISIBLE_ROWS + 20
    const value = Array.from({ length: total }, (_, i) => 'v' + i)
    assert.equal(M.flattenReply(value).rows.length, M.REPLY_VISIBLE_ROWS)
    assert.equal(M.replyToText(value).split('\n').length, total)
  })
})

describe('db-redis-console: 补全落点', () => {
  test('命令位：token 前只剩空白', () => {
    assert.deepEqual(M.completionContext('GE', 2), {
      active: true, token: 'GE', start: 0, end: 2, isCommand: true
    })
    assert.deepEqual(M.completionContext('  GE', 4), {
      active: true, token: 'GE', start: 2, end: 4, isCommand: true
    })
  })

  test('参数位：不是命令名，只给整行历史', () => {
    assert.deepEqual(M.completionContext('GET k', 5), {
      active: true, token: 'k', start: 4, end: 5, isCommand: false
    })
    // 参数位刚敲下空格：没有 token 就没有候选（键名补全等 N5b）
    assert.equal(M.completionContext('GET ', 4).active, false)
  })

  test('引号里的段是值，不给补全', () => {
    assert.equal(M.completionContext('SET k "a b', 9).active, false)
    assert.equal(M.completionContext("SET k 'a", 8).active, false)
  })

  test('光标在词中间：替换区间只到光标，后面的字符留着', () => {
    assert.deepEqual(M.completionContext('HGETALL', 4), {
      active: true, token: 'HGET', start: 0, end: 4, isCommand: true
    })
  })

  test('光标越界 / 非数字一律夹到行内（输入框失焦时 selectionStart 可能是 null）', () => {
    assert.equal(M.completionContext('GET', -5).end, 0)
    assert.equal(M.completionContext('GET', 99).end, 3)
    assert.equal(M.completionContext('GET', null).end, 3)
    assert.equal(M.completionContext('GET', NaN).end, 3)
    assert.equal(M.completionContext('', 0).isCommand, true)
    assert.equal(M.completionContext(null, 0).active, true)
  })

  test('命令位落字：大写 + 尾随空格，保留光标后缀', () => {
    assert.deepEqual(M.applyCompletion('ge', 2, 'GET'), { line: 'GET ', caret: 4 })
    assert.deepEqual(M.applyCompletion('HGETALL', 4, 'HGET'), { line: 'HGET ALL', caret: 5 })
    assert.deepEqual(M.applyCompletion('', 0, 'ping'), { line: 'PING ', caret: 5 })
  })

  test('参数位落字：整行历史替换整行（不拼出没人敲过的命令）', () => {
    assert.deepEqual(M.applyCompletion('GET k', 5, 'HGETALL h'), { line: 'HGETALL h', caret: 9 })
    assert.deepEqual(M.applyCompletion('GET k', 5, ''), { line: '', caret: 0 })
  })
})

describe('db-redis-console: 候选归一（复用 quick-open 的打分与截断）', () => {
  test('命令项：kind=action、标题大写、被拦的带词条 key 与 blocked 标记', () => {
    const items = M.commandItems({ entries: ENTRIES })
    assert.equal(items.length, ENTRIES.length)
    const get = items.find(i => i.id === 'cmd:get')
    assert.equal(get.kind, 'action')
    assert.equal(get.title, 'GET')
    assert.equal(get.insert, 'GET')
    assert.equal(get.subtitle, 'readonly · fast')
    assert.equal(get.hint, '')
    assert.equal(get.blocked, false)
    assert.equal(get.arity, 2)
    const set = items.find(i => i.id === 'cmd:set')
    assert.equal(set.blocked, true)
    assert.equal(set.hint, M.consoleReasonKey('readonly-refuse'))
    const keys = items.find(i => i.id === 'cmd:keys')
    assert.equal(keys.hint, M.consoleReasonKey('destructive'))
    // 主进程说"不知道"就不标写，客户端不替它猜
    assert.equal(items.find(i => i.id === 'cmd:mycustom').blocked, false)
  })

  test('脏条目剔除，不抛（命令表来自异步 IPC，任何一路畸形都不该让输入框卡死）', () => {
    const items = M.commandItems({ entries: [null, {}, { name: '' }, { name: 7 }, { name: 'GET' }] })
    assert.equal(items.length, 1)
    assert.equal(items[0].title, 'GET')
    assert.equal(items[0].arity, 0)
    assert.deepEqual(M.commandItems({}), [])
    assert.deepEqual(M.commandItems(), [])
  })

  test('历史项：去重、去空白、最近优先、上限 20', () => {
    const items = M.recentItems(RECENT)
    assert.deepEqual(items.map(i => i.title), ['GET k', 'HGETALL h', 'SET k v'])
    assert.ok(items.every(i => i.kind === 'history'))
    const many = Array.from({ length: 40 }, (_, i) => 'CMD ' + i)
    assert.equal(M.recentItems(many).length, M.RECENT_MAX)
    assert.deepEqual(M.recentItems(null), [])
  })

  test('命令位只出命令名：整行历史不许挤掉 HGETALL', () => {
    const { ctx, items } = M.consoleCandidates({
      entries: ENTRIES,
      recent: ['HGET k f', 'HGETALL h'],
      line: 'hge',
      caret: 3
    })
    assert.equal(ctx.isCommand, true)
    assert.deepEqual(items.map(i => i.title), ['HGETALL'])
    assert.ok(items.every(i => i.kind === 'action'))
  })

  test('参数位只出整行历史', () => {
    const { ctx, items } = M.consoleCandidates({
      entries: ENTRIES,
      recent: RECENT,
      line: 'GET k',
      caret: 5
    })
    assert.equal(ctx.isCommand, false)
    assert.deepEqual(items.map(i => i.title), ['GET k', 'SET k v'])
    assert.ok(items.every(i => i.kind === 'history'))
  })

  test('前缀命中排在子串命中之前（打分来自 rankItems，不再造一套）', () => {
    const { items } = M.consoleCandidates({ entries: ENTRIES, line: 'get', caret: 3 })
    assert.deepEqual(items.map(i => i.title), ['GET', 'GETRANGE', 'HGETALL'])
  })

  test('空 query 给默认清单，全局上限 30 条', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      name: 'cmd' + i, arity: 0, flags: [], hint: 'ok', write: false
    }))
    const { items } = M.consoleCandidates({ entries, line: '', caret: 0 })
    assert.equal(items.length, 30)
    assert.equal(items[0].title, 'CMD0')
  })

  test('引号内 / 参数位空 token → 没有候选', () => {
    assert.deepEqual(M.consoleCandidates({ entries: ENTRIES, line: 'SET k "a', caret: 8 }).items, [])
    assert.deepEqual(M.consoleCandidates({ entries: ENTRIES, recent: RECENT, line: 'GET ', caret: 4 }).items, [])
  })
})

describe('db-redis-console: 生产确认档位（复用既有闸门，不另造名单）', () => {
  const base = { entries: ENTRIES, readOnly: false, isProduction: true }

  test('非生产 / 只读 → 不问（只读下主进程已经拦了写，再弹一次是噪声）', () => {
    assert.equal(M.consoleRisk({ ...base, isProduction: false, line: 'SET k v' }), null)
    assert.equal(M.consoleRisk({ ...base, readOnly: true, line: 'SET k v' }), null)
    assert.equal(M.consoleRisk({ ...base, line: '   ' }), null)
    assert.equal(M.consoleRisk(), null)
  })

  test('明确会写 → write 档；明确只读 → 不问', () => {
    assert.equal(M.consoleRisk({ ...base, line: 'SET k v' }), RISK_WRITE)
    assert.equal(M.consoleRisk({ ...base, line: 'set k v' }), RISK_WRITE)
    assert.equal(M.consoleRisk({ ...base, line: 'GET k' }), null)
    assert.equal(M.consoleRisk({ ...base, line: 'HGETALL h' }), null)
  })

  test('命令表里查不到 → unknown 档（保守多问，不猜"大概不写"）', () => {
    assert.equal(M.consoleRisk({ ...base, line: 'BRAND_NEW k' }), RISK_UNKNOWN)
    assert.equal(M.consoleRisk({ ...base, entries: [], line: 'GET k' }), RISK_UNKNOWN)
  })

  test('write 缺失（老数据）按会写处理；write:null 同样保守', () => {
    assert.equal(M.consoleRisk({ ...base, entries: [{ name: 'get' }], line: 'GET k' }), RISK_WRITE)
    assert.equal(M.consoleRisk({ ...base, line: 'MYCUSTOM k' }), RISK_WRITE)
  })

  test('firstWord 只服务"要不要多问一句"：取首词、小写、遇引号即止', () => {
    assert.equal(M.firstWord('  SET k "a b"'), 'set')
    assert.equal(M.firstWord('"GET" k'), '')
    assert.equal(M.firstWord(''), '')
    assert.equal(M.firstWord(null), '')
  })
})
