#!/usr/bin/env node
/**
 * U4 Redis 键类型芯片 / TTL 芯片 —— CDP 实机回归（假 Redis，不碰真库）
 *
 * 覆盖：
 *   1) 键列表 type 列是芯片（六种类型分别带 is-string/hash/list/set/zset/stream）
 *   2) 芯片边框颜色取自 token（success / primary-text / info / warn / error / text-muted）
 *   3) TTL 列：有时限 = 时钟图标 + 秒数；无时限 = 弱化文案 is-none
 *   4) 键详情头部与 string 值面板头部共用同一对芯片（不再拼"type: x - ttl: y"文本）
 *   5) 深浅主题截图各一张
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync，跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（隔离 HOME）
 *   3) node self-test/db-redis-chips-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-redis-chips-shots')

const KEYS = [
  ['k:string', 'string', 300],
  ['k:hash', 'hash', -1],
  ['k:list', 'list', 120],
  ['k:set', 'set', -1],
  ['k:zset', 'zset', 600],
  ['k:stream', 'stream', -1]
]

const STUB = `
(() => {
  const KEYS = ${JSON.stringify(KEYS)}
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        return Promise.resolve([{ name: 'db0', type: 'database', count: KEYS.length }])
      }
      if (op === 'getPageData') {
        const rows = KEYS.map(([n, t, ttl]) => ({ name: n, type: t, ttl }))
        return Promise.resolve({ rows, nextCursor: '0', hasMore: false })
      }
      if (op === 'getKeyDetail') {
        const hit = KEYS.find(k => k[0] === args.key) || KEYS[0]
        const [, type, ttl] = hit
        if (type === 'string') {
          return Promise.resolve({ type, value: 'hello', fields: [], rows: [], ttl, total: 5 })
        }
        if (type === 'hash') {
          return Promise.resolve({ type, fields: ['f1', 'f2'], rows: { f1: 'v1', f2: 'v2' }, ttl })
        }
        if (type === 'list') {
          return Promise.resolve({ type, rows: ['a', 'b'], fields: [], ttl })
        }
        if (type === 'set') {
          return Promise.resolve({ type, rows: ['m1', 'm2'], fields: [], ttl })
        }
        if (type === 'zset') {
          return Promise.resolve({ type, rows: ['m1', '1', 'm2', '2'], fields: [], ttl })
        }
        return Promise.resolve({ type, rows: [], fields: [], ttl })
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
  window.__clickDb = name => {
    const el = [...document.querySelectorAll('.db-tree-db-name')].filter(window.__vis)
      .find(x => x.innerText.trim() === name) ||
      [...document.querySelectorAll('.db-tree-db-name')].find(x => x.innerText.trim() === name)
    if (!el) return 'missing'
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  }
  window.__rows = () => window.__in(window.__scope(), '.db-redis-keys .ant-table-row')
  window.__row = key => window.__rows().find(r => (r.innerText || '').indexOf(key) >= 0) || null
  // 勾选列在最前，列下标不可靠；按芯片类名取，避免把"列序变化"演成芯片缺失
  window.__typeCell = key => {
    const r = window.__row(key)
    if (!r) return JSON.stringify({ err: 'no-row:' + key })
    const chip = r.querySelector('.db-redis-type-chip')
    return JSON.stringify({
      text: chip ? chip.innerText.trim() : '',
      cls: chip ? String(chip.className) : '',
      border: chip ? getComputedStyle(chip).borderTopColor : '',
      color: chip ? getComputedStyle(chip).color : ''
    })
  }
  window.__ttlCell = key => {
    const r = window.__row(key)
    if (!r) return JSON.stringify({ err: 'no-row:' + key })
    const chip = r.querySelector('.db-redis-ttl-chip')
    return JSON.stringify({
      text: chip ? chip.innerText.trim() : '',
      cls: chip ? String(chip.className) : '',
      svg: !!(chip && chip.querySelector('svg')),
      color: chip ? getComputedStyle(chip).color : ''
    })
  }
  window.__clickKey = key => {
    const r = window.__row(key)
    if (!r) return 'missing'
    const td = [...r.children].find(c => (c.innerText || '').trim() === key)
    if (!td) return 'no-name-cell'
    td.click()
    return 'ok'
  }
  window.__detail = () => {
    const bar = window.__in(window.__scope(), '.db-redis-detail-bar')[0] || null
    const meta = window.__in(window.__scope(), '.db-redis-meta')[0] || null
    const read = box => box
      ? {
        type: (box.querySelector('.db-redis-type-chip') || {}).className || '',
        typeText: ((box.querySelector('.db-redis-type-chip') || {}).innerText || '').trim(),
        ttl: (box.querySelector('.db-redis-ttl-chip') || {}).className || '',
        ttlText: ((box.querySelector('.db-redis-ttl-chip') || {}).innerText || '').trim(),
        text: (box.innerText || '').replace(/\\s+/g, ' ').trim()
      }
      : null
    return JSON.stringify({ bar: read(bar), meta: read(meta) })
  }
  window.__tokenRgb = name => {
    const d = document.createElement('div')
    d.style.color = 'var(' + name + ')'
    document.body.appendChild(d)
    const rgb = getComputedStyle(d).color
    d.remove()
    return rgb
  }
  window.__themeIds = () => JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))
  return 'stub-installed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'redis chips demo',
    dbType: 'redis',
    dbHost: '127.0.0.1',
    dbPort: 6379,
    dbPassword: '',
    dbName: '0',
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

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = findPageTarget(targets)
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(400)

  await clearDbTabs(cdp)
  await cdp.call('Page.reload', {})
  await waitFor(cdp, '!!window.store', 'store ready')
  await sleep(800)
  const themeBefore = await cdp.eval('String((window.store._config || {}).theme || "")')

  const stub = await cdp.eval(STUB)
  check('桩 Redis 键空间已注入', stub === 'stub-installed', stub)
  const openRes = JSON.parse(await cdp.eval(OPEN_TAB))
  if (!openRes.id) {
    throw new Error('database tab was not created')
  }
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await waitFor(cdp, '!!document.querySelector(".db-tree-db-name")', 'redis tree')
  await cdp.eval('window.__clickDb("db0")')
  const ready = await waitFor(cdp, 'window.__rows().length >= 6', 'key rows')
  check('键列表出六行', ready && await cdp.eval('window.__rows().length') === 6)

  // ---- 1) 类型芯片 ----
  const types = {}
  for (const [k, t] of [['k:string', 'string'], ['k:hash', 'hash'], ['k:list', 'list'], ['k:set', 'set'], ['k:zset', 'zset'], ['k:stream', 'stream']]) {
    types[t] = JSON.parse(await cdp.eval(`window.__typeCell(${JSON.stringify(k)})`))
  }
  check('六种类型的芯片文本正确', Object.entries(types).every(([t, v]) => v.text === t), types)
  check('芯片修饰类与类型一一对应', Object.entries(types).every(([t, v]) => v.cls.includes('is-' + t)), types)

  // ---- 2) 芯片颜色 = token ----
  const want = {
    string: '--success',
    hash: '--primary-text',
    list: '--info',
    set: '--warn',
    zset: '--error',
    stream: '--text-muted'
  }
  const tok = {}
  for (const t of Object.values(want)) {
    tok[t] = await cdp.eval(`window.__tokenRgb(${JSON.stringify(t)})`)
  }
  for (const [t, token] of Object.entries(want)) {
    check(`${t} 芯片边框 = ${token}`, types[t].border === tok[token], { got: types[t].border, want: tok[token] })
  }

  // ---- 3) TTL 芯片 ----
  const ttl300 = JSON.parse(await cdp.eval('window.__ttlCell("k:string")'))
  const ttlNone = JSON.parse(await cdp.eval('window.__ttlCell("k:hash")'))
  check('有时限：时钟图标 + 秒数', ttl300.svg && ttl300.text === '300s' && !ttl300.cls.includes('is-none'), ttl300)
  const noneWord = await cdp.eval('window.translate("dbNone")')
  check('无时限：弱化文案 + is-none', ttlNone.text === noneWord && ttlNone.cls.includes('is-none') && ttlNone.svg, { ttlNone, noneWord })
  const muted = await cdp.eval('window.__tokenRgb("--text-muted")')
  check('无时限 TTL 用 --text-muted（弱化但不清零对比度）', ttlNone.color === muted, { got: ttlNone.color })

  // ---- 4) 详情头部统一 ----
  await cdp.eval('window.__clickKey("k:hash")')
  await waitFor(cdp, 'JSON.parse(window.__detail()).bar', 'hash detail')
  await sleep(400)
  const hashDetail = JSON.parse(await cdp.eval('window.__detail()'))
  check('hash 详情头部有类型芯片 is-hash', hashDetail.bar && hashDetail.bar.type.includes('is-hash') && hashDetail.bar.typeText === 'hash', hashDetail.bar)
  check('hash 详情头部有 TTL 芯片（无时限）', hashDetail.bar && hashDetail.bar.ttl.includes('is-none'), hashDetail.bar)
  check('详情头部不再拼 type:/ttl: 纯文本', hashDetail.bar && !/type:|ttl:/i.test(hashDetail.bar.text), hashDetail.bar)

  await cdp.eval('window.__clickKey("k:string")')
  await waitFor(cdp, 'JSON.parse(window.__detail()).meta', 'string detail')
  await sleep(400)
  const strDetail = JSON.parse(await cdp.eval('window.__detail()'))
  check('string 值面板头部有同一对芯片（is-string + 300s）',
    strDetail.meta && strDetail.meta.type.includes('is-string') && strDetail.meta.typeText === 'string' && strDetail.meta.ttlText === '300s', strDetail.meta)

  // ---- 5) 双主题截图 ----
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-chips-dark.png')))
  const themeIds = JSON.parse(await cdp.eval('window.__themeIds()'))
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== 'default')
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(800)
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-chips-light.png')))
    const lightType = JSON.parse(await cdp.eval('window.__typeCell("k:stream")'))
    check('浅色主题下芯片颜色跟着 token 变', lightType.border !== types.stream.border, { dark: types.stream.border, light: lightType.border })
    if (themeBefore) {
      await cdp.eval('window.store.setTheme(' + JSON.stringify(themeBefore) + ')')
      await sleep(300)
    }
  }

  const fails = results.filter(r => !r.ok)
  console.log(`\n${results.length - fails.length}/${results.length} PASS`)
  if (fails.length) {
    console.log(cdp.tail(8).join('\n'))
    process.exitCode = 1
  }
  cdp.ws.close()
  process.exit(process.exitCode || 0)
}

main().catch(e => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
