import { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import './session-rec-indicator.styl'

const e = window.translate

// 录制时长 mm:ss（仅本组件展示用）
function formatDuration (ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

// T5-4c 会话录制指示浮层: 录制中显示于终端区右上, 点击停止录制。
// T5-4f: 暂停态显示「Paused MM:SS」并停止红点闪烁。
// 状态源 window.store.recState (store/session.js toggleSessionRecord);
// manate 追踪在父级 session.jsx (render 读 recState 后传 props),
// 本组件纯 props 展示, 不自行读 store。
export default function SessionRecIndicator (props) {
  const {
    recording,
    paused = false,
    startTime = 0,
    recPath = '',
    tabId
  } = props
  // 暂停时长每秒刷新（录制中不需要走秒, 避免无谓重渲染）
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!recording || !paused) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording, paused])
  if (!recording) {
    return null
  }
  return (
    <Tooltip title={`${e('stopRecord')}: ${recPath}`} placement='leftTop'>
      <div
        className={'session-rec-indicator pointer' + (paused ? ' paused' : '')}
        onClick={() => window.store.toggleSessionRecord(tabId)}
      >
        <span className='rec-dot' />
        {paused ? `${e('paused')} ${formatDuration(now - startTime)}` : 'REC'}
      </div>
    </Tooltip>
  )
}
