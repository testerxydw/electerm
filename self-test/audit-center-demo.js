#!/usr/bin/env node
/**
 * G8-4 审计中心 —— 真实例 CDP 验收
 *
 * 单测钉的是判据层（audit-model.spec：三来源合并/过滤/导出格式）与落盘读取
 * （audit-files.spec：列目录、尾部窗口、防越界）。这里只验真渲染才看得见的东西：
 *   1) 顶栏菜单里确有「审计中心」，点它真的把弹层开出来（store 标志位 → main.jsx 渲染链）
 *   2) 三个来源真的并进一条时间线：连接 / 传输 / 日志 / 录制四类都有行
 *   3) 目录里非 .log/.cast 的文件不进审计（列目录那侧只放行这两种扩展名）
 *   4) 筛选三档各自成立且互不串：类型、主机、日期分桶；解不出主机的行不进主机候选
 *   5) 关键字能命中录制的「首条命令」——证明 cast 探测真的进了详情，不只是列了个名
 *   6) 选中 .log 行右栏真的读到尾部：ANSI 已剥、行数=500、窗口切掉的行数量如实报
 *   7) 选中 .cast 行能起回放器，画面里是录进的那台主机
 *   8) 导出的接线：空数据点导出只提示「无数据」且不发起下载（主进程仍应答），
 *      真有行时点导出会进入"下载中"。CSV/Markdown 的字节级内容归单测
 *      （audit-model.spec 的「G8 导出」组）——桌面产物里 `download()` 必走
 *      `showOpenDialogSync`（同步、无人应答就把主进程吊住），无头环境给不了
 *      一个能点"保存"的窗口，所以这条判据放在最后，跑完必须重启实例。
 *   9) 只读口径：整个弹层没有任何删除/改名入口
 *
 * 凭据：无 —— 历史与传输行用 CDP 灌进 store，日志目录是临时 HOME 下自建的夹具。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/ work/app/
 *   2) DISPLAY=<xvfb> HOME=<临时 home> XDG_CONFIG_HOME=<临时 config> TMPDIR=<临时 tmp> \
 *      ./node_modules/electron/dist/electron work/app/app.js \
 *      --no-sandbox --remote-debugging-port=9233
 *      —— demo 必须带同一套 HOME/XDG_CONFIG_HOME 运行：主进程列的日志目录是它的
 *      <config>/electerm/session_logs（ipc.js:246），夹具由脚本自己铺进去（见 seedFixtures）
 *   3) node self-test/audit-center-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9233'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'audit-center-shots')
// 夹具目录：自带，不认领别人的档案目录。
// 之前这里硬编码 /tmp/electerm-g83-config/electerm/session_logs —— 那是"写出这个脚本
// 那一批次"的 XDG_CONFIG_HOME，目录早没了，换任何一台实例都是 ENOENT 崩在半路
// （2026-11-04 第四轮扫掠里就是这么红的），而脚本头一直写着"临时 HOME 下自建的夹具"。
// 主进程列的目录 = app.getPath('appData')/electerm/session_logs（ipc.js:246，
// config.sessionLogPath 只在启动时读一次，跑中途改配置没用），Linux 上
// appData 就是 XDG_CONFIG_HOME —— 所以按同一套环境推出来，再自己把 4 个夹具文件铺上。
// 用法：驱动给 demo 和实例传同一个 HOME / XDG_CONFIG_HOME；要指别处就传 AUDIT_LOG_DIR。
const LOGS = process.env.AUDIT_LOG_DIR || path.join(
  process.env.XDG_CONFIG_HOME ||
    path.join(process.env.HOME || os.homedir(), '.config'),
  'electerm', 'session_logs')
const { check, results } = makeChecker()

// 文件名要走产品的命名式：`<标题>_<主机>_<7 位会话 id>.<ext>`（audit-model.js:51
// parseSessionLogName，SESSION_ID_LEN=7），主机名才解得出来；主机用种子历史里的
// web-1 / 10.0.0.9，免得筛选侧多出一个历史上没有的主机。
// 标题里可以带下划线（主机取会话 id 之前的最后一段），所以长日志叫 `build_dp`：
// 第 6 节选中它才点得到"尾部窗口"那组判据。
const LOG_LINES = 1200
// 每行都裹一层颜色，尾部判据才真的在验"剥了 ANSI"；行里绝不出现 uptime ——
// 第 5 节钉的是"关键字 uptime 只命中录制那一行"
const longLog = (() => {
  const out = []
  for (let i = 1; i <= LOG_LINES; i++) {
    out.push('\u001b[32m[build_dp]\u001b[0m step ' + i + ' \u001b[33mok\u001b[0m')
  }
  return out.join('\n') + '\n'
})()
// 录制 7 个事件 = 4 个输出（written 到 4）+ 3 个输入，末事件 6.0 秒（pos 到 6000）。
// 两条真命令 uptime / df -h 之间隔 3 秒虚拟时钟：4x 下约 0.75 秒真实时间，
// waitFor 每 200ms 轮一次才抢得到"徽标是 uptime、画面里还没有 uptime"的中途状态。
// 第三条输入是空行（只回车）——castCommands 不产命令，末尾徽标才停在 df -h。
const castBody = () => [
  JSON.stringify({
    version: 2, width: 80, height: 24, timestamp: Math.floor(Date.now() / 1000) - 90
  }),
  '[0.3,"o","root@web-1:~# "]',
  '[0.8,"i","uptime\\r\\n"]',
  '[2.0,"o","up 3 days, 1 user, load average: 0.00, 0.00, 0.00\\r\\n"]',
  '[3.8,"i","df -h\\r\\n"]',
  '[4.4,"o","Filesystem      Size  Used Avail Use% Mounted on\\r' +
    '\\n/dev/vda1        40G   12G   28G  30% /\\r\\n"]',
  '[5.0,"i","\\r\\n"]',
  '[6.0,"o","root@web-1:~# \\u001b[31mexit\\u001b[0m\\r\\n"]'
].join('\n') + '\n'

const FIXTURES = [
  { name: 'build_dp_web-1_aB3dEfG.log', body: longLog },
  { name: 'query_10.0.0.9_zZ9yXwV.log', body: 'select 1\n1\n' },
  { name: 'play_web-1_mN4bQrT.cast', body: castBody() },
  { name: 'note_web-1_kK7pLsP.txt', body: '不该进审计的扩展名\n' }
]

const seedFixtures = () => {
  fs.mkdirSync(LOGS, { recursive: true })
  for (const f of FIXTURES) {
    const p = path.join(LOGS, f.name)
    // 每次覆盖写：判据钉的是"目录里恰好 2 log + 1 cast + 1 txt"，
    // 留着上一轮的改名残留就会数多
    fs.writeFileSync(p, f.body)
  }
  const extra = fs.readdirSync(LOGS).filter(n => !FIXTURES.some(f => f.name === n))
  for (const n of extra) {
    if (/\.(log|cast|txt)$/.test(n)) fs.rmSync(path.join(LOGS, n), { force: true })
  }
  return LOGS
}

const zh = s => String(s == null ? '' : s).split(' ').join('')

/** 页内：把历史/传输灌进 store（组件按 props 读，先灌再开才拿得到） */
const SEED_STORE = `(() => {
  const now = Date.now()
  window.store.storeAssign({
    history: [
      { id: 'h1', time: now - 6 * 60000, count: 2, tab: { title: 'web shell', host: 'web-1', username: 'root', type: 'ssh' } },
      { id: 'h2', time: now - 3 * 3600 * 1000, count: 1, tab: { title: 'db', host: '10.0.0.9', username: 'svc', type: 'ssh' } },
      { id: 'h3', count: 1, tab: { title: 'no-time', host: 'ghost', username: 'nobody', type: 'ssh' } }
    ],
    transferHistory: [
      { id: 't1', host: 'web-1', username: 'root', typeFrom: 'local', typeTo: 'remote',
        fromPath: '/tmp/a.tar', toPath: '/srv/a.tar', startTime: now - 10 * 60000,
        finishTime: now - 9 * 60000, size: 12345, speed: 1000, error: '' },
      { id: 't2', host: '10.0.0.9', username: 'svc', typeFrom: 'remote', typeTo: 'local',
        fromPath: '/var/log/syslog', toPath: '/tmp/syslog', startTime: now - 40 * 60000,
        finishTime: now - 39 * 60000, size: 998, speed: 20, error: 'short read' }
    ]
  })
  return window.store.history.length * 100 + window.store.transferHistory.length
})()`

/** 页内：抓当前弹层的可读快照（只依赖稳定类名 + data-* 计数） */
const SNAPSHOT = `(() => {
  const txt = el => (el ? el.textContent.trim() : '')
  // 菜单条目要在弹层没开时也能读：否则"条目在不在"会跟着弹窗状态一起变假红。
  // 只看真的展开着的那个 popover：antd 收起来的 popover 仍留在 DOM 里，读它会放行"点了没反应"
  const pop = [...document.querySelectorAll('.ant-popover')].find(p =>
    !p.classList.contains('ant-popover-hidden'))
  const menuHasAudit = pop
    ? [...pop.querySelectorAll('.context-item')]
      .some(i => /审计中心|Audit center/.test(i.textContent.replace(/\\s+/g, '')))
    : false
  const box = document.querySelector('.audit-center')
  const menuOpen = (() => {
    const p = [...document.querySelectorAll('.ant-popover')].find(x =>
      !x.classList.contains('ant-popover-hidden'))
    return !!p && p.querySelectorAll('.context-item').length > 0
  })()
  if (!box) {
    return JSON.stringify({
      open: false, menuHasAudit, menuOpen, rows: [], kinds: [], hosts: [], days: [],
      dir: '', detail: { kv: [], ops: [], tailLines: [], tailTitle: '' },
      footerButtons: [], dangerButtons: []
    })
  }
  const rows = [...box.querySelectorAll('.audit-row')]
  const facet = title => {
    const heads = [...box.querySelectorAll('.audit-facet')]
    const hit = heads.find(h => txt(h.querySelector('.audit-facet-title')).indexOf(title) === 0)
    if (!hit) return []
    return [...hit.querySelectorAll('.audit-facet-item')].map(it => ({
      label: txt(it.querySelector('.audit-facet-label')),
      count: Number(txt(it.querySelector('.audit-facet-count'))),
      on: it.classList.contains('on')
    }))
  }
  const cell = (row, i) => txt(row.querySelectorAll('td')[i])
  return JSON.stringify({
    open: true,
    menuHasAudit,
    rowsAttr: Number(box.dataset.auditRows),
    totalAttr: Number(box.dataset.auditTotal),
    dayAttr: box.dataset.auditDay,
    rowCount: rows.length,
    rows: rows.map(r => ({
      key: r.getAttribute('data-row-key') || '',
      time: cell(r, 0),
      host: cell(r, 1),
      user: cell(r, 2),
      duration: cell(r, 3),
      kind: cell(r, 4),
      artifact: cell(r, 5),
      on: r.classList.contains('audit-row-on')
    })),
    kinds: facet('类型').concat(facet('Type')),
    hosts: facet('主机地址').concat(facet('Host')),
    days: facet('日期').concat(facet('Date')),
    dir: txt(box.querySelector('.audit-dir')),
    detail: {
      empty: !!box.querySelector('.audit-detail-empty'),
      kv: [...box.querySelectorAll('.audit-kv-row')].map(r => ({
        k: txt(r.querySelector('.audit-kv-key')),
        v: txt(r.querySelector('.audit-kv-val'))
      })),
      ops: [...box.querySelectorAll('.audit-detail-ops button')].map(b => txt(b)),
      tailTitle: txt(box.querySelector('.audit-tail-title')),
      tailLines: [...box.querySelectorAll('.audit-tail-line')].map(d => d.textContent),
      tailNote: txt(box.querySelector('.audit-tail-empty'))
    },
    // Modal 的 className 落在 .ant-modal 上，页脚在它里面，但别的弹层也有页脚：
    // 一律从 .audit-center 往上找它自己的 wrap，再在里面取按钮，不然会把邻居弹层的按钮算进来
    footerButtons: [...(box.closest('.ant-modal-root') || document)
      .querySelectorAll('.ant-modal-footer button')].map(b => txt(b)),
    dangerButtons: [...(box.closest('.ant-modal-root') || document)
      .querySelectorAll('button')].filter(b => {
      const t = txt(b)
      return /删除|删掉|Delete|delete/.test(t) || b.classList.contains('ant-btn-dangerous')
    }).map(b => txt(b)),
    onFacets: [...box.querySelectorAll('.audit-facet-item.on')]
      .map(i => txt(i.querySelector('.audit-facet-label'))),
    // 菜单是否处于展开状态（供"点条目"前判断要不要先点开）
    menuOpen: (() => {
      const p = [...document.querySelectorAll('.ant-popover')].find(x =>
        !x.classList.contains('ant-popover-hidden'))
      return !!p && p.querySelectorAll('.context-item').length > 0
    })()
  })
})()`

const snap = async cdp => JSON.parse(await cdp.eval(SNAPSHOT))

/**
 * 页内坐标：把选择器命中元素的中心算出来（真点击要走 Input 事件）
 * 带 1.5 秒等待：弹层进场时先按 0 尺寸定位、下一帧才摆好，抢在摆好之前读会得到
 * null——判据看着像"入口没渲染"，其实是脚本跑赢了动画（实测踩过一次）
 */
const centerOf = async (cdp, sel, text, settleMs = 1500) => {
  const expr = `(() => {
    // 只看真看得见的那个：antd 收起来的 popover 仍留在 DOM 里且排在前面，
    // 拿它的 rect 点下去 = 点了个 0 尺寸的空气
    const vis = e => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && !e.closest('.ant-popover-hidden') &&
        getComputedStyle(e).visibility !== 'hidden'
    }
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(vis)
    const el = ${text ? `all.find(e => e.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(zh(text))}))` : 'all[0]'}
    if (!el) return JSON.stringify(null)
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`
  for (let waited = 0; ; waited += 150) {
    const p = await cdp.jeval(expr)
    if (p || waited >= settleMs) {
      return p
    }
    await sleep(150)
  }
}

/** 点一个 .audit-facet-item（按标签文字，中/英都行），点完要确认真的选中/取消 */
const clickFacet = async (cdp, label) => {
  const find = async () => cdp.jeval(`(() => {
    const it = [...document.querySelectorAll('.audit-facet-item')].find(e =>
      e.querySelector('.audit-facet-label').textContent.trim() === ${JSON.stringify(label)})
    if (!it) return JSON.stringify(null)
    // 左栏是能滚的：候选一长，靠后的那个就落在可视区外，
    // 拿它的 rect 点下去等于点了隔壁的元素——"筛选没生效"其实是点错了地方
    it.scrollIntoView({ block: 'center' })
    const r = it.getBoundingClientRect()
    return JSON.stringify({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      on: it.classList.contains('on'),
      hit: (() => {
        const e2 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!e2 && (e2 === it || it.contains(e2))
      })()
    })
  })()`)
  const p = await find()
  if (!p) {
    return null
  }
  await sleep(120)
  await cdp.click(p.x, p.y)
  await sleep(220)
  const after = await find()
  // 点一下不算数，要读回 class：翻转了才算真选中。
  // 实测过"点了但状态没变"的一轮——不重试就会把后面整条筛选判据带进沟里
  if (after && after.on === p.on) {
    await cdp.click(p.x, p.y)
    await sleep(260)
    const retry = await find()
    return { ...p, retried: true, on: retry ? retry.on : null }
  }
  return { ...p, retried: false, on: after ? after.on : null }
}

/** 审计弹层自己页脚里的按钮（按文字）——别的弹层也有页脚，必须按归属取 */
const footBtn = async (cdp, text, settleMs = 1500) => {
  const expr = `(() => {
    const box = document.querySelector('.audit-center')
    if (!box) return JSON.stringify(null)
    const root = box.closest('.ant-modal-root') || document
    const want = ${JSON.stringify(text)}
    const norm = s => String(s).replace(/\\s+/g, '')
    const b = [...root.querySelectorAll('.ant-modal-footer button')]
      .find(x => norm(x.textContent).includes(norm(want)))
    if (!b) return JSON.stringify(null)
    const r = b.getBoundingClientRect()
    const e2 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return JSON.stringify({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      // 坐标算出来不等于点得着：筛选一变空，表格塌下去、页脚跟着上移，
      // 拿旧坐标点下去点的是别处。hit=false 就是要重新取坐标的信号
      hit: !!e2 && (e2 === b || b.contains(e2))
    })
  })()`
  for (let waited = 0; ; waited += 150) {
    const p = await cdp.jeval(expr)
    if (p || waited >= settleMs) {
      return p
    }
    await sleep(150)
  }
}

/**
 * 回放器的现场读数。
 * 画面文本只取 .xterm-rows：`.cast-player-box` 整块的 textContent 里，
 * xterm 注入的 <style> 占了 5.5 万字符，拿它做包含判断等于在样式表里找命令行——
 * 实测就是这么把"回放没画面"读成"回放没画面"的（本来就还没播）。
 */
const playerState = async cdp => cdp.jeval(`(() => {
  const p = document.querySelector('.cast-player')
  const rows = p ? p.querySelector('.cast-player-box .xterm-rows') : null
  const screen = rows ? rows.textContent : ''
  const typed = p ? p.querySelector('.cast-player-typed') : null
  return JSON.stringify({
    pos: p ? Number(p.dataset.castPos) : -1,
    written: p ? Number(p.dataset.castWritten) : -1,
    total: p ? Number(p.dataset.castTotal) : -1,
    playing: p ? p.dataset.castPlaying : null,
    speed: p ? Number(p.dataset.castSpeed) : 0,
    cmd: p ? p.dataset.castCmd : null,
    typedAttr: typed ? typed.dataset.castTyped : null,
    screenLen: screen.length,
    screenHasUp3days: screen.includes('up 3 days'),
    screenHasFs: screen.includes('Filesystem'),
    screenHasUptime: screen.includes('uptime')
  })
})()`)

/** 点时间线里第 n 行（真鼠标事件，验证 onRow 接线） */
const clickRow = async (cdp, n) => {
  const p = await cdp.jeval(`(() => {
    const r = document.querySelectorAll('.audit-center .audit-row')[${n}]
    if (!r) return JSON.stringify(null)
    const b = r.getBoundingClientRect()
    return JSON.stringify({ x: b.left + 40, y: b.top + b.height / 2 })
  })()`)
  if (!p) {
    return false
  }
  await cdp.click(p.x, p.y)
  await sleep(400)
  return true
}

const typeSearch = async (cdp, value) => {
  await cdp.jeval(`(() => {
    const i = document.querySelector('.audit-search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, ${JSON.stringify(value)})
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify(true)
  })()`)
  await sleep(320)
}

/**
 * 主进程此刻还在应答吗。
 * 判据红了要先分清"产品没渲染"和"IPC 已被吊住"，后者重启实例才能继续。
 * 挂住的原因是实测出来的：桌面产物里 vite 的 replaceWebAppPlugin 把
 * window.et.isWebApp 编译成字面量 false，download() 第一条出口（web-app 的
 * saveTextNative）在产物里根本不存在——替换 window.et 也拦不住，
 * 每次都走 chooseSaveDirectory → window.api.openDialog →
 * 主进程 dialog.showOpenDialogSync（同步！阻塞！），无头环境里没人应答。
 */
const mainAlive = async (cdp, ms = 8000) => {
  const call = cdp.eval(`window.pre.runGlobalAsync('auditOp', 'list')
    .then(r => (r && r.files || []).length)`)
  // 45 秒后那次 eval 仍会 reject；不接住就成了未处理拒绝，把进程先带走
  call.catch(() => {})
  const over = new Promise((_resolve, _reject) => setTimeout(() => _reject(new Error('ipc-timeout')), ms))
  return Promise.race([call, over])
    .then(files => ({ alive: true, files }))
    .catch(() => ({ alive: false }))
}

const shot = async (cdp, name) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
}

const main = async () => {
  const list = await getJson('http://127.0.0.1:' + PORT + '/json/list')
  const page = findPageTarget(list)
  if (!page) {
    throw new Error('no renderer page target; 实例是否带 --remote-debugging-port=' + PORT + ' 起的？')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')

  // 进门先刷新一次：这个实例是长驻的，上一轮崩在半路会把弹层/筛选/主题/导出拦截
  // 都留在页面上，而受控 Popover 点一次翻一次状态——带着别人的残留开跑，
  // 判据红了根本分不清是产品的问题还是残留状态。刷新是唯一确定的"清零"
  await cdp.call('Page.reload', { ignoreCache: true })
  const booted = await waitFor(
    cdp,
    `(() => !!window.store && typeof window.store.openAuditCenter === 'function' &&
      !!document.querySelector('.menu-control'))()`,
    'renderer booted', 40000)
  check('实例刷新后渲染层就绪（干净起点）', !!booted, { booted })
  if (!booted) {
    throw new Error('刷新后渲染层没起来，后续判据无意义')
  }
  await sleep(1500)

  // 刷新清得掉页面上的残留，清不掉主进程：上一轮点到导出会把主进程吊在
  // 同步的原生目录选择框里，这一轮 30 条判据会一起红成"产品坏了"。
  // 所以开跑前先确认 IPC 通着，不通就明确说"先重启实例"
  const alive0 = await mainAlive(cdp)
  check('开跑前主进程在应答（上一轮没把它吊住）', alive0.alive, alive0)
  if (!alive0.alive) {
    throw new Error('主进程无响应：重启 --remote-debugging-port=' + PORT + ' 的实例再跑')
  }

  check('夹具目录里有 2 个 .log + 1 个 .cast + 1 个 .txt', (() => {
    seedFixtures()
    const f = fs.readdirSync(LOGS)
    return f.filter(n => n.endsWith('.log')).length === 2 &&
      f.filter(n => n.endsWith('.cast')).length === 1 &&
      f.filter(n => n.endsWith('.txt')).length === 1
  })(), { dir: LOGS, files: fs.readdirSync(LOGS) })

  const seeded = await cdp.eval(SEED_STORE)
  check('历史/传输夹具灌进 store', seeded === 302, { seeded })

  // 1) 走真实入口：点顶栏菜单 → 点「审计中心」
  // 顶栏菜单是受控 Popover，点一次翻一次，脚本无从知道进门时它是开着还是关着，
  // 所以不猜"先关再开"——只认读回来的状态，点开为止。
  // 只看"展开着的那个 popover"里的条目，收起态的 DOM 残留不算数
  const menuHasItem = `(() => {
    const p = [...document.querySelectorAll('.ant-popover')]
      .find(x => !x.classList.contains('ant-popover-hidden'))
    return !!p && [...p.querySelectorAll('.context-item')]
      .some(i => /审计中心|Audit center/.test(i.textContent.replace(/\\s+/g, '')))
  })()`
  let menuReady = await cdp.jeval(menuHasItem)
  let menuClicks = 0
  for (let n = 0; n < 2 && !menuReady; n++) {
    const btn = await centerOf(cdp, '.menu-control')
    await cdp.click(btn.x, btn.y)
    menuClicks++
    // 弹层是异步挂载的，抢跑读快照会得到假红，所以要等
    menuReady = await waitFor(cdp, menuHasItem, 'menu item 审计中心', 4000)
  }
  const s0 = await snap(cdp)
  check('顶栏菜单里有「审计中心」条目', menuReady && s0.menuOpen && s0.menuHasAudit,
    { menuReady, menuClicks })
  const item = await centerOf(cdp, '.context-item', '审计中心')
  check('菜单条目可点击', !!item)
  if (!item) {
    throw new Error('菜单条目不可见，后面全是对空气判据')
  }
  await cdp.click(item.x, item.y)
  // 三来源合并要跨两次 IPC（列目录 + 探测），行没落地就快照等于读空数组
  const loaded = await waitFor(
    cdp,
    `(() => { const b = document.querySelector('.audit-center')
       return !!b && Number(b.dataset.auditTotal) > 0 && b.querySelectorAll('.audit-facet-item').length > 0 })()`,
    'audit rows loaded', 10000)
  check('点菜单条目真的打开弹层并读到行（store 标志位 → main.jsx 渲染链）', loaded, { loaded })
  if (!loaded) {
    throw new Error('审计中心没打开，后续判据无意义')
  }
  // 弹层的入场动画还在跑就去算 rect 并点下去，moseup 会落在别的元素上：
  // 表现为"点了候选但筛选没生效"，而判据看起来像是产品 bug
  await sleep(700)

  // 2) 三来源合并
  const s1 = await snap(cdp)
  // 主进程列的目录必须就是刚铺夹具的那一个：驱动忘了给 demo 传同一套
  // HOME/XDG_CONFIG_HOME 时，页面列的是实例的默认目录，"行数是几"就没意义了
  check('主进程列到的就是自铺的夹具目录（驱动与实例环境一致）',
    s1.rows.some(r => /play_web-1_mN4bQrT\.cast/.test(String(r.artifact))),
    { dir: s1.dir, expect: LOGS, artifacts: s1.rows.map(r => r.artifact) })
  const kindOf = label => (s1.kinds.find(k => k.label === label) || {}).count || 0
  check('类型候选四项都有行',
    kindOf('连接') + kindOf('Session') >= 3 &&
    kindOf('传输') + kindOf('Transfer') === 2 &&
    kindOf('日志') + kindOf('Log') === 2 &&
    kindOf('录制') + kindOf('Recording') === 1,
    { kinds: s1.kinds })
  check('目录里的 .txt 没进审计（只放行 .log/.cast）',
    !s1.rows.some(r => r.artifact.includes('.txt')) && !String(s1.dir).includes('.txt'),
    { dir: s1.dir })
  check('时间线按时刻倒序，无时刻的行排最后', (() => {
    const t = s1.rows.map(r => r.time).filter(x => x && x !== '—')
    const mono = t.every((x, i) => i === 0 || t[i - 1] >= x)
    return mono && s1.rows[s1.rows.length - 1].time === '—'
  })(), s1.rows.map(r => r.time))
  check('录制的时长/首条命令来自探测（不是文件名猜的）', (() => {
    const cast = s1.rows.find(r => r.artifact.includes('.cast'))
    return !!cast && cast.duration !== '—'
  })(), (s1.rows.find(r => r.artifact.includes('.cast')) || {}).duration)

  // 3) 主机筛选：解不出主机的行必须"筛了就不到场"
  const hostNames = s1.hosts.map(h => h.label)
  check('主机候选只列真实解得出的主机',
    hostNames.includes('web-1') && hostNames.includes('10.0.0.9') && !hostNames.includes('—'),
    { hostNames })
  const pWeb = await clickFacet(cdp, 'web-1')
  const s2 = await snap(cdp)
  check('筛 web-1 后每一行都是 web-1', !!pWeb && pWeb.on && s2.rows.every(r => r.host === 'web-1'),
    { pWeb, rows: s2.rows.map(r => r.host), on: s2.onFacets })
  check('筛主机时"无主机"的行不出现（宁少不假）',
    s2.rowsAttr < s1.rowsAttr && s2.rows.length === s2.rowsAttr &&
      !s2.rows.some(r => r.host === '—'),
    { before: s1.rowsAttr, after: s2.rowsAttr, on: s2.onFacets })

  // 4) 类型筛选 + 日期分桶
  await clickFacet(cdp, 'web-1')
  await clickFacet(cdp, '日志')
  const s3 = await snap(cdp)
  check('类型单选筛选生效：只剩日志行',
    s3.rows.length > 0 && s3.rows.every(r => /^(日志|Log)$/.test(zh(r.kind))),
    { kinds: s3.rows.map(r => r.kind) })
  await clickFacet(cdp, '日志')
  const dayToday = (s1.days.find(d => zh(d.label).startsWith(zh('2026'))) || s1.days[0])
  await clickFacet(cdp, dayToday.label)
  const s4 = await snap(cdp)
  check('日期分桶筛后行都落在该日',
    s4.rows.length > 0 && s4.rows.every(r => r.time.startsWith(dayToday.label)),
    { day: s4.dayAttr, rows: s4.rows.map(r => r.time) })
  const noTime = s1.days.find(d => /无时刻|No timestamp/.test(d.label))
  check('无时刻的行单独成桶（不为对齐把未知当 0）', !!noTime && noTime.count === 1,
    { days: s1.days.map(d => d.label + '=' + d.count) })
  const resetBtn = await centerOf(cdp, '.audit-filter-foot button')
  await cdp.click(resetBtn.x, resetBtn.y)
  await sleep(220)
  const s5 = await snap(cdp)
  check('重置把筛选全部放开', s5.rowsAttr === s1.rowsAttr && s5.dayAttr === '',
    { rows: s5.rowsAttr, total: s5.totalAttr, day: s5.dayAttr })

  // 5) 关键字命中录制详情里的首条命令
  await typeSearch(cdp, 'uptime')
  const s6 = await snap(cdp)
  check('关键字命中录制的首条命令（探测真的进了详情）',
    s6.rows.length === 1 && s6.rows[0].artifact.includes('.cast'),
    { rows: s6.rows.map(r => r.artifact) })
  await typeSearch(cdp, '')

  // 6) 选中 .log 行 → 尾部 500 行 + ANSI 已剥 + 窗口省略数如实
  const logIdx = (await snap(cdp)).rows.findIndex(r => r.artifact.includes('build_dp'))
  check('长日志行在场', logIdx >= 0, { logIdx })
  await clickRow(cdp, logIdx)
  await waitFor(cdp, `(() => {
    const b = document.querySelector('.audit-center')
    return b && b.querySelectorAll('.audit-tail-line').length > 0
  })()`, 'log tail', 8000)
  const s7 = await snap(cdp)
  const tail = s7.detail.tailLines
  check('选中日志行后右栏读到尾部 500 行', tail.length === 500, { lines: tail.length })
  check('尾部已剥 ANSI（界面上不该看见转义残骸）',
    tail.length > 0 && tail.every(l => !l.includes('\u001b[') && !l.includes('[32m')),
    { sample: tail.slice(0, 2) })
  check('窗口切掉的行数如实报出（不假装读全了）',
    /1200|700|未读|omitted/.test(zh(s7.detail.tailTitle)), { tailTitle: s7.detail.tailTitle })
  check('详情栏字段齐全（主机/用户/连接方式/时长/产物）', (() => {
    const ks = s7.detail.kv.map(r => zh(r.k))
    return ks.some(k => k.startsWith('主机')) && ks.some(k => k.startsWith('用户')) &&
      ks.some(k => k.startsWith('连接方式')) && ks.some(k => k.startsWith('时长')) &&
      ks.some(k => k.startsWith('产物'))
  })(), s7.detail.kv.map(r => r.k + '=' + r.v))
  await shot(cdp, '1-log-tail-dark.png')

  // 7) 选中 .cast 行 → 起回放器
  const s8 = await snap(cdp)
  const castIdx = s8.rows.findIndex(r => r.artifact.includes('.cast'))
  await clickRow(cdp, castIdx)
  const s9 = await snap(cdp)
  // antd 给两个汉字的按钮中间塞了个空格（"回 放"），比对前先去掉空白
  check('选中录制行出现「回放」入口',
    s9.detail.ops.some(t => /回放|Replay/.test(zh(t))), { ops: s9.detail.ops })
  const replay = await centerOf(cdp, '.audit-detail-ops button', '回放')
  if (!replay) {
    throw new Error('「回放」入口读不到坐标，回放段判据无意义')
  }
  await cdp.click(replay.x, replay.y)
  // 回放器要等一次 readRecording IPC + 异步建 xterm，弹层先转圈
  const opened = await waitFor(cdp, `(() => { const p = document.querySelector('.cast-player')
    return !!p && !p.querySelector('.cast-player-loading') && Number(p.dataset.castTotal) > 0 })()`,
  'cast player ready', 15000)
  const p0 = await playerState(cdp)
  check('回放器打开并解析到录制事件', opened && p0.total === 7 && p0.written === 0, p0)
  // 默认 1x 要放满 6 秒。先把时钟拨到 4x 再起播：判据等的是"事件真的写进终端"，
  // 不是"测试脚本愿意睡几秒"
  const speed4 = await centerOf(cdp, '.cast-player-speeds button', '4x')
  await cdp.click(speed4.x, speed4.y)
  await sleep(200)
  const playBtn = await centerOf(cdp, '.cast-player-bar button', '播放')
  await cdp.click(playBtn.x, playBtn.y)
  // 播到第一条命令敲下回车的那一刻：徽标该显示它，而终端画面里不该有它——
  // 录制当时输入没上屏，回放给它"回显"就是假画面。
  // 放完后 data-cast-cmd 会变成最后一条（df -h），所以要在中途读
  const atUptime = await waitFor(cdp, `(() => { const p = document.querySelector('.cast-player')
    return !!p && p.dataset.castCmd === 'uptime' })()`, 'uptime badge mid-play', 8000)
  const pMid = await playerState(cdp)
  check('输入事件画成徽标而不是假回显',
    atUptime && pMid.typedAttr === 'uptime' && !pMid.screenHasUptime,
    { atUptime, cmd: pMid.cmd, typedAttr: pMid.typedAttr, screenHasUptime: pMid.screenHasUptime })
  const done = await waitFor(cdp, `(() => { const p = document.querySelector('.cast-player')
    return !!p && Number(p.dataset.castWritten) >= 4 && p.dataset.castPlaying === '0' })()`,
  'cast finished', 15000)
  await sleep(400)
  const p1 = await playerState(cdp)
  check('按下 4x 起播后录制的输出真的画进了终端',
    done && p1.written === 4 && p1.pos === 6000 && p1.screenHasUp3days && p1.screenHasFs, p1)
  // 徽标跟着虚拟时钟走：放到最后，它就该是录制里最后敲的那条
  check('输入徽标跟着时钟走到最后一条命令',
    p1.cmd === 'df -h' && p1.typedAttr === 'df -h' && !p1.screenHasUptime,
    { cmd: p1.cmd, typedAttr: p1.typedAttr, screenHasUptime: p1.screenHasUptime })
  await shot(cdp, '2-cast-player-dark.png')
  // 只关回放器自己那个弹层：`.ant-modal-close` 全局第一个可能是审计中心自己的关闭键，
  // 点错会把主弹层一起关掉，后面的页脚判据全变成对空气
  const closedPlayer = await cdp.jeval(`(() => {
    const box = document.querySelector('.cast-player-box')
    if (!box) return JSON.stringify(false)
    const root = box.closest('.ant-modal-root') || box.closest('.ant-modal-wrap')
    const b = root && root.querySelector('.ant-modal-close')
    if (!b) return JSON.stringify(false)
    b.click()
    return JSON.stringify(true)
  })()`)
  check('关掉的是回放器自己的弹层', !!closedPlayer, { closedPlayer })
  await sleep(500)
  const stillOpen = await cdp.jeval(`(() =>
    JSON.stringify(!!document.querySelector('.audit-center')))()`)
  check('回放器关了，审计中心还在', !!stillOpen, { stillOpen })

  // 8) 导出的两半：先验不碰弹窗的那半
  const s10 = await snap(cdp)
  check('导出按钮在底部（CSV + Markdown）',
    s10.footerButtons.some(t => /CSV/.test(t)) && s10.footerButtons.some(t => /Markdown|MD/.test(t)),
    { footerButtons: s10.footerButtons })
  const csvBtn = await footBtn(cdp, 'CSV')
  check('CSV 按钮可点', !!csvBtn)
  if (!csvBtn) {
    throw new Error('找不到审计弹层自己的页脚按钮')
  }
  // 空数据闸门：筛到一行不剩再点导出，应该只提示"无数据"，
  // 既不发起 download()（按钮不进 loading），更不能把主进程吊住
  await typeSearch(cdp, '不可能命中的关键字zzz')
  const s11 = await snap(cdp)
  check('筛到空后计数与行一起归零', s11.rowsAttr === 0 && s11.rowCount === 0,
    { rowsAttr: s11.rowsAttr, rowCount: s11.rowCount })
  // 坐标要在筛选之后再取：表格塌成空态会把页脚整个上移，旧坐标点到的是空气
  const emptyCsvBtn = await footBtn(cdp, 'CSV')
  await cdp.click(emptyCsvBtn.x, emptyCsvBtn.y)
  await sleep(600)
  const guarded = await cdp.jeval(`(() => {
    const norm = s => String(s).replace(/\\s+/g, '')
    const notice = [...document.querySelectorAll(
      '.message-item, .ant-message-notice-content, .ant-message-notice-title')]
      .map(n => norm(n.textContent)).join('|')
    const box = document.querySelector('.audit-center')
    const root = box ? (box.closest('.ant-modal-root') || document) : document
    const loading = [...root.querySelectorAll('.ant-modal-footer button')]
      .filter(b => b.className.includes('loading')).map(b => norm(b.textContent))
    return JSON.stringify({ notice, loading })
  })()`)
  const alive1 = await mainAlive(cdp)
  check('空数据点导出只提示「无数据」，不发起下载',
    emptyCsvBtn.hit && /无数据/.test(zh(guarded.notice)) &&
      guarded.loading.length === 0 && alive1.alive,
    { emptyCsvBtn, guarded, alive1 })
  // 放开筛选，让后面的判据面对"有行"的正常态
  const backBtn = await centerOf(cdp, '.audit-filter-foot button')
  await cdp.click(backBtn.x, backBtn.y)
  await sleep(500)

  // 9) 只读口径：没有删除入口
  const s12 = await snap(cdp)
  check('弹层内没有任何删除/危险按钮（审计视图只给"看"）',
    s12.dangerButtons.length === 0, { dangerButtons: s12.dangerButtons })

  // 10) 浅色主题 + 关闭
  await cdp.eval(`(() => {
    window.store.updateConfig({ theme: 'light' })
    return true
  })()`)
  await sleep(1200)
  await shot(cdp, '3-light-log-tail.png')
  await cdp.eval(`(() => {
    window.store.updateConfig({ theme: 'dark' })
    return true
  })()`)
  await sleep(1000)
  const closeBtn = await footBtn(cdp, '关闭')
  await cdp.click(closeBtn.x, closeBtn.y)
  await sleep(500)
  const gone = await cdp.eval(`(() => !document.querySelector('.audit-center') &&
    window.store.showAuditCenter !== true)()`)
  check('关闭后弹层卸载且标志位复位', !!gone)

  // 11) 真点一次导出，放在所有判据之后：它必然弹原生目录选择框，
  //     主进程那边的 showOpenDialogSync 是同步阻塞的，无头环境没人应答——
  //     点完这个实例就废了（实测 auditOp/getGlobalState 全部无响应，只能重启）。
  //     所以这一步只认"按钮进了 loading"这一个事实：它证明 doExport 过了闸门、
  //     真的把 download() 发起了。CSV/MD 的字节口径由
  //     src/test/unit-ci/audit-model.spec.js 的「G8 导出」负责，不靠弹窗赌运气。
  await cdp.eval(`(() => {
    window.store.openAuditCenter()
    return true
  })()`)
  const reopened = await waitFor(cdp, `(() => { const b = document.querySelector('.audit-center')
    return !!b && Number(b.dataset.auditTotal) > 0 })()`, 'audit reopened', 15000)
  check('关掉后能再次打开（入口是可复用的）', reopened)
  await sleep(400)
  const csvBtn2 = await footBtn(cdp, 'CSV')
  await cdp.click(csvBtn2.x, csvBtn2.y)
  await sleep(700)
  const exporting = await cdp.jeval(`(() => {
    const box = document.querySelector('.audit-center')
    const root = box ? (box.closest('.ant-modal-root') || document) : document
    return JSON.stringify([...root.querySelectorAll('.ant-modal-footer button')]
      .filter(b => b.className.includes('loading')).map(b => String(b.textContent).replace(/\\s+/g, '')))
  })()`)
  check('真有行时点导出会进入下载中（按钮转圈）', exporting.length === 1, { exporting })
  const alive2 = await mainAlive(cdp, 5000)
  console.log('NOTE 导出后主进程应答: ' + JSON.stringify(alive2) +
    '（无头环境弹框无人应答，属环境限制；本轮到此结束，重启实例才能再跑）')

  // 页内异常一并打印：判据红了要能分清"产品崩了"和"夹具没到位"
  if (cdp.events.length) {
    console.log('PAGE EVENTS: ' + cdp.tail(10).join(' | '))
  }
  await cdp.call('Runtime.disable').catch(() => {})
  cdp.ws.close()

  const fail = results.filter(r => !r.ok).length
  console.log('\n' + (results.length - fail) + '/' + results.length + ' PASS')
  // 必须显式退出：留着 WebSocket，下一轮自测会和这一轮的点击打在同一个页面上互踩
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error('DEMO ERROR: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
