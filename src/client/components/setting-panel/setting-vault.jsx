/**
 * G6-3 主密码 Vault 设置页（阶段4 §14.7 阶段①）
 *
 * 页面只做"报动作"：口令与恢复码从这里进 IPC，回来的一律是状态与原因。
 * 强度、时长范围这些口径全部由主进程判（见 src/app/lib/vault.js），本页只把
 * reason 翻成人话——同一规则写两遍，将来只会有一遍是对的。
 *
 * 两处刻意的不顺手的做法：
 * - 恢复码只在建库成功那一屏出现，离开本页就再也拿不到原文（主进程不留它）；
 *   所以勾选"我已抄好"之前不给确认按钮，别让人以为还能再显示一次。
 * - 每次成功动作后清空口令输入框：React state 里多留一秒明文就多一秒风险。
 */
import React, { Component } from 'react'
import {
  CopyOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UnlockOutlined
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Space,
  Tag
} from 'antd'
import message from '../common/message'
import { copy as copyToClipboard } from '../../common/clipboard'
import {
  autoLockPresets,
  fieldValue,
  groupRecoveryCode,
  hasCredential,
  passwordsAgree,
  vaultErrorText,
  vaultState,
  vaultStateKey
} from '../../common/vault-ui'
import './setting-vault.styl'

const e = window.translate

const vaultOp = (action, arg) => window.pre.runGlobalAsync('vaultOp', action, arg)

const emptyForm = {
  enable: { masterPassword: '', confirm: '', autoLockMin: 15, saved: false },
  unlock: { masterPassword: '', recoveryCode: '', byRecovery: false },
  change: { masterPassword: '', newMasterPassword: '', confirm: '' },
  disable: { masterPassword: '', recoveryCode: '' }
}

export default class SettingVault extends Component {
  state = {
    ...emptyForm,
    status: null,
    loading: true,
    busy: '',
    // 恢复码原文只活在这里：主进程只在 enable 成功那一次返回它
    recoveryCode: '',
    error: ''
  }

  seq = 0

  componentDidMount () {
    this.handleLoadStatus()
  }

  componentWillUnmount () {
    // 设置页关掉后落回来的响应不能再 setState
    this.seq++
  }

  /**
   * 状态上屏，同时把"闲置自动锁定"编辑框对齐到库里真正记着的值。
   * 不这么做的话：库设的是 30 分钟，页面上摆着默认 15，用户点"应用"就把 30 改成了 15。
   */
  applyStatus (status) {
    const patch = { status }
    if (status && status.ok !== false && status.enabled) {
      patch.enable = { ...this.state.enable, autoLockMin: status.autoLockMin }
    }
    this.setState(patch)
  }

  handleLoadStatus = async () => {
    const seq = ++this.seq
    this.setState({ loading: true })
    const status = await vaultOp('status')
    if (seq !== this.seq) {
      return
    }
    this.setState({ loading: false })
    this.applyStatus(status)
  }

  setField = (section, key) => (value) => {
    const v = fieldValue(value)
    this.setState({ [section]: { ...this.state[section], [key]: v } })
  }

  /** 成功动作后把该段的明文抹掉 */
  clearSection = (section) => {
    this.setState({ [section]: { ...emptyForm[section] } })
  }

  run = async (action, arg, section, okText) => {
    const seq = ++this.seq
    this.setState({ busy: action, error: '' })
    const result = await vaultOp(action, arg)
    if (seq !== this.seq) {
      return null
    }
    this.setState({ busy: '' })
    if (!result || result.ok !== true) {
      this.setState({ error: vaultErrorText(result, e) })
      return null
    }
    if (section) {
      this.clearSection(section)
    }
    if (okText) {
      message.success(okText)
    }
    const status = await vaultOp('status')
    if (seq !== this.seq) {
      return result
    }
    this.applyStatus(status)
    return result
  }

  handleEnable = async () => {
    const { masterPassword, confirm, autoLockMin } = this.state.enable
    if (!passwordsAgree(masterPassword, confirm)) {
      this.setState({ error: e('vaultPassMismatch') })
      return
    }
    const result = await this.run(
      'enable',
      { masterPassword, autoLockMin },
      'enable',
      e('vaultEnabled')
    )
    if (result) {
      this.setState({ recoveryCode: result.recoveryCode || '' })
    }
  }

  handleUnlock = async () => {
    const { masterPassword, recoveryCode, byRecovery } = this.state.unlock
    const arg = byRecovery ? { recoveryCode } : { masterPassword }
    const result = await this.run(
      byRecovery ? 'unlockWithRecovery' : 'unlock',
      arg,
      'unlock',
      e('vaultUnlocked')
    )
    // 恢复码解出来是临时可用：主密码还是没设过，这句提示不能省
    if (result && result.needsNewPassword) {
      message.warning(e('vaultNeedsNewPassword'))
    }
  }

  handleLock = async () => {
    await this.run('lock', null, null, e('vaultLockedToast'))
  }

  handleChangePassword = async () => {
    const { masterPassword, newMasterPassword, confirm } = this.state.change
    if (!passwordsAgree(newMasterPassword, confirm)) {
      this.setState({ error: e('vaultPassMismatch') })
      return
    }
    await this.run(
      'changePassword',
      { masterPassword, newMasterPassword },
      'change',
      e('vaultPasswordChanged')
    )
  }

  handleSetAutoLock = async () => {
    const { autoLockMin } = this.state.enable
    await this.run('setAutoLock', { autoLockMin }, null, e('vaultAutoLockSaved'))
  }

  handleDisable = async () => {
    const { masterPassword, recoveryCode } = this.state.disable
    await this.run(
      'disable',
      hasCredential({ masterPassword, recoveryCode })
        ? { masterPassword, recoveryCode }
        : {},
      'disable',
      e('vaultDisabled')
    )
    if (this.state.recoveryCode) {
      this.setState({ recoveryCode: '' })
    }
  }

  handleCopyRecovery = () => {
    const { recoveryCode } = this.state
    if (!recoveryCode) {
      return
    }
    copyToClipboard(recoveryCode)
    message.success(e('vaultRecoveryCopied'))
  }

  renderHead () {
    const { status, loading } = this.state
    const state = vaultState(status)
    const color = state === 'unlocked' ? 'green' : (state === 'locked' ? 'orange' : 'default')
    return (
      <div className='vault-head pd1y'>
        <span className='vault-state'>
          <Tag className='vault-state-tag' color={color}>
            {loading ? e('loading') : e(vaultStateKey(status))}
          </Tag>
        </span>
        {
          status && status.ok !== false && status.enabled
            ? (
              <span className='vault-meta'>
                {e('vaultAutoLock')}: {status.autoLockMin} {e('vaultMinutes')}
                {' · '}
                {status.hasRecovery ? e('vaultHasRecovery') : e('vaultNoRecovery')}
              </span>
              )
            : null
        }
        <Button
          className='vault-refresh'
          size='small'
          type='text'
          icon={<ReloadOutlined />}
          onClick={this.handleLoadStatus}
        >
          {e('refresh')}
        </Button>
      </div>
    )
  }

  renderError () {
    const { error } = this.state
    if (!error) {
      return null
    }
    return (
      <Alert
        className='vault-error'
        type='error'
        showIcon
        message={error}
        onClose={() => this.setState({ error: '' })}
        closable
      />
    )
  }

  renderAutoLockInput (value, disabled) {
    return (
      <Space size={4} wrap className='vault-autolock'>
        <InputNumber
          className='vault-autolock-num'
          min={1}
          max={24 * 60}
          value={value}
          disabled={disabled}
          onChange={this.setField('enable', 'autoLockMin')}
        />
        {
          autoLockPresets.map(m => (
            <Button
              key={m}
              size='small'
              type={value === m ? 'primary' : 'text'}
              disabled={disabled}
              onClick={() => this.setField('enable', 'autoLockMin')(m)}
            >
              {m}
              {e('vaultMinutesShort')}
            </Button>
          ))
        }
      </Space>
    )
  }

  renderEnable () {
    const { enable, busy } = this.state
    const passProps = {
      className: 'vault-pass',
      value: enable.masterPassword,
      onChange: this.setField('enable', 'masterPassword'),
      disabled: busy === 'enable'
    }
    const confirmProps = {
      className: 'vault-pass2',
      value: enable.confirm,
      onChange: this.setField('enable', 'confirm'),
      disabled: busy === 'enable'
    }
    return (
      <div className='vault-block'>
        <div className='vault-block-title font16 bold pd1y'>{e('vaultEnableTitle')}</div>
        <div className='vault-intro pd1b'>{e('vaultEnableIntro')}</div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultMasterPassword')}</div>
          <Input.Password {...passProps} />
        </div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultMasterPasswordConfirm')}</div>
          <Input.Password {...confirmProps} />
        </div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultAutoLock')}</div>
          {this.renderAutoLockInput(enable.autoLockMin, busy === 'enable')}
          <div className='vault-intro'>{e('vaultAutoLockTip')}</div>
        </div>
        <div className='vault-intro pd1b'>{e('vaultRecoveryComing')}</div>
        <div className='pd1b'>
          <Button
            className='vault-enable'
            type='primary'
            loading={busy === 'enable'}
            disabled={busy === 'enable' || !passwordsAgree(enable.masterPassword, enable.confirm)}
            onClick={this.handleEnable}
          >
            {e('vaultEnable')}
          </Button>
        </div>
      </div>
    )
  }

  /** 勾了"已抄下"才允许收起；收起即把原文从渲染层丢掉——主进程本来就没留第二份 */
  handleAckRecovery = () => {
    if (!this.state.enable.saved) {
      this.setState({ error: e('vaultRecoveryNotSaved') })
      return
    }
    this.setState({ recoveryCode: '' })
    this.setField('enable', 'saved')(false)
  }

  renderRecovery (recoveryCode) {
    const { enable } = this.state
    const savedProps = {
      className: 'vault-recovery-saved',
      checked: enable.saved,
      onChange: evt => this.setField('enable', 'saved')(evt.target.checked)
    }
    return (
      <div className='vault-recovery pd1b'>
        <div className='vault-block-title font16 bold'>{e('vaultRecoveryTitle')}</div>
        <Alert
          className='vault-recovery-warn'
          type='warning'
          showIcon
          message={e('vaultRecoveryWarn')}
        />
        <div className='vault-recovery-code'>
          {groupRecoveryCode(recoveryCode)}
        </div>
        <Space size={6} wrap>
          <Button
            className='vault-recovery-copy'
            size='small'
            icon={<CopyOutlined />}
            onClick={this.handleCopyRecovery}
          >
            {e('copy')}
          </Button>
          <Checkbox {...savedProps}>{e('vaultRecoverySavedConfirm')}</Checkbox>
          <Button
            className='vault-recovery-ack'
            size='small'
            disabled={!enable.saved}
            onClick={this.handleAckRecovery}
          >
            {e('vaultRecoveryAck')}
          </Button>
        </Space>
        <div className='vault-intro'>{e('vaultRecoveryOnce')}</div>
      </div>
    )
  }

  renderUnlock () {
    const { unlock, busy } = this.state
    const value = unlock.byRecovery ? unlock.recoveryCode : unlock.masterPassword
    const inputProps = {
      className: 'vault-unlock-input',
      value,
      onChange: this.setField('unlock', unlock.byRecovery ? 'recoveryCode' : 'masterPassword'),
      disabled: busy === 'unlock' || busy === 'unlockWithRecovery',
      placeholder: unlock.byRecovery ? e('vaultRecoveryPlaceholder') : e('vaultMasterPassword'),
      onPressEnter: this.handleUnlock
    }
    return (
      <div className='vault-block'>
        <div className='vault-block-title font16 bold pd1y'>{e('vaultUnlockTitle')}</div>
        <div className='pd1b'>
          <Radio.Group
            className='vault-unlock-mode'
            value={unlock.byRecovery}
            onChange={evt => this.setField('unlock', 'byRecovery')(evt.target.value)}
            disabled={busy === 'unlock' || busy === 'unlockWithRecovery'}
            options={[
              { value: false, label: e('vaultUnlockByPassword') },
              { value: true, label: e('vaultUnlockByRecovery') }
            ]}
            optionType='button'
            size='small'
          />
        </div>
        <div className='pd1b'>
          {
            unlock.byRecovery
              ? <Input.TextArea {...inputProps} autoSize={{ minRows: 2, maxRows: 3 }} />
              : <Input.Password {...inputProps} />
          }
        </div>
        <div className='pd1b'>
          <Button
            className='vault-unlock'
            type='primary'
            icon={<UnlockOutlined />}
            loading={busy === 'unlock' || busy === 'unlockWithRecovery'}
            disabled={!value}
            onClick={this.handleUnlock}
          >
            {e('vaultUnlock')}
          </Button>
        </div>
        <div className='vault-intro'>{e('vaultUnlockIntro')}</div>
      </div>
    )
  }

  renderChange () {
    const { change, busy, enable } = this.state
    const currentProps = {
      className: 'vault-current',
      value: change.masterPassword,
      onChange: this.setField('change', 'masterPassword')
    }
    const nextProps = {
      className: 'vault-new',
      value: change.newMasterPassword,
      onChange: this.setField('change', 'newMasterPassword')
    }
    const confirmProps = {
      className: 'vault-new2',
      value: change.confirm,
      onChange: this.setField('change', 'confirm')
    }
    const canChange = passwordsAgree(change.newMasterPassword, change.confirm) && !!change.masterPassword
    return (
      <div className='vault-block'>
        <div className='vault-block-title font16 bold pd1y'>{e('vaultChangeTitle')}</div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultCurrentPassword')}</div>
          <Input.Password {...currentProps} />
        </div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultNewPassword')}</div>
          <Input.Password {...nextProps} />
        </div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultNewPasswordConfirm')}</div>
          <Input.Password {...confirmProps} />
        </div>
        <div className='pd1b'>
          <Button
            className='vault-change'
            loading={busy === 'changePassword'}
            disabled={!canChange || busy === 'changePassword'}
            onClick={this.handleChangePassword}
          >
            {e('vaultChange')}
          </Button>
        </div>
        <div className='vault-block-title font16 bold pd1y'>{e('vaultAutoLockUpdate')}</div>
        <div className='pd1b'>
          {this.renderAutoLockInput(enable.autoLockMin, busy === 'setAutoLock')}
        </div>
        <div className='pd1b'>
          <Button
            className='vault-save-autolock'
            loading={busy === 'setAutoLock'}
            disabled={busy === 'setAutoLock'}
            onClick={this.handleSetAutoLock}
          >
            {e('vaultSaveAutoLock')}
          </Button>
        </div>
      </div>
    )
  }

  renderDisable () {
    const { disable, busy } = this.state
    const can = hasCredential(disable)
    return (
      <div className='vault-block'>
        <div className='vault-block-title font16 bold pd1y'>{e('vaultDisableTitle')}</div>
        <div className='vault-intro pd1b'>{e('vaultDisableIntro')}</div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultCurrentPassword')}</div>
          <Input.Password
            className='vault-disable-pass'
            value={disable.masterPassword}
            onChange={this.setField('disable', 'masterPassword')}
          />
        </div>
        <div className='pd1b'>
          <div className='inline-title mg1r'>{e('vaultRecoveryCode')}</div>
          <Input
            className='vault-disable-recovery'
            value={disable.recoveryCode}
            onChange={this.setField('disable', 'recoveryCode')}
            placeholder={e('vaultRecoveryOptional')}
          />
        </div>
        <Popconfirm
          title={e('vaultDisableConfirm')}
          okText={e('del')}
          cancelText={e('cancel')}
          disabled={!can}
          onConfirm={this.handleDisable}
        >
          <Button
            className='vault-disable'
            danger
            loading={busy === 'disable'}
            disabled={!can || busy === 'disable'}
          >
            {e('vaultDisable')}
          </Button>
        </Popconfirm>
      </div>
    )
  }

  renderUnlockedTools () {
    const { busy } = this.state
    return (
      <div className='vault-block'>
        <div className='pd1b'>
          <Button
            className='vault-lock'
            icon={<LockOutlined />}
            loading={busy === 'lock'}
            disabled={busy === 'lock'}
            onClick={this.handleLock}
          >
            {e('vaultLockNow')}
          </Button>
          <span className='vault-intro mg1l'>{e('vaultLockTip')}</span>
        </div>
      </div>
    )
  }

  renderStoreError () {
    const { status } = this.state
    return (
      <Alert
        className='vault-store-error'
        type='error'
        showIcon
        message={vaultErrorText(status, e)}
        description={e('vaultStoreErrorHint')}
        action={
          <Button size='small' icon={<ReloadOutlined />} onClick={this.handleLoadStatus}>
            {e('refresh')}
          </Button>
        }
      />
    )
  }

  renderBody () {
    const { status } = this.state
    const state = vaultState(status)
    if (state === 'error') {
      return this.renderStoreError()
    }
    if (state === 'off') {
      return this.renderEnable()
    }
    // 停用永远给：忘了主密码的人还有恢复码这条路，"先解锁才能关掉"是把他堵在门外
    return (
      <div className='vault-managed'>
        {
          state === 'locked'
            ? (
              <div className='vault-block'>
                <Alert
                  className='vault-locked-hint'
                  type='info'
                  showIcon
                  message={e('vaultLockedHint')}
                />
              </div>
              )
            : this.renderUnlockedTools()
        }
        {
          state === 'locked' ? this.renderUnlock() : null
        }
        {
          state === 'unlocked' ? this.renderChange() : null
        }
        {this.renderDisable()}
      </div>
    )
  }

  render () {
    const { loading, recoveryCode } = this.state
    return (
      <div className='form-wrap pd1y pd2x setting-vault'>
        <div className='pd1y font16 bold'>
          <SafetyCertificateOutlined className='mg1r' />
          {e('vault')}
        </div>
        <div className='vault-intro pd1b'>{e('vaultIntro')}</div>
        {this.renderHead()}
        {this.renderError()}
        {
          loading
            ? <div className='pd1x aligncenter'>{e('loading')}</div>
            : this.renderBody()
        }
        {
          // 恢复码只在这一次返回，而"建好库"这一刻正好把表单换成管理视图 ——
          // 挂在 renderEnable 里等于永远不给看，所以挂在 render：换什么视图都得看得见。
          recoveryCode ? this.renderRecovery(recoveryCode) : null
        }
      </div>
    )
  }
}
