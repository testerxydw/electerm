#!/usr/bin/env node
/**
 * N11a 第 2 步的实机验收 —— 页面内查找（顶栏搜索条）从 db-session.jsx 搬到
 * use-db-page-search.js 之后，行为必须一模一样。
 *
 * 为什么这一段必须实机（源码契约单测钉不住）：
 * - 命中清单是**运行期从 DOM 现取**的（MutationObserver + rAF recount + input 委托），
 *   搬动 hook 时如果把 bodyRef 传错、或把 effect 的依赖数组写漏，单测全绿也照样坏；
 * - "当前命中"是往真实节点上挂 .db-kw-cur 类，只有真页面能证明挂的是**同一个元素**；
 * - 翻页 / 换关键字后的重算时机（rAF）只能在真渲染节奏里看。
 *
 * 覆盖（判据一律写成"计数条 (i/n) / DOM 标记数 / .db-kw-cur 下标"三者自洽：
 *   数据网格开了虚拟滚动，DOM 里只有视口内那几行，钉死命中数字测的是视口高度）：
 *   S1 查找条由顶栏图标开启、输入框自动聚焦
 *   S2 输入关键字 → 三者自洽，且当前命中落在第 1 个；标记只打在关键字本身上
 *   S3/S4/S5 下一个 / 循环回到第一个 / 上一个从尾部绕回（cur 与计数条同步挪）
 *   S6 换关键字 → 命中清单整体重算并回到第一个
 *   S7 零命中不报错、不出计数条
 *   S8 翻页后按新页 DOM 重算（recount 跟着内容走，旧页标记不残留）
 *   S9 关闭：查找条消失、标记清空；重开时输入框是空的（状态真复位）
 *
 * 用法：
 *   1) npm run compile
 *   2) DISPLAY=:136 HOME=/tmp/electerm-n11a/home TMPDIR=/tmp/electerm-n11a/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9372 --no-sandbox --window-size=1600,1000
 *   3) TMPDIR=/tmp/electerm-n11a/tmp node self-test/db-page-search-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9372'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-page-search-shots')
const DEMO_DIR = path.join(require('node:os').tmpdir(), 'electerm-n11a', 'demo')
const DB = path.join(DEMO_DIR, 'search.db')
const TITLE = 'n11a-search'
const KW = 'needle'

const { check, results } = makeChecker()
const J = s => JSON.stringify(s)

// 夹具：30 行、其中 7 行含关键字，够跨两页（默认每页 20 行）验证"翻页后重算"
const writeFixture = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  if (fs.existsSync(DB)) {
    fs.rmSync(DB, { force: true })
  }
  const db = new DatabaseSync(DB)
  db.exec('CREATE TABLE note_t (id INTEGER PRIMARY KEY, body TEXT)')
  const ins = db.prepare('INSERT INTO note_t (id, body) VALUES (?, ?)')
  for (let i = 1; i <= 30; i++) {
    // 关键字落在第 3/7/11/19/23/27/30 行：前 20 行里 5 个、第 2 页 2 个
    const hit = [3, 7, 11, 19, 23, 27, 30].includes(i)
    ins.run(i, hit ? `row ${i} ${KW} here` : `row ${i} plain text`)
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
  window.__at = sel => {
    const el = [...document.querySelectorAll(sel)].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__searchXY = () => window.__at('.session-bar-search')
  window.__barOpen = () => window.__vis(document.querySelector('.search-bar'))
  window.__inputXY = () => window.__at('.search-bar-input input')
  window.__inputValue = () => {
    const el = document.querySelector('.search-bar-input input')
    return el ? el.value : null
  }
  window.__countText = () => {
    const el = [...document.querySelectorAll('.search-bar-count')].filter(window.__vis)[0]
    return el ? el.innerText.trim() : null
  }
  window.__marks = () => [...document.querySelectorAll('.db-kw-hit')].map((el, i) => ({
    i,
    cur: el.classList.contains('db-kw-cur'),
    text: (el.textContent || '').trim()
  }))
  // 一次读齐"计数条文案 + DOM 命中清单 + 当前命中序号"：三个值必须互相自洽，
  // 这条自洽就是 use-db-page-search 里 recount / applyMarks 的全部职责
  window.__state = () => {
    const marks = window.__marks()
    const m = (window.__countText() || '').match(/\\((\\d+)\\/(\\d+)\\)/)
    return {
      n: marks.length,
      cur: marks.findIndex(x => x.cur),
      bar: m ? { i: Number(m[1]) - 1, n: Number(m[2]) } : null,
      texts: [...new Set(marks.map(x => x.text))]
    }
  }
  // 上一个 / 下一个：SearchBar 里两个箭头图标按 DOM 顺序是 左=prev、右=next
  // SearchBar 的三个动作按 DOM 顺序：左箭头=上一个、右箭头=下一个、× =关闭
  window.__actXY = which => {
    const acts = [...document.querySelectorAll('.search-bar-act')].filter(window.__vis)
    const el = which === 'prev' ? acts[0] : which === 'next' ? acts[1] : acts[acts.length - 1]
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
  window.__collapsedSwitcherXY = () => window.__at('.db-tree .ant-tree-switcher_close')
  window.__pageNoText = () => {
    const el = [...document.querySelectorAll('.db-grid-page-no')].filter(window.__vis)[0]
    return el ? (el.innerText || '').trim() : null
  }
  // 数据页分页条 = DbGridPager：按图标认按钮，不按下标
  // （分页条里不止上一页/下一页，取 btns[1] 或"最后一个"会抓到跳转按钮；
  //  另外分页条贴着底部快捷命令栏，命中测试会把它判成"不可见"，所以只查 disabled）
  window.__nextPageXY = () => {
    const p = [...document.querySelectorAll('.db-grid-area .db-grid-pager')][0]
    if (!p) return null
    const next = [...p.querySelectorAll('button')].find(b => b.querySelector('.anticon-right'))
    return next && !next.disabled ? window.__xy(next) : null
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
  const type = async (text) => {
    // 先全选再插入：不清空会变成"追加"，计数就成两个关键字的并集
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.insertText', { text })
    await sleep(700)
  }

  await clearDbTabs(cdp)

  // 每页 10 行：夹具 30 行 → 稳定跨 3 页，S8 的"下一页"才是真翻页。
  // 不写死就是在测别人留下的 config（上一轮探针把 dbPageSize 设成 200，
  // 于是 30 行全挤在一页、下一页按钮 disabled，S8 直接抓空）
  await cdp.eval('window.store.setConfig({ dbPageSize: 10 })')
  await sleep(600)

  // 开 SQLite 会话（真 node:sqlite 文件，无桩）
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
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const connected = await waitFor(cdp,
    '!!(window.__headTarget() && window.__headTarget().indexOf(\'search.db\') >= 0)',
    '会话头部等不到库文件名', 25000)
  check('S0 SQLite 会话连上（查找的宿主页面存在）', connected, await cdp.eval('window.__headTarget()'))

  for (let i = 0; i < 4; i++) {
    const sw = await cdp.eval('window.__collapsedSwitcherXY()')
    if (!sw) break
    await click(sw, 700)
  }
  await click(await cdp.eval('window.__treeNodeXY(\'note_t\')'), 1200)
  const marked = await waitFor(cdp,
    "!![...document.querySelectorAll('.db-grid-area .ant-table-row')].length",
    '数据网格没出行', 20000)
  check('S0 点开 note_t 数据页（30 行、每页 10 行 → 3 页）', marked, await cdp.eval('window.__pageNoText()'))

  // ---- S1 开启查找条 ----
  await click(await cdp.eval('window.__searchXY()'), 700)
  const open = await cdp.eval('window.__barOpen()')
  const focused = await cdp.eval('document.activeElement && document.activeElement.className')
  check('S1 点顶栏查找图标 → 查找条出现且输入框拿到焦点',
    open === true && String(focused).includes('input'), { open, focused })

  // 判据口径说明：数据网格开了虚拟滚动（virtual={y > 0}），DOM 里只有渲染出来的那几行，
  // 所以这里钉的是"计数条文案 / DOM 标记数 / 当前命中类"三者**互相自洽**，
  // 而不是钉一个命中数字（钉数字测到的是视口高度，不是查找逻辑本身）
  const state = async () => {
    await sleep(350)
    return await cdp.eval('window.__state()')
  }
  const selfConsistent = s => s.n > 0 &&
    !!s.bar && s.bar.n === s.n && s.cur >= 0 && s.bar.i === s.cur

  // ---- S2 输入关键字：三处口径一致，且当前命中就是第一个 ----
  await click(await cdp.eval('window.__inputXY()'), 400)
  await type(KW)
  const s2 = await state()
  check('S2 输入关键字：计数条 (i/n) 的 n == DOM 标记数，且已落在第 1 个命中',
    selfConsistent(s2) && s2.bar.i === 0 && s2.cur === 0, s2)
  check('S2b 标记打在真正的关键字上（不是整格文本）',
    s2.n > 0 && s2.texts.length === 1 && s2.texts[0] === KW, s2.texts)

  // ---- S3 下一个：当前命中的类挪到同一个序号的元素上 ----
  await click(await cdp.eval('window.__actXY(\'next\')'), 600)
  const s3 = await state()
  check('S3「下一个」：.db-kw-cur 与计数条同时挪到第 2 个命中',
    s3.n === s2.n && s3.cur === 1 && s3.bar.i === 1, { before: s2.cur, after: s3 })

  // ---- S4 循环导航：从第 2 个再走 n-1 步应回到第 1 个（不越界、不夹断） ----
  for (let i = 0; i < s2.n - 1; i++) {
    await click(await cdp.eval('window.__actXY(\'next\')'), 320)
  }
  const s4 = await state()
  check('S4 连点「下一个」越过末尾回到第 1 个（循环导航，不卡在最后一个）',
    s4.cur === 0 && s4.bar.i === 0 && s4.n === s2.n, s4)

  // ---- S5 上一个：从第 1 个绕回最后一个 ----
  await click(await cdp.eval('window.__actXY(\'prev\')'), 600)
  const s5 = await state()
  check('S5「上一个」从第 1 个绕回最后一个（cur 与计数条同指末位）',
    s5.cur === s5.n - 1 && s5.bar.i === s5.n - 1, s5)

  // ---- S6 换关键字：命中清单整体重算，序号回到第一个 ----
  await click(await cdp.eval('window.__inputXY()'), 300)
  await type('plain text')
  const s6 = await state()
  check('S6 换关键字后按新串重算（命中数变了，且回到第一个命中）',
    selfConsistent(s6) && s6.n !== s2.n && s6.cur === 0 && s6.bar.i === 0, { s2n: s2.n, s6 })

  // ---- S7 零命中：不出计数条、不报错 ----
  await click(await cdp.eval('window.__inputXY()'), 300)
  await type('zzz-not-here')
  const s7 = await state()
  check('S7 零命中：标记清空、计数条不出现（不显示 (1/0) 这种假状态）',
    s7.n === 0 && s7.bar === null && s7.cur === -1, s7)

  // ---- S8 翻页后按新页 DOM 重算（recount 跟着内容走，不是记第一次的数） ----
  await click(await cdp.eval('window.__inputXY()'), 300)
  await type(KW)
  const s8a = await state()
  const pageNoBefore = await cdp.eval('window.__pageNoText()')
  await click(await cdp.eval('window.__nextPageXY()'), 1500)
  const pageNoAfter = await cdp.eval('window.__pageNoText()')
  const s8b = await state()
  check('S8 翻到第 2 页：仍自洽，且标记只打在关键字上（第 1 页的命中不残留）',
    /2/.test(String(pageNoAfter)) && pageNoAfter !== pageNoBefore &&
    selfConsistent(s8b) && s8b.texts.length === 1 && s8b.texts[0] === KW,
    { pageNoBefore, pageNoAfter, s8a, s8b })

  // ---- S9 关闭：查找条消失 + 标记清空 + 状态复位 ----
  await click(await cdp.eval('window.__actXY(\'close\')'), 800)
  const closed = await cdp.eval('window.__barOpen()')
  const s9 = await state()
  check('S9 关闭查找：查找条收起、页面标记全清（不留底色）',
    closed === false && s9.n === 0, { closed, s9 })

  // 再开一次：关键字必须是空的（关闭真的复位了状态，不是只藏起来）
  await click(await cdp.eval('window.__searchXY()'), 700)
  const reopened = await cdp.eval('window.__inputValue()')
  check('S9b 重新打开查找条：输入框是空的（closeSearch 真的清了状态）',
    reopened === '' || reopened === null, reopened)
  await cdp.shot(path.join(SHOT_DIR, 'final.png'))
  // 页内 console/error：计数对了但页面在偷偷抛异常，同样是回归
  console.log('\nEVENTS', JSON.stringify(cdp.tail(8)))

  const bad = results.filter(r => !r.ok)
  console.log(`${results.length - bad.length}/${results.length} 条通过`)
  if (bad.length) {
    console.log('FAILED: ' + bad.map(b => b.name).join(' | '))
  }
  // CDP WebSocket 会把事件循环一直挂着：不显式退出，探针"跑完了"也回不来
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => {
  console.error('PROBE ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})
