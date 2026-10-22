// A5 快速连接 URI 解析（设计 §3.2）
// mysql://user:pass@host:3306/db
// postgres://...  postgresql://...
// redis://:pass@host:6379/0   rediss 暂不支持（表单无 ssl 字段）
// 密码含特殊字符须 percent-encoding；URI 解析错误一律显式报错，不产生半成品 tab

import { dbDefaultPortMap } from './constants'

const SCHEME_MAP = {
  mysql: { dbType: 'mysql' },
  postgres: { dbType: 'postgres' },
  postgresql: { dbType: 'postgres' },
  redis: { dbType: 'redis' }
}

// 不支持的已知协议：给出明确文案而非笼统 invalid
const REDISS = 'rediss'

export function parseDbUri (uri) {
  const raw = String(uri || '').trim()
  if (!raw) {
    throw new Error('empty database uri')
  }
  const schemeGuess = raw.split('://')[0].toLowerCase()
  if (schemeGuess === REDISS) {
    throw new Error('rediss (redis over TLS) is not supported yet')
  }
  let u
  try {
    u = new URL(raw)
  } catch (e) {
    throw new Error('invalid database uri')
  }
  const scheme = (u.protocol || '').replace(/:$/, '').toLowerCase()
  const hit = SCHEME_MAP[scheme]
  if (!hit) {
    throw new Error('unsupported scheme: ' + (scheme || '(none)'))
  }
  if (!u.hostname) {
    throw new Error('database uri missing host')
  }
  const base = {
    dbType: hit.dbType,
    dbHost: u.hostname,
    dbPort: u.port
      ? Number(u.port)
      : dbDefaultPortMap[hit.dbType],
    // URL 属性返回 percent-encoded 串，需 decode 还原特殊字符
    dbUser: safeDecode(u.username),
    dbPassword: safeDecode(u.password)
  }
  if (hit.dbType === 'redis') {
    // path 形如 /0 → dbIndex；缺省 0
    const idx = parseInt(u.pathname.replace(/^\//, ''), 10)
    return {
      ...base,
      dbIndex: Number.isInteger(idx) ? idx : 0
    }
  }
  return {
    ...base,
    dbName: safeDecode(u.pathname.replace(/^\//, ''))
  }
}

function safeDecode (s) {
  if (!s) {
    return ''
  }
  try {
    return decodeURIComponent(s)
  } catch (e) {
    return s
  }
}
