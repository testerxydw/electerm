#!/usr/bin/env node
/**
 * H8a-c SQLite 实机验收 —— 数据页 / 结构页 / SQL 页全链路（真 node:sqlite 文件，无桩）
 *
 * 为什么必须实机（单测与桩版替代不了）：
 * - 桩测钉得住纯函数（分页窗口、语句切分、方言标记），钉不住"真驱动把 'x\y' 读回来
 *   到底是 3 个字符还是 2 个"——反斜杠是不是转义符，只有真 SQLite 文件会回答；
 * - 数据页的写回（双击改格 / 删除选中）走的是主进程参数化 UPDATE/DELETE，
 *   判据必须落在"文件里真的变了"（宿主侧用 node:sqlite 直读同一个文件比对），
 *   而不是"界面刷新了"；
 * - 只读门是安全边界：渲染层把 readOnly:false 传进来不算数，白名单以主进程为权威，
 *   这条只能靠"直接发 IPC 仍被拒 + 文件里没多出表"来证明；
 * - SQL 结果撞行数上限时界面必须说出来（否则用户把残缺结果当全量去过滤/排序/导出）。
 *
 * 覆盖（63 条，跑完末尾打印实际数）：
 *   A 数据页/结构页（shop.db，可写）：连上并认出库文件、树里有表与视图、表头按
 *     PRAGMA 顺序、本页行数口径、NULL 占位、含引号/反斜杠/逗号引号的值逐字可见、
 *     本页过滤命中与还原、表头排序三态循环（无 → 升 → 降 → 取消，chip 与首行同时验，
 *     首行按"本列 min/max"判而不写死数字）、双击改格进编辑态、
 *     UPDATE 落盘、删除选中落盘、结构页类型与主键、查看 DDL 是 sqlite_master 原文、
 *     SQL 编辑器可写、只读开关三处生效（编辑器不可编、单元格不再进编辑态、
 *     主进程拒绝 IPC 写且文件里没多出表）、只读提示条按 SQLite 口径给
 *     （白名单里有 VALUES/PRAGMA，不再承诺 MySQL 才有的 SHOW/DESC）
 *   B SQL 页（sql.db）：方言标 SQLite、SELECT 出行、多语句多结果集、反斜杠非转义、
 *     双引号是标识符（正例 + no such column 反例）、# 非注释、错误条带复制入口、
 *     -- 后不需空格、LIKE 无默认转义符（0/1）、PRAGMA 直读、1.2 万行撞上限并说明
 *     （且提示里不留未替换的 {n}）、DROP 高危确认取消不改库、EXPLAIN 出 SCAN/SEARCH、
 *     500 行按 200/页翻页（OFFSET 下推）、DDL+DML 落盘、关页签重开仍在、浅色主题不塌
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/ work/app/
 *      （词条与主进程侧改动走 app.js：只构建渲染层不够，实例还要重启）
 *   2) DISPLAY=:130 HOME=/tmp/electerm-h8a/home TMPDIR=/tmp/electerm-h8a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-sqlite-sql-demo.js [debugPort] [shotDir]
 *
 * 夹具都在 /tmp/electerm-h8a/demo 下、每次跑重建：不碰仓库、不含真实凭据，
 * 数据全是本机造的假商品表，截图可以进仓库。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sqlite-sql-shots')
const DEMO_DIR = '/tmp/electerm-h8a/demo'
const SHOP = path.join(DEMO_DIR, 'shop.db')
const SQLDB = path.join(DEMO_DIR, 'sql.db')
const SHOP_TITLE = 'h8ac-shop'
const SQL_TITLE = 'h8ac-sql'

const { check, skip, results } = makeChecker()
const J = s => JSON.stringify(s)

// 页内探针。所有可见性判定都带命中测试：侧栏/浮层被裁掉时 display 仍是 block，
// 只看样式会把点不到的节点当成可见（H8a-b 就是这么被结构树的标题冒充过一次）。
// 列下标一律取"未过滤的全部 thead th"，再按同一序号取 tr.children —— 数据页有勾选列，
// 两边各自过滤会出现"看着对，实际错一列"的错位。
const HELPERS = `(() => {
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
  window.__at = sel => {
    const el = [...document.querySelectorAll(sel)].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__txt = el => (el ? String(el.innerText || '').trim() : null)

  window.__headTarget = () => window.__txt([...document.querySelectorAll('.db-head-target')]
    .filter(window.__vis)[0])
  window.__treeText = () => {
    const el = [...document.querySelectorAll('.db-tree')].filter(window.__vis)[0]
    return el ? el.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null
  }
  window.__collapsedSwitcherXY = () => {
    const el = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__treeNodeXY = t => {
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => n.innerText.trim().indexOf(t) >= 0)
    // 节点在树下方/被虚拟滚动移出视口时，命中测试会当它"不可见"（真人会先滚过去）
    for (const el of all) {
      el.scrollIntoView({ block: 'center' })
      if (window.__vis(el)) return window.__xy(el)
    }
    return null
  }
  // 会话主区的 数据 / SQL / 表结构（自绘 antd Tabs，不是外层文档页签 .tab）
  window.__segXY = t => {
    const el = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    return el ? window.__xy(el) : null
  }

  // ---- 数据页 ----
  const dataTable = () => [...document.querySelectorAll('.db-grid-area .db-grid-table')].filter(window.__vis)[0]
  const nameOf = th => {
    const n = th.querySelector('.db-col-name')
    return ((n && n.innerText) || th.innerText || '').trim().split('\\n')[0]
  }
  // 勾选列/占位列没有 .db-col-name：heads 只收有名字的列，但 __colIdx 仍按 DOM 全序给下标
  window.__dataGrid = () => {
    const g = dataTable()
    if (!g) return null
    return {
      heads: [...g.querySelectorAll('thead th')].map(nameOf).filter(Boolean),
      title: window.__txt([...document.querySelectorAll('.db-grid-area .db-grid-title')].filter(window.__vis)[0]),
      pageRows: window.__txt([...document.querySelectorAll('.db-grid-area .db-grid-page-rows')].filter(window.__vis)[0])
    }
  }
  window.__colIdx = label => {
    const g = dataTable()
    if (!g) return -1
    const ths = [...g.querySelectorAll('thead th')]
    let hit = -1
    for (let i = 0; i < ths.length; i++) {
      if (nameOf(ths[i]) === label) hit = i
    }
    return hit
  }
  window.__visRows = () => {
    const g = dataTable()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  window.__dataRows = () => window.__visRows().map(tr => [...tr.children].map(td => td.innerText.trim()))
  window.__cellText = (label, i) => {
    const idx = window.__colIdx(label)
    const tr = window.__visRows()[i || 0]
    if (idx < 0 || !tr || !tr.children[idx]) return null
    return tr.children[idx].innerText.trim()
  }
  // 点击坐标取格子左半 60px 内：右沿是列头拖宽热区的延长线，也避开省略号区
  window.__cellXY = (label, i) => {
    const idx = window.__colIdx(label)
    const tr = window.__visRows()[i || 0]
    if (idx < 0 || !tr || !tr.children[idx]) return null
    const r = tr.children[idx].getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2) }
  }
  // 表头单元格的命中诊断：横向滚到可视区、给出真实点击点与"那里到底是哪个元素"。
  // 列很多时表头中心可能落在窗口外或被右侧面板压住——那种点击什么都不会发生，
  // 没有这层诊断就只能看到"排序没生效"这种没法归因的失败
  window.__headProbe = label => {
    const idx = window.__colIdx(label)
    const g = dataTable()
    if (idx < 0 || !g) return null
    const th = g.querySelectorAll('thead th')[idx]
    th.scrollIntoView({ block: 'nearest', inline: 'center' })
    const xy = window.__xy(th)
    const hit = document.elementFromPoint(xy.x, xy.y)
    return {
      idx,
      xy,
      inView: xy.x >= 0 && xy.y >= 0 && xy.x <= window.innerWidth && xy.y <= window.innerHeight,
      hit: hit ? hit.tagName + '|' + String(hit.className).slice(0, 70) : null,
      clickable: !!hit && (hit === th || th.contains(hit) || hit.contains(th))
    }
  }
  window.__headXY = label => {
    const p = window.__headProbe(label)
    return p && p.clickable ? p.xy : null
  }
  // 视角条底部的排序 chip（.db-view-chip，降序带 is-desc）：点一次表头应当是升序。
  // 只断言"首格值"分不清"点了一次排成降序"和"点了两次"，chip 才是意图的直接证据
  window.__sortChips = () => [...document.querySelectorAll('.db-view-chip')].filter(window.__vis)
    .map(x => ({ t: x.innerText.replace(/\\s+/g, ' ').trim(), desc: x.className.indexOf('is-desc') >= 0 }))
  // 整列的可见值（按当前行序）：升/降的判据取"这一列的最小/最大值"，
  // 不写死数字——夹具行会被前面的删除/改值用例改动，写死就等于把判据绑在历史跑序上
  window.__colTexts = label => {
    const idx = window.__colIdx(label)
    if (idx < 0) return []
    return window.__visRows().map(tr => (tr.children[idx] ? tr.children[idx].innerText.trim() : null))
  }
  window.__rowIdxOf = t => window.__visRows()
    .findIndex(tr => [...tr.children].some(td => td.innerText.indexOf(t) >= 0))
  window.__rowCheckXY = i => {
    const tr = window.__visRows()[i]
    if (!tr) return null
    const el = tr.querySelector('.ant-checkbox-input') || tr.querySelector('.ant-checkbox')
    return el ? window.__xy(el) : null
  }
  window.__btnState = t => {
    const b = [...document.querySelectorAll('.db-grid-area button, .db-struct-tools button, .db-sql-bar button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return { found: false }
    return { found: true, disabled: !!b.disabled, xy: window.__xy(b) }
  }
  window.__pageSizeXY = () => {
    const s = [...document.querySelectorAll('.db-grid-area .db-grid-pagesize')].filter(window.__vis)[0]
    if (!s) return null
    const el = s.querySelector('.ant-select-content') || s.querySelector('.ant-select-selector') || s
    return window.__xy(el)
  }
  window.__optXY = re => {
    const el = [...document.querySelectorAll('.ant-select-item-option')].filter(window.__vis)
      .find(o => new RegExp(re).test(o.innerText.trim()))
    return el ? window.__xy(el) : null
  }
  window.__pager = () => {
    const p = [...document.querySelectorAll('.db-grid-area .db-grid-pager')].filter(window.__vis)[0]
    if (!p) return null
    const bs = [...p.querySelectorAll('button')]
    const next = bs.find(b => b.querySelector('.anticon-right'))
    return {
      pageNo: window.__txt(p.querySelector('.db-grid-page-no')),
      nextXY: next && !next.disabled ? window.__xy(next) : null
    }
  }
  window.__filterInput = () => [...document.querySelectorAll('.db-page-filter input')].filter(window.__vis)[0] || null
  window.__setInput = (el, v) => {
    if (!el) return 'no-input'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__cellEditor = () => [...document.querySelectorAll('.db-cell-editor')].filter(window.__vis)[0] || null

  // ---- SQL 页 ----
  window.__editorRO = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return ed ? String(ed.getAttribute('contenteditable')) : 'no-editor'
  }
  window.__edXY = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    if (!ed) return null
    const r = ed.getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + Math.min(20, r.height / 2)) }
  }
  window.__edFocused = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return !!(ed && document.activeElement === ed)
  }
  window.__sqlDoc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return ed ? String(ed.innerText || '').replace(/\\s+/g, ' ').trim() : 'no-editor'
  }
  window.__runBtn = () => {
    const b = [...document.querySelectorAll('.db-sql-bar button')].filter(window.__vis)
      .find(x => /^执行$|^run$/i.test(x.innerText.replace(/\\s/g, '')))
    if (!b) return { found: false }
    return {
      found: true,
      disabled: !!b.disabled,
      loading: /ant-btn-loading/.test(String(b.className)),
      xy: window.__xy(b)
    }
  }
  window.__status = () => window.__txt([...document.querySelectorAll('.db-sql-area .db-sql-elapsed')].filter(window.__vis)[0])
  window.__limitNote = () => window.__txt([...document.querySelectorAll('.db-sql-area .db-sql-row-limit')].filter(window.__vis)[0])
  window.__affected = () => window.__txt([...document.querySelectorAll('.db-sql-area .db-sql-affected')].filter(window.__vis)[0])
  window.__resultGrid = () => {
    const g = [...document.querySelectorAll('.db-sql-area .db-sql-result-grid')].filter(window.__vis)[0]
    if (!g) return { heads: [], rows: [] }
    return {
      heads: [...g.querySelectorAll('thead th')].map(nameOf).filter(Boolean),
      rows: [...g.querySelectorAll('.ant-table-row')].filter(window.__vis)
        .map(tr => [...tr.children].map(td => td.innerText.trim()))
    }
  }
  window.__resultTabs = () => [...document.querySelectorAll('.db-sql-results-tabs .ant-tabs-tab')]
    .filter(window.__vis).map(t => t.innerText.replace(/\\s+/g, ' ').trim())
  // 结果集按列名取格：与数据页同一套下标算法（全部 thead th 的 DOM 序），
  // 不依赖"结果表有没有勾选列"这种实现细节
  window.__resColIdx = label => {
    const g = [...document.querySelectorAll('.db-sql-area .db-sql-result-grid')].filter(window.__vis)[0]
    if (!g) return -1
    const ths = [...g.querySelectorAll('thead th')]
    let hit = -1
    for (let i = 0; i < ths.length; i++) {
      if (nameOf(ths[i]) === label) hit = i
    }
    return hit
  }
  window.__resCell = (label, i) => {
    const idx = window.__resColIdx(label)
    const g = [...document.querySelectorAll('.db-sql-area .db-sql-result-grid')].filter(window.__vis)[0]
    const tr = g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis)[i || 0] : null
    if (idx < 0 || !tr || !tr.children[idx]) return null
    return tr.children[idx].innerText.trim()
  }
  window.__errAlert = () => {
    const wrap = [...document.querySelectorAll('.db-sql-area .db-sql-result .ant-alert-error')].filter(window.__vis)[0]
    if (!wrap) return null
    return {
      text: String(wrap.innerText || '').replace(/\\s+/g, ' ').trim(),
      // 复制/AI 修复是纯图标按钮：认 title，不认 innerText
      actions: [...wrap.querySelectorAll('.db-sql-error-actions button')].map(b => b.getAttribute('title') || '')
    }
  }
  window.__dialectChip = () => window.__txt([...document.querySelectorAll('.db-sql-status-dialect')].filter(window.__vis)[0])
  window.__switchXY = label => {
    const wrap = [...document.querySelectorAll('.db-sys-toggle')].filter(window.__vis)
      .find(s => s.innerText.indexOf(label) >= 0)
    const sw = wrap && wrap.querySelector('.ant-switch')
    return sw ? { xy: window.__xy(sw), on: /ant-switch-checked/.test(String(sw.className)) } : null
  }
  // 只读开关的 Tooltip 文案：悬停才出现，且只在真正"可见"的那条上认
  // （同一页签可能有别的浮层残留，hidden 的不算）
  // 找不到控件时要说清"当时屏幕上是什么"：否则"编辑器没了"这种失败只能靠猜
  window.__tabState = () => ({
    docTabs: [...document.querySelectorAll('.tab-list .tab')].filter(window.__vis)
      .map(t => (window.__isActiveTab(t) ? '*' : '') + t.innerText.replace(/\\s+/g, ' ').trim().slice(0, 26)),
    segs: [...document.querySelectorAll('.db-tabs .ant-tabs-tab')].filter(window.__vis)
      .map(t => (/ant-tabs-tab-active/.test(String(t.className)) ? '*' : '') + t.innerText.replace(/\\s/g, '')),
    editors: document.querySelectorAll('.cm-content').length,
    editorsVisible: [...document.querySelectorAll('.cm-content')].filter(window.__vis).length,
    modal: [...document.querySelectorAll('.ant-modal')].filter(window.__vis).length
  })
  window.__isActiveTab = t => /active|selected/.test(String(t.className))
  window.__tipText = () => {
    const t = [...document.querySelectorAll('.ant-tooltip')].filter(window.__vis)[0]
    if (!t) return null
    return {
      text: String(t.innerText || '').replace(/\\s+/g, ' ').trim(),
      hidden: /ant-tooltip-hidden/.test(String(t.className))
    }
  }

  // ---- 浮层 ----
  // 危险确认是自绘 footer 的 .db-risk-modal（不是 Modal.confirm）：
  // 按钮文案是「取消 / 仍要执行」，非生产连接不要输库名，低危写才带"静音"勾选
  window.__risk = () => {
    const m = [...document.querySelectorAll('.ant-modal.db-risk-modal')].filter(window.__vis)[0]
    if (!m) return null
    return {
      badge: window.__txt(m.querySelector('.db-risk-badge')),
      reason: window.__txt(m.querySelector('.db-risk-gate-reason')),
      mute: !!m.querySelector('.db-risk-mute'),
      btns: [...m.querySelectorAll('.ant-modal-footer button')]
        .map(b => ({ t: b.innerText.replace(/\\s/g, ''), disabled: !!b.disabled })),
      text: String(m.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260)
    }
  }
  window.__riskClick = t => {
    const m = [...document.querySelectorAll('.ant-modal.db-risk-modal')].filter(window.__vis)[0]
    if (!m) return 'no-modal'
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return 'no-btn:' + t
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__modalTitle = () => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-title'))
    if (!m) return null
    const body = m.querySelector('.ant-modal-body')
    return {
      title: window.__txt(m.querySelector('.ant-modal-title')),
      body: body ? String(body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : '',
      btns: [...m.querySelectorAll('.ant-modal-footer button')].map(b => b.innerText.replace(/\\s/g, ''))
    }
  }
  window.__modalClick = t => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-title'))
    if (!m) return 'no-modal'
    const b = [...m.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => x.innerText.replace(/\\s/g, '').indexOf(t) >= 0)
    if (!b) return 'no-btn:' + t
    b.click()
    return 'ok'
  }
  // footer=null 的弹层（EXPLAIN）只能点右上角 X
  window.__closeModalXY = () => {
    const m = [...document.querySelectorAll('.ant-modal')].filter(window.__vis)
      .find(x => x.querySelector('.ant-modal-close'))
    const el = m && m.querySelector('.ant-modal-close')
    return el ? window.__xy(el) : null
  }
  window.__ddlPre = () => window.__txt([...document.querySelectorAll('.db-ddl-pre')].filter(window.__vis)[0])
  window.__structRows = () => {
    const area = [...document.querySelectorAll('.db-struct-area')].filter(window.__vis)[0]
    if (!area) return []
    return [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)
      .map(tr => [...tr.children].map(td => td.innerText.trim()))
  }
  // 计划树里的节点类型在 .db-explain-type 单元格里；图形视图是 SVG，innerText 读不到
  window.__explainTypes = () => [...document.querySelectorAll('.db-explain-modal .db-explain-type')]
    .filter(window.__vis).map(e => String(e.innerText || '').trim().toUpperCase())
  window.__explainText = () => {
    const m = [...document.querySelectorAll('.db-explain-modal')].filter(window.__vis)[0]
    return m ? String(m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : null
  }
  window.__popconfirm = () => {
    const p = [...document.querySelectorAll('.ant-popover')].filter(window.__vis)[0]
    if (!p) return null
    const ok = [...p.querySelectorAll('.ant-popconfirm-buttons button')].filter(window.__vis).pop()
    return { text: String(p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160), okXY: ok ? window.__xy(ok) : null }
  }
  window.__msg = () => [...document.querySelectorAll('.ant-message-notice-content')].map(x => x.innerText.trim()).join(' | ')
  return 1
})()`

async function main () {
  fs.mkdirSync(DEMO_DIR, { recursive: true })

  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) {
    throw new Error('端口 ' + PORT + ' 上没有页面目标')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  // 必须跑在刚构建的包上：实例常常先于 vite-build 启动，不重载就是在测上一版界面
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, '!!document.querySelector(".bookmark-sidebar-toggle")', '应用未就绪', 40000)) {
    throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  }
  await sleep(1500)
  await cdp.eval(HELPERS)

  // 点完把指针挪走：Tooltip 是"悬停才显示"，合成指针停在开关上 = 提示条一直开着，
  // 它会盖住下一屏要点的控件（实测：只读提示条压住 数据/SQL/表结构 页签，
  // 命中测试判定页签"不可见"，于是切页签的点击根本没发生）。真人不会这样用鼠标。
  const park = async () => {
    await cdp.move(1560, 940)
    await sleep(320)
  }
  const click = async (p, ms = 500) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
    await park()
  }
  const dblclick = async (p, ms = 800) => {
    if (!p) throw new Error('双击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y, 2)
    await sleep(ms)
    await park()
  }
  // 悬停取 Tooltip 文案：antd 提示条有出现延迟，要在它还开着时截图就先 shot 再 park
  const hoverTip = async (p, shotFile = null, ms = 900) => {
    if (!p) return null
    await cdp.move(p.x, p.y)
    await sleep(ms)
    const t = await cdp.eval('window.__tipText()')
    if (shotFile) await cdp.shot(shotFile)
    await park()
    return (t && !t.hidden) ? t.text : null
  }

  // 开一个 SQLite 会话页签：store.addTab → 组件挂载 → 主进程 openDbTab → 真 node:sqlite
  const openTab = async (title, file, readOnly) => {
    const id = await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database',
        from: 'quick-connect',
        title: ${J(title)},
        dbType: 'sqlite',
        dbFile: ${J(file)},
        readOnly: ${J(readOnly)},
        production: false,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    const ok = await waitFor(cdp,
      `!!(window.__headTarget() && window.__headTarget().indexOf(${J(path.basename(file))}) >= 0)`,
      '会话头部等不到库文件名', 25000)
    return { id, ok }
  }
  const activate = async id => {
    await cdp.eval(`window.store.changeActiveTabId(${J(id)})`)
    await sleep(900)
  }
  // SQLite 的树是 schema(main) → 表/视图，schema 默认收起：不展开就读不到表名
  const expandTree = async () => {
    for (let i = 0; i < 4; i++) {
      const sw = await cdp.eval('window.__collapsedSwitcherXY()')
      if (!sw) break
      await click(sw, 800)
    }
  }
  const selectTable = async name => {
    await expandTree()
    const p = await cdp.eval(`window.__treeNodeXY(${J(name)})`)
    if (!p) return 'no-node'
    await click(p, 1200)
    // SQLite 的数据页标题带库名前缀（main.product），不是裸表名：按后缀认
    const ok = await waitFor(cdp,
      `!!(window.__dataGrid() && (window.__dataGrid().title === ${J(name)} ||` +
      ` String(window.__dataGrid().title).endsWith(${J('.' + name)})))`, '数据页等不到表 ' + name, 15000)
    return ok ? 'ok' : 'grid-not-ready'
  }
  const openSeg = async label => {
    const p = await cdp.eval(`window.__segXY(${J(label)})`)
    if (!p) return 'no-seg'
    await click(p, 800)
    return true
  }
  const openSqlSeg = async () => {
    const r = await openSeg('SQL')
    if (r !== true) return r
    return waitFor(cdp, '!!window.__edXY()', 'SQL 编辑器未挂载', 12000)
  }
  // 整篇替换编辑器内容：真鼠标点击给焦点 → Ctrl+A 全选 → insertText 覆盖。
  // 覆盖成功后必须回读一次：Ctrl+A 没选中全文时 insertText 会变成"追加"，
  // 于是要么执行了上一条的残留、要么报一个和这条用例无关的语法错。
  const setSql = async text => {
    const want = String(text).replace(/\s+/g, ' ').trim()
    // 弹层刚关掉那一拍，遮罩还在淡出：命中测试会把编辑器判成"点不到"（实测过一次
    // explain 前置查询拿到 no-editor，下一轮同样的顺序又是绿的）。等它落定再判，
    // 等不到才认失败——否则这条 FAIL 说的是动画，不是产品。
    await waitFor(cdp, '!!window.__edXY()', '等 SQL 编辑器可点', 6000)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const xy = await cdp.eval('window.__edXY()')
      if (!xy) {
        console.log('WARN 找不到可见的 SQL 编辑器，现场 = ' +
          JSON.stringify(await cdp.eval('window.__tabState()')))
        return 'no-editor'
      }
      await click(xy, 250)
      if (!(await cdp.eval('window.__edFocused()'))) {
        await click(xy, 250)
      }
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
      await sleep(200)
      await cdp.call('Input.insertText', { text })
      await sleep(300)
      const got = await cdp.eval('window.__sqlDoc()')
      if (String(got).replace(/\s+/g, ' ').trim() === want) {
        return 'ok'
      }
      console.log('WARN 编辑器内容没被整篇替换（第 ' + attempt + ' 次）：期望 [' + want + '] 实得 [' + got + ']')
    }
    return 'ed-mismatch'
  }
  // 一次执行的"结果面"指纹：状态行 / 影响行数 / 结果集页签 / 错误条 / 结果表形状。
  // 形状（列名 + 首行）也要进指纹：SQLite 单句查询 3ms 就回来，宽窗轮询抓不到 loading
  // 亮过；而两条不同的查询完全可以是同样的"1 行 · 0 ms"，只比状态行就分不清新旧。
  const sig = () => cdp.eval(`JSON.stringify([
    window.__status(), window.__affected(), window.__resultTabs(),
    window.__errAlert() ? window.__errAlert().text : null,
    window.__resultGrid().heads.join(','),
    window.__resultGrid().rows.length,
    window.__resultGrid().rows[0] ? window.__resultGrid().rows[0].join('|') : null
  ])`)
  // 等一次执行落定。闸门（危险确认）在 setSqlResult(loading) 之前，所以 confirm
  // 是一种终态；否则只有 loading 熄灭 + 四种终态 UI 之一出现才算落定。
  const settle = async (label, timeout = 30000, prev = null) => {
    const deadline = Date.now() + timeout
    let sawStart = false
    while (Date.now() < deadline) {
      const s = await cdp.eval(`(() => {
        if (window.__risk()) return 'confirm'
        if (window.__runBtn().loading) return 'loading'
        return (window.__status() || window.__errAlert() || window.__affected() ||
          window.__resultTabs().length) ? 'settled' : 'idle'
      })()`)
      if (s === 'confirm') {
        return 'confirm'
      }
      if (s === 'loading') {
        sawStart = true
      }
      if (s === 'settled' && (sawStart || (prev && (await sig()) !== prev))) {
        return await cdp.eval('window.__errAlert() ? \'error\' : \'done\'')
      }
      await sleep(15)
    }
    console.log('TIMEOUT 执行未落定：' + label + ' 现场=' + await sig())
    return 'timeout'
  }
  const execSql = async (sql, label, timeout) => {
    const st = await setSql(sql)
    if (st !== 'ok') {
      console.log('WARN ' + label + '：编辑器写入失败 → ' + st)
      return st
    }
    const btn = await cdp.eval('window.__runBtn()')
    if (!btn.found || btn.disabled) {
      console.log('WARN ' + label + '：执行按钮不可用 → ' + JSON.stringify(btn))
      return 'run-unavailable'
    }
    const prev = await sig()
    await click(btn.xy, 100)
    return settle(label, timeout, prev)
  }
  // 危险确认放行：非生产连接的 write/ddl 每次都问（scope 按批次，不复用）
  const passRisk = async () => {
    const r = await cdp.eval('window.__riskClick(\'仍要执行\')')
    if (r !== 'ok') return r
    await waitFor(cdp, '!window.__risk()', '危险确认弹窗没关掉', 8000)
    await sleep(400)
    return 'ok'
  }
  const waitFirstCell = (col, want, timeout = 12000) => waitFor(cdp,
    `window.__cellText(${J(col)}, 0) === ${J(want)}`, `等第一行 ${col}=${want}`, timeout)
  // 多会话并存：树节点/网格都只存在于"当前活动页签"，所以先切页签再选表
  const selectTableOn = async (id, name) => {
    await activate(id)
    return selectTable(name)
  }

  // ---- 清场：留着上一轮的会话页签，取到的就是旧会话的头部 ----
  const cleared = await clearDbTabs(cdp)
  if (cleared.left.length) {
    console.log('WARN 仍有没关掉的数据库页签', JSON.stringify(cleared.left))
  }

  // 夹具在"页签都关掉之后"才重建：主进程按连接键复用 SQLite 句柄，
  // 只要还有一个页签开着（哪怕来自别的探针脚本），rmDb 就是在删一个仍被打开的 inode——
  // 新页签会拿到那个"已 unlink 的旧文件"，于是界面读到上一轮的 3 行、宿主直读新文件是 4 行，
  // 写回也落进旧 inode，看起来就像"UPDATE 没生效"。实测被这个坑过一次。
  writeShop()
  writeSqlDb()
  await sleep(300)

  // ================= A 数据页 / 结构页（shop.db，可写） =================
  const shop = await openTab(SHOP_TITLE, SHOP, false)
  check('加数据库页签即连上 SQLite，头部显示库文件名', shop.ok, await cdp.eval('window.__headTarget()'))
  await expandTree()
  const treeTxt = await cdp.eval('window.__treeText()')
  check('结构树里有表 product 与视图 v_price',
    !!treeTxt && /product/.test(treeTxt) && /v_price/.test(treeTxt), treeTxt)
  check('点树节点打开 product 的数据页', await selectTable('product') === 'ok')

  const dg = await cdp.eval('window.__dataGrid()')
  const dgTitle = String((dg && dg.title) || '')
  check('数据页标题点名表（SQLite 是库名限定的 main.product），列序按 PRAGMA（id/name/price/note）',
    !!dg && (dgTitle === 'product' || dgTitle.endsWith('.product')) &&
    JSON.stringify(dg.heads) === JSON.stringify(['id', 'name', 'price', 'note']), dg)
  const rowsA = await cdp.eval('window.__dataRows()')
  check('4 行全在网格里，且标的是"本页 4 行"口径',
    Array.isArray(rowsA) && rowsA.length === 4 && /4/.test(String((dg && dg.pageRows) || '')),
    { n: rowsA && rowsA.length, pageRows: dg && dg.pageRows })
  const nullIdx = await cdp.eval('window.__rowIdxOf("键盘")')
  const nullCell = await cdp.eval(`window.__cellText('note', ${nullIdx})`)
  check('note 为 NULL 的那格显示 NULL 占位（不是空白，也看不出"少了条数据"）',
    /NULL/i.test(String(nullCell)), nullCell)
  const verbatim = await cdp.eval(`(() => {
    const txt = window.__dataRows().map(r => r.join(' | ')).join('\\n')
    return {
      quote: txt.indexOf("鼠标'带引号'") >= 0 || txt.indexOf("鼠标'带引号") >= 0,
      backslash: txt.indexOf('esc \\\\ % _ test') >= 0,
      comma: txt.indexOf('a,b"c') >= 0
    }
  })()`)
  check('含单引号/反斜杠/逗号+引号的值逐字可见（没被转义或截断）',
    !!(verbatim && verbatim.quote && verbatim.backslash && verbatim.comma), verbatim)

  // 本页过滤
  await cdp.eval('window.__setInput(window.__filterInput(), \'带引号\')')
  const hitOne = await waitFor(cdp, 'window.__dataRows().length === 1', '本页过滤没收到 1 行', 8000)
  check('本页过滤命中 1 行', hitOne)
  await cdp.eval('window.__setInput(window.__filterInput(), \'\')')
  const back4 = await waitFor(cdp, 'window.__dataRows().length === 4', '清过滤后没回到 4 行', 8000)
  check('清掉过滤回到 4 行', back4)

  // 点表头排序：三态循环（chip 自己的 title 就写着"升序 → 降序 → 取消"）。
  // 排序状态是按表持久化的，上一轮跑到哪就停在哪，所以"点一次应当是升序"
  // 其实取决于进入时的历史状态——实测过两种假失败：进入时已是升序（点一下变降序），
  // 以及点完判据读不到 chip。先把状态归零（顺带验掉"取消"这条腿），
  // 再从已知起点逐段验，每段都从上一段的结果出发。
  const priceCol = (await cdp.eval('window.__colTexts(\'price\')')).map(Number).filter(n => !Number.isNaN(n))
  const lo = Math.min(...priceCol)
  const hi = Math.max(...priceCol)
  const headProbe = await cdp.eval('window.__headProbe(\'price\')')
  console.log('INFO price 表头点击点 = ' + JSON.stringify(headProbe) +
    '，进入时 chip = ' + JSON.stringify(await cdp.eval('window.__sortChips()')) +
    '，本列 min/max = ' + lo + '/' + hi)
  let chips = await cdp.eval('window.__sortChips()') || []
  if (!headProbe || !headProbe.clickable) {
    console.log('WARN price 表头点不到，跳过排序段：' + JSON.stringify(headProbe))
  } else {
    for (let n = 0; n < 4 && chips.length; n++) {
      await click(headProbe.xy, 700)
      await waitFor(cdp, 'window.__sortChips().length === 0', '等排序归零', 6000)
      chips = await cdp.eval('window.__sortChips()') || []
    }
    check('排序能归零（chip 消失 = "取消排序"这一条腿走通）', chips.length === 0, chips)
    await click(headProbe.xy, 700)
    await waitFor(cdp, 'window.__sortChips().length > 0', '等升序 chip', 6000)
    chips = await cdp.eval('window.__sortChips()') || []
    const ascFirst = await cdp.eval('window.__cellText(\'price\', 0)')
    check('无排序 → 点一次 = 升序（chip price ↑ 且首行是本列最小值）',
      chips.length === 1 && chips[0].desc === false && /price/.test(chips[0].t) &&
        Number(ascFirst) === lo, { chips, ascFirst, lo, headProbe })
    await click(headProbe.xy, 700)
    await waitFor(cdp, 'window.__sortChips().some(c => c.desc)', '等降序 chip', 6000)
    chips = await cdp.eval('window.__sortChips()') || []
    const descFirst = await cdp.eval('window.__cellText(\'price\', 0)')
    check('升序 → 点一次 = 降序（chip price ↓ 且首行换成本列最大值）',
      chips.length === 1 && chips[0].desc === true && Number(descFirst) === hi,
      { chips, descFirst, hi })
    await click(headProbe.xy, 700)
    await waitFor(cdp, 'window.__sortChips().length === 0', '等取消排序 chip', 6000)
    chips = await cdp.eval('window.__sortChips()') || []
    check('降序 → 点一次 = 取消（chip 消失，不再假装还在排序）', chips.length === 0, chips)
  }

  // 双击改格 → UPDATE → 界面与文件同时变
  const idxKb = await cdp.eval('window.__rowIdxOf(\'键盘\')')
  await dblclick(await cdp.eval(`window.__cellXY('name', ${idxKb})`), 900)
  const editor = await cdp.eval('!!window.__cellEditor()')
  check('可写连接双击单元格进编辑态（.db-cell-editor 出现）', editor === true, editor)
  await cdp.eval('window.__setInput(window.__cellEditor(), \'键盘A\')')
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13 })
  const gridEdited = await waitFor(cdp, 'window.__dataRows().map(r => r.join(\'|\')).join(\'#\').indexOf(\'键盘A\') >= 0',
    '界面没出现新值', 12000)
  check('改格后界面刷新出新值', gridEdited)
  const afterEdit = await readOne(SHOP, 'SELECT name FROM product WHERE id = 1')
  check('UPDATE 真的落到 sqlite 文件（宿主直读 = 键盘A）', afterEdit === '键盘A', afterEdit)

  // 勾选一行 → 删除选中 → Popconfirm → 文件里少一行
  const idxMon = await cdp.eval('window.__rowIdxOf(\'显示器\')')
  await click(await cdp.eval(`window.__rowCheckXY(${idxMon})`), 600)
  const del = await cdp.eval('window.__btnState(\'删除选中\')')
  check('有主键且非只读时「删除选中」可用', !!del.found && del.disabled === false, del)
  await click(del.xy, 800)
  const pop = await cdp.eval('window.__popconfirm()')
  check('删除走二次确认（弹层里点名表与行数）',
    !!pop && /product/.test(String(pop.text)) && /1/.test(String(pop.text)), pop && pop.text)
  if (pop && pop.okXY) {
    await click(pop.okXY, 1500)
  }
  const left3 = await waitFor(cdp, 'window.__dataRows().length === 3', '删除后网格没变成 3 行', 12000)
  check('删除选中后网格少一行（3 行）', left3)
  const countAfterDelete = await readOne(SHOP, 'SELECT COUNT(*) AS c FROM product')
  const goneAfterDelete = await readOne(SHOP, "SELECT COUNT(*) AS c FROM product WHERE name = '显示器'")
  check('DELETE 真的落到文件（COUNT=3 且那一行没了）',
    String(countAfterDelete) === '3' && String(goneAfterDelete) === '0',
    { countAfterDelete, goneAfterDelete })

  // ---- 结构页 ----
  await openSeg('结构')
  const struct = await cdp.eval('window.__structRows()')
  const flat = JSON.stringify(struct)
  check('结构页给出列类型原样（INTEGER/TEXT/REAL）',
    /INTEGER/.test(flat) && /TEXT/.test(flat) && /REAL/.test(flat), flat.slice(0, 220))
  check('结构页标出主键（Key=PRI）', /PRI/.test(flat), flat.slice(0, 220))
  const ddlBtn = await cdp.eval('window.__btnState(\'查看DDL\')')
  check('SQLite 也给出「查看 DDL」入口（没被 mysql 系独占）', !!ddlBtn.found && ddlBtn.disabled === false, ddlBtn)
  if (ddlBtn.found) {
    await click(ddlBtn.xy, 2200)
    const ddl = await cdp.eval('window.__ddlPre()')
    check('DDL 取的是 sqlite_master 原文（CREATE TABLE，不是 SHOW CREATE TABLE）',
      /CREATE TABLE/.test(String(ddl)) && !/SHOW CREATE/.test(String(ddl)), String(ddl).slice(0, 140))
    await cdp.eval('window.__modalClick(\'确定\')')
    await sleep(600)
  }

  // ---- 只读门：挡执行（主进程白名单）+ 挡写入口（单元格编辑），不挡打字 ----
  await openSqlSeg()
  const roBefore = await cdp.eval('window.__editorRO()')
  check('可写时 SQL 编辑器可输入（contenteditable=true）', roBefore === 'true', roBefore)
  const sw = await cdp.eval('window.__switchXY(\'只读\')')
  check('头部工具条有只读开关，且当前是可写', !!sw && sw.on === false, sw)
  // 只读提示按引擎给：SQLite 的白名单没有 SHOW/DESC（根本不是 MySQL），
  // 但有 VALUES/PRAGMA/WITH。以前所有引擎共用 MySQL 那句，于是
  // 「提示说可以、主进程照样拒」——照提示写 PRAGMA 的人会被自己的连接打回来。
  if (sw) {
    const tip = await hoverTip(sw.xy, path.join(SHOT_DIR, '1-readonly-tip.png'))
    check('SQLite 会话悬停只读开关出提示条', !!tip && /^只读模式/.test(String(tip)), tip)
    check('提示里是 SQLite 的口径（VALUES/PRAGMA 在白名单内）',
      !!tip && /VALUES/.test(tip) && /PRAGMA/.test(tip), tip)
    check('提示不再承诺 MySQL 才有的 SHOW/DESC（套错口径就是误导）',
      !!tip && !/SELECT \/ SHOW/.test(tip), tip)
    await click(sw.xy, 1200)
    const roAfter = await cdp.eval('window.__editorRO()')
    const swAfter = await cdp.eval('(window.__switchXY(\'只读\') || {}).on')
    // CM6 迁移（552d2b7c）把 isReadonly 接进了 EditorView.editable，而只读默认就是开的
    // （tab.readOnly !== false 即视为只读）——于是每个新建页签的 SQL 页一进来就打不了字：
    // 实测 .cm-content 的 contenteditable="false"，点进去 activeElement 还是 BODY。
    // 迁移前的 textarea 从来没有 readOnly 绑定，写语句由主进程白名单挡。这条判据专门盯这个回归。
    check('切只读后开关同步，编辑器仍可输入（只读挡执行，不挡打字）',
      roAfter === 'true' && swAfter === true, { roAfter, swAfter })
    const typedRo = await setSql('SELECT id, name FROM product LIMIT 2')
    check('只读开着时真键盘仍能整篇写入 SQL（回读一致）', typedRo === 'ok', typedRo)
    await cdp.shot(path.join(SHOT_DIR, '1b-readonly-typing.png'))
    const stRo = await execSql('SELECT id, name FROM product LIMIT 2', '只读下的 SELECT')
    const gRo = await cdp.eval('window.__resultGrid()')
    check('只读下的 SELECT 照常出结果（没有把读路径一起锁掉）',
      stRo === 'done' && gRo.rows.length === 2, { stRo, n: gRo.rows.length })
    const stRoW = await execSql('CREATE TABLE gate_ui(x)', '只读下的 DDL')
    if (stRoW === 'confirm') {
      await passRisk()
    }
    const alertRo = await cdp.eval('window.__errAlert()')
    check('只读下从界面点执行写语句，仍被主进程白名单拒绝',
      /read-only|只读/i.test((alertRo && alertRo.text) || ''), { stRoW, text: alertRo && alertRo.text })
    const gateUi = await readOne(SHOP,
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='gate_ui'")
    check('界面路径被拒的 DDL 没落进文件', String(gateUi) === '0', gateUi)
    await openSeg('数据')
    const idxAny = await cdp.eval('window.__rowIdxOf("鼠标")')
    await dblclick(await cdp.eval(`window.__cellXY('name', ${idxAny})`), 900)
    const roEditor = await cdp.eval('!!window.__cellEditor()')
    check('只读时双击单元格不再进编辑态', roEditor === false, roEditor)
    const ipc = await cdp.eval(`window.pre.runGlobalAsync('dbClientOp', ${J(shop.id)}, 'executeSql',
      { sql: 'CREATE TABLE gate_no(x)' }).then(() => 'ALLOWED').catch(err => 'REJECTED:' + String(err && err.message || err).slice(0, 90))`)
    check('只读时直接从渲染层发 IPC 写语句也被主进程拒绝（传参不算数）',
      /^REJECTED:/.test(String(ipc)), ipc)
    const gateFile = await readOne(SHOP,
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='gate_no'")
    check('被拒的写入没有落进文件', String(gateFile) === '0', gateFile)
    const sw2 = await cdp.eval('window.__switchXY(\'只读\')')
    await click(sw2.xy, 1000)
  }
  await cdp.shot(path.join(SHOT_DIR, '2-data-page.png'))

  // ================= B SQL 页方言与执行（sql.db） =================
  const sq = await openTab(SQL_TITLE, SQLDB, false)
  check('第二个 SQLite 会话（sql.db）连上', sq.ok, await cdp.eval('window.__headTarget()'))
  check('SQL 页签能打开且编辑器挂载', await openSqlSeg() === true)
  const dialect = await cdp.eval('window.__dialectChip()')
  check('编辑器状态栏方言标 SQLite（补全/格式化按 sqlite 走）', /SQLite/i.test(String(dialect)), dialect)

  const st1 = await execSql('SELECT id, s FROM seed ORDER BY id', 'seed 查询')
  const g1 = await cdp.eval('window.__resultGrid()')
  check('SELECT 走真驱动返回 3 行', st1 === 'done' && g1.rows.length === 3, { st1, n: g1.rows.length })

  await execSql("SELECT 'A' AS tag; SELECT 'B' AS tag", '多语句')
  const tabs = await cdp.eval('window.__resultTabs()')
  check('两条语句给出两个结果集页签', Array.isArray(tabs) && tabs.length === 2, tabs)

  // 反斜杠：只有真驱动能回答 length 是 3 还是 2
  await execSql("SELECT 'x\\y' AS v, length('x\\y') AS n", '反斜杠')
  const bv = await cdp.eval("window.__resCell('v', 0)")
  const bn = await cdp.eval("window.__resCell('n', 0)")
  check('反斜杠按普通字符算（格子里 x\\y 两个字符都在，length = 3 而不是 2）',
    bn === '3' && String(bv).indexOf('\\') >= 0 && String(bv).indexOf('y') >= 0, { bv, bn })

  await execSql('SELECT "s" FROM seed WHERE id = 1', '双引号标识符')
  const dv = await cdp.eval("window.__resCell('s', 0)")
  check('双引号当标识符用：SELECT "s" 出得来列 s 的值', dv === 'alpha', dv)
  const stE = await execSql('SELECT "nope" FROM seed', '不存在的列')
  const alertE = await cdp.eval('window.__errAlert()')
  check('双引号里的不存在列报 no such column（没被当字符串悄悄返回一个常量）',
    stE === 'error' && /no such column/i.test((alertE && alertE.text) || ''), alertE && alertE.text)

  const stH = await execSql('SELECT 1 AS one # tail', '# 号')
  const alertH = await cdp.eval('window.__errAlert()')
  check('# 不被当注释：SQLite 直接报 unrecognized token（而不是少执行一段）',
    stH === 'error' && /unrecognized token/i.test((alertH && alertH.text) || ''), alertH && alertH.text)
  check('执行错误的 Alert 带复制入口（U3-b 口径在 SQLite 同样生效）',
    !!alertH && alertH.actions.some(t => /复制|copy/i.test(t)), alertH && alertH.actions)

  const stC = await execSql('SELECT 1--1 AS v', '双横线')
  // `--` 后不需要空白：后半截整段是注释，发出去的就是 SELECT 1。
  // 按位置读而不是按列名读：结果列名是表达式本身，不同版本给的写法不一样，
  // 而这条用例真正要钉的是"注释没有把 1 变成 0，也没有把后半截当第二个条件"
  const gC = await cdp.eval('window.__resultGrid()')
  check('SELECT 1--1 返回 1（后半截是注释；同一句在 MySQL 口径是 0）',
    stC === 'done' && gC.rows.length === 1 && /^1$/.test(String(gC.rows[0][0])),
    { stC, heads: gC.heads, row0: gC.rows[0] })

  await execSql("SELECT ('a%b' LIKE 'a\\%b') AS no_esc, ('a%b' LIKE 'a\\%b' ESCAPE '\\') AS with_esc", 'LIKE ESCAPE')
  const lNo = await cdp.eval("window.__resCell('no_esc', 0)")
  const lYes = await cdp.eval("window.__resCell('with_esc', 0)")
  check('LIKE 默认不认反斜杠转义（0），显式 ESCAPE 才生效（1）',
    lNo === '0' && lYes === '1', { lNo, lYes })

  await execSql('PRAGMA table_info(seed)', 'PRAGMA')
  const gP = await cdp.eval('window.__resultGrid()')
  check('PRAGMA table_info 直读列信息（结构走 SQLite 原生口径）',
    gP.rows.length === 2 && /cid/.test(JSON.stringify(gP.heads)) && /pk/.test(JSON.stringify(gP.heads)), gP.heads)

  // 撞单次执行的行数上限：必须说出来，否则残缺结果会被当全量用
  const stR = await execSql(
    'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 12000) SELECT n FROM t',
    '递归 CTE 1.2 万行', 90000)
  const statusR = await cdp.eval('window.__status()')
  const noteR = await cdp.eval('window.__limitNote()')
  check('1.2 万行只取回 10000 行（主进程上限生效，状态行报的是拿到的行数）',
    stR === 'done' && /10000/.test(String(statusR)), { stR, statusR })
  check('结果区说明"已达上限、后面没取回"（不再静默截断）',
    /上限|limit/i.test(String(noteR)) && /10000/.test(String(noteR)), noteR)
  check('上限那句里没留下未替换的占位符（中文词条 {n} 出现两次）',
    !/\{n\}/.test(String(noteR)), noteR)
  await cdp.shot(path.join(SHOT_DIR, '3-row-limit.png'))

  // 危险确认：DROP 每次都要问；点取消 = 零执行
  await execSql('DROP TABLE dropme', 'DROP 确认')
  const risk = await cdp.eval('window.__risk()')
  check('DROP TABLE 触发危险确认弹层（E1 门在 SQLite 同样生效）', !!risk, risk && risk.text)
  check('弹层说清"凭什么拦"（高危级别 + 取消按钮在前）',
    !!risk && /高危|dangerous/i.test(String(risk.badge)) &&
      JSON.stringify(risk.btns).indexOf('取消') >= 0 && JSON.stringify(risk.btns).indexOf('仍要执行') >= 0,
    risk && { badge: risk.badge, btns: risk.btns, reason: risk.reason })
  const cancel = await cdp.eval('window.__riskClick(\'取消\')')
  await waitFor(cdp, '!window.__risk()', '取消后弹窗还在', 8000)
  const stillThere = await readOne(SQLDB,
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='dropme'")
  check('取消后表还在文件里（危险动作没被"顺手执行"）',
    cancel === 'ok' && String(stillThere) === '1', { cancel, stillThere })

  // EXPLAIN 计划
  await execSql('SELECT id, s FROM seed WHERE id > 1', 'explain 前置查询')
  const exBtn = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.db-sql-bar button')].filter(window.__vis)
      .find(x => x.querySelector('.anticon-node-index'))
    return b ? window.__xy(b) : null
  })()`)
  check('SQL 工具行有「解释」入口', !!exBtn, exBtn)
  if (exBtn) {
    await click(exBtn, 3200)
    const types = await cdp.eval('window.__explainTypes()')
    const planText = await cdp.eval('window.__explainText()')
    check('EXPLAIN QUERY PLAN 归一成计划节点（含 SCAN/SEARCH）',
      types.length > 0 && types.some(t => /SCAN|SEARCH/.test(t)), { types, planText: String(planText).slice(0, 160) })
    const cx = await cdp.eval('window.__closeModalXY()')
    if (cx) await click(cx, 700)
  }

  // 数据页分页：500 行的表按 200/页，第 2 页首行是 201（OFFSET 真的下推给 SQL）
  // page_t 在 sql.db 里（shop.db 只有 product/v_price），选错会话就是查不到节点
  await activate(sq.id)
  await openSeg('数据')
  const pt = await selectTable('page_t')
  check('切到 500 行的 page_t', pt === 'ok', pt)
  const psXY = await cdp.eval('window.__pageSizeXY()')
  if (!psXY) {
    skip('把每页行数调到 200', '找不到每页行数下拉框')
  } else {
    await click(psXY, 900)
    const opt = await cdp.eval('window.__optXY(\'^200\')')
    check('每页行数候选含 200（渲染侧上限）', !!opt, opt)
    if (opt) {
      await click(opt, 1200)
      const got200 = await waitFor(cdp, '/200/.test(String(window.__dataGrid().pageRows || \'\'))',
        '每页没变成 200 行', 15000)
      const dg200 = await cdp.eval('window.__dataGrid()')
      check('每页 200 行：状态口径是"本页 200 行"（500 行不整体塞进渲染层）',
        got200 && /200/.test(String(dg200.pageRows)), dg200 && dg200.pageRows)
      const pg = await cdp.eval('window.__pager()')
      check('分页器给出页码（1 / 3）', !!pg && /1/.test(String(pg.pageNo)), pg && pg.pageNo)
      if (pg && pg.nextXY) {
        await click(pg.nextXY, 1000)
        const p2 = await waitFirstCell('id', '201', 15000)
        const pg2 = await cdp.eval('window.__pager()')
        check('翻到第 2 页首行 id=201（LIMIT/OFFSET 下推给数据库，不是前端切片）',
          p2 && /2/.test(String(pg2 && pg2.pageNo)), { p2, pageNo: pg2 && pg2.pageNo })
      }
    }
  }

  // 写入落盘 + 关页签重开仍在
  await activate(sq.id)
  await openSqlSeg()
  const stW = await execSql(
    "CREATE TABLE h8a_persist(k TEXT); INSERT INTO h8a_persist VALUES('written-by-electerm')",
    '建持久表')
  check('DDL 批语句先过危险确认（不静默执行）', stW === 'confirm', stW)
  const passed = await passRisk()
  await waitFor(cdp, '!!(window.__status() || window.__affected() || window.__errAlert())', '放行后没有终态', 20000)
  const persisted = await readOne(SQLDB, 'SELECT k FROM h8a_persist LIMIT 1')
  check('放行后宿主直读得到写入内容（真落盘）',
    passed === 'ok' && persisted === 'written-by-electerm', { passed, persisted })
  await cdp.eval(`window.store.delTab(${J(sq.id)})`)
  await sleep(1800)
  const reopen = await openTab(SQL_TITLE + '-2', SQLDB, false)
  const reopened = await selectTableOn(reopen.id, 'h8a_persist')
  const persistRows = await cdp.eval('window.__dataRows()')
  check('关掉页签再重开，写入仍在同一个文件（不是只在内存里演一遍）',
    reopen.ok && reopened === 'ok' && JSON.stringify(persistRows).includes('written-by-electerm'), persistRows)

  // ---- 另一套主题下的落地效果 ----
  const themeIds = JSON.parse(await cdp.eval('JSON.stringify((window.store.getItems("terminalThemes") || []).map(t => t.id))'))
  const curTheme = await cdp.eval('window.store._config && window.store._config.theme')
  const lightId = themeIds.find(id => /light|day/i.test(String(id)))
  if (lightId) {
    await cdp.eval(`window.store.setTheme(${J(lightId)})`)
    await sleep(1600)
    const dgLight = await cdp.eval('window.__dataGrid()')
    check('浅色主题下数据网格仍在（切主题不丢会话、表头没塌）',
      !!dgLight && dgLight.heads.length > 0, dgLight)
    await cdp.shot(path.join(SHOT_DIR, '4-theme-light.png'))
    await cdp.eval(`window.store.setTheme(${J(curTheme)})`)
    await sleep(900)
  } else {
    skip('浅色主题下的呈现', '主题列表里没有 light/day 变体：' + JSON.stringify(themeIds))
  }

  const left = await clearDbTabs(cdp)
  if (left.left.length) {
    console.log('WARN 收尾仍有未关闭的数据库页签', JSON.stringify(left.left))
  }
  console.log('\nEVENTS', JSON.stringify(cdp.tail(8)))
  const bad = results.filter(r => !r.ok)
  const skipped = results.filter(r => r.skipped)
  // 逐条再打一遍失败项：长日志里 FAIL 行会被别的输出冲散（实测同一份日志被
  // 实例 stderr 覆盖掉十几行），只有末尾这份清单是可信的失败全集
  for (const b of bad) {
    console.log('FAILED → ' + b.name + (b.detail === undefined ? '' : ' :: ' + JSON.stringify(b.detail)))
  }
  console.log(`\n${results.length - bad.length - skipped.length}/${results.length} 条通过（跳过 ${skipped.length} 条）`)
  cdp.ws.close()
  process.exit(bad.length ? 1 : 0)
}

// 宿主侧直读文件：界面报的写动作必须真的落到 sqlite 文件里
function readOne (file, sql) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare(sql).get()
    if (!row) {
      return null
    }
    const k = Object.keys(row)[0]
    return row[k] === null ? null : String(row[k])
  } finally {
    db.close()
  }
}

function writeShop () {
  rmDb(SHOP)
  const db = new DatabaseSync(SHOP)
  db.exec('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT, price REAL, note TEXT)')
  const ins = db.prepare('INSERT INTO product(id, name, price, note) VALUES(?, ?, ?, ?)')
  ins.run(1, '键盘', 299.5, null)
  // 三类"容易被转义吞掉"的字面值：单引号、反斜杠+LIKE 元字符、逗号+双引号
  ins.run(2, "鼠标'带引号", 88, 'esc \\ % _ test')
  ins.run(3, '显示器', 1899, '1920×1080')
  ins.run(4, 'USB-C 扩展坞', 349.9, 'a,b"c')
  db.exec('CREATE VIEW v_price AS SELECT name, price FROM product WHERE price > 100')
  db.close()
}

function writeSqlDb () {
  rmDb(SQLDB)
  const db = new DatabaseSync(SQLDB)
  db.exec('CREATE TABLE seed(id INTEGER PRIMARY KEY, s TEXT)')
  const ins = db.prepare('INSERT INTO seed(id, s) VALUES(?, ?)')
  ins.run(1, 'alpha')
  ins.run(2, 'beta')
  ins.run(3, 'gamma')
  // 分页判据用的 500 行表
  db.exec('CREATE TABLE page_t(id INTEGER PRIMARY KEY, g TEXT)')
  const p = db.prepare('INSERT INTO page_t(id, g) VALUES(?, ?)')
  for (let i = 1; i <= 500; i++) {
    p.run(i, 'g' + i)
  }
  // 危险确认用：取消后必须它还在（所以预先建好，不靠界面建）
  db.exec('CREATE TABLE dropme(x TEXT)')
  db.prepare('INSERT INTO dropme VALUES(\'keep me\')').run()
  db.close()
}

// WAL/SHM 一起清：只删主文件会留下上一次的 -wal，新库读到旧数据
function rmDb (file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = file + suffix
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true })
    }
  }
}

main().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exit(1)
})
