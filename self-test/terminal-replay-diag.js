#!/usr/bin/env node
/**
 * 诊断构建 · 用真实客户端管线回放 lossless bin（CDP 实机）
 *
 * 目的：之前只能用 @xterm/headless 回放，证明的是「字节 + 解析器」完好；
 * 这次把同一份 bin 从 attachAddon.writeToTerminal 灌进去，走的是真实链路：
 *   TextDecoder → 抑制窗口 → 零丢弃 FIFO(16ms/批, ACK) → term.write → 渲染
 * 同时读 window.__termFlowStats（received/written/acked/dropped）和
 * main.log 里的 [terminal-render] 行（诊断构建默认开启）。
 *
 * 判据：
 *   1) 账本收敛：received == written == acked == bin 字节数，dropped == 0
 *   2) 屏幕完整：解压/设置/三个触发器/两轮 update/prompt 都在 buffer 里
 *   3) 与 session log 对照：日志里的语义行（去掉进度条）全部按序出现
 *   4) main.log 里能看到 [terminal-render] flow-stats 行
 *
 * 用法（先起 Xvfb 和诊断构建，见文件尾注释）：
 *   node self-test/terminal-replay-diag.js [debugPort] [bin] [log]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9224'
const BIN = process.argv[3] || '/home/dp25/.config/electerm/session_logs/lossless_output/lossless-bT9U8WQ_2026-11-19-09-14-45-1795050885460-000.bin'
const LOG = process.argv[4] || '/home/dp25/.config/electerm/session_logs/新连接_bT9U8WQ_2026-11-19-09-14-45.log'
const SHOT_DIR = path.join(__dirname, '2026-11-19-replay-diag-shots')
const MAIN_LOG = process.env.ELECTERM_MAIN_LOG || ''

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
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
  window.__feed = (b64, chunkSize, gap) => new Promise(resolve => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const addon = window.__addonOf(window.__t.tabId)
    if (!addon) return resolve({ error: 'no-addon' })
    let off = 0
    const step = () => {
      const end = Math.min(off + chunkSize, bytes.length)
      addon.writeToTerminal(bytes.subarray(off, end))
      off = end
      if (off >= bytes.length) return resolve({ fed: bytes.length })
      setTimeout(step, gap)
    }
    step()
  })
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

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      throw new Error('screenshot failed: ' + JSON.stringify(r.error || r.result))
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await cdp.eval(expr)
    if (ok) {
      return true
    }
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

// 折叠空白 + 折叠 ≥4 个的 . / # 填充：同一条 apt 行在 4096 列日志里与 197 列
// 真实终端里尾部点号数量必然不同，但语义部分必须一致。
const norm = s => String(s)
  .replace(/\s+/g, '')
  .replace(/\.{3,}/g, '#') // "..."（触发器提示）/ 长点号填充
  .replace(/#{2,}/g, '#') // "####" 进度填充

// 日志里的进度条/百分比行在归档里是「绝对定位覆盖写」，不会进 scrollback；
// 对照时剔除，只比语义行。
const isProgressNoise = line => (
  /MB\/s/.test(line) ||
  /^\s*\d+%/.test(line) ||
  /\.\.\. ?\d+%$/.test(line) ||
  /\[1 code \d+ MB\/\d+ MB/.test(line) ||
  /^[\s#.\]]+$/.test(line) ||
  /执行中/.test(line)
)

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  const storeReady = await waitFor(cdp, '!!(window.store && window.refs)', 'store ready', 25000)
  check('渲染层 store/refs 就绪', storeReady)
  if (!storeReady) {
    process.exit(1)
  }

  await cdp.eval(STUB)
  const tabId = await cdp.eval(SETUP)
  const ready = await waitFor(cdp, READY, 'local shell connected', 25000)
  check('本地终端就绪', ready, tabId)
  if (!ready) {
    console.log('abort: no terminal')
    process.exit(1)
  }
  // 等首屏出现任意输出（prompt 由 shell 决定，不强求 '$'）
  await waitFor(cdp, `window.__buf(${JSON.stringify(tabId)}).length > 0`, 'first output', 15000)

  // 清屏 + 清 scrollback，回放从空屏开始
  await cdp.eval(`window.__addonOf(${JSON.stringify(tabId)}).sendToServer("printf '\\\\033[2J\\\\033[3J\\\\033[H'\\r")`)
  await sleep(800)

  const bin = fs.readFileSync(BIN)
  const total = bin.length
  const b64 = bin.toString('base64')
  console.log(`feeding ${total} bytes in 4KB frames (~8ms gap) through writeToTerminal`)

  // 诊断是否默认开启：注入前先确认 hook 在线
  const stats0 = await cdp.eval(`JSON.stringify(window.__stats(${JSON.stringify(tabId)}))`)
  check('__termFlowStats 账本可读', stats0 && stats0 !== 'null', stats0)

  const fed = await cdp.eval(
    `window.__feed(${JSON.stringify(b64)}, 4096, 8)`,
    true
  )
  check('全部字节已喂入 writeToTerminal', fed && fed.fed === total, fed)

  const drained = await waitFor(
    cdp,
    `(() => {
      const s = window.__stats(${JSON.stringify(tabId)})
      return !!s && s.ackedBytes >= ${total}
    })()`,
    'pipeline drained (acked >= total)',
    30000
  )

  await sleep(1500) // 让空闲快照落一次
  const stats = JSON.parse(await cdp.eval(`JSON.stringify(window.__stats(${JSON.stringify(tabId)}))`))
  const shellBytes = stats.receivedBytes - total
  check('账本收敛 received == written == acked（无任何一段被丢）', drained &&
    stats.receivedBytes === stats.writtenBytes &&
    stats.writtenBytes === stats.ackedBytes &&
    shellBytes >= 0, { ...stats, shellBytes })
  check('droppedBytes == 0（解码器未抛错）', stats.droppedBytes === 0, stats.droppedBytes)
  check('pending/inflight 已清空', stats.pendingBytes === 0 && stats.inflightBytes === 0,
    { pending: stats.pendingBytes, inflight: stats.inflightBytes })

  const buf = await cdp.eval(`window.__buf(${JSON.stringify(tabId)})`)
  const bufNorm = norm(buf)
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.writeFileSync(path.join(SHOT_DIR, 'replayed-buffer.txt'), buf)
  const tailLines = buf.split('\n').filter(l => l.trim()).slice(-12)
  console.log('buffer tail:\n' + tailLines.map(l => '  | ' + l.replace(/\s+$/, '')).join('\n'))

  const marks = [
    '正在读取软件包列表',
    '您希望继续执行吗',
    '获取:1 https://packages.microsoft.com/repos/code',
    '已下载 295 MB',
    '准备解压 .../code_1.147.0-1794903003_amd64.deb',
    '正在解压 code (1.147.0-1794903003)',
    '正在设置 code (1.147.0-1794903003)',
    '正在处理用于 shared-mime-info',
    '正在处理用于 deepin-home-appstore-daemon',
    '正在处理用于 desktop-file-utils',
    'dp25@dp25-PC:~$'
  ]
  const missing = marks.filter(m => !bufNorm.includes(norm(m)))
  // 关键阶段还要按序出现（apt 的升级流程顺序不能乱）
  let cursor = 0
  const outOfOrder = []
  for (const m of marks) {
    const at = bufNorm.indexOf(norm(m), cursor)
    if (at < 0) {
      outOfOrder.push(m)
    } else {
      cursor = at + norm(m).length
    }
  }
  check('屏幕包含全部关键阶段', missing.length === 0, missing)
  check('关键阶段按正确顺序出现', outOfOrder.length === 0, outOfOrder)

  // 与 session log 对照：每条语义行都必须出现在 buffer 里。
  // 不做游标顺序断言：apt 的 dpkg/触发器行与 4096 列 headless 日志的行序天然
  // 有交错（日志里 准备解压 会排在 读取数据库 之前），顺序由上面的 marks 兜。
  const logLines = fs.readFileSync(LOG, 'utf8')
    .split('\n')
    .map(l => l.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] /, '').trim())
    // 日志写盘时会在物理行尾补一个 ']'（900 行里 75 行带），真实终端没有这个字符
    .map(l => l.replace(/\]$/, '').trim())
    .filter(l => l && !isProgressNoise(l))
  const lost = []
  for (const line of logLines) {
    const needle = norm(line)
    if (!needle) continue
    if (bufNorm.indexOf(needle) < 0) {
      lost.push(line)
    }
  }
  check('log 的语义行全部出现在渲染结果里（一行不缺）', lost.length === 0, {
    logLines: logLines.length,
    missing: lost.slice(0, 8)
  })

  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-replayed-buffer.png')))

  // main.log 里的诊断行
  if (MAIN_LOG && fs.existsSync(MAIN_LOG)) {
    const lines = fs.readFileSync(MAIN_LOG, 'utf8')
      .split('\n')
      .filter(l => l.includes('[terminal-render]'))
    const statsLines = lines.filter(l => l.includes('"event":"flow-stats'))
    const finalLines = lines.filter(l => l.includes('flow-stats-final'))
    const errLines = lines.filter(l => l.includes('decode-error'))
    check('main.log 收到 [terminal-render] 诊断行', lines.length > 0, lines.length)
    check('main.log 有 flow-stats 快照', statsLines.length > 0, statsLines.slice(-3))
    check('main.log 无 decode-error 行', errLines.length === 0, errLines.slice(0, 3))
    if (finalLines.length) {
      console.log('final ledger lines:', finalLines.slice(-1)[0])
    }
  } else {
    console.log('note: no main.log given (ELECTERM_MAIN_LOG), skipped log-file checks')
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

/**
 * 启动方式（诊断构建，隔离 HOME）：
 *
 *   Xvfb :111 -screen 0 1500x950x24 &
 *   rm -rf /tmp/electerm-replay-home
 *   mkdir -p /tmp/electerm-replay-home
 *   DISPLAY=:111 HOME=/tmp/electerm-replay-home \
 *     ./dist/deb-stage/opt/electerm/electerm \
 *     --remote-debugging-port=9224 --no-sandbox &
 *
 *   ELECTERM_MAIN_LOG=/tmp/electerm-replay-home/.config/electerm/logs/main.log \
 *     node self-test/terminal-replay-diag.js 9224
 */
