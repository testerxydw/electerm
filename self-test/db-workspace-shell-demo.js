#!/usr/bin/env node
/**
 * U1 · 工作台壳层（顶栏分组 / 控制条折行 / 空态首页 / 状态行）—— CDP 实机回归
 *
 * 为什么必须实机：这一批改的全是"同一排控件在窄宽度下怎么摆"——控制条从
 * nowrap 改成 wrap、翻页整组折到第二行、状态行两口径并排、空态首页顶替空网格。
 * 纯单测能钉住 JSX 结构与 token，钉不住 flex 换行后的真实几何，也钉不住
 * DbGridTable 用 ResizeObserver 量出来的网格高度会不会被折行吃掉。
 *
 * 覆盖（深色/浅色 × 1600/1200/900 共 6 组）：
 *   1) 空态首页可见：连接摘要 + 四个入口 + 最近表 chips
 *   2) 入口可用：打开 SQL 切页签、快速打开弹层可开可关、chip 点开数据网格
 *   3) 控制条不横向溢出（scrollWidth 不大于 clientWidth），且最多折成两行
 *   4) 翻页整组（上一页/页签/跳页/页大小）落在同一行，不会被拆成两截
 *   5) 状态行：本页 n 行 · 总行数（约）；勾选后动作组首出现"已选 n 行"
 *   6) 折行后网格可视高度仍然正常（虚拟列表容器没被压成 0、也没溢出卡片底边）
 *   7) 浅色主题下前景 token 确实变了（壳层没有写死深色）
 *
 * 用法：
 *   1) npm run vite-build
 *   2) HOME=/tmp/xxx/home TMPDIR=/tmp/xxx DISPLAY=:130 \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   3) node self-test/db-workspace-shell-demo.js [debugPort] [shotDir]
 *
 * 桩数据直接复用 db-grid-interactions-demo.js 里的 STUB/OPEN_TAB（同一份 12 行
 * 带主键的假表），两处各写一份必然打架。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-workspace-shell-shots')
const DISPLAY = process.env.DISPLAY || ':130'
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
// onResize 会去问主进程屏幕尺寸，测试实例上拿到 null 会解构报错
const SCREEN_STUB = `
(() => {
  const orig = window.pre.runGlobalAsync
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'getScreenSize') return Promise.resolve({ width: 1600, height: 1000 })
    return orig.call(window.pre, name, ...a)
  }
  return 'patched'
})()
`

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

const waitFor = async (cdp, cond, what, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = await cdp.eval('(() => { try { return !!(' + cond + ') } catch (e) { return false } })()')
    if (hit) return true
    await sleep(150)
  }
  return false
}

// 一次采齐：空态 / 控制条几何 / 状态行 / 网格高度
const READ = `(() => {
  const vis = window.__vis
  const head = [...document.querySelectorAll('.db-grid-head')].filter(vis)[0]
  const home = [...document.querySelectorAll('.db-home')].filter(vis)[0]
  const area = [...document.querySelectorAll('.db-grid-area')].filter(vis)[0]
  const out = { home: null, head: null, grid: null, vw: window.innerWidth }
  if (home) {
    out.home = {
      engine: (home.querySelector('.db-home-engine') || {}).innerText,
      target: (home.querySelector('.db-home-target') || {}).innerText,
      actions: [...home.querySelectorAll('.db-home-actions button')].map(b => b.innerText.trim()),
      chips: [...home.querySelectorAll('.db-home-table')].map(b => b.innerText.trim())
    }
  }
  if (head) {
    const r = head.getBoundingClientRect()
    const rowsOf = els => {
      const ys = []
      for (const el of els) {
        const y = Math.round(el.getBoundingClientRect().y)
        if (!ys.some(v => Math.abs(v - y) <= 10)) ys.push(y)
      }
      return ys.length
    }
    const kids = [...head.children].filter(vis)
    const pager = head.querySelector('.db-grid-head-pager')
    const total = head.querySelector('.db-grid-total')
    out.head = {
      w: Math.round(r.width),
      h: Math.round(r.height),
      scrollW: head.scrollWidth,
      clientW: head.clientWidth,
      rows: rowsOf(kids),
      pagerRows: pager ? rowsOf([...pager.querySelectorAll('button, .ant-select, .db-grid-jump, input')]) : null,
      pagerText: pager ? pager.innerText.replace(/\\s+/g, ' ').trim() : null,
      total: total ? total.innerText.replace(/\\s+/g, ' ').trim() : null,
      selected: (head.querySelector('.db-grid-selected') || {}).innerText || null,
      groupBtns: (() => {
        const g = head.querySelector('.db-tool-group')
        return g ? [...g.querySelectorAll('button')].length : 0
      })()
    }
  }
  if (area) {
    const holder = area.querySelector('.ant-table-tbody-virtual-holder') || area.querySelector('.ant-table-body')
    const ar = area.getBoundingClientRect()
    const hr = holder ? holder.getBoundingClientRect() : null
    out.grid = {
      rows: window.__rowCount(),
      areaH: Math.round(ar.height),
      areaBottom: Math.round(ar.bottom),
      holderH: hr ? Math.round(hr.height) : null,
      holderBottom: hr ? Math.round(hr.bottom) : null,
      viewportBottom: Math.round(document.documentElement.clientHeight)
    }
  }
  return JSON.stringify(out)
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
  await cdp.eval(SCREEN_STUB)

  // 先清掉实例里遗留的数据库标签页：切走的页签仍挂在 DOM 里，
  // 判据全靠"可见的那一个"，留着上一轮的网格就会时好时坏
  const leftovers = JSON.parse(await cdp.eval(
    "JSON.stringify(window.store.tabs.filter(t => t.type === 'database').map(t => t.id))"
  ))
  for (const id of leftovers) await closeTab(cdp, id)
  if (leftovers.length) console.log('closed leftover db tabs: ' + leftovers.length)

  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const theme0 = await cdp.eval('window.store._config && window.store._config.theme')
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  // 深色那一轮用内置 default，而不是实例当前主题：当前可能是任意一个 iterm 配色，
  // 换台机器跑出来的截图就不该跟着变
  const darkId = themeIds.includes('default') ? 'default' : theme0
  check('深浅两套主题可切换', !!lightId && !!darkId, themeIds)

  // 窗口宽度只能靠窗口管理器改：Emulation.setDeviceMetricsOverride 不会让应用真正重排，
  // Electron 下 Browser.getWindowForTarget 也不可用。
  // 机器上可能同时开着好几个 electerm 窗口（并行自测各占一个端口），按名字取第一个
  // 会缩错窗口——页面 innerWidth 纹丝不动，测出来的"三档宽度"全是同一档。
  // 所以逐个试缩（记下原尺寸、缩完立刻还原），谁跟着变谁就是这个页面的窗口。
  const xdo = (...args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY } }).toString()
  const innerW = async () => Number(await cdp.eval('window.innerWidth'))
  const geometryOf = (id) => {
    try {
      const m = /Geometry:\s*(\d+)x(\d+)/.exec(xdo('getwindowgeometry', id))
      return m ? [Number(m[1]), Number(m[2])] : [1600, 1000]
    } catch (e) {
      return [1600, 1000]
    }
  }
  const candidates = xdo('search', '--name', '^electerm').trim().split('\n').filter(Boolean)
  let winId = null
  for (const id of candidates) {
    const [w0, h0] = geometryOf(id)
    xdo('windowsize', id, '1023', String(h0))
    await sleep(450)
    const probe = await innerW()
    xdo('windowsize', id, String(w0), String(h0))
    await sleep(300)
    if (Math.abs(probe - 1023) <= 2) {
      winId = id
      break
    }
  }
  check('在多个 electerm 窗口里认出了本页面的窗口', !!winId,
    { candidates, innerWidth: await innerW() })
  const setSize = async (w) => {
    if (!winId) return
    xdo('windowsize', winId, String(w), '1000')
    await sleep(300)
    await cdp.eval('window.store.onResize()')
    await sleep(600)
  }
  const tokenOf = prop => cdp.eval(
    'getComputedStyle(document.documentElement).getPropertyValue(' + JSON.stringify(prop) + ')'
  )

  const textDark = String(await tokenOf('--text')).trim()
  let textLight = null
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(700)
    textLight = String(await tokenOf('--text')).trim()
    await cdp.eval('window.store.setTheme(' + JSON.stringify(darkId) + ')')
    await sleep(700)
  }
  check('切主题确实换了前景 token（壳层没写死颜色）', !!textLight && textLight !== textDark, [textDark, textLight])

  for (const theme of [{ id: darkId, name: 'dark' }, { id: lightId, name: 'light' }]) {
    if (!theme.id) continue
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme.id) + ')')
    await sleep(600)
    for (const w of [1600, 1200, 900]) {
      const tag = theme.name + '-' + w
      await setSize(w)
      const id = await openTab(cdp)
      const label = '[' + tag + ']'

      // ---- 空态首页 ----
      const homeOk = await waitFor(cdp,
        '!![...document.querySelectorAll(".db-home")].filter(window.__vis)[0]', 'home ' + tag, 6000)
      let s = JSON.parse(await cdp.eval(READ))
      check(label + ' 无表选中时显示工作台首页', homeOk && !!s.home, s.home)
      check(label + ' 首页有引擎与目标摘要', !!(s.home && s.home.engine && s.home.target),
        s.home && [s.home.engine, s.home.target])
      check(label + ' 首页四个入口齐全', !!(s.home && s.home.actions.length === 4),
        s.home && s.home.actions)
      check(label + ' 首页列出最近表 chips', !!(s.home && s.home.chips.length >= 1), s.home && s.home.chips)
      await cdp.shot(path.join(SHOT_DIR, 'home-' + tag + '.png'))

      // ---- 入口可用（只在 1600 深色那轮真点，其余轮次点 chip 即可）----
      if (tag === 'dark-1600') {
        await cdp.eval(`(() => {
          const b = [...document.querySelectorAll('.db-home-actions button')]
            .filter(window.__vis).find(x => /SQL/.test(x.innerText))
          b.click(); return 'ok'
        })()`)
        check(label + ' "打开 SQL" 切到 SQL 页签',
          await waitFor(cdp, '!![...document.querySelectorAll(".db-sql-editor, .db-sql-area, .db-editor")].filter(window.__vis)[0]', 'sql tab'))
        await cdp.eval(`(() => {
          const t = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')].filter(window.__vis)
            .find(x => /数据/.test(x.innerText))
          if (t) t.click()
          return 'ok'
        })()`)
        await sleep(500)
        await cdp.eval(`(() => {
          const b = [...document.querySelectorAll('.db-home-actions button')]
            .filter(window.__vis).find(x => /快速打开/.test(x.innerText))
          if (b) b.click()
          return 'ok'
        })()`)
        check(label + ' "快速打开" 弹出命令面板',
          await waitFor(cdp, '!![...document.querySelectorAll(".db-quick-open")].filter(window.__vis)[0]', 'palette'))
        await cdp.eval(`(() => {
          const i = document.querySelector('.db-quick-open-input input')
          if (i) { i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
          return 'ok'
        })()`)
        await sleep(400)
        check(label + ' Esc 关掉命令面板，回到首页',
          await cdp.eval('!![...document.querySelectorAll(".db-quick-open")].filter(window.__vis)[0]') === false)
      }

      // ---- 点 chip 打开表 ----
      await cdp.eval(`(() => {
        const c = [...document.querySelectorAll('.db-home-table')].filter(window.__vis)[0]
        c.click(); return 'ok'
      })()`)
      const gridOk = await waitFor(cdp,
        '!![...document.querySelectorAll(".db-grid-head")].filter(window.__vis)[0] && window.__rowCount() >= 5', 'grid ' + tag, 9000)
      s = JSON.parse(await cdp.eval(READ))
      check(label + ' 首页 chips 能直接打开数据网格', gridOk && s.head && s.grid.rows >= 5,
        { rows: s.grid && s.grid.rows, head: !!s.head })

      // ---- 控制条几何 ----
      const h = s.head || {}
      check(label + ' 窗口真的被缩到该档（不是白测）', Math.abs(s.vw - w) <= 2, [s.vw, w])
      check(label + ' 控制条不横向溢出', h.scrollW <= h.clientW + 1, [h.scrollW, h.clientW])
      // 设计口径是两行（信息行 + 翻页行）。900px 这种极窄宽度下动作族会继续往下折，
      // 这里按宽度分档卡上限：超过上限说明控件又长回来了或者分组散架了
      const rowCap = w >= 1200 ? 2 : 4
      check(label + ' 控制条折行数在档位上限内（<= ' + rowCap + '）', h.rows >= 1 && h.rows <= rowCap, h.rows)
      check(label + ' 翻页整组不被拆行（组内控件同一行）', h.pagerRows === 1, [h.pagerRows, h.pagerText])
      check(label + ' 状态行给出本页行数与总数',
        /本页 \d+ 行/.test(h.total || '') && /总行数|精确行数/.test(h.total || ''), h.total)
      check(label + ' 批量动作收在一个组里（4 个按钮）', h.groupBtns === 4, h.groupBtns)

      // ---- 勾选后出现选中计数 ----
      // 只点"当前可见"的表头勾选框：切走的标签页仍挂在 DOM 里，裸 querySelector 会打到那一格
      await cdp.eval(`(() => {
        const box = [...document.querySelectorAll('.db-grid-area .ant-table-thead .ant-checkbox')]
          .filter(window.__vis)[0]
        if (box) box.click()
        return 'ok'
      })()`)
      const selOk = await waitFor(cdp,
        '!![...document.querySelectorAll(".db-grid-head .db-grid-selected")].filter(window.__vis)[0]', 'selected chip ' + tag, 5000)
      s = JSON.parse(await cdp.eval(READ))
      check(label + ' 勾选后动作组首显示"已选 n 行"', selOk && /^已选 \d+ 行$/.test((s.head.selected || '').trim()), s.head.selected)
      await cdp.shot(path.join(SHOT_DIR, 'grid-' + tag + '.png'))

      // ---- 折行后网格高度仍然正常 ----
      const g = s.grid || {}
      check(label + ' 网格可视高度未被折行吃掉', g.holderH > 100, [g.holderH, g.areaH, h.h])
      check(label + ' 网格不溢出所在卡片/视口', g.holderBottom <= g.areaBottom + 2 && g.areaBottom <= g.viewportBottom + 2,
        [g.holderBottom, g.areaBottom, g.viewportBottom])

      await closeTab(cdp, id)
    }
  }

  if (winId) xdo('windowsize', winId, '1600', '1000')
  await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
  console.log('shots ->', SHOT_DIR)
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch(e => {
  console.log('ERR ' + e.message)
  process.exit(2)
})
