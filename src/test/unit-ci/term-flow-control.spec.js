const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const flow = require('../../app/common/term-flow-control.js')

// 服务端 credit 流控状态机：字节记账 + 迟滞 + 暂停超时兜底。
// 这是协议层杜绝 xterm 50MB「write data discarded」的根 —— 消费跟不上时
// 暂停上游（PTY/ssh/serial pause），字节留在内核缓冲，绝不丢弃。
describe('terminal output credit flow control (server side)', () => {
  test('a fresh state has nothing in flight and is not paused', () => {
    const s = flow.createCreditState()
    assert.equal(s.inflight, 0)
    assert.equal(s.paused, false)
    assert.equal(s.pausedAt, 0)
  })

  test('applySend / applyAck track bytes, floored at zero', () => {
    let s = flow.createCreditState()
    s = flow.applySend(s, 100)
    assert.equal(s.inflight, 100)
    s = flow.applySend(s, 50)
    assert.equal(s.inflight, 150)
    s = flow.applyAck(s, 200)
    assert.equal(s.inflight, 0, 'ACK never drives inflight negative')
    s = flow.applyAck(s, 10)
    assert.equal(s.inflight, 0)
    // 非正/非有限字节被忽略，不污染记账
    s = flow.applySend(s, -5)
    assert.equal(s.inflight, 0)
    s = flow.applySend(s, 0)
    assert.equal(s.inflight, 0)
  })

  test('pauses when in-flight reaches the window, resumes at the resume floor (hysteresis)', () => {
    const win = flow.limits.windowBytes
    const resume = flow.limits.resumeBytes
    let s = flow.createCreditState()
    s = flow.applySend(s, win)
    assert.equal(flow.shouldPause(s), true, 'reaches the window -> pause')
    s = flow.markPause(s, true, 0)
    // 仍在窗口内：保持暂停
    s = flow.applyAck(s, win - resume - 1)
    assert.equal(flow.shouldPause(s, 0), true, 'still above the resume floor -> stay paused')
    // 跌到 resume floor 以下：可以恢复
    s = flow.applyAck(s, 1)
    assert.equal(flow.shouldPause(s, 0), false, 'dropped to the floor -> may resume')
  })

  test('a long pause times out and resumes rather than stalling forever (no data loss)', () => {
    let s = flow.createCreditState()
    s = flow.applySend(s, flow.limits.windowBytes)
    s = flow.markPause(s, true, 0)
    // 刚暂停：常规保持
    assert.equal(flow.shouldPause(s, 0), true)
    // ACK 可能永久丢失：超过 pauseTimeoutMs 后强制恢复发货，
    // 字节全部已在无损归档，宁可队列暂时超窗口也不能让会话看起来死机。
    const past = flow.limits.pauseTimeoutMs + 1
    assert.equal(flow.shouldPause(s, past), false, 'timeout fallback resumes the source')
  })

  test('markPause records the pause timestamp for hysteresis/timeout', () => {
    let s = flow.createCreditState()
    s = flow.markPause(s, true, 12345)
    assert.equal(s.paused, true)
    assert.equal(s.pausedAt, 12345)
    s = flow.markPause(s, false)
    assert.equal(s.paused, false)
    assert.equal(s.pausedAt, 0)
  })
})
