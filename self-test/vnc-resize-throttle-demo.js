#!/usr/bin/env node
/**
 * VNC 会话「窗口自适应」链路 —— 运行时实测（台账 §1-S3-1）
 *
 * 批次 A/B（commit dcdc4be7 + 9975b008）把远程会话的 resize 链路做了五件事：
 *   V1 抖动门（VIEWPORT_EPSILON=2）、V2 合并窗（RESIZE_MERGE_MS=200）、
 *   C1 noVNC setter 判等（appliedFit/appliedClip）、C2 滚动定时器判等、
 *   R2 尺寸取 shell 实测值，不再"写样式之后再读 container.clientWidth"。
 * 此前只有 `src/test/unit-ci/remote-adapt.spec.js` 的纯函数重放在代答。
 * 本脚本把同一套手势放进**真实浏览器 + 真实产品组件实例**里跑，钉两个数：
 * ResizeObserver 回调计数、强制同步布局（同一 JS 任务里写完样式再读布局）计数。
 *
 * 没有真远端也能跑，靠两个替身（都在页面内接管产品的边界，不改产品代码）：
 *   假 ws  —— patch Ws.prototype.s/once，把 create-terminal(termType=vnc) 的
 *             应答在本地造出来（{pid, port}），于是 remoteInit 走完整成功分支；
 *   假 RFB —— 预置 window.novnc = {RFB: FakeRFB}，loadVncModule() 直接短路。
 *             FakeRFB 只实现 vnc-session 用到的接口，并且像真 noVNC 那样
 *             **在 JS 任务里写 canvas 的 style** —— 否则"写完就读"不会真的
 *             构成强制同步布局，计数就成了自说自话。
 *
 * 对照基线 OLD 阶段：把 resize 链路换回 commit dcdc4be7~1 的实现（每帧直接
 * 重排、setter 无条件写、autoscale 读写样式之后的 container.clientWidth、
 * 每次重排都重挂 50ms 滚动定时器），同一假 RFB、同一手势、同一页面。
 *
 * G) 阶段顺手收掉台账里"VNC 要不要跟 RDP 一样把首连尺寸夹到 MAX_DESKTOP"那一问：
 * 实测是**不夹**（2560 原样发），而且不夹是对的 —— 这两个值只拼进 wsUrl、落到
 * `src/app/server/session-vnc.js` 的 `this.width/this.height` 当诊断值，VNC 的桌面
 * 尺寸由远端 server 决定，客户端从不调 setDesktopSize/resizeSession。这条用源码
 * 契约守卫（vncAsksRemoteResize），将来 P-6/D5 真给 VNC 开了改桌面尺寸，判据要换。
 *
 * 用法：
 *   1) npm run compile
 *      （只跑 vite-build 不够：index.html 由 pug.js 生成、icons 由 copy.js 拷，
 *        少了这两步主窗口会停在 "Cannot GET /index.html"，CDP 连得上但页面是死的）
 *   2) D=$(mktemp -d /tmp/electerm-vnc-XXXX) && mkdir -p $D/home $D/config $D/data $D/tmp
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data TMPDIR=$D/tmp \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9225 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *      （TMPDIR 必须隔离：single-instance.sock 按用户共用，否则第二个实例会连到
 *        并行会话的主实例、退 0 什么也测不到）
 *   3) node self-test/vnc-resize-throttle-demo.js 9225 [shotDir]
 *      探针装在页面里、只在首连前装一次，所以**重跑要重启实例**（或整页 reload），
 *      否则第二次跑拿到的是上一轮的会话与计数基线。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'vnc-resize-throttle-shots')

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

  async metrics () {
    const r = await this.call('Performance.getMetrics', {})
    const list = (r.result && r.result.metrics) || []
    const out = {}
    for (const m of list) {
      out[m.name] = m.value
    }
    return out
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
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol

/* ------------------------------------------------------------------ *
 * 页面内探针：必须在开页签之前装好
 * ------------------------------------------------------------------ */

const INSTALL = `(() => {
  const vp = {
    armed: false, silence: false, dirty: false, inLayout: false,
    ro: 0, roSizeChanged: 0, lastROSize: null,
    resizeCalls: 0, layoutRuns: 0,
    reads: 0, readsInLayout: 0, forced: 0, forcedInLayout: 0,
    autoscale: 0, autoscaleArgs: null,
    timers50: 0, timers200: 0, setterWrites: {},
    oldLayouts: 0, burstSteps: 0,
    rfbBuilt: 0, createTerm: 0, disconnected: 0,
    lastUrl: '', lastOpts: null
  }
  window.__vp = vp
  const bump = (k) => { vp.setterWrites[k] = (vp.setterWrites[k] || 0) + 1 }
  const nativeTimeout = window.setTimeout
  window.__nativeTimeout = nativeTimeout

  // ---- 1) 包一层原生 ResizeObserver：只数远程视口那一个被观察元素。
  //         RO 回调跑在布局之后，所以顺手清掉"本帧写过样式"标记 ——
  //         帧末布局之后再读不算强制同步布局，不能混进 forced。
  const NativeRO = window.ResizeObserver
  const ROShim = function (cb) {
    const wrapped = (entries, obs) => {
      if (vp.armed) {
        vp.dirty = false
        for (const e of entries) {
          const el = e.target
          if (el && el.classList && el.classList.contains('remote-session-viewport')) {
            vp.ro++
            const w = Math.round(e.contentRect.width)
            const h = Math.round(e.contentRect.height)
            const last = vp.lastROSize
            if (!last || last.width !== w || last.height !== h) {
              vp.roSizeChanged++
            }
            vp.lastROSize = { width: w, height: h }
          }
        }
      }
      return cb(entries, obs)
    }
    return new NativeRO(wrapped)
  }
  ROShim.prototype = NativeRO.prototype
  window.ResizeObserver = ROShim

  // ---- 2) 布局读探针：写过样式、同一 JS 任务里再读布局 = 一次强制同步布局
  const elProto = Element.prototype
  const countRead = () => {
    vp.reads++
    if (vp.inLayout) {
      vp.readsInLayout++
    }
    if (vp.dirty) {
      vp.forced++
      if (vp.inLayout) {
        vp.forcedInLayout++
      }
      vp.dirty = false
    }
  }
  for (const p of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight']) {
    const d = Object.getOwnPropertyDescriptor(elProto, p)
    if (!d || !d.get) {
      continue
    }
    const g = d.get
    Object.defineProperty(elProto, p, {
      configurable: true,
      enumerable: d.enumerable,
      get () {
        if (vp.armed) {
          countRead()
        }
        return g.call(this)
      },
      set: d.set
    })
  }
  const nativeRect = elProto.getBoundingClientRect
  elProto.getBoundingClientRect = function () {
    if (vp.armed) {
      countRead()
    }
    return nativeRect.apply(this, arguments)
  }
  // 探针自己读尺寸不能污染计数
  window.__quiet = (fn) => {
    const a = vp.armed
    vp.armed = false
    try {
      return fn()
    } finally {
      vp.armed = a
    }
  }

  // ---- 3) 定时器计数：50ms = 滚动定位，200ms = 合并窗（RESIZE_MERGE_MS）
  window.setTimeout = function (fn, ms) {
    if (vp.armed) {
      if (ms === 50) {
        vp.timers50++
      }
      if (ms === 200) {
        vp.timers200++
      }
    }
    return nativeTimeout.apply(window, arguments)
  }

  // ---- 4) 假 noVNC：只实现 vnc-session 用到的接口，样式写入与真实现同构
  const DESKTOP = { width: 1280, height: 800 }
  const paint = (el, w, h) => {
    el.style.width = w + 'px'
    el.style.height = h + 'px'
    vp.dirty = true
  }
  const markStyle = (el, v) => {
    el.style.outline = v ? '3px solid rgba(230, 120, 40, 0.95)' : 'none'
    vp.dirty = true
  }
  class FakeRFB extends EventTarget {
    constructor (mount, url, opts) {
      super()
      vp.rfbBuilt++
      vp.lastUrl = url
      vp.lastOpts = {
        scaleViewport: !!opts.scaleViewport,
        clipViewport: !!opts.clipViewport,
        viewOnly: !!opts.viewOnly,
        qualityLevel: opts.qualityLevel,
        compressionLevel: opts.compressionLevel
      }
      const screen = document.createElement('div')
      screen.className = 'fake-vnc-screen'
      screen.style.position = 'relative'
      screen.style.boxSizing = 'border-box'
      screen.style.width = DESKTOP.width + 'px'
      screen.style.height = DESKTOP.height + 'px'
      const canvas = document.createElement('div')
      canvas.className = 'fake-vnc-canvas'
      canvas.style.boxSizing = 'border-box'
      canvas.style.width = DESKTOP.width + 'px'
      canvas.style.height = DESKTOP.height + 'px'
      canvas.style.background = 'linear-gradient(135deg, #16324f 0%, #2c6e91 45%, #2a9d8f 100%)'
      canvas.style.color = '#eaf4fb'
      canvas.style.fontFamily = 'monospace'
      canvas.style.fontSize = '16px'
      canvas.style.lineHeight = '1.6'
      canvas.style.padding = '10px'
      canvas.textContent = 'fake desktop ' + DESKTOP.width + 'x' + DESKTOP.height
      screen.appendChild(canvas)
      mount.appendChild(screen)
      this.screens = []
      this.capabilities = {}
      this._fail = (reason) => { vp.lastFail = String(reason) }
      this.disconnect = () => {
        vp.disconnected++
        screen.remove()
      }
      this.sendCtrlAltDel = () => {}
      this.clipboardPasteFrom = () => {}
      this.approveServer = () => {}
      this.sendCredentials = () => {}
      this._display = {
        scale: 1,
        autoscale: (w, h) => {
          vp.autoscale++
          vp.autoscaleArgs = [Math.round(w), Math.round(h)]
          this._display._rescale(Math.min(w / DESKTOP.width, h / DESKTOP.height))
        },
        _rescale: (s) => {
          this._display.scale = s
          const w = Math.round(DESKTOP.width * s)
          const h = Math.round(DESKTOP.height * s)
          canvas.textContent = 'fake desktop ' + DESKTOP.width + 'x' + DESKTOP.height +
            ' -> ' + w + 'x' + h + '  scale ' + s.toFixed(3)
          paint(canvas, w, h)
        }
      }
      let scaleViewport = false
      let clipViewport = false
      let viewOnly = false
      Object.defineProperty(this, 'scaleViewport', {
        configurable: true,
        get: () => scaleViewport,
        set: (v) => {
          bump('scaleViewport')
          scaleViewport = v
          markStyle(screen, v)
        }
      })
      Object.defineProperty(this, 'clipViewport', {
        configurable: true,
        get: () => clipViewport,
        set: (v) => {
          bump('clipViewport')
          clipViewport = v
          screen.style.overflow = v ? 'hidden' : 'auto'
          vp.dirty = true
        }
      })
      Object.defineProperty(this, 'viewOnly', {
        configurable: true,
        get: () => viewOnly,
        set: (v) => { bump('viewOnly'); viewOnly = v }
      })
      for (const k of ['qualityLevel', 'compressionLevel', 'showDotCursor']) {
        Object.defineProperty(this, k, {
          configurable: true,
          get: () => 0,
          set: () => { bump(k) }
        })
      }
      nativeTimeout(() => {
        this.dispatchEvent(new CustomEvent('connect', { detail: {} }))
        this.dispatchEvent(new CustomEvent('desktopname', { detail: { name: 'fake-desktop' } }))
      }, 30)
    }
  }
  window.novnc = { RFB: FakeRFB }

  // ---- 5) 假 ws：把 create-terminal(vnc) 的应答在本地造出来
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
      vp.createTerm++
      const cb = cbs[data.id]
      delete cbs[data.id]
      nativeTimeout(() => {
        cb && cb({ data: { pid: 'vnc-fake-' + vp.createTerm, port: 5900 } })
      }, 20)
      return
    }
    return origS.apply(this, arguments)
  }
  return 'installed'
})()`

const OPEN_VNC_TAB = `(() => {
  const store = window.store
  store.addTab({
    type: 'vnc',
    title: 'VNC-RESIZE',
    host: '127.0.0.1',
    port: '5900',
    username: 'demo',
    password: 'demo',
    scaleViewport: true,
    clipViewport: false,
    batch: 0
  })
  return store.activeTabId
})()`

const SESSION_READY = `(() => {
  const vp = window.__vp
  const mount = document.querySelector('.vnc-session-mount')
  const canvas = document.querySelector('.fake-vnc-canvas')
  const wrap = document.querySelector('.remote-session-wrap')
  if (!mount || !canvas || !wrap) {
    return null
  }
  const tab = (window.store.tabs || []).find(t => t.id === window.store.activeTabId)
  if (!tab || tab.status !== 'success') {
    return null
  }
  const size = window.__quiet(() => ({
    width: mount.clientWidth,
    height: mount.clientHeight
  }))
  return JSON.stringify({
    url: vp.lastUrl,
    opts: vp.lastOpts,
    rfbBuilt: vp.rfbBuilt,
    createTerm: vp.createTerm,
    fit: wrap.classList.contains('fit'),
    mountSize: size,
    desktopName: (document.querySelector('.remote-session-info-name') || {}).textContent || ''
  })
})()`

const INSTRUMENT = `(() => {
  const vp = window.__vp
  const node = document.querySelector('.vnc-session-mount')
  if (!node) {
    return 'no-mount'
  }
  const key = Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0)
  if (!key) {
    return 'no-fiber-key'
  }
  let fiber = node[key]
  let inst = null
  let shell = null
  while (fiber) {
    const sn = fiber.stateNode
    if (!inst && sn && typeof sn.updateViewLayout === 'function' && sn.domRef) {
      inst = sn
    }
    if (!shell && sn && typeof sn.measureViewport === 'function' && sn.viewRef) {
      shell = sn
    }
    fiber = fiber.return
  }
  if (!inst || !shell) {
    return 'no-instance'
  }
  window.__inst = inst
  window.__shell = shell

  // 产品的实际重排入口计数。防抖定时器和 handleScaleViewChange 都是按属性取
  // this.updateViewLayout，所以改属性就能覆盖全部调用路径
  const origLayout = inst.updateViewLayout
  inst.updateViewLayout = function () {
    if (vp.armed) {
      vp.layoutRuns++
    }
    vp.inLayout = true
    try {
      return origLayout.call(inst)
    } finally {
      vp.inLayout = false
    }
  }

  // 视口回调计数；OLD 阶段顺带把产品链路静音，只跑改造前实现
  let propPatched = false
  try {
    const origCb = shell.props.onViewportResize
    if (origCb) {
      const wrapped = function (w, h) {
        if (vp.armed) {
          vp.resizeCalls++
        }
        if (vp.silence) {
          return
        }
        return origCb(w, h)
      }
      shell.props.onViewportResize = wrapped
      propPatched = shell.props.onViewportResize === wrapped
    }
  } catch (e) {
    propPatched = false
  }

  // 改造前（commit dcdc4be7~1）的链路照搬：每帧直接重排、setter 无条件写、
  // autoscale 读"写完样式之后"的 container.clientWidth、每次重排都重挂 50ms 定时器
  window.__oldLayout = function () {
    const container = inst.domRef.current ? inst.domRef.current.firstElementChild : null
    const rfb = inst.rfb
    if (!rfb || !container) {
      return
    }
    if (vp.armed) {
      vp.oldLayouts++
      vp.layoutRuns++
    }
    vp.inLayout = true
    try {
      const fit = inst.getFit()
      rfb.scaleViewport = fit
      rfb.clipViewport = inst.props.tab.clipViewport || false
      if (fit && rfb._display) {
        rfb._display.autoscale(container.clientWidth, container.clientHeight)
      }
      clearTimeout(inst.timer)
      inst.timer = window.setTimeout(() => {
        container.scrollTo(0, 0)
      }, 50)
    } finally {
      vp.inLayout = false
    }
  }
  window.__oldFrame = function (w, h) {
    inst.viewSize = { width: w, height: h }
    window.__oldLayout()
  }

  return JSON.stringify({ propPatched, hasRfb: !!inst.rfb, hasScreens: !!inst.state })
})()`

/* ------------------------------------------------------------------ *
 * 手势重放与计数采集
 * ------------------------------------------------------------------ */

const MARK = `(() => {
  const vp = window.__vp
  Object.assign(vp, {
    ro: 0, roSizeChanged: 0, resizeCalls: 0, layoutRuns: 0,
    reads: 0, readsInLayout: 0, forced: 0, forcedInLayout: 0,
    autoscale: 0, autoscaleArgs: null, timers50: 0, timers200: 0,
    setterWrites: {}, oldLayouts: 0, burstSteps: 0,
    rfbBuilt: 0, createTerm: 0, disconnected: 0
  })
  vp.lastROSize = null
  vp.lastUrl = ''
  vp.armed = true
  return true
})()`

const COLLECT = `(() => {
  const vp = window.__vp
  vp.armed = false
  const o = {}
  for (const k of ['ro', 'roSizeChanged', 'resizeCalls', 'layoutRuns', 'reads',
    'readsInLayout', 'forced', 'forcedInLayout', 'autoscale', 'autoscaleArgs',
    'timers50', 'timers200', 'oldLayouts', 'burstSteps', 'rfbBuilt', 'createTerm',
    'disconnected']) {
    o[k] = vp[k]
  }
  o.scaleWrites = vp.setterWrites.scaleViewport || 0
  o.clipWrites = vp.setterWrites.clipViewport || 0
  o.lastROSize = vp.lastROSize
  return JSON.stringify(o)
})()`

const SILENCE = on => '(() => { window.__vp.silence = ' + (on ? 'true' : 'false') + '; return true })()'

// 拖窗 = 逐帧改会话外壳尺寸；RO 会逐帧回调到产品的 SessionShell
const BURST = cfg => `(() => {
  const vp = window.__vp
  const spin = document.querySelector('.remote-session-spin')
  if (!spin) {
    return 'no-spin'
  }
  const measure = () => window.__quiet(() => {
    const r = spin.getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  })
  const start = measure()
  const cfg = ${JSON.stringify(cfg)}
  const frames = cfg.frames || 34
  let i = 0
  return new Promise(resolve => {
    const step = () => {
      if (i >= frames) {
        vp.burstSteps = i
        spin.style.lastDrag = JSON.stringify(measure())
        return resolve(JSON.stringify({ start, end: measure(), steps: i }))
      }
      let w
      let h
      if (cfg.jitter) {
        const s = i % 2 ? 1 : -1
        w = Math.round(start.width + s * (cfg.jitterPx || 1))
        h = Math.round(start.height - s * (cfg.jitterPx || 1))
      } else {
        const t = (i + 1) / frames
        w = Math.round(start.width + (cfg.dx || 0) * t)
        h = Math.round(start.height + (cfg.dy || 0) * t)
      }
      spin.style.width = w + 'px'
      spin.style.height = h + 'px'
      vp.dirty = false
      if (cfg.mode === 'old') {
        window.__oldFrame(w, h)
      }
      i++
      const wait = i === cfg.pauseAt ? (cfg.pauseMs || 0) : (cfg.interval || 16)
      window.__nativeTimeout(step, wait)
    }
    step()
  })
})()`

// 基线：先放开内联尺寸（回到 100%），量一次自然尺寸，再把该尺寸钉成内联值
const CLEAR_BOX = `(() => {
  const spin = document.querySelector('.remote-session-spin')
  if (!spin) {
    return null
  }
  spin.style.width = ''
  spin.style.height = ''
  return true
})()`

const PIN_BOX = px => `(() => {
  const spin = document.querySelector('.remote-session-spin')
  if (!spin) {
    return null
  }
  const size = window.__quiet(() => {
    const r = spin.getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  })
  const w = ${JSON.stringify(px && px.width)} || size.width
  const h = ${JSON.stringify(px && px.height)} || size.height
  spin.style.width = w + 'px'
  spin.style.height = h + 'px'
  return JSON.stringify({ width: w, height: h })
})()`

const WARMUP = '(() => { window.__inst.updateViewLayout(); return true })()'

// 钉完之后再量一次真实矩形：flex 主轴方向会被窗口高度压回去（钉 1440 实得 933），
// 所以判据只能拿**实测值**，不能拿请求值。
// 两个都要量：spin 是拖动手势作用的盒子，mount 是产品 calcCanvasSize 真正读的节点
// （spin 比 mount 高出一条顶栏，拿 spin 的尺寸去对 wsUrl 的 height 会差一个条高）。
const READ_BOX = `(() => {
  const spin = document.querySelector('.remote-session-spin')
  const mount = document.querySelector('.vnc-session-mount')
  if (!spin || !mount) {
    return null
  }
  return JSON.stringify(window.__quiet(() => {
    const r = spin.getBoundingClientRect()
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      mountWidth: mount.clientWidth,
      mountHeight: mount.clientHeight
    }
  }))
})()`

const FIT_STATE = `(() => {
  const wrap = document.querySelector('.remote-session-wrap')
  const canvas = document.querySelector('.fake-vnc-canvas')
  const viewport = document.querySelector('.remote-session-viewport')
  return JSON.stringify({
    fit: !!wrap && wrap.classList.contains('fit'),
    canvasText: canvas ? canvas.textContent : '',
    viewportOverflow: viewport ? getComputedStyle(viewport).overflow : '',
    roSize: window.__vp.lastROSize
  })
})()`

const TOGGLE_SCALE_SWITCH = `(() => {
  const sw = document.querySelector('.remote-session-control-left .switch-label-wrap .ant-switch')
  if (!sw) {
    return 'no-switch'
  }
  sw.click()
  return 'clicked'
})()`

// 顶栏重连图标：走产品自己的 handleReInit -> remoteInit -> 重建 RFB
const CLICK_RECONNECT = `(() => {
  const icon = document.querySelector('.remote-session-control-left .anticon-reload')
  if (!icon) {
    return 'no-reload-icon'
  }
  icon.click()
  return 'clicked'
})()`

// VNC 侧有没有"请求远端改桌面尺寸"的通道（setDesktopSize / resizeSession）。
// 运行时判据拿不到（假 RFB 只实现产品用到的接口），所以读源码钉契约：
// 台账 §2 的 P-6/D5 一旦给 VNC 开了 rfb.resizeSession，这里就会命中，
// 届时 G) 阶段的"不做 1920 夹取"必须一起改。
const vncAsksRemoteResize = async () => {
  const dir = path.join(__dirname, '../src/client/components/vnc')
  const hits = []
  for (const f of fs.readdirSync(dir)) {
    if (!/\.jsx?$/.test(f)) {
      continue
    }
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (/setDesktopSize|resizeSession/.test(line)) {
        hits.push(f + ':' + (i + 1))
      }
    })
  }
  return hits
}

const PANEL = rows => `(() => {
  let el = document.getElementById('vp-demo-panel')
  if (!el) {
    el = document.createElement('div')
    el.id = 'vp-demo-panel'
    el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:rgba(12,18,26,.93);' +
      'color:#e8f1f8;font:12px/1.6 monospace;padding:10px 12px;border:1px solid #3a6b8c;max-width:560px;'
    document.body.appendChild(el)
  }
  el.innerHTML = '<b>VNC resize 链路运行时实测（假 RFB / 假 ws，无真远端）</b><br>' + ${JSON.stringify(rows.join('<br>'))}
  return 'panel'
})()`

const METRIC_KEYS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'ScriptDuration']

const diff = (a, b) => {
  const out = {}
  for (const k of METRIC_KEYS) {
    out[k] = Math.round(((b[k] || 0) - (a[k] || 0)) * 1000) / 1000
  }
  return out
}

// 基线复位：解除内联尺寸 -> 等 RO 与合并窗跑完 -> 钉住自然尺寸 -> 再跑一次重排
// （让 appliedFit/appliedClip 判等基准落到当前值，之后的计数才只属于本阶段）
const rebase = async (ev, cdp) => {
  await ev(CLEAR_BOX)
  await sleep(700)
  const box = JSON.parse(await ev(PIN_BOX(null)))
  await sleep(700)
  await ev(WARMUP)
  await sleep(120)
  return box
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  const ev = e => cdp.eval(e)
  const evAsync = e => cdp.evalAsync(e)

  await waitFor(cdp, '(() => !!(window.store && window.et && window.et.commonWs))()', 'app ready', 40000)
  await cdp.call('Page.enable')
  await cdp.call('Performance.enable')

  check('探针装载（假 RFB + 假 ws + RO/布局读/定时器计数）', await ev(INSTALL) === 'installed')

  await ev(OPEN_VNC_TAB)
  const readyRaw = await waitFor(cdp, SESSION_READY, 'vnc session connected via fake rfb')
  if (!readyRaw) {
    throw new Error('vnc session did not come up with the fake rfb')
  }
  const ready = JSON.parse(readyRaw)
  const urlSize = /&width=([0-9]+)&height=([0-9]+)$/.exec(String(ready.url)) || []
  check('假 ws 让 remoteInit 走完整成功分支（1 次 create-terminal、1 次 RFB 构造、状态 success）',
    ready.createTerm === 1 && ready.rfbBuilt === 1, ready)
  check('首连尺寸提示取实测视口（不再是旧的 props.width-10 / props.height-80）',
    !!urlSize[1] && near(urlSize[1], ready.mountSize.width, 4) && near(urlSize[2], ready.mountSize.height, 4),
    { hint: [Number(urlSize[1]), Number(urlSize[2])], mount: ready.mountSize })
  check('首连按书签默认打开缩放（fit 生效、假桌面已按视口等比缩放）',
    ready.fit === true && ready.opts.scaleViewport === true, ready.opts)
  await cdp.shot(path.join(SHOT_DIR, '01-connected.png'))

  const instrumented = String(await ev(INSTRUMENT))
  check('拿到真实产品组件实例（VncSession + SessionShell），视口回调计数已接线',
    !/no-/.test(instrumented) && instrumented.indexOf('"propPatched":true') > 0, instrumented)

  await rebase(ev, cdp)

  // ---- B) 60fps 拖窗手势：现状链路 ----
  const m0 = await cdp.metrics()
  await ev(MARK)
  const burstNew = JSON.parse(await evAsync(BURST({ frames: 34, dx: -420, dy: -260, pauseAt: 20, pauseMs: 120 })))
  await sleep(700)
  const sNew = JSON.parse(await ev(COLLECT))
  const newMetrics = diff(m0, await cdp.metrics())
  check('手势真发生在浏览器里（ResizeObserver 逐帧回调 ≥20 次）',
    sNew.ro >= 20 && sNew.roSizeChanged >= 20, { ro: sNew.ro, roSizeChanged: sNew.roSizeChanged, steps: burstNew.steps })
  check('视口回调次数 = RO 报告的尺寸变化次数',
    Math.abs(sNew.resizeCalls - sNew.roSizeChanged) <= 2 && sNew.resizeCalls >= 20,
    { resizeCalls: sNew.resizeCalls, roSizeChanged: sNew.roSizeChanged })
  check('一次拖窗（34 帧、中间 120ms 卡顿）只重排 1 次，而不是每帧 1 次',
    sNew.layoutRuns === 1, { layoutRuns: sNew.layoutRuns, frames: sNew.burstSteps })
  check('合并窗在跑：200ms 定时器逐帧重挂、最终只生效一次',
    sNew.timers200 >= 20 && sNew.layoutRuns === 1, { timers200: sNew.timers200 })
  check('重排内部 0 次布局读取（尺寸取 shell 实测值，不读 DOM）',
    sNew.readsInLayout === 0 && sNew.forcedInLayout === 0,
    { readsInLayout: sNew.readsInLayout, forcedInLayout: sNew.forcedInLayout })
  check('现状链路整轮手势 0 次强制同步布局',
    sNew.forced === 0, { forced: sNew.forced, reads: sNew.reads })
  check('fit/clip 未变时一个 noVNC setter 都不写（appliedFit/appliedClip 判等）',
    sNew.scaleWrites === 0 && sNew.clipWrites === 0, { scaleWrites: sNew.scaleWrites, clipWrites: sNew.clipWrites })
  check('autoscale 只跑 1 次，且用的是最后一次实测视口（合并后不丢尺寸）',
    sNew.autoscale === 1 &&
      near(sNew.autoscaleArgs[0], sNew.lastROSize.width, 2) &&
      near(sNew.autoscaleArgs[1], sNew.lastROSize.height, 2),
    { autoscaleArgs: sNew.autoscaleArgs, lastROSize: sNew.lastROSize })
  check('滚动定时器至多重挂 1 次（缩放比变了才挂，C2 判等）',
    sNew.timers50 <= 1, { timers50: sNew.timers50 })
  check('拖窗期间不重连（RFB 构造 0 次、create-terminal 0 次、disconnect 0 次）',
    sNew.rfbBuilt === 0 && sNew.createTerm === 0 && sNew.disconnected === 0, sNew)
  console.log('INFO  CDP 度量增量（现状一轮手势）: ' + JSON.stringify(newMetrics))
  await cdp.shot(path.join(SHOT_DIR, '02-after-drag.png'))

  // ---- C) 两次独立手势 ----
  await ev(MARK)
  await evAsync(BURST({ frames: 12, dx: -60, dy: -40 }))
  await sleep(400)
  await evAsync(BURST({ frames: 12, dx: 90, dy: 60 }))
  await sleep(700)
  const sTwo = JSON.parse(await ev(COLLECT))
  check('静置 400ms 后的第二次手势单独重排：共 2 次（合并窗不把两次手势并成一次）',
    sTwo.layoutRuns === 2 && sTwo.ro >= 20, { layoutRuns: sTwo.layoutRuns, ro: sTwo.ro })

  // ---- D) 亚像素抖动门 ----
  await ev(MARK)
  await evAsync(BURST({ frames: 14, jitter: true, jitterPx: 1 }))
  await sleep(600)
  const sJit = JSON.parse(await ev(COLLECT))
  check('±1px 抖动：回调照常来，一次重排都不做（VIEWPORT_EPSILON=2）',
    sJit.resizeCalls >= 10 && sJit.layoutRuns === 0 && sJit.timers200 === 0,
    { resizeCalls: sJit.resizeCalls, layoutRuns: sJit.layoutRuns, timers200: sJit.timers200 })
  await ev(MARK)
  await evAsync(BURST({ frames: 6, dx: -8, dy: -6 }))
  await sleep(700)
  const sJit2 = JSON.parse(await ev(COLLECT))
  check('抖动之后一次真变化（8px）→ 1 次重排，尺寸取抖动后的最终值（无滞后）',
    sJit2.layoutRuns === 1 &&
      near(sJit2.autoscaleArgs[0], sJit2.lastROSize.width, 2) &&
      near(sJit2.autoscaleArgs[1], sJit2.lastROSize.height, 2),
    { autoscaleArgs: sJit2.autoscaleArgs, lastROSize: sJit2.lastROSize })

  // ---- E) 改造前链路重放（同一手势） ----
  await rebase(ev, cdp)
  const mOld0 = await cdp.metrics()
  await ev(SILENCE(true))
  await ev(MARK)
  const burstOld = JSON.parse(await evAsync(BURST({ frames: 34, dx: -420, dy: -260, mode: 'old' })))
  await sleep(600)
  const sOld = JSON.parse(await ev(COLLECT))
  const oldMetrics = diff(mOld0, await cdp.metrics())
  await ev(SILENCE(false))
  check('改造前：同一手势每帧一次重排（帧数 = 重排数）',
    sOld.layoutRuns === burstOld.steps && burstOld.steps === 34,
    { layoutRuns: sOld.layoutRuns, steps: burstOld.steps })
  check('改造前：setter 无条件写，每帧各一次（scaleViewport + clipViewport）',
    sOld.scaleWrites === 34 && sOld.clipWrites === 34,
    { scaleWrites: sOld.scaleWrites, clipWrites: sOld.clipWrites })
  check('改造前：写完样式再读布局 —— 每帧 1 次强制同步布局、2 次布局读取',
    sOld.forcedInLayout === 34 && sOld.readsInLayout === 68,
    { forcedInLayout: sOld.forcedInLayout, readsInLayout: sOld.readsInLayout })
  check('改造前：每次重排都重挂 50ms 滚动定时器',
    sOld.timers50 >= 34, { timers50: sOld.timers50 })
  check('治理收益（同手势 34 帧）：重排 34→1、强制重排 34→0、setter 写 68→0、50ms 定时器 34→≤1',
    sOld.layoutRuns === 34 && sNew.layoutRuns === 1 &&
      sOld.forcedInLayout === 34 && sNew.forcedInLayout === 0 &&
      sOld.scaleWrites + sOld.clipWrites === 68 && sNew.scaleWrites + sNew.clipWrites === 0,
    {
      old: { runs: sOld.layoutRuns, forced: sOld.forcedInLayout, setterWrites: sOld.scaleWrites + sOld.clipWrites, timers50: sOld.timers50 },
      now: { runs: sNew.layoutRuns, forced: sNew.forcedInLayout, setterWrites: sNew.scaleWrites + sNew.clipWrites, timers50: sNew.timers50 }
    })
  check('CDP 度量对照：改造前一轮手势的样式重算/布局次数不低于现状',
    oldMetrics.RecalcStyleCount >= newMetrics.RecalcStyleCount &&
      oldMetrics.LayoutCount >= newMetrics.LayoutCount,
    { old: oldMetrics, now: newMetrics })

  // ---- F) 会话内缩放开关（R1 三层优先级的运行时面） ----
  await rebase(ev, cdp)
  await ev(MARK)
  const click1 = await ev(TOGGLE_SCALE_SWITCH)
  await sleep(500)
  const sOff = JSON.parse(await ev(COLLECT))
  const fitOff = JSON.parse(await ev(FIT_STATE))
  check('VNC 顶栏的缩放开关可点', click1 === 'clicked')
  check('关掉缩放：1 次 scaleViewport 写、0 次 clipViewport 写、不重连',
    sOff.scaleWrites === 1 && sOff.clipWrites === 0 && sOff.rfbBuilt === 0 && sOff.createTerm === 0, sOff)
  check('关掉缩放：fit 类移除、视口恢复可滚动、不再 autoscale（原始尺寸平铺）',
    fitOff.fit === false && fitOff.viewportOverflow !== 'hidden' && sOff.autoscale === 0, fitOff)
  await cdp.shot(path.join(SHOT_DIR, '03-fit-off.png'))
  await ev(MARK)
  await ev(TOGGLE_SCALE_SWITCH)
  await sleep(500)
  const sOn = JSON.parse(await ev(COLLECT))
  const fitOn = JSON.parse(await ev(FIT_STATE))
  check('重新打开缩放：1 次写 + 1 次 autoscale，仍不重连（noVNC setter 是 live 的）',
    sOn.scaleWrites === 1 && sOn.autoscale === 1 && fitOn.fit === true && sOn.rfbBuilt === 0,
    { writes: sOn.scaleWrites, autoscale: sOn.autoscale, fit: fitOn.fit })

  // ---- G) 顶栏重连：走产品链路重建，并看大窗下的首连尺寸提示 ----
  // 这里同时收掉台账里"VNC 要不要跟 RDP 一样夹到 MAX_DESKTOP"那一问：
  // RDP 的宽高是给 freerdp 建桌面用的（不夹就是让对端真开 2560 的帧缓冲），
  // VNC 的首连宽高只是拼进 wsUrl、落到中继的 this.width/this.height 当诊断值，
  // 桌面尺寸由远端 VNC server 决定，客户端从不调 setDesktopSize/resizeSession。
  await ev(CLEAR_BOX)
  await sleep(700)
  await ev(PIN_BOX({ width: 2560, height: 1440 }))
  await sleep(700)
  const boxG = JSON.parse(await ev(READ_BOX))
  await ev(MARK)
  const reconnect = await ev(CLICK_RECONNECT)
  const rebuilt = await waitFor(cdp,
    '(() => window.__vp.rfbBuilt === 1 ? JSON.stringify(window.__vp.lastUrl) : null)()',
    'reconnect rebuilds the session at the big viewport', 20000)
  const bigUrl = rebuilt ? JSON.parse(rebuilt) : String(await ev('window.__vp.lastUrl'))
  const bigSize = /&width=([0-9]+)&height=([0-9]+)$/.exec(bigUrl) || []
  const sReconnect = JSON.parse(await ev(COLLECT))
  check('顶栏重连图标走产品链路重建会话（旧 RFB 先断开、再重新 create-terminal）',
    reconnect === 'clicked' && sReconnect.rfbBuilt === 1 &&
      sReconnect.createTerm === 1 && sReconnect.disconnected === 1,
    { clicked: reconnect, ...sReconnect })
  check('重连的首连尺寸提示取重连时的实测视口（R2 口径在重连路径同样成立）',
    !!bigSize[1] && near(bigSize[1], boxG.mountWidth, 4) && near(bigSize[2], boxG.mountHeight, 4),
    { hint: [Number(bigSize[1]), Number(bigSize[2])], mount: [boxG.mountWidth, boxG.mountHeight], url: bigUrl })
  const vncResizeCalls = await vncAsksRemoteResize()
  const noClampName = '大窗（挂载节点实测 ' + boxG.mountWidth + 'x' + boxG.mountHeight +
    '）下 VNC 的首连提示不做 1920 夹取：该值只是中继诊断，桌面尺寸由 server 定'
  check(noClampName,
    Number(bigSize[1]) > 1920 && vncResizeCalls.length === 0,
    {
      hint: [Number(bigSize[1]), Number(bigSize[2])],
      box: boxG,
      // 命中即说明有人给 VNC 接上了改桌面尺寸的通道（台账 §2 P-6/D5），
      // 那时这条判据必须换成"夹到 MAX_DESKTOP 再发"
      resizeApiHits: vncResizeCalls
    })

  // ---- H) 计数台账入图 ----
  await ev(CLEAR_BOX)
  await sleep(900)
  await ev(PANEL([
    '手势：34 帧改窗（第 20 帧后卡顿 120ms）',
    'RO 回调 / 视口尺寸变化回调：' + sNew.ro + ' / ' + sNew.resizeCalls,
    '重排次数：现状 ' + sNew.layoutRuns + '  vs  改造前 ' + sOld.layoutRuns,
    '强制同步布局：现状 ' + sNew.forcedInLayout + '  vs  改造前 ' + sOld.forcedInLayout,
    '重排内布局读取：现状 ' + sNew.readsInLayout + '  vs  改造前 ' + sOld.readsInLayout,
    'noVNC setter 写：现状 ' + (sNew.scaleWrites + sNew.clipWrites) + '  vs  改造前 ' + (sOld.scaleWrites + sOld.clipWrites),
    '50ms 定时器重挂：现状 ' + sNew.timers50 + '  vs  改造前 ' + sOld.timers50,
    '200ms 合并窗重挂：现状 ' + sNew.timers200 + ' 次（只生效 1 次）',
    '抖动门：14 帧 ±1px → 回调 ' + sJit.resizeCalls + ' 次、重排 ' + sJit.layoutRuns + ' 次',
    'CDP LayoutCount / RecalcStyleCount 增量：现状 ' + newMetrics.LayoutCount + ' / ' + newMetrics.RecalcStyleCount +
      '  vs  改造前 ' + oldMetrics.LayoutCount + ' / ' + oldMetrics.RecalcStyleCount,
    '顶栏重连：旧 RFB 断开 ' + sReconnect.disconnected + ' 次、create-terminal ' + sReconnect.createTerm +
      ' 次、RFB 重建 ' + sReconnect.rfbBuilt + ' 次',
    '大窗（挂载节点实测 ' + boxG.mountWidth + 'x' + boxG.mountHeight + '）首连提示：' +
      (bigSize[1] || '?') + 'x' + (bigSize[2] || '?') +
      ' —— VNC 不夹到 1920x1080（该值只进中继诊断，桌面尺寸由 server 定；RDP 才需要夹）',
    '远端：假 RFB，全程无真 VNC；拖窗与缩放开关期间 0 次重连'
  ]))
  await sleep(300)
  await cdp.shot(path.join(SHOT_DIR, '04-counters.png'))

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
