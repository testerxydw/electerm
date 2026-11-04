const { describe, test, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')

// remote-suspend.js 是纯 ESM 模块（零依赖，只在函数体内读 window.store），
// node 环境没有 window，先 stub 再动态 import
global.window = { store: { config: {} } }

const MOD = require('node:path').join(
  __dirname, '../../client/common/remote-suspend.js'
)

// 挂起宽限期（suspendGraceMs）与挂起器（RemoteSuspend）的行为契约。
// 背景：隐藏的远程 tab 全速收帧（见模块头注释），切走超过宽限期就挂起。
// 宽限期存 config.remoteSuspendSeconds（秒），由三端顶栏的
// RemoteSuspendSelect 修改 —— 组件不在 manate 订阅范围内，所以宽限期
// 必须"切走那一刻"才读，改档位后下一次切走生效。

describe('suspendGraceMs：读 config，非法值回默认', () => {
  test('config 缺键时回默认 5 分钟', async () => {
    const { suspendGraceDefaultMs, suspendGraceMs } = await import(MOD)
    delete window.store.config.remoteSuspendSeconds
    assert.equal(suspendGraceMs(), suspendGraceDefaultMs)
    assert.equal(suspendGraceDefaultMs, 5 * 60 * 1000, '默认档位是 5 分钟')
  })

  test('档位按秒换算成毫秒', async () => {
    const { suspendGraceMs } = await import(MOD)
    for (const [sec, ms] of [[30, 30 * 1000], [60, 60 * 1000], [300, 300 * 1000], [1800, 30 * 60 * 1000]]) {
      window.store.config.remoteSuspendSeconds = sec
      assert.equal(suspendGraceMs(), ms, `${sec}s -> ${ms}ms`)
    }
  })

  test('0 表示隐藏即断联，返回 0ms（立即挂起）', async () => {
    const { suspendGraceMs } = await import(MOD)
    window.store.config.remoteSuspendSeconds = 0
    assert.equal(suspendGraceMs(), 0, '0 -> 0ms 隐藏即断联')
  })

  test('REMOTE_SUSPEND_NEVER(-1) 表示永不挂起，返回 Infinity', async () => {
    const { REMOTE_SUSPEND_NEVER, suspendGraceMs } = await import(MOD)
    window.store.config.remoteSuspendSeconds = REMOTE_SUSPEND_NEVER
    assert.equal(suspendGraceMs(), Infinity, '永不挂起返回 Infinity')
  })

  test('非数值/负数（除 -1 哨兵）回默认 5 分钟', async () => {
    const { suspendGraceDefaultMs, suspendGraceMs } = await import(MOD)
    for (const bad of ['x', null, NaN, -5]) {
      window.store.config.remoteSuspendSeconds = bad
      assert.equal(suspendGraceMs(), suspendGraceDefaultMs, `非法值 ${String(bad)} 回默认`)
    }
  })
})

describe('RemoteSuspend：切走宽限期到点挂起，切回恢复', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] })
    delete window.store.config.remoteSuspendSeconds
  })
  afterEach(() => {
    mock.timers.reset()
  })

  const setup = async () => {
    const { default: RemoteSuspend } = await import(MOD)
    const fired = { suspend: 0, resume: 0 }
    const guard = new RemoteSuspend({
      onSuspend: () => { fired.suspend++ },
      onResume: () => { fired.resume++ }
    })
    return { guard, fired }
  }

  test('切走后到宽限期才挂起，只挂起一次', async () => {
    const { guard, fired } = await setup()
    guard.update(false)
    mock.timers.tick(5 * 60 * 1000 - 1)
    assert.equal(fired.suspend, 0, '宽限期内不挂起')
    mock.timers.tick(1)
    assert.equal(fired.suspend, 1, '到点挂起')
    mock.timers.tick(10 * 60 * 1000)
    assert.equal(fired.suspend, 1, '不重复挂起')
    guard.stop()
  })

  test('切走前改档位，下一次切走用新值（宽限期切走时才读）', async () => {
    const { guard, fired } = await setup()
    window.store.config.remoteSuspendSeconds = 30
    guard.update(false)
    mock.timers.tick(30 * 1000)
    assert.equal(fired.suspend, 1, '30s 档位到点挂起')
    guard.update(true)
    assert.equal(fired.resume, 1, '切回恢复')
    window.store.config.remoteSuspendSeconds = 1800
    guard.update(false)
    mock.timers.tick(5 * 60 * 1000)
    assert.equal(fired.suspend, 1, '30 分钟档位下 5 分钟不挂起')
    mock.timers.tick(25 * 60 * 1000)
    assert.equal(fired.suspend, 2, '30 分钟档位到点挂起')
    guard.stop()
  })

  test('宽限期内切回：取消挂起且不报恢复；挂起后切回才报恢复', async () => {
    const { guard, fired } = await setup()
    guard.update(false)
    mock.timers.tick(1000)
    guard.update(true)
    assert.equal(fired.resume, 0, '还没挂起就切回，不算"恢复"')
    assert.equal(fired.suspend, 0, '未到点切回不挂起')
    mock.timers.tick(5 * 60 * 1000)
    assert.equal(fired.suspend, 0, '切回后 pending timer 必须取消')
    guard.update(true)
    assert.equal(fired.resume, 0, '重复激活不重复报恢复')
    // 挂起 -> 切回 = 恢复
    guard.update(false)
    mock.timers.tick(5 * 60 * 1000)
    assert.equal(fired.suspend, 1)
    guard.update(true)
    assert.equal(fired.resume, 1, '挂起后切回报恢复')
    guard.stop()
  })

  test('stop 清掉 pending timer，不再挂起', async () => {
    const { guard, fired } = await setup()
    guard.update(false)
    guard.stop()
    mock.timers.tick(5 * 60 * 1000)
    assert.equal(fired.suspend, 0)
  })

  test('0 档位：隐藏即立刻挂起（grace=0），切回恢复', async () => {
    const { default: RemoteSuspend } = await import(MOD)
    window.store.config.remoteSuspendSeconds = 0
    const fired = { suspend: 0, resume: 0 }
    const guard = new RemoteSuspend({
      onSuspend: () => { fired.suspend++ },
      onResume: () => { fired.resume++ }
    })
    guard.update(false)
    mock.timers.tick(0)
    assert.equal(fired.suspend, 1, '0 档：隐藏即挂起（不等宽限）')
    guard.update(true)
    assert.equal(fired.resume, 1, '切回恢复')
    guard.stop()
  })

  test('永不挂起(-1)：隐藏也不武装计时器，再久也不断连', async () => {
    const { REMOTE_SUSPEND_NEVER, default: RemoteSuspend } = await import(MOD)
    window.store.config.remoteSuspendSeconds = REMOTE_SUSPEND_NEVER
    const fired = { suspend: 0, resume: 0 }
    const guard = new RemoteSuspend({
      onSuspend: () => { fired.suspend++ },
      onResume: () => { fired.resume++ }
    })
    guard.update(false)
    mock.timers.tick(365 * 24 * 60 * 60 * 1000)
    assert.equal(fired.suspend, 0, '永不挂起：再久也不挂起')
    guard.update(true)
    assert.equal(fired.resume, 0, '从未挂起，切回不算恢复')
    guard.stop()
  })
})
