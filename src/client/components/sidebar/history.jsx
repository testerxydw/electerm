/**
 * history select
 */

import React, { useState, useEffect } from 'react'
import { auto } from 'manate/react'
import { UnorderedListOutlined } from '@ant-design/icons'
import SwitchLabel from '../common/switch'
import HistoryItem from './history-item'
import { historyConnStatus, openStatusByConn } from '../../common/history-conn-status'
import { getItemJSON, setItemJSON } from '../../common/safe-local-storage.js'
import '../setting-panel/list.styl'

const SORT_BY_FREQ_KEY = 'electerm-history-sort-by-frequency'

export default auto(function HistoryPanel (props) {
  const { store } = window
  const [sortByFrequency, setSortByFrequency] = useState(() => {
    return getItemJSON(SORT_BY_FREQ_KEY, false)
  })

  useEffect(() => {
    setItemJSON(SORT_BY_FREQ_KEY, sortByFrequency)
  }, [sortByFrequency])

  const {
    history
  } = store
  // doubleClickToOpenBookmark: a single click only marks the row, the session
  // opens on a double click. Touch devices have no double click, so the setting
  // is ignored there. Read here rather than in HistoryItem because this
  // component is `auto` — it re-renders when the input modality flips.
  const openOnDoubleClick = !!store.config.doubleClickToOpenBookmark &&
    !store.isTouchDevice
  let arr = store.config.disableConnectionHistory ? [] : history
  if (sortByFrequency) {
    arr = [...arr].sort((a, b) => { return b.count - a.count })
  }

  const handleSortByFrequencyChange = (checked) => {
    setSortByFrequency(checked)
  }

  const handleClearHistory = () => {
    store.clearHistory()
  }
  const e = window.translate
  function renderHeader () {
    if (!arr.length) {
      return null
    }
    return (
      <div className='history-header pd2x pd2b'>
        <div className='history-sort'>
          <SwitchLabel
            checked={sortByFrequency}
            onChange={handleSortByFrequencyChange}
            size='small'
            label={e('sortByFrequency')}
          />
        </div>
        <UnorderedListOutlined
          {...clearIconProps}
        />
      </div>
    )
  }
  const clearIconProps = {
    className: 'history-clear-icon pointer clear-ai-icon icon-hover',
    title: window.translate('clear'),
    onClick: handleClearHistory
  }
  // P-3 连接状态点：每次渲染从当前页签现算一张「连接键 → 状态」表（纯视觉，
  // 不往 history 条目里写字段）。在这里算而不是在 HistoryItem 里，是因为这层是
  // `auto`（页签增删/状态变化会重渲染），HistoryItem 是普通组件，拿不到这个订阅。
  const openStatus = openStatusByConn(store.tabs)
  return (
    <div
      className='sidebar-panel-history'
    >
      {renderHeader()}
      <div className='history-body'>
        {
          arr.map((item, i) => {
            return (
              <HistoryItem
                key={item.id}
                item={item}
                openOnDoubleClick={openOnDoubleClick}
                connStatus={historyConnStatus(item.tab, openStatus)}
              />
            )
          })
        }
      </div>
    </div>
  )
})
