// N9-② 专项探针：DbGridTable 恒虚拟化（高度未知也不退回全量渲染）
//
// 验收口径（TODO §1 N9-②）："3 万行页签切走不残留上万 DOM"。
// 数据页单页最多 200 行（DB_PAGE_SIZE_MAX），退化全量 = 200 行 DOM；
// 虚拟化生效 = 只渲染视口那 ~20 行。判据阈值 60 在两者之间，干净区分。
//
// 四判据（同一 3 万行表、config.dbPageSize=200）：
//   1. 稳态虚拟：出数后 DOM 行数 ≤ 60 且 .ant-table-tbody-virtual 容器存在
//   2. 切走切回：changeActiveTabId 切走再切回，DOM 行数仍 ≤ 60（不残留）
//   3. 极小窗口（区分性判据）：Emulation 把窗口压到 200x50 → wrap < 表头+分页器
//      → measuredY=0 → ESTIMATED_VH 顶上 → 仍虚拟。
//      旧写法 virtual={y>0} 在此时序 y=0 → antd 退回全量 200 行 DOM → 必 FAIL。
//      这是"证明修复而非巧合"的证伪口径：变异对照（回退旧写法）下只有判据 3 红。
//   4. 恢复窗口：clearDeviceMetricsOverride 后回到稳态行为。
const http = require('node:http')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9223'

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

// 桩：3 万行表，getPageData 按 page/pageSize 切片。只覆盖数据页最小闭环。
const STUB = `
(() => {
  const N = 30000
  const mkRow = i => ({ id: i, name: 'row-' + i, note: i % 7 ? 'n' + i : null })
  const COLS = [
    { name: 'id', dataType: 'int', isPk: true },
    { name: 'name', dataType: 'varchar' },
    { name: 'note', dataType: 'varchar' }
  ]
  if (!window.__prePristine) {
    window.__prePristine = { runGlobalAsync: window.pre.runGlobalAsync }
  }
  window.__dbStub = 'virtual-n92'
  window.__unstubPre = () => {
    window.pre.runGlobalAsync = window.__prePristine.runGlobalAsync
    delete window.__dbStub
    return 'restored'
  }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'demo_db', children: [{ name: 'big_table', type: 'table' }] }])
      }
      if (op === 'describeTable') {
        return Promise.resolve(COLS.map(c => ({ Field: c.name, Type: c.dataType, Key: c.isPk ? 'PRI' : '', Null: 'YES' })))
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({ columns: COLS, foreignKeys: [] })
      }
      if (op === 'getPageData') {
        const size = Math.max(1, Number(args.pageSize) || 20)
        const page = Math.max(1, Number(args.page) || 1)
        const lo = (page - 1) * size
        const rows = []
        for (let i = lo; i < Math.min(lo + size, N); i++) rows.push(mkRow(i + 1))
        return Promise.resolve({ rows, totalRows: N, page, hasMore: lo + size < N })
      }
      if (op === 'getReferences') return Promise.resolve({ references: [], degraded: false })
      if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], lastTx: null })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab' || name === 'closeDbTab') return Promise.resolve({ ok: true })
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
  window.__clickTree = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim() === text)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  window.__vrows = () =>
    [...document.querySelectorAll('.db-grid-area .ant-table-tbody .ant-table-row')].filter(window.__vis).length
  window.__hasVirtual = () => {
    const g = [...document.querySelectorAll('.db-grid-area .db-grid-table')].filter(window.__vis)[0]
    return g ? (g.querySelector('.ant-table-tbody-virtual') ? 1 : 0) : -1
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
    title: 'virtual n92 probe',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'demo',
    dbPassword: '',
    dbName: 'demo_db',
    dbSsl: false,
    readOnly: false,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
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
    throw new Error('no renderer page target; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  const stub = await cdp.eval(STUB)
  check('桩 3 万行表已注入', stub === 'stub-installed', { stub })

  // 页大小顶到 200（store.setConfig 与 UI Select 同一条 changePageSize 路径）
  await cdp.eval('window.store.setConfig({ dbPageSize: 200 })')

  const opened = JSON.parse(await cdp.eval(OPEN_TAB))
  check('DB tab 已打开', !!opened.id, opened)
  await sleep(800)

  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree render', 6000)
  await cdp.eval('window.__clickTree("demo_db")')
  const clicked = await waitFor(cdp, 'window.__clickTree("big_table") === "ok"', 'tree node big_table', 6000)
  check('展开 demo_db 并点开 big_table', clicked, { clicked })
  const ready = await waitFor(cdp, 'window.__vrows() > 0', 'grid first paint', 10000)

  // 判据 1：稳态虚拟（200 行/页 → 全量渲染 DOM=200；虚拟化 DOM=视口 ~20 行）
  const dom1 = await cdp.eval('window.__vrows()')
  const virt1 = await cdp.eval('window.__hasVirtual()')
  check('N9② 稳态虚拟：200 行/页 DOM 行数 ≤60 且虚拟容器在（全量退化会是 200）',
    ready && dom1 > 0 && dom1 <= 60 && virt1 === 1, { domRows: dom1, virtual: virt1 })

  // 判据 2：切走切回不退化
  const tid = JSON.stringify(opened.id)
  await cdp.eval('(() => { const others = window.store.tabs.filter(t => t.id !== ' + tid + '); if (others.length) window.store.changeActiveTabId(others[others.length - 1].id); return others.length })()')
  await sleep(500)
  await cdp.eval('window.store.changeActiveTabId(' + tid + ')')
  await sleep(800)
  const dom2 = await cdp.eval('window.__vrows()')
  const virt2 = await cdp.eval('window.__hasVirtual()')
  check('N9② 切走切回：DOM 行数不残留暴涨且虚拟容器在',
    dom2 > 0 && dom2 <= 60 && virt2 === 1, { domRows: dom2, virtual: virt2 })

  // 判据 3：极小窗口 → measuredY=0 → ESTIMATED_VH 兜底（区分性判据）
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 200, height: 50, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  const dom3 = await cdp.eval('window.__vrows()')
  const virt3 = await cdp.eval('window.__hasVirtual()')
  check('N9② 极小窗口：measuredY=0 时由 ESTIMATED_VH 兜底仍虚拟（旧写法此处退回全量 200 行）',
    virt3 === 1 && dom3 <= 60, { domRows: dom3, virtual: virt3 })
  await cdp.call('Emulation.clearDeviceMetricsOverride', {})
  await sleep(600)

  // 判据 4：恢复正常
  const dom4 = await cdp.eval('window.__vrows()')
  const virt4 = await cdp.eval('window.__hasVirtual()')
  check('N9② 恢复窗口：回到稳态虚拟', virt4 === 1 && dom4 > 0 && dom4 <= 60, { domRows: dom4, virtual: virt4 })

  // 收尾：还原桩
  console.log('unstub ->', await cdp.eval('window.__unstubPre()'))

  const fail = results.filter(r => !r.ok)
  console.log('\\n== N9-② virtual probe: ' + (results.length - fail.length) + '/' + results.length + ' pass ==')
  process.exit(fail.length ? 1 : 0)
}

main().catch(e => {
  console.error('probe error:', e.message)
  process.exit(2)
})
