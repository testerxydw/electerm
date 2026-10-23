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
  'viewKey, quoteIdent, materializeClause, parseClause, findClauseProblem, ' +
  'nextSortOrder })'

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
  quoteIdent,
  materializeClause,
  parseClause,
  findClauseProblem,
  nextSortOrder
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

// ---------------------------------------------------------------- 双模式（构建器 ⇄ SQL）
// materializeClause 与 parseClause 是一对互逆函数，测试分三层：
// 1) 具体化：字面量的每一种标量形态、方言差异、失败时原样返回；
// 2) 解析：只认规范形态，其余一律 null（绝不"尽力猜"）；
// 3) 往返：buildWhere → materialize → parse 必须回到 normalizeView 的等价条件。
// 第 3 层是双向契约里最值钱的一条：它同时钉住了两边的实现，谁单方面改口径都会红。
describe('db-grid-view: materializeClause（参数 → 字面量）', () => {
  test('字符串里的单引号成对加倍', () => {
    const built = buildWhere(viewOf([{ column: 'name', op: 'eq', value: "o'b" }]), COLS, 'mysql')
    assert.equal(built.clause, '`name` = ?')
    assert.equal(
      materializeClause(built.clause, built.params, 'mysql'),
      "`name` = 'o''b'"
    )
  })

  test('null → NULL / 布尔 → TRUE|FALSE / 数字不加引号', () => {
    assert.equal(materializeClause('`a` = ?', [null], 'mysql'), '`a` = NULL')
    assert.equal(materializeClause('`a` = ?', [true], 'mysql'), '`a` = TRUE')
    assert.equal(materializeClause('`a` = ?', [false], 'mysql'), '`a` = FALSE')
    assert.equal(materializeClause('`a` <> ?', [42], 'mysql'), '`a` <> 42')
    // 字符串 '42' 必须与数字 42 在文本上就分得清，否则回解析会把类型改掉
    assert.equal(materializeClause('`a` <> ?', ['42'], 'mysql'), "`a` <> '42'")
  })

  test('mysql 字符串里的反斜杠再加倍一次（反斜杠是 mysql 的转义符）', () => {
    assert.equal(materializeClause('`a` = ?', ['a\\b'], 'mysql'), '`a` = \'a\\\\b\'')
    // pg 的 standard_conforming_strings 默认开，反斜杠就是普通字符，不加倍、也不加 E 前缀
    assert.equal(materializeClause('"a" = $1', ['a\\b'], 'postgres'), '"a" = \'a\\b\'')
  })

  test('参数数量不符 → 原样返回子句（宁可难看，不生成一条错 SQL 让人以为是自己的条件）', () => {
    assert.equal(
      materializeClause('`a` = ? AND `b` = ?', ['1'], 'mysql'),
      '`a` = ? AND `b` = ?'
    )
    assert.equal(materializeClause('`a` = ?', ['1', '2'], 'mysql'), '`a` = ?')
    // 非标量值无法具体化 → 原样返回
    assert.equal(materializeClause('`a` = ?', [{ x: 1 }], 'mysql'), '`a` = ?')
    assert.equal(materializeClause('`a` = ?', [NaN], 'mysql'), '`a` = ?')
  })

  test('pg 按 $n 编号取值：乱序不吃错，越界/用不尽都原样返回', () => {
    assert.equal(
      materializeClause('"a" = $2 AND "b" = $1', ['x', 'y'], 'postgres'),
      '"a" = \'y\' AND "b" = \'x\''
    )
    // $3 越界
    assert.equal(materializeClause('"a" = $3', ['x'], 'postgres'), '"a" = $3')
    // 参数多了一个（$1 根本没被引用）→ 具体化出来的文本会少一个值
    assert.equal(materializeClause('"a" = $2', ['x', 'y'], 'postgres'), '"a" = $2')
    // pg 不收裸 ?（那是 mysql 的写法）
    assert.equal(materializeClause('"a" = ?', ['x'], 'postgres'), '"a" = ?')
  })

  test('引号区域里的 ? 不当占位符（列名 a?b / 值里的 ?）', () => {
    assert.equal(materializeClause('`a?b` = ?', ['v'], 'mysql'), "`a?b` = 'v'")
    assert.equal(materializeClause('`a` = ?', ['x?y'], 'mysql'), "`a` = 'x?y'")
  })
})

describe('db-grid-view: parseClause（字面量 → 条件体）', () => {
  test('等值 / 不等 / 比较算子', () => {
    assert.deepEqual(plain(parseClause("`name` = 'v'", COLS, 'mysql').conditions), [
      { column: 'name', op: 'eq', value: 'v' }
    ])
    assert.deepEqual(plain(parseClause('`age` <> 5', COLS, 'mysql').conditions), [
      { column: 'age', op: 'ne', value: '5' }
    ])
    assert.deepEqual(plain(parseClause('`age` >= 5', COLS, 'mysql').conditions), [
      { column: 'age', op: 'gte', value: '5' }
    ])
  })

  test('LIKE 三种通配位置反推回 contains / startsWith / endsWith', () => {
    const cases = [
      ["`name` LIKE '%v%'", 'contains'],
      ["`name` LIKE 'v%'", 'startsWith'],
      ["`name` LIKE '%v'", 'endsWith']
    ]
    for (const [text, op] of cases) {
      assert.deepEqual(
        plain(parseClause(text, COLS, 'mysql').conditions),
        [{ column: 'name', op, value: 'v' }],
        text
      )
    }
  })

  test('LIKE 模式里 % _ \\ 的转义被解开（与 escapeLike 互逆）', () => {
    // contains 'a%b' → escapeLike → %a\%b% ；mysql 具体化再把 \ 加倍
    const built = buildWhere(viewOf([{ column: 'name', op: 'contains', value: 'a%b' }]), COLS, 'mysql')
    const text = materializeClause(built.clause, built.params, 'mysql')
    assert.equal(text, "`name` LIKE '%a\\\\%b%'")
    assert.deepEqual(plain(parseClause(text, COLS, 'mysql').conditions), [
      { column: 'name', op: 'contains', value: 'a%b' }
    ])
  })

  test('IN 三项（数字回填成字符串，与 normalizeView 同口径）', () => {
    assert.deepEqual(plain(parseClause('`id` IN (1, 2, 3)', COLS, 'mysql').conditions), [
      { column: 'id', op: 'in', value: ['1', '2', '3'] }
    ])
    // 字符串元素里的逗号不参与切分
    assert.deepEqual(
      plain(parseClause("`name` IN ('a,b', 'c')", COLS, 'mysql').conditions),
      [{ column: 'name', op: 'in', value: ['a,b', 'c'] }]
    )
  })

  test('IS NULL / IS NOT NULL 不带 value 字段', () => {
    assert.deepEqual(plain(parseClause('`name` IS NULL', COLS, 'mysql').conditions), [
      { column: 'name', op: 'isNull' }
    ])
    assert.deepEqual(plain(parseClause('`name` IS NOT NULL', COLS, 'mysql').conditions), [
      { column: 'name', op: 'notNull' }
    ])
  })

  test('多条用 AND 连接，允许每条外层多裹括号', () => {
    const text = '(`age` >= 18) AND ((`name` LIKE \'%bo%\'))'
    assert.deepEqual(plain(parseClause(text, COLS, 'mysql').conditions), [
      { column: 'age', op: 'gte', value: '18' },
      { column: 'name', op: 'contains', value: 'bo' }
    ])
  })

  test('OR / 函数调用 / BETWEEN / 子查询 → null（绝不尽力猜）', () => {
    const bad = [
      '`age` = 1 OR 1 = 1',
      "`name` = lower('x')",
      '`age` BETWEEN 1 AND 2',
      '`id` IN (SELECT id FROM t)',
      "`name` LIKE '%a%b%'",
      '`name` = `other`',
      '1 = 1',
      '`age` = NULL',
      "`age` = '1' '2'"
    ]
    for (const text of bad) {
      assert.equal(parseClause(text, COLS, 'mysql'), null, text)
    }
  })

  test('列名必须命中白名单；未加引用符的裸列名不认', () => {
    assert.equal(parseClause("`nope` = 'v'", COLS, 'mysql'), null)
    assert.equal(parseClause("name = 'v'", COLS, 'mysql'), null)
    // 大小写不敏感，但回填白名单里的规范名
    assert.deepEqual(plain(parseClause("`NAME` = 'v'", COLS, 'mysql').conditions), [
      { column: 'name', op: 'eq', value: 'v' }
    ])
    // 没有列白名单 → 什么都不能确认
    assert.equal(parseClause("`name` = 'v'", [], 'mysql'), null)
  })

  test('空文本 → 空条件体（等价"无筛选"）；空白串同理', () => {
    assert.deepEqual(plain(parseClause('', COLS, 'mysql')), { conditions: [] })
    assert.deepEqual(plain(parseClause('   ', COLS, 'mysql')), { conditions: [] })
  })

  test('pg：双引号标识符 + $n 形态（具体化后已无占位符）', () => {
    assert.deepEqual(plain(parseClause('"name" = \'v\' AND "age" > 3', COLS, 'postgres').conditions), [
      { column: 'name', op: 'eq', value: 'v' },
      { column: 'age', op: 'gt', value: '3' }
    ])
    // 方言不匹配（mysql 的引用符喂给 pg）→ null
    assert.equal(parseClause("`name` = 'v'", COLS, 'postgres'), null)
  })

  test('往返契约：parseClause(materializeClause(buildWhere(v))) 与 normalizeView(v) 等价', () => {
    const v = {
      conditions: [
        { column: 'age', op: 'gte', value: '18' },
        { column: 'name', op: 'contains', value: "o'x" },
        { column: 'id', op: 'in', value: ['1', '2', '3'] },
        { column: 'created_at', op: 'notNull' }
      ]
    }
    const want = plain(normalizeView(v).conditions)
    for (const dialect of ['mysql', 'postgres']) {
      const built = buildWhere(v, COLS, dialect)
      const text = materializeClause(built.clause, built.params, dialect)
      const back = parseClause(text, COLS, dialect)
      assert.ok(back, dialect + ' 应能回解析: ' + text)
      assert.deepEqual(plain(back.conditions), want, dialect)
    }
  })
})

describe('db-grid-view: findClauseProblem（前端预检，非安全闸门）', () => {
  test('分号 / 注释 / 语句关键字被拒', () => {
    assert.equal(findClauseProblem('`a` = 1; DROP TABLE t', 'mysql'), 'semicolon')
    assert.equal(findClauseProblem('`a` = 1 -- x', 'mysql'), 'comment')
    assert.equal(findClauseProblem('`a` = 1 /* x */', 'mysql'), 'comment')
    assert.equal(findClauseProblem('1 = 1 # x', 'mysql'), 'comment')
    assert.equal(findClauseProblem('`a` = 1 AND DROP TABLE t', 'mysql'), 'keyword')
  })

  test('引号内的 ; -- # 与关键字不算（值匹配是合法的）', () => {
    assert.equal(findClauseProblem("`name` = 'a;--b#c'", 'mysql'), '')
    assert.equal(findClauseProblem("`name` = 'DROP TABLE t'", 'mysql'), '')
  })

  test('正常条件 / OR / 括号不配平 / 超长', () => {
    assert.equal(findClauseProblem("`a` = 'v' AND `b` IS NOT NULL", 'mysql'), '')
    assert.equal(findClauseProblem('`a` = 1 OR 1 = 1', 'mysql'), '')
    assert.equal(findClauseProblem('`a` = (1', 'mysql'), 'unbalanced')
    assert.equal(findClauseProblem('`a` = 1)', 'mysql'), 'unbalanced')
    assert.equal(findClauseProblem('`a` = ' + '1'.repeat(4200), 'mysql'), 'tooLong')
    assert.equal(findClauseProblem('', 'mysql'), '')
  })
})

describe('db-grid-view: nextSortOrder（chips 与列头共用同一条推进规则）', () => {
  test('升 → 降 → 移除', () => {
    let o = nextSortOrder([], 'id')
    assert.deepEqual(plain(o), [{ column: 'id', desc: false }])
    o = nextSortOrder(o, 'id')
    assert.deepEqual(plain(o), [{ column: 'id', desc: true }])
    o = nextSortOrder(o, 'id')
    assert.deepEqual(plain(o), [])
  })

  test('超过 3 列时丢掉最旧的一列', () => {
    const cur = [
      { column: 'a', desc: false },
      { column: 'b', desc: false },
      { column: 'c', desc: false }
    ]
    assert.deepEqual(plain(nextSortOrder(cur, 'id')), [
      { column: 'b', desc: false },
      { column: 'c', desc: false },
      { column: 'id', desc: false }
    ])
  })

  test('同一列大小写不敏感，重复点击不会插出两行', () => {
    assert.deepEqual(plain(nextSortOrder([{ column: 'ID', desc: false }], 'id')), [
      { column: 'id', desc: true }
    ])
    assert.deepEqual(plain(nextSortOrder([{ column: 'id', desc: true }], 'ID')), [])
  })

  test('空列名 / 脏输入不抛错', () => {
    assert.deepEqual(plain(nextSortOrder(null, '')), [])
    assert.deepEqual(plain(nextSortOrder([{ column: 'id', desc: true }], '')), [
      { column: 'id', desc: true }
    ])
  })
})
