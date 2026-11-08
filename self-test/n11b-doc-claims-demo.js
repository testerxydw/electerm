#!/usr/bin/env node
/**
 * N11b 文档更正项 —— CDP 实机复核
 *
 * 这一批改的是文档与注释（`数据库功能总览` 逐条更正并归档 + 两处滞后注释），
 * 所以实机要量的不是新功能，而是"更正是不是把结论改对了"。两条腿：
 *
 *   腿 A（总览 §2.2「支持 7 种引擎」+ §3.2 T10 行）：
 *     真实书签表单的引擎下拉逐项列出，逐引擎读端口联动，
 *     钉住 SQLite（本地文件，无端口）与 KingbaseES（54321）这两条新写的结论。
 *   腿 B（总览 §2.3 Redis 写操作行 = T12/D 批 10 个类型化写）：
 *     真 ioredis + self-test/fake-redis 的 RESP2 替身，从键详情工具条走真实 UI：
 *     hash 添加字段（HSET）、list 头部插入（LPUSH）、set 添加成员（SADD）、
 *     zset 添加成员带分值（ZADD）—— 服务端收到的命令与参数、网格刷新后的行数
 *     两头对账；再把只读开关打开，验同一批按钮真的 disabled（护栏仍在）。
 *
 * 用法：
 *   1) npm run compile
 *   2) DISPLAY=:139 HOME=/tmp/electerm-n4a/home TMPDIR=/tmp/electerm-n4a/tmp \
 *        setsid ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9391 --no-sandbox --disable-gpu --window-size=1680,1050
 *   3) node self-test/n11b-doc-claims-demo.js [cdpPort] [shotDir] [fakeRedisPort]
 *
 * 本机没有 redis-server / docker，Redis 侧用 RESP2 替身：验的是被改的那半
 * （客户端 + 渲染层写路径），命令与写操作可在同进程对账。
 */
const fs = require('node:fs')
const path = require('node:path')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9391'
const SHOT_DIR = process.argv[3] || path.join(__dirname, '2026-11-08-n11b-shots')
const REDIS_PORT = Number(process.argv[4]) || 6396
const J = s => JSON.stringify(s)
const { check, results } = makeChecker()

// 文档里写的默认端口（constants.js dbDefaultPortMap + db-client/index.js PORT_MAP）
const EXPECT_PORT = {
  MySQL: '3306',
  Redis: '6379',
  PostgreSQL: '5432',
  TiDB: '4000',
  OceanBase: '2881',
  KingbaseES: '54321'
}

const PROBE = `(() => {
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  }
  window.__txt = el => (el && el.innerText ? String(el.innerText) : '').trim()
  window.__at = sel => {
    const el = [...document.querySelectorAll(sel)].filter(window.__vis)[0]
    return el ? window.__xy(el) : null
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  // ---- 引擎下拉 ----
  // antd 给字段 id 加了表单前缀（database-form_dbType），只能按后缀认
  window.__inp = suffix => [...document.querySelectorAll('input, textarea')]
    .find(i => String(i.id || '').endsWith(suffix))
  window.__engineSelectXY = () => {
    const inp = window.__inp('dbType')
    const it = inp && inp.closest('.ant-form-item')
    const box = it && (it.querySelector('.ant-select-content') || it.querySelector('.ant-select-selector') || it.querySelector('.ant-select'))
    return box && window.__vis(box) ? window.__xy(box) : null
  }
  window.__optTexts = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(window.__txt)
  window.__optXY = t => {
    const el = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(o => window.__txt(o) === t)
    return el ? window.__xy(el) : null
  }
  window.__portValue = () => {
    const el = window.__inp('dbPort')
    return !el || !window.__vis(el) ? null : String(el.value)
  }
  window.__fileVisible = () => {
    const el = window.__inp('dbFile')
    return !!el && window.__vis(el)
  }
  window.__closeBtnXY = () => {
    const a = [...document.querySelectorAll('.close-setting-wrap')].filter(window.__vis).map(window.__xy)
    return a.length ? a[a.length - 1] : null
  }
  // ---- Redis 键详情写控件 ----
  window.__keyRowXY = name => {
    const tr = [...document.querySelectorAll('.db-redis-keys .ant-table-row')]
      .find(r => window.__txt(r.children[1] || r.children[0]) === name)
    const cell = tr && (tr.children[1] || tr.children[0])
    return cell ? window.__xy(cell) : null
  }
  window.__detailBar = () => {
    const el = [...document.querySelectorAll('.db-redis-detail-bar')].filter(window.__vis)[0]
    return el ? window.__txt(el) : null
  }
  window.__addInputs = () => [...document.querySelectorAll('.db-redis-detail-bar .db-redis-add-input')]
    .filter(window.__vis)
  // 注意：InputNumber 的 className 挂在外层 span 上，真正要写值的是它里面的 input
  window.__setInput = (i, v) => {
    const box = window.__addInputs()[i]
    if (!box) return 'no-input:' + i
    const el = box.tagName === 'INPUT' || box.tagName === 'TEXTAREA' ? box : box.querySelector('input')
    if (!el) return 'no-inner-input:' + i
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__barBtnXY = re => {
    const bar = [...document.querySelectorAll('.db-redis-detail-bar')].filter(window.__vis)[0]
    if (!bar) return null
    const rx = new RegExp(re)
    const b = [...bar.querySelectorAll('button')].find(x =>
      rx.test(window.__txt(x)) || rx.test(x.title || ''))
    return b ? window.__xy(b) : null
  }
  // 添加控件是"只有 Plus 图标、没有文字"的按钮，只读下 title 会换成只读提示，
  // 所以按图标认它，而不是按 title 文案认
  window.__plusBtn = () => {
    const bar = [...document.querySelectorAll('.db-redis-detail-bar')].filter(window.__vis)[0]
    if (!bar) return null
    const ic = bar.querySelector('.anticon-plus')
    const b = ic && ic.closest('button')
    return b && window.__vis(b) ? b : null
  }
  window.__plusBtnXY = () => {
    const b = window.__plusBtn()
    return b ? window.__xy(b) : null
  }
  window.__plusBtnState = () => {
    const b = window.__plusBtn()
    return b ? { disabled: !!b.disabled, title: String(b.title || '') } : null
  }
  window.__barBtnDisabled = re => {
    const bar = [...document.querySelectorAll('.db-redis-detail-bar')].filter(window.__vis)[0]
    if (!bar) return null
    const rx = new RegExp(re)
    const b = [...bar.querySelectorAll('button')].find(x =>
      rx.test(window.__txt(x)) || rx.test(x.title || ''))
    return b ? !!b.disabled : null
  }
  window.__detailRows = () => window.__txt(document.querySelector('.db-redis-detail')) &&
    [...document.querySelectorAll('.db-redis-detail .ant-table-row')].length
  window.__detailText = () => {
    const el = [...document.querySelectorAll('.db-redis-detail')].filter(window.__vis)[0]
    return el ? window.__txt(el).replace(/\\s+/g, ' ').slice(0, 220) : null
  }
  window.__readonlySwitch = () => {
    const sw = document.querySelector('.db-head .ant-switch')
    return sw ? { xy: window.__xy(sw), on: /ant-switch-checked/.test(String(sw.className)) } : null
  }
  window.__head = () => window.__txt(document.querySelector('.db-head-target'))
  return 1
})()`

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('端口 ' + PORT + ' 上没有页面目标')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  const shot = f => cdp.shot(path.join(SHOT_DIR, f))
  const click = async (p, ms = 600, what) => {
    if (!p) throw new Error('点不到：' + (what || '坐标为空'))
    await cdp.click(p.x, p.y)
    await sleep(ms)
  }
  // antd 下拉是"点一下开、选完自己关"：读选项或选完一项后，下次都得先确认它是开的
  const ensureEngineOpen = async () => {
    for (let i = 0; i < 12; i++) {
      if (Number(await cdp.eval('window.__optTexts().length')) > 0) return true
      const xy = await cdp.eval('window.__engineSelectXY()')
      if (!xy) return false
      await cdp.click(xy.x, xy.y)
      await sleep(450)
    }
    return false
  }

  // 前一个 demo 可能把 window.pre.runGlobalAsync 留在桩版：整页重载拿回原装桥接
  await cdp.call('Page.reload', { ignoreCache: false })
  check('渲染进程可用（store / pre 都在）',
    await waitFor(cdp, '!!(window.store && window.pre)', 'boot', 60000))
  await cdp.eval(buildHelpers('electerm-db-cell-split'))
  await cdp.eval(PROBE)
  check('页内探针装好',
    await cdp.eval('!!(window.__engineSelectXY && window.__keyRowXY && window.__barBtnXY)'))

  // ══════════════════ 腿 A：引擎下拉 + 默认端口 ══════════════════
  const NEW_BK = `(() => {
    const el = [...document.querySelectorAll('.anticon-plus-circle')]
      .filter(window.__vis).find(b => b.getBoundingClientRect().left < 290)
    return el ? window.__xy(el) : null
  })()`
  // 刚 reload 完侧栏图标还没挂上：先等它，再决定要不要点开书签面板
  check('左侧栏就绪（书签开关出现）',
    await waitFor(cdp, '!!window.__at(\'.bookmark-sidebar-toggle\')', '侧栏书签开关未出现', 30000))
  let btn = await cdp.eval(NEW_BK)
  if (!btn) {
    await click(await cdp.eval('window.__at(\'.bookmark-sidebar-toggle\')'), 1200, '书签侧栏')
    const got = await waitFor(cdp, `!!${NEW_BK}`, '点开侧栏仍没有"新建书签"图标', 12000)
    if (!got) throw new Error('打不开书签面板：' + J(cdp.tail(6)))
    btn = await cdp.eval(NEW_BK)
  }
  await click(btn, 800, '新建书签')
  const chipOk = await waitFor(cdp, `(() => {
    const b = [...document.querySelectorAll('.ant-radio-button-wrapper')].filter(window.__vis)
      .find(x => /^(数据库|database)$/i.test(window.__txt(x)))
    if (!b) return false
    if (!/checked/.test(String(b.className))) b.click()
    return true
  })()`, '类型切换条里找不到"数据库"', 12000)
  check('书签表单切到数据库类型', chipOk)
  check('引擎字段出现',
    await waitFor(cdp, '!!window.__engineSelectXY()', '数据库类型字段未出现', 10000))

  check('引擎下拉可打开', await ensureEngineOpen())
  const options = await cdp.eval('window.__optTexts()')
  check('① 引擎下拉 7 项（总览 §2.2「支持 7 种」）', options.length === 7, options)
  const need = ['MySQL', 'Redis', 'PostgreSQL', 'TiDB', 'OceanBase', 'SQLite', 'KingbaseES']
  check('① 下拉含 SQLite 与 KingbaseES（T10 更正项）',
    need.every(n => options.includes(n)), { need, options })

  const portRead = {}
  for (const name of Object.keys(EXPECT_PORT)) {
    await ensureEngineOpen()
    await click(await cdp.eval(`window.__optXY(${J(name)})`), 900, '选项 ' + name)
    await sleep(300)
    portRead[name] = await cdp.eval('window.__portValue()')
  }
  const portBad = Object.keys(EXPECT_PORT).filter(k => portRead[k] !== EXPECT_PORT[k])
  check('② 逐引擎默认端口与文档一致（3306/6379/5432/4000/2881/54321）',
    portBad.length === 0, { read: portRead, expect: EXPECT_PORT, bad: portBad })

  await ensureEngineOpen()
  await click(await cdp.eval('window.__optXY("SQLite")'), 1200, '选项 SQLite')
  check('③ SQLite：端口字段隐藏 + 出现库文件字段（文档「本地文件，无端口」）',
    (await cdp.eval('window.__portValue()')) === null && (await cdp.eval('window.__fileVisible()')),
    { port: await cdp.eval('window.__portValue()'), file: await cdp.eval('window.__fileVisible()') })
  await shot('n11b-A1-engine-sqlite.png')
  await click(await cdp.eval('window.__closeBtnXY()'), 900, '关闭书签表单')

  // ══════════════════ 腿 B：Redis 类型化写（T12/D 批） ══════════════════
  const srv = await startFakeRedis(REDIS_PORT)
  try {
    const cleared = await clearDbTabs(cdp)
    await cdp.eval('window.store.setConfig({ dbPageSize: 20 })')
    await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J('redis ' + REDIS_PORT)},
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
    check('Redis 会话建立（真 ioredis 连上 RESP2 替身）', connected,
      { head: await cdp.eval('window.__head()'), cleared: cleared.closed.length })
    if (!connected) throw new Error('Redis 没连上，腿 B 无法继续：' + J(cdp.tail(8)))

    const db0XY = `(() => {
      const n = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
        .filter(window.__vis).find(x => window.__txt(x).indexOf('db0') >= 0)
      return n ? window.__xy(n) : null
    })()`
    await click(await cdp.eval(db0XY), 2000, 'db0 节点')
    const listed = await waitFor(cdp, 'window.__keyRowXY("smoke:a:hash") !== null',
      '键列表等不到夹具键', 20000)
    check('键列表出数（夹具 smoke:a:hash 可见）', listed)

    const pickKey = async name => {
      await click(await cdp.eval(`window.__keyRowXY(${J(name)})`), 1500, '键 ' + name)
      const ok = await waitFor(cdp, '!!window.__detailBar()', '详情工具条未出现', 15000)
      if (!ok) throw new Error('选中 ' + name + ' 后没有详情工具条：' + J(await cdp.eval('window.__detailText()')))
      return ok
    }
    const cmdsOf = name => srv.stats().commands.filter(c => String(c.cmd).toUpperCase() === name)

    // —— hash：HSET ——
    await pickKey('smoke:a:hash')
    check('④ hash 详情工具条带"添加字段"控件（T12 UI 入口）',
      !!(await cdp.eval('window.__plusBtnXY()')),
      await cdp.eval('window.__detailBar()'))
    const hashBefore = await cdp.eval('window.__detailRows()')
    check('④ 写前 hash 网格 3 行（夹具 f1/f2/f3）', hashBefore === 3, hashBefore)
    await cdp.eval('window.__setInput(0, \'cdpn11b_field\')')
    await cdp.eval('window.__setInput(1, \'cdpn11b_value\')')
    await click(await cdp.eval('window.__plusBtnXY()'), 1800, '添加字段')
    const hashAfter = await cdp.eval('window.__detailRows()')
    const hset = cmdsOf('HSET')
    check('④ 添加字段 → 服务端收到 HSET 且键/字段/值对得上',
      hset.some(c => String(c.args && c.args[0]) === 'smoke:a:hash' &&
        String(c.args && c.args[1]) === 'cdpn11b_field' &&
        String(c.args && c.args[2]) === 'cdpn11b_value'),
      { hset: hset.map(c => c.args), text: await cdp.eval('window.__detailText()') })
    check('④ HSET 后网格刷到 4 行（前端重拉详情，不是本地假插入）',
      hashAfter === 4, { before: hashBefore, after: hashAfter })
    check('④ 替身存储里字段真的落库',
      srv.store.db(0).get('smoke:a:hash').value.get('cdpn11b_field') === 'cdpn11b_value',
      [...srv.store.db(0).get('smoke:a:hash').value.entries()])

    // —— list：LPUSH ——
    await pickKey('smoke:a:list')
    const listBefore = await cdp.eval('window.__detailRows()')
    await cdp.eval('window.__setInput(0, \'cdpn11b_head\')')
    await click(await cdp.eval('window.__barBtnXY("头部插入|Insert head")'), 1800, '头部插入')
    const listAfter = await cdp.eval('window.__detailRows()')
    const lpush = cmdsOf('LPUSH')
    check('⑤ 头部插入 → 服务端收到 LPUSH left 且值正确',
      lpush.some(c => String(c.args && c.args[0]) === 'smoke:a:list' &&
        String(c.args && c.args.slice(1)).indexOf('cdpn11b_head') >= 0),
      { lpush: lpush.map(c => c.args) })
    check('⑤ LPUSH 后网格刷到 4 行', listAfter === 4, { before: listBefore, after: listAfter })

    // —— set：SADD ——
    await pickKey('smoke:a:set')
    await cdp.eval('window.__setInput(0, \'cdpn11b_member\')')
    await click(await cdp.eval('window.__barBtnXY("添加成员|Add member")'), 1800, 'set 添加成员')
    const sadd = cmdsOf('SADD')
    check('⑥ SADD 到替身服务端 + 网格刷到 4 行',
      sadd.some(c => String(c.args && c.args[0]) === 'smoke:a:set' &&
        String(c.args && c.args[1]) === 'cdpn11b_member') &&
      (await cdp.eval('window.__detailRows()')) === 4,
      { sadd: sadd.map(c => c.args), rows: await cdp.eval('window.__detailRows()') })

    // —— zset：ZADD（带分值） ——
    await pickKey('smoke:a:zset')
    await cdp.eval('window.__setInput(0, \'cdpn11b_zmember\')')
    await cdp.eval('window.__setInput(1, \'9.5\')')
    await click(await cdp.eval('window.__barBtnXY("添加成员|Add member")'), 1800, 'zset 添加成员')
    const zadd = cmdsOf('ZADD')
    check('⑦ ZADD 成员与分值都到服务端',
      zadd.some(c => {
        const a = (c.args || []).map(String)
        return a.includes('smoke:a:zset') && a.includes('9.5') && a.includes('cdpn11b_zmember')
      }), { zadd: zadd.map(c => c.args) })
    // 替身里 zset 存的是 [member, score] 数组（hash 才是 Map）
    const zrec = srv.store.db(0).get('smoke:a:zset').value
    check('⑦ 替身存储里 zset 分值 = 9.5',
      Number((zrec.find(x => x[0] === 'cdpn11b_zmember') || [])[1]) === 9.5, zrec)
    await shot('n11b-B1-redis-typed-write.png')

    // —— 只读护栏 ——
    const sw0 = await cdp.eval('window.__readonlySwitch()')
    if (sw0 && !sw0.on) {
      await click(sw0.xy, 1500, '只读开关')
    }
    const sw1 = await cdp.eval('window.__readonlySwitch()')
    check('⑧ 只读开关已打开', !!sw1 && sw1.on === true, sw1)
    await pickKey('smoke:a:hash')
    const st = await cdp.eval('window.__plusBtnState()')
    check('⑧ 只读下"添加字段"按钮 disabled，且 title 说明只读原因',
      !!st && st.disabled === true && st.title.length > 0, st)
    const hsetCountBefore = cmdsOf('HSET').length
    await click(await cdp.eval(db0XY), 1200, 'db0 复点')
    check('⑧ 只读切换后没有新增任何写命令',
      cmdsOf('HSET').length === hsetCountBefore,
      { before: hsetCountBefore, after: cmdsOf('HSET').length })

    // —— 主题 + 硬错误 ——
    const themeIds = await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
    const ids = JSON.parse(themeIds)
    const themeBefore = String((await cdp.eval('String((window.store._config || {}).theme || "")')))
    const other = ids.find(id => /light/i.test(String(id))) || ids.find(id => id !== themeBefore)
    check('⑨ 双主题各截一张（写控件在两主题下都在）',
      await (async () => {
        if (!other) return false
        await cdp.eval('window.store.setTheme(' + J(other) + ')')
        await sleep(1500)
        await pickKey('smoke:a:hash')
        const stillThere = !!(await cdp.eval('window.__plusBtnXY()'))
        await shot('n11b-B2-redis-write-theme2.png')
        await cdp.eval('window.store.setTheme(' + J(themeBefore) + ')')
        await sleep(800)
        return stillThere
      })(), { ids, themeBefore, other })

    const hard = cdp.events.filter(e => e.indexOf('EX ') === 0)
    check('⑩ 渲染层零未捕获异常', hard.length === 0, hard.slice(0, 4))
  } finally {
    // 先关页签（主进程按签名引用计数才真的 release 连接），再关替身：
    // 反过来的话 srv.close 会一直等在还活着的 ioredis 连接上
    await clearDbTabs(cdp)
    await sleep(800)
    await srv.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  console.log('截图: ' + SHOT_DIR)
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('FATAL', e && e.message)
  try {
    const bad = results.filter(r => !r.ok)
    console.log((results.length - bad.length) + '/' + results.length + ' passed (aborted)')
  } catch (_) {}
  process.exit(1)
})
