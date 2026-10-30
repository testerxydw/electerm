#!/usr/bin/env node
/**
 * T3b-a SFTP flex 化 —— CDP 实机回归
 *
 * 单测只能钉住"源码里没有 px 代数"，钉不住"整条链真的吃满了高度"。
 * 判据一律取 getBoundingClientRect：链路各层底缘对齐（<=1px）+ 虚拟列表
 * 在实测高下窗口正确 + 全屏无上下留白。
 *
 * 覆盖：
 *   1) .sftp-pane-wrap / .sftp-wrap / .sftp-section / .sftp-panel 同底
 *   2) 列表底边 == 面板内容底边（.pd1 的 5px 内边距之外不留缝）
 *   3) 虚拟列表按实测容器高渲染窗口；滚到底时最后一项贴底
 *   4) 全屏：容器顶缘 0、底缘 == 视口底（旧实现底部留白 68px）
 *   5) 截图（普通/全屏）落 self-test/topbar-unify-shots/
 *
 * 用法：
 *   1) npm run build
 *   2) HOME=/tmp/electerm-t2/home XDG_CONFIG_HOME=/tmp/electerm-t2/config \
 *        DATA_PATH=/tmp/electerm-t2/data xvfb-run -a -s "-screen 0 1600x1000x24" \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000 &
 *   3) node self-test/t3b-sftp-flex.js [port] [shotDir] [localHome]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'topbar-unify-shots')
const LOCAL_HOME = process.argv[4] || '/tmp/electerm-t2/home'
const MANY_DIR = path.join(LOCAL_HOME, 'sftp-many')

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

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

// 探针：一次读回整条链的矩形，判据在 node 侧算
const PROBE = `
window.__t3b = () => {
  const rect = sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      width: Math.round(r.width)
    }
  }
  const content = document.querySelector('.sftp-table-content')
  const items = content ? [...content.querySelectorAll('.sftp-item')] : []
  const base = content ? content.getBoundingClientRect() : null
  return {
    innerH: window.innerHeight,
    fullscreen: !!document.querySelector('.session-wrap.session-current'),
    rects: {
      box: rect('.term-sftp-box'),
      bar: rect('.terminal-control'),
      splitter: rect('.term-sftp-box > .ant-splitter'),
      paneWrap: rect('.sftp-pane-wrap'),
      wrap: rect('.sftp-wrap'),
      section: rect('.sftp-section'),
      panel: rect('.sftp-panel'),
      list: rect('.file-list'),
      table: rect('.sftp-table'),
      header: rect('.sftp-file-table-header'),
      content: rect('.sftp-table-content')
    },
    list: content
      ? {
          scrollTop: content.scrollTop,
          scrollHeight: content.scrollHeight,
          clientHeight: content.clientHeight,
          rendered: items.length,
          lastBottom: items.length && base
            ? Math.round(items[items.length - 1].getBoundingClientRect().bottom - base.top)
            : null
        }
      : null
  }
}
'probe-installed'
`

const main = async () => {
  fs.mkdirSync(MANY_DIR, { recursive: true })
  for (let i = 1; i <= 80; i++) {
    const f = path.join(MANY_DIR, `file-${String(i).padStart(2, '0')}.txt`)
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, '')
    }
  }

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
  await sleep(600)
  await cdp.eval(PROBE)

  await cdp.eval(`(() => {
    const st = window.store
    st.toggleSessFullscreen(false, st.activeTabId)
    st.updateTab(st.activeTabId, { pane: 'fileManager' })
    return 'pane'
  })()`)
  await waitFor(cdp, 'document.querySelector(".sftp-table-content") && document.querySelector(".sftp-table-content").clientHeight > 100', 'sftp list')

  // 进入 80 文件目录，让虚拟列表真的有东西可滚
  await cdp.eval(`(() => {
    const inp = document.querySelector('.sftp-title-wrap input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, ${JSON.stringify(MANY_DIR)})
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed'
  })()`)
  await sleep(600)
  await cdp.eval(`(() => {
    document.querySelector('.sftp-title-wrap .ant-input-suffix .anticon')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'go'
  })()`)
  await waitFor(cdp, 'document.querySelector(".sftp-table-content").scrollHeight > 2000', 'many files')

  const normal = JSON.parse(await cdp.eval('JSON.stringify(window.__t3b())'))
  const r = normal.rects
  check('链路四层同底：paneWrap == wrap == section == panel',
    near(r.paneWrap.bottom, r.wrap.bottom) && near(r.wrap.bottom, r.section.bottom) &&
    near(r.section.bottom, r.panel.bottom),
    { paneWrap: r.paneWrap.bottom, wrap: r.wrap.bottom, section: r.section.bottom, panel: r.panel.bottom })
  check('列表底边贴面板内容底边（.pd1 5px 内边距之外不留缝）',
    near(r.list.bottom, r.panel.bottom - 5) && near(r.content.bottom, r.list.bottom),
    { list: r.list.bottom, content: r.content.bottom, panel: r.panel.bottom })
  check('滚动容器吃满表头之外的高度',
    near(r.content.height, r.list.height - r.header.height), { content: r.content.height, list: r.list.height, header: r.header.height })
  check('虚拟列表按实测高渲染窗口（不再是少 80px 的算术值）',
    normal.list.clientHeight === r.content.height &&
    normal.list.rendered < 81 && normal.list.rendered > 20,
    normal.list)

  // 滚到底：最后一项应贴容器底
  await cdp.eval(`(() => {
    const c = document.querySelector('.sftp-table-content')
    c.scrollTop = c.scrollHeight
    c.dispatchEvent(new Event('scroll', { bubbles: true }))
    return c.scrollTop
  })()`)
  await sleep(400)
  const bottom = JSON.parse(await cdp.eval('JSON.stringify(window.__t3b())'))
  check('滚到底时最后一项贴容器底',
    bottom.list.scrollTop > 0 && near(bottom.list.lastBottom, bottom.rects.content.height, 6),
    bottom.list)
  await cdp.eval(`(() => {
    const c = document.querySelector('.sftp-table-content')
    c.scrollTop = 0
    c.dispatchEvent(new Event('scroll', { bubbles: true }))
    return 0
  })()`)
  await sleep(300)

  const shots = []
  shots.push(await cdp.shot(path.join(SHOT_DIR, 'sftp-2row-normal.png')))

  // ---- 全屏：顶缘归零、底缘贴视口底（旧实现底部留白）----
  await cdp.eval(`(() => {
    const st = window.store
    st.toggleSessFullscreen(true, st.activeTabId)
    return 'fs'
  })()`)
  await sleep(900)
  const fsState = JSON.parse(await cdp.eval('JSON.stringify(window.__t3b())'))
  const f = fsState.rects
  check('全屏：SFTP 容器从视口顶部开始（无 36px 空带）',
    fsState.fullscreen && near(f.box.top, 0), { fullscreen: fsState.fullscreen, boxTop: f.box.top })
  check('全屏：SFTP 内容底缘贴视口底（无底部留白）',
    near(f.paneWrap.bottom, fsState.innerH),
    { paneBottom: f.paneWrap.bottom, innerH: fsState.innerH })
  shots.push(await cdp.shot(path.join(SHOT_DIR, 'sftp-2row-fullscreen.png')))

  // ---- 还原 ----
  await cdp.eval(`(() => {
    const st = window.store
    st.toggleSessFullscreen(false, st.activeTabId)
    const inp = document.querySelector('.sftp-title-wrap input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, ${JSON.stringify(LOCAL_HOME)})
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    st.updateTab(st.activeTabId, { pane: 'terminal' })
    return 'restored'
  })()`)
  await sleep(400)
  await cdp.eval(`(() => {
    const go = document.querySelector('.sftp-title-wrap .ant-input-suffix .anticon')
    if (go) go.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'home'
  })()`)

  check('两张截图落盘', shots.length === 2 && shots.every(f => fs.existsSync(f)), { shots })

  const failed = results.filter(d => !d.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
