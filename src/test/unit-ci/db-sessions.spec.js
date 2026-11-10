/**
 * N6 契约测试：会话与状态查看（只读最小版）。
 *
 * 覆盖三处：
 *   1) mysql.js / postgres.js 的 listSessions + getServerStatus：用 vm 沙箱
 *      加载真实源码，注入 fake 驱动（mysql2/promise / pg），捕获实际发出的
 *      SQL 文本 —— 断言只读性（无任何写/kill 关键词）与返回形状；
 *   2) index.js OP_MAP：两个引擎都注册了 listSessions/getServerStatus；
 *   3) UI 源码契约：db-sessions.jsx 无任何 kill/terminate 入口、自动刷新
 *      默认关；db-session.jsx 在非 redis 主区挂了 sessions 页签。
 *
 * vm.runInThisContext 保持同 realm（避免跨 realm deepEqual 原型链误报），
 * 与 redis-bigkeys-profiler.spec.js 同一模式。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const baseDir = path.join(__dirname, '../../app/lib/db-client')

// 只读 SQL 白名单断言：出现的任何关键词都说明越界（KILL 是 N6 明确"永不做的分叉点"）
const FORBIDDEN_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE|CALL|KILL|MERGE|REPLACE)\b/i

function loadModule (srcPath, fakes) {
  const src = fs.readFileSync(srcPath, 'utf8')
  const dir = path.dirname(srcPath)
  const fakeRequire = (id) => {
    if (fakes[id]) return fakes[id]
    return require(path.resolve(dir, id))
  }
  const module_ = { exports: {} }
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${src} })`,
    { filename: srcPath }
  )
  wrapper(module_.exports, fakeRequire, module_, srcPath, dir)
  return module_.exports
}

// ---- MySQL fake 驱动：queryImpl(sql, params) → [rows, fields] ----
function makeMysqlFakes (queryImpl) {
  const calls = []
  const pool = {
    query: async (...a) => {
      calls.push({ sql: a[0], params: a[1] })
      return queryImpl(a[0], a[1])
    },
    end: async () => {}
  }
  return {
    'mysql2/promise': { createPool: () => pool },
    './db-tls': { resolveTlsProfile: () => null, tlsSigTag: () => '' },
    // log.js 依赖 runtime-constants → ../package.json，测试沙箱里用空实现替代
    '../../common/log': { log: () => {} },
    calls
  }
}

// ---- PG fake 驱动：queryImpl(sql, params) → { rows } ----
function makePgFakes (queryImpl) {
  const calls = []
  class FakeClient {
    async connect () {}
    async end () {}
    async query (...a) {
      calls.push({ sql: a[0], params: a[1] })
      return queryImpl(a[0], a[1])
    }
  }
  return {
    pg: { Client: FakeClient },
    './db-tls': { resolveTlsProfile: () => null, tlsSigTag: () => '' },
    calls
  }
}

const conn = { dbHost: '127.0.0.1', dbPort: 3306, dbUser: 'root', dbName: 'shop' }

// ---- mysql.js ----

test('N6 mysql listSessions: 查 information_schema.PROCESSLIST，info 截 500，只读', async () => {
  const fakes = makeMysqlFakes((sql) => [
    [{ id: 1, user: 'root', host: 'localhost', db: 'shop', command: 'Query', time: 30, state: 'Sending data', info: 'SELECT * FROM t' }],
    []
  ])
  const db = loadModule(path.join(baseDir, 'mysql.js'), fakes)
  const res = await db.listSessions(conn)

  assert.equal(fakes.calls.length, 1)
  const sql = fakes.calls[0].sql
  assert.doesNotMatch(sql, FORBIDDEN_RE, 'SQL 必须只读')
  assert.match(sql, /information_schema\.PROCESSLIST/)
  assert.match(sql, /left\(info,\s*500\)/i, 'info 要截断防 IPC 大包')
  assert.match(sql, /ORDER BY time DESC/i, '跑得久的排前面')
  assert.match(sql, /\btime\b/, 'time 列要在（验收项）')
  assert.match(sql, /\bstate\b/, 'state 列要在（验收项）')
  assert.match(sql, /\binfo\b/, 'info 列要在（验收项）')
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0].command, 'Query')
})

test('N6 mysql getServerStatus: VERSION + SHOW GLOBAL STATUS 子集，整形为平对象', async () => {
  const fakes = makeMysqlFakes((sql) => {
    if (/VERSION\(\)/i.test(sql)) {
      return [[{ version: '8.0.36' }], []]
    }
    return [[
      { Variable_name: 'Threads_connected', Value: '5' },
      { Variable_name: 'Slow_queries', Value: '2' }
    ], []]
  })
  const db = loadModule(path.join(baseDir, 'mysql.js'), fakes)

  assert.equal(fakes.calls.length, 0, 'loadModule 不应触发查询')
  const res = await db.getServerStatus(conn)

  assert.equal(fakes.calls.length, 2, '恰好两条查询（版本 + 状态）')
  for (const c of fakes.calls) {
    assert.doesNotMatch(c.sql, FORBIDDEN_RE, 'SQL 必须只读')
  }
  const statusCall = fakes.calls.find(c => /SHOW GLOBAL STATUS/i.test(c.sql))
  assert.ok(statusCall, '要查 SHOW GLOBAL STATUS')
  assert.deepEqual(statusCall.params[0].sort(), [
    'Innodb_row_lock_current_waits',
    'Queries',
    'Questions',
    'Slow_queries',
    'Threads_connected',
    'Threads_running',
    'Uptime'
  ].sort(), '状态子集取关键变量')
  assert.equal(res.version, '8.0.36')
  assert.deepEqual(res.status, { Threads_connected: '5', Slow_queries: '2' }, '整形为 { 变量名: 值 } 平对象')
})

// ---- postgres.js ----

test('N6 pg listSessions: 查 pg_stat_activity 当前库，query 截 500，只读', async () => {
  const fakes = makePgFakes((sql) => ({
    rows: [{ pid: 42, usename: 'app', state: 'active', running_seconds: 12, query: 'SELECT 1' }]
  }))
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)
  const res = await db.listSessions(conn)

  assert.equal(fakes.calls.length, 1)
  const sql = fakes.calls[0].sql
  assert.doesNotMatch(sql, FORBIDDEN_RE, 'SQL 必须只读')
  assert.match(sql, /pg_stat_activity/)
  assert.match(sql, /current_database\(\)/, '只看当前库的会话')
  assert.match(sql, /left\(a\.query,\s*500\)/i, 'query 要截断防 IPC 大包')
  assert.match(sql, /running_seconds/, '运行秒数要在（长跑查询验收项）')
  assert.match(sql, /COALESCE\(a\.query_start,\s*a\.xact_start\)/i)
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0].pid, 42)
})

test('N6 pg getServerStatus: version() + pg_stat_database 当前库统计行', async () => {
  const fakes = makePgFakes((sql) => {
    if (/version\(\)/i.test(sql)) {
      return { rows: [{ version: 'PostgreSQL 15.4' }] }
    }
    return { rows: [{ numbackends: 3, xact_commit: 1000, xact_rollback: 5 }] }
  })
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)
  const res = await db.getServerStatus(conn)

  assert.equal(fakes.calls.length, 2)
  for (const c of fakes.calls) {
    assert.doesNotMatch(c.sql, FORBIDDEN_RE, 'SQL 必须只读')
  }
  const stCall = fakes.calls.find(c => /pg_stat_database/.test(c.sql))
  assert.ok(stCall, '要查 pg_stat_database')
  assert.match(stCall.sql, /current_database\(\)/)
  assert.match(stCall.sql, /deadlocks/)
  assert.equal(res.version, 'PostgreSQL 15.4')
  assert.deepEqual(res.status, { numbackends: 3, xact_commit: 1000, xact_rollback: 5 })
})

// ---- index.js OP_MAP ----

test('N6 OP_MAP: mysql / postgres 都注册 listSessions + getServerStatus', () => {
  const src = fs.readFileSync(path.join(baseDir, 'index.js'), 'utf8')
  const m = src.match(/mysql:\s*\{([\s\S]*?)\n {2}\}/)
  const p = src.match(/postgres:\s*\{([\s\S]*?)\n {2}\}/)
  assert.ok(m && p, 'OP_MAP 两段都要能抽出来')
  assert.match(m[1], /listSessions:\s*'listSessions'/)
  assert.match(m[1], /getServerStatus:\s*'getServerStatus'/)
  assert.match(p[1], /listSessions:\s*'listSessions'/)
  assert.match(p[1], /getServerStatus:\s*'getServerStatus'/)
  // sqlite 不该有（无会话视图能力位）
  const s = src.match(/sqlite:\s*\{([\s\S]*?)\n {2}\}/)
  assert.ok(s, 'sqlite 段要能抽出来')
  assert.doesNotMatch(s[1], /listSessions/, 'sqlite 没有会话视图，不注册')
})

// ---- UI 源码契约 ----

test('N6 UI: db-sessions.jsx 无任何 kill/terminate 入口，自动刷新默认关', () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-sessions.jsx'), 'utf8'
  )
  // 边界红线：只展示，绝不 kill（对标文档 §10 永不做的分叉点）。
  // 剥掉 /* */ 与 // 注释后测 —— 头注释里解释边界本身会提到这些词
  const code = jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /KILL/, '不得出现 KILL')
  assert.doesNotMatch(code, /kill/, '不得出现 kill')
  assert.doesNotMatch(code, /terminate/i, '不得出现 pg_terminate 一族')
  // 组件不直接发写 op：只允许经由 hook 的两个只读 op
  assert.doesNotMatch(jsx, /dbClientOp/, '组件不直接调 op，取数都走 useDbSessions')
  assert.match(jsx, /checked=\{auto\}/, '开关绑定 auto 状态')
  assert.match(jsx, /useDbSessions/, '取数走 useDbSessions hook')
})

test('N6 UI: use-db-sessions.js 只发两个只读 op，轮询在 unmount 时清理', () => {
  const hook = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/use-db-sessions.js'), 'utf8'
  )
  const ops = [...hook.matchAll(/'dbClientOp',\s*tabId,\s*'(\w+)'/g)].map(m => m[1])
  assert.deepEqual([...new Set(ops)].sort(), ['getServerStatus', 'listSessions'],
    '只允许 listSessions / getServerStatus 两个只读 op')
  // 自动刷新默认关（useState(false)，验收项"刷新可关"）
  assert.match(hook, /useState\(false\)/, 'auto 初始必须为 false（默认不自动刷新）')
  assert.match(hook, /clearInterval/, 'unmount/关闭开关要清轮询')
  assert.match(hook, /setInterval\(load,/, '自动刷新走节拍轮询')
})

test('N6 UI: db-session.jsx 在非 redis 主区挂 sessions 页签', () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-session.jsx'), 'utf8'
  )
  // 页签只在 !isRedis 的主区 Tabs 里（redis 走 H7a INFO 弹层）
  const mainAreaIdx = jsx.indexOf('const mainArea = isRedis')
  const sessionsIdx = jsx.indexOf("key: 'sessions'")
  assert.ok(mainAreaIdx > -1, '主区判定要在')
  assert.ok(sessionsIdx > mainAreaIdx, 'sessions 页签要挂在主区 Tabs（非 redis 分支）之后')
  assert.match(jsx, /<DbSessions tabId=\{tabId\} dbType=\{tab\.dbType\} \/>/)
  assert.doesNotMatch(jsx, /forceRender: true,\s*children: <DbSessions/,
    '不强制首帧渲染：没看过会话页的连接不白付一次查询')
})

// ---- UI 滚动通道（N6 回归锁）：与数据/结构页同款 DbGridTable ----
test('N6 UI: 会话页表格走 DbGridTable（统一滚动通道），不自开 overflow 视口', () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-sessions.jsx'), 'utf8'
  )
  const styl = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-session.styl'), 'utf8'
  )
  // 分支①（可虚拟化平表）唯一 JS 实现：组件层不得裸 Table / 手写 scroll.y / virtual
  assert.match(jsx, /<DbGridTable\b/, '会话网格必须走 DbGridTable')
  assert.doesNotMatch(jsx, /<Table\b/, '裸 antd Table 会绕过统一滚动通道')
  assert.doesNotMatch(jsx, /scroll=\{\{/, '组件层不得手写 scroll')
  // 截出 .db-sessions-wrap 这一块（到下一个顶层 .db- 块为止）
  const start = styl.indexOf('.db-sessions-wrap')
  const next = styl.indexOf('\n.db-', start + 1)
  const block = styl.slice(start, next > -1 ? next : styl.length)
  assert.ok(block.length > 0, '要能截到 .db-sessions-wrap 块')
  // 撑满链留给 DbGridTable 实测 scroll.y；wrap 自己不再开滚动视口（否则双通道）
  assert.match(block, /height 100%/, 'wrap 要撑满 tabpane，DbGridTable 才有确定高可测')
  assert.doesNotMatch(block, /overflow auto/, 'wrap 内不得自开 overflow 视口（滚动权归 DbGridTable）')
  assert.doesNotMatch(block, /\.ant-spin-container/, 'Spin 容器滚动链已废：loading 走 Table 自身 loading prop')
})

// 同根遗留兜底：.db-sql-result 等其它块也可能误打 antd5 死类，全文件扫描一次
test('N6 UI: db-session.styl 全文件注释剥离后不得残留 .ant-spin-nested-loading 选择器', () => {
  const styl = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-session.styl'), 'utf8'
  )
  // 剥掉 /* */ 与 // 注释后，绝不允许再出现 .ant-spin-nested-loading 选择器
  // （antd6 <Spin> 不渲染该类，写它等于没写；仅允许在注释里解释为何不用它）
  const code = styl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\.ant-spin-nested-loading/,
    'antd5 的 .ant-spin-nested-loading 在 antd6 不存在，选择器层必须清零（注释可留）')
})
