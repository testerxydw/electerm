#!/usr/bin/env node
/**
 * 远程会话顶栏条目契约（N3）—— CDP 实机验收
 *
 * N3 改的是"栏里摆什么"（doc/分析-远程会话顶栏差异与统一-2026-10-30.md §5）：
 * SessionShell 不再收 controlLeft/controlRight 两个自由槽，改成条目契约
 * （左 = 重连｜栏内条目｜信息，右 = 全屏｜⋮）。栏内条目含显示控件——分辨率/
 * 选屏 Select 与缩放开关，2026-11-03 决定不收进 ⋮（要先看得见才决定改不改），
 * ⋮ 回到"只有动作"。要钉住的三件事都只有真实渲染能答：
 *
 *   1) 三端条高一致：控件留在栏里也必须压在 --session-bar-h 一行的行盒内
 *      （Select / Switch 都走 small），三端 `.remote-session-control` 都是 32px、
 *      条目同一条中线，同一窗口下视口高度相等（§3 的连带影响就此收口）。
 *   2) ⋮ 只是动作菜单：页面里没有第二层设置面板，菜单的底与阴影仍由 antd 自己给
 *      （外面包一层再收敛一遍的做法随面板一起取消了）。
 *   3) 全屏时顶栏整条隐藏（term-fullscreen.styl 收了 .session-v-info），浮层 ⋮
 *      是唯一入口——隐藏得干净、栏里不会留下半个失效的缩放开关，所以栏内开关
 *      也不需要再自己置灰。
 *
 * 没有真远端也能跑，靠两个替身（都在页面内接管产品边界，不改产品代码）：
 *   假 ws —— patch Ws.prototype.s，把 create-terminal(vnc/spice) 的应答本地造出来；
 *   假 RFB —— 预置 window.novnc = {RFB: FakeRFB}，并按真机那样上报**两个屏**，
 *             这样 VNC 的选屏 Select 才会出现（单屏本就不该出现）。
 *
 * 用法：
 *   1) npm run build
 *   2) D=$(mktemp -d /tmp/electerm-n3-XXXX) && mkdir -p $D/home $D/config $D/data $D/tmp
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data TMPDIR=$D/tmp \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9225 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *      （TMPDIR 必须隔离：single-instance.sock 按用户共用，否则第二个实例会连到
 *        并行会话的主实例、退 0 什么也测不到）
 *   3) node self-test/remote-bar-n3-demo.js 9225 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'remote-bar-n3-shots')

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

  /**
   * 真鼠标点击：antd 的 Dropdown / Select 由 mousedown 与 document 级监听驱动，
   * el.click() 造不出"弹层之外的一次点击"，用它验收等于自说自话。
   *
   * 同名的候选可能有好几个（关掉的页签仍挂着 display:none 的旧壳），取**第一个可见**
   * 的，否则坐标落在 0×0 的残留节点上，点了等于没点。
   */
  async click (selector) {
    const box = await this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        }
      }
      return els.length ? 'NOT VISIBLE' : null
    })()`)
    if (!box || box === 'NOT VISIBLE') {
      return false
    }
    const { x, y } = JSON.parse(box)
    await this.clickAt(x, y)
    return true
  }

  async clickAt (x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.call('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1
      })
    }
  }

  async isVisible (selector) {
    return this.eval(`(() => {
      const dd = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter(d => !d.classList.contains('ant-dropdown-hidden'))
        .filter(d => {
          const r = d.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
      return dd.length
    })()`)
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

/* ------------------------------------------------------------------ *
 * 页面内替身：必须在开页签之前装好
 * ------------------------------------------------------------------ */

const INSTALL = `(() => {
  const vp = { rfbBuilt: 0, createTerm: 0, scaleWrites: 0, screens: null }
  window.__vp = vp
  const nativeTimeout = window.setTimeout

  // ---- 1) 假 noVNC：两个屏，选屏行才会出现
  const DESKTOP = { width: 1280, height: 800 }
  class FakeRFB extends EventTarget {
    constructor (mount, url, opts) {
      super()
      vp.rfbBuilt++
      vp.lastScaleViewport = !!opts.scaleViewport
      const screen = document.createElement('div')
      screen.className = 'fake-vnc-screen'
      screen.style.width = DESKTOP.width + 'px'
      screen.style.height = DESKTOP.height + 'px'
      screen.style.background = 'linear-gradient(135deg,#16324f,#2a9d8f)'
      mount.appendChild(screen)
      this.screens = [
        { id: 0, x: 0, y: 0, width: DESKTOP.width, height: DESKTOP.height, flags: 0 },
        { id: 1, x: DESKTOP.width, y: 0, width: DESKTOP.width, height: DESKTOP.height, flags: 0 }
      ]
      vp.screens = this.screens.length
      this.capabilities = { screens: this.screens }
      this._fail = () => {}
      this.disconnect = () => screen.remove()
      this.sendCtrlAltDel = () => {}
      this.clipboardPasteFrom = () => {}
      this.approveServer = () => {}
      this.sendCredentials = () => {}
      this._display = {
        scale: 1,
        autoscale: () => {},
        _rescale: () => {}
      }
      let scaleViewport = false
      Object.defineProperty(this, 'scaleViewport', {
        configurable: true,
        get: () => scaleViewport,
        set: (v) => {
          vp.scaleWrites++
          scaleViewport = v
        }
      })
      for (const k of ['clipViewport', 'viewOnly', 'qualityLevel', 'compressionLevel', 'showDotCursor']) {
        Object.defineProperty(this, k, {
          configurable: true,
          get: () => 0,
          set: () => {}
        })
      }
      nativeTimeout(() => {
        this.dispatchEvent(new CustomEvent('connect', { detail: {} }))
        this.dispatchEvent(new CustomEvent('desktopname', { detail: { name: 'fake-desktop' } }))
        this.dispatchEvent(new CustomEvent('capabilities', { detail: {} }))
        this.dispatchEvent(new CustomEvent('screens', { detail: this.screens }))
      }, 30)
    }
  }
  window.novnc = { RFB: FakeRFB }

  // ---- 2) 假 ws：create-terminal(vnc / spice) 本地应答，栏与视口照常渲染
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
    const t = data && data.body && data.body.termType
    if (data && data.action === 'create-terminal' && (t === 'vnc' || t === 'spice')) {
      vp.createTerm++
      const cb = cbs[data.id]
      delete cbs[data.id]
      nativeTimeout(() => {
        cb && cb({ data: { pid: 'fake-' + vp.createTerm, port: 5900 } })
      }, 20)
      return
    }
    return origS.apply(this, arguments)
  }
  return 'installed'
})()`

/* ------------------------------------------------------------------ *
 * 探针
 * ------------------------------------------------------------------ */

// 条的几何与内容。按协议自己的 wrap 类定位（rdp/vnc/spice-session-wrap 由
// SessionShell 的 wrapClassName 下发）——页面上可能同时挂着别的协议残留。
// 要量的不是"栏里有没有控件"（控件就在栏里），而是"放进去之后条还是一行"：
// 控件高度都压在 32 的行盒内，条目不换行，视口高度才不随协议漂移。
const barOf = wrapSel => `(() => {
  // 只取可见的那一条：关掉的页签会在 DOM 里留着 display:none 的旧壳，
  // 用第一个匹配会量到残留（条高 0）
  const wraps = [...document.querySelectorAll(${JSON.stringify(wrapSel)})]
  let bar = null
  let view = null
  let left = null
  let right = null
  for (const wrap of wraps) {
    const b = wrap.querySelector('.remote-session-control')
    const v = wrap.querySelector('.remote-session-viewport')
    if (b && v && b.getBoundingClientRect().height > 0) {
      bar = b
      view = v
      left = wrap.querySelector('.remote-session-control-left')
      right = wrap.querySelector('.remote-session-control-right')
      break
    }
  }
  if (!bar || !view) {
    return null
  }
  const selects = left.querySelectorAll('.ant-select')
  const switches = left.querySelectorAll('.ant-switch')
  const info = left.querySelector('.remote-session-info')
  const barBox = bar.getBoundingClientRect()
  const mid = barBox.top + barBox.height / 2
  // 量"栏的直接子项"，不是控件内核：SwitchLabel 的按钮只有 15px，按文字基线对齐
  // 会让中线偏几 px，那是排版细节，不是"有没有换行"
  const rowChild = (el) => {
    let cur = el
    while (cur && cur.parentElement !== left) {
      cur = cur.parentElement
    }
    return cur
  }
  const box = (el) => {
    if (!el) {
      return null
    }
    const b = el.getBoundingClientRect()
    return {
      top: Math.round(b.top * 10) / 10,
      h: Math.round(b.height * 10) / 10,
      left: Math.round(b.left),
      centerOff: Math.round((b.top + b.height / 2 - mid) * 10) / 10
    }
  }
  const text = (el) => el ? String(el.textContent).trim() : ''
  const infoBox = box(info)
  const selectBox = box(rowChild(selects[0]))
  const switchBox = box(rowChild(switches[0]))
  const parts = [infoBox, selectBox, switchBox].filter(Boolean)
  const leftBox = left.getBoundingClientRect()
  return JSON.stringify({
    barH: Math.round(barBox.height * 10) / 10,
    viewportH: Math.round(view.getBoundingClientRect().height * 10) / 10,
    selects: selects.length,
    switches: switches.length,
    selectH: selectBox ? selectBox.h : null,
    switchH: switchBox ? switchBox.h : null,
    // 一行 = 左组自己的高度不超过条高：换行会让它变成 32n，这比"中线对齐"更直接
    singleRow: Math.round(leftBox.height * 10) / 10 <= Math.round(barBox.height * 10) / 10 + 1,
    sameRow: parts.length > 0 && parts.every(b => Math.abs(b.centerOff) <= 1),
    leftH: Math.round(leftBox.height * 10) / 10,
    centerOff: parts.map(b => b.centerOff),
    barTop: Math.round(barBox.top),
    viewTop: Math.round(view.getBoundingClientRect().top),
    leftX: {
      select: selectBox ? selectBox.left : null,
      sw: switchBox ? switchBox.left : null,
      info: infoBox ? infoBox.left : null
    },
    leftIcons: left.querySelectorAll('.anticon').length,
    leftText: text(info),
    nameText: text(left.querySelector('.remote-session-info-name')),
    selectText: text(selects[0]),
    switchChecked: !!left.querySelector('.ant-switch.ant-switch-checked'),
    rightIcons: right.querySelectorAll('.anticon').length,
    hasMore: !!right.querySelector('.remote-float-control-inline'),
    firstIsReload: !!(left.firstElementChild && left.firstElementChild.classList.contains('anticon-reload'))
  })
})()`

const BAR = barOf('.remote-session-wrap.vnc-session-wrap')
const RDP_BAR = barOf('.remote-session-wrap.rdp-session-wrap')
const SPICE_BAR = barOf('.remote-session-wrap.spice-session-wrap')
// 当前可见的那条 VNC 栏：DOM 里可能留着已关闭页签的隐藏壳，取第一个可见的
const VIS_BAR = `(() => {
  for (const w of document.querySelectorAll('.remote-session-wrap.vnc-session-wrap')) {
    const b = w.querySelector('.remote-session-control')
    if (b && b.getBoundingClientRect().height > 0) {
      return b
    }
  }
  return null
})()`
const VIS_LEFT = `(() => {
  const b = (${VIS_BAR})
  return b ? b.querySelector('.remote-session-control-left') : null
})()`
const NO_BAR = `(() => {
  const wraps = [...document.querySelectorAll('.remote-session-wrap')]
  // "关掉了"= 没有可见的条，而不是 DOM 里一个 wrap 都不剩
  return wraps.every(w => {
    const b = w.querySelector('.remote-session-control')
    return !b || b.getBoundingClientRect().height === 0
  })
})()`

// 全屏时栏整条隐藏（term-fullscreen.styl 收了 .session-v-info），只剩浮层 ⋮。
// 这条既是既有设计的记录，也说明"控件放栏里"在全屏下不会留下半个失效开关。
const FS_STATE = `(() => {
  // 全屏下条被 display:none 收了，VIS_BAR 只挑可见条会返回 null——这里要验的正是"它不可见"，
  // 所以按视口挑出当前那个 wrap（视口在全屏下仍然撑满），再读它的条。
  let bar = null
  for (const w of document.querySelectorAll('.remote-session-wrap.vnc-session-wrap')) {
    const v = w.querySelector('.remote-session-viewport')
    const b = w.querySelector('.remote-session-control')
    if (v && b && v.getBoundingClientRect().height > 0) {
      bar = b
      break
    }
  }
  if (!bar) {
    return JSON.stringify({ noBar: true })
  }
  const hidden = getComputedStyle(bar).display === 'none' || bar.getBoundingClientRect().height === 0
  const floats = [...document.querySelectorAll('.remote-float-control, .remote-float-control-inline')]
  return JSON.stringify({
    hidden,
    display: getComputedStyle(bar).display,
    floatVisible: floats.filter(f => f.getBoundingClientRect().width > 0).length,
    floatTotal: floats.length
  })
})()`

// ⋮ 菜单：只有动作项，不是设置页。
// 只看**可见**的浮层：关掉的页签会留下 display:none 的旧菜单节点，
// 拿 menus[0] 会把那份残留当成当前菜单。
const MENU = `(() => {
  const drops = [...document.querySelectorAll('.ant-dropdown')].filter(d =>
    !d.classList.contains('ant-dropdown-hidden') && d.getBoundingClientRect().width > 0
  )
  if (!drops.length) {
    return JSON.stringify({ open: false, visibleDrops: 0 })
  }
  const menu = drops[0].querySelector('.ant-dropdown-menu')
  return JSON.stringify({
    open: true,
    // 一层盒：菜单自带背景/阴影，外面没有我们再包的面板
    panelWrapped: !!document.querySelector('.remote-float-panel'),
    settingRows: document.querySelectorAll('.remote-float-setting-row').length,
    visibleDrops: drops.length,
    bg: menu ? getComputedStyle(menu).backgroundColor : null,
    shadow: menu ? getComputedStyle(menu).boxShadow !== 'none' : null,
    items: [...drops[0].querySelectorAll('.ant-dropdown-menu-item')].map(i => String(i.textContent).trim())
  })
})()`

// 栏内 Select 展开：顶栏还在（点击不会被当成"栏外"把会话拆掉）
const SELECT_OPEN = `(() => {
  const dd = document.querySelector('.ant-select-dropdown')
  const bar = ${VIS_BAR}
  return JSON.stringify({
    dropdownExists: !!dd,
    barStillThere: !!bar,
    options: dd ? [...dd.querySelectorAll('.ant-select-item-option')].map(o => String(o.textContent).trim()) : []
  })
})()`

// 选屏走产品状态（不是替身的状态）
const SCREEN_APPLIED = `(() => {
  const node = document.querySelector('.vnc-session-mount')
  const key = node && Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0)
  let fiber = key ? node[key] : null
  let inst = null
  while (fiber) {
    const sn = fiber.stateNode
    if (sn && typeof sn.updateViewLayout === 'function' && sn.domRef) {
      inst = sn
      break
    }
    fiber = fiber.return
  }
  const left = ${VIS_LEFT}
  const sel = left && left.querySelector('.ant-select-content')
  return JSON.stringify({
    currentScreen: inst ? inst.state.currentScreen : null,
    selectShows: sel ? String(sel.textContent).trim() : null
  })
})()`

// 缩放开关：写本机记忆 + 即时推给 noVNC
const SCALE_APPLIED = `(() => {
  const vp = window.__vp
  return JSON.stringify({
    scaleWrites: vp.scaleWrites,
    lsValue: window.localStorage.getItem('vnc-scale-view-127.0.0.1'),
    checked: !!(${VIS_LEFT})?.querySelector('.ant-switch.ant-switch-checked')
  })
})()`

const openTab = type => `(() => {
  window.store.addTab({
    type: ${JSON.stringify(type)},
    title: 'N3-${type.toUpperCase()}',
    host: '127.0.0.1',
    port: '${type === 'rdp' ? '3389' : '5900'}',
    username: 'demo',
    password: 'demo',
    scaleViewport: true,
    clipViewport: false,
    batch: 0
  })
  return window.store.activeTabId
})()`

const closeTab = `(() => {
  window.store.delTab(window.store.activeTabId)
  return true
})()`

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

  await waitFor(cdp, '(() => !!(window.store && window.et && window.et.commonWs))()', 'app ready', 40000)
  await cdp.call('Page.enable')
  check('替身装载（假 RFB 两屏 + 假 ws）', await ev(INSTALL) === 'installed')

  // 清场：上次跑/手工留下的远程页签会让 wrap 选择器与"没有残留 wrap"的判断失真
  await ev(`(() => {
    window.store.toggleSessFullscreen(false)
    const left = (window.store.tabs || []).filter(t => /^(vnc|rdp|spice)$/.test(t.type))
    left.forEach(t => window.store.delTab(t.id))
    return left.length
  })()`)
  await waitFor(cdp, NO_BAR, 'pre-clean remote tabs', 10000)

  // 上一次跑可能留着没关的浮层：antd 的 Dropdown 是 toggle，第一下点的是"关"
  await cdp.clickAt(500, 500)
  await sleep(300)
  check('开跑前没有游离浮层', (await cdp.isVisible('.ant-dropdown')) === 0)

  // ---- A) VNC：控件在栏内，条仍是一行 ----
  await ev(openTab('vnc'))
  const barRaw = await waitFor(cdp, BAR, 'vnc bar')
  if (!barRaw) {
    throw new Error('vnc session bar did not render')
  }
  await waitFor(cdp, '(() => window.__vp.rfbBuilt > 0)()', 'fake rfb built')
  await sleep(500)
  const bar = JSON.parse(await ev(BAR))
  check('VNC 栏内有选屏 Select + 缩放 Switch（不收进 ⋮）',
    bar.selects === 1 && bar.switches === 1, { selects: bar.selects, switches: bar.switches })
  check('条高 = --session-bar-h 一行 32px（控件没把它撑成两行）',
    Math.abs(bar.barH - 32) <= 0.5 && bar.selectH <= 28 && bar.switchH <= 32,
    { barH: bar.barH, selectH: bar.selectH, switchH: bar.switchH })
  check('栏内只有一行：左组高度不超过条高（控件没撑出第二行）',
    bar.singleRow === true, { leftH: bar.leftH, barH: bar.barH, centerOff: bar.centerOff })
  check('左栏顺序：重连在最前，控件在连接信息之前',
    bar.firstIsReload && /127\.0\.0\.1/.test(bar.leftText) && /fake-desktop/.test(bar.nameText) &&
      bar.leftX.select < bar.leftX.info, bar.leftX)
  check('右栏只有全屏 + ⋮', bar.hasMore === true, bar)
  await cdp.shot(path.join(SHOT_DIR, '01-vnc-bar.png'))

  // ---- B) ⋮ 只是动作菜单 ----
  const moreSel = '.remote-session-wrap.vnc-session-wrap .remote-session-control-right .anticon-more'
  check('点开 ⋮', await cdp.click(moreSel))
  await sleep(400)
  const menu = JSON.parse(await ev(MENU))
  check('⋮ 里只有动作项，没有设置区',
    menu.open === true && menu.panelWrapped === false && menu.settingRows === 0 &&
      menu.items.some(i => /Ctrl\+Alt\+Del/.test(i)), menu)
  check('菜单仍由 antd 自己给底（不再有外面包一层的收敛样式）',
    menu.bg !== 'rgba(0, 0, 0, 0)' && menu.shadow === true, { bg: menu.bg, shadow: menu.shadow })
  await cdp.shot(path.join(SHOT_DIR, '02-more-menu.png'))
  // 收起菜单：栏内控件下一步要点，残留浮层也会污染"可见浮层"的计数
  await cdp.click(moreSel)
  await sleep(300)
  check('再点一次能收起（当前没有可见浮层）', (await cdp.isVisible('.ant-dropdown')) === 0)

  // ---- C) 栏内 Select：展开并换屏 ----
  check('点开栏内选屏 Select',
    await cdp.click('.remote-session-wrap.vnc-session-wrap .remote-session-control-left .ant-select-content'))
  await sleep(400)
  const sel = JSON.parse(await ev(SELECT_OPEN))
  check('下拉列出两个屏，顶栏没被这次点击拆掉',
    sel.dropdownExists === true && sel.barStillThere === true && sel.options.length === 2, sel)
  await cdp.shot(path.join(SHOT_DIR, '03-bar-select.png'))
  check('选第二个屏（真鼠标点下拉项）',
    await cdp.click('.ant-select-dropdown .ant-select-item-option:last-child'))
  await sleep(500)
  const applied = JSON.parse(await ev(SCREEN_APPLIED))
  check('选屏走产品链路（实例状态切到第二个屏，栏内标签同步）',
    String(applied.currentScreen) === '1' && /Screen 2/.test(applied.selectShows || ''), applied)

  // ---- D) 栏内缩放开关：即时生效 + 本机记忆 ----
  await cdp.click('.remote-session-wrap.vnc-session-wrap .remote-session-control-left .ant-switch')
  await sleep(500)
  const scale = JSON.parse(await ev(SCALE_APPLIED))
  check('开关关掉即时推给 noVNC 并写本机记忆（不必重连）',
    scale.scaleWrites >= 1 && scale.lsValue === 'false' && scale.checked === false, scale)
  await cdp.shot(path.join(SHOT_DIR, '04-scale-off.png'))

  // ---- E) 全屏：栏整条隐藏，浮层 ⋮ 是唯一入口 ----
  await ev('(() => { window.store.toggleSessFullscreen(true); return true })()')
  await sleep(900)
  const fs = JSON.parse(await ev(FS_STATE))
  check('全屏下顶栏整条隐藏（既有设计：term-fullscreen.styl 收 .session-v-info）',
    fs && fs.hidden === true, fs)
  check('全屏下只有浮层那一份 ⋮ 可点（隐藏条里不留半个死图标）',
    fs && fs.floatVisible === 1, fs)
  check('点开全屏浮层的 ⋮', await cdp.click('.remote-float-control .anticon-more'))
  await sleep(500)
  const fsMenu = JSON.parse(await ev(MENU))
  check('全屏浮层菜单可用（含退出全屏）',
    fsMenu.open === true && fsMenu.panelWrapped === false &&
      fsMenu.items.some(i => /fullscreen|全屏/i.test(i)), fsMenu)
  await cdp.shot(path.join(SHOT_DIR, '05-fullscreen-menu.png'))
  await ev('(() => { window.store.toggleSessFullscreen(false); return true })()')
  await sleep(500)

  // ---- F) 三端条高一致：RDP 是历史上条目最多的那一端 ----
  await ev(closeTab)
  await waitFor(cdp, NO_BAR, 'vnc tab closed', 10000)
  await ev(openTab('rdp'))
  const rdpRaw = await waitFor(cdp, RDP_BAR, 'rdp bar')
  await sleep(800)
  const rdpBar = rdpRaw ? JSON.parse(await ev(RDP_BAR)) : null
  check('RDP 条高与 VNC 一致（32px 一行，同窗口视口等高）',
    !!rdpBar && Math.abs(rdpBar.barH - 32) <= 0.5 && rdpBar.singleRow === true &&
      rdpBar.sameRow === true && Math.abs(rdpBar.viewportH - bar.viewportH) <= 0.5,
    { rdp: rdpBar && { barH: rdpBar.barH, viewportH: rdpBar.viewportH, leftH: rdpBar.leftH, centerOff: rdpBar.centerOff }, vnc: { barH: bar.barH, viewportH: bar.viewportH } })
  check('RDP 栏内：分辨率 Select + 缩放开关 + 文件传输/帮助图标',
    !!rdpBar && rdpBar.selects === 1 && rdpBar.switches >= 1 && rdpBar.leftIcons >= 4, rdpBar)
  await cdp.shot(path.join(SHOT_DIR, '06-rdp-bar.png'))
  await ev(closeTab)
  await waitFor(cdp, NO_BAR, 'rdp tab closed', 10000)

  await ev(openTab('spice'))
  const spiceRaw = await waitFor(cdp, SPICE_BAR, 'spice bar')
  await sleep(800)
  const spiceBar = spiceRaw ? JSON.parse(await ev(SPICE_BAR)) : null
  check('SPICE 条高与 VNC 一致（32px 一行，同窗口视口等高）',
    !!spiceBar && Math.abs(spiceBar.barH - 32) <= 0.5 && spiceBar.singleRow === true &&
      spiceBar.sameRow === true && Math.abs(spiceBar.viewportH - bar.viewportH) <= 0.5,
    { spice: spiceBar && { barH: spiceBar.barH, viewportH: spiceBar.viewportH, leftH: spiceBar.leftH, centerOff: spiceBar.centerOff }, vnc: { barH: bar.barH, viewportH: bar.viewportH } })
  check('SPICE 栏内只有缩放开关（没有选屏/分辨率）',
    !!spiceBar && spiceBar.selects === 0 && spiceBar.switches === 1, spiceBar)
  await cdp.shot(path.join(SHOT_DIR, '07-spice-bar.png'))
  await ev(closeTab)

  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log(`#${results.length - failed.length}/${results.length} passed, shots -> ${SHOT_DIR}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('DEMO ERROR', e)
  process.exit(1)
})
