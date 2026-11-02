#!/usr/bin/env node
/**
 * 外键分支真引擎实测 —— 拿一个真带外键的 SQLite 库，把"库里没有外键就永远走不到"的
 * 分支跑到有实证为止（ER 图 / 数据字典外键节 / 结构对比外键差异 / 关联侧栏）
 *
 * 为什么要另起一个夹具，而不是继续打真 MySQL：
 *   真库那台 MariaDB（`tgfsom`，69 张基表）全库 0 外键，生产库又禁止 DDL ——
 *   于是数据字典的"外键节"、结构对比的"外键差异"、ER 图的真取数、关联侧栏
 *   这四条靠外键才有意义的分支，此前只有单测与桩证据
 *   （结构对比真库脚本自己就写了"只钉得住没有外键时不外键节这一半"）。
 *   真外键只能本机造：文件在 os.tmpdir() 下，数据全是本机假名字（alpha/bravo），
 *   不含凭据不含业务内容，截图可进仓库。
 *
 * 这一版跑到的分支：ER 图（节点/边/详情/主题）+ 数据字典的外键节（Markdown/CSV）。
 * 结构对比的外键差异、关联侧栏另起脚本段跑，不在这里充数。
 *
 * 三层对账（防"自己对自己"）：
 *   1 我声明了什么：self-test/db-fk-fixture.js 的 DECLARED（按 DDL 字面）；
 *   2 引擎说了什么：宿主侧自己解析 PRAGMA foreign_key_list 的原始行；
 *   3 界面说了什么：产品经自己的适配器 + IPC + 渲染层给出的读数。
 *   界面判据一律对 1（约束名除外：SQLite 的 DDL 根本没有名字可写，
 *   名字只能取 2 的 id）；2 只用来钉"夹具本身就是我以为的形状"。
 *   本脚本不 require 产品的 sqlite.js，否则"一致"是同义反复。
 *
 * 用法：
 *   1) 改了主进程才需要 npm run vite-build && rsync -a src/app/ work/app/ 并重启实例
 *   2) DISPLAY=:130 HOME=/tmp/electerm-h8a/home TMPDIR=/tmp/electerm-h8a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-fk-sqlite-realdb.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  getJson, Cdp, sleep, waitFor, makeChecker, findPageTarget, clearDbTabs, preStubState
} = require('./db-ui-helpers')
const fk = require('./db-fk-fixture')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-fk-sqlite-shots')
const TAB_TITLE = 'fk-sqlite'
const { check, skip, results } = makeChecker()
const J = s => JSON.stringify(s)

const CDP_URL = 'http://127.0.0.1:' + PORT + '/json/list'

// ── 页内探针 ────────────────────────────────────────────────────────
// 可见性一律带命中测试：侧栏被裁掉、弹层遮罩还在淡出时 display 仍是 block，
// 只看样式会把点不到的节点当成可见（H8a-c 实测过一次）。
const PROBE = `(() => {
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
    if (window.__hidden(el)) return false
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  // SVG 的 <text> 没有 innerText（那是 HTMLElement 的属性），只读它会拿到空串：
  // ER 图上的表名/副标题一律走 textContent 兜底
  window.__txt = el => (el ? String(el.innerText || el.textContent || '').trim() : null)

  window.__headTarget = () => window.__txt([...document.querySelectorAll('.db-head-target')]
    .filter(window.__vis)[0])
  window.__treeTitles = () => [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .filter(window.__vis).map(t => window.__txt(t))
  window.__collapsedXY = () => {
    const el = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__treeXY = name => {
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__txt(n) === name)
    for (const el of all) {
      // 节点被虚拟滚动移出视口时命中测试判"不可见"，真人会先滚过去
      el.scrollIntoView({ block: 'center' })
      if (window.__vis(el)) return window.__xy(el)
    }
    return null
  }
  // 会话主区的 数据 / 结构 / SQL（自绘 antd Tabs，不是外层文档页签）
  window.__segXY = label => {
    const el = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')]
      .filter(window.__vis).find(x => String(x.innerText).replace(/\\s/g, '').indexOf(label) >= 0)
    return el ? window.__xy(el) : null
  }
  window.__structBtnXY = re => {
    const src = new RegExp(re, 'i')
    const tools = [...document.querySelectorAll('.db-struct-tools')].filter(window.__vis)[0]
    if (!tools) return null
    const b = [...tools.querySelectorAll('button')].filter(window.__vis)
      .find(x => src.test(String(x.innerText || '').replace(/\\s/g, '')))
    return b ? window.__xy(b) : null
  }
  window.__structBtnTexts = () => {
    const tools = [...document.querySelectorAll('.db-struct-tools')].filter(window.__vis)[0]
    return tools ? [...tools.querySelectorAll('button')].map(b => window.__txt(b)) : []
  }
  window.__readonlyChip = () => {
    const el = [...document.querySelectorAll('.db-sql-status-readonly')].filter(window.__vis)[0]
    return el ? window.__txt(el) : null
  }

  // —— ER 图 ——
  window.__erRoot = () => [...document.querySelectorAll('.db-er')].filter(window.__vis)[0] || null
  window.__erAll = sel => {
    const r = window.__erRoot()
    return r ? [...r.querySelectorAll(sel)].filter(window.__vis) : []
  }
  window.__erNodes = () => window.__erAll('.db-er-node')
  window.__erNames = () => window.__erNodes().map(g => window.__txt(g.querySelector('.db-er-node-name')))
  window.__erNode = name => window.__erNodes()
    .find(g => window.__txt(g.querySelector('.db-er-node-name')) === name) || null
  window.__erNodeXY = name => {
    const g = window.__erNode(name)
    if (!g) return null
    return window.__xy(g.querySelector('rect') || g)
  }
  window.__erNodeSub = name => {
    const g = window.__erNode(name)
    return g ? window.__txt(g.querySelector('.db-er-node-sub')) : null
  }
  // 边的计数不过可见性筛：父子同列时那条三次贝塞尔是竖直的，
  // 起止 x 相同 → 包围盒宽为 0 → __vis 会把它当成"不可见"，
  // 于是 11 条边只数到 7 条。数的是"渲染了几条边"，DOM 计数就是事实。
  window.__erEdgePaths = () => {
    const r = window.__erRoot()
    return r ? [...r.querySelectorAll('.db-er-edge path')].map(p => String(p.getAttribute('d') || '')) : []
  }
  window.__erEdgeCount = () => window.__erEdgePaths().length
  // 自引用那条边是"绕回来"的路径：起终点几乎重合。直线边起止分处两个节点。
  window.__erSelfLoops = () => window.__erEdgePaths()
    .filter(d => {
      const n = d.match(/-?\\d+(?:\\.\\d+)?/g)
      if (!n || n.length < 8) return false
      const x1 = +n[0]; const y1 = +n[1]
      const x2 = +n[n.length - 2]; const y2 = +n[n.length - 1]
      return Math.abs(x1 - x2) < 3 && Math.abs(y1 - y2) < 12
    }).length
  window.__erDetail = () => {
    const r = window.__erRoot()
    const d = r && r.querySelector('.db-er-detail')
    if (!d || window.__hidden(d)) return null
    return {
      title: window.__txt(d.querySelector('.db-er-detail-title')),
      subs: [...d.querySelectorAll('.db-er-detail-sub')].map(s => window.__txt(s)),
      rows: [...d.querySelectorAll('.db-er-detail-list li')].map(li => {
        const cols = li.querySelectorAll('.db-er-detail-col')
        return {
          fk: window.__txt(li.querySelector('.db-er-detail-fk')),
          cols: window.__txt(cols[0]),
          sep: window.__txt(li.querySelector('.db-er-detail-sep')),
          ref: window.__txt(cols[1])
        }
      }),
      openTable: [...d.querySelectorAll('button')].some(b => /打开表|Open\\s*table/i.test(b.innerText))
    }
  }
  window.__erNotes = () => window.__erAll('.db-er-note').map(n => window.__txt(n))
  // 节点名的取色：SVG 的 <text> 用 fill（color 是继承来的，读它看不出主题差异）
  window.__erNameFill = () => {
    const n = document.querySelector('.db-er-node-name')
    if (!n) return null
    const s = getComputedStyle(n)
    return String(s.fill || s.color || '')
  }
  window.__erErr = () => {
    const a = window.__erAll('.db-er-err')[0]
    return a ? window.__txt(a) : null
  }
  window.__erInputs = () => {
    const r = window.__erRoot()
    return r ? [...r.querySelectorAll('input, textarea, select')].filter(window.__vis).length : 0
  }
  window.__erFooterXY = re => {
    const m = document.querySelector('.db-er-modal')
    if (!m) return null
    const src = new RegExp(re, 'i')
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .find(x => src.test(String(x.innerText || '').replace(/\\s/g, '')))
    return b ? window.__xy(b) : null
  }
  window.__erOpen = () => !!window.__erRoot()

  // —— 数据字典导出：下载拦在 createObjectURL + a.click 这一层 ——
  // 真点会弹系统保存框（无头实例卡死），拦下来还能把文本原样读回比对
  window.__dlCapture = () => {
    if (window.__dlInstalled) return 'already'
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
              name: this.download, type: b.type, text: t,
              bytes: Array.from(new Uint8Array(buf).slice(0, 3))
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
      .find(b => /导出数据字典|Export dictionary/i.test(b.innerText))
    if (!btn) return 'no-btn'
    btn.click()
    return 'ok'
  }
  window.__dictMenu = () => [...document.querySelectorAll('.ant-dropdown-menu-item')]
    .filter(window.__vis).map(i => window.__txt(i))
  window.__dictPick = label => {
    const it = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .filter(window.__vis).find(i => window.__txt(i) === label)
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  return 'probe-ok'
})()`

// 桥接监听：只记录 op 名，不改行为；跑完必须还原（桩残留过一次让两个脚本互相污染）。
// 记的是"真 DB 动作名"：库操作一律走 runGlobalAsync('dbClientOp', tabId, op, args)，
// 直接记首参只会看到一串 dbClientOp，写命令混进去也数不出来。
const SPY = `(() => {
  if (window.__fkSpyInstalled) return 'already'
  if (!window.__fkPrePristine) window.__fkPrePristine = { runGlobalAsync: window.pre.runGlobalAsync }
  window.__ops = []
  window.__fkCalls = 0
  const orig = window.pre.runGlobalAsync
  window.pre.runGlobalAsync = function (kind) {
    const op = kind === 'dbClientOp' ? String(arguments[2]) : String(kind)
    window.__ops.push(op)
    if (op === 'listForeignKeys') window.__fkCalls++
    return orig.apply(this, arguments)
  }
  window.__fkSpyInstalled = true
  return 'installed'
})()`

const RESTORE = `(() => {
  const p = window.__fkPrePristine
  if (!p) return 'nothing-to-restore'
  window.pre.runGlobalAsync = p.runGlobalAsync
  window.__fkSpyInstalled = false
  return 'restored'
})()`

// 会改数据的 op：整轮里一次都不该出现（本批全是元数据读）
const WRITE_OPS = ['updateCell', 'insertRow', 'deleteRows', 'updateCells', 'executeSql',
  'setKey', 'delKey', 'delKeys', 'expireKey', 'hashSetField', 'hashDelField', 'setAdd',
  'setRem', 'zsetAdd', 'zsetRem', 'listPush', 'listSetAt', 'listRemAt', 'renameKeyNx']

let PRAGMA = null
// 主题只在这个脚本里换过一次（浅色截图），异常路径也要能换回去
let THEME_BEFORE = null
const expectedOf = name => fk.expectedForeignKeys(name, PRAGMA)

// 期望的详情行：与渲染层同一拼接口径（出边写 `子表.列`，引用端一律 `目标(列1, 列2)`）。
// 注意详情条列的是"与该节点相连的全部边"—— 出边 + 别人挂到它身上的入边，
// 所以不能只取该表自己声明的 DECLARED（父表的声明是空的，那样判父表等于判了个空集）。
// 数据字典那边只导本表声明的外键，且单列写成 table.col —— 两处口径不同，判据各按各的。
const nodeRows = (graph, name) => graph.edges
  .filter(e => e.from === name || e.to === name)
  .map(e => ({
    fk: e.name,
    cols: e.from + '.' + e.columns.map(c => c.from).join(', '),
    sep: '→',
    ref: e.to + '(' + e.columns.map(c => c.to).join(', ') + ')'
  }))
const degreeOf = (graph, name) => graph.edges.filter(e => e.from === name || e.to === name).length
const keyOfRow = r => [r.fk, r.cols, r.sep, r.ref].join('|')
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// —— 导出文本解析（node 侧，不借产品的模块）——
const mdSectionOf = (text, headingRe) => {
  const lines = String(text || '').split('\n')
  const i = lines.findIndex(l => headingRe.test(l))
  if (i < 0) return null
  const rows = []
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (/^##\s/.test(l)) break
    if (!l.trim()) continue
    if (!/^\|/.test(l)) continue
    if (/^[\s|:-]+$/.test(l)) continue
    rows.push(l.split('|').slice(1, -1).map(s => s.trim()))
  }
  return { heading: lines[i].trim(), head: rows[0] || [], body: rows.slice(1) }
}
const csvRow = line => {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { q = false }
      } else cur += c
    } else if (c === ',') { out.push(cur); cur = '' } else if (c === '"') q = true
    else cur += c
  }
  out.push(cur)
  return out
}
const csvSectionOf = (text, marker) => {
  const lines = String(text || '').replace(/^/, '').split('\r\n')
  const i = lines.findIndex(l => l.trim() === marker)
  if (i < 0) return null
  const body = []
  for (let j = i + 2; j < lines.length; j++) {
    const l = lines[j]
    if (!l.trim()) continue
    if (/^#/.test(l)) break
    body.push(csvRow(l))
  }
  return { head: csvRow(lines[i + 1] || ''), body }
}
// 字典里引用列的口径：单列 table.col，多列 table(a, b)（与 ER 详情条不同）
const dictExpect = table => expectedOf(table).map(e => [
  e.name,
  e.columns.join(', '),
  e.refColumns.length === 1 ? e.refTable + '.' + e.refColumns[0] : e.refTable + '(' + e.refColumns.join(', ') + ')',
  e.onDelete,
  e.onUpdate
])
const FK_MD_HEAD = ['外键名', '列', '引用', '删除动作', '更新动作']

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const targets = await getJson(CDP_URL)
  const page = findPageTarget(targets)
  if (!page) throw new Error('找不到 electerm 渲染进程目标（实例没起？）')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready

  // 鼠标常驻左下角：悬停态会改样式也会改命中测试，判据要的是"没悬停"的那一屏
  const park = async () => { await cdp.move(6, 6); await sleep(120) }
  const click = async (p, ms = 600) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
    await park()
  }

  // ── 0. 前置门：桥接必须是原装的 ────────────────────────────────────
  const gate = await preStubState(cdp)
  check('开跑前桥接是原装的（没有别的脚本留桩）', gate === 'ok', gate)
  if (gate !== 'ok') {
    console.log('整批不跑：桥接上有桩（' + gate + '），换顺序或先还原')
    process.exit(1)
  }

  // ── 1. 夹具自检：我声明的 == 引擎说的 ──────────────────────────────
  const built = fk.buildFixture()
  PRAGMA = built.pragma
  check('夹具落在临时目录，不在仓库里',
    built.file.startsWith(os.tmpdir()) && fs.existsSync(built.file), built.file)
  check('外键真的生效（违反引用的插入被拒，不是装饰）', built.enforced === true, built.enforced)

  const withFk = fk.TABLE_NAMES.filter(n => (fk.DECLARED[n] || []).length)
  check('夹具备齐 9 张带外键的表 + 2 张无外键对照表',
    withFk.length === 9 && fk.DECLARED.fk_none.length === 0 && fk.DECLARED.ord_c.length === 0,
    { withFk })

  const pragmaBad = []
  for (const t of withFk) {
    for (const want of expectedOf(t)) {
      const got = PRAGMA[t].find(g => g.columns.join(',') === want.columns.join(','))
      if (!got) {
        pragmaBad.push(t + ' 缺列集 ' + want.columns.join(','))
        continue
      }
      if (got.refTable !== want.refTable) pragmaBad.push(t + ' 引用表 ' + got.refTable)
      if (got.onDelete !== want.onDelete) pragmaBad.push(t + ' onDelete ' + got.onDelete)
      if (got.onUpdate !== want.onUpdate) pragmaBad.push(t + ' onUpdate ' + got.onUpdate)
      if (!got.refColumnsRaw.every(x => x === null) &&
        got.refColumnsRaw.join(',') !== want.refColumns.join(',')) {
        pragmaBad.push(t + ' refColumns ' + got.refColumnsRaw.join(','))
      }
    }
  }
  check('声明与 PRAGMA 逐条一致（引用表 / 列 / 两个动作）', pragmaBad.length === 0, pragmaBad.slice(0, 6))

  // 两条"引擎实况"先钉死，否则界面判据是在跟着想象比
  check('省略引用列时 PRAGMA 的 to 给 null（产品须回落到目标表主键）',
    PRAGMA.fk_implicit_cols[0].refColumnsRaw.every(x => x === null),
    PRAGMA.fk_implicit_cols[0].refColumnsRaw)
  check('省略 ON 子句时 PRAGMA 给 NO ACTION（不是空串）',
    PRAGMA.fk_defaults[0].onDelete === 'NO ACTION' && PRAGMA.fk_defaults[0].onUpdate === 'NO ACTION',
    { onDelete: PRAGMA.fk_defaults[0].onDelete, onUpdate: PRAGMA.fk_defaults[0].onUpdate })

  // 后面"结构对比外键节"的判据前提：PRAGMA 的 id 是声明顺序的倒序，
  // 于是外键集合完全相同的两张表，同一个合成名 fk_<id> 各自指向不同的外键。
  // 实测：two_fks 的 fk_0 = b→dim_second，two_fks_rev 的 fk_0 = a→dim_single。
  const twoA = expectedOf('two_fks')
  const twoB = expectedOf('two_fks_rev')
  const atName = (list, n) => {
    const x = list.find(e => e.name === n)
    return x ? x.columns + '→' + x.refTable : '缺'
  }
  check('同名约束指向不同外键：两张表外键集合相同，但 fk_0 / fk_1 的内容整体对调',
    sameSet(twoA.map(x => x.columns + x.refTable), twoB.map(x => x.columns + x.refTable)) &&
    ['fk_0', 'fk_1'].every(n => atName(twoA, n) !== atName(twoB, n)),
    {
      a: twoA.map(x => x.name + ':' + x.columns + '→' + x.refTable),
      b: twoB.map(x => x.name + ':' + x.columns + '→' + x.refTable)
    })

  const GRAPH = fk.expectedGraph(PRAGMA)
  check('夹具共 11 条外键、15 张基表（视图不算节点）',
    GRAPH.edges.length === 11 && GRAPH.tables.length === 15,
    { edges: GRAPH.edges.length, tables: GRAPH.tables.length })

  // ── 2. 用产品自己的 SQLite 引擎连上夹具库 ──────────────────────────
  await cdp.eval(PROBE)
  await cdp.eval(SPY)
  await clearDbTabs(cdp)

  const tabId = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(TAB_TITLE)},
      dbType: 'sqlite', dbFile: ${J(built.file)}, readOnly: true,
      production: false, batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const connected = await waitFor(cdp,
    `!!(window.__headTarget() && window.__headTarget().indexOf(${J('fk.db')}) >= 0)`,
    '会话头部等不到库文件名', 30000)
  check('页签头部认出夹具库（真连接，不是桩）', !!connected,
    { head: await cdp.eval('window.__headTarget()'), tabId })
  // 只读牌挂在 SQL 区的状态行上（.db-sql-status）。antd Tabs 的 pane 用 forceRender
  // 常驻 DOM，没切过去时是 display:none —— 在结构视角读它必然得到 null，
  // 所以先真切到 SQL 视角再读，读不到才叫"产品没说只读"。
  await click(await cdp.eval('window.__segXY(' + J('SQL') + ')'), 900)
  const chipSeen = await waitFor(cdp, '!!window.__readonlyChip()', 'SQL 状态行等不到只读牌', 8000)
  const chip = await cdp.eval('window.__readonlyChip()')
  const dialect = await cdp.eval("window.__txt(document.querySelector('.db-sql-status-dialect'))")
  check('按只读打开：SQL 状态行的只读牌在场（后面"零写命令"的前提）',
    !!chipSeen && /只读|read-only/i.test(String(chip)), { chip, dialect })

  for (let i = 0; i < 5; i++) {
    const sw = await cdp.eval('window.__collapsedXY()')
    if (!sw) break
    await click(sw, 800)
  }
  const titles = await cdp.jeval('JSON.stringify(window.__treeTitles())')
  check('树里 15 张基表 + 1 个视图都在场',
    GRAPH.tables.every(t => titles.indexOf(t) >= 0) && titles.indexOf('v_child') >= 0,
    { n: titles.length })

  const clickTree = async name => {
    const p = await cdp.eval(`window.__treeXY(${J(name)})`)
    if (!p) return 'no-node'
    await click(p, 1200)
    return 'ok'
  }
  const toStruct = async () => {
    const p = await cdp.eval('window.__segXY(' + J('结构') + ')')
    if (!p) return 'no-seg'
    await click(p, 900)
    return 'ok'
  }
  const toData = async () => {
    const p = await cdp.eval('window.__segXY(' + J('数据') + ')')
    if (!p) return 'no-seg'
    await click(p, 900)
    return 'ok'
  }

  const picked = await clickTree('fk_explicit')
  check('点左侧树选中 fk_explicit（不直接改 state）', picked === 'ok', picked)
  const segR = await toStruct()
  check('切到表结构视角', segR === 'ok', segR)
  const btnTexts = await cdp.jeval('JSON.stringify(window.__structBtnTexts())')
  const xyEr = await cdp.eval('window.__structBtnXY(' + J('ER图|ERgraph') + ')')
  const xyDiff = await cdp.eval('window.__structBtnXY(' + J('结构对比|Compare') + ')')
  const xyDict = await cdp.eval('window.__structBtnXY(' + J('导出数据字典|Export') + ')')
  check('SQLite 的结构页同样给出 ER 图 / 结构对比 / 导出数据字典 三个入口',
    !!xyEr && !!xyDiff && !!xyDict, { btnTexts })

  // ── 3. ER 图：真 listForeignKeys 走完整链路 ────────────────────────
  const opsBefore = await cdp.eval('window.__ops.length')
  await click(xyEr, 1500)
  const opened = await waitFor(cdp, 'window.__erNames().length >= 15', 'ER 图没画出 15 个节点', 30000)
  const nodeNames = await cdp.jeval('JSON.stringify(window.__erNames())')
  check('点开 ER 图：15 张基表逐张画成节点（按名字对，不是只数个数）',
    !!opened && sameSet(nodeNames, GRAPH.tables),
    { n: nodeNames.length, missing: GRAPH.tables.filter(t => nodeNames.indexOf(t) < 0) })

  const fkCalls = await cdp.eval('window.__fkCalls')
  check('打开只发一次 listForeignKeys（不轮询）', fkCalls === 1, fkCalls)
  const opsSlice = await cdp.jeval('JSON.stringify(window.__ops.slice(' + opsBefore + '))')
  check('ER 图全程零写命令（连 executeSql 都没出现）',
    !WRITE_OPS.some(op => opsSlice.indexOf(op) >= 0), opsSlice)
  check('视图不进 ER 图（v_child 不是节点）',
    (await cdp.jeval('JSON.stringify(window.__erNames())')).indexOf('v_child') < 0)
  const edgeCount = await cdp.eval('window.__erEdgeCount()')
  check('11 条外键画成 11 条边（复合外键一条边，不是一列一条）', edgeCount === 11, edgeCount)
  check('有外键时不出"本库没有定义外键"的提示',
    (await cdp.jeval('JSON.stringify(window.__erNotes())')).length === 0,
    await cdp.jeval('JSON.stringify(window.__erNotes())'))
  check('没有取数报错条', (await cdp.eval('window.__erErr()')) === null, await cdp.eval('window.__erErr()'))

  const subBad = []
  for (const t of ['dim_single', 'dim_pair', 'two_fks', 'fk_self', 'fk_none']) {
    const sub = await cdp.eval(`window.__erNodeSub(${J(t)})`)
    const want = degreeOf(GRAPH, t)
    // 副标题是 e('dbErFkCount') 渲染出来的整句（"{n} 个外键"），取句里那个数比原文稳
    const n = sub === null ? null : Number(String(sub).match(/\d+/))
    if (n !== want) subBad.push(t + ' 副标题 [' + sub + '] 读到的数 = ' + n + ' 期望 ' + want)
  }
  check('每个节点的"{n} 个外键"与夹具一致（被引用的入边也算）', subBad.length === 0, subBad)

  const detailOf = async name => {
    const p = await cdp.eval(`window.__erNodeXY(${J(name)})`)
    if (!p) return { err: 'no-node:' + name }
    await click(p, 600)
    return await cdp.jeval('JSON.stringify(window.__erDetail())')
  }
  const cmpRows = async name => {
    const d = await detailOf(name)
    if (!d || d.err) return { ok: false, d }
    const want = nodeRows(GRAPH, name).map(keyOfRow)
    const got = (d.rows || []).map(keyOfRow)
    return { ok: sameSet(want, got), want, got, subs: d.subs, openTable: d.openTable }
  }

  const rImpl = await cmpRows('fk_implicit_cols')
  check('省略引用列的外键：详情把引用列回落成目标表主键 (pa, pb)', rImpl.ok, rImpl)
  const rSelf = await cmpRows('fk_self')
  check('自引用外键：详情给 fk_self.up → fk_self(id) 且入边出边都算', rSelf.ok, rSelf)
  check('自引用那条边用绕回来的路径（不是断头直线）',
    (await cdp.eval('window.__erSelfLoops()')) >= 1, await cdp.eval('window.__erSelfLoops()'))
  const rTwo = await cmpRows('two_fks')
  check('一张表挂两条外键：详情逐条给约束名 / 列对 / 引用（编号与引擎同序）', rTwo.ok, rTwo)
  const rComp = await cmpRows('fk_composite')
  check('复合外键详情写 dim_pair(pa, pb) 而不是 dim_pair.pa, pb（多列不歧义）', rComp.ok, rComp)
  const rIn = await cmpRows('dim_single')
  check('被引用的父表：详情把它挂着的入边全列出来（4 条，自身声明是空的）',
    rIn.ok && rIn.want.length === 4, rIn)

  // 截图钉在 dim_single 这一屏：15 节点 11 边的整图 + 4 条入边的详情条同框
  const darkFill = await cdp.eval('window.__erNameFill()')
  await cdp.shot(path.join(SHOT_DIR, '1-er-fk-dark.png'))

  // 浅色主题再看一眼同一张图：ER 是自己画的 SVG，配色全走 CSS 变量，
  // 换主题最容易出的事是"某个色没变量化"（深底深字）或重画丢节点
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(x => x.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id)))
  if (!lightId) {
    skip('浅色主题下的 ER 图', '本实例的主题表里没有浅色主题可用：' + themeIds.join(','))
  } else {
    THEME_BEFORE = await cdp.eval('String((window.store._config || {}).theme)')
    const setTheme = async id => {
      await cdp.eval('window.store.setTheme(' + J(id) + ')')
      await sleep(1000)
    }
    await setTheme(lightId)
    await cdp.shot(path.join(SHOT_DIR, '2-er-fk-light.png'))
    const lightFill = await cdp.eval('window.__erNameFill()')
    check('换浅色主题：15 节点 / 11 边 / 详情 4 条一条没少',
      (await cdp.eval('window.__erNodes().length')) === 15 &&
      (await cdp.eval('window.__erEdgeCount()')) === 11 &&
      (await cdp.eval('window.__erDetail() ? window.__erDetail().rows.length : -1')) === 4,
      { theme: lightId, fill: lightFill })
    check('浅色主题真的落进 ER 的取色（两张截图不是同一屏颜色）',
      !!lightFill && !!darkFill && lightFill !== darkFill, { darkFill, lightFill })
    await setTheme(THEME_BEFORE)
    const back = await cdp.eval('String((window.store._config || {}).theme)')
    check('跑完把主题换回实例原状（不给下一个脚本留环境差）', back === THEME_BEFORE, { back, THEME_BEFORE })
    THEME_BEFORE = null
  }

  const dNone = await detailOf('fk_none')
  check('选中没有外键的表：详情说"这张表没有外键"而不是空白',
    dNone && (!dNone.rows || dNone.rows.length === 0) &&
    /没有外键|no foreign key/i.test(String(dNone.subs || [])), dNone)

  // 详情条的"打开表"：关弹层 + 数据页切到那张表
  const dBtn = await cdp.jeval(`(() => {
    const r = window.__erRoot(); const d = r && r.querySelector('.db-er-detail')
    const b = d && [...d.querySelectorAll('button')].find(x => /打开表|Open\\s*table/i.test(x.innerText))
    return b ? JSON.stringify(window.__xy(b)) : 'null'
  })()`)
  check('选中详情带"打开表"按钮', dBtn && dBtn !== 'null', dBtn)
  if (dBtn && dBtn !== 'null') {
    await click(dBtn, 1500)
    const stillOpen = await cdp.eval('window.__erOpen()')
    // "打开表"换的是选中对象，不改当前视角：ER 从结构工具条打开，点完仍停在结构页，
    // 与树单击同一口径（页签只有显式动作如"导入"才会被切走）。
    // 所以先读挂载但隐藏的数据网格标题（Tabs 的 forceRender 让 pane 常驻 DOM）确认选中换了，
    // 再真切回数据视角确认用户看到的就是那张表。
    const selAfter = await cdp.eval(
      "window.__txt(document.querySelector('.db-grid-area .db-grid-title'))")
    check('点"打开表"：弹层关闭、选中切到那张表（不越权翻页签）',
      stillOpen === false && /fk_none$/.test(String(selAfter)), { stillOpen, selAfter })
    const dataSeg = await toData()
    const gridTitle = await cdp.eval(
      "window.__txt([...document.querySelectorAll('.db-grid-area .db-grid-title')].filter(window.__vis)[0])")
    check('切到数据视角：网格就是刚打开的表（标题 main.<表>，不是空标题）',
      dataSeg === 'ok' && /fk_none/.test(String(gridTitle)), { dataSeg, gridTitle })
    await toStruct()
  }

  // 只读边界：弹层里没有任何输入控件
  const xyEr2 = await cdp.eval('window.__structBtnXY(' + J('ER图|ERgraph') + ')')
  if (!xyEr2) throw new Error('结构工具条上的 ER 图按钮在切回结构视角后找不到了')
  await click(xyEr2, 1200)
  await waitFor(cdp, 'window.__erOpen()', 'ER 图重开失败', 15000)
  check('ER 图弹层里没有可写控件（只读视图）', (await cdp.eval('window.__erInputs()')) === 0,
    await cdp.eval('window.__erInputs()'))
  const calls2 = await cdp.eval('window.__fkCalls')
  check('重开 ER 图再取一次数（每次打开一次，不是缓存到永久）', calls2 === 2, calls2)
  await click(await cdp.eval('window.__erFooterXY(' + J('关闭|close') + ')'), 800)
  check('关闭后 ER 根节点不在', (await cdp.eval('window.__erOpen()')) === false,
    await cdp.eval('window.__erOpen()'))

  // ── 4. 数据字典的外键节：一条导出的 Markdown/CSV 行对一条声明 ───────
  await cdp.eval('window.__dlCapture()')
  const dictOf = async (table, shotFile = null) => {
    const picked = await clickTree(table)
    if (picked !== 'ok') return { err: picked }
    const segR = await toStruct()
    if (segR !== 'ok') return { err: segR }
    await cdp.eval('window.__dl.length = 0')
    if (await cdp.eval('window.__dictBtn()') !== 'ok') return { err: 'no-dict-btn' }
    await sleep(400)
    const menu = await cdp.jeval('JSON.stringify(window.__dictMenu())')
    // 菜单还开着的时候拍：两格式的入口是这一批唯一"看得见"的字典证据，
    // 导出正文走拦截，屏幕上根本不出现
    if (shotFile) await cdp.shot(path.join(SHOT_DIR, shotFile))
    if (await cdp.eval("window.__dictPick('Markdown')") !== 'ok') return { err: 'no-md-item', menu }
    const gotMd = await waitFor(cdp, 'window.__dl.length >= 1', 'Markdown 没落进拦截', 10000)
    await cdp.eval('window.__dictBtn()')
    await sleep(400)
    if (await cdp.eval("window.__dictPick('CSV')") !== 'ok') return { err: 'no-csv-item' }
    const gotCsv = await waitFor(cdp, 'window.__dl.length >= 2', 'CSV 没落进拦截', 10000)
    if (!gotMd || !gotCsv) return { err: 'download-missing', gotMd, gotCsv }
    const dl = await cdp.jeval('JSON.stringify(window.__dl)')
    const md = (dl || []).find(d => /\.md$/.test(String(d.name))) || {}
    const csv = (dl || []).find(d => /\.csv$/.test(String(d.name))) || {}
    return { table, md, csv, menu }
  }

  const dOne = await dictOf('fk_explicit', '3-dict-menu.png')
  const mdOne = mdSectionOf(dOne.md && dOne.md.text, /^## 外键/)
  const csvOne = csvSectionOf(dOne.csv && dOne.csv.text, '# 外键')
  check('字典入口两格式可选，文件名按 dictionary-main-<表>-时间戳',
    dOne.menu && dOne.menu.join(',') === 'Markdown,CSV' &&
    /^dictionary-main-fk_explicit-\d{8}-\d{6}\.md$/.test(String(dOne.md.name)) &&
    /^dictionary-main-fk_explicit-\d{8}-\d{6}\.csv$/.test(String(dOne.csv.name)),
    { menu: dOne.menu, md: dOne.md && dOne.md.name, csv: dOne.csv && dOne.csv.name })
  check('Markdown 外键节：标题带条数、表头五列、行内容逐字等于声明',
    mdOne && mdOne.heading === '## 外键（1）' &&
    JSON.stringify(mdOne.head) === JSON.stringify(FK_MD_HEAD) &&
    JSON.stringify(mdOne.body) === JSON.stringify(dictExpect('fk_explicit')),
    { heading: mdOne && mdOne.heading, head: mdOne && mdOne.head, body: mdOne && mdOne.body })
  check('CSV 外键节与 Markdown 同一份事实（含 BOM，动作列不为空）',
    csvOne && JSON.stringify(csvOne.head) === JSON.stringify(FK_MD_HEAD) &&
    JSON.stringify(csvOne.body) === JSON.stringify(dictExpect('fk_explicit')) &&
    dOne.csv.bytes[0] === 0xEF && dOne.csv.bytes[1] === 0xBB && dOne.csv.bytes[2] === 0xBF,
    { head: csvOne && csvOne.head, body: csvOne && csvOne.body, bytes: dOne.csv && dOne.csv.bytes })

  const dImpl = await dictOf('fk_implicit_cols')
  const mdImpl = mdSectionOf(dImpl.md && dImpl.md.text, /^## 外键/)
  check('省略引用列的外键：字典里引用列是目标表主键 dim_pair(pa, pb)，不是空白',
    mdImpl && mdImpl.body.length === 1 && mdImpl.body[0][2] === 'dim_pair(pa, pb)',
    mdImpl && mdImpl.body)
  check('省略 ON 子句的外键：字典动作列写引擎给的 NO ACTION（不是空串也不是 —）',
    mdImpl && mdImpl.body.length === 1 && mdImpl.body[0][3] === 'NO ACTION' &&
    mdImpl.body[0][4] === 'NO ACTION', mdImpl && mdImpl.body)

  const dNoneDict = await dictOf('fk_none')
  const mdNone = mdSectionOf(dNoneDict.md && dNoneDict.md.text, /^## 外键/)
  const csvNone = csvSectionOf(dNoneDict.csv && dNoneDict.csv.text, '# 外键')
  check('没有外键的表：外键节仍然在场、条数写 0、只留表头不带数据行',
    mdNone && mdNone.heading === '## 外键（0）' && mdNone.body.length === 0 &&
    csvNone && csvNone.body.length === 0,
    { md: mdNone && mdNone.heading, mdBody: mdNone && mdNone.body, csvHead: csvNone && csvNone.head })

  const dictOps = await cdp.jeval('JSON.stringify(window.__ops)')
  check('整轮（ER + 字典）零写命令：写 op 一次都没出现',
    !WRITE_OPS.some(op => dictOps.indexOf(op) >= 0),
    { ops: [...new Set(dictOps)] })

  // ── 5. 收尾：还原桥接，不给下一个脚本留桩 ──────────────────────────
  const restored = await cdp.eval(RESTORE)
  check('收尾还原 window.pre.runGlobalAsync', restored === 'restored', restored)
  const afterGate = await preStubState(cdp)
  check('还原后桥接状态回到原装', afterGate === 'ok', afterGate)

  const failed = results.filter(r => !r.ok)
  console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' PASS')
  process.exit(failed.length ? 1 : 0)
}

main().catch(async err => {
  console.error('脚本异常：', err && err.stack ? err.stack : err)
  try {
    const t = await getJson(CDP_URL)
    const p = findPageTarget(t)
    if (p) {
      const c = new Cdp(p.webSocketDebuggerUrl)
      await c.ready
      await c.eval(RESTORE)
      if (THEME_BEFORE) {
        await c.eval('window.store.setTheme(' + J(THEME_BEFORE) + ')')
        console.log('收尾把主题换回了 ' + THEME_BEFORE)
      }
    }
  } catch (e) {
    console.log('WARN 收尾还原没成功：' + String(e.message || e).slice(0, 80))
  }
  process.exit(1)
})
