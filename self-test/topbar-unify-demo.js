#!/usr/bin/env node
/**
 * 底栏避让单源（T2）—— CDP 实机回归
 *
 * 为什么单独一个脚本：T2 改的是"六个绝对定位浮层各取哪一个派生值"，
 * 纯单测只能钉住源码里的变量名，钉不住"它们真的没互相压住"。
 * 判据一律取 getBoundingClientRect：底缘对齐（间隙 <= 1px）+ 两两不相交。
 *
 * 覆盖：
 *   1) 派生变量：--below-footer-h / --below-monitor-h / --bottom-reserved-h
 *      与 resolveBottomStack 的和式逐项相等（开快捷键条 + 软键盘时）
 *   2) footer 只让快捷键条 + 软键盘；监控条再让 footer；侧栏 / 右面板 /
 *      快捷命令带让整栈（含监控条）
 *   3) 五个浮层两两不相交（这就是 T2-4 的验收口径）
 *   4) 会话区高按 stack.session 收缩（qm 计入、reserved 不计）
 *   5) 关闭快捷键条后变量回 0，几何自然退化（不再依赖 body 类）
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/electerm-t2/home XDG_CONFIG_HOME=/tmp/electerm-t2/config \
 *        DATA_PATH=/tmp/electerm-t2/data xvfb-run -a -s "-screen 0 1600x1000x24" \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000 &
 *   3) node self-test/topbar-unify-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'topbar-unify-shots')
// 快捷键条高是 JS 单源常量（layout 的扣减与 CSS 的 --shortcut-bar-h 都取它），
// 桌面端不渲染该条，期望值只能来自源码
const SHORTCUT_H = Number(
  /shortcutBarHeight = (\d+)/.exec(
    fs.readFileSync(path.join(__dirname, '../src/client/common/constants.js'), 'utf8')
  )[1]
)

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
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 120))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      throw new Error('screenshot failed: ' + JSON.stringify(r.error || r.result))
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 12000) => {
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

// 探针：一次性把需要的量都读回来，判据在 node 侧算，失败详情里带原始数字
const PROBE = `
window.__t2 = () => {
  const rect = sel => {
    const el = document.querySelector(sel)
    if (!el) {
      return null
    }
    const r = el.getBoundingClientRect()
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  }
  const root = document.documentElement
  // 派生变量注入在 .is-main 包装层上（main.jsx 的 style），读根节点恒为未设值
  const host = document.querySelector('.is-main') || root
  const v = name => parseFloat(getComputedStyle(host).getPropertyValue(name)) || 0
  const session = document.querySelector('.sessions')
  return {
    innerH: window.innerWidth ? window.innerHeight : 0,
    vars: {
      belowFooter: v('--below-footer-h'),
      belowMonitor: v('--below-monitor-h'),
      reserved: v('--bottom-reserved-h'),
      footerStack: v('--footer-stack-height'),
      qmBar: v('--qm-bar-h')
    },
    store: {
      // 快捷键条是 touch-only，桌面不渲染 DOM 也不写 --shortcut-bar-h；
      // 期望值直接取 constants 里的单源常量（由脚本注入）
      shortcut: window.store.shortcutBarVisible ? __SHORTCUT_H__ : 0,
      kb: window.store.shortcutBarVisible ? window.store.shortcutBarKbOffset : 0,
      pinnedQm: !!window.store.pinnedQuickCommandBar && !window.store.quickCommandsInRightPanel && window.store.inActiveTerminal
    },
    rects: {
      footer: rect('.main-footer'),
      monitor: rect('.remote-monitor-bar'),
      sidebar: rect('.sidebar-panel'),
      right: rect('.right-side-panel'),
      qm: rect('.qm-wrap-tooltip'),
      sessions: rect('.sessions')
    }
  }
}
'probe-installed'
`

const SET_STATE = `
window.__t2set = (s) => {
  const st = window.store
  st.shortcutBarVisible = !!s.shortcut
  st.shortcutBarKbOffset = s.kb || 0
  st.pinnedQuickCommandBar = !!s.qm
  st.quickCommandsInRightPanel = false
  st._leftSideBarOpen = !!s.sidebar
  st.openedSideBar = s.sidebar ? 'bookmarks' : ''
  st._leftSidePanelWidth = 257
  st.rightPanelVisible = !!s.right
  st.rightPanelPinned = false
  st.rightPanelTab = 'ai'
  st._rightPanelWidth = 411
  return 'set'
}
'set-installed'
`

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

const overlap = (a, b) => {
  if (!a || !b) {
    return false
  }
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 1 && h > 1
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await waitFor(cdp, 'window.store && window.store.configLoaded === true', 'store ready', 20000)
  await sleep(600)

  const theme0 = await cdp.eval('window.store._config && window.store._config.theme')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id)))

  await cdp.eval(PROBE.replace('__SHORTCUT_H__', SHORTCUT_H))
  await cdp.eval(SET_STATE)

  // 监控条要求：ssh 类页 + remoteMonitorBarEnabled + 非 showModal + 右面板不是 info
  await cdp.eval(`(() => {
    const st = window.store
    st.updateTab(st.activeTabId, { host: 'monitor.invalid', type: 'ssh', status: 'success' })
    st.setConfig({ remoteMonitorBarEnabled: true })
    return 'monitor-on'
  })()`)
  const barShown = await waitFor(cdp, '!!document.querySelector(".remote-monitor-bar")', 'monitor bar')

  // ---- 1) 全关：footer 贴底，监控条坐在 footer 上 ----
  await cdp.eval('window.__t2set({})')
  await sleep(900)
  const off = JSON.parse(await cdp.eval('JSON.stringify(window.__t2())'))
  check('全关：快捷键条/软键盘为 0，监控条只让 footer',
    off.vars.belowFooter === 0 &&
    near(off.vars.belowMonitor, off.rects.footer.height) &&
    near(off.vars.reserved, off.vars.footerStack), off.vars)
  check('全关：footer 贴视口底', off.rects.footer && near(off.rects.footer.bottom, off.innerH), { footer: off.rects.footer, innerH: off.innerH })
  check('全关：监控条底缘 == footer 顶缘', barShown && off.rects.monitor && near(off.rects.monitor.bottom, off.rects.footer.top), { monitor: off.rects.monitor, footer: off.rects.footer })
  const sessionsOffH = off.rects.sessions ? off.rects.sessions.height : -1

  // ---- 2) 全开：快捷键条 + 软键盘 + 钉住 qm + 右面板 + 左侧栏 ----
  await cdp.eval('window.__t2set({ shortcut: 1, kb: 240, qm: 1, right: 1, sidebar: 1 })')
  await waitFor(cdp, 'window.__t2().rects.qm !== null && window.__t2().rects.sidebar !== null && window.__t2().rects.right !== null', 'all layers mounted')
  await sleep(900)
  const on = JSON.parse(await cdp.eval('JSON.stringify(window.__t2())'))
  const sb = on.store.shortcut + on.store.kb
  const expectBelowFooter = sb
  const expectBelowMonitor = off.rects.footer.height + sb
  // footerStack = footerHeight + monitorHeight（main.jsx 注入的过渡值）
  const expectReserved = off.vars.footerStack + sb
  check('软键盘打开时 --below-footer-h = 快捷键条 + 软键盘',
    near(on.vars.belowFooter, expectBelowFooter, 0.5), { got: on.vars.belowFooter, want: expectBelowFooter, store: on.store })
  check('--below-monitor-h = footer + 快捷键条 + 软键盘（监控条自身不计）',
    near(on.vars.belowMonitor, expectBelowMonitor, 0.5), { got: on.vars.belowMonitor, want: expectBelowMonitor })
  check('--bottom-reserved-h = 除 qm 外的整栈',
    near(on.vars.reserved, expectReserved, 0.5), { got: on.vars.reserved, want: expectReserved })
  check('footer 抬到快捷键条 + 软键盘之上',
    on.rects.footer && near(on.rects.footer.bottom, on.innerH - expectBelowFooter), { footer: on.rects.footer, innerH: on.innerH, wantBottom: on.innerH - expectBelowFooter })
  check('监控条底缘 == footer 顶缘（不叠）',
    near(on.rects.monitor.bottom, on.rects.footer.top), { monitor: on.rects.monitor, footer: on.rects.footer })
  check('侧栏底缘 == 整栈顶缘（含监控条；旧版只让 footer 会伸进监控条）',
    near(on.rects.sidebar.bottom, on.rects.monitor.top), { sidebar: on.rects.sidebar, monitorTop: on.rects.monitor.top })
  check('右面板底缘 == 整栈顶缘',
    near(on.rects.right.bottom, on.rects.monitor.top), { right: on.rects.right, monitorTop: on.rects.monitor.top })
  check('钉住的快捷命令带底缘 == 整栈顶缘',
    on.rects.qm && near(on.rects.qm.bottom, on.rects.monitor.top), { qm: on.rects.qm, monitorTop: on.rects.monitor.top })

  // 两两不相交（T2-4 验收口径）
  const pairs = [
    ['sidebar', 'right'],
    ['sidebar', 'qm'],
    ['sidebar', 'monitor'],
    ['sidebar', 'footer'],
    ['right', 'qm'],
    ['right', 'monitor'],
    ['right', 'footer'],
    ['qm', 'monitor'],
    ['qm', 'footer'],
    ['monitor', 'footer']
  ]
  const bad = pairs.filter(([a, b]) => overlap(on.rects[a], on.rects[b]))
  check('五个浮层两两不相交', barShown && bad.length === 0, { bad, rects: on.rects })

  // 会话区高：qm 计入 session、reserved 不含 qm
  const sessionsOnH = on.rects.sessions.height
  const shrink = sessionsOffH - sessionsOnH
  check('会话区按 stack.session（reserved + qm）收缩', shrink > 0 && shrink >= on.vars.qmBar, { shrink, sessionsOffH, sessionsOnH, qmBar: on.vars.qmBar })

  // ---- 3) 截图（组合开/关 × 深/浅）----
  const shots = []
  const themeDark = 'default'
  for (const theme of [{ id: themeDark, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) {
      continue
    }
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(500)
    shots.push(await cdp.shot(path.join(SHOT_DIR, 'stack-on-' + theme.name + '.png')))
  }
  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  await cdp.eval('window.__t2set({})')
  await sleep(900)
  for (const theme of [{ id: themeDark, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) {
      continue
    }
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(500)
    shots.push(await cdp.shot(path.join(SHOT_DIR, 'stack-off-' + theme.name + '.png')))
  }
  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  check('四张截图落盘', shots.length === 4 && shots.every(f => fs.existsSync(f)), { shots })

  // ---- 4) 还原：关掉监控条与所有临时状态 ----
  await cdp.eval(`(() => {
    const st = window.store
    st.setConfig({ remoteMonitorBarEnabled: false })
    st.shortcutBarVisible = false
    st.shortcutBarKbOffset = 0
    st.pinnedQuickCommandBar = false
    st._leftSideBarOpen = false
    st.openedSideBar = ''
    st.rightPanelVisible = false
    const tab = st.currentTab
    if (tab) {
      st.updateTab(st.activeTabId, { host: (tab.host && tab.host === 'monitor.invalid') ? undefined : tab.host })
    }
    return 'restored'
  })()`)
  await sleep(400)

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) {
    console.log('FAILED: ' + JSON.stringify(failed.map(f => f.name)))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
