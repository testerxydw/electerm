/**
 * 数据库连接失败提示卡片
 *
 * 页面级（初次建连失败）与区级（操作中掉线）共用同一份呈现：
 * 标题 + 连接目标 + 「人话」原因 + 原始错误 + 重连/复制。
 * 相比直接抛原始 errno，用户能看出该改端口、改密码还是查网络。
 */

import { Button, Space } from 'antd'
import {
  CloseCircleOutlined,
  ReloadOutlined,
  CopyOutlined
} from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { dbTypeLabelMap } from '../../common/constants'

const e = window.translate

// 常见错误 → 人话提示（顺序：先具体后泛化，避免被宽泛规则先命中）
const errRules = [
  [/NOAUTH|WRONGPASS|invalid password|auth required/i, 'dbErrAuthRequired'],
  [/ER_ACCESS_DENIED_ERROR|Access denied|authentication failed|password authentication failed|SASL|28P01/i, 'dbErrAuth'],
  [/does not support authentication protocol|caching_sha2|unknown authentication/i, 'dbErrAuthProtocol'],
  [/ECONNREFUSED|connection refused/i, 'dbErrRefused'],
  [/ETIMEDOUT|EHOSTUNREACH|timed out|timeout/i, 'dbErrTimeout'],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'dbErrHostNotFound'],
  [/Unknown database|does not exist|ER_BAD_DB_ERROR|3D000/i, 'dbErrNoDb'],
  [/READONLY|read only replica|replica/i, 'dbErrReadOnly'],
  [/connection is closed|stream isn't writeable|socket hang up|connection lost/i, 'dbErrClosed'],
  [/ssh|tunnel/i, 'dbErrTunnel']
]

// 去掉 IPC 包装噪音：
// "Error invoking remote method 'async': Error: connect ECONNREFUSED ..." → "connect ECONNREFUSED ..."
export function cleanDbError (msg) {
  return String(msg || '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

// 错误原因（人话）；认不出来时给通用排查建议
export function dbErrorHint (msg) {
  const text = String(msg || '')
  const hit = errRules.find(([re]) => re.test(text))
  return hit ? e(hit[1]) : e('dbErrUnknown')
}

// 连接要点：引擎 · host:port · 库 · 用户（不含密码）
export function dbTargetText (tab) {
  return [
    dbTypeLabelMap[tab.dbType] || tab.dbType,
    tab.dbHost ? `${tab.dbHost}:${tab.dbPort || ''}` : tab.title,
    tab.dbName,
    tab.dbUser
  ].filter(Boolean).join(' · ')
}

export default function DbConnError (props) {
  const { tab, error, title, onRetry, banner } = props
  const cls = banner
    ? 'db-conn-fail db-conn-fail-banner'
    : 'db-conn-fail'
  // 未给标题时按「连接失败 · 引擎」生成（调用方只关心错误本身）
  const head = title ||
    `${e('connectionFailed')} · ${dbTypeLabelMap[tab.dbType] || e('database')}`
  const raw = cleanDbError(error)
  return (
    <div className={cls}>
      <div className='db-conn-fail-head'>
        <CloseCircleOutlined />
        <span>{head}</span>
      </div>
      <div className='db-conn-fail-row'>
        <span className='db-conn-fail-key'>{e('dbConnTarget')}</span>
        <span className='db-conn-fail-val'>{dbTargetText(tab)}</span>
      </div>
      <div className='db-conn-fail-row'>
        <span className='db-conn-fail-key'>{e('dbErrorCause')}</span>
        <span className='db-conn-fail-val'>{dbErrorHint(raw)}</span>
      </div>
      <div className='db-conn-fail-raw' title={raw}>{raw}</div>
      <div className='db-conn-fail-actions'>
        <Space>
          <Button
            size='small'
            type='primary'
            icon={<ReloadOutlined />}
            onClick={onRetry}
          >
            {e('reconnect')}
          </Button>
          <Button
            size='small'
            icon={<CopyOutlined />}
            onClick={() => copy(raw)}
          >
            {e('copyError')}
          </Button>
        </Space>
      </div>
    </div>
  )
}
