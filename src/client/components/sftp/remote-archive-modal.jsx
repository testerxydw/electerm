/**
 * SFTP/FTP 远程归档（G4）：打包选中项 / 解压远端归档。
 *
 * 命令全在主进程拼（src/app/common/remote-archive.js），这里只负责三件事：
 * 给一个能直接点确定的默认名、解压前把清单摊开给用户看、把远端的降级
 * （没装 zip → 产出换成 .tar.gz）与 stderr 尾巴如实转达。
 *
 * 不提供取消：命令已经发进远端的 shell，客户端拦不住，挂个假的取消按钮
 * 只会让人以为远端停下来了。执行期间只有 loading 和那句说明。
 *
 * 解压只往当前目录解，不给「解到任意路径」的输入框：destDir 由文件管理器
 * 的当前目录给出，少一个能被文件名影响的落点。
 */

import React from 'react'
import { Input, Select, Spin, Button } from 'antd'
import Modal from '../common/modal'
import { refsStatic } from '../common/ref'
import resolve from '../../common/resolve'
import {
  alignArchiveName,
  archiveNameProblem,
  defaultArchiveName,
  baseName
} from '../../common/remote-archive'
import './remote-archive-modal.styl'

const e = window.translate

const KINDS = [
  { value: 'tar.gz', label: 'tar.gz' },
  { value: 'zip', label: 'zip' }
]

const EMPTY_STATE = {
  visible: false,
  mode: 'create',
  running: false,
  error: '',
  nameError: '',
  sources: [],
  dir: '',
  kind: 'tar.gz',
  name: '',
  archivePath: '',
  destDir: '',
  detail: '',
  listing: null,
  listingLoading: false,
  result: null
}

const errText = (err) => String((err && err.message) || err || '')

// 主进程失败时把最后几行 stderr 挂在 err.stderrTail 上，那句比 exit code 有用
const detailOf = (err) => String((err && err.stderrTail) || '')

export default class RemoteArchiveModal extends React.PureComponent {
  state = { ...EMPTY_STATE }

  // 连点两个文件时只认最后一次请求的回包（同 file-preview-modal）
  seq = 0

  componentDidMount () {
    refsStatic.add('remote-archive-modal', this)
  }

  showCreate ({ files = [], sftp, onDone } = {}) {
    const list = files.filter(f => f && f.name)
    if (!list.length) {
      return
    }
    const dir = String(list[0].path || '')
    const names = list.map(f => f.name)
    const kind = 'tar.gz'
    this.setState({
      ...EMPTY_STATE,
      visible: true,
      mode: 'create',
      sftp,
      onDone,
      dir,
      sources: list.map(f => resolve(f.path, f.name)),
      kind,
      name: defaultArchiveName({ names, kind, dirName: baseName(dir) })
    })
  }

  showExtract ({ file, sftp, onDone } = {}) {
    if (!file || !file.name) {
      return
    }
    const archivePath = resolve(file.path, file.name)
    const seq = ++this.seq
    this.setState({
      ...EMPTY_STATE,
      visible: true,
      mode: 'extract',
      sftp,
      onDone,
      archivePath,
      destDir: String(file.path || '')
    })
    this.loadListing(seq, archivePath, sftp)
  }

  loadListing (seq, archivePath, sftp) {
    sftp.archiveList({ archivePath }).then(res => {
      if (seq !== this.seq) {
        return
      }
      this.setState({ listingLoading: false, listing: res })
    }).catch(err => {
      if (seq !== this.seq) {
        return
      }
      this.setState({
        listingLoading: false,
        error: errText(err),
        detail: detailOf(err)
      })
    })
  }

  // 执行期间关不掉：命令还在远端跑，这时候关掉等于把结果丢在哪儿都说不清
  handleClose = () => {
    if (this.state.running) {
      return
    }
    this.seq++
    this.setState({ ...EMPTY_STATE })
  }

  // 改格式就改后缀：产出文件的名字始终是输入框里那个后缀
  handleKindChange = (kind) => {
    this.setState({ kind, name: alignArchiveName(this.state.name, kind) })
  }

  handleNameChange = (ev) => {
    this.setState({ name: ev.target.value, nameError: '' })
  }

  validateName (name) {
    const problem = archiveNameProblem(name)
    if (problem === 'empty') {
      return e('remoteArchiveNameEmpty')
    }
    if (problem === 'badChar') {
      return e('remoteArchiveNameBadChar')
    }
    return ''
  }

  handleCreate = async () => {
    const { sftp, sources, dir, kind, name, onDone } = this.state
    const nameError = this.validateName(name)
    if (nameError) {
      this.setState({ nameError })
      return
    }
    // 后缀跟 kind 对齐后才发命令：zip 那一支主进程要求 .zip 结尾
    const dest = resolve(dir, alignArchiveName(name, kind))
    const seq = this.seq
    this.setState({ running: true, error: '', detail: '', result: null, name: baseName(dest) })
    let res
    try {
      res = await sftp.archiveCreate({ sources, dest, kind })
    } catch (err) {
      if (seq !== this.seq) {
        return
      }
      this.setState({ running: false, error: errText(err), detail: detailOf(err) })
      return
    }
    if (seq !== this.seq) {
      return
    }
    this.setState({
      running: false,
      result: {
        text: e('remoteArchiveCreated').replace('{path}', res.producedPath),
        noticeKey: res.noticeKey || '',
        stderrTail: res.stderrTail || ''
      }
    })
    if (typeof onDone === 'function') {
      onDone()
    }
  }

  handleExtract = async () => {
    const { sftp, archivePath, destDir, onDone } = this.state
    const seq = this.seq
    this.setState({ running: true, error: '', detail: '', result: null })
    let res
    try {
      res = await sftp.archiveExtract({ archivePath, destDir })
    } catch (err) {
      if (seq !== this.seq) {
        return
      }
      this.setState({ running: false, error: errText(err), detail: detailOf(err) })
      return
    }
    if (seq !== this.seq) {
      return
    }
    this.setState({
      running: false,
      result: {
        text: e('remoteArchiveExtracted').replace('{path}', res.destDir),
        noticeKey: '',
        stderrTail: res.stderrTail || ''
      }
    })
    if (typeof onDone === 'function') {
      onDone()
    }
  }

  renderSources () {
    const { sources } = this.state
    return (
      <div className='remote-archive-block'>
        <div className='remote-archive-label'>
          {e('remoteArchiveSources').replace('{n}', sources.length)}
        </div>
        <pre className='remote-archive-list remote-archive-list-sources'>
          {sources.map(baseName).join('\n')}
        </pre>
      </div>
    )
  }

  renderCreate () {
    const { kind, name, nameError, dir } = this.state
    return (
      <>
        {this.renderSources()}
        <div className='remote-archive-row'>
          <span className='remote-archive-label'>{e('remoteArchiveKind')}</span>
          <Select
            size='small'
            className='remote-archive-kind'
            value={kind}
            options={KINDS}
            onChange={this.handleKindChange}
          />
        </div>
        <div className='remote-archive-row'>
          <span className='remote-archive-label'>{e('name')}</span>
          <Input
            size='small'
            className='remote-archive-name-input'
            value={name}
            status={nameError ? 'error' : ''}
            onChange={this.handleNameChange}
            onPressEnter={this.handleCreate}
          />
        </div>
        {
          nameError
            ? <div className='remote-archive-name-error'>{nameError}</div>
            : null
        }
        <div className='remote-archive-dest'>
          {e('remoteArchiveDest')}
          <span className='remote-archive-path'>{resolve(dir, alignArchiveName(name, kind))}</span>
        </div>
      </>
    )
  }

  renderListing () {
    const { listing, listingLoading } = this.state
    if (listingLoading) {
      return (
        <div className='aligncenter pd3'>
          <Spin />
        </div>
      )
    }
    if (!listing) {
      return null
    }
    return (
      <div className='remote-archive-block'>
        <div className='remote-archive-label'>
          {e('remoteArchiveListing').replace('{n}', listing.total)}
        </div>
        {
          listing.truncated
            ? (
              <div className='remote-archive-banner'>
                {e('remoteArchiveTruncated').replace('{n}', listing.entries.length)}
              </div>
              )
            : null
        }
        <pre className='remote-archive-list'>{listing.entries.join('\n')}</pre>
      </div>
    )
  }

  renderExtract () {
    const { archivePath, destDir } = this.state
    return (
      <>
        <div className='remote-archive-dest'>
          {e('remoteArchiveFile')}
          <span className='remote-archive-path'>{archivePath}</span>
        </div>
        <div className='remote-archive-dest'>
          {e('remoteArchiveExtractTo')}
          <span className='remote-archive-path'>{destDir}</span>
        </div>
        {this.renderListing()}
      </>
    )
  }

  renderResult () {
    const { result } = this.state
    if (!result) {
      return null
    }
    return (
      <div className='remote-archive-result'>
        <div>{result.text}</div>
        {
          result.noticeKey
            ? (
              <div className='remote-archive-notice'>{e(result.noticeKey)}</div>
              )
            : null
        }
        {
          result.stderrTail
            ? <pre className='remote-archive-detail'>{result.stderrTail}</pre>
            : null
        }
      </div>
    )
  }

  renderError () {
    const { error, detail } = this.state
    if (!error) {
      return null
    }
    return (
      <div className='remote-archive-error'>
        <div>{error}</div>
        {detail ? <pre className='remote-archive-detail'>{detail}</pre> : null}
      </div>
    )
  }

  renderFooter () {
    const { mode, running, result, listing, listingLoading, destDir } = this.state
    if (result) {
      return <Button onClick={this.handleClose}>{e('close')}</Button>
    }
    if (running) {
      // 没有取消按钮：这条命令已经在远端 shell 里跑，客户端停不了它
      return (
        <>
          <span className='remote-archive-running'>{e('remoteArchiveRunning')}</span>
          <Button type='primary' loading disabled>
            {mode === 'create' ? e('remoteArchivePackBtn') : e('remoteArchiveExtractBtn')}
          </Button>
        </>
      )
    }
    if (mode === 'create') {
      return (
        <>
          <Button onClick={this.handleClose}>{e('cancel')}</Button>
          <Button type='primary' onClick={this.handleCreate}>{e('remoteArchivePackBtn')}</Button>
        </>
      )
    }
    return (
      <>
        <Button onClick={this.handleClose}>{e('cancel')}</Button>
        <Button
          type='primary'
          disabled={!listing || listingLoading || !destDir}
          onClick={this.handleExtract}
        >
          {e('remoteArchiveExtractBtn')}
        </Button>
      </>
    )
  }

  render () {
    const { visible, mode, result } = this.state
    return (
      <Modal
        open={visible}
        width={620}
        className='remote-archive-modal'
        maskClosable={!this.state.running}
        title={mode === 'create' ? e('remoteArchivePackTitle') : e('remoteArchiveExtractTitle')}
        onCancel={this.handleClose}
        footer={this.renderFooter()}
      >
        {result ? this.renderResult() : (mode === 'create' ? this.renderCreate() : this.renderExtract())}
        {!result ? this.renderError() : null}
      </Modal>
    )
  }
}
