#!/usr/bin/env node
/**
 * 真机复测（3/3）· 数据库字体效果 —— 打真 MariaDB（TODO-数据库与显示层剩余项 §2-1「字体效果真机复测」）
 *
 * 为什么还要真机跑一遍：`--db-code-font` 这条链此前只有源码契约
 * （`src/test/unit-ci/css-tokens.spec.js`：db-session.jsx 根部有注入、db-session.styl 里
 * 数据面选择器写了 `var(--db-code-font, var(--font-mono))`）。契约钉的是"声明存在"，
 * 钉不住三件事，而这三件在真机上全部翻过车：
 *   1) **声明在 wrapper 上 ≠ 单元格拿到**。antd 在 Table 的 loading 容器 `.ant-spin`
 *      与表根 `.ant-table` 上各自重新声明了界面字体，这两层正好挂在 wrapper 下面 ——
 *      真机实测：表头与单元格 computed 全是界面字体，令牌只停在 wrapper。
 *      只补第一条还会露出第二条（子树里的"字体重置点"是自上而下逐个现形的），
 *      所以两条一起补，见 fix(db) 提交与本轮 F3。
 *   2) **三级回落（tab.fontFamily → config.fontFamily → --font-mono）是不是真按序生效**。
 *      第 3 级尤其容易骗过去：本机 `--font-mono` 与界面字体都是无衬线时，"看起来等宽"
 *      其实根本没回落。本轮把页签与全局两级同时清空，再比对 computed 是否等于
 *      tokens.styl 里那条 `--font-mono` 栈（F8），并要求这条参照栈本身非空（monoReal）。
 *   3) **改动只落在数据面**。内层页签标签、顶栏按钮这些界面文字不该跟着变等宽（F10）；
 *      数据库树节点字体属"待拍板项"（`.db-tree` 未接令牌），本轮把它钉成"保持未接入"，
 *      谁将来手滑接上或改动口径，判据会红（F11）。
 *
 * 判据口径（全部不涉及单元格内容）：
 *   · 页内只回传**字体族名字符串**（本机字体名，与库里数据无关）、计数、颜色值；
 *   · 为了"点得开一张真有行的表"，node 侧另开一条 mysql2 连接读 information_schema
 *     与一次 `SELECT COUNT(*)` 聚合（一个数字）；不读任何单元格；
 *   · 发往真库的 SQL 只有脚本自己写死的那条字面量 `SELECT 1 …`（不含任何表名），
 *     以及元数据/聚合查询；写、DDL、多语句一律被 assertReadOnly 拒发（R2 自证）；
 *   · 目标库名/表名全部由环境变量与 information_schema 现查现用，本文件里没有任何生产对象名
 *     （连"泄露扫描"本身也不写死库名，否则护栏自己就是泄露 —— 见 R1）；
 *   · 截图里会出现生产库表名 → 截图目录已在 .gitignore。
 *
 * 口令只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-font-realdb.js [debugPort] [shotDir]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败）。
 *
 * ⚠️ 不许在这个页面上调 `Page.close`：那是主窗口，关掉 = 整个实例退出，
 *   后面所有判据一起悬着（本脚本前身就是这么把调试端口上的实例弄没的）。收尾只关自己开的页签。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs, ensureRealDbLayer
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-font-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const HELPERS = buildHelpers(SPLIT_KEY)
const TAB_TITLE = 'font realdb'
const { check, skip, results } = makeChecker()
const J = s => JSON.stringify(s)

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}

// 本机确实装了、且彼此可区分的等宽族名：用作"令牌换了 → 界面真的跟着换"的探针值。
// 都是公共字体名，不含任何库侧信息。
const FONT_A = 'Liberation Mono'
const FONT_B = 'Andale Mono'
const FONT_TAB = 'Noto Mono'
// 第 3 级回落的对拍值：tokens.styl 里 --font-mono 的原样栈（改它要同步这条）
const MONO_STACK = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace"

const CDP_URL = 'http://127.0.0.1:' + PORT + '/json/list'

const L = {
  R1: '凭据与隐私纪律自证：口令/生产对象名不进源码，泄露扫描能抓住硬编码形态且不误抓键名',
  R2: '只读闸门自证：元数据/COUNT/字面量 SELECT 全放行，写、DDL、多语句、带分号与标识符注入一律拒发',
  P0: '开跑前桥接原装（无别的脚本留桩）、探针装好、ops 监听挂上',
  C1: '真连接起来：树在场、无连接错误条',
  C2: '页签确实以只读打开（readOnly 为真 → 后面的"零写命令"才有前提）',
  F0: '第 2 级：页签没设字体时，.db-session-wrap 上的 --db-code-font 就是全局 config.fontFamily',
  F1: '令牌是活体注入：改全局 config.fontFamily（不重载页面），wrap 上的令牌值当场跟着换',
  F2: '数据页网格真的吃到令牌：表头、数据格与格内文字都 == 令牌解析值，且 != 界面字体',
  F3: '网格子树没有把字体改回界面字体的"重置点"（antd 的 .ant-spin/.ant-table 已拦住；只允许无字形的勾选框 label 例外）',
  F4: '表结构网格同样吃令牌（与数据页同一个 DbGridTable 组件，分开各验一次）',
  F5: 'SQL 结果网格同样吃令牌（真在编辑器里敲一条不含表名的字面量 SELECT 并执行）',
  F6: '值面板正文（只读 pre / 编辑 textarea）吃令牌，且真有内容可量',
  F7: '第 1 级优先：给当前页签单独设 fontFamily 后，网格换成页签的值（压过全局，全局仍是原值）',
  F8: '第 3 级回落：页签与全局两级都清空 → 网格不是空值、不是界面字体，而是 tokens 里那条 --font-mono 栈',
  F9: '禁连字：.db-session-wrap 与数据面单元格 computed font-variant-ligatures 都是 none',
  F10: '反向护栏：界面文字（内层页签标签、顶栏按钮）不吃令牌 —— 改动只落在数据面',
  F11: '树节点字体保持"未接入"（待拍板项）：整轮换过全局字体，树节点仍是界面字体而不是令牌',
  F12: '主题切换不影响字体：切浅色主题后数据面字体原样不动，而表头配色确实变了（证明主题真换了）',
  O1: '全程 ops 白名单：updateCell / insertRow / deleteRows / applyChanges / getObjectDdl / DDL 零命中',
  O2: '发往真库的 executeSql 只有一条、就是脚本写死的那条字面量 SELECT（语句里没有表名）',
  M1: '覆盖面汇总：三处网格 + 值面板 + 三级回落 + 禁连字 + 反向护栏 + 主题都真量到过（防零样本真空通过）',
  Z1: '收尾还原 ops 监听、全局字体、页签字体、主题与"隐藏系统库"开关（不给下一个脚本留环境差）'
}

// —— 只读闸门（node 侧自己发的那几条）——
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|GRANT|REVOKE|RENAME|CALL|SET|LOCK|UNLOCK|HANDLER|LOAD|OPTIMIZE|ANALYZE)\b/i
const assertReadOnly = sql => {
  const s = String(sql).trim().replace(/;+$/, '')
  if (!/^(select|desc|describe|show)\b/i.test(s)) {
    throw new Error('非 SELECT/DESC/SHOW 起始，拒绝发往真库: ' + s.slice(0, 40))
  }
  if (s.indexOf(';') >= 0) {
    throw new Error('检测到分号（多语句拼接），拒绝发往真库')
  }
  const bad = WRITE_WORDS.exec(s)
  if (bad) throw new Error('语句含写/DDL 关键字 ' + bad[1] + '，拒绝发往真库')
  return s
}

const SQL_TABLES = 'SELECT TABLE_NAME nm FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME'
const SQL_COLUMNS = 'SELECT COLUMN_NAME nm FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION'
// 给 SQL 结果页用的字面量：不含任何表名，纯常量，只为了让结果网格真的有行有列
const UI_SQL = "SELECT 1 AS one_col, 'electerm' AS txt_col"

const identOk = s => /^[A-Za-z0-9_$]+$/.test(String(s))
const sqlCount = (schema, table) => {
  if (!identOk(schema) || !identOk(table)) {
    throw new Error('标识符含白名单外字符，拒绝拼 COUNT 查询')
  }
  return 'SELECT COUNT(*) AS n FROM `' + schema + '`.`' + table + '`'
}

const connect = async () => {
  const mysql = require('mysql2/promise')
  return mysql.createConnection({
    host: ENV.host,
    port: Number(ENV.port),
    user: ENV.user,
    password: ENV.pass || '',
    database: ENV.db
  })
}

const q = async (sql, args) => {
  const c = await connect()
  try {
    const [rows] = await c.query(assertReadOnly(sql), args || [])
    return rows
  } finally {
    await c.end()
  }
}

// 字体族名对拍：computed 值会带引号、空格差异（单双引号都可能），规范化后再比
const normFont = s => String(s || '')
  .replace(/["']/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

// 语句原文对拍是另一回事：字体规范化会把单引号吃掉（'electerm' 变成 electerm），
// 拿它比 SQL 等于"比之前先把两边改写过"。这里只压空白 + 去尾分号（产品执行时会补一个）。
const normSql = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/;+$/, '').toLowerCase()

// —— 页内探针 ——
const PROBE = `(() => {
  window.__vis = el => {
    let e = el
    while (e && e !== document.body) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      e = e.parentElement
    }
    return true
  }
  window.__txt = el => String((el && el.innerText) || '').replace(/\\s+/g, '')
  window.__tok = () => {
    const w = document.querySelector('.db-session-wrap')
    return w ? getComputedStyle(w).getPropertyValue('--db-code-font') : 'no-wrap'
  }
  window.__uiFont = () => getComputedStyle(document.body).fontFamily
  window.__monoToken = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
  window.__cfgFont = () => {
    const c = window.store._config || {}
    return c.fontFamily === undefined ? 'undefined' : String(c.fontFamily)
  }
  // 当前活动页签上的 fontFamily（页签级覆盖用）
  window.__tabFont = () => {
    const t = (window.store.tabs || []).find(x => String(x.id) === String(window.store.activeTabId))
    if (!t) return 'no-tab'
    return t.fontFamily === undefined ? 'undefined' : String(t.fontFamily)
  }
  // 写 undefined 必须传真 undefined：React 对值为 undefined 的自定义属性不落 style，
  // 写成字符串 "undefined" 会让 var(--db-code-font, …) 命中一个不存在的字体族（三级回落断掉）
  window.__setCfgFont = v => {
    if (v === null) { window.store.setConfig({ fontFamily: undefined }); return 'set-undefined' }
    window.store.setConfig({ fontFamily: String(v) })
    return 'set'
  }
  window.__setTabFont = v => {
    const id = String(window.store.activeTabId)
    window.store.updateTab(id, { fontFamily: v === null ? undefined : String(v) })
    return id
  }
  // 可见网格：真库页签下同时存在数据页/表结构/SQL 结果多个 .db-grid-table，
  // 用"有尺寸 + 表头多于 1 列"选，再按调用方给的宿主容器限定
  window.__grid = host => {
    const list = [...document.querySelectorAll('.db-grid-table')].filter(g => {
      const r = g.getBoundingClientRect()
      if (!(r.height > 0 && r.width > 0)) return false
      if (g.querySelectorAll('thead th').length < 2) return false
      return host ? !!g.closest(host) : true
    })
    return list[0] || null
  }
  // 数据格两种形状都要认：主网格是虚拟渲染（行与格都是 div，没有 tbody td），
  // 非虚拟那套（如表结构）仍是真 td。先按 class 含 cell 收，收不到再按行容器取子元素。
  // 行选择勾选框列不算数据格：它没有字形，其 span 用的是界面字体（F3 已允许该例外），
  // 字体取样与点格开面板都不该落在它身上 —— 否则量到的是 checkbox 而不是单元格文字。
  window.__bodyCells = g => {
    const out = []
    ;[...g.querySelectorAll('[class*=cell]')].forEach(e => {
      if (!/ant-table/.test(String(e.className))) return
      if (/ant-table-selection-column/.test(String(e.className))) return
      if (e.closest('thead')) return
      const r = e.getBoundingClientRect()
      if (!(r.height > 0 && r.width > 0)) return
      if (!window.__vis(e)) return
      out.push(e)
    })
    if (out.length) return out
    ;[...g.querySelectorAll('[data-row-key]')].forEach(rowEl => {
      if (!window.__vis(rowEl)) return
      const first = [...rowEl.children].find(c =>
        window.__vis(c) && !/selection/.test(String(c.className)))
      if (first) out.push(first)
    })
    return out
  }
  window.__cellFont = host => {
    const g = window.__grid(host)
    if (!g) return JSON.stringify({ exists: 0 })
    const th = [...g.querySelectorAll('thead th')].filter(window.__vis)[0] || null
    const tds = window.__bodyCells(g)
    const td = tds[0] || null
    // 格内文字节点：取第一个真有字形的 span/div；没有文字的直接用格自身
    const inner = td
      ? ([...td.querySelectorAll('span,div')].find(x => String(x.innerText || '').trim().length > 0) || td)
      : null
    return JSON.stringify({
      exists: 1,
      th: th ? getComputedStyle(th).fontFamily : 'no-th',
      td: td ? getComputedStyle(td).fontFamily : 'no-td',
      inner: inner ? getComputedStyle(inner).fontFamily : 'no-inner',
      tdCount: tds.length,
      // 形状诊断（红的时候一眼看出是"没渲染"还是"选择器没认到"）
      shape: JSON.stringify({
        tag: td ? td.tagName : '',
        cls: td ? String(td.className).slice(0, 40) : '',
        realTbody: g.querySelectorAll('tbody td').length,
        virtualRows: g.querySelectorAll('[data-row-key]').length
      })
    })
  }
  // 子树"字体重置点"：自身 computed 与父不同、且不是网格自己那条 —— 有人中途改回了界面字体
  window.__resetPoints = host => {
    const g = window.__grid(host)
    if (!g) return JSON.stringify({ exists: 0 })
    const want = getComputedStyle(g).fontFamily
    const hits = []
    const walk = e => {
      const cs = getComputedStyle(e)
      const p = e.parentElement
      const pf = p ? getComputedStyle(p).fontFamily : ''
      if (e !== g && cs.fontFamily !== pf && cs.fontFamily !== want) {
        hits.push({
          el: e.tagName + '.' + String(e.className).split(/\\s+/)[0],
          hasGlyph: String(e.innerText || '').trim().length > 0,
          ff: cs.fontFamily.slice(0, 28)
        })
      }
      for (const c of e.children) walk(c)
    }
    walk(g)
    return JSON.stringify({ exists: 1, want, hits: hits.slice(0, 20) })
  }
  window.__lig = host => {
    const w = document.querySelector('.db-session-wrap')
    const out = { wrap: w ? getComputedStyle(w).fontVariantLigatures : 'no-wrap', cell: 'no-cell' }
    const g = window.__grid(host)
    if (g) {
      const tds = window.__bodyCells(g)
      if (tds.length) out.cell = getComputedStyle(tds[0]).fontVariantLigatures
    }
    return JSON.stringify(out)
  }
  // 界面文字取样：内层页签标签 + 顶栏按钮（都不该跟着数据面变等宽）
  window.__uiSample = () => {
    const tab = [...document.querySelectorAll('.db-tabs .ant-tabs-tab-btn')].filter(window.__vis)[0] || null
    const btn = [...document.querySelectorAll('.db-head-right button, .db-head-actions button')]
      .filter(window.__vis)[0] || null
    // 树节点显示文本：antd Tree 的 .ant-tree-title 才是文字，图标字形不算
    const tree = [...document.querySelectorAll('.db-tree .ant-tree-title')]
      .map(e => ({ e, t: window.__txt(e) }))
      .filter(x => x.t.length > 0 && window.__vis(x.e))[0] || null
    return JSON.stringify({
      tab: tab ? getComputedStyle(tab).fontFamily : 'no-tab-btn',
      btn: btn ? getComputedStyle(btn).fontFamily : 'no-btn',
      tree: tree ? getComputedStyle(tree.e).fontFamily : 'no-tree-title',
      treeLen: tree ? tree.t.length : 0
    })
  }
  // 值面板：点格后那块。容器 .db-value-pane 是布局壳（头部标题/字符数/按钮属界面文字，
  // 与 F10 口径一致，不要求令牌）；正文才是数据面 —— 只读走 .db-value-pre，
  // 编辑态走 .db-value-pane-text，两处都有各自的令牌规则，量在场的那个
  window.__valuePane = () => {
    const p = [...document.querySelectorAll('.db-value-pane')].filter(window.__vis)[0] || null
    if (!p) return JSON.stringify({ exists: 0 })
    const pre = [...p.querySelectorAll('.db-value-pane-pre')].filter(window.__vis)[0] || null
    const text = [...p.querySelectorAll('.db-value-pane-text')].filter(window.__vis)[0] || null
    const body = pre || text
    const raw = body ? (body.innerText || body.value || '') : ''
    return JSON.stringify({
      exists: 1,
      pane: getComputedStyle(p).fontFamily,
      body: body ? getComputedStyle(body).fontFamily : 'no-body',
      bodyTag: body ? body.tagName : '',
      bodyLen: String(raw).trim().length
    })
  }
  window.__cellColor = host => {
    const g = window.__grid(host)
    if (!g) return 'no-grid'
    const th = [...g.querySelectorAll('thead th')].filter(window.__vis)[0]
    return th ? getComputedStyle(th).backgroundColor + '/' + getComputedStyle(th).color : 'no-th'
  }
  // 展开某个库节点 + 按整名点叶子（与树复测同一口径：图标字形不算名字的一部分）
  window.__tree = () => [...document.querySelectorAll('.db-tree')].filter(window.__vis)[0] || null
  window.__toggleDb = name => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    for (const el of [...t.querySelectorAll('.db-tree-db-title')].filter(x => window.__vis(x))) {
      if (window.__txt(el) !== String(name)) continue
      const tn = el.closest('.ant-tree-treenode')
      const sw = tn ? tn.querySelector('.ant-tree-switcher') : null
      if (!sw) return 'no-switcher'
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'ok'
    }
    return 'not-found'
  }
  window.__clickLeaf = name => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    for (const w of [...t.querySelectorAll('.ant-tree-node-content-wrapper')].filter(x => window.__vis(x))) {
      if (w.querySelector('.db-tree-db-title') || w.querySelector('.db-tree-schema')) continue
      const ic = w.querySelector('.db-tree-obj-icon')
      const all = window.__txt(w)
      const nm = ic ? all.replace(window.__txt(ic), '') : all
      if (nm !== String(name)) continue
      const r = w.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return 'zero-size'
      w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 4, clientY: r.y + r.height / 2 }))
      return 'ok'
    }
    return 'not-found'
  }
  // 内层页签（数据/表结构/SQL…）：词条可能是中文也可能是英文，给竖线分隔的候选词
  window.__clickInnerTab = alt => {
    const words = String(alt).split('|')
    const tabs = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')].filter(window.__vis)
    for (const w of words) {
      const hit = tabs.find(t => window.__txt(t).toLowerCase().indexOf(w.toLowerCase()) >= 0)
      if (hit) {
        hit.click()
        return 'ok'
      }
    }
    return 'no-tab:' + alt + '/have=' + JSON.stringify(tabs.map(t => window.__txt(t)).slice(0, 8))
  }
  // 点第一个数据格：值面板才有内容可测。优先点有字形的格（空格可能不触发面板）
  window.__clickFirstCell = host => {
    const g = window.__grid(host)
    if (!g) return 'no-grid'
    const tds = window.__bodyCells(g)
    if (!tds.length) return 'no-cell'
    const pick = tds.find(t => String(t.innerText || '').trim().length > 0) || tds[0]
    const r = pick.getBoundingClientRect()
    pick.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 6, clientY: r.y + r.height / 2 }))
    return 'ok'
  }
  // ops 监听：记录 dbClientOp 的 op 名；executeSql 额外记下语句原文
  // （原文只有本脚本自己写死的那条字面量，不含任何库侧对象名）
  window.__ops = []
  window.__sqls = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    const wrapped = function (name) {
      if (name === 'dbClientOp') {
        const op = String(arguments[2])
        window.__ops.push(op)
        if (op === 'executeSql') {
          // runGlobalAsync('dbClientOp', tabId, op, payload)：payload 是第 4 个实参
          const payload = arguments[3]
          if (payload && typeof payload.sql === 'string') window.__sqls.push(payload.sql)
        }
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
  window.__alerts = () => JSON.stringify({
    connErr: [...document.querySelectorAll('.db-session-error')].filter(window.__vis)
      .map(x => window.__txt(x)).slice(0, 1)
  })
})()`
// SQL 编辑器：真鼠标点进去 + Ctrl+A + Input.insertText（CodeMirror 6 只认这条路径）
const setSql = async (cdp, sql) => {
  let focused = await cdp.eval('window.__focusSql()')
  for (let i = 0; i < 6 && focused !== 'focused'; i++) {
    await sleep(300)
    const xy = await cdp.jeval(`(() => {
      const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
      if (!ed) return JSON.stringify({ error: 'no-editor' })
      const r = ed.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 20) })
    })()`)
    if (!xy.error) {
      await cdp.click(xy.x, xy.y)
      await sleep(200)
    }
    focused = await cdp.eval('window.__focusSql()')
  }
  if (focused !== 'focused') return { ok: false, why: focused }
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
  await cdp.call('Input.insertText', { text: sql })
  await sleep(200)
  // 自动补全下拉收掉，否则截图里像"另一个控件"
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await sleep(150)
  const doc = String(await cdp.eval('window.__sqlDoc()'))
  return { ok: normSql(doc).indexOf(normSql(sql).slice(0, 20)) >= 0, doc: doc.slice(0, 60) }
}

const cfg0 = { theme: undefined, font: undefined, hideSys: undefined }
const openedTabs = []
let cdpRef = null
let restored = false

// undefined 既不能 JSON.stringify（会变 "null"）也不能 String()（会变 "undefined" 字符串）：
// 还原配置时这两种写法都会把用户原值改坏
const ser = v => v === undefined ? 'undefined' : JSON.stringify(v)

const restoreAll = async () => {
  if (restored || !cdpRef) return
  restored = true
  try {
    await cdpRef.eval('window.__restoreOps()')
    await cdpRef.eval('window.store.setConfig({fontFamily:' + ser(cfg0.font) + ',theme:' + ser(cfg0.theme) +
      ',dbHideSystemSchemas:' + ser(cfg0.hideSys) + '})')
    for (const id of openedTabs) {
      await cdpRef.eval('(async () => { await window.store.delTab(' + J(id) + ') })()')
    }
  } catch (e) {
    console.log('restore warn: ' + e.message)
  }
}

const finish = () => {
  const red = results.filter(r => !r.ok && !r.skipped)
  const skipped = results.filter(r => r.skipped)
  const run = results.length - skipped.length
  console.log('\n判据 ' + run + ' 条：绿 ' + (run - red.length) + ' / 红 ' + red.length +
    (skipped.length ? ' / SKIP ' + skipped.length : ''))
  red.forEach(r => console.log('  ✗ ' + r.name + '\n    ' + JSON.stringify(r.detail)))
  return red.length
}

const skipAll = reason => {
  Object.keys(L).forEach(k => {
    if (!results.some(r => r.name === L[k])) skip(L[k], reason)
  })
}

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  if (!ENV.host || !ENV.user || !ENV.db) {
    console.log('没有 RDB_MYSQL_* 环境变量 → 真库批次整体 SKIP')
    skipAll('缺凭据')
    return finish()
  }

  // ---------- 闸门与隐私纪律自证（不打库）----------
  const src = fs.readFileSync(__filename, 'utf8')
  const allow = [
    SQL_TABLES.replace('?', 's'),
    SQL_COLUMNS.replace('?', 's').replace('?', 't'),
    'SHOW TABLES',
    sqlCount('s', 't'),
    UI_SQL,
    'SELECT TABLE_NAME FROM information_schema.TABLES LIMIT 3'
  ].filter(s => {
    try { assertReadOnly(s); return true } catch (e) { return false }
  })
  const deny = [
    'UPDATE t SET a = 1',
    'DROP TABLE t',
    'select 1; DELETE FROM t',
    'INSERT INTO t VALUES (1)',
    'CREATE INDEX i ON t (a)'
  ].filter(s => {
    try { assertReadOnly(s); return false } catch (e) { return true }
  })
  let evilCaught = 0
  for (const evil of ['t`; DROP TABLE x --', 't` OR 1=1', 'a b']) {
    try { sqlCount('s', evil) } catch (e) { evilCaught++ }
  }
  check(L.R2, allow.length === 6 && deny.length === 5 && evilCaught === 3,
    { allow: allow.length, deny: deny.length, evilCaught })

  // 泄露扫描不能写死生产对象名（那它自己就是泄露），判定条件全部由环境值现拼。
  // "值恰好等于某个键名"的写法要放过：作为独立 token 出现、后面不紧接冒号才算泄露。
  const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const findSecret = (text, v) => {
    if (!v) return false
    return new RegExp('(?:^|[^A-Za-z0-9_])' + escRe(v) + '(?![A-Za-z0-9_:])').test(String(text))
  }
  const passLeak = findSecret(src, ENV.pass)
  const dbLeak = findSecret(src, ENV.db)
  // 这台库业务表名都带 `<库名>_` 前缀 → 源码里出现"前缀_名字"就是泄露
  const businessName = new RegExp(escRe(ENV.db) + '_[a-z0-9_]+', 'i').test(src)
  // 自证：这套扫描抓得住三种硬编码形态，且不误抓"键名用法"
  const leakForms = ['  pass: ' + J(ENV.pass) + ',', 'RDB_MYSQL_PASS=' + ENV.pass, 'db: ' + J(ENV.db)]
  const caught = leakForms.filter(s => findSecret(s, ENV.pass) || findSecret(s, ENV.db)).length
  const keyNameOk = findSecret('pass: ENV.pass || \'\',', ENV.pass)
  check(L.R1, !passLeak && !dbLeak && !businessName &&
    caught === leakForms.length && keyNameOk === false,
  { passLeak, dbLeak, businessName, caught, wantCaught: leakForms.length, keyNameOk })
  if (passLeak || dbLeak || businessName) {
    skipAll('本文件含生产对象名/口令，先清理再跑')
    return finish()
  }

  // ---------- 参照：挑一张"真有行、真有列"的表 ----------
  let targetTable = null
  let targetRows = 0
  try {
    const tables = await q(SQL_TABLES, [ENV.db])
    for (const t of tables.slice(0, 40)) {
      const nm = String(t.nm)
      if (!identOk(nm)) continue
      const cols = await q(SQL_COLUMNS, [ENV.db, nm])
      if (!cols.length) continue
      const cnt = await q(sqlCount(ENV.db, nm))
      const n = Number((cnt[0] || {}).n)
      if (n > 0) {
        targetTable = nm
        targetRows = n
        break
      }
    }
  } catch (e) {
    console.log('参照读取失败：' + String(e.message).slice(0, 120))
  }
  if (!targetTable) {
    check(L.C1, false, { reason: '参照没找到有行有列的表（真库不可达或库为空）' })
    skipAll('真库参照不可用')
    return finish()
  }
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
  // 同实例可能跑过假库演示（整个换掉 runGlobalAsync 且没有还原）→ 先重载再开真库页签
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  const booted = await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000)
  if (!booted) {
    check(L.P0, false, { booted })
    skipAll('渲染进程没起来')
    return finish()
  }
  await cdp.eval(HELPERS)
  await cdp.eval(PROBE)
  // 桥接原装自证（检测到桩会自己再重载一次并等到干净）
  const layer = await ensureRealDbLayer(cdp)
  if (layer.reloaded) {
    // 重载把执行上下文换掉了：助手与探针要重装，否则后面每条判据都读不到 window.__*
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot after layer reload', 40000)
    await cdp.eval(HELPERS)
    await cdp.eval(PROBE)
  }
  const spy = await cdp.eval('window.__spyOps()')
  const probeOk = String(await cdp.eval(
    'JSON.stringify(["__tok","__cellFont","__resetPoints","__uiSample","__valuePane","__setCfgFont","__setTabFont","__clickLeaf","__clickInnerTab","__spyOps"].map(n => typeof window[n]).join(","))'))
  const wantFns = J(Array(10).fill('function').join(','))
  check(L.P0, layer.state === 'ok' && spy === 'ok' && probeOk === wantFns,
    { was: layer.was, state: layer.state, reloaded: layer.reloaded, spy, probeOk })

  // 原值按"值"取，不能 String()：fontFamily 本机可能就是 undefined
  cfg0.theme = await cdp.eval('(() => { const c = window.store._config || {}; return c.theme })()')
  cfg0.font = await cdp.eval('(() => { const c = window.store._config || {}; return c.fontFamily })()')
  cfg0.hideSys = await cdp.eval('(() => { const c = window.store._config || {}; return c.dbHideSystemSchemas })()')
  // 字体链与"隐藏系统库"无关，但叶子规模影响树里可点性；钉住默认口径，收尾还原
  await cdp.eval('window.store.setConfig({dbHideSystemSchemas:false})')
  await sleep(300)
  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))

  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(TAB_TITLE)},
      dbType: 'mysql', dbHost: ${J(ENV.host)}, dbPort: Number(${J(ENV.port)}),
      dbUser: ${J(ENV.user)}, dbPassword: ${J(ENV.pass)},
      dbName: ${J(ENV.db)}, dbSsl: false,
      readOnly: true, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  openedTabs.push(String(await cdp.eval('String(window.store.activeTabId)')))
  const treeShown = await waitFor(cdp,
    '!!window.__one(".db-tree") || !!window.__one(".db-session-error")', 'tree or conn error', 60000)
  const al = await cdp.jeval('window.__alerts()')
  check(L.C1, !!treeShown && !(al.connErr || []).length, { treeShown, err: (al.connErr || [])[0] || '' })
  if (!treeShown || (al.connErr || []).length) {
    skipAll('真库连接没起来')
    return finish()
  }
  const roTab = await cdp.eval(
    '(() => { const t = (window.store.tabs || []).find(x => String(x.title) === ' + J(TAB_TITLE) +
    '); return t && t.readOnly === true ? 1 : 0 })()')
  check(L.C2, Number(roTab) === 1, { roTab: Number(roTab) })

  // 基准字体钉成已知值：判据要的是"令牌跟着配置走"，所以先显式置 FONT_A 再往下测
  const uiFont0 = normFont(await cdp.eval('window.__uiFont()'))
  const mono0 = normFont(await cdp.eval('window.__monoToken()'))
  // 第 3 级的参照不能是空串：空串会让 fbNorm === mono0 恒真（回落根本没生效也绿）
  const monoReal = mono0 !== '' && mono0 === normFont(MONO_STACK)
  await cdp.eval('window.__setCfgFont(' + J(FONT_A) + ')')
  await sleep(700)
  const tokA = normFont(await cdp.eval('window.__tok()'))
  const tabFontBefore = await cdp.eval('window.__tabFont()')
  check(L.F0, tokA === normFont(FONT_A) && tabFontBefore === 'undefined',
    { tokA, want: normFont(FONT_A), tabFont: tabFontBefore })

  // 换一次值，令牌必须当场跟着变（不是只有重建页签才生效）
  await cdp.eval('window.__setCfgFont(' + J(FONT_B) + ')')
  await sleep(700)
  const tokB = normFont(await cdp.eval('window.__tok()'))
  await cdp.eval('window.__setCfgFont(' + J(FONT_A) + ')')
  await sleep(700)
  const tokBack = normFont(await cdp.eval('window.__tok()'))
  check(L.F1, tokB === normFont(FONT_B) && tokBack === normFont(FONT_A) && tokA !== tokB,
    { tokA, tokB, tokBack })

  // ---------- 点开一张有行的表 ----------
  const tg = await cdp.eval('window.__toggleDb(' + J(ENV.db) + ')')
  await sleep(1500)
  const click = await cdp.eval('window.__clickLeaf(' + J(targetTable) + ')')
  let cell = { exists: 0 }
  for (let i = 0; i < 30; i++) {
    await sleep(700)
    cell = await cdp.jeval('window.__cellFont(".db-grid-area")')
    if (cell.exists === 1 && String(cell.td).indexOf('no-') < 0 && cell.tdCount > 0) break
  }
  const tokNow = normFont(await cdp.eval('window.__tok()'))
  check(L.F2, tg === 'ok' && click === 'ok' && cell.exists === 1 &&
    normFont(cell.th) === tokNow && normFont(cell.td) === tokNow &&
    normFont(cell.inner) === tokNow && normFont(cell.td) !== uiFont0,
  { tg, click, tokNow, cell, uiFont0: uiFont0.slice(0, 24), refRows: targetRows })

  const rp = await cdp.jeval('window.__resetPoints(".db-grid-area")')
  const badReset = (rp.hits || []).filter(h => h.hasGlyph)
  check(L.F3, rp.exists === 1 && badReset.length === 0,
    { want: String(rp.want).slice(0, 24), hits: rp.hits })

  // ---------- 表结构 ----------
  const stTab = await cdp.eval('window.__clickInnerTab("表结构|structure")')
  let stCell = { exists: 0 }
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    stCell = await cdp.jeval('window.__cellFont(".db-struct-area")')
    if (stCell.exists === 1 && String(stCell.td).indexOf('no-') < 0) break
  }
  check(L.F4, stTab === 'ok' && stCell.exists === 1 &&
    normFont(stCell.th) === tokNow && normFont(stCell.td) === tokNow &&
    normFont(stCell.td) !== uiFont0,
  { stTab, stCell, tokNow })
  await cdp.shot(path.join(SHOT_DIR, '1-structure-font.png'))

  // ---------- SQL 结果 ----------
  const sqlTab = await cdp.eval('window.__clickInnerTab("SQL")')
  await sleep(1500)
  const typed = await setSql(cdp, UI_SQL)
  const opsBeforeRun = Number(await cdp.eval('(window.__ops || []).length'))
  const runBtn = await cdp.eval('window.__clickRunSql()')
  let sqlCell = { exists: 0 }
  for (let i = 0; i < 24; i++) {
    await sleep(700)
    sqlCell = await cdp.jeval('window.__cellFont(".db-sql-result")')
    if (sqlCell.exists === 1 && String(sqlCell.td).indexOf('no-') < 0) break
  }
  check(L.F5, sqlTab === 'ok' && typed.ok && runBtn === 'ok' && sqlCell.exists === 1 &&
    normFont(sqlCell.th) === tokNow && normFont(sqlCell.td) === tokNow &&
    normFont(sqlCell.td) !== uiFont0,
  { sqlTab, typed, runBtn, sqlCell, tokNow })
  await cdp.shot(path.join(SHOT_DIR, '2-sql-result-font.png'))

  // ---------- 值面板 ----------
  const dataTab = await cdp.eval('window.__clickInnerTab("数据|data")')
  await sleep(1500)
  const cc = await cdp.eval('window.__clickFirstCell(".db-grid-area")')
  await sleep(1000)
  const vp = await cdp.jeval('window.__valuePane()')
  check(L.F6, dataTab === 'ok' && cc === 'ok' && vp.exists === 1 &&
    vp.body !== 'no-body' && vp.bodyLen > 0 && normFont(vp.body) === tokNow,
  { dataTab, cc, vp, tokNow })
  // ---------- 三级回落 ----------
  await cdp.eval('window.__setTabFont(' + J(FONT_TAB) + ')')
  let tabTok = ''
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    tabTok = normFont(await cdp.eval('window.__tok()'))
    if (tabTok === normFont(FONT_TAB)) break
  }
  const tabCell = await cdp.jeval('window.__cellFont(".db-grid-area")')
  const cfgStill = normFont(await cdp.eval('window.__cfgFont()'))
  check(L.F7, tabTok === normFont(FONT_TAB) && normFont(tabCell.td) === normFont(FONT_TAB) &&
    cfgStill === normFont(FONT_A),
  { tabTok, want: normFont(FONT_TAB), td: String(tabCell.td).slice(0, 30), cfgStill })

  await cdp.eval('window.__setTabFont(null)')
  await cdp.eval('window.__setCfgFont(null)')
  let fbTok = 'x'
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    fbTok = String(await cdp.eval('window.__tok()')).trim()
    if (fbTok === '') break
  }
  const fbCell = await cdp.jeval('window.__cellFont(".db-grid-area")')
  const fbNorm = normFont(fbCell.td)
  check(L.F8, fbTok === '' && monoReal && fbNorm === mono0 && fbNorm !== uiFont0 && fbNorm !== '',
    { fbTok, td: String(fbCell.td).slice(0, 46), mono0: mono0.slice(0, 46), uiFont0: uiFont0.slice(0, 30), monoReal })

  // 后面还要用已知值，先恢复全局
  await cdp.eval('window.__setCfgFont(' + J(FONT_A) + ')')
  await sleep(700)

  // ---------- 禁连字 ----------
  const lig = await cdp.jeval('window.__lig(".db-grid-area")')
  check(L.F9, lig.wrap === 'none' && lig.cell === 'none', { lig })

  // ---------- 界面文字不吃令牌 ----------
  const uiS = await cdp.jeval('window.__uiSample()')
  const tokLive = normFont(await cdp.eval('window.__tok()'))
  check(L.F10, tokLive === normFont(FONT_A) &&
    normFont(uiS.tab) !== tokLive && normFont(uiS.btn) !== tokLive,
  { tokLive, tab: String(uiS.tab).slice(0, 26), btn: String(uiS.btn).slice(0, 26) })

  // 树节点：待拍板项，本轮钉住"仍然未接入"
  const treeBefore = normFont(uiS.tree)
  await cdp.eval('window.__setCfgFont(' + J(FONT_B) + ')')
  await sleep(800)
  const uiS2 = await cdp.jeval('window.__uiSample()')
  const tokB2 = normFont(await cdp.eval('window.__tok()'))
  await cdp.eval('window.__setCfgFont(' + J(FONT_A) + ')')
  await sleep(800)
  const tokA2 = normFont(await cdp.eval('window.__tok()'))
  check(L.F11, treeBefore !== '' && treeBefore.indexOf('no-tree') < 0 &&
    tokB2 === normFont(FONT_B) && tokA2 === normFont(FONT_A) &&
    normFont(uiS2.tree) === treeBefore &&
    treeBefore !== tokB2 && treeBefore !== normFont(FONT_A),
  { treeBefore: treeBefore.slice(0, 26), treeAfter: String(uiS2.tree).slice(0, 26), tokB2, tokA2, treeLen: uiS.treeLen })

  // ---------- 主题切换不动字体 ----------
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) ||
    themeIds.find(id => String(id) !== String(cfg0.theme))
  const colorDark = await cdp.eval('window.__cellColor(".db-grid-area")')
  const fontDark = await cdp.jeval('window.__cellFont(".db-grid-area")')
  let themeSwitched = false
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1600)
    const colorLight = await cdp.eval('window.__cellColor(".db-grid-area")')
    const fontLight = await cdp.jeval('window.__cellFont(".db-grid-area")')
    themeSwitched = String(colorLight) !== String(colorDark)
    await cdp.shot(path.join(SHOT_DIR, '3-theme-light.png'))
    await cdp.eval('window.store.setTheme(' + ser(cfg0.theme) + ')')
    await sleep(1300)
    check(L.F12, themeSwitched &&
      normFont(fontLight.td) === normFont(fontDark.td) &&
      normFont(fontLight.th) === normFont(fontDark.th) &&
      normFont(fontLight.td) === normFont(await cdp.eval('window.__tok()')),
    {
      fontDark: String(fontDark.td).slice(0, 22),
      fontLight: String(fontLight.td).slice(0, 22),
      colorDark: String(colorDark).slice(0, 32),
      colorLight: String(colorLight).slice(0, 32)
    })
  } else {
    check(L.F12, false, { themeIds: themeIds.slice(0, 6), current: cfg0.theme })
  }

  // ---------- ops 口径 ----------
  const opsAll = await cdp.jeval('JSON.stringify(window.__ops || [])')
  const badAll = [...new Set(opsAll)].filter(o =>
    /updateCell|insertRow|deleteRows|applyChanges|getObjectDdl|dropTable|createIndex|alterTable/i.test(o))
  check(L.O1, badAll.length === 0, { badAll, ops: [...new Set(opsAll)] })
  const sqls = await cdp.jeval('JSON.stringify(window.__sqls || [])')
  const opsRun = opsAll.slice(opsBeforeRun)
  check(L.O2, sqls.length === 1 && normSql(sqls[0]) === normSql(UI_SQL) &&
    opsRun.filter(o => o === 'executeSql').length === 1 &&
    !/information_schema|\bfrom\b/i.test(sqls[0]),
  { sqlCountSent: sqls.length, executeSqlCount: opsRun.filter(o => o === 'executeSql').length })

  // ---------- 覆盖面汇总（防"某处网格其实没量到"真空通过）----------
  const cov = {
    dataGrid: cell.exists === 1 && cell.tdCount > 0,
    structGrid: stCell.exists === 1 && stCell.tdCount > 0,
    sqlGrid: sqlCell.exists === 1 && sqlCell.tdCount > 0,
    valuePane: vp.exists === 1 && vp.body !== 'no-body' && vp.bodyLen > 0,
    fallback3: monoReal && fbNorm === mono0 && fbTok === '',
    tabOverride: tabTok === normFont(FONT_TAB),
    ligature: lig.wrap === 'none' && lig.cell === 'none',
    uiGuard: normFont(uiS.tab) !== tokLive,
    treePinned: treeBefore.indexOf('no-tree') < 0,
    theme: themeSwitched
  }
  const missing = Object.keys(cov).filter(k => !cov[k])
  check(L.M1, missing.length === 0, { missing })

  await cdp.shot(path.join(SHOT_DIR, '4-final-dark.png'))

  // ---------- 收尾还原（配置与主题；页签由 restoreAll 关）----------
  await cdp.eval('window.store.setConfig({fontFamily:' + ser(cfg0.font) + ',dbHideSystemSchemas:' +
    ser(cfg0.hideSys) + '})')
  await sleep(700)
  const endFont = await cdp.eval('(() => { const c = window.store._config || {}; return c.fontFamily })()')
  const endTabFont = await cdp.eval('window.__tabFont()')
  const endTheme = await cdp.eval('(() => { const c = window.store._config || {}; return c.theme })()')
  const endHide = await cdp.eval('(() => { const c = window.store._config || {}; return c.dbHideSystemSchemas })()')
  const opsRestored = await cdp.eval('window.__restoreOps()')
  check(L.Z1, opsRestored === 'restored' && String(endFont) === String(cfg0.font) &&
    endTabFont === 'undefined' && String(endTheme) === String(cfg0.theme) &&
    String(endHide) === String(cfg0.hideSys),
  { opsRestored, endFont: String(endFont).slice(0, 24), want: String(cfg0.font).slice(0, 24), endTabFont, endTheme, endHide, wantHide: cfg0.hideSys })

  console.log('shots → ' + SHOT_DIR)
  console.log('隐私纪律: 页内只回传字体族名/计数/颜色；除一次 COUNT(*) 聚合与一条不含表名的字面量 SELECT 外，零行数据读取')
  console.log('参照: 目标表行数(COUNT聚合)=' + targetRows + ' 界面字体=' + uiFont0.slice(0, 22) +
    ' --font-mono=' + mono0.slice(0, 22))
  return finish()
}

main().then(async code => {
  await restoreAll()
  process.exit(code ? 1 : 0)
}).catch(async e => {
  console.log('THROWN: ' + (e && e.stack ? e.stack : e))
  await restoreAll()
  process.exit(1)
})
