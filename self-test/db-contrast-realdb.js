#!/usr/bin/env node
/**
 * U2 · 网格文字对比度 —— 打**真** MariaDB（深/浅双主题，验收要的那两张图）
 *
 * 为什么桩库过了还要真库：桩表是我自己造的，"混合值"是我以为的混合；
 * 真库的 NULL 分布、空串密度、中文长文本的换行与列宽才是产品实际会遇到的画面。
 * 对比度是像素级结论，只有真实数据 + 真实渲染能给出"用户看到的那一屏够不够黑"。
 *
 * 判据算法**不复制**：从 self-test/db-contrast-probe.js require（桩库 demo 用的是同一份）。
 * 抄一份的话，桩库那份修过之后真库这份会悄悄退化，"真库也量过"就成了假话。
 *
 * 选表不是猜的（见 self-test/recon 口径）：`tgfsom_alarms` 118 行，
 * 同时具备 NULL（resolved_time）、空串（多个 varchar 列全空）、长文本（alarm_data 最长 494 字），
 * 且刻意避开 `*_log` / `audit` 类表 —— 那些列里是生产凭据材料，不该出现在任何截图里。
 *
 * 隐私纪律（生产库）：
 *   · 一条单元格内容都不回传 node：探针只返回比值/色值/字号/计数；
 *   · 参照查询只做聚合（COUNT / SUM(x IS NULL) / MAX(CHAR_LENGTH(x))），拿到的全是数字；
 *   · 页签 readOnly: true，渲染层 ops 全程监听，写类 op 与 executeSql 零出现；
 *   · 截图落 self-test/db-contrast-realdb-shots/（已 .gitignore，画面里是生产数据）。
 *
 * 凭据只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-contrast-realdb.js [debugPort]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败）。
 */
const fs = require('node:fs')
const path = require('node:path')
const mysql = require('mysql2/promise')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs,
  preStubState, ensureRealDbLayer
} = require('./db-ui-helpers')
const { PROBE, rgbClose, AA } = require('./db-contrast-probe')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-contrast-realdb-shots')
const SPLIT_KEY = 'electerm-db-contrast-realdb-split'
const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check, skip } = makeChecker()

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}
const TABLE = 'tgfsom_alarms'
// 最多翻几页去找 NULL 格（默认每页 20，本表 118 行）
const MAX_PAGES = 8

const G = {
  R1: '凭据齐备且脚本自身不含明文口令（护栏自证能抓住三种硬编码形态）',
  R2: '只读闸门：非只读 SQL 一律在发出前拒掉，只读的放行',
  A0: '渲染进程的数据库桥接是原装的（没有 demo 桩残留，或残留已自愈）',
  A1: '渲染进程可用、探针装好、无上一轮残留',
  A2: '真库连上，树里能看到库名',
  C1: '参照（服务端聚合计数）：这张表确实同时有 NULL / 空串 / 长文本',
  C2: '数据页真出现 NULL 格与空串格（翻页找过，不是桩造出来的）',
  C3: '屏面真有长文本格（只量长度，不读内容）',
  M1: '合成矩阵条目齐（格内 4 角色 × 3 底色 + 只会落在卡片底的 5 角色 = 17）',
  Z1: '零写：整轮只有读类 op，写类 op 与 executeSql 零命中',
  P1: '隐私自证：探针回传体里没有任何长文本（只有色值/比值/字号）',
  S1: '深/浅两张真库截图落盘'
}

// ---------- 只读闸门 ----------
const WRITE_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE|CALL|SET|LOCK|UNLOCK|KILL)\b/i
const assertReadOnly = sql => {
  const s = String(sql).trim()
  if (!/^(SELECT|SHOW|DESC|EXPLAIN)\b/i.test(s)) {
    throw new Error('非只读语句: ' + s.slice(0, 40))
  }
  if (/;/.test(s)) throw new Error('多语句: ' + s.slice(0, 40))
  const stripped = s.replace(/'(?:[^']|'')*'/g, "''").replace(/`[^`]*`/g, '``')
  if (WRITE_RE.test(stripped)) throw new Error('含写动词: ' + s.slice(0, 40))
  return s
}
const IDENT = /^[A-Za-z0-9_$]+$/
const col = (t, n) => {
  if (!IDENT.test(t) || !IDENT.test(n)) throw new Error('非法标识符: ' + t + '.' + n)
  return '`' + t + '`.`' + n + '`'
}

// ---------- 服务端参照：只出聚合数字 ----------
async function shapeOf (conn, table) {
  const [cols] = await conn.query(
    'SELECT COLUMN_NAME n, DATA_TYPE dt FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [ENV.db, table])
  const dt = cols.filter(x => /datetime|date|timestamp/.test(x.dt)).map(x => x.n)
  const st = cols.filter(x => /^(varchar|char)$/.test(x.dt)).map(x => x.n)
  const tx = cols.filter(x => /text|json/.test(x.dt)).map(x => x.n)
  const parts = ['COUNT(*) c0']
  // 括号不能省：`a IS NULL + b IS NULL` 会被解析成 `a IS (NULL + b) ...`，
  // 而 MAX() 只吃一个参数，跨列取最长得按列各出一个 MAX 再在本地比。
  if (dt.length) parts.push('SUM((' + dt.map(n => col(table, n) + ' IS NULL').join(') + (') + ') > 0) cNullRow')
  if (st.length) parts.push('SUM((' + st.map(n => col(table, n) + " = ''").join(') + (') + ') > 0) cEmptyRow')
  tx.forEach((n, i) => parts.push('MAX(CHAR_LENGTH(' + col(table, n) + ')) tx' + i))
  const [r] = await conn.query(assertReadOnly(
    'SELECT ' + parts.join(', ') + ' FROM `' + table + '`'))
  const o = r[0]
  return {
    rows: Number(o.c0),
    nullRows: Number(o.cNullRow || 0),
    emptyRows: Number(o.cEmptyRow || 0),
    maxTextLen: Math.max(0, ...tx.map((n, i) => Number(o['tx' + i]) || 0)),
    counts: { dt: dt.length, st: st.length, tx: tx.length, all: cols.length }
  }
}

// ---------- 页面探针 ----------
const PROBE2 = `
(() => {
  window.__ops = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    window.__opsOrig = orig
    window.__opsSpy = function (name, ...a) {
      if (name === 'dbClientOp') window.__ops.push(String(a[1]))
      return orig.apply(window.pre, arguments)
    }
    window.pre.runGlobalAsync = window.__opsSpy
    window.__opsSpied = 1
    return 'ok'
  }
  window.__restoreOps = () => {
    if (!window.__opsOrig) return 'nothing'
    window.pre.runGlobalAsync = window.__opsOrig
    window.__opsSpied = 0
    window.__opsOrig = null
    return 'restored'
  }
  window.__area = () => window.__one('.db-grid-area')
  window.__cellCount = sel => {
    const area = window.__area()
    if (!area) return -1
    return [...area.querySelectorAll(sel)].filter(window.__vis).length
  }
  // 只量"最长那一格有几个字符"，内容不外传（普通文本格没有 .db-cell 类，认 td 级格）
  window.__maxCellLen = () => {
    const area = window.__area()
    if (!area) return -1
    let m = 0
    for (const el of [...area.querySelectorAll('.ant-table-cell')].filter(window.__vis)) {
      const n = String(el.innerText || '').trim().length
      if (n > m) m = n
    }
    return m
  }
  window.__statusRows = () => {
    const area = window.__area()
    const el = area && [...area.querySelectorAll('.db-grid-page-rows')].filter(window.__vis)[0]
    return el ? String(el.innerText || '') : ''
  }
  window.__nextPage = () => {
    const area = window.__area()
    const btn = area && area.querySelector('.db-grid-pager button:has(.anticon-right)')
    if (!btn || btn.disabled) return 'no-next'
    btn.click()
    return 'clicked'
  }
  window.__checkRow = () => {
    const area = window.__area()
    if (!area) return 'no-area'
    const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[1]
    if (!row) return 'no-row'
    const box = row.querySelector('.ant-table-selection-column .ant-checkbox input, .ant-table-selection-column input[type=checkbox]')
    if (!box) return 'no-checkbox'
    box.click()
    return 'checked'
  }
  // 主题是否真的落到 CSS 变量上：setTheme 只改配置，React 重渲染 + 变量生效有延迟，
  // 靠固定 sleep 会量到"上一个主题"，所以这里等 --main 解析值稳定（两次读数相同）
  window.__mainLum = () => {
    const d = document.createElement('div')
    d.style.background = 'var(--main)'
    document.body.appendChild(d)
    const s = String(getComputedStyle(d).backgroundColor)
    d.remove()
    const m = /rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)/.exec(s)
    if (!m) return -1
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return Number((0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3])).toFixed(4))
  }
  return 'ok'
})()`

const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const findSecret = (text, v) => {
  if (!v) return false
  return new RegExp('(?:^|[^A-Za-z0-9_])' + escRe(v) + '(?![A-Za-z0-9_:])').test(String(text))
}

// 收尾必须真的把退出码交给进程：async IIFE 的返回值没人接，
// 只 return 的话 FAIL 也会以 0 退出，CI 读到的是"绿"。
const finish = () => {
  const skipped = results.filter(r => r.skipped).length
  const failed = results.filter(r => !r.ok).length
  console.log('\n' + (results.length - failed) + '/' + results.length + ' PASS（跳过 ' + skipped + '）')
  process.exit(failed ? 1 : 0)
}

const skipAll = reason => {
  for (const k of Object.keys(G)) {
    skip(G[k] + '（' + k + '）', reason)
  }
}

;(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // ---------- 凭据与护栏 ----------
  const missing = Object.entries(ENV).filter(([, v]) => v === undefined || v === null || v === '')
    .filter(([k]) => k !== 'pass').map(([k]) => k)
  const passGiven = ENV.pass !== undefined
  const src = fs.readFileSync(__filename, 'utf8')
  const hasSecret = findSecret(src, ENV.pass)
  const leakForms = ENV.pass
    ? ['  pass: ' + JSON.stringify(ENV.pass) + ',', 'RDB_MYSQL_PASS=' + ENV.pass, "const p = '" + ENV.pass + "'"]
    : []
  const caught = leakForms.filter(s => findSecret(s, ENV.pass)).length
  const keyNameOk = findSecret(ENV.pass + ": ENV.pass || '',", ENV.pass)
  check(G.R1 + '（R1）', missing.length === 0 && passGiven && !hasSecret &&
    caught === leakForms.length && keyNameOk === false, { missing, passGiven, hasSecret, caught, keyNameOk })
  let gReject = 0
  for (const bad of ['DELETE FROM t WHERE id=1', 'SELECT 1; DROP TABLE t', 'UPDATE t SET a=1',
    'INSERT INTO t VALUES (1)', 'SHOW CREATE TABLE t']) {
    try { assertReadOnly(bad) } catch (e) { gReject++ }
  }
  let gAccept = 0
  for (const good of ["SELECT COUNT(*) FROM `t` WHERE `n` = ''", 'SELECT 1 FROM `t` LIMIT 1']) {
    try { assertReadOnly(good); gAccept++ } catch (e) { console.log('guard false-reject: ' + e.message) }
  }
  check(G.R2 + '（R2）', gReject === 5 && gAccept === 2, { gReject, gAccept })
  if (missing.length || !passGiven || hasSecret || caught !== leakForms.length || keyNameOk ||
    gReject !== 5 || gAccept !== 2) {
    skipAll('缺凭据或护栏不自证：真库段整体跳过（不算通过）')
    console.log('用法: RDB_MYSQL_HOST/PORT/USER/PASS/DB node ' + path.basename(__filename))
    return finish()
  }

  // ---------- 服务端参照 ----------
  let shape = null
  let refErr = ''
  let conn = null
  try {
    conn = await mysql.createConnection({
      host: ENV.host, port: Number(ENV.port), user: ENV.user, password: ENV.pass, database: ENV.db
    })
    shape = await shapeOf(conn, TABLE)
  } catch (e) {
    refErr = String(e.message || e).slice(0, 120)
  } finally {
    if (conn) await conn.end()
  }
  check(G.C1 + '（C1）', !refErr && shape.rows > 0 && shape.nullRows > 0 && shape.emptyRows > 0 &&
    shape.maxTextLen > 60, { refErr, shape })
  if (refErr || !shape) {
    skipAll('真库不可达：' + refErr)
    return finish()
  }

  // ---------- 连真库、开数据页 ----------
  const ts = await getJson('http://127.0.0.1:' + PORT + '/json')
  const page = findPageTarget(ts)
  if (!page) throw new Error('没找到 electerm 页面，先起 --remote-debugging-port=' + PORT)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront')
  // 前置门：渲染进程里若还留着 demo 的数据库桩（pre.runGlobalAsync 被换掉且不还原），
  // "连上真库、树里有库名"这些判据全部只是看起来成立。ensureRealDbLayer 重载页面自愈，
  // 重载后仍不干净直接抛。
  const pre0 = await preStubState(cdp)
  const layer = await ensureRealDbLayer(cdp)
  if (layer.reloaded) console.log('WARN 数据库层有桩残留（' + layer.was + '），已重载页面自愈')
  check(G.A0 + '（A0）', layer.state === 'ok', { pre0, layer })
  const booted = await waitFor(cdp, '!!window.store', 'store ready', 60000)
  if (!booted) throw new Error('渲染进程没起来')
  await cdp.eval(HELPERS)
  await cdp.eval(PROBE2)
  const spy = await cdp.eval('window.__spyOps()')
  const ready = await cdp.eval('(() => [typeof window.__mainLum, typeof window.__clickTree, ' +
    'typeof window.__cellCount, window.__ops.length].join("|"))()')
  check(G.A1 + '（A1）', spy === 'ok' && ready === 'function|function|function|0', { booted, spy, ready })
  const theme0 = String(await cdp.eval('String((window.store._config || {}).theme)'))
  const cleared = await clearDbTabs(cdp)
  if (cleared.left.length) {
    console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(cleared.left))
  }
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'contrast realdb',
      dbType: 'mysql', dbHost: ${JSON.stringify(ENV.host)}, dbPort: Number(${JSON.stringify(ENV.port)}),
      dbUser: ${JSON.stringify(ENV.user)}, dbPassword: ${JSON.stringify(ENV.pass)},
      dbName: ${JSON.stringify(ENV.db)}, dbSsl: false,
      readOnly: true, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const tabId = String(await cdp.eval('String(window.store.activeTabId)'))
  // 树节点是元数据回来后异步挂上去的：只等 ".db-tree 存在" 会在空树上点不到库名
  const treeShown = await waitFor(cdp,
    'window.__hasTree && window.__hasTree(' + JSON.stringify(ENV.db) + ')', 'tree with db node', 60000)
  check(G.A2 + '（A2）', treeShown, { treeShown })

  let gridOk = false
  if (treeShown) {
    // 先点库节点展开，再点表；直接点表名在折叠状态下找不到节点
    await cdp.eval('window.__clickTree(' + JSON.stringify(ENV.db) + ')')
    const tableShown = await waitFor(cdp,
      'window.__hasTree(' + JSON.stringify(TABLE) + ')', 'table node', 20000)
    if (tableShown) {
      await cdp.eval('window.__clickTree(' + JSON.stringify(TABLE) + ')')
      gridOk = await waitFor(cdp, '!!window.__one(".db-grid-area .ant-table-row")', 'data grid', 30000)
    }
  }
  // 翻页找 NULL 格与空串格（真库的 NULL 不一定落在第一屏）
  let pages = 0
  let nullCells = 0
  let emptyCells = 0
  let maxLen = 0
  if (gridOk) {
    for (; pages < MAX_PAGES; pages++) {
      nullCells = await cdp.eval('window.__cellCount(".db-cell-null")')
      emptyCells = await cdp.eval('window.__cellCount(".db-cell-empty")')
      maxLen = await cdp.eval('window.__maxCellLen()')
      if (nullCells > 0 && emptyCells > 0 && maxLen > 60) break
      if (await cdp.eval('window.__nextPage()') !== 'clicked') break
      await sleep(900)
    }
  }
  check(G.C2 + '（C2）', gridOk && nullCells > 0 && emptyCells > 0,
    { gridOk, pagesScanned: pages + 1, nullCells, emptyCells })
  check(G.C3 + '（C3）', maxLen > 60, { maxCellCharsVisible: maxLen, refMaxTextLen: shape.maxTextLen })

  // 勾一行，让"真实选中行"这条对照有对象
  const checked = await cdp.eval('window.__checkRow()')
  await sleep(600)
  const selCount = await cdp.eval('window.__cellCount(".ant-table-row.ant-table-row-selected")')
  check('选中行对照有对象（X1）', checked === 'checked' && selCount > 0, { checked, selCount })

  // ---------- 逐个主题量一遍 ----------
  // 不只量"当前深色 + 一个浅色"：U2c 当初是在 default 上过的，而用户实际吃的主题
  // 可能是第三方深底（本例 iterm#Cobalt2 的 --main 比 default 亮一档，
  // 固定色值 --text-dark 在上面就掉破 4.5）。主题清单全扫，才叫"实测"。
  // 清单三部分组成，缺一个就有盲区：
  //   · 用户当前主题——他真正看到的那一屏；getTerminalThemes() 只给内置 + 自建主题，
  //     iterm 第三方主题不在里面（本轮就是被这个漏掉的）
  //   · 内置深/浅——产品口径的两个极端
  //   · 第三方主题等距抽样——"比 default 亮的深底"这类中间档位
  // 抽样用固定步长而不是随机：同一实例重跑要能拿到同一组主题，红才可复现。
  const SWEEP_N = Number(process.env.U2_SWEEP_N || 8)
  const baseIds = await cdp.jeval('JSON.stringify((window.store.getTerminalThemes() || []).map(t => t.id))')
  const allIds = await cdp.jeval("JSON.stringify((window.store.getSidebarList('terminalThemes') || []).map(t => t.id))")
  const themes = []
  const pushTheme = id => {
    if (id && themes.indexOf(id) < 0) themes.push(String(id))
  }
  pushTheme(theme0)
  ;(baseIds || []).forEach(pushTheme)
  const pool = (allIds || []).filter(id => themes.indexOf(String(id)) < 0)
  const step = Math.max(1, Math.floor(pool.length / Math.max(1, SWEEP_N)))
  for (let i = 0; i < pool.length && themes.length < 3 + SWEEP_N; i += step) pushTheme(pool[i])
  check('主题清单可读（T0）', themes.length >= 3 && themes.indexOf(theme0) === 0,
    { n: themes.length, pool: pool.length, first: themes[0] })
  const shots = []
  const seen = []
  for (const id of themes) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(id) + ')')
    // 等 --main 解析值稳定，避免量到上一个主题
    let lum = -1
    let prev = null
    let settle = 0
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      lum = await cdp.eval('window.__mainLum()')
      if (prev !== null && lum === prev) { settle++; if (settle >= 2) break } else settle = 0
      prev = lum
    }
    const kind = lum >= 0.2 ? 'light' : 'dark'
    seen.push({ id, kind, lum })
    const { matrix, real } = JSON.parse(await cdp.eval(PROBE))
    const bad = matrix.filter(m => m.ratio < AA)
    check('合成矩阵条目齐（' + id + '）', matrix.length === 17, { n: matrix.length })
    check('全部角色 × 底色 ≥ ' + AA + '（' + id + '）', bad.length === 0,
      bad.length ? bad.slice(0, 4) : { worst: Math.min(...matrix.map(m => m.ratio)) })
    const miss = real.filter(r => r.miss).map(r => r.label)
    const bgBad = real.filter(r => !r.miss && !rgbClose(r.bgSolid, r.want)).map(r => r.label)
    const lowBad = real.filter(r => !r.miss && r.ratio < AA).map(r => ({ l: r.label, v: r.ratio }))
    check('实机对照三类元素都在（' + id + '）', miss.length === 0, { miss })
    check('实机底色与合成底一致（' + id + '）', bgBad.length === 0, { bgBad })
    check('实机三格 ≥ ' + AA + '（' + id + '）', lowBad.length === 0, { lowBad })
    // 隐私自证：探针回传体里不许出现任何长文本（色值/字号/比值都远短于此）
    const longestField = Math.max(...[...matrix, ...real].flatMap(o => Object.values(o))
      .filter(v => typeof v === 'string').map(v => v.length))
    check('隐私自证：探针回传无长文本（' + id + '）', longestField <= 40, { longestField })
    const shot = await cdp.shot(path.join(SHOT_DIR, 'realdb-' + kind + '-' + String(id).replace(/[^A-Za-z0-9_.-]/g, '_') + '.png'))
    shots.push(shot)
  }
  check(G.S1 + '（S1）', shots.length === (themes || []).length &&
    shots.every(s => fs.existsSync(s)) &&
    seen.some(s => s.kind === 'dark') && seen.some(s => s.kind === 'light'),
  { shots: shots.length, seen })
  console.log('主题扫描: ' + JSON.stringify(seen))

  // ---------- 零写 ----------
  const ops = await cdp.jeval('JSON.stringify(window.__ops)')
  const uniq = [...new Set(ops || [])]
  const WRITE_OPS = ['updateCell', 'updateCells', 'insertRow', 'deleteRows', 'executeSql']
  const hits = uniq.filter(o => WRITE_OPS.indexOf(o) >= 0)
  check(G.Z1 + '（Z1）', uniq.length > 0 && hits.length === 0, { ops: uniq, total: (ops || []).length, hits })
  // ---------- 还原 ----------
  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  await sleep(500)
  const restored = await cdp.eval('window.__restoreOps()')
  await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(tabId) + ') })()')
  await sleep(500)
  console.log('restored: ops=' + restored + ' theme=' + theme0 + ' tab=' + tabId)
  console.log('shots → ' + SHOT_DIR)
  console.log('参照: ' + JSON.stringify(shape))
  console.log('隐私纪律: 一条单元格内容都不回传，参照只取聚合计数；截图不入库')
  return finish()
})().catch(e => {
  console.log('THROWN: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  process.exit(1)
})
