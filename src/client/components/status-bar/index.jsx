/**
 * 底部状态栏：连接态 / 主机 / 类型 / 标签数
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
  return (
    <div className='main-statusbar'>
      <span className='statusbar-unit'>
        <i className={classnames('statusbar-dot', { ok, err: hasTab && !ok })} />
        {statusText(currentTab && currentTab.status)}
      </span>
      {
        hasTab && (
          <span className='statusbar-unit'>
            {typeText(currentTab)}
            {currentTab.host ? ` · ${currentTab.host}` : ''}
          </span>
        )
      }
      <span className='statusbar-grow' />
      <span className='statusbar-unit'>{tabCount} tab{tabCount === 1 ? '' : 's'}</span>
      <span className='statusbar-unit statusbar-hint'>Ctrl/Cmd + K</span>
    </div>
  )
})
