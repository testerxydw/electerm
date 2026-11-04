#!/usr/bin/env node
/**
 * S2-1 · AI Agent 数据库只读工具集 —— CDP 实机验收（桩库 + 桩模型，无需真库与真 AI 服务）
 *
 * 这一批交付的是 agent 的五个 db_* 工具，判据分三层：
 *   A) 发给模型的 schema 里真的有这五个名字，且一个执行/写库的工具都没有；
 *   B) store 层五个方法在真实会话页上取到的东西是对的：当前库表来自会话页而不是书签、
 *      视图与基表分开、结果集里 NULL 与空串不混、超长单元格如实截断、
 *      多个数据库页签（含 redis）时报错要求显式给 tabId 而不是瞎猜；
 *   C) 走完整 agent 循环：模型发来 tool_calls → executeToolCall → 工具结果回流给模型，
 *      db_insert_sql 真的把 SQL 落进 CodeMirror（且没吃掉用户手写的那句）。
 *   D) 全程 executeSql 只发生"人按运行"的那一次：五个工具一次都没执行 SQL。
 *
 * 用法（与 self-test/db-sql-ai-demo.js 同一套）：
 *   1) npm run vite-build
 *   2) D=$(mktemp -d /tmp/electerm-bg-XXXX) && mkdir -p $D/home $D/config $D/data && \
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/agent-db-tools-demo.js 9333
 *
 * 改过产品代码要重新 vite-build 再跑：渲染层是构建产物，脚本只负责关缓存刷页。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'agent-db-tools-shots')

const MYSQL_TAB = {
  type: 'database',
  from: 'quick-connect',
  title: 'mysql demo_db',
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'demo',
  dbPassword: '',
  dbName: 'demo_db',
  dbSsl: false,
  readOnly: false,
  // 生产标记：db_get_context 必须把它透给模型，否则 agent 会拿生产库当练习场
  production: true,
  batch: null
}

const REDIS_TAB = {
  type: 'database',
  from: 'quick-connect',
  title: 'redis cache',
  dbType: 'redis',
  dbHost: '127.0.0.1',
  dbPort: 6379,
  dbUser: '',
  dbName: '',
  batch: null
}

const LONG_TEXT = 'L'.repeat(500)

// 桩：dbClientOp 只回答这次要用的几个 op；AIchatWithTools 按脚本发 tool_calls。
// 关键计数：__execSeq（executeSql 发生次数）——判据 D 全靠它。
const FIXTURE = `
(() => {
  if (window.pre.__agentDbStub === 'stub') return 'already'
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  const rows = [
    { id: 1, note: '${LONG_TEXT.slice(0, 20)}…(long)', tag: null, note2: '' },
    { id: 2, note: 'short', tag: 'ok', note2: '' },
    { id: 3, note: 'third', tag: null, note2: 'x' }
  ]
  rows[0].note = window.__LONG = '${LONG_TEXT}'
  window.__execSeq = 0
  window.__aiSeq = 0
  window.__aiReq = []
  window.__dbOps = []
  // 脚本：第一轮发这五个 tool_calls，第二轮收尾成纯文本
  window.__toolScript = []
  window.__cols = [
    { name: 'id', dataType: 'int', columnType: 'int(11)', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'note', dataType: 'varchar', columnType: 'varchar(64)', nullable: true, defaultValue: null, comment: '备注', ordinal: 2 },
    { name: 'tag', dataType: 'varchar', columnType: 'varchar(16)', nullable: true, ordinal: 3 },
    { name: 'note2', dataType: 'text', columnType: 'text', nullable: true, ordinal: 4 }
  ]

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'AIchatWithTools') {
      window.__aiSeq = window.__aiSeq + 1
      const msgs = Array.isArray(a[0]) ? a[0] : []
      window.__aiReq.push({
        n: window.__aiSeq,
        // 位次：0 messages / 1 model / 2 baseURL / 3 apiPath / 4 apiKey / 5 proxy / 6 tools
        tools: (a[6] || []).map(t => (t && t.function && t.function.name) || ''),
        roles: msgs.map(m => m.role),
        toolContents: msgs.filter(m => m.role === 'tool').map(m => String(m.content || '')),
        system: String((msgs[0] && msgs[0].content) || '')
      })
      const step = (window.__toolScript || []).shift()
      if (step && step.calls) {
        return Promise.resolve({
          message: {
            role: 'assistant',
            content: step.content || '',
            tool_calls: step.calls.map((c, i) => ({
              id: 'call-' + window.__aiSeq + '-' + i,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
            }))
          }
        })
      }
      return Promise.resolve({ message: { role: 'assistant', content: 'done: 只读看完，SQL 已放进编辑器，请你按运行。' } })
    }
    if (name === 'AIchat' || name === 'getStreamContent') {
      return Promise.resolve(name === 'AIchat' ? { isStream: true, sessionId: 'stub' } : { content: '', hasMore: false })
    }
    if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
      return Promise.resolve({ ok: true })
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(null)
    }
    if (name !== 'dbClientOp') {
      return orig(name, ...a)
    }
    const op = a[1]
    const args = a[2] || {}
    window.__dbOps.push(op)
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [
          { name: 'typed_tbl', type: 'table' },
          { name: 'order_tbl', type: 'table' },
          { name: 'v_active', type: 'view' }
        ]
      }, { name: 'other_db', type: 'database', children: [{ name: 'zeta', type: 'table' }] }])
    }
    if (op === 'executeSql') {
      window.__execSeq = window.__execSeq + 1
      return Promise.resolve({
        results: [{
          fields: ['id', 'note', 'tag', 'note2'],
          columns: window.__cols.map(c => ({ name: c.name, type: c.dataType })),
          rows
        }],
        elapsedMs: 42
      })
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        type: 'table',
        comment: '下单用户',
        estimatedRows: 1234,
        columns: window.__cols,
        indexes: [{ name: 'PRIMARY', unique: true, primary: true, columns: ['id'], method: 'BTREE' }],
        foreignKeys: [{
          name: 'fk_addr', columns: ['addr_id'], refSchema: 'demo_db', refTable: 'address',
          refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION'
        }]
      })
    }
    if (op === 'getPageData') {
      return Promise.resolve({ rows, hasMore: true, totalRows: 98000 })
    }
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve({ tables: [] })
    if (op === 'getReferences') return Promise.resolve({ references: [] })
    if (op === 'describeTable') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__agentDbStub = 'stub'
  return 'stub-installed'
})()
`

// 探针：store 方法调用统一走 __call（异常要能读回消息而不是把 eval 炸掉）
const PROBE = `
(() => {
  const vis = el => !!el && !!el.offsetParent
  window.__call = async (fn, arg) => {
    try {
      return JSON.stringify({ ok: true, value: await window.store[fn](arg || {}) })
    } catch (err) {
      return JSON.stringify({ ok: false, error: String((err && err.message) || err) })
    }
  }
  window.__execN = () => Number(window.__execSeq || 0)
  window.__ops = () => JSON.stringify(window.__dbOps || [])
  window.__aiN = () => Number(window.__aiSeq || 0)
  window.__req = i => JSON.stringify((window.__aiReq || [])[i] || {})
  window.__doc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(vis)[0]
    return ed ? String(ed.innerText || '') : 'no-editor'
  }
  window.__edXY = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(vis)[0]
    if (!ed) return 'no-editor'
    const r = ed.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + 20) })
  }
  window.__edFocused = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].filter(vis)[0]
    return !!(ed && document.activeElement === ed)
  }
  window.__dbTabs = () => JSON.stringify((window.store.tabs || [])
    .filter(t => t.type === 'database').map(t => String(t.id)))
  window.__toolCards = () => {
    const h = (window.store.aiChatHistory || []).slice(-1)[0] || {}
    return JSON.stringify((h.toolCalls || []).map(c => ({ name: c.name, status: c.status, result: String(c.result || '').slice(0, 240) })))
  }
  window.__script = calls => {
    window.__toolScript = calls
    return calls.length
  }
  window.__submit = text => {
    const c = window.refsStatic.get('AIChat')
    if (!c || typeof c.handleSubmit !== 'function') return 'no-ai-chat-ref'
    c.handleSubmit(String(text))
    return 'ok'
  }
  window.__panelState = () => JSON.stringify({ tab: String(window.store.rightPanelTab), vis: !!window.store.rightPanelVisible })
  window.__openPanel = () => {
    if (!(window.store.rightPanelTab === 'ai' && window.store.rightPanelVisible)) window.store.toggleAIPanel()
    return window.__panelState()
  }
  window.__closePanel = () => {
    if (window.store.rightPanelTab === 'ai' && window.store.rightPanelVisible) window.store.toggleAIPanel()
    return window.__panelState()
  }
  window.__reset = mode => {
    localStorage.setItem('ai-chat-mode', mode)
    window.store.aiChatHistory = []
    window.store.agentRunning = false
    return mode
  }
  return 'probe-installed'
})()
`

const { results, check: ck } = makeChecker()

const focusEditor = async (cdp) => {
  let ok = false
  for (let i = 0; i < 3 && ok !== true; i++) {
    if (i) await sleep(300)
    const raw = await cdp.eval('window.__edXY()')
    if (String(raw).charAt(0) !== '{') continue
    const p = JSON.parse(raw)
    await cdp.click(p.x, p.y)
    await sleep(200)
    ok = await cdp.eval('window.__edFocused()')
  }
  return ok
}

const selectAllEditor = async (cdp) => {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
  await sleep(150)
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target; start the app with --remote-debugging-port')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Network.enable')
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)

  ck('渲染进程可用（store / pre / translate 都在）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

  // 桩要在 boot 之后装：pre.js 整对象赋值 window.pre，装早了会被冲掉，
  // 于是页签真去连 127.0.0.1:3306，判据全退化成"找不到编辑器"
  let installed = false
  for (let i = 0; i < 10 && !installed; i++) {
    await cdp.eval(FIXTURE)
    await sleep(250)
    installed = !!(await cdp.eval('!!(window.pre && window.pre.__agentDbStub === "stub")'))
  }
  ck('桩装上（dbClientOp / AIchatWithTools 全由桩应答，其它方法名交回真 pre）', installed)

  await cdp.eval(buildHelpers('electerm-agent-db-tools'))
  await cdp.eval(PROBE)
  await sleep(200)
  ck('探针装上（__call / __doc / __toolCards 三类都探得到）',
    await cdp.eval('!!(window.__call && window.__doc && window.__toolCards)'))

  await cdp.eval('window.store.setConfig({ modelAI: "stub-model", baseURLAI: "http://127.0.0.1:9/v1", apiKeyAI: "stub-key", languageAI: "English" })')
  await sleep(300)

  const stale = JSON.parse(await cdp.eval('window.__dbTabs()'))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab("' + id + '") })()')
  }
  if (stale.length) await sleep(500)

  // ---------- 没有数据库页签时的报错要可行动 ----------
  const none = JSON.parse(await cdp.eval('window.__call("mcpDbGetContext", {})'))
  ck('一个数据库页签都没开时报错说清下一步（而不是抛空列表）',
    none.ok === false && /No database tab is open/.test(none.error), none)
  // ---------- 开库、选表、进 SQL 页 ----------
  await cdp.eval(`(() => {
    window.store.addTab(${JSON.stringify(MYSQL_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return String(t.id)
  })()`)
  const dbTabId = JSON.parse(await cdp.eval('window.__dbTabs()'))[0]
  ck('数据库页签打开（树渲染出来，桩真的接住 dbClientOp）',
    await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree', 30000) &&
    (await cdp.eval('window.__clickTree("demo_db")')) === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node', 15000))
  const chunks = JSON.parse(await cdp.eval(
    "JSON.stringify(performance.getEntriesByType('resource').map(r => r.name).filter(n => n.indexOf('db-session-') >= 0).map(n => n.split('/').pop()))"
  ))
  ck('加载的 db-session chunk 在磁盘上（测的是本次构建，不是缓存副本）',
    chunks.length > 0 && chunks.every(n => fs.existsSync(path.join(__dirname, '..', 'work', 'app', 'assets', 'chunk', n))),
    chunks)
  const clickedTable = await cdp.eval('window.__clickTree("typed_tbl")')
  await sleep(700)
  const clickedSqlTab = await cdp.eval('window.__clickTab("^SQL$")')
  ck('选中 typed_tbl 并打开 SQL 页（编辑器挂载，句柄就绪）',
    clickedTable === 'ok' && clickedSqlTab === 'ok' &&
    await waitFor(cdp, '!![...document.querySelectorAll(".db-sql-area .cm-content")].find(window.__vis)', 'editor', 15000),
    { clickedTable, clickedSqlTab })

  // ---------- B1：db_get_context 取的是会话页的实时上下文 ----------
  const ctx = JSON.parse(await cdp.eval('window.__call("mcpDbGetContext", {})'))
  ck('db_get_context：库/表来自会话页选择，生产标记与只读都透出',
    ctx.ok === true && ctx.value.tabId === dbTabId && ctx.value.dbType === 'mysql' &&
    ctx.value.database === 'demo_db' && ctx.value.table === 'typed_tbl' &&
    ctx.value.production === true && ctx.value.readOnly === false &&
    ctx.value.supportsSql === true && ctx.value.hasSqlEditor === true, ctx)

  const ctxOther = JSON.parse(await cdp.eval('window.__call("mcpDbGetContext", { tabId: "nope" })'))
  ck('显式 tabId 认不到就点名报错', ctxOther.ok === false && /Database tab not found: nope/.test(ctxOther.error), ctxOther)

  // ---------- B2：表清单 ----------
  const tables = JSON.parse(await cdp.eval('window.__call("mcpDbListTables", {})'))
  ck('db_list_tables：视图与基表都收，且如实标出总数',
    tables.ok === true && tables.value.totalTables === 3 &&
    tables.value.tables.map(t => t.name + ':' + t.kind).join(',') === 'order_tbl:table,typed_tbl:table,v_active:view' &&
    tables.value.truncated === false, tables)
  const tablesLimited = JSON.parse(await cdp.eval('window.__call("mcpDbListTables", { limit: 2 })'))
  ck('limit 截断如实标注，不静默丢表',
    tablesLimited.ok === true && tablesLimited.value.tables.length === 2 &&
    tablesLimited.value.truncated === true && tablesLimited.value.totalTables === 3, tablesLimited)
  const tablesMissing = JSON.parse(await cdp.eval('window.__call("mcpDbListTables", { database: "nope_db" })'))
  ck('指定的库看不见时报错并列出可见的库',
    tablesMissing.ok === false && /not visible on this connection/.test(tablesMissing.error) &&
    /demo_db, other_db/.test(tablesMissing.error), tablesMissing)

  // ---------- B3：表结构 ----------
  const desc = JSON.parse(await cdp.eval('window.__call("mcpDbDescribeTable", { table: "typed_tbl" })'))
  ck('db_describe_table：列（类型取带长度的 columnType）/索引/外键都到位',
    desc.ok === true && desc.value.table === 'typed_tbl' && desc.value.database === 'demo_db' &&
    desc.value.columns[1].type === 'varchar(64)' && desc.value.columns[1].comment === '备注' &&
    desc.value.columns[0].primaryKey === true && desc.value.estimatedRows === 1234 &&
    desc.value.indexes[0].name === 'PRIMARY' &&
    desc.value.foreignKeys[0].references === 'demo_db.address(id)', desc)
  const descNoName = JSON.parse(await cdp.eval('window.__call("mcpDbDescribeTable", {})'))
  ck('缺 table 参数时报错指向 db_list_tables', descNoName.ok === false && /table is required/.test(descNoName.error), descNoName)

  // ---------- B4：人跑一条 SQL，然后读屏幕上的结果集 ----------
  const execBeforeRun = Number(await cdp.eval('window.__execN()'))
  const focused = await focusEditor(cdp)
  await selectAllEditor(cdp)
  await cdp.call('Input.insertText', { text: 'SELECT id, note, tag, note2 FROM typed_tbl' })
  await sleep(250)
  const clickedRun = await cdp.eval('window.__clickRunSql()')
  const ranOnce = await waitFor(cdp, 'window.__execN() === ' + (execBeforeRun + 1), 'executeSql', 15000)
  ck('把 SELECT 写进编辑器并真的由"人"执行一次',
    focused === true && clickedRun === 'ok' && ranOnce === true,
    { focused, clickedRun, before: execBeforeRun, now: Number(await cdp.eval('window.__execN()')) })
  const execAfterRun = Number(await cdp.eval('window.__execN()'))

  const readAll = JSON.parse(await cdp.eval('window.__call("mcpDbReadResult", {})'))
  ck('db_read_result：读到人刚跑的结果集，列名取结果集自己的，耗时回传',
    readAll.ok === true && readAll.value.source === 'sql-result' &&
    readAll.value.totalRows === 3 &&
    readAll.value.columns.join(',') === 'id,note,tag,note2' &&
    readAll.value.elapsedMs === 42 && readAll.value.returnedRows === 3, readAll)
  ck('NULL 与空串在工具返回里仍是两件事（模型才不会被引去写 IS NOT NULL 的错觉）',
    readAll.value.rows[0].tag === null && readAll.value.rows[1].tag === 'ok' &&
    readAll.value.rows[0].note2 === '', readAll.value.rows)
  ck('超长单元格截断并计数（500 字只回 200 字 + 省略号）',
    readAll.value.rows[0].note.length === 201 && readAll.value.truncatedCells === 1,
    { len: readAll.value.rows[0].note.length, n: readAll.value.truncatedCells })
  const readPage = JSON.parse(await cdp.eval('window.__call("mcpDbReadResult", { limit: 2, offset: 1 })'))
  ck('offset/limit 生效且如实标 hasMoreRows',
    readPage.ok === true && readPage.value.returnedRows === 2 && readPage.value.offset === 1 &&
    readPage.value.hasMoreRows === false, readPage)

  // ---------- B5：把 SQL 只写进编辑器 ----------
  const beforeInsert = await cdp.eval('window.__doc()')
  const insert = JSON.parse(await cdp.eval(
    'window.__call("mcpDbInsertSql", { sql: "SELECT count(*) FROM order_tbl;" })'))
  await sleep(400)
  const afterInsert = await cdp.eval('window.__doc()')
  ck('db_insert_sql：文本落进 CodeMirror，返回里明说 executed: false',
    insert.ok === true && insert.value.inserted === true && insert.value.executed === false &&
    /SELECT count\(\*\) FROM order_tbl;/.test(afterInsert),
    { insert, doc: afterInsert.slice(0, 120) })
  ck('插入没有吃掉用户手写的那句（原文与产出同在）',
    /SELECT id, note, tag, note2 FROM typed_tbl/.test(afterInsert) &&
    afterInsert.length > beforeInsert.length,
    { before: beforeInsert.slice(0, 60), after: afterInsert.slice(0, 160) })
  const insertEmpty = JSON.parse(await cdp.eval('window.__call("mcpDbInsertSql", { sql: "   " })'))
  ck('空 SQL 报错，不落一个空串进编辑器', insertEmpty.ok === false && /sql is required/.test(insertEmpty.error), insertEmpty)

  ck('判据 D：到这里为止 executeSql 仍然只有"人按运行"那一次（五个工具一次都没执行）',
    Number(await cdp.eval('window.__execN()')) === execAfterRun,
    { afterRun: execAfterRun, now: await cdp.eval('window.__execN()') })

  // ---------- B6：redis 页签与多页签歧义 ----------
  await cdp.eval(`(() => {
    window.store.addTab(${JSON.stringify(REDIS_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return String(t.id)
  })()`)
  const redisId = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.dbType === 'redis').map(t => String(t.id)))"
  ))[0]
  await sleep(700)
  const redisCtx = JSON.parse(await cdp.eval('window.__call("mcpDbGetContext", { tabId: "' + redisId + '" })'))
  ck('redis 页签：上下文照实给出，但标成不支持 SQL（模型据此换路子而不是要表清单）',
    redisCtx.ok === true && redisCtx.value.dbType === 'redis' && redisCtx.value.supportsSql === false, redisCtx)
  const redisTables = JSON.parse(await cdp.eval('window.__call("mcpDbListTables", { tabId: "' + redisId + '" })'))
  ck('对 redis 页签要表清单：明确拒绝，不拿键名冒充表名',
    redisTables.ok === false && /Redis tab; it has no SQL tables/.test(redisTables.error), redisTables)
  // 活动页签指向一个非数据库页签（等价于"人正停在别的界面"），此时两个数据库页签无法二选一。
  // 注意不能走 changeActiveTabId：它对不在 tabs 里的 id 直接 return（store/tab.js），
  // 于是活动页签仍是 redis，判据量到的是"redis 拒绝"而不是"歧义"——用例自己骗了自己。
  const movedTo = await cdp.eval(`(() => {
    const other = (window.store.tabs || []).find(t => t.type !== 'database')
    const id = other ? String(other.id) : 'not-a-tab'
    window.store.activeTabId = id
    return id
  })()`)
  await sleep(200)
  const ambiguous = JSON.parse(await cdp.eval('window.__call("mcpDbListTables", {})'))
  ck('多个数据库页签且活动页签不是数据库：报错列出候选，要求显式给 tabId（不猜）',
    ambiguous.ok === false && /2 database tabs are open/.test(ambiguous.error) && /pass tabId/.test(ambiguous.error),
    { movedTo, ambiguous })
  // 关掉 redis，后面 agent 用 mysql 页签
  await cdp.eval('(async () => { await window.store.delTab("' + redisId + '") })()')
  await sleep(600)
  await cdp.eval('window.store.changeActiveTabId("' + dbTabId + '")')

  // ---------- C：走完整 agent 循环 ----------
  // Ask/Agent 会写进 localStorage，同一个用户数据目录里是跟着实例走的。
  // 记下进入前的值，收尾还原 —— 不还原的话，后面任何吃 AIchat 通道的 demo
  // （比如 db-ai-image-demo）一点发送都收不到请求，因为 Agent 走的是 AIchatWithTools。
  const modeBefore = await cdp.eval("localStorage.getItem('ai-chat-mode') || ''")
  await cdp.eval('window.__reset("agent")')
  await cdp.eval('window.__closePanel()')
  await sleep(300)
  await cdp.eval('window.__openPanel()')
  await sleep(500)
  const calls = [
    { name: 'db_get_context', args: { tabId: dbTabId } },
    { name: 'db_list_tables', args: { tabId: dbTabId } },
    { name: 'db_describe_table', args: { tabId: dbTabId, table: 'typed_tbl' } },
    { name: 'db_read_result', args: { tabId: dbTabId, limit: 2 } },
    { name: 'db_insert_sql', args: { tabId: dbTabId, sql: 'SELECT MAX(id) FROM typed_tbl;' } }
  ]
  await cdp.eval('window.__script(' + JSON.stringify([{ calls }]) + ')')
  const docBeforeAgent = await cdp.eval('window.__doc()')
  const sent = await cdp.eval('window.__submit("看一眼这张表，给一条统计 SQL")')
  ck('agent 模式发送出去（面板把这一句交给 agent 循环）', sent === 'ok', sent)
  ck('模型收到第一轮 tool_calls 后，agent 把五个工具全跑完并回到纯文本',
    await waitFor(cdp, '(window.store.aiChatHistory || []).slice(-1)[0].toolCalls && (window.store.aiChatHistory || []).slice(-1)[0].toolCalls.length === 5', '5 tool cards', 20000) &&
    await waitFor(cdp, '(window.store.aiChatHistory || []).slice(-1)[0].pending === false', 'turn finished', 20000))
  const cards = JSON.parse(await cdp.eval('window.__toolCards()'))
  ck('五个工具在真实循环里全部 completed（没有 Unknown agent tool / 参数没接住）',
    cards.length === 5 && cards.every(c => c.status === 'completed'),
    cards.map(c => c.name + ':' + c.status))
  ck('agent 全程没执行 SQL：executeSql 次数与"人按运行"那次相同',
    Number(await cdp.eval('window.__execN()')) === execAfterRun,
    { expect: execAfterRun, now: await cdp.eval('window.__execN()') })
  ck('db_insert_sql 在 agent 链路里同样落进编辑器',
    /SELECT MAX\(id\) FROM typed_tbl;/.test(await cdp.eval('window.__doc()')) &&
    (await cdp.eval('window.__doc()')).length > docBeforeAgent.length,
    (await cdp.eval('window.__doc()')).slice(0, 200))

  const req1 = JSON.parse(await cdp.eval('window.__req(0)'))
  const req2 = JSON.parse(await cdp.eval('window.__req(1)'))
  const DB_NAMES = ['db_get_context', 'db_list_tables', 'db_describe_table', 'db_read_result', 'db_insert_sql']
  ck('A) 发给模型的 schema 里五个 db 工具都在（不是只写在代码里没接进循环）',
    DB_NAMES.every(n => req1.tools.includes(n)), req1.tools.filter(t => t.startsWith('db_')))
  ck('A) schema 里没有任何执行/写库的 db 工具',
    !req1.tools.some(t => /db_(execute|run|write|query)/.test(t) || t === 'execute_sql'), req1.tools)
  ck('系统提示词把"只读、由人执行"的边界写给模型',
    /no tool that runs SQL/.test(req1.system) && /db_insert_sql/.test(req1.system),
    String(req1.system).slice(0, 200))
  ck('工具结果真的回流给模型：第二轮带 5 条 role:tool，内容是整形后的 JSON',
    req2.roles.filter(r => r === 'tool').length === 5 &&
    req2.toolContents.some(c => /typed_tbl/.test(c)) &&
    req2.toolContents.some(c => /truncatedCells/.test(c)),
    { roles: req2.roles, sample: (req2.toolContents[1] || '').slice(0, 120) })
  await cdp.shot(path.join(SHOT_DIR, '1-agent-tool-run.png'))

  // 还原进入本 demo 前的模式，别把 Agent 留给共用同一份配置目录的下一个 demo
  await cdp.eval(
    '(function () { const v = ' + JSON.stringify(modeBefore) +
    "; if (v) localStorage.setItem('ai-chat-mode', v); else localStorage.removeItem('ai-chat-mode') })()")
  ck('收尾把 Ask/Agent 记忆还原成进入前的值（不把 Agent 留给后面的 demo）',
    await cdp.eval("localStorage.getItem('ai-chat-mode') || ''") === modeBefore,
    { before: modeBefore || '(unset)', after: await cdp.eval("localStorage.getItem('ai-chat-mode') || '(unset)'") })

  const hard = cdp.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|TypeError|uncaught|Warning:/.test(s)
  })
  ck('渲染层没有新增硬错误（懒加载被换页撕掉的不算）', hard.length === 0, hard.slice(0, 5))

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  return fail.length
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
