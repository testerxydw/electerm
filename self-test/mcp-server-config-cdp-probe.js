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
 *   ⑦ §4.3 #5 HTTP 鉴权：http server 指向本地假端点（恒 401）→ 状态 failed 且
 *      lastError 含 HTTP 401 → 6s 窗口内请求 ≤ 2（4xx 不重试刷屏）→ DOM 徽章
 *      显示失败 → 重试按钮可用（点一次仍收敛，请求增量 ≤ 3）。
 *   ⑧ §4.3 #3 失败隔离：① `sleep 999` 的 stdio server initialize 永不回包 →
 *      INIT_TIMEOUT 内 failed，期间弹层仍可操作；② `--hang` server 已 ready，
 *      调工具在 timeoutMs+5s 内 settle 成 mcp_timeout，连接不被拆掉（agent
 *      循环拿到结构化错误继续走，不 hang）。
 *   ⑨ §4.3 #6 回归基线：清空 server 列表 → 外部工具集为空 / 状态空 / 无 warnings，
 *      内置工具基线仍 36（M10 硬门的源码常量），分节提示区不受影响。
 *   ⑩ id 稳定（本轮实机抓到的第三个真缺陷）：渲染层必须在保存时就分配 id。
 *      主进程只在 id 缺失时 nanoid(7) 生成且**不回写** config，所以缺 id 会
 *      每次 syncConfig 重建子进程（别名漂移）+ 徽章按 id 匹配不上。判据用
 *      「连续两次 GetTools 后子进程 pid 集合不变」+「状态 id === config id」+
 *      「DOM 徽章真的渲染出 ready(3)」三面钉死。
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
const http = require('node:http')
const { spawn, execSync } = require('node:child_process')
const {
  Cdp, getJson, findPageTarget, sleep, waitFor, makeChecker
} = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const PORT = '9396'
const HTTP_PORT = '9397'
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

// 假 HTTP MCP 端点：恒 401（§4.3 #5 的「错误 token」）。
// hits 是「不重试刷屏」判据的唯一证据——4xx 鉴权失败必须一次收敛，退避重连
// 只允许发生在传输/网络类失败上（设计 §2.7 重试表）。
function startFakeHttp401 (port) {
  const stat = { hits: 0, server: null }
  stat.server = http.createServer((req, res) => {
    stat.hits += 1
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } }))
  })
  return new Promise((resolve, reject) => {
    stat.server.once('error', reject)
    stat.server.listen(Number(port), '127.0.0.1', () => resolve(stat))
  })
}

const stopFakeHttp = stat => {
  if (!stat || !stat.server) return
  try { stat.server.close() } catch (e) {}
  try { stat.server.unref() } catch (e) {}
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

// 表单/按钮选择器只写一份：⑦⑧⑨ 复用 ②③ 的同一套定位，避免各块各自漂移
const SAVE_BTN = '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
  '.find(b => /^\\s*(save|保存)\\s*$/i.test(String(b.innerText || "").replace(/\\s+/g, "")))'
const NEW_BTN = '[...document.querySelectorAll(".mcp-server-config-section button")] ' +
  '.filter(b => b.innerText && !/refresh/i.test(b.innerText) && ' +
  '!b.closest(".mcp-fixed-hints") && b.closest(".mcp-server-config-section > div"))[0]'
const NAME_INPUT = 'document.querySelector(".mcp-server-config-section input[placeholder=\\"fs\\"]")'
const URL_INPUT = 'document.querySelector(".mcp-server-config-section input[placeholder^=\\"http://\\"]")'

// 真实点开 rc-select 并选中一项（下拉 portal 有隐藏实例，必须排除 hidden）
async function pickSelectOption (cdp, selectExpr, optionTitle, desc) {
  const optExpr = 'document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden) ' +
    '.ant-select-item-option[title=\\"' + optionTitle + '\\"]")'
  await clickEl(cdp, selectExpr, desc + ' select')
  let up = await waitFor(cdp, '!!' + optExpr, desc + ' option', 4000)
  if (!up) {
    await clickEl(cdp,
      '(' + selectExpr + ').querySelector(".ant-select-selector") || (' + selectExpr + ')',
      desc + ' selector 兜底')
    up = await waitFor(cdp, '!!' + optExpr, desc + ' option retry', 4000)
  }
  if (!up) throw new Error('下拉没打开: ' + desc)
  await clickEl(cdp, optExpr, desc + ' option')
  await sleep(300)
}

// antd InputNumber 的真实输入：native setter 对它无效（受控 + 内部格式化会在
// onBlur 回写），只能聚焦后全选再 Input.insertText，最后 blur 收敛。
async function setNumberValue (cdp, findExpr, value, desc) {
  const focused = await cdp.eval(`(() => { const el = (${findExpr}); if (!el) return false; el.focus(); el.setSelectionRange(0, String(el.value).length); return true })()`)
  if (!focused) throw new Error('数字输入框不存在: ' + desc)
  await cdp.call('Input.insertText', { text: String(value) })
  await sleep(150)
  await cdp.eval(`(() => { const el = (${findExpr}); if (!el) return false; el.blur(); return true })()`)
  await sleep(200)
}

// 走真实表单新增一条 server（New → 填字段 → Save）。http 的 headers 表单没有
// 字段，401 用例不需要它（错误 token 由服务端恒 401 表达）。
async function addServerViaUI (cdp, spec) {
  await jsClick(cdp, NEW_BTN, 'New 按钮')
  await waitFor(cdp, '!!' + NAME_INPUT, 'draft form', 8000)
  await setReactValue(cdp, NAME_INPUT, spec.name, 'name')
  // timeoutMs 必须显式写：表单默认 60000，§4.3 #3 的判据窗口是 timeoutMs+5s，
  // 用默认值会让「超时收敛」变成一分钟级等待，判据失去意义。
  // antd InputNumber 不认 native value setter（实测：注入后仍落盘 60000），
  // 必须走真实键盘输入——聚焦 + 全选 + insertText + blur 触发 onChange/onBlur。
  if (spec.timeoutMs) {
    await setNumberValue(cdp,
      'document.querySelector(".mcp-server-config-section .ant-input-number-input")',
      spec.timeoutMs, 'timeoutMs')
  }
  if (spec.transport === 'http') {
    // 草稿展开时 section 内恰 2 个 antd-select：文档序 [0]=transport、[1]=trust
    await pickSelectOption(cdp,
      '[...document.querySelectorAll(".mcp-server-config-section .ant-select")][0]',
      'http', 'transport')
    await waitFor(cdp, '!!' + URL_INPUT, 'url input', 5000)
    await setReactValue(cdp, URL_INPUT, spec.url, 'url')
  } else {
    await setReactValue(cdp,
      'document.querySelector(".mcp-server-config-section input[placeholder=\\"npx\\"]")',
      spec.command, 'command')
    await setReactValue(cdp,
      'document.querySelector(".mcp-server-config-section textarea")',
      (spec.args || []).join('\n'), 'args')
  }
  await jsClick(cdp, SAVE_BTN, 'Save 按钮')
  await sleep(900)
}

// ---------------------------------------------------------------- 主流程
async function main () {
  const { check, results } = makeChecker()
  let homeDir = null
  let tmpDir = null
  let xvfb = null
  let electron = null
  let cdp = null
  let httpStat = null

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
    stopFakeHttp(httpStat)
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

    // ---------------------------------------------- ③b id 稳定 + 徽章真渲染
    // 主进程 config-validate 只在 id 缺失时才 nanoid(7) 生成，且**从不回写**
    // config。渲染层若不给 id：① 每次 syncConfig 都按新 id 找不到旧 session →
    // 杀子进程重新 spawn（连接签名其实没变，别名却随 id 漂移）；② 徽章用
    // states.find(s => s.id === server.id) 匹配，渲染层 id 恒 '' → DOM 徽章
    // 永远不出现（store 状态却一直是 ready，只看 store 的断言会假绿）。
    const idSaved = await cdp.jeval(
      'String((window.store.config.mcpServersAI[0] || {}).id || "")'
    )
    check('③ config.mcpServersAI[0].id 由渲染层分配（缺 id 会让主进程每次重生成）',
      /^[A-Za-z0-9_-]{3,32}$/.test(idSaved), { got: idSaved })

    const pidsA = fakeServerPids().sort()
    await cdp.eval('(async () => { ' +
      'await window.store.mcpClientGetTools(); ' +
      'await window.store.mcpClientGetTools(); return true })()')
    await sleep(1500)
    const pidsB = fakeServerPids().sort()
    check('③ 连续两次 GetTools 不重建子进程（pid 集合不变 → 签名稳定）',
      pidsA.length > 0 && pidsA.join(',') === pidsB.join(','),
      { before: pidsA, after: pidsB })

    const stateIds = await cdp.jeval(
      '(window.store.mcpClientState() || []).map(s => s.id)'
    )
    check('③ 状态快照 id 与 config id 一致（徽章匹配前提）',
      Array.isArray(stateIds) && stateIds.length === 1 && stateIds[0] === idSaved,
      { configId: idSaved, stateIds })

    const badgeText = await cdp.jeval(
      '[...document.querySelectorAll(".mcp-server-config-section .mcp-status")]' +
      '.map(n => String(n.textContent || ""))'
    )
    check('③ DOM 状态徽章渲染 ready(3)（按 id 匹配到真实状态，非只看 store）',
      Array.isArray(badgeText) &&
      badgeText.some(t => /(ready|就绪)/i.test(t) && /\(3\)/.test(t)),
      { got: badgeText })

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

    // ============================================ ⑦ §4.3 #5 HTTP 鉴权失败
    // 判据原文：新增 http server（url + 错误 token）→ 401 →「鉴权失败」，不重试
    // 刷屏；徽章「失败」+ 重试按钮可用。三面都要证：结构化状态、请求次数、DOM。
    // 表单没有 headers 字段，错误 token 由「本地端点恒 401」表达（token 是否
    // 真的发出去由 http-transport 的单元 spec 钉）。
    httpStat = await startFakeHttp401(HTTP_PORT)
    await addServerViaUI(cdp, {
      name: 'probe-http',
      transport: 'http',
      url: 'http://127.0.0.1:' + HTTP_PORT + '/mcp',
      timeoutMs: 5000
    })
    const httpCfgTimeout = await cdp.jeval(
      '(window.store.config.mcpServersAI.find(s => s.name === "probe-http") || {}).timeoutMs')
    check('⑦ 表单 timeoutMs 真实落盘 = 5000（§4.3 #3 判据窗口的前提）',
      httpCfgTimeout === 5000, { got: httpCfgTimeout })

    const httpFailed = await waitFor(cdp,
      '(() => { ' +
      'const s = (window.store.mcpClientState() || []).find(x => x && x.name === "probe-http"); ' +
      'return !!(s && s.state === "failed" && /HTTP 401/.test(s.lastError || "")); ' +
      '})()', 'http 401 failed', 25000)
    check('⑦ HTTP 401 → 状态 failed 且 lastError 指名 HTTP 401（鉴权失败可读）',
      httpFailed === true)
    if (!httpFailed) {
      console.error('HTTP DIAG: hits=' + httpStat.hits + ' state=' + await cdp.eval(
        'JSON.stringify((window.store.mcpClientState() || []).find(s => s && s.name === "probe-http") || null)'
      ))
    }

    // 4xx 鉴权失败不得进退避重连（设计 §2.7：只允许传输/网络类失败重试）。
    // 6s 窗口足够跑完 1s/2s 两级退避——真重试的话 hits 会涨到 3 以上。
    await sleep(6000)
    const httpHits = httpStat.hits
    check('⑦ 鉴权失败不重试刷屏（6s 窗口内请求 ≤ 2）',
      httpHits >= 1 && httpHits <= 2, { hits: httpHits })

    const httpDom = await cdp.jeval(
      '(() => { const sec = document.querySelector(".mcp-server-config-section"); ' +
      'if (!sec) return null; ' +
      'const st = [...sec.querySelectorAll(".mcp-status")].map(n => String(n.textContent || "")); ' +
      'return { status: st, retry: sec.querySelectorAll(".mcp-retry-btn").length } })()'
    )
    check('⑦ DOM 徽章显示「失败：<lastError>」（设计 §2.9 映射）',
      !!httpDom && httpDom.status.some(t => /(failed|失败)/i.test(t) && /401/.test(t)),
      { got: httpDom && httpDom.status })
    check('⑦ 失败行渲染重试按钮（设计 §2.9「+ 重试按钮」）',
      !!httpDom && httpDom.retry >= 1, { got: httpDom && httpDom.retry })

    // 重试按钮真的可用：点一次 → 仍收敛为 failed（不是无限重连），且请求增量可控。
    // 增量允许 3：restart 自身一次 initialize + 紧随的 GetTools(force) 再对齐一次。
    const hitsBeforeRetry = httpStat.hits
    if (httpDom && httpDom.retry >= 1) {
      await jsClick(cdp, 'document.querySelector(".mcp-retry-btn")', '重试按钮')
    }
    await sleep(9000)
    const retryStillFailed = await waitFor(cdp,
      '(() => { ' +
      'const s = (window.store.mcpClientState() || []).find(x => x && x.name === "probe-http"); ' +
      'return !!(s && s.state === "failed"); ' +
      '})()', 'retry still failed', 8000)
    const retryDelta = httpStat.hits - hitsBeforeRetry
    check('⑦ 重试按钮可用：单次重试仍收敛为 failed，请求增量 ≤ 3（无循环重连）',
      retryStillFailed === true && retryDelta >= 1 && retryDelta <= 3,
      { delta: retryDelta, total: httpStat.hits })
    stopFakeHttp(httpStat)
    httpStat = null

    // ============================================ ⑧ §4.3 #3 失败隔离
    // (a) initialize 永不回包：`sleep 999` 的 stdio server。失败必须收敛在
    // INIT_TIMEOUT（session.js:22 = 10s）内，且弹层仍可操作。
    await addServerViaUI(cdp, {
      name: 'probe-sleep',
      transport: 'stdio',
      command: 'sleep',
      args: ['999'],
      timeoutMs: 5000
    })
    const sleepT0 = Date.now()
    const sleepFailed = await waitFor(cdp,
      '(() => { ' +
      'const s = (window.store.mcpClientState() || []).find(x => x && x.name === "probe-sleep"); ' +
      'return !!(s && s.state === "failed" && /timed? ?out|timeout|超时/i.test(s.lastError || "")); ' +
      '})()', 'sleep init timeout', 25000)
    const sleepMs = Date.now() - sleepT0
    check('⑧ initialize 永不回包 → failed 且 lastError 为超时（不无限挂起）',
      sleepFailed === true, { ms: sleepMs })
    if (!sleepFailed) {
      console.error('SLEEP DIAG: ' + await cdp.eval(
        'JSON.stringify((window.store.mcpClientState() || []).find(s => s && s.name === "probe-sleep") || null)'
      ))
    }

    const panelAliveRaw = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientGetTools(); ' +
      'const refresh = [...document.querySelectorAll(".mcp-server-config-section button")]' +
      '.find(b => /refresh/i.test(b.innerText || "")); ' +
      'return JSON.stringify({ servers: (r.servers || []).length, refresh: !!refresh }); })()')
    let panelAlive = {}
    try { panelAlive = JSON.parse(panelAliveRaw) } catch (e) { panelAlive = {} }
    check('⑧ 失败隔离期间弹层仍可操作（GetTools 正常返回 + Refresh 在）',
      panelAlive.servers === 2 && panelAlive.refresh === true, { got: panelAlive })

    // (b) tools/call 挂死：--hang 的 server 已 ready，调用必须 settle 成
    // mcp_timeout（≤ timeoutMs+5s，5s 是渲染层看门狗 padding），连接不拆。
    await addServerViaUI(cdp, {
      name: 'probe-hang',
      transport: 'stdio',
      command: 'node',
      args: [FAKE_SERVER, '--stdio', '--hang', '--tools=1'],
      timeoutMs: 5000
    })
    const hangReady = await waitFor(cdp,
      '(() => { ' +
      'const s = (window.store.mcpClientState() || []).find(x => x && x.name === "probe-hang"); ' +
      'return !!(s && s.state === "ready"); ' +
      '})()', 'hang server ready', 25000)
    const hangAlias = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientGetTools(); ' +
      'const s = (r.servers || []).find(x => x && x.name === "probe-hang"); ' +
      'const t = (r.tools || []).filter(x => x && x.function && ' +
      'String(x.function.name).indexOf(String(s && s.id)) === 5); ' +
      'return t.length ? String(t[0].function.name) : ""; })()')
    check('⑧ --hang server 先 ready 且注册了外部工具（拿到别名用于调用）',
      hangReady === true && /^mcp__/.test(String(hangAlias)), { alias: hangAlias })

    const callT0 = Date.now()
    const callRaw = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientCallTool(' + J(String(hangAlias)) + ', { text: "x" }, { timeoutMs: 5000 }); ' +
      'return JSON.stringify(r); })()')
    const callMs = Date.now() - callT0
    let callRes = {}
    try { callRes = JSON.parse(callRaw) } catch (e) { callRes = {} }
    const callCode = callRes && callRes.error && callRes.error.code
    check('⑧ tools/call 挂死 → timeoutMs+5s 内 settle 成 mcp_timeout（agent 循环不 hang）',
      callCode === 'mcp_timeout' && callMs <= 5000 + 5000 + 2000,
      { code: callCode, ms: callMs })

    // 超时只把会话降级（session.js:238-244：consecutiveFailures++ →
    // ready→degraded，第 2 次才 failed），**不得拆连接**。判据用「再拉一次
    // GetTools 仍能看到该 server 且工具表仍在」表达，而不是看缓存快照——
    // 缓存（mcpServerStates）只在 GetTools 结果里更新，直接读它证不了现状。
    const afterRaw = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientGetTools(); ' +
      'const s = (r.servers || []).find(x => x && x.name === "probe-hang") || null; ' +
      'return JSON.stringify({ state: s ? s.state : "gone", ' +
      'lastError: s ? String(s.lastError || "").slice(0, 80) : "", ' +
      'tools: (r.tools || []).length }); })()')
    let afterCall = {}
    try { afterCall = JSON.parse(afterRaw) } catch (e) { afterCall = {} }
    check('⑧ 调用超时未拆连接（仍 degraded/ready 且工具表还在，面板可继续用）',
      ['ready', 'degraded'].includes(afterCall.state) && afterCall.tools >= 1,
      { got: afterCall })

    // ============================================ ⑨ §4.3 #6 回归基线
    // 清空走真实 UI（逐行 Del），而不是直接改 config——判据要求「清空 server
    // 列表」这条用户路径本身可用。
    let delRounds = 0
    while (delRounds < 6) {
      const left = await cdp.jeval(
        '[...document.querySelectorAll(".mcp-server-config-section button")]' +
        '.filter(b => b.classList.contains("ant-btn-dangerous")).length'
      )
      if (!left) break
      await jsClick(cdp,
        '[...document.querySelectorAll(".mcp-server-config-section button")]' +
        '.find(b => b.classList.contains("ant-btn-dangerous"))',
        'Del 按钮 #' + (delRounds + 1))
      await sleep(900)
      delRounds += 1
    }
    const cfgCleared = await cdp.jeval('(window.store.config.mcpServersAI || []).length')
    check('⑨ 逐行删除清空列表（UI 路径，不靠改 config）',
      cfgCleared === 0, { got: cfgCleared, rounds: delRounds })

    const clearedRaw = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientGetTools(); ' +
      'return JSON.stringify({ tools: (r.tools || []).length, servers: (r.servers || []).length, ' +
      'warnings: (r.warnings || []).length }); })()')
    let cleared = {}
    try { cleared = JSON.parse(clearedRaw) } catch (e) { cleared = {} }
    check('⑨ 清空列表 → 外部工具集为空 / 无状态 / 无 warning（内置路径回基线）',
      cleared.tools === 0 && cleared.servers === 0 && cleared.warnings === 0,
      { got: cleared })

    // 内置 36 是 M10 硬门：源码常量口径（agentTools 里 type: 'function' 计数），
    // 与 mcp-builtin-tool-baseline.spec.js 同一事实源，探针只做端到端复核。
    const builtinSrc = fs.readFileSync(
      path.join(ROOT, 'src/client/components/ai/agent-tools.js'), 'utf8')
    const builtinCount = (builtinSrc.match(/type: 'function'/g) || []).length
    const builtinNames = [...builtinSrc.matchAll(/name: '([a-z0-9_]+)'/g)].map(m => m[1])
    const collideRaw = await cdp.eval('(async () => { ' +
      'const r = await window.store.mcpClientGetTools({ builtinToolNames: ' +
      J(builtinNames) + ' }); ' +
      'return JSON.stringify({ tools: (r.tools || []).length, warnings: (r.warnings || []).length }); })()')
    let collide = {}
    try { collide = JSON.parse(collideRaw) } catch (e) { collide = {} }
    check('⑨ 内置工具基线 = 36 且无外部工具时 tools 仍为 0（撞名跳过不误报）',
      builtinCount === 36 && builtinNames.length === 36 &&
      collide.tools === 0 && collide.warnings === 0,
      { builtinCount, names: builtinNames.length, got: collide })
    console.log('NOTE  system prompt 的 §3.3 基线比对属 golden 快照，' +
      '由 mcp-builtin-tool-baseline.spec.js 覆盖（探针不复刻快照）')

    const rowsAfterClear = await cdp.jeval(
      'document.querySelectorAll(".mcp-server-config-section .mcp-status").length'
    )
    const hintsAfterClear = await cdp.jeval(
      'document.querySelectorAll(".mcp-server-config-section .mcp-fixed-hints > div").length'
    )
    check('⑨ 清空后分节仍正常（无状态行、固定提示仍 3 句）',
      rowsAfterClear === 0 && hintsAfterClear === 3,
      { rows: rowsAfterClear, hints: hintsAfterClear })

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
