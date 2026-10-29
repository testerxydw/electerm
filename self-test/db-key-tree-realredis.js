#!/usr/bin/env node
/**
 * H7a-3 Redis 键树 —— 真 Redis 端到端（只读）
 *
 * 假 RESP 桩（db-key-tree-demo.js）验的是"抓取的形状"：分页游标、去重、上限截断、
 * 取消令牌。这些都需要一个能配合的大键空间，真库给不了（也**不该**在别人的生产实例上
 * 造 1 万个键去验截断）。真库这一层只验桩覆盖不到的那半截：
 *   1) IPC 到 ioredis 的真链路：SCAN 游标 + keysOnly 在后端真的成立（不再逐键 TYPE/TTL）
 *   2) 树的分层吃真键名：真 keyspace 计数 == 树状态数字 == 树里能找到的完整键名数
 *   3) 改分隔符只重分层不重扫、视图来回切复用（真网络往返下这两条才有代价）
 *   4) 点叶子走真 getKeyDetail（TYPE/TTL/值一次到位）
 *
 * 上限截断与取消：见 self-test/db-key-tree-demo.js 的第 5、6 步（12000 键假库）。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例
 *   3) RDB_REDIS_HOST=… RDB_REDIS_PORT=… RDB_REDIS_PASS=… [RDB_REDIS_DB=1] \
 *      node self-test/db-key-tree-realredis.js [debugPort] [shotDir]
 *
 * 凭据只从环境变量读，绝不写进被 git 跟踪的文件。整轮只读：tab 以 readOnly:true 打开，
 * 脚本自身不发出任何写命令（只有 getMetadata / getPageData / getKeyDetail）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-key-tree-realredis-shots')

const ENV = {
  host: process.env.RDB_REDIS_HOST,
  port: process.env.RDB_REDIS_PORT,
  pass: process.env.RDB_REDIS_PASS
}
const DB = process.env.RDB_REDIS_DB || '1'

// 探针：与假库版同名同语义，区别只在于不接管 runGlobalAsync。
// 记录用 wrap（透传原函数），这样"这一发到底有没有带 keysOnly"看的是真 IPC 参数。
const PROBE = `
(() => {
  if (window.__h7aReal) return 'already'
  window.__h7aReal = true
  window.__calls = []
  const orig = window.pre.runGlobalAsync.bind(window.pre)
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp' && a[1] === 'getPageData') {
      window.__calls.push(JSON.stringify(a[2] || {}))
    }
    return orig(name, ...a)
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
  window.__clickDb = name => {
    const el = [...document.querySelectorAll('.db-tree-db-name')]
      .filter(window.__vis)
      .find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__bar = () => window.__one('.db-redis-bar')
  window.__inBar = sel => {
    const b = window.__bar()
    return b ? [...b.querySelectorAll(sel)] : []
  }
  window.__segItems = () => window.__inBar('.ant-segmented-item')
  window.__seg = i => {
    const it = window.__segItems()[i]
    if (!it) return 'missing'
    const inp = it.querySelector('input')
    ;(inp || it).click()
    return 'ok'
  }
  // INFO keyspace 的真键数挂在左侧库节点上（.db-tree-db-count）——
  // 它是树状态那个数的独立来源：一个来自 SCAN 收满，一个来自服务端计数
  window.__dbCount = name => {
    const el = [...document.querySelectorAll('.db-tree-db')]
      .filter(window.__vis)
      .find(x => {
        const n = x.querySelector('.db-tree-db-name')
        return n && n.innerText.trim() === name
      })
    if (!el) return null
    const c = el.querySelector('.db-tree-db-count')
    return c ? Number(c.innerText) : null
  }
  window.__keyNames = () => {
    const c = window.__one('.db-redis-keys')
    if (!c) return []
    return [...c.querySelectorAll('.ant-table-row')]
      .map(r => r.innerText.trim().split(/\\s+/)[0])
      .filter(Boolean)
  }
  window.__sepInput = () => {
    const el = window.__one('.db-redis-tree-sep-input')
    return el ? (el.tagName === 'INPUT' ? el : el.querySelector('input')) : null
  }
  window.__setSep = v => {
    const input = window.__sepInput()
    if (!input) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__status = () => {
    const el = window.__one('.db-redis-tree-status')
    if (!el) return { text: '<no status>', nums: [], truncated: false }
    return {
      text: el.innerText.trim(),
      nums: (el.innerText.match(/\\d+/g) || []).map(Number),
      truncated: el.className.indexOf('is-truncated') > -1
    }
  }
  window.__tree = () => window.__one('.db-redis-tree')
  // 叶子 span 的 title 属性 = 完整键名（titleRender 里 node.keyName || node.title）；
  // 纯目录没有 keyName，title 就是段名 —— 所以「title 命中完整键名」的数量可当唯一键数用
  window.__nodeTitles = () => {
    const c = window.__tree()
    if (!c) return []
    return [...c.querySelectorAll('.db-redis-tree-node')]
      .filter(window.__vis)
      .map(el => el.getAttribute('title'))
      .filter(t => t !== null && t !== '')
  }
  window.__titles = () => {
    const c = window.__tree()
    if (!c) return []
    return [...c.querySelectorAll('.ant-tree-treenode')]
      .filter(window.__vis)
      .filter(n => n.querySelector('.db-redis-tree-title'))
      .map(n => n.querySelector('.db-redis-tree-title').innerText)
  }
  // 把所有未展开的目录点开（真库键名可能有多层，判据要覆盖整棵树）
  window.__expandAll = () => {
    const c = window.__tree()
    if (!c) return 'no-tree'
    let n = 0
    for (let round = 0; round < 6; round++) {
      const closed = [...c.querySelectorAll('.ant-tree-switcher_close')].filter(window.__vis)
      if (!closed.length) break
      for (const s of closed) {
        s.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        n++
      }
    }
    return n
  }
  // 按「完整键名」点：段名（server0001）在多个前缀下会重名，按标题文字点会点到别家
  window.__clickKey = fullName => {
    const c = window.__tree()
    if (!c) return 'missing'
    const span = [...c.querySelectorAll('.db-redis-tree-node')]
      .filter(window.__vis)
      .find(el => el.getAttribute('title') === fullName)
    if (!span) return 'missing'
    const w = span.closest('.ant-tree-node-content-wrapper') || span
    w.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__detail = () => {
    const el = window.__one('.db-redis-detail')
    if (!el) return null
    return {
      empty: el.className.indexOf('db-redis-detail-empty') > -1,
      text: el.innerText.slice(0, 80)
    }
  }
  return 'probe-installed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis real tree',
    dbType: 'redis',
    dbHost: ${JSON.stringify(ENV.host)},
    dbPort: Number(${JSON.stringify(ENV.port)}),
    dbPassword: ${JSON.stringify(ENV.pass)},
    dbName: ${JSON.stringify(DB)},
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
  for (const k of ['host', 'port', 'pass']) {
    if (ENV[k] === undefined) {
      throw new Error('缺环境变量 RDB_REDIS_' + k.toUpperCase() + '（凭据只走 env，不写文件）')
    }
  }
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  // 先刷新：假库版（db-key-tree-demo.js）把 window.pre.runGlobalAsync 整个接管了，
  // 它跑完不会自己还原 —— 同一个实例里接着跑真库，点开的还是那个 3000 键的假 db0，
  // 判据会在"真库"标题下全绿。刷新把渲染层回到干净状态，再钉一道"现场没有桩"。
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1500)
  const stubbed = await cdp.eval('(() => !!window.__space || !!window.__h7aReal)()')
  check('刷新后渲染层没有假库桩残留', !stubbed, { stubbed })
  if (stubbed) {
    console.log('\n真库判据必须在干净的 IPC 层上跑，终止。')
    process.exit(1)
  }
  await sleep(600)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  await clearDbTabs(cdp)
  await cdp.eval(PROBE)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(openRes.id), 'tab active')
  // 真连接要么出树，要么出错误页；别干等
  const loaded = await waitFor(cdp,
    "document.querySelectorAll('.db-tree-db-name').length > 0 || !!window.__one('.db-session-error')",
    'real redis connects', 60000)
  if (!loaded || await cdp.eval("!!window.__one('.db-session-error')")) {
    const err = await cdp.eval(`(() => {
      const el = window.__one('.db-session-error')
      return el ? el.innerText.slice(0, 200) : '<no tree, no error>'
    })()`)
    check('真 Redis 连得上（' + ENV.host + ':' + ENV.port + '）', false, { err })
    const failed = results.filter(r => !r.ok)
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
    process.exit(1)
  }

  // ── 1. 真库键列表 ────────────────────────────────────────────────
  const clicked = await cdp.eval('window.__clickDb(' + JSON.stringify('db' + DB) + ')')
  await waitFor(cdp, 'window.__keyNames().length > 0', 'real list rows', 40000)
  const dbCount = await cdp.eval('window.__dbCount(' + JSON.stringify('db' + DB) + ')')
  const listNames = JSON.parse(await cdp.eval('JSON.stringify(window.__keyNames())'))
  check('真库点 db 出键列表（' + DB + ' 库 INFO keyspace = ' + dbCount + ' 键）',
    clicked === 'ok' && dbCount > 0 && listNames.length > 0, { clicked, dbCount, rows: listNames.length })
  // 网格是虚拟列表：DOM 里只有视口那十几行，所以"列表行"只能当键名样本用，
  // 全量判据走 INFO keyspace（下一条）；这里钉的是"样本没超出整库"这个下界
  check('列表可见行是真库键名的样本（行数 ≤ 整库键数）',
    listNames.length > 0 && listNames.length <= dbCount, { rows: listNames.length, dbCount })
  // 列表首屏的行必须带 type/ttl —— keysOnly 只属于树的抓取
  const listCall = await cdp.eval('String(window.__calls[0] || "")')
  check('列表首屏不发 keysOnly（键列表两列还在用 type/ttl）',
    listCall.indexOf('"keysOnly":true') < 0, { listCall })

  // ── 2. 切到键树：真 SCAN ─────────────────────────────────────────
  await cdp.eval('window.__seg(1)')
  await waitFor(cdp, 'window.__nodeTitles().length > 0', 'real tree renders', 40000)
  const koCalls = JSON.parse(await cdp.eval('JSON.stringify(window.__calls)'))
  const treeCalls = koCalls.filter(c => c.indexOf('"keysOnly":true') > -1)
  const badCount = treeCalls.filter(c => c.indexOf('"pageSize":1000') < 0).length
  check('树抓取每发都带 keysOnly + COUNT 1000', treeCalls.length > 0 && badCount === 0,
    { treeCalls: treeCalls.length, badCount, first: treeCalls[0] })
  const st = JSON.parse(await cdp.eval('JSON.stringify(window.__status())'))
  // 树状态那个数是 SCAN 收满的唯一键名数；和 INFO keyspace 的库键数对得上，
  // 才说明真 SCAN 没漏页、去重也没把不同键当成重复吃掉
  check('SCAN 收满的键数 == 服务端 keyspace 计数',
    st.nums[0] === dbCount && !st.truncated, { st, dbCount })
  await shot('1-real-tree.png')

  // ── 3. 整棵树的键名 == 真库键名 ─────────────────────────────────
  await cdp.eval('window.__expandAll()')
  await sleep(500)
  const titles = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeTitles())'))
  const hit = listNames.filter(n => titles.indexOf(n) > -1)
  check('样本键名逐个都能在树里找到那一格（分层没丢键、去重没吃键）',
    hit.length === listNames.length, { hit: hit.length, names: listNames.length })
  const topTitles = JSON.parse(await cdp.eval('JSON.stringify(window.__titles())'))
  const prefixes = [...new Set(listNames.filter(n => n.includes(':')).map(n => n.split(':')[0]))]
  check('带 : 的键按前缀分层（顶层出现真前缀）',
    prefixes.length === 0 || topTitles.some(t => prefixes.includes(t)),
    { prefixes, topTitles: topTitles.slice(0, 8) })

  // ── 4. 改分隔符只重分层，不重扫 ─────────────────────────────────
  const beforeSep = await cdp.eval('window.__calls.length')
  const titlesBefore = JSON.parse(await cdp.eval('JSON.stringify(window.__titles())'))
  const setSep = await cdp.eval("window.__setSep('_')")
  await sleep(900)
  const titlesAfter = JSON.parse(await cdp.eval('JSON.stringify(window.__titles())'))
  const afterSep = await cdp.eval('window.__calls.length')
  check('改分隔符重分层（顶层集合变了）',
    setSep === 'ok' && JSON.stringify(titlesAfter) !== JSON.stringify(titlesBefore),
    { setSep, before: titlesBefore.slice(0, 6), after: titlesAfter.slice(0, 6) })
  check('改分隔符不重扫真库', afterSep === beforeSep, { beforeSep, afterSep })
  await shot('2-sep-underscore.png')
  await cdp.eval("window.__setSep(':')")
  await sleep(500)

  // ── 5. 视图来回切复用，不重发 SCAN ──────────────────────────────
  const beforeSwitch = await cdp.eval('window.__calls.length')
  await cdp.eval('window.__seg(0)')
  await waitFor(cdp, 'window.__keyNames().length > 0 && !window.__one(".db-redis-tree")', 'back to list', 20000)
  await cdp.eval('window.__seg(1)')
  await waitFor(cdp, 'window.__nodeTitles().length > 0', 'tree again', 20000)
  const afterSwitch = await cdp.eval('window.__calls.length')
  check('列表↔树来回切复用已抓键名', afterSwitch === beforeSwitch, { beforeSwitch, afterSwitch })

  // ── 6. 点叶子走真 getKeyDetail ──────────────────────────────────
  // 按完整键名点（span 的 title 属性），不靠段名：段名在不同前缀下会撞车
  const leaf = listNames.find(n => n.includes(':')) || listNames[0] || ''
  await cdp.eval('window.__expandAll()')
  await sleep(400)
  const clickLeaf = await cdp.eval('window.__clickKey(' + JSON.stringify(leaf) + ')')
  const detailOk = await waitFor(cdp,
    '(() => { const d = window.__detail(); return !!d && !d.empty && ' +
    'd.text.indexOf(' + JSON.stringify(leaf) + ') === 0 })()',
    'real detail loads', 20000)
  const detail = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
  check('点真叶子出该键的详情（真 TYPE/TTL/值）',
    clickLeaf === 'ok' && detailOk && !!detail && !detail.empty, { leaf, clickLeaf, detail })
  await shot('3-real-detail.png')

  await cdp.eval('window.__seg(0)')
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
