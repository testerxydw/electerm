#!/usr/bin/env node
/**
 * 数据库网格可读性 + 列宽回归 —— CDP 实机验证（桩数据，无需真 MySQL/Redis）
 *
 * 悬停预览卡已整体移除，"预览"只保留点击后展开的下方值面板。这里要证明的是：
 *   1) 5 处网格（数据页 / 表结构页 / SQL 结果 / Redis 键列表 / Redis 详情）
 *      悬停截断单元格不再渲染任何预览浮层（卡片与 popover 都为 0）；
 *   2) 鼠标扫过多格也不会冒出浮层（没有"悬停洪泛"可防了）；
 *   3) 数据页与 SQL 结果对齐：单击数据格直接展开下方值面板，
 *      中间不再出现提示条；SQL 面板给的是全文（6000 字符逐字符同哈希）；
 *   4) 不改数据链路：数据页双击仍进行内编辑、Esc 退出编辑；
 *   5) 列宽按内容量出来（短列≠长列，长列封顶 360），不再写死 220/200；
 *   6) 拖拽：起点是"实测宽"（不跳回配置宽）、拖幅生效、上下限夹到 [60,1200]、
 *      只按下不移动不留手动宽、过程中不掉帧（200 行/页慢拖 1s 采样）；
 *   7) 列头菜单：画在视口内且命中得到、三项齐全、标题显示这一列（译文）、
 *      Esc/滚动/在别处按下都能关；
 *   8) 落点分层：数据页手动宽写进表视角（切表不串味、切回来还在），
 *      SQL / 表结构 / Redis 键列表只在内存里；
 *   9) 保留与重置：翻页保留列宽；SQL 重新执行才回到自适应；
 *  10) 工具行"自适应全部列"：有手动宽才可点，点完全部回自适应并重新置灰。
 *
 * 用法：
 *   1) npm run compile && rsync -a src/app/ work/app/
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
  // 要验"拖完切表回来还在"，所以视角读写必须真的往返：这里做一个进程内
  // 的 view store（list 回 map、get 回单条、save/remove 改 map），
  // 换成写死 null 的话持久化路径全程空转，那条断言就是假的
  window.__viewStore = {}
  // 复制不做 UI 断言，但仍拦截，避免测试过程污染系统剪贴板
  try {
    window.pre.writeClipboard = () => {}
  } catch (e) {
    // 拦截失败不影响被测行为
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
          { name: 'db0', type: 'database', count: 4 },
          { name: 'db1', type: 'database', count: 0 }
        ])
      }
      if (op === 'getPageData' || op === 'scanKeysToPage') {
        return Promise.resolve({
          rows: [
            { name: F.key, type: 'hash', ttl: -1 },
            { name: 'k1', type: 'string', ttl: 100 },
            // 详情列宽按"键类型"分桶，所以夹具必须同时有 list / zset：
            // hash 的 value 与 list 的 value 是同名字段，只有两种类型都在，
            // "拖一处不该改另一处"才量得出来（只有一种类型时这条判据是空的）
            { name: 'k2', type: 'list', ttl: -1 },
            { name: 'k3', type: 'zset', ttl: -1 }
          ],
          cursors: ['0'], nextCursor: '0', hasMore: false, pageIndex: 0
        })
      }
      if (op === 'getKeyDetail') {
        // k1 走 string 分支（详情本身就是那只面板），长键走 hash 四张表那条 ——
        // 不区分的话"换键后不残留上一格选中态"只能验到同一种类型，换类型的渲染路径没实测对象
        if (String(args.key || '') === 'k1') {
          return Promise.resolve({ type: 'string', value: 'v1', ttl: 100, total: 2 })
        }
        if (String(args.key || '') === 'k2') {
          return Promise.resolve({
            type: 'list',
            // 列表这一列名字与 hash 的 value 相同、内容短得多：自适应宽应明显窄于 hash 那一张
            rows: ['a', 'bb', 'ccc'],
            ttl: -1,
            nextCursor: '0',
            total: 3
          })
        }
        if (String(args.key || '') === 'k3') {
          return Promise.resolve({
            type: 'zset',
            // zrange WITHSCORES 的扁平数组：[member, score, ...]
            rows: ['mmmm-long-member-value', '1', 'n', '2'],
            ttl: -1,
            nextCursor: '0',
            total: 2
          })
        }
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
  // 所有"当前会话内"的判据都按可见根取，跨页签计数才不会串味。
  // 根类名是 db-session-wrap（db-session 这个类不存在，写错了会静默退化成 document）
  window.__sessionRoot = () => [...document.querySelectorAll('.db-session-wrap')]
    .find(window.__vis) || document
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
  // 预览卡已整体移除：悬停不再产生任何浮层。判据分两层 —— DOM 里没有预览卡，
  // 且当前可见的 ant-popover 为 0（列宽菜单不用时也不该有残留浮层）。
  window.__previewDiag = () => JSON.stringify({
    cards: document.querySelectorAll('.db-cell-preview').length,
    popovers: [...document.querySelectorAll('.ant-popover')].filter(window.__vis).length
  })
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
  window.__hash = s => {
    let h = 5381
    for (let i = 0; i < s.length; i++) {
      h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    }
    return String(h)
  }
  // 点击数据格后直接读下方值面板：标题、字符数标注、正文长度与哈希。
  // bar 恒为 0 是"没有中间提示条"的回归判据（旧实现会先出一条 db-sql-value-bar）。
  window.__paneInfo = () => {
    const pane = [...document.querySelectorAll('.db-value-pane')].filter(window.__vis)[0]
    if (!pane) {
      return JSON.stringify({ open: 0, bar: document.querySelectorAll('.db-sql-value-bar').length })
    }
    const pre = pane.querySelector('.db-value-pane-pre')
    const txt = pre ? pre.innerText : ''
    return JSON.stringify({
      open: 1,
      title: (pane.querySelector('.db-grid-title') || {}).innerText || '',
      meta: (pane.querySelector('.db-grid-total') || {}).innerText || '',
      preLen: txt.length,
      preHash: window.__hash(txt),
      bar: document.querySelectorAll('.db-sql-value-bar').length
    })
  }
  // Redis 详情区的分栏几何。详情根 .db-redis-detail 自己还嵌在"键列表 / 详情"
  // 那层分区里，直接 querySelector('.db-split-pane') 会量到外层，判据只认详情里这一张
  window.__redisSplit = () => {
    const p = [...document.querySelectorAll('.db-redis-detail .db-split-pane')].filter(window.__vis)[0]
    if (!p) return JSON.stringify({ found: 0 })
    const b = p.querySelector('.db-split-pane-bottom')
    const g = p.querySelector('.db-grid-table')
    const handle = p.querySelector('.db-split-resizer')
    const r = handle ? handle.getBoundingClientRect() : null
    return JSON.stringify({
      found: 1,
      collapsed: p.className.indexOf('db-split-pane-collapsed') >= 0 ? 1 : 0,
      resizer: handle ? 1 : 0,
      resizerXY: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null,
      bottomH: b ? Math.round(b.getBoundingClientRect().height) : -1,
      paneVis: [...p.querySelectorAll('.db-value-pane')].filter(window.__vis).length,
      gridH: g ? Math.round(g.getBoundingClientRect().height) : -1,
      selCount: p.querySelectorAll('.db-cell-selected').length,
      // Redis 详情的行内编辑容器与数据页不是同一个类名（Redis 走 db-redis-cell-edit）
      editors: p.querySelectorAll('.db-redis-cell-edit').length
    })
  }
  // Redis 详情网格的列头。__thList 铺满整个会话根，会把键列表那 3 个列头也量进来；
  // 详情里"值"列与键列表的列也不是同一张表，判详情必须只看 .db-redis-detail 这一张
  window.__redisDetailThs = () => JSON.stringify(
    [...document.querySelectorAll('.db-redis-detail th')].filter(window.__vis).map(window.__thInfo)
  )
  window.__redisDetailThOf = (label) => {
    const ths = [...document.querySelectorAll('.db-redis-detail th')].filter(window.__vis)
    const nameOf = t => (((t.querySelector('.db-col-name') || {}).innerText || t.innerText || '').trim().split('\\n')[0])
    const th = ths.find(t => nameOf(t).indexOf(label) === 0)
    if (!th) {
      return JSON.stringify({ found: 0, labels: ths.map(nameOf) })
    }
    return JSON.stringify(window.__thInfo(th))
  }
  // 值列拖到 480/720 后手柄会跑出详情区视口，拖之前先把那一列滚进来（同 __scrollColIntoView）
  window.__scrollDetailColIntoView = (label) => {
    const ths = [...document.querySelectorAll('.db-redis-detail th')].filter(window.__vis)
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
  // 关掉 Redis 行内编辑：编辑条上没有 Esc 语义，取消是那只 × 按钮（最后一个按钮）
  window.__cancelRedisEdit = () => {
    const wrap = [...document.querySelectorAll('.db-redis-detail .db-redis-cell-edit')].filter(window.__vis)[0]
    if (!wrap) return 'no-editor'
    const btns = wrap.querySelectorAll('button')
    const cancel = btns[btns.length - 1]
    if (!cancel) return 'no-cancel'
    cancel.click()
    return 'ok'
  }
  // 那一格所在列的列头文字：面板标题前缀要和界面语言一致，所以拿实词来比，
  // 不在判据里写死"值 / value"。
  // 注意：行虚拟渲染时 antd 把 thead 拆进 .ant-table-header 里的另一张 table，
  // 从 td 往上 closest('table') 量不到表头，必须按整个网格容器找列头再按兄弟序号对齐
  window.__cellColLabel = prefix => {
    const c = window.__cellOf(prefix)
    if (!c) return 'no-cell'
    const scope = c.closest('.db-grid-table-wrap') || c.closest('.ant-table-wrapper') || document
    const ths = [...scope.querySelectorAll('thead th')].filter(window.__vis)
    const tr = c.parentElement
    const idx = tr ? [...tr.children].indexOf(c) : -1
    const th = ths[idx]
    return th ? th.innerText.trim() : 'no-th:' + idx + '/' + ths.length
  }
  window.__closePane = () => {
    const pane = [...document.querySelectorAll('.db-value-pane')].filter(window.__vis)[0]
    if (!pane) return 'no-pane'
    const b = [...pane.querySelectorAll('.db-value-pane-head button')]
      .find(x => x.querySelector('.anticon-close'))
    if (!b) return 'no-close'
    b.click()
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
  // 按前缀点键列表里的另一个键（换一个类型，验选中态不跟着键切回来）
  window.__clickRedisKeyAt = prefix => {
    const cell = window.__cellOf(prefix)
    if (!cell) return 'no-key-row:' + prefix
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
  // 多开一个数据库页签就多挂一份 DbColMenu（每个会话一份），
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

// 一条 CDP 协议命令的等待上限。截图在软件合成的 Xvfb 上会慢，所以给到 45 秒：
// 超过它就不是"慢"而是"再也不会回话"，此时必须报错而不是让整套判据停摆
const CDP_CALL_TIMEOUT = 45000

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
    // socket 断了/被顶掉了：把还在等的调用全部判失败。
    // 原来只有 resolve 一条路，连接没了就永远挂着（实测：进程 0% CPU、
    // socket 仍 ESTAB，整套判据停在第 72 条上，只能外部 kill）
    this.ws.on('close', () => this.abort('CDP socket closed'))
    this.ws.on('error', e => this.abort('CDP socket error: ' + e.message))
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString())
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb.resolve(m)
      }
    })
  }

  abort (why) {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    waiting.forEach(cb => cb.reject(new Error(why)))
  }

  call (method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      // 超时也带上 method：红了直接知道卡在哪一条协议上，不用 attach 调试器
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error('CDP timeout after ' + CDP_CALL_TIMEOUT + 'ms: ' + method))
        }
      }, CDP_CALL_TIMEOUT)
      timer.unref()
      this.pending.set(id, {
        resolve: m => { clearTimeout(timer); resolve(m) },
        reject
      })
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

// Redis 详情网格的列头/拖拽/菜单：作用域收在 .db-redis-detail 里（见 __redisDetailThs）
const detailThOf = async (cdp, label) => JSON.parse(await cdp.eval('window.__redisDetailThOf(' + JSON.stringify(label) + ')'))

const dragDetailCol = async (cdp, label, dx) => {
  const scrolled = await cdp.eval('window.__scrollDetailColIntoView(' + JSON.stringify(label) + ')')
  await sleep(120)
  const before = await detailThOf(cdp, label)
  if (!before.found || !before.handleIsResizer) {
    return { before, ok: false, scrolled }
  }
  const endX = await cdp.drag(before.handle.x, before.handle.y, dx, 6, 0)
  await cdp.release(endX, before.handle.y)
  await sleep(150)
  const after = await detailThOf(cdp, label)
  return { before, after, ok: true, scrolled }
}

const detailColMenu = async (cdp, label, pickRe) => {
  const th = await detailThOf(cdp, label)
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

// 悬停一个"必然截断"的格子，等过旧实现的开卡缓冲时长，再断言"没有任何浮层"。
// 指针先移到网格外再移进目标格：Chromium 冷启动的首个 mousemove 只定位指针、
// 不派生 hover，直接在格子内微移可能连 mouseenter 都不派发。
const expectNoPreview = async (cdp, label, prefix, shot) => {
  await cdp.move(5, 5)
  await sleep(60)
  const cell = await cellInfo(cdp, prefix)
  check(label + '：长内容单元格存在且被截断（悬停对象有效）',
    !cell.error && cell.truncated === true, cell)
  if (cell.error) {
    return cell
  }
  await cdp.move(cell.x, cell.y)
  await sleep(120)
  await cdp.move(cell.x + 2, cell.y)
  // 旧实现是 200ms 缓冲 + 开卡动画；留足时间仍为 0，才能说明这段逻辑真的没了
  await sleep(800)
  const diag = JSON.parse(await cdp.eval('window.__previewDiag()'))
  check(label + '：悬停不渲染预览浮层（卡片 0、可见 popover 0）',
    diag.cards === 0 && diag.popovers === 0, diag)
  if (shot) {
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, shot)))
  }
  await cdp.move(5, 5)
  await sleep(120)
  return cell
}

// 点击一个格子 → 下方值面板直接展开（没有"先出提示条、再点提示展开"那一步）
const clickOpenPane = async (cdp, prefix) => {
  const cell = await cellInfo(cdp, prefix)
  if (cell.error) {
    return { cell, opened: false, pane: { open: 0 } }
  }
  await cdp.move(cell.x, cell.y)
  await sleep(80)
  await cdp.click(cell.x, cell.y)
  const opened = await waitFor(cdp,
    '[...document.querySelectorAll(".db-value-pane")].filter(window.__vis).length === 1',
    'value pane', 3000)
  await sleep(150)
  return { cell, opened, pane: JSON.parse(await cdp.eval('window.__paneInfo()')) }
}

// 点一个"必然截断"的格子 → 下方值面板直接展开（与数据页同一交互），
// 正文给全文、标题带列名与行号；收起后面板不留残层
const paneCase = async (cdp, label, prefix, opts = {}) => {
  const { cell, opened, pane } = await clickOpenPane(cdp, prefix)
  check(label + '：长内容单元格存在且被截断（点击对象有效）',
    !cell.error && cell.truncated === true, cell)
  if (cell.error) {
    return
  }
  check(label + '：单击直接展开值面板（没有中间提示条）', opened === true && pane.bar === 0, pane)
  check(label + '：面板标题带列名与行号', /·/.test(String(pane.title)), pane.title)
  if (opts.len !== undefined) {
    check(label + '：面板给的是全文 ' + opts.len + ' 字符', pane.preLen === opts.len, { preLen: pane.preLen })
  }
  if (opts.metaLen) {
    // 词条没落地时这里会露出裸 key / undefined，肉眼在截图里也难发现。
    // "chars/字符"两态都算译文（语言随环境变），只禁裸 key 与 undefined
    check(label + '：字符数标注用全文长度',
      String(pane.meta).indexOf(String(opts.metaLen)) >= 0 &&
        /\d\s*(chars|字符)/i.test(String(pane.meta)) &&
        !/dbCell|undefined/i.test(String(pane.meta)),
      pane.meta)
  }
  if (opts.shot) {
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, opts.shot)))
  }
  const beforeHover = JSON.parse(await cdp.eval('window.__paneInfo()'))
  await expectNoPreview(cdp, label, prefix)
  const afterHover = JSON.parse(await cdp.eval('window.__paneDiag()'))
  const closed = await cdp.eval('window.__closePane()')
  check(label + '：面板 × 收起',
    closed === 'ok' &&
      await waitFor(cdp, 'JSON.parse(window.__paneInfo()).open === 0', 'pane close', 1500),
    { closed, beforeHover: beforeHover.open, afterHover })
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
  // 只认 index.html 会在 compile 清空 assets 的窗口里找不到目标（那时页面落在服务根路径 /）
  const page = targets.find(t => t.type === 'page' &&
    (/index\.html/.test(String(t.url || '')) || /^https?:\/\/127\.0\.0\.1:\d+\/(\?|#|$)/.test(String(t.url || ''))))
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
  check('探针装上（值面板 / 预览浮层计数）',
    await cdp.eval("typeof window.__paneInfo === 'function' && typeof window.__previewDiag === 'function'"))
  // 每页行数是全局 config，实测会写进真实配置目录（HOME 隔离没生效，落在 ~/.config/electerm）：
  // 先记原值，跑完还原。上一轮遗留的 200 曾把"下一页"合法置灰，让翻页那条检查失去对象
  const cfgPageSize0 = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  const cfgSqlPageSize0 = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  const cfgTheme0 = await cdp.eval('String((window.store._config || {}).theme)')

  // ---------- MySQL 会话 ----------
  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  const mysqlId = await cdp.eval(openTab(MYSQL_TAB))
  check('MySQL 页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  await cdp.eval('window.__clickTree("demo_db")')
  check('树里展开并选中数据表',
    await cdp.eval('window.__clickTree("operation_log")') === 'ok' &&
      await waitFor(cdp, '!!window.__cellOf("DDDDDDDDDDDD")', 'data grid long cell'),
    { mysqlId })

  // 1) 数据页：5000 字符 text 列（值面板直接给全文）
  await paneCase(cdp, '数据页 detail(5000)', 'DDDDDDDDDDDD', {
    len: 5000, metaLen: 5000, shot: '1-data-long-text-dark.png'
  })

  // 2) 数据页：JSON 列（网格里只显示 200 字符前缀，面板给全）
  const paramLen = await cdp.eval('window.__fixture.paramText.length')
  await paneCase(cdp, '数据页 parameter(JSON)', '{"uid":1001,', {
    len: paramLen, metaLen: paramLen, shot: '2-data-json-dark.png'
  })

  // 3) 悬停洪泛：旧实现的卡片是悬停触发的，现在扫过去应该一个浮层都不冒
  await expectNoPreview(cdp, '数据页 detail(悬停)', 'DDDDDDDDDDDD')

  // 3b) 表结构页：长注释列悬停同样不出浮层（结构表没有选中/值面板这条路）
  check('切到表结构页签', await cdp.eval('window.__clickTab("表结构|Structure")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("CCCCCCCCCCCC")', 'struct long comment cell'))
  await expectNoPreview(cdp, '表结构 Comment(900)', 'CCCCCCCCCCCC', '3-structure-dark.png')

  // 4) SQL 结果页：悬停不出浮层；单击直接展开下方值面板，正文是全文
  check('切到 SQL 页签', await cdp.eval('window.__clickTab("^SQL$")') === 'ok' &&
    await waitFor(cdp, '!!document.querySelector(".db-sql-area .cm-content")', 'sql editor'))
  check('SQL 编辑器可用', await cdp.eval('window.__typeSql()') === 'focused')
  await cdp.call('Input.insertText', { text: 'select id, flag, big_text from operation_log' })
  await sleep(200)
  const runClicked = await cdp.eval('window.__clickRunSql()')
  check('点击执行按钮', runClicked === 'ok', runClicked)
  check('SQL 结果网格出长单元格', await waitFor(cdp, '!!window.__cellOf("QQQQQQQQQQQQ")', 'sql long cell'))
  await expectNoPreview(cdp, 'SQL 结果 big_text(6000)', 'QQQQQQQQQQQQ', '4-sql-result-dark.png')
  const sqlClick = await clickOpenPane(cdp, 'QQQQQQQQQQQQ')
  check('SQL 结果单击数据格直接展开值面板（与数据页对齐，没有提示条）',
    sqlClick.opened && sqlClick.pane.open === 1 && sqlClick.pane.bar === 0 &&
      sqlClick.pane.title.indexOf('big_text') === 0,
    sqlClick.pane)
  check('SQL 结果面板给出全文 6000 字符并标注字符数',
    sqlClick.pane.preLen === 6000 && /6000\s*chars/i.test(String(sqlClick.pane.meta || '')),
    { preLen: sqlClick.pane.preLen, meta: sqlClick.pane.meta })
  const sqlCellHash = await cdp.eval(`(() => {
    const c = window.__cellOf('QQQQQQQQQQQQ')
    return c ? window.__hash(c.innerText.trim()) : ''
  })()`)
  check('SQL 面板正文与单元格内容逐字符同哈希（真值不走样）',
    !!sqlCellHash && sqlCellHash === sqlClick.pane.preHash,
    { cellHash: sqlCellHash, paneHash: sqlClick.pane.preHash })
  const closedSql = await cdp.eval('window.__closePane()')
  await sleep(300)
  check('SQL 面板 × 收起后网格重新占满（底部不再留半屏）',
    closedSql === 'ok' &&
      await cdp.eval('[...document.querySelectorAll(".db-value-pane")].filter(window.__vis).length === 0') &&
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('.db-split-pane-bottom')].filter(window.__vis)[0]
        return !b || b.getBoundingClientRect().height < 8
      })()`))

  // 5) 数据链路回归：短内容单击同样直接开面板；双击仍进编辑、Esc 退出
  const backToData = await cdp.eval('window.__clickTab("数据|Data")')
  const scrolled = await cdp.eval('window.__scrollTop("short one")')
  await sleep(250)
  const noteCell = await cellInfo(cdp, 'short one')
  check('切回数据页并能定位短内容单元格', backToData === 'ok' && !noteCell.error,
    { backToData, scrolled, noteCell })
  if (!noteCell.error) {
    const noteClick = await clickOpenPane(cdp, 'short one')
    check('数据页单击短内容也直接开面板（与长内容同一路径）',
      noteClick.opened && noteClick.pane.open === 1 && noteClick.pane.bar === 0,
      noteClick.pane)
    await cdp.eval('window.__closePane()')
    await sleep(200)
    await cdp.move(noteCell.x, noteCell.y)
    await sleep(100)
    await cdp.click(noteCell.x, noteCell.y, 2)
    const edited = await waitFor(cdp, '!!document.querySelector(".db-cell-editor")', 'inline editor')
    check('双击单元格仍进入行内编辑', edited, JSON.parse(await cdp.eval('window.__paneDiag()')))
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-inline-edit-dark.png')))
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
    check('Esc 退出编辑', await cdp.eval('!document.querySelector(".db-cell-editor")'))
    await cdp.eval('window.__closePane()')
    await sleep(200)
  }

  // 6) 指针扫过多格：没有"悬停洪泛"可防，但也不能冒出任何浮层
  await cdp.move(5, 5)
  await sleep(100)
  const sweep = JSON.parse(await cdp.eval(`
    (() => {
      const cells = [...document.querySelectorAll('.ant-table-cell')].filter(window.__vis).slice(0, 40)
      cells.forEach(c => c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      return JSON.stringify(Object.assign({ visited: cells.length }, JSON.parse(window.__previewDiag())))
    })()
  `))
  check('扫过几十格后仍无任何预览浮层', sweep.visited >= 20 && sweep.cards === 0 && sweep.popovers === 0, sweep)
  await cdp.move(5, 5)

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

  // 门杠是相对的：本机是共享 Xvfb + 软件合成，别的进程一忙（实测 load≈14）整页
  // 帧率会从 55 掉到 20 上下，绝对阈值会把环境噪声判成列宽回归。先量一段空闲
  // 帧率当基线，再看这次拖拽把帧率压掉了多少。
  await cdp.eval('window.__fpsStart()')
  await sleep(900)
  const idleFps = JSON.parse(await cdp.eval('window.__fpsStop()'))
  await cdp.eval('window.__fpsStart()')
  await dragCol(cdp, 'detail', 240, { steps: 24, sleepMs: 40 })
  const fps = JSON.parse(await cdp.eval('window.__fpsStop()'))
  // 最差帧只报不判：单次 180~190ms 的毛刺来自合成而不是列宽计算。持续掉帧才是
  // 真信号：拖拽期平均帧率不低于空闲基线的 70%，p95 帧距不超基线 p95 的 2 倍
  // （下限 120ms）。基线本身采不到帧时退回原绝对阈值。
  const baseOk = idleFps.frames >= 8 && idleFps.fps > 0
  const fpsFloor = baseOk ? Math.max(1, Math.round(idleFps.fps * 0.7)) : 24
  const p95Ceil = baseOk ? Math.max(120, idleFps.p95Gap * 2) : 120
  check('拖拽过程不掉帧（' + rows + ' 行 × 慢拖 ~1s：平均 ' + fps.fps + 'fps（空闲基线 ' + idleFps.fps + 'fps），p95 帧距 ' + fps.p95Gap + 'ms（上限 ' + p95Ceil + 'ms），最差 ' + fps.worstGap + 'ms）',
    fps.fps >= fpsFloor && fps.p95Gap < p95Ceil,
    { rows, idle: idleFps, fpsFloor, p95Ceil, ...fps })

  // 9) 不改数据链路：手柄吃了 mousedown，但单元格的悬停/单击都还在
  const detailCell = await cellInfo(cdp, 'DDDDDDDDDDDD')
  await cdp.move(detailCell.x, detailCell.y)
  await sleep(600)
  const dragDiag = JSON.parse(await cdp.eval('window.__previewDiag()'))
  check('拖过之后悬停仍不出浮层（手柄没让预览逻辑复活）',
    dragDiag.cards === 0 && dragDiag.popovers === 0, dragDiag)
  await cdp.click(detailCell.x, detailCell.y)
  check('拖过之后单击仍打开值面板',
    await waitFor(cdp,
      '[...document.querySelectorAll(".db-value-pane")].filter(window.__vis).length === 1',
      'pane after drag'))
  await cdp.eval('window.__closePane()')
  await sleep(250)
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
  // 翻页得先有"下一页"：SQL 结果的每页行数也是全局 config（sqlResultPageSize），
  // 上一轮遗留 200 时 200 行正好一页、分页器合法不渲染，这条就没有实测对象。
  // 用产品自己的下拉钉回 20 —— 顺带验一次"换结果页大小不丢手动宽"
  const sqlPsOpen = await cdp.eval('window.__openPageSize()')
  await sleep(350)
  const sqlPsPick = await cdp.eval('window.__pickPageSize(20)')
  await sleep(800)
  const sqlPsText = await cdp.eval('window.__pageSizeText()')
  const sqlSavedAfterPs = await thOf(cdp, 'big_text')
  check('SQL 翻页前置：结果每页钉回 20（分页器出现）且手动宽不丢',
    sqlPsOpen === 'ok' && sqlPsPick === 'ok' && String(sqlPsText).indexOf('20 ') === 0 &&
      sqlSavedAfterPs.used === sqlSaved,
    { sqlPsOpen, sqlPsPick, sqlPsText, used: sqlSavedAfterPs.used, expect: sqlSaved })
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
  const redisId = await cdp.eval(openTab(REDIS_TAB))
  check('Redis 页签打开', await waitFor(cdp,
    "(() => { const t = window.store.tabs.find(x => x.id === window.store.activeTabId); return !!(t && t.dbType === 'redis' && document.querySelector('.db-tree')) })()",
    'redis tab'))
  check('选中 db0 后键列表出长键名', await cdp.eval('window.__clickTree("db0")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("session:user")', 'redis key list'))
  await expectNoPreview(cdp, 'Redis 键列表 name', 'session:user', '6-redis-keys-dark.png')
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
  await expectNoPreview(cdp, 'Redis 详情 hash value(6500)', 'PPPPPPPPPPPP', '7-redis-hash-dark.png')

  // ---------- Redis 详情四张表：单击一格 → 底部只读值面板 ----------
  // 撤掉悬停卡后，长 value 的全文出口只剩这一条，所以这里把"折叠态不占位 / 点击即开 /
  // 全文不走样 / 收起还原 / 与双击行内编辑共存"四件事一次判完
  const redisSplitClosed = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('Redis 详情未选中时分区折叠：面板 0、底栏 0 高、不给拖拽手柄',
    redisSplitClosed.found === 1 && redisSplitClosed.collapsed === 1 &&
      redisSplitClosed.paneVis === 0 && redisSplitClosed.bottomH < 8 &&
      redisSplitClosed.resizer === 0, redisSplitClosed)
  const redisColLabelRaw = await cdp.eval('window.__cellColLabel("PPPPPPPPPPPP")')
  check('取到 value 列的列头译文（面板标题前缀有比对对象）',
    !!redisColLabelRaw && !redisColLabelRaw.startsWith('no-'), redisColLabelRaw)
  const redisClick = await clickOpenPane(cdp, 'PPPPPPPPPPPP')
  check('Redis 详情单击数据格直接展开值面板（与数据页/SQL 结果同一交互）',
    redisClick.opened && redisClick.pane.open === 1 && redisClick.pane.bar === 0,
    { opened: redisClick.opened, pane: redisClick.pane })
  check('Redis 详情面板标题 = 这一列的列头译文 + 行号',
    String(redisClick.pane.title).indexOf(redisColLabelRaw) === 0 &&
      /第\s*1\s*行|row\s*1\b/i.test(String(redisClick.pane.title)),
    { title: redisClick.pane.title, col: redisColLabelRaw })
  check('Redis 详情面板给出全文 6500 字符并标注字符数',
    redisClick.pane.preLen === 6500 && /6500\s*(chars|字符)/i.test(String(redisClick.pane.meta || '')),
    { preLen: redisClick.pane.preLen, meta: redisClick.pane.meta })
  const redisCellHash = await cdp.eval(`(() => {
    const c = window.__cellOf('PPPPPPPPPPPP')
    return c ? window.__hash(c.innerText.trim()) : ''
  })()`)
  check('Redis 详情面板正文与单元格内容逐字符同哈希（全文不走样）',
    !!redisCellHash && redisCellHash === redisClick.pane.preHash,
    { cellHash: redisCellHash, paneHash: redisClick.pane.preHash })
  const redisSplitOpen = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('选中格有选中态、分区展开后底栏占到高度、网格随之压矮',
    redisSplitOpen.selCount === 1 && redisSplitOpen.collapsed === 0 &&
      redisSplitOpen.paneVis === 1 && redisSplitOpen.bottomH > 40 &&
      redisSplitOpen.resizer === 1 && redisSplitOpen.gridH < redisSplitClosed.gridH,
    { closed: redisSplitClosed, open: redisSplitOpen })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '7b-redis-hash-pane-dark.png')))
  await expectNoPreview(cdp, 'Redis 详情面板展开时悬停', 'PPPPPPPPPPPP')
  // 单击不抢双击的行内编辑：D 批那条写路径还在（面板开了也能进编辑）
  await cdp.move(redisClick.cell.x, redisClick.cell.y)
  await sleep(100)
  await cdp.click(redisClick.cell.x, redisClick.cell.y, 2)
  await sleep(400)
  const redisEdited = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('Redis 详情双击 value 仍进入行内编辑（单击选中没有抢走这条路径）',
    redisEdited.editors === 1, redisEdited)
  const cancelled = await cdp.eval('window.__cancelRedisEdit()')
  await sleep(300)
  const afterCancel = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('取消 Redis 行内编辑后面板仍在（编辑不影响选中）',
    cancelled === 'ok' && afterCancel.editors === 0 && afterCancel.paneVis === 1 &&
      afterCancel.selCount === 1, { cancelled, after: afterCancel })
  const closedRedis = await cdp.eval('window.__closePane()')
  await sleep(400)
  const redisSplitAfterClose = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('Redis 详情面板 × 收起后分区回到折叠、网格还原全高',
    closedRedis === 'ok' && redisSplitAfterClose.collapsed === 1 &&
      redisSplitAfterClose.paneVis === 0 && redisSplitAfterClose.selCount === 0 &&
      redisSplitAfterClose.gridH === redisSplitClosed.gridH,
    { closedRedis, after: redisSplitAfterClose, before: redisSplitClosed })
  // 短值走同一条路径，只是不挂字符数（一格本来就装得下，标注是噪音）
  const fieldColLabelRaw = await cdp.eval('window.__cellColLabel("payload")')
  const fieldClick = await clickOpenPane(cdp, 'payload')
  check('Redis 详情短内容单击也直接开面板（与长内容同一路径、不挂字符数）',
    fieldClick.opened && fieldClick.pane.open === 1 && fieldClick.pane.meta === '' &&
      String(fieldClick.pane.title).indexOf(fieldColLabelRaw) === 0,
    { title: fieldClick.pane.title, meta: fieldClick.pane.meta, col: fieldColLabelRaw })
  await cdp.eval('window.__closePane()')
  await sleep(250)
  // 换一个键 = 重新取详情，上一格的选中态不能带过去（面板指向的是已经不存在的行）
  await cdp.eval('window.__clickRedisKeyAt("k1")')
  await sleep(700)
  const redisSwitched = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('切到另一个键（string 详情本身就是面板）：详情分区不残留、走 string 那条渲染',
    redisSwitched.found === 0 &&
      await waitFor(cdp, "!!document.querySelector('.db-redis-detail .db-value-pane')", 'string pane'))
  await cdp.eval('window.__clickRedisKey()')
  await sleep(700)
  const redisBack = JSON.parse(await cdp.eval('window.__redisSplit()'))
  check('切回 hash 键后分区回到折叠（选中态没跟着键切回来）',
    redisBack.found === 1 && redisBack.collapsed === 1 && redisBack.selCount === 0, redisBack)

  // ---------- Redis 详情列宽：5 张表接同一套手柄 / 菜单 / 四源优先级 ----------
  // 量的是 .db-redis-detail 里那一张表（__thList 会把键列表 3 个列头一起量进来）
  const detailHashThs = JSON.parse(await cdp.eval('window.__redisDetailThs()'))
  check('Redis 详情 hash 表三列：两个数据列挂手柄、操作列不挂（与数据页同一规则）',
    detailHashThs.length === 3 && detailHashThs[0].handleIsResizer === true &&
      detailHashThs[1].handleIsResizer === true && detailHashThs[1].handle !== null &&
      detailHashThs[2].handle === null && detailHashThs[2].label === '',
    detailHashThs.map(t => [t.label, t.used, t.handleIsResizer]))
  const hashValueLabel = detailHashThs[1].label
  check('详情长 value 列按内容量宽（明显宽于字段列；原来写死 220 不看内容）',
    detailHashThs[1].used > detailHashThs[0].used * 1.5,
    detailHashThs.map(t => [t.label, t.used]))
  const dMenu = await detailColMenu(cdp, hashValueLabel)
  check('详情列头菜单标题用译文（不是内部键 value）',
    dMenu.info.open === 1 && dMenu.info.head === hashValueLabel,
    { head: dMenu.info.head, label: hashValueLabel, open: dMenu.info.open })
  const dWide = await detailColMenu(cdp, hashValueLabel, '加宽到|widen')
  const dWideAfter = await detailThOf(cdp, hashValueLabel)
  // 详情表只有三列，720 的配置宽还不到容器宽 → 仍在摊宽态，屏幕上量不出 720。
  // 这一档只判"菜单项写着内容算出的目标宽 + 点下去这一列吃掉大半张表"；
  // 配置宽原样落到屏幕，留给下面把字段列拖到顶过容器之后再逐像素验证
  check('详情"加宽到"项写着按内容算出的目标宽，点下去 value 列吃掉大半张表',
    dWide.picked === 'ok' &&
      dWide.info.items.some(t => t.indexOf(String(COL_W.wide)) >= 0) &&
      dWideAfter.used > dWide.th.used * 1.1 && dWideAfter.used > dWideAfter.tableW * 0.75,
    { items: dWide.info.items, before: dWide.th.used, after: dWideAfter.used, table: dWideAfter.tableW })
  // 精确态：把字段列拖到顶过容器，此时 used 就是配置宽本体，value 的 720 才能逐像素验证
  const dField = await dragDetailCol(cdp, detailHashThs[0].label, 800)
  const dFieldAfter = await detailThOf(cdp, detailHashThs[0].label)
  const fieldExpect = Math.min(COL_W.dragMax, Math.round(dField.before.used) + 800)
  check('详情字段列可拖，拖到顶过容器后画到的就是拖出来的配置宽 ' + fieldExpect,
    dField.ok && dFieldAfter.stretch === 0 && dFieldAfter.used === fieldExpect,
    { from: dField.before.used, to: dFieldAfter.used, expect: fieldExpect, stretch: dFieldAfter.stretch })
  const valuePrecise = await detailThOf(cdp, hashValueLabel)
  check('精确态下 value 列画到的就是菜单写进去的 ' + COL_W.wide + '（加宽没停在菜单标签上）',
    valuePrecise.stretch === 0 && valuePrecise.used === COL_W.wide,
    { stretch: valuePrecise.stretch, used: valuePrecise.used })

  // 同名 value 列跨键类型不能串：hash 加宽过，list 的自适应宽应还是内容宽
  check('切到 list 键（同名 value 列的详情）',
    await cdp.eval('window.__clickRedisKeyAt("k2")') === 'ok' &&
      await waitFor(cdp, '!!window.__cellOf("bb")', 'redis list detail'))
  const detailListThs = JSON.parse(await cdp.eval('window.__redisDetailThs()'))
  check('Redis 详情 list 表：序号列不挂手柄（只有数据列可拖）',
    detailListThs.length === 3 && detailListThs[0].label === '#' &&
      detailListThs[0].handle === null && detailListThs[1].handleIsResizer === true,
    detailListThs.map(t => [t.label, t.used, t.handleIsResizer]))
  check('list 详情的同名 value 列不继承 hash 的 ' + COL_W.wide + '（详情列宽按键类型分桶）',
    detailListThs[1].label === hashValueLabel &&
      detailListThs[1].used < dWideAfter.used * 0.75,
    { label: detailListThs[1].label, used: detailListThs[1].used, hashUsed: dWideAfter.used })
  const dragL = await dragDetailCol(cdp, detailListThs[1].label, 80)
  check('list 详情 value 列可拖（拖 +80 生效，改的是 list 自己那一桶）',
    dragL.ok && grewBy(dragL.before, dragL.after, 80),
    { from: dragL.before.used, to: dragL.after.used })
  const listAll = await detailColMenu(cdp, detailListThs[1].label, '自适应全部列|auto-fit all')
  const listAfterAll = await detailThOf(cdp, detailListThs[1].label)
  check('详情"自适应全部列"把 list 这一桶清回自适应（回到拖之前那一档）',
    listAll.picked === 'ok' && listAfterAll.used === detailListThs[1].used,
    { picked: listAll.picked, used: listAfterAll.used, expect: detailListThs[1].used })
  await cdp.eval('window.__clickRedisKey()')
  check('切回 hash 详情网格', await waitFor(cdp, '!!window.__cellOf("PPPPPPPPPPPP")', 'redis hash back'))
  const hashBackTh = await detailThOf(cdp, hashValueLabel)
  const hashBackField = await detailThOf(cdp, detailHashThs[0].label)
  check('切回 hash 后两列手动宽都还在（"自适应全部列"只清当前键类型那一桶）',
    hashBackTh.used === valuePrecise.used && hashBackField.used === fieldExpect,
    { value: hashBackTh.used, field: hashBackField.used, expectValue: valuePrecise.used, expectField: fieldExpect })

  // zset：成员列是会变长的那一列，分数列是数字 —— 自适应宽必须体现这个差别
  check('切到 zset 键', await cdp.eval('window.__clickRedisKeyAt("k3")') === 'ok' &&
    await waitFor(cdp, '!!window.__cellOf("mmmm-long-member")', 'redis zset detail'))
  const detailZsetThs = JSON.parse(await cdp.eval('window.__redisDetailThs()'))
  check('Redis 详情 zset：member 列明显宽于 score 列（score 原来写死 150，member 反而不设宽）',
    detailZsetThs.length === 3 && detailZsetThs[0].handleIsResizer === true &&
      detailZsetThs[1].handleIsResizer === true &&
      detailZsetThs[0].used > detailZsetThs[1].used * 1.5,
    detailZsetThs.map(t => [t.label, t.used, t.handleIsResizer]))
  await cdp.eval('window.__clickRedisKey()')
  await waitFor(cdp, '!!window.__cellOf("PPPPPPPPPPPP")', 'redis hash back 2')

  // ---------- 浅色主题复查（值面板配色全部走 token） ----------
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(800)
    const themeNow = await cdp.eval('window.store._config && window.store._config.theme')
    await cdp.eval('window.store.changeActiveTabId(' + JSON.stringify(mysqlId) + ')')
    await cdp.eval('window.__clickTab("^SQL$")')
    await sleep(600)
    const sqlCell = await cellInfo(cdp, 'QQQQQQQQQQQQ')
    await cdp.move(sqlCell.x, sqlCell.y)
    await sleep(120)
    await cdp.move(sqlCell.x + 2, sqlCell.y)
    await sleep(700)
    const lightDiag = JSON.parse(await cdp.eval('window.__previewDiag()'))
    check('浅色主题下 SQL 结果悬停仍无浮层',
      lightDiag.cards === 0 && lightDiag.popovers === 0, lightDiag)
    const lightClick = await clickOpenPane(cdp, 'QQQQQQQQQQQQ')
    check('浅色下单击仍直接展开面板且给出全文',
      lightClick.opened && lightClick.pane.open === 1 && lightClick.pane.preLen === 6000,
      lightClick.pane)
    const colors = JSON.parse(await cdp.eval(`
      (() => {
        const pre = [...document.querySelectorAll('.db-value-pane-pre')].filter(window.__vis)[0]
        if (!pre) return '{}'
        const s = getComputedStyle(pre)
        return JSON.stringify({ color: s.color, bg: s.backgroundColor, mono: /mono|Consolas|Menlo|monospace/i.test(s.fontFamily) })
      })()
    `))
    check('浅色下面板正文有对比度（前景≠背景）',
      !!colors.color && colors.color !== colors.bg && colors.mono === true, { theme: themeNow, colors })
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '8-sql-result-light.png')))
    await cdp.eval('window.__closePane()')
    await cdp.move(5, 5)
    await sleep(340)
  }

  // 还原每页行数：没设过就回到产品默认 20，设过就原样还回去
  const backPs = Number(cfgPageSize0) >= 10 ? Number(cfgPageSize0) : 20
  await cdp.eval('window.store.setConfig({ dbPageSize: ' + backPs + ' })')
  // SQL 结果的每页行数是另一条 config（sqlResultPageSize），同样要还原：
  // 它留着 20 会让下一轮真库测的分页判据跑在别的页大小上
  const backSqlPs = Number(cfgSqlPageSize0) >= 10 ? Number(cfgSqlPageSize0) : 20
  await cdp.eval('window.store.setConfig({ sqlResultPageSize: ' + backSqlPs + ' })')
  // 主题也还原：这一轮的浅色复查会把 setTheme 落进真实配置目录，
  // 留着浅色交给下一份脚本，等于让它在没预期的调色板下跑
  await cdp.eval('window.store.setTheme(' + JSON.stringify(cfgTheme0) + ')')
  // 本脚本开的两个桩页签（mysql / redis quick-connect）会被持久化恢复：
  // 留着它们，下一份脚本 Page.reload 后的异步恢复过程会把 activeTabId 改成它们自己，
  // 于是真库判据读的是这份桩数据的树（demo_db）而不是真库的（tgfsom）—— 假故障
  for (const id of [mysqlId, redisId]) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  await sleep(600)
  const leftTabs = await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database').map(t => t.title))")
  console.log('leftover db tabs after cleanup: ' + leftTabs)
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
