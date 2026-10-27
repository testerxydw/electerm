/**
 * 结果集视角条（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.2）
 *
 * 形态：默认"构建器"（列▾ 算子▾ 值__ ＋条件），一键切到"SQL"（条件体原文可编辑），
 * 两者共享同一份 whereDraft —— 构建器只是"文本生成器"。
 *
 * 职责边界（这条边界是本文件最重要的约定）：
 * - 本组件**只做展示与编辑态**：行的增删、算子的合法集合、值的输入形态；
 * - 所有 SQL 语义（子句生成、参数具体化、文本回解析、危险形态预检）都在
 *   common/db-grid-view.js 里，那些函数是纯函数、被单测逐条钉死。
 *   组件里出现任何字符串拼 SQL 的代码，都说明边界被越过了。
 *
 * 三个反复出现的坑，写在这里防止后人"顺手优化"：
 *
 * 1) **值输入不回传查询。** 每次按键都 onChange 会让用户每敲一个字符就打一次库，
 *    输入 "1000" 要发 4 次请求，且前面 3 次都是错的条件。回车（或"应用"）才算数。
 * 2) **isNull/notNull 的值输入是隐藏而不是禁用。** 禁用会留下一个永远不能用的框，
 *    用户会以为"这个功能坏了"；隐藏才表达"这个算子没有值"。
 * 3) **切回构建器解析失败时留在 SQL 模式。** 静默丢掉手写条件是最坏的一种"成功"：
 *    界面看起来切回去了，查询却少筛了几万行。
 *
 * 状态模型：本地 rows 是**编辑中**的行（允许 value 为空、允许还没生效），
 * view.conditions 是**已生效**的条件。两者不同步是正常的（空值行不生效），
 * 所以本组件不把 props 回灌进本地行；换表/重置由父组件用 key 重挂载来复位。
 */
import { useMemo, useState } from 'react'
import { Button, Input, Select, Tag, Tooltip } from 'antd'
import { DeleteOutlined, FilterOutlined, PlusOutlined } from '@ant-design/icons'
import {
  buildWhere,
  materializeClause,
  parseClause,
  findClauseProblem,
  nextSortOrder
} from '../../common/db-grid-view'

const e = window.translate

// 列类型只分四类：算子列表与输入形态各自按类型裁剪。
// 日期刻意**不做日期选择器**：时区会把"用户以为的那一天"变成另一天的 00:00，
// 而用户要的是"这一列的字面值"，文本输入最不容易出错。
const T_NUM = 'number'
const T_STR = 'string'
const T_BOOL = 'bool'
const T_DATE = 'date'

const OPS_BY_TYPE = {
  [T_NUM]: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull', 'notNull'],
  [T_STR]: ['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'in', 'isNull', 'notNull'],
  [T_BOOL]: ['eq', 'ne', 'isNull', 'notNull'],
  [T_DATE]: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull', 'notNull']
}

const NO_VALUE_OPS = { isNull: true, notNull: true }

// 比较算子直接用符号：跨语言无歧义，也不需要翻译
const OP_SYMBOL = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'IN'
}

const OP_TEXT_KEY = {
  contains: 'dbViewOpContains',
  startsWith: 'dbViewOpStartsWith',
  endsWith: 'dbViewOpEndsWith',
  isNull: 'dbViewOpIsNull',
  notNull: 'dbViewOpNotNull'
}

const opLabel = op => (OP_TEXT_KEY[op] ? e(OP_TEXT_KEY[op]) : (OP_SYMBOL[op] || op))

/**
 * 列类型归一：getTableStructure 给的是 information_schema 的 dataType
 * （mysql: int / varchar / datetime；pg: integer / character varying / timestamp without time zone），
 * 两个引擎的写法不同，所以只做"关键词包含"的粗分类。
 * 认不出来的一律当字符串处理：字符串的算子集是数值的超集（多了 contains 等），
 * 最坏情况是给数值列多显示几个用不上的算子，不会少显示。
 * @param {Object} col getTableStructure 的列对象
 * @returns {string} T_NUM | T_STR | T_BOOL | T_DATE
 */
const typeOfColumn = (col) => {
  const raw = String((col && (col.dataType || col.columnType)) || '').toLowerCase()
  if (/^(bool|boolean)$/.test(raw)) {
    return T_BOOL
  }
  if (/(int|serial|decimal|numeric|float|double|real|money)/.test(raw)) {
    return T_NUM
  }
  if (/(date|time|year)/.test(raw)) {
    return T_DATE
  }
  return T_STR
}

// 行 id 只用于 React key 与"哪一行在编辑"，与条件下标无关：
// 条件下标会随删除位移，用它当 key 会让输入框内容串行
let rowSeq = 0
const newRowId = () => {
  rowSeq += 1
  return 'vr' + rowSeq
}

const toRows = conditions => (conditions || []).map(c => ({
  id: newRowId(),
  column: c.column,
  op: c.op,
  value: c.op === 'in'
    ? (Array.isArray(c.value) ? c.value.join(', ') : String(c.value == null ? '' : c.value))
    : (c.value === undefined || c.value === null ? '' : String(c.value))
}))

const REJECT_TEXT_KEY = {
  unknownOp: 'dbViewRejectOp',
  emptyValue: 'dbViewRejectValue',
  unknownColumn: 'dbViewRejectColumn'
}

// 按原因分组：只说"N 个条件未生效"没法让人去改，"2 个条件引用了不存在的列"才行
const rejectsText = (list) => {
  const count = {}
  for (const item of list || []) {
    const key = (item && item.reason) || 'unknownColumn'
    count[key] = (count[key] || 0) + 1
  }
  return Object.keys(count)
    .map(key => e(REJECT_TEXT_KEY[key] || REJECT_TEXT_KEY.unknownColumn)
      .replace('{n}', String(count[key])))
    .join(' / ')
}

const PROBLEM_TEXT_KEY = {
  semicolon: 'dbViewProblemSemicolon',
  comment: 'dbViewProblemComment',
  keyword: 'dbViewProblemKeyword',
  unbalanced: 'dbViewProblemUnbalanced',
  tooLong: 'dbViewProblemTooLong',
  unparsable: 'dbViewUnparsable'
}

const problemText = code => (
  PROBLEM_TEXT_KEY[code] ? e(PROBLEM_TEXT_KEY[code]).replace('{n}', '4000') : ''
)

export default function DbViewBar ({
  columns,
  dialect,
  view,
  mode,
  draft,
  rejected,
  truncated,
  loading,
  disabled,
  onChange,
  onApply,
  onReset
}) {
  const cols = Array.isArray(columns) ? columns : []
  const isSql = mode === 'sql'
  const [rows, setRows] = useState(() => toRows(view && view.conditions))
  // 切回构建器失败时的一次性提示（不弹窗：这里不是错误，是"这条表达式没法结构化"）
  const [hint, setHint] = useState('')
  const order = (view && view.order) || []

  // SQL 模式下"生效条件数"只能靠回解析算：文本是权威，view.conditions 是上一次结构化的结果。
  // 解析不了（手写表达式）就显示占位符 —— 显示一个旧数字比不显示更误导
  const sqlCount = useMemo(() => {
    if (!isSql || !String(draft || '').trim()) {
      return 0
    }
    const parsed = parseClause(draft, cols, dialect)
    return parsed ? parsed.conditions.length : null
  }, [isSql, draft, cols, dialect])
  const appliedCount = isSql ? sqlCount : (view && view.conditions ? view.conditions.length : 0)

  const colType = useMemo(() => {
    const map = {}
    for (const c of cols) {
      const name = c && c.name ? String(c.name) : ''
      if (name) {
        map[name.toLowerCase()] = typeOfColumn(c)
      }
    }
    return map
  }, [cols])

  const options = useMemo(
    () => cols.map(c => ({ value: String(c.name), label: String(c.name) })),
    [cols]
  )

  // 编辑中的行 → 交给父组件的条件（空值行也发上去：父组件用 normalizeView 裁，
  // 这里的 rows 只是"用户屏幕上看到的行"，不是"生效的条件"）
  const emit = (nextRows) => {
    setRows(nextRows)
    onChange({
      conditions: nextRows.map(r => {
        const t = colType[String(r.column).toLowerCase()] || T_STR
        if (NO_VALUE_OPS[r.op]) {
          return { column: r.column, op: r.op }
        }
        // 布尔列的 'true'/'false' 文本要变成真布尔值：绑参时 mysql 驱动会把
        // 字符串 'true' 当成 0 传下去（"筛 true 却一行都没有"就是这么来的）
        if (t === T_BOOL) {
          const v = String(r.value).toLowerCase()
          return { column: r.column, op: r.op, value: v === 'true' }
        }
        return { column: r.column, op: r.op, value: r.value }
      })
    })
  }

  const commitAndApply = (nextRows) => {
    emit(nextRows)
    setHint('')
    onApply()
  }

  // 回车 / "应用"：先把编辑中的行提交上去，再发查询。
  // 不能只调 onApply —— 用户刚敲完的值还在本地 rows 里，父组件的 view 里没有，
  // 这样"应用"出来的查询会少掉最后一条条件。
  // SQL 模式例外：那里的条件来自 draft（父组件直接用），提交构建器的行反而会把
  // "上一次构建器状态"盖到已应用条件上
  const applyNow = () => {
    setHint('')
    if (isSql) {
      onApply()
      return
    }
    commitAndApply(rows)
  }

  // 打字只改本地行：每次按键都上报会让父组件整棵树重渲染，
  // 而在大表上这只体现为"输入框卡一下"，没人会想到是视角条导致的
  const patchLocal = (id, patch) => {
    setRows(rows.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }

  const addRow = () => {
    const first = cols[0] ? String(cols[0].name) : ''
    if (!first) {
      return
    }
    const t = colType[first.toLowerCase()] || T_STR
    commitAndApply(rows.concat([{
      id: newRowId(),
      column: first,
      op: OPS_BY_TYPE[t][0],
      value: ''
    }]))
  }

  const removeRow = (id) => {
    commitAndApply(rows.filter(r => r.id !== id))
  }

  // 换列时算子可能不适用（数值列的 contains）：落到新类型的第一项
  const changeColumn = (row, column) => {
    const t = colType[String(column).toLowerCase()] || T_STR
    const allowed = OPS_BY_TYPE[t]
    const op = allowed.indexOf(row.op) === -1 ? allowed[0] : row.op
    commitAndApply(rows.map(r => (r.id === row.id
      ? { ...r, column, op, value: NO_VALUE_OPS[op] ? '' : r.value }
      : r)))
  }

  const changeOp = (row, op) => {
    commitAndApply(rows.map(r => (r.id === row.id
      // 换成无值算子时清掉值：留着会在切回来时"复活"一个旧条件
      ? { ...r, op, value: NO_VALUE_OPS[op] ? '' : r.value }
      : r)))
  }

  const toggleSort = (column) => {
    // 与列头点击共用同一条推进规则（升 → 降 → 移除，超 3 列丢最旧）
    onChange({ order: nextSortOrder(order, column) })
    onApply()
  }

  // 构建器 → SQL：把当前行生成的**参数化**子句具体化成字面量文本
  const toSql = () => {
    const built = buildWhere({ conditions: rows }, cols, dialect)
    const text = materializeClause(built.clause, built.params, dialect)
    setHint('')
    onChange({ mode: 'sql', draft: text })
  }

  // SQL → 构建器：解析失败就留在 SQL 模式（绝不静默丢条件）
  const toBuilder = () => {
    const text = String(draft || '').trim()
    if (!text) {
      setRows([])
      setHint('')
      onChange({ mode: 'builder', draft: '', conditions: [] })
      return
    }
    const parsed = parseClause(text, cols, dialect)
    if (!parsed) {
      setHint(problemText('unparsable'))
      return
    }
    setRows(toRows(parsed.conditions))
    setHint('')
    onChange({ mode: 'builder', draft: '', conditions: parsed.conditions })
  }

  const sqlProblem = isSql && draft ? findClauseProblem(draft, dialect) : ''
  const canApply = !loading && !disabled && !sqlProblem

  // 值输入：无值算子**隐藏**（不是禁用），布尔列给 TRUE/FALSE，布尔之外一律纯文本
  const valueInput = (row, t) => {
    if (NO_VALUE_OPS[row.op]) {
      return null
    }
    if (t === T_BOOL) {
      return (
        <Select
          size='small' className='db-view-value' placeholder='—' allowClear disabled={disabled}
          value={row.value === '' ? undefined : row.value}
          options={[{ value: 'true', label: 'TRUE' }, { value: 'false', label: 'FALSE' }]}
          onChange={v => patchLocal(row.id, { value: v === undefined ? '' : v })}
        />
      )
    }
    return (
      <Input
        size='small' className='db-view-value' value={row.value} disabled={disabled}
        placeholder={row.op === 'in' ? e('dbViewInPlaceholder') : ''}
        onChange={ev => patchLocal(row.id, { value: ev.target.value })}
        onPressEnter={applyNow}
      />
    )
  }

  const renderRow = (row) => {
    const t = colType[String(row.column).toLowerCase()] || T_STR
    const allowed = OPS_BY_TYPE[t]
    return (
      <div className='db-view-row' key={row.id}>
        <Select
          size='small' className='db-view-col' value={row.column} options={options}
          showSearch disabled={disabled} onChange={v => changeColumn(row, v)}
        />
        <Select
          size='small' className='db-view-op' value={row.op} disabled={disabled}
          options={allowed.map(op => ({ value: op, label: opLabel(op) }))}
          onChange={v => changeOp(row, v)}
        />
        {valueInput(row, t)}
        <Button
          size='small' type='text' className='db-view-del' icon={<DeleteOutlined />}
          title={e('dbViewRemove')} onClick={() => removeRow(row.id)}
        />
      </div>
    )
  }

  return (
    <div className='db-view-bar'>
      <div className='db-view-head'>
        {
          // 操作簇置左：模式切换/重置/应用位置固定最好找；
          // 右侧留给状态信息（筛选计数/丢弃/截断），动作在前、状态在后
          <span className='db-view-modes'>
            <Button size='small' type={isSql ? 'default' : 'primary'} onClick={() => isSql && toBuilder()}>
              {e('dbViewModeBuilder')}
            </Button>
            <Button size='small' type={isSql ? 'primary' : 'default'} onClick={() => !isSql && toSql()}>
              SQL
            </Button>
          </span>
        }
        <Button size='small' onClick={onReset} disabled={loading}>{e('dbViewReset')}</Button>
        <Button size='small' type='primary' loading={loading} disabled={!canApply} onClick={applyNow}>
          {e('dbViewApply')}
        </Button>
        <span className='db-view-funnel' title={e('dbViewHint')}>
          <FilterOutlined />
          {e('dbViewConditions').replace('{n}', appliedCount === null ? '—' : String(appliedCount))}
        </span>
        {
          rejected && rejected.length
            ? <span className='db-view-reject'>{rejectsText(rejected)}</span>
            : null
        }
        {
          // "已截断" ≠ "未生效"：这条**生效了**，只是取值被裁过（IN 超 200 项）
          truncated && truncated.length
            ? (
              <Tooltip title={e('dbViewTruncatedHint')}>
                <span className='db-view-truncated'>
                  {e('dbViewTruncated').replace('{n}', String(truncated.length))}
                </span>
              </Tooltip>
              )
            : null
        }
        <span className='db-view-spacer' />
      </div>
      {
        isSql
          ? (
            <div className='db-view-sql'>
              <Input.TextArea
                className='db-view-sql-input' value={draft || ''} spellCheck={false}
                autoSize={{ minRows: 1, maxRows: 6 }}
                placeholder={e('dbViewSqlPlaceholder')}
                status={sqlProblem ? 'error' : undefined}
                onChange={ev => onChange({ draft: ev.target.value })}
                onPressEnter={ev => {
                  // Shift+Enter 留给换行：多行条件体是编辑需求，回车=应用是取数需求
                  if (ev.shiftKey) {
                    return
                  }
                  ev.preventDefault()
                  if (canApply) {
                    applyNow()
                  }
                }}
              />
              {
                sqlProblem
                  ? <span className='db-view-problem'>{problemText(sqlProblem)}</span>
                  : <span className='db-view-hint'>{e('dbViewSqlHint')}</span>
              }
            </div>
            )
          : (
            <div className='db-view-rows'>
              {rows.map(renderRow)}
              <div className='db-view-row'>
                <Button
                  size='small' type='dashed' icon={<PlusOutlined />}
                  disabled={disabled || !cols.length} onClick={addRow}
                >
                  {e('dbViewAddCondition')}
                </Button>
              </div>
            </div>
            )
      }
      <div className='db-view-foot'>
        <span className='db-view-sort-label'>{e('dbViewSort')}</span>
        {
          order.length
            ? order.map(o => (
              <Tag
                key={o.column} className={'db-view-chip' + (o.desc ? ' is-desc' : '')}
                title={e('dbViewSortHint')} onClick={() => toggleSort(o.column)}
              >
                {o.column + (o.desc ? ' ↓' : ' ↑')}
              </Tag>
            ))
            : <span className='db-view-sort-empty'>{e('dbViewSortNone')}</span>
        }
        {hint ? <span className='db-view-problem'>{hint}</span> : null}
      </div>
    </div>
  )
}
