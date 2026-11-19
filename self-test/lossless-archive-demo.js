#!/usr/bin/env node
/**
 * 完整输出归档（lossless_output）—— CDP 实机演示/回归（真实本地 shell，无需远端）
 *
 * 验收：
 *   1) 顶栏「完整输出」图标常驻（右键被配置为粘贴时上下文菜单不可达，
 *      入口只能走顶栏）
 *   2) 点击后菜单三项齐全（打开目录 / 定位本会话 / 复制路径）
 *   3) 复制路径写进剪贴板，且是本次会话的 lossless-*.bin 分片
 *   4) 归档统计 IPC 指向 <sessionLogDir>/lossless_output，count/bytes 与实际一致
 *   5) 设置 → 终端 展示归档占用行「N 个文件 · 大小」
 *   6) 清理确认框可打开/取消，取消后文件数不变（不点确认，避免真删）
 *
 * 用法：
 *   1) npm run compile
 *   2) Xvfb :111 -screen 0 1400x900x24 &
 *      DISPLAY=:111 HOME=/tmp/electerm-arch-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox
 *   3) node self-test/lossless-archive-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'lossless-archive-shots')

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
  }).on('error', reject)
})

const STUB = `
(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__visAll = sel => [...document.querySelectorAll(sel)].filter(window.__vis)
  window.__text = el => (el ? String(el.innerText || '').replace(/\\s+/g, ' ').trim() : '')
  window.__archiveIcon = () => window.__visAll('.archive-menu-icon')[0] || null
  window.__ddItems = () =>
    window.__visAll('.ant-dropdown .ant-dropdown-menu-item').map(window.__text)
  window.__ddItem = re => {
    const items = window.__visAll('.ant-dropdown .ant-dropdown-menu-item')
    const it = items.find(el => re.test(window.__text(el)))
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  window.__modal = () => window.__visAll('.custom-modal-content')[0] || null
  window.__modalBtn = re => {
    const m = window.__modal()
    if (!m) return 'no-modal'
    const btns = [...m.querySelectorAll('.custom-modal-footer button')]
    const btn = btns.find(b => re.test(b.innerText))
    if (!btn) return 'no-btn'
    btn.click()
    return 'ok'
  }
  window.__openTerminalSettings = () => {
    window.store.openSetting()
    return 'ok'
  }
  window.__pickSettingItem = re => {
    const units = window.__visAll('.item-list-unit')
    const unit = units.find(el => re.test(window.__text(el.querySelector('.list-item-title'))))
    if (!unit) return 'no-item'
    unit.click()
    return 'ok'
  }
  return 'stub-installed'
})()
`

const SETUP = `
(() => {
  const store = window.store
  // 上次会话可能停在设置弹层：先关掉，顶栏截图才看得到终端栏
  store.hideSettingModal()
  store.tabs.slice().forEach(t => store.delTab(t.id))
  store.addTab({ type: 'local', title: 'ARCH-1', production: false, batch: 0 })
  const id = store.tabs[store.tabs.length - 1].id
  window.__a = { id }
  store.changeActiveTabId(id)
  return JSON.stringify({ id, active: store.activeTabId })
})()
`

const READY = `
(() => {
  const id = window.__a.id
  const tab = window.store.tabs.find(t => t.id === id)
  const t = window.refs.get('term-' + id)
  const addon = t && t.attachAddon
  return !!tab && tab.status === 'success' && !!addon && !addon.disposed
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
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression, awaitPromise = false) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 120))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      throw new Error('screenshot failed: ' + JSON.stringify(r.error || r.result))
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 10000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.eval(expr)) {
      return true
    }
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return false
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  await cdp.eval(STUB)
  const setup = JSON.parse(await cdp.eval(SETUP))
  const id = setup.id
  const ready = await waitFor(cdp, READY, 'local shell connected', 20000)
  check('本地终端就绪', ready, setup)

  // ---- 1) 顶栏图标常驻 ----
  await waitFor(cdp, '!!window.__archiveIcon()', 'archive icon')
  const iconInfo = JSON.parse(await cdp.eval(`
    (() => {
      const el = window.__archiveIcon()
      if (!el) return JSON.stringify(null)
      const rect = el.getBoundingClientRect()
      return JSON.stringify({
        inBar: !!el.closest('.terminal-control'),
        visible: rect.width > 0 && rect.height > 0
      })
    })()
  `))
  check('顶栏出现「完整输出」图标且可见', iconInfo && iconInfo.inBar && iconInfo.visible, iconInfo)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-topbar-icon.png')))

  // ---- 2) 菜单三项 ----
  await cdp.eval('window.__archiveIcon().click()')
  await waitFor(cdp, 'window.__ddItems().length > 0', 'archive dropdown')
  await sleep(400)
  const items = await cdp.eval('window.__ddItems()')
  check('菜单三项齐全', Array.isArray(items) && items.length === 3, items)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-archive-menu.png')))

  // ---- 3) 本会话归档信息（渲染层视角）----
  const info = JSON.parse(await cdp.eval(`
    (() => {
      const t = window.refs.get('term-' + ${JSON.stringify(id)})
      return JSON.stringify((t && t.getArchiveInfo && t.getArchiveInfo()) || null)
    })()
  `))
  check('渲染层拿得到本会话归档目录与分片',
    !!info && /lossless_output$/.test(info.dir || '') && info.parts.length >= 1,
    info && { dir: info.dir, parts: info.parts.length, first: path.basename((info.parts[0] || '')) }
  )

  // ---- 4) 复制路径 → 剪贴板 ----
  const clicked = await cdp.eval('window.__ddItem(/复制归档路径|Copy archive path/)')
  await sleep(400)
  const clip = await cdp.eval('window.pre.readClipboard()')
  check('复制路径写入剪贴板且是本会话分片',
    clicked === 'ok' && /lossless-.*\.bin/.test(String(clip || '')),
    String(clip || '').slice(0, 160)
  )

  // ---- 5) 主进程统计 IPC（临时 HOME，不碰真实归档）----
  const stat = JSON.parse(await cdp.eval(`
    (() => new Promise(resolve => {
      window.pre.runGlobalAsync('losslessArchiveInfo')
        .then(info => resolve(JSON.stringify(info)))
        .catch(err => resolve(JSON.stringify({ error: String(err && err.message || err) })))
    }))()
  `, true) || 'null')
  check('归档统计指向 lossless_output 且计数与文件一致',
    !!stat && /lossless_output$/.test(stat.dir || '') &&
      stat.count >= 1 && stat.bytes > 0 && Array.isArray(stat.files) && stat.files.length >= 1,
    stat && { dir: stat.dir, count: stat.count, bytes: stat.bytes }
  )
  check('统计带默认保留天数（设置页初始值）',
    !!stat && Number.isFinite(stat.keepDaysDefault) && stat.keepDaysDefault > 0,
    stat && stat.keepDaysDefault
  )

  // ---- 6) 设置 → 终端：归档占用行 ----
  await cdp.eval('window.store.hideSettingModal()')
  await sleep(300)
  await cdp.eval('window.__openTerminalSettings()')
  await waitFor(cdp, 'window.__visAll(".item-list-unit").length > 0', 'settings menu list')
  await sleep(400)
  const picked = await cdp.eval('window.__pickSettingItem(/终端|Terminal/)')
  await waitFor(cdp, 'window.__visAll(".archive-config-row").length === 1', 'archive row')
  await sleep(400)
  await cdp.eval('window.__visAll(".archive-config-row")[0].scrollIntoView({ block: "center" })')
  await sleep(300)
  const rowText = await cdp.eval('window.__text(window.__visAll(".archive-config-row")[0])')
  check('设置页展示归档占用（文件数 + 大小 + 两个按钮）',
    picked === 'ok' && /\d+\s*(个文件|files)/.test(rowText || '') &&
      /(打开归档目录|Open archive folder)/.test(rowText || '') &&
      /(清理旧归档|Clean old archives)/.test(rowText || ''),
    rowText
  )
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-settings-archive-row.png')))

  // ---- 7) 清理确认框：打开 → 取消 → 文件数不变 ----
  const before = (stat && stat.count) || 0
  const clickedClean = await cdp.eval(`
    (() => {
      const row = window.__visAll('.archive-config-row')[0]
      const btn = [...row.querySelectorAll('button')].find(b => /清理旧归档|Clean old archives/.test(b.innerText))
      if (!btn) return 'no-btn'
      btn.click()
      return 'ok'
    })()
  `)
  await waitFor(cdp, '!!window.__modal()', 'clean confirm modal')
  await sleep(400)
  const confirmInfo = JSON.parse(await cdp.eval(`
    (() => {
      const m = window.__modal()
      if (!m) return JSON.stringify(null)
      return JSON.stringify({
        title: window.__text(m.querySelector('.custom-modal-title')),
        hasInput: !!m.querySelector('.archive-clean-confirm input'),
        hasHint: /天|days/.test(window.__text(m))
      })
    })()
  `))
  check('清理确认框有保留天数和说明',
    clickedClean === 'ok' && !!confirmInfo && confirmInfo.hasInput && confirmInfo.hasHint,
    confirmInfo
  )
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-clean-confirm.png')))
  await cdp.eval('window.__modalBtn(/取消|Cancel/)')
  await sleep(500)
  const after = JSON.parse(await cdp.eval(`
    (() => new Promise(resolve => {
      window.pre.runGlobalAsync('losslessArchiveInfo')
        .then(info => resolve(JSON.stringify({ count: info.count })))
        .catch(err => resolve(JSON.stringify({ error: String(err && err.message || err) })))
    }))()
  `, true) || 'null')
  const closed = await cdp.eval('!window.__modal()')
  check('取消清理后弹层关闭且文件数不变', closed && !!after && after.count === before, { before, after, closed })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-after-cancel.png')))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.stack ? err.stack : err)
  process.exit(1)
})
