#!/usr/bin/env node
/**
 * H6a 参数化查询 —— CDP 实机演示/回归（假库，不碰真库）
 *
 * 抽参与占位符转换由 src/test/unit-ci/db-sql-params.spec.js 钉死，后端只吃数组
 * 由 db-sql-params-adapter.spec.js 钉死，面板接线由 db-sql-params-panel.spec.js 钉死。
 * 这里验"接到一起之后"的界面行为：
 *   1) 工具条上的参数开关默认开；关掉就回到纯文本执行
 *   2) 语句里有 :name 时先弹面板收值，按出现顺序一行一个
 *   3) 发给服务端的是占位符 SQL + 独立 params 数组：值原文绝不出现在 SQL 里
 *   4) 历史存用户原文（含 :name），参数值不进历史
 *   5) 同名参数只问一次；再执行带出上次的值；取消 = 零执行
 *   6) 字符串/注释里的 :x 不算参数；多语句在开面板前被挡掉并说明原因
 *   7) NULL 勾选即禁用输入，提交的是真正的 null（不是空串）
 *   8) 浅色主题下参数面板颜色跟着 token 走
 *
 * ⚠️ 本脚本接管 window.pre.runGlobalAsync，跑完不还原。
 *
 * 用法：
 *   1) npm run vite-build   （改了 src/app 还要 rsync 到 work/app 并重启实例）
 *   2) 起带 --remote-debugging-port 的实例（本仓库为 9227）
 *   3) node self-test/db-sql-params-demo.js [debugPort] [shotDir]
 */
const path = require('node:path')
const { getJson, buildHelpers, Cdp, sleep, waitFor, findPageTarget, clearDbTabs } = require('./db-ui-helpers')

const PORT = process.argv[2] || '9227'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'db-sql-params-shots')

const STUB = `
(() => {
  const COLS = [{ name: 'echo', type: 'text' }]
  window.__exec = []
  window.__ops = []
  window.__hist = []
  window.__execFail = null

  window.pre.runGlobalAsync = function (name, ...a) {
    if (name === 'dbClientOp') {
      const op = a[1]
      const args = a[2] || {}
      window.__ops.push(op)
      if (op === 'executeSql') {
        window.__exec.push(JSON.parse(JSON.stringify({
          sql: args.sql,
          database: args.database === undefined ? null : args.database,
          params: args.params === undefined ? null : args.params
        })))
        if (window.__execFail) {
          return Promise.reject(new Error(window.__execFail))
        }
        return Promise.resolve({
          results: [{
            sql: args.sql,
            fields: ['echo'],
            columns: COLS,
            rows: [{ echo: JSON.stringify(args.params === undefined ? null : args.params) }]
          }],
          elapsedMs: 3
        })
      }
      if (op === 'getMetadata') {
        return Promise.resolve([{
          name: 'demo',
          type: 'database',
          children: [
            { name: 'users', type: 'table' },
            { name: 'orders', type: 'table' }
          ]
        }])
      }
      if (op === 'describeTable') {
        return Promise.resolve([
          { Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: '' },
          { Field: 'name', Type: 'varchar(64)', Null: 'YES', Key: '', Default: null, Extra: '' }
        ])
      }
      if (op === 'getPageData') return Promise.resolve({ rows: [{ id: 1 }], totalRows: 1, hasMore: false })
      if (op === 'listColumns') return Promise.resolve([{ name: 'id', type: 'int' }])
      if (op === 'getReferences') return Promise.resolve([])
      if (op === 'getTableStructure') return Promise.resolve({ columns: [], foreignKeys: [] })
      return Promise.resolve(null)
    }
    if (name === 'dbSqlHistoryOp') {
      if (a[0] === 'append') {
        window.__hist.push(JSON.parse(JSON.stringify(a[1] || {})))
        return Promise.resolve(window.__hist.slice())
      }
      if (a[0] === 'list') return Promise.resolve(window.__hist.slice())
      return Promise.resolve([])
    }
    if (name === 'dbGridViewOp') return Promise.resolve(a[0] === 'list' ? [] : null)
    if (name === 'openDbTab' || name === 'closeDbTab' || name === 'setDbReadOnly') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  }

  window.__errs = []
  window.addEventListener('error', e => {
    window.__errs.push(String((e.error && e.error.stack) || e.message || '').split('\\n').slice(0, 3).join(' | '))
  })
  window.addEventListener('unhandledrejection', e => {
    window.__errs.push('REJ ' + String((e.reason && e.reason.stack) || e.reason || '').split('\\n').slice(0, 3).join(' | '))
  })

  window.__paramBtn = () => [...document.querySelectorAll('.db-sql-bar button')]
    .filter(window.__vis)
    .find(b => /^(参数|params)$/i.test(b.innerText.replace(/\\s/g, '')) ||
      /:name/.test(String(b.getAttribute('title') || ''))) || null
  window.__paramModeOn = () => {
    const b = window.__paramBtn()
    return b ? b.className.indexOf('ant-btn-primary') >= 0 : null
  }
  window.__clickParamToggle = () => {
    const b = window.__paramBtn()
    if (!b) return 'missing'
    b.click()
    return 'ok'
  }
  window.__paramRoot = () => window.__one('.db-params')
  window.__paramOpen = () => !!window.__paramRoot()
  // antd 的 className 可能落在 input 本身，也可能落在包裹层：两种都认
  window.__paramInput = row => row.querySelector('.db-params-input input') ||
    row.querySelector('.db-params-input')
  window.__paramRows = () => {
    const r = window.__paramRoot()
    if (!r) return []
    return [...r.querySelectorAll('.db-params-row')].filter(window.__vis).map(row => {
      const input = window.__paramInput(row)
      const box = row.querySelector('.db-params-null input')
      return {
        name: (row.querySelector('.db-params-name').innerText || '').trim(),
        value: input ? input.value : null,
        disabled: input ? !!input.disabled : null,
        nullChecked: box ? !!box.checked : null
      }
    })
  }
  window.__paramXY = (i, which) => {
    const row = [...window.__paramRoot().querySelectorAll('.db-params-row')].filter(window.__vis)[i]
    if (!row) return JSON.stringify({ error: 'no-row:' + i })
    const el = which === 'null'
      ? row.querySelector('.db-params-null input')
      : window.__paramInput(row)
    if (!el) return JSON.stringify({ error: 'no-el:' + which })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  }
  window.__paramFooter = re => {
    const r = window.__paramRoot()
    if (!r) return 'no-root'
    const box = r.closest('.ant-modal-container') || document
    const norm = x => String(x.innerText).split(' ').join('')
    const b = [...box.querySelectorAll('.ant-modal-footer button')].find(x => re.test(norm(x)))
    if (!b) return 'missing'
    if (b.disabled) return 'disabled'
    b.click()
    return 'ok'
  }
  window.__paramRun = () => window.__paramFooter(/执行|run/i)
  window.__paramCancel = () => window.__paramFooter(/取消|cancel/i)
  window.__paramHint = () => {
    const r = window.__paramRoot()
    const h = r && r.querySelector('.db-params-hint')
    return h ? h.innerText.trim() : null
  }
  window.__paramColor = sel => {
    const r = window.__paramRoot()
    const el = r && r.querySelector(sel)
    return el ? getComputedStyle(el).color : null
  }
  // 本应用的提示条不是 antd 原生 message（Electron 侧包了一层），两种都收
  window.__msg = () => [...document.querySelectorAll('.message-item, .ant-message-notice-content')]
    .filter(window.__vis).map(x => x.innerText.trim())
  window.__sqlEditorXY = () => {
    const ed = [...document.querySelectorAll('.db-sql-area .cm-content')].find(window.__vis)
    if (!ed) return JSON.stringify({ error: 'no-editor' })
    const r = ed.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 20) })
  }
  window.__gridEcho = () => {
    const idx = window.__colIdx('echo')
    const rows = window.__rows()
    if (idx < 0 || !rows.length) return null
    return rows[0].children[idx].innerText.trim()
  }
  return 'probes-installed'
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
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

// 全选再插入：不清掉旧语句的话，下一次执行会变成多语句（判据全乱）。
// 切页签后 CodeMirror 会重挂，focus() 有时落空——失败就按真实坐标点一次编辑器
const setSql = async (cdp, sql) => {
  let focused = await cdp.eval('window.__focusSql()')
  for (let i = 0; i < 6 && focused !== 'focused'; i++) {
    await sleep(300)
    const xy = await cdp.jeval('window.__sqlEditorXY()')
    if (!xy.error) {
      await cdp.click(xy.x, xy.y)
      await sleep(200)
    }
    focused = await cdp.eval('window.__focusSql()')
  }
  if (focused !== 'focused') {
    return { ok: false, why: focused }
  }
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  })
  await cdp.call('Input.insertText', { text: sql })
  await sleep(150)
  // 自动补全的下拉会挂在编辑器右侧，截图里像"另一个控件"：Esc 收掉
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  })
  await sleep(150)
  const doc = String(await cdp.eval('window.__sqlDoc()'))
  return { ok: doc.indexOf(sql.slice(0, 30)) === 0, doc }
}

// 点进参数输入框再敲：清空后插入，保证"改了"而不是"接着上一次的尾巴"
const fillParam = async (cdp, i, value) => {
  const xy = await cdp.jeval(`window.__paramXY(${i}, 'input')`)
  if (xy.error) return xy.error
  await cdp.click(xy.x, xy.y)
  await sleep(150)
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    commands: ['selectAll']
  })
  await cdp.call('Input.insertText', { text: value })
  await sleep(200)
  const rows = await cdp.jeval('JSON.stringify(window.__paramRows())')
  return rows[i] && rows[i].value === value ? 'ok' : 'not-applied'
}

const execCount = async cdp => Number(await cdp.eval('window.__exec.length'))
const lastExec = async cdp => cdp.jeval('JSON.stringify(window.__exec[window.__exec.length - 1])')

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
  await waitFor(cdp, '!!window.store && !!window.pre', 'renderer boots', 120000)
  await sleep(1200)

  let shotIdx = 0
  const shot = async name => {
    shotIdx++
    const file = path.join(SHOT_DIR, shotIdx + '-' + name + '.png')
    await sleep(350)
    await cdp.shot(file)
    console.log('shot -> ' + path.basename(file))
  }

  // 渲染层启动后还会自己再导航一次（持久化页签恢复），窗口对象会整体换掉：
  // 桩装早了等于装在旧窗口上。所以重试到真的落在这一个窗口为止
  let stubbed = false
  for (let i = 0; i < 20 && !stubbed; i++) {
    try {
      await cdp.eval(STUB)
      stubbed = true
    } catch (e) {
      await sleep(500)
      await waitFor(cdp, '!!window.store && !!window.pre', 'renderer re-boots', 60000)
    }
  }
  check('桩已接管 window.pre.runGlobalAsync', stubbed)
  if (!stubbed) throw new Error('stub not installed')
  check('渲染层就绪（store/pre 都挂上）',
    await waitFor(cdp, '!!window.store && !!window.pre', 'store ready', 60000))
  await cdp.eval(buildHelpers('db-split-ratio'))
  await clearDbTabs(cdp)

  // ── 0. 打开假库页签，切到 SQL 页 ───────────────────────────────
  const tab = JSON.parse(await cdp.eval(OPEN_TAB))
  await waitFor(cdp, 'window.store.activeTabId === ' + JSON.stringify(tab.id), 'mysql tab active')
  await waitFor(cdp, "!!document.querySelector('.db-sql-area .cm-content')", 'sql editor', 30000)
  await cdp.eval('window.__clickTab("^SQL$")')
  await sleep(500)

  const btn = await cdp.eval('(window.__paramBtn() || {}).innerText || null')
  // antd 6 会在两个汉字中间插空格（"参 数"），判定前先抹掉空白
  const btnNorm = String(btn || '').split(' ').join('')
  check('SQL 工具条有参数开关，文案走词条（不是 key）',
    !!btn && /参数|params/i.test(btnNorm) && !/DbSqlParams/.test(btnNorm), btn)
  check('参数开关默认开启（主色按钮）', (await cdp.eval('window.__paramModeOn()')) === true)

  // ── 1. 有 :name 先收值：按出现顺序一行一个 ─────────────────────
  const SQL1 = 'select * from users where name = :name and age > :age'
  const set1 = await setSql(cdp, SQL1)
  check('SQL 编辑器里是带 :name 的语句', set1.ok, set1)
  if (!set1.ok) throw new Error('cannot type SQL: ' + JSON.stringify(set1))

  const n0 = await execCount(cdp)
  await cdp.eval('window.__clickRunSql()')
  const open1 = await waitFor(cdp, 'window.__paramOpen()', 'params modal open', 8000)
  const rows1 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check('点执行先弹参数面板，不立刻发请求', open1 && (await execCount(cdp)) === n0,
    { open: open1, execN: await execCount(cdp) })
  check('参数按出现顺序排列、初值为空',
    rows1.length === 2 && rows1[0].name === ':name' && rows1[1].name === ':age' &&
    rows1.every(r => r.value === '' && r.disabled === false && r.nullChecked === false), rows1)
  check('面板带"值以参数绑定发送"的说明', /参数|parameter/i.test(String(await cdp.eval('window.__paramHint()'))),
    await cdp.eval('window.__paramHint()'))

  // 值里故意带引号、分号与写命令：若被拼进 SQL，服务端收到的文本会露馅
  const NAME_VAL = "o'brien; DROP TABLE users --"
  check('填入 name', (await fillParam(cdp, 0, NAME_VAL)) === 'ok')
  check('填入 age', (await fillParam(cdp, 1, '30')) === 'ok')
  await shot('params-modal-dark')

  await cdp.eval('window.__paramRun()')
  await waitFor(cdp, '!window.__paramOpen()', 'modal closed after run', 6000)
  const e1 = await lastExec(cdp)
  check('服务端收到的是占位符 SQL（mysql 用 ?）',
    e1 && e1.sql === 'select * from users where name = ? and age > ?', e1 && e1.sql)
  check('值原文没有拼进 SQL（引号/分号/写命令都不在语句里）',
    e1 && e1.sql.indexOf("o'brien") < 0 && !/DROP TABLE/i.test(e1.sql), e1 && e1.sql)
  check('值走独立 params 数组、按顺序原样传递',
    e1 && Array.isArray(e1.params) && e1.params.length === 2 &&
    e1.params[0] === NAME_VAL && e1.params[1] === '30', e1 && e1.params)
  check('执行请求带当前库', e1 && e1.database === 'demo', e1 && e1.database)
  check('结果正常渲染，回显的也是参数数组',
    await waitFor(cdp, "String(window.__gridEcho()).indexOf(\"o'brien\") > -1", 'echo row', 8000),
    await cdp.eval('window.__gridEcho()'))

  // ── 2. 历史存原文，参数值不进历史 ──────────────────────────────
  const hist = await cdp.jeval('JSON.stringify(window.__hist)')
  const lastHist = hist[hist.length - 1] || {}
  check('历史条目是用户原文（含 :name）',
    lastHist.sql === SQL1, lastHist.sql)
  check('历史里没有任何参数值',
    JSON.stringify(hist).indexOf("o'brien") < 0 && JSON.stringify(hist).indexOf('"30"') < 0,
    Object.keys(lastHist))

  // ── 3. 再执行：带出上次的值；取消 = 零执行 ─────────────────────
  const n1 = await execCount(cdp)
  await cdp.eval('window.__clickRunSql()')
  await waitFor(cdp, 'window.__paramOpen()', 'modal reopen', 6000)
  const rows2 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check('再执行带出上次填的值（memo 只在当前 tab）',
    rows2.length === 2 && rows2[0].value === NAME_VAL && rows2[1].value === '30', rows2)
  await cdp.eval('window.__paramCancel()')
  const closed2 = await waitFor(cdp, '!window.__paramOpen()', 'modal closed', 5000)
  check('取消不发请求（零执行）', closed2 && (await execCount(cdp)) === n1,
    { execN: await execCount(cdp), was: n1 })

  // ── 4. 字符串里的 :x 不算参数；同名只问一次 ────────────────────
  const SQL2 = "select ':x' as a, :id as b, :id as c"
  await setSql(cdp, SQL2)
  await cdp.eval('window.__clickRunSql()')
  const open2 = await waitFor(cdp, 'window.__paramOpen()', 'modal for masked param', 6000)
  const rows3 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check('字符串里的 :x 不抽参，同名 :id 只出现一行',
    open2 && rows3.length === 1 && rows3[0].name === ':id', rows3)
  await cdp.eval('window.__paramCancel()')
  await waitFor(cdp, '!window.__paramOpen()', 'modal closed', 5000)

  // ── 5. 多语句：开面板之前就挡掉 ────────────────────────────────
  const n2 = await execCount(cdp)
  await setSql(cdp, 'select * from users where id = :id; select * from orders where id = :oid')
  await cdp.eval('window.__clickRunSql()')
  const msgOk = await waitFor(cdp, 'window.__msg().some(t => /单条语句|single statement/i.test(t))',
    'single-statement message', 6000)
  check('多语句被拒：给出原因，且不开面板、不发请求',
    msgOk && !(await cdp.eval('window.__paramOpen()')) && (await execCount(cdp)) === n2,
    { msg: await cdp.jeval('JSON.stringify(window.__msg())'), execN: await execCount(cdp) })
  await shot('params-multi-error')
  // 提示条 3 秒后自己消失；等它走干净再开下一个弹层，截图里不留上一段的残影
  await waitFor(cdp, 'window.__msg().length === 0', 'message cleared', 6000)

  // ── 6. NULL：勾上即禁用输入，提交真正 null ─────────────────────
  await setSql(cdp, 'select * from users where id = :id')
  await cdp.eval('window.__clickRunSql()')
  await waitFor(cdp, 'window.__paramOpen()', 'modal for null', 6000)
  const nullXY = await cdp.jeval("window.__paramXY(0, 'null')")
  await cdp.click(nullXY.x, nullXY.y)
  await sleep(250)
  const rows4 = await cdp.jeval('JSON.stringify(window.__paramRows())')
  check('勾 NULL 后输入框禁用', rows4.length === 1 && rows4[0].nullChecked === true && rows4[0].disabled === true, rows4)
  await shot('params-null')
  await cdp.eval('window.__paramRun()')
  await waitFor(cdp, '!window.__paramOpen()', 'modal closed after null run', 6000)
  const e2 = await lastExec(cdp)
  check('NULL 以真正的 null 绑定（不是空串）',
    e2 && Array.isArray(e2.params) && e2.params.length === 1 && e2.params[0] === null, e2 && e2.params)

  // ── 7. 关掉参数开关：回到纯文本执行 ────────────────────────────
  await cdp.eval('window.__clickParamToggle()')
  await sleep(250)
  check('开关可关闭（不再主色）', (await cdp.eval('window.__paramModeOn()')) === false)
  await setSql(cdp, 'select * from users where id = :id')
  const n3 = await execCount(cdp)
  await cdp.eval('window.__clickRunSql()')
  const rawDone = await waitFor(cdp, `window.__exec.length === ${n3 + 1}`, 'raw exec', 8000)
  const e3 = await lastExec(cdp)
  check('开关关闭时不弹面板，:name 原样发给服务端、不带 params',
    rawDone && !(await cdp.eval('window.__paramOpen()')) &&
    e3.sql === 'select * from users where id = :id' && e3.params === null, e3)
  await cdp.eval('window.__clickParamToggle()')
  await sleep(250)
  check('开关能开回来', (await cdp.eval('window.__paramModeOn()')) === true)

  // ── 8. 全程只读：只发 executeSql，且都是 select ────────────────
  const ops = await cdp.jeval('JSON.stringify(window.__ops)')
  const execs = await cdp.jeval('JSON.stringify(window.__exec)')
  const writes = execs.filter(x => !/^\s*select/i.test(String(x.sql)))
  check('全程只执行了 select，且没有其他写命令 op',
    writes.length === 0 && ops.every(op => /^(executeSql|getMetadata|describeTable|getPageData|listColumns|getReferences|getTableStructure|getDbTxState)$/.test(op)),
    { writes: writes.map(w => w.sql), ops: Array.from(new Set(ops)) })

  // ── 9. 浅色主题：面板颜色跟 token 走 ──────────────────────────
  await setSql(cdp, 'select * from users where id = :id and name = :name')
  await cdp.eval('window.__clickRunSql()')
  await waitFor(cdp, 'window.__paramOpen()', 'modal for theme', 6000)
  const darkName = await cdp.eval("window.__paramColor('.db-params-name')")
  const darkHint = await cdp.eval("window.__paramColor('.db-params-hint')")
  const cfg0 = await cdp.eval('String((window.store._config || {}).theme)')
  const themeIds = await cdp.jeval("JSON.stringify((window.store.getItems('terminalThemes') || []).map(t => t.id))")
  const lightId = themeIds.find(id => /light/i.test(String(id))) || themeIds.find(id => id !== cfg0)
  if (lightId) {
    await cdp.eval('window.store.setTheme(' + JSON.stringify(lightId) + ')')
    await sleep(1200)
    const lightName = await cdp.eval("window.__paramColor('.db-params-name')")
    const lightHint = await cdp.eval("window.__paramColor('.db-params-hint')")
    check('换浅色主题后参数名/提示色跟着变（不是写死的深色）',
      !!darkName && !!lightName && lightName !== darkName && lightHint !== darkHint,
      { darkName, lightName, darkHint, lightHint })
    check('参数名与提示是两级文字色（提示用弱化色）', darkName !== darkHint, { darkName, darkHint })
    await shot('params-light')
    await cdp.eval('window.store.setTheme(' + JSON.stringify(cfg0) + ')')
    await sleep(800)
  } else {
    check('存在可切换的浅色系主题', false, themeIds)
  }
  await cdp.eval('window.__paramCancel()')
  await waitFor(cdp, '!window.__paramOpen()', 'modal closed', 5000)

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
