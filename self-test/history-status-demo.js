#!/usr/bin/env node
/**
 * P-3 历史行连接状态点 —— CDP 实机回归（假库页签，无需真库/真机）
 *
 * 拍板口径（2026-11-04）："只做连接状态点"，纯视觉新增，不动数据模型：
 * 状态不落进 store.history（那是同步出去的数据），每次渲染从 store.tabs 现算
 * 「连接键 → 最亮状态」，历史行按同一把键（bookmark-dedup.bookmarkConnKey）查。
 *
 * 为什么必须实机（纯函数单测钉不住的部分）：
 *   1) 反应性：状态表是在 `auto` 那层现算的。页签状态变了但历史列不刷新，
 *      功能就等于"打开面板那一刻的快照"—— 只有真 store + 真渲染量能证伪它。
 *   2) computed 颜色与圆角：点只吃 token（--success/--primary/--error、--radius-pill），
 *      深浅主题下都得跟着变，写死色在这条判据前会红。
 *   3) 与页签条 .tab-status 同口径：同一状态两处不同色，就是"状态语言"分家。
 *   4) 槽位常驻：有点/没点的行首文字必须不错位（历史列是平铺的，不是树）。
 *   5) 判不了就不画：本地终端、缺字段、没开着的会话 → 一行都不许亮。
 *   6) 纯视觉的承诺可验：跑完一圈 store.history 里不该多出任何状态字段。
 *
 * ⚠️ 本脚本临时替换 window.pre.runGlobalAsync（假库层，避免真连接）、改
 *    store.history / 侧栏面板与 pin / 主题，收尾全部还原并 reload 一次。
 *
 * 用法：
 *   1) 渲染层改过就 npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（隔离 HOME），默认端口 9333
 *   3) node self-test/history-status-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'history-status-demo-shots')

const TAG = 'hstat' + String(Date.now()).slice(-6)
const HOST_A = TAG + '-a.example.com'
const HOST_B = TAG + '-b.example.com'
const DB_NAME = TAG + '_db'
const DB_TITLE = TAG + '-db'

// 历史里先放五条：A 机、A 机另一入口（端口不同 = 另一把键）、B 机（始终没开着）、
// 本地终端、缺 host 的残条目（判不了）；数据库那条后面跟着假页签一起加，
// 用来验"页签建出来之后再加的行也能亮"
const SEED = [
  { title: TAG + '-a22', type: 'ssh', host: HOST_A, port: 22, username: 'root' },
  { title: TAG + '-a2222', type: 'ssh', host: HOST_A, port: 2222, username: 'root' },
  { title: TAG + '-b', type: 'ssh', host: HOST_B, port: 22, username: 'root' },
  { title: TAG + '-local', type: 'local' },
  { title: TAG + '-nolocator', type: 'ssh', host: '', port: 22, username: 'root' }
]

/** 假库层：开 database 页签不会真去连（同 db-tree-font-demo 的桩口径） */
const STUB = `
(() => {
  window.__dbStub = 'history-status'
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      if (op === 'getMetadata') return Promise.resolve([])
      if (op === 'getTableStructure') return Promise.resolve({ columns: [], foreignKeys: [] })
      if (op === 'countRows') return Promise.resolve({ count: 0 })
      if (op === 'getPageData') return Promise.resolve({ rows: [], totalRows: 0, hasMore: false })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'closeDbTab') return Promise.resolve(null)
    return Promise.resolve(null)
  }
  return 'stub-installed'
})()
`

const PROBE = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !!el && !window.__hidden(el)
  // token 问运行时解析值，不问声明字符串：主题是运行时换的，比字符串等于自证
  window.__tokenColor = name => {
    const d = document.createElement('div')
    d.style.color = 'var(' + name + ')'
    document.body.appendChild(d)
    const c = getComputedStyle(d).color
    d.remove()
    return c
  }
  window.__tokenRaw = name => String(getComputedStyle(document.body).getPropertyValue(name)).trim()
  window.__panel = () => [...document.querySelectorAll('.sidebar-panel-history')].filter(window.__vis)[0] || null
  window.__rows = () => {
    const p = window.__panel()
    if (!p) return []
    return [...p.querySelectorAll('.item-list-unit')].filter(window.__vis).map(r => {
      const slot = r.querySelector('.history-status-slot')
      const dot = r.querySelector('.history-status-dot')
      const title = r.querySelector('.elli')
      const sr = slot ? slot.getBoundingClientRect() : null
      const dr = dot ? dot.getBoundingClientRect() : null
      const tr = title ? title.getBoundingClientRect() : null
      return {
        text: title ? String(title.innerText || '').trim() : '',
        hasSlot: !!slot,
        slotW: sr ? Math.round(sr.width) : -1,
        textLeft: tr ? Math.round(tr.left) : -1,
        dot: dot ? String(dot.className).replace('history-status-dot', '').trim() : '',
        dotW: dr ? Math.round(dr.width) : -1,
        dotH: dr ? Math.round(dr.height) : -1,
        dotBg: dot ? getComputedStyle(dot).backgroundColor : '',
        dotRadius: dot ? getComputedStyle(dot).borderRadius : '',
        dotAnim: dot ? getComputedStyle(dot).animationName : '',
        dotShadow: dot ? getComputedStyle(dot).boxShadow : '',
        dotAria: dot ? dot.getAttribute('aria-hidden') : ''
      }
    })
  }
  window.__row = text => window.__rows().find(r => r.text.indexOf(text) >= 0) || null
  // 页签条那颗点是"同一状态同一色"的参照物（本模块的颜色映射照它抄）
  window.__tabDot = status => {
    const list = [...document.querySelectorAll('.tab-status')].filter(window.__vis)
    const t = status ? list.find(x => String(x.className).indexOf(status) >= 0) : list[0]
    return t ? { cls: String(t.className), bg: getComputedStyle(t).backgroundColor } : null
  }
  window.__notices = () => [...document.querySelectorAll('.ant-notification-notice')]
    .map(n => String(n.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  return 'probe-installed'
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}
const brief = o => JSON.stringify(o).slice(0, 260)

/** 打开一个 database 页签（假库层，不真连），返回页签 id */
const openDbTab = (title, dbName) => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: ${JSON.stringify(title)},
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'demo',
    dbPassword: '',
    dbName: ${JSON.stringify(dbName)},
    dbSsl: false,
    readOnly: false,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return created ? String(created.id) : ''
})()
`

const setStatus = (id, status) =>
  `window.store.updateTab(${JSON.stringify(String(id))}, { status: ${JSON.stringify(status)} })`

const main = async () => {
  const targets = await getJson('http://127.0.0.1:' + PORT + '/json')
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('端口 ' + PORT + ' 上没有渲染页面目标：先用 --remote-debugging-port 起实例')
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  // 先重载一次：实例可能是上一版包起来的，判据要跑在刚 vite-build 出来的产物上
  await cdp.call('Page.reload', {})
  await waitFor(cdp, '!!window.store', 'store 未就绪')
  await sleep(1500)
  // 页签先清干净：上一轮（或别的脚本）留下的会话会让"没开着就不该亮"失去意义
  await clearDbTabs(cdp)
  const tabIdsBefore = JSON.parse(await cdp.eval('JSON.stringify((window.store.tabs || []).map(t => String(t.id)))'))
  for (const id of tabIdsBefore) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  await sleep(800)

  // 现场快照，收尾照原样还回去
  const snapBefore = JSON.parse(await cdp.eval(`(() => {
    const s = window.store
    return JSON.stringify({
      history: s.history,
      openedSideBar: s.openedSideBar,
      sidebarPanelTab: s.sidebarPanelTab,
      pinned: s.pinned,
      theme: (s._config || {}).theme,
      disableHistory: !!s.config.disableConnectionHistory
    })
  })()`))
  if (snapBefore.disableHistory) {
    await cdp.eval('window.store.setConfig({ disableConnectionHistory: false })')
    await sleep(500)
  }

  check('桩与探针装好',
    await cdp.eval(STUB) === 'stub-installed' && await cdp.eval(PROBE) === 'probe-installed')

  // 侧栏打开并切到历史面板，顺带 pin 住：不 pin 时面板是"点外面就收"的浮层，
  // 判据跑到一半面板没了会红得莫名其妙（收尾照快照还原 pin）
  await cdp.eval(`(() => {
    const s = window.store
    if (!s.pinned) s.handlePin()
    s.handleSidebarPanelTab('history')
    s.setOpenedSideBar('bookmarks')
  })()`)
  if (!await waitFor(cdp, '!!window.__panel()', '历史面板没打开', 15000)) {
    throw new Error('侧栏历史面板等不到：' +
      brief(await cdp.eval('JSON.stringify([window.store.openedSideBar, window.store.sidebarPanelTab, window.store.pinned])')))
  }

  // 播历史：五条假条目（纯内存，跑完还原）
  await cdp.eval(`(() => {
    const seed = ${JSON.stringify(SEED)}
    window.store.history = seed.map((tab, i) => ({ id: '${TAG}-h' + i, tab, time: Date.now() - i, count: 1 }))
  })()`)
  await waitFor(cdp, `window.__rows().length === ${SEED.length}`, '历史行没渲染出 ' + SEED.length + ' 条', 8000)
  await sleep(400)

  const base = await cdp.jeval('window.__rows()')
  check('历史列渲染出全部假条目（面板与行都取得到）', base.length === SEED.length, base.map(r => r.text))
  check('每行都有常驻槽位（不管有没有点）',
    base.length > 0 && base.every(r => r.hasSlot && r.slotW > 0), base.map(r => r.slotW))
  check('一个会话都没开着 → 一颗点都不画（判不了/没开着就不亮）',
    base.every(r => r.dot === ''), base.map(r => [r.text, r.dot]))
  const slotW = base[0] ? base[0].slotW : -1
  check('没点时行首也留了槽位的位（后面点亮了才对得上）',
    slotW > 0 && new Set(base.map(r => r.textLeft)).size === 1, base.map(r => r.textLeft))

  // ── 点亮：开一个 database 页签，历史里对上的那条该亮 ────────
  const tabId = await cdp.eval(openDbTab(TAG + '-tab', DB_NAME))
  if (!tabId) throw new Error('database 页签没建出来')
  await cdp.eval(`(() => {
    window.store.history = window.store.history.concat([{
      id: '${TAG}-hdb',
      tab: { type: 'database', title: '${DB_TITLE}', dbType: 'mysql', dbHost: '127.0.0.1', dbPort: 3306, dbUser: 'demo', dbName: '${DB_NAME}' },
      time: Date.now(), count: 1
    }])
  })()`)
  await waitFor(cdp, `!!window.__row(${JSON.stringify(DB_TITLE)})`, '数据库历史行没渲染', 8000)

  // database 页签自己不会置状态（那是 ssh 终端那条链路上的事），这里手动喂
  await cdp.eval(setStatus(tabId, 'success'))
  await sleep(700)

  const lit = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  const green = await cdp.eval('window.__tokenColor("--success")')
  const pill = await cdp.eval('window.__tokenRaw("--radius-pill")')
  check('开着的会话让对应历史行亮起（class 带状态名）',
    !!lit && lit.dot === 'success', lit && [lit.text, lit.dot])
  check('点的尺寸与页签条同口径（7px 圆点）',
    !!lit && lit.dotW === 7 && lit.dotH === 7, lit && [lit.dotW, lit.dotH])
  check('圆角吃 token（computed 就是 --radius-pill 解析出来的那个值）',
    !!lit && lit.dotRadius === pill, lit && [lit.dotRadius, pill])
  check('点的颜色就是 --success 的运行时值（不是写死色）',
    !!lit && lit.dotBg === green, { dotBg: lit && lit.dotBg, token: green })
  check('点不带光晕也不呼吸（一列十几行，动效多了反而看不出哪条开着）',
    !!lit && (lit.dotAnim === 'none' || lit.dotAnim === '') &&
      (lit.dotShadow === 'none' || lit.dotShadow === ''), lit && [lit.dotAnim, lit.dotShadow])
  check('点是装饰（aria-hidden，读屏不念）', !!lit && lit.dotAria === 'true', lit && lit.dotAria)
  await cdp.shot(path.join(SHOT_DIR, '1-dot-success-dark.png'))

  // 与页签条那颗点比色：同一状态两处必须同色
  const tabDot = await cdp.eval('window.__tabDot("success")')
  check('与页签条 .tab-status 同色（状态语言不分家）',
    !!tabDot && !!lit && tabDot.bg === lit.dotBg, { tab: tabDot, history: lit && lit.dotBg })

  // ── 反应性：状态变了不重载也得换色 ─────────────────────────
  await cdp.eval(setStatus(tabId, 'processing'))
  await sleep(700)
  const proc = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  const blue = await cdp.eval('window.__tokenColor("--primary")')
  check('页签状态改 processing，历史行的点不重载就换色（每次渲染现算，不是快照）',
    !!proc && proc.dot === 'processing' && proc.dotBg === blue,
    proc && [proc.dot, proc.dotBg, blue])

  await cdp.eval(setStatus(tabId, 'error'))
  await sleep(700)
  const errRow = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  const red = await cdp.eval('window.__tokenColor("--error")')
  check('改 error → 换成 --error', !!errRow && errRow.dot === 'error' && errRow.dotBg === red,
    errRow && [errRow.dot, errRow.dotBg, red])

  // ── 同目标多页签取最亮 ─────────────────────────────────────
  const tabId2 = await cdp.eval(openDbTab(TAG + '-tab2', DB_NAME))
  await cdp.eval(setStatus(tabId2, 'success'))
  await sleep(700)
  const multi = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  const dotCount = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)}).dot`)
  check('同一目标两个页签（一个 error 一个 success）→ 仍是一颗点，取"已连上"',
    !!multi && multi.dot === 'success' && dotCount === 'success', multi && [multi.dot, multi.dotBg])
  await cdp.eval(setStatus(tabId, 'processing'))
  await cdp.eval(setStatus(tabId2, 'processing'))
  await sleep(700)
  const multi2 = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  check('两个都 processing 时仍是 processing（同键合并，不是每页签一颗）',
    !!multi2 && multi2.dot === 'processing', multi2 && multi2.dot)

  // ── 不该亮的行一律不亮 ─────────────────────────────────────
  // 注意：建页签本身会往 history 里追加一条（store 的既有行为），所以历史列里
  // 会出现 -tab / -tab2 那几行 —— 它们和 -db 行是同一把连接键，亮是对的。
  // 这里只钉"本就没开着/判不了"的那几条假条目。
  const litOk = [DB_TITLE, TAG + '-tab', TAG + '-tab2']
  const all = await cdp.jeval('window.__rows()')
  const others = all.filter(r => !litOk.some(t => r.text.indexOf(t) >= 0))
  check('没开着的/本地终端/缺定位字段的行始终没有点',
    others.length === SEED.length && others.every(r => r.dot === ''), others.map(r => [r.text, r.dot]))
  check('点亮与否不影响行首对齐（同宽槽位，平铺列表不错位）',
    new Set(all.map(r => r.textLeft)).size === 1, all.map(r => r.textLeft))

  // ── 关页签 → 点灭 ──────────────────────────────────────────
  await cdp.eval(`(async () => {
    await window.store.delTab(${JSON.stringify(String(tabId))})
    await window.store.delTab(${JSON.stringify(String(tabId2))})
  })()`)
  await sleep(1500)
  const off = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  check('关掉页签后点消失（状态表跟着 store.tabs 现算）',
    !!off && off.dot === '' && off.hasSlot === true, off && [off.dot, off.slotW, off.textLeft])
  check('关完历史行还在（只是不亮，不是把行删了）', !!off && !!off.text, off && off.text)

  // ── 主题：颜色跟着 token 走 ────────────────────────────────
  const tabId3 = await cdp.eval(openDbTab(TAG + '-tab3', DB_NAME))
  await sleep(600)
  if (!tabId3) throw new Error('第三个假页签没建出来')
  await cdp.eval(setStatus(tabId3, 'success'))
  await sleep(700)
  const dark = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  // 令牌活性（比"切主题看不看色"更硬）：运行时把 --success 改成一个不可能的值，
  // 点跟着动才证明颜色来自 token；写死色不会被这一手影响
  await cdp.eval('document.documentElement.style.setProperty("--success", "rgb(123, 45, 67)")')
  await sleep(500)
  const tokProbe = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
  check('运行时改 --success 立刻反映到点（颜色确实来自 token，不是写死色）',
    !!tokProbe && tokProbe.dotBg === 'rgb(123, 45, 67)', tokProbe && tokProbe.dotBg)
  await cdp.eval('document.documentElement.style.removeProperty("--success")')
  await sleep(500)
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id)))
  if (!lightId) {
    check('本机有可切换的浅色系主题（否则这条判据跑不了）', false, themeIds)
  } else {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1800)
    const light = await cdp.eval(`window.__row(${JSON.stringify(DB_TITLE)})`)
    const greenLight = await cdp.eval('window.__tokenColor("--success")')
    // 语义色（--success）在两套主题里可以同值，所以只要求"跟着该主题解析出来的
    // token 走"；两套同色时不比差异，比了会把产品判成红
    check('浅色主题下点仍亮着，颜色等于该主题解析出来的 --success',
      !!dark && !!light && light.dot === 'success' && light.dotBg === greenLight,
      { darkBg: dark && dark.dotBg, lightBg: light && light.dotBg, lightToken: greenLight })
    await cdp.shot(path.join(SHOT_DIR, '2-dot-success-light.png'))
  }

  // ── 纯视觉的承诺：数据模型没被动过 ─────────────────────────
  const dataShape = JSON.parse(await cdp.eval(`(() => {
    const s = window.store
    return JSON.stringify({
      extraKeys: [...new Set(s.history.flatMap(h => Object.keys(h)))].sort(),
      tabKeys: [...new Set(s.history.flatMap(h => Object.keys(h.tab || {})))].sort(),
      n: s.history.length
    })
  })()`))
  check('跑完一圈 history 条目里没有多出状态字段（纯视觉，不动数据模型）',
    dataShape.extraKeys.join(',') === 'count,id,tab,time' &&
      !dataShape.tabKeys.some(k => k === 'status' || k === 'id' || k === 'srcId'),
    dataShape)

  const notices = await cdp.eval('window.__notices()')
  check('全程没弹报错通知（假库层没被真连接戳穿）', (notices || []).length === 0, notices)

  // ── 还原现场 ───────────────────────────────────────────────
  await clearDbTabs(cdp)
  await cdp.eval(`(() => {
    const s = window.store
    const before = ${JSON.stringify(snapBefore)}
    s.history = before.history
    s.setConfig({ disableConnectionHistory: before.disableHistory })
    if (before.pinned !== s.pinned) s.handlePin()
    s.handleSidebarPanelTab(before.sidebarPanelTab || 'bookmarks')
    s.setOpenedSideBar(before.openedSideBar || '')
    if (before.theme) s.setTheme(before.theme)
    return 1
  })()`)
  await sleep(1000)
  const restored = JSON.parse(await cdp.eval(`JSON.stringify({
    hasTag: window.store.history.some(h => String((h.tab || {}).title || '').indexOf('${TAG}') === 0),
    dbTabs: window.store.tabs.filter(t => t.type === 'database').length,
    pinned: window.store.pinned === ${JSON.stringify(snapBefore.pinned)},
    theme: String((window.store._config || {}).theme) === ${JSON.stringify(String(snapBefore.theme))}
  })`))
  check('现场还原（假历史条目清零、假页签关净、pin 与主题回到进来时）',
    restored.hasTag === false && restored.dbTabs === 0 && restored.pinned === true && restored.theme === true,
    restored)
  await cdp.call('Page.reload', {})
  await sleep(2500)

  const failed = results.filter(r => !r.ok)
  console.log('—— P-3 历史连接状态点实机：' + (results.length - failed.length) + '/' + results.length + ' 通过 ——')
  if (failed.length) {
    throw new Error(failed.length + ' 条判据没过：' + failed.map(f => f.name).join(' / '))
  }
}

main().then(() => {
  console.log('DONE history-status demo')
  process.exit(0)
}).catch(err => {
  console.error('FATAL ' + err.message)
  process.exit(1)
})
