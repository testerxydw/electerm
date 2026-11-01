#!/usr/bin/env node
/**
 * G9-4 隧道运行时面板 —— 真 sshd + 真字节的实机验收
 *
 * 单测钉的是判据层：tunnel-runtime.spec（归一）、session-ssh-tunnel-op.spec（主进程启停）、
 * tunnel-runtime-ui.spec（接线契约）。这里只验"必须有一个真 SSH 对端"才看得见的东西：
 *   1) 入口只在配了隧道的 shell 会话上出现，本地终端页不给入口
 *   2) 四种隧道 + 缺端口 + 端口被占 + 未知类型共 8 行，一行的状态/地址/摘要都对得上
 *   3) "运行中"不是界面自己脑补：连上监听口写真字节，回声从对端穿回来
 *      （本地转发、远端转发、本地 SOCKS5、远端 SOCKS5 四条各走一遍）
 *   4) 点「停止」→ 端口真的没了（Node 侧能重新 bind 它），且 SSH 会话还活着、
 *      别的隧道照样能走字节
 *   5) 点「启动」→ 端口重新被占、字节重新走通（重建，不是把状态位翻回来）
 *   6) 远端隧道停止时，服务端确实收到 cancel-tcpip-forward 并关掉它自己的监听口
 *   7) 端口被占的那条：错误原文上屏；把占用者放掉再点启动 → 真能转发
 *   8) 缺监听端口那条没有按钮（点不动），并说明为什么
 *   9) 未知类型那条：类型说"不认识"，状态用主进程给的 error，界面不编状态
 *  10) 在途那行的按钮不许重复发（连点两下不会换来 "tunnel is not running" 报错）
 *  11) 面板认的是打开它的那条会话：切页不会改成讲别的会话的隧道
 *  12) SSH 断开后整表禁点、给一句为什么，且每行如实变成已停止
 *  13) 深浅两套主题下面板颜色都走 token
 *
 * 凭据：无 —— 假 sshd 跑在 127.0.0.1 随机端口上，口令是本脚本自己定的。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/ work/app/
 *   2) HOME=<临时> DISPLAY=<xvfb> 起带 --remote-debugging-port 的实例
 *      （例：port 9245、HOME=/tmp/electerm-g9-home）
 *   3) node self-test/tunnel-runtime-demo.js [debugPort] [home] [shotDir]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')
const {
  startFakeSshd,
  startEcho,
  holdPort,
  freePort,
  portOpen,
  bindable,
  roundTrip,
  socksRoundTrip
} = require('./fake-sshd')

const PORT = process.argv[2] || '9245'
const HOME = process.argv[3] || path.join(os.tmpdir(), 'electerm-g9-home')
const SHOT_DIR = process.argv[4] || path.join(__dirname, 'tunnel-runtime-shots')

const USER = 'g9tester'
const PASS = 'g9-self-test-pass'
const TAB_TITLE = 'g9-ssh'

const zh = (s) => String(s == null ? '' : s).split(' ').join('')

/**
 * 页内探针：面板的行全靠稳定类名取，坐标用来真点。
 */
const PROBE = `
(() => {
  const tr = {}
  const vis = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return false
      n = n.parentElement
      if (n && n.classList && n.classList.contains('ant-modal-wrap') &&
          getComputedStyle(n).display === 'none') return false
    }
    return true
  }
  const txt = el => el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  const box = el => {
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  }
  tr.icon = () => {
    const el = [...document.querySelectorAll('.terminal-tunnel-icon')].filter(vis)[0]
    return el ? { xy: box(el), active: el.className.indexOf('active') >= 0, title: el.title } : null
  }
  tr.modal = () => !![...document.querySelectorAll('.tunnel-runtime-modal')].filter(vis)[0]
  tr.title = () => {
    const el = document.querySelector('.tunnel-runtime-modal .ant-modal-title')
    return txt(el)
  }
  tr.head = () => [...document.querySelectorAll('.tunnel-runtime-modal .tunnel-head span')].map(txt)
  tr.bar = () => txt(document.querySelector('.tunnel-runtime-modal .tunnel-bar'))
  tr.empty = () => txt(document.querySelector('.tunnel-runtime-modal .tunnel-empty'))
  tr.rows = () => [...document.querySelectorAll('.tunnel-runtime-modal .tunnel-row')].map(r => {
    const q = s => r.querySelector(s)
    const btn = q('.tunnel-op button')
    const status = q('.tunnel-status')
    return {
      name: txt(q('.tunnel-name')),
      type: txt(q('.tunnel-type')),
      address: txt(q('.tunnel-address')),
      status: status ? status.className.replace(/.*tunnel-status-/, '') : null,
      statusText: txt(status),
      note: txt(q('.tunnel-note')),
      cls: r.className,
      hasBtn: !!btn,
      btnText: txt(btn),
      btnDisabled: btn ? !!btn.disabled : null,
      btnLoading: btn ? btn.className.indexOf('ant-btn-loading') >= 0 : null,
      xy: btn ? box(btn) : box(q('.tunnel-op'))
    }
  })
  tr.row = (name) => tr.rows().find(r => r.name === name) || null
  tr.foot = () => {
    const f = document.querySelector('.tunnel-runtime-modal .tunnel-foot')
    if (!f) return null
    return {
      total: txt(f.querySelector('.tunnel-total')),
      chips: [...f.querySelectorAll('.tunnel-sum')].map(c =>
        c.className.replace(/.*tunnel-sum-/, '') + '=' + txt(c.querySelector('.tunnel-sum-n')))
    }
  }
  tr.panelBg = () => {
    const el = document.querySelector('.tunnel-runtime-modal .tunnel-runtime')
    if (!el) return null
    const cs = getComputedStyle(el)
    return cs.backgroundColor + '|' + cs.color
  }
  tr.messages = () => [...document.querySelectorAll('.message-item')]
    .map(m => m.className.replace('message-item ', '') + '::' +
      (m.querySelector('.message-content') || { innerText: '' }).innerText.replace(/\\s+/g, ' ').trim())
  tr.tab = (id) => {
    const t = window.store.tabs.find(x => x.id === id)
    return t ? {
      id: t.id, status: t.status,
      results: (t.sshTunnelResults || []).map(r => r && r.id),
      specs: (t.sshTunnels || []).map(s => s && s.id)
    } : null
  }
  window.__tr = tr
  return 'ok'
})()
`

const main = async () => {
  // ── 服务端侧的真值：假 sshd + 三个回声端口 + 一个被占住的端口 ──────────
  const echoA = await startEcho('echoA')
  const echoB = await startEcho('echoB')
  const echoC = await startEcho('echoC')
  const sshd = await startFakeSshd({ username: USER, password: PASS })
  const takenPort = await freePort()
  const releaseTaken = await holdPort(takenPort)

  // 隧道清单：四种类型各一条真能转发的，再加三条"界面必须会解释"的
  const localA = await freePort()
  const localB = await freePort()
  const socksPort = await freePort()
  const remotePort = await freePort()
  const remoteDynamicPort = await freePort()
  const tunnels = [
    {
      id: 'g9-local-a',
      name: 'local-a',
      sshTunnel: 'forwardLocalToRemote',
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: localA,
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: echoA.port
    },
    {
      id: 'g9-local-b',
      name: 'local-b',
      sshTunnel: 'forwardLocalToRemote',
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: localB,
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: echoB.port
    },
    {
      id: 'g9-socks',
      name: 'socks',
      sshTunnel: 'dynamicForward',
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: socksPort
    },
    {
      id: 'g9-remote',
      name: 'remote',
      sshTunnel: 'forwardRemoteToLocal',
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: remotePort,
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: echoC.port
    },
    {
      id: 'g9-rsocks',
      name: 'rsocks',
      sshTunnel: 'remoteDynamicForward',
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: remoteDynamicPort
    },
    // 缺监听端口：主进程根本不会跑它，面板要摆出来并说明为什么点不动
    {
      id: 'g9-noport',
      name: 'noport',
      sshTunnel: 'forwardLocalToRemote',
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: echoA.port
    },
    // 本地口已被本脚本占住：EADDRINUSE 的原文要上屏
    {
      id: 'g9-taken',
      name: 'taken',
      sshTunnel: 'forwardLocalToRemote',
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: takenPort,
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: echoB.port
    },
    // 老书签/deeplink 里的没见过的类型：不许界面替它编一个状态
    {
      id: 'g9-weird',
      name: 'weird',
      sshTunnel: 'someFutureTunnelType',
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: await freePort(),
      sshTunnelRemoteHost: '127.0.0.1',
      sshTunnelRemotePort: echoA.port
    }
  ]

  // known_hosts：不预置就会弹信任确认，把整套判据卡在第一个点击上
  const sshDir = path.join(HOME, '.ssh')
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(sshDir, 'known_hosts'), sshd.knownHostsLine + '\n', { mode: 0o600 })

  const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no page target')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Log.enable', {})
  cdp.events.length = 0
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
  })

  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.translate', 'renderer boots', 120000)
  await sleep(2000)
  await cdp.eval(PROBE)
  cdp.events.length = 0

  const { check, results } = makeChecker()
  let shotIdx = 0
  const shot = async (name) => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(320)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ev = (expr) => cdp.eval(expr)
  const jev = (expr) => cdp.jeval(expr)
  const row = async (name) => jev('JSON.stringify(window.__tr.row(' + JSON.stringify(name) + '))')
  const allRows = async () => jev('JSON.stringify(window.__tr.rows())')
  const clickRowOp = async (name) => {
    const r = await row(name)
    if (!r || !r.hasBtn) {
      return false
    }
    await cdp.click(r.xy.x, r.xy.y)
    return true
  }
  const waitRowStatus = async (name, status, label, timeout = 15000) => {
    return waitFor(cdp,
      '(() => { const r = window.__tr.row(' + JSON.stringify(name) + ');' +
      ' return !!r && r.status === ' + JSON.stringify(status) + ' })()',
      label, timeout)
  }

  // ── 1. 入口只在配了隧道的 shell 会话上出现 ─────────────────────────
  await ev('window.store.tabs.slice().forEach(t => window.store.delTab(t.id))')
  await sleep(700)
  await ev('window.store.addTab({ type: "local", title: "g9-local" })')
  await sleep(1200)
  check('本地终端页不给隧道入口', (await jev('JSON.stringify(window.__tr.icon())')) === null)

  await ev(`window.store.bookmarks
    .filter(b => String(b.title || '').indexOf(${JSON.stringify(TAB_TITLE)}) === 0)
    .forEach(b => window.store.delItem({ id: b.id }, 'bookmarks'))`)
  await sleep(400)
  const bm = {
    id: 'g9-bm',
    title: TAB_TITLE,
    type: 'ssh',
    host: '127.0.0.1',
    port: sshd.port,
    username: USER,
    password: PASS,
    authType: 'password',
    useSshAgent: false,
    ignoreKeyboardInteractive: true,
    sshTunnels: tunnels
  }
  await ev('window.store.addItem(' + JSON.stringify(bm) + ', "bookmarks")')
  await ev('window.store.onSelectBookmark("g9-bm")')
  const opened = await waitFor(cdp,
    `(() => {
      const t = window.store.tabs.find(x => x.title === ${JSON.stringify(TAB_TITLE)})
      return !!t && t.status === 'success' && Array.isArray(t.sshTunnelResults)
    })()`, 'ssh session opens and reports tunnels', 60000)
  check('真 SSH 会话连上并回传了隧道结果', !!opened)
  const tabId = await ev(`window.store.tabs.filter(x => x.title === ${JSON.stringify(TAB_TITLE)})
    .map(x => x.id).join('|')`)
  const firstTab = String(tabId).split('|')[0]
  await ev('window.__g9Tab = ' + JSON.stringify(firstTab))
  await sleep(600)
  const tabPort = Number(await ev('window.store.tabs.find(x => x.id === window.__g9Tab).port'))
  check('开的是这一轮的假 sshd 端口（上一轮遗留的同名书签没顶掉它）',
    tabPort === sshd.port, { tab: tabPort, sshd: sshd.port })

  const tabState = await jev('JSON.stringify(window.__tr.tab(window.__g9Tab))')
  check('回传的行 id 就是书签里的 id（没有退化成 tunnel-<下标>）',
    JSON.stringify(tabState.results) === JSON.stringify(tunnels.filter(t => t.id !== 'g9-noport').map(t => t.id)),
    tabState.results)

  const iconWithTunnels = await jev('JSON.stringify(window.__tr.icon())')
  check('配了隧道的会话给出入口图标', !!iconWithTunnels && !!iconWithTunnels.xy, iconWithTunnels)
  check('入口标题用词条（不是硬编码中文/英文）',
    /隧道|tunnel/i.test(iconWithTunnels.title || ''), iconWithTunnels.title)
  await cdp.click(iconWithTunnels.xy.x, iconWithTunnels.xy.y)
  await waitFor(cdp, 'window.__tr.modal()', 'panel opens', 10000)
  await sleep(400)
  check('点入口打开面板', await ev('window.__tr.modal()'))
  await shot('panel-open')

  // ── 2. 八行、五种列、摘要 ────────────────────────────────────────
  const rows = await allRows()
  check('八条配置出八行（含根本没跑起来的三条）', rows.length === 8, rows.map(r => r.name))
  check('表头五列齐全', (await jev('JSON.stringify(window.__tr.head())')).length === 5,
    await jev('JSON.stringify(window.__tr.head())'))
  const byName = rows.reduce((acc, r) => ({ ...acc, [r.name]: r }), {})
  check('本地转发行的地址写成「监听端 → 目标端」',
    byName['local-a'].address === `127.0.0.1:${localA} → 127.0.0.1:${echoA.port}`, byName['local-a'].address)
  check('远端转发行也写成「监听端 → 目标端」（监听在远端）',
    byName.remote.address === `127.0.0.1:${remotePort} → 127.0.0.1:${echoC.port}`, byName.remote.address)
  check('动态转发行写成 socks5://本地监听口',
    byName.socks.address === `socks5://127.0.0.1:${socksPort}`, byName.socks.address)
  check('远端动态转发行写成 socks5://远端监听口',
    byName.rsocks.address === `socks5://127.0.0.1:${remoteDynamicPort}`, byName.rsocks.address)
  check('缺端口那条没有目标端可读时仍给得出地址',
    byName.noport.address === `127.0.0.1:— → 127.0.0.1:${echoA.port}`, byName.noport.address)

  const expectRunning = ['local-a', 'local-b', 'socks', 'remote', 'rsocks']
  const states = rows.reduce((acc, r) => ({ ...acc, [r.name]: r.status }), {})
  check('五条真跑起来的都说运行中',
    expectRunning.every(n => states[n] === 'running'), states)
  check('端口被占那条是错误（不是运行中）', states.taken === 'error', states.taken)
  check('未知类型那条是错误（主进程说了不认，界面不编状态）',
    states.weird === 'error', states.weird)
  check('缺端口那条是 invalid（配置不完整，不是坏了）', states.noport === 'invalid', states.noport)
  const foot = await jev('JSON.stringify(window.__tr.foot())')
  check('摘要计数与逐行状态一致（共 8：5 运行 / 1 错误(占口) / 1 错误(未知) / 1 无效）',
    zh(foot.total).indexOf('8') >= 0 &&
      foot.chips.includes('running=5') && foot.chips.includes('error=2') &&
      foot.chips.includes('invalid=1'), foot)

  // ── 3. 「运行中」得有真字节作证（四种类型各一趟） ───────────────────
  const rtA = await roundTrip(localA, 'g9-via-local-a')
  check('本地转发：连自己的监听口，字节穿过 SSH 到了对端', rtA && rtA.indexOf('g9-via-local-a') >= 0, rtA)
  const rtB = await roundTrip(localB, 'g9-via-local-b')
  check('第二条本地转发同样走通（多条隧道互不抢道）',
    rtB && rtB.indexOf('g9-via-local-b') >= 0, rtB)
  const rtSocks = await socksRoundTrip(socksPort, '127.0.0.1', echoA.port, 'g9-via-socks')
  check('本地 SOCKS5：握手 + CONNECT 后字节走通',
    !!rtSocks && rtSocks.indexOf('g9-via-socks') >= 0, rtSocks)
  const rtRemote = await roundTrip(remotePort, 'g9-via-remote')
  check('远端转发：连服务端的转发口，字节被推回本机目标口',
    !!rtRemote && rtRemote.indexOf('g9-via-remote') >= 0, rtRemote)
  const rtRsocks = await socksRoundTrip(remoteDynamicPort, '127.0.0.1', echoB.port, 'g9-via-rsocks')
  check('远端 SOCKS5：服务端口的握手在本地落地成目标连接',
    !!rtRsocks && rtRsocks.indexOf('g9-via-rsocks') >= 0, rtRsocks)
  check('假 sshd 侧确实被拨过这些目标（转发不是本机自己闭环）',
    [echoA.port, echoB.port].every(p => sshd.dialed.some(d => d.endsWith(':' + p))), sshd.dialed)
  check('远端两类隧道在服务端开了监听口',
    sshd.forwardedPorts().length === 2, sshd.forwardedPorts())

  // ── 4. 停止：端口真没了，会话与别的隧道不受影响 ────────────────────
  const beforeStop = await row('local-a')
  // antd 会把两字按钮渲染成「停 止」（CJK 自动间距），比的是去掉空格的形态
  check('运行中的那行给的是「停止」按钮',
    beforeStop.status === 'running' &&
    (zh(beforeStop.btnText) === zh('停止') || /stop/i.test(beforeStop.btnText || '')),
    beforeStop.btnText)
  await clickRowOp('local-a')
  await waitRowStatus('local-a', 'stopped', 'local-a row turns stopped')
  const afterStop = await row('local-a')
  check('停止后这一行改口叫「启动」', zh(afterStop.btnText) === zh('启动') || /start/i.test(afterStop.btnText),
    afterStop.btnText)
  const released = await bindable(localA)
  check('停止真的释放了监听端口（本进程能重新 bind 上它）', released === true)
  check('停止一条不影响会话：SSH 连接还在', await ev('window.__tr.tab(window.__g9Tab).status') === 'success')
  check('停止一条不影响会话：服务端仍认这条连接', sshd.clients() === 1, sshd.clients())
  const rtB2 = await roundTrip(localB, 'g9-still-alive')
  check('停止一条后，另一条隧道照样能走字节', !!rtB2 && rtB2.indexOf('g9-still-alive') >= 0, rtB2)
  await shot('after-stop-local-a')

  // ── 5. 启动：重新占口 + 重新走字节 ────────────────────────────────
  await clickRowOp('local-a')
  await waitRowStatus('local-a', 'running', 'local-a row turns running again')
  check('启动后端口重新被占住', await portOpen(localA))
  const rtA2 = await roundTrip(localA, 'g9-restarted')
  check('启动后字节重新走得通（重建，不是翻状态位）',
    !!rtA2 && rtA2.indexOf('g9-restarted') >= 0, rtA2)

  // ── 6. 在途置忙：连点两下不该换来第二次请求 ────────────────────────
  const rBefore = await row('local-b')
  await cdp.click(rBefore.xy.x, rBefore.xy.y)
  await cdp.click(rBefore.xy.x, rBefore.xy.y)
  await sleep(200)
  const msgs = await jev('JSON.stringify(window.__tr.messages())')
  check('连点两下不会把 "tunnel is not running" 这种主进程报错甩给用户',
    !msgs.some(m => /not running|is not configured/i.test(m)), msgs)
  await waitRowStatus('local-b', 'stopped', 'local-b stopped by the double click')

  // ── 7. 远端隧道的停止要真的把服务端监听口撤掉 ──────────────────────
  const cancelBefore = sshd.forwardLog.filter(l => l.name === 'cancel-tcpip-forward').length
  await clickRowOp('remote')
  await waitRowStatus('remote', 'stopped', 'remote row turns stopped')
  const cancelAfter = sshd.forwardLog.filter(l => l.name === 'cancel-tcpip-forward').length
  check('点停止真的发了 cancel-tcpip-forward 到服务端',
    cancelAfter === cancelBefore + 1, sshd.forwardLog.map(l => l.name + ' ' + l.key))
  check('服务端那一侧的监听口也真撤了',
    sshd.forwardedPorts().length === 1, sshd.forwardedPorts())
  await clickRowOp('remote')
  await waitRowStatus('remote', 'running', 'remote row runs again')
  const rtRemote2 = await roundTrip(remotePort, 'g9-remote-back')
  check('重新启动后远端转发又能走通', !!rtRemote2 && rtRemote2.indexOf('g9-remote-back') >= 0, rtRemote2)

  // ── 8. 错误行：原文上屏；占用者放掉后能启动 ────────────────────────
  const takenRow = await row('taken')
  check('端口被占的行把失败原文显示出来（不是只说"错误"）',
    /EADDRINUSE/i.test(takenRow.note || ''), takenRow.note)
  check('错误行也给「启动」按钮（值得再试一次）',
    zh(takenRow.btnText) === zh('启动') || /start/i.test(takenRow.btnText), takenRow.btnText)
  await releaseTaken()
  await sleep(400)
  await clickRowOp('taken')
  await waitRowStatus('taken', 'running', 'taken row runs once the port frees')
  const rtTaken = await roundTrip(takenPort, 'g9-taken-now')
  check('腾出口之后这条隧道真的建立并能走字节',
    !!rtTaken && rtTaken.indexOf('g9-taken-now') >= 0, rtTaken)

  // ── 9. invalid 与未知类型 ────────────────────────────────────────
  const noport = await row('noport')
  check('缺监听端口那条不给按钮（点下去只会换回一条错误）', noport.hasBtn === false, noport)
  check('缺监听端口那条写明为什么点不动（词条原文，不是空白）',
    /没有配置监听端口|no listen port/i.test(noport.note || ''), noport.note)
  const weird = await row('weird')
  check('未知类型那条的类型列说"不认识"',
    zh(weird.type).indexOf(zh('未知类型')) >= 0 || /unknown/i.test(weird.type), weird.type)
  check('未知类型那条把主进程的原话贴出来',
    /unknown ssh tunnel type/i.test(weird.note || ''), weird.note)
  await shot('rows-explained')

  // ── 10. 面板认的是打开它的那条会话 ────────────────────────────────
  const localTabId = await ev('window.store.tabs.find(t => t.title === "g9-local").id')
  await ev('window.store.changeActiveTabId(' + JSON.stringify(localTabId) + ')')
  await sleep(700)
  const rowsAfterSwitch = await allRows()
  check('切到本地页后，面板仍在讲原来那条会话的八条隧道',
    rowsAfterSwitch.length === 8 && rowsAfterSwitch[0].name === 'local-a',
    rowsAfterSwitch.map(r => r.name))
  check('切页后活动页已经没有隧道入口（面板不受它管辖）',
    (await jev('JSON.stringify(window.__tr.icon())')) === null)
  await ev('window.store.changeActiveTabId(window.__g9Tab)')
  await sleep(500)

  // ── 11. 浅色主题 ─────────────────────────────────────────────────
  const darkBg = await ev('window.__tr.panelBg()')
  await ev('window.store.setTheme && window.store.setTheme("defaultLight")')
  await sleep(900)
  const lightBg = await ev('window.__tr.panelBg()')
  check('面板颜色跟主题 token 走（深浅不同）', darkBg !== lightBg, { darkBg, lightBg })
  await shot('panel-light')
  await ev('window.store.setTheme && window.store.setTheme("default")')
  await sleep(800)

  // ── 12. 关掉再打开，面板不残留上一次的状态 ─────────────────────────
  const closeBtn = await jev(`(() => {
    const b = [...document.querySelectorAll('.tunnel-runtime-modal .ant-modal-footer button')]
    return b.length ? JSON.stringify(b[0].getBoundingClientRect()) : null
  })()`)
  if (closeBtn) {
    await cdp.click(Math.round(closeBtn.x + closeBtn.width / 2), Math.round(closeBtn.y + closeBtn.height / 2))
  }
  await sleep(600)
  check('关闭按钮能把面板收掉', !(await ev('window.__tr.modal()')))
  const icon2 = await jev('JSON.stringify(window.__tr.icon())')
  await cdp.click(icon2.xy.x, icon2.xy.y)
  await waitFor(cdp, 'window.__tr.modal()', 'panel reopens', 10000)
  const reopened = await allRows()
  check('重开后面板按当前回传重排（local-a 又成运行中）',
    reopened.length === 8 && reopened.find(r => r.name === 'local-a').status === 'running',
    reopened.map(r => r.name + '=' + r.status))

  // ── 13. 断开 SSH：整表禁点 + 说明原因 ─────────────────────────────
  await sshd.disconnectAll()
  const down = await waitFor(cdp,
    'window.__tr.tab(window.__g9Tab).status !== "success"', 'session marks itself down', 30000)
  check('会话断开后 tab 状态不再是成功', !!down, await jev('JSON.stringify(window.__tr.tab(window.__g9Tab))'))
  await sleep(1200)
  const bar = await jev('JSON.stringify(window.__tr.bar())')
  check('断开时给一句为什么（不是把按钮变灰就完事）',
    /会话未连接|not connected/i.test(String(bar || '')), bar)
  const downRows = await allRows()
  check('断开后每一行都没有按钮', downRows.length > 0 && downRows.every(r => !r.hasBtn),
    downRows.map(r => r.name + ':' + r.hasBtn))
  check('断开后每条隧道如实报成已停止（会话没了隧道也不在）',
    downRows.every(r => r.status !== 'running'), downRows.map(r => r.name + '=' + r.status))
  await shot('session-down')

  // ── 14. 前端没有未捕获错误 ────────────────────────────────────────
  const hardErrors = cdp.events.filter(e =>
    /^(LOG|EX|ERROR)/.test(e) &&
    !/favicon|DevTools|gpu|GLES|libva|network service|Fontconfig|dbus|blueman|sandbox|vulkan|gbm|dri|EGL|Wayland|Accelerated|SharedImage|-blit|Failed to load resource|net::ERR/i.test(e))
  // 断线时才回放的 exec 报错（"Unable to exec"）是假 sshd 应慢了的症状，不是面板的：
  // 真 sshd 会当场应答 exec，所以这里也应答，并把问过来的命令留痕，方便核对是谁在悬
  check('全程无未捕获前端错误', hardErrors.length === 0,
    { errors: hardErrors.slice(0, 3), execLog: sshd.execLog })
  check('断开后没有前端崩在隧道面板上（探针仍在）', await ev('typeof window.__tr.rows === "function"'))

  // 收尾：把本地那个 tab 也关掉，别让下一次跑撞上残留
  await ev('window.store.tabs.slice().forEach(t => window.store.delTab(t.id))')
  await sleep(500)

  await sshd.close()
  await echoA.close()
  await echoB.close()
  await echoC.close()
  fs.rmSync(path.join(os.tmpdir(), 'electerm-g9-probe'), { recursive: true, force: true })

  const fail = results.filter(r => !r.ok).length
  console.log('\n==== G9-4 结论 ====')
  console.log('pass ' + (results.length - fail) + '/' + results.length)
  if (fail) {
    console.log(results.filter(r => !r.ok).map(r => 'FAIL ' + r.name + ' ' + JSON.stringify(r.detail || '')).join('\n'))
  }
  process.exitCode = fail ? 1 : 0
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL ' + ((err && err.stack) || err))
  process.exit(1)
})
