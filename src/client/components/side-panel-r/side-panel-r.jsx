import React, { memo, useRef, useEffect } from 'react'
import DragHandle from '../common/drag-handle'
import './right-side-panel.styl'
import {
  CloseCircleOutlined,
  PushpinOutlined
} from '@ant-design/icons'
import {
  Flex
} from 'antd'
import { isAIDisabled } from '../../common/ai-feature'

const e = window.translate

export default memo(function RightSidePanel (
  {
    rightPanelVisible,
    rightPanelPinned,
    rightPanelWidth,
    children,
    title,
    rightPanelTab,
    isMobile,
    cmdHistoryInRightPanel,
    quickCommandsInRightPanel
  }
) {
  const panelRef = useRef(null)

  // Esc closes the panel, but never at the terminal's expense: xterm forwards
  // Esc to the remote shell, so stealing it there would break vim, less, etc.
  // The guard checks the event target rather than focus state, because the
  // keydown bubbles up from xterm's textarea inside .term-wrap — the same
  // selector shortcut-bar-entry.jsx uses to detect terminal focus. A modal owns
  // Esc while one is open. This hook has to stay above the early return below
  // so the hook order never changes.
  useEffect(() => {
    if (!rightPanelVisible) {
      return
    }
    function onKeyDown (event) {
      if (event.key !== 'Escape' || window.store.showModal) {
        return
      }
      const { target } = event
      if (target && typeof target.closest === 'function' && target.closest('.term-wrap')) {
        return
      }
      window.store.rightPanelVisible = false
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [rightPanelVisible])

  if (!rightPanelVisible) {
    return null
  }
  // Mobile has no pin control (it is not rendered below), so a pin persisted
  // from a desktop session must not turn the panel into a dock here — that
  // would make it full height over the footer for no reachable reason.
  const pinned = rightPanelPinned && !isMobile
  // 对齐重设计草图的右面板页签：AI / 传输 / 监控；
  // 文件信息与底栏信息按钮同状态（rightPanelTab='info'），页签/按钮灯态联动；
  // 命令历史/快捷命令寄居右面板时（双 home），顶栏动态出现对应页签并选中
  const aiDisabled = isAIDisabled()
  const tabs = [
    { key: 'ai', label: 'AI' },
    { key: 'transfer', label: '传输' },
    { key: 'monitor', label: '监控' },
    { key: 'info', label: e('info') }
  ]
  if (cmdHistoryInRightPanel) {
    tabs.push({ key: 'cmdHistory', label: e('cmdHistory') })
  }
  if (quickCommandsInRightPanel) {
    tabs.push({ key: 'quickCommands', label: e('quickCommands') })
  }

  function onDragEnd (nw) {
    window.store.setRightSidePanelWidth(nw)
  }

  function onDragMove (nw) {
    if (panelRef.current) {
      panelRef.current.style.width = nw + 'px'
    }
  }

  function onClose () {
    window.store.rightPanelVisible = false
  }

  function togglePin () {
    window.store.setRightPanelPinned(!window.store.rightPanelPinned)
  }

  const panelProps = {
    className: 'right-side-panel animate-fast' + (pinned ? ' right-side-panel-pinned' : ''),
    ref: panelRef,
    style: {
      width: `${rightPanelWidth}px`
    }
  }

  const pinProps = {
    className: 'right-side-panel-pin right-side-panel-controls' + (pinned ? ' pinned' : ''),
    onClick: togglePin
  }
  const dragProps = {
    min: 400,
    max: 1000,
    width: rightPanelWidth,
    onDragEnd,
    onDragMove,
    left: false
  }
  return (
    <div
      {...panelProps}
    >
      {/* Mobile panels are full-screen drawers (see store.rightPanelWidth):
          their width is the viewport and is not adjustable, so the resize
          handle is not rendered — it would otherwise sit on the screen's left
          edge and drag a size the panel never uses. */}
      {!isMobile && <DragHandle {...dragProps} />}
      <Flex
        className='right-panel-tabs'
        align='center'
      >
        {
          tabs.filter(t => t.key !== 'ai' || !aiDisabled).map(t => (
            <span
              key={t.key}
              className={
                'right-panel-tab' +
                (rightPanelTab === t.key ? ' on' : '')
              }
              onClick={() => { window.store.rightPanelTab = t.key }}
            >
              {t.label}
            </span>
          ))
        }
        <span className='right-panel-tab-grow' />
        <span className='right-panel-tab-title elli'>{title}</span>
        {!isMobile && (
          <PushpinOutlined
            {...pinProps}
          />
        )}
        <CloseCircleOutlined
          className='right-side-panel-close right-side-panel-controls mg1l'
          onClick={onClose}
        />
      </Flex>
      <div className='right-side-panel-content'>
        {children}
      </div>
    </div>
  )
})
