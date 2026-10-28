#!/usr/bin/env node
/**
 * R1 键列表任意跳页 —— CDP 实机演示/回归（无需真 Redis）
 *
 * 在渲染层 IPC 边界注入桩 Redis（5000 键 / 20 键一页 / 250 页），
 * 真实走 db-session 的键列表分页器，验证：
 *   1) 首页页码 1、首行 user:000001（antd 虚拟表格只渲染可视行，数量断言放宽到 ≥10）
 *   2) 跳到第 180 页 → 页码 180、首行 user:003581（179*20+1）、请求 pageIndex=179
 *   3) 跳完之后按「上一页」→ 页码 179、首行 user:003561（证明游标链重建的 prev 栈可用）
 *   4) 深跳第 2000 页 → 先弹确认（>500 页告警，文案已本地化），确认后越界夹到末页 250、首行 user:004981
 *
 * 用法：
 *   1) npm run vite-build
 *   2) DISPLAY=:0 HOME=/tmp/electerm-cdp-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9222 --no-sandbox
 *   3) node self-test/redis-keys-jump-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'redis-keys-jump-shots')

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
  const KEYS = 5000
  const PAGE = 20
  const PAGES = Math.ceil(KEYS / PAGE)
  const keyName = n => 'user:' + String(n).padStart(6, '0')
  const rowsOfPage = p => {
    const rows = []
    const from = p * PAGE + 1
    const to = Math.min(KEYS, (p + 1) * PAGE)
    for (let i = from; i <= to; i++) {
      rows.push({ name: keyName(i), type: i % 5 === 0 ? 'hash' : 'string', ttl: -1 })
    }
    return rows
  }
  const cursorPage = c => {
    const s = String(c || '0')
    return s === '0' ? 0 : Number(s.replace(/^p/, ''))
  }
  window.__redisCalls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__redisCalls.push(op + ' ' + JSON.stringify(args))
      if (op === 'getMetadata') {
        return Promise.resolve([
          { name: 'db0', type: 'database', count: KEYS },
          { name: 'db1', type: 'database', count: 0 }
        ])
      }
      if (op === 'getPageData') {
        const p = cursorPage(args.cursor)
        return Promise.resolve({
          rows: rowsOfPage(p),
          nextCursor: 'p' + (p + 1),
          hasMore: p + 1 < PAGES
        })
      }
      if (op === 'scanKeysToPage') {
        const target = Math.max(0, Math.min(Number(args.pageIndex) || 0, PAGES - 1))
        const cursors = []
        for (let i = 0; i <= target; i++) {
          cursors.push(i === 0 ? '0' : 'p' + i)
        }
        return Promise.resolve({
          rows: rowsOfPage(target),
          nextCursor: 'p' + (target + 1),
          hasMore: target + 1 < PAGES,
          cursors,
          pageIndex: target
        })
      }
      if (op === 'getKeyDetail') {
        return Promise.resolve({ type: 'string', value: 'demo-value', fields: [], ttl: -1 })
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(a[0] === 'list' ? [] : null)
    }
    if (name === 'openDbTab') {
      return Promise.resolve({ ok: true })
    }
    if (name === 'closeDbTab') {
      return Promise.resolve(null)
    }
    return Promise.resolve(null)
  }
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__clickDb = name => {
    const el = [...document.querySelectorAll('.db-tree-db-name')]
      .filter(window.__vis)
      .find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__visBar = () =>
    [...document.querySelectorAll('.db-redis-bar')].find(window.__vis)
  // antd 虚拟表格只渲染可视区（约 17 行），数量断言须放宽
  window.__keyRows = () => {
    const c = [...document.querySelectorAll('.db-redis-keys')].find(window.__vis)
    if (!c) return []
    return [...c.querySelectorAll('.ant-table-row')]
      .map(r => r.innerText.trim().split(/\\s+/)[0])
  }
  window.__pageNo = () => {
    const bar = window.__visBar()
    const el = bar && bar.querySelector('.db-grid-page-no')
    return el ? Number((el.innerText.match(/\\d+/) || [0])[0]) : 0
  }
  window.__jump = n => {
    const bar = window.__visBar()
    const input = bar && bar.querySelector('.db-grid-jump')
    if (!input) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, String(n))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const btns = [...input.closest('.db-grid-pager').querySelectorAll('button')]
    const go = btns[btns.length - 1]
    if (!go) return 'no-go'
    go.click()
    return 'ok'
  }
  window.__prev = () => {
    const bar = window.__visBar()
    const btn = bar && bar.querySelector('.db-grid-pager button')
    if (!btn) return 'no-prev'
    btn.click()
    return 'ok'
  }
  window.__modal = () => {
    const t = document.querySelector('.ant-modal-confirm-title')
    const c = document.querySelector('.ant-modal-confirm-content')
    const ok = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')
    return JSON.stringify({
      title: t ? t.innerText.trim() : '',
      content: c ? c.innerText.trim() : '',
      hasOk: !!ok
    })
  }
  window.__modalOk = () => {
    const ok = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')
    if (!ok) return 'no-ok'
    ok.click()
    return 'ok'
  }
  window.__dismissModals = () => {
    const btns = [...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-default')]
    btns.forEach(b => b.click())
    return btns.length
  }
  return 'stub-installed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis 127.0.0.1:6379',
    dbType: 'redis',
    dbHost: '127.0.0.1',
    dbPort: 6379,
    dbPassword: '',
    dbName: '0',
    dbSsl: false,
    readOnly: true,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null, active: window.store.activeTabId })
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
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
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

const waitFor = async (cdp, expr, label, timeout = 8000) => {
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
  // 窗口若最小化/被遮挡，document.hidden=true 会冻结 CSS 动画（弹窗停在 opacity 0），
  // 截图也会拿到旧帧 —— 必须先拉到前台
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  await cdp.eval(STUB)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await waitFor(cdp, '!!window.__visBar && document.querySelectorAll(\'.db-tree-db-name\').length > 0', 'tree loaded')
  await cdp.eval('window.__dismissModals()')

  // 选中 db0 → 键列表首页
  const clickRes = await cdp.eval("window.__clickDb('db0')")
  await waitFor(cdp, 'window.__keyRows().length >= 10 && window.__pageNo() === 1', 'first page rows')
  const firstPageRows = JSON.parse(await cdp.eval('JSON.stringify(window.__keyRows())'))
  const pageNo1 = await cdp.eval('window.__pageNo()')
  check('选中 db0 后键列表出首页', clickRes === 'ok' && firstPageRows.length >= 10, { clickRes, rows: firstPageRows.length })
  check('首页页码为 1、首行 user:000001', pageNo1 === 1 && firstPageRows[0] === 'user:000001', { pageNo1, first: firstPageRows[0] })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-page1.png')))

  // 跳第 180 页
  const jumpRes = await cdp.eval('window.__jump(180)')
  await waitFor(cdp, 'window.__pageNo() === 180 && window.__keyRows()[0] === "user:003581"', 'page 180')
  const pageNo180 = await cdp.eval('window.__pageNo()')
  const rows180 = JSON.parse(await cdp.eval('JSON.stringify(window.__keyRows())'))
  const calls = JSON.parse(await cdp.eval('JSON.stringify(window.__redisCalls)'))
  check('跳页请求走 scanKeysToPage(pageIndex=179)', calls.some(c => c.indexOf('scanKeysToPage') === 0 && c.indexOf('"pageIndex":179') > -1), jumpRes)
  check('跳到第 180 页：页码与首行正确', pageNo180 === 180 && rows180[0] === 'user:003581', { pageNo180, first: rows180[0], rendered: rows180.length })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-jump-180.png')))

  // 跳完后按上一页（验证 prev 栈由游标链重建）
  await cdp.eval('window.__prev()')
  await waitFor(cdp, 'window.__pageNo() === 179 && window.__keyRows()[0] === "user:003561"', 'page 179')
  const pageNo179 = await cdp.eval('window.__pageNo()')
  const rows179 = JSON.parse(await cdp.eval('JSON.stringify(window.__keyRows())'))
  check('跳页后上一页可用（游标链重建栈）', pageNo179 === 179 && rows179[0] === 'user:003561', { pageNo179, first: rows179[0] })

  // 深跳 2000 页：先确认（超出 250 页末页，服务端夹到末页）
  await cdp.eval('window.__jump(2000)')
  await waitFor(cdp, '!!document.querySelector(".ant-modal-confirm-title")', 'confirm modal')
  const modal = JSON.parse(await cdp.eval('window.__modal()') || '{}')
  const translated = !!modal.title && !/^db[A-Z]/.test(modal.title) && /跳|scan/i.test(modal.content)
  check('深跳 >500 页先弹确认（文案已本地化）', !!modal.title && modal.hasOk && translated, modal)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-deep-warn.png')))
  await cdp.eval('window.__modalOk()')
  await waitFor(cdp, 'window.__pageNo() === 250 && window.__keyRows()[0] === "user:004981"', 'clamped last page')
  await waitFor(cdp, '!document.querySelector(".ant-modal-confirm-title")', 'modal closed')
  const pageNo2000 = await cdp.eval('window.__pageNo()')
  const rows2000 = JSON.parse(await cdp.eval('JSON.stringify(window.__keyRows())'))
  check('确认后越界夹到末页 250：首行 user:004981', pageNo2000 === 250 && rows2000[0] === 'user:004981', { pageNo2000, first: rows2000[0] })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-jump-2000.png')))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.stack ? err.stack : err)
  process.exit(1)
})
