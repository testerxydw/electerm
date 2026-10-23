// A-3：SQL 补全引擎（L1 词法 + L2 源解析 + L3 场景/候选）
//
// 引擎是纯函数、零依赖，所以这里直测逻辑本身，不经过 CM6（node 环境没有 DOM）。
// 断言重点放在"错一次就会静默给错候选"的地方：
// 字符串/注释内的分号与关键字、引号前缀的替换起点、方言串味、排他类目为空时的降级。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '../../..')
const DIALECTS = path.join(ROOT, 'src/client/common/sql-dialects.js')
const COMPLETE = path.join(ROOT, 'src/client/common/db-sql-complete.js')

function load () {
  const strip = p => fs.readFileSync(p, 'utf8').replace(/^export /gm, '')
  const src = `${strip(DIALECTS)}\n${strip(COMPLETE)}`
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(
    `(function () { ${src};
      return {
        dialectMap, getDialect,
        maskSqlLiterals, literalAt, statementSpanAt, parseTrailingIdentifier,
        scanCtes, extractSources, classifyContext, buildCompletions, flattenTables, KIND_PRIORITY
      }
    })()`,
    sandbox
  )
}

const api = load()
const mysql = api.getDialect('mysql')
const pg = api.getDialect('postgres')

// 光标用 ⟨⟩ 标记，省得每处手数偏移
function at (sql) {
  const cursor = sql.indexOf('|')
  return { text: sql.slice(0, cursor) + sql.slice(cursor + 1), cursor }
}

function ctxOf (sql, dialect) {
  const { text, cursor } = at(sql)
  return api.classifyContext(text, cursor, { dialect: dialect || mysql })
}

function labels (res) {
  return (res ? res.options : []).map(o => o.label)
}

// vm 沙箱里造出来的数组原型与宿主不同，assert.deepEqual 会报
// "same structure but not reference-equal" —— 先搬回宿主 realm 再比
const arr = v => Array.from(v)

// ------------------------------------------------------------ L1 词法

describe('L1 词法：注释与字符串掩码', () => {
  test('掩码后与原文等长（位置可直接互用）', () => {
    const text = "SELECT 'a', `b` -- x\nFROM t"
    const { masked } = api.maskSqlLiterals(text, mysql)
    assert.equal(masked.length, text.length)
  })

  test('行注释被抹平，换行保留（行号不变）', () => {
    const text = 'SELECT 1 -- FROM users\nFROM t'
    const { masked } = api.maskSqlLiterals(text, mysql)
    assert.ok(!masked.includes('users'))
    assert.equal(masked.split('\n').length, 2)
  })

  test('MySQL：--1 不是注释（减负数）', () => {
    const text = 'SELECT 1 --1'
    const { literals } = api.maskSqlLiterals(text, mysql)
    assert.equal(literals.filter(l => l.kind === 'comment').length, 0)
  })

  test('PostgreSQL：--1 是注释（无空白要求）', () => {
    const text = 'SELECT 1 --1'
    const { literals } = api.maskSqlLiterals(text, pg)
    assert.equal(literals.filter(l => l.kind === 'comment').length, 1)
  })

  test('MySQL：# 是行注释', () => {
    const { literals } = api.maskSqlLiterals('SELECT 1 # FROM x', mysql)
    assert.equal(literals.filter(l => l.kind === 'comment').length, 1)
  })

  test('PostgreSQL：# 不是注释（不吞后续）', () => {
    const { literals } = api.maskSqlLiterals('SELECT 1 # FROM x', pg)
    assert.equal(literals.filter(l => l.kind === 'comment').length, 0)
  })

  test('块注释跨行且长度不变', () => {
    const text = 'SELECT /* a\nb */ 1'
    const { masked } = api.maskSqlLiterals(text, mysql)
    assert.equal(masked.length, text.length)
    assert.ok(!masked.includes('a\nb'))
    assert.equal(masked.split('\n').length, 2)
  })

  test('字符串里的分号被掩（不影响语句切分）', () => {
    const { masked } = api.maskSqlLiterals("SELECT 'a;b' FROM t", mysql)
    assert.equal(masked.indexOf(';'), -1)
  })

  test("单引号双写转义 'it''s' 整体当字符串", () => {
    const text = "SELECT 'it''s ok' FROM t"
    const { literals } = api.maskSqlLiterals(text, mysql)
    assert.equal(literals[0].kind, 'string')
    assert.equal(text.slice(literals[0].from, literals[0].to), "'it''s ok'")
  })

  test('MySQL 字符串吃反斜杠转义', () => {
    const text = "SELECT 'a\\'b' FROM t"
    const { literals } = api.maskSqlLiterals(text, mysql)
    assert.equal(text.slice(literals[0].from, literals[0].to), "'a\\'b'")
  })

  test('PostgreSQL 不吃反斜杠转义（C:\\path 正常闭合）', () => {
    const text = "SELECT 'C:\\path' FROM t"
    const { literals } = api.maskSqlLiterals(text, pg)
    assert.equal(text.slice(literals[0].from, literals[0].to), "'C:\\path'")
  })

  test('反引号标识符被掩（内含 ; 也不切语句）', () => {
    const text = 'SELECT `a;b` FROM t'
    const { masked } = api.maskSqlLiterals(text, mysql)
    assert.equal(masked.indexOf(';'), -1)
  })

  test('PG dollar quote 整体当字符串', () => {
    const text = 'SELECT $$a;b$$ FROM t'
    const { masked } = api.maskSqlLiterals(text, pg)
    assert.equal(masked.indexOf(';'), -1)
  })

  test('literalAt 边界：起点不算在内，终点算在内', () => {
    const { literals } = api.maskSqlLiterals("'ab'", mysql)
    assert.equal(api.literalAt(literals, 0), null, '起点是引号本身，光标不会停在那')
    assert.ok(api.literalAt(literals, 3), '终点（已进字符串）应命中')
    assert.equal(api.literalAt(literals, 4), null, '闭合引号之后已在字符串外')
  })
})

describe('L1 词法：语句切分与尾随标识符', () => {
  test('多语句按 ; 切分，光标在第二条时只看第二条', () => {
    const { text, cursor } = at('SELECT 1; SELECT * FROM us|')
    const { masked } = api.maskSqlLiterals(text, mysql)
    const span = api.statementSpanAt(masked, cursor)
    assert.equal(text.slice(span.from, span.to).trim(), 'SELECT * FROM us')
  })

  test('字符串内的分号不切语句', () => {
    const { text, cursor } = at("SELECT ';' FROM us|")
    const { masked } = api.maskSqlLiterals(text, mysql)
    const span = api.statementSpanAt(masked, cursor)
    assert.equal(span.from, 0)
  })

  test('普通前缀：from users 后的 us', () => {
    const { text, cursor } = at('SELECT * FROM us|')
    const r = api.parseTrailingIdentifier(text, cursor, mysql)
    assert.equal(r.prefix, 'us')
    assert.equal(r.from, 14)
    assert.equal(r.quoted, false)
    assert.equal(r.qualifier.length, 0)
  })

  test('限定前缀 u. → qualifier=[u]、prefix 为空', () => {
    const { text, cursor } = at('WHERE u.|')
    const r = api.parseTrailingIdentifier(text, cursor, mysql)
    assert.equal(r.prefix, '')
    assert.deepEqual(arr(r.qualifier), ['u'])
    assert.equal(r.from, cursor)
  })

  test('两级限定 schema.table. → qualifier 两级', () => {
    const { text, cursor } = at('SELECT db.users.|')
    const r = api.parseTrailingIdentifier(text, cursor, mysql)
    assert.deepEqual(arr(r.qualifier), ['db', 'users'])
    assert.equal(r.prefix, '')
  })

  test('u.na 同时给出 qualifier 与 prefix', () => {
    const { text, cursor } = at('WHERE u.na|')
    const r = api.parseTrailingIdentifier(text, cursor, mysql)
    assert.deepEqual(arr(r.qualifier), ['u'])
    assert.equal(r.prefix, 'na')
  })

  test('未闭合反引号：start 跳过引号（§4.6 引号前缀坑的根因）', () => {
    const { text, cursor } = at('SELECT * FROM `us|')
    const r = api.parseTrailingIdentifier(text, cursor, mysql)
    assert.equal(r.quoted, true)
    assert.equal(r.quoteChar, '`')
    assert.equal(r.prefix, 'us')
    assert.equal(r.from, text.indexOf('`') + 1, 'from 必须跳过反引号，否则候选全被过滤')
  })

  test('已闭合的双引号标识符内容被正确取出（PG 的引号是双引号）', () => {
    const { text, cursor } = at('SELECT * FROM "abc"|')
    const r = api.parseTrailingIdentifier(text, cursor, pg)
    assert.equal(r.prefix, 'abc')
    assert.equal(r.quoted, true)
    assert.equal(r.from, text.indexOf('"') + 1)
  })

  test('空位（空格后）返回 null', () => {
    const { text, cursor } = at('SELECT * FROM |')
    assert.equal(api.parseTrailingIdentifier(text, cursor, mysql), null)
  })
})

// ------------------------------------------------------------ L2 源解析

describe('L2 源解析（列补全那一格才接线，先钉住纯函数）', () => {
  test('scanCtes 收集 WITH 与 ,cte AS (', () => {
    const { masked } = api.maskSqlLiterals(
      'WITH recent AS (SELECT 1), agg AS (SELECT 2) SELECT * FROM recent', mysql
    )
    assert.deepEqual(arr(api.scanCtes(masked)), ['recent', 'agg'])
  })

  test('extractSources 抽源与别名，保留字不当别名', () => {
    const { masked } = api.maskSqlLiterals(
      'SELECT * FROM users u JOIN orders ON u.id = orders.uid WHERE 1', mysql
    )
    const src = api.extractSources(masked, [])
    assert.equal(src[0].name, 'users')
    assert.equal(src[0].alias, 'u')
    assert.equal(src[1].name, 'orders')
    assert.equal(src[1].alias, 'orders', 'WHERE 是保留字，不能被当成 orders 的别名')
  })

  test('extractSources 认识 CTE', () => {
    const { masked } = api.maskSqlLiterals('WITH r AS (SELECT 1) SELECT * FROM r', mysql)
    const src = api.extractSources(masked, api.scanCtes(masked))
    assert.equal(src[0].kind, 'cte')
  })
})

// ------------------------------------------------------------ L3 场景

describe('L3 场景判定', () => {
  test("字符串内不弹（'ord 是字面量）", () => {
    assert.equal(ctxOf("SELECT * FROM t WHERE name = 'ord|").kind, 'literal')
  })

  test('注释内不弹', () => {
    assert.equal(ctxOf('-- from us|\nSELECT 1').kind, 'literal')
  })

  test('FROM 之后 → table 且排他', () => {
    const c = ctxOf('SELECT * FROM |')
    assert.equal(c.kind, 'table')
    assert.equal(c.exclusive, true)
  })

  test('DELETE FROM 之后 → table（不出列）', () => {
    assert.equal(ctxOf('DELETE FROM |').kind, 'table')
  })

  test('FROM db. → table（限定的是库/模式，不是列）', () => {
    const c = ctxOf('SELECT * FROM db.|')
    assert.equal(c.kind, 'table')
    assert.deepEqual(arr(c.qualifier), ['db'])
  })

  test('u. → column', () => {
    const c = ctxOf('SELECT * FROM users u WHERE u.|')
    assert.equal(c.kind, 'column')
    assert.deepEqual(arr(c.qualifier), ['u'])
  })

  test('ORDER BY 之后 → alias（不排他）', () => {
    const c = ctxOf('SELECT a AS x FROM t ORDER BY |')
    assert.equal(c.kind, 'alias')
    assert.equal(c.exclusive, false)
  })

  test('CREATE TABLE t ( → name（列名位，不补类型）', () => {
    assert.equal(ctxOf('CREATE TABLE t (|').kind, 'general')
  })

  test('CREATE TABLE t (id → 仍在列名位', () => {
    assert.equal(ctxOf('CREATE TABLE t (id|').kind, 'general')
  })

  test('CREATE TABLE t (id  → 类型位且排他', () => {
    const c = ctxOf('CREATE TABLE t (id |')
    assert.equal(c.kind, 'type')
    assert.equal(c.exclusive, true)
  })

  test('第二列不出错位：CREATE TABLE t (id int,  → 列名位', () => {
    assert.equal(ctxOf('CREATE TABLE t (id int, |').kind, 'general')
  })

  test('第二列类型位：CREATE TABLE t (id int, name  → type', () => {
    assert.equal(ctxOf('CREATE TABLE t (id int, name |').kind, 'type')
  })

  test('ALTER TABLE ADD COLUMN c  → type', () => {
    assert.equal(ctxOf('ALTER TABLE t ADD COLUMN note |').kind, 'type')
  })

  test('多语句只看光标所在那条', () => {
    assert.equal(ctxOf('DELETE FROM x; SELECT * FROM |').kind, 'table')
    assert.equal(ctxOf('SELECT * FROM |; DELETE FROM x').kind, 'table')
  })

  test('解析不出场景时退化为 general，不抛错', () => {
    assert.equal(ctxOf('|').kind, 'general')
    assert.equal(ctxOf('随便写点中文|').kind, 'general')
  })
})

// ------------------------------------------------------------ L3 候选

describe('L3 候选生成', () => {
  test('默认小写插入', () => {
    const res = api.buildCompletions(ctxOf('sel|'), { dialect: mysql, keywordCase: 'lower' })
    assert.ok(labels(res).includes('select'), labels(res).slice(0, 6).join(','))
  })

  test('upper 模式插入大写', () => {
    const res = api.buildCompletions(ctxOf('sel|'), { dialect: mysql, keywordCase: 'upper' })
    assert.ok(labels(res).includes('SELECT'))
  })

  test('用户已敲大写时跟用户走（不因配置是小写就打回）', () => {
    const res = api.buildCompletions(ctxOf('SEL|'), { dialect: mysql, keywordCase: 'lower' })
    assert.ok(labels(res).includes('SELECT'))
  })

  test('前缀命中的排在前缀无关的前面', () => {
    const res = api.buildCompletions(ctxOf('sele|'), { dialect: mysql, keywordCase: 'lower' })
    assert.equal(labels(res)[0], 'select')
  })

  test('方言不串味：PG 的 RETURNING 不出现在 MySQL 候选里', () => {
    const my = labels(api.buildCompletions(ctxOf('RET|'), { dialect: mysql, keywordCase: 'upper' }))
    const pgLabels = labels(api.buildCompletions(ctxOf('RET|'), { dialect: pg, keywordCase: 'upper' }))
    assert.ok(!my.includes('RETURNING'), 'MySQL 不该补出 RETURNING')
    assert.ok(pgLabels.includes('RETURNING'))
  })

  test('内置函数带 detail，去重后不重复出 IF（既是关键字又是函数）', () => {
    const res = api.buildCompletions(ctxOf('i|'), { dialect: mysql, keywordCase: 'lower', max: 200 })
    const ifs = res.options.filter(o => o.label === 'if')
    assert.equal(ifs.length, 1, 'IF 只能出现一次')
  })

  test('table 场景：喂了表名就排他，只出表', () => {
    const res = api.buildCompletions(ctxOf('SELECT * FROM |'), {
      dialect: mysql, keywordCase: 'lower', tables: ['users', 'orders']
    })
    assert.equal(res.exclusive, true)
    assert.deepEqual(arr(labels(res)).sort(), ['orders', 'users'])
  })

  test('table 场景没有元数据 → 降级为静态候选且取消排他（绝不空菜单）', () => {
    const res = api.buildCompletions(ctxOf('SELECT * FROM |'), { dialect: mysql, keywordCase: 'lower' })
    assert.ok(res.options.length > 0)
    assert.equal(res.exclusive, false)
  })

  test('type 场景只出数据类型', () => {
    const res = api.buildCompletions(ctxOf('CREATE TABLE t (id |'), { dialect: mysql, keywordCase: 'upper' })
    assert.ok(labels(res).includes('VARCHAR'))
    assert.ok(!labels(res).includes('SELECT'), '类型位不该出关键字')
  })

  test('column 场景：喂了列就排他，且带类型 detail', () => {
    const res = api.buildCompletions(ctxOf('SELECT * FROM users u WHERE u.|'), {
      dialect: mysql,
      keywordCase: 'lower',
      columns: { u: [{ name: 'user_id', type: 'bigint', pk: true }, { name: 'name' }] }
    })
    assert.equal(res.exclusive, true)
    // 空前缀下按 §4.5 的"名称长度 → 字典序"排，不按元数据顺序
    assert.deepEqual(arr(labels(res)), ['name', 'user_id'])
    assert.equal(res.options.find(o => o.label === 'user_id').detail, 'bigint · PK')
  })

  test('column 场景没有列元数据 → 降级静态，不空菜单', () => {
    const res = api.buildCompletions(ctxOf('SELECT * FROM users u WHERE u.|'), {
      dialect: mysql, keywordCase: 'lower'
    })
    assert.ok(res.options.length > 0)
    assert.equal(res.exclusive, false)
  })

  test('候选上限生效（默认 50）', () => {
    const res = api.buildCompletions(ctxOf('|'), { dialect: mysql, keywordCase: 'lower' })
    assert.equal(res.options.length, 50)
  })

  test('反引号前缀：替换起点跳过引号，插入时补回引号', () => {
    const c = ctxOf('SELECT * FROM `us|')
    const res = api.buildCompletions(c, {
      dialect: mysql, keywordCase: 'lower', tables: ['users']
    })
    assert.equal(res.options[0].label, 'users')
    assert.equal(res.options[0].apply, 'users`', '未闭合的引号要自动补上')
    assert.equal(res.from, c.from)
  })

  test('函数候选补括号，光标语义上是"调用一个函数"', () => {
    const res = api.buildCompletions(ctxOf('|'), { dialect: mysql, keywordCase: 'lower', max: 200 })
    const count = res.options.find(o => o.label === 'count')
    assert.ok(count, '缺少 count 候选')
    assert.equal(count.apply, 'count()')
  })

  test('字面量场景直接返回 null（不弹菜单）', () => {
    const c = ctxOf("SELECT 'abc|'")
    assert.equal(api.buildCompletions(c, { dialect: mysql }), null)
  })

  test('无方言（redis）返回 null', () => {
    assert.equal(api.buildCompletions(ctxOf('sel|'), { dialect: null }), null)
  })
})

// ------------------------------------------------------------ A-4 元数据整形

describe('A-4 元数据拍平成候选表', () => {
  const MYSQL_META = [
    { name: 'shop', type: 'database', children: [{ name: 'users', type: 'table' }, { name: 'orders', type: 'table' }] },
    { name: 'log', type: 'database', children: [{ name: 'events', type: 'table' }] }
  ]
  const PG_META = [
    { name: 'app', type: 'database', children: [] },
    {
      name: 'shop',
      type: 'database',
      children: [
        { name: 'public', type: 'schema', children: [{ name: 'users', type: 'table' }] },
        { name: 'audit', type: 'schema', children: [{ name: 'trail', type: 'table' }] }
      ]
    }
  ]

  test('MySQL 两层结构：库 → 表', () => {
    assert.deepEqual(arr(api.flattenTables(MYSQL_META, 'shop')), ['orders', 'users'])
  })

  test('PG 三层结构：库 → schema → 表（递归穿透）', () => {
    assert.deepEqual(arr(api.flattenTables(PG_META, 'shop')), ['trail', 'users'])
  })

  test('不传库名时跨库合并（跨库查询常见）', () => {
    assert.deepEqual(arr(api.flattenTables(MYSQL_META)), ['events', 'orders', 'users'])
  })

  test('库名比较宽松大小写（避免"选了库却补不出表"）', () => {
    assert.deepEqual(arr(api.flattenTables(MYSQL_META, 'SHOP')), ['orders', 'users'])
  })

  test('库不存在 / 空元数据 → 空数组，不抛错', () => {
    assert.equal(api.flattenTables(MYSQL_META, 'nope').length, 0)
    assert.equal(api.flattenTables([], 'shop').length, 0)
    assert.equal(api.flattenTables(null, 'shop').length, 0)
  })

  test('拍平结果直接喂给 table 场景即可用（端到端）', () => {
    const tables = api.flattenTables(MYSQL_META, 'shop')
    const res = api.buildCompletions(ctxOf('SELECT * FROM us|'), {
      dialect: mysql, keywordCase: 'lower', tables
    })
    assert.equal(res.exclusive, true)
    assert.deepEqual(arr(labels(res)), ['users'])
  })
})
