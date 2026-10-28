/**
 * G1 广播输入红条（设计 §14.2）
 *
 * 只在主控 tab 里渲染：浮在终端内容顶部 28px，不进布局流（避免终端 fit 重排）。
 * 点击红条或按 Esc 退出广播。密码提示期间文案改为"已暂停"并转成警示色。
 * Esc 用捕获阶段监听：xterm 的隐藏 textarea 会先收到按键，必须抢在它前面。
 */
import { useEffect } from 'react'
import { auto } from 'manate/react'
import './broadcast.styl'

const e = window.translate

export default auto(function BroadcastBar (props) {
  const { tabId } = props
  const store = window.store
  const state = store.broadcast
  const visible = !!state && state.on && state.sourceTabId === tabId

  useEffect(() => {
    if (!visible) {
      return
    }
    const onKeyDown = ev => {
      if (ev.key !== 'Escape') {
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      window.store.stopBroadcast()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [visible])

  if (!visible) {
    return null
  }
  const count = (state.targets || []).length
  const blocked = !!state.blocked
  const cls = 'broadcast-bar' + (blocked ? ' broadcast-bar-blocked' : '')
  return (
    <div
      className={cls}
      role='button'
      tabIndex={0}
      title={e('broadcastBarExit')}
      onClick={() => window.store.stopBroadcast()}
      onKeyDown={ev => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          window.store.stopBroadcast()
        }
      }}
    >
      <span className='broadcast-bar-dot' />
      <span className='broadcast-bar-text'>
        {e('broadcastBarText').replace('{n}', String(count))}
      </span>
      {blocked
        ? (
          <span className='broadcast-bar-blocked-hint'>
            · {e('broadcastBlockedPassword')}
          </span>
          )
        : null}
      <span className='broadcast-bar-exit'>
        {e('broadcastBarExit')} · Esc
      </span>
    </div>
  )
})
