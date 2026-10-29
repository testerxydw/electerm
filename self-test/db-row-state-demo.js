#!/usr/bin/env node
/**
 * U2a · 数据网格行交互态（悬停/选中/当前键）token 化 —— CDP 实机回归
 *
 * 为什么必须实机：这一批改的是"哪条 CSS 规则最终生效"。源码里选择器写得再像，
 * 三种情况都能让它静默失效，而且都是浏览器才看得见：
 *   1) 虚拟表体（DbGridTable 在 scroll.y > 0 时开）里行与格都是 div，`td` 选择器落空；
 *   2) tbody 与行之间夹着 .ant-table-tbody-virtual-holder(-inner) 两层 div，`>` 落空；
 *   3) antd 的行底色是它自己 CSS-in-JS 派生的，类数不够就压不过它，
 *      而它的 <style> 运行时注入，"打平靠先后"并不可靠。
 * 所以判据只有一条：把鼠标真的移上去、真的勾一行，读单元格 getComputedStyle 的
 * backgroundColor，看它是否等于 --hover-bg / --active-bg 各自解析出来的值。
 *
 * 覆盖（深色 default / 浅色各一轮）：
 *   1) 空闲行不带交互色；悬停 = --hover-bg；选中 = --active-bg
 *   2) 选中 + 悬停仍是 --active-bg（勾中的行划过不闪色）
 *   3) 悬停/选中的底色不再等于 antd 自己的 --ant-table-row-hover-bg（证明覆盖生效）
 *   4) 换主题时悬停底色跟着前景变（--hover-bg 派生自 --text，写死就露馅）；
 *      选中底色两套内置主题同值（--active-bg 派生自 --primary，深浅两套主色一致）
 *   5) Redis 键列表用的 .db-row-selected：非 antd 选中态也能吃到 --active-bg
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/xxx/home TMPDIR=/tmp/xxx DISPLAY=:130 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-row-state-demo.js [debugPort] [shotDir]
 *
 * 桩数据与网格页签复用 db-grid-interactions-demo.js 的 STUB/OPEN_TAB，
 * 主题 id 的取法与 db-workspace-shell-demo.js 一致（深色固定用内置 default）。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-row-state-shots')
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

// 第 idx 行第 1 个数据格的中心（虚拟表体只渲染可见十几行，所以按序号取 DOM 里的那几行）
const CELL_BOX = idx => `(() => {
  const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
  const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[${idx}]
  if (!row) return null
  const cell = row.querySelector('.ant-table-cell:not(.ant-table-selection-column)')
  const r = cell.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
})()`

// 一次采齐：token 原文/解析值 + 该格实际底色 + 悬停/选中态 + antd 自己那套底色
const READ = idx => `(() => {
  const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
  const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[${idx}]
  const cell = row.querySelector('.ant-table-cell:not(.ant-table-selection-column)')
  const cs = getComputedStyle(cell)
  const resolve = v => {
    const d = document.createElement('div')
    d.style.background = 'var(' + v + ')'
    document.body.appendChild(d)
    const c = getComputedStyle(d).backgroundColor
    d.remove()
    return c
  }
  return JSON.stringify({
    rowCls: row.className,
    hoverOnRow: cs.backgroundColor,
    selectedCell: getComputedStyle(row.querySelector('.ant-table-selection-column')).backgroundColor,
    tokens: {
      hoverRaw: getComputedStyle(document.documentElement).getPropertyValue('--hover-bg').trim(),
      activeRaw: getComputedStyle(document.documentElement).getPropertyValue('--active-bg').trim(),
      hover: resolve('--hover-bg'),
      active: resolve('--active-bg')
    },
    // antd 自己那套（CSS-in-JS 变量）：覆盖生效时它仍在 DOM 上，但已经不再决定底色
    antd: {
      hover: cs.getPropertyValue('--ant-table-row-hover-bg').trim(),
      selected: cs.getPropertyValue('--ant-table-row-selected-bg').trim()
    }
  })
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

const move = async (cdp, x, y) => {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await sleep(350)
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
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  const darkId = themeIds.includes('default') ? 'default' : theme0
  check('深浅两套主题可切换', !!lightId && !!darkId, themeIds)

  const tabId = await openTab(cdp)
  await cdp.eval('window.__clickTree("demo_db")')
  await sleep(400)
  await cdp.eval('window.__clickTree("grid_demo")')
  const ready = await waitFor(cdp, 'window.__rowCount() >= 5')
  check('桩表网格已打开（虚拟表体，行与格都是 div）', ready, { rows: await cdp.eval('window.__rowCount()') })

  const seen = {}
  for (const theme of [{ id: darkId, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) continue
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(700)
    // 先复位：不悬停、不勾选，避免上一轮的主题残留状态
    await move(cdp, 4, 4)
    await cdp.eval(`(() => {
      const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
      for (const r of [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)) {
        const box = r.querySelector('.ant-table-selection-column .ant-checkbox')
        if (r.className.includes('ant-table-row-selected') && box) box.click()
      }
      return 'unchecked'
    })()`)
    await sleep(400)

    const idle = JSON.parse(await cdp.eval(READ(1)))
    check(theme.name + '：空闲行不是交互色（悬停/选中底色不该常驻）',
      idle.hoverOnRow !== idle.tokens.hover && idle.hoverOnRow !== idle.tokens.active,
      { bg: idle.hoverOnRow, hover: idle.tokens.hover, active: idle.tokens.active })

    const box = JSON.parse(await cdp.eval(CELL_BOX(1)))
    await move(cdp, box.x, box.y)
    const hov = JSON.parse(await cdp.eval(READ(1)))
    check(theme.name + '：悬停底色 = --hover-bg 解析值', hov.hoverOnRow === hov.tokens.hover,
      { got: hov.hoverOnRow, want: hov.tokens.hover, raw: hov.tokens.hoverRaw })
    if (hov.antd.hover) {
      check(theme.name + '：悬停底色不再是 antd 派生色', hov.hoverOnRow !== hov.antd.hover,
        { mine: hov.hoverOnRow, antd: hov.antd.hover })
    }
    await cdp.shot(path.join(SHOT_DIR, 'hover-' + theme.name + '.png'))

    // 勾选第 1 行，然后悬停在它上面：选中态该盖住悬停态
    await cdp.eval(`(() => {
      const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
      const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[1]
      row.querySelector('.ant-table-selection-column .ant-checkbox').click()
      return 'checked'
    })()`)
    await sleep(450)
    const selOnly = JSON.parse(await cdp.eval(READ(1)))
    check(theme.name + '：选中行底色 = --active-bg 解析值', selOnly.hoverOnRow === selOnly.tokens.active,
      { got: selOnly.hoverOnRow, want: selOnly.tokens.active, raw: selOnly.tokens.activeRaw, rowCls: selOnly.rowCls })

    const box2 = JSON.parse(await cdp.eval(CELL_BOX(1)))
    await move(cdp, box2.x, box2.y)
    const selHov = JSON.parse(await cdp.eval(READ(1)))
    check(theme.name + '：选中 + 悬停仍是 --active-bg（划过不闪色）', selHov.hoverOnRow === selHov.tokens.active,
      { got: selHov.hoverOnRow, want: selHov.tokens.active })
    check(theme.name + '：勾选列与数据列同一套底色', selHov.selectedCell === selHov.tokens.active,
      { data: selHov.hoverOnRow, selCol: selHov.selectedCell })
    await cdp.shot(path.join(SHOT_DIR, 'selected-hover-' + theme.name + '.png'))

    // 撤掉勾选，改挂 .db-row-selected（Redis 键列表"当前键"那条规则）：
    // 没有 antd 的 row-selected 类，只有我们的规则能给它上色
    await cdp.eval(`(() => {
      const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
      const row = [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)[1]
      row.querySelector('.ant-table-selection-column .ant-checkbox').click()
      row.classList.add('db-row-selected')
      return 'manual-class'
    })()`)
    await move(cdp, 4, 4)
    await sleep(400)
    const manual = JSON.parse(await cdp.eval(READ(1)))
    check(theme.name + '：.db-row-selected（Redis 当前键）也吃 --active-bg',
      manual.hoverOnRow === manual.tokens.active, { got: manual.hoverOnRow, want: manual.tokens.active, rowCls: manual.rowCls })
    await cdp.eval(`(() => {
      const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
      for (const r of [...area.querySelectorAll('.ant-table-row')].filter(window.__vis)) r.classList.remove('db-row-selected')
      return 'cleaned'
    })()`)

    seen[theme.name] = {
      hover: hov.tokens.hover,
      active: hov.tokens.active,
      hoverRaw: hov.tokens.hoverRaw,
      activeRaw: hov.tokens.activeRaw
    }
  }

  if (seen.dark && seen.light) {
    // 悬停底色由 --text 派生，两套主题前景不同 → 底色必须不同（写死就露馅）；
    // 选中底色由 --primary 派生，内置深浅两套主色同值 → 这里应当相同
    check('换主题时悬停底色跟着前景走（--hover-bg 派生自 --text）',
      seen.dark.hover !== seen.light.hover, { dark: seen.dark.hoverRaw, light: seen.light.hoverRaw })
    check('选中底色两套主题同值（--active-bg 派生自 --primary，两主题主色一致）',
      seen.dark.active === seen.light.active, { dark: seen.dark.activeRaw, light: seen.light.activeRaw })
  }

  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  await closeTab(cdp, tabId)
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
