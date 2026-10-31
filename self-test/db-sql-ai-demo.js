#!/usr/bin/env node
/**
 * AI × SQL 第一批 —— CDP 实机验收（桩数据 + 桩模型，无需真库，也无需真 AI 服务）
 *
 * 分析文档 §6 第一批交付的行为，逐条在真实渲染层里量：
 *   A) 入口齐备：工具条"AI 生成 / AI 优化"、错误条"复制 / AI 修复"、原有"AI 解释"。
 *   B) 弹层只写不执行：整条 AI 链路一次 executeSql 都不该发生（判 __execN）。
 *   C) 上下文真的进了提示词：方言、<schema> 列清单、选区优先、<error>、<user_note>
 *      —— 单测钉住了纯函数的构造，这里钉住"组件确实把参数传进来了"。
 *   D) 落编辑器三种策略：智能（非空文档不清空、插光标）、替换全部、选区替换；
 *      插入走 dispatch，所以 Ctrl+Z 能撤回（这就是"不用 onChange 整篇回写"的判据）。
 *   E) 对话面板里 SQL 代码块给"插入编辑器"而不是"在终端运行"；目标在点击时解析，
 *      没有可用会话页时只警告、不抛异常。
 *   F) 解释入口改走 pendingAiPrompt：递交被面板消费，句子带方言与库表上下文。
 *
 * 用法：
 *   1) npm run compile
 *   2) rsync -a src/app/ work/app/   # 词条在主进程里 require，compile 并不同步 src/app
 *   3) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a3/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   4) node self-test/db-sql-ai-demo.js [debugPort] [shotDir]
 *
 * 改过产品代码后必须重新 compile 再跑：脚本开头会关缓存刷页，但主进程里的
 * src/app（词条、ipc 处理）只有重启才生效。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-ai-shots')

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
  { name: 'note', type: 'varchar', nullable: true, comment: '' },
  { name: 'tag', type: 'varchar', nullable: true, comment: '' },
  { name: 'upper', type: 'varchar', nullable: true, comment: '' },
  { name: 'nullable', type: 'varchar', nullable: true, comment: '' }
]

// 桩要点：
// - dbClientOp 只回答这次要用的几个 op；语句里含 boom 的一律 reject（错误条判据）
// - AIchat 按 stream 参数分岔：非流式（弹层）回 { response }，流式（面板）回
//   { isStream, sessionId }，内容由 getStreamContent 给
// - 每次 AIchat 都记下 args，判据直接比"发出去的提示词长什么样"
const FIXTURE = `
(() => {
  const F = String.fromCharCode(96, 96, 96)
  const NL = String.fromCharCode(10)
  const COLS = ${JSON.stringify(COLS)}
  const rows = []
  for (let i = 1; i <= 5; i++) {
    rows.push({ id: i, note: 'note-' + i, tag: 'common', upper: 'user', nullable: 'v' })
  }
  window.__dbStubCalls = []
  // 计数器与探针访问器分开命名：同名会让"函数 + 1"把计数变成字符串，
  // 之后所有 > / === 判据都静默失效
  window.__execSeq = 0
  window.__aiSeq = 0
  window.__aiCalls = []
  // 弹层（非流式）与面板（流式）的回复分开给，判据能认出是哪条链路
  window.__aiReply = 'Sure:' + NL + F + 'sql' + NL + 'SELECT id FROM typed_tbl LIMIT 10;' + NL + F
  window.__streamReply = 'Look:' + NL + F + 'sql' + NL + 'SELECT tag FROM typed_tbl WHERE id = 3;' + NL + F

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
      return Promise.resolve({ ok: true })
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(null)
    }
    if (name === 'AIchat') {
      window.__aiSeq = window.__aiSeq + 1
      // 参数位次（runGlobalAsync 已吃掉第一个"方法名"）：
      // 0 prompt / 1 model / 2 role / 3 baseURL / 4 apiPath / 5 apiKey / 6 proxy
      // / 7 stream / 8 authHeaderName / 9 messages —— 流式判 stream，别拿 authHeader 当它
      window.__aiCalls.push({
        n: window.__aiSeq,
        prompt: String(a[0] || ''),
        role: String(a[2] || ''),
        stream: a[7] === true
      })
      if (a[7] === true) {
        return Promise.resolve({ isStream: true, sessionId: 'stub-stream', content: '' })
      }
      return Promise.resolve({ response: window.__aiReply })
    }
    if (name === 'getStreamContent') {
      return Promise.resolve({ content: String(window.__streamReply || ''), hasMore: false })
    }
    if (name !== 'dbClientOp') {
      return Promise.resolve(null)
    }
    const op = a[1]
    const args = a[2] || {}
    window.__dbStubCalls.push(op)
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [{ name: 'typed_tbl', type: 'table' }, { name: 'other_tbl', type: 'table' }]
      }])
    }
    if (op === 'executeSql') {
      window.__execSeq = window.__execSeq + 1
      if (String(args.sql || '').indexOf('boom') >= 0) {
        return Promise.reject(new Error('You have an error in your SQL syntax near boom'))
      }
      return Promise.resolve({
        results: [{
          sql: args.sql,
          fields: COLS.map(c => c.name),
          columns: COLS.map(c => ({ name: c.name, type: c.type })),
          rows
        }],
        elapsedMs: 42
      })
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: COLS.map(c => ({
          name: c.name,
          dataType: c.type,
          nullable: c.nullable,
          isPrimaryKey: !!c.isPk,
          defaultValue: null,
          comment: c.comment
        })),
        foreignKeys: []
      })
    }
    if (op === 'describeTable') {
      return Promise.resolve(COLS.map(c => ({
        Field: c.name, Type: c.type, Null: 'YES', Key: '', Default: null, Extra: '', Comment: ''
      })))
    }
    if (op === 'getPageData') {
      return Promise.resolve({ rows, totalRows: rows.length, page: 1, hasMore: false })
    }
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__b1ai = 'stub'
  return 'stub-installed'
})()
`

// 专项探针：按钮一律按图标认（界面语言可能是中或英），文本判据双语兼容
const PROBE = `
(() => {
  const visBy = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  const iconIn = (root, cls) =>
    [...root.querySelectorAll('button')].filter(window.__vis)
      .find(b => b.querySelector('.anticon-' + cls)) || null
  const icName = i => String(i.className).replace(/.*anticon-/, '')
  window.__modal = () => visBy('.db-sql-ai')[0] || null
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
  window.__doc = () => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    return ed ? String(ed.innerText || '') : 'no-editor'
  }
  window.__selText = () => String(window.getSelection && window.getSelection().toString() || '')
  // 编辑器里的一个可点坐标（真鼠标点击才会把 CodeMirror 的选区/焦点放对，
  // 只 .focus() 有时活动元素还在弹层按钮上，随后的 insertText 就落不到 doc 里）
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
  // 点不进去时的现场：编辑器矩形、命中的元素、活动元素、弹层是否还开着
  // （判据只说"没焦点"没用，得能一眼看出是谁挡住了）
  window.__edDiag = () => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    if (!ed) return 'no-editor'
    const r = ed.getBoundingClientRect()
    const p = JSON.parse(window.__edXY())
    const hit = document.elementFromPoint(p.x, p.y)
    return JSON.stringify({
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      point: p,
      hit: hit ? (String(hit.className) || hit.tagName) : 'none',
      same: hit === ed,
      active: String((document.activeElement && document.activeElement.className) || ''),
      modal: !!window.__modal(),
      wraps: [...document.querySelectorAll('.ant-modal-wrap')].map(w => getComputedStyle(w).display)
    })
  }
  // 文本节点里找第 n 个词的屏幕坐标（双击选词用；不依赖 CodeMirror 内部句柄）
  window.__wordXY = (word, nth) => {
    const ed = visBy('.db-sql-area .cm-content')[0]
    if (!ed) return 'no-editor'
    let seen = 0
    const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) {
      const t = String(node.nodeValue || '')
      let i = t.indexOf(word)
      while (i >= 0) {
        seen = seen + 1
        if (seen === (nth || 1)) {
          const r = document.createRange()
          r.setStart(node, i)
          r.setEnd(node, i + word.length)
          const box = r.getBoundingClientRect()
          return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) })
        }
        i = t.indexOf(word, i + word.length)
      }
    }
    return 'no-word'
  }
  // React 受控输入：必须走原生 setter + input 事件，直接改 value 不会被认
  window.__setInput = (sel, text) => {
    const el = visBy(sel)[0]
    if (!el) return 'no-input'
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, String(text))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__chips = () => {
    const m = window.__modal()
    const w = m && m.querySelector('.db-sql-ai-chips')
    return w ? [...w.querySelectorAll('.ant-tag')].map(x => String(x.innerText).trim()).join('|') : 'no-chips'
  }
  window.__src = () => {
    const m = window.__modal()
    const p = m && m.querySelector('.db-sql-ai-source')
    return p ? String(p.innerText) : 'no-src'
  }
  window.__preview = () => {
    const m = window.__modal()
    const p = m && m.querySelector('.db-sql-ai-pre')
    return p ? String(p.innerText) : 'no-preview'
  }
  window.__riskTag = () => {
    const m = window.__modal()
    const h = m && m.querySelector('.db-sql-ai-head')
    const t = h && h.querySelector('.ant-tag')
    return t ? String(t.innerText).trim() : 'no-risk'
  }
  // footer 的按钮：发请求那颗按图标认（文案随模式变：生成/重新生成/优化/修复），
  // 插入/取消按文案认（正则由 node 侧传进来）
  window.__clickRun = () => {
    const f = visBy('.db-sql-ai-footer')[0]
    if (!f) return 'no-footer'
    const i = f.querySelector('.anticon-robot')
    if (!i) return 'no-robot'
    const b = i.closest('button')
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__clickDlgBtn = reStr => {
    const f = visBy('.db-sql-ai-footer')[0]
    if (!f) return 'no-footer'
    const re = new RegExp(reStr, 'i')
    // antd 给"恰好两个汉字"的按钮插空格（取 消 / 复 制 / 生 成），
    // 文案判据一律先去空白再比，否则中英双语 + 两字词会双双落空
    const b = [...f.querySelectorAll('button')].find(x => re.test(String(x.innerText).replace(/\\s+/g, '')))
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__pickStrategy = i => {
    const m = window.__modal()
    const w = m && m.querySelector('.db-sql-ai-strategy')
    const items = w ? [...w.querySelectorAll('.ant-segmented-item')] : []
    if (!items[i]) return 'missing'
    items[i].click()
    return 'ok'
  }
  window.__toast = () => {
    // 项目自有的 message-item 与 antd 静态 message 两种都可能：判据只看"用户看得见的那句"
    const list = [...visBy('.message-item'), ...visBy('.ant-message-notice-content')]
    return list.length ? String(list[list.length - 1].innerText).replace(/\\s+/g, ' ').trim() : ''
  }
  window.__errActionIcons = () => {
    const w = visBy('.db-sql-error-actions')[0]
    if (!w) return 'no-error-actions'
    return [...w.querySelectorAll('.anticon')].map(icName).join('|')
  }
  window.__clickErrAction = cls => {
    const w = visBy('.db-sql-error-actions')[0]
    const b = w && w.querySelector('.anticon-' + cls)
    if (!b) return 'missing'
    b.closest('button').click()
    return 'ok'
  }
  // 对话里每个代码块的动作图标（一块一串，判据按"有没有 import / 有没有 play"来比）
  window.__blocksActs = () => JSON.stringify(visBy('.ai-history-wrap .code-block-actions')
    .map(b => [...b.querySelectorAll('.anticon')].map(icName).join('|')))
  window.__entryPrompts = () => JSON.stringify(
    (window.store.aiChatHistory || []).map(h => String(h.prompt || ''))
  )
  window.__aiN = () => Number(window.__aiSeq)
  window.__execN = () => Number(window.__execSeq)
  window.__lastAiCall = () => JSON.stringify(window.__aiCalls.slice(-1)[0] || {})
  window.__stubAlive = () => !!(window.pre && window.pre.__b1ai === 'stub')
  return 'ai-probe'
})()
`

// 双语兼容的文案判据（界面语言取决于跑起来的实例配置）
const RE = {
  inserted: '已插入编辑器，未执行|Inserted into the editor',
  insertedAll: '已替换编辑器内容，未执行|Editor content replaced',
  needInstruction: '请先写下你的需求|Type what you need first',
  noTarget: '请先切到数据库会话页|Open a database session tab',
  cancel: '取消|cancel',
  insert: '插入编辑器|Insert into editor',
  generate: '生成|Generate'
}

const hits = re => new RegExp(String(re), 'i')

let cdpRef = null
const all = []
const push = (name, ok, detail) => {
  all.push({ name, ok: !!ok })
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name +
    (ok ? '' : ' :: ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500)))
  return !!ok
}

// 关弹层（footer 的取消按钮）；只是收尾，不参与判定
// 走 __clickDlgBtn：它对"两字按钮被插空格"（取 消）已经做了归一化
const closeDialog = cdp => cdp.eval('window.__clickDlgBtn(' + JSON.stringify(RE.cancel) + ')')

// 填附加要求 → 点生成 → 等预览到位；把这次 AIchat 的实参交回给判据
const generateInDialog = async (cdp, instruction) => {
  const before = Number(await cdp.eval('window.__aiN()'))
  if (instruction !== null) {
    const set = await cdp.eval('window.__setInput(".db-sql-ai textarea", ' + JSON.stringify(instruction) + ')')
    if (set !== 'ok') {
      return { ok: false, why: 'set-input:' + set }
    }
  }
  // 按钮文案按模式变（生成/修复/优化），认图标不认字
  const clicked = await cdp.eval('window.__clickRun()')
  if (clicked !== 'ok') {
    return { ok: false, why: 'click:' + clicked }
  }
  const fired = await waitFor(cdp, 'window.__aiN() > ' + before, 'AIchat', 8000)
  const call = JSON.parse(await cdp.eval('window.__lastAiCall()'))
  const previewed = await waitFor(cdp, 'window.__preview() !== "no-preview"', 'preview', 6000)
  return { ok: fired && previewed, call }
}

// 真鼠标点进编辑器：只有真实点击才会把 CodeMirror 的焦点与选区放对。
// 一次不中就重来（上限 3 次）：弹层关闭后 .ant-modal-wrap 的淡出还在原位时，
// 点击会被遮罩吃掉 —— 实测过一次落空，后面"撤销 / 选区 / 执行失败"三条一起红，
// 看着像产品缺陷，其实断的是用例自己的前置
const focusEditor = async cdp => {
  let ok = false
  for (let i = 0; i < 3 && ok !== true; i++) {
    if (i) await sleep(300)
    const raw = await cdp.eval('window.__edXY()')
    // 'no-editor'（编辑器还没挂载 / 页签已关）时 JSON.parse 会抛，把整轮结果一起带走
    if (String(raw).charAt(0) !== '{') continue
    const p = JSON.parse(raw)
    await cdp.click(p.x, p.y)
    await sleep(200)
    ok = await cdp.eval('window.__edFocused()')
  }
  return ok
}

// 全选编辑器内容（随后 insertText 就是整篇替换，doc 起点确定）
const selectAllEditor = async cdp => {
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
  await sleep(150)
}

const clickFirstImportIcon = cdp => cdp.eval(`(() => {
  const list = [...document.querySelectorAll('.ai-history-wrap .code-block-actions')].filter(window.__vis)
  const icon = list.map(b => b.querySelector('.anticon-import')).find(x => x)
  if (!icon) return 'no-import-icon'
  icon.closest('.code-action-icon').click()
  return 'ok'
})()`)

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
  await cdp.call('Log.enable')
  // 关缓存再刷：db-session 是懒加载 chunk，文件服务只给协商缓存（no-cache + ETag），
  // 但 Chrome 仍可能把上一个构建的同名 chunk 直接吐回来。于是这一跑量的是旧代码，
  // 现象是页签区一片空白 + 一条只剩 minified 帧的 useMemo TypeError，
  // 判据全退化成"找不到弹层"——看着像功能坏了，其实测的根本不是这次的构建。
  await cdp.call('Network.enable')
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('重启后渲染进程可用（store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

  // 桩必须在 boot 之后装：pre.js 整对象赋值 window.pre，装早了会被冲掉，
  // 于是页签真的去连 127.0.0.1:3306（ECONNREFUSED），判据全退化成"找不到弹层"
  let installed = false
  for (let i = 0; i < 10 && !installed; i++) {
    if (await cdp.eval('!!(window.pre && window.pre.__b1ai === "stub")')) {
      installed = true
      break
    }
    await cdp.eval(FIXTURE)
    await sleep(300)
    installed = !!(await cdp.eval('window.__stubAlive && window.__stubAlive()'))
  }
  push('桩装上（dbClientOp / AIchat / getStreamContent 全由桩应答）', installed)

  await cdp.eval(buildHelpers('electerm-db-sql-value-split'))
  await sleep(300)
  await cdp.eval(PROBE)
  push('探针装上（弹层/工具条/编辑器/错误条四类都探得到）',
    await cdp.eval('!!(window.__modal && window.__clickBarBtn && window.__doc && window.__toast)'))

  const meta = JSON.parse(await cdp.eval(
    "(async () => JSON.stringify(await window.pre.runGlobalAsync('dbClientOp','t','getMetadata',{hideSystemSchemas:false})))()"
  ))
  push('桩真的接住 dbClientOp（回的是 demo_db，不是 ECONNREFUSED）',
    Array.isArray(meta) && !!meta[0] && meta[0].name === 'demo_db', meta)

  await cdp.eval('window.store.setConfig({ modelAI: "stub-model", baseURLAI: "http://127.0.0.1:9/v1", apiKeyAI: "stub-key", languageAI: "中文" })')
  await sleep(300)
  push('AI 配置就绪（aiConfigMissing 为假，点生成不会跳去设置页）',
    (await cdp.eval('window.store.aiConfigMissing()')) === false)

  const words = JSON.parse(await cdp.eval(
    'JSON.stringify([window.translate("dbAiInsert"), window.translate("dbAiInserted"), window.translate("dbAiGen")])'
  ))
  push('词条双语落地（插入/已插入/生成三条都不是 key 本身）',
    words.every(w => w && !/^dbAi/.test(w)), words)

  // ---------- 打开数据库页签与 SQL 页 ----------
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /demo_db/.test(String(t.dbName))).map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) {
    await sleep(500)
  }
  push('开页签前桩仍在位', await cdp.eval('window.__stubAlive()'))
  await cdp.eval(`(() => {
    window.store.addTab(${JSON.stringify(MYSQL_TAB)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  push('数据库页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  // 页签一开就会懒加载 db-session chunk；把浏览器真正用上的文件名对回磁盘，
  // 能一眼看出这跑的是本次构建还是缓存里的上一份（判据失败时先查这里）
  const chunks = JSON.parse(await cdp.eval(
    "JSON.stringify(performance.getEntriesByType('resource').map(r => r.name).filter(n => n.indexOf('db-session-') >= 0).map(n => n.split('/').pop()))"
  ))
  const staleChunks = chunks.filter(n => !fs.existsSync(path.join(__dirname, '..', 'work', 'app', 'assets', 'chunk', n)))
  push('加载的 db-session chunk 在磁盘上（测的是本次构建，不是缓存副本）',
    chunks.length > 0 && staleChunks.length === 0, { chunks, staleChunks })
  push('展开库并选中 typed_tbl（列结构进缓存，弹层才有 5 cols 芯片）',
    await cdp.eval('window.__clickTree("demo_db")') === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node') &&
    await cdp.eval('window.__clickTree("typed_tbl")') === 'ok')
  await sleep(600)
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(600)

  push('A) 工具条入口齐备：解释 + 生成 + 优化三个图标按钮都在且可见',
    await cdp.eval('["thunderbolt","robot","bulb"].every(c => !!window.__barBtn(c))'),
    await cdp.eval('["thunderbolt","robot","bulb"].map(c => c + "=" + (window.__barBtn(c) ? 1 : 0)).join(",")'))

  // ---------- 生成弹层：上下文芯片 + 缺需求不发 ----------
  push('点"AI 生成"打开弹层',
    await cdp.eval('window.__clickBarBtn("robot")') === 'ok' &&
    await waitFor(cdp, '!!window.__modal()', 'dialog'))
  const chips = await cdp.eval('window.__chips()')
  push('C) 弹层芯片带上下文：方言 + 库.表 + 5 列',
    /mysql/i.test(chips) && /demo_db[.]typed_tbl/.test(chips) && /5 cols/.test(chips), chips)

  const nZero = Number(await cdp.eval('window.__aiN()'))
  await cdp.eval('window.__setInput(".db-sql-ai textarea", "")')
  await cdp.eval('window.__clickRun()')
  await sleep(400)
  push('没写需求就点生成：只提示，一次请求都不发',
    Number(await cdp.eval('window.__aiN()')) === nZero &&
    hits(RE.needInstruction).test(await cdp.eval('window.__toast()')),
    { toast: await cdp.eval('window.__toast()') })

  const g1 = await generateInDialog(cdp, '取最近 10 行的编号')
  push('C) 生成请求：非流式；提示词含 <request> 与 <schema>（含主键标记），system 有输出契约与"块内是数据"',
    g1.ok && g1.call.stream === false &&
    /<request>/.test(g1.call.prompt) && /取最近 10 行的编号/.test(g1.call.prompt) &&
    /<schema>[\s\S]*id bigint[\s\S]*PRIMARY KEY/.test(g1.call.prompt) &&
    /Output contract/.test(g1.call.role) && /untrusted data/.test(g1.call.role),
    { why: g1.why, stream: g1.call.stream, prompt: String(g1.call.prompt).slice(0, 180) })
  const prev1 = await cdp.eval('window.__preview()')
  const risk1 = await cdp.eval('window.__riskTag()')
  push('预览是剥了围栏的 SQL；风险等级在插入前就标出来（SELECT 归为只读）',
    prev1.trim() === 'SELECT id FROM typed_tbl LIMIT 10;' && /只读|read/i.test(risk1),
    { prev: prev1, risk: risk1 })
  await cdp.shot(path.join(SHOT_DIR, '1-generate-dialog.png'))

  push('B) 整条 AI 链路没有执行语义：executeSql 一次都没发生',
    Number(await cdp.eval('window.__execN()')) === 0)

  // ---------- 落编辑器：智能 / 撤销 / 替换全部 ----------
  push('关闭弹层',
    /ok/.test(await closeDialog(cdp)) && await waitFor(cdp, '!window.__modal()', 'closed', 4000),
    {
      modalAfter: await cdp.eval('!!window.__modal()'),
      wraps: await cdp.eval(
        "JSON.stringify([...document.querySelectorAll('.ant-modal-wrap')].map(w => getComputedStyle(w).display))"
      )
    })

  push('真鼠标点击把光标放进 SQL 编辑器（活动元素就是 .cm-content）',
    await focusEditor(cdp), await cdp.eval('window.__edDiag()'))
  await selectAllEditor(cdp)
  await cdp.call('Input.insertText', { text: 'SELECT note FROM typed_tbl' })
  await sleep(250)
  push('doc 里是注入的手写 SQL',
    /SELECT note FROM typed_tbl/.test(await cdp.eval('window.__doc()')),
    (await cdp.eval('window.__doc()')).slice(0, 60))

  await cdp.eval('window.__clickBarBtn("robot")')
  await waitFor(cdp, '!!window.__modal()', 'dialog again')
  const g2 = await generateInDialog(cdp, '取最近 10 行的编号')
  push('第二次生成到位（预览可插入）', g2.ok, g2)
  // 手写与插入之间留够 500ms：CodeMirror 的历史按 newGroupDelay 把相邻改动并组，
  // 并了组之后"一次 Ctrl+Z 只撤插入"这条判据就验不出真东西（实测过：桩回复太快，
  // 一次撤销把整篇回到空文档，看着像插入走了整篇回写，其实是两次改动同组）
  await sleep(700)
  const clickedInsert = await cdp.eval('window.__clickDlgBtn(' + JSON.stringify(RE.insert) + ')')
  push('D) 智能策略插入成功',
    clickedInsert === 'ok' && await waitFor(cdp, 'window.__doc().indexOf("LIMIT 10") >= 0', 'inserted', 5000),
    { clicked: clickedInsert })
  const afterInsert = await cdp.eval('window.__doc()')
  push('D) 智能策略没吃掉手写 SQL：原文与产出同在，并提示"未执行"',
    afterInsert.indexOf('SELECT note FROM typed_tbl') >= 0 &&
    afterInsert.indexOf('LIMIT 10') >= 0 &&
    hits(RE.inserted).test(await cdp.eval('window.__toast()')),
    { doc: afterInsert.slice(0, 90), toast: await cdp.eval('window.__toast()') })
  await cdp.shot(path.join(SHOT_DIR, '2-inserted-not-executed.png'))

  const f2ok = await focusEditor(cdp)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', keyCode: 90, modifiers: 2 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', keyCode: 90, modifiers: 2 })
  await sleep(350)
  const undone = await cdp.eval('window.__doc()')
  // 撤不动有两种成因：句柄没走 dispatch（产品缺陷），或按键根本没进编辑器（用例前置塌了）。
  // 把焦点与命中元素一起报出来，否则后面几步会跟着一起红，看不出断在哪
  push('D) Ctrl+Z 能撤回这次插入（句柄走 dispatch，不是整篇回写 state）',
    f2ok === true && undone.indexOf('LIMIT 10') < 0 && /SELECT note FROM typed_tbl/.test(undone),
    { doc: undone.slice(0, 60), focused: f2ok, diag: await cdp.eval('window.__edDiag()') })

  // ---------- 选区优先：双击选词后开"AI 优化" ----------
  const xy = JSON.parse(await cdp.eval('window.__wordXY("typed_tbl", 1)'))
  await cdp.click(xy.x, xy.y)
  await sleep(150)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: xy.x, y: xy.y, button: 'left', clickCount: 2, buttons: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xy.x, y: xy.y, button: 'left', clickCount: 2, buttons: 0 })
  await sleep(300)
  push('双击选中一个词（DOM 选区真的存在）',
    /typed_tbl/.test(await cdp.eval('window.__selText()')),
    { sel: await cdp.eval('window.__selText()'), diag: await cdp.eval('window.__edDiag()') })
  await cdp.eval('window.__clickBarBtn("bulb")')
  await waitFor(cdp, '!!window.__modal()', 'optimize dialog')
  const srcOpt = await cdp.eval('window.__src()')
  push('C) 优化模式带的是选区而不是整篇', srcOpt.trim() === 'typed_tbl', srcOpt)
  const g3 = await generateInDialog(cdp, '改成走索引的写法')
  push('C) 附加要求真的进提示词：<sql_text> + <user_note> 同在（填了不等于没填）',
    g3.ok && /<sql_text>[\s\S]*typed_tbl[\s\S]*<\/sql_text>/.test(g3.call.prompt) &&
    /<user_note>[\s\S]*改成走索引的写法[\s\S]*<\/user_note>/.test(g3.call.prompt),
    { why: g3.why, prompt: String(g3.call.prompt).slice(0, 200) })
  await cdp.shot(path.join(SHOT_DIR, '3-optimize-selection.png'))

  push('D) 切到"替换全部"策略', await cdp.eval('window.__pickStrategy(2)') === 'ok')
  await cdp.eval('window.__clickDlgBtn(' + JSON.stringify(RE.insert) + ')')
  push('D) 替换全部确实只剩 AI 产出，并提示"已替换"',
    await waitFor(cdp, 'window.__doc().indexOf("LIMIT 10") >= 0', 'replaced', 5000) &&
    /LIMIT 10/.test(await cdp.eval('window.__doc()')) &&
    (await cdp.eval('window.__doc()')).indexOf('SELECT note FROM typed_tbl') < 0 &&
    hits(RE.insertedAll).test(await cdp.eval('window.__toast()')),
    { doc: (await cdp.eval('window.__doc()')).slice(0, 60), toast: await cdp.eval('window.__toast()') })
  await closeDialog(cdp)
  await sleep(300)

  // ---------- 错误条：复制 + AI 修复（修复要带 <error>） ----------
  await focusEditor(cdp)
  await selectAllEditor(cdp)
  await cdp.call('Input.insertText', { text: 'SELECT boom FROM typed_tbl' })
  await sleep(200)
  // 「执行一条会失败的语句」是这一组用例的前置：insertText 落空（焦点不在编辑器）时
  // 跑的是上一条能成功的 SQL，错误条自然不出现——那会让后面三条一起红
  push('把会失败的语句写进 doc（错误条用例的前置）',
    /boom/.test(await cdp.eval('window.__doc()')),
    { doc: (await cdp.eval('window.__doc()')).slice(0, 60), diag: await cdp.eval('window.__edDiag()') })
  await cdp.eval('window.__clickRunSql()')
  push('A) 执行失败后错误条出现，且带两个动作（复制原文 / AI 修复）',
    await waitFor(cdp, '/copy/.test(window.__errActionIcons()) && /bug/.test(window.__errActionIcons())', 'error actions', 8000),
    await cdp.eval('window.__errActionIcons()'))
  await cdp.shot(path.join(SHOT_DIR, '4-error-actions.png'))

  push('E) 错误条的"AI 修复"打开修复弹层：源语句与错误原文都在',
    await cdp.eval('window.__clickErrAction("bug")') === 'ok' &&
    await waitFor(cdp, '!!window.__modal()', 'fix dialog') &&
    /boom/.test(await cdp.eval('window.__src()')) &&
    await cdp.eval('!!([...document.querySelectorAll(".ant-alert-error")].filter(window.__vis).find(x => /boom/.test(x.innerText)))'))
  const g4 = await generateInDialog(cdp, null)
  push('C) 修复请求带上错误原文：<error> 块 + system 要求最小改动并标注 -- fix:',
    g4.ok && /<error>[\s\S]*boom[\s\S]*<\/error>/.test(g4.call.prompt) &&
    /smallest possible change/.test(g4.call.role) && /-- fix:/.test(g4.call.role),
    { why: g4.why, prompt: String(g4.call.prompt).slice(0, 200) })
  await cdp.shot(path.join(SHOT_DIR, '5-fix-dialog.png'))
  await closeDialog(cdp)
  await sleep(300)

  // ---------- 解释入口改走 pendingAiPrompt ----------
  const nHist = JSON.parse(await cdp.eval('(window.store.aiChatHistory || []).length'))
  const t0 = Date.now()
  const clickedExplain = await cdp.eval('window.__clickBarBtn("thunderbolt")')
  const appeared = await waitFor(cdp, '(window.store.aiChatHistory || []).length > ' + nHist, 'explain entry', 4000)
  const ms = Date.now() - t0
  const consumed = await cdp.eval('window.store.pendingAiPrompt === null')
  const openedPanel = await cdp.eval('window.store.rightPanelTab === "ai"')
  const prompts = JSON.parse(await cdp.eval('window.__entryPrompts()'))
  const lastPrompt = String(prompts[prompts.length - 1] || '')
  push('F) 解释入口：面板自动打开、递交被消费成一次真实条目（' + ms + 'ms）',
    clickedExplain === 'ok' && appeared && consumed && openedPanel,
    { clicked: clickedExplain, appeared, consumed, openedPanel, ms })
  push('F) 解释的句子带方言与库表上下文（不再是硬编码中文那一句）',
    /Explain this MySQL statement/.test(lastPrompt) &&
    (/<schema>/.test(lastPrompt) || /Current database/.test(lastPrompt)) &&
    !/请解释以下 SQL 语句/.test(lastPrompt), lastPrompt.slice(0, 200))

  // ---------- 对话面板里的 SQL 块动作 ----------
  push('E) AI 回复的代码块渲染出来（流式链路由桩供内容）',
    await waitFor(cdp, 'window.__blocksActs().length > 2', 'code block', 8000))
  // 再塞一条 js 块，用来证明非 SQL 块仍保留"在终端运行"
  await cdp.eval(`(() => {
    const F = String.fromCharCode(96, 96, 96)
    const NL = String.fromCharCode(10)
    const sid = window.store.currentChatSessionId
    window.store.aiChatHistory = [...(window.store.aiChatHistory || []), {
      id: 'b1-js-block',
      chatSessionId: sid,
      prompt: '',
      response: 'JS:' + NL + F + 'js' + NL + 'const a = 1' + NL + F,
      pending: false,
      isStreaming: false,
      mode: 'ask'
    }]
    return 'pushed'
  })()`)
  await sleep(800)
  const blocksActs = JSON.parse(await cdp.eval('window.__blocksActs()'))
  push('E) SQL 块给"插入编辑器"（import）且没有"在终端运行"（play-circle）',
    blocksActs.some(a => /import/.test(a) && !/play-circle/.test(a)), blocksActs)
  push('E) 非 SQL 块仍是"在终端运行"，没被顺手改掉',
    blocksActs.some(a => /play-circle/.test(a) && !/import/.test(a)), blocksActs)

  const docBefore = await cdp.eval('window.__doc()')
  const clickedIcon = await clickFirstImportIcon(cdp)
  push('E) 对话里的 SQL 块插入当前会话页编辑器（' + clickedIcon + '）',
    clickedIcon === 'ok' && await waitFor(cdp, 'window.__doc().indexOf("WHERE id = 3") >= 0', 'chat insert', 5000))
  const docAfter = await cdp.eval('window.__doc()')
  push('E) 点击时解析目标：插入不覆盖已有语句、另起一行，并提示"未执行"',
    // 换行由 planSqlInsertion 补：不补就会出现 "typed_tblSELECT tag ..." 这种两句话粘一句
    docAfter.indexOf('WHERE id = 3') >= 0 && docAfter.length > docBefore.length &&
    /\nSELECT tag FROM typed_tbl WHERE id = 3;/.test(docAfter) &&
    hits(RE.inserted).test(await cdp.eval('window.__toast()')),
    { before: docBefore.slice(0, 40), after: docAfter.slice(0, 110) })
  await cdp.shot(path.join(SHOT_DIR, '6-chat-insert.png'))

  // ---------- 没有可用目标时：只警告，不抛 ----------
  const activeId = await cdp.eval('String(window.store.activeTabId)')
  await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(activeId) + ') })()')
  await sleep(900)
  await clickFirstImportIcon(cdp)
  await sleep(700)
  push('E) 会话页关掉后再点插入：给可行动的提示，而不是抛异常',
    hits(RE.noTarget).test(await cdp.eval('window.__toast()')),
    { toast: await cdp.eval('window.__toast()') })

  // 只留"代码坏了"这一类：刷页时旧文档在途的懒加载会被撕掉，
  // Chrome 报的是 TypeError: Failed to fetch dynamically imported module + 404，
  // 那是网络/换页噪声，不是渲染层缺陷（真缺陷长这样：Cannot read / is not a function）
  const netNoise = /Failed to fetch dynamically imported module|Failed to load resource/
  const hard = cdpRef.events.filter(l => {
    const s = String(l)
    return !netNoise.test(s) && /Cannot read|is not a function|TypeError|uncaught|Warning:/.test(s)
  })
  push('G) 渲染层没有新增硬错误（换页撕掉的懒加载不算）', hard.length === 0, hard.slice(0, 6))

  console.log('\nrenderer events (' + cdpRef.events.length + '):')
  cdpRef.events.slice(-20).forEach(l => console.log('  ' + l))

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
