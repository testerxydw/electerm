import React from 'react'
import { Tooltip } from 'antd'
import './session-rec-indicator.styl'

const e = window.translate

// T5-4c 会话录制指示浮层: 录制中显示于终端区右上, 点击停止录制。
// 状态源 window.store.recState (store/session.js toggleSessionRecord);
// manate 追踪在父级 session.jsx (render 读 recState 后传 recording prop),
// 本组件纯 props 展示, 不自行读 store。
export default function SessionRecIndicator (props) {
  const { recording, recPath = '', tabId } = props
  if (!recording) {
    return null
  }
  return (
    <Tooltip title={`${e('stopRecord')}: ${recPath}`} placement='leftTop'>
      <div
        className='session-rec-indicator pointer'
        onClick={() => window.store.toggleSessionRecord(tabId)}
      >
        <span className='rec-dot' />
        REC
      </div>
    </Tooltip>
  )
}
