#!/usr/bin/env node
/**
 * H6c · SQL 查询文件 —— CDP 实机验收（桩数据 + 主进程文件对话框打桩）
 *
 * 设计文档 §2.17 的每一项都在真实渲染层里量：
 *   H6c-1  工具行出现"打开 / 保存"两个按钮，title 走词条
 *   H6c-2  打开 .sql：编辑器载入文件内容，页签显示文件名，完整路径在 title 里，不脏
 *   H6c-3  编辑后页签补 •、保存按钮转 primary（同一份脏信号）
 *   H6c-4  Ctrl/Cmd+S 落盘（编码、内容与编辑器一致），脏标记消失
 *   H6c-5  已绑定文件时点保存不再弹对话框，直接写回原路径
 *   H6c-6  未绑定文件时保存走"另存"对话框；用户没写扩展名时补 .sql
 *   H6c-7  打开新文件时，未保存的草稿先确认（取消 = 什么都不变）
 *   H6c-8  对话框取消（打开返回空）不改编辑器、不报错
 *   H6c-9  有未保存修改时关页签先确认：取消留下，确认才关
 *   H6c-10 双主题下工具行与页签不塌陷
 *
 * 环境（这台机器上 xdg-desktop-portal 的 chooser 是 Wayland 表面，xdotool
 * 驱动不了；所以对话框在**主进程**里打桩，渲染层 → IPC → fs 全程真实）：
 *   1) npm run compile && rsync -a src/app/ work/app/
 *   2) Xvfb :130 -nolisten tcp &
 *   3) DISPLAY=:130 HOME=/tmp/electerm-h1a3/home XDG_CONFIG_HOME=/tmp/electerm-h1a3/config \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9236 --inspect=9240 --no-sandbox --window-size=1600,1000
 *   4) node self-test/db-sql-file-demo.js [debugPort] [shotDir] [inspectPort]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9236'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-file-shots')
const INSPECT = process.argv[4] || '9240'
const SPLIT_KEY = 'electerm-db-sql-value-split'

const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

const FIXTURE = `
(() => {
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      if (name === 'dbGridViewOp') return Promise.resolve(null)
      if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve(null)
    }
    const op = a[1]
    const args = a[2] || {}
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [{ name: 'typed_tbl', type: 'table' }]
      }])
    }
    if (op === 'executeSql') {
      return Promise.resolve({
        results: [{
          sql: args.sql,
          fields: ['id'],
          columns: [{ name: 'id', type: 'int' }],
          rows: [{ id: 1 }]
        }],
        elapsedMs: 5
      })
    }
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__h6cStub = 'stub'
  return 'stub-installed'
})()
`

const PROBE = `
(() => {
  window.__h6cTabs = () => JSON.stringify(
    [...document.querySelectorAll('.db-session-wrap .ant-tabs-tab')].filter(window.__vis).map(t => {
      const span = [...t.querySelectorAll('span[title]')].filter(window.__vis)[0]
      return {
        text: String(t.innerText || '').replace(/\\s+/g, '').trim(),
        title: span ? String(span.getAttribute('title') || '') : '',
        active: /ant-tabs-tab-active/.test(String(t.className)) ? 1 : 0
      }
    })
  )
  window.__h6cClickSqlTab = () => {
    const ts = [...document.querySelectorAll('.db-session-wrap .ant-tabs-tab')].filter(window.__vis)
    if (!ts[1]) return 'no-tab:' + ts.length
    ts[1].click()
    return 'ok'
  }
  window.__h6cBar = () => {
    const bar = [...document.querySelectorAll('.db-sql-bar')].filter(window.__vis)[0]
    if (!bar) return null
    return bar
  }
  window.__h6cBtn = title => {
    const bar = window.__h6cBar()
    if (!bar) return null
    return [...bar.querySelectorAll('button')].filter(window.__vis)
      .find(b => b.getAttribute('title') === title) || null
  }
  window.__h6cClick = title => {
    const b = window.__h6cBtn(title)
    if (!b) return 'no-btn:' + title
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__h6cBtnState = title => {
    const b = window.__h6cBtn(title)
    return b ? (b.className.indexOf('ant-btn-primary') >= 0 ? 'primary' : 'default') : 'missing'
  }
  window.__h6cDoc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return ed ? String(ed.innerText || '') : 'no-editor'
  }
  window.__h6cModal = () => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-confirm-title'))
    if (!m) return JSON.stringify({ exists: 0 })
    const title = m.querySelector('.ant-modal-confirm-title')
    const content = m.querySelector('.ant-modal-confirm-content')
    const btns = [...m.querySelectorAll('.ant-modal-confirm-btns button')].filter(window.__vis)
    return JSON.stringify({
      exists: 1,
      title: title ? String(title.innerText || '').trim() : '',
      content: content ? String(content.innerText || '').trim() : '',
      btns: btns.map(b => ({
        text: String(b.innerText || '').trim(),
        primary: /ant-btn-primary/.test(String(b.className)) ? 1 : 0
      }))
    })
  }
  window.__h6cModalClick = ok => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-confirm-title'))
    if (!m) return 'no-modal'
    const btns = [...m.querySelectorAll('.ant-modal-confirm-btns button')].filter(window.__vis)
    const b = ok
      ? btns.find(x => /ant-btn-primary/.test(String(x.className)))
      : btns.find(x => !/ant-btn-primary/.test(String(x.className)))
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  window.__h6cMessage = () => {
    const els = [...document.querySelectorAll('.ant-message-notice-content')].filter(window.__vis)
    return els.map(e => String(e.innerText || '').trim()).join(' | ')
  }
  return 'probe-ready'
})()
`

const MYSQL_TAB = {
  type: 'database',
  from: 'quick-connect',
  title: 'mysql 127.0.0.1:3306',
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'demo',
  dbPassword: '',
  dbName: 'demo_db',
  dbSsl: false,
  readOnly: false,
  production: false,
  batch: null
}

const ensureStub = async (cdp, tries = 10) => {
  for (let i = 0; i < tries; i++) {
    const alive = await cdp.eval("window.pre && window.pre.__h6cStub === 'stub'")
    if (alive) {
      return true
    }
    await cdp.eval(FIXTURE)
    await sleep(300)
  }
  return false
}

const tabs = async cdp => JSON.parse(await cdp.eval('window.__h6cTabs()'))
const sqlTab = async cdp => (await tabs(cdp))[1] || { text: '', title: '', active: 0 }

const openDbTab = async cdp => {
  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  await cdp.eval(`
    (() => {
      window.store.addTab(${JSON.stringify(MYSQL_TAB)})
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      window.__h6cTabId = t.id
      return t.id
    })()
  `)
  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
  await cdp.eval('window.__h6cClickSqlTab()')
  await sleep(400)
}

const setDialog = async (main, { open, save } = {}) => {
  if (open !== undefined) {
    await main.eval('global.__h6cOpen = ' + (open === null ? 'null' : JSON.stringify(open)))
  }
  if (save !== undefined) {
    await main.eval('global.__h6cSave = ' + (save === null ? 'null' : JSON.stringify(save)))
  }
}
const dialogCounts = async main => JSON.parse(await main.eval(
  'JSON.stringify({ open: global.__h6cOpenCalls || 0, save: global.__h6cSaveCalls || 0 })'
))

const PATHS = {}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-h6c-'))
  PATHS.dir = dir
  PATHS.open = path.join(dir, 'open-me.sql')
  PATHS.second = path.join(dir, 'second.sql')
  PATHS.fresh = path.join(dir, 'fresh-query') // 故意不带扩展名
  fs.writeFileSync(PATHS.open, 'SELECT 42 AS answer;\n-- opened from disk\n')
  fs.writeFileSync(PATHS.second, 'SELECT 7 AS seven;\n')

  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})

  const mt = await getJson(`http://127.0.0.1:${INSPECT}/json`)
  if (!mt || !mt.length) {
    throw new Error('no main-process inspector on ' + INSPECT + '; start the app with --inspect=' + INSPECT)
  }
  const mainCdp = new Cdp(mt[0].webSocketDebuggerUrl)
  await mainCdp.ready
  await mainCdp.call('Runtime.enable')
  const patched = await mainCdp.eval(`(() => {
    try {
      const req = (typeof require === 'function') ? require : global.process.mainModule.require
      const electron = req('electron')
      if (!global.__h6cOrig) {
        global.__h6cOrig = {
          open: electron.dialog.showOpenDialogSync,
          save: electron.dialog.showSaveDialog
        }
      }
      global.__h6cOpen = null
      global.__h6cSave = null
      global.__h6cOpenCalls = 0
      global.__h6cSaveCalls = 0
      electron.dialog.showOpenDialogSync = () => {
        global.__h6cOpenCalls = (global.__h6cOpenCalls || 0) + 1
        return global.__h6cOpen ? [global.__h6cOpen] : undefined
      }
      electron.dialog.showSaveDialog = async () => {
        global.__h6cSaveCalls = (global.__h6cSaveCalls || 0) + 1
        return global.__h6cSave || { canceled: true }
      }
      return 'patched'
    } catch (e) { return 'ERR ' + e.message }
  })()`)
  check('主进程文件对话框打桩成功（渲染层 → IPC → fs 链路保持真实）', patched === 'patched', patched)
  if (patched !== 'patched') {
    throw new Error(patched)
  }

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  check('重启后渲染进程可用',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  check('桩接管 dbClientOp（碰不到本机 3306）', await ensureStub(cdp))
  await cdp.eval(HELPERS)
  await sleep(300)
  const probeRes = await cdp.eval(PROBE)
  check('查询文件探针装上', probeRes === 'probe-ready', { probeRes })

  await clearDbTabs(cdp)
  await openDbTab(cdp)
  const t0 = await tabs(cdp)
  check('H6c-0 三个内层页签就位，SQL 页签初始标题是 SQL',
    t0.length === 3 && /^SQL$/.test(t0[1].text), t0)

  const T_OPEN = await cdp.eval("String(window.translate('dbSqlFileOpen'))")
  const T_SAVE = await cdp.eval("String(window.translate('dbSqlFileSave'))")
  const btns0 = await cdp.eval("JSON.stringify([...window.__h6cBar().querySelectorAll('button')].map(b => b.getAttribute('title') || ''))")
  check('H6c-1 工具行有"打开 / 保存"两个按钮，title 走词条',
    btns0.indexOf(T_OPEN) >= 0 && btns0.indexOf(T_SAVE) >= 0 && T_OPEN.length > 0 && !/[{}]/.test(T_OPEN),
    { T_OPEN, T_SAVE, btns0 })

  // ---------- 打开 ----------
  await setDialog(mainCdp, { open: PATHS.open })
  const c0 = await dialogCounts(mainCdp)
  check('H6c-2a 点"打开"触发一次对话框', await cdp.eval('window.__h6cClick(' + JSON.stringify(T_OPEN) + ')') === 'ok' &&
    await waitFor(cdp, 'window.__h6cDoc().indexOf("opened from disk") >= 0', 'file loaded', 8000),
  { before: c0, after: await dialogCounts(mainCdp) })
  const doc2 = await cdp.eval('window.__h6cDoc()')
  let tab2 = await sqlTab(cdp)
  check('H6c-2b 编辑器载入文件内容（两行都在）',
    doc2.indexOf('42 AS answer') >= 0 && doc2.indexOf('opened from disk') >= 0, { len: doc2.length })
  check('H6c-2c 页签显示文件名，完整路径在 title，未脏',
    tab2.text === 'open-me.sql' && tab2.title === PATHS.open, tab2)
  check('H6c-2d 载入后保存按钮仍是普通态（刚读的文件不脏）',
    await cdp.eval('window.__h6cBtnState(' + JSON.stringify(T_SAVE) + ')') === 'default' &&
    (await dialogCounts(mainCdp)).save === 0)
  await cdp.shot(path.join(SHOT_DIR, '1-dark-file-open.png'))

  // ---------- 编辑 → 脏标记 ----------
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.insertText', { text: ' -- dirty patch' })
  await sleep(300)
  tab2 = await sqlTab(cdp)
  check('H6c-3 编辑后页签补 •，保存按钮转 primary（同一份脏信号）',
    tab2.text === 'open-me.sql•' && await cdp.eval('window.__h6cBtnState(' + JSON.stringify(T_SAVE) + ')') === 'primary',
    { tab: tab2, btn: await cdp.eval('window.__h6cBtnState(' + JSON.stringify(T_SAVE) + ')') })
  await cdp.shot(path.join(SHOT_DIR, '2-dark-dirty.png'))

  // ---------- Ctrl+S 落盘 ----------
  const beforeCtrlS = fs.readFileSync(PATHS.open, 'utf8')
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: 2, windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, key: 's', code: 'KeyS'
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, key: 's', code: 'KeyS'
  })
  const ctrlOk = await waitFor(cdp,
    'window.__h6cTabs() ? JSON.parse(window.__h6cTabs())[1].text === "open-me.sql" : false', 'ctrl+s saved', 6000)
  const afterCtrlS = fs.readFileSync(PATHS.open, 'utf8')
  check('H6c-4 Ctrl+S 写回原文件（内容含刚敲的补丁），页签去脏',
    ctrlOk && afterCtrlS.indexOf('dirty patch') > 0 && afterCtrlS !== beforeCtrlS && afterCtrlS.indexOf('opened from disk') > 0,
    { before: beforeCtrlS.length, after: afterCtrlS.length })

  // ---------- 已绑定文件：保存按钮直接写回 ----------
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.insertText', { text: ' -- via button' })
  await sleep(250)
  const saves0 = (await dialogCounts(mainCdp)).save
  await cdp.eval('window.__h6cClick(' + JSON.stringify(T_SAVE) + ')')
  const btnOk = await waitFor(cdp,
    'window.__h6cTabs() ? JSON.parse(window.__h6cTabs())[1].text === "open-me.sql" : false', 'button saved', 6000)
  const afterBtn = fs.readFileSync(PATHS.open, 'utf8')
  check('H6c-5 已绑定路径点保存：不弹对话框，直接写回',
    btnOk && afterBtn.indexOf('via button') > 0 && (await dialogCounts(mainCdp)).save === saves0,
    { saves0, saves1: (await dialogCounts(mainCdp)).save })

  // ---------- 打开新文件 → 未保存草稿确认 ----------
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.insertText', { text: ' -- draft' })
  await sleep(250)
  await setDialog(mainCdp, { open: PATHS.second })
  const opens0 = (await dialogCounts(mainCdp)).open
  await cdp.eval('window.__h6cClick(' + JSON.stringify(T_OPEN) + ')')
  const modalR = await waitFor(cdp, 'JSON.parse(window.__h6cModal()).exists === 1', 'replace modal', 5000)
  const m1 = JSON.parse(await cdp.eval('window.__h6cModal()'))
  const T_REPLACE = await cdp.eval("String(window.translate('dbSqlFileReplaceTitle'))")
  check('H6c-7a 有未保存草稿时打开新文件先确认，且此时还没弹选择框',
    modalR && m1.title === T_REPLACE && (await dialogCounts(mainCdp)).open === opens0, { m1, opens0 })
  await cdp.eval('window.__h6cModalClick(false)')
  await sleep(500)
  const mAfterCancel = JSON.parse(await cdp.eval('window.__h6cModal()'))
  const docCancel = await cdp.eval('window.__h6cDoc()')
  tab2 = await sqlTab(cdp)
  check('H6c-7b 确认框点取消：编辑器、页签、文件绑定全都不变',
    mAfterCancel.exists === 0 && docCancel.indexOf('via button') >= 0 &&
    docCancel.indexOf('draft') >= 0 && tab2.text === 'open-me.sql•' &&
    fs.readFileSync(PATHS.open, 'utf8').indexOf('draft') < 0, { tab: tab2, m: mAfterCancel })

  await cdp.eval('window.__h6cClick(' + JSON.stringify(T_OPEN) + ')')
  await waitFor(cdp, 'JSON.parse(window.__h6cModal()).exists === 1', 'replace modal 2', 5000)
  await cdp.eval('window.__h6cModalClick(true)')
  const replaced = await waitFor(cdp, 'window.__h6cDoc().indexOf("7 AS seven") >= 0', 'second file loaded', 8000)
  await sleep(300)
  tab2 = await sqlTab(cdp)
  check('H6c-7c 确认后载入新文件：内容换掉、页签换名、不脏',
    replaced && tab2.text === 'second.sql' && tab2.title === PATHS.second, tab2)

  // ---------- 对话框取消 ----------
  await setDialog(mainCdp, { open: null })
  await cdp.eval('window.__h6cClick(' + JSON.stringify(T_OPEN) + ')')
  await sleep(700)
  const docCancel2 = await cdp.eval('window.__h6cDoc()')
  const mNone = JSON.parse(await cdp.eval('window.__h6cModal()'))
  check('H6c-8 选择框被取消（返回空）时编辑器不变、不弹确认、不报错',
    docCancel2.indexOf('7 AS seven') >= 0 && mNone.exists === 0 &&
    !/错误|error/i.test(await cdp.eval('window.__h6cMessage()')),
    { msg: await cdp.eval('window.__h6cMessage()') })

  // ---------- 关页签确认 ----------
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.insertText', { text: ' -- before close' })
  await sleep(250)
  const tabId = await cdp.eval('String(window.__h6cTabId)')
  const T_CLOSE = await cdp.eval("String(window.translate('dbSqlFileCloseTitle'))")
  const openDel = `(() => {
    window.__h6cDel = 'pending'
    window.store.delTab(${JSON.stringify(tabId)})
      .then(r => { window.__h6cDel = String(r) })
      .catch(e => { window.__h6cDel = 'ERR:' + e.message })
    return 'fired'
  })()`
  await cdp.eval(openDel)
  const closeModal = await waitFor(cdp, 'JSON.parse(window.__h6cModal()).exists === 1', 'close modal', 5000)
  const m2 = JSON.parse(await cdp.eval('window.__h6cModal()'))
  check('H6c-9a 脏文件关页签先确认（标题走词条，内容带文件名）',
    closeModal && m2.title === T_CLOSE && m2.content.indexOf('second.sql') >= 0, m2)
  await cdp.eval('window.__h6cModalClick(false)')
  await sleep(600)
  const stillThere = await cdp.eval('window.store.tabs.some(t => t.id === ' + JSON.stringify(tabId) + ')')
  const delRet = await cdp.eval('String(window.__h6cDel)')
  check('H6c-9b 点取消：页签还在，delTab 不往下走（守卫拦下，返回 undefined）',
    stillThere === true && delRet === 'undefined', { stillThere, delRet })
  await cdp.eval(openDel)
  await waitFor(cdp, 'JSON.parse(window.__h6cModal()).exists === 1', 'close modal 2', 5000)
  await cdp.eval('window.__h6cModalClick(true)')
  const gone = await waitFor(cdp,
    'window.store.tabs.some(t => t.id === ' + JSON.stringify(tabId) + ') === false', 'tab closed', 6000)
  check('H6c-9c 点放弃：页签关闭', gone)

  // ---------- 另存：新页签 + 无扩展名 ----------
  await openDbTab(cdp)
  const t3 = await sqlTab(cdp)
  await cdp.eval('window.__focusSql()')
  await cdp.call('Input.insertText', { text: 'SELECT 9 AS nine;' })
  await sleep(300)
  const t3dirty = await sqlTab(cdp)
  check('H6c-6a 未绑定文件时页签保持 SQL、保存按钮不转 primary（没有文件就没有脏的概念）',
    t3.text === 'SQL' && t3dirty.text === 'SQL' &&
    await cdp.eval('window.__h6cBtnState(' + JSON.stringify(T_SAVE) + ')') === 'default', { t3, t3dirty })
  await setDialog(mainCdp, { save: { canceled: false, filePath: PATHS.fresh } })
  const saves1 = (await dialogCounts(mainCdp)).save
  const typedDoc = await cdp.eval('window.__h6cDoc()')
  await cdp.eval('window.__h6cClick(' + JSON.stringify(T_SAVE) + ')')
  const savedFresh = await waitFor(cdp, 'window.__h6cTabs() ? JSON.parse(window.__h6cTabs())[1].text === "fresh-query.sql" : false', 'save-as', 6000)
  const freshFile = PATHS.fresh + '.sql'
  const freshOk = fs.existsSync(freshFile)
  const freshText = freshOk ? fs.readFileSync(freshFile, 'utf8') : ''
  const t4 = await sqlTab(cdp)
  check('H6c-6b 另存时补 .sql 扩展名，内容与编辑器一致',
    savedFresh && freshOk && freshText.indexOf('9 AS nine') >= 0 && typedDoc.indexOf('9 AS nine') >= 0,
    { file: path.basename(freshFile), len: freshText.length })
  check('H6c-6c 另存后页签换成文件名、title 是补过扩展名的完整路径、不脏',
    t4.text === 'fresh-query.sql' && t4.title === freshFile &&
    await cdp.eval('window.__h6cBtnState(' + JSON.stringify(T_SAVE) + ')') === 'default',
    { t4, saves1, saves2: (await dialogCounts(mainCdp)).save })
  await cdp.shot(path.join(SHOT_DIR, '3-dark-save-as.png'))

  // ---------- 双主题 ----------
  const themeBefore = await cdp.eval('String((window.store._config || {}).theme || "")')
  const themeIds = JSON.parse(await cdp.eval(
    'JSON.stringify((window.store.getItems("terminalThemes") || []).map(t => t.id))'
  ))
  const lightId = themeIds.find(id => /light/i.test(String(id)))
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(600)
    const lightTab = await sqlTab(cdp)
    const barLight = await cdp.eval(`(() => {
      const bar = window.__h6cBar()
      const r = bar.getBoundingClientRect()
      const b = window.__h6cBtn(${JSON.stringify(T_SAVE)}).getBoundingClientRect()
      return JSON.stringify({ barH: Math.round(r.height), saveW: Math.round(b.width), saveH: Math.round(b.height) })
    })()`)
    const bl = JSON.parse(barLight)
    check('H6c-10a 浅色主题：页签与工具行不塌陷（按钮 ≥ 16px 高、工具行 ≥ 20px）',
      bl.barH >= 20 && bl.saveW > 0 && bl.saveH >= 16 && lightTab.text === 'fresh-query.sql', { bl, lightTab })
    await cdp.shot(path.join(SHOT_DIR, '4-light-file.png'))
    await cdp.eval('window.__focusSql()')
    await cdp.call('Input.insertText', { text: ' -- light dirty' })
    await sleep(300)
    await cdp.shot(path.join(SHOT_DIR, '5-light-dirty.png'))
    // 截图后先落盘，别把脏状态带进收尾：clearDbTabs 走 delTab，会等关闭确认
    await cdp.eval('window.__h6cClick(' + JSON.stringify(T_SAVE) + ')')
    await waitFor(cdp, 'window.__h6cTabs() ? JSON.parse(window.__h6cTabs())[1].text.indexOf("•") < 0 : false', 'light dirty saved', 6000)
    await cdp.eval('window.store.setTheme(' + JSON.stringify(themeBefore || 'default') + ')')
    await sleep(500)
  } else {
    check('H6c-10a 浅色主题截图（本机无 light 主题，只剩暗色）', false, { themeIds })
  }

  // ---------- 收尾 ----------
  await clearDbTabs(cdp)
  await mainCdp.eval(`(() => {
    const electron = global.process.mainModule.require('electron')
    if (global.__h6cOrig) {
      electron.dialog.showOpenDialogSync = global.__h6cOrig.open
      electron.dialog.showSaveDialog = global.__h6cOrig.save
    }
    global.__h6cOpen = null
    global.__h6cSave = null
    return 'restored'
  })()`)
  fs.rmSync(dir, { recursive: true, force: true })

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  return fail.length
}

main().then(n => process.exit(n ? 1 : 0)).catch(e => {
  console.error(e)
  process.exit(1)
})
