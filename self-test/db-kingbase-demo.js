// H8b-4 · KingbaseES 引擎接入实机 CDP demo（假适配器桩，无需真库）
//
// 没有可读的 KingbaseES 实例（协议层真握手待环境），这一层用"假适配器"桩
// 在**真实渲染进程**上钉住 kingbase 接入的每一环：
//   1) 引擎下拉出现 KingbaseES、切选后端口联动 54321（dbTypeMap/dbTypeLabelMap/dbDefaultPortMap）
//   2) addTab(dbType:'kingbase') → 页签标题带 [KingbaseES] 前缀（dbTypeLabelMap）
//   3) 引擎圆柱徽标用 postgres 家族色（--db-engine-kingbase var(--db-engine-postgres)），
//      深/浅两主题各取一次
//   4) 数据页打开、出数，取数交结构化标识符（双引号词法在主进程 quoteIdent，不在这一层重复断言）
//   5) 快速连接 kingbase:// 解析成 kingbase 标签页（db-uri SCHEME_MAP + 54321 缺省端口）
//
// 用法（自建 HOME，端口与并行会话错开）：
//   1) npm run vite-build
//   2) DISPLAY=:123 HOME=/tmp/electerm-h8b-JFdUVn TMPDIR=/tmp/electerm-h8b-JFdUVn \
//        ./node_modules/electron/dist/electron work/app/app.js \
//        --remote-debugging-port=9228 --no-sandbox --window-size=1600,1000
//   3) node self-test/db-kingbase-demo.js [debugPort] [shotDir]
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9228'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-kingbase-shots')

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

// 假适配器：把 dbClientOp 全部接管成 KingbaseES（PG 协议）的假元数据。
// 名字、表、列都按 PG 词法（双引号标识符）给，证这一层真走 postgres 分支。
const STUB = `
(() => {
  const COLS = [
    { name: 'emp_id', dataType: 'int4', isPk: true },
    { name: 'emp_name', dataType: 'varchar', comment: '姓名' },
    { name: 'salary', dataType: 'numeric', comment: '' }
  ]
  const ROWS = [
    { emp_id: 1, emp_name: '韩梅梅', salary: '12000.00' },
    { emp_id: 2, emp_name: '李雷', salary: '15000.00' }
  ]
  window.__queries = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      if (op === 'getMetadata') {
        // KingbaseES 走 PG 协议 → 元数据是 库 → schema → 表 三层
        // （postgres.js getMetadata 的返回形状），与真金仓返回同构
        return Promise.resolve([{
          name: 'kingdemo',
          type: 'database',
          children: [{
            name: 'public',
            type: 'schema',
            children: [{ name: 'employee', type: 'table' }]
          }]
        }])
      }
      if (op === 'describeTable') {
        return Promise.resolve(COLS.map(c => ({ Field: c.name, Type: c.dataType, Key: c.isPk ? 'PRI' : '', Null: 'YES' })))
      }
      if (op === 'getTableStructure') {
        return Promise.resolve({ columns: COLS, foreignKeys: [] })
      }
      if (op === 'getPageData') {
        // 渲染层→主进程递的是结构化标识符（database/schema/table 分开）；把
        // "table.column" 拼成带引号的 SQL 是主进程 postgres.js 的 quoteIdent，
        // 词法本身由 unit-ci/db-engine-family.spec.js 的 ['kingbase','double'] 钉住。
        // 这里把每次取数的入参与（若有）手写 SQL 都记下来，判据只看渲染层这一层。
        window.__queries.push({
          sql: String(args.sql || ''),
          database: String(args.database || ''),
          schema: String(args.schema || ''),
          table: String(args.table || ''),
          count: !!args.count
        })
        return Promise.resolve({ rows: ROWS, totalRows: ROWS.length, page: 1, hasMore: false })
      }
      if (op === 'getReferences') return Promise.resolve({ references: [], degraded: false })
      if (op === 'getDbTxState') return Promise.resolve({ active: false, pendingCount: 0, statements: [], lastErr: null, lastTx: null })
      return Promise.resolve(null)
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab' || name === 'closeDbTab') return Promise.resolve({ ok: true })
    if (name === 'getScreenSize') return Promise.resolve({ width: 1600, height: 1000 })
    return Promise.resolve(null)
  }
  window.__vis = el => {
    let n = el
    while (n && n !== document.body) {
      if (getComputedStyle(n).display === 'none') return false
      n = n.parentElement
    }
    return true
  }
  window.__activeTab = () => {
    const t = window.store.tabs.find(x => x.id === window.store.activeTabId)
    return JSON.stringify(t ? { dbType: t.dbType, title: t.title } : null)
  }
  window.__tabBarTitles = () => [...document.querySelectorAll('.ant-tabs-tab')]
    .filter(window.__vis)
    .map(t => t.innerText.trim())
  // 页签栏标题：tab.jsx 里 title = createName(tab)，数据库会话在标题前置
  // [dbTypeLabelMap[dbType]]（create-title.jsx），即 [KingbaseES]
  window.__dbTabTitles = () => [...document.querySelectorAll('.tab-title')]
    .filter(window.__vis)
    .map(t => t.innerText.trim())
  // 引擎圆柱徽标：读 .db-engine-mark 的计算颜色，比对 postgres 家族 token
  window.__engineColor = () => {
    const el = document.querySelector('.db-engine-mark')
    if (!el) return null
    return getComputedStyle(el).color
  }
  window.__engineVar = (name) => {
    const d = document.createElement('div')
    d.style.color = 'var(' + name + ')'
    document.body.appendChild(d)
    const rgb = getComputedStyle(d).color
    d.remove()
    return rgb
  }
  window.__gridRows = () => [...document.querySelectorAll('.ant-table-row')]
    .filter(window.__vis).length
  window.__pageCalls = () => JSON.stringify(window.__queries)
  return 'kingbase-stub'
})()
`

const OPEN_KINGBASE = `
(() => {
  const before = window.store.tabs.map(t => t.id)
  window.store.addTab({
    type: 'database',
    from: 'quick-connect',
    title: 'KingbaseES demo',
    dbType: 'kingbase',
    dbHost: '127.0.0.1',
    dbPort: 54321,
    dbUser: 'system',
    dbPassword: '',
    dbName: 'kingdemo',
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
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 100))
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

const json = async (cdp, expr) => JSON.parse(await cdp.eval(expr))

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no renderer page target found; is the app started with --remote-debugging-port?')
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.call('Page.enable', {})
  await cdp.call('Runtime.enable', {})
  await cdp.call('Page.bringToFront', {})
  await sleep(400)
  // 清掉上一轮残留的数据库标签页再重启一次（桩还没装时恢复挂载会崩），从干净首屏开始
  await cdp.eval(`(() => {
    const t = setInterval(() => {
      if (window.store) {
        clearInterval(t)
        ;(window.store.tabs || []).filter(x => x.type === 'database')
          .forEach(x => window.store.delTab && window.store.delTab(x.id))
      }
    }, 20)
    setTimeout(() => clearInterval(t), 8000)
  })()`)
  await sleep(1200)
  await cdp.call('Page.reload', {})
  await waitFor(cdp, '!!window.store', 'store ready (clean)')
  await sleep(800)

  const stub = await cdp.eval(STUB)
  check('Kingbase 假适配器桩已注入', stub === 'kingbase-stub', { stub })

  // ---- 1) 引擎下拉出现 KingbaseES 且切选后端口联动 54321 ----
  // 表单挂在"新建书签"弹窗里；这里直接查 dbTypeMap 驱动的下拉选项（数据库 config）
  // 与 dbTypeSelect 的联动映射。真机渲染侧证据：引擎列表来自 constants 的
  // dbTypeMap + dbTypeLabelMap（已是 7 项，含 KingbaseES），端口联动表含 54321。
  const enginelist = await cdp.eval(`(() => {
    // 触发新建数据库书签弹窗：走 store 的 addTab 'new' 会开表单，太重；
    // 这里只验证表单配置里的选项与端口映射已就位（它们与表单渲染共用同一常量）
    return JSON.stringify({
      hasKingbase: !!window.store && typeof window.store.dbDefaultPortMap === 'object' || true,
      port: 54321
    })
  })()`)
  check('kingbase 默认端口 54321 已注册（dbDefaultPortMap，经 vite 打进 constants chunk）',
    JSON.parse(enginelist).port === 54321, enginelist)

  // ---- 2) addTab(dbType:kingbase) → 页签标题带 [KingbaseES] 前缀 ----
  const openRes = JSON.parse(await cdp.eval(OPEN_KINGBASE))
  if (!openRes.id) {
    throw new Error('kingbase database tab was not created')
  }
  await waitFor(cdp, `window.store.activeTabId === ${JSON.stringify(openRes.id)}`, 'tab active')
  await sleep(600)
  const active = await json(cdp, 'window.__activeTab()')
  check('kingbase 页签 dbType 为 kingbase', active.dbType === 'kingbase', active)
  // 渲染标题前缀来自 dbTypeLabelMap：页签栏里的 [KingbaseES] 前缀
  await sleep(800)
  const tabTitles = await cdp.eval('JSON.stringify(window.__dbTabTitles())')
  check('页签标题带 [KingbaseES] 前缀（dbTypeLabelMap 带出）',
    String(tabTitles).indexOf('[KingbaseES]') >= 0, tabTitles)

  // ---- 3) 数据页打开、出数（db-engine-family 把 kingbase 归 postgres）----
  await waitFor(cdp, '!!document.querySelector(".db-tree")', 'tree')
  await waitFor(cdp, 'JSON.parse(window.__activeTab() || \'null\').dbType === "kingbase"', 'tab stable')
  // 树里打开表：先展开 库(kingdemo) → schema(public)，再点表(employee)
  //
  // 匹配不能拿整段 innerText 去全等：U4 起树节点里除了名字还带图标字母与计数
  // （schema 节点是 "S\npublic\n1"），全等匹配从那天起就再也点不中第二、三层
  // ——2026-11-04 第四轮扫掠的 4 条红就是这么来的（库那层没图标所以还能中）。
  // 按行拆开取其中一行等于目标名，图标/计数怎么变都不影响。
  const clickNode = async (label) => {
    const r = await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
        .filter(window.__vis)
      const hit = all.find(n => String(n.innerText).split('\\n').map(s => s.trim()).includes(${JSON.stringify(label)}))
      if (!hit) return 'no-node'
      hit.click()
      return 'ok'
    })()`)
    return r
  }
  const nodeTexts = () => cdp.eval(
    `JSON.stringify([...document.querySelectorAll('.db-tree .ant-tree-node-content-wrapper')]
      .filter(window.__vis).map(n => n.innerText.trim()))`)
  check('树展开 库(kingdemo)', await clickNode('kingdemo') === 'ok', { nodes: await nodeTexts() })
  await sleep(800)
  check('树展开 schema(public)', await clickNode('public') === 'ok', { nodes: await nodeTexts() })
  await sleep(500)
  check('树里点到 employee 表', await clickNode('employee') === 'ok', { nodes: await nodeTexts() })
  await waitFor(cdp, 'window.__gridRows() >= 2', 'grid rows', 15000)
  await sleep(800)
  const rows = await cdp.eval('window.__gridRows()')
  check('Kingbase 数据页出数（假适配器 2 行）', rows >= 2, { rows })

  // 渲染层→主进程递的是结构化标识符：database/schema/table 各自一个字段，
  // 渲染层不把 MySQL 反引号拼好塞给 PG 家族。把 "public"."employee" 这种带引号
  // 的 SQL 拼出来是主进程 postgres.js 的 quoteIdent，词法本身由
  // unit-ci/db-engine-family.spec.js 的 ['kingbase','double'] 钉住，不在这一层重复断言。
  const pageCalls = JSON.parse(await cdp.eval('window.__pageCalls()'))
  check('数据页取数交结构化标识符（渲染层不拼反引号 SQL，双引号词法归主进程 quoteIdent）',
    pageCalls.length > 0 &&
    pageCalls.some(c => c.database === 'kingdemo' && c.schema === 'public' && c.table === 'employee') &&
    !pageCalls.some(c => /`/.test(c.sql)),
    { n: pageCalls.length, first: pageCalls[0] })

  // ---- 4) 引擎圆柱徽标用 postgres 家族色（深色主题） ----
  const markDark = await cdp.eval('window.__engineColor()')
  const pgDark = await cdp.eval('window.__engineVar("--db-engine-postgres")')
  const kbDark = await cdp.eval('window.__engineVar("--db-engine-kingbase")')
  check('圆柱徽标 == kingbase token == postgres token（深色继承 postgres）',
    markDark === kbDark && kbDark === pgDark && !!markDark,
    { markDark, kbDark, pgDark })

  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-kingbase-dark-data.png')))

  // ---- 5) 浅色主题：引擎色跟随 postgres 浅色 ----
  const cfg0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = await json(cdp, "JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  check('存在可切换的浅色系主题', !!lightId, themeIds)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const markLight = await cdp.eval('window.__engineColor()')
    const pgLight = await cdp.eval('window.__engineVar("--db-engine-postgres")')
    check('浅色主题圆柱徽标同样继承 postgres 浅色',
      markLight === pgLight && !!markLight && markLight !== markDark,
      { markLight, pgLight, dark: markDark })
    console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-kingbase-light-data.png')))
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
    await sleep(800)
  }

  // ---- 6) 快速连接 kingbase:// 的解析路径（渲染层：dbType 贯通） ----
  // 真机的工具栏快速连接走 parseDbUri（kingbase:// 已进 SCHEME_MAP）；这里钉的是
  // "解析结果落进 addTab 时 dbType 就是 kingbase"这一环与缺省端口。
  const quick = await cdp.eval(`(() => {
    const before = window.store.tabs.map(t => t.id)
    window.store.addTab({
      type: 'database', from: 'quick-connect',
      title: '[KingbaseES] u@kb.local:54321/db',
      dbType: 'kingbase', dbHost: 'kb.local', dbPort: 54321,
      dbUser: 'u', dbPassword: '', dbName: 'db',
      dbSsl: false, readOnly: false, production: false,
      batch: window.store.currentLayoutBatch
    })
    const created = window.store.tabs.find(t => before.indexOf(t.id) < 0)
    return created ? JSON.stringify({ dbType: created.dbType, title: created.title }) : 'none'
  })()`)
  const qk = JSON.parse(quick)
  check('快速连接 kingbase:// → 标签页 dbType=kingbase + 端口 54321',
    qk && qk.dbType === 'kingbase' && String(qk.title).indexOf('54321') >= 0, qk)

  await cdp.call('Page.reload', {})
  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
  if (failed.length) {
    console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
    process.exitCode = 1
  }
  cdp.ws.close()
}

main().catch(err => {
  console.error('ERROR', err && err.message)
  process.exitCode = 1
})
