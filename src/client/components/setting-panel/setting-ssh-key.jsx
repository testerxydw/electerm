/**
 * G7 SSH 密钥与已知主机：
 * ① 生成密钥对（默认写 ~/.ssh，同名拒绝覆盖）+ 公钥与「装到远端」的下一步；
 * ② known_hosts 逐行列出，按指纹删单条。
 *
 * 刻意没有「清空 known_hosts」：一次点击抹掉全部主机信任，下一次连接要么撞
 * 中间人警告要么被用户顺手点掉信任，比逐条删危险得多（设计 §14.8）。
 */
import React, { Component } from 'react'
import {
  CopyOutlined,
  DeleteOutlined,
  KeyOutlined,
  LoadingOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import {
  Button,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip
} from 'antd'
import message from '../common/message'
import ShowItem from '../common/show-item'
import { copy as copyToClipboard } from '../../common/clipboard'
import { connectionMap } from '../../common/constants'
import createTitle from '../../common/create-title'
import './setting-ssh-key.styl'

const e = window.translate

const sshKeyOp = (action, arg) => window.pre.runGlobalAsync('sshKeyOp', action, arg)

// 与 src/app/common/ssh-keygen.js 的 KEY_TYPES 同一组；这里是呈现顺序
const keyTypeList = ['ed25519', 'rsa', 'ecdsa']

/**
 * 主进程把判据写在 Error.message 里（英文），这里翻成词条；认不出的原样抛出，
 * 不编一句「生成失败」把真实原因盖掉。
 */
function errorText (err) {
  const m = (err && err.message) || ''
  if (/already exists/.test(m)) {
    return e('sshKeyNameExists')
  }
  if (/passphrase short/.test(m)) {
    return e('sshKeyPassphraseTooShort')
  }
  if (/passphrase long/.test(m)) {
    return e('sshKeyPassphraseTooLong')
  }
  if (/key name must/.test(m)) {
    return e('sshKeyNameInvalid')
  }
  if (/unsupported key type/.test(m)) {
    return e('sshKeyTypeUnsupported')
  }
  return m
}

export default class SettingSshKey extends Component {
  state = {
    ready: false,
    type: 'ed25519',
    name: '',
    passphrase: '',
    passphrase2: '',
    generating: false,
    result: null,
    bookmarkId: '',
    known: null,
    knownLoading: false,
    deletingLine: 0
  }

  seq = 0

  componentDidMount () {
    this.setState({ ready: true })
    this.loadKnown()
  }

  componentWillUnmount () {
    // 卸载后落回来的响应不能 setState，也不能把 known_hosts 的旧快照写进内存
    this.seq++
  }

  loadKnown = async () => {
    const seq = ++this.seq
    this.setState({ knownLoading: true })
    let known = null
    try {
      known = await sshKeyOp('listKnownHosts')
    } catch (err) {
      message.error(err.message)
    }
    if (seq !== this.seq) {
      return
    }
    this.setState({
      known: known || this.state.known,
      knownLoading: false
    })
  }

  handleChange = (key) => (value) => {
    this.setState({ [key]: value })
  }

  handleRefreshKnown = () => {
    this.loadKnown()
  }

  handleGenerate = async () => {
    const { type, name, passphrase, passphrase2 } = this.state
    if (passphrase !== passphrase2) {
      message.error(e('sshKeyPassphraseMismatch'))
      return
    }
    const seq = ++this.seq
    this.setState({ generating: true })
    try {
      const result = await sshKeyOp('generate', {
        type,
        // 留空让主进程按 electerm_类型_日期 命名，判据不散到渲染层
        name: name || undefined,
        passphrase
      })
      if (seq !== this.seq) {
        return
      }
      this.setState({ result, bookmarkId: '', generating: false })
      message.success(e('sshKeyGenerated'))
    } catch (err) {
      if (seq !== this.seq) {
        return
      }
      this.setState({ generating: false })
      message.error(errorText(err))
    }
  }

  handleApplyBookmark = () => {
    const { bookmarkId, result } = this.state
    if (!bookmarkId || !result) {
      return
    }
    // 私钥内容优先于路径（bookmark-schema 的约定）：回填路径时必须把内容清空，
    // 否则书签仍然按旧的粘贴内容认证，用户以为换了密钥
    this.props.editBookmark(bookmarkId, {
      privateKeyPath: result.privateKeyPath,
      privateKey: '',
      authType: 'privateKey'
    })
    message.success(e('saved'))
  }

  handleDeleteKnown = async (row) => {
    const seq = ++this.seq
    this.setState({ deletingLine: row.lineNo })
    try {
      await sshKeyOp('deleteKnownHost', {
        lineNo: row.lineNo,
        fingerprint: row.fingerprint
      })
      message.success(e('knownHostsDeleted'))
    } catch (err) {
      // 行号是读列表那一刻的：期间被 ssh-keygen -R 之类改过就要重看一遍
      message.error(
        /no longer holds/.test(err.message) ? e('knownHostsStale') : errorText(err)
      )
    }
    if (seq !== this.seq) {
      return
    }
    this.setState({ deletingLine: 0 })
    this.loadKnown()
  }

  renderSshBookmarks = () => {
    const { bookmarks = [] } = this.props
    return bookmarks
      .filter(b => b.type === connectionMap.ssh)
      .map(b => ({ value: b.id, label: createTitle(b) }))
  }

  renderWizard () {
    const {
      type,
      name,
      passphrase,
      passphrase2,
      generating,
      result,
      bookmarkId
    } = this.state
    const nameInputProps = {
      className: 'ssh-key-name',
      value: name,
      onChange: evt => this.setState({ name: evt.target.value })
    }
    const passProps = {
      className: 'ssh-key-pass',
      value: passphrase,
      onChange: evt => this.setState({ passphrase: evt.target.value })
    }
    const pass2Props = {
      className: 'ssh-key-pass2',
      value: passphrase2,
      onChange: evt => this.setState({ passphrase2: evt.target.value })
    }
    return (
      <div className='ssh-key-wizard'>
        <div className='pd1b'>
          <span className='inline-title mg1r'>{e('sshKeyType')}</span>
          <Select
            className='ssh-key-type'
            value={type}
            onChange={this.handleChange('type')}
            popupMatchSelectWidth={false}
            options={keyTypeList.map(id => ({ value: id, label: id }))}
          />
        </div>
        <div className='pd1b'>
          <span className='inline-title mg1r'>{e('sshKeyName')}</span>
          <Input {...nameInputProps} />
          <div className='ssh-key-name-tip'>{e('sshKeyNameTip')}</div>
        </div>
        <div className='pd1b'>
          <span className='inline-title mg1r'>{e('sshKeyPassphrase')}</span>
          <Input.Password {...passProps} />
        </div>
        <div className='pd1b'>
          <span className='inline-title mg1r'>{e('sshKeyPassphraseConfirm')}</span>
          <Input.Password {...pass2Props} />
        </div>
        <div className='pd1b'>
          <Button
            className='ssh-key-generate'
            type='primary'
            loading={generating}
            disabled={generating}
            onClick={this.handleGenerate}
          >
            {generating ? e('sshKeyGenerating') : e('sshKeyGenerate')}
          </Button>
        </div>
        {
          result
            ? this.renderResult(result, bookmarkId)
            : null
        }
      </div>
    )
  }

  renderResult (result, bookmarkId) {
    const copyProps = {
      type: 'text',
      size: 'small',
      icon: <CopyOutlined />
    }
    const install = `ssh-copy-id -i ${result.publicKeyPath} user@host`
    const pubOptions = {
      className: 'ssh-key-pub',
      value: result.publicLine,
      readOnly: true,
      autoSize: { minRows: 2, maxRows: 4 }
    }
    return (
      <div className='ssh-key-result'>
        <div className='ssh-key-result-line'>
          <span className='ssh-key-result-label'>{e('sshKeyPrivatePath')}</span>
          <span className='ssh-key-result-path'>{result.privateKeyPath}</span>
          <ShowItem to={result.privateKeyPath} />
          {
            result.encrypted
              ? <Tag className='ssh-key-result-tag'>{e('sshKeyEncrypted')}</Tag>
              : null
          }
        </div>
        <div className='ssh-key-result-line'>
          <span className='ssh-key-result-label'>{e('sshKeyPublicLine')}</span>
          <Tooltip title={e('copy')}>
            <Button
              {...copyProps}
              className='ssh-key-copy-pub'
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(result.publicLine)}
            />
          </Tooltip>
        </div>
        <Input.TextArea {...pubOptions} />
        <div className='ssh-key-result-line'>
          <span className='ssh-key-result-label'>{e('sshKeyInstall')}</span>
          <span className='ssh-key-result-cmd'>{install}</span>
          <Tooltip title={e('copy')}>
            <Button
              {...copyProps}
              className='ssh-key-copy-install'
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(install)}
            />
          </Tooltip>
        </div>
        <div className='ssh-key-result-manual'>{e('sshKeyInstallManual')}</div>
        <div className='ssh-key-result-line'>
          <span className='ssh-key-result-label'>{e('sshKeyApplyBookmark')}</span>
          <Select
            className='ssh-key-bookmark'
            value={bookmarkId || undefined}
            placeholder={e('sshKeyBookmarkPlaceholder')}
            onChange={this.handleChange('bookmarkId')}
            options={this.renderSshBookmarks()}
            popupMatchSelectWidth={false}
            showSearch
          />
          <Tooltip title={e('sshKeyApplyTip')}>
            <Button
              className='ssh-key-apply'
              disabled={!bookmarkId}
              onClick={this.handleApplyBookmark}
            >
              {e('sshKeyApplyBookmarkBtn')}
            </Button>
          </Tooltip>
        </div>
        <div className='ssh-key-result-manual'>{e('sshKeyPassphraseNotSaved')}</div>
      </div>
    )
  }

  renderKnownHead () {
    const { known, knownLoading } = this.state
    const path = known && known.knownHostsPath
    const mtime = known && known.mtimeMs
    return (
      <div className='ssh-key-known-head'>
        <span className='ssh-key-result-label'>{e('knownHostsFile')}</span>
        {
          path
            ? (
              <Space size={4}>
                <span className='ssh-key-result-path'>{path}</span>
                <ShowItem to={path} />
              </Space>
              )
            : null
        }
        {
          mtime
            ? (
              <span className='ssh-key-known-mtime'>
                {new Date(mtime).toLocaleString()}
              </span>
              )
            : null
        }
        <Button
          className='ssh-key-known-refresh'
          size='small'
          type='text'
          icon={<ReloadOutlined />}
          loading={knownLoading}
          onClick={this.handleRefreshKnown}
        >
          {e('refresh')}
        </Button>
      </div>
    )
  }

  renderKnownRow = (row) => {
    const { deletingLine } = this.state
    // 哈希条目不暴露主机名，只能按行号 + 指纹删；畸形条目算不出指纹，删不了也判不了
    const host = row.hashed
      ? e('knownHostsHashed')
      : row.hostField
    const fp = row.malformed ? e('knownHostsMalformed') : row.fingerprint
    const canDelete = !row.malformed && !!row.fingerprint
    const delBtn = (
      <Button
        className='ssh-key-known-del'
        type='text'
        size='small'
        danger
        disabled={!canDelete}
        icon={<DeleteOutlined />}
        loading={deletingLine === row.lineNo}
      />
    )
    return (
      <div className='ssh-key-known-row' key={row.lineNo}>
        <div className='ssh-key-known-host elli' title={row.hostField}>
          {host}
        </div>
        <div className='ssh-key-known-alg elli' title={row.keyType}>
          {row.keyType}
        </div>
        <div className='ssh-key-known-fp elli' title={fp}>
          {fp}
        </div>
        <div className='ssh-key-known-marker'>
          {
            row.marker
              ? <Tag color={row.marker === '@revoked' ? 'red' : 'blue'}>{row.marker}</Tag>
              : null
          }
        </div>
        <div className='ssh-key-known-actions'>
          <Tooltip title={e('copy')}>
            <Button
              className='ssh-key-known-copy'
              type='text'
              size='small'
              disabled={!canDelete}
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(row.fingerprint)}
            />
          </Tooltip>
          {
            canDelete
              ? (
                <Popconfirm
                  title={e('knownHostsDeleteConfirm')}
                  okText={e('del')}
                  cancelText={e('cancel')}
                  placement='left'
                  onConfirm={() => this.handleDeleteKnown(row)}
                >
                  {delBtn}
                </Popconfirm>
                )
              : (
                <Tooltip title={e('knownHostsMalformed')}>
                  {delBtn}
                </Tooltip>
                )
          }
        </div>
      </div>
    )
  }

  renderKnownList () {
    const { known, knownLoading } = this.state
    const rows = (known && known.rows) || []
    if (!rows.length) {
      return (
        <div className='ssh-key-known-empty'>
          {knownLoading ? e('loading') : e('knownHostsEmpty')}
        </div>
      )
    }
    return (
      <div className='ssh-key-known-list'>
        {rows.map(this.renderKnownRow)}
      </div>
    )
  }

  render () {
    const { ready } = this.state
    if (!ready) {
      return (
        <div className='pd3 aligncenter'>
          <LoadingOutlined />
        </div>
      )
    }
    return (
      <div className='form-wrap pd1y pd2x setting-ssh-key'>
        <div className='pd1y font16 bold'>
          <KeyOutlined className='mg1r' />
          {e('sshKeys')}
        </div>
        {this.renderWizard()}
        <div className='ssh-key-known-title pd1y font16 bold'>
          {e('knownHosts')}
        </div>
        {this.renderKnownHead()}
        {this.renderKnownList()}
      </div>
    )
  }
}
