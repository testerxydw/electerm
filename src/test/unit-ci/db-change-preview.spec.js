/**
 * N2 第 1 步单测：变更预览语句构造 + 变更集模型（全是纯函数，不碰 DOM/IPC）。
 *
 * 断言取向：
 * - 预览文本**逐字钉死**：这串文字既进 E1 危险确认弹窗，也进变更面板，
 *   两处必须一模一样；哪天有人改了拼接，这里先炸，而不是用户在两个地方
 *   看到两种说法。
 * - 变更集只断"粒度/合并/顺序/边界"，不断渲染。
 */
import assert from 'assert'
import { test } from 'node:test'
import {
  updateCellPreview,
  insertRowPreview,
  deleteRowsPreview,
  bulkUpdatePreview,
  replacePreview
} from '../../client/common/db-change-preview.js'
import {
  createChangeSet,
  stageCell,
  stageCells,
  stageInsert,
  stageDelete,
  dropChange,
  dropGroup,
  clearChangeSet,
  countChanges,
  hasChanges,
  hasCellChangeOnRow,
  listChanges,
  planSubmit,
  buildInsertPayload,
  canSubmitInsertForm,
  groupKeyOf,
  canStage,
  ROW_OP_LIMIT
} from '../../client/common/db-change-set.js'

const sel = { database: 'db1', schema: '', table: 'note_t' }
const selPg = { database: 'app', schema: 'public', table: 't_order' }

// ---- 预览语句：与搬走前逐字一致 ----

test('updateCellPreview：WHERE 只含主键，文本口径与旧确认弹窗一致', () => {
  assert.strictEqual(
    updateCellPreview({
      sel,
      pkColumn: 'id',
      pkValue: 3,
      column: 'body',
      value: 'hello'
    }),
    "UPDATE db1.note_t SET body = 'hello' WHERE id = '3'"
  )
})

test('updateCellPreview：NULL 显式可见，长值截断而不是刷屏', () => {
  assert.strictEqual(
    updateCellPreview({ sel, pkColumn: 'id', pkValue: 1, column: 'body', value: null }),
    'UPDATE db1.note_t SET body = NULL WHERE id = \'1\''
  )
  const long = 'x'.repeat(80)
  assert.ok(
    updateCellPreview({ sel, pkColumn: 'id', pkValue: 1, column: 'b', value: long })
      .includes('x'.repeat(60) + '…')
  )
})

test('insertRowPreview：列清单与值清单原样并列（留空列由调用方已剔除）', () => {
  assert.strictEqual(
    insertRowPreview({ sel, cols: ['body', 'tag'], vals: ['\'a, b\'', 'NULL'] }),
    "INSERT INTO db1.note_t (body, tag) VALUES ('a, b', NULL)"
  )
})

test('deleteRowsPreview：主键清单最多显示 10 个，超出省略', () => {
  assert.strictEqual(
    deleteRowsPreview({ sel, pkColumn: 'id', pkValues: [1, 2] }),
    'DELETE FROM db1.note_t WHERE id IN (\'1\', \'2\')'
  )
  const many = deleteRowsPreview({
    sel,
    pkColumn: 'id',
    pkValues: Array.from({ length: 12 }, (_, i) => i + 1)
  })
  assert.ok(many.endsWith(', …)'), many)
  assert.strictEqual(many.split("'").length - 1, 20)
})

test('bulkUpdatePreview / replacePreview：IN 清单口径沿用 previewKeyList', () => {
  assert.strictEqual(
    bulkUpdatePreview({ sel, column: 'tag', value: 'x', pkColumn: 'id', pks: [1, 2] }),
    'UPDATE db1.note_t SET tag = \'x\' WHERE id IN (1, 2)'
  )
  assert.strictEqual(
    replacePreview({
      sel, column: 'body', find: 'a', replace: 'b', pkColumn: 'id', pks: [7]
    }),
    "UPDATE db1.note_t SET body = replace(body, 'a', 'b') WHERE id IN (7)"
  )
})

test('预览：连接无默认库时只显示表名', () => {
  assert.strictEqual(
    updateCellPreview({
      sel: { database: '', table: 't' },
      pkColumn: 'id',
      pkValue: 1,
      column: 'c',
      value: 'v'
    }),
    "UPDATE t SET c = 'v' WHERE id = '1'"
  )
})

// ---- 变更集：粒度、合并、互斥 ----

test('stageCell：同格重复暂存只覆盖不累加；不同列各算一条', () => {
  let s = createChangeSet()
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'a' }).set
  const r = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'b' })
  s = r.set
  assert.strictEqual(r.merged, true)
  assert.strictEqual(countChanges(s), 1)
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'tag', value: 't' }).set
  assert.strictEqual(countChanges(s), 2)
  const items = listChanges(s)[0].items
  assert.deepStrictEqual(items.map(i => i.column), ['body', 'tag'])
  assert.ok(items[0].sql.includes("'b'"), '覆盖后预览显示最新值')
})

test('stageCell：主键值不可用（null/undefined/空串）一律拒绝', () => {
  const s = createChangeSet()
  ;[null, undefined, ''].forEach(pk => {
    const r = stageCell(s, { target: sel, pkColumn: 'id', pkValue: pk, column: 'body', value: 'v' })
    assert.strictEqual(r.ok, false, String(pk))
    assert.strictEqual(r.reason, 'no-key')
  })
  assert.strictEqual(hasChanges(s), false)
})

test('stageCell：1 与 \'1\' 是两行，不合并（主键类型混用不能互相覆盖）', () => {
  let s = createChangeSet()
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'b', value: 'x' }).set
  const r = stageCell(s, { target: sel, pkColumn: 'id', pkValue: '1', column: 'b', value: 'y' })
  assert.strictEqual(r.merged, false)
  assert.strictEqual(countChanges(r.set), 2)
})

test('stageDelete：撤掉同行未应用的改动，并拒绝再往已删行上暂存改动', () => {
  let s = createChangeSet()
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'a' }).set
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 2, column: 'body', value: 'b' }).set
  const r = stageDelete(s, { target: sel, pkColumn: 'id', pkValues: [1, 1, 2] })
  s = r.set
  assert.strictEqual(r.count, 2, '重复主键只算一条删除')
  assert.strictEqual(r.droppedCells, 2)
  assert.strictEqual(countChanges(s), 2)
  const items = listChanges(s)[0].items
  assert.deepStrictEqual(items.map(i => i.kind), ['delete', 'delete'])
  assert.strictEqual(
    stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'z' }).reason,
    'deleted',
    '已暂存删除的行不能再挂改动'
  )
  assert.strictEqual(hasCellChangeOnRow(s, sel, 2), false)
})

test('stageInsert：每次一条，不与既有插入合并', () => {
  let s = createChangeSet()
  const payload = { values: { body: 'a' }, cols: ['body'], vals: ['\'a\''] }
  s = stageInsert(s, { target: sel, payload }).set
  const r = stageInsert(s, { target: sel, payload })
  assert.notStrictEqual(r.id, Object.keys(s.groups[groupKeyOf(sel)].inserts)[0])
  assert.strictEqual(countChanges(r.set), 2)
  assert.strictEqual(
    stageInsert(s, { target: sel, payload: { values: {} } }).reason,
    'empty'
  )
})

test('stageCells：批量/查找替换产出按同一粒度落集，坏主键计入 skipped', () => {
  const r = stageCells(createChangeSet(), {
    target: sel,
    pkColumn: 'id',
    column: 'body',
    updates: [{ pk: 1, value: 'a' }, { pk: null, value: 'b' }, { pk: 2, value: 'c' }]
  })
  assert.strictEqual(r.added, 2)
  assert.strictEqual(r.skipped, 1)
  assert.strictEqual(countChanges(r.set), 2)
})

test('多表分组：不同表各成一组，组顺序按首次暂存', () => {
  let s = createChangeSet()
  s = stageCell(s, { target: selPg, pkColumn: 'id', pkValue: 1, column: 'a', value: '1' }).set
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'b', value: '2' }).set
  const groups = listChanges(s)
  assert.deepStrictEqual(groups.map(g => g.key), [groupKeyOf(selPg), groupKeyOf(sel)])
  assert.strictEqual(groups[0].target.schema, 'public')
})

// ---- 撤销 / 丢弃 ----

test('dropChange：撤单条后分组不留空壳，order 同步收干', () => {
  let s = createChangeSet()
  const r = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'a' })
  s = dropChange(r.set, r.id)
  assert.strictEqual(countChanges(s), 0)
  assert.deepStrictEqual(s.order, [])
  assert.deepStrictEqual(listChanges(s), [])
})

test('dropGroup / clearChangeSet：按表丢弃与全部丢弃', () => {
  let s = createChangeSet()
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'b', value: '1' }).set
  s = stageCell(s, { target: selPg, pkColumn: 'id', pkValue: 2, column: 'c', value: '2' }).set
  s = dropGroup(s, groupKeyOf(sel))
  assert.strictEqual(countChanges(s), 1)
  assert.deepStrictEqual(listChanges(s).map(g => g.key), [groupKeyOf(selPg)])
  assert.strictEqual(countChanges(clearChangeSet(s)), 0)
})

// ---- 展示顺序（预览读起来就是将要发生的顺序）----

test('listChanges：组内固定 新增 → 修改 → 删除', () => {
  let s = createChangeSet()
  s = stageDelete(s, { target: sel, pkColumn: 'id', pkValues: [9] }).set
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 3, column: 'body', value: 'x' }).set
  s = stageInsert(s, {
    target: sel,
    payload: { values: { body: 'n' }, cols: ['body'], vals: ['\'n\''] }
  }).set
  assert.deepStrictEqual(
    listChanges(s)[0].items.map(i => i.kind),
    ['insert', 'cell', 'delete']
  )
})

test('验收口径：改 3 行 1 列 → 预览 3 条 UPDATE 且 WHERE 只含主键', () => {
  let s = createChangeSet()
  ;[1, 2, 3].forEach(pk => {
    s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: pk, column: 'body', value: 'v' + pk }).set
  })
  const items = listChanges(s)[0].items
  assert.strictEqual(items.length, 3)
  items.forEach((it, i) => {
    assert.ok(it.sql.startsWith('UPDATE db1.note_t SET body = '), it.sql)
    assert.ok(it.sql.endsWith("WHERE id = '" + (i + 1) + "'"), it.sql)
    assert.ok(!it.sql.includes(' IN ('), '单格预览只按主键等值定位')
  })
})

// ---- 应用计划：仍是同一批 op，只是拆分粒度不同 ----

test('planSubmit：INSERT → UPDATE → DELETE 顺序，参数与即时执行同形', () => {
  let s = createChangeSet()
  s = stageDelete(s, { target: sel, pkColumn: 'id', pkValues: [7] }).set
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 1, column: 'body', value: 'a' }).set
  s = stageInsert(s, {
    target: sel,
    payload: { values: { body: 'n' }, cols: ['body'], vals: ['\'n\''] }
  }).set
  const plan = planSubmit(s)
  assert.deepStrictEqual(plan.map(p => p.op), ['insertRow', 'updateCell', 'deleteRows'])
  assert.deepStrictEqual(plan[0].args, {
    database: 'db1', schema: '', table: 'note_t', values: { body: 'n' }
  })
  assert.deepStrictEqual(plan[1].args, {
    database: 'db1',
    schema: '',
    table: 'note_t',
    pkColumn: 'id',
    pkValue: 1,
    column: 'body',
    value: 'a'
  })
  assert.deepStrictEqual(plan[2].args, {
    database: 'db1', schema: '', table: 'note_t', pkColumn: 'id', pkValues: [7]
  })
})

test('planSubmit：同列多格并成一条 updateCells，散列各走各的', () => {
  let s = createChangeSet()
  s = stageCells(s, {
    target: sel,
    pkColumn: 'id',
    column: 'body',
    updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'b' }]
  }).set
  s = stageCell(s, { target: sel, pkColumn: 'id', pkValue: 3, column: 'tag', value: 't' }).set
  const plan = planSubmit(s)
  assert.strictEqual(plan.length, 2)
  const cells = plan.find(p => p.op === 'updateCells')
  assert.strictEqual(cells.args.column, 'body')
  assert.deepStrictEqual(cells.args.updates, [
    { pk: 1, value: 'a' }, { pk: 2, value: 'b' }
  ])
  assert.deepStrictEqual(cells.ids.length, 2, '一条 op 对应两条变更，撤销按 ids 对齐')
  assert.strictEqual(plan.find(p => p.op === 'updateCell').args.column, 'tag')
})

test('planSubmit：手动事务里退化成逐格 updateCell（updateCells 在事务内被主进程拒收）', () => {
  let s = createChangeSet()
  s = stageCells(s, {
    target: sel,
    pkColumn: 'id',
    column: 'body',
    updates: [{ pk: 1, value: 'a' }, { pk: 2, value: 'b' }]
  }).set
  const plan = planSubmit(s, { inTransaction: true })
  assert.deepStrictEqual(plan.map(p => p.op), ['updateCell', 'updateCell'])
})

test('planSubmit：一次 op 不超过 200 行（与主进程上限同口径）', () => {
  let s = createChangeSet()
  const updates = Array.from({ length: ROW_OP_LIMIT + 5 }, (_, i) => ({ pk: i + 1, value: 'v' }))
  s = stageCells(s, { target: sel, pkColumn: 'id', column: 'body', updates }).set
  const plan = planSubmit(s)
  assert.strictEqual(plan.length, 2)
  assert.strictEqual(plan[0].args.updates.length, ROW_OP_LIMIT)
  assert.strictEqual(plan[1].args.updates.length, 5)
  const d = planSubmit(stageDelete(createChangeSet(), {
    target: sel, pkColumn: 'id', pkValues: Array.from({ length: 250 }, (_, i) => i)
  }).set)
  assert.deepStrictEqual(d.map(p => p.args.pkValues.length), [ROW_OP_LIMIT, 50])
})

test('planSubmit：PG 组把 schema 带进 op 参数', () => {
  const s = stageCell(createChangeSet(), {
    target: selPg, pkColumn: 'id', pkValue: 1, column: 'a', value: '1'
  }).set
  assert.deepStrictEqual(planSubmit(s)[0].args, {
    database: 'app',
    schema: 'public',
    table: 't_order',
    pkColumn: 'id',
    pkValue: 1,
    column: 'a',
    value: '1'
  })
})

// ---- 插入表单构造（即时执行与暂存共用）----

test('buildInsertPayload：勾 NULL 传 null、留空列不传、数值列转数字', () => {
  const cols = [
    { name: 'id', isNumeric: true, isAutoInc: true },
    { name: 'body', isNumeric: false },
    { name: 'tag', isNumeric: false },
    { name: 'num', isNumeric: true }
  ]
  const p = buildInsertPayload(cols, {
    id: { text: '', isNull: false },
    body: { text: 'a\'b', isNull: false },
    tag: { text: '', isNull: true },
    num: { text: '12', isNull: false }
  })
  assert.deepStrictEqual(p.values, { body: 'a\'b', tag: null, num: 12 })
  assert.deepStrictEqual(p.cols, ['body', 'tag', 'num'])
  assert.deepStrictEqual(p.vals, ['\'a\'b\'', 'NULL', '\'12\''])
})

test('canSubmitInsertForm：全空不行，勾 NULL 行，数值列非法文本不行', () => {
  const cols = [{ name: 'body', isNumeric: false }, { name: 'num', isNumeric: true }]
  assert.strictEqual(canSubmitInsertForm(cols, { body: { text: '' }, num: { text: '' } }), false)
  assert.strictEqual(canSubmitInsertForm(cols, { body: { text: 'a' }, num: { text: 'x' } }), false)
  assert.strictEqual(canSubmitInsertForm(cols, { body: { text: 'a' }, num: { text: '1' } }), true)
  assert.strictEqual(canSubmitInsertForm(cols, { body: { isNull: true }, num: { text: '' } }), true)
})

// ---- 入口可用性（验收：只读 / 无主键 / Redis 都没有暂存入口）----

test('canStage：只读模式、无主键表、Redis 一律关入口', () => {
  assert.strictEqual(canStage({ readOnly: true, pkColumn: 'id' }), false)
  assert.strictEqual(canStage({ readOnly: false, pkColumn: '' }), false)
  assert.strictEqual(canStage({ readOnly: false, pkColumn: 'id', isRedis: true }), false)
  assert.strictEqual(canStage({ readOnly: false, pkColumn: 'id' }), true)
})
