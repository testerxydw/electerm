import React from 'react'
import {
  FullscreenExitOutlined,
  AppstoreOutlined,
  MoreOutlined
} from '@ant-design/icons'
import { Dropdown } from 'antd'
import './remote-float-control.styl'

const e = window.translate

/**
 * The `⋮` menu of a remote session - actions only.
 *
 * Display controls (resolution / screen picker, scale toggle) stay in the
 * control bar so they are visible without opening a popup; this menu is not a
 * settings page. See doc/分析-远程会话顶栏差异与统一-2026-10-30.md §5.
 */
export default function RemoteFloatControl (props) {
  const {
    isFullScreen,
    onSendCtrlAltDel,
    fixedPosition = true,
    showExitFullscreen = true
  } = props

  if (fixedPosition && !isFullScreen) return null

  function onExitFullScreen () {
    window.store.toggleSessFullscreen(false)
  }

  const items = []

  if (showExitFullscreen && isFullScreen) {
    items.push({
      key: 'exit-fullscreen',
      label: e('exitFullscreen') || 'Exit Fullscreen',
      icon: <FullscreenExitOutlined />,
      onClick: onExitFullScreen
    })
  }

  if (onSendCtrlAltDel) {
    items.push({
      key: 'ctrl-alt-del',
      label: 'Send Ctrl+Alt+Del',
      icon: <AppstoreOutlined />,
      onClick: onSendCtrlAltDel
    })
  }

  const containerClassName = fixedPosition ? 'remote-float-control' : 'remote-float-control-inline'
  const buttonClassName = fixedPosition ? 'remote-float-btn' : 'remote-float-btn-inline'
  const iconClassName = fixedPosition ? 'font20' : ''

  return (
    <div className={containerClassName}>
      <Dropdown
        menu={{ items }}
        trigger={['click']}
      >
        <div className={buttonClassName}>
          <MoreOutlined className={iconClassName} />
        </div>
      </Dropdown>
    </div>
  )
}
