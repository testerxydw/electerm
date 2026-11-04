#!/usr/bin/env node
/**
 * 数据网格交互（H2）—— CDP 实机回归（无需真 MySQL）
 *
 * 覆盖 H2 在数据页上新增的交互：
 *   1) 单元格右键菜单：项的顺序与出现条件、点项收起、外部按下/Esc/滚动三条关闭通道
 *   2) 复制族：复制值 / 字段名 / 整行 TSV / 整行 JSON（列集与屏幕同源，不带 __rowKey）
 *   3) 查看完整值 → 底部值面板给全文；编辑单元格 → 行内编辑
 *   4) 按值过滤 → 写进本页过滤（徽标 1 / N），清空后恢复
 *   5) 外键列 → "跳到引用行"，跳转后视角条带定位条件
 *   6) 空串与 NULL 的三种可区分渲染（'' / NULL / 字符串 "NULL"）
 *   7) 底部"行"页签：字段数 = 屏幕列数，值随选中行切换
 *
 * 本脚本在渲染层 IPC 边界注入桩 MySQL（metadata / structure / page / references），
 * 所有动作都是真实点击/右键，判据全部读 DOM。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) Xvfb :110 -nolisten tcp &
 *      DISPLAY=:110 HOME=/tmp/electerm-cdp-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9223 --no-sandbox
 *   3) node self-test/db-grid-interactions-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9223'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-grid-interactions-shots')

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
  const LONG = 'D'.repeat(5000)
  const ROWS = [
    { id: 1, flag: '', note: null, detail: LONG, parameter: { uid: 1001, action: 'order.export' } },
    { id: 2, flag: 'no', note: 'n2', detail: 'short one', parameter: { uid: 1002 } },
    // 字符串字面量 "NULL"：和真 NULL / 空串要能分开看
    { id: 3, flag: 'ok', note: 'n3', detail: 'd3', parameter: 'NULL' }
  ]
  for (let i = 4; i <= 12; i++) {
    ROWS.push({ id: i, flag: i % 2 ? 'ok' : 'no', note: 'n' + i, detail: 'd' + i, parameter: { uid: 3000 + i } })
  }
  const COLS = [
    { name: 'id', dataType: 'int', isPk: true },
    { name: 'flag', dataType: 'varchar' },
    { name: 'note', dataType: 'varchar' },
    { name: 'detail', dataType: 'text' },
    { name: 'parameter', dataType: 'json' }
  ]
  const ORDER_COLS = [
    { name: 'order_id', dataType: 'int', isPk: true },
    { name: 'amount', dataType: 'decimal' }
  ]
  window.__copied = null
  // 桩是把 window.pre.runGlobalAsync 整个换掉的，跟着渲染进程存活：同一实例上
  // 后续跑真库脚本会量到 demo_db。这里留一手——记下原装实现、打上标记、给出还原口，
  // 真库脚本侧的检测见 db-ui-helpers.js 的 preStubState / ensureRealDbLayer
  if (!window.__prePristine) {
    window.__prePristine = {
      runGlobalAsync: window.pre.runGlobalAsync,
      writeClipboard: window.pre.writeClipboard
    }
  }
  window.__dbStub = 'grid-demo'
  window.__unstubPre = () => {
    const p = window.__prePristine
    if (!p) return 'nothing-to-restore'
    window.pre.runGlobalAsync = p.runGlobalAsync
    window.pre.writeClipboard = p.writeClipboard
    delete window.__dbStub
    return 'restored'
  }
  window.pre.writeClipboard = s => { window.__copied = String(s) }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo_db',
          children: [{ name: 'grid_demo', type: 'table' }, { name: 'orders', type: 'table' }]
        }])
      }
      if (op === 'describeTable') {
        const cols = args.table === 'orders' ? ORDER_COLS : COLS
        return Promise.resolve(cols.map(c => ({ Field: c.name, Type: c.dataType, Key: c.isPk ? 'PRI' : '', Null: 'YES' })))
      }
      if (op === 'getTableStructure') {
        const cols = args.table === 'orders' ? ORDER_COLS : COLS
        return Promise.resolve({
          columns: cols,
          // 只有 grid_demo.id 有外键：无外键列不该出现"跳到引用行"
          foreignKeys: args.table === 'grid_demo'
            ? [{ name: 'fk_order', columns: ['id'], refTable: 'orders', refColumns: ['order_id'], refSchema: 'demo_db', refDatabase: 'demo_db' }]
            : []
        })
      }
      if (op === 'getPageData') {
        const isOrders = args.table === 'orders'
        const rows = isOrders ? [{ order_id: 1, amount: 9.5 }] : ROWS
        return Promise.resolve({ rows, totalRows: rows.length, page: 1, hasMore: false })
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
  // 按列定位格子：虚拟表格里每格是 div.ant-table-cell[aria-label=列名]
  window.__cellIn = (col, text) => {
    const cells = [...document.querySelectorAll('.ant-table-row .ant-table-cell[aria-label="' + col + '"]')]
      .filter(window.__vis)
    if (text === undefined) return cells[0] || null
    return cells.find(c => String(c.innerText).trim().startsWith(text)) || null
  }
  window.__rightClick = (col, text) => {
    const c = window.__cellIn(col, text)
    if (!c) return 'no-cell:' + col + '/' + text
    const r = c.getBoundingClientRect()
    c.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 8)
    }))
    return 'ok'
  }
  window.__menuEl = () => [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis)[0] || null
  window.__menuDump = () => {
    const m = window.__menuEl()
    if (!m) return JSON.stringify({ open: 0, inDom: document.querySelectorAll('.db-cell-menu').length })
    return JSON.stringify({
      open: 1,
      inDom: document.querySelectorAll('.db-cell-menu').length,
      head: String((m.querySelector('.db-cell-menu-head') || {}).textContent || '').trim(),
      items: [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis).map(x => x.textContent.trim())
    })
  }
  window.__clickMenuItem = label => {
    const m = window.__menuEl()
    if (!m) return 'no-menu'
    const items = [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis)
    const it = items.find(x => x.textContent.trim() === label) ||
      items.find(x => new RegExp(label).test(x.textContent))
    if (!it) return 'no-item:' + label
    it.click()
    return 'ok'
  }
  window.__gridHeads = () => JSON.stringify(
    [...document.querySelectorAll('.db-grid-area .ant-table-thead th')]
      .filter(window.__vis)
      .map(t => t.innerText.trim().split('\\n')[0])
      .filter(Boolean)
  )
  window.__rowCount = () =>
    [...document.querySelectorAll('.db-grid-area .ant-table-tbody .ant-table-row')].filter(window.__vis).length
  window.__mutedColor = () => {
    // 取主题里 --text-muted 的真实像素色：占位弱化的口径是"颜色"，得有个可对比的基准
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;left:-9999px;color:var(--text-muted)'
    document.body.appendChild(d)
    const c = window.getComputedStyle(d).color
    d.remove()
    return c
  }
  window.__cellClasses = (col, text) => {
    const c = window.__cellIn(col, text)
    if (!c) return JSON.stringify({ found: 0 })
    const span = c.querySelector('.db-cell-empty, .db-cell-null')
    return JSON.stringify({
      found: 1,
      text: c.innerText.trim(),
      cls: span ? span.className : '',
      opacity: span ? window.getComputedStyle(span).opacity : '',
      weight: span ? window.getComputedStyle(span).fontWeight : '',
      color: span ? window.getComputedStyle(span).color : '',
      muted: window.__mutedColor()
    })
  }
  window.__pageFilterInput = () => {
    const inp = [...document.querySelectorAll('.db-page-filter input')].filter(window.__vis)[0]
    return inp || null
  }
  window.__filterState = () => {
    const inp = window.__pageFilterInput()
    const badge = [...document.querySelectorAll('.db-page-filter-count')].filter(window.__vis)[0]
    return JSON.stringify({
      value: inp ? inp.value : null,
      badge: badge ? badge.innerText.trim() : '',
      rows: window.__rowCount()
    })
  }
  window.__setPageFilter = v => {
    const inp = window.__pageFilterInput()
    if (!inp) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, v)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__paneOpen = () => {
    const p = [...document.querySelectorAll('.db-value-pane')].filter(window.__vis)[0]
    return p ? String((p.querySelector('.db-value-pane-pre') || {}).innerText || '').length : -1
  }
  window.__clickTab = label => {
    const t = [...document.querySelectorAll('.db-pane-tabs .ant-tabs-tab')]
      .filter(window.__vis)
      .find(x => x.innerText.replace(/\\s/g, '') === label)
    if (!t) return 'no-tab:' + label
    t.click()
    return 'ok'
  }
  window.__rowDetailFields = () => {
    const d = [...document.querySelectorAll('.db-pane-tabs .db-row-detail')].filter(window.__vis)[0]
    if (!d) return JSON.stringify({ open: 0 })
    return JSON.stringify({
      open: 1,
      fields: [...d.querySelectorAll('.db-row-detail-item')].map(it => ({
        name: (it.querySelector('.db-row-detail-field') || {}).innerText || '',
        value: (it.querySelector('.db-row-detail-value') || {}).innerText || ''
      }))
    })
  }
  window.__gridTitle = () => {
    const t = [...document.querySelectorAll('.db-grid-title')].filter(window.__vis)[0]
    return t ? t.innerText.trim() : ''
  }
  window.__viewBarText = () => {
    const bar = [...document.querySelectorAll('.db-view-bar, .db-viewbar, .db-view-wrap')].filter(window.__vis)[0]
    return bar ? bar.innerText.replace(/\\s+/g, ' ').slice(0, 300) : ''
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
    title: 'mysql grid demo',
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

const menuDump = async cdp => JSON.parse(await cdp.eval('window.__menuDump()'))
const json = async (cdp, expr) => JSON.parse(await cdp.eval(expr))

const menuGone = cdp => waitFor(cdp, 'window.__menuEl() === null', 'menu gone', 2000)

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  // 窗口不可见时 CSS 动画冻结、截图拿到旧帧
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  const stub = await cdp.eval(STUB)
  check('桩 MySQL 已注入', stub === 'stub-installed', { stub })
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  if (!openRes.id) {
    throw new Error('database tab was not created')
  }
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')

  // ---- 1) 打开表 ----
  // 表体是虚拟渲染（virtual 表格只挂可视区那几行 DOM），所以判据是"首屏出数"，
  // 总量 12 由过滤徽标 "1 / 12" 断言（见第 5 节）
  await cdp.eval('window.__clickTree("demo_db")')
  const expanded = await waitFor(cdp, 'window.__clickTree("grid_demo") === "ok"', 'db expanded')
  const gridReady = expanded && await waitFor(cdp, 'window.__rowCount() >= 5', 'grid rows')
  const baseRows = await cdp.eval('window.__rowCount()')
  check('打开桩表，网格出数（虚拟渲染首屏）', gridReady, { rows: baseRows })

  // ---- 2) 右键菜单开合 ----
  check('右键单元格弹出菜单', (await cdp.eval('window.__rightClick("detail", "short one")')) === 'ok' &&
    await waitFor(cdp, '!!window.__menuEl()', 'cell menu'))
  const dump = await menuDump(cdp)
  check('菜单标题=列名', dump.head === 'detail', dump.head)
  check('非外键列 7 项：复制族 4 + 完整值 + 编辑 + 按值过滤', dump.items.length === 7, dump.items)
  check('菜单文案走词条（不是裸 key）', !dump.items.some(t => /^db[A-Z]/.test(t)), dump.items)
  check('同时只挂一份浮层', dump.inDom === 1, { inDom: dump.inDom })
  // 浮层有 100ms 级入场动画：DOM 就绪≠画面就绪，截图前等动画落定
  await sleep(250)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-menu-dark.png')))

  // ---- 3) 复制族 ----
  check('复制值 → 剪贴板 = 格子文本', (await cdp.eval('window.__clickMenuItem("复制值")')) === 'ok' &&
    await cdp.eval('window.__copied') === 'short one', { copied: await cdp.eval('window.__copied') })
  await menuGone(cdp)

  await cdp.eval('window.__rightClick("detail", "short one")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu again')
  check('复制字段名 → 剪贴板 = 列名', (await cdp.eval('window.__clickMenuItem("复制字段名")')) === 'ok' &&
    await cdp.eval('window.__copied') === 'detail', { copied: await cdp.eval('window.__copied') })
  await menuGone(cdp)

  const heads = await json(cdp, 'window.__gridHeads()')
  await cdp.eval('window.__rightClick("detail", "short one")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu again')
  await cdp.eval('window.__clickMenuItem("复制整行（TSV）")')
  await sleep(200)
  const tsv = String(await cdp.eval('window.__copied') || '')
  const tsvHead = tsv.split('\n')[0]
  check('复制整行 TSV：首行=屏幕列名且不含 __rowKey',
    tsvHead === heads.join('\t') && !tsvHead.includes('__rowKey'), { tsvHead, heads })
  check('复制整行 TSV：取值对应该行（id=2）', String(tsv).split('\n')[1] === ['2', 'no', 'n2', 'short one', '[object Object]'].join('\t'), { row: String(tsv).split('\n')[1] })
  await menuGone(cdp)

  await cdp.eval('window.__rightClick("detail", "short one")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu again')
  await cdp.eval('window.__clickMenuItem("复制整行（JSON）")')
  await sleep(200)
  const rowJson = JSON.parse(String(await cdp.eval('window.__copied') || '[]'))
  const rowKeys = Object.keys(rowJson[0] || {})
  check('复制整行 JSON：字段与屏幕列一致且不含 __rowKey',
    rowKeys.join(',') === heads.join(',') && rowJson[0].id === 2, { rowKeys, row: rowJson[0] })
  await menuGone(cdp)

  // ---- 4) 查看完整值 / 编辑 ----
  await cdp.eval('window.__rightClick("detail", "DDDDDDDDDDDD")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu on long cell')
  check('"查看完整值"打开底部面板并给全文',
    (await cdp.eval('window.__clickMenuItem("查看完整值")')) === 'ok' &&
      await waitFor(cdp, 'window.__paneOpen() > 0', 'value pane') &&
      await cdp.eval('window.__paneOpen()') === 5000, { preLen: await cdp.eval('window.__paneOpen()') })
  check('点项后菜单收起（DOM 里不留旧菜单）', await menuGone(cdp) &&
    await cdp.eval('document.querySelectorAll(".db-cell-menu").length') === 0)

  await cdp.eval('window.__rightClick("note", "n2")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu on note')
  check('"编辑单元格"进入行内编辑',
    (await cdp.eval('window.__clickMenuItem("编辑单元格")')) === 'ok' &&
      await waitFor(cdp, '!!document.querySelector(".db-cell-editor")', 'editor'))
  await cdp.eval(`
    (() => {
      const inp = document.querySelector('.db-cell-editor')
      if (!inp) return 'no-input'
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'ok'
    })()
  `)
  await sleep(300)
  check('Esc 退出编辑态', await cdp.eval('!document.querySelector(".db-cell-editor")'))

  // ---- 5) 按值过滤 ----
  await cdp.eval('window.__rightClick("detail", "short one")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu for filter')
  await cdp.eval('window.__clickMenuItem("按此值过滤")')
  await waitFor(cdp, 'JSON.parse(window.__filterState()).rows === 1', 'filter applied', 4000)
  const filtered = await json(cdp, 'window.__filterState()')
  check('按值过滤写进本页过滤框，只留命中行', filtered.value === 'short one' && filtered.rows === 1, filtered)
  check('过滤徽标给命中 / 总数', filtered.badge === '1 / 12', filtered)
  // 菜单点项后走退场动画，等它真从 DOM 里卸掉再截，避免截到半透明残留
  await menuGone(cdp)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-filter-dark.png')))
  await cdp.eval('window.__setPageFilter("")')
  await waitFor(cdp, `window.__rowCount() === ${baseRows}`, 'filter cleared', 4000)
  check('清空过滤恢复全量', await cdp.eval('window.__rowCount()') === baseRows,
    { rows: await cdp.eval('window.__rowCount()'), baseRows })

  // ---- 6) 空串 / NULL / 字符串 "NULL" ----
  const emptyCell = await json(cdp, 'window.__cellClasses("flag", "\\u0027\\u0027")')
  const nullCell = await json(cdp, 'window.__cellClasses("note", "NULL")')
  const literalNull = await json(cdp, 'window.__cellClasses("parameter", "NULL")')
  check('空串渲染成 \'\' 占位（.db-cell-empty）',
    emptyCell.text === "''" && emptyCell.cls === 'db-cell-empty', emptyCell)
  check('NULL 带 .db-cell-null', nullCell.text === 'NULL' && nullCell.cls === 'db-cell-null', nullCell)
  check('字符串 "NULL" 两个类都没有（值 vs 空值分得开）',
    literalNull.text === 'NULL' && literalNull.cls === '', literalNull)
  // 弱化口径自 3a30571a 起是"颜色（--text-muted）"，不是 opacity（实测 0.45/0.5
  // 在浅色卡片底只剩 2.0~2.2:1，AA 守不住）。所以钉：两者同色且确实等于 --text-muted、
  // 都是满不透明（反向：谁再把弱化改回 opacity 就红），空串靠更细的字重与 "" 字形区分。
  check('空串与 NULL 同色同不透明，靠字形与字重区分（弱化用 --text-muted 不用 opacity）',
    emptyCell.color === nullCell.color && emptyCell.color === emptyCell.muted &&
    Number(emptyCell.opacity) === 1 && Number(nullCell.opacity) === 1 &&
    Number(emptyCell.weight) < Number(nullCell.weight) && emptyCell.text !== nullCell.text,
    { empty: emptyCell, null: nullCell })

  // ---- 7) 外键跳转 ----
  await cdp.eval('window.__rightClick("id", "1")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu on id')
  const fkDump = await menuDump(cdp)
  const fkItem = fkDump.items.find(t => /跳到引用行/.test(t))
  check('外键列出现"跳到引用行 → orders"', !!fkItem && /orders/.test(fkItem), fkDump.items)
  await sleep(250)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-fk-menu-dark.png')))
  await cdp.eval('window.__clickMenuItem("跳到引用行")')
  const jumped = await waitFor(cdp, 'window.__gridTitle().endsWith("orders")', 'jump to orders', 8000)
  const barText = await cdp.eval('window.__viewBarText()')
  check('跳转后表头切到 orders', jumped, { title: await cdp.eval('window.__gridTitle()') })
  check('跳转后视角条带定位条件（order_id）', /order_id/.test(barText), { barText })

  // 回到原表继续后面的判据
  await cdp.eval('window.__clickTree("grid_demo")')
  await waitFor(cdp, `window.__rowCount() === ${baseRows}`, 'back to grid_demo', 6000)

  // ---- 8) 关闭通道 ----
  await cdp.eval('window.__rightClick("note", "n2")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu for esc')
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  check('Esc 收起菜单', await menuGone(cdp))

  await cdp.eval('window.__rightClick("note", "n2")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu for outside click')
  await cdp.eval(`
    (() => {
      const el = document.querySelector('.db-grid-area .ant-table-thead')
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      return 'ok'
    })()
  `)
  check('菜单外按下收起', await menuGone(cdp))

  await cdp.eval('window.__rightClick("note", "n2")')
  await waitFor(cdp, '!!window.__menuEl()', 'menu for scroll')
  // 真滚动而不是合成 scroll 事件：virtual 表格的滚动容器是
  // .ant-table-tbody-virtual-holder（antd6 起没有 .ant-table-body 了），
  // 改 scrollTop 由浏览器自己派发 scroll，走的是用户滚轮同一条路径
  const scrolled = await cdp.eval(`
    (() => {
      const holder = [...document.querySelectorAll('.db-grid-area .ant-table-tbody-virtual-holder')]
        .filter(window.__vis)[0]
      if (!holder) return 'no-holder'
      holder.scrollTop = 40
      return 'scrolled:' + holder.scrollTop
    })()
  `)
  check('网格滚动收起菜单', scrolled !== 'no-holder' && await menuGone(cdp), { scrolled })

  // ---- 9) 底部"行"页签 ----
  await cdp.eval('window.__cellIn("note", "n2").click()')
  await waitFor(cdp, 'window.__paneOpen() >= 0', 'value pane', 4000)
  check('切到"行"页签', (await cdp.eval('window.__clickTab("行")')) === 'ok' &&
    await waitFor(cdp, '!![...document.querySelectorAll(".db-pane-tabs .db-row-detail")].filter(window.__vis)[0]', 'row detail'))
  const fields = await json(cdp, 'window.__rowDetailFields()')
  check('行页签字段数 = 屏幕列数（不带 __rowKey）',
    fields.open === 1 && fields.fields.length === heads.length &&
      !fields.fields.some(f => f.name === '__rowKey'), { fields: fields.fields.map(f => f.name), heads })
  check('行页签值对应当前行', (fields.fields.find(f => f.name === 'note') || {}).value === 'n2',
    fields.fields.find(f => f.name === 'note'))
  const rowTab = await cdp.eval(`
    (() => {
      const t = [...document.querySelectorAll('.db-pane-tabs .ant-tabs-tab')].filter(window.__vis)
        .map(x => x.innerText.replace(/\\s/g, ''))
      return JSON.stringify(t)
    })()
  `)
  check('底部页签至少 值/行 两个（有外键列时再挂关联）',
    JSON.parse(rowTab).slice(0, 2).join(',') === '值,行', { rowTab })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-row-tab-dark.png')))

  // 收尾：关掉本次打开的 tab，不给后续脚本留脏状态
  await cdp.eval(`(async () => { await window.store.delTab(${JSON.stringify(openRes.id)}) })()`)
  await sleep(400)

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  process.exit(fail.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
