#!/usr/bin/env node
/**
 * H4 · 属性级结构对比（同连接、同库两张表）—— 真库 CDP 验收（MariaDB，只读）
 *
 * 假库那 30 条钉的是"弹层行为"（预置 A、方向、失败不冒充、复制、刷新、零写、双主题），
 * 它钉不住只有真服务器能回答的三件事：
 *   1) **差异是不是真的**：真库里两张孪生表到底差几列、差在哪个属性，
 *      是 information_schema 说了算，不是夹具里手写的两份 JSON 说了算。
 *      本脚本自己连真库读 COLUMNS/STATISTICS，按"名字两边都有 → 逐属性比"独立算一遍
 *      四态计数与条目名集合，再与屏面上的计数/条目对账。
 *   2) **旧值新值取的是不是原值**：报告里 `类型 varchar(64) → varchar(255)` 这种，
 *      两个字符串都得是服务端真给的那两个（比对用 djb2，正文不外传）。
 *   3) **真库的形状歧义**：MariaDB 的 COLUMN_DEFAULT 把 `DEFAULT NULL` 给成字符串
 *      'NULL'，把"没有默认值"给成 SQL NULL —— 两者在界面上如果印成同一个词，
 *      "默认值 NULL → NULL"就等于什么都没说。这类只有真数据能撞出来。
 *
 * 参照系不是产品实现的拷贝：node 侧另开一条 mysql2 连接直查 information_schema，
 * 本脚本**不 require** `src/client/common/db-structure-diff.js`。
 *
 * 隐私纪律（生产库）：
 *   · 一条行数据都不读：只 SELECT information_schema；
 *   · 页签 readOnly: true，渲染层 ops 全程监听，executeSql 与写操作零出现；
 *   · 复制出来的报告**不回传 node**：只在页面里算长度/哈希/是否含限定名/是否含 DDL/
 *     各节行数，判据拿这些派生值；列名与注释是有业务含义的元数据，不落终端。
 *
 * 凭据只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-struct-diff-realdb.js [debugPort] [shotDir]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败）。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-struct-diff-realdb-shots')
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

// 三对真表，按 information_schema 实况算过差异形状再选（不是猜的），各钉一件事：
//   覆盖面锚点 —— 7 列/2 索引 vs 9 列/3 索引：类型、长度、可空、默认值、注释五类变更
//                 在同一对里各出现 ≥1 次，独有列 2 vs 4，还有一条索引属性差异与一个
//                 "仅在一边的索引"，并且默认值差异里带着"一侧本来没有默认值"的样本
//                 （N1 要判的就是这种情形）——没有它，覆盖面判据只能靠碰运气；
//   不对称对 —— 21 列/6 索引 vs 16 列/2 索引：9 列一致、3 处可空+默认值不同（默认值
//               三处全是"一侧没有默认值"）、注释差异 2、独有列 9 vs 4、仅在一边的索引 5；
//   孪生对 —— 20 列 vs 20 列、索引两边同名同构：只有 1 处类型差异 + 两边各 1 个独有列，
//             钉"绝大多数条目相同 → 差异区只列那几条、无差异的索引节不出现"。
const PAIRS = [
  { a: 'tgfsom_filesystem_qos', b: 'tgfsom_hsm_copytool' },
  { a: 'tgfsom_directory', b: 'tgfsom_filesystem' },
  { a: 'tgfsom_hsm_archive_task', b: 'tgfsom_hsm_load_task' }
]
// 同表自比：钉"两张表结构一致"这条提示路径（真库上，不是夹具里两份相同 JSON）
const SELF = 'tgfsom_directory'

const TPL = [
  ['1', '弹层从结构页打开，A 预置为当前表（限定名）'],
  ['2', '四态计数与参照一致（仅在A / 仅在B / 有差异 / 相同）'],
  ['3', '差异条目名集合与参照一致（不丢差异、不造差异）'],
  ['4', '每条"有差异"的旧→新取的是服务端原值（djb2 对账）'],
  ['5', '"仅在 A/B"条目的一行摘要取的是服务端原值'],
  ['6', '相同条目不进差异区（只出现在计数里）'],
  ['7', '索引节差异与 STATISTICS 一致'],
  ['8', '外键节按真库实况（该库 0 外键 → 节不出现）'],
  ['9', '复制报告是 Markdown、含两表限定名、不含任何 DDL/DML 语句'],
  ['10', '对比路径只读：ops 只有元数据类调用，无 executeSql、无写']
]
const L = {}
const label = (p, k) => p.a + ' vs ' + p.b + ' #' + k
for (const p of PAIRS) {
  for (const [k, d] of TPL) {
    L[label(p, k)] = p.a + ' vs ' + p.b + ' · ' + d
  }
}
const G = {
  R1: '凭据全部来自环境变量、脚本正文不含口令',
  R2: 'node 侧只读护栏：5 条写语句全拒、4 条元数据读语句放行',
  A0: '开跑前现场干净（无假 adapter 桩、探针装上了）',
  A1: '渲染进程可用（window.store / pre / translate）',
  A2: '只读页签建连成功（树里出现库名、无连接错误页）',
  P0: 'catalog 可达：每对表都取到列，且参照算得出差异（不是"零差异所以全过"）',
  T1: '候选表清单 = 当前库的表（与树里表节点同源，不含视图）',
  S1: '同表自比：真库上给"两张表结构一致"，四态计数只剩相同',
  F1: '换 B 不串结果：计数与条目随选择重算（不拿上一对的结构配新选择）',
  N1: '无值写法不歧义：屏面上"没有该属性"不能印成与真实字面值同一个词',
  I1: '差异旧/新值色取自语义令牌：等于 --error/--success 解析值，现场改写令牌元素立刻跟着变（不是写死的色值）',
  I2: '换到浅色主题：面板正文色跟着主题走，旧/新值仍解析自语义令牌',
  K1: '覆盖面汇总：类型/长度/可空/默认值/注释变更 + 仅A/仅B + 索引属性差异 + 仅一边的索引 + 一侧无值样本，这一轮都真出现'
}
for (const k of Object.keys(G)) {
  L[k] = G[k]
}

// —— node 侧只读护栏 ——
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|rename|call|execute|set|lock|unlock|load|kill|shutdown|handler|commit|rollback|savepoint|prepare|deallocate)\b/i
const assertReadOnly = sql => {
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

const djb2 = s => {
  let h = 5381
  const t = String(s === null || s === undefined ? '' : s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return h
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

const COLS_SQL = 'SELECT ORDINAL_POSITION op, COLUMN_NAME nm, COLUMN_TYPE ct, IS_NULLABLE nu,' +
  ' COLUMN_DEFAULT df, COLUMN_COMMENT cm, CHARACTER_MAXIMUM_LENGTH ml' +
  ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?' +
  ' ORDER BY ORDINAL_POSITION'
const IDX_SQL = 'SELECT INDEX_NAME nm, NON_UNIQUE nu, SEQ_IN_INDEX sq, COLUMN_NAME cn, INDEX_TYPE it' +
  ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?' +
  ' ORDER BY INDEX_NAME, SEQ_IN_INDEX'
const FK_SQL = 'SELECT DISTINCT CONSTRAINT_NAME nm FROM information_schema.KEY_COLUMN_USAGE' +
  ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL'
const TABS_SQL = 'SELECT TABLE_NAME nm, TABLE_TYPE ty FROM information_schema.TABLES' +
  ' WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME'

const catalogOf = async table => {
  const [cols, idx, fk] = await Promise.all([
    q(COLS_SQL, [ENV.db, table]),
    q(IDX_SQL, [ENV.db, table]),
    q(FK_SQL, [ENV.db, table])
  ])
  const imap = new Map()
  for (const r of idx) {
    if (!imap.has(r.nm)) {
      imap.set(r.nm, { name: r.nm, unique: Number(r.nu) === 0, primary: r.nm === 'PRIMARY', method: String(r.it || ''), rows: [] })
    }
    imap.get(r.nm).rows.push({ sq: Number(r.sq) || 0, cn: r.cn })
  }
  return {
    table,
    cols: cols.map(c => ({
      name: String(c.nm),
      type: String(c.ct || ''),
      maxLength: c.ml === null || c.ml === undefined ? null : Number(c.ml),
      nullable: String(c.nu).toUpperCase() === 'YES',
      // df 为 SQL NULL = 没有默认值；MariaDB 把 DEFAULT NULL 给成字符串 'NULL'
      defaultRaw: c.df === null || c.df === undefined ? null : String(c.df),
      comment: c.cm === null || c.cm === undefined ? '' : String(c.cm)
    })),
    indexes: [...imap.values()].map(ix => ({
      name: ix.name,
      unique: ix.unique,
      primary: ix.primary,
      method: ix.method,
      cols: ix.rows.sort((x, y) => x.sq - y.sq).map(x => String(x.cn))
    })),
    fk: fk.length
  }
}

// —— 参照：按"名字两边都有 → 逐属性比"独立算四态（MySQL 标识符大小写不敏感）——
const fold = s => String(s).toLowerCase()
const FIELD_LABEL = {
  type: '类型',
  length: '长度',
  nullable: '可空',
  default: '默认值',
  comment: '注释'
}
const IDX_FIELD_LABEL = {
  unique: '唯一',
  primary: '主键',
  columns: '列',
  method: '方法'
}

const diffCols = (A, B) => {
  const ma = new Map(A.map(c => [fold(c.name), c]))
  const mb = new Map(B.map(c => [fold(c.name), c]))
  const keys = [...new Set([...ma.keys(), ...mb.keys()])]
  return keys.map(k => {
    const a = ma.get(k) || null
    const b = mb.get(k) || null
    if (!a) return { kind: 'column', name: b.name, status: 'added', base: null, target: b, fields: [] }
    if (!b) return { kind: 'column', name: a.name, status: 'removed', base: a, target: null, fields: [] }
    const fields = []
    if (a.type !== b.type) fields.push('type')
    if (String(a.maxLength) !== String(b.maxLength)) fields.push('length')
    if (a.nullable !== b.nullable) fields.push('nullable')
    if (String(a.defaultRaw) !== String(b.defaultRaw)) fields.push('default')
    if (a.comment !== b.comment) fields.push('comment')
    if (!fields.length) return { kind: 'column', name: a.name, status: 'equal', base: a, target: b, fields: [] }
    return { kind: 'column', name: a.name, status: 'changed', base: a, target: b, fields }
  })
}

const diffIdx = (A, B) => {
  const ma = new Map(A.map(c => [fold(c.name), c]))
  const mb = new Map(B.map(c => [fold(c.name), c]))
  const keys = [...new Set([...ma.keys(), ...mb.keys()])]
  return keys.map(k => {
    const a = ma.get(k) || null
    const b = mb.get(k) || null
    if (!a) return { kind: 'index', name: b.name, status: 'added', base: null, target: b, fields: [] }
    if (!b) return { kind: 'index', name: a.name, status: 'removed', base: a, target: null, fields: [] }
    const fields = []
    if (a.unique !== b.unique) fields.push('unique')
    if (a.primary !== b.primary) fields.push('primary')
    if (a.cols.join(',') !== b.cols.join(',')) fields.push('columns')
    if (fold(a.method) !== fold(b.method)) fields.push('method')
    if (!fields.length) return { kind: 'index', name: a.name, status: 'equal', base: a, target: b, fields: [] }
    return { kind: 'index', name: a.name, status: 'changed', base: a, target: b, fields }
  })
}

const summaryOf = list => ({
  removed: list.filter(x => x.status === 'removed').length,
  added: list.filter(x => x.status === 'added').length,
  changed: list.filter(x => x.status === 'changed').length,
  equal: list.filter(x => x.status === 'equal').length
})
const tally = summaryOf

// 期望渲染出来的文本（与组件 fmt 的口径同源：布尔 → 是/否，数组 → (a, b)，缺值 → 见 N1）
const expectText = (kind, field, side) => {
  if (field === 'nullable') return side.nullable ? '是' : '否'
  if (field === 'length') return side.maxLength === null ? null : String(side.maxLength)
  if (field === 'type') return side.type
  if (field === 'comment') return side.comment === '' ? null : side.comment
  if (field === 'default') return side.defaultRaw
  if (field === 'unique') return side.unique ? '是' : '否'
  if (field === 'primary') return side.primary ? '是' : '否'
  if (field === 'columns') return '(' + side.cols.join(', ') + ')'
  if (field === 'method') return side.method === '' ? null : side.method
  return null
}

// ---------- 页面探针 ----------
const PROBE = `
(() => {
  window.__ops = []
  window.__clip = null
  // 复制报告只留在页面里：判据要的是"含不含两表限定名 / 有没有 DDL / 概览四态数字 /
  // 每节各形态几行"，不是正文（列名与注释都是带业务含义的元数据，不外传）。
  window.__clipReport = (wantA, wantB) => {
    const s = String(window.__clip === null || window.__clip === undefined ? '' : window.__clip)
    const up = s.toUpperCase()
    const ddl = (up.match(/ALTER\\s+TABLE|CREATE\\s+TABLE|DROP\\s+TABLE|ADD\\s+COLUMN|MODIFY\\s+COLUMN|CHANGE\\s+COLUMN|DROP\\s+COLUMN|RENAME\\s+TO|TRUNCATE|INSERT\\s+INTO|DELETE\\s+FROM/g) || []).length
    const cellsOf = ln => {
      const t = String(ln).trim().replace(/^\\|/, '').replace(/\\|$/, '')
      const out = []
      let cur = ''
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '\\\\' && (t[i + 1] === '|' || t[i + 1] === '\\\\')) {
          cur += t[i + 1]
          i++
          continue
        }
        if (t[i] === '|') {
          out.push(cur.trim())
          cur = ''
          continue
        }
        cur += t[i]
      }
      out.push(cur.trim())
      return out
    }
    const isSep = cs => cs.length > 0 && cs.every(x => /^-{3,}$/.test(x))
    const overview = {}
    const sections = {}
    let sec = null
    let sub = null
    let stage = 0
    for (const ln of s.split('\\n')) {
      if (/^##\\s/.test(ln)) {
        sec = ln.replace(/^##\\s*/, '').trim()
        sub = null
        stage = 0
        continue
      }
      if (/^###\\s/.test(ln)) {
        sub = ln.replace(/^###\\s*/, '').trim()
        stage = 0
        continue
      }
      if (!/^\\|/.test(ln)) continue
      const cs = cellsOf(ln)
      if (sec === '概览') {
        if (!isSep(cs) && cs[0] !== '项') overview[cs[0]] = cs.slice(1).map(x => Number(x))
        continue
      }
      const gk = sec + '/' + (sub || '')
      if (!sections[gk]) sections[gk] = { rows: 0, cols: 0 }
      if (stage === 0) {
        stage = 1
        sections[gk].cols = cs.length
        continue
      }
      if (stage === 1) {
        if (isSep(cs)) {
          stage = 2
          continue
        }
      }
      sections[gk].rows++
    }
    return {
      len: s.length,
      lines: s.split('\\n').length,
      ddl: ddl,
      hasA: s.indexOf(String(wantA || '')) >= 0 ? 1 : 0,
      hasB: s.indexOf(String(wantB || '')) >= 0 ? 1 : 0,
      title: (s.match(/^#\\s*(.*)$/m) || ['', ''])[1],
      overview: overview,
      sections: sections
    }
  }
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    window.__opsOrig = orig
    window.pre.runGlobalAsync = function (name, ...a) {
      if (name === 'dbClientOp') window.__ops.push(String(a[1]))
      return orig.apply(window.pre, arguments)
    }
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
  window.__clipInstall = () => {
    if (window.__clipSpied) return 'ok'
    const orig = window.pre && window.pre.writeClipboard
    if (typeof orig !== 'function') return 'no-writeClipboard'
    window.__clipOrig = orig
    window.pre.writeClipboard = s => { window.__clip = String(s) }
    window.__clipSpied = 1
    return 'ok'
  }
  window.__clipRestore = () => {
    if (!window.__clipOrig) return 'nothing'
    window.pre.writeClipboard = window.__clipOrig
    window.__clipSpied = 0
    window.__clipOrig = null
    return 'restored'
  }
  window.__alerts = () => JSON.stringify({
    connErr: [...document.querySelectorAll('.db-session-error')].filter(window.__vis)
      .map(x => String(x.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 1)
  })
  window.__structTools = () => [...document.querySelectorAll('.db-struct-tools')].filter(window.__vis)[0] || null
  window.__diffBtn = () => {
    const t = window.__structTools()
    const b = t && [...t.querySelectorAll('button')].find(x => /结构对比|Compare structure/i.test(x.innerText))
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  window.__diffRoot = () => [...document.querySelectorAll('.db-diff')].filter(window.__vis)[0] || null
  window.__diffOpen = () => !!window.__diffRoot()
  window.__diffSels = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-select')].filter(window.__vis) : []
  }
  window.__diffSelText = i => {
    const s = window.__diffSels()[i]
    if (!s) return null
    const c = s.querySelector('.ant-select-content') || s
    const has = /ant-select-content-has-value/.test(String((c.parentElement || c).className)) ||
      /ant-select-content-has-value/.test(String(c.className))
    return { text: String(c.innerText || '').trim(), hasValue: has ? 1 : 0 }
  }
  window.__diffSelRect = i => {
    const s = window.__diffSels()[i]
    if (!s) return null
    const r = s.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  // 70 张表的下拉是虚拟列表：DOM 里只有屏内那十来条，必须先搜索再点
  window.__diffType = (i, text) => {
    const s = window.__diffSels()[i]
    if (!s) return 'no-select'
    const inp = s.querySelector('input')
    if (!inp) return 'no-input'
    inp.focus()
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(inp, text)
    inp.dispatchEvent(new window.Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__diffOptions = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => String(o.innerText || '').trim())
  window.__diffOptRect = label => {
    const o = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(x => String(x.innerText || '').trim() === label)
    if (!o) return null
    const r = o.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + 8 }
  }
  window.__diffCounts = () => {
    const r = window.__diffRoot()
    if (!r) return null
    const out = {}
    for (const t of [...r.querySelectorAll('.db-diff-count')]) {
      const cls = String(t.className || '')
      const n = Number((String(t.innerText || '').match(/(\\d+)\\s*$/) || ['', ''])[1])
      const k = /is-removed/.test(cls) ? 'removed' : /is-added/.test(cls) ? 'added'
        : /is-changed/.test(cls) ? 'changed' : /is-equal/.test(cls) ? 'equal' : null
      if (k) out[k] = n
    }
    return out
  }
  window.__diffSections = () => {
    const r = window.__diffRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-diff-section')].filter(window.__vis).map(sec => ({
      title: String(((sec.querySelector('.db-diff-section-title') || {}).innerText) || '').trim(),
      rows: [...sec.querySelectorAll('.db-diff-row')].map(row => {
        const cls = String(row.className || '')
        const st = (cls.match(/is-(removed|added|changed|equal)/) || ['', ''])[1]
        const f = [...row.querySelectorAll('.db-diff-field')].map(x => ({
          k: String(((x.querySelector('.db-diff-field-key') || {}).innerText) || '').trim(),
          old: String(((x.querySelector('.db-diff-old') || {}).innerText) || ''),
          new: String(((x.querySelector('.db-diff-new') || {}).innerText) || '')
        }))
        const br = row.querySelector('.db-diff-brief')
        return {
          status: st,
          name: String(((row.querySelector('.db-diff-name') || {}).innerText) || '').trim(),
          nameH: window.__hash(String(((row.querySelector('.db-diff-name') || {}).innerText) || '').trim()),
          fields: f,
          brief: br ? String(br.innerText || '') : '',
          briefH: br ? window.__hash(String(br.innerText || '')) : null
        }
      })
    }))
  }
  window.__diffHint = () => {
    const r = window.__diffRoot()
    if (!r) return null
    const h = [...r.querySelectorAll('.db-diff-hint')].filter(window.__vis)[0]
    return h ? String(h.innerText || '').trim() : ''
  }
  window.__diffErr = () => {
    const r = window.__diffRoot()
    if (!r) return ''
    const e = r.querySelector('.db-diff-err')
    return e ? String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : ''
  }
  // 按钮按可见文案找：调用的那侧传的是字符串（写在 eval 表达式里），这里现编成正则
  window.__diffFooter = pat => {
    const m = [...document.querySelectorAll('.db-struct-diff-modal')].filter(window.__vis)[0]
    if (!m) return null
    const re = new RegExp(String(pat))
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .find(x => re.test(String(x.innerText || '').replace(/\\s+/g, '')))
    return b || null
  }
  window.__diffClick = pat => {
    const b = window.__diffFooter(pat)
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
  window.__diffClose = () => {
    const m = [...document.querySelectorAll('.db-struct-diff-modal')].filter(window.__vis)[0]
    const x = m && m.querySelector('.ant-modal-close')
    if (!x) return 'no-x'
    x.click()
    return 'ok'
  }
  window.__diffColor = sel => {
    const r = window.__diffRoot()
    if (!r) return ''
    const el = r.querySelector(sel)
    return el ? String(getComputedStyle(el).color) : ''
  }
  // 令牌解析后的实际颜色：借一个临时 span 走 var(--x)，拿到的就是元素该长的那个 rgb，
  // 直接读 getPropertyValue 只会拿到 #EF476F 这种原始字面量，跟 computed color 不同形。
  window.__diffTokenColor = name => {
    const s = document.createElement('span')
    s.style.color = 'var(--' + String(name) + ')'
    document.body.appendChild(s)
    const c = String(getComputedStyle(s).color)
    s.remove()
    return c
  }
  // 现场改写令牌（val 传空 = 撤掉覆盖）：用来证明旧/新值是"跟着令牌走"而不是写死的色值
  window.__diffForceToken = (name, val) => {
    const k = '--' + String(name)
    if (!val) {
      document.documentElement.style.removeProperty(k)
      return 'removed'
    }
    document.documentElement.style.setProperty(k, String(val))
    return 'set'
  }
  return 'probe-installed'
})()
`

let cdpRef = null
const cfg0 = { theme: null }
const openedTabs = []

const restoreAll = async () => {
  const cdp = cdpRef
  if (!cdp) return
  try {
    let r = 'skip'
    let c = 'skip'
    if (cfg0.theme) {
      await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    for (const id of openedTabs) {
      await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
    }
    r = await cdp.eval('window.__restoreOps()')
    c = await cdp.eval('window.__clipRestore()')
    console.log('restored: ops=' + r + ' clip=' + c + ' tabs=' + openedTabs.length +
      ' theme=' + cfg0.theme)
  } catch (e) {
    console.log('restore failed: ' + (e && e.message))
  }
}

const finish = () => {
  const bad = results.filter(r => !r.ok && !r.skipped)
  const sk = results.filter(r => r.skipped)
  console.log('')
  console.log((results.length - sk.length - bad.length) + '/' + results.length +
    ' PASS（跳过 ' + sk.length + '）')
  if (bad.length) {
    for (const b of bad) console.log('FAILED: ' + b.name)
  }
  return bad.length ? 1 : 0
}

const skipAll = reason => {
  const done = new Set(results.map(r => r.name))
  for (const k of Object.keys(L)) {
    if (!done.has(L[k])) skip(L[k], reason)
  }
}

// ---------- 打开弹层并按名字选表（下拉虚拟 → 先搜后点） ----------
const pickSel = async (cdp, idx, name) => {
  const r = await cdp.jeval('window.__diffSelRect(' + idx + ')')
  if (!r) return 'no-select'
  await cdp.click(r.x, r.y)
  await sleep(220)
  const t = await cdp.eval('window.__diffType(' + idx + ', ' + JSON.stringify(name) + ')')
  if (t !== 'ok') return t
  const ok = await waitFor(cdp,
    'window.__diffOptions().indexOf(' + JSON.stringify(ENV.db + '.' + name) + ') > -1',
    'option ' + name, 6000)
  if (!ok) return 'no-option'
  await sleep(200)
  const o = await cdp.jeval('window.__diffOptRect(' + JSON.stringify(ENV.db + '.' + name) + ')')
  if (!o) return 'no-rect'
  await cdp.click(o.x, o.y)
  const hit = await waitFor(cdp,
    '(window.__diffSelText(' + idx + ') || {}).text === ' + JSON.stringify(ENV.db + '.' + name),
    'selection applied', 5000)
  return hit ? 'ok' : 'not-applied'
}

const openDiffOn = async (cdp, table) => {
  const dbNode = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(ENV.db) + ')')
  const shown = await waitFor(cdp, 'window.__hasTree(' + JSON.stringify(table) + ')',
    'table node ' + table, 40000)
  const node = await cdp.eval('window.__clickTreeExact(' + JSON.stringify(table) + ')')
  await sleep(900)
  const tab = await cdp.eval('window.__clickTab("表结构|Structure")')
  await sleep(700)
  const btn = await cdp.eval('window.__diffBtn()')
  const opened = await waitFor(cdp, 'window.__diffOpen()', 'diff modal', 8000)
  return { dbNode, shown, node, tab, btn, opened }
}

// ---------- 一对表 → 屏面 ----------
const readPair = async (cdp, pair, catA, catB) => {
  const refCols = diffCols(catA.cols, catB.cols)
  const refIdx = diffIdx(catA.indexes, catB.indexes)
  const refSum = {
    removed: refCols.filter(x => x.status === 'removed').length + refIdx.filter(x => x.status === 'removed').length,
    added: refCols.filter(x => x.status === 'added').length + refIdx.filter(x => x.status === 'added').length,
    changed: refCols.filter(x => x.status === 'changed').length + refIdx.filter(x => x.status === 'changed').length,
    equal: refCols.filter(x => x.status === 'equal').length + refIdx.filter(x => x.status === 'equal').length
  }
  const st0 = await cdp.eval('window.__ops.length')
  const st = await openDiffOn(cdp, pair.a)
  await sleep(400)
  const base = await cdp.jeval('window.__diffSelText(0)')
  const pickB = await pickSel(cdp, 1, pair.b)
  // 四个计数都到位才算"这一对算完了"：只等"有 counts 对象"会在空对象上立刻放行
  const ready = await waitFor(cdp,
    '(() => { const c = window.__diffCounts(); return !!c && [c.removed, c.added, c.changed, c.equal].every(x => typeof x === "number") })()',
    'diff result', 25000)
  await sleep(300)
  const counts = await cdp.jeval('window.__diffCounts()')
  const secs = await cdp.jeval('window.__diffSections()')
  const err = await cdp.jeval('window.__diffErr()')
  const hint = await cdp.jeval('window.__diffHint()')
  return {
    st, base, pickB, ready, counts, secs, err, hint, refCols, refIdx, refSum, opsBefore: st0, catA, catB
  }
}

const secOf = (secs, kw) => secs.find(s => String(s.title).indexOf(kw) >= 0) || { title: '', rows: [] }

// 期望某条目某侧的渲染文本（缺值返回 null，由 N1 单独判）
const fieldExpected = (entry, field) => {
  const a = expectText(entry.kind, field, entry.base)
  const b = expectText(entry.kind, field, entry.target)
  return { a, b }
}

// 只在一边出现的条目：屏面那行摘要的期望文本，与组件 brief() 同一口径
const briefExpected = entry => {
  const side = entry.status === 'added' ? entry.target : entry.base
  if (!side) {
    return ''
  }
  if (entry.kind === 'column') {
    return [
      side.type,
      side.nullable ? 'NULL' : 'NOT NULL',
      side.defaultRaw === null ? '' : '默认 ' + side.defaultRaw,
      side.comment
    ].filter(Boolean).join(' · ')
  }
  if (entry.kind === 'index') {
    return [
      side.cols.length ? '(' + side.cols.join(', ') + ')' : '',
      side.unique ? '唯一' : '',
      side.primary ? '主键' : '',
      side.method
    ].filter(Boolean).join(' · ')
  }
  return ''
}

/**
 * 屏面逐行 vs 自连参照逐行：每一处旧值/新值都必须等于 information_schema 的原值
 * （比哈希，正文不出页面），摘要行同理。
 * noValue 数的是"参照里这一侧本来没有值"的样本数（长度/默认值/注释都可能）；
 * ambiguous 数的是这些样本里屏面把"没有值"印得与对面真实值一模一样的次数——
 * 那种报告等于没说（N1 判它，noValue 保证 N1 不是零样本真空通过）。
 */
const auditRows = (rows, refDiff, labelMap) => {
  let bad = 0
  let briefBad = 0
  let noValue = 0
  const ambiguous = []
  const kinds = {}
  const byRef = new Map(refDiff.map(x => [fold(x.name), x]))
  for (const row of rows) {
    const e = byRef.get(fold(row.name))
    if (!e) {
      bad++
      continue
    }
    if (e.status === 'changed') {
      if (row.fields.length !== e.fields.length) bad++
      for (const f of e.fields) {
        kinds[f] = (kinds[f] || 0) + 1
        const got = row.fields.find(x => x.k === (labelMap[f] || f))
        if (!got) {
          bad++
          continue
        }
        const exp = fieldExpected(e, f)
        if (exp.a === null || exp.b === null) noValue++
        if (exp.a !== null && djb2(exp.a) !== djb2(got.old)) bad++
        if (exp.b !== null && djb2(exp.b) !== djb2(got.new)) bad++
        if (exp.a === null && got.old !== '' && djb2(got.old) === djb2(got.new)) ambiguous.push(f)
        if (exp.b === null && got.new !== '' && djb2(got.new) === djb2(got.old)) ambiguous.push(f)
      }
    } else {
      const txt = briefExpected(e)
      if (txt && djb2(txt) !== djb2(row.brief)) briefBad++
    }
  }
  return { bad, briefBad, kinds, ambiguous, noValue }
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
  // 口令与某个键名同词时，裸 substring 扫会把建连选项那一行判成泄密 → 护栏永不出口。
  // 收窄成"值作为独立 token 出现且后面不紧跟冒号"，并自证能抓住三种硬编码形态。
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
  for (const good of [COLS_SQL.replace(/\?/g, "'x'"), IDX_SQL.replace(/\?/g, "'x'"),
    FK_SQL.replace(/\?/g, "'x'"), TABS_SQL.replace(/\?/g, "'x'")]) {
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

  // ---------- catalog 预检 ----------
  const cats = {}
  let preErr = ''
  try {
    for (const p of PAIRS) {
      cats[p.a] = await catalogOf(p.a)
      cats[p.b] = await catalogOf(p.b)
    }
    cats[SELF] = cats[SELF] || await catalogOf(SELF)
  } catch (e) {
    preErr = String((e && e.code) || (e && e.message) || e).slice(0, 60)
  }
  const shapes = PAIRS.map(p => {
    const A = cats[p.a]; const B = cats[p.b]
    if (!A || !B) return null
    const rc = diffCols(A.cols, B.cols)
    const ri = diffIdx(A.indexes, B.indexes)
    return {
      pair: p.a,
      vs: p.b,
      colCount: A.cols.length + '/' + B.cols.length,
      colDiff: rc.filter(x => x.status !== 'equal').length,
      idxCount: A.indexes.length + '/' + B.indexes.length,
      idxDiff: ri.filter(x => x.status !== 'equal').length
    }
  })
  const ready = !preErr && shapes.every(s => s && s.colDiff > 0)
  check(G.P0, ready, { preErr, shapes })
  if (!ready) {
    skipAll('真库不可达或参照算不出差异：后续判据跳过（不算通过） :: ' + preErr)
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
  const clip = await cdp.eval('window.__clipInstall()')
  check(G.A0, await cdp.eval('typeof window.__diffSections') === 'function' &&
    await cdp.eval('typeof window.__hash') === 'function' &&
    clean.fixture === 'undefined' && clean.exec === 'undefined' && clean.wb === 'undefined' &&
    clean.dlOld === 'undefined' && spy === 'ok' && clip === 'ok', { clean, spy, clip })

  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const tabsCleared = await clearDbTabs(cdp)
  if (tabsCleared.left.length) {
    console.log('WARN 仍有未关掉的数据库页签：' + JSON.stringify(tabsCleared.left))
  }
  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: 'diff realdb',
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

  // ---------- 候选表清单 ----------
  const tabList = await q(TABS_SQL, [ENV.db])
  const baseTables = tabList.filter(r => String(r.ty) === 'BASE TABLE').map(r => String(r.nm))
  const nonBase = tabList.filter(r => String(r.ty) !== 'BASE TABLE').map(r => String(r.nm) + ':' + String(r.ty))
  await openDiffOn(cdp, PAIRS[0].a)
  const selRect = await cdp.jeval('window.__diffSelRect(1)')
  await cdp.click(selRect.x, selRect.y)
  await sleep(400)
  const optCount0 = await cdp.eval('window.__diffOptions().length')
  const optDump = await cdp.jeval('JSON.stringify(window.__diffOptions().slice(0, 3))')
  const searchOk = await cdp.eval('window.__diffType(1, ' + JSON.stringify(PAIRS[0].b) + ')')
  await sleep(400)
  const optFiltered = await cdp.jeval('JSON.stringify(window.__diffOptions())')
  await cdp.eval('window.__diffClose()')
  await sleep(400)
  check(G.T1, optCount0 > 0 && optFiltered.length === 1 &&
    optFiltered[0] === ENV.db + '.' + PAIRS[0].b && searchOk === 'ok',
  { baseTables: baseTables.length, nonBase, optCount0, optDump, optFiltered })

  // ---------- 逐对 ----------
  const cov = {
    type: 0,
    length: 0,
    nullable: 0,
    default: 0,
    comment: 0,
    onlyA: 0,
    onlyB: 0,
    idxDiff: 0,
    idxField: 0,
    idxBrief: 0,
    noValue: 0,
    ambiguous: 0
  }
  let shotTaken = false
  for (const p of PAIRS) {
    const catA = cats[p.a]
    const catB = cats[p.b]
    const r = await readPair(cdp, p, catA, catB)
    const colSec = secOf(r.secs, '列')
    const idxSec = secOf(r.secs, '索引')
    const fkSec = secOf(r.secs, '外键')
    const refColDiff = r.refCols.filter(x => x.status !== 'equal')
    const refIdxDiff = r.refIdx.filter(x => x.status !== 'equal')

    // #1 A 预置
    check(label(p, '1'), r.st.btn === 'ok' && r.st.opened && r.st.tab === 'ok' &&
      !!r.base && r.base.text === ENV.db + '.' + p.a && r.pickB === 'ok',
    { st: r.st, base: r.base && r.base.text, pickB: r.pickB, err: r.err })

    // #2 四态计数
    const cnt = r.counts || {}
    check(label(p, '2'), r.ready && !r.err &&
      cnt.removed === r.refSum.removed && cnt.added === r.refSum.added &&
      cnt.changed === r.refSum.changed && cnt.equal === r.refSum.equal,
    { screen: cnt, ref: r.refSum, hint: r.hint })

    // #3 条目名集合
    const nameSet = arr => [...arr].sort().join(',')
    const screenColNames = colSec.rows.map(x => fold(x.name))
    const refColNames = refColDiff.map(x => fold(x.name))
    check(label(p, '3'), nameSet(screenColNames) === nameSet(refColNames) &&
      colSec.rows.length === refColDiff.length,
    {
      screen: colSec.rows.length,
      ref: refColDiff.length,
      onlyScreen: screenColNames.filter(x => refColNames.indexOf(x) < 0),
      onlyRef: refColNames.filter(x => screenColNames.indexOf(x) < 0)
    })

    // #4/#5/N1 逐字段对账
    const aud = auditRows(colSec.rows, refColDiff, FIELD_LABEL)
    const { kinds } = aud
    check(label(p, '4'), aud.bad === 0,
      { bad: aud.bad, rows: colSec.rows.length, kinds })
    check(label(p, '5'), aud.briefBad === 0,
      {
        briefBad: aud.briefBad,
        onlyA: refColDiff.filter(x => x.status === 'removed').length,
        onlyB: refColDiff.filter(x => x.status === 'added').length
      })
    cov.type += kinds.type || 0
    cov.length += kinds.length || 0
    cov.nullable += kinds.nullable || 0
    cov.default += kinds.default || 0
    cov.comment += kinds.comment || 0
    cov.onlyA += refColDiff.filter(x => x.status === 'removed').length
    cov.onlyB += refColDiff.filter(x => x.status === 'added').length
    cov.noValue += aud.noValue
    cov.ambiguous += aud.ambiguous.length

    // #6 相同条目不进差异区
    const equalShown = colSec.rows.filter(x => x.status === 'equal').length
    check(label(p, '6'), equalShown === 0 && colSec.title.indexOf('(' + refColDiff.length + ')') >= 0,
      { equalShown, title: colSec.title, refDiff: refColDiff.length, refEqual: r.refCols.filter(x => x.status === 'equal').length })

    // #7 索引节：名字集合 + 逐属性原值都要与参照对得上
    const screenIdxNames = idxSec.rows.map(x => fold(x.name))
    const refIdxNames = refIdxDiff.map(x => fold(x.name))
    const idxAud = auditRows(idxSec.rows, refIdxDiff, IDX_FIELD_LABEL)
    check(label(p, '7'), nameSet(screenIdxNames) === nameSet(refIdxNames) &&
      idxSec.rows.length === refIdxDiff.length &&
      idxAud.bad === 0 && idxAud.briefBad === 0,
    {
      title: idxSec.title,
      screen: screenIdxNames.length,
      ref: refIdxDiff.length,
      bad: idxAud.bad,
      briefBad: idxAud.briefBad,
      idxKinds: idxAud.kinds,
      onlyScreen: screenIdxNames.filter(x => refIdxNames.indexOf(x) < 0),
      onlyRef: refIdxNames.filter(x => screenIdxNames.indexOf(x) < 0)
    })
    cov.idxDiff += refIdxDiff.length
    cov.idxField += Object.values(idxAud.kinds).reduce((a, x) => a + x, 0)
    cov.idxBrief += refIdxDiff.filter(x => x.status !== 'changed').length
    cov.noValue += idxAud.noValue
    cov.ambiguous += idxAud.ambiguous.length

    // #8 外键节（该库 0 外键 → 节不出现；有外键的库另说）
    check(label(p, '8'), catA.fk === 0 && catB.fk === 0
      ? fkSec.rows.length === 0
      : fkSec.rows.length > 0,
    {
      fkA: catA.fk,
      fkB: catB.fk,
      sectionShown: !!fkSec.title,
      note: '本库 0 外键 → 只钉"不外键节"，外键差异分支仍只有单测证据'
    })

    // #9 复制报告：概览四态 + 每节各形态的行数都要与参照一致，且不含任何 DDL/DML
    await cdp.eval('window.__clip = null')
    const cp = await cdp.eval('window.__diffClick("复制|copy")')
    await sleep(400)
    const rep = await cdp.jeval('window.__clipReport(' +
      JSON.stringify(ENV.db + '.' + p.a) + ', ' + JSON.stringify(ENV.db + '.' + p.b) + ')')
    const tC = tally(r.refCols)
    const tI = tally(r.refIdx)
    const fieldRows = list => list.filter(x => x.status === 'changed')
      .reduce((a, x) => a + x.fields.length, 0)
    const wantRows = {
      '列/仅在 B（新增）': tC.added,
      '列/仅在 A（删除）': tC.removed,
      '列/有差异': fieldRows(r.refCols),
      '索引/仅在 B（新增）': tI.added,
      '索引/仅在 A（删除）': tI.removed,
      '索引/有差异': fieldRows(r.refIdx)
    }
    const gotRows = {}
    const rowBad = []
    for (const k of Object.keys(wantRows)) {
      const g = (rep && rep.sections && rep.sections[k]) || { rows: 0 }
      gotRows[k] = g.rows
      if (g.rows !== wantRows[k]) rowBad.push(k + ':' + g.rows + '≠' + wantRows[k])
    }
    const ovWant = { 列: tC, 索引: tI, 外键: { removed: 0, added: 0, changed: 0, equal: 0 }, 合计: r.refSum }
    const ovBad = []
    for (const k of Object.keys(ovWant)) {
      const row = ((rep && rep.overview) || {})[k]
      const w = ovWant[k]
      // 概览行序 = [仅在A, 仅在B, 有差异, 相同]（与 sectionReport 同一口径）
      if (!row || row[0] !== w.removed || row[1] !== w.added || row[2] !== w.changed || row[3] !== w.equal) {
        ovBad.push(k + '=' + JSON.stringify(row))
      }
    }
    check(label(p, '9'), cp === 'ok' && !!rep && rep.len > 0 && rep.ddl === 0 &&
      rep.hasA === 1 && rep.hasB === 1 && rep.title === '结构对比' &&
      rowBad.length === 0 && ovBad.length === 0,
    {
      cp,
      len: rep && rep.len,
      ddl: rep && rep.ddl,
      title: rep && rep.title,
      hasA: rep && rep.hasA,
      hasB: rep && rep.hasB,
      rowBad,
      ovBad,
      wantRows,
      gotRows,
      overview: rep && rep.overview
    })

    // #10 ops 只读：这一对表只该发元数据读，且必须真发过 getTableStructure
    const ops = await cdp.jeval('JSON.stringify(window.__ops.slice(' + r.opsBefore + '))')
    const uniq = [...new Set(ops)]
    check(label(p, '10'), uniq.length > 0 && uniq.includes('getTableStructure') &&
      uniq.every(o => /^(getTableStructure|getMetadata|listColumns|describeTable|getDbTxState|getPageData)$/.test(o)),
    { ops: uniq, total: ops.length })

    if (!shotTaken) {
      await cdp.shot(path.join(SHOT_DIR, '1-dark-diff.png'))
      shotTaken = true
    }
    await cdp.eval('window.__diffClose()')
    await sleep(400)
  }

  // ---------- 同表自比 ----------
  await openDiffOn(cdp, SELF)
  const selfPick = await pickSel(cdp, 1, SELF)
  await waitFor(cdp, '!!window.__diffCounts()', 'self counts', 20000)
  await sleep(400)
  const selfCounts = await cdp.jeval('window.__diffCounts()')
  const selfHint = await cdp.jeval('window.__diffHint()')
  const selfSecs = await cdp.jeval('window.__diffSections()')
  const selfCat = cats[SELF]
  // 计数是"列 + 索引 + 外键"三节合起来的（自比时两边同一张表 → 全落在"相同"里）
  const selfEqual = selfCat.cols.length + selfCat.indexes.length + selfCat.fk
  check(G.S1, selfPick === 'ok' && !!selfCounts &&
    selfCounts.changed === 0 && selfCounts.added === 0 && selfCounts.removed === 0 &&
    selfCounts.equal === selfEqual && /一致|No structural differences/.test(selfHint) &&
    selfSecs.length === 0,
  { selfPick, counts: selfCounts, hint: selfHint, sections: selfSecs.length, equal: selfEqual })
  await cdp.eval('window.__diffClose()')
  await sleep(300)

  // ---------- 换 B 不串结果 ----------
  // 这一条只有在新旧两对的参照计数真的不同时才有意义：否则"屏面还是上一对"也能过。
  // 等待条件用"转圈消失 + 一轮落定"，不拿期望值当停止条件（那样判据就成了自证）。
  const fa = PAIRS[1].a
  const fb1 = PAIRS[1].b
  const fb2 = PAIRS[0].a
  const sumOf = (ta, tb) => {
    const rc = diffCols(cats[ta].cols, cats[tb].cols)
    const ri = diffIdx(cats[ta].indexes, cats[tb].indexes)
    const s = { changed: 0, equal: 0, added: 0, removed: 0 }
    for (const x of rc.concat(ri)) s[x.status]++
    return s
  }
  const sum1 = sumOf(fa, fb1)
  const sum2 = sumOf(fa, fb2)
  const discriminating = ['changed', 'equal', 'added', 'removed'].some(k => sum1[k] !== sum2[k])
  await openDiffOn(cdp, fa)
  const p1ok = await pickSel(cdp, 1, fb1)
  await waitFor(cdp, '!!window.__diffCounts()', 'pair A counts', 25000)
  await sleep(600)
  const c1 = await cdp.jeval('window.__diffCounts()')
  const p2ok = await pickSel(cdp, 1, fb2)
  await waitFor(cdp, '!document.querySelector(".db-diff .ant-spin")', 'pair B load settled', 25000)
  await sleep(1200)
  const c2 = await cdp.jeval('window.__diffCounts()')
  check(G.F1, p1ok === 'ok' && p2ok === 'ok' && discriminating && !!c2 &&
    c2.changed === sum2.changed && c2.equal === sum2.equal &&
    c2.added === sum2.added && c2.removed === sum2.removed,
  {
    pair1: fa + ' vs ' + fb1,
    pair2: fa + ' vs ' + fb2,
    first: c1,
    after: c2,
    ref1: sum1,
    ref2: sum2,
    discriminating,
    note: 'discriminating=false 说明这两对在四态计数上本来就同形，本判据无法分辨串结果'
  })
  await cdp.eval('window.__diffClose()')
  await sleep(300)

  // ---------- 无值写法 ----------
  check(G.N1, cov.ambiguous === 0, {
    ambiguous: cov.ambiguous,
    noValue: cov.noValue,
    note: '屏面上"这一侧没有该属性"的写法与另一侧真实值同形的次数（真库 MariaDB 会把 DEFAULT NULL 给成字符串 NULL）；noValue 是这类样本总数，为 0 则本判据是真空通过'
  })

  // ---------- 覆盖面 ----------
  // 逐项点名，不用一长串 && ：没跑到的形态要一眼看出是哪一项
  const uncovered = []
  const need = [
    ['type', '类型变更'], ['length', '长度变更'], ['nullable', '可空变更'],
    ['default', '默认值变更'], ['comment', '注释变更'],
    ['onlyA', '仅在 A 的列'], ['onlyB', '仅在 B 的列'],
    ['idxField', '索引属性差异'], ['idxBrief', '仅在某一边的索引'],
    ['noValue', '一侧本来没有值的样本']
  ]
  for (const [k, nm] of need) {
    if (!cov[k]) uncovered.push(nm)
  }
  check(G.K1, uncovered.length === 0, { cov, uncovered })

  // ---------- 双主题 ----------
  // 语义色（--error/--success）是设计令牌，不随主题换——所以这里钉的不是"浅色要变红变绿"，
  // 而是"颜色取自令牌、不是写死的"：值等于令牌解析结果，且现场改写令牌元素立刻跟着变；
  // 换主题后正文色（--text）必须跟着主题走，说明这一屏不是靠一次性硬编码凑出来的。
  await openDiffOn(cdp, PAIRS[1].a)
  await pickSel(cdp, 1, PAIRS[1].b)
  await waitFor(cdp, '!!window.__diffCounts()', 'theme pair counts', 20000)
  await sleep(500)
  const darkOld = await cdp.eval('window.__diffColor(".db-diff-old")')
  const darkNew = await cdp.eval('window.__diffColor(".db-diff-new")')
  const darkName = await cdp.eval('window.__diffColor(".db-diff-name")')
  const darkErr = await cdp.eval('window.__diffTokenColor("error")')
  const darkSuc = await cdp.eval('window.__diffTokenColor("success")')
  await cdp.shot(path.join(SHOT_DIR, '2-dark-diff-pair2.png'))
  await cdp.eval('window.__diffForceToken("error", "rgb(9, 8, 7)")')
  await sleep(150)
  const forcedOld = await cdp.eval('window.__diffColor(".db-diff-old")')
  await cdp.eval('window.__diffForceToken("error", "")')
  await sleep(150)
  const backOld = await cdp.eval('window.__diffColor(".db-diff-old")')
  check(G.I1, !!darkOld && !!darkNew && darkOld !== darkNew &&
    darkOld === darkErr && darkNew === darkSuc &&
    forcedOld === 'rgb(9, 8, 7)' && backOld === darkErr,
  { darkOld, darkNew, darkErr, darkSuc, forcedOld, backOld })
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1400)
    const lightOld = await cdp.eval('window.__diffColor(".db-diff-old")')
    const lightNew = await cdp.eval('window.__diffColor(".db-diff-new")')
    const lightName = await cdp.eval('window.__diffColor(".db-diff-name")')
    const lightErr = await cdp.eval('window.__diffTokenColor("error")')
    const lightSuc = await cdp.eval('window.__diffTokenColor("success")')
    await cdp.shot(path.join(SHOT_DIR, '3-light-diff-pair2.png'))
    check(G.I2, lightName !== darkName && lightOld === lightErr && lightNew === lightSuc,
      { lightId, darkName, lightName, lightOld, lightNew, lightErr, lightSuc })
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(800)
  } else {
    check(G.I2, false, { themeIds })
  }
  await cdp.eval('window.__diffClose()')
  await sleep(300)

  console.log('shots → ' + SHOT_DIR)
  console.log('隐私纪律: 报告正文只留在页面里，判据只出计数/长度/djb2；本脚本零行数据读取')
  console.log('覆盖面: ' + JSON.stringify(cov))
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
