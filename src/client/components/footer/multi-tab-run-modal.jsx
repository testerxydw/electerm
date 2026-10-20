/**
 * Run one command (usually picked from the command history) in several
 * terminals at once.
 *
 * Reuses the footer batch input tab panel (`TabSelectList`) for picking the
 * target terminals, and the same selection state + `batchInput` terminal API
 * the footer batch input uses, so both entry points stay consistent.
 */

import { auto } from 'manate/react'
import {
  Button,
  Modal
} from 'antd'
import { TabSelectList } from './tab-select'
import { refs } from '../common/ref'
import { isShellSessionTab } from '../../common/constants'

const e = window.translate

export default auto(function MultiTabRunModal (props) {
  const { store, cmd, onClose } = props
  const selectedTabIds = store.batchInputSelectedTabIds
  // 只列有终端实例的 shell 会话 tab（白名单见 constants.js
  // isShellSessionTab），与底栏批量输入同口径
  const tabs = store.tabs.filter(isShellSessionTab).sort((a, b) => {
    // current tab goes first
    if (a.id === store.activeTabId) return -1
    if (b.id === store.activeTabId) return 1
    return 0
  })
  const listProps = {
    tabs,
    activeTabId: store.activeTabId,
    selectedTabIds,
    onSelect: store.onSelectBatchInputSelectedTabId,
    onSelectAll: store.selectAllBatchInputTabs,
    onSelectNone: store.selectNoneBatchInputTabs
  }
  function handleRun () {
    selectedTabIds.map(id => {
      return refs.get('term-' + id)
    }).forEach(term => {
      term?.batchInput(cmd)
    })
    store.addCmdHistory(cmd)
    onClose()
  }
  return (
    <Modal
      open
      title={e('runInAllTerminals')}
      onCancel={onClose}
      destroyOnHidden
      width={520}
      footer={[
        <Button
          key='cancel'
          onClick={onClose}
        >
          {e('cancel')}
        </Button>,
        <Button
          key='run'
          type='primary'
          disabled={!selectedTabIds.length}
          onClick={handleRun}
        >
          {e('ok')}
        </Button>
      ]}
    >
      <div className='multi-tab-run-cmd'>{cmd}</div>
      <TabSelectList {...listProps} />
    </Modal>
  )
})
