// N5a · Redis 控制台策略层：判定必须只在主进程发生一次，这里逐条钉死。
// 直接 require 真实源码（零依赖纯函数），不留测试拷贝。
//
// 三类断言各自对应一条口径：
// - §7 明令禁止的 FLUSHDB/FLUSHALL/KEYS：两种只读位下都拒，且拒在服务端属性之前；
// - 黑名单与只读是两件事：黑名单不看 flags，只读只看 write/may-replicate/denyoom；
// - 认不出来的命令在只读下不放行（unknown-command），非只读下才放行。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const policy = require(path.join(__dirname, '../../app/lib/db-client/redis-command-policy'))

// 服务端 COMMAND 自述的最小样本：只取前三位（name/arity/flags），
// ping 故意不带 readonly —— 这正是"含 readonly 才放"会把只读诊断一起禁掉的反例
const COMMAND_REPLY = [
  ['get', 2, ['readonly', 'fast'], ['~'], 'RO'],
  ['set', -3, ['write', 'denyoom'], ['~'], 'RW'],
  ['ping', -1, [], [], 'RO'],
  ['info', -1, ['random', 'loading', 'stale'], [], 'RO'],
  ['blpop', -3, ['write', 'blocking', 'noscript'], ['~'], 'RW'],
  ['publish', 3, ['pubsub', 'may-replicate', 'fast'], [], 'RO'],
  ['zadd', -4, ['write', 'denyoom', 'fast'], ['~'], 'RW'],
  ['memory', -2, ['readonly', 'random'], [], 'RO'],
  ['mycustom', -1, ['readonly'], [], 'RO']
]
const flags = () => policy.parseCommandReply(COMMAND_REPLY)

describe('redis-command-policy: 整行分词（渲染层只送原文）', () => {
  test('命令名与参数按空白切开，大小写原样保留', () => {
    assert.deepEqual(policy.tokenize('GET foo'), { ok: true, command: 'GET', args: ['foo'] })
    assert.deepEqual(policy.tokenize('  set\tk\nv  '), { ok: true, command: 'set', args: ['k', 'v'] })
    assert.deepEqual(policy.tokenize('PING'), { ok: true, command: 'PING', args: [] })
  })

  test('单/双引号包住的一段是一个参数，引号内的空格不切开', () => {
    assert.deepEqual(policy.tokenize('SET k "a b"').args, ['k', 'a b'])
    assert.deepEqual(policy.tokenize("SET k 'a b'").args, ['k', 'a b'])
    assert.deepEqual(policy.tokenize('SET k ""').args, ['k', ''])
  })

  test('转义取下一个字符本身（引号内外都是）', () => {
    assert.deepEqual(policy.tokenize('SET k "a\\"b"').args, ['k', 'a"b'])
    assert.deepEqual(policy.tokenize('SET k a\\ b').args, ['k', 'a b'])
    assert.deepEqual(policy.tokenize("SET k 'it\\'s'").args, ['k', "it's"])
  })

  test('未闭合引号必须报错，不能静默当成"参数到此为止"', () => {
    // 半截 SET k "a b 若被当成 SET k a 执行，改掉的是用户的数据
    assert.deepEqual(policy.tokenize('SET k "a b'), { ok: false, reason: 'unterminated-quote' })
    assert.deepEqual(policy.tokenize("SET k 'a"), { ok: false, reason: 'unterminated-quote' })
  })

  test('空行 / 纯空白 → empty-command；非法命令名 → bad-name', () => {
    assert.deepEqual(policy.tokenize(''), { ok: false, reason: 'empty-command' })
    assert.deepEqual(policy.tokenize(' \t\n '), { ok: false, reason: 'empty-command' })
    assert.deepEqual(policy.tokenize(null), { ok: false, reason: 'empty-command' })
    assert.deepEqual(policy.tokenize('GET;k'), { ok: false, reason: 'bad-name' })
    assert.deepEqual(policy.tokenize('1abc'), { ok: false, reason: 'bad-name' })
    assert.deepEqual(policy.tokenize('"GET" k'), { ok: true, command: 'GET', args: ['k'] })
  })
})

describe('redis-command-policy: COMMAND 自述解析', () => {
  test('只取前三位，尾部多出来的 key spec 一律忽略；名字与 flags 统一小写', () => {
    const m = flags()
    assert.equal(m.size, COMMAND_REPLY.length)
    assert.deepEqual(m.get('get'), { arity: 2, flags: ['readonly', 'fast'] })
    assert.deepEqual(m.get('ping'), { arity: -1, flags: [] })
    assert.deepEqual(m.get('mycustom'), { arity: -1, flags: ['readonly'] })
  })

  test('脏条目跳过而不是让整张表报废', () => {
    const m = policy.parseCommandReply([
      ['GET', 2, ['READONLY']],
      null,
      'get',
      [],
      [123, 2, []],
      ['', 2, []],
      ['set', 'x', ['write', 7, null]]
    ])
    assert.deepEqual(m.get('get'), { arity: 2, flags: ['readonly'] })
    assert.deepEqual(m.get('set'), { arity: 0, flags: ['write'] })
    assert.equal(m.size, 2)
  })

  test('非数组入参给空表（调用方据此回落到名单）', () => {
    assert.equal(policy.parseCommandReply(null).size, 0)
    assert.equal(policy.parseCommandReply('OK').size, 0)
    assert.equal(policy.parseCommandReply([]).size, 0)
  })
})

describe('redis-command-policy: 只看名字的拒绝（执行层第一遍）', () => {
  test('§7 明令禁止的三条：FLUSHDB / FLUSHALL / KEYS', () => {
    for (const name of ['FLUSHDB', 'FLUSHALL', 'KEYS', 'flushall', 'Keys']) {
      assert.deepEqual(policy.refuseByName({ command: name }), { allow: false, reason: 'destructive' }, name)
    }
  })

  test('黑名单按类别给原因码（UI 按码取词条，不看命令名）', () => {
    const cases = [
      ['SHUTDOWN', 'destructive'],
      ['CONFIG', 'admin'],
      ['ACL', 'admin'],
      ['BGSAVE', 'admin'],
      ['REPLICAOF', 'admin'],
      ['MONITOR', 'streaming'],
      ['SUBSCRIBE', 'pubsub'],
      ['PSUBSCRIBE', 'pubsub'],
      ['SELECT', 'connection-state'],
      ['SWAPDB', 'connection-state'],
      ['HELLO', 'connection-state'],
      ['AUTH', 'connection-state'],
      ['CLIENT', 'connection-state'],
      ['MULTI', 'connection-state'],
      ['EXEC', 'connection-state'],
      ['WATCH', 'connection-state'],
      ['EVAL', 'scripting'],
      ['EVALSHA', 'scripting'],
      ['EVAL_RO', 'scripting'],
      ['FCALL_RO', 'scripting'],
      ['SCRIPT', 'scripting'],
      ['FUNCTION', 'scripting']
    ]
    for (const [command, reason] of cases) {
      assert.deepEqual(policy.refuseByName({ command }), { allow: false, reason }, command)
    }
  })

  test('阻塞名单：老版本 COMMAND 没有 blocking flag，名字必须兜住', () => {
    for (const name of policy.BLOCKING_NAMES) {
      assert.deepEqual(policy.refuseByName({ command: name }), { allow: false, reason: 'blocking' }, name)
    }
    // XREAD 不带 BLOCK 时立即返回，但控制台不做参数级判断，一律拒
    assert.equal(policy.refuseByName({ command: 'XREAD' }).reason, 'blocking')
    assert.equal(policy.refuseByName({ command: 'WAIT' }).reason, 'blocking')
  })

  test('只读诊断不在黑名单里：MEMORY / INFO / SCAN 必须能跑（N5b 还要用 MEMORY USAGE）', () => {
    for (const name of ['MEMORY', 'INFO', 'SCAN', 'GET', 'HGETALL', 'DBSIZE', 'SLOWLOG', 'TIME']) {
      assert.deepEqual(policy.refuseByName({ command: name }), { allow: true }, name)
    }
  })

  test('空名 / 非法名 → bad-name', () => {
    assert.deepEqual(policy.refuseByName({}), { allow: false, reason: 'bad-name' })
    assert.deepEqual(policy.refuseByName({ command: '' }), { allow: false, reason: 'bad-name' })
    assert.deepEqual(policy.refuseByName({ command: 'GET;' }), { allow: false, reason: 'bad-name' })
  })

  test('refuseByName 与 evaluate 的名字类规则不分叉', () => {
    for (const name of Object.keys(policy.BLOCKED_REASONS).concat(policy.BLOCKING_NAMES)) {
      const a = policy.refuseByName({ command: name })
      // 带上服务端属性也不该改变名字类拒绝：黑名单永远在 flags 之前
      const b = policy.evaluate({ command: name, readOnly: false, flagsByName: flags() })
      const c = policy.evaluate({ command: name, readOnly: true })
      assert.deepEqual(a, b, name)
      assert.deepEqual(a, c, name)
    }
  })
})

describe('redis-command-policy: 只读位（执行层第二遍）', () => {
  test('只读下会写的命令被拒，原因码是 readonly-refuse', () => {
    for (const name of ['SET', 'ZADD', 'DEL', 'HSET', 'EXPIRE', 'PUBLISH']) {
      const r = policy.evaluate({ command: name, readOnly: true, flagsByName: flags() })
      assert.deepEqual(r, { allow: false, reason: 'readonly-refuse' }, name)
    }
  })

  test('非只读下同样这些命令放行，并标明属性来自服务端', () => {
    const r = policy.evaluate({ command: 'SET', readOnly: false, flagsByName: flags() })
    assert.deepEqual(r, { allow: true, source: 'server' })
  })

  test('flags 里没有 readonly 的只读诊断照样放行（判据是"不含写 flag"而不是"含 readonly"）', () => {
    for (const name of ['PING', 'INFO']) {
      assert.deepEqual(policy.evaluate({ command: name, readOnly: true, flagsByName: flags() }), {
        allow: true,
        source: 'server'
      }, name)
    }
  })

  test('服务端自述 blocking → 拒绝（与名字名单同一原因码）', () => {
    assert.deepEqual(
      policy.evaluate({ command: 'BLPOP', readOnly: false, flagsByName: flags() }),
      { allow: false, reason: 'blocking' }
    )
  })

  test('服务端属性是权威：名单外的新命令按 flags 判，不按"没听说过"判', () => {
    assert.deepEqual(
      policy.evaluate({ command: 'MYCUSTOM', readOnly: true, flagsByName: flags() }),
      { allow: true, source: 'server' }
    )
  })

  test('拿不到属性时回落名单：只读命令放行、写命令拒绝、名单外 unknown-command', () => {
    assert.deepEqual(policy.evaluate({ command: 'GET', readOnly: true }), { allow: true, source: 'fallback' })
    assert.deepEqual(policy.evaluate({ command: 'MEMORY', readOnly: true }), { allow: true, source: 'fallback' })
    assert.deepEqual(policy.evaluate({ command: 'SET', readOnly: true }), { allow: false, reason: 'readonly-refuse' })
    assert.deepEqual(
      policy.evaluate({ command: 'SOME_NEW_CMD', readOnly: true }),
      { allow: false, reason: 'unknown-command' }
    )
    // 非只读下不做名单猜测：认不出来也放行，服务端自己会回答 ERR unknown command
    assert.deepEqual(
      policy.evaluate({ command: 'SOME_NEW_CMD', readOnly: false }),
      { allow: true, source: 'fallback' }
    )
  })

  test('空 flags 表等价于拿不到属性（不会误判成"服务端说它安全"）', () => {
    assert.deepEqual(
      policy.evaluate({ command: 'SOME_NEW_CMD', readOnly: true, flagsByName: new Map() }),
      { allow: false, reason: 'unknown-command' }
    )
  })

  test('两份回落名单不相交（同一条命令不能既读又写）', () => {
    const overlap = policy.FALLBACK_READ.filter(n => policy.FALLBACK_WRITE.includes(n))
    assert.deepEqual(overlap, [])
  })

  test('WRITE_FLAGS 三个词各自都能触发只读拒绝', () => {
    assert.deepEqual(policy.WRITE_FLAGS, ['write', 'may-replicate', 'denyoom'])
    for (const flag of policy.WRITE_FLAGS) {
      const m = policy.parseCommandReply([['zzz', -1, [flag]]])
      assert.deepEqual(
        policy.evaluate({ command: 'ZZZ', readOnly: true, flagsByName: m }),
        { allow: false, reason: 'readonly-refuse' },
        flag
      )
    }
  })
})

describe('redis-command-policy: 写属性三态（只给 UI 徽标，不参与放行）', () => {
  test('明确读 / 明确写 / 不知道', () => {
    assert.equal(policy.isWriteCommand({ command: 'GET', flagsByName: flags() }), false)
    assert.equal(policy.isWriteCommand({ command: 'SET', flagsByName: flags() }), true)
    // may-replicate 单独出现也算写（PUBLISH 在 Redis 7 的 flags 里没有 write）
    assert.equal(policy.isWriteCommand({ command: 'PUBLISH', flagsByName: flags() }), true)
    assert.equal(policy.isWriteCommand({ command: 'PING', flagsByName: flags() }), false)
    assert.equal(policy.isWriteCommand({ command: 'MYSTERY' }), null)
    assert.equal(policy.isWriteCommand({ command: '' }), null)
    assert.equal(policy.isWriteCommand({}), null)
  })

  test('没有服务端属性时用回落名单，名单外仍是 null（不许猜"大概不写"）', () => {
    assert.equal(policy.isWriteCommand({ command: 'HGETALL' }), false)
    assert.equal(policy.isWriteCommand({ command: 'DEL' }), true)
    assert.equal(policy.isWriteCommand({ command: 'BRAND_NEW_CMD' }), null)
  })

  test('服务端属性优先于回落名单', () => {
    const m = policy.parseCommandReply([['get', 2, ['write']]])
    assert.equal(policy.isWriteCommand({ command: 'GET', flagsByName: m }), true)
  })
})

describe('redis-command-policy: 补全提示与执行判定同源', () => {
  test('readOnlyHint = evaluate 的结论（列表标可用与真按回车不可能各说一套）', () => {
    const names = ['GET', 'SET', 'PING', 'BLPOP', 'FLUSHALL', 'KEYS', 'MONITOR', 'MYCUSTOM', 'MYSTERY']
    const m = flags()
    for (const readOnly of [true, false]) {
      for (const command of names) {
        const r = policy.evaluate({ command, readOnly, flagsByName: m })
        const hint = policy.readOnlyHint({ command, readOnly, flagsByName: m })
        assert.equal(hint, r.allow ? 'ok' : r.reason, `${command} readOnly=${readOnly}`)
      }
    }
  })

  test('提示跟着调用方给的只读位走（不是写死 true）', () => {
    assert.equal(policy.readOnlyHint({ command: 'SET', readOnly: false, flagsByName: flags() }), 'ok')
    assert.equal(policy.readOnlyHint({ command: 'SET', readOnly: true, flagsByName: flags() }), 'readonly-refuse')
  })

  test('回落命令表：有序、去重、含黑名单条目（列表里要能看见它们被拦）', () => {
    const list = policy.fallbackCommandList()
    const names = list.map(e => e.name)
    assert.deepEqual(names, Array.from(new Set(names)).sort())
    for (const key of Object.keys(policy.BLOCKED_REASONS)) {
      assert.ok(names.includes(key), `${key} 必须出现在候选里（并标成拒绝）`)
    }
    for (const e of list) {
      assert.deepEqual(e.flags, [])
      assert.equal(e.arity, 0)
    }
    // 黑名单条目在只读下的提示就是它自己的原因码
    assert.equal(
      policy.readOnlyHint({ command: 'flushall', readOnly: true, flagsByName: null }),
      'destructive'
    )
  })
})
