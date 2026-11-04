#!/usr/bin/env node
/**
 * G2 录制回放 —— CDP 实机演示/回归（真实本地 shell + 真实主进程文件读取）
 *
 * 单测钉住的是解析与契约（cast-parser / session-recordings / cast-player / recording-list），
 * 这里验"接到一起之后"的设计 §14.3 验收：
 *   1) 列表列出磁盘上的录制：大小/时长/首条命令/修改时间都来自真实读取
 *   2) 1x 走时误差 <1s（虚拟时钟跟真实时间对得上）
 *   3) 4x 不丢事件：跑完后"已写事件数"= 文件里的 o 事件数
 *   4) header 损坏 → 给"不是有效录制"的提示，不是白屏
 *   5) 空录制可打开（提示"没有内容"，播放键禁用）
 *   6) 删除：二次确认后真的从磁盘消失、列表也少一行
 *   7) 换浅色主题后列表配色跟着 token 走
 *
 * 假录制写在实例算出来的日志目录里（listRecordings 返回的 dir），
 * 跑完自己删干净——不依赖"下次再跑时目录是空的"。
 *
 * 用法：
 *   1) npm run vite-build && rsync -a src/app/lib/ work/app/lib/ && rsync -a src/app/common/ work/app/common/
 *   2) 起带 --remote-debugging-port=9227 的实例（见 git log 里的启动命令）
 *   3) node self-test/cast-player-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'cast-player-shots')

const N60 = 'electerm-rec-cast-demo-60s.cast'
const NEMPTY = 'electerm-rec-cast-demo-empty.cast'
const NBAD = 'electerm-rec-cast-demo-bad.cast'
const NDEL = 'electerm-rec-cast-demo-del.cast'
const FILES = [N60, NEMPTY, NBAD, NDEL]

// 60s、0.1s 一条输出（601 条 o）+ 2 条输入：1x 可比对，4x 跑完约 15s
const OUT_N = 601
const OUT_TOTAL = OUT_N
const IN_EVENTS = 2

const header = (w = 80, h = 24, ts = 1730000000) =>
  JSON.stringify({ version: 2, width: w, height: h, timestamp: ts })

const build60 = () => {
  const lines = [header()]
  for (let i = 0; i < OUT_N; i++) {
    lines.push(JSON.stringify([i * 0.1, 'o', 'out-' + i + '\r\n']))
    if (i === 50) {
      lines.push(JSON.stringify([i * 0.1, 'i', 'ls -al\r']))
    }
    if (i === 200) {
      lines.push(JSON.stringify([i * 0.1, 'i', 'echo hello\r']))
    }
  }
  return lines.join('\n') + '\n'
}

const buildEmpty = () => header() + '\n'
const buildBad = () => '{"version":2,"width":0,"height":24}\n' + JSON.stringify([0.1, 'o', 'x']) + '\n'
const buildDel = () => header(80, 24, 1730000001) + '\n' + JSON.stringify([0.5, 'o', 'bye\r\n']) + '\n'

const PROBE = `
(() => {
  // runGlobalAsync 是 Promise：CDP 的 evaluate 不等 Promise，结果先落 window 再取
  window.__ask = (name, arg) => {
    window.__res = null
    window.pre.runGlobalAsync(name, arg).then(
      r => { window.__res = r },
      e => { window.__res = { error: String((e && e.message) || e) } }
    )
    return 'asked:' + name
  }
  window.__resGet = () => JSON.stringify(window.__res === undefined ? null : window.__res)
  // 录制相关的 IPC 调用留个尾痕：删除没生效时分得清"没点到确认"还是"点了但主进程拒了"
  if (!window.__recWrapped) {
    window.__recWrapped = true
    window.__calls = []
    const raw = window.pre.runGlobalAsync.bind(window.pre)
    window.pre.runGlobalAsync = function (name, ...a) {
      if (/Recording/.test(String(name))) {
        const rec = { name: String(name), arg: JSON.stringify(a[0] === undefined ? null : a[0]) }
        window.__calls.push(rec)
        return raw(name, ...a).then(
          r => { rec.done = true; return r },
          e => { rec.error = String((e && e.message) || e); throw e }
        )
      }
      return raw(name, ...a)
    }
  }
  window.__callsTail = () => JSON.stringify((window.__calls || []).slice(-4))
  window.__toasts = () => JSON.stringify(
    [...document.querySelectorAll('.message-item, .ant-message-notice-content')]
      .map(el => (el.innerText || '').trim()).filter(Boolean)
  )
  // 进度条把手 + 轨道左端（往回拖要按住把手拖到轨道起点，点轨道只会跳到点到的位置；
  // 松手点必须还落在弹层面板内，否则等于点了遮罩 = 关掉播放器）
  window.__sliderGeom = () => {
    const track = document.querySelector('.cast-player .ant-slider')
    const handle = document.querySelector('.cast-player .ant-slider-handle')
    if (!track || !handle) return JSON.stringify({ error: 'no-slider' })
    const t = track.getBoundingClientRect()
    const h = handle.getBoundingClientRect()
    return JSON.stringify({
      hx: Math.round(h.left + h.width / 2),
      hy: Math.round(h.top + h.height / 2),
      left: Math.round(t.left)
    })
  }
  window.__dumpModals = () => JSON.stringify(
    [...document.querySelectorAll('.ant-modal-wrap')].map(el => {
      const c = el.querySelector('.ant-modal-content')
      const r = c && c.getBoundingClientRect()
      return {
        disp: getComputedStyle(el).display,
        title: ((el.querySelector('.ant-modal-title') || {}).innerText || '').trim().slice(0, 40),
        cast: !!el.querySelector('.cast-player'),
        list: !!el.querySelector('.rec-list'),
        panel: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null
      }
    })
  )
  // 确认气泡：只认 popconfirm（页面上可能有别的浮层），并带回文字便于判因
  window.__popOk = () => {
    const p = [...document.querySelectorAll('.ant-popconfirm')].find(window.__vis)
    if (!p) return JSON.stringify({ error: 'no-popconfirm' })
    const b = [...p.querySelectorAll('button')].find(x => /删除|delete/i.test(window.__norm(x.innerText)))
    if (!b) return JSON.stringify({ error: 'no-ok-btn', text: (p.innerText || '').trim().slice(0, 60) })
    const r = b.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (p.innerText || '').trim().slice(0, 60) })
  }
  window.__errs = []
  window.addEventListener('error', ev => window.__errs.push(String(ev.message)))
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !!el && !window.__hidden(el)
  window.__visRoot = sel => [...document.querySelectorAll(sel)].find(el => window.__vis(el)) || null
  window.__norm = x => String(x == null ? '' : x).split(' ').join('')
  // 在给定根里按"归一化后的文字"找可见按钮（antd 两字按钮中间会插空格）
  window.__btn = (root, re) => {
    if (!root) return null
    const b = [...root.querySelectorAll('button')]
      .filter(x => window.__vis(x) && re.test(window.__norm(x.innerText)))
    return b.length ? b[0] : null
  }
  window.__xy = el => {
    if (!el) return JSON.stringify({ error: 'no-el' })
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return JSON.stringify({ error: 'zero-size' })
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__recRoot = () => window.__visRoot('.rec-list')
  window.__recRows = () => {
    const r = window.__recRoot()
    if (!r) return []
    return [...r.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map(tr => {
      const td = [...tr.querySelectorAll('td')]
      return {
        name: (td[0].innerText || '').trim(),
        invalid: !!td[0].querySelector('.rec-invalid-tag'),
        size: (td[1].innerText || '').trim(),
        duration: (td[2].innerText || '').trim(),
        cmd: (td[3].innerText || '').trim(),
        mod: (td[4].innerText || '').trim()
      }
    })
  }
  window.__recRowXY = (file, which) => {
    const r = window.__recRoot()
    if (!r) return JSON.stringify({ error: 'no-list' })
    const tr = [...r.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
      .find(x => (x.innerText || '').indexOf(file) >= 0)
    if (!tr) return JSON.stringify({ error: 'no-row:' + file })
    const btns = [...tr.querySelectorAll('button')]
    if (!btns.length) return JSON.stringify({ error: 'no-btn' })
    const el = which === 'replay' ? btns[0] : which === 'reveal' ? btns[1] : btns[2]
    return window.__xy(el)
  }
  window.__recBtnXY = re => window.__xy(window.__btn(document.body, re))
  window.__castRoot = () => window.__visRoot('.cast-player')
  window.__castState = () => {
    const el = window.__castRoot()
    if (!el) return null
    const g = k => el.getAttribute(k)
    return {
      pos: Number(g('data-cast-pos')),
      written: Number(g('data-cast-written')),
      total: Number(g('data-cast-total')),
      playing: g('data-cast-playing'),
      speed: Number(g('data-cast-speed')),
      cmd: g('data-cast-cmd') || '',
      typed: (el.querySelector('[data-cast-typed]') || {}).textContent || '',
      meta: ((el.querySelector('.cast-player-meta') || {}).innerText || '').trim(),
      err: ((el.querySelector('.cast-player-error') || {}).innerText || '').trim(),
      lines: [...el.querySelectorAll('.cast-player-box .xterm-rows > div')].map(d => d.textContent)
    }
  }
  window.__castColor = sel => {
    const el = window.__castRoot()
    const n = el && el.querySelector(sel)
    return n ? getComputedStyle(n).color : null
  }
  return 'probes'
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  if (!fs.existsSync(SHOT_DIR)) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
  }
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
  cdp.tail(0)
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 950, deviceScaleFactor: 1, mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 120000)
  await sleep(1500)

  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }

  // 弹层带 rc-motion 动画：刚可见那一刻量到的是动画中间值，照它点会点到气泡外面
  // （等于点了外面 = 取消），所以坐标要连续两次一致才算数
  const stableEval = async (expr, tries = 12) => {
    let prev = null
    for (let i = 0; i < tries; i++) {
      const cur = await cdp.eval(expr)
      if (prev !== null && cur === prev && String(cur).indexOf('error') < 0) {
        return cur
      }
      prev = cur
      await sleep(200)
    }
    return prev
  }

  // 渲染层启动后还会自己再导航一次（持久化页签恢复），窗口对象会整体换掉：
  // 探针装早了等于装在旧窗口上，重试到真的落在这一个窗口为止
  let probed = false
  for (let i = 0; i < 20 && !probed; i++) {
    try {
      await cdp.eval(PROBE)
      probed = true
    } catch (e) {
      await sleep(500)
      await waitFor(cdp, '!!window.store && !!window.pre', 'renderer re-boots', 60000)
    }
  }
  check('渲染层就绪（探针已装上窗口）', probed)
  if (!probed) {
    throw new Error('probe not installed')
  }

  // 目录由主进程按配置算：自测不猜路径，问它要
  await cdp.eval('window.__ask(' + JSON.stringify('listRecordings') + ')')
  await waitFor(cdp, 'window.__res !== null', 'listRecordings answers', 15000)
  const listing = JSON.parse(await cdp.eval('window.__resGet()'))
  const dir = listing && listing.dir
  // 全新的档案目录里从没录过东西时 session_logs 还不存在 —— 主进程只在真正开录制时
  // 才 mkdir（ipc.js 的 createRecordFile）。铺假录制之前按产品同款方式把目录建出来，
  // 否则这条判据把"第一次跑"误判成"产品没给出目录"（2026-11-04 第四轮扫掠的红）。
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
  }
  check('主进程给出录制目录（渲染层不参与拼路径）', !!dir && fs.existsSync(dir), { dir })
  if (!dir) {
    throw new Error('no recording dir')
  }

  for (const [name, text] of [[N60, build60()], [NEMPTY, buildEmpty()], [NBAD, buildBad()], [NDEL, buildDel()]]) {
    fs.writeFileSync(path.join(dir, name), text)
  }
  check('假录制已落盘（4 个，60s 的 o 事件 ' + OUT_TOTAL + ' 条）',
    FILES.every(n => fs.existsSync(path.join(dir, n))))
  await sleep(300)

  // ── 1. 列表：真实入口 + 真实文件 ────────────────────────────────
  await cdp.eval('window.store.addTab()')
  await sleep(2500)
  const myTab = await cdp.eval('String(window.store.activeTabId)')
  await waitFor(cdp, "!!document.querySelector('.terminal-info-icon')", 'footer info icon', 20000)
  await cdp.eval('window.store.openInfoPanel()')
  await sleep(1200)
  const recBtn = await cdp.jeval('window.__recBtnXY(/录制文件|recordings?/i)')
  check('终端信息面板录制区有「录制文件」入口', !recBtn.error, recBtn)
  if (recBtn.error) {
    throw new Error('no entry button: ' + recBtn.error)
  }
  await cdp.click(recBtn.x, recBtn.y)
  await waitFor(cdp, '!!window.__recRoot()', 'recording list opens', 10000)
  // 根节点在打开那一下就有了，行数据要等 list+probe 两跳 IPC
  await waitFor(cdp, 'window.__recRows().length >= 4', 'list rows load', 15000)

  const rows = await cdp.jeval('JSON.stringify(window.__recRows())')
  const r60 = rows.find(r => r.name.indexOf(N60) >= 0)
  const rBad = rows.find(r => r.name.indexOf(NBAD) >= 0)
  check('列表列出磁盘上的 4 个假录制', [N60, NEMPTY, NBAD, NDEL].every(n => rows.some(r => r.name.indexOf(n) >= 0)),
    { count: rows.length })
  check('60s 录制的时长列读自文件（不是当前时间差）',
    !!r60 && /1\s*m\s*00\s*s/.test(r60.duration) && r60.cmd === 'ls -al', r60)
  check('60s 录制的大小列有值（真实字节数折算）', !!r60 && /Ki?B|B$/.test(r60.size), r60 && r60.size)
  check('header 损坏的行标了"无效"，其它列不挡（仍可删/可定位）',
    !!rBad && rBad.invalid === true, rBad)
  await shot('rec-list-dark')

  // ── 2. 回放 60s：1x 走时 ───────────────────────────────────────
  const xy60 = await cdp.jeval('window.__recRowXY(' + JSON.stringify(N60) + ', "replay")')
  check('60s 行有回放按钮', !xy60.error, xy60)
  await cdp.click(xy60.x, xy60.y)
  await waitFor(cdp, '!!window.__castRoot()', 'player opens', 10000)
  const s0 = await cdp.jeval('JSON.stringify(window.__castState())')
  check('回放器读到 header 尺寸与事件数（80×24、' + (OUT_TOTAL + IN_EVENTS) + ' 条）',
    s0.total === OUT_TOTAL + IN_EVENTS && /80×24/.test(s0.meta), s0 && { total: s0.total, meta: s0.meta })
  check('刚打开尚未写入（停在 0，画面是空的）', s0.pos === 0 && s0.written === 0, s0 && { pos: s0.pos, written: s0.written })

  const playXY = await cdp.jeval("window.__xy(window.__btn(document.querySelector('.cast-player'), /播放|play/i))")
  check('控制条有播放键', !playXY.error, playXY)
  const t0 = Date.now()
  await cdp.click(playXY.x, playXY.y)
  await sleep(6000)
  const s1 = await cdp.jeval('JSON.stringify(window.__castState())')
  const drift = Math.abs(s1.pos - (Date.now() - t0))
  check('1x 走时与真实经过时间误差 <1s', s1.playing === '1' && drift < 1000, { drift, pos: s1.pos })
  check('1x 期间画面确实在写（xterm 行里有 out-* 文本）',
    s1.written > 30 && s1.lines.join('\n').indexOf('out-') >= 0, { written: s1.written })
  check('输入事件不上屏，改画底部命令徽标（ls -al 出现过）',
    s1.cmd === 'echo hello' || s1.cmd === 'ls -al', s1.cmd)
  await shot('player-1x')

  const pauseXY = await cdp.jeval("window.__xy(window.__btn(document.querySelector('.cast-player'), /暂停|pause/i))")
  await cdp.click(pauseXY.x, pauseXY.y)
  await sleep(300)
  check('暂停即时钟停住', (await cdp.eval('window.__castState().playing')) === '0')

  // ── 3. 4x 不丢事件 ─────────────────────────────────────────────
  const xy4 = await cdp.jeval("window.__xy(window.__btn(document.querySelector('.cast-player'), /^4x$/))")
  check('倍速档可点（4x）', !xy4.error, xy4)
  await cdp.click(xy4.x, xy4.y)
  // 归零用"按住把手往轨道左端外拖"：点轨道只会跳到点到的位置，Home 键在 CDP 下不生效
  const g = await cdp.jeval('window.__sliderGeom()')
  check('进度条有把手', !g.error, g)
  await cdp.dragX(g.hx, g.hy, g.left - g.hx, 8)
  await sleep(400)
  const sBack = await cdp.jeval('JSON.stringify(window.__castState())')
  // 松手像素有 ±1 误差、把手又按 step=10ms 吸附，所以"回到起点"判的是"到不了第二个事件（100ms）"
  check('回到起点后画面重放（已写数从 0 重新计）',
    sBack.pos <= 30 && sBack.written <= 1, sBack && { pos: sBack.pos, written: sBack.written })
  const playXY2 = await cdp.jeval("window.__xy(window.__btn(document.querySelector('.cast-player'), /播放|play/i))")
  check('回零后播放键仍可用', !playXY2.error, playXY2)
  await cdp.click(playXY2.x, playXY2.y)
  await sleep(600)
  const playing = await cdp.eval('window.__castState() ? window.__castState().playing : "gone"')
  check('4x 起播且弹层还在（点把手没把弹层点没）', playing === '1',
    { playing, modals: await cdp.eval('window.__dumpModals()') })
  const done = await waitFor(cdp,
    "window.__castRoot() === null || (window.__castState() && window.__castState().playing === '0')", '4x playback finishes', 40000)
  const endRaw = String(await cdp.eval('window.__castState() ? JSON.stringify(window.__castState()) : "null"'))
  if (endRaw === 'null') {
    console.log('  播放器弹层在 4x 期间消失了：' + await cdp.eval('window.__dumpModals()'))
  }
  const sEnd = endRaw === 'null' ? {} : JSON.parse(endRaw)
  check('4x 跑完不丢事件：已写 o 事件数 = 文件里的 ' + OUT_TOTAL + ' 条',
    done && sEnd.written === OUT_TOTAL, { written: sEnd.written, pos: sEnd.pos, total: sEnd.total })
  check('跑完停在末尾（位置=总时长）', sEnd.pos >= 60000 - 10, sEnd.pos)
  await shot('player-4x-end')

  // ── 4. header 损坏：提示而非白屏 ───────────────────────────────
  await cdp.eval("window.__closeCast = () => { const m = window.__visRoot('.cast-player-modal'); const b = m && m.querySelector('.ant-modal-close'); b && b.click(); return b ? 'ok' : 'missing' }")
  await cdp.eval('window.__closeCast()')
  await waitFor(cdp, '!window.__castRoot()', 'player closes', 8000)
  const xyBad = await cdp.jeval('window.__recRowXY(' + JSON.stringify(NBAD) + ', "replay")')
  await cdp.click(xyBad.x, xyBad.y)
  await waitFor(cdp, '!!window.__castRoot()', 'bad file player opens', 8000)
  const sBad = await cdp.jeval('JSON.stringify(window.__castState())')
  check('header 损坏给可读提示而不是白屏',
    !!sBad.err && /不是有效|not.*valid|asciinema/i.test(sBad.err), sBad && sBad.err)
  await shot('player-bad-header')
  await cdp.eval('window.__closeCast()')
  await waitFor(cdp, '!window.__castRoot()', 'bad player closes', 8000)

  // ── 5. 空录制可打开 ────────────────────────────────────────────
  const xyEmpty = await cdp.jeval('window.__recRowXY(' + JSON.stringify(NEMPTY) + ', "replay")')
  await cdp.click(xyEmpty.x, xyEmpty.y)
  await waitFor(cdp, '!!window.__castRoot()', 'empty file player opens', 8000)
  // 终端是异步建的（loadTerminal），空录制唯一可见的东西就是那行提示，等它上屏再判
  const hinted = await waitFor(cdp,
    "!!window.__castRoot() && window.__castState().total === 0 && window.__castState().lines.join('\\n').trim().length > 0",
    'empty hint painted', 15000)
  const sEmpty = await cdp.jeval('JSON.stringify(window.__castState())')
  check('空录制能打开、明确显示"没有内容"而不是黑屏',
    hinted && sEmpty.total === 0 && sEmpty.err === '' &&
    /录制内容为空|Empty recording/i.test(sEmpty.lines.join('\n')),
    { hinted, total: sEmpty.total, screen: sEmpty.lines.join('\n').trim().slice(0, 40) })
  await shot('player-empty')
  await cdp.eval('window.__closeCast()')
  await waitFor(cdp, '!window.__castRoot()', 'empty player closes', 8000)

  // ── 6. 删除：确认后真的从磁盘消失 ──────────────────────────────
  const rowsBefore = (await cdp.jeval('JSON.stringify(window.__recRows())')).length
  const xyDel = await cdp.jeval('window.__recRowXY(' + JSON.stringify(NDEL) + ', "del")')
  check('删除按钮在操作列第三个', !xyDel.error, xyDel)
  await cdp.click(xyDel.x, xyDel.y)
  await waitFor(cdp, "!!window.__visRoot('.ant-popconfirm')", 'delete confirms first', 6000)
  const okXY = JSON.parse(String(await stableEval('window.__popOk()')))
  check('确认气泡里有「删除」确认键（不是取消）', !okXY.error, okXY)
  if (okXY.error) {
    throw new Error('no confirm ok button: ' + okXY.error)
  }
  await cdp.click(okXY.x, okXY.y)
  await waitFor(cdp, '!window.__visRoot(".ant-popconfirm")', 'confirm closes', 6000)
  // 分别等"IPC 真的发出去了"和"列表重取到了"：失败时才知道断在哪一段
  await waitFor(cdp, "window.__calls && window.__calls.some(c => c.name === 'deleteRecording')", 'delete IPC fires', 6000)
  await waitFor(cdp, 'window.__recRows().length === ' + (rowsBefore - 1), 'list refreshes after delete', 12000)
  const rowsAfter = (await cdp.jeval('JSON.stringify(window.__recRows())')).length
  check('确认后文件从磁盘删除、列表少一行（不是本地摘行）',
    rowsAfter === rowsBefore - 1 && !fs.existsSync(path.join(dir, NDEL)),
    {
      rowsBefore,
      rowsAfter,
      stillOnDisk: fs.existsSync(path.join(dir, NDEL)),
      calls: await cdp.jeval('window.__callsTail()'),
      toasts: await cdp.jeval('window.__toasts()')
    })

  // ── 7. 浅色主题跟随 token ──────────────────────────────────────
  const xyReplay = await cdp.jeval('window.__recRowXY(' + JSON.stringify(N60) + ', "replay")')
  await cdp.click(xyReplay.x, xyReplay.y)
  await waitFor(cdp, '!!window.__castRoot()', 'player reopens for theme', 8000)
  const darkMeta = await cdp.eval("window.__castColor('.cast-player-meta')")
  const darkTyped = await cdp.eval("window.__castColor('.cast-player-typed')")
  const cfg0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1500)
    const lightMeta = await cdp.eval("window.__castColor('.cast-player-meta')")
    const lightTyped = await cdp.eval("window.__castColor('.cast-player-typed')")
    check('换浅色主题后回放面板文字色跟着变（不是写死）',
      !!darkMeta && lightMeta !== darkMeta && lightTyped !== darkTyped,
      { darkMeta, lightMeta, darkTyped, lightTyped })
    await shot('player-light')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
    await sleep(800)
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }
  await cdp.eval('window.__closeCast()')
  await sleep(500)

  // ── 收尾：关掉自测造的假录制（磁盘）+ 关本地终端 ───────────────
  await cdp.eval('window.__closeRecList = () => { const m = window.__visRoot(".rec-list-modal"); const b = m && m.querySelector(".ant-modal-close"); b && b.click(); return b ? "ok" : "missing" }')
  await cdp.eval('window.__closeRecList()')
  await sleep(500)
  for (const n of FILES) {
    const p = path.join(dir, n)
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true })
    }
  }
  check('假录制已从磁盘清理', FILES.every(n => !fs.existsSync(path.join(dir, n))))

  // 自测开的本地终端也关掉：留下一个空 shell 会让下次跑的窗口状态不一样
  await cdp.eval('window.store.removeTabs(t => t.id === ' + JSON.stringify(myTab) + ')')
  await sleep(800)
  check('自测终端已关闭',
    (await cdp.jeval('JSON.stringify(window.store.tabs.map(t => t.id))')).indexOf(myTab) < 0)

  const errs = await cdp.jeval('JSON.stringify(window.__errs || [])')
  if (errs.length) {
    console.log('renderer errors:\n  ' + errs.join('\n  '))
  }
  const tail = cdp.tail(5)
  if (tail.length) {
    console.log('renderer log tail:\n  ' + tail.join('\n  '))
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
