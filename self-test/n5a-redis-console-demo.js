#!/usr/bin/env node
/**
 * N5a Redis 命令控制台 —— CDP 实机全链路验收（真 Electron + 真 ioredis + 假 RESP2 服务端）
 *
 * 为什么不能用渲染层桩：本批的验收判据是「**控制台写命令在只读下被主进程拦截**」。
 * 桩掉 window.pre.runGlobalAsync 就等于把被验的那一半（redis-command-policy /
 * redis-console / dbClientOp 的权威只读位注入）整个换成了测试自己写的答复。
 * 所以这里与 n11b 同一路数：self-test/fake-redis.js 起 RESP2 服务端，让真的
 * ioredis 连上来，命令是否发出、发了几条、键有没有真的被改，都在同进程对账。
 *
 * 假服务端这一轮补了 COMMAND 自述表（只读判定的权威来源）与 ECHO。表里故意留着
 * 三类反直觉条目：keys 自述 readonly（名字类黑名单必须先于 flags）、ping/info/
 * slowlog 没有 readonly 却不写（只读下应放行）、publish/eval 不是 write 却带
 * may-replicate（只读下应拦）。LOLWUT 不在表里也不在实现里 —— 可写模式下真发出去
 * 拿回 -ERR，验「服务端错误回复画进历史」这条路。
 *
 * 用法：
 *   1) npm run compile（改了 src 才需要）
 *   2) mkdir -p /tmp/electerm-n5a/{home,tmp}
 *      Xvfb :139 -screen 0 1680x1050x24 &   # 不要用带 -auth 的 :99，会报 Authorization required
 *      env -u ELECTRON_RUN_AS_NODE DISPLAY=:139 \
 *        HOME=/tmp/electerm-n5a/home TMPDIR=/tmp/electerm-n5a/tmp \
 *        DISABLE_GPU=1 DISABLE_GPU_SANDBOX=1 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9391 --no-sandbox --disable-gpu-sandbox \
 *        --in-process-gpu --window-size=1680,1050
 *      # 必须用后台任务/受控方式启动：直接 `&` 起的进程会随起它的 shell 一起被杀
 *      # 9389 是并行会话的实例，别碰
 *   3) node self-test/n5a-redis-console-demo.js [cdpPort] [shotDir] [redisPort]
 *   4) pkill -f "remote-debugging-port=9391"
 */
const fs = require('node:fs')
const path = require('node:path')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9391'
const SHOT_DIR = process.argv[3] || path.join(__dirname, '2026-11-09-n5a-shots')
const REDIS_PORT = Number(process.argv[4]) || 6391
const TITLE = `redis 127.0.0.1:${REDIS_PORT}`
const J = s => JSON.stringify(s)
const FIXTURE_TOTAL = 64

// 页内探针：只做「找 / 点 / 读」，判据留在 Node 侧。
// 键盘不在这里造事件：Esc/Enter 要经过 rc-dialog 的 keyCode 判定，
// 用 CDP Input.dispatchKeyEvent 发可信事件才与用户按键同一条路。
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
  window.__kids = (el, sel) => [...el.querySelectorAll(sel)].filter(window.__vis)
  window.__q = sel => document.querySelectorAll(sel).length
  window.__head = () => {
    const el = window.__all('.db-head-target')[0]
    return el ? window.__txt(el) : ''
  }
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  window.__fill = (sel, val) => {
    let el = document.querySelector(sel)
    if (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el = el.querySelector('input, textarea')
    }
    if (!el) return 'no-input:' + sel
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(val))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__redisRowCount = () => window.__all('.db-redis-keys .ant-table-row').length

  // ---- 入口 / 弹层 ----
  // 入口按钮也可能被隐藏标签页的同一份挂载复制抢走，一律取可见的那个。
  window.__consoleBtnState = () => {
    const b = window.__all('.db-redis-console-open')[0]
    return b ? (b.disabled ? 'disabled' : 'enabled') : 'no-btn'
  }
  window.__openConsole = () => {
    const b = window.__all('.db-redis-console-open')[0]
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  // 控制台是 antd body 级 portal，会带着"旧标签页仍挂载的弹层"一起挂在 body 下；
  // 一律从【可见】的控制台根出发（__all 已按 getBoundingClientRect 过滤 display:none），
  // 绝不用 document.querySelector('.db-redis-console')——那会拿到第一个（可能是隐藏的）弹层。
  window.__cRoot = () => window.__all('.db-redis-console')[0] || null
  window.__cq = sel => {
    const root = window.__cRoot()
    return root ? root.querySelector(sel) : null
  }
  window.__cqs = sel => {
    const root = window.__cRoot()
    return root ? window.__kids(root, sel) : []
  }
  window.__cOpen = () => {
    const el = window.__cRoot()
    return !!el
  }
  window.__cTitle = () => window.__txt(window.__cq('.ant-modal-title'))
  window.__cMode = () => window.__cqs('.db-redis-console-mode').map(window.__txt)
  window.__cCloseX = () => {
    const b = window.__cq('.ant-modal-close')
    if (!b) return 'no-close'
    b.click()
    return 'ok'
  }
  window.__cFooter = n => {
    const bs = window.__cqs('.ant-modal-footer button')
    if (!bs[n]) return 'no-btn:' + n + '/' + bs.length
    if (bs[n].disabled) return 'disabled'
    bs[n].click()
    return 'ok'
  }
  window.__cFooterState = () =>
    window.__cqs('.ant-modal-footer button')
      .map(b => ({ text: window.__txt(b), disabled: !!b.disabled }))

  // ---- 输入 / 补全 ----
  window.__cEl = () => window.__cq('.db-redis-console-input input')
  window.__cDraft = () => {
    const el = window.__cEl()
    return el ? el.value : null
  }
  window.__cCaret = () => {
    const el = window.__cEl()
    return el ? el.selectionStart : -1
  }
  window.__cType = text => {
    const el = window.__cEl()
    if (!el) return 'no-input'
    el.focus()
    const s = String(text)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, s)
    el.setSelectionRange(s.length, s.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__cRunState = () => {
    const b = window.__cq('.db-redis-console-run')
    return b ? (b.disabled ? 'disabled' : 'enabled') : 'no-btn'
  }
  window.__cRun = () => {
    const b = window.__cq('.db-redis-console-run')
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__cSuggest = () => window.__all('.db-redis-console-suggest-item').map(el => ({
    name: window.__txt(el.querySelector('.db-redis-console-suggest-name')),
    flags: window.__txt(el.querySelector('.db-redis-console-suggest-flags')),
    hint: window.__txt(el.querySelector('.db-redis-console-suggest-hint')),
    active: el.className.indexOf('is-active') >= 0,
    blocked: el.className.indexOf('is-blocked') >= 0
  }))
  window.__cSuggestCount = () => window.__all('.db-redis-console-suggest-item').length
  window.__cMouseDown = n => {
    const items = window.__all('.db-redis-console-suggest-item')
    if (!items[n]) return 'no-item:' + n + '/' + items.length
    items[n].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    return 'ok'
  }

  // ---- 历史 ----
  window.__cEntries = () => window.__all('.db-redis-console-entry').map(el => ({
    tone: el.className.split(' ').find(c => c.startsWith('is-')).replace(/^is-/, '') || '',
    pending: el.className.indexOf('is-pending') >= 0,
    line: window.__txt(el.querySelector('.db-redis-console-cmd-text')),
    tags: window.__kids(el, '.db-redis-console-tag').map(window.__txt),
    ms: window.__txt(el.querySelector('.db-redis-console-ms')),
    alert: window.__kids(el, '.db-redis-console-alert').map(window.__txt).join(' | '),
    error: window.__txt(el.querySelector('.db-redis-console-error')),
    header: window.__txt(el.querySelector('.db-redis-console-header')),
    rows: window.__kids(el, '.db-redis-console-row').map(r => ({
      label: window.__txt(r.querySelector('.db-redis-console-row-label')),
      text: window.__txt(r.querySelector('.db-redis-console-value')),
      kind: ((r.querySelector('.db-redis-console-value') || {}).className || '')
        .replace('db-redis-console-value', '').trim(),
      indent: r.style.paddingLeft
    })),
    notes: window.__kids(el, '.db-redis-console-note').map(window.__txt),
    copy: !!el.querySelector('.db-redis-console-copy')
  }))
  window.__cEntryCount = () => window.__all('.db-redis-console-entry').length
  window.__cCopy = n => {
    const es = window.__all('.db-redis-console-entry')
    const b = es[n] && es[n].querySelector('.db-redis-console-copy')
    if (!b) return 'no-copy:' + n
    b.click()
    return 'ok'
  }
  window.__cEmpty = () =>
    window.__txt(window.__cq('.db-redis-console-history .ant-empty-description'))

  // ---- 只读开关（顶栏，先同步主进程再改本地）----
  // 顶栏只读开关属于当前激活标签页的 .db-head；用可见元素过滤避开隐藏标签页的开关。
  window.__readonlyState = () => {
    const sw = window.__all('.db-head .ant-switch')[0]
    return sw ? String(sw.getAttribute('aria-checked')) : 'no-switch'
  }
  window.__toggleReadonly = () => {
    const sw = window.__all('.db-head .ant-switch')[0]
    if (!sw) return 'no-switch'
    sw.click()
    return 'ok'
  }

  // ---- 生产确认闸门（复用 DbDangerConfirm）----
  window.__riskOpen = () => !!window.__all('.db-risk-modal')[0]
  window.__riskText = () => {
    const el = window.__all('.db-risk-modal')[0]
    return el ? window.__txt(el).slice(0, 400) : ''
  }
  window.__riskHasNameInput = () => !!window.__all('.db-risk-dbname-input')[0]
  window.__riskFillName = v => window.__fill('.db-risk-dbname-input', v)
  window.__riskOkState = () => {
    const bs = window.__all('.db-risk-modal .ant-modal-footer button')
    const b = bs[bs.length - 1]
    return b ? String(!!b.disabled) : 'no-btn'
  }
  window.__riskOk = () => {
    const bs = window.__all('.db-risk-modal .ant-modal-footer button')
    const b = bs[bs.length - 1]
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__riskCancel = () => {
    const b = window.__all('.db-risk-modal .ant-modal-footer button')[0]
    if (!b) return 'no-btn'
    b.click()
    return 'ok'
  }
})()`

// CDP 可信按键：rc-dialog 的 Esc 判定看 keyCode，React 的 onKeyDown 看 key，两个都给
const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 }
}

async function main () {
  const { check, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const srv = await startFakeRedis(REDIS_PORT)
  const cmdCount = () => srv.stats().commands.length
  const countOf = n => srv.stats().commands.filter(c => c.cmd === n).length
  const argsOf = n => srv.stats().commands.filter(c => c.cmd === n).map(c => c.args)

  let tabId = ''
  let prodTabId = ''
  let cdp = null
  let theme0 = null

  const pressKey = async name => {
    const def = KEY_DEFS[name]
    await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...def })
    await sleep(180)
  }

  // 敲一行 → 点「执行」→ 等它结算，回最新那条历史。
  // 用按钮而不是回车：回车的语义（补全 or 执行）另有专门判据，别混进每一步里
  const runLine = async line => {
    const before = await cdp.eval('window.__cEntryCount()')
    const typeRet = await cdp.eval(`window.__cType(${J(line)})`)
    await sleep(160)
    const runRet = await cdp.eval('window.__cRun()')
    const settled = await waitFor(cdp,
      `window.__cEntryCount() === ${before + 1} && !window.__cEntries()[0].pending`,
      '命令没结算：' + line, 15000)
    const list = await cdp.eval('window.__cEntries()')
    return { typeRet, runRet, settled, entry: list[0] || null, count: list.length }
  }

  const addRedisTab = async (extra = {}) => {
    return cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J(TITLE)},
        dbType: 'redis', dbHost: '127.0.0.1', dbPort: ${REDIS_PORT}, dbPassword: '',
        dbName: '0', dbSsl: false, readOnly: true,
        batch: window.store.currentLayoutBatch,
        ...${J(extra)}
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
  }

  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    const page = findPageTarget(targets)
    if (!page) throw new Error('找不到渲染进程页签，先把实例起起来（见文件头用法）')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Log.enable')
    await cdp.call('Page.bringToFront', {})
    const shot = f => cdp.shot(path.join(SHOT_DIR, f))

    check('渲染进程可用（store / pre / translate 都在）',
      await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
    await cdp.eval(buildHelpers('electerm-n5a-redis-console'))
    await cdp.eval(PROBE)
    check('页内探针装好',
      await cdp.eval('!!(window.__cType && window.__cEntries && window.__riskOpen && window.__openConsole)'))
    check('剪贴板监听装好（复制判据要读真实剪贴板）',
      await cdp.eval('window.__spyClip()') !== 'no-pre')

    const stub = await preStubState(cdp)
    check('桥接层是原装的（没被别的 demo 的桩覆盖）',
      String(stub) === 'ok' || String(stub).indexOf('native') >= 0, stub)

    await clearDbTabs(cdp)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__dismiss()') !== 'closed') break
      await sleep(200)
    }
    theme0 = await cdp.eval('window.store._config && window.store._config.theme')

    // ---- ① 建连 + 入口 ----
    tabId = await addRedisTab()
    const connected = await waitFor(cdp,
      `!!(window.__head() && window.__head().indexOf(${J(String(REDIS_PORT))}) >= 0)`,
      'Redis 会话头部等不到连接目标', 25000)
    check('① 加页签即建连（真 ioredis 握手 PING + INFO 到达服务端）',
      connected && countOf('PING') > 0 && countOf('INFO') > 0,
      { head: await cdp.eval('window.__head()'), ping: countOf('PING'), info: countOf('INFO') })
    if (!connected) {
      await printDiag(cdp, srv)
      check('后续判据依赖建连，提前中止', false, cdp.tail(8))
      return finish()
    }

    check('① 元数据树出 16 个 db 节点',
      await waitFor(cdp, 'window.__hasTree("db0")', '树里等不到 db0', 20000) &&
      await cdp.eval('window.__q(".db-tree .ant-tree-treenode")') >= 16)
    const pick = await cdp.eval('window.__clickTree("db0")')
    check('① 选中 db0 后键列表出数（夹具 64 键）',
      pick === 'ok' && await waitFor(cdp, 'window.__redisRowCount() >= 10', '键列表没出内容', 20000),
      { pick, rows: await cdp.eval('window.__redisRowCount()'), db0: srv.count(0) })

    check('② 控制台入口在键列表工具条上，只读下不禁用（禁用条件归主进程）',
      await cdp.eval('window.__consoleBtnState()') === 'enabled',
      await cdp.eval('window.__consoleBtnState()'))
    const openRet = await cdp.eval('window.__openConsole()')
    const opened = await waitFor(cdp, 'window.__cOpen()', '控制台弹层没打开', 12000)
    await sleep(500)
    const title = await cdp.eval('window.__cTitle()')
    const mode = await cdp.eval('window.__cMode()')
    check('② 弹层打开，标题带当前 db（· db 0），只读横幅在且已本地化',
      openRet === 'ok' && opened && title.indexOf('db 0') >= 0 &&
        mode.length === 1 && mode[0].length > 0 && !/^dbRedisConsole/.test(mode[0]),
      { openRet, title, mode })
    // 命令表是异步取的：在服务端侧等它真的到达，而不是猜一个渲染层延时
    const t0 = Date.now()
    while (countOf('COMMAND') === 0 && Date.now() - t0 < 12000) await sleep(200)
    check('② 打开即取命令表：服务端收到 COMMAND（不是渲染层自己编的名单）',
      countOf('COMMAND') > 0,
      { commandCalls: srv.stats().commandCalls, footer: await cdp.eval('window.__cFooterState()') })
    check('② 历史为空时给的是空态文案，不是空白一片',
      (await cdp.eval('window.__cEmpty()')).length > 0, await cdp.eval('window.__cEmpty()'))
    await shot('01-console-readonly.png')

    // ---- ③ 补全：候选来自服务端自述，提示与执行判定同源 ----
    await cdp.eval("window.__cType('zre')")
    await sleep(300)
    const zre = await cdp.eval('window.__cSuggest()')
    check('③ 命令名补全出候选（zre → ZREM，带服务端 flags）',
      zre.some(x => x.name === 'ZREM') && zre.every(x => x.flags.length > 0),
      zre)
    // INCR 在假服务端的 COMMAND 表里没有，但在策略层回落名单里有：
    // 候选里没有它，才证明这份名单真的来自服务端而不是内置回落
    await cdp.eval("window.__cType('incr')")
    await sleep(300)
    check('③ 候选取自服务端 COMMAND 而非内置回落名单（表里没有的 INCR 不出现）',
      await cdp.eval('window.__cSuggestCount()') === 0,
      { count: await cdp.eval('window.__cSuggestCount()'), source: 'server' })

    await cdp.eval("window.__cType('flush')")
    await sleep(300)
    const flushItems = await cdp.eval('window.__cSuggest()')
    check('③ FLUSHDB/FLUSHALL 在补全里就标成"会被拦"，且给出原因文案',
      flushItems.length === 2 &&
        flushItems.every(x => x.blocked && x.hint.length > 0 && !/^dbRedisConsole/.test(x.hint)),
      flushItems)
    await shot('02-completion-blocked.png')

    await cdp.eval("window.__cType('keys')")
    await sleep(300)
    const keysItem = (await cdp.eval('window.__cSuggest()'))[0]
    check('③ KEYS 自述 readonly 也照样标"会被拦"（名字类规则先于 flags）',
      !!keysItem && keysItem.name === 'KEYS' && keysItem.blocked &&
        keysItem.flags.indexOf('readonly') >= 0,
      keysItem)

    await cdp.eval("window.__cType('slowlog')")
    await sleep(300)
    const slowItem = (await cdp.eval('window.__cSuggest()'))[0]
    check('③ SLOWLOG 带 admin flag 但只读下可用（不写就不该拦）',
      !!slowItem && slowItem.name === 'SLOWLOG' && !slowItem.blocked && slowItem.hint === '',
      slowItem)

    await cdp.eval("window.__cType('set')")
    await sleep(300)
    const setItem = (await cdp.eval('window.__cSuggest()'))[0]
    check('③ 只读下 SET 的补全提示就是"会被拦"（与执行判定同一份 readOnlyHint）',
      !!setItem && setItem.name === 'SET' && setItem.blocked && setItem.hint.length > 0,
      setItem)

    // ---- ④ 键盘：方向键高亮、Enter 补全 vs 执行、Esc 只吃一次 ----
    await cdp.eval("window.__cType('hs')")
    await sleep(300)
    const hsBefore = await cdp.eval('window.__cSuggest()')
    await cdp.eval("(() => { const el = window.__cEl(); if (el) el.focus(); return 'ok' })()")
    await pressKey('ArrowDown')
    const down1 = await cdp.eval('window.__cSuggest()')
    await pressKey('ArrowDown')
    const down2 = await cdp.eval('window.__cSuggest()')
    await pressKey('ArrowUp')
    const up1 = await cdp.eval('window.__cSuggest()')
    check('④ 方向键移动高亮（↓ 到第一条、再 ↓ 到第二条、↑ 回第一条）',
      hsBefore.length >= 2 && down1.findIndex(x => x.active) === 0 &&
        down2.findIndex(x => x.active) === 1 && up1.findIndex(x => x.active) === 0,
      { n: hsBefore.length, down1: down1.map(x => x.name + (x.active ? '*' : '')), down2: down2.findIndex(x => x.active), up1: up1.findIndex(x => x.active) })
    await shot('03-completion-active.png')

    const histBeforeEnter = await cdp.eval('window.__cEntryCount()')
    const cmdsBeforeEnter = cmdCount()
    await pressKey('Enter')
    const draftAfterEnter = await cdp.eval('window.__cDraft()')
    const caretAfterEnter = await cdp.eval('window.__cCaret()')
    check('④ 列表开着且有高亮时 Enter = 补全（大写 + 尾随空格），不执行',
      draftAfterEnter === hsBefore[0].name + ' ' && caretAfterEnter === draftAfterEnter.length &&
        await cdp.eval('window.__cEntryCount()') === histBeforeEnter && cmdCount() === cmdsBeforeEnter,
      { draft: draftAfterEnter, caret: caretAfterEnter, want: hsBefore[0].name, entries: await cdp.eval('window.__cEntryCount()') })

    // 补全后列表已关（尾随空格没有前缀可补），Esc 会直接关弹层。
    // 要验证"第一次 Esc 只收列表"，得先重新打一个前缀把列表打开。
    await cdp.eval("window.__cType('get')")
    await sleep(300)
    await waitFor(cdp, 'window.__cSuggestCount() > 0', '重新打前缀没出补全列表', 6000)
    const draftBeforeEsc = await cdp.eval('window.__cDraft()')
    await pressKey('Escape')
    const afterEsc1 = {
      suggest: await cdp.eval('window.__cSuggestCount()'),
      open: await cdp.eval('window.__cOpen()')
    }
    check('④ 第一次 Esc 只收补全列表，弹层还开着', afterEsc1.suggest === 0 && afterEsc1.open === true, afterEsc1)
    await pressKey('Escape')
    await sleep(400)
    check('④ 第二次 Esc 照常关弹层（列表没开时不该被吃掉）',
      await cdp.eval('window.__cOpen()') === false)

    // 关掉再打开：草稿留着（上一段没敲完的命令），历史也留着
    await cdp.eval('window.__openConsole()')
    await waitFor(cdp, 'window.__cOpen()', '重开控制台失败', 10000)
    await sleep(400)
    check('④ 重开弹层保留草稿（关闭不作废没敲完的命令）',
      await cdp.eval('window.__cDraft()') === draftBeforeEsc,
      { draft: await cdp.eval('window.__cDraft()'), want: draftBeforeEsc })

    // 鼠标补全走 mousedown（blur 先于 click，用 click 永远补不进去）
    await cdp.eval("window.__cType('hlen')")
    await sleep(300)
    const mouseRet = await cdp.eval('window.__cMouseDown(0)')
    await sleep(250)
    check('④ 鼠标点候选也能补进去（onMouseDown + preventDefault）',
      mouseRet === 'ok' && await cdp.eval('window.__cDraft()') === 'HLEN ',
      { mouseRet, draft: await cdp.eval('window.__cDraft()') })

    // ---- ⑤ 读命令：回复按类型呈现 ----
    const ping = await runLine('PING')
    check('⑤ PING → bulk 回复，头部 (string)，值 PONG',
      ping.settled && ping.entry.tone === 'ok' && ping.entry.header === '(string)' &&
        ping.entry.rows.length === 1 && ping.entry.rows[0].text === 'PONG' &&
        ping.entry.rows[0].kind === 'is-bulk',
      ping.entry)

    const dbsize = await runLine('DBSIZE')
    check('⑤ DBSIZE → integer 回复，头部 (integer) 64（与夹具键数一致）',
      dbsize.entry.tone === 'ok' && dbsize.entry.header === '(integer) ' + FIXTURE_TOTAL &&
        dbsize.entry.rows[0].kind === 'is-integer' && dbsize.entry.rows[0].text === String(FIXTURE_TOTAL),
      { entry: dbsize.entry, server: srv.count(0) })

    const get = await runLine('GET smoke:key:000')
    check('⑤ GET → bulk 值原样呈现（value:000）',
      get.entry.tone === 'ok' && get.entry.rows[0].text === 'value:000', get.entry)

    const nil = await runLine('GET smoke:no:such:key')
    check('⑤ 不存在的键 → (nil)，与空串分得开',
      nil.entry.tone === 'ok' && nil.entry.header === '(nil)' &&
        nil.entry.rows[0].kind === 'is-nil' && nil.entry.rows[0].text === '(nil)',
      nil.entry)

    const hash = await runLine('HGETALL smoke:a:hash')
    check('⑤ HGETALL → 数组回复，6 项逐行编号（RESP2 的扁平 field/value）',
      hash.entry.tone === 'ok' && hash.entry.header === '(array) 6 项' &&
        hash.entry.rows.length === 6 &&
        hash.entry.rows.map(r => r.label).join(',') === '1,2,3,4,5,6' &&
        hash.entry.rows.map(r => r.text).join(',') === 'f1,v1,f2,v2,f3,v3',
      { header: hash.entry.header, rows: hash.entry.rows })

    const list = await runLine('LRANGE smoke:a:list 0 -1')
    check('⑤ LRANGE → 数组 3 项', list.entry.header === '(array) 3 项' &&
      list.entry.rows.map(r => r.text).join(',') === 'l1,l2,l3', list.entry)

    const echo = await runLine('ECHO "hello world"')
    const echoArgs = argsOf('ECHO')
    check('⑤ 带引号的参数整段过 IPC（ECHO "hello world" → 服务端收到一个参数）',
      echo.entry.tone === 'ok' && echo.entry.rows[0].text === 'hello world' &&
        echoArgs.length === 1 && echoArgs[0].length === 1 && echoArgs[0][0] === 'hello world',
      { entry: echo.entry, serverArgs: echoArgs })

    const slowlog = await runLine('SLOWLOG LEN')
    check('⑤ 只读下 SLOWLOG LEN 真发出去并拿到整数 3（admin flag 不等于写）',
      slowlog.entry.tone === 'ok' && slowlog.entry.header === '(integer) 3' && countOf('SLOWLOG') >= 1,
      { entry: slowlog.entry, slowlogCalls: srv.stats().slowlogCalls })

    const info = await runLine('INFO server')
    check('⑤ INFO server → 长 bulk 原样呈现（含 redis_version）',
      info.entry.tone === 'ok' && info.entry.rows[0].text.indexOf('redis_version') >= 0,
      { head: String(info.entry.rows[0] && info.entry.rows[0].text).slice(0, 60) })
    check('⑤ 每条成功回复都带耗时与复制按钮',
      [ping, dbsize, get, hash].every(r => /^\d+ ms$/.test(r.entry.ms) && r.entry.copy),
      { ms: [ping, dbsize, get, hash].map(r => r.entry.ms) })
    await shot('04-read-replies.png')

    // 复制：给的是完整文本，不带行号/截断提示
    const clipBefore = await cdp.eval('window.__clip.length')
    const dbsizeIdx = (await cdp.eval('window.__cEntries()')).findIndex(x => x.line === 'DBSIZE')
    const copyRet = await cdp.eval(`window.__cCopy(${dbsizeIdx})`)
    await sleep(400)
    const clip = JSON.parse(await cdp.eval('JSON.stringify(window.__clip.slice(' + clipBefore + '))'))
    const wantText = String(FIXTURE_TOTAL)
    check('⑤ 复制按钮把回复写进真实剪贴板（整数回复就是 64，不带行号）',
      copyRet === 'ok' && clip.length === 1 && clip[0].len === wantText.length &&
        clip[0].head === wantText &&
        clip[0].hash === await cdp.eval(`window.__hash(${J(wantText)})`),
      { copyRet, dbsizeIdx, clip })

    // ---- ⑥ 核心验收：只读下写命令被主进程拦截 ----
    const roState = await cdp.eval('window.__readonlyState()')
    check('⑥ 前置：顶栏只读开关确实是开的', roState === 'true', roState)

    const beforeSet = { total: cmdCount(), set: countOf('SET') }
    const roSet = await runLine('SET n5a:ro refused')
    check('⑥ 只读下 SET 被主进程拦下：历史里是 blocked + 原因文案，服务端一条 SET 都没收到',
      roSet.entry.tone === 'blocked' && roSet.entry.alert.length > 0 &&
        !/^dbRedisConsole/.test(roSet.entry.alert) &&
        countOf('SET') === beforeSet.set && !srv.store.alive(0, 'n5a:ro'),
      { entry: roSet.entry, beforeSet, afterSet: countOf('SET'), total: cmdCount() })
    check('⑥ 拦截横幅说明"未向 Redis 发出"（中英文案都点明去向，不是笼统的失败）',
      /Redis/.test(roSet.entry.alert), roSet.entry.alert)
    await shot('05-readonly-refused.png')

    // 名字类拒绝：连 COMMAND 往返都不该有（refuseByName 在 useDb 之前）
    // 握手/切库本身会发 SELECT、CONFIG GET，所以按「增量」对账而不是要求全程为零
    const watched = ['FLUSHDB', 'FLUSHALL', 'KEYS', 'MONITOR', 'CONFIG', 'EVAL', 'BLPOP',
      'PUBLISH', 'SHUTDOWN', 'SUBSCRIBE', 'SELECT']
    const baseCounts = Object.fromEntries(watched.map(c => [c, countOf(c)]))
    const nameBlocked = [
      ['FLUSHDB', 'destructive'],
      ['FLUSHALL', 'destructive'],
      ['KEYS *', 'destructive'],
      ['SHUTDOWN NOSAVE', 'destructive'],
      ['CONFIG SET maxmemory 100mb', 'admin'],
      ['MONITOR', 'streaming'],
      ['SUBSCRIBE ch', 'pubsub'],
      ['SELECT 1', 'connection-state'],
      ['EVAL "return 1" 0', 'scripting'],
      ['BLPOP k 0', 'blocking'],
      ['PUBLISH ch msg', 'pubsub']
    ]
    for (const [line] of nameBlocked) {
      const before = cmdCount()
      const r = await runLine(line)
      const name = line.split(' ')[0]
      check(`⑥ ${name} 无条件拒绝（只读位无关），且零服务端往返`,
        r.entry.tone === 'blocked' && r.entry.alert.length > 0 &&
          cmdCount() === before && countOf(name) === baseCounts[name],
        { tone: r.entry.tone, alert: r.entry.alert, roundTrips: cmdCount() - before })
    }
    check('⑥ 清库命令被拦后夹具一个键都没少（64 键仍在）', srv.count(0) === FIXTURE_TOTAL,
      { db0: srv.count(0), flushdb: countOf('FLUSHDB'), flushall: countOf('FLUSHALL'), keys: countOf('KEYS') })

    const beforeUnknown = cmdCount()
    const unknownRo = await runLine('LOLWUT')
    check('⑥ 只读下名单外的命令宁可拒绝（unknown-command），不猜"大概无害"',
      unknownRo.entry.tone === 'blocked' && unknownRo.entry.alert.length > 0 &&
        cmdCount() === beforeUnknown && countOf('LOLWUT') === 0,
      { entry: unknownRo.entry, roundTrips: cmdCount() - beforeUnknown })

    const beforeBad = cmdCount()
    const badQuote = await runLine('GET "unterminated')
    check('⑥ 引号没闭合 → invalid，分词在主进程做，坏行不出网',
      badQuote.entry.tone === 'invalid' && badQuote.entry.alert.length > 0 &&
        cmdCount() === beforeBad,
      { entry: badQuote.entry, roundTrips: cmdCount() - beforeBad })

    await cdp.eval("window.__cType('   ')")
    await sleep(250)
    check('⑥ 空白行执行按钮禁用（不发空命令）',
      await cdp.eval('window.__cRunState()') === 'disabled',
      await cdp.eval('window.__cRunState()'))
    await cdp.eval("window.__cType('')")

    // ---- ⑦ 命令表刷新 / 清空历史 ----
    const beforeReload = countOf('COMMAND')
    const reloadRet = await cdp.eval('window.__cFooter(1)')
    const reloaded = await waitFor(cdp, 'window.__cFooterState()[1].disabled === false', '刷新没结束', 12000)
    check('⑦ 「重新取命令表」真的再发一次 COMMAND（force 不被缓存吃掉）',
      reloadRet === 'ok' && reloaded && countOf('COMMAND') > beforeReload,
      { reloadRet, before: beforeReload, after: countOf('COMMAND') })

    const entriesBeforeClear = await cdp.eval('window.__cEntryCount()')
    const clearRet = await cdp.eval('window.__cFooter(0)')
    await sleep(350)
    check('⑦ 清空历史：条目归零、空态文案回来、按钮自己禁用',
      clearRet === 'ok' && entriesBeforeClear > 0 &&
        await cdp.eval('window.__cEntryCount()') === 0 &&
        (await cdp.eval('window.__cEmpty()')).length > 0 &&
        (await cdp.eval('window.__cFooterState()'))[0].disabled === true,
      { clearRet, before: entriesBeforeClear, footer: await cdp.eval('window.__cFooterState()') })

    // ---- ⑧ 关掉只读：名字类黑名单不受影响，写命令真落库 ----
    // 先留几条读回复给双主题截图用
    await runLine('DBSIZE')
    await runLine('HGETALL smoke:a:hash')
    const toggleRet = await cdp.eval('window.__toggleReadonly()')
    const writable = await waitFor(cdp, 'window.__readonlyState() === "false"', '只读开关没关掉', 12000)
    await sleep(500)
    check('⑧ 顶栏开关先同步主进程再改本地（关只读后横幅消失）',
      toggleRet === 'ok' && writable && (await cdp.eval('window.__cMode()')).length === 0,
      { toggleRet, writable, mode: await cdp.eval('window.__cMode()') })

    const beforeFlush2 = cmdCount()
    const flushWritable = await runLine('FLUSHDB')
    check('⑧ 可写下 FLUSHDB/KEYS 仍然拒绝（黑名单与只读位是两件事）',
      flushWritable.entry.tone === 'blocked' && cmdCount() === beforeFlush2 &&
        srv.count(0) === FIXTURE_TOTAL,
      { tone: flushWritable.entry.tone, db0: srv.count(0), roundTrips: cmdCount() - beforeFlush2 })
    const keysWritable = await runLine('KEYS *')
    check('⑧ 可写下 KEYS 仍然拒绝，且服务端没收到 KEYS',
      keysWritable.entry.tone === 'blocked' && countOf('KEYS') === baseCounts.KEYS, keysWritable.entry)

    const lolwut = await runLine('LOLWUT')
    check('⑧ 可写下名单外命令真发出去，服务端 -ERR 作为回复画进历史（不是 toast）',
      lolwut.entry.tone === 'error' && /unknown command/i.test(lolwut.entry.error) &&
        lolwut.entry.error.indexOf('Redis') >= 0 && countOf('LOLWUT') === 1 &&
        srv.stats().unknown.some(u => u.cmd === 'LOLWUT'),
      { entry: lolwut.entry, unknown: srv.stats().unknown })
    await shot('06-server-error.png')

    // 真写回归：每一步都对服务端夹具账
    const wSet = await runLine('SET n5a:write v1')
    const recSet = srv.store.alive(0, 'n5a:write')
    check('⑧ 写命令真落库：SET 到服务端，回复 OK，带「写」标记与提示',
      wSet.entry.tone === 'ok' && wSet.entry.rows[0].text === 'OK' &&
        wSet.entry.tags.length === 1 && wSet.entry.notes.length === 1 &&
        !!recSet && recSet.value === 'v1' && countOf('SET') === 1,
      { entry: wSet.entry, server: recSet, setCalls: argsOf('SET') })

    const wGet = await runLine('GET n5a:write')
    check('⑧ 写后读回同一个值（不是前端本地假更新）',
      wGet.entry.rows[0].text === 'v1', wGet.entry)

    const wHset = await runLine('HSET smoke:a:hash n5a 7')
    const hashRec = srv.store.alive(0, 'smoke:a:hash')
    check('⑧ 整数回复的写命令：HSET → 1，服务端哈希真多了一个字段',
      wHset.entry.tone === 'ok' && wHset.entry.header === '(integer) 1' &&
        !!hashRec && hashRec.value.get('n5a') === '7',
      { entry: wHset.entry, field: hashRec && hashRec.value.get('n5a') })

    const wExpire = await runLine('EXPIRE n5a:write 120')
    const ttlServer = srv.ttlOf('n5a:write')
    check('⑧ EXPIRE → 1，服务端 TTL 真的是 120 秒',
      wExpire.entry.header === '(integer) 1' && ttlServer >= 118 && ttlServer <= 120,
      { entry: wExpire.entry, server: ttlServer, calls: srv.stats().expireCalls })

    const wDel = await runLine('DEL n5a:write')
    check('⑧ DEL → 1，键真的没了（写路径全程对服务端账）',
      wDel.entry.header === '(integer) 1' && !srv.store.alive(0, 'n5a:write') &&
        srv.stats().delKeys.includes('n5a:write'),
      { entry: wDel.entry, delKeys: srv.stats().delKeys })
    await shot('07-writable-writes.png')

    // 关掉本标签页控制台再进 ⑨：antd 弹层是 body 级 portal，开着旧弹层再建新页签，
    // 两个弹层会同时可见，可见性过滤兜不住"同一时刻两个真弹层"。先关干净。
    await cdp.eval('window.__cCloseX()')
    await waitFor(cdp, '!window.__cOpen()', '原控制台没关干净', 8000)

    // ---- ⑨ 生产连接：写命令过既有确认闸门（§5.2.6 不另造一套）----
    prodTabId = await addRedisTab({ readOnly: false, production: true })
    // 建连判据只看头部带端口 + 只读默认关。控制台按钮在键列表工具条上、
    // 要等选中 db0 才渲染，所以"按钮可用"不放进这里，等真正开弹层时再验。
    const prodConnected = await waitFor(cdp,
      `window.__head().indexOf(${J(String(REDIS_PORT))}) >= 0`,
      '生产页签没连上', 25000)
    check('⑨ 生产页签建连（production 标记来自页签，只读默认关）',
      prodConnected && await cdp.eval('window.__readonlyState()') === 'false',
      {
        prodConnected,
        ro: await cdp.eval('window.__readonlyState()'),
        head: await cdp.eval('window.__head()')
      })
    await cdp.eval('window.__clickTree("db0")')
    await waitFor(cdp, 'window.__redisRowCount() >= 10', '生产页签键列表没出数', 20000)
    check('⑨ 生产页签控制台入口可用', await cdp.eval('window.__consoleBtnState()') === 'enabled',
      await cdp.eval('window.__consoleBtnState()'))
    await cdp.eval('window.__openConsole()')
    await waitFor(cdp, 'window.__cOpen()', '生产页签控制台没打开', 12000)
    await sleep(500)
    check('⑨ 生产 + 可写：只读横幅不在（该问的是确认闸门，不是只读）',
      (await cdp.eval('window.__cMode()')).length === 0, await cdp.eval('window.__cMode()'))

    const beforeGate = { total: cmdCount(), set: countOf('SET'), entries: await cdp.eval('window.__cEntryCount()') }
    await cdp.eval("window.__cType('SET n5a:prod p1')")
    await sleep(200)
    await cdp.eval('window.__cRun()')
    const gateOpen = await waitFor(cdp, 'window.__riskOpen()', '生产确认闸门没弹', 12000)
    await sleep(500)
    const gateText = await cdp.eval('window.__riskText()')
    check('⑨ 生产写命令先弹既有危险确认闸门，命令原文与理由都在',
      gateOpen && gateText.indexOf('SET n5a:prod p1') >= 0 &&
        await cdp.eval('window.__riskHasNameInput()') === true,
      { gateOpen, text: gateText.slice(0, 200) })
    check('⑨ 闸门未确认前一个 op 都没发，历史里也不留痕',
      cmdCount() === beforeGate.total && countOf('SET') === beforeGate.set &&
        await cdp.eval('window.__cEntryCount()') === beforeGate.entries,
      { roundTrips: cmdCount() - beforeGate.total, entries: await cdp.eval('window.__cEntryCount()') })
    check('⑨ 生产闸门要求输库名，没输对时「仍要执行」禁用',
      await cdp.eval('window.__riskOkState()') === 'true', await cdp.eval('window.__riskOkState()'))
    await shot('08-production-gate.png')

    const cancelRet = await cdp.eval('window.__riskCancel()')
    await sleep(500)
    check('⑨ 取消 = 零执行（服务端没收到 SET，历史仍然干净）',
      cancelRet === 'ok' && await cdp.eval('window.__riskOpen()') === false &&
        countOf('SET') === beforeGate.set && !srv.store.alive(0, 'n5a:prod') &&
        await cdp.eval('window.__cEntryCount()') === beforeGate.entries,
      { cancelRet, set: countOf('SET'), entries: await cdp.eval('window.__cEntryCount()') })

    await cdp.eval("window.__cType('SET n5a:prod p1')")
    await sleep(200)
    await cdp.eval('window.__cRun()')
    await waitFor(cdp, 'window.__riskOpen()', '第二次闸门没弹', 12000)
    await sleep(400)
    const fillRet = await cdp.eval("window.__riskFillName('0')")
    await sleep(300)
    const okEnabled = await cdp.eval('window.__riskOkState()')
    const okRet = await cdp.eval('window.__riskOk()')
    const gateSettled = await waitFor(cdp,
      'window.__cEntryCount() === 1 && !window.__cEntries()[0].pending', '确认后没执行', 15000)
    const prodRec = srv.store.alive(0, 'n5a:prod')
    check('⑨ 输对库名后放行：命令真发出去并落库（闸门不是摆设）',
      fillRet === 'ok' && okEnabled === 'false' && okRet === 'ok' && gateSettled &&
        !!prodRec && prodRec.value === 'p1' && countOf('SET') === beforeGate.set + 1,
      { fillRet, okEnabled, okRet, server: prodRec, set: countOf('SET') })

    // ---- ⑩ 双主题：同一屏历史 + 补全在深浅两套下都画得出来 ----
    const themeIds = JSON.parse(await cdp.eval(
      "JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
    const lightId = themeIds.find(id => /light/i.test(String(id)))
    const darkId = themeIds.includes('default') ? 'default' : theme0
    check('⑩ 深浅两套主题可切换', !!lightId && !!darkId, themeIds)
    await runLine('HGETALL smoke:a:hash')
    await runLine('PING')
    for (const theme of [{ id: darkId, name: 'dark' }, { id: lightId, name: 'light' }]) {
      if (!theme.id) continue
      await cdp.eval('window.store.setTheme(' + J(theme.id) + ')')
      await sleep(900)
      await cdp.eval("window.__cType('h')")
      await sleep(400)
      const painted = await cdp.eval(`(() => {
        const root = window.__cRoot()
        const val = root && root.querySelector('.db-redis-console-entry .db-redis-console-value')
        const name = root && root.querySelector('.db-redis-console-suggest-name')
        // antd 把 Modal 的 className 直接落在 .ant-modal-content 上，
        // 所以 root 本身就是 content，不需要再往下找子节点
        const content = root
        const missing = [root ? null : 'root', val ? null : 'val', name ? null : 'name', content ? null : 'content']
          .filter(Boolean)
        if (missing.length) return JSON.stringify({ miss: true, missing, open: window.__cOpen(), entries: window.__cEntryCount(), suggestItems: window.__cSuggestCount() })
        const cv = getComputedStyle(val)
        const cn = getComputedStyle(name)
        const bg = getComputedStyle(content).backgroundColor
        return JSON.stringify({ value: cv.color, suggest: cn.color, bg, entries: window.__cEntryCount(), suggestItems: window.__cSuggestCount() })
      })()`)
      const p = JSON.parse(painted)
      check(`⑩ ${theme.name}：历史与补全都画出来，文字色与底色不同（不是隐形字）`,
        !p.miss && p.entries >= 2 && p.suggestItems > 0 && p.value !== p.bg && p.suggest !== p.bg,
        p)
      await shot('09-console-' + theme.name + '.png')
    }
    await cdp.eval('window.store.setTheme(' + J(theme0) + ')')
    await sleep(600)

    // ---- ⑪ 渲染层零硬错误 + 协议记账 ----
    const hard = cdp.events.slice().filter(l => {
      const s = String(l)
      if (/Failed to fetch dynamically imported module|Failed to load resource/.test(s)) return false
      return /Cannot read|is not a function|is not defined|TypeError|Uncaught|Cannot destructure|of undefined|of null/.test(s)
    })
    check('⑪ 渲染层没有硬错误（Buffer 全局、漏接线、词条缺失都会炸在这里）',
      hard.length === 0, hard.slice(0, 8))

    const unique = [...new Set(srv.stats().commands.map(c => c.cmd))].sort()
    const unknown = srv.stats().unknown
    check('⑪ 协议路径完整：读写两侧的命令都真的到达服务端',
      ['PING', 'INFO', 'COMMAND', 'SELECT', 'SCAN', 'DBSIZE', 'GET', 'HGETALL', 'LRANGE',
        'ECHO', 'SLOWLOG', 'SET', 'HSET', 'EXPIRE', 'DEL'].every(c => unique.includes(c)),
      { commands: unique })
    check('⑪ 被拦下的命令一条都没出网（FLUSHDB/FLUSHALL/KEYS/MONITOR/CONFIG/EVAL/BLPOP/PUBLISH/SELECT 控制台侧为零）',
      watched.every(c => countOf(c) === baseCounts[c]),
      { flushdb: countOf('FLUSHDB'), keys: countOf('KEYS'), monitor: countOf('MONITOR'), baseCounts })
    check('⑪ 假服务端只把 LOLWUT 记成未实现命令（其余都是实现过的路径）',
      unknown.length === 1 && unknown[0].cmd === 'LOLWUT', unknown)
    console.log('\n[fake-redis] 命令总数 ' + cmdCount() + '，独立命令 ' + unique.length)
    console.log('[fake-redis] 命令清单: ' + unique.join(', '))
    console.log('[fake-redis] COMMAND 往返: ' + JSON.stringify(srv.stats().commandCalls))
    await shot('10-final.png')

    return finish()
  } finally {
    try {
      if (cdp && theme0 !== null) {
        await cdp.eval('window.store.setTheme(' + J(theme0) + ')')
      }
    } catch (e) { /* ignore */ }
    for (const id of [prodTabId, tabId]) {
      try {
        if (cdp && id) await cdp.eval(`window.store.delTab(${J(id)})`)
      } catch (e) { /* 页面已关闭/超时，收尾失败不覆盖判据结果 */ }
    }
    try {
      await srv.close()
    } catch (e) { /* ignore */ }
  }

  function finish () {
    const fail = results.filter(r => !r.ok)
    console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
    if (fail.length) console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
    console.log('截图: ' + SHOT_DIR)
    return fail.length
  }
}

async function printDiag (cdp, srv) {
  try {
    console.log('DIAG head=' + await cdp.eval('window.__head()'))
    console.log('DIAG events=' + JSON.stringify(cdp.tail(10)))
    console.log('DIAG fake-redis cmds=' +
      JSON.stringify(srv.stats().commands.map(c => c.cmd).slice(0, 40)))
    console.log('DIAG fake-redis unknown=' + JSON.stringify(srv.stats().unknown.slice(0, 10)))
  } catch (e) {
    console.log('DIAG failed: ' + (e && e.message))
  }
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
