const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../..')
const protocol = require('../../app/common/term-flow-protocol.json')
const ctrl = require('../../app/common/term-flow-control.js')
const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/client/common/term-flow.js'), 'utf8')

function literal (key) {
  const m = rendererSrc.match(new RegExp(`\\b${key}:\\s*'([^']+)'`))
  return m ? m[1] : null
}

function number (key) {
  const m = rendererSrc.match(new RegExp(`\\b${key}:\\s*(\\d+)`))
  return m ? Number(m[1]) : null
}

describe('term flow protocol SSOT', () => {
  test('renderer action names match the JSON protocol exactly', () => {
    for (const [key, value] of Object.entries(protocol.actions)) {
      assert.equal(literal(key), value, `action ${key} drifted`)
    }
    assert.equal(Object.keys(protocol.actions).length, 2)
  })

  test('renderer limits match the JSON protocol exactly', () => {
    for (const [key, value] of Object.entries(protocol.limits)) {
      assert.equal(number(key), value, `limit ${key} drifted`)
    }
    assert.deepEqual(ctrl.limits, protocol.limits)
  })

  test('window is below the xterm 50MB write-buffer hard limit', () => {
    assert.ok(protocol.limits.windowBytes < 50 * 1024 * 1024)
    assert.ok(protocol.limits.maxBatchBytes < protocol.limits.windowBytes)
    assert.ok(protocol.limits.resumeBytes < protocol.limits.windowBytes)
  })
})

describe('credit flow control state machine', () => {
  test('send/ack are byte-exact and never negative', () => {
    let s = ctrl.createCreditState()
    assert.equal(s.inflight, 0)
    assert.equal(s.paused, false)
    s = ctrl.applySend(s, 1000)
    assert.equal(s.inflight, 1000)
    s = ctrl.applyAck(s, 400)
    assert.equal(s.inflight, 600)
    s = ctrl.applyAck(s, 9999)
    assert.equal(s.inflight, 0)
  })

  test('invalid byte counts are ignored, not NaN-ed', () => {
    let s = ctrl.createCreditState()
    s = ctrl.applySend(s, -5)
    s = ctrl.applySend(s, NaN)
    s = ctrl.applySend(s, undefined)
    assert.equal(s.inflight, 0)
    s = ctrl.applySend(s, 10)
    s = ctrl.applyAck(s, NaN)
    assert.equal(s.inflight, 10)
  })

  test('pauses at the high water and resumes only after the low water', () => {
    const { windowBytes, resumeBytes } = ctrl.limits
    let s = ctrl.applySend(ctrl.createCreditState(), windowBytes)
    assert.equal(ctrl.shouldPause(s), true)
    s = ctrl.markPause(s, true, 1000)
    assert.equal(s.paused, true)
    assert.equal(s.pausedAt, 1000)
    // Still above the low water: stay paused (hysteresis).
    s = ctrl.applyAck(s, windowBytes - resumeBytes - 1)
    assert.equal(ctrl.shouldPause(s, 1001), true)
    // Down to the low water: resume.
    s = ctrl.applyAck(s, 1)
    assert.equal(ctrl.shouldPause(s, 1002), false)
  })

  test('a lost ACK cannot deadlock the session: pause times out', () => {
    let s = ctrl.applySend(ctrl.createCreditState(), ctrl.limits.windowBytes)
    s = ctrl.markPause(s, true, 0)
    assert.equal(ctrl.shouldPause(s, 0), true)
    assert.equal(ctrl.shouldPause(s, ctrl.limits.pauseTimeoutMs - 1), true)
    assert.equal(ctrl.shouldPause(s, ctrl.limits.pauseTimeoutMs), false)
  })
})

describe('renderer byte accounting', () => {
  test('bytesOf uses the same byte unit for binary frames and text', async () => {
    const { bytesOf } = await import('../../../src/client/common/term-flow.js')
    assert.equal(bytesOf(new ArrayBuffer(7)), 7)
    assert.equal(bytesOf(new Uint8Array(9)), 9)
    assert.equal(bytesOf('abc'), 3)
    assert.equal(bytesOf('中文'), 6)
    assert.equal(bytesOf(null), 0)
    assert.equal(bytesOf(undefined), 0)
  })
})
