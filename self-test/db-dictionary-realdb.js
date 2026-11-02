#!/usr/bin/env node
/**
 * H3a · 数据字典导出（Markdown / CSV）—— 真库 CDP 验收（MariaDB，只读）
 *
 * 假表那 8 条钉的是"分支与格式"，钉不住只有真服务器能回答的四类事：
 *   1) **两条通道给不给同一份事实**：结构页走 `DESC 表`，字典走
 *      `getTableStructure` 的 information_schema 四条查询。桩里两边都是手写的，
 *      永远"一致"；真库才看得出这两条通道在"无默认值"上形状就不同
 *      （MariaDB：DESC 一律给 SQL NULL，information_schema 把 DEFAULT NULL 给成
 *      字符串 'NULL' —— 见判据 9 与设计 §6.4 的核验记录）。
 *   2) **真注释里的特殊字符**：这台库的列注释带英文逗号、带英文双引号 ——
 *      CSV 会不会因此把一行撑成两列（转义失手是静默的，导进表格软件才看得出来）。
 *   3) **复合索引的列顺序**：STATISTICS 一列一行，SEQ_IN_INDEX 的顺序经
 *      聚合 → 契约 → 导出后还是不是那个顺序（顺序错 = 字典里写着一条不存在的索引）。
 *   4) **保留字列名 / 空表注释 / 空表估算行数 0**：真库给形状，桩给不了。
 *
 * 参照系不是产品实现的拷贝：node 侧另开一条 mysql2 连接直查
 * information_schema 与 DESC，逐格与导出文本比；本脚本**不 require**
 * `src/client/common/db-dictionary.js`，否则"一致"是同义反复。
 *
 * 隐私纪律（这是生产库，不是玩具）：
 *   · 一条行数据都不读：node 侧只允许 SELECT information_schema + DESC 表；
 *   · 页签以 readOnly: true 打开，渲染层 ops 全程监听，写操作与 executeSql
 *     一次都不该出现；
 *   · 判据输出只有计数、长度、布尔与 djb2 哈希：列注释是有业务含义的元数据，
 *     正文既不落终端也不写进文档。
 *
 * 凭据只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-dictionary-realdb.js [debugPort] [shotDir]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败），并逐条打出来。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-dictionary-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check, skip } = makeChecker()

const ENV = {
  host: process.env.RDB_MYSQL_HOST,
  port: process.env.RDB_MYSQL_PORT,
  user: process.env.RDB_MYSQL_USER,
  pass: process.env.RDB_MYSQL_PASS,
  db: process.env.RDB_MYSQL_DB
}

// 三张真表各钉一件事（选表是按 information_schema 实况挑的，不是猜的）：
//   tgfsom_disk —— 25 列全部带注释、其中 7 条注释里有英文逗号、有一条两列复合唯一索引、
//                  还有一列的名字是 SQL 保留字（结构页与字典都得原样带出这个名字），
//                  列数 25 > 屏内 22 行 → 逼出虚拟表体的滚动累积；
//   tgfsom_hsm_copytool —— 注释里带英文双引号（CSV 要写成 ""），且是空表
//                  （估算行数 0 是"真空表"不是"未知"，导出不能把它当成缺字段）；
//   tgfsom_task —— 索引既有唯一也有非唯一（前两张表全是最优/唯一索引，「唯一」这一列
//                  一直只钉过 true 的一半），25 列同样跨屏。
// 特殊字符的覆盖面不靠单表运气：逗号/双引号在前两张，非唯一索引在第三张，
// 由全局 K1 汇总"这一轮总共真跑过几种形状"。
const TABLES = ['tgfsom_disk', 'tgfsom_hsm_copytool', 'tgfsom_task']

const TPL = [
  ['1', '结构页在真库上出列清单（行数 == catalog 列数）'],
  ['2', '这张表确实带非空列注释（不是"全空所以导出全空也能过"）'],
  ['3', '导出菜单恰好两种格式，两份文件都下发、文件名带库表+时间戳'],
  ['4', '表信息节与 TABLES 一致（限定名 / 类型 / 表注释 / 估算行数 / 导出时间）'],
  ['5', '列节序号 1..n 连续且数据行数 == catalog 列数'],
  ['6', '列名逐位与 catalog 一致（含保留字列名原样带出）'],
  ['7', '类型格子取 COLUMN_TYPE：真长度/unsigned 在文本里'],
  ['8', '可空/主键两格与 IS_NULLABLE / COLUMN_KEY 一致'],
  ['9', '默认值各忠实自己那条通道（字典=information_schema，结构页=DESC）'],
  ['10', '注释非空的行导出非空且等长、注释为空的行留空（不编造「—」）'],
  ['11', '索引节 == STATISTICS 聚合（数量 / 唯一 / 主键 / 方法）'],
  ['12', '复合索引列顺序按 SEQ_IN_INDEX 原样（不是重排出来的）'],
  ['13', '外键节与 catalog 同源（真库该表 0 外键 → 节在、只剩表头）'],
  ['14', 'Markdown 每行恰好 7 格：真值里的竖线/反斜杠没撑破表格'],
  ['15', 'CSV 是字节级 BOM + CRLF，四节标题与列头齐全'],
  ['16', 'CSV 每行 7 字段；含逗号/双引号的真注释解回原值且带引号'],
  ['17', '两种格式逐格同源（MD 解转义 == CSV 解引号，四节都对得上）'],
  ['18', '导出全文不含 DDL/DML（字典只有元数据，不是建表脚本）']
]
const L = {}
const label = (t, k) => t + '#' + k
for (const t of TABLES) {
  for (const [k, d] of TPL) {
    L[label(t, k)] = t + ' · ' + d
  }
}
const G = {
  R1: '凭据全部来自环境变量、脚本正文不含口令',
  R2: 'node 侧只读护栏：5 条写语句全拒、4 条元数据读语句放行',
  A0: '真库验收开跑前现场干净（无假 adapter 桩、探针装上了）',
  A1: '渲染进程可用（window.store / pre / translate）',
  A2: '只读页签建连成功（树里出现库名、无连接错误页）',
  P1: 'catalog 可达：每张样本表都有列与非空注释',
  H1: '字典路径不发 SQL：ops 里没有 executeSql，也没有任何写操作',
  H2: '页签确实是只读连接（readOnly 为真 → 只读连接下导出可用）',
  I1: '两种格式文件名同前缀（只差扩展名），深色菜单截图留证',
  I2: '浅色主题下工具行换色（同一处控件不是写死颜色）',
  K1: '覆盖面汇总：这一轮真跑过逗号注释 / 双引号注释 / 唯一+非唯一索引 / 跨屏列数'
}
for (const k of Object.keys(G)) {
  L[k] = G[k]
}

// —— 只读护栏 ——
// 允许形态只有两种：SELECT（information_schema / 参照计数）与 DESC（结构页那条通道）。
// SHOW / USE 一律拒，写关键字与分号拼接一律拒 —— 生产库上没有"应该没事"。
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|rename|call|execute|set|lock|unlock|load|kill|shutdown|handler|commit|rollback|savepoint|prepare|deallocate)\b/i
const assertReadOnly = sql => {
  const s = String(sql).trim().replace(/;+$/, '')
  if (!/^(select|desc|describe)\b/i.test(s)) {
    throw new Error('非 SELECT/DESC 起始，拒绝发往真库: ' + s.slice(0, 40))
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

// 与页面 window.__hash 同一套 djb2（有符号 int32）：跨进程只比哈希，正文不外传
const djb2 = s => {
  let h = 5381
  const t = String(s === null || s === undefined ? '' : s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return h
}

// —— catalog 参照（node 直连；字段名是 information_schema 的，不是产品的契约）——
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

const COLS_SQL = 'SELECT ORDINAL_POSITION op, COLUMN_NAME nm, DATA_TYPE dt, COLUMN_TYPE ct,' +
  ' IS_NULLABLE nu, COLUMN_KEY ky, COLUMN_DEFAULT df, COLUMN_COMMENT cm' +
  ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?' +
  ' ORDER BY ORDINAL_POSITION'
const TAB_SQL = 'SELECT TABLE_TYPE ty, TABLE_COMMENT cm, TABLE_ROWS rws' +
  ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?'
const IDX_SQL = 'SELECT INDEX_NAME nm, NON_UNIQUE nu, SEQ_IN_INDEX sq, COLUMN_NAME cn, INDEX_TYPE it' +
  ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?' +
  ' ORDER BY INDEX_NAME, SEQ_IN_INDEX'
const FK_SQL = 'SELECT DISTINCT CONSTRAINT_NAME nm FROM information_schema.KEY_COLUMN_USAGE' +
  ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL'

const catalogOf = async table => {
  const [cols, tabs, idx, fk] = await Promise.all([
    q(COLS_SQL, [ENV.db, table]),
    q(TAB_SQL, [ENV.db, table]),
    q(IDX_SQL, [ENV.db, table]),
    q(FK_SQL, [ENV.db, table])
  ])
  const t = tabs[0] || {}
  const map = new Map()
  for (const r of idx) {
    if (!map.has(r.nm)) {
      map.set(r.nm, { name: r.nm, unique: Number(r.nu) === 0, primary: r.nm === 'PRIMARY', method: String(r.it || ''), rows: [] })
    }
    map.get(r.nm).rows.push({ sq: Number(r.sq) || 0, cn: r.cn })
  }
  return {
    table,
    cols: cols.map(c => ({
      name: String(c.nm),
      columnType: String(c.ct || ''),
      nullable: String(c.nu).toUpperCase() === 'YES',
      pk: String(c.ky || '').toUpperCase() === 'PRI',
      comment: c.cm === null || c.cm === undefined ? '' : String(c.cm),
      // IS 的 COLUMN_DEFAULT：真 NULL = 没默认；MariaDB 把 DEFAULT NULL 给成字符串 'NULL'
      isNoDefault: c.df === null || c.df === undefined,
      defaultText: c.df === null || c.df === undefined ? '' : String(c.df)
    })),
    indexes: [...map.values()].map(ix => ({
      name: ix.name,
      unique: ix.unique,
      primary: ix.primary,
      method: ix.method,
      cols: ix.rows.sort((a, b) => a.sq - b.sq).map(x => String(x.cn))
    })),
    fk: fk.length,
    tableComment: t.cm === null || t.cm === undefined ? '' : String(t.cm),
    estimatedRows: t.rws === null || t.rws === undefined ? null : Number(t.rws),
    isView: String(t.ty || '') === 'VIEW'
  }
}

// 结构页那条通道（DESC）：本脚本自己发，只取显示形态用于对账
const descOf = async table => {
  const safe = String(table).replace(/[^A-Za-z0-9_]/g, '')
  const rows = await q('DESC `' + safe + '`', [])
  return rows.map(r => ({
    field: String(r.Field),
    type: String(r.Type),
    nullYes: String(r.Null).toUpperCase() === 'YES',
    pk: String(r.Key || '').toUpperCase() === 'PRI',
    isNoDefault: r.Default === null || r.Default === undefined,
    defaultText: r.Default === null || r.Default === undefined ? '' : String(r.Default),
    comment: String(r.Comment || '')
  }))
}

// —— 导出文本解析（测试侧独立实现，两格式归一到同一形状后逐格比）——
const splitMdRow = line => {
  const s = String(line).trim()
  const a = s.indexOf('|')
  const b = s.lastIndexOf('|')
  const body = a >= 0 && b > a ? s.slice(a + 1, b) : s
  const out = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && (body[i + 1] === '|' || body[i + 1] === '\\')) {
      cur += body[i + 1]
      i++
      continue
    }
    if (ch === '|') {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out.map(x => x.replace(/<br>/g, '\n'))
}

const mdSections = text => {
  const lines = String(text).split('\n')
  const sec = {}
  let key = null
  for (const ln of lines) {
    const m = /^## (.+)$/.exec(ln)
    if (m) {
      key = m[1].replace(/[（(][0-9]+[)）]$/, '').trim()
      sec[key] = []
      continue
    }
    if (key && /^\s*\|/.test(ln)) {
      sec[key].push(splitMdRow(ln))
    }
  }
  // 第一行是表头，其后全是数据行（分隔行 | --- | 剔除）
  const dataOf = k => (sec[k] || []).slice(1).filter(r => !r.every(c => /^-{3,}$/.test(c)))
  const headOf = k => (sec[k] || [])[0] || []
  const info = {}
  for (const r of dataOf('表信息')) {
    info[r[0]] = r[1]
  }
  return {
    title: String(lines[0] || '').replace(/^#\s*/, '').replace(/^数据字典：/, '').trim(),
    sec,
    info,
    heads: k => headOf(k).join(','),
    cols: dataOf('列'),
    idx: dataOf('索引'),
    fk: dataOf('外键')
  }
}

// CSV：页面 text() 已按 UTF-8 解码（BOM 被吃掉），这里按 RFC4180 手解，
// 每个字段带"原文是否被引号包住"—— 转义判据要看的就是这个
const csvRows = text => {
  const s = String(text).replace(/^\uFEFF/, '')
  const out = []
  let row = []
  let f = ''
  let quoted = false
  let wasQuoted = false
  let i = 0
  const endField = () => {
    row.push({ v: f, q: wasQuoted })
    f = ''
    wasQuoted = false
  }
  const endRow = () => {
    endField()
    out.push(row)
    row = []
  }
  while (i < s.length) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          f += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      f += ch
      i++
      continue
    }
    if (ch === '"') {
      quoted = true
      wasQuoted = true
      i++
      continue
    }
    if (ch === ',') {
      endField()
      i++
      continue
    }
    if (ch === '\n' || (ch === '\r' && s[i + 1] === '\n')) {
      endRow()
      i += ch === '\r' ? 2 : 1
      continue
    }
    f += ch
    i++
  }
  if (f !== '' || row.length) {
    endRow()
  }
  return out.filter(r => r.length > 1 || r[0].v !== '')
}

const csvSections = text => {
  const rows = csvRows(text)
  const sec = {}
  let key = null
  for (const r of rows) {
    if (r.length === 1 && /^# /.test(r[0].v)) {
      key = r[0].v.slice(2)
      sec[key] = []
      continue
    }
    if (key) {
      sec[key].push(r)
    }
  }
  const head = k => ((sec[k] || [])[0] || []).map(c => c.v).join(',')
  const data = k => (sec[k] || []).slice(1)
  const info = {}
  for (const r of data('表信息')) {
    info[r[0].v] = r[1] ? r[1].v : ''
  }
  return { sec, head, data, info, keys: Object.keys(sec) }
}

const yes = v => (v ? '是' : '否')
const MD_COL_HEAD = '序号,列名,类型,可空,默认值,主键,注释'
const IDX_HEAD = '索引名,唯一,主键,方法,列'
const FK_HEAD = '外键名,列,引用,删除动作,更新动作'

// —— 页内探针 ——
const PROBE = `
(() => {
  // 下载拦在 createObjectURL + a.click 这一层：真点会弹系统保存框（无头实例卡死）。
  // 文本回传 node 只为解析比对；判据只出哈希/长度/计数，正文不落终端。
  window.__dlCapture = () => {
    if (window.__dlInstalled) return 'ok'
    window.__dl = []
    const urls = new Map()
    const origCreate = URL.createObjectURL.bind(URL)
    URL.createObjectURL = b => {
      const u = origCreate(b)
      urls.set(u, b)
      return u
    }
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        const b = urls.get(this.getAttribute('href'))
        if (b) {
          Promise.all([b.text(), b.arrayBuffer()]).then(([t, buf]) => {
            window.__dl.push({
              name: this.download,
              type: b.type,
              text: t,
              bytes: Array.from(new Uint8Array(buf).slice(0, 3)),
              tl: t.length,
              th: window.__hash(t)
            })
          })
        }
        return
      }
      return origClick.apply(this, arguments)
    }
    window.__dlInstalled = true
    return 'ok'
  }
  window.__dictBtn = () => {
    const tools = [...document.querySelectorAll('.db-struct-tools')].filter(window.__vis)[0]
    const btn = tools && [...tools.querySelectorAll('button')]
      .find(b => /Export dictionary|导出数据字典/.test(b.innerText))
    if (!btn) return 'no-btn'
    btn.click()
    return 'ok'
  }
  window.__dictMenu = () => JSON.stringify(
    [...document.querySelectorAll('.ant-dropdown-menu-item')].filter(window.__vis)
      .map(i => i.innerText.trim()))
  window.__dictPick = label => {
    const it = [...document.querySelectorAll('.ant-dropdown-menu-item')].filter(window.__vis)
      .find(i => i.innerText.trim() === label)
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  window.__toolsColor = () => {
    const el = window.__stArea()
    return el ? String(getComputedStyle(el.querySelector('.db-struct-tools') || el).color) : ''
  }
  // 结构页网格（DESC 那条通道）：按列头取值，只回长度与哈希。
  // 两个 DOM 事实决定了这里的写法：
  //   · 取"可见的那块 .db-struct-area"而不是第一块——页签切走的 pane 仍挂在 DOM 里，
  //     按顺序取会读到 display:none 的空网格；
  //   · DbGridTable 是 virtual（y>0 即开），表体只渲染可视区那十几行，行不是 tbody tr。
  //     所以整表对账必须滚动 + 累积（node 侧 __stScan 循环），单次读只能拿到屏内行。
  //   行上带 data-row-key（值 = structureRows 的位置下标），累积用位置当键：既证明
  //   页 = catalog 的全部列，也证明顺序没被打乱。
  //   滚动容器不写死类名（antd 6 虚拟表体的类名与 rc-virtual-list 老名字不一致），
  //   按 area 内纵向可滚的那个 div 找，找到的类名回写进 diag。
  window.__stArea = () => [...document.querySelectorAll('.db-struct-area')].filter(window.__vis)[0] || null
  window.__stNameOf = t => {
    const n = t.querySelector('.db-col-name')
    return ((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]
  }
  window.__stRows = () => {
    const area = window.__stArea()
    if (!area) return []
    return [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)
  }
  window.__stHolder = () => {
    const area = window.__stArea()
    if (!area) return null
    // 不筛 overflow：虚拟表体的 holder 常是 overflow:hidden（虚拟列表自己按 scrollTop
    // 重算可见区），只对这种元素程序化写 scrollTop 才有效。判据退回"内容比可视区高"。
    const cands = [...area.querySelectorAll('div')].filter(d => d.scrollHeight > d.clientHeight + 4)
    cands.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    return cands[0] || null
  }
  window.__stHolderCands = () => {
    const area = window.__stArea()
    if (!area) return []
    return [...area.querySelectorAll('div')]
      .map(d => ({ cls: String(d.className || '').slice(0, 40), sh: d.scrollHeight, ch: d.clientHeight, ov: getComputedStyle(d).overflowY }))
      .filter(d => d.sh > d.ch + 4)
      .sort((a, b) => (b.sh - b.ch) - (a.sh - a.ch))
      .slice(0, 5)
  }
  window.__stDiag = () => {
    const all = [...document.querySelectorAll('.db-struct-area')]
    const vis = all.filter(window.__vis)
    const area = vis[0]
    const rows = window.__stRows()
    const r0 = rows[0]
    const holder = window.__stHolder()
    return JSON.stringify({
      areas: all.length,
      visible: vis.length,
      heads: area ? [...area.querySelectorAll('thead th')].filter(window.__vis).map(window.__stNameOf) : [],
      rowCount: rows.length,
      rowTag: r0 ? String(r0.tagName) : '',
      rowAttrs: r0 ? [...r0.attributes].map(a => a.name).join(' ') : '',
      rowKeyAttr: r0 ? String(r0.getAttribute('data-row-key') === null ? '-' : r0.getAttribute('data-row-key')) : '',
      cellCount: r0 ? (r0.children || []).length : -1,
      hasScrollHolder: !!holder,
      holderCls: holder ? String(holder.className) : '-',
      holderCands: window.__stHolderCands(),
      scrollHeight: holder ? holder.scrollHeight : -1,
      clientHeight: holder ? holder.clientHeight : -1
    })
  }
  window.__stHeads = () => {
    const area = window.__stArea()
    if (!area) return JSON.stringify([])
    return JSON.stringify([...area.querySelectorAll('thead th')].filter(window.__vis).map(window.__stNameOf))
  }
  // 屏内行的 (Field 哈希, 目标列哈希/长度)；node 侧滚动若干次后按 Field 累积成整表
  window.__stScan = head => {
    const area = window.__stArea()
    if (!area) return JSON.stringify({ ok: 0, idx: -1, rows: [] })
    const heads = [...area.querySelectorAll('thead th')].filter(window.__vis).map(window.__stNameOf)
    const idx = heads.indexOf(String(head))
    if (idx < 0) return JSON.stringify({ ok: 0, idx, rows: [] })
    const rows = window.__stRows().map(tr => {
      const kids = tr.children || []
      const f = String(((kids[0] || {}).innerText) || '').trim()
      const t = String(((kids[idx] || {}).innerText) || '').trim()
      return {
        k: Number(tr.getAttribute('data-row-key')),
        f: window.__hash(f),
        flen: f.length,
        len: t.length,
        h: window.__hash(t)
      }
    })
    return JSON.stringify({ ok: 1, idx, rows })
  }
  window.__stScroll = px => {
    const holder = window.__stHolder()
    if (!holder) return JSON.stringify({ ok: 0, top: -1, sh: -1, ch: -1 })
    holder.scrollTop = Number(px) || 0
    // 补发一次 scroll：虚拟列表只有收到 scroll 才会重算可见区并换掉屏内行
    holder.dispatchEvent(new window.Event('scroll', { bubbles: false }))
    return JSON.stringify({
      ok: 1,
      want: Number(px) || 0,
      top: holder.scrollTop,
      sh: holder.scrollHeight,
      ch: holder.clientHeight,
      cls: String(holder.className)
    })
  }
  // ops 监听：记渲染层真正发出的 dbClientOp 名字（只记不替换实现，退出时还原）
  window.__ops = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    const wrapped = function (name, ...a) {
      if (name === 'dbClientOp') window.__ops.push(String(a[1]))
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
      .map(x => String(x.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 1)
  })
  return 'probe-installed'
})()
`

let cdpRef = null
const cfg0 = { theme: null }
const openedTabs = []

const restoreAll = async () => {
  if (!cdpRef) {
    return
  }
  try {
    for (const id of openedTabs) {
      await cdpRef.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
    }
    const r = await cdpRef.eval('window.__restoreOps()')
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
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
  // 已经出过结论的判据不再补 SKIP：否则一条 FAIL 会紧跟一条同名牌 SKIP，
  // 总数虚高、红了也看不出是几条真失败。
  const done = new Set(results.map(r => r.name))
  for (const k of Object.keys(L)) {
    if (!done.has(L[k])) {
      skip(L[k], reason)
    }
  }
}

// 虚拟表体只渲染屏内行：逐屏滚动 + 按 data-row-key（位置下标）累积，才拿得到整表。
// （不这么读只看到屏内那二十几行，"结构页 == catalog 全列"这条判据就成了假阳性温床：
// 本轮真库实测 25 列的表，一次读只拿到 22 行。）
const sweepCol = async (cdp, head) => {
  const byPos = new Map()
  const merge = s => {
    if (s && s.ok === 1) {
      for (const r of s.rows) {
        if (Number.isFinite(r.k) && !byPos.has(r.k)) byPos.set(r.k, r)
      }
    }
    return s && s.ok === 1
  }
  const m0 = await cdp.jeval('window.__stScroll(0)')
  if (!m0 || !m0.ok) {
    const one = await cdp.jeval('window.__stScan(' + JSON.stringify(head) + ')')
    return { ok: merge(one) ? 1 : 0, byPos, screens: 1, got: byPos.size, virtual: false }
  }
  await sleep(160)
  const ch = m0.ch > 0 ? m0.ch : 240
  const sh = m0.sh > 0 ? m0.sh : 0
  const step = Math.max(60, Math.floor(ch * 0.6))
  const tops = []
  for (let t = 0; t + ch < sh; t += step) tops.push(t)
  tops.push(Math.max(0, sh - ch))
  let maxTop = 0
  for (const t of tops) {
    const s = await cdp.jeval('window.__stScroll(' + t + ')')
    if (s && s.ok === 1) maxTop = Math.max(maxTop, s.top)
    await sleep(160)
    merge(await cdp.jeval('window.__stScan(' + JSON.stringify(head) + ')'))
  }
  await cdp.jeval('window.__stScroll(0)')
  return {
    ok: byPos.size > 0 ? 1 : 0,
    byPos,
    screens: tops.length,
    sh,
    ch,
    maxTop,
    holderCls: m0.cls,
    got: byPos.size,
    virtual: true
  }
}

// 一张表 = 一轮"开结构页 → 两格式导出 → 与 catalog 逐格对账"
const runTable = async (cdp, table, cat, desc) => {
  const dbNode = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(ENV.db) + ')')
  const shown = await waitFor(cdp, 'window.__hasTree(' + JSON.stringify(table) + ')',
    'table node ' + table, 40000)
  const node = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(table) + ')')
  await sleep(900)
  const tab = await cdp.eval('window.__clickTab("表结构|Structure")')
  const rowsReady = await waitFor(cdp,
    '(() => { const h = JSON.parse(window.__stHeads()); const s = JSON.parse(window.__stScan("Field"));' +
    ' return h.indexOf("Field") >= 0 && s.ok === 1 && s.rows.length > 0 })()',
    'structure rows', 40000)
  // 失败时判据要自带现场（几块 area、可见的是第几块、列头叫什么），
  // 否则下一轮还得再跑一次才能知道 selector 错在哪
  const diag = await cdp.jeval('window.__stDiag()')
  const heads = await cdp.jeval('window.__stHeads()')
  const sw = await sweepCol(cdp, 'Field')
  // 位置对位置：第 i 行的 Field 必须等于 catalog 第 i 列的名字
  // （既证明"页 = catalog 全部列"，也证明顺序没被打乱、保留字列名原样在页上）
  const nameMissing = cat.cols.filter((c, i) => {
    const p = sw.byPos.get(i)
    return !p || p.f !== djb2(c.name)
  }).length
  check(label(table, '1'), dbNode === 'ok' && shown && node === 'ok' && tab === 'ok' && rowsReady &&
    heads.length === 6 && ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']
    .every(h => heads.indexOf(h) >= 0) && sw.ok === 1 &&
    sw.got === cat.cols.length && nameMissing === 0,
  {
    dbNode,
    shown,
    node,
    tab,
    rowsReady,
    heads,
    pageRows: sw.got,
    screens: sw.screens,
    virtual: sw.virtual,
    holderCls: sw.holderCls || '-',
    nameMissing,
    catalog: cat.cols.length,
    diag
  })

  const cmt = cat.cols.filter(c => c.comment !== '').length
  check(label(table, '2'), cmt > 0, { commentedCols: cmt, cols: cat.cols.length })

  // 两份导出
  await cdp.eval('window.__dl.length = 0')
  const btn = await cdp.eval('window.__dictBtn()')
  await sleep(350)
  const menu = await cdp.jeval('window.__dictMenu()')
  const darkColor = await cdp.eval('window.__toolsColor()')
  const pickMd = await cdp.eval("window.__dictPick('Markdown')")
  const gotMd = await waitFor(cdp, 'window.__dl.length >= 1', 'md download', 8000)
  await cdp.eval('window.__dictBtn()')
  await sleep(350)
  const pickCsv = await cdp.eval("window.__dictPick('CSV')")
  const gotCsv = await waitFor(cdp, 'window.__dl.length >= 2', 'csv download', 8000)
  const dl = await cdp.jeval('JSON.stringify(window.__dl)')
  const md = (dl || []).find(d => /\.md$/.test(String(d.name))) || {}
  const csv = (dl || []).find(d => /\.csv$/.test(String(d.name))) || {}
  const nameRe = ext => new RegExp('^dictionary-' + ENV.db + '-' + table + '-\\d{8}-\\d{6}\\.' + ext + '$')
  check(label(table, '3'), btn === 'ok' && menu.length === 2 && menu.indexOf('Markdown') > -1 &&
    menu.indexOf('CSV') > -1 && pickMd === 'ok' && gotMd && pickCsv === 'ok' && gotCsv &&
    nameRe('md').test(String(md.name)) && /^text\/markdown/.test(String(md.type)) &&
    nameRe('csv').test(String(csv.name)) && /^text\/csv/.test(String(csv.type)),
  { btn, menu, pickMd, pickCsv, nameMd: md.name, typeMd: md.type, typeCsv: csv.type })

  const M = mdSections(md.text || '')
  const Cv = csvSections(csv.text || '')
  const after = await catalogOf(table)

  // 表信息 ↔ TABLES（估算行数是 InnoDB 统计值，两次读之间可能刷新 → 等于其一即算忠实）
  const estText = String(M.info.估算行数 === undefined ? '' : M.info.估算行数)
  const estOk = /^[0-9]+$/.test(estText) &&
    [cat.estimatedRows, after.estimatedRows].map(Number).includes(Number(estText))
  check(label(table, '4'), M.title === ENV.db + '.' + table &&
    M.info.表 === ENV.db + '.' + table && M.info.类型 === (after.isView ? '视图' : '表') &&
    String(M.info.注释 || '') === after.tableComment && estOk &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(M.info.导出时间 || '')) &&
    M.heads('列') === MD_COL_HEAD && M.heads('索引') === IDX_HEAD && M.heads('外键') === FK_HEAD,
  { title: M.title, type: M.info.类型, est: estText, estBefore: cat.estimatedRows, estAfter: after.estimatedRows, tableCommentLen: after.tableComment.length, colHead: M.heads('列') })

  check(label(table, '5'), M.cols.length === cat.cols.length &&
    M.cols.every((r, i) => String(r[0]) === String(i + 1)),
  { mdRows: M.cols.length, catalog: cat.cols.length })

  const nameBad = M.cols.filter((r, i) => djb2(String(r[1] || '')) !== djb2(cat.cols[i].name)).length
  const reserved = cat.cols.filter(c => /^(index|key|order|group|desc|range|table|column|select|status|name)$/.test(c.name)).length
  check(label(table, '6'), nameBad === 0, { nameBad, reservedWordCols: reserved })

  const typeBad = M.cols.filter((r, i) => djb2(String(r[2] || '')) !== djb2(cat.cols[i].columnType)).length
  const withLen = cat.cols.filter(c => /\([0-9,]+\)$/.test(c.columnType) || /unsigned/.test(c.columnType)).length
  check(label(table, '7'), typeBad === 0 && withLen > 0, { typeBad, typesWithLengthOrUnsigned: withLen })

  const nullBad = M.cols.filter((r, i) => String(r[3] || '') !== yes(cat.cols[i].nullable)).length
  const pkBad = M.cols.filter((r, i) => String(r[5] || '') !== yes(cat.cols[i].pk)).length
  check(label(table, '8'), nullBad === 0 && pkBad === 0 && cat.cols.some(c => c.pk),
    { nullBad, pkBad, pks: cat.cols.filter(c => c.pk).length, nullables: cat.cols.filter(c => c.nullable).length })

  // 默认值：字典忠实 information_schema，结构页忠实 DESC。这两条通道在 MariaDB 上
  // 对"没有默认值"给的就不是同一个形状（DESC 一律 SQL NULL；IS 把 DEFAULT NULL 给成
  // 字符串 'NULL'、其余给 SQL NULL → 导出留空）。
  // 判据钉"各自忠实 + 差异如实可见"，不钉"两边字面相等"。
  const isDefaultBad = M.cols.filter((r, i) => String(r[4] || '') !== cat.cols[i].defaultText).length
  const swD = await sweepCol(cdp, 'Default')
  const pageOf = i => swD.byPos.get(i)
  const idxs = cat.cols.map((c, i) => i)
  const realIdx = idxs.filter(i => !desc[i].isNoDefault)
  const nullIdx = idxs.filter(i => desc[i].isNoDefault)
  const pageRealBad = realIdx.filter(i => {
    const p = pageOf(i)
    return !p || p.h !== djb2(desc[i].defaultText)
  }).length
  const nullHashes = [...new Set(nullIdx.map(i => (pageOf(i) || {}).h))].filter(h => h !== undefined)
  // 单元格只按"写法"归类比对（哈希对上才算识别出来），默认值本身不进日志
  const FORMS = ['', 'NULL', '—', '-']
  const formName = { '': '留空', NULL: '文本NULL', '—': '长破折号', '-': '连字符' }
  const pageForm = p => {
    const t = p ? FORMS.find(x => djb2(x) === p.h) : undefined
    return t === undefined ? '其它(长度' + ((p || {}).len) + ')' : formName[t]
  }
  const expForm = i => {
    const t = String(cat.cols[i].defaultText)
    return t === '' ? '留空' : t === 'NULL' ? '文本NULL' : '真默认值(长度' + t.length + ')'
  }
  const combos = {}
  for (const i of idxs) {
    const key = '页=' + pageForm(pageOf(i)) + ' / 字典=' + expForm(i)
    combos[key] = (combos[key] || 0) + 1
  }
  const nullForm = nullHashes.length === 1
    ? pageForm({ h: nullHashes[0], len: (pageOf(nullIdx[0]) || {}).len })
    : (nullHashes.length === 0 ? '屏内没读到' : '不统一')
  const mismatch = idxs.filter(i => {
    const p = pageOf(i)
    return !p || p.h !== djb2(String(cat.cols[i].defaultText))
  }).length
  const isStringNull = cat.cols.filter(c => c.defaultText === 'NULL' && !c.isNoDefault).length
  const descSqlNull = desc.filter(d => d.isNoDefault).length
  check(label(table, '9'), isDefaultBad === 0 && swD.ok === 1 &&
    swD.got === cat.cols.length && pageRealBad === 0 && nullHashes.length <= 1,
  {
    isDefaultBad,
    pageRows: swD.got,
    pageRealBad,
    nullForm,
    combos,
    descVsExportMismatchCells: mismatch,
    descRealDefaults: realIdx.length,
    isStringNullDefaults: isStringNull,
    descSqlNullDefaults: descSqlNull,
    colsWithDefaultText: cat.cols.filter(c => !c.isNoDefault).length
  })

  const cmtBad = cat.cols.filter((c, i) => (c.comment === ''
    ? String((M.cols[i] || [])[6] || '') !== ''
    : String((M.cols[i] || [])[6] || '').length !== c.comment.length)).length
  check(label(table, '10'), cmtBad === 0 && cmt > 0, { commentBad: cmtBad, commented: cmt, blank: cat.cols.length - cmt })

  // 索引节 ↔ STATISTICS（按名字对齐：产品按 INDEX_NAME 排，参照不比顺序）
  const want = new Map(after.indexes.map(ix => [ix.name, ix]))
  let idxBad = after.indexes.length === M.idx.length ? 0 : 1
  for (const r of M.idx) {
    const ix = want.get(String(r[0]))
    if (!ix) {
      idxBad++
      continue
    }
    if (String(r[1]) !== yes(ix.unique)) idxBad++
    if (String(r[2]) !== yes(ix.primary)) idxBad++
    if (String(r[3]) !== String(ix.method)) idxBad++
    if (String(r[4]) !== ix.cols.join(', ')) idxBad++
  }
  const catalogHasNonUniq = after.indexes.some(ix => !ix.unique)
  const exportHasNonUniq = M.idx.some(r => String(r[1]) === '否')
  check(label(table, '11'), idxBad === 0 && after.indexes.length > 0 &&
    after.indexes.some(ix => ix.primary) && catalogHasNonUniq === exportHasNonUniq,
  { idxBad, want: after.indexes.length, got: M.idx.length, catalogHasNonUniq, exportHasNonUniq })

  const comp = after.indexes.filter(ix => ix.cols.length > 1)
  if (comp.length) {
    const row = M.idx.find(r => String(r[0]) === comp[0].name)
    const right = comp[0].cols.join(', ')
    const wrong = comp[0].cols.slice().reverse().join(', ')
    check(label(table, '12'), !!row && String(row[4]) === right &&
      (comp[0].cols.length < 2 || String(row[4]) !== wrong),
    { compositeCols: comp[0].cols.length, hashMatch: row ? djb2(String(row[4])) === djb2(right) : false })
  } else {
    check(label(table, '12'), M.idx.every(r => String(r[4]).indexOf(',') < 0),
      { note: '该表无复合索引', singleColIndexes: after.indexes.length })
  }

  check(label(table, '13'), M.fk.length === after.fk &&
    Cv.data('外键').length === after.fk && (M.sec.外键 || []).length >= 1 &&
    Cv.head('外键') === FK_HEAD,
  { catalogFk: after.fk, mdFkRows: M.fk.length, csvFkRows: Cv.data('外键').length })

  const mdWidthBad = M.cols.filter(r => r.length !== 7).length
  const risky = cat.cols.filter(c => /[\\|\r\n]/.test(c.comment) || /[\\|\r\n]/.test(c.columnType)).length
  check(label(table, '14'), mdWidthBad === 0,
    { mdWidthBad, riskyCharsInMetadata: risky, note: risky === 0 ? '真库这批元数据里没有竖线/反斜杠，转义分支仍只有单测证据' : '' })

  check(label(table, '15'), String(csv.bytes) === '239,187,191' && /\r\n/.test(String(csv.text || '')) &&
    Cv.keys.join(',') === '表信息,列,索引,外键' && Cv.head('列') === MD_COL_HEAD &&
    String(md.bytes) !== '239,187,191',
  { csvBytes: csv.bytes, mdBytes: md.bytes, keys: Cv.keys, csvHead: Cv.head('列') })

  const cBody = Cv.data('列')
  const cWidthBad = cBody.filter(r => r.length !== 7).length
  const cNameBad = cBody.filter((r, i) => djb2(String((r[1] || {}).v || '')) !== djb2(cat.cols[i].name)).length
  const tricky = cat.cols.map((c, i) => ({ c, i })).filter(x => /[",\r\n]/.test(x.c.comment))
  const escBad = tricky.filter(x => {
    const r = cBody[x.i] || []
    return r.length !== 7 || (r[6] || {}).v !== x.c.comment || (r[6] || {}).q !== true
  }).length
  const withQuote = tricky.filter(x => x.c.comment.indexOf('"') >= 0).length
  // 每张表只钉"有 tricky 就要转义对"；"这一轮必须真跑过 tricky"由全局 K1 汇总，
  // 不然换一张干净表就会把覆盖面判据变成永久红灯（覆盖面是整轮的属性，不是单表的）
  check(label(table, '16'), cWidthBad === 0 && cNameBad === 0 && escBad === 0,
    { cWidthBad, cNameBad, trickyComments: tricky.length, withDoubleQuote: withQuote, escBad })

  const sameSec = (a, b) => a.length === b.length && a.every((r, i) =>
    !!b[i] && r.length === b[i].length &&
    r.every((cell, j) => djb2(String(cell)) === djb2(String((b[i][j] || {}).v === undefined ? '' : b[i][j].v))))
  // 两格式的表信息同源，但「导出时间」盖的是各次点击的时刻（MD 与 CSV 是两次导出，
  // 跨到下一秒字面值就不同，这是产品行为不是缺陷）—— 这一格排除在逐格同源之外，
  // 改为两边各自校验时间戳格式。
  const infoKeys = Object.keys(M.info).filter(k => k !== '导出时间')
  const infoBody = Object.keys(Cv.info).filter(k => k !== '导出时间').length === infoKeys.length &&
    infoKeys.every(k => djb2(String(M.info[k])) === djb2(String(Cv.info[k])))
  const stampOk = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(M.info.导出时间 || '')) &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(Cv.info.导出时间 || ''))
  const infoSame = infoBody && stampOk
  check(label(table, '17'), sameSec(M.cols, cBody) && sameSec(M.idx, Cv.data('索引')) &&
    sameSec(M.fk, Cv.data('外键')) && infoSame && M.heads('列') === Cv.head('列').replace(/^\uFEFF/, ''),
  {
    colsSame: sameSec(M.cols, cBody),
    idxSame: sameSec(M.idx, Cv.data('索引')),
    fkSame: sameSec(M.fk, Cv.data('外键')),
    infoBody,
    stampOk,
    infoSame
  })

  const hay = String(md.text || '') + '\u0000' + String(csv.text || '')
  const ddl = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|SELECT\s)/i.exec(hay)
  check(label(table, '18'), !ddl && !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/im.test(hay),
    { ddlHit: ddl ? djb2(ddl[0]) : 0, mdLen: md.tl, csvLen: csv.tl })

  return {
    darkColor,
    mdName: md.name,
    csvName: csv.name,
    commaCmt: cat.cols.filter(c => c.comment.indexOf(',') >= 0).length,
    quoteCmt: cat.cols.filter(c => c.comment.indexOf('"') >= 0).length,
    uniqIdx: after.indexes.filter(ix => ix.unique).length,
    nonUniqIdx: after.indexes.filter(ix => !ix.unique).length,
    composite: after.indexes.filter(ix => ix.cols.length > 1).length,
    screens: sw.screens,
    cols: cat.cols.length
  }
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // ---------- 凭据纪律 + 护栏自证 ----------
  const missing = Object.entries(ENV)
    .filter(([, v]) => v === undefined || v === null || v === '')
    .filter(([k]) => k !== 'pass')
    .map(([k]) => k)
  const passGiven = ENV.pass !== undefined
  const src = fs.readFileSync(__filename, 'utf8')
  // 泄密判定要放过「口令和某个键名恰好同词」这一种写法：mysql2 建连选项的键名，
  // 与这套测试库的口令是同一个词（键名那处后面紧跟冒号）。裸 substring 扫会把
  // connect() 里的 `键名: ENV.pass` 判成泄密 → 真库段每轮整批 SKIP，
  // 护栏变成"永远不出证据"，形同虚设。
  // 收窄后的规则：值作为独立 token 出现、且后面不紧接冒号（不是键名）即算泄密。
  // 收窄不是放松——同一条判定要自证能抓住三种硬编码形态，且不误抓键名用法。
  // （所以这段注释本身也不写出那个词，否则护栏第一个抓到的是注释。）
  const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const findSecret = (text, v) => {
    if (!v) return false
    return new RegExp('(?:^|[^A-Za-z0-9_])' + escRe(v) + '(?![A-Za-z0-9_:])').test(String(text))
  }
  const hasSecret = findSecret(src, ENV.pass)
  const leakForms = ENV.pass
    ? ['  pass: ' + JSON.stringify(ENV.pass) + ',', 'RDB_MYSQL_PASS=' + ENV.pass, "const p = '" + ENV.pass + "'"]
    : []
  const caught = leakForms.filter(s => findSecret(s, ENV.pass)).length
  const keyNameOk = findSecret(ENV.pass + ": ENV.pass || '',", ENV.pass)
  check(G.R1, missing.length === 0 && passGiven && !hasSecret &&
    caught === leakForms.length && keyNameOk === false,
  { missing, passGiven, hasSecret, caught, keyNameOk })
  let gReject = 0
  const rejected = []
  for (const bad of ['DELETE FROM t WHERE id=1', 'SELECT 1; DROP TABLE t', 'UPDATE t SET a=1',
    'INSERT INTO t VALUES (1)', 'SHOW CREATE TABLE t']) {
    try {
      assertReadOnly(bad)
      rejected.push(bad.slice(0, 12))
    } catch (e) {
      gReject++
    }
  }
  let gAccept = 0
  for (const good of [COLS_SQL.replace(/\?/g, "'x'"), TAB_SQL.replace(/\?/g, "'x'"),
    IDX_SQL.replace(/\?/g, "'x'"), 'DESC `tgfsom_disk`']) {
    try {
      assertReadOnly(good)
      gAccept++
    } catch (e) {
      console.log('guard false-reject: ' + e.message)
    }
  }
  check(G.R2, gReject === 5 && gAccept === 4 && rejected.length === 0,
    { gReject, gAccept, leakedThrough: rejected })
  if (missing.length || !passGiven || hasSecret || caught !== leakForms.length ||
    keyNameOk || gReject !== 5 || gAccept !== 4) {
    skipAll('缺凭据或护栏不自证：真库段整体跳过（不算通过）')
    console.log('用法: RDB_MYSQL_HOST/PORT/USER/PASS/DB node ' + path.basename(__filename))
    return finish()
  }

  // ---------- catalog 预检（不可达就整批 SKIP，不报红）----------
  const cats = {}
  const descs = {}
  let preErr = ''
  try {
    for (const t of TABLES) {
      cats[t] = await catalogOf(t)
      descs[t] = await descOf(t)
    }
  } catch (e) {
    preErr = String((e && e.code) || (e && e.message) || e).slice(0, 60)
  }
  const ready = TABLES.every(t => cats[t] && cats[t].cols.length > 0 &&
    cats[t].cols.some(c => c.comment !== ''))
  check(G.P1, ready && !preErr, { preErr, cols: TABLES.map(t => (cats[t] || { cols: [] }).cols.length) })
  if (!ready) {
    skipAll('真库不可达或样本表无注释列：后续判据跳过（不算通过） :: ' + preErr)
    return finish()
  }

  // ---------- CDP 现场 ----------
  const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('没有渲染进程目标；应用是否带 --remote-debugging-port=' + PORT + ' 启动？')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)
  // 同实例可能跑过假库演示（它们接管 runGlobalAsync 且不还原）→ 先重载再开真库页签
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  const booted = await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000)
  check(G.A1, booted, { booted })
  if (!booted) {
    throw new Error('渲染进程没起来，后续判据没有意义')
  }
  await cdp.eval(HELPERS)
  await cdp.eval(PROBE)
  const clean = await cdp.eval('(() => ({ fixture: typeof window.__fixture, exec: typeof window.__exec,' +
    ' wb: typeof window.__wbSpy, dlOld: typeof window.__fixture_dl }))()')
  const spy = await cdp.eval('window.__spyOps()')
  const cap = await cdp.eval('window.__dlCapture()')
  check(G.A0, await cdp.eval('typeof window.__dictBtn') === 'function' &&
    await cdp.eval('typeof window.__stScan') === 'function' &&
    await cdp.eval('typeof window.__hash') === 'function' &&
    clean.fixture === 'undefined' && clean.exec === 'undefined' && clean.wb === 'undefined' &&
    clean.dlOld === 'undefined' && spy === 'ok' && cap === 'ok', { clean, spy, cap })

  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) {
    console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))
  }
  // 只读页签：字典是元数据导出，只读连接就该能用（这条也钉住"只读不挡读路径"）
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'dict realdb',
      dbType: 'mysql', dbHost: ${JSON.stringify(ENV.host)}, dbPort: Number(${JSON.stringify(ENV.port)}),
      dbUser: ${JSON.stringify(ENV.user)}, dbPassword: ${JSON.stringify(ENV.pass)},
      dbName: ${JSON.stringify(ENV.db)}, dbSsl: false,
      readOnly: true, production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  openedTabs.push(String(await cdp.eval('String(window.store.activeTabId)')))
  const treeShown = await waitFor(cdp,
    '!!window.__one(".db-tree") || !!window.__one(".db-session-error")', 'tree or conn error', 60000)
  const treeText = String(await cdp.eval('String(((window.__one(".db-tree") || { innerText: "" })).innerText)'))
  const al = await cdp.jeval('window.__alerts()')
  check(G.A2, treeShown && treeText.indexOf(ENV.db) >= 0 && !(al.connErr || []).length,
    { treeShown, hasDb: treeText.indexOf(ENV.db) >= 0, err: (al.connErr || [])[0] || '' })
  if (!treeShown || (al.connErr || []).length) {
    skipAll('真库连接没起来：后续判据跳过')
    return finish()
  }
  const roTab = await cdp.eval(
    "(() => { const t = (window.store.tabs || []).find(x => String(x.title) === 'dict realdb');" +
    ' return t && t.readOnly === true ? 1 : 0 })()')
  check(G.H2, Number(roTab) === 1, { roTab: Number(roTab) })

  let first = null
  const stats = []
  for (const t of TABLES) {
    const r = await runTable(cdp, t, cats[t], descs[t])
    stats.push(r)
    if (!first) {
      first = r
    }
  }

  // 覆盖面是"这一轮"的属性，不是单表的：样本表各有分工，但逗号注释、引号注释、
  // 唯一/非唯一索引、复合索引、跨屏滚动这些分支，整轮加起来必须都真跑到过，
  // 否则某条判据其实是"零样本真空通过"。这里只做汇总断言，不重复单表判据。
  const cov = stats.reduce((a, s) => ({
    tables: a.tables + 1,
    cols: a.cols + s.cols,
    commaCmt: a.commaCmt + s.commaCmt,
    quoteCmt: a.quoteCmt + s.quoteCmt,
    uniqIdx: a.uniqIdx + s.uniqIdx,
    nonUniqIdx: a.nonUniqIdx + s.nonUniqIdx,
    composite: a.composite + s.composite,
    scrolled: a.scrolled + (s.screens > 1 ? 1 : 0)
  }), { tables: 0, cols: 0, commaCmt: 0, quoteCmt: 0, uniqIdx: 0, nonUniqIdx: 0, composite: 0, scrolled: 0 })
  check(G.K1, cov.tables === TABLES.length && cov.commaCmt > 0 && cov.quoteCmt > 0 &&
    cov.uniqIdx > 0 && cov.nonUniqIdx > 0 && cov.composite > 0 && cov.scrolled > 0, cov)

  // ---------- ops 白名单：字典不发 SQL、不写 ----------
  const ops = await cdp.jeval('JSON.stringify(window.__ops || [])')
  const uniq = [...new Set(ops)]
  const badOps = uniq.filter(o => /executeSql|updateCell|insertRow|deleteRows|updateCells|explainQuery|getObjectDdl/i.test(o))
  check(G.H1, badOps.length === 0 && uniq.includes('getTableStructure') &&
    !uniq.includes('executeSql'), { ops: uniq, badOps, total: ops.length })

  // ---------- 双主题 ----------
  await cdp.eval('window.__dictBtn()')
  await sleep(350)
  await cdp.shot(path.join(SHOT_DIR, '1-dark-menu.png'))
  // 时间戳每次导出各盖各的（两次点击只要跨到秒边界就差 1 秒），所以"同前缀"比的
  // 是去掉时间戳之后的词干，不是整名相等 —— 整名相等是测试自己的巧合，不是产品约定
  const stem = n => String(n || '').replace(/-\d{8}-\d{6}\.(md|csv)$/, '')
  const wantStem = 'dictionary-' + ENV.db + '-' + TABLES[0]
  check(G.I1, !!first && stem(first.mdName) === wantStem && stem(first.csvName) === wantStem,
    { md: first && first.mdName, csv: first && first.csvName, stem: first && stem(first.mdName) })
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const lightColor = await cdp.eval('window.__toolsColor()')
    await cdp.shot(path.join(SHOT_DIR, '2-light-menu.png'))
    check(G.I2, !!lightColor && !!first.darkColor && lightColor !== first.darkColor,
      { darkColor: first.darkColor, lightColor })
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(800)
  } else {
    check(G.I2, false, { themeIds })
  }

  console.log('shots → ' + SHOT_DIR)
  console.log('隐私纪律: 判据只出计数/长度/djb2；本脚本零行数据读取')
  for (const t of TABLES) {
    const c = cats[t]
    const d = descs[t] || []
    console.log('catalog ' + t + ': cols=' + c.cols.length +
      ' commented=' + c.cols.filter(x => x.comment !== '').length +
      ' trickyCmt=' + c.cols.filter(x => /[",]/.test(x.comment)).length +
      ' idx=' + c.indexes.length + ' composite=' + c.indexes.filter(x => x.cols.length > 1).length +
      ' nonUniq=' + c.indexes.filter(x => !x.unique).length +
      ' fk=' + c.fk + ' tableCommentLen=' + c.tableComment.length +
      ' IS_string_NULL_default=' + c.cols.filter(x => x.defaultText === 'NULL' && !x.isNoDefault).length +
      ' IS_sql_NULL_default=' + c.cols.filter(x => x.isNoDefault).length +
      ' DESC_sql_NULL_default=' + d.filter(x => x.isNoDefault).length)
  }
  console.log('覆盖面合计: tables=' + cov.tables + ' cols=' + cov.cols +
    ' commaCmt=' + cov.commaCmt + ' quoteCmt=' + cov.quoteCmt +
    ' uniqIdx=' + cov.uniqIdx + ' nonUniqIdx=' + cov.nonUniqIdx +
    ' composite=' + cov.composite + ' scrolled=' + cov.scrolled)
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
