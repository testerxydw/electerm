// 本地终端监控采集器（local-monitor.js）单元回归：
// - 纯函数：CPU 两次采样差值、loadavg 兜底、/proc/net/dev 与 netstat -ib 解析、
//   buildMemoryData/buildSysInfoData/buildNetworkSample、pickOsInterfaces 优先级；
// - 快照契约：与 session-monitor.createEmptyMonitorSnapshot / monitor-model.parse*
//   的 shape 一致，消费方 groupOf(...).data 不报错；
// - LocalMonitor 类行为：一次性采集、错误降级、users 兜底、Web 版 unsupported。
const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const { exec } = require('node:child_process')

let lm
let model
let sessionMonitor

before(async () => {
  lm = await import('../../client/components/remote-monitor/local-monitor.js')
  model = await import('../../client/components/remote-monitor/monitor-model.js')
  sessionMonitor = await import('../../client/components/remote-monitor/session-monitor.js')
})

const GROUP_NAMES = ['sysinfo', 'cpu', 'memory', 'network', 'uptime', 'users', 'disks', 'activities']

// /proc/net/dev 第 8 行（不含 lo）的等价 fixture：8 个 rx 计数 + 8 个 tx 计数
const PROC_NET_DEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 100 10 0 0 0 0 0 0 100 10 0 0 0 0 0 0',
  '  eth0: 1111 22 0 0 0 0 0 0 3333 44 0 0 0 0 0 0',
  ' wlan0: 5555 66 0 0 0 0 0 0 7777 88 0 0 0 0 0 0'
].join('\n')

const NETSTAT_IB = [
  'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
  'lo0   16384 <Link#1>                         101 0 200 51 0 102 0 0',
  'en0   1500  <Link#13>                     33125 0 4242424 28110 0 8484848 0'
].join('\n')

describe('local monitor: cpu pure functions', () => {
  const prev = [{ times: { user: 50, nice: 0, sys: 50, idle: 80, irq: 20 } }]
  const curr = [{ times: { user: 90, nice: 0, sys: 60, idle: 120, irq: 30 } }]

  test('computes usage from the delta of two os.cpus() samples', () => {
    // totalDelta=100, idleDelta=40 → used 60%
    assert.equal(lm.computeCpuUsage(prev, curr), 60)
  })

  test('clamps to 0..100 and rejects invalid deltas', () => {
    assert.equal(lm.computeCpuUsage(curr, curr), null, 'identical samples → totalDelta 0')
    const idleRegressed = [{ times: { user: 90, nice: 0, sys: 60, idle: 10, irq: 30 } }]
    assert.equal(lm.computeCpuUsage(prev, idleRegressed), null, 'idle going backwards')
    assert.equal(lm.computeCpuUsage(null, curr), null)
    assert.equal(lm.computeCpuUsage([], curr), null)
    const broken = [{ times: { user: 1, nice: 0, sys: NaN, idle: 5, irq: 0 } }]
    assert.equal(lm.computeCpuUsage(broken, curr), null)
  })

  test('loadavg fallback mirrors load/cores with clamping', () => {
    assert.equal(lm.estimateCpuFromLoadAvg([2.0, 1, 1], 4), 50)
    assert.equal(lm.estimateCpuFromLoadAvg([9, 0, 0], 4), 100, 'clamped at 100')
    assert.equal(lm.estimateCpuFromLoadAvg([-1, 0, 0], 4), null)
    assert.equal(lm.estimateCpuFromLoadAvg([2, 0, 0], 0), null)
    assert.equal(lm.estimateCpuFromLoadAvg('nope', 4), null)
  })

  test('collectCpu: first tick takes a second sample, later ticks reuse the baseline', async () => {
    const cpus = [[{ times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }],
      [{ times: { user: 0, nice: 0, sys: 0, idle: 150, irq: 0 } }]]
    let call = 1
    const monitor = new lm.LocalMonitor('cpu-sess', {
      readOsInfo: () => ({ cpus: cpus[Math.min(call++, 1)], loadavg: [1, 0, 0] }),
      runCommand: async () => '',
      intervals: Object.fromEntries(GROUP_NAMES.map(n => [n, 0])),
      delay: () => Promise.resolve()
    })
    const usage = await monitor.collectCpu({ cpus: cpus[0] })
    assert.equal(usage, 0, 'idle 100→150（全是 idle 增量）→ used 0%')
    const usage2 = await monitor.collectCpu({})
    assert.equal(usage2, 100, '基线复用后 totalDelta 0 → CPU 差值不可用，loadavg 兜底 1/1 核 = 100')
  })
})

describe('local monitor: parsers', () => {
  test('parseProcNetDev extracts rx/tx byte counters', () => {
    const list = lm.parseProcNetDev(PROC_NET_DEV)
    assert.equal(list.length, 3)
    const eth0 = list.find(i => i.name === 'eth0')
    assert.equal(eth0.rxBytes, 1111)
    assert.equal(eth0.txBytes, 3333, 'tx bytes is the 9th counter column')
    const lo = list.find(i => i.name === 'lo')
    assert.equal(lo.rxBytes, 100)
    assert.deepEqual(lm.parseProcNetDev('garbage'), [])
    assert.deepEqual(lm.parseProcNetDev(''), [])
  })

  test('parseNetstatIb takes Ibytes/Obytes from <Link#N> rows', () => {
    const list = lm.parseNetstatIb(NETSTAT_IB)
    assert.equal(list.length, 2)
    const en0 = list.find(i => i.name === 'en0')
    assert.equal(en0.rxBytes, 4242424)
    assert.equal(en0.txBytes, 8484848)
    assert.deepEqual(lm.parseNetstatIb('no link rows here'), [])
  })

  test('parseWindowsNetworkCounters accepts array or single object JSON', () => {
    const json = JSON.stringify([
      { Name: 'Ethernet', ReceivedBytes: 10, SentBytes: 20 },
      { Name: 'Loopback Pseudo-Interface 1', ReceivedBytes: 1, SentBytes: 2 }
    ])
    const list = lm.parseWindowsNetworkCounters(json)
    assert.equal(list.length, 2)
    assert.equal(list[0].rxBytes, 10)
    assert.deepEqual(lm.parseWindowsNetworkCounters('not json'), [])
  })

  test('parseWindowsDisks maps Used/Free to the parseDisks disk shape', () => {
    const json = JSON.stringify([{ Name: 'C', Used: 30, Free: 70 }])
    const disks = lm.parseWindowsDisks(json)
    assert.deepEqual(disks, [{
      filesystem: 'C',
      mount: 'C',
      totalBytes: 100,
      usedBytes: 30,
      availableBytes: 70,
      percent: 30
    }])
    assert.equal(lm.parseWindowsDisks('nope'), null)
  })
})

describe('local monitor: osInfo builders', () => {
  const osMap = {
    totalmem: 8000,
    freemem: 2000,
    uptime: 100,
    hostname: 'dev-box',
    release: '5.15.0-generic',
    platform: 'linux',
    type: 'Linux',
    arch: 'x64'
  }

  test('buildMemoryData matches the parseMemory contract', () => {
    const mem = lm.buildMemoryData(osMap)
    assert.deepEqual(mem, {
      totalBytes: 8000,
      availableBytes: 2000,
      usedBytes: 6000,
      freeBytes: 2000,
      swapTotalBytes: null,
      swapUsedBytes: null,
      percent: 75,
      compatibilityMode: true
    })
    assert.deepEqual(
      Object.keys(mem).sort(),
      Object.keys(model.parseMemory('MemTotal: 1 kB\nMemFree: 1 kB')).sort(),
      'memory shape must match the remote parser keys'
    )
    assert.equal(lm.buildMemoryData({ totalmem: 100 }), null)
    assert.equal(lm.buildMemoryData({ totalmem: 0, freemem: 0 }), null)
    // freemem > totalmem 被钳制，不产生负 used
    const clamped = lm.buildMemoryData({ totalmem: 100, freemem: 500 })
    assert.equal(clamped.usedBytes, 0)
  })

  test('buildUptimeData mirrors parseUptime output', () => {
    assert.deepEqual(lm.buildUptimeData(osMap, 5000), { seconds: 100, bootTime: -95000 })
    assert.deepEqual(Object.keys(lm.buildUptimeData(osMap, 5000)), ['seconds', 'bootTime'])
    assert.equal(lm.buildUptimeData({ uptime: -1 }, 5000), null)
    assert.equal(lm.buildUptimeData({}, 5000), null)
  })

  test('buildSysInfoData covers the parseSysInfo fields (plus shell placeholders)', () => {
    const sys = lm.buildSysInfoData(osMap)
    assert.equal(sys.hostname, 'dev-box')
    assert.equal(sys.os, 'Linux 5.15.0-generic')
    assert.deepEqual(
      Object.keys(sys).filter(k => k !== 'shell' && k !== 'shellVersion').sort(),
      Object.keys(model.parseSysInfo('Linux dev-box 5.15.0-generic x64', '')).sort()
    )
    assert.equal(lm.buildSysInfoData({}), null)
    assert.equal(lm.buildSysInfoData(null), null)
  })

  test('formatLocalOsName distinguishes Windows 10/11 and macOS', () => {
    assert.equal(lm.formatLocalOsName({ platform: 'win32', release: '10.0.22631' }), 'Windows 11 (10.0.22631)')
    assert.equal(lm.formatLocalOsName({ platform: 'win32', release: '10.0.19045' }), 'Windows 10 (10.0.19045)')
    assert.equal(lm.formatLocalOsName({ platform: 'darwin', release: '23.0.0' }), 'macOS')
    assert.equal(lm.formatLocalOsName({ platform: 'linux', release: '6.1' }), 'Linux 6.1')
    assert.equal(lm.formatLocalOsName({ type: 'SunOS' }), 'SunOS')
  })

  test('buildUsersData falls back to os.userInfo()', () => {
    assert.deepEqual(lm.buildUsersData({ userInfo: { username: 'ed' } }), {
      users: ['ed'],
      sessions: [{ user: 'ed', terminal: null, loginTime: null, source: null }]
    })
    assert.equal(lm.buildUsersData({}), null)
    assert.equal(lm.buildUsersData(null), null)
  })
})

describe('local monitor: interfaces and network sample', () => {
  test('pickOsInterfaces keeps the first public IPv4 per interface', () => {
    const nics = {
      eth0: [
        { family: 'IPv4', address: '10.0.0.5', internal: false },
        { family: 'IPv4', address: '10.0.0.6', internal: false }
      ],
      docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      v6only: [{ family: 'IPv6', address: '::1', internal: false }]
    }
    assert.deepEqual(lm.pickOsInterfaces(nics), {
      eth0: '10.0.0.5',
      docker0: '172.17.0.1'
    })
    assert.deepEqual(lm.pickOsInterfaces(null), {})
    assert.deepEqual(lm.pickOsInterfaces([1, 2]), {})
  })

  test('buildNetworkSample: interface with counters AND ipv4 wins default over address-only NICs', () => {
    const osMap = {
      networkInterfaces: {
        'aaa-virtual': [{ family: 'IPv4', address: '192.168.99.9', internal: false }],
        eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }]
      }
    }
    // 排序后 aaa-virtual 在前：若无「有计数器+有 IPv4 优先」规则，default 会误选 aaa-virtual
    const sample = lm.buildNetworkSample(osMap, PROC_NET_DEV)
    assert.equal(sample.defaultInterface, 'eth0')
    const eth0 = sample.interfaces.find(i => i.name === 'eth0')
    assert.equal(eth0.rxBytes, 1111)
    assert.equal(eth0.txBytes, 3333)
    assert.equal(eth0.ipv4, '10.0.0.5')
    const virt = sample.interfaces.find(i => i.name === 'aaa-virtual')
    assert.equal(virt.rxBytes, null)
    assert.equal(virt.ipv4, '192.168.99.9')
    // lo 不进列表
    assert.equal(sample.interfaces.some(i => i.name === 'lo'), false)
  })

  test('buildNetworkSample: counters-only interface can still be default when no ipv4 known', () => {
    const sample = lm.buildNetworkSample({}, PROC_NET_DEV)
    assert.equal(sample.defaultInterface, 'eth0')
    assert.equal(sample.interfaces.find(i => i.name === 'eth0').ipv4, null)
  })

  test('buildNetworkSample routes by platform (mac → netstat -ib, win → JSON)', () => {
    const mac = lm.buildNetworkSample({}, NETSTAT_IB, { isWin: false, isMac: true })
    assert.equal(mac.defaultInterface, 'en0', 'lo0 排除，en0 有计数器')
    const win = lm.buildNetworkSample({}, JSON.stringify([{ Name: 'Ethernet', ReceivedBytes: 5, SentBytes: 6 }]), { isWin: true, isMac: false })
    assert.equal(win.defaultInterface, 'Ethernet')
  })

  test('buildNetworkSample returns null when there is nothing to show', () => {
    assert.equal(lm.buildNetworkSample({}, ''), null)
    assert.equal(lm.buildNetworkSample({}, 'lo: 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1'), null, '仅回环 → null')
  })
})

describe('local monitor: snapshot contract with session-monitor/monitor-model', () => {
  test('group names and empty snapshot shape match createEmptyMonitorSnapshot', () => {
    const empty = sessionMonitor.createEmptyMonitorSnapshot('sess-1')
    assert.deepEqual(Object.keys(empty), ['sessionId', 'groups', 'cpuHistory', 'levels'])
    assert.deepEqual(Object.keys(empty.groups).sort(), [...GROUP_NAMES].sort())
    const unsupported = lm.createUnsupportedLocalSnapshot('sess-1', 'nope')
    assert.deepEqual(Object.keys(unsupported), Object.keys(empty))
    assert.deepEqual(Object.keys(unsupported.groups).sort(), [...GROUP_NAMES].sort())
    for (const name of GROUP_NAMES) {
      assert.equal(unsupported.groups[name].status, 'unsupported')
      assert.equal(unsupported.groups[name].error, 'nope')
      assert.equal(unsupported.groups[name].data, null)
    }
  })

  test('LOCAL_MONITOR_INTERVALS covers every group and follows the remote cadence', () => {
    assert.deepEqual(Object.keys(lm.LOCAL_MONITOR_INTERVALS).sort(), [...GROUP_NAMES].sort())
    for (const name of GROUP_NAMES) {
      if (name === 'activities') {
        assert.equal(lm.LOCAL_MONITOR_INTERVALS.activities, Math.max(model.REMOTE_MONITOR_INTERVALS.activities, 15000))
      } else {
        assert.equal(lm.LOCAL_MONITOR_INTERVALS[name], model.REMOTE_MONITOR_INTERVALS[name])
      }
    }
  })

  test('produced group data is consumable by groupOf() and downstream formatters', () => {
    const snapshot = sessionMonitor.createEmptyMonitorSnapshot('s')
    const ts = 1000
    let s = lm.applyLocalSample(snapshot, 'memory', lm.buildMemoryData({ totalmem: 8000, freemem: 2000 }), ts)
    s = lm.applyLocalSample(s, 'cpu', 42, ts)
    s = lm.applyLocalSample(s, 'disks', model.parseDisks([
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/sda1   1000  600  400  60% /'
    ].join('\n')), ts)
    s = lm.applyLocalSample(s, 'network', lm.buildNetworkSample({
      networkInterfaces: { eth0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] }
    }, PROC_NET_DEV), ts)
    s = lm.applyLocalSample(s, 'uptime', lm.buildUptimeData({ uptime: 10 }, ts), ts)
    s = lm.applyLocalSample(s, 'users', { users: ['ed'], sessions: [{ user: 'ed', terminal: null, loginTime: null, source: null }] }, ts)
    s = lm.applyLocalSample(s, 'sysinfo', lm.buildSysInfoData({ hostname: 'h', platform: 'linux', release: 'r', arch: 'x64' }), ts)
    s = lm.applyLocalSample(s, 'activities', model.parseActivities('  1 root 5.0 100 /bin/bash'), ts)

    assert.equal(model.groupOf(s, 'memory').status, 'ready')
    assert.equal(model.groupOf(s, 'memory').data.percent, 75)
    assert.equal(model.groupOf(s, 'cpu').data, 42)
    assert.deepEqual(s.cpuHistory, [{ timestamp: ts, value: 42 }])
    assert.equal(model.groupOf(s, 'disks').data[0].mount, '/')
    const primary = model.selectPrimaryNetwork(model.groupOf(s, 'network').data)
    assert.equal(primary.name, 'eth0')
    assert.equal(model.groupOf(s, 'uptime').data.seconds, 10)
    assert.deepEqual(model.groupOf(s, 'users').data.users, ['ed'])
    assert.equal(model.groupOf(s, 'sysinfo').data.hostname, 'h')
    assert.equal(model.groupOf(s, 'activities').data.length, 1)
    assert.equal(s.levels.memory, model.getUsageLevel(75, 'unknown'))
    assert.equal(s.levels.cpu, model.getUsageLevel(42, 'unknown'))
    assert.equal(s.levels.disks['/'], model.getUsageLevel(60, 'unknown'))
  })

  test('applyLocalSample caps cpuHistory at 60 entries', () => {
    let s = sessionMonitor.createEmptyMonitorSnapshot('s')
    for (let i = 0; i < 70; i++) {
      s = lm.applyLocalSample(s, 'cpu', i, i)
    }
    assert.equal(s.cpuHistory.length, 60)
    assert.equal(s.cpuHistory[59].value, 69)
  })

  test('markLocalGroupError: stale when data existed, error otherwise', () => {
    let s = sessionMonitor.createEmptyMonitorSnapshot('s')
    s = lm.applyLocalSample(s, 'memory', { percent: 1 }, 1)
    s = lm.markLocalGroupError(s, 'memory', 'boom', true)
    assert.equal(s.groups.memory.status, 'stale')
    assert.equal(s.groups.memory.error, 'boom')
    s = lm.markLocalGroupError(s, 'cpu', 'boom', false)
    assert.equal(s.groups.cpu.status, 'error')
  })
})

describe('local monitor: parseOsInfoEntries', () => {
  test('parses {k,v} entries and tolerates raw strings / junk', () => {
    const map = lm.parseOsInfoEntries([
      { k: 'totalmem', v: '8000' },
      { k: 'cpus', v: '[{"times":{"idle":1}}]' },
      { k: 'raw', v: 'not json' },
      { k: 'num', v: 5 },
      { k: null, v: 1 },
      null,
      'junk'
    ])
    assert.equal(map.totalmem, 8000)
    assert.deepEqual(map.cpus, [{ times: { idle: 1 } }])
    assert.equal(map.raw, 'not json')
    assert.equal(map.num, 5)
    assert.equal('null' in map, false)
    assert.deepEqual(lm.parseOsInfoEntries('nope'), {})
    assert.deepEqual(lm.parseOsInfoEntries(undefined), {})
  })
})

describe('local monitor: LocalMonitor class behaviour (injected deps)', () => {
  test('one-shot collection fills requested groups and always includes sysinfo', async () => {
    const commands = []
    const monitor = new lm.LocalMonitor('one-shot', {
      readOsInfo: () => ({
        totalmem: 1000,
        freemem: 250,
        uptime: 60,
        hostname: 'host',
        platform: 'linux',
        release: 'rel',
        type: 'Linux',
        arch: 'x64',
        loadavg: [0.5, 0, 0],
        cpus: [{ times: { user: 10, nice: 0, sys: 10, idle: 70, irq: 10 } }],
        userInfo: { username: 'ed' }
      }),
      runCommand: async (cmd) => {
        commands.push(cmd)
        if (cmd.startsWith('df')) {
          return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /'
        }
        if (cmd === 'who') {
          return 'ed pts/0 2026-01-01 10:00 (:0)'
        }
        if (cmd.startsWith('ps ')) {
          return '  1 root 1.0 50 /sbin/init'
        }
        return PROC_NET_DEV
      },
      intervals: Object.fromEntries(GROUP_NAMES.map(n => [n, 0])),
      delay: () => Promise.resolve()
    })
    try {
      const seen = []
      const unsub = monitor.subscribe(['memory', 'uptime', 'users', 'network', 'disks', 'activities'], snap => seen.push(snap))
      await new Promise(resolve => setImmediate(resolve))
      const snap = monitor.snapshot
      for (const name of ['sysinfo', 'memory', 'uptime', 'users', 'network', 'disks', 'activities']) {
        assert.equal(snap.groups[name].status, 'ready', `${name} should be ready, got ${snap.groups[name].status}: ${snap.groups[name].error}`)
        assert.notEqual(snap.groups[name].data, null)
      }
      assert.equal(snap.groups.memory.data.percent, 75)
      assert.deepEqual(snap.groups.users.data.users, ['ed'])
      // 未订阅的 cpu 不应产生 runner
      assert.equal(snap.groups.cpu.status, 'idle')
      // 只用本地 fs 命令，绝不碰 exec-cmd
      for (const cmd of commands) {
        assert.equal(/exec/i.test(cmd), false)
      }
      assert.deepEqual(commands.sort().map(c => c.split(' ')[0]), ['cat', 'df', 'ps', 'who'])
      unsub()
    } finally {
      monitor.destroy()
    }
  })

  test('command failure degrades: who error falls back to osInfo user; disks error marks group', async () => {
    const monitor = new lm.LocalMonitor('degrade', {
      readOsInfo: () => ({ userInfo: { username: 'fallback-user' } }),
      runCommand: async (cmd) => {
        if (cmd === 'who') return ''
        throw new Error('cmd failed')
      },
      intervals: Object.fromEntries(GROUP_NAMES.map(n => [n, 0])),
      delay: () => Promise.resolve()
    })
    try {
      monitor.subscribe(['users', 'disks'], () => {})
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(monitor.snapshot.groups.users.status, 'ready')
      assert.deepEqual(monitor.snapshot.groups.users.data.users, ['fallback-user'])
      assert.equal(monitor.snapshot.groups.disks.status, 'error')
      assert.equal(monitor.snapshot.groups.disks.error, 'cmd failed')
    } finally {
      monitor.destroy()
    }
  })

  test('invalid group names in a subscription are ignored', async () => {
    const monitor = new lm.LocalMonitor('filter', {
      readOsInfo: () => ({}),
      runCommand: async () => '',
      intervals: Object.fromEntries(GROUP_NAMES.map(n => [n, 0])),
      delay: () => Promise.resolve()
    })
    try {
      monitor.subscribe(['no-such-group'], () => {})
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(monitor.runners.size, 1, '只有强制 sysinfo runner')
      assert.equal(monitor.snapshot.groups['no-such-group'], undefined)
    } finally {
      monitor.destroy()
    }
  })

  test('destroy removes the visibility handler and clears runners', () => {
    const monitor = new lm.LocalMonitor('destroy-1', {
      readOsInfo: () => ({}),
      runCommand: async () => ''
    })
    const unsub = monitor.subscribe([], () => {})
    unsub()
    assert.equal(monitor.visibilityHandler, null)
  })
})

describe('local monitor: platform support detection', () => {
  test('isLocalMonitorSupported follows window.pre.osInfo', () => {
    const savedWindow = globalThis.window
    try {
      globalThis.window = {}
      assert.equal(lm.isLocalMonitorSupported(), false)
      globalThis.window = { pre: { osInfo: () => [] } }
      assert.equal(lm.isLocalMonitorSupported(), true)
    } finally {
      if (savedWindow === undefined) delete globalThis.window
      else globalThis.window = savedWindow
    }
  })

  test('createUnsupportedLocalSnapshot message defaults to null', () => {
    const snap = lm.createUnsupportedLocalSnapshot('s')
    assert.equal(snap.groups.cpu.error, null)
    assert.equal(snap.groups.cpu.status, 'unsupported')
  })
})

// 行为级验证：真实 Linux 数据（os.cpus 两次采样、/proc/net/dev、df -Pk、who、ps）
describe('local monitor: real Linux end-to-end sample', { skip: process.platform !== 'linux' }, () => {
  const runReal = cmd => new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
  })

  test('all 8 groups become ready with plausible values on this host', async () => {
    const osInfo = () => {
      let userInfo
      try {
        const ui = os.userInfo()
        userInfo = { username: ui.username }
      } catch (err) {
        userInfo = { username: process.env.USER || 'unknown' }
      }
      return [
        { k: 'totalmem', v: os.totalmem() },
        { k: 'freemem', v: os.freemem() },
        { k: 'uptime', v: os.uptime() },
        { k: 'hostname', v: os.hostname() },
        { k: 'platform', v: os.platform() },
        { k: 'type', v: os.type() },
        { k: 'release', v: os.release() },
        { k: 'arch', v: os.arch() },
        { k: 'loadavg', v: os.loadavg() },
        { k: 'cpus', v: os.cpus() },
        { k: 'userInfo', v: userInfo },
        { k: 'networkInterfaces', v: os.networkInterfaces() }
      ]
    }
    const savedWindow = globalThis.window
    globalThis.window = { pre: { osInfo }, fs: { run: runReal } }
    let monitor
    try {
      const lmReal = await import('../../client/components/remote-monitor/local-monitor.js')
      assert.equal(lmReal.isLocalMonitorSupported(), true)
      monitor = new lmReal.LocalMonitor('real-linux', {
        intervals: Object.fromEntries(GROUP_NAMES.map(n => [n, 0]))
      })
      monitor.subscribe(GROUP_NAMES, () => {})
      // 等待首轮采集完成（含 cpu 两次采样的 120ms delay + 本地命令）
      for (let i = 0; i < 50 && Object.values(monitor.snapshot.groups).some(g => g.status === 'loading' || g.status === 'idle'); i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      for (const name of GROUP_NAMES) {
        const group = monitor.snapshot.groups[name]
        assert.equal(group.status, 'ready', `${name} not ready: ${group.error}`)
      }
      const snap = monitor.snapshot
      const mem = model.groupOf(snap, 'memory').data
      assert.ok(mem.totalBytes > 0)
      assert.ok(mem.percent >= 0 && mem.percent <= 100)
      assert.equal(model.groupOf(snap, 'sysinfo').data.hostname, os.hostname())
      const disks = model.groupOf(snap, 'disks').data
      assert.ok(Array.isArray(disks) && disks.length > 0, 'df -Pk should yield at least one real mount')
      const net = model.selectPrimaryNetwork(model.groupOf(snap, 'network').data)
      assert.ok(net, 'should pick a primary interface from real /proc/net/dev')
      const up = model.groupOf(snap, 'uptime').data
      assert.ok(up.seconds > 0 && up.seconds < 10 * 365 * 24 * 3600)
      const cpu = model.groupOf(snap, 'cpu').data
      assert.ok(cpu === null || (cpu >= 0 && cpu <= 100))
      const users = model.groupOf(snap, 'users').data
      assert.ok(Array.isArray(users.users) && Array.isArray(users.sessions))
      const acts = model.groupOf(snap, 'activities').data
      assert.ok(Array.isArray(acts) && acts.length > 0, 'ps should list running processes')
    } finally {
      if (monitor) monitor.destroy()
      if (savedWindow === undefined) delete globalThis.window
      else globalThis.window = savedWindow
    }
  })
})
