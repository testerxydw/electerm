// S3 SQL 执行历史（cluster #8 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：两个标记段（S3-C 状态/refs/handlers + S3-D 导出）逐字合并进本 hook；
// 页面级 state/ref 随簇搬入（参照 use-db-tree 自建簇私有 state 的先例），setSqlText 由 owner 注入。
import { useMemo, useRef, useState } from 'react'
import message from '../common/message'
import {
  listSqlHistory,
  clearSqlHistory,
  removeSqlHistory,
  exportSqlHistory as exportHistoryFile
} from '../../common/db-sql-history'
import {
  clampHistoryIndex,
  filterHistory,
  readHistoryPanelSize
} from '../../common/db-sql-history-panel'
import { viewportSize } from '../../common/db-session-const'

const e = window.translate

export function useDbSqlHistory ({ setSqlText }) {
  // ---- S3-C SQL 执行历史（主进程文件环形存储，上限见 SQL_HISTORY_MAX，仅本地，跨启动稳定） ----

  const [sqlHistoryOpen, setSqlHistoryOpen] = useState(false)
  const [sqlHistory, setSqlHistory] = useState([])
  // 弹层尺寸：拖拽出来的，落盘在 config（dbSqlHistoryWidth/Height），跨启动稳定。
  // 初值读 config 时就夹一次，旧配置在更小的窗口上不会溢出
  const [histSize, setHistSize] = useState(
    () => readHistoryPanelSize(window.store._config, viewportSize())
  )
  // 拖拽期间要的是"最新的"尺寸而不是本次渲染闭包里的，用 ref 兜住
  const histSizeRef = useRef(histSize)
  // 当前悬浮/键盘选中的条目（预览栏与高亮共用同一份状态，
  // 否则鼠标预览和键盘走查会指向两行）
  const [histIndex, setHistIndex] = useState(0)
  const histListRef = useRef(null)
  // 300 条上限里找一条旧语句全靠滚动太费劲，给个只看语句文本的筛选框
  const [histFilter, setHistFilter] = useState('')
  const histList = useMemo(
    () => filterHistory(sqlHistory, histFilter),
    [sqlHistory, histFilter]
  )

  const openSqlHistory = (open) => {
    setSqlHistoryOpen(open)
    // 每次打开刷新列表，避免读陈旧快照（listSqlHistory 已异步，失败静默返回 []）
    if (open) {
      setHistIndex(0)
      setHistFilter('')
      listSqlHistory()
        .then(setSqlHistory)
        .catch(err => console.warn('load sql history failed:', err))
      // 列表一出现就给焦点：否则打开后按 ↑↓ 没反应（要先用鼠标点一下）
      setTimeout(() => {
        const el = histListRef.current
        if (el && el.focus) {
          el.focus()
        }
      }, 60)
    }
  }
  const pickSqlHistory = (item) => {
    setSqlText(item.sql)
    openSqlHistory(false)
  }
  const clearAllSqlHistory = () => {
    clearSqlHistory()
    setSqlHistory([])
    setHistIndex(0)
  }
  // 单条删除（悬浮 X / Delete 键）：先本地移除，点击即刻消失不等 IPC 回包；
  // 同一 (sql, ts) 再交给主进程落盘，失败不回滚——下次打开会重新出现，
  // 但比"点了没反应"好。不按下标删：列表可能处于筛选状态，下标对不上存储位置
  const removeOneSqlHistory = (item) => {
    if (!item) {
      return
    }
    const next = sqlHistory.filter(
      x => !(x.ts === item.ts && x.sql === item.sql)
    )
    if (next.length === sqlHistory.length) {
      return
    }
    setSqlHistory(next)
    // 删最后一条时原下标越界，夹一次；删中间的停在原下标（正好是原位置的下一项）
    setHistIndex(clampHistoryIndex(histIndex, filterHistory(next, histFilter).length))
    removeSqlHistory(item).catch(() => {})
    // 按钮随条目一起被移除，焦点会掉回 body，键盘走查就断了——还回列表
    setTimeout(() => {
      const el = histListRef.current
      if (el && el.focus) {
        el.focus()
      }
    }, 0)
  }

  // ---- 历史导出（S3-D）：全部或当前筛选结果 ----
  const exportSqlHistory = () => {
    const items = histFilter.trim() ? histList : sqlHistory
    if (!items.length) {
      message.warning(e('dbHistExportEmpty'))
      return
    }
    window.api.saveDialog({
      title: e('dbHistExport'),
      defaultPath: 'db-sql-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
      .then(res => {
        if (!res || res.canceled || !res.filePath) {
          return null
        }
        return exportHistoryFile(res.filePath, items).then(n => {
          message.success(e('dbHistExported').replace('{n}', String(n)))
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbHistExportFailed'))
      })
  }

  return {
    sqlHistoryOpen,
    setSqlHistoryOpen,
    sqlHistory,
    setSqlHistory,
    histSize,
    setHistSize,
    histSizeRef,
    histIndex,
    setHistIndex,
    histListRef,
    histFilter,
    setHistFilter,
    histList,
    openSqlHistory,
    pickSqlHistory,
    clearAllSqlHistory,
    removeOneSqlHistory,
    exportSqlHistory
  }
}
