#!/usr/bin/env node
/**
 * G7-4 SSH 密钥设置面板 —— 真实例 CDP 验收
 *
 * 单测钉的是判据层（ssh-keygen.spec）、落盘与 known_hosts 读写（ssh-keygen-server.spec）、
 * 接线契约（setting-ssh-key.spec）。这里验只有真渲染 + 真磁盘才看得见的东西：
 *   1) 设置里能真的打开这一节（列表由代码派生，老用户无需迁移）
 *   2) 面板指纹 = 系统 ssh-keygen -lf 的指纹（同一套 wire 字节，不是自算的另一种）
 *   3) 口令不一致 / 口令太短 / 名字带斜杠 / 同名已存在 —— 各自的拒绝路径与「磁盘上没留东西」
 *   4) 生成的私钥权限 0600、公钥 0644、目录 0700；系统 ssh-keygen -y 能读回同一行公钥
 *   5) 带口令的密钥：不给口令读不出来，给了才读得出（真加密，不是贴个标签）
 *   6) 回填书签：写路径 + 清掉粘贴内容（内容优先于路径，不清就等于没换密钥）
 *   7) 删单条 known_hosts 走 Popconfirm，删完只剩该行被删、其余原样
 *   8) 面板外的改动让行号失效 → 如实提示 stale 且一个字符都不删
 *   9) 没有「清空全部」按钮；哈希条目只显指纹、畸形条目删不掉也显式说明
 *
 * 凭据：无 —— 只碰临时 HOME 下的自建文件。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/common/ work/app/common/
 *   2) HOME=<临时> DISPLAY=<xvfb> 起带 --remote-debugging-port 的实例
 *   3) node self-test/ssh-key-settings-demo.js [debugPort] [home] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const PORT = process.argv[2] || '9231'
const HOME = process.argv[3] || '/tmp/electerm-g7-home'
const SHOT_DIR = process.argv[4] || path.join(__dirname, 'g74-shots')
const SSH_DIR = path.join(HOME, '.ssh')
const KNOWN = path.join(SSH_DIR, 'known_hosts')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-g74-'))
const KEYGEN = '/usr/bin/ssh-keygen'
const HAS_KEYGEN = fs.existsSync(KEYGEN)

const zh = (s) => String(s == null ? '' : s).split(' ').join('')

/**
 * 页内探针：面板在设置弹层里，取值全靠稳定类名。
 * 顺手把 sshKeyOp 的调用记下来 —— 「拒绝在发请求之前」这种判据，
 * 只有看见请求根本没发出去才算数。
 */
const PROBE = `
(() => {
  const sk = { calls: [], orig: null }
  sk.patch = () => {
    if (sk.orig) return 'already'
    sk.orig = window.pre.runGlobalAsync
    window.pre.runGlobalAsync = function (name, ...args) {
      if (name === 'sshKeyOp') {
        sk.calls.push({ action: args[0], arg: JSON.parse(JSON.stringify(args[1] === undefined ? null : args[1])) })
      }
      return sk.orig.apply(this, [name].concat(args))
    }
    return window.pre.runGlobalAsync !== sk.orig ? 'ok' : 'not-writable'
  }
  sk.unpatch = () => {
    if (sk.orig) { window.pre.runGlobalAsync = sk.orig; sk.orig = null }
    return 'ok'
  }
  sk.reset = () => { sk.calls.length = 0; return 'ok' }
  const vis = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return false
      n = n.parentElement
    }
    return true
  }
  sk.root = () => [...document.querySelectorAll('.setting-ssh-key')].filter(vis)[0] || null
  sk.in = (sel) => {
    const el = [...document.querySelectorAll(sel)].filter(vis)
    return el.length ? el[0] : null
  }
  sk.inRoot = (sel) => {
    const r = sk.root()
    return r ? [...r.querySelectorAll(sel)].filter(vis)[0] || null : null
  }
  sk.text = sel => {
    const el = sk.in(sel)
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  }
  sk.xy = (sel) => {
    const el = sk.in(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return Math.round(b.x + 30) + ',' + Math.round(b.y + b.height / 2)
  }
  sk.xyBox = (sel) => {
    const el = sk.in(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  }
  sk.messages = () => [...document.querySelectorAll('.message-item')]
    .map(m => m.className.replace('message-item ', '') + '::' +
      (m.querySelector('.message-content') || { innerText: '' }).innerText.replace(/\\s+/g, ' ').trim())
  sk.rows = () => [...document.querySelectorAll('.ssh-key-known-row')].map(r => {
    const q = c => r.querySelector(c)
    const del = q('.ssh-key-known-del')
    const b = del ? del.getBoundingClientRect() : null
    return {
      host: q('.ssh-key-known-host').innerText.trim(),
      hostTitle: q('.ssh-key-known-host').getAttribute('title'),
      alg: q('.ssh-key-known-alg').innerText.trim(),
      fp: q('.ssh-key-known-fp').innerText.trim(),
      marker: q('.ssh-key-known-marker').innerText.trim(),
      delDisabled: !!del.disabled,
      copyDisabled: !!q('.ssh-key-known-copy').disabled,
      xy: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    }
  })
  // className 可能落在 antd 包装层（Password 的 affix wrapper）或直接落在
  // input/textarea 上，两种都要认
  const field = el => {
    if (!el) return null
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el
    return el.querySelector('input, textarea')
  }
  sk.fill = (sel, value) => {
    const el = field(sk.in(sel))
    if (!el) return 'no-input:' + sel
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  sk.val = (sel) => {
    const el = field(sk.in(sel))
    return el ? el.value : null
  }
  sk.openSection = () => {
    const { store } = window
    const item = store.getItems('setting').find(d => d.id === 'setting-ssh-key')
    if (!item) return 'no-section'
    store.settingTab = 'setting'
    store.setSettingItem(item)
    store.openSettingModal()
    if (store.isMobile) store.settingMobileView = 'content'
    return 'ok'
  }
  sk.bm = () => {
    const s = window.store.bookmarks.find(b => b.id === window.__skBmId)
    return s ? {
      id: s.id, privateKeyPath: s.privateKeyPath || '', privateKeyLen: (s.privateKey || '').length,
      authType: s.authType || ''
    } : null
  }
  sk.panelBg = () => {
    const r = sk.root()
    return r ? getComputedStyle(r).backgroundColor + '|' + getComputedStyle(r).color : null
  }
  sk.hasClearAll = () => {
    const r = sk.root()
    if (!r) return null
    const txt = [...r.querySelectorAll('button')].map(b => b.innerText.trim() + ' ' + (b.title || ''))
    return txt.some(t => /清空|清除全部|clear all|clear all known/i.test(t))
  }
  window.__sk = sk
  return 'ok'
})()
`

/** 独立真值：系统 ssh-keygen -lf 自己算的指纹，跟我们面板显示的对照 */
function systemFingerprint (name, pubLine) {
  const f = path.join(TMP, name)
  fs.writeFileSync(f, pubLine + '\n')
  const out = execFileSync(KEYGEN, ['-lf', f], { encoding: 'utf8' })
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(out)
  if (!m) {
    throw new Error('no fingerprint from ssh-keygen: ' + out)
  }
  return m[1]
}

function keygen (args, opts = {}) {
  return execFileSync(KEYGEN, args, { encoding: 'utf8', ...opts })
}

function mode (p) {
  return (fs.statSync(p).mode & 0o777).toString(8)
}

function seedKnownHosts (lines) {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(KNOWN, lines.join('\n'), { mode: 0o600 })
}

const main = async () => {
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
  // 事件缓冲不清空会把上一轮（甚至上一批次）的报错算进本次判据
  cdp.events.length = 0
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
  })

  // ── 磁盘侧真值：临时 HOME 下的 ~/.ssh 每次从零开始 ──────────────
  fs.rmSync(SSH_DIR, { recursive: true, force: true })
  const { generateKeyPairSync } = require(path.join(ROOT, 'node_modules/@electerm/ssh2')).utils
  const mk = (tag) => generateKeyPairSync('ed25519', { comment: tag }).public
  const pubA = mk('g7-alpha')
  const pubB = mk('g7-beta')
  const pubC = mk('g7-gamma')
  const pubD = mk('g7-delta')
  // ssh-ed25519 <base64 wire> <comment>：取第 2 段（split 下标 1）才是 wire 字节
  const b64 = (line) => line.split(' ')[1]
  const salt = require('crypto').randomBytes(16).toString('base64')
  const hash = require('crypto').randomBytes(20).toString('base64')
  const SEED = [
    '# electerm g7 self-test seed',
    '',
    'g7-alpha.example ' + pubA,
    'g7-beta.example,g7-gamma.example ' + pubB,
    '|1|' + salt + '|' + hash + ' ssh-ed25519 ' + b64(pubC),
    '@revoked g7-delta.example ' + pubD,
    'g7-broken.example ssh-ed25519 not!base64!at!all'
  ]
  seedKnownHosts(SEED)

  await cdp.call('Page.reload', { ignoreCache: true })
  // 只等 store/pre 会踩空：重载前旧文档里这两个早就在，判据当场通过
  await waitFor(cdp, '!!window.store && !!window.pre && !!window.translate', 'renderer boots', 120000)
  await sleep(2000)
  // 探针必须在重载之后注入（reload 会清掉上一次文档里的 window.__sk）
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
  const jev = async expr => cdp.jeval(expr)
  const texts = () => jev('JSON.stringify(window.__sk.messages())')
  const msgHas = async (re, label) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      const arr = await texts()
      if (arr.some(t => re.test(t))) {
        return arr.find(t => re.test(t))
      }
      await sleep(150)
    }
    return null
  }
  const click = async (sel) => {
    const xy = await jev('JSON.stringify(window.__sk.xyBox(' + JSON.stringify(sel) + '))')
    if (!xy) {
      return false
    }
    await cdp.click(xy.x, xy.y)
    await sleep(320)
    return true
  }
  // rc-motion 的浮层刚出现时量到的是动画中间值，坐标连续两次一致才算数
  const stableXY = async (expr, tries = 14) => {
    let prev = null
    for (let i = 0; i < tries; i++) {
      const cur = await ev(expr)
      if (prev !== null && cur === prev && String(cur).indexOf('null') < 0) {
        return JSON.parse(cur)
      }
      prev = cur
      await sleep(180)
    }
    return null
  }

  check('探针挂上', await ev('window.__sk.patch()') === 'ok')
  await ev("window.store.addItem({ id: 'g74-demo-bm', title: 'g74-demo-host', type: 'ssh', host: 'g74-demo.example', port: 22, username: 'demo', authType: 'privateKey', privateKey: 'PASTED-PRIVATE-KEY-CONTENT' }, 'bookmarks')")
  await ev("window.__skBmId = 'g74-demo-bm'")
  await sleep(300)

  check('设置里能打开 SSH 密钥这一节', await ev('window.__sk.openSection()') === 'ok')
  await waitFor(cdp, '!!window.__sk.root()', 'ssh key section renders', 20000)
  check('面板挂载', await ev('!!window.__sk.root()'))
  await shot('section-open')

  // ── 1. known_hosts 列表面板 ─────────────────────────────────────
  let rows = await jev('JSON.stringify(window.__sk.rows())')
  check('注释与空行不进列表（7 行文件 → 5 条）', rows.length === 5, rows.map(r => r.host))
  const idxA = rows.findIndex(r => zh(r.host).indexOf('g7-alpha') >= 0)
  check('列表顺序与文件行序一致（alpha 打头 → 第 3 行被认出）',
    idxA === 0 && rows[1] && zh(rows[1].host).indexOf('g7-beta') === 0, rows.map(r => r.host))
  check('明文条目主机名照实显示', idxA >= 0 && zh(rows[idxA].host) === zh('g7-alpha.example'))
  check('多主机条目把整行主机字段都列出来',
    zh(rows[idxA + 1].host) === zh('g7-beta.example,g7-gamma.example'))
  const idxRevoked = rows.findIndex(r => r.marker === '@revoked')
  if (HAS_KEYGEN) {
    // OpenSSH 打印 SHA256 指纹时会去掉 base64 的 '=' 补位，面板保留标准 base64；
    // 比的是 wire 字节的哈希值，所以按无补位口径对齐（同一串字符，同一份字节）
    const noPad = s => String(s).replace(/=+$/, '')
    const fpA = systemFingerprint('g7a.pub', pubA)
    const fpD = systemFingerprint('g7d.pub', pubD)
    check('面板指纹 = 系统 ssh-keygen -lf 指纹（同一套 wire 字节）',
      noPad(rows[idxA].fp) === noPad(fpA), { panel: rows[idxA].fp, system: fpA })
    check('撤销标记单独成列且指纹也算得出来',
      idxRevoked >= 0 && noPad(rows[idxRevoked].fp) === noPad(fpD),
      idxRevoked >= 0 ? rows[idxRevoked].fp : null)
  } else {
    check('系统 ssh-keygen 可用（跳过指纹真值对照）', false, KEYGEN + ' missing')
  }
  const rHashed = rows[idxA + 2]
  check('哈希条目不显示主机名，只说是哈希存储',
    zh(rHashed.host) === zh('（哈希存储的主机名）') || zh(rHashed.host) === zh('(hashed host name)'), rHashed.host)
  check('哈希条目仍给出指纹并可删', /^SHA256:/.test(rHashed.fp) && !rHashed.delDisabled, rHashed)
  check('哈希条目主机名列保留原始 title（不给用户猜）',
    zh(rHashed.hostTitle || '').indexOf('|1|') === 0, rHashed.hostTitle)
  const rBad = rows[4]
  check('畸形条目明说是无法解析',
    zh(rBad.fp) === zh('无法解析的条目') || zh(rBad.fp) === zh('unparsable entry'), rBad.fp)
  check('畸形条目删不掉也复制不了（宁可不删也不猜）', rBad.delDisabled && rBad.copyDisabled, rBad)
  check('没有「清空 known_hosts」这种一把梭按钮',
    (await jev('window.__sk.hasClearAll()')) === false)
  check('列表头给出文件路径与修改时间',
    zh(await ev("window.__sk.text('.ssh-key-known-head')")).indexOf(zh(KNOWN)) >= 0 &&
      !!(await ev("!!window.__sk.in('.ssh-key-known-mtime')")))
  await shot('known-hosts-list')

  // ── 2. 拒绝路径：一次请求都不该发出去 ───────────────────────────
  await ev('window.__sk.reset()')
  await ev("window.__sk.fill('.ssh-key-pass','abcdef12')")
  await ev("window.__sk.fill('.ssh-key-pass2','abcdef13')")
  await click('.ssh-key-generate')
  const mismatch = await msgHas(/口令不一致|do not match/i)
  check('两次口令不一致 → 提示并挡住', !!mismatch, mismatch)
  check('口令不一致时一个请求都没发（拒绝在发请求之前）',
    (await jev("window.__sk.calls.filter(c => c.action === 'generate').length")) === 0)
  check('口令不一致时磁盘上没落任何密钥',
    !fs.existsSync(path.join(SSH_DIR, 'g7demo')) &&
      fs.readdirSync(SSH_DIR).filter(f => !f.startsWith('known_hosts')).length === 0)

  await ev("window.__sk.fill('.ssh-key-pass','abc')")
  await ev("window.__sk.fill('.ssh-key-pass2','abc')")
  await ev("window.__sk.fill('.ssh-key-name','g7short')")
  await click('.ssh-key-generate')
  const tooShort = await msgHas(/口令太短|too short/i)
  check('口令太短 → 主进程按词条拒绝', !!tooShort, tooShort)
  check('口令太短没写盘（校验在算密钥之前）', !fs.existsSync(path.join(SSH_DIR, 'g7short')))

  await ev("window.__sk.fill('.ssh-key-pass','')")
  await ev("window.__sk.fill('.ssh-key-pass2','')")
  await ev("window.__sk.fill('.ssh-key-name','bad/name')")
  await click('.ssh-key-generate')
  const badName = await msgHas(/密钥名不合法|Invalid key name/i)
  check('名字带路径分隔符 → 拒绝', !!badName, badName)
  check('非法名字没在 .ssh 下建子目录', !fs.existsSync(path.join(SSH_DIR, 'bad')))

  // ── 3. 真生成 + 权限 + 系统能读回 ───────────────────────────────
  await ev("window.__sk.fill('.ssh-key-name','g7plain')")
  await click('.ssh-key-generate')
  const okGen = await msgHas(/密钥已生成|Key generated/i)
  check('明文密钥生成成功并提示', !!okGen, okGen)
  await waitFor(cdp, "!!window.__sk.inRoot('.ssh-key-result')", 'result block shows', 8000)
  const priv = path.join(SSH_DIR, 'g7plain')
  const pub = priv + '.pub'
  check('私钥文件落盘 0600', fs.existsSync(priv) && mode(priv) === '600', fs.existsSync(priv) && mode(priv))
  check('公钥文件落盘 0644', fs.existsSync(pub) && mode(pub) === '644', fs.existsSync(pub) && mode(pub))
  check('目录 0700', mode(SSH_DIR) === '700', mode(SSH_DIR))
  check('结果区显示的私钥路径就是落盘路径',
    zh(await ev("window.__sk.text('.ssh-key-result .ssh-key-result-path')")) === zh(priv),
    await ev("window.__sk.text('.ssh-key-result .ssh-key-result-path')"))
  check('公钥文本框内容 = 落盘公钥（逐字）',
    (await ev("window.__sk.val('.ssh-key-pub')")) === fs.readFileSync(pub, 'utf8').trim())
  check('公钥框只读（防手改后当公钥复制走）',
    await ev("document.querySelector('.ssh-key-pub').readOnly"))
  check('下一步提示是 ssh-copy-id 带真实公钥路径',
    zh(await ev("window.__sk.text('.ssh-key-result-cmd')")).indexOf(zh('ssh-copy-id -i ' + pub)) === 0,
    await ev("window.__sk.text('.ssh-key-result-cmd')"))
  check('没口令时不挂「已加密」标签', !(await ev("!!window.__sk.inRoot('.ssh-key-result-tag')")))
  if (HAS_KEYGEN) {
    const y = keygen(['-y', '-f', priv], { input: '' })
    check('系统 ssh-keygen -y 读回同一行公钥', y.trim() === fs.readFileSync(pub, 'utf8').trim())
    check('公钥行注释是密钥名（ ssh-keygen -C 的默认语义）',
      y.trim().split(' ')[2] === 'g7plain', y.trim())
  }
  await shot('result-plain')

  // 同名第二次：拒绝覆盖，原文件一个字节都不动
  const before = { text: fs.readFileSync(priv, 'utf8'), mtimeMs: fs.statSync(priv).mtimeMs }
  await click('.ssh-key-generate')
  const dup = await msgHas(/同名密钥文件已存在|already exists/i)
  check('同名再点一次 → 拒绝覆盖', !!dup, dup)
  check('拒绝覆盖后原私钥内容与修改时间未变',
    fs.readFileSync(priv, 'utf8') === before.text && fs.statSync(priv).mtimeMs === before.mtimeMs)

  // ── 4. 带口令：真加密，不是贴标签 ───────────────────────────────
  await ev("window.__sk.fill('.ssh-key-name','g7enc')")
  await ev("window.__sk.fill('.ssh-key-pass','g7-passphrase-123')")
  await ev("window.__sk.fill('.ssh-key-pass2','g7-passphrase-123')")
  await click('.ssh-key-generate')
  const okEnc = await msgHas(/密钥已生成|Key generated/i)
  check('带口令生成成功', !!okEnc, okEnc)
  await waitFor(cdp, "!!window.__sk.inRoot('.ssh-key-result-tag')", 'encrypted tag shows', 8000)
  check('结果区标注「已加密」',
    zh(await ev("window.__sk.text('.ssh-key-result-tag')")) === zh('已加密') ||
      zh(await ev("window.__sk.text('.ssh-key-result-tag')")) === zh('Encrypted'))
  if (HAS_KEYGEN) {
    let plainFails = false
    try {
      execFileSync(KEYGEN, ['-y', '-f', path.join(SSH_DIR, 'g7enc')], { encoding: 'utf8', stdio: 'pipe', input: '' })
    } catch (err) {
      plainFails = true
    }
    check('不给口令读不出公钥（真的加密过）', plainFails)
    const withPass = keygen(['-y', '-P', 'g7-passphrase-123', '-f', path.join(SSH_DIR, 'g7enc')]).trim()
    check('给了口令能读回公钥且与 .pub 一致',
      withPass === fs.readFileSync(path.join(SSH_DIR, 'g7enc.pub'), 'utf8').trim())
  }
  const bodyHasPass = await ev("document.body.innerText.indexOf('g7-passphrase-123') >= 0")
  check('口令不出现在面板文本里', !bodyHasPass)
  check('口令没被写进任何书签',
    !(await jev("JSON.stringify(window.store.bookmarks.some(b => JSON.stringify(b).indexOf('g7-passphrase-123') >= 0))")))

  // ── 5. 回填书签 ─────────────────────────────────────────────────
  await ev("window.__sk.fill('.ssh-key-pass','')")
  await ev("window.__sk.fill('.ssh-key-pass2','')")
  await ev("window.__sk.fill('.ssh-key-name','g7apply')")
  await click('.ssh-key-generate')
  await waitFor(cdp, "!!window.__sk.inRoot('.ssh-key-apply')", 'apply row shows', 8000)
  check('未选书签时写入按钮不可点',
    await ev("document.querySelector('.ssh-key-apply').disabled"))
  // antd Select 只认真鼠标：合成 click 不会展开下拉
  const bmXY = await jev("JSON.stringify(window.__sk.xyBox('.ssh-key-bookmark'))")
  await cdp.click(bmXY.x, bmXY.y)
  await waitFor(cdp,
    "[...document.querySelectorAll('.ant-select-item-option')].filter(o => o.offsetHeight).length > 0",
    'bookmark options open', 8000)
  const bmOptXY = await stableXY("(() => { const o = [...document.querySelectorAll('.ant-select-item-option')].filter(x => x.offsetHeight).find(x => x.innerText.indexOf('g74-demo-host') >= 0); if (!o) return null; const r = o.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()")
  await cdp.click(bmOptXY.x, bmOptXY.y)
  await waitFor(cdp, "!document.querySelector('.ssh-key-apply').disabled", 'bookmark selected', 8000)
  await click('.ssh-key-apply')
  const saved = await msgHas(/已保存|saved/i)
  check('回填后提示已保存', !!saved, saved)
  const bm = await jev('JSON.stringify(window.__sk.bm())')
  check('书签写入私钥路径', bm.privateKeyPath === path.join(SSH_DIR, 'g7apply'), bm)
  check('书签里粘贴的私钥内容被清空（内容优先于路径）', bm.privateKeyLen === 0, bm)
  check('书签认证方式切成私钥', bm.authType === 'privateKey', bm)
  check('口令与私钥内容不在书签里',
    (await jev("JSON.stringify(window.store.bookmarks.find(b => b.id === 'g74-demo-bm')).indexOf('passphrase')")) < 0)
  await shot('apply-bookmark')

  // 复制：公钥行与 ssh-copy-id 命令
  await click('.ssh-key-copy-pub')
  await sleep(400)
  check('复制公钥按钮真的写进剪贴板',
    (await ev('window.pre.readClipboard()')) === fs.readFileSync(path.join(SSH_DIR, 'g7apply.pub'), 'utf8').trim())
  await click('.ssh-key-copy-install')
  await sleep(400)
  check('复制安装命令与提示行同源',
    (await ev('window.pre.readClipboard()')) === (await ev("window.__sk.text('.ssh-key-result-cmd')")))

  // ── 6. 删单条 known_hosts ───────────────────────────────────────
  await click('.ssh-key-known-refresh')
  await sleep(900)
  rows = await jev('JSON.stringify(window.__sk.rows())')
  const xyTarget = await stableXY('JSON.stringify(window.__sk.rows()[' + idxA + '].xy)')
  await cdp.click(xyTarget.x, xyTarget.y)
  const okBox = await stableXY("(() => { const b = [...document.querySelectorAll('.ant-popconfirm')].filter(x => x.offsetHeight)[0]; if (!b) return null; const btn = b.querySelector('.ant-btn-primary'); const r = btn.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: btn.innerText }) })()")
  check('删除先弹确认（不是点一下就删）',
    !!okBox && (zh(okBox.txt || '').indexOf('删除') >= 0 || /Delete/.test(okBox.txt || '')), okBox)
  const snapshotBefore = fs.readFileSync(KNOWN, 'utf8')
  await cdp.click(okBox.x, okBox.y)
  const delMsg = await msgHas(/已删除|Entry deleted/i)
  check('删除单条后给出已删除提示', !!delMsg, delMsg)
  await sleep(900)
  const after = fs.readFileSync(KNOWN, 'utf8').split('\n')
  check('删的正是那一行（alpha 主机不再出现）',
    !after.some(l => l.indexOf('g7-alpha.example') >= 0) ||
      after.filter(l => l.indexOf('g7-alpha.example') >= 0 && l.indexOf('ssh-') >= 0).length === 0)
  check('其余条目一行没少（哈希/撤销/双主机都还在）',
    snapshotBefore.split('\n').filter(l => l.indexOf('g7-alpha') >= 0 && /^g7-alpha/.test(l)).length === 1 &&
      fs.readFileSync(KNOWN, 'utf8').indexOf('|1|' + salt) >= 0 &&
      fs.readFileSync(KNOWN, 'utf8').indexOf('@revoked g7-delta.example') >= 0 &&
      fs.readFileSync(KNOWN, 'utf8').indexOf('g7-beta.example,g7-gamma.example') >= 0)
  check('注释与空行没被顺手抹掉',
    fs.readFileSync(KNOWN, 'utf8').indexOf('# electerm g7 self-test seed') === 0)
  rows = await jev('JSON.stringify(window.__sk.rows())')
  check('列表删完自己刷新（4 条）', rows.length === 4, rows.map(r => r.host))
  await shot('known-hosts-after-delete')

  // ── 7. 外部改动 → 行号失效要如实说，且不删任何东西 ──────────────
  const staleLine = 'g7-evil.example ' + pubB
  const shift = [staleLine].concat(fs.readFileSync(KNOWN, 'utf8').split('\n'))
  fs.writeFileSync(KNOWN, shift.join('\n'), { mode: 0o600 })
  const idxHash = rows.findIndex(r => zh(r.host) === zh('（哈希存储的主机名）'))
  const xyHash = await stableXY('JSON.stringify(window.__sk.rows()[' + idxHash + '].xy)')
  await cdp.click(xyHash.x, xyHash.y)
  const okBox2 = await stableXY("(() => { const b = [...document.querySelectorAll('.ant-popconfirm')].filter(x => x.offsetHeight)[0]; if (!b) return null; const btn = b.querySelector('.ant-btn-primary'); const r = btn.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()")
  const beforeStale = fs.readFileSync(KNOWN, 'utf8')
  await cdp.click(okBox2.x, okBox2.y)
  const staleMsg = await msgHas(/已被外部改动|changed outside this panel/i)
  check('行号指向的键已变 → 拒绝并提示 stale', !!staleMsg, staleMsg)
  check('stale 时一个字节都没删', fs.readFileSync(KNOWN, 'utf8') === beforeStale)
  await click('.ssh-key-known-refresh')
  await sleep(900)
  const rows2 = await jev('JSON.stringify(window.__sk.rows())')
  check('刷新后按新文件重排行号（多出一条 evil）',
    rows2.length === 5 && rows2.some(r => zh(r.host) === zh('g7-evil.example')), rows2.map(r => r.host))

  // 删哈希条目：面板里可删，落盘删的是它自己那一行
  const idxHash2 = rows2.findIndex(r => zh(r.host) === zh('（哈希存储的主机名）'))
  const xyH = await stableXY('JSON.stringify(window.__sk.rows()[' + idxHash2 + '].xy)')
  const saltStillIn = fs.readFileSync(KNOWN, 'utf8').indexOf('|1|' + salt) >= 0
  check('哈希条目删除前确实在文件里', saltStillIn)
  await cdp.click(xyH.x, xyH.y)
  const okBox3 = await stableXY("(() => { const b = [...document.querySelectorAll('.ant-popconfirm')].filter(x => x.offsetHeight)[0]; if (!b) return null; const btn = b.querySelector('.ant-btn-primary'); const r = btn.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()")
  await cdp.click(okBox3.x, okBox3.y)
  await msgHas(/已删除|Entry deleted/i)
  await sleep(900)
  const afterHashDel = fs.readFileSync(KNOWN, 'utf8')
  check('哈希条目按其自身行删除（不是按主机名猜）',
    afterHashDel.indexOf('|1|' + salt) < 0 &&
      afterHashDel.indexOf('g7-evil.example') >= 0 &&
      afterHashDel.indexOf('@revoked g7-delta.example') >= 0, afterHashDel.split('\n').length)

  // 畸形条目：确认按钮压根不出现
  const rows3 = await jev('JSON.stringify(window.__sk.rows())')
  const idxBad = rows3.findIndex(r => zh(r.fp) === zh('无法解析的条目') || zh(r.fp) === zh('unparsable entry'))
  const badDisabled = await ev('window.__sk.rows()[' + idxBad + '].delDisabled')
  check('畸形条目按钮 disabled，点不动', badDisabled === true)

  // ── 8. 浅色主题 ─────────────────────────────────────────────────
  const darkBg = await ev('window.__sk.panelBg()')
  // 浅色主题 id 是 defaultLight（不是 'light'），传错等于没切
  await ev('window.store.setTheme && window.store.setTheme("defaultLight")')
  await sleep(800)
  const lightBg = await ev('window.__sk.panelBg()')
  check('面板颜色跟主题 token 走（深浅不同）', darkBg !== lightBg, { darkBg, lightBg })
  await shot('section-light')
  await ev('window.store.setTheme && window.store.setTheme("default")')
  await sleep(600)

  // ── 9. 无报错、卸载后不留写 ─────────────────────────────────────
  const errEvents = cdp.events.filter(e =>
    e.method === 'Log.entryAdded' && e.params.entry.level === 'error' &&
    !/favicon|DevTools|gpu|GLES|libva|network service|ssl|Fontconfig|dbus|blueman|sandbox|vulkan|gbm|dri|EGL|sandbox|Wayland|GPU|Accelerated|SharedImage|-blit/i.test(e.params.entry.message))
  check('全程无未捕获前端错误', errEvents.length === 0, errEvents.slice(0, 2).map(e => e.params.entry.message))

  await ev('window.store.hideSettingModal && window.store.hideSettingModal()')
  await sleep(600)
  const fileBeforeClose = fs.readFileSync(KNOWN, 'utf8')
  await ev('window.store.setSettingItem && window.store.setSettingItem({ id: "setting-common", title: "common" })')
  await sleep(500)
  await ev('window.__sk.reset()')
  await click('.ssh-key-known-refresh').catch(() => {})
  check('切走小节后面板不再存在', !(await ev('!!window.__sk.root()')))
  check('切走后不会有人替我改文件', fs.readFileSync(KNOWN, 'utf8') === fileBeforeClose)
  await ev('window.__sk.unpatch()')

  fs.rmSync(TMP, { recursive: true, force: true })
  const fail = results.filter(r => !r.ok).length
  console.log('\n==== G7-4 结论 ====')
  console.log('pass ' + (results.length - fail) + '/' + results.length + '  ' +
    (HAS_KEYGEN ? '(系统 ssh-keygen 参与对照)' : '(缺 /usr/bin/ssh-keygen，指纹对照未跑)'))
  if (fail) {
    process.exitCode = 1
  }
  // ws 会挂住事件循环，跑完必须显式退出（否则 timeout 会把绿判据压成 124）
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL ' + err.message)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
})
