/**
 * 隐藏远程 tab 的挂起宽限期选择器（VNC / RDP / SPICE 三端顶栏 B 区共用）。
 *
 * 读写同一个全局配置 `config.remoteSuspendSeconds`（秒）：档位是全局习惯，
 * 所有远程窗口保持一致。挂起行为本身由 `src/client/common/remote-suspend.js`
 * 在到点时读取该配置 —— 三端 remote 组件不在 manate 订阅范围内，不随 config
 * 版本自动重渲染。本组件用本地 state 驱动显示值，并在 componentDidMount 里用
 * manate 的 autoRun 订阅 `_configVersion`：任一远程窗口改了档位后，本窗口也
 * 同步显示新值（修复"改一处其余窗口数字不刷新"的问题）。
 */

import { Component } from 'react'
import { Select, Tooltip } from 'antd'
import { autoRun } from 'manate'
import {
  suspendGraceDefaultMs,
  REMOTE_SUSPEND_NEVER
} from '../../common/remote-suspend'

// 档位（秒）。末项 -1 为"永不挂起"哨兵（见 remote-suspend.js）。
// desc 用于选项悬浮提示：短档省资源、长档持续渲染。
const SUSPEND_OPTIONS = [
  { sec: 30, desc: '最快挂起：切走即断连，最省内存/CPU，但回切需重连' },
  { sec: 60, desc: '较快挂起，平衡切换频率与资源占用' },
  { sec: 5 * 60, desc: '默认：兼顾"看一眼就回"与后台空转' },
  { sec: 10 * 60, desc: '适合频繁来回切换，较少触发重连' },
  { sec: 30 * 60, desc: '持续渲染，消耗内存/CPU，几乎不重连' },
  { sec: REMOTE_SUSPEND_NEVER, desc: '永不挂起：一直渲染，最耗资源，但切走也不断连' }
]

const DEFAULT_SECONDS = suspendGraceDefaultMs / 1000

const formatOption = (sec) => {
  if (sec === REMOTE_SUSPEND_NEVER) return '永不'
  return sec < 60 ? `${sec}s` : `${sec / 60}m`
}

function readConfigSeconds () {
  const sec = window.store?.config?.remoteSuspendSeconds
  if (sec === REMOTE_SUSPEND_NEVER) return REMOTE_SUSPEND_NEVER
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
    const introTitle = window.translate('remoteSuspendTimeout') ||
      '隐藏远程窗口自动挂起'
    const intro = (
      <div style={{ maxWidth: 260, whiteSpace: 'normal', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{introTitle}</div>
        <div>
          切走（隐藏）远程桌面超过设定时间后自动断连并停止渲染，切回时自动重连。
          所有 RDP / VNC / SPICE 窗口共用同一档位，改一处全局生效。
        </div>
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
                title={o.desc}
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
