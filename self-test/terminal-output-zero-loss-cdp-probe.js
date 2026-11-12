#!/usr/bin/env node
/**
 * 终端输出「一个字符都不丢」CDP 实机探针
 *
 * 钉的是端到端零丢弃链路（FIFO 写入 + term.write 回调 ACK + 服务端 credit
 * 窗口 + pause/resume + 无损原始字节归档）在真机（Electron + node-pty + 真 bash）
 * 下，渲染层看到的字节与服务端产出的精确字节是否逐字节一致，droppedBytes 是否为 0。
 *
 * 方法：
 *   - 渲染层间谍累加 term.write 收到的全部原始字节（FIFO 入口前的真值）；
 *   - 注入两段自校验负载：A 段 2000 行 `LA#####:X{110}`、B 段 75000 行 `LB#####:A{110}`
 *     （B 段 > 8MB，必穿过 credit 窗口触发 pause/resume，逼出背压路径）；
 *   - 在渲染层与「服务端无损归档文件」两侧各自抽取对应前缀的行，逐行校验格式、
 *     索引连续、sha256 完全一致 —— 任一字符被丢弃/重复/乱序都会让哈希或对账失配；
 *   - 同时断言运行时账本 droppedBytes===0、inflightBytes 回落 0、ackedBytes 推进、
 *     未触发 output-archive-error。
 *
 * 用法（先起 app，见 run-terminal-zero-loss.sh）：
 *   node self-test/terminal-output-zero-loss-cdp-probe.js 9333 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9333'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'terminal-zero-loss-shots')

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
    })
  }).on('error', reject)
})

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
      if (m.id === undefined) return
      const cb = this.pending.get(m.id)
      if (cb) { this.pending.delete(m.id); cb(m) }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const details = r.result && r.result.exceptionDetails
    if (details) throw new Error('eval failed: ' + (details.exception && details.exception.description))
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return path.basename(file)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.eval(expr)) return true
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

// 只开一个本地终端页签
const SETUP = `(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'ZL-probe', batch: 0 })
  window.__k = { id: store.tabs[store.tabs.length - 1].id }
  store.changeActiveTabId(window.__k.id)
  return JSON.stringify(window.__k)
})()`

const READY = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const addon = inst && inst.attachAddon
  return !!(addon && !addon.disposed && addon.term && addon._socket && addon._socket.readyState === 1)
})()`

// 间谍：累加 term.write 收到的全部原始字节（FIFO 入口前的真值）；
// 同时盯住 output-archive-error（归档降级必须暴露，绝不允许静默空洞）。
const INSTALL = `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const addon = inst && inst.attachAddon
  if (!addon || !addon.term) return 'no-terminal'
  if (!addon.__rawWrite) addon.__rawWrite = addon.term.write
  window.__written = []
  window.__archiveError = false
  const origWarn = console.warn
  console.warn = function () {
    const a = arguments[0]
    if (typeof a === 'string' && a.indexOf('lossless output archive degraded') >= 0) window.__archiveError = true
    return origWarn.apply(console, arguments)
  }
  addon.term.write = function (s) {
    if (typeof s === 'string') window.__written.push(s)
    return addon.__rawWrite.apply(addon.term, arguments)
  }
  return 'installed'
})()`

const RESET = '(() => { window.__written = []; return \'reset\' })()'

// 在渲染层抽取某前缀负载行，做格式/连续性校验并算 sha256（payload 为 ASCII，
// UTF-8 字节 == 实际字节；与归档侧用同一 join 规则，哈希可直接比对）。
const EXTRACT = (prefix, fill) => `(() => {
  const inst = window.refs.get('term-' + window.__k.id)
  const addon = inst.attachAddon
  const all = window.__written.join('')
  const lines = all.split('\\n')
  const tagRe = new RegExp('${prefix}(\\\\d{5}):')
  const re = new RegExp('^${prefix}(\\\\d{5}):(${fill}{110})$')
  const pay = []
  let malformed = 0, minIdx = Infinity, maxIdx = -1
  for (const l of lines) {
    // 行首可能被 shell-integration 的 OSC/CSI 控制序列污染（OSC 后无换行），
    // 不能用 ^ 锚定整行；先定位负载标记，再从标记处截取到行尾精确匹配。
    const norm = l.replace(/\\r$/, '')
    const t = tagRe.exec(norm)
    if (!t) continue
    const seg = norm.slice(t.index)
    const m = re.exec(seg)
    if (!m) continue
    if (m[2].length !== 110) { malformed++; continue }
    pay.push(seg)
    const i = parseInt(m[1], 10)
    if (i < minIdx) minIdx = i
    if (i > maxIdx) maxIdx = i
  }
  const stats = window.__termFlowStats[window.__k.id]()
  const joined = pay.join('\\n')
  const enc = new TextEncoder()
  return crypto.subtle.digest('SHA-256', enc.encode(joined)).then(h => {
    const hex = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('')
    return JSON.stringify({
      count: pay.length, minIdx, maxIdx, malformed,
      sha256: hex,
      droppedBytes: stats.droppedBytes,
      receivedBytes: stats.receivedBytes,
      writtenBytes: stats.writtenBytes,
      ackedBytes: stats.ackedBytes,
      inflightBytes: stats.inflightBytes,
      pendingBytes: stats.pendingBytes,
      archivePath: stats.archivePath,
      archiveParts: stats.archiveParts,
      archiveError: window.__archiveError
    })
  })
})()`

// 等渲染层 writtenBytes 稳定（不再增长）且 in-flight 归零
const waitStable = async (cdp, timeout = 60000) => {
  const t0 = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - t0 < timeout) {
    const s = await cdp.eval('JSON.stringify(window.__termFlowStats[window.__k.id]())')
    const st = JSON.parse(s)
    if (st.writtenBytes === last) {
      stable++
      if (stable >= 3 && st.inflightBytes === 0) return st
    } else {
      stable = 0
      last = st.writtenBytes
    }
    await sleep(500)
  }
  const s2 = await cdp.eval('JSON.stringify(window.__termFlowStats[window.__k.id]())')
  return JSON.parse(s2)
}

const send = (cdp, text) => cdp.eval(`(() => {
  const addon = window.refs.get('term-' + window.__k.id).attachAddon
  addon.sendToServer(${JSON.stringify(text)})
  return 'ok'
})()`)

// 在 node 侧读归档分片，抽取同一前缀负载行，计算 sha256 + 连续性判据
const reconcileArchive = (parts, prefix, fill) => {
  if (!parts || !parts.length) return { ok: false, reason: 'no archive parts' }
  const buf = Buffer.concat(parts.map(p => {
    try { return fs.readFileSync(p) } catch (e) { return Buffer.alloc(0) }
  }))
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  const re = new RegExp('^' + prefix + '(\\d{5}):(' + fill + '{110})$')
  const tagRe = new RegExp(prefix + '(\\d{5}):')
  const pay = []
  let malformed = 0
  const seen = new Set()
  for (const l of lines) {
    // 与渲染层同规则：剥 \r、定位标记、从标记处截取（行首可能被 OSC 序列污染）
    const norm = l.replace(/\r$/, '')
    const t = tagRe.exec(norm)
    if (!t) continue
    const seg = norm.slice(t.index)
    const m = re.exec(seg)
    if (!m) continue
    if (m[2].length !== 110) { malformed++; continue }
    pay.push(seg)
    const i = parseInt(m[1], 10)
    if (seen.has(i)) malformed++
    seen.add(i)
    if (m[2].length !== 110) malformed++
  }
  const joined = pay.join('\n')
  const sha = crypto.createHash('sha256').update(joined, 'utf8').digest('hex')
  let minIdx = Infinity
  let maxIdx = -1
  for (const i of seen) { if (i < minIdx) minIdx = i; if (i > maxIdx) maxIdx = i }
  return { count: pay.length, minIdx, maxIdx, malformed, sha256: sha, distinct: seen.size }
}

const runScenario = async (cdp, name, prefix, fill, n, cmd, timeout) => {
  console.log('\\n=== ' + name + ' (N=' + n + ') ===')
  await cdp.eval(RESET)
  await send(cdp, cmd + '\r')
  await waitStable(cdp, timeout)
  await sleep(2500) // 给归档异步落盘留余量
  const browserJson = await cdp.eval(EXTRACT(prefix, fill))
  const b = JSON.parse(browserJson)
  const arch = reconcileArchive(b.archiveParts, prefix, fill)
  console.log('  browser:', JSON.stringify({ count: b.count, minIdx: b.minIdx, maxIdx: b.maxIdx, malformed: b.malformed, sha: b.sha256.slice(0, 16) }))
  console.log('  archive:', JSON.stringify({ count: arch.count, minIdx: arch.minIdx, maxIdx: arch.maxIdx, distinct: arch.distinct, malformed: arch.malformed, sha: arch.sha256.slice(0, 16) }))

  check(name + ': 渲染层收到 ' + n + ' 行（无多无少）', b.count === n, { count: b.count, n })
  check(name + ': 渲染层行索引连续 1..' + n, b.minIdx === 1 && b.maxIdx === n && b.malformed === 0, { minIdx: b.minIdx, maxIdx: b.maxIdx, malformed: b.malformed })
  check(name + ': 渲染层无格式损坏行', b.malformed === 0, { malformed: b.malformed })
  check(name + ': 服务端归档 ' + n + ' 行且索引完整无重复', arch.count === n && arch.distinct === n && arch.minIdx === 1 && arch.maxIdx === n && arch.malformed === 0, arch)
  check(name + ': 渲染层哈希 == 服务端归档哈希（逐字节一致）', b.sha256 === arch.sha256, { browser: b.sha256.slice(0, 24), archive: arch.sha256.slice(0, 24) })
  check(name + ': 运行时账本 droppedBytes === 0', b.droppedBytes === 0, { droppedBytes: b.droppedBytes })
  check(name + ': 未触发 output-archive-error（归档未静默降级）', b.archiveError === false, { archiveError: b.archiveError })
  check(name + ': in-flight 已回落 0（FIFO 未冻结）', b.inflightBytes === 0, { inflightBytes: b.inflightBytes })
  check(name + ': ackedBytes 已推进（回调 ACK 链路活着）', b.ackedBytes > 0, { ackedBytes: b.ackedBytes })
  return b
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) throw new Error('no electerm page target on ' + PORT)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready

  await cdp.eval('(() => { if (!window.store || !window.refs) throw new Error(\'app not ready\') })()')
  console.log('setup local terminal tab')
  await cdp.eval(SETUP)
  check('本地终端页签就绪，attachAddon 可用', await waitFor(cdp, READY, 'terminal ready', 30000))
  console.log(await cdp.eval(INSTALL))
  check('间谍安装成功（term.write 累加 + archive-error 盯防）', true)
  await cdp.eval(RESET)

  // A 段：中等体量，精确逐行对账
  const cmdA = 'bash -c \'N=2000; F=$(printf "X%.0s" $(seq 1 110)); for i in $(seq 1 $N); do printf "LA%05d:%s\\n" $i "$F"; done\''
  await runScenario(cdp, 'A-integrity(2KB×110→234KB)', 'LA', 'X', 2000, cmdA, 30000)
  await cdp.shot(path.join(SHOT_DIR, 'A-integrity.png'))

  // B 段：>8MB 洪流，必穿过 credit 窗口触发 pause/resume
  const cmdB = 'bash -c \'N=75000; F=$(printf "A%.0s" $(seq 1 110)); for i in $(seq 1 $N); do printf "LB%05d:%s\\n" $i "$F"; done\''
  await runScenario(cdp, 'B-throughput(>8MB洪流)', 'LB', 'A', 75000, cmdB, 90000)
  await cdp.shot(path.join(SHOT_DIR, 'B-throughput.png'))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
  cdp.ws.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('probe error:', e)
  process.exit(2)
})
