#!/usr/bin/env node
/**
 * H1a-3 · 字段类型契约（columns[].type）—— CDP 实机验收（桩数据，无需真 MySQL）
 *
 * 设计文档 §1A.5 的验收口径落在"看得见"的四件事上，全部实测：
 *   A) 类型契约接通：SQL 结果的数值列右对齐，非数值列一律不右对齐
 *      —— varchar/text/blob/json/date/datetime/timestamp/time/未知类型都不能中枪，
 *      "宁可不格式化，也不能把 varchar 右对齐"是这一批唯一不能退让的边界。
 *   B) 本地化真的生效：E2-3b 的开关此前对 SQL 结果是**空转**的
 *      （`render: renderCell` 把 antd 传进来的行下标当成了 dataType，
 *      于是格式化的是"类型名 = 0/1/2…"这种不存在的名字）。
 *      H1a-3 把类型从 columns 传进来之后，开关必须在 SQL 结果上出效果。
 *   C) 多结果集不串味：两个结果集里同名列类型不同时，各用自己的类型表。
 *   D) 老结果回落：适配器没给 columns 时（旧版本/未覆盖的引擎），
 *      既不右对齐也不按类型格式化 —— 只有驱动本身给出 JS number 才分组。
 *   E) 数据页同一条判定（colTypeByName）不回归，且 H1a-2 的拖拽/预览/编辑/值面板共存。
 *
 * 不验但已在单测锁住的：驱动字段名口径（mysql2 characterSet / pg dataTypeID）、
 * PG 类型名词表对齐、数组类型回落 ''。真库 MySQL 实测 = 待环境
 * （本机无容器运行时、无本地 mysqld，192.168.115.67:13306 当前不可达）。
 *
 * 用法：
 *   1) npm run compile
 *      + cp src/app/common/db-type-normalize.js work/app/common/
 *      + cp src/app/lib/db-client/{mysql,postgres}.js work/app/lib/db-client/
 *      （compile 只打 client 包，不同步 src/app）
 *   2) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a3/home \
 *        ELECTRON_RUN_AS_NODE= ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *      （9225 必须空着：第二个实例 bind 失败会静默退出，本脚本会连到上一轮的
 *       老实例，继承它的内存态 config，测试结果就不可信）
 *   3) node self-test/db-sql-type-contract-demo.js [debugPort] [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-type-contract-shots')

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

// 夹具值刻意混着三种形态，覆盖 safeCell 出来的真实线格式：
// - bigint 在驱动里是 BigInt → 主进程转成字符串（所以数值列的值经常不是 JS number）
// - decimal 走 toJSON → 字符串
// - int/double 仍是 JS number
// 只看"有没有右对齐"证明不了 B 组，必须让字符串和数字各自的分支都被跑到。
const FIXTURE = `
(() => {
  const F = window.__fixture = {
    bin: { __bin: { size: 8, b64: 'AAECAwQFBgc=', truncated: false } },
    js: { uid: 1001, act: 'order.export' },
    longT: 'T'.repeat(5000)
  }
  window.__dbStubCalls = []
  window.__sqlMode = 'typed'
  window.__lastSql = null
  window.__viewStore = {}

  // SQL 结果的两个结果集：rs0 是标准类型光谱，rs1 故意把 rs0 的列名重用一遍
  // 但换类型 —— 这是"分结果集类型表"唯一能被证伪的写法
  const TYPED_COLS = [
    { name: 'id', type: 'bigint' },
    { name: 'amount', type: 'decimal' },
    { name: 'qty', type: 'int' },
    { name: 'ratio', type: 'double' },
    { name: 'flag', type: 'varchar' },
    { name: 'note', type: 'text' },
    { name: 'blob_col', type: 'blob' },
    { name: 'json_col', type: 'json' },
    { name: 'created_at', type: 'datetime' },
    { name: 'due_date', type: 'date' },
    { name: 'stamp', type: 'timestamp' },
    { name: 'clock', type: 'time' },
    { name: 'mystery', type: '' }
  ]
  const typedRow = i => ({
    id: i,                            // JS number（bigint 驱动也可能给数字）
    amount: '1234567.8901',           // 字符串 + decimal 类型 → 靠类型才分组
    qty: 42,
    ratio: -3.5,
    flag: 'ok',
    note: 'note-' + i,
    blob_col: F.bin,
    json_col: F.js,
    created_at: '2026-01-05 08:30:00',
    due_date: '2026-02-20',
    // 故意用 +05:00 而不是 Z：Z（UTC 00:30）在 UTC+8 机器上本地正好等于 08:30，
    // 与 created_at 的"无时区按本地"分支输出同一个串 —— 两条分支就区分不开了。
    // 带偏移后无论跑在哪个时区，zoned 与 naive 的串都不同一天或不同一小时。
    stamp: '2026-01-05T00:30:00+05:00',
    clock: '10:30:00',
    // 长得像 datetime，但类型未知：任何形式的"改写"都是猜错了
    mystery: '2026-01-05 08:30:00'
  })
  const typedRows = [typedRow(1234567), typedRow(1234568), typedRow(1234569)]

  window.__sqlResults = () => {
    if (window.__sqlMode === 'notypes') {
      // 老适配器/未覆盖引擎：只有 fields，没有 columns
      return [{
        sql: window.__lastSql,
        fields: ['id', 'amount', 'flag', 'created_at'],
        rows: [
          { id: 1234567, amount: '1234567.8901', flag: 'ok', created_at: '2026-01-05 08:30:00' },
          { id: 7654321, amount: '99.5', flag: 'no', created_at: '2026-12-31 23:59:59' }
        ]
      }]
    }
    return [
      { sql: window.__lastSql, fields: TYPED_COLS.map(c => c.name), columns: TYPED_COLS, rows: typedRows },
      {
        sql: 'second',
        fields: ['id', 'amount'],
        columns: [{ name: 'id', type: 'varchar' }, { name: 'amount', type: 'text' }],
        rows: [{ id: 'A-1', amount: 'not-a-number' }, { id: 'A-2', amount: '1234567' }]
      }
    ]
  }

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
    const op = a[1]
    const args = a[2] || {}
    window.__dbStubCalls.push(op)
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo_db',
        type: 'database',
        children: [
          { name: 'typed_tbl', type: 'table' },
          { name: 'other_tbl', type: 'table' }
        ]
      }])
    }
    if (op === 'describeTable') {
      return Promise.resolve([
        { Field: 'id', Type: 'bigint', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment', Comment: '' },
        { Field: 'amount', Type: 'decimal(18,4)', Null: 'YES', Key: '', Default: null, Extra: '', Comment: '' }
      ])
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: [
          { name: 'id', dataType: 'bigint', isPk: true },
          { name: 'amount', dataType: 'decimal' },
          { name: 'qty', dataType: 'int' },
          { name: 'flag', dataType: 'varchar' },
          { name: 'note', dataType: 'text' },
          { name: 'blob_col', dataType: 'blob' },
          { name: 'created_at', dataType: 'datetime' },
          { name: 'mystery', dataType: '' }
        ],
        foreignKeys: []
      })
    }
    if (op === 'getPageData') {
      const rows = []
      for (let i = 1; i <= 40; i++) {
        rows.push({
          id: i === 1 ? 1234567 : i,
          amount: '1234567.8901',
          qty: 42,
          flag: i % 2 ? 'ok' : 'no',
          note: i === 1 ? F.longT : 'note-' + i,
          blob_col: F.bin,
          created_at: '2026-01-05 08:30:00',
          mystery: '2026-01-05 08:30:00'
        })
      }
      const page = args.page || 1
      const ps = args.pageSize || 20
      const start = (page - 1) * ps
      return Promise.resolve({
        rows: rows.slice(start, start + ps),
        totalRows: rows.length,
        page,
        hasMore: start + ps < rows.length
      })
    }
    if (op === 'countRows') return Promise.resolve({ count: 40 })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'executeSql') {
      window.__lastSql = args.sql
      return Promise.resolve({ results: window.__sqlResults() })
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
  window.__sessionRoot = () => [...document.querySelectorAll('.db-session-wrap')]
    .find(window.__vis) || document

  window.__clickTree = text => {
    const nodes = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(n => window.__vis(n) && n.innerText.trim().indexOf(text) >= 0)
    if (!nodes.length) return 'no-node:' + text
    nodes[0].click()
    return 'ok'
  }
  // 树节点是懒加载的：点库节点之后才异步出表节点。
  // 等待必须用"存在性"判据，不能用 __clickTree 的返回值 —— 它永远返回非空字符串
  window.__hasTree = text => !![...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
    .find(n => window.__vis(n) && n.innerText.trim().indexOf(text) >= 0)
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
  window.__cellOf = prefix => {
    const p = prefix.substring(0, 12)
    const all = [...document.querySelectorAll('.ant-table-cell')].filter(window.__vis)
    return all.find(c => c.innerText.trim().substring(0, 12) === p) || null
  }
  window.__focusSql = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return 'no-editor'
    ed.focus()
    return document.activeElement === ed ? 'focused' : 'not-focused'
  }
  // CodeMirror6 不认合成的 beforeinput（只认浏览器原生插入），所以文本必须由 node 侧
  // 用 CDP Input.insertText 注进**已聚焦**的编辑器；这里只负责聚焦与读回 doc 外观。
  // 读回是必需的：runSql 拿空串会被直接挡回，结果网格永远不出现，
  // 后面所有判据就都变成"没找到列"。
  window.__sqlDoc = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return 'no-editor'
    return String(ed.innerText || '').trim().substring(0, 120)
  }
  window.__lastSqlOf = () => String(window.__lastSql)
  window.__runBtn = () => {
    const bars = [...document.querySelectorAll('.db-sql-bar')].filter(window.__vis)
    if (!bars.length) return { found: 0 }
    const b = [...bars[0].querySelectorAll('button')].find(x =>
      /^(执行|runsql|run)$/i.test(x.innerText.replace(/\\s/g, '')))
    if (!b) return { found: 0, btns: [...bars[0].querySelectorAll('button')].map(x => x.innerText.trim()) }
    return { found: 1, disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true' }
  }
  window.__clickRunSql = () => {
    const bars = [...document.querySelectorAll('.db-sql-bar')].filter(window.__vis)
    if (!bars.length) return 'no-bar'
    const b = [...bars[0].querySelectorAll('button')].find(x =>
      /^(执行|runsql|run)$/i.test(x.innerText.replace(/\\s/g, '')))
    if (!b) return 'no-run-btn'
    b.click()
    return 'ok'
  }

  // 日期判据的参考值必须在页面里用同一套 Intl 选项现算。原因：zh-CN 下 datetime 的
  // 本地格式与原文只差一个窄空格，"不等于原文"这种判据会假绿 —— 看着测到了本地化，
  // 其实什么都没测。两边同 locale 比较，判据才与跑它的机器无关。
  // kind: 'd' 纯日期（UTC 取日期部分）/ 'dt-naive' 无时区串（按本地解释）/
  //       'dt' 带时区串（绝对时刻换本地）/ 't' 纯时刻（不掺日期）
  window.__fmtRef = (raw, kind) => {
    const D = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'utc' }
    const DT = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    const T = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    let d
    if (kind === 'd') {
      d = new Date(raw + 'T00:00:00Z')
    } else if (kind === 't') {
      const p = raw.split(':')
      d = new Date(1970, 0, 1, Number(p[0]), Number(p[1]), Number(p[2] || 0))
    } else {
      d = new Date(kind === 'dt-naive' ? raw.replace(' ', 'T') : raw)
    }
    if (isNaN(d.getTime())) return 'invalid'
    return new Intl.DateTimeFormat(undefined, kind === 'd' ? D : kind === 't' ? T : DT).format(d)
  }

  // 一列的"落地效果"读法：class（我们写的）+ computed text-align（浏览器实际画的）
  // + font-variant-numeric + 可见文本。只看 class 就是"改了代码没管效果"。
  // 行的形状两种：非虚拟是 tr.ant-table-row，虚拟（scroll.y 生效）是
  // div.ant-table-row + div.ant-table-cell（实测 antd6 虚拟体是 .ant-table-tbody-virtual，
  // 根本没有 tbody）—— 所以按 class 找行，别写死 tbody/tr。
  window.__colMap = gridSel => {
    const grids = [...document.querySelectorAll(gridSel)].filter(window.__vis)
    if (!grids.length) return JSON.stringify({ error: 'no-visible-grid:' + gridSel + ' total=' + document.querySelectorAll(gridSel).length })
    const grid = grids[0]
    const head = grid.querySelector('.ant-table-header') || grid
    const ths = [...head.querySelectorAll('thead th')].filter(t =>
      !/cell-scrollbar|ant-table-measure/.test(t.className || ''))
    const rows = [...grid.querySelectorAll('.ant-table-row')].filter(window.__vis)
    const cols = ths.map((th, idx) => {
      const tds = rows.map(r => r.children[idx]).filter(Boolean)
      const first = tds[0]
      const s = first ? getComputedStyle(first) : null
      // 列名取 .db-col-name（H1a-2 的 ColHead 结构）：注释显示在第二行，别把它当列名
      const nameEl = th.querySelector('.db-col-name')
      const label = ((nameEl && nameEl.innerText) || th.innerText || '').trim().split('\\n')[0]
      // H1a-2 的几何契约：手柄压在表头右沿（right:0 + z-index:2）。
      // 数值列右对齐若把列名推到那儿，鼠标划过文字就变成 col-resize —— 这里量命中
      const handle = th.querySelector('.db-col-resizer')
      const hr = handle ? handle.getBoundingClientRect() : null
      const hit = hr
        ? document.elementFromPoint(Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2))
        : null
      return {
        idx,
        label,
        thAlign: getComputedStyle(th).textAlign,
        // 列名右沿到手柄左沿的余量：数值右对齐后列名会不会顶进热区，看这个数
        nameGap: hr && nameEl ? Math.round(hr.left - nameEl.getBoundingClientRect().right) : null,
        handleHit: hit ? (String(hit.className) || hit.tagName) : 'none',
        handleIsResizer: !!hit && !!hit.closest && !!hit.closest('.db-col-resizer'),
        n: tds.length,
        cls: first ? String(first.className) : null,
        align: s ? s.textAlign : null,
        fvn: s ? s.fontVariantNumeric : null,
        texts: tds.slice(0, 3).map(t => t.innerText.trim())
      }
    })
    return JSON.stringify({
      grids: grids.length, thCount: ths.length, rowCount: rows.length, cols
    })
  }

  window.__cards = () => [...document.querySelectorAll('.db-cell-preview')].filter(window.__vis)
  window.__paneDiag = () => JSON.stringify({
    valuePaneVis: [...document.querySelectorAll('.db-value-pane')].filter(window.__vis).length,
    editor: [...document.querySelectorAll('input.db-cell-editor')]
      .filter(window.__vis).map(i => i.value),
    editorCount: document.querySelectorAll('.db-cell-editor').length
  })
  window.__cellXY = prefix => {
    const c = window.__cellOf(prefix)
    if (!c) return JSON.stringify({ error: 'no-cell:' + prefix })
    const r = c.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + Math.min(r.width, 30) / 2), y: Math.round(r.top + r.height / 2) })
  }
  // 按列名反查单元格坐标：本地化开着的时候"可见文本"已经不等于原值
  // （1234567 → 1,234,567），用文本前缀找格子会找不到，必须按列定位
  window.__cellXYAt = (gridSel, label, rowIdx) => {
    const grid = [...document.querySelectorAll(gridSel)].find(window.__vis)
    if (!grid) return JSON.stringify({ error: 'no-grid:' + gridSel })
    const head = grid.querySelector('.ant-table-header') || grid
    const ths = [...head.querySelectorAll('thead th')].filter(t =>
      !/cell-scrollbar|ant-table-measure/.test(t.className || ''))
    const idx = ths.findIndex(t => {
      const n = t.querySelector('.db-col-name')
      return (((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]) === label
    })
    if (idx < 0) return JSON.stringify({ error: 'no-th:' + label })
    const rows = [...grid.querySelectorAll('.ant-table-row')].filter(window.__vis)
    const td = (rows[rowIdx || 0] || {}).children ? rows[rowIdx || 0].children[idx] : null
    if (!td) return JSON.stringify({ error: 'no-td:' + label + ' rows=' + rows.length })
    const r = td.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(r.left + Math.min(r.width, 30) / 2),
      y: Math.round(r.top + r.height / 2),
      text: td.innerText.trim()
    })
  }
  // 本地化开关只在数据页工具条上（sel && grid.rows.length），它是会话级 state
  // 并顺手写全局 config —— 所以先开开关再切 SQL 页签，才是用户真实会走的路径
  window.__localeState = () => {
    const s = [...document.querySelectorAll('.db-format-locale .ant-switch')].find(window.__vis)
    if (!s) return 'no-switch'
    return s.getAttribute('aria-checked') === 'true' ? 'os' : 'none'
  }
  window.__clickLocale = () => {
    const s = [...document.querySelectorAll('.db-format-locale .ant-switch')].find(window.__vis)
    if (!s) return 'no-switch'
    s.click()
    return 'ok'
  }
  window.__cfgLocale = () => String((window.store._config || {}).dbFormatLocale)
  window.__resultTabs = () => JSON.stringify(
    [...document.querySelectorAll('.db-sql-results-tabs .ant-tabs-tab')]
      .filter(window.__vis).map(t => t.innerText.trim())
  )
  window.__clickResultTab = re => {
    const t = [...document.querySelectorAll('.db-sql-results-tabs .ant-tabs-tab')]
      .filter(window.__vis)
      .find(x => new RegExp(re).test(x.innerText.replace(/\\s/g, '')))
    if (!t) return 'no-result-tab:' + re
    t.click()
    return 'ok'
  }
  // 手柄拖拽的落点：.db-col-resizer 的中心（不是 th 右沿 -8：手柄宽度是被 CSS 定的）
  window.__dragHandle = (gridSel, label) => {
    const grid = [...document.querySelectorAll(gridSel)].find(window.__vis)
    if (!grid) return JSON.stringify({ error: 'no-grid:' + gridSel })
    const head = grid.querySelector('.ant-table-header') || grid
    const nameOf = t => {
      const n = t.querySelector('.db-col-name')
      return ((n && n.innerText) || t.innerText || '').trim().split('\\n')[0]
    }
    const th = [...head.querySelectorAll('thead th')].find(t => nameOf(t) === label)
    if (!th) return JSON.stringify({ error: 'no-th:' + label })
    const handle = th.querySelector('.db-col-resizer')
    if (!handle) return JSON.stringify({ error: 'no-handle:' + label })
    const hr = handle.getBoundingClientRect()
    return JSON.stringify({
      x: Math.round(hr.left + hr.width / 2),
      y: Math.round(hr.top + hr.height / 2),
      w0: Math.round(th.getBoundingClientRect().width)
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
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
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

  async drag (x, y, dx, steps = 6) {
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

const colMap = async (cdp, sel) => JSON.parse(await cdp.eval('window.__colMap(' + JSON.stringify(sel) + ')'))
// 网格读不出来（选择器没命中、渲染还没完成）时立刻红，并说明是"读不到"而不是"没对齐"：
// 否则后面十几条判据全变成同一句"没找到列"，白跑一轮。
const readGrid = async (cdp, sel) => {
  const map = await colMap(cdp, sel)
  if (map.error) {
    check('网格可读：' + sel, false, map)
    throw new Error('grid unreadable: ' + map.error)
  }
  return map
}
const refOf = async (cdp, raw, kind) => await cdp.eval(
  'window.__fmtRef(' + JSON.stringify(raw) + ', ' + JSON.stringify(kind) + ')')
// 点执行并确认桩真的收到了 SQL：runSql 在空串时直接挡回，
// 不确认这一条，后面的"结果不对"全都是"其实根本没执行"。
const runSql = async (cdp, expect) => {
  await cdp.eval('window.__clickRunSql()')
  const got = await cdp.eval('window.__lastSqlOf()')
  // 前缀比对（不是全等）：客户端可能对 doc 文本做 trim/取选区，
  // 要判的是"确实把我们写进去的那句话发给了 executeSql"
  check('执行请求带上了 doc 里的 SQL', String(got).indexOf(expect) === 0, { got, expect })
  return got
}
const byLabel = (map, label) => (map.cols || []).find(c => c.label === label)
const of = c => c ? { align: c.align, cls: c.cls, text: (c.texts || [])[0], fvn: c.fvn, n: c.n } : null
// 列不存在时返回 ''：配套的"列齐全"前提检查会先红，这里只保证不炸栈
const firstText = c => (c && c.texts && c.texts[0] !== undefined) ? String(c.texts[0]) : ''
const textAt = (c, i) => (c && c.texts && c.texts[i] !== undefined) ? String(c.texts[i]) : ''
// 判据前提：期望的每一列都在网格里对得上号。缺列时 isPlain 会判假，
// 但真正说明问题的是这条 —— 否则一堆"没右对齐"其实是"没找到列"
const allPresent = (map, labels) => labels.every(l => !!byLabel(map, l))

// 期望：这一列右对齐（数值列）。判据同时看 class 和浏览器实际算出的 text-align，
// 只看一个就是"代码写了/效果没到"的温床
const isRight = c => !!c && /db-cell-num/.test(String(c.cls || '')) && c.align === 'right'
const isPlain = c => !!c && !!c.align && !/db-cell-num/.test(String(c.cls || '')) && c.align !== 'right'
// 分组文本的判据不能写死逗号：分隔符随系统区域（, / . / 空格 / U+202F 窄不换行空格）。
// 只认三件事：与原值不一样、数字序列一个都没丢、数字之间多了非数字字符。
const isGrouped = (text, raw) => {
  const t = String(text || '')
  return t !== raw && t.replace(/\D/g, '') === String(raw).replace(/\D/g, '') && /\d\D+\d/.test(t)
}
const digitsOf = s => String(s == null ? '' : s).replace(/\D/g, '')

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

const NUM_LABELS = ['id', 'amount', 'qty', 'ratio']
const NON_NUM_LABELS = ['flag', 'note', 'blob_col', 'json_col', 'created_at', 'due_date', 'stamp', 'clock', 'mystery']
// 数据页网格没有专属 class（DbGridTable 只加 .db-grid-table-wrap），靠数据页容器
// .db-grid-area 圈定；SQL 结果的 wrapper 上有 className='db-sql-result-grid'
const DATA_GRID_SEL = '.db-grid-area .db-grid-table-wrap'
const SQL_GRID_SEL = '.db-sql-result-grid'

// 开关写在真实 config 里（HOME 隔离对 config 不生效），所以"任何退出路径都要还原"
// 是硬要求：中途抛异常就把用户的区域设置留在打开状态，下次他自己打开一看就"莫名其妙"。
let cdpRef = null
let cfg0 = null
const restoreCfg = async () => {
  if (!cdpRef || !cfg0) {
    return
  }
  try {
    await cdpRef.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale0 === 'undefined' ? 'none' : cfg0.locale0) + ' })')
    await cdpRef.eval('window.store.setConfig({ dbPageSize: ' + (Number(cfg0.pageSize0) >= 10 ? Number(cfg0.pageSize0) : 20) + ' })')
    console.log('config 已还原: ' + JSON.stringify(cfg0))
  } catch (e) {
    console.log('config 还原失败（手工确认 dbFormatLocale）: ' + e.message)
  }
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
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(800)

  await cdp.eval(FIXTURE)
  await cdp.eval(HELPERS)
  // 记录原值，跑完还原：本地化开关写在真实 config 里（HOME 隔离对 config 不生效）
  cfg0 = {
    locale0: await cdp.eval('String((window.store._config || {}).dbFormatLocale)'),
    pageSize0: await cdp.eval('window.store._config && window.store._config.dbPageSize')
  }

  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  // 开关的初值来自 config（组件挂载时 useState 读一次）。上一轮跑完忘了还原就会
  // 带着 'os' 起步，"开关在数据页工具条上是关的"这条前提直接假红 —— 先钉回默认
  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: 20 })')
  await sleep(300)
  // 关掉上一轮留下的夹具页签：反复跑会堆出多个数据库页签，隐藏页签的 DOM 仍在文档里，
  // 结构类判据（结果页签数）就会被算成 4 而不是 2 —— 每次跑都从干净的挂载开始。
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && t.dbName === 'demo_db').map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) {
    await sleep(600)
  }
  const mysqlId = await cdp.eval(`
    (() => {
      window.store.addTab(${JSON.stringify(MYSQL_TAB)})
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()
  `)
  check('MySQL 页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  // 树是懒加载的：先点库节点让它去取表清单，再点表 —— 直接点表名会点不到（节点还没渲染）
  // 等待用存在性判据（__hasTree），不能用 __clickTree 的返回值 —— 它永远返回非空字符串
  check('展开库节点', await cdp.eval('window.__clickTree("demo_db")') === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node'))
  check('选中数据表（数据页出网格）', await cdp.eval('window.__clickTree("typed_tbl")') === 'ok' &&
    await waitFor(cdp, 'JSON.parse(window.__colMap(' + JSON.stringify(DATA_GRID_SEL) + ')).rowCount > 0', 'data grid'),
  { mysqlId })

  // ---------- E) 数据页：类型来自 F0 结构契约（getTableStructure） ----------
  const dm0 = await readGrid(cdp, DATA_GRID_SEL)
  check('数据页表头/表体列数一致（判据本身有效）',
    dm0.thCount === dm0.cols.length && (dm0.cols || []).every(c => c.n === dm0.rowCount),
    { thCount: dm0.thCount, rowCount: dm0.rowCount })
  check('数据页列齐全（判据前提）',
    allPresent(dm0, ['id', 'amount', 'qty', 'flag', 'note', 'blob_col', 'created_at', 'mystery']),
    (dm0.cols || []).map(c => c.label))
  check('数据页数值列右对齐（bigint/decimal/int）',
    ['id', 'amount', 'qty'].every(l => isRight(byLabel(dm0, l))),
    Object.fromEntries(['id', 'amount', 'qty'].map(l => [l, of(byLabel(dm0, l))])))
  check('数据页非数值列不右对齐（varchar/text/blob/datetime/未知类型）',
    ['flag', 'note', 'blob_col', 'created_at', 'mystery'].every(l => isPlain(byLabel(dm0, l))),
    Object.fromEntries(['flag', 'note', 'blob_col', 'created_at', 'mystery'].map(l => [l, of(byLabel(dm0, l))])))
  check('数据页数值列等宽数字（tabular-nums，翻页对得上账）',
    ['id', 'amount'].every(l => /tabular-nums/.test(String((byLabel(dm0, l) || {}).fvn))),
    { id: (byLabel(dm0, 'id') || {}).fvn })

  // ---------- B) 本地化开关（先开，再切 SQL —— 用户真实路径） ----------
  check('本地化开关在数据页工具条上', await cdp.eval('window.__localeState()') === 'none',
    await cdp.eval('window.__localeState()'))
  check('打开本地化开关', await cdp.eval('window.__clickLocale()') === 'ok' &&
    await waitFor(cdp, "window.__localeState() === 'os'", 'locale on'))
  check('开关顺手写进全局 config（下次启动还是它）',
    await cdp.eval('window.__cfgLocale()') === 'os', await cdp.eval('window.__cfgLocale()'))
  const dmOn = await readGrid(cdp, DATA_GRID_SEL)
  const amountCell = byLabel(dmOn, 'amount')
  check('数据页数值按类型分组（decimal 的值是字符串，只有类型契约能让它分组）',
    isGrouped(firstText(amountCell), '1234567.8901'), of(amountCell))
  // 判据是"等于本地日期分支的参考值"，不是"不等于原文"：zh-CN 下两者只差一个窄空格，
  // 用"不等于"会假绿（看着测到了本地化，其实格式化根本没跑）。
  const dtNaive = await refOf(cdp, '2026-01-05 08:30:00', 'dt-naive')
  check('数据页 datetime 走本地日期分支（与分支参考值逐字一致）',
    firstText(byLabel(dmOn, 'created_at')) === dtNaive,
    { created_at: of(byLabel(dmOn, 'created_at')), ref: dtNaive })
  check('未知类型列不参与格式化（datetime 长相的字符串原样保留）',
    firstText(byLabel(dmOn, 'mystery')) === '2026-01-05 08:30:00',
    { mystery: of(byLabel(dmOn, 'mystery')), ref: dtNaive })
  check('二进制信封仍按 H1a-1 呈现（类型契约没改写它）',
    !/AAECAwQFBgc=/.test(firstText(byLabel(dmOn, 'blob_col'))),
    of(byLabel(dmOn, 'blob_col')))
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-data-grid-os-dark.png')))

  // 格式化只在展示层：编辑框必须拿到原值（否则用户按回车就写进一个千分位串）
  const xy = JSON.parse(await cdp.eval('window.__cellXYAt(' + JSON.stringify(DATA_GRID_SEL) + ', "amount", 0)'))
  const editOk = await (async () => {
    if (xy.error) {
      return { ok: false, why: xy }
    }
    await cdp.click(xy.x, xy.y, 2)
    await sleep(400)
    const d = JSON.parse(await cdp.eval('window.__paneDiag()'))
    return { ok: d.editor.length === 1, why: d }
  })()
  check('双击进编辑且编辑框是原值（1234567.8901，不带千分位）', editOk.ok &&
    editOk.why.editor[0] === '1234567.8901', editOk.why)
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await sleep(200)
  await cdp.eval('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
  await sleep(200)
  check('Esc 退出编辑', await cdp.eval('!document.querySelector(".db-cell-editor")'))

  // ---------- A/C) SQL 结果：类型契约接通 + 多结果集不串味 ----------
  check('切到 SQL 页签', await cdp.eval('window.__clickTab("^SQL$")') === 'ok' &&
    await waitFor(cdp, "!![...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)", 'cm editor'))
  // CodeMirror6 不吃合成 beforeinput：先聚焦，再用 CDP 的原生 Input.insertText 注入
  const SQL_TEXT = 'SELECT id, amount, created_at FROM typed_tbl'
  const focus = await cdp.eval('window.__focusSql()')
  check('SQL 编辑器可聚焦（Input.insertText 要有落点）', focus === 'focused', focus)
  if (focus === 'focused') {
    await cdp.call('Input.insertText', { text: SQL_TEXT })
    await sleep(200)
  }
  const doc = await cdp.eval('window.__sqlDoc()')
  check('SQL 文本真的进了 CodeMirror doc（runSql 不再被空串挡回）',
    String(doc).indexOf(SQL_TEXT) === 0, doc)
  const btn = await cdp.eval('window.__runBtn()')
  check('执行按钮可点', btn.found === 1 && btn.disabled === false, btn)
  await runSql(cdp, SQL_TEXT)
  // 等待条件用"结构"而不是"单元格文本"：本地化开着时文本带分隔符，按值前缀等是等不到的。
  // 页签数走 __resultTabs()（只数可见的）：反复跑会留下隐藏的数据库页签，
  // 它们的 DOM 还在，直接 querySelectorAll 数出来的是 4 而不是 2。
  const gridReady = 'JSON.parse(window.__colMap(' + JSON.stringify(SQL_GRID_SEL) + ')).thCount === 13 && ' +
    'JSON.parse(window.__resultTabs()).length === 2'
  const twoSet = await waitFor(cdp, gridReady, 'sql grid')
  check('结果网格出现且是双结果集页签', twoSet, await cdp.eval('window.__resultTabs()'))

  const sm = await readGrid(cdp, SQL_GRID_SEL)
  check('SQL 结果表头/表体列数一致（判据本身有效）',
    sm.thCount === sm.cols.length && (sm.cols || []).every(c => c.n === sm.rowCount),
    { thCount: sm.thCount, rowCount: sm.rowCount, cols: (sm.cols || []).map(c => c.label) })
  check('SQL 结果列齐全（判据前提）', allPresent(sm, NUM_LABELS.concat(NON_NUM_LABELS)),
    (sm.cols || []).map(c => c.label))
  check('SQL 结果数值列右对齐（类型来自新增的 columns[].type）',
    NUM_LABELS.every(l => isRight(byLabel(sm, l))),
    Object.fromEntries(NUM_LABELS.map(l => [l, of(byLabel(sm, l))])))
  check('SQL 结果非数值列一律不右对齐（varchar/text/blob/json/日期时间/未知）',
    NON_NUM_LABELS.every(l => isPlain(byLabel(sm, l))),
    Object.fromEntries(NON_NUM_LABELS.map(l => [l, of(byLabel(sm, l))])))
  check('表头没被右对齐（列名不压 H1a-2 的拖拽手柄热区）',
    NUM_LABELS.every(l => (byLabel(sm, l) || {}).thAlign !== 'right'),
    Object.fromEntries(NUM_LABELS.map(l => [l, (byLabel(sm, l) || {}).thAlign])))
  check('数值列表头右沿手柄仍可命中（col-resize 没被文字挤掉）',
    NUM_LABELS.every(l => {
      const c = byLabel(sm, l)
      return c && /resiz/i.test(String(c.handleHit))
    }),
    Object.fromEntries(NUM_LABELS.map(l => [l, (byLabel(sm, l) || {}).handleHit])))
  check('SQL 结果数值列等宽数字', NUM_LABELS.every(l => /tabular-nums/.test(String((byLabel(sm, l) || {}).fvn))),
    Object.fromEntries(NUM_LABELS.map(l => [l, (byLabel(sm, l) || {}).fvn])))

  // B) 开关对 SQL 结果真的生效（这批的核心回归）
  check('SQL 结果 bigint 分组后数字序列一位不差（默认 3 位小数/Number 化会丢）',
    digitsOf(firstText(byLabel(sm, 'id'))) === '1234567' &&
      isGrouped(firstText(byLabel(sm, 'id')), '1234567'),
    of(byLabel(sm, 'id')))
  check('SQL 结果按类型分组（decimal 的值是字符串，靠新增的类型契约才分组）',
    isGrouped(firstText(byLabel(sm, 'amount')), '1234567.8901'), of(byLabel(sm, 'amount')))
  const refDt = await refOf(cdp, '2026-01-05 08:30:00', 'dt-naive')
  const refD = await refOf(cdp, '2026-02-20', 'd')
  const refZ = await refOf(cdp, '2026-01-05T00:30:00+05:00', 'dt')
  const refT = await refOf(cdp, '10:30:00', 't')
  // 判据有效性前提：四条参考值必须互不相同 —— 否则"等于某条"根本区分不出走了哪条分支
  check('判据本身有效：datetime/date/timestamp/time 四条参考值互不相同',
    new Set([refDt, refD, refZ, refT]).size === 4, { refDt, refD, refZ, refT })
  check('SQL 结果 datetime/date/timestamp 各走各的分支（逐字等于该分支的参考值，回归"行下标当 dataType"）',
    firstText(byLabel(sm, 'created_at')) === refDt &&
      firstText(byLabel(sm, 'due_date')) === refD &&
      firstText(byLabel(sm, 'stamp')) === refZ,
    {
      created_at: firstText(byLabel(sm, 'created_at')),
      due_date: firstText(byLabel(sm, 'due_date')),
      stamp: firstText(byLabel(sm, 'stamp')),
      refDt,
      refD,
      refZ
    })
  check('time 走纯时刻分支且不掺日期',
    firstText(byLabel(sm, 'clock')) === refT && !/1970|2026/.test(firstText(byLabel(sm, 'clock'))),
    { clock: of(byLabel(sm, 'clock')), refT })
  check('未知类型列在 SQL 结果也不猜（datetime 长相原样，且不等于任何一条参考值）',
    firstText(byLabel(sm, 'mystery')) === '2026-01-05 08:30:00' &&
      [refDt, refD, refZ, refT].indexOf(firstText(byLabel(sm, 'mystery'))) < 0,
    { mystery: of(byLabel(sm, 'mystery')), refDt })
  check('varchar 主键长相的值没被当数字格式化',
    firstText(byLabel(sm, 'flag')) === 'ok', of(byLabel(sm, 'flag')))
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-sql-result-os-dark.png')))

  // C) 多结果集：同名列、不同型
  const tabPick = await cdp.eval('window.__clickResultTab("2|result 2")')
  check('切到第 2 个结果集', tabPick === 'ok' && await waitFor(cdp, '!!window.__cellOf("A-1")', 'rs2 rows'), tabPick)
  const sm2 = await readGrid(cdp, SQL_GRID_SEL)
  check('第 2 个结果集同名列 id(varchar) 不右对齐（不串到结果集 1 的 bigint）',
    isPlain(byLabel(sm2, 'id')), of(byLabel(sm2, 'id')))
  check('第 2 个结果集 amount(text) 不右对齐也不分组（数字长相的字符串照样不动）',
    isPlain(byLabel(sm2, 'amount')) &&
      textAt(byLabel(sm2, 'amount'), 0) === 'not-a-number' &&
      textAt(byLabel(sm2, 'amount'), 1) === '1234567',
    { amount: of(byLabel(sm2, 'amount')) })
  await cdp.eval('window.__clickResultTab("1|result 1")')
  await sleep(400)
  const smBack = await readGrid(cdp, SQL_GRID_SEL)
  check('切回结果集 1 后 id 仍是右对齐（页签切换不改类型表）',
    isRight(byLabel(smBack, 'id')), of(byLabel(smBack, 'id')))

  // D) 老结果回落
  await cdp.eval('window.__sqlMode = "notypes"')
  await runSql(cdp, SQL_TEXT)
  // 等列数变成老形态的 4 列：分组打开后单元格文本带分隔符，按值前缀等是等不到的
  check('重新执行（无 columns 的老结果形态）',
    await waitFor(cdp,
      'JSON.parse(window.__colMap(' + JSON.stringify(SQL_GRID_SEL) + ')).thCount === 4', 'notypes grid'))
  const smOld = await readGrid(cdp, SQL_GRID_SEL)
  check('缺 columns 时没有任何列右对齐（不猜类型）',
    (smOld.cols || []).every(c => !/db-cell-num/.test(String(c.cls || ''))),
    (smOld.cols || []).map(c => [c.label, c.align]))
  check('缺 columns 时按值兜底：驱动给的 JS number 仍分组且不丢位',
    isGrouped(firstText(byLabel(smOld, 'id')), '1234567') &&
      digitsOf(firstText(byLabel(smOld, 'id'))) === '1234567',
    of(byLabel(smOld, 'id')))
  check('缺 columns 时字符串值不猜（amount/created_at 原样）',
    firstText(byLabel(smOld, 'amount')) === '1234567.8901' &&
      firstText(byLabel(smOld, 'created_at')) === '2026-01-05 08:30:00',
    { amount: of(byLabel(smOld, 'amount')), created_at: of(byLabel(smOld, 'created_at')) })

  // 关掉开关：一切原样（默认态不能被这批改动悄悄打开）
  await cdp.eval('window.__clickTab("数据|Data")')
  await sleep(400)
  check('关掉本地化开关', await cdp.eval('window.__clickLocale()') === 'ok' &&
    await waitFor(cdp, "window.__localeState() === 'none'", 'locale off'))
  const dmOff = await readGrid(cdp, DATA_GRID_SEL)
  check('关：数值/日期回到原样文本',
    firstText(byLabel(dmOff, 'amount')) === '1234567.8901' &&
      firstText(byLabel(dmOff, 'created_at')) === '2026-01-05 08:30:00',
    { amount: of(byLabel(dmOff, 'amount')), created_at: of(byLabel(dmOff, 'created_at')) })
  check('关：右对齐仍然在（对齐属于类型契约，不归本地化开关管）',
    ['id', 'amount'].every(l => isRight(byLabel(dmOff, l))),
    Object.fromEntries(['id', 'amount'].map(l => [l, of(byLabel(dmOff, l))])))

  // ---------- E) 网格共存回归（右对齐是 td class，不该碰事件） ----------
  await cdp.eval('window.__clickTab("数据|Data")')
  await sleep(300)
  const cellLong = await cdp.eval('window.__cellXY("TTTTTTTTTTTT")')
  const cinfo = JSON.parse(cellLong)
  await cdp.move(cinfo.x, cinfo.y)
  await sleep(120)
  await cdp.move(cinfo.x + 2, cinfo.y)
  await sleep(800)
  const hoverCards = await cdp.eval('window.__cards().length')
  check('长文本悬停不再出预览卡（悬停预览已整体移除）', hoverCards === 0, { cards: hoverCards })
  await cdp.move(5, 5)
  await sleep(400)
  const xyNote = JSON.parse(await cdp.eval('window.__cellXY("note-2")'))
  await cdp.click(xyNote.x, xyNote.y)
  await sleep(500)
  check('单击单元格仍开值面板（class 改动没吞事件）',
    (await cdp.eval('[...document.querySelectorAll(".db-value-pane")].filter(window.__vis).length')) >= 1,
    JSON.parse(await cdp.eval('window.__paneDiag()')))
  const handle = JSON.parse(await cdp.eval('window.__dragHandle(' + JSON.stringify(DATA_GRID_SEL) + ', "amount")'))
  check('数值列手柄存在且量到坐标（右对齐没动列头结构）',
    !!handle.x && !!handle.y && !handle.error, handle)
  await cdp.drag(handle.x, handle.y, 120)
  await sleep(500)
  const dmDrag = await readGrid(cdp, DATA_GRID_SEL)
  check('拖宽数值列后仍右对齐（H1a-2 与 H1a-3 不打架）',
    isRight(byLabel(dmDrag, 'amount')) && (byLabel(dmDrag, 'amount').n || 0) === dmDrag.rowCount,
    of(byLabel(dmDrag, 'amount')))

  // ---------- F) 浅色主题复查 ----------
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(300)
  await cdp.eval('window.__sqlMode = "typed"')
  await runSql(cdp, SQL_TEXT)
  await waitFor(cdp, gridReady, 'sql grid rerun')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(800)
    const lightMap = await readGrid(cdp, SQL_GRID_SEL)
    check('浅色主题下右对齐与分组一致（对齐不依赖主题）',
      NUM_LABELS.every(l => isRight(byLabel(lightMap, l))) &&
        NON_NUM_LABELS.every(l => isPlain(byLabel(lightMap, l))),
      Object.fromEntries(['id', 'flag'].map(l => [l, of(byLabel(lightMap, l))])))
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-sql-result-light.png')))
    await cdp.eval('window.store.setTheme("default")')
    await sleep(600)
  }
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-sql-result-dark-final.png')))

  // 还原 config 由 bail() 统一做（异常路径也还原），这里只汇报结果
  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  console.log('stub ops: ' + await cdp.eval('JSON.stringify(window.__dbStubCalls)'))
  return fail.length
}

// 任何退出路径（跑完 / 中途抛）都先还原 config，再退进程
const bail = async code => {
  await restoreCfg()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
