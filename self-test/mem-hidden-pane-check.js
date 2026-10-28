const http = require('node:http')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'
const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
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
      if (cb) { this.pending.delete(m.id); cb(m) }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression, awaitPromise = false) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    const d = r.result && r.result.exceptionDetails
    if (d) throw new Error('eval failed: ' + (d.exception && d.exception.description))
    return r.result && r.result.result ? r.result.result.value : undefined
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mb = n => Math.round(n / 1048576 * 10) / 10

const waitFor = async (cdp, expr, timeout = 20000, label = '') => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await cdp.eval(expr)
    if (v) return v
    await sleep(120)
  }
  throw new Error('waitFor timeout: ' + (label || expr))
}

const STUB = `
(() => {
  const cfg = window.__HP = { rows: 400 }
  const cell = (i, j) => 'alice lorem ipsum dolor sit amet ' + ('bcdefghij'.repeat(5)) + ' r' + i + 'c' + j
  const mkRows = (page, n) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      const r = { id: page * n + i + 1, name: i % 3 === 0 ? 'alice' : 'bob' + i, email: 'user' + i + '@example.com', amount: i * 10, note: 'alice special note ' + i }
      for (let j = 0; j < 3; j++) r['c' + j] = cell(i, j)
      rows.push(r)
    }
    return rows
  }
  const cols = ['id', 'name', 'email', 'amount', 'note', 'c0', 'c1', 'c2']
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name !== 'dbClientOp') return Promise.resolve(null)
    const op = a[1]
    const args = a[2] || {}
    if (op === 'getMetadata') return Promise.resolve([{ name: 'demo', type: 'database', children: [{ name: 't_big', type: 'table' }] }])
    if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], supported: true })
    if (op === 'getTableStructure') return Promise.resolve({ columns: cols.map(c => ({ name: c, type: 'text' })), foreignKeys: [] })
    if (op === 'describeTable') return Promise.resolve(cols.map(c => ({ Field: c, Type: 'text', Null: 'YES', Key: '', Default: null, Extra: '' })))
    if (op === 'countRows') return Promise.resolve({ count: 400000 })
    if (op === 'getPageData') {
      const page = Number(args.offset || 0) / cfg.rows
      return Promise.resolve({ rows: mkRows(page, cfg.rows), totalRows: 400000, hasMore: true })
    }
    return Promise.resolve(null)
  }
  return 'stub'
})()
`

const snap = async (cdp, label) => {
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(220)
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(120)
  const heap = await cdp.call('Runtime.getHeapUsage')
  const dom = JSON.parse(await cdp.eval(`JSON.stringify({
    all: document.querySelectorAll('*').length,
    kws: document.querySelectorAll('.db-kw').length,
    panes: [...document.querySelectorAll('.ant-tabs-tabpane')].filter(p => /db-session|database/.test(p.className) || p.querySelector('.db-grid-table')).map(p => ({
      active: p.className.includes('tabpane-active'),
      rows: p.querySelectorAll('.ant-table-row').length
    })),
    dataRows: [...document.querySelectorAll('.db-grid-table')].map(t => ({
      rows: t.querySelectorAll('.ant-table-row').length,
      h: t.clientHeight
    }))
  })`) || '{}')
  console.log(label.padEnd(22), 'heap=' + (mb(heap.result.usedSize) + 'MB').padEnd(7), JSON.stringify(dom))
  return heap.result.usedSize
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('HeapProfiler.enable')

  await waitFor(cdp, '!!(window.store && window.pre)', 30000, 'boot')
  await cdp.eval('window.store.tabs.filter(t => t.type === "database").forEach(t => window.store.delTab(t.id)); 1')
  await sleep(600)
  await cdp.eval(`window.store.setConfig({ keywords: [
    { keyword: 'alice', color: 'red' }, { keyword: 'lorem', color: 'green' }, { keyword: 'dolor', color: 'cyan' }
  ] }); 1`)
  const base = await snap(cdp, 'baseline')
  await cdp.eval(STUB)

  const tabId = await cdp.eval(`
  (() => {
    const prev = new Set(window.store.tabs.map(t => t.id))
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'hidden pane', dbType: 'mysql',
      dbHost: '127.0.0.1', dbPort: 3306, dbUser: 'root', dbPassword: '', dbName: 'demo',
      dbSsl: false, readOnly: false, production: false, batch: window.store.currentLayoutBatch
    })
    const added = window.store.tabs.filter(x => !prev.has(x.id))
    return added.length ? added[added.length - 1].id : ''
  })()`)
  await sleep(1200)
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const d = [...document.querySelectorAll('.ant-tree-title')].find(x => x.innerText.trim() === 'demo' && vis(x))
    if (d) d.click()
    return 1
  })()`)
  await sleep(700)
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const t = [...document.querySelectorAll('.ant-tree-title')].find(x => x.innerText.trim() === 't_big' && vis(x))
    if (t) t.click()
    return 1
  })()`)
  await waitFor(cdp, "[...document.querySelectorAll('.db-grid-table')].some(t => t.querySelectorAll('.ant-table-row').length > 0)", 25000, 'grid rows')
  await sleep(900)
  const a = await snap(cdp, 'data-active')

  // 切到 SQL 页签：数据面板隐藏
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => /^\\s*SQL\\s*$/.test(x.innerText) && vis(x))
    if (!t) throw new Error('SQL tab missing')
    t.click()
    return 1
  })()`)
  await sleep(1800)
  const b = await snap(cdp, 'sql-active(data hidden)')
  await sleep(2500)
  const c = await snap(cdp, 'sql-active +2.5s')

  // 切回数据页签
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => /^\\s*数据\\s*$/.test(x.innerText) && vis(x))
    if (!t) throw new Error('data tab missing')
    t.click()
    return 1
  })()`)
  await sleep(1500)
  const d = await snap(cdp, 'data-active-again')

  console.log('\nSUMMARY')
  console.log('  hidden pane cost MB:', mb(b - a), ' (sustained:', mb(c - a) + ')')
  console.log('  back to data MB:', mb(d - a), ' residual vs baseline:', mb(d - base))
  await cdp.eval(`window.store.delTab('${tabId}')`)
  cdp.ws.close()
  process.exit(0)
}

main().catch(e => { console.error('HIDDEN-PANE ERROR', e.stack || e.message); process.exit(2) })
