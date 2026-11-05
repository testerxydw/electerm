/**
 * 隐藏远程 tab 的挂起控制（VNC / RDP / SPICE 三端顶栏 B 区共用）。
 *
 * 读写同一个全局配置 `config.remoteSuspendSeconds`（秒）：档位是全局习惯，
 * 所有远程窗口保持一致。档位含义（见 remote-suspend.js）：
 *  - 0    隐藏即断联
 *  - N>0  隐藏 N 秒后断联（30 / 60 / 300 / 600 / 1800）
 *  - -1   永不挂起
 * 三端 remote 组件不在 manate 订阅范围内，不随 config 版本自动重渲染，所以本组件
 * 用本地 state 驱动显示值，并在 componentDidMount 里用 manate 的 autoRun 订阅
 * `_configVersion`：任一远程窗口改了档位后，本窗口也同步刷新（修复
 * "改一处其余窗口数字不刷新"的问题）。
 */

import { Component } from 'react'
import { Select, Tooltip } from 'antd'
import { autoRun } from 'manate'
import {
  suspendGraceDefaultMs,
  REMOTE_SUSPEND_NEVER
} from '../../common/remote-suspend'

const e = window.translate

// 档位（秒）。0 = 隐藏即断联；末项 -1 为"永不挂起"哨兵（见 remote-suspend.js）。
// descKey 用于选项悬浮提示：短档省资源、长档持续渲染。词条在 locales-extra，
// 渲染时才取，模块加载早于语言就绪也不会取到空值。
const SUSPEND_OPTIONS = [
  { sec: 0, descKey: 'remoteSuspendDescNow' },
  { sec: 30, descKey: 'remoteSuspendDesc30' },
  { sec: 60, descKey: 'remoteSuspendDesc60' },
  { sec: 5 * 60, descKey: 'remoteSuspendDesc5m' },
  { sec: 10 * 60, descKey: 'remoteSuspendDesc10m' },
  { sec: 30 * 60, descKey: 'remoteSuspendDesc30m' },
  { sec: REMOTE_SUSPEND_NEVER, descKey: 'remoteSuspendDescNever' }
]

const DEFAULT_SECONDS = suspendGraceDefaultMs / 1000

const formatOption = (sec) => {
  if (sec === 0) return e('remoteSuspendNow')
  if (sec === REMOTE_SUSPEND_NEVER) return e('remoteSuspendNeverShort')
  return sec < 60 ? `${sec}s` : `${sec / 60}m`
}

function readConfigSeconds () {
  const sec = window.store?.config?.remoteSuspendSeconds
  if (sec === REMOTE_SUSPEND_NEVER) return REMOTE_SUSPEND_NEVER
  // 0 是合法档位（隐藏即断联），必须原样返回，不能回退默认
  if (sec === 0) return 0
  return Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_SECONDS
}

export default class RemoteSuspendSelect extends Component {
  constructor (props) {
    super(props)
    this.state = {
      seconds: readConfigSeconds()
    }
  }

  componentDidMount () {
    // 订阅全局 config 版本：任一远程窗口改档位后，本窗口同步刷新显示值
    this._autoRun = autoRun(() => {
      const sec = readConfigSeconds()
      if (this.state.seconds !== sec) {
        this.setState({ seconds: sec })
      }
    })
    this._autoRun.start()
  }

  componentWillUnmount () {
    if (this._autoRun) {
      this._autoRun.stop()
      this._autoRun = null
    }
  }

  handleChange = (seconds) => {
    this.setState({ seconds })
    window.store.updateConfig({ remoteSuspendSeconds: seconds })
  }

  render () {
    const intro = (
      <div style={{ maxWidth: 300, whiteSpace: 'normal', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{e('remoteSuspendTimeout')}</div>
        <div>{e('remoteSuspendIntro')}</div>
        <div style={{ marginTop: 6 }}>{e('remoteSuspendHint')}</div>
      </div>
    )
    return (
      <Tooltip title={intro}>
        <Select
          size='small'
          value={this.state.seconds}
          onChange={this.handleChange}
          popupMatchSelectWidth={false}
        >
          {
            SUSPEND_OPTIONS.map(o => (
              <Select.Option
                key={o.sec}
                value={o.sec}
                title={e(o.descKey)}
              >
                {formatOption(o.sec)}
              </Select.Option>
            ))
          }
        </Select>
      </Tooltip>
    )
  }
}
