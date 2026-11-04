// G2-3：cast 回放器（组件契约）
//
// 播放的"算"的部分（解析、单调时钟、命令拼接）在 cast-parser.js 里已有纯函数单测。
// 这个 spec 守的是组件里那些"错了不会报错、只会画出假画面"的决定：
// 尺寸不重排、输入事件不上屏、往回拖要清屏、渲染层不碰文件路径。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const JSX = path.join(__dirname, '../../client/components/terminal/cast-player.jsx')
const STYL = path.join(__dirname, '../../client/components/terminal/cast-player.styl')
const extra = require(path.join(__dirname, '../../../src/app/common/locales-extra.js'))

const src = () => fs.readFileSync(JSX, 'utf8')

describe('G2-3 回放器：画面真实性', () => {
  test('只读终端：disableStdin + 不挂 FitAddon（回放不该能输入，也不该随窗口重排）', () => {
    const s = src()
    assert.match(s, /disableStdin:\s*true/)
    assert.ok(!/FitAddon|fitAddon|\.fit\(/.test(s), '挂 fit 会把录制里已折行的内容挪位')
    assert.match(s, /cols:\s*header\.width/)
    assert.match(s, /rows:\s*header\.height/)
  })

  test('键盘输入事件不写进终端（录制时它没上屏，上屏就是假画面）', () => {
    const s = src()
    // term.write 只允许写 o 事件攒出来的 buf，或空录制那句提示
    const writes = [...s.matchAll(/term\.write\(([^)]*)\)/g)].map(m => m[1].trim())
    assert.ok(writes.length, '终端应该有写入')
    for (const w of writes) {
      assert.ok(
        w === 'buf' || w.startsWith("'\\x1b[90m'"),
        '不该把输入事件写进终端：term.write(' + w + ')'
      )
    }
    assert.match(s, /feedTyping\(ev\.data\)/)
  })

  test('往回拖 = 重置终端再重放（只往前写会留下后半段画面）', () => {
    const s = src()
    const seek = s.slice(s.indexOf('const seek'), s.indexOf('const stopRaf'))
    assert.ok(seek.includes('resetScreen()'), 'seek 未调用重置')
    assert.match(s, /term\.reset\(\)/)
    // 重置必须发生在"当前位置往前挪"的分支里，而不是无条件清屏
    assert.match(seek, /if \(target < clockRef\.current\) \{\s*\n\s*resetScreen\(\)/)
  })

  test('调度时间单调化（录制端乱序/倒流的秒不会让时钟倒退）', () => {
    assert.match(src(), /Math\.max\(prev, Math\.round\(ev\.at \* 1000\)\)/)
  })

  test('终端异步建好后按当前时钟补画（否则前几毫秒的事件永久丢失）', () => {
    const s = src()
    const build = s.slice(s.indexOf('term.open(boxRef.current)'))
    assert.ok(build.includes('pump(clockRef.current)'), 'open 后没有按当前位置补画')
  })

  test('终端就绪前不消费事件，就绪后将计数刷回界面（黑屏但进度走满的那个坑）', () => {
    const s = src()
    const pump = s.slice(s.indexOf('const pump = upto'), s.indexOf('const resetScreen'))
    // 未就绪就 return：idxRef/writtenRef 一推进，后面那次补画就从队尾开始，
    // 整段输出被记成"已写"却一帧没上屏
    assert.match(
      pump,
      /const term = termRef\.current[\s\S]{0,400}if \(!term\) \{\s*\n\s*return\s*\n\s*\}/,
      'pump 在终端未就绪时仍会消费事件')
    assert.ok(
      pump.indexOf('if (!term) {') < pump.indexOf('idxRef.current = i'),
      '未就绪的短路必须在推进 idx 之前')
    // 补画之后要 setTick/setCmd：播放可能在终端就绪前就走完，帧里那次 setTick
    // 记的是 0，不刷就是"画面有内容、data-cast-written 还是 0"
    const build = s.slice(s.indexOf('term.open(boxRef.current)'))
    assert.ok(build.includes('pump(clockRef.current)'), 'open 后没有补画')
    assert.match(build, /setTick\(\{ pos: clockRef\.current, written: writtenRef\.current \}\)/)
    assert.match(build, /setCmd\(cmdRef\.current\)/)
  })

  test('空录制可打开：给一句提示而不是黑屏', () => {
    assert.match(src(), /load\.empty/)
    assert.match(src(), /e\('castEmpty'\)/)
  })
})

describe('G2-3 回放器：数据来源与边界', () => {
  test('文件只经 runGlobalAsync("readRecording", 裸文件名) 取得（渲染层不拼路径）', () => {
    const s = src()
    assert.match(s, /runGlobalAsync\('readRecording', name\)/)
    assert.ok(!/require\(/.test(s), '渲染层组件不该 require 主进程模块')
    for (const bad of ['fs.', 'path.', 'sessionLogPath', 'readFile']) {
      assert.ok(!s.includes(bad), '渲染层不该出现 ' + bad)
    }
  })

  test('格式错误走 CastFormatError → 用户可读文案（不是白屏也不是堆栈）', () => {
    const s = src()
    assert.match(s, /err instanceof CastFormatError/)
    assert.match(s, /e\('castInvalidFile'\)/)
    assert.match(s, /Alert[\s\S]*type='error'/)
  })

  test('截断要提示（只回放了开头，不能让用户以为是全程）', () => {
    assert.match(src(), /load\.truncated/)
    assert.match(src(), /e\('castTruncated'\)/)
  })

  test('样式文件存在且被组件引入', () => {
    assert.ok(fs.existsSync(STYL), 'cast-player.styl 缺失')
    assert.match(src(), /import '\.\/cast-player\.styl'/)
  })

  test('CDP 自测用的 data-* 锚点齐全', () => {
    const s = src()
    for (const k of ['data-cast-pos', 'data-cast-written', 'data-cast-total', 'data-cast-playing', 'data-cast-speed', 'data-cast-cmd', 'data-cast-typed']) {
      assert.ok(s.includes(k), k + ' 锚点缺失')
    }
  })
})

describe('G2-3 回放器：文案 en / zh_cn 成对', () => {
  const keys = [
    'castReplay', 'castPlay', 'castPause', 'castEvents', 'castBadLines',
    'castEmpty', 'castTruncated', 'castInvalidFile', 'castCopyCommands', 'castCopyHint'
  ]
  test('每个 key 在 en 与 zh_cn 都有', () => {
    const missing = keys.filter(k => !(
      Object.prototype.hasOwnProperty.call(extra.en, k) &&
      Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    ))
    assert.deepEqual(missing, [], 'locales-extra 缺失: ' + missing.join(', '))
  })

  test('组件用到的 cast* key 全部在守护清单里（漏了就会显示驼峰原文）', () => {
    const used = [...src().matchAll(/\be\('(cast[A-Za-z]+)'\)/g)].map(m => m[1])
    const uncovered = [...new Set(used)].filter(k => !keys.includes(k))
    assert.deepEqual(uncovered, [], '未守护的 key: ' + uncovered.join(', '))
  })
})
