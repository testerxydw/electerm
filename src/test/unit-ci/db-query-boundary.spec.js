// T7 hasMore 边界回归：真实适配器源码 + vm 假驱动
//  - MySQL/PG 查询 pageSize + 1 行，只返回前 pageSize 行
//  - 恰好整页时 hasMore=false，多 1 行时 hasMore=true
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

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
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

const conn = { dbHost: 'h', dbPort: 5432, dbUser: 'u', dbPassword: 'p', dbName: 'd' }

// 假 mysql pool：按 rows 数量返回；记录 SQL
function makeMysql (rows, execResult = [[]]) {
  const calls = { queries: [], executes: [] }
  const pool = {
    async query (sql) {
      calls.queries.push(sql)
      return [rows]
    },
    async execute (sql, params) {
      calls.executes.push({ sql, params })
      return execResult
    }
  }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      'mysql2/promise': { createPool () { return pool } }
    },
    'mysql.js'
  )
  return { mod, calls }
}

// 假 pg Client：rowsOrFn 为数组时固定返回，为函数时按 SQL 路由；记录 SQL/参数
function makePostgres (rowsOrFn) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      if (typeof rowsOrFn === 'function') {
        return rowsOrFn(sql, params)
      }
      return { rows: rowsOrFn }
    }

    async end () {}
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client } },
    'postgres.js'
  )
  return { mod, calls }
}

const makeRows = n => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('T7 hasMore boundary: mysql', () => {
  test('恰好整页 → hasMore false，只回 pageSize 行', async () => {
    const { mod, calls } = makeMysql(makeRows(20))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, false)
    assert.match(calls.queries[0], /LIMIT 21 OFFSET 0/, '多取 1 行判定边界')
  })

  test('多 1 行 → hasMore true，多余行不返回', async () => {
    const { mod } = makeMysql(makeRows(21))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, true)
    assert.equal(res.rows[19].id, 19, '返回前 pageSize 行')
  })

  test('末页不足整页 → hasMore false', async () => {
    const { mod } = makeMysql(makeRows(5))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 3, pageSize: 20 })
    assert.equal(res.rows.length, 5)
    assert.equal(res.hasMore, false)
  })
})

describe('T11 exact row count', () => {
  test('mysql countRows 走限定表名并返回数字', async () => {
    const { mod, calls } = makeMysql([{ c: 1234 }])
    const res = await mod.countRows(conn, { database: 'db', table: 't' })
    assert.equal(res.count, 1234)
    assert.match(calls.queries[0], /SELECT COUNT\(\*\) AS c FROM `db`\.`t`/)
  })

  test('postgres countRows 限定 schema，默认 public', async () => {
    const { mod, calls } = makePostgres(() => ({ rows: [{ c: '42' }] }))
    const res = await mod.countRows(conn, { database: 'd', schema: 'analytics', table: 'events' })
    assert.equal(res.count, 42)
    assert.match(calls.queries[0].sql, /FROM "analytics"\."events"/)
    await mod.countRows(conn, { database: 'd', table: 't' })
    assert.match(calls.queries[1].sql, /FROM "public"\."t"/)
  })

  test('postgres 跨库计数拒绝', async () => {
    const { mod } = makePostgres(() => ({ rows: [{ c: 1 }] }))
    await assert.rejects(
      mod.countRows(conn, { database: 'other', table: 't' }),
      /cross-database/
    )
  })

  test('op 注册与超时：countRows 60s、redis 不注册', async () => {
    const INDEX = path.join(ROOT, 'src/app/lib/db-client/index.js')
    const src = fs.readFileSync(INDEX, 'utf8')
    const mapHits = src.match(/countRows: 'countRows'/g) || []
    assert.equal(mapHits.length, 2, 'mysql/postgres must register countRows')
    assert.match(src, /countRows: 60000/, 'countRows needs a 60s timeout')
    const redisMap = src.match(/redis: \{[\s\S]*?\n\s{2}\}/)[0]
    assert.ok(!redisMap.includes('countRows'), 'redis has no total row count')
  })

  test('前端点击才计数，切表/排序/页大小/刷新重置', async () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes("dbClientOp', tabId, 'countRows'"), 'must call countRows op')
    const resets = src.match(/resetExactRows\(\)/g) || []
    assert.ok(resets.length >= 4, 'expected reset on table/sort/pageSize/refresh, got ' + resets.length)
    assert.ok(src.includes('exactRows.value === null'), 'exact value replaces the estimate')
  })
})

describe('批次 E：MySQL 近似行数只在首页查询', () => {
  test('首页查 information_schema，翻页不再查', async () => {
    const { mod, calls } = makeMysql([{ id: 1 }], [[{ c: 10 }]])
    const p1 = await mod.getPageData(conn, { database: 'db', table: 't', page: 1, pageSize: 20 })
    assert.equal(p1.totalRows, 10)
    assert.equal(calls.executes.length, 1)
    const p2 = await mod.getPageData(conn, { database: 'db', table: 't', page: 2, pageSize: 20 })
    assert.equal(p2.totalRows, undefined)
    assert.equal(calls.executes.length, 1, 'page 2 must reuse the page-1 estimate')
  })

  test('前端翻页沿用上一页的近似值', () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes('page > 1 ? g.totalRows : undefined'), 'totalRows fallback missing')
  })
})

describe('T3 postgres schema hierarchy', () => {
  test('当前库返回 schema 层级，非当前库仍为空', async () => {
    const { mod } = makePostgres(sql => {
      if (/pg_database/.test(sql)) {
        return { rows: [{ datname: 'd' }, { datname: 'other' }] }
      }
      // F0：表清单改查 pg_class（pg_tables 没有视图），字段是 relname/relkind；
      // 那条 SQL 里也含 "JOIN pg_namespace"，必须先判 relkind 再判 schema
      if (/relkind/.test(sql)) {
        return {
          rows: [
            { schemaname: 'public', relname: 'users', relkind: 'r' },
            { schemaname: 'analytics', relname: 'events', relkind: 'r' },
            { schemaname: 'analytics', relname: 'events_view', relkind: 'v' }
          ]
        }
      }
      if (/pg_namespace/.test(sql)) {
        return { rows: [{ nspname: 'analytics' }, { nspname: 'public' }] }
      }
      return { rows: [] }
    })
    const meta = await mod.getMetadata(conn)
    assert.deepEqual([...meta].map(d => d.name), ['d', 'other'])
    assert.deepEqual([...meta[0].children].map(s => s.name), ['analytics', 'public'])
    assert.equal(meta[0].children[0].type, 'schema')
    assert.deepEqual(
      [...meta[0].children[0].children].map(t => [t.name, t.type]),
      [['events', 'table'], ['events_view', 'view']]
    )
    assert.deepEqual([...meta[0].children[1].children].map(t => t.name), ['users'])
    assert.deepEqual([...meta[1].children], [], '非当前库不展开')
  })

  test('空 schema 也保留在树中', async () => {
    const { mod } = makePostgres(sql => {
      if (/pg_database/.test(sql)) {
        return { rows: [{ datname: 'd' }] }
      }
      if (/relkind/.test(sql)) {
        return { rows: [{ schemaname: 'public', relname: 't', relkind: 'r' }] }
      }
      if (/pg_namespace/.test(sql)) {
        return { rows: [{ nspname: 'empty_schema' }, { nspname: 'public' }] }
      }
      return { rows: [] }
    })
    const meta = await mod.getMetadata(conn)
    assert.deepEqual([...meta[0].children].map(s => s.name), ['empty_schema', 'public'])
    assert.deepEqual([...meta[0].children[0].children], [])
  })

  test('getPageData 显式限定 schema，默认 public', async () => {
    const { mod, calls } = makePostgres(makeRows(1))
    await mod.getPageData(conn, { database: 'd', schema: 'analytics', table: 'events', page: 1, pageSize: 20 })
    assert.match(calls.queries[0].sql, /FROM "analytics"\."events"/)
    await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.match(calls.queries[1].sql, /FROM "public"\."t"/)
  })

  test('渲染层传递 schema 并生成 S 标记 / schema.table 标题', async () => {
    const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
    const src = fs.readFileSync(JSX, 'utf8')
    assert.ok(src.includes('const nodeKey = (database, schema, table)'), 'node key must carry 3 parts')
    const schemaArgs = src.match(/schema: target\.schema \|\| ''/g) || []
    assert.ok(schemaArgs.length >= 2, 'loadPage / findLastPage must pass schema')
    assert.ok(src.includes('db-tree-schema-mark'), 'schema node needs S mark')
    assert.ok(
      /sel\.schema \? `\$\{sel\.schema\}\.\$\{sel\.table\}`/.test(src),
      'grid title must show schema.table'
    )
  })
})

describe('T7 hasMore boundary: postgres', () => {
  test('恰好整页 → hasMore false，只回 pageSize 行', async () => {
    const { mod, calls } = makePostgres(makeRows(20))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 1, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, false)
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 0/)
  })

  test('多 1 行 → hasMore true，偏移按页计算', async () => {
    const { mod, calls } = makePostgres(makeRows(21))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 2, pageSize: 20 })
    assert.equal(res.rows.length, 20)
    assert.equal(res.hasMore, true)
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 20/)
  })

  test('末页不足整页 → hasMore false', async () => {
    const { mod } = makePostgres(makeRows(3))
    const res = await mod.getPageData(conn, { database: 'd', table: 't', page: 5, pageSize: 20 })
    assert.equal(res.hasMore, false)
  })
})

// ------------------------------------------------------------------ E2（只新增）
// 设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.3：
// getPageData 扩 where / whereParams / orderClauses / count，旧参数继续工作。
// 这几条用"记录 (sql, params)"的假驱动，验证参数是按顺序进第二个实参的
// —— 混进 SQL 字符串就等于把绑定退化成拼接，那正是这一轮要消灭的东西。

function makeMysqlCapture (rows, execResult = [[]]) {
  const calls = { queries: [], executes: [] }
  const pool = {
    async query (sql, params) {
      calls.queries.push({ sql, params })
      return [rows]
    },
    async execute (sql, params) {
      calls.executes.push({ sql, params })
      return execResult
    }
  }
  const mod = runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    {
      '../../common/log': LOG_STUB,
      'mysql2/promise': { createPool () { return pool } }
    },
    'mysql.js'
  )
  return { mod, calls }
}

function makePostgresCapture (rowsOrFn) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      if (typeof rowsOrFn === 'function') {
        return rowsOrFn(sql, params)
      }
      return { rows: rowsOrFn }
    }

    async end () {}
  }
  const mod = runInVm(
    fs.readFileSync(POSTGRES_JS, 'utf8'),
    { pg: { Client } },
    'postgres.js'
  )
  return { mod, calls }
}

describe('E2 mysql getPageData: where / orderClauses / count', () => {
  test('where 拼 WHERE 且参数按顺序进第二个实参', async () => {
    const { mod, calls } = makeMysqlCapture(makeRows(3))
    await mod.getPageData(conn, {
      database: 'db',
      table: 't',
      page: 1,
      pageSize: 20,
      where: '`age` >= ? AND `name` LIKE ?',
      whereParams: [18, '%bo%']
    })
    assert.match(
      calls.queries[0].sql,
      /SELECT \* FROM `db`\.`t` WHERE `age` >= \? AND `name` LIKE \?/
    )
    assert.deepEqual(calls.queries[0].params, [18, '%bo%'])
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 0/, 'LIMIT/OFFSET 仍是拼进的数字')
  })

  test('无 where 时 query 只收一个实参（不传空参数数组）', async () => {
    const { mod, calls } = makeMysqlCapture(makeRows(2))
    await mod.getPageData(conn, { database: 'db', table: 't', page: 1, pageSize: 20 })
    assert.equal(calls.queries[0].params, undefined)
  })

  test('orderClauses 优先于旧的单列 orderBy', async () => {
    const { mod, calls } = makeMysqlCapture(makeRows(2))
    await mod.getPageData(conn, {
      database: 'db',
      table: 't',
      page: 1,
      pageSize: 20,
      orderBy: 'id',
      order: 'descend',
      orderClauses: [{ column: 'name', desc: true }, { column: 'id', desc: false }]
    })
    assert.match(calls.queries[0].sql, /ORDER BY `name` DESC, `id` ASC/)
    assert.ok(!/`id` DESC/.test(calls.queries[0].sql), '旧单列排序不得叠加')
  })

  test('orderClauses 为空时退回旧的单列 orderBy', async () => {
    const { mod, calls } = makeMysqlCapture(makeRows(2))
    await mod.getPageData(conn, {
      database: 'db',
      table: 't',
      page: 1,
      pageSize: 20,
      orderBy: 'id',
      order: 'descend',
      orderClauses: []
    })
    assert.match(calls.queries[0].sql, /ORDER BY `id` DESC/)
  })

  test('count:true 只发一条 COUNT，返回 total 且不返回 rows', async () => {
    const { mod, calls } = makeMysqlCapture([{ c: '42' }])
    const res = await mod.getPageData(conn, {
      database: 'db',
      table: 't',
      where: '`age` >= ?',
      whereParams: [18],
      count: true
    })
    assert.equal(calls.queries.length, 1)
    assert.match(calls.queries[0].sql, /SELECT COUNT\(\*\) AS c FROM `db`\.`t` WHERE `age` >= \?/)
    assert.ok(!/LIMIT/.test(calls.queries[0].sql), 'COUNT 不带分页')
    assert.deepEqual(calls.queries[0].params, [18])
    assert.equal(res.total, 42)
    assert.equal(res.rows, undefined)
  })
})

describe('E2 postgres getPageData: where / orderClauses / count', () => {
  test('where 用 $n 占位符，参数按顺序传', async () => {
    const { mod, calls } = makePostgresCapture(makeRows(3))
    await mod.getPageData(conn, {
      database: 'd',
      schema: 'analytics',
      table: 'events',
      page: 1,
      pageSize: 20,
      where: '"age" >= $1 AND "name" LIKE $2',
      whereParams: [18, '%bo%']
    })
    assert.match(calls.queries[0].sql, /FROM "analytics"\."events" WHERE "age" >= \$1/)
    assert.deepEqual(calls.queries[0].params, [18, '%bo%'])
    assert.match(calls.queries[0].sql, /LIMIT 21 OFFSET 0/)
  })

  test('orderClauses 多列排序', async () => {
    const { mod, calls } = makePostgresCapture(makeRows(2))
    await mod.getPageData(conn, {
      database: 'd',
      table: 't',
      page: 1,
      pageSize: 20,
      orderClauses: [{ column: 'name', desc: true }, { column: 'id', desc: false }]
    })
    assert.match(calls.queries[0].sql, /ORDER BY "name" DESC, "id" ASC/)
  })

  test('count:true 只发一条 COUNT 并返回数字 total', async () => {
    const { mod, calls } = makePostgresCapture(() => ({ rows: [{ c: '7' }] }))
    const res = await mod.getPageData(conn, {
      database: 'd',
      table: 't',
      where: '"id" > $1',
      whereParams: [3],
      count: true
    })
    assert.equal(calls.queries.length, 1)
    assert.match(calls.queries[0].sql, /SELECT COUNT\(\*\) AS c FROM "public"\."t" WHERE "id" > \$1/)
    assert.ok(!/LIMIT/.test(calls.queries[0].sql))
    assert.equal(res.total, 7)
    assert.equal(res.rows, undefined)
  })
})

// ------------------------------- E2 分发层：主进程是条件体的校验权威（只新增）
// 适配器只能保证"条件拼得对"，拦不住"渲染层直接传一段手写 SQL"。
// 这里跑的是真实 index.js（vm + 桩适配器），验证被拒发生在**查询发出之前**。
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const SAFE_CLAUSE = require(path.join(ROOT, 'src/app/lib/db-client/safe-clause.js'))

function makeIndexModule (adapter) {
  const src = fs.readFileSync(INDEX_JS, 'utf8')
  const stubs = {
    '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
    '../../common/log': LOG_STUB,
    './redis': adapter,
    './mysql': adapter,
    './postgres': adapter,
    './safe-clause': SAFE_CLAUSE
  }
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
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'db-client/index.js' })
  return mod.exports
}

function makeBoundaryAdapter (columns, calls) {
  return {
    async acquire () {},
    async release () {},
    async getMetadata () {
      return []
    },
    async getTableStructure () {
      return { columns: columns.map(name => ({ name })) }
    },
    async getPageData (connArg, args) {
      calls.pageArgs = args
      return { rows: [] }
    }
  }
}

describe('E2 dbClientOp: 条件体校验在主进程', () => {
  const bookmark = id => ({ id, dbType: 'mysql', dbHost: '127.0.0.1', dbPort: 3306, name: 'n' })
  // 统一分页入参：只写关心的字段，避免每个用例重复堆 database/table/page
  const pageArgs = extra => Object.assign(
    { database: 'd', table: 't', page: 1, pageSize: 20 },
    extra
  )

  test('注入型 where 被拒，且根本没走到适配器', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter(['id', 'name'], calls))
    await mod.openDbTab(bookmark('e2-a'), null)
    await assert.rejects(
      mod.dbClientOp('e2-a', 'getPageData', pageArgs({
        where: '1=1; DROP TABLE t',
        whereParams: []
      })),
      /分号/
    )
    assert.equal(calls.pageArgs, undefined, '校验失败不得发出查询')
  })

  test('未知列被拒（列清单来自表结构缓存）', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter(['id', 'name'], calls))
    await mod.openDbTab(bookmark('e2-b'), null)
    await assert.rejects(
      mod.dbClientOp('e2-b', 'getPageData', pageArgs({
        where: '`nope` = ?',
        whereParams: [1]
      })),
      /不存在的列: nope/
    )
  })

  test('占位符数与参数数不一致被拒', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter(['id', 'name'], calls))
    await mod.openDbTab(bookmark('e2-c'), null)
    await assert.rejects(
      mod.dbClientOp('e2-c', 'getPageData', pageArgs({
        where: '`id` = ? AND `name` = ?',
        whereParams: [1]
      })),
      /占位符数量\(2\)与参数数量\(1\)不一致/
    )
  })

  test('排序列也要校验：未知列 / 表达式被拒', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter(['id', 'name'], calls))
    await mod.openDbTab(bookmark('e2-d'), null)
    await assert.rejects(
      mod.dbClientOp('e2-d', 'getPageData', pageArgs({
        orderClauses: [{ column: 'evil' }]
      })),
      /排序引用了不存在的列: evil/
    )
    await assert.rejects(
      mod.dbClientOp('e2-d', 'getPageData', pageArgs({
        orderClauses: [{ column: 'RAND()' }]
      })),
      /不能是表达式/
    )
  })

  test('合规条件放行并透传到适配器（参数原样）', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter(['id', 'name'], calls))
    await mod.openDbTab(bookmark('e2-e'), null)
    await mod.dbClientOp('e2-e', 'getPageData', pageArgs({
      where: '`id` = ?',
      whereParams: [5],
      orderClauses: [{ column: 'name', desc: true }]
    }))
    assert.equal(calls.pageArgs.where, '`id` = ?')
    assert.deepEqual(calls.pageArgs.whereParams, [5])
    assert.deepEqual(calls.pageArgs.orderClauses, [{ column: 'name', desc: true }])
  })

  test('拿不到列信息时拒绝条件查询（不放行空白名单）', async () => {
    const calls = {}
    const mod = makeIndexModule(makeBoundaryAdapter([], calls))
    await mod.openDbTab(bookmark('e2-f'), null)
    await assert.rejects(
      mod.dbClientOp('e2-f', 'getPageData', pageArgs({
        where: '`id` = ?',
        whereParams: [1]
      })),
      /无法获取列信息，条件查询已拒绝/
    )
  })

  test('redis 整体跳过校验（SCAN 语义没有 where，也没有表结构）', async () => {
    const calls = {}
    const redisAdapter = {
      async acquire () {},
      async release () {},
      async getMetadata () {
        return []
      },
      async getPageData (connArg, args) {
        calls.pageArgs = args
        return { keys: [] }
      }
    }
    const mod = makeIndexModule(redisAdapter)
    await mod.openDbTab({ id: 'e2-r', dbType: 'redis', dbHost: 'h', dbPort: 6379, name: 'r' }, null)
    const res = await mod.dbClientOp('e2-r', 'getPageData', { where: 'not sql at all' })
    assert.equal(res.keys.length, 0)
    assert.equal(calls.pageArgs.where, 'not sql at all')
    assert.equal(typeof redisAdapter.getTableStructure, 'undefined', 'redis 不该走结构查询')
  })
})
