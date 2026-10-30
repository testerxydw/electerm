#!/usr/bin/env node
/**
 * H7b-2 Redis 慢日志页签 —— 真 Redis 端到端（只读）
 *
 * 假桩（db-redis-slowlog-demo.js）验的是界面口径。真库这层只验桩给不了的那半截：
 *   1) IPC → ioredis 的真链路：SLOWLOG GET 一次往返拿回真条目（不是 undefined、不被吞）
 *   2) 懒加载在真链路上成立：开弹层不发 SLOWLOG，切进页签恰好一发
 *   3) 真条目形状：id 是数、命令非空、耗时/时间是格式化过的串，且 id 递减（Redis 最新在前）
 *   4) 状态行条数与表格行数一致；0 条时说的是"没有慢日志"而不是"最慢 0 μs"
 *   5) 刷新只重发 SLOWLOG，不顺手再发 INFO
 *
 * 慢日志为空也是合法结果（`slowlog-log-slower-than` 设得高时常见），
 * 所以判据分两支：有条目验形状，没条目验"空得老实"。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/ work/app/
 *   2) 起带 --remote-debugging-port 的实例
 *   3) RDB_REDIS_HOST=… RDB_REDIS_PORT=… RDB_REDIS_PASS=… node self-test/db-redis-slowlog-realredis.js [port] [shotDir]
 *
 * 凭据只从环境变量读，绝不写进被 git 跟踪的文件。整轮只读：tab 以 readOnly:true 打开，
 * 脚本只发 getMetadata / getPageData / getRedisInfo / getRedisSlowlog。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-slowlog-realredis-shots')

const ENV = {
  host: process.env.RDB_REDIS_HOST,
  port: process.env.RDB_REDIS_PORT,
  pass: process.env.RDB_REDIS_PASS
}
if (!ENV.host || !ENV.port) {
  console.error('需要 RDB_REDIS_HOST / RDB_REDIS_PORT（可选 RDB_REDIS_PASS）')
  process.exit(2)
}

// 只 wrap（透传原函数）：到底发了几发、参数是什么，看的是真 IPC
const PROBE = `
(() => {
  if (window.__h7bReal) return 'already'
  window.__h7bReal = true
  window.__calls = []
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      window.__calls.push(a[1] + ' ' + JSON.stringify(a[2] || {}))
      const r = orig(name, ...a)
      // 记下主进程回来的条目数：与界面表格行数比对，证明归一没有丢条
      if (a[1] === 'getRedisSlowlog') {
        return r.then(v => {
          window.__slowlogLens = (window.__slowlogLens || []).concat([Array.isArray(v) ? v.length : -1])
          return v
        })
      }
      return r
    }
    return orig(name, ...a)
  }
  window.__stubbed = !!(window.__space || window.__info || window.__slowlog)
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null
  window.__norm = s => String(s || '').replace(/\\s+/g, '')
  window.__count = sub => window.__calls.filter(c => c.indexOf(sub) === 0).length
  window.__clickHeadBtn = t => {
    const want = window.__norm(t)
    const b = [...document.querySelectorAll('.db-head button')].filter(window.__vis)
      .find(x => window.__norm(x.textContent).indexOf(want) > -1)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__clickMaskClose = () => {
    const x = window.__one('.ant-modal-close')
    if (!x) return 'missing'
    x.click()
    return 'ok'
  }
  window.__tabLabels = () => [...document.querySelectorAll('.db-redis-info .ant-tabs-tab')]
    .filter(window.__vis).map(t => (t.textContent || '').trim())
  window.__tab = i => {
    const t = [...document.querySelectorAll('.db-redis-info .ant-tabs-tab')].filter(window.__vis)[i]
    if (!t) return 'missing'
    t.click()
    return 'ok'
  }
  window.__rowPairs = () => [...document.querySelectorAll('.db-redis-info-row')]
    .filter(window.__vis)
    .map(r => [(r.querySelector('.db-redis-info-k') || {}).textContent,
      (r.querySelector('.db-redis-info-v') || {}).textContent].map(s => String(s || '').trim()))
  window.__slRows = () => [...document.querySelectorAll('.db-redis-slowlog .ant-table-tbody tr.ant-table-row')]
    .filter(window.__vis)
    .map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()))
  window.__slStatus = () => {
    const s = window.__one('.db-redis-slowlog-status')
    return s ? (s.textContent || '').trim() : null
  }
  window.__alert = () => {
    const a = window.__one('.db-redis-info .db-redis-info-err')
    return a ? (a.innerText || '') : null
  }
  window.__dot = () => {
    const d = window.__one('.db-head-dot')
    return d ? d.className : null
  }
  window.__clickFoot = t => {
    const want = window.__norm(t)
    const b = [...document.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => window.__norm(x.textContent).indexOf(want) > -1)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  return 'probed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis real',
    dbType: 'redis',
    dbHost: ${JSON.stringify(ENV.host)},
    dbPort: ${JSON.stringify(Number(ENV.port))},
    dbPassword: ${JSON.stringify(ENV.pass || '')},
    dbName: '0',
    dbSsl: false,
    readOnly: true,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const DUR_RE = /^(\d+ μs|\d+\.\d{2} (ms|s))$/

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  // 干净现场：假库桩会顶掉真 IPC，带着桩跑真库判据等于什么都没验
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1500)
  await cdp.eval(PROBE)
  const stubbed = await cdp.eval('window.__stubbed')
  check('刷新后渲染层没有假库桩残留', !stubbed, { stubbed })
  if (stubbed) {
    console.log('\n真库判据必须在干净的 IPC 层上跑，终止。')
    process.exit(1)
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  await clearDbTabs(cdp)
  const opened = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(opened.id), 'tab active')
  await waitFor(cdp, "document.querySelectorAll('.db-tree-db-name').length > 0", 'metadata tree loaded', 30000)
  const dot0 = await cdp.eval('window.__dot()')
  check('真连接建立（顶栏"已连接"）', /(^|\s)ok($|\s)/.test(String(dot0)), { dot0 })

  // ── 1. 懒加载在真链路上成立 ──────────────────────────────────────
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal open', 20000)
  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'overview rendered', 20000)
  const slBefore = await cdp.eval("window.__count('getRedisSlowlog')")
  const labels = JSON.parse(await cdp.eval('JSON.stringify(window.__tabLabels())'))
  check('打开弹层只付 INFO：一发 SLOWLOG 都没发', slBefore === 0, { slBefore })
  check('真实例上也是四个页签（慢日志在最后）',
    labels.length === 4 && /慢日志|slow log/i.test(labels[3]), { labels })

  // ── 2. 切进页签恰好一发，参数为空 ────────────────────────────────
  await waitFor(cdp, 'window.__tabLabels().length > 0', 'tabs rendered', 10000)
  await cdp.eval('window.__tab(window.__tabLabels().length - 1)')
  await waitFor(cdp, 'window.__slStatus() !== null', 'slowlog pane rendered', 30000)
  const slArgs = JSON.parse(await cdp.eval(
    "JSON.stringify(window.__calls.filter(c => c.indexOf('getRedisSlowlog') === 0))"))
  check('切进慢日志页签恰好一发、不带 count（上限归后端）',
    slArgs.length === 1 && /^getRedisSlowlog \{\}$/.test(slArgs[0]), { slArgs })
  const alertNow = await cdp.eval('window.__alert()')
  check('读取过程没有报错（SLOWLOG 没被禁用/没被副本拒绝）',
    alertNow === null || alertNow === 'null', { alertNow })

  // ── 3. 真条目形状（空表也要"空得老实"）───────────────────────────
  const status = await cdp.eval('window.__slStatus()')
  const rows = JSON.parse(await cdp.eval('JSON.stringify(window.__slRows())'))
  const lens = JSON.parse(await cdp.eval('JSON.stringify(window.__slowlogLens || [])'))
  check('主进程回来的条目数 = 表格行数（归一不丢条）',
    lens.length === 1 && lens[0] === rows.length, { lens, rows: rows.length })
  const m = /(\d+)/.exec(String(status))
  const nStatus = m ? Number(m[1]) : null
  check('状态行条数与表格一致',
    rows.length ? nStatus === rows.length : /没有慢日志|no slow/i.test(String(status)), { status, rows: rows.length })
  if (rows.length === 0) {
    check('空表说的是"没有慢日志条目"，不出现"最慢 0"',
      !/0 μs|最慢/.test(String(status)), { status })
  } else {
    const ids = rows.map(r => Number(r[0]))
    check('id 全是数字且递减（Redis 最新在前，解析不重排）',
      ids.every(Number.isFinite) && ids.every((v, i) => i === 0 || ids[i - 1] >= v), { ids: ids.slice(0, 8) })
    check('耗时列是 μs/ms/s 三档之一（不是裸数字也不是 0 冒充缺失）',
      rows.every(r => DUR_RE.test(r[2])), { sample: rows.slice(0, 3).map(r => r[2]) })
    check('时间列是 YYYY-MM-DD HH:mm:ss', rows.every(r => TIME_RE.test(r[1])), {
      sample: rows.slice(0, 3).map(r => r[1])
    })
    check('命令列非空', rows.every(r => r[3] && r[3] !== '—'), {
      sample: rows.slice(0, 5).map(r => r[3])
    })
    check('没有 NaN / undefined / 驼峰 key 漏出',
      !/NaN|undefined|dbRedisSlowlog/.test(JSON.stringify(rows)), {})
  }
  await shot('1-slowlog-real.png')

  // ── 4. 刷新只重发 SLOWLOG ────────────────────────────────────────
  const infoBefore = await cdp.eval("window.__count('getRedisInfo')")
  const slBefore2 = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickFoot("刷新")')
  await waitFor(cdp, 'window.__count(\'getRedisSlowlog\') > ' + slBefore2, 'refetch sent', 20000)
  await sleep(600)
  const infoAfter = await cdp.eval("window.__count('getRedisInfo')")
  const slAfter = await cdp.eval("window.__count('getRedisSlowlog')")
  check('慢日志页签点刷新：只多发 SLOWLOG，不顺手再发 INFO',
    slAfter - slBefore2 === 1 && infoAfter === infoBefore, { infoBefore, infoAfter, slBefore2, slAfter })

  // ── 5. 关闭即作废：重开切进页签重新拉 ────────────────────────────
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed', 10000)
  const slClosed = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'reopen', 20000)
  await waitFor(cdp, 'window.__tabLabels().length > 0', 'tabs rendered again', 20000)
  await cdp.eval('window.__tab(window.__tabLabels().length - 1)')
  await waitFor(cdp, 'window.__count(\'getRedisSlowlog\') > ' + slClosed, 'refetch after reopen', 20000)
  check('关掉重开不背旧条目：切进页签会重新拉一发', true, {
    before: slClosed,
    after: await cdp.eval("window.__count('getRedisSlowlog')")
  })
  await cdp.eval('window.__clickMaskClose()')
  await sleep(300)

  const cleared = await clearDbTabs(cdp)
  check('自测收尾关闭数据库 tab', cleared.left.length === 0, cleared)

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.stack ? err.stack : err)
  process.exit(1)
})
