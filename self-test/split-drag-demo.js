#!/usr/bin/env node
/**
 * 分屏分隔条拖动 —— CDP 实机回归（覆盖本机配置里的 ssh / vnc / rdp / database 页面）
 *
 * 钉的是 S2-4（#4549）那套"按比例存"的拖动链路，跑在真实页面 + 真实鼠标上：
 *   1) 把手 DOM 契约：数量 == splitConfig[layout].handle，轴向类 == handleAxis()，
 *      中心压在两格之间的缝上；
 *   2) 拖动机制：按下即 body.split-dragging(+轴) / 把手 .dragging / 禁选中 / 光标覆盖，
 *      拖动中只改 store.splitRatios，**不写 localStorage**（松手才落盘一次）；
 *      位移以"按下时那份比例"为基准累计 —— 拖过去再拖回来必须落回原比例；
 *   3) 数值契约：新比例 == dragRatio 的结果（oracle 从 split-ratios.js 原文件加载，
 *      不抄实现），缝宽恒 4px，格子不重叠、不越出 .layout-wrap；
 *   4) 夹逼：往死里拖每格仍 >= MIN_PANE_PX - 缝宽（模型夹的是槽位，格子每贴一条缝
 *      让出 2px），比例留在 (0,1) 且同轴单调（c3/r3）；
 *   5) 比例的真意义：开左栏挤压 termWidth 后格子宽度跟着**比例**走而不是跟着像素走；
 *      reload 后从 localStorage 还原回拖出来的那个比例；
 *   6) 页面覆盖：ssh 终端 / RDP / VNC / 数据库四种真实页面各占一格，拖动时
 *      xterm 内容盒不溢出、RDP 画布 CSS 盒仍等于视口（d41a3e3d 修的那条缩放链不被
 *      分屏打断）、VNC 走"合并窗重排 + setter 判等"、数据库面板跟着格子缩；
 *      同格里的本机 PTY 页签也用真鼠标点过去再点回来，本地终端同样跟着格子。
 *
 * ⚠️ 绝不真连远端：本机书签里的 ssh/vnc/rdp/database 全部走页面内替身
 *    （create-terminal 在 renderer 侧截获、RDP 换假 wasm 会话、VNC 换假 RFB、
 *     库层 runGlobalAsync 只记账），拖的是真组件真 DOM，但不碰局域网主机。
 *    ssh/telnet 直接回 error 走组件的"连不上"分支；vnc/rdp 需要一个 port 才建得起
 *    会话，给的是本测试自己占着、连上即 RST 的监听口，撞不到别的终端服务。
 *    RDP/VNC 的自适应开关按产品自己的口径打开（书签 scaleViewport，内存副本兜底）。
 *
 * 隔离：DATA_PATH 用本机 users/default_user 的**副本**；起实例时保留真 session bus
 *      （不用 dbus-run-session），否则 safeStorage 拿不到钥匙环、书签全成空壳。
 *      临时 HOME / XDG_CONFIG_HOME / TMPDIR 自建自删，只杀自己 spawn 的进程组。
 *
 * 用法：
 *   1) 渲染层改过就 npm run compile（跑的是 work/app 里的产物）
 *   2) Xvfb <display> 起好（默认 :131）
 *   3) node self-test/split-drag-demo.js [display] [port] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { getJson, Cdp, sleep, findPageTarget } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':131'
const PORT = process.argv[3] || '9372'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/2026-11-05-split-drag-shots')
const SRC_USER_DIR = path.join(os.homedir(), '.config/electerm/users/default_user')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-splitdrag-'))
const LOG_FILE = path.join(RUN, 'app.log')
let childPid = null

const J = v => JSON.stringify(v)
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + brief(detail)))
}
const info = (name, detail) => console.log('INFO  ' + name + ' :: ' + brief(detail))
const brief = o => (typeof o === 'string' ? o : JSON.stringify(o)).slice(0, 320)
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol

// ---------------------------------------------------------------- oracle
// 判据不抄实现：把 src 里那份 split-ratios.js 原文件当 ESM 直接 import 进来当 oracle
// （仓库不是 type:module，所以拷一份 .mjs 到临时目录再 import，随临时目录一起删）
async function loadOracle () {
  const file = path.join(ROOT, 'src/client/components/layout/split-ratios.js')
  const copy = path.join(RUN, 'split-ratios.oracle.mjs')
  fs.copyFileSync(file, copy)
  return await import(pathToFileURL(copy).href)
}
let ORACLE = null

const SPLIT_CONFIG = {
  c1: { children: 1, handle: 0 },
  c2: { children: 2, handle: 1 },
  c3: { children: 3, handle: 2 },
  r2: { children: 2, handle: 1 },
  r3: { children: 3, handle: 2 },
  c2x2: { children: 4, handle: 2 },
  c1r2: { children: 3, handle: 2 },
  r1c2: { children: 3, handle: 2 }
}
const GAP = 2 // layout-alg 两格各让 2px，合计 4px 缝

// ---------------------------------------------------------------- launch / teardown
function seed () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'data/users/default_user'), { recursive: true })
  const copied = []
  for (const f of ['electerm.db', 'electerm_data.db', 'storage-key.enc', 'vault.json']) {
    const s = path.join(SRC_USER_DIR, f)
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, path.join(RUN, 'data/users/default_user', f))
      copied.push(f)
    }
  }
  return copied
}

function launch () {
  const env = {
    ...process.env,
    DISPLAY,
    HOME: path.join(RUN, 'home'),
    XDG_CONFIG_HOME: path.join(RUN, 'config'),
    TMPDIR: path.join(RUN, 'tmp'),
    DATA_PATH: path.join(RUN, 'data')
  }
  // 保留真 session bus：书签行是 safeStorage 密文，换一条干净总线拿不到钥匙环
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  child.unref()
  childPid = child.pid
  return child
}

// 假 create-terminal 还给渲染层一个"终端数据端口"：指到本机一个连上就 RST 的
// 监听口，整轮都由本测试占着。这样 term-socket 只会走到"连不上"，
// 既不会拨局域网，也不可能撞进别的 electerm 实例的真终端服务。
let deadTerm = null
function startDeadTerm () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(sock => sock.destroy())
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      deadTerm = srv
      resolve(srv.address().port)
    })
  })
}

function killInstance () {
  if (deadTerm) {
    try { deadTerm.close() } catch (e) {}
    deadTerm = null
  }
  if (!childPid) return Promise.resolve()
  try {
    const cmd = fs.readFileSync('/proc/' + childPid + '/cmdline', 'utf8')
    if (cmd.indexOf('electron') < 0) {
      console.error('pid ' + childPid + ' 已经不是本 lane 的 electron，不动它')
      return Promise.resolve()
    }
  } catch (e) { /* 已经没了 */ }
  try { process.kill(-childPid, 'SIGTERM') } catch (e) {
    try { process.kill(childPid, 'SIGTERM') } catch (e2) {}
  }
  return sleep(2000)
}

async function connectCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const page = list && findPageTarget(list)
    if (page) {
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      cdp.events.length = 0
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

async function evalRetry (cdp, expr, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cdp.eval(expr)
    } catch (e) {
      await sleep(700)
    }
  }
  throw new Error('表达式始终跑不出来：' + expr.slice(0, 60))
}

// ---------------------------------------------------------------- in-page fakes
const DB_STUB = `(() => {
  const w = window.__dbStub = { calls: [], openDbTab: [], closeDbTab: [] }
  const pre = window.pre
  const real = pre.runGlobalAsync.bind(pre)
  pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab') { w.openDbTab.push(String(a[0])); return Promise.resolve({ ok: true }) }
    if (name === 'closeDbTab') { w.closeDbTab.push(String(a[0])); return Promise.resolve(null) }
    if (name === 'dbClientOp') {
      w.calls.push('dbClientOp:' + a[1])
      const op = a[1]
      if (op === 'getMetadata' || op === 'getSchemas') return Promise.resolve([])
      if (op === 'getTableStructure') return Promise.resolve({ columns: [], foreignKeys: [] })
      if (op === 'countRows') return Promise.resolve({ count: 0 })
      if (op === 'getPageData') return Promise.resolve({ rows: [], totalRows: 0, hasMore: false })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    return real(name, ...a)
  }
  return 'db-stub'
})()`

// 假 IronRDP：桌面尺寸故意与请求值不同，让"服务端给的尺寸 -> 画布 CSS 盒"这条 fit 链真走一遍
const RDP_FAKE = `(() => {
  const f = window.__rdpFake = { built: 0, connects: 0, runs: 0, frees: 0, shutdown: 0, inputs: 0, requested: null, canvas: null, painted: 0, dest: null, user: null }
  const DESKTOP = { width: 1280, height: 720 }
  class Extension { constructor (name, value) { this.name = name; this.value = value } }
  class DesktopSize { constructor (w, h) { this.width = w; this.height = h; f.requested = { width: w, height: h } } }
  class InputTransaction { addEvent () { return this } }
  class DeviceEvent {
    static keyPressed () { return new DeviceEvent() }
    static keyReleased () { return new DeviceEvent() }
    static mouseMove () { return new DeviceEvent() }
    static mouseButtonPressed () { return new DeviceEvent() }
    static mouseButtonReleased () { return new DeviceEvent() }
    static wheelRotations () { return new DeviceEvent() }
  }
  class ClipboardData {
    addText () { return this }
    isEmpty () { return true }
    items () { return [] }
  }
  class SessionBuilder {
    constructor () { f.built++; this._cbs = {} }
    username (v) { this.u = v; f.user = String(v || ''); return this }
    password (v) { return this }
    serverDomain (v) { return this }
    destination (v) { f.dest = String(v || ''); return this }
    proxyAddress (v) { return this }
    authToken () { return this }
    desktopSize (s) { return this }
    renderCanvas (c) { this.canvas = c; f.canvas = c; return this }
    extension () { return this }
    remoteClipboardChangedCallback (cb) { this._cbs.rc = cb; return this }
    forceClipboardUpdateCallback (cb) { this._cbs.fc = cb; return this }
    setCursorStyleCallbackContext () { return this }
    setCursorStyleCallback (cb) { this._cbs.cursor = cb; return this }
    connect () {
      f.connects++
      const canvas = this.canvas
      const pending = new Promise((resolve) => { f.endRun = () => resolve({ reason: () => 'fake-ended' }) })
      const session = {
        desktopSize: () => ({ width: DESKTOP.width, height: DESKTOP.height }),
        run: () => {
          f.runs++
          try {
            const ctx = canvas.getContext('2d')
            const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
            g.addColorStop(0, '#12233b'); g.addColorStop(0.5, '#2b6a8f'); g.addColorStop(1, '#175c56')
            ctx.fillStyle = g
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.fillStyle = '#eaf4fb'
            ctx.font = 'bold 40px monospace'
            ctx.fillText('fake RDP desktop ' + canvas.width + 'x' + canvas.height, 50, 110)
            ctx.fillRect(30, canvas.height - 70, canvas.width - 60, 40)
            f.painted++
          } catch (e) { /* 画布拿不到不影响判据 */ }
          return pending
        },
        applyInputs: () => { f.inputs++ },
        invokeExtension: () => {},
        onClipboardPaste: () => Promise.resolve(),
        shutdown: () => { f.shutdown++; f.endRun && f.endRun() },
        free: () => { f.frees++ }
      }
      this._cbs.cursor && this._cbs.cursor.call(canvas, 'default')
      return Promise.resolve(session)
    }
  }
  window.ironRdp = {
    wasmInit: () => Promise.resolve(),
    wasmSetup: () => {},
    SessionBuilder,
    DesktopSize,
    InputTransaction,
    DeviceEvent,
    Extension,
    ClipboardData
  }
  return 'rdp-fake'
})()`

// 假 noVNC RFB：只实现 vnc-session 用到的接口，样式写入与真实现同构
const VNC_FAKE = `(() => {
  const vp = window.__vncFake = { built: 0, autoscale: 0, lastScale: null, sets: {}, disconnected: 0, createTerm: 0 }
  const DESKTOP = { width: 1280, height: 800 }
  const bump = k => { vp.sets[k] = (vp.sets[k] || 0) + 1 }
  class FakeRFB extends EventTarget {
    constructor (mount, url, opts) {
      super()
      vp.built++
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
      canvas.style.background = 'linear-gradient(135deg, #3b1d5e 0%, #7b4397 45%, #dc2430 100%)'
      canvas.style.color = '#f6eefc'
      canvas.style.fontFamily = 'monospace'
      canvas.style.fontSize = '16px'
      canvas.style.padding = '10px'
      canvas.textContent = 'fake vnc desktop ' + DESKTOP.width + 'x' + DESKTOP.height
      screen.appendChild(canvas)
      mount.appendChild(screen)
      this.screen = screen
      this.canvas = canvas
      this.disconnect = () => { vp.disconnected++; screen.remove() }
      this.sendCtrlAltDel = () => {}
      this.clipboardPasteFrom = () => {}
      this.approveServer = () => {}
      this.sendCredentials = () => {}
      this._display = {
        scale: 1,
        autoscale: (w, h) => {
          vp.autoscale++
          const s = Math.min(w / DESKTOP.width, h / DESKTOP.height)
          vp.lastScale = { box: [Math.round(w), Math.round(h)], scale: Number(s.toFixed(4)) }
          this._display.scale = s
          const pw = Math.round(DESKTOP.width * s)
          const ph = Math.round(DESKTOP.height * s)
          canvas.style.width = pw + 'px'
          canvas.style.height = ph + 'px'
          canvas.textContent = 'fake vnc desktop ' + DESKTOP.width + 'x' + DESKTOP.height + ' -> ' + pw + 'x' + ph
        },
        _rescale: (s) => { this._display.autoscale(DESKTOP.width * s, DESKTOP.height * s) }
      }
      let sv = false
      let cv = false
      Object.defineProperty(this, 'scaleViewport', {
        configurable: true, get: () => sv,
        set: (v) => { bump('scaleViewport'); sv = v; screen.style.outline = v ? '3px solid rgba(230,120,40,.95)' : 'none' }
      })
      Object.defineProperty(this, 'clipViewport', {
        configurable: true, get: () => cv,
        set: (v) => { bump('clipViewport'); cv = v; screen.style.overflow = v ? 'hidden' : 'auto' }
      })
      Object.defineProperty(this, 'viewOnly', { configurable: true, get: () => false, set: () => bump('viewOnly') })
      for (const k of ['qualityLevel', 'compressionLevel', 'showDotCursor']) {
        Object.defineProperty(this, k, { configurable: true, get: () => 0, set: () => bump(k) })
      }
      setTimeout(() => {
        this.dispatchEvent(new CustomEvent('connect', { detail: {} }))
        this.dispatchEvent(new CustomEvent('desktopname', { detail: { name: 'fake-desktop' } }))
      }, 30)
    }
  }
  window.novnc = { RFB: FakeRFB }
  return 'vnc-fake'
})()`

// renderer 侧截获 create-terminal：ssh/vnc/rdp 的拨号不会离开本机
//  - vnc/rdp/spice：给一个假 pid + "连上即 RST"的本机端口，页面照常用假会话渲染
//  - ssh/telnet：直接回 error，走组件自己的"连不上"分支；否则 term-socket 会拿着
//    假 port 去拉 sftp 通道（initWs 拿不到 socket → ws.s 报 TypeError），噪声盖住真判据
const WS_STUB = `(() => {
  const w = window.__wsStub = { intercepted: {}, passed: 0 }
  const ws = window.et && window.et.commonWs
  if (!ws) return 'no-common-ws'
  const proto = Object.getPrototypeOf(ws)
  const origS = proto.s
  const origOnce = proto.once
  const cbs = {}
  proto.once = function (func, id) { cbs[id] = func; return origOnce.apply(this, arguments) }
  proto.s = function (data) {
    const body = data && data.body
    const t = body && body.termType
    if (data && data.action === 'create-terminal' && (t === 'vnc' || t === 'rdp' || t === 'spice' || t === 'ssh' || t === 'telnet')) {
      w.intercepted[t] = (w.intercepted[t] || 0) + 1
      if (t === 'vnc') window.__vncFake.createTerm++
      const cb = cbs[data.id]
      delete cbs[data.id]
      const payload = (t === 'ssh' || t === 'telnet')
        ? { error: { message: 'split-drag demo: 不真连远端' } }
        : { data: { pid: 'fake-' + t + '-' + w.intercepted[t], port: window.__deadTermPort } }
      setTimeout(() => { cb && cb(payload) }, 20)
      return
    }
    w.passed++
    return origS.apply(this, arguments)
  }
  return 'ws-stub'
})()`

// ---------------------------------------------------------------- in-page probes
const STATE = `(() => {
  const st = window.store
  const layout = st.layout
  const wrap = document.querySelector('.layout-wrap.layout-wrap-' + layout)
  const rs = el => {
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  // 窗格序号从类名 v1/v2/... 取（layouts.jsx 只给 className，没有 data-batch）
  const paneBatch = el => {
    const m = /(^|\\s)v(\\d+)(\\s|$)/.exec(el.className)
    return m ? Number(m[2]) - 1 : -1
  }
  const panes = wrap ? Array.from(wrap.querySelectorAll(':scope > .layout-item')).map(el => ({
    batch: paneBatch(el),
    rect: rs(el),
    cursor: getComputedStyle(el).cursor,
    userSelect: getComputedStyle(el).userSelect
  })) : []
  const handles = wrap ? Array.from(wrap.querySelectorAll(':scope > .layout-handle')).map(el => ({
    index: Number(el.dataset.index),
    axis: /(^|\\s)x(\\s|$)/.test(el.className) ? 'x' : (/(^|\\s)y(\\s|$)/.test(el.className) ? 'y' : ''),
    dragging: el.classList.contains('dragging'),
    rect: rs(el)
  })) : []
  let ls = null
  try { ls = JSON.parse(localStorage.getItem('splitRatios') || 'null') } catch (e) { ls = 'PARSE-ERR' }
  const body = document.body.classList
  return JSON.stringify({
    layout,
    ratios: (st.splitRatios || {})[layout] || null,
    ls,
    wrap: wrap ? rs(wrap) : null,
    panes,
    handles,
    drag: { root: body.contains('split-dragging'), x: body.contains('split-dragging-x'), y: body.contains('split-dragging-y') }
  })
})()`

const INVENTORY = `(() => {
  const st = window.store
  const bm = st.bookmarks || []
  const byType = {}
  const pick = {}
  for (const b of bm) {
    const t = String(b.type)
    byType[t] = (byType[t] || 0) + 1
    if (!pick[t]) pick[t] = { id: b.id, title: String(b.title || ''), host: String(b.host || ''), port: b.port, dbType: b.dbType, scaleViewport: b.scaleViewport }
  }
  return JSON.stringify({
    total: bm.length,
    byType,
    pick,
    tabs: (st.tabs || []).map(t => ({ id: t.id, type: t.type, title: String(t.title || ''), batch: t.batch })),
    config: { onStartSessions: (st.config.onStartSessions || []).length, restore: st.config.restoreLastSession, initTab: st.config.initDefaultTabOnStart },
    layout: st.layout,
    dpr: window.devicePixelRatio
  })
})()`

const CONTENT = `(() => {
  const st = window.store
  const num = v => Math.round(v)
  const box = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: num(r.left), t: num(r.top), r: num(r.right), b: num(r.bottom), w: num(r.width), h: num(r.height) }
  }
  const paneBatch = el => {
    const m = /(^|\\s)v(\\d+)(\\s|$)/.exec(el.className)
    return m ? Number(m[2]) - 1 : -1
  }
  const wrap = document.querySelector('.layout-wrap.layout-wrap-' + st.layout)
  const items = wrap ? Array.from(wrap.querySelectorAll(':scope > .layout-item')) : []
  // 会话内容不在 .layout-item 里：sessions.jsx 把每个页签渲染成 .session-<id>，
  // 用同一套格子样式定位；格子里只有那一格的标签栏
  const panes = items.map(el => {
    const batch = paneBatch(el)
    const tabId = st['activeTabId' + batch] || ''
    const tab = (st.tabs || []).find(t => t.id === tabId) || {}
    const root = tabId ? document.querySelector('.session-' + CSS.escape(tabId)) : null
    const q = s => root ? root.querySelector(s) : null
    return {
      batch,
      tabId,
      type: tab.type,
      title: String(tab.title || ''),
      status: tab.status,
      pane: box(el),
      session: box(root),
      xtermScreen: box(q('.xterm-screen')),
      termCard: box(q('.term-card')),
      viewport: box(q('.remote-session-viewport')),
      wrapCls: (() => { const w = q('.remote-session-wrap'); return w ? String(w.className) : '' })(),
      rdpCanvas: (() => { const c = q('canvas.rdp-canvas'); if (!c) return null; const b = box(c); b.iw = c.width; b.ih = c.height; b.objectFit = getComputedStyle(c).objectFit; return b })(),
      vncCanvas: box(q('.fake-vnc-canvas')),
      dbBody: box(q('.db-body'))
    }
  })
  return JSON.stringify({ panes })
})()`

// 将手指在哪：把手是 6px 命中带，c2x2 的两根在交叉点互相盖住，
// 所以按下点要沿长轴找一段"topmost 就是这根把手"的位置
const PRESS = `(() => {
  const st = window.store
  const wrap = document.querySelector('.layout-wrap.layout-wrap-' + st.layout)
  const hs = wrap ? Array.from(wrap.querySelectorAll(':scope > .layout-handle')) : []
  const FR = [0.25, 0.15, 0.35, 0.5, 0.65, 0.85, 0.1, 0.9]
  return JSON.stringify(hs.map(el => {
    const r = el.getBoundingClientRect()
    const axis = /(^|\\s)x(\\s|$)/.test(el.className) ? 'x' : 'y'
    const tries = []
    let point = null
    for (const f of FR) {
      const x = axis === 'x' ? r.left + r.width / 2 : r.left + r.width * f
      const y = axis === 'x' ? r.top + r.height * f : r.top + r.height / 2
      const px = Math.round(x)
      const py = Math.round(y)
      const top = document.elementFromPoint(px, py)
      const ok = !!top && (top === el || el.contains(top))
      tries.push({ f, ok, hit: top ? String(top.className || top.tagName) : null })
      if (ok && !point) point = { x: px, y: py }
    }
    return {
      index: Number(el.dataset.index),
      axis,
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      point,
      tries
    }
  }))
})()`

// 每格的页签分布（activeTabId0..7 是 store 里各格的激活页签）
const TABS = `(() => {
  const st = window.store
  const act = []
  for (let i = 0; i < 8; i++) act.push(String(st['activeTabId' + i] || ''))
  return JSON.stringify({
    activeByPane: act,
    tabs: (st.tabs || []).map(t => ({ id: t.id, type: t.type, batch: t.batch, status: t.status, active: act.indexOf(String(t.id)) >= 0 }))
  })
})()`

// ---------------------------------------------------------------- drag primitives
async function state (cdp) {
  return JSON.parse(await cdp.eval(STATE))
}

async function content (cdp) {
  return JSON.parse(await cdp.eval(CONTENT))
}

async function waitContent (cdp, isReady, tries = 45) {
  let c = null
  for (let i = 0; i < tries; i++) {
    c = await content(cdp)
    if (isReady(c)) return c
    await sleep(300)
  }
  return c
}

/**
 * 真鼠标点某格的页签把它切激活，并回读 store 确认。
 * 点击判据挂在页签**里面的** .tab-title 上（tab.jsx 的 handleClick），外层 .tab 是
 * draggable 的容器，按它自己不会触发激活。
 */
async function clickTab (cdp, batch, tabId) {
  const p = await cdp.jeval(`(() => {
    const tab = document.querySelector('.tab[data-id=' + CSS.escape(${J(tabId)}) + ']')
    const el = tab && (tab.querySelector('.tab-title') || tab)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const top = document.elementFromPoint(x, y)
    return { x, y, hit: top ? String(top.className || top.tagName) : null }
  })()`)
  if (!p) return false
  await cdp.click(p.x, p.y)
  await sleep(250)
  const now = await cdp.jeval(`String(window.store['activeTabId${batch}'] || '')`)
  if (now !== String(tabId)) info('点页签没切过去（记录命中元素）', { want: tabId, now, point: p })
  return now === String(tabId)
}

async function mouse (cdp, type, x, y, extra) {
  await cdp.call('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), ...extra })
}

/** 真鼠标拖动，中途取样（钉"拖动中不落盘 / 按下态的类"），返回 { mid, delta } */
async function dragAndSample (cdp, x, y, dx, dy, steps = 6) {
  await mouse(cdp, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
  const half = Math.max(1, Math.floor(steps / 2))
  for (let i = 1; i <= half; i++) {
    await mouse(cdp, 'mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, { button: 'left', buttons: 1 })
  }
  const mid = await state(cdp)
  mid.__delta = { dx: (dx * half) / steps, dy: (dy * half) / steps }
  for (let i = half + 1; i <= steps; i++) {
    await mouse(cdp, 'mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, { button: 'left', buttons: 1 })
  }
  await mouse(cdp, 'mouseReleased', x + dx, y + dy, { button: 'left', buttons: 0, clickCount: 1 })
  await sleep(180)
  return mid
}

async function pressPoints (cdp) {
  return JSON.parse(await cdp.eval(PRESS))
}

function pointFor (pts, index) {
  const h = pts.find(x => x.index === index)
  if (!h || !h.point) return null
  return { x: h.point.x, y: h.point.y, axis: h.axis, tries: h.tries }
}

/**
 * 取该把手的按下点：沿长轴找一个"topmost 就是这根把手自己"的位置。
 * c2x2 里 x/y 两根在交叉点互相盖住，直接按矩形中心会抓到另一根。
 */
async function pressFor (cdp, index, label) {
  const pts = await pressPoints(cdp)
  const p = pointFor(pts, index)
  if (!p) {
    check(label + ' 把手有整段能被自己命中的按下点', false, pts.map(h => ({ index: h.index, axis: h.axis, tries: h.tries })))
  }
  return p
}

function termGeom (st) {
  const rects = st.panes.map(p => p.rect)
  const left = Math.min(...rects.map(r => r.l))
  const right = Math.max(...rects.map(r => r.r))
  const top = Math.min(...rects.map(r => r.t))
  const bottom = Math.max(...rects.map(r => r.b))
  return { left, top, width: right - left, height: bottom - top }
}

// 把手所在缝两侧：x 轴看竖向相交的那几格，y 轴看横向相交的那几格。
// 取样点用**按下点**（不是把手中心）：满跨的把手中心正好落在对面那条缝里，
// 拿它当带高会一格都筛不出来（c2x2 / c1r2 / r1c2 就是这样空掉的）。
function seamSides (st, index, press) {
  const h = st.handles.find(x => x.index === index)
  if (!h) return null
  const cx = h.rect.l + h.rect.w / 2
  const cy = h.rect.t + h.rect.h / 2
  if (h.axis === 'x') {
    const sy = press ? press.y : cy
    const band = st.panes.filter(p => p.rect.t - 1 <= sy && p.rect.b + 1 >= sy)
    return {
      axis: h.axis,
      before: band.filter(p => p.rect.r <= cx + 1),
      after: band.filter(p => p.rect.l >= cx - 1)
    }
  }
  const sx = press ? press.x : cx
  const band = st.panes.filter(p => p.rect.l - 1 <= sx && p.rect.r + 1 >= sx)
  return {
    axis: h.axis,
    before: band.filter(p => p.rect.b <= cy + 1),
    after: band.filter(p => p.rect.t >= cy - 1)
  }
}

const span = (arr, spec) => spec === 'x'
  ? Math.max(...arr.map(p => p.rect.r)) - Math.min(...arr.map(p => p.rect.l))
  : Math.max(...arr.map(p => p.rect.b)) - Math.min(...arr.map(p => p.rect.t))
const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9)

function checkDrag (label, layout, index, before, mid, after, dx, dy, press) {
  const spec = ORACLE.handleAxis(layout, index)
  if (!spec) {
    check(label + ' 有该把手的轴向定义', false, { layout, index })
    return
  }
  const geom = termGeom(before)
  const base = ORACLE.normalizeRatios(layout, before.ratios)
  const want = ORACLE.dragRatio(layout, index, base, spec === 'x' ? dx : dy, { width: geom.width, height: geom.height })

  check(label + ' 拖动中 body 带 split-dragging+' + spec,
    mid.drag.root && (spec === 'x' ? mid.drag.x : mid.drag.y) && !(spec === 'x' ? mid.drag.y : mid.drag.x), mid.drag)
  check(label + ' 拖动中把手自身 .dragging', mid.handles.some(h => h.index === index && h.dragging), mid.handles.map(h => [h.index, h.dragging]))
  check(label + ' 拖动中格子禁选中文本', mid.panes.every(p => p.userSelect === 'none'), mid.panes.map(p => p.userSelect))
  check(label + ' 拖动中光标压成 ' + (spec === 'x' ? 'col-resize' : 'row-resize'),
    mid.panes.every(p => p.cursor === (spec === 'x' ? 'col-resize' : 'row-resize')), mid.panes.map(p => p.cursor))

  // 拖动中：store 跟手（按中点位移算），localStorage 还没动
  const midDelta = mid.__delta || { dx, dy }
  const moved = (spec === 'x' ? midDelta.dx : midDelta.dy) / (spec === 'x' ? geom.width : geom.height)
  const ratioMid = mid.ratios && mid.ratios[index]
  check(label + ' 拖动中 store 比例跟手', typeof ratioMid === 'number' && Math.abs(ratioMid - (base[index] + moved)) < 0.02,
    { base: base[index], mid: ratioMid, expect: base[index] + moved })
  check(label + ' 拖动中不写 localStorage（松手才落一次盘）',
    JSON.stringify(mid.ls) === JSON.stringify(before.ls), { before: before.ls, mid: mid.ls })

  check(label + ' 松手后拖动态类清干净',
    !after.drag.root && !after.drag.x && !after.drag.y && after.handles.every(h => !h.dragging), after.drag)
  check(label + ' 松手后 localStorage 就是 store 里那份',
    after.ls && arrEq((after.ls || {})[layout], after.ratios), { ls: after.ls, store: after.ratios })
  check(label + ' 新比例 == dragRatio(源文件 oracle)', arrEq(after.ratios, want), { got: after.ratios, want })

  // 像素契约：缝内侧那组格子的**并集跨度** += 鼠标位移（c2x2 里内侧是两格，
  // 各自都变宽，所以不能加总宽度），总跨度不变，缝宽恒 4px
  const sBefore = seamSides(before, index, press)
  const sAfter = seamSides(after, index, press)
  const groupsOk = sBefore && sAfter &&
    sBefore.before.length > 0 && sBefore.after.length > 0 &&
    sAfter.before.length > 0 && sAfter.after.length > 0
  check(label + ' 缝两侧都取到格子（按下没抓到别的把手）', groupsOk,
    sBefore && sAfter && { ins: sBefore.before.map(p => p.batch), outs: sBefore.after.map(p => p.batch) })
  if (groupsOk) {
    const dB = span(sBefore.before, spec)
    const dA = span(sAfter.before, spec)
    check(label + ' 缝内侧格子跨度增量 == 鼠标位移（±2px）',
      near(dA - dB, spec === 'x' ? dx : dy, 2), { before: dB, after: dA, delta: spec === 'x' ? dx : dy })
    const g2 = termGeom(after)
    check(label + ' 终端区总' + (spec === 'x' ? '宽' : '高') + '不变（拖动只是重新分配）',
      near(spec === 'x' ? g2.width : g2.height, spec === 'x' ? geom.width : geom.height, 2),
      { before: spec === 'x' ? geom.width : geom.height, after: spec === 'x' ? g2.width : g2.height })
    // 缝宽取"拖完之后"那一帧：内侧格子的外沿到外侧格子的内沿（getBoundingClientRect
    // 是取整过的，所以容 1px）
    const innerEdge = spec === 'x' ? 'r' : 'b'
    const outerEdge = spec === 'x' ? 'l' : 't'
    const innerMax = Math.max(...sAfter.before.map(p => p.rect[innerEdge]))
    const outerMin = Math.min(...sAfter.after.map(p => p.rect[outerEdge]))
    check(label + ' 缝宽恒 4px（两格各让 2px）', near(outerMin - innerMax, 2 * GAP, 1), { innerMax, outerMin })
  }

  // 几何健康
  const w = after.wrap
  check(label + ' 格子都在 .layout-wrap 内',
    after.panes.every(p => p.rect.l >= w.l - 1 && p.rect.r <= w.r + 1 && p.rect.t >= w.t - 1 && p.rect.b <= w.b + 1),
    after.panes.map(p => p.rect))
  const overlap = []
  for (let i = 0; i < after.panes.length; i++) {
    for (let j = i + 1; j < after.panes.length; j++) {
      const a = after.panes[i].rect
      const b = after.panes[j].rect
      const ow = Math.min(a.r, b.r) - Math.max(a.l, b.l)
      const oh = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (ow > 0 && oh > 0) overlap.push([i, j, ow, oh])
    }
  }
  check(label + ' 格子互不重叠', overlap.length === 0, overlap)
}

// ---------------------------------------------------------------- main
let cdp = null
let stubCount = null
async function main () {
  ORACLE = await loadOracle()
  const copied = seed()
  info('本机 users/default_user 副本已种到临时 DATA_PATH', { copied, to: path.join(RUN, 'data/users/default_user') })
  if (!copied.length) console.error('本机没有可复制的 users/default_user，书签覆盖判据会退化成空')
  launch()
  cdp = await connectCdp()
  info('CDP 页面目标已连上', { port: PORT })

  await sleep(1500)
  const inv = JSON.parse(await evalRetry(cdp, INVENTORY))
  info('启动时页面状态', { dpr: inv.dpr, layout: inv.layout, tabs: inv.tabs.length, config: inv.config })
  check('本机书签可解密（不是只有 id 的空壳）',
    inv.total > 0 && inv.pick.ssh && !!inv.pick.ssh.host, { total: inv.total, byType: inv.byType })
  const need = ['ssh', 'vnc', 'rdp', 'database']
  check('本机配置覆盖 ssh / vnc / rdp / database 四类', need.every(t => (inv.byType[t] || 0) > 0), inv.byType)
  info('每类取用的书签（只留 title/host/type，凭据不外泄）', inv.pick)

  // 启动自动恢复不能真连：清空启动会话、关掉 last-session 恢复、关掉自动重连
  const deadPort = await startDeadTerm()
  await cdp.eval(`(() => {
    const st = window.store
    st.config.onStartSessions = []
    st.config.restoreLastSession = false
    st.config.autoReconnectTerminal = false
    window.__deadTermPort = ${deadPort}
    localStorage.removeItem('last-workspace')
    return 1
  })()`)
  info('假终端数据端口（连上即 RST，只在本机本测试手里）', { port: deadPort })

  check('库层替身装上', (await cdp.eval(DB_STUB)) === 'db-stub')
  check('假 IronRDP 装上（loadWasmModule 会短路）', (await cdp.eval(RDP_FAKE)) === 'rdp-fake')
  check('假 noVNC RFB 装上', (await cdp.eval(VNC_FAKE)) === 'vnc-fake')
  check('create-terminal 在 renderer 侧截获（不会拨号真远端）', (await cdp.eval(WS_STUB)) === 'ws-stub')

  // 自适应按产品口径开：书签没带就把内存里那份副本打开（不写磁盘）
  await cdp.eval(`(() => {
    for (const b of window.store.bookmarks) {
      if ((b.type === 'rdp' || b.type === 'vnc') && !b.scaleViewport) b.scaleViewport = true
    }
    return 1
  })()`)

  // ---- 四种真实页面各占一格
  await cdp.eval('window.store.setLayout(\'c2x2\', false)')
  await sleep(400)
  const wanted = [
    { type: 'ssh', pane: 0 },
    { type: 'rdp', pane: 1 },
    { type: 'vnc', pane: 2 },
    { type: 'database', pane: 3 }
  ]
  for (const w of wanted) {
    const id = inv.pick[w.type] && inv.pick[w.type].id
    if (!id) { info('本机没有 ' + w.type + ' 书签，跳过该格'); continue }
    await cdp.eval(`(() => { window.openTabBatch = ${w.pane}; window.store.onSelectBookmark(${J(id)}); return 1 })()`)
    await sleep(900)
  }
  // 页签可能和启动那台本机 PTY 挤在同一格：真点一下该格页签，把四类页面各自切激活
  for (const w of wanted) {
    if (!(inv.pick[w.type] && inv.pick[w.type].id)) continue
    const t = (await cdp.jeval(TABS)).tabs.find(x => x.type === w.type && x.batch === w.pane)
    if (!t) { info('没开出 ' + w.type + ' 页签（该格内容判据会退化）', w); continue }
    if (t.active) continue
    check(w.type + '：真点该格页签能把它切激活', await clickTab(cdp, w.pane, t.id), t)
  }
  const isReady = c => {
    const want = { ssh: 'xtermScreen', rdp: 'rdpCanvas', vnc: 'vncCanvas', database: 'dbBody' }
    return Object.keys(want).every(t => {
      const p = c.panes.find(x => x.type === t)
      return p && !!p[want[t]]
    })
  }
  const content0 = await waitContent(cdp, isReady)
  info('四格页签与内容（真页面，替身只接管远端连接）', content0.panes.map(p => ({ batch: p.batch, type: p.type, status: p.status, cls: p.wrapCls })))
  const byT = t => content0.panes.find(p => p.type === t)
  check('ssh 书签页在格子里（xterm 已挂载）', !!byT('ssh') && !!byT('ssh').xtermScreen, byT('ssh'))
  check('rdp 书签页在格子里（画布 + 视口，假桌面已画上）', !!byT('rdp') && !!byT('rdp').rdpCanvas && !!byT('rdp').viewport, byT('rdp'))
  check('vnc 书签页在格子里（假 RFB 桌面挂进视口）', !!byT('vnc') && !!byT('vnc').vncCanvas && !!byT('vnc').viewport, byT('vnc'))
  check('database 书签页在格子里（.db-body 已渲染）', !!byT('database') && !!byT('database').dbBody, byT('database'))
  const stubbed = JSON.parse(await cdp.eval('JSON.stringify(window.__wsStub.intercepted)'))
  check('远端页都只走到替身（create-terminal 被截获，未拨外网）', (stubbed.ssh || 0) > 0 && (stubbed.rdp || 0) > 0 && (stubbed.vnc || 0) > 0, stubbed)
  const rdpFake = await cdp.jeval('JSON.stringify({ connects: window.__rdpFake.connects, runs: window.__rdpFake.runs, painted: window.__rdpFake.painted, built: window.__rdpFake.built })')
  check('RDP 假会话真建起来了（builder 建 1 次、connect 1 次、run 1 次）',
    rdpFake.built === 1 && rdpFake.connects === 1 && rdpFake.runs === 1, rdpFake)
  await cdp.shot(path.join(SHOT_DIR, '00-c2x2-four-pages-before.png'))

  // ---- c2x2：两根把手（x / y）+ 拖动后各页面内容跟随
  {
    const layout = 'c2x2'
    let st = await state(cdp)
    check('c2x2 把手数量 == splitConfig.handle', st.handles.length === SPLIT_CONFIG[layout].handle, st.handles.map(h => h.index))
    check('c2x2 轴向类 == handleAxis()', st.handles.every(h => h.axis === ORACLE.handleAxis(layout, h.index)), st.handles.map(h => [h.index, h.axis]))
    for (const h of st.handles) {
      const c = await pressFor(cdp, h.index, 'c2x2#' + h.index)
      if (!c) continue
      const before = st
      const dx = h.axis === 'x' ? 160 : 0
      const dy = h.axis === 'y' ? 120 : 0
      const mid = await dragAndSample(cdp, c.x, c.y, dx, dy, 8)
      const after = await state(cdp)
      checkDrag('c2x2#' + h.index + '(' + h.axis + ')', layout, h.index, before, mid, after, dx, dy, c)
      await cdp.shot(path.join(SHOT_DIR, '01-c2x2-handle' + h.index + '-after.png'))
      st = after
    }

    // 拖过去再拖回来：以按下那份比例为基准累计，必须落回原值
    const beforeBack = await state(cdp)
    const base0 = beforeBack.ratios.slice()
    const c0 = await pressFor(cdp, 0, 'c2x2#0 往返')
    if (c0) {
      await dragAndSample(cdp, c0.x, c0.y, 90, 0, 5)
      const movedSt = await state(cdp)
      check('c2x2#0 拖 +90 后比例确实离开原值', Math.abs(movedSt.ratios[0] - base0[0]) > 0.02, { base: base0[0], moved: movedSt.ratios[0] })
      const c0b = await pressFor(cdp, 0, 'c2x2#0 往返回程')
      if (c0b) {
        await dragAndSample(cdp, c0b.x, c0b.y, -90, 0, 5)
        const back = await state(cdp)
        check('c2x2#0 再拖 -90 落回原比例（不做逐帧累加，所以能对得准）',
          back.ratios.every((v, i) => Math.abs(v - base0[i]) < 1e-6), { base: base0, back: back.ratios })
      }
    }

    // 拖动后：各页型内容仍住在自己格子里
    const c1 = await content(cdp)
    const fit = (p) => p && p.rdpCanvas && p.viewport &&
      near(p.rdpCanvas.l, p.viewport.l, 2) && near(p.rdpCanvas.t, p.viewport.t, 2) &&
      near(p.rdpCanvas.r, p.viewport.r, 2) && near(p.rdpCanvas.b, p.viewport.b, 2)
    const rdp1 = c1.panes.find(p => p.type === 'rdp')
    check('RDP：拖动后画布 CSS 盒仍等于视口（fit 缩放链不被分屏打断）', fit(rdp1), rdp1 && { canvas: rdp1.rdpCanvas, vp: rdp1.viewport, cls: rdp1.wrapCls })
    check('RDP：画布内在尺寸仍是服务端给的桌面尺寸', rdp1 && rdp1.rdpCanvas && rdp1.rdpCanvas.iw === 1280 && rdp1.rdpCanvas.ih === 720, rdp1 && rdp1.rdpCanvas)
    check('RDP：object-fit contain（等比不裁切）', rdp1 && rdp1.rdpCanvas && rdp1.rdpCanvas.objectFit === 'contain', rdp1 && rdp1.rdpCanvas && rdp1.rdpCanvas.objectFit)
    check('RDP：画布不超出所在格子', rdp1 && rdp1.rdpCanvas && rdp1.rdpCanvas.r <= rdp1.pane.r + 1 && rdp1.rdpCanvas.b <= rdp1.pane.b + 1, rdp1 && { canvas: rdp1.rdpCanvas, pane: rdp1.pane })
    const vnc1 = c1.panes.find(p => p.type === 'vnc')
    check('VNC：假桌面在拖动后仍不超出视口（等比缩放）',
      vnc1 && vnc1.vncCanvas && vnc1.viewport && vnc1.vncCanvas.w <= vnc1.viewport.w + 2 && vnc1.vncCanvas.h <= vnc1.viewport.h + 2,
      vnc1 && { canvas: vnc1.vncCanvas, vp: vnc1.viewport })
    const fake = await cdp.jeval('JSON.stringify(window.__vncFake)')
    check('VNC：拖动经合并窗走了一次重排（autoscale 计数增长）', fake.autoscale > 0, { autoscale: fake.autoscale, lastScale: fake.lastScale })
    check('VNC：纯拖动没有反复写 scaleViewport（setter 判等）', (fake.sets.scaleViewport || 0) <= 2, fake.sets)
    check('VNC：拖动不拆会话（RFB 重建 1 次、disconnect 0 次）', fake.built === 1 && fake.disconnected === 0, { built: fake.built, disconnected: fake.disconnected })
    const ssh1 = c1.panes.find(p => p.type === 'ssh')
    check('ssh 终端：xterm 内容盒不溢出所在格子', ssh1 && ssh1.xtermScreen && ssh1.xtermScreen.r <= ssh1.pane.r + 2 && ssh1.xtermScreen.b <= ssh1.pane.b + 2,
      ssh1 && { screen: ssh1.xtermScreen, pane: ssh1.pane })
    // 同格里的本机 PTY 页签（启动那台真终端）：真点过去，本地终端也照样跟着格子
    const tabList = (await cdp.jeval(TABS)).tabs
    info('c2x2 各格页签分布', tabList.map(t => [t.batch, t.type, t.status, t.active]))
    const local = tabList.find(t => t.batch === (ssh1 && ssh1.batch) && t.id !== ssh1.tabId)
    if (local) {
      check('本机 PTY 页签：真点页签切过去', await clickTab(cdp, local.batch, local.id), local)
      const cL = await content(cdp)
      const pL = cL.panes.find(p => p.batch === local.batch)
      check('本机 PTY 终端页：xterm 在格子内且宽高都不为 0',
        pL && pL.xtermScreen && pL.xtermScreen.w > 0 && pL.xtermScreen.h > 0 &&
        pL.xtermScreen.r <= pL.pane.r + 2 && pL.xtermScreen.b <= pL.pane.b + 2,
        pL && { screen: pL.xtermScreen, pane: pL.pane })
      await cdp.shot(path.join(SHOT_DIR, '01b-c2x2-local-pty.png'))
      check('切回 ssh 书签页', await clickTab(cdp, ssh1.batch, ssh1.tabId), { back: ssh1.tabId })
    } else info('本机 PTY 页签没和 ssh 页同格（启动页签分布见上），跳过该判据', tabList.map(t => [t.batch, t.type]))
    const db1 = c1.panes.find(p => p.type === 'database')
    check('数据库页：面板宽度随格子走（不溢出、不为 0）', db1 && db1.dbBody && db1.dbBody.w > 0 && db1.dbBody.r <= db1.pane.r + 2,
      db1 && { db: db1.dbBody, pane: db1.pane })
    // 数据库格子被拖动后宽度确实变了
    const db0w = (content0.panes.find(p => p.type === 'database') || {}).dbBody
    check('数据库页：面板宽度跟着这次拖动变了', db0w && db1 && Math.abs(db1.dbBody.w - db0w.w) > 20, { before: db0w && db0w.w, after: db1 && db1.dbBody.w })
  }

  // ---- 其余布局逐根把手
  for (const layout of ['c2', 'r2', 'c3', 'r3', 'c1r2', 'r1c2']) {
    await cdp.eval(`window.store.setLayout(${J(layout)}, false)`)
    await sleep(450)
    let st = await state(cdp)
    check(layout + ' 把手数量 == splitConfig.handle', st.handles.length === SPLIT_CONFIG[layout].handle, st.handles.map(h => h.index))
    check(layout + ' 轴向类 == handleAxis()', st.handles.every(h => h.axis === ORACLE.handleAxis(layout, h.index)), st.handles.map(h => [h.index, h.axis]))
    check(layout + ' 把手中心压在缝上（<=4px）', st.handles.every(h => {
      const centre = h.axis === 'x' ? h.rect.l + h.rect.w / 2 : h.rect.t + h.rect.h / 2
      const edges = h.axis === 'x' ? st.panes.map(p => p.rect.l).concat(st.panes.map(p => p.rect.r)) : st.panes.map(p => p.rect.t).concat(st.panes.map(p => p.rect.b))
      return edges.some(e => Math.abs(e - centre) <= 4)
    }), st.handles.map(h => ({ i: h.index, r: h.rect })))
    for (const h of st.handles) {
      const c = await pressFor(cdp, h.index, layout + '#' + h.index)
      if (!c) continue
      const before = st
      const dx = h.axis === 'x' ? (layout === 'c3' && h.index === 1 ? 80 : 120) : 0
      const dy = h.axis === 'y' ? (layout === 'r3' && h.index === 1 ? 70 : 100) : 0
      const mid = await dragAndSample(cdp, c.x, c.y, dx, dy, 7)
      const after = await state(cdp)
      checkDrag(layout + '#' + h.index + '(' + h.axis + ')', layout, h.index, before, mid, after, dx, dy, c)
      await cdp.shot(path.join(SHOT_DIR, '02-' + layout + '-handle' + h.index + '-after.png'))
      st = after
    }
    const min = ORACLE.MIN_PANE_PX
    // 模型夹的是"槽位"宽度（比例 × 容器），渲染出来的格子每贴一条缝就让出 2px，
    // 所以实测下限是 MIN_PANE_PX - 2*GAP，再容 2px 取整误差
    const floor = min - 2 * GAP - 2
    if (layout === 'c3' || layout === 'r3') {
      check(layout + ' 同轴两根把手没有互相越过', st.ratios[1] > st.ratios[0], st.ratios)
      const c = await pressFor(cdp, 0, layout + ' 死拖')
      if (c) {
        await dragAndSample(cdp, c.x, c.y, layout === 'c3' ? 4000 : 0, layout === 'r3' ? 4000 : 0, 6)
        const s2 = await state(cdp)
        const sizes = layout === 'c3' ? s2.panes.map(p => p.rect.w) : s2.panes.map(p => p.rect.h)
        check(layout + ' 死拖第一根后每格仍 >= MIN_PANE_PX - 缝宽', sizes.every(v => v >= floor), { floor, sizes })
        check(layout + ' 死拖后比例仍单调且落在 (0,1)', s2.ratios.every((v, i, a) => v > 0 && v < 1 && (i === 0 || v > a[i - 1])), s2.ratios)
        await cdp.shot(path.join(SHOT_DIR, '03-' + layout + '-clamp.png'))
      }
    } else {
      const c = await pressFor(cdp, st.handles[0].index, layout + ' 反向死拖')
      if (c) {
        await dragAndSample(cdp, c.x, c.y, st.handles[0].axis === 'x' ? -6000 : 0, st.handles[0].axis === 'y' ? -6000 : 0, 6)
        const s2 = await state(cdp)
        const sizes = st.handles[0].axis === 'x' ? s2.panes.map(p => p.rect.w) : s2.panes.map(p => p.rect.h)
        check(layout + ' 反向死拖不出现 0 宽/0 高格（夹到 MIN_PANE_PX - 缝宽）', sizes.every(v => v >= floor), { floor, sizes })
        check(layout + ' 反向死拖后比例仍是有限数且 ∈ (0,1)', s2.ratios.every(v => Number.isFinite(v) && v > 0 && v < 1), s2.ratios)
        await cdp.shot(path.join(SHOT_DIR, '03-' + layout + '-clamp.png'))
      }
    }
  }

  // ---- 比例的真意义：侧栏开合挤压 termWidth + reload 还原
  {
    await cdp.eval('window.store.setLayout(\'c2\', false)')
    await sleep(400)
    let st = await state(cdp)
    const c = await pressFor(cdp, 0, '侧栏挤压')
    if (!c) info('侧栏挤压 + reload 阶段跳过（没拿到按下点）')
    else {
      await dragAndSample(cdp, c.x, c.y, -180, 0, 8)
      st = await state(cdp)
      const ratio = st.ratios[0]
      const before = termGeom(st)
      await cdp.eval('window.store.setOpenedSideBar(\'bookmarks\')')
      await sleep(700)
      const st2 = await state(cdp)
      const after = termGeom(st2)
      const gotW = st2.panes[0].rect.w
      const wantW = Math.round(after.width * ratio)
      check('侧栏开合把终端区宽度挤掉了（>60px）', Math.abs(after.width - before.width) > 60, { before: before.width, after: after.width })
      check('侧栏开合：左格宽度 == 比例 × 新 termWidth（存的是比例不是像素）', Math.abs(gotW - wantW) <= 3, { ratio, newTermWidth: after.width, got: gotW, want: wantW })
      check('侧栏开合：比例本身没被改动', Math.abs(st2.ratios[0] - ratio) < 1e-9, { before: ratio, after: st2.ratios[0] })
      await cdp.shot(path.join(SHOT_DIR, '04-sidebar-ratio.png'))
      await cdp.eval('window.store.setOpenedSideBar(\'\')')
      await sleep(500)

      const written = await cdp.jeval('JSON.stringify((window.store.splitRatios || {}).c2 || null)')
      // reload 会把页面内替身冲干净，计数要在 reload 前取走
      stubCount = await cdp.jeval(`JSON.stringify({
        ws: window.__wsStub && window.__wsStub.intercepted,
        rdp: window.__rdpFake && { connects: window.__rdpFake.connects, runs: window.__rdpFake.runs, shutdown: window.__rdpFake.shutdown },
        vnc: window.__vncFake && { built: window.__vncFake.built, autoscale: window.__vncFake.autoscale, disconnected: window.__vncFake.disconnected }
      })`)
      const eventsBefore = cdp.events.slice()
      await cdp.eval('(() => { localStorage.removeItem(\'last-workspace\'); return 1 })()')
      await cdp.call('Page.reload', { ignoreCache: false })
      await sleep(4000)
      const restored = JSON.parse(await evalRetry(cdp, `(() => {
        const st = window.store
        const wrap = document.querySelector('.layout-wrap.layout-wrap-c2')
        const items = wrap ? Array.from(wrap.querySelectorAll(':scope > .layout-item')).map(el => Math.round(el.getBoundingClientRect().width)) : []
        return JSON.stringify({ layout: st.layout, ratios: (st.splitRatios || {}).c2 || null, ls: JSON.parse(localStorage.getItem('splitRatios') || 'null'), widths: items })
      })()`))
      check('reload 后 c2 比例从 localStorage 还原，且不是回落默认等分',
        restored.ratios && written && Math.abs(restored.ratios[0] - written[0]) < 1e-9 && Math.abs(restored.ratios[0] - 0.5) > 0.05,
        { written, restored })
      check('reload 后格子宽度按还原比例重算', restored.widths.length === 2 && near(restored.widths[0] / (restored.widths[0] + restored.widths[1] + 4), restored.ratios[0], 0.01), restored.widths)
      cdp.events = eventsBefore.concat(cdp.events)
    }
  }

  // ---- 全程无未捕获异常
  const noise = new RegExp([
    'fetch error', 'ws closed', 'EACCES', 'Fontconfig', 'libva', 'GPU stall', 'Passthrough',
    'Context creation', 'Automatic fallback', 'gpu_', 'WebGL', 'deprecated', 'Slow network',
    // 跑的是未打包产物，Electron 自己会喊 CSP；与本判据无关
    'Electron Security Warning',
    // 假 create-terminal 给的端口是"连上即 RST"的，终端数据通道必然报连不上
    'WebSocket connection to', 'Error in connection establishment', 'ECONNREFUSED'
  ].join('|'), 'i')
  const errs = cdp.events.filter(e => !noise.test(e))
  check('整轮拖动没有页面异常 / 控制台 error', errs.length === 0, errs.slice(0, 6).map(e => String(e).slice(0, 500)))

  const failed = results.filter(r => !r.ok)
  console.log('\n==== 汇总: ' + (results.length - failed.length) + '/' + results.length + ' PASS ====')
  if (failed.length) {
    console.log('FAIL 明细：')
    failed.forEach(f => console.log(' - ' + f.name))
  }
  console.log('截图目录：' + SHOT_DIR)
  console.log('替身计数（reload 前取的，证明没真连远端）：' + brief(stubCount))
  await killInstance()
  fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  process.exit(failed.length ? 1 : 0)
}

main().catch(async e => {
  console.error('FATAL ' + e.message)
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(l => !/dbus-daemon|xdg-desktop-portal|fusermount/.test(l))
    console.error('主进程日志尾巴：\n' + tail.slice(-20).join('\n'))
  } catch (e2) { console.error('日志读不出来：' + e2.message) }
  await killInstance()
  if (process.env.KEEP_TMP) console.error('临时目录保留：' + RUN)
  else fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  process.exit(1)
})
