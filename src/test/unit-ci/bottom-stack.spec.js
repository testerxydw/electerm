const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadMod = () => import('../../client/common/bottom-stack.js')

// T2 底栏避让单源（doc/TODO-顶栏高度与底栏避让统一-2026-10-30.md §2）：
// resolveBottomStack 一个和式输出四个派生值，六个浮层各取一个。
// 表驱动覆盖各层组合，并断言"每加一层，session 只会不减"。

const F = 30
const M = 28
const Q = 180
const S = 44
const K = 260

const cases = [
  { name: '全 0（省略参数）', args: {}, want: { belowFooter: 0, belowMonitor: 0, reserved: 0, session: 0 } },
  { name: '全 0（显式传 0）', args: { footer: 0, monitor: 0, qm: 0, shortcut: 0, kbOffset: 0 }, want: { belowFooter: 0, belowMonitor: 0, reserved: 0, session: 0 } },
  { name: '仅 footer', args: { footer: F }, want: { belowFooter: 0, belowMonitor: F, reserved: F, session: F } },
  { name: 'footer + 监控条', args: { footer: F, monitor: M }, want: { belowFooter: 0, belowMonitor: F, reserved: F + M, session: F + M } },
  { name: 'footer + 快捷命令带', args: { footer: F, qm: Q }, want: { belowFooter: 0, belowMonitor: F, reserved: F, session: F + Q } },
  { name: 'footer + 快捷键条', args: { footer: F, shortcut: S }, want: { belowFooter: S, belowMonitor: F + S, reserved: F + S, session: F + S } },
  { name: 'footer + 软键盘偏移', args: { footer: F, kbOffset: K }, want: { belowFooter: K, belowMonitor: F + K, reserved: F + K, session: F + K } },
  { name: '快捷键条 + 软键盘同时（iOS）', args: { shortcut: S, kbOffset: K }, want: { belowFooter: S + K, belowMonitor: S + K, reserved: S + K, session: S + K } },
  { name: '仅快捷命令带（无 footer）', args: { qm: Q }, want: { belowFooter: 0, belowMonitor: 0, reserved: 0, session: Q } },
  { name: 'footer + 监控条 + 快捷命令带', args: { footer: F, monitor: M, qm: Q }, want: { belowFooter: 0, belowMonitor: F, reserved: F + M, session: F + M + Q } },
  { name: '全开', args: { footer: F, monitor: M, qm: Q, shortcut: S, kbOffset: K }, want: { belowFooter: S + K, belowMonitor: F + S + K, reserved: F + M + S + K, session: F + M + S + K + Q } }
]

describe('T2: resolveBottomStack 派生值', () => {
  for (const { name, args, want } of cases) {
    test(name, async () => {
      const { resolveBottomStack } = await loadMod()
      assert.deepEqual(resolveBottomStack(args), want)
    })
  }

  test('session 与手写和式逐项等价（layout.jsx 旧式）', async () => {
    const { resolveBottomStack } = await loadMod()
    const footer = F
    const monitor = M
    const qm = Q
    const shortcut = S
    const kbOffset = K
    assert.equal(
      resolveBottomStack({ footer, monitor, qm, shortcut, kbOffset }).session,
      footer + monitor + qm + shortcut + kbOffset
    )
  })

  test('每加一层，session 单调不减（返回值为非负数）', async () => {
    const { resolveBottomStack } = await loadMod()
    const layers = ['footer', 'monitor', 'qm', 'shortcut', 'kbOffset']
    const values = { footer: F, monitor: M, qm: Q, shortcut: S, kbOffset: K }
    let prev = -1
    let acc = {}
    for (const key of layers) {
      acc = { ...acc, [key]: values[key] }
      const { session, belowFooter, belowMonitor, reserved } = resolveBottomStack(acc)
      assert.ok(session >= prev, `${key} 加入后 session 不得变小`)
      assert.ok(belowFooter >= 0 && belowMonitor >= 0 && reserved >= 0, '派生值非负')
      prev = session
    }
  })
})
