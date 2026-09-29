/**
 * 独立标题栏：Logo · 工作区 · 命令入口(⌘K) · 窗口控制三键
 * 系统标题栏模式 / macOS 下不渲染（沿用窗口控制三键的既有规则）
 */

import { auto } from 'manate/react'
import { isMacJs } from '../../common/constants'
import WindowControl from '../tabs/window-control'
import './index.styl'

const e = window.translate

export default auto(function TitleBar (props) {
  const { config } = props.store
  if (config.useSystemTitleBar || isMacJs) {
    return null
  }
  const openPalette = () => {
    window.dispatchEvent(new Event('open-command-palette'))
  }
  const ws = props.store.currentWorkspaceName || 'default'
  return (
    <div className='main-titlebar'>
      <div className='titlebar-brand'>
        <span className='titlebar-logo'>e</span>
        <span className='titlebar-name'>electerm</span>
        <span className='titlebar-ws'>{ws}</span>
      </div>
      <div
        className='titlebar-cmdk'
        onMouseDown={openPalette}
      >
        <span className='titlebar-cmdk-ico'>⌕</span>
        <span className='titlebar-cmdk-txt'>{e('commandPalette') || 'Search session / command'}</span>
        <kbd>Ctrl/Cmd+K</kbd>
      </div>
      <span className='titlebar-grow' />
      <WindowControl store={window.store} />
    </div>
  )
})
