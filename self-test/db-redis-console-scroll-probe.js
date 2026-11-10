#!/usr/bin/env node
/**
 * redis 命令控制台 · 双滚动条定向实测探针
 *
 * 背景：用户截图报告「命令控制台弹层出现双滚动条」。全局弹层 SSOT 探针
 * （modal-scroll-cdp-probe.js，74 判据）全部 PASS，证明 antd Modal 的
 * wrap/container/body 通道在 antd6 下整体生效——问题应出在弹层内容层。
 * 截图细看：双滚动条都出现在 .db-redis-console-suggest 补全浮层右缘
 * （空输入 + 命令表展开态），而非历史列表。本探针实机复现该场景并量化
 * 「浮层内 / 浮层祖先链 / 弹层 body」三层的滚动状态，定位第二条滚动条归属。
 *
 * 用法：node self-test/db-redis-console-scroll-probe.js
 * 退出码：0 = 复现成功并产出诊断（或确认无双滚动条）；1 = 判据 FAIL；
 *         2 = 环境/链路失败（如无 redis 时工具条不渲染）。
 *
 * 无真实 redis 也能跑：db tab 连接失败进入错误态，若键列表工具条（含
 * .db-redis-console-open）仍渲染，即可打开弹层（命令表加载失败只影响
 * listError 提示，不阻塞 suggest 场景）；若错误态不渲染工具条，则报 2。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  Cdp, getJson, findPageTarget, sleep, waitFor, makeChecker
} = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const PORT = '9397'
const DISPLAY = ':151'
const BIN = path.join(ROOT, 'node_modules/electron/dist/electron')

// 页内探针：滚动工具 + redis 控制台专用查询。模板字符串，禁 ${...}。
const PROBE = `(() => {
  const vis = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0
  }
  const brief = el => ({
    tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 100),
    sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop,
    oy: getComputedStyle(el).overflowY
  })
  const isScrollableY = el => {
    if (!el) return false
    const s = getComputedStyle(el)
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 1
  }
  const q = sel => document.querySelector(sel)
  const modal = () => q('.ant-modal.db-redis-console')
  const modalBody = () => modal() && modal().querySelector('.ant-modal-body')
  const suggest = () => modal() && modal().querySelector('.db-redis-console-suggest')
  const input = () => modal() && modal().querySelector('.db-redis-console-line input')
  const ancestorScrollables = el => {
    const out = []
    let n = el && el.parentElement
    while (n) {
      if (isScrollableY(n)) out.push(brief(n))
      n = n.parentElement
    }
    return out
  }
  const innerScrollables = () => {
    const m = modal()
    if (!m) return []
    return [...m.querySelectorAll('*')].filter(vis).filter(isScrollableY).map(brief)
  }
  const chainInfo = () => {
    const s = suggest()
    if (!s) return null
    const chain = []
    let n = s
    while (n && n !== document.body) {
      chain.push({
        cls: String(n.className || '').slice(0, 80),
        scrollable: isScrollableY(n),
        ...brief(n)
      })
      n = n.parentElement
    }
    return chain
  }
  window.__rc = {
    vis, brief, isScrollableY, q, modal, modalBody, suggest, input,
    ancestorScrollables, innerScrollables, chainInfo,
    modalExists: () => !!modal(),
    suggestExists: () => !!suggest(),
    suggestInfo: () => {
      const s = suggest()
      return s ? brief(s) : null
    },
    outerScrollables: () => {
      const sels = ['html', 'body', '.ant-modal-wrap']
      const out = []
      for (const sel of sels) {
        for (const el of [...document.querySelectorAll(sel)]) {
          if (vis(el) && isScrollableY(el)) out.push(brief(el))
        }
      }
      return out
    },
    pageScroll: () => ({
      st: document.scrollingElement.scrollTop,
      sw: document.scrollingElement.scrollWidth,
      iw: window.innerWidth
    }),
    bodyInfo: () => {
      const b = modalBody()
      return b ? brief(b) : null
    },
    hitAtSuggestEdge: () => {
      const s = suggest()
      if (!s) return null
      const r = s.getBoundingClientRect()
      const h = document.elementFromPoint(
        Math.round(r.right - 6), Math.round(r.top + r.height / 2))
      return h ? { cls: String(h.className || '').slice(0, 100), tag: h.tagName.toLowerCase() } : null
    }
  }
  return 'probe-injected'
})()`

async function main () {
  const { check, results } = makeChecker()
  let homeDir = null
  let tmpDir = null
  let xvfb = null
  let electron = null
  let cdp = null

  const killPortResidual = () => {
    try {
      const out = require('node:child_process').execSync(
        `ss -tlnp 2>/dev/null | grep ':${PORT}' || true`).toString()
      const pids = new Set()
      for (const m of out.matchAll(/pid=(\\d+)/g)) pids.add(m[1])
      for (const pid of pids) {
        try { process.kill(-Number(pid), 'SIGKILL') } catch (e) {}
      }
    } catch (e) {}
  }
  const rmDisplayLock = () => {
    try { fs.rmSync('/tmp/.X151-lock', { force: true }) } catch (e) {}
  }

  const cleanup = () => {
    for (const p of [electron, xvfb]) {
      if (p && p.pid) {
        try { process.kill(-p.pid, 'SIGKILL') } catch (e) { try { p.kill('SIGKILL') } catch (e2) {} }
      }
    }
    if (cdp) { try { cdp.ws.close() } catch (e) {} }
    killPortResidual()
    rmDisplayLock()
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  let exitCode = 0
  try {
    killPortResidual()
    rmDisplayLock()
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-rc-probe-home-'))
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-rc-probe-tmp-'))

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
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS

    electron = spawn(BIN, [
      'work/app/app.js',
      '--remote-debugging-port=' + PORT,
      '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu',
      '--window-size=1680,1050'
    ], { cwd: ROOT, stdio: 'ignore', env, detached: true })

    let targets = null
    const t0 = Date.now()
    while (Date.now() - t0 < 60000) {
      try {
        targets = await getJson('http://127.0.0.1:' + PORT + '/json/list')
        if (findPageTarget(targets)) break
      } catch (e) {}
      await sleep(500)
    }
    const page = findPageTarget(targets || [])
    if (!page) throw new Error('electron 没起来')
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.call('Runtime.enable')
    await cdp.call('Page.bringToFront', {})

    check('环境：渲染进程 boot（store/pre/translate）',
      await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
    await sleep(1500)
    await cdp.eval(PROBE)

    // 关启动弹层
    for (let i = 0; i < 3; i++) {
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.ant-modal button')]
          .find(x => /OK|Got it|知道了|稍后|Later|确定/i.test(String(x.innerText || '')))
        if (b) b.click()
        return 'done'
      })()`)
      await sleep(400)
    }

    // 建 redis db tab（连接会失败，弹层链路若渲染即够用）
    await cdp.eval(`(() => {
      window.store.addTab({
        type: 'database', dbType: 'redis', name: 'rc-probe',
        host: '127.0.0.1', port: 6379, dbIndex: 0
      })
      return 'tab-added'
    })()`)
    await sleep(2500)

    const boxOk = await waitFor(cdp, '!!document.querySelector(".db-session-box")',
      'db-session-box', 20000)
    check('db tab 已渲染（.db-session-box）', boxOk)

    // 等连接就绪后选择 db0（键空间 UI 需选中数据库才渲染工具条）
    const connOk = await waitFor(cdp,
      '(() => { const el = [...document.querySelectorAll("*")].find(' +
      'e => !e.children.length && e.textContent.trim() === "db0"); ' +
      'if (el) { el.click(); return true } return false })()',
      'select-db0', 30000)
    check('redis 连接就绪并已选择 db0', connOk)
    await sleep(1500)

    // 等命令控制台入口按钮（工具条随键空间渲染）
    const btnOk = await waitFor(cdp,
      '!!document.querySelector(".db-redis-console-open")', 'console-btn', 20000)
    check('命令控制台入口按钮可见', btnOk)
    if (!btnOk) {
      const snap = await cdp.eval(`(() => {
        const box = document.querySelector('.db-session-box')
        return box ? box.innerText.slice(0, 300) : 'no-box'
      })()`)
      console.log('[probe] 连接失败态未渲染工具条，tab 内容摘要：', snap)
      exitCode = 2
      return
    }

    await cdp.eval('document.querySelector(".db-redis-console-open").click()')
    const modalOk = await waitFor(cdp, '!!window.__rc.modal()', 'redis-console-modal', 15000)
    check('命令控制台弹层已打开', modalOk)
    if (!modalOk) { exitCode = 1; return }
    await sleep(1200) // 命令表加载（失败也有 listError，不阻塞 suggest）

    // 聚焦输入框并输入一个字符，确保 suggest 展开（截图即空输入展开态）
    await cdp.eval(`(() => {
      const el = window.__rc.input()
      if (el) el.focus()
      return 'focused'
    })()`)
    await sleep(400)
    try {
      await cdp.call('Input.insertText', { text: 'g' })
      await sleep(600)
    } catch (e) {}

    const suggestOk = await cdp.eval('window.__rc.suggestExists()')
    check('suggest 补全浮层已展开（复现截图场景）', suggestOk === true)

    // —— 核心量化：三条层的滚动状态 ——
    const inner = await cdp.eval('window.__rc.innerScrollables()')
    console.log('\n===== 弹层内可滚元素（预期：suggest 一个；多于一个即双滚动条复现）=====')
    console.log(JSON.stringify(inner, null, 2))
    check('弹层内可滚元素 ≤1（SSOT：body 为唯一通道，浮层自身一条）',
      Array.isArray(inner) && inner.length <= 1)

    const outer = await cdp.eval('window.__rc.outerScrollables()')
    console.log('\n===== 弹层外可滚元素（html/body/wrap，预期 0）=====')
    console.log(JSON.stringify(outer, null, 2))
    check('弹层外可滚元素 = 0', Array.isArray(outer) && outer.length === 0)

    const chain = await cdp.eval('window.__rc.chainInfo()')
    console.log('\n===== suggest 祖先链滚动状态 =====')
    console.log(JSON.stringify(chain, null, 2))

    const bodyInfo = await cdp.eval('window.__rc.bodyInfo()')
    const hit = await cdp.eval('window.__rc.hitAtSuggestEdge()')
    const pageScroll = await cdp.eval('window.__rc.pageScroll()')
    console.log('\n===== body / suggest 右缘命中 / 页面滚动 =====')
    console.log('body:', JSON.stringify(bodyInfo))
    console.log('suggest 右缘 elementFromPoint:', JSON.stringify(hit))
    console.log('page:', JSON.stringify(pageScroll))

    const st = await cdp.eval('document.scrollingElement.scrollTop')
    check('页面无滚动（scrollTop=0）', st === 0)
  } catch (e) {
    console.error('[probe] FAIL:', e.message)
    exitCode = exitCode || 1
  } finally {
    cleanup()
  }

  console.log('\\n===== RESULT =====')
  console.log(`total=${results.length} pass=${results.filter(r => r.ok).length} ` +
    `fail=${results.filter(r => !r.ok).length}`)
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name)
  }
  process.exit(exitCode || (results.some(r => !r.ok) ? 1 : 0))
}

main().catch(e => {
  console.error('[probe] fatal:', e)
  process.exit(2)
})
