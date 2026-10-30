#!/usr/bin/env node
/**
 * H3b ER 图 —— CDP 实机演示/回归（假库，不碰真库）
 *
 * 后端 listForeignKeys 与布局纯函数已由 src/test/unit-ci/db-er-graph.spec.js、
 * db-er-layout.spec.js 钉死，这里验的是"接到一起之后"的界面行为：
 *   1) 结构页工具条有"ER 图"入口；打开只发一次 listForeignKeys（不轮询）
 *   2) 节点/边数对；分层方向：子表在上、被引用表在下；自引用也画
 *   3) 悬停高亮相关边、其余变淡；移开复位
 *   4) 单击选中：详情条给列对；"打开表"与双击都能把表开进数据页
 *   5) 滚轮缩放以光标为不动点，钳在 20%~300%；拖空白平移；拖节点只改本地位置
 *   6) "重置布局"回到确定位置
 *   7) 空库 / 无外键 / 取数失败 / 超 200 张：四种状态各自有话说，失败仍保旧图
 *   8) 只读：弹层里没有输入框，全程无写命令
 *   9) 浅色主题下节点/画布颜色跟着 token 变
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 且跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（本仓库为 9227）
 *   3) node self-test/db-er-graph-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-er-graph-shots')

const STUB = `
(() => {
  const S = 'demo'
  const TABLES = ['users', 'orders', 'order_items', 'products', 'categories', 'payments',
    'addresses', 'carts', 'cart_items', 'coupons', 'order_coupons', 'shipments',
    'warehouses', 'inventory', 'suppliers', 'reviews', 'refunds', 'sessions',
    'audit_log', 'settings']
  const mk = (name, from, to, cols) => ({
    name,
    from: { schema: S, name: from },
    to: { schema: S, name: to },
    columns: cols.map(c => ({ from: c[0], to: c[1] }))
  })
  const EDGES = [
    mk('fk_orders_user', 'orders', 'users', [['user_id', 'id']]),
    mk('fk_items_order', 'order_items', 'orders', [['order_id', 'id']]),
    mk('fk_items_product', 'order_items', 'products', [['product_id', 'id']]),
    mk('fk_products_category', 'products', 'categories', [['category_id', 'id']]),
    mk('fk_products_supplier', 'products', 'suppliers', [['supplier_id', 'id']]),
    mk('fk_payments_order', 'payments', 'orders', [['order_id', 'id']]),
    mk('fk_addresses_user', 'addresses', 'users', [['user_id', 'id']]),
    mk('fk_carts_user', 'carts', 'users', [['user_id', 'id']]),
    mk('fk_cart_items_cart', 'cart_items', 'carts', [['cart_id', 'id']]),
    mk('fk_cart_items_product', 'cart_items', 'products', [['product_id', 'id']]),
    mk('fk_order_coupons_order', 'order_coupons', 'orders', [['order_id', 'id']]),
    mk('fk_order_coupons_coupon', 'order_coupons', 'coupons', [['coupon_id', 'id']]),
    mk('fk_shipments_order', 'shipments', 'orders', [['order_id', 'id']]),
    mk('fk_shipments_warehouse', 'shipments', 'warehouses', [['warehouse_id', 'id']]),
    mk('fk_inventory_product', 'inventory', 'products', [['product_id', 'id']]),
    mk('fk_inventory_warehouse', 'inventory', 'warehouses', [['warehouse_id', 'id']]),
    mk('fk_reviews_product', 'reviews', 'products', [['product_id', 'id']]),
    // 复合外键：详情里两列都要出现，且顺序与后端给的一致
    mk('fk_reviews_user', 'reviews', 'users', [['user_id', 'id'], ['tenant_id', 'tenant_id']]),
    mk('fk_refunds_payment', 'refunds', 'payments', [['payment_id', 'id']]),
    mk('fk_sessions_user', 'sessions', 'users', [['user_id', 'id']]),
    // 自引用：categories.parent_id → categories.id
    mk('fk_categories_parent', 'categories', 'categories', [['parent_id', 'id']])
  ]
  const withTables = (names, edges) => ({
    schema: S,
    tables: names.map(name => ({ schema: S, name })),
    edges
  })
  const big = (() => {
    const tables = []
    for (let i = 0; i < 260; i++) tables.push({ schema: S, name: 't' + String(i).padStart(3, '0') })
    const edges = []
    // 每张表都挂在一条边上：260 张全是"有外键关联的表"，
    // 才会走"关联表也超过 200，按名称截断"那条路
    for (let i = 0; i < 130; i++) {
      edges.push(mk('fk_big_' + i, 't' + String(i * 2).padStart(3, '0'), 't' + String(i * 2 + 1).padStart(3, '0'), [['ref_id', 'id']]))
    }
    return { schema: S, tables, edges }
  })()
  const GRAPHS = {
    normal: withTables(TABLES, EDGES),
    empty: { schema: S, tables: [], edges: [] },
    nofk: withTables(['users', 'orders', 'products', 'audit_log', 'settings'], []),
    big
  }
  window.__erMode = 'normal'
  window.__erThrows = null
  window.__erCalls = []
  window.__ops = []
  window.__pageTables = []
  window.__graph = () => GRAPHS[window.__erMode]
  const cols = [{ name: 'id', type: 'int', comment: '主键' }]
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__ops.push(op)
      if (op === 'listForeignKeys') {
        window.__erCalls.push(JSON.parse(JSON.stringify(args)))
        if (window.__erThrows) return Promise.reject(new Error(window.__erThrows))
        return Promise.resolve(JSON.parse(JSON.stringify(window.__graph())))
      }
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo',
          type: 'database',
          children: [{ name: 'users', type: 'table' }, { name: 'orders', type: 'table' }]
        }])
      }
      if (op === 'describeTable') {
        return Promise.resolve([{ Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: '' }])
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({ columns: cols, foreignKeys: [], indexes: [], type: 'table', comment: null, estimatedRows: 1 })
      }
      if (op === 'getPageData') {
        window.__pageTables.push(args.table)
        return Promise.resolve({ rows: [{ id: 1 }], totalRows: 1, hasMore: false })
      }
      if (op === 'listColumns') return Promise.resolve(cols.map(c => ({ name: c.name, type: c.type })))
      if (op === 'getReferences') return Promise.resolve([])
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  }

  // ── DOM 探针 ────────────────────────────────────────────────────
  // 渲染层有没有"不是本功能引起"的报错要看得见：只记前 4 帧，足够定位来源
  window.__errs = []
  window.addEventListener('error', e => {
    const s = String((e.error && e.error.stack) || e.message || '')
    window.__errs.push(s.split('\\n').slice(0, 4).join(' | '))
  })
  window.addEventListener('unhandledrejection', e => {
    window.__errs.push('REJ ' + String((e.reason && e.reason.stack) || e.reason || '').split('\\n').slice(0, 3).join(' | '))
  })
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null
  window.__erBtn = () => [...document.querySelectorAll('.db-struct-tools button')]
    .filter(window.__vis).find(b => /ER/i.test(b.innerText)) || null
  window.__clickEr = () => {
    const b = window.__erBtn()
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__erRoot = () => window.__one('.db-er')
  window.__erNodes = () => {
    const r = window.__erRoot()
    return r ? [...r.querySelectorAll('.db-er-node')] : []
  }
  window.__erNames = () => window.__erNodes().map(g => g.querySelector('.db-er-node-name').textContent)
  window.__erNode = name => window.__erNodes()
    .find(g => g.querySelector('.db-er-node-name').textContent === name) || null
  window.__erPos = name => {
    const g = window.__erNode(name)
    if (!g) return null
    const m = /translate\\((-?[\\d.]+) (-?[\\d.]+)\\)/.exec(g.getAttribute('transform'))
    return m ? { x: +m[1], y: +m[2] } : null
  }
  window.__erRect = name => {
    const g = window.__erNode(name)
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__erCanvasBox = () => {
    const r = window.__erRoot()
    if (!r) return null
    const c = r.querySelector('.db-er-canvas')
    const b = c.getBoundingClientRect()
    return { left: b.left, top: b.top, w: b.width, h: b.height, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  }
  window.__erEmptyPoint = () => {
    const c = window.__erCanvasBox()
    if (!c) return null
    const cands = [
      [c.left + 14, c.top + c.h - 14],
      [c.left + c.w - 14, c.top + c.h - 14],
      [c.left + 14, c.top + 40],
      [c.left + c.w - 14, c.top + 40]
    ]
    for (const p of cands) {
      const el = document.elementFromPoint(p[0], p[1])
      if (el && el.closest('.db-er-canvas') && !el.closest('.db-er-node')) {
        return { x: Math.round(p[0]), y: Math.round(p[1]) }
      }
    }
    return null
  }
  window.__erEdgeCount = () => {
    const r = window.__erRoot()
    return r ? r.querySelectorAll('.db-er-edge').length : -1
  }
  window.__erMark = () => {
    const r = window.__erRoot()
    if (!r) return null
    const n = s => r.querySelectorAll(s).length
    return {
      edges: n('.db-er-edge'),
      hot: n('.db-er-edge.is-hot'),
      dimEdges: n('.db-er-edge.is-dim'),
      dimNodes: n('.db-er-node.is-dim'),
      selected: (r.querySelector('.db-er-node.is-selected .db-er-node-name') || {}).textContent || null
    }
  }
  window.__erDetail = () => {
    const r = window.__erRoot()
    const d = r && r.querySelector('.db-er-detail')
    return d ? d.innerText : null
  }
  window.__erDetailBtn = () => {
    const r = window.__erRoot()
    const b = r && r.querySelector('.db-er-detail button')
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__erZoom = () => {
    const r = window.__erRoot()
    const z = r && r.querySelector('.db-er-zoom')
    return z ? Number(z.innerText.replace('%', '')) : null
  }
  window.__erTf = () => {
    const r = window.__erRoot()
    const g = r && r.querySelector('.db-er-svg > g')
    if (!g) return null
    const m = /translate\\((-?[\\d.]+) (-?[\\d.]+)\\) scale\\(([\\d.]+)\\)/.exec(g.getAttribute('transform'))
    return m ? { tx: +m[1], ty: +m[2], k: +m[3] } : null
  }
  window.__erNotes = () => {
    const r = window.__erRoot()
    return r ? [...r.querySelectorAll('.db-er-note')].map(x => x.innerText.trim()) : []
  }
  window.__erErr = () => {
    const r = window.__erRoot()
    const a = r && r.querySelector('.db-er-err')
    return a ? a.innerText : null
  }
  window.__erEmpty = () => {
    const r = window.__erRoot()
    const e = r && r.querySelector('.db-er-empty')
    return e ? e.innerText.trim() : null
  }
  window.__erInputs = () => {
    const r = window.__erRoot()
    return r ? r.querySelectorAll('input,textarea').length : -1
  }
  window.__erFooter = re => {
    const r = window.__erRoot()
    if (!r) return 'no-root'
    const box = r.closest('.ant-modal-container')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x => re.test(x.innerText))
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__erReset = () => window.__erFooter(/重置|reset/i)
  window.__erRefresh = () => window.__erFooter(/刷新|refresh/i)
  window.__erClose = () => window.__erFooter(/关闭|close/i)
  window.__erOpen = () => !!window.__erRoot()
  window.__erModalBox = () => {
    const r = window.__erRoot()
    if (!r) return null
    const b = r.closest('.ant-modal-container').getBoundingClientRect()
    return { w: Math.round(b.width), h: Math.round(b.height) }
  }
  window.__erNodeFill = () => {
    const g = window.__erNode('orders')
    if (!g) return null
    return getComputedStyle(g.querySelector('rect')).fill
  }
  return 'stubbed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'mysql root@127.0.0.1:3306/demo',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'root',
    dbPassword: '',
    dbName: 'demo',
    dbSsl: false,
    readOnly: true,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)

  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }

  await cdp.eval(STUB)
  await clearDbTabs(cdp)

  // ── 0. 打开一张表并切到结构页 ──────────────────────────────────
  const tab = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tab.id), 'mysql tab active')
  await waitFor(cdp, "document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper').length > 0", 'tree ready', 30000)
  await cdp.eval(`(() => {
    const d = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).find(x => x.innerText.trim() === 'demo')
    if (d) d.click()
  })()`)
  await sleep(600)
  await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).find(x => x.innerText.trim() === 'orders')
    if (t) t.click()
  })()`)
  await sleep(1600)
  const structTab = await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).find(x => /表结构|Structure/.test(x.innerText))
    if (!t) return 'missing'
    t.click()
    return 'ok'
  })()`)
  check('切到表结构页签', structTab === 'ok', structTab)
  await sleep(600)
  const btnText = await cdp.eval('(window.__erBtn() || {}).innerText || null')
  check('结构页工具条有「ER 图」入口且文案已翻译（不是词条 key）',
    /ER/i.test(String(btnText)) && !/DbErGraph/.test(String(btnText)), btnText)

  // ── 1. 打开：只拉一次，节点/边数对 ─────────────────────────────
  await cdp.eval('window.__clickEr()')
  const openOk = await waitFor(cdp, 'window.__erNames().length >= 20', 'er graph rendered', 20000)
  check('点开 ER 图渲染出 20 个节点', openOk && (await cdp.eval('window.__erNodes().length')) === 20,
    await cdp.eval('window.__erNodes().length'))
  const calls = await cdp.jeval('JSON.stringify(window.__erCalls)')
  check('打开时正好发一次 listForeignKeys，参数是当前库/schema',
    calls.length === 1 && calls[0].database === 'demo' && calls[0].schema === '', calls)
  check('21 条外键边全部画出', (await cdp.eval('window.__erEdgeCount()')) === 21,
    await cdp.eval('window.__erEdgeCount()'))
  const box = await cdp.jeval('JSON.stringify(window.__erModalBox())')
  check('弹层约 90% 宽 × 85% 高（1600×950 下 ≈ 1440×808）',
    box.w > 1380 && box.w < 1470 && box.h > 760 && box.h < 850, box)
  await shot('er-dark')

  // ── 2. 分层方向：子表在上，被引用表在下 ─────────────────────────
  const pos = async name => JSON.parse(await cdp.eval('JSON.stringify(window.__erPos(' + JSON.stringify(name) + '))'))
  const pItems = await pos('order_items')
  const pOrders = await pos('orders')
  const pUsers = await pos('users')
  const pProducts = await pos('products')
  const pCategories = await pos('categories')
  check('分层：order_items 在 orders 之上、orders 在 users 之上',
    pItems.y < pOrders.y && pOrders.y < pUsers.y, { pItems, pOrders, pUsers })
  check('分层：products 在 categories 之上（自引用表在下层）',
    pProducts.y < pCategories.y, { pProducts, pCategories })
  check('孤立表也在图里（audit_log / settings 没外键也照画）',
    (await cdp.eval("window.__erNames().indexOf('audit_log') > -1 && window.__erNames().indexOf('settings') > -1")) === true)

  // ── 3. 悬停：相关边高亮，其余变淡 ──────────────────────────────
  const ordersRect = await cdp.jeval("JSON.stringify(window.__erRect('orders'))")
  await cdp.move(ordersRect.x, ordersRect.y)
  const hoverOk = await waitFor(cdp, 'window.__erMark().hot === 5', 'hover highlights related edges', 5000)
  const markHover = await cdp.jeval('JSON.stringify(window.__erMark())')
  check('悬停 orders：5 条相关边高亮（1 出 4 入）', hoverOk && markHover.hot === 5, markHover)
  check('悬停时其余边与无关节点变淡', markHover.dimEdges === 16 && markHover.dimNodes > 0, markHover)
  await shot('er-hover')
  await cdp.move(10, 10)
  const hoverOff = await waitFor(cdp, 'window.__erMark().hot === 0', 'hover cleared', 5000)
  check('移开后高亮复位', hoverOff, await cdp.jeval('JSON.stringify(window.__erMark())'))

  // ── 4. 单击选中：详情条列对 + 打开表 ───────────────────────────
  await cdp.click(ordersRect.x, ordersRect.y)
  const selOk = await waitFor(cdp, 'window.__erMark().selected === "orders"', 'node selected', 5000)
  const detail = String(await cdp.eval('window.__erDetail()') || '')
  check('单击选中 orders，仍高亮它的边', selOk && (await cdp.eval('window.__erMark().hot')) === 5,
    await cdp.jeval('JSON.stringify(window.__erMark())'))
  check('详情条列出外键列对（payments.order_id → orders(id) 等）',
    detail.indexOf('order_id') > -1 && detail.indexOf('orders(id)') > -1, detail.slice(0, 260))
  check('详情条带「打开表」按钮', /打开表|open table/i.test(detail), detail.slice(0, 160))
  await shot('er-selected')
  await cdp.eval('window.__erDetailBtn()')
  const openedOk = await waitFor(cdp, '!window.__erOpen()', 'modal closed after open table', 8000)
  const pageTables = await cdp.jeval('JSON.stringify(window.__pageTables)')
  check('「打开表」把 orders 开进数据页并关掉弹层',
    openedOk && pageTables[pageTables.length - 1] === 'orders', pageTables.slice(-3))
  await sleep(800)

  // ── 5. 重新打开：不轮询；双击打开表 ────────────────────────────
  const beforeReopen = (await cdp.jeval('JSON.stringify(window.__erCalls)')).length
  await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).find(x => /表结构|Structure/.test(x.innerText))
    if (t) t.click()
  })()`)
  await sleep(500)
  await cdp.eval('window.__clickEr()')
  await waitFor(cdp, 'window.__erNames().length === 20', 'reopened', 15000)
  const calls2 = (await cdp.jeval('JSON.stringify(window.__erCalls)')).length
  check('重新打开只多发一次 listForeignKeys', calls2 === beforeReopen + 1, { beforeReopen, calls2 })
  await sleep(1500)
  const calls3 = (await cdp.jeval('JSON.stringify(window.__erCalls)')).length
  check('打开期间不轮询（静置 1.5s 后调用数不变）', calls3 === calls2, { calls2, calls3 })
  const usersRect = await cdp.jeval("JSON.stringify(window.__erRect('users'))")
  await cdp.click(usersRect.x, usersRect.y, 2)
  const dblOk = await waitFor(cdp, '!window.__erOpen()', 'modal closed after double click', 8000)
  const pageTables2 = await cdp.jeval('JSON.stringify(window.__pageTables)')
  check('双击节点把 users 开进数据页',
    dblOk && pageTables2[pageTables2.length - 1] === 'users', pageTables2.slice(-3))
  await sleep(800)
  await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).find(x => /表结构|Structure/.test(x.innerText))
    if (t) t.click()
  })()`)
  await sleep(500)
  await cdp.eval('window.__clickEr()')
  await waitFor(cdp, 'window.__erNames().length === 20', 'reopened for interaction tests', 15000)

  // ── 6. 缩放：光标不动点 + 上下限 ───────────────────────────────
  const cbox = await cdp.jeval('JSON.stringify(window.__erCanvasBox())')
  const k0 = (await cdp.jeval('JSON.stringify(window.__erTf())')).k
  await cdp.wheel(cbox.x, cbox.y, -600)
  await sleep(300)
  const tfZoom = await cdp.jeval('JSON.stringify(window.__erTf())')
  check('滚轮向上放大（k 变大、百分比同步）',
    tfZoom.k > k0 && (await cdp.eval('window.__erZoom()')) === Math.round(tfZoom.k * 100),
    { k0, tfZoom, badge: await cdp.eval('window.__erZoom()') })
  await cdp.wheel(cbox.x, cbox.y, 40000)
  await sleep(400)
  const kMin = (await cdp.jeval('JSON.stringify(window.__erTf())')).k
  check('缩小钳在 20%', Math.abs(kMin - 0.2) < 1e-6, kMin)
  await cdp.wheel(cbox.x, cbox.y, -80000)
  await sleep(400)
  const kMax = (await cdp.jeval('JSON.stringify(window.__erTf())')).k
  check('放大钳在 300%', Math.abs(kMax - 3) < 1e-6, kMax)

  // ── 7. 重置布局：回到确定位置 ─────────────────────────────────
  await cdp.eval('window.__erReset()')
  const resetOk = await waitFor(cdp, 'window.__erTf().k <= 1', 'fit after reset', 5000)
  const pAfterReset = await pos('orders')
  check('重置布局：缩放回到铺满（≤100%）且节点位置回到布局函数结果',
    resetOk && Math.abs(pAfterReset.x - pOrders.x) < 0.5 && Math.abs(pAfterReset.y - pOrders.y) < 0.5,
    { after: pAfterReset, before: pOrders })

  // ── 8. 拖空白平移；拖节点只改本地位置 ───────────────────────────
  // 重新打开会清掉选中（新图对象进 useEffect），先重新选一次，
  // 才能验"平移之后的 click 不吃掉选中"
  {
    const r = await cdp.jeval("JSON.stringify(window.__erRect('orders'))")
    await cdp.click(r.x, r.y)
    await waitFor(cdp, 'window.__erMark().selected === "orders"', 'reselect before pan', 5000)
    await cdp.move(10, 10)
  }
  const emptyPt = await cdp.jeval('JSON.stringify(window.__erEmptyPoint())')
  const tfBeforePan = await cdp.jeval('JSON.stringify(window.__erTf())')
  if (emptyPt) {
    await cdp.dragX(emptyPt.x, emptyPt.y, 120)
    await sleep(300)
    const tfAfterPan = await cdp.jeval('JSON.stringify(window.__erTf())')
    check('拖空白处平移画布（tx 跟随、ty 不变）',
      Math.abs(tfAfterPan.tx - tfBeforePan.tx - 120 / 1) < 6 && Math.abs(tfAfterPan.ty - tfBeforePan.ty) < 2,
      { tfBeforePan, tfAfterPan })
    const stillSelected = await cdp.eval('window.__erMark().selected')
    check('平移不会清掉选中（拖动后的 click 不算点空白）', stillSelected === 'orders', stillSelected)
  } else {
    check('画布有空白点可拖（夹具前提）', false, 'no empty point')
  }
  await cdp.eval('window.__erReset()')
  await sleep(400)
  const ordersRect2 = await cdp.jeval("JSON.stringify(window.__erRect('orders'))")
  const pBeforeDrag = await pos('orders')
  await cdp.dragY(ordersRect2.x, ordersRect2.y, 80)
  await sleep(300)
  const pAfterDrag = await pos('orders')
  check('拖节点：只改这张表的位置（约 80 屏幕像素，按缩放折算）',
    pAfterDrag.y - pBeforeDrag.y > 60 && pAfterDrag.y - pBeforeDrag.y < 100 &&
    Math.abs(pAfterDrag.x - pBeforeDrag.x) < 1, { pBeforeDrag, pAfterDrag })
  await cdp.eval('window.__erReset()')
  await sleep(400)
  const pReset2 = await pos('orders')
  check('重置布局把拖动过的节点放回原位',
    Math.abs(pReset2.x - pBeforeDrag.x) < 0.5 && Math.abs(pReset2.y - pBeforeDrag.y) < 0.5,
    { pBeforeDrag, pReset2 })

  // ── 9. 无外键 / 空库 ───────────────────────────────────────────
  await cdp.eval("window.__erMode = 'nofk'")
  await cdp.eval('window.__erRefresh()')
  const nofkOk = await waitFor(cdp, 'window.__erNodes().length === 5 && window.__erEdgeCount() === 0', 'nofk graph', 8000)
  const nofkNotes = await cdp.jeval('JSON.stringify(window.__erNotes())')
  check('没有外键时照画表节点 + 明确提示（不是空白）',
    nofkOk && nofkNotes.some(t => /外键|foreign key/i.test(t)), { nofkNotes })
  await cdp.eval("window.__erMode = 'empty'")
  await cdp.eval('window.__erRefresh()')
  const emptyOk = await waitFor(cdp, '!!window.__erEmpty()', 'empty state', 8000)
  check('空库出空态文案', emptyOk, await cdp.eval('window.__erEmpty()'))

  // ── 10. 取数失败：报错条 + 旧图保留 ────────────────────────────
  await cdp.eval("window.__erMode = 'normal'")
  await cdp.eval('window.__erRefresh()')
  await waitFor(cdp, 'window.__erNodes().length === 20', 'normal graph back', 8000)
  await cdp.eval("window.__erThrows = 'boom: no access to information_schema'")
  await cdp.eval('window.__erRefresh()')
  const errOk = await waitFor(cdp, '!!window.__erErr()', 'error banner', 8000)
  const errText = String(await cdp.eval('window.__erErr()') || '')
  check('刷新失败：弹层里出报错条（含原始原因）',
    errOk && /boom/.test(errText), errText.slice(0, 200))
  check('刷新失败不把上一张图清空', (await cdp.eval('window.__erNodes().length')) === 20,
    await cdp.eval('window.__erNodes().length'))
  await shot('er-error')
  await cdp.eval('window.__erThrows = null')

  // ── 11. 超 200 张：只留有外键的表并说明截断 ─────────────────────
  await cdp.eval("window.__erMode = 'big'")
  await cdp.eval('window.__erRefresh()')
  const bigOk = await waitFor(cdp, 'window.__erNodes().length === 200', 'truncated to 200', 15000)
  check('260 张表全部有外键时也只画 200 个节点', bigOk, await cdp.eval('window.__erNodes().length'))
  const bigNotes = await cdp.jeval('JSON.stringify(window.__erNotes())')
  check('截断提示写明 260 张里只显示 200 张',
    bigNotes.some(t => /260/.test(t) && /200/.test(t)), bigNotes)
  await shot('er-truncated')

  // ── 12. 只读：无输入框、无写命令 ───────────────────────────────
  check('弹层里没有输入框', (await cdp.eval('window.__erInputs()')) === 0,
    await cdp.eval('window.__erInputs()'))
  const ops = await cdp.jeval('JSON.stringify(window.__ops)')
  const writes = ops.filter(op => /^(set|del|unlink|hset|insert|update|alter|drop|create|truncate|exec|queryWrite)/i.test(op))
  check('全程零写命令（只有 listForeignKeys 与只读元数据 op）',
    writes.length === 0 && ops.indexOf('listForeignKeys') > -1, { writes, ops: Array.from(new Set(ops)) })

  // ── 13. 浅色主题 ───────────────────────────────────────────────
  await cdp.eval("window.__erMode = 'normal'")
  await cdp.eval('window.__erRefresh()')
  await waitFor(cdp, 'window.__erNodes().length === 20', 'normal graph for theme', 8000)
  const darkFill = await cdp.eval('window.__erNodeFill()')
  const darkCanvas = await cdp.eval("getComputedStyle(window.__erRoot().querySelector('.db-er-canvas')).backgroundColor")
  const cfg0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const lightFill = await cdp.eval('window.__erNodeFill()')
    const lightCanvas = await cdp.eval("getComputedStyle(window.__erRoot().querySelector('.db-er-canvas')).backgroundColor")
    check('换浅色主题后节点与画布底色都跟着 token 变（不是写死的深色）',
      !!darkFill && !!lightFill && lightFill !== darkFill && lightCanvas !== darkCanvas,
      { darkFill, lightFill, darkCanvas, lightCanvas })
    await shot('er-light')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
    await sleep(800)
  }

  await cdp.eval('window.__erClose()')
  await sleep(300)
  const cleared = await clearDbTabs(cdp)
  check('自测收尾关闭数据库 tab', cleared.left.length === 0, cleared)
  const errs = await cdp.jeval('JSON.stringify(window.__errs || [])')
  if (errs.length) console.log('renderer errors:\n  ' + errs.join('\n  '))
  const tail = cdp.tail(5)
  if (tail.length) console.log('renderer log tail:\n  ' + tail.join('\n  '))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
