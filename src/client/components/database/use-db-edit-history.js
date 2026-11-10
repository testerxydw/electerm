// N12c 数据修改历史（query edit history）页面侧接线。
// 与 use-db-sql-history（SQL 执行历史）同模式但精简一档：编辑历史是低频回溯场景，
// 不做键盘走查/弹层尺寸拖拽；列表/筛选/单条删除/清空/导出与 SQL 历史同口径。
import { useMemo, useState } from 'react'
import message from '../common/message'
import {
  listEditHistory,
  clearEditHistory,
  removeEditHistory,
  exportEditHistory,
  EDIT_HISTORY_MAX
} from '../../common/db-edit-history'

const e = window.translate

// 只看语句文本/目标表的筛选（与 SQL 历史同口径：命中即保留）
function filterHistory (items, kw) {
  const q = String(kw || '').trim().toLowerCase()
  if (!q) {
    return items
  }
  return items.filter(it => (
    (it.sql || '').toLowerCase().includes(q) ||
    (it.table || '').toLowerCase().includes(q) ||
    (it.database || '').toLowerCase().includes(q)
  ))
}

export function useDbEditHistory () {
  const [editHistoryOpen, setEditHistoryOpen] = useState(false)
  const [editHistory, setEditHistory] = useState([])
  const [editHistoryFilter, setEditHistoryFilter] = useState('')

  const editHistoryList = useMemo(
    () => filterHistory(editHistory, editHistoryFilter),
    [editHistory, editHistoryFilter]
  )

  const openEditHistory = (open) => {
    setEditHistoryOpen(open)
    // 每次打开刷新列表，避免读陈旧快照（listEditHistory 已异步，失败静默返回 []）
    if (open) {
      setEditHistoryFilter('')
      listEditHistory()
        .then(setEditHistory)
        .catch(err => console.warn('load edit history failed:', err))
    }
  }

  const removeOneEditHistory = (item) => {
    if (!item) {
      return
    }
    const next = editHistory.filter(
      x => !(x.ts === item.ts && x.sql === item.sql)
    )
    if (next.length === editHistory.length) {
      return
    }
    // 先本地移除，点击即刻消失不等 IPC 回包；同一 (ts, sql) 再交主进程落盘，
    // 失败不回滚——下次打开会重新出现，但比"点了没反应"好
    setEditHistory(next)
    removeEditHistory(item).catch(() => {})
  }

  const clearAllEditHistory = () => {
    clearEditHistory()
    setEditHistory([])
    setEditHistoryFilter('')
  }

  const exportEditHistoryFile = () => {
    const items = editHistoryFilter.trim() ? editHistoryList : editHistory
    if (!items.length) {
      message.warning(e('dbEditHistoryEmpty'))
      return
    }
    window.api.saveDialog({
      title: e('dbEditHistoryExport'),
      defaultPath: 'db-edit-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
      .then(res => {
        if (!res || res.canceled || !res.filePath) {
          return null
        }
        return exportEditHistory(res.filePath, items).then(n => {
          message.success(e('dbHistExported').replace('{n}', String(n)))
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbHistExportFailed'))
      })
  }

  return {
    editHistoryOpen,
    editHistory,
    editHistoryList,
    editHistoryFilter,
    setEditHistoryFilter,
    openEditHistory,
    removeOneEditHistory,
    clearAllEditHistory,
    exportEditHistoryFile,
    editHistoryMax: EDIT_HISTORY_MAX
  }
}
