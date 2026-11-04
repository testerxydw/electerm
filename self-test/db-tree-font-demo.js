#!/usr/bin/env node
/**
 * P-1/P-2 元数据树的对象名接入数据面字体 —— CDP 实机回归（假元数据，无需真库）
 *
 * 拍板口径（2026-11-04）：树里"要照着敲"的标识符（库 / schema / 表 / 视图 / 过程…）
 * 按数据面处理，吃 --db-code-font；分组标签（本地化界面词）、计数徽标、S 标记、对象图标、
 * 降级感叹号、过滤输入框、页签标签这些 chrome 留在界面字体。
 *
 * 为什么必须实机（源码契约只钉得住"声明存在"）：
 *   1) 令牌停在哪儿才算数。antd 在 .ant-tree 根上用 resetComponent 重新声明了界面字体，
 *      声明写在 .db-tree-panel 上会被那一层截断 —— 只有量到名字那一层的 computed 才知道接通了。
 *   2) 三级回落（tab.fontFamily → config.fontFamily → --font-mono）在树上是否真按序生效。
 *   3) 边界没有外溢：整棵面板里"吃令牌的元素"必须恰好是 .db-tree-name 子树。
 *   4) JSX 包一层 <span> 会不会改变行高（U4 钉过 24px 严格一致）。
 *   redis 分支的库名（.db-tree-db-name）是另一条 JSX 分支，也顺手量一遍。
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync，并临时改 window.store._config.fontFamily /
 *    当前页签的 fontFamily；两者都在收尾还原。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（隔离 HOME）
 *   3) node self-test/db-tree-font-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9231'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-tree-font-demo-shots')

// 本机可区分的公共字体名，仅作探针值；判据比的是 computed font-family 字符串
const FONT_A = 'Liberation Mono'
const FONT_B = 'Andale Mono'
const FONT_TAB = 'Noto Mono'

const normFont = s => String(s || '')
  .replace(/["']/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

// 假元数据：一个 MySQL 形状的库（表 / 视图 / 例程分组 / 触发器分组）
// + 一个带 schema 层的库（覆盖 .db-tree-schema 与 S 标记那条分支）
const TREE = [{
  name: 'font_demo',
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
      children: [{ name: 'trg_users', type: 'trigger', table: 'users' }]
    }
  ]
}, {
  name: 'font_demo_pg',
  type: 'database',
  children: [
    {
      name: 'public',
      type: 'schema',
      children: [
        { name: 't_one', type: 'table' },
        { name: 'v_two', type: 'view' }
      ]
    }
  ]
}]

// redis 分支的库列表（db0 有 count，db1 没有 → 顺手确认"无计数"时仍只有名字吃令牌）
const REDIS = [{ name: 'db0', count: 12 }, { name: 'db1' }]

const STUB = `
(() => {
  const TREE = ${JSON.stringify(TREE)}
  const REDIS = ${JSON.stringify(REDIS)}
  window.__redisTab = null
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      if (op === 'getMetadata') {
        return Promise.resolve(String(a[0]) === String(window.__redisTab) ? REDIS : TREE)
      }
      if (op === 'describeTable' || op === 'listColumns' || op === 'getReferences' ||
        op === 'getTableStructure') return Promise.resolve(op === 'getTableStructure' ? { columns: [], foreignKeys: [] } : [])
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
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !!el && !window.__hidden(el)
  window.__scope = () => document.querySelector('.session-current') || document
  window.__tree = () => [...document.querySelectorAll('.db-tree')].filter(window.__vis)[0] || null
  window.__fam = el => el ? getComputedStyle(el).fontFamily : 'no-el'
  window.__tok = () => {
    const w = document.querySelector('.db-session-wrap')
    return w ? getComputedStyle(w).getPropertyValue('--db-code-font') : 'no-wrap'
  }
  window.__monoToken = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
  window.__cfgFont = () => {
    const c = window.store._config || {}
    return c.fontFamily === undefined ? 'undefined' : String(c.fontFamily)
  }
  window.__setCfgFont = v => {
    if (v === null) { window.store.setConfig({ fontFamily: undefined }); return 'set-undefined' }
    window.store.setConfig({ fontFamily: String(v) })
    return 'set'
  }
  window.__tabFont = () => {
    const t = (window.store.tabs || []).find(x => String(x.id) === String(window.store.activeTabId))
    if (!t) return 'no-tab'
    return t.fontFamily === undefined ? 'undefined' : String(t.fontFamily)
  }
  window.__setTabFont = v => {
    const id = String(window.store.activeTabId)
    window.store.updateTab(id, { fontFamily: v === null ? undefined : String(v) })
    return id
  }
  // React 受控 Input：改 el.value 不触发 onChange，必须走原生 setter + input 事件
  window.__filterInput = () => {
    const box = [...window.__scope().querySelectorAll('.db-tree-filter')].filter(window.__vis)[0]
    return box ? box.querySelector('input') : null
  }
  window.__setFilter = v => {
    const el = window.__filterInput()
    if (!el) return 'no-input'
    el.focus()
    const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    st.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__node = text => {
    const t = window.__tree()
    if (!t) return null
    return [...t.querySelectorAll('.ant-tree-node-content-wrapper')]
      .filter(window.__vis)
      .find(w => String(w.innerText || '').indexOf(text) >= 0) || null
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
  window.__rowHeights = () => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    return JSON.stringify([...t.querySelectorAll('.ant-tree-node-content-wrapper')]
      .filter(window.__vis).map(n => Math.round(n.getBoundingClientRect().height)))
  }
  // 逐行明细：定位"哪一类行高度不同"，只看数字排不出原因
  window.__rowDump = () => {
    const t = window.__tree()
    if (!t) return 'no-tree'
    return JSON.stringify([...t.querySelectorAll('.ant-tree-node-content-wrapper')]
      .filter(window.__vis).map(n => {
        const r = n.getBoundingClientRect()
        return {
          t: String(n.innerText || '').replace(/\\s+/g, ' ').slice(0, 16),
          h: Math.round(r.height),
          mk: n.querySelectorAll('mark.db-tree-hit').length
        }
      }))
  }
  // A/B 对照：临时把名字那层的字体退回继承（等价于"接入前"的树），用来证明
  // 行高差异不是本次接入带来的（判据比的是接入前后同一组数字）
  window.__unwire = on => {
    const id = '__p12_unwire'
    const old = document.getElementById(id)
    if (old) old.remove()
    if (on) {
      const st = document.createElement('style')
      st.id = id
      st.textContent = '.db-tree-name{font-family:inherit}'
      document.head.appendChild(st)
      return 'unwired'
    }
    return 'wired'
  }
  // 一次性把树上每一层的字体取回来
  window.__fontMap = () => {
    const s = window.__scope()
    const names = [...s.querySelectorAll('.db-tree .db-tree-name')].filter(window.__vis)
      .map(el => ({ text: String(el.innerText || '').trim(), ff: window.__fam(el) }))
      .filter(x => x.text.length > 0)
    const chromePick = [
      ['count', '.db-tree .db-tree-count'],
      ['mark', '.db-tree .db-tree-schema-mark'],
      ['objIcon', '.db-tree .db-tree-obj-icon'],
      ['dbCount', '.db-tree .db-tree-db-count'],
      ['title', '.db-tree .ant-tree-title'],
      ['filterInput', '.db-tree-filter input'],
      ['innerTab', '.db-tabs .ant-tabs-tab-btn']
    ]
    const chrome = {}
    for (const [k, sel] of chromePick) {
      const el = [...s.querySelectorAll(sel)].filter(window.__vis)[0]
      if (el) chrome[k] = window.__fam(el)
    }
    // 分组行：.db-tree-schema 里没有 .db-tree-name 的那一条（标签是界面词，故意不包）
    const groupRows = [...s.querySelectorAll('.db-tree .db-tree-schema')]
      .filter(el => window.__vis(el) && !el.querySelector('.db-tree-name'))
      .map(el => ({ text: String(el.innerText || '').trim(), ff: window.__fam(el), hasName: !!el.querySelector('.db-tree-name') }))
    // 面板里"吃令牌的元素"清单：判据要求它们全部落在 .db-tree-name 子树内
    const tok = window.__tok().trim()
    const leak = []
    const walk = el => {
      for (const c of el.children) {
        if (!window.__vis(c)) continue
        if (tok && window.__fam(c).replace(/["']/g, '').indexOf(tok.replace(/["']/g, '')) === 0 &&
          !c.closest('.db-tree-name')) {
          leak.push(c.tagName + '.' + String(c.className).split(/\\s+/)[0])
        }
        walk(c)
      }
    }
    const panel = [...s.querySelectorAll('.db-tree-panel')].filter(window.__vis)[0]
    if (panel) walk(panel)
    return JSON.stringify({
      ui: getComputedStyle(document.body).fontFamily,
      tok,
      names,
      chrome,
      groupRows,
      leak,
      scanned: panel ? panel.querySelectorAll('*').length : 0
    })
  }
  // 过滤高亮：mark 必须跟着名字（在 .db-tree-name 里、字体与名字同一）
  window.__markRead = () => JSON.stringify([...window.__scope().querySelectorAll('.db-tree mark.db-tree-hit')]
    .filter(window.__vis)
    .map(m => {
      const nm = m.closest('.db-tree-name')
      const mr = m.getBoundingClientRect()
      const nr = nm ? nm.getBoundingClientRect() : null
      return {
        t: String(m.innerText || '').trim(),
        ff: window.__fam(m),
        nameFf: nm ? window.__fam(nm) : 'mark-not-in-name',
        sameLine: nr ? Math.abs(mr.top - nr.top) < 2 : false,
        inside: nr ? (mr.left >= nr.left - 1 && mr.right <= nr.right + 1) : false
      }
    }))
  return 'probe-installed'
})()
`

const OPEN_TAB = (dbType, title, asRedis) => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: ${JSON.stringify(title)},
    dbType: ${JSON.stringify(dbType)},
    dbHost: '127.0.0.1',
    dbPort: ${dbType === 'redis' ? 6379 : 3306},
    dbUser: 'demo',
    dbPassword: '',
    dbName: ${dbType === 'redis' ? "'0'" : "'font_demo'"},
    dbSsl: false,
    readOnly: false,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created && ${asRedis ? 'true' : 'false'}) window.__redisTab = String(created.id)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}
const brief = o => JSON.stringify(o).slice(0, 220)

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
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

  // 原值按"值"取（fontFamily 本机可能就是 undefined），收尾照原样还回去
  const fontBefore = await cdp.eval('(() => { const c = window.store._config || {}; return c.fontFamily })()')

  check('桩与探针装好', await cdp.eval(STUB) === 'stub-installed' &&
    await cdp.eval(PROBE) === 'probe-installed')

  // ---------- 打开假元数据的 MySQL 形状页签，把树全部展开 ----------
  const opened = JSON.parse(await cdp.eval(OPEN_TAB('mysql', 'tree font demo', false)))
  if (!opened.id) throw new Error('database tab was not created')
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(opened.id)}`, 'tab active')
  await waitFor(cdp, '!!window.__tree()', 'tree rendered')
  await cdp.eval('window.__expand("font_demo")')
  await waitFor(cdp, '!!window.__node("v_active")', 'db children')
  await sleep(600)
  for (const [labelKey, child] of [['dbRoutines', 'sp_demo'], ['dbTriggers', 'trg_users']]) {
    const text = await cdp.eval(`window.translate(${JSON.stringify(labelKey)})`)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval(`!!window.__node(${JSON.stringify(child)})`)) break
      await cdp.eval(`window.__expand(${JSON.stringify(text)})`)
      await sleep(500)
    }
    await waitFor(cdp, `!!window.__node(${JSON.stringify(child)})`, child, 4000)
  }
  await cdp.eval('window.__expand("font_demo_pg")')
  await waitFor(cdp, '!!window.__node("public")', 'pg db children')
  await sleep(400)
  await cdp.eval('window.__expand("public")')
  await waitFor(cdp, '!!window.__node("t_one")', 'schema children')
  await sleep(600)

  const m0 = await cdp.jeval('window.__fontMap()')
  check('树上五层节点都渲染出名字（库/schema/表/视图/过程/触发器，≥8 个样本）',
    m0.names.length >= 8, { n: m0.names.length, sample: m0.names.slice(0, 3) })
  // U4 钉过"所有树行行高一致"，这里先取一份展开态基线，后面过滤态与之对照
  const hPlain = JSON.parse(await cdp.eval('window.__rowHeights()'))
  check('展开态行高一致（U4 的 24px 口径没被包装层破坏）',
    hPlain.length > 5 && Math.max(...hPlain) - Math.min(...hPlain) === 0, hPlain)

  // ---------- 第 2 级：全局 config.fontFamily 就是令牌，名字那一层吃到 ----------
  await cdp.eval('window.__setCfgFont(' + JSON.stringify(FONT_A) + ')')
  await sleep(700)
  const mA = await cdp.jeval('window.__fontMap()')
  const tokA = normFont(mA.tok)
  check('令牌活体注入到 .db-session-wrap（全局字体 = ' + FONT_A + '）', tokA === normFont(FONT_A), brief(mA.tok))
  check('每个树名字 computed 都等于令牌（不是停在 wrapper）',
    mA.names.length > 0 && mA.names.every(x => normFont(x.ff) === tokA),
    { n: mA.names.length, off: mA.names.filter(x => normFont(x.ff) !== tokA).slice(0, 3) })

  const chromeA = Object.keys(mA.chrome).filter(k => normFont(mA.chrome[k]) === tokA)
  check('chrome 不吃令牌（计数/S 标记/图标/标题外壳/过滤框/内层页签）',
    Object.keys(mA.chrome).length >= 4 && chromeA.length === 0, mA.chrome)
  check('界面字体与令牌确实可区分（防"两者同栈"真空通过）',
    normFont(mA.ui) !== tokA, { ui: normFont(mA.ui).slice(0, 40), tokA })

  // ---------- 边界：吃令牌的元素恰好只有名字那一层 ----------
  check('面板里没有第二处吃令牌的元素（数据面不外溢到 chrome）',
    mA.scanned > 20 && mA.leak.length === 0, { scanned: mA.scanned, leak: mA.leak })

  // ---------- 分组标签留在界面字体 ----------
  const grp = mA.groupRows.filter(x => x.text.length > 0)
  check('分组行存在且不含 .db-tree-name（标签是界面词）', grp.length >= 1 &&
    grp.every(x => !x.hasName), { groups: grp.map(x => x.text) })
  check('分组行字体不等于令牌', grp.length >= 1 &&
    grp.every(x => normFont(x.ff) !== tokA), grp.map(x => x.ff.slice(0, 24)))

  // ---------- 活体：换全局字体，名字跟着换、chrome 不动 ----------
  await cdp.eval('window.__setCfgFont(' + JSON.stringify(FONT_B) + ')')
  await sleep(700)
  const mB = await cdp.jeval('window.__fontMap()')
  const tokB = normFont(mB.tok)
  check('令牌跟着换（不重载页面）', tokB === normFont(FONT_B) && tokB !== tokA, { tokA, tokB })
  check('树名字全部换成新令牌值',
    mB.names.length > 0 && mB.names.every(x => normFont(x.ff) === tokB),
    { n: mB.names.length, off: mB.names.filter(x => normFont(x.ff) !== tokB).slice(0, 2) })
  check('chrome 在换字体后纹丝不动',
    Object.keys(mB.chrome).every(k => normFont(mB.chrome[k]) === normFont(mA.chrome[k])),
    { before: mA.chrome, after: mB.chrome })

  // ---------- 第 1 级：页签字体压过全局 ----------
  await cdp.eval('window.__setTabFont(' + JSON.stringify(FONT_TAB) + ')')
  await sleep(700)
  const mT = await cdp.jeval('window.__fontMap()')
  const cfgStill = normFont(await cdp.eval('window.__cfgFont()'))
  check('第 1 级优先：页签字体覆盖全局，名字换成页签的值（全局原样）',
    normFont(mT.tok) === normFont(FONT_TAB) && cfgStill === normFont(FONT_B) &&
    mT.names.length > 0 && mT.names.every(x => normFont(x.ff) === normFont(FONT_TAB)),
    { tok: normFont(mT.tok).slice(0, 24), cfgStill })

  // ---------- 第 3 级：两级都清空 → 回落 --font-mono，而不是界面字体/空值 ----------
  await cdp.eval('window.__setTabFont(null)')
  await cdp.eval('window.__setCfgFont(null)')
  let tokEmpty = 'x'
  for (let i = 0; i < 12; i++) {
    await sleep(400)
    tokEmpty = String(await cdp.eval('window.__tok()')).trim()
    if (tokEmpty === '') break
  }
  const mF = await cdp.jeval('window.__fontMap()')
  const mono0 = normFont(await cdp.eval('window.__monoToken()'))
  const monoReal = mono0 !== '' && mono0 !== normFont(mF.ui)
  const nameF = mF.names.length ? normFont(mF.names[0].ff) : ''
  check('第 3 级回落：两级清空后名字是 tokens 里那条 --font-mono 栈',
    tokEmpty === '' && monoReal && mF.names.length > 0 &&
    mF.names.every(x => normFont(x.ff) === mono0),
    {
      tokEmpty,
      monoReal,
      mono0: mono0.slice(0, 40),
      got: nameF.slice(0, 40),
      ui: normFont(mF.ui).slice(0, 24)
    })

  // 后面几项要一个已知值，先恢复全局
  await cdp.eval('window.__setCfgFont(' + JSON.stringify(FONT_A) + ')')
  await sleep(700)

  // ---------- 过滤高亮跟着名字，且不换行 ----------
  const setF = await cdp.eval('window.__setFilter("o")')
  await sleep(800)
  const marks = JSON.parse(await cdp.eval('window.__markRead()'))
  check('过滤命中高亮在场', setF === 'ok' && marks.length >= 3, { setF, n: marks.length })
  check('高亮 mark 在 .db-tree-name 内且与名字同一字体',
    marks.length > 0 && marks.every(x => x.nameFf !== 'mark-not-in-name' &&
      normFont(x.ff) === normFont(x.nameFf) && normFont(x.ff) === normFont(FONT_A)),
    marks.slice(0, 3))
  check('高亮没有把名字撕成多行（同一行盒、mark 落在名字矩形内）',
    marks.length > 0 && marks.every(x => x.sameLine && x.inside), marks.slice(0, 3))
  // 过滤态的行高：接入前/后各量一遍（__unwire 把名字退回继承 = 接入前的树）。
  // 差异若来自"命中标记换行/名字被 gap 撕开"，两边不会同数字；数字相同才说明
  // 本次接入没动行盒（过滤态本身有 ±1px 的行高浮动，那是 mark 的老问题，不在这条判据里）
  const hWired = await cdp.eval('window.__rowDump()')
  await cdp.eval('window.__unwire(true)')
  await sleep(400)
  const hUnwired = await cdp.eval('window.__rowDump()')
  await cdp.eval('window.__unwire(false)')
  await sleep(300)
  check('过滤态行高与"接入前"逐行一致（数据面字体没改变行盒）',
    hWired === hUnwired && JSON.parse(hWired).length > 5,
    { wired: JSON.parse(hWired).slice(0, 6), unwired: JSON.parse(hUnwired).slice(0, 6) })
  await cdp.eval('window.__setFilter("")')
  await sleep(600)

  await cdp.shot(path.join(SHOT_DIR, '1-tree-names-mono.png'))

  // ---------- redis 分支的库名（另一条 JSX 分支）----------
  const redisOpen = JSON.parse(await cdp.eval(OPEN_TAB('redis', 'tree font demo redis', true)))
  if (!redisOpen.id) throw new Error('redis tab was not created')
  const redisReady = await waitFor(cdp, '!!window.__node("db0")', 'redis tree')
  const mR = await cdp.jeval('window.__fontMap()')
  const redisName = mR.names.find(x => x.text.indexOf('db0') >= 0)
  check('redis 库名（.db-tree-db-name）也吃令牌',
    redisReady && !!redisName && normFont(redisName.ff) === normFont(FONT_A),
    { redisReady, name: redisName ? redisName.ff.slice(0, 24) : 'no-db0-name' })
  check('redis 键数徽标不吃令牌',
    !!mR.chrome.dbCount && normFont(mR.chrome.dbCount) !== normFont(FONT_A),
    { dbCount: String(mR.chrome.dbCount).slice(0, 24), leak: mR.leak })
  check('redis 面板同样没有第二处吃令牌的元素', mR.leak.length === 0, { leak: mR.leak })

  // ---------- 还原：字体回界面，截图看"没接入时"的样子 ----------
  await cdp.eval('window.__setCfgFont(null)')
  await sleep(700)
  await cdp.shot(path.join(SHOT_DIR, '2-tree-fallback-mono.png'))
  const restored = await cdp.eval('window.__setCfgFont(' +
    JSON.stringify(fontBefore === undefined ? null : fontBefore) + ')')
  await sleep(600)
  const endFont = await cdp.eval('(() => { const c = window.store._config || {}; return c.fontFamily })()')
  const endTabFont = await cdp.eval('window.__tabFont()')
  const closed = await clearDbTabs(cdp)
  check('收尾还原全局字体、页签字体并关掉自开页签',
    String(restored).indexOf('set') === 0 && String(endFont) === String(fontBefore) &&
    endTabFont === 'undefined' && closed.left.length === 0,
    { endFont: String(endFont), fontBefore: String(fontBefore), endTabFont, left: closed.left })

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
