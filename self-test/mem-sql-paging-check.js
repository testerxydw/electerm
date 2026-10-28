const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || ''
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
  const cfg = window.__PZ = { bigRows: 30000, sqlCalls: 0, lastSql: '', rows: 400 }
  const mkBig = (n) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      rows.push({ id: i, a: 'alice ' + ('v'.repeat(40)) + i, b: 'lorem ' + ('w'.repeat(30)) + i, c: 'dolor ' + i, d: 'plain-' + i, e: 'x' + i })
    }
    return rows
  }
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
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name !== 'dbClientOp') return Promise.resolve(null)
    const op = a[1]
    const args = a[2] || {}
    if (op === 'getMetadata') return Promise.resolve([{ name: 'demo', type: 'database', children: [{ name: 't_big', type: 'table' }] }])
    if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], supported: true })
    if (op === 'getTableStructure') return Promise.resolve({ columns: ['id', 'name', 'email', 'amount', 'note', 'c0', 'c1', 'c2'].map(c => ({ name: c, type: 'text' })), foreignKeys: [] })
    if (op === 'countRows') return Promise.resolve({ count: 400000 })
    if (op === 'getPageData') {
      const page = Number(args.offset || 0) / cfg.rows
      return Promise.resolve({ rows: mkRows(page, cfg.rows), totalRows: 400000, hasMore: true })
    }
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
  if (SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, label + '.png'), Buffer.from(shot.result.data, 'base64'))
  }
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(220)
  await cdp.call('HeapProfiler.collectGarbage')
  await sleep(120)
  const heap = await cdp.call('Runtime.getHeapUsage')
  const dom = JSON.parse(await cdp.eval(`JSON.stringify({
    all: document.querySelectorAll('*').length,
    sqlRows: document.querySelectorAll('.db-sql-result-one .ant-table-row').length,
    sqlKws: document.querySelectorAll('.db-sql-result-one .db-kw').length,
    pager: !!document.querySelector('.db-sql-result-one .ant-pagination'),
    pagerTotal: (document.querySelector('.db-sql-result-one .ant-pagination-total-text') || {}).textContent || '',
    pagerItems: [...document.querySelectorAll('.db-sql-result-one .ant-pagination-item')].map(x => x.textContent),
    activePage: (document.querySelector('.db-sql-result-one .ant-pagination-item-active') || {}).textContent || '',
    firstRow: ((document.querySelector('.db-sql-result-one .ant-table-row') || {}).innerText || '').replace(/\\n/g, ' | ').slice(0, 60)
  })`) || '{}')
  console.log(label.padEnd(22), 'heap=' + (mb(heap.result.usedSize) + 'MB').padEnd(7), JSON.stringify(dom))
  return { heap: heap.result.usedSize, dom }
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
  await sleep(700)
  await cdp.eval(`window.store.setConfig({ keywords: [
    { keyword: 'alice', color: 'red' }, { keyword: 'lorem', color: 'green' }, { keyword: 'dolor', color: 'cyan' }
  ] }); 1`)
  await sleep(250)
  await cdp.eval(STUB)
  const base = await snap(cdp, 'baseline')

  // 1) 网格页大小上限：config 写 1000，选择器只能显示 200
  await cdp.eval('window.store.setConfig({ dbPageSize: 1000 }); 1')
  const tabId = await cdp.eval(`
  (() => {
    const prev = new Set(window.store.tabs.map(t => t.id))
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'paging check', dbType: 'mysql',
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
    if (!t) throw new Error('SQL tab missing')
    t.click()
    return 1
  })()`)
  await waitFor(cdp, "!!document.querySelector('.cm-content')", 15000, 'cm')
  await sleep(400)

  // 2) 30k 行结果：应分页（50/页）、DOM 行数 ≤ 60、翻页可换页
  const run = async (sql) => {
    await cdp.eval("document.querySelector('.cm-content').focus()")
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await cdp.call('Input.insertText', { text: sql })
    await sleep(250)
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.db-sql-bar .ant-btn-primary')].find(b => b.getBoundingClientRect().width > 0)
      if (!btn) throw new Error('run button missing')
      btn.click()
      return 1
    })()`)
    await waitFor(cdp, '/big|select 1/.test(window.__PZ.lastSql || "")', 15000, 'fired ' + sql)
    await sleep(1500)
  }

  await run('select * from big')
  await waitFor(cdp, "document.querySelectorAll('.db-sql-result-one .ant-table-row').length > 0", 30000, 'big rows')
  await sleep(600)
  const big = await snap(cdp, 'sql-30k-paged')

  const p2 = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.db-sql-result-one .ant-pagination-item')].find(x => x.textContent === '2')
    if (!item) return 'missing'
    item.querySelector('a').click()
    return 'ok'
  })()`)
  await sleep(900)
  const page2 = await snap(cdp, 'sql-page-2')

  const p5 = await cdp.eval(`(() => {
    const item = [...document.querySelectorAll('.db-sql-result-one .ant-pagination-item')].find(x => x.textContent === '5')
    if (!item) return 'missing'
    item.querySelector('a').click()
    return 'ok'
  })()`)
  await sleep(900)
  const page5 = await snap(cdp, 'sql-page-5')

  // 3) 小结果覆盖：分页器消失
  await run('select 1')
  await waitFor(cdp, "document.querySelectorAll('.db-sql-result-one .ant-table-row').length === 1", 15000, 'small result')
  await sleep(400)
  const small = await snap(cdp, 'sql-small-again')

  // 4) 数据页签仍虚拟化（隐藏面板修复）且页大小选择器显示 200
  await cdp.eval(`(() => {
    const vis = el => el && el.getBoundingClientRect().width > 0
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => /^\\s*数据\\s*$/.test(x.innerText) && vis(x))
    if (t) t.click()
    return 1
  })()`)
  await sleep(600)
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
  await sleep(700)
  const grid = await snap(cdp, 'grid-config-1000')
  const pageSizeText = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.db-grid-pagesize')].find(x => x.getBoundingClientRect().width > 0)
    return el ? el.textContent.trim() : 'missing'
  })()`)

  console.log('\nSUMMARY')
  console.log('  pager page 2 click:', p2, '| page 5 click:', p5)
  console.log('  big result heap delta MB:', mb(big.heap - base.heap))
  console.log('  dom nodes big:', big.dom.all, '(was 10905 before paging)')
  console.log('  sql DOM rows: p1=' + big.dom.sqlRows, 'p2=' + page2.dom.sqlRows, 'p5=' + page5.dom.sqlRows)
  console.log('  active page: p1=' + big.dom.activePage, 'p2=' + page2.dom.activePage, 'p5=' + page5.dom.activePage)
  console.log('  first row: p1=' + big.dom.firstRow)
  console.log('             p2=' + page2.dom.firstRow)
  console.log('             p5=' + page5.dom.firstRow)
  console.log('  pager items:', JSON.stringify(big.dom.pagerItems), 'total text:', big.dom.pagerTotal)
  console.log('  small result pager gone:', small.dom.pager === false, 'rows=' + small.dom.sqlRows)
  console.log('  grid pageSize selector (config=1000):', pageSizeText)
  console.log('  grid rows rendered:', grid.dom.sqlRows, 'hidden-pane safe (all nodes):', grid.dom.all)

  await cdp.eval(`window.store.delTab('${tabId}')`)
  cdp.ws.close()
  process.exit(0)
}

main().catch(e => { console.error('PAGING CHECK ERROR', e.stack || e.message); process.exit(2) })
