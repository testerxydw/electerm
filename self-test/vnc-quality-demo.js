#!/usr/bin/env node
/**
 * VNC 顶栏画质档位 + 自定义滑杆 —— 运行时实测（草图 2026-11-05 方案 A）
 *
 * 本脚本钉住草图的验收判据（§七 实机）：
 *   ① 未连接时画质 Select 置灰、不可点；
 *   ② 选「清晰」后 ws 出口报文含 -26 / -254（-32+Q6 / -256+C2）；
 *   ③ 同档再点不再多推一帧 SetEncodings（我们的 appliedQuality 判等）；
 *   ④ 原地重连后读回 rfb.qualityLevel 仍为上次决策值（值来自 state，不丢）；
 *   ⑤ 书签 qualityLevel 全程不变（不回写）；
 *   ⑥ 全程零未捕获异常。
 *
 * 证据口径：不重建 noVNC，用**真实 noVNC RFB** 打一条**假 WebSocket**。
 * 假 ws 只拦截 URL 里带 /vnc/ 的连接，自己扮演远端 RFB server：握手
 * （ProtocolVersion → Security(None) → SecurityResult → ServerInit）走完，
 * 客户端进入 connected 之后发出的 SetEncodings 帧（msg-type=2）逐帧记进
 * window.__vq.setEncodings。于是 Q/C 伪编码（qualityLevel0=-32 / compressLevel0=-256，
 * encodings.js）真的出现在协议层字节里 —— 这是"画质到了 noVNC setter 之外的
 * 线上"的硬证据，不是重放一个自写的 setter。
 *
 * 用法（与 vnc-resize-throttle-demo.js 同一条编译 + 启动链路）：
 *   1) npm run compile
 *   2) D=$(mktemp -d /tmp/electerm-vncq-XXXX) && mkdir -p $D/home $D/config $D/data $D/tmp
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data TMPDIR=$D/tmp \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9225 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/vnc-quality-demo.js 9225 [shotDir]
 *      探针在首连前装一次，重跑要重启实例（照 resize demo）。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'vnc-quality-shots')

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

  async evaluate (expression, awaitPromise) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: !!awaitPromise
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + JSON.stringify(details.exception || details.text))
    }
    const res = r.result && r.result.result
    return res ? res.value : undefined
  }

  eval (expression) {
    return this.evaluate(expression, false)
  }

  evalAsync (expression) {
    return this.evaluate(expression, true)
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

const waitFor = async (cdp, expr, label, timeout = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await cdp.eval(expr)
    if (v) {
      return v
    }
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return null
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  · ' + detail : ''))
}

// 页面内探针：拦截 /vnc/ 的 WebSocket，扮演远端 RFB server，并记录 SetEncodings。
// 探针只此一处安装，且必须在 remoteInit 打开 VNC ws 之前装好（装 window.WebSocket）。
const INSTALL = `(() => {
  const RealWS = window.WebSocket
  const vq = {
    frames: 0,          // 收到的 client→server 全部帧数
    setEncodings: [],   // 每条 SetEncodings 帧的编码列表（int32）
    encodeFrames: 0,    // SetEncodings 帧数
    fbUpdates: [],      // 每条 FramebufferUpdateRequest（msg-type 3）
    errors: [],         // 未捕获异常
    rfbBuilt: 0,
    createTerm: 0,
    vncSockets: 0
  }
  window.__vq = vq
  window.addEventListener('error', (e) => {
    vq.errors.push(String(e.message || e.error))
  })

  // ---- 远端 RFB server 状态机：只服务 /vnc/ 的连接，其余走真实现 ----
  class FakeWebSocket {
    constructor (url, protocols) {
      this.url = String(url)
      this.binaryType = 'blob'
      this.readyState = 0            // CONNECTING
      this.protocol = ''
      // noVNC attach() 会校验这四个 handler 与 protocol/readyState 都在通道上
      this.onopen = null
      this.onmessage = null
      this.onclose = null
      this.onerror = null
      if (!this.url.includes('/vnc/')) {
        // 应用自己的 IPC ws 不是 VNC 会话：走真实现
        this._real = new RealWS(url, protocols)
        return
      }
      this._real = null
      this._state = 'version'
      this._id = ++vq.vncSockets || 1
      const self = this
      setTimeout(() => {
        self.readyState = 1          // OPEN
        self.onopen && self.onopen({})
        // 1) ProtocolVersion：server 先发
        self._sendText('RFB 003.008\\n')
      }, 0)
    }

    _sendText (s) {
      const u8 = new Uint8Array(s.length)
      for (let i = 0; i < s.length; i++) {
        u8[i] = s.charCodeAt(i) & 0xff
      }
      this._deliver(u8.buffer)
    }

    _deliver (buf) {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({ data: buf })
        }
      }, 0)
    }

    send (data) {
      if (this._real) {
        this._real.send(data)
        return
      }
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
      vq.frames++
      if (this._state === 'connected') {
        if (u8.length && u8[0] === 2) {
          // SetEncodings: msg-type(1) padding(1) number-of-encodings(2) encodings(4*n)
          const count = (u8[2] << 8) | u8[3]
          const encs = []
          for (let i = 0; i < count; i++) {
            const o = 4 + i * 4
            const v = ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) | 0
            encs.push(v)
          }
          vq.setEncodings.push(encs)
          vq.encodeFrames++
        }
        if (u8.length >= 10 && u8[0] === 3) {
          // FramebufferUpdateRequest: type(1) incremental(1) x(2) y(2) w(2) h(2)
          vq.fbUpdates.push({
            incremental: u8[1] === 1,
            w: (u8[6] << 8) | u8[7],
            h: (u8[8] << 8) | u8[9]
          })
        }
        return
      }
      // 握手阶段：按 client 发出的字节回 server 应答
      if (this._state === 'version') {
        // client 回 version
        this._state = 'security'
        // 2) Security：numTypes=1, type=1(None)
        this._deliver(new Uint8Array([1, 1]).buffer)
      } else if (this._state === 'security') {
        // client 选 auth scheme
        this._state = 'clientinit'
        // 3) SecurityResult OK
        this._deliver(new Uint8Array([0, 0, 0, 0]).buffer)
      } else if (this._state === 'clientinit') {
        // client 发 ClientInit（shared 1 字节）
        this._state = 'connected'
        // 4) ServerInit：1280x800, 32bpp truecolor, name "fake-desktop"
        const name = 'fake-desktop'
        const b = [
          0x05, 0x00, 0x03, 0x20,            // 1280, 800
          0x20, 0x18, 0x00, 0x01,            // bpp 32, depth 24, bigEndian 0, trueColor 1
          0x00, 0xff, 0x00, 0xff, 0x00, 0xff, // redMax greenMax blueMax
          0x10, 0x08, 0x00,                  // redShift 16, greenShift 8, blueShift 0
          0x00, 0x00, 0x00,                  // padding 3
          (name.length >> 24) & 0xff, (name.length >> 16) & 0xff,
          (name.length >> 8) & 0xff, name.length & 0xff
        ]
        for (let i = 0; i < name.length; i++) {
          b.push(name.charCodeAt(i) & 0xff)
        }
        this._deliver(new Uint8Array(b).buffer)
      }
    }

    close () {
      if (this._real) {
        this._real.close()
      }
      this.readyState = 3
      this.onclose && this.onclose({})
    }
  }
  // noVNC 的 websock.js 在**模块求值**时读 WebSocket.OPEN/CONNECTING/... 拼
  // ReadyStates；本探针先替换 window.WebSocket 再动态 import，读到的是这个类。
  // 少了静态常量，readyState getter 就落 'unknown'，flush() 永远不发 —— 握手
  // 停在 Security，SetEncodings 一帧都出不去。
  FakeWebSocket.CONNECTING = 0
  FakeWebSocket.OPEN = 1
  FakeWebSocket.CLOSING = 2
  FakeWebSocket.CLOSED = 3
  window.WebSocket = FakeWebSocket

  // 假 ws：把 create-terminal(vnc) 应答在本地造出来（照 resize demo）
  const ws = window.et && window.et.commonWs
  if (!ws) {
    return 'no-common-ws'
  }
  const proto = Object.getPrototypeOf(ws)
  const origS = proto.s
  const origOnce = proto.once
  const cbs = {}
  proto.once = function (func, id) {
    cbs[id] = func
    return origOnce.apply(this, arguments)
  }
  proto.s = function (data) {
    if (data && data.action === 'create-terminal' && data.body && data.body.termType === 'vnc') {
      vq.createTerm++
      const cb = cbs[data.id]
      delete cbs[data.id]
      setTimeout(() => {
        cb && cb({ data: { pid: 'vnc-fake-' + vq.createTerm, port: 5900 } })
      }, 20)
      return
    }
    return origS.apply(this, arguments)
  }

  // 供 CDP 侧取 VncSession 实例：沿 fiber 爬到带 handleQualityCommit 的组件
  window.__vqInst = () => {
    const n = document.querySelector('.vnc-session-mount')
    if (!n) {
      return null
    }
    const key = Object.keys(n).find(x => x.indexOf('__reactFiber$') === 0)
    let f = key ? n[key] : null
    while (f) {
      if (f.stateNode && typeof f.stateNode.handleQualityCommit === 'function') {
        return f.stateNode
      }
      f = f.return
    }
    return null
  }
  return 'installed'
})()`

const OPEN_VNC_TAB = `(() => {
  const store = window.store
  store.addTab({
    type: 'vnc',
    title: 'VNC-QUALITY',
    host: '127.0.0.1',
    port: '5900',
    username: 'demo',
    password: 'demo',
    scaleViewport: true,
    clipViewport: false,
    qualityLevel: 3,
    compressionLevel: 1,
    batch: 0
  })
  return store.activeTabId
})()`

const SESSION_READY = `(() => {
  const vq = window.__vq
  const mount = document.querySelector('.vnc-session-mount')
  if (!mount) {
    return null
  }
  const tab = (window.store.tabs || []).find(t => t.id === window.store.activeTabId)
  if (!tab || tab.status !== 'success') {
    return null
  }
  return vq.encodeFrames > 0 ? 'connected' : null
})()`

// 从组件 fiber 拿到 VncSession 实例（照 resize demo 的 fiber 取法）
const RBF_STATE = `(() => {
  const inst = window.__vqInst()
  if (!inst || !inst.rfb) {
    return null
  }
  return JSON.stringify({
    q: inst.rfb.qualityLevel,
    c: inst.rfb.compressionLevel,
    stateQ: inst.state.qualityLevel,
    stateC: inst.state.compressionLevel,
    bookmarkQ: (window.store.tabs || []).find(t => t.id === window.store.activeTabId).qualityLevel
  })
})()`

const SET_ENC_VALUES = `(() => {
  const vq = window.__vq
  const latest = vq.setEncodings[vq.setEncodings.length - 1] || []
  return JSON.stringify({
    frames: vq.encodeFrames,
    hasNeg29: latest.indexOf(-29) > -1,
    hasNeg255: latest.indexOf(-255) > -1,
    hasNeg26: latest.indexOf(-26) > -1,
    hasNeg254: latest.indexOf(-254) > -1,
    hasNeg24: latest.indexOf(-24) > -1,
    hasNeg253: latest.indexOf(-253) > -1
  })
})()`

const FBU_STATE = `(() => {
  const vq = window.__vq
  const full = vq.fbUpdates.filter(f => !f.incremental)
  return JSON.stringify({
    total: vq.fbUpdates.length,
    full: full.length,
    lastFull: full[full.length - 1] || null
  })
})()`

const SELECT_DISABLED = `(() => {
  const sel = document.querySelector('.vnc-quality-select')
  if (!sel) {
    return 'no-select'
  }
  return sel.classList.contains('ant-select-disabled')
})()`

const HANDPRESET = (key) => `(() => {
  const inst = window.__vqInst()
  if (!inst) {
    return false
  }
  inst.handlePresetChange('${key}')
  return true
})()`

const HANDQUALITY = (q, c) => `(() => {
  const inst = window.__vqInst()
  if (!inst) {
    return false
  }
  inst.handleQualityCommit(${q}, ${c})
  return true
})()`

const RECONNECT = `(() => {
  const inst = window.__vqInst()
  if (!inst) {
    return false
  }
  inst.handleReInit()
  return true
})()`

// 用一个纯浏览器方法确认"真实 SetEncodings 帧含指定伪编码"的常数锚
const main = async () => {
  let target
  try {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list')
    target = list.find(t => t.type === 'page') || list[0]
  } catch (e) {
    console.error('CDP 连不上 ' + PORT + '，先按文件头用法起一个隔离实例')
    process.exit(2)
  }
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready

  check('探针安装', await cdp.eval(INSTALL) === 'installed')
  // 未连接置灰：打开 tab 后立即高频轮询，抓到"Select 已渲染且仍 disabled"的
  // 加载窗口（假连接很快，普通 waitFor 一次等 200ms 会直接跳到已连接）
  check('打开 tab', !!await cdp.eval(OPEN_VNC_TAB))
  let disabledSeen = false
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && !disabledSeen) {
    const s = await cdp.eval(SELECT_DISABLED)
    if (s === true) {
      disabledSeen = true
    }
    await sleep(40)
  }
  check('未连接时画质 Select 置灰', disabledSeen, 'seen=' + disabledSeen)

  // 连上：默认档位 3/1，初始 SetEncodings 含 -29/-255
  check('会话连上（fake ws 出口有 SetEncodings 帧）',
    (await waitFor(cdp, SESSION_READY, 'session connected')) === 'connected')
  const r0 = JSON.parse(await cdp.eval(RBF_STATE))
  check('首连决策值来自默认 3/1（本机无记忆 + 书签 3/1）',
    r0.q === 3 && r0.c === 1 && r0.stateQ === 3, JSON.stringify(r0))
  const e0 = JSON.parse(await cdp.eval(SET_ENC_VALUES))
  check('初始 SetEncodings 帧含 -29(qualityLevel0+3) / -255(compressLevel0+1)',
    e0.hasNeg29 && e0.hasNeg255, JSON.stringify(e0))

  // 选「清晰」(Q6/C2)：真产品 handler → 真实 noVNC → 真报文 -26/-254
  const fbu0 = JSON.parse(await cdp.eval(FBU_STATE))
  await cdp.eval(HANDPRESET('sharp'))
  await sleep(250)
  const r1 = JSON.parse(await cdp.eval(RBF_STATE))
  check('选「清晰」后 rfb.qualityLevel === 6', r1.q === 6 && r1.c === 2, JSON.stringify(r1))
  const e1 = JSON.parse(await cdp.eval(SET_ENC_VALUES))
  check('出口报文含 -26(qualityLevel0+6) / -254(compressLevel0+2)',
    e1.hasNeg26 && e1.hasNeg254, JSON.stringify(e1))
  const fbu1 = JSON.parse(await cdp.eval(FBU_STATE))
  check('切档后主动补一次全刷新请求（非增量、整屏）',
    fbu1.full > fbu0.full && fbu1.lastFull &&
      !fbu1.lastFull.incremental && fbu1.lastFull.w > 0 && fbu1.lastFull.h > 0,
    'full ' + fbu0.full + '→' + fbu1.full + ' last=' + JSON.stringify(fbu1.lastFull))

  // 同档再点：不再多推一帧
  await cdp.eval(HANDPRESET('sharp'))
  await sleep(250)
  const e1b = JSON.parse(await cdp.eval(SET_ENC_VALUES))
  check('同档再点不再多推一帧 SetEncodings',
    e1b.frames === e1.frames, e1b.frames + ' vs ' + e1.frames)

  // 自定义滑杆：handleQualityCommit(8, 3) → -24/-253；重复同值不再发帧
  await cdp.eval(HANDQUALITY(8, 3))
  await sleep(250)
  const r2 = JSON.parse(await cdp.eval(RBF_STATE))
  check('滑杆拖到 8/3 后 rfb.qualityLevel === 8', r2.q === 8 && r2.c === 3, JSON.stringify(r2))
  const e2 = JSON.parse(await cdp.eval(SET_ENC_VALUES))
  check('出口报文含 -24(qualityLevel0+8) / -253(compressLevel0+3)',
    e2.hasNeg24 && e2.hasNeg253, JSON.stringify(e2))
  await cdp.eval(HANDQUALITY(8, 3))
  await sleep(200)
  const e2b = JSON.parse(await cdp.eval(SET_ENC_VALUES))
  check('重复 8/3 不再多推一帧', e2b.frames === e2.frames, e2b.frames + ' vs ' + e2.frames)

  // 原地重连：值来自 state，不丢
  await cdp.eval(RECONNECT)
  const reconnected = await waitFor(cdp, SESSION_READY, 'reconnected')
  check('重连成功', reconnected === 'connected')
  const r3 = JSON.parse(await cdp.eval(RBF_STATE))
  check('重连后读回 rfb.qualityLevel === 8（值来自 state）',
    r3.q === 8 && r3.c === 3 && r3.stateQ === 8, JSON.stringify(r3))

  // 书签不回写
  check('书签 qualityLevel 全程不变（仍为 3）', r3.bookmarkQ === 3, 'bookmarkQ=' + r3.bookmarkQ)

  // 全程零未捕获异常
  const errs = await cdp.eval('JSON.stringify(window.__vq.errors)')
  check('全程零未捕获异常', errs === '[]', errs)

  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await cdp.shot(path.join(SHOT_DIR, 'vnc-quality-final.png'))
    console.log('shot → ' + path.join(SHOT_DIR, 'vnc-quality-final.png'))
  } catch (e) {
    console.log('(截图跳过) ' + e.message)
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n==== ' + results.length + ' checks, ' + failed.length + ' failed ====')
  failed.forEach(f => console.log('  FAIL  ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('demo error:', e)
  process.exit(1)
})
