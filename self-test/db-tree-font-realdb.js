#!/usr/bin/env node
/**
 * 真机复测（1/3）· 数据库树过滤 —— 打真 MariaDB（TODO-数据库与显示层剩余项 §2-1「树过滤真机复测」）
 *
 * 为什么还要再跑一遍：树过滤此前只有一条源码契约
 * （`src/test/unit-ci/db-page-tree-filter.spec.js`：从 db-session.jsx 抠出 useMemo 回调体，
 * 在 vm 沙箱里喂**手写假 metadata** 跑）。那条钉的是"过滤算法分支"，钉不住这三件事：
 *   1) 渲染层真拿到的 metadata 是不是 information_schema 那份（这台库实测 4 个 schema、
 *      238 个树节点 = 4 个库 + 1 个例程分组 + 233 个表/视图/序列；mysql 库里那 2 个
 *      PROCEDURE 生成的分组节点 —— 假数据永远"我写几个就是几个"，
 *      节点数、名字集合都构成不了对账）；
 *   2) 计数条 / 高亮 / 空态 / 展开还原这些**界面**行为（源码契约看不到 DOM）；
 *   3) 分组节点按"稳定英文 token（routines/triggers/events）"参与过滤、界面显示中文标签 ——
 *      这条只有库里真有例程时才暴露（本库 mysql 恰有 2 个 PROCEDURE；第一轮就是这样
 *      撞出"计数条说 6 个节点、树里只画得出 4 个"的分组不展开缺陷，已修，见 475a657c）。
 *
 * 三层对账（防"自己对自己"）：
 *   A 参照：node 侧另开一条 mysql2 连接，SHOW DATABASES + information_schema 的
 *     TABLES / ROUTINES / TRIGGERS / EVENTS 四张视图，自己拼"库 → 对象（含分组）"森林，
 *     按过滤语义（父命中保留整棵子树 / 只子命中保留分支 / 大小写不敏感 / 前后空格先 trim）
 *     算出每个关键词的期望集合与期望节点数；
 *   B 界面：CDP 读计数条数字 + DOM 真渲染出的节点（名字只以 djb2 哈希离开页面）；
 *   C 覆盖面：整轮必须真跑到"当前库叶子命中 / 非当前库叶子命中 / 库名命中保留整树 /
 *     分组 token 命中 / 零命中空态 / 大小写 / 空白"七支，缺任一支汇总判据就红。
 *   本脚本不 require 产品的 db-session.jsx，也不复用产品实现的过滤函数。
 *
 * 隐私纪律（这是生产库）：
 *   · 不读任何单元格内容：node 侧只发 SHOW DATABASES、information_schema 元数据查询，
 *     以及给"点哪张表"用的 COUNT(*) 聚合（一个数字，不是行数据）；
 *   · 页签以 readOnly: true 打开，渲染层 ops 全程监听，写 op 与 executeSql 一次都不该出现；
 *   · 判据输出只有计数 / 长度 / 布尔 / djb2 哈希：库名表名是生产元数据，既不回传也不打印；
 *   · 关键词与被点开的表都从参照集合里按规则现选（当前库内 ORDER BY TABLE_NAME 取
 *     第一个命中且有行的），不把任何生产表名写进这份会进版本库的源码。
 *
 * 口径先钉死再看效果：界面有个持久化开关 config.dbHideSystemSchemas（顶栏"隐藏系统库"），
 * 为真时 getMetadata 会把 information_schema / performance_schema / mysql / sys 整批滤掉，
 * 本脚本的参照（SHOW DATABASES 全量）就对不上，且"非当前库命中""分组 token 命中"
 * 两支直接失去样本。所以开页签前显式置 false，收尾还原原值（判据 C0 / Z1）。
 *
 * 凭据只从环境变量读（绝不写进本文件）：
 *   RDB_MYSQL_HOST=… RDB_MYSQL_PORT=… RDB_MYSQL_USER=… RDB_MYSQL_PASS=… RDB_MYSQL_DB=… \
 *   node self-test/db-tree-font-realdb.js [debugPort] [shotDir]
 *
 * 缺凭据 / 真库不可达 → 整批记 SKIP（不算通过也不算失败）。
 * 截图里是生产库的库表名 → `self-test/db-tree-font-realdb-shots/` 已在 .gitignore。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-tree-font-realdb-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const HELPERS = buildHelpers(SPLIT_KEY)
const TAB_TITLE = 'tree realdb'
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
  R1: '凭据纪律：口令不进源码、生产表名不进源码，且护栏自证能抓住三种硬编码形态',
  R2: '只读闸门自证：写/DDL/多语句一律拒发，本脚本要发的元数据与 COUNT 查询全部放行，带反引号/分号的标识符拼不进语句',
  P0: '开跑前桥接原装（无别的脚本留桩）、探针装好、ops 监听挂上',
  C0: '口径钉住：顶栏"隐藏系统库"开关显式置 false（参照按 SHOW DATABASES 全量算，两边同一口径）',
  C1: '真连接起来：树在场、无连接错误条',
  C2: '页签确实以只读打开（readOnly 为真 → 后面的"零写命令"才有前提）',
  C3: '树根库节点集合 == SHOW DATABASES（哈希对，一个不多一个不少）',
  C4: '未过滤时不渲染计数条（关键词为空 → 计数条不在场、输入框为空）',
  C5: '基线折叠态：未过滤时只渲染库节点，子节点不在 DOM 里（后面的"过滤自动展开"才有对照）',
  B1: '关键词 hsm：计数条数字 == 参照算的期望，且 DOM 节点数与它相等',
  B2: '关键词 hsm：渲染出的叶子/库/分组三类节点集合与期望逐条一致（哈希对，不多不少不漏）',
  B3: '关键词 hsm：命中叶子全部带高亮，高亮片段长度 == 关键词长度，没有"没命中却带高亮"的节点',
  B4: '关键词 hsm：只留当前库那一条分支（别的库整棵裁掉，库节点自身不高亮）',
  U1: '大小写不敏感：TASK 与 task 的计数、叶子集合、高亮数完全一致',
  U2: '前后空格不参与匹配：「  task  」与「task」同形（trim 语义），输入框里仍是原样',
  N1: '关键词 variables：只有子节点命中的非当前库也保留（库节点 + 命中对象）',
  N2: '关键词 variables：命中叶子集合与 information_schema 里同名族对象一致',
  D1: '库名命中保留整棵子树：perf → 命中的库全量在册（含名字不含 perf 的子节点）',
  D2: '父命中连带保留的子节点不高亮，只有父节点自身高亮（不冒充命中）',
  G1: '分组按稳定英文 token 过滤：routine 命中 routines 分组，整组子节点保留、计数条对得上',
  G2: '分组标题只有中文标签：命中的英文 token 不出现在可见文案里，也不产生高亮',
  E1: '零命中：计数条写 0、树换成「没有匹配的库或表」空态 + 清除筛选按钮',
  E2: '点「清除筛选」：关键词清空、计数条消失、树回到基线节点数',
  X1: '输入框自带的清除（allowClear 的 ×）与清空等效（不留半个关键词）',
  X2: '展开状态还原：过滤前手动展开的库，过滤再清空后仍是展开的（不是被压平）',
  K1: '过滤态下点开命中的表：右侧数据页就是那张表（标题带表名、参照列名全部在场、真画出行）',
  K2: '点开那张表只发读 op（getPageData 在场），零写命令',
  O1: '树过滤不重请求后端：整轮打字只改内存里的 metadata，getMetadata 次数不因过滤增加',
  O2: '全程 ops 白名单：executeSql / updateCells / insertRow / deleteRows / getObjectDdl 零命中',
  M1: '覆盖面汇总：七支形状这一轮真跑到（当前库叶子/非当前库叶子/库名整树/分组 token/零命中/大小写/空白）',
  T1: '双主题：过滤态深色与浅色各一张，命中高亮色随主题走（不是写死）',
  Z1: '收尾还原 ops 监听、主题与"隐藏系统库"开关、页签（不给下一个脚本留环境差）'
}
const keys = Object.keys(L)

// —— 参照 SQL：固定语句 + 占位符，没有任何生产表名进这份源码 ——
const SQL_SCHEMAS = 'SHOW DATABASES'
const SQL_TABLES = 'SELECT TABLE_SCHEMA sc, TABLE_NAME nm FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME'
const SQL_ROUTINES = 'SELECT ROUTINE_SCHEMA sc, ROUTINE_NAME nm FROM information_schema.ROUTINES ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME'
const SQL_TRIGGERS = 'SELECT TRIGGER_SCHEMA sc, TRIGGER_NAME nm FROM information_schema.TRIGGERS ORDER BY TRIGGER_SCHEMA, TRIGGER_NAME'
const SQL_EVENTS = 'SELECT EVENT_SCHEMA sc, EVENT_NAME nm FROM information_schema.EVENTS ORDER BY EVENT_SCHEMA, EVENT_NAME'
const SQL_COLUMNS = 'SELECT COLUMN_NAME nm FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION'

// B 支关键词（当前库叶子命中）：本库表名有共同前缀片段，用片段而不是表名
const KW_B = 'hsm'

// "点哪张表"要挑一张真有行的，COUNT(*) 只回一个数字，不碰任何单元格内容。
// 标识符来自 information_schema，仍然先过白名单字符校验再加反引号（拼不出第二语句）。
const identOk = s => /^[A-Za-z0-9_$]+$/.test(String(s))
const sqlCount = (schema, table) => {
  if (!identOk(schema) || !identOk(table)) {
    throw new Error('标识符含白名单外字符，拒绝拼 COUNT 查询')
  }
  return 'SELECT COUNT(*) AS n FROM `' + schema + '`.`' + table + '`'
}

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|GRANT|REVOKE|RENAME|CALL|SET|LOCK|UNLOCK|HANDLER|LOAD|OPTIMIZE|ANALYZE)\b/i

// 只读闸门：SHOW / SELECT / DESC 起头，禁分号与写关键字。SHOW 是多出来的口子，
// 因为参照要 SHOW DATABASES；写语句样本一律拒掉（见 R2 的自证）。
const assertReadOnly = sql => {
  const s = String(sql).trim().replace(/;+$/, '')
  if (!/^(select|desc|describe|show)\b/i.test(s)) {
    throw new Error('非 SELECT/DESC/SHOW 起始，拒绝发往真库: ' + s.slice(0, 40))
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

// 与页内 window.__hash 同一套 djb2（有符号 int32）：跨进程只比哈希，名字不外传
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

// —— 参照森林：库 → [表/视图/序列…叶子, 分组节点（例程/触发器/事件，非空才在场）→ 子叶子] ——
// 分组节点参与过滤的名字是稳定英文 token（routines/triggers/events），界面标签是中文 ——
// 参照按 token 算命中、按"标签里没有该 token"算不高亮，两条分开钉。
const buildForest = (schemas, tables, routines, triggers, events) => {
  const bucket = rows => {
    const m = new Map()
    for (const r of rows || []) {
      const k = String(r.sc)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(String(r.nm))
    }
    return m
  }
  const tm = bucket(tables)
  const rm = bucket(routines)
  const gm = bucket(triggers)
  const em = bucket(events)
  return (schemas || []).map(sc => {
    const leaves = (tm.get(sc) || []).map(n => ({ kind: 'leaf', name: n }))
    const groups = []
    for (const [token, names] of [
      ['routines', rm.get(sc) || []],
      ['triggers', gm.get(sc) || []],
      ['events', em.get(sc) || []]
    ]) {
      if (names.length) {
        groups.push({ kind: 'group', name: token, children: names.map(n => ({ kind: 'leaf', name: n })) })
      }
    }
    return { kind: 'db', name: sc, children: leaves.concat(groups) }
  })
}

const normKw = raw => String(raw || '').trim().toLowerCase()
const hit = (name, kw) => String(name || '').toLowerCase().includes(kw)

// 过滤语义（独立一份，不引产品实现）：父命中 → 保留整棵子树；只子命中 → 只留分支；都不沾 → 裁掉
const filterForest = (forest, kw) => {
  if (!kw) return forest
  const walk = node => {
    if (node.kind === 'leaf') return hit(node.name, kw) ? node : null
    const selfHit = hit(node.name, kw)
    const kids = (node.children || []).map(walk).filter(Boolean)
    if (!selfHit && !kids.length) return null
    return { ...node, children: selfHit ? (node.children || []) : kids }
  }
  return forest.map(walk).filter(Boolean)
}

const countNodes = nodes => (nodes || []).reduce((n, x) => n + 1 + countNodes(x.children), 0)

const srt = a => [...a].sort((x, y) => x - y)

// 期望形状：节点总数 + 三类集合 + 三类各自"该高亮"的集合
const expectOf = (forest, kw) => {
  const visible = filterForest(forest, kw)
  const leaves = []
  const dbs = []
  const markLeaves = []
  const markDbs = []
  let groups = 0
  const walk = node => {
    if (node.kind === 'leaf') {
      leaves.push(djb2(node.name))
      if (hit(node.name, kw)) markLeaves.push(djb2(node.name))
      return
    }
    if (node.kind === 'group') groups++
    else {
      dbs.push(djb2(node.name))
      if (hit(node.name, kw)) markDbs.push(djb2(node.name))
    }
    ;(node.children || []).forEach(walk)
  }
  visible.forEach(walk)
  return {
    total: countNodes(visible),
    leaves: srt(leaves),
    dbs: srt(dbs),
    groups,
    markLeaves: srt(markLeaves),
    markDbs: srt(markDbs)
  }
}

// —— 页内探针 ——
const PROBE = `(() => {
  // 与 node 侧同一套 djb2：库名表名是生产元数据，只以哈希离开页面
  window.__hash = s => {
    let h = 5381
    const t = String(s === null || s === undefined ? '' : s)
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
    return h
  }
  window.__txt = el => String((el && el.innerText) || '').replace(/\\s+/g, '')
  window.__tree = () => [...document.querySelectorAll('.db-tree')].filter(x => !window.__hidden(x))[0] || null
  window.__filterInput = () => {
    const box = [...document.querySelectorAll('.db-tree-filter')].filter(el => !window.__hidden(el))[0]
    return box ? box.querySelector('input') : null
  }
  // React 受控 Input：直接改 el.value 不会触发 onChange，必须走原生 setter + input 事件
  window.__setFilter = v => {
    const el = window.__filterInput()
    if (!el) return 'no-input'
    el.focus()
    const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    st.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__filterValue = () => {
    const el = window.__filterInput()
    return el === null ? null : String(el.value)
  }
  window.__clearXY = () => {
    const el = window.__filterInput()
    if (!el) return null
    const x = el.parentElement.querySelector('.ant-input-clear-icon')
    if (!x || window.__hidden(x)) return null
    const r = x.getBoundingClientRect()
    return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  }
  // 计数条：过滤词非空才在场，文本形如「56 个节点」
  window.__chip = () => {
    const el = [...document.querySelectorAll('.db-tree-filter-count')].filter(x => !window.__hidden(x))[0]
    if (!el) return null
    const m = window.__txt(el).match(/[0-9]+/)
    return m ? Number(m[0]) : -1
  }
  // 节点分类：库（.db-tree-db-title）/ 分组或 schema（.db-tree-schema）/ 其余算叶子
  window.__treeRead = () => {
    const out = { dbs: [], leaves: [], groups: 0, marks: 0, unknown: 0, total: 0, expanded: [] }
    const t = window.__tree()
    if (!t) return out
    ;[...t.querySelectorAll('.ant-tree-treenode')].forEach(tn => {
      if (window.__hidden(tn)) return
      const w = tn.querySelector('.ant-tree-node-content-wrapper')
      if (!w) return
      out.total++
      const mk = w.querySelectorAll('mark.db-tree-hit').length
      out.marks += mk
      if (/switcher-open/.test(String(tn.className))) out.expanded.push(window.__hash(window.__txt(w)))
      const db = w.querySelector('.db-tree-db-title')
      const gr = w.querySelector('.db-tree-schema')
      if (db) out.dbs.push(window.__hash(window.__txt(db)))
      else if (gr) out.groups++
      else if (String(w.innerText || '').trim()) {
        // 带形状图标的叶子（视图/过程…）：图标字形不算名字的一部分
        const ic = w.querySelector('.db-tree-obj-icon')
        const all = window.__txt(w)
        const nm = ic ? all.replace(window.__txt(ic), '') : all
        out.leaves.push(window.__hash(nm))
      } else out.unknown++
    })
    // 逐节点"该不该高亮"另由 __markRead / __dbRead 带 marks 取，这里只给集合
    return out
  }
  // 逐节点明细（__treeRead 压平成数组了，这里再取一次带 marks 的）
  window.__markRead = () => {
    const hitLeaves = []
    const plainLeaves = []
    const t = window.__tree()
    if (!t) return { hitLeaves, plainLeaves }
    ;[...t.querySelectorAll('.ant-tree-node-content-wrapper')].forEach(w => {
      if (window.__hidden(w)) return
      if (w.querySelector('.db-tree-db-title') || w.querySelector('.db-tree-schema')) return
      const ic = w.querySelector('.db-tree-obj-icon')
      const all = window.__txt(w)
      const nm = ic ? all.replace(window.__txt(ic), '') : all
      const m = w.querySelectorAll('mark.db-tree-hit')
      const rec = { h: window.__hash(nm), marks: m.length, frag: m.length ? window.__txt(m[0]).length : 0 }
      if (m.length) hitLeaves.push(rec); else plainLeaves.push(rec)
    })
    return { hitLeaves, plainLeaves }
  }
  window.__dbRead = () => {
    return [...document.querySelectorAll('.db-tree .db-tree-db-title')]
      .filter(el => !window.__hidden(el))
      .map(el => ({ h: window.__hash(window.__txt(el)), marks: el.querySelectorAll('mark.db-tree-hit').length }))
  }
  window.__groupRead = () => {
    return [...document.querySelectorAll('.db-tree .db-tree-schema')]
      .filter(el => !window.__hidden(el))
      .map(el => ({
        marks: el.querySelectorAll('mark.db-tree-hit').length,
        // 标题里是否混进拉丁字母：命中 token 是英文，界面应只显示中文标签 + 计数
        ascii: /[A-Za-z]/.test(window.__txt(el))
      }))
  }
  window.__emptyState = () => {
    const e = [...document.querySelectorAll('.db-tree-panel .ant-empty')].filter(x => !window.__hidden(x))[0]
    if (!e) return null
    const btn = [...e.querySelectorAll('button')].filter(x => !window.__hidden(x))[0]
    let xy = null
    if (btn) {
      const r = btn.getBoundingClientRect()
      if (r.width > 0) xy = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return {
      desc: String((e.querySelector('.ant-empty-description') || {}).innerText || '').trim(),
      btn: btn ? window.__txt(btn) : null,
      xy
    }
  }
  window.__clickLeaf = name => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    const nodes = [...t.querySelectorAll('.ant-tree-node-content-wrapper')].filter(w => !window.__hidden(w))
    for (const w of nodes) {
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
  // 手动展开某个库节点（"还原展开态"那条判据的前置）
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
  // 数据页：标题带表名 + 参照列名在场（列头里还混着注释与提示，所以只比"包含"）。
  // 页面上同时挂着数据页网格与 SQL 结果外壳两张 .db-grid-table，后者常驻 0 高、
  // 只有 1 个空表头 —— 取第一张会拿到它（第一轮就是这样把 K1 读成"表没列"），
  // 所以要按"真渲染出表头且容器有高度"筛。
  window.__gridCheck = arg => {
    const gridOf = () => {
      const cands = [...document.querySelectorAll('.db-grid-table')]
        .filter(el => !window.__hidden(el) && el.getBoundingClientRect().height > 0)
      for (const el of cands) {
        if (el.querySelectorAll('thead th').length > 1) return el
      }
      return cands[0] || null
    }
    const title = [...document.querySelectorAll('.db-grid-title')].filter(x => !window.__hidden(x))[0]
    const t = gridOf()
    if (!title || !t) return { ok: 0, reason: title ? 'no-grid' : 'no-title' }
    const heads = [...t.querySelectorAll('thead th')].filter(x => !window.__hidden(x)).map(window.__txt)
    const miss = arg.cols.filter(c => !heads.some(h => h.indexOf(c) >= 0)).length
    const rows = [...t.querySelectorAll('.ant-table-row')].filter(x => !window.__hidden(x)).length
    return {
      ok: 1,
      titleHasName: String(title.innerText || '').indexOf(arg.name) >= 0,
      titleLen: String(title.innerText || '').replace(/\\s+/g, '').length,
      cols: arg.cols.length,
      miss,
      heads: heads.length,
      rows
    }
  }
  window.__hitColor = () => {
    const m = [...document.querySelectorAll('.db-tree mark.db-tree-hit')].filter(x => !window.__hidden(x))[0]
    return m ? String(getComputedStyle(m).color) : null
  }
  // ops 监听：只记不替换实现，退出还原
  window.__ops = []
  window.__spyOps = () => {
    if (window.__opsSpied) return 'already'
    const orig = window.pre && window.pre.runGlobalAsync
    if (typeof orig !== 'function') return 'no-runGlobalAsync'
    const wrapped = function (name) {
      if (name === 'dbClientOp') window.__ops.push(String(arguments[2]))
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
const cfg0 = { theme: null, hideSys: null }
const openedTabs = []

const restoreAll = async () => {
  if (!cdpRef) return
  try {
    for (const id of openedTabs) {
      await cdpRef.eval('(async () => { await window.store.delTab(' + J(id) + ') })()')
    }
    if (cfg0.theme) await cdpRef.eval('window.store.setTheme(' + J(cfg0.theme) + ')')
    if (cfg0.hideSys === 'true' || cfg0.hideSys === 'false') {
      await cdpRef.eval('window.store.setConfig({dbHideSystemSchemas:' +
        (cfg0.hideSys === 'true' ? 'true' : 'false') + '})')
    }
    const r = await cdpRef.eval('window.__restoreOps()')
    console.log('restored: ops=' + r + ' tabs=' + openedTabs.length + ' theme=' + cfg0.theme +
      ' hideSystemSchemas=' + cfg0.hideSys)
  } catch (e) {
    console.log('restore failed（ops 监听 / 主题 / 隐藏系统库 / 页签需手工确认）: ' + e.message)
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

const sameSet = (a, b) => {
  const x = srt(a || [])
  const y = srt(b || [])
  return x.length === y.length && x.every((v, i) => v === y[i])
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
  // 泄密判定要放过"口令恰好等于某个键名"这种写法：值作为独立 token 出现、后面不紧接冒号才算泄密；
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
  // 生产元数据也不许进这份会入库的源码：目标库名之外不出现任何真表名（本库表名都以库名前缀开头）
  const noBusinessName = !/tgfsom_[a-z0-9_]+/i.test(src)
  check(L.R1, missing.length === 0 && passGiven && !hasSecret &&
    caught === leakForms.length && keyNameOk === false && noBusinessName,
  { missing, passGiven, hasSecret, caught, keyNameOk, noBusinessName })
  let gReject = 0
  const gRejectBad = []
  for (const bad of ['DELETE FROM t WHERE id=1', 'SELECT 1; DROP TABLE t', 'UPDATE t SET a=1',
    'INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD c INT', 'CALL some_proc()']) {
    try {
      assertReadOnly(bad)
      gRejectBad.push(bad.slice(0, 10))
    } catch (e) {
      gReject++
    }
  }
  let gAccept = 0
  const gateBad = []
  for (const good of [SQL_SCHEMAS, SQL_TABLES, SQL_ROUTINES, SQL_TRIGGERS, SQL_EVENTS, sqlCount('s', 't')]) {
    try {
      assertReadOnly(good)
      gAccept++
    } catch (e) {
      gateBad.push(String(e.message).slice(0, 40))
    }
  }
  // 拼标识符这条自己的护栏：反引号 / 分号 / 空格一律进不了 sqlCount（拦在拼语句之前）
  let identReject = 0
  const identBad = []
  for (const evil of ['t`', 't; DROP', 't x', 't--', 't\\`']) {
    try {
      sqlCount('s', evil)
      identBad.push(evil.slice(0, 10))
    } catch (e) {
      identReject++
    }
  }
  check(L.R2, gReject === 6 && gAccept === 6 && gRejectBad.length === 0 && gateBad.length === 0 &&
    identReject === 5 && identBad.length === 0,
  { gReject, gAccept, leakedThrough: gRejectBad, gateBad, identReject, identBad })
  if (missing.length || !passGiven || hasSecret || caught !== leakForms.length || keyNameOk ||
    !noBusinessName || gReject !== 6 || gAccept !== 6 || identReject !== 5) {
    skipAll('凭据/护栏不成立，整批跳过（不发任何真库请求）')
    return finish()
  }

  // ---------- 参照森林（node 直连，先于界面） ----------
  let forest
  let refSchemaNames = []
  let targetTable = null
  let targetCols = []
  let targetRows = 0
  try {
    const [schemas, tables, routines, triggers, events] = await Promise.all([
      q(SQL_SCHEMAS), q(SQL_TABLES), q(SQL_ROUTINES), q(SQL_TRIGGERS), q(SQL_EVENTS)
    ])
    refSchemaNames = schemas.map(r => String(Object.values(r)[0]))
    forest = buildForest(refSchemaNames, tables, routines, triggers, events)
    // 被点开的表：当前库里参照顺序中第一个「名字命中 B 关键词、真有行、真有列」的对象。
    // 表名由参照现选（本文件只有关键词片段，没有任何生产表名）。
    // 为什么要求有行：第一轮实测点中的是一张 0 行 0 列的 MariaDB 序列，数据页只有
    // 一个空表头，"点开表看到那张表"这条判据就无从可验。
    const cand = (tables || [])
      .filter(r => String(r.sc) === ENV.db && String(r.nm).toLowerCase().indexOf(KW_B) >= 0)
      .map(r => String(r.nm))
    for (const nm of cand) {
      const cnt = await q(sqlCount(ENV.db, nm))
      const n = Number((cnt[0] || {}).n)
      if (!(n > 0)) {
        continue
      }
      const cs = (await q(SQL_COLUMNS, [ENV.db, nm])).map(c => String(c.nm))
      if (!cs.length) {
        continue
      }
      targetTable = nm
      targetCols = cs
      targetRows = n
      break
    }
  } catch (e) {
    check(L.C1, false, { refError: String(e.message).slice(0, 120) })
    skipAll('真库参照取不到：' + String(e.message).slice(0, 80))
    return finish()
  }
  const refTotal = countNodes(forest)
  const refGroups = forest.reduce((n, d) => n + (d.children || []).filter(c => c.kind === 'group').length, 0)
  console.log('参照: schemas=' + refSchemaNames.length + ' nodes=' + refTotal + ' groups=' + refGroups +
    ' 目标表列数=' + targetCols.length + ' 目标表行数(COUNT聚合)=' + targetRows)

  // 关键词与期望全部由参照算出；每支先自证"有区分度"——既不是 0 也不是全量，
  // 否则判据真空通过（全量命中等于没过滤，零命中只剩空态）。
  const KW = {
    B: KW_B,
    Ul: 'task',
    Uu: 'TASK',
    Us: '  task  ',
    N: 'variables',
    D: 'perf',
    G: 'routine',
    E: 'zzqx_no_such_object_at_all'
  }
  const EXP = {}
  for (const k of Object.keys(KW)) EXP[k] = expectOf(forest, normKw(KW[k]))
  const weak = [
    [KW_B + ' 当前库叶子命中', EXP.B.total > 1 && EXP.B.total < refTotal],
    ['非当前库叶子命中', EXP.N.total > 1 && EXP.N.total < refTotal],
    ['库名命中整树', EXP.D.total > 1 && EXP.D.total < refTotal],
    ['分组 token 命中', EXP.G.total >= 2 && EXP.G.total < refTotal && EXP.G.groups > 0],
    ['零命中', EXP.E.total === 0],
    ['大小写两支都有样本', EXP.Ul.total > 1 && EXP.Ul.markLeaves.length > 0]
  ].filter(x => !x[1]).map(x => x[0])

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
  // 同实例可能跑过假库演示（接管 runGlobalAsync 不还原）→ 先重载再开真库页签
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
  const probeOk = await cdp.eval('JSON.stringify(["__setFilter","__chip","__treeRead","__markRead","__groupRead","__emptyState","__clickLeaf","__gridCheck","__toggleDb"].map(n => typeof window[n]).join(","))')
  const spy = await cdp.eval('window.__spyOps()')
  check(L.P0, stub === 'ok' && spy === 'ok' &&
    String(probeOk) === J(['function', 'function', 'function', 'function', 'function', 'function', 'function', 'function', 'function'].join(',')),
  { stub, spy, probeOk })

  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  // 口径先钉住：隐藏系统库为真时 getMetadata 少 3~4 个库，参照与界面不同源，
  // "非当前库命中""分组 token 命中"两支也直接没样本 —— 见文件头「口径先钉死再看效果」
  cfg0.hideSys = await cdp.eval('String((window.store._config || {}).dbHideSystemSchemas)')
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
    '!!window.__tree() || !!window.__one(".db-session-error")', 'tree or conn error', 60000)
  const al = await cdp.jeval('window.__alerts()')
  check(L.C1, treeShown && !(al.connErr || []).length, { treeShown, err: (al.connErr || [])[0] || '' })
  if (!treeShown || (al.connErr || []).length) {
    skipAll('真库连接没起来：后续判据跳过')
    return finish()
  }
  const roTab = await cdp.eval(
    '(() => { const t = (window.store.tabs || []).find(x => String(x.title) === ' + J(TAB_TITLE) +
    '); return t && t.readOnly === true ? 1 : 0 })()')
  check(L.C2, Number(roTab) === 1, { roTab: Number(roTab) })
  const hideNow = await cdp.eval('String((window.store._config || {}).dbHideSystemSchemas)')
  check(L.C0, hideNow === 'false', { hideNow })

  // 等元数据到手：树根出现参照里的全部库节点
  const rootOk = await waitFor(cdp,
    'window.__treeRead().dbs.length >= ' + refSchemaNames.length, 'tree root schemas', 60000)
  const base = await cdp.jeval('JSON.stringify(window.__treeRead())')
  check(L.C3, rootOk && sameSet(base.dbs, refSchemaNames.map(djb2)),
    { rootOk, dom: (base.dbs || []).length, ref: refSchemaNames.length })
  if (!(base.dbs || []).length) {
    skipAll('树根没有库节点：过滤判据没有意义')
    return finish()
  }
  const chip0 = await cdp.eval('window.__chip()')
  check(L.C4, chip0 === null && (await cdp.eval('window.__filterValue()')) === '', { chip0 })
  check(L.C5, base.total === (base.dbs || []).length && base.leaves.length === 0 &&
    base.groups === 0 && base.expanded.length === 0,
  {
    total: base.total,
    dbs: (base.dbs || []).length,
    leaves: base.leaves.length,
    groups: base.groups,
    expanded: base.expanded.length
  })
  const opsAfterOpen = (await cdp.jeval('JSON.stringify(window.__ops || [])')).length
  const mdAfterOpen = (await cdp.jeval('JSON.stringify(window.__ops || [])')).filter(o => o === 'getMetadata').length
  const covered = []

  const runCase = async kw => {
    const st = await cdp.eval('window.__setFilter(' + J(kw) + ')')
    if (st !== 'ok') return { err: st }
    // 过滤没有防抖，但 React 提交 + antd Tree 重排要给一帧
    await sleep(500)
    return {
      chip: await cdp.eval('window.__chip()'),
      read: await cdp.jeval('JSON.stringify(window.__treeRead())'),
      marks: await cdp.jeval('JSON.stringify(window.__markRead())'),
      dbs: await cdp.jeval('JSON.stringify(window.__dbRead())'),
      groups: await cdp.jeval('JSON.stringify(window.__groupRead())')
    }
  }

  // ---------- 逐关键词：计数条 / 集合 / 高亮 ----------
  const B = await runCase(KW.B)
  check(L.B1, B.chip === EXP.B.total && B.read.total === EXP.B.total,
    { chip: B.chip, dom: B.read.total, ref: EXP.B.total })
  covered.push(['当前库叶子命中', B.chip === EXP.B.total && EXP.B.total > 1 && EXP.B.total < refTotal])
  check(L.B2, sameSet(B.read.leaves, EXP.B.leaves) && sameSet(B.read.dbs, EXP.B.dbs) &&
    B.read.groups === EXP.B.groups && B.read.unknown === 0,
  {
    domLeaves: B.read.leaves.length,
    refLeaves: EXP.B.leaves.length,
    domDbs: B.read.dbs.length,
    refDbs: EXP.B.dbs.length,
    domGroups: B.read.groups,
    refGroups: EXP.B.groups,
    unknown: B.read.unknown
  })
  check(L.B3, sameSet(B.marks.hitLeaves.map(x => x.h), EXP.B.markLeaves) &&
    B.marks.plainLeaves.length === 0 &&
    B.marks.hitLeaves.every(x => x.marks >= 1 && x.frag === normKw(KW.B).length),
  {
    hit: B.marks.hitLeaves.length,
    plain: B.marks.plainLeaves.length,
    ref: EXP.B.markLeaves.length,
    fragBad: B.marks.hitLeaves.filter(x => x.frag !== normKw(KW.B).length).length
  })
  // 只留目标库那一条分支：别的库节点整个不在，库节点自身没命中所以不高亮
  check(L.B4, B.read.dbs.length === 1 && B.read.dbs[0] === djb2(ENV.db) &&
    B.dbs.every(x => x.marks === 0),
  { dbs: B.read.dbs.length, isTarget: B.read.dbs[0] === djb2(ENV.db), dbMarked: B.dbs.filter(x => x.marks > 0).length })

  const Ul = await runCase(KW.Ul)
  const Uu = await runCase(KW.Uu)
  const Us = await runCase(KW.Us)
  check(L.U1, Ul.chip === Uu.chip && Ul.chip === EXP.Ul.total && Ul.chip > 1 &&
    sameSet(Ul.read.leaves, Uu.read.leaves) && Ul.read.marks === Uu.read.marks,
  {
    lower: Ul.chip,
    upper: Uu.chip,
    ref: EXP.Ul.total,
    leavesSame: sameSet(Ul.read.leaves, Uu.read.leaves),
    marksLow: Ul.read.marks,
    marksUp: Uu.read.marks
  })
  covered.push(['大小写不敏感', Ul.chip === Uu.chip && Ul.chip > 1])
  check(L.U2, Us.chip === Ul.chip && sameSet(Us.read.leaves, Ul.read.leaves) &&
    (await cdp.eval('window.__filterValue()')) === KW.Us,
  { spaced: Us.chip, plain: Ul.chip, valueLen: String(await cdp.eval('window.__filterValue()')).length })
  covered.push(['前后空格', Us.chip === Ul.chip])

  const N = await runCase(KW.N)
  check(L.N1, N.chip === EXP.N.total && N.read.total === EXP.N.total && N.read.dbs.length === 1 &&
    N.read.dbs[0] !== djb2(ENV.db),
  {
    chip: N.chip,
    dom: N.read.total,
    ref: EXP.N.total,
    dbs: N.read.dbs.length,
    isTarget: N.read.dbs[0] === djb2(ENV.db)
  })
  check(L.N2, sameSet(N.read.leaves, EXP.N.leaves) && sameSet(N.dbs.map(x => x.h), EXP.N.dbs),
    { dom: N.read.leaves.length, ref: EXP.N.leaves.length })
  covered.push(['非当前库叶子命中', N.chip === EXP.N.total && N.read.dbs.length === 1])

  const D = await runCase(KW.D)
  check(L.D1, D.chip === EXP.D.total && D.read.total === EXP.D.total &&
    sameSet(D.read.leaves, EXP.D.leaves) && D.read.groups === EXP.D.groups,
  {
    chip: D.chip,
    dom: D.read.total,
    ref: EXP.D.total,
    leaves: D.read.leaves.length,
    refLeaves: EXP.D.leaves.length,
    groups: D.read.groups
  })
  // 父命中连带保留：被保留下来的子节点自身没命中 → 不该有高亮；命中的库节点自己该有高亮
  const carried = D.marks.plainLeaves.length
  check(L.D2, sameSet(D.marks.hitLeaves.map(x => x.h), EXP.D.markLeaves) && carried > 0 &&
    sameSet(D.dbs.filter(x => x.marks > 0).map(x => x.h), EXP.D.markDbs),
  {
    carried,
    selfHit: D.marks.hitLeaves.length,
    refHit: EXP.D.markLeaves.length,
    dbMarked: D.dbs.filter(x => x.marks > 0).length,
    refDbMarked: EXP.D.markDbs.length
  })
  covered.push(['库名命中保留整树', D.chip === EXP.D.total && carried > 0])

  const G = await runCase(KW.G)
  // 这一支就是第一轮撞出缺陷的地方：计数条按"分组命中 → 整棵子树"算 6 个节点，
  // 但分组没被自动展开，DOM 里只画得出 4 个。展开键修好后两者必须相等。
  check(L.G1, G.chip === EXP.G.total && G.read.total === EXP.G.total &&
    G.read.groups === EXP.G.groups && G.read.groups > 0 &&
    sameSet(G.read.leaves, EXP.G.leaves),
  {
    chip: G.chip,
    domTotal: G.read.total,
    ref: EXP.G.total,
    groups: G.read.groups,
    refGroups: EXP.G.groups,
    leaves: G.read.leaves.length,
    refLeaves: EXP.G.leaves.length
  })
  check(L.G2, G.groups.length > 0 && G.groups.every(x => x.marks === 0 && x.ascii === false),
    {
      groups: G.groups.length,
      marked: G.groups.filter(x => x.marks > 0).length,
      asciiLeak: G.groups.filter(x => x.ascii).length
    })
  covered.push(['分组 token 命中', G.read.groups > 0 && G.chip === EXP.G.total &&
    G.read.total === EXP.G.total])

  const Ex = await runCase(KW.E)
  const es = await cdp.jeval('JSON.stringify(window.__emptyState())')
  const descOk = !!es && /^(没有匹配的库或表|No matching database or table)$/.test(es.desc)
  const btnOk = !!es && /^(清除筛选|Clearfilter)$/.test(String(es.btn))
  check(L.E1, Ex.chip === 0 && Ex.read.total === 0 && descOk && btnOk && !!es.xy,
    { chip: Ex.chip, dom: Ex.read.total, desc: es && es.desc, btn: es && es.btn, xy: !!(es && es.xy) })
  covered.push(['零命中空态', Ex.chip === 0 && descOk && btnOk])

  // ---------- 清除与还原 ----------
  await cdp.click(es.xy.x, es.xy.y)
  await sleep(700)
  const afterBtn = await cdp.jeval('JSON.stringify(window.__treeRead())')
  check(L.E2, (await cdp.eval('window.__filterValue()')) === '' &&
    (await cdp.eval('window.__chip()')) === null &&
    afterBtn.total === base.total && afterBtn.dbs.length === base.dbs.length,
  {
    value: await cdp.eval('window.__filterValue()'),
    chip: await cdp.eval('window.__chip()'),
    total: afterBtn.total,
    base: base.total
  })

  const tg = await cdp.eval('window.__toggleDb(' + J(ENV.db) + ')')
  await sleep(600)
  const beforeExp = await cdp.jeval('JSON.stringify(window.__treeRead().expanded)')
  await cdp.eval('window.__setFilter(' + J(KW.B) + ')')
  await sleep(600)
  await cdp.eval('window.__setFilter("")')
  await sleep(800)
  const afterExp = await cdp.jeval('JSON.stringify(window.__treeRead().expanded)')
  check(L.X2, tg === 'ok' && beforeExp.length === 1 && sameSet(beforeExp, afterExp),
    { tg, before: beforeExp.length, after: afterExp.length })

  await cdp.eval('window.__setFilter(' + J(KW.B) + ')')
  await sleep(600)
  const xy = await cdp.jeval('JSON.stringify(window.__clearXY())')
  let xValue = 'no-icon'
  if (xy && xy.x) {
    await cdp.click(xy.x, xy.y)
    await sleep(500)
    xValue = await cdp.eval('window.__filterValue()')
  }
  check(L.X1, !!xy && !!xy.x && xValue === '' && (await cdp.eval('window.__chip()')) === null,
    { hasIcon: !!(xy && xy.x), valueAfterX: xValue, chip: await cdp.eval('window.__chip()') })

  // ---------- 过滤态下点开命中的表 ----------
  const opsBeforeOpen = (await cdp.jeval('JSON.stringify(window.__ops || [])')).length
  const setOk = targetTable ? await cdp.eval('window.__setFilter(' + J(KW.B) + ')') : 'no-candidate'
  await sleep(700)
  const click = targetTable ? await cdp.eval('window.__clickLeaf(' + J(targetTable) + ')') : 'skip'
  // 数据页要等列清单 + 首页数据两趟往返：waitFor 只看得到"网格容器在场"（旧轮就是这样
  // 抢读到只有 1 个空表头的那一帧），所以要按"参照列名全部出现且真画出行"轮询到稳
  let gc = { ok: 0, reason: 'no-try' }
  for (let i = 0; i < 30; i++) {
    await sleep(700)
    gc = await cdp.jeval('JSON.stringify(window.__gridCheck(' +
      J({ name: targetTable || '', cols: targetCols }) + '))')
    if (gc.ok === 1 && gc.titleHasName && gc.miss === 0 && gc.rows > 0) break
  }
  check(L.K1, setOk === 'ok' && click === 'ok' && gc.ok === 1 && gc.titleHasName &&
    gc.miss === 0 && gc.cols > 0 && gc.heads >= gc.cols && gc.rows > 0,
  { setOk, click, gc, refRows: targetRows })
  const opsOpen = await cdp.jeval('JSON.stringify((window.__ops || []).slice(' + opsBeforeOpen + '))')
  const badOpen = opsOpen.filter(o => /executeSql|updateCell|insertRow|deleteRows|applyChanges|getObjectDdl/i.test(o))
  check(L.K2, badOpen.length === 0 && opsOpen.includes('getPageData'), { ops: [...new Set(opsOpen)], badOpen })

  // ---------- ops 口径 ----------
  const opsAll = await cdp.jeval('JSON.stringify(window.__ops || [])')
  const mdNow = opsAll.filter(o => o === 'getMetadata').length
  check(L.O1, mdNow === mdAfterOpen && opsAll.length > opsAfterOpen,
    { mdAfterOpen, mdNow, opsTotal: opsAll.length })
  const badAll = [...new Set(opsAll)].filter(o =>
    /executeSql|updateCell|insertRow|deleteRows|applyChanges|getObjectDdl|dropTable|createIndex/i.test(o))
  check(L.O2, badAll.length === 0, { badAll, ops: [...new Set(opsAll)] })

  // ---------- 覆盖面 ----------
  const covBad = covered.filter(x => !x[1]).map(x => x[0])
  check(L.M1, covBad.length === 0 && weak.length === 0, { covBad, weakSamples: weak })

  // ---------- 双主题 ----------
  await cdp.eval('window.__setFilter(' + J(KW.D) + ')')
  await sleep(700)
  const darkColor = await cdp.eval('window.__hitColor()')
  await cdp.shot(path.join(SHOT_DIR, '1-filter-dark.png'))
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1300)
    const lightColor = await cdp.eval('window.__hitColor()')
    await cdp.shot(path.join(SHOT_DIR, '2-filter-light.png'))
    await cdp.eval('window.store.setTheme(' + J(cfg0.theme) + ')')
    await sleep(900)
    check(L.T1, !!darkColor && !!lightColor && darkColor !== lightColor,
      { darkColor, lightColor })
  } else {
    check(L.T1, false, { themeIds })
  }
  await cdp.eval('window.__setFilter("")')
  await sleep(400)
  const restoredTheme = await cdp.eval('String((window.store._config || {}).theme)')
  // 开关本应只在 restoreAll 里还原；这里先确认整轮没把它撞变形（还是钉住的那个 false）
  const hideEnd = await cdp.eval('String((window.store._config || {}).dbHideSystemSchemas)')
  const opsRestored = await cdp.eval('window.__restoreOps()')
  check(L.Z1, opsRestored === 'restored' && restoredTheme === cfg0.theme && hideEnd === 'false',
    { opsRestored, restoredTheme, want: cfg0.theme, hideEnd })

  console.log('shots → ' + SHOT_DIR)
  console.log('隐私纪律: 判据只出计数/长度/布尔/djb2；除一次 COUNT(*) 聚合外零行数据读取，源码里没有生产表名')
  console.log('参照期望: hsm=' + EXP.B.total + ' task=' + EXP.Ul.total + ' variables=' + EXP.N.total +
    ' perf=' + EXP.D.total + ' routine=' + EXP.G.total + ' 全量=' + refTotal)
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
