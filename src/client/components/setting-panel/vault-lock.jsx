/**
 * G6-3 底栏锁头 + 解锁弹窗（阶段4 §14.7 阶段①）
 *
 * 三件事：
 * - 状态：只在"建了库"时出现。没建库摆一个点开只有说明的图标是噪音。
 * - 续期：用户还在动（敲键、点鼠标）就把自动锁到期往后推；锁着不发，
 *   发过去只是让主进程回一句 unlocked:false。
 * - 解锁：启动时若建了库且锁着就弹一次（设计口径）。阶段① 允许取消——
 *   此刻还没有凭据走 vault，把整个应用拦在门外只是讨打；阶段② 再收紧。
 *
 * 口令只进输入框和 IPC：不进 store、不进日志、成功后立刻清空。
 */
import React, { useEffect, useRef, useState } from 'react'
import { LockOutlined, QuestionCircleOutlined, UnlockOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Popconfirm, Tooltip } from 'antd'
import message from '../common/message'
import {
  shouldPoll,
  shouldPromptAtStart,
  shouldTouch,
  statusPollMs,
  vaultErrorText,
  vaultState
} from '../../common/vault-ui'
import './setting-vault.styl'

const e = window.translate

const vaultOp = (action, arg) => window.pre.runGlobalAsync('vaultOp', action, arg)

export default function VaultLock () {
  const [status, setStatus] = useState(null)
  const [open, setOpen] = useState(false)
  const [byRecovery, setByRecovery] = useState(false)
  const [password, setPassword] = useState('')
  const [recovery, setRecovery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 卸载后落回来的响应不能再 setState，也不能把明文留在已经死掉的组件里
  const alive = useRef(true)
  const lastTouch = useRef(null)
  const stateRef = useRef(null)

  const refresh = async () => {
    const next = await vaultOp('status')
    if (!alive.current) {
      return null
    }
    // 读库失败也上屏：状态机里它是第四态，不能当"没启用"
    stateRef.current = next
    setStatus(next)
    return next
  }

  const touch = async () => {
    const s = stateRef.current
    if (!shouldTouch({
      unlocked: !!(s && s.ok !== false && s.unlocked),
      now: Date.now(),
      last: lastTouch.current
    })) {
      return
    }
    lastTouch.current = Date.now()
    const r = await vaultOp('touch')
    if (!alive.current || !r || r.unlocked) {
      return
    }
    // 主进程说已经过期了：界面别再摆着一把"已解锁"的锁
    refresh()
  }

  useEffect(() => {
    alive.current = true
    const onStartup = async () => {
      const s = await refresh()
      if (alive.current && shouldPromptAtStart(s)) {
        setOpen(true)
      }
    }
    onStartup()
    const activity = () => { touch() }
    document.addEventListener('pointerdown', activity)
    document.addEventListener('keydown', activity)
    const poll = setInterval(() => {
      if (shouldPoll(stateRef.current)) {
        refresh()
      }
    }, statusPollMs)
    return () => {
      alive.current = false
      document.removeEventListener('pointerdown', activity)
      document.removeEventListener('keydown', activity)
      clearInterval(poll)
    }
  }, [])

  const handleUnlock = async () => {
    const arg = byRecovery ? { recoveryCode: recovery } : { masterPassword: password }
    if (!arg.recoveryCode && !arg.masterPassword) {
      return
    }
    setBusy(true)
    setError('')
    const r = await vaultOp(byRecovery ? 'unlockWithRecovery' : 'unlock', arg)
    if (!alive.current) {
      return
    }
    setBusy(false)
    setPassword('')
    setRecovery('')
    if (!r || !r.ok) {
      setError(vaultErrorText(r, e))
      return
    }
    setOpen(false)
    message.success(e('vaultUnlocked'))
    if (r.needsNewPassword) {
      message.warning(e('vaultNeedsNewPassword'))
    }
    refresh()
  }

  const handleLock = async () => {
    const r = await vaultOp('lock')
    if (!alive.current) {
      return
    }
    // 用户是主动锁的，别转过头就弹一个"请输入密码"——那等于把他的动作撤销了
    if (r && r.ok) {
      message.success(e('vaultLockedToast'))
    }
    refresh()
  }

  const handleRecoveryUnlock = () => {
    setByRecovery(true)
    setError('')
    setOpen(true)
  }

  const state = vaultState(status)
  if (state !== 'locked' && state !== 'unlocked') {
    return null
  }
  const locked = state === 'locked'
  const autoLockMin = status.autoLockMin
  const tip = locked
    ? e('vaultLockedHint')
    : e('vaultAutoLockTip') + '（' + autoLockMin + ' ' + e('vaultMinutes') + '）'
  return (
    <div className={'terminal-footer-unit vault-lock-chip ' + (locked ? 'locked' : 'unlocked')}>
      <Tooltip title={tip}>
        {
          locked
            ? (
              <LockOutlined
                className='pointer font14 vault-lock-chip-icon'
                onClick={() => setOpen(true)}
              />
              )
            : (
              <Popconfirm
                title={e('vaultLockConfirm')}
                okText={e('vaultLockNow')}
                cancelText={e('cancel')}
                placement='top'
                onConfirm={handleLock}
              >
                <UnlockOutlined className='pointer font14 vault-lock-chip-icon' />
              </Popconfirm>
              )
        }
      </Tooltip>
      {
        locked
          ? (
            <Button
              className='vault-chip-unlock'
              type='link'
              size='small'
              onClick={() => setOpen(true)}
            >
              {e('vaultUnlock')}
            </Button>
            )
          : null
      }
      <Modal
        open={open}
        title={e('vaultUnlockTitle')}
        onCancel={() => setOpen(false)}
        footer={null}
        width={420}
        className='vault-unlock-modal'
      >
        <div className='vault-unlock-modal-intro'>{e('vaultUnlockIntro')}</div>
        {
          error
            ? (
              <Alert
                className='mg1b'
                type='error'
                showIcon
                message={error}
                onClose={() => setError('')}
                closable
              />
              )
            : null
        }
        {
          byRecovery
            ? (
              <Input.TextArea
                className='vault-unlock-modal-input'
                value={recovery}
                autoSize={{ minRows: 2, maxRows: 3 }}
                placeholder={e('vaultRecoveryPlaceholder')}
                onChange={evt => setRecovery(evt.target.value)}
              />
              )
            : (
              <Input.Password
                className='vault-unlock-modal-input'
                autoFocus
                value={password}
                placeholder={e('vaultMasterPassword')}
                onChange={evt => setPassword(evt.target.value)}
                onPressEnter={handleUnlock}
              />
              )
        }
        <div className='vault-unlock-modal-foot mg1t'>
          {
            byRecovery
              ? (
                <Button type='text' onClick={() => { setByRecovery(false); setError('') }}>
                  {e('vaultUnlockByPassword')}
                </Button>
                )
              : (
                  status.hasRecovery
                    ? (
                      <Button
                        type='text'
                        icon={<QuestionCircleOutlined />}
                        onClick={handleRecoveryUnlock}
                      >
                        {e('vaultUnlockByRecovery')}
                      </Button>
                      )
                    : null
                )
          }
          <Button onClick={() => setOpen(false)} disabled={busy}>
            {e('cancel')}
          </Button>
          <Button
            type='primary'
            loading={busy}
            disabled={busy || !(byRecovery ? recovery : password)}
            onClick={handleUnlock}
          >
            {e('vaultUnlock')}
          </Button>
        </div>
        <div className='vault-unlock-modal-intro mg1t'>
          {e('vaultPhaseCancelTip')}
        </div>
      </Modal>
    </div>
  )
}
