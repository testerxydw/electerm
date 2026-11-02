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
 * 两类角色分别量（角色清单在 self-test/db-contrast-probe.js，桩库与真库共用）：
 *   · 格内角色（正文/数值/NULL/空串）—— 会随行走，三种底色都量
 *   · 只待在卡片底的角色（详情 NULL、状态行次级、已选计数、详情字段名、执行计划类型）—— 只量一档
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
// 对比度算法与真库脚本共用一份（见 self-test/db-contrast-probe.js 的注释）
const { PROBE, rgbClose, AA } = require('./db-contrast-probe')
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

const waitFor = async (cdp, cond, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = await cdp.eval('(() => { try { return !!(' + cond + ') } catch (e) { return false } })()')
    if (hit) return true
    await sleep(150)
  }
  return false
}

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
