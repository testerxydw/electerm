#!/usr/bin/env node
/**
 * G6-5 主密码保险库（阶段②）—— 真实例端到端验收
 *
 * 单测钉的是判据层（vault-secrets / vault-bookmarks / vault-ui），这里验只有
 * "真磁盘 + 真渲染 + 真主进程"才看得见的东西：
 *   1) 库没开时旧格式书签原样落库（关闭态透传，不偷偷改写入路径）
 *   2) 建库后迁移块自己冒出来，点一次就搬完；进度计数跟着主进程走
 *   3) 解锁态读回来的是合并好的明文，且不再有 `_vault`（证明解开合并，不是副本）
 *   4) 兼容写入打开后新凭据仍是旧格式；锁定时新旧两种格式都能读
 *   5) 锁定态读不出明文、revealBookmark 被拒（vault-locked）
 *   6) 从书签发起连接 → 弹解锁框；取消不建 tab 且有提示；解锁后建 tab 且口令正确
 *   7) 锁定态开书签表单给"凭据暂不可见"提示
 *   8) 停用先把封存行反解回明文再删 vault.json；三条记录全部恢复旧格式
 *
 * 凭据：无 —— 临时 HOME + DATA_PATH 下的自建库，口令是本脚本现编的测试串。
 *
 * 用法：
 *   1) 渲染层改过就 npm run vite-build
 *   2) 主进程侧同步：cp src/app/lib/vault*.js src/app/lib/db.js src/app/lib/ipc.js work/app/lib/ &&
 *      cp src/app/common/locales-extra.js work/app/common/
 *   3) Xvfb <display> 起好（默认 :160）
 *   4) node self-test/vault-phase2-demo.js [display] [port] [shotDir]
 *
 * 临时目录默认删除，KEEP_TMP=1 保留以便排查。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':160'
const PORT = process.argv[3] || '9250'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/vault-phase2-shots')

const PASS_1 = 'g6p2-master-one-1234'
const BM1 = 'vp2-bm-1'
const BM2 = 'vp2-bm-2'
const BM3 = 'vp2-bm-3'
const PASS_BM1 = 'vp2-seed-pass-1'
const KEY_BM1 = '-----BEGIN OPENSSH PRIVATE KEY-----VP2FAKEKEY-----END OPENSSH PRIVATE KEY-----'
const HOP_PASS = 'vp2-hop-pass-2'
const PASS_BM2 = 'vp2-db-pass-2'
const PASS_BM3 = 'vp2-legacy-pass-3'

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-vault2-'))
const HOME = path.join(RUN, 'home')
const DATA = path.join(RUN, 'data')
const LOG_FILE = path.join(RUN, 'app.log')
const VAULT_JSON = path.join(DATA, 'users', 'default_user', 'vault.json')
let childPid = null

const zh = s => String(s == null ? '' : s).split(' ').join('')
const isZhLocale = !process.env.LANG || !/en/i.test(process.env.LANG)

// 提示文案从词条库现取：手抄一句会在下次改文案时把正常功能判成坏掉
const loc = require(path.join(ROOT, 'src/app/common/locales-extra'))
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const msgRe = key => {
  const texts = [loc.zh_cn[key], loc.en[key]].filter(Boolean)
  if (!texts.length) {
    die('词条库里没有 ' + key + '：判据要先跟着词条改')
  }
  return new RegExp(texts.map(escRe).join('|'), 'i')
}
const anyOf = (text, zhText, enRe) => {
  const t = zh(text)
  if (zhText && t.indexOf(zh(zhText)) >= 0) {
    return true
  }
  return !!enRe && enRe.test(text || '')
}

/** 开跑前顺带回收 1 小时以上的陈旧临时树（并行会话可能也在跑，只按前缀+年龄清） */
function sweepStale () {
  const base = os.tmpdir()
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith('electerm-vault2-')) {
      continue
    }
    const p = path.join(base, name)
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(p, { recursive: true, force: true })
      }
    } catch (e) { /* 并行会话刚建好又改过，跳过 */ }
  }
}

function readdirSafe (dir) {
  try {
    return fs.readdirSync(dir)
  } catch (e) {
    return '<' + e.code + '>'
  }
}

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

/** 被 SIGTERM 打死时没有 finally 可走：至少把刚起的进程组收掉，别留孤儿占端口 */
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
  console.error('日志 ' + LOG_FILE)
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n')
    console.error('[vault] 主进程日志：\n' + tail.filter(l => l.includes('[vault]')).slice(-12).join('\n'))
    console.error('DATA 下的 users：\n' + JSON.stringify({
      DATA: readdirSafe(DATA),
      users: readdirSafe(path.join(DATA, 'users')),
      'users/default_user': readdirSafe(path.join(DATA, 'users', 'default_user'))
    }))
  } catch (e) {
    console.error('日志读不出来：' + e.message)
  }
  if (process.env.KEEP_TMP) {
    console.error('临时目录保留以便排查：' + RUN)
  } else {
    try {
      fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (e) {
      console.error('临时目录没删干净（不影响判据）：' + e.message + ' -> ' + RUN)
    }
  }
  process.exit(1)
}

/** 只杀自己起的 detached 进程组，绝不按端口/pkill 匹配 —— 并行会话的实例还在跑 */
function killInstance (child) {
  if (!child || !child.pid) {
    return Promise.resolve()
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (e) {
    try {
      child.kill('SIGTERM')
    } catch (e2) {}
  }
  return sleep(2500)
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
  throw new Error('no CDP page target on port ' + PORT)
}

/**
 * 页内探针：状态/按钮/坐标都走稳定类名；dbAction、vaultOp 走主进程原入口，
 * 不借界面的手 —— 判据不该靠渲染层配合才成立。
 */
const PROBE = `
(() => {
  const v = { calls: [], orig: null }
  v.patch = () => {
    if (v.orig) return 'already'
    v.orig = window.pre.runGlobalAsync
    window.pre.runGlobalAsync = function (name, ...args) {
      if (name === 'vaultOp') {
        v.calls.push({ action: args[0], arg: JSON.parse(JSON.stringify(args[1] === undefined ? null : args[1])) })
      }
      return v.orig.apply(this, [name].concat(args))
    }
    return window.pre.runGlobalAsync !== v.orig ? 'ok' : 'not-writable'
  }
  v.unpatch = () => {
    if (v.orig) { window.pre.runGlobalAsync = v.orig; v.orig = null }
    return 'ok'
  }
  v.reset = () => { v.calls.length = 0; return 'ok' }
  const vis = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return false
      n = n.parentElement
    }
    return true
  }
  v.in = (sel) => {
    const el = [...document.querySelectorAll(sel)].filter(vis)
    return el.length ? el[0] : null
  }
  v.text = sel => {
    const el = v.in(sel)
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  }
  v.exists = sel => !!v.in(sel)
  v.disabled = sel => {
    const el = v.in(sel)
    return el ? !!el.disabled : null
  }
  // 设置页是可滚动的：目标在折叠线以下时 getBoundingClientRect 照样给坐标，
  // 但那个点上是别的东西 —— 点完什么都没发生，判据只会变成一句"没提示"
  v.xyScroll = (sel) => {
    const el = v.in(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    const b = el.getBoundingClientRect()
    const out = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    out.onScreen = out.y > 0 && out.y < window.innerHeight && out.x > 0 && out.x < window.innerWidth
    return out
  }
  v.xyBox = (sel) => {
    const el = v.in(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  }
  const field = el => {
    if (!el) return null
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el
    return el.querySelector('input, textarea')
  }
  v.fill = (sel, value) => {
    const el = field(v.in(sel))
    if (!el) return 'no-input:' + sel
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  v.val = (sel) => {
    const el = field(v.in(sel))
    return el ? el.value : null
  }
  v.messages = () => [...document.querySelectorAll('.message-item')]
    .map(m => m.className.replace('message-item ', '') + '::' +
      (m.querySelector('.message-content') || { innerText: '' }).innerText.replace(/\\s+/g, ' ').trim())
  v.openSection = () => {
    const { store } = window
    const item = store.getItems('setting').find(d => d.id === 'setting-vault')
    if (!item) return 'no-section'
    store.settingTab = 'setting'
    store.setSettingItem(item)
    store.openSettingModal()
    if (store.isMobile) store.settingMobileView = 'content'
    return 'ok'
  }
  v.stateTag = () => v.text('.vault-state-tag')
  // 直接走主进程原入口（不借界面的手）
  v.op = (action, arg) => v.orig('vaultOp', action, arg)
  v.db = (table, op, arg) => v.orig('dbAction', table, op, arg)
  // 取消/主按钮坐标：一起回，脚本按"有 primary"与文字挑
  v.modalFoot = () => {
    const foot = v.in('.vault-unlock-modal-foot')
    if (!foot) return null
    return [...foot.querySelectorAll('button')].map(b => {
      const r = b.getBoundingClientRect()
      return {
        text: b.innerText.replace(/\\s+/g, ' ').trim(),
        primary: /ant-btn-primary/.test(b.className),
        textBtn: /ant-btn-text/.test(b.className),
        disabled: !!b.disabled,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2)
      }
    })
  }
  // 取消按钮不是 primary 也不是 text（text 那个是"用恢复码"）
  v.modalCancel = () => {
    const foot = v.in('.vault-unlock-modal-foot')
    if (!foot) return null
    const bs = [...foot.querySelectorAll('button')]
    const pick = bs.find(b => /取消|^cancel$/i.test(b.innerText.trim())) ||
      bs.find(b => !/ant-btn-primary|ant-btn-text/.test(b.className))
    if (!pick) return null
    const r = pick.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: pick.innerText.trim() }
  }
  v.tabCount = () => (window.store.tabs || []).length
  // 口令原文只留在页面里：只回"对不对"与长度，不把口令送回 node
  v.tabInfo = (srcId, expected) => {
    const tabs = window.store.tabs || []
    const t = tabs.find(x => x && x.srcId === srcId)
    if (!t) return { found: false, count: tabs.length }
    return {
      found: true,
      count: tabs.length,
      passOk: t.password === expected,
      passLen: String(t.password || '').length
    }
  }
  // 把锁定态读结果挂进 store：书签列表平时也是这么灌的，_id 要补成 id。
  // 这是夹具整表替换，不是用户改动：重置 watcher 基线，别让它当成 diff 整轮回写
  v.setBookmarks = rows => {
    window.store.storeAssign({
      bookmarks: rows.map(r => Object.assign({}, r, { id: r.id || r._id }))
    })
    if (window.watchbookmarks && window.watchbookmarks.reseed) {
      window.watchbookmarks.reseed()
    }
    return (window.store.bookmarks || []).filter(b => /^vp2-bm-/.test(b.id)).length
  }
  v.bookmark = id => JSON.stringify((window.store.bookmarks || []).find(b => b.id === id) || null)
  v.popOk = () => {
    const b = [...document.querySelectorAll('.ant-popconfirm')].filter(vis)[0]
    if (!b) return null
    const btn = b.querySelector('.ant-btn-primary')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: btn.innerText }
  }
  window.__vlt = v
  return 'ok'
})()
`

const main = async () => {
  sweepStale()
  const child = launch()
  const cdp = await waitCdp()
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.translate', 'renderer boots', 150000)
  await sleep(2500)
  await cdp.eval(PROBE)
  cdp.events.length = 0

  const { check, results } = makeChecker()
  const shot = async name => {
    const file = path.join(SHOT_DIR, name + '.png')
    await sleep(320)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ev = async expr => cdp.eval(expr)
  const jv = async expr => ev('JSON.stringify(((' + expr + ')))')
  const get = async expr => JSON.parse(String(await jv(expr)))
  // op/db 返回 Promise：eval 带 awaitPromise，结果直接是主进程给的那个对象
  const op = (action, arg) => ev('window.__vlt.op(' + JSON.stringify(action) + ',' +
    JSON.stringify(arg === undefined ? null : arg) + ')')
  const db = (table, opName, arg) => ev('window.__vlt.db(' + JSON.stringify(table) + ',' +
    JSON.stringify(opName) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')')
  const texts = () => get('window.__vlt.messages()')
  const msgHas = async (re) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 6000) {
      const arr = await texts()
      if (arr.some(t => re.test(t))) {
        return arr.find(t => re.test(t))
      }
      await sleep(150)
    }
    return null
  }
  // 设置页要滚动：一律先 scrollIntoView 再取坐标（滚动可能是动画的，量两次）
  const click = async (sel) => {
    const first = await get('window.__vlt.xyScroll(' + JSON.stringify(sel) + ')')
    if (!first) {
      die('click target missing: ' + sel)
    }
    await sleep(260)
    const xy = await get('window.__vlt.xyScroll(' + JSON.stringify(sel) + ')')
    if (!xy) {
      die('click target vanished after scroll: ' + sel)
    }
    if (!xy.onScreen) {
      die('click target off-screen after scroll: ' + sel + ' ' + JSON.stringify(xy))
    }
    await cdp.click(xy.x, xy.y)
    await sleep(320)
    return true
  }
  const clickXY = async (xy, label) => {
    if (!xy || typeof xy.x !== 'number') {
      die('click target missing: ' + label)
    }
    await cdp.click(xy.x, xy.y)
    await sleep(320)
    return true
  }
  const errEvents = () => cdp.events.filter(e => {
    const s = String(e)
    if (!/^(EX|LOG) /.test(s)) {
      return false
    }
    return !/favicon|DevTools|gpu|GLES|libva|network service|ssl|Fontconfig|dbus|blueman|sandbox|vulkan|gbm|dri|EGL|Wayland|Accelerated|SharedImage|-blit/i.test(s)
  })

  check('探针挂上', await ev('window.__vlt.patch()') === 'ok')
  check('临时 DATA_PATH 起底没有 vault.json', !fs.existsSync(VAULT_JSON))
  // [vault] 每一步是 info 级，打包口径主日志只收 warn：走应用自己的调试开关抬级别，
  // 否则"动作可追溯"会成一条永远拿不到样本的空判据
  const dbg = await ev('window.pre.runGlobalAsync("saveUserConfig", ' +
    'Object.assign({}, window.store.config, { debug: true }))' +
    '.then(() => "ok").catch(err => "ERR:" + (err && err.message))')
  check('打开应用自己的调试日志档（[vault] 的 info 行才落得了盘）', dbg === 'ok', dbg)

  // ── 1. 保险库关闭时种两条旧格式书签 ──────────────────────────────
  const row1 = {
    _id: BM1,
    title: 'VP2 alpha',
    host: '127.0.0.1',
    port: 22,
    username: 'demo',
    type: 'ssh',
    authType: 'password',
    password: PASS_BM1,
    privateKey: KEY_BM1,
    connectionHoppings: [
      { host: 'hop-a', username: 'u1' },
      { host: 'hop-b', username: 'u2', password: HOP_PASS }
    ]
  }
  const row2 = {
    _id: BM2,
    title: 'VP2 beta',
    host: '127.0.0.1',
    type: 'database',
    dbPassword: PASS_BM2
  }
  const ins1 = await db('bookmarks', 'insert', row1)
  const ins2 = await db('bookmarks', 'insert', row2)
  check('关闭态插入不报错', !!ins1 && !!ins2 && ins1.password === PASS_BM1, { id: ins1 && ins1._id })
  check('关闭态 insert 返回里仍有明文（透传，不偷偷封存）',
    ins1 && ins1.password === PASS_BM1 && ins1.privateKey === KEY_BM1 &&
      ins2 && ins2.dbPassword === PASS_BM2 && !('_vault' in ins1) && !('_vault' in ins2),
    { k1: ins1 && Object.keys(ins1), k2: ins2 && Object.keys(ins2) })
  const seeded = await db('bookmarks', 'find', {})
  const seed1 = seeded.find(r => r._id === BM1) || {}
  const seed2 = seeded.find(r => r._id === BM2) || {}
  // 应用自带一条 default-local-bash，别按总条数判，只认自己种的那两条
  check('关闭态 find 读回两条旧格式明文',
    seed1.password === PASS_BM1 && seed2.dbPassword === PASS_BM2,
    { mine: seeded.filter(r => /^vp2-bm-/.test(r._id)).map(r => r._id) })

  // ── 2. 打开设置页 → 启用 Vault ──────────────────────────────────
  check('设置列表里有保险库这一节（桌面版）', await ev('window.__vlt.openSection()') === 'ok')
  await waitFor(cdp, 'window.__vlt.exists(".setting-vault")', 'vault section renders', 25000)
  await waitFor(cdp, 'window.__vlt.exists(".vault-enable") || window.__vlt.exists(".vault-managed")',
    'vault status resolves', 25000)
  check('未启用时给的是建库表单', await ev('window.__vlt.exists(".vault-enable")'))
  await ev('window.__vlt.fill(".vault-pass",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-pass2",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-autolock-num","30")')
  await click('.vault-enable')
  await waitFor(cdp, 'window.__vlt.exists(".vault-recovery-code")', 'recovery code shows', 30000)
  check('建库成功（恢复码面板出现）', await ev('window.__vlt.exists(".vault-recovery-code")'))
  await click('.vault-recovery-saved')
  await waitFor(cdp, '!document.querySelector(".vault-recovery-ack").disabled', 'ack enables', 12000)
  await click('.vault-recovery-ack')
  await waitFor(cdp, '!window.__vlt.exists(".vault-recovery-code")', 'recovery block collapses', 12000)
  const st1 = await op('status')
  check('建库后库是启用且解锁的', st1.ok === true && st1.enabled === true && st1.unlocked === true, st1)
  check('自动锁档位按填入值保存', st1.autoLockMin === 30, st1.autoLockMin)

  const ms0 = await op('migrateStatus')
  check('启用后 migrateStatus = {ok,total:2,sealed:0,plain:2}',
    ms0 && ms0.ok === true && ms0.total === 2 && ms0.sealed === 0 && ms0.plain === 2, ms0)

  // ── 3. 迁移块出现 → 点一次搬完 ──────────────────────────────────
  const blockShows = await waitFor(cdp, 'window.__vlt.exists(".vault-migrate-resume")', 'migrate block shows', 30000)
  check('有旧格式行时迁移块自己出现（不需要刷新）', blockShows === true)
  check('迁移块给"稍后"退路', !!(await ev('window.__vlt.exists(".vault-migrate-later")')))
  await shot('1-migrate-block')

  await click('.vault-migrate-resume')
  const tMig = Date.now()
  let msDone = null
  while (Date.now() - tMig < 60000) {
    msDone = await op('migrateStatus')
    if (msDone && msDone.ok && msDone.plain === 0) {
      break
    }
    await sleep(500)
  }
  check('点一次迁移后 plain 归零（2 行都封存）',
    msDone && msDone.ok === true && msDone.plain === 0 && msDone.sealed === 2, msDone)
  const resumeGone = await waitFor(cdp, '!window.__vlt.exists(".vault-migrate-resume")',
    'migrate block disappears', 30000)
  check('搬完后迁移块消失（没活可干就不摆进度条）', resumeGone === true)
  await ev('window.__vlt.openSection()')
  await waitFor(cdp, 'window.__vlt.exists(".vault-managed")', 'vault section reopens', 20000)
  check('封存行存在时停用块给"先反解"提示', await ev('window.__vlt.exists(".vault-unseal-hint")'))
  await shot('2-migrated')

  // ── 4. 解锁态读回是合并明文 ──────────────────────────────────────
  const rowsUnlocked = await db('bookmarks', 'find', {})
  const u1 = rowsUnlocked.find(r => r._id === BM1) || {}
  const u2 = rowsUnlocked.find(r => r._id === BM2) || {}
  check('解锁态两条都能读出来',
    !!u1._id && !!u2._id, rowsUnlocked.filter(r => /^vp2-bm-/.test(r._id)).map(r => r._id))
  check('解锁态第 1 条明文完整（password/privateKey/第 2 跳板口令）',
    u1.password === PASS_BM1 && u1.privateKey === KEY_BM1 &&
      Array.isArray(u1.connectionHoppings) &&
      u1.connectionHoppings[1] && u1.connectionHoppings[1].password === HOP_PASS, {
      pass: u1.password,
      hop: u1.connectionHoppings && u1.connectionHoppings.map(h => Object.keys(h || {}))
    })
  check('解锁态第 2 条 dbPassword 完整', u2.dbPassword === PASS_BM2, u2.dbPassword)
  check('解锁态读回对象里没有 _vault（是解开合并，不是原样带封套）',
    !('_vault' in u1) && !('_vault' in u2), [Object.keys(u1), Object.keys(u2)])

  // ── 5. 兼容写入：新凭据仍是旧格式 ────────────────────────────────
  await click('.vault-legacy-write')
  const legacyOn = await waitFor(cdp, 'window.__vlt.op("status").then(s => s.legacyWrite === true)',
    'legacyWrite on', 15000)
  check('打开兼容写入开关后 status.legacyWrite === true', legacyOn === true)
  const row3 = {
    _id: BM3,
    title: 'VP2 legacy',
    host: '127.0.0.1',
    type: 'ssh',
    authType: 'password',
    password: PASS_BM3
  }
  const ins3 = await db('bookmarks', 'insert', row3)
  check('兼容写入下第三条仍是旧格式（insert 返回带明文、无 _vault）',
    ins3 && ins3.password === PASS_BM3 && !('_vault' in ins3), Object.keys(ins3 || {}))
  const ms3 = await op('migrateStatus')
  check('兼容写入行被算作 plain（migrateStatus.plain === 1）',
    ms3 && ms3.ok === true && ms3.plain === 1, ms3)

  // ── 6. 锁定：新旧两种格式都能读，但封存行不出明文 ────────────────
  await op('lock')
  check('lock 后主进程报 locked', (await op('status')).unlocked === false)
  const rowsLocked = await db('bookmarks', 'find', {})
  const l1 = rowsLocked.find(r => r._id === BM1) || {}
  const l2 = rowsLocked.find(r => r._id === BM2) || {}
  const l3 = rowsLocked.find(r => r._id === BM3) || {}
  const stripKeys = ['password', 'privateKey', 'passphrase', 'certificate', 'dbPassword', 'proxyPassword']
  const hasAnySecret = row => stripKeys.some(k => typeof row[k] === 'string' && row[k] !== '') ||
    (Array.isArray(row.connectionHoppings) &&
      row.connectionHoppings.some(h => h && stripKeys.some(k => typeof h[k] === 'string' && h[k] !== '')))
  check('锁定态读回三条（新旧格式混合都可见）',
    !!l1._id && !!l2._id && !!l3._id,
    rowsLocked.filter(r => /^vp2-bm-/.test(r._id)).map(r => r._id))
  check('锁定态封存行明文被剥掉且标 _sealed',
    !hasAnySecret(l1) && !hasAnySecret(l2) &&
      l1._sealed === true && l2._sealed === true,
    { k1: Object.keys(l1), k2: Object.keys(l2), hop1: l1.connectionHoppings })
  check('锁定态旧格式行原样带明文、无 _sealed',
    l3.password === PASS_BM3 && !('_sealed' in l3), { keys: Object.keys(l3) })
  const rv = await op('revealBookmark', { id: BM1 })
  check('锁定态 revealBookmark 被拒（reason=vault-locked）',
    rv && rv.ok === false && rv.reason === 'vault-locked', rv)

  // ── 7. 从书签发起连接 → 取消：不建 tab + 有提示 ──────────────────
  check('锁定读结果挂进 store（3 条）', (await get('window.__vlt.setBookmarks(' +
    JSON.stringify(rowsLocked) + ')')) === 3)
  await sleep(800)
  const tabsBefore = await get('window.__vlt.tabCount()')
  // onSelectBookmark 是 async：必须用同步表达式点火，让它悬在解锁请求上
  await ev('(window.__sel = window.store.onSelectBookmark(' + JSON.stringify(BM1) + '), "started")')
  const modalShows = await waitFor(cdp, 'window.__vlt.exists(".vault-unlock-modal")',
    'unlock modal from connect', 20000)
  check('从书签发起连接会弹解锁框（不是静默失败）', modalShows === true)
  await shot('3-unlock-request')
  const footBtns = await get('window.__vlt.modalFoot()')
  check('解锁弹窗底部有取消 + 主按钮',
    Array.isArray(footBtns) && footBtns.some(b => b.primary) &&
      footBtns.some(b => !b.primary && !b.textBtn), footBtns)
  const cancel = await get('window.__vlt.modalCancel()')
  await clickXY(cancel, 'modal cancel')
  await sleep(2000)
  const tabsAfterCancel = await get('window.__vlt.tabCount()')
  check('取消解锁后不建 tab', tabsAfterCancel === tabsBefore, { before: tabsBefore, after: tabsAfterCancel })
  const cancelMsg = await msgHas(msgRe('vaultNeedUnlockToConnect'))
  check('取消后给出"解锁后才能新建连接"提示', !!cancelMsg, cancelMsg)

  // ── 8. 再次点火 → 解锁 → 建 tab 且口令正确 ──────────────────────
  await ev('(window.__sel = window.store.onSelectBookmark(' + JSON.stringify(BM1) + '), "started")')
  await waitFor(cdp, 'window.__vlt.exists(".vault-unlock-modal")', 'unlock modal again', 20000)
  await ev('window.__vlt.fill(".vault-unlock-modal-input",' + JSON.stringify(PASS_1) + ')')
  await click('.vault-unlock-modal .ant-btn-primary')
  const modalGone = await waitFor(cdp, '!window.__vlt.exists(".vault-unlock-modal")',
    'modal closes after unlock', 25000)
  check('输入正确主密码后弹窗关闭', modalGone === true)
  check('解锁成功（主进程口径）', (await op('status')).unlocked === true)
  const tabGrew = await waitFor(cdp,
    'window.__vlt.tabInfo(' + JSON.stringify(BM1) + ',' + JSON.stringify(PASS_BM1) + ').found',
    'bookmark tab opens', 30000)
  const tabInfo = await get('window.__vlt.tabInfo(' + JSON.stringify(BM1) + ',' + JSON.stringify(PASS_BM1) + ')')
  check('解锁后建出 tab，且 tab.password 等于种子口令',
    tabGrew === true && tabInfo.found === true && tabInfo.passOk === true, tabInfo)
  check('tab 数比取消那次多 1', tabInfo.count === tabsAfterCancel + 1,
    { before: tabsAfterCancel, after: tabInfo.count })
  // 设置页还盖在上面：要让截图看见刚建出来的连接 tab
  await ev('window.store.hideSettingModal && window.store.hideSettingModal()')
  await sleep(800)
  await shot('4-unlocked-connect')

  // ── 9. 锁定态开书签表单 → 凭据暂不可见提示 ──────────────────────
  await op('lock')
  check('再锁一次成功', (await op('status')).unlocked === false)
  const bmItem = await get('window.__vlt.bookmark(' + JSON.stringify(BM1) + ')')
  await ev('window.store.openBookmarkEdit(' + JSON.stringify(bmItem) + ')')
  const formHint = await waitFor(cdp, 'window.__vlt.exists(".bookmark-vault-locked")',
    'locked hint in bookmark form', 20000)
  check('锁定态书签表单出现"凭据暂不可见"提示', formHint === true)
  await shot('5-form-locked-hint')

  // ── 10. 停用：先反解再删库，三条全部回旧格式 ────────────────────
  const unlockAgain = await op('unlock', { masterPassword: PASS_1 })
  check('停用前解锁成功', unlockAgain && unlockAgain.ok === true && unlockAgain.unlocked === true, unlockAgain)
  const dis = await op('disable', { masterPassword: PASS_1 })
  check('停用返回 ok 且 enabled=false',
    dis && dis.ok === true && dis.enabled === false, dis)
  check('停用后 vault.json 从盘上删除', !fs.existsSync(VAULT_JSON))
  const rowsOff = await db('bookmarks', 'find', {})
  const off1 = rowsOff.find(r => r._id === BM1) || {}
  const off2 = rowsOff.find(r => r._id === BM2) || {}
  const off3 = rowsOff.find(r => r._id === BM3) || {}
  check('停用后三条全部明文回填（含跳板口令）',
    off1.password === PASS_BM1 && off1.privateKey === KEY_BM1 &&
      Array.isArray(off1.connectionHoppings) &&
      off1.connectionHoppings[1] && off1.connectionHoppings[1].password === HOP_PASS &&
      off2.dbPassword === PASS_BM2 && off3.password === PASS_BM3,
    { k1: Object.keys(off1), k2: Object.keys(off2), k3: Object.keys(off3) })
  check('停用后没有 _vault、没有 _sealed',
    ['_vault', '_sealed'].every(k => !(k in off1) && !(k in off2) && !(k in off3)),
    [Object.keys(off1), Object.keys(off2), Object.keys(off3)])
  await ev('window.__vlt.openSection()')
  await waitFor(cdp, 'window.__vlt.exists(".vault-enable")', 'back to enable form', 25000)
  check('停用后设置页回到未启用（给的是建库表单）',
    anyOf(await ev('window.__vlt.stateTag()'), '未启用', /Not enabled/i))
  await shot('6-disabled-backfilled')

  // ── 11. 泄漏审计 ────────────────────────────────────────────────
  const appLog = fs.readFileSync(LOG_FILE, 'utf8')
  check('主日志里没有主密码原文', appLog.indexOf(PASS_1) < 0)
  check('主日志确有 [vault] 行（行为可追溯）',
    /\[vault\] (enable|lock|unlock|disable|migrate)/.test(appLog),
    (appLog.match(/\[vault\][^\n]*/g) || []).slice(-4))
  const files = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      let s
      try {
        s = fs.statSync(p)
      } catch (e) {
        continue
      }
      if (s.isDirectory()) {
        walk(p, depth + 1)
      } else if (s.isFile() && s.size < 4 * 1024 * 1024) {
        files.push(p)
      }
    }
  }
  walk(DATA, 0)
  const leaks = files.filter(p => {
    let t
    try {
      t = fs.readFileSync(p, 'utf8')
    } catch (e) {
      return false
    }
    return t.indexOf(PASS_1) >= 0
  })
  check('DATA_PATH 下 ' + files.length + ' 个文件都没有主密码原文', leaks.length === 0, leaks)
  check('全程无未捕获前端错误', errEvents().length === 0, errEvents().slice(0, 3))
  await ev('window.__vlt.unpatch()')

  const fail = results.filter(r => !r.ok)
  console.log('\n==== G6-5 阶段②结论 ====')
  console.log('pass ' + (results.length - fail.length) + '/' + results.length + '  locale=' +
    (isZhLocale ? 'zh' : 'en') + '  实例目录 ' + RUN)
  fail.forEach(r => console.log('FAIL: ' + r.name + ' :: ' + JSON.stringify(r.detail)))
  await killInstance(child)
  if (!process.env.KEEP_TMP) {
    try {
      fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (e) {
      console.log('临时目录没删干净：' + e.message + ' -> ' + RUN)
    }
  } else {
    console.log('临时目录保留：' + RUN)
  }
  // ws 会挂住事件循环，跑完必须显式退出
  process.exit(fail.length ? 1 : 0)
}

main().catch(err => {
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')
    console.error('---- 实例日志尾巴 ----\n' + tail)
  } catch (e) { /* 还没起实例就崩了 */ }
  die((err && err.stack) || String(err))
})
