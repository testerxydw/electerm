#!/usr/bin/env node
/**
 * SQL 结果工作台 · 本页过滤 —— CDP 实机验收（桩数据，无需真库）
 *
 * 设计文档 §2（SQL 结果工作台增强）第 3 项「过滤输入」的效果，逐条在真实渲染层里量：
 *   F1) 工具行里有过滤框，占位文案走词条；筛的是**整份结果**而不是当前页
 *       （在第 1 页筛一个只出现在第 16、39 页的值，网格要直接把那行端上来）。
 *   F2) 输入防抖 150ms：敲下去的一瞬间行数不变，到点才扫；纯前端过滤，
 *       一次都不该再惊动 executeSql。
 *   F3) 分页口径跟着命中数走：筛完不足一页就没分页器；跨页时页数 = ceil(命中/每页)，
 *       且停在第 5 页时筛到 2 行不会留在一页空白上。
 *   F4) 所见即所得：大小写不敏感、数字按文本、NULL 按格子里的 "NULL"、命中任意列。
 *   F5) 命中 0 时给的是"红的 0/总数 + 空网格"，而页大小/导出/列宽工具不能跟着消失
 *       （显隐看的是这次执行有没有回行，不是命中数）。
 *   F6) 每个结果集一份过滤状态：切页签互不串味；重新执行把过滤与输入框一起清掉。
 *   F7) 筛选后单击单元格，工具条报的行号仍是**结果内绝对下标**（不是页内第几行）。
 *   F8) 1 万行不回归：虚拟化仍在、DOM 行数远小于命中数、扫一遍的墙上时间可接受。
 *   F9) 双主题下工具行不塌陷、过滤框宽度可见。
 *
 * 用法：
 *   1) npm run compile
 *   2) rsync -a src/app/ work/app/   # 词条在主进程里 require，compile 并不同步 src/app
 *                                       # （不带 --delete，别清掉生成的 work/app/package.json）
 *   3) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a3/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   4) node self-test/db-sql-workbench-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, rowRe, clickCell
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-workbench-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const ROWS = 10000
const PAGE = 200
const DEBOUNCE = 150

const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

// 桩数据要点（都是假数据，可以随意外传内容，判据里直接比明文）：
// - 1 万行：够测"扫一遍的墙上时间"，也够让"筛到第 16/39 页的值"成为跨页判据
// - xneedle 只挂在第 3001、7777 行；ADMIN 只挂在第 5、500、9000 行（测大小写不敏感）
// - nullable 每 2500 行一个 null → 恰好 4 个 NULL（测"按格子里看到的 NULL 筛"）
// - id 是 number：筛 '10000' 要能命中（数字按文本匹配，不要求用户先转类型）
// - 结果集 2 只有 2 行：与结果集 1 的过滤状态必须互不串味
const FIXTURE = `
(() => {
  const COLS = [
    { name: 'id', type: 'int' },
    { name: 'note', type: 'varchar' },
    { name: 'tag', type: 'varchar' },
    { name: 'upper', type: 'varchar' },
    { name: 'nullable', type: 'varchar' }
  ]
  const rows = []
  for (let i = 1; i <= ${ROWS}; i++) {
    rows.push({
      id: i,
      note: 'note-' + i,
      tag: (i === 3001 || i === 7777) ? 'xneedle' : 'common',
      upper: (i === 5 || i === 500 || i === 9000) ? 'ADMIN' : 'user',
      nullable: (i % 2500 === 0) ? null : 'v'
    })
  }
  const rows2 = [{ id: 'A-1', payload: 'short' }, { id: 'A-2', payload: '2026-01-05 08:30:00' }]

  // 独立参照系（不是产品实现）：值全是串/数/NULL，String(v) 就是格子里看到的文本，
  // 所以这里用最朴素的逐格 includes 就能算出"应该命中几行"
  window.__expectCount = q => {
    const needle = String(q).toLowerCase()
    let n = 0
    for (const r of rows) {
      const hit = Object.keys(r).some(k => String(r[k] === null ? 'NULL' : r[k]).toLowerCase().indexOf(needle) >= 0)
      if (hit) n++
    }
    return n
  }

  window.__dbStubCalls = []
  window.__sqlMode = 'one'
  window.__lastSql = null
  window.__execN = 0
  window.__sqlResults = () => {
    if (window.__sqlMode === 'two') {
      return [
        { sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows },
        {
          sql: 'second',
          fields: ['id', 'payload'],
          columns: [{ name: 'id', type: 'varchar' }, { name: 'payload', type: 'text' }],
          rows: rows2
        }
      ]
    }
    return [{ sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows }]
  }

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      if (name === 'dbGridViewOp') return Promise.resolve(null)
      if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve(null)
    }
    const op = a[1]
    const args = a[2] || {}
    window.__dbStubCalls.push(op)
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [
          { name: 'typed_tbl', type: 'table' },
          { name: 'other_tbl', type: 'table' }
        ]
      }])
    }
    if (op === 'executeSql') {
      window.__lastSql = args.sql
      window.__execN = window.__execN + 1
      return Promise.resolve({ results: window.__sqlResults() })
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: COLS.map(c => ({ name: c.name, dataType: c.type, isPk: c.name === 'id' })),
        foreignKeys: []
      })
    }
    if (op === 'describeTable') {
      return Promise.resolve(COLS.map(c => ({
        Field: c.name, Type: c.type, Null: 'YES', Key: '', Default: null, Extra: '', Comment: ''
      })))
    }
    if (op === 'getPageData') {
      return Promise.resolve({ rows: rows.slice(0, 20), totalRows: rows.length, page: 1, hasMore: true })
    }
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__h1wb = 'stub'
  return 'stub-installed'
})()
`

// 过滤专项探针：都只读"看得见的那一处"（多结果集时非激活页签也在 DOM 里）
const PROBE = `
(() => {
  const tools = () => [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0] || null
  window.__fWrap = () => {
    const t = tools()
    const w = t && t.querySelector('.db-sql-filter')
    return w && window.__vis(w) ? w : null
  }
  window.__fInput = () => {
    const w = window.__fWrap()
    const i = w && w.querySelector('input')
    return i && window.__vis(i) ? i : null
  }
  window.__fSet = text => {
    const i = window.__fInput()
    if (!i) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, String(text))
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__fValue = () => {
    const i = window.__fInput()
    return i === null ? null : String(i.value)
  }
  window.__fClear = () => {
    const w = window.__fWrap()
    const x = w && w.querySelector('.ant-input-clear-icon')
    if (!x || !window.__vis(x)) return 'no-clear'
    x.click()
    return 'ok'
  }
  // 命中/总数那条 span：文本、解析出的 m/t、是否走了"零命中"红色档
  // （正则用 [0-9] 而不是反斜杠类 —— 这段源码要穿过一层模板字符串，反斜杠数容易数错）
  window.__fHit = () => {
    const t = tools()
    const el = t && [...t.querySelectorAll('.db-sql-filter-hit')].filter(window.__vis)[0]
    if (!el) return JSON.stringify({ exists: 0, tools: t ? 1 : 0 })
    const txt = String(el.innerText || '').trim()
    const m = /([0-9]+)[^0-9]+([0-9]+)/.exec(txt)
    const r = el.getBoundingClientRect()
    return JSON.stringify({
      exists: 1,
      text: txt,
      m: m ? Number(m[1]) : -1,
      t: m ? Number(m[2]) : -1,
      emptyCls: /db-sql-filter-hit-empty/.test(String(el.className)) ? 1 : 0,
      color: getComputedStyle(el).color,
      w: Math.round(r.width),
      h: Math.round(r.height)
    })
  }
  // 工具行里除过滤框之外还剩什么：页大小 Select、导出、列宽工具
  window.__fTools = () => {
    const t = tools()
    if (!t) return JSON.stringify({ exists: 0 })
    const vis = els => [...els].filter(window.__vis)
    return JSON.stringify({
      exists: 1,
      h: Math.round(t.getBoundingClientRect().height),
      filter: window.__fWrap() ? 1 : 0,
      fw: window.__fWrap() ? Math.round(window.__fWrap().getBoundingClientRect().width) : -1,
      placeholder: window.__fInput() ? String(window.__fInput().placeholder) : '',
      pagesize: vis(t.querySelectorAll('.db-grid-pagesize')).length,
      buttons: vis(t.querySelectorAll('button')).length,
      pager: vis(t.querySelectorAll('.ant-pagination')).length,
      pages: vis(t.querySelectorAll('.ant-pagination-item')).map(x => x.innerText.trim()),
      totalText: (() => {
        const el = vis(t.querySelectorAll('.ant-pagination-total-text'))[0]
        return el ? String(el.innerText || '').trim() : ''
      })(),
      current: (() => {
        const el = vis(t.querySelectorAll('.ant-pagination-item-active'))[0]
        return el ? Number(String(el.innerText).trim()) : -1
      })()
    })
  }
  // 防抖只能量"敲下第一个字到命中数变化"这一段：MutationObserver 记 DOM 改动的时刻，
  // 比 node 侧轮询准（轮询间隔 30~200ms，量不出 150ms 这一档）
  window.__fArm = () => {
    window.__fT0 = performance.now()
    window.__fAt = null
    if (window.__fObs) window.__fObs.disconnect()
    let prev = (() => {
      const h = JSON.parse(window.__fHit())
      return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
    })()
    window.__fObs = new MutationObserver(() => {
      const now = (() => {
        const h = JSON.parse(window.__fHit())
        return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
      })()
      if (now !== prev) {
        prev = now
        if (window.__fAt === null) window.__fAt = performance.now()
      }
    })
    window.__fObs.observe(document.body, { childList: true, subtree: true, characterData: true })
    return 'armed'
  }
  // 敲下之后的"立刻"读数：这一刻必须还在防抖窗口内（node 往返 ~10ms）
  window.__fPeek = () => JSON.stringify({
    since: Math.round(performance.now() - window.__fT0),
    hit: JSON.parse(window.__fHit()).exists,
    rows: window.__rows().length
  })
  window.__fElapsed = () => (window.__fAt === null ? -1 : Math.round(window.__fAt - window.__fT0))
  return 'probe-installed'
})()
`

const MYSQL_TAB = {
  type: 'database',
  from: 'quick-connect',
  title: 'mysql 127.0.0.1:3306',
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'demo',
  dbPassword: '',
  dbName: 'demo_db',
  dbSsl: false,
  readOnly: false,
  production: false,
  batch: null
}

const runSql = async cdp => {
  const before = Number(await cdp.eval('window.__execN'))
  const clicked = await cdp.eval('window.__clickRunSql()')
  const fired = await waitFor(cdp, 'window.__execN > ' + before, 'executeSql #' + (before + 1), 8000)
  await sleep(700)
  return { before, after: Number(await cdp.eval('window.__execN')), clicked, fired }
}

// 写过滤词 → 等命中 span 出现/变化（防抖之后才算数）
// arm 与 set 必须压在同一个 CDP 往返里：分两次的话"敲下第一个字"到"读数"之间
// 已经吃掉两个往返，150ms 的防抖窗口就被量成"看起来没防抖"了
const typeFilter = async (cdp, text) => {
  const set = await cdp.eval('window.__fArm(); window.__fSet(' + JSON.stringify(text) + ')')
  const peek = await cdp.jeval('window.__fPeek()')
  const t0 = Date.now()
  let changed = false
  while (Date.now() - t0 < 5000) {
    if (Number(await cdp.eval('window.__fElapsed()')) >= 0) {
      changed = true
      break
    }
    await sleep(40)
  }
  await sleep(250)
  return { set: String(set).slice(-2), peek, changed, elapsed: Number(await cdp.eval('window.__fElapsed()')) }
}

const firstIdOf = async cdp => String((await cdp.jeval('window.__cellXY("id", 0)')).text)

const readHit = async cdp => JSON.parse(await cdp.eval('window.__fHit()'))
const readTools = async cdp => JSON.parse(await cdp.eval('window.__fTools()'))

// 桩必须在 boot 之后装：pre.js 整对象赋值 window.pre，装早了会被冲掉，
// 于是页签真的去连 127.0.0.1:3306（ECONNREFUSED），判据全退化成"没找到网格"。
// 判据也不能只看哨兵 —— 哨兵只证明挂上去过，不证明这一次 call 被接住。
const stubProbe = async cdp => {
  await cdp.eval(`(() => {
    window.__probe = null
    window.__dbStubCalls = []
    const back = v => { window.__probe = JSON.stringify(v) }
    try {
      Promise.resolve(window.pre.runGlobalAsync('dbClientOp', 'probe-tab', 'getMetadata', { hideSystemSchemas: false }))
        .then(r => back({ ok: true, names: (r || []).map(x => x && x.name) }))
        .catch(e => back({ err: String((e && e.message) || e) }))
    } catch (e) { back({ err: String((e && e.message) || e) }) }
    return 'kicked'
  })()`)
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) {
    const raw = await cdp.eval('window.__probe')
    if (raw) {
      const p = JSON.parse(raw)
      if (!p.ok) {
        return { ok: false, why: p.err || 'no-names' }
      }
      const calls = JSON.parse(await cdp.eval('JSON.stringify(window.__dbStubCalls || [])'))
      return { ok: p.names.indexOf('demo_db') >= 0 && calls.indexOf('getMetadata') >= 0, names: p.names, calls }
    }
    await sleep(150)
  }
  return { ok: false, why: 'probe-timeout' }
}
const stubAlive = async cdp => {
  try {
    if (!(await cdp.eval("!!(window.pre && window.pre.__h1wb === 'stub')"))) {
      return { ok: false, why: 'sentinel-gone' }
    }
    return await stubProbe(cdp)
  } catch (e) {
    return { ok: false, why: String(e.message || e) }
  }
}
const ensureStub = async (cdp, tries = 10) => {
  let last = { ok: false, why: 'not-tried' }
  for (let i = 0; i < tries; i++) {
    last = await stubAlive(cdp)
    if (last.ok) {
      return last
    }
    await cdp.eval(FIXTURE)
    await sleep(400)
  }
  return last
}

let cdpRef = null
const cfg0 = { pageSize: null, sqlPageSize: null, locale: null, theme: null }
const restoreAll = async () => {
  if (!cdpRef) {
    return
  }
  try {
    if (cfg0.sqlPageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ sqlResultPageSize: ' + (Number(cfg0.sqlPageSize) >= 10 ? Number(cfg0.sqlPageSize) : 50) + ' })')
    }
    if (cfg0.pageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ dbPageSize: ' + (Number(cfg0.pageSize) >= 10 ? Number(cfg0.pageSize) : 20) + ' })')
    }
    if (cfg0.locale !== null) {
      await cdpRef.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale) + ' })')
    }
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    console.log('restored: ' + JSON.stringify(cfg0))
  } catch (e) {
    console.log('restore failed (check sqlResultPageSize/theme manually): ' + e.message)
  }
}

let reported = false
const finish = async results => {
  if (!reported && cdpRef) {
    reported = true
    try {
      console.log('stub ops: ' + await cdpRef.eval('JSON.stringify(window.__dbStubCalls.slice(0, 6))'))
    } catch (e) { /* 页签没了就读不到桩日志，不奇怪 */ }
    console.log('renderer events (' + cdpRef.events.length + '):')
    cdpRef.events.slice(-25).forEach(l => console.log('  ' + l))
  }
  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  return fail.length
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  check('重启后渲染进程可用（window.store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  const stub1 = await ensureStub(cdp)
  check('桩真的接管了 dbClientOp（getMetadata 由桩应答，碰不到本机 3306）', stub1.ok, stub1)
  if (!stub1.ok) {
    throw new Error('stub not intercepting: ' + JSON.stringify(stub1))
  }
  await cdp.eval(HELPERS)
  await sleep(400)
  // HELPERS 之后装专项探针：__fHit 用到了 window.__rows，反过来 typeFilter 用到 __fArm
  await cdp.eval(PROBE)
  check('过滤探针装上（输入框/命中 span/工具行三类都探得到）',
    await cdp.eval("window.__fHit && window.__fTools && window.__fArm ? 'yes' : 'no'") === 'yes')

  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  cfg0.pageSize = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  cfg0.sqlPageSize = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')

  check('词条 dbFilterResult / dbFilterHit 已生效（src/app locales 同步、占位符成对）',
    /筛选整个结果|Filter this result/.test(await cdp.eval("String(window.translate('dbFilterResult'))")) &&
    /命中 \{m\}\/\{t\}|\{m\} \/ \{t\} matched/.test(await cdp.eval("String(window.translate('dbFilterHit'))")),
    {
      ph: await cdp.eval("String(window.translate('dbFilterResult'))"),
      hit: await cdp.eval("String(window.translate('dbFilterHit'))")
    })

  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: 200, sqlResultPageSize: ' + PAGE + ' })')
  await sleep(300)

  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /demo_db/.test(String(t.dbName))).map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) {
    await sleep(600)
  }
  const stub2 = await ensureStub(cdp)
  check('开页签前桩仍在位', stub2.ok, stub2)
  await cdp.eval(`
    (() => {
      window.store.addTab(${JSON.stringify(MYSQL_TAB)})
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()
  `)
  check('数据库页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  check('展开库节点并选中表',
    await cdp.eval('window.__clickTree("demo_db")') === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node') &&
    await cdp.eval('window.__clickTree("typed_tbl")') === 'ok')
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(400)

  const SQL_TEXT = 'SELECT * FROM typed_tbl'
  check('SQL 编辑器可聚焦', await cdp.eval('window.__focusSql()') === 'focused')
  await cdp.call('Input.insertText', { text: SQL_TEXT })
  await sleep(200)
  check('doc 里确实是注入的 SQL', String(await cdp.eval('window.__sqlDoc()')).indexOf(SQL_TEXT) === 0)
  const run0 = await runSql(cdp)
  check('桩收到执行请求，1 万行到位',
    run0.fired && await waitFor(cdp, 'window.__rows().length > 5 && window.__colIdx("tag") >= 0', 'grid'), { run0 })
  const geo0 = await cdp.jeval('window.__geom()')
  check('基线：每页 ' + PAGE + ' 行、虚拟化仍生效（DOM 行数远小于本页）',
    geo0.domRows > 5 && geo0.domRows < PAGE && geo0.firstId === '1', geo0)

  // ---------- F1) 工具行里的过滤框 ----------
  const t0s = await readTools(cdp)
  const hit0 = await readHit(cdp)
  check('F1 工具行出现过滤框，占位文案是词条而非裸 key/占位符',
    t0s.filter === 1 && t0s.placeholder.length > 0 && !/[{}]/.test(t0s.placeholder), t0s)
  check('F2 没在过滤时不显示"命中/总数"（不拿 10000/10000 制造噪音）',
    hit0.exists === 0, hit0)
  // antd 分页器只会把首尾几页做成页码按钮（中间折叠成 ...），所以认"第 1 页与末页都在、
  // 底纹文字是总行数"，而不是数满 50 个按钮
  check('F3 分页器按原始行数给页码（末页 ' + (ROWS / PAGE) + '）',
    t0s.pager === 1 && t0s.pages.includes(String(ROWS / PAGE)) && t0s.current === 1 &&
    String(t0s.totalText).indexOf(String(ROWS)) >= 0,
    { pages: t0s.pages, current: t0s.current, totalText: t0s.totalText })

  // ---------- F4/F5) 防抖 + 扫整份结果（跨页命中） ----------
  const execBefore = Number(await cdp.eval('window.__execN'))
  const f1 = await typeFilter(cdp, 'xneedle')
  check('F4 输入防抖：敲下去的一瞬间（' + f1.peek.since + 'ms）行数与命中数都还没动',
    f1.set === 'ok' && f1.peek.since < DEBOUNCE + 60 && f1.peek.hit === 0 && f1.peek.rows === geo0.domRows, f1)
  const hit1 = await readHit(cdp)
  const geo1 = await cdp.jeval('window.__geom()')
  const firstId1 = await firstIdOf(cdp)
  check('F5 到点后扫的是整份结果：只挂在第 3001/7777 行的值，第 1 页也能筛出来',
    f1.changed && hit1.exists === 1 && hit1.m === 2 && hit1.t === ROWS && hit1.emptyCls === 0,
    { hit1, elapsed: f1.elapsed })
  check('F5b 网格只剩命中的 2 行，首行就是第 3001 行（不是页内序号）',
    geo1.domRows === 2 && firstId1 === '3001', { domRows: geo1.domRows, firstId: firstId1 })
  check('F5c 防抖时长量出来在 150ms 档（实测 ' + f1.elapsed + 'ms = 防抖 + 扫描 + 渲染）',
    f1.elapsed >= DEBOUNCE - 20 && f1.elapsed <= DEBOUNCE + 400, { elapsed: f1.elapsed })
  check('F5d 纯前端过滤：一次都没有重新执行 SQL',
    Number(await cdp.eval('window.__execN')) === execBefore,
    { before: execBefore, after: await cdp.eval('window.__execN') })
  check('F5e 筛到 2 行后分页器消失（按命中数算，不按 1 万行算）',
    (await readTools(cdp)).pager === 0, await readTools(cdp))

  // ---------- F6) 大小写 / 数字 / NULL / 任意列 ----------
  const f2 = await typeFilter(cdp, 'XNEEDLE')
  const hit2 = await readHit(cdp)
  check('F6 大小写不敏感（查询串与格里值两侧都算）', hit2.m === 2, { hit2, elapsed: f2.elapsed })
  const f3 = await typeFilter(cdp, '10000')
  const hit3 = await readHit(cdp)
  const firstId3 = await firstIdOf(cdp)
  check('F7 数字列按文本筛：筛 10000 命中 id=10000 那一行',
    f3.changed && hit3.m === 1 && firstId3 === '10000', { hit3, firstId: firstId3, elapsed: f3.elapsed })
  const f4 = await typeFilter(cdp, 'null')
  const hit4 = await readHit(cdp)
  const expectNull = Number(await cdp.eval('window.__expectCount("null")'))
  check('F8 NULL 按格子里看到的 "NULL" 筛（与独立参照算出的 ' + expectNull + ' 行一致）',
    f4.changed && hit4.m === expectNull && expectNull === 4, { hit4, expectNull, elapsed: f4.elapsed })
  const f5 = await typeFilter(cdp, 'adm')
  const hit5 = await readHit(cdp)
  check('F9 命中任意列：adm 命中的是 upper 列里的 ADMIN（3 行）',
    f5.changed && hit5.m === 3, { hit5, expect: await cdp.eval('window.__expectCount("adm")'), elapsed: f5.elapsed })

  // ---------- F10) 零命中 ----------
  const f6 = await typeFilter(cdp, 'zzz-not-in-any-cell')
  const hit6 = await readHit(cdp)
  const tools6 = await readTools(cdp)
  const geo10 = await cdp.jeval('window.__geom()')
  check('F10 零命中给红色的 0/总数（换的是 error 色），网格空',
    f6.changed && hit6.exists === 1 && hit6.m === 0 && hit6.t === ROWS && hit6.emptyCls === 1 &&
    hit6.color !== hit1.color && geo10.domRows === 0,
    { hit6, normalColor: hit1.color, domRows: geo10.domRows })
  check('F10b 工具行的显隐看的是"这次执行有没有回行"：零命中时页大小/导出/列宽工具仍在',
    tools6.pagesize === 1 && tools6.buttons >= 2 && tools6.filter === 1, tools6)

  // ---------- F11) 命中跨页：分页口径 + 停在末页不空白 ----------
  const f7 = await typeFilter(cdp, 'note-1')
  const expect7 = Number(await cdp.eval('window.__expectCount("note-1")'))
  const hit7 = await readHit(cdp)
  const tools7 = await readTools(cdp)
  check('F11 命中数与独立参照一致（' + expect7 + ' 行；产品与参照各算各的）',
    f7.changed && hit7.m === expect7 && hit7.t === ROWS, { hit7, expect7, elapsed: f7.elapsed })
  check('F11b 分页器 total/页数换成命中口径：' + Math.ceil(expect7 / PAGE) + ' 页，底纹文字也跟着',
    tools7.pager === 1 && tools7.pages.length === Math.ceil(expect7 / PAGE) &&
    String(tools7.totalText).indexOf(String(expect7)) >= 0, tools7)
  const geo7 = await cdp.jeval('window.__geom()')
  check('F11c ' + expect7 + ' 行命中下虚拟化没退化（DOM ' + geo7.domRows + ' 行 ≪ 命中数）',
    geo7.virtual === 1 && geo7.domRows < PAGE, geo7)
  await cdp.eval('window.__gotoPage(' + Math.ceil(expect7 / PAGE) + ')')
  await sleep(500)
  const lastBefore = await cdp.jeval('window.__geom()')
  const f8 = await typeFilter(cdp, 'xneedle')
  const afterLastPage = await cdp.jeval('window.__geom()')
  const tools8 = await readTools(cdp)
  const cell8 = await firstIdOf(cdp)
  check('F12 停在最后一页时筛到 2 行：夹回有内容的一页，不留空白页',
    lastBefore.domRows > 2 && f8.changed && afterLastPage.domRows === 2 &&
    cell8 === '3001' && tools8.pager === 0,
    { lastBefore: lastBefore.domRows, after: afterLastPage.domRows, cell8, changed: f8.changed, tools8 })

  // ---------- F13) 清空与恢复 ----------
  const cleared = await cdp.eval('window.__fClear()')
  await sleep(700)
  const geo9 = await cdp.jeval('window.__geom()')
  const tools9 = await readTools(cdp)
  check('F13 点 × 清空：输入框空、命中提示消失、行数与分页器回到全量',
    cleared === 'ok' && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 && geo9.firstId === '1' &&
    geo9.domRows > 5 && tools9.pager === 1 && tools9.current === 1 &&
    // antd 只渲染首尾几个页码项，中间的折成 …，所以认"末页在列表里"而不是项数
    tools9.pages.includes(String(ROWS / PAGE)) &&
    String(tools9.totalText).includes(String(ROWS)),
    { cleared, firstId: geo9.firstId, pages: tools9.pages, current: tools9.current, totalText: tools9.totalText })

  // ---------- F14) 筛选后行号仍是绝对下标 ----------
  await typeFilter(cdp, 'xneedle')
  const cell = await clickCell(cdp, 'id', 1)
  const bar = await cdp.jeval('window.__bar()')
  check('F14 筛完只剩 2 行时单击，工具条报的还是结果内绝对行号（第 7777 行）',
    cell.ok && /^id · /.test(bar.title) && rowRe(7777).test(bar.title), { bar, cell })
  await cdp.eval('window.__fClear()')
  await sleep(600)

  // ---------- F15) 每个结果集一份状态 ----------
  await cdp.eval("window.__sqlMode = 'two'")
  const runTwo = await runSql(cdp)
  check('F15 切到两个结果集（1 万行 + 2 行），重新执行把过滤清干净',
    runTwo.fired && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 &&
    await waitFor(cdp, 'window.__rows().length > 5', 'rerun grid'), { runTwo })
  await typeFilter(cdp, 'xneedle')
  const tabClick = await cdp.eval('window.__clickResultTab("2")')
  await sleep(600)
  const valB = await cdp.eval('window.__fValue()')
  const hitB = await readHit(cdp)
  const geoB = await cdp.jeval('window.__geom()')
  check('F16 结果集 2 是它自己的状态：过滤框空、2 行全在（没被结果集 1 的词筛掉）',
    tabClick === 'ok' && valB === '' && hitB.exists === 0 && geoB.domRows === 2, { tabClick, valB, hitB, geoB })
  await typeFilter(cdp, 'A-2')
  const hitB2 = await readHit(cdp)
  await cdp.eval('window.__clickResultTab("1")')
  await sleep(600)
  const valA = await cdp.eval('window.__fValue()')
  const hitA2 = await readHit(cdp)
  check('F17 切回结果集 1：原来的词还在、命中数还是 2（状态没被另一个页签冲掉）',
    hitB2.m === 1 && valA === 'xneedle' && hitA2.m === 2 && (await firstIdOf(cdp)) === '3001',
    { hitB2, valA, hitA2 })

  // ---------- F18) 重新执行清空 ----------
  const runAgain = await runSql(cdp)
  await cdp.eval('window.__clickResultTab("1")')
  await sleep(600)
  const geoRerun = await cdp.jeval('window.__geom()')
  const toolsRerun = await readTools(cdp)
  check('F18 重新执行：过滤与输入框一起清掉，回到全量第 1 页',
    runAgain.fired && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 && geoRerun.firstId === '1' &&
    geoRerun.domRows > 5 && toolsRerun.current === 1,
    { runAgain, geoRerun, tools: toolsRerun })

  // ---------- F19) 工具行几何与双主题 ----------
  const layout = await cdp.jeval(`(() => {
    const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
    const w = window.__fWrap()
    const tr = t.getBoundingClientRect()
    const wr = w.getBoundingClientRect()
    const kids = [...t.children].filter(window.__vis).map(c => Math.round(c.getBoundingClientRect().top - tr.top))
    return JSON.stringify({
      toolsH: Math.round(tr.height),
      filterW: Math.round(wr.width),
      filterVisible: wr.width > 100 && wr.height > 12 ? 1 : 0,
      lineSpread: Math.max(...kids) - Math.min(...kids),
      kids: kids.length,
      wrap: getComputedStyle(t).flexWrap
    })
  })()`)
  check('F19 过滤框宽度可见（200px 档）、工具行仍是一行（各控件顶边差不超 8px）',
    layout.filterVisible === 1 && layout.filterW >= 180 && layout.filterW <= 220 &&
    layout.lineSpread <= 8 && layout.kids >= 4, layout)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-dark-tools-row.png')))
  await typeFilter(cdp, 'xneedle')
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-dark-filtered-hit.png')))
  await typeFilter(cdp, 'zzz-not-in-any-cell')
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-dark-filtered-empty.png')))
  await cdp.eval('window.__fClear()')
  await sleep(500)

  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('F20 存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1000)
    await typeFilter(cdp, 'note-1')
    const lightLayout = await cdp.jeval(`(() => {
      const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
      const hit = [...t.querySelectorAll('.db-sql-filter-hit')].filter(window.__vis)[0]
      const inp = window.__fInput()
      const cs = getComputedStyle(hit)
      const ci = getComputedStyle(inp)
      return JSON.stringify({
        hitColor: cs.color,
        inputColor: ci.color,
        inputBg: ci.backgroundColor,
        rowH: Math.round(t.getBoundingClientRect().height)
      })
    })()`)
    check('F21 浅色下命中提示与输入框都走 token（文字可见、行高没塌）',
      /rgb/.test(lightLayout.hitColor) && lightLayout.inputBg !== lightLayout.hitColor && lightLayout.rowH >= 24,
      lightLayout)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-light-filtered.png')))
    await cdp.eval('window.__fClear()')
    await sleep(400)
  }

  const hard = cdpRef.events.filter(l => /uncaught|error|Error|Cannot|Warning:/.test(String(l)))
  check('F22 渲染层没有新增硬错误（过滤全程无 uncaught/React 报错）',
    hard.length === 0, hard.slice(0, 6))

  return finish(results)
}

const bail = async code => {
  await restoreAll()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
