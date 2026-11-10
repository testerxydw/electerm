#!/usr/bin/env node
// N12c 后续：索引/序列组顶栏开关（默认关闭）—— 真实 UI 全链路 CDP 探针。
//
// 链路全是真的：真实点击顶栏 Switch（CDP Input 坐标）→ setConfig → watch.js
// autoRun debounce → saveUserConfig（主进程）→ globalState.config；
// 树的变化来自 use-db-tree-data 的纯前端裁剪（不重新拉元数据，所以切换是瞬时的）。
//
// 为什么必须实机（单测替代不了）：
// - "默认关闭"是 config 判定方向问题（=== true vs !== false），单测能锁源码方向，
//   但锁不住"首次连接时树里到底有没有索引组"——metadata 是主进程回的，只有真跑一次
//   才看得见裁剪有没有作用在真实树上；
// - 纯前端过滤的时机（先裁后过滤）与 auto-expand 的交互，只有真树的展开态能验；
// - 持久化链是三段接力（setConfig → debounce → IPC → globalState），断一段就静默失效。
//
// 用法：先 npm run compile + rsync -a src/app/ work/app/（词条在主进程侧），需独占 X display：
//   node self-test/relation-group-toggle-cdp-probe.js [display] [pagePort] [mainPort] [shotDir]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9358'
const IPORT = process.argv[4] || '9359'
const SHOT_DIR = path.join(ROOT, process.argv[5] || 'self-test/2026-11-10-relation-toggle-shots')

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n12c2-'))
const DB = path.join(RUN, 'demo', 'probe.db')
let app = null
let page = null
let mainCdp = null

// 主进程侧读 config：saveUserConfig 里 globalState.update('config', userConfig)，
// 这是持久化链最末端的权威副本（磁盘 nedb 之上、渲染层之下，读它最能说明"真的写进去了"）。
// process.mainModule 在 Electron 里不是 app.js（是 browser_init），相对 require 会解析失败
// —— 用 spawn 的 cwd（仓库根）拼绝对路径。
const CONF_READ = `(() => {
  const req = process.mainModule && process.mainModule.require
    ? process.mainModule.require
    : require
  const st = req(req('path').join(process.cwd(), 'work/app/lib/glob-state'))
  const c = (st && st.get('config')) || {}
  return JSON.stringify({ show: c.dbShowRelationGroups, key: 'dbShowRelationGroups' in c })
})()`

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
  // 树面板里有没有文本含 needle 的节点（组标签用 i18n 值，探针不写死中文）
  window.__treeHasText = needle => [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .some(n => window.__vis(n) && n.innerText.trim().indexOf(needle) >= 0)
  window.__treeDump = () => [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .filter(window.__vis).map(n => n.innerText.trim().replace(/\\s+/g, ' ')).slice(0, 40)

  // 关系组开关：aria-checked 是 antd Switch 的真实状态读数（class 会被过渡动画影响）
  window.__relSwitch = () => {
    const wrap = window.__one('.db-relation-toggle')
    if (!wrap) return null
    const sw = wrap.querySelector('.ant-switch')
    if (!sw) return null
    return {
      checked: sw.getAttribute('aria-checked') === 'true',
      label: window.__txt(wrap.querySelector('.db-tool-label')),
      xy: window.__xy(sw)
    }
  }
  return 1
})()`

function writeFixture () {
  fs.mkdirSync(path.dirname(DB), { recursive: true })
  const db = new DatabaseSync(DB)
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  db.exec('CREATE INDEX idx_product_name ON product(name)')
  const ins = db.prepare('INSERT INTO product(id, name, price, note) VALUES(?, ?, ?, ?)')
  ins.run(1, '键盘', 299.5, null)
  ins.run(2, '鼠标', 88, '第一批')
  db.close()
}

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.HOME = path.join(RUN, 'home')
  env.XDG_CONFIG_HOME = path.join(RUN, 'config')
  env.TMPDIR = path.join(RUN, 'tmp')
  env.DATA_PATH = path.join(RUN, 'data')
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

const idxLabel = 'window.translate("dbIndexes")'

async function main () {
  await assertPortsIdle()
  writeFixture()

  launch()
  mainCdp = await waitMainCdp()
  page = await waitPageCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  if (!await waitFor(page, '!!(window.store && window.store.tabs && window.translate)', '应用未就绪', 90000)) {
    throw new Error('渲染层没就绪：' + J(await page.tail(8)))
  }
  await sleep(2500)
  await page.eval(PROBE)

  await page.eval(`(() => {
    window.store.addTab({
      type: 'database',
      from: 'quick-connect',
      title: 'n12c2-relation-toggle',
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

  // 展开收起的库/schema 层，让表与对象组进 DOM
  for (let i = 0; i < 4; i++) {
    const sw = await page.eval('window.__collapsedSwitcherXY()')
    if (!sw) break
    await page.click(sw.x, sw.y)
    await sleep(700)
  }
  check('树里有 product 表（夹具含一条显式索引）',
    await waitFor(page, '!!window.__treeNodeXY("product")', 'tree product', 15000))

  // —— 默认关闭 ——
  const rel0 = await page.eval('window.__relSwitch()')
  check('顶栏关系组开关存在且默认关闭（aria-checked=false）', !!rel0 && rel0.checked === false, rel0)
  check('顶栏开关文案是「索引/序列」词条',
    !!rel0 && rel0.label === await page.eval('window.translate("dbShowRelationGroups")'), rel0 && rel0.label)
  const idxVisible0 = await page.eval(`window.__treeHasText(${idxLabel})`)
  check('默认关闭：树里没有索引组节点', idxVisible0 === false,
    idxVisible0 === false ? null : await page.eval('window.__treeDump()'))
  const conf0 = JSON.parse(await mainCdp.eval(CONF_READ))
  check('默认关闭：config 里没有开启记录（undefined，不是 false 兜底）', conf0.show === undefined, conf0)
  await page.shot(path.join(SHOT_DIR, '1-default-off.png'))

  // —— 打开开关 ——
  await page.click(rel0.xy.x, rel0.xy.y)
  check('打开开关后索引组出现在树里', await waitFor(page,
    `window.__treeHasText(${idxLabel})`, 'index group', 10000))
  const node = await page.eval(`window.__treeNodeXY(${idxLabel})`)
  if (!node) throw new Error('索引组节点不可点')
  await page.click(node.x, node.y)
  check('展开索引组能看到夹具里的 idx_product_name',
    await waitFor(page, 'window.__treeHasText("idx_product_name")', 'index leaf', 10000),
    await page.eval('window.__treeDump()'))
  // 截图要拍到展开后的子项：等待展开动画 + 一次性重渲染落定
  await sleep(900)
  await page.shot(path.join(SHOT_DIR, '2-toggle-on.png'))

  // —— 持久化链：setConfig → debounce 100ms → saveUserConfig → globalState ——
  let conf1 = null
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    conf1 = JSON.parse(await mainCdp.eval(CONF_READ))
    if (conf1.show === true) break
    await sleep(300)
  }
  check('主进程 config 收到 dbShowRelationGroups=true（持久化链走通）',
    !!conf1 && conf1.show === true, conf1)

  // —— 关回去：树立即收回（纯前端裁剪，不重拉元数据） ——
  const rel1 = await page.eval('window.__relSwitch()')
  await page.click(rel1.xy.x, rel1.xy.y)
  check('关闭开关后索引组从树里消失，表仍在', await waitFor(page,
    `!window.__treeHasText(${idxLabel}) && !!window.__treeNodeXY("product")`, 'index hidden', 10000),
  await page.eval('window.__treeDump()'))

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

main().then(code => {
  process.exitCode = code ? 1 : 0
}, e => {
  console.error(e)
  process.exitCode = 1
}).finally(cleanup).catch(e => {
  console.error(e)
  process.exitCode = 1
})
