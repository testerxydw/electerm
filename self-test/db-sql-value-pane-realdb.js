#!/usr/bin/env node
/**
 * SQL 结果「选中一格看完整值」—— 真库 CDP 实机验收（不打桩，走真实 MySQL/Redis 连接）
 *
 * 为什么要有这一份：桩数据验收（self-test/db-sql-value-pane-demo.js）能证明分支逻辑，
 * 但证明不了"驱动给出的真实值形态"。本轮两个真缺陷都是桩测不出、实机才现形的：
 *   · 渲染层用了 Buffer（渲染进程没有 Buffer 全局）——只有真实 BLOB 查询会把
 *     __bin 信封送进值面板，桩里的信封是我手写的，形态对不对全看驱动；
 *   · 展开态重跑后 bottom 挂着半屏空气 —— 需要"重新执行一次真实查询"才触发。
 * 这一份跑的就是真实链路：主进程 mysql2 取数 → IPC 结构化克隆 → 网格/工具条/面板/弹窗。
 *
 * 对生产库的护栏（本脚本对自己的硬约束，不是产品的闸门）：
 *   只发单条 SELECT。任何含写关键字、分号拼接多语句的文本在 node 侧就抛错，
 *   根本不会送到页面。连接的 readOnly 必须为 false 才能往 SQL 编辑器里打字，
 *   所以"只读"这件事完全由这条护栏承担 —— 见 assertSelectOnly，P2 判据自证它真的会拒。
 *   真值内容一律不回传：跨节点比"这段文本是不是那一格的全文"用长度 + djb2 哈希，
 *   要确认具体特征（二进制 hex）时由 node 递 needle、页面只回答布尔。
 *   库 tgfsom 的 parameter 列里有生产口令散列，所以这条纪律不是洁癖。
 *
 * 凭据只从环境变量读，脚本里不写死（P1 判据会回读本文件确认没有口令）。
 *
 * 用法：
 *   1) npm run compile
 *   2) 应用已带 --remote-debugging-port=9225 启动（见桩版脚本头部的 Xvfb 命令）
 *   3) RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *      RDB_REDIS_HOST=… RDB_REDIS_PORT=… RDB_REDIS_PASS=… \
 *      node self-test/db-sql-value-pane-realdb.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker,
  rowRe, clickCell
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-value-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const PREVIEW_MAX = 4000
const BIG_LEN = 30000
const ROWS_WANTED = 500
const PAGE_SIZE = 200
// Redis 的库号可覆盖（默认 0）：树里的节点标签是 "db0" 这种形态，不是 "0"
const REDIS_DB = process.env.RDB_REDIS_DB || '0'
const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB,
  redisHost: process.env.RDB_REDIS_HOST,
  redisPort: process.env.RDB_REDIS_PORT,
  redisPass: process.env.RDB_REDIS_PASS
}

// 合成类型查询：不碰任何业务表，只为造出"十进制/日期/三万字符/二进制"四种真实列形态。
// 值本身由数据库算出来，所以长度与形态是驱动给的，不是我编的。
const SQL_TYPES = `SELECT CAST('1234567.8912' AS DECIMAL(18,4)) AS amount,
CAST('2026-03-05 14:23:45' AS DATETIME) AS dt,
REPEAT('x', ${BIG_LEN}) AS payload,
X'0001020304050607' AS blob_col`

// 真表大结果：走主键倒序取 500 行，分页/虚拟化/绝对行号都用真数据验。
// 列里带 parameter（text，实测最长 1136 字符）当"长值"样本。
const SAMPLE_TABLE = 'tgfsom_operation_log'
const SQL_BIG = 'SELECT id, operator, operate_type, level, status, start_time, parameter ' +
  'FROM ' + SAMPLE_TABLE + ' ORDER BY id DESC LIMIT ' + ROWS_WANTED

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

// 判据输出纪律：真值内容不落终端。带 *_len / *_hash / has 的字段可以打，
// 任何可能夹带内容的字符串字段（title 例外，它是列名+行号）由调用方先过滤。
const pick = (o, keys) => {
  const r = {}
  for (const k of keys) {
    if (o && o[k] !== undefined) {
      r[k] = typeof o[k] === 'string' && o[k].length > 40 ? o[k].slice(0, 40) + '…' : o[k]
    }
  }
  return r
}

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
      const all = cdpRef.events
      console.log('renderer events total: ' + all.length)
      all.slice(-6).forEach(l => console.log('  ' + l))
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

// 每条判据都可能被"连接根本没起来"污染，所以出错信息与告警要能随手带上。
// 注意这是"返回表达式串"的同步函数：写成 async 的话调用方拿到的是 Promise，
// 塞进 jeval 就等于把 Promise 对象当表达式，判据直接崩成 JSON.parse(undefined)
const errDump = () => `(() => {
  const vis = window.__vis
  const alerts = [...document.querySelectorAll('.ant-alert-message')].filter(vis).map(x => x.innerText.trim()).slice(0, 2)
  return JSON.stringify({
    tabs: [...document.querySelectorAll('.ant-tabs-tab')].filter(vis).map(x => x.innerText.trim()),
    alerts,
    spin: [...document.querySelectorAll('.ant-spin-spinning')].filter(vis).length,
    rows: window.__rows().length
  })
})()`

// 往 SQL 编辑器里放一条语句：先全选再插入，否则新语句会接在旧语句后面变成多语句
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
  return { ok: doc.indexOf(safe.slice(0, 40)) === 0, doc, safe }
}

const runSql = async (cdp, sql, readyExpr, label) => {
  const set = await setSql(cdp, sql)
  if (!set.ok) {
    return { ok: false, stage: 'set', set }
  }
  const clicked = await cdp.eval('window.__clickRunSql()')
  const ready = await waitFor(cdp, readyExpr, label, 60000)
  await sleep(500)
  return { ok: clicked === 'ok' && ready, clicked, ready, stage: 'run', set }
}

const main = async () => {
  // ---------- P) 前置：凭据纪律 + 护栏自证 ----------
  const missing = Object.entries(ENV).filter(([k, v]) => !v).map(([k]) => k)
  const src = fs.readFileSync(__filename, 'utf8')
  const hasSecret = [ENV.pass, ENV.redisPass].filter(Boolean).some(p => src.includes(p))
  check('P1 凭据全部来自环境变量、脚本正文不含口令',
    missing.length === 0 && !hasSecret,
    { missing, hasSecret })
  if (missing.length || hasSecret) {
    console.log('用法: RDB_MYSQL_HOST/PORT/USER/PASS/DB + RDB_REDIS_HOST/PORT/PASS node ' + path.basename(__filename))
    return 1
  }

  let rejected = 0
  for (const bad of [
    'DELETE FROM tgfsom_operation_log WHERE id=1',
    'SELECT 1; DROP TABLE tgfsom_task',
    'UPDATE tgfsom_disk SET x=1',
    'SHOW CREATE TABLE tgfsom_task'
  ]) {
    try {
      assertSelectOnly(bad)
    } catch (e) {
      rejected++
    }
  }
  let accepted = 0
  for (const good of [SQL_TYPES, SQL_BIG]) {
    try {
      assertSelectOnly(good)
      accepted++
    } catch (e) {
      console.log('guard false-reject: ' + e.message)
    }
  }
  check('P2 只读护栏：4 条非 SELECT 全拒、本脚本 2 条真语句全放行',
    rejected === 4 && accepted === 2, { rejected, accepted })
  if (rejected !== 4 || accepted !== 2) {
    return 1
  }

  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
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
  check('P3 渲染进程可用（window.store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  await cdp.eval(HELPERS)
  await sleep(300)
  check('P4 探针与复制监听就绪（无夹具：真库验收不许有 __fixture）',
    await cdp.eval('typeof window.__geom') === 'function' &&
    ['installed', 'already'].indexOf(await cdp.eval('window.__spyClip()')) >= 0 &&
    await cdp.eval('typeof window.__fixture') === 'undefined')

  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  cfg0.pageSize = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  cfg0.sqlPageSize = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const ls0 = await cdp.eval('window.__ls()')
  cfg0.split = ls0 === 'null' ? null : ls0
  await cdp.eval('window.localStorage.removeItem(' + JSON.stringify(SPLIT_KEY) + ')')
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: ' + PAGE_SIZE + ', sqlResultPageSize: ' + PAGE_SIZE + ' })')
  await sleep(300)

  // ---------- Q) 真连接 ----------
  // 清掉上一轮（可能是中途抛错）留下的页签，否则 __one() 会选中旧页签的 DOM。
  // 只按本脚本自己用的标题删，绝不碰用户手工开的连接
  const staleIds = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /^(mysql realdb|redis real)$/.test(String(t.title))).map(t => t.id))"
  ))
  for (const id of staleIds) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (staleIds.length) {
    await sleep(700)
  }
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect',
      title: 'mysql realdb',
      dbType: 'mysql', dbHost: ${JSON.stringify(ENV.host)}, dbPort: Number(${JSON.stringify(ENV.port)}),
      dbUser: ${JSON.stringify(ENV.user)}, dbPassword: ${JSON.stringify(ENV.pass)},
      dbName: ${JSON.stringify(ENV.db)}, dbSsl: false,
      readOnly: false, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const tabId = await cdp.eval('String(window.store.activeTabId)')
  openedTabs.push(tabId)
  // 真连接的判据只看树真的把库名列出来了：`.db-tree` 是页签内的树容器，
  // 库名是其中一个节点（不是 .db-tree-db-name —— 那个类只在 Redis 侧出现）
  const treeShown = await waitFor(cdp, '!!window.__one(".db-tree")', 'real tree', 60000)
  const treeText0 = await cdp.eval('String((document.querySelector(".db-tree") || { innerText: "" }).innerText)')
  check('Q1 真库页签打开并建连（树里出现库名，无错误告警）',
    treeShown && String(treeText0).indexOf(ENV.db) >= 0 &&
    (await cdp.jeval(errDump())).alerts.length === 0,
    { treeShown, hasDbName: String(treeText0).indexOf(ENV.db) >= 0, dump: await cdp.jeval(errDump()) })
  // SQL 编辑器挂在"选中一张表"之后的页签里，所以先把树点开、选中样本表
  const dbNode = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(ENV.db) + ')')
  const tableShown = await waitFor(cdp, 'window.__hasTree(' + JSON.stringify(SAMPLE_TABLE) + ')',
    'table node under ' + ENV.db, 40000)
  const tableNode = await cdp.eval('window.__clickTree(' + JSON.stringify(SAMPLE_TABLE) + ')')
  await sleep(900)
  check('Q2 树里展开库并选中样本表（SQL 页的前置）',
    dbNode === 'ok' && tableShown && tableNode === 'ok',
    { dbNode, tableShown, tableNode, nodes: await cdp.eval('document.querySelectorAll(".db-tree .ant-tree-node-content-wrapper").length') })
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(600)
  check('Q3 SQL 页可聚焦编辑器', await cdp.eval('window.__focusSql()') === 'focused', await cdp.eval('window.__focusSql()'))

  // ---------- R) 合成类型查询：驱动给的真实列形态 ----------
  const run1 = await runSql(cdp, SQL_TYPES,
    'window.__colIdx("payload") >= 0 && window.__colIdx("blob_col") >= 0 && window.__rows().length === 1',
    'typed result')
  const heads1 = JSON.parse(await cdp.eval('window.__headerLabels()'))
  const g1 = await cdp.jeval('window.__geom()')
  check('R1 合成查询真跑通：1 行 × 4 列，列名由驱动给出',
    run1.ok && g1.domRows === 1 && heads1.join(',') === 'amount,dt,payload,blob_col',
    { run1: pick(run1, ['ok', 'clicked', 'ready']), heads1 })
  check('R2 未选中时是折叠分区（bottom 空、无 resizer、无工具条）',
    g1.pane === 1 && g1.collapsed === 1 && g1.resizer === 0 && g1.bar === 0 && g1.valPane === 0 && g1.selCount === 0, g1)
  const binType = await cdp.eval(`(() => {
    const td = window.__tdOf('blob_col', 0)
    return String(td ? td.textContent : '').slice(0, 60)
  })()`)
  check('R3 真实 BLOB 列不是占位串也不是崩溃：单元格给出可读形态',
    typeof binType === 'string' && binType.length > 0 && !/undefined|Error/.test(binType), { binType })

  const cellPayload = await cdp.jeval('window.__cellText("payload", 0)')
  check('R4 驱动真给了 30000 字符的长值，且网格按视觉裁、DOM 里仍是全文',
    cellPayload.exists === 1 && cellPayload.len === BIG_LEN, { cellPayload })

  const sel1 = await clickCell(cdp, 'payload', 0)
  const bar1 = await cdp.jeval('window.__bar()')
  const g1b = await cdp.jeval('window.__geom()')
  check('R5 真库单击选中 → 工具条出现，且网格高度不塌',
    sel1.ok && bar1.exists === 1 && g1b.gridH > 300 && g1b.bar === 1 && g1b.collapsed === 1,
    { sel: pick(sel1, ['ok']), bar: pick(bar1, ['exists', 'h', 'meta']), gridH: g1b.gridH })
  check('R6 工具条标题是「列名 · 第 N 行」（真行号，不是数组下标错觉）',
    /payload/.test(bar1.title || '') && rowRe(1).test(bar1.title || ''), { title: bar1.title })
  const metaOk = String(bar1.meta || '').replace(/[\s,]/g, '') === BIG_LEN + 'chars'
  check('R7 长值 meta 报的是字符数 30000（阈值 60 生效、单位没写错）', metaOk, { meta: bar1.meta })

  const selBlob = await clickCell(cdp, 'blob_col', 0)
  const barB = await cdp.jeval('window.__bar()')
  check('R8 真实二进制格 meta 走字节数分支（8 bytes），不是按字符串数出来',
    selBlob.ok && /^8\s*bytes$/i.test(String(barB.meta || '').trim()), { meta: barB.meta, exists: barB.exists })

  const numMeta = await cdp.jeval('window.__colMeta("amount")')
  const dtMeta = await cdp.jeval('window.__colMeta("dt")')
  check('R9 数值列右对齐（真实 DECIMAL 列，类型契约在真库路径成立）',
    numMeta.align[0] === 'right', pick(numMeta, ['align', 'texts']))
  check('R10 本地化关闭时日期列原样是驱动给的 ISO 串',
    /2026-03-05T06:23:45/.test(dtMeta.texts[0] || ''), { dt: dtMeta.texts[0] })

  // 本地化开关是页签组件里的 UI 状态（挂载时读一次 config，之后由开关自己写回）：
  // 从外面 setConfig 不会让已挂载的网格重渲染，所以这里走真人的路径 ——
  // 切到数据页点那个 Switch，再回 SQL 页看渲染。测的是产品入口，不是我的注入技巧。
  await cdp.eval('window.__clickTab("数据|data")')
  await sleep(1200)
  const sw = await cdp.eval(`(() => {
    const s = [...document.querySelectorAll('.db-format-locale .ant-switch')].filter(window.__vis)[0]
    if (!s) return JSON.stringify({ found: 0 })
    const r = s.getBoundingClientRect()
    return JSON.stringify({ found: 1, checked: s.getAttribute('aria-checked'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`)
  const swInfo = JSON.parse(sw)
  if (swInfo.found) {
    await cdp.click(swInfo.x, swInfo.y)
    await sleep(500)
  }
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(900)
  const numOs = await cdp.jeval('window.__colMeta("amount")')
  const dtOs = await cdp.jeval('window.__colMeta("dt")')
  const swAfter = await cdp.eval(`(() => {
    const s = [...document.querySelectorAll('.db-format-locale .ant-switch')][0]
    return s ? String(s.getAttribute('aria-checked')) : 'gone'
  })()`)
  check('R11 点产品自己的本地化开关后，真实 DECIMAL 出千分位、日期不再是 ISO 原文',
    swInfo.found === 1 && /1[.,\u00a0]234[.,\u00a0]567/.test(numOs.texts[0] || '') &&
    !/T\d\d:\d\d:\d\d/.test(dtOs.texts[0] || ''),
    { swInfo: pick(swInfo, ['found', 'checked']), swAfter, amount: numOs.texts[0], dt: dtOs.texts[0] })

  // ---------- S) 展开面板：真值全文、只读、复制 ----------
  // 选中格换回 payload（R8 把选中留在了二进制格），并把鼠标移出网格：
  // 悬停预览卡还开着时会盖住工具条，点 bar 就成了点卡片
  const selPay = await clickCell(cdp, 'payload', 0)
  await cdp.move(5, 5)
  await sleep(400)
  const barS = await cdp.jeval('window.__bar()')
  if (!selPay.ok || !barS.exists || !barS.center) {
    check('S0 工具条就位可点（拿不到坐标就无法展开）', false, { selPay, bar: pick(barS, ['exists', 'h']) })
    return finish()
  }
  await cdp.click(barS.center.x, barS.center.y)
  await sleep(700)
  const paneP = await cdp.jeval('window.__pane()')
  const g2 = await cdp.jeval('window.__geom()')
  check('S1 真库展开：面板全文 30000 字符且与那一格的全文逐字符同哈希',
    paneP.exists === 1 && paneP.preLen === BIG_LEN && paneP.preHash === cellPayload.hash &&
    g2.valPane === 1 && g2.collapsed === 0,
    { pane: pick(paneP, ['exists', 'preLen', 'preHash', 'h']), cellHash: cellPayload.hash, geom: pick(g2, ['valPane', 'collapsed', 'topH', 'bottomH']) })
  check('S2 SQL 结果面板只读：没有 textarea，也没有编辑/替换入口',
    paneP.textarea === 0 && !/编辑|替换|edit|replace|保存|save/i.test((paneP.btns || []).map(b => b.t + b.title).join('')),
    { btns: (paneP.btns || []).map(b => ({ t: b.t.replace(/\s/g, ''), title: b.title })), textarea: paneP.textarea })

  const copyBtn = (paneP.btns || []).find(b => /复制|copy/i.test(b.t + ' ' + b.title))
  if (!copyBtn) {
    check('S3 面板有复制按钮（拿不到就无法验剪贴板）', false, { btns: (paneP.btns || []).map(b => b.t) })
    return finish()
  }
  await cdp.eval('window.__clip = []')
  await cdp.click(copyBtn.x, copyBtn.y)
  await sleep(600)
  const clip = JSON.parse(await cdp.eval('window.__clipLog()'))
  // 读回真实剪贴板留一次重试：这一轮实测里它报过错，查下来是探针自己的问题 ——
  // 真库页面上没有注入原文，探针拿 window.__fixture.big 比对时 undefined 抛 TypeError，
  // 一度被误读成"产品没写全"。修成 same=-1（无可比对原文）+ 只走哈希等值后，
  // 重试只用来挡 window.pre 偶发未就绪，判据本身不再依赖重试才变绿。
  let clipBack = null
  for (let i = 0; i < 6; i++) {
    clipBack = await cdp.jeval('window.__readClip()')
    if (clipBack.ok === 1) {
      break
    }
    await sleep(400)
  }
  check('S3 复制发出的确实是全文（writeClipboard 收到 30000 且同哈希）',
    clip.length === 1 && clip[0].len === BIG_LEN && clip[0].hash === cellPayload.hash, pick(clip[0] || {}, ['len', 'hash']))
  check('S4 真实剪贴板里就是全文（readClipboard 读回 30000 且同哈希）',
    clipBack.ok === 1 && clipBack.len === BIG_LEN && clipBack.hash === cellPayload.hash,
    { ok: clipBack.ok, len: clipBack.len, hash: clipBack.hash, error: clipBack.error })

  // 二进制格展开：本轮 Buffer 崩溃就发生在这里（渲染层没有 Buffer 全局）
  // 先收回面板 → 点 blob 格 → 再展开
  const paneNow = await cdp.jeval('window.__pane()')
  const paneBtns = paneNow.btns || []
  const xBtn = paneBtns.find(b => /×|close|收起|关闭/i.test(b.t + ' ' + b.title)) || null
  if (xBtn) {
    await cdp.click(xBtn.x, xBtn.y)
    await sleep(400)
  }
  const selB2 = await clickCell(cdp, 'blob_col', 0)
  const barB2 = await cdp.jeval('window.__bar()')
  await cdp.click(barB2.center.x, barB2.center.y)
  await sleep(700)
  const paneBin = await cdp.jeval('window.__pane()')
  const hexHit = await cdp.jeval('window.__paneHas("0001020304050607")')
  const aliveAfterBin = await cdp.jeval('window.__geom()')
  check('S5 真实 BLOB 展开值面板：hex 预览命中且不崩（渲染层 Buffer 回归）',
    selB2.ok && paneBin.exists === 1 && hexHit.has === 1 &&
    aliveAfterBin.valPane === 1 && aliveAfterBin.selCount === 1,
    { pane: pick(paneBin, ['exists', 'preLen', 'h']), hexHit, geom: pick(aliveAfterBin, ['valPane', 'selCount', 'gridH', 'domRows']) })

  // 面板 × 是"收回工具条"，不是"取消选中"
  const paneBinBtns = (paneBin.btns || []).find(b => /×|close|收起|关闭/i.test(b.t + ' ' + b.title))
  if (paneBinBtns) {
    await cdp.click(paneBinBtns.x, paneBinBtns.y)
    await sleep(500)
  }
  const g3 = await cdp.jeval('window.__geom()')
  const barAfterClose = await cdp.jeval('window.__bar()')
  check('S6 面板 × 收回为工具条（选中仍在、网格重新占满）',
    g3.collapsed === 1 && g3.valPane === 0 && g3.selCount === 1 && g3.bar === 1 && g3.gridH > 300 &&
    barAfterClose.exists === 1, pick(g3, ['collapsed', 'valPane', 'selCount', 'bar', 'gridH']))

  // ---------- T) hover 预览卡 → 查看完整 → 弹窗复制（真值 30000） ----------
  const pre4000 = await cdp.jeval('window.__cellPre("payload", 0, ' + PREVIEW_MAX + ')')
  const xyP = await cdp.jeval('window.__cellXY("payload", 0)')
  await cdp.move(5, 5)
  await sleep(200)
  await cdp.move(xyP.x, xyP.y)
  await sleep(300)
  await cdp.move(Math.round(xyP.x + 8), xyP.y)
  await sleep(900)
  const card = await cdp.jeval('window.__card()')
  check('T1 真值 hover 预览卡：只给前 4000 且与全文前 4000 同哈希 + 截断标记',
    card.open === 1 && card.len === PREVIEW_MAX && card.hash === pre4000.hash && card.more === 1 && card.cards === 1,
    pick(card, ['open', 'cards', 'len', 'hash', 'more']))
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-realdb-preview-card.png')))
  if (!card.full) {
    check('T2 预览卡有「查看完整」（拿不到按钮无法验弹窗）', false, card)
    return finish()
  }
  await cdp.click(card.full.x, card.full.y)
  await sleep(700)
  const modal = await cdp.jeval('window.__modal()')
  check('T3 「查看完整」弹窗给全文 30000（与格内全文同哈希）、等宽、可选中',
    modal.open === 1 && modal.len === BIG_LEN && modal.hash === cellPayload.hash && modal.mono && modal.selectable,
    pick(modal, ['open', 'len', 'hash', 'mono', 'selectable', 'wrap', 'title']))
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-realdb-full-text-modal.png')))
  const mCopy = (modal.btns || []).find(b => /复制|copy/i.test(b.k + ' ' + b.title))
  if (!mCopy) {
    check('T4 弹窗有复制按钮', false, { btns: (modal.btns || []).map(b => b.k) })
  } else {
    await cdp.eval('window.__clip = []')
    await cdp.click(mCopy.x, mCopy.y)
    await sleep(500)
    const clipM = JSON.parse(await cdp.eval('window.__clipLog()'))
    check('T4 弹窗复制发出全文（30000 且同哈希）',
      clipM.length === 1 && clipM[0].len === BIG_LEN && clipM[0].hash === cellPayload.hash,
      pick(clipM[0] || {}, ['len', 'hash']))
  }
  // 关掉弹窗
  const mClose = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.ant-modal-close')].filter(window.__vis)[0]
    if (!b) return 'no-close'
    b.click()
    return 'ok'
  })()`)
  await sleep(500)
  check('T5 弹窗可关闭且不残留', mClose === 'ok' && (await cdp.jeval('window.__modal()')).open === 0, { mClose })

  // ---------- U) 真表 500 行：分页、虚拟化、绝对行号、重跑不留半屏空气 ----------
  const run2 = await runSql(cdp, SQL_BIG,
    'window.__colIdx("parameter") >= 0 && window.__rows().length > 10', 'big result')
  const gU = await cdp.jeval('window.__geom()')
  const errU = await cdp.jeval(errDump())
  check('U1 真表 500 行跑通：虚拟化生效、DOM 只渲染可视区',
    run2.ok && gU.virtual === 1 && gU.domRows > 5 && gU.domRows < PAGE_SIZE && errU.alerts.length === 0,
    { run: pick(run2, ['ok', 'clicked', 'ready']), geom: pick(gU, ['virtual', 'domRows', 'gridH', 'holderSH']), alerts: errU.alerts.length })
  const pager = await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('.db-sql-result-tools .ant-pagination-item')].filter(window.__vis)
    return JSON.stringify({ n: items.length, pages: items.map(x => x.getAttribute('title') || x.innerText.trim()) })
  })()`)
  const pg = JSON.parse(pager)
  const expectPages = Math.ceil(ROWS_WANTED / PAGE_SIZE)
  check('U2 分页器按 ' + PAGE_SIZE + ' 行/页给出 ' + expectPages + ' 页（真 500 行）',
    pg.n === expectPages, pg)

  const bp = await cdp.jeval('window.__bodyPoint()')
  const beforeWheel = await cdp.jeval('window.__geom()')
  await cdp.wheel(bp.x, bp.y, 1200)
  const afterWheel = await cdp.jeval('window.__geom()')
  check('U3 折叠态网格真能滚（首行 id 或 translateY 变化）',
    afterWheel.firstId !== beforeWheel.firstId || afterWheel.innerTY !== beforeWheel.innerTY,
    { before: pick(beforeWheel, ['firstId', 'innerTY']), after: pick(afterWheel, ['firstId', 'innerTY']) })

  if (pg.n >= 2) {
    await cdp.wheel(bp.x, bp.y, -3000)
    await sleep(400)
    const p1 = await cdp.jeval('window.__geom()')
    const goto = await cdp.eval('window.__gotoPage(2)')
    await sleep(800)
    const p2 = await cdp.jeval('window.__geom()')
    check('U4 翻到第 2 页：首行换人且不是同一批行（真分页换数据）',
      goto === 'ok' && p2.domRows > 5 && p2.firstId !== p1.firstId,
      { goto, p1: pick(p1, ['firstId', 'domRows']), p2: pick(p2, ['firstId', 'domRows']) })
    // 行号必须是"结果集内绝对下标"：第 2 页第一行 = 第 201 行
    const sel2 = await clickCell(cdp, 'parameter', 0)
    const bar2 = await cdp.jeval('window.__bar()')
    check('U5 第 2 页首行的行号是绝对下标（第 201 行，不是页内 1）',
      sel2.ok && rowRe(PAGE_SIZE + 1).test(bar2.title || ''), { title: bar2.title, exists: bar2.exists })
    const cellP = await cdp.jeval('window.__cellText("parameter", 0)')
    // 工具条的 meta 必须在展开之前读：展开后 bottom 渲染的是面板，bar 已不在 DOM 里
    check('U7 生产长值按阈值给字符数（工具条与面板口径一致，都不是"看着像"）',
      /^\d+\s*chars$/i.test(String(bar2.meta || '').trim()) &&
      cellP.exists === 1 && String(bar2.meta).replace(/[\s,]/g, '') === cellP.len + 'chars',
      { barMeta: bar2.meta, cellLen: cellP.len })
    await cdp.click(bar2.center.x, bar2.center.y)
    await sleep(700)
    const paneP2 = await cdp.jeval('window.__pane()')
    check('U6 生产表长文本格：面板全文与单元格逐字符同哈希（真值不走样）',
      cellP.exists === 1 && paneP2.exists === 1 && paneP2.preLen === cellP.len && paneP2.preHash === cellP.hash,
      { pane: pick(paneP2, ['exists', 'preLen', 'preHash']), paneMeta: paneP2.meta })
    // 收回，避免下一步重跑时还挂着面板
    const xBtn2 = (paneP2.btns || []).find(b => /×|close|收起|关闭/i.test(b.t + ' ' + b.title))
    if (xBtn2) {
      await cdp.click(xBtn2.x, xBtn2.y)
      await sleep(400)
    }
  } else {
    check('U4 翻到第 2 页：首行换人且不是同一批行（真分页换数据）', false, pg)
  }

  // 重跑同一条 SELECT：选中该清空、展开偏好留着，但半屏不能空着压网格
  const preRerun = await cdp.jeval('window.__geom()')
  const setAgain = await setSql(cdp, SQL_BIG)
  const clickedAgain = await cdp.eval('window.__clickRunSql()')
  const reran = await waitFor(cdp, 'window.__rows().length > 5 && window.__colIdx("parameter") >= 0', 'rerun grid', 60000)
  await sleep(900)
  const postRerun = await cdp.jeval('window.__geom()')
  check('U8 重新执行后不留半屏空气（选中清空、分区收回、网格重新占满）',
    setAgain.ok && clickedAgain === 'ok' && reran &&
    postRerun.selCount === 0 && postRerun.bar === 0 && postRerun.valPane === 0 &&
    postRerun.collapsed === 1 && postRerun.bottomH === 0 && postRerun.gridH > 300 &&
    postRerun.domRows > 5,
    { set: pick(setAgain, ['ok']), clickedAgain, reran, pre: pick(preRerun, ['valPane', 'collapsed', 'gridH']), post: pick(postRerun, ['selCount', 'bar', 'valPane', 'collapsed', 'bottomH', 'gridH', 'domRows']) })

  // 选中 → 展开 → 拖高 → 记忆
  const selU = await clickCell(cdp, 'parameter', 0)
  const barU = await cdp.jeval('window.__bar()')
  await cdp.click(barU.center.x, barU.center.y)
  await sleep(700)
  const rz = await cdp.jeval('window.__resizerXY()')
  if (!rz.found) {
    check('U9 展开后有可拖的分隔条', false, rz)
  } else {
    const beforeDrag = await cdp.jeval('window.__geom()')
    await cdp.dragY(rz.x, rz.y, -160)
    await sleep(600)
    const afterDrag = await cdp.jeval('window.__geom()')
    const lsVal = await cdp.eval('window.__ls()')
    check('U9 拖动分隔条改高度并写进 localStorage（真库挂载下也记住）',
      selU.ok && afterDrag.bottomH > beforeDrag.bottomH + 60 && lsVal !== 'null' && Number(lsVal) > 0,
      { lsVal, before: pick(beforeDrag, ['bottomH', 'topH']), after: pick(afterDrag, ['bottomH', 'topH']) })
    // 收回再展开：不能跳回 50%
    const paneU = await cdp.jeval('window.__pane()')
    const xU = (paneU.btns || []).find(b => /×|close|收起|关闭/i.test(b.t + ' ' + b.title))
    if (xU) {
      await cdp.click(xU.x, xU.y)
      await sleep(500)
    }
    const barU2 = await cdp.jeval('window.__bar()')
    await cdp.click(barU2.center.x, barU2.center.y)
    await sleep(700)
    const reopened = await cdp.jeval('window.__geom()')
    check('U10 收回再展开仍是拖过的比例（同一次挂载内不跳回 50%）',
      Math.abs(reopened.bottomH - afterDrag.bottomH) <= 40,
      { dragged: afterDrag.bottomH, reopened: reopened.bottomH })
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-realdb-value-pane.png')))
  }

  // ---------- V) 浅色主题下的真库呈现 ----------
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  check('V0 有可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const selV = await clickCell(cdp, 'operator', 1)
    await cdp.move(5, 5)
    await sleep(300)
    const barV = await cdp.jeval('window.__bar()')
    if (barV.center) {
      await cdp.click(barV.center.x, barV.center.y)
      await sleep(600)
    }
    // __selCells 返回的是数组本体（不是 JSON 串），jeval 会把它读成 [object Object]
    const selInfo = JSON.parse(await cdp.eval('JSON.stringify(window.__selCells())'))
    const paneV = await cdp.jeval('window.__pane()')
    check('V1 浅色下选中格仍有可见描边、面板仍在位',
      selV.ok && selInfo.length === 1 && /inset/.test(String(selInfo[0].shadow || '')) && paneV.exists === 1,
      { shadow: selInfo[0] && selInfo[0].shadow, pane: pick(paneV, ['exists', 'preLen']) })
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-realdb-light-pane.png')))
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(800)
  }

  // ---------- W) Redis 真库冒烟（同一套展示层的另一条连接） ----------
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect',
      title: 'redis real',
      dbType: 'redis', dbHost: ${JSON.stringify(ENV.redisHost)}, dbPort: Number(${JSON.stringify(ENV.redisPort)}),
      dbPassword: ${JSON.stringify(ENV.redisPass)}, dbName: ${JSON.stringify(REDIS_DB)}, dbSsl: false,
      readOnly: true, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const redisId = await cdp.eval('String(window.store.activeTabId)')
  openedTabs.push(redisId)
  // Redis 页签先出树（db0…db15 带键数），键列表区要点库节点才挂出来 ——
  // 节点标签是 "db0" 这种形态，按 dbName '0' 精确匹配会找不到
  await waitFor(cdp, '!!window.__one(".db-tree")', 'redis tree', 40000)
  const redisNode = await cdp.eval('window.__clickTree(' + JSON.stringify('db' + REDIS_DB) + ')')
  const redisOk = await waitFor(cdp,
    "!![...document.querySelectorAll('.db-redis-bar')].filter(window.__vis).length && " +
    "!![...document.querySelectorAll('.db-redis-keys')].filter(window.__vis).length",
    'redis area', 40000)
  const keyRows = await cdp.eval(`(() => {
    const c = [...document.querySelectorAll('.db-redis-keys')].filter(window.__vis)[0]
    return c ? c.querySelectorAll('.ant-table-row').length : -1
  })()`)
  check('W1 真 Redis 连上并列出键（只读页签，不写任何键）',
    redisNode === 'ok' && redisOk && keyRows > 0, { redisNode, redisOk, keyRows })
  if (keyRows > 0) {
    const picked = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('.db-redis-keys')].filter(window.__vis)[0]
      const r = c.querySelector('.ant-table-row')
      if (!r) return 'no-row'
      r.click()
      return 'ok'
    })()`)
    await sleep(1500)
    const detail = await cdp.eval(`(() => {
      const d = [...document.querySelectorAll('.db-redis-detail')].filter(window.__vis)[0]
      if (!d) return JSON.stringify({ exists: 0 })
      return JSON.stringify({
        exists: 1,
        empty: !!d.querySelector('.db-redis-detail-empty'),
        grids: d.querySelectorAll('.db-grid-table').length,
        text: d.innerText.replace(/\\s+/g, ' ').length
      })
    })()`)
    const d = JSON.parse(detail)
    check('W2 选中键后详情区出内容（不是"请选择键"空态）',
      picked === 'ok' && d.exists === 1 && d.empty === false && d.text > 0, d)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-realdb-redis.png')))
  }

  // ---------- 收尾：全程无渲染层异常 ----------
  const hardEvents = cdp.events.filter(e => /^(EX |ERROR|LOG )/.test(e))
  check('X1 真库全程无渲染层异常/错误（Buffer 崩溃这类只能这样抓到）',
    hardEvents.length === 0, { hard: hardEvents.slice(0, 4), total: cdp.events.length })
  const stillThere = await cdp.eval(`(() => {
    const t = window.store.tabs.filter(x => x.type === 'database')
    return t.length
  })()`)
  check('X2 页签结构全程完好（没被异常打没）', stillThere >= 1, { stillThere })

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
