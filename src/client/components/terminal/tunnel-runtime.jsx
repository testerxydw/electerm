/**
 * G9 隧道运行时面板（设计 §16.1）
 *
 * 面板没有自己的数据源：行 = 主进程推回 tab 的 sshTunnelResults ∪ 书签里的 sshTunnels，
 * 归一整套交给 common/tunnel-runtime.js，这里只做三件事——摆出来、点一下发一条 tunnel-op、
 * 把"请求在途"的那一行置忙。
 *
 * 三条刻意的口径：
 * - 状态只翻译主进程说的话：没回传就是 stopped，界面不推断"点了启动所以应该在跑"；
 * - 配置不完整（缺监听端口）的行不给按钮——点下去只会换回一条服务端错误；
 * - 会话没连着时整表禁点：隧道只能挂在一条活的 SSH 连接上。
 */
import { useState } from 'react'
import { auto } from 'manate/react'
import { Modal, Button } from 'antd'
import message from '../common/message'
import { statusMap } from '../../common/constants'
import { tunnelOp } from './terminal-apis'
import {
  TUNNEL_STATUS,
  tunnelAction,
  tunnelRows,
  tunnelSummary,
  withPending
} from '../../common/tunnel-runtime.js'
import './tunnel-runtime.styl'

const e = window.translate
const DASH = '—'

const statusText = {
  [TUNNEL_STATUS.running]: 'tunnelStatusRunning',
  [TUNNEL_STATUS.stopped]: 'tunnelStatusStopped',
  [TUNNEL_STATUS.error]: 'tunnelStatusError',
  [TUNNEL_STATUS.invalid]: 'tunnelStatusInvalid'
}

const opText = {
  start: 'tunnelStart',
  stop: 'tunnelStop'
}

export default auto(function TunnelRuntime (props) {
  const { open, tabId, onClose } = props
  const store = window.store
  // 只记"哪一行在途"：行数据始终来自 store，界面不留第二份状态
  const [pending, setPending] = useState({})
  if (!open) {
    return null
  }
  // 面板绑定在打开它那一条会话上：切页、关页都不会让这一份界面去讲别的会话的隧道
  const tab = store.tabs.find(t => t.id === tabId)
  const rows = tunnelRows(tab && tab.sshTunnelResults, tab && tab.sshTunnels)
  const summary = tunnelSummary(rows)
  const connected = !!tab && tab.status === statusMap.success
  const viewRows = Object.keys(pending).reduce(
    (acc, id) => withPending(acc, id, !!pending[id]),
    rows
  )

  function clearPending (id) {
    setPending(p => {
      const next = { ...p }
      delete next[id]
      return next
    })
  }

  function runOp (row, op) {
    setPending(p => ({ ...p, [row.id]: true }))
    tunnelOp(tab.id, op, row.id)
      .catch(err => {
        // 主进程回的是这一条隧道的真实失败原因，原样给用户看
        message.error(String((err && err.message) || err))
      })
      .finally(() => clearPending(row.id))
  }

  const renderRow = (row) => {
    const action = connected ? tunnelAction(row) : null
    const busy = !!row.pending
    // invalid 没有按钮，必须给一句为什么，否则这行看起来像界面坏了
    const hint = row.error || (
      row.status === TUNNEL_STATUS.invalid ? e('tunnelNoListenPort') : ''
    )
    return (
      <div className={'tunnel-row tunnel-row-' + row.status} key={row.id}>
        <div className='tunnel-line'>
          <span className='tunnel-name' title={row.name || DASH}>
            {row.name || DASH}
          </span>
          <span className='tunnel-type' title={e(row.typeKey)}>{e(row.typeKey)}</span>
          <span className='tunnel-address' title={row.address}>{row.address || DASH}</span>
          <span className={'tunnel-status tunnel-status-' + row.status}>
            {e(statusText[row.status])}
          </span>
          <span className='tunnel-op'>
            {
              action
                ? (
                  <Button
                    size='small'
                    disabled={busy}
                    loading={busy}
                    onClick={() => runOp(row, action)}
                  >
                    {e(opText[action])}
                  </Button>
                  )
                : <span className='tunnel-op-none'>{DASH}</span>
            }
          </span>
        </div>
        {
          hint
            ? (
              <div
                className={'tunnel-note' + (row.error ? ' tunnel-note-error' : '')}
                title={hint}
              >
                {hint}
              </div>
              )
            : null
        }
      </div>
    )
  }

  const counts = [
    [TUNNEL_STATUS.running, summary.running],
    [TUNNEL_STATUS.stopped, summary.stopped],
    [TUNNEL_STATUS.error, summary.error],
    [TUNNEL_STATUS.invalid, summary.invalid]
  ].filter(([, n]) => n > 0)

  return (
    <Modal
      className='tunnel-runtime-modal'
      open={open}
      width={720}
      title={e('tunnelRuntime')}
      onCancel={onClose}
      footer={[
        <Button key='close' size='small' onClick={onClose}>{e('close')}</Button>
      ]}
    >
      <div className='tunnel-runtime' data-tunnel-rows={viewRows.length}>
        {
          connected
            ? null
            : <div className='tunnel-bar'>{e('tunnelSessionDown')}</div>
        }
        {
          viewRows.length
            ? (
              <div className='tunnel-head'>
                <span className='tunnel-name'>{e('tunnelName')}</span>
                <span className='tunnel-type'>{e('tunnelType')}</span>
                <span className='tunnel-address' title={e('tunnelAddressHint')}>
                  {e('tunnelAddress')}
                </span>
                <span className='tunnel-status'>{e('tunnelStatus')}</span>
                <span className='tunnel-op'>{e('tunnelAction')}</span>
              </div>
              )
            : null
        }
        {viewRows.map(renderRow)}
        {
          !viewRows.length
            ? <div className='tunnel-empty'>{e('tunnelEmpty')}</div>
            : null
        }
        {
          counts.length
            ? (
              <div className='tunnel-foot'>
                <span className='tunnel-total'>
                  {e('tunnelTotal').replace('{n}', String(summary.total))}
                </span>
                {
                  counts.map(([status, n]) => (
                    <span className={'tunnel-sum tunnel-sum-' + status} key={status}>
                      <span className='tunnel-sum-n'>{n}</span>
                      {e(statusText[status])}
                    </span>
                  ))
                }
              </div>
              )
            : null
        }
      </div>
    </Modal>
  )
})
