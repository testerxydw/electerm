#!/usr/bin/env node
/**
 * 表头统一（点 1 排序一套 / 点 3 拖宽线用表头边沿线）—— CDP 实机回归（无需真 MySQL）
 *
 * 为什么单独一个脚本：这两点改的都是"列头这一小块 DOM 的几何与状态来源"，
 * 判据必须来自真实渲染（antd 注入的 CSS-in-JS 规则、th 的 overflow 裁剪、
 * :hover 点亮 ::before），纯单测只能钉住列定义，钉不住像素。
 *
 * 覆盖：
 *   1) 数据页不再借 antd 的 col.sorter：thead 里没有 .ant-table-column-sorters /
 *      .ant-table-column-title / th.ant-table-column-has-sorters，也就没有
 *      语言包外那句英文 tooltip
 *   2) 排序一套：箭头在 ColHead 里（⇅ → ▲ → ▼ → ⇅），每次点击写进 view.order
 *      并发出对应 orderClauses，3 列上限保留最后三列
 *   3) 拖宽热区右沿与 th 的分隔线重合，且外扩的 8px 仍可命中（没被 th 的
 *      overflow 裁掉）；hover 时点亮的是**表头自己那道线**（变主色、整格高），
 *      手柄不再自己画一条
 *   4) 真实拖拽仍然改宽，且拖拽不会被误判成"点击排序"
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/electerm-h1a-tmp/home TMPDIR=/tmp/electerm-h1a-tmp DISPLAY=:130 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-head-unify-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-head-unify-shots')

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
  const ROWS = []
  for (let i = 1; i <= 12; i++) {
    ROWS.push({ id: i, flag: i % 2 ? 'ok' : 'no', note: 'n' + i, detail: 'd' + i })
  }
  const COLS = [
    { name: 'id', dataType: 'int', isPk: true, comment: '主键' },
    { name: 'flag', dataType: 'varchar', comment: '' },
    { name: 'note', dataType: 'varchar', comment: '备注' },
    { name: 'detail', dataType: 'text', comment: '' }
  ]
  // 每次 getPageData 把服务端 ORDER BY 载荷记下来：排序是不是真的发出去了，
  // 只有在这里能证明（DOM 上的箭头只是同一状态的显示）
  window.__orders = []
  window.__copied = null
  window.pre.writeClipboard = s => { window.__copied = String(s) }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'demo_db', children: [{ name: 'grid_demo', type: 'table' }] }])
      }
      if (op === 'describeTable') {
        return Promise.resolve(COLS.map(c => ({ Field: c.name, Type: c.dataType, Key: c.isPk ? 'PRI' : '', Null: 'YES' })))
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({ columns: COLS, foreignKeys: [] })
      }
      if (op === 'getPageData') {
        window.__orders.push((args.orderClauses || []).map(c => c.column + (c.desc ? ':desc' : ':asc')))
        return Promise.resolve({ rows: ROWS, totalRows: ROWS.length, page: 1, hasMore: false })
      }
      if (op === 'getReferences') return Promise.resolve({ references: [], degraded: false })
      if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], lastErr: null, lastTx: null })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab' || name === 'closeDbTab') return Promise.resolve({ ok: true })
    // 窗口尺寸：主窗口在 headless 屏上拿不到 screen，onResize 会解构 null 直接崩，
    // 崩在 db 面板挂载之前 → 整个 .db-tree 都不出现（判据会误报成"表头没渲染"）
    if (name === 'getScreenSize') return Promise.resolve({ width: 1600, height: 1000 })
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
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(window.__vis)
    // 先精确后包含：切换标签页的瞬间新旧两份树同时存在，精确名不会误点别的库/表
    let hit = all.filter(n => n.innerText.trim() === text)
    if (!hit.length) {
      hit = all.filter(n => n.innerText.trim().indexOf(text) >= 0)
    }
    if (!hit.length) return 'no-node:' + text
    hit[0].click()
    return 'ok'
  }
  window.__rowCount = () => [...document.querySelectorAll('.ant-table-row')]
    .filter(window.__vis).length
  // 只看数据页那张表（本脚本不开 SQL 结果，但判据写死更稳）
  window.__ths = () => [...document.querySelectorAll('.db-grid-table .ant-table-thead > tr > th')]
    .filter(window.__vis)
    .filter(th => th.querySelector('.db-col-name'))
  window.__th = name => window.__ths().find(th => th.querySelector('.db-col-name').innerText.trim() === name) || null
  window.__glyph = name => {
    const th = window.__th(name)
    const g = th && th.querySelector('.db-col-sort')
    return g ? g.innerText.trim() : 'none'
  }
  window.__clickHead = name => {
    const th = window.__th(name)
    if (!th) return 'no-th'
    const head = th.querySelector('.db-col-head')
    if (!head) return 'no-head'
    head.click()
    return 'ok'
  }
  window.__sorterDom = () => JSON.stringify({
    sorters: document.querySelectorAll('.db-grid-table .ant-table-column-sorters').length,
    titles: document.querySelectorAll('.db-grid-table .ant-table-column-title').length,
    hasSorters: document.querySelectorAll('.db-grid-table th.ant-table-column-has-sorters').length,
    ascTip: String(document.querySelector('.db-grid-table .ant-table-thead').outerHTML).includes('Click to sort')
  })
  window.__headTitle = name => {
    const th = window.__th(name)
    const head = th && th.querySelector('.db-col-head')
    return head ? String(head.getAttribute('title') || '') : ''
  }
  // 容器收敛判据：表头标题容器只剩 .db-col-head 一份（数据页原来那条同构的
  // .db-col-title 已并进它）。合并后唯一差别是"有没有注释那一行"，所以：
  //   有注释 → 两行，行间距正好是容器自己的 gap（1px）
  //   无注释 → 容器高度回落到列名高度（gap 只作用在流内相邻项，多不出高度）
  // 无注释这一支在桩数据里天生碰不到（4 列都带注释），就地把注释节点摘掉量完
  // 再原样塞回去：一次同步 evaluate，React 察觉不到，也不影响后面的判据。
  window.__headShape = (name) => {
    const th = window.__th(name)
    if (!th) return JSON.stringify({ err: 'no-th' })
    const all = window.__ths()
    const head = th.querySelector('.db-col-head')
    const nameEl = th.querySelector('.db-col-name')
    const comment = th.querySelector('.db-col-comment')
    const out = {
      cls: head ? String(head.className) : '',
      legacy: document.querySelectorAll('.db-grid-table .db-col-title').length,
      heads: all.filter(x => x.querySelector('.db-col-head')).length,
      ths: all.length,
      headH: head ? Math.round(head.getBoundingClientRect().height) : null,
      nameH: nameEl ? Math.round(nameEl.getBoundingClientRect().height) : null,
      gap: comment && nameEl ? Math.round(comment.getBoundingClientRect().top - nameEl.getBoundingClientRect().bottom) : null,
      hasComment: !!comment,
      bareHeadH: null,
      bareNameH: null
    }
    if (comment && head && nameEl) {
      comment.remove()
      out.bareHeadH = Math.round(head.getBoundingClientRect().height)
      out.bareNameH = Math.round(nameEl.getBoundingClientRect().height)
      head.insertBefore(comment, th.querySelector('.db-col-sort') || null)
    }
    return JSON.stringify(out)
  }
  window.__lastOrder = () => window.__orders[window.__orders.length - 1] || []
  window.__orderCount = () => window.__orders.length
  // 量线：th 自己的 ::before（antd 画的那道分隔线）+ 手柄 ::after（应当不存在）
  window.__line = (name) => {
    const th = window.__th(name)
    if (!th) return JSON.stringify({ err: 'no-th' })
    const cs = getComputedStyle(th, '::before')
    const rz = th.querySelector('.db-col-resizer')
    const rcs = rz ? getComputedStyle(rz, '::after') : null
    const thr = th.getBoundingClientRect()
    const rr = rz ? rz.getBoundingClientRect() : null
    return JSON.stringify({
      before: {
        content: cs.content, width: parseFloat(cs.width) || 0, height: parseFloat(cs.height) || 0,
        bg: cs.backgroundColor, top: cs.top, transform: cs.transform
      },
      // 热区右沿相对 th 右沿：0 表示正好压在边界上
      resizerRightDelta: rr ? Math.round(rr.right - thr.right) : null,
      resizerAfter: rcs ? rcs.content : null,
      resizerCursor: rz ? getComputedStyle(rz).cursor : '',
      th: { w: Math.round(thr.width), h: Math.round(thr.height), right: thr.right, cy: thr.top + thr.height / 2 }
    })
  }
  window.__hitAt = (name, dx) => {
    const th = window.__th(name)
    if (!th) return 'no-th'
    const r = th.getBoundingClientRect()
    const el = document.elementFromPoint(r.right + dx, r.top + r.height / 2)
    return el ? String(el.className) : 'null'
  }
  window.__tokenRgb = (name) => {
    const d = document.createElement('div')
    d.style.color = 'var(' + name + ')'
    document.body.appendChild(d)
    const rgb = getComputedStyle(d).color
    d.remove()
    return rgb
  }
  // 指针事件流水（捕获相，所以即使列内 stopPropagation 也记得到）：
  // 拖拽到底有没有变成"点了一下列头"，看这份日志比看状态猜靠谱
  window.__ptr = []
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, ev => {
      const th = ev.target && ev.target.closest
        ? ev.target.closest('.ant-table-thead > tr > th')
        : null
      if (!th) {
        return
      }
      const nm = th.querySelector('.db-col-name')
      window.__ptr.push({
        type,
        col: nm ? nm.innerText.trim() : '?',
        target: String(ev.target.className).slice(0, 32),
        x: Math.round(ev.clientX)
      })
    }, true)
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
    title: 'mysql head demo',
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
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async mouse (type, x, y) {
    await this.call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
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

const json = async (cdp, expr) => JSON.parse(await cdp.eval(expr))

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(400)
  // 上一轮留下的数据库标签页会在**桩还没装上去**时就恢复挂载：那条路径拿不到
  // screen/连接信息直接崩，之后这一轮就只剩"表头没渲染"的假案。先把它们清掉并
  // 重启一次（delTab 会写回持久化，所以重启后不会再恢复），再从干净首屏开始
  await cdp.eval(`(() => {
    const t = setInterval(() => {
      if (window.store) {
        clearInterval(t)
        ;(window.store.tabs || []).filter(x => x.type === 'database')
          .forEach(x => window.store.delTab && window.store.delTab(x.id))
      }
    }, 20)
    setTimeout(() => clearInterval(t), 8000)
  })()`)
  await sleep(1200)
  await cdp.call('Page.reload', {})
  await waitFor(cdp, '!!window.store', 'store ready (clean)')
  await sleep(800)

  const stub = await cdp.eval(STUB)
  check('桩 MySQL 已注入', stub === 'stub-installed', { stub })
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  if (!openRes.id) {
    throw new Error('database tab was not created')
  }
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
  await cdp.eval('window.__clickTree("demo_db")')
  const expanded = await waitFor(cdp, 'window.__clickTree("grid_demo") === "ok"', 'open table')
  // 打开表的瞬间新旧面板同时在 DOM 里（旧面板还在退场，树也短暂有两份）：
  // 本脚本的判据全在列头上，先等列头就位并落定，再谈行
  const headsReady = expanded && await waitFor(cdp, 'window.__ths().length === 4', '4 headers')
  await sleep(1200)
  const rows = await cdp.eval('window.__rowCount()')
  check('网格出数（4 列表头 + 首屏行）', headsReady && rows >= 4, { heads: await cdp.eval('window.__ths().length'), rows })

  // ---- 1) 不再有 antd 的 sorter DOM ----
  const dom = await json(cdp, 'window.__sorterDom()')
  check('thead 无 .ant-table-column-sorters', dom.sorters === 0, dom)
  check('thead 无 .ant-table-column-title（包装层消失，列头整格都是热区宿主）', dom.titles === 0, dom)
  check('无 th.ant-table-column-has-sorters（表头不再整格 pointer）', dom.hasSorters === 0, dom)
  check('语言包外的英文 tooltip 消失', dom.ascTip === false, dom)
  const tip = await cdp.eval('window.__headTitle("id")')
  const zh = await cdp.eval('window.translate("dbColSortHint")')
  check('列头 title 含排序提示词条', tip.includes(zh) && !!zh, { tip, zh })

  // ---- 1b) 表头标题容器只有一份：.db-col-head；无注释列不该被撑高 ----
  const shape = await json(cdp, 'window.__headShape("id")')
  check('表头容器收敛为单一份 .db-col-head（.db-col-title 全部消失）',
    shape.legacy === 0 && shape.cls.startsWith('db-col-head') && shape.heads === shape.ths && shape.ths > 0, shape)
  check('有注释列：两行之间正是容器自己的 1px gap（合并后 gap 只有一处定义）',
    shape.hasComment && shape.gap === 1 && shape.headH > shape.nameH, shape)
  check('注释摘掉后容器高度回落到列名高度（单行表头不会被多撑一行）',
    shape.bareHeadH === shape.bareNameH && shape.bareHeadH === shape.nameH, shape)

  // ---- 2) 一套排序：箭头 + view.order + 发给服务端的 orderClauses ----
  const first = await cdp.eval('window.__orderCount()')
  check('未排序时箭头是淡提示 ⇅', await cdp.eval('window.__glyph("id")') === '⇅',
    { glyph: await cdp.eval('window.__glyph("id")') })
  await cdp.eval('window.__clickHead("id")')
  await waitFor(cdp, 'window.__orderCount() > ' + first, 'sort query sent #1')
  check('点一次：▲ + 发出 id:asc',
    await cdp.eval('window.__glyph("id")') === '▲' &&
    await cdp.eval('JSON.stringify(window.__lastOrder())') === '["id:asc"]',
    { order: await cdp.eval('window.__lastOrder()') })
  await cdp.eval('window.__clickHead("id")')
  await waitFor(cdp, 'window.__orderCount() > ' + (first + 1), 'sort query sent #2')
  check('点两次：▼ + 发出 id:desc',
    await cdp.eval('window.__glyph("id")') === '▼' &&
    await cdp.eval('JSON.stringify(window.__lastOrder())') === '["id:desc"]',
    { order: await cdp.eval('window.__lastOrder()') })
  await cdp.eval('window.__clickHead("id")')
  await waitFor(cdp, 'window.__orderCount() > ' + (first + 2), 'sort query sent #3')
  check('点三次：回到 ⇅ 且条件清空（第三下是取消，不是留在 desc）',
    await cdp.eval('window.__glyph("id")') === '⇅' &&
    await cdp.eval('JSON.stringify(window.__lastOrder())') === '[]',
    { order: await cdp.eval('window.__lastOrder()') })
  // 多列：4 次点击 → 只保留最后 3 列（上限由 nextSortOrder 决定，两页同源）
  for (const c of ['id', 'flag', 'note', 'detail']) {
    await cdp.eval('window.__clickHead("' + c + '")')
    await sleep(320)
  }
  const multi = await cdp.eval('JSON.stringify(window.__lastOrder())')
  check('多列排序 3 列上限（保留最后三列，箭头与载荷同一状态）',
    multi === '["flag:asc","note:asc","detail:asc"]', { multi })
  check('三列各显示自己的箭头', await cdp.eval(
    '["flag","note","detail"].every(c => window.__glyph(c) === "▲") && window.__glyph("id") === "⇅"'
  ))
  // asc → desc → 取消：每一列还要两下才回到无排序
  for (const c of ['flag', 'note', 'detail']) {
    await cdp.eval('window.__clickHead("' + c + '")')
    await sleep(320)
    await cdp.eval('window.__clickHead("' + c + '")')
    await sleep(320)
  }
  check('逐列取消后回到无排序（箭头与载荷同时清空）',
    await cdp.eval('JSON.stringify(window.__lastOrder())') === '[]' &&
    await cdp.eval('["id","flag","note","detail"].every(c => window.__glyph(c) === "⇅")'),
    { order: await cdp.eval('JSON.stringify(window.__lastOrder())') })

  // ---- 3) 拖宽线 = 表头边沿线 ----
  const primary = await cdp.eval('window.__tokenRgb("--primary")')
  const base = await json(cdp, 'window.__line("id")')
  check('手柄不再自己画一条线（::after 无内容）',
    base.resizerAfter === 'none' || base.resizerAfter === null, base.resizerAfter)
  check('热区右沿压在 th 边界上（与分隔线重合，容差 1px）',
    Math.abs(base.resizerRightDelta) <= 1, { delta: base.resizerRightDelta })
  check('外扩的 8px 仍可命中（th 的 overflow 没裁掉它）',
    (await cdp.eval('window.__hitAt("id", -2)')).includes('db-col-resizer'),
    { hit: await cdp.eval('window.__hitAt("id", -2)') })
  check('默认态分隔线还是 antd 那道细线（不是常驻主色）',
    base.before.content !== 'none' && base.before.bg !== primary && base.before.width <= 1.5,
    { before: base.before })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-head-idle.png')))

  // 真指针 hover：CSS :hover 只认设备状态，JS 伪造不了
  await cdp.mouse('mouseMoved', base.th.right - 2, base.th.cy)
  // antd 给 ::before 上了 background-color 过渡（motionDurationMid），读太早拿到的是
  // 过渡起点：颜色还停在分隔线灰，判据会误报成"规则没生效"
  await sleep(600)
  const hot = await json(cdp, 'window.__line("id")')
  check('hover 热区点亮的是表头自己那道线（变主色）',
    hot.before.bg === primary, { bg: hot.before.bg, primary })
  check('点亮的线整格高（不是 1.6em 居中短线）',
    Math.abs(hot.before.height - hot.th.h) <= 2, { line: hot.before.height, th: hot.th.h })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-head-hover-line.png')))

  // 末列：antd 不给它画分隔线，热区 hover 也要有反馈
  const last = await json(cdp, 'window.__line("detail")')
  await cdp.mouse('mouseMoved', last.th.right - 2, last.th.cy)
  await sleep(200)
  const lastHot = await json(cdp, 'window.__line("detail")')
  check('末列热区 hover 同样出主线（antd 无 ::before 时我们自己补）',
    lastHot.before.bg === primary && Math.abs(lastHot.before.height - lastHot.th.h) <= 2,
    { before: lastHot.before, base: last.before.content })

  // ---- 4) 真实拖拽改宽，且不被当成点击排序 ----
  await cdp.mouse('mouseMoved', base.th.right - 4, base.th.cy)
  await sleep(120)
  const ordersBefore = await cdp.eval('JSON.stringify(window.__orders)')
  await cdp.eval('window.__ptr = []')
  const widthBefore = (await json(cdp, 'window.__line("id")')).th.w
  await cdp.mouse('mousePressed', base.th.right - 4, base.th.cy)
  for (let d = 10; d <= 60; d += 10) {
    await cdp.mouse('mouseMoved', base.th.right - 4 + d, base.th.cy)
    await sleep(40)
  }
  await cdp.mouse('mouseReleased', base.th.right + 56, base.th.cy)
  await sleep(400)
  const after = await json(cdp, 'window.__line("id")')
  const ordersAfter = await cdp.eval('JSON.stringify(window.__orders)')
  const ptr = await cdp.eval('JSON.stringify(window.__ptr)')
  console.log('DEBUG drag geometry', JSON.stringify({
    pressX: Math.round(base.th.right - 4),
    releaseX: Math.round(base.th.right + 56),
    idRight: Math.round(after.th.right),
    widthBefore,
    widthAfter: after.th.w,
    ptr
  }))
  // 拖完之后新记录的查询：判据不是"一条都不能多发"（提交宽度会连带重算行数等），
  // 而是"多发的查询不带 ORDER BY"—— 带了就说明这一下被当成了排序点击
  const added = JSON.parse(ordersAfter).slice(JSON.parse(ordersBefore).length)
  // table-layout fixed + max-content 会把剩余空间摊给各列，提交宽 +60 后**实测**
  // 增幅不等于 60：判据只要求"明显变宽且方向对"，精确值由单元测的纯函数钉
  check('拖 +60 生效（列宽变大）',
    after.th.w - widthBefore >= 20, { before: widthBefore, after: after.th.w })
  check('拖拽不被当成排序点击（没有新排序条件发出去）',
    added.every(o => !o.length) && await cdp.eval('window.__glyph("id")') === '⇅',
    { added })
  check('拖拽期间光标是 col-resize', after.resizerCursor === 'col-resize', { cursor: after.resizerCursor })
  // 这道守卫必须是一次性的：拖完再正常点一下，排序还得生效（否则是"拖一次废一列"）
  const beforeGuard = await cdp.eval('window.__orderCount()')
  await cdp.eval('window.__clickHead("id")')
  await waitFor(cdp, 'window.__orderCount() > ' + beforeGuard, 'click after drag')
  check('拖完之后的正常点击仍然能排序（守卫只吃拖完那一下）',
    await cdp.eval('JSON.stringify(window.__lastOrder())') === '["id:asc"]' &&
    await cdp.eval('window.__glyph("id")') === '▲',
    { order: await cdp.eval('JSON.stringify(window.__lastOrder())') })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-after-drag.png')))

  await cdp.call('Page.reload', {})
  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  if (failed.length) {
    console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
    process.exitCode = 1
  }
  // 不断socket 的话这条常驻连接会一直压着事件循环，判据早跑完了进程还不退
  cdp.ws.close()
}

main().catch(err => {
  console.error('ERROR', err && err.message)
  process.exitCode = 1
})
