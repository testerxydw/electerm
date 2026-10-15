/**
 * 数据库页上下可拖拽分区（redis 键列表/详情、mysql 网格/单元格预览共用）
 * - 比例持久化 localStorage（storageKey），拖拽 clamp 15~85
 * - top/bottom 由调用方传入（元素或节点），pane 内 flex 1 1 0，子内容自行撑满
 */
import React, { useState } from 'react'

const MIN_PCT = 15
const MAX_PCT = 85

export default function DbSplitPane (props) {
  const { storageKey, defaultPct = 50, top, bottom } = props
  const [pct, setPct] = useState(() => {
    const v = Number(window.localStorage.getItem(storageKey))
    return v >= MIN_PCT && v <= MAX_PCT ? v : defaultPct
  })
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
