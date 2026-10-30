import React from 'react'
import {
  FullscreenExitOutlined,
  AppstoreOutlined,
  MoreOutlined
} from '@ant-design/icons'
import { Dropdown } from 'antd'
import './remote-float-control.styl'

const e = window.translate

export default function RemoteFloatControl (props) {
  const {
    isFullScreen,
    onSendCtrlAltDel,
    fixedPosition = true,
    showExitFullscreen = true,
    className = ''
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

  // 已删除多显示器子菜单：选屏只在 VNC 有，而它已经把入口放在顶栏左侧的 Select
  // 里，同一个功能两个入口会让用户不知道该点哪个（见
  // doc/分析-远程会话顶栏差异与统一-2026-10-30.md §4）。RDP/SPICE/DB 一直传的是空数组。

  const containerClassName = (fixedPosition ? 'remote-float-control' : 'remote-float-control-inline') + (className ? ' ' + className : '')
  const buttonClassName = fixedPosition ? 'remote-float-btn' : 'remote-float-btn-inline'
  const iconClassName = fixedPosition ? 'font20' : ''

  return (
    <div className={containerClassName}>
      <Dropdown menu={{ items }} trigger={['click']}>
        <div className={buttonClassName}>
          <MoreOutlined className={iconClassName} />
        </div>
      </Dropdown>
    </div>
  )
}
