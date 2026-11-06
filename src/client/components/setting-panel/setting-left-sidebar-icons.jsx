/**
 * editor (embedded in the common settings page) for the customizable
 * far-left sidebar icons. The select takes effect immediately — order of the
 * selected ids is the order shown in the sidebar.
 */

import { Select } from 'antd'
import {
  leftSidebarIconOptions,
  normalizeLeftSideBarIcons
} from '../../common/left-sidebar-icon-defs'

const { Option } = Select
const e = window.translate

export default function SettingLeftSidebarIcons (props) {
  const { config, store } = props
  // 过与左栏相同的 normalize：存量旧默认配置在侧栏已升级出 auditCenter，
  // 这里必须显示同一份列表，否则开关看起来是关的、图标却是显示的。
  // 用户一旦改动任意项就写入显式列表，不再触发迁移。
  const value = normalizeLeftSideBarIcons(config.leftSideBarIcons)

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
                {e(opt.text) || opt.text}
              </Option>
            )
          })
        }
      </Select>
    </div>
  )
}
