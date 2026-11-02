// G6-3：保险库状态变更通知（渲染层内部的小总线）
//
// 钉的是"两个各自读 status 的组件不许互相看不见"：设置页建完库，底栏锁头必须在
// 同一刻出现（'off' 态故意不轮询，没有这条通知就只能等重启）。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/vault-notify.js')

const load = async () => import(pathToFileURL(MOD).href)

describe('订阅与通知', () => {
  it('订阅后能收到通知，退订后不再收到', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    let hits = 0
    const off = onVaultChange(() => { hits++ })
    notifyVaultChange('test')
    notifyVaultChange('test')
    assert.equal(hits, 2)
    off()
    notifyVaultChange('test')
    assert.equal(hits, 2, '退订后还收到通知：组件卸载没摘干净会一直读盘')
  })

  it('通知把 source 原样递给监听者（自己发的不再处理）', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    const seen = []
    const off = onVaultChange((src) => { seen.push(src) })
    notifyVaultChange('setting-vault')
    notifyVaultChange()
    off()
    assert.deepEqual(seen, ['setting-vault', undefined])
  })

  it('同一个函数重复订阅只算一份（挂载两次不该读两次盘）', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    let hits = 0
    const fn = () => { hits++ }
    const off1 = onVaultChange(fn)
    const off2 = onVaultChange(fn)
    notifyVaultChange('test')
    assert.equal(hits, 1)
    off1()
    off2()
  })

  it('非函数订阅返回一个能安全调用的退订，且不会把总线弄坏', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    let hits = 0
    const off = onVaultChange(null)
    assert.equal(typeof off, 'function')
    assert.equal(off(), false)
    const off2 = onVaultChange(() => { hits++ })
    notifyVaultChange('test')
    assert.equal(hits, 1)
    off2()
  })

  it('通知途中退订不影响本轮其余监听者（遍历的是快照）', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    const order = []
    const holder = {}
    const offA = onVaultChange(() => {
      order.push('a')
      holder.offB()
    })
    holder.offB = onVaultChange(() => { order.push('b') })
    notifyVaultChange('test')
    offA()
    holder.offB()
    assert.deepEqual(order, ['a', 'b'])
  })

  it('监听者抛错不带走别的监听者，也不把发通知的组件一起拖崩', async () => {
    const { onVaultChange, notifyVaultChange } = await load()
    const hit = []
    const warn = console.warn
    console.warn = () => {}
    const offBad = onVaultChange(() => { throw new Error('boom') })
    const offGood = onVaultChange(() => { hit.push('good') })
    try {
      assert.doesNotThrow(() => notifyVaultChange('test'))
    } finally {
      console.warn = warn
    }
    offBad()
    offGood()
    assert.deepEqual(hit, ['good'], '抛错之后其余监听者仍要收到')
  })
})
