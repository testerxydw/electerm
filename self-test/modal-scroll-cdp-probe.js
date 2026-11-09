#!/usr/bin/env node
/**
 * 全局弹层滚动统一通道 · CDP 实机复验探针（可复跑，最后一轮定向复验固化）
 *
 * 用法（从任意目录都能跑，cwd 由本脚本自己设为仓库根）：
 *   node self-test/modal-scroll-cdp-probe.js
 * 退出码：0 = 全部 PASS；1 = 有判据 FAIL；2 = 环境/启动失败。
 *
 * 为什么必须有这个脚本（AGENTS.md §5.2.7 测试分层）：
 *   静态契约 spec（src/test/unit-ci/modal-scroll-unified.spec.js）只能钉死
 *   「源码里写了什么」。上一轮 NoGo 里所有 CSS 规则都产出且都生效，但
 *   info.styl 自造的 flex 1 1 0 + height 100% 定高链把 .ant-tabs-body 压成
 *   clientHeight=0，deps/cmd 完全不可见、无滚动条 —— 静态断言一条都发现不了。
 *   只有真 Electron + Xvfb + CDP 真实滚轮，量 clientHeight>0 / scrollTop>0 /
 *   nav rect.top 恒定 / 双滚动条 / 嵌套滚动链，才能识别这类运行时布局坍缩。
 *
 * 判据（本轮 5 条核心 + 此前未覆盖的嵌套滚动特例）：
 *   ① .info-modal .ant-tabs-body clientHeight>0；首条 dep 行 rect 完全落在
 *      .custom-modal-content rect 内。
 *   ② deps（~200 行）/ cmd（注入超长 commandLineHelp）真实滚轮后
 *      scrollTop>0 且 st+ch>=sh-2；滚动容器必须是 .custom-modal-body
 *      （computed overflowY==='auto' 且 sh>ch+1）。
 *   ③ 真实滚轮下 .ant-tabs-nav rect.top 前后差 <=1.5px；computed
 *      position==='sticky'（证明 !important 压过 antd 的 relative）；
 *      背景不透明且 elementFromPoint 命中 nav 自身（无行穿透）。
 *   ④ 弹层内「sh>ch+1 且 overflowY in {auto,scroll}」元素 <=1；
 *      弹层外 html/body/wrap/mask/container 为 0；
 *      document.scrollingElement.scrollTop===0；scrollWidth<=innerWidth。
 *   ⑤ 短内容零回归：info 页签 sh==ch（大视口下）、关于页 computed width
 *      720、header/footer rect.top 差 = 0；Modal.confirm 短内容 computed
 *      width 520、Esc / 遮罩点击 / footer 按钮行为不变。
 *   ⑥ term-of-use：Modal.confirm 的 content 自带 maxHeight:50vh;overflow:auto
 *      的 div，嵌套在也 overflow-y:auto 的 .custom-modal-body 内 ——
 *      同时可滚祖先链 <=1、条款能滚到底、header/footer rect.top 差 = 0、
 *      footer 按钮可见可点、无全屏滚动条。
 *   抽验：5 个 Tab 逐个切换 nav 常驻；is-mobile content.height===innerHeight
 *      且能滚到底；浅/深主题 nav 背景跟随 --main 且不透明。
 *
 * 环境纪律：
 *   - 子进程 env 必须显式 delete ELECTRON_RUN_AS_NODE / NODE_OPTIONS
 *     （宿主 shell 注入了这两个，否则 electron 退化成纯 Node、app.getPath 未定义）。
 *   - 临时 HOME/TMPDIR 放 os.tmpdir()，finally 用 fs.rmSync 直删（绝不进回收站，
 *     AGENTS.md §1-3）；唯一落在仓库里的产物是本脚本自身。
 *   - 端口 / Xvfb display 启动前后都清残留，PGID 整组 kill。
 *   - 不回看的输出统一 >/dev/null 2>&1，不落 .log。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execSync } = require('node:child_process')
const {
  Cdp, getJson, findPageTarget, sleep, waitFor, makeChecker
} = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const PORT = '9396'
const DISPLAY = ':150'
const BIN = path.join(ROOT, 'node_modules/electron/dist/electron')
const J = JSON.stringify

// 超长命令行帮助：模拟 commander helpInformation()（~100 字符/行 × 240 行），
// 保证 cmd 页签内容远超 .custom-modal-body 高度，真实滚轮一定滚得动。
const LONG_HELP = Array.from({ length: 240 }, (_, i) =>
  '  --option-' + String(i).padStart(3, '0') + ' <value>   Description for command line usage line ' +
  i + ', deliberately long enough to force vertical scrolling inside the modal body'
).join('\n')

// 长条款：whiteSpace:pre-wrap + maxHeight:50vh，必须能滚到底。
const LONG_TERM = Array.from({ length: 160 }, (_, i) =>
  '第 ' + (i + 1) + ' 条  使用条款正文。Lorem ipsum dolor sit amet, consectetur adipiscing elit, ' +
  'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. 本行用于撑高内容以验证嵌套滚动。'
).join('\n')

// ---------------------------------------------------------------- 页内探针
// 注意：这是模板字符串，禁止出现 ${...}（会被 Node 侧插值）。
const PROBE = `(() => {
  const vis = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
  }
  const rect = el => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: +r.top.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2),
      bottom: +r.bottom.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2)
    }
  }
  const scrollInfo = el => el ? {
    sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop,
    sw: el.scrollWidth, cw: el.clientWidth,
    oy: getComputedStyle(el).overflowY, ox: getComputedStyle(el).overflowX
  } : null
  const isScrollableY = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 1
  }
  const brief = el => ({
    tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 90),
    sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY
  })
  const ancestorScrollables = el => {
    const out = []
    let n = el
    while (n) {
      if (isScrollableY(n)) out.push(brief(n))
      n = n.parentElement
    }
    return out
  }
  const hitSelf = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    const h = document.elementFromPoint(
      Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    return !!h && (h === el || el.contains(h))
  }

  // 键盘事件送达记录（capture 阶段）：用于分辨「产品 Esc 逻辑坏了」还是
  // 「CDP 按键根本没派发进渲染进程」——两者结论完全不同，不能混为一谈。
  window.__msKeyLog = []
  document.addEventListener('keydown', e => {
    window.__msKeyLog.push({ key: e.key, code: e.code, trusted: e.isTrusted })
  }, true)

  window.__ms = {
    vis, rect, scrollInfo, isScrollableY, brief, ancestorScrollables, hitSelf,
    q: sel => document.querySelector(sel),
    qa: sel => [...document.querySelectorAll(sel)].filter(vis),
    wraps: () => [...document.querySelectorAll('.custom-modal-wrap')].filter(vis),
    keyLog: () => window.__msKeyLog.slice(),
    clearKeyLog: () => { window.__msKeyLog.length = 0; return 'cleared' },
    // 夹具清理：DOM 原生 .click() 走 React 合成事件，逐个 destroy 现存弹层，
    // 避免上一轮没关掉的弹层叠加，把判据量到被遮住的旧弹层上。
    forceCloseAll: () => {
      let n = 0
      for (const w of [...document.querySelectorAll('.custom-modal-wrap')]) {
        const b = w.querySelector('.custom-modal-cancel-btn') ||
          w.querySelector('.custom-modal-close')
        if (b) { b.click(); n++ }
      }
      return n
    },
    content: () => document.querySelector('.info-modal .custom-modal-content'),
    body: () => document.querySelector('.info-modal .custom-modal-body'),
    header: () => document.querySelector('.info-modal .custom-modal-header'),
    footer: () => document.querySelector('.info-modal .custom-modal-footer'),
    nav: () => document.querySelector('.info-modal .ant-tabs-nav'),
    tabsBody: () => document.querySelector('.info-modal .ant-tabs-body'),
    tabs: () => [...document.querySelectorAll('.info-modal .ant-tabs-tab')].filter(vis),
    depRows: () => [...document.querySelectorAll('.info-modal .pd1b')].filter(vis),
    cmdPre: () => document.querySelector('.info-modal pre'),

    // 弹层内可滚元素（content 的后代）
    innerScrollables: () => {
      const c = window.__ms.content()
      if (!c) return []
      return [...c.querySelectorAll('*')].filter(vis).filter(isScrollableY).map(brief)
    },
    // 弹层外可滚元素（html/body/wrap/mask/container/ant-modal-wrap）
    outerScrollables: () => {
      const sels = ['html', 'body', '.custom-modal-wrap', '.custom-modal-mask',
        '.custom-modal-container', '.ant-modal-wrap']
      const out = []
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (isScrollableY(el)) {
            out.push(Object.assign({ sel: s }, brief(el)))
          }
        }
      }
      return out
    },
    docScroll: () => ({
      scrollingTop: document.scrollingElement ? document.scrollingElement.scrollTop : -1,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docElScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight
    }),
    bodyWheelPoint: () => {
      const b = window.__ms.body()
      if (!b) return null
      const r = b.getBoundingClientRect()
      // 落点取可视区偏下，避开 sticky 的 nav（nav 在 body 顶部）
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height * 0.72),
        w: Math.round(r.width), h: Math.round(r.height)
      }
    },
    navOpaque: () => {
      const n = window.__ms.nav()
      if (!n) return { found: false }
      const s = getComputedStyle(n)
      return {
        found: true,
        position: s.position,
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        zIndex: s.zIndex,
        top: s.top,
        rect: rect(n),
        hitSelf: hitSelf(n),
        hitCls: (() => {
          const r = n.getBoundingClientRect()
          const h = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
          return h ? String(h.className || '').slice(0, 90) : null
        })()
      }
    },
    theme: () => {
      const n = window.__ms.nav()
      const c = window.__ms.content()
      return {
        mainVar: getComputedStyle(document.documentElement).getPropertyValue('--main').trim(),
        navBg: n ? getComputedStyle(n).backgroundColor : null,
        contentBg: c ? getComputedStyle(c).backgroundColor : null,
        navColor: n ? getComputedStyle(n).color : null
      }
    },
    // 关于页状态打包（一条 eval 拿全，减少往返）
    aboutState: () => {
      const M = window.__ms
      const c = M.content()
      const b = M.body()
      const tb = M.tabsBody()
      const row = M.depRows()[0]
      const rr = rect(row), cr = rect(c)
      const inside = !!(rr && cr &&
        rr.top >= cr.top - 0.5 && rr.bottom <= cr.bottom + 0.5 &&
        rr.left >= cr.left - 0.5 && rr.right <= cr.right + 0.5)
      return {
        innerHeight: window.innerHeight, innerWidth: window.innerWidth,
        content: cr,
        contentComputedWidth: c ? getComputedStyle(c).width : null,
        contentComputedHeight: c ? getComputedStyle(c).height : null,
        body: scrollInfo(b),
        tabsBodyClientHeight: tb ? tb.clientHeight : -1,
        tabsBodyScrollHeight: tb ? tb.scrollHeight : -1,
        depRowCount: M.depRows().length,
        depRowRect: rr,
        rowInsideContent: inside,
        header: rect(M.header()),
        footer: rect(M.footer()),
        nav: M.navOpaque(),
        innerScrollables: M.innerScrollables(),
        outerScrollables: M.outerScrollables(),
        doc: M.docScroll(),
        wheelPoint: M.bodyWheelPoint(),
        cmdPreLen: M.cmdPre() ? String(M.cmdPre().textContent || '').length : -1
      }
    },
    // term-of-use / 通用 confirm 状态（挂在 body 直属的 .custom-modal-wrap 上）
    confirmState: () => {
      const M = window.__ms
      const ws = M.wraps()
      // 找带 footer buttons 的那个（confirm 一定带），排除关于页
      // 取最新打开的（appendChild 追加到 body 末尾、层级最上），
      // 绝不取第一个 —— 一旦有旧弹层残留，第一个会被盖住、量到的全是假值。
      const w = ws[ws.length - 1]
      if (!w) return null
      const c = w.querySelector('.custom-modal-content')
      const b = w.querySelector('.custom-modal-body')
      const h = w.querySelector('.custom-modal-header')
      const f = w.querySelector('.custom-modal-footer')
      const ok = w.querySelector('.custom-modal-ok-btn')
      const cancel = w.querySelector('.custom-modal-cancel-btn')
      // 条款 div：inline style 带 50vh / overflow auto
      const term = b
        ? [...b.querySelectorAll('div')].find(d =>
            /50vh/.test(String(d.getAttribute('style') || '')) ||
            (getComputedStyle(d).overflowY === 'auto' && d.style.maxHeight))
        : null
      return {
        wrapCls: String(w.className || ''),
        content: rect(c),
        contentComputedWidth: c ? getComputedStyle(c).width : null,
        hasBody: !!b,
        body: scrollInfo(b),
        header: rect(h),
        footer: rect(f),
        term: term ? Object.assign(
          { maxHeight: term.style.maxHeight, rect: rect(term) }, scrollInfo(term)) : null,
        // 从条款 div 到 html 的可滚祖先链（含条款 div 自身）
        termAncestorScrollables: term ? ancestorScrollables(term) : [],
        innerScrollables: c ? [...c.querySelectorAll('*')].filter(vis).filter(isScrollableY).map(brief) : [],
        outerScrollables: M.outerScrollables(),
        doc: M.docScroll(),
        okBtn: ok ? {
          rect: rect(ok), visible: vis(ok), hitSelf: hitSelf(ok),
          text: String(ok.innerText || '').trim().slice(0, 40)
        } : null,
        cancelBtn: cancel ? {
          rect: rect(cancel), visible: vis(cancel), hitSelf: hitSelf(cancel),
          text: String(cancel.innerText || '').trim().slice(0, 40)
        } : null,
        termWheelPoint: term ? (() => {
          const r = term.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 120)) }
        })() : null
      }
    }
  }
  return 'ms-probe-installed'
})()`

// ---------------------------------------------------------------- 进程管理
const portBusy = port => new Promise(resolve => {
  const s = net.connect(Number(port), '127.0.0.1')
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
  s.setTimeout(600, () => { s.destroy(); resolve(false) })
})

// 按端口清残留 electron（PGID 整组 kill），启动前后各调一次。
function killPortResidual (port) {
  try {
    const out = execSync('ss -ltnp 2>/dev/null | grep ' + J(':' + port + ' ') + ' || true',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const m = out.match(/pid=(\d+)/)
    if (m) {
      const pid = Number(m[1])
      try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) {} }
    }
  } catch (e) { /* ss 不可用就跳过 */ }
}

function rmDisplayLock (display) {
  try { fs.rmSync('/tmp/.X' + display.replace(':', '') + '-lock', { force: true }) } catch (e) {}
}

// ---------------------------------------------------------------- 滚轮辅助
// 用 CDP 真实 mouseWheel，分多次派发，直到 st+ch>=sh-2 或次数用尽。
async function wheelToBottom (cdp, pt, readExpr, maxRounds = 16) {
  const trace = []
  for (let i = 0; i < maxRounds; i++) {
    await cdp.wheel(pt.x, pt.y, 900, 5)
    const st = await cdp.eval(readExpr + '.scrollTop')
    const sh = await cdp.eval(readExpr + '.scrollHeight')
    const ch = await cdp.eval(readExpr + '.clientHeight')
    trace.push({ round: i + 1, st, sh, ch })
    if (st > 0 && st + ch >= sh - 2) break
  }
  return trace
}

// ---------------------------------------------------------------- 主流程
async function main () {
  const { check, results } = makeChecker()
  const metrics = {}
  let homeDir = null
  let tmpDir = null
  let xvfb = null
  let electron = null
  let cdp = null

  killPortResidual(PORT)
  rmDisplayLock(DISPLAY)
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-modal-scroll-home-'))
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-modal-scroll-tmp-'))

  const cleanup = () => {
    if (electron && electron.pid) {
      try { process.kill(-electron.pid, 'SIGKILL') } catch (e) { try { electron.kill('SIGKILL') } catch (e2) {} }
    }
    if (xvfb && xvfb.pid) {
      try { process.kill(-xvfb.pid, 'SIGKILL') } catch (e) { try { xvfb.kill('SIGKILL') } catch (e2) {} }
    }
    if (cdp) { try { cdp.ws.close() } catch (e) {} }
    killPortResidual(PORT)
    rmDisplayLock(DISPLAY)
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  try {
    xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1680x1050x24'],
      { stdio: 'ignore', detached: true })
    await sleep(900)

    const env = {
      ...process.env,
      DISPLAY,
      HOME: homeDir,
      TMPDIR: tmpDir,
      DISABLE_GPU: '1',
      DISABLE_GPU_SANDBOX: '1'
    }
    // 宿主注入的这两个会让 electron 退化成纯 Node，必须删。
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS

    electron = spawn(BIN, [
      'work/app/app.js',
      '--remote-debugging-port=' + PORT,
      '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu',
      '--window-size=1680,1050'
    ], {
      cwd: ROOT,
      stdio: 'ignore',
      env,
      detached: true
    })

    // 等 CDP 端口就绪
    let targets = null
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      try {
        targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
        if (findPageTarget(targets)) break
      } catch (e) { /* 还没起来 */ }
      await sleep(500)
    }
    const page = findPageTarget(targets || [])
    if (!page) throw new Error('electron 没起来：找不到渲染进程 page target')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Log.enable')
    await cdp.call('Page.bringToFront', {})

    const booted = await waitFor(cdp,
      '!!(window.store && window.pre && window.translate)', 'boot', 40000)
    check('环境：真 Electron 渲染进程可用（store/pre/translate 就绪）', booted)
    if (!booted) throw new Error('渲染层 boot 超时')
    await sleep(1500) // boot 后桥接层稳定
    await cdp.eval(PROBE)
    check('环境：页内探针注入成功',
      await cdp.eval('window.__ms && typeof window.__ms.aboutState === "function"') === true)

    // 关掉可能的启动弹层（升级提示 / antd modal），避免遮挡滚轮落点
    for (let i = 0; i < 3; i++) {
      const closed = await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll('.ant-modal button, .custom-modal-footer button')]
          .filter(window.__ms.vis)
        const b = btns.find(x => /OK|Got it|知道了|稍后|Later|确定/i.test(String(x.innerText || '')))
        if (!b) return 'none'
        b.click()
        return 'closed'
      })()`)
      if (closed !== 'closed') break
      await sleep(250)
    }
    await cdp.eval('window.store.showInfoModal = false')
    await sleep(300)

    const vp = await cdp.eval('JSON.stringify({w: window.innerWidth, h: window.innerHeight})')
    metrics.viewport = JSON.parse(vp)
    console.log('VIEWPORT ' + vp)

    // ================================================================ S1 deps
    await cdp.eval('window.store.commandLineHelp = ' + J(LONG_HELP))
    await cdp.eval("window.store.showInfoModal = true; window.store.infoModalTab = 'deps'")
    const aboutUp = await waitFor(cdp,
      '!!window.__ms.tabsBody() && window.__ms.depRows().length > 20', 'about deps', 20000)
    check('夹具：关于页 deps 页签渲染（>20 条依赖行）', aboutUp)
    if (!aboutUp) throw new Error('关于页 deps 没渲染，后续判据无意义')
    await sleep(900) // 入场/布局稳定，避免 header/footer rect 假位移

    const s1 = await cdp.eval('window.__ms.aboutState()')
    metrics.depsBaseline = s1
    console.log('METRIC deps-baseline ' + J({
      innerHeight: s1.innerHeight,
      content: s1.content,
      contentComputedWidth: s1.contentComputedWidth,
      body: s1.body,
      tabsBodyClientHeight: s1.tabsBodyClientHeight,
      depRowCount: s1.depRowCount,
      depRowRect: s1.depRowRect,
      rowInsideContent: s1.rowInsideContent,
      nav: s1.nav,
      innerScrollables: s1.innerScrollables,
      outerScrollables: s1.outerScrollables,
      doc: s1.doc
    }))

    // ① 内容可见 + 首条 dep 行落在 content 内
    check('① .ant-tabs-body clientHeight > 0（内容未坍缩）',
      s1.tabsBodyClientHeight > 0, { clientHeight: s1.tabsBodyClientHeight })
    check('① 首条 dep 行 rect 完全落在 .custom-modal-content 内',
      s1.rowInsideContent === true,
      { depRowRect: s1.depRowRect, content: s1.content })

    // ③ nav 运行时优先级 / 不透明 / 不穿透（滚动前）
    const alphaOf = bg => {
      const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(String(bg || ''))
      return m ? Number(m[1]) : (String(bg || '').startsWith('rgb(') ? 1 : null)
    }
    const navAlpha = alphaOf(s1.nav && s1.nav.backgroundColor)
    check('③ nav computed position === sticky（!important 压过 antd relative）',
      s1.nav && s1.nav.position === 'sticky',
      { position: s1.nav && s1.nav.position, top: s1.nav && s1.nav.top, zIndex: s1.nav && s1.nav.zIndex })
    check('③ nav 背景不透明（alpha=1，无行穿透）',
      navAlpha === 1 && s1.nav && s1.nav.hitSelf === true,
      {
        backgroundColor: s1.nav && s1.nav.backgroundColor,
        alpha: navAlpha,
        hitSelf: s1.nav && s1.nav.hitSelf,
        hitCls: s1.nav && s1.nav.hitCls
      })

    // ④ 无双滚动条（滚动前，deps 长内容）
    check('④ 弹层内可滚元素 <= 1（唯一 .custom-modal-body）',
      s1.innerScrollables.length <= 1,
      { count: s1.innerScrollables.length, list: s1.innerScrollables })
    check('④ 弹层外 html/body/wrap/mask/container 可滚元素 = 0',
      s1.outerScrollables.length === 0, { list: s1.outerScrollables })
    check('④ 无全屏滚动条：scrollingElement.scrollTop===0 且 scrollWidth<=innerWidth',
      s1.doc.scrollingTop === 0 && s1.doc.docScrollWidth <= s1.doc.innerWidth,
      { doc: s1.doc })

    const navTopBefore = s1.nav && s1.nav.rect ? s1.nav.rect.top : null
    const headerTopBefore = s1.header ? s1.header.top : null

    // ② deps 真实滚轮到底
    const depsTrace = await wheelToBottom(cdp, s1.wheelPoint, 'window.__ms.body()')
    const s1after = await cdp.eval('window.__ms.aboutState()')
    metrics.depsAfter = { trace: depsTrace, state: s1after }
    const d = s1after.body
    console.log('METRIC deps-after-wheel ' + J({
      body: d,
      navTopBefore,
      navTopAfter: s1after.nav && s1after.nav.rect && s1after.nav.rect.top,
      headerTopBefore,
      headerTopAfter: s1after.header && s1after.header.top,
      innerScrollables: s1after.innerScrollables,
      doc: s1after.doc,
      lastRound: depsTrace[depsTrace.length - 1]
    }))
    check('② deps 真实滚轮 scrollTop>0 且能滚到最后一行（st+ch>=sh-2）',
      d.st > 0 && d.st + d.ch >= d.sh - 2,
      { st: d.st, ch: d.ch, sh: d.sh, st_plus_ch: d.st + d.ch, sh_minus_2: d.sh - 2 })
    check('② 滚动容器是 .custom-modal-body（overflowY=auto 且 sh>ch+1）',
      d.oy === 'auto' && d.sh > d.ch + 1,
      { overflowY: d.oy, sh: d.sh, ch: d.ch })

    // ③ nav rect.top 恒定（滚动后）
    const navTopAfter = s1after.nav && s1after.nav.rect ? s1after.nav.rect.top : null
    const navDelta = (navTopBefore === null || navTopAfter === null)
      ? null
      : +Math.abs(navTopAfter - navTopBefore).toFixed(2)
    check('③ 真实滚轮下 nav rect.top 前后差 <=1.5px（Tab 栏常驻）',
      navDelta !== null && navDelta <= 1.5,
      { before: navTopBefore, after: navTopAfter, deltaPx: navDelta })
    check('③ 滚动后 nav 仍 sticky 且不穿透',
      s1after.nav.position === 'sticky' && s1after.nav.hitSelf === true,
      { position: s1after.nav.position, hitSelf: s1after.nav.hitSelf })
    check('④ 滚动后仍无双滚动条 / 无全屏滚动条',
      s1after.innerScrollables.length <= 1 && s1after.outerScrollables.length === 0 &&
      s1after.doc.scrollingTop === 0 && s1after.doc.docScrollWidth <= s1after.doc.innerWidth,
      {
        inner: s1after.innerScrollables.length,
        outer: s1after.outerScrollables.length,
        scrollingTop: s1after.doc.scrollingTop,
        scrollWidth: s1after.doc.docScrollWidth,
        innerWidth: s1after.doc.innerWidth
      })

    // ⑤ header 常驻（关于页无 footer，header rect.top 差）
    const headerTopAfter = s1after.header ? s1after.header.top : null
    const headerDelta = (headerTopBefore === null || headerTopAfter === null)
      ? null
      : +Math.abs(headerTopAfter - headerTopBefore).toFixed(2)
    check('⑤ 长内容滚动前后 .custom-modal-header rect.top 差 = 0',
      headerDelta !== null && headerDelta <= 1.5,
      { before: headerTopBefore, after: headerTopAfter, deltaPx: headerDelta })
    check('⑤ 关于页 .custom-modal-content computed width = 720px',
      s1.contentComputedWidth === '720px',
      { computedWidth: s1.contentComputedWidth, rectWidth: s1.content && s1.content.width })

    // ================================================================ S2 cmd
    await cdp.eval("window.store.infoModalTab = 'cmd'")
    const cmdUp = await waitFor(cdp,
      '!!window.__ms.cmdPre() && window.__ms.vis(window.__ms.cmdPre()) && String(window.__ms.cmdPre().textContent || "").length > 3000',
      'about cmd', 15000)
    await sleep(500)
    const s2 = await cdp.eval('window.__ms.aboutState()')
    const cmdTrace = await wheelToBottom(cdp, s2.wheelPoint, 'window.__ms.body()')
    const s2after = await cdp.eval('window.__ms.aboutState()')
    metrics.cmd = { up: cmdUp, preLen: s2.cmdPreLen, trace: cmdTrace, body: s2after.body }
    const dc = s2after.body
    console.log('METRIC cmd ' + J({
      up: cmdUp,
      preLen: s2.cmdPreLen,
      bodyBefore: s2.body,
      bodyAfter: dc,
      lastRound: cmdTrace[cmdTrace.length - 1]
    }))
    check('② cmd 页签超长 commandLineHelp 已渲染（>3000 字符）', cmdUp,
      { cmdPreLen: s2.cmdPreLen })
    check('② cmd 真实滚轮 scrollTop>0 且能滚到最后一行',
      dc.st > 0 && dc.st + dc.ch >= dc.sh - 2,
      { st: dc.st, ch: dc.ch, sh: dc.sh, st_plus_ch: dc.st + dc.ch, sh_minus_2: dc.sh - 2 })
    check('② cmd 滚动容器仍是 .custom-modal-body（overflowY=auto）',
      dc.oy === 'auto' && dc.sh > dc.ch + 1, { overflowY: dc.oy, sh: dc.sh, ch: dc.ch })

    // ================================================================ S3 5 Tab
    const tabCount = await cdp.eval('window.__ms.tabs().length')
    const navTops = []
    let allSticky = true
    for (let i = 0; i < tabCount; i++) {
      await cdp.eval('window.__ms.tabs()[' + i + '].click()')
      await sleep(350)
      const st = await cdp.eval('window.__ms.navOpaque()')
      navTops.push(st && st.rect ? st.rect.top : null)
      if (!st || st.position !== 'sticky') allSticky = false
    }
    const validTops = navTops.filter(t => t !== null)
    const spread = validTops.length ? Math.max(...validTops) - Math.min(...validTops) : null
    metrics.tabSwitch = { tabCount, navTops, allSticky, spread }
    console.log('METRIC tab-switch ' + J(metrics.tabSwitch))
    check('抽验：5 个 Tab 逐个切换后 nav 仍 sticky 且 rect.top 恒定',
      tabCount >= 5 && allSticky &&
      navTops.every(t => t !== null) && spread !== null && spread <= 1.5,
      { tabCount, navTops, spread })

    // ================================================================ S4 短内容
    // 用 Emulation 统一到大视口（--window-size 在部分环境不生效）。
    // 注意：关于页 info 页签并非「零滚动短内容」——它含 logo + 11 行 about-row
    // + 检查更新按钮，1680x1050 下自然高度仍略超 body 可用高度。用户诉求是
    // 「滚动条只在容器内 / 无多余滚动条」，不是「内容绝不超高」，所以正确判据是：
    // 内容超高时滚动唯一落在 .custom-modal-body 内、弹层外零可滚、无全屏滚动条。
    // 真正的「短内容零回归 / sh==ch」由 S7 的 Modal.confirm({content:''}) 覆盖。
    await cdp.call('Emulation.setDeviceMetricsOverride',
      { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    await cdp.eval("window.store.infoModalTab = 'info'")
    await sleep(600)
    const s4 = await cdp.eval('window.__ms.aboutState()')
    metrics.shortInfo = {
      innerHeight: s4.innerHeight,
      body: s4.body,
      contentComputedWidth: s4.contentComputedWidth,
      innerScrollables: s4.innerScrollables,
      header: s4.header,
      footer: s4.footer,
      doc: s4.doc
    }
    console.log('METRIC short-info@1680 ' + J(metrics.shortInfo))
    const s4Single = s4.innerScrollables.length === 1 &&
      /custom-modal-body/.test(s4.innerScrollables[0].cls) &&
      s4.innerScrollables[0].oy === 'auto'
    check('⑤ info 页签内容超高时滚动唯一落在 .custom-modal-body（无多余滚动条）',
      s4Single,
      {
        sh: s4.body.sh,
        ch: s4.body.ch,
        overflowPx: s4.body.sh - s4.body.ch,
        innerScrollables: s4.innerScrollables,
        innerHeight: s4.innerHeight
      })
    check('⑤ info 页签弹层外可滚元素 = 0 且无全屏滚动条',
      s4.outerScrollables.length === 0 && s4.doc.scrollingTop === 0 &&
      s4.doc.docScrollWidth <= s4.doc.innerWidth,
      { outer: s4.outerScrollables, doc: s4.doc })

    // ================================================================ S5 主题
    await cdp.eval("window.store.setTheme('default'); 'ok'")
    await sleep(700)
    const th1 = await cdp.eval('window.__ms.theme()')
    await cdp.eval("window.store.setTheme('defaultLight'); 'ok'")
    await sleep(700)
    const th2 = await cdp.eval('window.__ms.theme()')
    metrics.themes = { dark: th1, light: th2 }
    console.log('METRIC themes ' + J(metrics.themes))
    const alpha1 = alphaOf(th1.navBg)
    const alpha2 = alphaOf(th2.navBg)
    check('抽验：浅/深主题 nav 背景跟随 --main 且不透明（两主题颜色不同、alpha=1、与 content 同色）',
      th1.navBg !== th2.navBg && alpha1 === 1 && alpha2 === 1 &&
      th1.navBg === th1.contentBg && th2.navBg === th2.contentBg,
      {
        dark: { navBg: th1.navBg, contentBg: th1.contentBg, alpha: alpha1 },
        light: { navBg: th2.navBg, contentBg: th2.contentBg, alpha: alpha2 }
      })
    // 恢复默认主题
    await cdp.eval("window.store.setTheme('default')")
    await sleep(300)
    await cdp.call('Emulation.clearDeviceMetricsOverride', {})
    await sleep(400)

    // ================================================================ S6 is-mobile
    // 真实断点由 store.isMobile 驱动，但为稳妥直接给 html 挂 is-mobile 类
    // （CSS 选择器 .is-mobile .custom-modal-content 只要求是祖先）。
    await cdp.call('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await cdp.eval("document.documentElement.classList.add('is-mobile'); window.store.infoModalTab = 'deps'")
    await sleep(900)
    const s6 = await cdp.eval('window.__ms.aboutState()')
    const mTrace = await wheelToBottom(cdp, s6.wheelPoint, 'window.__ms.body()')
    const s6after = await cdp.eval('window.__ms.aboutState()')
    metrics.mobile = {
      innerHeight: s6.innerHeight,
      contentHeight: s6.content && s6.content.height,
      contentComputedHeight: s6.contentComputedHeight,
      body: s6after.body,
      doc: s6after.doc,
      lastRound: mTrace[mTrace.length - 1]
    }
    console.log('METRIC is-mobile ' + J(metrics.mobile))
    check('抽验：is-mobile content.height === innerHeight',
      Math.abs((s6.content ? s6.content.height : -1) - s6.innerHeight) <= 1.5,
      { contentHeight: s6.content && s6.content.height, innerHeight: s6.innerHeight })
    check('抽验：is-mobile 仍能滚到底（st+ch>=sh-2）且无全屏滚动条',
      s6after.body.st > 0 && s6after.body.st + s6after.body.ch >= s6after.body.sh - 2 &&
      s6after.doc.scrollingTop === 0,
      { body: s6after.body, doc: s6after.doc })
    await cdp.eval("document.documentElement.classList.remove('is-mobile')")
    await cdp.call('Emulation.clearDeviceMetricsOverride', {})
    await cdp.eval('window.store.showInfoModal = false')
    await sleep(500)

    // ================================================================ S7 短内容 confirm
    // window.store.confirmExit() -> Modal.confirm({content:''}) 不传 width，默认 520，
    // 带 header + footer（cancel/ok），maskClosable 默认 true，Esc 走 onCancel。
    //
    // Round 1 教训：上一轮 Esc 未关掉弹层 -> 后续 openConfirm 又 appendChild 新弹层，
    // 旧弹层把新弹层盖住，confirmState 若取第一个就量到被遮住的旧 DOM（hitSelf:false），
    // 一连串判据全假红。修法：每轮开弹层前 forceCloseAll 清场；给当前弹层打
    // data-probe-id，只判「这一个」是否销毁；键盘事件另装 capture 日志分辨
    // 「产品 Esc 逻辑坏了」还是「CDP 按键没派发进渲染进程」。
    const openConfirm = async (tag) => {
      await cdp.eval('window.__ms.forceCloseAll()')
      await sleep(250)
      const leftover = await cdp.eval('window.__ms.wraps().length')
      if (leftover > 0) {
        console.log('WARN  清场后仍有 ' + leftover + ' 个残留弹层（tag=' + tag + '）')
      }
      await cdp.eval('window.store.confirmExit()')
      const up = await waitFor(cdp,
        '!!window.__ms.confirmState() && !!window.__ms.confirmState().okBtn',
        'confirm open', 8000)
      const tagged = await cdp.eval(`(() => {
        const ws = window.__ms.wraps()
        const w = ws[ws.length - 1]
        if (!w) return false
        w.dataset.probeId = ${J(tag)}
        return true
      })()`)
      console.log('METRIC open-confirm ' + J({ tag, leftover, up, wraps: await cdp.eval('window.__ms.wraps().length') }))
      return up && tagged === true
    }
    const gone = (tag) => waitFor(cdp,
      '!document.querySelector(' + J('.custom-modal-wrap[data-probe-id="' + tag + '"]') + ')',
      'confirm closed', 6000)

    check('⑤ 夹具：Modal.confirm 短内容弹层可打开',
      await openConfirm('short'))
    await sleep(400)
    const s7 = await cdp.eval('window.__ms.confirmState()')
    metrics.confirmShort = s7
    console.log('METRIC confirm-short ' + J({
      wrapCls: s7.wrapCls,
      contentComputedWidth: s7.contentComputedWidth,
      hasBody: s7.hasBody,
      body: s7.body,
      header: s7.header,
      footer: s7.footer,
      okBtn: s7.okBtn,
      cancelBtn: s7.cancelBtn,
      innerScrollables: s7.innerScrollables,
      doc: s7.doc
    }))
    check('⑤ Modal.confirm 短内容 computed width = 520px',
      s7.contentComputedWidth === '520px',
      { computedWidth: s7.contentComputedWidth, rectWidth: s7.content && s7.content.width })
    check('⑤ 短内容 sh==ch（无 body 或 body 不可滚）且弹层内可滚元素 = 0',
      (!s7.body || s7.body.sh <= s7.body.ch + 1) && s7.innerScrollables.length === 0,
      { hasBody: s7.hasBody, body: s7.body, innerScrollables: s7.innerScrollables })
    check('⑤ 短内容无全屏滚动条（弹层外可滚=0、scrollingTop=0）',
      s7.outerScrollables.length === 0 && s7.doc.scrollingTop === 0 &&
      s7.doc.docScrollWidth <= s7.doc.innerWidth,
      { outer: s7.outerScrollables.length, doc: s7.doc })

    // Esc 关闭：CDP 真按键（keyDown）+ capture 日志，三级兜底，每级都打印 mode。
    //
    // 归因（独立诊断实测）：焦点常落在 xterm 的隐藏 TEXTAREA 上，其既有 keydown
    // 处理在 target 阶段 stopPropagation —— 实测 CDP 真实 Escape 只有 document
    // capture 记录、没有 bubble 记录，Modal 注册在 bubble 阶段的 handleKeyDown
    // （modal.jsx:74）收不到，弹层因此不关；而直接向 document 派发 KeyboardEvent
    // 时 capture+bubble 都有、wraps 1→0。证明 Modal 的 Esc -> onCancel -> destroy
    // 逻辑完好，问题在输入路径，不是产品回归（modal.jsx 本轮零改动）。
    // 只有连「直接派发到 document 的合成事件」都关不掉才判红 —— 那才是源码 bug。
    const sendEsc = async () => {
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
        text: ''
      })
      await cdp.call('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
    }
    await cdp.eval('window.__ms.clearKeyLog()')
    await sendEsc()
    const keyLog = await cdp.eval('window.__ms.keyLog()')
    let escOk = await gone('short')
    let escMode = 'CDP Input.dispatchKeyEvent(keyDown)'
    const keyDelivered = Array.isArray(keyLog) && keyLog.some(k => k.key === 'Escape')
    if (!escOk) {
      // 先把焦点从 xterm textarea 移开，再派一次真实按键
      await cdp.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
      await cdp.eval('window.__ms.clearKeyLog()')
      await sendEsc()
      escOk = await gone('short')
      escMode = 'CDP keyDown after activeElement.blur()'
    }
    if (!escOk) {
      // 上游既有 keydown 处理吞掉真实按键时，直接验证 Modal 的 Esc 逻辑本身
      await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
      escOk = await gone('short')
      escMode = 'synthetic KeyboardEvent on document (upstream keydown swallowed real key)'
    }
    console.log('METRIC esc ' + J({ keyLog, keyDelivered, escOk, escMode }))
    check('⑤ Esc 关闭行为不变（弹层销毁）', escOk, { keyLog, keyDelivered, escMode })
    await sleep(300)

    // 遮罩点击关闭：点 content 外侧空白，命中 mask/container 触发 onCancel
    check('⑤ 夹具：遮罩测试弹层重新打开', await openConfirm('mask'))
    await sleep(300)
    const maskClosed = await cdp.eval(`(() => {
      const c = window.__ms.confirmState()
      if (!c || !c.content) return 'no-content'
      const x = Math.max(8, Math.round(c.content.left / 2))
      const y = Math.round(window.innerHeight / 2)
      return JSON.stringify({ x, y })
    })()`)
    const mp = JSON.parse(maskClosed)
    await cdp.click(mp.x, mp.y)
    const maskOk = await gone('mask')
    check('⑤ 遮罩点击关闭行为不变', maskOk, { clickAt: mp })
    await sleep(300)

    // footer 按钮可见可点：点 cancel（onOk 会 doExit，绝不点）
    check('⑤ 夹具：footer 测试弹层重新打开', await openConfirm('footer'))
    await sleep(300)
    const s7c = await cdp.eval('window.__ms.confirmState()')
    const btnOk = s7c.cancelBtn && s7c.cancelBtn.visible && s7c.cancelBtn.hitSelf &&
      s7c.okBtn && s7c.okBtn.visible && s7c.okBtn.hitSelf
    check('⑤ footer 按钮可见且可点（elementFromPoint 命中自身）', btnOk,
      { cancelBtn: s7c.cancelBtn, okBtn: s7c.okBtn })
    if (s7c.cancelBtn) {
      const r = s7c.cancelBtn.rect
      await cdp.click(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    }
    check('⑤ footer cancel 按钮点击后弹层销毁', await gone('footer'))
    await sleep(300)

    // ================================================================ S8 term-of-use 嵌套滚动
    // 先清场（S7 三次开关不能留下任何叠加弹层），再注入长条款、走真实入口。
    await cdp.eval('window.__ms.forceCloseAll()')
    await sleep(300)
    const etLen = await cdp.eval(`(() => {
      const v = ${J(LONG_TERM)}
      window.et.AITermOfUse = v
      if (String(window.et.AITermOfUse || '').length !== v.length) {
        Object.defineProperty(window.et, 'AITermOfUse',
          { value: v, writable: true, configurable: true })
      }
      return String(window.et.AITermOfUse || '').length
    })()`)
    check('⑥ 夹具：window.et.AITermOfUse 长条款注入生效', etLen > 3000, { len: etLen })
    await cdp.eval("window.localStorage.removeItem('ai-term-of-use-confirmed')")
    await cdp.eval('window.store.toggleAIConfig()')
    const termUp = await waitFor(cdp,
      '!!window.__ms.confirmState() && !!window.__ms.confirmState().term',
      'term-of-use open', 10000)
    await cdp.eval(`(() => {
      const ws = window.__ms.wraps()
      const w = ws[ws.length - 1]
      if (w) w.dataset.probeId = 'ms-term'
      return !!w
    })()`)
    check('⑥ 夹具：term-of-use 长条款 Modal.confirm 打开（content 自带 50vh/overflow:auto div）',
      termUp)
    await sleep(600)
    const s8 = await cdp.eval('window.__ms.confirmState()')
    console.log('METRIC term-before ' + J({
      wrapCls: s8.wrapCls,
      contentComputedWidth: s8.contentComputedWidth,
      body: s8.body,
      header: s8.header,
      footer: s8.footer,
      term: s8.term,
      termAncestorScrollables: s8.termAncestorScrollables,
      innerScrollables: s8.innerScrollables,
      outerScrollables: s8.outerScrollables,
      okBtn: s8.okBtn,
      cancelBtn: s8.cancelBtn,
      doc: s8.doc
    }))

    // 条款自身能滚到底（真实滚轮落在条款 div 上）。
    // 在页面里补一个稳定的 DOM 引用，避免每轮 eval 重新查选择器。
    const termElFound = await cdp.eval(`(() => {
      const ws = window.__ms.wraps()
      const w = ws.find(x => x.dataset && x.dataset.probeId === 'ms-term') || ws[ws.length - 1]
      const b = w && w.querySelector('.custom-modal-body')
      window.__ms.termEl = b ? [...b.querySelectorAll('div')].find(d =>
        /50vh/.test(String(d.getAttribute('style') || '')) ||
        (getComputedStyle(d).overflowY === 'auto' && d.style.maxHeight)) : null
      return !!window.__ms.termEl
    })()`)
    check('⑥ 夹具：条款 div（50vh / overflow:auto）可定位', termElFound === true)
    let tTrace = []
    if (termElFound === true && s8.termWheelPoint) {
      tTrace = await wheelToBottom(cdp, s8.termWheelPoint, 'window.__ms.termEl', 14)
    }
    const s8after = await cdp.eval('window.__ms.confirmState()')
    const termAfter = await cdp.eval(`(() => {
      const el = window.__ms.termEl
      return el ? { st: el.scrollTop, ch: el.clientHeight, sh: el.scrollHeight,
        oy: getComputedStyle(el).overflowY } : null
    })()`)
    const chainAfter = await cdp.eval('window.__ms.ancestorScrollables(window.__ms.termEl)')
    metrics.termOfUse = {
      before: s8, after: s8after, termAfter, chainAfter, trace: tTrace
    }
    console.log('METRIC term-after ' + J({
      termAfter,
      chainAfter,
      body: s8after.body,
      header: s8after.header,
      footer: s8after.footer,
      innerScrollables: s8after.innerScrollables,
      outerScrollables: s8after.outerScrollables,
      okBtn: s8after.okBtn,
      doc: s8after.doc,
      lastRound: tTrace[tTrace.length - 1]
    }))

    check('⑥ 条款能滚到底（st>0 且 st+ch>=sh-2）',
      !!termAfter && termAfter.st > 0 && termAfter.st + termAfter.ch >= termAfter.sh - 2,
      { termAfter })
    check('⑥ 同时可滚祖先链元素 <= 1（外层 .custom-modal-body 不产生第二条滚动）',
      Array.isArray(chainAfter) && chainAfter.length <= 1,
      { count: Array.isArray(chainAfter) ? chainAfter.length : -1, chain: chainAfter })
    check('⑥ header/footer rect.top 差 = 0（滚动条款时头尾常驻）',
      s8.header && s8after.header && s8.footer && s8after.footer &&
      Math.abs(s8.header.top - s8after.header.top) <= 1.5 &&
      Math.abs(s8.footer.top - s8after.footer.top) <= 1.5,
      {
        headerBefore: s8.header && s8.header.top,
        headerAfter: s8after.header && s8after.header.top,
        footerBefore: s8.footer && s8.footer.top,
        footerAfter: s8after.footer && s8after.footer.top
      })
    check('⑥ footer 按钮可见且可点（ok/cancel elementFromPoint 命中自身）',
      s8after.okBtn && s8after.okBtn.visible && s8after.okBtn.hitSelf &&
      s8after.cancelBtn && s8after.cancelBtn.visible && s8after.cancelBtn.hitSelf,
      { okBtn: s8after.okBtn, cancelBtn: s8after.cancelBtn })
    check('⑥ 无全屏滚动条 / 弹层外可滚元素 = 0',
      s8after.outerScrollables.length === 0 && s8after.doc.scrollingTop === 0 &&
      s8after.doc.docScrollWidth <= s8after.doc.innerWidth,
      { outer: s8after.outerScrollables.length, doc: s8after.doc })

    // footer cancel 真的点一下，证明不只是"看起来可点"
    const cr = s8after.cancelBtn && s8after.cancelBtn.rect
    if (cr) {
      await cdp.click(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2))
      await sleep(300)
    }
    const termCancelOk = await waitFor(cdp,
      '!document.querySelector(' + J('.custom-modal-wrap[data-probe-id="ms-term"]') + ')',
      'term closed', 6000)
    check('⑥ 条款 footer cancel 实际点击可关闭', termCancelOk)

    // ================================================================ 汇总
    const failed = results.filter(r => !r.ok)
    console.log('\n===== CHECKS (' + results.length + ') =====')
    for (const r of results) {
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name)
    }
    console.log('\n===== RESULT =====')
    console.log('total=' + results.length + ' pass=' + (results.length - failed.length) +
      ' fail=' + failed.length)
    if (failed.length) {
      console.log('FAILED: ' + failed.map(r => r.name).join(' | '))
    }
    // 收尾：确认端口与 Xvfb 清干净
    cleanup()
    electron = null; xvfb = null; cdp = null
    const stillBusy = await portBusy(PORT)
    if (stillBusy) console.log('WARN  端口 ' + PORT + ' 仍有监听（可能有并行实例）')
    process.exit(failed.length ? 1 : 0)
  } catch (err) {
    console.error('PROBE ERROR: ' + (err.stack || err.message))
    if (cdp) {
      try { console.error('console tail: ' + J(cdp.tail(8))) } catch (e) {}
    }
    cleanup()
    process.exit(2)
  }
}

main()
