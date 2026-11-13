/**
 * N7 新建表 / 新建键 —— CDP 实机 E2E 探针（退出码即结论）
 *
 * 链路：真 Electron（Xvfb）+ 渲染层 op 面（与 UI 同通道），双库实测：
 * - Redis：本地 127.0.0.1:6379，按 buildCreateKeyPlan 的产出顺序逐条调既有 op
 *   （setKey/hashSetField/listPush/setAdd/zsetAdd/expireKey），redis-cli 独立反查
 *   类型/内容/TTL —— 证明「页面新建键」的服务端通道全部真实可用；
 * - MySQL：115.67:13306（mysql.png 配置），createTableDdl 生成的 CREATE TABLE
 *   脚本原样经 executeSql 落库，information_schema 反查列定义 —— 证明生成器
 *   产出的是真实可执行的 SQL，不是"看起来像"。
 *
 * 复用 db-import-cdp-probe.js 的骨架（CDP page + op 面直调）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.join(__dirname, '..')
// 端口/DISPLAY/TMPDIR 按 pid 唯一化。踩过的坑：app/lib/single-instance.js 的锁
// socket 落在 app.getPath('temp')，默认是 /tmp；用户若正在跑打包版 /opt/electerm，
// 源码探针会被判成「第二实例」直接 app.quit()，表现为 DevTools 端口通但 no page target。
// 独立 TMPDIR 让探针的单实例锁与正式版彻底隔离，固定端口同理避免误连旧页面。
const UNIQ = process.pid % 30000
const CDP_PORT = 21000 + UNIQ
const INSPECT_PORT = 24000 + UNIQ
const DISPLAY = ':' + (120 + (process.pid % 100))
const MYSQL = { host: '192.168.115.67', port: 13306, user: 'root', password: 'password' }
const DB_NAME = 'electerm_create_test'
const REDIS_PREFIX = 'e2e:n7:'

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
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-create-cdp-'))
  const userData = path.join(run, 'ud')
  const probeTmp = path.join(run, 'tmp')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(probeTmp, { recursive: true })

  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24'], { stdio: 'ignore' })
  await wait(1200)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.ELECTERM_USER_DATA = userData
  // app.getPath('temp') 认 TMPDIR，单实例 socket 因此落在本探针私有目录
  env.TMPDIR = probeTmp
  env.NODE_OPTIONS = ''
  const app = spawn(
    path.join(ROOT, 'node_modules/electron/dist/electron'),
    [path.join(ROOT, 'work/app/app.js'),
      '--remote-debugging-port=' + CDP_PORT,
      '--inspect=' + INSPECT_PORT],
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

  try {
    // 生成器从源码 import（渲染层代码打包进 assets bundle，op 级验证不需要它进产物；
    // generate 出的 SQL 经真实 executeSql 落库，等于替 UI 把"写入编辑器后执行"走完）
    const GEN = await import('file://' + path.join(ROOT, 'src/client/common/db-ddl-generate.js'))
    // 方案 B：createTableDdl 吃 draftToStructure 产出的 v2 结构（唯一归一化出口），
    // 探针也要走这条链，不能把草稿形状直接塞给生成器
    const DESIGN = await import('file://' + path.join(ROOT, 'src/client/common/db-table-design.js'))

    // ---------- 1. 渲染层就绪 ----------
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

    const runExpr = expr => cdpEval(page.webSocketDebuggerUrl, expr, 60000)
    const op = (name, ...args) =>
      `window.pre.runGlobalAsync(${JSON.stringify(name)}, ${args.map(a => JSON.stringify(a)).join(', ')})` +
      '.then(r => JSON.stringify(r)).catch(e => \'ERR:\' + e.message)'
    const parse = v => {
      if (typeof v !== 'string' || v.startsWith('ERR:')) {
        throw new Error('op failed: ' + v)
      }
      return JSON.parse(v)
    }
    const cli = args => execSync('redis-cli --no-raw ' + args).toString().trim()

    // ---------- 2. Redis：新建键（与 UI buildCreateKeyPlan 同一调用序列） ----------
    console.log('\n== Redis 新建键（127.0.0.1:6379）==')
    const rbm = {
      id: 'cdp-create-redis-tab',
      dbType: 'redis',
      dbHost: '127.0.0.1',
      dbPort: 6379,
      dbPassword: '',
      name: 'cdp-n7-redis',
      readOnly: false
    }
    const rconn = parse(await runExpr(op('testDbConnection', rbm)))
    check('testDbConnection redis', !!rconn, rconn)
    await runExpr(op('openDbTab', rbm))
    const rcall = async (opName, args) => parse(await runExpr(op('dbClientOp', rbm.id, opName, args)))
    const rid = { dbIndex: 0 }

    // string + TTL（键不存在 → SET 自动建键）
    await rcall('setKey', { ...rid, key: REDIS_PREFIX + 'str', value: 'hello' })
    await rcall('expireKey', { ...rid, key: REDIS_PREFIX + 'str', seconds: 120 })
    check('string 建键 + type', cli('type ' + REDIS_PREFIX + 'str').includes('string'))
    check('string 值正确', cli('get ' + REDIS_PREFIX + 'str').includes('hello'))
    const ttlRaw = cli('ttl ' + REDIS_PREFIX + 'str')
    const ttlMatch = ttlRaw.match(/(\d+)\s*$/)
    const ttl = ttlMatch ? Number(ttlMatch[1]) : NaN
    check('TTL 落位（60~120s）', ttl > 60 && ttl <= 120, { ttl, ttlRaw })

    // hash（每字段一条 hashSetField，HSET 自动建键）
    await rcall('hashSetField', { ...rid, key: REDIS_PREFIX + 'h', field: 'f1', value: 'v=1' })
    await rcall('hashSetField', { ...rid, key: REDIS_PREFIX + 'h', field: 'f2', value: 'v2' })
    const h = cli('hgetall ' + REDIS_PREFIX + 'h')
    check('hash 建键 + 两字段', h.includes('f1') && h.includes('v=1') && h.includes('f2') && h.includes('v2'), h)

    // list（RPUSH 保序）
    await rcall('listPush', { ...rid, key: REDIS_PREFIX + 'l', value: 'a', position: 'right' })
    await rcall('listPush', { ...rid, key: REDIS_PREFIX + 'l', value: 'b', position: 'right' })
    const l = cli('lrange ' + REDIS_PREFIX + 'l 0 -1')
    check('list 建键 + 输入顺序', l.includes('a') && l.includes('b') && l.indexOf('a') < l.indexOf('b'), l)

    // set / zset
    await rcall('setAdd', { ...rid, key: REDIS_PREFIX + 's', members: ['m1', 'm2'] })
    check('set 建键 + 成员', cli('smembers ' + REDIS_PREFIX + 's').includes('m1') &&
      cli('smembers ' + REDIS_PREFIX + 's').includes('m2'))
    await rcall('zsetAdd', { ...rid, key: REDIS_PREFIX + 'z', score: 90, member: 'alice' })
    await rcall('zsetAdd', { ...rid, key: REDIS_PREFIX + 'z', score: 85, member: 'bob' })
    const z = cli('zrange ' + REDIS_PREFIX + 'z 0 -1 WITHSCORES')
    check('zset 建键 + score', z.includes('bob') && z.includes('90'), z)

    // 只读 tab：建键必须被拦（写护栏回归）
    const rbmRo = { ...rbm, id: 'cdp-create-redis-tab-ro', readOnly: true }
    await runExpr(op('openDbTab', rbmRo))
    const roBlocked = await runExpr(op('dbClientOp', rbmRo.id, 'setKey', { dbIndex: 0, key: REDIS_PREFIX + 'ro', value: 'x' })
      .replace('.then(r => JSON.stringify(r))', '.then(r => \'OK:\' + JSON.stringify(r))'))
    check('只读 tab 建键被拦', roBlocked.startsWith('ERR:'), { roBlocked: roBlocked.slice(0, 80) })
    await runExpr(op('closeDbTab', rbmRo.id))

    // ---------- 3. MySQL：新建表（createTableDdl 产出原样落库） ----------
    console.log('\n== MySQL 新建表（' + MYSQL.host + ':' + MYSQL.port + '）==')
    const mbm = {
      id: 'cdp-create-mysql-tab',
      dbType: 'mysql',
      dbHost: MYSQL.host,
      dbPort: MYSQL.port,
      dbUser: MYSQL.user,
      dbPassword: MYSQL.password,
      dbName: 'mysql',
      readOnly: false
    }
    parse(await runExpr(op('testDbConnection', mbm)))
    await runExpr(op('openDbTab', mbm))
    const msql = async sql => parse(await runExpr(op('dbClientOp', mbm.id, 'executeSql', { sql, database: 'mysql' })))
    await msql('create database if not exists ' + DB_NAME)

    // 生成器产出 → 原样执行（UI 落 SQL 编辑器的就是这段文本）
    const draft = {
      comment: 'e2e 新建表',
      columns: [
        { key: 'c1', origName: '', name: 'id', type: 'int(11)', nullable: false, hasDefault: true, defaultValue: '0', comment: '' },
        { key: 'c2', origName: '', name: 'username', type: 'varchar(64)', nullable: false, hasDefault: false, defaultValue: '', comment: '用户名' },
        { key: 'c3', origName: '', name: 'note', type: 'varchar(255)', nullable: true, hasDefault: false, defaultValue: '', comment: '' }
      ],
      indexes: [
        { key: 'i1', origName: '', name: 'pk', columns: ['id'], unique: false, primary: true, method: null },
        { key: 'i2', origName: '', name: 'uk_username', columns: ['username'], unique: true, primary: false, method: null }
      ]
    }
    const gen = GEN.createTableDdl(DESIGN.draftToStructure(draft), 'mysql', { database: DB_NAME, table: 'e2e_users' })
    check('createTableDdl supported', gen.supported, gen.reason)
    check('脚本是一条 CREATE', gen.sqls.length === 1 && gen.sqls[0].startsWith('CREATE TABLE'), gen.sqls[0].slice(0, 60))
    await msql(gen.sqls[0])
    const cols = parse(await runExpr(op('dbClientOp', mbm.id, 'executeSql', {
      sql: `select column_name, column_type, is_nullable, column_comment from information_schema.columns where table_schema='${DB_NAME}' and table_name='e2e_users' order by ordinal_position`,
      database: DB_NAME
    })))
    const rows = cols.results && cols.results[0] && cols.results[0].rows
    check('三列齐全且顺序一致', rows && rows.length === 3 &&
      rows.map(r => r.column_name || r.COLUMN_NAME).join(',') === 'id,username,note', rows)
    const uk = parse(await runExpr(op('dbClientOp', mbm.id, 'executeSql', {
      sql: `select index_name, non_unique from information_schema.statistics where table_schema='${DB_NAME}' and table_name='e2e_users' group by index_name, non_unique`,
      database: DB_NAME
    })))
    const ukRows = uk.results && uk.results[0] && uk.results[0].rows
    check('主键 + 唯一索引落库',
      ukRows && ukRows.some(r => (r.index_name || r.INDEX_NAME) === 'PRIMARY') &&
      ukRows.some(r => (r.index_name || r.INDEX_NAME) === 'uk_username' && Number(r.non_unique) === 0), ukRows)
    const tbc = parse(await runExpr(op('dbClientOp', mbm.id, 'executeSql', {
      sql: `select table_comment from information_schema.tables where table_schema='${DB_NAME}' and table_name='e2e_users'`,
      database: DB_NAME
    })))
    const tbcRow = tbc.results && tbc.results[0] && tbc.results[0].rows && tbc.results[0].rows[0]
    check('表注释落库', tbcRow && String(tbcRow.table_comment || tbcRow.TABLE_COMMENT).includes('e2e'), tbcRow)

    // 生成器拒绝口径（坏表名不出语句）
    const bad = GEN.createTableDdl(DESIGN.draftToStructure(draft), 'mysql', { database: DB_NAME, table: 'bad name' })
    check('非法表名 supported=false', !bad.supported && bad.reason === 'bad-table-name', bad.reason)

    // ---------- 4. 清理 ----------
    await msql('drop database if exists ' + DB_NAME)
    for (const k of ['str', 'h', 'l', 's', 'z', 'ro']) {
      try { execSync('redis-cli del ' + REDIS_PREFIX + k) } catch (e) {}
    }
    await runExpr(op('closeDbTab', rbm.id))
    await runExpr(op('closeDbTab', mbm.id))
    console.log('\n== 清理完成 ==')
  } catch (e) {
    failCount++
    console.error('[fail]', e.message)
    console.error('[stderr-tail]', appErr.slice(-500))
    console.error('[stdout-tail]', appOut.slice(-500))
  } finally {
    // detached 进程组整体收掉：只 kill 主进程会留下 gpu/server 子进程，
    // 它们会继承单实例 socket 的 fd，把后续探针继续判成第二实例
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
