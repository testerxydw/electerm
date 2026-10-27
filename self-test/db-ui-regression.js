#!/usr/bin/env node
/**
 * DBX 观感回归（CDP 驱动，无需真库）
 *
 * 为什么存在：A1/A2（renderCell useCallback、列定义 memo、dataSource memo）与
 * hooks 顺序修复都只能靠"真的把数据库页渲染出来"来证明 —— 单元测试跑的是源码字符串，
 * 而这类改动出问题时的表现是「白屏 / 高亮不刷新 / 列头不跟随语言」，全部发生在运行时。
 * 本机无 mysqld/redis，故在**渲染层 IPC 边界**注入桩数据：主进程一行不改，
 * 数据库页照常挂载与渲染，足以覆盖 UI 回归。
 *
 * 用法：
 *   1) 构建产物：npm run vite-build
 *   2) 启动带调试口的应用（隔离 HOME，避免污染真实配置）：
 *      DISPLAY=:110 HOME=/tmp/electerm-cdp-home ELECTRON_RUN_AS_NODE= \
 *        ./node_modules/electron/dist/electron work/app/app.js \
 *        --remote-debugging-port=9222 --no-sandbox
 *   3) node self-test/db-ui-regression.js [debugPort] [shotDir]
 *
 * 断言（任一失败即 exit 1）：
 *   - metadata 树渲染出库与表（含 view 节点）
 *   - 选中表后数据网格有行（证明 hooks 顺序正常：ready false→true 若 hook 数变化会直接抛错白屏）
 *   - 表注释出现在列头（colCommentByName 生效）
 *   - 页内过滤后 .db-page-hit 数量 > 0 且计数行出现（renderCell + pageFilterKw 依赖正确）
 *   - 表结构页签渲染出行（structureRows memo 正确）
 * 副作用：在 shotDir 落 3 张 PNG 供人工比对。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-ui-regression-shots')

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

// 桩数据：与真实适配器返回同形（getPageData → {rows,totalRows,hasMore}）
const STUB = `
(() => {
  const orig = window.pre.runGlobalAsync
  const rows = []
  for (let i = 1; i <= 40; i++) {
    rows.push({
      id: i,
      name: i % 3 === 0 ? 'alice' : 'bob' + i,
      email: 'user' + i + '@example.com',
      amount: i * 10,
      note: i === 5 ? 'alice special note' : 'n' + i
    })
  }
  const cols = [
    { name: 'id', type: 'int', comment: '主键' },
    { name: 'name', type: 'varchar(64)', comment: '用户名' },
    { name: 'email', type: 'varchar(128)', comment: '' },
    { name: 'amount', type: 'decimal(10,2)', comment: '金额' },
    { name: 'note', type: 'text', comment: '' }
  ]
  window.__dbStubCalls = []
  window.pre.runGlobalAsync = function (name, ...a) {
    if (name !== 'dbClientOp') {
      // 视角存储 / 建连 / 其他都当作"无副作用成功"，不碰主进程
      if (name === 'dbGridViewOp') {
        return Promise.resolve(a[0] === 'list' ? [] : null)
      }
      if (name === 'openDbTab') return Promise.resolve({ ok: true })
      return Promise.resolve(null)
    }
    const op = a[1]
    window.__dbStubCalls.push(op)
    if (op === 'getMetadata') {
      return Promise.resolve([{
        name: 'demo',
        type: 'database',
        children: [
          { name: 'users', type: 'table' },
          { name: 'orders', type: 'table' },
          { name: 'v_active', type: 'view' },
          {
            name: 'routines',
            type: 'group',
            group: 'routine',
            children: [
              { name: 'sp_demo', type: 'procedure' },
              { name: 'fn_demo', type: 'function' }
            ]
          },
          {
            name: 'triggers',
            type: 'group',
            group: 'trigger',
            children: [{ name: 'trg_demo', type: 'trigger', table: 'users' }]
          },
          {
            name: 'events',
            type: 'group',
            group: 'event',
            children: [{ name: 'ev_demo', type: 'event' }]
          }
        ]
      }])
    }
    if (op === 'describeTable') {
      return Promise.resolve([
        { Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment' },
        { Field: 'name', Type: 'varchar(64)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'email', Type: 'varchar(128)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'amount', Type: 'decimal(10,2)', Null: 'YES', Key: '', Default: null, Extra: '' },
        { Field: 'note', Type: 'text', Null: 'YES', Key: '', Default: null, Extra: '' }
      ])
    }
    if (op === 'getTableStructure') {
      return Promise.resolve({ columns: cols, foreignKeys: [] })
    }
    if (op === 'getPageData') return Promise.resolve({ rows, totalRows: 40, hasMore: false })
    if (op === 'countRows') return Promise.resolve({ count: 40 })
    if (op === 'listColumns') return Promise.resolve(cols.map(c => ({ name: c.name, type: c.type })))
    if (op === 'getReferences') return Promise.resolve([])
    if (op === 'getObjectDdl') {
      return Promise.resolve({
        name: a[2] && a[2].name,
        objectType: a[2] && a[2].objectType,
        ddl: 'CREATE PROCEDURE sp_demo()\\nBEGIN\\n  SELECT 1;\\nEND'
      })
    }
    return Promise.resolve(null)
  }
  return 'stub-installed'
})()
`

const openDbTab = `
(() => {
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
  return 'tab-added'
})()
`

// 非激活的 tab 面板仍在 DOM 里（display:none），且 antd 表格行在本环境
// getClientRects() 普遍返回 0（sticky + 容器），故用"祖先 display:none"判定可见性
const HELPERS = `
window.__hidden = el => {
  let n = el
  while (n && n !== document.body) {
    if (getComputedStyle(n).display === 'none') return true
    n = n.parentElement
  }
  return false
}
window.__vis = el => !window.__hidden(el)
window.__treeTitle = name => [...document.querySelectorAll('.ant-tree-title')]
  .filter(window.__vis)
  .find(x => x.innerText.trim() === name)
window.__visRows = () => [...document.querySelectorAll('.ant-table-row')]
  .filter(window.__vis).length
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

  // 返回 JS 值；表达式抛错时把错误信息带出来（不要静默 undefined）
  async eval (expression) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description) + ' :: ' + expression.slice(0, 80))
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

// 逐条记录断言结果，最后统一打印（中途失败也保留已跑完的结论）
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
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

  await cdp.eval(STUB)
  await cdp.eval(HELPERS)
  await cdp.eval(openDbTab)
  await sleep(1500)

  // 1) 树：库节点出现（metadata 已加载）
  await cdp.eval("(() => { const d = window.__treeTitle('demo'); if (!d) return 'missing'; d.click(); return 'ok' })()")
  await sleep(600)
  const treeNames = await cdp.eval("JSON.stringify([...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).map(x => x.innerText.trim()))")
  const names = JSON.parse(treeNames || '[]')
  check('元数据树渲染出库下的表与视图', names.includes('users') && names.some(n => n.includes('v_active')), names)

  // 2) 选中表：网格有行（hooks 顺序正常的最强证据 —— 顺序错了这里直接白屏抛错）
  await cdp.eval("(() => { const u = window.__treeTitle('users'); if (!u) return 'missing'; u.click(); return 'ok' })()")
  await sleep(1800)
  const rowCount = await cdp.eval('window.__visRows()')
  const headers = JSON.parse(await cdp.eval("JSON.stringify([...document.querySelectorAll('.ant-table-thead th')].filter(window.__vis).map(e => e.innerText.trim()).slice(0, 6))") || '[]')
  check('选中表后数据网格渲染出行', rowCount > 0, { rowCount })
  check('列头带上列注释（colCommentByName 生效）', headers.some(h => h.includes('主键')), headers)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '1-grid.png')))

  // 3) 页内过滤：renderCell 高亮 + 计数（验证 renderCell/columns 的依赖没漏）
  const filterInfo = await cdp.eval(`
    (() => {
      const input = document.querySelector('.db-page-filter input')
      if (!input) return JSON.stringify({ error: 'filter input missing' })
      input.focus()
      return JSON.stringify({ focused: document.activeElement === input })
    })()
  `)
  const focus = JSON.parse(filterInfo || '{}')
  if (focus.focused) {
    await cdp.call('Input.insertText', { text: 'alice' })
  }
  await sleep(900)
  const hitCount = await cdp.eval("document.querySelectorAll('.db-page-hit').length")
  const counter = await cdp.eval("(document.querySelector('.db-page-filter-count') || {}).innerText || ''")
  check('页内过滤后单元格高亮命中', hitCount > 0, { hitCount, counter })
  check('过滤计数行出现（N / 总数）', /\d+\s*\/\s*\d+/.test(String(counter)), counter)
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '2-filter-highlight.png')))

  // 4) 表结构页签：structureRows memo 的渲染路径
  const tabClicked = await cdp.eval(`
    (() => {
      const t = [...document.querySelectorAll('.ant-tabs-tab')].filter(window.__vis)
        .find(x => /表结构|Structure/.test(x.innerText))
      if (!t) return 'missing'
      t.click()
      return 'ok'
    })()
  `)
  await sleep(900)
  const structRows = await cdp.eval('window.__visRows()')
  check('表结构页签渲染出行', tabClicked === 'ok' && structRows > 0, { tabClicked, structRows })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '3-structure.png')))

  // 5) B2：树里出现非表对象分组，点开过程能看到 DDL
  await cdp.eval(`
    (() => {
      const g = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis)
        .find(x => x.innerText.includes('存储过程') || x.innerText.includes('Procedures'))
      if (g) g.click()
      return g ? 'ok' : 'missing'
    })()
  `)
  await sleep(600)
  const treeTitles = JSON.parse(await cdp.eval("JSON.stringify([...document.querySelectorAll('.ant-tree-title')].filter(window.__vis).map(x => x.innerText.trim()))") || '[]')
  check('B2 树里出现对象分组（过程与函数/触发器/事件）',
    treeTitles.some(t => /存储过程|Procedures/.test(t)) &&
    treeTitles.some(t => /触发器|Triggers/.test(t)) &&
    treeTitles.some(t => /事件|Events/.test(t)),
    treeTitles)

  const procClicked = await cdp.eval(`
    (() => {
      const p = [...document.querySelectorAll('.ant-tree-title')].filter(window.__vis)
        .find(x => x.innerText.includes('sp_demo'))
      if (!p) return 'missing'
      p.click()
      return 'ok'
    })()
  `)
  await sleep(700)
  const ddlText = await cdp.eval("((document.querySelector('.db-ddl-pre') || {}).textContent || '').slice(0, 60)")
  check('B2 点开过程弹出 DDL（走 getObjectDdl）',
    procClicked === 'ok' && /CREATE PROCEDURE/.test(String(ddlText)),
    { procClicked, ddlText })
  console.log('shot ->', await cdp.shot(path.join(SHOT_DIR, '4-object-ddl.png')))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('REGRESSION ERROR:', err.message)
  process.exit(2)
})
