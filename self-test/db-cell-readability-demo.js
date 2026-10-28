#!/usr/bin/env node
/**
 * H1a-1 / H1a-2 · 网格可读性统一层 —— CDP 实机回归（桩数据，无需真 MySQL/Redis）
 *
 * 要证明的是"落地效果"，不是"代码写了"：
 *   1) 5 处网格（数据页 / 表结构页 / SQL 结果 / Redis 键列表 / Redis 详情）
 *      截断单元格悬停真的出预览卡；
 *   2) 没被截断的格子不弹（否则鼠标扫过整表就是洪泛）；
 *   3) 预览卡是单例：DOM 里永远只有 1 个锚点，不随行数/格数增长；
 *   4) 复制拿到的是全文（不是 4000 字符裁剪后的预览）；>4000 出截断提示；
 *   5) 关闭时机：指针移开（缓冲后）、滚动、Esc；
 *   6) 不改数据链路：单击开值面板、双击行内编辑、编辑框 Esc 退出都仍在。
 *   —— 以下是 H1a-2（列宽可控）——
 *   7) 宽度按列内容量出来（短列≠长列，长列封顶 360），不再写死 220/200；
 *   8) 拖拽：起点是"实测宽"（不跳回配置宽）、拖幅生效、上下限夹到 [60,1200]、
 *      只按下不移动不留手动宽、过程中不掉帧（200 行/页慢拖 1s 采样）；
 *   9) 列头菜单：画在视口内且命中得到、三项齐全、标题显示这一列（译文）、
 *      Esc/滚动/在别处按下都能关；
 *  10) 落点分层：数据页手动宽写进表视角（切表不串味、切回来还在），
 *      SQL / 表结构 / Redis 键列表只在内存里；
 *  11) 保留与重置：翻页保留列宽；SQL 重新执行才回到自适应；
 *  12) 工具行"自适应全部列"：有手动宽才可点，点完全部回自适应并重新置灰。
 *
 * 用法：
 *   1) npm run compile && cp -r src/app/common/locales-extra.js work/app/common/locales-extra.js
 *      （compile 不同步 src/app，词条没进 work/app 时运行时会拿到 undefined）
 *   2) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a-tmp/home \
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
  // H1a-2 要验"拖完切表回来还在"，所以视角读写必须真的往返：这里做一个进程内
  // 的 view store（list 回 map、get 回单条、save/remove 改 map），
  // 换成写死 null 的话持久化路径全程空转，那条断言就是假的
  window.__viewStore = {}
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
      if (name === 'dbGridViewOp') {
        const action = a[0]
        const arg = a[1] || {}
        if (action === 'list') return Promise.resolve({ ...window.__viewStore })
        if (action === 'get') return Promise.resolve(window.__viewStore[arg.key] || null)
        if (action === 'save') {
          window.__viewStore[arg.key] = { ...(arg.view || {}), key: arg.key }
          return Promise.resolve(window.__viewStore[arg.key])
        }
        if (action === 'remove') {
          const had = !!window.__viewStore[arg.key]
          delete window.__viewStore[arg.key]
          return Promise.resolve(had)
        }
        return Promise.resolve(null)
      }
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
        children: [
          { name: 'operation_log', type: 'table' },
          // H1a-2 用第二张表验"手动宽不跨表串味"（视角键含表名）
          { name: 'other_tbl', type: 'table' }
        ]
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
      // H1a-2 再抬到 200 行并按 page/pageSize 切片：翻页按钮要真的能点，
      // "翻页保留列宽"这条才有实测对象（每页上限 200 是批次 A 定的，即渲染上界）
      const rows = [
        { id: 1, flag: 'ok', note: null, detail: F.longD, parameter: F.param },
        { id: 2, flag: 'no', note: 'n2', detail: 'short one', parameter: { uid: 1002 } }
      ]
      for (let i = 3; i <= 200; i++) {
        rows.push({ id: i, flag: i % 2 ? 'ok' : 'no', note: 'n' + i, detail: 'd' + i, parameter: { uid: 3000 + i } })
      }
      const page = args.page || 1
      const ps = args.pageSize || 20
      const start = (page - 1) * ps
      const res = {
        rows: rows.slice(start, start + ps),
        totalRows: rows.length,
        page,
        hasMore: start + ps < rows.length
      }
      // 现场留档：翻页按钮置灰时，"app 到底要了第几页/每页几条"和"stub 回了
      // hasMore/totalRows 没有"是唯一能事后还原的判据（ops 日志只有 op 名）
      window.__dbStubLast = {
        page, ps, count: res.rows.length, totalRows: res.totalRows, hasMore: res.hasMore,
        tabId, table: args.table
      }
      return Promise.resolve(res)
    }
    if (op === 'countRows') return Promise.resolve({ count: 200 })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'executeSql') {
      // 200 行 > 每页 50 → SQL 结果真的分页，才能验"翻页保留列宽、重新执行才重置"
      const sqlRows = [{ id: 1, flag: 'ok', big_text: F.longQ }, { id: 2, flag: 'no', big_text: 'tiny' }]
      for (let i = 3; i <= 200; i++) {
        sqlRows.push({ id: i, flag: i % 2 ? 'ok' : 'no', big_text: 'v' + i })
      }
      return Promise.resolve({
        results: [{
          sql: args.sql,
          fields: ['id', 'flag', 'big_text'],
          rows: sqlRows
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
  // 预览卡是"每会话一个实例"，所以单例/归属判断都以可见的会话根为准。
  // 根类名是 db-session-wrap（db-session 这个类不存在，写错了会静默退化成 document，
  // 跨页签计数就再也不是"当前会话内"的判据了 —— 实测踩过）
  window.__sessionRoot = () => [...document.querySelectorAll('.db-session-wrap')]
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
  // ---------- H1a-2 列宽实测 ----------
  // 宽度有两种读法，但两者都不是"我们配置的那个数"：
  // - used：th 的实测矩形宽
  // - specified：colgroup 里那一列的 style.width（rc-table 会把实测宽回写进来，
  //   实测 used === specified，所以它证明不了配置值）
  // 布局有两种状态，判据必须按状态选（stretch=1 表示当前处于摊宽状态）：
  // - 摊宽态（配置宽之和 <= 容器）：table-layout fixed + min-width:100% 会把剩余
  //   空间按比例摊给每列（实测配置 360 的列画成 444），只能判"谁比谁宽""没撑爆"
  // - 精确态（配置宽之和 > 容器）：used === 配置宽，才能判 360/720/1200/60 这些数
  // 所以精确断言前要先用一列的拖宽/加宽把总和顶过容器，并检查 stretched === false
  window.__thInfo = (th) => {
    const r = th.getBoundingClientRect()
    const table = th.closest('table')
    const col = table && table.querySelector('colgroup')
      ? table.querySelector('colgroup').children[th.cellIndex]
      : null
    const wrap = th.closest('.db-grid-table-wrap') ||
      (table ? table.parentElement : null)
    const handle = th.querySelector('.db-col-resizer')
    const hr = handle ? handle.getBoundingClientRect() : null
    const cx = hr ? Math.round(hr.left + hr.width / 2) : 0
    const cy = hr ? Math.round(hr.top + hr.height / 2) : 0
    const hit = hr ? document.elementFromPoint(cx, cy) : null
    const name = ((th.querySelector('.db-col-name') || {}).innerText || th.innerText || '').trim()
    const head = th.querySelector('.db-col-head') || th.querySelector('.db-col-title')
    const tableW = table ? Math.round(table.getBoundingClientRect().width) : 0
    const wrapW = wrap ? Math.round(wrap.clientWidth) : 0
    return {
      found: 1,
      label: name.split('\\n')[0],
      hint: head ? (head.getAttribute('title') || '') : '',
      // 手柄没接住的话，startResize 根本不会跑 —— 这条判据保证"拖的是手柄，不是列头"
      handleHit: hit ? (String(hit.className) || hit.tagName) : 'none',
      handleIsResizer: !!hit && !!hit.closest && !!hit.closest('.db-col-resizer'),
      used: Math.round(r.width),
      specified: col ? Math.round(parseFloat(col.style.width) || 0) : -1,
      tableW,
      wrapW,
      // 1 = 表格被拉伸铺满容器（此时 used 不等于配置宽，只能判相对量）
      stretch: tableW && wrapW && tableW <= wrapW + 2 ? 1 : 0,
      left: Math.round(r.left),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      handle: hr ? { x: cx, y: cy, w: Math.round(hr.width), h: Math.round(hr.height) } : null
    }
  }
  window.__thList = () => JSON.stringify(
    [...window.__sessionRoot().querySelectorAll('th')].filter(window.__vis).map(window.__thInfo)
  )
  // 把某一列横向滚进视口：拖到 1200 宽时这一列的手柄会跑到窗口右边外面，
  // 不先滚进来下一次按下的坐标就落在视口外，"拖不动"其实是点不到 —— 必须先滚再量
  window.__scrollColIntoView = (label) => {
    const ths = [...window.__sessionRoot().querySelectorAll('th')].filter(window.__vis)
    const nameOf = t => (((t.querySelector('.db-col-name') || {}).innerText || t.innerText || '').trim().split('\\n')[0])
    const th = ths.find(t => nameOf(t).indexOf(label) === 0)
    if (!th) {
      return 'no-th'
    }
    th.scrollIntoView({ block: 'nearest', inline: 'end' })
    const handle = th.querySelector('.db-col-resizer')
    const hr = handle ? handle.getBoundingClientRect() : null
    if (!hr) {
      return 'no-handle'
    }
    return hr.left > 1 && hr.right < innerWidth - 1
      ? 'in-view'
      : 'still-off:' + Math.round(hr.left) + '/' + Math.round(hr.right) + '/vw=' + innerWidth
  }
  window.__thOf = (label) => {
    const ths = [...window.__sessionRoot().querySelectorAll('th')].filter(window.__vis)
    const nameOf = t => (((t.querySelector('.db-col-name') || {}).innerText || t.innerText || '').trim().split('\\n')[0])
    const th = ths.find(t => nameOf(t).indexOf(label) === 0)
    if (!th) {
      return JSON.stringify({ found: 0, labels: ths.map(nameOf) })
    }
    return JSON.stringify(window.__thInfo(th))
  }
  window.__menus = () => document.querySelectorAll('.db-col-menu').length
  // 与 __anchors 同规则：多开一个数据库页签就多挂一份 DbColMenu（每个会话一份），
  // 单例契约是"当前会话内不随列数增长"，所以按当前会话根 + 可见性计数
  window.__menuAnchors = () => [...window.__sessionRoot().querySelectorAll('.db-col-menu-anchor')].filter(window.__vis).length
  // 滚轮到底滚没滚：拿落点元素的最近可纵向滚动祖先，读它的 scrollTop。
  // "滚动关菜单"这条红了要先分清是"没滚起来"（落点/行数不对）还是"滚了但没关"（监听没接住）。
  // overflow 要连 hidden 一起认：虚拟列表的 holder 就是 overflow hidden + 滚轮驱动
  window.__scrollProbe = (x, y) => {
    let el = document.elementFromPoint(x, y)
    while (el && el !== document.body) {
      const s = getComputedStyle(el)
      if (/(auto|scroll|hidden)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) {
        return JSON.stringify({
          hit: String(el.className).slice(0, 60), top: Math.round(el.scrollTop),
          sh: el.scrollHeight, ch: el.clientHeight
        })
      }
      el = el.parentElement
    }
    return JSON.stringify({ hit: 'no-scroller', top: -1 })
  }
  window.__menuInfo = () => {
    const m = [...document.querySelectorAll('.db-col-menu')].find(window.__vis)
    if (!m) {
      return JSON.stringify({ open: 0, anchors: window.__menuAnchors(), popovers: document.querySelectorAll('.ant-popover').length })
    }
    const r = m.getBoundingClientRect()
    const cx = Math.round(r.left + Math.min(r.width, 30) / 2)
    const cy = Math.round(r.top + Math.min(r.height, 30) / 2)
    const hit = document.elementFromPoint(cx, cy)
    const anchor = [...window.__sessionRoot().querySelectorAll('.db-col-menu-anchor')].find(window.__vis)
    const ar = anchor ? anchor.getBoundingClientRect() : null
    return JSON.stringify({
      open: 1,
      anchors: window.__menuAnchors(),
      head: (m.querySelector('.db-col-menu-head') || {}).innerText,
      items: [...m.querySelectorAll('.db-col-menu-item')].map(b => b.innerText.replace(/\\s/g, '')),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      hitIsMenu: !!hit && m.contains(hit),
      onScreen: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && !!hit && m.contains(hit),
      anchorVisible: !!ar && ar.width > 0 && ar.height > 0,
      anchorRect: ar ? { w: Math.round(ar.width), h: Math.round(ar.height) } : null,
      popInset: (() => {
        const pop = m.closest('.ant-popover')
        return pop ? (pop.style.inset || 'css') : 'no-pop'
      })()
    })
  }
  window.__clickMenuItem = (re) => {
    const m = [...document.querySelectorAll('.db-col-menu')].find(window.__vis)
    if (!m) return 'no-menu'
    const b = [...m.querySelectorAll('.db-col-menu-item')].find(x => new RegExp(re).test(x.innerText.replace(/\\s/g, '')))
    if (!b) return 'no-item:' + re + ':' + JSON.stringify([...m.querySelectorAll('.db-col-menu-item')].map(x => x.innerText))
    b.click()
    return 'ok'
  }
  // 翻页：只认"可见 pane 里的那一个"分页条（数据页 / SQL 结果各有一套）
  window.__clickPage = (n) => {
    const li = [...document.querySelectorAll('.ant-pagination-item-' + n)].filter(window.__vis)[0]
    if (!li) {
      return 'no-page-' + n + ':' + [...document.querySelectorAll('.ant-pagination-item')]
        .filter(window.__vis).map(x => x.className.match(/ant-pagination-item-(\\d+)/)).join(',')
    }
    const a = li.querySelector('a') || li
    a.click()
    return 'ok'
  }
  // 数据页的翻页是左右箭头按钮（不是 antd Pagination），按图标类名点
  window.__clickDataPage = (dir) => {
    const bars = [...document.querySelectorAll('.db-grid-pager')].filter(window.__vis)
    if (!bars.length) return 'no-pager'
    const bar = bars[0]
    const btn = [...bar.querySelectorAll('button')].find(b => b.querySelector('.anticon-' + (dir === 'next' ? 'right' : 'left')))
    if (!btn) return 'no-btn-' + dir
    // 被禁用时把"有几条分页条 / 这条写着什么 / 每个按钮的禁用态 / stub 最后一次回了
    // 第几页几行"全部带回来：上一轮只报 disabled-next，分不清"取错了别的面板的分页条"
    // 还是"这一页真的没有下一页"
    if (btn.disabled) {
      const btns = [...bar.querySelectorAll('button')].map(b => {
        const ic = b.querySelector('[class*="anticon-"]')
        return (ic ? String(ic.getAttribute('class')).match(/anticon-[a-z-]+/)[0] : 'tag') + (b.disabled ? '!' : '')
      }).join(' ')
      return 'disabled-' + dir + ':bars=' + bars.length + ':' + bar.innerText.replace(/\\s+/g, ' ').slice(0, 48) +
        ':btns=' + btns + ':stub=' + JSON.stringify(window.__dbStubLast || null)
    }
    btn.click()
    return 'ok'
  }
  // 当前选中的每页行数文本：数据页是虚拟滚动，DOM 里只有视口那几十行，
  // "行数拉到 200"不能拿 DOM 行数当判据，只能读下拉的选中值
  window.__pageSizeText = () => {
    const s = [...document.querySelectorAll('.db-grid-pagesize')].filter(window.__vis)[0]
    if (!s) return 'no-select'
    // antd6 的选中文本在 .ant-select-content 上（没有 .ant-select-selection-item），
    // 直接读 innerText 最稳：不跟 antd 的内部类名较劲
    return String(s.innerText || '').trim()
  }
  window.__openPageSize = () => {
    const s = [...document.querySelectorAll('.db-grid-pagesize')].filter(window.__vis)[0]
    if (!s) return 'no-select'
    const el = s.querySelector('.ant-select-selector') || s
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    return 'ok'
  }
  window.__pickPageSize = (n) => {
    const opts = [...document.querySelectorAll('.ant-select-item-option')].filter(window.__vis)
    // 用前缀匹配而不是拼正则：这段代码在模板字符串里，字符串内的 "\\b" 会被模板
    // 吃掉一层变成退格符，正则永远匹配不上（实测 seen 里明明有 "200 / 页" 却报 no-option）
    // 前缀要带上数字后面的那个空格（候选文案是 "{n} / 页"）：只比 "20" 会先撞上 "200 / 页"
    const hit = String(n) + ' '
    const opt = opts.find(o => String(o.innerText || '').trim().indexOf(hit) === 0)
    if (!opt) {
      return 'no-option:' + n + ':seen=' + JSON.stringify(opts.map(o => o.innerText))
    }
    opt.click()
    return 'ok'
  }
  window.__fitBtn = () => {
    const b = [...window.__sessionRoot().querySelectorAll('.db-col-fitall')].find(window.__vis)
    if (!b) return JSON.stringify({ found: 0 })
    const r = b.getBoundingClientRect()
    return JSON.stringify({
      found: 1,
      disabled: b.disabled === true,
      title: b.getAttribute('title') || (b.closest('.ant-tooltip') || {}).innerText || '',
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    })
  }
  window.__viewDump = () => JSON.stringify(
    Object.keys(window.__viewStore).map(k => [k, (window.__viewStore[k].columnWidths || {})]))
  window.__bodyResizing = () => document.body.classList.contains('db-col-resizing')
  // 拖拽帧率采样：起点到终点之间逐帧记 performance.now()，跑完算平均 fps 与最差帧距
  window.__fpsOn = false
  window.__fpsStart = () => {
    window.__fpsOn = true
    window.__fpsT = []
    const tick = ts => {
      if (!window.__fpsOn) return
      window.__fpsT.push(ts)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return 'started'
  }
  window.__fpsStop = () => {
    window.__fpsOn = false
    const t = window.__fpsT || []
    const gaps = []
    for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1])
    gaps.sort((a, b) => a - b)
    const span = t.length > 1 ? t[t.length - 1] - t[0] : 0
    return JSON.stringify({
      frames: t.length,
      span: Math.round(span),
      fps: span > 0 ? Math.round((t.length - 1) * 1000 / span) : 0,
      worstGap: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
      p95Gap: gaps.length ? Math.round(gaps[Math.max(0, Math.floor(gaps.length * 0.95) - 1)]) : 0
    })
  }
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

  // 右键：Chromium 对合成的按下/抬起会派发 contextmenu（React 的 onContextMenu
  // 就挂在这上面）。button 同样必须显式给 'right'
  async rightClick (x, y) {
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1
    })
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1
    })
  }

  // 手柄拖拽：按下 → 分步移动（buttons:1 才算"按键未松开"，document 上的
  // mousemove 监听才会收到）→ 抬起。sleepMs>0 时逐帧让出主线程，配合
  // __fpsStart/__fpsStop 采拖拽过程中的真实帧率
  async drag (x, y, dx, steps = 6, sleepMs = 0) {
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
    })
    for (let i = 1; i <= steps; i++) {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(x + (dx * i) / steps), y, button: 'left', buttons: 1
      })
      if (sleepMs) {
        await sleep(sleepMs)
      }
    }
    return Math.round(x + dx)
  }

  async release (x, y) {
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
    })
  }

  // 滚轮要先 mouseMoved 到落点：Chromium 派发 wheel 用的是它内部记录的指针位置，
  // 只给 x/y 不移指针时事件会打到"上一次鼠标所在的那个元素"上 —— 实测右键完列头
  // 再 wheel 到正文，滚动根本没发生（虚拟表的 holder scrollTop 纹丝不动），
  // 于是"滚动关菜单"被误判成监听器失灵
  async wheel (x, y, deltaY) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
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
const thOf = async (cdp, label) => JSON.parse(await cdp.eval('window.__thOf(' + JSON.stringify(label) + ')'))
const menuInfo = async cdp => JSON.parse(await cdp.eval('window.__menuInfo()'))
const fitBtn = async cdp => JSON.parse(await cdp.eval('window.__fitBtn()'))

// 期望宽度从常量源里读，不在测试里再抄一份数字：改了 common 那边这里跟着动，
// 红的是"实现与契约不一致"，而不是"测试忘了更新"
const COL_W = (() => {
  const s = fs.readFileSync(path.join(__dirname, '../src/client/common/db-column-width.js'), 'utf8')
  const num = (n) => {
    const m = s.match(new RegExp('export const ' + n + ' = (\\d+)'))
    if (!m) {
      throw new Error('constant ' + n + ' not found in db-column-width.js')
    }
    return Number(m[1])
  }
  return {
    min: num('COL_W_MIN'),
    max: num('COL_W_MAX'),
    wide: num('COL_W_WIDE'),
    dragMin: num('COL_W_DRAG_MIN'),
    dragMax: num('COL_W_DRAG_MAX')
  }
})()

// 拖某一列的手柄：（先把它横向滚进视口）→ 按下 → 分步移动 → （可选）按住不动时读一次宽度 → 抬起
const dragCol = async (cdp, label, dx, opts = {}) => {
  const scrolled = await cdp.eval('window.__scrollColIntoView(' + JSON.stringify(label) + ')')
  await sleep(120)
  const before = await thOf(cdp, label)
  if (!before.found || !before.handleIsResizer) {
    return { before, ok: false, scrolled }
  }
  const steps = opts.steps === undefined ? 6 : opts.steps
  const endX = await cdp.drag(before.handle.x, before.handle.y, dx, steps, opts.sleepMs || 0)
  // probeMid：还按着按键时读宽度 —— 只有这时量到的才是"拖拽中"的那一帧
  const mid = opts.probeMid ? await thOf(cdp, label) : null
  await cdp.release(endX, before.handle.y)
  await sleep(150)
  const after = await thOf(cdp, label)
  return { before, mid, after, ok: true, scrolled }
}

// 只按下不移动（手抖点了一下列头右边沿）：不该留下任何手动宽
const tapHandle = async (cdp, label) => {
  const scrolled = await cdp.eval('window.__scrollColIntoView(' + JSON.stringify(label) + ')')
  await sleep(120)
  const before = await thOf(cdp, label)
  if (!before.found || !before.handleIsResizer) {
    return { before, ok: false, scrolled }
  }
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: before.handle.x, y: before.handle.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(60)
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: before.handle.x, y: before.handle.y, button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(150)
  return { before, after: await thOf(cdp, label), ok: true }
}

// 右键列头出菜单 → 读一次菜单状态 → 可选点某一项（不点就交给调用方关）
const colMenu = async (cdp, label, pickRe) => {
  const th = await thOf(cdp, label)
  if (!th.found) {
    return { th, info: { open: 0 }, picked: 'no-th' }
  }
  await cdp.rightClick(Math.round(th.left + Math.min(th.used, 40)), Math.round(th.top + 8))
  await sleep(200)
  const info = await menuInfo(cdp)
  let picked = 'skip'
  if (pickRe && info.open === 1) {
    picked = await cdp.eval('window.__clickMenuItem(' + JSON.stringify(pickRe) + ')')
    await sleep(200)
  }
  return { th, info, picked }
}

// 视角存的是**配置宽**（手动宽落库值），与浏览器摊不摊宽无关 —— 数据页判
// "360/720/1200/60 这些数到底存成了多少"只能读这里，DOM 上的宽度在摊宽态下不是配置值
const manualOf = async (cdp, tableRe, col) => {
  const dump = JSON.parse(await cdp.eval('window.__viewDump()'))
  const hit = dump.find(([k]) => tableRe.test(k))
  return hit && hit[1] ? hit[1][col] : undefined
}

// 拖拽后"屏幕真的变宽了"的判据：精确态（顶过容器）下增量就是 dx；
// 摊宽态下配置宽还要被再摊一次，只能判"宽了大半"，不能判相等
const grewBy = (before, after, dx) => after.stretch === 0
  ? after.used === before.used + dx
  : after.used > before.used + Math.round(dx / 2)

// "没被长内容撑爆"的判据：摊宽态下浏览器会把配置宽再放大一次，屏幕上量不出 360
// 这个数，所以这里只判两件与档位无关的事实 —— 表格没有溢出容器（不出现横向滚动条），
// 且单列没吃掉大半个容器。精确封顶值由数据页在"加宽到 720 顶过容器"那一档去证
// （stretch===0 时配置宽原样落到屏幕上）。
const notBlownUp = (th) => th.tableW <= th.wrapW + 2 && th.used <= th.wrapW * 0.75

// 悬停并等卡片出现。两步 prime：
// 1) 先把指针挪到网格外（Chromium 冷启动的首个 mousemove 只定位指针、不派生 hover）；
// 2) 再从外移进目标格 —— 只有"命中目标变了"才派发 mouseover/mouseenter。在同一个
//    格子里挪 1px 不算变化，预览卡因此一直不开（实测首轮就是这么红的）。
// 再用 waitFor 等开卡缓冲过去：固定 sleep 在冷启动首轮会假失败。
// 整轮最多两次：实测同一份代码在不同轮次里"首个格子"会偶发不出卡（第二轮才出，
// 后续格子全绿），是 CDP 指针冷启动的抖动而不是产品行为 —— 真人第一次移动鼠标
// 时系统早就有指针位置了。重试只补偿测试环境，不放宽"截断格必须出卡"这条判据。
const hoverCard = async (cdp, x, y, budget = 3000) => {
  let card = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    await cdp.move(5, 5)
    await sleep(60)
    await cdp.move(x, y)
    await sleep(80)
    await cdp.move(x + 2, y)
    // 探针一律返回 JSON 字符串，所以判据要先 parse（直接 .open 取到 undefined，等满预算再判假）
    const opened = await waitFor(cdp, 'JSON.parse(window.__cardInfo()).open === 1', 'card open', budget)
    card = await cardInfo(cdp)
    if (opened && card.open === 1) {
      return { opened, card, attempts: attempt }
    }
  }
  return { opened: false, card, attempts: 2 }
}

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
  const { opened, card } = await hoverCard(cdp, cell.x, cell.y)
  check(label + '：悬停出预览卡', opened === true && card.open === 1, card)
  // DOM 里有卡 ≠ 看得见：必须真的画在视口里（见 __cardOnScreen 注释）
  // 等一等再量：开卡那一刻 antd 的 zoom-big appear 还在跑（appear-start 是 scale(0)，
  // 量到 0×0）。首轮冷启动要等浏览器把大表格首帧画完，动画才推进到 appear-active，
  // 所以预算给到 5 秒 —— 卡位真错时（-1000vw）等多久都不会绿，不会掩盖问题
  await waitFor(cdp, 'JSON.parse(window.__cardOnScreen()).onScreen === true', 'card paint', 5000)
  const onScreen = JSON.parse(await cdp.eval('window.__cardOnScreen()'))
  check(label + '：卡片真的画在视口内且指针命中（不是 -1000vw 待定位）',
    onScreen.onScreen === true, { ...onScreen, pop: card.pop })
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
  // 每页行数是全局 config，实测会写进真实配置目录（HOME 隔离没生效，落在 ~/.config/electerm）：
  // 先记原值，跑完还原。上一轮遗留的 200 曾把"下一页"合法置灰，让翻页那条检查失去对象
  const cfgPageSize0 = await cdp.eval('window.store._config && window.store._config.dbPageSize')

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
  check('重新悬停能再次开卡', (await hoverCard(cdp, jsonCell.x, jsonCell.y)).card.open === 1)
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
  check('再次开卡（Esc 前置条件）', (await hoverCard(cdp, jsonCell2.x, jsonCell2.y)).card.open === 1)
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  check('Esc 关闭卡片',
    await waitFor(cdp, 'window.__cards().length === 0', 'card close on Esc', 1500))

  // 切页签：指针没动 → 不会有 mouseout，只有"源格消失"的兜底能抓到。
  // 少了这条，卡片会带着上一个页签的内容浮在新页签上（portal 不在被隐藏的 pane 里）
  // 先移开再移回来：指针一直在同一格上不会重新派发 mouseover，React 也就不会
  // 再触发 onMouseEnter，前置条件会假失败（后面那条也跟着假通过）
  await cdp.move(5, 5)
  await sleep(300)
  const preSwitch = (await hoverCard(cdp, jsonCell2.x, jsonCell2.y)).card
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

  // ---------- H1a-2 列宽可控（数据页） ----------
  // 宽度有两套真相，判据必须分开用（详见 __thInfo 注释）：
  // - DOM 上量到的 used/specified 在"摊宽态"下不等于配置宽（实测配置 360 画成 444），
  //   只能判相对量（谁比谁宽、没撑爆、回到拖之前的那一档）
  // - 视角里存的 columnWidths 是配置宽本体，落库值（360/720/1200/60）只能读这里
  const d0 = await thOf(cdp, 'detail')
  check('列头右侧手柄存在、16px 宽、指针命中（拖的是手柄不是列头）',
    d0.found === 1 && d0.handleIsResizer === true && d0.handle && d0.handle.w === 16,
    { hit: d0.handleHit, handle: d0.handle })
  check('列头 title 是翻译后的文案（词条真的进了运行时）',
    /拖动|右键|drag|right click/i.test(d0.hint || ''), { hint: d0.hint })
  const id0 = await thOf(cdp, 'id')
  check('自适应是分列量的：长列明显宽于短列（不再一刀切写死同一个数）',
    d0.stretch === 1 && d0.used > id0.used * 2, { id: id0.used, detail: d0.used, stretch: d0.stretch })
  check('5000 字符的列被自适应封顶：没把表格撑出容器',
    notBlownUp(d0), { used: d0.used, tableW: d0.tableW, wrapW: d0.wrapW })

  // 1) 拖拽起点必须是"实测宽"：摊宽态下配置 360 的列实际画成 444，从配置值起算的话
  //    按下第一帧列会先缩一截（原来就是这个抖动感）。落库值是 445 而不是 361 才算证住
  const dragBase = await dragCol(cdp, 'detail', 1, { steps: 1, probeMid: true })
  await sleep(700)
  const storedBase = await manualOf(cdp, /operation_log/, 'detail')
  check('拖 +1px：落库手动宽 = 实测宽 + 1（起点没跳回配置宽 ' + COL_W.max + '）',
    dragBase.ok && storedBase === d0.used + 1,
    { measuredWas: d0.used, configuredWas: COL_W.max, stored: storedBase })
  check('拖拽结束后列保持拖到的宽度（live 交班给手动宽，抬手不回弹）',
    dragBase.mid && dragBase.after && dragBase.after.used === dragBase.mid.used,
    { during: dragBase.mid && dragBase.mid.used, after: dragBase.after && dragBase.after.used })
  check('拖拽结束摘掉 body 的拖拽态（否则全局禁选中一直挂着）',
    await cdp.eval('window.__bodyResizing()') === false)

  // 2) 拖幅与夹取上下限（落库值判精确，屏幕宽度判"真的变宽"）
  const drag2 = await dragCol(cdp, 'detail', 180)
  await sleep(700)
  const stored2 = await manualOf(cdp, /operation_log/, 'detail')
  check('拖 +180 落库 = 上一轮实测宽 + 180',
    drag2.ok && stored2 === drag2.before.used + 180,
    { from: drag2.before.used, stored: stored2 })
  check('拖 +180 屏幕上真的变宽了（不只是状态里的数字）',
    grewBy(drag2.before, drag2.after, 180), { from: drag2.before.used, to: drag2.after.used })
  const dragMax = await dragCol(cdp, 'detail', 5000)
  await sleep(700)
  check('往右拖过界夹到 ' + COL_W.dragMax + '（落库值与屏幕宽都是它，表格没被拖成彩虹）',
    (await manualOf(cdp, /operation_log/, 'detail')) === COL_W.dragMax &&
      dragMax.after.stretch === 0 && dragMax.after.used === COL_W.dragMax,
    { stored: await manualOf(cdp, /operation_log/, 'detail'), th: dragMax.after })
  // 保底夹取换一列试：上一列已经被拖到 1200，它的手柄跑到窗口右边外面了，
  // 按下去点不到（不是产品问题，是视口边界）—— note 在这一档还看得见
  const dragMin = await dragCol(cdp, 'note', -5000)
  await sleep(700)
  const storedMin = await manualOf(cdp, /operation_log/, 'note')
  check('往左拖过界夹到 ' + COL_W.dragMin + '（落库值与屏幕宽都是它）',
    dragMin.ok && storedMin === COL_W.dragMin &&
      dragMin.after.stretch === 0 && dragMin.after.used === COL_W.dragMin,
    { stored: storedMin, scrolled: dragMin.scrolled, th: dragMin.after })

  // 顺手把保底那一列用菜单收回自适应：既证"自适应本列"对任意列都生效，
  // 又恢复摊宽基线 —— 留着 60 的手动宽会改变其他列被摊到的宽度，后面的
  // "回到拖之前那一档"对比就没有可比对象了
  const noteAuto = await colMenu(cdp, 'note', '自适应本列|auto-fit column')
  await sleep(700)
  const afterNoteAuto = await thOf(cdp, 'note')
  check('菜单"自适应本列"对任意列生效（note 回到自适应保底宽 ' + COL_W.min + '）',
    noteAuto.picked === 'ok' && (await manualOf(cdp, /operation_log/, 'note')) === undefined &&
      afterNoteAuto.stretch === 0 && afterNoteAuto.used === COL_W.min,
    { picked: noteAuto.picked, th: afterNoteAuto })

  // 3) 右键菜单：出得来、画在视口里、命中得了、三项齐全、锚点单例
  const m1 = await colMenu(cdp, 'detail')
  check('右键列头出列宽菜单，且真的画在视口内（不是 -1000vw 待定位）',
    m1.info.open === 1 && m1.info.onScreen === true, m1.info)
  check('菜单锚点非 0 尺寸 + DOM 里只有 1 个（全站单例，不随列数增长）',
    m1.info.anchorVisible === true && m1.info.anchors === 1,
    { anchorRect: m1.info.anchorRect, anchors: m1.info.anchors })
  check('菜单标题显示的是这一列（不是内部键名）', m1.info.head === 'detail', { head: m1.info.head })
  check('菜单三项齐全且加宽那项写着目标宽 ' + COL_W.wide,
    m1.info.items && m1.info.items.length === 3 &&
      m1.info.items.some(t => String(t).includes(String(COL_W.wide))) &&
      m1.info.items.some(t => /自适应本列|auto-fit column/i.test(t)) &&
      m1.info.items.some(t => /自适应全部列|auto-fit all/i.test(t)),
    m1.info.items)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '9-col-menu-dark.png')))
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  check('Esc 关菜单', await waitFor(cdp, 'window.__menus() === 0', 'menu close on Esc', 1500),
    await menuInfo(cdp))

  await colMenu(cdp, 'detail')
  const bodyCell = await cellInfo(cdp, 'DDDDDDDDDDDD')
  await cdp.click(bodyCell.x, bodyCell.y)
  check('在别处按下也关菜单', await waitFor(cdp, 'window.__menus() === 0', 'menu close on outside down', 1500),
    await menuInfo(cdp))
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(150)

  // "滚动关菜单"挪到 8b：这里数据页只有 10 行，整页都在视口内、根本滚不动
  // （probe 报 no-scroller），拿它当"监听器没接住"是冤枉产品 —— 要在真的滚得动的
  // 时候测，所以等每页行数拉到 200 之后再打这一枪

  // 4) 菜单动作：自适应本列 = 删掉这一列的手动宽。
  //    "回到自适应"在屏幕上等价于回到拖之前的那一档实测宽（d0.used），
  //    落库侧等价于这一列从手动宽 map 里消失 —— 两边都要证住
  const beforeAuto = await thOf(cdp, 'detail')
  const mAuto = await colMenu(cdp, 'detail', '自适应本列|auto-fit column')
  await sleep(700)
  const afterAuto = await thOf(cdp, 'detail')
  check('菜单"自适应本列"清掉手动宽并回到自适应（' + beforeAuto.used + ' → ' + d0.used + '）',
    mAuto.picked === 'ok' && (await manualOf(cdp, /operation_log/, 'detail')) === undefined &&
      afterAuto.used === d0.used, { picked: mAuto.picked, was: beforeAuto.used, th: afterAuto })
  check('选完菜单自己收起', await waitFor(cdp, 'window.__menus() === 0', 'menu after pick', 1500))
  const fb1 = await fitBtn(cdp)
  check('全部回到自适应后工具行按钮置灰（点了没反应的按钮不该亮着）',
    fb1.found === 1 && fb1.disabled === true, fb1)
  const tap = await tapHandle(cdp, 'detail')
  check('只按下不移动不留手动宽（手抖点列头不该改宽）',
    tap.ok && (await manualOf(cdp, /operation_log/, 'detail')) === undefined &&
      (await fitBtn(cdp)).disabled === true, tap.after)

  // 5) 加宽到 720：落库是配置宽本体，同时把整表顶过容器 ——
  //    于是"长列封顶 360 / 短列保底 90"这两个摊宽态判不了的精确数可以顺手补上
  const mWide = await colMenu(cdp, 'detail', '加宽到|widen')
  await sleep(700)
  const afterWide = await thOf(cdp, 'detail')
  check('菜单"加宽到 ' + COL_W.wide + '" 落库并画到 ' + COL_W.wide,
    mWide.picked === 'ok' && (await manualOf(cdp, /operation_log/, 'detail')) === COL_W.wide &&
      afterWide.stretch === 0 && afterWide.used === COL_W.wide,
    { picked: mWide.picked, th: afterWide })
  const exactLong = await thOf(cdp, 'parameter')
  const exactShort = await thOf(cdp, 'id')
  check('顶过容器后精确复查自适应：长列封顶 ' + COL_W.max + '、短列保底 ' + COL_W.min,
    exactLong.stretch === 0 && exactLong.used === COL_W.max && exactShort.used === COL_W.min,
    { parameter: exactLong.used, id: exactShort.used, detail: afterWide.used })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '10-col-widened-dark.png')))
  const fb2 = await fitBtn(cdp)
  check('有手动宽时工具行按钮可点', fb2.found === 1 && fb2.disabled === false, fb2)
  await cdp.click(fb2.x, fb2.y)
  await sleep(700)
  const afterFitAll = await thOf(cdp, 'detail')
  check('工具行"自适应全部列"一次清掉本表手动宽（回到自适应档、重新摊宽）',
    afterFitAll.used === d0.used && afterFitAll.stretch === 1 &&
      (await manualOf(cdp, /operation_log/, 'detail')) === undefined &&
      (await fitBtn(cdp)).disabled === true,
    { afterFitAll, other: await manualOf(cdp, /other_tbl/, 'detail') })

  // 6) 持久化：数据页的手动宽写进表视角，且不跨表串味
  const dragSave = await dragCol(cdp, 'detail', 200)
  await sleep(700)
  const saved = await manualOf(cdp, /operation_log/, 'detail')
  check('拖完落盘到该表视角（400ms 防抖后），值 = 上一轮实测宽 + 200 且画在屏上',
    dragSave.ok && saved === dragSave.before.used + 200 && dragSave.after.used === saved,
    { saved, th: dragSave.after })
  await cdp.eval('window.__clickTree("other_tbl")')
  await sleep(600)
  const other = await thOf(cdp, 'detail')
  check('换一张表不继承上一张的手动宽（视角键含表名，另一张表没有手动宽）',
    other.found === 1 && (await manualOf(cdp, /other_tbl/, 'detail')) === undefined &&
      other.stretch === 1, { other, dump: await cdp.eval('window.__viewDump()') })
  await cdp.eval('window.__clickTree("operation_log")')
  await sleep(600)
  const backAgain = await thOf(cdp, 'detail')
  check('切回来还在（手动宽跟着视角走，不是组件内存）',
    (await manualOf(cdp, /operation_log/, 'detail')) === saved && backAgain.used === saved,
    { expect: saved, got: backAgain.used })

  // 7) 翻页保留（重新取数不该重置列宽）。摊宽态下第 2 页的行更短 → 表格更窄 →
  //    浏览器把 644 再摊成 725，所以屏幕宽只能判"不小于配置宽"，
  //    "没被重置"这件事由落库值去判
  //
  //    翻页得先有"下一页"可点：每页行数是**全局 config**，会留在用户配置里跨轮次生效
  //    （实测残留 dbPageSize=200 时 stub 的 200 行正好一页，按钮合法置灰，这条就
  //    没有对象可测）。所以先把页大小钉回 20 —— 10 页，翻得动，也顺便验一次
  //    "换页大小不丢手动宽"。
  const psOpen20 = await cdp.eval('window.__openPageSize()')
  await sleep(350)
  const psPick20 = await cdp.eval('window.__pickPageSize(20)')
  await sleep(900)
  const psText20 = await cdp.eval('window.__pageSizeText()')
  const savedAfterPs = await manualOf(cdp, /operation_log/, 'detail')
  // 页大小一变，自适应宽与摊宽态都会重算 —— 所以"翻回来等于多少"必须拿**同一页大小下**
  // 的第 1 页做基准，不能拿改页大小之前那一轮（行数不同 → 自适应宽不同 → 摊宽态可能翻转）
  const p1base = await thOf(cdp, 'detail')
  const pageNext = await cdp.eval("window.__clickDataPage('next')")
  await sleep(700)
  const onPage2 = await thOf(cdp, 'detail')
  const savedOn2 = await manualOf(cdp, /operation_log/, 'detail')
  await cdp.eval("window.__clickDataPage('prev')")
  await sleep(700)
  const afterPage = await thOf(cdp, 'detail')
  check('翻页前置：每页钉回 20 后手动宽不丢、"下一页"真的点得动',
    psOpen20 === 'ok' && psPick20 === 'ok' && String(psText20).indexOf('20 ') === 0 &&
      savedAfterPs === saved && pageNext === 'ok',
    { psOpen20, psPick20, psText20, savedAfterPs, expect: saved, pageNext })
  check('翻页后列宽保留（落库宽不变，第 2 页不低于它，翻回来与同页大小的第 1 页等宽）',
    savedOn2 === saved && onPage2.used >= saved && afterPage.used === p1base.used,
    { p2: onPage2.used, p2stretch: onPage2.stretch, back: afterPage.used, p1base: p1base.used, expect: saved })

  // 7b) "自适应全部列"只清当前表：先给另一张表也拖出一个手动宽，回到本表点工具行
  //     按钮，另一张表的宽必须原样留着 —— 视角按表名分键，共用一次清宽动作会串味
  await cdp.eval('window.__clickTree("other_tbl")')
  await sleep(600)
  const dragOther = await dragCol(cdp, 'detail', 120)
  await sleep(700)
  const otherSaved = await manualOf(cdp, /other_tbl/, 'detail')
  await cdp.eval('window.__clickTree("operation_log")')
  await sleep(600)
  const fbAll = await fitBtn(cdp)
  await cdp.click(fbAll.x, fbAll.y)
  await sleep(700)
  check('工具行"自适应全部列"只清当前表（另一张表的手动宽与按钮状态互不串味）',
    dragOther.ok && otherSaved === dragOther.before.used + 120 &&
      fbAll.found === 1 && fbAll.disabled === false &&
      (await manualOf(cdp, /operation_log/, 'detail')) === undefined &&
      (await manualOf(cdp, /other_tbl/, 'detail')) === otherSaved,
    { otherSaved, thisTable: (await thOf(cdp, 'detail')).used })
  // 本表重新拖出一个手动宽，后面的帧率项仍以"拖得动"为前置
  await dragCol(cdp, 'detail', 200)
  await sleep(700)

  // 8) 帧率：先把每页行数拉到 200（每页上限就是渲染侧的最坏情况），再慢慢拖 1 秒
  const openPs = await cdp.eval('window.__openPageSize()')
  await sleep(350)
  const pickPs = await cdp.eval('window.__pickPageSize(200)')
  await sleep(900)
  const rows = await cdp.eval("document.querySelectorAll('.ant-table-row').length")
  // 数据页是虚拟滚动，DOM 里恒为视口那几十行 —— 拿行数当判据会把成功的操作判成失败，
  // 所以"拉到 200"读下拉的选中值，rows 只作为帧率样本量报出来
  check('每页行数拉到 200（为帧率准备最坏情况）',
    openPs === 'ok' && pickPs === 'ok' && String(await cdp.eval('window.__pageSizeText()')).indexOf('200') === 0,
    { openPs, pickPs, pageSize: await cdp.eval('window.__pageSizeText()'), domRows: rows })
  // 8b) 滚动关菜单：现在整页 63 行、视口只装得下二十几行，是真的滚得动。
  //     （原来这一步放在只有 10 行的时候做，整页不溢出 → 滚轮无处可滚 →
  //     菜单合理地留着，却被判成"监听没接住"，白追一轮）
  const mScroll = await colMenu(cdp, 'detail')
  // 滚轮落点取网格下沿，不用第一行：列宽菜单是从列头往下开的，正下方那块被浮层
  // 盖着，滚轮打在浮层上等于没滚（实测 probe 一路 climb 到 body，报 no-scroller）
  const gBox = JSON.parse(await cdp.eval(`(() => {
    const g = [...window.__sessionRoot().querySelectorAll('.db-grid-table-wrap')].filter(window.__vis)[0]
    if (!g) {
      return JSON.stringify({ ok: 0 })
    }
    const r = g.getBoundingClientRect()
    return JSON.stringify({ ok: 1, x: Math.round(r.left + 40), y: Math.round(r.bottom - 40) })
  })()`))
  const sx = gBox.x
  const sy = gBox.y
  const sBefore = JSON.parse(await cdp.eval('window.__scrollProbe(' + sx + ',' + sy + ')'))
  await cdp.wheel(sx, sy, 120)
  await sleep(200)
  const sAfter = JSON.parse(await cdp.eval('window.__scrollProbe(' + sx + ',' + sy + ')'))
  const closedByScroll = await waitFor(cdp, 'window.__menus() === 0', 'menu close on scroll', 2500)
  // 三个前置一起钉住：菜单是开着的、落点真的可滚、这次滚轮真的动了它 —— 否则
  // "关没关"这个结论没有意义
  check('滚动时关菜单（不会跟着表格飘 / 停在原地指着别的列）',
    mScroll.info.open === 1 && sBefore.top >= 0 && sAfter.top !== sBefore.top && closedByScroll,
    { open: mScroll.info.open, menus: await cdp.eval('window.__menus()'), gBox, before: sBefore, after: sAfter })
  await cdp.wheel(sx, sy, -120)
  await sleep(200)

  await cdp.eval('window.__fpsStart()')
  await dragCol(cdp, 'detail', 240, { steps: 24, sleepMs: 40 })
  const fps = JSON.parse(await cdp.eval('window.__fpsStop()'))
  // 门杠打在"平均帧率 + p95 帧距"上，最差帧只报不判：本机是 Xvfb + 软件合成，
  // 单次 180~190ms 的毛刺来自合成而不是列宽计算（同一份代码三轮量到 133/183ms），
  // 拿它当回归线会天天红；持续掉帧（平均 <24fps 或 p95 >120ms）才是真信号
  check('拖拽过程不掉帧（' + rows + ' 行 × 慢拖 ~1s：平均 ' + fps.fps + 'fps，p95 帧距 ' + fps.p95Gap + 'ms，最差 ' + fps.worstGap + 'ms）',
    fps.fps >= 24 && fps.p95Gap < 120, { rows, ...fps })

  // 9) 不改数据链路：手柄吃了 mousedown，但单元格的单击/悬停/双击都还在
  const detailCell = await cellInfo(cdp, 'DDDDDDDDDDDD')
  const afterDragCard = (await hoverCard(cdp, detailCell.x, detailCell.y)).card
  check('拖过之后悬停仍出预览卡（手柄没挡住单元格事件）', afterDragCard.open === 1, afterDragCard)
  await cdp.move(5, 5)
  await sleep(300)
  await cdp.click(detailCell.x, detailCell.y)
  check('拖过之后单击仍打开值面板',
    await cdp.eval('!![...document.querySelectorAll(".db-value-pane")].find(window.__vis)') === true)
  await cdp.eval('window.__clickTab("表结构|Structure")')
  await sleep(400)
  // 结构页的列头是 Field/Type/…（值里才有 id），按列头名取列
  const dragClickStruct = await dragCol(cdp, 'Field', 60)
  check('切页签回来点列头不误触排序（拖过之后表头仍可点）',
    dragClickStruct.ok === true && grewBy(dragClickStruct.before, dragClickStruct.after, 60),
    dragClickStruct.after)
  await cdp.eval('window.__clickTab("数据|Data")')
  await sleep(300)

  // 10) 表结构网格：拖拽 + 菜单 + 工具行（长注释列最常超长）。
  //     这里的手动宽只在内存里（结构页不落视角），所以判据用"屏幕相对量 +
  //     回到拖之前那一档"，精确数留给数据页的落库值去判
  await cdp.eval('window.__clickTab("表结构|Structure")')
  await sleep(500)
  // 上面 9) 在结构页拖过 Field。先借工具行按钮清掉：一是顺手证"有手动宽时按钮可点、
  // 点一次全清"，二是让下面的量宽基线回到纯自适应档 —— 拿手动宽当基线，
  // "注释列明显宽于列名列"就变成跟用户拖出来的宽度比大小，说明不了封顶在起作用
  const cfbPre = await fitBtn(cdp)
  await cdp.click(cfbPre.x, cfbPre.y)
  await sleep(500)
  const c0 = await thOf(cdp, 'Comment')
  const cField = await thOf(cdp, 'Field')
  check('结构页工具行"自适应全部列"在有手动宽时可点',
    cfbPre.found === 1 && cfbPre.disabled === false && (await fitBtn(cdp)).disabled === true, cfbPre)
  check('表结构注释列按内容量宽（明显宽于列名列，原来写死 200）',
    c0.found === 1 && c0.handleIsResizer === true && c0.used > cField.used * 1.5,
    { comment: c0.used, field: cField.used, hit: c0.handleHit })
  check('表结构注释列没被内容撑爆（自适应封顶在起作用）',
    notBlownUp(c0), { used: c0.used, tableW: c0.tableW, wrapW: c0.wrapW })
  const dragC = await dragCol(cdp, 'Comment', 150)
  check('表结构列可拖（拖 +150 生效）',
    dragC.ok && grewBy(dragC.before, dragC.after, 150), dragC.after)
  const cMenu = await colMenu(cdp, 'Comment', '自适应本列|auto-fit column')
  check('表结构列头菜单可用且能回到自适应（屏幕宽回到拖之前）',
    cMenu.info.open === 1 && cMenu.info.onScreen === true && cMenu.picked === 'ok' &&
      (await thOf(cdp, 'Comment')).used === c0.used,
    { open: cMenu.info.open, onScreen: cMenu.info.onScreen, picked: cMenu.picked })
  const cfb = await fitBtn(cdp)
  check('菜单只清这一列：清完本列已无手动宽，工具行按钮跟着置灰',
    cfb.found === 1 && cfb.disabled === true, cfb)
  // 一次拖两列再点工具行：证的是"自适应全部列"清的是全部，不是只清最后动的那一列
  const dragC2 = await dragCol(cdp, 'Comment', 150)
  const dragF2 = await dragCol(cdp, 'Field', 80)
  const cfbAll = await fitBtn(cdp)
  await cdp.click(cfbAll.x, cfbAll.y)
  await sleep(500)
  const cAfterAll = await thOf(cdp, 'Comment')
  const fAfterAll = await thOf(cdp, 'Field')
  check('结构页"自适应全部列"一次清掉两列的手动宽',
    dragC2.ok && dragF2.ok && cfbAll.disabled === false &&
      cAfterAll.used === c0.used && fAfterAll.used === cField.used &&
      (await fitBtn(cdp)).disabled === true,
    { comment: cAfterAll.used, base: c0.used, field: fAfterAll.used, fieldBase: cField.used })
  await cdp.eval('window.__clickTab("数据|Data")')
  await sleep(300)

  // 11) SQL 结果网格：翻页/换页大小保留，重新执行才重置
  check('切到 SQL 页签并重跑', await cdp.eval('window.__clickTab("^SQL$")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("QQQQQQQQQQQQ")', 'sql grid'))
  const s0 = await thOf(cdp, 'big_text')
  const sId = await thOf(cdp, 'id')
  check('SQL 结果列按内容量宽（长列明显宽于短列，不再写死 220）',
    s0.found === 1 && s0.handleIsResizer === true && s0.used > sId.used * 2,
    { id: sId.used, big: s0.used, hit: s0.handleHit })
  check('SQL 结果长列没被 6000 字符撑爆（封顶在起作用）',
    notBlownUp(s0), { used: s0.used, tableW: s0.tableW, wrapW: s0.wrapW })
  const dragS = await dragCol(cdp, 'big_text', 200)
  check('SQL 结果列可拖（拖 +200 生效）',
    dragS.ok && grewBy(dragS.before, dragS.after, 200), dragS.after)
  const sqlSaved = dragS.after.used
  const sqlPage = await cdp.eval('window.__clickPage(2)')
  await sleep(500)
  const sqlPage2 = await thOf(cdp, 'big_text')
  check('SQL 结果翻页保留列宽（内存态，不写视角）',
    sqlPage === 'ok' && sqlPage2.used === sqlSaved, { sqlPage, th: sqlPage2 })
  await cdp.eval('window.__clickPage(1)')
  await sleep(400)
  const sqlMenu = await colMenu(cdp, 'big_text')
  check('SQL 结果菜单标题只显示列名（不显示"结果集下标::列名"内部键）',
    sqlMenu.info.head === 'big_text', { head: sqlMenu.info.head })
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(200)
  const sqlViewDumpBefore = await cdp.eval('window.__viewDump()')
  check('SQL 手动宽不写表视角（决策 11：结果集的列随查询变）',
    !sqlViewDumpBefore.includes('"big_text"'), sqlViewDumpBefore)
  await cdp.eval('window.__clickRunSql()')
  await sleep(700)
  const sAfterRun = await thOf(cdp, 'big_text')
  check('重新执行 = 列宽回到自适应（拖过的宽对新结果集没有意义）',
    sAfterRun.used === s0.used && (await fitBtn(cdp)).disabled === true, sAfterRun)
  await cdp.eval('window.__clickTab("数据|Data")')
  await sleep(300)

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
  // H1a-2：Redis 键列表（列头是译文，菜单标题必须跟着显示译文而不是内部键名）。
  // 手动宽同样只在内存里 —— 判据是"相对量 + 回到拖之前那一档"
  const rkThs = JSON.parse(await cdp.eval('window.__thList()'))
  check('Redis 键列表三列都挂上手柄且指针命中（列头统一走 ColHead）',
    rkThs.length === 3 && rkThs.every(t => t.handleIsResizer === true),
    rkThs.map(t => [t.label, t.used, t.handleHit]))
  const nameCol = rkThs[0]
  const rkOthers = rkThs.slice(1)
  check('长键名列按内容量宽（明显宽于类型/TTL 列，原来根本没有宽度）',
    nameCol.used > Math.max(...rkOthers.map(t => t.used)) * 1.5,
    rkThs.map(t => [t.label, t.used]))
  const dragR = await dragCol(cdp, nameCol.label, 120)
  check('键名列可拖（拖 +120 生效）',
    dragR.ok && grewBy(dragR.before, dragR.after, 120), dragR.after)
  const rMenu = await colMenu(cdp, nameCol.label)
  check('键名列菜单标题用译文（不是 name/type/ttl 这类内部键）',
    rMenu.info.open === 1 && rMenu.info.head === nameCol.label,
    { head: rMenu.info.head, label: nameCol.label, open: rMenu.info.open })
  const rPick = await colMenu(cdp, nameCol.label, '自适应全部列|auto-fit all')
  check('键列表"自适应全部列"一次回到自适应（屏幕宽回到拖之前）',
    rPick.picked === 'ok' && (await thOf(cdp, nameCol.label)).used === nameCol.used, rPick.picked)
  const rfb = await fitBtn(cdp)
  check('键列表工具行也有"自适应全部列"且此时置灰', rfb.found === 1 && rfb.disabled === true, rfb)

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
    const lightCard = (await hoverCard(cdp, sqlCell.x, sqlCell.y)).card
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

  // 还原每页行数：没设过就回到产品默认 20，设过就原样还回去
  const backPs = Number(cfgPageSize0) >= 10 ? Number(cfgPageSize0) : 20
  await cdp.eval('window.store.setConfig({ dbPageSize: ' + backPs + ' })')
  await sleep(300)

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
