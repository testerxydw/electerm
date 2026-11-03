#!/usr/bin/env node
/**
 * S1-5（§5.7）AI 回复语言注入收口 —— 实机 demo
 *
 * 修前：`;用[${lang}]回复` 这条中文模板串在 4 个落点各抄一遍，界面其余部分却是英文；
 * 修后：一个 src/client/common/ai-role.js 同时决定「用哪种语言」和「这句话怎么写」。
 * 单测量的是纯函数，这里量的是**真的发出去的那句话**：把 window.pre.runGlobalAsync
 * 的 AIchat 包一层，记下每次请求的 role，再从界面点发送，判据直接读实参。
 *
 * 五条链路：
 *   P1 产物：出厂 bundle 里再无中文模板串；'Reply in' 只由 ai-role 一个 chunk 定义，
 *      其余消费方 chunk 全部 import 它（收口是否真的收口）
 *   P2 聊天面板（ask）：roleAI + languageAI 都在 → role = role + '\n' + 语言指令
 *   P3 聊天面板：languageAI 留空 → 回落到界面语言名（和修前一致，只是写法统一）
 *   P4 聊天面板：roleAI 留空 → 不能出现前导换行、'undefined'、';用[]回复' 这类残渣
 *   P5 agent 模式：走 agent.js 自己那条拼装路径，也必须用同一个构造函数
 *
 * 用法：
 *   1) npm run vite-build
 *   2) D=$(mktemp -d /tmp/electerm-lang-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/ai-language-demo.js 9333 [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'ai-language-shots')
const ASSETS = path.join(__dirname, '..', 'work', 'app', 'assets')

// 三种语言互不相同，任一条判据红了都能认出是「没跟随」「回落错」还是「拼接错」
const CFG_LANG = 'Deutsch'
const ROLE = 'Be terse.'

// 只包 AIchat（ask）与 AIchatWithTools（agent），其余原样转给真实现
const STUB = `
(() => {
  if (window.pre && window.pre.__ailang === 'stub') return 'already'
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  window.__aiSeq = 0
  window.__aiCalls = []
  const record = (via, role, msgs, prompt) => {
    window.__aiSeq = window.__aiSeq + 1
    window.__aiCalls.push({
      n: window.__aiSeq, via, prompt: String(prompt || ''), role: String(role || ''),
      msgs: Array.isArray(msgs) ? msgs.map(m => m && m.role) : null
    })
  }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'AIchat') {
      // 参数位次：0 prompt / 1 model / 2 role / 7 stream / 9 messages
      record('ask', a[2], a[9], a[0])
      if (a[7] === true) {
        return Promise.resolve({ isStream: true, sessionId: 'stub-stream-' + window.__aiSeq, content: '' })
      }
      return Promise.resolve({ response: 'stubbed reply' })
    }
    if (name === 'AIchatWithTools') {
      // agent 不走 role 形参：system 提示词就是 messages[0]
      const msgs = Array.isArray(a[0]) ? a[0] : []
      record('agent', (msgs[0] && msgs[0].content) || '', msgs)
      return Promise.resolve({ message: { role: 'assistant', content: 'stubbed agent reply' } })
    }
    if (name === 'getStreamContent') {
      return Promise.resolve({ content: 'stubbed reply', hasMore: false })
    }
    return orig(name, ...a)
  }
  window.pre.__ailang = 'stub'
  return 'stub-installed'
})()
`

const PROBE = `
(() => {
  const vis = el => !!el && !!el.offsetParent
  window.__ta = () => [...document.querySelectorAll('.ai-chat-textarea')].filter(vis)[0] || null
  // 走面板自己的 handleSubmit(text)：DOM 点图标要先让 React 认下草稿文本，
  // 而 handleSubmit 本来就支持把这一句直接递进去（外部递交路径不带面板附件）
  window.__submit = text => {
    const c = window.refsStatic.get('AIChat')
    if (!c || typeof c.handleSubmit !== 'function') return 'no-ai-chat-ref'
    c.handleSubmit(String(text))
    return 'ok'
  }
  window.__panelState = () => JSON.stringify({
    tab: String(window.store.rightPanelTab), vis: !!window.store.rightPanelVisible
  })
  // 幂等开面板：toggleAIPanel 再点一次就是关，判据里"顺手读一次状态"会把面板关掉
  window.__openPanel = () => {
    if (!(window.store.rightPanelTab === 'ai' && window.store.rightPanelVisible)) {
      window.store.toggleAIPanel()
    }
    return window.__panelState()
  }
  window.__closePanel = () => {
    if (window.store.rightPanelTab === 'ai' && window.store.rightPanelVisible) {
      window.store.toggleAIPanel()
    }
    return window.__panelState()
  }
  // 上一轮残留的条目会把 agentRunning 钉在 true，之后的发送全被面板拦下
  window.__reset = mode => {
    localStorage.setItem('ai-chat-mode', mode)
    window.store.aiChatHistory = []
    window.store.agentRunning = false
    return mode
  }
  window.__aiN = () => Number(window.__aiSeq || 0)
  window.__lastCall = () => JSON.stringify(window.__aiCalls.slice(-1)[0] || {})
  window.__langName = () => String(window.store.getLangName())
  window.__mode = () => String(localStorage.getItem('ai-chat-mode') || '')
  return 'probe-installed'
})()
`

const { results, check: ck } = makeChecker()

// 发送 → 等 AIchat 真的带上了实参 → 把这次请求的 role 取回来
const sendOnce = async (cdp, text) => {
  const before = Number(await cdp.eval('window.__aiN()'))
  const sent = await cdp.eval('window.__submit(' + JSON.stringify(text) + ')')
  if (sent !== 'ok') {
    return { ok: false, why: 'submit:' + sent }
  }
  const fired = await waitFor(cdp, 'window.__aiN() > ' + before, 'AIchat', 12000)
  if (!fired) {
    return { ok: false, why: 'no-AIchat' }
  }
  await sleep(250)
  return { ok: true, call: JSON.parse(await cdp.eval('window.__lastCall()')) }
}

// 配置进的是 React props：写完立刻发，面板拿到的还是上一次的语言（实测过一次假通过）
const setCfg = async (cdp, cfg) => {
  await cdp.eval('window.store.setConfig(' + JSON.stringify(cfg) + ')')
  await sleep(450)
}

const main = async () => {
  if (!fs.existsSync(path.join(ASSETS, 'index.html'))) {
    throw new Error('没有出厂产物（先 npm run vite-build）：' + ASSETS)
  }

  // ---------- P1：产物层面真的收口了 ----------
  const js = []
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.js')) js.push({ file: p, src: fs.readFileSync(p, 'utf8') })
    }
  }
  walk(ASSETS)
  const retired = js.filter(j => /;用\[|回复\]/.test(j.src)).map(j => path.basename(j.file))
  ck('P1a 出厂 bundle 里再无 ";用[x]回复" 中文模板串', retired.length === 0, retired)

  const definers = js.filter(j => /Reply in \$\{|['"`]Reply in /.test(j.src))
  ck('P1b "Reply in …" 只由一个 chunk 定义（措辞不再各写一份）',
    definers.length === 1, definers.map(d => path.basename(d.file)))
  // 引用判据要用带 hash 的文件名（chunk 之间按 ./ai-role-5.8.1-XXXX.js 互相 import）
  const defName = definers.length === 1 ? path.basename(definers[0].file) : ''
  const importers = js
    .filter(j => path.basename(j.file) !== defName && j.src.includes(defName))
    .map(j => path.basename(j.file))
  ck('P1c ≥6 个消费方 chunk 引用同一个 ai-role（聊天/agent/压缩/SQL/快捷命令/主题/书签）',
    !!defName && importers.length >= 6, { defName, count: importers.length, importers: importers.slice(0, 12) })

  // ---------- 起实例 ----------
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('没有渲染进程目标；用 --remote-debugging-port 启动实例')
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Network.enable')
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  // 刷页拿本次构建的 chunk：懒加载面板不刷就还是上一版代码
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  const booted = await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000)
  const bootEvents = cdp.events.filter(e => e.startsWith('EX '))
  ck('P1d 重刷后渲染进程可用且无未捕获异常（新 import 全解析得到）',
    booted === true && bootEvents.length === 0, { booted, bootEvents })

  let installed = false
  for (let i = 0; i < 10 && !installed; i++) {
    await cdp.eval(STUB)
    await sleep(300)
    installed = !!(await cdp.eval('!!(window.pre && window.pre.__ailang === "stub")'))
  }
  ck('桩装上（AIchat 实参被记录，其余调用原样转发）', installed === true)
  await cdp.eval(PROBE)
  // 干净起点：ask 模式 + 空历史 —— 上一轮遗留的条目会让面板以为 agent 还在跑，把每条发送都拦下
  await cdp.eval("window.__reset('ask')")
  await cdp.eval('window.__closePanel()')
  await sleep(400)

  const uiLang = String(await cdp.eval('window.__langName()'))
  ck('界面语言可取（回落到它时判据认得具体名字）', uiLang.length > 0, { uiLang })

  await setCfg(cdp, {
    modelAI: 'stub-model',
    baseURLAI: 'http://127.0.0.1:9/v1',
    apiKeyAI: 'stub-key',
    roleAI: ROLE,
    languageAI: CFG_LANG
  })
  ck('AI 配置就绪（aiConfigMissing 为假，点发送不会跳设置页）',
    (await cdp.eval('window.store.aiConfigMissing()')) === false)

  await cdp.eval('window.__openPanel()')
  const panel = await waitFor(cdp, '!!window.__ta()', 'AI 面板输入框', 20000)
  ck('AI 聊天面板打开（输入框在 DOM 里可见）', panel === true, await cdp.jeval('window.__openPanel()'))

  // ---------- P2：配了语言 → 跟随配置 ----------
  const roleOf = r => String((r.call || {}).role || '')
  const tailOf = r => roleOf(r).trim().split('\n').pop()
  const r2 = await sendOnce(cdp, 'demo: role + language both set')
  ck('P2a 发出的 system role 带上了 roleAI 原文',
    r2.ok === true && roleOf(r2).startsWith(ROLE), r2)
  ck('P2b 语言指令用统一措辞 "Reply in Deutsch language"（不再是中文模板）',
    tailOf(r2) === 'Reply in ' + CFG_LANG + ' language', { tail: tailOf(r2) })
  ck('P2c role 里没有中文模板串残渣', !/用\[|回复\]/.test(roleOf(r2)), { role: roleOf(r2) })
  ck('P2d 同一次请求的 messages 以 system 打头（语言指令确实进的是 system 层）',
    Array.isArray((r2.call || {}).msgs) && r2.call.msgs[0] === 'system', { msgs: (r2.call || {}).msgs })
  await cdp.shot(path.join(SHOT_DIR, '01-panel-configured-language.png'))

  // ---------- P3：languageAI 留空 → 回落到界面语言（不重挂面板，改完直接发） ----------
  await setCfg(cdp, { languageAI: '' })
  const r3 = await sendOnce(cdp, 'demo: language falls back to UI language')
  ck('P3 languageAI 留空时回落到界面语言名（行为与修前一致，写法统一）',
    tailOf(r3) === 'Reply in ' + uiLang + ' language', { uiLang, tail: tailOf(r3) })

  // ---------- P4：roleAI 留空 → 没有拼接残渣 ----------
  await setCfg(cdp, { roleAI: '', languageAI: CFG_LANG })
  const r4 = await sendOnce(cdp, 'demo: empty roleAI')
  ck('P4a roleAI 为空时 role 就是语言指令本身（无前导换行）',
    roleOf(r4) === 'Reply in ' + CFG_LANG + ' language', { role: roleOf(r4) })
  ck('P4b 全空配置不再产出 ";用[]回复" / undefined 这类脏串',
    roleOf(r4).length > 0 && !/undefined|用\[/.test(roleOf(r4)), { role: roleOf(r4) })

  await cdp.shot(path.join(SHOT_DIR, '02-panel-empty-role.png'))

  // ---------- P5：agent 模式自己那条拼装路径 ----------
  await setCfg(cdp, { roleAI: ROLE, languageAI: CFG_LANG })
  await cdp.eval("window.__reset('agent')")
  // agent 要有可操作的页签，否则它压根不发第一次请求
  await cdp.eval(`(() => {
    const tabs = (window.store.tabs || []).filter(t => t.type === 'local')
    if (!tabs.length) return window.store.addTab({ type: 'local', title: 'ai-lang-probe' })
    window.store.changeActiveTabId(tabs[0].id)
    return null
  })()`)
  const tabReady = await waitFor(
    cdp,
    "(window.store.tabs || []).some(t => t.type === 'local' && t.status === 'success')",
    '本地页签', 30000)
  ck('agent 判据的本地页签就位', tabReady === true)
  await cdp.eval('window.__closePanel()')
  await sleep(400)
  await cdp.eval('window.__openPanel()')
  const remount = await waitFor(cdp, '!!window.__ta()', '面板重挂（agent 模式）', 15000)
  ck('面板切到 agent 模式后重挂成功', remount === true, await cdp.jeval('window.__panelState()'))
  const r5 = await sendOnce(cdp, 'demo: agent mode system prompt')
  ck('P5a 走的是 agent 那条请求（AIchatWithTools），不是 ask 的复用',
    (r5.call || {}).via === 'agent', { send: r5 })
  // agent 的 system prompt 由 buildAgentSystemPrompt 拼，基座是 roleAI，末尾跟语言指令
  ck('P5b agent 模式的 system prompt 也带同一句语言指令（两条链路一个出处）',
    /^Reply in Deutsch language\.?$/.test(tailOf(r5)), { tail: tailOf(r5) })
  ck('P5c agent 的 system prompt 仍以 roleAI 为基座（语言指令是追加，不是替换）',
    roleOf(r5).startsWith(ROLE), { head: roleOf(r5).slice(0, 60) })
  await cdp.shot(path.join(SHOT_DIR, '03-agent-mode.png'))

  const fails = results.filter(r => !r.ok)
  console.log((results.length - fails.length) + '/' + results.length + ' PASS')
  if (fails.length) {
    console.log('FAILED: ' + fails.map(f => f.name).join(' | '))
    console.log('renderer log: ' + cdp.tail(10).join(' ;; '))
  }
  cdp.ws.close()
  process.exit(fails.length ? 1 : 0)
}

main().catch(e => {
  console.error('DEMO ERROR: ' + (e && e.message))
  process.exit(1)
})
