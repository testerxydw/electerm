const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// F1 §8 外键引用侧栏纯计算（vm 加载真实源码、strip ESM，模块无外部依赖）
const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/components/database/db-ref-utils.js')

const loadMod = () => {
  const code = fs.readFileSync(SRC, 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+/gm, '')
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return ctx
}

// 复合外键场景：本表 child(a_id, b_id) → parent(a, b)
const compositeFk = {
  name: 'fk_c_p',
  columns: ['a_id', 'b_id'],
  refSchema: 'pub',
  refTable: 'parent',
  refColumns: ['a', 'b']
}

const singleFk = {
  name: 'fk_o_parent',
  columns: ['parent_id'],
  refSchema: 'pub',
  refTable: 'parent',
  refColumns: ['id']
}

const fk1 = {
  name: 'fk1',
  columns: ['parent_id'],
  refSchema: null,
  refTable: 'parent',
  refColumns: ['id']
}

const incomingSingle = {
  schema: 'pub',
  table: 'child',
  fkName: 'fk_child_parent',
  refTable: 'parent',
  refSchema: 'pub',
  columns: ['parent_id'],
  refColumns: ['id']
}

const incomingComposite = {
  schema: 'pub',
  table: 'child2',
  fkName: 'fk2',
  refTable: 'parent',
  refSchema: 'pub',
  columns: ['x_id', 'y_id'],
  refColumns: ['a', 'b']
}

const incomingMysql = {
  schema: 'shop',
  table: 'orders',
  fkName: 'fk_o_u',
  refTable: 'users',
  refSchema: null,
  columns: ['user_id'],
  refColumns: ['id']
}

describe('db-ref-utils buildRefItems（被引用父行方向）', () => {
  const { buildRefItems } = loadMod()

  test('单列外键：选中 fk 列 → 生成父表定位项', () => {
    const items = buildRefItems({
      column: 'parent_id',
      row: { parent_id: 7 },
      foreignKeys: [singleFk],
      references: [],
      database: 'db1',
      schema: 'pub',
      dialect: 'postgres'
    })
    assert.equal(items.length, 1)
    assert.equal(items[0].dir, 'parent')
    assert.deepEqual(items[0].whereColumns, ['id'])
    assert.deepEqual(items[0].whereValues, [7])
    assert.equal(items[0].target.table, 'parent')
    assert.equal(items[0].target.schema, 'pub')
    assert.equal(items[0].target.database, 'db1')
    assert.equal(items[0].unusable, '')
  })

  test('复合外键：全列等值（值取自当前行，天然全列可定位）', () => {
    const items = buildRefItems({
      column: 'a_id',
      row: { a_id: 1, b_id: 2 },
      foreignKeys: [compositeFk],
      references: [],
      database: 'db1',
      schema: 'pub',
      dialect: 'postgres'
    })
    assert.equal(items.length, 1)
    assert.deepEqual(items[0].whereColumns, ['a', 'b'])
    assert.deepEqual(items[0].whereValues, [1, 2])
  })

  test('选中列不属于外键 → 不生成父行项', () => {
    const items = buildRefItems({
      column: 'name',
      row: { name: 'x' },
      foreignKeys: [compositeFk],
      references: [],
      database: 'db1',
      schema: 'pub',
      dialect: 'mysql'
    })
    assert.equal(items.length, 0)
  })

  test('fk 值为 NULL / 二进制信封 → unusable 带原因', () => {
    const env = { __bin: { size: 3, b64: 'aaa', truncated: false } }
    const nullRow = buildRefItems({
      column: 'parent_id',
      row: { parent_id: null },
      foreignKeys: [fk1],
      references: [],
      database: 'db1',
      schema: '',
      dialect: 'mysql'
    })
    assert.equal(nullRow[0].unusable, 'dbRefNull')
    const binRow = buildRefItems({
      column: 'parent_id',
      row: { parent_id: env },
      foreignKeys: [fk1],
      references: [],
      database: 'db1',
      schema: '',
      dialect: 'mysql'
    })
    assert.equal(binRow[0].unusable, 'dbRefBinary')
  })
})

describe('db-ref-utils buildRefItems（引用子记录方向）', () => {
  const { buildRefItems } = loadMod()

  test('反向引用：refColumns 含选中列 → 生成子表项（目标=子表）', () => {
    const items = buildRefItems({
      column: 'id',
      row: { id: 42 },
      foreignKeys: [],
      references: [incomingSingle],
      database: 'db1',
      schema: 'pub',
      dialect: 'postgres'
    })
    assert.equal(items.length, 1)
    assert.equal(items[0].dir, 'child')
    assert.equal(items[0].target.table, 'child')
    assert.equal(items[0].target.schema, 'pub')
    assert.deepEqual(items[0].whereColumns, ['parent_id'])
    assert.deepEqual(items[0].whereValues, [42])
  })

  test('mysql 家族归一：子表 schema 进 database，schema 恒空串', () => {
    const items = buildRefItems({
      column: 'id',
      row: { id: 1 },
      foreignKeys: [],
      references: [incomingMysql],
      database: 'shop',
      schema: '',
      dialect: 'mysql'
    })
    assert.equal(items[0].target.database, 'shop')
    assert.equal(items[0].target.schema, '')
  })

  test('复合外键缺列值（行里没有）→ unusable=dbRefNull', () => {
    const items = buildRefItems({
      column: 'a',
      row: { a: 1 },
      foreignKeys: [],
      references: [incomingComposite],
      database: 'db1',
      schema: 'pub',
      dialect: 'postgres'
    })
    assert.equal(items.length, 1)
    assert.equal(items[0].unusable, 'dbRefNull')
  })
})

describe('db-ref-utils buildRefWhere', () => {
  const { buildRefWhere } = loadMod()

  test('mysql：反引号 + ? 占位符', () => {
    const w = buildRefWhere({
      whereColumns: ['a', 'b'],
      whereValues: [1, 'x']
    }, 'mysql')
    assert.equal(w.where, '`a` = ? AND `b` = ?')
    // vm-realm 数组与宿主 Array 非同构造函数：Array.from 搬回宿主再比较
    assert.deepEqual(Array.from(w.whereParams), [1, 'x'])
  })

  test('pg：双引号 + $n 连续编号', () => {
    const w = buildRefWhere({
      whereColumns: ['a"b'],
      whereValues: [7]
    }, 'postgres')
    assert.equal(w.where, '"a""b" = $1')
    assert.deepEqual(Array.from(w.whereParams), [7])
  })

  test('NULL 值转 IS NULL 且不占占位符', () => {
    const w = buildRefWhere({
      whereColumns: ['a', 'b'],
      whereValues: [null, 3]
    }, 'mysql')
    assert.equal(w.where, '`a` IS NULL AND `b` = ?')
    assert.deepEqual(Array.from(w.whereParams), [3])
  })

  test('对象值（二进制信封）→ 返回 null 由调用方禁用查询', () => {
    const w = buildRefWhere({
      whereColumns: ['a'],
      whereValues: [{ __bin: { size: 1, b64: 'x', truncated: false } }]
    }, 'mysql')
    assert.equal(w, null)
  })

  test('列值长度不一致 → null', () => {
    const w = buildRefWhere({ whereColumns: ['a'], whereValues: [] }, 'mysql')
    assert.equal(w, null)
  })
})
