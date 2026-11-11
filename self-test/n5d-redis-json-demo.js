#!/usr/bin/env node
/**
 * N5d RedisJSON —— CDP 实机全链路（真 Electron + 真 ioredis + fake-redis JSON.GET/SET 替身）
 *
 * 验的是键详情/值面板/写分发整条 UI 链：ReJSON 键不再落 "unsupported type" 空白，
 * 值面板按 string 同款渲染（type chip / 大整数保真 / 截断禁编辑），
 * 编辑保存经 server 侧 setKey 按 TYPE 自动分发 JSON.SET（不是 SET）。
 *
 * 用法（同 n11b-redis-smoke 机位）：
 *   1) npm run compile（改了 src 才需要）
 *   2) Xvfb :99 + env -u ELECTRON_RUN_AS_NODE DISPLAY=:99 ... electron work/app/app.js
 *      --remote-debugging-port=9386 --no-sandbox --disable-gpu-sandbox --in-process-gpu
 *   3) node self-test/n5d-redis-json-demo.js [cdpPort] [shotDir] [redisPort]
 */
const fs = require('node:fs')
const path = require('node:path')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker,
  clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9386'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'n5d-redis-json-shots')
const REDIS_PORT = Number(process.argv[4]) || 6390
const TITLE = `redis 127.0.0.1:${REDIS_PORT}`
const J = s => JSON.stringify(s)
const BIG_KEY = 'smoke:json:big'
const JSON_KEY = 'smoke:json:user'

// >256KB 的合法 JSON（触发 string 同款截断口径）
const bigDoc = '{"pad":"' + 'x'.repeat(300 * 1024) + '","n":1}'

// 页内探针：只做「找 / 点 / 读」，判据留在 Node 侧
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
  window.__head = () => window.__txt(document.querySelector('.db-head-target'))
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  // ReJSON 走 string 值面板分支：没有 DbSplitPane 壳，pane 直接在 .db-redis-detail 里
  window.__pane = () => document.querySelector('.db-redis-detail .db-value-pane')
  window.__detail = () => {
    const pane = window.__pane()
    const chip = document.querySelector('.db-redis-detail .db-redis-type-chip')
    return {
      hasDetail: !!document.querySelector('.db-redis-detail'),
      unsupported: !!document.querySelector('.db-redis-detail .db-cell-null'),
      chipType: window.__txt(chip),
      chipCls: chip ? String(chip.className) : '',
      paneTitle: window.__txt(pane && pane.querySelector('.db-grid-title')),
      // 值文本可能包在 .db-value-pre 的子高亮节点里：读整个 pane 的 textContent，
      // 再掐掉头部 meta（type/ttl/字符数）只留值区
      paneText: (() => {
        if (!pane) return ''
        const pre = pane.querySelector('.db-value-pre')
        if (pre) return String(pre.textContent || '')
        return String(pane.textContent || '').replace(/^(rejson-rl|无|[0-9]+ 字符|preview truncated.*|[ \\n\\r\\t])+/, '')
      })(),
      metaText: window.__txt(pane && pane.querySelector('.db-grid-total')),
      truncated: /truncated/i.test(window.__txt(pane && pane.querySelector('.db-grid-total')) || '')
    }
  }
  window.__editBtn = () => {
    const pane = window.__pane()
    if (!pane) return null
    const btns = [...pane.querySelectorAll('.db-value-pane-head button')]
    return btns.find(b => /edit|编辑/i.test(b.getAttribute('title') || window.__txt(b))) || null
  }
  window.__editState = () => {
    const pane = window.__pane()
    if (!pane) return 'no-pane'
    const b = window.__editBtn()
    if (!b) return 'no-edit-btn'
    return { disabled: b.disabled, title: b.getAttribute('title') || '' }
  }
  window.__startEdit = () => {
    const b = window.__editBtn()
    if (!b) return 'no-edit-btn'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__draft = () => {
    const ta = document.querySelector('.db-redis-detail .db-value-pane-text')
    return ta ? ta.value : null
  }
  window.__fill = val => {
    const ta = document.querySelector('.db-redis-detail .db-value-pane-text')
    if (!ta) return 'no-textarea'
    const proto = window.HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, String(val))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__clickPaneBtn = re => {
    const pane = window.__pane()
    if (!pane) return 'no-pane'
    const b = [...pane.querySelectorAll('.db-value-pane-head button')]
      .find(x => new RegExp(re, 'i').test(window.__txt(x).replace(/\\s/g, '')))
    if (!b) return 'no-btn:' + re
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  'ok'
})()`

async function main () {
  const { check, results } = makeChecker()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const srv = await startFakeRedis(REDIS_PORT)
  let cdp = null

  try {
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    const page = findPageTarget(targets)
    if (!page) throw new Error('找不到渲染进程页签，先把实例起起来')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Log.enable')
    await cdp.call('Page.bringToFront', {})
    const shot = f => cdp.shot(path.join(SHOT_DIR, f))

    check('渲染进程可用（store / pre / translate 都在）',
      await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
    await cdp.eval(buildHelpers('electerm-n5d-redis-json'))
    await cdp.eval(PROBE)
    check('页内探针装好',
      await cdp.eval('!!(window.__detail && window.__startEdit && window.__fill)'))

    // 幂等起点：清残留 db 页签 + 关引导弹层
    await clearDbTabs(cdp)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__dismiss()') !== 'closed') break
      await sleep(200)
    }

    // Node 侧直连 fake-redis 塞一个 >256KB 的 ReJSON 键（截断口径的前提）
    const Redis = require('ioredis')
    const seed = new Redis({ port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })
    await seed.connect()
    const setBig = await seed.call('JSON.SET', BIG_KEY, '$', bigDoc)
    check('Node 侧直塞 300KB ReJSON 键成功（截断判据前提）', setBig === 'OK', setBig)
    seed.disconnect()

    // ---- 建连（非 production：写路径确认弹窗直接放行，与 n11b 同口径）----
    await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J(TITLE)},
        dbType: 'redis', dbHost: '127.0.0.1', dbPort: ${REDIS_PORT}, dbPassword: '',
        dbName: '0', dbSsl: false, readOnly: false,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    const connected = await waitFor(cdp,
      `!!(window.__head() && window.__head().indexOf(${J(String(REDIS_PORT))}) >= 0)`,
      'Redis 会话头部等不到连接目标', 25000)
    check('加页签即建连', connected, { head: await cdp.eval('window.__head()') })
    if (!connected) return finish()

    // 键列表出来后点 ReJSON 键（先点树 db0 节点触发 SCAN 首页，n11b 同款）
    const treeOk = await waitFor(cdp, 'window.__hasTree && window.__hasTree("db0")', '树里等不到 db0', 20000)
    check('元数据树出 db0 节点', treeOk, await cdp.eval('window.__q(".db-tree .ant-tree-treenode")'))
    check('点树 db0 触发 SCAN', await cdp.eval('window.__clickTree("db0")') === 'ok')
    await waitFor(cdp, 'window.__all(".db-redis-keys .ant-table-row").length >= 5', '键列表', 20000)
    const clicked = await cdp.jeval(`(() => {
      const rows = window.__all('.db-redis-keys .ant-table-row')
      const tr = rows.find(r => (r.children[1] ? r.children[1].innerText : '') === ${J(JSON_KEY)})
      if (!tr) return 'no-row'
      tr.click()
      return 'ok'
    })()`)
    check('键列表点中 ReJSON 键 smoke:json:user', clicked === 'ok', clicked)
    await waitFor(cdp, '!!window.__pane()', '值面板等不到', 15000)
    await shot('1-json-user-pane.png')

    // ---- 读路径：详情不再 unsupported，走值面板 ----
    const d1 = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
    check('ReJSON 键详情渲染（不是 unsupported type 空白）',
      d1.hasDetail && !d1.unsupported && !!d1.paneTitle, d1)
    check('type chip 报 ReJSON-RL（真实模块 TYPE 形态）',
      /rejson-rl/i.test(d1.chipType), { chipType: d1.chipType })
    check('值面板文本是 JSON.GET 原始紧凑文本（大整数 9007199254740993 逐字保真）',
      d1.paneText.includes('"big":9007199254740993') &&
      d1.paneText.includes('"name":"alice"'), { head: d1.paneText.slice(0, 120) })
    check('小文档不触发截断（无 truncated 标记）', d1.truncated === false, d1.metaText)

    // 服务端命令对账：UI 读走 TYPE + JSON.GET（不是 GET）
    const cmds1 = srv.stats().commands.map(c => c.cmd)
    check('服务端到达 TYPE + JSON.GET（读路径走 JSON.GET，不是 GET）',
      cmds1.includes('TYPE') && cmds1.includes('JSON.GET') && !cmds1.includes('GET'),
      { unique: [...new Set(cmds1)] })

    // ---- 写路径：值面板编辑保存 → setKey 按 TYPE 分发 JSON.SET ----
    const st = JSON.parse(await cdp.eval('JSON.stringify(window.__editState())'))
    check('编辑按钮在场且可用（小文档不禁编辑）', st && st.disabled === false, st)
    const started = await cdp.eval('window.__startEdit()')
    check('进入编辑态（textarea 出现）',
      started === 'ok' && await waitFor(cdp, '!!document.querySelector(".db-redis-detail .db-value-pane-text")', 'textarea', 5000),
      started)
    const draft1 = await cdp.eval('window.__draft()')
    check('编辑草稿 = 当前 JSON 文本（编辑的是原始值不是渲染壳）',
      typeof draft1 === 'string' && draft1.includes('"big":9007199254740993'),
      { len: String(draft1 || '').length })

    // 改 name 并保留大整数：写回的文本必须逐字保真
    const newText = String(draft1).replace('"name":"alice"', '"name":"bob"')
    check('构造编辑文本成功（含大整数）', newText.includes('"name":"bob"') &&
      newText.includes('"big":9007199254740993'))
    const filled = await cdp.eval('window.__fill(' + J(newText) + ')')
    check('填入编辑文本', filled === 'ok', filled)
    const saved = await cdp.eval('window.__clickPaneBtn("save|保存")')
    check('点保存', saved === 'ok', saved)
    await sleep(1200)

    // 重读：值面板刷新出 bob，大整数原样
    const d2 = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
    check('保存后详情刷新：name 变 bob、大整数逐字保真',
      d2.paneText.includes('"name":"bob"') && d2.paneText.includes('"big":9007199254740993'),
      { head: d2.paneText.slice(0, 120) })
    const cmds2 = srv.stats().commands.map(c => c.cmd)
    check('服务端到达 JSON.SET（写分发按 TYPE 自动走，不是 SET）',
      cmds2.includes('JSON.SET') && !cmds2.includes('SET'),
      { unique: [...new Set(cmds2)] })

    // Node 侧直读服务端存储：大整数逐字节一致（原始文本透传，无 JS number 吞精度）
    const Redis2 = require('ioredis')
    const back = new Redis2({ port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })
    await back.connect()
    const stored = await back.call('JSON.GET', JSON_KEY)
    check('服务端存储的 JSON 文本与编辑文本逐字节一致（大整数保真到底）',
      stored === newText,
      { len: String(stored || '').length, head: String(stored || '').slice(0, 80) })
    back.disconnect()

    // ---- 截断口径：>256KB 的 ReJSON 键 → truncated 标记 + 禁编辑 ----
    const clicked2 = await cdp.jeval(`(() => {
      const rows = window.__all('.db-redis-keys .ant-table-row')
      const tr = rows.find(r => (r.children[1] ? r.children[1].innerText : '') === ${J(BIG_KEY)})
      if (!tr) return 'no-row'
      tr.click()
      return 'ok'
    })()`)
    check('切到大键 smoke:json:big', clicked2 === 'ok', clicked2)
    await sleep(1500)
    const d3 = JSON.parse(await cdp.eval('JSON.stringify(window.__detail())'))
    check('大文档触发截断标记（preview truncated + 完整字节数）', d3.truncated === true,
      { meta: d3.metaText })
    const st3 = await cdp.eval('window.__editState()')
    // 截断时 DbValuePane 直接不渲染编辑按钮（effectiveEditable=false 且未在编辑态），
    // 所以"禁编辑"的正确形态是按钮不在场；在场则必须 disabled
    check('截断后编辑禁用（防截断 JSON 覆盖写回真实文档）',
      st3 === 'no-edit-btn' || st3 === 'no-pane' || (st3 && st3.disabled === true),
      typeof st3 === 'string' ? st3 : st3)
    await shot('2-json-big-truncated.png')

    await shot('3-final.png')
  } catch (e) {
    console.log('DIAG failed: ' + (e && e.message))
    if (cdp) console.log('DIAG events=' + JSON.stringify(cdp.tail(8)))
    console.log('DIAG fake-redis unknown=' + JSON.stringify(srv.stats().unknown.slice(0, 10)))
  }
  async function finish () {
    const failed = results.filter(r => !r.ok)
    console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' PASS')
    try { srv.server.close() } catch (e2) { console.log('close err:', e2.message) }
    process.exit(failed.length ? 1 : 0)
  }
  await finish()
}

main().then(() => {}, e => {
  console.error(e)
  process.exit(1)
})
