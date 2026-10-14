/**
 * tab title create rule
 */

import {
  terminalLocalType,
  terminalDatabaseType,
  dbTypeLabelMap
} from './constants'

const e = window.translate

// 类型前缀：数据库会话显示具体引擎（[MySQL] / [Redis] / [PostgreSQL]…），
// 比通用的 [database] 信息量大、且比它更短，其余类型仍用类型名
function getTypeTag (res) {
  const { type, dbType } = res
  if (!type || type === 'ssh') {
    return ''
  }
  if (type === terminalDatabaseType && dbTypeLabelMap[dbType]) {
    return `[${dbTypeLabelMap[dbType]}]`
  }
  return `[${type}]`
}

function maskHost (hostOrIp = '') {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostOrIp)) {
    const arr = hostOrIp.split('.')
    return arr.slice(0, arr.length - 2).join('.') + '.*.*'
  } else {
    return hostOrIp.replace(/^.{3}/, '***')
  }
}

export default function createTitle (res, hide = true) {
  if (!res) {
    return ''
  }
  const {
    host, port, username, title, url,
    path, connectionHoppings, sshTunnels
  } = res
  const h = hide && window.store.config.hideIP ? maskHost(host) : host
  const fixTitle = `${username || ''}@${h}:${port}`
  const extra = host || path ? (path || fixTitle) : (url || '')
  // onlyShowTitleInTab: a session that was given its own title shows just that
  // title. One without a title is left alone and keeps the host/user fallback,
  // otherwise the tab would read as empty.
  const onlyTitle = title && window.store.config.onlyShowTitleInTab
  let f = title
    ? `${title}` + (extra && !onlyTitle ? ` - ${extra}` : '')
    : extra
  if (connectionHoppings && connectionHoppings.length) {
    f = `[⋙]${f}`
  }
  if (
    sshTunnels &&
    sshTunnels.length &&
    sshTunnels[0].sshTunnel &&
    sshTunnels[0].sshTunnelRemoteHost
  ) {
    f = `[T]${f}`
  }
  if (res.mcpStatus) {
    f = `[${res.mcpStatus}]${f}`
  }
  if (res.from === 'mcp') {
    f = `[mcp]${f}`
  }
  f = getTypeTag(res) + f
  return f || e(terminalLocalType)
}

export function createTitleTag (obj) {
  const { color } = obj
  if (!color) {
    return null
  }
  const styleTag = color
    ? { color }
    : {}
  return (
    <span style={styleTag} className='tab-title-tag'>●</span>
  )
}

export function createTitleWithTag (obj) {
  return (
    <span className='tab-title'>
      {createTitleTag(obj)} {createTitle(obj)}
    </span>
  )
}
