#!/usr/bin/env node
/**
 * N11b Redis 面板 —— CDP 实机全链路冒烟（真 Electron + 真 ioredis + 假 RESP2 服务端）
 *
 * 为什么必须有这一条：`fd7e6ed6` 把 use-db-redis-keys 的形参从 32 个收成 5 个
 * （`browse` 对象体内解构 28 项）。这类改动 compile 必过、单测也必过 ——
 * 漏一个字段的表现是运行时 undefined（`rowSelection` 没勾选框、`keyJumpInput`
 * 没值、`switchRedisView` 点不动），只有真的把面板点一遍才看得见。
 *
 * 环境：本机没有 redis-server / docker。self-test/fake-redis.js 起一个 RESP2
 * 服务端，让**真的 ioredis** 连上来 —— 验的仍是客户端代码路径（正是被改的那半），
 * 只是把 Redis 换成了可控替身。夹具每次重建，命令与写操作可在同进程对账。
 *
 * 用法：
 *   1) npm run compile（改了 src 才需要）
 *   2) mkdir -p /tmp/electerm-redis/{home,tmp}
 *      # 本机 Xorg 上 GPU 进程会 exit_code=1002（"GPU process isn't usable"）。
 *      # 起一个 Xvfb + 强制软件渲染可稳定跑：
 *      Xvfb :99 -screen 0 1600x1000x24 &
 *      env -u ELECTRON_RUN_AS_NODE DISPLAY=:99 \
 *        HOME=/tmp/electerm-redis/home TMPDIR=/tmp/electerm-redis/tmp \
 *        DISABLE_GPU=1 DISABLE_GPU_SANDBOX=1 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9386 --no-sandbox --disable-gpu-sandbox \
 *        --in-process-gpu --window-size=1600,1000
 *      # 必须用后台任务/受控方式启动：直接 `&` 起的进程会随起它的 shell 一起被杀
 *   3) node self-test/n11b-redis-smoke.js [cdpPort] [shotDir] [redisPort]
 *   4) pkill -f "remote-debugging-port=9386"
 *
 * 夹具（fake-redis.js）：
 *   db0 = 60 × smoke:key:000..059（string，005/006 带 TTL）
 *       + smoke:a:hash / list / set / zset 各一份 → 共 64 键（4 页 × 20）
 *   db1..15 为空（验 SELECT 切库）
 */
const fs = require('node:fs')
const path = require('node:path')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs, preStubState
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9386'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'n11b-redis-shots')
const REDIS_PORT = Number(process.argv[4]) || 6390
const TITLE = `redis 127.0.0.1:${REDIS_PORT}`
const J = s => JSON.stringify(s)

// 页内探针：只做「找 / 点 / 读」，判据留在 Node 侧。
// 注意 antd 虚拟表格行是 .ant-table-row（不在 tbody > tr 里）；
// 弹层淡入期间 opacity < 0.05，所以结构判定一律走原始 querySelector。
const PROBE = `(() => {
  window.__txt = el => (el && el.innerText ? el.innerText : '').trim()
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
  }
  window.__all = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__q = sel => document.querySelectorAll(sel).length
  window.__txtOf = sel => window.__all(sel).map(window.__txt).join(' | ')
  window.__head = () => window.__txt(document.querySelector('.db-head-target'))
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }

  // ---- 键列表 ----
  window.__redisRows = () => [...document.querySelectorAll('.db-redis-keys .ant-table-row')]
  window.__redisRowCount = () => window.__redisRows().length
  // 第一列是勾选框，键名在第二列
  window.__redisKeys = () => window.__redisRows().map(tr =>
    window.__txt(tr.children[1] || tr.children[0]))
  window.__keyRow = name => window.__redisRows().find(tr =>
    window.__txt(tr.children[1] || tr.children[0]) === name) || null
  window.__clickKey = name => {
    const tr = window.__keyRow(name)
    if (!tr) return 'no-row:' + name
    tr.click()
    return 'ok'
  }
  window.__checkKey = name => {
    const tr = window.__keyRow(name)
    if (!tr) return 'no-row:' + name
    const cb = tr.querySelector('.ant-checkbox-input')
    if (!cb) return 'no-checkbox'
    cb.click()
    return 'ok'
  }
  window.__selChip = () => window.__txt(document.querySelector('.db-redis-sel-chip'))
  window.__clickBatchDel = () => {
    const b = [...document.querySelectorAll('.db-redis-bar button')]
      .find(x => x.className.indexOf('ant-btn-dangerous') >= 0)
    if (!b) return 'no-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__delModalOpen = () => {
    const el = document.querySelector('.db-redis-del-modal')
    if (!el) return false
    const wrap = el.closest('.ant-modal-wrap') || el
    return getComputedStyle(wrap).display !== 'none'
  }
  window.__delModalKeys = () => [...document.querySelectorAll('.db-redis-del-modal .db-redis-del-key')]
    .map(window.__txt)
  window.__confirmDel = () => {
    const btns = [...document.querySelectorAll('.db-redis-del-modal .ant-modal-footer button')]
    if (!btns.length) return 'no-footer'
    const b = btns[btns.length - 1]
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }

  // ---- 分页 / 视图 / 过滤 ----
  window.__pageText = () => window.__txt(document.querySelector('.db-redis-bar .db-grid-page-no'))
  window.__pageNums = () => (window.__pageText().match(/\\d+/g) || []).map(Number)
  window.__pagerBtns = () => [...document.querySelectorAll('.db-redis-bar .db-grid-pager > button')]
  window.__nextPage = () => {
    const bs = window.__pagerBtns()
    if (!bs[1]) return 'no-next'
    if (bs[1].disabled) return 'disabled'
    bs[1].click()
    return 'ok'
  }
  window.__prevPage = () => {
    const bs = window.__pagerBtns()
    if (!bs[0]) return 'no-prev'
    if (bs[0].disabled) return 'disabled'
    bs[0].click()
    return 'ok'
  }
  window.__nextDisabled = () => {
    const bs = window.__pagerBtns()
    return bs[1] ? String(!!bs[1].disabled) : 'no-next'
  }
  window.__fill = (sel, val) => {
    let el = document.querySelector(sel)
    if (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el = el.querySelector('input, textarea')
    }
    if (!el) return 'no-input:' + sel
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(val))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  // Redis 的跳页是文本草稿 + Go（numeric:false），必须等一拍让草稿落进 state
  window.__jump = async n => {
    const r = window.__fill('.db-redis-bar .db-grid-jump', n)
    if (r !== 'ok') return r
    await new Promise(resolve => setTimeout(resolve, 220))
    const box = document.querySelector('.db-redis-bar .db-grid-pager')
    if (!box) return 'no-pager'
    const bs = [...box.querySelectorAll('button')]
    const go = bs[bs.length - 1]
    if (!go) return 'no-go'
    if (go.disabled) return 'go-disabled'
    go.click()
    return 'ok'
  }
  window.__seg = n => {
    const items = [...document.querySelectorAll('.db-redis-bar .ant-segmented-item')]
    if (!items[n]) return 'no-seg:' + n + '/' + items.length
    items[n].click()
    return 'ok'
  }
  window.__filter = async p => {
    const r = window.__fill('.db-redis-match', p)
    if (r !== 'ok') return r
    await new Promise(resolve => setTimeout(resolve, 180))
    // antd 的 autoInsertSpace 会把两个中文字拆成「过 滤」，匹配前必须去空白
    const btn = [...document.querySelectorAll('.db-redis-bar button')]
      .find(b => /filter|过滤|筛选/i.test(window.__txt(b).replace(/\\s/g, '')))
    if (!btn) return 'no-filter-btn'
    btn.click()
    return 'ok'
  }
  window.__treeNodes = () => window.__q('.db-redis-tree .ant-tree-treenode')
  window.__treeStatus = () => window.__txt(document.querySelector('.db-redis-tree-status'))
  window.__treeText = () => window.__txt(document.querySelector('.db-redis-tree'))
  // 左侧元数据树里 db0 的键计数（INFO keyspace 的渲染值）
  window.__treeDbCount = name => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-treenode')]
    const hit = nodes.find(el => {
      const t = el.querySelector('.db-tree-name')
      return t && window.__txt(t) === name
    })
    const c = hit && hit.querySelector('.db-tree-db-count')
    return c ? window.__txt(c) : ''
  }
  window.__listLoading = () => window.__q('.db-redis-keys .ant-spin-spinning')

  // ---- 详情 ----
  window.__pane = () => document.querySelector('.db-split-pane-bottom .db-value-pane')
  window.__detail = () => {
    const pane = window.__pane()
    const bar = document.querySelector('.db-redis-detail .db-redis-detail-bar')
    return {
      hasDetail: !!document.querySelector('.db-redis-detail'),
      barKey: window.__txt(document.querySelector('.db-redis-detail .db-redis-key-name')),
      rows: window.__q('.db-redis-detail .ant-table-row'),
      text: window.__txt(document.querySelector('.db-redis-detail')).slice(0, 200),
      paneTitle: window.__txt(pane && pane.querySelector('.db-grid-title')),
      paneText: String((pane && pane.querySelector('.db-value-pre') || {}).textContent || '').slice(0, 200),
      ttlChip: window.__txt(pane && pane.querySelector('.db-redis-ttl-chip'))
    }
  }
  window.__setTtl = async n => {
    const pane = window.__pane()
    if (!pane) return 'no-pane'
    const r = window.__fill('.db-split-pane-bottom .db-value-pane .ant-input-number input', n)
    if (r !== 'ok') return r
    await new Promise(resolve => setTimeout(resolve, 160))
    const btn = [...pane.querySelectorAll('.db-value-pane-head button')]
      .find(b => /ttl/i.test(window.__txt(b)) || /ttl/i.test(b.getAttribute('title') || ''))
    if (!btn) return 'no-ttl-btn'
    if (btn.disabled) return 'ttl-disabled'
    btn.click()
    return 'ok'
  }
  window.__readonlyState = () => {
    const sw = document.querySelector('.db-head .ant-switch')
    return sw ? String(sw.getAttribute('aria-checked')) : 'no-switch'
  }
  window.__toggleReadonly = () => {
    const sw = document.querySelector('.db-head .ant-switch')
    if (!sw) return 'no-switch'
    sw.click()
    return 'ok'
  }

  // ---- INFO / 慢日志弹层 ----
  window.__openInfo = () => {
    const btn = [...document.querySelectorAll('.db-head button')]
      .find(b => b.querySelector('.anticon-info-circle'))
    if (!btn) return 'no-info-btn'
    btn.click()
    return 'ok'
  }
  window.__modalOpen = sel => {
    const el = document.querySelector(sel)
    if (!el) return false
    const wrap = el.closest('.ant-modal-wrap') || el
    return getComputedStyle(wrap).display !== 'none'
  }
  window.__infoTabs = () => [...document.querySelectorAll('.db-redis-info .ant-tabs-tab')].map(window.__txt)
  window.__clickInfoTab = n => {
    const tabs = [...document.querySelectorAll('.db-redis-info .ant-tabs-tab')]
    if (!tabs[n]) return 'no-tab:' + n + '/' + tabs.length
    tabs[n].click()
    return 'ok'
  }
  window.__infoText = () => window.__txt(document.querySelector('.db-redis-info'))
  window.__slowlogRows = () => window.__q('.db-redis-slowlog .ant-table-row')
  window.__slowlogStatus = () => window.__txt(document.querySelector('.db-redis-slowlog-status'))
  window.__closeInfo = () => {
    const box = document.querySelector('.db-redis-info')
    const modal = box && box.closest('.ant-modal')
    const btn = modal && modal.querySelector('.ant-modal-close')
    if (!btn) return 'no-close'
    btn.click()
    return 'ok'
  }
})()`

// 期望：4 个类型键排在最前（s < key），第一页 = 4 typed + 16 smoke:key:000..015
const TYPE_KEYS = ['smoke:a:hash', 'smoke:a:list', 'smoke:a:set', 'smoke:a:zset']
const FIXTURE_TOTAL = 64
const PAGE_SIZE = 20
// 分区 85% 时可视区能挂 19 行左右；这是「虚拟滚动渲染了几行」的下界，不参与页大小判定
const MIN_VISIBLE = 15

async function main () {
  const { check, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const srv = await startFakeRedis(REDIS_PORT)
  let tabId = ''
  let cdp = null

  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    const page = findPageTarget(targets)
    if (!page) throw new Error('找不到渲染进程页签，先把实例起起来（见文件头用法）')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Log.enable')
    await cdp.call('Page.bringToFront', {})
    const shot = f => cdp.shot(path.join(SHOT_DIR, f))

    check('渲染进程可用（store / pre / translate 都在）',
      await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))

    await cdp.eval(buildHelpers('electerm-n11b-redis-smoke'))
    await cdp.eval(PROBE)
    check('页内探针装好',
      await cdp.eval('!!(window.__clickKey && window.__jump && window.__openInfo && window.__toggleReadonly)'))
    // 页大小固定 20：默认值受 store 配置影响（本机是 50），夹具 64 键必须落在 4 页，
    // 「末页不满页」才验得到。配置在挂载前写入，getDbPageSize() 取数时读到的就是它
    await cdp.eval('window.store.setConfig({ dbPageSize: 20 })')
    check('前置：页大小固定为 20（夹具 64 键 = 4 页）',
      await cdp.eval('window.store._config.dbPageSize') === 20,
      await cdp.eval('window.store._config.dbPageSize'))
    // 键列表的顶部分区拉高到 85%：20 行全部落在可视区，判据读的是「这一页有几条」
    // 而不是「虚拟滚动这一帧渲染了几条」（后者会让 20/18/4 这些数字变成环境噪声）
    await cdp.eval("window.localStorage.setItem('electerm-db-redis-split', '85')")

    const stub = await preStubState(cdp)
    check('桥接层是原装的（没被别的 demo 的桩覆盖）',
      String(stub) === 'ok' || String(stub).indexOf('native') >= 0, stub)

    // 幂等起点：清掉残留数据库页签（主进程按连接签名复用句柄）
    const cleared = await clearDbTabs(cdp)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__dismiss()') !== 'closed') break
      await sleep(200)
    }

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
    const connected = await waitFor(cdp,
      `!!(window.__head() && window.__head().indexOf(${J(String(REDIS_PORT))}) >= 0)`,
      'Redis 会话头部等不到连接目标', 25000)
    check('加页签即建连（头部显示 127.0.0.1:' + REDIS_PORT + '）', connected,
      { head: await cdp.eval('window.__head()'), cleared: cleared.closed.length })
    if (!connected) {
      await printDiag(cdp, srv)
      check('后续判据依赖建连，提前中止', false, cdp.tail(8))
      return finish()
    }

    // 主进程侧 acquire() 的 PING 与 readyCheck 的 INFO 都已发生
    const cmdsAfterConnect = srv.stats().commands.map(c => c.cmd)
    check('主进程用真 ioredis 完成握手（PING + INFO 已到达服务端）',
      cmdsAfterConnect.includes('PING') && cmdsAfterConnect.includes('INFO'),
      { unique: [...new Set(cmdsAfterConnect)] })

    // ---- 选 db0：树节点点击 → SCAN 首页 ----
    const treeHasDb0 = await waitFor(cdp, 'window.__hasTree && window.__hasTree("db0")',
      '树里等不到 db0', 20000)
    check('元数据树出 16 个 db 节点（getMetadata → INFO keyspace）',
      treeHasDb0 && await cdp.eval('window.__q(".db-tree .ant-tree-treenode")') >= 16,
      await cdp.eval('window.__q(".db-tree .ant-tree-treenode")'))

    const pick = await cdp.eval('window.__clickTree("db0")')
    // 虚拟表格只挂可视区的行（本机 19 行），所以「一页 20 条」不能读 DOM 行数：
    // 从服务端收到的 SCAN 入参/返回条数判定，DOM 只验「确有内容且不是全量」
    const firstPage = await waitFor(cdp,
      `window.__redisRowCount() >= ${MIN_VISIBLE} && window.__pageNums()[0] === 1 && window.__listLoading() === 0`,
      'db0 键列表首页没出内容', 20000)
    await sleep(400)
    const keys1 = await cdp.eval('window.__redisKeys()')
    const scans1 = srv.stats().scanCalls.filter(c => c.count === PAGE_SIZE)
    check('① 键列表出数且是分页第一页（服务端 SCAN 一页 20 条，远小于夹具 64 键）',
      firstPage && pick === 'ok' && keys1.length > 0 && keys1.length < FIXTURE_TOTAL &&
        keys1.includes(TYPE_KEYS[0]) && scans1.some(c => c.n === PAGE_SIZE),
      { pick, domRows: await cdp.eval('window.__redisRowCount()'), names: keys1.slice(0, 5), page: await cdp.eval('window.__pageText()'), scan: scans1[0] })
    check('① 页码按 INFO 键数换算（第 1 / 4 页）',
      JSON.stringify(await cdp.eval('window.__pageNums()')) === JSON.stringify([1, 4]),
      await cdp.eval('window.__pageText()'))
    await shot('01-list-page1.png')

    // ---- 判据 2：顺序翻页 + 跳页 ----
    const nextRet = await cdp.eval('window.__nextPage()')
    const page2 = await waitFor(cdp,
      `window.__redisRowCount() >= ${MIN_VISIBLE} && window.__pageNums()[0] === 2 && window.__listLoading() === 0`,
      '下一页没落到第 2 页', 15000)
    const keys2 = await cdp.eval('window.__redisKeys()')
    const overlap = keys2.filter(k => keys1.includes(k))
    check('② 下一页：页码变 2、键名集合变化（无重叠）',
      page2 && nextRet === 'ok' && overlap.length === 0 && keys2[0] !== keys1[0],
      { nextRet, page: await cdp.eval('window.__pageText()'), first2: keys2.slice(0, 3), overlap: overlap.length })

    // 直接跳到最后一页（64 / 20 → 4 页，末页 4 条）
    const jump4 = await cdp.eval('window.__jump(4)')
    const lastPage = await waitFor(cdp,
      'window.__pageNums()[0] === 4 && window.__redisRowCount() === 4 && window.__listLoading() === 0',
      '跳页没落到末页', 20000)
    const lastKeys = await cdp.eval('window.__redisKeys()')
    check('② 跳到最后页：末页 4 行（不满页不越界）、下一页禁用',
      lastPage && jump4 === 'ok' && lastKeys.length === 4 &&
        await cdp.eval('window.__nextDisabled()') === 'true',
      { jump4, rows: lastKeys.length, names: lastKeys, next: await cdp.eval('window.__nextDisabled()'), page: await cdp.eval('window.__pageText()') })
    await shot('02-list-lastpage.png')

    // 跳到远大于末页的页码：后端夹到真实末页（不是空表）
    const jump99 = await cdp.eval('window.__jump(99)')
    const clamped = await waitFor(cdp,
      'window.__pageNums()[0] === 4 && window.__redisRowCount() === 4 && window.__listLoading() === 0',
      '超界跳页没有夹到末页', 20000)
    check('② 超界跳页夹到末页（仍 4 行、页码 4）', clamped && jump99 === 'ok',
      { jump99, rows: await cdp.eval('window.__redisRowCount()'), page: await cdp.eval('window.__pageText()') })

    // 回第 1 页给后续判据一个确定起点
    await cdp.eval('window.__jump(1)')
    await waitFor(cdp, `window.__pageNums()[0] === 1 && window.__redisRowCount() >= ${MIN_VISIBLE} && window.__listLoading() === 0`,
      '回第 1 页失败', 20000)

    // ---- 判据 3：树视图切换 ----
    const segTree = await cdp.eval('window.__seg(1)')
    const treeOk = await waitFor(cdp,
      'window.__treeNodes() >= 3 && window.__treeStatus().indexOf("64") >= 0 && window.__treeText().indexOf("smoke") >= 0',
      '键树没渲染出 64 键', 20000)
    check('③ 切到树视图：全量抓取 64 键并按 : 分层（switchRedisView 接线完好）',
      treeOk && segTree === 'ok',
      { segTree, nodes: await cdp.eval('window.__treeNodes()'), status: await cdp.eval('window.__treeStatus()'), sample: await cdp.eval('window.__treeText()').then(s => String(s).slice(0, 120)) })
    await shot('03-tree-view.png')
    const segList = await cdp.eval('window.__seg(0)')
    const backList = await waitFor(cdp,
      `window.__redisRowCount() >= ${MIN_VISIBLE} && window.__pageNums()[0] === 1`,
      '切回平铺视图没恢复列表', 15000)
    check('③ 切回平铺视图：列表恢复 20 行', backList && segList === 'ok', segList)

    // ---- 判据 4：过滤 ----
    const filterRet = await cdp.eval('window.__filter(\'smoke:key:00*\')')
    const filtered = await waitFor(cdp,
      'window.__redisRowCount() === 10 && window.__listLoading() === 0',
      '过滤后没收到 10 行', 15000)
    const fKeys = await cdp.eval('window.__redisKeys()')
    const fPage = await cdp.eval('window.__pageText()')
    const fNums = await cdp.eval('window.__pageNums()')
    check('④ 过滤 smoke:key:00* 收窄到 10 行，键名全部命中',
      filtered && filterRet === 'ok' && fKeys.length === 10 && fKeys.every(k => k.indexOf('smoke:key:00') === 0),
      { filterRet, names: fKeys })
    // 带 pattern 时没有可信总数：文案从「第 1 / 4 页」退化成「第 1 页」
    check('④ 过滤后计数文案跟着变（不再显示估算总页数）',
      fNums.length === 1 && fPage !== '第 1 / 4 页',
      { page: fPage, nums: fNums })
    await shot('04-filter.png')

    const resetRet = await cdp.eval('window.__filter(\'\')')
    const reset = await waitFor(cdp,
      `window.__redisRowCount() >= ${MIN_VISIBLE} && window.__pageNums().length === 2 && window.__listLoading() === 0`,
      '清空过滤没恢复', 15000)
    check('④ 清空过滤恢复 20 行 + 总页数文案', reset && resetRet === 'ok',
      { page: await cdp.eval('window.__pageText()') })

    // ---- 附加：SELECT 切库（db1 空 → 回 db0） ----
    await cdp.eval('window.__clickTree("db1")')
    const db1 = await waitFor(cdp, 'window.__redisRowCount() === 0', 'db1 没切成空列表', 15000)
    check('附加 SELECT：切 db1 后键列表为空（真的换了库，不是缓存）',
      db1 && srv.count(1) === 0, { rows: await cdp.eval('window.__redisRowCount()') })
    await cdp.eval('window.__clickTree("db0")')
    const back0 = await waitFor(cdp,
      `window.__redisRowCount() >= ${MIN_VISIBLE} && window.__pageNums()[0] === 1`,
      '切回 db0 没恢复', 15000)
    check('附加 SELECT：切回 db0 列表恢复 20 行', back0, await cdp.eval('window.__pageText()'))

    // ---- 判据 5：选中键 → 详情面板 ----
    const clickStr = await cdp.eval('window.__clickKey(\'smoke:key:000\')')
    const strDetail = await waitFor(cdp,
      'window.__detail().paneTitle === \'smoke:key:000\' && window.__detail().paneText.indexOf(\'value:000\') >= 0',
      'string 键详情没出值', 15000)
    check('⑤ 选中 string 键：详情面板出键名与原值（selectRedisKey → GET）',
      strDetail && clickStr === 'ok', await cdp.eval('window.__detail()'))

    // 四种复合类型的详情各点一次：GET/LRANGE/SSCAN/HSCAN/ZRANGE 五条客户端路径
    const typeCases = [
      ['smoke:a:list', 'l1', 'LRANGE'],
      ['smoke:a:hash', 'f1', 'HSCAN'],
      ['smoke:a:set', 'm1', 'SSCAN'],
      ['smoke:a:zset', 'm1', 'ZRANGE']
    ]
    for (const [key, needle, cmd] of typeCases) {
      await cdp.eval(`window.__clickKey(${J(key)})`)
      const ok = await waitFor(cdp,
        `window.__detail().barKey === ${J(key)} && window.__detail().rows === 3 && window.__detail().text.indexOf(${J(needle)}) >= 0`,
        key + ' 详情没出 3 行', 15000)
      check(`⑤ 选中 ${key}：详情网格 3 行（${cmd}）`, ok, await cdp.eval('window.__detail()'))
    }
    await shot('05-detail.png')

    // ---- 判据 6/7：INFO 弹层 + 慢日志页签 ----
    const infoRet = await cdp.eval('window.__openInfo()')
    const infoOpen = await waitFor(cdp, 'window.__modalOpen(".db-redis-info")',
      'INFO 弹层没打开', 15000)
    const infoText = await cdp.eval('window.__infoText()')
    check('⑥ INFO 弹层打开并渲染服务端段落（版本 7.2.6 / keyspace）',
      infoOpen && infoRet === 'ok' && infoText.indexOf('7.2.6') >= 0,
      { infoRet, tabs: await cdp.eval('window.__infoTabs()'), head: infoText.slice(0, 100) })
    check('⑥ INFO 弹层四个页签都在（概览 / Keyspace / 原文 / 慢日志）',
      (await cdp.eval('window.__q(".db-redis-info .ant-tabs-tab")')) === 4,
      await cdp.eval('window.__infoTabs()'))
    await shot('06-info-overview.png')

    const slTab = await cdp.eval('window.__clickInfoTab(3)')
    const slOk = await waitFor(cdp,
      'window.__slowlogRows() === 3 && window.__slowlogStatus().length > 0',
      '慢日志页签没拉到条目', 15000)
    check('⑦ 慢日志页签拉到 3 条（SLOWLOG GET，首次切进才发）',
      slOk && slTab === 'ok',
      { slTab, rows: await cdp.eval('window.__slowlogRows()'), status: await cdp.eval('window.__slowlogStatus()'), text: (await cdp.eval('window.__infoText()')).slice(0, 160) })
    await shot('07-info-slowlog.png')
    const slCalls = srv.stats().slowlogCalls
    check('⑦ 服务端确实收到 SLOWLOG GET（count=128，未传 0）',
      slCalls.length === 1 && slCalls[0].count === 128, slCalls)

    await cdp.eval('window.__closeInfo()')
    const infoClosed = await waitFor(cdp, '!window.__modalOpen(".db-redis-info")',
      'INFO 弹层没关掉', 10000)
    check('⑥/⑦ 关闭 INFO 弹层', infoClosed)

    // ---- 判据 8：批量删键（先关只读，写路径才放开） ----
    const ro0 = await cdp.eval('window.__readonlyState()')
    await cdp.eval('window.__toggleReadonly()')
    const roOff = await waitFor(cdp, 'window.__readonlyState() === "false"',
      '只读开关没关掉', 15000)
    check('批量删键前置：页面内关掉只读（主进程白名单同步生效）',
      ro0 === 'true' && roOff, { before: ro0, after: await cdp.eval('window.__readonlyState()') })

    const ck1 = await cdp.eval('window.__checkKey(\'smoke:key:000\')')
    const ck2 = await cdp.eval('window.__checkKey(\'smoke:key:001\')')
    const chip = await waitFor(cdp, 'window.__selChip().indexOf("2") >= 0', '勾选 2 个键后没出"已选 2"', 10000)
    check('⑧ 勾选 2 个键：常驻"已选 2"提示出现', chip && ck1 === 'ok' && ck2 === 'ok',
      { ck1, ck2, chip: await cdp.eval('window.__selChip()') })

    const openDel = await cdp.eval('window.__clickBatchDel()')
    const delOpen = await waitFor(cdp, 'window.__delModalOpen()', '批量删键弹层没打开', 10000)
    const preview = await cdp.eval('window.__delModalKeys()')
    check('⑧ 批量删键弹层打开并预览 2 个键',
      delOpen && openDel === 'ok' && preview.length === 2, { openDel, preview })
    await shot('08-del-preview.png')

    const confirmRet = await cdp.eval('window.__confirmDel()')
    // SCAN 游标不是 offset：删掉本页两个键后，后面的键会顶上来，当前页仍是 20 条。
    // 能钉死的是「被删键从列表消失」+「左侧 db0 计数按 INFO 刷新为 62」。
    const delDone = await waitFor(cdp,
      `!window.__delModalOpen() && window.__listLoading() === 0 &&
       window.__treeDbCount('db0') === '62'`,
      '删完列表/左侧计数没刷新', 20000)
    const unlinkStats = srv.stats().unlinkKeys.slice()
    const keysAfterDel = await cdp.eval('window.__redisKeys()')
    check('⑧ 确认删除后：被删键消失、左侧 db0 计数 64 → 62',
      delDone && confirmRet === 'ok' &&
        !keysAfterDel.includes('smoke:key:000') && !keysAfterDel.includes('smoke:key:001'),
      {
        confirmRet,
        rows: keysAfterDel.length,
        keys: keysAfterDel.slice(0, 4),
        treeDb0: await cdp.eval("window.__treeDbCount('db0')"),
        page: await cdp.eval('window.__pageText()')
      })
    check('⑧ 服务端收到 UNLINK 且键名对得上（产品用 UNLINK 而非 DEL）',
      unlinkStats.length === 2 &&
        unlinkStats.includes('smoke:key:000') && unlinkStats.includes('smoke:key:001') &&
        srv.count(0) === FIXTURE_TOTAL - 2,
      { unlink: unlinkStats, db0: srv.count(0) })

    // ---- 判据 9：TTL 修改 ----
    await cdp.eval('window.__clickKey(\'smoke:key:002\')')
    const selOk = await waitFor(cdp, 'window.__detail().paneTitle === \'smoke:key:002\'',
      'TTL 用的键没选中', 12000)
    const ttlRet = await cdp.eval('window.__setTtl(120)')
    const ttlOk = await waitFor(cdp,
      '/^(11[5-9]|120)s$/.test(window.__detail().ttlChip)',
      'TTL 芯片没刷成 ~120s', 15000)
    const ttlServer = srv.ttlOf('smoke:key:002')
    check('⑨ 设 TTL 后读回新值（EXPIRE 120 → 服务端 TTL=120）',
      selOk && ttlRet === 'ok' && ttlServer >= 118 && ttlServer <= 120,
      { ttlRet, server: ttlServer, chip: await cdp.eval('window.__detail().ttlChip'), calls: srv.stats().expireCalls })
    check('⑨ 详情 TTL 芯片同步刷新（前端重新 GET 详情，不本地假更新）', ttlOk,
      await cdp.eval('window.__detail()'))
    await shot('09-ttl.png')

    // ---- 判据 10：渲染层零硬错误 ----
    const events = cdp.events.slice()
    const hard = events.filter(l => {
      const s = String(l)
      if (/Failed to fetch dynamically imported module|Failed to load resource/.test(s)) {
        return false
      }
      return /Cannot read|is not a function|is not defined|TypeError|Uncaught|Cannot destructure|of undefined|of null/.test(s)
    })
    check('⑩ 渲染层没有硬错误（32→5 收拢漏字段会炸在这里）', hard.length === 0, hard.slice(0, 8))
    await shot('10-final.png')

    // ---- 协议路径记账 ----
    const cmds = srv.stats().commands
    const unique = [...new Set(cmds.map(c => c.cmd))].sort()
    const unknown = srv.stats().unknown
    check('协议路径完整：键列表/详情/INFO/慢日志/写路径的命令都到达服务端',
      ['SCAN', 'TYPE', 'TTL', 'GET', 'LRANGE', 'HSCAN', 'SSCAN', 'ZRANGE', 'SLOWLOG', 'UNLINK', 'EXPIRE', 'SELECT']
        .every(c => unique.includes(c)),
      { commands: unique, unknown })
    console.log('\n[fake-redis] 命令总数 ' + cmds.length + '，独立命令 ' + unique.length)
    console.log('[fake-redis] 命令清单: ' + unique.join(', '))
    console.log('[fake-redis] unknown: ' + JSON.stringify(unknown))
    if (unknown.length) {
      check('假服务端没有收到未实现命令', false, unknown.slice(0, 6))
    }

    return finish()
  } finally {
    try {
      if (cdp && tabId) {
        await cdp.eval(`window.store.delTab(${J(tabId)})`)
      }
    } catch (e) { /* 页面已关闭/超时，收尾失败不覆盖判据结果 */ }
    try {
      await srv.close()
    } catch (e) { /* ignore */ }
  }

  function finish () {
    const fail = results.filter(r => !r.ok)
    console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
    if (fail.length) {
      console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
    }
    console.log('截图: ' + SHOT_DIR)
    return fail.length
  }
}

async function printDiag (cdp, srv) {
  try {
    console.log('DIAG head=' + await cdp.eval('window.__head()'))
    console.log('DIAG events=' + JSON.stringify(cdp.tail(10)))
    console.log('DIAG fake-redis cmds=' +
      JSON.stringify(srv.stats().commands.map(c => c.cmd).slice(0, 40)))
    console.log('DIAG fake-redis unknown=' + JSON.stringify(srv.stats().unknown.slice(0, 10)))
  } catch (e) {
    console.log('DIAG failed: ' + (e && e.message))
  }
}

main().then(code => process.exit(code ? 1 : 0), e => {
  console.error(e)
  process.exit(1)
})
