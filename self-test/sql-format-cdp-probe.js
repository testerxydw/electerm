#!/usr/bin/env node
// N12e SQL 格式化器嵌套规则化 —— 真实编辑器全链路 CDP 探针。
//
// 链路：sqlite 会话 → SQL 页签 → CodeMirror 6 编辑器真实键入嵌套 SQL
//   → Ctrl+Shift+F（db-sql-editor 的 Mod-Shift-f keymap → formatSqlEditor
//   → db-sql-format.formatSql）→ 断言 CM6 行 DOM 的缩进/折叠结果。
//
// 为什么必须实机（单测替代不了）：
// - formatSql 的产出要经过 setSqlText → CM6 重渲染才落到用户眼前，接线断了
//   （onFormat 没绑、keymap 被吞）单测永远绿；
// - CM6 的行 DOM（.cm-line）是真实显示单元，缩进空格是否保留只有真渲染知道。
//
// 用法：先 npm run compile，需独占 X display：
//   node self-test/sql-format-cdp-probe.js [display] [pagePort] [mainPort] [shotDir]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9360'
const IPORT = process.argv[4] || '9361'
const SHOT_DIR = path.join(ROOT, process.argv[5] || 'self-test/2026-11-10-sql-format-shots')

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n12e-'))
const DB = path.join(RUN, 'demo', 'probe.db')
const TITLE = 'n12e-sql-format'
let app = null
let page = null

// 页内探针：SQL 页签与 CM6 编辑器
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

  // 主 Tabs：SQL 是第二个页签（data=0, sql=1）
  window.__sqlTabXY = () => {
    const tabs = [...document.querySelectorAll('.db-tabs [role="tab"]')].filter(window.__vis)
    const t = tabs[1]
    return t ? window.__xy(t) : null
  }
  // CM6 行 DOM：真实显示单元，每行一个 .cm-line。
  // CM6 用 \u00a0 画连续空格，统一归一回普通空格再断言
  window.__cmLines = () => {
    const c = window.__one('.db-sql-editor .cm-content')
    if (!c) return null
    return [...c.querySelectorAll('.cm-line')].map(l =>
      String(l.textContent).replace(/\u00a0/g, ' '))
  }
  window.__cmContent = () => window.__one('.db-sql-editor .cm-content')
  return 1
})()`

function writeFixture () {
  fs.mkdirSync(path.dirname(DB), { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  const ins = db.prepare('INSERT INTO product(id, name, price, note) VALUES(?, ?, ?, ?)')
  ins.run(1, '键盘', 299.5, null)
  ins.run(2, '鼠标', 88, '第一批')
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
  // Xvfb 无 GPU：必须 app 级禁用硬件加速（crash-reporter.js 认 DISABLE_GPU）
  env.DISABLE_GPU = '1'
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: 'ignore' })
}

async function cleanup () {
  if (page) page.ws.close()
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

const MOD_CTRL = 2
const MOD_SHIFT = 8

async function key (key0, code, keyCode, modifiers) {
  const base = { key: key0, code, keyCode, windowsVirtualKeyCode: keyCode }
  if (modifiers) base.modifiers = modifiers
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// CM6 键位 Mod-Shift-F（db-sql-editor keymap，Linux 下 Mod=Ctrl）
async function pressFormat () {
  await key('Control', 'ControlLeft', 17)
  await key('Shift', 'ShiftLeft', 16)
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'F',
    code: 'KeyF',
    keyCode: 70,
    windowsVirtualKeyCode: 70,
    modifiers: MOD_CTRL | MOD_SHIFT
  })
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'F',
    code: 'KeyF',
    keyCode: 70,
    windowsVirtualKeyCode: 70,
    modifiers: MOD_CTRL | MOD_SHIFT
  })
  await key('Shift', 'ShiftLeft', 16)
  await key('Control', 'ControlLeft', 17)
  await sleep(400)
}

async function replaceEditorText (text) {
  // Ctrl+A 全选 → Delete → insertText（CM6 走 beforeinput，等价真实输入）
  await key('a', 'KeyA', 65, MOD_CTRL)
  await key('Delete', 'Delete', 46)
  await page.call('Input.insertText', { text })
  await sleep(400)
}

async function main () {
  await assertPortsIdle()
  writeFixture()

  launch()
  page = await waitPageCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(page, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪')
  }
  await sleep(2500)
  await page.eval(PROBE)

  // 开 sqlite 会话页签（readOnly 必须显式 false）
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
  check('sqlite 会话页签连上',
    await waitFor(page, 'String(window.__headTarget() || "").indexOf("probe.db") >= 0', 'head target', 25000))

  // 切到 SQL 页签
  const tabXY = await page.eval('window.__sqlTabXY()')
  if (!tabXY) throw new Error('SQL 页签不可点')
  await page.click(tabXY.x, tabXY.y)
  check('SQL 页签出现 CodeMirror 编辑器', await waitFor(page,
    '!!window.__cmContent()', 'cm editor', 15000))

  // ============ A 子查询嵌套 ============
  const sqlA = 'select a from (select b, c from t where x in (1, 2, 3)) q'
  // DOM 节点不能过 CDP 返回值序列化，只取坐标
  const cp = await page.eval('window.__xy(window.__cmContent())')
  if (!cp) throw new Error('编辑器内容区不可点')
  await page.click(cp.x, cp.y)
  await sleep(300)
  await replaceEditorText(sqlA)
  check('键入后编辑器是单行原文', await waitFor(page,
    'window.__cmLines() && window.__cmLines().length === 1', 'one line', 8000))
  await page.shot(path.join(SHOT_DIR, '1-before-format.png'))

  await pressFormat()
  check('Ctrl+Shift+F 后编辑器变多行（onFormat 接线活着）', await waitFor(page,
    'window.__cmLines() && window.__cmLines().length > 1', 'multi lines', 8000))

  const linesA = await page.eval('window.__cmLines()')
  const joined = linesA.join('\n')
  check('子查询主子句保留缩进层级（不拍平到第 0 列）',
    /^\s{2}SELECT b,$/m.test(joined) && /^\s{2}WHERE x IN \(1, 2, 3\)\) q$/m.test(joined),
    joined)
  check('顶层主子句仍在第 0 列', /^FROM \(/m.test(joined) && /^SELECT a$/m.test(joined), joined)
  check('短 IN 列表折叠回单行（不再竖排）', joined.includes('x IN (1, 2, 3)'), joined)
  check('关键字大写（键入的小写 select/from 已大写化）',
    /^SELECT a$/m.test(joined) && !/\bselect\b/.test(joined), joined)
  await page.shot(path.join(SHOT_DIR, '2-after-format-nested.png'))

  // ============ B 窗口函数 ============
  await replaceEditorText('select row_number() over (partition by dep order by sal desc) r from t')
  await pressFormat()
  check('窗口函数格式化为多行', await waitFor(page,
    'window.__cmLines() && window.__cmLines().length > 1', 'window multi', 8000))
  const linesB = await page.eval('window.__cmLines()')
  const joinedB = linesB.join('\n')
  check('OVER ( 内 PARTITION BY / ORDER BY 分行缩进',
    /OVER \($/m.test(joinedB) && /^\s{2}PARTITION BY dep$/m.test(joinedB) &&
    /^\s{2}ORDER BY sal DESC\) r$/m.test(joinedB), joinedB)
  check('函数名后括号紧贴（row_number() 不留空格）', joinedB.includes('row_number()'), joinedB)
  await page.shot(path.join(SHOT_DIR, '3-after-format-window.png'))

  const hard = page.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|TypeError|uncaught/.test(s)
  })
  check('渲染层没有新增硬错误', hard.length === 0, hard.slice(0, 5))

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  return fail.length
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
