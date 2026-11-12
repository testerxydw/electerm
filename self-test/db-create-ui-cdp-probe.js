/**
 * N7 新建表 UI 级探针 —— 真渲染、真点击（退出码即结论）
 *
 * 背景：op 级探针（db-create-e2e-cdp-probe）测不到渲染层，实机上
 * 「打开一张表 → 点新建表」直接 TypeError: reading 'length'
 * （emptyDraft 缺 foreignKeys）。本探针走真 DOM：
 *
 * 1. 挂错误捕获（包住 store.onError），任何渲染异常都记进 __uiErrors
 * 2. 没打开过表时点「新建表」：必须出 warning message（不许静默/不许崩）
 * 3. 树里展开库 → 点表 leaf 打开一张表
 * 4. 再点「新建表」：弹层必须打开且无渲染错误（回归锁 emptyDraft 形状）
 * 5. 填表名：预览必须渲染出 CREATE TABLE（create 模式渲染链完整）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.join(__dirname, '..')
const CDP_PORT = 19351
const DISPLAY = ':98'
const MYSQL = { host: '192.168.115.67', port: 13306, user: 'root', password: 'password' }

let passCount = 0
let failCount = 0
const check = (name, ok, detail) => {
  if (ok) {
    passCount++
    console.log('  ✓ ' + name)
  } else {
    failCount++
    console.log('  ✗ ' + name + ' | ' + JSON.stringify(detail))
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const httpJson = url => new Promise((resolve, reject) => {
  http.get(url, r => {
    let b = ''
    r.on('data', d => { b += d })
    r.on('end', () => resolve(JSON.parse(b)))
  }).on('error', reject)
})

async function main () {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-create-ui-'))
  const userData = path.join(run, 'ud')
  fs.mkdirSync(userData, { recursive: true })

  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1440x960x24'], { stdio: 'ignore' })
  await wait(1200)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.ELECTERM_USER_DATA = userData
  env.NODE_OPTIONS = ''
  const app = spawn(
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    [path.join(ROOT, 'work/app/app.js'),
      '--remote-debugging-port=' + CDP_PORT],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let appErr = ''
  app.stderr.on('data', d => { appErr += String(d) })
  const WebSocket = require(path.join(ROOT, 'node_modules/ws'))

  async function cdpEval (targetUrl, expr, timeoutMs = 30000) {
    const ws = new WebSocket(targetUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const p = new Promise((resolve, reject) => {
      ws.on('message', m => {
        const msg = JSON.parse(m)
        if (msg.id === 1) resolve(msg)
      })
      setTimeout(() => reject(new Error('cdp eval timeout: ' + expr.slice(0, 60))), timeoutMs)
    })
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true }
    }))
    const out = await p
    ws.close()
    if (out.result && out.result.exceptionDetails) {
      const d = out.result.exceptionDetails
      throw new Error('page exception: ' + ((d.exception && d.exception.description) || d.text))
    }
    return out.result && out.result.result && out.result.result.value
  }

  async function getPageTarget () {
    for (let i = 0; i < 40; i++) {
      try {
        const ts = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`)
        const page = ts.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page
      } catch (e) {}
      await wait(1000)
    }
    throw new Error('no page target. stderr: ' + appErr.slice(-600))
  }

  // 在页面里轮询等一个 JS 断言成立
  async function waitExpr (pageUrl, expr, label, tries = 30, gap = 1000) {
    for (let i = 0; i < tries; i++) {
      try {
        const v = await cdpEval(pageUrl, '(function(){return !!(' + expr + ')})()')
        if (v === true) return true
      } catch (e) {}
      await wait(gap)
    }
    return false
  }

  const clickByText = (selector, texts) => `
    (function () {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const t = ${JSON.stringify(texts)}
      const el = els.find(x => t.some(s => (x.textContent || '').trim() === s))
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`

  try {
    const page = await getPageTarget()
    const PU = page.webSocketDebuggerUrl
    let ready = false
    for (let i = 0; i < 40 && !ready; i++) {
      await wait(1000)
      try {
        ready = await cdpEval(PU, 'typeof window.pre') === 'object'
      } catch (e) {}
    }
    if (!ready) throw new Error('window.pre never ready. stderr: ' + appErr.slice(-600))

    // 错误捕获：包住 store.onError（渲染异常经 ErrorBoundary 走这里）
    await cdpEval(PU, `
      (function () {
        window.__uiErrors = []
        const orig = window.store.onError.bind(window.store)
        window.store.onError = function (e) {
          window.__uiErrors.push(String((e && e.message) || e))
          return orig(e)
        }
        return true
      })()`)

    const op = (name, ...args) =>
      `window.pre.runGlobalAsync(${JSON.stringify(name)}, ${args.map(a => JSON.stringify(a)).join(', ')})` +
      '.then(r => JSON.stringify(r)).catch(e => \'ERR:\' + e.message)'
    const parse = v => {
      if (typeof v !== 'string' || v.startsWith('ERR:')) {
        throw new Error('op failed: ' + v)
      }
      return JSON.parse(v)
    }

    const bm = {
      id: 'cdp-ui-create-tab-' + Date.now(),
      type: 'database',
      dbType: 'mysql',
      dbHost: MYSQL.host,
      dbPort: MYSQL.port,
      dbUser: MYSQL.user,
      dbPassword: MYSQL.password,
      dbName: 'mysql',
      readOnly: false,
      status: 'processing',
      from: 'quick-connect',
      title: 'cdp-ui-create'
    }
    // UI 级：走 store.addTab（与快速连接同构）——DbSession 挂载后自己 openDbTab
    // 建连。直接调 openDbTab op 只建服务端会话，UI 不挂载（第一版踩过的坑）
    await cdpEval(PU, 'window.store.addTab(' + JSON.stringify(bm) + '); true')

    // 等会话 UI 出来
    check('db session UI 挂载',
      await waitExpr(PU, 'document.querySelector(\'.db-tabs\')', 'tabs'))

    // ---- 1. 没打开过表：点新建表必须出提示，不许静默也不许崩 ----
    // 先切到「表结构」页签（forceRender 已挂载，未激活的 pane 点不到里面）
    check('切到表结构页签',
      await cdpEval(PU, clickByText('.ant-tabs-tab', ['表结构', 'Table structure'])),
      'tab label 未找到')
    check('未开表时点「新建表」有响应',
      await cdpEval(PU, clickByText('.db-struct-area button', ['新建表', 'new table'])),
      '按钮未找到')
    check('warning 提示出现',
      await waitExpr(PU,
        'document.querySelector(\'.message-item.warning .message-content\')', 'warnmsg'),
      '没有 warning message')
    const errs1 = await cdpEval(PU, 'window.__uiErrors')
    check('未开表阶段无渲染错误', errs1.length === 0, errs1)

    // ---- 2. 展开树 → 点表 leaf 打开一张表 ----
    // 树标题是后到的，先等树渲染；匹配用 includes + trim（节点文本可能带空白）
    check('树渲染出现',
      await waitExpr(PU, 'document.querySelector(\'.ant-tree-title\')', 'tree'),
      '树未渲染')
    // 先拿一个真实存在的库/表（跟 UI 同通道查）
    const dbs = parse(await cdpEval(PU, op('dbClientOp', bm.id, 'executeSql',
      { sql: 'show databases', database: 'mysql' })))
    const dbNames = dbs.results[0].rows.map(r => Object.values(r)[0])
      .filter(n => !/^(information_schema|performance_schema|sys)$/i.test(n))
    // 只认树里真画出来的库（元数据可能裁剪系统库，show databases 全量）
    const clickNodeByIncludes = dbNameOrTable => `
      (function () {
        const els = [...document.querySelectorAll('.ant-tree-title')]
        const el = els.find(x => (x.textContent || '').trim().includes(${JSON.stringify(dbNameOrTable)}))
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      })()`
    const dbClicked = await cdpEval(PU, `
      (function () {
        const dbs = ${JSON.stringify(dbNames)}
        const els = [...document.querySelectorAll('.ant-tree-title')]
        const hit = els.find(x => dbs.some(d => (x.textContent || '').trim() === d.trim()))
        if (!hit) return ''
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return (hit.textContent || '').trim()
      })()`)
    check('展开库节点', !!dbClicked, { dbNames })
    await wait(1200)
    const tbls = parse(await cdpEval(PU, op('dbClientOp', bm.id, 'executeSql',
      { sql: 'show tables from `' + dbClicked + '`', database: dbClicked })))
    const tblName = tbls.results[0].rows.length
      ? String(Object.values(tbls.results[0].rows[0])[0])
      : ''
    check('库里找到表', !!tblName, tbls.results[0].rows)
    // 展开后 leaf 才进 DOM（可能虚拟滚动），轮询等它出现再点
    check('点开表 leaf',
      await (async () => {
        for (let i = 0; i < 10; i++) {
          if (await cdpEval(PU, clickNodeByIncludes(tblName))) {
            return true
          }
          await wait(1000)
        }
        return false
      })(),
      tblName + ' leaf 未找到')
    // 打开一张表后 sel 落位：结构区第二行工具（DDL 等）只在 structure.rows
    // 有行时渲染 —— .ant-table 在工作台首页就存在，不能当判据（假阳性教训）
    check('表已打开（sel 落位）',
      await waitExpr(PU,
        'document.querySelectorAll(\'.db-struct-area .db-struct-tools\').length >= 2', 'structrows'),
      '结构行未出现')

    // ---- 3. 再点新建表：弹层必须打开且无渲染错误（原 TypeError 回归锁） ----
    // 打开表后主区切回 data 页签，先切回结构区再点（与用户操作同序）；
    // 页签切换与 React 重渲染有竞态，重试直到弹层标题出现
    let modalOpen = false
    for (let i = 0; i < 8 && !modalOpen; i++) {
      await cdpEval(PU, clickByText('.ant-tabs-tab', ['表结构', 'Table structure']))
      await wait(800)
      await cdpEval(PU, clickByText('.db-struct-area button', ['新建表', 'new table']))
      await wait(1500)
      modalOpen = await cdpEval(PU,
        '[...document.querySelectorAll(\'.ant-modal-title\')].some(x => /新建表|new table/.test(x.textContent))')
    }
    check('设计弹层打开', modalOpen, '重试 8 轮弹层仍未出现')
    const errs2 = await cdpEval(PU, 'window.__uiErrors')
    check('create 模式渲染无 TypeError（emptyDraft.foreignKeys 回归锁）',
      errs2.length === 0, errs2)

    // ---- 4. 填表名 + 填预置列名 → 预览渲染 CREATE TABLE（渲染链完整） ----
    // 只填表名时预置空列会被 createTableDdl 判 bad-column-name（reason 展示，
    // 这是正确行为），所以两格都填
    const fillInput = (placeholder, value) => `
      (function () {
        const input = [...document.querySelectorAll('.ant-modal input[placeholder]')]
          .find(x => x.placeholder === ${JSON.stringify(placeholder)})
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(value)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    check('表名输入框在',
      await cdpEval(PU, fillInput('new_table', 'ui_probe_t')),
      'placeholder=new_table 的输入框未找到')
    check('列名输入框在',
      await cdpEval(PU, fillInput('列名', 'id') || fillInput('Column', 'id')),
      '列名输入框未找到')
    // newColumn() 的 type 是空串 —— 不填类型会被 createTableDdl 判
    // missing-column-type（reason 展示，正确行为），预览里就见不到 CREATE TABLE
    await cdpEval(PU, fillInput('类型', 'int(11)') || fillInput('type', 'int(11)'))
    check('预览渲染出 CREATE TABLE',
      await waitExpr(PU,
        '[...document.querySelectorAll(\'.db-design-sql\')].some(x => x.textContent.includes(\'CREATE TABLE\'))',
        'preview'),
      '预览未出现')
    const errs3 = await cdpEval(PU, 'window.__uiErrors')
    check('全程零渲染错误', errs3.length === 0, errs3)

    // ---- 清理 ----
    await cdpEval(PU, op('closeDbTab', bm.id))
    console.log('\n== 清理完成 ==')
  } catch (e) {
    failCount++
    console.error('[fail]', e.message)
    console.error('[stderr-tail]', appErr.slice(-500))
  } finally {
    app.kill('SIGKILL')
    xvfb.kill()
  }

  console.log(`\n[verdict] ${failCount === 0 ? 'PASS' : 'FAIL'} | pass ${passCount} / fail ${failCount}`)
  fs.rmSync(run, { recursive: true, force: true })
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
