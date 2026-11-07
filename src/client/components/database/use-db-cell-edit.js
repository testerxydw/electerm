// #4 单元格编辑（cluster #4 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：行内单格编辑闭环 —— 进入编辑（startEdit）/ 取消（cancelEdit）/
// 提交（submitEdit）/ 参数化 UPDATE（runCellUpdate，主进程按引擎拼 UPDATE，
// 前端只传主键值定位）。返回 undefined 的写法与旧内联段逐字一致。
// 编辑态 editing/editValue 是页面级 state（A1 列工厂的行内编辑参数与底部值面板共用），
// 按 AGENTS.md §5.2.4 留 owner 持有并注入；
// selectCell（单元格选中）服务预览面板选中而非编辑，不属本簇，同样留 owner。
import message from '../common/message'
import { updateCellPreview } from '../../common/db-change-preview'

const e = window.translate

export function useDbCellEdit ({
  canEditCell,
  editing,
  setEditing,
  editValue,
  setEditValue,
  grid,
  sel,
  pkColumn,
  tabId,
  changes,
  confirmRowWrite,
  setGrid,
  loadQuery,
  onOpError
}) {
  const startEdit = (row, col) => {
    if (!canEditCell) {
      message.error(e('dbNoPrimaryKey'))
      return
    }
    setEditing({ rowKey: row.__rowKey, col })
    setEditValue(row[col] === null || row[col] === undefined ? '' : String(row[col]))
  }

  const cancelEdit = () => {
    setEditing(null)
  }

  // 单元格 UPDATE（行内双击编辑与预览面板共用）：主进程按引擎参数化构造 UPDATE，
  // 前端只传主键值定位，不拼接 SQL
  const runCellUpdate = async (rowKey, col, value) => {
    const row = grid.rows[rowKey]
    if (!row || !sel) {
      return
    }
    // N2：暂存开着时这条改动进变更集，一个 op 都不发（数据库此刻没被改过）。
    // 返回值就是"我消费掉了"，所以即时执行路径保持原样不动
    if (changes.stageCellEdit({ pkValue: row[pkColumn], column: col, value })) {
      return
    }
    // E1：production 连接上改数据要二次确认（带表名/列名/主键定位与影响行数）
    const ok = await confirmRowWrite({
      level: 'write',
      text: updateCellPreview({
        sel,
        pkColumn,
        pkValue: row[pkColumn],
        column: col,
        value
      }),
      note: e('dbAffectedRows').replace('{n}', '1')
    })
    if (!ok) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'updateCell', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      pkColumn,
      pkValue: row[pkColumn],
      column: col,
      value
    })
      .then(() => loadQuery(sel, grid.page))
      .catch(err => {
        setGrid(g => ({ ...g, loading: false }))
        onOpError(err)
      })
  }

  const submitEdit = () => {
    const target = editing
    setEditing(null)
    if (!target || !sel) {
      return
    }
    runCellUpdate(target.rowKey, target.col, editValue)
  }

  return { startEdit, cancelEdit, runCellUpdate, submitEdit }
}
