#!/usr/bin/env node
/**
 * 空表总行数（约 1 → 0）—— 假库 CDP 实机回归
 *
 * 现象（2026-11-05 用户实机截图，MariaDB 10.3）：空表的状态行自相矛盾成
 * 「本页 0 行 · 总行数（约）: 1」，空态提示也跟着说「该表暂无数据（总行数（约）: 1）」。
 * 根因不在产品：`information_schema.TABLES.TABLE_ROWS` 是统计估算，MariaDB/InnoDB
 * 对空表会给 1。改口放在**主进程取数处**（mysql.js confirmEmpty：估算落在 0..1 这一档
 * 时补一次 `SELECT 1 … LIMIT 1`，探不到行就是确定的空表 → 0）。数据页状态行、空态提示、
 * 数据字典导出、AI 工具读的是同一个数，一处修全生效。
 *
 * 这份脚本只验渲染层这条边界 —— 状态行与空态提示同读 grid.totalRows，而它必须
 * 原样来自服务端回传值（界面不推断）：
 *   1) 服务端复核过回 0 → 界面显示 0，且状态行与空态提示两处同源一起是 0；
 *   2) 服务端没复核（复核失败/老服务端）回 1 → 界面**照抄 1**，不在渲染层再判一次
 *      "这一页没行"去覆盖。这条是 0e0423a4 把方向踩反之后留下的墓碑；
 *   3) 有数据的表回估算 12 万 → 原样显示，不能被任何本地逻辑归零。
 * 复核该不该发、什么时候发，由 src/test/unit-ci/db-approx-rows-empty.spec.js
 * 用假 pool 跑真实适配器源码钉住 —— 那在 CDP 之下，这份看不见。
 *
 * 对生产库无依赖：全程假 host + 假 runGlobalAsync，不发起真实连接。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) Xvfb <display> -nolisten tcp &
 *   3) node self-test/db-empty-total-demo.js [display] [port] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':157'
const PORT = process.argv[3] || '9451'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/db-empty-total-shots')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-emptytotal-'))
const HOME = path.join(RUN, 'home')
const DATA = path.join(RUN, 'data')
const LOG_FILE = path.join(RUN, 'app.log')

// 三张表 = 三个场景，切表即切场景，不需要中途改桩
const T_ZERO = 't_zero' // 主进程复核过的空表：服务端回 0
const T_RAW = 't_raw' // 没复核的空表（复核失败/老服务端）：服务端仍回 1
const T_BIG = 't_big' // 有数据的表：估算原样透传
const ZERO_TOTAL = 0
const RAW_TOTAL = 1
const BIG_TOTAL = 120000

const STUB = `
(() => {
  const COLS = [
    { Field: 'id', Type: 'int', Key: 'PRI', Null: 'NO' },
    { Field: 'name', Type: 'varchar', Key: '', Null: 'YES' }
  ]
  const mkRows = n => {
    const r = []
    for (let i = 1; i <= n; i++) {
      r.push({ id: i, name: 'row' + i })
    }
    return r
  }
  const RESP = {
    '${T_ZERO}': { rows: [], totalRows: ${ZERO_TOTAL}, hasMore: false },
    '${T_RAW}': { rows: [], totalRows: ${RAW_TOTAL}, hasMore: false },
    '${T_BIG}': { rows: mkRows(50), totalRows: ${BIG_TOTAL}, hasMore: true }
  }
  window.__served = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo_db',
          children: ['${T_ZERO}', '${T_RAW}', '${T_BIG}'].map(n => ({ name: n, type: 'table' }))
        }])
      }
      if (op === 'describeTable') {
        return Promise.resolve(COLS)
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({ columns: COLS.map(c => ({ name: c.Field, dataType: c.Type })), foreignKeys: [] })
      }
      if (op === 'getPageData') {
        const r = RESP[args.table] || { rows: [], totalRows: 0, hasMore: false }
        window.__served.push({ table: args.table, rows: r.rows.length, totalRows: r.totalRows, hasMore: r.hasMore })
        return Promise.resolve({ rows: r.rows, totalRows: r.totalRows, hasMore: r.hasMore, page: args.page })
      }
      if (op === 'getReferences') return Promise.resolve({ references: [], degraded: false })
      if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], lastErr: null, lastTx: null })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab' || name === 'closeDbTab') return Promise.resolve({ ok: true })
    // headless 屏拿不到 screen，onResize 会解构 null 崩在 db 面板挂载之前
    if (name === 'getScreenSize') return Promise.resolve({ width: 1600, height: 1000 })
    return Promise.resolve(null)
  }
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return n
      n = n.parentElement
    }
    return null
  }
  window.__vis = el => !window.__hidden(el)
  window.__clickTree = text => {
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(window.__vis)
    let hit = all.filter(n => n.innerText.trim() === text)
    if (!hit.length) {
      hit = all.filter(n => n.innerText.trim().indexOf(text) >= 0)
    }
    if (!hit.length) return 'no-node:' + text
    hit[0].click()
    return 'ok'
  }
  // 状态行与空态提示都只取**可见**那一份：切表瞬间新旧面板同时在 DOM 里
  window.__totalText = () => {
    const el = [...document.querySelectorAll('.db-grid-total')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : ''
  }
  window.__emptyTip = () => {
    const el = [...document.querySelectorAll('.db-empty-tip')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : ''
  }
  window.__rowCount = () => [...document.querySelectorAll('.ant-table-row')].filter(window.__vis).length
  window.__pageRowsText = () => {
    const el = [...document.querySelectorAll('.db-grid-page-rows')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : ''
  }
  window.__pageNo = () => {
    const el = [...document.querySelectorAll('.db-grid-page-no')].filter(window.__vis)[0]
    return el ? el.innerText.trim() : ''
  }
  window.__labels = () => JSON.stringify({
    approx: window.translate('approxRows'),
    exact: window.translate('dbExactRows'),
    pageRows: window.translate('dbGridPageRows')
  })
  return 'stub-installed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'mysql empty-total demo',
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

function portFree (port) {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

function launch () {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = {
    ...process.env,
    DISPLAY,
    HOME,
    XDG_CONFIG_HOME: path.join(RUN, 'config'),
    TMPDIR: path.join(RUN, 'tmp'),
    DATA_PATH: DATA
  }
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn('dbus-run-session', [
    '--',
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    'work/app/app.js',
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  child.unref()
  return child
}

/** 只杀自己起的进程组（detached），绝不按端口/pkill 匹配 —— 并行会话的实例还在跑 */
function killInstance (child) {
  if (!child || !child.pid) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (e) {
    try { child.kill('SIGTERM') } catch (e2) {}
  }
}

function removeRun () {
  if (process.env.KEEP_TMP) {
    console.error('临时目录保留以便排查：' + RUN)
    return
  }
  try {
    fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch (e) {
    console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
  }
}

async function shot (cdp, file) {
  const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
  const data = r.result && r.result.data
  if (!data) {
    throw new Error('截图失败：' + JSON.stringify(r.error || r.result))
  }
  fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(data, 'base64'))
}

async function waitCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const page = list && findPageTarget(list)
    if (page) {
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

async function main () {
  const { results, check } = makeChecker()
  let child = null
  const finish = code => {
    killInstance(child)
    removeRun()
    process.exit(code)
  }
  try {
    if (!await portFree(Number(PORT))) {
      throw new Error('端口 ' + PORT + ' 已被占用（并行会话的实例在跑）——换一个端口重跑')
    }
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    child = launch()

    const cdp = await waitCdp()
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

    check('桩 MySQL 已注入', await cdp.eval(STUB) === 'stub-installed')
    const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
    if (!openRes.id) {
      throw new Error('database tab was not created')
    }
    await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
    await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
    await waitFor(cdp, 'window.__clickTree("demo_db") === "ok"', '展开库节点')

    const L = JSON.parse(await cdp.eval('window.__labels()'))
    const approx = L.approx
    const totalWith = n => approx + ': ' + n
    // 状态行里"精确"按钮的文字也落在 .db-grid-total 内，所以取标签后面那个数而不是endsWith
    const approxOf = t => {
      const m = String(t).match(new RegExp(approx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(\\d+)'))
      return m ? Number(m[1]) : null
    }
    check('词条可读（approxRows 非空）', !!approx, { approx })

    const openTable = async name => {
      const ok = await waitFor(cdp, `window.__clickTree("${name}") === "ok"`, 'open ' + name)
      await sleep(1200)
      return ok
    }

    // ── 1) 服务端复核过的空表：界面 0，两处同源 ────────────────
    check('打开复核过的空表', await openTable(T_ZERO))
    const servedZero = JSON.parse(await cdp.eval('JSON.stringify(window.__served.filter(s => s.table === "' + T_ZERO + '").slice(-1)[0])'))
    const tZero = await cdp.eval('window.__totalText()')
    const tipZero = await cdp.eval('window.__emptyTip()')
    const rowsZero = await cdp.eval('window.__rowCount()')
    const pageRowsZero = await cdp.eval('window.__pageRowsText()')
    const pageNoZero = await cdp.eval('window.__pageNo()')
    check('桩按主进程复核后的口径回了 0',
      servedZero.totalRows === ZERO_TOTAL && servedZero.rows === 0, { served: servedZero })
    check('空表状态行显示「总行数（约）: 0」', approxOf(tZero) === ZERO_TOTAL, { tZero })
    check('空表状态行的本页行数仍是 0（两个口径不互相顶掉）',
      rowsZero === 0 && pageRowsZero === L.pageRows.replace('{n}', '0'), { rowsZero, pageRowsZero })
    check('空态提示与状态行同源，一起是 0',
      tipZero.includes(totalWith(ZERO_TOTAL)) && !tipZero.includes(totalWith(RAW_TOTAL)), { tipZero })
    check('空表分页器仍显示第 1 页（总数 0 不该把分页器算成 0 页）',
      /1/.test(pageNoZero), { pageNo: pageNoZero })
    await shot(cdp, '01-empty-is-zero.png')

    // ── 2) 服务端没复核（回 1）：界面照抄，不在渲染层再判一次 ──
    check('打开未复核的空表', await openTable(T_RAW))
    const tRaw = await cdp.eval('window.__totalText()')
    check('界面不推断：服务端回 1 就显示 1（改口只在主进程）',
      approxOf(tRaw) === RAW_TOTAL, { tRaw })
    await shot(cdp, '02-raw-estimate-passed-through.png')

    // ── 3) 有数据的表：估算原样透传 ────────────────────────────
    check('打开大表', await openTable(T_BIG))
    const tBig = await cdp.eval('window.__totalText()')
    const rowsBig = Number(await cdp.eval('window.__rowCount()'))
    check('大表仍显示服务端估算 120000（本地逻辑不归零）',
      approxOf(tBig) === BIG_TOTAL, { tBig })
    // 只断言"有行"：网格是窗口化的，DOM 里的行数不等于桩返回的 50
    check('大表首屏有行', rowsBig > 0, { rowsBig })
    await shot(cdp, '03-big-keeps-estimate.png')

    const fails = results.filter(r => !r.ok)
    console.log('\n' + results.length + ' checks, ' + fails.length + ' fail')
    for (const f of fails) {
      console.log('  FAIL ' + f.name + ' ' + JSON.stringify(f.detail || {}))
    }
    finish(fails.length ? 1 : 0)
  } catch (e) {
    console.error('FATAL ' + e.message)
    try {
      console.error('主进程日志尾巴：\n' + fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n'))
    } catch (e2) {}
    finish(1)
  }
}

main()
