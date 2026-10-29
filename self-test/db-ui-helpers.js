// SQL 结果区 CDP 验收的公共件：页内探针 + CDP 客户端 + 判据工具。
//
// 桩版（db-sql-value-pane-demo.js）与真库版（db-sql-value-pane-realdb.js）共用同一套
// DOM 判据：两处各写一遍的话，页面结构一改就会只改一边，另一边的判据静默失真。
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

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

// 页内探针（window.__* 一族）。splitKey = 分区高度的 localStorage 键，
// 探针要读它来验"拖完即存"，由调用方给，避免探针里写死业务键名。
const buildHelpers = splitKey => `
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
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null

  window.__clickTab = re => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')]
      .filter(window.__vis)
      .find(x => new RegExp(re).test(x.innerText.replace(/\\s/g, '')))
    if (!t) return 'no-tab:' + re
    t.click()
    return 'ok'
  }
  window.__clickTree = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim().indexOf(text) >= 0)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  window.__hasTree = text => !![...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .find(n => window.__vis(n) && n.innerText.trim().indexOf(text) >= 0)

  // 只认结果区那一张表：数据页网格也有 .db-grid-table-wrap，靠 .db-sql-result-grid 区分
  window.__grid = () => window.__one('.db-sql-result-grid')
  window.__colIdx = label => {
    const g = window.__grid()
    if (!g) return -1
    const nameOf = t => {
      const n = t.querySelector('.db-col-name')
      return ((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]
    }
    const ths = [...g.querySelectorAll('thead th')].filter(window.__vis)
    for (let i = 0; i < ths.length; i++) {
      if (nameOf(ths[i]) === label) return i
    }
    return -1
  }
  window.__rows = () => {
    const g = window.__grid()
    return g ? [...g.querySelectorAll('.ant-table-row')].filter(window.__vis) : []
  }
  // 给一格打坐标：点击/悬停都按真实坐标走 CDP Input，React 合成事件才和真人一致。
  // x 取左边 60px 内 —— 长值格的右半边是省略号区，且避开列头拖拽句柄那条热区
  window.__cellXY = (label, rowIdx) => {
    const idx = window.__colIdx(label)
    if (idx < 0) return JSON.stringify({ error: 'no-col:' + label })
    const rows = window.__rows()
    const tr = rows[rowIdx || 0]
    if (!tr) return JSON.stringify({ error: 'no-row:' + rowIdx + ' of ' + rows.length })
    const td = tr.children[idx]
    if (!td) return JSON.stringify({ error: 'no-td' })
    const r = td.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + Math.min(r.width / 2, 60)),
      y: Math.round(r.top + r.height / 2),
      cls: String(td.className || ''),
      w: Math.round(r.width),
      text: td.innerText.trim().substring(0, 24)
    })
  }
  window.__selCells = () => [...document.querySelectorAll('.db-cell-selected')].filter(window.__vis)
    .map(td => {
      const r = td.getBoundingClientRect()
      return {
        cls: String(td.className || ''),
        text: td.innerText.trim().substring(0, 20),
        align: getComputedStyle(td).textAlign,
        shadow: getComputedStyle(td).boxShadow,
        x: Math.round(r.left + 20),
        y: Math.round(r.top + r.height / 2)
      }
    })

  // 表体滚动：@rc-component/virtual-list 在 useVirtual 时把 holder 写成
  // overflow:hidden，总高靠自绘 ScrollBar + wheel 事件驱动（native scrollTop 纹丝不动）。
  // 所以"滚没滚"只能读两样东西：inner 的 translateY 与 DOM 里第一行的 id。
  window.__scroller = () => {
    const g = window.__grid()
    if (!g) return null
    const el = g.querySelector('.ant-table-tbody-virtual-holder') ||
      g.querySelector('.ant-table-body') ||
      g.querySelector('.db-grid-table')
    if (el) {
      el.__isScroller = 1
    }
    return el
  }
  window.__inner = () => {
    const g = window.__grid()
    return g ? g.querySelector('.ant-table-tbody-virtual-holder-inner') : null
  }
  // transform: translateY(Npx) 里的 N（矩阵读法对 translate3d 也成立）
  window.__innerTY = () => {
    const el = window.__inner()
    if (!el) return -1
    const t = getComputedStyle(el).transform
    const m = /matrix\\(([^)]*)\\)/.exec(t)
    if (!m) return 0
    const p = m[1].split(',').map(Number)
    return Math.round(p[5] || 0)
  }
  window.__firstId = () => {
    const r = window.__rows()[0]
    if (!r) return null
    const td = r.children[0]
    return td ? td.innerText.trim().substring(0, 12) : null
  }
  // 网格与分区的"实测几何"：折叠/展开前后各读一次，比的是真实像素高
  window.__geom = () => {
    const pane = window.__one('.db-split-pane')
    const g = window.__grid()
    const top = pane ? pane.querySelector('.db-split-pane-top') : null
    const bottom = pane ? pane.querySelector('.db-split-pane-bottom') : null
    const res = {
      pane: pane ? 1 : 0,
      collapsed: pane ? (pane.className.indexOf('db-split-pane-collapsed') >= 0 ? 1 : 0) : -1,
      resizer: pane ? (pane.querySelector('.db-split-resizer') ? 1 : 0) : -1,
      topH: top ? Math.round(top.getBoundingClientRect().height) : -1,
      bottomH: bottom ? Math.round(bottom.getBoundingClientRect().height) : -1,
      gridH: g ? Math.round(g.getBoundingClientRect().height) : -1,
      domRows: window.__rows().length,
      virtual: g ? (g.querySelector('.ant-table-tbody-virtual') ? 1 : 0) : -1,
      bar: window.__one('.db-sql-value-bar') ? 1 : 0,
      valPane: window.__one('.db-split-pane-bottom .db-value-pane') ? 1 : 0,
      selCount: window.__selCells().length,
      scrollTop: -1,
      scrollMax: -1,
      innerTY: window.__innerTY(),
      firstId: window.__firstId(),
      holderSH: -1,
      holderCH: -1
    }
    const sc = window.__scroller()
    if (sc) {
      res.scrollTop = Math.round(sc.scrollTop)
      res.scrollMax = Math.round(sc.scrollHeight - sc.clientHeight)
      res.holderSH = sc.scrollHeight
      res.holderCH = sc.clientHeight
    }
    return JSON.stringify(res)
  }
  // 节点身份探针：给网格与表体挂自定义属性，重挂后属性必然丢失 —— 这是
  // "表格有没有被换树形搞重挂"最直接的读数，比截图对比可靠
  window.__mark = () => {
    const g = window.__grid()
    if (!g) return 'no-grid'
    g.__probe = 'wrap'
    const body = g.querySelector('.ant-table-tbody-virtual') || g.querySelector('.ant-table-body')
    if (body) body.__probe = 'body'
    return 'marked'
  }
  window.__probeAlive = () => {
    const g = window.__grid()
    if (!g) return JSON.stringify({ wrap: 0, body: 0 })
    const body = g.querySelector('.ant-table-tbody-virtual') || g.querySelector('.ant-table-body')
    return JSON.stringify({
      wrap: g.__probe === 'wrap' ? 1 : 0,
      body: body ? (body.__probe === 'body' ? 1 : 0) : -1
    })
  }
  // 滚轮落点：网格可视区中部。落 in tbody 才会被 useFrameWheel 接住
  window.__bodyPoint = () => {
    const sc = window.__scroller()
    if (!sc) return JSON.stringify({ error: 'no-holder' })
    const r = sc.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + 80),
      y: Math.round(r.top + Math.min(r.height / 2, 120)),
      w: Math.round(r.width),
      h: Math.round(r.height)
    })
  }

  // 现场快照：任何一条判据红了都要能分清"产品没做对"还是"夹具没到位"
  window.__dump = () => JSON.stringify({
    rows: window.__rows().length,
    grid: !!window.__grid(),
    pane: window.__one('.db-split-pane') ? 1 : 0,
    bar: window.__one('.db-sql-value-bar') ? 1 : 0,
    valPane: window.__one('.db-split-pane-bottom .db-value-pane') ? 1 : 0,
    firstId: window.__firstId(),
    lastSql: String(window.__lastSql),
    err: (() => {
      const a = document.querySelector('.db-sql-result .ant-alert-message')
      return a ? a.innerText.trim().slice(0, 120) : null
    })(),
    tabs: [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).map(t => t.innerText.trim()).slice(0, 8),
    runBtn: (() => {
      const b = [...document.querySelectorAll('.db-sql-area button')].filter(window.__vis)[0]
      return b ? String(b.disabled) : 'none'
    })()
  })

  window.__bar = () => {
    const bar = window.__one('.db-sql-value-bar')
    if (!bar) return JSON.stringify({ exists: 0 })
    const xy = el => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    }
    const col = bar.querySelector('.db-sql-value-bar-col')
    const meta = bar.querySelector('.db-sql-value-bar-meta')
    const hint = bar.querySelector('.db-sql-value-bar-hint')
    const close = bar.querySelector('.db-sql-value-bar-close')
    const r = bar.getBoundingClientRect()
    return JSON.stringify({
      exists: 1,
      title: ((col && col.innerText) || '').trim(),
      meta: ((meta && meta.innerText) || '').trim(),
      hint: ((hint && hint.innerText) || '').trim(),
      h: Math.round(r.height),
      center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      closeXY: close ? xy(close) : null
    })
  }
  window.__pane = () => {
    const pane = window.__one('.db-split-pane-bottom .db-value-pane')
    if (!pane) return JSON.stringify({ exists: 0 })
    const head = pane.querySelector('.db-value-pane-head')
    const pre = pane.querySelector('.db-value-pre')
    const btns = [...pane.querySelectorAll('button')].map(b => {
      const r = b.getBoundingClientRect()
      return {
        t: b.innerText.trim(),
        title: b.getAttribute('title') || '',
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      }
    })
    const txt = pre ? pre.textContent : ''
    return JSON.stringify({
      exists: 1,
      title: (((head || {}).querySelector('.db-grid-title')) || {}).innerText || '',
      meta: (((head || {}).querySelector('.db-grid-total')) || {}).innerText || '',
      preLen: txt.length,
      preHash: window.__hash(txt),
      preSame: pre && window.__fixture && txt === window.__fixture.big ? 1 : 0,
      textarea: pane.querySelector('textarea') ? 1 : 0,
      btns,
      h: Math.round(pane.getBoundingClientRect().height)
    })
  }
  window.__resizerXY = () => {
    const el = window.__one('.db-split-pane .db-split-resizer')
    if (!el) return JSON.stringify({ found: 0 })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ found: 1, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__ls = () => String(window.localStorage.getItem(${JSON.stringify(splitKey)}))
  window.__setLs = v => {
    if (v === null) {
      window.localStorage.removeItem(${JSON.stringify(splitKey)})
      return 'removed'
    }
    window.localStorage.setItem(${JSON.stringify(splitKey)}, String(v))
    return String(window.localStorage.getItem(${JSON.stringify(splitKey)}))
  }

  // 预览卡（H1a-1）：单例、截断标记、"查看完整"按钮坐标
  window.__card = () => {
    const c = window.__one('.db-cell-preview')
    const all = document.querySelectorAll('.db-cell-preview').length
    if (!c) return JSON.stringify({ open: 0, cards: all })
    const pre = c.querySelector('.db-cell-preview-pre')
    // 正文长度要绕开截断提示：那个 span 就嵌在 .db-cell-preview-pre 里面，
    // 直接取 textContent 会把"已截断"的提示字数算进正文，4000 会被读成 4016
    let bodyLen = -1
    let bodyText = ''
    if (pre) {
      bodyLen = 0
      for (const n of Array.from(pre.childNodes)) {
        if (n.nodeType === 1 && n.classList.contains('db-cell-preview-more')) {
          continue
        }
        bodyLen += String(n.textContent || '').length
        bodyText += String(n.textContent || '')
      }
    }
    const b = [...c.querySelectorAll('button')].find(x => /查看完整|view full/i.test(x.innerText.replace(/\\s+/g, '')))
    let full = null
    if (b) {
      const r = b.getBoundingClientRect()
      full = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: b.innerText.trim() }
    }
    return JSON.stringify({
      open: 1,
      cards: all,
      len: bodyLen,
      hash: window.__hash(bodyText),
      more: c.querySelector('.db-cell-preview-more') ? 1 : 0,
      col: ((c.querySelector('.db-cell-preview-col') || {}).innerText || '').trim(),
      full
    })
  }
  window.__modal = () => {
    const pre = window.__one('.db-full-text-pre')
    if (!pre) return JSON.stringify({ open: 0 })
    const box = pre.closest('.ant-modal')
    const meta = box ? box.querySelector('.db-full-text-meta') : null
    const s = getComputedStyle(pre)
    const btns = box ? [...box.querySelectorAll('.ant-modal-footer button')].map(b => {
      const r = b.getBoundingClientRect()
      // antd 会在两个汉字的按钮里插一个空格（"复 制"），按原文匹配按钮名会漏
      return {
        t: b.innerText.trim(),
        k: b.innerText.replace(/\\s+/g, ''),
        title: b.getAttribute('title') || '',
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      }
    }) : []
    const txt = pre.textContent
    return JSON.stringify({
      open: 1,
      len: txt.length,
      hash: window.__hash(txt),
      same: window.__fixture && txt === window.__fixture.big ? 1 : 0,
      head: txt.slice(0, 12),
      tail: txt.slice(-12),
      title: ((box && box.querySelector('.ant-modal-title')) || {}).innerText || '',
      meta: ((meta && meta.innerText) || '').trim(),
      mono: /mono|Consolas|Menlo/i.test(s.fontFamily),
      selectable: /text/.test(s.userSelect + ' ' + s.webkitUserSelect),
      wrap: s.whiteSpace,
      btns
    })
  }
  // 读回真实剪贴板。两条硬约束：
  //   1) 真库跑没有 window.__fixture（页面里没有我们注入的原文可比），
  //      same 用 -1 表示"没有可比对的原文"，与 0"比对不相等"区分开；
  //      真库那一侧的等值判断走哈希，对的是格子里读出来的 hash。
  //   2) 剪贴板里可能是生产数据，所以只回长度与哈希，绝不把原文送回 node。
  window.__readClip = () => {
    try {
      const t = String(window.pre.readClipboard ? window.pre.readClipboard() : '')
      return JSON.stringify({
        ok: 1,
        len: t.length,
        hash: window.__hash(t),
        same: window.__fixture ? (t === window.__fixture.big ? 1 : 0) : -1,
        headHash: window.__hash(t.slice(0, 12)),
        tailHash: window.__hash(t.slice(-12))
      })
    } catch (err) {
      return JSON.stringify({
        ok: 0,
        error: String((err && err.message) || err),
        pre: typeof window.pre,
        readClipboard: typeof (window.pre && window.pre.readClipboard)
      })
    }
  }
  window.__clipLog = () => JSON.stringify(window.__clip)

  window.__focusSql = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return 'no-editor'
    ed.focus()
    return document.activeElement === ed ? 'focused' : 'not-focused'
  }
  window.__sqlDoc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    return ed ? String(ed.innerText || '').trim().substring(0, 80) : 'no-editor'
  }
  window.__clickRunSql = () => {
    const bars = [...document.querySelectorAll('.db-sql-bar')].filter(window.__vis)
    if (!bars.length) return 'no-bar'
    const b = [...bars[0].querySelectorAll('button')].find(x => /^(执行|runsql|run)$/i.test(x.innerText.replace(/\\s/g, '')))
    if (!b) return 'no-run-btn:' + JSON.stringify(bars[0].querySelectorAll('button').length)
    if (b.disabled) return 'run-disabled'
    b.click()
    return 'ok'
  }
  // 点执行没反应时，先看清 bar 上到底有哪些按钮、什么状态
  window.__sqlBarBtns = () => [...document.querySelectorAll('.db-sql-bar button')].filter(window.__vis)
    .map(b => ({
      t: b.innerText.replace(/\\s+/g, ''),
      title: b.getAttribute('title') || '',
      disabled: String(!!b.disabled)
    }))
  window.__gotoPage = n => {
    const item = window.__one('.db-sql-result-tools .ant-pagination-item-' + n)
    if (!item) return 'no-page-' + n
    const a = item.querySelector('a') || item
    a.click()
    return 'ok'
  }
  window.__resultTabs = () => {
    const box = window.__one('.db-sql-results-tabs')
    if (!box) return JSON.stringify([])
    return JSON.stringify([...box.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).map(x => x.innerText.trim()))
  }
  window.__clickResultTab = re => {
    const box = window.__one('.db-sql-results-tabs')
    if (!box) return 'no-tabs'
    const t = [...box.querySelectorAll('.ant-tabs-tab')].filter(window.__vis)
      .find(x => new RegExp(re).test(x.innerText.replace(/\\s/g, '')))
    if (!t) return 'no-tab:' + re
    t.click()
    return 'ok'
  }
  // 列宽：表头 handle 坐标 + 列宽读数（H1a-2 共存回归用）
  window.__colWidth = label => {
    const idx = window.__colIdx(label)
    const rows = window.__rows()
    if (idx < 0 || !rows.length) return -1
    return Math.round(rows[0].children[idx].getBoundingClientRect().width)
  }
  window.__handleXY = label => {
    const g = window.__grid()
    if (!g) return JSON.stringify({ found: 0, reason: 'no-grid' })
    const nameOf = t => {
      const n = t.querySelector('.db-col-name')
      return ((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]
    }
    const th = [...g.querySelectorAll('thead th')].find(t => nameOf(t) === label)
    if (!th) return JSON.stringify({ found: 0, reason: 'no-th:' + label })
    const h = th.querySelector('.db-col-resizer')
    if (!h) return JSON.stringify({ found: 0, reason: 'no-handle' })
    const r = h.getBoundingClientRect()
    return JSON.stringify({ found: 1, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__colMeta = label => {
    const idx = window.__colIdx(label)
    if (idx < 0) return JSON.stringify({ error: 'no-col:' + label })
    const rows = window.__rows()
    const pick = rows.slice(0, 3).map(r => r.children[idx])
    return JSON.stringify({
      n: rows.length,
      cls: pick.map(td => String((td || {}).className || '')),
      align: pick.map(td => (td ? getComputedStyle(td).textAlign : '')),
      texts: pick.map(td => ((td || {}).innerText || '').trim().slice(0, 40))
    })
  }

  // —— 以下为本机真库验收补的"不外泄内容"判据原语 ——
  // 真库里 parameter/detail 这类列存的是生产数据（含口令散列），验收输出绝不能把内容
  // 打到终端或写进文档。所以跨节点比"这段文本是不是那一格的全文"时，比的是
  // 长度 + djb2 哈希；要确认具体特征（比如二进制 hex）时，由 node 递一个 needle
  // 让页面回答布尔，内容本身始终留在页面里。
  window.__hash = s => {
    let h = 5381
    const t = String(s || '')
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) + h + t.charCodeAt(i)) | 0
    }
    return h
  }
  window.__tdOf = (label, rowIdx) => {
    const idx = window.__colIdx(label)
    if (idx < 0) return null
    const tr = window.__rows()[rowIdx || 0]
    return tr ? (tr.children[idx] || null) : null
  }
  // 单元格的"全文"量度：CSS 省略号只裁视觉，textContent 仍是完整值 ——
  // 这一条正是"网格裁 / 预览卡裁 4000 / 面板给全文"三档分开的基准
  window.__cellText = (label, rowIdx) => {
    const td = window.__tdOf(label, rowIdx)
    if (!td) return JSON.stringify({ exists: 0, reason: 'no-cell:' + label + '/' + rowIdx })
    const t = String(td.textContent || '')
    return JSON.stringify({ exists: 1, len: t.length, hash: window.__hash(t) })
  }
  // 预览卡只给前 PREVIEW_MAX 个字符：要证明"卡片里的就是全文的前 4000"，
  // 比的就是"全文切前 4000 的哈希"，而不是把内容取回 node
  window.__cellPre = (label, rowIdx, n) => {
    const td = window.__tdOf(label, rowIdx)
    if (!td) return JSON.stringify({ exists: 0, reason: 'no-cell:' + label + '/' + rowIdx })
    const t = String(td.textContent || '')
    return JSON.stringify({ exists: 1, len: Math.min(t.length, n), hash: window.__hash(t.slice(0, n)) })
  }
  window.__headerLabels = () => {
    const g = window.__grid()
    if (!g) return JSON.stringify([])
    const nameOf = t => {
      const n = t.querySelector('.db-col-name')
      return ((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]
    }
    return JSON.stringify([...g.querySelectorAll('thead th')].filter(window.__vis).map(nameOf))
  }
  // needle 由 node 给定，页面只回答有没有 —— 便于断言 hex/前缀而不回传内容
  window.__paneHas = needle => {
    const pane = window.__one('.db-split-pane-bottom .db-value-pane')
    if (!pane) return JSON.stringify({ exists: 0 })
    const t = String((pane.textContent || ''))
    return JSON.stringify({ exists: 1, has: t.indexOf(String(needle)) >= 0 ? 1 : 0 })
  }
  window.__modalHas = needle => {
    const pre = window.__one('.db-full-text-pre')
    if (!pre) return JSON.stringify({ exists: 0 })
    return JSON.stringify({ exists: 1, has: String(pre.textContent || '').indexOf(String(needle)) >= 0 ? 1 : 0 })
  }
  // 树节点按"整名相等"点：真库的表名都以库名前缀开头（tgfsom 库里 tgfsom_xxx 满屏），
  // indexOf 版会点错节点
  window.__clickTreeExact = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim() === text)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  // 复制监听：拦 writeClipboard 记录长度与哈希，仍调原函数让真实剪贴板一并可验
  window.__spyClip = () => {
    if (!window.pre || typeof window.pre.writeClipboard !== 'function') {
      return 'no-pre'
    }
    if (window.pre.writeClipboard.__clipspy) {
      return 'already'
    }
    const orig = window.pre.writeClipboard
    const wrapped = function (s) {
      const t = String(s === null || s === undefined ? '' : s)
      window.__clip.push({ len: t.length, hash: window.__hash(t), head: t.slice(0, 8) })
      return orig.apply(window.pre, arguments)
    }
    wrapped.__clipspy = 1
    window.pre.writeClipboard = wrapped
    return 'installed'
  }
  window.__clip = window.__clip || []
  return 'helpers-installed'
})()
`

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    // 渲染层的异常/控制台输出：判据红了要能区分"产品崩了"和"夹具没到位"。
    // 上一轮 C4 之后整个数据库页签没了，dump 里只剩 书签/访问历史 ——
    // 没有这份日志就只能靠猜
    this.events = []
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
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params && m.params.exceptionDetails
        this.events.push('EX ' + String(((e && e.exception && e.exception.description) || (e && e.text) || '')).split('\n')[0].slice(0, 220))
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const p = m.params || {}
        if (p.type === 'error' || p.type === 'warning') {
          this.events.push(p.type.toUpperCase() + ' ' + (p.args || []).map(a => String(a.value === undefined ? a.description || '' : a.value)).join(' ').slice(0, 220))
        }
      } else if (m.method === 'Log.entryAdded') {
        const en = (m.params && m.params.entry) || {}
        if (en.level === 'error') {
          this.events.push('LOG ' + String(en.text || '').slice(0, 220))
        }
      }
    })
  }

  tail (n = 6) {
    return this.events.slice(-n)
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async jeval (expression) {
    return JSON.parse(await this.eval(expression))
  }

  async move (x, y) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  }

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

  async dragY (x, y, dy, steps = 8) {
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
    })
    for (let i = 1; i <= steps; i++) {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y: Math.round(y + (dy * i) / steps), button: 'left', buttons: 1
      })
    }
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y: Math.round(y + dy), button: 'left', buttons: 0, clickCount: 1
    })
    return Math.round(y + dy)
  }

  async dragX (x, y, dx, steps = 6) {
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
    })
    for (let i = 1; i <= steps; i++) {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(x + (dx * i) / steps), y, button: 'left', buttons: 1
      })
    }
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(x + dx), y, button: 'left', buttons: 0, clickCount: 1
    })
    return Math.round(x + dx)
  }

  async wheel (x, y, deltaY, steps = 5) {
    // 分多派发：useFrameWheel 按帧累积 deltaX/deltaY，一次 600px 会被合成一帧
    for (let i = 0; i < steps; i++) {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.round(deltaY / steps)
      })
      await sleep(50)
    }
    await sleep(320)
    return Math.round(deltaY)
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
    try {
      if (await cdp.eval(expr)) {
        return true
      }
    } catch (e) { /* reload 期间执行上下文会短暂失效，继续等 */ }
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return false
}

// 判据累加器：check 记一条 PASS/FAIL，脚本末尾按 fail 数决定退出码
const makeChecker = () => {
  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail })
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
  }
  return { results, check }
}

// 判据不能写死语言：本机词条可能是中文也可能是英文，两种都得认
const rowRe = n => new RegExp('第 ' + n + ' 行|row ' + n + '\\b')
const rsRe = n => new RegExp('结果 ' + n + '|result ' + n + '\\b', 'i')
const isCharsMeta = (s, n) => {
  const t = String(s || '').replace(/[,\s]/g, '')
  return t === n + 'chars' || t === n + '字符'
}

const hexOk = (a, b) => {
  const p = s => String(s || '').match(/\d+/g)
  if (!p(a) || !p(b)) {
    return false
  }
  return p(a).slice(0, 3).join(',') !== p(b).slice(0, 3).join(',')
}

// 点一格：坐标只能来自那一格自己的矩形。拿不到矩形就明确报告，
// 绝不能把 undefined 当 0 传给 CDP —— 那样等于在 (0,0) 乱点，
// 把"夹具没到位"演成"产品没选中"，红的全是假案
const clickCell = async (cdp, label, rowIdx) => {
  const xy = await cdp.jeval('window.__cellXY(' + JSON.stringify(label) + ', ' + rowIdx + ')')
  if (xy.error || typeof xy.x !== 'number') {
    return { ok: false, reason: 'cellXY:' + (xy.error || 'no-coord'), dump: await cdp.jeval('window.__dump()') }
  }
  await cdp.click(xy.x, xy.y)
  await sleep(350)
  await cdp.move(5, 5)
  await sleep(200)
  return { ok: true, xy }
}

module.exports = {
  getJson,
  buildHelpers,
  Cdp,
  sleep,
  waitFor,
  makeChecker,
  rowRe,
  rsRe,
  isCharsMeta,
  hexOk,
  clickCell
}
