#!/usr/bin/env node
/**
 * T4 终端内容区 flex 化 —— CDP 实机回归
 *
 * 单测钉住"源码里没有 props 宽度链 / 有 RO + 可见性守卫"，钉不住
 * "xterm 真的按实测容器 fit"。判据用 xterm 自己的 cols/rows × 单元格尺寸
 * 与容器实测宽高对齐：
 *   1) 首挂载 fit：cols/rows 恰好铺满容器（余量 < 一格）
 *   2) 隐藏标签不 fit：display:none 期间 rows 不变；切回后重新 fit
 *   3) 分屏：终端缩进半栏后重新 fit；拖拽分栏后再次 fit 且比例正确
 *   4) 全屏进出：容器铺满视口，无残留滚动
 *   5) 字号缩放：直接 fit（不依赖 1px 重排）后列数变化且仍铺满
 *   6) 截图（普通/分屏/全屏）落 self-test/topbar-unify-shots/
 *
 * 用法：
 *   1) npm run build
 *   2) HOME=/tmp/electerm-t2/home XDG_CONFIG_HOME=/tmp/electerm-t2/config \
 *        DATA_PATH=/tmp/electerm-t2/data xvfb-run -a -s "-screen 0 1600x1000x24" \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000 &
 *   3) node self-test/t4-term-flex.js [port] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'topbar-unify-shots')

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

const PROBE = `
window.__t4 = () => {
  const st = window.store
  const id = st.activeTabId
  const wrap = document.querySelector('.session-wrap.session-current')
  const rect = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom)
    }
  }
  const box = wrap && wrap.querySelector('.term-wrap-2')
  const pane = wrap && wrap.querySelector('.term-wrap')
  const vp = wrap && wrap.querySelector('.xterm-viewport')
  const term = window.refs.get('term-' + id)?.term
  const dim = term && term.dimensions && term.dimensions.css
  const splitter = wrap && wrap.querySelector('.term-sftp-box > .ant-splitter')
  const panes = splitter
    ? [...splitter.querySelectorAll(':scope > .ant-splitter-panel')].map(rect)
    : []
  const footer = document.querySelector('.main-footer')
  return {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    fullscreen: !!document.querySelector('.fullscreen'),
    footer: footer && getComputedStyle(footer).display !== 'none' ? rect(footer) : null,
    id,
    tabs: st.tabs.length,
    split: !!splitter,
    box: rect(box),
    boxClient: box ? { w: box.clientWidth, h: box.clientHeight } : null,
    pane: rect(pane),
    splitter: rect(splitter),
    panes,
    vp: vp ? { ow: vp.offsetWidth, cw: vp.clientWidth } : null,
    cols: term ? term.cols : null,
    rows: term ? term.rows : null,
    cell: dim ? { w: dim.cell.width, h: dim.cell.height } : null,
    fontSize: term ? term.options.fontSize : null
  }
}
'probe-installed'
`

// 终端是否恰好铺满容器：多一列/一行会溢出，少一整列/行则有空带。
// 口径与 FitAddon 一致：可用宽 = 容器宽 - .xterm 内边距(10+10) - 滚动条(14)，
// 列数 = floor(可用宽 / 单元格宽)；行数同理（无滚动条扣减）。
const XTERM_PAD = 20
const SCROLLBAR_W = 14
const fits = v => {
  if (!v || !v.box || !v.cell || !v.cols) return { ok: false, reason: 'missing', v }
  const restW = v.box.w - XTERM_PAD - SCROLLBAR_W - v.cols * v.cell.w
  const restH = v.box.h - XTERM_PAD - v.rows * v.cell.h
  return {
    ok: restW >= -1 && restW < v.cell.w + 1 && restH >= -1 && restH < v.cell.h + 1,
    restW,
    restH
  }
}

const probe = async cdp => JSON.parse(await cdp.eval('JSON.stringify(window.__t4())'))

// 沿分栏方向拖动 150px；方向由 splitter 的 orientation 类名决定
const dragSplitter = async (cdp, drag) => {
  const r = JSON.parse(await cdp.eval(`(() => {
    const sp = document.querySelector('.term-sftp-box > .ant-splitter')
    const d = sp && sp.querySelector(':scope > .ant-splitter-bar .ant-splitter-bar-dragger')
    if (!d) return 'null'
    const b = d.getBoundingClientRect()
    return JSON.stringify({
      x: b.left + b.width / 2,
      y: b.top + b.height / 2,
      axis: sp.classList.contains('ant-splitter-horizontal') ? 'x' : 'y'
    })
  })()`))
  if (!r) {
    return false
  }
  const from = { x: r.x, y: r.y }
  const to = { ...from }
  to[r.axis] += drag
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 })
  await sleep(120)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  return true
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; start the app with --remote-debugging-port')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await waitFor(cdp, 'window.store && window.store.configLoaded === true', 'store ready', 20000)
  await sleep(800)
  await cdp.eval(PROBE)

  // ---- 1) 首挂载 fit ----
  await waitFor(cdp, `(() => {
    const id = window.store.activeTabId
    const t = window.refs.get('term-' + id)
    return t && t.term && t.term.rows > 1
  })()`, 'first terminal')
  await sleep(900)
  const v0 = await probe(cdp)
  const f0 = fits(v0)
  check('首挂载：终端按实测容器 fit（cols/rows 恰好铺满）', f0.ok, {
    cols: v0.cols, rows: v0.rows, cell: v0.cell, box: v0.box, f0
  })
  const shots = []
  shots.push(await cdp.shot(path.join(SHOT_DIR, 'term-normal.png')))

  // ---- 2) 隐藏标签不 fit：新开标签，旧标签 display:none ----
  const firstId = v0.id
  const before = JSON.parse(await cdp.eval(`JSON.stringify({
    rows: window.refs.get('term-${firstId}')?.term?.rows,
    cols: window.refs.get('term-${firstId}')?.term?.cols
  })`))
  await cdp.eval("(() => { window.store.addTab(); return 'added' })()")
  await waitFor(cdp, `(() => {
    const id = window.store.activeTabId
    const t = window.refs.get('term-' + id)
    return id !== '${firstId}' && t && t.term && t.term.rows > 1
  })()`, 'second terminal')
  await sleep(1200)
  const hidden = JSON.parse(await cdp.eval(`(() => {
    const t = window.refs.get('term-${firstId}')
    const box = document.querySelector('.tw-${firstId} .term-wrap-2')
    return JSON.stringify({
      boxH: box ? box.clientHeight : null,
      rows: t?.term?.rows,
      cols: t?.term?.cols
    })
  })()`))
  check('隐藏标签不 fit（display:none 期间行列保持不变，不被 0 列覆盖）',
    hidden.boxH === 0 && hidden.rows === before.rows && hidden.cols === before.cols,
    { before, hidden })
  const vNew = await probe(cdp)
  check('新标签按实测容器 fit', fits(vNew).ok, { cols: vNew.cols, rows: vNew.rows, box: vNew.box, f: fits(vNew) })

  // ---- 3) 切回：重新 fit ----
  // 会话可见性由 activeTabId<batch> 控制（activeTabId 只决定高亮）
  await cdp.eval(`(() => {
    const st = window.store
    const tab = st.tabs.find(t => t.id === '${firstId}')
    st.activeTabId = '${firstId}'
    st['activeTabId' + tab.batch] = '${firstId}'
    return 'back'
  })()`)
  await sleep(900)
  const vBack = await probe(cdp)
  check('切回后重新 fit（容器可见 → 一次 fit）', vBack.id === firstId && fits(vBack).ok,
    { id: vBack.id, cols: vBack.cols, rows: vBack.rows, box: vBack.box, f: fits(vBack) })

  // ---- 4) 分屏：终端缩进半栏，重新 fit ----
  await cdp.eval(`(() => { window.store.updateTab('${firstId}', { sshSftpSplitView: true }); return 'split' })()`)
  await waitFor(cdp, '!!document.querySelector(".session-current .term-sftp-box > .ant-splitter")', 'splitter')
  await sleep(1200)
  const vSplit = await probe(cdp)
  // 分栏方向由窗口比例决定（宽 > 1.6 才左右分），这里不假定方向：
  // 终端必须缩进第一个 pane 并重新 fit
  const pane0 = vSplit.panes[0]
  const splitShrank = v0 && (vSplit.cols < v0.cols || vSplit.rows < v0.rows)
  check('分屏：终端缩进分栏后重新 fit（行列随可用区减少且仍铺满）',
    vSplit.split && fits(vSplit).ok && splitShrank &&
    vSplit.box.w === pane0.w && vSplit.box.h === pane0.h,
    { cols: vSplit.cols, rows: vSplit.rows, before: { cols: v0.cols, rows: v0.rows }, box: vSplit.box, pane0, f: fits(vSplit) })
  shots.push(await cdp.shot(path.join(SHOT_DIR, 'term-split.png')))

  // ---- 5) 拖拽分栏：比例变化 + 再次 fit ----
  const dragged = await dragSplitter(cdp, 150)
  await sleep(900)
  const vDrag = await probe(cdp)
  const pane0Before = pane0
  const pane0After = vDrag.panes[0]
  // 方向：以哪一维变了为准（垂直分栏动的是高度）
  const changedW = pane0After.w - pane0Before.w
  const changedH = pane0After.h - pane0Before.h
  check('拖拽分栏：比例按实测像素变化（±150px）',
    dragged && (changedW !== 0 || changedH !== 0) &&
    (Math.abs(Math.abs(changedW) - 150) <= 12 || Math.abs(Math.abs(changedH) - 150) <= 12),
    { dragged, changedW, changedH, before: pane0Before, after: pane0After })
  check('拖拽后终端重新 fit 到新尺寸',
    fits(vDrag).ok && (vDrag.cols !== vSplit.cols || vDrag.rows !== vSplit.rows) &&
    vDrag.box.w === pane0After.w && vDrag.box.h === pane0After.h,
    { cols: vDrag.cols, rows: vDrag.rows, box: vDrag.box, pane0After, f: fits(vDrag) })

  // ---- 6) 字号缩放：直接 fit（不依赖 1px 重排）----
  await cdp.eval(`(() => { window.refs.get('term-${firstId}').zoom(2); return 'zoom' })()`)
  await sleep(900)
  const vZoom = await probe(cdp)
  check('字号放大后直接 fit（行列减少且仍铺满）',
    (vZoom.cols < vDrag.cols || vZoom.rows < vDrag.rows) && fits(vZoom).ok,
    { cols: vZoom.cols, rows: vZoom.rows, before: { cols: vDrag.cols, rows: vDrag.rows }, fontSize: vZoom.fontSize, f: fits(vZoom) })
  await cdp.eval(`(() => { window.refs.get('term-${firstId}').handleResetFontSize(); return 'reset' })()`)
  await sleep(900)
  const vReset = await probe(cdp)
  check('字号复位后重新 fit', vReset.cols === vDrag.cols && vReset.rows === vDrag.rows && fits(vReset).ok,
    { cols: vReset.cols, rows: vReset.rows, expect: { cols: vDrag.cols, rows: vDrag.rows } })

  // 关掉分屏再进全屏，便于看整屏
  await cdp.eval(`(() => { window.store.updateTab('${firstId}', { sshSftpSplitView: false }); return 'nosplit' })()`)
  await sleep(700)

  // ---- 7) 全屏进出：铺满视口、无残留滚动 ----
  await cdp.eval(`(() => { window.store.toggleSessFullscreen(true, '${firstId}'); return 'fs' })()`)
  await sleep(1200)
  const vFs = await probe(cdp)
  // 终端全屏保留底栏（fs-with-footer），容器底缘应正好让出底栏高
  const expectBottom = vFs.innerH - (vFs.footer ? vFs.footer.h : 0)
  check('全屏：终端容器铺满可用区（top 0 / bottom == 视口底 - 底栏）',
    vFs.fullscreen && vFs.box.top === 0 && Math.abs(vFs.box.bottom - expectBottom) <= 1,
    { box: vFs.box, innerH: vFs.innerH, footer: vFs.footer, expectBottom })
  check('全屏：无残留滚动（文档 scrollHeight == 视口高）',
    vFs.scrollH <= vFs.innerH + 1, { scrollH: vFs.scrollH, innerH: vFs.innerH })
  check('全屏：终端按全屏容器重新 fit', fits(vFs).ok,
    { cols: vFs.cols, rows: vFs.rows, box: vFs.box, f: fits(vFs) })
  shots.push(await cdp.shot(path.join(SHOT_DIR, 'term-fullscreen.png')))

  await cdp.eval(`(() => { window.store.toggleSessFullscreen(false, '${firstId}'); return 'exitfs' })()`)
  await sleep(1200)
  const vExit = await probe(cdp)
  check('退出全屏：尺寸复原并重新 fit',
    !vExit.fullscreen && vExit.box.h < vFs.box.h && fits(vExit).ok,
    { box: vExit.box, cols: vExit.cols, rows: vExit.rows, f: fits(vExit) })
  check('退出全屏：无残留滚动', vExit.scrollH <= vExit.innerH + 1,
    { scrollH: vExit.scrollH, innerH: vExit.innerH })

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS ${results.length}/${results.length}`))
  console.log('shots: ' + shots.join(', '))
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
