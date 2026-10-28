#!/usr/bin/env node
/**
 * G1 广播输入 —— CDP 实机演示/回归（真实本地 shell，无需远端）
 *
 * 三个本地终端（B2/B3 为广播目标，B3 标 production），验证设计 §14.2 验收：
 *   1) 入口：默认目标只勾非生产（B2），生产目标带「生产」徽章
 *   2) 选中含生产机 → 同弹层切到确认步骤（列出主机），确认后开启，红条「广播中 · 2 台」
 *   3) 主控输入命令 → 三个终端同时执行（各自 buffer 都能看到同一标记）
 *   4) 密码期闸门：主控出现 Password 提示 → 红条转"已暂停"；期间输入的口令
 *      target 收不到（断言 0 次），回车后闸门解除、镜像恢复
 *   5) 目标断连/关页 → 自动移出目标集
 *   6) 退出广播后再输入 → 只剩主控收到
 *
 * 用法：
 *   1) npm run vite-build
 *   2) Xvfb :110 -screen 0 1400x900x24 &
 *      DISPLAY=:110 HOME=/tmp/electerm-g1-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9223 --no-sandbox
 *   3) node self-test/broadcast-input-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9223'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'broadcast-input-shots')

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

const STUB = `
(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__visBar = () =>
    [...document.querySelectorAll('.broadcast-bar')].find(window.__vis)
  window.__termOf = id => window.refs.get('term-' + id)
  window.__addonOf = id => {
    const t = window.__termOf(id)
    return t && t.attachAddon ? t.attachAddon : null
  }
  window.__buf = id => {
    const t = window.__termOf(id)
    const term = t && t.term
    if (!term) return ''
    const b = term.buffer.active
    const out = []
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i)
      if (line) out.push(line.translateToString(true))
    }
    return out.join('\\n')
  }
  window.__count = (id, needle) => window.__buf(id).split(needle).length - 1
  window.__send = (id, s) => {
    const addon = window.__addonOf(id)
    if (!addon) return 'no-addon'
    addon.sendToServer(s)
    return 'ok'
  }
  window.__modal = () => {
    const m = [...document.querySelectorAll('.ant-modal')].find(window.__vis)
    if (!m) return null
    const items = [...m.querySelectorAll('.broadcast-item')]
    return {
      title: (m.querySelector('.ant-modal-title') || {}).innerText || '',
      items: items.map(it => ({
        title: (it.querySelector('.broadcast-item-title') || {}).innerText || '',
        checked: !!it.querySelector('.ant-checkbox-checked'),
        prod: !!it.querySelector('.broadcast-prod-badge')
      })),
      confirmWarn: !!m.querySelector('.broadcast-prod-warn'),
      confirmHosts: (m.querySelector('.broadcast-prod-hosts') || {}).innerText || '',
      footer: [...m.querySelectorAll('.ant-modal-footer button')].map(b => ({
        text: b.innerText.trim(),
        danger: /\bant-btn-dangerous\b/.test(b.className),
        disabled: b.disabled
      }))
    }
  }
  window.__modalBtn = re => {
    const m = [...document.querySelectorAll('.ant-modal')].find(window.__vis)
    if (!m) return 'no-modal'
    const btns = [...m.querySelectorAll('.ant-modal-footer button')]
    const btn = btns.find(b => re.test(b.innerText))
    if (!btn) return 'no-btn'
    btn.click()
    return 'ok'
  }
  window.__pickAll = () => {
    const m = [...document.querySelectorAll('.ant-modal')].find(window.__vis)
    if (!m) return 'no-modal'
    const tools = [...m.querySelectorAll('.broadcast-tools button')]
    if (!tools.length) return 'no-tools'
    tools[0].click()
    return 'ok'
  }
  window.__barText = () => {
    const bar = window.__visBar()
    return bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : ''
  }
  window.__barBlocked = () => {
    const bar = window.__visBar()
    return !!bar && bar.classList.contains('broadcast-bar-blocked')
  }
  window.__clickBar = () => {
    const bar = window.__visBar()
    if (!bar) return 'no-bar'
    bar.click()
    return 'ok'
  }
  return 'stub-installed'
})()
`

const SETUP = `
(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  const specs = [
    { title: 'B2-plain', production: false },
    { title: 'B3-prod', production: true }
  ]
  const ids = []
  // 主控先建，保证 activeTabId 落在它上面
  store.addTab({ type: 'local', title: 'B1-source', production: false, batch: 0 })
  ids.push(store.tabs[store.tabs.length - 1].id)
  for (const s of specs) {
    store.addTab({ type: 'local', title: s.title, production: s.production, batch: 0 })
    ids.push(store.tabs[store.tabs.length - 1].id)
  }
  window.__b = { ids }
  store.changeActiveTabId(ids[0])
  return JSON.stringify({ ids, active: store.activeTabId })
})()
`

const READY = `
(() => {
  const ids = window.__b.ids
  return ids.every(id => {
    const tab = window.store.tabs.find(t => t.id === id)
    const addon = window.__addonOf(id)
    return !!tab && tab.status === 'success' && !!addon && !addon.disposed
  })
})()
`

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
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })
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

const waitFor = async (cdp, expr, label, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await cdp.eval(expr)
    if (ok) {
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

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  await cdp.eval(STUB)
  const setup = JSON.parse(await cdp.eval(SETUP))
  const [src, b2, b3] = setup.ids
  const ready = await waitFor(cdp, READY, 'three local shells connected', 20000)
  check('三个本地终端就绪', ready, setup)

  // ---- 1) 打开目标选择：默认只勾非生产 ----
  await cdp.eval('window.store.toggleBroadcast()')
  await waitFor(cdp, '!!window.__modal()', 'broadcast picker')
  await sleep(450) // 等 antd 弹层缩放动画落定，截图才不是半开状态
  const m1 = JSON.parse(await cdp.eval('JSON.stringify(window.__modal())') || 'null')
  const checked = m1.items.filter(i => i.checked).map(i => i.title)
  check('弹层列出 2 个目标、默认只勾非生产', m1 && m1.items.length === 2 && checked.length === 1 && checked[0] === 'B2-plain', { checked, items: m1 && m1.items })
  check('生产目标带徽章', !!m1 && m1.items.some(i => i.prod && i.title === 'B3-prod'), m1 && m1.items)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-picker.png')))

  // ---- 2) 全选 → 确认步骤 → 开启 ----
  await cdp.eval('window.__pickAll()')
  await sleep(200)
  await cdp.eval('window.__modalBtn(/开始广播|Start/)')
  await waitFor(cdp, '!!(window.__modal() || {}).confirmWarn', 'production confirm step')
  await sleep(450)
  const m2 = JSON.parse(await cdp.eval('JSON.stringify(window.__modal())') || 'null')
  check('选中生产机先进入确认步骤并列出主机', !!m2 && m2.confirmWarn && /B3-prod/.test(m2.confirmHosts), m2 && m2.confirmHosts)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-prod-confirm.png')))
  await cdp.eval('window.__modalBtn(/仍要开启|anyway/i)')
  const started = await waitFor(cdp, 'window.store.broadcast.on === true && window.store.broadcast.targets.length === 2', 'broadcast on')
  await sleep(300)
  const barText = await cdp.eval('window.__barText()')
  check('确认后开启广播：红条出现并显示台数', started && /2/.test(barText), barText)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-broadcasting.png')))

  // ---- 3) 输入镜像到全部目标 ----
  const MARK = 'BCAST-7731'
  await cdp.eval(`window.__send(${JSON.stringify(src)}, ${JSON.stringify(`echo ${MARK}\r`)})`)
  const mirrored = await waitFor(cdp, `window.__count(${JSON.stringify(b2)}, '${MARK}') > 0 && window.__count(${JSON.stringify(b3)}, '${MARK}') > 0`, 'mirrored output', 8000)
  const counts = JSON.parse(await cdp.eval(`JSON.stringify({src: window.__count(${JSON.stringify(src)}, '${MARK}'), b2: window.__count(${JSON.stringify(b2)}, '${MARK}'), b3: window.__count(${JSON.stringify(b3)}, '${MARK}')})`))
  check('主控输入同一命令三台同时执行', mirrored && counts.b2 > 0 && counts.b3 > 0 && counts.src > 0, counts)

  // ---- 4) 密码期闸门 ----
  const SECRET = 'SEC9f31'
  await cdp.eval(`window.__send(${JSON.stringify(src)}, ${JSON.stringify('stty -echo; read -p "Password: " P; stty echo; echo DONE-$P\r')})`)
  const blocked = await waitFor(cdp, "window.store.broadcast.blocked === 'password' && window.__barBlocked()", 'password gate', 8000)
  check('密码提示出现后红条进入已暂停', blocked, await cdp.eval('window.__barText()'))
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-password-paused.png')))
  await cdp.eval(`window.__send(${JSON.stringify(src)}, ${JSON.stringify(SECRET)})`)
  await cdp.eval(`window.__send(${JSON.stringify(src)}, '\\r')`)
  await sleep(800)
  const leaks = JSON.parse(await cdp.eval(`JSON.stringify({b2: window.__count(${JSON.stringify(b2)}, '${SECRET}'), b3: window.__count(${JSON.stringify(b3)}, '${SECRET}')})`))
  const unblocked = await cdp.eval('window.store.broadcast.blocked === null && !window.__barBlocked()')
  const localDone = await waitFor(cdp, `window.__count(${JSON.stringify(src)}, 'DONE-' + '${SECRET}') > 0`, 'source got password', 6000)
  check('密码不上目标机（target 收到 0 次）', leaks.b2 === 0 && leaks.b3 === 0, leaks)
  check('回车后闸门解除、镜像恢复', unblocked && localDone, { unblocked, localDone })

  // ---- 5) 关掉一个目标 tab → 自动移出 ----
  await cdp.eval(`window.store.delTab(${JSON.stringify(b2)})`)
  const removed = await waitFor(cdp, 'window.store.broadcast.on === true && window.store.broadcast.targets.length === 1', 'target removed')
  const leftTargets = JSON.parse(await cdp.eval('JSON.stringify(window.store.broadcast.targets.map(t => t.title))'))
  check('目标关页后自动移出，广播继续', removed && leftTargets.length === 1 && leftTargets[0] === 'B3-prod', leftTargets)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-target-lost.png')))

  // ---- 6) 退出广播后不再镜像 ----
  await cdp.eval('window.__clickBar()')
  const stopped = await waitFor(cdp, 'window.store.broadcast.on === false && !window.__visBar()', 'stopped')
  const AFTER = 'AFTER-5591'
  await cdp.eval(`window.__send(${JSON.stringify(src)}, ${JSON.stringify(`echo ${AFTER}\r`)})`)
  await waitFor(cdp, `window.__count(${JSON.stringify(src)}, '${AFTER}') > 0`, 'source after echo', 6000)
  await sleep(600)
  const afterCount = await cdp.eval(`window.__count(${JSON.stringify(b3)}, '${AFTER}')`)
  check('退出后再输入只有主控收到', stopped && afterCount === 0, { stopped, b3: afterCount })

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.stack ? err.stack : err)
  process.exit(1)
})
