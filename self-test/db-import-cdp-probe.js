/**
 * db-import 选文件 CDP 实机探针（2026-11-12 openFile electron 修复验证）
 *
 * 场景：真 Electron + Xvfb + CDP，真实渲染层 op 面，真 MySQL
 * （mysql.png 配置：192.168.115.67:13306 root/password）。
 *
 * 被验证的链路：渲染层 dbImportOp('openFile') → 主进程 db-client-remote
 * 开 dialog（此处用 inspector 打桩返回固定文件）→ 以 preview+filePath 转发
 * db-client fork 子进程 → 样例预览回传。再走 start → 子进程分批写 MySQL →
 * status → 反查表内行数，端到端闭环。
 *
 * 用法：node self-test/db-import-cdp-probe.js
 * 退出码即结论：0 = 全部判据通过。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const DISPLAY = ':97'
const CDP_PORT = 19330
const INSPECT_PORT = 19331
const MYSQL = {
  host: '192.168.115.67',
  port: 13306,
  user: 'root',
  password: 'password'
}
const DB_NAME = 'electerm_cdp_test'
const TABLE = 'cdp_imp'

let passCount = 0
let failCount = 0
function check (name, ok, detail) {
  if (ok) {
    passCount++
    console.log('  ✓ ' + name + (detail ? ' | ' + JSON.stringify(detail) : ''))
  } else {
    failCount++
    console.log('  ✗ ' + name + (detail ? ' | ' + JSON.stringify(detail) : ''))
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function httpJson (url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let b = ''
      res.on('data', d => { b += d })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main () {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-imp-cdp-'))
  const userData = path.join(run, 'ud')
  const dataPath = path.join(run, 'data')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(dataPath, { recursive: true })
  const csvPath = path.join(run, 'import-sample.csv')
  fs.writeFileSync(csvPath, 'name,age\nalice,31\nbob,32\ncarol,33\n')

  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24'], { stdio: 'ignore' })
  await wait(1200)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.ELECTERM_USER_DATA = userData
  env.DATA_PATH = dataPath
  env.NODE_OPTIONS = ''
  const app = spawn(
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    [path.join(ROOT, 'work/app/app.js'),
      '--remote-debugging-port=' + CDP_PORT,
      '--inspect=' + INSPECT_PORT],
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

  async function getInspectTarget () {
    for (let i = 0; i < 40; i++) {
      try {
        const ts = await httpJson(`http://127.0.0.1:${INSPECT_PORT}/json/list`)
        const node = ts.find(t => t.type === 'node' && t.webSocketDebuggerUrl)
        if (node) return node
      } catch (e) {}
      await wait(500)
    }
    throw new Error('no inspector target (main process)')
  }

  try {
    // ---------- 1. 主进程打桩 dialog（真实主进程，inspector 注入） ----------
    const insp = await getInspectTarget()
    const patched = await cdpEval(insp.webSocketDebuggerUrl, `
      const { dialog } = process.mainModule.require('electron')
      dialog.showOpenDialogSync = (opts) => {
        globalThis.__dlgCalls = (globalThis.__dlgCalls || 0) + 1
        globalThis.__dlgOpts = opts
        return [${JSON.stringify(csvPath)}]
      }
      'patched'
    `, 15000)
    check('主进程 inspector 打桩 dialog 成功', patched === 'patched')

    // ---------- 2. 渲染层就绪 ----------
    const page = await getPageTarget()
    let ready = false
    for (let i = 0; i < 40 && !ready; i++) {
      await wait(1000)
      try {
        const v = await cdpEval(page.webSocketDebuggerUrl, 'typeof window.pre', 5000)
        ready = v === 'object'
      } catch (e) {}
    }
    if (!ready) throw new Error('window.pre never ready. stderr: ' + appErr.slice(-600))
    console.log('\n== 渲染层就绪，开始 op 面验证 ==\n')

    const run = expr => cdpEval(page.webSocketDebuggerUrl, expr, 60000)
    const op = (name, ...args) =>
      `window.pre.runGlobalAsync(${JSON.stringify(name)}, ${args.map(a => JSON.stringify(a)).join(', ')})` +
      '.then(r => JSON.stringify(r)).catch(e => \'ERR:\' + e.message)'
    const parse = v => {
      if (typeof v !== 'string' || v.startsWith('ERR:')) {
        throw new Error('op failed: ' + v)
      }
      return JSON.parse(v)
    }

    // ---------- 3. 测连 + 开 tab ----------
    const bm = {
      id: 'cdp-imp-test-tab',
      dbType: 'mysql',
      dbHost: MYSQL.host,
      dbPort: MYSQL.port,
      dbUser: MYSQL.user,
      dbPassword: MYSQL.password,
      dbName: 'mysql',
      // db-client/index.js:228 默认 readOnly（!== false）—— 测试 tab 须显式关闭，
      // 否则建库建表 DDL 被主进程只读白名单拒绝（且该拒绝静默于未检查的返回值里）
      readOnly: false
    }
    const conn = parse(await run(op('testDbConnection', bm)))
    check('testDbConnection MySQL ' + MYSQL.host + ':' + MYSQL.port, !!conn, conn)
    await run(op('openDbTab', bm))
    check('openDbTab', true, { tabId: bm.id })

    // ---------- 4. 建库建表 ----------
    await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: 'create database if not exists ' + DB_NAME,
      database: 'mysql'
    }))
    await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: `create table if not exists ${DB_NAME}.${TABLE} (name varchar(64), age int)`,
      database: DB_NAME
    }))
    await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: `truncate table ${DB_NAME}.${TABLE}`,
      database: DB_NAME
    }))
    // 建表结果必须真查（上轮教训：DDL 被 readOnly 拒时 ERR 静默于未检查的返回值）
    const created = parse(await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: `select table_name from information_schema.tables where table_schema='${DB_NAME}' and table_name='${TABLE}'`,
      database: DB_NAME
    })))
    check('建库建表（' + DB_NAME + '.' + TABLE + '）',
      created.results && created.results.length === 1, created.results)

    // ---------- 5. openFile：主进程 dialog 被调 → 子进程 preview 回传 ----------
    const preview = parse(await run(op('dbImportOp', 'openFile', {})))
    check('openFile 返回 filePath = 打桩路径', preview.filePath === csvPath, preview)
    check('openFile 格式判定 csv + kind rows',
      preview.format === 'csv' && preview.kind === 'rows', preview)
    check('openFile 列识别 [name, age]',
      JSON.stringify(preview.columns) === JSON.stringify(['name', 'age']), preview.columns)
    check('openFile 样例 3 行', (preview.sampleRows || []).length === 3, preview.sampleRows)

    // ---------- 6. start：子进程分批写 MySQL ----------
    const started = parse(await run(op('dbImportOp', 'start', {
      tabId: bm.id,
      filePath: csvPath,
      database: DB_NAME,
      table: TABLE,
      mode: 'append',
      mapping: [
        { fileCol: 'name', target: 'name' },
        { fileCol: 'age', target: 'age' }
      ]
    })))
    check('start 返回 importId', !!started.importId, started)

    // ---------- 7. status 轮询到结束 ----------
    let status = null
    for (let i = 0; i < 30; i++) {
      await wait(500)
      status = parse(await run(op('dbImportOp', 'status', { importId: started.importId })))
      if (status.status !== 'running') break
    }
    check('导入任务完成', status && status.status === 'done' && !status.error, status)
    check('committedRows == 3', status && status.committedRows === 3, status)
    check('failedBatches == 0', status && status.failedBatches === 0, status)

    // ---------- 8. 反查表内数据 ----------
    const cnt = parse(await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: `select count(*) c, sum(age) s from ${DB_NAME}.${TABLE}`,
      database: DB_NAME
    })))
    const row = cnt.results && cnt.results[0] && cnt.results[0].rows && cnt.results[0].rows[0]
    check('表内行数 == 3', row && Number(row.c) === 3, cnt.results)
    check('sum(age) == 96（数据逐行落库）', row && Number(row.s) === 96, cnt.results)

    // ---------- 9. 确认 dialog 确实在主进程被调用 ----------
    const dlgCalls = await cdpEval(insp.webSocketDebuggerUrl, 'globalThis.__dlgCalls', 10000)
    check('主进程 dialog.showOpenDialogSync 被调 1 次（openFile 走主进程）', dlgCalls === 1, { dlgCalls })

    // ---------- 10. 清理 ----------
    await run(op('dbClientOp', bm.id, 'executeSql', {
      sql: 'drop database if exists ' + DB_NAME,
      database: 'mysql'
    }))
    await run(op('closeDbTab', bm.id))
    console.log('\n== 清理完成（drop database / closeDbTab）==')
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

main().catch(e => { console.error(e); process.exit(1) })
