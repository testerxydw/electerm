// S3-A B1 行级写入：真实适配器源码 + vm 假驱动
//  - insertRow：列清单由 values keys 生成、占位符绑定、只读/空列拦截
//  - deleteRows：主键 IN 定位、空数组/超 200/无主键列拦截、只读拦截
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const POSTGRES_JS = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

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

const conn = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbPassword: 'p', dbName: 'd' }

function makeMysql (executeResult) {
  const calls = { executes: [] }
  const pool = {
    async query () {
      return [[]]
    },
    async execute (sql, params) {
      calls.executes.push({ sql, params })
      return [executeResult || { affectedRows: 1, insertId: 7 }]
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

function makePostgres (queryResult) {
  const calls = { queries: [] }
  class Client {
    constructor (opts) {
      this.database = opts.database
    }

    async connect () {}

    async query (sql, params) {
      calls.queries.push({ sql, params })
      return queryResult || { rowCount: 1 }
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

describe('B1 insertRow: mysql', () => {
  test('SQL 形状与占位符绑定', async () => {
    const { mod, calls } = makeMysql()
    const res = await mod.insertRow(conn, {
      database: 'db',
      table: 't',
      values: { name: "O'Neil", age: 3, note: null },
      readOnly: false
    })
    assert.equal(calls.executes.length, 1)
    assert.equal(
      calls.executes[0].sql,
      'INSERT INTO `db`.`t` (`name`, `age`, `note`) VALUES (?, ?, ?)'
    )
    // vm 里的数组原型与宿主不同，先摊平再比较
    assert.deepEqual([...calls.executes[0].params], ["O'Neil", 3, null])
    assert.equal(res.affected, 1)
    assert.equal(res.insertId, 7)
  })

  test('undefined 值归一为 null', async () => {
    const { mod, calls } = makeMysql()
    await mod.insertRow(conn, {
      database: 'db', table: 't', values: { a: undefined, b: 'x' }, readOnly: false
    })
    assert.deepEqual([...calls.executes[0].params], [null, 'x'])
  })

  test('空 values 拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.insertRow(conn, { database: 'db', table: 't', values: {}, readOnly: false }),
      /requires at least one column value/
    )
  })

  test('readOnly 拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.insertRow(conn, { database: 'db', table: 't', values: { a: 1 }, readOnly: true }),
      /read-only mode/
    )
  })
})

describe('B1 deleteRows: mysql', () => {
  test('主键 IN 占位符定位', async () => {
    const { mod, calls } = makeMysql()
    const res = await mod.deleteRows(conn, {
      database: 'db', table: 't', pkColumn: 'id', pkValues: [1, 2, 3], readOnly: false
    })
    assert.equal(
      calls.executes[0].sql,
      'DELETE FROM `db`.`t` WHERE `id` IN (?, ?, ?)'
    )
    assert.deepEqual([...calls.executes[0].params], [1, 2, 3])
    assert.equal(res.affected, 1)
  })

  test('无库前缀时仅表名', async () => {
    const { mod, calls } = makeMysql()
    await mod.deleteRows(conn, {
      table: 't', pkColumn: 'id', pkValues: [1], readOnly: false
    })
    assert.match(calls.executes[0].sql, /^DELETE FROM `t` WHERE/)
  })

  test('空 pkValues 拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'db', table: 't', pkColumn: 'id', pkValues: [], readOnly: false
      }),
      /requires at least one primary key value/
    )
  })

  test('超过 200 行拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'db',
        table: 't',
        pkColumn: 'id',
        pkValues: Array.from({ length: 201 }, (_, i) => i),
        readOnly: false
      }),
      /up to 200 rows/
    )
  })

  test('无主键列拒绝（引导走 SQL 页）', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'db', table: 't', pkColumn: '', pkValues: [1], readOnly: false
      }),
      /no-pk table, use SQL page/
    )
  })

  test('readOnly 拒绝', async () => {
    const { mod } = makeMysql()
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'db', table: 't', pkColumn: 'id', pkValues: [1], readOnly: true
      }),
      /read-only mode/
    )
  })
})

describe('B1 insertRow/deleteRows: postgres', () => {
  test('insertRow $n 占位符 + 默认 public schema', async () => {
    const { mod, calls } = makePostgres()
    const res = await mod.insertRow(conn, {
      database: 'd',
      table: 't',
      values: { name: 'a', age: 2 },
      readOnly: false
    })
    assert.equal(
      calls.queries[0].sql,
      'INSERT INTO "public"."t" ("name", "age") VALUES ($1, $2)'
    )
    assert.deepEqual([...calls.queries[0].params], ['a', 2])
    assert.equal(res.affected, 1)
  })

  test('insertRow 显式 schema', async () => {
    const { mod, calls } = makePostgres()
    await mod.insertRow(conn, {
      database: 'd', schema: 'mys', table: 't', values: { a: 1 }, readOnly: false
    })
    assert.match(calls.queries[0].sql, /^INSERT INTO "mys"\."t"/)
  })

  test('insertRow 空值拒绝 + 跨库拒绝', async () => {
    const { mod } = makePostgres()
    await assert.rejects(
      mod.insertRow(conn, { database: 'd', table: 't', values: {}, readOnly: false }),
      /requires at least one column value/
    )
    await assert.rejects(
      mod.insertRow(conn, {
        database: 'd2', table: 't', values: { a: 1 }, readOnly: false
      }),
      /cross-database/
    )
  })

  test('deleteRows $n 占位符 IN', async () => {
    const { mod, calls } = makePostgres()
    await mod.deleteRows(conn, {
      database: 'd',
      schema: 'mys',
      table: 't',
      pkColumn: 'user id',
      pkValues: [10, 20],
      readOnly: false
    })
    assert.equal(
      calls.queries[0].sql,
      'DELETE FROM "mys"."t" WHERE "user id" IN ($1, $2)'
    )
    assert.deepEqual([...calls.queries[0].params], [10, 20])
  })

  test('deleteRows 空 pkValues / 超 200 / 无主键列 / 只读 拒绝', async () => {
    const { mod } = makePostgres()
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'd', table: 't', pkColumn: 'id', pkValues: [], readOnly: false
      }),
      /requires at least one primary key value/
    )
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'd',
        table: 't',
        pkColumn: 'id',
        pkValues: Array.from({ length: 201 }, (_, i) => i),
        readOnly: false
      }),
      /up to 200 rows/
    )
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'd', table: 't', pkColumn: '', pkValues: [1], readOnly: false
      }),
      /no-pk table, use SQL page/
    )
    await assert.rejects(
      mod.deleteRows(conn, {
        database: 'd', table: 't', pkColumn: 'id', pkValues: [1], readOnly: true
      }),
      /read-only mode/
    )
  })
})

describe('B1 wiring: OP_MAP 注册', () => {
  test('mysql 与 postgres 适配器均注册 insertRow/deleteRows', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    assert.equal((src.match(/insertRow: 'insertRow'/g) || []).length, 2)
    assert.equal((src.match(/deleteRows: 'deleteRows'/g) || []).length, 2)
    // redis 不得注册写行 op
    const redisBlock = src.match(/redis: \{[\s\S]*?\n {2}\}/)
    assert.ok(redisBlock, 'redis op block not found')
    assert.ok(!redisBlock[0].includes('insertRow'))
    assert.ok(!redisBlock[0].includes('deleteRows'))
  })
})

const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// 从 jsx 源码切出模块级纯函数（无 JSX 依赖）后在沙箱求值
function extractFn (src, name) {
  const start = src.indexOf(`const ${name} =`)
  assert.ok(start >= 0, `${name} not found`)
  const end = src.indexOf('\n}', start)
  assert.ok(end > start, `${name} body not closed`)
  const code = src.slice(start, end + 2)
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(`(function () { ${code}; return ${name} })()`, sandbox)
}

describe('B1 wiring: renderer 接线', () => {
  const src = fs.readFileSync(JSX, 'utf8')

  test('前端走 insertRow/deleteRows op', () => {
    assert.ok(src.includes("dbClientOp', tabId, 'insertRow'"), 'must call insertRow op')
    assert.ok(src.includes("dbClientOp', tabId, 'deleteRows'"), 'must call deleteRows op')
    // 删除只传主键值，不传整行数据
    assert.ok(src.includes('pkValues'), 'delete must send pkValues')
  })

  test('rowSelection 仅主数据网格透传一次', () => {
    assert.equal((src.match(/rowSelection=\{rowSelection\}/g) || []).length, 1)
    // 重新取数（切表/翻页/刷新）必须清空选中
    const block = src.match(/const loadPage = [\s\S]*?\n {2}\}/)
    assert.ok(block, 'loadPage not found')
    assert.ok(block[0].includes('setSelectedRowKeys([])'), 'loadPage must clear row selection')
  })

  test('删除入口受 只读+主键+选中数 门控', () => {
    const block = src.match(/B1 删除选中[\s\S]*?: null\n {8}\}/)
    assert.ok(block, 'delete button block not found')
    assert.ok(block[0].includes('!isReadonly'))
    assert.ok(block[0].includes('pkColumn'))
    assert.ok(block[0].includes('selectedRowKeys.length'))
    assert.ok(block[0].includes('Popconfirm'), 'must double confirm')
  })

  test('buildInsertFormColumns 归一化两引擎列定义', () => {
    const fn = extractFn(src, 'buildInsertFormColumns')
    const mysqlCols = fn([
      { Field: 'id', Type: 'int(11)', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment' },
      { Field: 'name', Type: 'varchar(255)', Null: 'YES', Key: '', Default: null, Extra: '' }
    ], 'mysql')
    assert.equal(mysqlCols.length, 2)
    assert.deepEqual(
      { name: mysqlCols[0].name, isPk: mysqlCols[0].isPk, isAutoInc: mysqlCols[0].isAutoInc, isNumeric: mysqlCols[0].isNumeric },
      { name: 'id', isPk: true, isAutoInc: true, isNumeric: true }
    )
    assert.equal(mysqlCols[1].isPk, false)
    assert.equal(mysqlCols[1].isNumeric, false)

    const pgCols = fn([
      { column_name: 'id', data_type: 'integer', is_primary_key: true, column_default: "nextval('t_id_seq'::regclass)" },
      { column_name: 'body', data_type: 'text', is_primary_key: false, column_default: null }
    ], 'postgres')
    assert.equal(pgCols[0].isPk, true)
    assert.equal(pgCols[0].isAutoInc, true)
    assert.equal(pgCols[0].isNumeric, true)
    assert.equal(pgCols[1].isPk, false)
    assert.equal(pgCols[1].isAutoInc, false)
  })

  test('新词条 en/zh_cn 两区同步', () => {
    const loc = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbAddRow', 'dbDeleteRows', 'dbDeleteRowsConfirm', 'dbInsertRowTitle', 'dbAutoInc', 'dbAffected', 'dbCopyAs', 'dbCopyInsert', 'dbCopyUpdate', 'dbCopyTsv', 'dbExportSql']) {
      assert.equal((loc.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 2, `${k} must exist in both locales`)
    }
  })

  test('A4 导出菜单接线', () => {
    assert.ok(src.includes("e('dbExportSql')"), 'grid export menu must have SQL item')
    // 两处导出按钮均为 Dropdown（网格 + SQL 结果）
    assert.ok(src.includes('exportGridAs'), 'grid export json/sql dispatcher missing')
    assert.ok(src.includes('exportSqlJson'), 'sql result json export missing')
    assert.ok(src.includes('downloadText'), 'downloadText helper must be used')
    // 导出范围同拍板语义：有选中为选中
    assert.ok(src.includes('gridExportRows'), 'shared export rows helper missing')
  })

  test('A2 DDL 入口 mysql 系显示 / PG 隐藏', () => {
    // 走 executeSql op，SHOW CREATE TABLE 语句拼接
    assert.ok(src.includes('SHOW CREATE TABLE'), 'must use SHOW CREATE TABLE')
    assert.ok(src.includes("'Create Table'") && src.includes("'Create View'"), 'must read Create Table/View')
    // 入口块带 !isPg 门控（PG 隐藏）
    const block = src.match(/A2 DDL 入口[\s\S]*?: null\n {6}\}/)
    assert.ok(block, 'ddl entry block not found')
    assert.ok(block[0].includes('!isPg'), 'entry must be gated by !isPg')
    // 词条两区同步
    const loc = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbViewDdl', 'dbDdlNotFound']) {
      assert.equal((loc.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 2, `${k} must exist in both locales`)
    }
  })

  test('A3/A5 词条两区同步', () => {
    const loc = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbFormatSql', 'dbQuickConnect', 'dbQuickConnectPlaceholder', 'dbQuickConnectTip']) {
      assert.equal((loc.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 2, `${k} must exist in both locales`)
    }
  })
})
