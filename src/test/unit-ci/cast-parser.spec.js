// G2-1：asciinema v2 录制解析（纯函数）
//
// 录制是"边写边 flush"的，所以解析层的主要敌人不是恶意输入而是**残缺**：
// 尾部半行、只有 header、没有输入事件。判据重点在"哪些坏是可以继续播、
// 哪些坏必须直接拒"——header 坏必须抛（没有宽高就定不了终端尺寸），
// 单行坏只跳过并计数。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/cast-parser.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

const H = '{"version":2,"width":80,"height":24,"timestamp":1730000000}'
const ev = (t, type, data) => JSON.stringify([t, type, data])
const cast = (...rows) => [H, ...rows].join('\n') + '\n'

describe('G2 cast 解析：header', () => {
  test('正常 header 原样带出宽高与起始时间戳', async () => {
    const { parseCast } = await load()
    const r = parseCast(cast(ev(0.1, 'o', 'hi')))
    assert.equal(r.header.width, 80)
    assert.equal(r.header.height, 24)
    assert.equal(r.header.timestamp, 1730000000)
    assert.equal(r.empty, false)
  })

  test('header 不是 JSON / 是数组 / 缺宽高 / 宽高非正数 → 抛格式错', async () => {
    const { parseCast, CastFormatError } = await load()
    const bad = [
      'not json\n' + ev(0.1, 'o', 'x') + '\n',
      '[1,2,3]\n' + ev(0.1, 'o', 'x') + '\n',
      '{"version":2,"timestamp":1}\n' + ev(0.1, 'o', 'x') + '\n',
      '{"version":2,"width":0,"height":24}\n' + ev(0.1, 'o', 'x') + '\n',
      '{"version":2,"width":"80","height":24}\n' + ev(0.1, 'o', 'x') + '\n'
    ]
    for (const text of bad) {
      assert.throws(() => parseCast(text), CastFormatError, '应当拒掉: ' + text.slice(0, 30))
    }
  })

  test('空文件与只有空白：可打开（empty），不当格式错', async () => {
    const { parseCast } = await load()
    for (const text of ['', '\n', '   \n\n']) {
      const r = parseCast(text)
      assert.equal(r.empty, true)
      assert.deepEqual(r.events, [])
      assert.equal(r.duration, 0)
    }
  })

  test('只有 header：合法空录制，events 为空但不是 empty', async () => {
    const { parseCast } = await load()
    const r = parseCast(H + '\n')
    assert.equal(r.empty, false)
    assert.deepEqual(r.events, [])
    assert.equal(r.badLines, 0)
  })
})

describe('G2 cast 解析：事件', () => {
  test('o/i 事件按文件顺序产出，时间与数据分字段', async () => {
    const { parseCast } = await load()
    const r = parseCast(cast(ev(0.5, 'o', 'a'), ev(1.25, 'i', 'ls\r'), ev(2, 'o', 'b')))
    assert.deepEqual(r.events, [
      { at: 0.5, type: 'o', data: 'a' },
      { at: 1.25, type: 'i', data: 'ls\r' },
      { at: 2, type: 'o', data: 'b' }
    ])
    assert.equal(r.duration, 2)
  })

  test('负时间钳到 0（录制端已钳，解析层不信任落盘内容）', async () => {
    const { parseCast } = await load()
    const r = parseCast(cast(ev(-3, 'o', 'x')))
    assert.equal(r.events[0].at, 0)
  })

  test('时间乱序不重排：录制端按到达顺序落盘，重排等于把输出顺序改掉', async () => {
    const { parseCast } = await load()
    const r = parseCast(cast(ev(2, 'o', 'first'), ev(1, 'o', 'second')))
    assert.deepEqual(r.events.map(e => e.data), ['first', 'second'])
    // duration 取最大值而不是末条，乱序不会给出偏小的时长
    assert.equal(r.duration, 2)
  })

  test('坏行跳过并计数：半行 / 非数组 / 列数不足 / 时间非数 / 类型非串', async () => {
    const { parseCast } = await load()
    const r = parseCast([
      H,
      '[0.1,"o","ok"',
      '"just a string"',
      '[0.2,"o"]',
      '["t","o","x"]',
      '[0.3,null,"x"]',
      ev(0.4, 'o', 'good'),
      ''
    ].join('\n'))
    assert.equal(r.badLines, 5)
    assert.deepEqual(r.events, [{ at: 0.4, type: 'o', data: 'good' }])
  })

  test('尾部半行是常态：断连落盘时最后一条可能没写完，不影响前面的事件', async () => {
    const { parseCast } = await load()
    const r = parseCast(H + '\n' + ev(0.1, 'o', 'a') + '\n' + '[0.2,"o","截')
    assert.equal(r.events.length, 1)
    assert.equal(r.badLines, 1)
  })

  test('CRLF 行尾照常解析', async () => {
    const { parseCast } = await load()
    const r = parseCast(cast(ev(0.1, 'o', 'a'), ev(0.2, 'o', 'b')).replace(/\n/g, '\r\n'))
    assert.deepEqual(r.events.map(e => e.data), ['a', 'b'])
    assert.equal(r.badLines, 0)
  })

  test('非字符串负载（如 resize 的对象）保留事件、数据给空串，算 other 不算坏行', async () => {
    const { parseCast, castCounts } = await load()
    const r = parseCast(cast(ev(0.1, 'o', 'a'), JSON.stringify([0.2, 'r', { cols: 100, rows: 30 }])))
    assert.equal(r.badLines, 0)
    assert.deepEqual(r.events[1], { at: 0.2, type: 'r', data: '' })
    assert.deepEqual(castCounts(r.events), { out: 1, input: 0, other: 1 })
  })

  test('castCounts 输出/输入分开数，与解析条数对得上账', async () => {
    const { parseCast, castCounts } = await load()
    const r = parseCast(cast(ev(0.1, 'o', 'a'), ev(0.2, 'i', 'b'), ev(0.3, 'o', 'c')))
    assert.deepEqual(castCounts(r.events), { out: 2, input: 1, other: 0 })
    assert.equal(castCounts(r.events).out + castCounts(r.events).input, r.events.length)
  })
})

describe('G2 cast 解析：命令与进度', () => {
  test('输入事件按回车分段；退格真的删掉前一个字符', async () => {
    const { parseCast, castCommands } = await load()
    const r = parseCast(cast(
      ev(0.1, 'i', 'ls -l'),
      ev(0.2, 'i', '\r'),
      ev(0.3, 'i', 'git statx'),
      ev(0.4, 'i', '\b'),
      ev(0.5, 'i', 'us\r'),
      ev(0.6, 'o', '出画面不算命令')
    ))
    assert.deepEqual(castCommands(r.events), ['ls -l', 'git status'])
  })

  test('方向键/编辑键等转义序列不残留成 "[A" 这种垃圾', async () => {
    const { parseCast, castCommands } = await load()
    const r = parseCast(cast(ev(0.1, 'i', '\x1b[A\x1b[Bvim\r'), ev(0.2, 'i', '\x1b[200~paste\x1b[201~\r')))
    assert.deepEqual(castCommands(r.events), ['vim', 'paste'])
  })

  test('连续回车与只有空格的"命令"不产出条目；制表符压成空格', async () => {
    const { parseCast, castCommands } = await load()
    const r = parseCast(cast(ev(0.1, 'i', '\r\r\n'), ev(0.2, 'i', 'a\tb\r')))
    assert.deepEqual(castCommands(r.events), ['a b'])
  })

  test('没开 recordInput 的录制：命令列表为空、首条命令为 null', async () => {
    const { parseCast, castCommands, firstCastCommand } = await load()
    const r = parseCast(cast(ev(0.1, 'o', 'only output')))
    assert.deepEqual(castCommands(r.events), [])
    assert.equal(firstCastCommand(r.events), null)
  })

  test('首条命令压空白、截到上限带省略号', async () => {
    const { parseCast, firstCastCommand, CAST_CMD_MAX } = await load()
    const long = 'echo ' + 'x'.repeat(200)
    const r = parseCast(cast(ev(0.1, 'i', long + '  \r'), ev(0.2, 'i', 'second\r')))
    const one = firstCastCommand(r.events)
    assert.equal(one.length, CAST_CMD_MAX + 1)
    assert.ok(one.endsWith('…'))
    assert.ok(!/\s$/.test(one))
  })

  test('首条命令只剩控制字符时给 null，而不是一个空格', async () => {
    const { parseCast, firstCastCommand } = await load()
    const r = parseCast(cast(ev(0.1, 'i', '\x07\x08\r'), ev(0.2, 'i', 'real\r')))
    // 第一条被退格/响铃吃干净了 → 取下一条真实命令
    assert.equal(firstCastCommand(r.events), 'real')
  })

  test('帧按毫秒归并、按时间升序，帧内保持原顺序（拖进度据此定位）', async () => {
    const { parseCast, castFrames } = await load()
    const r = parseCast(cast(
      ev(0.0004, 'o', 'a'),
      ev(0.0002, 'o', 'b'),
      ev(0.0015, 'o', 'c')
    ))
    assert.deepEqual(castFrames(r.events), [
      { ms: 0, idxs: [0, 1] },
      { ms: 1, idxs: [2] }
    ])
  })

  test('空事件集：帧表为空，不抛', async () => {
    const { castFrames } = await load()
    assert.deepEqual(castFrames([]), [])
  })
})

describe('G2 cast 列表探测：尾段时长', () => {
  test('取最后一条事件的时间（列表页据此显示时长）', async () => {
    const { castTailDuration } = await load()
    assert.equal(castTailDuration([ev(1, 'o', 'a'), ev(2.5, 'o', 'b')].join('\n')), 2.5)
  })

  test('末尾半行跳过（写盘 500ms 一批，尾巴本来就不全）', async () => {
    const { castTailDuration } = await load()
    const tail = [ev(1, 'o', 'a'), ev(3, 'o', 'x')].join('\n') + '\n[3.9", "o"'
    assert.equal(castTailDuration(tail), 3)
  })

  test('开头半行也跳过（尾段是切片出来的，边界一定在行中）', async () => {
    const { castTailDuration } = await load()
    assert.equal(castTailDuration('"a"]\n' + ev(7, 'o', 'b')), 7)
  })

  test('键盘输入事件也算时间（时间线不分类型）', async () => {
    const { castTailDuration } = await load()
    assert.equal(castTailDuration([ev(2, 'o', 'a'), ev(4, 'i', 'ls\r')].join('\n')), 4)
  })

  test('负时间钳到 0；全扫不到回 null（界面画「—」而不是 0 秒）', async () => {
    const { castTailDuration } = await load()
    assert.equal(castTailDuration(ev(-3, 'o', 'a')), 0)
    assert.equal(castTailDuration(''), null)
    assert.equal(castTailDuration(H), null)
    assert.equal(castTailDuration([ev('x', 'o', 'a'), '[1,2]', '[9]'].join('\n')), null)
  })
})

describe('G2 cast 列表探测：整行摘要', () => {
  test('小文件（tail 为空）：时长/尺寸/首条命令都来自 head', async () => {
    const { castProbeSummary } = await load()
    const s = castProbeSummary(cast(ev(0.1, 'i', 'ls\r'), ev(1.2, 'o', 'file1\n')), '')
    assert.deepEqual(s, {
      invalid: false,
      cols: 80,
      rows: 24,
      duration: 1.2,
      firstCommand: 'ls'
    })
  })

  test('大文件：时长取尾段而不是 head 的下界', async () => {
    const { castProbeSummary } = await load()
    const head = cast(ev(0.5, 'o', 'a'), ev(1, 'o', 'b'))
    const s = castProbeSummary(head, ev(120.5, 'o', 'z'))
    assert.equal(s.duration, 120.5)
    assert.equal(s.cols, 80)
  })

  test('没开 recordInput 时首条命令为 null（界面画「—」）', async () => {
    const { castProbeSummary } = await load()
    assert.equal(castProbeSummary(cast(ev(1, 'o', 'a')), '').firstCommand, null)
  })

  test('header 损坏不抛：只标 invalid，其余留空（该行仍可删/可定位）', async () => {
    const { castProbeSummary } = await load()
    const bad = '{"version":2,"width":0,"height":24}\n' + ev(1, 'o', 'a')
    assert.deepEqual(castProbeSummary(bad, ev(9, 'o', 'z')), {
      invalid: true,
      cols: null,
      rows: null,
      duration: null,
      firstCommand: null
    })
  })

  test('0 字节/只有空白：不是"格式错误"，是"没内容"（时长 0、尺寸空）', async () => {
    const { castProbeSummary } = await load()
    const empty = cast()
    assert.deepEqual(castProbeSummary('', ''), {
      invalid: false,
      cols: null,
      rows: null,
      duration: 0,
      firstCommand: null
    })
    // 有 header 没事件：尺寸照常显示
    assert.deepEqual(castProbeSummary(empty, ''), {
      invalid: false,
      cols: 80,
      rows: 24,
      duration: 0,
      firstCommand: null
    })
  })

  test('残缺数组不算事件（[1,2] 不能当时间用）', async () => {
    const { castTailDuration } = await load()
    assert.equal(castTailDuration([ev(1, 'o', 'a'), '[1,2]', '[9]', '[1,"r",[80,24]]'].join('\n')), 1)
  })
})
