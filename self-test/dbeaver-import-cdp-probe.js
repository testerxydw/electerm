#!/usr/bin/env node
// N12b DBeaver data-sources.json 导入连接 —— 真实 UI 全链路 CDP 探针。
//
// 链路每一环都是真的：
//   真实点击 .upload-bookmark-icon（CDP Input 坐标）
//   → 自定义 Upload 的 openFileSelect → window.api.openDialog（contextBridge，不可打桩）
//   → 主进程 'show-open-dialog-sync' → dialog.showOpenDialogSync
//   → 这里唯一的桩：electron 启动加 --inspect，从主进程 CDP 把
//     dialog.showOpenDialogSync 换成「按队列返回 fixture 路径」，
//     替代真人选文件。解析/判重/建分组全部走渲染层真实代码。
//
// 用法：先 npm run compile（探针加载 work/app 产物），需独占 X display：
//   node self-test/dbeaver-import-cdp-probe.js [display] [pagePort] [mainPort] [shotDir]
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9353'
const IPORT = process.argv[4] || '9354'
const SHOT_DIR = path.join(ROOT, process.argv[5] || 'self-test/2026-11-10-dbeaver-import-shots')

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n12b-'))
let app = null
let page = null
let mainCdp = null

// 6 条连接：4 支持的（mysql/pg/redis/带路径 sqlite）+ oracle（不支持）+
// 无路径 sqlite（跳过）。mysql 的 configuration.password 是防御性验证项：
// DBeaver 真实文件里没有明文密码，这里塞一个确保整包 configuration 不会漏进来
const DBEAVER_FIXTURE = {
  folders: {},
  connections: {
    'uuid-mysql': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'TGFS MariaDB',
      description: 'probe fixture mysql',
      configuration: {
        host: '192.168.115.67',
        port: '13306',
        database: 'tgfsom',
        user: 'root',
        password: 'SHOULD-NOT-IMPORT'
      }
    },
    'uuid-pg': {
      provider: 'postgresql',
      name: 'Report PG',
      configuration: { host: '10.0.0.2', port: '5433', database: 'report' }
    },
    'uuid-redis': {
      provider: 'redis',
      name: 'Cache Redis',
      configuration: { host: '192.168.115.67', port: '16379' }
    },
    'uuid-sqlite': {
      provider: 'sqlite',
      name: 'Local TGFS db',
      configuration: { path: '/data/demo/tgfs.db' }
    },
    'uuid-sqlite-nopath': {
      provider: 'sqlite',
      name: 'broken sqlite',
      configuration: { host: 'x' }
    },
    'uuid-oracle': {
      provider: 'oracle',
      name: 'unsupported oracle',
      configuration: { host: 'h', port: '1521' }
    }
  }
}

// electerm 自身导出形状：必须走原路径（有 bookmarks 键，永不判成 DBeaver）
const ELECTERM_FIXTURE = {
  bookmarkGroups: [],
  bookmarks: [{
    id: 'bm-e1',
    type: 'database',
    dbType: 'mysql',
    title: 'my-electerm-bm',
    dbHost: '1.2.3.4',
    dbPort: 3306,
    dbUser: 'u',
    dbName: 'd'
  }]
}

const dbeaverPath = path.join(RUN, 'dbeaver-data-sources.json')
const electermPath = path.join(RUN, 'electerm-bookmarks.json')

// 主进程侧：换掉 dialog.showOpenDialogSync（ipc.js:603 是调用点解引用，属性替换即生效）
const MAIN_STUB = `
(() => {
  // inspector 的全局 eval 没有 require（CJS 模块级注入），从入口模块借
  const req = process.mainModule && process.mainModule.require
    ? process.mainModule.require
    : require
  const { dialog } = req('electron')
  if (dialog.__n12bStub) return 'already'
  dialog.__n12bStub = true
  dialog.__n12bCalls = 0
  const orig = dialog.showOpenDialogSync.bind(dialog)
  dialog.showOpenDialogSync = function (...a) {
    dialog.__n12bCalls++
    const f = (global.__n12bQueue || []).shift()
    return f ? [f] : orig(...a)
  }
  global.__n12bQueue = global.__n12bQueue || []
  return 'stub-installed'
})()`

// 渲染层探针：只读快照 + 找按钮坐标，导入动作本身走真实点击
const PROBE = `
(() => {
  window.__bmSnap = () => JSON.stringify((window.store.bookmarks || []).map(b => ({
    id: b.id, title: b.title, dbType: b.dbType, dbHost: b.dbHost, description: b.description,
    dbPort: b.dbPort, dbUser: b.dbUser, dbPassword: b.dbPassword,
    dbName: b.dbName, dbFile: b.dbFile
  })))
  window.__importedGroups = () => JSON.stringify((window.store.bookmarkGroups || [])
    .filter(g => /^imported_/.test(String(g.title || '')))
    .map(g => ({ title: g.title, ids: g.bookmarkIds || [] })))
  window.__importBtnXY = () => {
    const el = window.__one('.upload-bookmark-icon')
    if (!el) return JSON.stringify({ error: 'no-btn' })
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return JSON.stringify({ error: 'too-small' })
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  return 'probe-installed'
})()`

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = { ...process.env }
  // 宿主环境（WorkBuddy 沙箱）带 ELECTRON_RUN_AS_NODE=1，不清掉的话
  // electron 二进制会以普通 node 跑，app.getPath 直接 undefined
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.HOME = path.join(RUN, 'home')
  env.XDG_CONFIG_HOME = path.join(RUN, 'config')
  env.TMPDIR = path.join(RUN, 'tmp')
  env.DATA_PATH = path.join(RUN, 'data')
  // Xvfb 无 GPU：仅命令行 --disable-gpu 不够，GPU 进程照样 FATAL 退出
  // （gpu_data_manager "Goodbye"）；app 的 crash-reporter 认这个 env，
  // 走 app.disableHardwareAcceleration() 完整禁用（crash-reporter.js:189）
  env.DISABLE_GPU = '1'
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--inspect=127.0.0.1:' + IPORT,
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    // Xvfb 无 GPU：GPU 进程起来即 FATAL（gpu_data_manager Goodbye），必须软件渲染
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

// 真实点击导入按钮：坐标来自按钮自身矩形，CDP Input 派发
async function clickImport () {
  const xy = JSON.parse(await page.eval('window.__importBtnXY()'))
  if (xy.error) {
    throw new Error('导入按钮不可点：' + xy.error)
  }
  await page.click(xy.x, xy.y)
}

const bmSnap = async () => JSON.parse(await page.eval('window.__bmSnap()'))

async function main () {
  await assertPortsIdle()
  fs.writeFileSync(dbeaverPath, JSON.stringify(DBEAVER_FIXTURE, null, 2))
  fs.writeFileSync(electermPath, JSON.stringify(ELECTERM_FIXTURE, null, 2))

  launch()
  // 主进程先连：桩必须在第一次点击前就位
  mainCdp = await waitMainCdp()
  const stubbed = await mainCdp.eval(MAIN_STUB)
  check('主进程 dialog.showOpenDialogSync 桩就位（仅替代"选文件"，其余全真）',
    stubbed === 'stub-installed' || stubbed === 'already', stubbed)

  page = await waitPageCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(page, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪：' + J(await page.tail(8)))
  }
  await sleep(2500)
  await page.eval(buildHelpers('electerm-n12b'))
  await page.eval(PROBE)
  // 导入按钮挂在设置弹窗的书签树 header（侧栏树是 staticList，没有该按钮）：
  // 打开设置并切到书签 tab。modals.setting 是数字 1（constants.js），不是字符串
  await page.eval(`(() => {
    window.store.isSecondInstance = false
    window.store.settingTab = 'bookmarks'
    window.store.showModal = 1
    return 'opened'
  })()`)
  check('设置弹窗书签 tab 打开，导入按钮真实可见', await waitFor(page,
    '!!window.__one(".upload-bookmark-icon")', 'import button', 12000))

  const base0 = (await bmSnap()).length
  // —— 第一次导入：DBeaver data-sources.json ——
  await mainCdp.eval('global.__n12bQueue.push(' + J(dbeaverPath) + ')')
  await clickImport()
  check('4 条书签落地（oracle 与无路径 sqlite 被跳过）',
    await waitFor(page, 'JSON.parse(window.__bmSnap()).length - ' + base0 + ' >= 4', 'dbeaver bookmarks', 15000))
  await sleep(800)
  const snap1 = await bmSnap()
  const added = snap1.slice(base0)

  const findBm = (dbType, title) => added.find(b => b.dbType === dbType && b.title === title)
  const mysql = findBm('mysql', 'TGFS MariaDB')
  const pg = findBm('postgres', 'Report PG')
  const redis = findBm('redis', 'Cache Redis')
  const lite = findBm('sqlite', 'Local TGFS db')

  check('mysql：host/端口字符串转数字/user/dbName 全对',
    mysql && mysql.dbHost === '192.168.115.67' && mysql.dbPort === 13306 &&
    mysql.dbUser === 'root' && mysql.dbName === 'tgfsom', mysql)
  check('postgresql：provider→postgres，端口 5433 数字',
    pg && pg.dbHost === '10.0.0.2' && pg.dbPort === 5433 && pg.dbName === 'report', pg)
  check('redis：无 dbName 属性，端口 16379',
    redis && redis.dbHost === '192.168.115.67' && redis.dbPort === 16379 &&
    !('dbName' in redis), redis)
  check('sqlite：dbFile 落位，不带网络字段',
    lite && lite.dbFile === '/data/demo/tgfs.db' &&
    lite.dbHost === undefined && lite.dbPort === undefined, lite)
  check('密码永不导入（含 configuration.password 防御项）',
    added.length === 4 && added.every(b => b.dbPassword === ''), added.map(b => b.dbPassword))
  check('description 透传', mysql && mysql.description === 'probe fixture mysql')

  const groups1 = JSON.parse(await page.eval('window.__importedGroups()'))
  check('imported_ 分组创建且 bookmarkIds 覆盖 4 条新书签',
    groups1.length >= 1 &&
    groups1.some(g => added.every(b => g.ids.includes(b.id))), groups1)

  const calls1 = Number(await mainCdp.eval('process.mainModule.require("electron").dialog.__n12bCalls'))
  check('真实点击走完 UI→IPC→主进程对话框链路（桩被调 1 次）', calls1 === 1, calls1)
  await page.shot(path.join(SHOT_DIR, '1-dbeaver-imported.png'))

  // —— 第二次导入同一文件：同名同连接判重全跳过 ——
  await mainCdp.eval('global.__n12bQueue.push(' + J(dbeaverPath) + ')')
  await clickImport()
  await sleep(2500)
  const snap2 = await bmSnap()
  const dbeaverCount2 = snap2.filter(b =>
    ['TGFS MariaDB', 'Report PG', 'Cache Redis', 'Local TGFS db'].includes(b.title)).length
  check('二次导入同名同连接判重：书签不翻倍（仍 4 条）', dbeaverCount2 === 4, dbeaverCount2)
  check('二次导入有 skipped 警告（自研 message，含数量 4）',
    await waitFor(page,
      '(() => { const n = document.querySelector(".message-item.warning");' +
      'return !!(n && n.textContent.indexOf("4") >= 0) })()', 'dup warning', 6000))
  const calls2 = Number(await mainCdp.eval('process.mainModule.require("electron").dialog.__n12bCalls'))
  check('第二次点击同样走真实对话框链路（桩累计 2 次）', calls2 === 2, calls2)
  await page.shot(path.join(SHOT_DIR, '2-duplicate-warning.png'))

  // —— 第三次导入：electerm 自身导出形状，必须走原路径 ——
  const base3 = (await bmSnap()).length
  await mainCdp.eval('global.__n12bQueue.push(' + J(electermPath) + ')')
  await clickImport()
  check('electerm 导出格式照常导入（my-electerm-bm 落地）',
    await waitFor(page, 'JSON.parse(window.__bmSnap()).length - ' + base3 + ' >= 1', 'electerm bm', 15000))
  const mine = (await bmSnap()).find(b => b.title === 'my-electerm-bm')
  check('electerm 格式未被 DBeaver 误判：字段原样保留',
    mine && mine.dbHost === '1.2.3.4' && mine.dbPort === 3306 &&
    mine.dbName === 'd' && mine.dbUser === 'u', mine)
  const groups3 = JSON.parse(await page.eval('window.__importedGroups()'))
  check('electerm 导入不再新建 imported_ 分组（原路径语义）', groups3.length === 1, groups3.length)
  await page.shot(path.join(SHOT_DIR, '3-electerm-format-intact.png'))

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
