// G9-1：隧道运行时的面板归一层（纯函数）
//
// 钉的重点是"界面不许替用户猜状态"：
// 没见过的类型要说"不认识"而不是 running；端口没配要说"没启动"而不是错误；
// 重启失败时 error 要盖过 stopped，否则面板显示"已停止"而用户刚看到它启动失败。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/tunnel-runtime.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

const spec = (type, extra = {}) => ({
  sshTunnel: type,
  sshTunnelLocalHost: '127.0.0.1',
  sshTunnelLocalPort: 12200,
  sshTunnelRemoteHost: '10.0.0.9',
  sshTunnelRemotePort: 3306,
  ...extra
})

describe('tunnel-runtime：类型与地址', () => {
  test('四种类型都有词条 key，且互不相同', async () => {
    const { TUNNEL_TYPES } = await load()
    const keys = Object.values(TUNNEL_TYPES).map(t => t.key)
    assert.equal(keys.length, 4)
    assert.equal(new Set(keys).size, 4)
    assert.equal(keys.includes('tunnelTypeUnknown'), false, 'unknown 不能和真类型撞 key')
  })

  test('本地监听的两类：地址 = 本地口 → 远端口', async () => {
    const { tunnelAddress } = await load()
    assert.equal(tunnelAddress(spec('forwardLocalToRemote')), '127.0.0.1:12200 → 10.0.0.9:3306')
  })

  test('远端监听的两类：方向反过来（监听端在前）', async () => {
    const { tunnelAddress } = await load()
    assert.equal(tunnelAddress(spec('forwardRemoteToLocal')), '10.0.0.9:3306 → 127.0.0.1:12200')
  })

  test('dynamic 两类没有目标端，给 socks5 地址', async () => {
    const { tunnelAddress } = await load()
    assert.equal(tunnelAddress(spec('dynamicForward')), 'socks5://127.0.0.1:12200')
    assert.equal(tunnelAddress(spec('remoteDynamicForward')), 'socks5://10.0.0.9:3306')
  })

  test('host 缺省与空白都补 127.0.0.1（服务端默认就是这个）', async () => {
    const { tunnelAddress } = await load()
    for (const h of [undefined, null, '', '   ']) {
      assert.equal(
        tunnelAddress(spec('forwardLocalToRemote', { sshTunnelLocalHost: h })),
        '127.0.0.1:12200 → 10.0.0.9:3306',
        JSON.stringify(h)
      )
    }
  })

  test('端口没给写成「host:—」，不是 host:undefined', async () => {
    const { tunnelAddress } = await load()
    const a = tunnelAddress(spec('forwardLocalToRemote', { sshTunnelLocalPort: '' }))
    assert.equal(a, '127.0.0.1:— → 10.0.0.9:3306')
    assert.equal(a.includes('undefined'), false)
  })

  test('未知类型给空串（类型列会显示"未知类型"）', async () => {
    const { tunnelAddress } = await load()
    assert.equal(tunnelAddress(spec('whateverForward')), '')
    assert.equal(tunnelAddress(undefined), '')
  })
})

describe('tunnel-runtime：监听端口判据', () => {
  test('远端开的两类看远端口，本地开的两类看本地口', async () => {
    const { listenPortOf } = await load()
    assert.equal(listenPortOf(spec('forwardLocalToRemote')), 12200)
    assert.equal(listenPortOf(spec('dynamicForward')), 12200)
    assert.equal(listenPortOf(spec('forwardRemoteToLocal')), 3306)
    assert.equal(listenPortOf(spec('remoteDynamicForward')), 3306)
  })

  test('字符串端口认，0 / 空 / 非数字不认', async () => {
    const { listenPortOf } = await load()
    assert.equal(listenPortOf(spec('dynamicForward', { sshTunnelLocalPort: '8008' })), 8008)
    for (const p of [0, '', null, 'abc', undefined]) {
      assert.equal(listenPortOf(spec('dynamicForward', { sshTunnelLocalPort: p })), null, JSON.stringify(p))
    }
  })

  test('未知类型没有"该看哪一端"可说 → null', async () => {
    const { listenPortOf } = await load()
    assert.equal(listenPortOf(spec('whatever')), null)
  })
})

describe('tunnel-runtime：行归一与状态', () => {
  test('成功回传 → running', async () => {
    const { tunnelRows, TUNNEL_STATUS } = await load()
    const r = tunnelRows([{ id: 'a', sshTunnel: spec('dynamicForward') }])
    assert.equal(r[0].status, TUNNEL_STATUS.running)
    assert.equal(r[0].error, '')
  })

  test('stopped 回传 → stopped', async () => {
    const { tunnelRows, TUNNEL_STATUS } = await load()
    const r = tunnelRows([{ id: 'a', sshTunnel: spec('dynamicForward'), stopped: true }])
    assert.equal(r[0].status, TUNNEL_STATUS.stopped)
  })

  test('重启失败：error 盖过 stopped（不然界面显示"已停止"而用户刚看到失败）', async () => {
    const { tunnelRows, TUNNEL_STATUS } = await load()
    const r = tunnelRows([{ id: 'a', sshTunnel: spec('dynamicForward'), stopped: true, error: 'EADDRINUSE' }])
    assert.equal(r[0].status, TUNNEL_STATUS.error)
    assert.equal(r[0].error, 'EADDRINUSE')
  })

  test('缺监听端口 → invalid（不是 error：根本没去试）', async () => {
    const { tunnelRows, TUNNEL_STATUS } = await load()
    const r = tunnelRows([{ id: 'a', sshTunnel: spec('dynamicForward', { sshTunnelLocalPort: 0 }) }])
    assert.equal(r[0].status, TUNNEL_STATUS.invalid)
  })

  test('没见过的类型 → invalid 且类型列说"未知类型"', async () => {
    const { tunnelRows, TUNNEL_STATUS } = await load()
    const r = tunnelRows([{ id: 'a', sshTunnel: spec('teleportForward') }])
    assert.equal(r[0].status, TUNNEL_STATUS.invalid)
    assert.equal(r[0].typeKey, 'tunnelTypeUnknown')
  })

  test('id 取用顺序：回传条目 > 配置项 > 位置兜底', async () => {
    const { tunnelRows } = await load()
    const a = tunnelRows([{ id: 'from-entry', sshTunnel: spec('dynamicForward', { id: 'from-spec' }) }])[0]
    assert.equal(a.id, 'from-entry')
    const b = tunnelRows([{ sshTunnel: spec('dynamicForward', { id: 'from-spec' }) }])[0]
    assert.equal(b.id, 'from-spec')
    const c = tunnelRows([{ sshTunnel: spec('dynamicForward') }])[0]
    assert.equal(c.id, 'tunnel-0')
  })

  test('配置里有、主进程没回传的条目补成 stopped（可启动，不是 running）', async () => {
    const { tunnelRows, TUNNEL_STATUS, tunnelAction } = await load()
    const missing = spec('forwardLocalToRemote', { id: 'gone' })
    const r = tunnelRows(
      [{ id: 'here', sshTunnel: spec('dynamicForward', { id: 'here' }) }],
      [missing, { id: 'here', sshTunnel: 'dynamicForward' }]
    )
    assert.deepEqual(r.map(x => x.id), ['here', 'gone'])
    assert.equal(r[1].status, TUNNEL_STATUS.stopped)
    assert.equal(tunnelAction(r[1]), 'start')
  })

  test('补出来的条目若端口也没配，仍是 invalid（没有"启动"可点）', async () => {
    const { tunnelRows, TUNNEL_STATUS, tunnelAction } = await load()
    const r = tunnelRows([], [spec('forwardLocalToRemote', { id: 'bad', sshTunnelLocalPort: 0 })])
    assert.equal(r.length, 1)
    assert.equal(r[0].status, TUNNEL_STATUS.invalid)
    assert.equal(tunnelAction(r[0]), null)
  })

  test('空/坏输入不炸', async () => {
    const { tunnelRows } = await load()
    for (const v of [undefined, null, 'x', 42]) {
      assert.deepEqual(tunnelRows(v), [])
    }
    assert.deepEqual(tunnelRows([null, undefined]), [])
  })

  test('同一输入跑两次结果逐字节相同', async () => {
    const { tunnelRows } = await load()
    const input = [{ id: 'a', sshTunnel: spec('dynamicForward') }, { id: 'b', sshTunnel: spec('forwardRemoteToLocal'), stopped: true }]
    assert.equal(JSON.stringify(tunnelRows(input)), JSON.stringify(tunnelRows(input)))
  })
})

describe('tunnel-runtime：汇总与动作', () => {
  const rows = async () => {
    const { tunnelRows } = await load()
    return tunnelRows([
      { id: 'a', sshTunnel: spec('dynamicForward') },
      { id: 'b', sshTunnel: spec('forwardLocalToRemote'), stopped: true },
      { id: 'c', sshTunnel: spec('forwardRemoteToLocal'), error: 'boom' },
      { id: 'd', sshTunnel: spec('remoteDynamicForward', { sshTunnelRemotePort: 0 }) }
    ])
  }

  test('计数按状态分桶，total 是行数', async () => {
    const { tunnelSummary } = await load()
    assert.deepEqual(tunnelSummary(await rows()), {
      total: 4, running: 1, stopped: 1, error: 1, invalid: 1
    })
  })

  test('动作：running 给停止、stopped/error 给启动、invalid 什么都不给', async () => {
    const { tunnelAction, TUNNEL_STATUS } = await load()
    const r = await rows()
    const byId = id => r.find(x => x.id === id)
    assert.equal(tunnelAction(byId('a')), 'stop')
    assert.equal(tunnelAction(byId('b')), 'start')
    assert.equal(tunnelAction(byId('c')), 'start')
    assert.equal(tunnelAction(byId('d')), null, '端口没配不该给"启动"')
    assert.equal(tunnelAction(null), null)
    assert.equal(tunnelAction({ status: TUNNEL_STATUS.running }), 'stop')
  })

  test('pending 只落在这一行，且不改原数组', async () => {
    const { withPending } = await load()
    const r = await rows()
    const next = withPending(r, 'a', true)
    assert.equal(next[0].pending, true)
    assert.equal(next[1].pending, undefined)
    assert.notEqual(next, r)
    assert.equal(r[0].pending, undefined, '原数组必须没被就地改过')
    // 撤掉 pending 后回到原状态
    assert.equal(withPending(next, 'a', false)[0].pending, false)
  })
})
