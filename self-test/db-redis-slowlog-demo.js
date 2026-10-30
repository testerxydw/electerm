#!/usr/bin/env node
/**
 * H7b-2 Redis 慢日志页签 —— CDP 实机演示/回归（无需真 Redis）
 *
 * 纯函数那层（parse/format/tsv）已由 src/test/unit-ci/db-redis-slowlog.spec.js 钉死，
 * 这里验的是"接到一起之后"的界面行为，桩给不了的那半截：
 *   1) 懒加载：打开弹层只发 INFO，第一次切进"慢日志"才发 SLOWLOG GET
 *   2) 只发一次：切走再切回、静置都不重发；只有点"刷新"才再发
 *   3) 两条命令互不连坐：INFO 失败仍只剩慢日志一页、并自动拨过去取数（红条留在顶上，
 *      因为它已经没有别的页可去）；SLOWLOG 失败时概览照常、红条只在慢日志页签出现
 *   4) 表格口径：耗时按 μs/ms/s 三档、时间取微秒那份、命令不改大小写、
 *      参数预览截断（原文只进剪贴板）、「—」而不是 0
 *   5) 状态行与空态：0 条说"没有慢日志条目"而不是"最慢 0 μs"；没数据不给复制
 *   6) 关闭即作废：重开后切进页签会重新拉，不闪上一次的旧条目
 *   7) 样式走 token（浅色换色）+ 数据面等宽字体链
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 且跑完不还原（同 db-redis-info-demo.js）。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/ work/app/
 *   2) 起带 --remote-debugging-port 的实例
 *   3) node self-test/db-redis-slowlog-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-slowlog-shots')

const INFO_FULL = [
  '# Server',
  'redis_version:7.2.6',
  'redis_mode:standalone',
  'os:Linux 6.18.48 x86_64',
  'uptime_in_seconds:259200',
  '',
  '# Stats',
  'keyspace_hits:970',
  'keyspace_misses:30',
  'instantaneous_ops_per_sec:250',
  '',
  '# Replication',
  'role:master',
  '',
  '# Keyspace',
  'db0:keys=6,expires=0,avg_ttl=0'
].join('\r\n')

// Redis 7.2 的条目形状：[id, 秒时间戳, 微秒耗时, 参数数组, 客户端地址, 客户端名]
const LONG_ARG = 'x'.repeat(120)
const SLOWLOG_72 = [
  [12, 1730192000, 42130, ['SET', 'user:1', LONG_ARG], '10.0.0.5:53212', 'cli-a'],
  [13, 1730192060, 1500000, ['KEYS', '*'], '10.0.0.5:53212', ''],
  [14, 1730192090, 421, ['PING'], '[::ffff:10.0.0.6]:41000', 'app'],
  [15, 1730192100, 0, ['GET', 'k'], '10.0.0.7:1', ''],
  [16, 1730192110, 999999, ['MSET'].concat(Array.from({ length: 12 }, (_, i) => 'v' + i)), '10.0.0.8:2', 'bulk']
]

// Redis 7.4 起的形状：尾部多一个微秒时间戳（这里让它指向"另一秒"，才能看出界面用的是哪份）
const SLOWLOG_74 = [
  [20, 1730192200, 5200, ['EXPIRE', 'k', '60'], 1730199999123456, '[::1]:6379', ''],
  [21, 1730192260, 10, ['BGSAVE'], '', '']
]

/** 与 common/db-redis-slowlog.js 的 formatSlowTime 同一口径，用来算期望串 */
function fmtTime (ms) {
  const d = new Date(ms)
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const STUB = `
(() => {
  window.__info = ${JSON.stringify(INFO_FULL)}
  window.__slowlog = ${JSON.stringify(SLOWLOG_72)}
  window.__slowlogThrows = null
  window.__infoThrows = null
  window.__delay = 0
  window.__calls = []
  window.__clip = []
  window.__count = sub => window.__calls.filter(c => c.indexOf(sub) === 0).length
  const ow = window.pre.writeClipboard.bind(window.pre)
  window.pre.writeClipboard = s => { window.__clip.push(String(s)); return ow(s) }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__calls.push(op + ' ' + JSON.stringify(args))
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'db0', type: 'database', count: 3 }])
      }
      if (op === 'getPageData') {
        return Promise.resolve({ rows: [], nextCursor: '0', hasMore: false })
      }
      if (op === 'getRedisInfo') {
        return new Promise((res, rej) => setTimeout(() => {
          if (window.__infoThrows) { rej(new Error(window.__infoThrows)) } else { res(String(window.__info || '')) }
        }, window.__delay || 0))
      }
      if (op === 'getRedisSlowlog') {
        return new Promise((res, rej) => setTimeout(() => {
          if (window.__slowlogThrows) { rej(new Error(window.__slowlogThrows)) } else { res(window.__slowlog) }
        }, window.__delay || 0))
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    return Promise.resolve(null)
  }
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
  window.__slRows = () => [...document.querySelectorAll('.db-redis-slowlog .ant-table-tbody tr.ant-table-row')]
    .filter(window.__vis)
    .map(tr => [...tr.querySelectorAll('td')].map(td => ({
      t: (td.textContent || '').trim(),
      title: [...td.querySelectorAll('[title]')].map(x => x.getAttribute('title'))
    })))
  window.__slOverflow = () => {
    const box = window.__one('.db-redis-slowlog .ant-table-content') ||
      window.__one('.db-redis-slowlog .ant-table-body')
    return box ? { sw: box.scrollWidth, cw: box.clientWidth } : null
  }
  window.__slStatus = () => {
    const s = window.__one('.db-redis-slowlog-status')
    return s ? (s.textContent || '').trim() : null
  }
  window.__modal = () => {
    const m = window.__one('.db-redis-info')
    return m ? (m.innerText || '') : ''
  }
  window.__rowPairs = () => [...document.querySelectorAll('.db-redis-info-row')]
    .filter(window.__vis)
    .map(r => [(r.querySelector('.db-redis-info-k') || {}).textContent,
      (r.querySelector('.db-redis-info-v') || {}).textContent].map(s => String(s || '').trim()))
  window.__alert = () => {
    const a = window.__one('.db-redis-info .db-redis-info-err')
    return a ? (a.innerText || '') : null
  }
  window.__dot = () => {
    const d = window.__one('.db-head-dot')
    return d ? d.className : null
  }
  window.__foot = () => [...document.querySelectorAll('.ant-modal-footer button')]
    .filter(window.__vis).map(b => ({ t: window.__norm(b.textContent), disabled: !!b.disabled }))
  window.__clickFoot = t => {
    const want = window.__norm(t)
    const b = [...document.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => window.__norm(x.textContent).indexOf(want) > -1)
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  return 'stubbed'
})()
`

const openTab = () => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis 127.0.0.1:6379',
    dbType: 'redis',
    dbHost: '127.0.0.1',
    dbPort: 6379,
    dbPassword: '',
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

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  // 硬刷：db-session 与弹层都是懒加载 chunk，不 reload 会在旧 chunk 上跑
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  // 弹层首帧是转圈（Tabs 还没挂上），等页签真出来再点，否则点的是空气
  const gotoSlowlog = async () => {
    await waitFor(cdp, 'window.__tabLabels().length > 0', 'tabs rendered', 10000)
    await cdp.eval('window.__tab(window.__tabLabels().length - 1)')
  }

  await cdp.eval(STUB)
  await clearDbTabs(cdp)
  await sleep(300)

  const tabRes = JSON.parse(await cdp.eval(openTab()))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tabRes.id), 'redis tab active')
  await waitFor(cdp, "!!window.__one('.db-head')", 'db head rendered')

  // ── 1. 懒加载：打开弹层只付 INFO，不付 SLOWLOG ────────────────────
  const c0 = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal open')
  await waitFor(cdp, 'window.__rowPairs().length >= 10', 'overview rendered')
  const c1 = await cdp.eval("window.__count('getRedisSlowlog')")
  check('只看概览时一发 SLOWLOG 都不发（整段日志拷回来不该白付）',
    c1 - c0 === 0, { c0, c1 })

  const labels = JSON.parse(await cdp.eval('JSON.stringify(window.__tabLabels())'))
  check('页签四个且慢日志在最后（INFO 三页 + 另一条命令）',
    labels.length === 4 && /慢日志|slow log/i.test(labels[3]), { labels })

  // ── 2. 第一次切进页签才拉，恰好一发 ───────────────────────────────
  await gotoSlowlog()
  await waitFor(cdp, 'window.__slRows().length === 5', 'slowlog rows rendered', 8000)
  const c2 = await cdp.eval("window.__count('getRedisSlowlog')")
  const slArg = await cdp.eval("window.__calls.find(c => c.indexOf('getRedisSlowlog') === 0)")
  check('切进慢日志页签恰好拉一次', c2 - c1 === 1, { c1, c2 })
  check('不带 count（0 在 RESP 里是"取全部"，上限归后端），且不 select db',
    /^getRedisSlowlog \{\}$/.test(String(slArg)), { slArg })

  // ── 3. 表格口径 ──────────────────────────────────────────────────
  const rows = JSON.parse(await cdp.eval('JSON.stringify(window.__slRows())'))
  check('行数 = 条目数、列数 6（服务端原序：最新在前的 12 在首行）',
    rows.length === 5 && rows.every(r => r.length === 6) && rows[0][0].t === '12', {
      n: rows.length, firstId: rows[0] && rows[0][0].t
    })
  const durations = rows.map(r => r[2].t)
  check('耗时分三档：42.13 ms / 1.50 s / 421 μs / 0 μs / 1000.00 ms',
    durations.join('|') === '42.13 ms|1.50 s|421 μs|0 μs|1000.00 ms', { durations })
  check('时间列是本地 YYYY-MM-DD HH:mm:ss（秒时间戳换算）',
    rows[0][1].t === fmtTime(1730192000 * 1000), { got: rows[0][1].t, want: fmtTime(1730192000 * 1000) })
  check('命令按服务端原样显示（KEYS 不改大小写）',
    rows[1][3].t === 'KEYS' && rows[2][3].t === 'PING', { cmds: rows.map(r => r[3].t) })
  const longCell = rows[0][4]
  check('超长参数在表格里截断（原文只进剪贴板），预览 ≤ 81 字符',
    longCell.t.length <= 81 && longCell.t.includes(String.fromCharCode(8230)) && !longCell.t.includes(LONG_ARG), {
      len: longCell.t.length, head: longCell.t.slice(0, 20)
    })
  check('参数多于 8 个折叠成 …(+N)，不静默丢尾',
    /\(\+4\)$/.test(rows[4][4].t), { cell: rows[4][4].t })
  check('无参数出「—」而不是空串（PING 没有参数）',
    rows[2][4].t === '—', { cell: rows[2][4].t })
  check('客户端列 = 地址 · 名字，缺名只剩地址',
    rows[0][5].t === '10.0.0.5:53212 · cli-a' && rows[1][5].t === '10.0.0.5:53212', {
      withName: rows[0][5].t, addrOnly: rows[1][5].t
    })
  const status = await cdp.eval('window.__slStatus()')
  check('状态行：共 5 条 · 最慢取最大那条（1.50 s，不是最后一条）',
    /5/.test(String(status)) && /1\.50 s/.test(String(status)), { status })

  const overflow = JSON.parse(await cdp.eval('JSON.stringify(window.__slOverflow())'))
  check('六列在弹层宽度内放得下（不出现横向滚动条）',
    !!overflow && overflow.sw <= overflow.cw + 2, { overflow })

  await shot('1-slowlog-dark.png')

  // ── 4. 微秒时间戳那份优先（新版本形状） ───────────────────────────
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed before 7.4 shape')
  await cdp.eval('window.__slowlog = ' + JSON.stringify(SLOWLOG_74))
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal reopen')
  await gotoSlowlog()
  await waitFor(cdp, 'window.__slRows().length === 2', '7.4 rows rendered', 8000)
  const rows74 = JSON.parse(await cdp.eval('JSON.stringify(window.__slRows())'))
  check('尾部微秒时间戳覆盖秒时间戳（用的是 1730199999 那份，不是 1730192200）',
    rows74[0][1].t === fmtTime(1730199999 * 1000), {
      got: rows74[0][1].t, want: fmtTime(1730199999 * 1000), secVer: fmtTime(1730192200 * 1000)
    })
  check('微秒时间戳不冒充客户端地址、地址/名都空时客户端列出「—」',
    rows74[0][5].t === '[::1]:6379' && rows74[1][5].t === '—', {
      addr: rows74[0][5].t, none: rows74[1][5].t
    })
  await shot('2-newshape-dark.png')

  // ── 5. 只拉一次：切走再切回不重发 ────────────────────────────────
  const c3 = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__tab(0)')
  await sleep(300)
  await gotoSlowlog()
  await sleep(400)
  const c4 = await cdp.eval("window.__count('getRedisSlowlog')")
  check('已有条目时切走再切回不再发（每次往返都是整段日志拷贝）',
    c4 === c3, { c3, c4 })
  await sleep(2000)
  const c5 = await cdp.eval("window.__count('getRedisSlowlog')")
  check('静置 2s 不再多发（没有常驻轮询）', c5 === c4, { c4, c5 })

  // ── 6. 复制走 TSV：全量参数、无「—」 ─────────────────────────────
  const clip0 = await cdp.eval('window.__clip.length')
  const clicked = await cdp.eval('window.__clickFoot("复制")')
  await sleep(300)
  const clip = JSON.parse(await cdp.eval('JSON.stringify(window.__clip)'))
  const copied = String(clip[clip.length - 1] || '')
  const head = copied.split('\n')[0]
  check('复制按钮可用且复制的是 TSV（表头六列）',
    clicked === 'ok' && head === 'id\ttime\tduration_us\tcommand\targs\tclient', { clicked, head })
  check('TSV 用原始微秒数、耗时不格式化（粘出去的是数据不是显示串）',
    copied.split('\n')[1].split('\t')[2] === '5200', { line1: copied.split('\n')[1] })
  await cdp.eval('window.__slowlog = ' + JSON.stringify(SLOWLOG_72))
  await cdp.eval('window.__clickFoot("刷新")')
  await waitFor(cdp, 'window.__slRows().length === 5', 'back to 7.2 rows', 8000)
  const clip2 = JSON.parse(await cdp.eval('JSON.stringify(window.__clip)'))
  await cdp.eval('window.__clickFoot("复制")')
  await sleep(300)
  const clip3 = JSON.parse(await cdp.eval('JSON.stringify(window.__clip)'))
  const tsv = String(clip3[clip3.length - 1] || '')
  check('TSV 参数不截断（表格里被截掉的那串 120 字符完整在里面）',
    tsv.includes(LONG_ARG) && !tsv.includes(String.fromCharCode(8230)), {
      len: tsv.split('\n')[1].length
    })
  check('TSV 空字段留空而不是「—」（横杠粘进表格会被当成数据）',
    tsv.split('\n')[3].split('\t')[4] === '' &&
    tsv.split('\n')[3].split('\t')[5] === '[::ffff:10.0.0.6]:41000 app' &&
    tsv.indexOf(String.fromCharCode(8212)) < 0, {
      pingLine: tsv.split('\n')[3]
    })
  check('剪贴板只在点复制时写入（刷新不偷偷改用户剪贴板）',
    clip2.length === clip0 + 1 && clip3.length === clip2.length + 1, { clip0, clip2: clip2.length, clip3: clip3.length })

  // ── 7. 刷新只重发当前页签那条命令 ────────────────────────────────
  const iBefore = await cdp.eval("window.__count('getRedisInfo')")
  const sBefore = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickFoot("刷新")')
  await sleep(600)
  const iAfter = await cdp.eval("window.__count('getRedisInfo')")
  const sAfter = await cdp.eval("window.__count('getRedisSlowlog')")
  check('慢日志页签点刷新：只多发 SLOWLOG，不顺手再发一次 INFO',
    sAfter - sBefore === 1 && iAfter === iBefore, { iBefore, iAfter, sBefore, sAfter })

  // ── 8. 空态：0 条不说"最慢 0 μs"，也不给复制 ─────────────────────
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed before empty')
  await cdp.eval('window.__slowlog = []')
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal open (empty slowlog)')
  await gotoSlowlog()
  await waitFor(cdp, 'window.__slStatus() !== null', 'empty status rendered', 8000)
  const emptyStatus = await cdp.eval('window.__slStatus()')
  const footEmpty = JSON.parse(await cdp.eval('JSON.stringify(window.__foot())'))
  const copyBtn = (footEmpty || []).find(b => /复制|copy/i.test(b.t))
  check('0 条说"没有慢日志条目"，不出现"最慢 0"',
    /没有慢日志|no slow/i.test(String(emptyStatus)) && !/0 μs|最慢/.test(String(emptyStatus)), { emptyStatus })
  check('没有可复制内容时复制按钮禁用', !!copyBtn && copyBtn.disabled === true, { footEmpty })
  await shot('3-empty-dark.png')

  // ── 9. 关闭作废：重开后切进页签会重新拉 ──────────────────────────
  await cdp.eval('window.__slowlog = ' + JSON.stringify(SLOWLOG_72))
  const sOpen = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed before reopen')
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal reopen 2')
  const sReopen = await cdp.eval("window.__count('getRedisSlowlog')")
  await gotoSlowlog()
  await waitFor(cdp, 'window.__slRows().length === 5', 'rows after reopen', 8000)
  const sReopen2 = await cdp.eval("window.__count('getRedisSlowlog')")
  check('重开弹层不带上一次的旧条目（切进页签会重新拉一次）',
    sReopen === sOpen && sReopen2 - sReopen === 1, { sOpen, sReopen, sReopen2 })

  // ── 10. SLOWLOG 失败不连坐 INFO ──────────────────────────────────
  await cdp.eval('window.__slowlogThrows = "SLOWLOG disabled"')
  await cdp.eval('window.__clickFoot("刷新")')
  await waitFor(cdp, '!!window.__alert()', 'slowlog error shown', 8000)
  const errAlert = await cdp.eval('window.__alert()')
  const errRows = await cdp.eval('window.__slRows().length')
  const dot = await cdp.eval('window.__dot()')
  check('慢日志读取失败：红条只在慢日志页签（表格清空，不留旧数据冒充新的）',
    /SLOWLOG disabled/.test(String(errAlert)) && errRows === 0, { errAlert, errRows })
  check('取数失败不改顶栏连接状态（仍"已连接"）', /(^|\s)ok($|\s)/.test(String(dot)), { dot })
  await shot('4-error-dark.png')

  // ── 11. INFO 失败不影响慢日志 ────────────────────────────────────
  await cdp.eval('window.__slowlogThrows = null')
  await cdp.eval('window.__slowlog = ' + JSON.stringify(SLOWLOG_72))
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed before info fail')
  await cdp.eval('window.__info = ""')
  await cdp.eval('window.__infoThrows = "ERR unknown command \'INFO\'"')
  const sInfoFail0 = await cdp.eval("window.__count('getRedisSlowlog')")
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, '!!window.__alert()', 'info error shown', 8000)
  const labelsErr = JSON.parse(await cdp.eval('JSON.stringify(window.__tabLabels())'))
  check('INFO 被禁用：不摆三张空页，但慢日志页签仍在（另一条命令，不连坐）',
    labelsErr.length === 1 && /慢日志|slow log/i.test(labelsErr[0]), { labelsErr })
  // 三页不在，'overview' 就指到一个不存在的页签：必须自动拨过去，而不是空着等人点
  await waitFor(cdp, 'window.__slRows().length === 5', 'slowlog auto-loaded after INFO failed', 8000)
  const sInfoFail1 = await cdp.eval("window.__count('getRedisSlowlog')")
  const activeTab = await cdp.eval(
    "String((document.querySelector('.db-redis-info .ant-tabs-tab-active') || {}).textContent || '')")
  check('INFO 没原文时自动拨到慢日志页并恰好拉一次（不发第二次）',
    /慢日志|slow log/i.test(activeTab) && sInfoFail1 - sInfoFail0 === 1, { activeTab, sInfoFail0, sInfoFail1 })
  const alertNow = await cdp.eval('window.__alert()')
  const emptyHint = await cdp.eval('!!window.__one(".db-redis-info-empty")')
  check('这唯一一页上 INFO 的报错仍要说（三页没了它就没别处可去）',
    /unknown command/.test(String(alertNow)), { alertNow })
  check('但不叠加"这个实例没有返回任何 INFO"的空态（慢日志明明有数据）',
    emptyHint === false, { emptyHint })
  await shot('5-info-failed-dark.png')
  // 深色底下先取一次样式，切主题后用同一组取色比对（证明颜色跟 token 走）
  const styleDark = JSON.parse(await cdp.eval(`(() => {
    const el = document.querySelector('.db-redis-slowlog-num')
    const cs = el ? getComputedStyle(el) : null
    const td = document.querySelector('td.db-redis-slowlog-num')
    const th = document.querySelector('th.db-redis-slowlog-num')
    return JSON.stringify({
      color: cs && cs.color,
      mono: cs ? /mono/i.test(cs.fontFamily) : false,
      tn: cs ? String(cs.fontVariantNumeric) : '',
      tdAlign: td ? getComputedStyle(td).textAlign : null,
      thAlign: th ? getComputedStyle(th).textAlign : null
    })
  })()`))
  check('耗时列等宽 + tabular-nums，数据格右对齐（表头不跟着右对齐）',
    styleDark.mono && styleDark.tn.includes('tabular-nums') &&
    styleDark.tdAlign === 'right' && styleDark.thAlign !== 'right', { styleDark })
  const leaked = JSON.parse(await cdp.eval(
    "JSON.stringify((window.__modal() || '').match(/db[A-Z][A-Za-z]+/g) || [])"))
  check('文案已本地化（弹层里没有驼峰 key 原文）', leaked.length === 0, { leaked })

  // ── 12. 浅色主题 + 等宽链 ────────────────────────────────────────
  await cdp.eval('window.__infoThrows = null')
  await cdp.eval('window.__info = ' + JSON.stringify(INFO_FULL))
  await cdp.eval('window.__clickMaskClose()')
  await sleep(200)
  const theme0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1000)
    await cdp.eval('window.__clickHeadBtn("服务器信息")')
    await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal open light')
    await gotoSlowlog()
    await waitFor(cdp, 'window.__slRows().length === 5', 'slowlog rows light', 8000)
    const styleLight = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('.db-redis-slowlog-num')
      const cs = el ? getComputedStyle(el) : null
      return JSON.stringify({ color: cs && cs.color })
    })()`))
    check('浅色主题下慢日志表格文字随主题换色（不是写死的）',
      !!styleLight.color && styleLight.color !== styleDark.color, { styleDark, styleLight })
    await shot('6-slowlog-light.png')
    await cdp.eval('window.__clickMaskClose()')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
    await sleep(600)
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }

  await cdp.eval('window.__clickMaskClose()')
  await sleep(200)
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
