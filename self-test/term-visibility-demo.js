#!/usr/bin/env node
/**
 * #4216 最小化恢复后终端重绘 —— CDP 实机回归
 *
 * 单测钉的是"源码里挂了可见性监听并走 fitAndRefresh"，钉不住两件事：
 *   A) 隐藏期间监听是否真的静默（隐藏态 fit 会算出 0 列，把 shell 提示符逐字符换行）；
 *   B) 回到可见那一次，监听是否恰好落到一次 fit + refresh（而不是被守卫吞掉）。
 * 判据只用计数与布尔，另附前后截图供肉眼复核。
 *
 * 通道：Electron 的 CDP 不实现 Browser.getWindowForTarget / setWindowBounds
 * （实测 -32601 wasn't found），驱动不了真窗口最小化。所以这里先探测 OS 通道，
 * 拿不到就退到 DOM 通道 —— 覆写 document.visibilityState 后派发 visibilitychange，
 * 这正是 Chromium 最小化/恢复时对页面做的事。本 demo 验的是"我们的监听接上了
 * 重绘链"，不重复验 Chromium 的行为；OS 通道可用时会额外跑一轮真最小化。
 *
 * 用法：
 *   1) npm run vite-build && cp -r src/app/. work/app/
 *   2) D=$(mktemp -d /tmp/electerm-vis-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/term-visibility-demo.js 9333 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'term-visibility-shots')

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

// 间谍：计数只落在 window 上，取的是既有 fitAndRefresh / term.refresh 两个点。
// 顺带记录每次 fit 时的 cols —— 隐藏态误 fit 的第一现场就是 cols 塌成个位数。
// 原始方法挂在实例上（__rawFit/__rawRefresh），重复安装只重置计数不叠包装，
// 否则同一页面跑第二次会变成 +2，把"恰好一次"的判据读成产品问题。
const INSTALL = `(() => {
  const id = window.store.activeTabId
  const inst = window.refs.get('term-' + id)
  if (!inst || !inst.term) return 'no-terminal'
  if (!inst.__rawFit) {
    inst.__rawFit = inst.fitAndRefresh
    inst.__rawRefresh = inst.term.refresh
  }
  window.__spy = { fit: 0, refresh: 0, vis: [], colsAtFit: [] }
  if (window.__visListener) {
    document.removeEventListener('visibilitychange', window.__visListener)
  }
  window.__visListener = () => {
    window.__spy.vis.push(document.visibilityState)
  }
  document.addEventListener('visibilitychange', window.__visListener)
  inst.fitAndRefresh = function () {
    window.__spy.fit++
    window.__spy.colsAtFit.push(inst.term.cols)
    return inst.__rawFit.call(inst)
  }
  inst.term.refresh = function (a, b) {
    window.__spy.refresh++
    return inst.__rawRefresh.call(inst.term, a, b)
  }
  window.__spy.tabId = id
  return 'installed'
})()`

const SPY = 'JSON.stringify(window.__spy && {fit: window.__spy.fit, refresh: window.__spy.refresh, vis: window.__spy.vis, colsAtFit: window.__spy.colsAtFit})'

// DOM 通道：覆写 visibilityState/hidden 后派发 visibilitychange。
// 一次性接管，反复调用 goHidden/goVisible 只换值，不重复 defineProperty。
const SET_VISIBLE = `((v) => {
  if (!window.__visPatched) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => window.__vis || 'visible'
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => window.__vis === 'hidden'
    })
    window.__visPatched = true
  }
  window.__vis = v
  document.dispatchEvent(new Event('visibilitychange'))
  return document.visibilityState
})`

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target; start the app with --remote-debugging-port')
  }
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  const browser = new Cdp(version.webSocketDebuggerUrl)
  await cdp.ready
  await browser.ready
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.enable', {})
  // 整页重载：间谍挂的是实例方法，重复安装会叠包装把计数读成 +2。
  // 重载拿一个干净实例，比在页面上做反包装可靠。
  await cdp.call('Page.reload', {})
  await sleep(1500)

  check('渲染层就绪', await waitFor(cdp, 'window.store && window.store.configLoaded === true', 'store'))
  await sleep(1000)

  // 没有终端就开一个本地会话
  const hasTerm = await cdp.eval('!!window.refs.get("term-" + window.store.activeTabId)')
  if (!hasTerm) {
    await cdp.eval('(() => { window.store.addTab(); return 1 })()')
  }
  check('本地终端已挂载（term.rows > 1）', await waitFor(cdp, `(() => {
    const t = window.refs.get('term-' + window.store.activeTabId)
    return t && t.term && t.term.rows > 1
  })()`, 'terminal'))
  await sleep(1200)

  check('间谍已挂', await cdp.eval(INSTALL) === 'installed')
  const before = JSON.parse(await cdp.eval(SPY))
  check('基线：尚未发生多余重绘', before.fit === 0 && before.refresh === 0, before)
  const shotBefore = await cdp.shot(path.join(SHOT_DIR, 'before-minimize.png'))

  // ---- 选择驱动通道 ----
  const win = await browser.call('Browser.getWindowForTarget', { targetId: page.id })
  const windowId = win.result && win.result.windowId
  const useOsChannel = !!windowId

  const goHidden = async () => {
    if (useOsChannel) {
      await browser.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await sleep(1500)
    } else {
      await cdp.eval(`(${SET_VISIBLE})('hidden')`)
      await sleep(400)
    }
  }

  const goVisible = async () => {
    if (useOsChannel) {
      await browser.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await sleep(600)
      await cdp.call('Page.bringToFront', {})
      await sleep(1500)
    } else {
      await cdp.eval(`(${SET_VISIBLE})('visible')`)
      await sleep(600)
    }
  }

  console.log('driver channel: ' + (useOsChannel ? 'OS window (real minimize)' : 'DOM visibility (Electron CDP 无 Browser.setWindowBounds)'))

  const geom = async () => JSON.parse(await cdp.eval(`(() => {
    const t = window.refs.get('term-' + window.__spy.tabId)
    const rows = document.querySelectorAll('.session-wrap .xterm-rows > div')
    let painted = 0
    rows.forEach(r => { if (r.textContent.trim().length) painted++ })
    return JSON.stringify({ cols: t && t.term.cols, rows: t && t.term.rows, domRows: rows.length, painted })
  })()`))

  // ---- 第一轮：隐藏 ----
  await goHidden()
  const mid = JSON.parse(await cdp.eval(SPY))
  check('隐藏期间不重绘（隐藏态 fit 会算出 0 列）', mid.fit === 0 && mid.refresh === 0, mid)
  check('隐藏事件已到达页面', mid.vis.includes('hidden'), { vis: mid.vis })

  // ---- 第一轮：恢复 ----
  const beforeBack = JSON.parse(await cdp.eval(SPY))
  await goVisible()
  const after = JSON.parse(await cdp.eval(SPY))
  check('恢复后页面回到 visible', after.vis[after.vis.length - 1] === 'visible', { vis: after.vis })
  check('恢复恰好触发一次重绘（fitAndRefresh +1）', after.fit === beforeBack.fit + 1, {
    before: beforeBack.fit, after: after.fit
  })
  check('重绘确实下到 xterm.refresh（不是被可见性守卫吞掉）', after.refresh > beforeBack.refresh, {
    before: beforeBack.refresh, after: after.refresh
  })

  const health = await geom()
  check('恢复后终端几何与内容正常（cols/rows 合理且 DOM 有渲染行）',
    health.cols > 20 && health.rows > 5 && health.domRows > 0, health)
  check('重绘没有把列数改坏（fit 前后 cols 一致）',
    after.colsAtFit.every(c => c === health.cols), { colsAtFit: after.colsAtFit, cols: health.cols })
  const shotAfter = await cdp.shot(path.join(SHOT_DIR, 'after-restore.png'))

  // ---- 第二轮：再来一次，监听不是一次性的 ----
  const base = JSON.parse(await cdp.eval(SPY))
  await goHidden()
  const mid2 = JSON.parse(await cdp.eval(SPY))
  check('第二轮隐藏期间同样不重绘', mid2.fit === base.fit, { before: base.fit, mid: mid2.fit })
  await goVisible()
  const again = JSON.parse(await cdp.eval(SPY))
  check('第二次隐藏→恢复仍会重绘（监听非一次性）', again.fit === base.fit + 1, {
    before: base.fit, after: again.fit
  })
  const health2 = await geom()
  check('第二轮几何仍稳定', health2.cols === health.cols && health2.rows === health.rows, health2)
  await cdp.shot(path.join(SHOT_DIR, 'after-restore-2.png'))

  // ---- focus 通道：window focus 也接在同一条重绘链上 ----
  const baseFocus = JSON.parse(await cdp.eval(SPY))
  await cdp.eval('window.dispatchEvent(new Event("focus")); 1')
  await sleep(600)
  const afterFocus = JSON.parse(await cdp.eval(SPY))
  const focusDelta = afterFocus.fit - baseFocus.fit
  check('focus 事件同样走一次重绘（0 < delta ≤ 2）', focusDelta > 0 && focusDelta <= 2, { delta: focusDelta })

  // ---- 对照：把这次的两个监听摘掉，同样的驱动应不再产生任何重绘 ----
  // 证明前面"恢复重绘一次"确实来自本修复，而不是 ResizeObserver 之类的旁路。
  await cdp.eval(`(() => {
    const inst = window.refs.get('term-' + window.__spy.tabId)
    document.removeEventListener('visibilitychange', inst.onWindowBack)
    window.removeEventListener('focus', inst.onWindowBack)
    return 1
  })()`)
  const baseCtrl = JSON.parse(await cdp.eval(SPY))
  await goHidden()
  await goVisible()
  const afterCtrl = JSON.parse(await cdp.eval(SPY))
  check('对照：摘掉监听后隐藏→恢复零重绘（重绘来自本修复）',
    afterCtrl.fit === baseCtrl.fit && afterCtrl.refresh === baseCtrl.refresh, {
      before: baseCtrl.fit, after: afterCtrl.fit
    })

  const pass = results.filter(r => r.ok).length
  console.log('----')
  console.log(`shots: ${[shotBefore, shotAfter, 'after-restore-2.png'].join(', ')}`)
  console.log(`${pass}/${results.length} PASS`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => {
  console.error('DEMO ERROR', e.message)
  process.exit(1)
})
