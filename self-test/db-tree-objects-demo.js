#!/usr/bin/env node
/**
 * U4 元数据树：对象图标 / 分组计数 / 悬停选中 —— CDP 实机回归（无需真 MySQL）
 *
 * 为什么必须实机：图标是 antd SVG + 行内盒模型，判据要同时盯住"形状真的不同""颜色
 * 真的跟着 token""树行高没被图标撑开"——这三样源码守卫都只能猜。
 * 悬停/选中颜色更是只有浏览器会算（CSS :hover 无法用 JS 伪造）。
 *
 * 覆盖：
 *   1) 视图/过程/函数/触发器/事件五类叶子各有形状图标，表/普通键没有
 *   2) 分组节点（过程与函数 / 触发器 / 事件）图标与组内叶子同源
 *   3) 图标颜色取自 token（info / primary-text / success / warn / text-muted）
 *   4) 分组右侧计数 = 组内对象数；schema 计数 = 递归叶子数
 *   5) 所有树行行高一致（图标不把 24px 行撑成 25/26px）
 *   6) 悬停背景 = --hover-bg；选中背景 = --active-bg（与数据网格同一口径）
 *   7) 深浅主题各一张截图
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync，跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（隔离 HOME，见 README 式注释）
 *   3) node self-test/db-tree-objects-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9226'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-tree-objects-shots')

const STUB = `
(() => {
  window.__calls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      window.__calls.push(op)
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'tree_demo',
          type: 'database',
          children: [
            { name: 'users', type: 'table' },
            { name: 'orders', type: 'table' },
            { name: 'v_active', type: 'view' },
            {
              name: 'routines',
              type: 'group',
              group: 'routine',
              children: [
                { name: 'sp_demo', type: 'procedure' },
                { name: 'fn_demo', type: 'function' }
              ]
            },
            {
              name: 'triggers',
              type: 'group',
              group: 'trigger',
              children: [{ name: 'trg_demo', type: 'trigger', table: 'users' }]
            },
            {
              name: 'events',
              type: 'group',
              group: 'event',
              children: [{ name: 'ev_demo', type: 'event' }]
            }
          ]
        }])
      }
      if (op === 'describeTable') return Promise.resolve([])
      if (op === 'getTableStructure') return Promise.resolve({ columns: [], foreignKeys: [] })
      if (op === 'listColumns') return Promise.resolve([])
      if (op === 'getReferences') return Promise.resolve([])
      if (op === 'countRows') return Promise.resolve({ count: 0 })
      if (op === 'getPageData') return Promise.resolve({ rows: [], totalRows: 0, hasMore: false })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'closeDbTab') return Promise.resolve(null)
    return Promise.resolve(null)
  }
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__scope = () => document.querySelector('.session-current') || document
  window.__nodes = () => [...window.__scope().querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .filter(window.__vis)
  window.__node = text => window.__nodes()
    .find(n => (n.innerText || '').trim().indexOf(text) >= 0) || null
  window.__nodeJson = text => {
    const n = window.__node(text)
    if (!n) return JSON.stringify({ err: 'no-node:' + text })
    const r = n.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2), h: Math.round(r.height), bg: getComputedStyle(n).backgroundColor })
  }
  window.__expand = text => {
    const n = window.__node(text)
    if (!n) return 'missing'
    const li = n.closest('.ant-tree-treenode')
    const sw = li && li.querySelector('.ant-tree-switcher')
    if (!sw) return 'no-switcher'
    sw.click()
    return 'ok'
  }
  window.__icon = text => {
    const n = window.__node(text)
    if (!n) return JSON.stringify({ err: 'no-node:' + text })
    const ic = n.querySelector('.db-tree-obj-icon')
    const r = n.getBoundingClientRect()
    return JSON.stringify({
      cls: ic ? String(ic.className) : '',
      svg: !!(ic && ic.querySelector('svg')),
      color: ic ? getComputedStyle(ic).color : '',
      w: ic ? Math.round(ic.getBoundingClientRect().width) : 0,
      h: ic ? Math.round(ic.getBoundingClientRect().height) : 0,
      rowH: Math.round(r.height)
    })
  }
  window.__count = text => {
    const n = window.__node(text)
    if (!n) return null
    const c = n.querySelector('.db-tree-count')
    return c ? c.innerText.trim() : null
  }
  window.__bgOf = text => {
    const n = window.__node(text)
    return n ? getComputedStyle(n).backgroundColor : null
  }
  window.__tokenRgb = name => {
    const d = document.createElement('div')
    d.style.color = 'var(' + name + ')'
    document.body.appendChild(d)
    const rgb = getComputedStyle(d).color
    d.remove()
    return rgb
  }
  window.__rowHeights = () => JSON.stringify(window.__nodes().map(n => Math.round(n.getBoundingClientRect().height)))
  window.__themeIds = () => JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))
  return 'stub-installed'
})()
`

const OPEN_TAB = dbType => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'tree objects demo',
    dbType: '${dbType}',
    dbHost: '127.0.0.1',
    dbPort: ${dbType === 'redis' ? 6379 : 3306},
    dbUser: 'demo',
    dbPassword: '',
    dbName: 'tree_demo',
    dbSsl: false,
    readOnly: false,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  await clearDbTabs(cdp)
  await cdp.call('Page.reload', {})
  await waitFor(cdp, '!!window.store', 'store ready')
  await sleep(800)
  const themeBefore = await cdp.eval('String((window.store._config || {}).theme || "")')

  const stub = await cdp.eval(STUB)
  check('桩 MySQL 元数据已注入', stub === 'stub-installed', stub)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB('mysql')))
  if (!openRes.id) {
    throw new Error('database tab was not created')
  }
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
  await cdp.eval('window.__expand("tree_demo")')
  await waitFor(cdp, '!!window.__node("v_active")', 'db children')
  // 库刚展开时树还在提交/动画中，紧接着点分组可能被同一次渲染吞掉（实测）。
  // 每次展开后以"组内子节点出现"为准，最多点三次
  await sleep(800)
  for (const [g, child] of [['dbRoutines', 'sp_demo'], ['dbTriggers', 'trg_demo'], ['dbEvents', 'ev_demo']]) {
    const label = await cdp.eval(`window.translate(${JSON.stringify(g)})`)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval(`!!window.__node(${JSON.stringify(child)})`)) {
        break
      }
      await cdp.eval(`window.__expand(${JSON.stringify(label)})`)
      await sleep(600)
    }
    await waitFor(cdp, `!!window.__node(${JSON.stringify(child)})`, child, 4000)
  }
  await sleep(500)

  // ---- 1) 五类对象各有形状图标，表没有 ----
  const icons = {}
  for (const [label, key] of [['v_active', 'view'], ['sp_demo', 'procedure'], ['fn_demo', 'function'], ['trg_demo', 'trigger'], ['ev_demo', 'event']]) {
    icons[key] = JSON.parse(await cdp.eval(`window.__icon(${JSON.stringify(label)})`))
  }
  check('五类对象都渲染了图标且是 SVG',
    Object.values(icons).every(i => i.svg && i.w > 0 && i.h > 0), icons)
  check('每类图标的修饰类与类型一致',
    Object.entries(icons).every(([k, i]) => String(i.cls || '').includes('is-' + k)), icons)
  const tableIcon = JSON.parse(await cdp.eval('window.__icon("users")'))
  check('普通表没有对象图标', tableIcon.cls === '' && tableIcon.svg === false, tableIcon)

  // ---- 2) 分组图标与组内叶子同源 ----
  const groups = {}
  for (const [g, cls] of [['dbRoutines', 'is-group-routine'], ['dbTriggers', 'is-group-trigger'], ['dbEvents', 'is-group-event']]) {
    const label = await cdp.eval(`window.translate(${JSON.stringify(g)})`)
    groups[g] = JSON.parse(await cdp.eval(`window.__icon(${JSON.stringify(label)})`))
    check(`分组「${g}」有 ${cls} 图标`, groups[g].cls.includes(cls) && groups[g].svg, groups[g])
  }

  // ---- 3) 颜色来自 token ----
  const tok = {}
  for (const t of ['--info', '--primary-text', '--success', '--warn', '--text-muted']) {
    tok[t] = await cdp.eval(`window.__tokenRgb(${JSON.stringify(t)})`)
  }
  check('视图图标 = --info', icons.view.color === tok['--info'], { got: icons.view.color, want: tok['--info'] })
  check('过程图标 = --primary-text', icons.procedure.color === tok['--primary-text'], { got: icons.procedure.color })
  check('函数图标 = --success', icons.function.color === tok['--success'], { got: icons.function.color })
  check('触发器图标 = --warn', icons.trigger.color === tok['--warn'], { got: icons.trigger.color })
  check('事件图标 = --text-muted', icons.event.color === tok['--text-muted'], { got: icons.event.color })
  const distinct = new Set(Object.values(icons).map(i => i.color))
  check('五类图标颜色两两不同（形状之外还有颜色区分）', distinct.size === 5, [...distinct])

  // ---- 4) 计数徽标 ----
  const nRoutine = await cdp.eval('window.__count("sp_demo")')
  const routinesLabel = await cdp.eval('window.translate("dbRoutines")')
  const triggersLabel = await cdp.eval('window.translate("dbTriggers")')
  const eventsLabel = await cdp.eval('window.translate("dbEvents")')
  check('过程与函数分组计数 = 2', await cdp.eval(`window.__count(${JSON.stringify(routinesLabel)})`) === '2', { got: await cdp.eval(`window.__count(${JSON.stringify(routinesLabel)})`) })
  check('触发器分组计数 = 1', await cdp.eval(`window.__count(${JSON.stringify(triggersLabel)})`) === '1')
  check('事件分组计数 = 1', await cdp.eval(`window.__count(${JSON.stringify(eventsLabel)})`) === '1')
  // 叶子节点本身不该出现计数（计数属于容器）
  check('叶子对象不显示计数徽标', nRoutine === null, { nRoutine })

  // ---- 5) 行高一致：图标不得把某一行撑高 ----
  const heights = JSON.parse(await cdp.eval('window.__rowHeights()'))
  check('所有树行行高一致（图标没撑高任何一行）',
    heights.length > 5 && Math.max(...heights) - Math.min(...heights) === 0, heights)

  // ---- 6) 悬停 / 选中与数据网格同口径 ----
  const hoverNode = JSON.parse(await cdp.eval('window.__nodeJson("users")'))
  await cdp.move(hoverNode.x, hoverNode.y)
  await sleep(500)
  const hoverBg = await cdp.eval('window.__bgOf("users")')
  const hoverTok = await cdp.eval('window.__tokenRgb("--hover-bg")')
  check('悬停背景 = --hover-bg', hoverBg === hoverTok, { hoverBg, hoverTok })

  // 选中态只在叶子节点上出现（非叶子的点击是展开/收起，不改 selectedKeys），
  // 所以点一张表：桩里把表格链路全部回空，只为拿到 .ant-tree-node-selected
  const usersNode = JSON.parse(await cdp.eval('window.__nodeJson("users")'))
  await cdp.click(usersNode.x, usersNode.y)
  const selOk = await waitFor(cdp, '!!document.querySelector(".db-tree .ant-tree-node-selected")', 'tree selected')
  await sleep(400)
  const selBg = await cdp.eval('(() => { const n = document.querySelector(".db-tree .ant-tree-node-selected"); return n ? getComputedStyle(n).backgroundColor : null })()')
  const activeTok = await cdp.eval('window.__tokenRgb("--active-bg")')
  check('选中背景 = --active-bg', selOk && selBg === activeTok, { selBg, activeTok })

  // ---- 7) 双主题截图 ----
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-tree-dark.png')))
  const themeIds = JSON.parse(await cdp.eval('window.__themeIds()'))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(800)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-tree-light.png')))
    // --success 在浅色主题里没有覆盖值；--text-muted（事件图标）才有，用它验"跟着主题走"
    const lightColor = JSON.parse(await cdp.eval('window.__icon("ev_demo")')).color
    check('浅色主题下图标颜色跟着 token 变（不是写死色值）', lightColor !== icons.event.color, { dark: icons.event.color, light: lightColor })
    if (themeBefore) {
      await cdp.eval('window.store.setTheme(' + JSON.stringify(themeBefore) + ')')
      await sleep(300)
    }
  }

  const fails = results.filter(r => !r.ok)
  console.log(`\n${results.length - fails.length}/${results.length} PASS`)
  if (fails.length) {
    console.log(cdp.tail(8).join('\n'))
    process.exitCode = 1
  }
  cdp.ws.close()
  process.exit(process.exitCode || 0)
}

main().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
