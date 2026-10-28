#!/usr/bin/env node
/**
 * F2 手动事务（连接钉住 + 待提交清单）—— CDP 实机 UI 演示/回归（无需真 MySQL）
 *
 * 在渲染层 IPC 边界注入桩 MySQL（元数据 + 事务状态机），真实走 db-session 的
 * 工具条开关 / 待提交清单 / 提交回滚 / 关 tab 守卫。后端事务语义由
 * src/test/unit-ci/db-tx*.spec.js 覆盖（假时钟 + 假 adapter），这里只验 UI 接线：
 *   1) 工具条出现「自动提交」开关
 *   2) 打开开关 → 确认弹窗 → 确认后出现「待提交 N 条 / 提交 / 回滚」
 *   3) 待提交清单弹窗四列（时间/耗时/影响行数/语句），新语句在前
 *   4) 提交后开关复位、按钮收起
 *   5) 未提交时关 tab → 弹确认；取消则 tab 保留
 *   6) 空闲自动回滚 → 全局提示
 *
 * 用法：
 *   1) npm run vite-build
 *   2) DISPLAY=:0 HOME=/tmp/electerm-cdp-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9222 --no-sandbox
 *   3) node self-test/db-tx-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const locales = require('../src/app/common/locales-extra')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-tx-shots')

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
  window.__txCalls = []
  // 桩事务状态机：只模拟「主进程权威状态」的形状，不模拟 SQL 语义
  const st = {
    active: false,
    pendingCount: 0,
    statements: [],
    pinnedTabs: 0,
    maxTabs: 2,
    lastTx: null
  }
  window.__tx = st
  window.__txAddStmt = (sql, affected) => {
    st.statements.push({
      at: Date.now(),
      ms: 3,
      sql,
      affectedRows: affected
    })
    st.pendingCount += 1
    return st.pendingCount
  }
  window.__txExpire = () => {
    // 模拟主进程空闲超时回滚：状态先清空，lastTx 标 auto
    st.active = false
    st.statements = []
    st.pendingCount = 0
    st.pinnedTabs = 0
    st.lastTx = { reason: 'idle', auto: true, at: Date.now(), count: 2 }
    return 'expired'
  }
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      window.__txCalls.push(op)
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'demo_db', type: 'database', count: 0 }])
      }
      if (op === 'getDbTxState') {
        return Promise.resolve(JSON.parse(JSON.stringify(st)))
      }
      if (op === 'beginDbTx') {
        st.active = true
        st.pinnedTabs = 1
        st.statements = []
        st.pendingCount = 0
        st.lastTx = null
        return Promise.resolve({ ok: true, since: Date.now() })
      }
      if (op === 'commitDbTx' || op === 'rollbackDbTx') {
        const n = st.pendingCount
        st.active = false
        st.pinnedTabs = 0
        st.statements = []
        st.pendingCount = 0
        st.lastTx = { reason: op === 'commitDbTx' ? 'commit' : 'rollback', auto: false, at: Date.now(), count: n }
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') {
      return Promise.resolve(a[0] === 'list' ? [] : null)
    }
    if (name === 'openDbTab' || name === 'closeDbTab') {
      return Promise.resolve({ ok: true })
    }
    return Promise.resolve(null)
  }
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => !window.__hidden(el)
  window.__txBar = () => [...document.querySelectorAll('.db-tx-bar')].find(window.__vis) || null
  window.__txLabel = () => {
    const bar = window.__txBar()
    const el = bar && bar.querySelector('.db-tx-switch-label')
    return el ? el.innerText.trim() : ''
  }
  window.__txChecked = () => {
    const bar = window.__txBar()
    const el = bar && bar.querySelector('.ant-switch')
    return !!el && el.classList.contains('ant-switch-checked')
  }
  window.__txToggle = () => {
    const bar = window.__txBar()
    const el = bar && bar.querySelector('.ant-switch')
    if (!el) return 'no-switch'
    el.click()
    return 'ok'
  }
  window.__txBtn = cls => {
    const bar = window.__txBar()
    const btn = bar && bar.querySelector('.' + cls)
    if (!btn) return 'no-btn'
    btn.click()
    return 'ok'
  }
  window.__txPendingText = () => {
    const bar = window.__txBar()
    const el = bar && bar.querySelector('.db-tx-pending')
    return el ? el.innerText.trim() : ''
  }
  window.__modal = () => {
    const t = document.querySelector('.ant-modal-confirm-title')
    const c = document.querySelector('.ant-modal-confirm-content')
    const ok = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')
    return JSON.stringify({
      title: t ? t.innerText.trim() : '',
      content: c ? c.innerText.trim() : '',
      hasOk: !!ok
    })
  }
  window.__modalOk = () => {
    const ok = document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')
    if (!ok) return 'no-ok'
    ok.click()
    return 'ok'
  }
  window.__modalCancel = () => {
    const btns = [...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-default')]
    if (!btns.length) return 'no-cancel'
    btns[btns.length - 1].click()
    return 'ok'
  }
  window.__txListRows = () => {
    const box = [...document.querySelectorAll('.db-tx-list')].find(window.__vis)
    if (!box) return []
    return [...box.querySelectorAll('.db-tx-row')]
      .filter(r => !r.classList.contains('db-tx-row-head'))
      .map(r => [...r.children].map(c => c.innerText.trim()))
  }
  window.__txListHead = () => {
    const box = [...document.querySelectorAll('.db-tx-list')].find(window.__vis)
    const head = box && box.querySelector('.db-tx-row-head')
    return head ? [...head.children].map(c => c.innerText.trim()) : []
  }
  window.__closeListModal = () => {
    const btn = [...document.querySelectorAll('.ant-modal-close')].find(window.__vis)
    if (!btn) return 'no-close'
    btn.click()
    return 'ok'
  }
  window.__msgTexts = () =>
    [...document.querySelectorAll('.message-item, .ant-message-notice-content')]
      .map(el => el.innerText.trim())
  window.__closeTab = id => {
    const tab = document.querySelector('.tab[data-id="' + id + '"]')
    // 关闭点击挂在内层 svg 上（.tab-close 只是热区样式）
    const btn = tab && (tab.querySelector('.tab-close svg') || tab.querySelector('.tab-close'))
    if (!btn) return 'no-close'
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  return 'stub-installed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'mysql 127.0.0.1:3306',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'demo',
    dbPassword: '',
    dbName: 'demo_db',
    dbSsl: false,
    readOnly: false,
    production: false,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null, active: window.store.activeTabId })
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

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
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
    const ok = await cdp.eval(expr)
    if (ok) {
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

// 应用语言未知（zh-CN / en），断言取两套文案的并集
const loc = k => [locales.en[k], locales.zh_cn[k]].filter(Boolean)
const isOneOf = (text, key) => loc(key).indexOf(text) > -1

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => (t.type === 'page') && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  // 窗口不可见时 CSS 动画冻结（弹窗停在 opacity 0）、截图拿旧帧
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  await cdp.eval(STUB)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  const hasBar = await waitFor(cdp, '!!window.__txBar()', 'tx bar')
  check('数据页工具条出现事务开关', hasBar, { id: openRes.id })
  const labelAuto = await cdp.eval('window.__txLabel()')
  const checked0 = await cdp.eval('window.__txChecked()')
  check('初始为「自动提交」且开关关闭', isOneOf(labelAuto, 'dbTxAuto') && !checked0, { labelAuto, checked0 })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-auto.png')))

  // 开启手动事务：确认弹窗 → 确认
  await cdp.eval('window.__txToggle()')
  await waitFor(cdp, 'JSON.parse(window.__modal()).hasOk', 'begin confirm')
  const beginModal = JSON.parse(await cdp.eval('window.__modal()'))
  check('开启手动事务先弹确认', isOneOf(beginModal.title, 'dbTxBeginTitle'), beginModal)
  await sleep(450)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-begin-confirm.png')))
  await cdp.eval('window.__modalOk()')
  await waitFor(cdp, 'window.__txChecked() && !!window.__txPendingText()', 'tx active')
  const labelManual = await cdp.eval('window.__txLabel()')
  const pending0 = await cdp.eval('window.__txPendingText()')
  check('确认后进入手动事务：标签切换 + 待提交 0 条', isOneOf(labelManual, 'dbTxManual') && /0/.test(pending0), { labelManual, pending0 })

  // 桩里塞 3 条语句 → 轮询拉到 → 打开清单
  await cdp.eval("window.__txAddStmt('UPDATE users SET name = ? WHERE id = ?', 1)")
  await cdp.eval("window.__txAddStmt('DELETE FROM logs WHERE at < ?', 42)")
  await cdp.eval("window.__txAddStmt('SELECT 1', undefined)")
  await waitFor(cdp, '/3/.test(window.__txPendingText())', 'pending 3', 8000)
  const pending3 = await cdp.eval('window.__txPendingText()')
  await cdp.eval('window.__txBtn("db-tx-pending")')
  const listShown = await waitFor(cdp, 'window.__txListRows().length === 3', 'tx list rows')
  const head = JSON.parse(await cdp.eval('JSON.stringify(window.__txListHead())'))
  const rows = JSON.parse(await cdp.eval('JSON.stringify(window.__txListRows())'))
  check('待提交 N 条随轮询更新', /3/.test(pending3), { pending3 })
  check('待提交清单四列（时间/耗时/影响行数/语句）', listShown && head.length === 4, { head })
  check('清单新语句在前、影响行数透出', rows.length === 3 && rows[0][3].indexOf('SELECT 1') === 0 && rows[1][2] === '42', {
    first: rows[0],
    second: rows[1]
  })
  await sleep(450)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-statements.png')))
  await cdp.eval('window.__closeListModal()')
  await sleep(400)

  // 提交：开关复位、按钮收起
  await cdp.eval('window.__txBtn("db-tx-commit")')
  await waitFor(cdp, '!window.__txChecked()', 'committed')
  const calls = JSON.parse(await cdp.eval('JSON.stringify(window.__txCalls)'))
  check('提交后回到自动提交（commitDbTx 已下发）', calls.indexOf('commitDbTx') > -1, { calls })

  // 再开一次：未提交关 tab → 确认；取消则保留
  await waitFor(cdp, '!JSON.parse(window.__modal()).hasOk', 'prev modal gone')
  await cdp.eval('window.__txToggle()')
  await waitFor(cdp, 'JSON.parse(window.__modal()).hasOk', 'begin confirm 2')
  await cdp.eval('window.__modalOk()')
  await waitFor(cdp, '!JSON.parse(window.__modal()).hasOk', 'begin modal gone 2')
  await waitFor(cdp, 'window.__txChecked()', 'tx active 2')
  await cdp.eval("window.__txAddStmt('UPDATE t SET a = 1', 1)")
  await waitFor(cdp, '/1/.test(window.__txPendingText())', 'pending 1', 8000)
  await cdp.eval(`window.__closeTab(${JSON.stringify(openRes.id)})`)
  await waitFor(cdp, loc('dbTxCloseTitle').map(t => `JSON.parse(window.__modal()).title === ${JSON.stringify(t)}`).join(' || '), 'close confirm')
  const closeModal = JSON.parse(await cdp.eval('window.__modal()'))
  check('未提交关 tab 先弹确认（文案含未提交语义）', isOneOf(closeModal.title, 'dbTxCloseTitle'), closeModal)
  await sleep(450)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-close-confirm.png')))
  await cdp.eval('window.__modalCancel()')
  await waitFor(cdp, '!JSON.parse(window.__modal()).hasOk', 'close modal gone')
  await sleep(300)
  const tabStill = await cdp.eval(`!!window.store.tabs.find(t => t.id === ${JSON.stringify(openRes.id)})`)
  check('取消关 tab 后标签保留', tabStill)

  // 回滚收口 → 空闲自动回滚提示
  await cdp.eval('window.__txBtn("db-tx-rollback")')
  await waitFor(cdp, loc('dbTxRollbackTitle').map(t => `JSON.parse(window.__modal()).title === ${JSON.stringify(t)}`).join(' || '), 'rollback confirm')
  const rollbackModal = JSON.parse(await cdp.eval('window.__modal()'))
  check('有待提交时点回滚先弹确认', isOneOf(rollbackModal.title, 'dbTxRollbackTitle'), rollbackModal)
  await cdp.eval('window.__modalOk()')
  await waitFor(cdp, '!JSON.parse(window.__modal()).hasOk', 'rollback modal gone')
  await waitFor(cdp, '!window.__txChecked()', 'rolled back')

  await cdp.eval('window.__txToggle()')
  await waitFor(cdp, loc('dbTxBeginTitle').map(t => `JSON.parse(window.__modal()).title === ${JSON.stringify(t)}`).join(' || '), 'begin confirm 3')
  await cdp.eval('window.__modalOk()')
  await waitFor(cdp, '!JSON.parse(window.__modal()).hasOk', 'begin modal gone 3')
  await waitFor(cdp, 'window.__txChecked()', 'tx active 3')
  await cdp.eval('window.__txExpire()')
  const gotMsg = await waitFor(
    cdp,
    `window.__msgTexts().some(t => ${JSON.stringify(loc('dbTxAutoRolledBack').map(s => s.split('{n}')[0]))}.some(k => t.indexOf(k) > -1))`,
    'auto rollback notice',
    9000
  )
  const msgs = JSON.parse(await cdp.eval('JSON.stringify(window.__msgTexts())'))
  check('空闲自动回滚会弹全局提示', gotMsg, { msgs })
  await sleep(450)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-auto-rollback.png')))

  const fail = results.filter(r => !r.ok)
  console.log('\\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  // ws 会挂住事件循环，跑完必须显式退出
  process.exit(fail.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
