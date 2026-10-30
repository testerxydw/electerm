#!/usr/bin/env node
/**
 * H7b-4 Redis Stream 详情 —— CDP 实机演示/回归（假 Redis，全程不碰真库）
 *
 * 后端 XINFO/XRANGE 与归一纯函数已由 src/test/unit-ci/db-redis-stream.spec.js 钉死，
 * 这里验的是"接到一起之后"的界面行为：
 *   1) 键列表里 stream 键能点开，详情走 Stream 视图而不是"不支持的类型"
 *   2) 元信息条：长度 / 首末 ID / 消费组数 / 累计写入
 *   3) 消费者组表：消费者/待确认/最后投递；老版本没有 lag 时出「—」不是 0
 *   4) 条目表：ID + 单行摘要 + 字段数；200 条一页，加载更多按游标续
 *   5) 单击条目格 → 值面板出完整多行字段（网格里只是摘要）
 *   6) XINFO 被实例禁用：元信息/组列表出「—」与说明，条目照常显示
 *   7) 只读：视图里没有任何输入框/写按钮；一条写命令都不发
 *   8) 刷新按钮重拉详情；样式：ID/组名走数据面等宽链，浅色主题跟着换色
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 且跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build && /usr/bin/rsync -a src/app/{lib,common}/ work/app/
 *   2) 起带 --remote-debugging-port 的实例
 *   3) node self-test/db-redis-stream-demo.js [debugPort] [shotDir]
 */
const fs = require('node:fs')
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-stream-shots')

const KEY_NAME = 'orders:stream'
const TOTAL = 250
const PAGE = 200

const STUB = `
(() => {
  window.__streamName = ${JSON.stringify(KEY_NAME)}
  window.__total = ${TOTAL}
  window.__page = ${PAGE}
  window.__calls = []
  window.__detailCalls = []
  window.__infoAvailable = true
  window.__groupsAvailable = true
  window.__streamEntries = (() => {
    const list = []
    for (let i = 0; i < ${TOTAL}; i++) {
      list.push([
        (1690000000000 + i) + '-0',
        ['orderId', 'order-' + i, 'amount', String(100 + i), 'payload',
          '{"step":"created","i":' + i + ',"note":"' + 'x'.repeat(60) + '"}']
      ])
    }
    return list
  })()
  window.__idOf = i => (1690000000000 + i) + '-0'
  window.__groupData = [
    ['name', 'workers', 'consumers', 2, 'pending', 3, 'last-delivered-id', window.__idOf(${TOTAL} - 10), 'entries-read', ${TOTAL} - 9, 'lag', 9],
    // 7.0 之前没有 lag/entries-read：界面必须出「—」，不能显示成 0（"已追平"）
    ['name', 'audit', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0']
  ]
  window.__streamInfo = () => ['length', window.__streamEntries.length, 'radix-tree-keys', 3,
    'radix-tree-nodes', 4, 'last-generated-id', window.__idOf(${TOTAL} - 1),
    'max-deleted-entry-id', '0-0', 'entries-added', 300,
    'recorded-first-entry-id', window.__idOf(0), 'groups', 2,
    'first-entry', window.__streamEntries[0], 'last-entry', window.__streamEntries[${TOTAL} - 1]]
  window.__startIndex = cursor => {
    if (!/^(\\d+)-(\\d+)$/.test(String(cursor || ''))) return 0
    const i = window.__streamEntries.findIndex(e => e[0] === String(cursor))
    return i < 0 ? 0 : i
  }
  window.__keys = [
    { name: ${JSON.stringify(KEY_NAME)}, type: 'stream', ttl: -1 },
    { name: 'user:1', type: 'string', ttl: -1 },
    { name: 'cache:foo', type: 'hash', ttl: 60 }
  ]
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__calls.push(op + ' ' + JSON.stringify(args))
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'db0', type: 'database', count: window.__keys.length }])
      }
      if (op === 'getPageData') {
        return Promise.resolve({ rows: window.__keys, nextCursor: '0', hasMore: false })
      }
      if (op === 'getKeyDetail') {
        window.__detailCalls.push(JSON.parse(JSON.stringify(args)))
        if (args.key !== window.__streamName) {
          return Promise.resolve({ type: 'string', value: 'v', fields: [], rows: [], ttl: -1, nextCursor: '0' })
        }
        const start = window.__startIndex(args.cursor)
        const size = Math.min(Number(args.pageSize) || window.__page, 1000)
        const rows = window.__streamEntries.slice(start, start + size)
        const next = start + rows.length
        return Promise.resolve({
          type: 'stream',
          value: null,
          fields: [],
          rows,
          ttl: -1,
          total: window.__streamEntries.length,
          nextCursor: next >= window.__streamEntries.length ? '0' : window.__idOf(next),
          streamInfo: window.__infoAvailable ? window.__streamInfo() : null,
          streamGroups: window.__infoAvailable && window.__groupsAvailable ? window.__groupData : null
        })
      }
      // 任何写命令都不该出现；记下来让断言能看见
      if (/^(set|del|unlink|expire|hset|xadd|xdel|xack|xgroup)/i.test(op)) {
        window.__writes = (window.__writes || 0) + 1
      }
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    if (name === 'closeDbTab') return Promise.resolve(null)
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
  window.__scope = () => document.querySelector('.session-current') || document
  window.__in = (root, sel) => [...root.querySelectorAll(sel)].filter(window.__vis)
  window.__one = sel => window.__in(document, sel)[0] || null
  window.__sone = sel => window.__in(window.__scope(), sel)[0] || null
  window.__norm = s => String(s || '').replace(/\\s+/g, '')
  window.__clickDb = name => {
    const all = [...document.querySelectorAll('.db-tree-db-name')]
    const el = all.filter(window.__vis).find(x => x.innerText.trim() === name) ||
      all.find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__treeReady = () => document.querySelectorAll('.session-current .db-tree-db-name').length > 0
  window.__keyRows = () => [...window.__scope().querySelectorAll('.db-redis-keys .ant-table-tbody div.ant-table-row')]
  window.__keyRowByName = name => window.__keyRows().find(tr => {
    const cells = tr.querySelectorAll('.ant-table-cell')
    return cells[1] && cells[1].innerText.trim() === name
  }) || null
  window.__clickKey = name => {
    const tr = window.__keyRowByName(name)
    if (!tr) return 'missing'
    tr.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  // ── Stream 视图 ────────────────────────────────────────────────
  window.__root = () => window.__sone('.db-redis-stream')
  window.__stats = () => {
    const r = window.__root()
    if (!r) return null
    const out = {}
    for (const s of r.querySelectorAll('.db-redis-stream-stat')) {
      const k = s.querySelector('.db-redis-stream-k')
      const v = s.querySelector('.db-redis-stream-v')
      if (k && v) out[k.innerText.trim()] = v.innerText.trim()
    }
    return out
  }
  window.__tables = () => {
    const r = window.__root()
    return r ? [...r.querySelectorAll('.ant-table')] : []
  }
  window.__cellsOf = i => {
    const t = window.__tables()[i]
    if (!t) return []
    return [...t.querySelectorAll('.ant-table-tbody .ant-table-row')].map(tr =>
      [...tr.querySelectorAll('.ant-table-cell')].map(td => td.innerText.trim()))
  }
  window.__entries = () => window.__cellsOf(window.__tables().length - 1)
  window.__groups = () => window.__cellsOf(0)
  window.__note = () => {
    const r = window.__root()
    if (!r) return null
    return [...r.querySelectorAll('.db-redis-stream-note')].map(n => n.innerText.trim())
  }
  // 表体虚拟渲染后 DOM 只有可视行，条数得看计数文案而不是行数
  window.__noteHas = s => (window.__note() || []).some(t => t.indexOf(s) > -1)
  window.__rects = () => {
    const r = window.__root()
    if (!r) return null
    const box = el => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { t: Math.round(b.top), h: Math.round(b.height) }
    }
    return {
      root: box(r),
      meta: box(r.querySelector('.db-redis-stream-meta')),
      groupsTable: box(r.querySelector('.db-redis-stream-groups-table')),
      entryHead: box(r.querySelectorAll('.db-redis-stream-head')[1]),
      entriesTable: box(r.querySelector('.db-redis-stream-entries-table')),
      more: box(r.querySelector('.db-redis-more'))
    }
  }
  window.__moreBtn = () => {
    const r = window.__root()
    return r ? r.querySelector('.db-redis-more') : null
  }
  window.__clickMore = () => {
    const b = window.__moreBtn()
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__clickRefresh = () => {
    const r = window.__root()
    const b = r && r.querySelector('.db-redis-stream-refresh')
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__clickEntryCell = (row, col) => {
    const t = window.__tables()[window.__tables().length - 1]
    if (!t) return 'missing'
    const tr = t.querySelectorAll('.ant-table-tbody .ant-table-row')[row]
    if (!tr) return 'missing'
    const td = tr.querySelectorAll('.ant-table-cell')[col]
    if (!td) return 'missing'
    td.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__pane = () => {
    const p = window.__sone('.db-value-pane')
    return p ? { text: p.innerText || '', title: (p.querySelector('.db-grid-title') || {}).innerText || '' } : null
  }
  window.__fonts = () => {
    const mono = window.__one('.db-redis-stream-mono')
    const k = window.__one('.db-redis-stream-k')
    return {
      mono: mono ? getComputedStyle(mono).fontFamily : null,
      k: k ? getComputedStyle(k).color : null
    }
  }
  window.__inputCount = () => {
    const r = window.__root()
    return r ? r.querySelectorAll('input,textarea').length : -1
  }
  window.__writeBtns = () => {
    const r = window.__root()
    if (!r) return null
    return [...r.querySelectorAll('button')]
      .map(b => window.__norm(b.innerText))
      .filter(t => /添加|删除|写入|ack|add|delete/i.test(t))
  }
  return 'stubbed'
})()
`

const openTab = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis 127.0.0.1:6379',
    dbType: 'redis',
    dbHost: '127.0.0.1',
    dbPort: 6379,
    dbPassword: '',
    dbName: '0',
    dbSsl: false,
    readOnly: true,
    batch: window.store.currentLayoutBatch
  })
  const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
  if (created) window.store.changeActiveTabId(created.id)
  return JSON.stringify({ id: created ? created.id : null })
})()
`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) throw new Error('no renderer page target; 实例是否带 --remote-debugging-port 起的？')
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront', {})
  // 窗口大小由窗管决定，统一钉成 1600×950 的 CSS 视口，跟其它批次截图同尺度
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = async f => {
    await sleep(350)
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) throw new Error('screenshot failed')
    fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
    console.log('shot -> ' + f)
  }

  await cdp.eval(STUB)
  await clearDbTabs(cdp)

  const tab = JSON.parse(await cdp.eval(openTab))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tab.id), 'redis tab active')
  const ready = await waitFor(cdp, 'window.__treeReady()', 'tree ready', 30000)
  const r0 = await cdp.eval("window.__clickDb('db0')")
  check('点开 db0', ready && r0 === 'ok', r0)
  await waitFor(cdp, 'window.__keyRows().length >= 3', 'key rows', 30000)

  // ── 1. 键列表里 stream 键的类型没错 ──────────────────────────────
  const typeCell = await cdp.eval(`(() => {
    const tr = window.__keyRowByName(window.__streamName)
    if (!tr) return null
    const cells = tr.querySelectorAll('.ant-table-cell')
    return cells[2] ? cells[2].innerText.trim() : null
  })()`)
  check('键列表把 stream 标成 stream（不是 string/unknown）', String(typeCell) === 'stream', typeCell)

  // ── 2. 点开：Stream 视图 + 元信息 ───────────────────────────────
  await cdp.eval('window.__clickKey(window.__streamName)')
  const viewOk = await waitFor(cdp, '!!window.__root()', 'stream view rendered')
  check('点开 stream 键走 Stream 视图（不是"不支持的类型"）', viewOk)
  const stats = JSON.parse(await cdp.eval('JSON.stringify(window.__stats())'))
  check('元信息：长度 250 / 累计写入 300 / 消费组 2',
    stats['长度'] === String(TOTAL) && stats['累计写入'] === '300' && stats['消费组'] === '2', stats)
  check('元信息：首末 ID 是真实 ID（不是「—」）',
    stats['首条 ID'] === '1690000000000-0' && stats['末条 ID'] === '1690000000249-0', stats)
  const notes0 = JSON.parse(await cdp.eval('JSON.stringify(window.__note())'))
  check('条目计数写"已加载 / 总数"', notes0.some(t => t.indexOf(PAGE + ' / ' + TOTAL) > -1), notes0)

  // ── 3. 消费者组表 ───────────────────────────────────────────────
  const groups = JSON.parse(await cdp.eval('JSON.stringify(window.__groups())'))
  check('消费组表两行：workers / audit',
    groups.length === 2 && groups[0][0] === 'workers' && groups[1][0] === 'audit', groups)
  check('组的消费者/待确认/最后投递原样呈现',
    groups[0][1] === '2' && groups[0][2] === '3' && groups[0][3] === '1690000000240-0', groups[0])
  check('没有 lag 字段的组出「—」而不是 0（0 是"已追平"这个真实结论）',
    groups[0][4] === '9' && groups[1][4] === '—', groups.map(g => g[4]))

  // ── 4. 条目表：单行摘要 + 字段数 ────────────────────────────────
  const entries = JSON.parse(await cdp.eval('JSON.stringify(window.__entries())'))
  check('首屏只取 200 条（计数 200 / 250），表体虚拟渲染只挂可视行',
    (await cdp.eval("window.__noteHas('200 / 250')")) === true &&
    entries.length > 0 && entries.length < 60, entries.length)
  check('条目行 = ID + 摘要 + 字段数',
    entries[0][0] === '1690000000000-0' && entries[0][2] === '3', entries[0])
  check('摘要压成单行且带截断省略号',
    !/\n/.test(entries[0][1]) && entries[0][1].indexOf('orderId=order-0') === 0 &&
    entries[0][1].endsWith('…'), entries[0][1])
  await shot('1-stream-dark.png')

  // ── 5. 单击格子 → 完整多行字段 ──────────────────────────────────
  await cdp.eval('window.__clickEntryCell(0, 1)')
  const paneOk = await waitFor(cdp, '!!window.__pane()', 'value pane open')
  const pane = JSON.parse(await cdp.eval('JSON.stringify(window.__pane())'))
  check('单击条目格展开值面板', paneOk && !!pane)
  check('值面板给完整字段（保留换行、不截断）',
    pane.text.indexOf('orderId=order-0') > -1 && pane.text.indexOf('\n') > -1 &&
    pane.text.indexOf('x'.repeat(60)) > -1, { len: pane.text.length })
  check('值面板标题指向"字段 · 第 N 行"', /字段/.test(pane.title) && /第\s*1\s*行/.test(pane.title), pane.title)
  const rects = JSON.parse(await cdp.eval('JSON.stringify(window.__rects())'))
  check('值面板打开时条目表仍然可见（不被挤成 0 高）',
    !!rects && !!rects.entriesTable && rects.entriesTable.h > 80, rects)
  await shot('2-stream-value-pane-dark.png')

  // ── 6. 加载更多：按游标续到 250，按钮消失 ───────────────────────
  const beforeMore = await cdp.eval('window.__detailCalls.length')
  const moreText = await cdp.eval('(window.__moreBtn() || {}).innerText || null')
  check('还有 50 条时给"加载更多（剩余 50）"', /50/.test(String(moreText)), moreText)
  await cdp.eval('window.__clickMore()')
  const moreOk = await waitFor(cdp, "window.__noteHas('250 / 250')", 'all entries loaded', 12000)
  check('加载更多续到 250 条', moreOk, await cdp.eval('JSON.stringify(window.__note())'))
  const lastCall = JSON.parse(await cdp.eval('JSON.stringify(window.__detailCalls[window.__detailCalls.length - 1])'))
  check('第二页从上一页末条的下一个 ID 开始（不重复末条）',
    lastCall.cursor === '1690000000200-0', lastCall.cursor)
  check('到末条后不再给"加载更多"', (await cdp.eval('!!window.__moreBtn()')) === false)
  const notes1 = JSON.parse(await cdp.eval('JSON.stringify(window.__note())'))
  check('计数刷新成 250 / 250', notes1.some(t => t.indexOf('250 / 250') > -1), notes1)
  check('只多发了一次详情请求（翻页不重拉首页）',
    (await cdp.eval('window.__detailCalls.length')) === beforeMore + 1)

  // ── 7. 只读：视图里没有输入框/写按钮，一条写命令都没发 ───────────
  check('视图内没有输入框', (await cdp.eval('window.__inputCount()')) === 0)
  const wb = JSON.parse(await cdp.eval('JSON.stringify(window.__writeBtns())'))
  check('视图内没有添加/删除按钮', wb.length === 0, wb)
  check('全程零写命令（只有 getMetadata/getPageData/getKeyDetail）',
    (await cdp.eval('window.__writes || 0')) === 0 &&
    (await cdp.eval('window.__calls.every(c => /^(getMetadata|getPageData|getKeyDetail) /.test(c))')) === true)

  // ── 8. 刷新：重拉首屏 ───────────────────────────────────────────
  const beforeRefresh = await cdp.eval('window.__detailCalls.length')
  await cdp.eval('window.__clickRefresh()')
  const refreshOk = await waitFor(cdp, 'window.__detailCalls.length > ' + beforeRefresh, 'refresh refetch', 8000)
  const backOk = await waitFor(cdp, "window.__noteHas('200 / 250')", 'entries back to first page', 8000)
  check('刷新按钮重拉详情（回到第一页 200 条）', refreshOk && backOk,
    await cdp.eval('JSON.stringify(window.__note())'))
  const refreshCall = JSON.parse(await cdp.eval('JSON.stringify(window.__detailCalls[window.__detailCalls.length - 1])'))
  check('刷新的请求游标是首页' + '（不带上一页的游标）', !refreshCall.cursor || refreshCall.cursor === '0', refreshCall.cursor)

  // ── 9. XINFO 被禁用：元信息出「—」，条目照常 ────────────────────
  await cdp.eval('window.__infoAvailable = false')
  await cdp.eval('window.__clickRefresh()')
  const dashOk = await waitFor(cdp, `(() => {
    const s = window.__stats()
    return s && s['长度'] === '—' && s['消费组'] === '—'
  })()`, 'meta falls back to dash', 8000)
  check('XINFO 拿不到：长度/消费组出「—」而不是 0', dashOk, await cdp.eval('JSON.stringify(window.__stats())'))
  const notes2 = JSON.parse(await cdp.eval('JSON.stringify(window.__note())'))
  check('组列表说明"该实例不支持 XINFO"',
    notes2.some(t => t.indexOf('不支持 XINFO') > -1), notes2)
  check('条目照常显示（元信息失败不牵连条目）',
    (await cdp.eval('window.__entries().length')) > 0 &&
    (await cdp.eval("window.__noteHas('200 / 250')")) === true,
    await cdp.eval('JSON.stringify(window.__note())'))
  await shot('3-stream-xinfo-unavailable-dark.png')

  // ── 10. 样式：等宽链 + 浅色主题 ─────────────────────────────────
  const fonts = JSON.parse(await cdp.eval('JSON.stringify(window.__fonts())'))
  check('ID/组名走数据面等宽字体链', /mono/i.test(String(fonts.mono)), fonts.mono)

  const theme0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = JSON.parse(await cdp.eval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))"))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== theme0)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(900)
    const light = JSON.parse(await cdp.eval('JSON.stringify(window.__fonts())'))
    check('浅色主题下元信息文字跟着换色（颜色来自 token）',
      !!light.k && light.k !== fonts.k, { dark: fonts.k, light: light.k })
    await shot('4-stream-light.png')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(theme0) + ')')
    await sleep(600)
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }

  const cleared = await clearDbTabs(cdp)
  check('自测收尾关闭数据库 tab', cleared.left.length === 0, cleared)

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err && err.stack ? err.stack : err)
  process.exit(1)
})
