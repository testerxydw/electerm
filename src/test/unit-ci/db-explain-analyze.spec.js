/**
 * N7 契约测试：受控实测执行计划（EXPLAIN ANALYZE）。
 *
 * 覆盖三处：
 *   1) mysql.js / postgres.js explainQuery 的 analyze 受控路径：vm 沙箱加载真实
 *      源码 + fake 驱动捕获实发 SQL —— 断言三重收紧（只读拒 / SELECT 限定 /
 *      用户自带 ANALYZE 拒）、mysql 走 TREE 文本（root=null）、pg 走
 *      BEGIN → SET LOCAL statement_timeout → EXPLAIN (ANALYZE, FORMAT JSON) →
 *      ROLLBACK（出错也回滚）、actualRows 从 'Actual Rows' 提取；
 *   2) 预估路径行为不变（analyze 不传时 SQL 与返回形状同旧版）；
 *   3) UI 源码契约：实测开关默认关、能力位 explainAnalyze 控制、只读禁用、
 *      实测前过 confirmSqlRisk、词条中英齐备。
 *
 * vm.runInThisContext 保持同 realm（避免跨 realm deepEqual 原型链误报），
 * 与 db-sessions.spec.js 同一模式。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const baseDir = path.join(__dirname, '../../app/lib/db-client')

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

// ---- mysql fake：pool.getConnection() → c.query(sql) ----
function makeMysqlFakes (queryImpl) {
  const calls = []
  const pool = {
    getConnection: async () => ({
      query: async (...a) => {
        calls.push({ sql: a[0], params: a[1] })
        return queryImpl(a[0], a[1])
      },
      release: async () => {}
    })
  }
  return {
    'mysql2/promise': { createPool: () => pool },
    './db-tls': { resolveTlsProfile: () => null, tlsSigTag: () => '' },
    // log.js 依赖 runtime-constants → ../package.json，测试沙箱里用空实现替代
    '../../common/log': { log: () => {} },
    calls
  }
}

// ---- pg fake：getClient 内部走 pg.Client；同一实例内按序捕获 ----
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
const PG_ANALYZE_PLAN = {
  Plan: {
    'Node Type': 'Seq Scan',
    'Relation Name': 't1',
    'Plan Rows': 10,
    'Actual Rows': 7,
    'Total Cost': 1.5
  }
}

// ---- mysql.js ----

test('N7 mysql analyze=true: 发 EXPLAIN ANALYZE（TREE），返回 root=null + 原文', async () => {
  const fakes = makeMysqlFakes(() => [[{ EXPLAIN: '-> Table scan on t1 (actual rows=7)' }]])
  const db = loadModule(path.join(baseDir, 'mysql.js'), fakes)
  const res = await db.explainQuery(conn, { sql: 'select 1', analyze: true })

  assert.equal(fakes.calls.length, 1)
  assert.match(fakes.calls[0].sql, /^EXPLAIN ANALYZE select 1/, '实测走 EXPLAIN ANALYZE 前缀')
  assert.doesNotMatch(fakes.calls[0].sql, /FORMAT=JSON/, 'MySQL ANALYZE 不支持 JSON，不带 FORMAT')
  assert.equal(res.analyze, true)
  assert.equal(res.root, null)
  assert.equal(res.raw, '-> Table scan on t1 (actual rows=7)')
})

test('N7 mysql analyze 缺省: 行为不变（EXPLAIN FORMAT=JSON + root 树）', async () => {
  const plan = { query_block: { table: { table_name: 't1', access_type: 'ALL', rows: 3 } } }
  const fakes = makeMysqlFakes(() => [[{ EXPLAIN: JSON.stringify(plan) }]])
  const db = loadModule(path.join(baseDir, 'mysql.js'), fakes)
  const res = await db.explainQuery(conn, { sql: 'select 1' })

  assert.match(fakes.calls[0].sql, /^EXPLAIN FORMAT=JSON select 1/)
  assert.equal(res.root.nodeType, 'SELECT')
  assert.notEqual(res.analyze, true)
})

test('N7 mysql 受控收紧: 只读拒 / 非 SELECT 拒 / 用户自带 ANALYZE 拒，且零往返', async () => {
  const fakes = makeMysqlFakes(() => [[]])
  const db = loadModule(path.join(baseDir, 'mysql.js'), fakes)

  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'select 1', analyze: true, readOnly: true }),
    /只读连接不提供实测执行计划/,
    '只读连接必须拒（readOnly 由主进程注入）'
  )
  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'delete from t', analyze: true }),
    /只接受 SELECT/,
    '写语句没有实测语义，必须拒'
  )
  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'EXPLAIN ANALYZE select 1', analyze: true }),
    /拒绝 ANALYZE/,
    '用户自带 ANALYZE 统一入口拒绝'
  )
  // 注释里藏写语句：首词是 select 但掩码后含分号多语句，原有闸门仍兜住
  await assert.rejects(
    () => db.explainQuery(conn, { sql: "select 1; delete from t where '--'='x'", analyze: true }),
    /多余分号/
  )
  assert.equal(fakes.calls.length, 0, '四条收紧全部零往返')
})

// ---- postgres.js ----

test('N7 pg analyze=true: BEGIN → SET LOCAL → EXPLAIN (ANALYZE, FORMAT JSON) → ROLLBACK，actualRows 提取', async () => {
  const fakes = makePgFakes(() => ({ rows: [{ 'QUERY PLAN': [PG_ANALYZE_PLAN] }] }))
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)
  const res = await db.explainQuery(conn, { sql: 'select 1', analyze: true })

  const seq = fakes.calls.map(c => c.sql)
  assert.deepEqual(seq, [
    'BEGIN',
    'SET LOCAL statement_timeout = 120000',
    'EXPLAIN (ANALYZE, FORMAT JSON) select 1',
    'ROLLBACK'
  ], '事务包裹 + 服务端超时 + 测完回滚，顺序固定')
  assert.equal(res.analyze, true)
  assert.equal(res.root.nodeType, 'Seq Scan')
  assert.equal(res.root.rows, 10, '预估行数仍取 Plan Rows')
  assert.equal(res.root.actualRows, 7, '实际行数取 Actual Rows')
})

test('N7 pg analyze 出错也回滚，不留开放事务', async () => {
  const fakes = makePgFakes((sql) => {
    if (/EXPLAIN \(ANALYZE/.test(sql)) {
      throw new Error('boom')
    }
    return { rows: [] }
  })
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)
  await assert.rejects(() => db.explainQuery(conn, { sql: 'select 1', analyze: true }), /boom/)

  const seq = fakes.calls.map(c => c.sql)
  assert.equal(seq[0], 'BEGIN')
  assert.equal(seq[seq.length - 1], 'ROLLBACK', 'finally 里必须回滚')
})

test('N7 pg analyze 缺省: 行为不变（EXPLAIN (FORMAT JSON)，无事务）', async () => {
  // 预估计划没有 'Actual Rows' 字段 —— 该字段只在 ANALYZE 输出里存在
  const estPlan = {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 't1',
      'Plan Rows': 10,
      'Total Cost': 1.5
    }
  }
  const fakes = makePgFakes(() => ({ rows: [{ 'QUERY PLAN': [estPlan] }] }))
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)
  const res = await db.explainQuery(conn, { sql: 'select 1' })

  const seq = fakes.calls.map(c => c.sql)
  assert.deepEqual(seq, ['EXPLAIN (FORMAT JSON) select 1'], '预估路径不开事务')
  assert.equal(res.root.actualRows, null, '预估计划 actualRows 恒为 null')
  assert.notEqual(res.analyze, true)
})

test('N7 pg 受控收紧: 只读拒 / 非 SELECT 拒，零往返', async () => {
  const fakes = makePgFakes(() => ({ rows: [] }))
  const db = loadModule(path.join(baseDir, 'postgres.js'), fakes)

  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'select 1', analyze: true, readOnly: true }),
    /只读连接不提供实测执行计划/
  )
  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'update t set a=1', analyze: true }),
    /只接受 SELECT/
  )
  await assert.rejects(
    () => db.explainQuery(conn, { sql: 'EXPLAIN (ANALYZE) select 1', analyze: true }),
    /拒绝 ANALYZE/
  )
  assert.equal(fakes.calls.length, 0)
})

// ---- UI 源码契约 ----

test('N7 UI: db-explain-tree.jsx 实测开关默认关、能力位控制、只读禁用、确认闸门', () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-explain-tree.jsx'), 'utf8'
  )
  const code = jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /useState\(false\)/, '实测开关默认关（验收项）')
  assert.match(code, /capabilityOf\(dbType, 'explainAnalyze'\)/, '开关显隐走能力位，不散落方言判断')
  assert.match(code, /disabled=\{readOnly\}/, '只读连接开关禁用（后端也会拒）')
  assert.match(code, /confirmSqlRisk\(sql, database\)/, '实测前过二次确认闸门')
  assert.match(code, /setAnalyze\(false\)\s*\n\s*return/, '确认取消时开关弹回关')
  assert.match(code, /analyze\s*$/m, 'op 载荷带 analyze 开关') // runGlobalAsync 载荷 analyze
})

test('N7 UI: db-session.jsx 给弹层传 dbType/readOnly/confirmSqlRisk', () => {
  const jsx = fs.readFileSync(
    path.join(__dirname, '../../client/components/database/db-session.jsx'), 'utf8'
  )
  assert.match(jsx, /<DbExplainDialog[\s\S]*?dbType=\{tab\.dbType\}/)
  assert.match(jsx, /<DbExplainDialog[\s\S]*?readOnly=\{isReadonly\}/)
  assert.match(jsx, /<DbExplainDialog[\s\S]*?confirmSqlRisk=\{confirmSqlRisk\}/)
})

test('N7 i18n: 实测相关词条中英齐备', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../app/common/locales-extra.js'), 'utf8'
  )
  const keys = [
    'dbExplainAnalyze',
    'dbExplainAnalyzeTip',
    'dbExplainAnalyzeWarn',
    'dbExplainAnalyzeReadonly',
    'dbExplainActualRows'
  ]
  for (const k of keys) {
    assert.match(src, new RegExp('^  ' + k + ": '.+',", 'm'), 'en 词条 ' + k)
  }
  // zh 段：用中文值锚定两个块
  const zh = (re, label) => assert.match(src, new RegExp('^ {2}' + re, 'm'), 'zh 词条 ' + label)
  zh("dbExplainAnalyze: '实测执行计划'", 'dbExplainAnalyze')
  zh("dbExplainAnalyzeWarn: '为测出真实计划", 'dbExplainAnalyzeWarn')
  zh("dbExplainActualRows: '实际行数'", 'dbExplainActualRows')
  zh("dbExplainAnalyzeTip: '真实执行该语句", 'dbExplainAnalyzeTip')
  zh("dbExplainAnalyzeReadonly: '只读连接不提供实测执行计划'", 'dbExplainAnalyzeReadonly')
})
