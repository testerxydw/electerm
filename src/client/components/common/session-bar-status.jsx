/**
 * 会话顶栏信息组件（T5-2d）：ssh2·算法 / shell 版本 / ↑↓ 速率 三段
 *
 * 使用方（一行调用，段显隐/开关/格式化全部组件内）：
 * - 终端页 .terminal-control（session-control.jsx renderBarStatus）
 * - 其他 session 页需要时同样 <SessionBarStatus tab={tab} />
 *
 * 数据源（全项目各一处实现）：
 * - ssh2 算法：session-ssh.js conn.once('handshake') → action 'ssh-handshake-info'
 * - zsh 版本：session-local.js probeZshVersion → action 'shell-info'
 * - ↑↓ 速率：common/session-traffic.js（attach addon 挂接，零 IPC）
 * 三者统一写 store.sessionInfoMap[tabId]（common/session-bar-data.js）。
 *
 * 响应式关键：必须是 manate class 组件 —— render 中读 store 才会建立追踪，
 * traffic 每 500ms 写入即触发本组件 re-render；纯函数组件读 store 不会
 * 触发 re-render（项目已知坑，见 session.jsx REC 浮层的同款处理），
 * 症状为"只在父级偶发渲染时显示快照，切 tab 后消失"。
 *
 * 显隐开关：config.sessionBarInfoVisible（default-setting.js 与渲染层同步
 * 定义），顶栏前部灯态图标点击切换，持久化 config。
 */
import React from 'react'
import { Component } from 'manate/react/class-components'
import { Tooltip } from 'antd'
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import classnames from 'classnames'

const e = window.translate

// 展示层精简: 去掉算法名 @后缀 (如 curve25519-sha256@libssh.org)
function cleanAlgo (name) {
  return (name || '').split('@')[0]
}

export function formatRate (bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 0) {
    return '0 B/s'
  }
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`
  }
  const kb = bytesPerSecond / 1024
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB/s`
  }
  return `${(kb / 1024).toFixed(1)} MB/s`
}

export default class SessionBarStatus extends Component {
  render () {
    const { tab } = this.props
    if (!tab || !tab.id) {
      return null
    }
    const { store } = window
    const info = store.sessionInfoMap[tab.id] || {}
    const visible = store.config.sessionBarInfoVisible !== false

    const hasAlgo = !!(info.kex || info.cipherClientToServer)
    const hasShellVersion = !!info.shellVersion
    const traffic = info.traffic
    const hasTraffic = !!traffic && (traffic.up > 0 || traffic.down > 0)

    const toggleVisible = () => {
      store.updateConfig({
        sessionBarInfoVisible: !visible
      })
    }

    function renderToggleIcon () {
      // 语言包现有 key: hide / show（缺新 key 会回退 key 名，故复用现有）
      const title = visible ? e('hide') : e('show')
      return (
        <Tooltip title={title} placement='bottomLeft'>
          <span
            className={classnames('sess-icon pointer session-bar-status-toggle', {
              active: visible
            })}
            onClick={toggleVisible}
          >
            {visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          </span>
        </Tooltip>
      )
    }

    function renderAlgoSeg () {
      if (!hasAlgo) {
        return null
      }
      return (
        <span className='session-bar-seg mono'>
          <span className='seg-k'>ssh2</span>
          <span className='seg-v'>{cleanAlgo(info.kex)}</span>
          {
            info.cipherClientToServer
              ? (
                <>
                  <span className='seg-k'>·</span>
                  <span className='seg-v'>{cleanAlgo(info.cipherClientToServer)}</span>
                </>
                )
              : null
          }
        </span>
      )
    }

    function renderShellVersionSeg () {
      if (!hasShellVersion) {
        return null
      }
      return (
        <span className='session-bar-seg mono'>
          <span className='seg-v'>{info.shellVersion}</span>
        </span>
      )
    }

    function renderTrafficSeg () {
      if (!hasTraffic) {
        return null
      }
      return (
        <span className='session-bar-seg mono'>
          <span className='seg-up'>↑</span>
          <span className='seg-v'>{formatRate(traffic.up)}</span>
          <span className='seg-down'>↓</span>
          <span className='seg-v'>{formatRate(traffic.down)}</span>
        </span>
      )
    }

    const anySeg = visible && (hasAlgo || hasShellVersion || hasTraffic)

    return (
      <div className='session-bar-status fleft'>
        {
          anySeg
            ? (
              <span className='session-bar-status-segs'>
                {renderAlgoSeg()}
                {renderShellVersionSeg()}
                {renderTrafficSeg()}
              </span>
              )
            : null
        }
        {renderToggleIcon()}
      </div>
    )
  }
}
