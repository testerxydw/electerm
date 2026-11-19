const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const flowProtocol = require('../../app/common/term-flow-protocol.json')

global.window = global.window || { xtermAddons: {} }
global.window.xtermAddons = global.window.xtermAddons || {}
// _flushWrites reads document.hidden for the hidden-window flush fast path
global.document = global.document || { hidden: false }

const loadModule = () => import('../../client/components/terminal/attach-addon-custom.js')

// A terminal whose write contract mirrors xterm's: the callback fires once the
// data has been "parsed". The lossless FIFO advances and ACKs only from this
// callback, so the mock must invoke it (synchronously, like xterm in practice).
const makeXtermLikeTerm = () => {
  const written = []
  let cbCount = 0
  const term = {
    write: (data, cb) => {
      written.push(data)
      if (cb) {
        cbCount += 1
        cb()
      }
    }
  }
  return { term, written, getCbCount: () => cbCount }
}

describe('output suppression', () => {
  const makeAddon = async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const written = []
    const addon = new AttachAddonCustom({ write: (s, cb) => { written.push(s); cb && cb() } }, {})
    // 单测同步喂数据：关掉 16ms 合批窗口，产品行为不变。
    addon._flushIntervalMs = 0
    addon._sendData = () => {}
    return { addon, written }
  }

  test('a second suppression replaces the first instead of overlapping', async () => {
    const { addon } = await makeAddon()
    const ended = []
    // keepalive-style short window, then the long shell-integration one
    addon.startOutputSuppression(200, () => ended.push('first'))
    addon.startOutputSuppression(1000, () => ended.push('second'))

    // the replaced window is released right away, the new one is still armed
    assert.deepEqual(ended, ['first'])

    await new Promise(resolve => setTimeout(resolve, 400))

    // the stale 200ms timer must NOT have ended the new window early
    assert.deepEqual(ended, ['first'])
    assert.equal(addon.outputSuppressed, true)

    addon.stopOutputSuppression()
    assert.deepEqual(ended, ['first', 'second'])
  })

  test('suppressed bytes are buffered, never discarded', async () => {
    const { addon, written } = await makeAddon()
    const consumed = []
    addon.addDataTap(s => consumed.push(s))
    addon.startOutputSuppression(1000)
    addon.writeToTerminal('hidden line one\n')
    addon.writeToTerminal('hidden line two\n')
    // 抑制期间不写屏、但每个字节都进 taps（不再静默吞）
    assert.deepEqual(written, [])
    // 两段各 16 字节（UTF-8 ASCII），补全口径：12 字符 + \n = 16。
    assert.equal(addon._suppressedBytes, 32)
    assert.deepEqual(consumed, ['hidden line one\n', 'hidden line two\n'])
    addon.stopOutputSuppression()
    // 窗口结束按序补写进 xterm，一个不少
    assert.deepEqual(written, ['hidden line one\n', 'hidden line two\n'])
    assert.equal(addon._droppedBytes, 0)
  })

  test('dispose releases a pending suppression callback', async () => {
    const { addon } = await makeAddon()
    let released = false
    addon.startOutputSuppression(10000, () => {
      released = true
    })
    addon.dispose()
    assert.equal(released, true)
    assert.equal(addon.suppressTimeout, null)
    assert.equal(addon.outputSuppressed, false)
  })

  test('onInitialData does not wait on a disposed addon', async () => {
    const { addon } = await makeAddon()
    let called = false
    addon.dispose()
    addon.onInitialData(() => {
      called = true
    })
    assert.equal(called, false)
  })
})

describe('waitForOutputIdle', () => {
  const makeAddon = async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const addon = new AttachAddonCustom({ write: (s, cb) => cb && cb() }, {})
    addon._flushIntervalMs = 0
    addon._sendData = () => {}
    return { addon }
  }

  test('resolves once output stops', async () => {
    const { addon } = await makeAddon()
    addon._lastDataTime = Date.now()
    const quiet = addon.waitForOutputIdle({ idleMs: 100, timeoutMs: 2000 })
    assert.equal(await quiet, true)
  })

  test('times out instead of hanging while output keeps flowing', async () => {
    const { addon } = await makeAddon()
    const pusher = setInterval(() => { addon._lastDataTime = Date.now() }, 20)
    const result = await addon.waitForOutputIdle({ idleMs: 400, timeoutMs: 300 })
    clearInterval(pusher)
    assert.equal(result, false)
  })

  test('resolves immediately once disposed', async () => {
    const { addon } = await makeAddon()
    const pending = addon.waitForOutputIdle({ idleMs: 500, timeoutMs: 5000 })
    addon.dispose()
    assert.equal(await pending, false)
  })
})

// The client half of session keepalive — the same switch the session
// toolbar heartbeat icon and the MCP set_electerm_terminal_keepalive tool
// drive. The server half (writing \n to the PTY) lives in session-server.js.
describe('session keepalive', () => {
  // Minimal terminal. xterm parses writes asynchronously and exposes the
  // parsed buffer through term.buffer.active, which the keepalive guard reads
  // back to see what is actually on the input line.
  const makeTerm = (text = '') => {
    const state = { text, row: 0, type: 'normal' }
    const term = {
      write: (data, cb) => { cb && cb() },
      buffer: {
        get active () {
          return {
            type: state.type,
            baseY: 0,
            cursorY: state.row,
            getLine: (row) => row === state.row
              ? { translateToString: () => state.text }
              : null
          }
        }
      }
    }
    return { term, state }
  }

  const makeKeepaliveAddon = async ({ line = '' } = {}) => {
    const { default: AttachAddonCustom } = await loadModule()
    const sent = []
    const acks = []
    const socket = {
      readyState: 1 /* OPEN */,
      send: (s) => {
        // 新协议的 output-ack 走同一条 ws，单元测试只关心 keepalive 帧，
        // 把 ACK 分流到 acks，避免污染 sent 断言。
        try {
          const m = JSON.parse(s)
          if (m && m.action === flowProtocol.actions.ack) {
            acks.push(m)
            return
          }
        } catch (_) {}
        sent.push(s)
      }
    }
    const { term, state } = makeTerm(line)
    const addon = new AttachAddonCustom(term, socket)
    addon._flushIntervalMs = 0
    addon._sendData = () => {}
    return { addon, sent, acks, state, term }
  }

  const goIdle = (addon) => {
    const idle = Date.now() - addon._keepaliveInterval - 1000
    addon._lastDataTime = idle
    addon._lastInputTime = idle
  }

  test('setKeepalive arms and disarms the interval, idempotently', async () => {
    const { addon } = await makeKeepaliveAddon()
    try {
      assert.equal(addon._keepaliveTimer, null, 'starts disarmed')
      addon.setKeepalive(true)
      assert.ok(addon._keepaliveTimer, 'enabling must arm the timer')
      addon.setKeepalive(true)
      assert.ok(addon._keepaliveTimer, 'still armed after a repeat enable')
      addon.setKeepalive(false)
      assert.equal(addon._keepaliveTimer, null, 'disabling must clear the timer')
      addon.setKeepalive(false)
      assert.equal(addon._keepaliveTimer, null, 'disabling twice is a no-op')
    } finally {
      addon.dispose()
    }
  })

  test('an idle session sends a keepalive frame over the socket', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [JSON.stringify({ action: 'keepalive' })])
    } finally {
      addon.dispose()
    }
  })

  test('a session that just produced output stays quiet', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      addon._lastDataTime = Date.now()
      addon._lastInputTime = Date.now()
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'recent output must suppress the keepalive')
    } finally {
      addon.dispose()
    }
  })

  test('a typed but unsubmitted command is never submitted by the keepalive', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      addon.sendToServer('rm -rf ./bu')
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'the probe waits for a provably clean line')
      addon.sendToServer('\r')
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [JSON.stringify({ action: 'keepalive' })], 'an empty line is safe again')
    } finally {
      addon.dispose()
    }
  })

  test('an erased or cancelled line lets the keepalive run again', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      addon.sendToServer('l')
      addon.sendToServer('\x7f')
      goIdle(addon)
      addon._checkKeepalive()
      assert.equal(sent.length, 1, 'backspaced back to an empty line')
      addon.sendToServer('\x1b[A') // history recall: line content unknown
      goIdle(addon)
      addon._checkKeepalive()
      assert.equal(sent.length, 1, 'a recalled command must not be submitted')
      addon.sendToServer('\x03')
      goIdle(addon)
      addon._checkKeepalive()
      assert.equal(sent.length, 2, 'Ctrl+C clears the line')
    } finally {
      addon.dispose()
    }
  })

  test('a cursor key on an empty prompt does not disable the keepalive', async () => {
    const { addon, sent, state } = await makeKeepaliveAddon({ line: '$ ' })
    try {
      addon.writeToTerminal('$ ') // the shell drew its prompt, nothing typed
      addon.sendToServer('\x1b[D') // Left arrow
      addon.sendToServer('\x7f'.repeat(8)) // and clear whatever might be left
      goIdle(addon)
      addon._checkKeepalive()
      assert.equal(sent.length, 1, 'the line is still empty, a newline is safe')
      assert.equal(state.text, '$ ')
    } finally {
      addon.dispose()
    }
  })

  test('a recalled command stays on the line even though no key typed it', async () => {
    const { addon, sent, state } = await makeKeepaliveAddon({ line: '$ ' })
    try {
      addon.writeToTerminal('$ ')
      addon.sendToServer('\x1b[A') // Up: readline recalls a whole command
      state.text = '$ rm -rf ./build'
      addon.writeToTerminal('rm -rf ./build\n')
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'a recalled command must not be submitted')
    } finally {
      addon.dispose()
    }
  })

  test('erasing a recalled command lets the keepalive run again', async () => {
    const { addon, sent, state } = await makeKeepaliveAddon({ line: '$ ' })
    try {
      addon.writeToTerminal('$ ')
      addon.sendToServer('\x1b[A')
      state.text = '$ rm -rf ./build'
      addon.writeToTerminal('\r$ rm -rf ./build')
      state.text = '$ ' // Ctrl+U: readline clears the line
      addon.sendToServer('\x15')
      addon.writeToTerminal('\r$ ')
      goIdle(addon)
      addon._checkKeepalive()
      assert.equal(sent.length, 1, 'the screen shows a bare prompt again')
    } finally {
      addon.dispose()
    }
  })

  test('no keepalive while the command wrapped onto another row', async () => {
    const { addon, sent, state } = await makeKeepaliveAddon({ line: '$ ' })
    try {
      addon.writeToTerminal('$ ')
      addon.sendToServer('echo ' + 'x'.repeat(200))
      state.row = 3
      state.text = 'xxxxxxxx'
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [])
    } finally {
      addon.dispose()
    }
  })

  test('no keepalive while a full-screen app owns the alternate screen', async () => {
    const { addon, sent, state } = await makeKeepaliveAddon({ line: '' })
    try {
      state.type = 'alternate' // vim / less / top
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'a full-screen app owns the escape traffic')
    } finally {
      addon.dispose()
    }
  })

  test('no keepalive while a password prompt is waiting', async () => {
    const { addon, sent } = await makeKeepaliveAddon({ line: 'Password: ' })
    try {
      addon.writeToTerminal('Password: ')
      assert.equal(addon._passwordPromptDetected, true)
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'an unreadable line means no probe')
    } finally {
      addon.dispose()
    }
  })

  test('binary input is forwarded instead of throwing', async () => {
    const { addon } = await makeKeepaliveAddon({ line: '$ ' })
    const forwarded = []
    addon._sendData = (data) => forwarded.push(data)
    try {
      const report = new Uint8Array([27, 91, 77, 32, 33, 33])
      assert.doesNotThrow(() => addon.sendToServer(report))
      assert.equal(forwarded.length, 1, 'the report must still reach the socket')
    } finally {
      addon.dispose()
    }
  })

  test('a session that just received input stays quiet', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      const idle = Date.now() - addon._keepaliveInterval - 1000
      addon._lastDataTime = idle
      addon._lastInputTime = Date.now()
      addon._checkKeepalive()
      assert.deepEqual(sent, [], 'recent input must suppress the keepalive')
    } finally {
      addon.dispose()
    }
  })

  test('no keepalive frame while the socket is not open', async () => {
    const { addon, sent } = await makeKeepaliveAddon()
    try {
      addon._socket.readyState = 3 /* CLOSED */
      goIdle(addon)
      addon._checkKeepalive()
      assert.deepEqual(sent, [])
    } finally {
      addon.dispose()
    }
  })

  test('dispose stops the keepalive timer', async () => {
    const { addon } = await makeKeepaliveAddon()
    addon.setKeepalive(true)
    assert.ok(addon._keepaliveTimer)
    addon.dispose()
    assert.equal(addon._keepaliveTimer, null)
  })

  // #4628: the keepalive used to have the server write '\n\r\x1b[K' into the
  // PTY - typing on the user's behalf. It now asks for a DSR round trip that
  // stays on the renderer side, so the bytes below never reach the shell.
  describe('keepalive DSR probe (#4628)', () => {
    const makeProbeAddon = async () => {
      const ctx = await makeKeepaliveAddon({ line: '$ ' })
      const writes = []
      const forwarded = []
      const write = ctx.term.write
      ctx.term.write = (data, cb) => {
        writes.push(data)
        return write(data, cb)
      }
      ctx.addon._sendData = (data) => forwarded.push(data)
      return { ...ctx, writes, forwarded }
    }

    const probeMsg = { data: JSON.stringify({ action: 'keepalive-probe', pid: 'p1' }) }

    test('an idle keepalive no longer hides output for 500ms', async () => {
      const { addon, sent } = await makeProbeAddon()
      try {
        addon.writeToTerminal('$ ')
        goIdle(addon)
        addon._checkKeepalive()
        assert.equal(sent.length, 1, 'the frame is still sent')
        assert.equal(addon.outputSuppressed, false,
          'nothing is echoed any more, so nothing needs hiding')
      } finally {
        addon.dispose()
      }
    })

    test('the probe writes the query into the terminal, not into the socket', async () => {
      const { addon, sent, writes, forwarded } = await makeProbeAddon()
      try {
        addon.onMsg(probeMsg)
        assert.deepEqual(writes, ['\x1b[5n'], 'DSR status query on the display stream')
        assert.equal(sent.length, 0, 'a probe is not user input')
        assert.equal(forwarded.length, 0)
      } finally {
        addon.dispose()
      }
    })

    test('the answer is swallowed and leaves no trace in the input tracking', async () => {
      const { addon, writes, forwarded } = await makeProbeAddon()
      try {
        addon.onMsg(probeMsg)
        const beforeInputTime = addon._lastInputTime
        addon.sendToServer('\x1b[0n')
        assert.equal(forwarded.length, 0, 'the reply must not be forwarded to the pty')
        assert.equal(addon._pendingInputUnknown, false,
          'a swallowed escape reply must not latch the unknown-line guard')
        assert.equal(addon._lastInputTime, beforeInputTime, 'it is not user activity')
        assert.equal(addon._dsrReplyExpected, false, 'one answer per query')
        assert.deepEqual(writes, ['\x1b[5n'], 'no second query for the same answer')
        // the window is closed: the same bytes are ordinary input again
        addon.sendToServer('\x1b[0n')
        assert.equal(forwarded.length, 1)
      } finally {
        addon.dispose()
      }
    })

    test('a reply that never arrives does not keep the swallow armed', async () => {
      const { addon, forwarded } = await makeProbeAddon()
      try {
        addon.onMsg(probeMsg)
        assert.equal(addon._dsrReplyExpected, true)
        await new Promise(resolve => setTimeout(resolve, 1100))
        assert.equal(addon._dsrReplyExpected, false, 'the window times out')
        addon.sendToServer('\x1b[0n')
        assert.equal(forwarded.length, 1, 'an app-private reply stays untouched')
      } finally {
        addon.dispose()
      }
    })

    test('two probes in flight write the query once', async () => {
      const { addon, writes } = await makeProbeAddon()
      try {
        addon.onMsg(probeMsg)
        addon.onMsg(probeMsg)
        assert.deepEqual(writes, ['\x1b[5n'], 'no pile-up while one answer is awaited')
      } finally {
        addon.dispose()
      }
    })

    test('dispose releases a pending probe window', async () => {
      const { addon } = await makeProbeAddon()
      addon.onMsg(probeMsg)
      addon.dispose()
      assert.equal(addon._dsrReplyTimer, null)
      assert.equal(addon._dsrReplyExpected, false)
    })

    test('the server side of the keepalive writes nothing to the pty', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../src/app/server/session-server.js'), 'utf8'
      )
      const handler = /if \(parsed\.action === 'keepalive'\) \{[\s\S]*?\n {14}\}/.exec(src)
      assert.ok(handler, 'keepalive handler exists')
      assert.ok(!src.includes("const wake = '\\n\\r\\x1b[K'"), 'the old wake bytes are gone')
      assert.ok(!/term(\.writeRaw|\.write)\(wake\)/.test(handler[0]), 'no pty write')
      assert.ok(handler[0].includes("action: 'keepalive-probe'"), 'the probe is delegated to the renderer')
    })
  })
})

// TUI apps (vim/htop/Ink) repaint incrementally and assume every byte reaches
// the terminal. The old design dropped frames past a 2MB cap and special-cased
// the alternate screen; the new design funnels everything through one lossless
// FIFO keyed on the term.write completion callback. These tests pin that.
describe('lossless output (FIFO)', () => {
  const makeLosslessAddon = async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const { term, written, getCbCount } = makeXtermLikeTerm()
    const acks = []
    const socket = {
      readyState: 1,
      send: (s) => {
        try {
          const m = JSON.parse(s)
          if (m && m.action === flowProtocol.actions.ack) acks.push(m)
        } catch (_) {}
      }
    }
    const addon = new AttachAddonCustom(term, socket)
    addon._flushIntervalMs = 0
    addon._sendData = () => {}
    return { addon, written, acks, getCbCount }
  }

  test('every byte reaches the terminal, nothing dropped', async () => {
    const { addon, written } = await makeLosslessAddon()
    try {
      const payload = 'line of output\n'.repeat(2000) // ~32KB
      addon.writeToTerminal(payload)
      assert.equal(addon._droppedBytes, 0)
      assert.equal(written.join(''), payload, 'exact byte-for-byte delivery')
      assert.equal(addon._ackedBytes, Buffer.byteLength(payload))
      assert.equal(addon._writeInFlight, false, 'FIFO drains, no stall')
    } finally {
      addon.dispose()
    }
  })

  test('the completion callback is what advances the FIFO (I-1)', async () => {
    const { addon } = await makeLosslessAddon()
    try {
      // 模拟「回调被吞」的最坏场景：term.write 不触发 cb（高亮 wrapper 漏传
      // 第二个参数即此情形）。FIFO 必须在首批后冻结 —— 这正是此前整链停摆的根因。
      let blocked = true
      let capturedCb = null
      const realTerm = {
        write: (data, cb) => {
          if (!blocked) {
            cb && cb()
          } else {
            capturedCb = cb // 把在途批次的完成回调抓出来，稍后手动放行
          }
        }
      }
      addon.term = realTerm
      addon.writeToTerminal('first batch\n')
      assert.equal(addon._writeInFlight, true, 'first batch in flight (cb held back)')
      assert.equal(addon._pending.length, 0)
      // 回调未回 → 后续输出只能积压（冻结的真正表现）
      addon.writeToTerminal('second batch\n')
      assert.ok(addon._pending.length > 0, 'subsequent output queued while stalled')
      // 若回调永远不回（高亮 wrapper 的 bug 复现），FIFO 会在此永久冻结。
      // 放行回调：FIFO 应继续推进并补写积压，一个不少；ackedBytes 收敛到全量。
      blocked = false
      assert.ok(capturedCb, 'the in-flight onDone callback was captured')
      capturedCb()
      assert.equal(addon._writeInFlight, false, 'advances past the stalled batch')
      assert.equal(addon._pending.length, 0, 'queued output fully flushed')
      // 12 字节(first batch\n) + 13 字节(second batch\n) 经回调路径全部消费
      assert.equal(addon._ackedBytes, 25, 'both batches consumed via the completion callback')
    } finally {
      addon.dispose()
    }
  })

  test('the batch cap splits huge flushes but delivers everything (I-3b)', async () => {
    const { addon, written } = await makeLosslessAddon()
    try {
      addon._maxFlushBytes = 100 // 强制分多批
      const payload = 'x'.repeat(2000)
      addon.writeToTerminal(payload)
      assert.equal(addon._droppedBytes, 0)
      assert.equal(written.join(''), payload, 'all 2000 bytes delivered across batches')
      assert.equal(addon._ackedBytes, 2000)
      assert.equal(addon._writeInFlight, false, 'no deadlock')
    } finally {
      addon.dispose()
    }
  })

  test('an empty (decoder held-back) frame still ACKs its bytes', async () => {
    const { addon, acks, written } = await makeLosslessAddon()
    try {
      // 模拟 TextDecoder 暂存了半截多字节字符：解码得到空串但字节已计入。
      addon.writeToTerminal(Buffer.from([0xe4])) // 半个 UTF-8 汉字首字节
      // 空串分支：直接 ACK，不写屏（字节在 decoder 内，下一批补齐）
      assert.equal(addon._ackedBytes, 1)
      assert.equal(written.length, 0)
      assert.deepEqual(acks.map(a => a.n), [1])
    } finally {
      addon.dispose()
    }
  })

  test('dispose with queued output does not throw and clears state', async () => {
    const { addon, written } = await makeLosslessAddon()
    addon.writeToTerminal('a'.repeat(50))
    addon.dispose()
    assert.equal(addon._pending.length, 0)
    assert.equal(addon._writeInFlight, false)
    assert.ok(written.join('').length >= 50)
  })

  test('100 consecutive batches all drain with no stall (I-2)', async () => {
    const { addon, written } = await makeLosslessAddon()
    try {
      const n = 100
      let total = 0
      const expected = []
      for (let i = 0; i < n; i++) {
        const s = `batch ${i}\n`
        expected.push(s)
        total += Buffer.byteLength(s)
        addon.writeToTerminal(s)
      }
      assert.equal(addon._droppedBytes, 0)
      assert.equal(addon._pending.length, 0, 'FIFO fully drained')
      assert.equal(addon._writeInFlight, false, 'no stall')
      assert.equal(addon._ackedBytes, total, 'every batch ACKed')
      assert.equal(written.join(''), expected.join(''), 'exact byte-for-byte delivery')
    } finally {
      addon.dispose()
    }
  })

  test('an 8MB flood is delivered in full, never dropped (I-4)', async () => {
    const { addon, written } = await makeLosslessAddon()
    try {
      const payload = 'x'.repeat(8 * 1024 * 1024)
      addon.writeToTerminal(payload)
      assert.equal(addon._droppedBytes, 0, 'no byte lost under a heavy flood')
      assert.equal(written.join(''), payload, 'all 8MB byte-for-byte')
      assert.equal(addon._ackedBytes, 8 * 1024 * 1024)
      assert.equal(addon._writeInFlight, false)
      assert.equal(addon._pending.length, 0)
    } finally {
      addon.dispose()
    }
  })

  test('a remote-printed JSON string with an action is not swallowed (I-6)', async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const { term, written } = makeXtermLikeTerm()
    const socket = {
      readyState: 1,
      send: () => {}
    }
    // 用 '' 构造（不建 trafficTracker/recorder），事后补 infoTabId 以真正走
    // handleSessionControlMessage 分支，验证「远端打印的 JSON 不被误吞」。
    const addon = new AttachAddonCustom(term, socket)
    addon.infoTabId = 'tab-1'
    addon._flushIntervalMs = 0
    addon._sendData = () => {}
    global.window.store = { sessionInfoMap: {} }
    try {
      // 远端把一段合法 JSON 当普通终端输出打印（不是控制消息）：必须落到屏幕。
      addon.onMsg({ data: JSON.stringify({ action: 'foo', value: 1 }) })
      assert.deepEqual(written, [JSON.stringify({ action: 'foo', value: 1 })],
        'arbitrary-action JSON still displayed, not swallowed')
      // 即使是 ssh-handshake-info，但没有 update 字段，也不是控制消息，照样显示
      written.length = 0
      addon.onMsg({ data: JSON.stringify({ action: 'ssh-handshake-info' }) })
      assert.deepEqual(written, [JSON.stringify({ action: 'ssh-handshake-info' })],
        'handshake-info without update is still ordinary output')
    } finally {
      addon.dispose()
      global.window.store = undefined
    }
  })

  test('a term.write that throws is retried, never dropped (I-7)', async () => {
    const { addon } = await makeLosslessAddon()
    try {
      // 复现 xterm 写缓冲抛错（"write data discarded, use flow control..."）的
      // 最坏情形：首批 term.write 抛错，FIFO 必须把整批原样回队退避重试。
      let calls = 0
      const realTerm = {
        write: (data, cb) => {
          calls += 1
          if (calls === 1) {
            throw new Error('simulated xterm write-buffer discard')
          }
          cb && cb()
        }
      }
      addon.term = realTerm
      addon.writeToTerminal('recover me\n')
      assert.equal(addon._droppedBytes, 0, 'nothing dropped on the throw')
      assert.ok(addon._pending.length > 0 || addon._writeInFlight, 'batch held, not lost')
      // 等退避重发（catch 分支 setTimeout(_pump, 100)）
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(addon._droppedBytes, 0)
      assert.equal(addon._writeInFlight, false, 'recovered and drained')
      assert.equal(addon._pending.length, 0)
      assert.equal(addon._ackedBytes, Buffer.byteLength('recover me\n'), 'recovered batch fully ACKed')
      assert.equal(calls, 2, 'retried exactly once then succeeded')
    } finally {
      addon.dispose()
    }
  })
})

// The KeywordHighlighterAddon wraps term.write. The lossless FIFO relies on the
// write-completion callback to advance and ACK; if the wrapper drops the second
// argument the terminal freezes after the first batch. These tests pin that the
// wrapper forwards the callback (and degrades safely when highlighting throws).
describe('highlight addon forwards the write callback', () => {
  const loadHighlight = () => import('../../client/components/terminal/highlight-addon.js')

  const makeMockTerm = () => {
    const written = []
    let cbCount = 0
    const term = { displayRaw: false }
    term.write = (data, cb) => {
      written.push(data)
      if (cb) { cbCount += 1; cb() }
    }
    return { term, written, getCbCount: () => cbCount }
  }

  test('the wrapper forwards the completion callback on every branch (I-1)', async () => {
    const { KeywordHighlighterAddon } = await loadHighlight()
    const { term, getCbCount } = makeMockTerm()
    const addon = new KeywordHighlighterAddon([])
    addon.activate(term)
    // 普通文本、含 DCS、displayRaw、二进制 四条路径都应把 cb 透传。
    term.write('hello world', () => {})
    assert.equal(getCbCount(), 1, 'plain text forwards cb')
    term.displayRaw = true
    term.write('\x1b[31mred\x1b[0m', () => {})
    assert.equal(getCbCount(), 2, 'displayRaw branch forwards cb')
    term.displayRaw = false
    term.write('', () => {})
    assert.equal(getCbCount(), 3, 'empty string still invokes cb')
  })

  test('highlightChunk throwing falls back to raw write with cb (I-3a)', async () => {
    const { KeywordHighlighterAddon } = await loadHighlight()
    const { term, written, getCbCount } = makeMockTerm()
    const addon = new KeywordHighlighterAddon([])
    addon.activate(term)
    // 让 highlightChunk 抛错：必须退回原始写且不吞回调，否则 FIFO 冻结。
    const orig = addon.highlightChunk
    addon.highlightChunk = () => { throw new Error('boom') }
    let cbFired = false
    term.write('payload that must survive', () => { cbFired = true })
    assert.equal(cbFired, true, 'callback still fires on the fallback path')
    assert.equal(getCbCount(), 1)
    // 退回路写的是原始数据，未被高亮改写（高亮失败不应丢字节）
    assert.equal(written[0], 'payload that must survive')
    addon.highlightChunk = orig
  })

  test('a wrapper missing the callback still writes (does not freeze)', async () => {
    const { KeywordHighlighterAddon } = await loadHighlight()
    const { term, written } = makeMockTerm()
    const addon = new KeywordHighlighterAddon([])
    addon.activate(term)
    // 复原一个「吞回调」的坏 wrapper，验证 attach addon 的看门狗/重试能兜底：
    // 这里只验证高亮层不抛、数据能写出；FIFO 层冻结由 attach-addon 用例覆盖。
    term.write = (data) => { written.push(data) } // 无 cb
    let threw = false
    try { addon.highlightChunk = () => data => data; term.write('x') } catch (_) { threw = true }
    assert.equal(threw, false)
    assert.ok(written.length >= 1)
  })
})

describe('broadcast fanout (G1)', () => {
  const loadBroadcast = () => import('../../client/common/term-broadcast.js')

  const makeFanout = async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const { registerBroadcastAddon, resetBroadcastAddons } = await loadBroadcast()
    resetBroadcastAddons()
    const localSent = []
    const targetSent = []
    const blocked = []
    const source = new AttachAddonCustom({ write: () => {} }, {})
    source.infoTabId = 'src'
    source._sendData = d => { localSent.push(d) }
    const target = new AttachAddonCustom({ write: () => {} }, {})
    target.infoTabId = 'dst'
    target._sendData = d => { targetSent.push(d) }
    registerBroadcastAddon('src', source)
    registerBroadcastAddon('dst', target)
    global.window.store = {
      broadcast: {
        on: true,
        sourceTabId: 'src',
        targets: [{ tabId: 'dst', title: 'dst', isProduction: false }],
        blocked: null
      },
      setBroadcastBlocked: k => { blocked.push('set:' + k); global.window.store.broadcast.blocked = k },
      clearBroadcastBlocked: () => { blocked.push('clear'); global.window.store.broadcast.blocked = null }
    }
    return { source, target, localSent, targetSent, blocked }
  }

  test('mirrors normal input to every target once', async () => {
    const { source, localSent, targetSent } = await makeFanout()
    source.sendToServer('l')
    source.sendToServer('s')
    source.sendToServer('\r')
    assert.deepEqual(localSent, ['l', 's', '\r'], '主控本地照常发送')
    assert.deepEqual(targetSent, ['l', 's', '\r'], '目标各收到一份，且无二次扇出')
  })

  test('password input is withheld, and Enter clears the gate', async () => {
    const { source, targetSent, blocked } = await makeFanout()
    source._passwordPromptDetected = true
    try {
      source.sendToServer('s')
      source.sendToServer('e')
      assert.deepEqual(targetSent, [], '密码字符不得离开主控')
      assert.ok(blocked.includes('set:password'), '红条进入"已暂停"')
      source.sendToServer('\r')
      assert.deepEqual(targetSent, [], '提交密码的回车同样不镜像')
      assert.equal(global.window.store.broadcast.blocked, null, '回车后闸门必须解除')
      source.sendToServer('x')
      assert.deepEqual(targetSent, ['x'], '密码结束后镜像恢复')
    } finally {
      source.dispose()
    }
  })

  test('terminal replies (OSC/DCS) are never mirrored', async () => {
    const { source, targetSent } = await makeFanout()
    const esc = String.fromCharCode(27)
    source.sendToServer(`${esc}]10;rgb:0000/0000/0000${String.fromCharCode(7)}`)
    source.sendToServer(`${esc}P1$r0m${esc}\\`)
    assert.deepEqual(targetSent, [], 'OSC/DCS 应答是终端内部协商，不得打到目标机')
  })

  test('a mirrored send does not fan out again (depth guard)', async () => {
    const { target, targetSent } = await makeFanout()
    target._broadcastDepth = 1
    target.sendToServer('z')
    assert.deepEqual(targetSent, ['z'], '目标本地只发一次')
    assert.equal(targetSent.length, 1, '没有回环复制')
  })
})

describe('archive replay', () => {
  const makeReplayAddon = async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const written = []
    const term = {
      write: (data, cb) => {
        written.push(data)
        cb && cb()
      }
    }
    const socket = { readyState: 1, send: () => {}, binaryType: 'arraybuffer' }
    const addon = new AttachAddonCustom(term, socket)
    addon._flushIntervalMs = 0
    if (!addon.decoder) {
      addon.decoder = new TextDecoder('utf-8')
    }
    return { addon, written }
  }

  test('replayArchive writes bytes through the FIFO, stripped and counted', async () => {
    const { addon, written } = await makeReplayAddon()
    const esc = String.fromCharCode(27)
    // 含 shell 集成 OSC 133/633 的输出：回放应剥掉它们，只留可读文本
    const payload = 'hello world\r\n' + esc + ']133;C' + esc + '\\' + 'next line'
    const res = await addon.replayArchive(new TextEncoder().encode(payload))
    assert.equal(res.ok, true)
    const joined = written.join('')
    assert.ok(joined.includes('hello world'), '普通文本保留')
    assert.ok(joined.includes('next line'), 'OSC 后的文本保留')
    assert.ok(!joined.includes(']133;'), 'OSC 133 已被剥离')
    // 账本：received 计入回放字节；OSC 被剥后 fed < 原始字节数
    assert.equal(res.fed, joined.length)
    assert.ok(res.fed < payload.length, 'OSC 序列被剥掉，fed 小于原始长度')
    assert.equal(addon._droppedBytes, 0, '回放不产生解码丢失')
  })

  test('replayArchive is rejected while already replaying', async () => {
    const { addon } = await makeReplayAddon()
    addon._replaying = true
    const res = await addon.replayArchive(new TextEncoder().encode('x'))
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'busy')
  })

  test('replayArchive empty input short-circuits', async () => {
    const { addon } = await makeReplayAddon()
    const res = await addon.replayArchive(new Uint8Array(0))
    assert.equal(res.ok, false)
  })
})
