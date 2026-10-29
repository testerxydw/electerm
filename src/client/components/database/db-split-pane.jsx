/**
 * 数据库页上下可拖拽分区（redis 键列表/详情、mysql 网格/单元格预览共用）
 * - 比例持久化 localStorage（storageKey），拖拽 clamp 15~85
 * - top/bottom 由调用方传入（元素或节点），pane 内 flex 1 1 0，子内容自行撑满
 * - `collapsed`：只把 bottom 当一条贴底工具条（按内容高，不给拖拽、不读比例）。
 *   刻意保留同一条 DOM 链路而不是"折叠时不渲染 DbSplitPane"：换树形会让 top 里的
 *   网格整块重挂，虚拟滚动的纵向位置与横向滚动全部丢回去 —— 用户刚点了一格，
 *   结果表格自己跳回左上角，这比"展开的面板占高"更糟。
 */
import React, { useState } from 'react'

const MIN_PCT = 15
const MAX_PCT = 85

export default function DbSplitPane (props) {
  const { storageKey, defaultPct = 50, top, bottom, collapsed = false } = props
  const [pct, setPct] = useState(() => {
    const v = Number(window.localStorage.getItem(storageKey))
    return v >= MIN_PCT && v <= MAX_PCT ? v : defaultPct
  })
  if (collapsed) {
    return (
      <div className='db-split-pane db-split-pane-collapsed'>
        <div className='db-split-pane-top'>{top}</div>
        <div className='db-split-pane-bottom'>{bottom}</div>
      </div>
    )
  }
  const startResize = (ev) => {
    ev.preventDefault()
    const startY = ev.clientY
    const startPct = pct
    const root = ev.target.closest('.db-split-pane')
    let last = startPct
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const onMove = (e) => {
      const h = root ? root.clientHeight : 0
      if (h <= 0) {
        return
      }
      const next = Math.min(MAX_PCT, Math.max(MIN_PCT, startPct + (e.clientY - startY) * 100 / h))
      last = next
      setPct(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = prevSelect
      window.localStorage.setItem(storageKey, String(Math.round(last)))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  return (
    <div className='db-split-pane'>
      <div className='db-split-pane-top' style={{ flexBasis: pct + '%' }}>{top}</div>
      <div className='db-split-resizer' onMouseDown={startResize} />
      <div className='db-split-pane-bottom' style={{ flexBasis: (100 - pct) + '%' }}>{bottom}</div>
    </div>
  )
}
