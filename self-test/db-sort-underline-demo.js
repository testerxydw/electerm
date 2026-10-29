#!/usr/bin/env node
/**
 * U2d · 排序列表头主色下划线 —— CDP 实机回归
 *
 * 为什么必须实机：这条规则全靠 `:has()` 从"格内的箭头"反推"整格"。三种落空方式
 * 只有浏览器看得见：
 *   1) 表头格不是真 th（虚拟化的只是表体，thead 仍是真表格元素 —— 得实测确认）；
 *   2) antd 给 th 自己写过 box-shadow，我们的 inset 线被它覆盖（或把它覆盖掉）；
 *   3) :has() 在构建链里被降级丢掉。
 * 判据只有一条：点一次列头，读 th 的 getComputedStyle('boxShadow')，看它是不是
 * "主色 0 -2 0 inset"，未排序的列没有这条；再把线色与该格实际底色做 WCAG 比 ——
 * 下划线是非文本指示物，门槛 3:1（不是正文的 4.5:1）。
 *
 * 覆盖（深色 default / 浅色各一轮）：
 *   1) 未排序时全表头无 inset 线；排序列有，且颜色解析后 == var(--primary)
 *   2) 只有排序那列有线（不误伤同行其它列）；线与箭头同色，一列不搞两套强调色
 *   3) 多列排序：两列各自都有线
 *   4) 取消排序：线跟着消失 —— 证明绑的是排序态，不是一次性 class
 *   5) 线 vs 表头实际底色 ≥ 3:1，两套主题都达标
 *   6) 排序态截图 sorted-{dark,light}.png
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/xxx/home TMPDIR=/tmp/xxx DISPLAY=:130 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-sort-underline-demo.js [debugPort] [shotDir]
 *
 * 桩数据与网格页签复用 db-grid-interactions-demo.js 的 STUB/OPEN_TAB
 * （__clickTree / __rowCount / __hidden / __vis 由那份桩提供）。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sort-underline-shots')
const MIN = 3
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
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }

  close () { this.ws.close() }
}

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
  }).on('error', reject)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

// 列头点击helper：点标题容器（不是整格 —— 自绘箭头之后 th 上没有 pointer，
// 可点的是 .db-col-head），排序态由箭头自己反映
const HELPERS = `(() => {
  window.__ths = () => [...document.querySelectorAll('.db-grid-table .ant-table-thead > tr > th')]
    .filter(th => !window.__hidden(th) && th.querySelector('.db-col-name'))
  window.__th = name => window.__ths().find(th => th.querySelector('.db-col-name').innerText.trim() === name) || null
  window.__glyph = name => {
    const th = window.__th(name)
    const g = th && th.querySelector('.db-col-sort')
    return g ? g.innerText.trim() : 'none'
  }
  window.__sorted = name => {
    const th = window.__th(name)
    return !!(th && th.querySelector('.db-col-sort-active'))
  }
  window.__clickHead = name => {
    const th = window.__th(name)
    if (!th) return 'no-th'
    const head = th.querySelector('.db-col-head')
    if (!head) return 'no-head'
    head.click()
    return 'ok'
  }
  return 'helpers-ok'
})()`

// 页内一次算完：每列的下划线状态 + 线色与该格实际底色的 WCAG 比
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
  const rgbStr = c => c ? 'rgb(' + c.slice(0, 3).map(Math.round).join(', ') + ')' : ''
  const resolve = expr => {
    const d = document.createElement('div')
    d.style.background = expr
    document.body.appendChild(d)
    const c = parse(getComputedStyle(d).backgroundColor)
    d.remove()
    return c
  }
  // 底色逐层合成：表头格自己可能带半透明底，压在卡片底上
  const solidBg = el => {
    const layers = []
    let n = el
    let opaqueAt = -1
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) { opaqueAt = layers.length - 1; break }
      }
      n = n.parentElement
    }
    if (opaqueAt < 0) return null
    let acc = layers[opaqueAt]
    for (let i = opaqueAt - 1; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  const colorOf = sh => {
    const m = /(rgba?\\([^)]*\\)|color\\([^)]*\\)|#[0-9a-f]{3,8})/i.exec(String(sh))
    return m ? parse(m[1]) : null
  }
  // computed 形如 "rgb(0, 136, 204) 0px -2px 0px 0px inset"
  const offsetsOf = sh => {
    const m = /\\)\\s+(-?[\\d.]+)px\\s+(-?[\\d.]+)px/.exec(String(sh))
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: null, y: null }
  }
  const primary = resolve('var(--primary)')
  const cols = window.__ths().map(th => {
    const sh = getComputedStyle(th).boxShadow
    const bar = colorOf(sh)
    const bg = solidBg(th)
    const off = offsetsOf(sh)
    const arrowEl = th.querySelector('.db-col-sort-active')
    return {
      name: th.querySelector('.db-col-name').innerText.trim(),
      sorted: !!arrowEl,
      shadow: sh,
      bar: rgbStr(bar),
      bg: rgbStr(bg),
      inset: /inset/.test(sh),
      x: off.x,
      y: off.y,
      ratio: bar && bg ? Number(ratio(bar, bg).toFixed(2)) : null,
      // 线与箭头必须同色，否则一列出现两套强调色
      arrow: rgbStr(arrowEl ? parse(getComputedStyle(arrowEl).color) : null)
    }
  })
  return JSON.stringify({ primary: rgbStr(primary), cols })
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

const probe = async (cdp) => JSON.parse(await cdp.eval(PROBE))
const col = (p, name) => p.cols.find(c => c.name === name) || null

// 点一次列头并等渲染（asc→desc→none 三态循环，靠字形判断到了哪一档）
const clickHead = async (cdp, name, glyph) => {
  await cdp.eval('window.__clickHead(' + JSON.stringify(name) + ')')
  const hit = await waitFor(cdp, 'window.__glyph(' + JSON.stringify(name) + ') === ' + JSON.stringify(glyph))
  await sleep(200)
  return hit
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
  check('列头 helper 已注入', await cdp.eval(HELPERS) === 'helpers-ok')

  for (const theme of [{ id: darkId, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) continue
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(800)

    // ---- 1) 初始无排序：全表头都不该有 inset 线；表头格得是真 th ----
    let p = await probe(cdp)
    check(theme.name + '：表头列渲染成真 th（:has() 有对象可匹配）', p.cols.length >= 4,
      { th: p.cols.length, names: p.cols.map(c => c.name) })
    const stray = p.cols.filter(c => c.inset)
    check(theme.name + '：未排序时没有列带下划线', stray.length === 0,
      stray.map(c => ({ name: c.name, shadow: c.shadow })))

    // ---- 2) id 排序：该列有线，颜色 = --primary，几何 = 贴格底 ----
    check('点 id 排序生效（▲）', await clickHead(cdp, 'id', '▲'))
    p = await probe(cdp)
    let id = col(p, 'id')
    check(theme.name + '：排序列有线（inset box-shadow 生效，:has() 没白写）', !!id && id.inset,
      { shadow: id && id.shadow })
    check(theme.name + '：线贴在格底（0 / -2 偏移）', !!id && id.x === 0 && id.y === -2,
      { x: id && id.x, y: id && id.y, shadow: id && id.shadow })
    check(theme.name + '：线色 == 解析后的 --primary（不是写死色值）', !!id && rgbClose(id.bar, p.primary),
      { bar: id && id.bar, primary: p.primary })
    check(theme.name + '：线与箭头同色（一列不搞两套强调色）', !!id && rgbClose(id.arrow, p.primary),
      { arrow: id && id.arrow, primary: p.primary })
    const others = p.cols.filter(c => c.name !== 'id')
    check(theme.name + '：只有排序那列有线，其余列没被误伤',
      others.every(c => !c.inset || !rgbClose(c.bar, p.primary)),
      others.filter(c => c.inset).map(c => ({ name: c.name, shadow: c.shadow })))

    // ---- 3) 多列排序：两列各自都有线 ----
    check('点 flag 排序生效（▲）', await clickHead(cdp, 'flag', '▲'))
    p = await probe(cdp)
    id = col(p, 'id')
    const flag = col(p, 'flag')
    check(theme.name + '：多列排序时两列各自都有下划线',
      !!id && id.inset && !!flag && flag.inset,
      { id: id && id.inset, flag: flag && flag.inset })

    // ---- 4) 取消 flag 的排序：线跟着消失（绑的是排序态，不是一次性 class） ----
    check('flag 转 desc（▼）', await clickHead(cdp, 'flag', '▼'))
    check('flag 取消排序（回到 ⇅）', await clickHead(cdp, 'flag', '⇅'))
    p = await probe(cdp)
    const flag2 = col(p, 'flag')
    check(theme.name + '：取消排序后该列下划线消失',
      !!flag2 && !flag2.sorted && !flag2.inset, { flag: flag2 })
    check(theme.name + '：id 仍在排序，线不受别的列影响', !!col(p, 'id') && col(p, 'id').inset,
      { id: col(p, 'id') && col(p, 'id').inset })

    // ---- 5) 线 vs 表头实际底色：非文本指示物 ≥ 3:1 ----
    p = await probe(cdp)
    const sortedCols = p.cols.filter(c => c.sorted)
    check(theme.name + '：恰好剩 id 一列在排序', sortedCols.length === 1, sortedCols.map(c => c.name))
    for (const c of sortedCols) {
      const ok = c.ratio !== null && c.ratio >= MIN
      console.log('  bar ' + c.name.padEnd(8, ' ') + ' | ' + String(c.ratio).padStart(5) +
        ' | ' + c.bar + ' on ' + c.bg)
      check(theme.name + '：' + c.name + ' 列下线 vs 表头底 ≥ ' + MIN + ':1', ok,
        { ratio: c.ratio, bar: c.bar, bg: c.bg })
    }
    await cdp.shot(path.join(SHOT_DIR, 'sorted-' + theme.name + '.png'))

    // ---- 6) 复原：把 id 也点掉，别把排序态留给下一个脚本 ----
    check(theme.name + '：id 转 desc', await clickHead(cdp, 'id', '▼'))
    check(theme.name + '：id 取消排序（复原）', await clickHead(cdp, 'id', '⇅'))
    p = await probe(cdp)
    check(theme.name + '：复原后全表头无下划线', p.cols.every(c => !c.inset),
      p.cols.filter(c => c.inset).map(c => ({ name: c.name, shadow: c.shadow })))
  }

  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  await closeTab(cdp, tabId)
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch(e => { console.log('ERR ' + e.message); process.exit(1) })
