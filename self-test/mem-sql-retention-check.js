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
  const cfg = window.__MEM = { bigRows: 30000, sqlCalls: 0, lastSql: '' }
  const mkBig = (n) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      rows.push({ id: i, a: 'alice ' + ('v'.repeat(40)) + i, b: 'lorem ' + ('w'.repeat(30)) + i, c: 'dolor ' + i, d: 'plain-' + i, e: 'x' + i })
    }
    return rows
  }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name !== 'dbClientOp') return Promise.resolve(null)
    const op = a[1]
    const args = a[2] || {}
    if (op === 'getMetadata') return Promise.resolve([{ name: 'demo', type: 'database', children: [] }])
    if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], supported: true })
    if (op === 'getPageData') return Promise.resolve({ rows: [], totalRows: 0, hasMore: false })
    if (op === 'countRows') return Promise.resolve({ count: 0 })
    if (op === 'executeSql') {
      cfg.sqlCalls++
      cfg.lastSql = args.sql
      if (/big/i.test(args.sql || '')) {
        return Promise.resolve({ results: [{ rows: mkBig(cfg.bigRows), fields: ['id', 'a', 'b', 'c', 'd', 'e'] }] })
      }
      return Promise.resolve({ results: [{ rows: [{ id: 1, v: 'alice small' }], fields: ['id', 'v'] }] })
    }
    return Promise.resolve(null)
  }
  return 'stub'
})()
`

const snap = async (cdp, label) => {
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(250)
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(150)
  const heap = await cdp.call('Runtime.getHeapUsage')
  const dc = await cdp.call('Memory.getDOMCounters')
  const rows = await cdp.eval("document.querySelectorAll('.db-sql-result-one .ant-table-row').length")
  console.log(label.padEnd(26), 'heap=' + (mb(heap.result.usedSize) + 'MB').padEnd(7), 'nodes=' + String(dc.result.nodes).padEnd(7), 'sqlRows=' + rows)
  return heap.result.usedSize
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Performance.enable')
  await cdp.call('HeapProfiler.enable')

  await waitFor(cdp, '!!(window.store && window.pre)', 30000, 'boot')
  await cdp.eval('window.store.tabs.filter(t => t.type === "database").forEach(t => window.store.delTab(t.id)); 1')
  await sleep(800)
  await cdp.eval(`window.store.setConfig({ keywords: [
    { keyword: 'alice', color: 'red' },
    { keyword: 'lorem', color: 'green' },
    { keyword: 'dolor', color: 'cyan' }
  ] }); 1`)
  await sleep(300)
  const base = await snap(cdp, 'baseline')

  await cdp.eval(STUB)

  const tabId = await cdp.eval(`
  (() => {
    const prev = new Set(window.store.tabs.map(t => t.id))
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'sql leak check', dbType: 'mysql',
      dbHost: '127.0.0.1', dbPort: 3306, dbUser: 'root', dbPassword: '', dbName: 'demo',
      dbSsl: false, readOnly: false, production: false, batch: window.store.currentLayoutBatch
    })
    const added = window.store.tabs.filter(x => !prev.has(x.id))
    return added.length ? added[added.length - 1].id : ''
  })()`)
  await sleep(1200)
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => /^\\s*SQL\\s*$/.test(x.innerText) && vis(x))
    if (!t) throw new Error('visible SQL tab missing')
    t.click()
    return 1
  })()`)
  await waitFor(cdp, "!!document.querySelector('.cm-content')", 15000, 'cm')
  await sleep(400)

  const run = async (sql) => {
    await cdp.eval("document.querySelector('.cm-content').focus()")
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await cdp.call('Input.insertText', { text: sql })
    await sleep(250)
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.db-sql-bar .ant-btn-primary')]
        .find(b => b.getBoundingClientRect().width > 0)
      if (!btn) throw new Error('run button missing')
      btn.click()
      return 1
    })()`)
    await waitFor(cdp, `window.__MEM.lastSql === ${JSON.stringify(sql)}`, 15000, 'fired ' + sql)
    await sleep(1500)
  }

  await run('select 1')
  const a = await snap(cdp, 'small-result')
  await run('select * from big')
  const b = await snap(cdp, 'big-30k-result')
  await run('select 1')
  const c = await snap(cdp, 'replaced-small')
  await sleep(5000)
  const d = await snap(cdp, 'replaced-small-idle5s')
  await cdp.eval(`window.store.delTab('${tabId}')`)
  await sleep(2500)
  await snap(cdp, 'tab-closed-2.5s')
  await sleep(5000)
  const f = await snap(cdp, 'tab-closed-idle5s')

  console.log('\nSUMMARY')
  console.log('  big add      MB:', mb(b - a))
  console.log('  replace free MB:', mb(b - c), ' (idle:', mb(b - d) + ')')
  console.log('  close free   MB:', mb(d - f))
  console.log('  residual vs baseline MB:', mb(f - base))
  cdp.ws.close()
  process.exit(0)
}

main().catch(e => { console.error('LEAKCHECK ERROR', e.stack || e.message); process.exit(2) })
