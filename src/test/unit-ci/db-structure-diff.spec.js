/**
 * H4 结构对比纯函数：方言折叠 / 类型别名 / 默认值四态 / 索引列序 / FK 引用变化 / 报告
 *
 * 对比的失败方向有两个：漏报（真差异被判相同，人以为两张表一致）和误报
 * （同义写法被当成差异，报告全是噪声）。两边都钉住：同义词表只收文档里的
 * 同义写法，其余一律按原值比较。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/db-structure-diff.js')
let D
before(async () => {
  D = await import('file://' + MOD)
})

const COL = (name, extra = {}) => ({
  name,
  columnType: 'int(11)',
  dataType: 'int',
  nullable: false,
  defaultValue: null,
  comment: null,
  isPrimaryKey: false,
  ordinal: 1,
  maxLength: null,
  ...extra
})

const IDX = (name, columns, extra = {}) => ({
  name,
  unique: false,
  primary: false,
  columns,
  method: 'BTREE',
  ...extra
})

const FK = (name, columns, refTable, refColumns, extra = {}) => ({
  name,
  columns,
  refSchema: null,
  refTable,
  refColumns,
  onDelete: 'NO ACTION',
  onUpdate: 'NO ACTION',
  ...extra
})

const STRUCT = (over = {}) => ({
  type: 'table',
  columns: [COL('id', { isPrimaryKey: true })],
  indexes: [IDX('PRIMARY', ['id'], { primary: true, unique: true })],
  foreignKeys: [],
  comment: null,
  estimatedRows: 100,
  ...over
})

const find = (list, name) => list.find(e => e.name === name)

describe('normalizeType 类型归一', () => {
  test('同义写法折叠（mysql integer → int，pg int8 → bigint）', () => {
    assert.equal(D.normalizeType('INTEGER', 'mysql'), 'int')
    assert.equal(D.normalizeType('int8', 'postgres'), 'bigint')
    assert.equal(D.normalizeType('character varying(64)', 'postgres'), 'varchar(64)')
  })

  test('长度/无符号参与比较，空白与大小写不参与', () => {
    assert.equal(D.normalizeType('VARCHAR( 64 )', 'mysql'), 'varchar(64)')
    assert.notEqual(D.normalizeType('varchar(64)', 'mysql'), D.normalizeType('varchar(32)', 'mysql'))
    assert.equal(D.normalizeType('INT(11) UNSIGNED', 'mysql'), 'int(11)unsigned')
  })

  test('跨类型不折叠：int 与 bigint、char 与 varchar 都是差异', () => {
    assert.notEqual(D.normalizeType('int', 'mysql'), D.normalizeType('bigint', 'mysql'))
    assert.notEqual(D.normalizeType('char(10)', 'mysql'), D.normalizeType('varchar(10)', 'mysql'))
  })
})

describe('normalizeDefault 默认值四态', () => {
  test('null 与空串不是一回事', () => {
    assert.notEqual(D.normalizeDefault(null), D.normalizeDefault(''))
  })

  test('函数默认值大小写与尾括号不敏感', () => {
    assert.equal(D.normalizeDefault('CURRENT_TIMESTAMP'), D.normalizeDefault('current_timestamp()'))
    assert.equal(D.normalizeDefault('CURRENT_DATE'), D.normalizeDefault('current_date()'))
    assert.equal(D.normalizeDefault('now()'), D.normalizeDefault('NOW()'))
  })

  test('字面量区分大小写（Admin 与 admin 是两个默认值）', () => {
    assert.notEqual(D.normalizeDefault('Admin'), D.normalizeDefault('admin'))
    assert.equal(D.normalizeDefault(0), D.normalizeDefault('0'))
  })
})

describe('foldName 名称折叠', () => {
  test('mysql 不敏感、pg 敏感', () => {
    assert.equal(D.foldName('Users', 'mysql'), D.foldName('users', 'mysql'))
    assert.notEqual(D.foldName('Users', 'postgres'), D.foldName('users', 'postgres'))
  })
})

describe('diffTableStructure 列差异', () => {
  test('完全一致：全部 equal，changed 为 0', () => {
    const d = D.diffTableStructure(STRUCT(), STRUCT(), { dialect: 'mysql' })
    assert.equal(d.summary.changed, 0)
    assert.equal(d.summary.added, 0)
    assert.equal(d.summary.removed, 0)
    assert.equal(d.columns.every(e => e.status === 'equal'), true)
  })

  test('新增列（只在 B）与删除列（只在 A）方向不反', () => {
    const a = STRUCT()
    const b = STRUCT({ columns: [COL('id'), COL('email')] })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.equal(find(d.columns, 'email').status, 'added')
    assert.equal(find(d.columns, 'email').base, null)
    assert.equal(find(d.columns, 'email').target.name, 'email')
    // 反向对比：同一对结构，方向跟着 base/target 换
    const r = D.diffTableStructure(b, a, { dialect: 'mysql' })
    assert.equal(find(r.columns, 'email').status, 'removed')
  })

  test('改了类型/可空/默认/注释：字段级列出，原始值带在条目里', () => {
    const a = STRUCT({ columns: [COL('name', { columnType: 'varchar(64)', maxLength: 64 })] })
    const b = STRUCT({
      columns: [COL('name', {
        columnType: 'varchar(128)',
        maxLength: 128,
        nullable: true,
        defaultValue: 'x',
        comment: '名字'
      })]
    })
    const e = find(D.diffTableStructure(a, b, { dialect: 'mysql' }).columns, 'name')
    assert.equal(e.status, 'changed')
    assert.deepEqual(e.fields.map(f => f.key).sort(), ['comment', 'default', 'length', 'nullable', 'type'])
    const typeField = e.fields.find(f => f.key === 'type')
    assert.equal(typeField.base, 'varchar(64)')
    assert.equal(typeField.target, 'varchar(128)')
  })

  test('大小写不同的列名在 mysql 下按同一列比较', () => {
    const a = STRUCT({ columns: [COL('Name')] })
    const b = STRUCT({ columns: [COL('name')] })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.equal(d.columns.length, 1)
    assert.equal(d.columns[0].status, 'equal')
    // pg 下是两列：一增一减
    const p = D.diffTableStructure(a, b, { dialect: 'postgres' })
    assert.equal(find(p.columns, 'Name').status, 'removed')
    assert.equal(find(p.columns, 'name').status, 'added')
  })

  test('estimatedRows / isPrimaryKey 这类不参与比较的字段不制造差异', () => {
    const a = STRUCT({ estimatedRows: 1 })
    const b = STRUCT({ estimatedRows: 99999, columns: [COL('id', { isPrimaryKey: false })] })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.equal(d.summary.changed, 0)
  })
})

describe('diffTableStructure 索引差异', () => {
  test('列顺序参与比较：(a,b) 与 (b,a) 不是同一个索引', () => {
    const a = STRUCT({ indexes: [IDX('idx_ab', ['a', 'b'])] })
    const b = STRUCT({ indexes: [IDX('idx_ab', ['b', 'a'])] })
    const e = find(D.diffTableStructure(a, b, { dialect: 'mysql' }).indexes, 'idx_ab')
    assert.equal(e.status, 'changed')
    assert.deepEqual(e.fields.map(f => f.key), ['columns'])
  })

  test('唯一性与方法变化都算差异', () => {
    const a = STRUCT({ indexes: [IDX('idx_x', ['x'])] })
    const b = STRUCT({ indexes: [IDX('idx_x', ['x'], { unique: true, method: 'HASH' })] })
    const e = find(D.diffTableStructure(a, b, { dialect: 'mysql' }).indexes, 'idx_x')
    assert.deepEqual(e.fields.map(f => f.key), ['unique', 'method'])
  })

  test('唯一索引在一边缺失时是一增一减，不是 changed', () => {
    const a = STRUCT({ indexes: [] })
    const b = STRUCT({ indexes: [IDX('idx_x', ['x'])] })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.equal(d.sections.indexes.added, 1)
    assert.equal(d.sections.indexes.removed, 0)
  })
})

describe('diffTableStructure 外键差异', () => {
  test('引用表/引用列/级联动作任一变化都报差异，且列顺序敏感', () => {
    const a = STRUCT({ foreignKeys: [FK('fk_u', ['user_id'], 'users', ['id'], { onDelete: 'CASCADE' })] })
    const b = STRUCT({ foreignKeys: [FK('fk_u', ['user_id'], 'users', ['uid'], { onDelete: 'RESTRICT' })] })
    const e = find(D.diffTableStructure(a, b, { dialect: 'mysql' }).foreignKeys, 'fk_u')
    assert.equal(e.status, 'changed')
    assert.deepEqual(e.fields.map(f => f.key).sort(), ['onDelete', 'refColumns'])
  })

  test('MySQL 下引用表名大小写不敏感，PG 下敏感', () => {
    const a = STRUCT({ foreignKeys: [FK('fk_u', ['user_id'], 'Users', ['id'])] })
    const b = STRUCT({ foreignKeys: [FK('fk_u', ['user_id'], 'users', ['id'])] })
    assert.equal(D.diffTableStructure(a, b, { dialect: 'mysql' }).summary.changed, 0)
    assert.equal(D.diffTableStructure(a, b, { dialect: 'postgres' }).summary.changed, 1)
  })
})

describe('diffTableStructure 排序与汇总', () => {
  test('条目按 added → removed → changed → equal 排列，同状态按名称', () => {
    const a = STRUCT({
      columns: [COL('a'), COL('b'), COL('c')],
      indexes: [],
      foreignKeys: []
    })
    const b = STRUCT({
      columns: [COL('b', { columnType: 'bigint(20)' }), COL('c'), COL('z')],
      indexes: [],
      foreignKeys: []
    })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.deepEqual(d.columns.map(e => e.name), ['z', 'a', 'b', 'c'])
    assert.deepEqual(d.columns.map(e => e.status), ['added', 'removed', 'changed', 'equal'])
  })

  test('sections 与 summary 的口径一致', () => {
    const a = STRUCT({
      columns: [COL('id'), COL('gone')],
      indexes: [IDX('PRIMARY', ['id'], { primary: true, unique: true })],
      foreignKeys: []
    })
    const b = STRUCT({
      columns: [COL('id'), COL('fresh')],
      indexes: [IDX('PRIMARY', ['id'], { primary: true, unique: true })],
      foreignKeys: [FK('fk_x', ['id'], 'other', ['id'])]
    })
    const d = D.diffTableStructure(a, b, { dialect: 'mysql' })
    assert.deepEqual(d.sections.columns, { added: 1, removed: 1, changed: 0, equal: 1, total: 3 })
    assert.deepEqual(d.sections.foreignKeys, { added: 1, removed: 0, changed: 0, equal: 0, total: 1 })
    assert.equal(d.summary.total, d.sections.columns.total + d.sections.indexes.total + d.sections.foreignKeys.total)
    assert.equal(d.summary.added, 2)
    assert.equal(d.summary.removed, 1)
  })
})

describe('diffToMarkdown 报告', () => {
  test('标题与概览带 A/B 标签，差异按节列出', () => {
    const a = STRUCT()
    const b = STRUCT({ columns: [COL('id', { columnType: 'bigint(20)' })] })
    const diff = D.diffTableStructure(a, b, { dialect: 'mysql' })
    const md = D.diffToMarkdown({
      baseLabel: 'db.t1',
      targetLabel: 'db.t2',
      diff,
      base: a,
      target: b
    })
    assert.match(md, /^# 结构对比/m)
    assert.match(md, /A（基准）：`db\.t1`/)
    assert.match(md, /B（对比）：`db\.t2`/)
    assert.match(md, /\| 列 \| 0 \| 0 \| 1 \| \d+ \|/)
    assert.match(md, /### 有差异/)
    assert.match(md, /\| id \| 类型 \| int\(11\) \| bigint\(20\) \|/)
    assert.match(md, /## 索引[\s\S]*无差异/)
    // 只描述、不生成 DDL
    assert.equal(/ALTER|CREATE |DROP /i.test(md), false)
  })

  test('单元格里的竖线被转义，不撑破表格', () => {
    const a = STRUCT()
    const b = STRUCT({ columns: [COL('id', { comment: 'a|b' })] })
    const md = D.diffToMarkdown({
      baseLabel: 't1',
      targetLabel: 't2',
      diff: D.diffTableStructure(a, b, { dialect: 'mysql' })
    })
    assert.match(md, /a\\\|b/)
  })

  test('完全一致时每节都写无差异', () => {
    const md = D.diffToMarkdown({
      baseLabel: 't1',
      targetLabel: 't2',
      diff: D.diffTableStructure(STRUCT(), STRUCT(), { dialect: 'mysql' })
    })
    assert.equal((md.match(/无差异/g) || []).length, 3)
  })
})
