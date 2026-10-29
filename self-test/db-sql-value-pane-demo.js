#!/usr/bin/env node
/**
 * H1a-4 · SQL 结果「一整格看全」—— CDP 实机验收（桩数据，无需真 MySQL）
 *
 * 设计文档 §1A.6 承诺的效果，逐条在真实渲染层里量，看落地不看代码：
 *   A) 单击选中 → 网格下方出现一条工具条（列名 · 第 N 行 + 字符数/字节数 + 提示），
 *      **此刻网格高度不能塌**：折叠判据必须是「面板是否展开」，不是「有没有选中」。
 *      （本轮实测前抓出来的真缺陷：写成 collapsed={!sqlValuePane} 时，单击的一瞬间
 *        就切进 50/50 分区，工具条孤零零挂在半个空容器里，网格凭空矮一半。）
 *   B) 工具条点开 → 复用数据页的 DbValuePane，但 editable=false：全文在 <pre> 里、
 *      有复制、没有任何编辑入口；面板 × 是「收回工具条」不是「取消选中」。
 *   C) 分区高度记忆（localStorage electerm-db-sql-value-split）：拖完写盘，
 *      同一次挂载内展开/收回不跳回 50%，空结果重挂后仍按记忆值分配。
 *   D) 3 万字符的值：hover 预览卡只给前 4000 + 「已截断」→ 点「查看完整」→
 *      弹窗 pre 与夹具原文逐字符相等 → 复制按钮写进剪贴板的确实是全文
 *      （既拦 writeClipboard 看发出的串，也用 readClipboard 读回真实剪贴板）。
 *   E) 与 H1a-1/2/3 共存：右对齐、列宽拖拽、预览卡单例、本地化分组都不回归；
 *      虚拟化不退化（网格节点不重挂 + DOM 行数远小于本页行数 + 展开后滚动位置不丢）。
 *
 * 不验但已在单测锁住的：sqlCellInfo 取不到行时返回 null、locale 词条成对、
 * collapsed 分支的 hook 顺序。真库 MySQL 实测 = 待环境（本机无容器运行时）。
 *
 * 用法：
 *   1) npm run compile
 *      （compile 会同步 src/app → work/app；改过 src/app 时用 cmp -s 确认一次）
 *   2) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a3/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-sql-value-pane-demo.js [debugPort] [shotDir]
 *      脚本第一步就 Page.reload，所以改完 client 代码只要重跑 compile + 本脚本。
 */
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker,
  rowRe, rsRe, isCharsMeta, hexOk, clickCell
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-value-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const BIG = 30000
const PREVIEW_MAX = 4000

const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

// 桩数据要点：
// - payload 是 30000 字符的 JSON **文本**（500 行共用同一个串，不是 500 份拷贝）：
//   网格按 CSS 省略号裁、预览卡按 PREVIEW_MAX 裁、面板与弹窗给全文，三档必须在同一个值上分开
// - blob_col 走 __bin 信封：工具条 meta 必须是 bytes 而不是 chars，面板走二进制只读呈现器
// - amount 是字符串 + decimal 类型：H1a-3 的右对齐/分组判据顺带回归
// - 500 行 > 每页 200：既造出分页器（行号得是绝对下标），也让「DOM 行数 << 本页行数」可测
const FIXTURE = `
(() => {
  const HEAD = '{"rows":[{"data":"'
  const TAIL = '"}]}'
  const big = HEAD + 'x'.repeat(${BIG} - HEAD.length - TAIL.length) + TAIL
  const F = window.__fixture = {
    big,
    bin: { __bin: { size: 8, b64: 'AAECAwQFBgc=', truncated: false } }
  }
  window.__dbStubCalls = []
  window.__viewStore = {}
  window.__sqlMode = 'typed'
  window.__lastSql = null
  // 执行次数：证明"这一次真的又跑了一遍"，而不是 lastSql 恰好还是那条
  window.__execN = 0

  const COLS = [
    { name: 'id', type: 'int' },
    { name: 'payload', type: 'json' },
    { name: 'note', type: 'varchar' },
    { name: 'amount', type: 'decimal' },
    { name: 'blob_col', type: 'blob' }
  ]
  const rows = []
  for (let i = 1; i <= 500; i++) {
    rows.push({ id: i, payload: big, note: 'note-' + i, amount: '1234567.8901', blob_col: F.bin })
  }

  window.__sqlResults = () => {
    if (window.__sqlMode === 'empty') {
      // 只有受影响行、没有结果集：SQL 区必须退回"不套 DbSplitPane"的空态
      return []
    }
    if (window.__sqlMode === 'two') {
      return [
        { sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows },
        {
          sql: 'second',
          fields: ['id', 'payload'],
          columns: [{ name: 'id', type: 'varchar' }, { name: 'payload', type: 'text' }],
          rows: [{ id: 'A-1', payload: 'short' }, { id: 'A-2', payload: '2026-01-05 08:30:00' }]
        }
      ]
    }
    return [{ sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows }]
  }

  // 复制走 window.pre.writeClipboard —— 拦在这里才能证明"发出去的确实是全文"，
  // 而不是"UI 上看着像全文"。拦完仍调用原函数，真实剪贴板也一并验。
  window.__clip = []
  const origWrite = window.pre.writeClipboard
  if (typeof origWrite === 'function' && !origWrite.__h1a4) {
    const wrapped = function (s) {
      const t = String(s === null || s === undefined ? '' : s)
      window.__clip.push({
        len: t.length,
        same: t === window.__fixture.big ? 1 : 0,
        head: t.slice(0, 12),
        tail: t.slice(-12)
      })
      return origWrite.apply(window.pre, arguments)
    }
    wrapped.__h1a4 = 1
    window.pre.writeClipboard = wrapped
  }
  // 真正的桩：把 dbClientOp 全接住，页面永远碰不到 3306。
  // 上一版这里只包了 writeClipboard，剩下一个哨兵属性 —— 于是页签照旧去连本机
  // 端口，ECONNREFUSED 后所有判据退化成"没找到网格"，而哨兵检查却一路"通过"。
  // 所以 node 侧判桩在不在，看的是这次 call 有没有被接住（见 stubWorks）。
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      if (name === 'dbGridViewOp') {
        const action = a[0]
        const arg = a[1] || {}
        if (action === 'list') return Promise.resolve({ ...window.__viewStore })
        if (action === 'get') return Promise.resolve(window.__viewStore[arg.key] || null)
        if (action === 'save') {
          window.__viewStore[arg.key] = { ...(arg.view || {}), key: arg.key }
          return Promise.resolve(window.__viewStore[arg.key])
        }
        if (action === 'remove') {
          const had = !!window.__viewStore[arg.key]
          delete window.__viewStore[arg.key]
          return Promise.resolve(had)
        }
        return Promise.resolve(null)
      }
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
      const page = args.page || 1
      const ps = args.pageSize || 20
      const start = (page - 1) * ps
      return Promise.resolve({
        rows: rows.slice(start, start + ps),
        totalRows: rows.length,
        page,
        hasMore: start + ps < rows.length
      })
    }
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  // 哨兵：pre.js 里 window.pre 是"整对象赋值"，boot 期间再跑一次就把桩冲掉。
  // node 侧靠它判断桩是否还在，掉了就重装（ensureStub）
  window.pre.__h1a4 = 'stub'
  return 'stub-installed'
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

// 再点一次"执行"：doc 不动，只换桩的返回形态（__sqlMode）。
// 上一版这里去改 CodeMirror 的 doc、把语句换成一条 DELETE —— 结果是产品的写安全闸门
// confirmSqlRisk 弹窗拦下（DELETE 判成 write，非生产连接首次写要人确认），executeSql
// 压根没被调用，"分区没卸载"看着像产品缺陷。本项要验的是"空结果集怎么呈现"，
// 语句本身是什么不重要，所以用同一条 SELECT 让桩回空，闸门不参与。
// 回读执行次数与 lastSql：换形态没生效时让下一条判据带着证据红，
// 而不是让人去猜"是产品没卸载分区，还是夹具压根没跑到那条语句"
const runSqlAgain = async cdp => {
  const before = Number(await cdp.eval('window.__execN'))
  const clicked = await cdp.eval('window.__clickRunSql()')
  const fired = await waitFor(cdp, 'window.__execN > ' + before, 'executeSql #' + (before + 1), 8000)
  await sleep(700)
  return {
    before,
    after: Number(await cdp.eval('window.__execN')),
    fired,
    clicked,
    doc: await cdp.eval('window.__sqlDoc()'),
    sent: await cdp.eval('String(window.__lastSql)')
  }
}

// 桩必须在"boot 完成之后"装：pre.js 是整对象赋值 window.pre，装早了会被冲掉，
// 于是页签真的去连 127.0.0.1:3306（ECONNREFUSED），后面所有判据都变成"没找到网格"。
// 所以每次关键动作前都确认一次，掉了就重装。
// 判据不能是哨兵属性 —— 哨兵只证明"曾经挂上去过"，证明不了这一次 call 被接住。
// 真判据：拿桩才答得出的问题去问 runGlobalAsync（getMetadata 必须回 demo_db，
// 且 __dbStubCalls 里出现这次 op）。真实 IPC 要么答不出、要么答不上。
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
        return { ok: false, why: p.err || 'no-names', calls: [] }
      }
      const calls = JSON.parse(await cdp.eval('JSON.stringify(window.__dbStubCalls || [])'))
      return { ok: p.names.indexOf('demo_db') >= 0 && calls.indexOf('getMetadata') >= 0, names: p.names, calls }
    }
    await sleep(150)
  }
  return { ok: false, why: 'probe-timeout', calls: [] }
}
const stubAlive = async cdp => {
  try {
    if (!(await cdp.eval("!!(window.pre && window.pre.__h1a4 === 'stub')"))) {
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

// 全局还原：config（每页行数/本地化）、主题、localStorage 都写在真实盘上，
// 中途抛异常也不能把用户的机器留在测试态
let cdpRef = null
const cfg0 = { locale: null, pageSize: null, sqlPageSize: null, theme: null, split: null }
const restoreAll = async () => {
  if (!cdpRef) {
    return
  }
  try {
    if (cfg0.locale !== null) {
      await cdpRef.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale) + ' })')
    }
    if (cfg0.pageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ dbPageSize: ' + (Number(cfg0.pageSize) >= 10 ? Number(cfg0.pageSize) : 20) + ' })')
    }
    if (cfg0.sqlPageSize !== null && Number(cfg0.sqlPageSize) >= 10) {
      await cdpRef.eval('window.store.setConfig({ sqlResultPageSize: ' + Number(cfg0.sqlPageSize) + ' })')
    }
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    await cdpRef.eval('window.__setLs(' + JSON.stringify(cfg0.split) + ')')
    console.log('restored: ' + JSON.stringify(cfg0))
  } catch (e) {
    console.log('restore failed (check dbPageSize/theme/' + SPLIT_KEY + ' manually): ' + e.message)
  }
}

// 汇总：提前退出（夹具没到位，后面全是假红）也走同一段，保证分数与事件日志都在
let reported = false
const finish = async results => {
  if (!reported && cdpRef) {
    reported = true
    try {
      console.log('stub ops: ' + await cdpRef.eval('JSON.stringify(window.__dbStubCalls.slice(0, 6))'))
    } catch (e) { /* 页签都没了，读不到桩日志不奇怪 */ }
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

  // 载入的是不是刚编译出来的包？—— 先 reload，改完 client 代码只要 compile + 重跑本脚本
  await cdp.call('Page.reload', { ignoreCache: true })
  // reload 之后先给 boot 一点时间：waitFor 的第一次轮询可能还落在旧上下文里
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

  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  cfg0.pageSize = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  // SQL 结果网格的行数走的是独立 config（sqlResultPageSize，默认 50），
  // dbPageSize 只管数据页 —— 上一版只设 dbPageSize，于是"每页 200"其实是 10 行/页，
  // 虚拟化根本没有可滚的余量，A2 的"滚得动"判据注定红
  cfg0.sqlPageSize = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')
  const ls0 = await cdp.eval('String(window.localStorage.getItem(' + JSON.stringify(SPLIT_KEY) + '))')
  cfg0.split = ls0 === 'null' ? null : ls0

  // 词条必须真的到位：标题里出现裸 'row' 或 {n} 没替换，说明 src/app 的 locales 没同步
  const rowN = await cdp.eval("String(window.translate('dbRowN'))")
  check('词条 dbRowN 已生效且带占位符（src/app locales 同步）', /row \{n\}|第 \{n\} 行/.test(rowN), { rowN })

  // 从干净的高度开始：先清掉上一轮的分区比例，C 组自己再写
  await cdp.eval('window.localStorage.removeItem(' + JSON.stringify(SPLIT_KEY) + ')')
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: 200, sqlResultPageSize: 200 })')
  await sleep(300)

  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /demo_db|probe_db/.test(String(t.dbName))).map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) {
    await sleep(600)
  }
  // 开页签前最后一次确认：桩掉了就会真的去连 3306，报 ECONNREFUSED 而不是走桩
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
  await cdp.eval('window.__clickRunSql()')
  check('桩收到了执行请求', String(await cdp.eval('String(window.__lastSql)')).indexOf(SQL_TEXT) === 0)
  const ready = await waitFor(cdp, 'window.__rows().length > 5 && window.__colIdx("payload") >= 0', 'grid')
  const g0 = await cdp.jeval('window.__geom()')
  check('结果网格出现（单结果集，5 列 × 500 行、每页 200）',
    ready && g0.domRows > 5 && g0.firstId === '1', g0)
  check('本页确实按 200 行分页（DOM 只渲染可视区，远少于 200）',
    g0.virtual === 1 && g0.domRows < 150, { domRows: g0.domRows, virtual: g0.virtual })

  // ---------- A) 单击选中 → 折叠工具条，且网格不能塌 ----------
  check('A1 未选中时是折叠分区（bottom 空、无 resizer）',
    g0.pane === 1 && g0.collapsed === 1 && g0.resizer === 0 && g0.bar === 0 && g0.valPane === 0 && g0.selCount === 0, g0)
  // 虚拟化表体是 overflow:hidden + 自绘滚动条：native scrollTop 恒为 0，
  // 所以"高度是确定的、还滚得动"只能用 wheel 驱动后看首行 id / inner translateY 变没变
  const bp = await cdp.jeval('window.__bodyPoint()')
  await cdp.wheel(bp.x, bp.y, 600)
  const g0s = await cdp.jeval('window.__geom()')
  check('A2 折叠态网格拿到确定高度、虚拟化仍生效且真的能滚',
    g0.gridH > 200 && g0.virtual === 1 && g0.domRows > 5 && g0.domRows < 150 &&
    g0s.firstId !== g0.firstId && g0s.innerTY > 0, {
      gridH: g0.gridH,
      domRows: g0.domRows,
      virtual: g0.virtual,
      firstId: g0.firstId,
      afterFirstId: g0s.firstId,
      innerTY: g0s.innerTY
    })
  await cdp.wheel(bp.x, bp.y, -600)
  const g0t = await cdp.jeval('window.__geom()')
  check('A2b 反向滚回顶部（首行又是第 1 行，坐标可读）', g0t.firstId === '1', { firstId: g0t.firstId })
  check('A3 网格节点身份可追踪', await cdp.eval('window.__mark()') === 'marked')

  const payXY = await cdp.jeval('window.__cellXY("payload", 2)')
  await cdp.click(payXY.x, payXY.y)
  await sleep(400)
  await cdp.move(5, 5)
  await sleep(300)
  const g1 = await cdp.jeval('window.__geom()')
  const sel1 = await cdp.jeval('JSON.stringify(window.__selCells())')
  const bar1 = await cdp.jeval('window.__bar()')
  check('A4 单击出选中且只有一格被标（面板还没展开）',
    g1.selCount === 1 && g1.bar === 1 && g1.valPane === 0, g1)
  check('A5 选中格落在被点的那一格（文本对得上）',
    sel1.length === 1 && sel1[0].text.indexOf('{"rows"') === 0 && /db-cell-selected/.test(sel1[0].cls), sel1)
  check('A6 工具条标题是「列名 · 第 N 行」，行号按绝对下标',
    bar1.exists === 1 && /^payload · /.test(bar1.title) && rowRe(3).test(bar1.title), bar1)
  check('A7 工具条 meta 报字符数（30000 chars）', isCharsMeta(bar1.meta, BIG), bar1)
  check('A8 工具条提示语在位', /展开|click/i.test(bar1.hint), bar1)
  check('A9 折叠判据看的是"是否展开"：选中后网格高度不塌',
    g1.collapsed === 1 && g1.resizer === 0 && Math.abs(g1.gridH - g0.gridH) < 60, { g0h: g0.gridH, g1h: g1.gridH })
  check('A10 工具条按内容高（一条，不是半屏）', bar1.h > 8 && bar1.h < 60, { h: bar1.h })

  const noteXY = await cdp.jeval('window.__cellXY("note", 4)')
  await cdp.click(noteXY.x, noteXY.y)
  await sleep(400)
  const bar2 = await cdp.jeval('window.__bar()')
  const g2 = await cdp.jeval('window.__geom()')
  check('A11 再点别格：选中仍恰 1，标题跟着换',
    g2.selCount === 1 && /^note · /.test(bar2.title) && rowRe(5).test(bar2.title), { bar2, sel: g2.selCount })
  check('A12 短值列没有 meta（不硬凑字符数）', bar2.meta === '', bar2)

  // 分页后行号必须是绝对下标：面板指着"第 201 行"却显示第 1 行的值是假的
  check('A13 翻到第 2 页（首行 id 变成 201）',
    await cdp.eval('window.__gotoPage(2)') === 'ok' &&
    await waitFor(cdp, 'JSON.parse(window.__cellXY("id", 0)).text === "201"', 'page 2 rows'))
  const p2 = await cdp.jeval('window.__cellXY("id", 0)')
  await cdp.click(p2.x, p2.y)
  await sleep(400)
  const bar3 = await cdp.jeval('window.__bar()')
  check('A14 第 2 页首格的行号是绝对下标（第 201 行）',
    /^id · /.test(bar3.title) && rowRe(201).test(bar3.title), bar3)

  // × 取消选中：不能先展开（stopPropagation）
  const bar4 = await cdp.jeval('window.__bar()')
  await cdp.click(bar4.closeXY.x, bar4.closeXY.y)
  await sleep(400)
  const g3 = await cdp.jeval('window.__geom()')
  check('A15 工具条 × 取消选中（且没有先闪出面板）',
    g3.bar === 0 && g3.valPane === 0 && g3.selCount === 0 && g3.collapsed === 1, g3)
  await cdp.eval('window.__gotoPage(1)')
  await sleep(500)

  // ---------- B) 展开完整值面板（只读） ----------
  const pay2 = await cdp.jeval('window.__cellXY("payload", 2)')
  await cdp.click(pay2.x, pay2.y)
  await sleep(350)
  await cdp.move(5, 5)
  await sleep(250)
  const beforeExpand = await cdp.jeval('window.__geom()')
  // 先把表体滚下去：展开面板不能把滚动位置甩回顶部
  const bp2 = await cdp.jeval('window.__bodyPoint()')
  await cdp.wheel(bp2.x, bp2.y, 600)
  const scrolled = await cdp.jeval('window.__geom()')
  check('B0 表体可滚且真的滚了（首行下移、inner 上移）',
    scrolled.firstId !== beforeExpand.firstId && scrolled.innerTY > 0, {
      before: beforeExpand.firstId, after: scrolled.firstId, innerTY: scrolled.innerTY
    })

  const b5 = await cdp.jeval('window.__bar()')
  await cdp.click(b5.center.x, b5.center.y)
  await sleep(600)
  const g4 = await cdp.jeval('window.__geom()')
  check('B1 点工具条展开面板：分区切到展开态并给 resizer',
    g4.collapsed === 0 && g4.resizer === 1 && g4.valPane === 1 && g4.bar === 0, g4)
  check('B2 展开后网格仍可读、虚拟化不退化',
    g4.gridH > 120 && g4.domRows > 4 && g4.virtual === 1, { gridH: g4.gridH, domRows: g4.domRows, before: beforeExpand.domRows })
  check('B3 网格节点没被重挂（wrap 与表体探针都在）',
    await cdp.eval('window.__probeAlive()') === JSON.stringify({ wrap: 1, body: 1 }),
    await cdp.jeval('window.__probeAlive()'))
  const g4b = await cdp.jeval('window.__geom()')
  check('B4 展开面板后表体滚动位置没被甩回顶部（首行仍是滚到那一行）',
    g4b.firstId === scrolled.firstId && g4b.innerTY > 0, {
      before: scrolled.firstId, after: g4b.firstId, innerTY: g4b.innerTY
    })

  const pane1 = await cdp.jeval('window.__pane()')
  check('B5 面板正文是完整 30000 字符且与夹具逐字符相等',
    pane1.preLen === BIG && pane1.preSame === 1, { preLen: pane1.preLen, same: pane1.preSame })
  check('B6 面板标题与工具条一致', pane1.title === b5.title, { pane: pane1.title, bar: b5.title })
  check('B7 面板 meta 是 30000 chars', isCharsMeta(pane1.meta, BIG), pane1.meta)
  check('B8 只读：没有 textarea、没有编辑/保存入口',
    pane1.textarea === 0 && !pane1.btns.some(b => /编辑|保存|edit|save/i.test(b.t + ' ' + b.title)), pane1.btns)
  check('B9 只读面板仍有复制，且关闭 × 只有一个',
    pane1.btns.filter(b => /复制|copy/i.test(b.t + ' ' + b.title)).length >= 1 &&
    pane1.btns.filter(b => /关闭|close/i.test(b.t + ' ' + b.title)).length === 1, pane1.btns)

  const closeBtn = pane1.btns.find(b => /关闭|close/i.test(b.t + ' ' + b.title))
  await cdp.click(closeBtn.x, closeBtn.y)
  await sleep(500)
  // 选中行可能已被虚拟滚动回收（不在 DOM 里就没有 .db-cell-selected 节点），
  // 先把表体滚回顶部再验高亮，否则"没亮"是回收的假象不是缺陷
  const bp3 = await cdp.jeval('window.__bodyPoint()')
  await cdp.wheel(bp3.x, bp3.y, -1200)
  const g5 = await cdp.jeval('window.__geom()')
  const b6 = await cdp.jeval('window.__bar()')
  check('B10 面板 × 收回工具条，选中格与标题都留着',
    g5.collapsed === 1 && g5.valPane === 0 && g5.bar === 1 && g5.selCount === 1 && b6.title === b5.title,
    { g5, bar: b6.title, firstId: g5.firstId })

  await cdp.click(b6.center.x, b6.center.y)
  await sleep(500)
  const g6 = await cdp.jeval('window.__geom()')
  check('B11 收回后能再展开', g6.valPane === 1 && g6.collapsed === 0, g6)

  // ---------- C) 分区高度记忆 ----------
  const rz = await cdp.jeval('window.__resizerXY()')
  check('C0 resizer 在面板上沿、可命中', rz.found === 1, rz)
  await cdp.dragY(rz.x, rz.y, -160)
  await sleep(500)
  const lsVal = await cdp.eval('window.__ls()')
  const pct = Number(lsVal)
  check('C1 拖拽把比例写进 localStorage（clamp 在 15~85）', pct >= 15 && pct <= 85, { lsVal })
  const g7 = await cdp.jeval('window.__geom()')
  check('C2 渲染比例与存的一致（±3 个百分点）',
    Math.abs(g7.topH / (g7.topH + g7.bottomH) * 100 - pct) <= 3, { pct, topH: g7.topH, bottomH: g7.bottomH })
  const p7 = await cdp.jeval('window.__pane()')
  check('C3 拖矮之后面板仍装着全文（高度变化不影响内容）', p7.preSame === 1, { preLen: p7.preLen })

  // 换选中格：先在展开态点二进制列，看高度不被重置、meta 换成字节数
  const blobClick = await clickCell(cdp, 'blob_col', 1)
  check('C3b 二进制格可点（夹具到位：拿得到那一格的坐标）', blobClick.ok, blobClick)
  const g9 = await cdp.jeval('window.__geom()')
  check('C4 换选中格不重置已拖好的高度',
    g9.pane === 1 && Math.abs(g9.topH / (g9.topH + g9.bottomH) * 100 - pct) <= 3,
    { pct, topH: g9.topH, bottomH: g9.bottomH, pane: g9.pane, bar: g9.bar, valPane: g9.valPane, dump: blobClick.dump, events: cdp.tail() })

  const p8 = await cdp.jeval('window.__pane()')
  check('C5 二进制列 meta 报字节数（8 bytes，不是 chars）',
    /bytes/.test(p8.meta) && /8/.test(p8.meta), { meta: p8.meta, g9 })
  check('C6 二进制列面板走只读呈现器，不是 30000 字符正文',
    p8.preLen !== BIG && rowRe(2).test(p8.title) && p8.textarea === 0, { preLen: p8.preLen, title: p8.title })

  // 工具条在展开态是不渲染的（分区折叠才显示），所以先收起来再读它的 meta：
  // 上一版直接在展开态读 .db-sql-value-bar，读到 exists:0，红的是夹具不是产品
  const paneClose = p8.btns.find(b => /关闭|close/i.test(b.t + ' ' + b.title))
  check('C5b 面板关闭按钮在位', !!paneClose, p8.btns)
  if (paneClose) {
    await cdp.click(paneClose.x, paneClose.y)
    await sleep(500)
  }
  const b7 = await cdp.jeval('window.__bar()')
  check('C5c 折叠后工具条同一口径报字节数',
    b7.exists === 1 && /bytes/.test(b7.meta) && /8/.test(b7.meta) && rowRe(2).test(b7.title),
    { b7, events: cdp.tail() })

  // 真正的写语句会被 confirmSqlRisk 弹窗拦下（那是产品该有的安全带）；
  // 验收要用桩的形态切换来造场景，doc 始终留同一条 SELECT
  await cdp.eval('window.__sqlMode = "empty"')
  const run1 = await runSqlAgain(cdp)
  const g10 = await cdp.jeval('window.__geom()')
  check('C7a 空结果那一轮执行真的发出去了（执行次数 +1）',
    run1.fired && run1.after === run1.before + 1 && run1.clicked === 'ok', run1)
  check('C7 空结果不套分区（回到无 DbSplitPane 的空态）',
    g10.pane === 0 && g10.bar === 0 && g10.valPane === 0, { g10, run1, dump: await cdp.jeval('window.__dump()') })
  await cdp.eval('window.__sqlMode = "typed"')
  const run2 = await runSqlAgain(cdp)
  const rerun = await waitFor(cdp, 'window.__rows().length > 5', 'grid rerun')
  check('C8a 回到有结果那一轮也真的执行了（执行次数 +1）',
    run2.fired && run2.after === run2.before + 1 && run2.clicked === 'ok', run2)
  const g11 = await cdp.jeval('window.__geom()')
  check('C8 重挂后回到折叠空态，且没有残留选中',
    rerun && g11.collapsed === 1 && g11.bar === 0 && g11.selCount === 0,
    { rerun, g11, run2, dump: await cdp.jeval('window.__dump()') })
  const payClick = await clickCell(cdp, 'payload', 0)
  check('C8b 重挂后那一格仍可点', payClick.ok, payClick)
  const b8 = await cdp.jeval('window.__bar()')
  check('C8c 重挂后单击出工具条（可点开展开）', b8.exists === 1, b8)
  if (b8.exists === 1) {
    await cdp.click(b8.center.x, b8.center.y)
    await sleep(600)
  }
  const g12 = await cdp.jeval('window.__geom()')
  check('C9 新挂载按 localStorage 记忆分配高度（不再跳回 50%）',
    Math.abs(g12.topH / (g12.topH + g12.bottomH) * 100 - pct) <= 3, { pct, topH: g12.topH, bottomH: g12.bottomH })

  // ---------- D) 3 万字符：预览卡截断 → 查看完整 → 复制全文 ----------
  // D 组要悬停第 6 行的 payload，前提是网格重新变高（C9 把面板展开了，
  // 网格只渲染得出 5 行，第 6 行压根不在 DOM 里）+ 表体滚回顶部。
  // 这两步是夹具，不做到判据里，D0 就只能红着报"没这一行"。
  const p9 = await cdp.jeval('window.__pane()')
  const paneClose9 = p9.btns && p9.btns.find(b => /关闭|close/i.test(b.t + ' ' + b.title))
  if (paneClose9) {
    await cdp.click(paneClose9.x, paneClose9.y)
    await sleep(500)
  }
  const bp4 = await cdp.jeval('window.__bodyPoint()')
  await cdp.wheel(bp4.x, bp4.y, -2000)
  await sleep(400)
  const n1 = await cdp.jeval('window.__cellXY("note", 1)')
  const payXY2 = await cdp.jeval('window.__cellXY("payload", 5)')
  check('D0 预览夹具到位（note 与 payload 两格都在 DOM 里）',
    !n1.error && !payXY2.error, { n1: n1.error || 'ok', pay: payXY2.error || 'ok', dump: await cdp.jeval('window.__dump()') })
  if (n1.error || payXY2.error) {
    return finish(results)
  }
  await cdp.click(n1.x, n1.y)
  await sleep(300)
  await cdp.move(payXY2.x, payXY2.y)
  await sleep(800)
  const card1 = await cdp.jeval('window.__card()')
  check('D1 悬停截断格出预览卡，且只给前 4000 字符 + 已截断标记',
    card1.open === 1 && card1.len === PREVIEW_MAX && card1.more === 1, card1)
  check('D2 预览卡带「查看完整」按钮', !!card1.full && /查看完整|view full/i.test(card1.full.text), card1.full)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-dark-preview-card.png')))
  if (!card1.full) {
    check('D2b 没有「查看完整」按钮，后续 D 组无法继续', false, { card: card1, events: cdp.tail() })
    return finish(results)
  }
  await cdp.click(card1.full.x, card1.full.y)
  await sleep(700)
  const card2 = await cdp.jeval('window.__card()')
  const modal1 = await cdp.jeval('window.__modal()')
  check('D3 弹窗打开时预览卡已让位（浮层不叠在弹窗上）',
    modal1.open === 1 && card2.open === 0, { modal: modal1.open, card: card2.open })
  check('D4 弹窗正文完整 30000 字符且与夹具原文逐字符相等',
    modal1.len === BIG && modal1.same === 1, { len: modal1.len, same: modal1.same, head: modal1.head, tail: modal1.tail })
  check('D5 弹窗标题带列名、头部标注字符数',
    /payload/.test(modal1.title) && isCharsMeta(modal1.meta, BIG), { title: modal1.title, meta: modal1.meta })
  check('D6 弹窗正文等宽 + 可选中 + 换行（长 JSON 要能整段读）',
    modal1.mono === true && modal1.selectable === true && /pre-wrap/.test(modal1.wrap),
    { mono: modal1.mono, selectable: modal1.selectable, wrap: modal1.wrap })
  const copyBtn = modal1.btns.find(b => /复制|copy/i.test(b.k + ' ' + b.title))
  check('D7 弹窗有复制按钮', !!copyBtn, modal1.btns)
  if (!copyBtn) {
    return finish(results)
  }
  await cdp.click(copyBtn.x, copyBtn.y)
  await sleep(500)
  const clip = JSON.parse(await cdp.eval('window.__clipLog()'))
  const last = clip[clip.length - 1] || {}
  check('D8 复制发出去的确实是全文（writeClipboard 收到 30000 字符且等值）',
    last.len === BIG && last.same === 1, clip.slice(-2))
  const real = await cdp.jeval('window.__readClip()')
  check('D9 真实剪贴板里就是全文（readClipboard 读回 30000 且等值）',
    real.ok === 1 && real.len === BIG && real.same === 1, real)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-dark-full-text-modal.png')))
  await cdp.eval("(() => { const b=document.querySelector('.ant-modal'); const x=b&&b.querySelector('.ant-modal-close'); if (x) x.click() })()")
  await sleep(500)
  check('D10 弹窗可关闭且不留残层', (await cdp.jeval('window.__modal()')).open === 0)

  // ---------- E) 与 H1a-1/2/3 共存 ----------
  const idMeta = await cdp.jeval('window.__colMeta("id")')
  const payMeta = await cdp.jeval('window.__colMeta("payload")')
  check('E1 数值列右对齐、长文本列不右对齐（H1a-3 未回归）',
    idMeta.align.every(a => a === 'right') && /db-cell-num/.test(idMeta.cls[0]) &&
    payMeta.align.every(a => a !== 'right') && !/db-cell-num/.test(payMeta.cls[0]),
    { id: idMeta.align, pay: payMeta.align })
  const w0 = await cdp.eval('window.__colWidth("payload")')
  const h0 = await cdp.jeval('window.__handleXY("payload")')
  check('E2 列宽拖拽句柄仍在表头（H1a-2 未回归）', h0.found === 1, h0)
  await cdp.dragX(h0.x, h0.y, 120)
  await sleep(500)
  const w1 = await cdp.eval('window.__colWidth("payload")')
  check('E3 拖宽仍生效', Number(w1) > Number(w0) + 40, { w0, w1 })

  for (const col of ['note', 'amount', 'payload']) {
    const xy = await cdp.jeval('window.__cellXY(' + JSON.stringify(col) + ', 3)')
    await cdp.move(xy.x, xy.y)
    await sleep(500)
  }
  const cardN = await cdp.jeval('window.__card()')
  check('E4 预览卡是单例（连悬三格后 DOM 里仍只有一张）', cardN.cards === 1, cardN)
  await cdp.move(5, 5)
  await sleep(400)

  // 本地化开关：分组判据按数字序列比，分隔符随区域设置
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "os" })')
  await sleep(600)
  const amt = await cdp.jeval('window.__colMeta("amount")')
  const shown = String((amt.texts || [])[0] || '')
  check('E5 本地化开启后 SQL 结果分组仍生效（数字序列不丢、多了分隔符）',
    shown.replace(/\D/g, '') === '12345678901' && /\d\D+\d/.test(shown), { shown })
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none" })')
  await sleep(400)

  // 多结果集：标题要带上是第几个结果集（页签在上、面板在下，只写列名会对不上号）
  await cdp.eval('window.__sqlMode = "two"')
  await runSqlAgain(cdp)
  const tabs = JSON.parse(await cdp.eval('window.__resultTabs()'))
  check('E6 双结果集页签渲染正常（切页后网格仍可读）',
    tabs.length === 2 && await waitFor(cdp, 'window.__rows().length > 5', 'two-set grid'), tabs)
  await cdp.eval('window.__clickResultTab("2|2")')
  await sleep(500)
  const xy2 = await cdp.jeval('window.__cellXY("id", 0)')
  if (xy2.error) {
    check('E7 多结果集的工具条标题带集号', false, xy2)
  } else {
    await cdp.click(xy2.x, xy2.y)
    await sleep(400)
    const barT = await cdp.jeval('window.__bar()')
    check('E7 多结果集的工具条标题带集号（第 2 个结果集 · id · 第 1 行）',
      rsRe(2).test(barT.title) && /^.* · id · /.test(barT.title) && rowRe(1).test(barT.title), barT)
  }
  await cdp.eval('window.__clickResultTab("1|1")')
  await sleep(400)
  await cdp.eval('window.__sqlMode = "typed"')

  // 重新执行 → 选中态必须清空（面板指着上一次执行的那一格是假的）。
  // 先回到结果集 1 的页签上**重新点一格**：E7 选中的是那另一结果集里的一格，
  // 切回 1 之后高亮本来就不在 DOM 上，拿那个 0 当"重跑前应该有的 1"是自欺
  const reselect = await clickCell(cdp, 'payload', 0)
  const beforeRerun = await cdp.jeval('window.__geom()')
  const run3 = await runSqlAgain(cdp)
  const reran = await waitFor(cdp, 'window.__rows().length > 5', 'rerun grid')
  const afterRerun = await cdp.jeval('window.__geom()')
  check('E8 重新执行后选中/面板一起清空（不留指向空气的标题）',
    reselect.ok && beforeRerun.selCount === 1 && reran &&
    afterRerun.selCount === 0 && afterRerun.bar === 0 && afterRerun.valPane === 0 &&
    afterRerun.pane === 1 && afterRerun.collapsed === 1,
    { reselect, before: beforeRerun, run3, reran, after: afterRerun, dump: await cdp.jeval('window.__dump()') })

  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-dark-collapsed-bar.png')))
  const pay3 = await cdp.jeval('window.__cellXY("payload", 0)')
  await cdp.click(pay3.x, pay3.y)
  await sleep(300)
  await cdp.move(5, 5)
  const b9 = await cdp.jeval('window.__bar()')
  await cdp.click(b9.center.x, b9.center.y)
  await sleep(600)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-dark-value-pane.png')))
  const geoFinal = await cdp.jeval('window.__geom()')
  check('E9 深色终态：面板展开、全文在位',
    geoFinal.valPane === 1 && geoFinal.collapsed === 0 && (await cdp.jeval('window.__pane()')).preSame === 1, geoFinal)

  // ---------- F) 浅色主题复查（工具条/选中态/面板配色全走 token） ----------
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('F0 存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1000)
    const light = await cdp.jeval(`
      (() => {
        const sel = window.__selCells()[0] || null
        const bar = window.__one('.db-value-pane')
        const pre = bar && bar.querySelector('.db-value-pre')
        const cs = el => el ? getComputedStyle(el) : null
        const b = cs(bar), p = cs(pre)
        return JSON.stringify({
          hasSel: !!sel,
          selShadow: sel ? sel.shadow : '',
          paneBg: b ? b.backgroundColor : '',
          preFg: p ? p.color : '',
          preBg: p ? p.backgroundColor : '',
          font: p ? p.fontFamily : ''
        })
      })()
    `)
    check('F1 浅色下选中格有可见描边（inset box-shadow 用主色）',
      light.hasSel === true && /rgb|inset/.test(String(light.selShadow)), light)
    check('F2 浅色下面板正文有对比且仍等宽',
      hexOk(light.preFg, light.preBg) && /mono|Consolas|Menlo/i.test(String(light.font)), light)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-light-value-pane.png')))
    await cdp.move(5, 5)
    await sleep(300)
    // 展开态重跑：选中被清掉，展开偏好按设计保留 —— 但那一半屏不能空着压网格。
    // 这一条是实测抓出来的真缺陷（重跑后 top 186px / bottom 503px 空白、网格只剩 5 行）
    const preRerunGeo = await cdp.jeval('window.__geom()')
    const runL = await runSqlAgain(cdp)
    const postRerunGeo = await cdp.jeval('window.__geom()')
    check('F2b 展开态重跑不留半屏空气（分区收回、网格重新占满）',
      preRerunGeo.valPane === 1 && preRerunGeo.collapsed === 0 && runL.fired &&
      postRerunGeo.valPane === 0 && postRerunGeo.bar === 0 && postRerunGeo.selCount === 0 &&
      postRerunGeo.collapsed === 1 && postRerunGeo.pane === 1 && postRerunGeo.bottomH === 0 &&
      postRerunGeo.gridH > 300 && postRerunGeo.domRows > 5,
      { pre: preRerunGeo, run: runL, post: postRerunGeo, dump: await cdp.jeval('window.__dump()') })
    await waitFor(cdp, 'window.__rows().length > 5', 'light rerun')
    const payXY3 = await cdp.jeval('window.__cellXY("payload", 1)')
    await cdp.move(payXY3.x, payXY3.y)
    await sleep(800)
    const c = await cdp.jeval('window.__card()')
    check('F3 浅色下截断格仍出预览卡（前 4000 + 已截断）',
      c.open === 1 && c.len === PREVIEW_MAX && c.more === 1, c)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '6-light-preview-card.png')))
    if (c.full) {
      await cdp.click(c.full.x, c.full.y)
      await sleep(700)
      const m = await cdp.jeval('window.__modal()')
      check('F4 浅色下全文弹窗仍是完整 30000 字符', m.open === 1 && m.len === BIG && m.same === 1, { open: m.open, len: m.len })
      console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '7-light-full-text-modal.png')))
      await cdp.eval("(() => { const b=document.querySelector('.ant-modal'); const x=b&&b.querySelector('.ant-modal-close'); if (x) x.click() })()")
      await sleep(400)
    }
  }

  return finish(results)
}

// 任何退出路径（跑完 / 中途抛）都先还原真实配置，再退进程
const bail = async code => {
  await restoreAll()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
