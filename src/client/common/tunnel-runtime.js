// G9 隧道运行时：把主进程回传的 sshTunnelResults 归一成"面板能直接摆"的行。
//
// 这里不碰 i18n（只给词条 key），不碰网络，也不猜状态：
// 一条隧道到底活着没有，只有持有 conn 的那个终端子进程知道，界面只翻译它说的话。
// 地址一律写成「监听端 → 目标端」，方向交给类型列去说，这样四种类型共用一个读法。

export const TUNNEL_STATUS = {
  running: 'running',
  stopped: 'stopped',
  error: 'error',
  invalid: 'invalid'
}

// listens = 哪一端开监听口；connects = 转发到哪一端（dynamic 两类没有固定目标）
export const TUNNEL_TYPES = {
  forwardLocalToRemote: { key: 'tunnelTypeLocalToRemote', listens: 'local', connects: 'remote' },
  forwardRemoteToLocal: { key: 'tunnelTypeRemoteToLocal', listens: 'remote', connects: 'local' },
  dynamicForward: { key: 'tunnelTypeDynamic', listens: 'local', connects: null },
  remoteDynamicForward: { key: 'tunnelTypeRemoteDynamic', listens: 'remote', connects: null }
}

const host = (v, dft) => {
  const s = String(v == null ? '' : v).trim()
  return s || dft
}

const portOf = (spec, side) => {
  const p = side === 'remote' ? spec.sshTunnelRemotePort : spec.sshTunnelLocalPort
  const n = Number(p)
  return Number.isFinite(n) && n > 0 ? n : null
}

const endpoint = (spec, side) => {
  const hostName = host(side === 'remote' ? spec.sshTunnelRemoteHost : spec.sshTunnelLocalHost, '127.0.0.1')
  const port = portOf(spec, side)
  // 端口没给也要出串：这一行是给用户看"配置缺了什么"的，不是日志
  return port === null ? hostName + ':—' : hostName + ':' + port
}

/**
 * 该类型必须存在的监听端口。
 * 与 session-ssh.js 里"没有监听端口就跳过"那条判据同一条线：
 * 远端开的两类（-R / -R socks）看的是远端口，本地开的两类看本地口。
 */
export function listenPortOf (spec) {
  const t = TUNNEL_TYPES[spec && spec.sshTunnel]
  if (!t) {
    return null
  }
  return portOf(spec, t.listens)
}

/**
 * 「监听端 → 目标端」；dynamic 两类没有目标端，直接给 socks5 地址。
 */
export function tunnelAddress (spec) {
  const t = TUNNEL_TYPES[spec && spec.sshTunnel]
  if (!t) {
    return ''
  }
  const from = endpoint(spec, t.listens)
  if (!t.connects) {
    return 'socks5://' + from
  }
  return from + ' → ' + endpoint(spec, t.connects)
}

const statusOf = (entry, spec) => {
  if (entry && typeof entry.error === 'string' && entry.error) {
    return TUNNEL_STATUS.error
  }
  if (entry && entry.stopped) {
    return TUNNEL_STATUS.stopped
  }
  if (!TUNNEL_TYPES[spec.sshTunnel]) {
    // 老书签 / deeplink 里冒出没见过的类型：界面要说"不认识"，不能替它编一个状态
    return TUNNEL_STATUS.invalid
  }
  if (!listenPortOf(spec)) {
    return TUNNEL_STATUS.invalid
  }
  // 配置里有、回传里没有 = 它现在没在跑（还没启动、或启动过又被摘掉）。
  // 给 stopped 而不是 running：面板上"能点启动"这件事必须与真实情况一致。
  return entry ? TUNNEL_STATUS.running : TUNNEL_STATUS.stopped
}

/**
 * @param results 主进程回传的数组，元素形状 { id?, sshTunnel: spec, error?, stopped? }
 * @param specs   书签里配置的完整列表（可选）：用来把"因为缺端口根本没启动"的条目也摆出来
 */
export function tunnelRows (results, specs) {
  const list = Array.isArray(results) ? results : []
  const rows = []
  const seen = new Set()
  list.forEach((entry, i) => {
    // 连对象都不是的条目（老版本回传、序列化丢字段）不配占一行
    if (!entry || typeof entry !== 'object') {
      return
    }
    const spec = entry.sshTunnel || {}
    const id = entry.id || spec.id || ('tunnel-' + i)
    seen.add(id)
    rows.push(rowOf(id, spec, entry))
  })
  // 主进程只把"跑过的"回传，缺端口的条目压根不在里面；
  // 面板要能让用户看见它没启动，而不是以为书签里就配了一条都没有
  for (const spec of (Array.isArray(specs) ? specs : [])) {
    const id = spec && typeof spec === 'object' ? spec.id : null
    if (!id || seen.has(id)) {
      continue
    }
    rows.push(rowOf(id, spec, null))
  }
  return rows
}

function rowOf (id, spec, entry) {
  const type = TUNNEL_TYPES[spec.sshTunnel]
  return {
    id,
    type: spec.sshTunnel || '',
    typeKey: type ? type.key : 'tunnelTypeUnknown',
    name: host(spec.name, ''),
    address: tunnelAddress(spec),
    listenPort: listenPortOf(spec),
    status: statusOf(entry, spec),
    error: (entry && entry.error) || ''
  }
}

export function tunnelSummary (rows) {
  const out = { total: 0, running: 0, stopped: 0, error: 0, invalid: 0 }
  for (const r of (Array.isArray(rows) ? rows : [])) {
    out.total++
    if (out[r.status] !== undefined) {
      out[r.status]++
    }
  }
  return out
}

/**
 * 这一行该给什么按钮。
 * invalid 永远没有：端口都没配，点"启动"只会拿一条服务端错误糊用户一脸。
 */
export function tunnelAction (row) {
  if (!row) {
    return null
  }
  if (row.status === TUNNEL_STATUS.running) {
    return 'stop'
  }
  if (row.status === TUNNEL_STATUS.stopped || row.status === TUNNEL_STATUS.error) {
    return 'start'
  }
  return null
}

/**
 * 请求在途时把某一行标成"忙"，界面据此禁用它自己的按钮——
 * 只改这一行，别整表替换：主进程随时可能推回一份新的，整表替换会把别人的状态盖掉。
 */
export function withPending (rows, id, pending) {
  return (Array.isArray(rows) ? rows : []).map(r =>
    r.id === id ? { ...r, pending } : r
  )
}
