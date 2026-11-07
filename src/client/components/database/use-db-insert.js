// #5 行级 INSERT / DELETE（cluster #5 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：B1 标记段（1538–1676，不含 A2 DDL 的 ddl state——它归 DDL 查看器，留在 owner）逐字迁入本 hook；
// 页面级 state/ref 由 owner 注入（selectedRowKeys/setSelectedRowKeys/filteredRows/grid/setGrid/countKeyRef/
// structure/tab/tabId/changes/confirmRowWrite/onOpError/pkColumn/sel）。
import { useMemo, useState } from 'react'
import message from '../common/message'
import { SEL_COL_W, buildInsertFormColumns } from '../../common/db-session-const'
import { buildInsertPayload, canSubmitInsertForm } from '../../common/db-change-set'
import { insertRowPreview, deleteRowsPreview } from '../../common/db-change-preview'

const e = window.translate

export function useDbInsert ({
  sel,
  selectedRowKeys,
  setSelectedRowKeys,
  structure,
  tab,
  tabId,
  changes,
  confirmRowWrite,
  setGrid,
  countKeyRef,
  loadWithCount,
  grid,
  onOpError,
  pkColumn,
  filteredRows
}) {
  // ---- B1 行级 INSERT / DELETE（主进程占位绑定构造 SQL，前端只传值） ----

  // 行选择透传 antd rowSelection（仅主数据网格使用；redis 无行概念）。
  // columnWidth 必须显式给：表头是独立 table（scroll.y 生效后 header/body 两套），
  // `table-layout: fixed` 下列宽总和超过容器时，没有显式宽度的列会被压到 1px
  // → 表头勾选框被挤没、且表头文字相对数据整体左移一列。CSS 里的同宽只是兜底，
  // 真正决定 colgroup 的是这里（见 db-session.styl 的 .ant-table-selection-column）
  const rowSelection = {
    selectedRowKeys,
    onChange: keys => setSelectedRowKeys(keys),
    columnWidth: SEL_COL_W
  }

  // 插入行弹窗：列清单来自 describeTable 缓存（structure.rows）
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertCols, setInsertCols] = useState([])
  // 每列编辑态：{ text, isNull }；勾选 NULL 后输入框禁用
  const [insertValues, setInsertValues] = useState({})

  const openInsertModal = () => {
    const cols = buildInsertFormColumns(structure.rows, tab.dbType)
    const init = {}
    cols.forEach(c => {
      init[c.name] = { text: '', isNull: false }
    })
    setInsertCols(cols)
    setInsertValues(init)
    setInsertOpen(true)
  }

  const setInsertCol = (name, patch) => {
    setInsertValues(v => ({
      ...v,
      [name]: { ...(v[name] || { text: '', isNull: false }), ...patch }
    }))
  }

  // 表单 → 传参/预览的唯一口径在 db-change-set.buildInsertPayload：
  // 即时执行与 N2 暂存共用同一份构造，否则会出现"预览是 A、执行是 B"
  const insertPayload = useMemo(
    () => buildInsertPayload(insertCols, insertValues),
    [insertCols, insertValues]
  )
  const canSubmitInsert = canSubmitInsertForm(insertCols, insertValues)

  const submitInsert = async () => {
    if (!sel || !canSubmitInsert) {
      return
    }
    const values = insertPayload.values
    // N2：暂存开着时先把整行收进变更集并关掉弹窗（弹窗关掉=这行已经交代过了，
    // 值不会丢；E1 的确认留到应用那一刻，与改格/删行同一道闸）
    if (changes.stageInsertRow(insertPayload)) {
      setInsertOpen(false)
      return
    }
    // E1：production 连接上插行要二次确认（取消则插入弹窗保持打开，值不丢）
    const ok = await confirmRowWrite({
      level: 'write',
      text: insertRowPreview({ sel, cols: insertPayload.cols, vals: insertPayload.vals }),
      note: e('dbAffectedRows').replace('{n}', '1')
    })
    if (!ok) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'insertRow', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      values
    })
      .then(res => {
        setInsertOpen(false)
        message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
        // 行数变了 → 总数必须重算，否则"精确行数"会停在上一次的值上
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      })
      .catch(err => {
        setGrid(g => ({ ...g, loading: false }))
        onOpError(err)
      })
  }

  // 批量删除选中行：仅主键 IN 定位（无主键表不显示入口），二次确认后执行。
  // 原有 Popconfirm 保留（轻量、就地确认），production 连接再叠一层库名确认 ——
  // 前者是"点了会不会误触"，后者是"确认这是生产库"，两道语义不同
  const runDeleteRows = async () => {
    if (!sel || !pkColumn) {
      return
    }
    const pkValues = grid.rows
      .filter((_, i) => selectedRowKeys.includes(i))
      .map(r => r[pkColumn])
    if (!pkValues.length) {
      return
    }
    // N2：暂存开着时记下"要删这些行"，不发 deleteRows（行还在库里，页面上也不动）
    if (changes.stageDeleteRows(pkValues)) {
      return
    }
    // 删行定为 dangerous：批量删除不可撤销，按钮应以危险色呈现
    const ok = await confirmRowWrite({
      level: 'dangerous',
      text: deleteRowsPreview({ sel, pkColumn, pkValues }),
      note: e('dbAffected').replace('{n}', String(pkValues.length))
    })
    if (!ok) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'deleteRows', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      pkColumn,
      pkValues
    })
      .then(res => {
        message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      })
      .catch(onOpError)
  }

  // 反选：按当前页可见行（filteredRows 的 __rowKey）反转勾选
  const invertSelection = () => {
    setSelectedRowKeys(keys => {
      const cur = new Set(keys)
      return filteredRows
        .map(r => r.__rowKey)
        .filter(k => !cur.has(k))
    })
  }

  return {
    rowSelection,
    insertOpen,
    setInsertOpen,
    insertCols,
    setInsertCols,
    insertValues,
    setInsertValues,
    openInsertModal,
    setInsertCol,
    insertPayload,
    canSubmitInsert,
    submitInsert,
    runDeleteRows,
    invertSelection
  }
}
