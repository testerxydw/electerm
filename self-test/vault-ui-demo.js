#!/usr/bin/env node
/**
 * G6-4 主密码保险库（阶段①）—— 真实例端到端验收
 *
 * 单测钉的是判据层（vault-crypto.spec）、服务状态机与 IPC 白名单（vault-service.spec）、
 * UI 判据与接线契约（vault-ui.spec / vault-setting-ui.spec）。这里验只有"真磁盘 + 真渲染 +
 * 真时钟 + 真进程生命周期"才看得见的东西：
 *   1) 没建库时底栏没有锁头；建完库锁头出现，状态一路跟着主进程走
 *   2) 短主密码由主进程拒（盘上一个文件都不落）；两次不一致由渲染层挡在发请求之前
 *   3) 建库：vault.json 0600、只有包好的东西；主密码/恢复码/裸 DEK 不在盘上、不在日志里
 *   4) 恢复码只显一次：复制拿到同一串；没勾"已抄下"收不起来；收起后 DOM 与组件 state 都找不到
 *   5) 锁定/解锁：错口令报"主密码不对"且仍锁着；对口令解锁后输入框明文立刻清空
 *   6) 换主密码：旧口令当场失效、新口令可用，库文件没被重建
 *   7) 自动锁真到期：设成 1 分钟，不碰鼠标键盘，界面自己回到"已锁定"
 *   8) 停用：身份不过拒绝且库还在；身份过了文件删除、锁头消失、回到未启用
 *   9) 读库失败是第四态：把 vault.json 写成半截 JSON，界面说"读不出来"，绝不当成"没启用"
 *     恢复码解锁：格式错的当场拒（不进 scrypt），52 字符但不对的报"不对"，对了给 needsNewPassword
 *  11) 重启主进程：DEK 只在内存 → 重启后必然回到锁定、库文件字节没变、弹窗输入主密码能开
 *
 * 凭据：无 —— 临时 HOME + 临时 DATA_PATH 下的自建库，口令是本脚本现编的测试串。
 *
 * 用法：
 *   1) 渲染层改过就 npm run vite-build
 *   2) 主进程侧同步：cp src/app/lib/vault*.js src/app/lib/ipc.js work/app/lib/ &&
 *      cp src/app/common/locales-extra.js work/app/common/
 *   3) Xvfb <display> 起好（默认 :153）
 *   4) node self-test/vault-ui-demo.js [display] [port] [shotDir]
 *
 * 实例由本脚本自己起（含重启那一步），跑完自己收；临时目录默认删除，KEEP_TMP=1 保留。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9247'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/vault-shots')

const PASS_1 = 'g6-demo-master-one-1234'
const PASS_2 = 'g6-demo-master-two-5678'
const PASS_SHORT = 'g6short'
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-vault-'))
const HOME = path.join(RUN, 'home')
const DATA = path.join(RUN, 'data')
const LOG_FILE = path.join(RUN, 'app.log')
const VAULT_JSON = path.join(DATA, 'users', 'default_user', 'vault.json')
let childPid = null

const zh = (s) => String(s == null ? '' : s).split(' ').join('')
const vaultOnDisk = () => fs.readFileSync(VAULT_JSON, 'utf8')
const isZhLocale = !process.env.LANG || !/en/i.test(process.env.LANG)

/**
 * 提示条/元信息的文案都由词条拼出来：正则也从词条库现取，
 * 手抄一句"已启用"就会在下次改文案时把一个正常功能判成坏掉。
 */
const loc = require(path.join(ROOT, 'src/app/common/locales-extra'))
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const msgRe = (key) => {
  const texts = [loc.zh_cn[key], loc.en[key]].filter(Boolean)
  if (!texts.length) {
    die('词条库里没有 ' + key + '：判据要先跟着词条改，不能留一条永远匹配不上的正则')
  }
  return new RegExp(texts.map(escRe).join('|'), 'i')
}

/** 词条两语都认：判据不该跟着本机语言倒下去 */
const anyOf = (text, zhText, enRe) => {
  const t = zh(text)
  if (zhText && t.indexOf(zh(zhText)) >= 0) {
    return true
  }
  return !!enRe && enRe.test(text || '')
}

function writeVaultFile (text) {
  fs.mkdirSync(path.dirname(VAULT_JSON), { recursive: true })
  fs.writeFileSync(VAULT_JSON, text, { encoding: 'utf8', mode: 0o600 })
}

/** 排查用：目录不存在/没权限都不该把排查本身弄崩 */
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
  // 排查全靠这两段：主进程说过什么（含 [vault] 每一步）+ 盘上到底有什么
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
      // 刚 SIGTERM 完，electron 的子进程还在往 DATA 里落最后一笔：
      // 硬删会撞 ENOTEMPTY，把上面那条真 FATAL 盖成一句清理错误
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

async function waitPortClosed (tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (!(await targets())) {
      return true
    }
    await sleep(500)
  }
  return false
}

/**
 * 页内探针：状态全看稳定类名；顺手记 vaultOp 的调用，
 * "拒绝在发请求之前"与"发出去的东西"只有看见调用本身才算数。
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
  v.xyBox = (sel) => {
    const el = v.in(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
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
  // 一组并排按钮（主密码/恢复码切换）不能点整组的中心 —— 那里正好在两颗之间
  v.xyNth = (sel, i) => {
    const els = [...document.querySelectorAll(sel)].filter(vis)
    const el = els[i]
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
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
  // 界面"点不动"时，光看 DOM 值不够：值进了 input 不代表进了 React state。
  // 从 fiber 上把建库表单的当前 state 抠出来（只回长度，口令不进日志）
  v.enableForm = () => {
    const el = document.querySelector('.setting-vault')
    if (!el) return 'no-root'
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber$'))
    let n = el[k]
    let up = 0
    while (n && up++ < 500) {
      const st = n.stateNode && n.stateNode.state
      if (st && st.enable) {
        return {
          p1: (st.enable.masterPassword || '').length,
          p2: (st.enable.confirm || '').length,
          autoLockMin: st.enable.autoLockMin,
          busy: st.busy || '',
          error: (st.error || '').slice(0, 60)
        }
      }
      n = n.return
    }
    return 'no-fiber-state'
  }
  v.chip = () => {
    const el = v.in('.vault-lock-chip')
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      cls: el.className,
      text: el.innerText.replace(/\\s+/g, ' ').trim(),
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2)
    }
  }
  // "unlocked" 里就含 "locked"：/locked/ 判"锁上了"永远为真，得锚定整段类名
  v.chipLocked = () => {
    const el = v.in('.vault-lock-chip')
    return el ? /(^|\\s)locked$/.test(el.className) : null
  }
  // 直接走 IPC（不借界面的手）：主进程的判据不该靠渲染层配合才成立
  v.op = (action, arg) => v.orig('vaultOp', action, arg)
  // 全应用 React 树里还留着这串明文吗：从 fiber 根往下扫，
  // DOM 看不见东西不代表组件 state 里已经没了
  v.leaked = (needle) => {
    const el = [...document.querySelectorAll('body *')].find(x => Object.keys(x).some(k => k.startsWith('__reactFiber$')))
    if (!el) return 'no-fiber'
    let n = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
    let up = 0
    while (n.return && up++ < 500) n = n.return
    const seen = new WeakSet()
    const hit = (x, d) => {
      if (x == null || d > 30) return false
      if (typeof x === 'string') return x.indexOf(needle) >= 0
      if (typeof x !== 'object') return false
      if (seen.has(x)) return false
      seen.add(x)
      let ks
      try { ks = Object.keys(x) } catch (e) { return false }
      for (const k of ks) {
        let val
        try { val = x[k] } catch (e) { continue }
        if (hit(val, d + 1)) return true
      }
      return false
    }
    return hit(n, 0) ? 'found' : 'clean'
  }
  v.bodyHas = (needle) => document.body.innerText.indexOf(needle) >= 0
  v.storeHas = (needle) => {
    try { return JSON.stringify(window.store).indexOf(needle) >= 0 } catch (e) { return 'unserializable' }
  }
  v.panelColors = () => {
    const r = v.in('.setting-vault')
    return r ? getComputedStyle(r).backgroundColor + '|' + getComputedStyle(r).color : null
  }
  // 确认弹层里那个主按钮（锁定/停用都走它）
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
  let child = launch()
  let cdp = await waitCdp()
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.translate', 'renderer boots', 150000)
  await sleep(2500)
  await cdp.eval(PROBE)
  cdp.events.length = 0

  const { check, results } = makeChecker()
  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(320)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ev = async expr => cdp.eval(expr)
  // 探针返回值统一走 JSON 往返：CDP returnByValue 会把 undefined/函数静默吃掉
  const jv = async expr => ev('JSON.stringify(((' + expr + ')))')
  const get = async expr => JSON.parse(String(await jv(expr)))
  // op 返回 Promise：eval 带 awaitPromise，结果直接是主进程给的那个对象
  const op = (action, arg) => ev('window.__vlt.op(' + JSON.stringify(action) + ',' + JSON.stringify(arg === undefined ? null : arg) + ')')
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
  // 设置页要滚动：一律先 scrollIntoView 再取坐标，否则点到的是盖在上面的别的东西
  // 滚动可能是动画的：量一次拿到的是"滚之前"的位置，等落定再量一次才准
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
  const clickNth = async (sel, i) => {
    await get('window.__vlt.xyNth(' + JSON.stringify(sel) + ',' + i + ')')
    await sleep(260)
    const xy = await get('window.__vlt.xyNth(' + JSON.stringify(sel) + ',' + i + ')')
    if (!xy) {
      die('click target missing: ' + sel + ' #' + i)
    }
    await cdp.click(xy.x, xy.y)
    await sleep(320)
    return true
  }
  const stable = async (expr, tries = 14) => {
    let prev = null
    for (let i = 0; i < tries; i++) {
      const cur = await jv(expr)
      if (prev !== null && cur === prev && cur !== 'null') {
        return JSON.parse(cur)
      }
      prev = cur
      await sleep(180)
    }
    return null
  }
  // Cdp 把异常/日志压成一行字符串（EX/LOG/ERROR 前缀），按前缀挑真错误
  const errEvents = () => cdp.events.filter(e => {
    const s = String(e)
    if (!/^(EX|LOG) /.test(s)) {
      return false
    }
    return !/favicon|DevTools|gpu|GLES|libva|network service|ssl|Fontconfig|dbus|blueman|sandbox|vulkan|gbm|dri|EGL|Wayland|Accelerated|SharedImage|-blit/i.test(s)
  })

  check('探针挂上', await ev('window.__vlt.patch()') === 'ok')
  check('临时 DATA_PATH 起底是干净的', !fs.existsSync(VAULT_JSON))
  // [vault] 每一步是 info 级，打包口径主日志只收 warn：不开这一档，"日志只记动作与原因"
  // 就成了一条永远拿不到样本的空判据。走应用自己的调试开关（saveUserConfig 里顺带抬级别），
  // ELECTERM_DEBUG 环境变量没用 —— 启动时 ipc.js 会拿 config.debug 把它覆盖回 warn。
  const dbg = await ev('window.pre.runGlobalAsync("saveUserConfig", ' +
    'Object.assign({}, window.store.config, { debug: true }))' +
    '.then(() => "ok").catch(err => "ERR:" + (err && err.message))')
  check('打开应用自己的调试日志档（[vault] 的 info 行才落得了盘）', dbg === 'ok', dbg)
  check('设置列表里有保险库这一节（桌面版）', await ev('window.__vlt.openSection()') === 'ok')
  await waitFor(cdp, 'window.__vlt.exists(".setting-vault")', 'vault section renders', 25000)
  // 挂载先出一帧"加载中"：不等状态落地就比文案，比到的是加载中的字
  await waitFor(cdp,
    'window.__vlt.exists(".vault-enable") || window.__vlt.exists(".vault-managed") || window.__vlt.exists(".vault-store-error")',
    'vault status resolves', 25000)

  // ── 1. 未启用 ────────────────────────────────────────────────────
  const tag0 = await ev('window.__vlt.stateTag()')
  check('未启用时状态标签是"未启用"', anyOf(tag0, '未启用', /Not enabled/i), tag0)
  check('未启用时底栏没有锁头（没库就不摆入口）', (await get('window.__vlt.chip()')) === null)
  check('未启用时给的是建库表单', await ev('window.__vlt.exists(".vault-enable")'))
  check('建库按钮在两个输入都空时点不动', await ev('window.__vlt.disabled(".vault-enable")') === true)
  await shot('off-enable-form')

  // ── 2. 两条拒绝路径：主进程拒短密码，渲染层拒不一致 ──────────────
  const weak = await op('enable', { masterPassword: PASS_SHORT })
  check('短主密码由主进程拒（reason=weak-password）', weak.ok === false && weak.reason === 'weak-password', weak)
  check('拒绝消息里不带口令原文', JSON.stringify(weak).indexOf(PASS_SHORT) < 0, weak)
  check('弱口令被拒后盘上没有半个文件', !fs.existsSync(VAULT_JSON))
  check('弱口令被拒后状态仍是未启用', (await op('status')).enabled === false)

  await ev('window.__vlt.reset()')
  await ev('window.__vlt.fill(".vault-pass",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-pass2",' + JSON.stringify(PASS_2) + ')')
  check('两遍不一致时确认按钮仍点不动', await ev('window.__vlt.disabled(".vault-enable")') === true)
  await click('.vault-enable')
  check('不一致时一个 enable 请求都没发（拒绝在发请求之前）',
    (await get('window.__vlt.calls.filter(c => c.action === "enable").length')) === 0)
  check('不一致时盘上依然什么都没有', !fs.existsSync(VAULT_JSON))

  // ── 3. 真建库 ────────────────────────────────────────────────────
  await ev('window.__vlt.fill(".vault-pass2",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-autolock-num","30")')
  check('自动锁输入框收得进值', (await ev('window.__vlt.val(".vault-autolock-num")')) === '30')
  // 失败时这一行就是全部证据：DOM 里有字不等于 state 里有字
  const form1 = await get('window.__vlt.enableForm()')
  check('建库表单 state 收得进两遍口令与档位',
    form1 && form1.p1 === PASS_1.length && form1.p2 === PASS_1.length && Number(form1.autoLockMin) === 30, form1)
  check('两遍一致后建库按钮点得动', await ev('window.__vlt.disabled(".vault-enable")') === false)
  await click('.vault-enable')
  const sentEnable = await get('window.__vlt.calls.filter(c => c.action === "enable").length')
  check('建库请求确实从界面发出去了（界面→IPC 这一段没断）', sentEnable > 0, sentEnable)
  const created = await msgHas(msgRe('vaultEnabled'))
  check('建库成功给出提示', !!created, created)
  await waitFor(cdp, 'window.__vlt.exists(".vault-recovery-code")', 'recovery code shows', 25000)
  const grouped = await ev('window.__vlt.text(".vault-recovery-code")')
  const code = String(grouped).replace(/[^A-Z2-7]/g, '')
  check('恢复码是 52 个 Base32 字符（A–Z2–7）', /^[A-Z2-7]{52}$/.test(code), grouped)
  check('恢复码按 5 字符分组显示', /^[A-Z2-7]{5}( [A-Z2-7]{5})+[ A-Z2-7]{1,5}$/.test(grouped), grouped)
  const tag1 = await ev('window.__vlt.stateTag()')
  check('建库后状态标签是"已解锁"', anyOf(tag1, '已解锁', /Unlocked/i), tag1)
  const meta = await ev('window.__vlt.text(".vault-meta")')
  check('头部把自动锁分钟数与"有恢复码"讲清楚',
    zh(meta).indexOf('30') >= 0 && msgRe('vaultHasRecovery').test(meta), meta)
  await shot('created-recovery-code')

  await waitFor(cdp, 'window.__vlt.op("status").then(s => s.autoLockMin === 30)', 'autoLockMin 30 persisted', 20000)
  if (!fs.existsSync(VAULT_JSON)) {
    die('建库后盘上没有 ' + VAULT_JSON + '（主进程说成功了，就要回答它写到哪去了）')
  }
  const mode = (fs.statSync(VAULT_JSON).mode & 0o777).toString(8)
  check('vault.json 权限 0600', mode === '600', mode)
  const cfg = JSON.parse(vaultOnDisk())
  check('落盘字段齐：v/salt/wrappedDek/verifier/autoLockMin/kdf/recovery',
    cfg.v === 1 && !!cfg.salt && !!cfg.wrappedDek && !!cfg.verifier && cfg.autoLockMin === 30 &&
      !!cfg.kdf && cfg.kdf.N === 32768 && !!cfg.recovery, Object.keys(cfg))
  check('scrypt 参数按主进程默认落盘（不是渲染层能挑的）',
    cfg.kdf.N === 32768 && cfg.kdf.r === 8 && cfg.kdf.p === 1, cfg.kdf)
  check('盘上没有主密码原文', vaultOnDisk().indexOf(PASS_1) < 0)
  check('盘上没有恢复码原文（存的是包好的 DEK）', vaultOnDisk().indexOf(code) < 0)
  check('恢复段也是"盐 + 封套"两段，不是明文字符串',
    /^[0-9a-f]+$/i.test(cfg.recovery.salt) && /^vlt1:/.test(cfg.recovery.wrappedDek), cfg.recovery)
  check('主密码没进 store（渲染层状态里没有它）',
    (await get('window.__vlt.storeHas(' + JSON.stringify(PASS_1) + ')')) === false)

  // 恢复码：复制 → 勾选 → 收起 → 再也拿不到
  await click('.vault-recovery-copy')
  await sleep(500)
  check('复制恢复码拿到的是同一串',
    String(await ev('window.pre.readClipboard()')).replace(/[^A-Z2-7]/g, '') === code)
  check('没勾"已抄下"时收不起来（不给假的退路）',
    await ev('window.__vlt.disabled(".vault-recovery-ack")') === true)
  await click('.vault-recovery-saved')
  await waitFor(cdp, '!document.querySelector(".vault-recovery-ack").disabled', 'ack enables after checkbox', 12000)
  await click('.vault-recovery-ack')
  await waitFor(cdp, '!window.__vlt.exists(".vault-recovery-code")', 'recovery block collapses', 12000)
  check('收起后界面不再显示恢复码', !(await ev('window.__vlt.exists(".vault-recovery-code")')))
  check('收起后整个 React 树里也不留原文（主进程本来就没第二份）',
    (await get('window.__vlt.leaked(' + JSON.stringify(code) + ')')) === 'clean')

  // ── 4. 底栏锁头：锁定 ────────────────────────────────────────────
  const chipUnlocked = await get('window.__vlt.chip()')
  check('建库后底栏出现锁头（解锁态）', !!chipUnlocked && /unlocked/.test(chipUnlocked.cls), chipUnlocked)
  await ev('window.store.hideSettingModal && window.store.hideSettingModal()')
  await sleep(700)
  const chip1 = await get('window.__vlt.chip()')
  await cdp.click(chip1.x, chip1.y)
  const popLock = await stable('window.__vlt.popOk()')
  check('解锁态点锁头要二次确认（不是点一下就锁）', !!popLock, popLock)
  await cdp.click(popLock.x, popLock.y)
  const lockedToast = await msgHas(msgRe('vaultLockedToast'))
  check('锁定后给出提示', !!lockedToast, lockedToast)
  await waitFor(cdp, 'window.__vlt.chipLocked() === true', 'chip turns locked', 20000)
  check('底栏锁头切到锁定态', (await get('window.__vlt.chipLocked()')) === true)
  await shot('footer-chip-locked')

  // ── 5. 错口令 → 仍锁着；对口令 → 解锁 ───────────────────────────
  await ev('window.__vlt.openSection()')
  await waitFor(cdp, 'window.__vlt.exists(".vault-unlock")', 'unlock block shows', 20000)
  check('锁定态同时给解锁表单与停用入口（忘口令的人有恢复码这条路）',
    !!(await ev('window.__vlt.exists(".vault-unlock")')) && !!(await ev('window.__vlt.exists(".vault-disable")')))
  check('解锁表单不给免检入口：没填就不能提交', await ev('window.__vlt.disabled(".vault-unlock")') === true)
  await ev('window.__vlt.fill(".vault-unlock-input","wrong-password-attempt")')
  await click('.vault-unlock')
  await waitFor(cdp, 'window.__vlt.exists(".vault-error")', 'error alert shows', 15000)
  const errText = await ev('window.__vlt.text(".vault-error")')
  check('错口令报"主密码不对"（不是笼统一句失败）',
    anyOf(errText, '主密码不对', /Wrong master password/i), errText)
  const tagLocked = await ev('window.__vlt.stateTag()')
  check('错口令后状态仍是已锁定', anyOf(tagLocked, '已锁定', /Locked/i), tagLocked)
  check('失败也不动盘上的库', fs.existsSync(VAULT_JSON))
  await shot('wrong-password')

  await ev('window.__vlt.fill(".vault-unlock-input",' + JSON.stringify(PASS_1) + ')')
  await click('.vault-unlock')
  await waitFor(cdp, 'window.__vlt.op("status").then(s => s.unlocked === true)', 'unlocked via settings', 20000)
  check('对口令解锁成功（主进程口径）', (await op('status')).unlocked === true)
  const unlockVal = await ev('window.__vlt.val(".vault-unlock-input")')
  // 解锁成功后整个表单换成管理视图，输入框是"没了"而不是"空了"：两种都算明文没留下
  check('解锁成功后输入框不再留明文', unlockVal === '' || unlockVal === null, unlockVal)
  check('解锁后整个 React 树里不留主密码',
    (await get('window.__vlt.leaked(' + JSON.stringify(PASS_1) + ')')) === 'clean')
  await shot('unlocked-tools')

  // ── 6. 换主密码 ──────────────────────────────────────────────────
  await waitFor(cdp, 'window.__vlt.exists(".vault-change")', 'change block shows', 15000)
  const cfgBeforeChange = vaultOnDisk()
  await ev('window.__vlt.fill(".vault-current",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-new",' + JSON.stringify(PASS_2) + ')')
  await ev('window.__vlt.fill(".vault-new2",' + JSON.stringify(PASS_2) + ')')
  await click('.vault-change')
  const changedToast = await msgHas(msgRe('vaultPasswordChanged'))
  check('换主密码成功并提示', !!changedToast, changedToast)
  check('换密码后库文件确实重写（包 DEK 那层换了）',
    fs.existsSync(VAULT_JSON) && vaultOnDisk() !== cfgBeforeChange)
  check('盘上没有新主密码原文', vaultOnDisk().indexOf(PASS_2) < 0)
  const oldTry = await op('unlock', { masterPassword: PASS_1 })
  check('旧主密码当场失效', oldTry.ok === false && oldTry.reason === 'wrong-password', oldTry)
  const newTry = await op('unlock', { masterPassword: PASS_2 })
  check('新主密码可用（库没重建，同一把 DEK）', newTry.ok === true && newTry.unlocked === true, newTry)

  // ── 7. 自动锁真到期（1 分钟，不碰鼠标键盘） ──────────────────────
  await ev('window.__vlt.openSection()')
  await waitFor(cdp, 'window.__vlt.exists(".vault-save-autolock")', 'autolock block shows', 15000)
  await ev('window.__vlt.fill(".vault-autolock-num","1")')
  check('自动锁输入框收得进 1 分钟', (await ev('window.__vlt.val(".vault-autolock-num")')) === '1')
  await click('.vault-save-autolock')
  const autoSaved = await msgHas(msgRe('vaultAutoLockSaved'))
  check('自动锁档位保存成功', !!autoSaved, autoSaved)
  check('自动锁回读为 1 分钟', (await op('status')).autoLockMin === 1)
  const t0 = Date.now()
  let expired = false
  while (Date.now() - t0 < 140000) {
    const s = await op('status')
    if (s.ok && s.unlocked === false) {
      expired = true
      break
    }
    await sleep(3000)
  }
  check('闲置到期后主进程回到锁定（DEK 已抹掉）', expired)
  // 到期是主进程单方面知道的：界面靠"用户一动就续期，续期被打回 → 重读状态"追上，
  // 所以这里先制造一次真实活动（点空白说明文字），再等锁头自己翻转
  await click('.vault-intro')
  const chipCaught = await waitFor(cdp, 'window.__vlt.chipLocked() === true', 'chip catches auto-lock expiry', 80000)
  check('到期后底栏锁头自己变锁定（不等用户点）', chipCaught === true, await get('window.__vlt.chip()'))
  await shot('auto-lock-expired')

  // ── 8. 恢复码解锁：格式判据 + 真码 + 临时可用提示 ─────────────────
  const recStatus = await op('status')
  check('库仍在（只是锁定）', recStatus.enabled === true && recStatus.unlocked === false, recStatus)
  await ev('window.__vlt.openSection()')
  // 锁是主进程自己翻的，设置页那份 status 是独立读的：总线不递一句，这里永远摆着"已解锁"
  const unlockFormShows = await waitFor(cdp, 'window.__vlt.exists(".vault-unlock-mode")', 'unlock mode switch shows', 25000)
  check('到期后设置页同步换成解锁表单（不是停在解锁视图）', unlockFormShows === true)
  await clickNth('.vault-unlock-mode .ant-radio-button-wrapper', 1)
  const showsTextarea = await waitFor(cdp,
    'window.__vlt.in(".vault-unlock-input").tagName === "TEXTAREA"', 'recovery textarea shows', 15000)
  check('切到"用恢复码"后输入框换成多行（粘整串不带拆行）', showsTextarea)
  const badFormat = await op('unlockWithRecovery', { recoveryCode: 'AAAAA-BBB' })
  // 抄漏一组是"长度不对"，不是"主密码不对"：长度判据在 scrypt 之前，一次 KDF 都不该白烧
  check('长度不对的恢复码先挡下（reason=bad-recovery-code，不进 scrypt）',
    badFormat.ok === false && badFormat.reason === 'bad-recovery-code', badFormat)
  const last = code[code.length - 1] === 'A' ? 'B' : 'A'
  const badCode = await op('unlockWithRecovery', { recoveryCode: code.slice(0, 51) + last })
  check('差一个字符的恢复码解不开（GCM tag 把关）',
    badCode.ok === false && badCode.reason === 'wrong-password', badCode)
  // 界面上拿不到原文（已收起），所以先用一次真码走 IPC 让库回到解锁，
  // 再由界面这条路验 needsNewPassword 提示：见下一段重建库
  const goodRecovery = await op('unlockWithRecovery', { recoveryCode: code })
  check('真恢复码解得开并标记"临时可用"',
    goodRecovery.ok === true && goodRecovery.needsNewPassword === true, goodRecovery)
  await op('lock')

  // ── 9. 停用 ──────────────────────────────────────────────────────
  await ev('window.__vlt.openSection()')
  await waitFor(cdp, 'window.__vlt.exists(".vault-disable")', 'disable block shows', 15000)
  check('没填身份凭据时停用按钮点不动', await ev('window.__vlt.disabled(".vault-disable")') === true)
  await ev('window.__vlt.fill(".vault-disable-pass","wrong-once-more")')
  await click('.vault-disable')
  const popBad = await stable('window.__vlt.popOk()')
  check('停用要确认（Popconfirm，不给点一下就删）', !!popBad, popBad)
  await cdp.click(popBad.x, popBad.y)
  await waitFor(cdp, 'window.__vlt.exists(".vault-error")', 'disable rejection shows', 15000)
  check('身份不过 → 拒绝停用且库还在',
    fs.existsSync(VAULT_JSON) && anyOf(await ev('window.__vlt.text(".vault-error")'), '主密码不对', /Wrong master password|failed|wrong/i))
  await ev('window.__vlt.fill(".vault-disable-pass",' + JSON.stringify(PASS_2) + ')')
  await click('.vault-disable')
  const popOk = await stable('window.__vlt.popOk()')
  await cdp.click(popOk.x, popOk.y)
  await waitFor(cdp, 'window.__vlt.exists(".vault-enable")', 'back to enable form', 20000)
  check('停用后回到未启用（给的是建库表单）', !!(await ev('window.__vlt.exists(".vault-enable")')))
  check('停用把 vault.json 删掉', !fs.existsSync(VAULT_JSON))
  check('停用后底栏锁头消失', (await get('window.__vlt.chip()')) === null)
  await shot('disabled-back-to-off')

  // ── 10. 读库失败 = 第四态 ────────────────────────────────────────
  writeVaultFile('{"v":1,"salt":"deadbeef"')
  await click('.vault-refresh')
  await waitFor(cdp, 'window.__vlt.exists(".vault-store-error")', 'store error shows', 20000)
  const errTag = await ev('window.__vlt.stateTag()')
  check('坏文件时状态不是"未启用"', zh(errTag).indexOf(zh('未启用')) < 0, errTag)
  check('坏文件时状态是"读不出来"',
    zh(errTag).indexOf(zh('保险库文件读不出来')) >= 0 || /unreadable|cannot be read/i.test(errTag), errTag)
  check('第四态给可读说明与重试入口',
    !!(await ev('window.__vlt.exists(".vault-store-error")')) &&
      !!(await ev('window.__vlt.text(".vault-store-error")')).length &&
      zh(await ev('window.__vlt.text(".vault-store-error")')).indexOf(zh('修复或还原')) >= 0,
    await ev('window.__vlt.text(".vault-store-error")'))
  const stBad = await op('status')
  check('主进程如实报 store-unavailable', stBad.ok === false && stBad.reason === 'store-unavailable', stBad)
  const badEnable = await op('enable', { masterPassword: PASS_1 })
  check('坏文件时不给人"顺手重建"（先报读不出来）',
    badEnable.ok === false && badEnable.reason === 'store-unavailable', badEnable)
  await shot('store-error-fourth-state')
  fs.rmSync(VAULT_JSON, { force: true })
  await click('.vault-refresh')
  await waitFor(cdp, 'window.__vlt.exists(".vault-enable")', 'back to off after removing bad file', 20000)
  check('文件没了就回到未启用（第四态不是死状态）',
    anyOf(await ev('window.__vlt.stateTag()'), '未启用', /Not enabled/i))

  // 重建一遍，把"界面里的恢复码解锁 + needsNewPassword"这条路验完
  await ev('window.__vlt.fill(".vault-pass",' + JSON.stringify(PASS_1) + ')')
  await ev('window.__vlt.fill(".vault-pass2",' + JSON.stringify(PASS_1) + ')')
  await click('.vault-enable')
  await waitFor(cdp, 'window.__vlt.exists(".vault-recovery-code")', 'recovery code shows again', 20000)
  const code2 = String(await ev('window.__vlt.text(".vault-recovery-code")')).replace(/[^A-Z2-7]/g, '')
  check('第二次建库给的是另一串恢复码（随机 DEK，不是复用）',
    /^[A-Z2-7]{52}$/.test(code2) && code2 !== code, code2.slice(0, 5) + '…')
  await click('.vault-recovery-saved')
  await waitFor(cdp, '!document.querySelector(".vault-recovery-ack").disabled', 'ack enabled again', 12000)
  await click('.vault-recovery-ack')
  await waitFor(cdp, '!window.__vlt.exists(".vault-recovery-code")', 'recovery collapsed again', 12000)

  await click('.vault-lock')
  await waitFor(cdp, 'window.__vlt.exists(".vault-unlock")', 'locked from settings', 20000)
  check('设置页"立即锁定"把库锁上且不给免检入口', (await op('status')).unlocked === false)
  await clickNth('.vault-unlock-mode .ant-radio-button-wrapper', 1)
  await waitFor(cdp, 'window.__vlt.in(".vault-unlock-input").tagName === "TEXTAREA"', 'recovery textarea again', 15000)
  await ev('window.__vlt.fill(".vault-unlock-input",' + JSON.stringify(code2) + ')')
  await click('.vault-unlock')
  const needsNew = await msgHas(msgRe('vaultNeedsNewPassword'))
  check('界面用恢复码解锁成功并提示"这是临时的"', !!needsNew, needsNew)
  await waitFor(cdp, 'window.__vlt.op("status").then(s => s.unlocked === true)', 'unlocked by recovery', 20000)
  check('恢复码解锁后 React 树里不留恢复码原文',
    (await get('window.__vlt.leaked(' + JSON.stringify(code2) + ')')) === 'clean')
  await shot('recovery-unlock-needs-new-password')

  // ── 11. 重启主进程：钥匙只在内存 ─────────────────────────────────
  const beforeRestart = vaultOnDisk()
  await killInstance(child)
  check('重启前调试口释放', await waitPortClosed())
  child = launch()
  cdp = await waitCdp()
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.translate', 'renderer boots after restart', 150000)
  await sleep(2500)
  await cdp.eval(PROBE)
  await ev('window.__vlt.patch()')
  cdp.events.length = 0
  check('重启后磁盘上的库一字不变', vaultOnDisk() === beforeRestart)
  const stRestart = await op('status')
  check('重启后必然回到锁定（DEK 没落盘，只能重新派生）',
    stRestart.enabled === true && stRestart.unlocked === false, stRestart)
  await waitFor(cdp, 'window.__vlt.exists(".vault-unlock-modal")', 'unlock prompt at start', 25000)
  check('启动时锁着会弹一次解锁（阶段① 允许取消）',
    !!(await ev('window.__vlt.exists(".vault-unlock-modal")')))
  await shot('restart-unlock-prompt')
  await ev('window.__vlt.fill(".vault-unlock-modal-input",' + JSON.stringify(PASS_1) + ')')
  await click('.vault-unlock-modal .ant-btn-primary')
  await waitFor(cdp, '!window.__vlt.exists(".vault-unlock-modal")', 'modal closes after unlock', 20000)
  check('弹窗里输入主密码可解锁', (await op('status')).unlocked === true)
  const chipAfterRestart = await get('window.__vlt.chip()')
  check('解锁后底栏锁头跟着变（弹窗关掉，不锁回去）',
    !!chipAfterRestart && /unlocked/.test(chipAfterRestart.cls), chipAfterRestart)
  const modalInputVal = await ev('window.__vlt.val(".vault-unlock-modal-input")')
  check('解锁后弹窗输入框不留明文（关掉或清空都算）',
    modalInputVal === '' || modalInputVal === null, modalInputVal)

  // ── 12. 泄漏审计 ─────────────────────────────────────────────────
  const appLog = fs.readFileSync(LOG_FILE, 'utf8')
  check('主日志里没有主密码也没有恢复码原文',
    appLog.indexOf(PASS_1) < 0 && appLog.indexOf(PASS_2) < 0 &&
      appLog.indexOf(code) < 0 && appLog.indexOf(code2) < 0)
  check('主日志只记动作与原因（确有 [vault] 行）',
    /\[vault\] (status|unlock|lock|enable|disable|changePassword|setAutoLock)/.test(appLog),
    (appLog.match(/\[vault\][^\n]*/g) || []).slice(-3))
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
    return t.indexOf(PASS_1) >= 0 || t.indexOf(PASS_2) >= 0 || t.indexOf(code) >= 0 || t.indexOf(code2) >= 0
  })
  check('DATA_PATH 下 ' + files.length + ' 个文件都没有主密码/恢复码原文', leaks.length === 0, leaks)
  check('渲染层 React 树里没有主密码', (await get('window.__vlt.leaked(' + JSON.stringify(PASS_1) + ')')) === 'clean')
  check('界面上任何地方都没把恢复码打印出来（收起后）',
    (await ev('window.__vlt.bodyHas(' + JSON.stringify(code2) + ')')) === false)
  check('全程无未捕获前端错误', errEvents().length === 0, errEvents().slice(0, 3))

  // ── 13. IPC 白名单 + 主题 ────────────────────────────────────────
  const protoAction = await op('constructor')
  check('非白名单动作（constructor）被拒',
    protoAction.ok === false && protoAction.reason === 'unknown-action', protoAction)
  const protoArg = await op('unlock', { masterPassword: { toString: 1 } })
  check('参数形状不对也只是解不开，不会走偏', protoArg.ok === false, protoArg)
  check('白名单动作照常可用', (await op('status')).ok === true)

  // 深浅对比要看真的面板：重启那一段把设置页关掉了，先重新打开再取色，
  // 否则两次都取到 null，"颜色不同"会假成一条永远成立的判据
  await ev('window.__vlt.openSection()')
  const panelUp = await waitFor(cdp, '!!window.__vlt.in(".setting-vault")', 'vault section open', 20000)
  check('重启后仍能重新打开保险库这一节', panelUp === true)
  const darkBg = await ev('window.__vlt.panelColors()')
  // 浅色主题 id 是 defaultLight（不是 'light'），传错等于没切
  await ev('window.store.setTheme && window.store.setTheme("defaultLight")')
  await sleep(900)
  const lightBg = await ev('window.__vlt.panelColors()')
  check('面板颜色跟主题 token 走（深浅不同）', !!darkBg && darkBg !== lightBg, { darkBg, lightBg })
  await shot('settings-light')
  await ev('window.__vlt.unpatch()')

  const fail = results.filter(r => !r.ok)
  console.log('\n==== G6-4 结论 ====')
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
  // ws 会挂住事件循环，跑完必须显式退出（否则 timeout 会把绿判据压成 124）
  process.exit(fail.length ? 1 : 0)
}

main().catch(err => {
  // 崩了也要把实例日志的尾巴带出来：只留"哪条判据抛异常"看不出主进程那侧发生了什么
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')
    console.error('---- 实例日志尾巴 ----\n' + tail)
  } catch (e) { /* 还没起实例就崩了 */ }
  die((err && err.stack) || String(err))
})
