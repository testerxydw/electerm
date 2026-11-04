#!/usr/bin/env node
/**
 * 列聚合摘要（.db-cell-summary）的字体链 —— 实机验收（台账 §1 收口后的自查项）
 *
 * 背景：B3-1 的列聚合摘要（选中单元格后出现在网格工具条上的 Σ/⌀/min/max 那一行）
 * 写的是 `font-family var(--font-mono, monospace)` —— 数据库页里唯一绕过
 * `--db-code-font` 数据面字体链的地方。后果不是"不好看"：electerm 出厂自带的
 * fontFamily 就是一条具体字体栈（本机实测 'Maple Mono, mono, …'），于是整张网格按
 * 它渲染、唯独这一行退回 `--font-mono` 那条完全不同的栈 —— 数字与单元格字宽对不上，
 * 它自己注释承诺的"Σ/⌀ 数值跳动时不会左右抖"也不成立。
 *
 * 为什么单测的红/绿自证不够，还要实机：
 *   `css-tokens.spec.js` 那条反向守卫当时写成 includes('font-family var(--font-mono)')，
 *   **带兜底的写法 var(--font-mono, monospace) 正好从缝里漏出去**（本轮已收紧，见该 spec，
 *   并把 .db-cell-summary 加进数据面选择器枚举）。守卫钉"声明长什么样"，钉不住四件
 *   只能真机看的事：
 *     1) 令牌真的续到这一行（wrapper 注入 → 摘要 span 的 computed 值）；
 *     2) 三级回落（tab.fontFamily → config.fontFamily → --font-mono）逐级的实际值；
 *     3) 改造前后**同帧可观测**：页面里挂一个用旧声明的对照节点，同一父层同一环境，
 *        新的跟随、旧的不跟随 —— 不靠二次构建旧版也能拿到 before/after；
 *     4) 改动只落数据面 —— 会话头部标签、数据库树这些界面文字不许跟着变等宽。
 *
 * 判据只读**字体族名字符串**与聚合行文本；夹具是脚本在 os.tmpdir() 里造的真 SQLite
 * 文件（假商品价格表，无凭据、无生产库名），截图可进仓库。
 *
 * 用法：
 *   1) npm run compile
 *   2) D=$(mktemp -d /tmp/electerm-cellfont-run-XXXX) && mkdir -p $D/{home,config,data,tmp}
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data TMPDIR=$D/tmp \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9251 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/db-cell-summary-font-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9251'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-cell-summary-font-shots')
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-cellfont-'))
const FIXTURE = path.join(RUN_DIR, 'prices.db')
const COL = 'unit_price'
const TAB_A = 'cellfont-a'
const TAB_B = 'cellfont-b'
// 本机装过、且都不在 tokens.styl 的 --font-mono 栈里：这样"跟随/不跟随"是可判的
const DIST_CONFIG = 'Liberation Mono'
const DIST_TAB = 'DejaVu Sans Mono'

const { check, results } = makeChecker()
const J = s => JSON.stringify(s)
// computed 的字体栈会被规范化（引号、空格），比对前先削平（连逗号也削掉，
// 否则"栈里是否含某族"要按每个族名分别比，反而更脆）
const flat = s => String(s || '').replace(/["',\s]/g, '').toLowerCase()
const eq = (a, b) => flat(a) === flat(b)
const has = (fam, font) => !!fam && !!font && flat(fam).includes(flat(font))
const monoReal = fam => !!fam && flat(fam) !== 'monospace'
const isAgg = t => /Σ/.test(String(t || '')) && /⌀/.test(String(t || ''))

const HELPERS = `(() => {
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  }
  window.__wrap = () => [...document.querySelectorAll('.db-session-wrap')].filter(window.__vis)[0] || null
  // 数据页网格（SQL 结果网格是 .db-sql-result-grid，这里要的是数据页那一张）
  window.__grid = () => {
    const w = window.__wrap()
    if (!w) return null
    return [...w.querySelectorAll('.db-grid-table-wrap')].filter(window.__vis)[0] || null
  }
  window.__gridRows = () => {
    const g = window.__grid()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  // 一格：虚拟滚动的行里单元格不一定是 td，按行取子节点更稳
  window.__firstCell = () => {
    const rows = window.__gridRows()
    const tr = rows[0]
    if (!tr) return null
    return tr.querySelector('td') || tr.querySelector('.ant-table-cell') || tr.children[0] || null
  }
  window.__switchXY = () => {
    const w = window.__wrap()
    if (!w) return null
    const s = [...w.querySelectorAll('.db-tree .ant-tree-switcher_close')].filter(window.__vis)[0]
    if (!s) return null
    const r = s.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__nodeXY = text => {
    const w = window.__wrap()
    if (!w) return null
    const n = [...w.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(x => window.__vis(x) && x.innerText.trim().indexOf(text) >= 0)[0]
    if (!n) return null
    const r = n.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__colIdx = label => {
    const g = window.__grid()
    if (!g) return -1
    const ths = [...g.querySelectorAll('thead th')].filter(window.__vis)
    for (let i = 0; i < ths.length; i++) {
      const n = ths[i].querySelector('.db-col-name')
      const t = ((n && n.innerText) || ths[i].innerText || '').trim().split('\\n')[0]
      if (t === label) return i
    }
    return -1
  }
  window.__cellXY = (label, rowIdx) => {
    const g = window.__grid()
    if (!g) return JSON.stringify({ error: 'no-grid' })
    const idx = window.__colIdx(label)
    if (idx < 0) return JSON.stringify({ error: 'no-col:' + label })
    // 数据页有勾选列：表头与行都按同一序号取，不然"看着对、实际错一列"
    const tr = window.__gridRows()[rowIdx || 0]
    if (!tr) return JSON.stringify({ error: 'no-row' })
    const td = tr.children[idx]
    if (!td) return JSON.stringify({ error: 'no-td' })
    const r = td.getBoundingClientRect()
    const gb = g.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + Math.min(r.width / 2, 60)),
      y: Math.round(r.top + r.height / 2),
      inView: r.left >= gb.left - 2 && r.right <= gb.right + 2,
      text: td.innerText.trim().substring(0, 12)
    })
  }
  // 一次读齐"数据面 / 界面 / 改造前对照"三组 computed 字体
  window.__fonts = () => {
    const w = window.__wrap()
    if (!w) return null
    const sum = [...w.querySelectorAll('.db-cell-summary')].filter(window.__vis)[0] || null
    const cell = window.__firstCell()
    const nul = sum ? sum.querySelector('.db-cell-summary-null') : null
    const fam = el => (el ? getComputedStyle(el).fontFamily : null)
    // 对照节点：改造前那一行的声明，挂在摘要的同一个父层里，同帧同环境比
    const ctrl = document.createElement('span')
    ctrl.style.fontFamily = 'var(--font-mono, monospace)'
    ctrl.textContent = '0'
    ;(sum ? sum.parentElement : w).appendChild(ctrl)
    const out = {
      // inline 是 React 到底有没有写这个自定义属性，computed 是 CSS 侧读到的值
      tokenInline: w.style.getPropertyValue('--db-code-font'),
      token: getComputedStyle(w).getPropertyValue('--db-code-font').trim(),
      mono: getComputedStyle(w).getPropertyValue('--font-mono').trim(),
      ui: fam(document.body),
      sum: fam(sum),
      sumText: sum ? sum.innerText.trim().replace(/\\s+/g, ' ') : null,
      nul: fam(nul),
      cell: fam(cell),
      ctrl: fam(ctrl),
      head: fam(w.querySelector('.db-head-engine')),
      tree: fam(w.querySelector('.db-tree .ant-tree-node-content-wrapper')),
      diag: {
        hasWrap: true,
        hasGrid: !!window.__grid(),
        rows: window.__gridRows().length,
        cellTag: cell ? String(cell.tagName) : null
      }
    }
    ctrl.remove()
    return JSON.stringify(out)
  }
})()`

function buildFixture () {
  const db = new DatabaseSync(FIXTURE)
  db.exec('CREATE TABLE price (id INTEGER PRIMARY KEY, unit_price REAL, qty INTEGER, note TEXT)')
  const ins = db.prepare('INSERT INTO price (id, unit_price, qty, note) VALUES (?, ?, ?, ?)')
  // 故意留一个 NULL 单价：让 .db-cell-summary-null 那一节也出现在同帧里
  const rows = [[1, 12.5, 4, 'a'], [2, 7.25, 9, 'b'], [3, 101.0, 2, 'c'], [4, null, 5, 'd'], [5, 66.75, 1, 'e']]
  for (const r of rows) ins.run(...r)
  db.close()
}

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  buildFixture()

  const page = findPageTarget(await getJson(`http://127.0.0.1:${PORT}/json/list`))
  if (!page) throw new Error('端口 ' + PORT + ' 上没有页面目标')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  // 必须在刚构建的包上跑：实例常早于 vite-build，不重载就是测上一版样式
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, '!!document.querySelector(".bookmark-sidebar-toggle")', '应用未就绪', 40000)) {
    throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
  }
  await sleep(1500)
  await cdp.eval(HELPERS)
  await clearDbTabs(cdp)

  // 桥接必须是原装：二十来个 *-demo.js 会把 runGlobalAsync 整个换掉且不还原，
  // 那样"连上库、看到表"量的却是上一轮的假数据
  const stub = await cdp.eval(`(() => {
    const f = (window.pre || {}).runGlobalAsync
    if (!f) return 'no-pre'
    return String(f).indexOf('[native code]') >= 0 ? 'clean' : 'stub'
  })()`)
  if (stub !== 'clean') {
    throw new Error('页面桥接不是原装（' + stub + '）：请重启实例后再跑')
  }

  const origFont = await cdp.eval('String(window.store._config.fontFamily || "")')
  const park = async () => {
    await cdp.move(1560, 940)
    await sleep(300)
  }
  const click = async (p, ms = 600) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
    await park()
  }
  const openTab = async (title, extra) => {
    const id = await cdp.eval(`(() => {
      window.store.addTab(Object.assign({
        type: 'database',
        from: 'quick-connect',
        title: ${J(title)},
        dbType: 'sqlite',
        dbFile: ${J(FIXTURE)},
        readOnly: true,
        production: false,
        batch: window.store.currentLayoutBatch
      }, ${JSON.stringify(extra || {})}))
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    const ok = await waitFor(cdp,
      `(() => { const w = window.__wrap(); return !!w && w.innerText.indexOf(${J('prices.db')}) >= 0 })()`,
      title + ' 等不到库文件名', 30000)
    return { id, ok }
  }
  // SQLite 的树是 schema(main) → 表，schema 默认收起：不展开就点不到表名
  const selectTable = async () => {
    for (let i = 0; i < 4; i++) {
      const sw = await cdp.eval('window.__switchXY()')
      if (!sw) break
      await click(JSON.parse(sw), 700)
    }
    const p = await cdp.eval(`window.__nodeXY(${J('price')})`)
    if (!p) return 'no-node'
    await click(JSON.parse(p), 1200)
    return await waitFor(cdp, 'window.__gridRows().length > 0', '数据页等不到网格行', 20000) ? 'ok' : 'grid-empty'
  }
  const fonts = async () => {
    const raw = await cdp.eval('window.__fonts()')
    return raw ? JSON.parse(raw) : null
  }
  const setConfigFont = async v => {
    await cdp.eval(`window.store.setConfig({ fontFamily: ${J(v)} })`)
    await sleep(700)
  }

  const a = await openTab(TAB_A, {})
  const selA = await selectTable()
  check('A 页签连上夹具库并进数据页（真 node:sqlite，无桩）',
    a.ok && selA === 'ok', { tab: a.id, selA })

  const f0 = await fonts()
  check('未选中单元格时不出现摘要条（前置，避免把上一轮的残留当本轮）',
    !!f0 && f0.sum === null, f0 && { sumText: f0.sumText, diag: f0.diag })

  // —— 出厂状态：实例自带的 fontFamily（不是脚本设的）——
  const xy = JSON.parse(await cdp.eval(`window.__cellXY(${J(COL)}, 0)`))
  check('点位可命中：' + COL + ' 首格在网格视口内', !xy.error && xy.inView !== false, xy)
  await click(xy)
  const f1 = await fonts()
  check('点数值列一格 → 摘要出现并给出数值聚合（Σ/⌀）',
    !!f1 && isAgg(f1.sumText), f1 && { sumText: f1.sumText })
  check('出厂字体栈生效时：摘要与网格单元格同一字体栈（同源）',
    eq(f1.sum, f1.cell), { sum: f1.sum, cell: f1.cell })
  if (origFont) {
    check('出厂字体栈生效时：摘要跟随生效字体（改造前不跟随，见同帧对照）',
      has(f1.token, origFont) && has(f1.sum, origFont), { token: f1.token, sum: f1.sum })
    check('同帧对照：改造前的写法（var(--font-mono, monospace)）不跟生效字体',
      !has(f1.ctrl, origFont) && !eq(f1.ctrl, f1.sum), { ctrl: f1.ctrl, sum: f1.sum })
  }
  await cdp.shot(path.join(SHOT_DIR, '01-shipped-font.png'))

  // —— 第三级回落：两级字体都清空 ——
  await setConfigFont('')
  const f2 = await fonts()
  check('字体全清空（tab/config 两级都无）：摘要落到 --font-mono 栈',
    eq(f2.sum, f2.mono) && monoReal(f2.mono), { sum: f2.sum, mono: f2.mono, token: f2.token })
  check('该参照栈非空且与界面字体不同（否则"看着等宽"其实没回落）',
    monoReal(f2.mono) && !eq(f2.mono, f2.ui), { mono: f2.mono, ui: f2.ui })
  check('回落态下摘要与"改造前写法"同值（缺省时两者不该有差异）',
    eq(f2.sum, f2.ctrl), { sum: f2.sum, ctrl: f2.ctrl })
  check('回落态下摘要仍与网格单元格同源',
    eq(f2.sum, f2.cell), { sum: f2.sum, cell: f2.cell })
  await cdp.shot(path.join(SHOT_DIR, '02-no-font-fallback.png'))

  // —— 第一级回落之上：全局配置字体 ——
  await setConfigFont(DIST_CONFIG)
  const f3 = await fonts()
  check('注入点生效：wrapper 的 --db-code-font = 全局配置字体',
    has(f3.token, DIST_CONFIG), { tokenInline: f3.tokenInline, token: f3.token })
  check('设全局字体后摘要跟随（这就是改造前的行为缺口）',
    has(f3.sum, DIST_CONFIG), { sum: f3.sum })
  check('设全局字体后网格单元格同样跟随，且与摘要仍是同一栈',
    has(f3.cell, DIST_CONFIG) && eq(f3.sum, f3.cell), { sum: f3.sum, cell: f3.cell })
  check('同帧对照：旧写法在这一行不跟随，新写法跟随',
    !has(f3.ctrl, DIST_CONFIG) && has(f3.sum, DIST_CONFIG), { ctrl: f3.ctrl, sum: f3.sum })
  check('NULL 计数子节点继承同一链（.db-cell-summary-null）',
    !!f3.nul && has(f3.nul, DIST_CONFIG), { nul: f3.nul, sumText: f3.sumText })
  check('改动只落数据面：会话头部引擎标签保持界面字体',
    !!f3.head && !has(f3.head, DIST_CONFIG), { head: f3.head })
  check('改动只落数据面：数据库树保持未接入（与 db-font-realdb F11 同口径）',
    !!f3.tree && !has(f3.tree, DIST_CONFIG), { tree: f3.tree })
  await cdp.shot(path.join(SHOT_DIR, '03-config-font.png'))

  // —— 最高一级：页签自带字体覆盖全局 ——
  const b = await openTab(TAB_B, { fontFamily: DIST_TAB })
  const selB = await selectTable()
  const xyB = JSON.parse(await cdp.eval(`window.__cellXY(${J(COL)}, 1)`))
  if (!xyB.error) await click(xyB)
  const f4 = await fonts()
  check('B 页签（自带字体）进数据页并选中同一列',
    b.ok && selB === 'ok' && !!f4 && isAgg(f4.sumText), { selB, sumText: f4 && f4.sumText })
  check('三级回落的顺序：页签字体覆盖全局字体',
    has(f4.token, DIST_TAB) && has(f4.sum, DIST_TAB) && !has(f4.sum, DIST_CONFIG),
    { token: f4.token, sum: f4.sum })
  await cdp.shot(path.join(SHOT_DIR, '04-tab-font.png'))

  // —— 收尾：还原全局字体、关掉自己开的两个页签，不留状态 ——
  await setConfigFont(origFont)
  await cdp.eval(`(async () => { await window.store.delTab(${J(b.id)}) })()`)
  await sleep(900)
  await cdp.eval(`window.store.changeActiveTabId(${J(a.id)})`)
  await sleep(900)
  const f5 = await fonts()
  check('还原出厂字体后 A 页签摘要重新跟随它（无残留）',
    !f5 || !origFont || (has(f5.token, origFont) && has(f5.sum, origFont)),
    f5 && { token: f5.token, sum: f5.sum })
  await cdp.eval(`(async () => { await window.store.delTab(${J(a.id)}) })()`)
  await sleep(700)
  await cdp.shot(path.join(SHOT_DIR, '05-tabs-closed.png'))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) {
    console.log(JSON.stringify(failed, null, 1))
  }
}

main()
  .then(() => {
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    process.exit(results.filter(r => !r.ok).length ? 1 : 0)
  })
  .catch(err => {
    fs.rmSync(RUN_DIR, { recursive: true, force: true })
    console.error('CRASH', err)
    process.exit(1)
  })
