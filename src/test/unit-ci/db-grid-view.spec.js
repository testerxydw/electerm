// E2 结果集视角模型（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.1）
//
// 为什么用 vm 跑 src 下的同一份源码（与 db-sql-risk.spec.js 同样做法）：
// - 源码是 ESM（export），CJS 测试进程里 require 吃不下；
// - 更关键的是**不许出现"测试拷贝"**：条件生成规则一旦在实现与测试之间漂移，
//   测试就变成自证（实现怎么写都能过）。
// 为什么用"追加导出表达式"而不是模板串拼接源码：
// 源码里有正则（\\ % _ 的转义），经模板串插值会被 JS 字符串转义吃掉反斜杠，
// 测试就会在"看起来全绿"的情况下跑一份被改坏的实现。
//
// 断言里的 plain()：vm 里造出来的数组/对象属于另一个 realm，原型链不是宿主的那几个，
// node:assert 的 strict deepEqual 会连原型一起比。序列化一次把值搬回宿主 realm，
// 断言失败信息也跟着变得好读。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const VIEW = path.join(ROOT, 'src/client/common/db-grid-view.js')

const VIEW_EXPORTS = '({ FILTER_OPS, normalizeView, buildWhere, buildOrderBy, ' +
  'viewKey, quoteIdent })'

function loadFrom (file, exportsExpr) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '')
  const sandbox = { Map, Set, Array, Object, Number, String, Math, JSON, RegExp, Boolean }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n' + exportsExpr, sandbox)
}

const {
  FILTER_OPS,
  normalizeView,
  buildWhere,
  buildOrderBy,
  viewKey,
  quoteIdent
} = loadFrom(VIEW, VIEW_EXPORTS)

// 值搬回宿主 realm，便于 strict deepEqual
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// 列白名单：既覆盖大小写，也覆盖 LIKE 里常见的字符串列
const COLS = ['id', 'name', 'age', 'a', 'b', 'c', 'created_at']

const viewOf = conditions => ({ conditions })

describe('db-grid-view: FILTER_OPS 契约', () => {
  test('算子清单与设计文档一致', () => {
    assert.deepEqual(plain(FILTER_OPS), [
      'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
      'contains', 'startsWith', 'endsWith', 'in', 'isNull', 'notNull'
    ])
  })
})

describe('db-grid-view: buildWhere 基础', () => {
  test('单等值：列名加引用符，值走占位符', () => {
    const r = buildWhere(viewOf([{ column: 'id', op: 'eq', value: '7' }]), COLS, 'mysql')
    assert.equal(r.clause, '`id` = ?')
    assert.deepEqual(plain(r.params), ['7'])
    assert.deepEqual(plain(r.rejected), [])
  })

  test('多条件用 AND 连接，参数顺序与占位符一致', () => {
    const r = buildWhere(viewOf([
      { column: 'age', op: 'gte', value: '18' },
      { column: 'name', op: 'contains', value: 'bo' }
    ]), COLS, 'mysql')
    assert.equal(r.clause, '`age` >= ? AND `name` LIKE ?')
    assert.deepEqual(plain(r.params), ['18', '%bo%'])
  })

  test('比较算子映射 eq/ne/gt/gte/lt/lte', () => {
    const cases = [
      ['eq', '='],
      ['ne', '<>'],
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<=']
    ]
    for (const [op, sql] of cases) {
      const r = buildWhere(viewOf([{ column: 'age', op, value: '1' }]), COLS, 'mysql')
      assert.equal(r.clause, '`age` ' + sql + ' ?', op)
      assert.deepEqual(plain(r.params), ['1'], op)
    }
  })

  test('大小写不敏感匹配白名单，但 SQL 用白名单里的规范名', () => {
    const r = buildWhere(viewOf([{ column: 'ID', op: 'eq', value: '1' }]), COLS, 'mysql')
    assert.equal(r.clause, '`id` = ?')
    assert.deepEqual(plain(r.rejected), [])
  })

  test('列清单可以是 {name} 对象（getTableStructure 的形状）', () => {
    const r = buildWhere(
      viewOf([{ column: 'Name', op: 'eq', value: 'x' }]),
      [{ name: 'id' }, { name: 'name' }],
      'mysql'
    )
    assert.equal(r.clause, '`name` = ?')
  })
})

describe('db-grid-view: LIKE 三种位置与转义', () => {
  test('contains → %val%', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'ab' }]), COLS, 'mysql')
    assert.equal(r.clause, '`name` LIKE ?')
    assert.deepEqual(plain(r.params), ['%ab%'])
  })

  test('startsWith → val%', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'startsWith', value: 'ab' }]), COLS, 'mysql')
    assert.deepEqual(plain(r.params), ['ab%'])
  })

  test('endsWith → %val', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'endsWith', value: 'ab' }]), COLS, 'mysql')
    assert.deepEqual(plain(r.params), ['%ab'])
  })

  test('值里的反斜杠先被转义（顺序正确才不会被二次转义）', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'a\\b' }]), COLS, 'mysql')
    // 原值 a\b → 转义 a\\b → 包通配符 %a\\b%
    assert.deepEqual(plain(r.params), ['%a\\\\b%'])
  })

  test('值里的 % 被转义成字面百分号', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'a%b' }]), COLS, 'mysql')
    assert.deepEqual(plain(r.params), ['%a\\%b%'])
  })

  test('值里的 _ 被转义成字面下划线', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'a_b' }]), COLS, 'mysql')
    assert.deepEqual(plain(r.params), ['%a\\_b%'])
  })

  test('LIKE 值不生成 ESCAPE 子句（两种方言默认转义符都是反斜杠）', () => {
    const r = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'a%b' }]), COLS, 'mysql')
    assert.ok(!/ESCAPE/i.test(r.clause))
  })
})

describe('db-grid-view: IN / NULL', () => {
  test('in 按元素个数展开占位符', () => {
    const r = buildWhere(viewOf([{ column: 'id', op: 'in', value: [1, 2, 3] }]), COLS, 'mysql')
    assert.equal(r.clause, '`id` IN (?, ?, ?)')
    assert.deepEqual(plain(r.params), ['1', '2', '3'])
  })

  test('in 接受逗号分隔字符串', () => {
    const r = buildWhere(viewOf([{ column: 'id', op: 'in', value: '1, 2 ,,3' }]), COLS, 'mysql')
    assert.deepEqual(plain(r.params), ['1', '2', '3'])
  })

  test('in 超 200 截断到 200：进 truncated，不算 rejected（条件确实生效了）', () => {
    const values = Array.from({ length: 250 }, (_, i) => String(i))
    const r = buildWhere(viewOf([{ column: 'id', op: 'in', value: values }]), COLS, 'mysql')
    assert.equal(r.params.length, 200)
    assert.equal((r.clause.match(/\?/g) || []).length, 200)
    assert.deepEqual(plain(r.rejected), [], '生效了的条件不能算"未生效"')
    assert.deepEqual(plain(r.truncated), [
      { index: 0, column: 'id', op: 'in', reason: 'tooManyValues' }
    ])
  })

  test('isNull / notNull 不产生参数', () => {
    const a = buildWhere(viewOf([{ column: 'name', op: 'isNull' }]), COLS, 'mysql')
    assert.equal(a.clause, '`name` IS NULL')
    assert.deepEqual(plain(a.params), [])
    const b = buildWhere(viewOf([{ column: 'name', op: 'notNull' }]), COLS, 'mysql')
    assert.equal(b.clause, '`name` IS NOT NULL')
    assert.deepEqual(plain(b.params), [])
  })
})

describe('db-grid-view: 丢弃与拒绝', () => {
  test('未知列被丢弃并记 rejected（带原始下标）', () => {
    const r = buildWhere(viewOf([
      { column: 'id', op: 'eq', value: '1' },
      { column: 'nope', op: 'eq', value: '1' }
    ]), COLS, 'mysql')
    assert.equal(r.clause, '`id` = ?')
    assert.deepEqual(plain(r.rejected), [
      { index: 1, column: 'nope', op: 'eq', reason: 'unknownColumn' }
    ])
    assert.deepEqual(plain(r.truncated), [], '未生效 ≠ 被裁剪')
  })

  test('未生效与"生效但截断"同时出现时各归各的清单', () => {
    const many = Array.from({ length: 250 }, (_, i) => String(i))
    const r = buildWhere(viewOf([
      { column: 'nope', op: 'eq', value: '1' },
      { column: 'id', op: 'in', value: many },
      { column: 'name', op: 'eq', value: '   ' }
    ]), COLS, 'mysql')
    assert.equal(r.params.length, 200)
    assert.deepEqual(plain(r.rejected).map(x => [x.index, x.reason]), [
      [0, 'unknownColumn'],
      [2, 'emptyValue']
    ])
    assert.deepEqual(plain(r.truncated).map(x => [x.index, x.reason]), [
      [1, 'tooManyValues']
    ])
  })

  test('空值条件被丢弃：不生成 = 空串 那种"看起来有筛其实全表"', () => {
    const r = buildWhere(viewOf([
      { column: 'name', op: 'eq', value: '   ' },
      { column: 'age', op: 'gt', value: '' }
    ]), COLS, 'mysql')
    assert.equal(r.clause, '')
    assert.deepEqual(plain(r.params), [])
    assert.deepEqual(plain(r.rejected).map(x => x.reason), ['emptyValue', 'emptyValue'])
  })

  test('未知算子被丢弃（不认识的算子绝不能拼进 SQL）', () => {
    const r = buildWhere(viewOf([{ column: 'id', op: 'regexp', value: '1' }]), COLS, 'mysql')
    assert.equal(r.clause, '')
    assert.deepEqual(plain(r.rejected), [
      { index: 0, column: 'id', op: 'regexp', reason: 'unknownOp' }
    ])
  })

  test('全部条件都被丢弃时 clause 为空串（调用方据此跳过 WHERE）', () => {
    const r = buildWhere(viewOf([{ column: 'zzz', op: 'eq', value: '1' }]), COLS, 'mysql')
    assert.equal(r.clause, '')
    assert.deepEqual(plain(r.params), [])
  })

  test('空 columns 白名单 → 所有条件都拒绝', () => {
    const r = buildWhere(viewOf([{ column: 'id', op: 'eq', value: '1' }]), [], 'mysql')
    assert.equal(r.clause, '')
    assert.equal(r.rejected.length, 1)
  })
})

describe('db-grid-view: 方言差异', () => {
  test('mysql 反引号 / pg 双引号', () => {
    const v = viewOf([{ column: 'id', op: 'eq', value: '1' }])
    assert.equal(buildWhere(v, COLS, 'mysql').clause, '`id` = ?')
    assert.equal(buildWhere(v, COLS, 'postgres').clause, '"id" = $1')
  })

  test('pg 占位符跨条件连续编号（中间夹三元素 IN）', () => {
    const r = buildWhere(viewOf([
      { column: 'a', op: 'eq', value: '1' },
      { column: 'b', op: 'in', value: ['x', 'y', 'z'] },
      { column: 'c', op: 'eq', value: '2' }
    ]), COLS, 'postgres')
    assert.equal(r.clause, '"a" = $1 AND "b" IN ($2, $3, $4) AND "c" = $5')
    assert.equal(r.params.length, 5)
  })

  test('quoteIdent 对引用符自身成对加倍', () => {
    assert.equal(quoteIdent('a`b', 'mysql'), '`a``b`')
    assert.equal(quoteIdent('a"b', 'postgres'), '"a""b"')
  })

  test('未知 dialect 按 mysql 处理（不静默变 pg）', () => {
    assert.equal(quoteIdent('id', 'tidb'), '`id`')
  })
})

describe('db-grid-view: buildOrderBy', () => {
  test('单列升序', () => {
    const sql = buildOrderBy({ order: [{ column: 'id', desc: false }] }, COLS, 'mysql')
    assert.equal(sql, '`id` ASC')
  })

  test('单列降序', () => {
    const sql = buildOrderBy({ order: [{ column: 'id', desc: true }] }, COLS, 'mysql')
    assert.equal(sql, '`id` DESC')
  })

  test('多列按序拼接', () => {
    const sql = buildOrderBy({
      order: [{ column: 'id', desc: true }, { column: 'name', desc: false }]
    }, COLS, 'mysql')
    assert.equal(sql, '`id` DESC, `name` ASC')
  })

  test('未知列被过滤掉', () => {
    const sql = buildOrderBy({
      order: [{ column: 'nope', desc: true }, { column: 'id', desc: false }]
    }, COLS, 'mysql')
    assert.equal(sql, '`id` ASC')
  })

  test('空 order → null（调用方据此不拼 ORDER BY）', () => {
    assert.equal(buildOrderBy({ order: [] }, COLS, 'mysql'), null)
    assert.equal(buildOrderBy({}, COLS, 'mysql'), null)
    assert.equal(buildOrderBy(null, COLS, 'mysql'), null)
  })

  test('同一列重复只留第一次', () => {
    const sql = buildOrderBy({
      order: [{ column: 'id', desc: true }, { column: 'ID', desc: false }]
    }, COLS, 'mysql')
    assert.equal(sql, '`id` DESC')
  })

  test('超 3 列截断', () => {
    const sql = buildOrderBy({
      order: [
        { column: 'id', desc: false },
        { column: 'name', desc: false },
        { column: 'age', desc: false },
        { column: 'a', desc: false }
      ]
    }, COLS, 'mysql')
    assert.equal(sql, '`id` ASC, `name` ASC, `age` ASC')
  })

  test('pg 用双引号', () => {
    const sql = buildOrderBy({ order: [{ column: 'id', desc: true }] }, COLS, 'postgres')
    assert.equal(sql, '"id" DESC')
  })
})

describe('db-grid-view: viewKey', () => {
  test('四段用 | 连接', () => {
    assert.equal(
      viewKey({ connectionId: 'c1', dbName: 'shop', schema: 'public', table: 'orders' }),
      'c1|shop|public|orders'
    )
  })

  test('undefined / null 归一成空串', () => {
    assert.equal(viewKey({ connectionId: 'c1', dbName: 'shop', table: 't' }), 'c1|shop||t')
    assert.equal(
      viewKey({ connectionId: 'c1', dbName: null, schema: undefined, table: 't' }),
      'c1|||t'
    )
  })

  test('不做 URL 编码，键能被人直接读懂', () => {
    assert.equal(viewKey({ connectionId: 'a b', table: 'x' }), 'a b|||x')
  })

  test('空入参不抛错', () => {
    assert.equal(viewKey(undefined), '|||')
    assert.equal(viewKey({}), '|||')
  })
})

describe('db-grid-view: normalizeView', () => {
  test('null 输入得到空视角（六个字段俱全）', () => {
    const raw = normalizeView(null)
    // 用原始对象取 keys：plain() 走 JSON，undefined 的 pageSize 会被丢掉
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['columnOrder', 'columnWidths', 'conditions', 'hiddenColumns', 'order', 'pageSize']
    )
    assert.equal(raw.pageSize, undefined)
    const v = plain(raw)
    assert.deepEqual(v.conditions, [])
    assert.deepEqual(v.order, [])
    assert.deepEqual(v.hiddenColumns, [])
    assert.deepEqual(v.columnWidths, {})
    assert.deepEqual(v.columnOrder, [])
  })

  test('未知字段不透传', () => {
    const raw = normalizeView({ conditions: [], evil: 'x', updatedAt: 1 })
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['columnOrder', 'columnWidths', 'conditions', 'hiddenColumns', 'order', 'pageSize']
    )
  })

  test('脏算子被丢弃，合法算子保留', () => {
    const v = plain(normalizeView({
      conditions: [
        { column: 'id', op: 'eq', value: '1' },
        { column: 'id', op: 'regexp', value: '1' }
      ]
    }))
    assert.deepEqual(v.conditions, [{ column: 'id', op: 'eq', value: '1' }])
  })

  test('脏 pageSize 归 undefined（正整数才留）', () => {
    assert.equal(normalizeView({ pageSize: 0 }).pageSize, undefined)
    assert.equal(normalizeView({ pageSize: -5 }).pageSize, undefined)
    assert.equal(normalizeView({ pageSize: 1.5 }).pageSize, undefined)
    assert.equal(normalizeView({ pageSize: 'abc' }).pageSize, undefined)
    assert.equal(normalizeView({ pageSize: 200 }).pageSize, 200)
    assert.equal(normalizeView({ pageSize: '500' }).pageSize, 500)
  })

  test('in 从逗号串转成数组，元素 trim 且丢空', () => {
    const v = plain(normalizeView({
      conditions: [{ column: 'id', op: 'in', value: ' 1, 2 ,, 3 ' }]
    }))
    assert.deepEqual(v.conditions, [{ column: 'id', op: 'in', value: ['1', '2', '3'] }])
  })

  test('条件超 20 条截断', () => {
    const conditions = Array.from({ length: 30 }, () => ({ column: 'id', op: 'eq', value: '1' }))
    const v = plain(normalizeView({ conditions }))
    assert.equal(v.conditions.length, 20)
  })

  test('hiddenColumns 丢空、非字符串丢弃', () => {
    const v = plain(normalizeView({ hiddenColumns: ['a', '', '  ', 5, 'b'] }))
    assert.deepEqual(v.hiddenColumns, ['a', 'b'])
  })

  test('columnWidths 只保留正数', () => {
    const v = plain(normalizeView({ columnWidths: { a: 120, b: 0, c: -3, d: 'x' } }))
    assert.deepEqual(v.columnWidths, { a: 120 })
  })

  test('order 的 desc 只认严格 true，且最多 3 列', () => {
    const v = plain(normalizeView({
      order: [
        { column: 'a', desc: 'true' },
        { column: 'b', desc: true },
        { column: 'c' },
        { column: 'id' }
      ]
    }))
    assert.deepEqual(v.order, [
      { column: 'a', desc: false },
      { column: 'b', desc: true },
      { column: 'c', desc: false }
    ])
  })

  test('isNull/notNull 不带 value 字段', () => {
    const v = plain(normalizeView({ conditions: [{ column: 'a', op: 'isNull', value: 'x' }] }))
    assert.deepEqual(v.conditions, [{ column: 'a', op: 'isNull' }])
  })
})
