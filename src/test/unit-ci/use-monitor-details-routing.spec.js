// use-monitor-details 路由回归：
// isLocal=true 时本地 tab 走 useLocalMonitor（不发 exec-cmd），
// isLocal=false 时远端 tab 走 useRemoteMonitor（exec 通道），互不串线。
// 该文件 import 无扩展名（'./monitor-model'），plain Node ESM 解析不了，
// 参照 db-redis-info.spec.js 的 vm 模式装载源码；两个 hook 注入 spy，
// 直接断言 enabled 路由参数与返回快照来自哪一侧。
// useLocalMonitor 本体（真实模块）用 react-dom/server 真跑一遍 Web 降级。
const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const React = require('react')
const { renderToString } = require('react-dom/server')

const state = { remoteSpy: null, localSpy: null }

let useMonitorDetails

before(async () => {
  const model = await import('../../client/components/remote-monitor/monitor-model.js')
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../client/components/remote-monitor/use-monitor-details.js'),
    'utf8'
  )
  const rewritten = src
    .replace("import { useMemo } from 'react'", 'const { useMemo } = __deps.react')
    .replace("import { MONITOR_ITEM_GROUP } from './monitor-model'", 'const { MONITOR_ITEM_GROUP } = __deps.monitorModel')
    .replace("import { useRemoteMonitor } from './session-monitor'", '')
    .replace("import { useLocalMonitor } from './local-monitor'", '')
    // 解构会立刻取走 getter 值（null），改为调用点取 __deps 上的最新 spy
    .replace('useRemoteMonitor(sessionId, groups, enabled && !isLocal)', '__deps.useRemoteMonitor(sessionId, groups, enabled && !isLocal)')
    .replace('useLocalMonitor(sessionId, groups, enabled && isLocal)', '__deps.useLocalMonitor(sessionId, groups, enabled && isLocal)')
    // vm.Script 不认 ESM 语法，去掉 export 前缀（文件只有一个导出）
    .replace(/export (?=function|const|class)/g, '')
  const deps = {
    // 路由测试不渲染组件，用朴素 useMemo 代替 React 调度器
    react: { useMemo: fn => fn() },
    monitorModel: model,
    get useRemoteMonitor () { return state.remoteSpy },
    set useRemoteMonitor (v) { state.remoteSpy = v },
    get useLocalMonitor () { return state.localSpy },
    set useLocalMonitor (v) { state.localSpy = v }
  }
  const sandbox = { __deps: deps, __exports: {} }
  vm.createContext(sandbox)
  vm.runInContext(`${rewritten}\n__exports.useMonitorDetails = useMonitorDetails`, sandbox)
  useMonitorDetails = sandbox.__exports.useMonitorDetails
})

const REMOTE = { marker: 'remote' }
const LOCAL = { marker: 'local' }

function renderRouting ({ isLocal, enabled = true, sessionId = 'sess-1', items = ['cpu', 'memory', 'upload'] } = {}) {
  const calls = { remote: null, local: null }
  state.remoteSpy = (sid, groups, en) => {
    calls.remote = { sid, groups: [...groups], enabled: en }
    return REMOTE
  }
  state.localSpy = (sid, groups, en) => {
    calls.local = { sid, groups: [...groups], enabled: en }
    return LOCAL
  }
  const snapshot = useMonitorDetails(sessionId, items, enabled, { isLocal })
  return { calls, snapshot }
}

describe('useMonitorDetails routing', () => {
  test('isLocal=true: remote hook disabled, local hook enabled, local snapshot wins', () => {
    const { calls, snapshot } = renderRouting({ isLocal: true })
    assert.deepEqual(calls.remote, { sid: 'sess-1', groups: ['cpu', 'memory', 'network'], enabled: false },
      '本地 tab 绝不能启用远端 hook（否则会发 exec-cmd）')
    assert.deepEqual(calls.local, { sid: 'sess-1', groups: ['cpu', 'memory', 'network'], enabled: true })
    assert.equal(snapshot.snapshot.marker, 'local')
  })

  test('isLocal=false/omitted/truthy-string: remote hook enabled, local hook disabled', () => {
    for (const options of [{}, { isLocal: false }, { isLocal: 'yes' }]) {
      const { calls, snapshot } = renderRouting({ options })
      assert.equal(calls.remote.enabled, true, `options=${JSON.stringify(options)}`)
      assert.equal(calls.local.enabled, false)
      assert.equal(snapshot.snapshot.marker, 'remote')
    }
  })

  test('enabled=false disables BOTH hooks regardless of routing', () => {
    const local = renderRouting({ isLocal: true, enabled: false })
    assert.equal(local.calls.remote.enabled, false)
    assert.equal(local.calls.local.enabled, false)
    const remote = renderRouting({ isLocal: false, enabled: false })
    assert.equal(remote.calls.remote.enabled, false)
    assert.equal(remote.calls.local.enabled, false)
  })

  test('items map through MONITOR_ITEM_GROUP with duplicates and unknown ids dropped', () => {
    const { calls } = renderRouting({ isLocal: true, items: ['cpu', 'memory', 'upload', 'cpu', 'bogus'] })
    assert.deepEqual([...calls.remote.groups].sort(), ['cpu', 'memory', 'network'])
  })

  test('useLocalMonitor (real module): web build without osInfo degrades to unsupported snapshot', async () => {
    const lm = await import('../../client/components/remote-monitor/local-monitor.js')
    const saved = globalThis.window
    try {
      globalThis.window = {}
      let captured = null
      const Probe = () => {
        captured = lm.useLocalMonitor('web-1', ['cpu', 'memory'], true)
        return null
      }
      renderToString(React.createElement(Probe))
      assert.equal(captured.sessionId, 'web-1')
      assert.equal(captured.groups.cpu.status, 'unsupported')
      assert.equal(captured.groups.cpu.error, 'localMonitorUnavailable')
      assert.equal(captured.groups.memory.status, 'unsupported')

      // 有 osInfo 桥：受支持，返回空快照（status idle），等待订阅填充
      globalThis.window = { pre: { osInfo: () => [] } }
      let supported = null
      const Probe2 = () => {
        supported = lm.useLocalMonitor('web-2', ['cpu'], true)
        return null
      }
      renderToString(React.createElement(Probe2))
      assert.equal(supported.groups.cpu.status, 'idle')
      assert.equal(supported.groups.cpu.data, null)
    } finally {
      if (saved === undefined) delete globalThis.window
      else globalThis.window = saved
    }
  })

  test('source wiring: both hooks always called; consumers pass isLocal correctly', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/remote-monitor/use-monitor-details.js'),
      'utf8'
    )
    assert.match(src, /useRemoteMonitor\(sessionId, groups, enabled && !isLocal\)/)
    assert.match(src, /useLocalMonitor\(sessionId, groups, enabled && isLocal\)/)
    assert.match(src, /options\.isLocal === true/)
    // 终端信息页本地分支固定走本地采集；监控页按 tab.host 判定
    const infoSrc = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/terminal-info/terminal-info.jsx'),
      'utf8'
    )
    assert.match(infoSrc, /useMonitorDetails\(tab\.id, items, true, \{ isLocal: true \}\)/)
    const panelSrc = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/remote-monitor/monitor-panel.jsx'),
      'utf8'
    )
    assert.match(panelSrc, /isLocal = !tab\.host/)
  })
})
