/**
 * 远程会话顶栏的连接信息（RDP / VNC / SPICE 共用）。
 *
 * 三端原来各自在 span 里手拼 user / host / port，格式与缺字段行为都不一致（VNC 多
 * 一个粗体桌面名，username 为空时会渲染出半截的 `@host:port`）。统一到
 * 这里，格式规则见 common/remote-display.js 的 formatConnInfo。
 *
 * `name` 只有 VNC 传（远端上报的 desktopName，别处看不到）；RDP/SPICE 不传。
 */

import { memo } from 'react'
import { formatConnInfo } from '../../common/remote-display'

function SessionInfo (props) {
  const { name, username, host, port } = props
  const info = formatConnInfo({ name, username, host, port })
  if (!info.name && !info.conn) {
    return null
  }
  return (
    <span className='remote-session-info mg2l mg2r'>
      {
        info.name
          ? <span className='remote-session-info-name mg1r'>{info.name}</span>
          : null
      }
      {info.conn}
    </span>
  )
}

export default memo(SessionInfo)
