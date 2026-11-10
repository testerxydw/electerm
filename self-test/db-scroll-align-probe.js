#!/usr/bin/env node
/**
 * 会话页 / 服务器信息键空间 / Redis 命令控制台 · 滚动通道定向探针
 *
 * 用法：
 *   1) npm run compile（探针加载 work/app 产物）
 *   2) node self-test/db-scroll-align-probe.js
 * 退出码：0 = 全部 PASS；1 = 有判据 FAIL；2 = 环境/启动失败。
 *
 * 量什么（静态契约 spec 的盲区，AGENTS.md §5.2.7 / §5.3）：
 *   每个界面里「computed overflowY in {auto,scroll}」的滚动容器清单
 *   + 真实滚轮后谁动了（scrollTop）+ 表头/输入行/分页器 rect 是否钉住 + 截图。
 *   窗口故意压矮（1420x520）复现用户截图里的限高工况。
 *
 * 顺序 C→A→B：会话页先量（避免控制台弹层盖住后续界面）；控制台最后量，
 * Enter/Escape 走真实 CDP 按键（合成 KeyboardEvent 进不了 React 键路径），
 * 按钮关闭走 onClick 合成点击（坐标点击在叠层弹层下落点不可靠）。
 * 会话页取数走渲染层桩（dbClientOp 只假 mysql 一支，redis 仍走 fake-redis 真 IPC）；
 * 桩只活在本次一次性实例里，结束即回收（AGENTS.md §1/§2：临时目录直删）。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const Redis = require('ioredis')
const { startFakeRedis } = require('./fake-redis')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, makeChecker, clearDbTabs
} = require('./db-ui-helpers')

const PORT = '9394'
const REDIS_PORT = 6394
const DISPLAY = ':144'
const SHOT_DIR = path.join(__dirname, '2026-11-10-scroll-align-shots')
const J = s => JSON.stringify(s)
const asArr = v => Array.isArray(v) ? v : []

const PROBE = `(() => {
  window.__txt = el => (el && el.innerText ? el.innerText : '').trim()
  window.__vis = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
  }
  window.__all = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__one = sel => window.__all(sel)[0] || null
  window.__dismiss = () => {
    const btns = [...document.querySelectorAll('.ant-modal-root button')].filter(window.__vis)
    const t = btns.find(b => /稍后|Later|知道了|OK|Got it/i.test(window.__txt(b)))
    if (!t) return 'none'
    t.click()
    return 'closed'
  }
  window.__clickText = (sel, re) => {
    // antd 会给两字汉字按钮插空格（"关 闭"），匹配前先去掉空格
    const el = window.__all(sel).find(n => re.test(window.__txt(n).split(' ').join('')))
    if (!el) return 'no-match:' + re
    el.click()
    return 'ok'
  }
  window.__rect = sel => {
    const el = window.__one(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }
  }
  // 滚动容器清单：只列真正会滚的（overflow auto/scroll），over 标记是否溢出
  window.__scrollDump = rootSel => {
    const root = document.querySelector(rootSel)
    if (!root) return { error: 'no-root:' + rootSel }
    const out = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const s = getComputedStyle(el)
      // 虚拟表体 overflowY=hidden 但挂原生 wheel 监听（rc-virtual-list），同样是滚动通道
      const virt = /ant-table-tbody-virtual-holder/.test(String(el.className))
      if (!virt && !/(auto|scroll)/.test(s.overflowY)) continue
      const r = el.getBoundingClientRect()
      if (!r.height) continue
      out.push({
        cls: String(el.className).slice(0, 80),
        ch: el.clientHeight, sh: el.scrollHeight, st: el.scrollTop,
        top: Math.round(r.top), h: Math.round(r.height),
        over: el.scrollHeight > el.clientHeight + 1
      })
    }
    return out
  }
  // 表体通道几何：DbGridTable 的 scroll.y 是否生效（y=0 会退化为全量渲染）
  window.__gridGeom = wrapSel => {
    const wrap = document.querySelector(wrapSel + ' .db-grid-table-wrap')
    const body = document.querySelector(wrapSel + ' .ant-table-body') ||
      document.querySelector(wrapSel + ' .ant-table-tbody-virtual-holder')
    const rows = document.querySelectorAll(wrapSel + ' .ant-table-row').length
    return {
      wrapH: wrap ? wrap.clientHeight : -1,
      bodyCls: body ? String(body.className).slice(0, 60) : null,
      bodyOY: body ? getComputedStyle(body).overflowY : null,
      bodyH: body ? body.clientHeight : -1,
      rows
    }
  }
  // 会话页桩：只假 mysql 的 dbClientOp；其余 op 原样回落原装桥接
  window.__stubMysql = () => {
    if (window.__mysqlStub) return 'already'
    const orig = window.pre.runGlobalAsync
    const rows = []
    for (let i = 1; i <= 60; i++) {
      rows.push({
        id: i, user: 'app', host: '10.0.0.' + i + ':51000', db: 'shop',
        command: i % 3 ? 'Query' : 'Sleep', time: i * 2,
        state: i % 3 ? 'Sending data' : '', info: i % 3 ? 'SELECT * FROM t' + i : null
      })
    }
    const isMysqlTab = id => {
      const t = (window.store.tabs || []).find(x => x.id === id)
      return !!t && t.dbType === 'mysql'
    }
    window.pre.runGlobalAsync = function (name, ...a) {
      // 建连/关连也按引擎分流：mysql 假成功（3306 无真库）；redis 必须走真 IPC，
      // 否则主进程没登记连接 → 后续 op 报 database tab not open
      if (name === 'openDbTab' && a[0] && a[0].dbType === 'mysql') return Promise.resolve({ ok: true })
      if (name === 'closeDbTab' && isMysqlTab(a[0])) return Promise.resolve({ ok: true })
      // 只假 mysql 一支；redis 的 info/scan 等必须走真 IPC，
      // 否则服务器信息弹层拿不到 INFO 会退化成只剩慢日志页签
      if (name === 'dbClientOp' && isMysqlTab(a[0])) {
        const op = a[1]
        if (op === 'listSessions') return Promise.resolve({ rows })
        if (op === 'getServerStatus') {
          return Promise.resolve({ version: '8.0.36', status: { Threads_connected: '60' } })
        }
        if (op === 'getMetadata') {
          return Promise.resolve([{ name: 'demo_db', children: [{ name: 't1', type: 'table' }] }])
        }
        return Promise.resolve(null)
      }
      return orig.call(window.pre, name, ...a)
    }
    window.__mysqlStub = true
    return 'ok'
  }
  return 'probe-ready'
})()`

const { check, results } = makeChecker()

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-scroll-align-home-'))
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-scroll-align-tmp-'))
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1420x520x24'], { stdio: 'ignore', detached: true })
  await sleep(800)
  const srv = await startFakeRedis(REDIS_PORT)
  const electron = spawn(
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron'),
    ['work/app/app.js',
      '--remote-debugging-port=' + PORT,
      '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu',
      '--window-size=1420,520'],
    {
      stdio: 'ignore',
      // 独立进程组：electron 会再 fork server.js 子进程并继承 CDP 监听 socket，
      // 只杀主 pid 会留下占端口僵尸（下一轮 getJson 连上 hung 端口永久挂起）
      detached: true,
      env: { ...process.env, DISPLAY, HOME: homeDir, TMPDIR: tmpDir, DISABLE_GPU: '1', DISABLE_GPU_SANDBOX: '1' }
    }
  )
  const cleanup = () => {
    // 杀整组（主 + server.js + shell 子进程），负 pid = 进程组
    try { process.kill(-electron.pid, 'SIGKILL') } catch (e) {}
    try { electron.kill('SIGKILL') } catch (e) {}
    try { process.kill(-xvfb.pid, 'SIGKILL') } catch (e) {}
    try { xvfb.kill('SIGKILL') } catch (e) {}
    srv.close().catch(() => {})
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  let cdp = null
  try {
    let targets = null
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      try {
        // hung 端口（僵尸继承监听 socket）会 accept 不回包：单请求 3s 上限，避免永久挂起
        targets = await Promise.race([
          getJson(`http://127.0.0.1:${PORT}/json/list`),
          sleep(3000).then(() => null)
        ])
        if (findPageTarget(targets)) break
      } catch (e) {}
      await sleep(500)
    }
    const page = findPageTarget(targets || [])
    if (!page) throw new Error('electron 没起来：渲染进程目标找不到')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Page.bringToFront', {})
    const shot = f => cdp.shot(path.join(SHOT_DIR, f))
    const key = async k => {
      const vk = k === 'Escape' ? 27 : 13
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk })
    }
    check('渲染进程可用', await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
    await cdp.eval(buildHelpers('electerm-cdp-scroll-align'))
    await cdp.eval(PROBE)
    await clearDbTabs(cdp)
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__dismiss()') !== 'closed') break
      await sleep(200)
    }

    // ---- C：MySQL 会话页（渲染层桩，先量避免弹层遮挡） ----
    check('mysql 桩安装', await cdp.eval('window.__stubMysql()') === 'ok')
    await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: 'mysql 127.0.0.1:3306',
        dbType: 'mysql', dbHost: '127.0.0.1', dbPort: 3306, dbUser: 'root', dbPassword: '',
        dbName: 'demo_db', dbSsl: false, readOnly: true,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    check('会话页签点开', await waitFor(cdp,
      'window.__clickText(".ant-tabs-tab", /^会话$|^sessions$/) === "ok"', 'sessions tab', 20000))
    check('会话行渲染（桩 60 行，虚拟只渲染可视窗口）', await waitFor(cdp,
      'window.__all(".db-sessions-wrap .ant-table-row").length >= 5', 'session rows', 20000))
    await sleep(600)
    console.log('C grid geom:', J(await cdp.jeval('window.__gridGeom(".db-sessions-wrap")')))
    const sBefore = await cdp.jeval('window.__scrollDump(".db-sessions-wrap")')
    const sHeadBefore = await cdp.jeval('window.__rect(".db-sessions-wrap .ant-table-thead")')
    await shot('C-sessions-before.png')
    const sBox = await cdp.jeval('window.__rect(".db-sessions-wrap .db-grid-table-wrap")')
    if (sBox) await cdp.wheel(700, sBox.top + 100, 400)
    await sleep(400)
    const sAfter = asArr(await cdp.jeval('window.__scrollDump(".db-sessions-wrap")'))
    const sHeadAfter = await cdp.jeval('window.__rect(".db-sessions-wrap .ant-table-thead")')
    await shot('C-sessions-after-wheel.png')
    console.log('C sessions scrollables before:', J(sBefore))
    console.log('C sessions scrollables after :', J(sAfter))
    const sOver = (sAfter || []).filter(x => x.over)
    const sInner = (sAfter || []).find(x => /ant-table-body|virtual-holder/.test(x.cls))
    check('C 会话页：表体内滚（DbGridTable 通道 scrollTop>0）', !!sInner && sInner.st > 0, sInner)
    check('C 会话页：wrap 内单通道=表体（不自开 overflow 视口）',
      sOver.length > 0 && sOver.every(x => /ant-table-body|virtual-holder/.test(x.cls)), sOver)
    check('C 会话页：滚轮后表头钉住（rect.top 差 <=1.5）',
      !!sHeadBefore && !!sHeadAfter && Math.abs(sHeadBefore.top - sHeadAfter.top) <= 1.5,
      { sHeadBefore, sHeadAfter })
    const sWrap = await cdp.jeval('window.__rect(".db-sessions-wrap")')
    const sPager = await cdp.jeval('window.__rect(".db-sessions-wrap .ant-pagination")')
    check('C 会话页：分页器常驻可视区（不被滚走）',
      !!sPager && !!sWrap && sPager.top + sPager.h <= sWrap.top + sWrap.h + 2, { sWrap, sPager })

    // ---- 建 redis 连 ----
    await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', from: 'quick-connect', title: ${J('redis 127.0.0.1:' + REDIS_PORT)},
        dbType: 'redis', dbHost: '127.0.0.1', dbPort: ${REDIS_PORT}, dbPassword: '',
        dbName: '0', dbSsl: false, readOnly: true,
        batch: window.store.currentLayoutBatch
      })
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()`)
    check('redis 建连', await waitFor(cdp, '!!window.__one(".db-head-target")', 'head', 25000))
    for (let i = 0; i < 3; i++) {
      if (await cdp.eval('window.__clickTree("db0")') !== 'ok') continue
      if (await waitFor(cdp, 'window.__all(".db-redis-keys .ant-table-row").length >= 5', 'keys', 20000)) break
      await sleep(500)
    }
    // 埋满 16 个 db：键空间表 16 行 > 定高 380 的可视频，表体内滚才有的量
    for (let i = 2; i < 16; i++) {
      const c = new Redis({ port: REDIS_PORT, db: i })
      await c.set('seed:k', '1')
      c.disconnect()
    }

    // ---- A：服务器信息弹层 · 键空间 ----
    check('INFO 入口点开', await cdp.eval(
      'window.__clickText(".db-session-head-bar button, .db-head button, button", /服务器信息|Server info/)') === 'ok')
    check('INFO 弹层打开', await waitFor(cdp, '!!window.__one(".db-redis-info")', 'info modal', 12000))
    check('INFO 页签渲染', await waitFor(cdp, '!!window.__one(".db-redis-info .ant-tabs-tab")', 'info tabs', 12000))
    check('切到键空间页签', await cdp.eval(
      'window.__clickText(".db-redis-info .ant-tabs-tab", /键空间|Keyspace|keyspace/)') === 'ok')
    await sleep(600)
    console.log('A grid geom:', J(await cdp.jeval('window.__gridGeom(".db-redis-info")')))
    const ksBefore = await cdp.jeval('window.__scrollDump(".ant-modal-root")')
    const ksHeadBefore = await cdp.jeval('window.__rect(".db-redis-info .ant-table-thead")')
    await shot('A-keyspace-before.png')
    const ksBox = await cdp.jeval('window.__rect(".db-redis-info .ant-table")')
    if (ksBox) await cdp.wheel(700, ksBox.top + 60, 240)
    await sleep(400)
    const ksAfter = asArr(await cdp.jeval('window.__scrollDump(".ant-modal-root")'))
    const ksHeadAfter = await cdp.jeval('window.__rect(".db-redis-info .ant-table-thead")')
    await shot('A-keyspace-after-wheel.png')
    console.log('A keyspace scrollables before:', J(ksBefore))
    console.log('A keyspace scrollables after :', J(ksAfter))
    const ksInner = (ksAfter || []).find(x => /ant-table-body|virtual-holder/.test(x.cls))
    const ksBody = (ksAfter || []).find(x => x.cls === 'ant-modal-body')
    check('A 键空间：表体内滚（DbGridTable 通道 scrollTop>0）', !!ksInner && ksInner.st > 0, ksInner)
    check('A 键空间：滚轮后表头钉住（rect.top 差 <=1.5）',
      !!ksHeadBefore && !!ksHeadAfter && Math.abs(ksHeadBefore.top - ksHeadAfter.top) <= 1.5,
      { ksHeadBefore, ksHeadAfter })
    check('A 键空间：滚轮落在表体时弹层 body 不被带着滚', !!ksBody && ksBody.st === 0, ksBody)
    check('INFO 弹层关闭', await cdp.eval(
      'window.__clickText(".ant-modal-root button", /^关闭$|^Close$/)') === 'ok')
    await sleep(600)
    const titles = await cdp.jeval('window.__all(".ant-modal-title").map(window.__txt)')
    console.log('B0 after info close:', J(titles))

    // ---- B：命令控制台（最后量；真实按键收补全、真实点击关弹层） ----
    await cdp.eval('window.__one(".db-redis-console-open").click()')
    check('控制台弹层打开', await waitFor(cdp, '!!window.__one(".db-redis-console-input")', 'console', 12000))
    // 等开弹层动画落地：动画中途的 rect 去点击会落在遮罩上把弹层关掉
    await sleep(700)
    for (let i = 0; i < 10; i++) {
      // antd v6 的 <Input> 无前缀时 className 直接落在原生 input 上（非嵌套），
      // 用 .db-redis-console-line 自身即可；有嵌套 input 时兜底内层。focus() 与真点击等效，
      // 键盘事件仍走真 CDP 按键。
      await cdp.eval(`(() => {
        const el = window.__one('.db-redis-console-line')
        const t = el && (el.querySelector('input') || el)
        if (t) t.focus()
        return !!t
      })()`)
      await cdp.call('Input.insertText', { text: 'get smoke:key:' + String(i).padStart(3, '0') })
      await sleep(80)
      await key('Enter')
      await sleep(300)
      console.log('B iter', i, J(await cdp.jeval(`(() => {
        const el = window.__one('.db-redis-console-line')
        const inp = el && (el.querySelector('input') || el)
        return {
          console: !!window.__one('.db-redis-console-input'),
          val: inp ? inp.value : null,
          entries: window.__all('.db-redis-console-entry').length,
          suggest: !!window.__one('.db-redis-console-suggest'),
          focus: document.activeElement ? String(document.activeElement.className).slice(0, 40) : null
        }
      })()`)))
    }
    const cEntries = await cdp.eval('window.__all(".db-redis-console-entry").length')
    console.log('B console entries:', cEntries)
    check('B 控制台：命令真执行了（历史有entry）', cEntries >= 5, cEntries)
    // 补全开着才按 Escape：补全已收时真 Escape 会进弹层 Esc 监听把整个控制台关掉
    if (await cdp.eval('!!window.__one(".db-redis-console-suggest")')) {
      await key('Escape')
      await sleep(300)
    }
    const cBefore = await cdp.jeval('window.__scrollDump(".db-redis-console")')
    await shot('B-console-before.png')
    await cdp.wheel(700, 320, 400)
    await sleep(400)
    const cAfter = asArr(await cdp.jeval('window.__scrollDump(".db-redis-console")'))
    const cInputAfter = await cdp.jeval('window.__rect(".db-redis-console-input")')
    await shot('B-console-after-wheel.png')
    console.log('B console scrollables before:', J(cBefore))
    console.log('B console scrollables after :', J(cAfter))
    const cOver = (cAfter || []).filter(x => x.over && !/console-suggest/.test(x.cls))
    check('B 控制台：补全收起后弹层内溢出滚动容器仅 body 一条', cOver.length === 1 &&
      cOver[0].cls === 'ant-modal-body', cOver)
    check('B 控制台：滚轮后 body 确实滚了', cOver.some(x => x.st > 0), cOver)
    // 输入行 sticky top:0：滚前在标题下方（197），滚后钉到 body 顶（150）—— 断言"钉住"应比滚动后的顶，
    // 不比滚前自然位（未滚前 sticky 不触发，二者本来就不同）
    const cBodyRect = await cdp.jeval('window.__rect(".db-redis-console .ant-modal-body")')
    check('B 控制台：滚轮后输入行钉顶（与 body 顶对齐）',
      !!cInputAfter && !!cBodyRect && Math.abs(cInputAfter.top - cBodyRect.top) <= 1.5,
      { cInputAfter, cBodyRect })
    await cdp.eval('window.__clickText(".db-redis-console button", /^关闭$|^Close$/)')
    await sleep(600)
    check('B 控制台：关闭后不再遮挡界面', await cdp.eval('!window.__one(".db-redis-console-input")'))
  } catch (e) {
    check('探针执行无异常', false, String((e && e.message) || e))
  } finally {
    cleanup()
  }
  const fail = results.filter(r => !r.ok).length
  console.log(J({ total: results.length, fail }))
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
