#!/usr/bin/env node
/**
 * ssh configs 导入去重 —— 真实例端到端验收
 *
 * 单测（src/test/unit-ci/ssh-config-import.spec.js）钉的是判据层与接线契约；
 * 这里验只有"真渲染 + 真磁盘 + 真 store + 真点按钮"才看得见的东西：
 *   1) 临时 HOME 的 ~/.ssh/config 摆 4 个 Host 块（1 对完全重复）+ Host * 全局块：loader 收合成 3 台
 *   2) 首次导入：一台一条书签，都带 importedFrom=sshConfig，全部落进 "ssh configs" 分组
 *   3) 手工书签同 host/user/port 也不参与去重：既不被合并，也不会挡住自动导入
 *   4) 再点一次导入：一条都不加（addSshConfigs 回 0），分组里的 id 不重复
 *   5) 导入弹窗里"导入"按钮灰掉 + 给一句"没有新增"
 *   6) 往 config 追加一台新主机 → 重载 → 只有新增那台可导入，导入只 +1
 *   7) 清掉"已导入过"的本地标记（真重启的等价物）：没有新增时不再弹导入提示，
 *      但配置里真来了新主机时提示必须重新出现（别把提示顺手关掉）
 *
 * 凭据：无 —— 临时 HOME + 临时 DATA_PATH，主机名是现编的假地址，不连任何机器。
 *
 * 用法：
 *   1) 渲染层改过就 npm run vite-build
 *   2) 主进程侧同步：cp src/app/common/locales-extra.js work/app/common/
 *   3) Xvfb <display> 起好（默认 :153）
 *   4) node self-test/ssh-config-import-demo.js [display] [port] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9248'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/ssh-config-import-shots')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-sshcfg-'))
const HOME = path.join(RUN, 'home')
const SSH_DIR = path.join(HOME, '.ssh')
const SSH_CONFIG = path.join(SSH_DIR, 'config')
const DATA = path.join(RUN, 'data')
const LOG_FILE = path.join(RUN, 'app.log')
let childPid = null

// 4 个 Host 块：1 对完全重复；再加 Host * 全局块（不该变成书签）→ loader 应给 3 台
const BASE_CONFIG = [
  'Host demo-alpha',
  '  HostName alpha.example.com',
  '  User alice',
  '  Port 22',
  '',
  'Host demo-alpha',
  '  HostName alpha.example.com',
  '  User alice',
  '',
  'Host demo-beta',
  '  HostName 10.0.0.7',
  '  User bob',
  '  Port 2207',
  '',
  'Host demo-gamma',
  '  HostName gamma.example.com',
  '  User carol',
  '',
  'Host *',
  '  IdentityFile ~/.ssh/id_ed25519',
  '  ServerAliveInterval 30',
  ''
].join('\n')

const withHost = (name, host, user, port) => BASE_CONFIG + [
  'Host ' + name,
  '  HostName ' + host,
  '  User ' + user,
  '  Port ' + port,
  ''
].join('\n')

const keyOf = (user, host, port) => user + '@' + host + ':' + port
const KEY_ALPHA = keyOf('alice', 'alpha.example.com', '22')
const KEY_BETA = keyOf('bob', '10.0.0.7', '2207')
const KEY_GAMMA = keyOf('carol', 'gamma.example.com', '22')
const BASE_KEYS = [KEY_ALPHA, KEY_BETA, KEY_GAMMA].sort()

function writeConfig (text) {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(SSH_CONFIG, text, 'utf8')
  fs.chmodSync(SSH_CONFIG, 0o600)
}

function launch () {
  writeConfig(BASE_CONFIG)
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

/** 只杀自己起的进程组（detached），绝不按端口/pkill 匹配 —— 并行会话的实例还在跑 */
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
    console.error('日志尾巴：\n' + fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-20).join('\n'))
  } catch (e) {
    console.error('日志读不出来：' + e.message)
  }
  if (process.env.KEEP_TMP) {
    console.error('临时目录保留以便排查：' + RUN)
  } else {
    try {
      // 刚 SIGTERM 完，electron 子进程还在往 DATA 里落最后一笔：硬删会撞 ENOTEMPTY
      fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (e) {
      console.error('临时目录没删干净（不影响上面的判据）：' + e.message + ' -> ' + RUN)
    }
  }
  process.exit(1)
}

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
 * 页内探针：书签与分组是 store 里的纯数据，直接读比数 DOM 行准；
 * 按钮状态/提示条走稳定类名 + 词条正则，改文案不会把判据带倒。
 */
const PROBE = `
(() => {
  const v = {}
  const vis = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return false
      n = n.parentElement
    }
    return true
  }
  const all = (sel) => [...document.querySelectorAll(sel)].filter(vis)
  v.in = (sel) => all(sel)[0] || null
  v.exists = (sel) => !!v.in(sel)
  v.text = (sel) => {
    const el = v.in(sel)
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  }
  // 弹窗里刷新/导入/取消三颗并排按钮共用一套工具类：按文案找，不按 nth 找。
  // 中文两字按钮 antd 会自动插一个空格（"导 入"），比对必须把空白全去掉。
  const flat = (s) => String(s || '').replace(/\\s+/g, '')
  const byText = (sel, text) => all(sel).find(b => flat(b.innerText) === flat(text))
  v.xyByText = (sel, text) => {
    const el = byText(sel, text)
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    const b = el.getBoundingClientRect()
    const out = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    out.onScreen = out.y > 0 && out.y < window.innerHeight && out.x > 0 && out.x < window.innerWidth
    return out
  }
  v.dumpByText = (sel) => JSON.stringify(all(sel).map(b => flat(b.innerText)))
  v.disabledByText = (sel, text) => {
    const el = byText(sel, text)
    return el ? !!el.disabled : null
  }
  const key = (b) => String(b.username || '') + '@' + String(b.host || '') + ':' + String(b.port || '')
  // 文案一律从页面现取（window.translate 就是组件用的那个）：手抄一句中文
  // 会在换语言或改词条时把一个正常功能判成坏掉
  v.t = (tk) => window.translate(tk)
  // 命不中词条时 window.translate 会原样回 key：那正是"本地化漏了"，要单独报出来
  v.untranslated = (tk) => flat(window.translate(tk)) === flat(tk)
  v.sshNotifyShown = () => {
    const want = flat(window.translate('loadSshConfigs'))
    if (!want || flat(window.translate('loadSshConfigs')) === flat('loadSshConfigs')) return 'UNTRANSLATED'
    return all('.notification-title').some(n => flat(n.innerText) === want)
  }
  v.snap = () => {
    const store = window.store
    const g = (store.bookmarkGroups || []).find(d => d.id === 'sshConfig')
    const ids = (g && g.bookmarkIds) || []
    const byId = new Map(store.bookmarks.map(b => [String(b.id), b]))
    const inGroup = ids.map(id => byId.get(String(id))).filter(Boolean)
    return {
      sshConfigs: (store.sshConfigs || []).length,
      bookmarks: store.bookmarks.length,
      ids: ids.length,
      uniqueIds: new Set(ids.map(String)).size,
      dangling: ids.filter(id => !byId.has(String(id))).length,
      marked: store.bookmarks.filter(b => b.importedFrom === 'sshConfig').length,
      keys: inGroup.map(key).sort(),
      dupKeys: inGroup.map(key).length - new Set(inGroup.map(key)).size,
      groupExists: !!g,
      groupTitle: g ? g.title : null
    }
  }
  // 手工书签：和 demo-alpha 同 user/host/port，但没有来源标记 —— 自动去重不许碰它
  v.addManual = () => {
    window.store.addItems([{
      term: 'xterm-256color',
      id: 'manual-dup-for-dedupe',
      type: 'ssh',
      color: '#cc0000',
      host: 'alpha.example.com',
      port: 22,
      username: 'alice',
      authType: 'password',
      title: 'manual-same-host'
    }], 'bookmarks')
    return 'ok'
  }
  v.manual = () => {
    const b = (window.store.bookmarks || []).find(x => x.id === 'manual-dup-for-dedupe')
    if (!b) return null
    const g = (window.store.bookmarkGroups || []).find(d => d.id === 'sshConfig')
    return {
      host: b.host,
      port: b.port,
      inGroup: !!(g && (g.bookmarkIds || []).map(String).includes('manual-dup-for-dedupe')),
      marked: b.importedFrom === 'sshConfig'
    }
  }
  v.notifyTitles = () => [...document.querySelectorAll('.notification-title')]
    .filter(vis)
    .map(n => n.innerText.replace(/\\s+/g, ' ').trim())
  // 这个 Modal 组件 footer 为 null，三颗按钮都落在 .custom-modal-body 里
  v.importDisabled = () => v.disabledByText('.custom-modal-body button', window.translate('import'))
  v.hintShown = () => v.exists('.ssh-config-nothing-new')
  v.hintText = () => {
    const el = v.in('.ssh-config-nothing-new')
    if (!el) return 'MISSING'
    if (v.untranslated('sshConfigNothingNew')) return 'UNTRANSLATED'
    return flat(el.innerText) === flat(window.translate('sshConfigNothingNew'))
      ? el.innerText.trim()
      : 'MISMATCH:' + el.innerText
  }
  v.openBookmarksTab = () => {
    window.store.storeAssign({ settingTab: 'bookmarks' })
    window.store.openSettingModal()
    return 'ok'
  }
  v.closeModals = () => {
    window.store.showModal = 0
    window.store.showSshConfigModal = false
    return 'ok'
  }
  v.openSshModal = () => {
    window.store.showSshConfigModal = true
    return 'ok'
  }
  // 清掉"这次已经问过了"的本地标记：等价于应用重启后重新问一遍
  v.clearFlags = () => {
    localStorage.removeItem('ssh-config-loaded')
    localStorage.removeItem('ignore-ssh-config')
    return JSON.stringify({
      loaded: localStorage.getItem('ssh-config-loaded'),
      ignore: localStorage.getItem('ignore-ssh-config')
    })
  }
  v.flags = () => JSON.stringify({
    loaded: localStorage.getItem('ssh-config-loaded'),
    ignore: localStorage.getItem('ignore-ssh-config')
  })
  v.reimport = () => window.store.addSshConfigs(window.store.sshConfigs)
  window.__sci = v
  return 'ok'
})()
`

async function main () {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const child = launch()
  const cdp = await waitCdp()
  const { check, results } = makeChecker()
  let shotIdx = 0
  const shot = async (name) => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(320)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }
  const ev = async (expr) => cdp.eval(expr)
  const get = async (expr) => JSON.parse(String(await ev('JSON.stringify(((' + expr + ')))')))
  const clickAt = async (selExpr, label, dumpExpr) => {
    const xy = await get(selExpr)
    if (!xy) {
      // 找不到点得到时先把候选文案打出来：不然只知道"没点到"，不知道找错还是没渲染
      const dump = dumpExpr ? await get(dumpExpr) : null
      die('click target missing: ' + label + (dump ? ' 候选=' + JSON.stringify(dump) : ''))
    }
    if (xy.onScreen === false) {
      die('click target off-screen: ' + label + ' ' + JSON.stringify(xy))
    }
    await sleep(260)
    await cdp.click(xy.x, xy.y)
    await sleep(400)
    return true
  }
  const xyBtn = (text, scope) => 'window.__sci.xyByText(' +
    JSON.stringify(scope || '.custom-modal-body button') + ',' + JSON.stringify(text) + ')'
  const dumpBtns = (scope) => 'window.__sci.dumpByText(' + JSON.stringify(scope) + ')'
  const snap = () => get('window.__sci.snap()')
  const titles = () => get('window.__sci.notifyTitles()')
  const notifyShown = async () => (await get('window.__sci.sshNotifyShown()')) === true

  // CDP 的 page target 在文档刚开始加载时就有了：探针和判据都读 window.translate，
  // 早一步挂上去就是 "window.translate is not a function"（第二轮就死在这）
  const booted = await waitFor(cdp,
    'typeof window.translate === "function" && !!window.store && Array.isArray(window.store.bookmarkGroups)',
    'renderer booted', 60000)
  if (booted !== true) {
    die('渲染层 60s 内没起好（window.translate / window.store 有一个还没挂上）')
  }
  check('探针挂上', await ev(PROBE) === 'ok')
  // 判据全靠页面现取的文案：词条缺一种语言时 window.translate 回 key 原文，先把这条钉住
  check('用到的词条在当前语言里都有译文',
    await get('["loadSshConfigs","sshConfigNothingNew","import","reload"].every(k => window.__sci.untranslated(k) === false)') === true,
    await get('["loadSshConfigs","sshConfigNothingNew","import","reload"].map(k => k + "=" + window.__sci.t(k))'))

  // 启动时 sshConfigs 由主进程读 ~/.ssh/config 异步灌进来，先等它落地
  const ready = await waitFor(cdp, 'window.store.sshConfigs && window.store.sshConfigs.length > 0', 'sshConfigs loaded', 45000)
  const s0 = await snap()
  check('临时 HOME 的 ~/.ssh/config 被读到', ready === true && s0.sshConfigs > 0, s0)
  check('重复 Host 块与 Host * 由 loader 收合成 3 台', s0.sshConfigs === 3, s0)
  check('起底没有 ssh configs 分组（新库干净）', s0.groupExists === false, s0)

  // 手工书签先落地：同 user/host/port，用来验"自动去重只管 ssh-config 来源"
  await get('window.__sci.addManual()')
  await sleep(300)
  const s1 = await snap()
  check('同 host 的手工书签加上了', s1.bookmarks === s0.bookmarks + 1, s1)

  // 提示条：设置弹窗 + 书签页签才会问
  await get('window.__sci.openBookmarksTab()')
  const notified = await waitFor(cdp, 'window.__sci.notifyTitles().length > 0', 'ssh config notification', 15000)
  check('没导入过时弹出导入提示', notified === true && await notifyShown(), await titles())
  await shot('notify-first-time')

  const importLabel = await get('window.translate("import")')
  await clickAt(xyBtn(importLabel, '.notification-description button'),
    'notification import button', dumpBtns('.notification-description button'))
  check('点提示条的"导入"会把弹窗打开', await get('window.__sci.exists(".custom-modal-body")') === true)
  await shot('import-modal')

  // 弹窗里点"导入"：走 handleLoadSshConfig → store.addSshConfigs
  await clickAt(xyBtn(importLabel), 'modal import button', dumpBtns('.custom-modal-body button'))
  await waitFor(cdp, 'window.store.bookmarkGroups.some(g => g.id === "sshConfig")', 'group created', 15000)
  const s2 = await snap()
  check('首次导入：一台一条书签（+3）', s2.bookmarks === s1.bookmarks + 3, s2)
  check('导入的书签都带来源标记 importedFrom=sshConfig', s2.marked === 3, s2)
  check('分组里正好这 3 台，id 与键都不重复',
    s2.ids === 3 && s2.uniqueIds === 3 && s2.dupKeys === 0 && s2.dangling === 0, s2)
  check('分组内容 = 3 台主机',
    JSON.stringify(s2.keys) === JSON.stringify(BASE_KEYS), s2)
  check('导入会建出 "ssh configs" 分组',
    s2.groupExists === true && s2.groupTitle === 'ssh configs', s2)
  const m1 = await get('window.__sci.manual()')
  check('同 host 的手工书签没被合并、也没被拉进分组',
    m1 && m1.inGroup === false && m1.marked === false, m1)

  // 再点一次：addSshConfigs 自己回 0，列表一个字节都不动
  const again = await get('window.__sci.reimport()')
  await sleep(400)
  const s3 = await snap()
  check('程序化再导入回 0（一条都没新增）', again === 0, again)
  check('再导入后书签/分组数量纹丝不动',
    s3.bookmarks === s2.bookmarks && s3.ids === s2.ids && s3.dupKeys === 0, s3)

  // 弹窗重开：按钮灰掉 + 一句话
  await get('window.__sci.openSshModal()')
  await sleep(800)
  const dis = await get('window.__sci.importDisabled()')
  check('全部导入过时"导入"按钮灰掉', dis === true, dis)
  const hintText = await get('window.__sci.hintText()')
  check('灰掉的同时给一句"没有新增"（文案就是词条本身）',
    !!hintText && !/^(MISMATCH|MISSING|UNTRANSLATED)/.test(String(hintText)), hintText)
  await shot('nothing-new')
  await get('window.__sci.closeModals()')
  await sleep(300)

  // 追加一台新主机 → 重载 → 只有新增那台可导入
  writeConfig(withHost('demo-delta', 'delta.example.com', 'dave', '22'))
  await get('window.__sci.openSshModal()')
  await sleep(500)
  await clickAt(xyBtn(await get('window.translate("reload")')), 'reload button', dumpBtns('.custom-modal-body button'))
  await waitFor(cdp, 'window.store.sshConfigs.length === 4', 'reload picks up the new host', 20000)
  const s4 = await snap()
  check('重载后本地配置读到 4 台', s4.sshConfigs === 4, s4)
  const dis2 = await get('window.__sci.importDisabled()')
  check('有新增时"导入"按钮重新可点', dis2 === false, dis2)
  check('有新增时不再摆"没有新增"那句话', await get('window.__sci.hintShown()') === false)
  await shot('one-new-host')
  await clickAt(xyBtn(importLabel), 'import button (one new)', dumpBtns('.custom-modal-body button'))
  await waitFor(cdp, '(window.store.bookmarkGroups.find(g => g.id === "sshConfig") || {bookmarkIds:[]}).bookmarkIds.length === 4', 'second import lands', 20000)
  const s5 = await snap()
  check('第二次导入只加新增那台（书签 +1）',
    s5.bookmarks === s4.bookmarks + 1 && s5.marked === 4, s5)
  check('分组里是 4 台，仍无重复键',
    s5.dupKeys === 0 && s5.uniqueIds === 4 &&
      JSON.stringify(s5.keys) === JSON.stringify([...BASE_KEYS, keyOf('dave', 'delta.example.com', '22')].sort()), s5)
  await get('window.__sci.closeModals()')
  await sleep(300)

  // 真重启的等价物：清掉本地标记，重开书签页 → 没有新增就不该再问
  const flags = JSON.parse(String(await get('window.__sci.clearFlags()')))
  check('本地标记确实清了', flags.loaded === null && flags.ignore === null, flags)
  await get('window.__sci.openBookmarksTab()')
  await sleep(1200)
  const notifiedAgain = await notifyShown()
  check('没有新增时不再弹导入提示（不再反复骚扰）', notifiedAgain === false, await titles())
  await shot('no-notify-when-nothing-new')

  // 反证：配置里真来了新主机时提示必须重新出现（不是一刀切把提示关掉）
  await get('window.__sci.closeModals()')
  writeConfig(withHost('demo-delta', 'delta.example.com', 'dave', '22') + [
    'Host demo-epsilon',
    '  HostName epsilon.example.com',
    '  User erin',
    '  Port 22',
    ''
  ].join('\n'))
  await ev('window.store.fetchSshConfigItems()')
  await waitFor(cdp, 'window.store.sshConfigs.length === 5', 'a fifth host shows up', 20000)
  await get('window.__sci.openBookmarksTab()')
  const backAgain = await waitFor(cdp, 'window.__sci.notifyTitles().length > 0', 'notification returns after a new host', 15000)
  check('真来了新主机时提示重新出现', backAgain === true && await notifyShown(), await titles())
  await shot('notify-returns-with-new-host')

  console.log('\n==== ssh-config 导入去重 结论 ====')
  const fail = results.filter(r => !r.ok)
  console.log('pass ' + (results.length - fail.length) + '/' + results.length)
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
    console.error('---- 实例日志尾巴 ----\n' + fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n'))
  } catch (e) { /* 还没起实例就崩了 */ }
  die((err && err.stack) || String(err))
})
