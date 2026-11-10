#!/usr/bin/env node
// Requires an exclusive X display and compiled app; DB and model are stubbed in the real renderer.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':152'
const PORT = process.argv[3] || '9352'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/2026-11-10-agent-db-n10b-shots')

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n10b-'))
let app = null
let connection = null

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
  readOnly: true,
  production: true,
  dbUser: '',
  dbName: '',
  batch: null
}

const STUB = String.raw`
(() => {
  if (window.pre.__n10bStub === 'stub') return 'already'
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  window.__writeOps = []
  window.__dbOps = []
  window.__aiSeq = 0
  window.__aiReq = []
  window.__toolScript = []
  window.__cols = [
    { name: 'id', dataType: 'int', columnType: 'int(11)', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'email', dataType: 'varchar', columnType: 'varchar(64)', nullable: false, defaultValue: '', comment: '登录名', ordinal: 2 },
    { name: 'note', dataType: 'text', columnType: 'text', nullable: true, ordinal: 3 }
  ]
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'AIchatWithTools') {
      window.__aiSeq = window.__aiSeq + 1
      const msgs = Array.isArray(a[0]) ? a[0] : []
      window.__aiReq.push({
        n: window.__aiSeq,
        tools: (a[6] || []).map(t => (t && t.function && t.function.name) || ''),
        roles: msgs.map(m => m.role),
        toolContents: msgs.filter(m => m.role === 'tool').map(m => m.content),
        system: String((msgs[0] && msgs[0].content) || '')
      })
      const step = (window.__toolScript || []).shift()
      if (step && step.calls) {
        return Promise.resolve({
          message: {
            role: 'assistant', content: step.content || '',
            tool_calls: step.calls.map((c, i) => ({
              id: 'call-' + window.__aiSeq + '-' + i, type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
            }))
          }
        })
      }
      const failed = msgs.some(m => m.role === 'tool' && String(m.content).includes('fixture connection lost'))
      return Promise.resolve({ message: { role: 'assistant', content: failed ? '读取失败：fixture connection lost。' : 'done: 只读看完。' } })
    }
    if (name === 'AIchat' || name === 'getStreamContent') {
      return Promise.resolve(name === 'AIchat' ? { isStream: true, sessionId: 'stub' } : { content: '', hasMore: false })
    }
    if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
      return Promise.resolve({ ok: true })
    }
    if (name === 'dbGridViewOp') return Promise.resolve(null)
    if (name !== 'dbClientOp') return orig(name, ...a)
    const op = a[1]
    const args = a[2] || {}
    window.__dbOps.push({ op, args })
    if (!['getMetadata', 'getPageData', 'getKeyDetail', 'getRedisInfo', 'getRedisSlowlog', 'getTableStructure', 'countRows', 'getDbTxState', 'listColumns'].includes(op)) {
      window.__writeOps.push(op)
      return Promise.reject(new Error('Unexpected database operation: ' + op))
    }
    if (op === 'getDbTxState') return Promise.resolve({ supported: true, active: false, statements: [], pendingCount: 0, pinnedTabs: 0, maxTabs: 8, lastTx: null })
    if (op === 'listColumns') return Promise.resolve({ tables: [] })
    if (op === 'getMetadata') {
      const tab = window.store.tabs.find(t => t.id === a[0])
      if (tab && tab.dbType === 'redis') return Promise.resolve([{ name: 'db0', type: 'database', children: [] }])
      return Promise.resolve([{
        name: 'demo_db', type: 'database', children: [
          { name: 'base_tbl', type: 'table' }, { name: 'target_tbl', type: 'table' }
        ]
      }])
    }
    if (op === 'getPageData') {
      return Promise.resolve({
        rows: [{ name: 'k1', type: 'string', ttl: -1 }, { name: 'k2', type: 'hash', ttl: 120 }],
        nextCursor: '0', hasMore: false
      })
    }
    if (op === 'getKeyDetail') {
      if (args.key === 'failure') return Promise.reject(new Error('fixture connection lost'))
      if (args.key === 'k2') {
        return Promise.resolve({ type: 'hash', rows: { a: '1', b: '2' }, fields: ['a', 'b'], total: 2, nextCursor: '0', ttl: -1 })
      }
      return Promise.resolve({ type: 'string', value: 'hello', fields: [], ttl: -1, nextCursor: '0' })
    }
    if (op === 'getRedisInfo') {
      return Promise.resolve('# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n# Stats\r\nkeyspace_hits:90\r\nkeyspace_misses:10\r\n# Keyspace\r\ndb0:keys=5,expires=2\r\n')
    }
    if (op === 'getRedisSlowlog') {
      return Promise.resolve([[1, 1730192000, 5000, ['GET', 'k'], '1.2.3.4:1', '']])
    }
    if (op === 'getTableStructure') {
      if (args.table === 'target_tbl') {
        return Promise.resolve({
          type: 'table', comment: '目标表', estimatedRows: 100,
          columns: [
            { name: 'id', dataType: 'int', columnType: 'int(11)', nullable: false, isPrimaryKey: true, ordinal: 1 },
            { name: 'email', dataType: 'varchar', columnType: 'varchar(128)', nullable: false, defaultValue: '', comment: '登录名', ordinal: 2 },
            { name: 'extra', dataType: 'int', columnType: 'int(11)', nullable: true, ordinal: 4 }
          ],
          indexes: [], foreignKeys: []
        })
      }
      return Promise.resolve({
        type: 'table', comment: '基础表', estimatedRows: 1234,
        columns: window.__cols,
        indexes: [{ name: 'PRIMARY', unique: true, primary: true, columns: ['id'], method: 'BTREE' }],
        foreignKeys: []
      })
    }
    if (op === 'countRows') return Promise.resolve({ count: 1 })
    return Promise.resolve(null)
  }
  window.pre.__n10bStub = 'stub'
  return 'stub-installed'
})()
`

const PROBE = `
(() => {
  window.__call = async (fn, arg) => {
    try {
      return JSON.stringify({ ok: true, value: await window.store[fn](arg || {}) })
    } catch (err) {
      return JSON.stringify({ ok: false, error: String((err && err.message) || err) })
    }
  }
  window.__dbTabs = () => JSON.stringify((window.store.tabs || [])
    .filter(t => t.type === 'database').map(t => ({ id: String(t.id), dbType: t.dbType })))
  window.__writeOpsN = () => (window.__writeOps || []).length
  window.__aiN = () => Number(window.__aiSeq || 0)
  window.__req = i => JSON.stringify((window.__aiReq || [])[i] || {})
  window.__script = calls => { window.__toolScript = calls; return calls.length }
  window.__reset = () => {
    localStorage.setItem('ai-chat-mode', 'agent')
    window.store.aiChatHistory = []
    window.store.agentRunning = false
    return 'ok'
  }
  return 'probe-installed'
})()
`

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = {
    ...process.env,
    DISPLAY,
    HOME: path.join(RUN, 'home'),
    XDG_CONFIG_HOME: path.join(RUN, 'config'),
    TMPDIR: path.join(RUN, 'tmp'),
    DATA_PATH: path.join(RUN, 'data')
  }
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: 'ignore' })
}

async function cleanup () {
  if (connection) connection.ws.close()
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve))
    try { process.kill(-app.pid, 'SIGTERM') } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
    await exited
  }
  fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

async function waitCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const page = list && findPageTarget(list)
    if (page) {
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      await cdp.call('Log.enable', {})
      cdp.events.length = 0
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

async function assertPortIdle () {
  const v = await getJson('http://127.0.0.1:' + PORT + '/json/version').catch(() => null)
  if (!v) return
  throw new Error('端口 ' + PORT + ' 上已有实例在跑（' + (v.Browser || '未知') + '）——先清掉再跑')
}

const main = async () => {
  await assertPortIdle()
  launch()
  const cdp = await waitCdp()
  connection = cdp
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(cdp, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪：' + J(await cdp.tail(8)))
  }
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, readyExpr, '重载后 store 仍不在', 60000)) {
    throw new Error('重载后仍未就绪：' + J(await cdp.tail(8)))
  }
  await sleep(2500)

  let installed = false
  for (let i = 0; i < 10 && !installed; i++) {
    await cdp.eval(STUB)
    await sleep(250)
    installed = !!(await cdp.eval('!!(window.pre && window.pre.__n10bStub === "stub")'))
  }
  check('桩装上（dbClientOp / AIchatWithTools 由桩应答）', installed)
  await cdp.eval(buildHelpers('electerm-n10b'))
  await cdp.eval(PROBE)
  await sleep(200)
  check('探针装上（__call / __dbTabs / __script 都探得到）',
    await cdp.eval('!!(window.__call && window.__dbTabs && window.__script)'))

  await cdp.eval('window.store.setConfig({ modelAI: "stub-model", baseURLAI: "http://127.0.0.1:9/v1", apiKeyAI: "stub-key", languageAI: "English" })')
  await sleep(300)

  // 清场：关掉所有数据库页签
  const stale = JSON.parse(await cdp.eval('window.__dbTabs()'))
  for (const t of stale) {
    await cdp.eval('(async () => { await window.store.delTab("' + t.id + '") })()')
  }
  if (stale.length) await sleep(600)

  // ---------- 开 SQL 页签：db_structure_diff ----------
  await cdp.eval(`(() => {
    window.store.addTab(${J(MYSQL_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return String(t.id)
  })()`)
  await sleep(700)
  const sqlId = JSON.parse(await cdp.eval('window.__dbTabs()')).find(t => t.dbType === 'mysql').id

  // B1: 结构 diff —— 只报有变化的条目
  const diff = JSON.parse(await cdp.eval(
    'window.__call("mcpDbStructureDiff", { tabId: ' + J(sqlId) + ', baseTable: "base_tbl", targetTable: "target_tbl" })'))
  const changedNames = ((diff.value && diff.value.columns && diff.value.columns.changes) || []).map(c => c.name)
  check('db_structure_diff：两表对比出 added（extra）+ removed（note），equal 不入 changes',
    diff.ok === true &&
    changedNames.includes('extra') &&
    changedNames.includes('note') &&
    diff.value.columns.changes.every(c => c.status !== 'equal'),
    { changedNames })
  check('db_structure_diff：dialect/标签透出，note 明说只读不生成 DDL',
    diff.value && diff.value.dialect && diff.value.base && diff.value.target &&
    /No DDL is generated or run/.test(diff.value.note), diff.value)
  // 缺参数报错
  const diffNoArg = JSON.parse(await cdp.eval('window.__call("mcpDbStructureDiff", { tabId: ' + J(sqlId) + ' })'))
  check('db_structure_diff：缺 base/target 报错指向 db_list_tables',
    diffNoArg.ok === false && /baseTable and targetTable are required/.test(diffNoArg.error), diffNoArg)

  // redis 工具对 SQL 页签明确拒绝（模型要 redis_* 数据却停在 SQL 页签时改口）
  const badRedis = JSON.parse(await cdp.eval(
    'window.__call("mcpRedisScanKeys", { tabId: ' + J(sqlId) + ' })'))
  check('对 SQL 页签调 redis_scan_keys：明确拒绝，说清要 Redis 连接',
    badRedis.ok === false && /not a Redis tab/.test(badRedis.error), badRedis)

  // ---------- 开 redis 页签：redis 只读工具 ----------
  await cdp.eval(`(() => {
    window.store.addTab(${J(REDIS_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return String(t.id)
  })()`)
  await sleep(700)
  const redisId = JSON.parse(await cdp.eval('window.__dbTabs()')).find(t => t.dbType === 'redis').id

  const scan = JSON.parse(await cdp.eval(
    'window.__call("mcpRedisScanKeys", { tabId: ' + J(redisId) + ' })'))
  check('redis_scan_keys：键清单/游标/翻页标志透出',
    scan.ok === true && scan.value.keys.length === 2 &&
    scan.value.keys[0].name === 'k1' && scan.value.keys[0].type === 'string' &&
    scan.value.nextCursor === '0', scan.value)

  const key = JSON.parse(await cdp.eval(
    'window.__call("mcpRedisGetKey", { tabId: ' + J(redisId) + ', key: "k2" })'))
  check('redis_get_key：hash 按类型整形，字段/总数到位',
    key.ok === true && key.value.type === 'hash' &&
    key.value.fields.length === 2 && key.value.totalFields === 2, key.value)
  const keyNoArg = JSON.parse(await cdp.eval('window.__call("mcpRedisGetKey", { tabId: ' + J(redisId) + ' })'))
  check('redis_get_key：缺 key 报错指向 redis_scan_keys',
    keyNoArg.ok === false && /key is required/.test(keyNoArg.error), keyNoArg)

  const info = JSON.parse(await cdp.eval(
    'window.__call("mcpRedisInfo", { tabId: ' + J(redisId) + ' })'))
  check('redis_info：概览（版本/命中率/键空间）到位，缺即 null 不猜 0',
    info.ok === true && info.value.overview.version === '7.2.4' &&
    info.value.overview.hitRate === 0.9 &&
    info.value.keyspace[0].db === 'db0' && info.value.keyspace[0].keys === 5, info.value)

  const slow = JSON.parse(await cdp.eval(
    'window.__call("mcpRedisSlowlog", { tabId: ' + J(redisId) + ' })'))
  check('redis_slowlog：参数走 argText 预览，最慢耗时/条目归位',
    slow.ok === true && slow.value.entries[0].command === 'GET' &&
    slow.value.entries[0].args === 'k' && slow.value.maxDurationUs === 5000, slow.value)

  const structureOps = await cdp.jeval('window.__dbOps.filter(c => c.op === "getTableStructure")')
  check('两表结构强制刷新，新增/删除定义和字段变化保留',
    structureOps.length >= 2 && structureOps.every(c => c.args.refresh === true) &&
    diff.value.columns.changes.some(c => c.name === 'extra' && c.target) &&
    diff.value.columns.changes.some(c => c.name === 'note' && c.base) &&
    diff.value.columns.changes.some(c => c.name === 'email' && c.fields.some(f => f.base === 'varchar(64)' && f.target === 'varchar(128)')))

  const invoke = async (fn, args) => cdp.jeval('window.__call(' + J(fn) + ', ' + J({ tabId: redisId, ...args }) + ')')
  const sqlOnRedis = await invoke('mcpDbStructureDiff', { baseTable: 'base_tbl', targetTable: 'target_tbl' })
  check('Redis 页签拒绝 SQL 结构比较', !sqlOnRedis.ok && /Redis tab/.test(sqlOnRedis.error))
  for (const exactKey of ['', ' ', ' k ']) {
    const result = await invoke('mcpRedisGetKey', { key: exactKey })
    const sentKey = await cdp.eval('window.__dbOps.filter(c => c.op === "getKeyDetail").slice(-1)[0].args.key')
    check('Redis key 原样传递 ' + J(exactKey), result.ok && sentKey === exactKey)
  }
  for (const [fn, op, field, expected] of [
    ['mcpRedisScanKeys', 'getPageData', 'pageSize', 200],
    ['mcpRedisGetKey', 'getKeyDetail', 'pageSize', 200],
    ['mcpRedisSlowlog', 'getRedisSlowlog', 'count', 100]
  ]) {
    const result = await invoke(fn, { key: 'k2', limit: 999999 })
    const sent = await cdp.eval('window.__dbOps.filter(c => c.op === ' + J(op) + ').slice(-1)[0].args.' + field)
    check(fn + ' IPC 请求先封顶', result.ok && sent === expected, sent)
  }
  for (const args of [{ dbIndex: -1 }, { dbIndex: 0.5 }, { cursor: 'invalid' }, { match: 'x'.repeat(8193) }]) {
    const before = await cdp.eval('window.__dbOps.length')
    const result = await invoke('mcpRedisScanKeys', args)
    check('非法参数在 IPC 前拒绝', !result.ok && await cdp.eval('window.__dbOps.length') === before)
  }
  const sample = await invoke('mcpRedisGetKey', { key: 'k2', limit: 1 })
  check('末批截断明确标记，不把样本说成全量', sample.ok && sample.value.truncated === true && sample.value.hasMore === false)
  const failed = await invoke('mcpRedisGetKey', { key: 'failure' })
  check('连接错误可见，不伪装空结果', !failed.ok && /fixture connection lost/.test(failed.error))

  const writeOpsBefore = Number(await cdp.eval('window.__writeOpsN()'))
  check('判据 D（store 层）：五只读工具全程 0 次写 op（executeSql/setKey/runRedisCommand…）',
    writeOpsBefore === 0, await cdp.jeval('JSON.stringify(window.__writeOps)'))

  // ---------- C：走完整 agent 循环 ----------
  await cdp.eval('window.__reset()')
  await cdp.eval(`(() => {
    const s = window.store
    if (s.rightPanelVisible && s.rightPanelTab === 'ai') s.toggleAIPanel()
  })()`)
  await sleep(300)
  await cdp.eval('window.store.toggleAIPanel()')
  if (!await waitFor(cdp, '!!document.querySelector(".ai-chat-textarea")', 'AI input mounted', 10000)) {
    throw new Error('AI input did not mount')
  }
  await sleep(500)
  const calls = [
    { name: 'redis_scan_keys', args: { tabId: redisId } },
    { name: 'redis_get_key', args: { tabId: redisId, key: 'k2' } },
    { name: 'redis_info', args: { tabId: redisId } },
    { name: 'redis_slowlog', args: { tabId: redisId } },
    { name: 'db_structure_diff', args: { tabId: sqlId, baseTable: 'base_tbl', targetTable: 'target_tbl' } }
  ]
  await cdp.eval('window.__script(' + J([{ calls }]) + ')')
  const sendPrompt = async (text) => {
    const rect = await cdp.jeval(`(() => {
      const r = document.querySelector('.ai-chat-textarea').getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    await cdp.click(rect.x, rect.y)
    await cdp.call('Input.insertText', { text })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await sendPrompt('看一下 redis 和表结构差异')
  check('真实鼠标与回车发送 Agent 请求', await waitFor(cdp, 'window.__aiN() >= 1', 'agent request', 10000))
  check('模型收到第一轮 tool_calls 后 agent 把 5 个新工具全跑完回到纯文本',
    await waitFor(cdp, '(window.store.aiChatHistory || []).slice(-1)[0].toolCalls && (window.store.aiChatHistory || []).slice(-1)[0].toolCalls.length === 5', '5 tool cards', 20000) &&
    await waitFor(cdp, '(window.store.aiChatHistory || []).slice(-1)[0].pending === false', 'turn finished', 20000))
  const cards = await cdp.jeval('JSON.stringify((window.store.aiChatHistory || []).slice(-1)[0].toolCalls)')
  check('五个工具全部 completed', cards.length === 5 && cards.every(c => c.status === 'completed'), cards.map(c => c.name + ':' + c.status))
  const req2 = JSON.parse(await cdp.eval('window.__req(1)'))
  const outputs = (req2.toolContents || []).map(JSON.parse)
  check('五份真实工具结果回流下一轮模型请求', outputs.length === 5 &&
    outputs[0].keys[0].name === 'k1' && outputs[1].fields.length === 2 &&
    outputs[2].overview.version === '7.2.4' && outputs[3].entries[0].command === 'GET' &&
    outputs[4].columns.changes.some(c => c.name === 'email' && c.status === 'changed'))
  const req1 = JSON.parse(await cdp.eval('window.__req(0)'))
  const NEW_NAMES = ['redis_scan_keys', 'redis_get_key', 'redis_info', 'redis_slowlog', 'db_structure_diff']
  check('A) 发给模型的 schema 里 5 个新工具都在（接进了真实循环）',
    NEW_NAMES.every(n => req1.tools.includes(n)),
    req1.tools.filter(t => t.startsWith('db_') || t.startsWith('redis_')))
  check('A) schema 里没有任何执行/写库工具',
    !req1.tools.some(t => /db_(execute|run|write|query)/.test(t) || t === 'execute_sql' ||
      /redis_.*(set|del|expire|push|add|rem|command)/.test(t) || t === 'run_redis_command'),
    req1.tools.filter(t => t.startsWith('db_') || t.startsWith('redis_')))
  check('系统提示词把"Redis 只读 / 结构 diff 只比元数据"写给模型',
    /redis_\* tools only read/.test(req1.system) && /db_structure_diff only compares metadata/.test(req1.system),
    String(req1.system).slice(-240))

  await cdp.shot(path.join(SHOT_DIR, '1-n10b-agent-tool-run.png'))

  await cdp.eval('window.__script(' + J([{ calls: [{ name: 'redis_get_key', args: { tabId: redisId, key: 'failure' } }] }]) + ')')
  await sendPrompt('读取失败的键')
  check('工具报错后 Agent 正常收尾',
    await waitFor(cdp, 'window.__aiN() === 4 && window.store.aiChatHistory.slice(-1)[0].pending === false', 'failed tool completed', 10000))
  const failedCard = await cdp.jeval('JSON.stringify(window.store.aiChatHistory.slice(-1)[0].toolCalls[0])')
  const failureReq = await cdp.jeval('window.__req(3)')
  check('错误工具卡与模型回传均包含连接错误', failedCard.status === 'error' &&
    failureReq.toolContents.some(t => /fixture connection lost/.test(t)), failedCard.status)
  const errorHeader = await cdp.jeval(`(() => {
    const r = document.querySelector('.agent-tool-error .agent-tool-header').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await cdp.click(errorHeader.x, errorHeader.y)
  check('真实点击展开错误卡后错误文本可见', await waitFor(cdp,
    '!!document.querySelector(".agent-tool-error .agent-tool-result") && document.querySelector(".agent-tool-error .agent-tool-result").textContent.includes("fixture connection lost")', 'visible tool error', 5000))
  await cdp.shot(path.join(SHOT_DIR, '2-n10b-agent-tool-error.png'))

  // ---------- 判据 D（agent 链路）：写 op 仍是 0 ----------
  const writeOpsAfter = Number(await cdp.eval('window.__writeOpsN()'))
  check('判据 D（agent 链路）：完整循环后写 op 仍是 0 次',
    writeOpsAfter === 0, { writeOps: writeOpsAfter })

  const hard = cdp.events.filter(l => {
    const s = String(l)
    return !/Failed to fetch dynamically imported module|Failed to load resource/.test(s) &&
      /Cannot read|is not a function|TypeError|uncaught|Warning:/.test(s)
  })
  check('渲染层没有新增硬错误（懒加载被换页撕掉的不算）', hard.length === 0, hard.slice(0, 5))

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  return fail.length
}

main().then(code => {
  process.exitCode = code ? 1 : 0
}, e => {
  console.error(e)
  process.exitCode = 1
}).finally(cleanup).catch(e => {
  console.error(e)
  process.exitCode = 1
})
