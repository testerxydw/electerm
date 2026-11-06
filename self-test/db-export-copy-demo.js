#!/usr/bin/env node
/**
 * N11a 第 3 步的实机验收 —— 导出/复制簇（数据页 + SQL 结果共 11 个函数）从
 * db-session.jsx 搬到 use-db-export.js 之后，行为必须一模一样。
 *
 * 为什么这一段必须实机（源码契约单测钉不住）：
 * - hook 的实参里有 visibleColumnNames / pkColumn 这类**渲染期求值**的页面闭包，
 *   调用点排错一位就是 TDZ，页面直接白屏 —— 单测读源码是读不出顺序的；
 * - 导出口径三条（范围 / 列序 / 落地）跨两个文件：范围与列序在 hook，列序的
 *   数据源（隐藏列集合）在页面。断一条注入，单测全绿也照样把隐藏列导出去；
 * - 下载与剪贴板都是真副作用：这里拦在 createObjectURL + a.click / writeClipboard
 *   这一层读正文（真点会弹系统保存框，无头实例会卡死）。
 *
 * 覆盖（数字一律从夹具与拦到的正文现算，不写死命中数）：
 *   E1 无选中导出 CSV = 当前页全部可见行 + 列序为全列，且不含 __rowKey
 *   E2 勾选两行后导出 = 只导选中（selectedRowKeys 注入生效）
 *   E3 复制为 INSERT 与导出 SQL 同源：选中口径一致、语句条数 = 选中行数
 *   E4 隐藏一列后导出 CSV：该列既不出现在表头也不出现在数据行（visibleColumnNames 注入生效）
 *   E5 SQL 结果导出 CSV：列序取 fields（不是首行键），正文是整份结果不受结果分页影响
 *   E6 SQL 结果单元格右键"复制整行 TSV"：菜单留在页面、列序仍取导出的那一套
 *   E7 全程无未捕获异常
 *
 * 用法：
 *   1) npm run compile
 *   2) DISPLAY=:136 HOME=/tmp/electerm-n11a/home TMPDIR=/tmp/electerm-n11a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9372 --no-sandbox --window-size=1600,1000
 *   3) TMPDIR=/tmp/electerm-n11a/tmp node self-test/db-export-copy-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9372'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-export-copy-shots')
const DEMO_DIR = path.join(os.tmpdir(), 'electerm-n11a', 'demo')
const STAMP = String(Date.now()).slice(-6)
const DB = path.join(DEMO_DIR, 'export-' + STAMP + '.db')
const TITLE = 'n11a-export'
const ROWS = 12
// 库文件每次跑新建：视角（隐藏列/列序/列宽）与元数据缓存都是按库/表存盘的，
// 沿用同一个文件会继承上一轮 hide 掉的列，E1 的「表头三列」就变成在测别人留下的状态
const TABLE = 'note_t'
const PAGE = 10

const { check, results } = makeChecker()

const DUMP_ICONS = `[...document.querySelectorAll('.anticon-download')].map(i => {
  const b = i.closest('button')
  const box = b && b.closest('div')
  return { vis: !!(b && window.__vis(b)), in: b && b.parentElement.className }
})`
const DUMP_MENU = `[...document.querySelectorAll('.ant-dropdown')].filter(window.__vis)
  .map(d => [...d.querySelectorAll('.ant-dropdown-menu-item')].map(x => x.innerText.trim()))`
const J = s => JSON.stringify(s)

// 夹具：12 行三列。id 连续好核对；body 里带逗号与引号，专门用来抓"导出转义坏掉"
const writeFixture = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  if (fs.existsSync(DB)) {
    fs.rmSync(DB, { force: true })
  }
  const db = new DatabaseSync(DB)
  db.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, body TEXT, tag TEXT)`)
  const ins = db.prepare(`INSERT INTO ${TABLE} (id, body, tag) VALUES (?, ?, ?)`)
  for (let i = 1; i <= ROWS; i++) {
    ins.run(i, i % 4 === 0 ? 'has, comma and "quote"' : `body ${i}`, 't' + i)
  }
  db.close()
}

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
    if (!r.width || !r.height || window.__hidden(el)) return false
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  // 可见按钮：按图标认，不按下标（工具条会随只读/选中状态增减按钮，下标一定漂）
  window.__iconBtnXY = icon => {
    const i = [...document.querySelectorAll('.anticon-' + icon)].filter(window.__vis)[0]
    const b = i && i.closest('button')
    return b && window.__vis(b) ? window.__xy(b) : null
  }
  // 下拉项按文案找：文案现场从词条取，不写死中英文
  // 结果/数据单元格右键菜单是自建浮层 DbCellMenu（.db-cell-menu-item），不是 antd 下拉
  window.__cellMenuXY = label => {
    const el = [...document.querySelectorAll('.db-cell-menu-item')]
      .filter(n => window.__vis(n) && (n.innerText || '').trim() === label)[0]
    return el ? window.__xy(el) : null
  }
  window.__cellMenuOpen = () => [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis).length
  window.__menuXY = label => {
    const el = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .filter(n => window.__vis(n) && (n.innerText || '').trim() === label)[0]
    return el ? window.__xy(el) : null
  }
  window.__headTarget = () => {
    const el = [...document.querySelectorAll('.db-head-target')].filter(window.__vis)[0]
    return el ? (el.innerText || '').trim() : null
  }
  window.__treeNodeXY = t => {
    const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => (n.innerText || '').trim().indexOf(t) >= 0)
    for (const el of all) {
      el.scrollIntoView({ block: 'center' })
      if (window.__vis(el)) return window.__xy(el)
    }
    return null
  }
  window.__collapsedSwitcherXY = () => {
    const el = [...document.querySelectorAll('.db-tree .ant-tree-switcher_close')].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  // 数据页 / SQL 页的切换是页签，不是 Segmented
  window.__segXY = label => {
    const el = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')]
      .filter(window.__vis).find(x => (x.innerText || '').replace(/\\s/g, '').indexOf(label) >= 0)
    return el ? window.__xy(el) : null
  }
  window.__edXY = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    if (!ed) return null
    const r = ed.getBoundingClientRect()
    return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + Math.min(20, r.height / 2)) }
  }
  window.__sqlDoc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(window.__vis)[0]
    return ed ? String(ed.innerText || '').replace(/\\s+/g, ' ').trim() : 'no-editor'
  }
  window.__runBtnXY = () => {
    const b = [...document.querySelectorAll('.db-sql-bar button')].filter(window.__vis)
      .find(x => /^执行$|^run$/i.test(x.innerText.replace(/\\s/g, '')))
    return b ? window.__xy(b) : null
  }
  window.__pageRows = () => [...document.querySelectorAll('.db-grid-area .ant-table-row')].filter(window.__vis).length
  // 行勾选框：按数据行顺序取第 i 个（表头"全选"是 thead 里的，不会跟着进来）
  // 点 .ant-checkbox-wrapper，不点 .ant-checkbox-input：后者是 opacity:0 的隐形输入，
  // 命中测试一定判它"不可见"（点了等于没点）
  // 网格开了虚拟滚动：DOM 里只有视口那几行，且不在 tbody 里。选择器按"行节点"限定，
  // 表头那个全选勾选框不在 .ant-table-row 里，不会混进来
  window.__rowCheckXY = i => {
    const boxes = [...document.querySelectorAll('.db-grid-area .ant-table-row .ant-checkbox-wrapper')].filter(window.__vis)
    return boxes[i] ? window.__xy(boxes[i]) : null
  }
  window.__rowCount = () => [...document.querySelectorAll('.db-grid-area .ant-table-row .ant-checkbox-wrapper')].filter(window.__vis).length
  // 第 i 行的 id 单元格文本：E2 拿它核对"导出的就是勾的那两行"，而不是写死 1,2
  window.__rowIdAt = i => {
    const tr = [...document.querySelectorAll('.db-grid-area .ant-table-row')].filter(window.__vis)[i]
    if (!tr) return null
    // 第 0 格是勾选列（空文本），取第一个有内容的格子当 id
    const cell = [...tr.children].map(td => (td.innerText || '').trim()).find(x => x)
    return cell || null
  }
  // 结果网格第一行第 c 列的格子中心（右键菜单的落点）
  window.__sqlCellXY = (r, c) => {
    const rows = [...document.querySelectorAll('.db-sql-area .db-sql-result-grid .ant-table-row')].filter(window.__vis)
    const td = rows[r] && rows[r].children[c]
    return td ? window.__xy(td) : null
  }
  window.__sqlRowTexts = () => [...document.querySelectorAll('.db-sql-area .db-sql-result-grid .ant-table-row')]
    .filter(window.__vis).map(tr => [...tr.children].map(td => td.innerText.trim()))

  // ---- 两条落地通道都拦下来读正文 ----
  // 下载：真点 a[download] 会弹系统保存框（无头实例卡死），拦在 createObjectURL 这层
  window.__dlCapture = () => {
    if (window.__dlOn) return 'ok'
    window.__dlLog = []
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
          b.text().then(t => window.__dlLog.push({ name: this.download, type: b.type, text: t }))
        }
        return
      }
      return origClick.apply(this, arguments)
    }
    window.__dlOn = true
    return 'ok'
  }
  window.__dl = () => (window.__dlLog || []).slice(-1)[0] || null
  window.__dlCount = () => (window.__dlLog || []).length
  // 剪贴板：copy() 最终落到 window.pre.writeClipboard，拦这一层就拿到复制文本
  window.__clipCapture = () => {
    if (window.__clipOn) return 'ok'
    window.__clipLog = []
    const orig = window.pre.writeClipboard.bind(window.pre)
    window.pre.writeClipboard = s => {
      window.__clipLog.push(String(s))
      return orig(s)
    }
    window.__clipOn = true
    return 'ok'
  }
  window.__clip = () => (window.__clipLog || []).slice(-1)[0] || null
  window.__clipCount = () => (window.__clipLog || []).length

  // CSV 现算：第一行是表头，其余是数据行（末行空串丢掉）
  window.__csv = () => {
    const d = window.__dl()
    if (!d) return null
    const lines = d.text.replace(/\\r\\n/g, '\\n').split('\\n').filter(x => x.length)
    return { name: d.name, head: lines[0], n: lines.length - 1, lines, text: d.text }
  }
  // 列显隐浮层里按列名点掉/勾上一列
  window.__colCheckXY = name => {
    const el = [...document.querySelectorAll('.db-cols-pop-name')]
      .filter(n => window.__vis(n) && (n.title || '') === name)[0]
    const wrap = el && el.closest('label')
    return wrap && window.__vis(wrap) ? window.__xy(wrap) : null
  }
  return 'helpers-ok'
})()`

const main = async () => {
  writeFixture()
  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) {
    throw new Error('端口 ' + PORT + ' 上没有页面目标')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  // 必须跑在刚构建的包上：实例常常先于 compile 启动，不重载就是在测上一版界面
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, '!!document.querySelector(".bookmark-sidebar-toggle")', '应用未就绪', 40000)) {
    throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  }
  await sleep(1500)
  await cdp.eval(HELPERS)
  await cdp.eval('window.__dlCapture()')
  await cdp.eval('window.__clipCapture()')

  const park = async () => {
    await cdp.move(1560, 940)
    await sleep(280)
  }
  const click = async (p, ms = 450) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
    await park()
  }
  const rightClick = async p => {
    if (!p) throw new Error('右键目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 })
    await sleep(600)
  }
  const type = async text => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.insertText', { text })
    await sleep(600)
  }
  // 菜单项文案现场从词条取
  const t = async key => await cdp.eval(`window.translate(${J(key)})`)
  // 导出下拉 → 点某一项 → 等拦到第 n 份下载
  // 全站两类下拉都在用：默认 hover 型（数据页导出）与 trigger='click' 型（SQL 结果导出）。
  // 先移过去等菜单自己开，等不到再点 —— 对 click 型是打开，对 hover 型是无害重申
  const visibleItem = () => cdp.eval(
    '[...document.querySelectorAll(".ant-dropdown-menu-item")].some(window.__vis)')
  // 全站两类下拉都在用：默认 hover 型（数据页导出）与 trigger='click' 型（SQL 结果导出）。
  // hover 型要靠"真的移进去"触发 mouseenter：菜单刚关那一拍鼠标还停在原地，
  // 只发一次同坐标的 mouseMoved 不一定重放进入事件（实测第二页起就打不开），
  // 所以先偏一点再进来，并留三次重试
  const openMenu = async icon => {
    const b = await cdp.eval(`window.__iconBtnXY(${J(icon)})`)
    if (!b) {
      throw new Error('找不到图标按钮 ' + icon + ' :: 可见同类图标 ' + JSON.stringify(await cdp.eval(DUMP_ICONS)))
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await cdp.move(b.x - 24, b.y - 18)
      await sleep(120)
      await cdp.move(b.x, b.y)
      await sleep(400)
      if (await visibleItem()) return
      await cdp.click(b.x, b.y)
      await sleep(400)
      if (await visibleItem()) return
      await cdp.move(1560, 940)
      await sleep(300)
    }
    throw new Error('下拉菜单没开 ' + icon + ' :: ' + JSON.stringify(await cdp.eval(DUMP_MENU)))
  }
  const exportVia = async (icon, itemLabel) => {
    const before = await cdp.eval('window.__dlCount()')
    await openMenu(icon)
    const mi = await cdp.eval(`window.__menuXY(${J(itemLabel)})`)
    if (!mi) {
      throw new Error('下拉里没有 ' + itemLabel + ' :: ' + JSON.stringify(await cdp.eval(DUMP_MENU)))
    }
    await click(mi, 500)
    const got = await waitFor(cdp, `window.__dlCount() > ${before}`, '没拦到下载', 8000)
    return got ? await cdp.eval('window.__csv()') : null
  }
  const copyVia = async (icon, itemLabel) => {
    const before = await cdp.eval('window.__clipCount()')
    await openMenu(icon)
    const mi = await cdp.eval(`window.__menuXY(${J(itemLabel)})`)
    if (!mi) {
      throw new Error('下拉里没有 ' + itemLabel + ' :: ' + JSON.stringify(await cdp.eval(DUMP_MENU)))
    }
    await click(mi, 600)
    return waitFor(cdp, `window.__clipCount() > ${before}`, '没拦到复制', 8000)
      ? await cdp.eval('window.__clip()')
      : null
  }

  await clearDbTabs(cdp)
  // 每页钉成 10：不写死就是在继承别人留下的 config
  await cdp.eval(`window.store.setConfig({ dbPageSize: ${PAGE} })`)
  await sleep(600)

  await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database',
      from: 'quick-connect',
      title: ${J(TITLE)},
      dbType: 'sqlite',
      dbFile: ${J(DB)},
      readOnly: true,
      production: false,
      batch: window.store.currentLayoutBatch
    })
    const tb = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(tb.id)
    return tb.id
  })()`)
  const connected = await waitFor(cdp,
    '!!(window.__headTarget() && window.__headTarget().indexOf(\'export-\') >= 0)',
    '会话头部等不到库文件名', 25000)
  check('E0 SQLite 会话连上（导出的宿主页面存在）', connected, await cdp.eval('window.__headTarget()'))

  for (let i = 0; i < 4; i++) {
    const sw = await cdp.eval('window.__collapsedSwitcherXY()')
    if (!sw) break
    await click(sw, 700)
  }
  const nodeXY = await cdp.eval('window.__treeNodeXY(' + J(TABLE) + ')')
  if (!nodeXY) {
    console.log('DEBUG 树节点文本：', JSON.stringify(await cdp.eval(
      '[...document.querySelectorAll(".db-tree .ant-tree-node-content-wrapper")].map(n => (n.innerText || "").trim()).slice(0, 20)')))
  }
  await click(nodeXY, 1500)
  const gridOk = await waitFor(cdp, 'window.__pageRows() > 0', '数据网格没出行', 20000)
  const shown = await cdp.eval('window.__pageRows()')
  // 这里不断言 shown === PAGE：虚拟滚动只挂视口行（实测 10 行的一页只渲染 8 行）。
  // "导出的范围 = 当前页 10 行"由 E1 的正文行数证明，不由 DOM 行数证明
  check('E0 点开 note_t 数据页（出行、行勾选框可用）',
    gridOk === true && shown > 0 && (await cdp.eval('window.__rowCount()')) === shown,
    { shown, boxes: await cdp.eval('window.__rowCount()') })

  // ---- E1 无选中导出 CSV：范围=当前页，列序=全列，且不含内部辅助键 ----
  const c1 = await exportVia('download', 'CSV')
  check('E1 无选中导出 CSV = 当前页 10 行、表头三列、文件名带表名与时间戳',
    !!c1 && c1.n === PAGE && /^"?id"?,"?body"?,"?tag"?/.test(c1.head) &&
    new RegExp('^db-[^-]*-' + TABLE + '-\\d{8}-\\d{6}\\.csv$').test(c1.name),
    c1 && { name: c1.name, head: c1.head, n: c1.n })
  check('E1 导出正文没有 __rowKey（网格辅助键不是数据列）',
    !!c1 && c1.text.indexOf('__rowKey') < 0, c1 && c1.head)

  // ---- E2 勾选两行：范围口径跟着选中走 ----
  const want2 = [
    await cdp.eval('window.__rowIdAt(0)'),
    await cdp.eval('window.__rowIdAt(1)')
  ]
  await click(await cdp.eval('window.__rowCheckXY(0)'), 500)
  await click(await cdp.eval('window.__rowCheckXY(1)'), 500)
  const c2 = await exportVia('download', 'CSV')
  const ids2 = c2 ? c2.lines.slice(1).map(l => l.split(',')[0]) : []
  check('E2 勾选 2 行后导出 = 只导这 2 行（selectedRowKeys 注入生效）',
    !!c2 && c2.n === 2 && ids2.join(',') === want2.join(','), { n: c2 && c2.n, ids: ids2, want2 })

  // ---- E3 复制为 INSERT / 导出 SQL 同源：同一份选中、同一套语句生成 ----
  const clipSql = await copyVia('copy', await t('dbCopyInsert'))
  const insCount = clipSql ? (clipSql.match(/INSERT INTO/gi) || []).length : 0
  check('E3 复制为 INSERT 走选中口径（2 行 = 2 条语句、表名在内）',
    !!clipSql && insCount === 2 && /note_t/.test(String(clipSql)),
    { insCount, head: String(clipSql || '').slice(0, 60) })

  const c3 = await exportVia('download', await t('dbExportSql'))
  const expIns = c3 ? (c3.text.match(/INSERT INTO/gi) || []).length : 0
  check('E3 导出 SQL 与复制 INSERT 语句数一致（同一 buildCopyStatements 核心）',
    !!c3 && expIns === insCount, { expIns, insCount })

  // ---- E4 隐藏 body 列：列序注入断掉的话，这一列会照常出现在导出里 ----
  await click(await cdp.eval('window.__iconBtnXY(\'menu\')'), 800)
  const hide = await waitFor(cdp, "!!window.__colCheckXY('body')", '列显隐浮层等不到 body 那一行', 8000)
  await click(await cdp.eval("window.__colCheckXY('body')"), 800)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(700)
  const c4 = await exportVia('download', 'CSV')
  check('E4 隐藏 body 列后导出不含该列（visibleColumnNames 注入生效）',
    hide === true && !!c4 && c4.head.indexOf('body') < 0 && /^"?id"?,"?tag"?/.test(c4.head),
    c4 && { head: c4.head, n: c4.n })

  // ---- E5/E6 SQL 结果侧：列序取 fields、导出的是整份结果 ----
  await click(await cdp.eval('window.__segXY(\'SQL\')'), 1200)
  const edOk = await waitFor(cdp, '!!window.__edXY()', 'SQL 编辑器未挂载', 15000)
  await click(await cdp.eval('window.__edXY()'), 400)
  await type('SELECT id, body, tag FROM ' + TABLE + ' ORDER BY id')
  await click(await cdp.eval('window.__runBtnXY()'), 1800)
  const rows5 = await waitFor(cdp, 'window.__sqlRowTexts().length > 0', 'SQL 结果没出行', 20000)
  check('E5 SQL 页执行 SELECT 出结果（12 行全在，结果分页不影响导出）',
    edOk === true && rows5 === true, { n: (await cdp.eval('window.__sqlRowTexts()')).length })

  const c5 = await exportVia('download', 'CSV')
  check('E5 SQL 结果导出 CSV = 整份 12 行、表头取 fields（id,body,tag）',
    !!c5 && c5.n === ROWS && /^"?id"?,"?body"?,"?tag"?/.test(c5.head),
    c5 && { name: c5.name, head: c5.head, n: c5.n })

  const cell = await cdp.eval('window.__sqlCellXY(0, 1)')
  await rightClick(cell)
  const labelTsv = await t('dbCellCopyRowTsv')
  const menuOk = await waitFor(cdp, `!!window.__cellMenuXY(${J(labelTsv)})`, '结果单元格菜单没出', 8000)
  if (!menuOk) {
    console.log('DEBUG 单元格菜单：open=', await cdp.eval('window.__cellMenuOpen()'),
      'items=', JSON.stringify(await cdp.eval(
        '[...document.querySelectorAll(".db-cell-menu-item")].map(x => x.innerText.trim())')))
  }
  await click(await cdp.eval(`window.__cellMenuXY(${J(labelTsv)})`), 700)
  const clipTsv = await cdp.eval('window.__clip()')
  const tsvHead = String(clipTsv || '').split('\n')[0].split('\t')
  check('E6 结果单元格右键「复制整行 TSV」仍在且列序与导出同源（3 列）',
    menuOk === true && tsvHead.length === 3 && tsvHead[0] === 'id',
    { menuOk, tsvHead, clip: String(clipTsv || '').slice(0, 40) })

  check('E7 全程无未捕获异常', cdp.events.filter(x => x.method === 'Runtime.exceptionThrown').length === 0,
    cdp.tail(3))

  const bad = results.filter(r => !r.ok)
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' 条通过')
  console.log('EVENTS', JSON.stringify(cdp.events.filter(x => x.method === 'Runtime.exceptionThrown').slice(0, 3)))
  // CDP socket 不关会让 node 事件循环一直挂着（探针"跑完了但不退出"）
  process.exit(bad.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.message)
  process.exit(1)
})
