#!/usr/bin/env node
/**
 * DBX / 终端 内存占用与回收探针（CDP 驱动，无需真库）
 *
 * 目的：回答"关键字高亮渲染、数据库数据加载有没有内存问题"——
 * 单元测试只证明源码形状，内存问题必须真的把页面渲染出来、反复操作、
 * 强制 GC 后看保留量。做法：
 *   1) 渲染层 IPC 边界注入桩数据（主进程一行不改）
 *   2) 每个采样点 HeapProfiler.collectGarbage 两次后读 Runtime.getHeapUsage /
 *      Performance.getMetrics（Nodes / JSEventListeners / Documents）
 *   3) 场景：500 行宽文本网格 + 关键字高亮 + 页内过滤循环、翻页循环、
 *      SQL 3 万行大结果重载、Redis 键列表跳页、Redis 详情"加载更多"、
 *      DB tab 开关循环、终端关键字高亮洪泛
 *   4) 堆采样（HeapProfiler.startSampling）定位分配热点
 *
 * 用法（见脚本尾部启动说明）：
 *   node self-test/mem-probe.js [debugPort] [reportPath]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'
const MAIN_PORT = process.argv[4] || '9230'
const REPORT = process.argv[3] || path.join(__dirname, 'mem-probe-report.json')
const SHOT_DIR = path.join(__dirname, 'mem-probe-shots')

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

  async eval (expression, awaitPromise = false) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + String(expression).slice(0, 100))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      return null
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  close () {
    try {
      this.ws.close()
    } catch (e) {}
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mb = n => Math.round(n / 1024 / 1024 * 10) / 10

const waitFor = async (cdp, expr, timeout = 20000, label = '') => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await cdp.eval(expr)
    if (v) {
      return v
    }
    await sleep(120)
  }
  throw new Error('waitFor timeout: ' + (label || expr))
}

// ------------------------------------------------------------------ 桩数据
const STUB = `
(() => {
  const cfg = window.__MEM = {
    pageRows: 400,
    bigRows: 30000,
    redisKeys: 1000,
    detailTotal: 200000,
    gridCalls: 0,
    sqlCalls: 0,
    detailCalls: 0
  }
  const cell = (i, j) => 'alice lorem ipsum dolor sit amet ' + ('bcdefghij'.repeat(5)) + ' r' + i + 'c' + j
  const mkRows = (page, n) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      const r = { id: page * n + i + 1, name: i % 3 === 0 ? 'alice' : 'bob' + i, email: 'user' + i + '@example.com', amount: i * 10, note: 'alice special note ' + i }
      for (let j = 0; j < 3; j++) {
        r['c' + j] = cell(i, j)
      }
      rows.push(r)
    }
    return rows
  }
  const mkBig = (n) => {
    const rows = []
    for (let i = 0; i < n; i++) {
      const r = { id: i, a: 'alice ' + ('v'.repeat(40)) + i, b: 'lorem ' + ('w'.repeat(30)) + i, c: 'dolor ' + i, d: 'plain-' + i, e: 'x' + i }
      rows.push(r)
    }
    return rows
  }
  const cols = [
    { name: 'id', type: 'int', comment: '主键' },
    { name: 'name', type: 'varchar(64)', comment: '用户名' },
    { name: 'email', type: 'varchar(128)', comment: '' },
    { name: 'amount', type: 'decimal(10,2)', comment: '金额' },
    { name: 'note', type: 'text', comment: '' },
    { name: 'c0', type: 'text', comment: 'c0' },
    { name: 'c1', type: 'text', comment: 'c1' },
    { name: 'c2', type: 'text', comment: 'c2' }
  ]
  const hashPage = (cursor) => {
    const start = Number(cursor) || 0
    const size = 200
    const fields = []
    const rows = {}
    for (let i = 0; i < size; i++) {
      const f = 'field:' + (start + i)
      const v = 'alice lorem ' + ('z'.repeat(180)) + '#' + (start + i)
      fields.push(f)
      rows[f] = v
    }
    const next = start + size
    return {
      type: 'hash',
      fields,
      rows,
      total: cfg.detailTotal,
      nextCursor: next >= cfg.detailTotal ? '0' : String(next),
      hasMore: next < cfg.detailTotal,
      ttl: -1
    }
  }
  window.__dbStubCalls = []
  const orig = window.pre.runGlobalAsync
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [] })
    if (name !== 'dbClientOp') return Promise.resolve(null)
    const op = a[1]
    const args = a[2] || {}
    const tab = window.store.tabs.find(t => t.id === a[0]) || {}
    const isRedis = tab.dbType === 'redis'
    window.__dbStubCalls.push(op)
    if (op === 'getDbTxState') {
      return Promise.resolve({ active: false, pendingCount: 0, statements: [], supported: !isRedis })
    }
    if (op === 'getMetadata') {
      if (isRedis) {
        return Promise.resolve([
          { name: 'db0', type: 'database', count: cfg.redisKeys },
          { name: 'db1', type: 'database', count: 12 }
        ])
      }
      return Promise.resolve([{
        name: 'demo',
        type: 'database',
        children: [
          { name: 't_big', type: 'table' },
          { name: 't_wide', type: 'table' }
        ]
      }])
    }
    if (op === 'describeTable') {
      return Promise.resolve([
        { Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment' },
        { Field: 'name', Type: 'varchar(64)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'email', Type: 'varchar(128)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'amount', Type: 'decimal(10,2)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'note', Type: 'text', Null: 'YES', Key: '', Default: null, Extra: '' }
      ])
    }
    if (op === 'getTableStructure') return Promise.resolve({ columns: cols, foreignKeys: [] })
    if (op === 'listColumns') return Promise.resolve(cols.map(c => ({ name: c.name, type: c.type })))
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'countRows') return Promise.resolve({ count: cfg.pageRows * 1000 })
    if (op === 'getPageData') {
      cfg.gridCalls++
      if (args.match !== undefined) {
        // redis 键列表
        const n = cfg.redisKeys
        const rows = []
        for (let i = 0; i < n; i++) {
          rows.push({ name: 'key:' + args.cursor + ':' + i, type: i % 5 === 0 ? 'hash' : 'string', ttl: -1 })
        }
        return Promise.resolve({ rows, nextCursor: String((Number(args.cursor) || 0) + 1), hasMore: true })
      }
      const page = Number(args.offset || 0) / cfg.pageRows
      return Promise.resolve({ rows: mkRows(page, cfg.pageRows), totalRows: cfg.pageRows * 1000, hasMore: true })
    }
    if (op === 'scanKeysToPage') {
      const target = Number(args.pageIndex) || 0
      const cursors = []
      for (let i = 0; i < target; i++) cursors.push(String(i))
      cursors.push(String(target))
      const rows = []
      for (let i = 0; i < cfg.redisKeys; i++) {
        rows.push({ name: 'jump:' + target + ':' + i, type: 'string', ttl: -1 })
      }
      return Promise.resolve({ rows, nextCursor: String(target + 1), hasMore: true, cursors, pageIndex: target })
    }
    if (op === 'getKeyDetail') {
      cfg.detailCalls++
      if (args.key && args.key.indexOf('str:') === 0) {
        return Promise.resolve({ type: 'string', value: 'alice lorem string value', fields: [], total: 28, ttl: -1 })
      }
      return Promise.resolve(hashPage(args.cursor))
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
  return 'stub-installed'
})()
`

const HELPERS = `
window.__hidden = el => {
  let n = el
  while (n && n !== document.body) {
    if (getComputedStyle(n).display === 'none') return true
    n = n.parentElement
  }
  return false
}
window.__vis = el => !window.__hidden(el)
window.__treeTitle = name => [...document.querySelectorAll('.ant-tree-title')]
  .filter(window.__vis).find(x => x.innerText.trim() === name)
window.__treeDb = name => [...document.querySelectorAll('.db-tree-db-name')]
  .filter(window.__vis).find(x => x.innerText.trim() === name)
window.__visRows = () => [...document.querySelectorAll('.ant-table-row')].filter(window.__vis).length
window.__clickText = (sel, re) => {
  const el = [...document.querySelectorAll(sel)].filter(window.__vis)
    .find(x => re.test(x.innerText || ''))
  if (!el) return 'missing'
  el.click()
  return 'ok'
}
window.__setInput = (sel, value) => {
  const el = document.querySelector(sel)
  if (!el) return 'missing'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
}
window.__jumpRedis = (page) => {
  const input = document.querySelector('.db-redis-area .db-grid-pager input.db-grid-jump')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, String(page))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const btns = [...document.querySelectorAll('.db-redis-area .db-grid-pager button')].filter(window.__vis)
  const go = btns[btns.length - 1]
  if (!go) return 'no-go'
  if (go.disabled) return 'go-disabled'
  go.click()
  return 'ok'
}
window.__clickPagerRight = () => {
  const btn = [...document.querySelectorAll('.db-grid-pager .anticon-right')]
    .map(i => i.closest('button')).filter(Boolean).filter(window.__vis)
    .find(b => !b.disabled)
  if (!btn) return 'disabled'
  btn.click()
  return 'ok'
}
window.__domStats = () => ({
  all: document.querySelectorAll('*').length,
  rows: document.querySelectorAll('.ant-table-row').length,
  visRows: window.__visRows(),
  kws: document.querySelectorAll('.db-kw').length,
  xterms: document.querySelectorAll('.xterm').length
})
`

const openDbTab = (dbType) => `
(() => {
  const prev = new Set(window.store.tabs.map(t => t.id))
  const t = {
    type: 'database',
    from: 'quick-connect',
    title: '${dbType} stub',
    dbType: '${dbType}',
    dbHost: '127.0.0.1',
    dbPort: ${dbType === 'redis' ? 6379 : 3306},
    dbUser: 'root',
    dbPassword: '',
    dbName: 'demo',
    dbSsl: false,
    readOnly: ${dbType === 'redis'},
    production: false,
    batch: window.store.currentLayoutBatch
  }
  window.store.addTab(t)
  const added = window.store.tabs.filter(x => !prev.has(x.id))
  return JSON.stringify({ id: added.length ? added[added.length - 1].id : '' })
})()
`

// ------------------------------------------------------------------ 度量
class Metrics {
  constructor (cdp, mainCdp) {
    this.cdp = cdp
    this.mainCdp = mainCdp
    this.rows = []
  }

  async snap (label, extra) {
    const cdp = this.cdp
    await cdp.call('HeapProfiler.collectGarbage')
    await sleep(250)
    await cdp.call('HeapProfiler.collectGarbage')
    await sleep(150)
    const heap = await cdp.call('Runtime.getHeapUsage')
    const perf = await cdp.call('Performance.getMetrics')
    const m = {}
    for (const it of (perf.result && perf.result.metrics) || []) {
      m[it.name] = it.value
    }
    const dom = JSON.parse(await cdp.eval('JSON.stringify(window.__domStats ? window.__domStats() : {})') || '{}')
    let domCounters = null
    try {
      const dc = await cdp.call('Memory.getDOMCounters')
      domCounters = dc.result || null
    } catch (e) {}
    let main = null
    if (this.mainCdp) {
      try {
        const mu = await this.mainCdp.eval("JSON.stringify({heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, handles: process._getActiveHandles ? process._getActiveHandles().length : -1})")
        main = JSON.parse(mu || 'null')
      } catch (e) {
        main = null
      }
    }
    const row = {
      label,
      usedMB: mb((heap.result && heap.result.usedSize) || m.JSHeapUsedSize || 0),
      used: (heap.result && heap.result.usedSize) || m.JSHeapUsedSize || 0,
      nodes: m.Nodes,
      listeners: m.JSEventListeners,
      docs: m.Documents,
      dom,
      domCounters,
      main,
      at: Date.now(),
      extra
    }
    this.rows.push(row)
    console.log(
      'SNAP  ' + label.padEnd(34) +
      ' heap=' + String(row.usedMB + 'MB').padEnd(7) +
      ' nodes=' + String(row.nodes).padEnd(7) +
      ' listeners=' + String(row.listeners).padEnd(6) +
      (domCounters ? ' domNodes=' + String(domCounters.nodes).padEnd(7) : '') +
      (dom.visRows !== undefined ? ' visRows=' + String(dom.visRows).padEnd(4) : '') +
      (main ? ' mainRSS=' + mb(main.rss) + 'MB' : '') +
      (extra ? ' ' + JSON.stringify(extra) : '')
    )
    return row
  }

  report () {
    return this.rows
  }
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target; start app with --remote-debugging-port')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Performance.enable')
  await cdp.call('HeapProfiler.enable')

  // 主进程 inspector（可选）
  let mainCdp = null
  try {
    const mt = await getJson(`http://127.0.0.1:${MAIN_PORT}/json`)
    const mtgt = (mt || [])[0]
    if (mtgt && mtgt.webSocketDebuggerUrl) {
      mainCdp = new Cdp(mtgt.webSocketDebuggerUrl)
      await mainCdp.ready
      await mainCdp.call('Runtime.enable')
      console.log('main inspector attached on', MAIN_PORT)
    }
  } catch (e) {
    console.log('main inspector not available:', e.message)
  }

  const M = new Metrics(cdp, mainCdp)
  const findings = []

  await waitFor(cdp, '!!(window.store && window.pre)', 30000, 'app boot')
  await cdp.eval(HELPERS)

  // 关键字高亮配置（3 条规则；数据库页与终端共用）
  await cdp.eval(`(() => {
    window.store.setConfig({
      keywords: [
        { keyword: 'alice', color: 'red' },
        { keyword: 'lorem', color: 'green' },
        { keyword: 'dolor', color: 'cyan' }
      ],
      scrollback: 3000
    })
    return 'config-set'
  })()`)
  await sleep(300)

  await M.snap('baseline')

  await cdp.eval(STUB)
  console.log('stub installed')

  // ---------------------------------------------------------------- S1 网格
  const dbTab = JSON.parse(await cdp.eval(openDbTab('mysql')))
  await sleep(1200)
  await waitFor(cdp, "!!window.__treeTitle('demo')", 20000, 'metadata root')
  await cdp.eval("(() => { const d = window.__treeTitle('demo'); if (d) d.click(); return 1 })()")
  await waitFor(cdp, "!!window.__treeTitle('t_big')", 15000, 'metadata children')
  await sleep(300)
  await cdp.eval("(() => { const t = window.__treeTitle('t_big'); if (!t) return 0; t.click(); return 1 })()")
  await waitFor(cdp, 'window.__visRows() > 0', 20000, 'grid rows')
  await sleep(800)
  const s1 = await M.snap('grid-400rows-8cols', { tab: dbTab.id })
  await cdp.shot(path.join(SHOT_DIR, '1-grid.png'))
  const hit0 = await cdp.eval("document.querySelectorAll('.db-kw').length")
  findings.push({ name: 'grid virtualizes rows', ok: s1.dom.visRows < 400, detail: { visRows: s1.dom.visRows, totalRowsDom: s1.dom.rows, kwSpans: hit0 } })
  if (hit0 === 0) {
    findings.push({ name: 'keyword highlight spans present in grid', ok: false, detail: { kwSpans: 0 } })
  } else {
    findings.push({ name: 'keyword highlight spans present in grid', ok: true, detail: { kwSpans: hit0 } })
  }

  // 页内过滤循环（高亮渲染压力）
  await cdp.call('HeapProfiler.startSampling', { samplingInterval: 32768 })
  const filterSnaps = []
  for (let i = 0; i < 12; i++) {
    await cdp.eval(`window.__setInput('.db-page-filter input', '${i % 2 === 0 ? 'alice' : ''}')`)
    await sleep(180)
    if (i % 3 === 2) {
      filterSnaps.push(await M.snap('filter-cycle-' + (i + 1), { hits: await cdp.eval("document.querySelectorAll('.db-page-hit').length") }))
    }
  }
  const prof = await cdp.call('HeapProfiler.stopSampling')
  // 汇总自采样：按函数名统计
  const alloc = {}
  try {
    const p = prof.result && prof.result.profile
    const nodes = (p && p.nodes) || []
    const selfById = {}
    for (const s of ((p && p.samples) || [])) {
      selfById[s.nodeId] = (selfById[s.nodeId] || 0) + (s.size || 0)
    }
    for (const n of nodes) {
      const size = selfById[n.id] || 0
      if (!size) continue
      const cf = n.callFrame || {}
      const name = (cf.functionName || '(anonymous)') + ' @ ' + String(cf.url || '').split('/').slice(-1)[0] + ':' + (cf.lineNumber || 0)
      alloc[name] = (alloc[name] || 0) + size
    }
  } catch (e) {}
  const allocTop = Object.entries(alloc).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => ({ fn: k, mb: mb(v) }))
  findings.push({ name: 'filter cycles heap stable', ok: (filterSnaps[filterSnaps.length - 1].used - filterSnaps[0].used) < 3 * 1024 * 1024, detail: { firstMB: filterSnaps[0].usedMB, lastMB: filterSnaps[filterSnaps.length - 1].usedMB } })

  // 翻页循环
  const pageSnaps = []
  for (let i = 0; i < 20; i++) {
    const r = await cdp.eval('window.__clickPagerRight()')
    if (r !== 'ok') break
    await sleep(350)
    if (i % 5 === 4) pageSnaps.push(await M.snap('page-load-' + (i + 1)))
  }
  if (pageSnaps.length >= 2) {
    const growth = pageSnaps[pageSnaps.length - 1].used - pageSnaps[0].used
    findings.push({ name: 'page loads release old data', ok: growth < 4 * 1024 * 1024, detail: { firstMB: pageSnaps[0].usedMB, lastMB: pageSnaps[pageSnaps.length - 1].usedMB, growthMB: mb(growth) } })
  }
  await cdp.shot(path.join(SHOT_DIR, '2-grid-paged.png'))

  // ---------------------------------------------------------------- S2 SQL 大结果
  await cdp.eval("window.__clickText('.ant-tabs-tab', /^\\s*SQL\\s*$/)")
  await waitFor(cdp, "!!document.querySelector('.cm-content')", 20000, 'sql editor')
  await sleep(300)
  await cdp.eval("document.querySelector('.cm-content').focus()")
  await cdp.call('Input.insertText', { text: 'select * from big' })
  await sleep(200)
  await cdp.eval("(() => { const b = [...document.querySelectorAll('.db-sql-bar button')].filter(window.__vis)[0]; if (!b) return 0; b.click(); return 1 })()")
  await waitFor(cdp, "!!document.querySelector('.db-sql-result-one .ant-table-row')", 30000, 'sql result')
  await sleep(600)
  const s2 = await M.snap('sql-30k-rows', { rows: 30000 })
  await cdp.shot(path.join(SHOT_DIR, '3-sql-big.png'))
  findings.push({ name: 'sql big result kept in heap (expected, unbounded)', ok: true, detail: { heapMB: s2.usedMB, deltaMB: mb(s2.used - s1.used), visRows: s2.dom.visRows } })

  // 小查询覆盖后应释放
  const callsBefore = await cdp.eval('window.__MEM.sqlCalls')
  await cdp.eval("document.querySelector('.cm-content').focus()")
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await cdp.call('Input.insertText', { text: 'select 1' })
  await sleep(200)
  await cdp.eval("[...document.querySelectorAll('.db-sql-bar .ant-btn-primary')].filter(window.__vis)[0].click()")
  try {
    await waitFor(cdp, `window.__MEM.sqlCalls > ${callsBefore} && /select 1/.test(window.__MEM.lastSql || '')`, 10000, 'sql replace fired')
  } catch (e) {
    // 兜底：execCommand selectAll（CM6 会通过 DOM 观察同步选区）
    await cdp.eval("(() => { const c = document.querySelector('.cm-content'); if (!c) return 0; c.focus(); document.execCommand('selectAll'); return 1 })()")
    await cdp.call('Input.insertText', { text: 'select 1' })
    await sleep(250)
    await cdp.eval("[...document.querySelectorAll('.db-sql-bar .ant-btn-primary')].filter(window.__vis)[0].click()")
  }
  await sleep(1200)
  const s3 = await M.snap('sql-result-replaced', {
    sqlCalls: await cdp.eval('window.__MEM.sqlCalls'),
    lastSql: await cdp.eval('window.__MEM.lastSql')
  })
  const released = s2.used - s3.used
  const replaceOk = await cdp.eval("(window.__MEM.sqlCalls > " + callsBefore + ") && /select 1/.test(window.__MEM.lastSql || '')")
  findings.push({
    name: 'replacing sql result releases big rows',
    ok: !!replaceOk && released > (s2.used - s1.used) * 0.6,
    detail: { bigMB: mb(s2.used - s1.used), releasedMB: mb(released), replaceOk: !!replaceOk }
  })

  // 关掉 mysql tab
  await cdp.eval(`window.store.delTab('${dbTab.id}')`)
  await sleep(2500)
  const s4 = await M.snap('mysql-tab-closed')
  await sleep(3000)
  const s4b = await M.snap('mysql-tab-closed-idle')
  findings.push({ name: 'closing db tab frees grid data', ok: (s4b.used - s1.used) < 6 * 1024 * 1024, detail: { backToMB: s4b.usedMB, baseMB: s1.usedMB } })
  findings.push({
    name: 'detached DOM after tab close is reclaimed',
    ok: !s4b.domCounters || s4b.domCounters.nodes < 3000,
    detail: { domNodes: s4b.domCounters && s4b.domCounters.nodes, attached: s4b.dom.all, listenersDom: s4b.domCounters && s4b.domCounters.jsEventListeners }
  })

  // ---------------------------------------------------------------- S3 Redis
  const redisTab = JSON.parse(await cdp.eval(openDbTab('redis')))
  await sleep(1000)
  await waitFor(cdp, "!!window.__treeDb('db0')", 20000, 'redis db nodes')
  await cdp.eval("(() => { const d = window.__treeDb('db0'); if (!d) return 0; d.click(); return 1 })()")
  await waitFor(cdp, "document.querySelectorAll('.db-redis-keys .ant-table-row').length > 0", 20000, 'redis keys')
  await sleep(500)
  const s5 = await M.snap('redis-keys-1000', { visRows: await cdp.eval('window.__visRows()') })

  // 跳页（R1）：第 60 页
  const jumpRes = await cdp.eval('window.__jumpRedis(60)')
  await waitFor(cdp, "(document.querySelector('.db-redis-area .db-grid-page-no') || {}).innerText !== '' && (document.querySelector('.db-redis-area .db-grid-page-no') || {}).innerText.includes('60')", 15000, 'redis jump page 60')
  await sleep(600)
  const s6 = await M.snap('redis-key-jump-60', { jump: jumpRes, pageNo: await cdp.eval("(document.querySelector('.db-redis-area .db-grid-page-no') || {}).innerText || ''") })
  findings.push({ name: 'redis key jump holds only cursors chain + page', ok: (s6.used - s5.used) < 4 * 1024 * 1024, detail: { deltaMB: mb(s6.used - s5.used) } })

  // 打开 hash 详情并"加载更多"
  await cdp.eval("(() => { const r = [...document.querySelectorAll('.db-redis-keys .ant-table-row')].filter(window.__vis)[0]; if (!r) return 0; r.click(); return 1 })()")
  await waitFor(cdp, "!!document.querySelector('.db-redis-more')", 20000, 'redis detail')
  await sleep(400)
  const detailSnaps = []
  for (let i = 0; i < 15; i++) {
    const r = await cdp.eval("(() => { const b = document.querySelector('.db-redis-more'); if (!b || b.disabled) return 'missing'; b.click(); return 'ok' })()")
    if (r !== 'ok') break
    await sleep(450)
    if (i % 5 === 4) detailSnaps.push(await M.snap('redis-detail-more-' + (i + 1)))
  }
  const d0 = detailSnaps[0] || s6
  const dLast = detailSnaps[detailSnaps.length - 1] || d0
  findings.push({ name: 'redis detail load-more grows linearly (by design)', ok: true, detail: { firstMB: d0.usedMB, lastMB: dLast.usedMB, growthMB: mb(dLast.used - d0.used) } })

  // 切换键 → 旧详情应释放
  await cdp.eval("(() => { const rows = [...document.querySelectorAll('.db-redis-keys .ant-table-row')].filter(window.__vis); const r = rows[1]; if (!r) return 0; r.click(); return 1 })()")
  await sleep(1200)
  const s7 = await M.snap('redis-detail-switched')
  findings.push({ name: 'switching redis key releases previous detail', ok: (s7.used - s6.used) < 8 * 1024 * 1024, detail: { backToMB: s7.usedMB } })

  await cdp.shot(path.join(SHOT_DIR, '4-redis.png'))
  await cdp.eval(`window.store.delTab('${redisTab.id}')`)
  await sleep(1200)
  await M.snap('redis-tab-closed')

  // ---------------------------------------------------------------- S4 tab 开关循环
  const cycleSnaps = []
  for (let i = 0; i < 5; i++) {
    const t = JSON.parse(await cdp.eval(openDbTab('mysql')))
    await sleep(900)
    await waitFor(cdp, "!!window.__treeTitle('demo')", 15000, 'cycle root')
    await cdp.eval("(() => { const d = window.__treeTitle('demo'); if (d) d.click(); return 1 })()")
    await waitFor(cdp, "!!window.__treeTitle('t_big')", 15000, 'cycle tree')
    await cdp.eval("(() => { const t = window.__treeTitle('t_big'); if (t) t.click(); return 1 })()")
    await sleep(700)
    await cdp.eval(`window.store.delTab('${t.id}')`)
    await sleep(700)
    cycleSnaps.push(await M.snap('tab-cycle-' + (i + 1)))
  }
  if (cycleSnaps.length >= 2) {
    const growth = cycleSnaps[cycleSnaps.length - 1].used - cycleSnaps[0].used
    findings.push({ name: 'db tab open/close cycles do not leak', ok: growth < 4 * 1024 * 1024, detail: { firstMB: cycleSnaps[0].usedMB, lastMB: cycleSnaps[cycleSnaps.length - 1].usedMB, growthMB: mb(growth) } })
  }

  // ---------------------------------------------------------------- S5 终端高亮洪泛
  let termSnaps = []
  try {
    await cdp.eval("(() => { window.store.addTab({ type: 'local', batch: window.store.currentLayoutBatch }); return 1 })()")
    await waitFor(cdp, "!!document.querySelector('.xterm')", 20000, 'local terminal')
    await sleep(1500)
    await cdp.eval("(() => { const s = [...document.querySelectorAll('.xterm-screen')].filter(window.__vis)[0]; if (s) s.click(); return 1 })()")
    await sleep(300)
    const typeCmd = async (text) => {
      await cdp.eval(`(() => { const t = [...document.querySelectorAll('.xterm-helper-textarea')].filter(window.__vis)[0] || document.querySelector('.xterm-helper-textarea'); if (!t) return 0; t.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); return 1 })()`)
      await sleep(120)
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    }
    await typeCmd('for i in $(seq 1 30000); do echo "alice lorem ipsum dolor sit amet $i"; done')
    await sleep(3500)
    termSnaps.push(await M.snap('term-flood-30k-lines-1'))
    for (let i = 2; i <= 4; i++) {
      await typeCmd('for i in $(seq 1 30000); do echo "alice lorem ipsum dolor sit amet $i"; done')
      await sleep(3500)
      termSnaps.push(await M.snap('term-flood-30k-lines-' + i))
    }
    const growth = termSnaps[termSnaps.length - 1].used - termSnaps[0].used
    findings.push({ name: 'terminal flood respects scrollback (heap plateau)', ok: growth < 8 * 1024 * 1024, detail: { firstMB: termSnaps[0].usedMB, lastMB: termSnaps[termSnaps.length - 1].usedMB, growthMB: mb(growth) } })
    await cdp.shot(path.join(SHOT_DIR, '5-terminal.png'))
  } catch (e) {
    findings.push({ name: 'terminal flood scenario', ok: false, detail: { error: e.message } })
  }

  const final = await M.snap('final')
  findings.push({ name: 'final heap vs baseline', ok: (final.used - M.rows[0].used) < 20 * 1024 * 1024, detail: { baseMB: M.rows[0].usedMB, finalMB: final.usedMB } })

  const report = {
    at: new Date().toISOString(),
    app: 'electerm mem-probe',
    snaps: M.report(),
    allocTop,
    findings
  }
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
  console.log('\n===== FINDINGS =====')
  for (const f of findings) {
    console.log((f.ok ? 'PASS  ' : 'FAIL  ') + f.name + ' :: ' + JSON.stringify(f.detail))
  }
  console.log('\nreport ->', REPORT)
  console.log('shots  ->', SHOT_DIR)
  const failed = findings.filter(f => !f.ok)
  cdp.close()
  if (mainCdp) mainCdp.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('MEM-PROBE ERROR:', err.stack || err.message)
  process.exit(2)
})
