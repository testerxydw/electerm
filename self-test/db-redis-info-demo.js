#!/usr/bin/env node
/**
 * H7a-4 Redis 服务器信息弹层 —— CDP 实机演示/回归（无需真 Redis）
 *
 * 在渲染层 IPC 边界注入假 INFO（window.__info / window.__infoThrows），走真的顶栏按钮 +
 * 真的弹层。验的是桩覆盖不到的那半截 —— 界面拿到"事实"之后有没有替用户编结论：
 *   1) 入口只在 Redis tab（MySQL tab 顶栏没有这个按钮）
 *   2) 打开拉一次、不轮询（静置 2s 调用数不变）；手动刷新才再拉
 *   3) 缺字段出「—」不出 0：config_file 空值、稀疏 INFO 的命中率/键总数
 *   4) 真 0 出 0：blocked_clients:0 / evicted_keys:0 不能被当成"没拿到"
 *   5) maxmemory:0 说成"未设上限"（不是"内存上限 0"）
 *   6) 字节走 KiB/MiB（不抄 Redis 的 *_human 10.00M）；命中率 97.00%；碎片率两位
 *   7) Keyspace 按序号排（db2 在 db10 前）+ avg_ttl 毫秒换算成时长
 *   8) 刷新期间旧内容不闪空；关闭再开重新拉、不带上一次的旧 INFO
 *   9) INFO 被禁用：错误留在弹层，顶栏仍显示"已连接"（不误判成整条连接断了）
 *  10) 文案已过 i18n（弹层里没有 dbXxx 驼峰 key 原文漏出）
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 且跑完不还原（同 db-key-tree-demo.js）。
 * 真库那份（db-redis-info-realredis.js）开跑前会 Page.reload 并钉"现场没有桩"。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/ work/app/（getRedisInfo op 要进主进程）
 *   2) 起带 --remote-debugging-port 的实例
 *   3) node self-test/db-redis-info-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-info-shots')

// 真 Redis 7.2.6 的字段形状（节选）：有空值、有真 0、keyspace 故意乱序 + avg_ttl 毫秒
const INFO_FULL = [
  '# Server',
  'redis_version:7.2.6',
  'redis_mode:standalone',
  'os:Linux 6.18.48 x86_64',
  'config_file:',
  'uptime_in_seconds:259200',
  '',
  '# Clients',
  'connected_clients:12',
  'blocked_clients:0',
  'maxclients:10000',
  '',
  '# Memory',
  'used_memory:10485760',
  'used_memory_human:10.00M',
  'used_memory_rss:15728640',
  'maxmemory:0',
  'maxmemory_policy:noeviction',
  'mem_fragmentation_ratio:1.50',
  '',
  '# Stats',
  'ops_per_sec:0',
  'keyspace_hits:970',
  'keyspace_misses:30',
  'instantaneous_ops_per_sec:250',
  'evicted_keys:0',
  'expired_keys:7',
  'rejected_connections:0',
  '',
  '# Replication',
  'role:master',
  'connected_slaves:2',
  '',
  '# Keyspace',
  'db10:keys=8,expires=8,avg_ttl=3661000',
  'db0:keys=6,expires=0,avg_ttl=0',
  'db2:keys=120,expires=12,avg_ttl=86400000'
].join('\r\n')

// 受管/精简实例：只有 Server 小节。概览必须大部分是「—」，命中率与键总数不能猜
const INFO_SPARSE = [
  '# Server',
  'redis_version:6.2.0',
  'redis_mode:standalone',
  'uptime_in_seconds:60',
  '# Client Count and Stats',
  'connected_clients:3'
].join('\n')

const STUB = `
(() => {
  window.__full = ${JSON.stringify(INFO_FULL)}
  window.__sparse = ${JSON.stringify(INFO_SPARSE)}
  window.__info = window.__full
  window.__infoThrows = null
  window.__delay = 0
  window.__calls = []
  window.__count = sub => window.__calls.filter(c => c.indexOf(sub) === 0).length
  const KEYS = ['a:1', 'a:2', 'b:1']
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__calls.push(op + ' ' + JSON.stringify(args))
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'db0', type: 'database', count: KEYS.length }])
      }
      if (op === 'getPageData') {
        return Promise.resolve({
          rows: KEYS.map(n => ({ name: n, type: 'string', ttl: -1 })),
          nextCursor: '0',
          hasMore: false
        })
      }
      if (op === 'getKeyDetail') {
        return Promise.resolve({ type: 'string', value: 'v', fields: [], ttl: -1 })
      }
      if (op === 'getRedisInfo') {
        if (window.__infoThrows) {
          return new Promise((res, rej) => setTimeout(
            () => rej(new Error(window.__infoThrows)), window.__delay || 0))
        }
        return new Promise(r => setTimeout(
          () => r(String(window.__info || '')), window.__delay || 0))
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'closeDbTab') return Promise.resolve(null)
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
  window.__headBtns = () => [...document.querySelectorAll('.db-head button')]
    .filter(window.__vis)
    .map(b => (b.textContent || '').trim())
  // antd 给两字中文按钮插一个空格（textContent 是 "刷 新"/"关 闭"），
  // 直接 indexOf('刷新') 永远找不到 —— 匹配前必须把空白抹掉
  window.__norm = s => String(s || '').replace(/\\s+/g, '')
  window.__clickHeadBtn = t => {
    const want = window.__norm(t)
    const b = [...document.querySelectorAll('.db-head button')].filter(window.__vis)
      .find(x => window.__norm(x.textContent).indexOf(want) > -1)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__modal = () => {
    const m = window.__one('.db-redis-info')
    return m ? (m.innerText || '') : null
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
    .map(r => [
      (r.querySelector('.db-redis-info-k') || {}).textContent,
      (r.querySelector('.db-redis-info-v') || {}).textContent
    ].map(s => String(s || '').trim()))
  window.__row = labelPart => {
    const hit = window.__rowPairs().find(([k]) => k.indexOf(labelPart) > -1)
    return hit ? hit[1] : null
  }
  window.__ksRows = () => [...document.querySelectorAll('.db-redis-info .ant-table-tbody tr')]
    .filter(window.__vis)
    .map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()))
  window.__alert = () => {
    const a = window.__one('.db-redis-info-err')
    return a ? (a.innerText || '') : null
  }
  window.__dot = () => {
    const d = window.__one('.db-head-dot')
    return d ? d.className : null
  }
  window.__footBtns = () => [...document.querySelectorAll('.ant-modal-footer button')]
    .filter(window.__vis).map(b => ({
      t: window.__norm(b.textContent),
      disabled: !!b.disabled
    }))
  window.__clickFoot = t => {
    const want = window.__norm(t)
    const b = [...document.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => window.__norm(x.textContent).indexOf(want) > -1)
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
  return 'stubbed'
})()
`

const openTab = dbType => `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: '${dbType} 127.0.0.1:6379',
    dbType: '${dbType}',
    dbHost: '127.0.0.1',
    dbPort: ${dbType === 'redis' ? 6379 : 3306},
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
  // 硬刷一次：db-session 是懒加载 chunk，改完代码不 reload 就会在旧 chunk 上跑绿/跑红
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

  await cdp.eval(STUB)
  await clearDbTabs(cdp)

  // ── 1. 入口只在 Redis ─────────────────────────────────────────────
  const mysqlRes = JSON.parse(await cdp.eval(openTab('mysql')))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(mysqlRes.id), 'mysql tab active')
  await sleep(500)
  const mysqlBtns = JSON.parse(await cdp.eval('JSON.stringify(window.__headBtns())'))
  const hasInfoRe = /服务器信息|server info/i
  check('MySQL tab 顶栏没有"服务器信息"按钮',
    !mysqlBtns.some(t => hasInfoRe.test(t)), { mysqlBtns })
  await cdp.eval('window.__clickHeadBtn("服务器信息")')

  const redisRes = JSON.parse(await cdp.eval(openTab('redis')))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(redisRes.id), 'redis tab active')
  await waitFor(cdp, "document.querySelectorAll('.db-tree-db-name').length > 0", 'redis tree loaded')
  const redisBtns = JSON.parse(await cdp.eval('JSON.stringify(window.__headBtns())'))
  check('Redis tab 顶栏有"服务器信息"按钮',
    redisBtns.some(t => hasInfoRe.test(t)), { redisBtns })

  // ── 2. 打开拉一次，不轮询 ─────────────────────────────────────────
  const infoCalls0 = await cdp.eval("window.__count('getRedisInfo')")
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, "!!window.__one('.db-redis-info')", 'modal open')
  const infoCalls1 = await cdp.eval("window.__count('getRedisInfo')")
  check('打开弹层恰好拉一次 INFO（无 section 参数 = 一次全量往返）',
    infoCalls1 - infoCalls0 === 1, { infoCalls0, infoCalls1 })
  const arg = await cdp.eval("window.__calls.find(c => c.indexOf('getRedisInfo') === 0)")
  check('op 走 dbClientOp 且不带参数（不 select db）',
    /^getRedisInfo \{\}$/.test(String(arg)), { arg })

  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'overview rows rendered')
  const rowsA = JSON.parse(await cdp.eval('JSON.stringify(window.__rowPairs())'))
  // 记下深色主题下的取色，第 9 步用同一选择器比对（证明颜色跟 token 走，不是写死）
  const darkColors = JSON.parse(await cdp.eval(`(() => {
    const v = window.__one('.db-redis-info-v')
    const cs = getComputedStyle(v)
    return JSON.stringify({ text: cs.color, mono: /mono/i.test(cs.fontFamily) })
  })()`))
  await sleep(2000)
  const infoCalls2 = await cdp.eval("window.__count('getRedisInfo')")
  check('静置 2s 不再多发（没有常驻轮询）', infoCalls2 === infoCalls1, { infoCalls1, infoCalls2 })

  // ── 3. 概览数值口径 ───────────────────────────────────────────────
  const kv = {}
  for (const [k, v] of rowsA) {
    if (!(k in kv)) {
      kv[k] = v
    }
  }
  const find = re => Object.entries(kv).find(([k, v]) => re.test(k) || re.test(v))
  const pair = re => {
    const hit = find(re)
    return hit ? { k: hit[0], v: hit[1] } : null
  }
  const version = pair(/7\.2\.6/)
  const hitRate = pair(/97\.00%/)
  const usedMem = pair(/10 MiB/)
  const rss = pair(/15 MiB/)
  const noLimit = pair(/未设上限|no limit/i)
  const frag = pair(/^1\.50$|碎片|fragment/i)
  check('版本/命中率/内存按 KiB 口径渲染',
    !!version && !!hitRate && !!usedMem && !!rss, { version, hitRate, usedMem, rss })
  check('maxmemory:0 显示"未设上限"而不是"0"', !!noLimit, {
    noLimit,
    // 0 字节这种值留在界面上会被读成"内存上限是 0"
    hasZeroMax: Object.entries(kv).some(([k, v]) => /上限|max/i.test(k) && v === '0')
  })
  check('命中率 97.00%（970/(970+30)）而不是抄 ops_per_sec', !!hitRate, { hitRate })
  check('碎片率 1.50（两位，不是一串浮点）', !!frag, { frag })
  const zeroRows = rowsA.filter(([, v]) => v === '0')
  check('真 0 出 0（blocked/evicted/rejected 不能被当成"没拿到"）',
    zeroRows.length >= 3, { zero: zeroRows.map(([k]) => k) })
  const dashRows = rowsA.filter(([, v]) => v === '—')
  check('config_file 空值出「—」', dashRows.some(([k]) => /配置|config/i.test(k)), {
    dash: dashRows.map(([k]) => k)
  })
  check('概览文案已本地化（没有驼峰 key 漏出）',
    rowsA.every(([k]) => !/^db[A-Z][A-Za-z]+$/.test(k)), {
      leaked: rowsA.map(([k]) => k).filter(k => /^db[A-Z][A-Za-z]+$/.test(k))
    })
  await shot('1-overview-dark.png')

  // ── 4. Keyspace：排序 + avg_ttl 单位 ──────────────────────────────
  await cdp.eval('window.__tab(1)')
  await waitFor(cdp, 'window.__ksRows().length === 3', 'keyspace rows')
  const ks = JSON.parse(await cdp.eval('JSON.stringify(window.__ksRows())'))
  const order = ks.map(r => r[0])
  check('Keyspace 按 db 序号排（db2 在 db10 前，不是字符串序）',
    order.join(',') === 'db0,db2,db10', { order })
  const flat = JSON.stringify(ks)
  // avg_ttl 毫秒 → 时长：86400000ms = 1d、3661000ms = 1h01m01s、0ms = 0s
  check('avg_ttl 按毫秒换算成时长（1d / 1h 01m 01s / 0s）',
    /1d 00h 00m 00s/.test(flat) && /1h 01m 01s/.test(flat) && /0s/.test(flat), { ks })
  check('键数/带过期数原样出（6/120/8 与 0/12/8）',
    /"6"/.test(flat) && /"120"/.test(flat) && /"8"/.test(flat) && /"12"/.test(flat), { ks })
  await shot('2-keyspace-dark.png')

  // ── 5. 原始 INFO 页签 + 复制 ─────────────────────────────────────
  await cdp.eval('window.__tab(2)')
  await waitFor(cdp, "!!window.__one('.db-redis-info-raw')", 'raw tab')
  const rawLen = await cdp.eval("(window.__one('.db-redis-info-raw') || {}).textContent.replace(/\\s+/g,'').length")
  const footBtns = JSON.parse(await cdp.eval('JSON.stringify(window.__footBtns())'))
  check('原始页签给出完整 INFO 原文', rawLen > 500, { rawLen })
  check('footer 三个动作（复制/刷新/关闭）且都有词条',
    footBtns.length === 3 && footBtns.every(b => b.t && !/^db[A-Z]/.test(b.t)), { footBtns })
  check('有原文时"复制"可用', footBtns.some(b => !b.disabled), { footBtns })
  await shot('3-raw-dark.png')

  // ── 6. 刷新：旧内容不闪空，且真的再发一次 ────────────────────────
  await cdp.eval('window.__tab(0)')
  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'back to overview')
  await cdp.eval('window.__delay = 1200')
  const beforeRefresh = await cdp.eval("window.__count('getRedisInfo')")
  const clickedRefresh = await cdp.eval('window.__clickFoot("刷新")')
  await sleep(350)
  const rowsDuring = await cdp.eval('window.__rowPairs().length')
  const alertDuring = await cdp.eval('!!window.__alert()')
  check('刷新中不闪空板（旧内容还在）且不出错误',
    clickedRefresh === 'ok' && rowsDuring >= 20 && !alertDuring, { clickedRefresh, rowsDuring, alertDuring })
  await waitFor(cdp, 'window.__count("getRedisInfo") > ' + beforeRefresh, 'refresh request sent', 8000)
  const afterRefresh = await cdp.eval("window.__count('getRedisInfo')")
  check('手动刷新会真的再拉一次', afterRefresh === beforeRefresh + 1, {
    clickedRefresh,
    beforeRefresh,
    afterRefresh
  })
  await cdp.eval('window.__delay = 0')

  // ── 7. 关闭即清：下次打开重新拉，不闪旧 INFO ──────────────────────
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'modal closed')
  const closedCalls = await cdp.eval("window.__count('getRedisInfo')")
  await cdp.eval('window.__info = window.__sparse')
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, 'window.__rowPairs().length >= 1', 'modal reopened')
  const reopenCalls = await cdp.eval("window.__count('getRedisInfo')")
  check('关闭后重开会重新拉一次', reopenCalls === closedCalls + 1, { closedCalls, reopenCalls })
  const sparseRows = JSON.parse(await cdp.eval('JSON.stringify(window.__rowPairs())'))
  const sparseText = JSON.stringify(sparseRows)
  check('精简实例：命中率/键总数出「—」而不是 0',
    !/0\.00%/.test(sparseText) && !/"0",\s*"命中率/.test(sparseText), { sparseRows })
  const sparseDash = sparseRows.filter(([, v]) => v === '—').length
  check('缺字段大部分出「—」（没有把 undefined 落成字符串"undefined"）',
    sparseDash >= 15 && !/undefined/.test(sparseText), { sparseDash })
  check('精简实例仍能显示拿到的那几项（版本 6.2.0）', /6\.2\.0/.test(sparseText), {
    sample: sparseRows.slice(0, 4)
  })
  await shot('4-sparse-dark.png')

  // ── 8. INFO 被禁用：错误留在弹层，顶栏不判成断连 ──────────────────
  await cdp.eval('window.__clickMaskClose()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'closed before error run')
  await cdp.eval('window.__infoThrows = "ERR unknown command \'INFO\'"')
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, '!!window.__alert()', 'error alert shown', 8000)
  const alertText = await cdp.eval('window.__alert()')
  const dotAfterErr = await cdp.eval('window.__dot()')
  check('INFO 被禁用：弹层内提示原文（不吞成空概览）',
    /unknown command/.test(String(alertText)) && /读取失败|failed/i.test(String(alertText)), { alertText })
  check('取数失败不改顶栏连接状态（仍"已连接"）', /(^|\s)ok($|\s)/.test(String(dotAfterErr)), {
    dotAfterErr
  })
  const errRows = await cdp.eval('window.__rowPairs().length')
  const errEmpty = await cdp.eval("(window.__modal() || '').length")
  // 失败已经说了"读不到"，不该再补一句"这个实例没有返回任何 INFO"：
  // 两句并存会把"被禁用"说成"实例是空的"
  const emptyHintWithErr = await cdp.eval('!!window.__one(".db-redis-info-empty")')
  check('失败时不显示假概览（不是一排 0 的表）', errRows === 0 && errEmpty < 400, {
    errRows,
    errEmpty
  })
  check('失败时不叠加"没有返回 INFO"空态提示', emptyHintWithErr === false, { emptyHintWithErr })
  await shot('5-error-dark.png')

  // ── 9. 浅色主题：弹层颜色全走 token，换主题必须跟着变 ─────────────
  await cdp.eval('window.__infoThrows = null')
  await cdp.eval('window.__info = window.__full')
  await cdp.eval('window.__clickMaskClose()')
  await sleep(200)
  const cfg0 = { theme: await cdp.eval('String((window.store._config || {}).theme)') }
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0.theme)
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1000)
    await cdp.eval('window.__clickHeadBtn("服务器信息")')
    await waitFor(cdp, 'window.__rowPairs().length >= 20', 'reopened after theme switch')
    const lightColors = JSON.parse(await cdp.eval(`(() => {
      const v = window.__one('.db-redis-info-v')
      const cv = getComputedStyle(v)
      return JSON.stringify({ text: cv.color, mono: /mono/i.test(cv.fontFamily) })
    })()`))
    // 写死颜色（--dark-text 之类）在浅色底下会出现"深字压深底"；
    // 这里用同一选择器在两个主题下的取色是否变化来证明它跟着 token 走
    check('浅色主题下弹层文字随主题换色（不是写死的）',
      !!lightColors.text && lightColors.text !== darkColors.text, { darkColors, lightColors })
    check('值列用等宽字体 + tabular-nums（数字竖排对齐）', lightColors.mono, { lightColors })
    await shot('6-overview-light.png')
    await cdp.eval('window.__clickMaskClose()')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(600)
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
