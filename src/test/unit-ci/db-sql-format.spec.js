// A3 SQL 格式化：纯函数直测（ESM 源码，vm 沙箱加载方式与 db-csv.spec 一致）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, '../../client/common/db-sql-format.js')

function loadFns () {
  let src = fs.readFileSync(SRC, 'utf8')
  // ESM export → 去掉后供 vm 同步求值（同 db-csv.spec 模式）
  src = src.replace(/^export /gm, '')
  const sandbox = {}
  vm.createContext(sandbox)
  return vm.runInContext(`(function () { ${src}; return { formatSql } })()`, sandbox)
}

describe('db-sql-format formatSql', () => {
  const { formatSql } = loadFns()

  test('空输入返回空串', () => {
    assert.equal(formatSql(''), '')
    assert.equal(formatSql('   '), '')
    assert.equal(formatSql(null), '')
  })

  test('SELECT 基本格式化：主子句换行、关键字大写、列逗号换行', () => {
    const out = formatSql('select id, name from users where id = 1 order by name desc')
    assert.equal(
      out,
      'SELECT id,\nname\nFROM users\nWHERE id = 1\nORDER BY name DESC'
    )
  })

  test('字符串字面量内部关键字不大写、引号翻倍保留', () => {
    const out = formatSql("select * from t where name = 'select from where'")
    assert.ok(out.includes("'select from where'"), 'literal must stay as-is')
    assert.ok(!out.includes("'SELECT FROM WHERE'"), 'literal must not be uppercased')
  })

  test('反引号标识符保留原样', () => {
    const out = formatSql('select `order` from `my table`')
    assert.ok(out.includes('`order`'))
    assert.ok(out.includes('`my table`'))
  })

  test('GROUP BY 两词主子句换行', () => {
    const out = formatSql('select a, count(*) from t group by a having count(*) > 1')
    assert.ok(out.includes('\nGROUP BY a'), 'GROUP BY on own line')
    assert.ok(out.includes('\nHAVING'), 'HAVING on own line')
  })

  test('INSERT INTO / VALUES 换行', () => {
    const out = formatSql("insert into t (a, b) values (1, 'x')")
    assert.ok(out.startsWith('INSERT INTO t'))
    assert.ok(out.includes('\nVALUES'))
  })

  test('LEFT JOIN 换行且 JOIN 关键字大写', () => {
    const out = formatSql('select * from a left join b on a.id = b.id where a.x = 1')
    assert.ok(out.includes('\nLEFT JOIN b ON a.id = b.id'), 'LEFT JOIN line')
    assert.ok(out.includes('\nWHERE'), 'WHERE line')
  })

  test('短列表折叠回单行（IN 列表不再竖排）', () => {
    const out = formatSql('select * from t where id in (1, 2, 3)')
    assert.ok(out.includes('IN (1, 2, 3)'), `inline list, got: ${out}`)
    assert.ok(!/\n\s*\)/.test(out), 'closing paren not on its own indented line')
  })

  test('N12e 子查询嵌套：括号内主子句保留缩进层级（不再拍平到第 0 列）', () => {
    const out = formatSql('select a from (select b, c from t where x = 1) q')
    assert.ok(out.includes('FROM (\n  SELECT b,\n  c\n  FROM t\n  WHERE x = 1) q'),
      `nested indent, got:\n${out}`)
  })

  test('N12e CTE：WITH 换行、子查询体缩进、顶层 SELECT 回到第 0 列', () => {
    const out = formatSql('with a as (select x from t) select * from a')
    assert.ok(out.startsWith('WITH a AS (\n  SELECT x\n  FROM t)'), `cte head, got:\n${out}`)
    assert.ok(out.includes('\nSELECT *\nFROM a'), 'outer SELECT at column 0')
  })

  test('N12e 窗口函数：OVER (PARTITION BY / ORDER BY) 分行缩进', () => {
    const out = formatSql('select row_number() over (partition by dep order by sal desc) r from t')
    assert.ok(out.includes('OVER (\n  PARTITION BY dep\n  ORDER BY sal DESC)'),
      `window indent, got:\n${out}`)
  })

  test('N12e 函数参数折叠：func(a, b) 不拆竖排', () => {
    const out = formatSql('select greatest(a, b, c) from t')
    assert.ok(out.includes('greatest(a, b, c)'), `func args inline, got: ${out}`)
  })

  test('N12e 折叠护栏：块内有行注释不折叠（防注释吞行）', () => {
    const out = formatSql('select * from t where id in (1, -- first\n 2)')
    assert.ok(out.includes('-- first'), 'comment kept')
    // 块没被折叠成单行 —— 折叠会把注释后的内容并进注释行
    assert.ok(!out.includes('IN (1, -- first 2)'), 'block not collapsed under comment')
  })

  test('N12e 折叠护栏：超长块保持竖排（单行化 > 80 字符）', () => {
    const items = Array.from({ length: 20 }, (_, i) => `verylongcolumnname${i + 1}`).join(', ')
    const out = formatSql(`select * from t where id in (${items})`)
    assert.ok(/\n\s+verylongcolumnname2,/.test(out), 'long list stays expanded')
  })

  test('N12e 折叠护栏：字符串字面量内的括号与换行不被折叠改动', () => {
    const out = formatSql("select * from t where note = 'line1\nline2' and id in (1, 2)")
    assert.ok(out.includes("'line1\nline2'"), 'multiline string literal untouched')
    assert.ok(out.includes('IN (1, 2)'), 'plain list still collapsed')
  })

  test('注释保留', () => {
    const out = formatSql('select * from t -- all rows\nwhere id = 1')
    assert.ok(out.includes('-- all rows'), 'line comment kept')
  })

  test('语句串联：分号后新语句从新行开始', () => {
    const out = formatSql('select 1;select 2;')
    assert.equal(out.split('\n').length >= 2, true)
    assert.ok(out.includes(';'))
  })
})
