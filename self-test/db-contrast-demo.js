#!/usr/bin/env node
/**
 * U2c · 数据库工作台文字对比度 —— CDP 实机回归（深/浅 × 三类背景，正文 ≥ 4.5:1）
 *
 * 为什么必须实机：对比度不是"看一眼"的事。三个原因：
 *   1) 文字色、背景色都是 color-mix(...) 派生的，只有浏览器能算出最终像素值；
 *   2) 半透明背景要逐层合成（卡片底 → 悬停 7% → 选中 16% 主色），手算容易漏层；
 *   3) 元素自己的 opacity 会把文字一起压下去（以前 NULL/空串占位就是这么糊的，
 *      浅色主题下只剩 2.0~2.2:1）。
 * 判据用 WCAG 2.1 相对亮度比：正文（<18px 常规字重）要求 ≥ 4.5:1。
 *
 * 两类角色分别量：
 *   · 格内角色（正文/数值/NULL/空串/详情 NULL）—— 会出现在三种底色上，三档都量
 *   · 壳层角色（状态行次级、已选计数、详情字段名、执行计划类型）—— 只待在卡片底
 *
 * 覆盖：
 *   1) 合成矩阵：角色 × 底色（用真实 class，读真实 computed style，不写死色值）
 *   2) 实机对照：桩表里真实的 NULL / 空串 / 选中行，量出来的底色与合成底一致
 *   3) 混合表（NULL + 空串 + 数字 + 长文本 + JSON）深浅两张截图（U2 验收）
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/xxx/home TMPDIR=/tmp/xxx DISPLAY=:130 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-contrast-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-contrast-shots')
const AA = 4.5
const SRC = fs.readFileSync(path.join(__dirname, 'db-grid-interactions-demo.js'), 'utf8')
const grab = (name) => {
  const tag = 'const ' + name + ' = `'
  const at = SRC.indexOf(tag)
  if (at < 0) throw new Error('桩里没找到 ' + name)
  const s = at + tag.length
  return SRC.slice(s, SRC.indexOf('\n`', s))
}
const STUB = grab('STUB')
const OPEN_TAB = grab('OPEN_TAB')

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString())
      const cb = this.pending.get(m.id)
      if (cb) { this.pending.delete(m.id); cb(m) }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const d = r.result && r.result.exceptionDetails
    if (d) throw new Error('eval failed: ' + ((d.exception && d.exception.description) || d.text) + ' :: ' + expression.slice(0, 90))
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    if (r.result && r.result.data) {
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
      return path.relative(process.cwd(), file)
    }
    return '截图失败：' + JSON.stringify(r.error || {}).slice(0, 120)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const getJson = u => new Promise((resolve, reject) => {
  http.get(u, s => {
    let b = ''
    s.on('data', d => { b += d })
    s.on('end', () => resolve(JSON.parse(b)))
  }).on('error', reject)
})

let fails = 0
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
  if (!ok) fails++
}

// 'rgb(r, g, b)' 逐通道比较（合成路径不同会有一两度舍入差），容 ±4
const rgbClose = (a, b) => {
  const pa = /(\d+),\s*(\d+),\s*(\d+)/.exec(String(a))
  const pb = /(\d+),\s*(\d+),\s*(\d+)/.exec(String(b))
  if (!pa || !pb) return false
  return [1, 2, 3].every(i => Math.abs(Number(pa[i]) - Number(pb[i])) <= 4)
}

const waitFor = async (cdp, cond, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = await cdp.eval('(() => { try { return !!(' + cond + ') } catch (e) { return false } })()')
    if (hit) return true
    await sleep(150)
  }
  return false
}

// 页内一次算完：合成矩阵 + 真实 DOM 对照
// 说明：角色一律用真实 class 造探针，读 getComputedStyle，所以量到的就是线上生效的那套规则
// （包括元素自己的 background / opacity）。
const PROBE = `(() => {
  const parse = s => {
    s = String(s).trim()
    let m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*(?:\\/\\s*([\\d.]+))?\\s*\\)$/.exec(s)
    if (m) return [Math.round(m[1] * 255), Math.round(m[2] * 255), Math.round(m[3] * 255), m[4] === undefined ? 1 : Number(m[4])]
    m = /^rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)\\s*(?:[,/]\\s*([\\d.]+))?\\s*\\)$/.exec(s)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1]
    return null
  }
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1]
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const rgbStr = c => 'rgb(' + c.slice(0, 3).map(Math.round).join(', ') + ')'
  const resolve = expr => {
    const d = document.createElement('div')
    d.style.background = expr
    document.body.appendChild(d)
    const c = parse(getComputedStyle(d).backgroundColor)
    d.remove()
    return c
  }
  // 元素（含祖先）的 opacity 会整体压低文字，要乘进前景 alpha
  const alphaOf = el => {
    let a = 1
    let n = el
    while (n && a > 0) { a *= Number(getComputedStyle(n).opacity); n = n.parentElement }
    return a
  }
  const measure = (el, bg) => {
    const cs = getComputedStyle(el)
    const fg = parse(cs.color)
    if (!fg) return null
    let acc = bg
    const own = parse(cs.backgroundColor)
    if (own && own[3] > 0) acc = over(own, acc)
    const alpha = fg[3] * alphaOf(el)
    const solid = over([fg[0], fg[1], fg[2], alpha], acc)
    return {
      ratio: Number(ratio(solid, acc).toFixed(2)),
      font: cs.fontSize + '/' + cs.fontWeight + (alphaOf(el) < 1 ? ' op' + alphaOf(el).toFixed(2) : ''),
      color: cs.color,
      bgSolid: rgbStr(acc)
    }
  }
  const BG = [
    ['卡片底', ['var(--main)']],
    ['悬停底', ['var(--main)', 'var(--hover-bg)']],
    ['选中底', ['var(--main)', 'var(--active-bg)']]
  ]
  // 格内角色：三种底色都会遇到
  const GRID = [
    ['格内正文', ''],
    ['数值列', 'db-cell-num'],
    ['NULL 占位', 'db-cell-null'],
    ['空串占位', 'db-cell-empty'],
    ['详情 NULL', 'db-row-detail-value is-null']
  ]
  // 壳层角色：只待在卡片底（状态行、计数、字段名、执行计划类型）
  const CHROME = [
    ['状态行次级', 'db-grid-total'],
    ['已选计数', 'db-grid-selected'],
    ['详情字段名', 'db-row-detail-type'],
    ['执行计划类型', 'db-explain-type']
  ]
  const host = document.createElement('div')
  host.setAttribute('style', 'position:fixed;left:-9999px;top:0')
  document.body.appendChild(host)
  const matrix = []
  const run = (roles, bgs) => {
    for (const [roleName, cls] of roles) {
      for (const [bgName, layers] of bgs) {
        const el = document.createElement('span')
        if (cls) el.className = cls
        el.textContent = 'Aa 1234567890'
        host.appendChild(el)
        let acc = [0, 0, 0, 1]
        for (const l of layers) acc = over(resolve(l), acc)
        const m = measure(el, acc)
        if (m) matrix.push({ role: roleName, cls, bg: bgName, ...m })
        el.remove()
      }
    }
  }
  run(GRID, BG)
  run(CHROME, BG.slice(0, 1))
  host.remove()

  // 实机对照：桩表里真实的 NULL / 空串格与真实选中行，底色应与合成的卡片底/选中底一致
  const real = []
  const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
  const cardBg = resolve('var(--main)')
  const selBg = over(resolve('var(--active-bg)'), cardBg)
  // 从元素往上收集半透明层，遇到不透明层收尾，再从最底层往上叠
  const stackOf = el => {
    const layers = []
    let n = el
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
      n = n.parentElement
    }
    let acc = layers[layers.length - 1]
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  for (const [label, sel, want] of [
    ['NULL 格', '.db-cell-null', cardBg],
    ['空串格', '.db-cell-empty', cardBg]
  ]) {
    const el = area && [...area.querySelectorAll(sel)].filter(window.__vis)[0]
    if (!el) { real.push({ label, miss: true }); continue }
    // 从父级开始叠：measure() 会把元素自己的 background 再叠一层
    const m = measure(el, stackOf(el.parentElement))
    real.push({ label, want: rgbStr(want), ...m })
  }
  const selRow = area && [...area.querySelectorAll('.ant-table-row.ant-table-row-selected')].filter(window.__vis)[0]
  if (selRow) {
    const cell = selRow.querySelector('.ant-table-cell')
    const m = measure(cell, stackOf(cell.parentElement))
    real.push({ label: '选中行正文', want: rgbStr(selBg), ...m })
  } else {
    real.push({ label: '选中行正文', miss: true })
  }
  return JSON.stringify({ matrix, real })
})()`

const openTab = async (cdp) => {
  const res = JSON.parse(await cdp.eval(OPEN_TAB))
  if (!res.id) throw new Error('数据库标签页没建出来')
  await sleep(1200)
  return res.id
}

const closeTab = async (cdp, id) => {
  await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  await sleep(400)
}

;(async () => {
  const ts = await getJson('http://127.0.0.1:' + PORT + '/json')
  const page = ts.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) throw new Error('没找到 electerm 页面，先起 --remote-debugging-port=' + PORT)
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront')
  await sleep(400)
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  check('桩 MySQL 已注入', await cdp.eval(STUB) === 'stub-installed')
  const leftovers = JSON.parse(await cdp.eval(
    "JSON.stringify(window.store.tabs.filter(t => t.type === 'database').map(t => t.id))"
  ))
  for (const id of leftovers) await closeTab(cdp, id)
  if (leftovers.length) console.log('closed leftover db tabs: ' + leftovers.length)

  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const theme0 = await cdp.eval('window.store._config && window.store._config.theme')
  const lightId = themeIds.find(id => /light/i.test(String(id)))
  const darkId = themeIds.includes('default') ? 'default' : theme0
  check('深浅两套主题可切换', !!lightId && !!darkId, themeIds)

  const tabId = await openTab(cdp)
  await cdp.eval('window.__clickTree("demo_db")')
  await sleep(400)
  await cdp.eval('window.__clickTree("grid_demo")')
  check('桩表网格已打开', await waitFor(cdp, 'window.__rowCount() >= 5'))
  // 勾一行，让"真实选中行"这条对照有对象（也顺便给截图一个选中态）
  await cdp.eval(`(() => {
    const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
    const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[1]
    row.querySelector('.ant-table-selection-column .ant-checkbox').click()
    return 'checked'
  })()`)
  await sleep(400)

  for (const theme of [{ id: darkId, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) continue
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(800)
    const { matrix, real } = JSON.parse(await cdp.eval(PROBE))
    console.log('=== ' + theme.name + '（阈值 ' + AA + ':1）')
    let worst = null
    for (const m of matrix) {
      const ok = m.ratio >= AA
      if (!worst || m.ratio < worst.ratio) worst = m
      console.log((ok ? '  ok  ' : '  FAIL') + ' ' + m.role.padEnd(6, ' ') + ' @ ' + m.bg +
        ' | ' + String(m.ratio).padStart(5) + ' | ' + m.font.padEnd(18) + m.color + ' on ' + m.bgSolid)
      check(theme.name + '：' + m.role + ' 在' + m.bg + ' 上 ≥ ' + AA, ok,
        ok ? undefined : { ratio: m.ratio, font: m.font, color: m.color, bg: m.bgSolid })
    }
    console.log('  最差：' + (worst ? worst.role + ' @ ' + worst.bg + ' = ' + worst.ratio : 'n/a'))
    for (const r of real) {
      if (r.miss) { check(theme.name + '：实机对照「' + r.label + '」元素存在', false); continue }
      const near = rgbClose(r.bgSolid, r.want)
      console.log('  real ' + r.label.padEnd(6, ' ') + ' | ' + String(r.ratio).padStart(5) +
        ' | ' + r.color + ' on ' + r.bgSolid + (near ? '' : ' ≠ ' + r.want))
      check(theme.name + '：实机「' + r.label + '」底色与合成底一致（±4/通道）', near, { got: r.bgSolid, want: r.want })
      check(theme.name + '：实机「' + r.label + '」≥ ' + AA, r.ratio >= AA,
        { ratio: r.ratio, color: r.color, bg: r.bgSolid })
    }
    await cdp.shot(path.join(SHOT_DIR, 'mixed-' + theme.name + '.png'))
  }

  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  await closeTab(cdp, tabId)
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
