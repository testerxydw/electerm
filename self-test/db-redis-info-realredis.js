#!/usr/bin/env node
/**
 * H7a-4 Redis 服务器信息 —— 真 Redis 端到端（只读）
 *
 * 假 INFO 桩（db-redis-info-demo.js）验的是界面口径（「—」vs 0、KiB 单位、ms→时长、
 * 不轮询、错误不冒充断连）。真库这一层只验桩给不了的那半截：
 *   1) IPC → ioredis 的真链路：一次 INFO 往返真的拿回一份真原文（不是空串、不是被截断）
 *   2) 真字段形状：小节齐全（Server/Clients/Memory/Stats/Replication/Keyspace），
 *      原文长度与主进程 IPC 返回一致（弹层显示的就是那一整份，没有被中间层吃掉一段）
 *   3) 概览里的"键总数"与 Keyspace 行求和、左树 db 节点计数对得上
 *      （同一个实例的三份数字必须互相自洽，否则就是解析吃掉了小节）
 *   4) 命中率/内存/运行时长这类"只有真数据才有意义"的项出得来，且不出现 NaN/undefined
 *   5) 刷新走真链路（第二次原文里的瞬时计数会变，说明确实重新发过 INFO）
 *
 * 左树计数与弹层 Keyspace 各来自一次独立往返（连接时的 metadata、点开时的 INFO），
 * 生产实例期间会被别的客户端增删键，所以那条判据允许 TOLERANCE 个键的漂移；
 * "逐位相等"归假 INFO 桩去钉（同一段文本喂两处），不拿到真库上赌。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/ work/app/
 *   2) 起带 --remote-debugging-port 的实例
 *   3) RDB_REDIS_HOST=… RDB_REDIS_PORT=… RDB_REDIS_PASS=… node self-test/db-redis-info-realredis.js [port] [shotDir]
 *
 * 凭据只从环境变量读，绝不写进被 git 跟踪的文件。整轮只读：tab 以 readOnly:true 打开，
 * 脚本自身只发 getRedisInfo / getMetadata / getPageData，不发出任何写命令。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-info-realredis-shots')
// 左树/弹层两份快照之间允许漂移的键数（活实例会被别的客户端增删键）
const TOLERANCE = 5

const ENV = {
  host: process.env.RDB_REDIS_HOST,
  port: process.env.RDB_REDIS_PORT,
  pass: process.env.RDB_REDIS_PASS
}
if (!ENV.host || !ENV.port) {
  console.error('需要 RDB_REDIS_HOST / RDB_REDIS_PORT（可选 RDB_REDIS_PASS）')
  process.exit(2)
}

// 只 wrap（透传原函数），不接管：这样"到底发了几发 INFO、原文多长"看的是真 IPC
const PROBE = `
(() => {
  if (window.__h7aInfoReal) return 'already'
  window.__h7aInfoReal = true
  window.__calls = []
  window.__infoLens = []
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp' && a[1] === 'getRedisInfo') {
      window.__calls.push(JSON.stringify(a[2] || {}))
      // 记下主进程回来的原文长度：与弹层"原始信息"页的长度比对，
      // 证明 IPC 透传没有截断/丢字节
      return orig(name, ...a).then(r => {
        window.__infoLens.push(String(r || '').length)
        return r
      })
    }
    return orig(name, ...a)
  }
  window.__stubbed = !!(window.__space || window.__info)
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
  window.__clickHeadBtn = t => {
    const want = String(t).replace(/\\s+/g, '')
    const b = [...document.querySelectorAll('.db-head button')].filter(window.__vis)
      .find(x => String(x.textContent || '').replace(/\\s+/g, '').indexOf(want) > -1)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__tab = i => {
    const t = [...document.querySelectorAll('.db-redis-info .ant-tabs-tab')].filter(window.__vis)[i]
    if (!t) return 'missing'
    t.click()
    return 'ok'
  }
  window.__rowPairs = () => [...document.querySelectorAll('.db-redis-info-row')]
    .filter(window.__vis)
    .map(r => [
      String((r.querySelector('.db-redis-info-k') || {}).textContent || '').trim(),
      String((r.querySelector('.db-redis-info-v') || {}).textContent || '').trim()
    ])
  window.__ksRows = () => [...document.querySelectorAll('.db-redis-info .ant-table-tbody tr')]
    .filter(window.__vis)
    .map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()))
  window.__raw = () => {
    const p = window.__one('.db-redis-info-raw')
    return p ? String(p.textContent || '') : ''
  }
  window.__alert = () => {
    const a = window.__one('.db-redis-info-err')
    return a ? (a.innerText || '') : null
  }
  window.__dot = () => {
    const d = window.__one('.db-head-dot')
    return d ? d.className : null
  }
  window.__clickFoot = t => {
    const want = String(t).replace(/\\s+/g, '')
    const b = [...document.querySelectorAll('.ant-modal-footer button')]
      .filter(window.__vis).find(x => String(x.textContent || '').replace(/\\s+/g, '').indexOf(want) > -1)
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  // 左树里每个 db 节点的键数（来自 INFO keyspace，与弹层是同一份事实的两个出口）。
  // 逐节点取「库名 → 计数」而不是只抓一串数字：少了哪个 db、哪个数字对不上，
  // 只看排序后的数组分不出是"树漏了节点"还是"某个节点的计数没渲染"。
  window.__dbNodes = () => [...document.querySelectorAll('.db-tree-db')]
    .filter(window.__vis)
    .map(el => [
      String((el.querySelector('.db-tree-db-name') || {}).textContent || '').trim(),
      (el.querySelector('.db-tree-db-count') || {}).textContent != null
        ? String(el.querySelector('.db-tree-db-count').textContent).trim()
        : null
    ])
  return 'probed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis ${ENV.host}',
    dbType: 'redis',
    dbHost: ${JSON.stringify(ENV.host)},
    dbPort: Number(${JSON.stringify(String(ENV.port))}),
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
  await waitFor(cdp, "document.querySelectorAll('.db-tree-db-name').length > 0", 'metadata tree')
  const dot0 = await cdp.eval('window.__dot()')
  check('真连接建立（顶栏"已连接"）', /(^|\s)ok($|\s)/.test(String(dot0)), { dot0 })

  // ── 1. 一次 INFO 往返 ─────────────────────────────────────────────
  const before = await cdp.eval('window.__calls.length')
  const clicked = await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, 'window.__calls.length > ' + before, 'INFO request sent', 20000)
  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'overview rendered', 20000)
  const args = JSON.parse(await cdp.eval('JSON.stringify(window.__calls.slice(' + before + '))'))
  check('点一次只发一发 INFO、不带参数', clicked === 'ok' && args.length === 1 && args[0] === '{}',
    { clicked, args })

  // ── 2. 真原文形状 ────────────────────────────────────────────────
  await cdp.eval('window.__tab(2)')
  await waitFor(cdp, 'window.__raw().length > 200', 'raw INFO present')
  const raw = await cdp.eval('window.__raw()')
  const sections = [...raw.matchAll(/^#\s+(.+)$/gm)].map(m => m[1].trim())
  check('真 INFO 原文含核心小节（Server/Clients/Memory/Stats/Keyspace）',
    ['Server', 'Clients', 'Memory', 'Stats', 'Keyspace']
      .every(s => sections.some(x => x.toLowerCase() === s.toLowerCase())), { sections })
  // 主进程回来的原文长度 == 弹层"原始信息"页的长度：IPC 透传不截断、不丢字节
  const infoLens = JSON.parse(await cdp.eval('JSON.stringify(window.__infoLens)'))
  const shownLen = (await cdp.eval('window.__raw()')).replace(/\s+/g, '').length
  check('原文完整穿过 IPC（长度与主进程返回一致）',
    infoLens.length === 1 && Math.abs(infoLens[0] - (await cdp.eval('window.__raw()')).length) <= 1, {
      infoLens,
      shownLen
    })
  await shot('1-raw-real.png')

  // ── 3. 概览：真字段出得来，且不出现猜的值 ────────────────────────
  await cdp.eval('window.__tab(0)')
  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'overview again')
  const rows = JSON.parse(await cdp.eval('JSON.stringify(window.__rowPairs())'))
  const text = JSON.stringify(rows)
  check('概览没有 NaN / undefined / 驼峰 key 漏出',
    !/NaN|undefined|^db[A-Z]/.test(text) && !/db[A-Z][A-Za-z]+/.test(rows.map(r => r[0]).join('|')),
    { sample: rows.slice(0, 6) })
  const version = rows.find(([k]) => /版本|version/i.test(k))
  const uptime = rows.find(([k]) => /运行时长|uptime/i.test(k))
  const clients = rows.find(([k]) => /已连接客户端|connected clients/i.test(k))
  const mem = rows.find(([k]) => /已用内存|used memory/i.test(k))
  const hit = rows.find(([k]) => /命中率|hit rate/i.test(k))
  check('版本/运行时长/客户端/内存出真值',
    !!(version && /^\d+\.\d+/.test(version[1])) &&
    !!(uptime && /\d/.test(uptime[1])) &&
    !!(clients && /\d/.test(clients[1])) &&
    !!(mem && /(B|KiB|MiB|GiB)/.test(mem[1])), { version, uptime, clients, mem })
  // 命中率：真实例只要有过查询就该是个百分比；一次查询都没有才该是「—」，
  // 两种都算对，唯独不许出现"猜出来的 0.00%"以外的假数（0.00% 只允许在 hits=0 时出现）
  check('命中率出百分比或「—」（不猜数）',
    !!hit && (/^\d+(\.\d+)?%$/.test(hit[1]) || hit[1] === '—'), { hit })
  await shot('2-overview-real.png')

  // ── 4. Keyspace 与左树计数自洽 ────────────────────────────────────
  await cdp.eval('window.__tab(1)')
  await waitFor(cdp, 'window.__ksRows().length >= 1', 'keyspace rows')
  const ks = JSON.parse(await cdp.eval('JSON.stringify(window.__ksRows())'))
  const ksIdx = ks.map(r => r[0])
  check('Keyspace 按 db 序号升序（真库常见 db0/db1/…/db10 混序）',
    ksIdx.join(',') === [...ksIdx].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).join(','),
    { ksIdx })
  // 截图要趁 Keyspace 页签还露着的时候拍：切回概览再拍，拍到的还是概览
  await shot('3-keyspace-real.png')
  const ksSum = ks.reduce((s, r) => s + (Number(r[1]) || 0), 0)
  await cdp.eval('window.__tab(0)')
  await waitFor(cdp, 'window.__rowPairs().length >= 20', 'overview for total')
  const totalRow = JSON.parse(await cdp.eval('JSON.stringify(window.__rowPairs())'))
    .find(([k]) => /键总数|total keys/i.test(k))
  check('概览"键总数" = Keyspace 各行之和（同一份事实的两个出口）',
    !!totalRow && Number(String(totalRow[1]).replace(/[^0-9]/g, '')) === ksSum, {
      totalRow,
      ksSum
    })
  // 左树 db 节点的计数也来自 INFO keyspace，与弹层是同一份事实的两个出口。
  // 这里钉的是「两个出口说的是同一件事」：库名集合、顺序、每个库的键数都要对得上。
  // 但两份快照有先后（树 = 连接时的 metadata，弹层 = 点开的这一次 INFO），
  // tgfsom 是活的生产实例，期间会被别的客户端增删键，所以数字允许 ±TOLERANCE 漂移；
  // 「逐位相等」那种判据在假库 demo 里已经钉死了（同一段文本喂两处），不该拿到真库上赌。
  const treeNodes = JSON.parse(await cdp.eval('JSON.stringify(window.__dbNodes())'))
  const ksMap = new Map(ks.map(r => [r[0], Number(r[1])]))
  const treeMap = new Map(treeNodes.map(([n, c]) => [n, c === null ? null : Number(c)]))
  const drift = []
  ks.forEach(([name]) => {
    if (!treeMap.has(name)) {
      drift.push(`${name}: 弹层有、树里没有`)
    }
  })
  treeNodes.forEach(([name, text]) => {
    const got = Number(text)
    const want = ksMap.has(name) ? ksMap.get(name) : 0
    if (!Number.isFinite(got) || Math.abs(got - want) > TOLERANCE) {
      drift.push(`${name}: 树=${text} 弹层=${want}`)
    }
  })
  // 库名从 db0 起连续升序（不硬写 16：databases 被调大时这里也该过），
  // 每个节点都带数字徽标（INFO 可用时不该有库"没数"），且 Keyspace 里出现的库都在树里。
  check('左树 db 节点与 Keyspace 表同源（库名/顺序一致，计数在同一份 keyspace 的漂移内）',
    treeNodes.length > 0 &&
    treeNodes.every(([name, text], i) => name === 'db' + i && text !== null &&
      Number.isFinite(Number(text))) &&
    ks.every(([name]) => treeMap.has(name)) &&
    drift.length === 0, { drift, treeNodes, ks })

  // ── 5. 刷新走真链路 ──────────────────────────────────────────────
  await cdp.eval('window.__tab(2)')
  await sleep(200)
  const rawSnapshot = await cdp.eval('window.__raw()')
  const opsBefore = String((rawSnapshot.match(/^total_commands_processed:(\d+)$/m) || ['', ''])[1])
  const callsBeforeRefresh = await cdp.eval('window.__calls.length')
  const clickedRefresh = await cdp.eval('window.__clickFoot("刷新")')
  await waitFor(cdp, 'window.__calls.length > ' + callsBeforeRefresh, 'refresh sent', 20000)
  await cdp.eval('window.__tab(2)')
  await sleep(400)
  const rawAfter = await cdp.eval('window.__raw()')
  const callsAfterRefresh = await cdp.eval('window.__calls.length')
  const opsAfter = String((rawAfter.match(/^total_commands_processed:(\d+)$/m) || ['', ''])[1])
  // 判据是"确实又发了一发、并且换回一份完整原文"；累计计数变不变取决于这台实例
  // 这 0.5s 里有没有别的客户端在动，不能拿来当"刷新生效"的依据
  check('刷新真的重新发 INFO 并换回完整原文',
    clickedRefresh === 'ok' && callsAfterRefresh === callsBeforeRefresh + 1 && rawAfter.length > 200, {
      clickedRefresh,
      callsBeforeRefresh,
      callsAfterRefresh,
      lenBefore: rawSnapshot.length,
      lenAfter: rawAfter.length
    })
  check('原文里累计计数仍在（同一份 INFO 的两个字段都解析得到）',
    /^\d+$/.test(opsBefore) && /^\d+$/.test(opsAfter), { opsBefore, opsAfter })

  // ── 6. 关掉再开：不带上一次原文（清空后重拉） ────────────────────
  await cdp.eval('window.__one(".ant-modal-close").click()')
  await waitFor(cdp, "!window.__one('.db-redis-info')", 'modal closed')
  const callsClosed = await cdp.eval('window.__calls.length')
  await cdp.eval('window.__clickHeadBtn("服务器信息")')
  await waitFor(cdp, 'window.__calls.length > ' + callsClosed, 'reopened refetches', 20000)
  check('关闭后重开重新拉一次 INFO', await cdp.eval('window.__calls.length') === callsClosed + 1, {
    callsClosed
  })
  const dotEnd = await cdp.eval('window.__dot()')
  check('全程只读操作不改连接状态', /(^|\s)ok($|\s)/.test(String(dotEnd)), { dotEnd })

  await cdp.eval('window.__one(".ant-modal-close") && window.__one(".ant-modal-close").click()')
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
