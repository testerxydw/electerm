#!/usr/bin/env node
/**
 * #4539 终端主题 background 落地 —— 实机回归 demo
 *
 * 修复前这里是复现探针（结论：主题 background 被丢弃，可见底色恒为 --main）。
 * 修复后同一批测量点反过来当判据：配了什么，屏幕上就该是什么。
 * 沿五条链路各量一次：
 *   P1 props/override：主题确实传到终端组件（排除"配置没生效"的假通过）
 *   P2 DOM：从 .xterm-screen 往上找第一个不透明 backgroundColor —— 真正画出来的底色
 *   P3 内联层：.term-wrap 的内联 backgroundColor 用了背景色长写，
 *              terminal.styl 的氛围光（background-image 的 radial-gradient）不被 shorthand 抹掉
 *   P4 可见底色：getVisibleTerminalBackground()，同时决定 OSC 11 应答、webGL 清屏色与选中色混合
 *   P5 OSC 11：真人向终端问 `ESC]11;?`，shell/tmux 配色自适应据此选色
 * 另加三条边界：配了终端背景图时维持现状（图是用户选的观感）、内置浅色主题的
 * background 生效（修前是 #ededed 底 + #af9a91 字，不可读）、主题没配可用背景色时回到 --main。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) D=$(mktemp -d /tmp/electerm-bg-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/term-theme-background-demo.js 9333 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'term-theme-background-shots')
// 显眼且不会与任何内置主题撞色的探针色
const PROBE_BG = '#7a1fa2'
// 只用来触发"这个页签配了背景图"的判定，不需要真的能下载
const PROBE_IMG = 'https://electerm.invalid/probe-bg.png'

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

  async evalPromise (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
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

const waitFor = async (cdp, expr, label, timeout = 25000) => {
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

// ---- 主题：复制当前主题，只改 themeConfig.background ----
const applyProbeTheme = (background) => `(() => {
  const store = window.store
  const base = store.getThemeConfig()
  const uiBase = store.getUiThemeConfig()
  if (!Object.keys(base).length || !base.background) {
    throw new Error('活动终端主题缺少可复制的 themeConfig（当前主题 id=' + store.config.theme + '）')
  }
  const id = 'probe-4539-bg'
  const theme = {
    id,
    name: id,
    themeConfig: { ...base, background: ${JSON.stringify(background)} },
    uiThemeConfig: { ...uiBase }
  }
  if (store.getTerminalThemes().find(t => t.id === id)) {
    store.editTheme(id, theme)
  } else {
    store.addTheme(theme)
  }
  store.setTheme(id)
  return JSON.stringify({
    themeId: store.config.theme,
    configuredBackground: store.getThemeConfig().background,
    selectionBackground: store.getThemeConfig().selectionBackground || '',
    uiMain: store.getUiThemeConfig().main,
    rendererType: store.config.rendererType
  })
})()`

const OPEN_TAB = `(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'BG-4539', batch: 0 })
  window.__g = { id: store.tabs[store.tabs.length - 1].id }
  store.changeActiveTabId(window.__g.id)
  return JSON.stringify(window.__g)
})()`

const READY = `(() => {
  const inst = window.refs.get('term-' + window.__g.id)
  return !!(inst && inst.term && inst.attachAddon && !inst.attachAddon.disposed)
})()`

// ---- 五条链路一起量（期望色由 node 传入） ----
const measure = (expectColor) => `(() => {
  const inst = window.refs.get('term-' + window.__g.id)
  const term = inst.term
  const toRGB = c => {
    const d = document.createElement('div')
    d.style.color = c
    document.body.appendChild(d)
    const s = getComputedStyle(d).color
    document.body.removeChild(d)
    return s
  }
  const eq = (a, b) => a && b && toRGB(a) === toRGB(b)
  const wrap = document.querySelector('.term-wrap.tw-' + window.__g.id)
  const screen = term.element && term.element.querySelector('.xterm-screen')
  const chain = []
  let el = screen
  let painted = null
  while (el) {
    const bg = getComputedStyle(el).backgroundColor
    chain.push({ cls: (el.className || el.id || el.tagName) + '', bg })
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      painted = { cls: chain[chain.length - 1].cls, bg }
      break
    }
    el = el.parentElement
  }
  const cssMain = getComputedStyle(document.documentElement).getPropertyValue('--main').trim()
  const visible = inst.getVisibleTerminalBackground()
  const override = inst.getTerminalBackgroundOverride()
  const xtermBg = term.options.theme && term.options.theme.background
  const colors = term._core && term._core._themeService && term._core._themeService.colors
  return JSON.stringify({
    propsBackground: (inst.props.themeConfig || {}).background,
    hasImage: inst.hasTerminalBackgroundImage(),
    override,
    painted,
    paintedChain: chain.slice(0, 6),
    visible,
    uiMain: window.store.getUiThemeConfig().main,
    cssMain,
    inlineBackground: wrap ? wrap.style.backgroundColor : '(no .term-wrap)',
    inlineShorthand: wrap ? wrap.getAttribute('style').includes('background:') : false,
    glowKept: wrap ? getComputedStyle(wrap).backgroundImage.includes('radial-gradient') : false,
    imageLayer: screen ? getComputedStyle(screen, '::before').backgroundImage : '',
    xtermThemeBackground: xtermBg,
    selectionCss: colors ? colors.selectionBackgroundOpaque.css : '',
    rendererType: inst.props.config.rendererType,
    paintedEqualsExpect: painted ? eq(painted.bg, ${JSON.stringify(expectColor)}) : false,
    paintedEqualsMain: painted ? eq(painted.bg, cssMain) : false,
    visibleEqualsExpect: eq(visible, ${JSON.stringify(expectColor)}),
    xtermEqualsExpect: !!xtermBg && eq(xtermBg, ${JSON.stringify(expectColor)}),
    xtermIsTransparent: xtermBg === 'rgba(0,0,0,0)'
  })
})()`

// ---- OSC 11：终端被问"你的背景色是什么"时实际回什么（格式同 colorToOscRgb） ----
const osc11 = (color) => `(() => {
  const inst = window.refs.get('term-' + window.__g.id)
  const addon = inst.attachAddon
  const raw = addon.__rawSendData || addon._sendData
  addon.__rawSendData = raw
  const osc = c => {
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
    const h = m
      ? [m[1], m[2], m[3]].map(x => (x + x).toLowerCase())
      : /^#([0-9a-f]{6})$/i.test(c) ? [1, 3, 5].map(i => c.slice(i, i + 2).toLowerCase()) : null
    return h ? 'rgb:' + h.join('/') : ''
  }
  const out = []
  addon._sendData = (d) => {
    out.push(typeof d === 'string' ? d : '')
    return raw.call(addon, d)
  }
  inst.term.write('\\u001b]11;?\\u001b\\\\')
  return new Promise(r => setTimeout(() => {
    addon._sendData = raw
    addon.sendToServer('\\u0015')
    const reply = out.join('')
    const want = osc(${JSON.stringify(color)})
    r(JSON.stringify({
      replies: out.map(s => s.replace(/\\u001b/g, '<ESC>')),
      want,
      matched: want !== '' && reply.includes(want)
    }))
  }, 400))
})()`

// 与 terminal-color-query.mjs 同式的混合：选中色必须混在真正的可见底色上
const blendOver = (bg, sel) => {
  const hex = c => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c || '').trim())
    return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null
  }
  const rgba = c => {
    const m = /^rgba?\(([^)]+)\)$/i.exec(String(c || '').trim())
    if (!m) {
      return null
    }
    const p = m[1].split(',').map(s => parseFloat(s.trim()))
    return p.length < 3 ? null : [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  const toCss = (r, g, b, a) =>
    '#' + [r, g, b, a].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  const b1 = hex(bg)
  const s1 = rgba(sel)
  if (!b1 || !s1) {
    return ''
  }
  const [sr, sg, sb, sa] = s1
  if (sa >= 1) {
    return toCss(sr, sg, sb, 255)
  }
  return toCss(
    b1[0] + (sr - b1[0]) * sa,
    b1[1] + (sg - b1[1]) * sa,
    b1[2] + (sb - b1[2]) * sa,
    sa * 255
  )
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.eval('(() => { if (!window.store || !window.refs) { throw new Error("app not ready") } })()')

  const applied = JSON.parse(await cdp.eval(applyProbeTheme(PROBE_BG)))
  console.log('applied theme :: ' + JSON.stringify(applied))
  check('主题已切到探针色（配置里带显眼的 background）',
    applied.configuredBackground === PROBE_BG, { configuredBackground: applied.configuredBackground })
  JSON.parse(await cdp.eval(OPEN_TAB))
  check('终端页签就绪', await waitFor(cdp, READY, 'terminal ready'))
  await sleep(1500)

  // ---- A) 没配背景图：配了什么底色就是什么 ----
  const a = JSON.parse(await cdp.eval(measure(PROBE_BG)))
  console.log('A measure :: ' + JSON.stringify(a))
  check('P1 主题配置传到终端组件（排除"没读到配置"的假通过）',
    a.propsBackground === PROBE_BG && a.override === PROBE_BG && a.hasImage === false,
    { propsBackground: a.propsBackground, override: a.override, hasImage: a.hasImage })
  check('P2 真正画出来的底色 = 配置的 background（修前恒为 --main）',
    a.paintedEqualsExpect === true && a.paintedEqualsMain === false,
    { painted: a.painted, cssMain: a.cssMain })
  check('P3 .term-wrap 用背景色长写，氛围光 radial-gradient 层仍在',
    a.inlineShorthand === false && a.glowKept === true,
    { inlineBackground: a.inlineBackground, glowKept: a.glowKept })
  check('P4 可见底色（OSC/webGL/选中混合的共同来源）= 配置色',
    a.visibleEqualsExpect === true, { visible: a.visible })
  check('P4b DOM 渲染层不重复画底：xterm 仍透明，容器负责（webGL 则取同一个可见色）',
    a.rendererType === 'webGL' ? a.xtermEqualsExpect === true : a.xtermIsTransparent === true,
    { rendererType: a.rendererType, xtermThemeBackground: a.xtermThemeBackground })

  const sel = blendOver(PROBE_BG, a.selectionBackground || applied.selectionBackground || 'rgba(255, 255, 255, 0.3)')
  check('P4c 选中色混在新底色上（修前混的是 transparent-black）',
    sel === '' || a.selectionCss === sel, { selectionCss: a.selectionCss, expected: sel })

  const o1 = JSON.parse(await cdp.evalPromise(osc11(PROBE_BG)))
  console.log('A OSC11 :: ' + JSON.stringify(o1))
  check('P5 OSC 11 回配置色（shell/tmux 配色自适应拿到的终于是终端真实底色）',
    o1.matched === true, { replies: o1.replies, want: o1.want })
  await cdp.shot(path.join(SHOT_DIR, '01-theme-background-painted.png'))

  // ---- B) 配了终端背景图：维持现状，图底下仍是 --main ----
  await cdp.eval(`(() => { window.store.updateConfig({ terminalBackgroundImagePath: ${JSON.stringify(PROBE_IMG)} }) })()`)
  await sleep(1200)
  const b = JSON.parse(await cdp.eval(measure(PROBE_BG)))
  console.log('B measure :: ' + JSON.stringify(b))
  check('B1 配了背景图时 override 让位（图是用户选的观感，不改它底下的色）',
    b.hasImage === true && b.override === '', { hasImage: b.hasImage, override: b.override })
  check('B2 底色维持 --main，且图片层照常挂在 .xterm-screen::before 上',
    b.paintedEqualsMain === true && b.paintedEqualsExpect === false &&
      /url|none/.test(b.imageLayer),
    { painted: b.painted, imageLayer: b.imageLayer.slice(0, 80) })
  const o2 = JSON.parse(await cdp.evalPromise(osc11(b.uiMain)))
  check('B3 此时 OSC 11 回 --main（可见底色确实是它）',
    o2.matched === true, { replies: o2.replies, want: o2.want })
  await cdp.shot(path.join(SHOT_DIR, '02-with-background-image.png'))
  await cdp.eval('(() => { window.store.updateConfig({ terminalBackgroundImagePath: "" }) })()')
  await sleep(1200)

  // ---- C) 主题没配可用背景色：回到样式表的 --main ----
  JSON.parse(await cdp.eval(applyProbeTheme('transparent')))
  await sleep(1500)
  const c = JSON.parse(await cdp.eval(measure(PROBE_BG)))
  console.log('C measure :: ' + JSON.stringify(c))
  check('C1 背景色不可用（透明）时不硬涂，交回样式表',
    c.override === '' && c.inlineBackground === '' && c.paintedEqualsMain === true,
    { override: c.override, inlineBackground: c.inlineBackground, painted: c.painted })

  // ---- D) 内置浅色主题：background 生效（修前是浅底配浅字，读不见） ----
  const light = JSON.parse(await cdp.eval(`(() => {
    const store = window.store
    const t = store.getTerminalThemes().find(d => (d.uiThemeConfig || {}).light === true ||
      /^#(e|f)/i.test((d.uiThemeConfig || {}).main || ''))
    if (!t) {
      throw new Error('找不到内置浅色主题')
    }
    store.setTheme(t.id)
    return JSON.stringify({
      id: t.id,
      background: t.themeConfig.background,
      foreground: t.themeConfig.foreground,
      uiMain: t.uiThemeConfig.main
    })
  })()`))
  console.log('D theme :: ' + JSON.stringify(light))
  await sleep(1500)
  const d = JSON.parse(await cdp.eval(measure(light.background)))
  console.log('D measure :: ' + JSON.stringify(d))
  check('D1 浅色主题的终端底色 = 主题 background（修前画的是 #ededed 配浅字，读不见）',
    d.paintedEqualsExpect === true, { painted: d.painted, want: light.background, uiMain: light.uiMain })
  check('D2 底色不再跟着 UI 主色走：界面是浅的（--main=' + d.cssMain + '），终端仍是主题色',
    d.paintedEqualsMain === false, { painted: d.painted, cssMain: d.cssMain })
  await cdp.shot(path.join(SHOT_DIR, '03-light-theme.png'))
  await cdp.shot(path.join(SHOT_DIR, '03-light-theme.png'))

  // 反向：换回探针主题，底色必须跟着换回来（不是钉在某一次的值上）
  JSON.parse(await cdp.eval(applyProbeTheme(PROBE_BG)))
  await sleep(1500)
  const e = JSON.parse(await cdp.eval(measure(PROBE_BG)))
  check('D3 主题来回切，终端底色随之来回切',
    e.paintedEqualsExpect === true && e.painted.bg !== d.painted.bg,
    { light: d.painted && d.painted.bg, back: e.painted && e.painted.bg })
  await cdp.shot(path.join(SHOT_DIR, '04-back-to-probe-theme.png'))

  const failed = results.filter(r => !r.ok)
  console.log((results.length - failed.length) + '/' + results.length + ' PASS')
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
