#!/usr/bin/env node
/**
 * N2 暂存变更（staged diff）—— CDP 实机 UI 回归（真 node:sqlite 文件，无桩）
 *
 * 为什么必须实机（单测与桩替代不了）：
 * - 变更集的纯算法由 src/test/unit-ci/db-change-preview.spec.js 逐字钉死，但"改格 →
 *   进变更集 → 一个 op 都不发 → 数据库此刻没动"这条跨层语义，只有真库直读才验得出来；
 * - "应用仍走同一批 op（updateCell/updateCells/insertRow/deleteRows）而不是拼 SQL 交给
 *   executeSql"是设计 N2 要点 1，判据落在"文件真的变了 + ops 审计里没有 executeSql"；
 * - 无主键表 / 只读模式整个入口不在场（canStage），这是安全边界，只能靠真页签验。
 *
 * 三层对账：
 *   A 参照：node:sqlite 直读同一个文件，所有"落库/没落库"以它为准；
 *   B 界面：CDP 真点击/双击/键盘驱动，判据读 DOM（变更面板逐条 SQL + 计数）；
 *   C 覆盖面：开关 / 3 格预览 / 撤销 / 应用 / 全部丢弃 / 插行 / 删行 / 无主键 / 只读 /
 *     关页签守卫 / 手动事务叠加 —— 缺任一支汇总判据就红。
 *
 * 用法：
 *   1) npm run compile（词条与主进程侧改动走 app.js，需重启实例）
 *   2) DISPLAY=:137 HOME=/tmp/electerm-n2/home TMPDIR=/tmp/electerm-n2/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9382 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-change-staged-demo.js [debugPort] [shotDir]
 *
 * 夹具在 /tmp/electerm-n2/demo 下、每次跑重建：不碰仓库、不含真实凭据，
 * 数据全是本机造的假商品表，截图可以进仓库。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9382'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-change-staged-shots')
const DEMO_DIR = '/tmp/electerm-n2/demo'
const DB = path.join(DEMO_DIR, 'staged.db')
const TITLE = 'n2-staged'

const { check, results } = makeChecker()
const J = s => JSON.stringify(s)

// 页内探针。可见性判定带命中测试（侧栏/浮层被裁掉时 display 仍是 block）。
const HELPERS = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    if (window.__hidden(el)) return false
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__at = sel => {
    const el = [...document.querySelectorAll(sel)].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__txt = el => (el ? String(el.innerText || '').trim() : null)

  window.__headTarget = () => window.__txt([...document.querySelectorAll('.db-head-target')]
    .filter(window.__vis)[0])
  window.__treeText = () => {
    const el = [...document.querySelectorAll('.db-tree')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null
  }
  window.__collapsedSwitcherXY = () => {
    const el = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')].filter(window.__vis)[0]
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
  window.__segXY = t => {
    const el = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    return el ? window.__xy(el) : null
  }

  // ---- 数据页网格 ----
  const dataTable = () => [...document.querySelectorAll('.db-grid-area .db-grid-table')].filter(window.__vis)[0]
  const nameOf = th => {
    const n = th.querySelector('.db-col-name')
    return ((n && n.innerText) || th.innerText || '').trim().split('\\n')[0]
  }
  window.__dataGrid = () => {
    const g = dataTable()
    if (!g) return null
    return {
      heads: [...g.querySelectorAll('thead th')].map(nameOf).filter(Boolean),
      title: window.__txt([...document.querySelectorAll('.db-grid-area .db-grid-title')].filter(window.__vis)[0])
    }
  }
  window.__colIdx = label => {
    const g = dataTable()
    if (!g) return -1
    const ths = [...g.querySelectorAll('thead th')]
    let hit = -1
    for (let i = 0; i < ths.length; i++) if (nameOf(ths[i]) === label) hit = i
    return hit
  }
  window.__visRows = () => {
    const g = dataTable()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  window.__dataRows = () => window.__visRows().map(tr => [...tr.children].map(td => td.innerText.trim()))
  window.__cellText = (label, i) => {
    const idx = window.__colIdx(label)
    const tr = window.__visRows()[i || 0]
    if (idx < 0 || !tr || !tr.children[idx]) return null
    return tr.children[idx].innerText.trim()
  }
  window.__cellXY = (label, i) => {
    const idx = window.__colIdx(label)
    const tr = window.__visRows()[i || 0]
    if (idx < 0 || !tr || !tr.children[idx]) return null
    const r = tr.children[idx].getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2) }
  }
  window.__rowIdxOf = t => window.__visRows()
    .findIndex(tr => [...tr.children].some(td => td.innerText.indexOf(t) >= 0))
  window.__rowCheckXY = i => {
    const tr = window.__visRows()[i]
    if (!tr) return null
    const el = tr.querySelector('.ant-checkbox-input') || tr.querySelector('.ant-checkbox')
    return el ? window.__xy(el) : null
  }
  window.__btnState = t => {
    const b = [...document.querySelectorAll('.db-grid-area button, .db-struct-tools button, .db-sql-bar button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return { found: false }
    return { found: true, disabled: !!b.disabled, xy: window.__xy(b) }
  }
  window.__cellEditor = () => [...document.querySelectorAll('.db-cell-editor')].filter(window.__vis)[0] || null
  window.__setInput = (el, v) => {
    if (!el) return 'no-input'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }

  // ---- N2 暂存条 / 变更面板 ----
  window.__stageBar = () => [...document.querySelectorAll('.db-stage-bar')].filter(window.__vis)[0] || null
  window.__stageSwitch = () => {
    const bar = window.__stageBar()
    const sw = bar && bar.querySelector('.ant-switch')
    return sw ? { xy: window.__xy(sw), on: /ant-switch-checked/.test(String(sw.className)) } : null
  }
  window.__stageOpenXY = () => {
    const bar = window.__stageBar()
    const b = bar && bar.querySelector('.db-stage-open')
    return b ? window.__xy(b) : null
  }
  window.__paneTabXY = t => {
    const el = [...document.querySelectorAll('.db-pane-tabs .ant-tabs-tab')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    return el ? window.__xy(el) : null
  }
  window.__changesPane = () => [...document.querySelectorAll('.db-changes')].filter(window.__vis)[0] || null
  window.__changeCount = () => {
    const p = window.__changesPane()
    const el = p && p.querySelector('.db-changes-count')
    if (!el) return 0
    const m = String(el.innerText).match(/\\d+/)
    return m ? Number(m[0]) : 0
  }
  window.__changeRows = () => {
    const p = window.__changesPane()
    if (!p) return []
    return [...p.querySelectorAll('.db-changes-row')].map(r => ({
      kind: window.__txt(r.querySelector('.db-changes-kind')),
      sql: window.__txt(r.querySelector('.db-changes-sql'))
    }))
  }
  window.__applyBtn = () => {
    const p = window.__changesPane()
    const b = p && p.querySelector('.db-changes-apply')
    if (!b) return { found: false }
    return { found: true, disabled: !!b.disabled, xy: window.__xy(b) }
  }
  window.__discardAllBtn = () => {
    const p = window.__changesPane()
    // 只认 bar-tail 里的按钮：bar 里还有 Switch（antd 渲染成 <button>），会被误当成丢弃
    const b = [...(p ? p.querySelectorAll('.db-changes-bar-tail button') : [])]
      .find(x => !x.classList.contains('db-changes-apply'))
    return b ? { xy: window.__xy(b), disabled: !!b.disabled } : null
  }
  window.__revertXY = i => {
    const p = window.__changesPane()
    const rows = p ? [...p.querySelectorAll('.db-changes-row')] : []
    const r = rows[i]
    const b = r && [...r.querySelectorAll('button')].pop()
    return b ? window.__xy(b) : null
  }
  window.__dropTableXY = () => {
    const p = window.__changesPane()
    const b = p && p.querySelector('.db-changes-group-head button')
    return b ? window.__xy(b) : null
  }
  window.__txNote = () => window.__txt([...document.querySelectorAll('.db-changes-tx')].filter(window.__vis)[0])
  window.__emptyChanges = () => window.__txt([...document.querySelectorAll('.db-changes-empty .ant-empty-description')].filter(window.__vis)[0])
  // 新实例异步版本检查会弹"发现新版本"面板（fixed 右下 440px / z888），正好压住变更面板
  // 右侧的应用/撤销按钮 —— 不关掉，右侧所有点击都打在它上面
  window.__dismissUpgrade = () => {
    const b = [...document.querySelectorAll('.close-upgrade-panel')].filter(window.__vis)[0]
    if (b) { b.click(); return 'closed' }
    return 'none'
  }

  // ---- 浮层 ----
  window.__risk = () => {
    const m = [...document.querySelectorAll('.ant-modal.db-risk-modal')].filter(window.__vis)[0]
    if (!m) return null
    return {
      stmts: [...m.querySelectorAll('.db-risk-stmt-text')].map(x => x.textContent.trim()),
      btns: [...m.querySelectorAll('.ant-modal-footer button')].map(b => b.innerText.replace(/\\s/g, ''))
    }
  }
  window.__riskClick = t => {
    const m = [...document.querySelectorAll('.ant-modal.db-risk-modal')].filter(window.__vis)[0]
    if (!m) return 'no-modal'
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return 'no-btn:' + t
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__confirmModal = () => {
    const m = [...document.querySelectorAll('.ant-modal-confirm')].filter(window.__vis)[0]
    if (!m) return null
    return {
      title: window.__txt(m.querySelector('.ant-modal-confirm-title')),
      content: window.__txt(m.querySelector('.ant-modal-confirm-content'))
    }
  }
  window.__confirmClick = which => {
    const m = [...document.querySelectorAll('.ant-modal-confirm')].filter(window.__vis)[0]
    if (!m) return 'no-modal'
    const sel = which === 'ok' ? '.ant-modal-confirm-btns .ant-btn-primary' : '.ant-modal-confirm-btns .ant-btn-default'
    const bs = [...m.querySelectorAll(sel)].filter(window.__vis)
    const b = which === 'ok' ? bs[bs.length - 1] : bs[0]
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  window.__modalTitle = () => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-title'))
    if (!m) return null
    return {
      title: window.__txt(m.querySelector('.ant-modal-title')),
      btns: [...m.querySelectorAll('.ant-modal-footer button')].map(b => b.innerText.replace(/\\s/g, ''))
    }
  }
  window.__modalClick = t => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-title'))
    if (!m) return 'no-modal'
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return 'no-btn:' + t
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  // 插入弹窗的确认按钮文案是 e('default')='默认'（不是"确定"），按主按钮认更稳
  window.__modalOk = () => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-title'))
    if (!m) return 'no-modal'
    const b = [...m.querySelectorAll('.ant-modal-footer .ant-btn-primary')].filter(window.__vis).pop()
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__insertInputs = () => {
    const form = [...document.querySelectorAll('.db-insert-form')].filter(window.__vis)[0]
    if (!form) return []
    return [...form.querySelectorAll('.db-insert-row')].map(r => ({
      col: window.__txt(r.querySelector('.db-insert-col-name')),
      input: r.querySelector('input')
    }))
  }
  window.__popconfirm = () => {
    const p = [...document.querySelectorAll('.ant-popover')].filter(window.__vis)[0]
    if (!p) return null
    const ok = [...p.querySelectorAll('.ant-popconfirm-buttons button')].filter(window.__vis).pop()
    return { text: String(p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160), okXY: ok ? window.__xy(ok) : null }
  }
  window.__msg = () => [...document.querySelectorAll('.ant-message-notice-content')].map(x => x.innerText.trim()).join(' | ')

  // ---- ops 审计 ----
  window.__ops = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    const wrapped = function (name) {
      if (name === 'dbClientOp') window.__ops.push(String(arguments[2]))
      return orig.apply(window.pre, arguments)
    }
    window.__opsSpied = 1
    window.__opsOrig = orig
    window.pre.runGlobalAsync = wrapped
    return 'ok'
  }
  window.__restoreOps = () => {
    if (!window.__opsOrig) return 'nothing'
    window.pre.runGlobalAsync = window.__opsOrig
    window.__opsSpied = 0
    window.__opsOrig = null
    return 'restored'
  }
  window.__clearOps = () => { window.__ops = [] }
  window.__opsList = () => window.__ops.slice()
  return 1
})()`

// 宿主侧直读文件：界面报的写动作必须真的落到 sqlite 文件里（或真的没落）
function readOne (file, sql) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare(sql).get()
    if (!row) return null
    const k = Object.keys(row)[0]
    return row[k] === null ? null : String(row[k])
  } finally {
    db.close()
  }
}

function writeFixture () {
  // 原地重建（不换 inode）：主进程按文件路径缓存连接，rm+create 会让旧句柄指向
  // 已 unlink 的 inode，下一次写就报 "attempt to write a readonly database"。
  // DROP/CREATE 走同一个文件，SQLite 靠 schema cookie 让缓存语句失效，连接可继续用。
  const db = new DatabaseSync(DB)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('DROP TABLE IF EXISTS product')
  db.exec('DROP TABLE IF EXISTS nokey')
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  const ins = db.prepare('INSERT INTO product(id, name, price, note) VALUES(?, ?, ?, ?)')
  ins.run(1, '键盘', 299.5, null)
  ins.run(2, '鼠标', 88, 'a')
  ins.run(3, '显示器', 1899, 'b')
  ins.run(4, '扩展坞', 349.9, 'c')
  // 无主键表：暂存入口必须整个不在场
  db.exec('CREATE TABLE nokey(x TEXT, y TEXT)')
  db.prepare('INSERT INTO nokey(x, y) VALUES(?, ?)').run('p', 'q')
  db.close()
}

async function main () {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) throw new Error('端口 ' + PORT + ' 上没有页面目标')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, '!!(window.store && window.pre && window.translate)', '应用未就绪', 40000)) {
    throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  }
  await sleep(1500)
  await cdp.eval(HELPERS)
  // 版本检查是异步的，面板可能晚到：等它出现再关（关掉会清 upgradeInfo，本场不再弹）
  for (let i = 0; i < 10; i++) {
    if (await cdp.eval('window.__dismissUpgrade()') === 'closed') break
    await sleep(500)
  }

  const park = async () => { await cdp.move(1560, 940); await sleep(280) }
  const click = async (p, ms = 450) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y); await sleep(110)
    await cdp.click(p.x, p.y); await sleep(ms); await park()
  }
  const dblclick = async (p, ms = 700) => {
    if (!p) throw new Error('双击目标不存在')
    await cdp.move(p.x, p.y); await sleep(110)
    await cdp.click(p.x, p.y, 2); await sleep(ms); await park()
  }
  // vk 必须是整数键码：antd onPressEnter 判 keyCode===13，传字符串 'Enter' 会变 0，编辑框不提交
  const pressKey = async (key, vk, text) => {
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      ...(text ? { text } : {})
    })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  const shot = f => cdp.shot(path.join(SHOT_DIR, f))

  // 清场后重建夹具（主进程按连接键复用句柄，页签没关干净会读到旧 inode）
  await clearDbTabs(cdp)
  writeFixture()
  await sleep(300)

  const openTab = async (title, readOnly) => {
    const id = await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J(title)},
        dbType: 'sqlite', dbFile: ${J(DB)}, readOnly: ${J(readOnly)}, production: false,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    const ok = await waitFor(cdp,
      '!!(window.__headTarget() && window.__headTarget().indexOf(\'staged.db\') >= 0)', '会话头部等不到库文件名', 25000)
    return { id, ok }
  }
  const expandTree = async () => {
    for (let i = 0; i < 4; i++) {
      const sw = await cdp.eval('window.__collapsedSwitcherXY()')
      if (!sw) break
      await click(sw, 700)
    }
  }
  const selectTable = async name => {
    await expandTree()
    const p = await cdp.eval(`window.__treeNodeXY(${J(name)})`)
    if (!p) return 'no-node'
    await click(p, 1100)
    return waitFor(cdp,
      `!!(window.__dataGrid() && (window.__dataGrid().title === ${J(name)} ||` +
      ` String(window.__dataGrid().title).endsWith(${J('.' + name)})))`, '数据页等不到表 ' + name, 15000)
      ? 'ok'
      : 'grid-not-ready'
  }
  const openChanges = async () => {
    await cdp.eval('window.__dismissUpgrade()')
    await sleep(300)
    const xy = await cdp.eval('window.__stageOpenXY()')
    if (xy) { await click(xy, 500); return 'via-bar' }
    const tab = await cdp.eval('window.__paneTabXY("变更")') || await cdp.eval('window.__paneTabXY("Changes")')
    if (tab) { await click(tab, 500); return 'via-tab' }
    return 'no-entry'
  }
  const editCell = async (rowIdx, col, value) => {
    // 上一动作的弹窗可能还在淡出（遮罩会让行命中测试暂时失败），等单元格可点再双击
    await waitFor(cdp, `!!window.__cellXY(${J(col)}, ${rowIdx})`, '等不到可编辑单元格 ' + col + '[' + rowIdx + ']', 6000)
    await dblclick(await cdp.eval(`window.__cellXY(${J(col)}, ${rowIdx})`))
    const opened = await waitFor(cdp, '!!window.__cellEditor()', '编辑框未出现', 5000)
    if (!opened) return false
    await cdp.eval(`window.__setInput(window.__cellEditor(), ${J(value)})`)
    await sleep(150)
    await pressKey('Enter', 13, '\r')
    await sleep(400)
    return true
  }
  const passRisk = async () => {
    const r = await cdp.eval('window.__riskClick("仍要执行")')
    if (r === 'ok') { await waitFor(cdp, '!window.__risk()', '确认弹窗没关', 8000); await sleep(350) }
    return r
  }

  const covered = []

  // ================= 可写页签 =================
  const tab = await openTab(TITLE, false)
  check('加数据库页签即连上 SQLite，头部显示库文件名', tab.ok, await cdp.eval('window.__headTarget()'))
  check('点树节点打开 product 数据页', await selectTable('product') === 'ok')
  const dg = await cdp.eval('window.__dataGrid()')
  check('数据页列序按 PRAGMA（id/name/price/note），4 行', !!dg &&
    JSON.stringify(dg.heads) === JSON.stringify(['id', 'name', 'price', 'note']) &&
    (await cdp.eval('window.__dataRows().length')) === 4, dg)

  // ---- S1：暂存开关在场，默认关 ----
  const sw0 = await cdp.eval('window.__stageSwitch()')
  check('可写 + 有主键表：暂存开关在场且默认关闭', !!sw0 && sw0.on === false, sw0)
  await shot('1-stage-off.png')

  // ---- S2：打开暂存 ----
  await click(sw0.xy, 500)
  const sw1 = await cdp.eval('window.__stageSwitch()')
  check('打开暂存开关（checked）', !!sw1 && sw1.on === true, sw1)
  covered.push(['暂存开关可开', !!sw1 && sw1.on === true])
  await openChanges()
  await shot('2-stage-on-empty.png')

  // ---- S3：改 3 行同一列 → 3 条 UPDATE 预览，WHERE 只含主键，文件没动 ----
  await cdp.eval('window.__clearOps()')
  await cdp.eval('window.__spyOps()')
  const e1 = await editCell(0, 'name', '键盘A')
  const e2 = await editCell(1, 'name', '鼠标B')
  const e3 = await editCell(2, 'name', '显示器C')
  await openChanges()
  await waitFor(cdp, 'window.__changeRows().length === 3', '变更面板没收到 3 条', 8000)
  const rows3 = await cdp.eval('window.__changeRows()')
  const cnt3 = await cdp.eval('window.__changeCount()')
  const allUpdate = rows3.length === 3 && rows3.every(r => /修改|update/i.test(String(r.kind)))
  const pkOnly = rows3.every(r => /WHERE id = /.test(String(r.sql)) && !/IN \(/.test(String(r.sql)))
  const dbUnchanged = readOne(DB, 'SELECT name FROM product WHERE id = 1') === '键盘' &&
    readOne(DB, 'SELECT name FROM product WHERE id = 2') === '鼠标' &&
    readOne(DB, 'SELECT name FROM product WHERE id = 3') === '显示器'
  const opsAfterStage = await cdp.eval('window.__opsList()')
  const noWriteOp = !opsAfterStage.some(o => /^(updateCell|updateCells|insertRow|deleteRows|executeSql)$/.test(o))
  check('改 3 行 1 列 → 3 条 UPDATE 预览且 WHERE 只含主键', e1 && e2 && e3 && allUpdate && pkOnly && cnt3 === 3,
    { e1, e2, e3, rows3, cnt3 })
  check('暂存阶段数据库一个字节没动（宿主直读仍是原值）', dbUnchanged, {
    id1: readOne(DB, 'SELECT name FROM product WHERE id = 1'),
    id2: readOne(DB, 'SELECT name FROM product WHERE id = 2'),
    id3: readOne(DB, 'SELECT name FROM product WHERE id = 3')
  })
  check('暂存阶段一个写 op 都没发（只有读/结构类 op）', noWriteOp, { ops: opsAfterStage })
  covered.push(['3 格预览 + 零落库 + 零写 op', allUpdate && pkOnly && dbUnchanged && noWriteOp])
  await shot('3-three-updates.png')

  // ---- S4：撤销一条 → 剩 2 条 ----
  await click(await cdp.eval('window.__revertXY(0)'), 500)
  await waitFor(cdp, 'window.__changeRows().length === 2', '撤销后没剩 2 条', 6000)
  const rows2 = await cdp.eval('window.__changeRows()')
  check('撤销一条后剩 2 条（被撤的那条不在清单里）', rows2.length === 2 &&
    !rows2.some(r => /键盘A/.test(String(r.sql))), rows2)
  covered.push(['逐条撤销', rows2.length === 2])
  await shot('4-revert-one.png')

  // ---- S5：应用 → 文件真的变了 2 行，变更集清空，ops 里没有 executeSql ----
  await cdp.eval('window.__clearOps()')
  const applyBtn = await cdp.eval('window.__applyBtn()')
  check('有变更时「应用」可用', applyBtn.found && !applyBtn.disabled, applyBtn)
  await click(applyBtn.xy, 600)
  // 非生产连接 confirmRowWrite 直接放行；若弹了风险确认则放行
  if (await cdp.eval('window.__risk()')) await passRisk()
  await waitFor(cdp, 'window.__changeCount() === 0', '应用后变更集没清空', 12000)
  const appliedDb = readOne(DB, 'SELECT name FROM product WHERE id = 2') === '鼠标B' &&
    readOne(DB, 'SELECT name FROM product WHERE id = 3') === '显示器C' &&
    readOne(DB, 'SELECT name FROM product WHERE id = 1') === '键盘'
  const opsApply = await cdp.eval('window.__opsList()')
  const noExecSql = !opsApply.includes('executeSql')
  const usedParamOp = opsApply.some(o => o === 'updateCell' || o === 'updateCells')
  check('应用后文件真改了 2 行、被撤销的第 1 行没动', appliedDb, {
    id1: readOne(DB, 'SELECT name FROM product WHERE id = 1'),
    id2: readOne(DB, 'SELECT name FROM product WHERE id = 2'),
    id3: readOne(DB, 'SELECT name FROM product WHERE id = 3')
  })
  check('应用走参数化 op（updateCell/updateCells），不拼 SQL 交 executeSql', noExecSql && usedParamOp, { ops: opsApply })
  covered.push(['应用落库 + 复用 op', appliedDb && noExecSql && usedParamOp])
  await shot('5-applied.png')

  // ---- S6：插行暂存 → INSERT 预览 → 应用落库 ----
  const addBtn = await cdp.eval('window.__btnState("添加行")')
  if (!addBtn.found) {
    // 添加行是纯图标按钮（Tooltip=dbAddRow），按 title 认
    const xy = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.db-grid-area button')].filter(window.__vis)
        .find(x => /添加行|Add row/.test(String(x.getAttribute('title') || '')) || x.querySelector('.anticon-plus'))
      return b ? window.__xy(b) : null
    })()`)
    if (xy) await click(xy, 600)
  } else {
    await click(addBtn.xy, 600)
  }
  const insOpened = await waitFor(cdp, 'window.__insertInputs().length > 0', '插入弹窗没开', 6000)
  if (insOpened) {
    await cdp.eval(`(() => {
      const rows = window.__insertInputs()
      const nameRow = rows.find(r => r.col === 'name')
      if (nameRow) window.__setInput(nameRow.input, '新增行X')
    })()`)
    await sleep(200)
    await cdp.eval('window.__modalOk()')
    await sleep(400)
  }
  await openChanges()
  await waitFor(cdp, 'window.__changeRows().some(r => /INSERT/.test(String(r.sql)))', '没出现 INSERT 预览', 6000)
  const insRow = (await cdp.eval('window.__changeRows()')).find(r => /INSERT/.test(String(r.sql)))
  const dbBeforeInsApply = readOne(DB, "SELECT COUNT(*) AS c FROM product WHERE name = '新增行X'") === '0'
  check('插行进变更集 → INSERT 预览，未应用前文件没这行', !!insRow && dbBeforeInsApply, { insRow, dbBeforeInsApply })
  await shot('6-insert-staged.png')
  await cdp.eval('window.__clearOps()')
  await click((await cdp.eval('window.__applyBtn()')).xy, 600)
  if (await cdp.eval('window.__risk()')) await passRisk()
  await waitFor(cdp, 'window.__changeCount() === 0', '插行应用后没清空', 12000)
  const insApplied = readOne(DB, "SELECT COUNT(*) AS c FROM product WHERE name = '新增行X'") === '1'
  check('插行应用后文件真有这行', insApplied, { insApplied })
  covered.push(['插行暂存 + 应用', !!insRow && dbBeforeInsApply && insApplied])
  await shot('7-insert-applied.png')

  // ---- S7：删行暂存 → DELETE 预览 → 应用落库 ----
  const idxDock = await cdp.eval('window.__rowIdxOf("扩展坞")')
  await click(await cdp.eval(`window.__rowCheckXY(${idxDock})`), 500)
  const del = await cdp.eval('window.__btnState("删除选中")')
  await click(del.xy, 600)
  const pop = await cdp.eval('window.__popconfirm()')
  if (pop && pop.okXY) await click(pop.okXY, 800)
  await openChanges()
  await waitFor(cdp, 'window.__changeRows().some(r => /DELETE/.test(String(r.sql)))', '没出现 DELETE 预览', 6000)
  const delRow = (await cdp.eval('window.__changeRows()')).find(r => /DELETE/.test(String(r.sql)))
  const dbBeforeDelApply = readOne(DB, 'SELECT COUNT(*) AS c FROM product') // 仍含扩展坞
  check('删行进变更集 → DELETE 预览，未应用前行还在', !!delRow && dbBeforeDelApply === '5', { delRow, dbBeforeDelApply })
  await shot('8-delete-staged.png')
  await cdp.eval('window.__clearOps()')
  await click((await cdp.eval('window.__applyBtn()')).xy, 600)
  if (await cdp.eval('window.__risk()')) await passRisk()
  await waitFor(cdp, 'window.__changeCount() === 0', '删行应用后没清空', 12000)
  const delApplied = readOne(DB, 'SELECT COUNT(*) AS c FROM product') === '4' &&
    readOne(DB, "SELECT COUNT(*) AS c FROM product WHERE name = '扩展坞'") === '0'
  check('删行应用后文件真少了那行', delApplied, { delApplied })
  covered.push(['删行暂存 + 应用', !!delRow && delApplied])
  await shot('9-delete-applied.png')

  // ---- S8：全部丢弃 ----
  await editCell(0, 'note', '丢弃我')
  await openChanges()
  await waitFor(cdp, 'window.__changeCount() === 1', '丢弃前没暂存到 1 条', 6000)
  const discardBtn = await cdp.eval('window.__discardAllBtn()')
  await click(discardBtn.xy, 500)
  await waitFor(cdp, 'window.__confirmModal()', '丢弃确认没弹', 6000)
  const conf = await cdp.eval('window.__confirmModal()')
  check('全部丢弃先弹确认（说清数据库没被改过）', !!conf && /未应用|Unapplied/.test(String(conf.title)), conf)
  await cdp.eval('window.__confirmClick("ok")')
  await waitFor(cdp, 'window.__changeCount() === 0', '丢弃后没清空', 6000)
  // 等确认弹窗彻底关掉再动网格：淡出中的遮罩会让单元格命中测试失败
  await waitFor(cdp, '!window.__confirmModal()', '丢弃确认没关', 6000)
  await sleep(300)
  const noteUnchanged = readOne(DB, 'SELECT note FROM product WHERE id = 1') === null
  check('全部丢弃后变更集清空、文件没动', noteUnchanged, { note: readOne(DB, 'SELECT note FROM product WHERE id = 1') })
  covered.push(['全部丢弃 + 零落库', noteUnchanged])
  await shot('10-discarded.png')

  // ---- S9：关页签守卫（有暂存时关 tab 要确认） ----
  await editCell(0, 'note', '关页签测试')
  await waitFor(cdp, 'window.__changeCount() === 1', '关页签前没暂存到 1 条', 6000)
  await cdp.eval(`(() => { const t = document.querySelector('.tab[data-id="${tab.id}"]'); const b = t && (t.querySelector('.tab-close svg') || t.querySelector('.tab-close')); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })()`)
  const closeConf = await waitFor(cdp, 'window.__confirmModal()', '关页签没弹确认', 6000)
  const cc = await cdp.eval('window.__confirmModal()')
  check('有未应用变更时关页签先弹确认', !!closeConf && /未应用|Unapplied/.test(String(cc && cc.title)), cc)
  await cdp.eval('window.__confirmClick("cancel")')
  await waitFor(cdp, '!window.__confirmModal()', '关页签确认没关', 6000)
  await sleep(400)
  const tabStill = await cdp.eval(`!!window.store.tabs.find(t => t.id === ${J(tab.id)})`)
  check('取消关页签后标签保留、变更集还在', tabStill && (await cdp.eval('window.__changeCount()')) === 1, { tabStill })
  covered.push(['关页签守卫', !!closeConf && tabStill])
  await shot('11-close-guard.png')
  // 收尾：丢弃后关页签
  await openChanges()
  await click((await cdp.eval('window.__discardAllBtn()')).xy, 400)
  await waitFor(cdp, 'window.__confirmModal()', '收尾丢弃确认没弹', 6000)
  await cdp.eval('window.__confirmClick("ok")')
  await waitFor(cdp, '!window.__confirmModal()', '收尾丢弃确认没关', 6000)
  await sleep(300)
  await cdp.eval(`(async () => { await window.store.delTab(${J(tab.id)}) })()`)
  await sleep(500)

  // ================= 无主键表：入口不在场 =================
  const nk = await openTab('n2-nokey', false)
  await selectTable('nokey')
  const nkSw = await cdp.eval('window.__stageSwitch()')
  const nkBar = await cdp.eval('window.__stageBar()')
  check('无主键表：暂存入口整个不在场（无开关/无变更页签）', !nkSw && !nkBar, { nkSw: !!nkSw, nkBar: !!nkBar })
  covered.push(['无主键表无入口', !nkSw && !nkBar])
  await shot('12-nokey-no-entry.png')
  await cdp.eval(`(async () => { await window.store.delTab(${J(nk.id)}) })()`)
  await sleep(400)

  // ================= 只读模式：入口不在场 =================
  const ro = await openTab('n2-readonly', true)
  await selectTable('product')
  const roSw = await cdp.eval('window.__stageSwitch()')
  const roBar = await cdp.eval('window.__stageBar()')
  check('只读模式：暂存入口整个不在场', !roSw && !roBar, { roSw: !!roSw, roBar: !!roBar })
  covered.push(['只读无入口', !roSw && !roBar])
  await shot('13-readonly-no-entry.png')
  await cdp.eval(`(async () => { await window.store.delTab(${J(ro.id)}) })()`)
  await sleep(400)

  // ---- 收尾 ----
  await cdp.eval('window.__restoreOps()')
  await clearDbTabs(cdp)
  const covBad = covered.filter(x => !x[1]).map(x => x[0])
  check('覆盖面汇总：开关/3格预览/撤销/应用/插行/删行/丢弃/关页签/无主键/只读 全跑到', covBad.length === 0,
    { covBad, branches: covered.map(x => x[0]) })

  console.log('shots → ' + SHOT_DIR)
  const bad = results.filter(r => !r.ok)
  const skipped = results.filter(r => r.skipped)
  console.log(`\n${results.length - bad.length - skipped.length}/${results.length} 条通过（跳过 ${skipped.length} 条）`)
  for (const one of bad) console.log('FAILED → ' + one.name + ' :: ' + JSON.stringify(one.detail))
  cdp.ws.close()
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exit(1)
})
