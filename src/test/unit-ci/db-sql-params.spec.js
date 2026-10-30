// H6a-1：命名参数提取与占位符转换（纯函数）
//
// 这一层是"禁止字符串拼接"的唯一出口：只产出 SQL 文本 + 值数组，
// 值的转义交给驱动。测试重点在"哪里不该被当成参数"——字符串、注释、
// `::` 类型转换、引号标识符；以及两种方言的编号规则。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/db-sql-params.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

describe('H6a 命名参数：提取', () => {
  test('普通 :name 按首次出现排序、同名只记一次', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(
      extractSqlParams('SELECT * FROM t WHERE a = :a AND b = :b AND a2 = :a'),
      ['a', 'b']
    )
  })

  test('字符串字面量里的 :x 不是参数（含反斜杠转义与双写引号）', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams("SELECT ':a', 'it''s :b', 'c\\':d'"), [])
    assert.deepEqual(extractSqlParams("SELECT ':a' , x = :real"), ['real'])
  })

  test('三种注释里的 :x 不是参数', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams('SELECT 1 -- :a\n, :b'), ['b'])
    assert.deepEqual(extractSqlParams('SELECT /* :a */ :b'), ['b'])
    assert.deepEqual(extractSqlParams('SELECT 1 # :a\n, :b'), ['b'])
  })

  test('引号标识符里的 :x 不是参数', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams('SELECT `:a`, ":b" FROM t'), [])
  })

  test('PG 的 :: 类型转换不吞掉/不误判参数', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams('SELECT :id::int, :name::text'), ['id', 'name'])
    assert.deepEqual(extractSqlParams('SELECT 1::int'), [])
  })

  test('PG 的 $1 不被当作命名参数', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams('SELECT * FROM t WHERE a = $1'), [])
  })

  test('冒号后面不是标识符时不认（:= 与 a:b 之外的普通冒号）', async () => {
    const { extractSqlParams } = await load()
    assert.deepEqual(extractSqlParams('SELECT a || \'\'  FROM t'), [])
  })
})

describe('H6a 命名参数：占位符转换', () => {
  test('mysql：:name → ?，值按占位符顺序（同名重复展开）', async () => {
    const { toPositional } = await load()
    const r = toPositional('UPDATE t SET a = :a WHERE id = :id OR prev = :a', { a: 1, id: 2 }, 'mysql')
    assert.equal(r.sql, 'UPDATE t SET a = ? WHERE id = ? OR prev = ?')
    assert.deepEqual(r.values, [1, 2, 1])
  })

  test('postgres：:name → $1..$n，同名复用编号', async () => {
    const { toPositional } = await load()
    const r = toPositional('SELECT * FROM t WHERE a = :a AND b = :b AND a2 = :a', { a: 1, b: 2 }, 'postgres')
    assert.equal(r.sql, 'SELECT * FROM t WHERE a = $1 AND b = $2 AND a2 = $1')
    assert.deepEqual(r.values, [1, 2])
  })

  test('保留 PG 类型转换与字符串里的冒号', async () => {
    const { toPositional } = await load()
    const r = toPositional("SELECT ':a', :id::int", { id: 7 }, 'postgres')
    assert.equal(r.sql, "SELECT ':a', $1::int")
    assert.deepEqual(r.values, [7])
  })

  test('无参数回退：SQL 原样、values 为空', async () => {
    const { toPositional } = await load()
    const r = toPositional('SELECT 1', {}, 'mysql')
    assert.equal(r.sql, 'SELECT 1')
    assert.deepEqual(r.values, [])
  })

  test('null 是 SQL NULL（不当作没填）', async () => {
    const { toPositional } = await load()
    const r = toPositional('INSERT INTO t (a, b) VALUES (:a, :b)', { a: null, b: 'x' }, 'mysql')
    assert.deepEqual(r.values, [null, 'x'])
  })

  test('缺值要报错，不能悄悄变成 undefined 或 NULL', async () => {
    const { toPositional } = await load()
    assert.throws(() => toPositional('SELECT :a', {}, 'mysql'), /missing value for :a/)
    assert.throws(() => toPositional('SELECT :a, :b', [1], 'mysql'), /parameter count mismatch/)
  })

  test('$n 与 :name 混用直接拒绝（编号会撞车）', async () => {
    const { toPositional } = await load()
    assert.throws(
      () => toPositional('SELECT $1, :a', { a: 1 }, 'postgres'),
      /\$n positional parameters cannot be mixed/
    )
    // 字符串里的 $1 不算混用
    const r = toPositional("SELECT '$1', :a", { a: 1 }, 'postgres')
    assert.equal(r.sql, "SELECT '$1', $1")
  })

  test('值里的引号/分号原样交给驱动（本层不做任何转义或拼接）', async () => {
    const { toPositional } = await load()
    const evil = "x'; DROP TABLE t; --"
    const r = toPositional('SELECT * FROM t WHERE a = :a', { a: evil }, 'mysql')
    assert.equal(r.sql, 'SELECT * FROM t WHERE a = ?')
    assert.deepEqual(r.values, [evil])
  })
})

describe('H6a 单语句判定', () => {
  test('单条 / 多条 / 末尾分号', async () => {
    const { countSqlStatements } = await load()
    assert.equal(countSqlStatements('SELECT 1'), 1)
    assert.equal(countSqlStatements('SELECT 1;'), 1)
    assert.equal(countSqlStatements('SELECT 1; SELECT 2'), 2)
    assert.equal(countSqlStatements('; ; SELECT 1 ; '), 1)
  })

  test('字符串与注释里的分号不算语句分隔', async () => {
    const { countSqlStatements } = await load()
    assert.equal(countSqlStatements("SELECT 'a;b'"), 1)
    assert.equal(countSqlStatements('SELECT 1 -- ; not a statement'), 1)
    assert.equal(countSqlStatements('SELECT 1 /* ; */'), 1)
    assert.equal(countSqlStatements('SELECT 1; -- 收尾注释'), 1)
  })

  test('空串与纯注释算 0 条', async () => {
    const { countSqlStatements } = await load()
    assert.equal(countSqlStatements(''), 0)
    assert.equal(countSqlStatements('  \n\t '), 0)
    assert.equal(countSqlStatements('-- 只有注释\n/* 还是注释 */'), 0)
  })
})
