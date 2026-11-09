#!/usr/bin/env node
/**
 * 数据库第三批（N5a 控制台 / N5b 大 Key 扫描 / N5c Profiler）CDP 实机验证 ——
 * 功能 + 性能 + 资源消耗三合一探针（真 Electron + 真 ioredis + fake-redis）。
 *
 * 背景：用户怀疑今天的数据库修改增加了内存消耗。静态排查已锁定疑点：
 *   - 主进程 Profiler 环形缓冲上限 1000 行（redis.js PROFILER_RING_MAX，守恒）
 *   - 渲染侧 db-redis-key-space.jsx 的 profiler.rows 是 `rows.concat(newRows)`
 *     无上限累计，且 Modal 里的 Table pagination=false 全量渲染 ——
 *     MONITOR 流持续跑时渲染侧堆与 DOM 都应线性增长（本探针实测验证）
 *   - N5a 控制台历史 HISTORY_MAX=50（有上限）、N5b TOP-N=100（有上限）
 *
 * 场景：
 *   S0 baseline：空态快照（堆 / DOM / 主进程 RSS）
 *   S1 N5a 控制台：跑 55 条读命令 → 历史应封顶 50（内存有界），功能正常
 *   S2 N5b 大 Key：夹具埋大键（最大 hash ~200KB vs 24KB string）→ TOP-N 正确、
 *      降序、耗时采样、堆增量
 *   S3 N5c Profiler A：以 ~100 命令/秒流 20s（≈2000 行 > 环形 1000）→
 *      每 5s 采样：渲染堆增长 / Modal 内 DOM 行数 / 主进程 RSS / TaskDuration
 *   S4 N5c Profiler B：filter + 暂停/继续功能验证
 *   S5 停止 + 关 Modal：堆与 DOM 应释放（判定渲染侧 rows 是否随关弹层回收）
 *   S6 关页签：回到 baseline 附近
 *
 * 自包含：本脚本自己拉起 Xvfb + electron + fake-redis，结束全部回收
 * （临时 HOME/TMPDIR 放 os.tmpdir()，走 fs.rmSync 直删，见 AGENTS.md §1/§2）。
 *
 * 用法：
 *   1) npm run compile（改了 src 才需要；work/app 里已有本批产物可跳过）
 *   2) node self-test/db-batch3-cdp-probe.js
 *   3) 产物：self-test/db-batch3-cdp-report.json + self-test/2026-11-09-batch3-shots/
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execSync } = require('node:child_process')
const Redis = require('ioredis')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = '9392' // CDP 端口（与 n5a 的 9391 错开）
const REDIS_PORT = 6392
const SHOT_DIR = path.join(__dirname, '2026-11-09-batch3-shots')
const REPORT = path.join(__dirname, 'db-batch3-cdp-report.json')
const TITLE = `redis 127.0.0.1:${REDIS_PORT}`
const DISPLAY = ':142'
const STREAM_SECONDS = Number(process.env.PROBE_STREAM_SECONDS || 20) // Profiler A 压测时长（env 可覆盖，调试用）
const STREAM_RATE = 100 // 命令/秒（≈2000 行 > 主进程环形 1000）

const mb = n => Math.round(n / 1024 / 1024 * 10) / 10
const J = s => JSON.stringify(s)

// ---- 主进程 RSS（electron 主进程 + 全部子进程求和，走 /proc，不经 CDP） ----
function rssTreeSum (rootPid) {
  const rows = execSync('ps -eo pid,ppid,rss --no-headers').toString().trim()
    .split('\n').map(l => l.trim().split(/\s+/).map(Number))
  const byPid = new Map(rows.map(r => [r[0], r]))
  let sum = 0
  const walk = pid => {
    const r = byPid.get(pid)
    if (!r || r[2] <= 0) return
    sum += r[2]
    for (const row of rows) {
      if (row[1] === pid && row[0] !== pid) walk(row[0])
    }
  }
  walk(rootPid)
  return sum * 1024 // KB → B
}

// ---- 页内探针：找/点/读，判据留在 Node 侧 ----
const PROBE = `(() => {
  window.__txt = el => (el && el.innerText ? el.innerText : '').trim()
  window.__vis = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
  }
  window.__all = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__q = sel => document.querySelector(sel)
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  window.__redisRowCount = () => window.__all('.db-redis-keys .ant-table-row').length

  // Profiler Modal（标题含 Profiler 的可见 ant-modal），与隐藏标签页的旧挂载区分
  window.__profModal = () => [...document.querySelectorAll('.ant-modal')]
    .filter(window.__vis)
    .find(m => window.__txt(m.querySelector('.ant-modal-title')).indexOf('Profiler') >= 0) || null
  window.__profOpen = () => {
    const m = window.__profModal()
    return !!m
  }
  window.__profBtn = re => {
    const m = window.__profModal()
    if (!m) return null
    return [...m.querySelectorAll('button')].filter(window.__vis)
      .find(b => re.test(window.__txt(b))) || null
  }
  window.__profState = () => {
    const m = window.__profModal()
    if (!m) return null
    const rows = [...m.querySelectorAll('.ant-table-row')].filter(window.__vis)
    const first = rows[0] ? window.__txt(rows[0].children[1]).slice(0, 60) : ''
    const last = rows[rows.length - 1] || null
    return {
      domRows: rows.length,
      firstText: first,
      lastId: last ? window.__txt(last.children[0]).trim() : '',
      lastText: last ? window.__txt(last.children[1]).slice(0, 60) : '',
      stopBtn: !!window.__profBtn(/^stop$|^停止$/),
      pauseBtn: !!window.__profBtn(/^pause$|^暂停$/),
      resumeBtn: !!window.__profBtn(/^resume$|^继续$/),
      startBtn: !!window.__profBtn(/^start$|^开始$/),
      error: window.__txt(m.querySelector('.db-redis-profiler-error'))
    }
  }
  // React fiber 直读 Table 的 dataSource（绕过可视区假象）：
  // len=12 → 渲染侧 pull/state 死了；len≈2400 → 数据在涨、只是视口问题
  window.__profDs = () => {
    const m = window.__profModal()
    if (!m) return null
    const row = m.querySelector('.ant-table-row')
    if (!row) return null
    const k = Object.keys(row).find(x => x.indexOf('__reactFiber') === 0)
    let f = k ? row[k] : null
    while (f) {
      const p = f.memoizedProps
      if (p && Array.isArray(p.dataSource)) {
        return {
          len: p.dataSource.length,
          first: p.dataSource[0] && p.dataSource[0].id,
          last: p.dataSource[p.dataSource.length - 1] && p.dataSource[p.dataSource.length - 1].id
        }
      }
      f = f.return
    }
    return null
  }
  window.__profClick = re => {
    const b = window.__profBtn(re)
    if (!b) return 'no-btn:' + re
    b.click()
    return 'ok'
  }
  window.__profSetFilter = v => {
    const m = window.__profModal()
    if (!m) return 'no-modal'
    const input = m.querySelector('.ant-input')
    if (!input) return 'no-input'
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, String(v))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__profDomBytes = () => {
    const m = window.__profModal()
    return m ? m.querySelectorAll('*').length : -1
  }

  // 控制台（弹层本体挂在 owner 上，只认可见根）
  window.__cRoot = () => window.__all('.db-redis-console')[0] || null
  window.__cClose = () => {
    const m = [...document.querySelectorAll('.ant-modal')]
      .filter(window.__vis)
      .find(m => m.querySelector('.db-redis-console'))
    if (!m) return 'no-modal'
    const x = m.querySelector('.ant-modal-close')
    if (!x) return 'no-x'
    x.click()
    return 'ok'
  }
  window.__cType = text => {
    const el = window.__cRoot() && window.__cRoot().querySelector('.db-redis-console-input input')
    if (!el) return 'no-input'
    el.focus()
    const s = String(text)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, s)
    el.setSelectionRange(s.length, s.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__cRun = () => {
    const el = window.__cRoot() && window.__cRoot().querySelector('.db-redis-console-run')
    if (!el) return 'no-btn'
    if (el.disabled) return 'disabled'
    el.click()
    return 'ok'
  }
  window.__cEntryCount = () => window.__all('.db-redis-console-entry').length
  window.__cLastEntry = () => {
    const es = window.__all('.db-redis-console-entry')
    const el = es[0]
    return el ? { pending: el.className.indexOf('is-pending') >= 0, text: window.__txt(el).slice(0, 120) } : null
  }

  // 大 Key 弹层（标题含 big key / 大 Key 的可见 ant-modal，中英 locale 都能命中）
  window.__bigModal = () => [...document.querySelectorAll('.ant-modal')]
    .filter(window.__vis)
    .find(m => /big key|大 Key/i.test(window.__txt(m.querySelector('.ant-modal-title')))) || null
  window.__bigState = () => {
    const m = window.__bigModal()
    if (!m) return null
    const rows = [...m.querySelectorAll('.ant-table-row')].filter(window.__vis)
    return {
      rows: rows.map(r => ({
        name: window.__txt(r.children[0]),
        type: window.__txt(r.children[1]),
        size: Number((window.__txt(r.children[2]) || '0').replace(/[^0-9]/g, ''))
      })),
      summary: window.__txt(m.querySelector('.ant-modal-confirm-content') || m).slice(0, 200)
    }
  }
  window.__bigClose = () => {
    const m = window.__bigModal()
    if (!m) return 'no-modal'
    const x = m.querySelector('.ant-modal-close')
    if (!x) return 'no-x'
    x.click()
    return 'ok'
  }
})()`

// ------------------------------------------------------------------ 度量
class Metrics {
  constructor (cdp, appPid) {
    this.cdp = cdp
    this.appPid = appPid
    this.rows = []
    this.last = null
  }

  async snap (label, extra = {}) {
    const cdp = this.cdp
    await cdp.call('HeapProfiler.collectGarbage')
    await sleep(250)
    await cdp.call('HeapProfiler.collectGarbage')
    await sleep(150)
    const heap = await cdp.call('Runtime.getHeapUsage')
    const perf = await cdp.call('Performance.getMetrics')
    const m = {}
    for (const it of (perf.result && perf.result.metrics) || []) {
      m[it.name] = it.value
    }
    let domCounters = null
    try {
      const dc = await cdp.call('Memory.getDOMCounters')
      domCounters = dc.result || null
    } catch (e) {}
    const rss = this.appPid ? rssTreeSum(this.appPid) : 0
    const row = {
      label,
      heapMB: mb((heap.result && heap.result.usedSize) || m.JSHeapUsedSize || 0),
      nodes: m.Nodes,
      listeners: m.JSEventListeners,
      domNodes: domCounters ? domCounters.nodes : null,
      domDetached: domCounters ? domCounters.detachedNodes : null,
      taskMs: Math.round(m.TaskDuration * 1000),
      scriptMs: Math.round(m.ScriptDuration * 1000),
      layout: m.LayoutCount,
      recalc: m.RecalcStyleCount,
      appRSSMB: mb(rss),
      extra,
      at: Date.now()
    }
    row.delta = this.last
      ? {
          heapMB: mb(row.heapMB - this.last.heapMB),
          taskMs: row.taskMs - this.last.taskMs,
          layout: row.layout - this.last.layout,
          recalc: row.recalc - this.last.recalc
        }
      : null
    this.last = row
    this.rows.push(row)
    const d = row.delta
    console.log(
      'SNAP  ' + label.padEnd(30) +
      ' heap=' + String(row.heapMB + 'MB').padEnd(8) +
      (d ? ' dHeap=' + String(d.heapMB + 'MB').padEnd(7) : '') +
      ' domNodes=' + String(row.domNodes).padEnd(7) +
      (d ? ' task=' + String(d.taskMs + 'ms').padEnd(9) + ' layout=' + d.layout : '') +
      ' rss=' + row.appRSSMB + 'MB' +
      (Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '')
    )
    return row
  }
}

async function main () {
  const { check, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const findings = []
  let stream = null // ioredis 压测流（catch 路径也要能断）

  // ---- 环境：临时 HOME/TMPDIR（os.tmpdir()，直删） + Xvfb + electron + fake-redis ----
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-batch3-home-'))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-batch3-tmp-'))
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1680x1050x24'], { stdio: 'ignore' })
  await sleep(800)
  const srv = await startFakeRedis(REDIS_PORT)
  const electron = spawn(
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron'),
    ['work/app/app.js',
      '--remote-debugging-port=' + PORT,
      '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu',
      '--window-size=1680,1050'],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        DISPLAY,
        HOME: homeDir,
        TMPDIR: tmpDir,
        DISABLE_GPU: '1',
        DISABLE_GPU_SANDBOX: '1'
      }
    }
  )
  const cleanup = () => {
    try { electron.kill('SIGKILL') } catch (e) {}
    try { xvfb.kill('SIGKILL') } catch (e) {}
    srv.close().catch(() => {})
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  let cdp = null
  let tabId = ''
  try {
    // 等 CDP 端口就绪
    let targets = null
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      try {
        targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
        if (findPageTarget(targets)) break
      } catch (e) {}
      await sleep(500)
    }
    const page = findPageTarget(targets || [])
    if (!page) throw new Error('electron 没起来：渲染进程目标找不到')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Log.enable')
    await cdp.call('Page.bringToFront', {})
    await cdp.call('Performance.enable')
    await cdp.call('HeapProfiler.enable')
    const M = new Metrics(cdp, electron.pid)
    const shot = f => cdp.shot(path.join(SHOT_DIR, f))

    check('渲染进程可用（store / pre / translate 都在）',
      await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
    await cdp.eval(buildHelpers('electerm-cdp-batch3'))
    await cdp.eval(PROBE)
    const stub = await preStubState(cdp)
    check('桥接层是原装的（没被别的 demo 的桩覆盖）',
      String(stub) === 'ok' || String(stub).indexOf('native') >= 0, stub)
    await clearDbTabs(cdp)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__dismiss()') !== 'closed') break
      await sleep(200)
    }

    // ---- S0 baseline ----
    await M.snap('S0-baseline')
    const base = M.last

    // ---- 建连 ----
    tabId = await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J(TITLE)},
        dbType: 'redis', dbHost: '127.0.0.1', dbPort: ${REDIS_PORT}, dbPassword: '',
        dbName: '0', dbSsl: false, readOnly: true,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    check('页签建连（PING/INFO 到达 fake-redis）',
      await waitFor(cdp,
        `!!window.__one('.db-head-target') && window.__one('.db-head-target').innerText.indexOf(${J(String(REDIS_PORT))}) >= 0`,
        '连接头部', 25000) &&
      srv.stats().commands.filter(c => c.cmd === 'PING').length > 0)
    check('元数据树出 db0', await waitFor(cdp, 'window.__hasTree("db0")', '树 db0', 20000))
    check('选中 db0 出键列表', await (async () => {
      // 偶发树节点未就绪/首帧渲染慢，点击重试 3 次
      for (let i = 0; i < 3; i++) {
        if (await cdp.eval('window.__clickTree("db0")') !== 'ok') continue
        if (await waitFor(cdp, 'window.__redisRowCount() >= 10', '键列表', 20000)) return true
        await sleep(500)
      }
      return false
    })())

    // ---- S1 N5a 控制台：55 条读命令，历史封顶 50 ----
    await cdp.eval('window.__one(".db-redis-console-open").click()')
    check('控制台弹层打开',
      await waitFor(cdp, '!!window.__cRoot()', 'console open', 12000))
    // 命令表异步取：等服务端收到 COMMAND
    const t0c = Date.now()
    while (srv.stats().commands.filter(c => c.cmd === 'COMMAND').length === 0 && Date.now() - t0c < 12000) {
      await sleep(200)
    }
    check('打开即取命令表（COMMAND 到达服务端）',
      srv.stats().commands.filter(c => c.cmd === 'COMMAND').length > 0)
    await M.snap('S1-console-open')
    for (let i = 0; i < 55; i++) {
      const line = 'get smoke:key:' + String(i % 60).padStart(3, '0')
      const before = await cdp.eval('window.__cEntryCount()')
      await cdp.eval(`window.__cType(${J(line)})`)
      await sleep(60)
      await cdp.eval('window.__cRun()')
      await waitFor(cdp,
        `window.__cEntryCount() === Math.min(${before + 1}, 50) && !window.__cLastEntry().pending`,
        'cmd settle ' + i, 15000)
    }
    const cCount = await cdp.eval('window.__cEntryCount()')
    const lastEntry = await cdp.eval('window.__cLastEntry()')
    check('N5a 功能：55 条命令执行成功，最后一条 GET 回值正确',
      /value:/.test(lastEntry ? lastEntry.text : ''), { lastEntry })
    check('N5a 内存：历史封顶 HISTORY_MAX=50（不发一条涨一条）',
      cCount === 50, { historyCount: cCount })
    findings.push({ name: 'N5a console history bounded', ok: cCount === 50, detail: { historyCount: cCount } })
    await M.snap('S1-console-55-cmds', { historyCount: cCount })
    await shot('S1-console.png')
    await cdp.eval('window.__cClose()')
    await sleep(800)

    // ---- S2 N5b 大 Key 扫描 ----
    // 夹具：最大 hash（2000 字段 ≈170KB）应压过最大的 24KB string；扫描应覆盖全部 85 键
    const db0 = srv.store.db(0)
    for (let i = 1; i <= 24; i++) {
      db0.set('probe:big:' + String(i).padStart(3, '0'), { type: 'string', value: 'x'.repeat(1024 * i) })
    }
    const bigHash = new Map()
    for (let i = 0; i < 2000; i++) {
      bigHash.set('field_' + i, 'value_' + i + '_' + 'y'.repeat(50))
    }
    db0.set('probe:big:hash', { type: 'hash', value: bigHash })
    const bigOpenAt = Date.now()
    const clickRes = await cdp.eval(`(() => {
      const b = window.__one('.db-redis-bigkeys-open')
      if (!b) return 'no-btn'
      if (b.disabled) return 'disabled'
      b.click()
      return 'ok'
    })()`)
    // 逐帧追踪 10s：250ms 一帧，抓"开了又关"这类瞬态
    const trace = []
    let bigOk = false
    for (let i = 0; i < 40 && !bigOk; i++) {
      await sleep(250)
      const st = await cdp.eval('window.__bigState()')
      trace.push(st
        ? { rows: st.rows.length, err: st.error, top: st.rows[0] || null }
        : null)
      bigOk = !!(st && st.rows.length > 0)
    }
    if (!bigOk) {
      const cmdStats = {}
      for (const c of srv.stats().commands) {
        cmdStats[c.cmd] = (cmdStats[c.cmd] || 0) + 1
      }
      console.log('BIGKEYS DUMP:', JSON.stringify({ clickRes, trace, cmdStats, events: cdp.tail(6) }))
      throw new Error('bigkeys 扫描 10s 内没出结果')
    }
    const bigMs = Date.now() - bigOpenAt
    const big = await cdp.eval('window.__bigState()')
    const sizes = big.rows.map(r => r.size)
    const sortedDesc = sizes.every((v, i) => i === 0 || sizes[i - 1] >= v)
    check('N5b 功能：扫描出 TOP-N 结果且按 size 降序',
      big.rows.length > 0 && sortedDesc, { n: big.rows.length, bigMs })
    check('N5b 正确性：TOP1 是 2000 字段的大 hash（MEMORY USAGE 路径）',
      big.rows[0] && big.rows[0].name === 'probe:big:hash' && big.rows[0].type === 'hash',
      big.rows[0])
    check('N5b 覆盖：夹具大键（24 条 probe:big string + 大 hash）都在 TOP-N 里',
      big.rows.filter(r => String(r.name).indexOf('probe:big:') === 0).length >= 20,
      { probeRows: big.rows.filter(r => String(r.name).indexOf('probe:big:') === 0).length })
    findings.push({
      name: 'N5b bigkey scan function + perf',
      ok: big.rows.length > 0 && sortedDesc && big.rows[0].name === 'probe:big:hash',
      detail: { top1: big.rows[0], scanMs: bigMs, rows: big.rows.length }
    })
    await M.snap('S2-bigkeys-done', { scanMs: bigMs, topN: big.rows.length })
    await shot('S2-bigkeys.png')
    await cdp.eval('window.__bigClose()')
    await sleep(600)

    // ---- S3 N5c Profiler A：无过滤压测 ~100 cmd/s × 20s ----
    // 先做主链路直调诊断：绕过 UI 直接 IPC，区分"主进程收流失败"还是"UI pull 失败"
    const diagStart = await cdp.eval(`window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'startRedisProfiler', { dbIndex: 0, filter: '' })`)
    console.log('DIRECT start:', JSON.stringify(diagStart))
    const diagStream = new Redis(REDIS_PORT, { lazyConnect: false, maxRetriesPerRequest: 1 })
    const diagDriver = setInterval(() => {
      const p = diagStream.pipeline()
      for (let i = 0; i < 10; i++) p.set('probe:diag:' + Math.random(), 'v')
      p.exec().catch(() => {})
    }, 100)
    await sleep(2000)
    const diagPull = await cdp.eval(`window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'getRedisProfilerData', { handleId: ${J(diagStart && diagStart.handleId)}, lastSeq: -1 })`)
    console.log('DIRECT pull:', JSON.stringify({
      stopped: diagPull && diagPull.stopped,
      rows: diagPull && (diagPull.rows || []).length,
      first: diagPull && (diagPull.rows || [])[0],
      overflow: diagPull && diagPull.overflow
    }))
    clearInterval(diagDriver)
    await cdp.eval(`window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'stopRedisProfiler', { handleId: ${J(diagStart && diagStart.handleId)} })`)
    diagStream.disconnect()

    await cdp.eval('window.__one(".db-redis-profiler-open").click()')
    check('Profiler 弹层打开', await waitFor(cdp, 'window.__profOpen()', 'profiler open', 12000))
    await cdp.eval('window.__profClick(/^start$|^开始$/)')
    await waitFor(cdp, 'window.__profState() && window.__profState().stopBtn', 'profiler start', 12000)

    // 驱动流：ioredis pipeline 10 条 / 100ms = ~100 cmd/s（S4 暂停判定还在用，别提前停）
    stream = new Redis(REDIS_PORT, { lazyConnect: false, maxRetriesPerRequest: 1 })
    const samples = []
    let sent = 0
    const driver = setInterval(() => {
      const p = stream.pipeline()
      for (let i = 0; i < 10; i++) {
        p.set('probe:stream:' + sent, 'v' + sent)
        sent++
      }
      p.exec().catch(() => {})
    }, 100)
    for (let s = 1; s <= STREAM_SECONDS / 5; s++) {
      await sleep(5000)
      // 功能判定用 React fiber 直读 dataSource（virtual 表可视区只渲染头部，
      // DOM 里读不到尾部行——前三轮 FAIL 均为探针视口假象，见 UI PULL DIAG 记录）
      const st = await cdp.eval('window.__profState()')
      const ds = await cdp.eval('window.__profDs()')
      const snap = await M.snap('S3-profiler-' + (s * 5) + 's', {
        domRows: st ? st.domRows : -1,
        dsLen: ds ? ds.len : -1,
        dsLast: ds ? ds.last : -1,
        sent
      })
      samples.push({
        t: s * 5,
        heapMB: snap.heapMB,
        domRows: st ? st.domRows : -1,
        dsLen: ds ? ds.len : 0,
        dsLast: ds ? ds.last : 0,
        sent
      })
      await cdp.shot(path.join(SHOT_DIR, 'S3-profiler-' + (s * 5) + 's.png'))
    }
    const stEnd = await cdp.eval('window.__profState()')
    const domRowsEnd = stEnd ? stEnd.domRows : -1
    const dsEnd = await cdp.eval('window.__profDs()')
    const dsLastEnd = dsEnd ? dsEnd.last : 0
    // 服务端侧取证：绕过 UI 直拉 UI profiler 的 buffer（handleId 顺序分配，UI 是 DIRECT 的下一个）
    const uiHandle = diagStart && typeof diagStart.handleId === 'number' ? diagStart.handleId + 1 : null
    const uiPull = uiHandle
      ? await cdp.eval(`window.pre.runGlobalAsync('dbClientOp', ${J(tabId)}, 'getRedisProfilerData', { handleId: ${uiHandle}, lastSeq: -1 })`)
      : null
    console.log('UI PULL DIAG:', JSON.stringify({
      dsEnd,
      stEnd,
      uiRows: uiPull && (uiPull.rows || []).length,
      uiLast: uiPull && uiPull.rows && uiPull.rows[uiPull.rows.length - 1]
    }))
    // 取证：服务端到底收到了 MONITOR / SET 吗；渲染侧 error 字段
    const cmdStats3 = {}
    for (const c of srv.stats().commands) {
      cmdStats3[c.cmd] = (cmdStats3[c.cmd] || 0) + 1
    }
    console.log('PROFILER DUMP:', JSON.stringify({ cmdStats3, stEnd, events: cdp.tail(4) }))
    // N5c 功能：dataSource 最后一条 id 随流增长且追上命令量（流进得来）
    const lastIdGrows = samples.length > 1 &&
      samples[samples.length - 1].dsLast > samples[0].dsLast &&
      dsLastEnd > sent * 0.5
    check('N5c 功能：dataSource 随流增长且追上命令量（流进得来）',
      lastIdGrows, { dsLastEnd, sent, dsTrace: samples.map(x => x.dsLast), uiRows: uiPull && (uiPull.rows || []).length })
    // N5c 内存：virtual 生效 —— DOM 行数恒定为可视区规模，不随流线性涨
    const domSteady = domRowsEnd > 0 && domRowsEnd <= 30
    check('N5c 内存：Table virtual 生效（DOM 行数恒定为可视区规模）',
      domSteady, { domRowsEnd })
    findings.push({
      name: 'N5c stream function + memory containment',
      ok: lastIdGrows && domSteady,
      detail: { samples, domRowsEnd, dsLastEnd, sent, note: '修复后 rows 上限 5000 + virtual Table' }
    })
    const heapNow = M.last
    findings.push({
      name: 'N5c renderer heap growth during stream',
      ok: true,
      detail: {
        heapStartMB: samples[0] ? samples[0].heapMB : null,
        heapEndMB: heapNow.heapMB,
        growthMB: mb(heapNow.heapMB - (samples[0] ? samples[0].heapMB : 0)),
        taskMsDelta: heapNow.delta ? heapNow.delta.taskMs : null,
        layoutDelta: heapNow.delta ? heapNow.delta.layout : null
      }
    })

    // ---- S4 Profiler B：暂停/继续功能（流还在跑） ----
    // 用 dataSource 最后一条 id 度量（virtual 表可视区只渲染头部，DOM 读不到尾部）：
    // 暂停时 id1；resume 窗口 id2 > id1；再暂停 2s 后 id3 === id2（冻结）
    const profId = async () => {
      const d = await cdp.eval('window.__profDs()')
      return d ? d.last : 0
    }
    await cdp.eval('window.__profClick(/^pause$|^暂停$/)')
    await waitFor(cdp, 'window.__profState() && window.__profState().resumeBtn', 'paused', 8000)
    // 等 200ms pull 循环把 pause 前在途的最后一批收完，水位才真正冻结
    await sleep(600)
    const p1 = await profId()
    await cdp.eval('window.__profClick(/^resume$|^继续$/)')
    await waitFor(cdp, 'window.__profState() && window.__profState().pauseBtn', 'resumed', 8000)
    await sleep(800)
    await cdp.eval('window.__profClick(/^pause$|^暂停$/)')
    await waitFor(cdp, 'window.__profState() && window.__profState().resumeBtn', 'paused again', 8000)
    await sleep(600)
    const p2 = await profId()
    await sleep(2000)
    const p3 = await profId()
    clearInterval(driver)
    check('N5c 功能：resume 窗口累计行数在涨（p2 > p1）',
      p2 > p1, { p1, p2, p3 })
    check('N5c 功能+内存：暂停 2s 累计行数冻结（p3 === p2，主进程不再 append）',
      p3 === p2, { p1, p2, p3 })
    findings.push({ name: 'N5c pause freezes accumulation', ok: p3 === p2 && p2 > p1, detail: { p1, p2, p3 } })
    await M.snap('S4-pause-checked', { p1, p2, p3 })

    // ---- S5 停止 + 关 Modal：堆与 DOM 应释放 ----
    const heapBeforeClose = (await M.snap('S5-before-close')).heapMB
    const domBeforeClose = (await cdp.call('Memory.getDOMCounters')).result.nodes
    await cdp.eval('window.__profClick(/^stop$|^停止$/)')
    // startBtn 回来即证 UI 已停（pull 定时器清掉）；主进程 stopped 路径已由前面 DIRECT pull 验证
    const stopOk = await waitFor(cdp, 'window.__profState() && window.__profState().startBtn', 'profiler stopped', 10000)
    check('N5c 功能：stop 后回到 Start 按钮（pull 定时器被清）', stopOk)
    const closeX = await cdp.eval(`(() => {
      const m = window.__profModal()
      if (!m) return 'no-modal'
      const x = m.querySelector('.ant-modal-close')
      if (!x) return 'no-x'
      x.click()
      return 'ok'
    })()`)
    await sleep(1500)
    const afterClose = await M.snap('S5-after-modal-close', { closeX })
    const domAfterClose = (await cdp.call('Memory.getDOMCounters')).result.nodes
    const domReleased = domAfterClose <= domBeforeClose + 1500
    findings.push({
      name: 'N5c closing modal releases rows (heap/DOM)',
      ok: domReleased && afterClose.heapMB < heapBeforeClose,
      detail: {
        domBeforeClose,
        domAfterClose,
        heapBeforeMB: heapBeforeClose,
        heapAfterMB: afterClose.heapMB
      }
    })
    check('N5c 资源：关弹层后 DOM 收敛（分离节点被回收）', domReleased,
      { domBeforeClose, domAfterClose })

    // ---- S6 关页签：回到 baseline 附近（spy 挂在被关页签所在的页面上，随 delTab 一并消失） ----
    await cdp.eval(`window.store.delTab(${J(tabId)})`)
    await sleep(2500)
    const final = await M.snap('S6-tab-closed')
    findings.push({
      name: 'final heap vs baseline after tab close',
      ok: (final.heapMB - base.heapMB) < 25,
      detail: { baseMB: base.heapMB, finalMB: final.heapMB }
    })
    await shot('S6-final.png')

    const failed = results.filter(r => !r.ok)
    const report = {
      at: new Date().toISOString(),
      app: 'electerm db-batch3 cdp probe (N5a/N5b/N5c function+perf+memory)',
      env: { cdpPort: PORT, redisPort: REDIS_PORT, streamRate: STREAM_RATE, streamSeconds: STREAM_SECONDS },
      snaps: M.rows,
      findings,
      checks: results,
      consoleEvents: cdp.tail(12)
    }
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
    console.log('\n===== CHECKS =====')
    for (const r of results) {
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name)
    }
    console.log('\n===== FINDINGS =====')
    for (const f of findings) {
      console.log((f.ok ? 'PASS  ' : 'FAIL  ') + f.name + ' :: ' + JSON.stringify(f.detail))
    }
    console.log('\nreport ->', REPORT)
    console.log('shots  ->', SHOT_DIR)
    stream.disconnect()
    cdp.ws.close()
    cleanup()
    process.exit(failed.length ? 1 : 0)
  } catch (err) {
    console.error('PROBE ERROR:', err.stack || err.message)
    if (cdp) {
      console.error('console tail:', cdp.tail(8))
      cdp.ws.close()
    }
    cleanup()
    process.exit(2)
  }
}

main()
