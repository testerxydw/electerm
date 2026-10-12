/**
 * editor (embedded in the common settings page) for the customizable
 * far-left sidebar icons. The select takes effect immediately — order of the
 * selected ids is the order shown in the sidebar.
 */

import { Select } from 'antd'
import {
  leftSidebarIconOptions,
  defaultLeftSideBarIcons
} from '../../common/left-sidebar-icon-defs'

const { Option } = Select
const e = window.translate

export default function SettingLeftSidebarIcons (props) {
  const { config, store } = props
  const value = Array.isArray(config.leftSideBarIcons) && config.leftSideBarIcons.length
    ? config.leftSideBarIcons
    : [...defaultLeftSideBarIcons]

  const handleChange = (v) => {
    store.updateConfig({
      leftSideBarIcons: v
    })
  }

  return (
    <div className='pd2b'>
      <div className='pd1b'>{e('leftSideBarIcons')}</div>
      <Select
        mode='multiple'
        value={value}
        onChange={handleChange}
        popupMatchSelectWidth={false}
        style={{ minWidth: 320, width: '100%' }}
        placeholder={e('leftSideBarIcons')}
      >
        {
          leftSidebarIconOptions.map(opt => {
            return (
              <Option
                key={opt.id}
                value={opt.id}
              >
                {/* 右面板页签入口 (aiPanel/transferPanel/monitorPanel) 的 text 为显示文本非 locale key, 翻译缺失时兜底原文 */}
                {e(opt.text) || opt.text}
              </Option>
            )
          })
        }
      </Select>
    </div>
  )
}
