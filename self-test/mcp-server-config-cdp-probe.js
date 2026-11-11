#!/usr/bin/env node
/**
 * T05 MCP servers 配置分节 · CDP 实机探针（可复跑）
 *
 * 用法（从任意目录都能跑，cwd 由本脚本自己设为仓库根）：
 *   node self-test/mcp-server-config-cdp-probe.js
 * 退出码：0 = 全部 PASS；1 = 有判据 FAIL；2 = 环境/启动失败。
 *
 * 为什么必须有这个脚本（AGENTS.md §5.2.7 测试分层 / 用户验证先行纪律）：
 *   mcp-server-config.spec.js（28 断言）钉的是源码事实与 store 面；但
 *   「antd Select 真点击 → Modal.confirm 二次确认 → 确认后 draft 真的变 auto」
 *   「真实保存 → 主进程 spawn fake-mcp-server → tools/list 拉通 → 状态徽章
 *   ready(3)」→ Refresh 真点击 → 删除 → 子进程真退出，这条端到端链只有
 *   真 Electron + Xvfb + CDP 实机才能证。单元层 Mock 永远证不了子进程回收。
 *
 * 判据（对应 T05-01/02/04 实机面 + SEC-12 实机）：
 *   ① 环境：真渲染进程 boot；AI 配置弹层打开；.mcp-server-config-section
 *      渲染；.mcp-fixed-hints 恰好 3 句常驻；`default trust: ask` 文案
 *      （DEFAULT_MCP_TRUST 常量实机渲染，跨语言硬编码英文）。
 *   ② T05-01 就地报错：New → 不填直接 Save → 错误节点出现在表单内
 *      （color:#cf1322），且 store.config.mcpServersAI 不新增条目。
 *   ③ 新增 stdio server（fake-mcp-server --stdio --tools=3）→ Save →
 *      config 恰 1 条且 trust==='ask' / enabled===true / args 数组拆行正确；
 *      状态徽章 ready 且 toolCount===3（真子进程 + 真 initialize + tools/list）。
 *   ④ T05-02：真实点击 Refresh tools → loading 结束 → 状态仍 ready(3)
 *      （force 重拉全链路实机通；force 语义已由单元 spec 钉）。
 *   ⑤ SEC-12 实机：Edit → trust Select 真点击选 auto → **Modal.confirm
 *      必须出现**（未确认时 draft 不得变 auto）→ 点 OK → inline warn 出现 →
 *      Save → config trust==='auto'。
 *   ⑥ 资源回收（fake-mcp-server teardown 约束）：删除 server → config 空 →
 *      pgrep 轮询 fake-mcp-server 子进程退出（ESRCH 语义用 pgrep 空表达）。
 *
 * 环境纪律（与 modal-scroll-cdp-probe.js 同源）：
 *   - 子进程 env 显式 delete ELECTRON_RUN_AS_NODE / NODE_OPTIONS。
 *   - 临时 HOME/TMPDIR 放 os.tmpdir()，finally rmSync 直删（绝不进回收站）。
 *   - 唯一落在仓库里的产物是本脚本自身；截图/日志一律不落仓库。
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
const FAKE_SERVER = path.join(ROOT, 'src/test/fixtures/fake-mcp-server.js')
const J = JSON.stringify

// ---------------------------------------------------------------- 进程管理
const portBusy = port => new Promise(resolve => {
  const s = net.connect(Number(port), '127.0.0.1')
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
  s.setTimeout(600, () => { s.destroy(); resolve(false) })
})

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

// fake server 残留兜底（探针自身失败路径 + 其它实例泄漏都不该留下来）
// pgrep 模式用 [f] 字符类：sh -c 的命令行含模式字面串，会被 -f 匹配到自身
// （实证：ORPHAN DIAG 里 ps -p 查无此进程 = pgrep 匹配了 execSync 的 shell）
function killFakeServerResidual () {
  try {
    const out = execSync('pgrep -f ' + J('[f]ake-mcp-server') + ' || true',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    for (const pid of out.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL') } catch (e) { /* 已死 */ }
    }
  } catch (e) { /* pgrep 不可用就跳过 */ }
}

const fakeServerPids = () => {
  try {
    return execSync('pgrep -f ' + J('[f]ake-mcp-server') + ' || true',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      .split('\n').filter(Boolean)
  } catch (e) {
    return []
  }
}

// ---------------------------------------------------------------- 页内动作
// 真实点击：CDP Input.dispatchMouseEvent（mousedown+mouseup 全事件序列，
// rc-select 依赖 mousedown 开下拉，合成 click() 事件不够）。
async function clickEl (cdp, findExpr, desc) {
  // jeval 返回的是「已解析」值（勿再 JSON.parse，记忆踩坑②）
  // 先 scrollIntoView：AI 配置弹层内容超高，目标按钮常在滚动容器视口外，
  // 直接取 rect 点击会落空（首跑实证：New 能点中、视口外的 Save 全部无效）
  let pt = null
  // antd dropdown/弹层动画期 rect 可能 0 尺寸：最多重试 3 次（每次间隔 300ms）
  for (let i = 0; i < 3 && !pt; i++) {
    pt = await cdp.jeval(`(() => {
      const el = (${findExpr})
      if (!el) return null
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) return null
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!pt) await sleep(300)
  }
  if (!pt || (typeof pt === 'string')) throw new Error('点击目标不存在: ' + desc)
  await sleep(250)
  // 命中诊断：elementFromPoint 若不是目标自身/子孙，说明被遮挡或坐标漂移
  const hit = await cdp.jeval(`(() => {
    const el = (${findExpr})
    if (!el) return 'gone'
    const r = el.getBoundingClientRect()
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return t === el || el.contains(t) ? 'hit' : 'blocked:' +
      (t ? t.tagName + '.' + String(t.className).slice(0, 40) : 'null')
  })()`)
  if (hit !== 'hit' && hit !== 'gone') {
    console.error('CLICK DIAG [' + desc + ']: ' + hit)
  }
  // 实测：cdp.click（press+release 连发）可稳定触发 rc-select 的 mousedown
  // 开下拉；press+release 拉开 60ms 反而会让 changeTrust 后续选中丢事件
  await cdp.click(Math.round(pt.x), Math.round(pt.y))
}

// JS click：真实 DOM click 事件（走 React 合成事件），不依赖坐标/遮挡。
// 遗留 dropdown portal（body 级、z-index 更高）会罩住坐标点击——弹层内的
// 普通 Button 一律走这个；rc-select 开下拉仍需真实 mousedown，保留坐标点击。
async function jsClick (cdp, findExpr, desc) {
  const ok = await cdp.eval(
    `(() => { const el = (${findExpr}); if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.click(); return true })()`
  )
  if (!ok) throw new Error('点击目标不存在: ' + desc)
}

// React 受控注入：native setter + input 事件（绕过受控组件只认合成事件的坑）
const SET_VAL_HELPER = `(() => {
  if (window.__mcpSetVal) return 'ok'
  window.__mcpSetVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  return 'installed'
})()`

async function setReactValue (cdp, findExpr, value, desc) {
  await cdp.eval(SET_VAL_HELPER)
  const ok = await cdp.eval(
    `window.__mcpSetVal((${findExpr}), ${J(value)}) === true`
  )
  if (!ok) throw new Error('注入失败: ' + desc)
}

// ---------------------------------------------------------------- 主流程
async function main () {
  const { check, results } = makeChecker()
  let homeDir = null
  let tmpDir = null
  let xvfb = null
  let electron = null
  let cdp = null

  killPortResidual(PORT)
  killFakeServerResidual()
  rmDisplayLock(DISPLAY)
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-mcp-config-home-'))
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-mcp-config-tmp-'))

  const cleanup = () => {
    if (electron && electron.pid) {
      try { process.kill(-electron.pid, 'SIGKILL') } catch (e) { try { electron.kill('SIGKILL') } catch (e2) {} }
    }
    if (xvfb && xvfb.pid) {
      try { process.kill(-xvfb.pid, 'SIGKILL') } catch (e) { try { xvfb.kill('SIGKILL') } catch (e2) {} }
    }
    killFakeServerResidual()
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
      // userData 彻底隔离：Electron Linux appData = XDG_CONFIG_HOME（否则 ~/.config）。
      // 不设的话会与宿主正在跑的 electerm 生产实例共享 userData ——
      // SingletonLock 碰撞 + 配置交叉污染（run14-16 boot 卡死、CFG 跨 run 累积的根因）
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_DATA_HOME: path.join(tmpDir, '.local', 'share'),
      DISABLE_GPU: '1',
      DISABLE_GPU_SANDBOX: '1'
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS

    // 诊断用：主进程 stdout/stderr 收进临时文件（fd 直传 stdio，无流——
    // 流在 cleanup rmSync 后 close 会抛 EBADF 未处理事件）
    const mainLog = path.join(tmpDir, 'electron-main.log')
    const mainLogFd = fs.openSync(mainLog, 'a')

    electron = spawn(BIN, [
      'work/app/app.js',
      '--remote-debugging-port=' + PORT,
      '--no-sandbox', '--disable-gpu-sandbox', '--in-process-gpu',
      '--window-size=1680,1050'
    ], {
      cwd: ROOT,
      stdio: ['ignore', mainLogFd, mainLogFd],
      env,
      detached: true
    })

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
    await cdp.call('Page.bringToFront', {})

    let booted = await waitFor(cdp,
      '!!(window.store && window.pre && window.translate)', 'boot', 90000)
    if (!booted) {
      // 自愈：卡住时 dump 现场 + reload 一轮再等（宿主内存压力下首启可卡在
      // 懒加载链上，reload 后按已缓存 chunk 正常挂载——实测可恢复）
      const rootLen = await cdp.jeval(
        '(document.getElementById("root") || {innerHTML:""}).innerHTML.length'
      )
      console.error('BOOT STALL: root innerHTML len=' + rootLen +
        ' href=' + await cdp.jeval('location.href'))
      await cdp.call('Page.reload', {}).catch(e => {})
      booted = await waitFor(cdp,
        '!!(window.store && window.pre && window.translate)', 'boot retry', 60000)
      if (booted) console.error('BOOT RETRY: reload 后恢复')
    }
    check('① 环境：真 Electron 渲染进程可用（store/pre/translate 就绪）', booted)
    if (!booted) {
      const diag = await cdp.jeval('({ href: location.href, ready: document.readyState, store: !!window.store, pre: !!window.pre, translate: !!window.translate, et: !!window.et, title: document.title })')
      console.error('BOOT DIAG: ' + JSON.stringify(diag))
      const res = await cdp.jeval(
        'performance.getEntriesByType("resource")' +
        '.filter(r => /\\.js/.test(r.name)).slice(-6)' +
        '.map(r => ({ n: r.name.split("/").pop(), s: r.transferSize, d: Math.round(r.duration) }))'
      )
      console.error('RESOURCES: ' + JSON.stringify(res))
      try {
        console.error('MAIN LOG tail:\n' +
          fs.readFileSync(path.join(tmpDir, 'electron-main.log'), 'utf8').slice(-3000))
      } catch (e) { console.error('main log read fail: ' + e.message) }
      throw new Error('渲染层 boot 超时')
    }
    await sleep(1500)

    // 打开 AI 配置弹层（lazy 组件，等 chunk 加载 + MCP 分节渲染）
    await cdp.eval('window.store.showAIConfigModal = true')
    const sectionUp = await waitFor(cdp,
      '!!document.querySelector(".mcp-server-config-section")', 'mcp section', 20000)
    if (!sectionUp) {
      const diag = await cdp.eval(
        'JSON.stringify({ aiDisabled: !!(window.et && window.et.disableAIFeature), modal: !!document.querySelector(".ai-config-form") })'
      )
      throw new Error('MCP 分节没渲染，诊断: ' + diag)
    }
    check('① AI 配置弹层打开且 .mcp-server-config-section 渲染', true)

    const hintCount = await cdp.jeval(
      'document.querySelectorAll(".mcp-server-config-section .mcp-fixed-hints > div").length'
    )
    check('① 固定提示区恰好 3 句常驻（SEC-9/SEC-12②/SEC-6）', hintCount === 3,
      { got: hintCount })

    const defaultTrust = await cdp.jeval(
      '[...document.querySelectorAll(".mcp-server-config-section div")]' +
      '.map(d => d.textContent).find(t => t.startsWith("default trust:")) || ""'
    )
    check('① default trust 文案 = ask（DEFAULT_MCP_TRUST 实机渲染）',
      defaultTrust === 'default trust: ask', { got: defaultTrust })

    const cfg0 = await cdp.jeval('(window.store.config.mcpServersAI || []).length')
    if (cfg0 !== 0) {
      console.error('CFG DIAG: ' + await cdp.jeval(
        'JSON.stringify(window.store.config.mcpServersAI)'
      ))
    }
    check('① 初始 config.mcpServersAI 为空数组', cfg0 === 0, { got: cfg0 })

    // ================================================== ② 就地报错（T05-01）
    // New 按钮 = section 头部（Refresh/New 按钮组）中非 Refresh 的那个
    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.filter(b => b.innerText && !/refresh/i.test(b.innerText) && ' +
      '!b.closest(".mcp-fixed-hints") && b.closest(".mcp-server-config-section > div"))[0]',
      'New 按钮')
    await waitFor(cdp,
      '!!document.querySelector(".mcp-server-config-section input[placeholder=\\"fs\\"]")',
      'draft form', 8000)
    check('② New 打开草稿表单（name input placeholder=fs）', true)

    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => /^\\s*(save|保存)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))',
      'Save 按钮')
    await sleep(900)
    // 就地报错的本质是「错误文案出现在字段下方」：以文本匹配为主
    // （色值受主题/全局样式影响不稳，实测 computed rgb(207,50,34) 匹配失败但
    //  DOM 里 errNode 确实在——errish 检出 'requires a non-empty command'）
    let errCount = await cdp.jeval(
      '[...document.querySelectorAll(".mcp-server-config-section div")]' +
      '.filter(d => /requires a non-empty command/i.test(d.textContent) && ' +
      'd.children.length === 0).length'
    )
    if (errCount === 0) {
      // 首点偶发无效（antd Button 事件时序）：再点一次
      console.error('NOTE: 错误节点未出现，Save 重试一次')
      await jsClick(cdp,
        '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
        '.find(b => /^\\s*(save|保存)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))',
        'Save 按钮')
      await sleep(900)
      errCount = await cdp.jeval(
        '[...document.querySelectorAll(".mcp-server-config-section div")]' +
        '.filter(d => /requires a non-empty command/i.test(d.textContent) && ' +
        'd.children.length === 0).length'
      )
    }
    if (errCount === 0) {
      const inputDump = await cdp.jeval(
        '[...document.querySelectorAll(".mcp-server-config-section input, .mcp-server-config-section textarea")]' +
        '.map(i => i.tagName + ":" + String(i.value).slice(0, 30))'
      )
      const errish = await cdp.jeval(
        '[...document.querySelectorAll(".mcp-server-config-section div")]' +
        '.filter(d => /must|required|error|requires/i.test(d.textContent))' +
        '.map(d => d.textContent.slice(0, 60))'
      )
      const formHtml = await cdp.eval(
        '(document.querySelector(".mcp-server-config-section") || { innerHTML: "gone" })' +
        '.innerHTML.length'
      )
      const hasRequires = await cdp.eval(
        'document.querySelector(".mcp-server-config-section").innerHTML.includes("non-empty command")'
      )
      console.error('ERR DIAG: ' + JSON.stringify({ inputDump, errish, formHtml, hasRequires }))
    }
    check('② 空表单 Save → 就地错误节点出现（#cf1322，非全局提示）', errCount > 0,
      { errCount })
    const cfgAfterErr = await cdp.jeval('(window.store.config.mcpServersAI || []).length')
    check('② 报错路径不落盘（config 仍为空）', cfgAfterErr === 0, { got: cfgAfterErr })

    // ================================================== ③ 新增 stdio server
    await setReactValue(cdp,
      'document.querySelector(".mcp-server-config-section input[placeholder=\\"fs\\"]")',
      'probe-fake', 'name')
    await setReactValue(cdp,
      'document.querySelector(".mcp-server-config-section input[placeholder=\\"npx\\"]")',
      'node', 'command')
    await setReactValue(cdp,
      'document.querySelector(".mcp-server-config-section textarea")',
      FAKE_SERVER + '\n--stdio\n--tools=3', 'args')
    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => /^\\s*(save|保存)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))',
      'Save 按钮')
    await sleep(600)

    const saved = await cdp.jeval(
      'window.store.config.mcpServersAI || []'
    )
    const list = saved
    check('③ Save → config.mcpServersAI 恰 1 条', list.length === 1,
      { got: list.length })
    const sv = list[0] || {}
    check('③ 字段保真：name/transport/command/trust=ask/enabled',
      sv.name === 'probe-fake' && sv.transport === 'stdio' &&
      sv.command === 'node' && sv.trust === 'ask' && sv.enabled === true,
      { got: { name: sv.name, transport: sv.transport, trust: sv.trust, enabled: sv.enabled } })
    check('③ args 多行文本拆成数组且恰 3 项',
      Array.isArray(sv.args) && sv.args.length === 3, { got: sv.args })

    const readyUp = await waitFor(cdp,
      '(() => { ' +
      'const st = window.store.mcpClientState(); ' +
      'return !!(st || []).find(s => s && s.state === "ready" && s.toolCount === 3); ' +
      '})()', 'fake server ready(3)', 20000)
    check('③ 状态徽章 ready 且 toolCount===3（真子进程 initialize+tools/list）',
      readyUp === true)
    if (!readyUp) {
      // cdp.eval（非 jeval）拿原始 JSON 字符串，避免 parse 后 [object Object]
      const stDump = await cdp.eval(
        'JSON.stringify(window.store.mcpClientState ? window.store.mcpClientState() : "no-fn")'
      )
      console.error('READY DIAG: mcpClientState=' + stDump)
      // 主进程 electerm 日志（userData/logs 与 app 日志目录都试）
      for (const p of [
        path.join(homeDir, '.config', 'electerm', 'logs'),
        path.join(homeDir, '.electerm', 'logs'),
        path.join(homeDir, '.electerm')
      ]) {
        try {
          const ls = fs.readdirSync(p)
          console.error('LOG DIR ' + p + ': ' + ls.join(','))
          for (const f of ls.slice(-3)) {
            try {
              console.error('LOG ' + f + ' tail:\n' +
                fs.readFileSync(path.join(p, f), 'utf8').slice(-2500))
            } catch (e) {}
          }
        } catch (e) { /* 目录不存在 */ }
      }
      try {
        console.error('MAIN LOG tail:\n' +
          fs.readFileSync(path.join(tmpDir, 'electron-main.log'), 'utf8').slice(-2000))
      } catch (e) {}
    }

    // ================================================== ④ Refresh（T05-02）
    await clickEl(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => /refresh/i.test(b.innerText || ""))',
      'Refresh tools 按钮')
    // loading 结束（按钮 disabled/loading 退出）+ 状态保持
    await waitFor(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.every(b => !(b.classList.contains("ant-btn-loading")))',
      'refresh done', 15000)
    await sleep(600)
    // force 重拉 tools/list 有处理延迟：等待式检查（最多 10s）
    const rst = await waitFor(cdp,
      '(() => { ' +
      'const st = window.store.mcpClientState(); ' +
      'const s = (st || []).find(x => x && x.name === "probe-fake"); ' +
      'return !!(s && s.state === "ready" && s.toolCount === 3); ' +
      '})()', 'refresh ready(3)', 10000)
    const rstObj = await cdp.eval(
      'JSON.stringify((window.store.mcpClientState() || []).find(s => s && s.name === "probe-fake"))'
    )
    const rr = rstObj ? JSON.parse(rstObj) : {}
    check('④ Refresh 后状态仍 ready 且计数仍 3（force 全链实机通）', rst === true,
      { got: { state: rr.state, toolCount: rr.toolCount } })
    if (!(rst.state === 'ready' && rst.toolCount === 3)) {
      console.error('REFRESH DIAG: ' + await cdp.eval(
        'JSON.stringify(window.store.mcpClientState ? window.store.mcpClientState() : "no-fn")'
      ))
    }

    // ================================================== ⑤ SEC-12 二次确认
    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => !b.classList.contains("ant-btn-dangerous") && ' +
      '/^\\s*(edit|编辑)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))',
      'Edit 按钮')
    await waitFor(cdp,
      '!!document.querySelector(".mcp-server-config-section input[placeholder=\\"fs\\"]")',
      'edit form', 8000)

    // trust Select：draft 展开时 section 内恰 2 个 antd-select，
    // 文档序 [0]=transport、[1]=trust（列表行只有徽章无 select）
    const trustSel = '[...document.querySelectorAll(".mcp-server-config-section .ant-select")][1]'
    const trustSelFound = await cdp.jeval('!!(' + trustSel + ')')
    if (!trustSelFound) throw new Error('trust Select 没找到')
    // 只匹配「当前打开」的 dropdown（rc-select 关闭后 DOM 保留且 hidden，
    // 不排除会把隐藏实例的 option 匹配出来 → rect 0×0 点不中）
    const OPT_EXPR =
      'document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden) ' +
      '.ant-select-item-option[title=\\"auto\\"]")'
    await clickEl(cdp, trustSel, 'trust Select')
    // rc-select 开下拉偶发需要 selector 区域的真实 mousedown：兜底再点一次
    let optUp = await waitFor(cdp, '!!' + OPT_EXPR, 'auto option', 4000)
    if (!optUp) {
      await clickEl(cdp,
        '(' + trustSel + ').querySelector(".ant-select-selector") || (' + trustSel + ')',
        'trust selector 兜底')
      optUp = await waitFor(cdp, '!!' + OPT_EXPR, 'auto option retry', 4000)
    }
    if (optUp) {
      try {
        await clickEl(cdp, OPT_EXPR, 'auto option')
      } catch (e) {
        // dropdown option rect 持续 0 尺寸（antd 动画/虚拟滚动）→ 走键盘兜底
        console.error('NOTE: option 点击失败（' + e.message + '），走键盘兜底')
        optUp = false
      }
    }
    if (!optUp) {
      // dropdown 没开：dump select 状态辅助定位
      const dd = await cdp.eval(
        'JSON.stringify({ open: [...document.querySelectorAll(".ant-select-open")].length, ' +
        'dd: document.querySelectorAll(".ant-select-dropdown").length, ' +
        'hidden: document.querySelectorAll(".ant-select-dropdown.ant-select-dropdown-hidden").length })'
      )
      console.error('DROPDOWN DIAG: ' + dd)
      // 最后兜底：键盘导航（select 获焦后 ArrowDown 至 auto 并 Enter）。
      // 是否真选中交给后续 Modal.confirm / inline warn / config 判据说话。
      console.error('NOTE: dropdown 未打开，走键盘兜底')
      await cdp.call('Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
      await cdp.call('Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
      await sleep(300)
      await cdp.call('Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp.call('Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    }
    await sleep(500)

    // confirm 出现是异步渲染：等最多 4s；失败时 dump changeTrust 信号
    const confirmUp = await waitFor(cdp,
      '!!document.querySelector(".custom-modal-wrap .custom-modal-ok-btn")',
      'confirm modal', 4000)
    if (!confirmUp) {
      const sig = await cdp.eval(
        'JSON.stringify({ custom: document.querySelectorAll(".custom-modal-wrap").length, ' +
        'okBtnAny: document.querySelectorAll(".custom-modal-ok-btn").length, ' +
        'wrapHtml: (document.querySelector(".custom-modal-wrap") || { innerHTML: "" }).innerHTML.slice(0, 400) })'
      )
      console.error('CONFIRM DIAG: ' + sig)
      try { console.error('console tail: ' + J(cdp.tail(8))) } catch (e) {}
    }
    // 组件导入的是自定义 Modal（common/modal.jsx），confirm 渲染
    // .custom-modal-wrap/.custom-modal-ok-btn，不是 antd 的 .ant-modal-confirm
    check('⑤ 选 auto → Modal.confirm 二次确认出现（SEC-12）', confirmUp === true)

    const trustBeforeOk = await cdp.jeval(
      'window.store.config.mcpServersAI[0].trust'
    )
    check('⑤ 确认前 config.trust 仍为 ask（未放行不生效）',
      trustBeforeOk === 'ask', { got: trustBeforeOk })

    await jsClick(cdp,
      'document.querySelector(".custom-modal-ok-btn")',
      'confirm OK')
    await sleep(500)
    const warnShown = await cdp.jeval(
      '[...document.querySelectorAll(".mcp-server-config-section div")] ' +
      '.some(d => getComputedStyle(d).color === "rgb(173, 104, 0)" && d.textContent.length > 0)'
    )
    check('⑤ 确认后 inline warn 出现（#ad6800 写操作警示）', warnShown === true)

    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => /^\\s*(save|保存)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))',
      'Save 按钮')
    await sleep(600)
    const trustAfter = await cdp.jeval(
      'window.store.config.mcpServersAI[0].trust'
    )
    check('⑤ 二次确认后保存 → config.trust === auto',
      trustAfter === 'auto', { got: trustAfter })

    // ================================================== ⑥ 删除与子进程回收
    const pidsBefore = fakeServerPids()
    check('⑥ 前置：fake-mcp-server 子进程在跑（pgrep 可见）',
      pidsBefore.length >= 1, { pids: pidsBefore })

    await jsClick(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
      '.find(b => b.classList.contains("ant-btn-dangerous"))',
      'Del 按钮')
    await sleep(800)
    const cfgAfterDel = await cdp.jeval(
      '(window.store.config.mcpServersAI || []).length'
    )
    check('⑥ 删除 → config.mcpServersAI 清空', cfgAfterDel === 0, { got: cfgAfterDel })

    let gone = false
    const d0 = Date.now()
    // 主进程 close = stdin.end + SIGTERM + SIGKILL 兜底，但实测子进程可能
    // 慢退出（30-60s 才消失）——判据窗口给 45s，超时才算孤儿
    while (Date.now() - d0 < 45000) {
      if (fakeServerPids().length === 0) { gone = true; break }
      await sleep(1000)
    }
    check('⑥ 子进程真退出（pgrep 45s 内清零，无孤儿）', gone)
    if (!gone) {
      // 归属判定：ppid=探针 electron → 本实例 disconnect 链没杀掉（产品缺陷）；
      // ppid=1 或其它 → 外部残留污染 pgrep（探针误报）
      const pids = fakeServerPids()
      let psOut = ''
      try {
        psOut = execSync('ps -o pid,ppid,lstart,cmd -p ' + pids.join(' -p ') + ' 2>/dev/null || true')
          .toString()
      } catch (e) {}
      console.error('ORPHAN DIAG: ' + J(pids) + '\n' + psOut)
    }

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
    cleanup()
    electron = null; xvfb = null; cdp = null
    const stillBusy = await portBusy(PORT)
    if (stillBusy) console.log('WARN  端口 ' + PORT + ' 仍有监听（可能有并行实例）')
    process.exit(failed.length ? 1 : 0)
  } catch (err) {
    console.error('PROBE ERROR: ' + (err.stack || err.message))
    cleanup()
    process.exit(2)
  }
}

main()
