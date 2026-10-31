/**
 * G5 目录镜像（单向、手动）的弹层：本地一棵树 → 远端一棵树。
 *
 * 四步走完：选目录 → 差异预演 → 确认 → 执行。执行只做三件事——远端建缺的目录、
 * 把要传的文件交给现有传输队列（并发、重试、进度都不在这里自己实现）、最后删
 * 远端多余的文件。字节的搬运完全交给 transfer.jsx。
 *
 * 三条底线：
 * - 预演看到的数就是执行会做的数：同一对树 + 同一个 mode，diffTrees 是纯函数。
 *   改判断依据/勾选不重新采集，只对已经采回来的两棵树重新算。
 * - 「删除远端多余项」默认不勾，而且只要有一端没采完整就禁用：残缺的远端清单
 *   会让"没扫到的文件"看起来像"源目录里没有的文件"，勾上就是删。
 * - 明细只渲染前若干行（planRows 的 limit），计数永远是全量数。
 */

import React from 'react'
import { Input, Select, Checkbox, Button } from 'antd'
import { filesize } from 'filesize'
import Modal from '../common/modal'
import { refsStatic } from '../common/ref'
import resolve from '../../common/resolve'
import generate from '../../common/uid'
import { typeMap, fileActions } from '../../common/constants'
import {
  MIRROR_MODE,
  diffTrees,
  planRows,
  planSummary
} from '../../common/dir-mirror'
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  walkLocalTree,
  walkRemoteTree,
  walkNote
} from '../../common/dir-mirror-walk'
import { createTransferProps } from './transfer-common'
import './dir-mirror-modal.styl'

const e = window.translate

// 明细渲染上限：计数是全量的，行只画前这么多（几万个文件时不然会卡住弹层）
const PLAN_LIMIT = 500

const MODES = [
  { value: MIRROR_MODE.sizeMtime, label: 'dirMirrorModeSizeMtime' },
  { value: MIRROR_MODE.sizeOnly, label: 'dirMirrorModeSizeOnly' }
]

const GROUP_LABEL = {
  create: 'dirMirrorGroupCreate',
  overwrite: 'dirMirrorGroupOverwrite',
  createDirs: 'dirMirrorGroupDirs',
  blocked: 'dirMirrorGroupBlocked',
  delete: 'dirMirrorGroupDelete',
  skip: 'dirMirrorGroupSkip'
}

const NOTE_LABEL = {
  cancelled: 'dirMirrorNoteCancelled',
  'max-entries': 'dirMirrorNoteMaxEntries',
  'max-depth': 'dirMirrorNoteMaxDepth',
  'read-error': 'dirMirrorNoteReadError'
}

const EMPTY_STATE = {
  visible: false,
  phase: 'idle',
  localDir: '',
  remoteDir: '',
  remoteDirError: '',
  mode: MIRROR_MODE.sizeMtime,
  deleteExtra: false,
  canDelete: false,
  progress: null,
  summary: null,
  plan: null,
  notes: [],
  error: '',
  result: null
}

const errText = (err) => String((err && err.message) || err || '')

// 采集侧的原因只有一句枚举，翻成人话再由界面显示；`{n}` 按原因各取一个数：
// 条数/层数上限取采集器的常量，读失败取失败目录的个数
const noteOf = (walk) => {
  if (!walk || walk.complete) {
    return ''
  }
  const reason = walkNote(walk)
  const key = NOTE_LABEL[reason] || 'dirMirrorNoteReadError'
  const n = reason === 'max-entries'
    ? DEFAULT_MAX_ENTRIES
    : reason === 'max-depth'
      ? DEFAULT_MAX_DEPTH
      : (walk.errors || []).length
  return e(key).replace('{n}', n)
}

export default class DirMirrorModal extends React.PureComponent {
  state = { ...EMPTY_STATE }

  // 连点两个目录时只认最后一次请求（同 remote-archive-modal）
  seq = 0

  sftp = null
  tab = null
  onDone = null
  localWalk = null
  remoteWalk = null
  cancelWalk = false
  counters = { local: null, remote: null }
  ticker = null

  componentDidMount () {
    refsStatic.add('dir-mirror-modal', this)
  }

  componentWillUnmount () {
    this.stopTicker()
  }

  showMirror ({ dir, remotePath, sftp, tab, onDone } = {}) {
    const localDir = typeof dir === 'string' ? dir : ''
    if (!localDir) {
      return
    }
    this.stopTicker()
    this.sftp = sftp
    this.tab = tab
    this.onDone = onDone
    this.localWalk = null
    this.remoteWalk = null
    this.cancelWalk = false
    this.setState({
      ...EMPTY_STATE,
      visible: true,
      localDir,
      remoteDir: typeof remotePath === 'string' ? remotePath : ''
    }, () => {
      // 打开即预演：右键选完目录还要多点一次按钮，而那一次点了也可能什么都没变。
      // 放在 setState 回调里而不是紧跟着调用：预演读的是 this.state 里的两个目录，
      // 状态没落地就先跑，源目录拿到的是空串。
      this.handleScan()
    })
  }

  handleClose = () => {
    if (this.state.phase === 'running') {
      return
    }
    // 采集还在跑就先叫停，不然关掉窗口它仍在后台把整棵树列完
    this.cancelWalk = true
    this.stopTicker()
    this.seq++
    this.setState({ ...EMPTY_STATE })
  }

  // 采集期间的进度每 300ms 抄一次到 state：每个目录都 setState 会把弹层拖死
  startTicker () {
    this.stopTicker()
    this.ticker = setInterval(() => {
      this.setState({
        progress: {
          local: this.counters.local,
          remote: this.counters.remote
        }
      })
    }, 300)
  }

  stopTicker () {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  handleRemoteDirChange = (ev) => {
    this.setState({ remoteDir: ev.target.value, remoteDirError: '' })
  }

  handleModeChange = (mode) => {
    this.setState({ mode }, () => {
      if (this.localWalk) {
        this.applyDiff()
      }
    })
  }

  handleDeleteExtraChange = (ev) => {
    this.setState({ deleteExtra: ev.target.checked }, () => {
      if (this.localWalk) {
        this.applyDiff()
      }
    })
  }

  handleCancelWalk = () => {
    this.cancelWalk = true
  }

  handleScan = () => {
    const { localDir, remoteDir } = this.state
    if (!this.sftp || typeof this.sftp.list !== 'function') {
      this.setState({ error: e('dirMirrorNoSftp') })
      return
    }
    if (!remoteDir) {
      this.setState({ remoteDirError: e('dirMirrorRemoteRequired') })
      return
    }
    const seq = ++this.seq
    this.cancelWalk = false
    this.counters = { local: null, remote: null }
    this.setState({
      phase: 'walking',
      error: '',
      remoteDirError: '',
      summary: null,
      plan: null,
      notes: [],
      result: null,
      progress: { local: null, remote: null }
    })
    this.startTicker()
    const isCancelled = () => this.cancelWalk || seq !== this.seq
    const local = walkLocalTree({
      root: localDir,
      isCancelled,
      onProgress: p => { this.counters.local = p }
    })
    const remote = walkRemoteTree({
      root: remoteDir,
      sftp: this.sftp,
      isCancelled,
      onProgress: p => { this.counters.remote = p }
    })
    Promise.all([local, remote]).then(([lw, rw]) => {
      if (seq !== this.seq) {
        return
      }
      this.stopTicker()
      if (this.cancelWalk) {
        this.localWalk = null
        this.remoteWalk = null
        this.setState({ phase: 'idle', progress: null, error: e('dirMirrorCancelled') })
        return
      }
      this.localWalk = lw
      this.remoteWalk = rw
      this.applyDiff(lw, rw)
    }).catch(err => {
      if (seq !== this.seq) {
        return
      }
      this.stopTicker()
      this.setState({ phase: 'idle', progress: null, error: errText(err) })
    })
  }

  applyDiff (lw = this.localWalk, rw = this.remoteWalk) {
    const { mode, deleteExtra } = this.state
    const diff = diffTrees(lw.entries, rw.entries, { mode, deleteExtra })
    const notes = []
    for (const [which, walk] of [['dirMirrorSource', lw], ['dirMirrorTarget', rw]]) {
      const n = noteOf(walk)
      if (n) {
        notes.push(`${e(which)}: ${n}`)
      }
    }
    if (diff.noTimestamp) {
      notes.push(e('dirMirrorNoTimestamp').replace('{n}', diff.noTimestamp))
    }
    if (diff.unknownSize) {
      notes.push(e('dirMirrorUnknownSize').replace('{n}', diff.unknownSize))
    }
    if (diff.duplicates) {
      notes.push(e('dirMirrorDuplicates').replace('{n}', diff.duplicates))
    }
    if (diff.blocked.length) {
      notes.push(e('dirMirrorBlockedHint').replace('{n}', diff.blocked.length))
    }
    this.setState({
      phase: 'ready',
      progress: null,
      diff,
      canDelete: !!(lw.complete && rw.complete),
      summary: planSummary(diff),
      plan: planRows(diff, { limit: PLAN_LIMIT }),
      notes
    })
  }

  // 本地 relPath 用 `/` 拼，落到本地要换成本机分隔符（远端那侧 resolve 自己判）
  localPathOf (rel) {
    const sep = (typeof window !== 'undefined' && window.pre && window.pre.sep) || '/'
    return resolve(this.state.localDir, String(rel).split('/').join(sep))
  }

  remotePathOf (rel) {
    return resolve(this.state.remoteDir, String(rel))
  }

  buildTransfer (file, overwrite) {
    const fromPath = this.localPathOf(file.relPath)
    const rel = String(file.relPath)
    const name = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
    const dir = fromPath.replace(/[\\/]+[^\\/]*$/, '')
    const fromFile = {
      id: generate(),
      type: typeMap.local,
      name,
      path: dir,
      size: file.size,
      mtimeMs: file.mtimeMs,
      isDirectory: false
    }
    if (Number.isFinite(file.mode) && file.mode > 0) {
      fromFile.mode = file.mode
    }
    const obj = {
      host: this.tab && this.tab.host,
      tabType: this.tab && this.tab.type,
      typeFrom: typeMap.local,
      typeTo: typeMap.remote,
      fromPath,
      toPath: this.remotePathOf(file.relPath),
      fromFile,
      id: generate(),
      ...createTransferProps({ tab: this.tab || {} })
    }
    // 覆盖项预先给出冲突策略：几千个文件逐个弹冲突框等于没有预演
    if (overwrite) {
      obj.resolvePolicy = fileActions.mergeOrOverwrite
    }
    return obj
  }

  handleExecute = async () => {
    const { diff, deleteExtra, phase } = this.state
    if (!diff || phase !== 'ready') {
      return
    }
    if (deleteExtra && !this.state.canDelete) {
      this.setState({ error: e('dirMirrorPartialNoDelete') })
      return
    }
    const seq = ++this.seq
    const sftp = this.sftp
    this.setState({ phase: 'running', error: '', result: null })
    const failures = []
    let dirsOk = 0
    let dirsFail = 0
    for (const d of diff.createDirs) {
      if (seq !== this.seq) {
        return
      }
      if (d.vsFile) {
        dirsFail++
        failures.push(`${d.relPath}: ${e('dirMirrorVsFile')}`)
        continue
      }
      try {
        await sftp.mkdir(this.remotePathOf(d.relPath))
        dirsOk++
      } catch (err) {
        dirsFail++
        failures.push(`${d.relPath}: ${errText(err)}`)
      }
    }
    const uploads = [
      ...diff.create.map(f => this.buildTransfer(f, false)),
      ...diff.overwrite.map(f => this.buildTransfer(f, true))
    ]
    if (uploads.length) {
      window.store.addTransferList(uploads)
    }
    let deleted = 0
    let deleteFail = 0
    for (const f of diff.deleteCandidates) {
      if (seq !== this.seq) {
        return
      }
      try {
        await sftp.rm(this.remotePathOf(f.relPath))
        deleted++
      } catch (err) {
        deleteFail++
        failures.push(`${f.relPath}: ${errText(err)}`)
      }
    }
    if (seq !== this.seq) {
      return
    }
    this.setState({
      phase: 'done',
      result: {
        dirsOk,
        dirsFail,
        queued: uploads.length,
        deleted,
        deleteFail,
        failures
      }
    })
    if (typeof this.onDone === 'function') {
      this.onDone()
    }
  }

  renderPaths () {
    const { localDir, remoteDir, remoteDirError, phase } = this.state
    const editable = phase !== 'running'
    return (
      <div className='dir-mirror-paths'>
        <div className='dir-mirror-field'>
          <div className='dir-mirror-label'>{e('dirMirrorSource')}</div>
          <div className='dir-mirror-path'>{localDir}</div>
        </div>
        <div className='dir-mirror-field'>
          <div className='dir-mirror-label'>{e('dirMirrorTarget')}</div>
          <Input
            value={remoteDir}
            disabled={!editable}
            onChange={this.handleRemoteDirChange}
            placeholder='/remote/path'
          />
          {
            remoteDirError
              ? <div className='dir-mirror-field-error'>{remoteDirError}</div>
              : null
          }
        </div>
      </div>
    )
  }

  renderOptions () {
    const { mode, deleteExtra, canDelete, phase, summary } = this.state
    const editable = phase !== 'running' && phase !== 'walking'
    return (
      <div className='dir-mirror-options'>
        <div className='dir-mirror-option'>
          <span className='dir-mirror-label'>{e('dirMirrorMode')}</span>
          <Select
            size='small'
            value={mode}
            disabled={!editable}
            onChange={this.handleModeChange}
            options={MODES.map(m => ({ value: m.value, label: e(m.label) }))}
          />
        </div>
        <div className='dir-mirror-option'>
          <Checkbox
            checked={deleteExtra}
            disabled={!editable || !canDelete}
            onChange={this.handleDeleteExtraChange}
          >
            {e('dirMirrorDeleteExtra')}
          </Checkbox>
          {
            !canDelete
              ? <span className='dir-mirror-hint'>{e('dirMirrorDeleteHint')}</span>
              : null
          }
        </div>
        {
          deleteExtra && summary
            ? (
              <div className='dir-mirror-warn-line'>
                {e('dirMirrorDeleteWarn').replace('{n}', summary.delete)}
              </div>
              )
            : null
        }
      </div>
    )
  }

  renderSummary () {
    const { summary, plan, notes } = this.state
    if (!summary) {
      return null
    }
    return (
      <div className='dir-mirror-summary'>
        <div className='dir-mirror-nums'>
          <span>{e('dirMirrorCreate').replace('{n}', summary.create)}</span>
          <span>{e('dirMirrorOverwrite').replace('{n}', summary.overwrite)}</span>
          <span>{e('dirMirrorSkip').replace('{n}', summary.skip)}</span>
          <span>{e('dirMirrorDirs').replace('{n}', summary.createDirs)}</span>
          {
            summary.delete
              ? <span className='dir-mirror-num-danger'>{e('dirMirrorDeleteN').replace('{n}', summary.delete)}</span>
              : null
          }
          {
            summary.remoteExtra
              ? <span>{e('dirMirrorRemoteExtra').replace('{n}', summary.remoteExtra).replace('{d}', summary.extraDirs)}</span>
              : null
          }
        </div>
        <div className='dir-mirror-bytes'>
          {e('dirMirrorBytes').replace('{n}', filesize(summary.bytes))}
        </div>
        {
          summary.clean
            ? <div className='dir-mirror-clean'>{e('dirMirrorClean')}</div>
            : null
        }
        {
          notes.length
            ? (
              <ul className='dir-mirror-notes'>
                {notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
              )
            : null
        }
        {this.renderPlan(plan)}
      </div>
    )
  }

  renderPlan (plan) {
    if (!plan || !plan.rows.length) {
      return null
    }
    return (
      <div className='dir-mirror-plan'>
        {plan.rows.map((r, i) => (
          <div className={`dir-mirror-plan-row dir-mirror-plan-${r.group}`} key={`${r.group}-${r.relPath}-${i}`}>
            <span className='dir-mirror-plan-group'>{e(GROUP_LABEL[r.group] || 'dirMirrorGroupSkip')}</span>
            <span className='dir-mirror-plan-path'>{r.relPath}</span>
            <span className='dir-mirror-plan-size'>
              {Number.isFinite(r.size) ? filesize(r.size) : ''}
            </span>
          </div>
        ))}
        {
          plan.truncated
            ? (
              <div className='dir-mirror-plan-more'>
                {e('dirMirrorTruncated').replace('{n}', plan.limit).replace('{t}', plan.total)}
              </div>
              )
            : null
        }
      </div>
    )
  }

  renderWalking () {
    const { progress } = this.state
    const l = progress && progress.local
    const r = progress && progress.remote
    return (
      <div className='dir-mirror-notice'>
        {e('dirMirrorWalking')
          .replace('{local}', l ? l.entries : 0)
          .replace('{remote}', r ? r.entries : 0)}
      </div>
    )
  }

  renderResult () {
    const { result } = this.state
    if (!result) {
      return null
    }
    return (
      <div className='dir-mirror-result'>
        <div>{e('dirMirrorResultDirs').replace('{ok}', result.dirsOk).replace('{fail}', result.dirsFail)}</div>
        <div>{e('dirMirrorResultQueued').replace('{n}', result.queued)}</div>
        <div>{e('dirMirrorResultDeleted').replace('{ok}', result.deleted).replace('{fail}', result.deleteFail)}</div>
        <div className='dir-mirror-result-hint'>{e('dirMirrorTransferHint')}</div>
        {
          result.failures.length
            ? (
              <pre className='dir-mirror-detail'>
                {result.failures.slice(0, 50).join('\n')}
              </pre>
              )
            : null
        }
      </div>
    )
  }

  renderError () {
    const { error } = this.state
    if (!error) {
      return null
    }
    return <div className='dir-mirror-error'>{error}</div>
  }

  renderFooter () {
    const { phase } = this.state
    if (phase === 'done') {
      return <Button onClick={this.handleClose}>{e('close')}</Button>
    }
    if (phase === 'running') {
      return (
        <>
          <span className='dir-mirror-running'>{e('dirMirrorRunning')}</span>
          <Button type='primary' loading disabled>
            {e('dirMirrorExecute')}
          </Button>
        </>
      )
    }
    if (phase === 'walking') {
      return (
        <>
          <span className='dir-mirror-running'>{e('dirMirrorWalkingHint')}</span>
          <Button onClick={this.handleCancelWalk}>{e('dirMirrorCancelWalk')}</Button>
          <Button type='primary' loading disabled>
            {e('dirMirrorScan')}
          </Button>
        </>
      )
    }
    return (
      <>
        <Button onClick={this.handleClose}>{e('cancel')}</Button>
        {
          phase === 'ready'
            ? (
              <Button onClick={this.handleScan}>{e('dirMirrorRescan')}</Button>
              )
            : null
        }
        {/* 故意不加 custom-modal-ok-btn：共享 Modal 会把这个类名的按钮绑到
            Enter/空格上，而这个按钮会往远端写并可能删文件 */}
        <Button
          type='primary'
          disabled={phase !== 'ready'}
          onClick={this.handleExecute}
        >
          {e('dirMirrorExecute')}
        </Button>
      </>
    )
  }

  render () {
    const { visible, phase, result } = this.state
    const showDiff = phase === 'ready' || phase === 'running' || phase === 'done'
    return (
      <Modal
        open={visible}
        width={720}
        className='dir-mirror-modal'
        maskClosable={phase !== 'running'}
        title={e('dirMirrorTitle')}
        onCancel={this.handleClose}
        footer={this.renderFooter()}
      >
        {this.renderPaths()}
        {this.renderOptions()}
        {
          phase === 'walking'
            ? this.renderWalking()
            : null
        }
        {
          phase === 'idle' && !result
            ? <div className='dir-mirror-notice'>{e('dirMirrorIdleHint')}</div>
            : null
        }
        {
          showDiff && !result
            ? this.renderSummary()
            : null
        }
        {phase === 'done' ? this.renderResult() : null}
        {
          phase !== 'done'
            ? this.renderError()
            : null
        }
      </Modal>
    )
  }
}
