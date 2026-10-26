/**
 * D 批单测：EXPLAIN 可视化后端 + Redis 类型化写（T12）
 *
 * EXPLAIN（设计 §12.1）：
 *   - mysql parseMysqlPlan：单表 / nested_loop / ordering/grouping 包装 / 深层嵌套 /
 *     坏 JSON 可读错 / 缺 query_block / cost_info 缺省 / rows 回退
 *   - pg parsePgPlan：单层 / Plans 递归 / Relation Name 缺省 / Index Name/Filter/Total Cost
 *   - containsAnalyze：注释/字符串里的 analyze 不杀，真 ANALYZE 变体全杀（词法掩码）
 *   - extractActualRows：只有真正执行过的计划才有实际行数，预估值不冒充
 *   - explainQuery 集成（vm 打桩）：USE + EXPLAIN 前缀 / ANALYZE 拒绝不触网 /
 *     多语句分号拒绝 / 跨库拒绝
 * Redis（设计 §12.2 T12）：
 *   - 10 个类型化写方法 checkWritable 前置（readOnly 全拒且零 redis 调用）
 *   - 参数校验（空 members/fields、非有限 score、非法 position/index/count）
 *   - renamenx 冲突抛含 newKey 的可读错误
 *   - OP_MAP 注册齐全（源码契约）；redis 不注册 explainQuery
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

// ---------- vm 加载真实源码（不依赖 electron/真实驱动/网络） ----------

function runInVm (src, stubs, filename) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Buffer,
    Uint8Array
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

const loadMysql = (opts = {}) => {
  const calls = { queries: [] }
  const client = {
    async query (sql) {
      calls.queries.push(sql)
      if (opts.queryFail) {
        throw new Error(opts.queryErr || 'mock query fail')
      }
      return [opts.rows !== undefined ? opts.rows : []]
    },
    release () {}
  }
  const pool = { async getConnection () { return client } }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    { '../../common/log': LOG_STUB, 'mysql2/promise': { createPool () { return pool } } },
    'mysql.js'
  )
  return { mod, calls }
}

const loadPg = (opts = {}) => {
  const calls = { queries: [] }
  const client = {
    database: 'mydb',
    async connect () {},
    async end () {},
    async query (sql) {
      calls.queries.push(sql)
      if (opts.queryFail) {
        throw new Error(opts.queryErr || 'mock query fail')
      }
      return opts.result || { rows: [] }
    }
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client: function () { return client } } },
    'postgres.js'
  )
  return { mod, calls }
}

const loadRedis = (opts = {}) => {
  const calls = {}
  const rec = (name, args) => {
    calls[name] = calls[name] || []
    calls[name].push(args)
  }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select () {},
    async ping () { return 'PONG' },
    async hset (...a) { rec('hset', a); return 1 },
    async hdel (...a) { rec('hdel', a); return 1 },
    async sadd (...a) { rec('sadd', a); return 1 },
    async srem (...a) { rec('srem', a); return 1 },
    async zadd (...a) { rec('zadd', a); return 1 },
    async zrem (...a) { rec('zrem', a); return 1 },
    async lpush (...a) { rec('lpush', a); return 1 },
    async rpush (...a) { rec('rpush', a); return 1 },
    async lset (...a) { rec('lset', a); return 'OK' },
    async lrem (...a) { rec('lrem', a); return 1 },
    async renamenx (...a) {
      rec('renamenx', a)
      if (Array.isArray(opts.renamenxResults) && opts.renamenxResults.length) {
        return opts.renamenxResults.shift()
      }
      return 1
    }
  }
  const mod = runInVm(
    fs.readFileSync(REDIS_JS, 'utf8'),
    { ioredis: function () { return inst } },
    'redis.js'
  )
  const totalCalls = () =>
    Object.values(calls).reduce((s, a) => s + a.length, 0)
  return { mod, calls, totalCalls }
}

// ------------------------------------------------ mysql parseMysqlPlan

const MY_TABLE = (over = {}) => ({
  table_name: 't1',
  access_type: 'ALL',
  rows_examined_per_scan: 100,
  rows_produced_per_join: 100,
  filtered: '100.00',
  ...over
})

describe('D 批：EXPLAIN 解析（mysql parseMysqlPlan）', () => {
  const { mod } = loadMysql()

  test('单表：query_block 直挂 table，cost 取自 query_cost', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '2.40' },
        table: MY_TABLE()
      }
    })
    assert.equal(root.nodeType, 'SELECT')
    assert.equal(root.table, 't1')
    assert.equal(root.rows, 100)
    assert.equal(root.filtered, 100)
    assert.equal(root.cost, 2.4)
    assert.equal(root.children.length, 0)
  })

  test('单表嵌在 nested_loop 里：nodeType 取 access_type（ref + key）', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        nested_loop: [
          {
            table: MY_TABLE({
              access_type: 'ref',
              key: 'idx_name',
              used_key_parts: ['name'],
              rows_examined_per_scan: 3
            })
          }
        ]
      }
    })
    const child = root.children[0]
    assert.equal(child.nodeType, 'ref')
    assert.equal(child.key, 'idx_name')
    assert.equal(child.rows, 3)
  })

  test('nested_loop：两个子表各成一个节点', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        nested_loop: [
          { table: MY_TABLE({ table_name: 'a' }) },
          { table: MY_TABLE({ table_name: 'b', access_type: 'ref' }) }
        ]
      }
    })
    assert.equal(root.nodeType, 'SELECT')
    assert.equal(root.children.length, 2)
    assert.equal(root.children[0].nodeType, 'ALL')
    assert.equal(root.children[0].table, 'a')
    assert.equal(root.children[1].nodeType, 'ref')
    assert.equal(root.children[1].table, 'b')
  })

  test('ordering_operation 包裹：Sort 节点 + 子表，extra/attached_condition 均可取', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '12.00' },
        ordering_operation: {
          table: MY_TABLE({ access_type: 'index', key: 'PRIMARY', extra: 'Using where' })
        }
      }
    })
    assert.equal(root.nodeType, 'SELECT')
    assert.equal(root.cost, 12)
    const sort = root.children[0]
    assert.equal(sort.nodeType, 'Sort')
    assert.equal(sort.table, 't1')
    assert.equal(sort.key, 'PRIMARY')
    assert.equal(sort.extra, 'Using where')
  })

  test('attached_condition 作为 extra 回退来源', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        table: MY_TABLE({ attached_condition: '(`t1`.`id` > 3)' })
      }
    })
    assert.equal(root.extra, '(`t1`.`id` > 3)')
  })

  test('grouping_operation 包 ordering_operation：Group → Sort → table 递归', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        grouping_operation: {
          ordering_operation: {
            table: MY_TABLE()
          }
        }
      }
    })
    const group = root.children[0]
    assert.equal(group.nodeType, 'Group')
    // table 节点合并进最近的操作节点：Sort 节点直接带表字段，无孙节点
    const sort = group.children[0]
    assert.equal(sort.nodeType, 'Sort')
    assert.equal(sort.table, 't1')
    assert.equal(sort.children.length, 0)
  })

  test('深层嵌套：nested_loop 元素里再套 nested_loop', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        select_id: 1,
        nested_loop: [
          { table: MY_TABLE({ table_name: 'a' }) },
          {
            nested_loop: [
              { table: MY_TABLE({ table_name: 'b' }) },
              { table: MY_TABLE({ table_name: 'c', access_type: 'eq_ref' }) }
            ]
          }
        ]
      }
    })
    assert.equal(root.children[0].table, 'a')
    const inner = root.children[1]
    assert.deepEqual(Array.from(inner.children.map(c => c.table)), ['b', 'c'])
    assert.equal(inner.children[1].nodeType, 'eq_ref')
  })

  test('坏 JSON 字符串抛可读错', () => {
    assert.throws(() => mod.parseMysqlPlan('<html>oops</html>'), /不是合法 JSON/)
  })

  test('缺 query_block 抛可读错', () => {
    assert.throws(() => mod.parseMysqlPlan({ other: 1 }), /缺少 query_block/)
    assert.throws(() => mod.parseMysqlPlan(null), /无法解析 EXPLAIN 输出/)
  })

  test('cost_info 缺省 → cost 为 null，不影响树结构', () => {
    const root = mod.parseMysqlPlan({
      query_block: { select_id: 1, table: MY_TABLE() }
    })
    assert.equal(root.cost, null)
    assert.equal(root.table, 't1')
  })

  test('rows_examined_per_scan 缺省时回退 table.rows', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        table: { table_name: 't1', access_type: 'ALL', rows: 42, filtered: '50.00' }
      }
    })
    assert.equal(root.rows, 42)
    assert.equal(root.filtered, 50)
  })

  test('行数/过滤非法值 → null，不抛错', () => {
    const root = mod.parseMysqlPlan({
      query_block: {
        table: { table_name: 't1', access_type: 'ALL', rows_examined_per_scan: 'abc' }
      }
    })
    assert.equal(root.rows, null)
    assert.equal(root.filtered, null)
  })
})

// ------------------------------------------------ mysql containsAnalyze / extractActualRows

describe('D 批：ANALYZE 词法检查与实际行数（mysql）', () => {
  const { mod } = loadMysql()

  test('普通 SELECT 放行', () => {
    assert.equal(mod.containsAnalyze('SELECT * FROM users WHERE name = ?'), false)
  })

  test('EXPLAIN ANALYZE 各写法全杀（含大小写与换行）', () => {
    assert.equal(mod.containsAnalyze('EXPLAIN ANALYZE select 1'), true)
    assert.equal(mod.containsAnalyze('explain analyze select 1'), true)
    assert.equal(mod.containsAnalyze('EXPLAIN\nANALYZE SELECT 1'), true)
    assert.equal(mod.containsAnalyze('EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1'), true)
    assert.equal(mod.containsAnalyze('EXPLAIN FORMAT=JSON ANALYZE SELECT 1'), true)
  })

  test('字符串里的 analyze 不杀', () => {
    assert.equal(mod.containsAnalyze("SELECT * FROM t WHERE note = 'please analyze this'"), false)
    assert.equal(mod.containsAnalyze("SELECT 'analyze' FROM t"), false)
    assert.equal(mod.containsAnalyze("SELECT 'it\\'s analyze' FROM t"), false)
  })

  test('注释里的 analyze 不杀', () => {
    assert.equal(mod.containsAnalyze('SELECT 1 -- analyze me later'), false)
    assert.equal(mod.containsAnalyze('SELECT 1 # analyze'), false)
    assert.equal(mod.containsAnalyze('/* analyze */ SELECT 1'), false)
    assert.equal(mod.containsAnalyze('SELECT 1 /* analyze\nmulti line */'), false)
  })

  test('词边界：analyzed / analysis 不算 analyze', () => {
    assert.equal(mod.containsAnalyze('SELECT * FROM analysis'), false)
    assert.equal(mod.containsAnalyze('SELECT analyzed FROM t'), false)
  })

  test('BUG-1 联动：-- 后无空格时 analyze 视为普通文本（保守误杀方向）', () => {
    // --analyze 不是注释 → 文本里有 analyze 词 → 拒绝（宁可误拒）
    assert.equal(mod.containsAnalyze('select 1 --analyze from t'), true)
    // -- 后有空格 → 注释 → 不杀
    assert.equal(mod.containsAnalyze('select 1 -- analyze from t'), false)
  })

  test('extractActualRows：有实际行数才取，预估值不冒充', () => {
    assert.equal(mod.extractActualRows({ r_rows: 3 }), 3)
    assert.equal(mod.extractActualRows({ 'Actual Rows': 5 }), 5)
    assert.equal(mod.extractActualRows({ actualRows: '7' }), 7)
    // 预估字段（rows / Plan Rows / rows_examined_per_scan）一律不算实际值
    assert.equal(mod.extractActualRows({ rows: 100 }), null)
    assert.equal(mod.extractActualRows({ 'Plan Rows': 42 }), null)
    assert.equal(mod.extractActualRows({}), null)
    assert.equal(mod.extractActualRows(null), null)
    assert.equal(mod.extractActualRows('plan'), null)
  })
})

// ------------------------------------------------ mysql explainQuery（vm 打桩）

describe('D 批：mysql explainQuery（集成，vm 打桩）', () => {
  const DOC = {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '1.00' },
      table: MY_TABLE()
    }
  }

  test('带 database：先 USE 再 EXPLAIN FORMAT=JSON，返回统一树 + 原始 JSON', async () => {
    const { mod, calls } = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    const res = await mod.explainQuery(
      { dbHost: 'h', dbPort: 3306 },
      { database: 'mydb', sql: 'SELECT * FROM t1' }
    )
    assert.deepEqual(Array.from(calls.queries), ['USE `mydb`', 'EXPLAIN FORMAT=JSON SELECT * FROM t1'])
    assert.equal(res.dialect, 'mysql')
    assert.equal(res.root.table, 't1')
    assert.equal(res.root.nodeType, 'SELECT')
    assert.equal(res.raw.query_block.select_id, 1)
  })

  test('无 database：不发 USE', async () => {
    const { mod, calls } = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    await mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'SELECT 1' })
    assert.deepEqual(Array.from(calls.queries), ['EXPLAIN FORMAT=JSON SELECT 1'])
  })

  test('ANALYZE 输入被拒绝且不触网（不建连接）', async () => {
    const { mod, calls } = loadMysql()
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'EXPLAIN ANALYZE SELECT 1' }),
      /拒绝 ANALYZE/
    )
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'explain (ANALYZE) select 1' }),
      /拒绝 ANALYZE/
    )
    assert.equal(calls.queries.length, 0)
  })

  test('字符串/注释里的 analyze 不杀：正常走 EXPLAIN', async () => {
    const { mod, calls } = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    const res = await mod.explainQuery(
      { dbHost: 'h', dbPort: 3306 },
      { sql: "SELECT 'analyze' /* analyze */ FROM t1" }
    )
    assert.equal(res.dialect, 'mysql')
    assert.equal(calls.queries.length, 1)
  })

  test('空 sql 拒绝', async () => {
    const { mod, calls } = loadMysql()
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: '   ' }),
      /requires sql/
    )
    assert.equal(calls.queries.length, 0)
  })

  test('多语句分号拒绝（掩码后仍含分号）；尾部孤立分号剥掉后放行', async () => {
    const { mod, calls } = loadMysql()
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 3306 },
        { sql: 'SELECT 1; DELETE FROM t' }
      ),
      /一条语句/
    )
    assert.equal(calls.queries.length, 0)
    // 尾部孤立分号：剥掉后正常发送
    const ok = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    await ok.mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'SELECT 1;' })
    assert.deepEqual(
      Array.from(ok.calls.queries),
      ['EXPLAIN FORMAT=JSON SELECT 1']
    )
  })

  test('BUG-1 回归：-- 后无空格不是注释，分号可见 → 多语句拒绝', async () => {
    const { mod, calls } = loadMysql()
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 3306 },
        { sql: 'select 1 --x; DELETE FROM t' }
      ),
      /一条语句/
    )
    assert.equal(calls.queries.length, 0)
  })

  test('BUG-1 回归：-- 后跟空白仍是注释（掩到行尾，单条放行）', async () => {
    const { mod, calls } = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    // 真实 mysql 词法：-- 到行尾都是注释，服务端只看到 select 1，安全
    await mod.explainQuery(
      { dbHost: 'h', dbPort: 3306 },
      { sql: 'select 1 -- ok; DELETE FROM t' }
    )
    assert.equal(calls.queries.length, 1)
  })

  test('BUG-1 回归：--ok 后跟普通字符且无分号，正常放行', async () => {
    const { mod, calls } = loadMysql({ rows: [{ EXPLAIN: JSON.stringify(DOC) }] })
    await mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'select 1 --ok' })
    assert.deepEqual(
      Array.from(calls.queries),
      ['EXPLAIN FORMAT=JSON select 1 --ok']
    )
  })

  test('版本注释 /*! 一律拒绝（会被服务端当 SQL 执行，且掩不住内部分号）', async () => {
    const { mod, calls } = loadMysql()
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 3306 },
        { sql: 'select 1 /*!80000 x*/ ; DELETE FROM t' }
      ),
      /版本注释/
    )
    // 字符串里的字面量 /*! 也拒绝：多语句防护语境宁可误杀
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: "select '/*!' from t" }),
      /版本注释/
    )
    assert.equal(calls.queries.length, 0)
  })

  test('服务端返回坏 JSON → 可读错', async () => {
    const { mod } = loadMysql({ rows: [{ EXPLAIN: '{broken' }] })
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 3306 }, { sql: 'SELECT 1' }),
      /不是合法 JSON/
    )
  })
})

// ------------------------------------------------ pg parsePgPlan

const PG_PLAN = {
  'Node Type': 'Nested Loop',
  'Join Type': 'Inner',
  'Total Cost': 100.5,
  'Plan Rows': 50,
  Plans: [
    {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      'Plan Rows': 1000,
      Filter: '(age > 18)'
    },
    {
      'Node Type': 'Index Scan',
      'Relation Name': 'orders',
      'Index Name': 'idx_orders_user',
      'Plan Rows': 3,
      'Index Cond': '(user_id = users.id)'
    }
  ]
}

describe('D 批：EXPLAIN 解析（pg parsePgPlan）', () => {
  const { mod } = loadPg()

  test('单层：Seq Scan 字段映射', () => {
    const root = mod.parsePgPlan({
      Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Plan Rows': 1000, 'Total Cost': 25.1 }
    })
    assert.equal(root.nodeType, 'Seq Scan')
    assert.equal(root.table, 'users')
    assert.equal(root.rows, 1000)
    assert.equal(root.cost, 25.1)
    assert.equal(root.children.length, 0)
  })

  test('Plans 递归：Nested Loop 两个子节点，key/extra 取自 Index Name/Index Cond', () => {
    const root = mod.parsePgPlan({ Plan: PG_PLAN })
    assert.equal(root.nodeType, 'Nested Loop')
    assert.equal(root.table, null)
    assert.equal(root.cost, 100.5)
    assert.equal(root.children.length, 2)
    const seq = root.children[0]
    assert.equal(seq.nodeType, 'Seq Scan')
    assert.equal(seq.table, 'users')
    assert.equal(seq.extra, '(age > 18)')
    const idx = root.children[1]
    assert.equal(idx.nodeType, 'Index Scan')
    assert.equal(idx.key, 'idx_orders_user')
    assert.equal(idx.extra, '(user_id = users.id)')
  })

  test('深层递归：第三层 Plans 继续展开', () => {
    const root = mod.parsePgPlan({
      Plan: {
        'Node Type': 'Sort',
        Plans: [{
          'Node Type': 'Nested Loop',
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Plan Rows': 1 },
            { 'Node Type': 'Seq Scan', 'Relation Name': 'b', 'Plan Rows': 2 }
          ]
        }]
      }
    })
    const nl = root.children[0]
    assert.equal(nl.nodeType, 'Nested Loop')
    assert.deepEqual(Array.from(nl.children.map(c => c.table)), ['a', 'b'])
  })

  test('Relation Name 缺省 → table null', () => {
    const root = mod.parsePgPlan({
      Plan: { 'Node Type': 'Sort', 'Plan Rows': 1 }
    })
    assert.equal(root.table, null)
    assert.equal(root.nodeType, 'Sort')
  })

  test('缺 Plan → 可读错', () => {
    assert.throws(() => mod.parsePgPlan({}), /缺少 Plan/)
    assert.throws(() => mod.parsePgPlan(null), /缺少 Plan/)
    assert.throws(() => mod.parsePgPlan([{ Plan: 1 }]), /缺少 Plan/)
  })

  test('Plan Rows / Total Cost 非法值 → null', () => {
    const root = mod.parsePgPlan({
      Plan: { 'Node Type': 'Result', 'Plan Rows': 'x', 'Total Cost': undefined }
    })
    assert.equal(root.rows, null)
    assert.equal(root.cost, null)
  })
})

// ------------------------------------------------ pg explainQuery（vm 打桩）

describe('D 批：pg explainQuery（集成，vm 打桩）', () => {
  test('发送 EXPLAIN (FORMAT JSON)，返回统一树 + 原始文档', async () => {
    const { mod, calls } = loadPg({
      result: { rows: [{ 'QUERY PLAN': [{ Plan: PG_PLAN }] }] }
    })
    const res = await mod.explainQuery(
      { dbHost: 'h', dbPort: 5432 },
      { database: 'mydb', schema: 'public', sql: 'SELECT * FROM users' }
    )
    assert.deepEqual(
      Array.from(calls.queries),
      ['EXPLAIN (FORMAT JSON) SELECT * FROM users']
    )
    assert.equal(res.dialect, 'postgres')
    assert.equal(res.root.nodeType, 'Nested Loop')
    assert.equal(res.root.children[1].key, 'idx_orders_user')
    assert.equal(res.raw.Plan['Node Type'], 'Nested Loop')
  })

  test('QUERY PLAN 为数组时取首个计划文档', async () => {
    const { mod } = loadPg({
      result: { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Plan Rows': 1 } }] }] }
    })
    const res = await mod.explainQuery({ dbHost: 'h', dbPort: 5432 }, { sql: 'SELECT 1' })
    assert.equal(res.root.nodeType, 'Result')
  })

  test('BUG-2 回归：dollar-quoted 串内的撇号不再吞掉后续分号', async () => {
    const { mod, calls } = loadPg()
    // 修复前 $$it's$$ 的撇号被误当字符串起点，`; DELETE` 全被吞、闸门失守
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 5432 },
        { sql: "SELECT $$it's$$; DELETE FROM t" }
      ),
      /一条语句/
    )
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 5432 },
        { sql: "SELECT $fn$ it's $fn$; DELETE FROM t" }
      ),
      /一条语句/
    )
    assert.equal(calls.queries.length, 0)
  })

  test('BUG-2 回归：$1 占位符不是 dollar-quote 开标签，正常放行', async () => {
    const { mod, calls } = loadPg({
      result: { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Plan Rows': 1 } }] }] }
    })
    await mod.explainQuery(
      { dbHost: 'h', dbPort: 5432 },
      { sql: 'SELECT $1 FROM t WHERE x = $1' }
    )
    assert.deepEqual(
      Array.from(calls.queries),
      ['EXPLAIN (FORMAT JSON) SELECT $1 FROM t WHERE x = $1']
    )
  })

  test('dollar-quoted 串内的 analyze 被掩掉，不触发 ANALYZE 拒绝', async () => {
    const { mod } = loadPg({
      result: { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Plan Rows': 1 } }] }] }
    })
    await mod.explainQuery(
      { dbHost: 'h', dbPort: 5432 },
      { sql: 'SELECT $$analyze$$ FROM t' }
    )
  })

  test('悬空 dollar-quote 固定行为：保守掩到文末，放行为单条由服务端报错', async () => {
    // close 配不上 → 掩到文末（后端注释已写明）：无分号可见，多语句闸门放行，
    // 服务端对未闭合串报语法错，不会执行任何东西 —— 宁可保守不放大
    const { mod } = loadPg({
      result: { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Plan Rows': 1 } }] }] }
    })
    await mod.explainQuery(
      { dbHost: 'h', dbPort: 5432 },
      { sql: 'SELECT $tag$ unclosed ; DELETE FROM t' }
    )
  })

  test('ANALYZE 拒绝且不触网；字符串里的 analyze 不杀', async () => {
    const { mod, calls } = loadPg()
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 5432 },
        { sql: 'EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1' }
      ),
      /拒绝 ANALYZE/
    )
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 5432 }, { sql: 'explain analyze SELECT 1' }),
      /拒绝 ANALYZE/
    )
    assert.equal(calls.queries.length, 0)
    // 字符串里的 analyze 不能误杀（会正常发查询；stub 返回空结果才报缺 QUERY PLAN）
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 5432 }, { sql: "SELECT 'analyze it'" }),
      /缺少 QUERY PLAN/
    )
    assert.equal(calls.queries.length, 1)
  })

  test('空 sql / 跨库 / 缺 QUERY PLAN 各自拒绝', async () => {
    const { mod } = loadPg()
    await assert.rejects(
      mod.explainQuery({ dbHost: 'h', dbPort: 5432 }, { sql: '' }),
      /requires sql/
    )
    await assert.rejects(
      mod.explainQuery(
        { dbHost: 'h', dbPort: 5432 },
        { database: 'otherdb', sql: 'SELECT 1' }
      ),
      /cross-database/
    )
    const bad = loadPg({ result: { rows: [{ 'QUERY PLAN': [] }] } })
    await assert.rejects(
      bad.mod.explainQuery({ dbHost: 'h', dbPort: 5432 }, { sql: 'SELECT 1' }),
      /缺少 QUERY PLAN|缺少 Plan/
    )
  })
})

// ------------------------------------------------ Redis 类型化写（T12）

const CONN = { dbHost: 'h', dbPort: 6379 }

describe('D 批：Redis 类型化写（T12）', () => {
  const WRITE_METHODS = [
    ['hashSetField', { key: 'h', field: 'f', value: 'v' }],
    ['hashDelField', { key: 'h', fields: ['f'] }],
    ['setAdd', { key: 's', members: ['a'] }],
    ['setRem', { key: 's', members: ['a'] }],
    ['zsetAdd', { key: 'z', score: 1, member: 'a' }],
    ['zsetRem', { key: 'z', members: ['a'] }],
    ['listPush', { key: 'l', value: 'v', position: 'left' }],
    ['listSetAt', { key: 'l', index: 0, value: 'v' }],
    ['listRemAt', { key: 'l', index: 'v' }],
    ['renameKeyNx', { key: 'a', newKey: 'b' }]
  ]

  test('readOnly 全拦截：10 个方法全部拒绝且零 redis 调用', async () => {
    const { mod, totalCalls } = loadRedis()
    for (const [name, args] of WRITE_METHODS) {
      await assert.rejects(
        mod[name](CONN, { dbIndex: 0, readOnly: true, ...args }),
        /read-only mode: key modification disabled/,
        `${name} must be blocked in read-only mode`
      )
    }
    assert.equal(totalCalls(), 0, 'no redis command may be issued for read-only requests')
  })

  test('hashSetField：HSET key field value', async () => {
    const { mod, calls } = loadRedis()
    await mod.hashSetField(CONN, { dbIndex: 2, key: 'h', field: 'f', value: 'v', readOnly: false })
    assert.deepEqual(Array.from(calls.hset[0]), ['h', 'f', 'v'])
  })

  test('hashDelField：fields 数组逐个透传给 HDEL', async () => {
    const { mod, calls } = loadRedis()
    await mod.hashDelField(CONN, { dbIndex: 0, key: 'h', fields: ['a', 'b'], readOnly: false })
    assert.deepEqual(Array.from(calls.hdel[0]), ['h', 'a', 'b'])
  })

  test('hashDelField：fields 字符串归一为单元素', async () => {
    const { mod, calls } = loadRedis()
    await mod.hashDelField(CONN, { dbIndex: 0, key: 'h', fields: 'a', readOnly: false })
    assert.deepEqual(Array.from(calls.hdel[0]), ['h', 'a'])
  })

  test('setAdd/setRem：SADD/SREM 数组成员透传', async () => {
    const { mod, calls } = loadRedis()
    await mod.setAdd(CONN, { dbIndex: 0, key: 's', members: ['a', 'b'], readOnly: false })
    await mod.setRem(CONN, { dbIndex: 0, key: 's', members: 'a', readOnly: false })
    assert.deepEqual(Array.from(calls.sadd[0]), ['s', 'a', 'b'])
    assert.deepEqual(Array.from(calls.srem[0]), ['s', 'a'])
  })

  test('zsetAdd：score 数字/数字字符串强转；非有限数拒绝且不发命令', async () => {
    const { mod, calls } = loadRedis()
    await mod.zsetAdd(CONN, { dbIndex: 0, key: 'z', score: '1.5', member: 'a', readOnly: false })
    assert.deepEqual(Array.from(calls.zadd[0]), ['z', 1.5, 'a'])
    await assert.rejects(
      mod.zsetAdd(CONN, { dbIndex: 0, key: 'z', score: 'abc', member: 'a', readOnly: false }),
      /finite numeric score/
    )
    await assert.rejects(
      mod.zsetAdd(CONN, { dbIndex: 0, key: 'z', score: NaN, member: 'a', readOnly: false }),
      /finite numeric score/
    )
    assert.equal(calls.zadd.length, 1)
  })

  test('zsetRem：ZREM 数组成员透传', async () => {
    const { mod, calls } = loadRedis()
    await mod.zsetRem(CONN, { dbIndex: 0, key: 'z', members: ['a', 'b'], readOnly: false })
    assert.deepEqual(Array.from(calls.zrem[0]), ['z', 'a', 'b'])
  })

  test('listPush：left→LPUSH / right→RPUSH；非法 position 拒绝', async () => {
    const { mod, calls } = loadRedis()
    await mod.listPush(CONN, { dbIndex: 0, key: 'l', value: 'v', position: 'left', readOnly: false })
    await mod.listPush(CONN, { dbIndex: 0, key: 'l', value: 'w', position: 'right', readOnly: false })
    await assert.rejects(
      mod.listPush(CONN, { dbIndex: 0, key: 'l', value: 'v', position: 'up', readOnly: false }),
      /position left or right/
    )
    assert.deepEqual(Array.from(calls.lpush[0]), ['l', 'v'])
    assert.deepEqual(Array.from(calls.rpush[0]), ['l', 'w'])
    assert.equal(calls.lpush.length, 1)
  })

  test('listSetAt：整数下标透传；非整数拒绝；越界错误由 ioredis 冒泡', async () => {
    const { mod, calls } = loadRedis()
    await mod.listSetAt(CONN, { dbIndex: 0, key: 'l', index: -1, value: 'v', readOnly: false })
    assert.deepEqual(Array.from(calls.lset[0]), ['l', -1, 'v'])
    await assert.rejects(
      mod.listSetAt(CONN, { dbIndex: 0, key: 'l', index: 1.5, value: 'v', readOnly: false }),
      /integer index/
    )
    assert.equal(calls.lset.length, 1)
  })

  test('listRemAt：LREM 默认 count=1，count/元素透传', async () => {
    const { mod, calls } = loadRedis()
    await mod.listRemAt(CONN, { dbIndex: 0, key: 'l', index: 'v', readOnly: false })
    await mod.listRemAt(CONN, { dbIndex: 0, key: 'l', index: 'v', count: 0, readOnly: false })
    assert.deepEqual(Array.from(calls.lrem[0]), ['l', 1, 'v'])
    assert.deepEqual(Array.from(calls.lrem[1]), ['l', 0, 'v'])
  })

  test('renameKeyNx：成功返回 ok；冲突抛含 newKey 的可读错误', async () => {
    const { mod, calls } = loadRedis({ renamenxResults: [1, 0] })
    const ok = await mod.renameKeyNx(CONN, { dbIndex: 0, key: 'a', newKey: 'b', readOnly: false })
    assert.deepEqual({ ...ok }, { ok: true })
    await assert.rejects(
      mod.renameKeyNx(CONN, { dbIndex: 0, key: 'a', newKey: 'b', readOnly: false }),
      e => {
        assert.match(e.message, /target key already exists: b/)
        return true
      }
    )
    assert.equal(calls.renamenx.length, 2)
    assert.deepEqual(Array.from(calls.renamenx[0]), ['a', 'b'])
  })

  test('参数校验：空数组/空串/空 key/非法类型拒绝且不发 redis', async () => {
    const { mod, calls, totalCalls } = loadRedis()
    // vm-realm 抛出的 Error 不是宿主 Error 实例，只断言"有可读 message"
    const anyError = e => {
      assert.ok(typeof e.message === 'string' && e.message.length > 0)
      return true
    }
    const cases = [
      ['setAdd', { key: 's', members: [] }],
      ['setAdd', { key: 's', members: [''] }],
      ['setAdd', { key: 's', members: 123 }],
      ['setRem', { key: 's', members: [] }],
      ['hashDelField', { key: 'h', fields: [] }],
      ['zsetRem', { key: 'z', members: [] }],
      ['hashSetField', { key: 'h', field: '', value: 'v' }],
      ['hashSetField', { key: '', field: 'f', value: 'v' }],
      ['renameKeyNx', { key: 'a', newKey: '' }],
      ['listRemAt', { key: 'l', index: 'v', count: 'x' }]
    ]
    for (const [name, args] of cases) {
      await assert.rejects(
        mod[name](CONN, { dbIndex: 0, readOnly: false, ...args }),
        anyError,
        `${name}(${JSON.stringify(args)}) must reject`
      )
    }
    assert.equal(totalCalls(), 0, 'invalid params must never reach redis')
    assert.equal(calls.hset, undefined)
  })
})

// ------------------------------------------------ OP_MAP / OP_TIMEOUTS 契约（源码断言）

describe('D 批：OP_MAP / 超时契约（db-client/index.js 源码）', () => {
  const src = fs.readFileSync(INDEX_JS, 'utf8')

  test('mysql/postgres 注册 explainQuery，redis 不注册', () => {
    const mysqlBlock = src.slice(src.indexOf('mysql: {'), src.indexOf('postgres: {'))
    const pgBlock = src.slice(src.indexOf('postgres: {'), src.indexOf('redis: {'))
    const redisBlock = src.slice(src.indexOf('redis: {'), src.indexOf('function getAdapter'))
    assert.match(mysqlBlock, /explainQuery: 'explainQuery'/)
    assert.match(pgBlock, /explainQuery: 'explainQuery'/)
    assert.doesNotMatch(redisBlock, /explainQuery/, 'redis must not register explainQuery')
  })

  test('redis 注册 10 个类型化写 op', () => {
    const redisBlock = src.slice(src.indexOf('redis: {'), src.indexOf('function getAdapter'))
    for (const op of [
      'hashSetField', 'hashDelField', 'setAdd', 'setRem',
      'zsetAdd', 'zsetRem', 'listPush', 'listSetAt', 'listRemAt', 'renameKeyNx'
    ]) {
      assert.match(redisBlock, new RegExp(op + ": '" + op + "'"), `redis OP_MAP missing ${op}`)
    }
  })

  test('explainQuery 超时跟随 executeSql 口径（120s 分类表）', () => {
    assert.match(src, /explainQuery: 120000/)
    assert.match(src, /const opMs = OP_TIMEOUTS\[op\] \|\| OP_TIMEOUTS\.default/)
  })
})
