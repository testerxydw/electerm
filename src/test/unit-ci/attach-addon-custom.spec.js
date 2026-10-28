const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

global.window = global.window || { xtermAddons: {} }
global.window.xtermAddons = global.window.xtermAddons || {}
// _bufferedWrite reads document.hidden for the hidden-window flush fast path
global.document = global.document || { hidden: false }

const loadModule = () => import('../../client/components/terminal/attach-addon-custom.js')

describe('terminal output truncation', () => {
  test('removes cursor operations after safe leading ANSI sequences', async () => {
    const { stripLeadingCursorOps } = await loadModule()
    const esc = String.fromCharCode(27)
    const safePrefix = `${esc}[?25l${esc}[31m${esc}[2J`
    const input = `${safePrefix}${esc}[50A${esc}8${esc}[uhello`

    assert.equal(stripLeadingCursorOps(input), `${safePrefix}hello`)
  })

  test('keeps a single oversized chunk within the character cap', async () => {
    const { truncateTerminalOutput } = await loadModule()
    const maxChars = 96
    const input = `old line\n${'x'.repeat(300)}`
    const result = truncateTerminalOutput(input, maxChars)

    assert.ok(result.output.length <= maxChars)
    assert.match(result.output, /output truncated/)
    assert.ok(result.output.endsWith('x'.repeat(20)))
    assert.ok(result.dropped > 0)
  })

  test('does not retain a partial multi-byte ESC sequence', async () => {
    const { truncateTerminalOutput } = await loadModule()
    const esc = String.fromCharCode(27)
    const maxChars = 80
    const input = `${'x'.repeat(200)}${esc}${'('.repeat(100)}Btail`
    const result = truncateTerminalOutput(input, maxChars)

    assert.ok(result.output.length <= maxChars)
    assert.match(result.output, /output truncated/)
    assert.ok(result.output.endsWith('tail'))
    assert.ok(!result.output.includes('(B'))
  })

  test('does not retain a partial ANSI string control sequence', async () => {
    const { truncateTerminalOutput } = await loadModule()
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    const maxChars = 80
    const input = `${'x'.repeat(200)}${esc}]0;${'y'.repeat(100)}${bel}tail`
    const result = truncateTerminalOutput(input, maxChars)

    assert.ok(result.output.length <= maxChars)
    assert.match(result.output, /output truncated/)
    assert.ok(result.output.endsWith('tail'))
    assert.ok(!result.output.includes('y'))
  })

  test('updates the addon buffer to the capped output', async () => {
    const { default: AttachAddonCustom } = await loadModule()
    const addon = new AttachAddonCustom({}, {})
    addon._maxBufferChars = 96
    addon._writeBuffer = [`old line\n${'z'.repeat(300)}`]
    addon._bufferChars = addon._writeBuffer[0].length

    addon._dropOldestUntil()

    assert.equal(addon._writeBuffer.length, 1)
    assert.equal(addon._bufferChars, addon._writeBuffer[0].length)
    assert.ok(addon._bufferChars <= addon._maxBufferChars)
    assert.match(addon._writeBuffer[0], /output truncated/)
  })
})

const makeAddon = async () => {
  const { default: AttachAddonCustom } = await loadModule()
  const written = []
  const addon = new AttachAddonCustom({ write: (s) => written.push(s) }, {})
  addon._sendData = () => {}
  return { addon, written }
}

describe('output suppression', () => {
  test('a second suppression replaces the first instead of overlapping', async () => {
    const { addon } = await makeAddon()
    const ended = []
    // keepalive-style short window, then the long shell-integration one
    addon.startOutputSuppression(200, () => ended.push('first'), true)
    addon.startOutputSuppression(1000, () => ended.push('second'), true)

    // the replaced window is released right away, the new one is still armed
    assert.deepEqual(ended, ['first'])

    await new Promise(resolve => setTimeout(resolve, 400))

    // the stale 200ms timer must NOT have ended the new window early
    assert.deepEqual(ended, ['first'])
    assert.equal(addon.outputSuppressed, true)

    addon.stopOutputSuppression(true)
    assert.deepEqual(ended, ['first', 'second'])
  })

  test('dispose releases a pending suppression callback', async () => {
    const { addon } = await makeAddon()
    let released = false
    addon.startOutputSuppression(10000, () => {
      released = true
    }, true)

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
  test('resolves once output stops', async () => {
    const { addon } = await makeAddon()
    addon._lastDataTime = Date.now()
    const quiet = addon.waitForOutputIdle({ idleMs: 100, timeoutMs: 2000 })
    const result = await quiet
    assert.equal(result, true)
  })

  test('times out instead of hanging while output keeps flowing', async () => {
    const { addon } = await makeAddon()
    const pusher = setInterval(() => {
      addon._lastDataTime = Date.now()
    }, 20)
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
    const socket = { readyState: 1 /* OPEN */, send: (s) => sent.push(s) }
    const { term, state } = makeTerm(line)
    const addon = new AttachAddonCustom(term, socket)
    addon._sendData = () => {}
    return { addon, sent, state, term }
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

      // _startKeepalive() clears before arming, so a repeat enable leaves
      // exactly one live timer rather than stacking a second one.
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
      assert.deepEqual(sent, [], 'a newline would run the half-typed command')

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

      addon.stopOutputSuppression() // end the first keepalive's echo suppression
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
      // A wrapped line puts the cursor on a later row; the baseline row no
      // longer matches, which is what a long typed command looks like.
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
      assert.deepEqual(sent, [], 'a newline there inserts a line or pages forward')
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
      assert.deepEqual(sent, [], 'a newline would submit an empty password')
    } finally {
      addon.dispose()
    }
  })

  test('binary input is forwarded instead of throwing', async () => {
    const { addon } = await makeKeepaliveAddon({ line: '$ ' })
    const forwarded = []
    addon._sendData = (data) => forwarded.push(data)
    try {
      // Mouse report in the default (X10) encoding, which xterm delivers
      // through terminal.onBinary as a Uint8Array.
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
})

// TUI apps (vim/htop/Ink) repaint incrementally inside the alternate screen
// buffer and assume every byte reaches the terminal — dropping any frame
// corrupts the screen. While the alternate screen is active the addon must
// bypass write coalescing/dropping entirely (upstream electerm behaviour).
describe('alternate screen lossless direct write', () => {
  const esc = String.fromCharCode(27)

  describe('findAltBufferSwitch', () => {
    test('detects enter for all three private-mode forms', async () => {
      const { findAltBufferSwitch } = await loadModule()
      for (const n of ['47', '1047', '1049']) {
        const r = findAltBufferSwitch(`abc${esc}[?${n}h`)
        assert.equal(r.swType, 'enter', n)
        assert.equal(r.swOffset, 3, n)
        assert.equal(r.tailStart, -1, n)
      }
    })

    test('takes the last switch when a chunk holds several', async () => {
      const { findAltBufferSwitch } = await loadModule()
      const input = `${esc}[?1049hxx${esc}[?1049l`
      const r = findAltBufferSwitch(input)
      assert.equal(r.swType, 'exit')
      assert.equal(r.swOffset, 10)
    })

    test('ignores non-private, unrelated and reset forms', async () => {
      const { findAltBufferSwitch } = await loadModule()
      assert.equal(findAltBufferSwitch(`${esc}[1049h`).swType, null, 'no ? marker')
      assert.equal(findAltBufferSwitch(`${esc}[?1048h`).swType, null, '1048 is cursor save')
      assert.equal(findAltBufferSwitch(`${esc}[?25l${esc}[?2004h`).swType, null, 'bracketed paste')
      assert.equal(findAltBufferSwitch('plain text').swType, null)
    })

    test('skips OSC string bodies containing switch-like text', async () => {
      const { findAltBufferSwitch } = await loadModule()
      const bel = String.fromCharCode(7)
      const input = `${esc}]0;fake?1049h${bel}${esc}[?1049h`
      const r = findAltBufferSwitch(input)
      assert.equal(r.swType, 'enter')
      assert.equal(r.swOffset, input.lastIndexOf(`${esc}[?1049h`))
    })

    test('reports a truncated trailing sequence as tailStart', async () => {
      const { findAltBufferSwitch } = await loadModule()
      assert.deepEqual(findAltBufferSwitch(`${esc}[?1049`), {
        swType: null, swOffset: -1, tailStart: 0
      })
      assert.deepEqual(findAltBufferSwitch(`ok${esc}[?10`), {
        swType: null, swOffset: -1, tailStart: 2
      })
    })
  })

  test('writes directly once the alternate screen is active', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._enqueueWrite(`${esc}[?1049hFRAME1`)
      assert.deepEqual(written, [`${esc}[?1049hFRAME1`], 'flushed synchronously, no coalescing')
      assert.equal(addon._altBufferActive, true)

      written.length = 0
      addon._enqueueWrite('FRAME2')
      assert.deepEqual(written, ['FRAME2'], 'next chunk also bypasses the buffer')
      assert.equal(addon._writeBuffer.length, 0)
    } finally {
      addon.dispose()
    }
  })

  test('the 2MB drop never applies inside the alternate screen', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._enqueueWrite(`${esc}[?1049h`)
      written.length = 0
      addon._maxBufferChars = 100
      addon._enqueueWrite('x'.repeat(5000))
      assert.equal(addon._droppedChars, 0, 'no frame may be dropped')
      assert.equal(written[0].length, 5000)
    } finally {
      addon.dispose()
    }
  })

  test('flushes buffered normal-screen residue before the first alternate bytes', async () => {
    const { addon, written } = await makeAddon()
    try {
      // simulate a burst in progress: the chunk lands inside the 16ms window
      addon._lastFlushTime = Date.now()
      addon._enqueueWrite('NORMAL')
      assert.deepEqual(written, [], 'residue still coalescing')

      addon._enqueueWrite(`${esc}[?1049hALT`)
      assert.deepEqual(written, ['NORMAL', `${esc}[?1049hALT`])
      assert.equal(addon._altBufferActive, true)
    } finally {
      addon.dispose()
    }
  })

  test('switches back to coalescing on exit', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._enqueueWrite(`${esc}[?1049hA`)
      addon._enqueueWrite(`${esc}[?1049lB`)
      assert.equal(addon._altBufferActive, false)
      // "B" went through the coalescing path inside the burst window
      assert.equal(addon._writeBuffer.join(''), `${esc}[?1049lB`)
      assert.deepEqual(written, [`${esc}[?1049hA`])
    } finally {
      addon.dispose()
    }
  })

  test('a truncated switch held back flips the mode when the next chunk completes it', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._enqueueWrite(`hello${esc}[?10`)
      assert.equal(addon._pendingTail, `${esc}[?10`)
      assert.equal(addon._altBufferActive, false)
      assert.deepEqual(written, ['hello'], 'body flushed, tail held')

      addon._enqueueWrite('49hFRAME')
      assert.equal(addon._altBufferActive, true, 'mode flipped only now')
      assert.equal(addon._pendingTail, '')
      assert.deepEqual(written, ['hello', `${esc}[?1049hFRAME`])
    } finally {
      addon.dispose()
    }
  })

  test('a held-back tail is flushed after the 200ms bail-out', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._lastFlushTime = Date.now()
      addon._enqueueWrite(`abc${esc}[?1`)
      assert.equal(addon._pendingTail, `${esc}[?1`)

      await new Promise(resolve => setTimeout(resolve, 300))

      assert.equal(addon._pendingTail, '', 'bail-out released the tail')
      assert.ok(written.includes(`${esc}[?1`), 'tail written on the current path')
      assert.ok(written.includes('abc'))
    } finally {
      addon.dispose()
    }
  })

  test('a tail over the cap is written out instead of being held', async () => {
    const { addon } = await makeAddon()
    try {
      addon._lastFlushTime = Date.now()
      addon._enqueueWrite(`x${esc}[?${'1'.repeat(5000)}`)
      assert.equal(addon._pendingTail, '', 'runaway tail must not be held')
      assert.equal(addon._pendingTailTimer, null, 'no bail-out timer armed')
      assert.ok(addon._writeBuffer.join('').startsWith(`x${esc}[?1`), 'written as-is')
    } finally {
      addon.dispose()
    }
  })

  test('dispose releases a pending tail and its timer', async () => {
    const { addon } = await makeAddon()
    addon._lastFlushTime = Date.now()
    addon._enqueueWrite(`a${esc}[?1`)
    assert.ok(addon._pendingTailTimer)
    addon.dispose()
    assert.equal(addon._pendingTailTimer, null)
    assert.equal(addon._pendingTail, '')
  })

  test('enter+exit inside one chunk keeps every byte, none dropped', async () => {
    const { addon, written } = await makeAddon()
    try {
      addon._enqueueWrite(`${esc}[?1049hA${esc}[?1049lB`)
      assert.equal(addon._altBufferActive, false)
      // split at the LAST switch: head ran on the old (normal) path, rest on
      // the new one; both reach the terminal, order preserved
      assert.ok(written.includes(`${esc}[?1049hA`))
      assert.equal(addon._writeBuffer.join(''), `${esc}[?1049lB`)
    } finally {
      addon.dispose()
    }
  })
})

describe('broadcast fanout (G1)', () => {
  const loadBroadcast = () => import('../../client/common/term-broadcast.js')

  // source 是主控，target 是广播目标；两侧都真实走 sendToServer → _sendData
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
      setBroadcastBlocked: k => {
        blocked.push('set:' + k)
        global.window.store.broadcast.blocked = k
      },
      clearBroadcastBlocked: () => {
        blocked.push('clear')
        global.window.store.broadcast.blocked = null
      }
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
    // 模拟 mirrorInput 打到目标时的深度
    target._broadcastDepth = 1
    target.sendToServer('z')
    assert.deepEqual(targetSent, ['z'], '目标本地只发一次')
    assert.equal(targetSent.length, 1, '没有回环复制')
  })
})
