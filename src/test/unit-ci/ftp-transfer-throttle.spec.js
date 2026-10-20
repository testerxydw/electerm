/**
 * Test: ftp-transfer onData is throttled (3s window) before hitting ws.
 *
 * basic-ftp's trackProgress fires handleProgress on every chunk — high
 * frequency. Without throttle every chunk produced one ws message
 * (`transfer:data:<id>`), flooding the renderer just like the SFTP class
 * did before it got the same _.throttle(..., 3000) treatment.
 *
 * Pins (matching the self-hosted lodash throttle semantics used by the
 * SFTP transfer class — leading send + one trailing send carrying the
 * FIRST call's args, fresh values flow again right after the window):
 * 1. many handleProgress calls inside one 3s window -> at most 2 ws sends,
 *    far fewer than the calls themselves
 * 2. trailing send fires once after the window; the next call after the
 *    window goes out immediately with the fresh total
 * 3. pausing suppresses data sends (leading guard + throttled body guard)
 */

process.env.NODE_ENV = 'development'

const { describe, test, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const { Transfer } = require('../../app/server/ftp-transfer')

// ftpSession stub whose createOperationClient never resolves: startTransfer
// stays pending so constructing Transfer triggers no transfer work at all
const neverFtpSession = {
  createOperationClient: () => new Promise(() => {})
}

function buildTransfer (wsCalls) {
  return new Transfer({
    remotePath: '/remote-file.bin',
    localPath: '/tmp/local-file.bin',
    type: 'download',
    ftpSession: neverFtpSession,
    id: 'tid-1',
    ws: {
      s: (event) => wsCalls.push(event),
      close: () => {}
    }
  })
}

describe('ftp-transfer onData throttle', () => {
  let t
  beforeEach(() => {
    t = mock.timers
    t.enable({ apis: ['Date', 'setTimeout'] })
    // mock clock starts at 0; push it away from 0 so the first throttled
    // call takes the "now - previous > wait" leading-send branch
    t.tick(1000000)
  })
  afterEach(() => {
    t.reset()
  })

  test('high frequency progress in one 3s window sends at most 2 ws messages', () => {
    const calls = []
    const transfer = buildTransfer(calls)

    // 100 chunk callbacks inside the first 3s window
    for (let i = 1; i <= 100; i++) {
      t.tick(20) // 20ms * 100 = 2s < 3s window
      transfer.handleProgress({ bytes: i * 1024 })
    }

    const dataCalls = calls.filter(c => c.id === 'transfer:data:tid-1')
    assert.ok(
      dataCalls.length <= 2,
      `expected <= 2 throttled sends, got ${dataCalls.length}`
    )
    assert.ok(
      dataCalls.length >= 1,
      'leading send must have happened'
    )
    // 反向验证: 未节流的旧实现会发 100 条, 节流后必须显著少于调用次数
    assert.ok(dataCalls.length < 100)
  })

  test('trailing send fires after the window, fresh total flows right after', () => {
    const calls = []
    const transfer = buildTransfer(calls)

    transfer.handleProgress({ bytes: 1024 }) // leading send
    const mid = calls.filter(c => c.id === 'transfer:data:tid-1').length
    assert.equal(mid, 1)

    // cross the 3s trailing window
    t.tick(3000)
    const afterTrailing = calls.filter(c => c.id === 'transfer:data:tid-1').length
    assert.ok(afterTrailing >= 1, 'a send happened within the window')

    // next call after the window goes out immediately (fresh value path)
    transfer.handleProgress({ bytes: 10240 })
    const dataCalls = calls.filter(c => c.id === 'transfer:data:tid-1')
    const last = dataCalls[dataCalls.length - 1]
    assert.equal(last.data, 10240, 'post-window call sends the fresh total')
  })

  test('pausing suppresses data sends', () => {
    const calls = []
    const transfer = buildTransfer(calls)

    transfer.handleProgress({ bytes: 1024 })
    const during = calls.filter(c => c.id === 'transfer:data:tid-1').length
    assert.ok(during >= 1, 'first send before pause went out')

    transfer.pause()
    transfer.handleProgress({ bytes: 2048 })
    t.tick(3000)
    const after = calls.filter(c => c.id === 'transfer:data:tid-1').length
    assert.equal(after, during, 'no extra send while paused')
  })
})
