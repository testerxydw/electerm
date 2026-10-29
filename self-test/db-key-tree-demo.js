#!/usr/bin/env node
/**
 * H7a-3 Redis 键树（抓取 + 树/列表切换）—— CDP 实机演示/回归（无需真 Redis）
 *
 * 在渲染层 IPC 边界注入假键空间（见 STUB 的 SPACES），真实走 db-session 的键树视图，
 * 验证的是"抓取的形状"而不是 ioredis 本身（keysOnly 的后端语义在
 * src/test/unit-ci/db-redis-keys-jump.spec.js 里已锁）：
 *   1) 抓取每发都带 keysOnly + COUNT 1000；SCAN 重复回的键被去重（进度=真实唯一数）
 *   2) 大键库不自动摊开目录（antd Tree 非虚拟，摊开一个万键目录=一万个 DOM）
 *   3) 视图来回切复用已抓键名（不重扫）；过滤条件两视图共用
 *   4) 撞 REDIS_TREE_MAX_KEYS 停手并标 is-truncated，且不再多发 SCAN
 *   5) 取消 = 令牌作废：在途响应到达后不被采纳，call 数不再增长
 *   6) 分隔符改一下只重分层，不重扫
 *   7) 目录节点不可选（不触发 getKeyDetail）；列表选中的键切到树里那一支自动展开
 *   8) 计数用 --text-muted 变色、不用 opacity（U2c 对比度契约）；长名截断不外溢成横向滚动
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（见 README 式注释：self-test/redis-keys-jump-demo.js）
 *   3) node self-test/db-key-tree-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-key-tree-shots')

// 假键空间：page 大小固定 1000（= 前端每轮 SCAN 的 COUNT），游标 'c<p>'，末页回 '0'
const STUB = `
(() => {
  const PAGE = 1000
  const pad = n => String(n).padStart(6, '0')
  // 400 个字符才够撑满 1600 宽窗口下 ~1240px 的树容器（12px 等宽字 ≈ 7.2px/字）
  const LONG = 'x'.repeat(400)
  const SPACES = {}
  // '*'：3000 键 = app:{user|order|log|cache}:{1..749} + 4 个超长名（测省略号）
  const appKeys = []
  const mods = ['user', 'order', 'log', 'cache']
  for (let i = 1; i <= 749; i++) {
    for (const m of mods) appKeys.push('app:' + m + ':' + pad(i))
  }
  for (let i = 1; i <= 4; i++) appKeys.push(LONG + ':deep:' + i)
  SPACES['*'] = appKeys
  // 'big:*' / 'slow:*'：12000 键，全在同一个前缀目录下（最常见的"单前缀万键"形状）
  const mkPrefixed = pre => {
    const a = []
    for (let i = 1; i <= 12000; i++) {
      a.push(pre + ':' + pad(i))
    }
    return a
  }
  SPACES['big:*'] = mkPrefixed('big')
  SPACES['slow:*'] = mkPrefixed('slow')
  // 'small:*' / 'mix:*'：小键库（默认会摊开第一层）；叶子名互不重复，点谁都唯一
  SPACES['small:*'] = ['s:a:one', 's:a:two', 's:b:three']
  SPACES['mix:*'] = ['p:q:1', 'p:q:2', 'p:r:1', 'x-y-1', 'x-y-2', 'z']
  window.__space = p => SPACES[p] || SPACES['*']
  window.__spaceSize = p => window.__space(p).length
  window.__longName = LONG
  // SCAN 是"至少一次"：第 2 轮故意重复回第 1 轮的头 5 个键，前端去重后唯一数仍应是整份
  const pageRows = (names, p) => {
    const rows = names.slice(p * PAGE, (p + 1) * PAGE)
    if (p === 1) rows.unshift.apply(rows, names.slice(0, 5))
    return rows
  }
  const pages = names => Math.max(1, Math.ceil(names.length / PAGE))
  window.__calls = []
  window.__count = sub => window.__calls.filter(c => c.indexOf(sub) === 0).length
  window.__keysOnlyCalls = () => window.__calls
    .filter(c => c.indexOf('getPageData') === 0 && c.indexOf('"keysOnly":true') > -1)
  window.__badKeysOnly = () => window.__keysOnlyCalls()
    .filter(c => c.indexOf('"pageSize":1000') < 0).length
  // 列表视图的行要带 type/ttl（键列表那两列在用），keysOnly 只属于树的抓取
  window.__fullRowCalls = () => window.__calls
    .filter(c => c.indexOf('getPageData') === 0 && c.indexOf('keysOnly":true') < 0).length
  // slow:* 每轮延迟 —— 给"取消"留出可点的时间窗
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([
          { name: 'db0', type: 'database', count: window.__spaceSize(args.match || '*') }
        ])
      }
      if (op === 'getPageData') {
        const p = String(args.cursor || '0')
        const idx = p === '0' ? 0 : Number(p.replace(/^c/, ''))
        window.__calls.push('getPageData ' + JSON.stringify(args))
        const names = window.__space(args.match || '*')
        const last = idx + 1 >= pages(names)
        const rows = pageRows(names, idx).map(n => (args.keysOnly
          ? { name: n }
          : { name: n, type: 'string', ttl: -1 }))
        const res = { rows, nextCursor: last ? '0' : 'c' + (idx + 1), hasMore: !last }
        return args.delay || window.__delay
          ? new Promise(r => setTimeout(() => r(res), args.delay || window.__delay))
          : Promise.resolve(res)
      }
      if (op === 'getKeyDetail') {
        window.__calls.push('getKeyDetail ' + JSON.stringify(args))
        return Promise.resolve({ type: 'string', value: 'v-' + String(args.key || '').length, fields: [], ttl: -1 })
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(a[0] === 'list' ? [] : null)
    }
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
  window.__clickDb = name => {
    const el = [...document.querySelectorAll('.db-tree-db-name')]
      .filter(window.__vis)
      .find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  // 所有工具行探针一律先定位「当前可见的那一条 .db-redis-bar」再往里找：
  // 页面上可能同时存在多个数据库 tab（别的脚本没关干净），全局 querySelectorAll
  // 会把两个 tab 的控件混在一起（实测 Segmented 出现 4 个选项）
  window.__bar = () => window.__one('.db-redis-bar')
  window.__inBar = sel => {
    const b = window.__bar()
    return b ? [...b.querySelectorAll(sel)] : []
  }
  window.__segItems = () => window.__inBar('.ant-segmented-item')
  // 按序号点，别按文案（界面语言会变）
  window.__seg = i => {
    const it = window.__segItems()[i]
    if (!it) return 'missing'
    const inp = it.querySelector('input')
    ;(inp || it).click()
    return 'ok'
  }
  window.__segSelected = () => {
    const list = window.__segItems()
    const i = list.findIndex(x => x.className.indexOf('ant-segmented-item-selected') > -1)
    return i < 0 ? -1 : i
  }
  window.__segLabels = () => window.__segItems().map(x => x.innerText.trim())
  // match 输入：只负责改值；应用过滤走「过滤」按钮（工具行里第一个有文字的按钮）。
  // ⚠️ 不用回车：同一次 eval 里连续派发 input + keydown，Enter 命中的还是上一次渲染的
  // onChange 闭包，实测会时灵时不灵 —— 按钮点下去一定是新值
  window.__setMatch = v => {
    const wrap = window.__one('.db-redis-match')
    const input = wrap && (wrap.tagName === 'INPUT' ? wrap : wrap.querySelector('input'))
    if (!input) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  }
  window.__matchVal = () => {
    const wrap = window.__one('.db-redis-match')
    const input = wrap && (wrap.tagName === 'INPUT' ? wrap : wrap.querySelector('input'))
    return input ? input.value : null
  }
  window.__applyFilter = () => {
    const b = window.__busyButtons()[0]
    if (!b) return 'no-filter-btn'
    b.click()
    return 'ok'
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
    if (!el) return { text: '<no status>', nums: [], truncated: false, color: '' }
    return {
      text: el.innerText.trim(),
      nums: (el.innerText.match(/\\d+/g) || []).map(Number),
      truncated: el.className.indexOf('is-truncated') > -1,
      color: getComputedStyle(el).color
    }
  }
  window.__busyButtons = () => window.__inBar('button')
    .filter(b => window.__vis(b) && b.innerText.trim() !== '')
  // 扫描中工具行只有两个有文字的按钮：[0] 过滤、[1] 取消
  window.__clickCancel = () => {
    const b = window.__busyButtons()[1]
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  // rc-tree 会渲染一个只含 indent 的测量用 .ant-tree-treenode（没有标题格），必须剔掉
  window.__tree = () => window.__one('.db-redis-tree')
  window.__treeNodes = () => {
    const c = window.__tree()
    if (!c) return []
    return [...c.querySelectorAll('.ant-tree-treenode')]
      .filter(window.__vis)
      .filter(n => n.querySelector('.db-redis-tree-title'))
      .map(n => {
        const t = n.querySelector('.db-redis-tree-title')
        const cnt = n.querySelector('.db-redis-tree-count')
        const w = n.querySelector('.ant-tree-node-content-wrapper')
        return {
          title: t.innerText,
          count: cnt ? Number(cnt.innerText) : null,
          selected: !!(w && w.className.indexOf('ant-tree-node-selected') > -1),
          // 省略号：内容宽 > 可视宽；且父容器不该因此产生横向滚动
          over: t.scrollWidth > t.clientWidth + 1,
          tw: t.clientWidth,
          sw: t.scrollWidth,
          cColor: cnt ? getComputedStyle(cnt).color : '',
          cOpacity: cnt ? getComputedStyle(cnt).opacity : ''
        }
      })
  }
  window.__titles = () => window.__treeNodes().map(n => n.title)
  // token 变量在 getComputedStyle(--text-muted) 里拿到的是 color-mix(...) 原文，
  // 不能直接和元素的 computed color 比：用一个探针元素把同一个 token 解析成实际色值
  window.__mutedColor = () => {
    const d = document.createElement('span')
    d.style.color = 'var(--text-muted)'
    document.body.appendChild(d)
    const c = getComputedStyle(d).color
    d.remove()
    return c
  }
  window.__shortTitles = () => window.__titles().map(t => (t.length > 24 ? t.slice(0, 12) + '…(' + t.length + ')' : t))
  window.__nodeEl = title => {
    const c = window.__tree()
    if (!c) return null
    return [...c.querySelectorAll('.ant-tree-treenode')]
      .filter(window.__vis)
      .find(x => {
        const t = x.querySelector('.db-redis-tree-title')
        return t && t.innerText === title
      }) || null
  }
  window.__clickNode = title => {
    const n = window.__nodeEl(title)
    if (!n) return 'missing'
    const w = n.querySelector('.ant-tree-node-content-wrapper') || n
    w.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__clickSwitcher = title => {
    const n = window.__nodeEl(title)
    const s = n && n.querySelector('.ant-tree-switcher')
    if (!s) return 'missing'
    s.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__treeScrollOver = () => {
    const c = window.__one('.db-redis-tree')
    return c ? c.scrollWidth - c.clientWidth : -1
  }
  window.__keyRows = () => {
    const c = window.__one('.db-redis-keys')
    if (!c) return []
    return [...c.querySelectorAll('.ant-table-row')].map(r => r.innerText.trim().split(/\\s+/)[0])
  }
  window.__clickKeyRow = name => {
    const hit = window.__keyRows().indexOf(name)
    if (hit < 0) return 'missing'
    const row = [...window.__one('.db-redis-keys').querySelectorAll('.ant-table-row')][hit]
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__detail = () => {
    const el = window.__one('.db-redis-detail')
    if (!el) return null
    return { empty: el.className.indexOf('db-redis-detail-empty') > -1, text: el.innerText.slice(0, 60) }
  }
  return 'stub-installed'
})()
`

const OPEN_TAB = `
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

// 换过滤条件 → 点「过滤」→ 确认这次真的把请求发出去了。
// 后面每一步都靠它切键空间；不确认"发出去了"，一次没生效的 setMatch 会让整串断言
// 在旧数据上跑绿（踩过：Enter 闭包不生效时 6/7/8 三步全在 big:* 上打转）。
const filterTo = async (cdp, pattern) => {
  const before = await cdp.eval('window.__calls.length')
  const set = await cdp.eval('window.__setMatch(' + JSON.stringify(pattern) + ')')
  const clicked = await cdp.eval('window.__applyFilter()')
  const landed = await waitFor(cdp, 'window.__calls.length > ' + before, 'filter ' + pattern + ' 发请求', 8000)
  return { pattern, set, clicked, landed }
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  await cdp.eval(STUB)
  // 先清场：上一次跑挂/别的脚本留下的数据库 tab 会让 .db-redis-bar 出现多个，
  // 探针就会点到别的 tab（实测把整轮判据全带偏）
  await clearDbTabs(cdp)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(openRes.id), 'tab active')
  await waitFor(cdp, "document.querySelectorAll('.db-tree-db-name').length > 0", 'tree loaded')
  await cdp.eval("window.__clickDb('db0')")
  await waitFor(cdp, 'window.__keyRows().length >= 10', 'list first page')

  // ── 1. 视图切换器 ──────────────────────────────────────────────────
  const labels = JSON.parse(await cdp.eval('JSON.stringify(window.__segLabels())'))
  const selDefault = await cdp.eval('window.__segSelected()')
  // 文案必须过了 i18n（未翻译时 e('dbRedisViewList') 原样落回 key 名）
  check('视图切换器两项、默认列表、文案已本地化',
    labels.length === 2 && selDefault === 0 && labels.every(t => t && !/^db[A-Z]/.test(t)), { labels, selDefault })

  // ── 2. 切到键树：抓取形状 ────────────────────────────────────────
  await cdp.eval('window.__seg(1)')
  await waitFor(cdp, 'window.__treeNodes().length >= 2', 'tree rendered')
  await waitFor(cdp, 'window.__status() && window.__status().nums[0] === 3000', 'status 3000')
  const koCalls = await cdp.eval('window.__keysOnlyCalls().length')
  const badKo = await cdp.eval('window.__badKeysOnly()')
  const firstCall = await cdp.eval('window.__keysOnlyCalls()[0]')
  check('抓取每发都带 keysOnly + COUNT 1000', koCalls === 3 && badKo === 0, { koCalls, badKo, firstCall })
  const st = JSON.parse(await cdp.eval('JSON.stringify(window.__status())'))
  // 假 Redis 第 2 轮重复回了 5 个键（SCAN 至少一次语义）：界面必须显示去重后的 3000
  check('SCAN 重复键去重后进度为真实唯一数 3000', st.nums[0] === 3000 && !st.truncated, st)
  check('列表视图仍拿完整行（keysOnly 只给树用）',
    (await cdp.eval('window.__fullRowCalls()')) >= 1)

  const titles = JSON.parse(await cdp.eval('JSON.stringify(window.__shortTitles())'))
  const nodes = JSON.parse(await cdp.eval('JSON.stringify(window.__treeNodes())'))
  // 3000 键 > REDIS_TREE_AUTO_EXPAND_KEYS：一个目录都不自动摊（antd Tree 非虚拟）
  check('大键库默认不摊开目录（只顶层两项）', titles.length === 2 && titles[0] === 'app', { titles })
  check('目录计数 = 其下键数', nodes[0].count === 2996, nodes[0])
  await shot('1-tree-3000.png')

  // ── 3. 视图来回切：复用，不重扫 ─────────────────────────────────
  await cdp.eval('window.__seg(0)')
  await waitFor(cdp, 'window.__keyRows().length >= 10 && !window.__one(".db-redis-tree")', 'back to list')
  const listOk = await cdp.eval('!!window.__one(".db-redis-keys")')
  await cdp.eval('window.__seg(1)')
  await waitFor(cdp, 'window.__treeNodes().length >= 2', 'tree again')
  const koAfter = await cdp.eval('window.__keysOnlyCalls().length')
  check('切回列表出网格、再切回键树不重扫', listOk && koAfter === koCalls, { listOk, koBefore: koCalls, koAfter })

  // ── 4. 长名截断 + 计数配色（U2c 契约）────────────────────────────
  const nodesNow = JSON.parse(await cdp.eval('JSON.stringify(window.__treeNodes())'))
  const LONG = await cdp.eval('window.__longName')
  const longNode = nodesNow.find(n => n.title === LONG)
  const overFlow = await cdp.eval('window.__treeScrollOver()')
  check('超长目录名走省略号，不把树撑出横向滚动',
    !!longNode && longNode.over && overFlow <= 1,
    { longFound: !!longNode, tw: longNode && longNode.tw, sw: longNode && longNode.sw, overFlow })
  const muted = await cdp.eval('window.__mutedColor()')
  const countStyle = nodesNow.map(n => ({ c: n.cColor, o: n.cOpacity }))
  check('计数用 --text-muted 变色且不用 opacity 压暗',
    countStyle.length > 0 && countStyle.every(x => x.c === muted && x.o === '1'),
    { muted, sample: countStyle[0] })

  // ── 5. 截断：撞上限就停手 ───────────────────────────────────────
  const f5 = await filterTo(cdp, 'big:*')
  await waitFor(cdp, 'window.__status() && window.__status().truncated', 'truncated status', 20000)
  const bst = JSON.parse(await cdp.eval('JSON.stringify(window.__status())'))
  const koBig = await cdp.eval('window.__keysOnlyCalls().length')
  await sleep(600)
  const koBig2 = await cdp.eval('window.__keysOnlyCalls().length')
  // 12000 键的键库：只能收满 10000（10 轮）就停，且停手后不再多发
  check('撞 1 万上限即停手并标 is-truncated',
    bst.truncated && bst.nums[0] === 10000 && bst.nums.length === 2, { f5, bst })
  check('截断后不再继续 SCAN（10 轮封盘）', koBig === koBig2 && koBig > 3, { koBig, koBig2 })
  await shot('2-truncated.png')

  // ── 6. 取消：令牌作废在途响应 ────────────────────────────────────
  await cdp.eval('window.__delay = 250')
  const f6 = await filterTo(cdp, 'slow:*')
  await waitFor(cdp, 'window.__busyButtons().length === 2', 'cancel button shown')
  const busyCount = await cdp.eval('window.__busyButtons().length')
  await waitFor(cdp, 'window.__keysOnlyCalls().length > 0', 'some rounds landed')
  const before = await cdp.eval('window.__keysOnlyCalls().length')
  check('扫描中出现取消按钮（工具行两个文字按钮）', busyCount === 2, { f6, busyCount })
  await cdp.eval('window.__clickCancel()')
  await waitFor(cdp, 'window.__busyButtons().length === 1', 'cancel gone')
  await sleep(900)
  const after = await cdp.eval('window.__keysOnlyCalls().length')
  const stCancel = JSON.parse(await cdp.eval('JSON.stringify(window.__status())'))
  // 取消后最多只可能再落地 1 发在途请求；采纳它就必须继续下一轮 —— 数量不再增长证明已丢弃
  check('取消后在途响应被丢弃、不再续扫', after - before <= 1 && stCancel.nums.length >= 1, { before, after, stCancel })
  await cdp.eval('window.__delay = 0')

  // ── 7. 分隔符：只重分层，不重扫 ─────────────────────────────────
  await filterTo(cdp, 'mix:*')
  await waitFor(cdp, "window.__titles().indexOf('p') >= 0", 'mix tree')
  const tColon = JSON.parse(await cdp.eval('JSON.stringify(window.__shortTitles())'))
  const koSep = await cdp.eval('window.__keysOnlyCalls().length')
  await cdp.eval("window.__setSep('-')")
  await waitFor(cdp, "window.__titles().indexOf('x') >= 0", 'dash tree')
  const tDash = JSON.parse(await cdp.eval('JSON.stringify(window.__shortTitles())'))
  const koSep2 = await cdp.eval('window.__keysOnlyCalls().length')
  check('改分隔符重分层（顶层集合变了）',
    JSON.stringify(tColon) !== JSON.stringify(tDash) && tColon.indexOf('p') > -1 && tDash.indexOf('x') > -1,
    { tColon, tDash })
  check('改分隔符不重扫键名', koSep2 === koSep, { koSep, koSep2 })
  await shot('3-separator.png')

  // ── 8. 选中：列表→树、目录不可选、树→列表保留详情 ───────────────
  await cdp.eval("window.__setSep(':')")
  await filterTo(cdp, 'small:*')
  await waitFor(cdp, "window.__titles().indexOf('s') >= 0", 'small tree')
  // 小键库（3 键）默认摊开第一层
  const st2 = JSON.parse(await cdp.eval('JSON.stringify(window.__treeNodes())'))
  check('小键库默认摊开第一层目录', st2.some(n => n.title === 'a') && st2.some(n => n.title === 'b'), st2.map(n => n.title))

  // 列表里选中 s:b:three → 切到树，那一支必须自动展开且高亮（ancestorKeys 接线）
  await cdp.eval('window.__seg(0)')
  await waitFor(cdp, "window.__keyRows().indexOf('s:b:three') >= 0", 'small list rows')
  const clickRow = await cdp.eval("window.__clickKeyRow('s:b:three')")
  await waitFor(cdp, "window.__calls.some(c => c.indexOf('getKeyDetail') === 0 && c.indexOf('s:b:three') > -1)", 'detail loaded')
  await cdp.eval('window.__seg(1)')
  await waitFor(cdp, "window.__treeNodes().some(n => n.selected && n.title === 'three')", 'tree highlights key')
  const selNodes = JSON.parse(await cdp.eval('JSON.stringify(window.__treeNodes())'))
  check('列表选中的键切进树里自动展开那一支并高亮',
    clickRow === 'ok' && selNodes.some(n => n.selected && n.title === 'three'),
    selNodes.map(n => [n.title, n.selected]))

  // 纯目录不可选：点标题不加载详情，只有展开箭头有用
  const kdBefore = await cdp.eval("window.__calls.filter(c => c.indexOf('getKeyDetail') === 0).length")
  const clickFolder = await cdp.eval("window.__clickNode('a')")
  await sleep(400)
  const kdAfter = await cdp.eval("window.__calls.filter(c => c.indexOf('getKeyDetail') === 0).length")
  check('点纯目录不触发 getKeyDetail（目录不可选）',
    clickFolder === 'ok' && kdAfter === kdBefore, { clickFolder, kdBefore, kdAfter })
  const nBefore = await cdp.eval('window.__treeNodes().length')
  await cdp.eval("window.__clickSwitcher('a')")
  await waitFor(cdp, 'window.__treeNodes().length !== ' + nBefore, 'switcher toggles')
  const nAfter = await cdp.eval('window.__treeNodes().length')
  check('展开箭头可收/放（子节点数变化）', nAfter !== nBefore, { nBefore, nAfter })

  // 树里点叶子 → 详情；切回列表 → 详情不丢
  await cdp.eval("window.__clickNode('one')")
  await waitFor(cdp, "window.__calls.some(c => c.indexOf('getKeyDetail') === 0 && c.indexOf('s:a:one') > -1)", 'leaf detail')
  const detailTree = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
  await cdp.eval('window.__seg(0)')
  await sleep(400)
  const detailList = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
  check('树里点叶子加载详情，切回列表详情不丢',
    !!detailTree && !detailTree.empty && !!detailList && !detailList.empty, { detailTree, detailList })
  await shot('4-selection.png')

  // 清理：关掉本次开的数据库 tab，别把假连接留给下一次跑
  await cdp.eval('window.__delay = 0')
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
