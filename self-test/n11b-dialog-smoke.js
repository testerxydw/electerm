#!/usr/bin/env node
/**
 * N11b 收口补测 —— 三块「CDP 点不到」的实机验证
 *
 * 覆盖：
 *   A. #28 SQL 文件打开 / 保存（use-db-sql-file.js）
 *   B. #29 掉线重连（reconnect）与初次失败重试（retryConnect）—— use-db-connection.js
 *      正向：补上库文件后重试 → 进入正常界面
 *      反向：不补文件再点一次 → 失败卡片必须原地不动（不许把错误态提前清掉）
 *   C. 三个弹层：ER 图 / 结构对比 / 值面板 —— use-db-redis-instance.js + 值面板入口
 *
 * 为什么不是「照抄 n11b-split-smoke」：
 *   - 文件对话框走主进程（window.api.openDialog → ipc → dialog），而 window.api 由
 *     contextBridge 暴露且 Object.isFrozen(window.api) === true、window.api 属性也
 *     non-writable/non-configurable —— 页面里**改不了** openDialog/saveDialog。
 *     所以本脚本给主进程起 --inspect=9229，在主进程侧替换 electron.dialog 的两个方法。
 *     这比页面桩更真：preload → ipcMain.handle → dialog 整条链路照跑。
 *   - 掉线：sqlite 的句柄按路径缓存在主进程（db-client/sqlite.js 的 dbs），
 *     只删库文件不会让后续 op 失败（unlink 后 fd 仍可读）。脚本先量一次
 *     「删文件但不断连」确实不报错，再显式 closeDbTab 模拟真掉线。
 *
 * 用法：
 *   1) npm run compile（只在改了 src 后需要）
 *   2) mkdir -p /tmp/electerm-dlg/{home,tmp}
 *      env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 HOME=/tmp/electerm-dlg/home \
 *        TMPDIR=/tmp/electerm-dlg/tmp ./node_modules/electron/dist/electron \
 *        work/app/app.js --inspect=9229 --remote-debugging-port=9387 \
 *        --no-sandbox --window-size=1600,1000
 *   3) node self-test/n11b-dialog-smoke.js [port] [mainInspectPort] [shotDir]
 *
 * 夹具在 /tmp/electerm-dlg/demo，每次重建；不碰仓库、不含真实凭据。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9387'
const MAIN_PORT = process.argv[3] || '9229'
const SHOT_DIR = process.argv[4] || path.join(__dirname, 'n11b-dialog-shots')
const DEMO_DIR = '/tmp/electerm-dlg/demo'
const DB = path.join(DEMO_DIR, 'dlg.db')
const DB_BAK = path.join(DEMO_DIR, 'dlg.db.bak')
const Q_SQL = path.join(DEMO_DIR, 'q.sql')
const MISSING = path.join(DEMO_DIR, 'missing.db')
const UNBOUND = path.join(DEMO_DIR, 'plain')
const Q_TEXT = "-- n11b-sql-file-marker\nselect 'q_marker' as tag;\n"
const DIRTY_TAIL = '\n-- dirty marker'
const TITLE = 'dlg'
const J = s => JSON.stringify(s)

// 页内探针：只做「找 / 点 / 读」，判据留在 Node 侧。
// 弹层淡入期间 opacity 还不到 0.05，结构判定一律用原始 querySelectorAll。
const PROBE = `(() => {
  window.__txt = el => (el && el.innerText ? el.innerText : '').trim()
  window.__q = sel => document.querySelectorAll(sel).length
  window.__all = sel => [...document.querySelectorAll(sel)].filter(el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  })
  window.__txtOf = sel => window.__all(sel).map(window.__txt).join(' | ')
  // 顶栏：目标 + 连接状态
  window.__head = () => window.__txt(document.querySelector('.db-head-target'))
  window.__headDot = () => {
    const d = document.querySelector('.db-head-dot')
    return d ? String(d.className) : 'none'
  }
  // 点主区页签（0=data 1=sql 2=structure）。SQL 页签文案会变成文件名，不能按文字找
  window.__tabN = n => {
    const tabs = window.__all('.db-tabs .ant-tabs-tab')
    if (!tabs[n]) return 'no-tab:' + n + '/' + tabs.length
    tabs[n].click()
    return 'ok'
  }
  window.__tabLabel = n => {
    const tabs = window.__all('.db-tabs .ant-tabs-tab')
    return tabs[n] ? window.__txt(tabs[n]) : 'no-tab:' + n
  }
  window.__visEl = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  // 按 title / aria-label / innerText 任一命中来点按钮（图标按钮只有 title）
  window.__btnRe = (sel, re) => {
    const rx = new RegExp(re, 'i')
    const hit = [...document.querySelectorAll(sel)].filter(window.__visEl).find(b => {
      const label = [b.getAttribute('title'), b.getAttribute('aria-label'), window.__txt(b)]
        .filter(Boolean).join(' ')
      return rx.test(label)
    })
    if (!hit) return 'no-btn:' + sel + ':' + re
    if (hit.disabled) return 'btn-disabled:' + re
    hit.click()
    return 'ok'
  }
  // 升级提示 / 引导弹层会吃掉点击
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__visEl)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  // 数据页网格行数（antd 虚拟表同样是 .ant-table-row）
  window.__dataRows = () => window.__q('.db-grid-table .ant-table-row')
  // 数据页某列某行的坐标：列名从 thead 的 .db-col-name 读
  window.__cellXY = (label, rowIdx) => {
    const g = document.querySelector('.db-grid-table')
    if (!g) return JSON.stringify({ error: 'no-grid' })
    const nameOf = th => {
      const n = th.querySelector('.db-col-name')
      return ((n && n.innerText) || th.innerText || '').trim().split('\\n')[0]
    }
    const ths = [...g.querySelectorAll('thead th')]
    let idx = -1
    for (let i = 0; i < ths.length; i++) { if (nameOf(ths[i]) === label) { idx = i; break } }
    if (idx < 0) return JSON.stringify({ error: 'no-col:' + label, ths: ths.map(nameOf) })
    const tr = [...g.querySelectorAll('.ant-table-row')][rowIdx || 0]
    if (!tr) return JSON.stringify({ error: 'no-row:' + rowIdx })
    const td = tr.children[idx]
    if (!td) return JSON.stringify({ error: 'no-td' })
    const r = td.getBoundingClientRect()
    const gr = g.getBoundingClientRect()
    const x = Math.round(r.left + Math.min(r.width / 2, 50))
    const y = Math.round(r.top + r.height / 2)
    return JSON.stringify({
      x, y,
      inView: x > gr.left && x < gr.right && y > gr.top && y < gr.bottom,
      text: td.innerText.trim().slice(0, 24)
    })
  }
  // 值面板：可见的 .db-value-pane（数据页在 split-pane-bottom 里）
  window.__paneInfo = () => {
    const list = window.__all('.db-value-pane')
    const p = list[0]
    if (!p) return JSON.stringify({ n: 0 })
    const head = p.querySelector('.db-value-pane-head')
    return JSON.stringify({
      n: list.length,
      title: ((head && head.querySelector('.db-grid-title')) || {}).innerText || '',
      text: String(p.textContent || '').slice(0, 200),
      h: Math.round(p.getBoundingClientRect().height)
    })
  }
  // 弹层信息：raw 计数（淡入期也在）+ 可见计数
  window.__modal = sel => JSON.stringify({
    raw: document.querySelectorAll(sel).length,
    vis: window.__all(sel).length
  })
  window.__erInfo = () => JSON.stringify({
    modalRaw: window.__q('.db-er-modal'),
    modalVis: window.__all('.db-er-modal').length,
    nodes: window.__q('.db-er-node'),
    edges: window.__q('.db-er-edge'),
    empty: window.__q('.db-er-empty'),
    note: window.__txtOf('.db-er-note'),
    err: window.__txtOf('.db-er-err'),
    hint: window.__txtOf('.db-er-hint')
  })
  window.__diffInfo = () => JSON.stringify({
    modal: window.__all('.db-struct-diff-modal').length,
    selects: window.__q('.db-struct-diff-modal .db-diff-select'),
    selText: [...document.querySelectorAll('.db-struct-diff-modal .db-diff-select')].map(x => window.__txt(x)),
    hint: window.__txtOf('.db-diff-hint'),
    summary: window.__txtOf('.db-diff-summary'),
    sections: window.__txtOf('.db-diff-section-title'),
    removed: window.__q('.db-diff-row.is-removed'),
    added: window.__q('.db-diff-row.is-added'),
    changed: window.__q('.db-diff-row.is-changed'),
    rowText: window.__txtOf('.db-diff-row'),
    // 按状态分组的行文本：三种差异要分别落到具体列名上，不能只看第一行
    removedText: [...document.querySelectorAll('.db-diff-row.is-removed')].map(window.__txt).join(' | '),
    addedText: [...document.querySelectorAll('.db-diff-row.is-added')].map(window.__txt).join(' | '),
    changedText: [...document.querySelectorAll('.db-diff-row.is-changed')].map(window.__txt).join(' | '),
    // summary 四个计数 Tag 的原文（如「仅在 B 1」）；单独读，避免整块文案混在一起
    counts: {
      removed: window.__txtOf('.db-diff-count.is-removed'),
      added: window.__txtOf('.db-diff-count.is-added'),
      changed: window.__txtOf('.db-diff-count.is-changed'),
      equal: window.__txtOf('.db-diff-count.is-equal')
    },
    err: window.__txtOf('.db-diff-err')
  })
  // 关弹层：优先右上角 ×，退化为底部「关闭」按钮
  window.__closeModal = sel => {
    const root = document.querySelector(sel)
    if (!root) return 'no-modal'
    const x = root.querySelector('.ant-modal-close')
    if (x) { x.click(); return 'x' }
    const btns = [...document.querySelectorAll(sel + ' button')]
    const b = btns.find(x => /关闭|close/i.test(window.__txt(x)))
    if (!b) return 'no-close'
    b.click()
    return 'btn'
  }
  // 顶栏刷新（loadTree 的唯一稳定入口：title/aria-label = 刷新/Refresh）
  window.__headRefresh = () => window.__btnRe('.db-head button', '刷新|refresh')
  // 掉线横幅
  window.__banner = () => JSON.stringify({
    n: window.__all('.db-conn-fail-banner').length,
    text: window.__txtOf('.db-conn-fail-banner'),
    raw: window.__txtOf('.db-conn-fail-raw'),
    tabs: window.__q('.db-tabs'),
    grid: window.__q('.db-grid-table'),
    rows: window.__dataRows(),
    headDot: window.__headDot()
  })
  window.__bannerReconnect = () => {
    const box = document.querySelector('.db-conn-fail-banner')
    if (!box) return 'no-banner'
    const b = [...box.querySelectorAll('button')].find(x => /重连|reconnect/i.test(window.__txt(x)))
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  // 结构化入口：结构页工具行按钮
  window.__structBtn = re => window.__btnRe('.db-struct-tools button', re)
  // 树展开（SQLite/PG 默认只到库节点）
  window.__expand = () => {
    let n = 0
    for (let i = 0; i < 12; i++) {
      const closed = window.__all('.db-tree .ant-tree-switcher_close')
      if (!closed.length) break
      closed.forEach(s => s.click())
      n += closed.length
    }
    return n
  }
})()`

const writeFixture = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  for (const f of [DB, DB + '-wal', DB + '-shm', DB_BAK, Q_SQL, UNBOUND, UNBOUND + '.sql']) {
    try { fs.unlinkSync(f) } catch (e) {}
  }
  const db = new DatabaseSync(DB)
  db.exec(`
    create table orders (
      id integer primary key,
      amount integer,
      created_at text
    );
    insert into orders values (1, 100, '2026-01-01');
    insert into orders values (2, 250, '2026-01-02');
    insert into orders values (3, 375, '2026-01-03');
    insert into orders values (4, 480, '2026-01-04');
    create table orders_copy (
      id integer primary key,
      amount text,
      note text
    );
    insert into orders_copy values (1, '100', 'n1');
    insert into orders_copy values (2, '250', 'n2');
    insert into orders_copy values (3, '375', 'n3');
    insert into orders_copy values (4, '480', 'n4');
  `)
  db.close()
  fs.writeFileSync(Q_SQL, Q_TEXT)
}

const makeMissingDb = () => {
  try { fs.unlinkSync(MISSING) } catch (e) {}
  const db = new DatabaseSync(MISSING)
  db.exec(`
    create table recover_me (id integer primary key, note text);
    insert into recover_me values (1, 'back');
  `)
  db.close()
}

// 主进程桩：替换 electron.dialog 的两个方法，值从 global.__dlgStub 读。
// 页面里的 window.api 是 contextBridge 冻结对象，改不动 —— 只能在这一层拦。
const installDialogStub = main => main.eval(`(() => {
  const { dialog } = process.mainModule.require('electron')
  global.__dlgStub = global.__dlgStub || { open: [], save: '' }
  if (!dialog.__n11bStubbed) {
    dialog.showOpenDialogSync = function () {
      return (global.__dlgStub.open || []).slice()
    }
    dialog.showSaveDialog = async function () {
      if (!global.__dlgStub.save) {
        return { canceled: true, filePath: '' }
      }
      return { canceled: false, filePath: global.__dlgStub.save }
    }
    dialog.__n11bStubbed = true
  }
  return 'ok'
})()`)

const setDialogStub = (main, { open, save }) => main.eval(
  `(() => {
    global.__dlgStub = global.__dlgStub || { open: [], save: '' }
    global.__dlgStub.open = ${JSON.stringify(open || [])}
    global.__dlgStub.save = ${JSON.stringify(save || '')}
    return JSON.stringify(global.__dlgStub)
  })()`
)

// 主进程 IPC 计数桩：只包一层 'async' 通道（pre.runGlobalAsync 走的就是它），
// 记录方法名序列。作用是把「点了重试」与「按钮没点上、旧卡片还挂着」区分开 ——
// 纯观测，不改变调用结果；拿不到 Electron 内部的 handler Map 时返回 no-map，
// 判据本身不依赖它（只作为证据打出来）。
const installIpcTap = main => main.eval(`(() => {
  try {
    const { ipcMain } = process.mainModule.require('electron')
    const map = ipcMain && ipcMain._invokeHandlers
    if (!map || typeof map.get !== 'function') return 'no-map'
    if (global.__n11bIpcTapped) return 'already'
    const orig = map.get('async')
    if (typeof orig !== 'function') return 'no-handler'
    global.__n11bIpc = []
    map.set('async', function (event, payload) {
      try {
        (global.__n11bIpc = global.__n11bIpc || []).push(payload && payload.name)
      } catch (e) {}
      return orig.call(this, event, payload)
    })
    global.__n11bIpcTapped = true
    return 'ok'
  } catch (e) {
    return 'err:' + String((e && e.message) || e)
  }
})()`)

const ipcMark = async main => Number(await main.eval('(global.__n11bIpc || []).length')) || 0
const ipcSince = async (main, mark) => {
  const raw = await main.eval(`JSON.stringify((global.__n11bIpc || []).slice(${mark}))`)
  try { return JSON.parse(raw) } catch (e) { return [] }
}

// 等磁盘文件出现且内容符合预期（保存是异步 fs 通道）
const waitFile = async (file, expect, timeout = 6000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8')
      if (expect === undefined || text === expect) return { ok: true, text }
    }
    await sleep(150)
  }
  return { ok: false, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }
}

// CodeMirror 6：真鼠标点进去 + Ctrl+A + Input.insertText（只认这条路径）
const setSql = async (cdp, sql) => {
  let focused = await cdp.eval('window.__focusSql()')
  for (let i = 0; i < 6 && focused !== 'focused'; i++) {
    await sleep(300)
    const xy = await cdp.jeval(`(() => {
      const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
      if (!ed) return JSON.stringify({ error: 'no-editor' })
      const r = ed.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 20) })
    })()`)
    if (!xy.error) {
      await cdp.click(xy.x, xy.y)
      await sleep(200)
    }
    focused = await cdp.eval('window.__focusSql()')
  }
  if (focused !== 'focused') return { ok: false, why: focused }
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
  await cdp.call('Input.insertText', { text: sql })
  await sleep(200)
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await sleep(150)
  return { ok: true }
}

async function main () {
  const { check, skip, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // ---- 连接渲染进程（9387）----
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('找不到渲染进程页签，先把实例起起来（见文件头用法）')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  const shot = f => cdp.shot(path.join(SHOT_DIR, f))

  // ---- 连接主进程 inspector（9229），装对话框桩 ----
  let mainCdp = null
  try {
    const nodeTargets = await getJson(`http://127.0.0.1:${MAIN_PORT}/json/list`)
    const nodeTarget = (nodeTargets || []).find(t => t.type === 'node')
    if (nodeTarget) {
      mainCdp = new Cdp(nodeTarget.webSocketDebuggerUrl)
      await mainCdp.ready
      await mainCdp.call('Runtime.enable')
    }
  } catch (e) {
    mainCdp = null
  }
  check('主进程 inspector 可用（对话框必须在主进程侧换桩）', !!mainCdp,
    mainCdp ? 'ok' : '需要以 --inspect=9229 启动')
  if (!mainCdp) return finish()

  check('渲染进程可用（store / pre / translate 都在）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  // 页内能不能改 window.api：留一条实测读数，报告里要说明为什么走主进程
  const apiFrozen = await cdp.eval(`(() => {
    const d = Object.getOwnPropertyDescriptor(window, 'api')
    return JSON.stringify({
      frozen: Object.isFrozen(window.api),
      writable: d ? !!d.writable : null,
      configurable: d ? !!d.configurable : null
    })
  })()`)
  console.log('window.api 可写性: ' + apiFrozen)

  await cdp.eval(buildHelpers('electerm-n11b-dialog'))
  await cdp.eval(PROBE)
  check('页内探针装好', await cdp.eval('!!(window.__btnRe && window.__tabN && window.__cellXY)'))

  const stub = await preStubState(cdp)
  check('桥接层是原装的（没被别的 demo 的桩覆盖）',
    String(stub) === 'ok' || String(stub).indexOf('native') >= 0, stub)

  await clearDbTabs(cdp)
  writeFixture()
  makeMissingDb()
  try { fs.unlinkSync(MISSING) } catch (e) {} // 先删掉，B2 才能复现首次建连失败
  await sleep(300)

  for (let i = 0; i < 3; i++) {
    if (await cdp.eval('window.__dismiss()') !== 'closed') break
    await sleep(200)
  }

  check('对话框桩安装成功（electron.dialog.showOpenDialogSync/showSaveDialog）',
    await installDialogStub(mainCdp) === 'ok')
  // 重试链路的旁证：记录 runGlobalAsync 的方法名（拿不到内部 Map 时为 no-map，不影响判据）
  const ipcTap = await installIpcTap(mainCdp)
  console.log('主进程 IPC 计数桩: ' + ipcTap)

  // ---- 建连主 tab ----
  const tabId = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(TITLE)},
      dbType: 'sqlite', dbFile: ${J(DB)}, readOnly: false, production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const connected = await waitFor(cdp, '!!(window.__head() && window.__head().indexOf(\'dlg.db\') >= 0)',
    '会话头部等不到库文件名', 25000)
  check('夹具建连成功（头部显示 dlg.db）', connected, await cdp.eval('window.__head()'))
  if (!connected) {
    check('后续判据依赖建连，提前中止', false, cdp.tail(6))
    return finish()
  }

  const expanded = await cdp.eval('window.__expand()')
  const hasOrders = await waitFor(cdp, 'window.__hasTree("orders")', '树里等不到 orders', 20000)
  check('元数据树展开出两张表', hasOrders && await cdp.eval('window.__hasTree("orders_copy")'),
    { switched: expanded, names: await cdp.eval('window.__txtOf(".db-tree .ant-tree-node-content-wrapper")') })
  await cdp.eval('window.__clickTree("orders")')
  const gridOk = await waitFor(cdp, 'window.__dataRows() >= 4', '数据页网格等不到行', 20000)
  check('选 orders 后数据页出 4 行', gridOk, await cdp.eval('window.__dataRows()'))
  if (!gridOk) return finish()

  // =====================================================================
  // C. 三个弹层
  // =====================================================================
  const tab2 = await cdp.eval('window.__tabN(2)')
  const structOk = await waitFor(cdp, 'window.__q(".db-struct-tools button") >= 3', '结构页没渲染', 15000)
  check('C0 结构页工具行可用（ER / 结构对比入口的前置）', structOk && tab2 === 'ok',
    { tab: tab2, btns: await cdp.eval('window.__txtOf(".db-struct-tools button")') })

  // ---- C1 ER 图 ----
  const erClick = await cdp.eval('window.__structBtn("ER 图|ER diagram")')
  const erOpen = await waitFor(cdp,
    '(() => { const i = JSON.parse(window.__erInfo()); return i.nodes > 0 || i.empty > 0 || i.err.length > 0 })()',
    'ER 弹层没打开/没内容', 20000)
  const erInfo = await cdp.jeval('window.__erInfo()')
  check('C1 ER 图弹层打开且渲染出节点（sqlite 无外键时仍画表）', erOpen && erInfo.nodes >= 2,
    { ret: erClick, info: erInfo })
  check('C1 无外键时有说明文案（不是空白图）',
    erInfo.nodes >= 2 ? /外键|foreign key/i.test(erInfo.note) : true, erInfo.note)
  await shot('01-er-graph.png')
  const erClose = await cdp.eval('window.__closeModal(".db-er-modal")')
  const erGone = await waitFor(cdp, 'window.__all(".db-er-modal").length === 0', 'ER 弹层关闭后仍可见', 8000)
  check('C1 关闭后 ER 弹层不可见（antd 隐藏节点允许留在 DOM）', erGone,
    { close: erClose, raw: await cdp.eval('window.__q(".db-er-modal")') })

  // ---- C2 结构对比 ----
  const sdClick = await cdp.eval('window.__structBtn("结构对比|Compare structure")')
  const sdOpen = await waitFor(cdp, 'window.__q(".db-struct-diff-modal .db-diff-select") === 2',
    '结构对比弹层没打开', 10000)
  const sdBefore = await cdp.jeval('window.__diffInfo()')
  check('C2 结构对比弹层打开、A/B 两个选择器都在（A 预填当前表）',
    sdOpen && sdBefore.selects === 2, { ret: sdClick, info: sdBefore })
  await shot('02-struct-diff-open.png')
  // 弹层有 0.3s 的位移动画：动画中量到的坐标点下去会落到别处（实测 B 侧选择器一直没生效）
  await sleep(900)

  // 点第二个 Select（B 侧）→ 选 orders_copy
  const pick = await cdp.jeval(`(() => {
    const sels = [...document.querySelectorAll('.db-struct-diff-modal .db-diff-select')]
    const b = sels[1]
    if (!b) return JSON.stringify({ error: 'no-target-select' })
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  if (pick.error) {
    check('C2 能选中第二张表（B 侧下拉）', false, pick)
  } else {
    await cdp.click(pick.x, pick.y)
    const ddOpen = await waitFor(cdp,
      "document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').length >= 2",
      'B 侧下拉没展开', 6000)
    // 选项用 DOM click：下拉是 portal 到 body 的浮层，坐标点击偶发落在动画中的旧位置；
    // 选中本身仍是 antd Select 的原生 onClick，不是绕过组件改 state
    const optRet = await cdp.eval(`(() => {
      const opts = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
      const o = opts.find(x => /orders_copy/.test(x.textContent || ''))
      if (!o) return 'no-option:' + opts.map(x => x.textContent.trim()).join(',')
      o.click()
      return 'ok'
    })()`)
    if (optRet !== 'ok') {
      check('C2 能选中第二张表（B 侧下拉）', false, { ddOpen, optRet })
    } else {
      const sdDiff = await waitFor(cdp,
        '(() => { const i = JSON.parse(window.__diffInfo()); return i.summary.length > 0 })()',
        '对比结果区没渲染', 20000)
      const sdInfo = await cdp.jeval('window.__diffInfo()')
      check('C2 选 B=orders_copy 后对比结果渲染（removed/changed/equal 任一）',
        sdDiff && (sdInfo.removed + sdInfo.added + sdInfo.changed) > 0,
        { ddOpen, optRet, info: sdInfo })
      // 夹具口径（writeFixture）：
      //   orders      = id, amount integer, created_at text
      //   orders_copy = id, amount text,    note text
      //   → created_at 仅在 A；note 仅在 B；amount 类型 integer→text 算「有差异」
      const nOf = (s, re) => {
        const m = String(s || '').match(re)
        return m ? Number(m[m.length - 1]) : -1
      }
      check('C2 summary「仅在 A」=1（orders 的 created_at 在 B 里没有）',
        nOf(sdInfo.counts.removed, /(?:仅在 A|only in A)\s*(\d+)/) === 1 && sdInfo.removed === 1,
        { count: sdInfo.counts.removed, rows: sdInfo.removed, summary: sdInfo.summary })
      check('C2 差异定位到 created_at（仅在 A 的行文本命中该列名）',
        /(?:^|\n)created_at(?:$|\n)/.test(sdInfo.removedText) && sdInfo.removed >= 1,
        sdInfo.removedText)
      check('C2 summary「仅在 B」=1，且 added 行渲染出 note（added 分支）',
        nOf(sdInfo.counts.added, /(?:仅在 B|only in B)\s*(\d+)/) === 1 &&
        sdInfo.added === 1 && /(?:^|\n)note(?:$|\n)/.test(sdInfo.addedText),
        { count: sdInfo.counts.added, rows: sdInfo.added, text: sdInfo.addedText })
      check('C2 summary「有差异」=1，且 changed 行是 amount 的 INTEGER → TEXT（changed 分支）',
        nOf(sdInfo.counts.changed, /(?:有差异|changed)\s*(\d+)/) === 1 &&
        sdInfo.changed === 1 &&
        /(?:^|\n)amount(?:$|\n)/.test(sdInfo.changedText) &&
        /INTEGER[\s\S]*TEXT/.test(sdInfo.changedText),
        { count: sdInfo.counts.changed, rows: sdInfo.changed, text: sdInfo.changedText })
      await shot('03-struct-diff-result.png')
      const sdClose = await cdp.eval('window.__closeModal(".db-struct-diff-modal")')
      const sdGone = await waitFor(cdp, 'window.__all(".db-struct-diff-modal").length === 0',
        '结构对比弹层关闭后仍可见', 8000)
      check('C2 关闭后结构对比弹层不可见', sdGone,
        { close: sdClose, raw: await cdp.eval('window.__q(".db-struct-diff-modal")') })
    }
  }

  // ---- C3 值面板 ----
  await cdp.eval('window.__tabN(0)')
  await sleep(500)
  const cell = await cdp.jeval('window.__cellXY("amount", 0)')
  let paneOK = false
  let paneInfo = { n: 0 }
  if (!cell.error && cell.inView !== false) {
    await cdp.click(cell.x, cell.y)
    paneOK = await waitFor(cdp, 'window.__all(".db-value-pane").length > 0', '值面板没出现', 8000)
    paneInfo = await cdp.jeval('window.__paneInfo()')
  }
  check('C3 单击数据页单元格弹出值面板，且显示该格内容',
    paneOK && /amount/.test(paneInfo.title) && /100/.test(paneInfo.text),
    { cell, info: paneInfo })
  await shot('04-value-pane.png')
  const paneClose = await cdp.eval('window.__closePane()')
  const paneGone = await waitFor(cdp, 'window.__all(".db-value-pane").length === 0', '值面板关闭后仍可见', 8000)
  check('C3 关闭后值面板不残留', paneGone, { close: paneClose, info: await cdp.jeval('window.__paneInfo()') })

  // =====================================================================
  // A. #28 SQL 文件打开 / 保存
  // =====================================================================
  await cdp.eval('window.__tabN(1)')
  const editorOK = await waitFor(cdp, '!![...document.querySelectorAll(".db-sql-area .cm-content")].find(window.__vis)',
    'SQL 编辑器没就绪', 15000)
  check('A0 SQL 页签编辑器就绪', editorOK, await cdp.eval('window.__tabLabel(1)'))
  if (!editorOK) return finish()

  // A1 未绑定文件 + 保存 → saveDialog 分支 → withSqlExt 补 .sql
  const unboundText = 'select 42 as answer;'
  const typed = await setSql(cdp, unboundText)
  check('A1 未绑定文件时编辑器可写入（脏草稿）', typed.ok, typed)
  // 未绑定路径 → 走 saveDialog 分支；把桩指到一个**没有扩展名**的新路径，顺带验 withSqlExt
  await setDialogStub(mainCdp, { open: [], save: UNBOUND })
  const saveClick = await cdp.eval('window.__btnRe(".db-sql-bar button", "保存|save")')
  const createdFile = await waitFile(UNBOUND + '.sql', unboundText, 8000)
  check('A1 未绑定文件点保存 → 弹 saveDialog 并新建文件（自动补 .sql）',
    createdFile.ok,
    { ret: saveClick, file: UNBOUND + '.sql', got: createdFile.text })
  const plainLabel = await waitFor(cdp, 'window.__tabLabel(1) === "plain.sql"', '页签没变成 plain.sql', 8000)
  check('A1 保存后页签变成文件名（无 •）', plainLabel, await cdp.eval('window.__tabLabel(1)'))

  // A2 打开预置 q.sql
  await setDialogStub(mainCdp, { open: [Q_SQL], save: UNBOUND })
  const openClick = await cdp.eval('window.__btnRe(".db-sql-bar button", "打开|open")')
  const opened = await waitFor(cdp,
    'window.__sqlDoc().indexOf("n11b-sql-file-marker") >= 0', '编辑器里没出现 q.sql 内容', 12000)
  check('A2 打开 q.sql 后编辑器出现文件内容', opened,
    { ret: openClick, doc: await cdp.eval('window.__sqlDoc()') })
  check('A2 页签标题变成 q.sql（sqlFileTabLabel）',
    (await cdp.eval('window.__tabLabel(1)')) === 'q.sql', await cdp.eval('window.__tabLabel(1)'))

  // A3 脏标记
  const dirtyText = Q_TEXT + DIRTY_TAIL
  const typed2 = await setSql(cdp, dirtyText)
  const dirtySeen = await waitFor(cdp, 'window.__tabLabel(1).indexOf("•") >= 0', '脏标记 • 没出现', 8000)
  check('A3 编辑器改动后页签出现 •（sqlFileDirty）', typed2.ok && dirtySeen,
    { tab: await cdp.eval('window.__tabLabel(1)') })
  await shot('05-sql-file-dirty.png')

  // A4 保存 → 磁盘内容 == 编辑器内容
  const save2 = await cdp.eval('window.__btnRe(".db-sql-bar button", "保存|save")')
  const savedFile = await waitFile(Q_SQL, dirtyText, 8000)
  check('A4 保存后磁盘 q.sql == 编辑器内容（硬判据）', savedFile.ok,
    { ret: save2, diskLen: savedFile.text === null ? null : savedFile.text.length, expLen: dirtyText.length })
  const cleanLabel = await waitFor(cdp, 'window.__tabLabel(1).indexOf("•") < 0', '保存后 • 没消失', 8000)
  check('A4 保存成功后 • 消失', cleanLabel, await cdp.eval('window.__tabLabel(1)'))
  await shot('06-sql-file-saved.png')

  // =====================================================================
  // B. #29 掉线重连 / 初次失败重试
  // =====================================================================
  await cdp.eval('window.__tabN(0)')
  await sleep(400)
  const rowsBefore = await cdp.eval('window.__dataRows()')
  const expRows = Number(rowsBefore) || 4
  fs.copyFileSync(DB, DB_BAK)
  try { fs.unlinkSync(DB) } catch (e) {}
  try { fs.unlinkSync(DB + '-wal') } catch (e) {}
  try { fs.unlinkSync(DB + '-shm') } catch (e) {}
  // B0：只删文件（保持句柄）——记录真实行为，不当判据
  const refresh1 = await cdp.eval('window.__headRefresh()')
  await sleep(2500)
  const afterUnlink = await cdp.jeval('window.__banner()')
  skip('B0 仅删库文件后刷新（句柄仍缓存，预期不报错）',
    'ret=' + refresh1 + ' banner=' + afterUnlink.n + ' rows=' + afterUnlink.rows)

  // B1：显式断连（closeDbTab）→ 刷新失败 → 横幅
  await cdp.eval(`(async () => { await window.pre.runGlobalAsync('closeDbTab', ${J(tabId)}) })()`)
  await sleep(300)
  const refresh2 = await cdp.eval('window.__headRefresh()')
  const bannerUp = await waitFor(cdp, 'window.__all(".db-conn-fail-banner").length > 0',
    '掉线后没有出现错误横幅', 15000)
  const bInfo = await cdp.jeval('window.__banner()')
  check('B1 连接失效后刷新 → 出现掉线横幅（onOpError 识别连接类错误）', bannerUp,
    { ret: refresh2, info: bInfo })
  check('B1 横幅期间页面没有白屏（数据页签与网格仍在）',
    bInfo.tabs > 0 && bInfo.grid > 0 && bInfo.rows >= expRows,
    { rowsBefore, info: bInfo })
  check('B1 顶栏状态灯变成 err', /err/.test(String(bInfo.headDot)), bInfo.headDot)
  await shot('07-conn-lost-banner.png')

  // 恢复文件 → 点横幅重连
  fs.copyFileSync(DB_BAK, DB)
  const recon = await cdp.eval('window.__bannerReconnect()')
  const bannerDown = await waitFor(cdp, 'window.__all(".db-conn-fail-banner").length === 0',
    '重连后横幅没消失', 30000)
  check('B1 恢复文件后点横幅「重连」→ 横幅消失', bannerDown, { ret: recon, info: await cdp.jeval('window.__banner()') })
  const refresh3 = await cdp.eval('window.__headRefresh()')
  const rowsBack = await waitFor(cdp, `window.__dataRows() >= ${expRows}`, '重连后取数没恢复', 15000)
  check('B1 重连后刷新元数据成功、网格仍可读', rowsBack,
    { ret: refresh3, rows: await cdp.eval('window.__dataRows()'), dot: await cdp.eval('window.__headDot()') })
  await shot('08-reconnected.png')

  // B2：初次建连失败 → 失败卡片 → 补文件 → 重试
  const tabErr = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'dlg-missing',
      dbType: 'sqlite', dbFile: ${J(MISSING)}, readOnly: false, production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const cardUp = await waitFor(cdp,
    'window.__all(".db-session-error .db-conn-fail").length > 0', '初次失败卡片没出现', 25000)
  const cardText = await cdp.eval('window.__txtOf(".db-session-error .db-conn-fail")')
  check('B2 库文件不存在 → 呈现连接失败卡片（不是空白页）', cardUp, cardText)
  check('B2 失败卡片带原因与重试按钮',
    /不存在|not exist|unable to open|SQLITE/i.test(cardText) &&
    /重连|reconnect/i.test(cardText), cardText)
  await shot('09-initial-fail.png')

  // ---- B2 反向路径：不补库文件，直接再点一次「重连/重试」 ----
  // 盯的是 doConnect 成功分支里新加的 setError('')：失败分支必须原样保留错误态，
  // 不能出现「点一下卡片就消失、界面变空」这种过度清理。
  const markBefore = await ipcMark(mainCdp)
  const retryAgain = await cdp.eval(
    'window.__btnRe(".db-session-error .db-conn-fail-actions button", "重连|reconnect|重试|retry")')
  // 失败重试没有 loading 态可等：先等主进程侧真的收到 openDbTab 调用（拿不到计数桩时退化为定长等待），
  // 再留 1.5s 让 reject 传回渲染层落成 setError。
  let retryAttempts = -1
  if (ipcTap === 'ok' || ipcTap === 'already') {
    for (let i = 0; i < 48; i++) {
      const names = await ipcSince(mainCdp, markBefore)
      retryAttempts = names.filter(n => n === 'openDbTab').length
      if (retryAttempts > 0) break
      await sleep(250)
    }
  }
  await sleep(1500)
  const stillCard = await cdp.eval('window.__all(".db-session-error").length')
  const stillText = await cdp.eval('window.__txtOf(".db-session-error .db-conn-fail")')
  const stillPage = await cdp.jeval(`(() => JSON.stringify({
    wrap: window.__q('.db-session-wrap'),
    fail: window.__q('.db-session-error .db-conn-fail'),
    head: window.__q('.db-session-error .db-conn-fail-head'),
    raw: window.__q('.db-session-error .db-conn-fail-raw'),
    retryBtn: window.__q('.db-session-error .db-conn-fail-actions button'),
    containerKids: (document.getElementById('container') || { children: [] }).children.length
  }))()`)
  check('B2 反向：不补文件再点「重连/重试」→ 失败卡片仍在（stillCard === 1）',
    retryAgain === 'ok' && stillCard === 1,
    { ret: retryAgain, stillCard, openDbTabCalls: retryAttempts })
  check('B2 反向：卡片原因仍是「SQLite 数据库文件不存在」（错误态没被提前清掉）',
    /SQLite 数据库文件不存在|SQLite database file .*not exist/i.test(stillText) &&
    /库文件打不开|database file cannot be opened/i.test(stillText),
    stillText)
  check('B2 反向：重试失败后页面没有白屏（卡片三行 + 原因 + 按钮 + 挂载点都在）',
    stillPage.fail >= 1 && stillPage.head >= 1 && stillPage.raw >= 1 &&
    stillPage.retryBtn >= 1 && stillPage.containerKids > 0,
    stillPage)
  await shot('09b-retry-still-fail.png')

  makeMissingDb()
  const retryClick = await cdp.eval(
    'window.__btnRe(".db-session-error .db-conn-fail-actions button", "重连|reconnect|重试|retry")')
  const recovered = await waitFor(cdp, 'window.__all(".db-session-error").length === 0',
    '重试后仍停留在失败卡片（30s）', 30000)
  // 卡片没消失时再补一刀：直接问主进程这个 tab 的连接在不在。
  // 在 → 说明重连其实成功了，只是 UI 被 error 状态钉住；不在 → 重连本身失败。
  // （这个诊断分支正是当初发现「连接已恢复、卡片不消失」用的；setError('') 补上后
  // 正向路径已转绿，分支保留是为了下次回归时能一眼分辨是 UI 钉住还是重连真失败。）
  let linkAlive = null
  if (!recovered) {
    linkAlive = await cdp.eval(`(async () => {
      try {
        const meta = await window.pre.runGlobalAsync('dbClientOp', ${J(tabErr)}, 'getMetadata', { hideSystemSchemas: true })
        return 'meta:' + (Array.isArray(meta) ? meta.length : typeof meta)
      } catch (e) {
        return 'err:' + String((e && e.message) || e).slice(0, 120)
      }
    })()`)
  }
  check('B2 补上库文件后点「重连/重试」→ 失败卡片消失、进入正常界面', recovered, {
    ret: retryClick,
    stillCard: await cdp.eval('window.__all(".db-session-error").length'),
    linkAlive,
    head: await cdp.eval('window.__head()'),
    tail: cdp.tail(4)
  })
  await shot('10-after-retry.png')

  // ---- 渲染层异常 ----
  const hard = cdp.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|is not defined|TypeError|uncaught/.test(s)
  })
  check('渲染层没有硬错误（拆分后的组件崩溃会落在这里）', hard.length === 0, hard.slice(0, 6))

  // 清理
  for (const id of [tabId, tabErr]) {
    try { await cdp.eval(`(async () => { await window.store.delTab(${J(id)}) })()`) } catch (e) {}
  }
  return finish()

  function finish () {
    const fail = results.filter(r => !r.ok)
    console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
    if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
    return fail.length
  }
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
