/**
 * 窗口级动作共享（S1）：查找 + 全屏两个顶栏图标
 *
 * 使用方（同位置同口径）：
 * - 终端 .terminal-control 右侧（session-control.jsx renderTermControls）
 * - 数据库页 .db-head-actions（db-session.jsx headBar）
 * - web 页地址栏右端（address-bar.jsx suffix）
 * - telnet 复用终端路径自动获得
 *
 * 视觉：沿用终端既有全局工具类（mg1r/icon-info/iblock/pointer/spliter），
 * 查找激活态 .search-open 染主色（session-control.styl，全局类），
 * 三页 tooltip 统一 placement=bottomLeft。
 */
import { Tooltip } from 'antd'
import { SearchOutlined, FullscreenOutlined } from '@ant-design/icons'

export default function SessionBarActions (props) {
  const {
    searchOpen,
    onToggleSearch,
    onFullscreen,
    showSearch = true,
    showFullscreen = true
  } = props
  return (
    <>
      {
        showSearch
          ? (
            <Tooltip title={window.translate('search')} placement='bottomLeft'>
              <SearchOutlined
                className={
                  'mg1r icon-info iblock pointer spliter session-bar-search' +
                  (searchOpen ? ' search-open' : '')
                }
                onClick={onToggleSearch}
              />
            </Tooltip>
            )
          : null
      }
      {
        showFullscreen
          ? (
            <Tooltip title={window.translate('fullscreen')} placement='bottomLeft'>
              <FullscreenOutlined
                className='mg1r icon-info iblock pointer spliter fullscreen-control-icon'
                onClick={onFullscreen}
              />
            </Tooltip>
            )
          : null
      }
    </>
  )
}
