import { Popover } from 'antd'
import { CodeOutlined } from '@ant-design/icons'
import TabItem from './batch-item'

/**
 * The multi terminal selection panel shared by the "run in terminals" dialogs
 * (command history / quick commands) and the AI chat panel.
 * The footer broadcast trigger no longer expands its own panel: it opens the
 * G1 broadcast picker instead.
 */
export function TabSelectList (props) {
  const {
    selectedTabIds = [],
    tabs = [],
    activeTabId,
    onSelect,
    onSelectAll,
    onSelectNone
  } = props
  function renderTabs () {
    return tabs.map(tab => {
      const selected = selectedTabIds.includes(tab.id)
      const itemProps = {
        tab,
        selected,
        onSelect,
        id: tab.id,
        isCurrent: tab.id === activeTabId
      }
      return (
        <TabItem
          key={tab.id}
          {...itemProps}
        />
      )
    })
  }
  function renderBtns () {
    return (
      <div className='pd1t pd2b font12'>
        <span
          className='mg1r pointer'
          onClick={onSelectAll}
        >
          All
        </span>
        <span
          className='pointer'
          onClick={onSelectNone}
        >
          None
        </span>
      </div>
    )
  }
  return (
    <div className='pd1x alignright'>
      {renderBtns()}
      {renderTabs()}
    </div>
  )
}

// Popover 形态供 AI 面板使用；目标仍是同一份 batchInputSelectedTabIds 选中集
export default function TabSelect (props) {
  const { selectedTabIds, tabs, activeTabId } = props
  const listProps = {
    selectedTabIds,
    tabs,
    activeTabId,
    onSelect: window.store.onSelectBatchInputSelectedTabId,
    onSelectAll: window.store.selectAllBatchInputTabs,
    onSelectNone: window.store.selectNoneBatchInputTabs
  }
  return (
    <Popover
      content={<TabSelectList {...listProps} />}
      trigger='click'
    >
      <span className='pointer iblock pd1x'>
        ({selectedTabIds.length}) <CodeOutlined />
      </span>
    </Popover>
  )
}
