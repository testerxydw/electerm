#!/usr/bin/env node
/**
 * #4628 保活改 DSR 探针 —— CDP 实机回归
 *
 * 钉的是三件事：
 *   A) 保活往返一个字节都不进 PTY（旧实现往 PTY 写 '\n\r\x1b[K'，等于替用户按键）；
 *   B) 探针本身还活着：渲染层收到 keepalive-probe 后把 ESC[5n 写进 xterm 显示流，
 *      xterm 的 ESC[0n 应答在出口被吞掉，不会变成 PTY 输入；
 *   C) 吞应答不会把 `_pendingInputUnknown` 钉住（一旦钉住，之后所有保活都被静音），
 *      也不会再开 500ms 的输出抑制窗口（旧实现吞掉真输出的那个窗口）。
 * 另外两条现场判据：真的挂一个 `while read` 循环，看空闲期有没有莫名出现的 GOT 行；
 * 以及半截命令（没回车）期间探针必须按住不写。
 *
 * 用法：
 *   1) npm run vite-build && cp -r src/app/. work/app/
 *   2) D=$(mktemp -d /tmp/electerm-ka-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/keepalive-dsr-probe-demo.js 9333 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'keepalive-dsr-probe-shots')
const ESC = String.fromCharCode(27)

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
  }).on('error', reject)
})

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString())
      if (m.id === undefined) {
        return
      }
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      throw new Error('screenshot failed')
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return path.basename(file)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.eval(expr)) {
      return true
    }
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return false
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}
const skip = (name, detail) => {
  console.log('SKIP  ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 只开一个本地终端页签，拿到它的 addon
const SETUP = `(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'KA-probe', batch: 0 })
  window.__k = { id: store.tabs[store.tabs.length - 1].id }
  store.changeActiveTabId(window.__k.id)
  return JSON.stringify(window.__k)
})()`

const READY = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const addon = inst && inst.attachAddon
  return !!(addon && !addon.disposed && addon.term && addon._socket && addon._socket.readyState === 1)
})()`

// 间谍：三条出口/入口流分别计数。
//  - _sendData 是渲染层交给服务端的"字节"，服务端原样写进 PTY ⇒ 这就是键盘流；
//  - socket.send 只承载 JSON 控制帧 ⇒ 用来看 keepalive 往返有没有发生；
//  - term.write 是显示流 ⇒ ESC[5n 必须只出现在这里。
// 原始方法挂在实例上，重复安装只重置计数，不叠第二层包装。
const INSTALL = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const addon = inst && inst.attachAddon
  if (!addon || !addon.term) return 'no-terminal'
  if (!addon.__rawSendData) addon.__rawSendData = addon._sendData
  if (!addon.__rawWrite) addon.__rawWrite = addon.term.write
  if (!addon.__rawSockSend) addon.__rawSockSend = addon._socket.send
  if (!addon.__rawSuppress) addon.__rawSuppress = addon.startOutputSuppression
  window.__spy = { dataOut: [], frames: [], dsrWrites: 0, suppress: 0 }
  const note = () => {
    window.__spy.dataOut = []
    window.__spy.frames = []
    window.__spy.dsrWrites = 0
    window.__spy.suppress = 0
  }
  window.__note = note
  addon._sendData = function (d) {
    const s = typeof d === 'string' ? d : Array.from(d).map(b => String.fromCharCode(b)).join('')
    window.__spy.dataOut.push(s)
    return addon.__rawSendData.call(addon, d)
  }
  addon.term.write = function (s) {
    if (typeof s === 'string' && s.indexOf('\\u001b[5n') >= 0) window.__spy.dsrWrites++
    return addon.__rawWrite.call(addon.term, s)
  }
  addon._socket.send = function (m) {
    if (typeof m === 'string' && m.indexOf('keepalive') >= 0) window.__spy.frames.push(m)
    return addon.__rawSockSend.call(addon._socket, m)
  }
  addon.startOutputSuppression = function () {
    window.__spy.suppress++
    return addon.__rawSuppress.apply(addon, arguments)
  }
  note()
  return 'installed'
})()`

// 保活是手动开关（工具栏心跳图标 / MCP），默认不开 —— 实机验必须先打开。
const ENABLE = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  if (!inst || typeof inst.setKeepalive !== 'function') return 'no-inst'
  const on = inst.setKeepalive(true)
  const addon = inst.attachAddon
  return JSON.stringify({ on, timer: !!addon._keepaliveTimer, interval: addon._keepaliveInterval })
})()`

const SPY = `JSON.stringify({
  dataOut: window.__spy.dataOut.map(s => s.replace(/\\u001b/g, '<ESC>')),
  dataOutChars: window.__spy.dataOut.reduce((n, s) => n + s.length, 0),
  keepaliveFrames: window.__spy.frames.length,
  dsrWrites: window.__spy.dsrWrites,
  suppress: window.__spy.suppress,
  pendingLength: window.refs.get('term-' + window.__k.id).attachAddon._pendingInputLength,
  pendingUnknown: window.refs.get('term-' + window.__k.id).attachAddon._pendingInputUnknown,
  dsrExpected: window.refs.get('term-' + window.__k.id).attachAddon._dsrReplyExpected
})`

const BUF = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const b = inst && inst.term && inst.term.buffer.active
  if (!b) return ''
  const out = []
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i)
    if (line) out.push(line.translateToString(true))
  }
  return out.join('\\n')
})()`

const send = (cdp, text) => cdp.eval(`(() => {
  const addon = window.refs.get('term-' + window.__k.id).attachAddon
  addon.sendToServer(${JSON.stringify(text)})
  return 'ok'
})()`)

const countOf = async (cdp, needle) => {
  const buf = await cdp.eval(BUF)
  return String(buf || '').split(needle).length - 1
}

const countLines = async (cdp, re) => {
  const buf = await cdp.eval(BUF)
  return String(buf || '').split('\n').filter(l => re.test(l)).length
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready

  console.log('setup tab')
  await cdp.eval('(() => { if (!window.store || !window.refs) throw new Error(\'app not ready\') })()')
  console.log(await cdp.eval(SETUP))
  check('本地终端页签就绪，attachAddon 可用', await waitFor(cdp, READY, 'terminal ready', 30000))
  console.log(await cdp.eval(INSTALL))
  check('间谍安装成功（_sendData / term.write / socket.send / startOutputSuppression）', true)
  const ka = JSON.parse(await cdp.eval(ENABLE))
  check('保活开关已打开（默认关，心跳图标/MCP 才开）', ka.on === true && ka.timer === true, ka)

  // 等终端把提示符打出来，再清零，避免把开场的滚动输出算进窗口
  await sleep(2500)
  await cdp.eval('window.__note()')

  // ---- 1) 空闲窗口：保活往返发生，但 PTY 一个字节都收不到 ----
  console.log('idle window 13s (>=2 keepalive cycles)')
  await sleep(13000)
  const idle = JSON.parse(await cdp.eval(SPY))
  check('空闲期渲染层发出 >=2 次 keepalive 控制帧', idle.keepaliveFrames >= 2, { keepaliveFrames: idle.keepaliveFrames })
  check('空闲期 ESC[5n 被写进 xterm 显示流 >=2 次（探针真的跑了）', idle.dsrWrites >= 2, { dsrWrites: idle.dsrWrites })
  check('空闲期交给服务端的字节流为空（旧实现这里是 \\n\\r<ESC>[K）', idle.dataOutChars === 0 && idle.dataOut.length === 0, idle.dataOut)
  check('ESC[0n 应答没有出现在键盘流里', !idle.dataOut.some(s => s === `${ESC}[0n`), idle.dataOut)
  check('探针窗口结束后 _dsrReplyExpected 回落 false（往返闭合，不会堆积）', idle.dsrExpected === false)
  check('保活不再开启输出抑制窗口（旧实现 startOutputSuppression(500)）', idle.suppress === 0, { suppress: idle.suppress })
  check('吞应答不会把 _pendingInputUnknown 钉住（钉住 = 之后保活全静音）', idle.pendingUnknown === false, { pendingUnknown: idle.pendingUnknown })
  await cdp.shot(path.join(SHOT_DIR, '01-idle-probe.png'))

  // ---- 2) 现场：while read 循环，空闲期不该出现 GOT 行 ----
  // 计数清零必须在启动命令自己落进键盘流之后 —— 命令回显里就带着 "GOT:"，
  // 按子串数会把那 1 次算成保活的锅，所以判据改成"整行匹配 ^GOT:"。
  await send(cdp, 'while read -r l; do echo "GOT:$l"; done\r')
  await sleep(1200)
  await cdp.eval('window.__note()')
  console.log('read loop idle 10s')
  await sleep(10000)
  const loopSpy = JSON.parse(await cdp.eval(SPY))
  const gotAfterIdle = await countLines(cdp, /^GOT:/)
  // 这一窗口的含金量在于"确实探过"：read 阻塞在前台时至少跑了一次 keepalive
  // 往返（旧实现在这里会把 '\n\r\x1b[K' 写进 PTY，read 立刻返回空行并打印 GOT）。
  check('前台有 read 阻塞时保活仍至少往返一次', loopSpy.keepaliveFrames >= 1, { keepaliveFrames: loopSpy.keepaliveFrames })
  check('挂 read 循环，空闲 10s 后 PTY 里没有莫名出现的 GOT 行（旧实现会打印）', gotAfterIdle === 0 && loopSpy.dataOutChars === 0, {
    gotLines: gotAfterIdle, dataOut: loopSpy.dataOut
  })
  // 正控制：真按一次回车，读循环必须立刻打印 —— 证明上面那条判据看得见
  await send(cdp, 'x\r')
  await sleep(1200)
  const gotAfterReal = await countLines(cdp, /^GOT:/)
  check('对照：真人敲一次回车，read 循环恰好打印 1 行 GOT（判据看得见）', gotAfterReal === 1, { gotLines: gotAfterReal })
  await send(cdp, '\x03')
  await sleep(800)
  await cdp.shot(path.join(SHOT_DIR, '02-read-loop.png'))

  // ---- 3) 半截命令：探针必须按住 ----
  await sleep(1200)
  await send(cdp, 'echo KA-HALF-TYPED')
  await sleep(300)
  const halfBefore = JSON.parse(await cdp.eval(SPY))
  await cdp.eval('window.__note()')
  console.log('half-typed window 8s')
  await sleep(8000)
  const halfSpy = JSON.parse(await cdp.eval(SPY))
  check('半截命令期间 keepalive 控制帧为 0（探针按住不写）', halfSpy.keepaliveFrames === 0, {
    frames: halfSpy.keepaliveFrames,
    pendingLengthBefore: halfBefore.pendingLength,
    pendingLength: halfSpy.pendingLength
  })
  check('半截命令期间 ESC[5n 一次都没写进显示流', halfSpy.dsrWrites === 0, { dsrWrites: halfSpy.dsrWrites })
  check('半截命令期间 PTY 依旧收不到字节', halfSpy.dataOutChars === 0, halfSpy.dataOut)
  const executed = await countOf(cdp, 'KA-HALF-TYPED')
  check('半截命令没有被提交执行（缓冲里只出现输入行那 1 次）', executed === 1, { occurrences: executed })
  await send(cdp, '\r')
  await sleep(1000)
  check('补一次回车后恰好执行一次（没有双回车提交）', (await countOf(cdp, 'KA-HALF-TYPED')) === 2, {
    occurrences: await countOf(cdp, 'KA-HALF-TYPED')
  })
  await cdp.shot(path.join(SHOT_DIR, '03-half-typed.png'))

  // ---- 4) 全屏程序（alternate buffer）：探针按住 ----
  const hasLess = await cdp.eval(`(() => {
    const addon = window.refs.get('term-' + window.__k.id).attachAddon
    addon.sendToServer('command -v less >/dev/null 2>&1 && echo HAVE-LESS || echo NO-LESS\\r')
    return 'sent'
  })()`)
  await sleep(1500)
  if (String(await cdp.eval(BUF)).includes('HAVE-LESS')) {
    await send(cdp, 'less /etc/hostname\r')
    await sleep(1500)
    const inAlt = await cdp.eval(`(() => {
      const addon = window.refs.get('term-' + window.__k.id).attachAddon
      return addon.term.buffer.active.type
    })()`)
    await cdp.eval('window.__note()')
    console.log('alternate-buffer window 8s, buffer type = ' + inAlt)
    await sleep(8000)
    const altSpy = JSON.parse(await cdp.eval(SPY))
    check('全屏程序（alternate buffer）期间探针按住不写', inAlt === 'alternate' && altSpy.dsrWrites === 0 && altSpy.dataOutChars === 0, {
      bufferType: inAlt, dsrWrites: altSpy.dsrWrites, dataOut: altSpy.dataOut
    })
    await send(cdp, 'q')
    await sleep(1000)
  } else {
    skip('环境没有 less，alternate buffer 那条判据跳过', hasLess)
  }
  await cdp.shot(path.join(SHOT_DIR, '04-final.png'))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) {
    console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
  }
  cdp.ws.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('demo error:', e)
  process.exit(2)
})
