/**
 * 隐藏远程 tab 的挂起宽限期选择器（VNC / RDP / SPICE 三端顶栏 B 区共用）。
 *
 * 读写同一个全局配置 `config.remoteSuspendSeconds`（秒）：档位是全局习惯，
 * 所有远程窗口保持一致。挂起行为本身由 `src/client/common/remote-suspend.js`
 * 在到点时读取该配置 —— 三端 remote 组件不在 manate 订阅范围内，不随 config
 * 版本自动重渲染，所以本组件用本地 state 驱动显示值，选择时同步写 config。
 */

import { Component } from 'react'
import { Select, Tooltip } from 'antd'
import { suspendGraceDefaultMs } from '../../common/remote-suspend'

// 档位（秒）。不含"永不"：隐藏会话全速收帧（见 remote-suspend.js 头注释），
// 关掉挂起等于放弃该特性；如需支持再扩展此表并同步 suspendGraceMs 语义。
const SUSPEND_OPTIONS = [30, 60, 5 * 60, 10 * 60, 30 * 60]

const DEFAULT_SECONDS = suspendGraceDefaultMs / 1000

const formatOption = (sec) => {
  return sec < 60 ? `${sec}s` : `${sec / 60}m`
}

function readConfigSeconds () {
  const sec = window.store?.config?.remoteSuspendSeconds
  return Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_SECONDS
}

export default class RemoteSuspendSelect extends Component {
  constructor (props) {
    super(props)
    this.state = {
      seconds: readConfigSeconds()
    }
  }

  handleChange = (seconds) => {
    this.setState({ seconds })
    window.store.updateConfig({ remoteSuspendSeconds: seconds })
  }

  render () {
    const title = window.translate('remoteSuspendTimeout') ||
      'Suspend hidden remote tab after this idle time'
    return (
      <Tooltip title={title}>
        <Select
          size='small'
          value={this.state.seconds}
          onChange={this.handleChange}
          popupMatchSelectWidth={false}
        >
          {
            SUSPEND_OPTIONS.map(sec => (
              <Select.Option
                key={sec}
                value={sec}
              >
                {formatOption(sec)}
              </Select.Option>
            ))
          }
        </Select>
      </Tooltip>
    )
  }
}
