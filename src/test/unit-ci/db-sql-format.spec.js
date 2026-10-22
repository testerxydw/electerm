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

  test('括号内缩进、闭合回退', () => {
    const out = formatSql('select * from t where id in (1, 2, 3)')
    const lines = out.split('\n')
    assert.ok(lines.some(l => /^\s+2,/.test(l)), 'list item indented')
    assert.ok(!/\n\s*\)/.test(out), 'closing paren not on its own indented line')
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
