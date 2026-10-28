/**
 * G1 广播输入目标选择弹层（设计 §14.2）
 *
 * 默认勾选全部非生产 shell 会话；选中里含生产机时先在同弹层里换到确认步骤
 * （列出主机名），确认后才真正开启广播。目标断连由 store 自动移出。
 */
import { useEffect, useState } from 'react'
import { auto } from 'manate/react'
import { Modal, Checkbox, Button } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import message from '../common/message'
import { isShellSessionTab } from '../../common/constants'
import './broadcast.styl'

const e = window.translate

function titleOf (tab) {
  return tab.title || tab.host || tab.id
}

export default auto(function BroadcastModal () {
  const store = window.store
  const open = !!store.broadcastPickerOpen
  const [selected, setSelected] = useState([])
  const [step, setStep] = useState('pick')

  const sourceTab = store.currentTab
  const candidates = store.tabs.filter(
    t => isShellSessionTab(t) && t.id !== store.activeTabId
  )
  // 可选集合变化（新开/关闭 tab）时重算默认勾选：全部非生产目标
  const signature = candidates.map(t => t.id).join(',')

  useEffect(() => {
    if (!open) {
      return
    }
    setStep('pick')
    setSelected(
      candidates
        .filter(t => t.production !== true)
        .map(t => t.id)
    )
    // 只在打开瞬间或候选集合变化时重置，用户勾选过程不被打断
  }, [open, signature])

  if (!open) {
    return null
  }

  const selectedTabs = candidates.filter(t => selected.includes(t.id))
  const prodTabs = selectedTabs.filter(t => t.production === true)

  function toggle (id) {
    setSelected(ids => (
      ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
    ))
  }

  function submit () {
    if (!selected.length) {
      return message.warning(e('broadcastNoTarget'))
    }
    if (prodTabs.length) {
      setStep('confirm')
      return
    }
    store.startBroadcast(selected)
  }

  function renderList () {
    if (!candidates.length) {
      return <div className='broadcast-empty'>{e('broadcastEmpty')}</div>
    }
    return (
      <div className='broadcast-list'>
        {candidates.map(tab => {
          const on = selected.includes(tab.id)
          return (
            <label
              key={tab.id}
              className={'broadcast-item' + (on ? ' broadcast-item-on' : '')}
            >
              <Checkbox checked={on} onChange={() => toggle(tab.id)} />
              <span className='broadcast-item-title'>{titleOf(tab)}</span>
              {tab.host
                ? <span className='broadcast-item-host'>{tab.host}</span>
                : null}
              {tab.production === true
                ? <span className='broadcast-prod-badge'>{e('broadcastProductionBadge')}</span>
                : null}
            </label>
          )
        })}
      </div>
    )
  }

  function renderPick () {
    return (
      <div className='broadcast-pick'>
        <p className='broadcast-desc'>{e('broadcastDesc')}</p>
        {sourceTab
          ? (
            <p className='broadcast-desc'>
              {e('broadcastSourceLine').replace('{title}', titleOf(sourceTab))}
            </p>
            )
          : null}
        {renderList()}
        <div className='broadcast-tools'>
          <Button
            size='small'
            onClick={() => setSelected(candidates.map(t => t.id))}
          >
            {e('broadcastAll')}
          </Button>
          <Button size='small' onClick={() => setSelected([])}>
            {e('broadcastNone')}
          </Button>
          <span className='broadcast-item-host'>
            {selected.length} / {candidates.length}
          </span>
        </div>
      </div>
    )
  }

  function renderConfirm () {
    return (
      <div className='broadcast-confirm'>
        <p className='broadcast-prod-warn'>
          <ExclamationCircleOutlined /> {e('broadcastProductionWarn')}
        </p>
        <div className='broadcast-prod-hosts'>
          {prodTabs.map(t => t.host || titleOf(t)).join('\n')}
        </div>
      </div>
    )
  }

  function renderFooter () {
    if (step === 'confirm') {
      return [
        <Button key='back' onClick={() => setStep('pick')}>
          {e('broadcastBack')}
        </Button>,
        <Button
          key='ok'
          type='primary'
          danger
          onClick={() => store.startBroadcast(selected)}
        >
          {e('broadcastStartAnyway')}
        </Button>
      ]
    }
    return [
      <Button key='cancel' onClick={() => store.closeBroadcastPicker()}>
        {e('cancel')}
      </Button>,
      <Button
        key='ok'
        type='primary'
        disabled={!selected.length}
        onClick={submit}
      >
        {e('broadcastStart')}
      </Button>
    ]
  }

  return (
    <Modal
      open={open}
      title={e('broadcastInput')}
      width={480}
      destroyOnClose
      onCancel={() => store.closeBroadcastPicker()}
      footer={renderFooter()}
    >
      {step === 'confirm' ? renderConfirm() : renderPick()}
    </Modal>
  )
})
