#!/usr/bin/env node
/**
 * N4b xlsx 导出/导入 —— CDP 实机验收（真 node:sqlite 文件 + 真主进程 IPC）
 *
 * 与 N4a 的 db-import-jsonl-sql-demo.js 同一机位（向导管线那边已验过，本批只量
 * xlsx 新增面），五条腿：
 *   A 预览：多 sheet 的 sheets/sheetName/totalRows、显式 sheetName 换列、大写扩展名
 *   B 导出→导入闭环（§N4 验收原文）：产品导出器写 xlsx → 产品导入器导回 →
 *     逐字段对账。类型必须原样回来：数字不变成字符串、NULL 不是空串、
 *     BLOB 按 b64 文本落库但解 b64 字节相等（xlsx 单元格没有 BLOB 语义，
 *     binCell 口径与 csv/tsv 一致 —— 这是设计决定不是缺陷）。
 *   C 日期单元格：真日期格（Date → SheetJS 序列）导回必须是日期字符串
 *     （cellDates 修复的实机回归：修复前读回 45306.6666 这样的序列号）
 *   D 尾部 null / 空行 / sheet 选择：xlsx 尾部空单元格不落盘是格式特性，
 *     导入端按表头长度补 NULL；全 null 空行不计入；sheetName 精确匹配 +
 *     匹配不到回落第一个
 *   E 导入向导 UI：格式下拉出现 XLSX、sheet 下拉渲染、切 sheet 重预览列变化
 *
 * 只有一处不是真的：OS 文件选择对话框无法自动化，openFile 这一个 action
 * 换成"对夹具路径走同一个 previewImportFile"（与 N4a 同款包裹），
 * 其余解析、映射、写库、状态轮询全走真实主进程与真实适配器。
 *
 * 用法：
 *   1) npm run compile && rsync -a src/app/ work/app/   # 主进程与渲染层都在 work
 *   2) Xvfb :154 &  DISPLAY=:154 HOME=/tmp/electerm-n4b-xlsx/home TMPDIR=/tmp/electerm-n4b-xlsx/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9451 --no-sandbox --disable-gpu --window-size=1680,1050
 *   3) node self-test/db-xlsx-realdb-demo.js [debugPort] [shotDir]
 *
 * 夹具在 /tmp/electerm-n4b-xlsx/demo 下：库文件原地 DROP/CREATE（换 inode 会让
 * 主进程缓存的 sqlite 句柄写到已删除的旧文件上），xlsx 夹具每次重写。
 * 本机假数据（alpha/bravo），不含凭据不含业务内容。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const nodeXlsx = require('node-xlsx')
const {
  getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs, ensureRealDbLayer
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9451'
const SHOT_DIR = process.argv[3] || path.join(__dirname, '2026-11-11-n4b-shots')
const DEMO_DIR = '/tmp/electerm-n4b-xlsx/demo'
const DB = path.join(DEMO_DIR, 'imp.db')
const TAB_TITLE = 'n4b-xlsx'
const { results, check } = makeChecker()
const J = s => JSON.stringify(s)

const F = {
  multi: path.join(DEMO_DIR, 'multi.xlsx'),
  multiUpper: path.join(DEMO_DIR, 'multi.XLSX'),
  dates: path.join(DEMO_DIR, 'dates.xlsx'),
  exported: path.join(DEMO_DIR, 'exported.xlsx')
}

const SRC_COLS = ['id', 'name', 'score', 'flag', 'note', 'data']
// 源表数据：类型、NULL、空串、引号逗号换行、中文、二进制各占一位
// （行 3 note=null、行 5 note=''：空串与 NULL 必须可区分）
const SRC = [
  { id: 1, name: 'alpha', score: 1.5, flag: 1, note: 'n1', data: Buffer.from([0, 255, 16]) },
  { id: 2, name: 'bravo', score: 2.25, flag: 0, note: null, data: Buffer.from('0123456789') },
  { id: 3, name: '', score: 0, flag: 1, note: '带,逗"号\n换行', data: null },
  { id: 4, name: '中文名', score: -3.75, flag: 0, note: '中文备注', data: Buffer.from('deadbeef', 'hex') },
  { id: 5, name: 'delta', score: 100.5, flag: 1, note: '', data: Buffer.from([127, 8]) }
]
// 第二页：不同的列名与行数（sheet 选择腿）
const SHEET2_COLS = ['id', 'tag']
const SHEET2 = [
  { id: 101, tag: 'x' },
  { id: 102, tag: 'y' },
  { id: 103, tag: '中文页' }
]
// 日期夹具：UTC 构造，断言 UTC 分量（d1 纯日期、d2 带时刻非整分整秒）
const DATE_D1 = Date.UTC(2024, 0, 15)
const DATE_D2 = Date.UTC(2024, 0, 15, 8, 30, 5, 500)

// ================================ 夹具 ================================

const DDL_MAIN = `CREATE TABLE %T (
  id INTEGER PRIMARY KEY,
  name TEXT,
  score REAL,
  flag INTEGER,
  note TEXT,
  data BLOB
)`
const DDL_DATES = `CREATE TABLE dates_t (
  id INTEGER PRIMARY KEY,
  d1 TEXT,
  d2 TEXT,
  tail TEXT
)`
const DDL_SHEET2 = 'CREATE TABLE sheet2_t (id INTEGER PRIMARY KEY, tag TEXT)'

const withBusy = (fn, tries = 60) => {
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      return fn()
    } catch (e) {
      last = e
      // 产品连接与夹具写入同文件：SQLITE_BUSY 是预期的瞬时锁竞争，退避重试
      if (!/BUSY|LOCKED/i.test(String(e && e.message))) break
      const t = Date.now()
      while (Date.now() - t < 30) { /* spin */ }
    }
  }
  throw last
}

const hostWrite = sqls => {
  const db = new DatabaseSync(DB)
  try {
    for (const s of sqls) {
      withBusy(() => db.exec(s))
    }
  } finally {
    db.close()
  }
}

const hostSelect = sql => {
  const db = new DatabaseSync(DB)
  try {
    return withBusy(() => db.prepare(sql).all())
  } finally {
    db.close()
  }
}

const hostScalar = sql => {
  const r = hostSelect(sql)
  return r.length ? Number(Object.values(r[0])[0]) : null
}

// 库文件原地重建，绝不 rm 换 inode（db-client/sqlite.js 的 dbs Map 按绝对路径缓存句柄）
const FIX_TABLES = ['src_t', 'imp_t', 'dates_t', 'sheet2_t', 'sheet1_t']

const buildFixtures = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  hostWrite(FIX_TABLES.map(t => `DROP TABLE IF EXISTS ${t}`).concat([
    DDL_MAIN.replace('%T', 'src_t'),
    DDL_MAIN.replace('%T', 'imp_t'),
    DDL_MAIN.replace('%T', 'sheet1_t'),
    DDL_DATES,
    DDL_SHEET2
  ]))
  {
    const db = new DatabaseSync(DB)
    try {
      const ins = db.prepare(
        'INSERT INTO src_t (id, name, score, flag, note, data) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of SRC) {
        withBusy(() => ins.run(r.id, r.name, r.score, r.flag, r.note, r.data))
      }
    } finally {
      db.close()
    }
  }
  // 第一页 = src_t 同款 6 列 5 行；第二页 = 2 列 3 行（列名都不同，sheet 换列一目了然）
  fs.writeFileSync(F.multi, nodeXlsx.build([
    { name: '第一页', data: [[...SRC_COLS], ...SRC.map(r => SRC_COLS.map(c => r[c]))] },
    { name: '第二页', data: [[...SHEET2_COLS], ...SHEET2.map(r => SHEET2_COLS.map(c => r[c]))] }
  ], { writeOptions: { compression: true } }))
  fs.copyFileSync(F.multi, F.multiUpper)
  // 日期夹具：Date 对象让 SheetJS 写成真日期格。
  // 行 1：3 列（tail 缺格）→ 尾部空单元格不落盘，读回应补 NULL
  // 行 2：只有 id → 其余补 NULL（id 有值，不是空行，要导入）
  // 行 3：全 null 行 → xlsxIsEmptyRow 命中，导入执行层跳过（count 不含它）
  const datesData = [
    ['id', 'd1', 'd2', 'tail'],
    [1, new Date(DATE_D1), new Date(DATE_D2)],
    [2],
    [null, null, null, null]
  ]
  fs.writeFileSync(F.dates, nodeXlsx.build(
    [{ name: 'Sheet1', data: datesData }], { writeOptions: { compression: true } }))
}

// ================================ 页内探针 ================================

const PROBE = `(() => {
  window.__errs = []
  if (!window.__errHooked) {
    window.__errHooked = true
    window.addEventListener('error', e => window.__errs.push(String(e.message || e)))
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason
      window.__errs.push('rej:' + String((r && r.message) || r))
    })
  }
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
    return !window.__hidden(el)
  }
  window.__q = sel => [...document.querySelectorAll(sel)]
  window.__one = sel => window.__q(sel).filter(window.__vis)[0] || null
  window.__all = sel => window.__q(sel).filter(window.__vis)
  window.__xy = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__txt = el => (el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '')

  window.__importBtn = () => window.__q('button')
    .filter(window.__vis).find(b => b.querySelector('.anticon-upload')) || null
  window.__importBtnEnabled = () => {
    const b = window.__importBtn()
    return b ? !b.disabled && !b.getAttribute('disabled') : 'no-btn'
  }
  window.__modal = () => window.__one('.db-import-modal')
  window.__pickBtn = () => window.__q('.db-import-modal button')
    .filter(window.__vis).find(b => b.querySelector('.anticon-folder-open')) || null
  window.__stepTitles = () => {
    const t = window.__q('.db-import-modal .ant-steps-item-title')
      .filter(window.__vis).map(x => window.__txt(x)).filter(s => s)
    if (t.length) return t
    return window.__all('.db-import-modal .ant-steps-item').map(x => window.__txt(x))
  }
  window.__footerBtn = re => {
    const src = new RegExp(re, 'i')
    const scoped = window.__q('.db-import-modal .ant-modal-footer button').filter(window.__vis)
    const pool = scoped.length ? scoped : window.__all('.ant-modal:not(.db-risk-modal) .ant-modal-footer button')
    return pool.find(x => src.test(window.__txt(x))) || null
  }
  window.__footerBtnXY = re => window.__xy(window.__footerBtn(re))
  window.__startBtn = () => window.__one('.db-import-modal button.db-import-start')
  window.__startDisabled = () => {
    const b = window.__startBtn()
    return b ? !!b.disabled : 'no-btn'
  }

  // —— 文件步 ——
  window.__formatSelect = () => window.__one('.db-import-format')
  window.__selValue = s => {
    if (!s) return null
    const c = s.querySelector('.ant-select-content') || s.querySelector('.ant-select-selection-item')
    return c ? window.__txt(c) : window.__txt(s)
  }
  window.__formatValue = () => window.__selValue(window.__formatSelect())
  window.__formatXY = () => window.__xy(window.__formatSelect())
  window.__optionTexts = () => window.__all('.ant-select-item-option').map(o => window.__txt(o))
  window.__optionXY = txt => {
    const o = window.__all('.ant-select-item-option').find(x => window.__txt(x) === txt)
    return o ? window.__xy(o) : null
  }
  window.__filePathText = () => window.__txt(window.__one('.db-import-file-path'))
  window.__fileMeta = () => window.__txt(window.__one('.db-import-file-meta'))
  // sheet 下拉：xlsx 独有，挂在 .db-import-batch 里（file 步唯一可见的 batch 块）
  window.__sheetSelect = () => window.__one('.db-import-modal .db-import-batch .ant-select')
  window.__sheetValue = () => window.__selValue(window.__sheetSelect())
  window.__sheetXY = () => window.__xy(window.__sheetSelect())
  window.__rowsTotal = () => window.__txt(window.__one('.db-import-modal .db-import-script-meta'))
  window.__sampleRows = () => window.__all('.db-import-sample-row').map(r =>
    [...r.children].map(c => window.__txt(c)))
  return 'probed'
})()`

// 文件对话框无法自动化：openFile 换成对夹具路径走同一个 previewImportFile
const WRAP = filePath => `(() => {
  if (!window.__realRun) window.__realRun = window.pre.runGlobalAsync.bind(window.pre)
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbImportOp') {
      const action = a[0]
      const arg = a[1] || {}
      if (action === 'openFile') {
        return window.__realRun('dbImportOp', 'preview', {
          filePath: ${J(filePath)},
          format: arg.format
        })
      }
    }
    return window.__realRun(name, ...a)
  }
  return 'wrapped'
})()`

// ================================ 主流程 ================================

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false
  })
  const layer = await ensureRealDbLayer(cdp)
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)
  await cdp.eval(PROBE)
  check('本轮跑在真实数据库层上（没有被上一轮的桩污染）', layer.state === 'ok', layer)

  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const f = path.join(SHOT_DIR, String(shotIdx) + '-' + name + '.png')
    await sleep(300)
    await cdp.shot(f)
    console.log('shot -> ' + path.basename(f))
  }
  const clickXY = async (xy, ms = 500, why = '') => {
    if (!xy) throw new Error('拿不到坐标，不能点：' + why)
    await cdp.click(xy.x, xy.y)
    await sleep(ms)
  }

  // ── 真实主进程调用 ──
  const op = async (name, ...args) => await cdp.eval(
    `window.pre.runGlobalAsync(${J(name)}, ${args.map(a => J(a)).join(',')})` +
    '.then(r => ({ok:1, r})).catch(e => ({ok:0, msg: String((e && e.message) || e)}))')
  const waitImport = async (importId, { untilMs = 120000 } = {}) => {
    const t0 = Date.now()
    let st = null
    while (Date.now() - t0 < untilMs) {
      const s = await op('dbImportOp', 'status', { importId })
      if (!s.ok) throw new Error('status 失败: ' + s.msg)
      st = s.r
      if (st.status !== 'running') {
        return st
      }
      await sleep(50)
    }
    return st || { status: 'timeout' }
  }
  const waitExport = async (exportId, { untilMs = 120000 } = {}) => {
    const t0 = Date.now()
    let st = null
    while (Date.now() - t0 < untilMs) {
      const s = await op('dbExportOp', 'status', { exportId })
      if (!s.ok) throw new Error('export status 失败: ' + s.msg)
      st = s.r
      if (st.status !== 'running') {
        return st
      }
      await sleep(50)
    }
    return st || { status: 'timeout' }
  }

  // ── 打开可写的 sqlite 页签 ──
  await clearDbTabs(cdp)
  buildFixtures()
  const tabId = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(TAB_TITLE)},
      dbType: 'sqlite', dbFile: ${J(DB)}, readOnly: false, production: true,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  await waitFor(cdp,
    `(async () => { try { const r = await window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'executeSql', {sql: 'SELECT count(*) AS c FROM src_t', database: 'main'}); return r.results[0].rows[0].c === ${SRC.length} } catch (e) { return false } })()`,
    'sqlite 页签连上且夹具数据在', 40000)
  await sleep(600)

  const pv = async (filePath, extra) => await op('dbImportOp', 'preview', {
    filePath, ...(extra || {})
  })

  // ══════════════════════ 腿 A：xlsx 预览 ══════════════════════
  const a1 = await pv(F.multi)
  check('多 sheet xlsx 预览：format/kind 对、sheets 全、默认选第一个 sheet、列是第一页的',
    a1.ok && a1.r.format === 'xlsx' && a1.r.kind === 'rows' &&
      JSON.stringify(a1.r.sheets) === JSON.stringify(['第一页', '第二页']) &&
      a1.r.sheetName === '第一页' &&
      JSON.stringify(a1.r.columns) === JSON.stringify(SRC_COLS) &&
      a1.r.totalRows === SRC.length,
    a1.ok
      ? { sheets: a1.r.sheets, sheetName: a1.r.sheetName, cols: a1.r.columns, total: a1.r.totalRows }
      : a1.msg)
  const a2 = await pv(F.multi, { sheetName: '第二页' })
  check('显式 sheetName=第二页：列换成了第二页的、行数跟着换',
    a2.ok && a2.r.sheetName === '第二页' &&
      JSON.stringify(a2.r.columns) === JSON.stringify(SHEET2_COLS) &&
      a2.r.totalRows === SHEET2.length,
    a2.ok ? { sheetName: a2.r.sheetName, cols: a2.r.columns, total: a2.r.totalRows } : a2.msg)
  const a3 = await pv(F.multiUpper)
  check('大写扩展名 .XLSX 也认（大小写不敏感，不回落 CSV）',
    a3.ok && a3.r.format === 'xlsx', a3.ok ? a3.r.format : a3.msg)
  check('预览样例行是第一页的数据（中文/数字/NULL 原样进样例）',
    a1.ok && a1.r.sampleRows.length === 5 &&
      a1.r.sampleRows[0][0] === '1' && a1.r.sampleRows[0][1] === 'alpha' &&
      a1.r.sampleRows[1][4] === '' && // note=null 展示为空串
      a1.r.sampleRows[3][1] === '中文名',
    a1.ok ? { n: a1.r.sampleRows.length, row0: a1.r.sampleRows[0], row3: a1.r.sampleRows[3] } : a1.msg)

  // ══════════════════════ 腿 B：导出 → 导入闭环 ══════════════════════
  const exp = await op('dbExportOp', 'start', {
    tabId, table: 'src_t', database: 'main', format: 'xlsx', targetPath: F.exported
  })
  check('产品导出器起 xlsx 导出任务（闭环上半段用真实导出）',
    exp.ok && !!exp.r.exportId, exp)
  const expSt = exp.ok ? await waitExport(exp.r.exportId) : { status: 'no-task' }
  const exportedBuf = fs.existsSync(F.exported) ? fs.readFileSync(F.exported) : Buffer.alloc(0)
  check('导出完成且是合法 zip 容器（xlsx = PK 头，不是文本格式改名）',
    expSt.status === 'done' && exportedBuf.length > 4 &&
      exportedBuf.slice(0, 2).toString() === 'PK' && exportedBuf[3] === 0x04,
    { status: expSt.status, error: expSt.error, bytes: exportedBuf.length })
  // 导出产物自证：sheet 名清洗成表名、表头行 = 列序（host 侧 node-xlsx 读回）
  const expSheets = exportedBuf.length ? nodeXlsx.parse(F.exported) : []
  check('导出产物 sheet 名 = 表名、首行 = 列序、行数 = 源表行数（含表头）',
    expSheets.length === 1 && expSheets[0].name === 'src_t' &&
      JSON.stringify(expSheets[0].data[0]) === JSON.stringify(SRC_COLS) &&
      expSheets[0].data.length === SRC.length + 1,
    expSheets.length
      ? { name: expSheets[0].name, rows: expSheets[0].data.length, head: expSheets[0].data[0] }
      : 'no-sheet')

  const impArgs = extra => ({
    tabId,
    database: 'main',
    schema: '',
    table: 'imp_t',
    filePath: F.exported,
    format: 'xlsx',
    mapping: SRC_COLS.map(c => ({ fileCol: c, target: c })),
    ...extra
  })
  const bImp = await op('dbImportOp', 'start', impArgs({ mode: 'overwrite', batchSize: 2 }))
  const bRun = bImp.ok ? await waitImport(bImp.r.importId) : null
  check('导回的 xlsx → 空表 overwrite 导入完成，行数 = 源表行数',
    bImp.ok && bRun && bRun.status === 'done' && bRun.committedRows === SRC.length,
    bRun ? { status: bRun.status, committed: bRun.committedRows, error: bRun.error } : bImp)

  // 期望值：xlsx 往返的类型口径 —— number 原样、NULL 仍是 NULL、空串仍是空串、
  // BLOB → b64 文本（binCell 口径，与 csv/tsv 一致；解 b64 字节必须相等）
  const wantImp = SRC.map(r => ({
    id: r.id,
    name: r.name,
    score: r.score,
    flag: r.flag,
    note: r.note,
    data: r.data ? r.data.toString('base64') : null
  }))
  const BLOB_TEXT = col => `CASE WHEN ${col} IS NULL THEN NULL ELSE CAST(${col} AS TEXT) END`
  const readImp = () => hostSelect(
    `SELECT id, name, score, flag, note, ${BLOB_TEXT('data')} AS data FROM imp_t ORDER BY id`)
  check('闭环内容一致（逐字段：类型/NULL/空串/引号逗号换行/中文/BLOB b64 文本）',
    JSON.stringify(readImp()) === JSON.stringify(wantImp) &&
      SRC.every((r, i) => !r.data ||
        Buffer.from(readImp()[i].data, 'base64').equals(r.data)),
    { got: readImp().map(x => ({ ...x, data: x.data ? x.data.slice(0, 8) + '…' : null })) })
  check('BLOB 解 b64 与源字节相等（文本口径没有丢字节）',
    SRC.every((r, i) => !r.data ||
      Buffer.from(readImp()[i].data, 'base64').equals(r.data)),
    SRC.map(r => !!r.data))

  // ══════════════════════ 腿 C：日期格 ══════════════════════
  const cImp = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'dates_t',
    filePath: F.dates,
    format: 'xlsx',
    mapping: [{ fileCol: 'id', target: 'id' }, { fileCol: 'd1', target: 'd1' },
      { fileCol: 'd2', target: 'd2' }, { fileCol: 'tail', target: 'tail' }],
    mode: 'append',
    batchSize: 10
  })
  const cRun = cImp.ok ? await waitImport(cImp.r.importId) : null
  check('日期夹具导入完成：真日期格不变成序列号（cellDates 实机回归）',
    cImp.ok && cRun && cRun.status === 'done' && cRun.committedRows === 2,
    cRun ? { status: cRun.status, committed: cRun.committedRows, error: cRun.error } : cImp)
  const datesRow = hostSelect('SELECT id, d1, d2, tail FROM dates_t ORDER BY id')[0]
  check('纯日期格 → YYYY-MM-DD、带时刻格 → YYYY-MM-DD HH:mm:ss（UTC 构造，分量一致）',
    !!datesRow && datesRow.d1 === '2024-01-15' && datesRow.d2 === '2024-01-15 08:30:05',
    datesRow)
  check('尾部空格不落盘 → 导入端补 NULL（不是缺列错位/空串）',
    datesRow && datesRow.tail === null, datesRow)

  // ══════════════════════ 腿 D：空行 / sheet 选择 ══════════════════════
  check('全 null 数据行被跳过（dates_t 只有 2 行有效数据，空行不计入）',
    hostScalar('SELECT count(*) FROM dates_t') === 2,
    { count: hostScalar('SELECT count(*) FROM dates_t'), rows: hostSelect('SELECT * FROM dates_t ORDER BY id') })
  const d3 = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'sheet2_t',
    filePath: F.multi,
    format: 'xlsx',
    sheetName: '第二页',
    mapping: SHEET2_COLS.map(c => ({ fileCol: c, target: c })),
    mode: 'append',
    batchSize: 10
  })
  const d3Run = d3.ok ? await waitImport(d3.r.importId) : null
  const sheet2Rows = hostSelect('SELECT id, tag FROM sheet2_t ORDER BY id')
  check('sheetName=第二页：导的是第二页的行（列映射按第二页的列名走）',
    d3.ok && d3Run && d3Run.status === 'done' &&
      d3Run.committedRows === SHEET2.length &&
      JSON.stringify(sheet2Rows) === JSON.stringify(SHEET2),
    d3Run ? { committed: d3Run.committedRows, rows: sheet2Rows } : d3)
  const d4 = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'sheet1_t',
    filePath: F.multi,
    format: 'xlsx',
    sheetName: '不存在的页',
    mapping: SRC_COLS.map(c => ({ fileCol: c, target: c })),
    mode: 'append',
    batchSize: 10
  })
  const d4Run = d4.ok ? await waitImport(d4.r.importId) : null
  check('sheetName 匹配不到 → 回落第一个 sheet（行数 = 第一页）',
    d4.ok && d4Run && d4Run.status === 'done' &&
      d4Run.committedRows === SRC.length &&
      hostScalar('SELECT count(*) FROM sheet1_t') === SRC.length,
    d4Run ? { committed: d4Run.committedRows, count: hostScalar('SELECT count(*) FROM sheet1_t') } : d4)

  // ══════════════════════ 腿 E：导入向导 UI ══════════════════════
  const expandTree = async () => {
    for (let i = 0; i < 4; i++) {
      const sw = await cdp.eval(`(() => {
        const el = window.__all('.db-tree .ant-tree-switcher_close')[0]
        return el ? window.__xy(el) : null
      })()`)
      if (!sw) break
      await clickXY(sw, 800, '树展开箭头')
    }
  }
  const selectTable = async name => {
    await expandTree()
    for (let i = 0; i < 20; i++) {
      const xy = await cdp.eval(`(() => {
        const hit = window.__all('.db-tree .ant-tree-node-content-wrapper').find(n => {
          const t = window.__txt(n)
          return t === ${J(name)} || t.endsWith('.' + ${J(name)}) || t.split(/\\s+/).pop() === ${J(name)}
        })
        if (!hit) return null
        hit.scrollIntoView({ block: 'center' })
        return window.__xy(hit)
      })()`)
      if (xy) {
        await clickXY(xy, 2000, '树节点 ' + name)
        return true
      }
      await expandTree()
      await sleep(500)
    }
    return false
  }
  const closeWizard = async () => {
    if (!(await cdp.eval('!!window.__modal()'))) {
      return
    }
    const xy = await cdp.eval(`(() => {
      const b = window.__footerBtn('取消|Cancel|关闭|Close')
      if (b) return window.__xy(b)
      const x = window.__one('.db-import-modal .ant-modal-close')
      return x ? window.__xy(x) : null
    })()`)
    await clickXY(xy, 700, '关闭向导')
    await waitFor(cdp, '!window.__modal()', '向导关闭', 10000)
  }
  const openWizard = async filePath => {
    await closeWizard()
    await cdp.eval(WRAP(filePath))
    await clickXY(await cdp.eval('window.__xy(window.__importBtn())'), 900, '导入入口')
    const opened = await waitFor(cdp, '!!window.__modal()', '导入向导打开', 15000)
    if (!opened) throw new Error('导入向导没打开')
    await sleep(400)
    await clickXY(await cdp.eval('window.__xy(window.__pickBtn())'), 1400, '选择文件按钮')
    const loaded = await waitFor(cdp, 'window.__filePathText().length > 3', '夹具载入：' + filePath, 15000)
    if (!loaded) throw new Error('夹具没载入 ' + filePath)
    await sleep(400)
  }
  const ensureDropdownOpen = async (xyExpr) => {
    for (let i = 0; i < 20; i++) {
      if (Number(await cdp.eval('window.__optionTexts().length')) > 0) {
        return true
      }
      await clickXY(await cdp.eval(xyExpr), 500, '下拉')
    }
    return false
  }

  const selected = await selectTable('imp_t')
  check('选中目标表 imp_t（导入入口要求先选节点）', selected)
  const btnOk = await waitFor(cdp,
    '!!window.__importBtn() && window.__vis(window.__importBtn()) && window.__importBtnEnabled() === true',
    '可写页签的导入入口出现且可用', 20000)
  check('可写连接 + 选中表 → 导入入口可见可用', !!btnOk,
    await cdp.jeval('JSON.stringify({btn: !!window.__importBtn(), enabled: window.__importBtnEnabled()})'))

  await openWizard(F.multi)
  const eMeta = await cdp.jeval('JSON.stringify({meta: window.__fileMeta(), sheet: window.__sheetValue(), steps: window.__stepTitles().length, total: window.__rowsTotal()})')
  check('xlsx 经界面识别：文件步显示 XLSX、sheet 下拉出现（默认第一页）、行数提示 = 5',
    /XLSX/.test(String(eMeta.meta)) &&
      eMeta.sheet === '第一页' && eMeta.steps === 4 && /5/.test(String(eMeta.total)),
    eMeta)
  // 切 sheet：选项列表来自 sheet 下拉（点开 sheet 下拉再选第二页）
  const sheetOpen = await ensureDropdownOpen('window.__sheetXY()')
  const sheetOpts = await cdp.jeval('JSON.stringify(window.__optionTexts())')
  check('sheet 下拉候选 = 两个页名', sheetOpen &&
    JSON.stringify(sheetOpts) === JSON.stringify(['第一页', '第二页']), sheetOpts)
  await clickXY(await cdp.eval('window.__optionXY("第二页")'), 1200, '选第二页')
  const eSwitch = await cdp.jeval('JSON.stringify({sheet: window.__sheetValue(), total: window.__rowsTotal(), samples: window.__sampleRows().length, row0: (window.__sampleRows()[0] || [])[0]})')
  check('切到第二页：重预览后行数变 3、样例列换成第二页的数据（101/x）',
    eSwitch.sheet === '第二页' && /3/.test(String(eSwitch.total)) &&
      eSwitch.row0 === '101',
    eSwitch)
  await shot('e-file-step-sheet2')

  // 格式下拉候选含 XLSX（6 项：按扩展名判断 + 5 格式）
  await closeWizard()
  await openWizard(F.multi)
  const fmtOpen = await ensureDropdownOpen('window.__formatXY()')
  const fmtOpts = await cdp.jeval('JSON.stringify(window.__optionTexts())')
  check('格式下拉给全 6 个候选（含 XLSX）',
    fmtOpen && fmtOpts.length === 6 &&
      fmtOpts.some(t => /XLSX/i.test(t)), fmtOpts)
  await cdp.eval('document.body.click()')
  await sleep(400)
  await shot('e-file-step-xlsx')

  // ══════════════════════ 收尾 ══════════════════════
  const errs = await cdp.jeval('JSON.stringify(window.__errs || [])')
  check('全程零未捕获异常', Array.isArray(errs) && errs.length === 0, errs)

  const fails = results.filter(r => !r.ok)
  console.log('\n========== N4b xlsx 实机验收 ==========')
  for (const r of results) {
    console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name)
    if (!r.ok) {
      console.log('    ' + JSON.stringify(r.info === undefined ? null : r.info).slice(0, 300))
    }
  }
  console.log(`结果：${results.length - fails.length}/${results.length} PASS，截图 ${shotIdx} 张 -> ${SHOT_DIR}`)
  process.exit(fails.length ? 1 : 0)
}

main().catch(e => {
  console.error('PROBE FAIL:', e.message)
  process.exit(1)
})
