// 空表估算行数复核（mysql 适配器）
//
// information_schema.TABLES.TABLE_ROWS 是统计估算，MariaDB/InnoDB 对**空表**会回 1。
// 用户实机（MariaDB 10.3，2026-11-05）看到数据页状态行自相矛盾成
// 「本页 0 行 · 总行数（约）: 1」，同一个数还被数据字典导出与 AI 工具读走。
// 改口放在主进程取数处（mysql.js confirmEmpty）：估算落在 0..1 这一档时补一次
// `SELECT 1 … LIMIT 1`，探不到行就是确定的空表 → 0。界面只翻译回传值，不自己推断。
//
// 这份 spec 用 vm + 假 pool 跑真实适配器源码，钉的是复核的**边界**：
//   什么时候多发消息（只有 0..1 这一档）、什么时候绝不改口（视图 / 未统计 / 复核失败）、
//   以及"复核只会把数字变得更准"（有行的表不能被打成 0）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const TYPE_NORM = require(path.join(ROOT, 'src/app/common/db-type-normalize.js'))
// getTableStructure 里惰性 require 的 './structure-v2'：vm 的未知 require 会转交宿主，
// 而相对路径是按**测试文件**目录解析的（会找不到），所以显式给真实模块
const STRUCTURE_V2 = require(path.join(ROOT, 'src/app/lib/db-client/structure-v2.js'))

const CONN = { dbHost: 'h', dbPort: 1, dbUser: 'u', dbPassword: 'p', dbName: 'demo_db' }

/**
 * 假 pool。cfg 控制三件独立的事：
 * @param {Object}   cfg
 * @param {*}        cfg.approx      TABLE_ROWS 回传值（1 / 0 / 120000 / null）；undefined = 查不到这一行
 * @param {Array}    cfg.probeRows   `SELECT 1 … LIMIT 1` 的回执（[] 表示表确实空）
 * @param {Array}    cfg.pageRows    取页回执
 * @param {Object}   cfg.table       information_schema.TABLES 那一条结构行的形状（getTableStructure 用）
 * @param {boolean}  cfg.approxThrow 读 information_schema 就失败
 * @param {boolean}  cfg.probeThrow  复核那一条 LIMIT 1 失败（例如对该表没有 SELECT 权限）
 */
function makePool (cfg) {
  const queries = []
  return {
    queries,
    sqls: () => queries.map(q => q.sql.replace(/\s+/g, ' ').trim()),
    async execute (sql) {
      queries.push({ via: 'execute', sql })
      if (/information_schema\.TABLES/.test(sql)) {
        if (cfg.approxThrow) {
          throw new Error('mock: information_schema denied')
        }
        return [cfg.approx === undefined ? [] : [{ c: cfg.approx }]]
      }
      throw new Error('mock: unexpected execute ' + sql)
    },
    async query (sql) {
      queries.push({ via: 'query', sql })
      if (/^SELECT 1 AS x FROM/.test(sql)) {
        if (cfg.probeThrow) {
          throw new Error('mock: no SELECT on table')
        }
        return [cfg.probeRows || []]
      }
      if (/^SELECT \* FROM/.test(sql)) {
        return [cfg.pageRows || []]
      }
      if (/information_schema\.COLUMNS/.test(sql)) {
        return [[{
          ORDINAL_POSITION: 1,
          COLUMN_NAME: 'id',
          DATA_TYPE: 'int',
          COLUMN_TYPE: 'int(11)',
          IS_NULLABLE: 'NO',
          COLUMN_DEFAULT: null,
          CHARACTER_MAXIMUM_LENGTH: null,
          CHARACTER_OCTET_LENGTH: null,
          COLUMN_COMMENT: '',
          COLUMN_KEY: 'PRI'
        }]]
      }
      if (/information_schema\.STATISTICS/.test(sql)) {
        return [[{
          INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id', INDEX_TYPE: 'BTREE'
        }]]
      }
      if (/KEY_COLUMN_USAGE/.test(sql)) {
        return [[]]
      }
      if (/information_schema\.TABLES/.test(sql)) {
        return [[cfg.table || { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 0, ENGINE: 'InnoDB' }]]
      }
      throw new Error('mock: unexpected query ' + sql)
    },
    async end () {}
  }
}

function loadMysql (pool) {
  const src = fs.readFileSync(JS, 'utf8')
  const stubs = {
    '../../common/log': { debug () {}, info () {}, warn () {}, error () {} },
    '../../common/db-type-normalize': TYPE_NORM,
    './structure-v2': STRUCTURE_V2,
    'mysql2/promise': { createPool () { return pool } }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: spec => stubs[spec] || require(spec)
  }
  vm.runInNewContext(src, sandbox, { filename: 'mysql.js' })
  return sandbox.module.exports
}

const probeCount = pool => pool.sqls().filter(s => /^SELECT 1 AS x FROM/.test(s)).length

describe('mysql getPageData: 空表估算复核', () => {
  test('估算 1 且探不到行 → 回 0，状态行不再自相矛盾', async () => {
    const pool = makePool({ approx: 1, probeRows: [], pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_empty', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, 0, '空表必须落回确定的 0')
    assert.equal(res.rows.length, 0)
    assert.equal(res.hasMore, false)
    assert.equal(probeCount(pool), 1, '只多发一条 LIMIT 1')
  })

  test('估算 1 但探到了行 → 保留 1（复核不能把有数据的表说成空）', async () => {
    const pool = makePool({ approx: 1, probeRows: [{ x: 1 }], pageRows: [{ id: 1 }] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_one', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, 1)
  })

  test('估算 0 → 不发消息也不改形状（本来就是 0）', async () => {
    const pool = makePool({ approx: 0, probeRows: [], pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_zero', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, 0)
    assert.equal(probeCount(pool), 1, '0 也在 0..1 这一档，复核一次坐实')
  })

  test('估算大于 1 → 不复核：大表不为此多一次往返', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    const pool = makePool({ approx: 120000, pageRows: rows })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_big', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, 120000, '有数据的表保留估算值')
    assert.equal(probeCount(pool), 0, '不该发复核')
  })

  test('TABLE_ROWS 为 NULL（未统计）→ 仍是 undefined，不判成 0 也不复核', async () => {
    const pool = makePool({ approx: null, pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_view', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, undefined, '"不知道"不能被说成"0 行"')
    assert.equal(probeCount(pool), 0)
  })

  test('information_schema 查不到这一行 → undefined（表不存在与空表两种口径不混）', async () => {
    const pool = makePool({ pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_missing', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, undefined)
    assert.equal(probeCount(pool), 0)
  })

  test('复核失败（对该表没有 SELECT 权限）→ 保留估算，取页照常成功', async () => {
    const pool = makePool({ approx: 1, probeThrow: true, pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_nolimit', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, 1, '一次计数失败不能把取页打成错误')
    assert.equal(res.rows.length, 0)
  })

  test('读不到 information_schema → undefined（原行为不变）', async () => {
    const pool = makePool({ approxThrow: true, pageRows: [] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_denied', page: 1, pageSize: 50
    })
    assert.equal(res.totalRows, undefined)
  })

  test('翻页不查估算，也就不复核', async () => {
    const pool = makePool({ approx: 1, probeRows: [], pageRows: [{ id: 1 }] })
    const res = await loadMysql(pool).getPageData(CONN, {
      database: 'demo_db', table: 't_p2', page: 2, pageSize: 50
    })
    assert.equal(res.totalRows, undefined)
    assert.equal(probeCount(pool), 0)
  })

  test('复核带库前缀：查的就是刚取页那张表', async () => {
    const pool = makePool({ approx: 1, probeRows: [], pageRows: [] })
    await loadMysql(pool).getPageData(CONN, {
      database: 'other_db', table: 't_x', page: 1, pageSize: 50
    })
    const probe = pool.sqls().find(s => /^SELECT 1 AS x FROM/.test(s))
    assert.equal(probe, 'SELECT 1 AS x FROM `other_db`.`t_x` LIMIT 1')
  })
})

describe('mysql getTableStructure: 估算行数同一条复核', () => {
  const struct = async cfg => {
    const pool = makePool(cfg)
    const res = await loadMysql(pool).getTableStructure(CONN, { database: 'demo_db', table: 't' })
    return { res, pool }
  }

  test('BASE TABLE 估算 1 + 探不到行 → estimatedRows 0', async () => {
    const { res, pool } = await struct({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '任务表', TABLE_ROWS: 1, ENGINE: 'InnoDB' },
      probeRows: []
    })
    assert.equal(res.estimatedRows, 0)
    assert.equal(probeCount(pool), 1)
    assert.equal(res.comment, '任务表', '复核不该顺手改掉别的字段')
  })

  test('BASE TABLE 估算 1 + 探到有行 → 保留 1', async () => {
    const { res } = await struct({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 1, ENGINE: 'InnoDB' },
      probeRows: [{ x: 1 }]
    })
    assert.equal(res.estimatedRows, 1)
  })

  test('VIEW 不复核：LIMIT 1 会真的执行视图定义', async () => {
    const { res, pool } = await struct({
      table: { TABLE_TYPE: 'VIEW', TABLE_COMMENT: 'VIEW', TABLE_ROWS: 1, ENGINE: null },
      probeRows: [{ x: 1 }]
    })
    assert.equal(probeCount(pool), 0, '一条都不该发')
    assert.equal(res.type, 'view')
  })

  test('BASE TABLE 但 TABLE_ROWS 为 NULL（未统计）→ null，不被复核改成 0', async () => {
    const { res, pool } = await struct({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: null, ENGINE: 'InnoDB' }
    })
    assert.equal(res.estimatedRows, null, '"未统计"与"0 行"是两件事')
    assert.equal(probeCount(pool), 0)
  })

  test('BASE TABLE 估算 1234 → 原样透传，不发消息', async () => {
    const { res, pool } = await struct({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '', TABLE_ROWS: 1234, ENGINE: 'InnoDB' }
    })
    assert.equal(res.estimatedRows, 1234)
    assert.equal(probeCount(pool), 0)
  })

  test('复核失败 → 保留估算，结构其余部分照常回', async () => {
    const { res, pool } = await struct({
      table: { TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: '任务表', TABLE_ROWS: 1, ENGINE: 'InnoDB' },
      probeThrow: true
    })
    assert.equal(res.estimatedRows, 1)
    assert.equal(probeCount(pool), 1, '复核发了出去，只是失败被吞掉')
    assert.equal(res.columns.length, 1)
    assert.equal(res.indexes.length, 1)
  })
})
