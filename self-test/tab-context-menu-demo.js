#!/usr/bin/env node
/**
 * P-8 tab 右键菜单 —— CDP 实机（setColor 色卡 / 清除色 / 批量关闭收尾 / reopenClosedTab）
 *
 * 两轮口径：
 *   第一轮（2026-11-05 上午，"只收口，不动产品"）把已提交的 closeTabsLeft /
 *   closeAllTabs / setColor / reopenClosedTab 钉在真实 DOM 与真实 store 上，
 *   顺带发现五处缺口，按"现状钉子"记在这里。
 *   第二轮（2026-11-05 下午，用户拍板"修掉那 5 处 + 色卡复用创建时那张"）：
 *     ① setColor 复用书签创建那张色卡（24 色 + random + hex 输入），点色点即上色，
 *        设过色后菜单出现"清除页签颜色"，清除回到默认色；
 *     ② 批量关闭（右侧/左侧/其他/全部）逐条过 txCloseGuards，取消即停止后续；
 *     ③ 批量关闭接上 autoCloseEmptyPane（空窗格自己收起）；
 *     ④ 窗格被关光后该窗格的活动指针置空，不留悬空 id；
 *     ⑤ onContextMenu 的 this[key]() 有兜底，全程零未捕获异常。
 *   所以下面的判据钉的是**修好之后的样子**：哪条红了，就是那处退化回去了。
 *   卡片本身是从书签创建表单里抽出来的（components/common/color-card.jsx），
 *   H 段再把那个**原入口**跑一遍：抽走之后书签、分类、主题这几处共用同一张卡的
 *   地方不能坏，而且这一版刻意改了口径——拖动高级取色器时卡片不再一动就收起。
 *
 * 为什么必须实机（源码契约与纯函数单测替代不了）：
 *   1) 菜单项会不会出现是 renderContext() 的门控（index>0 / noRight / 栈非空 /
 *      有没有设过色），只有真页签列表 + 真右键才知道它会不会自己收掉；
 *   2) 色卡是 Popover 里再套 antd 取色器 + hex 输入，菜单一点就关、卡片必须活下来；
 *      点色点要真的落到 tab.color、真的把 .tab-count 那颗徽标上成那个色、
 *      深浅色底配白/黑字（isDark），这一整条链路只有浏览器里的 antd 能给答案；
 *   3) 批量关闭现在是"守卫 → removeTabs → 收空窗格 → 收敛广播"的异步链路：
 *      连接有没有真被释放（closeDbTab 计数）、closedTabs 压栈顺序对不对、
 *      活动页签指针会不会悬空、分屏后会不会误伤别的窗格，都得跑真 store；
 *   4) reopenClosedTab 的五条关闭路径（×、关闭右侧、关闭其他、关闭左侧、关闭全部）
 *      是否**都**压栈，只有真点才作数。
 *
 * ⚠️ 本脚本临时替换 window.pre.runGlobalAsync（假库层，绝不真连接）、
 *    增删 store.tabs / store.closedTabs、挂 txCloseGuards 夹具、改 layout 与主题，
 *    收尾全部还原并 reload。
 *
 * 隔离：自建临时 HOME / XDG_CONFIG_HOME / DATA_PATH / TMPDIR，自起自收实例
 *      （只按 spawn 出去的进程组下杀手，绝不按端口或 pkill 模式匹配）。
 *
 * 用法：
 *   1) 渲染层改过要 npm run compile；改到 src/app/**（主进程、含 locales-extra 词条）
 *      还要 cp -r src/app/. work/app/ —— compile 只重建 assets，不碰 work/app 里那份
 *      主进程拷贝。上一轮就是栽在这：新加的 clearTabColor 在界面上显示成 "ClearTabColor"
 *      （translate() 缺词条回退成 key 再首字母大写），所以下面有一条直接查语言包表的判据。
 *   2) Xvfb <display> 起好（默认 :131）
 *   3) node self-test/tab-context-menu-demo.js [display] [port] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':131'
const PORT = process.argv[3] || '9361'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/2026-11-05-p8-tab-menu-shots')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-p8-tabmenu-'))
const LOG_FILE = path.join(RUN, 'app.log')
let childPid = null

const TAG = 'p8tab' + String(Date.now()).slice(-6)
// 色卡清单从源头读：判据要能问"界面上摆出来的就是这 24 个 + random"，
// 而不是把色值抄第二遍（抄第二遍的话改色卡时这条判据不会跟着响）
const PALETTE_SRC = fs.readFileSync(
  path.join(ROOT, 'src/client/common/rand-hex-color.js'), 'utf8'
)
const PALETTE = ((PALETTE_SRC.match(/const defaultColors = \[([\s\S]*?)\]/) || ['', ''])[1]
  .match(/'#[0-9a-fA-F]{6}'/g) || []).map(s => s.replace(/'/g, ''))
const defaultTabColor = ((fs.readFileSync(
  path.join(ROOT, 'src/client/components/tabs/tab.jsx'), 'utf8'
).match(/const defaultTabColor = '(#[0-9a-fA-F]{6})'/) || ['', '#0088cc'])[1])
// 界面上的 computed 值只认 "rgb(r, g, b)"，源码里那颗是 hex —— 换算一次，判据不写死
const hexToRgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')'
const defaultBadgeBg = hexToRgb(defaultTabColor)

const J = v => JSON.stringify(v)
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300)))
}
const info = (name, detail) => {
  console.log('INFO  ' + name + ' :: ' + JSON.stringify(detail).slice(0, 300))
}
const brief = o => JSON.stringify(o).slice(0, 300)

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = {
    ...process.env,
    DISPLAY,
    HOME: path.join(RUN, 'home'),
    XDG_CONFIG_HOME: path.join(RUN, 'config'),
    TMPDIR: path.join(RUN, 'tmp'),
    DATA_PATH: path.join(RUN, 'data')
  }
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn('dbus-run-session', ['--',
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    'work/app/app.js',
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  child.unref()
  childPid = child.pid
  return child
}

function cleanupOrphan () {
  if (!childPid) return
  try { process.kill(-childPid, 'SIGTERM') } catch (e) { /* 已经没了 */ }
}

function die (why) {
  cleanupOrphan()
  console.error('FATAL ' + why)
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n')
      .filter(l => !/dbus-daemon|xdg-desktop-portal|fusermount/.test(l))
    console.error('主进程日志尾巴：\n' + tail.slice(-20).join('\n'))
  } catch (e) {
    console.error('日志读不出来：' + e.message)
  }
  if (process.env.KEEP_TMP) {
    console.error('临时目录保留以便排查：' + RUN)
  } else {
    try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e) {
      console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
    }
  }
}

/**
 * 只杀自己起的进程组（detached），且先确认那条命令行确实是本 lane 的实例。
 * 上一批次的纪律：kill 逻辑写在脚本文件里，绝不和启动命令挤同一条 shell 调用。
 */
function killInstance () {
  if (!childPid) return Promise.resolve()
  try {
    const cmd = fs.readFileSync('/proc/' + childPid + '/cmdline', 'utf8')
    if (cmd.indexOf('dbus-run-session') < 0) {
      console.error('pid ' + childPid + ' 已经不是本 lane 的 dbus-run-session，不动它')
      return Promise.resolve()
    }
  } catch (e) { /* 进程已经没了 */ }
  try { process.kill(-childPid, 'SIGTERM') } catch (e) {
    try { process.kill(childPid, 'SIGTERM') } catch (e2) {}
  }
  return sleep(2000)
}

async function waitCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const page = list && findPageTarget(list)
    if (page) {
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      await cdp.call('Log.enable', {})
      cdp.events.length = 0
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

// 上一轮的实例没清干净时，这个端口会**秒答** /json/version，于是这一轮连上的是旧实例的
// 旧页面：没装替身、store 也不是这一轮的，判据成片红或干脆挂在半路（实机连着踩过两轮）。
// 起实例前先验端口是空的，脏就当场喊出来，别往下跑出假现场。
async function assertPortIdle () {
  const v = await getJson('http://127.0.0.1:' + PORT + '/json/version').catch(() => null)
  if (!v) return
  throw new Error('端口 ' + PORT + ' 上已经有实例在跑（' + (v.Browser || '未知') + '）—— ' +
    '接着连会连到那一轮的旧页面。先清掉：kill $(pgrep -f "remote-debugging-port=' + PORT + '")')
}

// 假库层：开/关 database 页签都不真连，只记账（关页签的资源释放判据要吃这个计数）
const STUB = `(() => {
  window.__calls = { closeDbTab: [], openDbTab: [] }
  const real = window.pre && window.pre.runGlobalAsync
  window.__realRunGlobalAsync = real
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'closeDbTab') { window.__calls.closeDbTab.push(String(a[0])); return Promise.resolve(null) }
    if (name === 'openDbTab') { window.__calls.openDbTab.push(String(a[0])); return Promise.resolve({ ok: true }) }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'dbClientOp') {
      const op = a[1]
      if (op === 'getMetadata') return Promise.resolve([])
      if (op === 'getTableStructure') return Promise.resolve({ columns: [], foreignKeys: [] })
      if (op === 'countRows') return Promise.resolve({ count: 0 })
      if (op === 'getPageData') return Promise.resolve({ rows: [], totalRows: 0, hasMore: false })
      return Promise.resolve(null)
    }
    return Promise.resolve(null)
  }
  return 'stub-installed'
})()`

// 运行时探针：标签文案一律从界面自己的 translate() 取，判据不写死中英文
const PROBE = `(() => {
  window.__L = k => String((window.translate && window.translate(k)) || k)
  // 词条在不在语言包里 —— translate() 缺词条时回退成 key 原文（再首字母大写），
  // 界面上就是 "ClearTabColor" 那种；判据若跟着 __L 的返回值自比就会假绿，所以直接查表
  window.__hasKey = k => {
    const lang = (window.getLang && window.getLang()) || null
    return !!(lang && Object.prototype.hasOwnProperty.call(lang, k))
  }
  window.__flat = s => String(s == null ? '' : s).replace(/\\s/g, '').toLowerCase()
  window.__rendered = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      n = n.parentElement
    }
    return !!el.getBoundingClientRect().width
  }
  window.__vis = el => {
    if (!window.__rendered(el)) return false
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
  }
  window.__reveal = el => {
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' })
    return el
  }
  // 页签：按窗格（batch）取，分屏时两个窗格各数各的
  window.__tabEls = b => Array.from(
    document.querySelectorAll(b === undefined ? '.tab' : '.v' + (b + 1) + ' .tab')
  ).filter(window.__rendered)
  window.__tabsOf = b => window.__tabEls(b).map(el => {
    const id = el.getAttribute('data-id')
    const badge = el.querySelector('.tab-count')
    const cs = badge ? getComputedStyle(badge) : null
    // 20 多条页签时最右侧会被挤出可视区：先滚过来再取坐标，
    // 否则点出去的是一个屏幕外的坐标，判据会把它读成"菜单没出现"
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' })
    return {
      id,
      title: ((window.store.tabs.find(t => String(t.id) === id) || {}).title) || '',
      xy: window.__xy(el),
      badgeBg: cs ? cs.backgroundColor : null,
      badgeColor: cs ? cs.color : null,
      hasBadge: !!badge
    }
  })
  window.__store = () => {
    const s = window.store
    const num = k => s[k] === undefined ? null : String(s[k])
    return {
      layout: String(s.layout),
      activeTabId: num('activeTabId'),
      // 按窗格位取下标（不过滤 null）：判据要能问"窗格 2 的指针还在不在原来那条上"
      batchActive: [0, 1, 2, 3].map(b => num('activeTabId' + b)),
      tabs: s.tabs.map(t => ({
        id: String(t.id),
        title: String(t.title || ''),
        host: String(t.host || ''),
        batch: Number(t.batch),
        color: t.color === undefined ? null : String(t.color),
        status: String(t.status || '')
      })),
      closed: (s.closedTabs || []).map(t => ({
        title: String(t.title || ''),
        host: String(t.host || ''),
        // 快照不该带运行时字段（重开时由 addTab 重新补）
        leaked: ['id', 'batch', 'pane', 'tabCount', 'status'].filter(k => t[k] !== undefined)
      })),
      calls: window.__calls || { closeDbTab: [], openDbTab: [] },
      guardHits: (window.__guardHits || []).slice(),
      configLayoutAuto: s.config && s.config.autoCloseEmptyPane
    }
  }
  // 右键菜单（antd Dropdown 的 portal）
  // 注意：菜单项的坐标一律直接取 rect，不走 __reveal —— 菜单是 fixed 定位的 portal，
  // scrollIntoView 会去滚外层容器，把刚量到的点挪走（点了个空处，菜单自己先关了）
  // 页面上可能同时挂着好几个 .ant-dropdown（每个页签自己一个 Dropdown portal、别的菜单也是），
  // 只按 DOM 顺序取第一个，会量到"上一个还没收干净的那份"的坐标 —— 点下去落在别处，
  // 判据就红成"功能没生效"。所以按 __anchor（刚刚右键的那个点）由近到远排。
  window.__anchor = null
  window.__menus = () => {
    const list = Array.from(document.querySelectorAll('.ant-dropdown')).filter(window.__rendered)
    const a = window.__anchor
    if (!a) return list
    return list.map(m => {
      const r = m.getBoundingClientRect()
      return { m, d: Math.hypot(r.left + r.width / 2 - a.x, r.top + Math.min(r.height / 2, 60) - a.y) }
    }).sort((x, y) => x.d - y.d).map(x => x.m)
  }
  window.__menuItems = () => window.__menus().flatMap(m =>
    Array.from(m.querySelectorAll('li')).filter(window.__rendered).map(li => {
      return {
        text: String(li.innerText || '').replace(/\\s+/g, ' ').trim(),
        flat: window.__flat(li.innerText),
        xy: window.__xy(li),
        labelXy: window.__xy(li.querySelector('.ant-dropdown-menu-title-content') || li),
        // 菜单项最前面的图标：走到 onContextMenu 的那条路都从这儿进
        iconXy: (() => {
          const ic = li.querySelector('.ant-dropdown-menu-item-icon') ||
            li.querySelector(':scope > .anticon')
          return ic ? Object.assign({ cls: String(ic.className) }, window.__xy(ic)) : null
        })()
      }
    })
  )
  window.__itemByText = lab => {
    const f = window.__flat(lab)
    return window.__menuItems().find(i => i.flat.indexOf(f) >= 0) || null
  }
  // 菜单行尾那颗色块：既要看它"在不在、色对不对"，也要在点击这一刻量出矩形 ——
  // 色卡就是照这个坐标弹到行旁边的，量不到就会退回弹在页签底下。
  window.__swatchXy = () => {
    const el = Array.from(document.querySelectorAll('.ant-dropdown .tab-context-color-swatch'))
      .find(x => {
        const dd = x.closest('.ant-dropdown')
        return dd && !/ant-dropdown-hidden/.test(String(dd.className)) && window.__rendered(x)
      })
    if (!el) return null
    const r = el.getBoundingClientRect()
    const xy = window.__xy(el)
    const top = document.elementFromPoint(xy.x, xy.y)
    return {
      bg: getComputedStyle(el).backgroundColor,
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      hit: !!top && (el.contains(top) || top.contains(el))
    }
  }
  window.__menuOpen = () => window.__menus().length > 0
  // 现场取证：几个候选菜单、各自的位置与首项（跨窗格那组判据红了就靠它定位是哪份菜单被读了）
  window.__menuDebug = () => Array.from(document.querySelectorAll('.ant-dropdown')).map(m => {
    const r = m.getBoundingClientRect()
    const first = m.querySelector('li')
    return {
      hidden: /ant-dropdown-hidden/.test(String(m.className)),
      rendered: window.__rendered(m),
      r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      items: Array.from(m.querySelectorAll('li')).filter(window.__rendered).length,
      first: first ? String(first.innerText).replace(/\\s+/g, ' ').trim().slice(0, 16) : ''
    }
  })
  // 色卡：菜单关掉后卡片必须还活着，所以它是页签自己那个 Popover（portal 到 body），
  // 不是菜单项里的东西。认根只认"里面真有 .color-picker-box"那一份 —— 书签表单用的
  // 是同一张卡，判据要抓的就是这张共用的卡，不管它挂在谁身上。
  window.__cardRoot = () => {
    const box = Array.from(document.querySelectorAll('.ant-popover'))
      .find(x => !/ant-popover-hidden/.test(String(x.className)) && x.querySelector('.color-picker-box'))
    return box && window.__rendered(box.querySelector('.color-picker-box')) ? box : null
  }
  window.__cardOpen = () => {
    const root = window.__cardRoot()
    if (!root) return false
    const r = root.querySelector('.color-picker-box').getBoundingClientRect()
    return r.width > 60 && r.height > 40
  }
  window.__cardRect = () => {
    const root = window.__cardRoot()
    if (!root) return null
    const r = root.querySelector('.color-picker-box').getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  }
  // 色点：一个 .color-picker-unit 一个，文案就是 "● #rrggbb"，random 那颗写 "● random"
  window.__cardChips = () => {
    const root = window.__cardRoot()
    if (!root) return []
    return Array.from(root.querySelectorAll('.color-picker-unit')).filter(window.__rendered).map(el => {
      const xy = window.__xy(el)
      const top = document.elementFromPoint(xy.x, xy.y)
      return {
        text: String(el.innerText || '').replace(/\\s+/g, ' ').trim(),
        colorStyle: String(el.style.color || ''),
        xy,
        hit: !!top && (el.contains(top) || top.contains(el))
      }
    })
  }
  window.__chipByHex = hex => {
    const f = String(hex).toLowerCase()
    return window.__cardChips().find(c => c.text.toLowerCase().indexOf(f) >= 0) || null
  }
  // 卡片里自己的 hex 输入（HexInput，不是 antd 取色器面板里那个）：值不带 #，前缀是另一个 span
  window.__cardHex = () => {
    const root = window.__cardRoot()
    if (!root) return null
    const el = Array.from(root.querySelectorAll('.color-picker-box input'))
      .find(i => i.getBoundingClientRect().width > 4)
    if (!el) return null
    const xy = window.__xy(el)
    return { value: String(el.value), cls: String(el.className), xy }
  }
  // hex 只有点后缀那个 ✓ 才提交（回车不提交）；而 ✓ 只在凑满 6 位十六进制时才出现
  window.__cardHexSubmitXy = () => {
    const root = window.__cardRoot()
    if (!root) return null
    const ok = root.querySelector('.ant-input-suffix .anticon-check') || root.querySelector('.anticon-check')
    return ok && window.__rendered(ok) ? window.__xy(ok) : null
  }
  // 卡片右上角那个可拖动的高级取色器触发块（在卡片里面，不在菜单里）
  window.__cardPickerXy = () => {
    const root = window.__cardRoot()
    const t = root && root.querySelector('.color-picker-box .ant-color-picker-trigger')
    if (!t) return null
    const xy = window.__xy(t)
    if (xy.w < 8 || xy.h < 8) return null
    const top = document.elementFromPoint(xy.x, xy.y)
    return Object.assign({ hit: !!top && (t.contains(top) || top === t) }, xy)
  }
  // antd 取色器自己的弹层：根是 body portal 上的 .ant-popover.ant-color-picker。
  // 找它不看它自己的 rect（antd 的 popover 根是定位壳，宽高可能是 0，尺寸都在里面那层），
  // 只看"没被隐藏 + 类名带 color-picker + 里面真有画布面板"。
  window.__panelRoot = () => Array.from(document.querySelectorAll('.ant-popover'))
    .find(x => !/ant-popover-hidden/.test(String(x.className)) &&
      /ant-color-picker/.test(String(x.className)) && !!x.querySelector('.ant-color-picker-panel')) || null
  window.__panelOpen = () => {
    const p = window.__panelRoot()
    if (!p) return false
    const pan = p.querySelector('.ant-color-picker-panel')
    const r = pan.getBoundingClientRect()
    return r.width > 8 || [...p.querySelectorAll('input')].some(i => i.getBoundingClientRect().width > 4)
  }
  // 卡片没按预期取到时的一次性现场取证（省得再猜选择器）
  window.__cardDump = () => ({
    popovers: Array.from(document.querySelectorAll('.ant-popover')).map(x => {
      const r = x.getBoundingClientRect()
      return {
        cls: String(x.className).replace(/css-[a-z0-9]+/g, '').slice(0, 70),
        r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        card: !!x.querySelector('.color-picker-box'),
        chips: x.querySelectorAll('.color-picker-unit').length
      }
    }),
    units: document.querySelectorAll('.color-picker-unit').length
  })
  window.__closeXy = id => {
    const el = document.querySelector('.tab[data-id="' + id + '"] .tab-close')
    return el && window.__rendered(el) ? window.__xy(el) : null
  }
  window.__badge = id => {
    const el = document.querySelector('.tab[data-id="' + id + '"] .tab-count')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, color: cs.color, text: String(el.innerText || '').trim() }
  }
  // 书签表单里那颗触发色块（色卡原来的入口）。限定在 .form-wrap 里：
  // 书签树上的分类色块用的是同一个 ColorPicker，不限定会点错人
  window.__bkChoose = () => {
    const list = Array.from(document.querySelectorAll('.form-wrap .color-picker-choose'))
      .filter(window.__rendered)
      .map(el => {
        const xy = window.__xy(el)
        const top = document.elementFromPoint(xy.x, xy.y)
        return Object.assign({
          bg: getComputedStyle(el).backgroundColor,
          hit: !!top && (el.contains(top) || top.contains(el))
        }, xy)
      })
    return { n: list.length, first: list[0] || null, pick: list.find(i => i.hit) || null }
  }
  window.__bkCount = () => window.store.bookmarks.length
  window.__clearAll = () => {
    const s = window.store
    // 夹具里挂过的事务守卫要一起摘：否则清场时 delTab 被守卫按回，页签关不掉
    s.txCloseGuards = {}
    s.tabs.slice().forEach(t => s.delTab(String(t.id)))
    s.closedTabs = []
    return s.tabs.length
  }
  window.__mkTab = (title, host) => {
    const before = window.store.tabs.map(t => String(t.id))
    window.store.addTab({
      type: 'database',
      from: 'quick-connect',
      title,
      dbType: 'mysql',
      dbHost: host,
      dbPort: 3306,
      dbUser: 'p8',
      dbPassword: '',
      dbName: ${J(TAG + '_db')},
      dbSsl: false,
      readOnly: true,
      production: false,
      host,
      port: 22,
      username: 'p8',
      batch: window.store.currentLayoutBatch
    })
    const created = window.store.tabs.find(t => before.indexOf(String(t.id)) < 0)
    if (created) window.store.changeActiveTabId(created.id)
    return created ? String(created.id) : ''
  }
  window.__mkLocal = title => {
    const before = window.store.tabs.map(t => String(t.id))
    window.store.addTab({ type: 'local', title, batch: window.store.currentLayoutBatch })
    const created = window.store.tabs.find(t => before.indexOf(String(t.id)) < 0)
    return created ? String(created.id) : ''
  }
  return 'probe-installed'
})()`

const rightClick = async (cdp, x, y) => {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
}

const pressKey = async (cdp, params) => {
  await cdp.call('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, params))
  await cdp.call('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, params))
}

const main = async () => {
  await assertPortIdle()
  launch()
  const cdp = await waitCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // 先等应用自己起来，再重载一次跑最新产物：
  // 首屏还在拉 chunk 时插 Page.reload 会换来一发 404 且页面再也起不来（bookmark-dedup 踩过）
  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(cdp, readyExpr, '应用未就绪（store/translate 没等到）', 60000)) {
    throw new Error('实例起来了但渲染层没就绪：' + brief(await cdp.tail(8)))
  }
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, readyExpr, '重载后 store 仍不在包里', 60000)) {
    throw new Error('重载后仍未就绪：' + brief(await cdp.tail(8)))
  }
  await sleep(2500)

  const snapBefore = await cdp.jeval(`(() => {
    const s = window.store
    return {
      layout: String(s.layout),
      autoCloseEmptyPane: !!(s.config || {}).autoCloseEmptyPane,
      theme: (s._config || {}).theme,
      tabCount: s.tabs.length,
      closedCount: (s.closedTabs || []).length
    }
  })()`)
  check('实例起来、渲染层就绪（真 store + 真 translate）', true, snapBefore)
  check('假库层与探针装好',
    await cdp.eval(STUB) === 'stub-installed' && await cdp.eval(PROBE) === 'probe-installed')

  // 现场清场：所有页签关掉、栈清空
  await cdp.eval('window.__clearAll()')
  await sleep(1500)
  await cdp.eval('window.__clearAll()')
  await sleep(800)
  if (!await waitFor(cdp, 'window.store.tabs.length === 0', '清场后仍有页签', 15000)) {
    throw new Error('清场失败：' + brief(await cdp.eval('window.__store()')))
  }

  const st = () => cdp.jeval('window.__store()')
  const exAll = () => cdp.events.filter(x => String(x).startsWith('EX'))
  const addTab = async (i) => {
    const title = TAG + '-' + i
    const host = TAG + '-h' + i + '.example.com'
    const id = await cdp.eval(`window.__mkTab(${J(title)}, ${J(host)})`)
    if (!id) throw new Error('假页签没建出来：' + title)
    await sleep(700)
    return { title, host, id }
  }
  const openMenuOn = async (id) => {
    const list = await cdp.jeval('window.__tabsOf()')
    const t = list.find(x => x.id === String(id))
    if (!t) throw new Error('页签不在 DOM 里：' + id + ' :: ' + brief(list))
    await cdp.eval('window.__anchor = ' + J({ x: t.xy.x, y: t.xy.y }))
    await rightClick(cdp, t.xy.x, t.xy.y)
    if (!await waitFor(cdp, 'window.__menuOpen()', '右键菜单没出现', 8000)) {
      throw new Error('右键 ' + id + ' 菜单没出现：' + brief(await cdp.tail(6)))
    }
    await sleep(500)
    return cdp.jeval('window.__menuItems()')
  }
  // 标签文案先归一化（去空白 + 小写）再比：antd 会在中英文之间塞空格，
  // 判据跟着界面自己的 translate() 走，就不用来回改硬编码文案
  const __flat = s => String(s == null ? '' : s).replace(/\s/g, '').toLowerCase()
  const hasLabel = (items, label) => {
    const f = __flat(label)
    return !!items.find(i => i.flat.indexOf(f) >= 0)
  }
  const pickLabel = (items, label) => {
    const f = __flat(label)
    return items.find(i => i.flat.indexOf(f) >= 0) || null
  }
  const clickByLabel = async (items, label, settle = 900) => {
    const by = pickLabel(items, label)
    if (!by) return null
    // 坐标现取现点：菜单项的 rect 是传进来的那一刻量的，中间只要重排一次就点空
    const fresh = await cdp.jeval(`window.__itemByText(${J(label)})`)
    const it = (fresh && fresh.xy && fresh.xy.w > 0) ? fresh : by
    await cdp.click(it.xy.x, it.xy.y)
    await sleep(settle)
    return it
  }
  const closeMenu = async () => {
    await pressKey(cdp, { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)
    return cdp.jeval('window.__menuOpen()')
  }
  /**
   * 从右键菜单把色卡点开。
   * 菜单刚挂出来的那几百毫秒里项还在做动画，坐标要么量到 0x0、要么是动画前的旧位置，
   * 照着那份坐标点下去会落在别处（卡片没开，现场看着像"功能坏了"）。
   * 所以：坐标每次现取 + 点完等卡片真长出来，最多三轮。
   */
  const openCard = async (id) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!await cdp.jeval('window.__menuOpen()')) await openMenuOn(id)
      const fresh = await cdp.jeval(`window.__itemByText(${J(L.setTabColor)})`)
      if (fresh && fresh.xy && fresh.xy.w > 0) {
        await cdp.click(fresh.xy.x, fresh.xy.y)
        if (await waitFor(cdp, 'window.__cardOpen()', '色卡', 4000)) {
          await waitFor(cdp, '!window.__menuOpen()', '菜单没随点击收起', 4000)
          return { attempt, xy: fresh.xy }
        }
      } else {
        await sleep(350)
      }
    }
    return null
  }
  // 卡片右上角那个可拖动的高级取色器：点开它算"选色进行中"，卡片不该跟着收
  const openAdvanced = async (id) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!await cdp.jeval('window.__cardOpen()') && !await openCard(id)) return null
      const p = await cdp.jeval('window.__cardPickerXy()')
      if (p && p.hit) {
        await cdp.click(p.x, p.y)
        if (await waitFor(cdp, 'window.__panelOpen()', '高级取色面板', 4000)) return { attempt, xy: p }
      } else {
        await sleep(350)
      }
    }
    return null
  }
  // 主用法：点色点上色（点完卡片自己收起，不用再拖）
  const pickChip = async (id, hex) => {
    if (!await cdp.jeval('window.__cardOpen()') && !await openCard(id)) {
      throw new Error('色卡点不出来：' + brief(await cdp.tail(6)))
    }
    const chip = await cdp.jeval(`window.__chipByHex(${J(hex)})`)
    if (!chip) {
      throw new Error('色卡里没有 ' + hex + ' 那颗：' + brief((await cdp.jeval('window.__cardChips()')).map(c => c.text)))
    }
    if (!chip.hit) throw new Error('那颗色点被别的东西压住了：' + brief(chip.xy))
    await cdp.click(chip.xy.x, chip.xy.y)
    await sleep(700)
    return chip
  }
  // 真键盘往卡片里的 hex 输入打字 + 点后缀 ✓ 提交（回车不提交，这是 HexInput 的口径）
  const typeHex = async (id, hex) => {
    if (!await cdp.jeval('window.__cardOpen()') && !await openCard(id)) {
      throw new Error('色卡点不出来（hex 那条路）：' + brief(await cdp.tail(6)))
    }
    const inp = await cdp.jeval('window.__cardHex()')
    if (!inp) throw new Error('卡片里没有 hex 输入：' + brief(await cdp.jeval('window.__cardDump()')))
    await cdp.click(inp.xy.x, inp.xy.y)
    await sleep(300)
    await pressKey(cdp, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.insertText', { text: hex })
    await sleep(400)
    const typed = await cdp.jeval('window.__cardHex()')
    const okXy = await cdp.jeval('window.__cardHexSubmitXy()')
    if (okXy) {
      await cdp.click(okXy.x, okXy.y)
      await sleep(700)
    }
    return { valueBeforeSubmit: typed && typed.value, submitted: !!okXy }
  }

  const L = {}
  const missKey = []
  for (const k of ['closeTabLeft', 'closeTabRight', 'closeAllTabs', 'setTabColor', 'clearTabColor', 'reopenClosedTab', 'closeOtherTabs', 'rename']) {
    L[k] = await cdp.eval(`window.__L(${J(k)})`)
    if (!await cdp.jeval(`window.__hasKey(${J(k)})`)) missKey.push(k)
  }
  // 缺词条时 translate() 回退成 key 原文再首字母大写（界面上是 "ClearTabColor" 那种），
  // 而判据是拿 __L 的返回值去比界面文案 —— 两边一起回退就自比成立，"没有这一项"
  // 那几条会集体假绿。所以这里直接查语言包表，不看 translate 的脸。
  check('菜单标签全部真的取自语言包（没有一条走 key 回退）', missKey.length === 0, missKey)
  info('菜单标签取到（跟着界面语言走，判据不写死中英文）', L)

  // ── A · 菜单渲染与门控 ────────────────────────────────
  const t1 = await addTab(1)
  const t2 = await addTab(2)
  const t3 = await addTab(3)
  const s0 = await st()
  check('三个假页签渲染进页签条（DOM 与 store 各数各的对得上）',
    (s0.tabs || []).length === 3 && (await cdp.jeval('window.__tabsOf()')).length === 3,
    [s0.tabs.map(t => t.title), (await cdp.jeval('window.__tabsOf()')).map(t => t.id)])

  const midMenu = await openMenuOn(t2.id)
  const midTexts = midMenu.map(i => i.text)
  check('中间页签右键：菜单出现，且是同一份 DOM（不是只写在源码里）', midTexts.length > 5, midTexts)
  check('P-8b 三项都在菜单里：关闭左侧 / 关闭全部 / 设置页签颜色',
    hasLabel(midMenu, L.closeTabLeft) && hasLabel(midMenu, L.closeAllTabs) && hasLabel(midMenu, L.setTabColor),
    midTexts)
  const order = midMenu.map(i => i.flat)
  const idxLeft = order.findIndex(x => x.indexOf(__flat(L.closeTabLeft)) >= 0)
  const idxRight = order.findIndex(x => x.indexOf(__flat(L.closeTabRight)) >= 0)
  const idxAll = order.findIndex(x => x.indexOf(__flat(L.closeAllTabs)) >= 0)
  check('顺序对：关闭左侧紧跟在关闭右侧之后、关闭全部再在它之后（对称补齐不是随便插）',
    idxLeft >= 0 && idxLeft === idxRight + 1 && idxAll > idxLeft,
    midTexts)
  check('栈空时"重新打开已关闭的页签"不出现（P-8a 的门控）',
    !hasLabel(midMenu, L.reopenClosedTab) && s0.closed.length === 0, s0.closed.length)
  const colorItem = pickLabel(midMenu, L.setTabColor)
  check('"设置页签颜色"就是一行普通菜单项（色卡不藏在菜单里，点这一行才弹）',
    !!colorItem && !!colorItem.iconXy && /bg-colors/i.test(String(colorItem.iconXy.cls)),
    colorItem && colorItem.iconXy)
  check('没设过色时菜单里没有"清除页签颜色"（缺口①补的入口按 tab.color 门控）',
    !hasLabel(midMenu, L.clearTabColor), midMenu.map(i => i.text))
  const swA = await cdp.jeval('window.__swatchXy()')
  check('"设置页签颜色"行尾挂得出色块（原先空着的那个位置）：渲染出来、点得到、是个方不是条',
    !!swA && swA.w >= 10 && swA.h >= 10 && swA.hit === true, swA)
  check('没设过色时色块就是徽标那份默认色（computed 与徽标同源，不是透明也不是黑）',
    !!swA && swA.bg === defaultBadgeBg, swA && swA.bg)

  const leftMenu = await openMenuOn(t1.id)
  check('最左页签：有"关闭右侧"、没有"关闭左侧"',
    !hasLabel(leftMenu, L.closeTabLeft) && hasLabel(leftMenu, L.closeTabRight),
    leftMenu.map(i => i.text))
  const rightMenu = await openMenuOn(t3.id)
  check('最右页签：有"关闭左侧"，"关闭右侧"自己收掉（门控跟随位置）',
    hasLabel(rightMenu, L.closeTabLeft) && !hasLabel(rightMenu, L.closeTabRight),
    rightMenu.map(i => i.text))
  await closeMenu()

  // ── B · 色卡：点色点上色 / 清除 / hex / 高级取色器 ──────
  // 色卡该弹在行旁边：先把色块矩形量下来 —— 点下去菜单就收，色块跟着卸载，事后量不到
  if (!await cdp.jeval('window.__menuOpen()')) await openMenuOn(t2.id)
  const swPre = await cdp.jeval('window.__swatchXy()')
  const cardB = await openCard(t2.id)
  if (!cardB) throw new Error('色卡点不出来：' + brief(await cdp.tail(6)))
  info('色卡打开现场（第几轮点成 / 卡片尺寸）', { cardB, rect: await cdp.jeval('window.__cardRect()') })
  check('点"设置页签颜色"那一行：菜单收起、色卡照样活着（卡片由页签持有，不跟着菜单一起卸载）',
    await cdp.jeval('window.__cardOpen()') === true && await cdp.jeval('window.__menuOpen()') === false,
    { card: await cdp.jeval('window.__cardOpen()'), menu: await cdp.jeval('window.__menuOpen()') })
  const cardRectB = await cdp.jeval('window.__cardRect()')
  check('色卡弹在行旁边（贴着色块右缘、顶边基本对齐），不是退回弹在页签底下',
    !!swPre && !!cardRectB && cardRectB.x >= swPre.right - 6 && Math.abs(cardRectB.y - swPre.top) <= 28,
    { swPre, cardRectB })

  const chips = await cdp.jeval('window.__cardChips()')
  const chipTexts = chips.map(c => c.text.toLowerCase())
  check('色卡扩到 24 色 + random：界面上 25 颗，一颗不缺',
    PALETTE.length === 24 && chips.length === 25 && /random/.test(chipTexts[24]),
    { palette: PALETTE.length, chips: chips.length, last: chips[24] && chips[24].text })
  check('界面上那 24 颗与 rand-hex-color.js 的 defaultColors 逐颗一致（书签与页签共用一份色表，没有第二份）',
    PALETTE.every((h, i) => chipTexts[i].indexOf(h.toLowerCase()) >= 0),
    chipTexts.slice(0, 25))
  check('色点每颗都点得到（没有被卡片外框/滚动裁掉 —— 24 色后卡片变高，这条专防溢出）',
    chips.every(c => c.hit === true), chips.filter(c => !c.hit).map(c => c.text))
  const hex0 = await cdp.jeval('window.__cardHex()')
  if (!hex0) info('卡片里的输入现场（选择器没命中时）', await cdp.jeval('window.__cardDump()'))
  check('hex 输入默认给的就是当前色（没设过色 → 页签默认色 ' + defaultTabColor + '）',
    new RegExp('^' + defaultTabColor.slice(1) + '$', 'i').test(String(hex0 && hex0.value)), hex0)

  const DARK = '#6f42c1'
  await pickChip(t2.id, DARK)
  const sB = await st()
  const tabB = sB.tabs.find(t => t.id === t2.id)
  check('点色点即上色：tab.color 就是那颗（#6f42c1），不用自己拖动',
    String(tabB.color).toLowerCase() === DARK, tabB.color)
  check('选定即收起：点完色卡自己关掉（不是留着让用户再点别处）',
    await cdp.jeval('window.__cardOpen()') === false)
  const badge = await cdp.jeval(`window.__badge(${J(t2.id)})`)
  check('徽标真的上成那个颜色（computed background = rgb(111,66,193)），不是只写了个字段',
    !!badge && badge.bg === 'rgb(111, 66, 193)', badge)
  check('深色底自动配白字（isDark 口径在浏览器里也算得出）',
    !!badge && badge.color === 'rgb(255, 255, 255)', badge)
  check('改色不产生任何连接动作：页签 id/状态不变、closeDbTab 一次都没被调',
    sB.tabs.length === 3 && sB.calls.closeDbTab.length === 0 &&
      tabB.status === s0.tabs.find(t => t.id === t2.id).status,
    [sB.calls.closeDbTab, tabB.status])

  // 缺口①补的入口：设过色才出现"清除页签颜色"，点了回到默认色
  const afterDark = await openMenuOn(t2.id)
  check('设过色之后菜单里出现"清除页签颜色"（门控的另一侧）',
    hasLabel(afterDark, L.clearTabColor), afterDark.map(i => i.text))
  const swDark = await cdp.jeval('window.__swatchXy()')
  check('行尾色块跟着当前色走（刚点成 ' + DARK + '，computed 背景就是那颗）',
    !!swDark && swDark.bg === hexToRgb(DARK), swDark && swDark.bg)
  await clickByLabel(afterDark, L.clearTabColor, 1200)
  const sC1 = await st()
  const tabC1 = sC1.tabs.find(t => t.id === t2.id)
  const badgeDefault = await cdp.jeval(`window.__badge(${J(t2.id)})`)
  check('点清除：字段真的删掉（不是设成默认色的字符串），徽标回到默认色',
    tabC1.color === null && !!badgeDefault && badgeDefault.bg === defaultBadgeBg,
    [tabC1.color, badgeDefault])
  const afterClear = await openMenuOn(t2.id)
  check('清掉色之后"清除页签颜色"自己收掉（门控是活的，不是夹具期的快照）',
    !hasLabel(afterClear, L.clearTabColor), afterClear.map(i => i.text))
  const swCleared = await cdp.jeval('window.__swatchXy()')
  check('清除后行尾色块退回默认色（不留一个黑块或空块）',
    !!swCleared && swCleared.bg === defaultBadgeBg, swCleared && swCleared.bg)
  await closeMenu()

  // hex 输入：真键盘打字 + 点后缀 ✓ 提交；浅色 → 字自动转黑
  const LIGHT = 'f5f0ff'
  const typed = await typeHex(t2.id, LIGHT)
  const sC2 = await st()
  const tabC2 = sC2.tabs.find(t => t.id === t2.id)
  const badge2 = await cdp.jeval(`window.__badge(${J(t2.id)})`)
  check('真键盘在 hex 框里打色 → 点 ✓ 提交，tab.color 落到 #f5f0ff（✓ 只在凑满 6 位时出现）',
    typed.submitted === true && /^f5f0ff$/i.test(String(typed.valueBeforeSubmit)) &&
      String(tabC2.color).toLowerCase() === '#' + LIGHT, typed)
  check('换成浅色底 → 字自动转黑（同一处 isDark 判定，两处口径一致）',
    !!badge2 && badge2.bg === 'rgb(245, 240, 255)' && badge2.color === 'rgb(0, 0, 0)', badge2)
  const backCard = await openCard(t2.id)
  const hexBack = await cdp.jeval('window.__cardHex()')
  check('重开卡片时 hex 框显示的就是当前色（每次打开重挂一张，不留上回的输入草稿）',
    !!backCard && /^f5f0ff$/i.test(String(hexBack && hexBack.value)), hexBack)

  // 右上角高级取色器：属于"选色进行中"，点开它卡片不能跟着收
  const adv = await openAdvanced(t2.id)
  if (!adv) throw new Error('卡片里的高级取色器点不出来：' + brief(await cdp.jeval('window.__cardDump()')))
  check('打开高级取色面板时卡片不收（拖动属于选色中，收起只认点色点 / random / 提交 hex）',
    await cdp.jeval('window.__cardOpen()') === true && await cdp.jeval('window.__panelOpen()') === true,
    { card: await cdp.jeval('window.__cardOpen()'), panel: await cdp.jeval('window.__panelOpen()') })
  await pickChip(t2.id, '#28a745')
  const sC3 = await st()
  const badge3 = await cdp.jeval(`window.__badge(${J(t2.id)})`)
  check('面板开着时点色点照样收尾：上色 + 卡片与面板一起收',
    String(sC3.tabs.find(t => t.id === t2.id).color).toLowerCase() === '#28a745' &&
      await cdp.jeval('window.__cardOpen()') === false &&
      await cdp.jeval('window.__panelOpen()') === false &&
      badge3.bg === 'rgb(40, 167, 69)',
    [badge3, await cdp.jeval('window.__panelOpen()')])

  // random 那颗：出来的必须是可用的 #RRGGBB（不是 'random' 字符串本身）
  await openCard(t2.id)
  await pickChip(t2.id, 'random')
  const tabR = (await st()).tabs.find(t => t.id === t2.id)
  check('点 random：落到一个真实色值（#RRGGBB），不是把 "random" 写进 tab.color',
    /^#[0-9a-f]{6}$/i.test(String(tabR.color)), tabR.color)

  // 缺口⑤修好之后：从菜单项图标那条路激活 setColor 不再抛未捕获异常，且真的把卡片弹出来
  const exIcon0 = exAll().length
  await closeMenu()
  const rowMenu = await openMenuOn(t2.id)
  const rowItem = pickLabel(rowMenu, L.setTabColor)
  if (!rowItem) throw new Error('菜单里没有"设置页签颜色"那一行：' + brief(rowMenu.map(i => i.text)))
  const iconPoint = rowItem.iconXy
  if (!iconPoint) throw new Error('setColor 那一项没量到前面的图标：' + brief(rowItem))
  await cdp.click(iconPoint.x, iconPoint.y)
  await sleep(900)
  const exIcon = exAll().slice(exIcon0)
  check('缺口⑤已修：点"设置页签颜色"那一项的图标（不走 stopPropagation 的那条路）不再抛异常，卡片正常弹出',
    exIcon.length === 0 && await cdp.jeval('window.__cardOpen()') === true,
    { added: exIcon.length, msgs: exIcon.slice(0, 3), card: await cdp.jeval('window.__cardOpen()') })
  await pickChip(t2.id, '#d73a49')
  const sC4 = await st()
  const badge4 = await cdp.jeval(`window.__badge(${J(t2.id)})`)
  check('图标那条路进来的和文字那条路一样：色落进 store、徽标跟着变色',
    String(sC4.tabs.find(t => t.id === t2.id).color).toLowerCase() === '#d73a49' &&
      badge4.bg === 'rgb(215, 58, 73)', [sC4.tabs.find(t => t.id === t2.id).color, badge4])

  // ── C · closeTabsLeft ────────────────────────────────
  const t4 = await addTab(4)
  let sc = await st()
  check('补到四个页签（关闭左侧的夹具就位）', sc.tabs.length === 4, sc.tabs.map(t => t.title))
  const leftCloseMenu = await openMenuOn(t3.id)
  const callsBefore = (await st()).calls.closeDbTab.length
  const hit = await clickByLabel(leftCloseMenu, L.closeTabLeft, 1400)
  sc = await st()
  const domIds = (await cdp.jeval('window.__tabsOf()')).map(t => t.id)
  check('关闭左侧真把左边两条干掉：只剩右键那条和它右边的（store 与 DOM 双向一致）',
    !!hit && sc.tabs.length === 2 && sc.tabs.map(t => t.id).sort().join() === [t3.id, t4.id].sort().join() &&
      domIds.sort().join() === [t3.id, t4.id].sort().join(),
    [sc.tabs.map(t => t.title), domIds])
  const sc2 = await st()
  const rel = sc2.calls.closeDbTab.slice(callsBefore)
  info('关闭左侧的释放现场（每条库页签被释放两次：store 主动 + 组件卸载兜底）', {
    delta: rel, activeTabId: sc2.activeTabId, batchActive: sc2.batchActive
  })
  check('活动指针没悬空：关掉的不是活动那条时，指针必须还指着活着的页签',
    sc2.activeTabId === null || sc2.tabs.some(t => t.id === sc2.activeTabId),
    [sc2.activeTabId, sc2.tabs.map(t => t.id)])
  check('被关的两条都真的释放了连接（closeDbTab 里两条的 id 都在，且没牵连别人）',
    [t1.id, t2.id].every(id => rel.includes(id)) &&
      rel.every(id => id === String(t1.id) || id === String(t2.id)),
    { delta: rel, callsBefore, expect: [t1.id, t2.id] })
  // pushClosedTab 用 unshift：循环从右往左关，最后被关的是最左那条，所以它才是栈顶；
  // 于是"关闭左侧"之后连按重开，回来的顺序是从最左往回爬 —— 与逐个 × 关闭的顺序相反
  check('两条都进了 closedTabs，栈顶是最后被关的那条（关闭左侧 → 最左那条先回来）',
    sc2.closed.length === 2 && sc2.closed[0].title === TAG + '-1' && sc2.closed[1].title === TAG + '-2',
    sc2.closed)
  check('快照只留可重建字段（id/batch/pane/tabCount/status 都不该带）',
    sc2.closed.every(c => c.leaked.length === 0), sc2.closed)
  const nowLeftmost = await openMenuOn(t3.id)
  check('成了最左之后"关闭左侧"自己收掉（门控是活的，不是夹具期的快照）',
    !hasLabel(nowLeftmost, L.closeTabLeft), nowLeftmost.map(i => i.text))
  check('栈非空时"重新打开已关闭的页签"出现在菜单里（P-8a 的门控另一侧）',
    hasLabel(nowLeftmost, L.reopenClosedTab), nowLeftmost.map(i => i.text))

  // ── F · reopenClosedTab：四条关闭路径都压栈，弹栈重开 ──
  const xY = await cdp.jeval(`window.__closeXy(${J(t4.id)})`)
  const closedLen = (await st()).closed.length
  await cdp.click(xY.x, xY.y)
  await sleep(1400)
  const sxF = await st()
  check('× 关闭一条：走的是同一条压栈链路（栈 +1，页签真没了）',
    sxF.closed.length === closedLen + 1 && !sxF.tabs.find(t => t.id === t4.id),
    { closed: sxF.closed.length, was: closedLen, tabs: sxF.tabs.map(t => t.title) })
  await cdp.eval('window.__clearAll()')
  await sleep(1500)
  const fA = await addTab('a1')
  await addTab('a2')
  await addTab('a3')
  const menuA = await openMenuOn(fA.id)
  await clickByLabel(menuA, L.closeTabRight, 1400)
  let sf = await st()
  check('关闭右侧：两条都压栈（不是只把 DOM 抹掉）',
    sf.tabs.length === 1 && sf.closed.length === 2 &&
      sf.closed.map(c => c.title).sort().join() === [TAG + '-a2', TAG + '-a3'].sort().join(),
    [sf.tabs.map(t => t.title), sf.closed.map(c => c.title)])
  await cdp.eval('window.__clearAll()')
  await sleep(1500)
  const gB = await addTab('b2')
  await addTab('b1')
  await addTab('b3')
  const menuG = await openMenuOn(gB.id)
  await clickByLabel(menuG, L.closeOtherTabs, 1400)
  sf = await st()
  check('关闭其他：另外两条压栈，自己留下',
    sf.tabs.length === 1 && sf.tabs[0].id === String(gB.id) && sf.closed.length === 2,
    [sf.tabs.map(t => t.title), sf.closed.map(c => c.title)])
  const openCallsBefore = (await st()).calls.openDbTab.length
  const menuR = await openMenuOn(gB.id)
  check('栈非空 → 菜单里就有重开项', hasLabel(menuR, L.reopenClosedTab), menuR.map(i => i.text))
  const reopenedTitle = sf.closed[0].title
  const closedIdBefore = sf.closed.length
  await clickByLabel(menuR, L.reopenClosedTab, 1800)
  sf = await st()
  const newTab = sf.tabs.find(t => t.title === reopenedTitle)
  check('点重开：那条回到页签条，且是一条全新页签（快照不带旧 id）',
    !!newTab && newTab.id !== String(gB.id),
    [sf.tabs.map(t => [t.title, t.id]), reopenedTitle])
  check('重开就是把栈顶弹掉一条（不是整个清空、也不是复制一份留两份）',
    sf.closed.length === closedIdBefore - 1 && sf.closed[0] && sf.closed[0].title !== reopenedTitle,
    sf.closed.map(c => c.title))
  check('重开走的是真开页签链路（openDbTab 被调到）',
    (await st()).calls.openDbTab.length > openCallsBefore, (await st()).calls.openDbTab)
  await cdp.eval('window.__clearAll()')
  await sleep(1600)

  // 封顶 20：分三轮各关 8 条（一轮 22 条会把页签条挤成溢出态，
  // 那时最右几条根本不在 DOM 里，右键点不到 —— 计数照样能涨到封顶）
  const MANY_ROUND = 8
  for (let round = 0; round < 3; round++) {
    const ids = []
    for (let i = 0; i < MANY_ROUND; i++) {
      ids.push(await cdp.eval(`window.__mkTab(${J(TAG + '-r' + round + '-' + i)}, ${J(TAG + '-rh' + round + i + '.example.com')})`))
      if (i % 4 === 3) await sleep(250)
    }
    await sleep(600)
    const mMenu = await openMenuOn(ids[ids.length - 1])
    await clickByLabel(mMenu, L.closeAllTabs, 2200)
  }
  const sm = await st()
  check('连关 24 条：closedTabs 封顶 20，不无限涨',
    sm.closed.length === 20, sm.closed.length)
  check('砍的是最久未引用那一批（留 24 条里最近的 20 条：最后一轮 8 + 第二轮 8 + 第一轮头 4）',
    sm.closed.length === 20 &&
      sm.closed.filter(c => c.title.indexOf(TAG + '-r2-') === 0).length === MANY_ROUND &&
      sm.closed.filter(c => c.title.indexOf(TAG + '-r1-') === 0).length === MANY_ROUND &&
      sm.closed.filter(c => c.title.indexOf(TAG + '-r0-') === 0).length === 4,
    { r2: sm.closed.filter(c => c.title.indexOf(TAG + '-r2-') === 0).length, r1: sm.closed.filter(c => c.title.indexOf(TAG + '-r1-') === 0).length, r0: sm.closed.filter(c => c.title.indexOf(TAG + '-r0-') === 0).length })
  check('关闭全部把自己也压栈（closeOtherTabs 语义之外的那一条路径）',
    sm.tabs.length === 0 && sm.calls.closeDbTab.length >= MANY_ROUND * 3,
    [sm.tabs.length, sm.calls.closeDbTab.length])

  // ── D · 批量关闭的收尾：事务守卫 / 活动指针 / 空窗格 ───
  // 缺口②：关闭全部以前完全不看 txCloseGuards（守卫只在 × 那条路上生效），
  // 现在四条批量路径都走 closeTabsBatch → 逐条确认，取消即停止后续。
  await cdp.eval('window.store.closedTabs = []')
  await sleep(300)
  const d1 = await addTab('d1')
  const d2 = await addTab('d2')
  const d3 = await addTab('d3')
  const guardId = d2.id
  await cdp.eval(`(() => {
    window.__guardHits = []
    const s = window.store
    s.txCloseGuards = s.txCloseGuards || {}
    s.txCloseGuards[${J(guardId)}] = () => { window.__guardHits.push(${J(guardId)}); return false }
    return 'guard-deny'
  })()`)
  const dMenu = await openMenuOn(d3.id)
  await clickByLabel(dMenu, L.closeAllTabs, 2200)
  const sd = await st()
  check('缺口②已修 · 守卫说"不"：批量关闭逐条过 txCloseGuards，取消即停止后续',
    sd.guardHits.length === 1 && sd.guardHits[0] === String(guardId) &&
      !!sd.tabs.find(t => t.id === guardId) && !!sd.tabs.find(t => t.id === d3.id),
    { guardHits: sd.guardHits, tabs: sd.tabs.map(t => t.title) })
  check('取消之前那一条（没有守卫的）照关，压栈的也只有它 —— 不是整批回滚、也不是整批照关',
    !sd.tabs.find(t => t.id === d1.id) && sd.closed.length === 1 &&
      sd.closed[0].title === TAG + '-d1',
    [sd.tabs.map(t => t.title), sd.closed.map(c => c.title)])

  // 守卫放行那一侧：同一条路径要把这条也关掉
  await cdp.eval(`(() => {
    const s = window.store
    s.txCloseGuards[${J(guardId)}] = () => { window.__guardHits.push(${J(guardId)}); return true }
    return 'guard-allow'
  })()`)
  const dMenu2 = await openMenuOn(d3.id)
  await clickByLabel(dMenu2, L.closeAllTabs, 2200)
  const sd2 = await st()
  check('守卫放行后同一条路把它也关掉：本窗格清光（含右键那一条自己），DOM 不留幽灵页签',
    sd2.tabs.length === 0 && (await cdp.jeval('window.__tabsOf(0)')).length === 0,
    [sd2.tabs.map(t => t.title), (await cdp.jeval('window.__tabsOf(0)')).length])
  check('三条都压栈（守卫那条被确认过两次，栈里只留一份）',
    sd2.guardHits.length === 2 && sd2.closed.length === 3 &&
      sd2.closed.map(c => c.title).sort().join() === [TAG + '-d1', TAG + '-d2', TAG + '-d3'].sort().join(),
    [sd2.guardHits.length, sd2.closed.map(c => c.title)])

  // 缺口④：窗格被关光后活动指针不能还挂着那条已关页签
  info('关光之后的指针现场（全局 / 各窗格）', { activeTabId: sd2.activeTabId, batchActive: sd2.batchActive })
  check('缺口④已修 · 关光整个窗格后指针不悬空：activeTabId 与该窗格的 activeTabId0 都置空',
    sd2.tabs.length === 0 && sd2.activeTabId === '' && sd2.batchActive[0] === '',
    { activeTabId: sd2.activeTabId, batchActive: sd2.batchActive })

  // 缺口③：批量关闭接上 autoCloseEmptyPane。
  // 单窗格布局本来就"没有窗格可收"（autoClosePaneIfEmpty 在 total<=1 时直接返回），
  // 所以这条必须在双窗格下判 —— 上一轮把它钉成"布局不变"其实是条恒真的假判据。
  await cdp.eval('window.__clearAll()')
  await sleep(1200)
  await cdp.eval('window.store.setLayout("c2", false)')
  await sleep(1200)
  await cdp.eval('window.store.setConfig({ autoCloseEmptyPane: true })')
  await sleep(600)
  const h0 = await cdp.eval(`window.store.currentLayoutBatch = 0; window.__mkTab(${J('h0')}, ${J(TAG + '-h0.example.com')})`)
  await sleep(700)
  const h1 = await cdp.eval(`window.store.currentLayoutBatch = 1; window.__mkTab(${J('h1')}, ${J(TAG + '-h1.example.com')})`)
  await sleep(700)
  const beforeCollapse = await st()
  const hMenu = await openMenuOn(h1)
  await clickByLabel(hMenu, L.closeAllTabs, 2200)
  const sh = await st()
  const domAfterCollapse = await cdp.jeval('window.__tabsOf(0)')
  check('缺口③已修 · 开着"自动收起空窗格"：双窗格下关闭全部把窗格 2 清光后，布局自己收回去',
    beforeCollapse.layout === 'c2' && sh.configLayoutAuto === true &&
      sh.layout === 'c1' && sh.tabs.length === 1 && String(sh.tabs[0].id) === String(h0),
    [beforeCollapse.layout, sh.layout, sh.tabs.map(t => [t.title, t.batch])])
  check('收起的是空的那一格：另一窗格那条原样在（DOM 也只剩它）',
    domAfterCollapse.length === 1 && domAfterCollapse[0].id === String(h0),
    domAfterCollapse.map(t => t.id))
  check('收起之后没有指向已关页签的指针（活动指针要么指着活的、要么置空）',
    !sh.activeTabId || sh.tabs.some(t => t.id === sh.activeTabId),
    { activeTabId: sh.activeTabId, batchActive: sh.batchActive, tabs: sh.tabs.map(t => t.id) })
  await cdp.eval(`window.store.setConfig({ autoCloseEmptyPane: ${J(snapBefore.autoCloseEmptyPane === true)} })`)
  await sleep(400)

  // ── E · 跨窗格：只清本 batch ─────────────────────────
  // 这一组判要看的是"关本窗格不动别的窗格"，所以先把自动收空窗格关掉：
  // 开着它的话窗格 2 一空布局就缩回单格，batch 重排会把"没误伤"这条判据冲掉
  await cdp.eval('window.__clearAll()')
  await cdp.eval('window.store.setConfig({ autoCloseEmptyPane: false })')
  await sleep(1500)
  await cdp.eval('window.store.setLayout("c2", false)')
  await sleep(1200)
  const p0a = await cdp.eval(`window.store.currentLayoutBatch = 0; window.__mkTab(${J('p0-a')}, ${J(TAG + '-p0a.example.com')})`)
  await sleep(700)
  const p0b = await cdp.eval(`window.store.currentLayoutBatch = 0; window.__mkTab(${J('p0-b')}, ${J(TAG + '-p0b.example.com')})`)
  await sleep(700)
  const p1a = await cdp.eval(`window.store.currentLayoutBatch = 1; window.__mkTab(${J('p1-a')}, ${J(TAG + '-p1a.example.com')})`)
  await sleep(700)
  let se2 = await st()
  check('双窗格夹具就位（batch 归属：0 两条、1 一条）',
    se2.tabs.filter(t => t.batch === 0).length === 2 && se2.tabs.filter(t => t.batch === 1).length === 1 &&
      (await cdp.jeval('window.__tabsOf(0)')).length === 2 && (await cdp.jeval('window.__tabsOf(1)')).length === 1,
    se2.tabs.map(t => [t.title, t.batch]))
  const w1 = await cdp.jeval('window.__tabsOf(1)')
  check('第二个窗格里就是那一条（夹具的窗格归属在 DOM 上也成立）',
    w1.length === 1 && w1[0].id === String(p1a), [w1.map(t => t.id), p1a])
  const m1 = await openMenuOn(p1a)
  info('窗格 2 的菜单现场（页面上几份 dropdown、各自位置与首项）', await cdp.jeval('window.__menuDebug()'))
  const beforeCloseDb = (await st()).calls.closeDbTab.length
  await clickByLabel(m1, L.closeAllTabs, 2000)
  se2 = await st()
  const relDelta = se2.calls.closeDbTab.slice(beforeCloseDb)
  info('窗格 2 关闭全部后的释放现场', { delta: relDelta, stack: se2.closed.map(c => c.title) })
  const other = se2.tabs.filter(t => t.batch === 0)
  check('跨窗格不误伤：关闭全部只清空本窗格，另一个窗格两条原样在（id/顺序/batch 都不动）',
    se2.tabs.filter(t => t.batch === 1).length === 0 && other.length === 2 &&
      other[0].id === String(p0a) && other[1].id === String(p0b),
    [se2.tabs.map(t => [t.title, t.batch]), [p0a, p0b]])
  check('另一窗格的活动指针没被改写（activeTabId0 还指着它自己那一条）',
    se2.batchActive[0] === String(p0b), se2.batchActive)
  // 一条库页签会被释放两次：store 里 releaseTabResources 主动调一次，
  // db-session 组件卸载时再兜底调一次（delTab 那条路也是这个次数，不是批量关闭特有的）
  check('资源释放只算本窗格那一条（别的页签一次都没被带进去）',
    relDelta.length >= 1 && relDelta.every(id => id === String(p1a)), relDelta)
  const domLeft0 = await cdp.jeval('window.__tabsOf(0)')
  const domLeft1 = await cdp.jeval('window.__tabsOf(1)')
  check('两个窗格的 DOM 都与 store 对齐（没有渲染残留）',
    domLeft0.length === 2 && domLeft1.length === 0, [domLeft0.length, domLeft1.length])

  // 分屏下 closeTabsLeft 同样只吃本窗格
  const m0 = await openMenuOn(p0b)
  await clickByLabel(m0, L.closeTabLeft, 1600)
  const se3 = await st()
  check('窗格 1 里"关闭左侧"只关本窗格左边那条，另一窗格（本就空着）不受影响',
    se3.tabs.length === 1 && se3.tabs[0].id === String(p0b) && se3.tabs[0].batch === 0,
    se3.tabs.map(t => [t.title, t.batch]))
  await cdp.eval('window.__clearAll()')
  await sleep(1200)
  await cdp.eval(`window.store.setConfig({ autoCloseEmptyPane: ${J(snapBefore.autoCloseEmptyPane === true)} })`)
  await cdp.eval(`window.store.setLayout(${J(snapBefore.layout)}, false)`)
  await sleep(1000)

  // ── G · 本地终端不入栈 + 稳定性 + 主题观感 ───────────
  const hasPty = await cdp.eval('!!window.store.hasNodePty')
  const g0 = (await st()).closed.length
  if (hasPty) {
    const lid = await cdp.eval(`window.__mkLocal(${J('local-x')})`)
    await sleep(2500)
    // 不用菜单里那条"关闭"：'关闭' 是 '关闭左侧页签' 等条目的子串，
    // pickLabel 会按菜单顺序抓到别的条目；× 图标按 data-id 定位，只会命中这一条
    const lxy = await cdp.jeval(`window.__closeXy(${J(lid)})`)
    if (!lxy) throw new Error('本地终端的 × 取不到坐标：' + lid)
    await cdp.click(lxy.x, lxy.y)
    await sleep(1600)
    const sg = await st()
    check('本地终端没有可重建的连接 → 不进 closedTabs（重开它只会开一个新的空壳）',
      sg.closed.length === g0 && !sg.tabs.find(t => t.id === String(lid)),
      [sg.closed.length, g0, sg.tabs.map(t => t.title)])
    await cdp.eval('window.__clearAll()')
    await sleep(1200)
  } else {
    info('本机没有 node-pty，本地终端不入栈那条判据没跑', 'hasNodePty=false')
  }

  // 深浅主题各两张现场图（右键菜单 / 色卡）
  const tDark = await addTab('theme-dark')
  await openMenuOn(tDark.id)
  await sleep(400)
  await cdp.shot(path.join(SHOT_DIR, '1-context-menu-dark.png'))
  const darkCard = await openCard(tDark.id)
  if (!darkCard) throw new Error('深色主题下色卡点不出来：' + brief(await cdp.tail(6)))
  await sleep(300)
  await cdp.shot(path.join(SHOT_DIR, '2-color-card-dark.png'))
  const darkChips = await cdp.jeval('window.__cardChips()')
  check('深色主题下卡片完整：25 颗（24 色 + random）全在场、每颗都点得到、不超出视口',
    darkChips.length === 25 && darkChips.every(c => c.hit) &&
      await cdp.jeval('(() => { const r = window.__cardRect(); return !!r && r.y + r.h < window.innerHeight })()'),
    { n: darkChips.length, misses: darkChips.filter(c => !c.hit).map(c => c.text), rect: await cdp.jeval('window.__cardRect()') })
  await pickChip(tDark.id, '#6f42c1')
  const darkBadge = await cdp.jeval(`window.__badge(${J(tDark.id)})`)
  check('深色主题下上色链路照旧（点色点 → 徽标变色）',
    darkBadge.bg === 'rgb(111, 66, 193)', darkBadge)
  const themeLight = await cdp.jeval(`(() => {
    const s = window.store
    const items = (s.getItems && s.getItems('terminalThemes')) || []
    const light = items.find(t => String(t.name || '').toLowerCase().indexOf('light') >= 0)
    return light ? String(light.id) : ''
  })()`)
  if (themeLight) {
    await cdp.eval(`window.store.setTheme(${J(themeLight)})`)
    await sleep(1800)
    await openMenuOn(tDark.id)
    await cdp.shot(path.join(SHOT_DIR, '3-context-menu-light.png'))
    const lightCard = await openCard(tDark.id)
    if (!lightCard) throw new Error('浅色主题下色卡点不出来：' + brief(await cdp.jeval('window.__cardDump()')))
    await sleep(300)
    await cdp.shot(path.join(SHOT_DIR, '4-color-card-light.png'))
    const lightChips = await cdp.jeval('window.__cardChips()')
    const lightBadge = await cdp.jeval(`window.__badge(${J(tDark.id)})`)
    check('浅色主题下同一套链路照旧（菜单能开、卡片 25 颗在、徽标取到 computed 值）',
      lightChips.length === 25 && lightChips.every(c => c.hit) &&
        !!lightBadge && /rgb\(/.test(String(lightBadge.bg)),
      { chips: lightChips.length, misses: lightChips.filter(c => !c.hit).map(c => c.text), badge: lightBadge })
    await pickChip(tDark.id, '#ffd33d')
    const lightBadge2 = await cdp.jeval(`window.__badge(${J(tDark.id)})`)
    check('换主题不影响 isDark 判定：同是黄色那颗，深浅主题下都配黑字',
      lightBadge2.bg === 'rgb(255, 211, 61)' && lightBadge2.color === 'rgb(0, 0, 0)', lightBadge2)
    await cdp.eval(`window.store.setTheme(${J(snapBefore.theme)})`)
    await sleep(1200)
  } else {
    info('没找到名字带 light 的内置主题，浅色那两张没跑', themeLight)
  }
  await closeMenu()

  // ── H · 书签侧共用同一张色卡 ───────────────────────────
  // 卡片是从书签创建表单里抽出去的（src/client/components/common/color-card.jsx）。
  // 这一段证的不是卡片本身（B 段证过了），而是"抽走之后原来那个入口没坏"：
  // 入口弹的是同一张卡、色点与 hex 两条提交路都落得进表单、面板开着时收尾照旧。
  // 全程不保存：最后 hideSettingModal，书签库条数必须不变。
  const bkCount0 = await cdp.jeval('window.__bkCount()')
  const cardBeforeH = await cdp.jeval('window.__cardOpen()')
  await cdp.eval(`window.store.openBookmarkEdit({ id: 'new-bookmark:' + Date.now(), title: ${J(TAG + '-card')} })`)
  if (!await waitFor(cdp, '!!window.__bkChoose().pick', '书签表单里的色块触发点', 12000)) {
    throw new Error('书签表单里量不到色块：' + brief(await cdp.jeval('window.__bkChoose()')))
  }
  check('进这一段时页签那边的卡片已经收干净（下面读到的卡只可能是书签侧这张）',
    cardBeforeH === false, cardBeforeH)
  const bk0 = await cdp.jeval('window.__bkChoose()')
  info('书签表单色块现场（表单里有几颗 / 点得着的那颗在哪、当前底色）', bk0)

  const bkCard = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await cdp.jeval('window.__cardOpen()')) return true
      const t = (await cdp.jeval('window.__bkChoose()')).pick
      if (t) {
        await cdp.click(t.x, t.y)
        if (await waitFor(cdp, 'window.__cardOpen()', '书签侧的色卡', 4000)) {
          // 卡片和里面的面板会一起重走入场动画（现场类名 ant-zoom-big-enter-start、矩形 0×0）：
          // 动画中途量到的色点坐标不可用，等它落定再取，否则每颗都判成"被别的东西压住"
          await sleep(500)
          return true
        }
      }
      await sleep(350)
    }
    return false
  }
  const bkPick = async (hex) => {
    if (!await bkCard()) throw new Error('书签侧的色卡点不出来：' + brief(await cdp.jeval('window.__cardDump()')))
    const chip = await cdp.jeval(`window.__chipByHex(${J(hex)})`)
    if (!chip || !chip.hit) throw new Error('书签侧卡片里没有点得到的 ' + hex + '：' + brief(chip))
    await cdp.click(chip.xy.x, chip.xy.y)
    await sleep(700)
  }
  const bkSwatch = async () => {
    const b = await cdp.jeval('window.__bkChoose()')
    return b.pick || b.first
  }
  // 和页签侧的 typeHex 同一条路（真键盘 + 后缀 ✓），只是卡片归书签表单管
  const bkTypeHex = async (hex) => {
    if (!await bkCard()) throw new Error('书签侧的色卡点不出来（hex 那条路）：' + brief(await cdp.jeval('window.__cardDump()')))
    const inp = await cdp.jeval('window.__cardHex()')
    if (!inp) throw new Error('书签侧卡片里没有 hex 输入：' + brief(await cdp.jeval('window.__cardDump()')))
    await cdp.click(inp.xy.x, inp.xy.y)
    await sleep(300)
    await pressKey(cdp, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await cdp.call('Input.insertText', { text: hex })
    await sleep(400)
    const typed = await cdp.jeval('window.__cardHex()')
    const okXy = await cdp.jeval('window.__cardHexSubmitXy()')
    if (okXy) {
      await cdp.click(okXy.x, okXy.y)
      await sleep(700)
    }
    return { valueBeforeSubmit: typed && typed.value, submitted: !!okXy }
  }

  await cdp.click(bk0.pick.x, bk0.pick.y)
  const bkOpened = await waitFor(cdp, 'window.__cardOpen()', '书签侧的色卡', 4000)
  await sleep(600)
  const bkChips = await cdp.jeval('window.__cardChips()')
  check('书签表单那颗色块弹出来的就是同一张卡：25 颗、逐颗对上那 24 色 + random、颗颗点得到',
    bkOpened === true && bkChips.length === 25 && bkChips.every(c => c.hit) &&
      PALETTE.every((h, i) => String(bkChips[i].text).toLowerCase().indexOf(h.toLowerCase()) >= 0) &&
      /random/.test(String(bkChips[24].text).toLowerCase()),
    { open: bkOpened, n: bkChips.length, misses: bkChips.filter(c => !c.hit).map(c => c.text) })
  await cdp.shot(path.join(SHOT_DIR, '5-bookmark-card.png'))

  await bkPick('#6f42c1')
  const bkS1 = await bkSwatch()
  check('书签侧点色点即落值（色块 computed 底色 = rgb(111, 66, 193)，说明值真的经过表单回流）并自动收卡',
    !!bkS1 && bkS1.bg === 'rgb(111, 66, 193)' && await cdp.jeval('window.__cardOpen()') === false, bkS1)

  const reBk = await bkCard()
  const bkHexBack = await cdp.jeval('window.__cardHex()')
  check('书签侧重开卡片时 hex 框显示的就是当前色（value 回流到卡里，不是一进来就空）',
    reBk === true && /^6f42c1$/i.test(String(bkHexBack && bkHexBack.value)), bkHexBack)
  const bkTyped = await bkTypeHex('f5f0ff')
  const bkS2 = await bkSwatch()
  check('书签侧 hex 那条路同样通：真键盘打字 + 点 ✓ → 色块变 rgb(245, 240, 255)',
    bkTyped.submitted === true && /^f5f0ff$/i.test(String(bkTyped.valueBeforeSubmit)) &&
      !!bkS2 && bkS2.bg === 'rgb(245, 240, 255)' && await cdp.jeval('window.__cardOpen()') === false,
    [bkTyped, bkS2])

  if (!await bkCard()) throw new Error('书签侧色卡第 N 次点不出来：' + brief(await cdp.jeval('window.__cardDump()')))
  const bkPanel = await cdp.jeval('window.__cardPickerXy()')
  if (!bkPanel || !bkPanel.hit) throw new Error('书签侧卡片里的高级取色器点不出来：' + brief(bkPanel))
  await cdp.click(bkPanel.x, bkPanel.y)
  const bkPanelOpen = await waitFor(cdp, 'window.__panelOpen()', '书签侧的高级取色面板', 4000)
  await sleep(900)
  const bkCardStill = await cdp.jeval('window.__cardOpen()')
  info('书签侧点开高级面板后的弹层现场（卡片有没有被这一下点收）', {
    panel: await cdp.jeval('window.__panelOpen()'),
    card: bkCardStill,
    dump: await cdp.jeval('window.__cardDump()')
  })
  check('书签侧打开高级面板时卡片不收（这一版刻意的口径：拖动取色属于选色进行中，不再一动就收起）',
    bkPanelOpen === true && bkCardStill === true, { panel: bkPanelOpen, card: bkCardStill })
  await bkPick('#28a745')
  const bkS3 = await bkSwatch()
  check('面板开着时点色点照样收尾：色块是那颗绿、卡片与面板一起收',
    !!bkS3 && bkS3.bg === 'rgb(40, 167, 69)' &&
      await cdp.jeval('window.__cardOpen()') === false && await cdp.jeval('window.__panelOpen()') === false,
    bkS3)

  await cdp.eval('window.store.hideSettingModal()')
  await sleep(1200)
  const bkCount1 = await cdp.jeval('window.__bkCount()')
  const bkAfterClose = await cdp.jeval('window.__bkChoose()')
  check('没点保存就把面板关掉：书签库一条没多、表单里的色块也随面板卸载',
    bkCount1 === bkCount0 && bkAfterClose.n === 0, { count: [bkCount0, bkCount1], swatches: bkAfterClose.n })

  // 收尾还原
  await cdp.eval('window.__clearAll()')
  await sleep(1200)
  const sEnd = await st()
  check('现场还原：页签与栈清干净、布局回到进来之前的样子',
    sEnd.tabs.length === 0 && sEnd.closed.length === 0 && sEnd.layout === snapBefore.layout,
    [sEnd.tabs.length, sEnd.closed.length, sEnd.layout, snapBefore.layout])
  check('缺口⑤已修 · 全程零未捕获异常（含从菜单项图标那条路激活 setColor）',
    exAll().length === 0, exAll().slice(0, 5))

  const failed = results.filter(r => !r.ok)
  console.log('—— P-8 tab 右键菜单实机：' + (results.length - failed.length) + '/' + results.length + ' 通过 ——')
  await killInstance()
  await sleep(500)
  if (failed.length) {
    throw new Error(failed.length + ' 条判据没过：' + failed.map(f => f.name).join(' / '))
  }
  try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e) {
    console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
  }
}

main().then(() => {
  console.log('DONE tab-context-menu demo')
  process.exit(0)
}).catch(err => {
  die(err.message)
  process.exit(1)
})
