// N5a · Redis 控制台执行层（主进程）：用桩客户端逐条钉死"发或不发"。
// 验收口径（§7 N5a）：**控制台写命令在只读下被主进程拦截**。
// 这里不只断言"返回了 blocked"，还断言**服务端一次都没被碰过**（calls 为空）——
// 否则"拦住了"与"发出去了但没生效"在结果里长得一模一样，而后者意味着命令已经递给了 Redis。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const SRC = path.join(__dirname, '../../app/lib/db-client/redis-console')
const consoleOp = require(SRC)

// 与 redis-command-policy.spec.js 同一份样本形状：ping 不带 readonly flag
const COMMAND_REPLY = [
  ['get', 2, ['readonly', 'fast']],
  ['set', -3, ['write', 'denyoom']],
  ['ping', -1, []],
  ['info', -1, ['random']],
  ['blpop', -3, ['write', 'blocking']],
  ['memory', -2, ['readonly']],
  ['dbsize', 1, ['readonly', 'fast']],
  ['mycustom', -1, ['readonly']]
]

/**
 * 桩客户端：记录每一次 call（含参数），COMMAND 可配置成禁用/空表，
 * 其它命令的回复与异常由 opts 决定。useDb 的调用也单独记，
 * 用来断言"拒绝发生在建连/SELECT 之前"。
 */
function makeClient (opts = {}) {
  const calls = []
  const client = {
    async call (...args) {
      calls.push(args)
      const name = String(args[0]).toLowerCase()
      if (name === 'command') {
        if (opts.noCommand) {
          throw new Error('ERR unknown command \'COMMAND\'')
        }
        return opts.commandReply === undefined ? COMMAND_REPLY : opts.commandReply
      }
      if (opts.throws && opts.throws[name]) {
        throw opts.throws[name]
      }
      return opts.reply ? opts.reply(name, args.slice(1)) : 'OK'
    }
  }
  const useDbCalls = []
  const deps = {
    useDb: async (conn, dbIndex) => {
      useDbCalls.push({ conn, dbIndex })
      return client
    }
  }
  return { client, calls, useDbCalls, deps, conn: { host: 'stub' } }
}

function replyError (message) {
  const e = new Error(message)
  e.name = 'ReplyError'
  return e
}

describe('redis-console: 拒绝不碰服务端（第一遍，只看名字）', () => {
  const refused = [
    ['FLUSHALL', 'destructive'],
    ['FLUSHDB', 'destructive'],
    ['KEYS *', 'destructive'],
    ['SHUTDOWN', 'destructive'],
    ['CONFIG GET maxmemory', 'admin'],
    ['MONITOR', 'streaming'],
    ['SUBSCRIBE ch', 'pubsub'],
    ['SELECT 3', 'connection-state'],
    ['MULTI', 'connection-state'],
    ['EVAL "return 1" 0', 'scripting'],
    ['BLPOP k 0', 'blocking'],
    ['XREAD COUNT 1 STREAMS s 0', 'blocking']
  ]
  for (const readOnly of [true, false]) {
    for (const [line, reason] of refused) {
      test(`${line} · readOnly=${readOnly} → ${reason}，零往返`, async () => {
        const s = makeClient()
        const r = await consoleOp.runRedisCommand(s.conn, { line, dbIndex: 2, readOnly }, s.deps)
        assert.equal(r.status, 'blocked')
        assert.equal(r.reason, reason)
        assert.equal(r.readOnly, readOnly)
        assert.deepEqual(s.useDbCalls, [], '连 useDb 都不该发生')
        assert.deepEqual(s.calls, [], '一次服务端往返都不该有（连 COMMAND 都不取）')
      })
    }
  }

  test('拒绝结果带回命令名与参数（历史里要能看出用户敲的是什么）', async () => {
    const s = makeClient()
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'KEYS user:*', readOnly: false }, s.deps)
    assert.equal(r.command, 'KEYS')
    assert.deepEqual(r.args, ['user:*'])
  })
})

describe('redis-console: 只读位（第二遍，取服务端 COMMAND 自述）', () => {
  test('验收口径：只读下 SET 被主进程拦截，且没有把 SET 发出去', async () => {
    const s = makeClient()
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'SET k v', dbIndex: 1, readOnly: true }, s.deps)
    assert.equal(r.status, 'blocked')
    assert.equal(r.reason, 'readonly-refuse')
    assert.equal(r.command, 'SET')
    assert.deepEqual(r.args, ['k', 'v'])
    assert.deepEqual(s.calls, [['COMMAND']], '只花了取属性那一次往返')
  })

  test('非只读下 SET 真的发出去了（真写路径，参数原样递到 call）', async () => {
    const s = makeClient()
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'SET k v', readOnly: false }, s.deps)
    assert.equal(r.status, 'ok')
    assert.equal(r.reply, 'OK')
    assert.equal(r.write, true)
    assert.equal(r.source, 'server')
    assert.deepEqual(s.calls, [['COMMAND'], ['SET', 'k', 'v']])
  })

  test('只读下 PING / INFO / DBSIZE 放行（flags 无 readonly 也不误伤）', async () => {
    for (const line of ['PING', 'INFO', 'DBSIZE']) {
      const s = makeClient({ reply: () => 42 })
      const r = await consoleOp.runRedisCommand(s.conn, { line, readOnly: true }, s.deps)
      assert.equal(r.status, 'ok', line)
      assert.equal(r.write, false, line)
      assert.equal(r.reply, 42)
    }
  })

  test('服务端自述 blocking → 拒绝（名字名单之外的新阻塞命令也拦得住）', async () => {
    const s = makeClient({
      commandReply: [['newblock', -1, ['blocking']]].concat(COMMAND_REPLY)
    })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'NEWBLOCK k', readOnly: false }, s.deps)
    assert.equal(r.status, 'blocked')
    assert.equal(r.reason, 'blocking')
    assert.deepEqual(s.calls, [['COMMAND']])
  })

  test('名单外的新命令按服务端 flags 判，不按"没听说过"判', async () => {
    const s = makeClient({ reply: () => 'v' })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'MYCUSTOM k', readOnly: true }, s.deps)
    assert.equal(r.status, 'ok')
    assert.equal(r.source, 'server')
    assert.equal(r.write, false)
  })

  test('COMMAND 被禁用 → 回落名单：读放行、写拒绝、名单外 unknown-command', async () => {
    for (const [line, status, reason, source] of [
      ['GET k', 'ok', undefined, 'fallback'],
      ['MEMORY USAGE k', 'ok', undefined, 'fallback'],
      ['SET k v', 'blocked', 'readonly-refuse', undefined],
      ['SOME_NEW_CMD', 'blocked', 'unknown-command', undefined]
    ]) {
      const s = makeClient({ noCommand: true, reply: () => 'v' })
      const r = await consoleOp.runRedisCommand(s.conn, { line, readOnly: true }, s.deps)
      assert.equal(r.status, status, line)
      assert.equal(r.reason, reason, line)
      assert.equal(r.source, source, line)
      // 取属性失败不该被当成"这条命令不安全"：读命令仍然只花 COMMAND 那一次失败往返
      assert.equal(s.calls[0][0], 'COMMAND')
      if (status === 'ok') {
        assert.equal(s.calls.length, 2, line)
      } else {
        assert.equal(s.calls.length, 1, line)
      }
    }
  })

  test('COMMAND 回空表也走回落（不是"服务端说这张表是空的所以都安全"）', async () => {
    const s = makeClient({ commandReply: [] })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'SOME_NEW_CMD', readOnly: true }, s.deps)
    assert.deepEqual(r, {
      status: 'blocked',
      reason: 'unknown-command',
      command: 'SOME_NEW_CMD',
      args: [],
      readOnly: true
    })
  })

  test('非只读 + 拿不到属性 → 放行（服务端自己会回答 ERR unknown command）', async () => {
    const s = makeClient({ noCommand: true, throws: { some_new_cmd: replyError('ERR unknown command') } })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'SOME_NEW_CMD', readOnly: false }, s.deps)
    assert.equal(r.status, 'error')
    assert.equal(r.source, 'fallback')
    assert.equal(r.write, null, '不知道就不标写')
  })
})

describe('redis-console: 分词与入参上限', () => {
  test('超长行 → invalid/line-too-long，且不碰服务端', async () => {
    const s = makeClient()
    const line = 'SET k ' + 'x'.repeat(consoleOp.LINE_MAX_CHARS)
    const r = await consoleOp.runRedisCommand(s.conn, { line, readOnly: false }, s.deps)
    assert.equal(r.status, 'invalid')
    assert.equal(r.reason, 'line-too-long')
    assert.deepEqual(s.useDbCalls, [])
  })

  test('未闭合引号 / 空行 / 非法名 → invalid，且不碰服务端', async () => {
    for (const [line, reason] of [
      ['SET k "a b', 'unterminated-quote'],
      ['', 'empty-command'],
      ['   ', 'empty-command'],
      ['GET;k', 'bad-name']
    ]) {
      const s = makeClient()
      const r = await consoleOp.runRedisCommand(s.conn, { line, readOnly: true }, s.deps)
      assert.equal(r.status, 'invalid', line)
      assert.equal(r.reason, reason, line)
      assert.equal(r.readOnly, true)
      assert.deepEqual(s.useDbCalls, [], line)
    }
  })

  test('引号里的空格作为一个参数原样递出去（不被二次切分）', async () => {
    const s = makeClient()
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'SET k "a b"', readOnly: false }, s.deps)
    assert.equal(r.status, 'ok')
    assert.deepEqual(s.calls[1], ['SET', 'k', 'a b'])
    assert.deepEqual(r.args, ['k', 'a b'])
  })

  test('dbIndex 原样交给 useDb（控制台跟着当前库走）', async () => {
    const s = makeClient()
    await consoleOp.runRedisCommand(s.conn, { line: 'PING', dbIndex: 7, readOnly: true }, s.deps)
    assert.deepEqual(s.useDbCalls, [{ conn: s.conn, dbIndex: 7 }])
  })

  test('useDb 必须由 redis.js 注入（缺注入直接抛，不静默跑空）', async () => {
    await assert.rejects(
      () => consoleOp.runRedisCommand({}, { line: 'PING' }, {}),
      /requires useDb injection/
    )
    await assert.rejects(
      () => consoleOp.listRedisCommands({}, {}, {}),
      /requires useDb injection/
    )
  })
})

describe('redis-console: 错误回复是结果，连接错误仍是异常', () => {
  test('ReplyError → status error，服务端原文保留', async () => {
    const s = makeClient({
      throws: { get: replyError('ERR wrong number of arguments for \'get\' command') }
    })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'GET', readOnly: true }, s.deps)
    assert.equal(r.status, 'error')
    assert.equal(r.error, 'ERR wrong number of arguments for \'get\' command')
    assert.equal(r.command, 'GET')
    assert.equal(r.source, 'server')
    assert.equal(r.write, false)
    assert.equal(typeof r.elapsedMs, 'number')
  })

  test('构造器名为 ReplyError（跨 realm / 未设 name）也认', async () => {
    class ReplyError extends Error {}
    const s = makeClient({ throws: { ping: new ReplyError('ERR nope') } })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'PING', readOnly: true }, s.deps)
    assert.equal(r.status, 'error')
    assert.equal(r.error, 'ERR nope')
  })

  test('连接/超时错误继续上抛（那不是回复，是没法问）', async () => {
    for (const e of [new Error('Connection is closed.'), new Error('Reached the max retries per request limit')]) {
      const s = makeClient({ throws: { ping: e } })
      await assert.rejects(
        () => consoleOp.runRedisCommand(s.conn, { line: 'PING', readOnly: true }, s.deps),
        err => err === e
      )
    }
  })

  test('COMMAND 抛错不影响后续命令执行（属性拿不到就走名单）', async () => {
    const s = makeClient({ noCommand: true, reply: () => 'PONG' })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'PING', readOnly: true }, s.deps)
    assert.equal(r.status, 'ok')
    assert.equal(r.reply, 'PONG')
    assert.equal(r.source, 'fallback')
  })
})

describe('redis-console: 属性缓存按连接实例持有', () => {
  test('同一连接连发两条只花一次 COMMAND；换一条连接重新取', async () => {
    const s = makeClient({ reply: () => 'PONG' })
    await consoleOp.runRedisCommand(s.conn, { line: 'PING', readOnly: true }, s.deps)
    await consoleOp.runRedisCommand(s.conn, { line: 'PING', readOnly: true }, s.deps)
    assert.equal(s.calls.filter(c => c[0] === 'COMMAND').length, 1)

    const t = makeClient({ reply: () => 'PONG' })
    await consoleOp.runRedisCommand(t.conn, { line: 'PING', readOnly: true }, t.deps)
    assert.equal(t.calls.filter(c => c[0] === 'COMMAND').length, 1, '不同实例不共用属性')
  })

  test('loadFlagsByName：拿到表 / 拿不到给 null（不抛）', async () => {
    const s = makeClient()
    const m = await consoleOp.loadFlagsByName(s.client)
    assert.equal(m.get('set').flags.includes('write'), true)
    const t = makeClient({ noCommand: true })
    assert.equal(await consoleOp.loadFlagsByName(t.client), null)
    const u = makeClient({ commandReply: [] })
    assert.equal(await consoleOp.loadFlagsByName(u.client), null)
  })

  test('force 绕过缓存重取，并把新属性写回缓存（否则那个按钮等于不存在）', async () => {
    const s = makeClient()
    await consoleOp.loadFlagsByName(s.client)
    await consoleOp.loadFlagsByName(s.client)
    const n = () => s.calls.filter(c => c[0] === 'COMMAND').length
    assert.equal(n(), 1)
    const m = await consoleOp.loadFlagsByName(s.client, true)
    assert.equal(n(), 2, 'force 必须真的再问一次服务端')
    assert.equal(m.get('set').flags.includes('write'), true)
    await consoleOp.loadFlagsByName(s.client)
    assert.equal(n(), 2, 'force 之后缓存已刷新，后续仍走缓存')
  })
})

describe('redis-console: 回复封顶（只截大小，不改语义）', () => {
  test('小回复原样、truncated=false、计数为 0', () => {
    const r = consoleOp.capReply(['a', 1, null])
    assert.deepEqual(r, { value: ['a', 1, null], truncated: false, droppedNodes: 0, shortenedValues: 0 })
    assert.deepEqual(consoleOp.capReply(null).value, null)
    assert.equal(consoleOp.capReply(42).value, 42)
    assert.equal(consoleOp.capReply(true).value, true)
  })

  test('Buffer → 字符串（二进制在这一版是有损的，见模块头"已知边界"）', () => {
    const r = consoleOp.capReply(Buffer.from('abc'))
    assert.equal(r.value, 'abc')
    assert.equal(r.truncated, false)
  })

  test('节点预算：数组按前 N 项截，丢掉的只计数、不塞假元素', () => {
    const total = consoleOp.REPLY_MAX_NODES + 500
    const r = consoleOp.capReply(Array.from({ length: total }, (_, i) => i))
    const kept = consoleOp.REPLY_MAX_NODES - 1
    assert.equal(r.value.length, kept)
    assert.equal(r.value[0], 0)
    assert.equal(r.value[kept - 1], kept - 1)
    assert.equal(r.droppedNodes, total - kept)
    assert.equal(r.shortenedValues, 0)
    assert.equal(r.truncated, true)
  })

  test('对象形状（RESP3 map）同样受节点预算约束', () => {
    const big = {}
    for (let i = 0; i < consoleOp.REPLY_MAX_NODES + 10; i++) {
      big['k' + i] = i
    }
    const r = consoleOp.capReply(big)
    assert.equal(Object.keys(r.value).length, consoleOp.REPLY_MAX_NODES - 1)
    assert.ok(r.droppedNodes > 0)
    assert.equal(r.truncated, true)
  })

  test('深度上限：超出的子树整个换成 null 并计数', () => {
    let v = 'leaf'
    for (let i = 0; i < consoleOp.REPLY_MAX_DEPTH + 4; i++) {
      v = [v]
    }
    const r = consoleOp.capReply(v)
    assert.ok(r.droppedNodes > 0)
    assert.equal(r.truncated, true)
    let cur = r.value
    let depth = 0
    while (Array.isArray(cur)) {
      depth++
      cur = cur[0]
    }
    assert.ok(depth <= consoleOp.REPLY_MAX_DEPTH, `实际深度 ${depth}`)
    assert.equal(cur, null)
  })

  test('单值长度上限：截断计数与 truncated 都给，值本身是前缀', () => {
    const text = 'x'.repeat(consoleOp.REPLY_MAX_VALUE_CHARS + 100)
    const r = consoleOp.capReply(text)
    assert.equal(r.value.length, consoleOp.REPLY_MAX_VALUE_CHARS)
    assert.equal(r.value, text.slice(0, consoleOp.REPLY_MAX_VALUE_CHARS))
    assert.equal(r.shortenedValues, 1)
    assert.equal(r.droppedNodes, 0)
    assert.equal(r.truncated, true)
  })

  test('封顶标记随执行结果一起回来（渲染层据此给"回复过大"提示）', async () => {
    const s = makeClient({ reply: () => 'x'.repeat(consoleOp.REPLY_MAX_VALUE_CHARS + 1) })
    const r = await consoleOp.runRedisCommand(s.conn, { line: 'GET k', readOnly: true }, s.deps)
    assert.equal(r.status, 'ok')
    assert.equal(r.truncated, true)
    assert.equal(r.shortenedValues, 1)
    assert.equal(r.reply.length, consoleOp.REPLY_MAX_VALUE_CHARS)
  })
})

describe('redis-console: 命令名表（补全来源）与提示同源', () => {
  test('服务端来源：按名字排序、带 arity/flags、提示与写属性都算好', async () => {
    const s = makeClient()
    const r = await consoleOp.listRedisCommands(s.conn, { dbIndex: 3, readOnly: true }, s.deps)
    assert.equal(r.source, 'server')
    assert.equal(r.readOnly, true)
    assert.deepEqual(r.entries.map(e => e.name), r.entries.map(e => e.name).slice().sort())
    const byName = new Map(r.entries.map(e => [e.name, e]))
    assert.equal(byName.get('get').hint, 'ok')
    assert.equal(byName.get('get').write, false)
    assert.equal(byName.get('get').arity, 2)
    assert.deepEqual(byName.get('get').flags, ['readonly', 'fast'])
    assert.equal(byName.get('set').hint, 'readonly-refuse')
    assert.equal(byName.get('set').write, true)
    assert.equal(byName.get('ping').hint, 'ok')
    assert.equal(byName.get('blpop').hint, 'blocking')
    assert.equal(byName.get('mycustom').hint, 'ok')
    assert.deepEqual(s.useDbCalls, [{ conn: s.conn, dbIndex: 3 }])
  })

  test('提示跟着只读位走：同一条 SET 在只读下被标拒绝、非只读下可用', async () => {
    const s = makeClient()
    const ro = await consoleOp.listRedisCommands(s.conn, { readOnly: true }, s.deps)
    const rw = await consoleOp.listRedisCommands(s.conn, { readOnly: false }, s.deps)
    const pick = (r, n) => r.entries.find(e => e.name === n)
    assert.equal(pick(ro, 'set').hint, 'readonly-refuse')
    assert.equal(pick(rw, 'set').hint, 'ok')
    assert.equal(pick(rw, 'set').write, true, '写属性与只读位无关')
    assert.equal(ro.readOnly, true)
    assert.equal(rw.readOnly, false)
  })

  test('黑名单条目也在表里，并带上自己的原因码（列表要能解释为什么不能用）', async () => {
    const s = makeClient({
      commandReply: COMMAND_REPLY.concat([
        ['flushall', 1, ['write']],
        ['keys', 2, ['readonly']],
        ['monitor', 1, []],
        ['eval', -3, ['noscript', 'may-replicate']]
      ])
    })
    const r = await consoleOp.listRedisCommands(s.conn, { readOnly: false }, s.deps)
    const pick = n => r.entries.find(e => e.name === n)
    // KEYS 的 flags 是 readonly，但名字规则先判 —— 只读位关着也拦
    assert.equal(pick('keys').hint, 'destructive')
    assert.equal(pick('flushall').hint, 'destructive')
    assert.equal(pick('monitor').hint, 'streaming')
    assert.equal(pick('eval').hint, 'scripting')
  })

  test('COMMAND 拿不到 → 回落名单，source=fallback，flags 留空', async () => {
    const s = makeClient({ noCommand: true })
    const r = await consoleOp.listRedisCommands(s.conn, { readOnly: true }, s.deps)
    assert.equal(r.source, 'fallback')
    assert.ok(r.entries.length > 100)
    for (const e of r.entries) {
      assert.deepEqual(e.flags, [])
      assert.equal(e.arity, 0)
    }
    const pick = n => r.entries.find(e => e.name === n)
    assert.equal(pick('get').hint, 'ok')
    assert.equal(pick('set').hint, 'readonly-refuse')
    assert.equal(pick('flushall').hint, 'destructive')
    assert.equal(pick('memory').write, false)
  })

  test('listRedisCommands 把 force 透到属性层；执行判定不受 force 影响', async () => {
    const s = makeClient({ reply: () => 'PONG' })
    await consoleOp.listRedisCommands(s.conn, {}, s.deps)
    const n = () => s.calls.filter(c => c[0] === 'COMMAND').length
    assert.equal(n(), 1)
    const r = await consoleOp.listRedisCommands(s.conn, { force: true, readOnly: false }, s.deps)
    assert.equal(r.source, 'server')
    assert.equal(n(), 2, 'force 必须透到属性层再发一次 COMMAND')

    // 执行路径只看只读位判定，force 不该改动"发不发"这个结论
    const t = makeClient({ reply: () => 'PONG' })
    const ro = await consoleOp.runRedisCommand(t.conn, { line: 'SET k v', readOnly: true, force: true }, t.deps)
    assert.equal(ro.status, 'blocked')
    assert.equal(ro.reason, 'readonly-refuse')
    assert.deepEqual(t.calls, [['COMMAND']], '只取属性那次往返，SET 没发')
    const rw = await consoleOp.runRedisCommand(t.conn, { line: 'SET k v', readOnly: false, force: true }, t.deps)
    assert.equal(rw.status, 'ok')
    const sentSet = t.calls.filter(c => c[0] === 'SET')
    assert.equal(sentSet.length, 1, '非只读下 force 不影响放行')
  })
})
