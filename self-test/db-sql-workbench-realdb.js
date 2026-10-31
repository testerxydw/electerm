#!/usr/bin/env node
/**
 * SQL 结果工具行 · 本页过滤 —— 真库 CDP 验收（MySQL，只读）
 *
 * 桩数据能证明分支，证明不了"驱动给的真实值形态 + 真实行量"。这份跑真实链路：
 * 主进程 mysql2 取数 → IPC → 网格；过滤在渲染层扫整份结果。
 *
 * 要真库才验得到的四件事：
 *   1) 真实 BLOB 的 __bin 信封能不能按「<binary 8 bytes>」筛（桩里的信封是手写的）；
 *   2) 真实 DECIMAL 的文本精度能不能整串命中（CAST 出来的 1234567.8912）；
 *   3) 真实 NULL 列按格子里的 "NULL" 筛（不是按空串）；
 *   4) 5000 行真实结果上，"筛的是整份还是当前页""命中数与 SQL 参照是否一致"
 *      这两条只有存在跨页命中时才分得出来。
 *
 * 参照系（oracle）不是产品的实现拷贝：命中数、首末行 id 全部交给**数据库**自己算
 * （同一条 WHERE ... LIKE 谓词、同一个窗口），页面只报数字；id 这类内容不回传，
 * 只比 djb2 哈希。生产的 tgfsom 库里 parameter 列有口令散列，所以这条纪律不是洁癖。
 *
 * 对生产库的护栏（本脚本自约束）：
 *   · 只发单条 SELECT；含写/DDL 关键字或分号拼接的文本在 node 侧就抛，根本不进页面；
 *   · 连接用 readOnly: false（要不编辑器不让打字），所以"只读"全靠 assertSelectOnly；
 *   · 判据输出里不出现任何单元格原文，只有数字、布尔、长度与哈希。
 *
 * 凭据只从环境变量读：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-sql-workbench-realdb.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, clickCell, findPageTarget, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-workbench-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const PAGE = 200
const WANTED = 5000
const DEBOUNCE = 150
const SAMPLE_TABLE = 'tgfsom_operation_log'
const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}

// 合成查询：不碰业务表，只为把"十进制 / 日期 / 三万字符 / 二进制 / NULL / 文本"
// 六种真实列形态凑齐。值由数据库算出来，形态就是驱动给的形态
const SQL_TYPED = `SELECT CAST('1234567.8912' AS DECIMAL(18,4)) AS amount,
CAST('2026-03-05 14:23:45' AS DATETIME) AS dt,
REPEAT('x', 30000) AS payload,
X'0001020304050607' AS blob_col,
NULL AS nothing,
'Hello-WORLD' AS note`

// 真表：主键倒序取 5000 行（25 页）。只取 4 列，够筛、又不会把 parameter 那种长文本搬进内存
const SAMPLE_COLS = 'id, operate_type, level, status'
const SQL_BIG = 'SELECT ' + SAMPLE_COLS + ' FROM ' + SAMPLE_TABLE +
  ' ORDER BY id DESC LIMIT ' + WANTED

// 参照查询：同一个谓词交给数据库算。IFNULL(x,'NULL') 与格子里"NULL 文本"对齐；
// 默认排序规则（*_ci）本身就大小写不敏感，与产品语义一致
const sqlCount = q => {
  const needle = String(q)
  if (/[%_\\']/.test(needle)) {
    throw new Error('needle 含 SQL 通配/引号，拒绝拼进参照查询: ' + needle.slice(0, 8))
  }
  const like = "(CAST(id AS CHAR) LIKE '%" + needle + "%' OR IFNULL(operate_type, 'NULL') LIKE '%" +
    needle + "%' OR IFNULL(level, 'NULL') LIKE '%" + needle + "%' OR IFNULL(status, 'NULL') LIKE '%" + needle + "%')"
  return 'SELECT COUNT(*) AS n FROM (SELECT ' + SAMPLE_COLS + ' FROM ' + SAMPLE_TABLE +
    ' ORDER BY id DESC LIMIT ' + WANTED + ') t WHERE ' + like
}
const SQL_MINMAX = 'SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM (SELECT id FROM ' +
  SAMPLE_TABLE + ' ORDER BY id DESC LIMIT ' + WANTED + ') t'
// 跨页判据要一个"样本里大量出现"的 needle。写死 INFO 会随真实数据漂移
// （这份 5000 行样本里一个 INFO 都没有），所以让数据库报当前样本里最多的 level 值
const SQL_TOPLEVEL = 'SELECT level AS lv, COUNT(*) AS n FROM (SELECT level FROM ' +
  SAMPLE_TABLE + ' ORDER BY id DESC LIMIT ' + WANTED + ') t GROUP BY level ORDER BY n DESC LIMIT 1'

// —— 只读护栏 ——
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|rename|call|execute|set|lock|unlock|load|kill|shutdown|handler|commit|rollback|savepoint|prepare|deallocate)\b/i
const assertSelectOnly = sql => {
  const s = String(sql).trim().replace(/;+$/, '')
  if (!/^select\b/i.test(s)) {
    throw new Error('非 SELECT 起始，拒绝发往真库: ' + s.slice(0, 40))
  }
  if (s.indexOf(';') >= 0) {
    throw new Error('检测到分号（多语句拼接），拒绝发往真库')
  }
  const bad = WRITE_WORDS.exec(s)
  if (bad) {
    throw new Error('语句含写/DDL 关键字 ' + bad[1] + '，拒绝发往真库')
  }
  return s
}

// 与页面 window.__hash 同一个 djb2：只为了"这条判据指的是不是那一行"，
// 值本身不进 node 的日志
const djb2 = s => {
  let h = 5381
  const t = String(s === null || s === undefined ? '' : s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return h
}

// 真库判据的输出纪律：内容一律不落终端
const pick = (o, keys) => {
  const r = {}
  for (const k of keys) {
    if (o && o[k] !== undefined) {
      r[k] = typeof o[k] === 'string' && o[k].length > 40 ? o[k].slice(0, 40) + '…' : o[k]
    }
  }
  return r
}

// 过滤专项探针（与该批次桩版脚本同一套；多结果集时只看看得见的那一处）
const PROBE = `
(() => {
  const tools = () => [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0] || null
  window.__fWrap = () => {
    const t = tools()
    const w = t && t.querySelector('.db-sql-filter')
    return w && window.__vis(w) ? w : null
  }
  window.__fInput = () => {
    const w = window.__fWrap()
    const i = w && w.querySelector('input')
    return i && window.__vis(i) ? i : null
  }
  window.__fSet = text => {
    const i = window.__fInput()
    if (!i) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, String(text))
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__fValue = () => {
    const i = window.__fInput()
    return i === null ? null : String(i.value)
  }
  window.__fClear = () => {
    const w = window.__fWrap()
    const x = w && w.querySelector('.ant-input-clear-icon')
    if (!x || !window.__vis(x)) return 'no-clear'
    x.click()
    return 'ok'
  }
  window.__fHit = () => {
    const t = tools()
    const el = t && [...t.querySelectorAll('.db-sql-filter-hit')].filter(window.__vis)[0]
    if (!el) return JSON.stringify({ exists: 0 })
    const txt = String(el.innerText || '').trim()
    const m = /([0-9]+)[^0-9]+([0-9]+)/.exec(txt)
    return JSON.stringify({
      exists: 1,
      text: txt,
      m: m ? Number(m[1]) : -1,
      t: m ? Number(m[2]) : -1,
      emptyCls: /db-sql-filter-hit-empty/.test(String(el.className)) ? 1 : 0
    })
  }
  window.__fTools = () => {
    const t = tools()
    if (!t) return JSON.stringify({ exists: 0 })
    const vis = els => [...els].filter(window.__vis)
    return JSON.stringify({
      exists: 1,
      filter: window.__fWrap() ? 1 : 0,
      placeholder: window.__fInput() ? String(window.__fInput().placeholder) : '',
      pagesize: vis(t.querySelectorAll('.db-grid-pagesize')).length,
      buttons: vis(t.querySelectorAll('button')).length,
      // 分页器已换成与数据页同一份 DbGridPager（没有 antd 页码按钮）：
      // 末页从跳页框 placeholder（'1-25'）读，当前页从 .db-grid-page-no 解析
      pager: vis(t.querySelectorAll('.db-grid-pager')).length,
      maxPage: (() => {
        const i = vis(t.querySelectorAll('.db-grid-pager .db-grid-jump input'))[0]
        const m = i ? String(i.getAttribute('placeholder') || '').match(/([0-9]+)[^0-9]*$/) : null
        return m ? Number(m[1]) : -1
      })(),
      current: (() => {
        const el = vis(t.querySelectorAll('.db-grid-pager .db-grid-page-no'))[0]
        const m = el ? String(el.innerText || '').match(/([0-9]+)/) : null
        return m ? Number(m[1]) : -1
      })(),
      totalText: (() => {
        const el = vis(t.querySelectorAll('.db-grid-pager .db-grid-total'))[0]
        return el ? String(el.innerText || '').trim() : ''
      })()
    })
  }
  // 防抖:量的是"敲下第一个字 → 命中数真的变了"这一段
  window.__fArm = () => {
    window.__fT0 = performance.now()
    window.__fAt = null
    if (window.__fObs) window.__fObs.disconnect()
    let prev = (() => {
      const h = JSON.parse(window.__fHit())
      return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
    })()
    window.__fObs = new MutationObserver(() => {
      const now = (() => {
        const h = JSON.parse(window.__fHit())
        return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
      })()
      if (now !== prev) {
        prev = now
        if (window.__fAt === null) window.__fAt = performance.now()
      }
    })
    window.__fObs.observe(document.body, { childList: true, subtree: true, characterData: true })
    return 'armed'
  }
  window.__fPeek = () => JSON.stringify({
    since: Math.round(performance.now() - window.__fT0),
    hit: JSON.parse(window.__fHit()).exists,
    rows: window.__rows().length
  })
  window.__fElapsed = () => (window.__fAt === null ? -1 : Math.round(window.__fAt - window.__fT0))
  // 首行 id 的哈希（值不外传，只回哈希）
  window.__firstIdHash = () => {
    const td = window.__tdOf('id', 0)
    return td ? window.__hash(String(td.textContent || '').trim()) : null
  }
  window.__colTextHash = label => {
    const td = window.__tdOf(label, 0)
    return td ? window.__hash(String(td.textContent || '').trim()) : null
  }
  // 纯前端判据：过滤期间 executeSql 次数不能变
  window.__execN = 0
  const orig = window.pre.runGlobalAsync
  if (typeof orig === 'function' && !orig.__wbSpy) {
    const wrapped = function (name, ...a) {
      if (name === 'dbClientOp' && a[1] === 'executeSql') window.__execN += 1
      return orig.apply(window.pre, arguments)
    }
    wrapped.__wbSpy = 1
    window.pre.runGlobalAsync = wrapped
  }
  return 'probe-installed'
})()
`

let cdpRef = null
const cfg0 = { locale: null, pageSize: null, sqlPageSize: null, theme: null, split: null }
const openedTabs = []

const restoreAll = async () => {
  if (!cdpRef) {
    return
  }
  try {
    for (const id of openedTabs) {
      await cdpRef.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
    }
    if (cfg0.locale !== null) {
      await cdpRef.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale) + ' })')
    }
    if (cfg0.pageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ dbPageSize: ' + Number(cfg0.pageSize) + ' })')
    }
    if (cfg0.sqlPageSize !== null && Number(cfg0.sqlPageSize) >= 10) {
      await cdpRef.eval('window.store.setConfig({ sqlResultPageSize: ' + Number(cfg0.sqlPageSize) + ' })')
    }
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    await cdpRef.eval('window.__setLs(' + JSON.stringify(cfg0.split) + ')')
    console.log('restored: tabs=' + openedTabs.length + ' ' + JSON.stringify(cfg0))
  } catch (e) {
    console.log('restore failed (check dbPageSize/sqlResultPageSize/theme/' + SPLIT_KEY + ' manually): ' + e.message)
  }
}

let reported = false
const finish = async () => {
  if (!reported && cdpRef) {
    reported = true
    try {
      const hard = cdpRef.events.filter(e => /^(EX |ERROR|LOG )/.test(e))
      console.log('\nrenderer hard events (' + hard.length + '):')
      hard.slice(-10).forEach(l => console.log('  ' + l))
      console.log('renderer events total: ' + cdpRef.events.length)
    } catch (e) {
      console.log('event dump failed: ' + e.message)
    }
  }
  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  return fail.length
}

const errDump = () => `(() => {
  const vis = window.__vis
  const alerts = [...document.querySelectorAll('.ant-alert-message')].filter(vis).map(x => x.innerText.trim()).slice(0, 2)
  // 连不上时应用给的是 .db-session-error 整页（不是 antd 告警条）：只查 .ant-alert-message
  // 会把屏幕上明晃晃的"连接数据库失败 · Access denied"读成"没错误"，判据红了也说不清为什么
  const connErr = [...document.querySelectorAll('.db-session-error')].filter(vis)
    .map(x => x.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 2)
  return JSON.stringify({
    tabs: [...document.querySelectorAll('.ant-tabs-tab')].filter(vis).map(x => x.innerText.trim()),
    alerts,
    connErr,
    spin: [...document.querySelectorAll('.ant-spin-spinning')].filter(vis).length,
    rows: window.__rows().length
  })
})()`

const setSql = async (cdp, sql) => {
  const safe = assertSelectOnly(sql)
  const focused = await cdp.eval('window.__focusSql()')
  if (focused !== 'focused') {
    return { ok: false, why: focused }
  }
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
  await cdp.call('Input.insertText', { text: safe })
  await sleep(250)
  const doc = String(await cdp.eval('window.__sqlDoc()'))
  return { ok: doc.indexOf(safe.slice(0, 40)) === 0, doc }
}

const runSql = async (cdp, sql, readyExpr, label) => {
  const set = await setSql(cdp, sql)
  if (!set.ok) {
    return { ok: false, stage: 'set', set }
  }
  const clicked = await cdp.eval('window.__clickRunSql()')
  const ready = await waitFor(cdp, readyExpr, label, 60000)
  await sleep(500)
  return { ok: clicked === 'ok' && ready, clicked, ready }
}

// 写过滤词：arm 与 set 压在同一个往返里，否则 150ms 窗口会被往返吃掉
const typeFilter = async (cdp, text) => {
  const set = await cdp.eval('window.__fArm(); window.__fSet(' + JSON.stringify(text) + ')')
  const peek = await cdp.jeval('window.__fPeek()')
  const t0 = Date.now()
  let changed = false
  while (Date.now() - t0 < 8000) {
    if (Number(await cdp.eval('window.__fElapsed()')) >= 0) {
      changed = true
      break
    }
    await sleep(40)
  }
  await sleep(300)
  return { set: String(set).slice(-2), peek, changed, elapsed: Number(await cdp.eval('window.__fElapsed()')) }
}

const readHit = async cdp => JSON.parse(await cdp.eval('window.__fHit()'))
const readTools = async cdp => JSON.parse(await cdp.eval('window.__fTools()'))
// 合成结果集只有 1 行，好几个词都命中同一行 → 命中提示字面都是「1/1」，
// 防抖探针按"命中文本 + 行数"判断变化时看不出新词生效。先敲「词+不存在后缀」
// 把命中压到 0，再敲原词回到 1 —— 0→1 才证明起作用的是这个词本身。
const verifyWord = async (cdp, word) => {
  const neg = await typeFilter(cdp, word + ' zzz')
  const negHit = await readHit(cdp)
  const pos = await typeFilter(cdp, word)
  const posHit = await readHit(cdp)
  return {
    negChanged: neg.changed,
    negM: negHit.m,
    posChanged: pos.changed,
    posM: posHit.m,
    ok: neg.changed && negHit.m === 0 && pos.changed && posHit.m === 1
  }
}
const clearFilter = async cdp => {
  const r = await cdp.eval('window.__fClear()')
  await sleep(800)
  return r
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  // ---------- R) 前置：凭据纪律 + 护栏自证 ----------
  // 空口令是合法配置（这台 MariaDB 的 root 没设密码），但环境变量必须**显式存在**：
  // 按 undefined 判漏配，按真假值判会把空口令误报成"凭据缺失"
  const missing = Object.entries(ENV)
    .filter(([, v]) => v === undefined || v === null || v === '')
    .filter(([k]) => k !== 'pass')
    .map(([k]) => k)
  const passGiven = ENV.pass !== undefined
  const src = fs.readFileSync(__filename, 'utf8')
  const hasSecret = [ENV.pass].filter(Boolean).some(p => src.includes(p))
  check('R1 凭据全部来自环境变量、脚本正文不含口令',
    missing.length === 0 && passGiven && !hasSecret, { missing, passGiven, hasSecret })
  if (missing.length || !passGiven || hasSecret) {
    console.log('用法: RDB_MYSQL_HOST/PORT/USER/PASS/DB node ' + path.basename(__filename))
    return 1
  }
  let rejected = 0
  for (const bad of [
    'DELETE FROM ' + SAMPLE_TABLE + ' WHERE id=1',
    'SELECT 1; DROP TABLE ' + SAMPLE_TABLE,
    'UPDATE ' + SAMPLE_TABLE + ' SET level=1',
    'SHOW CREATE TABLE ' + SAMPLE_TABLE
  ]) {
    try {
      assertSelectOnly(bad)
    } catch (e) {
      rejected++
    }
  }
  let accepted = 0
  for (const good of [SQL_TYPED, SQL_BIG, SQL_MINMAX, sqlCount('INFO')]) {
    try {
      assertSelectOnly(good)
      accepted++
    } catch (e) {
      console.log('guard false-reject: ' + e.message)
    }
  }
  check('R2 只读护栏：4 条非 SELECT 全拒、本脚本 4 条参照语句全放行',
    rejected === 4 && accepted === 4, { rejected, accepted })
  if (rejected !== 4 || accepted !== 4) {
    return 1
  }

  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('没有渲染进程目标；应用是否带 --remote-debugging-port 启动？')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  check('R3 渲染进程可用（window.store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  await cdp.eval(HELPERS)
  await sleep(300)
  await cdp.eval(PROBE)
  check('R4 探针就绪（过滤/整行哈希/executeSql 计数），且真库验收里没有夹具',
    await cdp.eval('typeof window.__fHit') === 'function' &&
    await cdp.eval('typeof window.__firstIdHash') === 'function' &&
    await cdp.eval('typeof window.__fixture') === 'undefined')

  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  cfg0.pageSize = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  cfg0.sqlPageSize = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const ls0 = await cdp.eval('window.__ls()')
  cfg0.split = ls0 === 'null' ? null : ls0
  await cdp.eval('window.localStorage.removeItem(' + JSON.stringify(SPLIT_KEY) + ')')
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: ' + PAGE + ', sqlResultPageSize: ' + PAGE + ' })')
  await sleep(300)
  check('R5 结果列宽/行数按本脚本设定（每页 ' + PAGE + '）',
    Number(await cdp.eval('window.store._config.sqlResultPageSize')) === PAGE,
    { pageSize: await cdp.eval('window.store._config.sqlResultPageSize') })

  // ---------- Q) 真连接 ----------
  // 先清干净再开自己的页签：持久化页签在 Page.reload 后是异步恢复的，恢复过程会把
  // activeTabId 改成它自己，上一份脚本留下的桩页签会把判据带到错误的 DOM 上
  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) {
    console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))
  }
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect',
      title: 'mysql workbench',
      dbType: 'mysql', dbHost: ${JSON.stringify(ENV.host)}, dbPort: Number(${JSON.stringify(ENV.port)}),
      dbUser: ${JSON.stringify(ENV.user)}, dbPassword: ${JSON.stringify(ENV.pass)},
      dbName: ${JSON.stringify(ENV.db)}, dbSsl: false,
      readOnly: false, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  openedTabs.push(await cdp.eval('String(window.store.activeTabId)'))
  const treeShown = await waitFor(cdp,
    '!!window.__one(".db-tree") || !!window.__one(".db-session-error")', 'real tree or conn error', 60000)
  // 走 __one（可见性过滤）：document.querySelector 会先命中别的页签留在 DOM 里的隐藏树
  const treeText = await cdp.eval('String(((window.__one(".db-tree") || { innerText: "" })).innerText)')
  const dumpQ1 = await cdp.jeval(errDump())
  check('Q1 真库页签打开并建连（树里出现库名，无错误告警）',
    treeShown && String(treeText).indexOf(ENV.db) >= 0 &&
    dumpQ1.alerts.length === 0 && !(dumpQ1.connErr || []).length,
    { treeShown, hasDbName: String(treeText).indexOf(ENV.db) >= 0, blocked: (dumpQ1.connErr || [])[0] || '' })
  const dbNode = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(ENV.db) + ')')
  const tableShown = await waitFor(cdp, 'window.__hasTree(' + JSON.stringify(SAMPLE_TABLE) + ')',
    'table node under ' + ENV.db, 40000)
  const tableNode = await cdp.eval('window.__clickTree(' + JSON.stringify(SAMPLE_TABLE) + ')')
  await sleep(900)
  check('Q2 树里展开库并选中样本表（SQL 页的前置）',
    dbNode === 'ok' && tableShown && tableNode === 'ok', { dbNode, tableShown, tableNode })
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(600)

  // ---------- S) 合成类型查询：真实列形态上的过滤语义 ----------
  const run1 = await runSql(cdp, SQL_TYPED,
    'window.__colIdx("blob_col") >= 0 && window.__rows().length === 1', 'typed result')
  const heads1 = JSON.parse(await cdp.eval('window.__headerLabels()'))
  check('S1 合成查询真跑通：1 行 × 6 列（amount/dt/payload/blob_col/nothing/note）',
    run1.ok && heads1.join(',') === 'amount,dt,payload,blob_col,nothing,note', { heads1 })
  check('S2 过滤框在位，占位文案是词条',
    (await readTools(cdp)).filter === 1 && !/[{}]/.test((await readTools(cdp)).placeholder), await readTools(cdp))

  const sBin = await typeFilter(cdp, '8 bytes')
  check('S3 真实 BLOB 的 __bin 信封按「<binary 8 bytes>」可筛（桩测不出的驱动形态）',
    sBin.changed && (await readHit(cdp)).m === 1, { hit: await readHit(cdp), elapsed: sBin.elapsed })
  const sNull = await verifyWord(cdp, 'null')
  check('S4 真实 NULL 列按格子里的 "NULL" 筛（不是按空串）',
    sNull.ok, sNull)
  const sCase = await verifyWord(cdp, 'hello')
  check('S5 文本列大小写不敏感（Hello-WORLD 被 hello 命中）',
    sCase.ok, sCase)
  const sDec = await verifyWord(cdp, '1234567.8912')
  check('S6 真实 DECIMAL 的整串精度可命中（CAST 出来的本位文本，不是浮点评分）',
    sDec.ok, sDec)
  const sNone = await typeFilter(cdp, 'zzz-not-in-row')
  const toolsNone = await readTools(cdp)
  check('S7 零命中：红色 0/1，且页大小/导出/列宽工具不被筛没',
    sNone.changed && (await readHit(cdp)).m === 0 && (await readHit(cdp)).emptyCls === 1 &&
    toolsNone.pagesize === 1 && toolsNone.buttons >= 2, { hit: await readHit(cdp), tools: pick(toolsNone, ['pagesize', 'buttons']) })
  await clearFilter(cdp)

  // ---------- T) 5000 行真结果：命中数与 SQL 参照一致 ----------
  const run2 = await runSql(cdp, SQL_BIG,
    'window.__colIdx("level") >= 0 && window.__rows().length > 5', 'big result')
  const t0s = await readTools(cdp)
  const firstHash0 = Number(await cdp.eval('window.__firstIdHash()'))
  check('T1 真表 5000 行到位、25 页、分页器在工具行',
    run2.ok && t0s.pager === 1 && t0s.maxPage === WANTED / PAGE, pick(t0s, ['maxPage', 'totalText']))

  // 参照：同一谓词交给数据库（先记 max/min，后面既当参照也当"首末行是否指对"的锚）
  const mm = await runSql(cdp, SQL_MINMAX, 'window.__rows().length === 1', 'minmax')
  const minId = Number(await cdp.eval('String(window.__tdOf("min_id", 0).textContent).trim()'))
  const maxId = Number(await cdp.eval('String(window.__tdOf("max_id", 0).textContent).trim()'))
  check('T2 参照锚点取到（样本内 min/max id 都是正数，且 min < max）',
    mm.ok && Number.isFinite(minId) && Number.isFinite(maxId) && minId > 0 && minId < maxId,
    { minOk: minId > 0, maxOk: maxId > 0, ordered: minId < maxId })
  check('T2b 样本首行就是 max id（刚才是倒序取的 5000 行）',
    firstHash0 === djb2(maxId), { anchor: 'max', same: firstHash0 === djb2(maxId) })

  // 回到真表结果再筛
  const run2b = await runSql(cdp, SQL_BIG, 'window.__rows().length > 5', 'big result again')
  check('T3 重新执行清空过滤状态（输入框空、无命中提示）',
    run2b.ok && (await cdp.eval('window.__fValue()')) === '' && (await readHit(cdp)).exists === 0)

  // 跨页 needle 由数据库给（见 SQL_TOPLEVEL 注释）；内容只报长度，不落终端
  const runLv = await runSql(cdp, SQL_TOPLEVEL, 'window.__rows().length === 1', 'top level')
  const topLv = String(await cdp.eval('String(window.__tdOf("lv", 0).textContent).trim()'))
  const topN = Number(await cdp.eval('String(window.__tdOf("n", 0).textContent).trim()'))
  check('T3b 取样：最常出现的 level 值在样本里超过一页，且能安全拼进参照 LIKE',
    runLv.ok && topN > PAGE && topLv.length > 0 && !/['%_\\]/.test(topLv),
    { topN, len: topLv.length })
  await runSql(cdp, SQL_BIG, 'window.__rows().length > 5', 'big result for filter')

  const execBefore = Number(await cdp.eval('window.__execN'))
  const tTop = await typeFilter(cdp, topLv)
  const hitTop = await readHit(cdp)
  const toolsTop = await readTools(cdp)
  check('T4 5000 行上筛最常见的 level 值：不是只筛当前 200 行（命中数跨页）',
    tTop.changed && hitTop.exists === 1 && hitTop.m > PAGE && hitTop.m >= topN,
    pick(hitTop, ['m', 't', 'emptyCls']))
  check('T5 分页口径换成命中数：页数 = ceil(命中/每页)，底纹总数跟着',
    toolsTop.pager === 1 && toolsTop.maxPage === Math.ceil(hitTop.m / PAGE) &&
    String(toolsTop.totalText).indexOf(String(hitTop.m)) >= 0,
    { m: hitTop.m, maxPage: toolsTop.maxPage, totalText: toolsTop.totalText })
  check('T6 纯前端过滤：过滤期间 executeSql 一次都没再发',
    Number(await cdp.eval('window.__execN')) === execBefore,
    { before: execBefore, after: await cdp.eval('window.__execN') })

  // 参照：数据库自己算的命中数
  const run3 = await runSql(cdp, sqlCount(topLv), 'window.__rows().length === 1', 'count top level')
  const oracleInfo = Number(await cdp.eval('String(window.__tdOf("n", 0).textContent).trim()'))
  check('T7 命中数与数据库参照逐字相等（产品与参照是两条独立实现）',
    run3.ok && oracleInfo === hitTop.m, { ui: hitTop.m, sql: oracleInfo })

  // ---------- U) 跨页命中：只有"筛整份"才会出现在第 1 页上 ----------
  await runSql(cdp, SQL_BIG, 'window.__rows().length > 5', 'big result 3')
  const tMin = await typeFilter(cdp, String(minId))
  const hitMin = await readHit(cdp)
  const firstMinHash = Number(await cdp.eval('window.__firstIdHash()'))
  check('U1 只出现在样本最后一行的 id，筛出来直接出现在第 1 页（筛的是整份结果）',
    tMin.changed && hitMin.m >= 1 && firstMinHash === djb2(minId),
    { m: hitMin.m, atBottomRow: firstMinHash === djb2(minId) })
  const run4 = await runSql(cdp, sqlCount(String(minId)), 'window.__rows().length === 1', 'count min')
  const oracleMin = Number(await cdp.eval('String(window.__tdOf("n", 0).textContent).trim()'))
  check('U2 该 id 的命中数同样与数据库参照相等', run4.ok && oracleMin === hitMin.m, { ui: hitMin.m, sql: oracleMin })

  // ---------- V) 清空 / 性能 / 收尾 ----------
  await runSql(cdp, SQL_BIG, 'window.__rows().length > 5', 'big result 4')
  const tPerf = await typeFilter(cdp, topLv)
  const perf = await cdp.jeval('window.__geom()')
  check('V1 5000 行端到端（含 150ms 防抖）耗时 ' + tPerf.elapsed + 'ms，虚拟化没退化',
    tPerf.elapsed >= DEBOUNCE - 20 && tPerf.elapsed <= 1500 && perf.virtual === 1 && perf.domRows < PAGE,
    { elapsed: tPerf.elapsed, domRows: perf.domRows, virtual: perf.virtual })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-realdb-filtered.png')))
  const cleared = await clearFilter(cdp)
  const afterClear = await readTools(cdp)
  const firstHashClear = Number(await cdp.eval('window.__firstIdHash()'))
  check('V2 点 × 清空：回到 5000 行、25 页、首行又是 max id（过滤没留副作用）',
    cleared === 'ok' && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 && afterClear.maxPage === WANTED / PAGE &&
    firstHashClear === djb2(maxId),
    { cleared, maxPage: afterClear.maxPage, sameAnchor: firstHashClear === djb2(maxId) })
  const selCell = await clickCell(cdp, 'id', 0)
  const bar = await cdp.jeval('window.__bar()')
  check('V3 清空后单击首格：行号仍是结果内绝对下标（第 1 行）',
    selCell.ok && /^id · /.test(bar.title || '') && /第 1 行|row 1\b/.test(bar.title || ''), { title: bar.title })
  await cdp.eval('window.__closePane()')
  await sleep(300)

  const hard = cdpRef.events.filter(e => /^(EX |ERROR|LOG )/.test(e))
  check('V4 真库全程无渲染层硬错误', hard.length === 0, hard.slice(0, 6))

  // V5：状态行显示真实耗时（真库往返不是 0 ms，桩测只能验格式，这里验真值）
  const elapsedReal = JSON.parse(await cdp.eval(`JSON.stringify((() => {
    const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
    const el = t && t.querySelector('.db-sql-elapsed')
    return el ? String(el.textContent).trim() : null
  })())`))
  // 期望格式从词条现算（{rows}/{ms} 换成数字通配），不硬编码语言
  const v5Pat = String(await cdp.eval(`(() => {
    const esc = s => String(s).replace(/[[\\]{}()*+?.,\\\\^$|#]/g, String.fromCharCode(92) + '$&')
    return esc(window.translate('dbSqlRowsElapsed'))
      .replace(esc('{rows}'), '[0-9]+').replace(esc('{ms}'), '[0-9]+')
  })()`))
  const msOf = String(elapsedReal).match(new RegExp(v5Pat))
  check('V5 状态行显示真实耗时（行数 · 毫秒，毫秒是真库往返 > 0）',
    msOf && Number(msOf[0].match(/[0-9]+/g).pop()) > 0,
    { elapsedReal })

  // V6：真库数据上的右键复制 —— 只比哈希，绝不打印任何真实单元格内容
  const v6Probe = await cdp.eval(`(() => {
    window.__rCtx = (col, rowIdx) => {
      const tr = window.__rows()[rowIdx || 0]
      if (!tr) return 'no-row'
      const idx = window.__colIdx(col)
      if (idx < 0) return 'no-col'
      const td = tr.children[idx]
      if (!td) return 'no-td'
      const r = td.getBoundingClientRect()
      td.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(r.x + 8), clientY: Math.round(r.y + 8)
      }))
      return 'ok'
    }
    window.__rMenu = () => {
      const m = [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis)[0]
      if (!m) return JSON.stringify({ open: 0 })
      return JSON.stringify({
        open: 1,
        head: String((m.querySelector('.db-cell-menu-head') || {}).textContent || '').trim(),
        n: [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis).length
      })
    }
    window.__rPick = i => {
      const m = [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis)[0]
      const items = m ? [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis) : []
      const it = items[i]
      if (!it) return 'no-item'
      it.click()
      return 'ok'
    }
    window.__clipHash = () => {
      try {
        return String(window.__hash(String(window.pre.readClipboard ? window.pre.readClipboard() : '')))
      } catch (err) {
        return ''
      }
    }
    window.__rDetail = () => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .filter(window.__vis)
        .find(x => x.querySelector('.db-row-detail'))
      if (!m) return JSON.stringify({ open: 0 })
      const items = [...m.querySelectorAll('.db-row-detail-item')].filter(window.__vis)
      const txt = el => String((el || {}).textContent || '').trim()
      return JSON.stringify({
        open: 1,
        title: txt(m.querySelector('.ant-modal-title')),
        fields: items.map(x => txt(x.querySelector('.db-row-detail-field'))),
        valueHashes: items.map(x => Number(window.__hash(txt(x.querySelector('.db-row-detail-value'))))),
        // 长值默认折叠并带省略号，哈希对不上是正常的：逐项标出来，节点侧只对未折叠的比
        truncated: items.map(x => /…$/.test(txt(x.querySelector('.db-row-detail-value'))) ? 1 : 0),
        copyBtns: items.filter(x => x.querySelector('.ant-btn-text')).length,
        footerBtns: [...m.querySelectorAll('.ant-modal-footer button')].filter(window.__vis).length
      })
    }
    window.__rDetailClose = () => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .filter(window.__vis)
        .find(x => x.querySelector('.db-row-detail'))
      if (!m) return 'no-modal'
      const b = [...m.querySelectorAll('.ant-modal-footer button')].filter(window.__vis)[1]
      if (!b) return 'no-btn'
      b.click()
      return 'ok'
    }
    return 'v6-probe'
  })()`)
  const v6CellHash = Number(await cdp.eval('window.__hash(String(window.__tdOf("id", 0).textContent).trim())'))
  const v6Open = await cdp.eval('window.__rCtx("id", 0)')
  await sleep(250)
  const v6Menu = JSON.parse(await cdp.eval('window.__rMenu()'))
  const v6Pick = await cdp.eval('window.__rPick(0)')
  await sleep(400)
  const v6ClipHash = Number(await cdp.eval('window.__clipHash()'))
  check('V6 真库右键菜单：表头/六项齐、复制值与单元格哈希一致（不打印真实内容）',
    v6Probe === 'v6-probe' && v6Open === 'ok' && v6Menu.open === 1 &&
    v6Menu.head === 'id' && v6Menu.n === 6 && v6Pick === 'ok' && v6ClipHash === v6CellHash,
    { open: v6Menu.open, head: v6Menu.head, n: v6Menu.n, pick: v6Pick, sameHash: v6ClipHash === v6CellHash })

  // V7：真库行详情 Modal —— 字段序与结果列同源、值取自被右键那一行；
  // 只比哈希（长值折叠的跳过），任何真实内容都不进 node 日志
  const v7Cells = []
  for (const c of ['id', 'operate_type', 'level', 'status']) {
    v7Cells.push(Number(await cdp.eval(`window.__hash(String(window.__tdOf(${JSON.stringify(c)}, 0).textContent).trim())`)))
  }
  const v7Open = await cdp.eval('window.__rCtx("id", 0)')
  await sleep(250)
  const v7Pick = await cdp.eval('window.__rPick(4)')
  await sleep(450)
  const v7 = JSON.parse(await cdp.eval('window.__rDetail()'))
  const v7ExpTitle = String(await cdp.eval("String(window.translate('dbRowDetailTitle'))"))
  const v7Match = v7.open === 1
    ? v7.valueHashes.filter((h, i) => !v7.truncated[i] && h === v7Cells[i]).length
    : 0
  const v7Close = await cdp.eval('window.__rDetailClose()')
  await sleep(450)
  const v7After = JSON.parse(await cdp.eval('window.__rDetail()'))
  check('V7 真库行详情：4 字段按结果列序、未折叠值哈希逐项一致、关闭后从 DOM 移除',
    v7Open === 'ok' && v7Pick === 'ok' && v7.open === 1 &&
    v7.title === v7ExpTitle &&
    v7.fields.join(',') === 'id,operate_type,level,status' &&
    v7.copyBtns === 4 && v7.footerBtns === 2 && v7Match >= 3 &&
    v7Close === 'ok' && v7After.open === 0,
    {
      pick: v7Pick,
      title: v7.title === v7ExpTitle,
      fields: v7.fields.join(','),
      copyBtns: v7.copyBtns,
      footerBtns: v7.footerBtns,
      hashMatches: v7Match,
      truncated: v7.truncated,
      closed: v7After.open
    })
  return finish()
}

const bail = async code => {
  await restoreAll()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
