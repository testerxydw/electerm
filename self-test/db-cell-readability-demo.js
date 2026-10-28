#!/usr/bin/env node
/**
 * H1a-1 · 网格可读性统一层 —— CDP 实机回归（桩数据，无需真 MySQL/Redis）
 *
 * 要证明的是"落地效果"，不是"代码写了"：
 *   1) 5 处网格（数据页 / 表结构页 / SQL 结果 / Redis 键列表 / Redis 详情）
 *      截断单元格悬停真的出预览卡；
 *   2) 没被截断的格子不弹（否则鼠标扫过整表就是洪泛）；
 *   3) 预览卡是单例：DOM 里永远只有 1 个锚点，不随行数/格数增长；
 *   4) 复制拿到的是全文（不是 4000 字符裁剪后的预览）；>4000 出截断提示；
 *   5) 关闭时机：指针移开（缓冲后）、滚动、Esc；
 *   6) 不改数据链路：单击开值面板、双击行内编辑、编辑框 Esc 退出都仍在。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) Xvfb :112 -nolisten tcp &
 *      DISPLAY=:112 HOME=/tmp/electerm-cdp-home2 ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox
 *   3) node self-test/db-cell-readability-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-cell-readability-shots')

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

// 夹具。长内容前缀各 12 字符且互不相同，方便按可见文本反查单元格
const FIXTURE = `
(() => {
  const F = window.__fixture = {
    longD: 'D'.repeat(5000),
    longQ: 'Q'.repeat(6000),
    longC: 'C'.repeat(900),
    longP: 'P'.repeat(6500),
    param: { uid: 1001, action: 'order.export', trace: 't'.repeat(600) },
    // 键名要长到"固定布局分给它的剩余宽度也装不下"才会截断：158 字符在 1600 宽
    // 窗口下实测 sw===cw（正好装得下），拿它验截断分支就是假阴性
    key: 'session:user:1001:' + 'x'.repeat(420)
  }
  F.paramText = JSON.stringify(F.param)
  window.__dbStubCalls = []
  window.__copied = null
  // copy() 最终走 window.pre.writeClipboard：截下来才能验证"复制的是全文"
  try {
    window.pre.writeClipboard = s => { window.__copied = s }
    window.__copySpied = true
  } catch (e) {
    window.__copySpied = 'blocked:' + e.message
  }
  const real = window.pre.runGlobalAsync.bind(window.pre)
  window.realRunGlobalAsync = real
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
      if (name === 'openDbTab' || name === 'closeDbTab') return Promise.resolve({ ok: true })
      return Promise.resolve(null)
    }
    const tabId = a[0]
    const op = a[1]
    const args = a[2] || {}
    const tab = (window.store.tabs || []).find(t => t.id === tabId) || {}
    const isRedis = tab.dbType === 'redis'
    window.__dbStubCalls.push(op + (isRedis ? ':redis' : ''))
    if (isRedis) {
      if (op === 'getMetadata') {
        return Promise.resolve([
          { name: 'db0', type: 'database', count: 2 },
          { name: 'db1', type: 'database', count: 0 }
        ])
      }
      if (op === 'getPageData' || op === 'scanKeysToPage') {
        return Promise.resolve({
          rows: [
            { name: F.key, type: 'hash', ttl: -1 },
            { name: 'k1', type: 'string', ttl: 100 }
          ],
          cursors: ['0'], nextCursor: '0', hasMore: false, pageIndex: 0
        })
      }
      if (op === 'getKeyDetail') {
        return Promise.resolve({
          type: 'hash',
          value: null,
          fields: ['payload', 'note'],
          rows: { payload: F.longP, note: 'short' },
          ttl: -1,
          nextCursor: '0',
          total: 2
        })
      }
      return Promise.resolve(null)
    }
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [{ name: 'operation_log', type: 'table' }]
      }])
    }
    if (op === 'describeTable') {
      return Promise.resolve([
        { Field: 'id', Type: 'bigint', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment', Comment: F.longC },
        { Field: 'flag', Type: 'varchar(8)', Null: 'YES', Key: '', Default: 'ok', Extra: '', Comment: '短' }
      ])
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: [
          { name: 'id', dataType: 'bigint', isPk: true },
          { name: 'flag', dataType: 'varchar' },
          { name: 'note', dataType: 'text' },
          { name: 'detail', dataType: 'text' },
          { name: 'parameter', dataType: 'json' }
        ],
        foreignKeys: []
      })
    }
    if (op === 'getPageData') {
      // 行数要够多，表体才真的可滚动 —— 只有 2 行时 wheel 不产生 scroll 事件，
      // "滚动关闭卡片"就无从验证（也顺便让虚拟渲染/列宽采样走真实规模）
      const rows = [
        { id: 1, flag: 'ok', note: null, detail: F.longD, parameter: F.param },
        { id: 2, flag: 'no', note: 'n2', detail: 'short one', parameter: { uid: 1002 } }
      ]
      for (let i = 3; i <= 30; i++) {
        rows.push({ id: i, flag: i % 2 ? 'ok' : 'no', note: 'n' + i, detail: 'd' + i, parameter: { uid: 3000 + i } })
      }
      return Promise.resolve({ rows, totalRows: rows.length, page: 1, hasMore: false })
    }
    if (op === 'countRows') return Promise.resolve({ count: 30 })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'executeSql') {
      return Promise.resolve({
        results: [{
          sql: args.sql,
          fields: ['id', 'flag', 'big_text'],
          rows: [
            { id: 1, flag: 'ok', big_text: F.longQ },
            { id: 2, flag: 'no', big_text: 'tiny' }
          ]
        }]
      })
    }
    return Promise.resolve(null)
  }
  return 'stub-installed'
})()
`

const HELPERS = `
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
  // 当前会话根节点：多开数据库页签时非激活的那份 DOM 还在（display:none），
  // 预览卡是"每会话一个实例"，所以单例/归属判断都以可见的会话根为准
  window.__sessionRoot = () => [...document.querySelectorAll('.db-session')]
    .find(window.__vis) || document
  // 诊断：卡片关不掉时，先分清"指针离开的事件根本没来"还是"事件来了但 state 没清"
  window.__evlog = []
  window.__ev = tag => {
    if (window.__evlog.length < 60) window.__evlog.push(tag)
  }
  document.addEventListener('mouseout', ev => {
    const cell = ev.target && ev.target.closest ? ev.target.closest('.ant-table-cell') : null
    const card = ev.target && ev.target.closest ? ev.target.closest('.db-cell-preview') : null
    if (cell) {
      window.__ev('cell-out rel=' + (ev.relatedTarget ? (ev.relatedTarget.className || ev.relatedTarget.tagName) : 'null'))
    } else if (card) {
      window.__ev('card-out rel=' + (ev.relatedTarget ? (ev.relatedTarget.className || ev.relatedTarget.tagName) : 'null'))
    }
  }, true)
  document.addEventListener('mouseover', ev => {
    const cell = ev.target && ev.target.closest ? ev.target.closest('.ant-table-cell') : null
    const card = ev.target && ev.target.closest ? ev.target.closest('.db-cell-preview') : null
    if (cell) {
      window.__ev('cell-in ' + cell.innerText.trim().substring(0, 6))
    } else if (card) {
      window.__ev('card-in')
    }
  }, true)
  window.__clickTree = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim().indexOf(text) >= 0)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  // 按单元格可见文本前缀反查（与界面语言无关；长内容前缀在夹具里唯一）
  window.__cellOf = prefix => {
    const p = prefix.substring(0, 12)
    const all = [...document.querySelectorAll('.ant-table-cell')].filter(window.__vis)
    return all.find(c => c.innerText.trim().substring(0, 12) === p) || null
  }
  window.__cellInfo = prefix => {
    const c = window.__cellOf(prefix)
    if (!c) return JSON.stringify({ error: 'no-cell:' + prefix })
    const r = c.getBoundingClientRect()
    return JSON.stringify({
      sw: Math.round(c.scrollWidth),
      cw: Math.round(c.clientWidth),
      truncated: c.scrollWidth > c.clientWidth,
      title: c.getAttribute('title'),
      x: Math.round(r.left + Math.min(r.width, 30) / 2),
      y: Math.round(r.top + r.height / 2),
      textLen: c.innerText.trim().length
    })
  }
  window.__cards = () => [...document.querySelectorAll('.db-cell-preview')].filter(window.__vis)
  // 锚点按"可见"计数：多开一个数据库页签就多一个 DbCellPreview 实例（每个会话
  // 一张卡），非激活页签的锚点在 display:none 的 pane 里。单例契约说的是
  // "当前会话内不随行数/格数增长"，所以必须只看可见的那个。
  window.__anchors = () => [...window.__sessionRoot().querySelectorAll('.db-cell-preview-anchor')].filter(window.__vis).length
  // 锚点的内联 left 直接来自 state（state ? x : -1）：用它区分"state 没清"
  // 和"state 清了但浮层没收"——后者是 antd 动画/portal 的问题，前者才是逻辑问题
  window.__anchorLeft = () => {
    const a = [...window.__sessionRoot().querySelectorAll('.db-cell-preview-anchor')].find(window.__vis)
    return a ? a.style.left : 'no-anchor'
  }
  window.__popCls = () => {
    const card = window.__cards()[0]
    const pop = card && card.closest ? card.closest('.ant-popover') : null
    return pop ? pop.className + ' | display=' + getComputedStyle(pop).display : 'no-popover'
  }
  // 值面板没开时的分层判据：是"根本没渲染"（点击没生效 / rowKey 找不到行）、
  // 还是"渲染了但不可见"（分屏被压扁）—— 两种修法完全不同
  window.__paneDiag = () => {
    const bottom = [...document.querySelectorAll('.db-split-pane-bottom')].find(window.__vis)
    const r = bottom ? bottom.getBoundingClientRect() : null
    return JSON.stringify({
      valuePanes: document.querySelectorAll('.db-value-pane').length,
      valuePaneVis: [...document.querySelectorAll('.db-value-pane')].filter(window.__vis).length,
      emptyVis: [...document.querySelectorAll('.db-pane-empty')].filter(window.__vis).length,
      paneTabsVis: [...document.querySelectorAll('.db-pane-tabs')].filter(window.__vis).length,
      bottomRect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : 'none',
      editor: document.querySelectorAll('.db-cell-editor').length
    })
  }
  window.__cardInfo = () => {
    const card = window.__cards()[0]
    if (!card) {
      return JSON.stringify({
        open: 0,
        anchors: window.__anchors(),
        anchorLeft: window.__anchorLeft(),
        popovers: document.querySelectorAll('.ant-popover').length
      })
    }
    const pre = card.querySelector('.db-cell-preview-pre')
    const txt = pre ? pre.innerText : ''
    return JSON.stringify({
      open: window.__cards().length,
      anchors: window.__anchors(),
      anchorLeft: window.__anchorLeft(),
      pop: window.__popCls(),
      col: (card.querySelector('.db-cell-preview-col') || {}).innerText,
      meta: (card.querySelector('.db-cell-preview-meta') || {}).innerText,
      bodyLen: txt.trim().length,
      head: txt.trim().substring(0, 12),
      hasMore: !!card.querySelector('.db-cell-preview-more'),
      // 卡内正文的实际排版宽度：预览 <pre> 是 pre-wrap，宽度不够就换行而不是
      // 横向溢出，所以 sw===cw，不能用它判断"有没有被截"
      bodyW: pre ? Math.round(pre.clientWidth) : 0,
      copyable: !!window.__copySpied
    })
  }
  // "看得见"的判据，不是"在不在 DOM"：rc-trigger 定位前把浮层停在
  // inset: -1000vh/-1000vw（useOffsetStyle.js），只要 isVisible(锚点) 判假就永远
  // 停在那儿 —— DOM 有卡、文本对、opacity 1，屏幕上一个像素都没有。所以必须
  // 量真实矩形在不在视口内，并用 elementFromPoint 确认那个位置画的确实是卡片。
  window.__cardOnScreen = () => {
    const card = window.__cards()[0]
    if (!card) {
      return JSON.stringify({ onScreen: false, why: 'no-card' })
    }
    const pop = card.closest('.ant-popover')
    const anchor = [...window.__sessionRoot().querySelectorAll('.db-cell-preview-anchor')].find(window.__vis)
    const ar = anchor ? anchor.getBoundingClientRect() : null
    const r = card.getBoundingClientRect()
    const cx = Math.round(r.left + Math.min(r.width, 30) / 2)
    const cy = Math.round(r.top + Math.min(r.height, 30) / 2)
    const hit = document.elementFromPoint(cx, cy)
    return JSON.stringify({
      inViewport: r.width > 0 && r.height > 0 &&
        r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      hitIsCard: !!hit && card.contains(hit),
      onScreen: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && !!hit && card.contains(hit),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      // 锚点尺寸单独回传：0×0 是"卡看不见"的根因（fixed 元素 offsetParent 恒 null，
      // isVisible 只剩宽或高非零这一条活路），要能在失败时一眼看到
      anchorVisible: !!ar && ar.width > 0 && ar.height > 0,
      anchorRect: ar ? { w: Math.round(ar.width), h: Math.round(ar.height) } : null,
      popInset: pop ? pop.style.inset || 'css' : 'no-pop',
      hit: hit ? hit.tagName + '.' + String(hit.className).substring(0, 30) : 'none',
      viewport: { w: innerWidth, h: innerHeight }
    })
  }
  window.__clickCopy = () => {
    const card = window.__cards()[0]
    if (!card) return 'no-card'
    const btn = [...card.querySelectorAll('button')].find(b =>
      /复制|copy/i.test((b.getAttribute('title') || '') + ' ' + b.innerText))
    if (!btn) return 'no-copy-btn'
    btn.click()
    return 'ok'
  }
  // 注意两点：1) 这里是模板字符串里的源码，正则里的反斜杠要写两层，少写一层就
  // 退化成"匹配反斜杠加字母 s"，按钮文字永远对不上；2) antd 会给两字中文按钮
  // 自动插空格（"执 行"），必须先去空白再匹配。
  // 3) 语言不固定（这台机器是 zh_cn，别的环境可能是 en_us），按钮文案两种都要认，
  //    所以这里按"文本"找而不是按 key 找
  window.__clickTab = re => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')]
      .filter(window.__vis)
      .find(x => new RegExp(re).test(x.innerText.replace(/\\s/g, '')))
    if (!t) {
      return 'no-tab:' + re + ' visible=' + JSON.stringify(
        [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).map(x => x.innerText.trim())
      )
    }
    t.click()
    return 'ok'
  }
  window.__typeSql = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return 'no-editor'
    ed.focus()
    return document.activeElement === ed ? 'focused' : 'not-focused'
  }
  window.__clickRunSql = () => {
    const bars = [...document.querySelectorAll('.db-sql-bar')].filter(window.__vis)
    if (!bars.length) {
      return 'no-bar(sqlArea=' + document.querySelectorAll('.db-sql-area').length +
        ',cm=' + document.querySelectorAll('.cm-content').length + ')'
    }
    const b = [...bars[0].querySelectorAll('button')].find(x =>
      /^(执行|runsql|run)$/i.test(x.innerText.replace(/\\s/g, '')))
    if (!b) {
      return 'no-run-btn:' + JSON.stringify([...bars[0].querySelectorAll('button')].map(x => x.innerText.trim()))
    }
    b.click()
    return 'ok'
  }
  window.__clickRedisKey = () => {
    const cell = window.__cellOf('session:user')
    if (!cell) return 'no-key-row'
    const row = cell.closest('.ant-table-row') || cell
    row.click()
    return 'ok'
  }
  // 把目标格滚回可视区。虚拟网格被回收时目标 td 根本不在 DOM 里，所以
  // 找不到单元格就退回到"把会话区所有可滚容器拉到顶"，并把走了哪条路返回出来
  // —— 返回 no-scroller 说明判据本身失效了，不能当成"已经滚到顶"。
  window.__scrollTop = prefix => {
    const cell = window.__cellOf(prefix)
    if (cell) {
      cell.scrollIntoView({ block: 'center' })
      return 'into-view'
    }
    const scrollers = [...window.__sessionRoot().querySelectorAll('*')].filter(el => {
      const s = getComputedStyle(el)
      return /(auto|scroll|hidden)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4
    })
    scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)
    scrollers.forEach(el => { el.scrollTop = 0 })
    return scrollers.length ? 'top:' + scrollers.length : 'no-scroller'
  }
  window.__domCount = sel => document.querySelectorAll(sel).length
  return 'helpers-installed'
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
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  // 真·指针事件：React 的合成 onMouseEnter 只认浏览器派发的 mouseover/mouseout
  async move (x, y) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  }

  // button 必须显式给 'left'：CDP 的默认值是 "none"，按下/抬起不带按键时浏览器
  // 不会合成 click/dblclick，React 的 onClick 一次都不会触发（探针实测：补上
  // button 后同一坐标的 DOM 点击与真鼠标点击结果一致）
  // 双击要按 clickCount 1→2 各发一对按下/抬起，只发一对 clickCount=2 不算 dblclick
  async click (x, y, clickCount = 1) {
    for (let n = 1; n <= clickCount; n++) {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n
      })
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n
      })
    }
  }

  async wheel (x, y, deltaY) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
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

const waitFor = async (cdp, expr, label, timeout = 12000) => {
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
const cardInfo = async cdp => JSON.parse(await cdp.eval('window.__cardInfo()'))
const cellInfo = async (cdp, prefix) => JSON.parse(await cdp.eval('window.__cellInfo(' + JSON.stringify(prefix) + ')'))

// 悬停一个"必然截断"的格子 → 出卡；再悬停一个短格子 → 不出卡
const hoverCase = async (cdp, label, longPrefix, shortPrefix, opts = {}) => {
  await cdp.eval('window.__copied = null')
  const cell = await cellInfo(cdp, longPrefix)
  check(label + '：长内容单元格确实被截断', !cell.error && cell.truncated, cell)
  if (cell.error) {
    return
  }
  // 原生 title 已刻意不设（每格序列化 + 与预览卡叠两层 tooltip）
  check(label + '：单元格没有原生 title 属性', cell.title === null, { title: cell.title })
  await cdp.move(cell.x, cell.y)
  await sleep(220)
  const card = await cardInfo(cdp)
  check(label + '：悬停出预览卡', card.open === 1, card)
  // DOM 里有卡 ≠ 看得见：必须真的画在视口里（见 __cardOnScreen 注释）
  const onScreen = JSON.parse(await cdp.eval('window.__cardOnScreen()'))
  check(label + '：卡片真的画在视口内且指针命中（不是 -1000vw 待定位）', onScreen.onScreen === true, onScreen)
  check(label + '：锚点非 0 尺寸（rc-trigger isVisible 判据）', onScreen.anchorVisible === true, onScreen)
  check(label + '：锚点单例（DOM 恒 1 个）', card.anchors === 1, { anchors: card.anchors })
  check(label + '：卡内正文与单元格内容同源', card.head === longPrefix.substring(0, 12), { head: card.head })
  if (opts.fullLen) {
    check(label + '：预览渲染全文 ' + opts.fullLen + ' 字符（未触发裁剪）',
      card.bodyLen === opts.fullLen && card.hasMore === false,
      { bodyLen: card.bodyLen, hasMore: card.hasMore })
  }
  if (opts.clipOver) {
    check(label + '：超 4000 只渲染前缀并给截断提示',
      card.bodyLen >= 4000 && card.bodyLen <= 4100 && card.hasMore === true,
      { bodyLen: card.bodyLen, hasMore: card.hasMore })
  }
  if (opts.metaLen) {
    check(label + '：字符数标注用全文长度而非预览长度',
      String(card.meta || '').indexOf(String(opts.metaLen)) >= 0, card.meta)
    // 词条没落地时这里会露出 DbCellChars / undefined，肉眼在截图里也难发现
    check(label + '：字符数标注是翻译后的文案（不是裸 key）',
      !/DbCellChars|undefined/i.test(String(card.meta || '')), card.meta)
  }
  if (opts.shot) {
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, opts.shot)))
  }
  if (opts.copyLen) {
    const c = await cdp.eval('window.__clickCopy()')
    await sleep(120)
    const copied = await cdp.eval('(window.__copied || "").length')
    check(label + '：复制得到完整 ' + opts.copyLen + ' 字符', c === 'ok' && copied === opts.copyLen, { click: c, copied })
  }
  await cdp.eval('window.__evlog = []')
  await cdp.move(5, 5)
  // 关闭要经历"200ms 缓冲 + antd 关闭动画（约 200ms）"，所以断言"最终会关"并记下
  // 实际耗时：掐固定 sleep 会把正常关闭判成失败（第一轮 340ms 全红就是这个坑）
  const t0 = Date.now()
  const gone = await waitFor(cdp, 'window.__cards().length === 0', 'card close after leave', 2000)
  check(label + '：指针移开后卡片关闭（缓冲 + 关闭动画）', gone,
    { ms: Date.now() - t0, evlog: JSON.parse(await cdp.eval('JSON.stringify(window.__evlog)')) })
  if (shortPrefix) {
    const short = await cellInfo(cdp, shortPrefix)
    if (short.error) {
      check(label + '：短内容单元格存在', false, short)
      return
    }
    check(label + '：短内容单元格没被截断', short.truncated === false, short)
    await cdp.move(short.x, short.y)
    await sleep(220)
    check(label + '：未截断的格子不弹卡（防悬停洪泛）', (await cardInfo(cdp)).open === 0)
    await cdp.move(5, 5)
    await sleep(340)
  }
}

const openTab = (cfg) => `
  (() => {
    window.store.addTab(${JSON.stringify(cfg)})
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()
`

const MYSQL_TAB = {
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
  batch: null
}

const REDIS_TAB = {
  type: 'database',
  from: 'quick-connect',
  title: 'redis 127.0.0.1:6379',
  dbType: 'redis',
  dbHost: '127.0.0.1',
  dbPort: 6379,
  dbPassword: '',
  dbSsl: false,
  readOnly: false,
  production: false,
  batch: null
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
  await cdp.call('Runtime.enable')
  // 窗口不可见时 CSS 动画冻结、截图拿到旧帧
  await cdp.call('Page.bringToFront', {})
  await sleep(800)

  await cdp.eval(FIXTURE)
  await cdp.eval(HELPERS)
  check('复制调用已劫持（能验全文复制）', await cdp.eval('window.__copySpied === true'),
    await cdp.eval('String(window.__copySpied)'))

  // ---------- MySQL 会话 ----------
  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  const mysqlId = await cdp.eval(openTab(MYSQL_TAB))
  check('MySQL 页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  await cdp.eval('window.__clickTree("demo_db")')
  check('树里展开并选中数据表',
    await cdp.eval('window.__clickTree("operation_log")') === 'ok' &&
      await waitFor(cdp, '!!window.__cellOf("DDDDDDDDDDDD")', 'data grid long cell'),
    { mysqlId })

  // 1) 数据页：5000 字符 text 列（>4000 → 预览裁剪 + 复制全文）
  await hoverCase(cdp, '数据页 detail(5000)', 'DDDDDDDDDDDD', 'short one', {
    copyLen: 5000, metaLen: 5000, clipOver: true, shot: '1-data-long-text-dark.png'
  })

  // 2) 数据页：JSON 列（网格里只显示 200 字符前缀，卡片给全）
  const paramLen = await cdp.eval('window.__fixture.paramText.length')
  await hoverCase(cdp, '数据页 parameter(JSON)', '{"uid":1001,', 'ok', {
    copyLen: paramLen, metaLen: paramLen, shot: '2-data-json-dark.png'
  })

  // 关闭时机：滚动 / Esc
  const jsonCell = await cellInfo(cdp, '{"uid":1001,')
  await cdp.move(jsonCell.x, jsonCell.y)
  await sleep(200)
  check('重新悬停能再次开卡', (await cardInfo(cdp)).open === 1)
  await cdp.wheel(jsonCell.x, jsonCell.y + 4, 120)
  check('滚动时卡片立即关闭（不会停在原地指向别的格）',
    await waitFor(cdp, 'window.__cards().length === 0', 'card close on scroll', 1500))
  // 滚回原处：虚拟滚动只渲染视口内的行，滚下去之后目标行已经不在 DOM 里，
  // 按老坐标悬停/点击会打在别的行上。反向前滚同样量，比找滚动容器的类名稳
  // （antd6 虚拟表的容器类名不在产物里，靠类名反查是猜）
  await cdp.wheel(jsonCell.x, jsonCell.y + 4, -120)
  await sleep(300)
  const jsonCell2 = await cellInfo(cdp, '{"uid":1001,')
  check('滚回顶部后目标单元格重新可见', !jsonCell2.error && jsonCell2.truncated, jsonCell2)
  await cdp.move(jsonCell2.x, jsonCell2.y)
  await sleep(250)
  check('再次开卡（Esc 前置条件）', (await cardInfo(cdp)).open === 1)
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  check('Esc 关闭卡片',
    await waitFor(cdp, 'window.__cards().length === 0', 'card close on Esc', 1500))

  // 切页签：指针没动 → 不会有 mouseout，只有"源格消失"的兜底能抓到。
  // 少了这条，卡片会带着上一个页签的内容浮在新页签上（portal 不在被隐藏的 pane 里）
  // 先移开再移回来：指针一直在同一格上不会重新派发 mouseover，React 也就不会
  // 再触发 onMouseEnter，前置条件会假失败（后面那条也跟着假通过）
  await cdp.move(5, 5)
  await sleep(300)
  await cdp.move(jsonCell2.x, jsonCell2.y)
  await sleep(250)
  const preSwitch = await cardInfo(cdp)
  check('切页签前卡片是开着的（前置）', preSwitch.open === 1, preSwitch)
  const toStruct = await cdp.eval('window.__clickTab("表结构|Structure")')
  check('切页签后卡片自动关闭（display:none 走 ResizeObserver 兜底）',
    preSwitch.open === 1 && toStruct === 'ok' &&
      await waitFor(cdp, 'window.__cards().length === 0', 'card close on pane hide', 1500),
    { toStruct, diag: JSON.parse(await cdp.eval('window.__cardInfo()')) })

  // 3) 表结构页：长注释列
  check('切到表结构页签', await cdp.eval('window.__clickTab("表结构|Structure")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("CCCCCCCCCCCC")', 'struct long comment cell'))
  await hoverCase(cdp, '表结构 Comment(900)', 'CCCCCCCCCCCC', null, {
    copyLen: 900, fullLen: 900, shot: '3-structure-dark.png'
  })

  // 4) SQL 结果页：6000 字符结果
  check('切到 SQL 页签', await cdp.eval('window.__clickTab("^SQL$")') === 'ok' &&
    await waitFor(cdp, '!!document.querySelector(".db-sql-area .cm-content")', 'sql editor'))
  check('SQL 编辑器可用', await cdp.eval('window.__typeSql()') === 'focused')
  await cdp.call('Input.insertText', { text: 'select id, flag, big_text from operation_log' })
  await sleep(200)
  const runClicked = await cdp.eval('window.__clickRunSql()')
  check('点击执行按钮', runClicked === 'ok', runClicked)
  check('SQL 结果网格出长单元格', await waitFor(cdp, '!!window.__cellOf("QQQQQQQQQQQQ")', 'sql long cell'))
  await hoverCase(cdp, 'SQL 结果 big_text(6000)', 'QQQQQQQQQQQQ', 'tiny', {
    copyLen: 6000, metaLen: 6000, clipOver: true, shot: '4-sql-result-dark.png'
  })

  // 5) 数据链路回归：单击开值面板、双击进编辑、Esc 退出
  const backToData = await cdp.eval('window.__clickTab("数据|Data")')
  const scrolled = await cdp.eval('window.__scrollTop("short one")')
  await sleep(250)
  const noteCell = await cellInfo(cdp, 'short one')
  check('切回数据页并能定位短内容单元格', backToData === 'ok' && !noteCell.error,
    { backToData, scrolled, noteCell })
  if (!noteCell.error) {
    await cdp.move(noteCell.x, noteCell.y)
    await sleep(150)
    await cdp.click(noteCell.x, noteCell.y)
    const paneAfterClick = await waitFor(cdp,
      '!![...document.querySelectorAll(".db-value-pane")].find(window.__vis)', 'value pane')
    check('单击单元格仍能打开值面板（预览卡没抢事件）', paneAfterClick,
      JSON.parse(await cdp.eval('window.__paneDiag()')))
    await cdp.click(noteCell.x, noteCell.y, 2)
    const edited = await waitFor(cdp, '!!document.querySelector(".db-cell-editor")', 'inline editor')
    check('双击单元格仍进入行内编辑', edited, JSON.parse(await cdp.eval('window.__paneDiag()')))
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-inline-edit-dark.png')))
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
    check('Esc 退出编辑', await cdp.eval('!document.querySelector(".db-cell-editor")'))
  }

  // 6) 洪泛检查：指针扫过多格，锚点数不变
  await cdp.move(noteCell.x, noteCell.y)
  await sleep(150)
  const sweep = JSON.parse(await cdp.eval(`
    (() => {
      const cells = [...document.querySelectorAll('.ant-table-cell')].filter(window.__vis).slice(0, 40)
      cells.forEach(c => c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      return JSON.stringify({
        visited: cells.length,
        anchors: window.__anchors(),
        cards: window.__cards().length
      })
    })()
  `))
  check('扫过 40 格后 DOM 仍只有 1 个锚点（单例不随格数增长）', sweep.anchors === 1, sweep)
  await cdp.move(5, 5)
  check('移开后没有残留卡片',
    await waitFor(cdp, 'window.__cards().length === 0', 'no residual card', 1500),
    await cdp.eval('JSON.stringify({ anchors: window.__anchors(), popovers: document.querySelectorAll(".ant-popover").length })'))

  // ---------- Redis 会话 ----------
  REDIS_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  await cdp.eval(openTab(REDIS_TAB))
  check('Redis 页签打开', await waitFor(cdp,
    "(() => { const t = window.store.tabs.find(x => x.id === window.store.activeTabId); return !!(t && t.dbType === 'redis' && document.querySelector('.db-tree')) })()",
    'redis tab'))
  check('选中 db0 后键列表出长键名', await cdp.eval('window.__clickTree("db0")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("session:user")', 'redis key list'))
  const redisKeyLen = await cdp.eval('window.__fixture.key.length')
  await hoverCase(cdp, 'Redis 键列表 name', 'session:user', 'k1', {
    copyLen: redisKeyLen,
    metaLen: redisKeyLen,
    shot: '6-redis-keys-dark.png'
  })
  check('点开一个 hash 键（详情网格出长 value）', await cdp.eval('window.__clickRedisKey()') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("PPPPPPPPPPPP")', 'redis hash value'))
  await hoverCase(cdp, 'Redis 详情 hash value(6500)', 'PPPPPPPPPPPP', 'short', {
    copyLen: 6500, metaLen: 6500, clipOver: true, shot: '7-redis-hash-dark.png'
  })

  // ---------- 浅色主题复查（卡片配色全部走 token） ----------
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(800)
    const dark = await cdp.eval('window.store._config && window.store._config.theme')
    await cdp.eval('window.store.changeActiveTabId(' + JSON.stringify(mysqlId) + ')')
    await cdp.eval('window.__clickTab("^SQL$")')
    await sleep(600)
    const sqlCell = await cellInfo(cdp, 'QQQQQQQQQQQQ')
    await cdp.move(sqlCell.x, sqlCell.y)
    await sleep(220)
    const lightCard = await cardInfo(cdp)
    check('浅色主题下 SQL 结果仍出预览卡', lightCard.open === 1, lightCard)
    const colors = JSON.parse(await cdp.eval(`
      (() => {
        const card = window.__cards()[0]
        if (!card) return '{}'
        const pre = card.querySelector('.db-cell-preview-pre')
        const s = getComputedStyle(pre)
        return JSON.stringify({ color: s.color, bg: s.backgroundColor, border: s.borderTopColor, mono: /mono|Consolas|Menlo|monospace/i.test(s.fontFamily) })
      })()
    `))
    check('浅色下预览正文有对比度（前景≠背景）',
      !!colors.color && colors.color !== colors.bg && colors.mono === true, { theme: dark, colors })
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '8-sql-result-light.png')))
    await cdp.move(5, 5)
    await sleep(340)
  }

  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  console.log('stub ops called: ' + await cdp.eval('JSON.stringify(window.__dbStubCalls)'))
  // ws 会挂住事件循环，跑完必须显式退出
  process.exit(fail.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
