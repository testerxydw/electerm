#!/usr/bin/env node
/**
 * SQL 结果工作台 · 本页过滤 —— CDP 实机验收（桩数据，无需真库）
 *
 * 设计文档 §2（SQL 结果工作台增强）第 3 项「过滤输入」的效果，逐条在真实渲染层里量：
 *   F1) 工具行里有过滤框，占位文案走词条；筛的是**整份结果**而不是当前页
 *       （在第 1 页筛一个只出现在第 16、39 页的值，网格要直接把那行端上来）。
 *   F2) 输入防抖 150ms：敲下去的一瞬间行数不变，到点才扫；纯前端过滤，
 *       一次都不该再惊动 executeSql。
 *   F3) 分页口径跟着命中数走：筛完不足一页就没分页器；跨页时页数 = ceil(命中/每页)，
 *       且停在第 5 页时筛到 2 行不会留在一页空白上。
 *   F4) 所见即所得：大小写不敏感、数字按文本、NULL 按格子里的 "NULL"、命中任意列。
 *   F5) 命中 0 时给的是"红的 0/总数 + 空网格"，而页大小/导出/列宽工具不能跟着消失
 *       （显隐看的是这次执行有没有回行，不是命中数）。
 *   F6) 每个结果集一份过滤状态：切页签互不串味；重新执行把过滤与输入框一起清掉。
 *   F7) 筛选后单击单元格，工具条报的行号仍是**结果内绝对下标**（不是页内第几行）。
 *   F8) 1 万行不回归：虚拟化仍在、DOM 行数远小于命中数、扫一遍的墙上时间可接受。
 *   F9) 双主题下工具行不塌陷、过滤框宽度可见。
 *
 * 用法：
 *   1) npm run compile
 *   2) rsync -a src/app/ work/app/   # 词条在主进程里 require，compile 并不同步 src/app
 *                                       # （不带 --delete，别清掉生成的 work/app/package.json）
 *   3) Xvfb :130 -nolisten tcp &
 *      DISPLAY=:130 HOME=/tmp/electerm-h1a3/home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9225 --no-sandbox --window-size=1600,1000
 *   4) node self-test/db-sql-workbench-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const {
  getJson, buildHelpers, Cdp, sleep, waitFor, makeChecker, rowRe, clickCell, findPageTarget
} = require('./db-ui-helpers')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-workbench-shots')
const SPLIT_KEY = 'electerm-db-sql-value-split'
const ROWS = 10000
const PAGE = 200

// 判据输出只留必要字段（与真库脚本同一条纪律：长字符串先截断再打印）
const pick = (o, keys) => {
  const r = {}
  for (const k of keys) {
    if (o && o[k] !== undefined) {
      r[k] = typeof o[k] === 'string' && o[k].length > 40 ? o[k].slice(0, 40) + '…' : o[k]
    }
  }
  return r
}
const DEBOUNCE = 150

const HELPERS = buildHelpers(SPLIT_KEY)
const { results, check } = makeChecker()

// 桩数据要点（都是假数据，可以随意外传内容，判据里直接比明文）：
// - 1 万行：够测"扫一遍的墙上时间"，也够让"筛到第 16/39 页的值"成为跨页判据
// - xneedle 只挂在第 3001、7777 行；ADMIN 只挂在第 5、500、9000 行（测大小写不敏感）
// - nullable 每 2500 行一个 null → 恰好 4 个 NULL（测"按格子里看到的 NULL 筛"）
// - id 是 number：筛 '10000' 要能命中（数字按文本匹配，不要求用户先转类型）
// - 结果集 2 只有 2 行：与结果集 1 的过滤状态必须互不串味
const FIXTURE = `
(() => {
  const COLS = [
    { name: 'id', type: 'int' },
    { name: 'note', type: 'varchar' },
    { name: 'tag', type: 'varchar' },
    { name: 'upper', type: 'varchar' },
    { name: 'nullable', type: 'varchar' }
  ]
  const rows = []
  for (let i = 1; i <= ${ROWS}; i++) {
    rows.push({
      id: i,
      note: 'note-' + i,
      tag: (i === 3001 || i === 7777) ? 'xneedle' : 'common',
      upper: (i === 5 || i === 500 || i === 9000) ? 'ADMIN' : 'user',
      nullable: (i % 2500 === 0) ? null : 'v'
    })
  }
  const rows2 = [{ id: 'A-1', payload: 'short' }, { id: 'A-2', payload: '2026-01-05 08:30:00' }]

  // 独立参照系（不是产品实现）：值全是串/数/NULL，String(v) 就是格子里看到的文本，
  // 所以这里用最朴素的逐格 includes 就能算出"应该命中几行"
  window.__expectCount = q => {
    const needle = String(q).toLowerCase()
    let n = 0
    for (const r of rows) {
      const hit = Object.keys(r).some(k => String(r[k] === null ? 'NULL' : r[k]).toLowerCase().indexOf(needle) >= 0)
      if (hit) n++
    }
    return n
  }

  window.__dbStubCalls = []
  window.__sqlMode = 'one'
  window.__lastSql = null
  window.__execN = 0
  window.__sqlResults = () => {
    if (window.__sqlMode === 'two') {
      return [
        { sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows },
        {
          sql: 'second',
          fields: ['id', 'payload'],
          columns: [{ name: 'id', type: 'varchar' }, { name: 'payload', type: 'text' }],
          rows: rows2
        }
      ]
    }
    return [{ sql: window.__lastSql, fields: COLS.map(c => c.name), columns: COLS, rows }]
  }

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      if (name === 'dbGridViewOp') return Promise.resolve(null)
      if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') {
        return Promise.resolve({ ok: true })
      }
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
    if (op === 'executeSql') {
      window.__lastSql = args.sql
      window.__execN = window.__execN + 1
      return Promise.resolve({ results: window.__sqlResults(), elapsedMs: 123 })
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({
        columns: COLS.map(c => ({ name: c.name, dataType: c.type, isPk: c.name === 'id' })),
        foreignKeys: []
      })
    }
    if (op === 'describeTable') {
      return Promise.resolve(COLS.map(c => ({
        Field: c.name, Type: c.type, Null: 'YES', Key: '', Default: null, Extra: '', Comment: ''
      })))
    }
    if (op === 'getPageData') {
      return Promise.resolve({ rows: rows.slice(0, 20), totalRows: rows.length, page: 1, hasMore: true })
    }
    if (op === 'countRows') return Promise.resolve({ count: rows.length })
    if (op === 'listColumns') return Promise.resolve([])
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getDbTxState') return Promise.resolve({ active: false })
    return Promise.resolve(null)
  }
  window.pre.__h1wb = 'stub'
  return 'stub-installed'
})()
`

// 过滤专项探针：都只读"看得见的那一处"（多结果集时非激活页签也在 DOM 里）
const PROBE = `
(() => {
  const tools = () => [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0] || null
  window.__fWrap = () => {
    const t = tools()
    const w = t && t.querySelector('.db-sql-filter')
    return w && window.__vis(w) ? w : null
  }
  window.__fInput = () => {
    const w = window.__fWrap()
    const i = w && w.querySelector('input')
    return i && window.__vis(i) ? i : null
  }
  window.__fSet = text => {
    const i = window.__fInput()
    if (!i) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, String(text))
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  window.__fValue = () => {
    const i = window.__fInput()
    return i === null ? null : String(i.value)
  }
  window.__fClear = () => {
    const w = window.__fWrap()
    const x = w && w.querySelector('.ant-input-clear-icon')
    if (!x || !window.__vis(x)) return 'no-clear'
    x.click()
    return 'ok'
  }
  // 命中/总数那条 span：文本、解析出的 m/t、是否走了"零命中"红色档
  // （正则用 [0-9] 而不是反斜杠类 —— 这段源码要穿过一层模板字符串，反斜杠数容易数错）
  window.__fHit = () => {
    const t = tools()
    const el = t && [...t.querySelectorAll('.db-sql-filter-hit')].filter(window.__vis)[0]
    if (!el) return JSON.stringify({ exists: 0, tools: t ? 1 : 0 })
    const txt = String(el.innerText || '').trim()
    const m = /([0-9]+)[^0-9]+([0-9]+)/.exec(txt)
    const r = el.getBoundingClientRect()
    return JSON.stringify({
      exists: 1,
      text: txt,
      m: m ? Number(m[1]) : -1,
      t: m ? Number(m[2]) : -1,
      emptyCls: /db-sql-filter-hit-empty/.test(String(el.className)) ? 1 : 0,
      color: getComputedStyle(el).color,
      w: Math.round(r.width),
      h: Math.round(r.height)
    })
  }
  // 工具行里除过滤框之外还剩什么：页大小 Select、导出、列宽工具
  window.__fTools = () => {
    const t = tools()
    if (!t) return JSON.stringify({ exists: 0 })
    const vis = els => [...els].filter(window.__vis)
    return JSON.stringify({
      exists: 1,
      h: Math.round(t.getBoundingClientRect().height),
      filter: window.__fWrap() ? 1 : 0,
      fw: window.__fWrap() ? Math.round(window.__fWrap().getBoundingClientRect().width) : -1,
      placeholder: window.__fInput() ? String(window.__fInput().placeholder) : '',
      pagesize: vis(t.querySelectorAll('.db-grid-pagesize')).length,
      buttons: vis(t.querySelectorAll('button')).length,
      // 分页器已换成与数据页同一份 DbGridPager：没有页码按钮，"末页"只能从
      // 跳页框的 placeholder（'1-50'）读，当前页从 .db-grid-page-no 文本解析
      pager: vis(t.querySelectorAll('.db-grid-pager')).length,
      maxPage: (() => {
        const i = vis(t.querySelectorAll('.db-grid-pager .db-grid-jump input'))[0]
        const m = i ? String(i.getAttribute('placeholder') || '').match(/([0-9]+)[^0-9]*$/) : null
        return m ? Number(m[1]) : -1
      })(),
      totalText: (() => {
        const el = vis(t.querySelectorAll('.db-grid-pager .db-grid-total'))[0]
        return el ? String(el.innerText || '').trim() : ''
      })(),
      current: (() => {
        const el = vis(t.querySelectorAll('.db-grid-pager .db-grid-page-no'))[0]
        const m = el ? String(el.innerText || '').match(/([0-9]+)/) : null
        return m ? Number(m[1]) : -1
      })()
    })
  }
  // 防抖只能量"敲下第一个字到命中数变化"这一段：MutationObserver 记 DOM 改动的时刻，
  // 比 node 侧轮询准（轮询间隔 30~200ms，量不出 150ms 这一档）
  window.__fArm = () => {
    window.__fT0 = performance.now()
    window.__fAt = null
    if (window.__fObs) window.__fObs.disconnect()
    let prev = (() => {
      const h = JSON.parse(window.__fHit())
      return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
    })()
    window.__fObs = new MutationObserver(() => {
      const now = (() => {
        const h = JSON.parse(window.__fHit())
        return h.exists + '|' + (h.text || '') + '|' + window.__rows().length
      })()
      if (now !== prev) {
        prev = now
        if (window.__fAt === null) window.__fAt = performance.now()
      }
    })
    window.__fObs.observe(document.body, { childList: true, subtree: true, characterData: true })
    return 'armed'
  }
  // 敲下之后的"立刻"读数：这一刻必须还在防抖窗口内（node 往返 ~10ms）
  window.__fPeek = () => JSON.stringify({
    since: Math.round(performance.now() - window.__fT0),
    hit: JSON.parse(window.__fHit()).exists,
    rows: window.__rows().length
  })
  window.__fElapsed = () => (window.__fAt === null ? -1 : Math.round(window.__fAt - window.__fT0))

  // ---- H1 排序探针：受控状态看 aria-sort 打在哪、指示符文字是什么 ----
  const grid = () => [...document.querySelectorAll('.db-sql-result-grid')].filter(window.__vis)[0] || null
  const thOf = label => {
    const g = grid()
    if (!g) return null
    return [...g.querySelectorAll('thead th')].filter(window.__vis).find(th => {
      const n = th.querySelector('.db-col-name')
      return n && String(n.textContent).trim() === label
    }) || null
  }
  window.__headState = label => {
    const th = thOf(label)
    if (!th) return JSON.stringify({ found: 0 })
    const head = th.querySelector('.db-col-head-sortable')
    const ind = th.querySelector('.db-col-sort')
    return JSON.stringify({
      found: 1,
      aria: head ? String(head.getAttribute('aria-sort')) : '',
      ind: ind ? String(ind.textContent).trim() : '',
      active: ind && /db-col-sort-active/.test(String(ind.className)) ? 1 : 0,
      tabindex: head ? String(head.getAttribute('tabindex')) : ''
    })
  }
  window.__headAll = () => {
    const g = grid()
    return g ? g.querySelectorAll('thead .db-col-head-sortable').length : -1
  }
  window.__headClick = label => {
    const th = thOf(label)
    const head = th && th.querySelector('.db-col-head-sortable')
    if (!head) return 'no-head'
    head.click()
    return 'ok'
  }
  window.__headKey = (label, key) => {
    const th = thOf(label)
    const head = th && th.querySelector('.db-col-head-sortable')
    if (!head) return 'no-head'
    head.focus()
    head.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    return 'ok'
  }
  window.__colTexts = (label, n) => {
    const idx = window.__colIdx(label)
    if (idx < 0) return JSON.stringify({ error: 'no-col' })
    const rows = window.__rows()
    return JSON.stringify(rows.slice(0, n || 3).map(tr => {
      const td = tr.children[idx]
      return td ? String(td.innerText || '').trim() : ''
    }))
  }

  // ---- H1 列显隐探针：眼睛按钮、下拉项勾选态、当前可见列名 ----
  window.__eyeCount = () => JSON.stringify(
    [...document.querySelectorAll('.db-sql-result-tools')]
      .filter(window.__vis)
      .map(t => [...t.querySelectorAll('button .anticon-eye')].filter(window.__vis).length)
  )
  window.__eyeBtn = () => {
    const t = tools()
    if (!t) return null
    return [...t.querySelectorAll('button .anticon-eye')]
      .filter(window.__vis)
      .map(x => x.closest('button'))[0] || null
  }
  window.__headNames = () => {
    const g = grid()
    if (!g) return JSON.stringify([])
    return JSON.stringify(
      [...g.querySelectorAll('thead th .db-col-name')]
        .filter(window.__vis)
        .map(x => String(x.textContent).trim())
    )
  }
  window.__colsMenu = () => {
    const m = [...document.querySelectorAll('.db-sql-cols-menu')].filter(window.__vis)[0]
    if (!m) return JSON.stringify({ open: 0 })
    const items = [...m.querySelectorAll('.ant-dropdown-menu-item')].filter(window.__vis)
    return JSON.stringify({
      open: 1,
      n: items.length,
      items: items.map(it => ({
        text: String(it.innerText || '').trim().split(String.fromCharCode(10))[0],
        disabled: /ant-dropdown-menu-item-disabled/.test(String(it.className)) ? 1 : 0,
        checked: it.querySelector('.ant-checkbox-checked') ? 1 : 0
      }))
    })
  }
  window.__colsClick = i => {
    const m = [...document.querySelectorAll('.db-sql-cols-menu')].filter(window.__vis)[0]
    if (!m) return 'no-menu'
    const items = [...m.querySelectorAll('.ant-dropdown-menu-item')].filter(window.__vis)
    const it = items[i]
    if (!it) return 'no-item'
    it.click()
    return 'ok'
  }
  return 'probe-installed'
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

const runSql = async cdp => {
  const before = Number(await cdp.eval('window.__execN'))
  const clicked = await cdp.eval('window.__clickRunSql()')
  const fired = await waitFor(cdp, 'window.__execN > ' + before, 'executeSql #' + (before + 1), 8000)
  await sleep(700)
  return { before, after: Number(await cdp.eval('window.__execN')), clicked, fired }
}

// 写过滤词 → 等命中 span 出现/变化（防抖之后才算数）
// arm 与 set 必须压在同一个 CDP 往返里：分两次的话"敲下第一个字"到"读数"之间
// 已经吃掉两个往返，150ms 的防抖窗口就被量成"看起来没防抖"了
const typeFilter = async (cdp, text) => {
  const set = await cdp.eval('window.__fArm(); window.__fSet(' + JSON.stringify(text) + ')')
  const peek = await cdp.jeval('window.__fPeek()')
  const t0 = Date.now()
  let changed = false
  while (Date.now() - t0 < 5000) {
    if (Number(await cdp.eval('window.__fElapsed()')) >= 0) {
      changed = true
      break
    }
    await sleep(40)
  }
  await sleep(250)
  return { set: String(set).slice(-2), peek, changed, elapsed: Number(await cdp.eval('window.__fElapsed()')) }
}

const firstIdOf = async cdp => String((await cdp.jeval('window.__cellXY("id", 0)')).text)

const readHit = async cdp => JSON.parse(await cdp.eval('window.__fHit()'))
const readTools = async cdp => JSON.parse(await cdp.eval('window.__fTools()'))
// 排序专用：列头状态（aria-sort / 指示符）、点击、列内前 n 个文本
const headState = async (cdp, label) => cdp.jeval('window.__headState(' + JSON.stringify(label) + ')')
const colTexts = async (cdp, label, n) => cdp.jeval('window.__colTexts(' + JSON.stringify(label) + ', ' + n + ')')
const clickHead = async (cdp, label) => {
  const r = await cdp.eval('window.__headClick(' + JSON.stringify(label) + ')')
  await sleep(350)
  return r
}
// 末页末尾的几行落在虚拟列表可视窗口之外（DOM 只留窗口内那一小段），
// 直接读 "__rows 的最后 4 个"读的是"窗口最后 4 个"。先滚到底再读。
const scrollResultToBottom = async (cdp) => {
  const p = await cdp.jeval('window.__bodyPoint()')
  let prev = null
  for (let i = 0; i < 60; i++) {
    await cdp.wheel(p.x, p.y, 600)
    await sleep(90)
    const cur = await cdp.eval('window.__innerTY()')
    if (cur === prev) break
    prev = cur
  }
  await sleep(250)
}
// 末页 + 滚到底 + 读这一列最后 n 行
// DbGridPager 没有页码按钮：跳页 = 往跳页框写值（原生 setter + input 事件，
// 走 React 的受控链路）再点 Go；Go 在草稿落进 state 之前是禁用的，所以要分两步
const gotoSqlPage = async (cdp, n) => {
  const typed = await cdp.eval(`(() => {
    const box = window.__one('.db-sql-result-tools .db-grid-pager')
    if (!box) return 'no-pager'
    const i = [...box.querySelectorAll('.db-grid-jump input')].filter(window.__vis)[0]
    if (!i) return 'no-jump'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, String(${n}))
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(180)
  const went = await cdp.eval(`(() => {
    const box = window.__one('.db-sql-result-tools .db-grid-pager')
    const b = box && [...box.querySelectorAll('button')].filter(window.__vis).pop()
    if (!b) return 'no-go'
    if (b.disabled) return 'go-disabled'
    b.click()
    return 'ok'
  })()`)
  await sleep(500)
  return { typed, went }
}
const tailOfLastPage = async (cdp, label, n) => {
  // 末页号从跳页框 placeholder（'1-50'）读；读不到就停在当前页
  const maxPage = Number((await readTools(cdp)).maxPage)
  await gotoSqlPage(cdp, maxPage > 1 ? maxPage : 1)
  await sleep(300)
  await scrollResultToBottom(cdp)
  return (await colTexts(cdp, label, 400)).slice(-n)
}

// 桩必须在 boot 之后装：pre.js 整对象赋值 window.pre，装早了会被冲掉，
// 于是页签真的去连 127.0.0.1:3306（ECONNREFUSED），判据全退化成"没找到网格"。
// 判据也不能只看哨兵 —— 哨兵只证明挂上去过，不证明这一次 call 被接住。
const stubProbe = async cdp => {
  await cdp.eval(`(() => {
    window.__probe = null
    window.__dbStubCalls = []
    const back = v => { window.__probe = JSON.stringify(v) }
    try {
      Promise.resolve(window.pre.runGlobalAsync('dbClientOp', 'probe-tab', 'getMetadata', { hideSystemSchemas: false }))
        .then(r => back({ ok: true, names: (r || []).map(x => x && x.name) }))
        .catch(e => back({ err: String((e && e.message) || e) }))
    } catch (e) { back({ err: String((e && e.message) || e) }) }
    return 'kicked'
  })()`)
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) {
    const raw = await cdp.eval('window.__probe')
    if (raw) {
      const p = JSON.parse(raw)
      if (!p.ok) {
        return { ok: false, why: p.err || 'no-names' }
      }
      const calls = JSON.parse(await cdp.eval('JSON.stringify(window.__dbStubCalls || [])'))
      return { ok: p.names.indexOf('demo_db') >= 0 && calls.indexOf('getMetadata') >= 0, names: p.names, calls }
    }
    await sleep(150)
  }
  return { ok: false, why: 'probe-timeout' }
}
const stubAlive = async cdp => {
  try {
    if (!(await cdp.eval("!!(window.pre && window.pre.__h1wb === 'stub')"))) {
      return { ok: false, why: 'sentinel-gone' }
    }
    return await stubProbe(cdp)
  } catch (e) {
    return { ok: false, why: String(e.message || e) }
  }
}
const ensureStub = async (cdp, tries = 10) => {
  let last = { ok: false, why: 'not-tried' }
  for (let i = 0; i < tries; i++) {
    last = await stubAlive(cdp)
    if (last.ok) {
      return last
    }
    await cdp.eval(FIXTURE)
    await sleep(400)
  }
  return last
}

let cdpRef = null
const cfg0 = { pageSize: null, sqlPageSize: null, locale: null, theme: null }
const restoreAll = async () => {
  if (!cdpRef) {
    return
  }
  try {
    if (cfg0.sqlPageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ sqlResultPageSize: ' + (Number(cfg0.sqlPageSize) >= 10 ? Number(cfg0.sqlPageSize) : 50) + ' })')
    }
    if (cfg0.pageSize !== null) {
      await cdpRef.eval('window.store.setConfig({ dbPageSize: ' + (Number(cfg0.pageSize) >= 10 ? Number(cfg0.pageSize) : 20) + ' })')
    }
    if (cfg0.locale !== null) {
      await cdpRef.eval('window.store.setConfig({ dbFormatLocale: ' + JSON.stringify(cfg0.locale) + ' })')
    }
    if (cfg0.theme) {
      await cdpRef.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    }
    console.log('restored: ' + JSON.stringify(cfg0))
  } catch (e) {
    console.log('restore failed (check sqlResultPageSize/theme manually): ' + e.message)
  }
}

let reported = false
const finish = async results => {
  if (!reported && cdpRef) {
    reported = true
    try {
      console.log('stub ops: ' + await cdpRef.eval('JSON.stringify(window.__dbStubCalls.slice(0, 6))'))
    } catch (e) { /* 页签没了就读不到桩日志，不奇怪 */ }
    console.log('renderer events (' + cdpRef.events.length + '):')
    cdpRef.events.slice(-25).forEach(l => console.log('  ' + l))
  }
  const fail = results.filter(r => !r.ok)
  console.log('\n' + (results.length - fail.length) + '/' + results.length + ' PASS')
  if (fail.length) {
    console.log('FAILED: ' + fail.map(f => f.name).join(' | '))
  }
  return fail.length
}

const main = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  cdpRef = cdp
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  await cdp.call('Page.bringToFront', {})
  await sleep(500)

  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(2500)
  check('重启后渲染进程可用（window.store / pre / translate）',
    await waitFor(cdp, '!!(window.store && window.pre && window.translate)', 'boot', 40000))
  const stub1 = await ensureStub(cdp)
  check('桩真的接管了 dbClientOp（getMetadata 由桩应答，碰不到本机 3306）', stub1.ok, stub1)
  if (!stub1.ok) {
    throw new Error('stub not intercepting: ' + JSON.stringify(stub1))
  }
  await cdp.eval(HELPERS)
  await sleep(400)
  // HELPERS 之后装专项探针：__fHit 用到了 window.__rows，反过来 typeFilter 用到 __fArm
  await cdp.eval(PROBE)
  check('过滤探针装上（输入框/命中 span/工具行三类都探得到）',
    await cdp.eval("window.__fHit && window.__fTools && window.__fArm ? 'yes' : 'no'") === 'yes')

  cfg0.locale = await cdp.eval('String((window.store._config || {}).dbFormatLocale)')
  cfg0.pageSize = await cdp.eval('window.store._config && window.store._config.dbPageSize')
  cfg0.sqlPageSize = await cdp.eval('window.store._config && window.store._config.sqlResultPageSize')
  cfg0.theme = await cdp.eval('String((window.store._config || {}).theme)')

  check('词条 dbFilterResult / dbFilterHit 已生效（src/app locales 同步、占位符成对）',
    /筛选整个结果|Filter this result/.test(await cdp.eval("String(window.translate('dbFilterResult'))")) &&
    /命中 \{m\}\/\{t\}|\{m\} \/ \{t\} matched/.test(await cdp.eval("String(window.translate('dbFilterHit'))")),
    {
      ph: await cdp.eval("String(window.translate('dbFilterResult'))"),
      hit: await cdp.eval("String(window.translate('dbFilterHit'))")
    })

  await cdp.eval('window.store.setConfig({ dbFormatLocale: "none", dbPageSize: 200, sqlResultPageSize: ' + PAGE + ' })')
  await sleep(300)

  MYSQL_TAB.batch = await cdp.eval('window.store.currentLayoutBatch')
  const stale = JSON.parse(await cdp.eval(
    "JSON.stringify((window.store.tabs || []).filter(t => t.type === 'database' && /demo_db/.test(String(t.dbName))).map(t => t.id))"
  ))
  for (const id of stale) {
    await cdp.eval('(async () => { await window.store.delTab(' + JSON.stringify(id) + ') })()')
  }
  if (stale.length) {
    await sleep(600)
  }
  const stub2 = await ensureStub(cdp)
  check('开页签前桩仍在位', stub2.ok, stub2)
  await cdp.eval(`
    (() => {
      window.store.addTab(${JSON.stringify(MYSQL_TAB)})
      const t = window.store.tabs[window.store.tabs.length - 1]
      window.store.changeActiveTabId(t.id)
      return t.id
    })()
  `)
  check('数据库页签打开', await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree'))
  check('展开库节点并选中表',
    await cdp.eval('window.__clickTree("demo_db")') === 'ok' &&
    await waitFor(cdp, 'window.__hasTree("typed_tbl")', 'table node') &&
    await cdp.eval('window.__clickTree("typed_tbl")') === 'ok')
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(400)

  const SQL_TEXT = 'SELECT * FROM typed_tbl'
  check('SQL 编辑器可聚焦', await cdp.eval('window.__focusSql()') === 'focused')
  await cdp.call('Input.insertText', { text: SQL_TEXT })
  await sleep(200)
  check('doc 里确实是注入的 SQL', String(await cdp.eval('window.__sqlDoc()')).indexOf(SQL_TEXT) === 0)
  const run0 = await runSql(cdp)
  check('桩收到执行请求，1 万行到位',
    run0.fired && await waitFor(cdp, 'window.__rows().length > 5 && window.__colIdx("tag") >= 0', 'grid'), { run0 })
  const geo0 = await cdp.jeval('window.__geom()')
  check('基线：每页 ' + PAGE + ' 行、虚拟化仍生效（DOM 行数远小于本页）',
    geo0.domRows > 5 && geo0.domRows < PAGE && geo0.firstId === '1', geo0)

  // ---------- F1) 工具行里的过滤框 ----------
  const t0s = await readTools(cdp)
  const hit0 = await readHit(cdp)
  check('F1 工具行出现过滤框，占位文案是词条而非裸 key/占位符',
    t0s.filter === 1 && t0s.placeholder.length > 0 && !/[{}]/.test(t0s.placeholder), t0s)
  check('F2 没在过滤时不显示"命中/总数"（不拿 10000/10000 制造噪音）',
    hit0.exists === 0, hit0)
  // antd 分页器只会把首尾几页做成页码按钮（中间折叠成 ...），所以认"第 1 页与末页都在、
  // 底纹文字是总行数"，而不是数满 50 个按钮
  check('F3 分页器按原始行数给页码（末页 ' + (ROWS / PAGE) + '）',
    t0s.pager === 1 && t0s.maxPage === ROWS / PAGE && t0s.current === 1 &&
    String(t0s.totalText).indexOf(String(ROWS)) >= 0,
    { maxPage: t0s.maxPage, current: t0s.current, totalText: t0s.totalText })

  // ---------- F4/F5) 防抖 + 扫整份结果（跨页命中） ----------
  const execBefore = Number(await cdp.eval('window.__execN'))
  const f1 = await typeFilter(cdp, 'xneedle')
  check('F4 输入防抖：敲下去的一瞬间（' + f1.peek.since + 'ms）行数与命中数都还没动',
    f1.set === 'ok' && f1.peek.since < DEBOUNCE + 60 && f1.peek.hit === 0 && f1.peek.rows === geo0.domRows, f1)
  const hit1 = await readHit(cdp)
  const geo1 = await cdp.jeval('window.__geom()')
  const firstId1 = await firstIdOf(cdp)
  check('F5 到点后扫的是整份结果：只挂在第 3001/7777 行的值，第 1 页也能筛出来',
    f1.changed && hit1.exists === 1 && hit1.m === 2 && hit1.t === ROWS && hit1.emptyCls === 0,
    { hit1, elapsed: f1.elapsed })
  check('F5b 网格只剩命中的 2 行，首行就是第 3001 行（不是页内序号）',
    geo1.domRows === 2 && firstId1 === '3001', { domRows: geo1.domRows, firstId: firstId1 })
  check('F5c 防抖时长量出来在 150ms 档（实测 ' + f1.elapsed + 'ms = 防抖 + 扫描 + 渲染）',
    f1.elapsed >= DEBOUNCE - 20 && f1.elapsed <= DEBOUNCE + 400, { elapsed: f1.elapsed })
  check('F5d 纯前端过滤：一次都没有重新执行 SQL',
    Number(await cdp.eval('window.__execN')) === execBefore,
    { before: execBefore, after: await cdp.eval('window.__execN') })
  check('F5e 筛到 2 行后分页器消失（按命中数算，不按 1 万行算）',
    (await readTools(cdp)).pager === 0, await readTools(cdp))

  // ---------- F6) 大小写 / 数字 / NULL / 任意列 ----------
  const f2 = await typeFilter(cdp, 'XNEEDLE')
  const hit2 = await readHit(cdp)
  check('F6 大小写不敏感（查询串与格里值两侧都算）', hit2.m === 2, { hit2, elapsed: f2.elapsed })
  const f3 = await typeFilter(cdp, '10000')
  const hit3 = await readHit(cdp)
  const firstId3 = await firstIdOf(cdp)
  check('F7 数字列按文本筛：筛 10000 命中 id=10000 那一行',
    f3.changed && hit3.m === 1 && firstId3 === '10000', { hit3, firstId: firstId3, elapsed: f3.elapsed })
  const f4 = await typeFilter(cdp, 'null')
  const hit4 = await readHit(cdp)
  const expectNull = Number(await cdp.eval('window.__expectCount("null")'))
  check('F8 NULL 按格子里看到的 "NULL" 筛（与独立参照算出的 ' + expectNull + ' 行一致）',
    f4.changed && hit4.m === expectNull && expectNull === 4, { hit4, expectNull, elapsed: f4.elapsed })
  const f5 = await typeFilter(cdp, 'adm')
  const hit5 = await readHit(cdp)
  check('F9 命中任意列：adm 命中的是 upper 列里的 ADMIN（3 行）',
    f5.changed && hit5.m === 3, { hit5, expect: await cdp.eval('window.__expectCount("adm")'), elapsed: f5.elapsed })

  // ---------- F10) 零命中 ----------
  const f6 = await typeFilter(cdp, 'zzz-not-in-any-cell')
  const hit6 = await readHit(cdp)
  const tools6 = await readTools(cdp)
  const geo10 = await cdp.jeval('window.__geom()')
  check('F10 零命中给红色的 0/总数（换的是 error 色），网格空',
    f6.changed && hit6.exists === 1 && hit6.m === 0 && hit6.t === ROWS && hit6.emptyCls === 1 &&
    hit6.color !== hit1.color && geo10.domRows === 0,
    { hit6, normalColor: hit1.color, domRows: geo10.domRows })
  check('F10b 工具行的显隐看的是"这次执行有没有回行"：零命中时页大小/导出/列宽工具仍在',
    tools6.pagesize === 1 && tools6.buttons >= 2 && tools6.filter === 1, tools6)

  // ---------- F11) 命中跨页：分页口径 + 停在末页不空白 ----------
  const f7 = await typeFilter(cdp, 'note-1')
  const expect7 = Number(await cdp.eval('window.__expectCount("note-1")'))
  const hit7 = await readHit(cdp)
  const tools7 = await readTools(cdp)
  check('F11 命中数与独立参照一致（' + expect7 + ' 行；产品与参照各算各的）',
    f7.changed && hit7.m === expect7 && hit7.t === ROWS, { hit7, expect7, elapsed: f7.elapsed })
  check('F11b 分页器 total/页数换成命中口径：' + Math.ceil(expect7 / PAGE) + ' 页，底纹文字也跟着',
    tools7.pager === 1 && tools7.maxPage === Math.ceil(expect7 / PAGE) &&
    String(tools7.totalText).indexOf(String(expect7)) >= 0, tools7)
  const geo7 = await cdp.jeval('window.__geom()')
  check('F11c ' + expect7 + ' 行命中下虚拟化没退化（DOM ' + geo7.domRows + ' 行 ≪ 命中数）',
    geo7.virtual === 1 && geo7.domRows < PAGE, geo7)
  await gotoSqlPage(cdp, Math.ceil(expect7 / PAGE))
  await sleep(500)
  const lastBefore = await cdp.jeval('window.__geom()')
  const f8 = await typeFilter(cdp, 'xneedle')
  const afterLastPage = await cdp.jeval('window.__geom()')
  const tools8 = await readTools(cdp)
  const cell8 = await firstIdOf(cdp)
  check('F12 停在最后一页时筛到 2 行：夹回有内容的一页，不留空白页',
    lastBefore.domRows > 2 && f8.changed && afterLastPage.domRows === 2 &&
    cell8 === '3001' && tools8.pager === 0,
    { lastBefore: lastBefore.domRows, after: afterLastPage.domRows, cell8, changed: f8.changed, tools8 })

  // ---------- F13) 清空与恢复 ----------
  const cleared = await cdp.eval('window.__fClear()')
  await sleep(700)
  const geo9 = await cdp.jeval('window.__geom()')
  const tools9 = await readTools(cdp)
  check('F13 点 × 清空：输入框空、命中提示消失、行数与分页器回到全量',
    cleared === 'ok' && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 && geo9.firstId === '1' &&
    geo9.domRows > 5 && tools9.pager === 1 && tools9.current === 1 &&
    // 末页号从跳页框 placeholder 读（DbGridPager 不渲染页码按钮）
    tools9.maxPage === ROWS / PAGE &&
    String(tools9.totalText).includes(String(ROWS)),
    { cleared, firstId: geo9.firstId, maxPage: tools9.maxPage, current: tools9.current, totalText: tools9.totalText })

  // ---------- F14) 筛选后行号仍是绝对下标 ----------
  await typeFilter(cdp, 'xneedle')
  const cell = await clickCell(cdp, 'id', 1)
  const bar = await cdp.jeval('window.__bar()')
  check('F14 筛完只剩 2 行时单击，工具条报的还是结果内绝对行号（第 7777 行）',
    cell.ok && /^id · /.test(bar.title) && rowRe(7777).test(bar.title), { bar, cell })
  // 单击即展开面板：后面的筛选/分页判据按全高网格算，先收起再继续
  await cdp.eval('window.__closePane()')
  await sleep(400)
  await cdp.eval('window.__fClear()')
  await sleep(600)

  // ---------- F15) 每个结果集一份状态 ----------
  await cdp.eval("window.__sqlMode = 'two'")
  const runTwo = await runSql(cdp)
  check('F15 切到两个结果集（1 万行 + 2 行），重新执行把过滤清干净',
    runTwo.fired && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 &&
    await waitFor(cdp, 'window.__rows().length > 5', 'rerun grid'), { runTwo })
  await typeFilter(cdp, 'xneedle')
  const tabClick = await cdp.eval('window.__clickResultTab("结果\\s*2|result\\s*2")')
  await sleep(600)
  const valB = await cdp.eval('window.__fValue()')
  const hitB = await readHit(cdp)
  const geoB = await cdp.jeval('window.__geom()')
  check('F16 结果集 2 是它自己的状态：过滤框空、2 行全在（没被结果集 1 的词筛掉）',
    tabClick === 'ok' && valB === '' && hitB.exists === 0 && geoB.domRows === 2, { tabClick, valB, hitB, geoB })
  await typeFilter(cdp, 'A-2')
  const hitB2 = await readHit(cdp)
  await cdp.eval('window.__clickResultTab("结果\\s*1|result\\s*1")')
  await sleep(600)
  const valA = await cdp.eval('window.__fValue()')
  const hitA2 = await readHit(cdp)
  check('F17 切回结果集 1：原来的词还在、命中数还是 2（状态没被另一个页签冲掉）',
    hitB2.m === 1 && valA === 'xneedle' && hitA2.m === 2 && (await firstIdOf(cdp)) === '3001',
    { hitB2, valA, hitA2 })

  // ---------- F18) 重新执行清空 ----------
  const runAgain = await runSql(cdp)
  await cdp.eval('window.__clickResultTab("结果\\s*1|result\\s*1")')
  await sleep(600)
  const geoRerun = await cdp.jeval('window.__geom()')
  const toolsRerun = await readTools(cdp)
  check('F18 重新执行：过滤与输入框一起清掉，回到全量第 1 页',
    runAgain.fired && (await cdp.eval('window.__fValue()')) === '' &&
    (await readHit(cdp)).exists === 0 && geoRerun.firstId === '1' &&
    geoRerun.domRows > 5 && toolsRerun.current === 1,
    { runAgain, geoRerun, tools: toolsRerun })

  // ---------- F19) 工具行几何与双主题 ----------
  const layout = await cdp.jeval(`(() => {
    const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
    const w = window.__fWrap()
    const tr = t.getBoundingClientRect()
    const wr = w.getBoundingClientRect()
    const kids = [...t.children].filter(window.__vis).map(c => Math.round(c.getBoundingClientRect().top - tr.top))
    return JSON.stringify({
      toolsH: Math.round(tr.height),
      filterW: Math.round(wr.width),
      filterVisible: wr.width > 100 && wr.height > 12 ? 1 : 0,
      lineSpread: Math.max(...kids) - Math.min(...kids),
      kids: kids.length,
      wrap: getComputedStyle(t).flexWrap
    })
  })()`)
  check('F19 过滤框宽度可见（200px 档）、工具行仍是一行（各控件顶边差不超 8px）',
    layout.filterVisible === 1 && layout.filterW >= 180 && layout.filterW <= 220 &&
    layout.lineSpread <= 8 && layout.kids >= 4, layout)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-dark-tools-row.png')))
  await typeFilter(cdp, 'xneedle')
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-dark-filtered-hit.png')))
  await typeFilter(cdp, 'zzz-not-in-any-cell')
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-dark-filtered-empty.png')))
  await cdp.eval('window.__fClear()')
  await sleep(500)

  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  check('F20 存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1000)
    await typeFilter(cdp, 'note-1')
    const lightLayout = await cdp.jeval(`(() => {
      const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
      const hit = [...t.querySelectorAll('.db-sql-filter-hit')].filter(window.__vis)[0]
      const inp = window.__fInput()
      const cs = getComputedStyle(hit)
      const ci = getComputedStyle(inp)
      return JSON.stringify({
        hitColor: cs.color,
        inputColor: ci.color,
        inputBg: ci.backgroundColor,
        rowH: Math.round(t.getBoundingClientRect().height)
      })
    })()`)
    check('F21 浅色下命中提示与输入框都走 token（文字可见、行高没塌）',
      /rgb/.test(lightLayout.hitColor) && lightLayout.inputBg !== lightLayout.hitColor && lightLayout.rowH >= 24,
      lightLayout)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-light-filtered.png')))
    await cdp.eval('window.__fClear()')
    await sleep(400)
  }

  // ---------- G) 表头排序（受控：升 → 降 → 无） ----------
  // 这一组从 F18 之后的状态起步：结果集 1 = 1 万行、无过滤、第 1 页
  const execSort0 = Number(await cdp.eval('window.__execN'))
  const g0 = await headState(cdp, 'id')
  const heads = Number(await cdp.eval('window.__headAll()'))
  check('G1 每个结果列头都可排序（受控按钮 + 未排序时是淡的 ⇅）',
    heads >= 5 && g0.found === 1 && g0.aria === 'none' && g0.ind === '⇅' &&
    g0.active === 0 && g0.tabindex === '0', { heads, g0 })

  await clickHead(cdp, 'id')
  const g1 = await headState(cdp, 'id')
  const ids1 = await colTexts(cdp, 'id', 3)
  check('G2 第一次点升序：aria-sort / ▲ / 数据真按升序',
    g1.aria === 'ascending' && g1.ind === '▲' && g1.active === 1 &&
    ids1.join(',') === '1,2,3', { g1, ids1 })

  await clickHead(cdp, 'id')
  const g2 = await headState(cdp, 'id')
  const ids2 = await colTexts(cdp, 'id', 3)
  check('G3 第二次点降序：数值列按数排（10000 在 9999 前），不是按字符串',
    g2.aria === 'descending' && g2.ind === '▼' && ids2.join(',') === '10000,9999,9998', { g2, ids2 })

  await clickHead(cdp, 'id')
  const g3 = await headState(cdp, 'id')
  const ids3 = await colTexts(cdp, 'id', 3)
  check('G4 第三次点回到无排序：箭头变淡、顺序回到执行时的原样',
    g3.aria === 'none' && g3.ind === '⇅' && g3.active === 0 && ids3.join(',') === '1,2,3', { g3, ids3 })

  await clickHead(cdp, 'note')
  const notes = await colTexts(cdp, 'note', 3)
  check('G5 文本列按文本序（note-1 < note-10 < note-100），不按数值',
    notes.join(',') === 'note-1,note-10,note-100', { notes })
  await clickHead(cdp, 'note')
  await clickHead(cdp, 'note')

  await clickHead(cdp, 'nullable')
  const nullFirst = await colTexts(cdp, 'nullable', 1)
  const tailAsc = await tailOfLastPage(cdp, 'nullable', 4)
  check('G6 升序时 NULL 排最后（4 个 NULL 全在末页末尾，不在第一屏当最小值）',
    nullFirst[0] === 'v' && tailAsc.every(x => x === 'NULL'), { first: nullFirst[0], tailAsc })

  await clickHead(cdp, 'nullable')
  // 换向回第 1 页看的是分页器高亮页，不是首行 id：按 nullable 降序时首行是最大值的
  // 那一行（同值并列按原序），本来就未必是 id=1
  const toolsDesc = await readTools(cdp)
  const tailDesc = await tailOfLastPage(cdp, 'nullable', 4)
  check('G7 降序时 NULL 仍排最后（"NULL 恒最后"与方向无关），且换向回第 1 页',
    toolsDesc.current === 1 && tailDesc.every(x => x === 'NULL'),
    { current: toolsDesc.current, tailDesc })
  await clickHead(cdp, 'nullable')

  const fSort = await typeFilter(cdp, 'xneedle')
  const hitSort = await readHit(cdp)
  await clickHead(cdp, 'id')
  const idsAsc2 = await colTexts(cdp, 'id', 2)
  check('G8 排序只排命中集：命中/总数口径不变（2/10000），升序首行是 3001',
    fSort.changed && hitSort.m === 2 && hitSort.t === ROWS && idsAsc2.join(',') === '3001,7777',
    { hit: pick(hitSort, ['m', 't']), idsAsc2 })

  await clickHead(cdp, 'id')
  const idsDesc2 = await colTexts(cdp, 'id', 2)
  const cellG = await clickCell(cdp, 'id', 0)
  const barG = await cdp.jeval('window.__bar()')
  check('G9 排序后单击仍是结果内绝对行号（第 7777 行，不是页内第 1 行）',
    idsDesc2.join(',') === '7777,3001' && cellG.ok && rowRe(7777).test(barG.title || ''),
    { idsDesc2, title: barG.title })
  await cdp.eval('window.__closePane()')
  await sleep(400)

  const execSort1 = Number(await cdp.eval('window.__execN'))
  check('G10 排序/切页全程没重新执行 SQL（纯前端排列）',
    execSort0 === execSort1, { before: execSort0, after: execSort1 })

  const clearedSort = await cdp.eval('window.__fClear()')
  const runReset = await runSql(cdp)
  const gReset = await headState(cdp, 'id')
  const idsReset = await colTexts(cdp, 'id', 3)
  check('G11 重新执行清掉排序（箭头回到 ⇅，顺序回到原样）',
    clearedSort === 'ok' && runReset.fired && gReset.aria === 'none' && idsReset.join(',') === '1,2,3',
    { clearedSort, runReset: pick(runReset, ['fired']), gReset, idsReset })

  // ---------- G12) 每个结果集一份排序 ----------
  await clickHead(cdp, 'id')
  await clickHead(cdp, 'id')
  await cdp.eval('window.__clickResultTab("结果\\s*2|result\\s*2")')
  await sleep(700)
  const gB = await headState(cdp, 'id')
  const idsB0 = await colTexts(cdp, 'id', 2)
  await clickHead(cdp, 'id')
  await clickHead(cdp, 'id')
  const idsB1 = await colTexts(cdp, 'id', 2)
  await cdp.eval('window.__clickResultTab("结果\\s*1|result\\s*1")')
  await sleep(700)
  const gA = await headState(cdp, 'id')
  const idsA = await colTexts(cdp, 'id', 2)
  check('G12 每个结果集各自一份排序（结果集 2 的降序不覆盖结果集 1 的降序，两头都对）',
    gB.aria === 'none' && idsB0.join(',') === 'A-1,A-2' &&
    idsB1.join(',') === 'A-2,A-1' && gA.aria === 'descending' && idsA.join(',') === '10000,9999',
    { gB, idsB0, idsB1, gA, idsA })

  // ---------- G13) 换排序回第 1 页 ----------
  await gotoSqlPage(cdp, 5)
  await sleep(700)
  const pageBefore = (await readTools(cdp)).current
  await clickHead(cdp, 'note')
  const tools13 = await readTools(cdp)
  check('G13 换排序列回第 1 页（否则看到的是"另一个顺序的第 5 页"）',
    pageBefore === 5 && tools13.current === 1, { pageBefore, current: tools13.current })

  const before14 = await headState(cdp, 'note')
  const keyRes = await cdp.eval('window.__headKey("note", "Enter")')
  await sleep(350)
  const after14 = await headState(cdp, 'note')
  check('G14 键盘 Enter 也能切排序（Tab 可达，不是只能鼠标）',
    keyRes === 'ok' && before14.aria === 'ascending' && after14.aria === 'descending',
    { before14, after14 })

  const toolsG = await readTools(cdp)
  const geoG = await cdp.jeval('window.__geom()')
  const hintG = await cdp.eval("(() => { const el = [...document.querySelectorAll('.db-sql-sort-hint')].filter(window.__vis)[0]; return el ? String(el.innerText) : '' })()")
  check('G15 排序后工具行仍是一行 24px、网格没被箭头挤塌；1 万行不显示 5 万行档提示',
    toolsG.h === 24 && geoG.gridH > 300 && hintG === '',
    { toolsH: toolsG.h, gridH: geoG.gridH, hintG })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '5-light-sorted.png')))

  // ---------- H) 列显隐（每结果集独立 + 至少留一列） ----------
  // 这一组从 G15 之后的状态起步：结果集 1、无过滤。先把 G14 留下的 note 降序点回无排序
  await clickHead(cdp, 'note')
  await sleep(300)

  const eyeN = JSON.parse(await cdp.eval('window.__eyeCount()'))
  check('C1 工具行有"列显隐"眼睛按钮（激活的结果集一个，不多不少）',
    eyeN.length >= 1 && eyeN.every(n => n === 1), { eyeN })

  await cdp.eval('window.__eyeBtn().click()')
  await sleep(400)
  const menu0 = JSON.parse(await cdp.eval('window.__colsMenu()'))
  const colItems0 = menu0.items.slice(0, -1)
  check('C2 菜单里每列一项（默认全勾）+"显示全部"在末尾且禁用（还没藏列）',
    menu0.open === 1 && menu0.n === 6 && colItems0.every(it => it.checked === 1) &&
    colItems0.map(it => it.text).join(',') === 'id,note,tag,upper,nullable' &&
    menu0.items[menu0.n - 1].disabled === 1, menu0)

  await cdp.eval('window.__colsClick(1)')
  await sleep(400)
  const names1 = JSON.parse(await cdp.eval('window.__headNames()'))
  check('C3 勾掉 note 列：表头立刻少这一列，其余列原序保留',
    names1.join(',') === 'id,tag,upper,nullable', { names1 })

  const fHid = await typeFilter(cdp, 'note-1')
  const hitHid = await readHit(cdp)
  check('C4 藏起来的列不再参与命中（note-1 只活在 note 列里，命中 0）',
    fHid.changed && hitHid.m === 0 && hitHid.t === ROWS, pick(hitHid, ['m', 't']))
  await cdp.eval('window.__fClear()')
  await sleep(500)

  await cdp.eval('window.__eyeBtn().click()')
  await sleep(400)
  const menu1 = JSON.parse(await cdp.eval('window.__colsMenu()'))
  const noteItem = menu1.items.find(it => it.text === 'note')
  check('C5 重开菜单：note 未勾选，"显示全部"此刻可点',
    menu1.open === 1 && noteItem && noteItem.checked === 0 &&
    menu1.items[menu1.n - 1].disabled === 0, menu1)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '6-light-cols-menu.png')))
  await cdp.eval('window.__colsClick(' + (menu1.n - 1) + ')')
  await sleep(400)
  const names2 = JSON.parse(await cdp.eval('window.__headNames()'))
  check('C6 显示全部：note 回来且原位原序', names2.join(',') === 'id,note,tag,upper,nullable', { names2 })

  // 藏到只剩一列：逐个勾掉 note/tag/upper/nullable（菜单每次点完会收起，逐个重开）
  for (const idx of [1, 2, 3, 4]) {
    await cdp.eval('window.__eyeBtn().click()')
    await sleep(350)
    await cdp.eval('window.__colsClick(' + idx + ')')
    await sleep(350)
  }
  const names3 = JSON.parse(await cdp.eval('window.__headNames()'))
  await cdp.eval('window.__eyeBtn().click()')
  await sleep(350)
  const menu2 = JSON.parse(await cdp.eval('window.__colsMenu()'))
  await cdp.eval('window.__colsClick(0)')
  await sleep(350)
  const names4 = JSON.parse(await cdp.eval('window.__headNames()'))
  check('C7 至少留一列：只剩 id 时再勾掉无效（id 还在，hidden 不收脏状态）',
    names3.join(',') === 'id' && menu2.items[0].checked === 1 && names4.join(',') === 'id',
    { names3, last: menu2.items[0], names4 })

  // 收尾：显示全部 → 结果集 1 藏 note → 结果集 2 不受影响 → 重新执行清掉
  await cdp.eval('window.__eyeBtn().click()')
  await sleep(350)
  await cdp.eval('window.__colsClick(5)')
  await sleep(350)
  await cdp.eval('window.__eyeBtn().click()')
  await sleep(350)
  await cdp.eval('window.__colsClick(1)')
  await sleep(350)
  await cdp.eval('window.__clickResultTab("结果\\s*2|result\\s*2")')
  await sleep(700)
  const namesR2 = JSON.parse(await cdp.eval('window.__headNames()'))
  await cdp.eval('window.__clickResultTab("结果\\s*1|result\\s*1")')
  await sleep(700)
  const namesR1 = JSON.parse(await cdp.eval('window.__headNames()'))
  const runC = await runSql(cdp)
  await sleep(300)
  const namesAfter = JSON.parse(await cdp.eval('window.__headNames()'))
  check('C8 每个结果集各自一份藏列 + 重新执行清掉藏列',
    namesR1.join(',') === 'id,tag,upper,nullable' && namesR2.join(',') === 'id,payload' && runC.fired &&
    namesAfter.join(',') === 'id,note,tag,upper,nullable',
    { namesR1, namesR2, runC: pick(runC, ['fired']), namesAfter })

  // ---------- M) 单元格右键菜单（复制值/字段名/整行 TSV/JSON + 按值过滤） ----------
  // 探针：右键派原生 contextmenu（React 根监听会合成），浮层三项探针，
  // 复制类判据一律读回真实剪贴板（writeClipboard 包装器会跨运行残留）
  await cdp.eval(`(() => {
    window.__ctxMenu = () => {
      const m = [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis)[0]
      if (!m) return JSON.stringify({ open: 0 })
      const items = [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis)
      const h = m.querySelector('.db-cell-menu-head')
      return JSON.stringify({
        open: 1,
        head: h ? String(h.textContent).trim() : '',
        items: items.map(x => String(x.textContent).trim())
      })
    }
    window.__cellCtx = (col, rowIdx) => {
      const tr = window.__rows()[rowIdx || 0]
      if (!tr) return 'no-row'
      const idx = window.__colIdx(col)
      if (idx < 0) return 'no-col:' + col
      const td = tr.children[idx]
      if (!td) return 'no-td'
      const r = td.getBoundingClientRect()
      td.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(r.x + 8), clientY: Math.round(r.y + 8)
      }))
      return 'ok'
    }
    window.__ctxPick = i => {
      const m = [...document.querySelectorAll('.db-cell-menu')].filter(window.__vis)[0]
      if (!m) return 'no-menu'
      const items = [...m.querySelectorAll('.db-cell-menu-item')].filter(window.__vis)
      const it = items[i]
      if (!it) return 'no-item'
      it.click()
      return 'ok'
    }
    window.__escKey = () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return 'esc'
    }
    // 剪贴板验"读回的真实内容"，不包 writeClipboard：包装器会跨次运行残留，
    // 一旦页面上留着旧包装，本次的判据就长在过期状态上（上一版就这么把 F22 弄红了）
    window.__clipEq = exp => {
      try {
        const t = String(window.pre.readClipboard ? window.pre.readClipboard() : '')
        const e2 = typeof exp === 'function' ? String(exp()) : String(exp)
        return JSON.stringify({ same: t === e2 ? 1 : 0, len: t.length, expLen: e2.length })
      } catch (err) {
        return JSON.stringify({ err: String(err) })
      }
    }
    return 'ctx-probe-ready'
  })()`)
  await sleep(200)
  // 固定回单结果集 1 万行、无过滤（C 段末尾重新执行过，视图是干净的）
  await cdp.eval('window.__sqlMode = "one"')
  await runSql(cdp)

  // 打开菜单 → 等浮层真的渲染出来 → 再点第 idx 项。
  // 三步必须分开走：contextmenu 与点击压在同一次 eval 里时，React 还没把
  // 浮层渲出来，__ctxPick 点到的是上一次残留的菜单（或点空）
  const ctxPick = async (col, rowIdx, idx) => {
    const opened = await cdp.eval('window.__cellCtx(' + JSON.stringify(col) + ', ' + rowIdx + ')')
    await sleep(150)
    const menu = JSON.parse(await cdp.eval('window.__ctxMenu()'))
    const picked = await cdp.eval('window.__ctxPick(' + idx + ')')
    await sleep(350)
    return { opened, open: menu.open, picked }
  }

  const mxOpen1 = await ctxPick('note', 0, -1)
  const mxMenu1 = JSON.parse(await cdp.eval('window.__ctxMenu()'))
  const mxExpMenu = JSON.parse(await cdp.eval(`JSON.stringify(
    ['dbCellCopyValue', 'dbCellCopyColName', 'dbCellCopyRowTsv', 'dbCellCopyRowJson', 'dbCellRowDetail', 'dbCellFilterByValue']
      .map(k => String(window.translate(k)))
  )`))
  check('M1 右键出菜单：表头=列名、六项词条齐且顺序正确（不是裸 key）',
    mxOpen1.opened === 'ok' && mxMenu1.open === 1 && mxMenu1.head === 'note' &&
    mxMenu1.items.join('|') === mxExpMenu.join('|'),
    { opened: mxOpen1.opened, head: mxMenu1.head, items: mxMenu1.items })
  // 先收掉 M1 打开的菜单（点第一项只会复制值，M2 反正要重开）
  await cdp.eval('window.__escKey()')
  await sleep(400)

  // 期望值一律在动作**之前**从 DOM 取：复制/过滤之后网格可能已变
  const mxCellNote0 = String((await cdp.jeval('window.__cellXY("note", 0)')).text)
  const mxP2 = await ctxPick('note', 0, 0)
  const mxClipValue = JSON.parse(await cdp.eval('window.__clipEq(' + JSON.stringify(mxCellNote0) + ')'))
  check('M2 复制值：剪贴板里就是那一格的可见文本（读回真实剪贴板，不是拦写入）',
    mxP2.picked === 'ok' && mxClipValue.same === 1 && mxClipValue.len > 0,
    { pick: mxP2.picked, ...mxClipValue })

  const mxP3 = await ctxPick('note', 0, 1)
  const mxClipCol = JSON.parse(await cdp.eval('window.__clipEq("note")'))
  check('M3 复制字段名：写入的是列名本身',
    mxP3.picked === 'ok' && mxClipCol.same === 1 && mxClipCol.len === 4,
    { pick: mxP3.picked, ...mxClipCol })

  const mxP4 = await ctxPick('note', 0, 2)
  const mxTsvInfo = JSON.parse(await cdp.eval(`(() => {
    const t = String(window.pre.readClipboard())
    const lines = t.split(String.fromCharCode(10))
    return JSON.stringify({
      head: lines[0],
      n: lines.length,
      rowHasCell: lines[1] ? lines[1].indexOf('note-1') > -1 : false
    })
  })()`))
  check('M4 复制整行 TSV：表头行=五个列名制表符连接，整行只有 表头+1 行且含该格值',
    mxP4.picked === 'ok' && mxTsvInfo.head === ['id', 'note', 'tag', 'upper', 'nullable'].join(String.fromCharCode(9)) &&
    mxTsvInfo.n === 2 && mxTsvInfo.rowHasCell,
    { pick: mxP4.picked, ...mxTsvInfo })

  const mxP5 = await ctxPick('note', 0, 3)
  const mxJsonInfo = JSON.parse(await cdp.eval(`(() => {
    try {
      const a = JSON.parse(String(window.pre.readClipboard()))
      return JSON.stringify({ isArray: Array.isArray(a), n: a.length, keys: Object.keys(a[0] || {}).join(','), note: a[0] && a[0].note })
    } catch (e) { return JSON.stringify({ err: String(e) }) }
  })()`))
  check('M5 复制整行 JSON：单元素数组、键与列序同源、note 值正确',
    mxP5.picked === 'ok' && mxJsonInfo.isArray && mxJsonInfo.n === 1 &&
    mxJsonInfo.keys === 'id,note,tag,upper,nullable' && mxJsonInfo.note === 'note-1',
    { pick: mxP5.picked, ...mxJsonInfo })

  // 菜单开着按 Esc 收起（关闭通道与列宽菜单同一套）
  const mxReopen = await cdp.eval('window.__cellCtx("note", 1)')
  await sleep(150)
  const mxBeforeEsc = JSON.parse(await cdp.eval('window.__ctxMenu()'))
  await cdp.eval('window.__escKey()')
  await sleep(500)
  const mxAfterEsc = JSON.parse(await cdp.eval('window.__ctxMenu()'))
  check('M6 Esc 关掉右键菜单（DOM 里不留隐藏浮层，destroyOnHidden）',
    mxReopen === 'ok' && mxBeforeEsc.open === 1 && mxAfterEsc.open === 0,
    { mxReopen, before: mxBeforeEsc.open, after: mxAfterEsc.open })

  // 按值过滤：与手动输入同一条路（防抖 + 命中口径 + 页码回第 1 页）
  const mxUpperRow0 = String((await cdp.jeval('window.__cellXY("upper", 0)')).text)
  const mxP7 = await ctxPick('upper', 0, 5)
  let mxMFilter = null
  const t0m = Date.now()
  while (Date.now() - t0m < 5000) {
    const h = JSON.parse(await cdp.eval('window.__fHit()'))
    if (h && h.exists) { mxMFilter = h; break }
    await sleep(80)
  }
  const mxDraftUpper = await cdp.eval('window.__fValue()')
  check('M7 按此值过滤：过滤框写入该格文本、命中口径出来（走的就是防抖那条路）',
    mxP7.picked === 'ok' && String(mxDraftUpper) === mxUpperRow0 &&
    mxMFilter && mxMFilter.t === 10000 && mxMFilter.m > 0,
    { pick: mxP7.picked, upperRow0: mxUpperRow0, draft: mxDraftUpper, hit: mxMFilter && { m: mxMFilter.m, t: mxMFilter.t } })
  await cdp.eval('window.__fClear()')
  await sleep(400)

  // ---------- M8~M11) 行详情 Modal（逐字段 + 逐字段复制 + 复制整行） ----------
  await cdp.eval(`(() => {
    window.__rdModal = () => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .filter(window.__vis)
        .find(x => x.querySelector('.db-row-detail'))
      if (!m) return JSON.stringify({ open: 0 })
      const items = [...m.querySelectorAll('.db-row-detail-item')].filter(window.__vis)
      const text = el => (el ? String(el.textContent).trim() : '')
      return JSON.stringify({
        open: 1,
        title: text(m.querySelector('.ant-modal-title')),
        fields: items.map(x => text(x.querySelector('.db-row-detail-field'))),
        values: items.map(x => text(x.querySelector('.db-row-detail-value'))),
        expandBtns: items.filter(x => x.querySelector('.ant-btn-link')).length,
        copyBtns: items.filter(x => x.querySelector('.ant-btn-text')).length,
        footer: [...m.querySelectorAll('.ant-modal-footer button')].filter(window.__vis).map(text)
      })
    }
    window.__rdCopyField = name => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .filter(window.__vis)
        .find(x => x.querySelector('.db-row-detail'))
      if (!m) return 'no-modal'
      const it = [...m.querySelectorAll('.db-row-detail-item')]
        .find(x => String(x.querySelector('.db-row-detail-field').textContent).trim() === name)
      if (!it) return 'no-field'
      const btn = it.querySelector('.ant-btn-text')
      if (!btn) return 'no-btn'
      btn.click()
      return 'ok'
    }
    window.__rdFooter = i => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .filter(window.__vis)
        .find(x => x.querySelector('.db-row-detail'))
      if (!m) return 'no-modal'
      const b = [...m.querySelectorAll('.ant-modal-footer button')].filter(window.__vis)[i]
      if (!b) return 'no-btn'
      b.click()
      return 'ok'
    }
    return 'row-detail-probe-ready'
  })()`)
  await sleep(200)
  // 固定回单结果集 1 万行、无过滤：前面的 M7 改过过滤框
  await cdp.eval('window.__sqlMode = "one"')
  await runSql(cdp)
  const rdCellId = String((await cdp.jeval('window.__cellXY("id", 0)')).text)
  const rdCellNote = String((await cdp.jeval('window.__cellXY("note", 0)')).text)
  const rdOpen = await ctxPick('note', 0, 4)
  await sleep(400)
  const rd1 = JSON.parse(await cdp.eval('window.__rdModal()'))
  const rdExpTitle = await cdp.eval("String(window.translate('dbRowDetailTitle'))")
  check('M8 行详情 Modal：整行 5 字段、列序与表头同源、值取自被右键那一行',
    rdOpen.picked === 'ok' && rd1.open === 1 && rd1.title === rdExpTitle &&
    rd1.fields.join(',') === 'id,note,tag,upper,nullable' &&
    rd1.values[0] === rdCellId && rd1.values[1] === rdCellNote &&
    rd1.expandBtns === 0 && rd1.copyBtns === 5,
    {
      pick: rdOpen.picked,
      title: rd1.title,
      fields: rd1.fields,
      v0: rd1.values[0],
      v1: rd1.values[1],
      expand: rd1.expandBtns,
      copy: rd1.copyBtns
    })
  // 双主题同一批：此刻在手的是浅色（F20 切的），再切回启动时那套拍深色
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '7-row-detail-light.png')))
  if (cfg0.theme && cfg0.theme !== lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0.theme) + ')')
    await sleep(900)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '8-row-detail-dark.png')))
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(900)
  }

  const rdCopy = await cdp.eval('window.__rdCopyField("note")')
  const rdClip = JSON.parse(await cdp.eval('window.__clipEq(' + JSON.stringify(rdCellNote) + ')'))
  check('M9 逐字段复制：剪贴板读回就是该字段展示文本',
    rdCopy === 'ok' && rdClip.same === 1 && rdClip.len > 0,
    { copy: rdCopy, ...rdClip })

  const rdFooterCopy = await cdp.eval('window.__rdFooter(0)')
  const rdJson = JSON.parse(await cdp.eval(`(() => {
    try {
      const o = JSON.parse(String(window.pre.readClipboard()))
      return JSON.stringify({ keys: Object.keys(o).join(','), note: o.note, hasRowKey: '__rowKey' in o })
    } catch (e) { return JSON.stringify({ err: String(e) }) }
  })()`))
  check('M10 复制整行：键序与表头同源，__rowKey 等内部键不进结果',
    rdFooterCopy === 'ok' && rdJson.keys === 'id,note,tag,upper,nullable' &&
    rdJson.note === rdCellNote && rdJson.hasRowKey === false,
    { copy: rdFooterCopy, ...rdJson })

  const rdClosed = await cdp.eval('window.__rdFooter(1)')
  await sleep(400)
  const rdAfter = JSON.parse(await cdp.eval('window.__rdModal()'))
  check('M11 关闭后 Modal 从 DOM 移除（不是藏起来）',
    rdClosed === 'ok' && rdAfter.open === 0,
    { close: rdClosed, after: rdAfter.open })

  // ---------- E) 执行耗时状态（{rows} 行 · {ms} ms + 多结果页签总耗时） ----------
  // 状态行探针：读可见工具行右端的 .db-sql-elapsed 文本
  await cdp.eval(`(() => {
    window.__elapsedText = () => {
      const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
      const el = t && t.querySelector('.db-sql-elapsed')
      return el ? String(el.textContent).trim() : null
    }
    return 'elapsed-probe-ready'
  })()`)
  await sleep(200)
  // 固定到单结果集 1 万行：前面的段落可能停在双结果页签上
  await cdp.eval('window.__sqlMode = "one"')
  await runSql(cdp)
  // 期望文本从词条现算（页面语言可变，不能硬编码英文/中文任何一边）
  const expRows = n => `(() => String(window.translate('dbSqlRowsElapsed'))
    .replace('{rows}', ${n}).replace('{ms}', '123'))()`
  const e1 = await cdp.eval('window.__elapsedText()')
  const exp1 = await cdp.eval(expRows(10000))
  check('E1 状态行：{rows} 行 · {ms} ms（行数是原始口径，此时未过滤）',
    e1 === exp1, { e1, exp1 })

  const eF = await typeFilter(cdp, 'xneedle')
  const eHit = await readHit(cdp)
  const e2 = await cdp.eval('window.__elapsedText()')
  const exp2 = await cdp.eval(expRows(2))
  check('E2 过滤后状态行行数跟着命中口径走（与网格所见一致），耗时不变',
    eF.changed && eHit.m === 2 && e2 === exp2, { e2, exp2, hit: pick(eHit, ['m', 't']) })
  await cdp.eval('window.__fClear()')
  await sleep(400)

  await cdp.eval('window.__sqlMode = "two"')
  await runSql(cdp)
  const tabTexts = await cdp.eval(`JSON.stringify(
    [...document.querySelectorAll('.db-sql-results-tabs .ant-tabs-tab')].filter(window.__vis).map(x => String(x.textContent).trim())
  )`)
  const tabs = JSON.parse(tabTexts)
  const expSuffix = await cdp.eval(`' · ' + String(window.translate('dbSqlElapsedTotal'))
    .replace('{ms}', '123')`)
  check('E3 多结果集：总耗时标在每个页签旁（两页签共享一份 123 ms）',
    tabs.length === 2 && tabs.every(t => t.includes(expSuffix)),
    { tabs, expSuffix })
  await cdp.eval('window.__sqlMode = "one"')
  await runSql(cdp)

  // ---------- D) 导出补齐（TSV / JSONL / Markdown，CSV / JSON 回归） ----------
  // downloadText 走 Blob + a[download]，Electron 里会真触发下载；判据不落盘，
  // 改为截获 createObjectURL 的 Blob 读成文本存进 __dls，验内容与行数
  await cdp.eval(`(() => {
    window.__dls = []
    window.__dlArm = () => {
      if (!window.__dlPatched) {
        window.__dlPatched = true
        const orig = window.URL.createObjectURL.bind(window.URL)
        window.URL.createObjectURL = blob => {
          const url = orig(blob)
          // Blob.text() 按 UTF-8 解码会把 BOM 剥掉（规范行为），BOM 要从字节看
          Promise.all([
            blob.text ? blob.text() : Promise.resolve(''),
            blob.arrayBuffer ? blob.arrayBuffer() : Promise.resolve(new ArrayBuffer(0))
          ]).then(([t, buf]) => {
            const b = new Uint8Array(buf)
            window.__dls.push({
              mime: String(blob.type || ''),
              text: String(t),
              bom: b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF
            })
          }).catch(() => {})
          return url
        }
      }
      window.__dls = []
      return 'armed'
    }
    const dlBtn = () => {
      const t = [...document.querySelectorAll('.db-sql-result-tools')].filter(window.__vis)[0]
      if (!t) return null
      const b = [...t.querySelectorAll('button .anticon-download')].map(x => x.closest('button')).filter(window.__vis)[0]
      return b || null
    }
    window.__exportOpen = () => {
      const b = dlBtn()
      if (!b) return 'no-btn'
      b.click()
      return 'opened'
    }
    window.__exportPick = label => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .filter(window.__vis)
        .filter(x => !x.closest('.db-sql-cols-menu'))
      const it = items.find(x => String(x.textContent).trim() === label)
      if (!it) return 'no-item:' + items.map(x => String(x.textContent).trim()).join(',')
      it.click()
      return 'clicked'
    }
    return 'export-probe-ready'
  })()`)
  await sleep(300)
  const exportAs = async (cdp2, label) => {
    await cdp2.eval('window.__dlArm()')
    await cdp2.eval('window.__exportOpen()')
    await sleep(400)
    const picked = await cdp2.eval('window.__exportPick(' + JSON.stringify(label) + ')')
    await sleep(600)
    const dls = JSON.parse(await cdp2.eval('JSON.stringify(window.__dls)'))
    return { picked, dls }
  }

  const dCsv = await exportAs(cdp, 'CSV')
  check('D1 导出菜单回归：CSV 仍可导出（BOM + 表头行 + 1 万行）',
    dCsv.picked === 'clicked' && dCsv.dls.length === 1 &&
    dCsv.dls[0].mime.startsWith('text/csv') &&
    dCsv.dls[0].bom === true &&
    dCsv.dls[0].text.split('\r\n').length >= ROWS + 1,
    { picked: dCsv.picked, n: dCsv.dls.length, mime: dCsv.dls[0] && dCsv.dls[0].mime, lines: dCsv.dls[0] && dCsv.dls[0].text.split('\r\n').length })

  const dJson = await exportAs(cdp, 'JSON')
  check('D2 导出菜单回归：JSON 仍可导出（数组长度 1 万）',
    dJson.picked === 'clicked' && dJson.dls.length === 1 &&
    JSON.parse(dJson.dls[0].text).length === ROWS,
    { picked: dJson.picked, n: dJson.dls.length })

  const dTsv = await exportAs(cdp, 'TSV')
  const tsvTxt = dTsv.dls[0] ? dTsv.dls[0].text : ''
  check('D3 TSV：表头行 = 列名制表符连接，数据行 = 1 万 + 值内制表/换行压成空格',
    dTsv.picked === 'clicked' && dTsv.dls.length === 1 &&
    dTsv.dls[0].mime.startsWith('text/tab-separated-values') &&
    tsvTxt.split('\n').length === ROWS + 1 &&
    tsvTxt.split('\n')[0] === ['id', 'note', 'tag', 'upper', 'nullable'].join('\t'),
    { picked: dTsv.picked, mime: dTsv.dls[0] && dTsv.dls[0].mime, lines: tsvTxt.split('\n').length, head: tsvTxt.split('\n')[0] })

  const dJsonl = await exportAs(cdp, 'JSONL')
  const jsonlTxt = dJsonl.dls[0] ? dJsonl.dls[0].text : ''
  const jsonlLines = jsonlTxt.split('\n')
  check('D4 JSONL：一行一个 JSON 对象（1 万行逐行可 parse），列序以 fields 为准',
    dJsonl.picked === 'clicked' && dJsonl.dls.length === 1 &&
    dJsonl.dls[0].mime.startsWith('application/x-ndjson') &&
    jsonlLines.length === ROWS &&
    jsonlLines.every(l => { JSON.parse(l); return true }) &&
    Object.keys(JSON.parse(jsonlLines[0])).join(',') === 'id,note,tag,upper,nullable',
    { picked: dJsonl.picked, mime: dJsonl.dls[0] && dJsonl.dls[0].mime, lines: jsonlLines.length, keys: jsonlLines[0] ? Object.keys(JSON.parse(jsonlLines[0])).join(',') : '' })

  const dMd = await exportAs(cdp, 'Markdown')
  const mdTxt = dMd.dls[0] ? dMd.dls[0].text : ''
  const mdLines = mdTxt.split('\n')
  check('D5 Markdown：表头行 + 分隔行 + 1 万数据行（换行没把表撑破）',
    dMd.picked === 'clicked' && dMd.dls.length === 1 &&
    dMd.dls[0].mime.startsWith('text/markdown') &&
    mdLines.length === ROWS + 2 &&
    mdLines[0] === '| id | note | tag | upper | nullable |' &&
    mdLines[1] === '| --- | --- | --- | --- | --- |',
    { picked: dMd.picked, mime: dMd.dls[0] && dMd.dls[0].mime, lines: mdLines.length, head: mdLines[0] })

  // Markdown 转义要有真实样本：构造一列含竖线/换行/反引号的结果集再导
  // （换成桩的返回函数后必须真的重新执行一次 —— 导出读的是已加载的结果，
  // 不重新执行导出的还是那份 1 万行旧数据）
  await cdp.eval('window.__sqlResults = function () { return [{ sql: "pipe", fields: ["v"], columns: [{ name: "v", type: "varchar" }], rows: [{ v: "a|b" }, { v: "x" + String.fromCharCode(10) + "y" }, { v: "c`d" }, { v: null }] }] }')
  const runD6 = await runSql(cdp)
  const dMd2 = await exportAs(cdp, 'Markdown')
  const md2 = dMd2.dls[0] ? dMd2.dls[0].text : ''
  const md2Lines = md2.split('\n')
  check('D6 Markdown 转义真样本：竖线转义、换行变 <br>、反引号转义、NULL 空单元格',
    runD6.fired && md2Lines.length === 6 &&
    md2Lines[2].includes('a\\|b') && md2Lines[3].includes('x<br>y') &&
    md2Lines[4].includes('c\\`d') && md2Lines[5] === '|  |',
    { fired: runD6.fired, lines: md2Lines.length, rows: md2Lines.slice(2) })

  const hard = cdpRef.events.filter(l => /uncaught|error|Error|Cannot|Warning:/.test(String(l)))
  check('F22 渲染层没有新增硬错误（过滤全程无 uncaught/React 报错）',
    hard.length === 0, hard.slice(0, 6))

  return finish(results)
}

const bail = async code => {
  await restoreAll()
  process.exit(code)
}

main().then(f => bail(f ? 1 : 0), e => {
  console.error(e)
  return bail(1)
})
