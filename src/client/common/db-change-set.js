/**
 * N2 变更集：前端侧"还没执行"的待提交改动。
 *
 * 与 F2 手动事务的分工（本模块最大的混淆点，命名上也必须分开）：
 * - **变更集（这里）**：还没发给数据库的意图，纯前端内存，关掉页面就没了，
 *   数据库状态完全没动过 —— 面板叫"暂存变更"，按钮叫"应用"。
 * - **F2 事务清单（主进程）**：已经执行、只是还没 COMMIT 的语句，数据库在事务里
 *   已经改过了，断连/超时会被服务端回滚 —— 开关叫"手动事务"，按钮叫"提交/回滚"。
 * 两者可以叠加：手动事务开着时，"应用"就是把变更集当成普通 op 发进去，
 * 于是它们同时出现在 F2 的清单里，由用户决定何时 COMMIT。
 *
 * 粒度与合并（设计 N2 要点 2）：
 * - 单元格改动以 **表 + 主键值 + 列** 为单位，重复编辑同一格覆盖旧值（不堆历史）。
 * - 删行以 **表 + 主键值** 为单位；暂存删除会把该行上尚未应用的改动一并撤掉
 *   （行都要删了，留着改它的记录只会生成一条永远命中 0 行的 UPDATE）。
 * - 插行无法合并（还没有主键可依），每点一次"保存"多一条。
 *
 * 全部函数都不改入参 set，返回新对象：React 侧直接 setState，单测也不用管副作用。
 */

import { usableKey } from './db-grid-replace.js'
import { previewLiteral } from './db-session-const.js'
import {
  updateCellPreview,
  insertRowPreview,
  deleteRowsPreview
} from './db-change-preview.js'

// 与主进程 deleteRows / updateCells 的单次上限同口径（一次 op 最多带 200 行）
export const ROW_OP_LIMIT = 200

// 表定位键：PG 用 database.schema.table，MySQL 用 database.table
export function groupKeyOf (target) {
  const t = target || {}
  return [t.database || '', t.schema || '', t.table || ''].join('.')
}

// 主键值的键：区分 1 与 '1'（它们在变更集里是两行不同的记录）
const pkKeyOf = v => JSON.stringify(v === undefined ? null : v)

const cellIdOf = (groupKey, pkValue, column) =>
  groupKey + '#c#' + column + '#' + pkKeyOf(pkValue)
const deleteIdOf = (groupKey, pkValue) => groupKey + '#d#' + pkKeyOf(pkValue)
const insertIdOf = (groupKey, seq) => groupKey + '#i' + seq + '#'

export function createChangeSet () {
  return { groups: {}, order: [], seq: 0 }
}

const cloneGroup = g => ({
  ...g,
  cells: { ...(g.cells || {}) },
  inserts: { ...(g.inserts || {}) },
  deletes: { ...(g.deletes || {}) }
})

export function countGroup (g) {
  if (!g) {
    return 0
  }
  return Object.keys(g.cells || {}).length +
    Object.keys(g.inserts || {}).length +
    Object.keys(g.deletes || {}).length
}

// 非空分组，按首次暂存顺序
function groupsOf (set) {
  const list = ((set && set.order) || []).map(k => (set.groups || {})[k]).filter(countGroup)
  return list
}

/**
 * 写入一条变更。mutate 返回的 patch 会并进结果（ok / id / merged 等），
 * 分组只在真的有内容时进入 order，避免空表壳留在列表里。
 */
function withGroup (set, { target, pkColumn }, mutate) {
  const key = groupKeyOf(target)
  const prev = (set.groups || {})[key]
  const group = prev ? cloneGroup(prev) : { key, target, pkColumn: '', cells: {}, inserts: {}, deletes: {} }
  // 主键列以最后一次暂存为准（结构缓存刷新后可能是同一列的不同大小写口径）
  group.pkColumn = pkColumn || group.pkColumn || ''
  const patch = mutate(group) || {}
  if (!countGroup(group)) {
    return { set, ...patch }
  }
  const groups = { ...(set.groups || {}), [key]: group }
  const order = (set.order || []).includes(key) ? set.order : [...(set.order || []), key]
  return { set: { ...set, groups, order }, ...patch }
}

/**
 * 暂存一次单元格改动，同键覆盖（merged=true 表示改的是上一次暂存的那条）。
 * 无主键值（null/undefined/空串）与已暂存删除的行都不接受：前者无法定位，
 * 后者会生成一条永远命中 0 行的 UPDATE。
 */
export function stageCell (set, o) {
  const { target, pkColumn, pkValue, column, value } = o || {}
  if (!usableKey(pkValue) || !column || !target || !target.table) {
    return { set, ok: false, reason: 'no-key' }
  }
  const key = groupKeyOf(target)
  const group = (set.groups || {})[key]
  if (group && group.deletes[deleteIdOf(key, pkValue)]) {
    return { set, ok: false, reason: 'deleted' }
  }
  const id = cellIdOf(key, pkValue, column)
  const merged = !!(group && group.cells[id])
  return withGroup(set, { target, pkColumn }, g => {
    g.cells[id] = { id, kind: 'cell', pk: pkValue, column, value }
    return { ok: true, id, merged }
  })
}

/**
 * 暂存一次插行。payload = buildInsertPayload 从插入行弹窗表单算出的
 * { values, cols, vals } —— 即时执行与暂存共用同一份构造。
 */
export function stageInsert (set, o) {
  const { target, payload } = o || {}
  const values = payload && payload.values
  if (!target || !target.table || !values || !Object.keys(values).length) {
    return { set, ok: false, reason: 'empty' }
  }
  const seq = (set.seq || 0) + 1
  const id = insertIdOf(groupKeyOf(target), seq)
  return withGroup({ ...set, seq }, { target }, g => {
    g.inserts[id] = {
      id,
      kind: 'insert',
      values,
      cols: payload.cols || Object.keys(values),
      vals: payload.vals || Object.keys(values).map(k => previewLiteral(values[k]))
    }
    return { ok: true, id }
  })
}

/**
 * 暂存删行。同一主键重复暂存只留一条；顺带撤掉这些行上尚未应用的单元格改动，
 * droppedCells 给 UI 提示"有 N 条改动因删除而作废"。
 */
export function stageDelete (set, o) {
  const { target, pkColumn, pkValues } = o || {}
  // 先去重：勾选口径下同一个主键可能出现两次（多结果页拼接），
  // 不去重会让"暂存了 N 行删除"的 N 与实际条数对不上
  const list = []
  const seen = new Set()
  ;(Array.isArray(pkValues) ? pkValues : []).forEach(pk => {
    if (!usableKey(pk)) {
      return
    }
    const k = pkKeyOf(pk)
    if (seen.has(k)) {
      return
    }
    seen.add(k)
    list.push(pk)
  })
  if (!target || !target.table || !pkColumn || !list.length) {
    return { set, ok: false, reason: 'no-key' }
  }
  let dropped = 0
  const res = withGroup(set, { target, pkColumn }, g => {
    list.forEach(pk => {
      g.deletes[deleteIdOf(g.key, pk)] = { id: deleteIdOf(g.key, pk), kind: 'delete', pk }
      Object.keys(g.cells).forEach(id => {
        if (g.cells[id].pk === pk) {
          delete g.cells[id]
          dropped++
        }
      })
    })
    return { ok: true }
  })
  return { ...res, count: list.length, droppedCells: dropped }
}

/**
 * 批量同列改值 / 表内查找替换产出的一批 { pk, value } 落进变更集。
 * 与逐格编辑同一粒度（行主键 + 列），所以合并与去重语义天然一致；
 * skipped 计数把"主键不可用 / 该行已暂存删除"都算进去，由 UI 决定怎么说。
 */
export function stageCells (set, o) {
  const { target, pkColumn, column, updates } = o || {}
  const list = Array.isArray(updates) ? updates : []
  let added = 0
  let skipped = 0
  let out = set
  list.forEach(u => {
    const r = stageCell(out, {
      target,
      pkColumn,
      pkValue: u && u.pk,
      column,
      value: u && u.value
    })
    out = r.set
    if (r.ok) {
      added++
    } else {
      skipped++
    }
  })
  return { set: out, added, skipped }
}

/** 撤销单条变更（按 id，跨表唯一） */
export function dropChange (set, id) {
  return dropOne(set, id)
}

/** 批量撤销（应用成功/部分成功后按 ids 收干已执行的条目，空 ids 原样返回） */
export function dropChanges (set, ids) {
  return (Array.isArray(ids) ? ids : []).reduce((s, id) => dropChange(s, id), set)
}

function dropOne (set, id) {
  const groups = {}
  const order = []
  ;(set.order || []).forEach(key => {
    const src = set.groups[key]
    const g = cloneGroup(src)
    delete g.cells[id]
    delete g.inserts[id]
    delete g.deletes[id]
    if (countGroup(g)) {
      groups[key] = g
      order.push(key)
    }
  })
  return { ...set, groups, order }
}

/** 丢弃整张表的所有变更（面板表头的"丢弃本表"） */
export function dropGroup (set, key) {
  const groups = { ...(set.groups || {}) }
  const g = groups[key]
  if (!g) {
    return set
  }
  const n = cloneGroup(g)
  n.cells = {}
  n.inserts = {}
  n.deletes = {}
  delete groups[key]
  return { ...set, groups, order: (set.order || []).filter(k => k !== key) }
}

export function clearChangeSet (set) {
  return { ...createChangeSet(), seq: (set && set.seq) || 0 }
}

/**
 * 插入弹窗表单 → { values, cols, vals }。
 * 勾选 NULL 传 null；留空列不传（交给数据库默认值/自增）；数值列文本转数字。
 * 即时执行与暂存两条路径共用，避免"预览是 A、执行是 B"。
 */
export function buildInsertPayload (insertCols, insertValues) {
  const values = {}
  const cols = []
  const vals = []
  ;(insertCols || []).forEach(c => {
    const st = (insertValues || {})[c.name] || {}
    if (st.isNull) {
      values[c.name] = null
      cols.push(c.name)
      vals.push('NULL')
    } else if (st.text !== '') {
      values[c.name] = c.isNumeric ? Number(st.text) : st.text
      cols.push(c.name)
      vals.push(previewLiteral(values[c.name]))
    }
  })
  return { values, cols, vals }
}

/** 插入表单是否可提交：至少一列有值（或勾 NULL），且数值列文本均可转数字 */
export function canSubmitInsertForm (insertCols, insertValues) {
  const cols = insertCols || []
  return cols.some(c => {
    const st = (insertValues || {})[c.name] || {}
    return st.isNull || st.text !== ''
  }) && cols.every(c => {
    const st = (insertValues || {})[c.name] || {}
    if (st.isNull || st.text === '' || !c.isNumeric) {
      return true
    }
    return !Number.isNaN(Number(st.text))
  })
}

export function countChanges (set) {
  return groupsOf(set).reduce((n, g) => n + countGroup(g), 0)
}

export function hasChanges (set) {
  return countChanges(set) > 0
}

/** 该表该主键行上是否已有待应用的改动（暂存删除前的提示依据） */
export function hasCellChangeOnRow (set, target, pkValue) {
  const g = set && set.groups && set.groups[groupKeyOf(target)]
  if (!g) {
    return false
  }
  return Object.keys(g.cells).some(id => g.cells[id].pk === pkValue)
}

/**
 * 面板展示：按表分组，组内 新增 → 修改 → 删除，与 planSubmit 的执行顺序一致 ——
 * 预览读起来就是将要发生的顺序。
 */
export function listChanges (set) {
  return groupsOf(set).map(g => {
    const inserts = Object.keys(g.inserts).map(id => g.inserts[id])
    const cells = Object.keys(g.cells).map(id => g.cells[id])
    const deletes = Object.keys(g.deletes).map(id => g.deletes[id])
    return {
      key: g.key,
      target: g.target,
      pkColumn: g.pkColumn,
      count: countGroup(g),
      items: [
        ...inserts.map(e => ({
          ...e,
          sql: insertRowPreview({ sel: g.target, cols: e.cols, vals: e.vals })
        })),
        ...cells.map(e => ({
          ...e,
          sql: updateCellPreview({
            sel: g.target,
            pkColumn: g.pkColumn,
            pkValue: e.pk,
            column: e.column,
            value: e.value
          })
        })),
        ...deletes.map(e => ({
          ...e,
          sql: deleteRowsPreview({ sel: g.target, pkColumn: g.pkColumn, pkValues: [e.pk] })
        }))
      ]
    }
  })
}

const chunk = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size))
  }
  return out
}

/**
 * 应用计划：把变更集翻成"同一批既有 op"的有序数组（设计 N2 要点 1/3）。
 * 顺序 = 每张表先 INSERT、再 UPDATE、最后 DELETE（外键安全的最小版本：
 * 先补被引用的新行，最后才删行）。跨表依赖本期不猜（没有可靠依赖图），
 * 需要时用户自己分批应用。
 *
 * inTransaction=true 时改值退化成**逐格 updateCell**：批量 updateCells 自管
 * START TRANSACTION，在手动事务里会把外层事务隐式提交，主进程直接拒收该 op。
 * 两种模式只是拆分粒度不同，用的仍是同一批 op、同一份参数口径。
 */
export function planSubmit (set, o) {
  const inTx = !!(o && o.inTransaction)
  const plan = []
  groupsOf(set).forEach(g => {
    const base = {
      database: g.target.database || '',
      schema: g.target.schema || '',
      table: g.target.table
    }
    Object.keys(g.inserts).forEach(id => {
      plan.push({ op: 'insertRow', ids: [id], args: { ...base, values: g.inserts[id].values } })
    })
    const cells = Object.keys(g.cells).map(id => g.cells[id])
    if (inTx) {
      cells.forEach(e => {
        plan.push({
          op: 'updateCell',
          ids: [e.id],
          args: { ...base, pkColumn: g.pkColumn, pkValue: e.pk, column: e.column, value: e.value }
        })
      })
    } else {
      const byColumn = {}
      cells.forEach(e => {
        byColumn[e.column] = byColumn[e.column] || []
        byColumn[e.column].push(e)
      })
      Object.keys(byColumn).forEach(column => {
        const list = byColumn[column]
        if (list.length === 1) {
          const e = list[0]
          plan.push({
            op: 'updateCell',
            ids: [e.id],
            args: { ...base, pkColumn: g.pkColumn, pkValue: e.pk, column: e.column, value: e.value }
          })
          return
        }
        chunk(list, ROW_OP_LIMIT).forEach(part => {
          plan.push({
            op: 'updateCells',
            ids: part.map(e => e.id),
            args: {
              ...base,
              pkColumn: g.pkColumn,
              column,
              updates: part.map(e => ({ pk: e.pk, value: e.value }))
            }
          })
        })
      })
    }
    const deletes = Object.keys(g.deletes).map(id => g.deletes[id])
    chunk(deletes, ROW_OP_LIMIT).forEach(part => {
      plan.push({
        op: 'deleteRows',
        ids: part.map(e => e.id),
        args: { ...base, pkColumn: g.pkColumn, pkValues: part.map(e => e.pk) }
      })
    })
  })
  return plan
}

/** 暂存入口是否可用：只读模式 / 无主键表 / Redis 都没有暂存（验收 N2 要点 5） */
export function canStage (o) {
  const { readOnly, pkColumn, isRedis } = o || {}
  return !readOnly && !isRedis && !!pkColumn
}
