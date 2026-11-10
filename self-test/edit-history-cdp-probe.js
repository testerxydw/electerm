#!/usr/bin/env node
// N12c 数据修改历史 —— 真实 UI 全链路 CDP 探针。
//
// 链路每一环都是真的（唯一桩：无——临时 sqlite 夹具即真库）：
//   真实双击改格（CDP Input 坐标）→ 编辑态 → Enter 保存
//   → 即时写路径（use-db-cell-edit → dbClientOp updateCell → 真库落盘）
//   → 成功后 appendEditHistory（渲染层 → dbEditHistoryOp IPC → 主进程环形 JSON）
//   变更集路径：暂存开关 → 改格进 stage（此时**不**落历史）→ 变更面板「应用」
//   → planSubmit 逐条走 op → kind:'changes' 留痕
//   面板路径：变更面板历史按钮 → Modal 渲染条目 → 删单条 / 清空（IPC remove/clear）。
//
// 为什么必须实机（单测替代不了）：
// - 历史条目是 fire-and-forget 挂在 4 个 hook 的成功分支上，接线对不对（editHistoryBase
//   传没传、kind 对不对、preview 同不同源）只有真跑一次写路径才知道；
// - "暂存模式不即时落历史、应用才落一条"这个分流语义，纯函数测不出 UI 层的实际分叉；
// - 面板与 IPC 的 remove/clear 是乐观更新 + fire 主进程，坏一条就整条链静默失败。
//
// 用法：先 npm run compile（探针加载 work/app 产物），需独占 X display：
//   node self-test/edit-history-cdp-probe.js [display] [pagePort] [mainPort] [shotDir]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9355'
const IPORT = process.argv[4] || '9356'
const SHOT_DIR = path.join(ROOT, process.argv[5] || 'self-test/2026-11-10-edit-history-shots')

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n12c-'))
const DB = path.join(RUN, 'demo', 'probe.db')
const TITLE = 'n12c-edit-history'
let app = null
let page = null
let mainCdp = null

// 主进程侧读历史文件：不猜 userData 位置，从 app.getPath 拿
const HIST_READ = `(() => {
  const req = process.mainModule && process.mainModule.require
    ? process.mainModule.require
    : require
  const f = req('path').join(req('electron').app.getPath('userData'), 'db-edit-history.json')
  try {
    return JSON.stringify({ file: f, items: JSON.parse(req('fs').readFileSync(f, 'utf8')) })
  } catch (e) {
    return JSON.stringify({ file: f, items: [], err: String((e && e.message) || e) })
  }
})()`

// 页内探针：数据网格/树用 db-sqlite-sql-demo 验证过的子集，
// 变更集与历史面板按本轮 DOM 现写。可见性判定一律带命中测试。
const PROBE = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return !!r.width && !!r.height && !window.__hidden(el)
  }
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__txt = el => (el ? String(el.innerText || '').trim() : null)
  window.__headTarget = () => window.__txt(window.__one('.db-head-target'))

  // ---- 结构树 ----
  window.__collapsedSwitcherXY = () => {
    const el = window.__one('.db-tree .ant-tree-switcher_close')
    return el ? window.__xy(el) : null
  }
  window.__treeNodeXY = t => {
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => n.innerText.trim().indexOf(t) >= 0)
    for (const el of all) {
      el.scrollIntoView({ block: 'center' })
      if (window.__vis(el)) return window.__xy(el)
    }
    return null
  }

  // ---- 数据网格 ----
  const dataTable = () => window.__one('.db-grid-area .db-grid-table')
  const nameOf = th => {
    const n = th.querySelector('.db-col-name')
    return ((n && n.innerText) || th.innerText || '').trim().split('\\n')[0]
  }
  window.__dataGrid = () => {
    const g = dataTable()
    if (!g) return null
    return {
      heads: [...g.querySelectorAll('thead th')].map(nameOf).filter(Boolean),
      title: window.__txt(window.__one('.db-grid-area .db-grid-title'))
    }
  }
  window.__colIdx = label => {
    const g = dataTable()
    if (!g) return -1
    const ths = [...g.querySelectorAll('thead th')]
    let hit = -1
    for (let i = 0; i < ths.length; i++) {
      if (nameOf(ths[i]) === label) hit = i
    }
    return hit
  }
  window.__visRows = () => {
    const g = dataTable()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  window.__dataRows = () => window.__visRows().map(tr => [...tr.children].map(td => td.innerText.trim()))
  window.__rowIdxOf = t => window.__visRows()
    .findIndex(tr => [...tr.children].some(td => td.innerText.indexOf(t) >= 0))
  // 点击坐标取格子左半 60px 内：右沿是列头拖宽热区的延长线
  window.__cellXY = (label, i) => {
    const idx = window.__colIdx(label)
    const tr = window.__visRows()[i || 0]
    if (idx < 0 || !tr || !tr.children[idx]) return null
    const r = tr.children[idx].getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2) }
  }
  window.__cellEditor = () => window.__one('.db-cell-editor')
  window.__setInput = (el, v) => {
    if (!el) return 'no-input'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }

  // ---- 暂存变更（N2）----
  window.__stageSwitchXY = () => {
    const el = window.__one('.db-stage-switch .ant-switch')
    return el ? window.__xy(el) : null
  }
  window.__stageOpen = () => {
    const el = window.__one('.db-stage-open')
    return el ? { text: window.__txt(el), xy: window.__xy(el) } : null
  }
  window.__changesBar = () => {
    const bar = window.__one('.db-changes-bar')
    if (!bar) return null
    return {
      rows: [...document.querySelectorAll('.db-changes-row')].filter(window.__vis)
        .map(r => ({ sql: window.__txt(r.querySelector('.db-changes-sql')), kind: window.__txt(r.querySelector('.db-changes-kind')) })),
      apply: (() => {
        const b = window.__one('.db-changes-apply')
        return b ? { disabled: !!b.disabled, text: window.__txt(b), xy: window.__xy(b) } : null
      })(),
      hist: (() => {
        const b = window.__one('.db-changes-history')
        return b ? { xy: window.__xy(b) } : null
      })()
    }
  }

  // ---- 编辑历史面板（N12c）----
  window.__histPanel = () => {
    const m = [...document.querySelectorAll('.db-edit-history-modal')].filter(window.__vis)[0]
    if (!m) return null
    const items = [...m.querySelectorAll('.db-edit-history-item')].filter(window.__vis)
    return {
      title: window.__txt(m.querySelector('.ant-modal-title')),
      count: window.__txt(m.querySelector('.db-edit-history-count')),
      kinds: items.map(i => window.__txt(i.querySelector('.db-edit-history-kind'))),
      tables: items.map(i => window.__txt(i.querySelector('.db-edit-history-table'))),
      sqls: items.map(i => window.__txt(i.querySelector('.db-edit-history-sql'))),
      n: items.length
    }
  }
  // 第 i 条的删除按钮（X，title=dbEditHistoryRemove）
  window.__histRemoveXY = i => {
    const m = [...document.querySelectorAll('.db-edit-history-modal')].filter(window.__vis)[0]
    if (!m) return null
    const items = [...m.querySelectorAll('.db-edit-history-item')].filter(window.__vis)
    const it = items[i]
    if (!it) return null
    const b = [...it.querySelectorAll('.db-edit-history-item-head button')][0]
    return b ? window.__xy(b) : null
  }
  window.__histClearXY = () => {
    const m = [...document.querySelectorAll('.db-edit-history-modal')].filter(window.__vis)[0]
    if (!m) return null
    const b = [...m.querySelectorAll('.db-edit-history-bar button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').length > 0 && !x.querySelector('.anticon-download'))
    return b ? window.__xy(b) : null
  }
  // Popconfirm 的确认键（okText 是最后一个按钮）
  window.__popconfirmOkXY = () => {
    const p = [...document.querySelectorAll('.ant-popover')].filter(window.__vis)[0]
    if (!p) return null
    const ok = [...p.querySelectorAll('.ant-popconfirm-buttons button')].filter(window.__vis).pop()
    return ok ? window.__xy(ok) : null
  }
  window.__msgAll = () => [...document.querySelectorAll('.message-item')].filter(window.__vis)
    .map(x => x.innerText.trim()).join(' | ')
  return 1
})()`

function writeFixture () {
  fs.mkdirSync(path.dirname(DB), { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  const ins = db.prepare('INSERT INTO product(id, name, price, note) VALUES(?, ?, ?, ?)')
  ins.run(1, '键盘', 299.5, null)
  ins.run(2, '鼠标', 88, '第一批')
  ins.run(3, '显示器', 1899, '1920x1080')
  db.close()
}

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = { ...process.env }
  // 宿主（WorkBuddy 沙箱）带 ELECTRON_RUN_AS_NODE=1，不清掉 electron 会以普通 node 跑
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.HOME = path.join(RUN, 'home')
  env.XDG_CONFIG_HOME = path.join(RUN, 'config')
  env.TMPDIR = path.join(RUN, 'tmp')
  env.DATA_PATH = path.join(RUN, 'data')
  // Xvfb 无 GPU：命令行 --disable-gpu 不够，必须 app 级禁用硬件加速（crash-reporter.js 认 DISABLE_GPU）
  env.DISABLE_GPU = '1'
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--inspect=127.0.0.1:' + IPORT,
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: 'ignore' })
}

async function cleanup () {
  if (page) page.ws.close()
  if (mainCdp) mainCdp.ws.close()
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve))
    try { process.kill(-app.pid, 'SIGTERM') } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
    await exited
  }
  fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

async function assertPortsIdle () {
  for (const [label, port] of [['页面', PORT], ['主进程', IPORT]]) {
    const v = await getJson('http://127.0.0.1:' + port + '/json/list').catch(() => null)
    if (v) {
      throw new Error(label + '端口 ' + port + ' 上已有实例（targets=' + v.length + '）——先清掉再跑')
    }
  }
}

async function waitPageCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const p = list && findPageTarget(list)
    if (p) {
      const cdp = new Cdp(p.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      await cdp.call('Log.enable', {})
      cdp.events.length = 0
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

async function waitMainCdp (tries = 60) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + IPORT + '/json/list').catch(() => null)
    const t = Array.isArray(list) && list.find(x => x.webSocketDebuggerUrl)
    if (t) {
      const cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Runtime.enable', {})
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('inspect 端口 ' + IPORT + ' 上没有主进程目标')
}

// 历史文件轮询读：appendEditHistory 是 fire-and-forget，落盘有 IO 延迟
async function readHist () {
  return JSON.parse(await mainCdp.eval(HIST_READ))
}
async function waitHist (pred, label, timeout = 12000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeout) {
    last = await readHist()
    if (pred(last.items)) return last
    await sleep(250)
  }
  console.log('TIMEOUT 历史文件等不到：' + label + ' 现场=' + JSON.stringify(last).slice(0, 400))
  return null
}

async function main () {
  await assertPortsIdle()
  writeFixture()

  launch()
  mainCdp = await waitMainCdp()
  page = await waitPageCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(page, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪：' + J(await page.tail(8)))
  }
  await sleep(2500)
  await page.eval(PROBE)

  // 开一个 sqlite 会话页签（readOnly 必须显式 false：tab.readOnly !== false 即视为只读）
  await page.eval(`(() => {
    window.store.addTab({
      type: 'database',
      from: 'quick-connect',
      title: ${J(TITLE)},
      dbType: 'sqlite',
      dbFile: ${J(DB)},
      readOnly: false,
      production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  check('sqlite 会话页签连上，头部显示库文件名',
    await waitFor(page, 'String(window.__headTarget() || "").indexOf("probe.db") >= 0', 'head target', 25000))
  // sqlite 树的 schema 层默认收起，product 节点未展开时不在 DOM：先展开再判
  for (let i = 0; i < 4; i++) {
    const sw0 = await page.eval('window.__collapsedSwitcherXY()')
    if (!sw0) break
    await page.click(sw0.x, sw0.y)
    await sleep(700)
  }
  check('结构树有 product', await waitFor(page, '!!window.__treeNodeXY("product")', 'tree node', 15000))

  const node = await page.eval('window.__treeNodeXY("product")')
  if (!node) throw new Error('product 节点不可点')
  await page.click(node.x, node.y)
  check('点表打开数据网格（4 列 id/name/price/note）',
    await waitFor(page, `(() => {
      const g = window.__dataGrid()
      return !!(g && (g.title === 'product' || String(g.title).endsWith('.product')) &&
        JSON.stringify(g.heads) === JSON.stringify(['id', 'name', 'price', 'note']))
    })()`, 'grid', 15000))

  // ============ A 即时写留痕（kind:'cell'）============
  const idxMouse = await page.eval('window.__rowIdxOf("鼠标")')
  await dblClickCell('name', idxMouse)
  check('双击改格进编辑态（.db-cell-editor）', await waitFor(page,
    '!!window.__cellEditor()', 'cell editor', 8000))
  await page.eval('window.__setInput(window.__cellEditor(), \'鼠标B\')')
  await pressEnter()
  check('改格后界面刷新出新值', await waitFor(page,
    'window.__dataRows().map(r => r.join("|")).join("#").indexOf("鼠标B") >= 0', 'new value', 12000))

  const h1 = await waitHist(items => items.some(it => it.kind === 'cell'), 'cell 条目')
  check('历史文件出现 kind=cell 条目', !!h1 && h1.items.some(it => it.kind === 'cell'), h1 && h1.file)
  const cell0 = h1 && [...h1.items].sort((a, b) => (b.ts || 0) - (a.ts || 0)).find(it => it.kind === 'cell')
  check('cell 条目字段齐全：table=product、sql 与确认弹窗同源（UPDATE 含新值）、n=1、ok=true',
    !!cell0 && cell0.table === 'product' && /UPDATE/i.test(String(cell0.sql)) &&
    String(cell0.sql).indexOf('鼠标B') >= 0 && cell0.n === 1 && cell0.ok === true,
    cell0 && { sql: cell0.sql, n: cell0.n, ok: cell0.ok })
  check('cell 条目带连接身份（sqlite + 夹具路径），不含密码字段',
    !!cell0 && cell0.dbType === 'sqlite' && cell0.dbFile === DB &&
    !('dbPassword' in cell0) && !('password' in cell0),
    cell0 && { dbType: cell0.dbType, dbFile: cell0.dbFile })

  // ============ B 变更集留痕（kind:'changes'，暂存期间不落历史）============
  const sw = await page.eval('window.__stageSwitchXY()')
  if (!sw) throw new Error('暂存开关不可点')
  await page.click(sw.x, sw.y)
  check('暂存开关打开后变更入口出现', await waitFor(page, '!!window.__stageOpen()', 'stage-open', 8000))

  const idxKb = await page.eval('window.__rowIdxOf("键盘")')
  await dblClickCell('note', idxKb)
  await page.eval('window.__setInput(window.__cellEditor(), \'n12c-staged\')')
  await pressEnter()
  check('暂存模式下改格进变更集（入口按钮计数变 1）', await waitFor(page,
    '/\\(\\s*1\\s*\\)/.test(String((window.__stageOpen() || {}).text || ""))', 'count 1', 10000))
  check('暂存期间历史不落条目（应用才留痕——分流语义）',
    (await readHist()).items.filter(it => it.kind === 'changes').length === 0)

  const openBtn = await page.eval('window.__stageOpen()')
  await page.click(openBtn.xy.x, openBtn.xy.y)
  check('变更面板打开且预览 SQL 可见（与确认弹窗同源）', await waitFor(page,
    `(() => {
      const b = window.__changesBar()
      return !!(b && b.rows.length === 1 && /UPDATE/i.test(String(b.rows[0].sql)) &&
        String(b.rows[0].sql).indexOf('n12c-staged') >= 0)
    })()`, 'changes bar', 10000))
  await page.shot(path.join(SHOT_DIR, '1-changes-pane.png'))

  const applyBtn = await page.eval('window.__changesBar()')
  if (!applyBtn || !applyBtn.apply || applyBtn.apply.disabled) {
    throw new Error('应用按钮不可用：' + J(applyBtn && applyBtn.apply))
  }
  await page.click(applyBtn.apply.xy.x, applyBtn.apply.xy.y)
  check('应用后真库落盘（网格刷新出新值）', await waitFor(page,
    'window.__dataRows().map(r => r.join("|")).join("#").indexOf("n12c-staged") >= 0', 'applied value', 15000))

  const h2 = await waitHist(items => items.some(it => it.kind === 'changes'), 'changes 条目')
  const chg = h2 && [...h2.items].sort((a, b) => (b.ts || 0) - (a.ts || 0)).find(it => it.kind === 'changes')
  check('变更集应用落一条 kind=changes 留痕（n=1、ok=true、sql 为批次合并摘要）',
    !!chg && chg.n === 1 && chg.ok === true && /UPDATE/i.test(String(chg.sql)) &&
    String(chg.sql).indexOf('n12c-staged') >= 0,
    chg && { sql: chg.sql, n: chg.n, ok: chg.ok })

  // 宿主侧直读 sqlite 文件：两次写都真的落库（界面刷新不算数）
  const probe = new DatabaseSync(DB)
  try {
    const mouseB = probe.prepare('SELECT COUNT(*) AS c FROM product WHERE name = ?').get('鼠标B').c
    const staged = probe.prepare('SELECT COUNT(*) AS c FROM product WHERE note = ?').get('n12c-staged').c
    check('宿主直读 sqlite：即时写与变更集写都落盘', mouseB === 1 && staged === 1, { mouseB, staged })
  } finally {
    probe.close()
  }

  // ============ C 历史面板 UI ============
  const histBtn = (await page.eval('window.__changesBar()') || {}).hist
  if (!histBtn) throw new Error('历史按钮不可点')
  await page.click(histBtn.xy.x, histBtn.xy.y)
  check('历史面板打开（Modal 标题为「数据修改历史」或对应词条）', await waitFor(page,
    '!!window.__histPanel()', 'hist modal', 10000))
  await page.shot(path.join(SHOT_DIR, '2-edit-history-panel.png'))

  const hp = await page.eval('window.__histPanel()')
  check('面板渲染 2 条留痕（cell + changes，MRU 新在前）',
    !!hp && hp.n === 2 && hp.kinds.length === 2 &&
    hp.kinds[0] !== hp.kinds[1] && String(hp.sqls[0] || '').indexOf('n12c-staged') >= 0,
    hp && { kinds: hp.kinds, sqls: hp.sqls })
  check('计数文案给出条数 2 与环形上限 300', !!hp && /2/.test(String(hp.count)) && /300/.test(String(hp.count)), hp && hp.count)
  check('目标列显示 库.表（含 product）', !!hp && hp.tables.every(t => String(t).indexOf('product') >= 0), hp && hp.tables)

  // 删单条：乐观本地移除 + fire IPC remove
  const rmXY = await page.eval('window.__histRemoveXY(0)')
  if (!rmXY) throw new Error('删除按钮不可点')
  await page.click(rmXY.x, rmXY.y)
  const h3 = await waitHist(items => items.length === 1, '删单条后剩 1 条')
  check('面板删单条 → 主进程文件同步剩 1 条', !!h3 && h3.items.length === 1, h3 && h3.items.map(i => i.kind))

  // 清空：Popconfirm 二次确认 → 文件清空
  const clearXY = await page.eval('window.__histClearXY()')
  if (!clearXY) throw new Error('清空按钮不可点')
  await page.click(clearXY.x, clearXY.y)
  check('清空走 Popconfirm 二次确认', await waitFor(page, '!!window.__popconfirmOkXY()', 'popconfirm', 8000))
  const okXY = await page.eval('window.__popconfirmOkXY()')
  await page.click(okXY.x, okXY.y)
  const h4 = await waitHist(items => items.length === 0, '清空后 0 条')
  check('确认清空 → 主进程文件同步清空', !!h4 && h4.items.length === 0, h4 && { err: h4.err, n: h4.items.length })
  await page.shot(path.join(SHOT_DIR, '3-after-clear.png'))

  const hard = page.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|TypeError|uncaught/.test(s)
  })
  check('渲染层没有新增硬错误（懒加载被换页撕掉的不算）', hard.length === 0, hard.slice(0, 5))

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  return fail.length
}

async function dblClickCell (label, rowIdx) {
  const xy = await page.eval(`window.__cellXY(${J(label)}, ${J(rowIdx)})`)
  if (!xy) throw new Error('格子不可点：' + label + '/' + rowIdx)
  await page.click(xy.x, xy.y, 2)
  await sleep(900)
}

async function pressEnter () {
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13 })
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13 })
  await sleep(600)
}

main().then(code => {
  process.exitCode = code ? 1 : 0
}, e => {
  console.error(e)
  process.exitCode = 1
}).finally(cleanup).catch(e => {
  console.error(e)
  process.exitCode = 1
})
