#!/usr/bin/env node
/**
 * AI 图片输入（第二批）—— CDP 实机验收（桩模型，无需真 AI 服务）
 *
 * 逐条量这些行为：
 *   A) 粘贴图片：剪贴板里真有图才接管，纯文本粘贴照旧落进输入框。
 *   B) 附件卡片：缩略图 + 名字 + 尺寸/体积；发出去之前一次 AI 请求都不该发生。
 *   C) 请求形态：只有 OpenAI Chat 带 content 数组（text + image_url），
 *      prompt 参数仍是字符串（主进程对它做 includes）；历史条目只存元数据，
 *      不含 data:image 的 base64。
 *   D) 能力闸门：用户覆盖为 off 时出现芯片 + 警告卡 + 横幅，发送被拦，
 *      「仍要发送」放行一次；路径不是 /chat/completions 时连放行都不给。
 *   E) 重启降级：内存缓存没了，历史卡片标灰，下一轮把上一轮的图换成
 *      [attached image unavailable: ...] 占位符，绝不静默丢图。
 *
 * 用法：
 *   1) npm run compile
 *   2) rsync -a src/app/ work/app/   # 词条在主进程里 require
 *   3) Xvfb :131 -nolisten tcp &
 *      DISPLAY=:131 HOME=/tmp/electerm-img/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9226 --no-sandbox --window-size=1600,1000
 *   4) node self-test/db-ai-image-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9226'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-ai-image-shots')

// 桩只做两件事：接住 AIchat（记下实参，直接给一段非流式回复，免去轮询），
// 其余 IPC 一律回 null。AIchat 的位次：0 prompt / 1 model / 2 role / 3 baseURL
// / 4 apiPath / 5 apiKey / 6 proxy / 7 stream / 8 authHeaderName / 9 messages
const FIXTURE = `
(() => {
  // 只接管 AIchat，其余 IPC 原样转发：dbAction 走的也是 runGlobalAsync，
  // 一律回 null 会让历史的落库写入静默失败，重启后"历史没了"其实是夹具吞了写
  if (!window.__origRGA) {
    window.__origRGA = window.pre.runGlobalAsync.bind(window.pre)
  }
  window.__aiSeq = 0
  window.__aiCalls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'AIchat') {
      window.__aiSeq = window.__aiSeq + 1
      window.__aiCalls.push({
        n: window.__aiSeq,
        prompt: a[0],
        model: String(a[1] || ''),
        stream: a[7] === true,
        messages: a[9]
      })
      return Promise.resolve({ response: 'noted' })
    }
    return window.__origRGA(name, ...a)
  }
  window.pre.__imgstub = 'stub'
  return 'stub-installed'
})()
`

// 页内探针。所有读图信息都只回前缀/长度，别把几百 KB 的 base64 搬回 node
const PROBE = `
(() => {
  const visBy = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__panel = () => visBy('.ai-chat-history')[0] ? visBy('.ai-chat-textarea')[0] : null
  window.__lastWire = () => {
    const c = window.__aiCalls[window.__aiCalls.length - 1]
    if (!c) return JSON.stringify({ none: 1 })
    const msgs = Array.isArray(c.messages) ? c.messages : []
    const last = msgs[msgs.length - 1] || {}
    const content = last.content
    const parts = Array.isArray(content)
      ? content.map(p => ({
        type: p && p.type,
        text: p && p.type === 'text' ? String(p.text || '').slice(0, 120) : undefined,
        url: p && p.type === 'image_url' ? String((p.image_url || {}).url || '').slice(0, 24) : undefined,
        urlLen: p && p.type === 'image_url' ? String((p.image_url || {}).url || '').length : undefined
      }))
      : null
    return JSON.stringify({
      n: c.n,
      promptType: typeof c.prompt,
      prompt: String(c.prompt || '').slice(0, 160),
      stream: c.stream,
      model: c.model,
      msgCount: msgs.length,
      lastRole: last.role,
      lastType: Array.isArray(content) ? 'array' : typeof content,
      parts,
      allContentTypes: msgs.map(m => Array.isArray(m.content) ? 'array' : typeof m.content)
    })
  }
  // 历史里的图片是元数据；这里直接回答"落库的条目里有没有 base64/缩略图"
  window.__historyStats = () => {
    const sid = window.store.currentChatSessionId
    const h = (window.store.aiChatHistory || []).filter(x => x.chatSessionId === sid)
    const text = JSON.stringify(h)
    return JSON.stringify({
      entries: h.length,
      withImages: h.filter(x => (x.images || []).length).length,
      imageMeta: h.flatMap(x => (x.images || []).map(i => ({
        name: i.name, w: i.width, h: i.height, bytes: i.bytes, keys: Object.keys(i)
      }))),
      hasDataUrl: text.indexOf('data:image') >= 0,
      hasThumb: text.indexOf('thumbDataUrl') >= 0
    })
  }
  window.__placeholders = () => JSON.stringify(
    (window.__aiCalls[window.__aiCalls.length - 1] || { messages: [] }).messages
      .map(m => typeof m.content === 'string' ? m.content : '')
      .filter(t => t.indexOf('[attached image unavailable:') >= 0)
  )
  window.__cards = () => JSON.stringify(visBy('.ai-image-card').map(c => {
    const img = c.querySelector('.ai-image-thumb')
    return {
      name: String((c.querySelector('.ai-image-name') || {}).innerText || ''),
      size: String((c.querySelector('.ai-image-size') || {}).innerText || ''),
      thumb: img ? String(img.getAttribute('src') || '').slice(0, 22) : '',
      warn: c.className.indexOf('is-warn') >= 0,
      expired: c.className.indexOf('is-expired') >= 0,
      where: c.closest('.ai-chat-item-attachments') ? 'history' : 'composer'
    }
  }))
  // 草稿卡片与历史卡片分开读：两边都是 .ai-image-card，混在一起数会把
  // "历史里已有两条"当成"输入框里贴上了图"，判据就永远绿
  window.__composerCards = () => JSON.stringify(
    visBy('.ai-chat-input .ai-image-card').map(c => {
      const img = c.querySelector('.ai-image-thumb')
      return {
        name: String((c.querySelector('.ai-image-name') || {}).innerText || ''),
        size: String((c.querySelector('.ai-image-size') || {}).innerText || ''),
        thumb: img ? String(img.getAttribute('src') || '').slice(0, 22) : '',
        warn: c.className.indexOf('is-warn') >= 0
      }
    })
  )
  window.__historyCards = () => JSON.stringify(
    visBy('.ai-chat-history .ai-image-card').map(c => {
      const img = c.querySelector('.ai-image-thumb')
      return {
        name: String((c.querySelector('.ai-image-name') || {}).innerText || ''),
        size: String((c.querySelector('.ai-image-size') || {}).innerText || ''),
        thumb: img ? String(img.getAttribute('src') || '').slice(0, 22) : '',
        expired: c.className.indexOf('is-expired') >= 0,
        title: String(c.getAttribute('title') || '')
      }
    })
  )
  window.__chip = () => {
    const c = visBy('.ai-image-cap-chip')[0]
    if (!c) return 'none'
    return JSON.stringify({
      cls: String(c.className),
      text: String(c.innerText || '').trim(),
      title: String(c.getAttribute('title') || '')
    })
  }
  window.__blocked = () => {
    const b = visBy('.ai-image-blocked')[0]
    if (!b) return 'none'
    return JSON.stringify({
      text: String((b.querySelector('.ai-image-blocked-text') || b).innerText || '').trim().slice(0, 120),
      sendAnyway: !!b.querySelector('.ai-image-send-anyway'),
      goSettings: !!b.querySelector('.ai-image-go-settings')
    })
  }
  window.__clickSendAnyway = () => {
    const b = visBy('.ai-image-blocked')[0]
    const x = b && b.querySelector('.ai-image-send-anyway')
    if (!x) return 'missing'
    x.click()
    return 'ok'
  }
  window.__setPrompt = text => {
    const el = visBy('.ai-chat-textarea')[0]
    if (!el) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, String(text))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__send = () => {
    const i = visBy('.send-to-ai-icon')[0]
    if (!i) return 'no-send-icon'
    i.click()
    return 'ok'
  }
  // 生成一张真 PNG 并当成剪贴板内容派发 paste。返回 dispatchEvent 的结果：
  // true = 没被 preventDefault（纯文本粘贴就该如此）
  window.__pasteImage = (w, h, color, name) => new Promise(resolve => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    x.fillStyle = color
    x.fillRect(0, 0, w, h)
    x.fillStyle = '#fff'
    x.font = '24px sans-serif'
    x.fillText(String(name || 'shot'), 12, 40)
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
      const notCanceled = ta.dispatchEvent(ev)
      resolve(JSON.stringify({ notCanceled, files: dt.files.length }))
    }, 'image/png')
  })
  window.__pasteText = text => {
    const ta = visBy('.ai-chat-textarea')[0]
    if (!ta) return JSON.stringify({ error: 'no-textarea' })
    const dt = new DataTransfer()
    dt.setData('text/plain', String(text))
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    const notCanceled = ta.dispatchEvent(ev)
    return JSON.stringify({ notCanceled, files: dt.files.length })
  }
  window.__toast = () => {
    const list = [...document.querySelectorAll('.message-item, .ant-message-notice-content')].filter(window.__vis)
    return list.length ? String(list[list.length - 1].innerText).replace(/\\s+/g, ' ').trim() : ''
  }
  window.__aiN = () => Number(window.__aiSeq)
  window.__stubAlive = () => !!(window.pre && window.pre.__imgstub === 'stub')
  window.__tr = k => String(window.translate(k))
  return 'img-probe'
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
    if (await cdp.eval('!!(window.pre && window.pre.__imgstub === "stub")')) {
      return true
    }
    await cdp.eval(FIXTURE)
    await sleep(300)
    if (await cdp.eval('window.__stubAlive && window.__stubAlive()')) {
      return true
    }
  }
  return false
}

const waitWire = async (cdp, n, label) => waitFor(cdp, 'window.__aiN() >= ' + n, label, 8000)

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
  await cdp.call('Network.enable')
  await cdp.call('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('重启后渲染进程可用（store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

  push('桩装上（AIchat 记住实参，其它 IPC 回 null）', await installStub(cdp))

  await cdp.eval(buildHelpers('electerm-db-sql-value-split'))
  await cdp.eval(PROBE)
  push('探针装上（卡片/芯片/横幅/输入框都探得到）',
    await cdp.eval('!!(window.__cards && window.__chip && window.__blocked && window.__pasteImage)'))

  // 高能力 + Chat 通道：这是"什么都不该提示"的对照组
  await cdp.eval(`window.store.setConfig({
    modelAI: 'gpt-4o',
    baseURLAI: 'http://127.0.0.1:9/v1',
    apiPathAI: '/v1/chat/completions',
    apiKeyAI: 'stub-key',
    languageAI: '中文',
    supportsImageAI: 'auto'
  })`)
  await cdp.eval('window.store.setAiAutoCompress && window.store.setAiAutoCompress(false)')
  await sleep(300)
  push('AI 配置就绪（aiConfigMissing 为假）',
    (await cdp.eval('window.store.aiConfigMissing()')) === false)
  push('词条落地：过期提示不是 key 本身',
    (await cdp.eval('window.__tr("aiImageExpired")')) !== 'aiImageExpired')

  // 清空历史再开：脚本要能被重复跑，上一轮留下的条目会让"历史里有几条"的判据失真
  await cdp.eval('window.store.clearAllChatSessions && window.store.clearAllChatSessions()')
  await cdp.eval('window.store.handleOpenAIPanel()')
  push('AI 面板打开（输入框可见）',
    await waitFor(cdp, '!!window.__panel()', 'panel', 8000))
  await sleep(500)

  push('A) 能力判定为支持（gpt-4o）时芯片不出现：没有要动手的事就不占位置',
    (await cdp.eval('window.__chip()')) === 'none', await cdp.eval('window.__chip()'))
  push('A) 初始没有图片卡片', (await cdp.eval('window.__composerCards()')) === '[]')

  // ---------- 粘贴图片 ----------
  const pasted = JSON.parse(await cdp.eval(
    'window.__pasteImage(640, 360, "#3366cc", "shot.png")'
  ))
  push('A) 粘贴真 PNG：事件被接管（preventDefault），并且确实采到 1 个文件',
    pasted.notCanceled === false && pasted.files === 1, pasted)
  push('B) 附件卡片出现（缩略图 + 名字 + 尺寸）',
    await waitFor(cdp, 'JSON.parse(window.__composerCards()).length > 0', 'card', 6000))
  const card1 = JSON.parse(await cdp.eval('window.__composerCards()'))[0] || {}
  push('B) 卡片内容正确：data:image 缩略图、shot.png、640×360 与体积、未标警告',
    /^data:image\/png/.test(card1.thumb) && card1.name === 'shot.png' &&
    /640×360/.test(card1.size) && card1.warn === false, card1)
  push('B) 粘贴之后还没发请求（图片只是草稿）',
    Number(await cdp.eval('window.__aiN()')) === 0)

  const textPaste = JSON.parse(await cdp.eval('window.__pasteText("hello world")'))
  push('A) 纯文本粘贴不被接管（dispatchEvent 返回 true），卡片数不变',
    textPaste.notCanceled === true &&
    JSON.parse(await cdp.eval('window.__composerCards()')).length === 1, textPaste)
  await cdp.shot(path.join(SHOT_DIR, '1-pasted-card.png'))

  // ---------- 文本 + 图片发送 ----------
  await cdp.eval('window.__setPrompt("look at this screenshot")')
  await sleep(150)
  push('点发送图标', await cdp.eval('window.__send()') === 'ok')
  push('C) 带图发送真的发了一次请求', await waitWire(cdp, 1, 'wire-1'))
  const wire1 = JSON.parse(await cdp.eval('window.__lastWire()'))
  push('C) prompt 参数仍是字符串（主进程对它 includes，不是数组）',
    wire1.promptType === 'string' && wire1.prompt.indexOf('look at this screenshot') >= 0, wire1)
  push('C) 最后一条 user 的 content 是分片数组：text 原句 + image_url 的 data URL',
    wire1.lastType === 'array' && wire1.parts.length === 2 &&
    wire1.parts[0].type === 'text' &&
    wire1.parts[0].text.indexOf('look at this screenshot') >= 0 &&
    wire1.parts[1].type === 'image_url' &&
    /^data:image\/png/.test(wire1.parts[1].url) && wire1.parts[1].urlLen > 1000,
    wire1.parts)
  const hist1 = JSON.parse(await cdp.eval('window.__historyStats()'))
  push('C) 历史条目只存图片元数据：没有 data:image、没有缩略图 base64',
    hist1.entries === 1 && hist1.withImages === 1 &&
    hist1.imageMeta[0].name === 'shot.png' && hist1.imageMeta[0].w === 640 &&
    hist1.hasDataUrl === false && hist1.hasThumb === false, hist1)
  push('B) 发送后草稿卡片清空',
    (await cdp.eval('window.__composerCards()')) === '[]')

  // ---------- 只有图片、没有文字 ----------
  await cdp.eval('window.__pasteImage(320, 240, "#cc6633", "two.png")')
  await waitFor(cdp, 'JSON.parse(window.__composerCards()).length > 0', 'card-2', 6000)
  await cdp.eval('window.__send()')
  push('C) 只有图片也能发（没有文字不等于没有输入）', await waitWire(cdp, 2, 'wire-2'))
  const wire2 = JSON.parse(await cdp.eval('window.__lastWire()'))
  push('C) 纯图消息的 content 只有 image_url 一片，prompt 是空字符串',
    wire2.lastType === 'array' && wire2.parts.length === 1 &&
    wire2.parts[0].type === 'image_url' && wire2.prompt === '', wire2)

  // ---------- 能力判定为纯文本 ----------
  await cdp.eval('window.store.setConfig({ supportsImageAI: "off" })')
  await sleep(400)
  const chipNo = JSON.parse(await cdp.eval('window.__chip()'))
  push('D) 判定为纯文本时出现芯片（is-no，来源写明是用户覆盖）',
    /is-no/.test(chipNo.cls) && /You set this|设置/.test(chipNo.title), chipNo)
  await cdp.eval('window.__pasteImage(400, 300, "#229944", "blocked.png")')
  await waitFor(cdp, 'JSON.parse(window.__composerCards()).length > 0', 'card-3', 6000)
  const blockedCard = JSON.parse(await cdp.eval('window.__composerCards()'))[0] || {}
  push('D) 图片卡片描警告色', blockedCard.warn === true, blockedCard)
  const banner1 = JSON.parse(await cdp.eval('window.__blocked()'))
  push('D) 横幅说明原因，并给「仍要发送」与「去设置」两条出路',
    banner1.sendAnyway === true && banner1.goSettings === true && banner1.text.length > 4, banner1)
  await cdp.shot(path.join(SHOT_DIR, '2-capability-blocked.png'))

  const nBeforeBlock = Number(await cdp.eval('window.__aiN()'))
  await cdp.eval('window.__send()')
  await sleep(600)
  push('D) 点发送被拦住：一次请求都不发，只提示原因',
    Number(await cdp.eval('window.__aiN()')) === nBeforeBlock &&
    /纯文本|text-only|看不懂/i.test(await cdp.eval('window.__toast()')),
    { n: await cdp.eval('window.__aiN()'), toast: await cdp.eval('window.__toast()') })

  push('D) 点「仍要发送」放行这次草稿（横幅消失）',
    await cdp.eval('window.__clickSendAnyway()') === 'ok' &&
    await waitFor(cdp, 'window.__blocked() === "none"', 'banner-gone', 4000))
  await cdp.eval('window.__send()')
  push('D) 放行后这次真的发出去了，并带上图片分片',
    await waitWire(cdp, nBeforeBlock + 1, 'wire-anyway'))
  const wire3 = JSON.parse(await cdp.eval('window.__lastWire()'))
  push('D) 放行后的请求里图片仍在（不是“点头了但还是没带”）',
    wire3.lastType === 'array' && wire3.parts.some(p => p.type === 'image_url'), wire3)

  // ---------- 通道不带图：连「仍要发送」都不给 ----------
  await cdp.eval('window.store.setConfig({ supportsImageAI: "auto", apiPathAI: "/v1/messages" })')
  await sleep(400)
  const chipT = JSON.parse(await cdp.eval('window.__chip()'))
  push('D) 换成 /messages 后芯片变 is-transport（通道问题优先于能力）',
    /is-transport/.test(chipT.cls), chipT)
  await cdp.eval('window.__pasteImage(360, 200, "#8844aa", "transport.png")')
  await waitFor(cdp, 'JSON.parse(window.__composerCards()).length > 0', 'card-4', 6000)
  const banner2 = JSON.parse(await cdp.eval('window.__blocked()'))
  push('D) 通道横幅没有「仍要发送」：图会在构造请求体时被压掉，点头也救不回来',
    banner2.sendAnyway === false && banner2.goSettings === true, banner2)
  const nBeforeT = Number(await cdp.eval('window.__aiN()'))
  await cdp.eval('window.__send()')
  await sleep(600)
  push('D) 通道不对时发送被拦，请求数不变',
    Number(await cdp.eval('window.__aiN()')) === nBeforeT)
  await cdp.shot(path.join(SHOT_DIR, '3-transport-blocked.png'))

  // ---------- 重启：缓存没了，但不静默丢图 ----------
  await cdp.eval('window.store.setConfig({ apiPathAI: "/v1/chat/completions" })')
  const kept = JSON.parse(await cdp.eval('window.__historyStats()'))
  push('E) 重启前会话里有 3 条带图条目（夹具前置）', kept.entries === 3 && kept.withImages === 3, kept)
  // 历史落库是 debounce 1000ms 的（流式期间每条都在重写，不能每 tick 落盘）。
  // 发完立刻刷页会读到还没写进去的库，重启后"历史不见了"其实是夹具没等落盘
  await sleep(2200)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2200)
  push('重启后渲染进程可用',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot-2', 40000))
  push('重启后桩重新装上', await installStub(cdp))
  await cdp.eval(buildHelpers('electerm-db-sql-value-split'))
  await cdp.eval(PROBE)
  await cdp.eval('window.store.handleOpenAIPanel()')
  push('重启后 AI 面板与历史都回来了',
    await waitFor(cdp, 'window.__panel() && (window.store.aiChatHistory || []).length >= 3', 'panel-2', 20000),
    await cdp.eval('JSON.stringify({ panel: !!window.__panel(), n: (window.store.aiChatHistory || []).length })'))

  const expired = JSON.parse(await cdp.eval('window.__historyCards()'))
  push('E) 历史里的图片卡片仍在，但全部标灰（is-expired）且没有缩略图',
    expired.length >= 3 &&
    expired.every(c => c.expired && c.thumb === '' && /占位符|过期|expired|placeholder/i.test(c.title)),
    expired)

  const nAfterReload = Number(await cdp.eval('window.__aiN()'))
  await cdp.eval('window.__setPrompt("continue the conversation")')
  await sleep(150)
  await cdp.eval('window.__send()')
  push('E) 重启后发一条纯文本', await waitWire(cdp, nAfterReload + 1, 'wire-reload'))
  const wire4 = JSON.parse(await cdp.eval('window.__lastWire()'))
  const placeholders = JSON.parse(await cdp.eval('window.__placeholders()'))
  push('E) 上一轮已过期的图换成占位符文本，而不是静默消失',
    placeholders.length >= 2 &&
    placeholders.some(t => t.indexOf('shot.png') >= 0) &&
    placeholders.some(t => t.indexOf('two.png') >= 0), placeholders)
  push('E) 过期图不再被当成 image_url 发出去（历史里没有分片数组）',
    wire4.lastType === 'string' && wire4.allContentTypes.every(t => t !== 'array'),
    wire4.allContentTypes)
  await cdp.shot(path.join(SHOT_DIR, '4-expired-after-reload.png'))

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
