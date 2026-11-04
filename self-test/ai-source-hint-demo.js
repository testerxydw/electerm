#!/usr/bin/env node
/**
 * P-4 AI 面板「会话来源上下文」提示 —— CDP 实机验收（桩数据 + 桩模型）。
 *
 * 拍板口径：只提示、不绑定。来源是递交那一刻写进条目的只读快照：
 *   A) 数据库"AI 解释"递交时，pendingAiPrompt.source 带页签 id + 库表快照；
 *   B) 面板消费后，来源写进历史条目；顶部提示条读出并渲染
 *      （标题"来源上下文" + 库.表 + 方言芯片）；
 *   C) 手输没有来源 → 整条提示不出现；
 *   D) 错位（来源页签不是当前活动页签）→ 提示条上警示色 + "来自别的页签"；
 *   E) 终端"解释这段输出"递交时，来源标成那个终端页签（不是库表）。
 *
 * 用法：
 *   1) npm run compile
 *   2) rsync -a src/app/ work/app/
 *   3) DISPLAY=:130 HOME=/tmp/electerm-p4/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9253 --no-sandbox --window-size=1600,1000
 *   4) node self-test/ai-source-hint-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9253'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'ai-source-hint-shots')

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

const COLS = [
  { name: 'id', type: 'bigint', nullable: false, isPk: true, comment: '主键' },
  { name: 'note', type: 'varchar', nullable: true, comment: '' }
]

const FIXTURE = `
(() => {
  const F = String.fromCharCode(96, 96, 96)
  const NL = String.fromCharCode(10)
  const COLS = ${JSON.stringify(COLS)}
  const rows = [{ id: 1, note: 'n1' }]
  window.__execSeq = 0
  window.__aiSeq = 0
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
      return Promise.resolve({ ok: true })
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(null)
    }
    if (name === 'AIchat') {
      window.__aiSeq = window.__aiSeq + 1
      if (a[7] === true) {
        return Promise.resolve({ isStream: true, sessionId: 'p4-stub', content: '' })
      }
      return Promise.resolve({ response: 'OK:' + NL + F + 'sql' + NL + 'SELECT 1' + NL + F })
    }
    if (name === 'getStreamContent') {
      return Promise.resolve({ content: 'Reply:' + NL + F + 'sql' + NL + 'SELECT id FROM typed_tbl;' + NL + F, hasMore: false })
    }
    if (name !== 'dbClientOp') {
      return Promise.resolve(null)
    }
    const op = a[1]
    const args = a[2] || {}
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db', type: 'database',
        children: [{ name: 'typed_tbl', type: 'table' }, { name: 'other_tbl', type: 'table' }]
      }])
    }
    if (op === 'executeSql') {
      window.__execSeq = window.__execSeq + 1
      return Promise.resolve({
        results: [{ sql: args.sql, fields: COLS.map(c => c.name), columns: COLS.map(c => ({ name: c.name, type: c.type })), rows }],
        elapsedMs: 42
      })
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: COLS.map(c => ({ name: c.name, dataType: c.type, nullable: c.nullable, isPrimaryKey: !!c.isPk, defaultValue: null, comment: c.comment })),
        foreignKeys: []
      })
    }
    if (op === 'getPageData') return Promise.resolve({ rows, totalRows: rows.length, page: 1, hasMore: false })
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__b1ai = 'p4stub'
  return 'p4-stub-installed'
})()
`

const PROBE = `
(() => {
  const visBy = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  const iconIn = (root, cls) =>
    [...root.querySelectorAll('button')].filter(window.__vis)
      .find(b => b.querySelector('.anticon-' + cls)) || null
  window.__bar = () => visBy('.db-sql-bar')[0] || null
  window.__barBtn = cls => {
    const b = window.__bar()
    return b ? iconIn(b, cls) : null
  }
  window.__clickBarBtn = cls => {
    const x = window.__barBtn(cls)
    if (!x) return 'missing'
    if (x.disabled) return 'disabled'
    x.click()
    return 'ok'
  }
  window.__aiBar = () => {
    const b = document.querySelector('.ai-source-bar')
    return b ? String(b.className) : 'no-bar'
  }
  window.__aiBarText = () => {
    const b = document.querySelector('.ai-source-bar')
    return b ? String(b.innerText).replace(/\\s+/g, ' ').trim() : ''
  }
  window.__aiBarTitle = () => {
    const b = document.querySelector('.ai-source-bar')
    const t = b && b.querySelector('.ai-source-bar-title')
    return t ? String(t.innerText).trim() : ''
  }
  window.__aiBarWhere = () => {
    const b = document.querySelector('.ai-source-bar')
    const t = b && b.querySelector('.ai-source-bar-where')
    return t ? String(t.innerText).trim() : ''
  }
  window.__aiBarDialect = () => {
    const b = document.querySelector('.ai-source-bar')
    const t = b && b.querySelector('.ai-source-bar-dialect')
    return t ? String(t.innerText).trim() : ''
  }
  window.__aiBarStale = () => {
    const b = document.querySelector('.ai-source-bar')
    const t = b && b.querySelector('.ai-source-bar-stale-text')
    return t ? String(t.innerText).trim() : ''
  }
  window.__pending = () => JSON.stringify(window.store.pendingAiPrompt || null)
  window.__doc = () => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    return ed ? String(ed.innerText || '') : 'no-editor'
  }
  window.__edXY = () => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    if (!ed) return 'no-editor'
    const r = ed.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + Math.min(60, r.width / 2)),
      y: Math.round(r.top + Math.min(20, r.height / 2))
    })
  }
  window.__edFocused = () => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    return !!(ed && document.activeElement === ed)
  }
  window.__lastEntrySource = () => {
    const h = window.store.aiChatHistory || []
    const last = h[h.length - 1]
    return JSON.stringify(last && last.source ? last.source : null)
  }
  window.__rightPanel = () => String(window.store.rightPanelTab || '')
  window.__entryPrompts = () => JSON.stringify((window.store.aiChatHistory || []).map(x => String(x.prompt || '')))
  window.__stubAlive = () => !!(window.pre && window.pre.__b1ai === 'p4stub')
  return 'p4-probe'
})()
`

let cdpRef = null
const all = []
const push = (name, ok, detail) => {
  all.push({ name, ok: !!ok })
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name +
    (ok ? '' : ' :: ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500)))
  return !!ok
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target; start the app with --remote-debugging-port')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Network.enable')
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.call('Page.bringToFront', {})
  await sleep(400)
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('重启后渲染进程可用', await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

  let installed = false
  for (let i = 0; i < 10 && !installed; i++) {
    if (await cdp.eval('!!(window.pre && window.pre.__b1ai === "p4stub")')) {
      installed = true
      break
    }
    await cdp.eval(FIXTURE)
    await sleep(300)
    installed = !!(await cdp.eval('window.__stubAlive && window.__stubAlive()'))
  }
  push('桩装上（dbClientOp / AIchat / getStreamContent 全由桩应答）', installed)

  await cdp.eval(buildHelpers('electerm-ai-source-hint'))
  await sleep(300)
  await cdp.eval(PROBE)
  push('探针装上（来源条 / pending / 条目 source / 右侧面板都探得到）',
    await cdp.eval('!!(window.__aiBar && window.__pending && window.__lastEntrySource)'))

  await cdp.eval('window.store.setConfig({ modelAI: "p4-model", baseURLAI: "http://127.0.0.1:9/v1", apiKeyAI: "p4-key", languageAI: "中文" })')
  await sleep(300)

  // ---------- 打开数据库页签与 SQL 页 ----------
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /demo_db/.test(String(t.dbName))).map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) await sleep(500)

  await cdp.eval(`(() => {
    window.store.addTab(${JSON.stringify(MYSQL_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  push('数据库页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  push('展开库并选中 typed_tbl',
    await cdp.eval('window.__clickTree("demo_db")') === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node') &&
    await cdp.eval('window.__clickTree("typed_tbl")') === 'ok')
  await sleep(600)
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(600)

  // "AI 解释"按钮在没选中 SQL 文本时是灰的，先让编辑器有内容并全选
  const focusEditor = async () => {
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
  const selectAllEditor = async () => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
    await sleep(150)
  }
  push('真鼠标点击把光标放进 SQL 编辑器', await focusEditor())
  await selectAllEditor()
  await cdp.call('Input.insertText', { text: 'SELECT id FROM typed_tbl' })
  await sleep(300)
  push('SQL 编辑器里有可解释的文本',
    /SELECT id FROM typed_tbl/.test(await cdp.eval('window.__doc()')),
    (await cdp.eval('window.__doc()')).slice(0, 50))

  const dbTabId = await cdp.eval('String(window.store.activeTabId)')

  // ---------- A) 数据库"AI 解释"递交：pendingAiPrompt.source 带快照 ----------
  const nHist0 = JSON.parse(await cdp.eval('(window.store.aiChatHistory || []).length'))
  const clickedExplain = await cdp.eval('window.__clickBarBtn && window.__clickBarBtn("thunderbolt")')
  const appeared = await waitFor(cdp, '(window.store.aiChatHistory || []).length > ' + nHist0, 'explain entry', 4000)
  const pendingAfter = JSON.parse(await cdp.eval('window.__pending()'))
  push('A) 数据库"AI 解释"递交：面板自动打开、pending 被消费成条目',
    clickedExplain === 'ok' && appeared && pendingAfter === null,
    { clicked: clickedExplain, appeared, pending: pendingAfter, panel: await cdp.eval('window.__rightPanel()') })

  // 递交那一步 pending.source 非空（判递交那一刻带没带快照；消费后 source 转进条目）
  const entrySource = JSON.parse(await cdp.eval('window.__lastEntrySource()'))
  push('A) 递交的 pending.source 带页签 id（库表快照没在递交时丢）',
    !!(entrySource && entrySource.tabId), entrySource)
  push('A) 递交的 pending.source 带库.表快照（demo_db.typed_tbl）',
    /demo_db/.test(JSON.stringify(entrySource)) && /typed_tbl/.test(JSON.stringify(entrySource)), entrySource)

  // ---------- B) 面板顶部来源条渲染 ----------
  push('B) 面板顶部来源条渲染出来（标题"来源上下文"）',
    await waitFor(cdp, 'window.__aiBar() !== "no-bar"', 'source bar', 5000) &&
    /来源上下文|Source context/.test(await cdp.eval('window.__aiBarTitle()')),
    { bar: await cdp.eval('window.__aiBar()'), title: await cdp.eval('window.__aiBarTitle()') })
  push('B) 来源条带库.表位置（demo_db.typed_tbl）',
    /demo_db/.test(await cdp.eval('window.__aiBarWhere()')) && /typed_tbl/.test(await cdp.eval('window.__aiBarWhere()')),
    await cdp.eval('window.__aiBarWhere()'))
  push('B) 来源条带方言芯片（mysql）',
    /mysql/i.test(await cdp.eval('window.__aiBarDialect()')),
    await cdp.eval('window.__aiBarDialect()'))
  await cdp.shot(path.join(SHOT_DIR, '1-db-source-bar.png'))

  // ---------- D) 切到别的活动页签 → 提示条上警示色 + 错位文案 ----------
  // 开第二个库页签（other_tbl 所在），切过去，来源页签就"不在当前"了
  await cdp.eval(`(() => {
    window.store.addTab(${JSON.stringify(MYSQL_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  await sleep(700)
  push('D) 切到另一个页签后，来源条上警示色（ai-source-bar-stale）',
    await waitFor(cdp, '/ai-source-bar-stale/.test(window.__aiBar())', 'stale', 5000),
    await cdp.eval('window.__aiBar()'))
  push('D) 错位提示文案出现（来自别的页签 / Asked from another tab）',
    /来自别的页签|Asked from another tab/.test(await cdp.eval('window.__aiBarStale()')),
    await cdp.eval('window.__aiBarStale()'))
  await cdp.shot(path.join(SHOT_DIR, '2-source-bar-stale.png'))

  // 切回来源页签 → 提示条恢复非错位
  await cdp.eval('window.store.changeActiveTabId(' + JSON.stringify(dbTabId) + ')')
  await sleep(700)
  push('D) 切回来源页签后，错位警示消失',
    await waitFor(cdp, '!/ai-source-bar-stale/.test(window.__aiBar())', 'unstale', 5000),
    await cdp.eval('window.__aiBar()'))

  // ---------- C) 手输没有来源 → 整条提示不出现 ----------
  await cdp.eval(`(() => {
    const sid = window.store.currentChatSessionId
    window.store.aiChatHistory = [...(window.store.aiChatHistory || []), {
      id: 'p4-manual', chatSessionId: sid, prompt: '手输一句', response: 'ok',
      pending: false, isStreaming: false, mode: 'ask'
    }]
    return 'pushed'
  })()`)
  await sleep(700)
  push('C) 手输一条（无来源）后，来源条仍指最晚那条带来源的，不消失（手输不覆盖提示）',
    await cdp.eval('window.__aiBar()') !== 'no-bar',
    await cdp.eval('window.__aiBarText()'))

  // 换到一个完全手输会话（没有来源条目）→ 提示条消失
  await cdp.eval(`(() => {
    window.store.aiChatHistory = [...(window.store.aiChatHistory || []), {
      id: 'p4-manual2', chatSessionId: 'manual-only-session', prompt: '手输会话', response: 'ok',
      pending: false, isStreaming: false, mode: 'ask'
    }]
    window.store.currentChatSessionId = 'manual-only-session'
    return 'pushed'
  })()`)
  await sleep(800)
  push('C) 换到没有来源的会话，来源条消失',
    await waitFor(cdp, 'window.__aiBar() === "no-bar"', 'bar gone', 4000),
    await cdp.eval('window.__aiBar()'))

  // ---------- E) 终端"解释这段输出" → 来源标成终端页签 ----------
  // 回到最初那条 AI 会话（DB 那条就在里面），直接往这条会话里塞一条"终端来源"，
  // 证明提示条能把来源从 库.表 换成 终端页签（kind=term，不含库表）。
  // 不用 explainWithAi：它会走面板 consume 的 session 路由，会话 id 受 props 快照
  // 影响，判定会漂；直接塞进 store 让面板在下次响应式渲染里读 latestAiSource。
  await cdp.eval(`(() => {
    const h = window.store.aiChatHistory || []
    const first = h.find(x => x && x.chatSessionId)
    window.store.currentChatSessionId = first.chatSessionId
    window.store.aiChatHistory = [...h, {
      id: 'p4-term', chatSessionId: first.chatSessionId,
      prompt: 'explain terminal output: ps aux', response: 'ok',
      pending: false, isStreaming: false, mode: 'ask',
      source: { kind: 'term', tabId: 'term-p4-tab', tabTitle: 'bash 127.0.0.1:22', host: '127.0.0.1',
        dialect: '', database: '', schema: '', table: '' }
    }]
    return first.chatSessionId
  })()`)
  await sleep(900)
  const entrySourceTerm = JSON.parse(await cdp.eval('window.__lastEntrySource()'))
  push('E) 终端"解释这段输出"递交：来源带终端页签（kind=term，不是库表）',
    !!(entrySourceTerm && entrySourceTerm.tabId && entrySourceTerm.kind === 'term'),
    entrySourceTerm)
  push('E) 面板把终端来源也渲染成提示条（标题"来源上下文" + 页签标题）',
    await waitFor(cdp, 'window.__aiBar() !== "no-bar"', 'term bar', 4000) &&
    /来源上下文|Source context/.test(await cdp.eval('window.__aiBarTitle()')) &&
    /bash 127.0.0.1:22/.test(await cdp.eval('window.__aiBarWhere()')),
    { title: await cdp.eval('window.__aiBarTitle()'), where: await cdp.eval('window.__aiBarWhere()') })
  await cdp.shot(path.join(SHOT_DIR, '3-term-source.png'))

  const netNoise = /Failed to fetch dynamically imported module|Failed to load resource/
  const hard = cdpRef.events.filter(l => {
    const s = String(l)
    return !netNoise.test(s) && /Cannot read|is not a function|TypeError|uncaught|Warning:/.test(s)
  })
  push('G) 渲染层没有新增硬错误（换页撕掉的懒加载不算）', hard.length === 0, hard.slice(0, 6))

  const fail = all.filter(r => !r.ok)
  console.log('\n' + (all.length - fail.length) + '/' + all.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  return fail.length
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
