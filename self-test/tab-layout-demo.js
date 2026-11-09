#!/usr/bin/env node
/**
 * 页签栏布局草图落地 —— CDP 实机复核（任务 #10）
 *
 * 钉的是两处渲染改动（纯渲染，不含交互流，所以用可观察 store 字段直接驱动重渲染，
 * 与生产 handleColorChange 的 `this.props.tab.color = color` 同一条路；徽标底色真的
 * 变成所设颜色，本身就证明重渲染发生了）：
 *   ① tab.jsx：行尾 createTitleTag 的条件 (tab.color || tab.icon) → tab.icon。
 *      纯颜色页签不再渲染那颗重复的 ●（编号徽标底色已表达颜色）；有图标时图标保留。
 *   ② tabs.styl：删掉 .tab-status 的 position:static 7px 圆点覆盖，恢复上游左上角
 *      5px 绝对定位小方块；编号徽标因此成为行内首元素。
 *
 * 判据（真页签 + 真 computed style + 真 DOM 顺序）：
 *   A 状态点：position=absolute / width=5px / left=2px / top=2px（左上角，不占行内宽度）
 *   B 纯颜色页签：无 .tab-title-tag；.tab-count 底色 = 所设颜色
 *   C 图标页签：有 .tab-title-tag 且内含 img.item-icon；DOM 顺序 徽标 → 图标 → 标题
 *   D 无颜色无图标：无 .tab-title-tag；徽标底色 = 默认 #0088cc
 *   E 编号徽标是内层 span.tab-title 的第一个元素 child（在标题文字之前）
 *
 * 隔离：自建临时 HOME / XDG_CONFIG_HOME / DATA_PATH / TMPDIR，自起自收实例
 *      （只按 spawn 出去的进程组下杀手，绝不按端口或 pkill 模式匹配）。
 *
 * 用法：
 *   1) 渲染层改过要 npm run compile（本探针读 work/app/assets 里的最新产物）
 *   2) Xvfb <display> 起好（默认 :141，独占；避开别的 lane 的 :139）
 *   3) node self-test/tab-layout-demo.js [display] [port] [shotDir]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':141'
const PORT = process.argv[3] || '9376'
const SHOT_DIR = path.join(ROOT, process.argv[4] || 'self-test/2026-11-09-tab-layout-shots')

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tab-layout-'))
const LOG_FILE = path.join(RUN, 'app.log')
let childPid = null
const { check, results } = makeChecker()
const J = JSON.stringify
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
}

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

async function assertPortIdle () {
  const v = await getJson('http://127.0.0.1:' + PORT + '/json/version').catch(() => null)
  if (!v) return
  throw new Error('端口 ' + PORT + ' 上已经有实例在跑（' + (v.Browser || '未知') + '）—— 先清掉那一轮')
}

const PROBE = `(() => {
  window.__rendered = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return false
      n = n.parentElement
    }
    return !!el.getBoundingClientRect().width
  }
  window.__mkLocal = title => {
    const before = window.store.tabs.map(t => String(t.id))
    window.store.addTab({ type: 'local', title, batch: window.store.currentLayoutBatch })
    const created = window.store.tabs.find(t => before.indexOf(String(t.id)) < 0)
    if (created) window.store.changeActiveTabId(created.id)
    return created ? String(created.id) : ''
  }
  window.__setTab = (id, fields) => {
    const t = window.store.tabs.find(x => String(x.id) === String(id))
    if (!t) return 'no-tab:' + id
    // 与生产 handleColorChange 同路：直接改可观察字段，mobx 触发重渲染
    if ('color' in fields) { if (fields.color === null) delete t.color; else t.color = fields.color }
    if ('icon' in fields) { if (fields.icon === null) delete t.icon; else t.icon = fields.icon }
    window.store.changeActiveTabId(t.id)
    return 'ok'
  }
  window.__tabInfo = id => {
    const el = Array.from(document.querySelectorAll('.tab'))
      .find(t => t.getAttribute('data-id') === String(id) && window.__rendered(t))
    if (!el) return { error: 'no-tab:' + id }
    const tabR = el.getBoundingClientRect()
    const dot = el.querySelector('.tab-status')
    const ds = dot ? getComputedStyle(dot) : null
    const dr = dot ? dot.getBoundingClientRect() : null
    const badge = el.querySelector('.tab-count')
    const bs = badge ? getComputedStyle(badge) : null
    const tag = el.querySelector('.tab-title-tag')
    const tagImg = tag ? tag.querySelector('img.item-icon') : null
    const titleText = el.querySelector('.tab-title-text')
    // 内层 span.tab-title（外层是 div.tab-title.elli，用 span 区分）
    const inner = el.querySelector('span.tab-title')
    const kids = inner ? Array.from(inner.children) : []
    const idx = n => kids.indexOf(n)
    // .tab-title-tag 包在 <span class=mg1r> 里，不是 inner 的直接 child；
    // 顺序按"包裹它的那个直接 child"算，否则 indexOf 恒为 -1
    const tagWrap = tag ? kids.find(k => k.contains(tag)) : null
    return {
      id: String(id),
      title: titleText ? titleText.innerText : '',
      dot: ds ? {
        position: ds.position, width: ds.width, height: ds.height,
        left: ds.left, top: ds.top, radius: ds.borderRadius,
        // 相对页签左上角的实测偏移（应 ≈ 2,2，落在 padding 区，不与徽标重叠）
        dx: dr ? Math.round(dr.left - tabR.left) : null,
        dy: dr ? Math.round(dr.top - tabR.top) : null
      } : null,
      badge: bs ? { bg: bs.backgroundColor, color: bs.color, idx: idx(badge), left: badge.getBoundingClientRect().left } : null,
      tag: tag ? { present: true, hasImg: !!tagImg, idx: idx(tagWrap), text: tag.innerText } : { present: false },
      titleIdx: idx(titleText),
      kidClasses: kids.map(k => String(k.className || k.tagName)),
      tabLeft: Math.round(tabR.left)
    }
  }
  window.__tabsRect = () => {
    const b = document.querySelector('.tabs')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  }
  return 'probe-installed'
})()`

const hexToRgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')'
const TAB_COLOR = '#bf3989'
const DEFAULT_COLOR = '#0088cc'

const main = async () => {
  await assertPortIdle()
  launch()
  const cdp = await waitCdp()
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(cdp, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪：' + brief(cdp.tail(8)))
  }
  await cdp.call('Page.reload', { ignoreCache: true })
  if (!await waitFor(cdp, readyExpr, '重载后 store 仍不在包里', 60000)) {
    throw new Error('重载后仍未就绪：' + brief(cdp.tail(8)))
  }
  await sleep(2500)
  check('实例起来、渲染层就绪（真 store + 真 translate）', true)
  check('探针装好', await cdp.eval(PROBE) === 'probe-installed')

  // 三条本地页签：A 纯颜色 / B 图标(兼颜色) / C 素色
  const idA = await cdp.eval(`window.__mkLocal(${J('layout-A-color')})`)
  const idB = await cdp.eval(`window.__mkLocal(${J('layout-B-icon')})`)
  const idC = await cdp.eval(`window.__mkLocal(${J('layout-C-plain')})`)
  if (!idA || !idB || !idC) throw new Error('本地页签没建出来：' + brief({ idA, idB, idC }))
  await sleep(800)
  await cdp.eval(`window.__setTab(${J(idA)}, { color: ${J(TAB_COLOR)} })`)
  await cdp.eval(`window.__setTab(${J(idB)}, { color: ${J(TAB_COLOR)}, icon: 'icon:ubuntu' })`)
  await sleep(1200)

  const A = await cdp.jeval(`window.__tabInfo(${J(idA)})`)
  const B = await cdp.jeval(`window.__tabInfo(${J(idB)})`)
  const C = await cdp.jeval(`window.__tabInfo(${J(idC)})`)
  console.log('INFO  A(color) :: ' + brief(A))
  console.log('INFO  B(icon)  :: ' + brief(B))
  console.log('INFO  C(plain) :: ' + brief(C))

  // A 状态点回到左上角（三条都验，CSS 是全局的）
  for (const [name, t] of [['A', A], ['B', B], ['C', C]]) {
    const d = t.dot || {}
    check(name + ' 状态点绝对定位左上角 5px（position/left/top/width）',
      d.position === 'absolute' && d.left === '2px' && d.top === '2px' && d.width === '5px', d)
    check(name + ' 状态点实测落在页签左上角 padding 区（dx≈2,dy≈2，不占行内宽度）',
      d.dx === 2 && d.dy === 2, { dx: d.dx, dy: d.dy })
  }

  // B 纯颜色页签：无行尾 ●，徽标底色 = 所设颜色（底色匹配本身证明重渲染发生）
  check('B 纯颜色页签不再渲染行尾 .tab-title-tag（● 已删）', A.tag && A.tag.present === false, A.tag)
  check('B 纯颜色页签编号徽标底色 = 所设颜色 ' + TAB_COLOR,
    A.badge && A.badge.bg === hexToRgb(TAB_COLOR), A.badge)

  // C 图标页签：保留 .tab-title-tag 且是真图标 img；DOM 顺序 徽标 → 图标 → 标题
  check('C 图标页签保留 .tab-title-tag', B.tag && B.tag.present === true, B.tag)
  check('C 图标页签 tag 内是真图标 img.item-icon（icon:ubuntu）', B.tag && B.tag.hasImg === true, B.tag)
  check('C 图标页签 DOM 顺序：徽标 < 图标 < 标题',
    B.badge && B.tag && B.badge.idx >= 0 && B.badge.idx < B.tag.idx && B.tag.idx < B.titleIdx,
    { badgeIdx: B.badge && B.badge.idx, tagIdx: B.tag && B.tag.idx, titleIdx: B.titleIdx, kids: B.kidClasses })

  // D 素色页签：无 tag，徽标默认蓝
  check('D 素色页签无 .tab-title-tag', C.tag && C.tag.present === false, C.tag)
  check('D 素色页签编号徽标底色 = 默认 ' + DEFAULT_COLOR,
    C.badge && C.badge.bg === hexToRgb(DEFAULT_COLOR), C.badge)

  // E 编号徽标是内层 span.tab-title 的第一个元素 child（徽标移到最左）
  for (const [name, t] of [['A', A], ['B', B], ['C', C]]) {
    check(name + ' 编号徽标是行内首元素（idx=0，在标题之前）',
      t.badge && t.badge.idx === 0 && t.titleIdx > 0, { badgeIdx: t.badge && t.badge.idx, titleIdx: t.titleIdx, kids: t.kidClasses })
  }

  // 截图：整窗 + 标签栏裁切
  await cdp.shot(path.join(SHOT_DIR, 'tab-layout-full.png'))
  const rect = await cdp.jeval('window.__tabsRect()')
  if (rect && rect.width > 0) {
    const r = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height + 2, scale: 2 }
    })
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(SHOT_DIR, 'tab-layout-bar.png'), Buffer.from(r.result.data, 'base64'))
    }
  }
  check('截图已存（整窗 + 标签栏裁切）', fs.existsSync(path.join(SHOT_DIR, 'tab-layout-full.png')), SHOT_DIR)

  const ex = cdp.events.filter(x => String(x).startsWith('EX'))
  check('全程零未捕获渲染异常', ex.length === 0, ex.slice(0, 4))

  await killInstance()
  const fails = results.filter(r => !r.ok && !r.skipped)
  console.log('\n==== ' + (results.length - fails.length) + '/' + results.length + ' PASS ====')
  if (fails.length) {
    console.log('FAILURES:\n' + fails.map(f => ' - ' + f.name + ' :: ' + brief(f.detail)).join('\n'))
  }
  try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e) {}
  process.exit(fails.length ? 1 : 0)
}

main().catch(async e => {
  die((e && e.stack) || String(e))
  await killInstance()
  try { fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e2) {}
  process.exit(1)
})
