#!/usr/bin/env node
/**
 * AI 图片磁盘冷层（S2-2 / 设计 §6-11）—— CDP 实机验收
 *
 * 逐条量这些行为：
 *   A) 真主进程 IPC：aiImageOp 的 dir/put/get/list 都落到 appData 下那个固定目录，
 *      一张一个 `<id>.data`，读一次续一次 mtime（保留期按"最后一次被用到"算）。
 *   B) 闸门：非法 id（路径穿越）、非 data URL、空图、单张超限都只回"这次没存上"，
 *      不抛错也不越界写文件。
 *   C) 配额与回收：字节配额、条数上限、保留期三道闸都从"最久没被引用"开始砍。
 *   D) 渲染层闭环：贴进输入框就落盘；刷新页面（内存缓存清空，等价于重启应用）之后
 *      历史卡片不再标"已过期"，下一轮纯文本追问仍把上一轮那张真图发出去。
 *   E) 生命周期：删一条历史 / 清空会话时，磁盘副本一起走，不留孤儿文件。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/ work/app/   # 主进程改动要重启才生效
 *   2) 起一个带 --remote-debugging-port 的实例，HOME 指到临时目录（磁盘层就在
 *      appData 里，本 demo 会清空它；跑在真实用户目录上就是删用户的图片缓存）
 *   3) node self-test/ai-image-persist-demo.js [debugPort] [shotDir]
 *
 * 桩只接管 AIchat（记下实参、直接回一段非流式回复），其余 IPC 原样转发给真主进程
 * ——aiImageOp 必须是真的，否则本 demo 量的只是渲染层的想象。
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'ai-image-persist-shots')

// 一张 8x8 的合法 PNG：够小，能在没有真截图的情况下把配额算清楚
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76L' +
  'AAAAF0lEQVR42mP8z8BQz0AEYBxVSF+FAP5FEOJvqTcAAAAASUVORK5CYII='

const FIXTURE = `
(() => {
  if (!window.__origRGA) {
    window.__origRGA = window.pre.runGlobalAsync.bind(window.pre)
  }
  window.__aiSeq = 0
  window.__aiCalls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'AIchat') {
      window.__aiSeq = window.__aiSeq + 1
      window.__aiCalls.push({ n: window.__aiSeq, prompt: a[0], messages: a[9] })
      return Promise.resolve({ response: 'noted' })
    }
    return window.__origRGA(name, ...a)
  }
  window.pre.__stub22 = 'stub'
  return 'stub-installed'
})()
`

const PROBE = `
(() => {
  const visBy = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__panel22 = () => visBy('.ai-chat-textarea')[0] ? visBy('.ai-chat-history')[0] : null
  window.__historyCards22 = () => JSON.stringify(
    visBy('.ai-chat-history .ai-image-card').map(c => {
      const img = c.querySelector('.ai-image-thumb')
      return {
        name: String((c.querySelector('.ai-image-name') || {}).innerText || ''),
        expired: c.className.indexOf('is-expired') >= 0,
        thumb: img ? String(img.getAttribute('src') || '').slice(0, 22) : '',
        title: String(c.getAttribute('title') || '')
      }
    })
  )
  window.__setPrompt22 = text => {
    const el = visBy('.ai-chat-textarea')[0]
    if (!el) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, String(text))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__send22 = () => {
    const i = visBy('.send-to-ai-icon')[0]
    if (!i) return 'no-send-icon'
    i.click()
    return 'ok'
  }
  window.__modeNow22 = () => {
    const sel = visBy('.ai-chat-terminals .ant-segmented-item-selected')[0]
    return sel ? String(sel.innerText).trim() : 'none'
  }
  window.__clickMode22 = label => {
    const hit = visBy('.ai-chat-terminals .ant-segmented-item')
      .find(el => String(el.innerText).trim() === label)
    if (!hit) return 'missing'
    if (hit.className.indexOf('ant-segmented-item-selected') >= 0) return 'already'
    hit.click()
    return 'clicked'
  }
  // 剪贴板贴图：走真的 paste 事件，量的是"用户贴进来"这条路径，不是我们自己调 API
  window.__pasteImage22 = (w, h, color, name) => new Promise(resolve => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    x.fillStyle = color
    x.fillRect(0, 0, w, h)
    x.fillStyle = '#fff'
    x.font = '16px sans-serif'
    x.fillText(String(name || 'shot'), 6, 20)
    c.toBlob(b => {
      const f = new File([b], name || 'shot.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(f)
      const ta = visBy('.ai-chat-textarea')[0]
      if (!ta) {
        resolve(JSON.stringify({ error: 'no-textarea' }))
        return
      }
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: dt })
      resolve(JSON.stringify({ notCanceled: ta.dispatchEvent(ev), files: dt.files.length }))
    }, 'image/png')
  })
  // 上一次请求实头发出的消息：只回结构与前缀，别把 base64 搬回 node
  window.__lastWire22 = () => {
    const c = window.__aiCalls[window.__aiCalls.length - 1]
    if (!c) return JSON.stringify({ none: 1 })
    const msgs = Array.isArray(c.messages) ? c.messages : []
    return JSON.stringify({
      n: c.n,
      msgCount: msgs.length,
      kinds: msgs.map(m => Array.isArray(m.content) ? 'array' : typeof m.content),
      imageParts: msgs.map(m => Array.isArray(m.content)
        ? m.content.filter(p => p && p.type === 'image_url').length : 0),
      placeholders: msgs
        .map(m => typeof m.content === 'string' ? m.content : '')
        .filter(t => t.indexOf('[attached image unavailable:') >= 0).length,
      lastUrl: (() => {
        const last = msgs[msgs.length - 1] || {}
        const p = Array.isArray(last.content)
          ? last.content.find(x => x && x.type === 'image_url') : null
        return p ? String((p.image_url || {}).url || '').slice(0, 22) : ''
      })()
    })
  }
  // 落库的条目仍然只有元数据：持久化的是磁盘，不是把 base64 塞回历史
  window.__historyMeta22 = () => {
    const sid = window.store.currentChatSessionId
    const h = (window.store.aiChatHistory || []).filter(x => x.chatSessionId === sid)
    const text = JSON.stringify(h)
    return JSON.stringify({
      entries: h.length,
      withImages: h.filter(x => (x.images || []).length).length,
      ids: h.flatMap(x => (x.images || []).map(i => i.id)),
      hasDataUrl: text.indexOf('data:image') >= 0
    })
  }
  window.__aiN22 = () => Number(window.__aiSeq)
  window.__entryWithImage22 = () => {
    const sid = window.store.currentChatSessionId
    const h = (window.store.aiChatHistory || []).filter(
      x => x.chatSessionId === sid && (x.images || []).length)
    return h.length ? String(h[0].id) : ''
  }
  window.__tr22 = k => String(window.translate(k))
  return 'ai-image-persist-probe'
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

const installStub = async cdp => {
  for (let i = 0; i < 10; i++) {
    if (await cdp.eval('!!(window.pre && window.pre.__stub22 === "stub")')) {
      return true
    }
    await cdp.eval(FIXTURE)
    await sleep(300)
    if (await cdp.eval('!!(window.pre && window.pre.__stub22 === "stub")')) {
      return true
    }
  }
  return false
}

// 页内调真 IPC（awaitPromise 会等这条 Promise 落地），结果原样回 node
const ipcCall = async (cdp, action, arg) => cdp.jeval(
  'window.pre.runGlobalAsync("aiImageOp", ' + JSON.stringify(action) + ', ' +
  JSON.stringify(arg === undefined ? null : arg) + ')'
)

const filesIn = dir => {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.data') || f.endsWith('.tmp')).sort()
  } catch (e) {
    return null
  }
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
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('渲染进程可用（store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  push('桩装上（只接管 AIchat；aiImageOp 仍走真主进程）', await installStub(cdp))
  await cdp.eval(buildHelpers('electerm-ai-image-persist'))
  await cdp.eval(PROBE)
  push('探针装上（卡片 / 输入框 / 请求实参都探得到）',
    await cdp.eval('!!(window.__historyCards22 && window.__pasteImage22 && window.__lastWire22)'))

  // ---------- A) 主进程磁盘层 ----------
  const dir = String(await cdp.eval('window.pre.runGlobalAsync("aiImageOp", "dir", null)'))
  push('A) aiImageOp("dir") 给的是应用数据目录下的固定子目录（渲染层不参与拼路径）',
    /electerm[\\/]ai_images$/.test(dir), { dir })
  await ipcCall(cdp, 'clear')
  await ipcCall(cdp, 'put', { id: 's22-a', dataUrl: TINY_PNG })
  push('A) put 之后目录里真有这个文件，内容就是那段 data URL',
    fs.existsSync(path.join(dir, 's22-a.data')) &&
    fs.readFileSync(path.join(dir, 's22-a.data'), 'utf8') === TINY_PNG,
    { files: filesIn(dir) })
  const getA = await ipcCall(cdp, 'get', 's22-a')
  push('A) get 原样取回（id 对得上、data URL 完整）',
    getA && getA.id === 's22-a' && getA.dataUrl === TINY_PNG,
    { id: getA && getA.id, len: getA ? String(getA.dataUrl || '').length : 0 })
  const listA = await ipcCall(cdp, 'list')
  push('A) list 只回元数据（id/bytes/mtimeMs），不把字节搬回渲染层',
    Array.isArray(listA) && listA.length === 1 && listA[0].id === 's22-a' &&
    typeof listA[0].bytes === 'number' && typeof listA[0].mtimeMs === 'number' &&
    listA[0].dataUrl === undefined, listA)

  // 引用即续期：手工把 mtime 改老，再读一次，应当被刷回"刚刚"
  const aged = Date.now() - 9 * 24 * 3600 * 1000
  fs.utimesSync(path.join(dir, 's22-a.data'), new Date(aged), new Date(aged))
  await ipcCall(cdp, 'get', 's22-a')
  const renewed = fs.statSync(path.join(dir, 's22-a.data')).mtimeMs
  push('A) 读一次就续期：mtime 回到现在（保留期看"最后用到"，不是"哪天存的"）',
    renewed > Date.now() - 60000 && renewed > aged + 1000, { aged, renewed })

  // ---------- B) 闸门 ----------
  for (const [id, dataUrl, want] of [
    ['../../evil', TINY_PNG, 'invalid-id'],
    ['s22-b', 'http://x/y.png', 'not-data-url'],
    ['s22-c', 'data:image/png;base64,', 'empty'],
    ['s22-d', 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024), 'over-single']
  ]) {
    const r = await ipcCall(cdp, 'put', { id, dataUrl })
    push('B) 非法写入只回"这次没存上"（' + want + '），不抛错不断链',
      r && r.ok === false && r.reason === want, r)
  }
  push('B) 非法 id 没在目录外面落下文件（路径穿越挡在拼接之前）',
    !fs.existsSync(path.join(path.dirname(dir), 'evil.data')) &&
    !fs.existsSync('/tmp/evil.data'), path.dirname(dir))
  push('B) 被拒的写入也没在目录里留半截文件（原子写：tmp + rename）',
    filesIn(dir).join(',') === 's22-a.data', filesIn(dir))

  // ---------- C) 配额与回收 ----------
  for (const name of ['old', 'mid', 'new']) {
    await ipcCall(cdp, 'put', { id: 's22-' + name, dataUrl: TINY_PNG })
    await sleep(60)
  }
  const listC = await ipcCall(cdp, 'list')
  push('C) 清单按"最久没被引用 → 最近引用"排序（调用方不用自己再排）',
    Array.isArray(listC) && listC.length === 4 &&
    listC.map(x => x.id).join(',') === 's22-a,s22-old,s22-mid,s22-new', listC)

  const oneBytes = listC[3].bytes
  const swept = await ipcCall(cdp, 'sweep', { budget: oneBytes })
  push('C) 超字节配额时从最久未引用的开始砍，砍完文件真的不在目录里了',
    swept.removed.join(',') === 's22-a,s22-old,s22-mid' && swept.count === 1 &&
    swept.bytes === oneBytes && filesIn(dir).join(',') === 's22-new.data', swept)

  for (const name of ['q1', 'q2', 'q3']) {
    await ipcCall(cdp, 'put', { id: 's22-' + name, dataUrl: TINY_PNG })
    await sleep(60)
  }
  const byCount = await ipcCall(cdp, 'sweep', { maxCount: 2 })
  push('C) 条数上限同样先砍最久未引用的（一堆小图也不能把目录变成几千个文件）',
    byCount.removed.join(',') === 's22-new,s22-q1' && byCount.count === 2, byCount)

  const byAge = await ipcCall(cdp, 'sweep', { now: Date.now() + 3600 * 1000, maxAgeMs: 1000 })
  push('C) 过了保留期的全部收回（保留期到点的图不会再有人引用，留着只是占配额）',
    byAge.count === 0 && byAge.removed.length === 2 && filesIn(dir).length === 0, byAge)

  const unknownOp = String(await cdp.eval(
    'window.pre.runGlobalAsync("aiImageOp", "nope", null)' +
    '.then(() => "resolved").catch(e => String((e && e.message) || e))'))
  push('C) 未知 action 明确报错，而不是静默返回 null（静默 null 会让人以为存好了）',
    /unknown aiImageOp action/.test(unknownOp), unknownOp)

  // ---------- D) 渲染层闭环 ----------
  await cdp.eval('window.store.setConfig({' +
    'modelAI: "gpt-4o", baseURLAI: "http://127.0.0.1:9/v1",' +
    'apiPathAI: "/v1/chat/completions", apiKeyAI: "stub-key", supportsImageAI: "auto",' +
    'roleAI: "You are helpful.", authHeaderNameAI: "Authorization", languageAI: "English"})')
  await cdp.eval('window.store.setAiAutoCompress && window.store.setAiAutoCompress(false)')
  push('AI 配置就绪（aiConfigMissing 为假）',
    (await cdp.eval('window.store.aiConfigMissing()')) === false,
    await cdp.eval('JSON.stringify(window.store.aiConfigMissing())'))

  // 先留一个"没有任何历史条目引用"的文件，再用清空会话来收尾：
  // 用户点清空是期待"图也没了"，磁盘副本留在原地就是骗人
  await ipcCall(cdp, 'put', { id: 's22-orphan', dataUrl: TINY_PNG })
  await cdp.eval('window.store.clearAllChatSessions && window.store.clearAllChatSessions()')
  await cdp.eval('window.store.handleOpenAIPanel()')
  push('D) AI 面板打开（输入框可见）',
    await waitFor(cdp, '!!window.__panel22()', 'panel', 8000))
  push('D) 清空会话把磁盘冷层一起清了（不留孤儿文件）',
    filesIn(dir).length === 0, filesIn(dir))

  const modePin = await cdp.eval('window.__clickMode22("Ask")')
  push('D) 模式钉回 Ask（Agent 走另一条 IPC，桩收不到）',
    modePin !== 'missing' && await waitFor(cdp, 'window.__modeNow22() === "Ask"', 'mode', 5000),
    { action: modePin, now: await cdp.eval('window.__modeNow22()') })

  const pasted = JSON.parse(await cdp.eval('window.__pasteImage22(420, 300, "#3366cc", "cold.png")'))
  push('D) 粘贴真 PNG 被接管（preventDefault 且确实采到 1 个文件）',
    pasted.notCanceled === false && pasted.files === 1, pasted)
  push('D) 图还没发就已经落盘（冷层在"进输入框"那一刻，不等点发送）',
    await waitFor(cdp, '(async () => (await window.pre.runGlobalAsync("aiImageOp", "list"))' +
      '.filter(x => x.bytes > 0).length >= 1)()', 'disk-draft', 6000), filesIn(dir))

  await cdp.eval('window.__setPrompt22("what is in this picture")')
  await sleep(150)
  push('D) 点发送', (await cdp.eval('window.__send22()')) === 'ok')
  push('D) 真的发出一次请求', await waitFor(cdp, 'window.__aiN22() >= 1', 'wire-1', 8000))
  const wire1 = JSON.parse(await cdp.eval('window.__lastWire22()'))
  push('D) 这一轮的图以 image_url 分片出境（不是占位文本）',
    wire1.kinds[wire1.kinds.length - 1] === 'array' &&
    wire1.imageParts[wire1.imageParts.length - 1] === 1 &&
    /^data:image\/png/.test(wire1.lastUrl), wire1)
  const meta1 = JSON.parse(await cdp.eval('window.__historyMeta22()'))
  push('D) 落库的历史条目仍只有元数据：base64 进磁盘，不进历史',
    meta1.entries === 1 && meta1.withImages === 1 && meta1.hasDataUrl === false, meta1)
  await cdp.shot(path.join(SHOT_DIR, '1-sent-with-disk.png'))

  // 把这张图的 mtime 改老（但仍在 14 天保留期内）：刷页之后如果它被刷回"刚刚"，
  // 就同时证明了两件事——内存层当时是空的，而字节确实是从磁盘读回来的
  const draftFile = filesIn(dir)[0]
  const coldFrom = Date.now() - 3 * 24 * 3600 * 1000
  fs.utimesSync(path.join(dir, draftFile), new Date(coldFrom), new Date(coldFrom))

  // 落库是 debounce 1s 的（流式期间每条都在重写，不能每 tick 落盘）；
  // 不等它写完就刷页，"重启后历史不见了"其实是夹具没等落盘
  await sleep(2200)
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('D) 刷新后渲染进程可用（内存缓存清空，等价于重启应用）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot-2', 40000))
  push('D) 刷新后桩重新装上', await installStub(cdp))
  await cdp.eval(buildHelpers('electerm-ai-image-persist'))
  await cdp.eval(PROBE)
  await cdp.eval('window.store.handleOpenAIPanel()')
  push('D) 刷新后历史回来了',
    await waitFor(cdp, '(window.store.aiChatHistory || []).length >= 1', 'history-2', 20000))

  const gotHydrated = await waitFor(cdp,
    'JSON.parse(window.__historyCards22()).length >= 1 && ' +
    'JSON.parse(window.__historyCards22()).every(c => !c.expired)', 'hydrated', 10000)
  const cards2 = JSON.parse(await cdp.eval('window.__historyCards22()'))
  push('D) 冷层回填：刷新后同一张图不再标"已过期"（回填完换条目身份，卡片才会重渲染）',
    gotHydrated && cards2.length === 1 && cards2[0].expired === false &&
    cards2[0].name === 'cold.png', cards2)
  const mtimeNow = fs.statSync(path.join(dir, draftFile)).mtimeMs
  push('D) 回填读的是磁盘（这次 get 把 mtime 从 3 天前刷回现在，证明内存当时没有它）',
    mtimeNow > Date.now() - 60000, { coldFrom, mtimeNow })

  const nBefore = Number(await cdp.eval('window.__aiN22()'))
  await cdp.eval('window.__setPrompt22("continue with the same picture")')
  await sleep(150)
  await cdp.eval('window.__send22()')
  push('D) 刷新后发一条纯文本', await waitFor(cdp, `window.__aiN22() >= ${nBefore + 1}`, 'wire-2', 8000))
  const wire2 = JSON.parse(await cdp.eval('window.__lastWire22()'))
  push('D) 上一轮那张图仍被真的发出去：不再降级成 [attached image unavailable]',
    wire2.placeholders === 0 &&
    wire2.imageParts.reduce((s, x) => s + x, 0) === 1 &&
    wire2.kinds.some(k => k === 'array'), wire2)
  await cdp.shot(path.join(SHOT_DIR, '2-after-reload-hydrated.png'))

  const listAfterHydrate = await ipcCall(cdp, 'list')
  push('D) 回填不复制文件（读一次只续期，目录里还是那一张）',
    listAfterHydrate.length === 1, listAfterHydrate)

  // ---------- E) 生命周期 ----------
  const entryId = await cdp.eval('window.__entryWithImage22()')
  push('E) 前置：有一条带图条目可删', !!entryId, { entryId })
  await cdp.eval(`window.store.removeAiHistory(${JSON.stringify(entryId)})`)
  await sleep(600)
  push('E) 删掉一条历史，它的磁盘副本一起走（附件 id 一次性，不需要引用计数）',
    filesIn(dir).length === 0, filesIn(dir))

  await ipcCall(cdp, 'put', { id: 's22-orphan2', dataUrl: TINY_PNG })
  await cdp.eval('window.store.clearAllChatSessions && window.store.clearAllChatSessions()')
  await sleep(600)
  push('E) 「清空全部会话」清干净磁盘', filesIn(dir).length === 0, filesIn(dir))

  push('词条仍在（图片过期提示没被这次改动带坏）',
    (await cdp.eval('window.__tr22("aiImageExpired")')) !== 'aiImageExpired')

  const netNoise = /Failed to fetch dynamically imported module|Failed to load resource/
  const hard = cdpRef.events.filter(l => {
    const s = String(l)
    return !netNoise.test(s) && /Cannot read|is not a function|TypeError|uncaught|Warning:/.test(s)
  })
  push('渲染层没有新增硬错误（换页撕掉的懒加载不算）', hard.length === 0, hard.slice(0, 6))

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
