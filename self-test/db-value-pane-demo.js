#!/usr/bin/env node
/**
 * 单元格值预览面板（DbValuePane）高度链路 —— CDP 实机回归（无需真 MySQL）
 *
 * 背景：F1 把值面板包进 antd Tabs 时用了 antd5 的 .ant-tabs-content-holder，
 * 而当前 antd6 的层级是 body-holder > body > content → 撑满链断掉，
 * 面板退化为「内容高」：只读态看着正常，一点「编辑」textarea（flex 1 1 0 +
 * min-height 0）直接塌成 0 高。
 *
 * 本脚本在渲染层 IPC 边界注入桩 MySQL，真实走 db-session 的选表 → 选单元格 →
 * 编辑态，量真实布局高度：
 *   1) 有外键的表（值/关联双页签路径）：只读态面板撑满；编辑态 textarea 有高度
 *   2) 无外键的表（面板直挂 .db-split-pane-bottom）：编辑态同样有高度
 *   3) Redis string 键的父级（.db-redis-detail，block + overflow auto）：
 *      用同款 DOM 量一遍，防止 height 100% 只修好 MySQL 一侧
 *
 * 用法：
 *   1) npm run vite-build
 *   2) Xvfb :110 -nolisten tcp &
 *      DISPLAY=:110 HOME=/tmp/electerm-cdp-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9223 --no-sandbox
 *   3) node self-test/db-value-pane-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9223'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-value-pane-shots')

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
  // 桩 MySQL：users 带外键（触发值/关联双页签），plain 无外键（面板直挂分区）
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo_db',
          children: [
            { name: 'users', type: 'table' },
            { name: 'plain', type: 'table' }
          ]
        }])
      }
      if (op === 'describeTable') {
        // 主键列（Key=PRI）决定 canEditCell：没有它「编辑」按钮置灰
        return Promise.resolve([
          { Field: 'id', Type: 'int', Key: 'PRI', Null: 'NO' },
          { Field: 'auth', Type: 'varchar(255)', Key: '', Null: 'YES' }
        ])
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({
          columns: [
            { name: 'id', dataType: 'int', isPk: true },
            { name: 'auth', dataType: 'varchar' }
          ],
          foreignKeys: args.table === 'users'
            ? [{ name: 'fk_auth', columns: ['auth'], refTable: 'accounts', refColumns: ['auth'] }]
            : []
        })
      }
      if (op === 'getPageData') {
        return Promise.resolve({
          rows: [{
            id: 1,
            auth: '{"username":"admin","password":"b91fcb23c05f755c23d0e1f5a6b7c8d9e0f1a2b3c4d5e6f7"}'
          }],
          totalRows: 1,
          page: 1,
          hasMore: false
        })
      }
      if (op === 'getReferences') {
        return Promise.resolve({ references: [], degraded: false })
      }
      if (op === 'getDbTxState') {
        return Promise.resolve({ active: false, pendingCount: 0, statements: [], lastTx: null })
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
  window.__rect = sel => {
    const els = [...document.querySelectorAll(sel)].filter(window.__vis)
    if (!els.length) return null
    const r = els[els.length - 1].getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  window.__paneMetrics = () => JSON.stringify({
    tabs: window.__rect('.db-pane-tabs'),
    holder: window.__rect('.db-pane-tabs .ant-tabs-body-holder'),
    body: window.__rect('.db-pane-tabs .ant-tabs-body'),
    content: window.__rect('.db-pane-tabs .ant-tabs-content-active'),
    bottom: window.__rect('.db-split-pane-bottom'),
    pane: window.__rect('.db-value-pane'),
    pre: window.__rect('.db-value-pane-pre'),
    text: window.__rect('.db-value-pane-text')
  })
  window.__clickTree = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim() === text)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  window.__clickCell = col => {
    // antd6 表格默认走虚拟滚动：行/单元格是 div.ant-table-row > div.ant-table-cell，
    // 没有 <td>，aria-label 落在单元格 div 上
    const cell = [...document.querySelectorAll('.ant-table-row .ant-table-cell[aria-label="' + col + '"]')]
      .find(window.__vis)
    if (!cell) return 'no-cell'
    cell.click()
    return 'ok'
  }
  window.__clickEdit = () => {
    const head = [...document.querySelectorAll('.db-value-pane-head')].find(window.__vis)
    if (!head) return 'no-pane'
    // antd6 会给两字中文按钮自动插空格（「编 辑」），按 title 或去空格后的文本匹配
    const btn = [...head.querySelectorAll('button')].find(b =>
      /^(编辑|Edit)$/.test((b.getAttribute('title') || '').trim()) ||
      /^(编辑|Edit)$/.test(b.innerText.replace(/ /g, '').trim())
    )
    if (!btn) return 'no-edit-btn'
    btn.click()
    return 'ok'
  }
  // Redis string 键的真实父级：.db-redis-detail（block + overflow auto）而非 flex，
  // 值面板的确定高度只能靠自身的 height 100%，这里用同款 DOM 量一遍
  window.__redisParentMetrics = () => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-3000px;top:0;width:600px;height:420px;display:flex'
    host.innerHTML = '<div class="db-split-pane"><div class="db-split-pane-bottom" style="flex-basis:60%"><div class="db-redis-detail"><div class="db-value-pane"><div class="db-value-pane-head"><span class="db-grid-title">k</span></div><textarea class="db-value-pane-text"></textarea></div></div></div></div>'
    document.body.appendChild(host)
    const m = sel => Math.round(host.querySelector(sel).getBoundingClientRect().height)
    const out = {
      detail: m('.db-redis-detail'),
      pane: m('.db-value-pane'),
      text: m('.db-value-pane-text')
    }
    host.remove()
    return JSON.stringify(out)
  }
  window.__msgTexts = () =>
    [...document.querySelectorAll('.message-item, .ant-message-notice-content')]
      .map(el => el.innerText.trim())
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
  return JSON.stringify({ id: created ? created.id : null })
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

const metrics = async cdp => JSON.parse(await cdp.eval('window.__paneMetrics()'))

const openTable = async (cdp, table) => {
  await cdp.eval(`window.__clickTree(${JSON.stringify(table)})`)
  const ok = await waitFor(
    cdp,
    "!![...document.querySelectorAll('.db-grid-title')].find(window.__vis) && " +
      "!!document.querySelector('.ant-table-row .ant-table-cell[aria-label=\"auth\"]')",
    'grid rows for ' + table
  )
  return ok
}

const clickCellAndEdit = async (cdp) => {
  await cdp.eval('window.__clickCell("auth")')
  if (!await waitFor(cdp, '!!window.__rect(".db-value-pane")', 'value pane')) {
    return false
  }
  return true
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
  // 窗口不可见时 CSS 动画冻结、截图拿到旧帧
  await cdp.call('Page.bringToFront', {})
  await sleep(600)

  await cdp.eval(STUB)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  const treeReady = await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
  check('数据页树已渲染', treeReady)

  // 展开库节点
  await cdp.eval('window.__clickTree("demo_db")')
  const expanded = await waitFor(cdp, 'window.__clickTree("users") === "ok"', 'db expanded')

  // ---- 1) 有外键的表：值/关联双页签路径 ----
  const usersOk = expanded && await openTable(cdp, 'users')
  check('选中带外键的表', usersOk)
  check('选中单元格后出现值面板', await clickCellAndEdit(cdp))
  check('出现值/关联双页签', await waitFor(cdp, '!!window.__rect(".db-pane-tabs")', 'pane tabs'))
  const readM = await metrics(cdp)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-read-tabs.png')))
  check('只读态：面板撑满下方分区（不是内容高）',
    readM.pane && readM.content && readM.bottom &&
      readM.pane.h >= readM.content.h - 2 &&
      readM.holder.h >= readM.content.h - 2 &&
      readM.bottom.h - readM.holder.h < 60 &&
      readM.pane.h > 120,
    readM)

  const editRes = await cdp.eval('window.__clickEdit()')
  const editShown = await waitFor(cdp, '!!window.__rect(".db-value-pane-text")', 'edit textarea')
  const editM = await metrics(cdp)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-edit-tabs.png')))
  check('编辑态：textarea 有可用高度（修复前为 0）', editRes === 'ok' && editShown && editM.text && editM.text.h > 100, editM)
  check('编辑态：面板高度不塌（与只读态一致）',
    editM.pane && readM.pane && Math.abs(editM.pane.h - readM.pane.h) <= 2,
    { read: readM.pane, edit: editM.pane })
  check('编辑态：textarea 撑满面板剩余区', editM.text && editM.pane &&
    editM.text.h >= editM.pane.h - 40, { pane: editM.pane, text: editM.text })

  // ---- 2) 无外键的表：面板直挂分区路径 ----
  const plainOk = await openTable(cdp, 'plain')
  check('选中无外键的表（不出现页签）', plainOk && await waitFor(cdp, '!window.__rect(".db-pane-tabs")', 'no pane tabs'))
  await clickCellAndEdit(cdp)
  const plainEdit = await cdp.eval('window.__clickEdit()')
  const plainShown = await waitFor(cdp, '!!window.__rect(".db-value-pane-text")', 'plain edit textarea')
  const plainM = await metrics(cdp)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-edit-no-tabs.png')))
  check('直挂分区路径：编辑态 textarea 有可用高度',
    plainEdit === 'ok' && plainShown && plainM.text && plainM.text.h > 100, plainM)

  // ---- 3) Redis string 的真实父级（block + overflow auto） ----
  const redisM = JSON.parse(await cdp.eval('window.__redisParentMetrics()'))
  check('Redis 详情父级下：面板/textarea 同样撑满', redisM.text > 100 && redisM.pane > 120, redisM)

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  // ws 会挂住事件循环，跑完必须显式退出
  process.exit(fail.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
