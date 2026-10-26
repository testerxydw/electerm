const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// B-3 SQL 模板（设计 §11 关键纪律：模板 = 补全用的 snippet 定义，同一份文件）。
// 纯函数零依赖：vm 加载真实源码、strip ESM import/export
const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-sql-snippets.js')

const loadMod = () => {
  const code = fs.readFileSync(SRC, 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+/gm, '') +
    // 顶层 const 声明不挂 context 对象（词法作用域），显式导出给宿主
    '\n;Object.assign(globalThis, { PLACEHOLDER_TABLE, SQL_TEMPLATES, quoteIdent, buildTemplateSql })\n'
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

// vm realm 的数组与宿主 Array 非同构造函数，deepStrictEqual 会误报
// "not reference-equal"——用 Array.from 搬回宿主 realm 再比（项目既有坑）
const toHost = arr => Array.from(arr || [])

describe('db-sql-snippets quoteIdent', () => {
  const { quoteIdent } = loadMod()
  test('mysql 反引号，内部反引号双写转义', () => {
    assert.equal(quoteIdent('tbl', 'mysql'), '`tbl`')
    assert.equal(quoteIdent('we`ird', 'mysql'), '`we``ird`')
  })
  test('pg 双引号，内部双引号双写转义', () => {
    assert.equal(quoteIdent('tbl', 'postgres'), '"tbl"')
    assert.equal(quoteIdent('a"b', 'postgres'), '"a""b"')
  })
  test('空值原样返回，不抛错', () => {
    assert.equal(quoteIdent('', 'mysql'), '')
    assert.equal(quoteIdent(null, 'mysql'), '')
    assert.equal(quoteIdent(undefined, 'postgres'), '')
  })
})

describe('db-sql-snippets 骨架（无表上下文）', () => {
  const { buildTemplateSql, PLACEHOLDER_TABLE } = loadMod()
  test('五种模板 key 全部可生成，占位表名可读', () => {
    for (const key of ['select', 'insert', 'update', 'delete', 'count']) {
      const text = buildTemplateSql(key, { dialect: 'mysql' })
      assert.equal(typeof text, 'string')
      assert.ok(text.includes('table_name'), key + ' 应含占位表名')
    }
    assert.equal(PLACEHOLDER_TABLE, 'table_name')
  })
  test('未知 key 返回 null', () => {
    assert.equal(buildTemplateSql('nope', { dialect: 'mysql' }), null)
  })
})

describe('db-sql-snippets 带表上下文', () => {
  const { buildTemplateSql } = loadMod()
  const cols = [{ name: 'id' }, { name: 'name' }, { name: 'note' }]

  test('生成 INSERT：mysql 列清单 + ? 占位符', () => {
    const text = buildTemplateSql('insert', {
      dialect: 'mysql', schema: 'db1', table: 't1', columns: cols
    })
    assert.equal(
      text,
      'INSERT INTO `db1`.`t1` (`id`, `name`, `note`)\nVALUES (?, ?, ?)'
    )
  })

  test('生成 INSERT：pg $n 连续编号 + 双引号列', () => {
    const text = buildTemplateSql('insert', {
      dialect: 'postgres', schema: 'public', table: 't1', columns: cols
    })
    assert.equal(
      text,
      'INSERT INTO "public"."t1" ("id", "name", "note")\nVALUES ($1, $2, $3)'
    )
  })

  test('生成 INSERT：列对象里的空名被过滤，全空退化为骨架', () => {
    const text = buildTemplateSql('insert', {
      dialect: 'mysql', table: 't1', columns: [{ name: '' }, { name: 'id' }]
    })
    assert.ok(text.includes('(`id`)'))
    assert.ok(text.includes('(?)'))
    const empty = buildTemplateSql('insert', {
      dialect: 'mysql', table: 't1', columns: [{}, { name: null }]
    })
    assert.ok(empty.includes('col1, col2'), '全空列退化为骨架')
  })

  test('SELECT：有列生成列清单，无列退化 *', () => {
    const withCols = buildTemplateSql('select', {
      dialect: 'mysql', table: 't1', columns: cols
    })
    assert.ok(withCols.startsWith('SELECT `id`, `name`, `note`'))
    assert.ok(withCols.includes('FROM `t1`'))
    const noCols = buildTemplateSql('select', { dialect: 'mysql', table: 't1' })
    assert.ok(noCols.startsWith('SELECT *'))
  })

  test('UPDATE：SET 跳过第一列（约定首列为主键），WHERE 留条件占位', () => {
    const text = buildTemplateSql('update', {
      dialect: 'mysql', table: 't1', columns: cols
    })
    assert.equal(
      text,
      'UPDATE `t1`\nSET `name` = ?, `note` = ?\nWHERE <condition>'
    )
  })

  test('DELETE / COUNT：带表名生成完整可改语句', () => {
    const del = buildTemplateSql('delete', { dialect: 'pg', table: 't1' })
    assert.ok(del.startsWith('DELETE FROM'))
    const cnt = buildTemplateSql('count', { dialect: 'postgres', schema: 's', table: 't1' })
    assert.ok(cnt.includes('COUNT(*) AS total'))
    assert.ok(cnt.includes('"s"."t1"'))
  })

  test('模板生成绝不抛错：异常输入降级为最简骨架', () => {
    const text = buildTemplateSql('insert', { dialect: 'mysql', table: null, columns: 'oops' })
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0)
  })

  test('模板注册表结构稳定（菜单与补全共用同一份）', () => {
    const { SQL_TEMPLATES } = loadMod()
    const keys = toHost(SQL_TEMPLATES.map(t => t.key))
    assert.deepEqual(keys, ['select', 'insert', 'update', 'delete', 'count'])
    for (const t of SQL_TEMPLATES) {
      assert.equal(typeof t.build, 'function')
    }
  })
})
