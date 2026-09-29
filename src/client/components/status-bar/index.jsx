/**
 * 底部状态栏：连接态 / 主机 / 类型 / 编码 / 标签数 / 命令面板提示
 * 对齐重设计草图 .statusbar：等宽字体、分段（.it）、主机名加粗、kbd 提示
 * 全 token 化，随 12 主题自适应
 */

import { auto } from 'manate/react'
import classnames from 'classnames'
import { statusMap } from '../../common/constants'
import { statusText, typeText } from './format'
import './index.styl'

export default auto(function StatusBar (props) {
  const { store } = props
  if (store.isMobile) {
    return null
  }
  const currentTab = store.currentTab
  const ok = currentTab && currentTab.status === statusMap.success
  const hasTab = !!currentTab
  const tabCount = (store.tabs || []).length
  const encode = hasTab && currentTab.encode
    ? String(currentTab.encode).toUpperCase()
    : ''
  return (
    <div className='main-statusbar'>
      <span className='statusbar-unit'>
        <i className={classnames('statusbar-dot', { ok, err: hasTab && !ok })} />
        {statusText(currentTab && currentTab.status)}
        {
          hasTab && currentTab.host
            ? <b className='statusbar-host'>{currentTab.host}</b>
            : null
        }
      </span>
      {
        hasTab && (
          <span className='statusbar-unit'>
            {typeText(currentTab)}
          </span>
        )
      }
      {
        encode && (
          <span className='statusbar-unit'>{encode}</span>
        )
      }
      <span className='statusbar-grow' />
      <span className='statusbar-unit'>{tabCount} tab{tabCount === 1 ? '' : 's'}</span>
      <span className='statusbar-unit statusbar-hint'>
        <kbd>Ctrl/Cmd + K</kbd> 命令面板
      </span>
    </div>
  )
})
