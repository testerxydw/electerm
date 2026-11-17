#!/usr/bin/env node
/**
 * shell integration 注入卫生 CDP 实机探针
 *
 * 钉的是注入链路的三个用户可见卫生问题在真机（Electron + node-pty + 真 bash）
 * 下是否成立：
 *   1) 注入命令的回显不上屏（7f2b3d78 剥离逻辑；旧行为整条 eval 打进屏幕）；
 *   2) 注入命令不进 bash 内存 history（__e_cmd 每个 prompt 检查末条自删；
 *      主机 HISTCONTROL 无 ignorespace 时前导空格挡不住）；
 *   3) 注入命令不进 electerm 命令历史（__e_pre 633;E 指纹排除 + tracker 兜底过滤）。
 *
 * 诊断件：dataTap 抓原始输出流（chunk 边界 + 抑制态 + 时间戳），addon 实例
 * 重建自适应重挂；bash 侧 $- / ELECTERM_SHELL_INTEGRATION 守卫态、末条历史、
 * 全量 buffer dump，注入链路任何一环失效都能定位。
 *
 * 用法（先起 app，见 run-terminal-zero-loss.sh 的启动器结构）：
 *   node self-test/shell-integration-echo-cdp-probe.js 9333
 */
const http = require('node:http')
const fs = require('node:fs')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9333'
const HIST_FILE = '/tmp/electerm-si-probe-hist'
const FP = 'ELECTERM_SHELL_INTEGRATION'

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
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 反复确保当前 attachAddon 挂着 tap/包装（addon 可能被重建；按实例标记去重）
const ENSURE_TAP = `(() => {
  const inst = window.refs.get('term-' + (window.__si || {}).id)
  const addon = inst && inst.attachAddon
  if (!addon || addon.__probeTap) return 'skip'
  addon.__probeTap = true
  window.__siStream = window.__siStream || []
  window.__siEv = window.__siEv || []
  addon.addDataTap(s => window.__siStream.push({ t: Date.now(), s, sup: addon.outputSuppressed }))
  const so = addon.startOutputSuppression
  addon.startOutputSuppression = function (...a) {
    window.__siEv.push({ e: 'sup-start', t: Date.now(), timeout: a[0],
      echoLen: addon._injectionEcho ? addon._injectionEcho.length : 0 })
    return so.apply(addon, a)
  }
  const st = addon.stopOutputSuppression
  addon.stopOutputSuppression = function (...a) {
    window.__siEv.push({ e: 'sup-stop', t: Date.now(), active: addon.outputSuppressed,
      echoLen: addon._injectionEcho ? addon._injectionEcho.length : 0,
      bufChunks: addon.suppressedData.map(c => c.str.length) })
    return st.apply(addon, a)
  }
  window.__siLastAddon = addon
  return 'attached'
})()`

const waitFor = async (cdp, expr, label, timeout = 20000, ensure = null) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (ensure) await cdp.eval(ensure)
    if (await cdp.eval(expr)) return true
    await sleep(100)
  }
  console.log('TIMEOUT waiting for ' + label)
  return false
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 只开一个本地终端页签（本地 bash 与远程 ssh 走同一条 typing 注入链路）
const SETUP = `(() => {
  const store = window.store
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'SI-probe', batch: 0 })
  window.__si = { id: store.tabs[store.tabs.length - 1].id }
  store.changeActiveTabId(window.__si.id)
  window.__siStream = []
  window.__siEv = []
  return JSON.stringify(window.__si)
})()`

const READY = `(() => {
  const inst = window.refs.get('term-' + window.__si.id)
  const addon = inst && inst.attachAddon
  return !!(addon && !addon.disposed && addon.term && addon._socket && addon._socket.readyState === 1)
})()`

// 注入完成：startup-queue 的 shellInjected 标志（OSC 633 已确认）
const INJECTED = `(() => {
  const inst = window.refs.get('term-' + window.__si.id)
  const q = inst && inst.startupQueue
  return !!(q && q.shellInjected)
})()`

// 读 xterm buffer 全文（OSC 序列被 parser 消费不落 buffer；注入回显剥离与否直接可见）
const BUFFER = `(() => {
  const inst = window.refs.get('term-' + window.__si.id)
  const term = inst.attachAddon.term
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) {
    const l = buf.getLine(i)
    lines.push(l ? l.translateToString(true) : '')
  }
  return lines.join('\\n')
})()`

const send = (cdp, text) => cdp.eval(`(() => {
  const addon = window.refs.get('term-' + window.__si.id).attachAddon
  addon.sendToServer(${JSON.stringify(text)})
  return 'ok'
})()`)

const CMDHIST = 'JSON.stringify(window.store.terminalCommandHistory.map(h => h.cmd))'

// 流诊断：指纹与首个 633 各落在哪个 chunk、是否同帧合并、窗口起止时刻
const dumpStream = (stream, ev) => {
  const joined = stream.map(x => x.s).join('')
  const fpAt = joined.indexOf(FP)
  const oscAt = joined.indexOf('\x1b]633;')
  const chunkOf = pos => {
    let off = 0
    for (let i = 0; i < stream.length; i++) {
      off += stream[i].s.length
      if (pos < off) return i
    }
    return -1
  }
  console.log('stream: chunks=' + stream.length + ' total=' + joined.length +
    ' fpAt=' + fpAt + '(chunk ' + chunkOf(fpAt) + ')' +
    ' osc633At=' + oscAt + '(chunk ' + chunkOf(oscAt) + ')' +
    ' sameChunk=' + (fpAt >= 0 && oscAt >= 0 && chunkOf(fpAt) === chunkOf(oscAt)))
  for (const e of ev) {
    console.log('ev: ' + JSON.stringify(e))
  }
  if (fpAt >= 0) {
    const a = Math.max(0, fpAt - 100)
    const b = Math.min(joined.length, fpAt + 400)
    console.log('context: ' + JSON.stringify(joined.slice(a, b)))
  }
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page')
  if (!page) throw new Error('no page target')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready

  await cdp.eval(SETUP)
  check('tab created', true)
  await waitFor(cdp, READY, 'terminal ready', 20000, ENSURE_TAP)
  // tap 链路自检：发一条命令，看 stream 是否收到、账本是否增长
  await sleep(300)
  await send(cdp, 'echo TAPCHECK_OK\n')
  await sleep(500)
  const tapStat = await cdp.eval(`JSON.stringify((() => {
    const inst = window.refs.get('term-' + window.__si.id)
    const addon = inst.attachAddon
    return {
      streamLen: (window.__siStream || []).length,
      evLen: (window.__siEv || []).length,
      tapsSize: addon._dataTaps ? addon._dataTaps.size : -1,
      received: addon._receivedBytes,
      written: addon._writtenBytes,
      acked: addon._ackedBytes,
      msSinceLastData: Date.now() - addon._lastDataTime
    }
  })())`).then(s => JSON.parse(s))
  console.log('tapcheck:', JSON.stringify(tapStat))
  const injected = await waitFor(cdp, INJECTED, 'shell injected', 20000, ENSURE_TAP)
  const stream = await cdp.eval('JSON.stringify(window.__siStream || [])').then(s => JSON.parse(s))
  const ev = await cdp.eval('JSON.stringify(window.__siEv || [])').then(s => JSON.parse(s))
  // 全量流落盘：离线比对回显字节与预期注入命令（needle 匹配失败定位用）
  try { fs.writeFileSync('/tmp/electerm-si-stream.json', JSON.stringify(stream, null, 1)) } catch (e) {}
  stream.forEach((c, i) => {
    console.log('chunk[' + i + '] t=' + (c.t % 100000) + ' sup=' + (c.sup ? 1 : 0) + ' len=' + c.s.length + ' head=' + JSON.stringify(c.s.slice(0, 60)))
  })
  // addon 是否在挂 tap 之后被重建
  const alive = await cdp.eval(`JSON.stringify((() => {
    const inst = window.refs.get('term-' + window.__si.id)
    const addon = inst && inst.attachAddon
    return {
      addonReplaced: addon !== window.__siLastAddon,
      disposed: !!(addon && addon.disposed),
      outputSuppressed: !!(addon && addon.outputSuppressed),
      suppressedBufLen: addon ? addon.suppressedData.length : -1,
      suppressedChars: addon ? addon.suppressedChars : -1,
      injectionEchoSet: !!(addon && addon._injectionEcho),
      echoLen: addon && addon._injectionEcho ? addon._injectionEcho.length : 0
    }
  })())`).then(s => JSON.parse(s))
  dumpStream(stream, ev)
  console.log('addon state:', JSON.stringify(alive))
  check('shell integration injected', injected)
  check('addon instance stable since tap', !alive.addonReplaced, alive)
  await sleep(500) // 留出首个 prompt 的自删与回放余量

  // 注入链路诊断：注入是否真的执行过（shellType 由注入流程探测）？
  const diag = await cdp.eval(`JSON.stringify((() => {
    const inst = window.refs.get('term-' + window.__si.id)
    const q = inst.startupQueue || {}
    const tracker = inst.cmdAddon || {}
    return {
      shellInjected: q.shellInjected,
      shellType: q.shellType,
      queueLen: (q.queue || []).length,
      reported: tracker.reportedCommand !== undefined ? tracker.reportedCommand : null,
      executed: tracker.executedCommand ? String(tracker.executedCommand).slice(0, 60) : null,
      cwdReported: inst.cwd || null
    }
  })())`).then(s => JSON.parse(s))
  console.log('diag:', JSON.stringify(diag))
  // 注意：diag 时还没有任何用户命令执行过，633;E 尚未出现属正常；
  // 通道存活改在真实命令执行后判定（见下方 osc 633 alive 检查）

  // bash 侧决定性证据：守卫两条件（$- 交互位 + 环境变量）、PROMPT_COMMAND
  // 是否含 __e_cmd（$((1+1)) 展开后的 PC_YES_2 只可能来自输出行）、末条历史。
  // 变量引用用 $VAR 形态（注入已 export 为 1，足够判定；避免字面 ${ 触发 lint）
  await send(cdp, 'echo GUARD_I=$- VAR=[$ELECTERM_SHELL_INTEGRATION]; [[ "$PROMPT_COMMAND" == *__e_cmd* ]] && echo PC_YES_$((1+1)) || echo PC_NO_$((1+1)); fc -ln -1\n')
  await sleep(700)

  // 1) 注入回显不上屏。判据用注入行专属签名 "eval 'if [["（探针自己 typed 的
  // 命令不含它）；buffer 先扁平化——长行被 xterm 折行会切断裸子串匹配。
  const buf = await cdp.eval(BUFFER)
  const flat = buf.replace(/\n/g, '')
  const hasMark = flat.includes("eval 'if [[")
  check('injection echo stripped from screen', !hasMark, hasMark ? 'buffer contains the injected eval line' : undefined)
  check('injection helper defs not on screen', !flat.includes('__e_esc() {') && !flat.includes('__e_pre() {'), undefined)
  const pcYes = buf.includes('PC_YES_2')
  const pcNo = buf.includes('PC_NO_2')
  check('bash executed the injected script (PROMPT_COMMAND set)', pcYes && !pcNo, { pcYes, pcNo })
  const gi = buf.match(/GUARD_I=([^\s]*)\s*VAR=\[([^\]]*)\]/)
  console.log('guard:', gi ? JSON.stringify({ flags: gi[1], envVar: gi[2] }) : 'not found')
  console.log('buffer tail:', JSON.stringify(buf.slice(Math.max(0, buf.length - 900))))

  // 2) bash 内存 history：真实命令入史、注入行被自删
  try { fs.unlinkSync(HIST_FILE) } catch (e) {}
  await send(cdp, 'echo SI_PROBE_OK\n')
  await sleep(600)
  await send(cdp, `history -w ${HIST_FILE}\n`)
  await sleep(800)
  let hist = ''
  try { hist = fs.readFileSync(HIST_FILE, 'utf8') } catch (e) { hist = '' }
  console.log('history dump (' + hist.split('\n').length + ' lines):')
  console.log(hist.split('\n').map((l, i) => '  [' + i + '] ' + l.slice(0, 120)).join('\n'))
  check('real command stays in bash history', hist.includes('echo SI_PROBE_OK'), undefined)
  check('injected line deleted from bash history', !hist.includes("eval 'if [["), hist.includes("eval 'if [[") ? 'history dump had the injected eval line' : undefined)

  // 3) electerm 命令历史（633;E 上报路径）。泄漏判据用注入行签名；
  //    宽匹配 FP/__e_ 会误伤探针自己 typed 的含这些串的真实命令。
  const cmds = JSON.parse(await cdp.eval(CMDHIST))
  const leaked = cmds.filter(c => c.includes("eval 'if [["))
  check('injected line not in electerm command history', leaked.length === 0, leaked.slice(0, 2))
  check('real command in electerm command history', cmds.some(c => c.includes('echo SI_PROBE_OK')), undefined)
  // 通道存活：真实命令已被 633;E 上报（tracker.reportedCommand 翻转）
  const reportedNow = await cdp.eval("(window.refs.get('term-' + window.__si.id).cmdAddon || {}).reportedCommand === true")
  check('osc 633 channel alive (real command reported)', reportedNow === true, { reportedNow })

  try { fs.unlinkSync(HIST_FILE) } catch (e) {}
  const failed = results.filter(r => !r.ok)
  console.log('---')
  console.log(`probe done: ${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('probe error:', e.message)
  process.exit(2)
})
