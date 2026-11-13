/**
 * N7 新建表 / 复制表 UI 级探针 —— 真渲染、真点击（退出码即结论）
 *
 * 背景：op 级探针（db-create-e2e-cdp-probe）测不到渲染层，实机上
 * 「打开一张表 → 点新建表」曾直接 TypeError: reading 'length'
 * （组件手写 emptyDraft 缺 foreignKeys）。本探针走真 DOM，按方案 B 验收：
 *
 * A 阶段0：没打开过表也能新建（默认库回落连接默认库，不再 warning 挡人）
 * B 改表链回归：打开一张表 → 表设计器（alter）正常渲染、零异常
 * C 新建表链：目标库下拉双向切换 → 预览全限定前缀跟随 → 填列后出 CREATE
 * D 复制表链：复制本库表 / 外库表 → 草稿列与索引跟随 → 仍可编辑 →
 *   换源弹确认（不静默丢改动）→ 切回空白表重置草稿
 *
 * antd6.5 Select 适配（踩过的坑，别改回去）：
 * - 单选显示值在 .ant-select-content 的 title 属性（不是 antd5 的 selection-item）
 * - aria-expanded 在 .ant-select-input，mousedown/click 要派到 selector 根与 input
 * - [role=option] 有两份：aria 隐藏镜像（无事件）与虚拟列表真实项；真实项文本
 *   带图标零宽空格 U+200B（trim 不掉），必须按 .ant-select-item-option-content
 *   精确匹配 → closest('.ant-select-item') → 派 click
 * - 表清单可能上百项走虚拟列表：直接匹配不到时先往搜索框输 label 再点
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.join(__dirname, '..')
// 端口/DISPLAY 按 pid 取唯一值：残留的 electron 占着固定端口时，新探针会误连到
// 旧实例的 CDP 页面（旧代码），表现为"所有判据莫名全红"。踩过一次，别改回常量
const CDP_PORT = 21000 + (process.pid % 30000)
const DISPLAY = ':' + (120 + (process.pid % 100))
const MYSQL = { host: '192.168.115.67', port: 13306, user: 'root', password: 'password' }
const ALT_DB = 'ui_probe_alt_db'
const LOCAL_SRC = 'ui_probe_local_src'
const EXT_SRC = 'ui_probe_ext_src'
const DB_SELECT = '.db-design-db-select'
const SRC_SELECT = '.db-design-source-select'
const NEW_TABLE_RE = '[...document.querySelectorAll(\'.ant-modal-title\')].some(x => /新建表|new table/.test(x.textContent))'

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
  const probeTmp = path.join(run, 'tmp')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(probeTmp, { recursive: true })

  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1440x960x24'], { stdio: 'ignore' })
  await wait(1200)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.ELECTERM_USER_DATA = userData
  // 单实例锁 socket 落在 app.getPath('temp')；独立 TMPDIR 避免与正在运行的
  // 打包版 electerm 抢锁（抢输的新实例会静默 quit，表现为 no page target）
  env.TMPDIR = probeTmp
  env.NODE_OPTIONS = ''
  const app = spawn(
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    [path.join(ROOT, 'work/app/app.js'),
      '--remote-debugging-port=' + CDP_PORT],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  )
  let appErr = ''
  let appOut = ''
  app.stderr.on('data', d => { appErr += String(d) })
  app.stdout.on('data', d => { appOut += String(d) })
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

  const openSelect = sel => `
    (function () {
      const root = document.querySelector(${JSON.stringify(sel)})
      if (!root) return 'NO-SELECT'
      const input = root.querySelector('.ant-select-input')
      const ev = type => new MouseEvent(type, { bubbles: true, cancelable: true })
      root.dispatchEvent(ev('mousedown'))
      if (input) input.dispatchEvent(ev('mousedown'))
      root.dispatchEvent(ev('click'))
      return input && input.getAttribute('aria-expanded')
    })()`
  const isSelectOpen = sel => `
    (function () {
      const i = document.querySelector(${JSON.stringify(sel + ' .ant-select-input')})
      return !!(i && i.getAttribute('aria-expanded') === 'true')
    })()`
  const pickOption = label => `
    (function () {
      const want = ${JSON.stringify(label)}
      const contents = [...document.querySelectorAll('.ant-select-item-option-content')]
      const c = contents.find(x => (x.textContent || '').trim() === want)
      const el = c && c.closest('.ant-select-item')
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`
  // 空白表选项的 label 随界面语言变化（空白表 / blank table），按正则匹配；
  // 真实 option 文本可能带零宽空格，先剔掉再比。
  const pickOptionMatch = pattern => `
    (function () {
      const re = new RegExp(${JSON.stringify(pattern)}, 'i')
      const contents = [...document.querySelectorAll('.ant-select-item-option-content')]
      const c = contents.find(x => re.test((x.textContent || '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim()))
      const el = c && c.closest('.ant-select-item')
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()`
  const listOptions = `
    (function () {
      const i = document.querySelector('.db-design-source-select .ant-select-input')
      return {
        search: i ? i.value : 'NO-INPUT',
        opts: [...document.querySelectorAll('.ant-select-item-option-content')]
          .map(x => (x.textContent || '').trim()).slice(0, 12)
      }
    })()`
  const fillSelectSearch = (sel, text) => `
    (function () {
      const i = document.querySelector(${JSON.stringify(sel + ' .ant-select-input')})
      if (!i) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(i, ${JSON.stringify(text)})
      i.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  const closeDesignModal = `
    (function () {
      const btn = [...document.querySelectorAll('.ant-modal-footer button')]
        .find(x => /关闭|close/i.test(x.textContent || ''))
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      }
      const x = document.querySelector('.ant-modal-close')
      if (x) {
        x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      }
      return false
    })()`
  const clickConfirmOk = `
    (function () {
      const b = document.querySelector('.custom-modal-ok-btn')
      if (!b) return false
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
    const BM_ID = 'cdp-ui-create-tab-' + Date.now()
    const sql = async (s, database) => parse(await cdpEval(PU,
      op('dbClientOp', BM_ID, 'executeSql', { sql: s, database })))

    const bm = {
      id: BM_ID,
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
    check('db session UI 挂载',
      await waitExpr(PU, 'document.querySelector(\'.db-tabs\')', 'tabs'))

    const ensureOpen = async sel => {
      // 已经开着就别再派发点击：mousedown+click 会把开着的下拉 toggle 关掉
      if (await cdpEval(PU, isSelectOpen(sel))) return true
      for (let i = 0; i < 5; i++) {
        await cdpEval(PU, openSelect(sel))
        if (await cdpEval(PU, isSelectOpen(sel))) return true
        await wait(800)
      }
      return false
    }
    // 表清单可能上百项走虚拟列表：先直接找，找不到再往搜索框输 label 过滤后找
    const pickOptionWithSearch = async (sel, label) => {
      if (!(await ensureOpen(sel))) return false
      await wait(500)
      if (await cdpEval(PU, pickOption(label))) return true
      await cdpEval(PU, fillSelectSearch(sel, label))
      await wait(800)
      const diag = await cdpEval(PU, `
        (function () {
          const opts = [...document.querySelectorAll('.ant-select-item-option-content')]
            .map(x => (x.textContent || '').trim())
          const i = document.querySelector(${JSON.stringify(sel + ' .ant-select-input')})
          return { want: ${JSON.stringify(label)}, input: i ? i.value : 'NO-INPUT', opts: opts.slice(0, 12) }
        })()`)
      console.log('[diag select]', JSON.stringify(diag))
      return await cdpEval(PU, pickOption(label))
    }
    const selectTitle = sel => `
      (function () {
        const c = document.querySelector(${JSON.stringify(sel + ' .ant-select-content')})
        return c ? c.getAttribute('title') : 'NO-CONTENT'
      })()`
    const previewHas = text => `
      [...document.querySelectorAll('.db-design-sql')].some(x => x.textContent.includes(${JSON.stringify(text)}))`
    const reopenCreate = async () => {
      let ok = false
      for (let i = 0; i < 8 && !ok; i++) {
        await cdpEval(PU, clickByText('.db-create-table-extra', ['新建表', 'new table']))
        await wait(1500)
        ok = await cdpEval(PU, '(function(){return ' + NEW_TABLE_RE + '})()')
      }
      return ok
    }

    // ================= A 阶段0：未开表也能新建 =================
    check('入口紧跟会话页签（不是最右端）',
      await cdpEval(PU, `
        (function () {
          const tabs = [...document.querySelectorAll('.db-tabs .ant-tabs-tab')]
          const i = tabs.findIndex(x => /新建表|new table/.test(x.textContent || ''))
          const j = tabs.findIndex(x => /会话|Sessions/i.test(x.textContent || ''))
          return i !== -1 && j !== -1 && i === j + 1
        })()`),
      '新建表伪页签不在会话页签之后')
    check('未开表时点「新建表」有响应（页签栏入口）',
      await cdpEval(PU, clickByText('.db-create-table-extra', ['新建表', 'new table'])),
      '按钮未找到')
    check('阶段0：空库无需先打开表，弹层直接打开（不再 warning 挡人）',
      await waitExpr(PU, NEW_TABLE_RE, 'modal'), '弹层未打开')
    check('默认库回落连接默认库 mysql（sel 为 null 时的降级链）',
      (await cdpEval(PU, selectTitle(DB_SELECT))) === 'mysql',
      await cdpEval(PU, selectTitle(DB_SELECT)))
    check('A 阶段零渲染错误', (await cdpEval(PU, 'window.__uiErrors')).length === 0)
    await cdpEval(PU, closeDesignModal)
    await wait(700)

    // ================= B 打开一张表 + ALTER 回归 =================
    check('树渲染出现',
      await waitExpr(PU, 'document.querySelector(\'.ant-tree-title\')', 'tree'))
    const dbs = parse(await cdpEval(PU, op('dbClientOp', BM_ID, 'executeSql',
      { sql: 'show databases', database: 'mysql' })))
    const dbNames = dbs.results[0].rows.map(r => Object.values(r)[0])
      .filter(n => !/^(information_schema|performance_schema|sys)$/i.test(n))
    const clickNodeByIncludes = name => `
      (function () {
        const els = [...document.querySelectorAll('.ant-tree-title')]
        const el = els.find(x => (x.textContent || '').trim().includes(${JSON.stringify(name)}))
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
    // 只点基础表：视图进设计器没有结构行（探针上一版踩过 sel 落位假失败）
    const tbls = parse(await cdpEval(PU, op('dbClientOp', BM_ID, 'executeSql',
      {
        sql: 'select table_name t from information_schema.tables ' +
          "where table_schema = '" + dbClicked.replace(/'/g, "''") + "' " +
          "and table_type = 'BASE TABLE' order by table_name limit 1",
        database: dbClicked
      })))
    const tblName = tbls.results[0].rows.length
      ? String(Object.values(tbls.results[0].rows[0])[0])
      : ''
    check('库里找到表', !!tblName, tbls.results[0].rows)
    check('点开表 leaf',
      await (async () => {
        for (let i = 0; i < 10; i++) {
          if (await cdpEval(PU, clickNodeByIncludes(tblName))) return true
          await wait(1000)
        }
        return false
      })(),
      tblName + ' leaf 未找到')
    // .ant-table 在工作台首页就存在，不能当判据（假阳性教训）
    check('表已打开（sel 落位）',
      await waitExpr(PU, 'document.querySelector(\'.db-grid-table-wrap\')', 'gridwrap'))

    check('切到表结构页签',
      await cdpEval(PU, clickByText('.ant-tabs-tab', ['表结构', 'Table structure'])),
      'tab label 未找到')
    check('打开表设计器（alter 模式）',
      await cdpEval(PU, clickByText('.db-struct-area button', ['表设计', 'Table designer'])),
      '设计按钮未找到')
    check('alter 弹层标题是「表设计」',
      await waitExpr(PU,
        '[...document.querySelectorAll(\'.ant-modal-title\')].some(x => /表设计|Table designer/.test(x.textContent))',
        'altermodal'))
    check('B 阶段零渲染错误（ALTER 链回归）',
      (await cdpEval(PU, 'window.__uiErrors')).length === 0)
    await cdpEval(PU, closeDesignModal)
    await wait(700)

    // ================= C 新建表链（含目标库双向切换） =================
    // 源表必须在弹层打开前建好：openCreateTable 打开时一次拉齐 sourceTables
    await sql('CREATE DATABASE IF NOT EXISTS `' + ALT_DB + '`', dbClicked)
    await sql(
      'CREATE TABLE IF NOT EXISTS `' + dbClicked + '`.`' + LOCAL_SRC + '` ' +
        '(`local_id` bigint(20) NOT NULL, PRIMARY KEY (`local_id`)) COMMENT=\'本库源\'',
      dbClicked
    )
    await sql(
      'CREATE TABLE IF NOT EXISTS `' + ALT_DB + '`.`' + EXT_SRC + '` ' +
        '(`ext_name` varchar(64) NOT NULL, UNIQUE KEY `uk_ext` (`ext_name`)) COMMENT=\'外库源\'',
      ALT_DB
    )
    check('设计弹层打开（新建表）', await reopenCreate(), '重试 8 轮弹层仍未出现')
    check('点入口不切走当前页签',
      await cdpEval(PU, `
        (function () {
          const a = document.querySelector('.db-tabs .ant-tabs-tab-active')
          return a && /表结构|Table structure/i.test(a.textContent || '')
        })()`),
      'activeKey 被伪页签带走了')
    check('create 模式渲染无 TypeError（emptyDraft 形状回归锁）',
      (await cdpEval(PU, 'window.__uiErrors')).length === 0)
    check('目标库默认=打开表的库',
      (await cdpEval(PU, selectTitle(DB_SELECT))) === dbClicked,
      { want: dbClicked, got: await cdpEval(PU, selectTitle(DB_SELECT)) })
    check('打开目标库下拉', await ensureOpen(DB_SELECT), '下拉打不开')
    await wait(600)
    check('备选库选项在', await cdpEval(PU, pickOption(ALT_DB)), '下拉选项未找到')
    check('切到备选库生效',
      await waitExpr(PU,
        `document.querySelector('.db-design-db-select .ant-select-content') && document.querySelector('.db-design-db-select .ant-select-content').getAttribute('title') === ${JSON.stringify(ALT_DB)}`,
        'alt-selected'))

    // 预置空列不填名字/类型会被 designIssues / 生成器拦（reason 展示，正确行为）
    check('表名输入框在',
      await cdpEval(PU, fillInput('new_table', 'ui_probe_t')) ||
        await cdpEval(PU, fillInput('table name', 'ui_probe_t')),
      'placeholder=new_table 的输入框未找到')
    check('列名输入框在',
      await cdpEval(PU, fillInput('列名', 'id')) ||
        await cdpEval(PU, fillInput('Column', 'id')),
      '列名输入框未找到')
    await cdpEval(PU, fillInput('类型', 'int(11)')) ||
      await cdpEval(PU, fillInput('Type', 'int(11)'))
    check('预览渲染出 CREATE TABLE',
      await waitExpr(PU, previewHas('CREATE TABLE'), 'preview'))
    check('切换库后预览前缀跟着变',
      await waitExpr(PU, previewHas('`' + ALT_DB + '`.`ui_probe_t`'), 'alt-prefix'))
    check('再开下拉', await ensureOpen(DB_SELECT), '下拉打不开')
    await wait(600)
    check('切回原库',
      await cdpEval(PU, pickOption(dbClicked)) &&
        await waitExpr(PU,
          `document.querySelector('.db-design-db-select .ant-select-content') && document.querySelector('.db-design-db-select .ant-select-content').getAttribute('title') === ${JSON.stringify(dbClicked)}`,
          'back-selected'))
    check('切回后前缀还原',
      await waitExpr(PU, previewHas('`' + dbClicked + '`.`ui_probe_t`'), 'back-prefix'))

    // ================= D 复制表链 =================
    // 重开弹层：草稿回到空基准（draftDirty=false），复制选源不该弹确认
    await cdpEval(PU, closeDesignModal)
    await wait(700)
    check('重开弹层（复制阶段）', await reopenCreate(), '重开失败')
    check('复制源下拉在',
      await waitExpr(PU, 'document.querySelector(\'.db-design-source-select\')', 'sourceselect'))
    check('复制本库表：草稿列/索引/注释跟随',
      await pickOptionWithSearch(SRC_SELECT, dbClicked + '.' + LOCAL_SRC) &&
        await waitExpr(PU, previewHas('`local_id` bigint(20) NOT NULL'), 'copy-local', 12, 800),
      await cdpEval(PU, previewHas('CREATE TABLE')))
    check('复制本库表：主键与表注释跟随',
      await waitExpr(PU, previewHas('PRIMARY KEY (`local_id`)'), 'copy-local-pk') &&
        await waitExpr(PU, previewHas("COMMENT='本库源'"), 'copy-local-comment'))
    check('目标表名自动填 源表_copy',
      await cdpEval(PU, `
        (function () {
          const i = [...document.querySelectorAll('.ant-modal input[placeholder]')]
            .find(x => x.placeholder === 'new_table' || x.placeholder === 'table name')
          return i && i.value === ${JSON.stringify(LOCAL_SRC + '_copy')}
        })()`))
    check('复制后列名输入框未禁用（可继续修改）',
      await cdpEval(PU, `
        (function () {
          const i = [...document.querySelectorAll('.ant-modal input[placeholder]')]
            .find(x => x.placeholder === '列名' || x.placeholder === 'Column')
          return !!i && !i.disabled
        })()`))
    // 改类型而不是改列名：源表有主键引用列名，改名会正确触发 index-column-missing
    await cdpEval(PU, fillInput('类型', 'varchar(32)')) ||
      await cdpEval(PU, fillInput('Type', 'varchar(32)'))
    check('复制后修改列定义，预览跟着变',
      await waitExpr(PU, previewHas('`local_id` varchar(32)'), 'copy-editable'))

    // 换源会重建草稿：改过就先弹确认，不能静默丢改动
    check('换源弹出丢弃改动确认',
      await pickOptionWithSearch(SRC_SELECT, ALT_DB + '.' + EXT_SRC) &&
        await waitExpr(PU, 'document.querySelector(\'.custom-modal-ok-btn\')', 'confirm', 8, 500),
      '确认弹层未出现')
    check('确认后换成外库源表结构（跨库复制）',
      await cdpEval(PU, clickConfirmOk) &&
        await waitExpr(PU, previewHas('`ext_name` varchar(64) NOT NULL'), 'copy-ext', 12, 800))
    check('外库源表的 UNIQUE KEY 与表注释跟随',
      await waitExpr(PU, previewHas('UNIQUE KEY `uk_ext` (`ext_name`)'), 'copy-ext-uk') &&
        await waitExpr(PU, previewHas("COMMENT='外库源'"), 'copy-ext-comment'))
    // 换源后草稿是全新预填、用户没二次编辑，draftDirty 已重置 → 不再重复确认。
    // antd6 Select 的 option 走虚拟列表，上一轮选过外库表后视窗停在底部，
    // 第一项「空白表」没被渲染，光清搜索词点不到。直接按 label 搜索把它筛出来；
    // 界面语言不确定，中英两种关键词依次试。
    const pickBlankSource = async () => {
      if (!(await ensureOpen(SRC_SELECT))) return false
      for (const q of ['空白', 'blank']) {
        await cdpEval(PU, fillSelectSearch(SRC_SELECT, q))
        await wait(600)
        if (await cdpEval(PU, pickOptionMatch('空白表|blank table'))) return true
        console.log('[diag blank]', JSON.stringify(await cdpEval(PU, listOptions)))
      }
      return false
    }
    check('切回空白表选项可选', await pickBlankSource(), '空白表选项未找到')
    check('空白表：草稿重置为 1 个空列行',
      await waitExpr(PU, `
          (function () {
            const ins = [...document.querySelectorAll('.ant-modal input[placeholder]')]
              .filter(x => x.placeholder === '列名' || x.placeholder === 'Column')
            return ins.length === 1 && ins[0].value === ''
          })()`, 'blank-draft', 12, 600))
    const errs = await cdpEval(PU, 'window.__uiErrors')
    check('全程零渲染错误', errs.length === 0, errs)

    // ---- 清理 ----
    try {
      await sql('DROP DATABASE IF EXISTS `' + ALT_DB + '`', dbClicked)
      await sql('DROP TABLE IF EXISTS `' + LOCAL_SRC + '`', dbClicked)
    } catch (e) {}
    await cdpEval(PU, op('closeDbTab', BM_ID))
    console.log('\n== 清理完成 ==')
  } catch (e) {
    failCount++
    console.error('[fail]', e.message)
    console.error('[stderr-tail]', appErr.slice(-500))
    console.error('[stdout-tail]', appOut.slice(-500))
  } finally {
    try { process.kill(-app.pid, 'SIGKILL') } catch (e) { try { app.kill('SIGKILL') } catch (e2) {} }
    xvfb.kill('SIGKILL')
  }

  console.log(`\n[verdict] ${failCount === 0 ? 'PASS' : 'FAIL'} | pass ${passCount} / fail ${failCount}`)
  fs.rmSync(run, { recursive: true, force: true })
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
