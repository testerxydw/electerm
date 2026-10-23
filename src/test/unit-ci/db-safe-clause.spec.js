// E2 条件体的主进程二次校验（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.3）
//
// 这里直接 require src 下的同一份源码（CJS，无需 vm）：
// 校验规则的判据（黑名单词、函数白名单、掩码规则）必须与主进程实际执行的完全一致，
// 一旦测试里另抄一份"等价实现"，测试就会在实现退化时照样全绿。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SAFE = require(path.join(ROOT, 'src/app/lib/db-client/safe-clause.js'))

const { assertSafeClause, assertSafeOrderClauses, FN_WHITELIST } = SAFE

// 列白名单：故意不包含 version / pg_sleep 之类的"注入常见载体"，
// 这样才能验证"没在白名单里的标识符一律拒绝"这条规则本身
const COLS = ['id', 'name', 'age', 'a', 'b', 'c', 'created_at', 'status']

const rejects = (clause, dialect) => assert.throws(
  () => assertSafeClause(clause, COLS, dialect || 'mysql'),
  Error,
  '应当被拒绝: ' + clause
)

const accepts = (clause, dialect) => assertSafeClause(clause, COLS, dialect || 'mysql')

describe('db-safe-clause: 注入样本必须被拒', () => {
  const samples = [
    '1=1; DROP TABLE t',
    '1=1 --',
    '1=1 /* x */',
    '1=1 #x',
    '(1=1',
    '1=1)',
    "name = 'x' OR SELECT 1",
    'EXISTS(SELECT 1)',
    'id UNION SELECT 1',
    '1; DELETE FROM t',
    'pg_sleep(10)=0',
    '@@version',
    'a = 1 AND (b=2',
    'id IN (1,2); UPDATE t SET x=1',
    'name = 1 INTO OUTFILE',
    'a = 1 /* 注释藏语句 */'
  ]

  for (const sample of samples) {
    test('拒绝: ' + sample, () => {
      rejects(sample, 'mysql')
    })
  }

  test('超过 4000 字符被拒，且错误信息可读', () => {
    const long = 'a = 1 AND '.repeat(450)
    assert.ok(long.length > 4000)
    assert.throws(
      () => assertSafeClause(long, COLS, 'mysql'),
      /条件体过长（最大 4000 字符）/
    )
  })

  test('错误信息指出具体的关键词/列名（能直接给终端用户看）', () => {
    assert.throws(() => assertSafeClause('id UNION SELECT 1', COLS, 'mysql'), /关键词: UNION/)
    assert.throws(() => assertSafeClause('nope = 1', COLS, 'mysql'), /不存在的列: nope/)
    assert.throws(() => assertSafeClause('(a = 1', COLS, 'mysql'), /括号不配平/)
    assert.throws(() => assertSafeClause('a = 1; b = 2', COLS, 'mysql'), /分号/)
  })

  test('非字符串条件体被拒', () => {
    assert.throws(() => assertSafeClause({ a: 1 }, COLS, 'mysql'), /必须是字符串/)
    assert.throws(() => assertSafeClause(undefined, COLS, 'mysql'), /必须是字符串/)
  })

  test('白名单外函数被拒（只有 FN_WHITELIST 里的函数可用）', () => {
    assert.throws(() => assertSafeClause('pg_sleep(1) = 0', COLS, 'postgres'), /不存在的列: pg_sleep/)
    assert.ok(FN_WHITELIST.includes('upper'))
  })
})

describe('db-safe-clause: 合规样本放行', () => {
  test('`a` = ? （引用标识符 + 占位符）', () => {
    const r = accepts('`a` = ?', 'mysql')
    assert.equal(r.placeholders, 1)
  })

  test('a IS NULL', () => {
    assert.equal(accepts('a IS NULL', 'mysql').placeholders, 0)
  })

  test('a LIKE ?', () => {
    assert.equal(accepts('a LIKE ?', 'mysql').placeholders, 1)
  })

  test('(a = ? AND b > ?) OR c IS NOT NULL → 2 个占位符', () => {
    assert.equal(accepts('(a = ? AND b > ?) OR c IS NOT NULL', 'mysql').placeholders, 2)
  })

  test('UPPER(name) LIKE ? （函数白名单）', () => {
    assert.equal(accepts('UPPER(name) LIKE ?', 'mysql').placeholders, 1)
  })

  test('a IN (?, ?) → 2 个占位符', () => {
    assert.equal(accepts('a IN (?, ?)', 'mysql').placeholders, 2)
  })

  test('字符串字面量里的分号与注释不触发拒绝（掩码生效）', () => {
    assert.equal(accepts("a = 'x;--y'", 'mysql').placeholders, 0)
    assert.equal(accepts("a = 'DROP TABLE t'", 'mysql').placeholders, 0)
    assert.equal(accepts("a = 'a/*b*/c'", 'mysql').placeholders, 0)
    assert.equal(accepts("a = 'x#y'", 'mysql').placeholders, 0)
  })

  test('BETWEEN / NOT / OR / TRUE / FALSE 等语法词放行', () => {
    assert.equal(accepts('a BETWEEN ? AND ?', 'mysql').placeholders, 2)
    assert.equal(accepts('NOT a = ?', 'mysql').placeholders, 1)
    assert.equal(accepts('a = TRUE OR b = FALSE', 'mysql').placeholders, 0)
  })

  test('列清单可以是 {name} 对象', () => {
    const r = assertSafeClause('a = ?', [{ name: 'a' }], 'mysql')
    assert.equal(r.placeholders, 1)
  })
})

describe('db-safe-clause: CAST 与类型词（白名单里的函数必须真能用）', () => {
  test('CAST(id AS char) 可用 —— AS 与类型词都要放行', () => {
    const r = accepts('CAST(id AS char) = ?', 'mysql')
    assert.equal(r.placeholders, 1)
  })

  test('id = CAST(? AS SIGNED)（mysql 的强转惯用写法）', () => {
    assert.equal(accepts('id = CAST(? AS SIGNED)', 'mysql').placeholders, 1)
  })

  test('pg 的 cast 写法同样可用', () => {
    assert.equal(accepts('CAST(created_at AS date) = $1', 'postgres').placeholders, 1)
  })

  test('COALESCE(name, ?) = ? 多参数函数计数正确', () => {
    assert.equal(accepts('COALESCE(name, ?) = ?', 'mysql').placeholders, 2)
  })

  test('类型词被当列名时不误判为注入（失败方向交给数据库）', () => {
    // 表里真有一列叫 char/date 时：本地放行、由数据库报语法错 —— 见 TYPE_WORDS 注释
    assert.equal(accepts('char = 1', 'mysql').placeholders, 0)
    assert.equal(accepts('date = $1', 'postgres').placeholders, 1)
  })

  test('类型词表是有限集：瞎写的类型名仍被拒（错误指向那个词）', () => {
    assert.throws(
      () => assertSafeClause('CAST(id AS evil_type) = 1', COLS, 'mysql'),
      /不存在的列: evil_type/
    )
  })

  test('引用符包起来的语法词/类型词必须走列白名单', () => {
    assert.throws(
      () => assertSafeClause('`AS` = 1', COLS, 'mysql'),
      /不存在的列: AS/
    )
  })
})

describe('db-safe-clause: 方言差异', () => {
  test('pg 的 E 字符串（含反斜杠转义）放行', () => {
    const clause = "a = E'x\\'y'"
    assert.equal(accepts(clause, 'postgres').placeholders, 0)
  })

  test('mysql 的双引号是字符串字面量，不是标识符', () => {
    // "a" 在 mysql 是值，因此 `"a" = 1` 是字面量比较，不该报"未知列 a"
    const r = accepts('"a" = 1', 'mysql')
    assert.equal(r.placeholders, 0)
  })

  test('pg 的双引号是标识符，同样走白名单', () => {
    assert.equal(assertSafeClause('"a" = $1', COLS, 'postgres').placeholders, 1)
    assert.throws(
      () => assertSafeClause('"nope" = $1', COLS, 'postgres'),
      /不存在的列: nope/
    )
  })

  test('mysql 的 # 注释被拒（pg 同样按不安全处理）', () => {
    assert.throws(() => assertSafeClause('a = 1 #c', COLS, 'mysql'), /注释/)
    assert.throws(() => assertSafeClause('a = 1 #c', COLS, 'postgres'), /注释/)
  })

  test('pg 的 $tag$...$tag$ 内部的 ; 不触发拒绝', () => {
    assert.equal(accepts('a = $tag$ ; $tag$', 'postgres').placeholders, 0)
    assert.equal(accepts('a = $$ ; $$', 'postgres').placeholders, 0)
  })

  test('pg 的 $1 占位符不能被当成 dollar-quote', () => {
    assert.equal(accepts('a = $1 AND b = $2', 'postgres').placeholders, 2)
  })
})

describe('db-safe-clause: 占位符计数', () => {
  test('mysql 数 ? 的个数', () => {
    assert.equal(accepts('a = ? AND b IN (?, ?)', 'mysql').placeholders, 3)
  })

  test('pg 返回最大编号', () => {
    assert.equal(accepts('a = $1 AND b = $2 AND c = $3', 'postgres').placeholders, 3)
  })

  test('pg 缺号被拒（$1 与 $3 缺 $2）', () => {
    assert.throws(
      () => assertSafeClause('a = $1 AND b = $3', COLS, 'postgres'),
      /占位符编号不连续: 缺少 \$2/
    )
  })

  test('方言与占位符形式不匹配被拒', () => {
    assert.throws(() => assertSafeClause('a = $1', COLS, 'mysql'), /\? 形式/)
    assert.throws(() => assertSafeClause('a = ?', COLS, 'postgres'), /\$n 形式/)
  })
})

describe('db-safe-clause: assertSafeOrderClauses', () => {
  test('单列/多列合规', () => {
    assertSafeOrderClauses([{ column: 'id', desc: true }], COLS, 'mysql')
    assertSafeOrderClauses([{ column: 'id' }, { column: 'name', desc: false }], COLS, 'mysql')
  })

  test('null / undefined 直接通过（旧前端不传）', () => {
    assertSafeOrderClauses(null, COLS, 'mysql')
    assertSafeOrderClauses(undefined, COLS, 'mysql')
  })

  test('未知列被拒', () => {
    assert.throws(
      () => assertSafeOrderClauses([{ column: 'nope' }], COLS, 'mysql'),
      /排序引用了不存在的列: nope/
    )
  })

  test('表达式被拒（排序只接受单列名）', () => {
    assert.throws(
      () => assertSafeOrderClauses([{ column: 'a+1' }], COLS, 'mysql'),
      /不能是表达式: a\+1/
    )
    assert.throws(
      () => assertSafeOrderClauses([{ column: 'RAND()' }], COLS, 'mysql'),
      /不能是表达式: RAND\(\)/
    )
  })

  test('非数组被拒（渲染层传字符串也不行）', () => {
    assert.throws(() => assertSafeOrderClauses('id', COLS, 'mysql'), /必须是数组/)
  })

  test('超过 3 列被拒', () => {
    assert.throws(() => assertSafeOrderClauses([
      { column: 'id' }, { column: 'name' }, { column: 'age' }, { column: 'a' }
    ], COLS, 'mysql'), /最多 3 列/)
  })
})

// ---------------------------------------------------------- 跨模块契约（关键）
// 渲染层 buildWhere 的产出必须**全部**能过主进程 assertSafeClause，
// 且占位符数与 params.length 相等。两边各写对、合起来不通，是这一轮最容易漏的缺陷：
// 单测各自全绿，真机一用就"条件被拒"。所以这里直接拿实现的输出去喂实现。
const fs = require('node:fs')
const vm = require('node:vm')

const VIEW_FILE = path.join(ROOT, 'src/client/common/db-grid-view.js')

function loadGridView () {
  const src = fs.readFileSync(VIEW_FILE, 'utf8').replace(/^export /gm, '')
  const sandbox = { Map, Set, Array, Object, Number, String, Math, JSON, RegExp, Boolean }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n({ buildWhere, buildOrderBy })', sandbox)
}

const { buildWhere, buildOrderBy } = loadGridView()

// 覆盖每个算子；值里带 % _ \ 是为了让 LIKE 转义也进这条契约
const OP_SAMPLES = [
  { column: 'a', op: 'eq', value: "o'k" },
  { column: 'b', op: 'ne', value: '0' },
  { column: 'age', op: 'gt', value: '1' },
  { column: 'age', op: 'gte', value: '1' },
  { column: 'age', op: 'lt', value: '1' },
  { column: 'age', op: 'lte', value: '1' },
  { column: 'name', op: 'contains', value: 'a%b_c\\d' },
  { column: 'name', op: 'startsWith', value: 'DROP TABLE' },
  { column: 'name', op: 'endsWith', value: ';--' },
  { column: 'id', op: 'in', value: ['1', '2', '3'] },
  { column: 'c', op: 'isNull' },
  { column: 'c', op: 'notNull' }
]

describe('db-safe-clause × db-grid-view: 生成的片段必须过校验', () => {
  for (const dialect of ['mysql', 'postgres']) {
    test(dialect + '：全部算子逐个通过校验，占位符数=参数数', () => {
      for (const sample of OP_SAMPLES) {
        const { clause, params, rejected } = buildWhere({ conditions: [sample] }, COLS, dialect)
        assert.equal(rejected.length, 0, '合法条件不该被丢弃: ' + JSON.stringify(sample))
        const r = assertSafeClause(clause, COLS, dialect)
        assert.equal(r.placeholders, params.length, '占位符与参数必须一一对应: ' + clause)
      }
    })

    test(dialect + '：多条件混合（含三元素 IN）也通过', () => {
      const { clause, params } = buildWhere({
        conditions: [
          { column: 'age', op: 'gte', value: '18' },
          { column: 'id', op: 'in', value: ['a', 'b', 'c'] },
          { column: 'name', op: 'startsWith', value: 'x' },
          { column: 'c', op: 'isNull' }
        ]
      }, COLS, dialect)
      const r = assertSafeClause(clause, COLS, dialect)
      assert.equal(r.placeholders, params.length)
    })

    test(dialect + '：值得写成字面量的极端值也通过（值永远走绑定）', () => {
      const nasty = "1=1; DROP TABLE t -- /* # ' \" $$"
      const { clause, params } = buildWhere({
        conditions: [{ column: 'name', op: 'eq', value: nasty }]
      }, COLS, dialect)
      assert.equal(params[0], nasty, '值必须原样绑定，不被裁剪')
      const r = assertSafeClause(clause, COLS, dialect)
      assert.equal(r.placeholders, 1)
    })

    test(dialect + '：buildOrderBy 的产出能过排序校验', () => {
      const order = buildOrderBy({
        order: [{ column: 'id', desc: true }, { column: 'name', desc: false }]
      }, COLS, dialect)
      assert.ok(order)
      const expr = order.split(', ').map(part => {
        const [name] = part.split(' ')
        return { column: name.replace(/[`"]/g, '') }
      })
      assertSafeOrderClauses(expr, COLS, dialect)
    })

    test(dialect + '：250 项 IN → 200 个占位符全过校验，且只报 truncated', () => {
      const values = Array.from({ length: 250 }, (_, i) => String(i))
      const { clause, params, rejected, truncated } = buildWhere({
        conditions: [{ column: 'id', op: 'in', value: values }]
      }, COLS, dialect)
      assert.equal(rejected.length, 0, '生效了的条件不能算"未生效"')
      assert.equal(truncated.length, 1)
      const r = assertSafeClause(clause, COLS, dialect)
      assert.equal(r.placeholders, 200)
      assert.equal(r.placeholders, params.length)
    })
  }
})
