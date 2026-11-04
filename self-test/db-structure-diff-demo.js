#!/usr/bin/env node
/**
 * H4 结构对比 —— CDP 实机演示/回归（假库，不碰真库）
 *
 * 对比算法由 src/test/unit-ci/db-structure-diff.spec.js 钉死，主进程 refresh 旁路
 * 由 db-structure-refresh.spec.js 钉死；这里验"接到一起之后"的界面行为：
 *   1) 结构页工具条有"结构对比"入口；打开时 A 默认是当前表，B 没选不发请求
 *   2) 选齐两张表后各发一次 getTableStructure（带 refresh:true，绕过 60s 缓存）
 *   3) 概览计数与差异条目对得上：仅在 A / 仅在 B / 有差异都能在界面上找到
 *   4) 字段级：类型/注释变化显示"旧值 → 新值"；索引列顺序、外键动作的变化也算差异
 *   5) 同一张表比自己：明确说"结构一致"，不是一片空白
 *   6) 加载失败：报错条；且"换过选择后失败"不能拿上一对表的结果冒充
 *   7) 复制 Markdown：剪贴板里是报告（含 A/B 标题与差异行），不含任何 DDL
 *   8) 刷新只重拉这对表；静置不轮询
 *   9) 只读：全程只有 getTableStructure 等只读 op，没有写命令
 *  10) 浅色主题下颜色跟着 token 变
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync 与 writeClipboard，跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 起带 --remote-debugging-port 的实例（本仓库为 9227）
 *   3) node self-test/db-structure-diff-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-structure-diff-shots')

const STUB = `
(() => {
  const col = (name, extra) => Object.assign({
    name,
    dataType: 'int',
    columnType: 'int(11)',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    ordinal: 1,
    comment: null,
    maxLength: null,
    isBinary: false
  }, extra || {})
  const idx = (name, columns, extra) => Object.assign({
    name, unique: false, primary: false, columns, method: 'BTREE'
  }, extra || {})
  const fk = (name, columns, refTable, refColumns, extra) => Object.assign({
    name, columns, refSchema: 'demo', refTable, refColumns, onDelete: 'RESTRICT', onUpdate: 'NO ACTION'
  }, extra || {})
  const S = {
    orders: {
      type: 'table',
      columns: [
        col('id', { isPrimaryKey: true }),
        col('amount', { columnType: 'decimal(10,2)', dataType: 'decimal', defaultValue: '0.00' }),
        col('note', { columnType: 'varchar(64)', dataType: 'varchar', nullable: true, maxLength: 64 }),
        col('legacy_note', { columnType: 'varchar(32)', dataType: 'varchar', nullable: true, maxLength: 32 }),
        col('created_at', { columnType: 'datetime', dataType: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' }),
        col('status', { columnType: 'varchar(16)', dataType: 'varchar', maxLength: 16, defaultValue: 'new' }),
        col('user_id')
      ],
      indexes: [
        idx('PRIMARY', ['id'], { unique: true, primary: true }),
        idx('idx_user', ['user_id']),
        idx('idx_status_amount', ['status', 'amount'])
      ],
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'users', ['id'])],
      comment: '订单主表',
      estimatedRows: 12000
    },
    orders_archive: {
      type: 'table',
      columns: [
        col('id', { columnType: 'bigint(20)', dataType: 'bigint', isPrimaryKey: true }),
        col('amount', { columnType: 'decimal(12,2)', dataType: 'decimal', defaultValue: '0.00' }),
        col('note', { columnType: 'varchar(64)', dataType: 'varchar', nullable: true, maxLength: 64, comment: '备注' }),
        col('discount', { columnType: 'decimal(10,2)', dataType: 'decimal', nullable: true }),
        col('created_at', { columnType: 'datetime', dataType: 'datetime', defaultValue: 'current_timestamp()' }),
        col('status', { columnType: 'varchar(16)', dataType: 'varchar', maxLength: 16, defaultValue: 'new' }),
        col('user_id')
      ],
      indexes: [
        idx('PRIMARY', ['id'], { unique: true, primary: true }),
        idx('idx_user', ['user_id']),
        idx('idx_status_amount', ['amount', 'status'])
      ],
      foreignKeys: [fk('fk_orders_user', ['user_id'], 'users', ['id'], { onDelete: 'CASCADE' })],
      comment: '订单归档',
      estimatedRows: 900
    },
    users: {
      type: 'table',
      columns: [col('id', { isPrimaryKey: true }), col('email', { columnType: 'varchar(120)', dataType: 'varchar', maxLength: 120 })],
      indexes: [idx('PRIMARY', ['id'], { unique: true, primary: true })],
      foreignKeys: [],
      comment: null,
      estimatedRows: 300
    },
    products: {
      type: 'table',
      columns: [col('id', { isPrimaryKey: true })],
      indexes: [idx('PRIMARY', ['id'], { unique: true, primary: true })],
      foreignKeys: [],
      comment: null,
      estimatedRows: 20
    }
  }
  window.__structCalls = []
  window.__structFail = null
  window.__ops = []
  window.__clip = null
  window.pre.writeClipboard = s => { window.__clip = String(s) }

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__ops.push(op)
      if (op === 'getTableStructure') {
        window.__structCalls.push(JSON.parse(JSON.stringify(args)))
        if (window.__structFail === args.table) {
          return Promise.reject(new Error('boom: no access to information_schema for ' + args.table))
        }
        const hit = S[args.table]
        if (!hit) return Promise.reject(new Error('table not found: ' + args.table))
        return Promise.resolve(JSON.parse(JSON.stringify(hit)))
      }
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo',
          type: 'database',
          children: [
            { name: 'orders', type: 'table' },
            { name: 'orders_archive', type: 'table' },
            { name: 'users', type: 'table' },
            { name: 'products', type: 'table' },
            { name: 'v_orders', type: 'view' }
          ]
        }])
      }
      if (op === 'describeTable') {
        return Promise.resolve([{ Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: '' }])
      }
      if (op === 'getPageData') {
        return Promise.resolve({ rows: [{ id: 1 }], totalRows: 1, hasMore: false })
      }
      if (op === 'listColumns') return Promise.resolve([{ name: 'id', type: 'int' }])
      if (op === 'getReferences') return Promise.resolve([])
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  }

  window.__errs = []
  window.addEventListener('error', e => {
    const s = String((e.error && e.error.stack) || e.message || '')
    window.__errs.push(s.split('\\n').slice(0, 4).join(' | '))
  })
  window.addEventListener('unhandledrejection', e => {
    window.__errs.push('REJ ' + String((e.reason && e.reason.stack) || e.reason || '').split('\\n').slice(0, 3).join(' | '))
  })

  // ── DOM 探针 ────────────────────────────────────────────────────
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
  window.__diffBtn = () => [...document.querySelectorAll('.db-struct-tools button')]
    .filter(window.__vis).find(b => /结构对比|Compare structure/i.test(b.innerText)) || null
  window.__clickDiff = () => {
    const b = window.__diffBtn()
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__diffRoot = () => window.__one('.db-diff')
  window.__diffSels = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-select')] : []
  }
  // antd 6 的 Select 不再是 .ant-select-selection-item，选中值在 .ant-select-content 上
  window.__diffSelTexts = () => window.__diffSels().map(s => {
    const t = s.querySelector('.ant-select-content')
    // 没选中时这里是 placeholder（"选择表"），不能当成已选值
    if (!t || !t.classList.contains('ant-select-content-has-value')) return ''
    return (t.getAttribute('title') || t.innerText || '').trim()
  })
  window.__diffSelRect = i => {
    const s = window.__diffSels()[i]
    if (!s) return null
    const r = s.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__diffOptions = () => [...document.querySelectorAll('.ant-select-item-option')]
    .filter(window.__vis).map(o => o.innerText.trim())
  window.__diffOptRect = label => {
    const o = [...document.querySelectorAll('.ant-select-item-option')]
      .filter(window.__vis).find(x => x.innerText.trim() === label)
    if (!o) return null
    const r = o.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__diffTags = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-count')].map(t => t.innerText.trim()) : []
  }
  window.__diffSections = () => {
    const r = window.__diffRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-diff-section')].map(s => ({
      title: s.querySelector('.db-diff-section-title').innerText.trim(),
      rows: [...s.querySelectorAll('.db-diff-row')].map(row => ({
        cls: row.className,
        tag: row.querySelector('.db-diff-tag').innerText.trim(),
        name: row.querySelector('.db-diff-name').innerText.trim(),
        values: row.querySelector('.db-diff-values').innerText.trim()
      }))
    }))
  }
  window.__diffHint = () => {
    const r = window.__diffRoot()
    return r ? [...r.querySelectorAll('.db-diff-hint')].map(x => x.innerText.trim()).filter(Boolean) : []
  }
  window.__diffErr = () => {
    const r = window.__diffRoot()
    const a = r && r.querySelector('.db-diff-err')
    return a ? a.innerText : null
  }
  window.__diffFooter = re => {
    const r = window.__diffRoot()
    if (!r) return 'no-root'
    const box = r.closest('.ant-modal-container')
    // antd 6 会在两个汉字之间插空格（"关 闭"），比对前先抹掉空白
    const norm = x => String(x.innerText).split(' ').join('')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x => re.test(norm(x)))
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__diffCopy = () => window.__diffFooter(/复制|copy/i)
  window.__diffRefresh = () => window.__diffFooter(/刷新|refresh/i)
  window.__diffClose = () => window.__diffFooter(/关闭|close/i)
  window.__diffOpen = () => !!window.__diffRoot()
  window.__diffCopyDisabled = () => {
    const r = window.__diffRoot()
    if (!r) return null
    const box = r.closest('.ant-modal-container')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x => /复制|copy/i.test(x.innerText))
    return b ? b.disabled : null
  }
  window.__diffColor = sel => {
    const r = window.__diffRoot()
    const el = r && r.querySelector(sel)
    return el ? getComputedStyle(el).color : null
  }
  window.__diffBodyScroll = () => {
    const r = window.__diffRoot()
    const b = r && r.querySelector('.db-diff-body')
    return b ? { maxH: getComputedStyle(b).maxHeight, overflow: getComputedStyle(b).overflowY } : null
  }
  return 'stubbed'
})()
`

const OPEN_TAB = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'mysql root@127.0.0.1:3306/demo',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'root',
    dbPassword: '',
    dbName: 'demo',
    dbSsl: false,
    readOnly: true,
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
  await cdp.call('Runtime.enable')
  await cdp.call('Page.bringToFront', {})
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.call('Page.reload', { ignoreCache: true })
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 60000)
  await sleep(1200)

  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }

  await cdp.eval(STUB)
  await clearDbTabs(cdp)

  // 选一张表：从下拉里按可见文案点
  // 下拉有滑入动画：列表一出现就取坐标会点在动画途中，等它落定再点
  const pick = async (idx, label) => {
    const r = await cdp.jeval(`JSON.stringify(window.__diffSelRect(${idx}))`)
    if (!r) return 'no-select'
    await cdp.click(r.x, r.y)
    const ok = await waitFor(cdp, `window.__diffOptions().indexOf(${JSON.stringify(label)}) > -1`, 'options open', 5000)
    if (!ok) return 'no-option'
    await sleep(350)
    const o = await cdp.jeval(`JSON.stringify(window.__diffOptRect(${JSON.stringify(label)}))`)
    if (!o) return 'no-rect'
    await cdp.click(o.x, o.y)
    const hit = await waitFor(cdp,
      `window.__diffSelTexts()[${idx}] === ${JSON.stringify(label)}`, 'selection applied', 4000)
    return hit ? 'ok' : 'not-applied'
  }

  const refreshCalls = async () => {
    const all = await cdp.jeval('JSON.stringify(window.__structCalls)')
    return all.filter(c => c.refresh === true)
  }

  // ── 0. 打开一张表并切到结构页 ──────────────────────────────────
  const tab = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tab.id), 'mysql tab active')
  await waitFor(cdp, "document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper').length > 0", 'tree ready', 30000)
  await cdp.eval(`(() => {
    const d = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).find(x => x.innerText.trim() === 'demo')
    if (d) d.click()
  })()`)
  await sleep(600)
  await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).find(x => x.innerText.trim() === 'orders')
    if (t) t.click()
  })()`)
  await sleep(1600)
  const structTab = await cdp.eval(`(() => {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis).find(x => /表结构|Structure/.test(x.innerText))
    if (!t) return 'missing'
    t.click()
    return 'ok'
  })()`)
  check('切到表结构页签', structTab === 'ok', structTab)
  await sleep(600)

  const btnText = await cdp.eval('(window.__diffBtn() || {}).innerText || null')
  check('结构页工具条有「结构对比」入口且文案已翻译（不是词条 key）',
    /结构对比|Compare structure/i.test(String(btnText)) && !/DbStructDiff/.test(String(btnText)), btnText)

  // ── 1. 打开：A 默认当前表；B 没选不发请求 ──────────────────────
  await cdp.eval('window.__clickDiff()')
  const openOk = await waitFor(cdp, 'window.__diffOpen()', 'diff modal open', 10000)
  await waitFor(cdp, "window.__diffSelTexts()[0] === 'demo.orders'", 'base preselected', 5000)
  const sel0 = await cdp.jeval('JSON.stringify(window.__diffSelTexts())')
  check('打开后 A 默认是当前表（orders），B 留空',
    openOk && sel0[0] === 'demo.orders' && !sel0[1], sel0)
  check('只选 A 时给引导、不发请求、复制按钮禁用',
    (await cdp.jeval('JSON.stringify(window.__diffHint())')).some(t => /选择两张表/.test(t)) &&
    (await refreshCalls()).length === 0 &&
    (await cdp.eval('window.__diffCopyDisabled()')) === true,
    { hints: await cdp.jeval('JSON.stringify(window.__diffHint())'), copyDisabled: await cdp.eval('window.__diffCopyDisabled()') })

  // 打开 B 的下拉看候选
  {
    const r = await cdp.jeval('JSON.stringify(window.__diffSelRect(1))')
    await cdp.click(r.x, r.y)
    await waitFor(cdp, 'window.__diffOptions().length >= 3', 'options listed', 5000)
    await sleep(350)
    const listed = await cdp.jeval('JSON.stringify(window.__diffOptions())')
    check('B 的下拉列出同库 4 张表、排除视图',
      listed.length === 4 && listed.indexOf('demo.v_orders') < 0 && listed.indexOf('demo.orders_archive') > -1, listed)
    // 选中 orders_archive（下拉还开着，直接点选项）
    const o = await cdp.jeval('JSON.stringify(window.__diffOptRect("demo.orders_archive"))')
    await cdp.click(o.x, o.y)
    await waitFor(cdp, "window.__diffSelTexts()[1] === 'demo.orders_archive'", 'target selected', 4000)
  }

  // ── 2. 取数：两边各一次，带 refresh ────────────────────────────
  const loadedOk = await waitFor(cdp, 'window.__diffSections().length >= 3', 'diff rendered', 15000)
  const calls = await refreshCalls()
  check('两边结构各取一次，均带 refresh:true（绕过 60s 缓存）',
    loadedOk && calls.length === 2 && calls.every(c => c.refresh === true) &&
    calls.map(c => c.table).sort().join(',') === 'orders,orders_archive',
    calls)
  check('取数参数带当前库，schema 补空串',
    calls.length === 2 && calls.every(c => c.database === 'demo' && c.schema === ''), calls)

  // ── 3. 概览计数 ────────────────────────────────────────────────
  const tags = await cdp.jeval('JSON.stringify(window.__diffTags())')
  check('概览：仅在 A 1 / 仅在 B 1 / 有差异 5 / 相同 5',
    tags.some(t => /仅在 A/.test(t) && /\b1\b/.test(t)) &&
    tags.some(t => /仅在 B/.test(t) && /\b1\b/.test(t)) &&
    tags.some(t => /有差异/.test(t) && /\b5\b/.test(t)) &&
    tags.some(t => /相同/.test(t) && /\b5\b/.test(t)), tags)
  await shot('diff-dark')

  // ── 4. 三节的条目与方向 ────────────────────────────────────────
  const secs = await cdp.jeval('JSON.stringify(window.__diffSections())')
  const byTitle = t => secs.find(s => s.title.indexOf(t) === 0) || { rows: [] }
  const colRows = byTitle('列').rows
  const row = name => colRows.find(r => r.name === name) || {}
  check('列：仅在 B 的 discount / 仅在 A 的 legacy_note 方向正确',
    /is-added/.test(row('discount').cls || '') && /仅在 B/.test(row('discount').tag || '') &&
    /is-removed/.test(row('legacy_note').cls || '') && /仅在 A/.test(row('legacy_note').tag || ''),
    { discount: row('discount'), legacy: row('legacy_note') })
  check('列：id 类型 int(11) → bigint(20)，旧值/新值都在',
    /int\(11\)/.test(row('id').values || '') && /bigint\(20\)/.test(row('id').values || ''),
    row('id').values)
  // bddb67e7 起，"压根没有这个值"走 dbStructDiffNoValue 词条（中文（无）/ 英文 none），
  // 与字面量 NULL 不同形 —— 这里既要看到缺值占位，也要确认不再印 NULL
  check('列：note 只有注释变了（旧侧缺值走"（无）"占位，不再印成 NULL）',
    /备注/.test(row('note').values || '') &&
    /（无）|\bnone\b/.test(row('note').values || '') &&
    !/NULL/.test(row('note').values || ''), row('note').values)
  check('列：created_at 的 CURRENT_TIMESTAMP 写法差异不算差异（未出现在列表里）',
    !colRows.some(r => r.name === 'created_at'), colRows.map(r => r.name))
  const idxRows = byTitle('索引').rows
  check('索引：idx_status_amount 的列顺序变化被报出来',
    idxRows.length === 1 && idxRows[0].name === 'idx_status_amount' &&
    /\(status, amount\)/.test(idxRows[0].values) && /\(amount, status\)/.test(idxRows[0].values),
    idxRows)
  const fkRows = byTitle('外键').rows
  check('外键：fk_orders_user 的 ON DELETE 变化被报出来',
    fkRows.length === 1 && fkRows[0].name === 'fk_orders_user' &&
    /RESTRICT/.test(fkRows[0].values) && /CASCADE/.test(fkRows[0].values),
    fkRows)

  const bodyCss = await cdp.jeval('JSON.stringify(window.__diffBodyScroll())')
  // 56vh 会被解析成 px（1600×950 下 ≈ 532px），按视口比例核对
  const wantMax = Math.round(950 * 0.56)
  const gotMax = bodyCss ? Number(String(bodyCss.maxH).replace('px', '')) : NaN
  check('差异列表自己有滚动上限（56vh），不把弹层撑出视口',
    bodyCss && bodyCss.overflow === 'auto' && Math.abs(gotMax - wantMax) <= 2,
    { ...bodyCss, wantMax })

  // ── 5. 同一张表比自己：明确一致 ────────────────────────────────
  check('选中 B=orders（同一张表）', (await pick(1, 'demo.orders')) === 'ok')
  const sameOk = await waitFor(cdp, 'window.__diffHint().some(t => /结构一致/.test(t))', 'same state', 10000)
  const sameTags = await cdp.jeval('JSON.stringify(window.__diffTags())')
  check('同一张表：说"结构一致"，差异条目不画',
    sameOk && (await cdp.eval('window.__diffSections().length')) === 0 &&
    sameTags.some(t => /有差异/.test(t) && /\b0\b/.test(t)), sameTags)
  await shot('diff-same')

  // ── 6. 失败：报错条 + 不拿上一对冒充 ───────────────────────────
  await cdp.eval("window.__structFail = 'users'")
  check('选中 B=users（这次会失败）', (await pick(1, 'demo.users')) === 'ok')
  const errOk = await waitFor(cdp, '!!window.__diffErr()', 'error banner', 10000)
  const errText = String(await cdp.eval('window.__diffErr()') || '')
  check('加载失败：报错条含原始原因', errOk && /boom/.test(errText), errText.slice(0, 160))
  check('换过选择后失败：不画上一对表的结果', (await cdp.eval('window.__diffSections().length')) === 0,
    await cdp.eval('window.__diffSections().length'))
  await shot('diff-error')
  await cdp.eval('window.__structFail = null')
  await sleep(300)

  // ── 7. 复制 Markdown 报告 ─────────────────────────────────────
  await pick(1, 'demo.orders_archive')
  await waitFor(cdp, 'window.__diffSections().length >= 3', 'diff back', 15000)
  const copyRes = await cdp.eval('window.__diffCopy()')
  await sleep(300)
  const clip = String(await cdp.eval('window.__clip') || '')
  check('复制产出 Markdown 报告（A/B 标题 + 差异行）',
    copyRes === 'ok' && /^# 结构对比/.test(clip) && /A（基准）/.test(clip) && /legacy_note/.test(clip) && /discount/.test(clip),
    { copyRes, head: clip.slice(0, 120) })
  check('报告里没有任何 DDL 关键字',
    !/\b(ALTER|CREATE|DROP|TRUNCATE)\b/.test(clip), clip.match(/ALTER|CREATE|DROP|TRUNCATE/g))

  // ── 8. 刷新：只重拉这对表，不轮询 ─────────────────────────────
  const before = (await refreshCalls()).length
  await cdp.eval('window.__diffRefresh()')
  await waitFor(cdp, `window.__structCalls.filter(c => c.refresh === true).length >= ${before + 2}`, 'refresh fetched', 10000)
  const afterRefresh = (await refreshCalls()).length
  check('刷新只重拉这两张表（+2 次，都是 refresh）', afterRefresh === before + 2, { before, afterRefresh })
  await sleep(1500)
  const settled = (await refreshCalls()).length
  check('静置 1.5s 不轮询（调用数不变）', settled === afterRefresh, { afterRefresh, settled })

  // ── 9. 只读：没有写命令 ───────────────────────────────────────
  const ops = await cdp.jeval('JSON.stringify(window.__ops)')
  const writes = ops.filter(op => /^(set|del|unlink|hset|insert|update|alter|drop|create|truncate|exec|queryWrite)/i.test(op))
  check('全程零写命令（只有 getTableStructure 等只读 op）',
    writes.length === 0 && ops.indexOf('getTableStructure') > -1,
    { writes, ops: Array.from(new Set(ops)) })

  // ── 10. 浅色主题 ──────────────────────────────────────────────
  // --error / --success 是主题无关的语义色（两个主题下都是同一对红绿），
  // 会随主题翻的是文字/背景那组 token：表名与节标题走 --text，用它验
  const darkName = await cdp.eval("window.__diffColor('.db-diff-name')")
  const darkTitle = await cdp.eval("window.__diffColor('.db-diff-section-title')")
  const darkOld = await cdp.eval("window.__diffColor('.db-diff-old')")
  const darkNew = await cdp.eval("window.__diffColor('.db-diff-new')")
  const cfg0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const lightName = await cdp.eval("window.__diffColor('.db-diff-name')")
    const lightTitle = await cdp.eval("window.__diffColor('.db-diff-section-title')")
    const lightOld = await cdp.eval("window.__diffColor('.db-diff-old')")
    const lightNew = await cdp.eval("window.__diffColor('.db-diff-new')")
    check('换浅色主题后表名/节标题的 --text 跟着变（不是写死的深色）',
      !!darkName && !!lightName && lightName !== darkName && lightTitle !== darkTitle,
      { darkName, lightName, darkTitle, lightTitle })
    check('新旧值用主题无关的语义色（--error / --success 两个主题下一致）',
      !!darkOld && darkOld === lightOld && darkNew === lightNew,
      { darkOld, lightOld, darkNew, lightNew })
    await shot('diff-light')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
    await sleep(800)
  }

  const closeRet = await cdp.eval('window.__diffClose()')
  const closedOk = await waitFor(cdp, '!window.__diffOpen()', 'modal closed', 5000)
  check('关闭弹层', closedOk, closeRet)
  const cleared = await clearDbTabs(cdp)
  check('自测收尾关闭数据库 tab', cleared.left.length === 0, cleared)
  const errs = await cdp.jeval('JSON.stringify(window.__errs || [])')
  if (errs.length) console.log('renderer errors:\n  ' + errs.join('\n  '))
  const tail = cdp.tail(5)
  if (tail.length) console.log('renderer log tail:\n  ' + tail.join('\n  '))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
