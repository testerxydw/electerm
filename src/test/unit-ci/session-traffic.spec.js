/**
 * Test: session-traffic — the single write point for per-tab ↑↓ rates.
 *
 * Pins:
 * 1. byte accounting covers string / ArrayBuffer / Blob-ish frames
 * 2. 500ms tick converts pending bytes to per-second rates into
 *    store.sessionInfoMap[tabId].traffic
 * 3. after 2 consecutive idle windows traffic zeroes and the timer stops
 * 4. stop() clears the timer; no tabId disables counting entirely
 */

process.env.NODE_ENV = 'development'

const { describe, test, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')

// node sandbox has no window; tracker writes window.store.sessionInfoMap
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}

let SessionTrafficTracker
let frameByteLength

beforeEach(async () => {
  if (!SessionTrafficTracker) {
    const mod = await import('../../client/common/session-traffic.js')
    SessionTrafficTracker = mod.default
    frameByteLength = mod.frameByteLength
  }
  window.store = { sessionInfoMap: {} }
})

describe('frameByteLength', () => {
  test('string counts UTF-16 code units, binary counts bytes', () => {
    assert.equal(frameByteLength('abc'), 3)
    assert.equal(frameByteLength(new ArrayBuffer(7)), 7)
    assert.equal(frameByteLength({ size: 9 }), 9)
    assert.equal(frameByteLength(null), 0)
  })
})

describe('SessionTrafficTracker', () => {
  let t
  beforeEach(() => {
    t = mock.timers
    t.enable({ apis: ['Date', 'setInterval'] })
  })
  afterEach(() => {
    t.reset()
  })

  test('tick writes per-second rates from pending bytes', () => {
    const tracker = new SessionTrafficTracker({ tabId: 'tab-1', intervalMs: 500 })
    tracker.countDown('x'.repeat(1000))
    tracker.countUp('y'.repeat(500))

    t.tick(500)
    const traffic = window.store.sessionInfoMap['tab-1'].traffic
    assert.equal(traffic.down, 2000, '1000 bytes in 0.5s = 2000 B/s')
    assert.equal(traffic.up, 1000, '500 bytes in 0.5s = 1000 B/s')

    tracker.stop()
  })

  test('rates accumulate across multiple chunks within one window', () => {
    const tracker = new SessionTrafficTracker({ tabId: 'tab-1' })
    tracker.countDown('a'.repeat(100))
    tracker.countDown(new ArrayBuffer(50))
    tracker.countDown({ size: 50 })

    t.tick(500)
    assert.equal(window.store.sessionInfoMap['tab-1'].traffic.down, 400)

    tracker.stop()
  })

  test('2 consecutive idle windows zero traffic and stop the timer', () => {
    const tracker = new SessionTrafficTracker({ tabId: 'tab-1' })
    tracker.countDown('a'.repeat(100))
    t.tick(500) // window 1: active -> rate written
    assert.ok(window.store.sessionInfoMap['tab-1'].traffic.down > 0)

    t.tick(500) // window 2: idle #1 -> still timer, traffic zeroed
    assert.equal(window.store.sessionInfoMap['tab-1'].traffic.down, 0)
    assert.ok(tracker.timer, 'timer still armed after idle window #1')

    t.tick(500) // window 3: idle #2 -> cleared + timer stopped
    assert.equal(tracker.timer, null, 'timer stopped after 2 idle windows')

    // reverse: writing after stop restarts the timer on next count
    tracker.countDown('b'.repeat(10))
    assert.ok(tracker.timer, 'counting again re-arms the timer')
    tracker.stop()
  })

  test('stop clears timer and pending bytes', () => {
    const tracker = new SessionTrafficTracker({ tabId: 'tab-1' })
    tracker.countUp('a'.repeat(100))
    tracker.stop()
    assert.equal(tracker.timer, null)
    assert.equal(tracker.pendingUp, 0)
    t.tick(2000)
    assert.equal(window.store.sessionInfoMap['tab-1'], undefined, 'no traffic written after stop')
  })

  test('no tabId disables counting entirely', () => {
    const tracker = new SessionTrafficTracker({ tabId: '' })
    tracker.countUp('a'.repeat(100))
    tracker.countDown('b'.repeat(100))
    assert.equal(tracker.pendingUp, 0)
    assert.equal(tracker.pendingDown, 0)
    assert.equal(tracker.timer, null)
  })
})
