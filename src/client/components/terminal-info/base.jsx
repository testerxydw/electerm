/**
 * show base terminal info, id sessionID
 */
import { Component } from 'react'
import { Button } from 'antd'
import { FolderOutlined } from '@ant-design/icons'
import ItemFilter from '../common/item-filter'
import SwitchLabel from '../common/switch'
import { INFO_PANEL_ITEM_IDS } from '../remote-monitor/monitor-model'
import { toggleTerminalLog, toggleTerminalLogTimestamp } from '../terminal/terminal-apis'
import { refs } from '../common/ref'
import ShowItem from '../common/show-item'
import { osResolve } from '../../common/resolve'
import createDefaultLogPath from '../../common/default-log-path'

const e = window.translate

// 录制时长 mm:ss（仅本页展示用）
function formatDuration (ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = n => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export default class TerminalInfoBase extends Component {
  state = {
    saveTerminalLogToFile: false,
    addTimeStampToTermLog: false,
    logPath: '',
    logFileName: '',
    // 会话录制状态快照 (store.recState[pid]) 与当前时刻（时长展示）
    rec: null,
    now: 0
  }

  componentDidMount () {
    const { pid } = this.props
    refs.add('term-info-' + pid, this)
    this.getState()
    this.recTimer = setInterval(this.syncRec, 500)
  }

  componentWillUnmount () {
    clearTimeout(this.timer)
    clearInterval(this.recTimer)
    const { pid } = this.props
    refs.remove('term-info-' + pid)
  }

  // 录制状态来自 store（密码避录不反映到 UI），每 500ms 同步一次并驱动时长
  syncRec = () => {
    const { pid } = this.props
    const rec = window.store.recState[pid]
    this.setState({
      rec: rec
        ? {
            path: rec.path,
            paused: !!rec.paused,
            startTime: rec.startTime
          }
        : null,
      now: Date.now()
    })
  }

  handleToggleRecord = () => {
    window.store.toggleSessionRecord(this.props.pid)
  }

  handleToggleRecordPause = () => {
    window.store.toggleSessionRecordPause(this.props.pid)
  }

  handleOpenLogDir = (evt) => {
    evt.preventDefault()
    window.pre.runGlobalAsync('openSessionLogDir')
  }

  handleToggleRecConfig = (key) => {
    window.store.setConfig({ [key]: !window.store.config[key] })
  }

  handleToggleTimestamp = () => {
    const { saveTerminalLogToFile, addTimeStampToTermLog } = this.state
    const {
      pid
    } = this.props
    toggleTerminalLogTimestamp(
      pid
    )
    const nv = !addTimeStampToTermLog
    this.setState({
      addTimeStampToTermLog: nv
    })
    refs.get('term-' + pid)?.setState({
      addTimeStampToTermLog: nv,
      saveTerminalLogToFile
    })
  }

  handleToggleInfo = (id) => {
    const selected = new Set(this.props.terminalInfos || [])
    if (selected.has(id)) {
      selected.delete(id)
    } else {
      selected.add(id)
    }
    window.store.setTerminalInfos(INFO_PANEL_ITEM_IDS.filter(x => selected.has(x)))
  }

  handleToggle = () => {
    const { saveTerminalLogToFile, addTimeStampToTermLog } = this.state
    const {
      pid
    } = this.props
    toggleTerminalLog(
      pid
    )
    const nv = !saveTerminalLogToFile
    this.setState({
      saveTerminalLogToFile: nv
    })
    refs.get('term-' + pid)?.setState({
      saveTerminalLogToFile: nv,
      addTimeStampToTermLog
    })
  }

  getState = () => {
    const {
      pid
    } = this.props
    const term = refs.get('term-' + pid)
    if (term) {
      this.setState({
        saveTerminalLogToFile: term.state.saveTerminalLogToFile,
        addTimeStampToTermLog: term.state.addTimeStampToTermLog,
        logPath: term.state.logPath,
        logFileName: term.state.logFileName || ''
      })
    } else {
      this.timer = setTimeout(this.getState, 100)
    }
  }

  renderTimestamp () {
    const { saveTerminalLogToFile, addTimeStampToTermLog } = this.state
    if (!saveTerminalLogToFile) {
      return null
    }
    const name = e('addTimeStampToTermLog')
    return (
      <SwitchLabel
        label={name}
        checked={addTimeStampToTermLog}
        onChange={this.handleToggleTimestamp}
        className='mg1b'
      />
    )
  }

  renderInfoFilter () {
    return (
      <ItemFilter
        ids={INFO_PANEL_ITEM_IDS}
        onToggle={this.handleToggleInfo}
        selected={this.props.terminalInfos || []}
      />
    )
  }

  // 统一日志目录行（T5-4f）：路径展示 + 文档图标/文字按钮同一动作
  renderLogDir () {
    const dir = window.store.config.sessionLogPath || createDefaultLogPath()
    return (
      <div className='pd1b font-xs color-grey'>
        <b>{e('terminalLogPath')}:</b> {dir}{' '}
        <a
          href={dir}
          title={e('openLogDir')}
          onClick={this.handleOpenLogDir}
        >
          <FolderOutlined />
        </a>{' '}
        <a href={dir} onClick={this.handleOpenLogDir}>
          {e('openLogDir')}
        </a>
      </div>
    )
  }

  renderRecSetting (key, label) {
    return (
      <SwitchLabel
        key={key}
        label={label}
        checked={!!window.store.config[key]}
        onChange={() => this.handleToggleRecConfig(key)}
        className='mg1b'
      />
    )
  }

  // 会话录制（cast）区（T5-4f）：状态/时长/文件/控制按钮/录制内容选项
  renderSessionRecord () {
    const { rec, now } = this.state
    const dur = formatDuration(rec ? now - rec.startTime : 0)
    const status = rec
      ? (rec.paused ? `${e('paused')} ${dur}` : `${e('recording')} ${dur}`)
      : e('notRecording')
    return (
      <div className='pd2t'>
        <div className='pd1b'>
          <b>{e('sessionRecording')}</b>
        </div>
        <div className='pd1b font-xs color-grey'>
          {status}
        </div>
        <div className='pd1b'>
          {
            rec
              ? (
                <>
                  <Button
                    size='small'
                    onClick={this.handleToggleRecordPause}
                  >
                    {rec.paused ? window.capitalizeFirstLetter(e('resume')) : window.capitalizeFirstLetter(e('pause'))}
                  </Button>
                  <Button
                    size='small'
                    danger
                    className='mg1l'
                    onClick={this.handleToggleRecord}
                  >
                    {e('stopRecord')}
                  </Button>
                </>
                )
              : (
                <Button size='small' onClick={this.handleToggleRecord}>
                  {e('record')}
                </Button>
                )
          }
        </div>
        {
          rec
            ? (
              <div className='pd1b font-xs color-grey'>
                {rec.path} <ShowItem to={rec.path} />
              </div>
              )
            : null
        }
        <div className='pd1b'>
          {this.renderRecSetting('recordInput', e('recordInput'))}
          {this.renderRecSetting('recordStripOsc', e('recordStripOsc'))}
          {this.renderRecSetting('recordAvoidPassword', e('recordAvoidPassword'))}
        </div>
      </div>
    )
  }

  render () {
    const {
      id,
      logName
    } = this.props
    const { saveTerminalLogToFile, logPath, logFileName } = this.state
    const name = e('saveTerminalLogToFile')
    const base = logPath || createDefaultLogPath()
    const fileName = logFileName || (logName + '.log')
    const fullPath = osResolve(base, fileName)
    return (
      <div className='terminal-info-section terminal-info-base'>
        {this.renderLogDir()}
        <div className='pd1b'>
          <b>ID:</b> {id}
        </div>
        {this.renderSessionRecord()}
        <div className='pd2t pd1b'>
          <b>{e('terminalLog')}</b>
        </div>
        <div className='pd1b'>
          <SwitchLabel
            label={name}
            checked={saveTerminalLogToFile}
            onChange={this.handleToggle}
            className='mg1r mg1b'
          />
          {
            this.renderTimestamp()
          }
        </div>
        {
          saveTerminalLogToFile
            ? (
              <div className='pd1b font-xs color-grey'>
                {e('terminalLogPath')}: {fullPath} <ShowItem to={fullPath} />
              </div>
              )
            : null
        }
        <div className='terminal-info-filter-wrap'>
          {
            this.renderInfoFilter()
          }
        </div>

      </div>
    )
  }
}
