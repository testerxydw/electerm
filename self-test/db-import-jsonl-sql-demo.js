#!/usr/bin/env node
/**
 * N4a JSONL / SQL 导入闭环 —— CDP 实机验收（真 node:sqlite 文件 + 真主进程 IPC）
 *
 * 这一批"接到界面/数据库之后才会坏"的事，单测钉不住，所以全部在实机量：
 *   A 预览与格式判定：格式只在主进程注册表判一次；显式选格式必须赢过扩展名；
 *     未知格式、超 8MB 脚本、大写扩展名都有确定答案（不静默回落成逗号切）。
 *   B 导出→导入闭环（§N4 验收原文）：产品自己的导出器写 JSONL → 产品自己的
 *     导入器写回 → 与源表逐字段一致。类型必须原样回来：数字不变成字符串、
 *     NULL 不是空串、BLOB 字节相等、空串不被静默转成 NULL。
 *   C 取消语义：20000 行跑到中途取消 —— 已提交批次保留、未提交批次丢弃，
 *     落库行数 = 报告的已提交行数（"不留半截"），且轮询期间行数是递增的
 *     （分批流式，不是整表一次性写）。
 *   D SQL 脚本通道：逐条执行（计数、影响行数汇总、失败即停不跳过后面的语句）、
 *     语句边界取消、rebuild 模式拒绝、缺语句/空语句拒绝、只读连接拒绝。
 *   E/F 导入向导 UI：行通道 4 步、脚本通道 3 步；格式下拉重新解析同一文件；
 *     列映射的"全忽略 → 下一步灰掉"；危险模式的勾选与 E1 闸门（取消 = 零调用）；
 *     脚本通道的语句清单与 E1 弹窗列出的语句是同一批；开始导入的载荷带 filePath
 *     （旧版没有 filePath，CSV 导入经界面必然失败 —— 这一批的回归点）。
 *   G 双主题截图 + 词条齐全 + 全程零未捕获异常。
 *
 * 语句切分不自造：腿 D/F 的期望值取自产品自己的 db-import-plan.statementPlan
 * （内部就是 classifySql），判据与界面下发的是同一批语句。
 *
 * 只有一处不是真的：OS 文件选择对话框（dialog.showOpenDialogSync）无法自动化，
 * 因此把 openFile 这一个 action 换成"对夹具路径走同一个 previewImportFile"，
 * 其余 openFile 之后的解析、映射、写库、状态轮询全走真实主进程与真实适配器。
 *
 * 用法：
 *   1) npm run compile && rsync -a src/app/ work/app/    # 词条与主进程都在 work 里
 *   2) DISPLAY=:139 HOME=/tmp/electerm-n4a/home TMPDIR=/tmp/electerm-n4a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9391 --no-sandbox --disable-gpu --window-size=1680,1050
 *   3) node self-test/db-import-jsonl-sql-demo.js [debugPort] [shotDir]
 *
 * 夹具在 /tmp/electerm-n4a/demo 下：文本夹具每次重写，库文件原地 DROP/CREATE
 * （换 inode 会让主进程缓存的 sqlite 句柄写到已删除的旧文件上）。
 * 本机假数据（alpha/bravo），不含凭据不含业务内容，截图可进仓库。
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DatabaseSync } = require('node:sqlite')
const {
  getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs, ensureRealDbLayer
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9391'
const SHOT_DIR = process.argv[3] || path.join(__dirname, '2026-11-08-n4a-shots')
const DEMO_DIR = '/tmp/electerm-n4a/demo'
const DB = path.join(DEMO_DIR, 'imp.db')
const TAB_TITLE = 'n4a-import'
const { results, check } = makeChecker()
const J = s => JSON.stringify(s)

const F = {
  csv: path.join(DEMO_DIR, 'src.csv'),
  tsv: path.join(DEMO_DIR, 'src.tsv'),
  txt: path.join(DEMO_DIR, 'src.txt'),
  jsonl: path.join(DEMO_DIR, 'rows.jsonl'),
  jsonlUpper: path.join(DEMO_DIR, 'rows.JSONL'),
  mismatch: path.join(DEMO_DIR, 'mismatch.csv'),
  big: path.join(DEMO_DIR, 'big.csv'),
  script: path.join(DEMO_DIR, 'seed.sql'),
  badScript: path.join(DEMO_DIR, 'bad.sql'),
  many: path.join(DEMO_DIR, 'many.sql'),
  huge: path.join(DEMO_DIR, 'huge.sql'),
  exported: path.join(DEMO_DIR, 'exported.jsonl')
}

// 源表数据：类型、NULL、空串、逗号/引号、换行、二进制各占一位
const SRC = [
  { id: 1, name: 'alpha', score: 1.5, flag: 1, note: 'n1', data: Buffer.from([0, 255, 16]) },
  { id: 2, name: 'bravo', score: 2.25, flag: 0, note: null, data: Buffer.from('0123456789') },
  { id: 3, name: '', score: 0, flag: 1, note: 'n3', data: null },
  { id: 4, name: 'd"q,uote', score: -3.75, flag: 0, note: '带,逗"号', data: Buffer.from([127, 8]) },
  { id: 5, name: '换行\n文本', score: 100.5, flag: 1, note: null, data: Buffer.from('deadbeef', 'hex') }
]
const SRC_COLS = ['id', 'name', 'score', 'flag', 'note', 'data']
// 手写那份 JSONL 只有前 5 列（少 data），用来量"列名来自 JSON 键"
const JSONL_COLS = ['id', 'name', 'score', 'flag', 'note']

// ================================ 夹具 ================================

const ddl = tbl => `CREATE TABLE ${tbl} (
  id INTEGER PRIMARY KEY,
  name TEXT,
  score REAL,
  flag INTEGER,
  note TEXT,
  data BLOB
)`

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
  const v = r.length ? Object.values(r[0])[0] : null
  return Number(v)
}

// CSV/TSV 里的 BLOB 用十六进制文本落盘：二进制列的还原在腿 B（产品导出器）量，
// 这里放原始字节会把 NUL 灌进文本夹具，解析结果不可读
const textCell = v => {
  if (v === null || v === undefined) {
    return ''
  }
  if (Buffer.isBuffer(v)) {
    return v.toString('hex')
  }
  return String(v)
}

const csvCell = v => {
  const s = textCell(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const tsvCell = v => textCell(v).replace(/[\t\r\n]/g, ' ')

// 库文件原地重建，绝不 rm 换 inode：主进程按绝对路径缓存 sqlite 句柄
// （db-client/sqlite.js 的 dbs Map + 引用计数），页签还开着就把文件换成新的，
// 旧句柄继续写已删除的那份，SQLite 报的正是 "attempt to write a readonly database"
const FIX_TABLES = ['src_t', 'imp_t', 'csv_t', 'sql_t', 'sql2_t', 'blob_t', 'filler']

const buildFixtures = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  for (const f of Object.values(F)) {
    fs.rmSync(f, { force: true })
  }

  hostWrite(
    FIX_TABLES.map(t => `DROP TABLE IF EXISTS ${t}`).concat([
      ddl('src_t'),
      ddl('imp_t'),
      'CREATE TABLE csv_t (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE TABLE sql_t (id INTEGER PRIMARY KEY, tag TEXT)',
      'CREATE TABLE sql2_t (id INTEGER PRIMARY KEY, tag TEXT)',
      'CREATE TABLE blob_t (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE TABLE filler (id INTEGER PRIMARY KEY)'
    ])
  )
  // filler：翻倍插到 30 万行，给"语句边界取消"腿的每条 INSERT 加一次 count(*) 扫描。
  // 纯 INSERT 单条 0.1ms，12000 条在第一次轮询前就写完了，"中途取消"会退化成
  // "自然结束"；每条 1ms 上下才留得下 cancel 落在语句边界的窗口
  let filled = 1
  const fill = ['INSERT INTO filler (id) VALUES (1)']
  while (filled < 300000) {
    fill.push(`INSERT INTO filler (id) SELECT id + ${filled} FROM filler`)
    filled *= 2
  }
  hostWrite(fill)
  const db = new DatabaseSync(DB)
  try {
    const ins = db.prepare('INSERT INTO src_t (id, name, score, flag, note, data) VALUES (?, ?, ?, ?, ?, ?)')
    for (const r of SRC) {
      withBusy(() => ins.run(r.id, r.name, r.score, r.flag, r.note, r.data))
    }
  } finally {
    db.close()
  }

  const lines = SRC.map(r => SRC_COLS.map(c => csvCell(r[c])).join(','))
  fs.writeFileSync(F.csv, SRC_COLS.join(',') + '\n' + lines.join('\n') + '\n')
  fs.writeFileSync(F.txt, SRC_COLS.join(',') + '\n' + lines.join('\n') + '\n')
  fs.writeFileSync(F.tsv, SRC_COLS.join('\t') + '\n' +
    SRC.map(r => SRC_COLS.map(c => tsvCell(r[c])).join('\t')).join('\n') + '\n')
  fs.writeFileSync(F.jsonl, SRC.map(r => JSON.stringify({
    id: r.id, name: r.name, score: r.score, flag: r.flag, note: r.note
  })).join('\n') + '\n')
  fs.copyFileSync(F.jsonl, F.jsonlUpper)
  // 列名对不上：文件列 zzz 在表里没有同名列
  fs.writeFileSync(F.mismatch, 'zzz\n1\n2\n')
  // 4 条语句（影响行数 1+1+1+0 = 3）+ 一条注释尾巴：注释不该被切成第 5 条
  fs.writeFileSync(F.script, [
    "INSERT INTO sql_t (id, tag) VALUES (10, 'a');",
    "INSERT INTO sql_t (id, tag) VALUES (11, 'b');",
    "UPDATE sql_t SET tag = 'c' WHERE id = 11;",
    'DELETE FROM sql_t WHERE id = 99;',
    '-- 只有注释的尾巴不该被当成一条语句'
  ].join('\n') + '\n')
  fs.writeFileSync(F.badScript, [
    "INSERT INTO sql_t (id, tag) VALUES (20, 'ok');",
    'INSERT INTO no_such_table (id) VALUES (1);',
    "INSERT INTO sql_t (id, tag) VALUES (21, 'never');"
  ].join('\n') + '\n')
  // 取消腿：纯 INSERT，落库行数与已执行条数一比一对得上（不掺 CREATE）。
  // 每条带一个 (SELECT count(*) FROM filler)：一次 INSERT 约 0.1ms，2000 条在第一次
  // 轮询前就跑完了，"中途取消"会退化成"自然结束"；12000 条 × 每条扫一遍 filler
  // 才留出让 cancel 落在语句边界的窗口
  const many = []
  for (let i = 1; i <= 12000; i++) {
    many.push(
      `INSERT INTO sql2_t (id, tag) VALUES (${i}, (SELECT count(*) FROM filler));`)
  }
  fs.writeFileSync(F.many, many.join('\n') + '\n')
  // 超过 MAX_SCRIPT_BYTES(8MB)：SQL 通道要拒绝，不能把 8MB 文本灌进 IPC
  fs.writeFileSync(F.huge, 'SELECT 1;\n' + '-- ' + 'x'.repeat(9 * 1024 * 1024) + '\n')
  // 20000 行 CSV（取消腿）
  const big = ['id,name']
  for (let i = 1; i <= 20000; i++) {
    big.push(i + ',row' + i)
  }
  fs.writeFileSync(F.big, big.join('\n') + '\n')
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
  window.__colorOf = sel => {
    const el = window.__one(sel)
    return el ? getComputedStyle(el).color : null
  }

  // —— 入口与向导外壳 ——
  window.__importBtn = () => window.__q('button')
    .filter(window.__vis).find(b => b.querySelector('.anticon-upload')) || null
  window.__importBtnEnabled = () => {
    const b = window.__importBtn()
    return b ? !b.disabled && !b.getAttribute('disabled') : 'no-btn'
  }
  window.__modal = () => window.__one('.db-import-modal')
  window.__pickBtn = () => window.__q('.db-import-modal button')
    .filter(window.__vis).find(b => b.querySelector('.anticon-folder-open')) || null
  // v6 的 Steps 标题类名以实测为准，拿不到就退回整条 item 的文本
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
  window.__nextDisabled = () => {
    const n = window.__footerBtn('下一步|Next')
    return n ? !!n.disabled : 'no-btn'
  }

  // —— 文件步 ——
  window.__formatSelect = () => window.__one('.db-import-format')
  // 单选框当前值：v6 用 .ant-select-content，老版是 .ant-select-selection-item，
  // 都没有就退回整个 select 的文本（关闭态下只有值 + 箭头图标）
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
  window.__scriptMeta = () => window.__txt(window.__one('.db-import-script-meta'))
  window.__sampleRows = () => window.__all('.db-import-sample-row').map(r =>
    [...r.children].map(c => window.__txt(c)))
  window.__hint = () => window.__txt(window.__one('.db-import-hint'))

  // —— 映射步 ——
  window.__mapRows = () => window.__all('.db-import-mapping-row')
  window.__mapFileCols = () => window.__mapRows().map(r => window.__txt(r.querySelector('.db-import-file-col')))
  window.__mapValues = () => window.__mapRows().map(r => window.__selValue(r.querySelector('.ant-select')))
  window.__mapSelectXY = i => {
    const r = window.__mapRows()[i]
    return r ? window.__xy(r.querySelector('.ant-select')) : null
  }

  // —— 模式步 ——
  window.__radioTexts = () => window.__all('.db-import-step .ant-radio-wrapper').map(w => window.__txt(w))
  window.__radioXY = txt => {
    const w = window.__all('.db-import-step .ant-radio-wrapper').find(x => window.__txt(x) === txt)
    return w ? window.__xy(w) : null
  }
  // Checkbox 的 input 是 opacity:0 的隐形层，只能点它所在的 label
  window.__confirmLabel = () => window.__one('.db-import-confirm')
  window.__confirmXY = () => window.__xy(window.__confirmLabel())
  window.__confirmChecked = () => {
    const b = window.__confirmLabel()
    if (!b) return null
    const i = b.querySelector('input')
    if (i) return !!i.checked
    return /ant-checkbox-checked/.test(String(b.innerHTML || ''))
  }

  // —— 语句清单步 ——
  window.__stmtRows = () => window.__all('.db-import-stmt').map(r => ({
    no: window.__txt(r.querySelector('.db-import-stmt-no')),
    lv: window.__txt(r.querySelector('.db-risk-stmt-lv')),
    text: window.__txt(r.querySelector('.db-import-stmt-text'))
  }))
  window.__stmtNote = () => window.__txt(window.__one('.db-import-stmt-note'))

  // —— 执行步 ——
  window.__alertText = () => window.__txt(window.__one('.db-import-step .ant-alert'))
  window.__progressText = () => window.__txt(window.__one('.db-import-progress'))

  // —— E1 风险闸门 ——
  window.__risk = () => {
    const m = window.__one('.db-risk-modal')
    return m ? {
      text: window.__txt(m),
      stmts: window.__all('.db-risk-modal .db-risk-stmt-text').map(x => window.__txt(x)),
      needInput: !!window.__one('.db-risk-dbname-input'),
      btns: window.__all('.db-risk-modal .ant-modal-footer button').map(b => ({
        text: window.__txt(b), disabled: !!b.disabled
      }))
    } : null
  }
  window.__riskBtnXY = idx => {
    const b = window.__all('.db-risk-modal .ant-modal-footer button')
    return b[idx] ? window.__xy(b[idx]) : null
  }
  window.__riskBtnCount = () => window.__all('.db-risk-modal .ant-modal-footer button').length
  window.__riskTypeDbName = txt => {
    const i = window.__one('.db-risk-dbname-input')
    if (!i) return 'no-input'
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(i, txt)
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  // 期望名从提示文案的括号里取（中英文都是 "…（main）…" / "… (main) …"）：
  // 按空格切最后一个 token 会拿到 "to continue" / "后才可继续"，输进去永远对不上
  window.__riskExpectedName = () => {
    const t = window.__txt(window.__one('.db-risk-dbname-label'))
    const m = t.match(/[（(]([^）)]+)[）)]/)
    return m ? m[1].trim() : ''
  }

  // —— 元数据树（展开 + 选表）——
  window.__collapsedSwitcherXY = () => {
    const el = window.__all('.db-tree .ant-tree-switcher_close')[0]
    return el ? window.__xy(el) : null
  }
  window.__treeNodeXY = name => {
    const hit = window.__all('.db-tree .ant-tree-node-content-wrapper').find(n => {
      const t = window.__txt(n)
      return t === name || t.endsWith('.' + name) || t.split(/\\s+/).pop() === name
    })
    if (!hit) return null
    hit.scrollIntoView({ block: 'center' })
    return window.__xy(hit)
  }
  return 'probed'
})()`

// 文件对话框无法自动化：只把 openFile 换成"对夹具路径走同一个 previewImportFile"，
// 其余 action 一律原样转发给真实主进程。
const WRAP = filePath => `(() => {
  if (!window.__realRun) window.__realRun = window.pre.runGlobalAsync.bind(window.pre)
  window.__impCalls = []
  window.__impFile = ${J(filePath)}
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbImportOp') {
      const action = a[0]
      const arg = a[1] || {}
      window.__impCalls.push({ action, arg })
      if (action === 'openFile') {
        return window.__realRun('dbImportOp', 'preview', {
          filePath: window.__impFile,
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
  // 期望值与产品同源：语句切分用渲染层那份纯模块（classifySql），判据里不再
  // 自己 split(';')，否则"界面下发什么"与"判据认为应该是什么"又是两个口径
  const PLAN = await import(pathToFileURL(
    path.resolve(__dirname, '../src/client/common/db-import-plan.js')
  ).href)
  const planOf = text => PLAN.statementPlan(text, 'sqlite')
  const stmtsOf = text => planOf(text).statements.map(s => s.text)

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
  const norm = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim()
  const clickXY = async (xy, ms = 500, why = '') => {
    if (!xy) throw new Error('拿不到坐标，不能点：' + why)
    await cdp.click(xy.x, xy.y)
    await sleep(ms)
  }

  // ── 真实主进程调用（A–D 腿）──
  const op = async (name, ...args) => await cdp.eval(
    `window.pre.runGlobalAsync(${J(name)}, ${args.map(a => J(a)).join(',')})` +
    '.then(r => ({ok:1, r})).catch(e => ({ok:0, msg: String((e && e.message) || e)}))')
  const waitImport = async (importId, { untilMs = 120000, wantRows = 0 } = {}) => {
    const t0 = Date.now()
    const series = []
    let st = null
    while (Date.now() - t0 < untilMs) {
      st = await op('dbImportOp', 'status', { importId })
      if (!st.ok) throw new Error('status 失败: ' + st.msg)
      const s = st.r
      if (s.committedRows !== series[series.length - 1]) {
        series.push(s.committedRows)
      }
      if (wantRows && s.committedRows >= wantRows) {
        return { st: s, series }
      }
      if (s.status !== 'running') {
        return { st: s, series }
      }
      await sleep(50)
    }
    return { st: st && st.r, series, timedOut: true }
  }
  const pickStartArg = () => cdp.jeval(
    'JSON.stringify((window.__impCalls.filter(c => c.action === "start").pop() || {arg:{}}).arg)')
  const countStarts = () => cdp.jeval('window.__impCalls.filter(c => c.action === "start").length')

  // ── 打开可写的 sqlite 页签 ──
  // 先关掉上一轮遗留的数据库页签，再原地重建夹具表，最后才 addTab：
  // 库文件不换 inode（见 buildFixtures），所以主进程那句柄缓存指向的始终是这一份
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
  const ready = await waitFor(cdp,
    `(async () => { try { const r = await window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'executeSql', {sql: 'SELECT count(*) AS c FROM src_t', database: 'main'}); return r.results[0].rows[0].c === ${SRC.length} } catch (e) { return false } })()`,
    '真连接就绪', 40000)
  check('sqlite 真连接就绪（源表 5 行读得到）', ready)

  // ══════════════════════ 腿 A：预览与格式判定 ══════════════════════
  const pv = async (filePath, format) => await op('dbImportOp', 'preview', { filePath, format })
  const aCsv = await pv(F.csv)
  check('CSV 预览：format=csv / kind=rows / 列名来自首行 / 5 行样例',
    aCsv.ok && aCsv.r.format === 'csv' && aCsv.r.kind === 'rows' &&
      JSON.stringify(aCsv.r.columns) === JSON.stringify(SRC_COLS) &&
      aCsv.r.sampleRows.length === SRC.length,
    aCsv.ok ? { format: aCsv.r.format, cols: aCsv.r.columns, n: aCsv.r.sampleRows.length } : aCsv.msg)

  const aTsv = await pv(F.tsv)
  check('TSV 按扩展名判成制表符（不是逗号）',
    aTsv.ok && aTsv.r.format === 'tsv' && aTsv.r.delimiter === '\t' &&
      JSON.stringify(aTsv.r.columns) === JSON.stringify(SRC_COLS),
    aTsv.ok ? { format: aTsv.r.format, delim: JSON.stringify(aTsv.r.delimiter), cols: aTsv.r.columns } : aTsv.msg)

  const aJsonl = await pv(F.jsonl)
  check('JSONL 预览：kind=rows、列名来自 JSON 键（不是整行文本）',
    aJsonl.ok && aJsonl.r.format === 'jsonl' && aJsonl.r.kind === 'rows' &&
      JSON.stringify(aJsonl.r.columns) === JSON.stringify(JSONL_COLS),
    aJsonl.ok ? { format: aJsonl.r.format, cols: aJsonl.r.columns } : aJsonl.msg)

  const aSql = await pv(F.script)
  const aSqlPlan = aSql.ok ? planOf(aSql.r.scriptText) : null
  check('SQL 预览走脚本形态：kind=script、没有列、带全文',
    aSql.ok && aSql.r.kind === 'script' && aSql.r.format === 'sql' &&
      aSql.r.columns.length === 0 && /INSERT INTO sql_t/.test(aSql.r.scriptText),
    aSql.ok ? { kind: aSql.r.kind, bytes: aSql.r.scriptText.length } : aSql.msg)
  check('脚本全文经产品切分器 = 4 条语句（注释尾巴不成为一条）',
    !!aSqlPlan && aSqlPlan.statements.length === 4 && aSqlPlan.level === 'write',
    aSqlPlan && { n: aSqlPlan.statements.length, level: aSqlPlan.level })

  const aUpper = await pv(F.jsonlUpper)
  check('大写扩展名 .JSONL 也认（大小写不敏感，不回落 CSV）',
    aUpper.ok && aUpper.r.format === 'jsonl', aUpper.ok ? aUpper.r.format : aUpper.msg)

  const aForced = await pv(F.jsonl, 'csv')
  check('显式格式赢过扩展名：同一份 JSONL 按 CSV 判（列名不再是 JSON 键）',
    aForced.ok && aForced.r.format === 'csv' &&
      JSON.stringify(aForced.r.columns) !== JSON.stringify(JSONL_COLS),
    aForced.ok ? { format: aForced.r.format, col0: String(aForced.r.columns[0]).slice(0, 24) } : aForced.msg)

  const aTxt = await pv(F.txt)
  check('.txt 无显式格式 → 回落 CSV（与旧版行为一致）',
    aTxt.ok && aTxt.r.format === 'csv', aTxt.ok ? aTxt.r.format : aTxt.msg)

  const aUnknown = await pv(F.csv, 'parquet')
  check('未知格式 id 明确拒绝，不静默按逗号切',
    !aUnknown.ok && /unknown import format/.test(aUnknown.msg || ''), aUnknown)

  const aHuge = await pv(F.huge)
  check('超 8MB 的 SQL 脚本拒绝并让人用命令行（不把大文本灌进 IPC）',
    !aHuge.ok && /上限/.test(aHuge.msg || ''), aHuge)

  // ══════════════════════ 腿 B：导出 → 导入闭环 ══════════════════════
  const exp = await op('dbExportOp', 'start', {
    tabId, table: 'src_t', database: 'main', format: 'jsonl', targetPath: F.exported
  })
  check('产品导出器起 JSONL 导出任务（闭环的上半段用真实导出，不自造文件）',
    exp.ok && !!exp.r.exportId, exp)
  let expSt = null
  for (let i = 0; i < 200 && (!expSt || expSt.status === 'running'); i++) {
    const s = await op('dbExportOp', 'status', { exportId: exp.r && exp.r.exportId })
    expSt = s.ok ? s.r : { status: 'failed', error: s.msg }
    await sleep(50)
  }
  const exportedText = fs.existsSync(F.exported) ? fs.readFileSync(F.exported, 'utf8') : ''
  check('导出完成且文件非空', expSt.status === 'done' && !!exportedText,
    { status: expSt.status, error: expSt.error, bytes: exportedText.length })

  const exportedLines = exportedText.split('\n').filter(Boolean).map(l => JSON.parse(l))
  check('导出产物每行一个对象、含 data 共 6 键、BLOB 是未截断的 __bin 信封（NULL 列仍是 null）',
    exportedLines.length === SRC.length &&
      JSON.stringify(Object.keys(exportedLines[0])) === JSON.stringify(SRC_COLS) &&
      SRC.every((r, i) => {
        if (!r.data) {
          return exportedLines[i].data === null
        }
        const env = exportedLines[i].data && exportedLines[i].data.__bin
        return !!env && env.truncated === false &&
          Buffer.from(env.b64, 'base64').equals(r.data)
      }),
    exportedLines.map(l => ({ note: l.note, data: l.data && l.data.__bin ? 'bin' : String(l.data) })))

  const impArgs = extra => ({
    tabId,
    database: 'main',
    schema: '',
    table: 'imp_t',
    filePath: F.exported,
    format: 'jsonl',
    mapping: SRC_COLS.map(c => ({ fileCol: c, target: c })),
    ...extra
  })
  const bImp = await op('dbImportOp', 'start', impArgs({ mode: 'overwrite', batchSize: 2 }))
  const bRun = bImp.ok ? await waitImport(bImp.r.importId) : null
  check('导回的 JSONL → 空表 overwrite 导入完成，行数 = 源表行数',
    bImp.ok && bRun && bRun.st.status === 'done' && bRun.st.committedRows === SRC.length,
    bRun ? { status: bRun.st.status, committed: bRun.st.committedRows, error: bRun.st.error } : bImp)

  const wantImp = SRC.map(r => ({
    id: r.id,
    name: r.name,
    score: r.score,
    flag: r.flag,
    note: r.note,
    data: r.data ? r.data.toString('hex').toUpperCase() : null
  }))
  // node:sqlite 的 hex(NULL) 返回空串而不是 NULL，读 BLOB 必须显式分流，
  // 否则"空串"与"真 BLOB 为空"两种情况在断言里会糊成同一个值
  const BLOB_HEX = col => `CASE WHEN ${col} IS NULL THEN NULL ELSE hex(${col}) END`
  const readImp = () => hostSelect(
    `SELECT id, name, score, flag, note, ${BLOB_HEX('data')} AS data FROM imp_t ORDER BY id`)
  check('闭环内容一致（逐字段，含类型/NULL/空串/逗号引号/换行/BLOB 字节）',
    JSON.stringify(readImp()) === JSON.stringify(wantImp),
    { got: readImp(), want: wantImp })

  const bAgain = await op('dbImportOp', 'start', impArgs({ mode: 'overwrite', batchSize: 500 }))
  const bAgainRun = bAgain.ok ? await waitImport(bAgain.r.importId) : null
  check('重跑一次 overwrite：行数仍是 5（覆盖不是追加）',
    bAgainRun && bAgainRun.st.status === 'done' &&
      hostScalar('SELECT count(*) FROM imp_t') === SRC.length,
    { committed: bAgainRun && bAgainRun.st.committedRows, count: hostScalar('SELECT count(*) FROM imp_t') })

  // upsert：改一行 name 后按主键冲突更新
  const upsLines = exportedLines.map((l, i) => (i === 0 ? { ...l, name: 'gamma', note: 'upsert改过' } : l))
  const upsFile = path.join(DEMO_DIR, 'upsert.jsonl')
  fs.writeFileSync(upsFile, upsLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const bUps = await op('dbImportOp', 'start', impArgs({
    filePath: upsFile, mode: 'upsert', batchSize: 500
  }))
  const bUpsRun = bUps.ok ? await waitImport(bUps.r.importId) : null
  const afterUpsert = hostSelect(
    `SELECT id, name, note, ${BLOB_HEX('data')} AS data FROM imp_t ORDER BY id`)
  check('upsert 走主键冲突更新：行数不变、第 1 行被改、BLOB 未被写坏',
    bUpsRun && bUpsRun.st.status === 'done' && afterUpsert.length === SRC.length &&
      afterUpsert[0].name === 'gamma' && afterUpsert[0].note === 'upsert改过' &&
      afterUpsert[1].name === 'bravo' &&
      afterUpsert[0].data === SRC[0].data.toString('hex').toUpperCase(),
    { status: bUpsRun && bUpsRun.st.status, rows: afterUpsert })

  // 截断信封必须整单拒绝（导入它等于静默写坏数据）；目标是真实存在的 blob_t，
  // 让失败原因落在信封本身，而不是"表不存在"
  const truncLine = JSON.stringify({
    id: 99, name: 't', data: { __bin: { size: 99999, b64: 'AAAA', truncated: true } }
  })
  const truncFile = path.join(DEMO_DIR, 'trunc.jsonl')
  fs.writeFileSync(truncFile, truncLine + '\n')
  const bTrunc = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'blob_t',
    filePath: truncFile,
    format: 'jsonl',
    mapping: [{ fileCol: 'id', target: 'id' }, { fileCol: 'data', target: 'name' }],
    mode: 'append',
    batchSize: 10
  })
  const bTruncRun = bTrunc.ok ? await waitImport(bTrunc.r.importId) : null
  check('截断的 __bin 信封在执行侧拒绝（预览不拦，执行必须拦）',
    bTruncRun && bTruncRun.st.status === 'failed' && /截断/.test(bTruncRun.st.error || ''),
    bTruncRun ? { status: bTruncRun.st.status, error: bTruncRun.st.error } : bTrunc)
  check('拒绝截断信封时没有写入半行（blob_t 仍是空表）',
    hostScalar('SELECT count(*) FROM blob_t') === 0, hostScalar('SELECT count(*) FROM blob_t'))

  // ══════════════════════ 腿 C：取消语义（行通道，20000 行）══════════════════════
  const cStart = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'csv_t',
    filePath: F.big,
    format: 'csv',
    mapping: [{ fileCol: 'id', target: 'id' }, { fileCol: 'name', target: 'name' }],
    mode: 'append',
    batchSize: 500
  })
  check('20000 行 CSV 导入任务起来', cStart.ok && !!cStart.r.importId, cStart)
  const halfway = cStart.ok ? await waitImport(cStart.r.importId, { wantRows: 1500 }) : null
  const cCancel = cStart.ok ? await op('dbImportOp', 'cancel', { importId: cStart.r.importId }) : null
  const cFinal = cStart.ok ? await waitImport(cStart.r.importId, { untilMs: 60000 }) : null
  const cSt = cFinal && cFinal.st
  const dbCount = hostScalar('SELECT count(*) FROM csv_t')
  check('中途取消 → 状态 cancelled，且停在批次边界（已提交行数是批次大小的整数倍）',
    cSt && cSt.status === 'cancelled' && cSt.committedRows > 0 &&
      cSt.committedRows % 500 === 0 && cSt.committedRows < 20000,
    cSt ? { status: cSt.status, committed: cSt.committedRows, cancel: cCancel } : cStart)
  check('落库行数 = 报告的已提交行数（未提交的累积批次被丢弃，没有半截批次）',
    cSt && dbCount === cSt.committedRows, { dbCount, committed: cSt && cSt.committedRows })
  // 轮询节奏与批次速度无关（20000 行可能两次轮询就写完了），所以判据是
  // "读到过中间值 + 严格递增"，不是"至少读到 4 次"
  const seriesOf = (halfway && halfway.series) || []
  const monotonic = seriesOf.every((v, i) => i === 0 || v > seriesOf[i - 1])
  check('已提交行数是递增读出来的（分批流式写入，不是整表一次性写完）',
    monotonic && seriesOf.some(v => v > 0 && v < cSt.committedRows),
    { series: seriesOf.slice(0, 8), committed: cSt && cSt.committedRows })

  // ══════════════════════ 腿 D：SQL 脚本通道 ══════════════════════
  const seedStatements = stmtsOf(fs.readFileSync(F.script, 'utf8'))
  const scriptArgs = (filePath, statements) => ({
    tabId, database: 'main', schema: '', filePath, format: 'sql', statements
  })
  const dStart = await op('dbImportOp', 'start', scriptArgs(F.script, seedStatements))
  const dRun = dStart.ok ? await waitImport(dStart.r.importId) : null
  check('脚本通道逐条执行：4 条 → 已执行 4 条、影响行数按语句汇总（DELETE 0 行不充数）',
    dStart.ok && dRun && dRun.st.status === 'done' &&
      dRun.st.totalStatements === 4 && dRun.st.executedStatements === 4 &&
      dRun.st.committedRows === 3,
    dRun ? { ...pickRun(dRun.st) } : dStart)
  const sqlT = hostSelect('SELECT id, tag FROM sql_t ORDER BY id')
  check('脚本效果真落库（UPDATE 也执行到了）',
    JSON.stringify(sqlT) === JSON.stringify([{ id: 10, tag: 'a' }, { id: 11, tag: 'c' }]), sqlT)

  hostWrite(['DELETE FROM sql_t'])
  const dBad = await op('dbImportOp', 'start',
    scriptArgs(F.badScript, stmtsOf(fs.readFileSync(F.badScript, 'utf8'))))
  const dBadRun = dBad.ok ? await waitImport(dBad.r.importId) : null
  check('失败即停：第 2 条报错 → 整体 failed，错误带语句号',
    dBadRun && dBadRun.st.status === 'failed' && dBadRun.st.executedStatements === 1 &&
      /第 2 条/.test(dBadRun.st.error || '') &&
      dBadRun.st.errors.length === 1 && dBadRun.st.errors[0].no === 2,
    dBadRun ? { status: dBadRun.st.status, error: dBadRun.st.error, errors: dBadRun.st.errors } : dBad)
  check('失败后面的语句没有被执行（不跳过继续）',
    hostScalar('SELECT count(*) FROM sql_t WHERE id = 21 OR tag = \'never\'') === 0 &&
      hostScalar('SELECT count(*) FROM sql_t WHERE id = 20') === 1,
    {
      never: hostScalar('SELECT count(*) FROM sql_t WHERE tag = \'never\''),
      firstOk: hostScalar('SELECT count(*) FROM sql_t WHERE id = 20')
    })

  const dRebuild = await op('dbImportOp', 'start', {
    tabId,
    database: 'main',
    schema: '',
    table: 'csv_t',
    filePath: F.csv,
    format: 'csv',
    mapping: [{ fileCol: 'id', target: 'id' }],
    mode: 'rebuild'
  })
  const dRebuildRun = dRebuild.ok ? await waitImport(dRebuild.r.importId) : null
  check('rebuild 模式明确拒绝（D 批实现），不做破坏性操作',
    dRebuildRun && dRebuildRun.st.status === 'failed' &&
      /rebuild 模式暂不支持/.test(dRebuildRun.st.error || ''), dRebuildRun)

  const dNoStmt = await op('dbImportOp', 'start', scriptArgs(F.script, []))
  check('脚本通道缺语句 → 直接拒绝（不给"零调用"当成功）',
    !dNoStmt.ok && /statements/.test(dNoStmt.msg || ''), dNoStmt)

  const dEmptyStmt = await op('dbImportOp', 'start', scriptArgs(F.script, ['SELECT 1', '   ']))
  const dEmptyRun = dEmptyStmt.ok ? await waitImport(dEmptyStmt.r.importId) : null
  check('空白语句被拒绝（不给"少执行一条"留口子）',
    (!dEmptyStmt.ok && /statements|为空/.test(dEmptyStmt.msg || '')) ||
      (dEmptyRun && dEmptyRun.st.status === 'failed' && /为空|不是文本/.test(dEmptyRun.st.error || '')),
    dEmptyRun ? { error: dEmptyRun.st.error } : { msg: dEmptyStmt.msg })

  // 只读连接：写路径必须被主进程侧白名单拦住（渲染层传什么都不算）
  const roTab = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'n4a-readonly',
      dbType: 'sqlite', dbFile: ${J(DB)}, readOnly: true, production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  await waitFor(cdp, `(async () => { try { await window.pre.runGlobalAsync('dbClientOp', ${J(roTab)}, 'executeSql', {sql: 'SELECT 1 AS x', database: 'main'}); return true } catch (e) { return false } })()`,
    '只读页签连上', 40000)
  const roBefore = hostScalar('SELECT count(*) FROM imp_t')
  const dRo = await op('dbImportOp', 'start', impArgs({
    tabId: roTab, mode: 'append', batchSize: 10
  }))
  const dRoRun = dRo.ok ? await waitImport(dRo.r.importId) : null
  check('只读连接导入被拒（错误上抛、任务 failed）',
    dRoRun && dRoRun.st.status === 'failed' && !!dRoRun.st.error,
    dRoRun ? { status: dRoRun.st.status, error: String(dRoRun.st.error || '').slice(0, 160) } : dRo)
  check('只读拒绝没有改动画库（行数不变）',
    roBefore === hostScalar('SELECT count(*) FROM imp_t'),
    { before: roBefore, after: hostScalar('SELECT count(*) FROM imp_t') })
  await cdp.eval(`window.store.delTab(${J(roTab)})`)
  await cdp.eval(`window.store.changeActiveTabId(${J(tabId)})`)
  await sleep(1200)

  // 语句边界取消：12000 条 INSERT，跑到中途取消 → 已执行的保留、未执行的不发
  const manyStatements = stmtsOf(fs.readFileSync(F.many, 'utf8'))
  const dMany = await op('dbImportOp', 'start', scriptArgs(F.many, manyStatements))
  check('12000 条语句的脚本任务起来（语句边界取消腿）',
    dMany.ok && manyStatements.length === 12000, { ok: dMany.ok, n: manyStatements.length })
  const manyHalf = dMany.ok ? await waitImport(dMany.r.importId, { wantRows: 300 }) : null
  await op('dbImportOp', 'cancel', { importId: dMany.r && dMany.r.importId })
  const manyFinal = dMany.ok ? await waitImport(dMany.r.importId, { untilMs: 60000 }) : null
  const mSt = manyFinal && manyFinal.st
  const manyCount = hostScalar('SELECT count(*) FROM sql2_t')
  check('脚本取消停在语句边界：已执行 < 总数，且落库行数 = 已执行条数（不回滚、不补发）',
    mSt && mSt.status === 'cancelled' && mSt.executedStatements > 0 &&
      mSt.executedStatements < manyStatements.length && manyCount === mSt.executedStatements,
    mSt
      ? {
          status: mSt.status,
          executed: mSt.executedStatements,
          dbCount: manyCount,
          halfway: manyHalf && manyHalf.st && manyHalf.st.executedStatements
        }
      : dMany)

  // ══════════════════════ 树导航 + 向导开关 ══════════════════════
  const expandTree = async () => {
    for (let i = 0; i < 4; i++) {
      const sw = await cdp.eval('window.__collapsedSwitcherXY()')
      if (!sw) break
      await clickXY(sw, 800, '树展开箭头')
    }
  }
  const selectTable = async name => {
    await expandTree()
    for (let i = 0; i < 20; i++) {
      const xy = await cdp.eval(`window.__treeNodeXY(${J(name)})`)
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
  const next = async () => {
    await clickXY(await cdp.eval('window.__footerBtnXY("下一步|Next")'), 1000, '下一步')
  }
  // 下拉是"点一下开、再点一下关"的：上一处只是读过选项时它可能还开着，
  // 再点一次就把它关上了 —— 所以先探一下有没有可见选项，没有才点
  const ensureFormatOpen = async () => {
    for (let i = 0; i < 20; i++) {
      if (Number(await cdp.eval('window.__optionTexts().length')) > 0) {
        return true
      }
      await clickXY(await cdp.eval('window.__formatXY()'), 500, '格式下拉')
    }
    return false
  }
  const openFormatDropdown = async () => {
    await ensureFormatOpen()
    return cdp.jeval('JSON.stringify(window.__optionTexts())')
  }
  const chooseOption = async txt => {
    await ensureFormatOpen()
    const xy = await cdp.eval(`window.__optionXY(${J(txt)})`)
    if (!xy) {
      const seen = await cdp.jeval('JSON.stringify(window.__optionTexts())')
      throw new Error('下拉里没有选项 ' + txt + '：' + JSON.stringify(seen))
    }
    await clickXY(xy, 1500, '选项 ' + txt)
  }
  // E1 闸门：ok=false 点取消，ok=true 输库名后点"仍要执行"
  const answerRisk = async (ok, dbName) => {
    const gate = await waitFor(cdp, '!!window.__risk()', 'E1 闸门弹出', 15000)
    if (!gate) {
      return { gate: false, info: null }
    }
    const info = await cdp.jeval('JSON.stringify(window.__risk())')
    if (!ok) {
      await clickXY(await cdp.eval('window.__riskBtnXY(0)'), 1000, '闸门取消')
      return { gate: true, info }
    }
    const expected = await cdp.eval('window.__riskExpectedName()')
    const typed = expected || dbName
    const typeRes = await cdp.eval(`window.__riskTypeDbName(${J(typed)})`)
    await sleep(400)
    // 输完库名后"仍要执行"必须已经放行：灰着说明输的不是期望名，后面必然超时
    const btns = await cdp.jeval('JSON.stringify(window.__risk().btns)')
    const last = await cdp.eval('window.__riskBtnCount() - 1')
    await clickXY(await cdp.eval(`window.__riskBtnXY(${last})`), 1400, '闸门确认')
    return { gate: true, info, typed, typeRes, btns }
  }

  // ══════════════════════ 腿 E：导入向导 UI（行通道）══════════════════════
  const selected = await selectTable('imp_t')
  check('选中目标表 imp_t（导入入口要求先选节点）', selected)
  const btnOk = await waitFor(cdp,
    '!!window.__importBtn() && window.__vis(window.__importBtn()) && window.__importBtnEnabled() === true',
    '可写页签的导入入口出现且可用', 20000)
  check('可写连接 + 选中表 → 导入入口可见可用', !!btnOk,
    await cdp.jeval('JSON.stringify({btn: !!window.__importBtn(), enabled: window.__importBtnEnabled()})'))

  await openWizard(F.csv)
  const eSteps = await cdp.jeval('JSON.stringify(window.__stepTitles())')
  check('行通道 4 步（文件 / 列映射 / 写入模式 / 执行导入）',
    eSteps.length === 4 && /文件|File/i.test(eSteps[0]) && /映射|mapping/i.test(eSteps[1]) &&
      /模式|mode/i.test(eSteps[2]) && /执行|run/i.test(eSteps[3]), eSteps)

  // 格式下拉：候选齐全 + 显式格式赢过扩展名（同一个文件重新解析）
  const fmtOpts = await openFormatDropdown()
  check('格式下拉给全 5 个候选（按扩展名判断 + CSV/TSV/JSONL/SQL）',
    fmtOpts.length === 5 && /CSV/.test(fmtOpts[1]) && /SQL/.test(fmtOpts[4]), fmtOpts)
  await cdp.eval('document.body.click()')
  await sleep(400)
  const autoLabel = await cdp.jeval('window.__formatValue()')
  await chooseOption('CSV')
  const eFmtCsv = await cdp.jeval('JSON.stringify({fmt: window.__formatValue(), path: window.__filePathText()})')
  check('显式选 CSV：值变成 CSV、文件没换（同一路径重新解析）',
    /CSV/i.test(String(eFmtCsv.fmt)) && eFmtCsv.path === F.csv, eFmtCsv)
  await chooseOption('SQL')
  const eFmtSql = await cdp.jeval('JSON.stringify({fmt: window.__formatValue(), steps: window.__stepTitles(), script: window.__scriptMeta()})')
  check('CSV 文件显式选 SQL → 步骤收成脚本通道 3 步（判定权在注册表，不在扩展名）',
    /SQL/i.test(String(eFmtSql.fmt)) && eFmtSql.steps.length === 3,
    { fmt: eFmtSql.fmt, steps: eFmtSql.steps })
  await chooseOption(autoLabel)
  const eFmtBack = await cdp.jeval('JSON.stringify({fmt: window.__formatValue(), steps: window.__stepTitles(), meta: window.__fileMeta(), path: window.__filePathText(), samples: window.__sampleRows().length})')
  check('切回"按扩展名判断"：同一文件重新解析回 CSV、步骤回到 4 步、样例回来了',
    eFmtBack.steps.length === 4 && /CSV/.test(eFmtBack.meta) && eFmtBack.samples === 3 &&
      norm(eFmtBack.fmt) === norm(autoLabel) && eFmtBack.path === F.csv, eFmtBack)
  check('文件步显示"CSV · 大小"（大小来自 totalBytes，单位不重复）',
    /\d+\s*KB/.test(eFmtBack.meta) && !/KB\s*KB/.test(eFmtBack.meta), { meta: eFmtBack.meta })
  await shot('e-file-step-csv')

  await next()
  const eMap = await cdp.jeval('JSON.stringify({cols: window.__mapFileCols(), vals: window.__mapValues()})')
  check('CSV 列自动同名映射（6 列全部映射到表列）',
    JSON.stringify(eMap.cols) === JSON.stringify(SRC_COLS) &&
      eMap.vals.every(v => SRC_COLS.includes(v)), eMap)
  await shot('e-mapping-csv')

  await next()
  const eRadios = await cdp.jeval('JSON.stringify(window.__radioTexts())')
  check('模式步三个写入模式都在（追加 / 覆盖 / UPSERT）',
    eRadios.length === 3 && /追加|Append/i.test(eRadios[0]) &&
      /覆盖|Overwrite/i.test(eRadios[1]) && /UPSERT/i.test(eRadios[2]), eRadios)
  const ovLabel = eRadios.find(t => /覆盖|Overwrite/i.test(t))
  await clickXY(await cdp.eval(`window.__radioXY(${J(ovLabel)})`), 800, '覆盖模式')
  const eDanger = await cdp.jeval('JSON.stringify({box: !!window.__confirmLabel(), checked: window.__confirmChecked(), disabled: window.__startDisabled()})')
  check('危险模式（覆盖）要求勾选确认，未勾选时"开始导入"灰掉',
    eDanger.box && eDanger.checked === false && eDanger.disabled === true, eDanger)

  // 闸门里取消 = 零调用
  await clickXY(await cdp.eval('window.__confirmXY()'), 700, '危险模式确认勾选')
  const eChecked = await cdp.jeval('window.__confirmChecked()')
  const eBeforeGate = await countStarts()
  await clickXY(await cdp.eval('window.__xy(window.__startBtn())'), 1200, '开始导入')
  const gate = await answerRisk(false)
  const eAfterGate = await countStarts()
  check('危险模式在 production 连接上过 E1 闸门（说明了为什么拦）',
    gate.gate && /生产|production|危险|danger|确认/i.test(norm(gate.info && gate.info.text)),
    { text: norm(gate.info && gate.info.text).slice(0, 90) })
  await shot('e-risk-gate-overwrite')
  check('闸门里取消 = 零调用（没有发出 start）',
    gate.gate && eAfterGate === eBeforeGate, { before: eBeforeGate, after: eAfterGate, gate: gate.gate })
  check('危险模式勾选框点得动（勾上才放行开始导入）', eChecked === true, eChecked)
  await closeWizard()

  // 真正经界面跑一次 JSONL 导入（append）：先清表，否则主键冲突把成功腿变成失败腿
  hostWrite(['DELETE FROM imp_t'])
  await openWizard(F.exported)
  const eJsonlFile = await cdp.jeval('JSON.stringify({fmt: window.__formatValue(), meta: window.__fileMeta(), steps: window.__stepTitles().length})')
  // 识别结论来自预览（file.format 落在文件信息行里），不是界面那个下拉：
  // 下拉停在"按扩展名判断"才说明判定权确实只在主进程注册表，界面没有自己猜
  check('产品导出的 JSONL 经界面识别为 JSONL（闭环在界面上也接得上）',
    /按扩展名|auto/i.test(String(eJsonlFile.fmt)) && /JSONL/.test(eJsonlFile.meta) &&
      eJsonlFile.steps === 4, eJsonlFile)
  await next()
  const eJsonlMap = await cdp.jeval('JSON.stringify({cols: window.__mapFileCols(), vals: window.__mapValues()})')
  check('JSONL 的文件列 = JSON 键（6 个，含 data）、默认同名映射',
    JSON.stringify(eJsonlMap.cols) === JSON.stringify(SRC_COLS) &&
      eJsonlMap.vals.every(v => SRC_COLS.includes(v)), eJsonlMap)
  await shot('e-mapping-jsonl')
  await next()
  const eAppendStart = await cdp.jeval('JSON.stringify({disabled: window.__startDisabled(), box: !!window.__confirmLabel()})')
  check('追加模式不需要额外确认勾选（开始导入可直接点）',
    eAppendStart.disabled === false && eAppendStart.box === false, eAppendStart)
  await clickXY(await cdp.eval('window.__xy(window.__startBtn())'), 1500, '开始导入（追加）')
  const eAppendGate = await cdp.eval('!!window.__risk()')
  if (eAppendGate) {
    await answerRisk(true, 'main')
  }
  check('追加模式不进 E1 闸门（非危险写入不打扰用户）', eAppendGate === false, eAppendGate)
  const eRunDone = await waitFor(cdp,
    '(window.__alertText() || \'\').length > 0', '执行步出结果', 30000)
  const eAlert = await cdp.jeval('JSON.stringify({alert: window.__alertText(), progress: window.__progressText(),' +
    ' errs: [...document.querySelectorAll(".db-import-error-item")].map(window.__txt).slice(0, 3)})')
  const eStartArg = await pickStartArg()
  check('界面跑完：执行步报告已提交 5 行',
    !!eRunDone && /5/.test(eAlert.alert) && /行|rows/i.test(eAlert.alert), eAlert)
  check('start 载荷带 filePath / format / mapping / table / mode / batchSize / tabId（旧版缺 filePath → 界面导入必失败）',
    eStartArg.filePath === F.exported && eStartArg.format === 'jsonl' &&
      eStartArg.table === 'imp_t' && Array.isArray(eStartArg.mapping) &&
      eStartArg.mapping.length === SRC_COLS.length && eStartArg.mode === 'append' &&
      eStartArg.batchSize === 500 && eStartArg.tabId === tabId,
    { keys: Object.keys(eStartArg || {}), mapping: (eStartArg.mapping || []).length })
  check('界面导入的落库结果与源表一致（真库回归，不是只看提示文案）',
    JSON.stringify(readImp()) === JSON.stringify(wantImp), readImp())
  await shot('e-run-done-rows')

  // 列名对不上：默认全忽略 → 下一步灰掉；手动映射一列 → 放行
  await closeWizard()
  await openWizard(F.mismatch)
  await next()
  const mmState = await cdp.jeval('JSON.stringify({cols: window.__mapFileCols(), vals: window.__mapValues(), next: window.__nextDisabled()})')
  check('列名对不上：默认全部"忽略"，"下一步"灰掉',
    JSON.stringify(mmState.cols) === JSON.stringify(['zzz']) &&
      /忽略|Ignore/i.test(String(mmState.vals[0])) && mmState.next === true, mmState)
  await clickXY(await cdp.eval('window.__mapSelectXY(0)'), 900, '映射下拉')
  const optXY = await cdp.eval('window.__optionXY("name")')
  check('映射下拉里能选到目标列 name', !!optXY, {
    optXY, seen: await cdp.jeval('JSON.stringify(window.__optionTexts())')
  })
  await clickXY(optXY, 900, '目标列 name')
  const mmAfter = await cdp.jeval('JSON.stringify({vals: window.__mapValues(), next: window.__nextDisabled()})')
  check('映射上一列后"下一步"放行', /name/i.test(String(mmAfter.vals[0])) && mmAfter.next === false, mmAfter)
  await shot('e-mapping-manual')
  await closeWizard()

  // ══════════════════════ 腿 F：脚本通道 UI ══════════════════════
  await openWizard(F.script)
  const fSteps = await cdp.jeval('JSON.stringify(window.__stepTitles())')
  check('SQL 文件 → 步骤自动收成 3 步（没有映射与写入模式）',
    fSteps.length === 3 && /语句|statement/i.test(fSteps[1]), fSteps)
  const fFile = await cdp.jeval('JSON.stringify({meta: window.__fileMeta(), stmt: window.__scriptMeta()})')
  check('文件步给出条数而不是样例（SQL 没有"列"概念）',
    /4/.test(fFile.stmt) && /SQL/.test(fFile.meta), fFile)
  await shot('f-file-step')
  await next()
  const fList = await cdp.jeval('JSON.stringify(window.__stmtRows())')
  const wantStmts = stmtsOf(fs.readFileSync(F.script, 'utf8'))
  check('语句清单：4 行、序号连续、带风险级标签、文本就是产品切分器那 4 条',
    fList.length === 4 && fList.every((r, i) => r.no === String(i + 1)) &&
      fList.every(r => r.lv && r.lv.length > 0) &&
      JSON.stringify(fList.map(r => norm(r.text))) === JSON.stringify(wantStmts.map(norm)),
    fList.map(r => ({ no: r.no, lv: r.lv, text: r.text.slice(0, 40) })))
  const fNote = await cdp.jeval('window.__stmtNote()')
  check('该引擎一次一条 → 说明条在场（sqlite multiStatement=false 的可见降级）',
    /逐条|一次|one by one|one statement/i.test(norm(fNote)), fNote)
  await shot('f-statements')

  // 落库前清表：腿 D 已经往 sql_t 写过数据，清干净才能核对界面这一跑的净效果
  hostWrite(['DELETE FROM sql_t'])
  const fBeforeStart = await countStarts()
  await clickXY(await cdp.eval('window.__xy(window.__startBtn())'), 1200, '脚本通道开始导入')
  const fGate = await answerRisk(true, 'main')
  check('脚本导入过 E1，且弹窗列出的语句与清单是同一批（判定=执行）',
    fGate.gate && fGate.info.stmts.length === 4 &&
      norm(fGate.info.stmts[0]) === norm(wantStmts[0]),
    { n: fGate.info && fGate.info.stmts.length, typed: fGate.typed })
  check('输入期望库名后"仍要执行"才放行（灰着 = 输的不是期望名）',
    fGate.typeRes === 'ok' &&
      (fGate.btns || []).some(b => /仍要执行|Execute|confirm/i.test(b.text) && b.disabled === false),
    { typeRes: fGate.typeRes, typed: fGate.typed, btns: fGate.btns })
  await shot('f-risk-gate')
  const fDone = await waitFor(cdp,
    '/已执行|执行|Executed/i.test(window.__alertText() || \'\')', '脚本执行步出结果', 30000)
  const fAlert = await cdp.jeval('window.__alertText()')
  const fStartArg = await pickStartArg()
  check('脚本通道跑完：报告 4/4 条语句与 3 行影响',
    !!fDone && /4/.test(fAlert) && /3/.test(fAlert), {
      alert: fAlert,
      errs: await cdp.jeval('JSON.stringify([...document.querySelectorAll(".db-import-error-item")].map(window.__txt).slice(0, 3))')
    })
  check('脚本通道的载荷只带 filePath / format / statements（不带 table/mapping/mode/batchSize）',
    fStartArg.filePath === F.script && fStartArg.format === 'sql' &&
      Array.isArray(fStartArg.statements) && fStartArg.statements.length === 4 &&
      fStartArg.table === undefined && fStartArg.mapping === undefined &&
      fStartArg.mode === undefined && fStartArg.batchSize === undefined,
    { keys: Object.keys(fStartArg || {}) })
  const fStartCount = await countStarts()
  check('脚本通道一次执行只发一次 start（闸门放行前为零调用）',
    fStartCount === fBeforeStart + 1, { before: fBeforeStart, after: fStartCount })
  const sqlTAfter = hostSelect('SELECT id, tag FROM sql_t ORDER BY id')
  check('脚本经界面执行后真落库（id 10 / 11→c，DELETE 影响 0 行）',
    JSON.stringify(sqlTAfter) === JSON.stringify([{ id: 10, tag: 'a' }, { id: 11, tag: 'c' }]), sqlTAfter)
  await shot('f-run-done')
  await closeWizard()

  // ══════════════════════ 腿 G：双主题 + 词条 + 异常 ══════════════════════
  await openWizard(F.csv)
  const darkColor = await cdp.jeval('window.__colorOf(".db-import-file-meta")')
  const themeIds = await cdp.jeval('JSON.stringify((window.store.getItems("terminalThemes") || []).map(t => t.id))')
  const curTheme = await cdp.eval('(() => { const c = window.store._config || {}; return c.theme })()')
  const lightId = themeIds.find(id => /light/i.test(String(id))) ||
    themeIds.find(id => String(id) !== String(curTheme))
  let lightColor = null
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1800)
    lightColor = await cdp.jeval('window.__colorOf(".db-import-file-meta")')
    await shot('g-light-theme')
    await cdp.eval('window.store.setTheme(' + J(curTheme) + ')')
    await sleep(1400)
  }
  check('浅色主题：导入向导文字颜色跟 token 变（没有写死）',
    !!lightId && !!darkColor && norm(darkColor) !== norm(lightColor), { darkColor, lightColor, lightId })

  const rawKeys = await cdp.jeval(
    'JSON.stringify((window.__one(".db-import-modal") || {innerText: ""}).innerText.match(/dbImport[A-Za-z]+/g) || [])')
  check('向导里没有未翻译的词条 key', rawKeys.length === 0, rawKeys)
  await closeWizard()

  const errs = await cdp.jeval('JSON.stringify(window.__errs)')
  check('全程无未捕获异常 / 未处理 rejection', errs.length === 0, errs)
  console.log('CDP 侧事件（仅参考）：' + JSON.stringify(cdp.tail(8)))

  console.log('\n════ N4a JSONL/SQL 导入闭环：CDP 验收 ════')
  const failed = results.filter(r => !r.ok)
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length)
  failed.forEach(f => console.log('  FAIL: ' + f.name + ' :: ' + JSON.stringify(f.detail)))
  console.log('截图目录 ' + SHOT_DIR)
  process.exit(failed.length ? 1 : 0)
}

// 状态里的关键字段（判据 detail 里不带整份 errors，避免刷屏）
const pickRun = st => ({
  status: st.status,
  total: st.totalStatements,
  executed: st.executedStatements,
  rows: st.committedRows,
  error: String(st.error || '').slice(0, 120)
})

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
