// G6 T4：Vault 锁定态拦截新建连接
//
// 两组契约：
// - vault-unlock 总线：只允许一个 pending，取消/成功都要给出一个明确的布尔结果，
//   否则 store 里 await 的那句门禁会永远挂着，或者弹一次开好几个弹窗。
// - setting.js 的 onSelectBookmark：所有连接入口都从这里走，门禁必须在 addTab 之前。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(__dirname, '../../client/common/vault-unlock.js')
const SETTING = path.join(ROOT, 'src/client/store/setting.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// 模块里的 pending/listeners 是模块级状态，每个用例单独 import 一份，互不串味
let seq = 0
const load = async () => import(pathToFileURL(MOD).href + '?t=' + (++seq))

describe('请求解锁总线', () => {
  it('没有订阅者时立刻返回 false（连库都没建就没有弹窗可等）', async () => {
    const { requestUnlock } = await load()
    assert.equal(await requestUnlock(), false)
  })

  it('订阅后请求挂起，settleUnlock(true) 放行', async () => {
    const { requestUnlock, onUnlockRequest, settleUnlock } = await load()
    let hits = 0
    const off = onUnlockRequest(() => { hits++ })
    const p = requestUnlock()
    assert.equal(hits, 1, '订阅者应该收到一次打开弹窗的请求')
    assert.equal(settleUnlock(true), true)
    assert.equal(await p, true)
    off()
  })

  it('settleUnlock(false) 表示用户取消了（调用方拿到 false 而不是异常）', async () => {
    const { requestUnlock, onUnlockRequest, settleUnlock } = await load()
    const off = onUnlockRequest(() => {})
    const p = requestUnlock()
    assert.equal(settleUnlock(false), true)
    assert.equal(await p, false)
    off()
  })

  it('多个订阅者都会收到；其中一个抛错不带走另一个', async () => {
    const { requestUnlock, onUnlockRequest, settleUnlock } = await load()
    const hit = []
    const warn = console.warn
    console.warn = () => {}
    const offBad = onUnlockRequest(() => { throw new Error('boom') })
    const offGood = onUnlockRequest(() => { hit.push('good') })
    let p
    try {
      assert.doesNotThrow(() => { p = requestUnlock() })
    } finally {
      console.warn = warn
    }
    offBad()
    offGood()
    assert.deepEqual(hit, ['good'], '抛错之后其余订阅者仍要收到')
    settleUnlock(false)
    assert.equal(await p, false)
  })

  it('pending 期间再次请求复用同一个 Promise，订阅者不会收到第二次', async () => {
    const { requestUnlock, onUnlockRequest, settleUnlock } = await load()
    let hits = 0
    const off = onUnlockRequest(() => { hits++ })
    const p1 = requestUnlock()
    const p2 = requestUnlock()
    assert.equal(p1, p2, '同一轮弹窗只能有一个结果')
    assert.equal(hits, 1, '弹窗已经开着，不该再通知一次')
    settleUnlock(true)
    assert.equal(await p1, true)
    off()
  })

  it('退订后不再收到请求；没有 pending 时 settleUnlock 返回 false', async () => {
    const { requestUnlock, onUnlockRequest, settleUnlock } = await load()
    let hits = 0
    const off = onUnlockRequest(() => { hits++ })
    off()
    assert.equal(await requestUnlock(), false)
    assert.equal(hits, 0, '退订后还收到请求：组件卸载没摘干净')
    assert.equal(settleUnlock(true), false, '没有 pending 时不该假装成功')
  })

  it('非函数订阅返回一个能安全调用的退订，且不会把总线弄坏', async () => {
    const { onUnlockRequest, requestUnlock, settleUnlock } = await load()
    const off = onUnlockRequest(null)
    assert.equal(typeof off, 'function')
    let hits = 0
    const off2 = onUnlockRequest(() => { hits++ })
    requestUnlock()
    assert.equal(hits, 1)
    settleUnlock(false)
    off2()
  })
})

describe('onSelectBookmark 门禁（源码契约）', () => {
  const src = fs.readFileSync(SETTING, 'utf8')
  const body = src.match(/Store\.prototype\.onSelectBookmark = async function \(id\) \{[\s\S]*?\n {2}\}/)

  it('接上了总线与词条，且仍是 async', () => {
    assert.match(src, /import \{ requestUnlock \} from '\.\.\/common\/vault-unlock'/)
    assert.match(src, /import \{ vaultErrorText \} from '\.\.\/common\/vault-ui'/)
    assert.match(src, /const vaultOp = \(action, arg\) => window\.pre\.runGlobalAsync\('vaultOp', action, arg\)/)
    assert.ok(body, 'onSelectBookmark 签名变了，判据要先跟着改')
    assert.match(body[0], /^Store\.prototype\.onSelectBookmark = async function/)
  })

  it('先问 status，锁着就请求解锁，不建 tab', () => {
    assert.ok(body, 'onSelectBookmark 签名变了，判据要先跟着改')
    const fn = body[0]
    assert.match(fn, /vaultOp\('status'\)/)
    assert.match(fn, /requestUnlock\(\)/)
    assert.ok(
      fn.indexOf("vaultOp('status')") < fn.indexOf('requestUnlock()'),
      '没读 status 就请求解锁：连库都没建时会白弹一个窗'
    )
    const addAt = fn.indexOf('store.addTab')
    assert.ok(addAt > 0, '原 addTab 逻辑不该丢')
    const warnAt = fn.indexOf("e('vaultNeedUnlockToConnect')")
    assert.ok(warnAt >= 0, '取消分支要提示 vaultNeedUnlockToConnect')
    assert.ok(warnAt < addAt, '取消分支必须在 addTab 之前 return')
    const gate = fn.slice(warnAt, addAt)
    assert.match(gate, /return/, '取消之后必须 return，不能继续建 tab')
  })

  it('_sealed 行要经 revealBookmark 补齐凭据，最后摘掉内部标记', () => {
    assert.ok(body, 'onSelectBookmark 签名变了，判据要先跟着改')
    const fn = body[0]
    assert.match(fn, /item\._sealed/)
    assert.match(fn, /vaultOp\('revealBookmark'/)
    assert.match(fn, /Object\.assign\(item,/)
    assert.match(fn, /delete item\._sealed/)
    assert.match(fn, /connectionHoppings/)
    assert.match(fn, /vaultErrorText\(r, e\)/)
  })

  it('新词条中英文都在', () => {
    const extra = require(LOCALES)
    assert.ok(extra.en.vaultNeedUnlockToConnect)
    assert.ok(extra.zh_cn.vaultNeedUnlockToConnect)
  })
})
