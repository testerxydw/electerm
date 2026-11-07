#!/usr/bin/env node
/**
 * N11b 拆分收口 —— CDP 实机冒烟（真 Electron 渲染进程 + 真 SQLite 夹具）
 *
 * 为什么必须实机：N11b 的 13 个簇全部只做过静态验证（standard / 单测 / compile）。
 * compile 通过只能证明「符号解析得开」，证明不了这些：
 *   - #30 视图动作换了宿主（owner → useDbView）：排序 chip、应用/重置还连着没有；
 *   - #31a/#31b 两块面板 JSX 搬进组件：19/20 个 props 里漏一个就是运行时 undefined；
 *   - #32 结构区搬成组件：工具行四颗按钮 + 字典导出的 Dropdown 是否还挂在 handler 上；
 *   - #29 连接生命周期：挂载建连 effect 仍留 owner，重连路径未被本脚本覆盖（需掉线）。
 * 判据读 DOM 与渲染层异常日志（cdp.events），不读源码 —— 源码已被单测钉过一遍，
 * 再读一遍等于同义反复。
 *
 * 用法：
 *   1) npm run compile
 *   2) DISPLAY=:0 HOME=/tmp/electerm-n11b/home TMPDIR=/tmp/electerm-n11b/tmp \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9385 --no-sandbox --window-size=1600,1000
 *   3) node self-test/n11b-split-smoke.js [port] [shotDir]
 *
 * 夹具在 /tmp/electerm-n11b/demo 下，每次跑重建；不碰仓库、不含真实凭据。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9385'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'n11b-smoke-shots')
const DEMO_DIR = '/tmp/electerm-n11b/demo'
const DB = path.join(DEMO_DIR, 'smoke.db')
const TITLE = 'n11b-smoke'
const J = s => JSON.stringify(s)

// 页内探针：只做「找元素 / 点 / 数」，判据留在 Node 侧
const PROBE = `(() => {
  window.__txt = el => (el && el.innerText ? el.innerText : '').trim()
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  window.__all = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__cnt = sel => window.__all(sel).length
  // 结构判定用原始计数：antd 弹层淡入期间 opacity 还不到 0.05，__vis 会把它滤成 0
  window.__q = sel => document.querySelectorAll(sel).length
  window.__txtOf = sel => window.__all(sel).map(window.__txt).join(' | ')
  window.__head = () => window.__txt(document.querySelector('.db-head-target'))
  // 升级提示/引导弹层会吃掉点击：先点掉再继续
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  // 点第一个文案匹配的按钮（antd Button 的 innerText 含图标时也认）
  window.__btn = t => {
    const hit = window.__all('button').find(b => window.__txt(b).indexOf(t) >= 0)
    if (!hit) return 'no-btn:' + t
    hit.click()
    return 'ok'
  }
  window.__btnIn = (sel, t) => {
    const hit = [...document.querySelectorAll(sel + ' button')].filter(window.__vis)
      .find(b => window.__txt(b).indexOf(t) >= 0)
    if (!hit) return 'no-btn:' + t
    hit.click()
    return 'ok'
  }
  // 点第 n 个 antd 页签（data / sql / structure）
  window.__tab = n => {
    const tabs = window.__all('.db-tabs .ant-tabs-tab')
    if (!tabs[n]) return 'no-tab:' + n + '/' + tabs.length
    tabs[n].click()
    return 'ok'
  }
  window.__activeTab = () => window.__txt(document.querySelector('.db-tabs .ant-tabs-tab-active'))
  // 数据页网格行数（表体 tr，不含表头/占位）
  window.__gridRows = () => window.__q('.db-grid-table .ant-table-row')
  // 列头：点第 n 个可排序表头
  window.__clickSort = n => {
    const hs = window.__all('.db-grid-table .db-col-head-sortable')
    if (!hs[n]) return 'no-head:' + n + '/' + hs.length
    hs[n].click()
    return 'ok'
  }
  window.__sortActive = () => window.__q('.db-grid-table .db-col-sort-active')
  window.__thText = () => window.__all('.db-grid-table thead th').map(window.__txt).join('|')
  // SQLite/PG 的树默认只展开到库节点：表名要先把「关着的 switcher」逐个点开
  window.__expand = () => {
    let n = 0
    for (let i = 0; i < 12; i++) {
      const closed = window.__all('.db-tree .ant-tree-switcher_close')
      if (!closed.length) break
      closed.forEach(s => s.click())
      n += closed.length
    }
    return n
  }
})()`

const writeFixture = () => {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  for (const f of [DB, DB + '-wal', DB + '-shm']) {
    try { fs.unlinkSync(f) } catch (e) {}
  }
  const db = new DatabaseSync(DB)
  db.exec(`
    create table smoke_users (
      id integer primary key,
      name text not null,
      city text,
      score integer
    );
    insert into smoke_users values (1,'ada','beijing',91);
    insert into smoke_users values (2,'bob','shanghai',72);
    insert into smoke_users values (3,'cy','shenzhen',58);
    insert into smoke_users values (4,'dee','hangzhou',88);
  `)
  db.close()
}

async function main () {
  const { check, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('找不到渲染进程页签，先把实例起起来（见文件头用法）')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  const shot = f => cdp.shot(path.join(SHOT_DIR, f))

  check('渲染进程可用（store / pre / translate 都在）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

  await cdp.eval(buildHelpers('electerm-n11b-smoke'))
  await cdp.eval(PROBE)
  check('页内探针装好', await cdp.eval('!!(window.__btn && window.__tab && window.__gridRows)'))

  // 桩残留检测：别的 demo 会把 window.pre.runGlobalAsync 整个换成假数据源，
  // 换完跟着渲染进程存活 —— 不先验一下，"连上了、树里有表"可能量的是假数据
  const stub = await preStubState(cdp)
  check('桥接层是原装的（没被别的 demo 的桩覆盖）',
    String(stub) === 'ok' || String(stub).indexOf('native') >= 0, stub)

  // 清掉上次残留的 db 页签：主进程按连接键复用句柄，旧句柄会指向被删掉的 inode
  await clearDbTabs(cdp)
  writeFixture()
  await sleep(300)

  for (let i = 0; i < 3; i++) {
    if (await cdp.eval('window.__dismiss()') !== 'closed') break
    await sleep(200)
  }

  // ---- 建连：addTab → 挂载 effect 建连 → getMetadata ----
  const tabId = await cdp.eval(`(() => {
    window.store.addTab({
      type: 'database', from: 'quick-connect', title: ${J(TITLE)},
      dbType: 'sqlite', dbFile: ${J(DB)}, readOnly: false, production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  const connected = await waitFor(cdp,
    '!!(window.__head() && window.__head().indexOf(\'smoke.db\') >= 0)', '会话头部等不到库文件名', 25000)
  check('#29 加页签即建连（头部显示库文件名）', connected, await cdp.eval('window.__head()'))
  if (!connected) {
    check('后续判据依赖建连，提前中止', false, cdp.tail(6))
    return finish()
  }

  // ---- 选表：树节点点击 → 数据页网格 ----
  const expanded = await cdp.eval('window.__expand()')
  const hasTree = await waitFor(cdp, 'window.__hasTree && window.__hasTree("smoke_users")',
    '树里等不到 smoke_users', 20000)
  check('元数据树里能展开出表（getMetadata 正常返回）', hasTree,
    { switched: expanded, names: await cdp.eval('window.__txtOf(".db-tree .ant-tree-node-content-wrapper")') })
  await cdp.eval('window.__clickTree("smoke_users")')
  const gridOk = await waitFor(cdp, 'window.__gridRows() >= 4', '数据页网格等不到行', 20000)
  check('选表后数据页出 4 行（R0 基线）', gridOk, await cdp.eval('window.__gridRows()'))

  // ---- #30 视图动作：列头点两次 = 升序 → 降序，第 3 次清空 ----
  const thInfo = await cdp.eval('window.__thText()')
  const sortClick = await cdp.eval('window.__clickSort(1)')
  check('#30 列头排序可点（onColSort 换宿主后仍接线）', sortClick === 'ok', { th: thInfo, ret: sortClick })
  const sorted = await waitFor(cdp, 'window.__sortActive() >= 1', '列头排序箭头没进 active 态', 10000)
  check('#30 点击后列头进入排序态（view.order 已写入）', sorted, {
    active: await cdp.eval('window.__sortActive()'),
    bar: await cdp.eval('window.__txtOf(".db-view-bar")')
  })
  // 再点两次回到「无排序」：#30 的 onViewReset 走的是同一份 applyView
  await cdp.eval('window.__clickSort(1)'); await sleep(400)
  await cdp.eval('window.__clickSort(1)'); await sleep(400)
  check('#30 第三次点击清掉排序（三态循环未破）', await cdp.eval('window.__sortActive()') === 0,
    await cdp.eval('window.__txtOf(".db-view-bar")'))

  // ---- #32 结构区：切到「结构」页签 ----
  const tabRet = await cdp.eval('window.__tab(2)')
  const structOk = await waitFor(cdp, 'window.__cnt(".db-struct-area") > 0', '结构区没渲染', 10000)
  check('#32 结构页签挂出 .db-struct-area', structOk, { tab: tabRet, active: await cdp.eval('window.__activeTab()') })
  const toolCnt = await cdp.eval('window.__cnt(".db-struct-tools button")')
  check('#32 工具行四颗按钮都在（DDL / 自适应列宽 / ER 图 / 结构对比 / 字典导出）', toolCnt >= 4, toolCnt)
  check('#32 结构表格有行（structColumns / structureRows 两个 props 没漏）',
    await cdp.eval('window.__q(".db-struct-area .ant-table-row")') >= 4,
    await cdp.eval('window.__q(".db-struct-area .ant-table-row")'))
  await shot('01-structure-area.png')

  // 字典导出 Dropdown：点开后必须出 md/csv 两项（#32 的 handler 接线）
  const dd = await cdp.eval(`(() => {
    const bs = window.__all('.db-struct-tools button')
    if (!bs.length) return 'no-btn'
    bs[bs.length - 1].click()
    return 'ok'
  })()`)
  const ddOpen = await waitFor(cdp,
    "window.__cnt('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item') >= 2",
    '字典导出下拉没展开', 5000)
  check('#32 字典导出下拉展开出两项（exportDictionary 仍挂在 onClick）', ddOpen,
    { ret: dd, items: await cdp.eval("window.__txtOf('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')") })
  await cdp.eval('document.body.click()')
  await sleep(250)

  // ---- #31a / #31b 历史 / 收藏面板 ----
  const sqlTab = await cdp.eval('window.__tab(1)')
  await sleep(600)
  check('切到 SQL 页签（面板所在区域）', sqlTab === 'ok', await cdp.eval('window.__activeTab()'))

  const entry = await cdp.eval(`(() => {
    const btn = window.__all('.db-sql-toolbar button, .db-sql-bar button, .db-sql-area button')
      .find(b => /历史|History/i.test(window.__txt(b)))
    if (!btn) return 'no-entry'
    btn.click()
    return 'ok'
  })()`)
  const popOpen = await waitFor(cdp, 'window.__cnt(".db-history-pop") > 0', '历史/收藏弹层没打开', 8000)
  check('#31 历史/收藏弹层可打开（触发按钮在外层 owner，面板在组件内）', popOpen, entry)
  if (popOpen) {
    await sleep(500)
    check('#31a 默认历史 tab 渲染 .db-history-head + 列表/空态',
      await cdp.eval("window.__q('.db-history-head') > 0 && (window.__q('.db-history-empty') + window.__q('.db-history-item')) > 0"),
      { head: await cdp.eval('window.__txtOf(".db-history-head")') })
    await shot('02-history-panel.png')

    const favSwitch = await cdp.eval('window.__btnIn(".db-history-tabbar", "收藏") || window.__btnIn(".db-history-tabbar", "Favorites")')
    const favOk = await waitFor(cdp, 'window.__cnt(".db-fav-body") > 0', '收藏面板没渲染', 6000)
    check('#31b 切到收藏 tab 渲染 .db-fav-body + 工具条', favOk && await cdp.eval('window.__cnt(".db-fav-toolbar button") >= 3'),
      { ret: favSwitch, btns: await cdp.eval('window.__cnt(".db-fav-toolbar button")') })
    await shot('03-fav-panel.png')

    const backRet = await cdp.eval('window.__btnIn(".db-history-tabbar", "历史") || window.__btnIn(".db-history-tabbar", "History")')
    const backOk = await waitFor(cdp, 'window.__cnt(".db-history-head") > 0', '切回历史面板失败', 6000)
    check('#31a 两个 tab 来回切换都正常（switchPanelTab 未受影响）', backOk, backRet)

    check('#31a 单条删除按钮存在（#31a 搬走后 CloseOutlined 仍在）',
      await cdp.eval("!!document.querySelector('.db-history-del')") ||
      await cdp.eval("window.__q('.db-history-item') === 0"),
      await cdp.eval('window.__q(".db-history-item")'))
    await cdp.eval('document.body.click()')
    await sleep(300)
  }

  // ---- 渲染层异常：这套判据唯一能抓住「compile 通、运行时炸」的通道 ----
  const hard = cdp.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|is not defined|TypeError|uncaught|Warning:/.test(s)
  })
  check('渲染层没有硬错误（undefined 调用 / 组件崩溃都会落在这里）', hard.length === 0, hard.slice(0, 6))
  await shot('04-final.png')

  await cdp.eval(`window.store.delTab(${J(tabId)})`)
  return finish()

  function finish () {
    const fail = results.filter(r => !r.ok)
    console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
    if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
    return fail.length
  }
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
