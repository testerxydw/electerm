#!/usr/bin/env node
/**
 * CDP 实机探针：验证归档回放管线（replayArchive + 账本收敛）
 *
 * 隔离 HOME 下跑诊断构建；node 侧读真实 HOME 的 lossless bin，
 * 经 CDP 调 addon.replayArchive(字节) 灌入渲染层，断言账本收敛。
 *
 * 用法：
 *   node /tmp/electerm-replay-probe.js <debugPort> <binPath>
 */
const http = require('node:http')
const fs = require('node:fs')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9230'
const BIN = process.argv[3] || ''

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => resolve(JSON.parse(body)))
  }).on('error', reject)
})

const STUB = `
(() => {
  window.__termOf = id => window.refs.get('term-' + id)
  window.__addonOf = id => {
    const t = window.__termOf(id)
    return t && t.attachAddon ? t.attachAddon : null
  }
  window.__buf = id => {
    const t = window.__termOf(id)
    const term = t && t.term
    if (!term) return ''
    const b = term.buffer.active
    const out = []
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i)
      if (line) out.push(line.translateToString(true))
    }
    return out.join('\\n')
  }
  window.__stats = id => {
    const fn = window.__termFlowStats && window.__termFlowStats[id]
    return fn ? fn() : null
  }
  window.__replay = (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const addon = window.__addonOf(window.__t.tabId)
    if (!addon) return Promise.resolve({ error: 'no-addon' })
    return addon.replayArchive(bytes)
  }
  return 'stub-installed'
})()
`

const SETUP = `
(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'replay', production: false, batch: 0 })
  const tabId = store.tabs[store.tabs.length - 1].id
  window.__t = { tabId }
  store.changeActiveTabId(tabId)
  return tabId
})()
`

const READY = `
(() => {
  const id = window.__t && window.__t.tabId
  if (!id) return false
  const tab = window.store.tabs.find(t => t.id === id)
  const addon = window.__addonOf(id)
  return !!tab && tab.status === 'success' && !!addon && !addon.disposed
})()
`

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString())
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression, awaitPromise = false) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 120))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await cdp.eval(expr)
    if (ok) return true
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return false
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  if (!BIN || !fs.existsSync(BIN)) {
    throw new Error('usage: node probe.js <debugPort> <binPath>')
  }
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) throw new Error('no renderer page target; is app started with --remote-debugging-port?')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  const storeReady = await waitFor(cdp, '!!(window.store && window.refs)', 'store ready', 25000)
  check('渲染层 store/refs 就绪', storeReady)
  if (!storeReady) process.exit(1)

  await cdp.eval(STUB)
  const tabId = await cdp.eval(SETUP)
  const ready = await waitFor(cdp, READY, 'local shell connected', 25000)
  check('本地终端就绪', ready, tabId)
  if (!ready) {
    console.log('abort: no terminal')
    process.exit(1)
  }

  // 读 bin（node 侧，真实 HOME），b64 传 CDP
  const bin = fs.readFileSync(BIN)
  const total = bin.length
  const b64 = bin.toString('base64')
  console.log(`replaying ${total} bytes via addon.replayArchive`)

  const stats0 = await cdp.eval(`JSON.stringify(window.__stats(${JSON.stringify(tabId)}))`)
  check('__termFlowStats 账本可读', stats0 && stats0 !== 'null', stats0)

  const res = await cdp.eval(`window.__replay(${JSON.stringify(b64)})`, true)
  check('replayArchive 返回成功', res && res.ok, res)

  // 等待管线排空：acked >= 回放实际喂入字节（回放 fed，非文件字节；剥 OSC 后有差）
  const fedTarget = (res && res.ok && res.fed) || 0
  const drained = await waitFor(
    cdp,
    `(() => {
      const s = window.__stats(${JSON.stringify(tabId)})
      return !!s && s.ackedBytes >= ${fedTarget}
    })()`,
    'pipeline drained',
    30000
  )
  await sleep(1500)
  const stats = JSON.parse(await cdp.eval(`JSON.stringify(window.__stats(${JSON.stringify(tabId)}))`))
  // shell 首屏输出也计入 received；回放字节是 received 增量的下限
  check('账本收敛（received 覆盖回放字节）', drained && stats.receivedBytes >= fedTarget, {
    received: stats.receivedBytes,
    written: stats.writtenBytes,
    acked: stats.ackedBytes,
    dropped: stats.droppedBytes
  })
  check('droppedBytes == 0', stats.droppedBytes === 0, stats.droppedBytes)
  check('pending/inflight 已清空', stats.pendingBytes === 0 && stats.inflightBytes === 0,
    { pending: stats.pendingBytes, inflight: stats.inflightBytes })

  // 屏幕出现回放内容：取一个归档内较独特的行做子串校验
  const buf = await cdp.eval(`window.__buf(${JSON.stringify(tabId)})`)
  const bufNorm = String(buf).replace(/\s+/g, '')
  console.log('buffer tail:\n' + buf.split('\n').filter(l => l.trim()).slice(-6).map(l => '  | ' + l.replace(/\s+$/, '')).join('\n'))
  // 取 bin 解码后非空白/非控制字符的长片段（40 字符）作为屏幕命中判据
  // no-control-regex 拦 \x1b 字面量，用 String.fromCharCode 构造正则绕开。
  const binText = Buffer.from(bin).toString('utf8')
  const escSeq = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g')
  const ctlSeq = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']+', 'g')
  const printable = binText.replace(escSeq, '').replace(ctlSeq, ' ').replace(/\s+/g, ' ').trim()
  const sample = printable.slice(0, 40)
  check('屏幕包含回放输出片段', sample.length > 8 && bufNorm.includes(sample.replace(/\s+/g, '')), { sample })

  const failed = results.filter(r => !r.ok)
  console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
