#!/usr/bin/env node
/**
 * B 批 书签查重（同名 + 同连接）—— 真实例端到端验收
 *
 * 为什么必须实机（源码契约与纯函数单测替代不了）：
 * - 判重发生在表单 submit 的那一刻，而写库挪到空闲帧：只有真渲染才证得了
 *   "被拦下时库里确实没多一条"，也证得了「仍然保存」重跑的是一份没被
 *   trim/换 id 污染过的提交；
 * - 横幅是 antd Alert（message + description + action）：文案、命中清单、
 *   「仍然保存」按钮分处三个盒子，深浅主题下都得看得见；
 * - store 卡点（addBookmark / editBookmark / addBookmarks / checkBookmark）
 *   只有在真 store 上才测得出"改密码不会被存量重复拦住""批量导入只跳不弹"。
 *
 * 覆盖：
 *   A 就绪与卡点在构建产物里存在
 *   B 新建：第一条正常保存；第二条同名同连接被拦（横幅 + 命中清单 + 库里不多一条）；
 *     「仍然保存」放行
 *   C 只同名不同机、只同机不同名 —— 都放行
 *   D 改名：撞别人被拦并可「仍然保存」；改一个没用过的名字直接通过
 *   E store 卡点语义：身份短路、selfId、checkBookmark 只读、批量跳过报数、
 *     force 复制语义、判不了放行、本地终端放行，且这些写库都真的落得了库（无报错通知）
 *   F 深浅主题各一张横幅 + 配色跟随主题
 *
 * 用法：
 *   1) 渲染层改过就 npm run vite-build
 *   2) 主进程侧同步：cp src/app/common/locales-extra.js work/app/common/
 *      （词条走 app.js，不同步就会在横幅里看到 key 而不是话）
 *   3) Xvfb <display> 起好（默认 :153）
 *   4) node self-test/bookmark-dedup-demo.js [display] [port] [shotDir]
 *
 * 凭据：无 —— 临时 HOME + 临时 DATA_PATH 的自建实例，主机名是假域名，
 * 全程不发起真实连接（只点保存，不点连接）。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9248'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/bookmark-dedup-shots')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-bkdedup-'))
const HOME = path.join(RUN, 'home')
const DATA = path.join(RUN, 'data')
const LOG_FILE = path.join(RUN, 'app.log')
let childPid = null

const TAG = 'bkd' + String(Date.now()).slice(-6)
const H1 = TAG + '-h1.example.com'
const H2 = TAG + '-h2.example.com'
const USER = 'dedupuser'
const T1 = TAG + '-web'
const T2 = TAG + '-same-host'

const loc = require(path.join(ROOT, 'src/app/common/locales-extra'))
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 判据两语都认：本机词条可能是中文也可能是英文 */
const msgRe = key => new RegExp([loc.zh_cn[key], loc.en[key]].filter(Boolean).map(escRe).join('|'), 'i')
const J = v => JSON.stringify(v)
const TITLE = J(['标题', 'title'])
const HOST = J(['主机', 'host'])
const PORT_L = J(['端口', 'port'])
const USER_L = J(['用户名', 'username'])

function launch () {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = {
    ...process.env,
    DISPLAY,
    HOME,
    XDG_CONFIG_HOME: path.join(RUN, 'config'),
    TMPDIR: path.join(RUN, 'tmp'),
    DATA_PATH: DATA
  }
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn('dbus-run-session', [
    '--',
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
  if (!childPid) {
    return
  }
  try {
    process.kill(-childPid, 'SIGTERM')
  } catch (e) { /* 已经没了 */ }
}

function die (why) {
  cleanupOrphan()
  console.error('FATAL ' + why)
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n')
    console.error('主进程日志尾巴：\n' + tail.slice(-25).join('\n'))
  } catch (e) {
    console.error('日志读不出来：' + e.message)
  }
  if (process.env.KEEP_TMP) {
    console.error('临时目录保留以便排查：' + RUN)
  } else {
    try {
      fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (e) {
      console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
    }
  }
  process.exit(1)
}

/** 只杀自己起的进程组（detached），绝不按端口/pkill 匹配 —— 并行会话的实例还在跑 */
function killInstance (child) {
  if (!child || !child.pid) {
    return Promise.resolve()
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (e) {
    try { child.kill('SIGTERM') } catch (e2) {}
  }
  return sleep(2000)
}

async function targets () {
  return getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
}

async function waitCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await targets()
    const page = list && findPageTarget(list)
    if (page) {
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      await cdp.call('Log.enable', {})
      cdp.events.length = 0
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
      })
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

const HELPERS = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true
      n = n.parentElement
    }
    return false
  }
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
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    if (window.__hidden(el)) return false
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top) || top.contains(el))
  }
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__flat = s => String(s == null ? '' : s).replace(/\\s/g, '').toLowerCase()
  // 表单项只问"渲染出来了没有"（页签里没展开的、折叠起来的都是 display:none），
  // 不问"此刻在不在视口里"：填标题要把表单滚到顶上，点保存又要滚到底下，
  // 用 __vis 挑字段会变成"滚到哪儿就只剩哪儿的字段填得进去"。
  // 真正需要"看得见"的判据（横幅、按钮坐标）另走 __vis + __reveal。
  window.__items = () => [...document.querySelectorAll('.ant-form-item')].filter(window.__rendered)
  // 表单项按 label 找（候选 = 中英两语）：label 一改判据就红，比写死 id 好懂
  window.__itemByLabel = cands => {
    const list = cands.map(window.__flat)
    return window.__items().find(i => {
      const lab = i.querySelector('.ant-form-item-label label')
      return lab && list.some(c => window.__flat(lab.innerText).indexOf(c) >= 0)
    }) || null
  }
  window.__inputOf = cands => {
    const it = window.__itemByLabel(cands)
    return it ? (it.querySelector('input, textarea')) : null
  }
  // React 受控输入：改 el.value 不算数，必须走原生 setter + input 事件
  // （这个 input 事件同时就是表单的 onValuesChange —— 横幅会不会随编辑收起也靠它）
  window.__set = (cands, v) => {
    const el = window.__inputOf(cands)
    if (!el) return 'no-input:' + cands.join('/')
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__get = cands => {
    const el = window.__inputOf(cands)
    return el === null || el === undefined ? null : String(el.value)
  }
  // 设置面板是一整页长表单：保存按钮和查重横幅都在首屏之外，
  // __vis 的 elementFromPoint 会把"在视口外"判成"不可见"，于是真功能被读成没做。
  // 先滚到视口中央再量：量的仍然是"真看得见"，只是把视口挪过去，判据不降级。
  window.__reveal = el => {
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' })
    return el || null
  }
  // antd 在两个汉字的按钮里插空格（"保 存"），比对前先去掉空白；
  // 且必须整词匹配，否则会把"保存并连接/保存并新建"当成保存按钮点下去
  window.__btnByText = re => {
    const rx = new RegExp(re, 'i')
    return [...document.querySelectorAll('button')]
      .find(x => rx.test(x.innerText.replace(/\\s/g, ''))) || null
  }
  window.__btnXY = re => {
    const b = window.__reveal(window.__btnByText(re))
    return b && window.__vis(b) ? window.__xy(b) : null
  }
  window.__saveXY = () => window.__btnXY('^(保存|save)$')
  // 查重横幅：文案 + 「仍然保存」按钮 + 配色（深浅主题各取一次）
  window.__dupEl = () => [...document.querySelectorAll('.bookmark-dup-warn')][0] || null
  window.__dup = () => {
    const el = window.__reveal(window.__dupEl())
    if (!el || !window.__vis(el)) return null
    const btn = [...el.querySelectorAll('button')][0]
    return {
      text: el.innerText.replace(/\\s+/g, ' ').trim(),
      btn: btn ? btn.innerText.replace(/\\s/g, '') : null,
      bg: getComputedStyle(el).backgroundColor
    }
  }
  window.__dupBtnXY = () => {
    const el = window.__reveal(window.__dupEl())
    const btn = el && [...el.querySelectorAll('button')][0]
    return btn && window.__vis(btn) ? window.__xy(btn) : null
  }
  // 侧栏书签是一条会滚的列：新建的那条多半在折叠区下面，
  // 这里要的是"库里/树里有这一条"，不是"此刻在视口里"，所以按是否渲染判定，不按 elementFromPoint
  window.__bkText = () => [...document.querySelectorAll('.tree-item-title')]
    .filter(n => n.offsetParent !== null).map(n => n.innerText.trim()).filter(Boolean)
  // 右下角的红色通知是这条应用报错的出口：判据全绿但弹了三条错，
  // 等于把"崩在落库上"的写库读成通过（实机踩过：没 id 的书签 → SQLite 绑定失败）
  window.__errNotice = () => [...document.querySelectorAll('.ant-notification-notice')]
    .map(n => n.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)
  // ── B4 存量重复清单：入口徽标 + 弹窗内容 ──
  window.__xyOf = el => {
    const t = window.__reveal(el)
    return t && window.__vis(t) ? window.__xy(t) : null
  }
  window.__dupEntry = () => {
    // 书签工具栏同时渲染两份（侧栏 + 设置面板的书签页）：认"当前点得着的那份"，
    // 抓第一条会把被弹层盖住/未展开那份的徽标数字当成界面给的数
    const list = [...document.querySelectorAll('.dup-bookmarks-entry')]
      .map(b => ({ b, wrap: b.closest('.ant-badge') || b.parentElement }))
    let hit = null
    for (const c of list) {
      window.__reveal(c.b)
      if (window.__vis(c.b)) {
        hit = c
        break
      }
    }
    return hit || list[0] || null
  }
  window.__dupBadge = () => {
    const hit = window.__dupEntry()
    if (!hit) return null
    const sup = hit.wrap ? hit.wrap.querySelector('.ant-badge-count') : null
    return {
      has: true,
      count: sup ? sup.innerText.replace(/\\s/g, '') : '',
      // antd 的 Badge 数为 0 时是 display:none，不是"没了"：读可见性而不是存在性
      shown: !!sup && sup.getBoundingClientRect().width > 0,
      xy: window.__xyOf(hit.b)
    }
  }
  // 同名书签在树里有几条：按书签 id 数树节点，不按标题文本数
  // （标题文本要穿过 highlight/省略号那层包装，且工具栏/树都可能有多份，按 id 才是一条一判）
  window.__treeCountFor = ids => ids.map(id =>
    document.querySelectorAll('.tree-item-title[data-item-id="' + id + '"]').length)
  window.__dupModal = () => {
    const m = [...document.querySelectorAll('.dup-bookmarks-modal')][0]
    if (!m || window.__hidden(m)) return null
    const txt = n => (n ? String(n.textContent) : '').replace(/\\s+/g, ' ').trim()
    const title = txt(m.querySelector('.ant-modal-title'))
    const groups = [...m.querySelectorAll('.dup-group')].map(g => ({
      head: txt(g.querySelector('.dup-group-head')),
      rows: [...g.querySelectorAll('.dup-row')].map(r => {
        const box = r.querySelector('input[type=checkbox]')
        return {
          id: r.dataset.bkId || '',
          name: txt(r.querySelector('.dup-row-name')),
          meta: txt(r.querySelector('.dup-row-meta')),
          checked: !!box && box.checked,
          marked: r.className.indexOf('dup-row-del') >= 0,
          edit: !!r.querySelector('.dup-row-edit')
        }
      })
    }))
    const btns = [...m.querySelectorAll('button')]
    const del = btns.find(x => /删除所选|delete selected/i.test(x.innerText.replace(/\\s/g, '')))
    return {
      title,
      groups,
      delText: txt(del),
      delDisabled: !del || del.disabled === true,
      empty: !!m.querySelector('.ant-empty'),
      emptyText: txt(m.querySelector('.ant-empty'))
    }
  }
  window.__dupRowBoxXY = (gi, ri) => {
    const g = [...document.querySelectorAll('.dup-group')][gi]
    const r = g && [...g.querySelectorAll('.dup-row')][ri]
    return r ? window.__xyOf(r.querySelector('.ant-checkbox')) : null
  }
  window.__dupRowEditXY = (gi, ri) => {
    const g = [...document.querySelectorAll('.dup-group')][gi]
    const r = g && [...g.querySelectorAll('.dup-row')][ri]
    return r ? window.__xyOf(r.querySelector('.dup-row-edit')) : null
  }
  window.__dupDelXY = () => window.__xyOf(
    [...document.querySelectorAll('.dup-bookmarks-modal button')]
      .find(x => /删除所选|delete selected/i.test(x.innerText.replace(/\\s/g, '')))
  )
  window.__dupEntryXY = () => {
    const hit = window.__dupEntry()
    return hit ? window.__xyOf(hit.b) : null
  }
  // 只动"这一批"造出来的书签：按 TAG 前缀筛，默认分组与别的书签不参与判据
  window.__snap = tag => JSON.stringify(window.store.bookmarks
    .filter(b => String(b.title || '').indexOf(tag) === 0)
    .map(b => ({ id: b.id, title: b.title, host: b.host, port: b.port, username: b.username, password: b.password })))
  return 1
})()`

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const child = launch()
  const cdp = await waitCdp()
  // 卡点在不在包里 —— 实例是本脚本现起的，跑的就是刚构建的产物，所以默认不重载：
  // 实测在首屏还在拉 chunk 时插一发 Page.reload，会换来一发 404 且页面再也起不来
  // （ERR_ABORTED + "Failed to load resource: 404"），把产品问题误判成判据问题。
  // 只有"起来了但卡点不在"（说明加载到的是上一版包）才补一次重载。
  const readyExpr = `(() => {
    const s = window.store
    return !!(s && s.bookmarks && window.translate &&
      ['checkBookmark', 'addBookmark', 'editBookmark', 'addBookmarks']
        .every(k => typeof s[k] === 'function'))
  })()`
  const booted = await waitFor(cdp, readyExpr, '应用未就绪（store 卡点没等到）', 60000)
  if (!booted) {
    await cdp.call('Page.reload', { ignoreCache: true })
    if (!await waitFor(cdp, readyExpr, '重载后 store 卡点仍不在包里', 60000)) {
      throw new Error('重载后应用未就绪：' + JSON.stringify(cdp.tail(6)))
    }
  }
  await sleep(1500)
  await cdp.eval(HELPERS)
  const { check, results } = makeChecker()

  const click = async (p, ms = 500) => {
    if (!p) throw new Error('点击目标不存在')
    await cdp.move(p.x, p.y)
    await sleep(120)
    await cdp.click(p.x, p.y)
    await sleep(ms)
  }
  const shot = name => cdp.shot(path.join(SHOT_DIR, name))
  const snap = async () => JSON.parse(await cdp.eval('window.__snap(' + J(TAG) + ')'))
  const dup = () => cdp.eval('window.__dup()')
  const saveXY = () => cdp.eval('window.__saveXY()')
  const clickSave = async () => click(await saveXY(), 900)

  /**
   * 打开书签表单。"开面板"这一步走 store（等价于点侧栏的「新建书签」/点列表里的书签），
   * 表单里的一切都是真鼠标真键盘。
   */
  const openNew = async () => {
    await cdp.eval('window.store.openBookmarkEdit({ id: "new-bookmark:" + Date.now(), title: "" })')
    if (!await waitFor(cdp, '!!window.__saveXY()', '新建书签表单没出来', 12000)) {
      throw new Error('openBookmarkEdit 后等不到保存按钮：' + JSON.stringify(cdp.tail(5)))
    }
  }
  const openEdit = async (id, expectTitle) => {
    await cdp.eval(`(() => {
      const it = window.store.bookmarks.find(b => b.id === ${J(id)})
      if (it) window.store.openBookmarkEdit(it)
    })()`)
    if (!await waitFor(cdp, `window.__get(${TITLE}) === ${J(expectTitle)}`,
      '编辑表单没打开到指定书签', 12000)) {
      throw new Error('编辑表单未打开（' + expectTitle + '）：' + JSON.stringify(cdp.tail(5)))
    }
  }
  const fill = async (title, host) => {
    const got = await cdp.eval(`JSON.stringify([
      window.__set(${TITLE}, ${J(title)}), window.__set(${HOST}, ${J(host)}),
      window.__set(${PORT_L}, '22'), window.__set(${USER_L}, ${J(USER)})])`)
    if (JSON.parse(got).some(x => x !== 'ok')) {
      throw new Error('表单字段没填上：' + got)
    }
    await sleep(300)
  }

  // ── A 卡点在构建产物里 ─────────────────────────────────────
  const api = JSON.parse(await cdp.eval(`JSON.stringify(['checkBookmark', 'addBookmark',
    'editBookmark', 'addBookmarks'].map(k => typeof window.store[k]))`))
  check('store 四个卡点方法在构建产物里都是函数', api.every(t => t === 'function'), api)

  // ── B1 新建第一条：正常保存 ────────────────────────────────
  await openNew()
  await fill(T1, H1)
  await clickSave()
  check('第一条同名书签正常保存（没有对照就碰撞不了）',
    (await snap()).length === 1, await snap())
  let list = await snap()
  check('保存按填写落库（host/端口/用户名都进得去）',
    list.length === 1 && list[0].host === H1 && String(list[0].port) === '22' &&
      list[0].username === USER, list)
  check('书签出现在书签树里',
    (await cdp.eval('window.__bkText()')).some(t => t.indexOf(T1) >= 0), await cdp.eval('window.__bkText()'))
  await shot('1-first-bookmark.png')

  // ── B2 第二条同名同连接：拦下 ──────────────────────────────
  await openNew()
  await fill(T1, H1)
  await clickSave()
  const warn = await dup()
  check('同名同连接被拦：横幅出现', !!warn, warn)
  check('横幅说的是人话（词条文案，不是 key）',
    !!warn && msgRe('bookmarkDuplicateWarn').test(warn.text), warn && warn.text)
  check('横幅列出撞在哪几条（标题 + user@host:port 式目标）',
    !!warn && warn.text.indexOf(T1) >= 0 && warn.text.indexOf(USER + '@' + H1 + ':22') >= 0, warn && warn.text)
  check('横幅里有「仍然保存」出口',
    !!warn && msgRe('bookmarkSaveAnyway').test(warn.btn || ''), warn && warn.btn)
  check('拦下时库里没有多出一条（判重早于写库）', (await snap()).length === 1, await snap())
  check('被拦下时字段还在（没有因为拦截把用户填的清空）',
    (await cdp.eval('window.__get(' + TITLE + ')')) === T1, await cdp.eval('window.__get(' + TITLE + ')'))
  await shot('2-duplicate-blocked-dark.png')

  // ── B3 「仍然保存」放行 ────────────────────────────────────
  await click(await cdp.eval('window.__dupBtnXY()'), 1000)
  check('点「仍然保存」后这条真的落库（同名同连接两条并存）', (await snap()).length === 2, await snap())
  check('放行后横幅收起', !(await dup()))

  // ── C 只差一个条件就放行 ───────────────────────────────────
  await openNew()
  await fill(T2, H1)
  await clickSave()
  check('同机不同名照常保存（不算重复）',
    !(await dup()) && (await snap()).length === 3, await snap())
  await openNew()
  await fill(T1, H2)
  await clickSave()
  list = await snap()
  check('同名不同机照常保存（不算重复）',
    !(await dup()) && list.length === 4 && list.some(d => d.title === T1 && d.host === H2), list)

  // ── D 改名 ─────────────────────────────────────────────────
  const sameHost = list.find(d => d.title === T2)
  await openEdit(sameHost.id, T2)
  await cdp.eval('window.__set(' + TITLE + ', ' + J(T1) + ')')
  await sleep(300)
  await clickSave()
  const warn2 = await dup()
  check('改名撞别人（同机同名）被拦并给横幅', !!warn2, warn2 && warn2.text)
  await shot('3-rename-conflict-dark.png')
  await click(await cdp.eval('window.__dupBtnXY()'), 1000)
  check('「仍然保存」让改名生效',
    (await snap()).some(d => d.id === sameHost.id && d.title === T1), await snap())

  const one = list.find(d => d.title === T1 && d.host === H1)
  await openEdit(one.id, T1)
  const keep = TAG + '-kept'
  await cdp.eval('window.__set(' + TITLE + ', ' + J(keep) + ')')
  await sleep(300)
  await clickSave()
  check('改成一个没用过的名字：直接保存、不弹横幅',
    !(await dup()) && (await snap()).some(d => d.id === one.id && d.title === keep), await snap())

  // ── E store 卡点语义（真 store，不靠源码正则） ─────────────
  const st = JSON.parse(await cdp.eval(`(() => {
    const s = window.store
    const mk = (t, h, extra) => Object.assign({
      id: 'stk-' + Math.random().toString(36).slice(2, 8),
      type: 'ssh', title: '${TAG}-' + t, host: h, port: 22, username: ${J(USER)}, password: 'p1'
    }, extra || {})
    const a = mk('stk-a', ${J(H1)})
    const twin = mk('stk-a', ${J(H1)})
    const other = mk('stk-d', ${J(H1)})
    s.addBookmark(a, { force: true })
    s.addBookmark(twin, { force: true })
    s.addBookmark(other)
    // 存量已有两条一模一样：给其中一条改密码，不该被另一条拦住
    const pwd = s.editBookmark(twin.id, { password: 'p2' })
    const pwdApplied = (s.bookmarks.find(d => d.id === twin.id) || {}).password
    // 同 host 同端口同用户、标题改成 third 的：这次是真的撞车
    const collide = s.editBookmark(twin.id, { title: other.title })
    const hit = (collide.duplicates || []).map(d => d.id)
    // 当场读，不能等最后再读：下面还会给这条改一次密码，
    // 事后读到的 p3 会把"拒绝时没写库"这条判据读成绿的
    const afterCollide = (s.bookmarks.find(d => d.id === twin.id) || {}).password
    const before = s.bookmarks.length
    const ro = s.checkBookmark({ type: 'ssh', title: other.title, host: other.host, port: 22, username: ${J(USER)} })
    const after = s.bookmarks.length
    const batch = s.addBookmarks([
      mk('stk-c', ${J(H2)}),
      { type: 'ssh', title: other.title, host: other.host, port: 22, username: ${J(USER)} },
      { type: 'ssh', title: other.title, host: other.host, port: 22, username: ${J(USER)} }
    ])
    // 探针书签一律带 id：addBookmark 不代生成 id（表单/MCP/导入各自生成），
    // 没 id 的那几条会在落库时炸出 "cannot be bound to SQLite parameter 2"，
    // 把判重判据淹成一片红色通知
    const noLocator = s.addBookmark(mk('stk-empty', ''))
    const local1 = s.addBookmark(mk('stk-local', '', { type: 'local' }))
    const local2 = s.addBookmark(mk('stk-local', '', { type: 'local' }))
    const undone = s.editBookmark(twin.id, { password: 'p3' })
    return JSON.stringify({
      pwdOk: pwd.ok, pwdApplied, collideOk: collide.ok, hit, afterCollide,
      roOk: ro.ok, roHits: (ro.duplicates || []).length, readCountSame: before === after,
      batchAdded: batch.added, batchSkipped: batch.skipped.length,
      batchSkippedStillThere: s.bookmarks.filter(b => b.title === other.title && b.host === other.host).length,
      noLocatorOk: noLocator.ok, localOk: [local1.ok, local2.ok], undoneOk: undone.ok,
      twinPassword: (s.bookmarks.find(d => d.id === twin.id) || {}).password
    })
  })()`))
  check('存量有两条一模一样时，改密码不再被自己另一条拦住（身份短路）',
    st.pwdOk === true && st.pwdApplied === 'p2', st)
  check('把标题改成另一条同名同连接的：editBookmark 拒绝', st.collideOk === false, st)
  check('拒绝时把撞在哪几条回给调用方', st.collideOk === false && st.hit.length === 1, st)
  check('撞车拒绝后没写库（标题没改、密码仍是 p2）',
    st.collideOk === false && st.afterCollide === 'p2', st)
  check('拒绝过一次不等于这条从此不能改：再改密码照常通过',
    st.undoneOk === true && st.twinPassword === 'p3', st)
  check('checkBookmark 只读：判重前后书签条数不变', st.readCountSame === true, st)
  check('checkBookmark 能在写之前就看见碰撞（给界面用）',
    st.roOk === false && st.roHits >= 1, st)
  check('批量落库跳过重复并如实报数（added=1 / skipped=2）',
    st.batchAdded === 1 && st.batchSkipped === 2, st)
  check('跳过的重复没有进库（同标题同主机仍只有一条）', st.batchSkippedStillThere === 1, st)
  check('判不了的（没有主机）一律放行', st.noLocatorOk === true, st)
  check('本地终端没有"连接"这回事：同名两条都放行',
    st.localOk.length === 2 && st.localOk.every(Boolean), st)
  await sleep(1500)
  const notices = await cdp.eval('window.__errNotice()')
  check('上面这些 store 级写库都真的落得了库（没弹报错通知）',
    (notices || []).length === 0, notices)

  // ── F 浅色主题 ─────────────────────────────────────────────
  const theme0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  if (!lightId) {
    check('存在可切换的浅色系主题', false, themeIds)
  } else {
    await openNew()
    await fill(T1, H1)
    await clickSave()
    const dark = await dup()
    check('深色主题下横幅可见（这一批已有两条同名同连接，第三次仍被拦）', !!dark, dark)
    await cdp.eval('window.store.setTheme(' + J(lightId) + ')')
    await sleep(1200)
    const light = await dup()
    check('浅色主题下横幅仍然可见、文案不丢',
      !!light && light.text === dark.text && msgRe('bookmarkDuplicateWarn').test(light.text), light)
    check('横幅配色跟随主题（不是写死色）',
      !!light && !!dark && light.bg !== dark.bg, { darkBg: dark && dark.bg, lightBg: light && light.bg })
    await shot('4-duplicate-blocked-light.png')
    await cdp.eval('window.store.setTheme(' + J(theme0) + ')')
    await sleep(600)
    // 字段一改，上一次碰撞就说明不了了：横幅该自己收起（判重以点保存那一刻为准）
    await cdp.eval('window.__set(' + TITLE + ', "x-cancel")')
    await sleep(400)
    check('改字段后旧横幅收起，不会留着一条已经不作数的提示', !(await dup()))
    await clickSave()
  }

  // E 段是拿真 store 直接造的探针书签（也带 TAG 前缀）：它们证明的是卡点语义，
  // 不该混进"界面这一批的生命周期"计数里
  const uiOnly = (await snap()).filter(d => d.title.indexOf(TAG + '-stk') !== 0)
  check('全程只有"确认要创建/仍然保存"的落库，被拦下的没一条偷偷进去',
    uiOnly.filter(d => d.title === T1 && d.host === H1).length === 2 &&
      uiOnly.filter(d => d.title === TAG + '-kept').length === 1 &&
      uiOnly.length === 4,
    uiOnly.map(d => d.title + '@' + d.host))

  // ── G B4 存量重复清单：入口 → 清单 → 勾选 → 删除 → 空态 ────
  // 判据在 Node 侧再算一遍（同一份纯模块）：清单列的不是"界面自己攒的一堆"，
  // 而是 bookmark-dedup 算出来的那几堆 —— 两边对不上就是界面另造了口径
  const dedup = await import(pathToFileURL(path.join(ROOT, 'src/client/common/bookmark-dedup.js')).href)
  const all = JSON.parse(await cdp.eval('JSON.stringify(window.store.bookmarks)'))
  const wantGroups = dedup.groupDuplicateBookmarks(all)
  const wantExtra = dedup.countDuplicateBookmarks(all)
  const wantTotal = wantGroups.reduce((n, g) => n + g.items.length, 0)
  const badge0 = await cdp.eval('window.__dupBadge()')
  check('清单入口在书签工具栏上，徽标数的是"多出来的条数"（不是组数）',
    !!badge0 && badge0.has === true && badge0.shown === true && badge0.count === String(wantExtra),
    { badge: badge0, wantExtra })
  await click(await cdp.eval('window.__dupEntryXY()'), 900)
  const modal0 = await cdp.eval('window.__dupModal()')
  const titleTotal = modal0 ? Number((modal0.title.match(/\((\d+)\)\s*$/) || [])[1]) : -1
  check('点入口开出清单，标题给出重复总条数',
    !!modal0 && titleTotal === wantTotal, { title: modal0 && modal0.title, wantTotal })
  const shapeOk = !!modal0 && modal0.groups.length === wantGroups.length &&
    modal0.groups.every((g, i) => {
      const w = wantGroups[i]
      return g.rows.length === w.items.length &&
        g.rows.every(r => r.name === w.title) &&
        g.head.indexOf(w.title) >= 0 && g.head.indexOf(w.target) >= 0
    })
  check('清单列的就是判据算出来的那几堆（组、条数、目标一一对上）',
    shapeOk, {
      got: modal0 ? modal0.groups.map(g => g.rows.length + '|' + g.head) : null,
      want: wantGroups.map(g => g.items.length + '|' + g.title + ' ' + g.target)
    })
  check('默认"每组留第一条、勾其余"，删除态与勾选态一致',
    !!modal0 && modal0.groups.every(g => g.rows.length > 1 &&
      g.rows[0].checked === false && g.rows.slice(1).every(r => r.checked === true) &&
      g.rows.every(r => r.marked === r.checked)), modal0 && modal0.groups)
  check('每行都给出"编辑"这条出路（改名就不算重复，不必非得删）',
    !!modal0 && modal0.groups.every(g => g.rows.every(r => r.edit === true)), modal0 && modal0.groups)
  const checked0 = modal0 ? modal0.groups.reduce((n, g) => n + g.rows.filter(r => r.checked).length, 0) : -1
  check('删除按钮报的数 = 当前勾选数',
    !!modal0 && modal0.delText.indexOf('(' + checked0 + ')') >= 0 && modal0.delDisabled === false,
    modal0 && modal0.delText)
  // 勾选是用户说了算的：点第一条也要跟上（默认只留第一条，不是"第一条锁死"）
  await click(await cdp.eval('window.__dupRowBoxXY(0, 0)'), 600)
  const modal1 = await cdp.eval('window.__dupModal()')
  const picked = modal1 && modal1.groups[0].rows[0]
  check('勾掉"保留的第一条"也认：勾选态、行删除态、按钮计数三处同步',
    !!picked && picked.checked === true && picked.marked === true &&
      modal1.delText.indexOf('(' + (checked0 + 1) + ')') >= 0,
    { picked, delText: modal1 && modal1.delText })
  await click(await cdp.eval('window.__dupRowBoxXY(0, 0)'), 600)
  await shot('5-dup-list-dark.png')

  // 逐行"编辑"：关掉清单并把这条打开到表单 —— 改名脱离重复是比删除更常做的事
  await click(await cdp.eval('window.__dupRowEditXY(0, 1)'), 900)
  const g0name = wantGroups[0] ? wantGroups[0].title : ''
  const formShown = await waitFor(cdp, 'window.__get(' + TITLE + ') === ' + J(g0name),
    '行内编辑没把这条打开到表单', 9000)
  const modalGone = !(await cdp.eval('window.__dupModal()'))
  check('行内"编辑"会收起清单并把这条打开到书签表单',
    formShown && modalGone, { formShown, modalGone, want: g0name })
  await click(await cdp.eval('window.__dupEntryXY()'), 900)
  const reopened = await cdp.eval('window.__dupModal()')
  check('重新打开清单默认勾选回到"留第一条"，没把上一轮的勾选冻在旧名单上',
    !!reopened && reopened.groups.length === wantGroups.length &&
      reopened.groups.every(g => g.rows[0].checked === false),
    reopened && reopened.groups.map(g => g.rows.map(r => (r.checked ? 1 : 0)).join('')))

  // 树的判据只认"从表单建出来那一组"：E 段的探针书签是直接喂 store 的，
  // 没进任何分类，本来就不挂在树上（fixBookmarkGroups 只在导入/启动时收编散条），
  // 拿它们要求"树上必须有"会红得莫名其妙
  const webRows = modal0
    ? ((modal0.groups.find(g => g.head.indexOf(T1) >= 0) || {}).rows || [])
    : []
  const webDel = webRows.filter(r => r.marked).map(r => r.id)
  const webKeep = webRows.filter(r => !r.marked).map(r => r.id)
  const probeIds = webDel.concat(webKeep)
  const tree0 = JSON.parse(await cdp.eval(
    'JSON.stringify(window.__treeCountFor(' + J(probeIds) + '))'))
  check('待删与待留的书签此刻都挂在书签树上（下面才知道删完是不是真的摘掉了）',
    webDel.length === 1 && webKeep.length >= 1 && tree0.every(n => n >= 1),
    { webDel, webKeep, tree0 })

  const before = JSON.parse(await cdp.eval('JSON.stringify(window.store.bookmarks.length)'))
  await click(await cdp.eval('window.__dupDelXY()'), 1200)
  const after = JSON.parse(await cdp.eval('JSON.stringify(window.store.bookmarks.length)'))
  check('删除所选后书签真的少了（少的就是勾选那几条，不是整组）',
    before - after === checked0, { before, after, checked0 })
  const tree1 = JSON.parse(await cdp.eval(
    'JSON.stringify(window.__treeCountFor(' + J(probeIds) + '))'))
  const stillDup = JSON.parse(await cdp.eval(
    'JSON.stringify(window.store.bookmarks.filter(b => b.title === ' + J(T1) +
    ' && b.host === ' + J(H1) + ').length)'))
  check('侧栏书签树跟着更新：勾掉的那条从树上摘干净，保留的那条没被顺手带走',
    tree1.slice(0, webDel.length).every(n => n === 0) &&
      tree1.slice(webDel.length).every(n => n >= 1),
    { probeIds, tree0, tree1 })
  check('库里同名同连接真的只剩一条', stillDup === 1, { stillDup })
  const groupLeak = JSON.parse(await cdp.eval(`(() => {
    const ids = new Set(window.store.bookmarks.map(b => b.id))
    return JSON.stringify(window.store.bookmarkGroups
      .filter(g => (g.bookmarkIds || []).some(id => !ids.has(id)))
      .map(g => g.title))
  })()`))
  check('删掉的书签不会在分类里留下悬空 id（走了既有的分组收口）',
    groupLeak.length === 0, groupLeak)
  const badge1 = await cdp.eval('window.__dupBadge()')
  check('清完之后徽标不再显示数字（入口留在原位，不是整个消失）',
    !!badge1 && badge1.has === true && badge1.shown === false, badge1)
  await click(await cdp.eval('window.__dupEntryXY()'), 900)
  const modal2 = await cdp.eval('window.__dupModal()')
  check('再打开是空态："没有重复书签"，不是一片看起来像坏了的空白',
    !!modal2 && modal2.empty === true && modal2.groups.length === 0 &&
      msgRe('noDuplicateBookmarks').test(modal2.emptyText), modal2)
  await shot('6-dup-list-empty.png')
  await click(await cdp.eval(`(() => {
    const m = [...document.querySelectorAll('.dup-bookmarks-modal button')]
      .find(x => /^(关闭|close)$/i.test(x.innerText.replace(/\\s/g, '')))
    return m && window.__vis(m) ? window.__xy(m) : null
  })()`), 700)
  const notices2 = await cdp.eval('window.__errNotice()')
  check('清单这一路（打开/勾选/编辑/删除）没弹任何报错通知',
    (notices2 || []).length === 0, notices2)

  const failed = results.filter(r => !r.ok)
  console.log('—— 书签查重实机：' + (results.length - failed.length) + '/' + results.length + ' 通过 ——')
  await killInstance(child)
  await sleep(500)
  // 判据红了先把现场留给 die() 打印主进程日志：上一版在这里就删了临时目录，
  // 结果"9 条没过"配一句"日志读不出来"，等于把线索自己撕掉
  if (failed.length) {
    throw new Error(failed.length + ' 条判据没过：' + failed.map(f => f.name).join(' / '))
  }
  try {
    fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch (e) {
    console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
  }
}

main().then(() => {
  console.log('DONE bookmark-dedup demo')
  process.exit(0)
}).catch(err => die(err.message))
