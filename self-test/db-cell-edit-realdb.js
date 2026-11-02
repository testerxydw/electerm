#!/usr/bin/env node
/**
 * 真机复测（2/3）· MySQL 单元格编辑 —— 打真 MariaDB（数据库面板真机复测三件套之二）
 *
 * 为什么还要真库跑一遍：单元格编辑此前只有两条契约 ——
 *   · src/test/unit-ci/db-cell-update.spec.js（vm 沙箱扣 updateCell 适配器函数喂假连接）
 *   · self-test/db-grid-interactions-demo.js（IPC 边界注入桩 MySQL，量的是交互形状）
 * 两条都钉不住这三件事：
 *   1) 渲染层 → 主进程 → mysql2 → 真 MariaDB 的整条写链路（参数化 UPDATE 是不是真的
 *      落到了那台库、保存后的回读刷新是不是真的发生）；
 *   2) PK 定位、只读闸门（readOnly: true 时编辑入口整个不在场）这些跨层行为；
 *   3) NULL 往返：界面唯一能写 NULL 的入口是「批量改值」弹窗勾 NULL（updateCells，
 *      值为 null 走占位符绑定），内联编辑写回的只有字符串 —— 空串与 NULL 是否可区分
 *      只有真库才验得出来。
 *
 * 三层对账（防"自己对自己"）：
 *   A 参照：node 侧另开一条 mysql2 连接，CREATE/INSERT 本脚本专用临时表，
 *     所有期望值与落库对账都走这条连接的 SELECT；
 *   B 界面：CDP 真点击/双击/键盘驱动编辑，判据读 DOM（单元格文本只以 djb2 哈希
 *     + 长度 + null/空串占位类布尔离开页面）；
 *   C 覆盖面：只读对照 / 内联编辑保存 / 空串 vs NULL / 批量写 NULL / NULL 回填数字 /
 *     Esc 取消 / 写命令白名单 —— 缺任一支 M1 汇总判据就红。
 *
 * 隐私与安全纪律（目标库是生产库）：
 *   · 生产数据零接触：整张脚本只 CREATE/DROP 一张专用临时表 electerm_e2e_edit，
 *     参照连接的每条语句过写闸门（必须含临时表名 + 动词白名单 + 禁多语句），
 *     生产表一条都不会被碰（R2 自证能抓住"无临时表名/写动词/多语句"样本）；
 *   · 判据输出只有计数 / 长度 / 布尔 / djb2 哈希，生产库名不打印，业务表名不进源码；
 *   · 编辑的值全部是本脚本自造的合成值，但跨进程仍只比哈希（纪律统一，不留例外口子）；
 *   · 收尾 DROP 临时表并 SHOW TABLES LIKE 复核零残留。
 *
 * 与判据 E5 的一处口径说明：任务原案写"写命令只允许 updateCell"。实测产品里
 * 「批量改值」弹窗（勾 NULL）是 UI 上唯一能写 NULL 的通道，它发的是 updateCells
 * （同为参数化 UPDATE、按主键逐行定位）。本脚本把白名单放宽为
 * updateCell + updateCells 两种（都是单表参数化写），executeSql / insertRow /
 * deleteRows / dropTable 等仍然零命中，且两者的 table 参数必须等于临时表名。
 *
 * 口令只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-cell-edit-realdb.js [debugPort] [shotDir]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败）。
 * 截图里含库表名 → self-test/db-cell-edit-realdb-shots/ 已在 .gitignore。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9223'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-cell-edit-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const HELPERS = buildHelpers(SPLIT_KEY)
const TBL = 'electerm_e2e_edit'
const TAB_RO = 'cell edit ro'
const TAB_RW = 'cell edit rw'
const { check, skip, results } = makeChecker()
const J = s => JSON.stringify(s)

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}

const CDP_URL = 'http://127.0.0.1:' + PORT + '/json/list'

const L = {
  R1: '凭据纪律：口令不进源码、业务表名不进源码，且护栏自证能抓住硬编码形态',
  R2: '参照连接写闸门自证：语句必须含临时表名且动词白名单，无临时表名/DELETE/UPDATE/多语句/TRUNCATE 样本全拒，临时表 DML/DDL/SELECT/SHOW 全放行',
  P0: '开跑前桥接原装（无别的脚本留桩）、探针装好、ops 监听挂上',
  C1: '真连接起来：树在场、无连接错误条',
  C2: '只读页签打开临时表：格子不带编辑类、双击不进行内编辑、批量改值按钮不在场（对照面）',
  E1: '非只读页签打开临时表：标题带表名、参照列头 id/name/val 全部在场、真画出行',
  E2: '双击 name 单元格 → 行内编辑保存：编辑框预填原值，DOM 显示新值且参照连接 SELECT 确认落库',
  E3: 'NULL 往返：批量改值勾 NULL → 整列落库 NULL（updateCells）；NULL 格内联改回数字 → 落库正确',
  E6: 'NULL/空串可区分：name 内联改成空串 → 落库是空串（长度 0）不是 NULL，DOM 用 .db-cell-empty 占位；NULL 格用 .db-cell-null 占位',
  E4: 'Esc 取消编辑：编辑框关闭，DOM 与参照连接均无变化',
  E5: 'ops 审计：写命令只出现 updateCell/updateCells 且全部只指向临时表；executeSql/insertRow/deleteRows/dropTable 等零命中',
  T1: '双主题：编辑态深色与浅色各一张，底色随主题走（不是写死）',
  Z1: '收尾还原 ops 监听、主题、页签；临时表 DROP 后 SHOW TABLES 零残留复核',
  M1: '覆盖面汇总：只读对照/内联保存/NULL 写/NULL 回填/Esc 取消/空串区分/写命令白名单 全部真跑到'
}
const keys = Object.keys(L)

// —— 参照连接写闸门：本脚本对真库的全部访问都要过这里 ——
// 白名单动词 + 必须含临时表名 + 禁分号（多语句拼接）+ 禁其余写/DDL 关键字。
// 于是生产表一条都进不了语句：不含临时表名的语句在名字闸门就被拒。
const REF_ALLOWED = /^(select|show|create table|drop table|insert into)\b/i
const REF_BANNED = /\b(delete|update|alter|rename|grant|revoke|call|load|lock|unlock|handler|optimize|analyze|repair|truncate|replace|set|use|start|commit|rollback|prepare|execute)\b/i
const assertRef = sql => {
  const s = String(sql).trim()
  if (s.indexOf(';') >= 0) {
    throw new Error('检测到分号（多语句拼接），拒绝发往真库')
  }
  if (!new RegExp('`?' + TBL + '`?').test(s)) {
    throw new Error('语句不含临时表 ' + TBL + '，拒绝发往真库（生产表零接触）')
  }
  if (!REF_ALLOWED.test(s)) {
    throw new Error('动词不在白名单（SELECT/SHOW/CREATE TABLE/DROP TABLE/INSERT INTO），拒绝发往真库')
  }
  const bad = REF_BANNED.exec(s)
  if (bad) {
    throw new Error('语句含禁用关键字 ' + bad[1] + '，拒绝发往真库')
  }
  return s
}

// 与页内 window.__hash 同一套 djb2（有符号 int32）：跨进程只比哈希，值不外传
const djb2 = s => {
  let h = 5381
  const t = String(s === null || s === undefined ? '' : s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return h
}

let refConn = null
const refOpen = async () => {
  const mysql = require('mysql2/promise')
  refConn = await mysql.createConnection({
    host: ENV.host,
    port: Number(ENV.port),
    user: ENV.user,
    password: ENV.pass || '',
    database: ENV.db
  })
  return refConn
}
const refq = async (sql, args) => {
  assertRef(sql)
  const [rows] = await refConn.query(sql, args || [])
  return rows
}
// 等主进程写链路落库：界面上"保存成功"只说明 IPC 回包，落库与否以参照连接为准
const pollRef = async (sql, args, want, timeout = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    let rows = []
    try {
      rows = await refq(sql, args)
    } catch (e) { /* 重连竞态：下一轮再试 */ }
    if (want(rows)) return true
    await sleep(400)
  }
  return false
}

// —— 页内探针（数据页网格 + 行内编辑器 + 批量改值弹窗 + ops 审计） ——
const PROBE = `(() => {
  window.__txt = el => String((el && el.innerText) || '').replace(/\\s+/g, '')
  window.__alerts = () => JSON.stringify({
    connErr: [...document.querySelectorAll('.db-session-error')].filter(window.__vis)
      .map(x => String(x.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 1)
  })
  window.__tree = () => [...document.querySelectorAll('.db-tree')].filter(x => !window.__hidden(x))[0] || null
  // 手动展开某个库节点（点 switcher，与 1/3 同一路径）
  window.__toggleDb = name => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    for (const el of [...t.querySelectorAll('.db-tree-db-title')].filter(x => !window.__hidden(x))) {
      if (window.__txt(el) !== String(name)) continue
      const tn = el.closest('.ant-tree-treenode')
      const sw = tn ? tn.querySelector('.ant-tree-switcher') : null
      if (!sw) return 'no-switcher'
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'ok'
    }
    return 'not-found'
  }
  // 叶子（表）可见性：图标字形不算名字的一部分
  const leafName = w => {
    const ic = w.querySelector('.db-tree-obj-icon')
    const all = window.__txt(w)
    return ic ? all.replace(window.__txt(ic), '') : all
  }
  window.__leafVisible = name => {
    const t = window.__tree()
    if (!t) return false
    return [...t.querySelectorAll('.ant-tree-node-content-wrapper')].some(w => {
      if (window.__hidden(w)) return false
      if (w.querySelector('.db-tree-db-title') || w.querySelector('.db-tree-schema')) return false
      return leafName(w) === String(name)
    })
  }
  window.__leafClick = name => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    for (const w of [...t.querySelectorAll('.ant-tree-node-content-wrapper')].filter(x => !window.__hidden(x))) {
      if (w.querySelector('.db-tree-db-title') || w.querySelector('.db-tree-schema')) continue
      if (leafName(w) !== String(name)) continue
      const r = w.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return 'zero-size'
      w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 4, clientY: r.y + r.height / 2 }))
      return 'ok'
    }
    return 'not-found'
  }
  // 数据页网格：页面上同时挂着数据网格与 SQL 结果外壳两张 .db-grid-table，
  // 后者常驻 0 高只有空表头 —— 按"真渲染出表头且容器有高度"筛（1/3 同款）
  window.__dgrid = () => {
    const cands = [...document.querySelectorAll('.db-grid-table')]
      .filter(el => !window.__hidden(el) && el.getBoundingClientRect().height > 0)
    for (const el of cands) {
      if (el.querySelectorAll('thead th').length > 1) return el
    }
    return cands[0] || null
  }
  window.__dheads = () => {
    const g = window.__dgrid()
    if (!g) return []
    const nameOf = t => {
      const n = t.querySelector('.db-col-name')
      return String(((n && n.innerText) || t.innerText || '')).trim().split('\\n')[0]
    }
    return [...g.querySelectorAll('thead th')].filter(window.__vis).map(nameOf)
  }
  window.__drows = () => {
    const g = window.__dgrid()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  // 数据页就绪读数：标题带表名 + 参照列头全部在场 + 真画出行
  window.__dready = arg => {
    const g = window.__dgrid()
    if (!g) return JSON.stringify({ ok: 0, reason: 'no-grid' })
    const heads = window.__dheads()
    const miss = arg.cols.filter(c => heads.indexOf(c) < 0).length
    const title = window.__one('.db-grid-title')
    return JSON.stringify({
      ok: 1,
      titleHas: title ? String(title.innerText || '').indexOf(arg.name) >= 0 : false,
      heads,
      miss,
      rows: window.__drows().length
    })
  }
  window.__findRow = idVal => window.__drows().find(r => {
    // 虚拟表格整行是 div.ant-table-row，格子是 div.ant-table-cell[aria-label=列名]
    const idEl = r.querySelector('[aria-label="id"]')
    return idEl && idEl.textContent.trim() === String(idVal)
  }) || null
  // 单元格读数：文本只回长度 + djb2 + NULL/空串占位类布尔
  window.__dcell = (idVal, col) => {
    const tr = window.__findRow(idVal)
    if (!tr) return JSON.stringify({ exists: 0, reason: 'no-row:' + String(idVal) })
    const td = tr.querySelector('[aria-label="' + col + '"]')
    if (!td) return JSON.stringify({ exists: 0, reason: 'no-col:' + col })
    const t = String(td.textContent || '')
    return JSON.stringify({
      exists: 1,
      len: t.length,
      hash: window.__hash(t),
      nullSpan: !!td.querySelector('.db-cell-null'),
      emptySpan: !!td.querySelector('.db-cell-empty')
    })
  }
  window.__cellXY2 = (idVal, col) => {
    const g = window.__dgrid()
    if (!g) return JSON.stringify({ error: 'no-grid' })
    const tr = window.__findRow(idVal)
    if (!tr) return JSON.stringify({ error: 'no-row:' + String(idVal) })
    const td = tr.querySelector('[aria-label="' + col + '"]')
    if (!td) return JSON.stringify({ error: 'no-col:' + col })
    const r = td.getBoundingClientRect()
    const gr = g.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + Math.min(r.width / 2, 60)),
      y: Math.round(r.top + r.height / 2),
      inView: r.left >= gr.left - 2 && r.right <= gr.right + 2 && r.top >= gr.top - 2 && r.bottom <= gr.bottom + 2
    })
  }
  window.__editableCount = () => {
    const g = window.__dgrid()
    return g ? g.querySelectorAll('.db-cell-editable').length : -1
  }
  // 行内编辑器（antd Input，className 落在 input 元素上）
  // __editorOpen 给 waitFor 用的纯布尔；__editor 给判据用的 JSON 明细
  window.__editorOpen = () => {
    const el = document.querySelector('input.db-cell-editor')
    return el && !window.__hidden(el) ? 1 : 0
  }
  window.__editor = () => {
    const el = document.querySelector('input.db-cell-editor')
    if (!el || window.__hidden(el)) return JSON.stringify({ open: 0 })
    return JSON.stringify({ open: 1, len: String(el.value).length, hash: window.__hash(String(el.value)) })
  }
  // React 受控 Input：原生 setter + input 事件（Enter/Esc 走 CDP 真键）
  window.__setEditor = v => {
    const el = document.querySelector('input.db-cell-editor')
    if (!el) return 'no-editor'
    el.focus()
    const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    st.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  // 行选择（批量改值弹窗的前置：先勾行）
  window.__selCount = () => window.__drows().filter(r => /ant-table-row-selected/.test(String(r.className))).length
  window.__clickHeaderSel = () => {
    const g = window.__dgrid()
    if (!g) return 'no-grid'
    const inp = g.querySelector('thead .ant-table-selection-column input[type=checkbox]')
    if (!inp) return 'no-input'
    inp.click()
    return 'ok'
  }
  // 批量改值按钮：文案「批量改值(n)」/「Set value(n)」
  window.__bulkBtn = () => {
    const b = [...document.querySelectorAll('button')].filter(window.__vis)
      .find(x => /^(批量改值|Set value)/.test(String(x.innerText || '').trim()))
    if (!b) return JSON.stringify({ found: 0 })
    return JSON.stringify({ found: 1, disabled: !!b.disabled })
  }
  window.__clickBulkBtn = () => {
    const b = [...document.querySelectorAll('button')].filter(window.__vis)
      .find(x => /^(批量改值|Set value)/.test(String(x.innerText || '').trim()))
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  // 批量改值弹窗：以 .db-bulk-form 为锚点反查所属 .ant-modal。
  // 不能取"第一个可见 .ant-modal"——上一个弹窗淡出动画期间仍是可见元素，会被误抓。
  window.__modalEl = () => {
    const form = document.querySelector('.db-bulk-form')
    if (!form) return null
    return form.closest('.ant-modal') || form
  }
  window.__modalOpen = () => window.__modalEl() ? 1 : 0
  window.__modal = () => {
    const m = window.__modalEl()
    if (!m) return JSON.stringify({ open: 0 })
    const ok = m.querySelector('.ant-modal-footer .ant-btn-primary')
    const cb = m.querySelector('.db-bulk-form .ant-checkbox-input')
    const inputs = [...m.querySelectorAll('.db-bulk-form input.ant-input')]
    return JSON.stringify({
      open: 1,
      hasNullCb: !!cb,
      valDisabled: inputs.some(i => i.disabled),
      okDisabled: ok ? !!ok.disabled : -1
    })
  }
  window.__modalPickColXY = () => {
    const m = window.__modalEl()
    const form = document.querySelector('.db-bulk-form')
    const sel = form && form.querySelector('.db-select, .ant-select-selector, .ant-select')
    if (!sel) {
      // 诊断：只出标签名+类名（无行数据），定位 antd 结构与选择器不匹配的原因
      const cls = form
        ? [...form.querySelectorAll('*')].slice(0, 14).map(x =>
          x.tagName.toLowerCase() + '[' + String(x.className || '').split(' ').filter(Boolean).slice(0, 4).join('.') + ']')
        : null
      return JSON.stringify({ error: 'no-select', hasModal: !!m, hasForm: !!form, cls })
    }
    const r = (sel.classList.contains('ant-select') ? sel.querySelector('.ant-select-selector') || sel : sel)
      .getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  const dropOptions = () => [...document.querySelectorAll('.ant-select-dropdown')]
    .filter(window.__vis)
    .reduce((a, d) => a.concat([...d.querySelectorAll('.ant-select-item-option, .ant-select-item')]), [])
  window.__colOptions = () => JSON.stringify(dropOptions().map(o => String(o.title || o.textContent).trim()))
  window.__clickColOption = t => {
    const o = dropOptions().find(x => {
      const s = String(x.title || x.textContent).trim()
      return s === String(t) || s.startsWith(String(t) + ' ')
    })
    if (!o) return 'no-option'
    o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    o.click()
    return 'ok'
  }
  window.__modalNull = () => {
    const m = window.__modalEl()
    const cb = m && m.querySelector('.db-bulk-form .ant-checkbox-input')
    if (!cb) return 'no-checkbox'
    cb.click()
    return 'ok'
  }
  window.__modalOk = () => {
    const m = window.__modalEl()
    const ok = m && m.querySelector('.ant-modal-footer .ant-btn-primary')
    if (!ok) return 'no-ok'
    if (ok.disabled) return 'ok-disabled'
    ok.click()
    return 'ok'
  }
  // ops 审计：dbClientOp 的 op 名 + table 参数（值留在页面里，只出计数/布尔）
  window.__ops = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    const wrapped = function (name) {
      if (name === 'dbClientOp') {
        const args = arguments[3] || {}
        window.__ops.push({ op: String(arguments[2]), tbl: String(args.table || '') })
      }
      return orig.apply(window.pre, arguments)
    }
    window.__opsSpied = 1
    window.__opsOrig = orig
    window.pre.runGlobalAsync = wrapped
    return 'ok'
  }
  window.__restoreOps = () => {
    if (!window.__opsOrig) return 'nothing'
    window.pre.runGlobalAsync = window.__opsOrig
    window.__opsSpied = 0
    window.__opsOrig = null
    return 'restored'
  }
  window.__audit = tbl => {
    const ops = window.__ops || []
    const writeRe = /^(updateCell|updateCells|insertRow|deleteRows|executeSql|dropTable|createTable|truncateTable|applyChanges|deleteRow)$/
    const wr = ops.filter(o => writeRe.test(o.op))
    const violations = [...new Set(wr.filter(o => o.op !== 'updateCell' && o.op !== 'updateCells').map(o => o.op))]
    const tableBad = wr.filter(o => o.tbl !== String(tbl)).length
    return JSON.stringify({
      total: ops.length,
      writeCount: wr.length,
      violations,
      tableBad,
      names: [...new Set(ops.map(o => o.op))]
    })
  }
  // 主题取色：body 底色 + 数据格文字色 + 编辑框边框色（有一项随主题变即算数）
  window.__colors = () => {
    const ed = document.querySelector('input.db-cell-editor')
    const rows = window.__drows()
    const cell = rows[0] || null
    return JSON.stringify({
      bodyBg: String(getComputedStyle(document.body).backgroundColor),
      cellColor: cell ? String(getComputedStyle(cell).color) : null,
      edBorder: ed ? String(getComputedStyle(ed).borderTopColor) : null,
      edOpen: ed ? 1 : 0
    })
  }
  return 'probe-installed'
})()
`

let cdpRef = null
const cfg0 = { theme: null }
const openedTabs = []

const closeTab = async id => {
  try {
    await cdpRef.eval('(async () => { await window.store.delTab(' + J(id) + ') })()')
  } catch (e) { /* 收尾尽力而为 */ }
  const i = openedTabs.indexOf(id)
  if (i >= 0) openedTabs.splice(i, 1)
}

const restoreAll = async () => {
  if (!cdpRef) return
  try {
    for (const id of [...openedTabs]) {
      await closeTab(id)
    }
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + J(cfg0.theme) + ')').catch(() => {})
    }
    const r = await cdpRef.eval('window.__restoreOps()').catch(() => 'no-probe')
    console.log('restored: ops=' + r + ' tabs=' + openedTabs.length + ' theme=' + cfg0.theme)
  } catch (e) {
    console.log('restore failed（ops 监听 / 主题 / 页签需手工确认）: ' + e.message)
  }
}

const finish = () => {
  const bad = results.filter(r => !r.ok)
  const skipped = results.filter(r => r.skipped)
  console.log('\n' + (results.length - bad.length - skipped.length) + '/' +
    results.length + ' PASS（跳过 ' + skipped.length + '）')
  for (const one of bad) {
    console.log('FAILED → ' + one.name + ' :: ' + JSON.stringify(one.detail))
  }
  return bad.length
}

const skipAll = reason => {
  // 已出过结论的判据不再补 SKIP：否则一条 FAIL 紧跟一条同名 SKIP，总数虚高
  const done = new Set(results.map(r => r.name))
  for (const k of keys) {
    if (!done.has(L[k])) skip(L[k], reason)
  }
}

// 真键（Enter / Escape / F2）：CDP Input 域派发，与真人同一事件路径
const pressKey = async (cdp, key, code, text) => {
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    ...(text ? { text } : {})
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
  })
}

// 单元格读数（node 侧便捷封装）
const cellOf = async (cdp, idVal, col) =>
  cdp.jeval('window.__dcell(' + J(String(idVal)) + ', ' + J(col) + ')')

// DOM 轮询：等某格满足 want（编辑保存后 loadQuery 回读有延迟）
const pollCell = async (cdp, idVal, col, want, timeout = 15000) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeout) {
    last = await cellOf(cdp, idVal, col)
    if (last.exists === 1 && want(last)) return last
    await sleep(500)
  }
  return null
}

// 打开数据库页签（readOnly 参数是本脚本的核心变量）
const openDbTab = async (cdp, title, readOnly) => {
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(title)},
      dbType: 'mysql', dbHost: ${J(ENV.host)}, dbPort: Number(${J(ENV.port)}),
      dbUser: ${J(ENV.user)}, dbPassword: ${J(ENV.pass)},
      dbName: ${J(ENV.db)}, dbSsl: false,
      readOnly: ${readOnly ? 'true' : 'false'}, production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  return String(await cdp.eval('String(window.store.activeTabId)'))
}

// 展开库 → 点临时表叶子 → 等数据网格真画出来（标题/列头/行数齐）
const openTable = async cdp => {
  if (!await waitFor(cdp,
    '!!window.__tree() || !!window.__one(".db-session-error")', 'tree or conn error', 60000)) {
    return { ok: false, stage: 'no-tree' }
  }
  if (!await waitFor(cdp,
    '!!window.__tree() && window.__tree().querySelectorAll(".db-tree-db-title").length > 0',
    'db nodes', 60000)) {
    return { ok: false, stage: 'no-db-nodes' }
  }
  const tg = await cdp.eval('window.__toggleDb(' + J(ENV.db) + ')')
  if (tg !== 'ok') return { ok: false, stage: 'toggleDb:' + tg }
  if (!await waitFor(cdp, 'window.__leafVisible(' + J(TBL) + ')', 'leaf ' + TBL, 20000)) {
    return { ok: false, stage: 'leaf-not-visible' }
  }
  const cl = await cdp.eval('window.__leafClick(' + J(TBL) + ')')
  if (cl !== 'ok') return { ok: false, stage: 'leafClick:' + cl }
  for (let i = 0; i < 30; i++) {
    await sleep(700)
    const r = await cdp.jeval('window.__dready(' + J({ name: TBL, cols: ['id', 'name', 'val'] }) + ')')
    if (r.ok === 1 && r.titleHas && r.miss === 0 && r.rows > 0) return { ok: true, grid: r }
  }
  return { ok: false, stage: 'grid-not-ready', last: await cdp.jeval('window.__dready(' + J({ name: TBL, cols: ['id', 'name', 'val'] }) + ')') }
}

// 进入某格的行内编辑态：先单击（选中会展开底部值面板、网格被挤压），
// 等布局稳定后按新坐标真双击 —— 与真人操作同序
const openEditor = async (cdp, idVal, col) => {
  let xy = await cdp.jeval('window.__cellXY2(' + J(String(idVal)) + ', ' + J(col) + ')')
  if (!xy || xy.error) return { ok: false, why: 'cellXY:' + JSON.stringify(xy) }
  if (xy.inView === false) return { ok: false, why: 'out-of-view' }
  await cdp.click(xy.x, xy.y)
  await sleep(600)
  xy = await cdp.jeval('window.__cellXY2(' + J(String(idVal)) + ', ' + J(col) + ')')
  if (!xy || xy.error || xy.inView === false) return { ok: false, why: 'cellXY-2nd:' + JSON.stringify(xy) }
  await cdp.click(xy.x, xy.y, 2)
  let opened = await waitFor(cdp, 'window.__editorOpen() === 1', 'cell editor open', 5000)
  let via = 'dblclick'
  if (!opened) {
    // 兜底：数据页键盘可达路径（单击选中后 F2 进编辑，与双击同一个 startEdit 入口）
    await pressKey(cdp, 'F2', 113)
    opened = await waitFor(cdp, 'window.__editorOpen() === 1', 'cell editor via F2', 3000)
    via = 'F2'
  }
  if (!opened) return { ok: false, why: 'editor-not-open' }
  const ed = await cdp.jeval('window.__editor()')
  return { ok: true, ed, via }
}

const closeEditor = async (cdp, mode) => {
  await sleep(150)
  if (mode === 'esc') {
    await pressKey(cdp, 'Escape', 27)
  } else {
    await pressKey(cdp, 'Enter', 13, '\r')
  }
  await sleep(300)
  return await cdp.eval('window.__editorOpen()')
}

// 双击进编辑 → 换值 → Enter 提交（Esc 走 cancelEdit，见 E4）
const editCell = async (cdp, idVal, col, newText, mode) => {
  const op = await openEditor(cdp, idVal, col)
  if (!op.ok) return op
  if (newText !== null) {
    await cdp.eval('window.__setEditor(' + J(newText) + ')')
    await sleep(200)
  }
  const open = await closeEditor(cdp, mode || 'enter')
  return { ok: open === 0, ed: op.ed, why: open === 0 ? '' : 'editor-still-open' }
}

// 批量改值弹窗：勾整页行 → 开弹窗 → 选 val 列 → 勾 NULL → 确定
const bulkSetValNull = async cdp => {
  const hs = await cdp.eval('window.__clickHeaderSel()')
  await sleep(500)
  let selN = await cdp.eval('window.__selCount()')
  if (selN !== 5) {
    // 表头全选没生效时退回逐行勾选（行内 checkbox 带 aria-label "Select row N"）
    await cdp.eval(`(() => {
      const g = window.__dgrid()
      if (!g) return 'no-grid'
      ;[...g.querySelectorAll('.ant-table-row')].forEach(r => {
        if (/ant-table-row-selected/.test(String(r.className))) return
        const inp = r.querySelector('.ant-table-selection-column input[type=checkbox]')
        if (inp) inp.click()
      })
      return 'ok'
    })()`)
    await sleep(500)
    selN = await cdp.eval('window.__selCount()')
  }
  if (selN !== 5) return { ok: false, why: 'selected:' + selN + ' header:' + hs }
  const bb = await cdp.jeval('window.__bulkBtn()')
  if (!bb.found) return { ok: false, why: 'no-bulk-btn' }
  if (bb.disabled) return { ok: false, why: 'bulk-btn-disabled' }
  await cdp.eval('window.__clickBulkBtn()')
  if (!await waitFor(cdp, 'window.__modalOpen() === 1', 'bulk modal', 5000)) {
    return { ok: false, why: 'no-modal' }
  }
  // 列下拉：真实坐标点击（React 受控 Select 与真人同一路径）
  const pxy = await cdp.jeval('window.__modalPickColXY()')
  if (!pxy || pxy.error) return { ok: false, why: 'pick-xy:' + JSON.stringify(pxy) }
  await cdp.click(pxy.x, pxy.y)
  if (!await waitFor(cdp, 'window.__colOptions().length > 0', 'col dropdown', 8000)) {
    return { ok: false, why: 'no-col-options', dropdowns: await cdp.jeval('window.__colOptions()') }
  }
  const pick = await cdp.eval('window.__clickColOption("val")')
  if (pick !== 'ok') return { ok: false, why: 'pick:' + pick }
  await sleep(300)
  const nc = await cdp.eval('window.__modalNull()')
  if (nc !== 'ok') return { ok: false, why: 'null-cb:' + nc }
  await sleep(300)
  const m = await cdp.jeval('window.__modal()')
  if (!m.valDisabled) return { ok: false, why: 'val-input-not-disabled-after-null', m }
  const okR = await cdp.eval('window.__modalOk()')
  await sleep(600)
  return { ok: okR === 'ok', why: okR }
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // ---------- 凭据纪律 + 护栏自证 ----------
  const missing = Object.entries(ENV)
    .filter(([, v]) => v === undefined || v === null || v === '')
    .filter(([k]) => k !== 'pass')
    .map(([k]) => k)
  const passGiven = ENV.pass !== undefined && ENV.pass !== ''
  const src = fs.readFileSync(__filename, 'utf8')
  // 泄密判定要放过"口令恰好等于某个键名"的用法：值作为独立 token 出现、后面不紧接冒号才算泄密；
  // 同一条判定要自证能抓住三种硬编码形态，且不误抓键名用法（否则护栏形同虚设）。
  const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const findSecret = (text, v) => {
    if (!v) return false
    return new RegExp('(?:^|[^A-Za-z0-9_])' + escRe(v) + '(?![A-Za-z0-9_:])').test(String(text))
  }
  const hasSecret = findSecret(src, ENV.pass)
  const leakForms = passGiven
    ? ['  pass: ' + J(ENV.pass) + ',', 'RDB_MYSQL_PASS=' + ENV.pass, "const p = '" + ENV.pass + "'"]
    : []
  const caught = leakForms.filter(s => findSecret(s, ENV.pass)).length
  const keyNameOk = passGiven && findSecret(ENV.pass + ': ENV.pass || \'\',', ENV.pass)
  // 业务元数据也不许进这份会入库的源码：目标库的表名都有共同前缀，前缀即指纹
  const noBusinessName = !/[a-z0-9]+_[a-z0-9]+_[a-z0-9]+_tbl\b/i.test(src) &&
    !/\btgfsom_[a-z0-9_]+/i.test(src)
  check(L.R1, missing.length === 0 && passGiven && !hasSecret &&
    caught === leakForms.length && keyNameOk === false && noBusinessName,
  { missing, passGiven, hasSecret, caught, keyNameOk, noBusinessName })

  let gReject = 0
  const gRejectBad = []
  for (const bad of ['DELETE FROM ' + TBL + ' WHERE id=1',
    'UPDATE other_table SET a=1 WHERE id=1',
    'SELECT 1',
    'SELECT * FROM information_schema.TABLES',
    'DROP TABLE other_table',
    'SELECT 1; DROP TABLE ' + TBL,
    'INSERT INTO other_table VALUES (1)',
    'TRUNCATE ' + TBL]) {
    try {
      assertRef(bad)
      gRejectBad.push(bad.slice(0, 16))
    } catch (e) {
      gReject++
    }
  }
  let gAccept = 0
  const gateBad = []
  const SQL_CREATE = 'CREATE TABLE IF NOT EXISTS `' + TBL + '` (' +
    'id INT PRIMARY KEY, name VARCHAR(64) NULL, val INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  const SQL_INSERT = 'INSERT INTO `' + TBL + '` (id, name, val) VALUES ' +
    "(1,'row-name-1',10),(2,'row-name-2',20),(3,'row-name-3',NULL),(4,'row-name-4',40),(5,'row-name-5',50)"
  for (const good of [SQL_CREATE,
    SQL_INSERT,
    'SELECT name FROM `' + TBL + '` WHERE id = 1',
    'SELECT COUNT(*) AS n FROM `' + TBL + '` WHERE val IS NOT NULL',
    'DROP TABLE IF EXISTS `' + TBL + '`',
    "SHOW TABLES LIKE '" + TBL + "'"]) {
    try {
      assertRef(good)
      gAccept++
    } catch (e) {
      gateBad.push(String(e.message).slice(0, 40))
    }
  }
  check(L.R2, gReject === 8 && gRejectBad.length === 0 && gAccept === 6 && gateBad.length === 0,
  { gReject, gAccept, leakedThrough: gRejectBad, gateBad })
  if (missing.length || !passGiven || hasSecret || caught !== leakForms.length || keyNameOk ||
    !noBusinessName || gReject !== 8 || gAccept !== 6) {
    skipAll('凭据/护栏不成立，整批跳过（不发任何真库请求）')
    return finish()
  }

  // ---------- 参照：建临时表 + 种子（node 直连，先于界面） ----------
  try {
    await refOpen()
    await refq('DROP TABLE IF EXISTS `' + TBL + '`')
    await refq(SQL_CREATE)
    await refq(SQL_INSERT)
  } catch (e) {
    check(L.C1, false, { refError: String(e.message).slice(0, 120) })
    skipAll('真库临时表准备失败：' + String(e.message).slice(0, 80))
    return finish()
  }
  const seedRows = (await refq('SELECT COUNT(*) AS n FROM `' + TBL + '`'))[0].n
  const seedNulls = (await refq('SELECT COUNT(*) AS n FROM `' + TBL + '` WHERE val IS NULL'))[0].n
  console.log('参照: 临时表就绪 rows=' + seedRows + ' valNull=' + seedNulls)

  // ---------- 界面 ----------
  const targets = await getJson(CDP_URL)
  const page = findPageTarget(targets)
  if (!page) {
    check(L.P0, false, { targets: targets.length })
    skipAll('找不到渲染进程')
    return finish()
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)
  // 同实例可能跑过桩版演示（接管 runGlobalAsync 不还原）→ 先重载再开真库页签
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  const booted = await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000)
  if (!booted) {
    check(L.P0, false, { booted })
    skipAll('渲染进程没起来，后续判据没有意义')
    return finish()
  }
  await cdp.eval(HELPERS)
  await cdp.eval(PROBE)
  const stub = await preStubState(cdp)
  const probeNames = ['__txt', '__alerts', '__tree', '__toggleDb', '__leafVisible', '__leafClick',
    '__dgrid', '__dheads', '__dready', '__dcell', '__cellXY2', '__editableCount', '__editorOpen',
    '__editor', '__setEditor', '__selCount', '__clickHeaderSel', '__bulkBtn', '__clickBulkBtn',
    '__modalEl', '__modalOpen', '__modal', '__modalPickColXY', '__colOptions', '__clickColOption',
    '__modalNull', '__modalOk', '__spyOps', '__restoreOps', '__audit', '__colors']
  const probeOk = await cdp.eval('JSON.stringify(' + J(probeNames) + '.map(n => typeof window[n]).join(","))')
  const spy = await cdp.eval('window.__spyOps()')
  check(L.P0, stub === 'ok' && spy === 'ok' &&
    String(probeOk) === J(probeNames.map(() => 'function').join(',')),
  { stub, spy, probeOk })

  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))

  const covered = []

  // ---------- 只读页签（对照面）：树在场，编辑入口整个不在 ----------
  const roId = await openDbTab(cdp, TAB_RO, true)
  openedTabs.push(roId)
  const roTree = await waitFor(cdp,
    '!!window.__tree() || !!window.__one(".db-session-error")', 'ro tree or conn error', 60000)
  const al = await cdp.jeval('window.__alerts()')
  check(L.C1, roTree && !(al.connErr || []).length, { roTree, err: (al.connErr || [])[0] || '' })
  if (!roTree || (al.connErr || []).length) {
    skipAll('真库连接没起来：后续判据跳过')
    return finish()
  }
  const ro = await openTable(cdp)
  const roEditable = ro.ok ? await cdp.eval('window.__editableCount()') : -1
  let roDbl = 'grid-not-open'
  if (ro.ok) {
    const xy = await cdp.jeval('window.__cellXY2("1", "name")')
    if (xy && !xy.error && xy.inView !== false) {
      await cdp.click(xy.x, xy.y, 2)
      await sleep(1000)
      roDbl = await cdp.eval('window.__editorOpen()')
    } else {
      roDbl = 'no-cell:' + JSON.stringify(xy)
    }
  }
  const roBulk = ro.ok ? await cdp.jeval('window.__bulkBtn()') : { found: -1 }
  // 批量改值按钮：只读下整个不渲染（或渲染但禁用）都算编辑入口不在场
  const bulkGone = roBulk.found === 0 || roBulk.disabled === true
  check(L.C2, ro.ok && roDbl === 0 && bulkGone,
  { open: ro.ok, stage: ro.ok ? '' : ro.stage, dblOpen: roDbl, bulkBtn: roBulk, editableClsCells: roEditable })
  covered.push(['只读对照（编辑入口不存在）', ro.ok && roDbl === 0 && bulkGone])
  await cdp.shot(path.join(SHOT_DIR, '1-ro-readonly-grid.png'))
  await closeTab(roId)

  // ---------- 非只读页签：正式编辑 ----------
  const rwId = await openDbTab(cdp, TAB_RW, false)
  openedTabs.push(rwId)
  const rwTree = await waitFor(cdp,
    '!!window.__tree() || !!window.__one(".db-session-error")', 'rw tree or conn error', 60000)
  const rw = rwTree ? await openTable(cdp) : { ok: false, stage: 'no-tree' }
  check(L.E1, rw.ok,
  { open: rw.ok, stage: rw.ok ? '' : rw.stage, grid: rw.ok ? rw.grid : null })
  if (!rw.ok) {
    skipAll('非只读页签没能打开临时表：' + (rw.stage || ''))
    return finish()
  }
  const rwEditable = await cdp.eval('window.__editableCount()')

  // ---- E2：双击 name 单元格 → 改值 → 保存 → DOM + 参照连接双确认 ----
  const nameBefore = await cellOf(cdp, 1, 'name')
  const e2 = await editCell(cdp, 1, 'name', 'edit-a1')
  const e2Db = e2.ok
    ? await pollRef('SELECT name FROM `' + TBL + '` WHERE id = 1', [],
      rows => rows.length === 1 && rows[0].name === 'edit-a1')
    : false
  const e2Dom = e2.ok && e2Db
    ? await pollCell(cdp, 1, 'name', c => c.hash === djb2('edit-a1') && c.len === 7 &&
      !c.nullSpan && !c.emptySpan)
    : null
  check(L.E2, rwEditable > 0 && nameBefore.exists === 1 &&
    nameBefore.hash === djb2('row-name-1') && e2.ok && e2Db && !!e2Dom,
  {
    editableCells: rwEditable,
    before: nameBefore,
    edit: e2.ok ? { prefillHash: e2.ed.hash } : e2.why,
    db: e2Db,
    dom: !!e2Dom
  })
  covered.push(['行内双击编辑 + 保存落库', rwEditable > 0 && e2.ok && e2Db && !!e2Dom])
  if (e2Dom) await cdp.shot(path.join(SHOT_DIR, '2-saved-edit-a1.png'))

  // ---- E6：空串 vs NULL（name 改成空串：落库空串不是 NULL） ----
  const e6 = await editCell(cdp, 2, 'name', '')
  const e6Db = e6.ok
    ? await pollRef('SELECT (name IS NULL) AS isn, LENGTH(name) AS len FROM `' + TBL + '` WHERE id = 2', [],
      rows => rows.length === 1 && rows[0].isn === 0 && rows[0].len === 0)
    : false
  const e6Dom = e6.ok && e6Db
    ? await pollCell(cdp, 2, 'name', c => c.emptySpan && !c.nullSpan)
    : null
  const val3Before = await cellOf(cdp, 3, 'val')
  check(L.E6, e6.ok && e6Db && !!e6Dom && val3Before.exists === 1 && val3Before.nullSpan &&
    !val3Before.emptySpan,
  {
    edit: e6.ok ? '' : e6.why,
    db: e6Db,
    dom: !!e6Dom,
    val3NullPlaceholder: !!(val3Before.exists === 1 && val3Before.nullSpan)
  })
  covered.push(['空串与 NULL 可区分', e6.ok && e6Db && !!e6Dom &&
    !!(val3Before.exists === 1 && val3Before.nullSpan)])

  // ---- E3a：批量改值勾 NULL → 整列落库 NULL（updateCells 通道） ----
  const e3a = await bulkSetValNull(cdp)
  const e3aDb = e3a.ok
    ? await pollRef('SELECT COUNT(*) AS n FROM `' + TBL + '` WHERE val IS NOT NULL', [],
      rows => rows.length === 1 && rows[0].n === 0)
    : false
  let e3aDom = e3a.ok && e3aDb
  for (let i = 1; e3aDom && i <= 5; i++) {
    const c = await pollCell(cdp, i, 'val', cc => cc.nullSpan && !cc.emptySpan, 8000)
    if (!c) e3aDom = false
  }
  if (e3aDom) await cdp.shot(path.join(SHOT_DIR, '3-bulk-null.png'))

  // ---- E3b：NULL 格内联改回数字 → 落库正确 ----
  const e3b = await editCell(cdp, 3, 'val', '77')
  const e3bDb = e3b.ok
    ? await pollRef('SELECT val FROM `' + TBL + '` WHERE id = 3', [],
      rows => rows.length === 1 && rows[0].val === 77)
    : false
  const e3bDom = e3b.ok && e3bDb
    ? await pollCell(cdp, 3, 'val', c => c.hash === djb2('77') && c.len === 2 && !c.nullSpan)
    : null
  check(L.E3, e3a.ok && e3aDb && e3aDom && e3b.ok && e3bDb && !!e3bDom,
  { bulk: e3a.ok ? '' : e3a.why, bulkDb: e3aDb, bulkDom: e3aDom, back: e3b.ok ? '' : e3b.why, backDb: e3bDb, backDom: !!e3bDom })
  covered.push(['批量改值写 NULL', e3a.ok && e3aDb && e3aDom])
  covered.push(['NULL 内联改回数字', e3b.ok && e3bDb && !!e3bDom])

  // ---- E4：Esc 取消 → DOM 与 DB 均不变 ----
  const name4Before = await cellOf(cdp, 4, 'name')
  const e4 = await editCell(cdp, 4, 'name', 'zzz-unsaved-esc', 'esc')
  const name4After = await cellOf(cdp, 4, 'name')
  const e4Db = await refq('SELECT name FROM `' + TBL + '` WHERE id = 4', [])
  const dbStill = e4Db.length === 1 && e4Db[0].name === 'row-name-4'
  check(L.E4, e4.ok && name4Before.exists === 1 && name4After.exists === 1 &&
    name4Before.hash === name4After.hash && dbStill,
  {
    edit: e4.ok ? '' : e4.why,
    domSame: name4Before.hash === name4After.hash,
    db: dbStill
  })
  covered.push(['Esc 取消不改', e4.ok && name4Before.hash === name4After.hash && dbStill])

  // ---- E5：ops 审计 ----
  const audit = await cdp.jeval('window.__audit(' + J(TBL) + ')')
  const e5Ok = audit.writeCount > 0 && audit.violations.length === 0 && audit.tableBad === 0 &&
    audit.names.includes('updateCell') && audit.names.includes('updateCells')
  check(L.E5, e5Ok,
  { writeCount: audit.writeCount, violations: audit.violations, tableBad: audit.tableBad,
    ops: audit.names })
  covered.push(['写命令白名单（仅 updateCell/updateCells 且指向临时表）', e5Ok])

  // ---- T1：双主题（编辑态各截一张，底色必须随主题走） ----
  const t1op = await openEditor(cdp, 5, 'name')
  const dark = await cdp.jeval('window.__colors()')
  await cdp.shot(path.join(SHOT_DIR, '4-editor-dark.png'))
  let light = null
  if (t1op.ok) {
    const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
    const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
    if (lightId) {
      await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
      await sleep(1400)
      light = await cdp.jeval('window.__colors()')
      await cdp.shot(path.join(SHOT_DIR, '5-editor-light.png'))
      await pressKey(cdp, 'Escape', 27)
      await sleep(300)
      await cdp.eval('window.store.setTheme(' + J(cfg0.theme) + ')')
      await sleep(900)
    }
  }
  check(L.T1, !!dark && !!light && dark.bodyBg !== light.bodyBg,
  { dark: dark && dark.bodyBg, light: light && light.bodyBg, darkEditor: dark && dark.edOpen, lightEditor: light && light.edOpen })

  // ---- Z1：收尾还原 + 零残留 ----
  const opsRestored = await cdp.eval('window.__restoreOps()')
  await closeTab(rwId)
  const tabsLeft = JSON.parse(await cdp.eval(
    'JSON.stringify((window.store.tabs || []).filter(t => t.type === "database").length)'))
  await refq('DROP TABLE IF EXISTS `' + TBL + '`')
  const residual = (await refq("SHOW TABLES LIKE '" + TBL + "'")).length
  const themeNow = await cdp.eval('String((window.store._config || {}).theme)')
  check(L.Z1, opsRestored === 'restored' && tabsLeft === 0 && residual === 0 && themeNow === cfg0.theme,
  { opsRestored, tabsLeft, residualTables: residual, themeRestored: themeNow === cfg0.theme })

  // ---- M1：覆盖面汇总 ----
  const covBad = covered.filter(x => !x[1]).map(x => x[0])
  check(L.M1, covBad.length === 0, { covBad, branches: covered.map(x => x[0]) })

  console.log('shots → ' + SHOT_DIR)
  console.log('参照读数: seedRows=' + seedRows + ' seedValNull=' + seedNulls)
  console.log('ops 全集: ' + JSON.stringify(audit.names))
  console.log('隐私纪律: 判据只出计数/长度/布尔/djb2；参照连接所有语句过写闸门（仅临时表），收尾 DROP 后零残留')
  return finish()
}

main().then(async code => {
  await restoreAll()
  if (refConn) {
    try { await refConn.end() } catch (e) { /* 已断开 */ }
  }
  process.exit(code ? 1 : 0)
}).catch(async e => {
  console.log('THROWN: ' + (e && e.stack ? e.stack : e))
  await restoreAll()
  if (refConn) {
    try { await refConn.end() } catch (e2) { /* 已断开 */ }
  }
  process.exit(1)
})
