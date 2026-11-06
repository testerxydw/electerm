/**
 * G1 广播输入目标选择弹层（设计 §14.2）
 *
 * 两种模式共用同一份目标选择 + 生产机二次确认：
 *   - 持续广播：主控每次按键实时镜像到目标，直到手动退出
 *   - 发送一次：把一条（可多行）命令发到目标后立即结束，主控后续输入不参与
 *
 * 默认勾选全部非生产 shell 会话；选中里含生产机时先在同弹层里换到确认步骤
 * （列出主机名），确认后才真正发送。目标断连由 store 自动移出。
 */
import { useEffect, useState } from 'react'
import { auto } from 'manate/react'
import { Modal, Checkbox, Button, Segmented, Input } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import message from '../common/message'
import { isShellSessionTab } from '../../common/constants'
import './broadcast.styl'

const e = window.translate
const MODE_CONTINUOUS = 'continuous'
const MODE_ONCE = 'once'

function titleOf (tab) {
  return tab.title || tab.host || tab.id
}

export default auto(function BroadcastModal () {
  const store = window.store
  const open = !!store.broadcastPickerOpen
  const [selected, setSelected] = useState([])
  const [step, setStep] = useState('pick')
  const [mode, setMode] = useState(MODE_CONTINUOUS)
  const [cmd, setCmd] = useState('')
  const [includeSource, setIncludeSource] = useState(false)

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
    setMode(store.broadcastPickerMode === MODE_ONCE ? MODE_ONCE : MODE_CONTINUOUS)
    setCmd('')
    setIncludeSource(false)
    setSelected(
      candidates
        .filter(t => t.production !== true)
        .map(t => t.id)
    )
    // 只在打开瞬间或候选集合变化时重置，用户勾选过程不被打断
  }, [open, signature, store.broadcastPickerMode])

  if (!open) {
    return null
  }

  const once = mode === MODE_ONCE
  const selectedTabs = candidates.filter(t => selected.includes(t.id))
  const prodTabs = selectedTabs.filter(t => t.production === true)

  function toggle (id) {
    setSelected(ids => (
      ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
    ))
  }

  function run () {
    if (once) {
      return store.sendBroadcastOnce(cmd, selected, includeSource)
    }
    return store.startBroadcast(selected)
  }

  function submit () {
    if (once) {
      if (!cmd.trim()) {
        return message.warning(e('broadcastOnceEmpty'))
      }
      if (!selected.length && !includeSource) {
        return message.warning(e('broadcastNoTarget'))
      }
    } else if (!selected.length) {
      return message.warning(e('broadcastNoTarget'))
    }
    if (prodTabs.length) {
      setStep('confirm')
      return
    }
    return run()
  }

  function handleCmdKeyDown (ev) {
    // Enter 提交，Shift+Enter 换行（多行脚本靠粘贴或 Shift+Enter）
    // 输入法组字期间的 Enter 只用于选字，不能触发发送
    if (ev.nativeEvent && ev.nativeEvent.isComposing) {
      return
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      submit()
    }
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

  function renderOnce () {
    if (!once) {
      return null
    }
    return (
      <div className='broadcast-once'>
        <Input.TextArea
          value={cmd}
          onChange={ev => setCmd(ev.target.value)}
          onKeyDown={handleCmdKeyDown}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder={e('broadcastOnceCmd')}
        />
        <Checkbox
          checked={includeSource}
          onChange={ev => setIncludeSource(ev.target.checked)}
        >
          {e('broadcastIncludeSource')}
        </Checkbox>
      </div>
    )
  }

  function renderPick () {
    return (
      <div className='broadcast-pick'>
        <Segmented
          block
          value={mode}
          onChange={setMode}
          options={[
            { label: e('broadcastModeContinuous'), value: MODE_CONTINUOUS },
            { label: e('broadcastModeOnce'), value: MODE_ONCE }
          ]}
        />
        <p className='broadcast-desc'>
          {once ? e('broadcastOnceDesc') : e('broadcastDesc')}
        </p>
        {sourceTab
          ? (
            <p className='broadcast-desc'>
              {e('broadcastSourceLine').replace('{title}', titleOf(sourceTab))}
            </p>
            )
          : null}
        {renderOnce()}
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
          <ExclamationCircleOutlined /> {
            once ? e('broadcastOnceProductionWarn') : e('broadcastProductionWarn')
          }
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
          onClick={run}
        >
          {once ? e('broadcastSendAnyway') : e('broadcastStartAnyway')}
        </Button>
      ]
    }
    const disabled = once
      ? (!cmd.trim() || (!selected.length && !includeSource))
      : !selected.length
    return [
      <Button key='cancel' onClick={() => store.closeBroadcastPicker()}>
        {e('cancel')}
      </Button>,
      <Button
        key='ok'
        type='primary'
        disabled={disabled}
        onClick={submit}
      >
        {once ? e('broadcastSendOnce') : e('broadcastStart')}
      </Button>
    ]
  }

  return (
    <Modal
      className='broadcast-modal'
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
