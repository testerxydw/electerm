/**
 * G6-2 主进程 vault 服务（阶段4 §14.7 阶段①）
 *
 * 只测服务本身：内存 store + 注入时钟 + 低成本 scrypt。
 * 落盘那层（vault-instance.js）只做路径与 JSON，真机验收在 G6-4 的
 * 实例自测里覆盖，这里不碰 electron。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { createVaultService, DEFAULT_AUTO_LOCK_MIN, MIN_AUTO_LOCK_MIN, MAX_AUTO_LOCK_MIN } = require('../../app/lib/vault')
const vc = require('../../app/common/vault-crypto')

const fastKdf = { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 32 }
const PASS = 'a-master-password'
const MIN_MS = 60 * 1000

function memStore (initial = null) {
  const box = { value: initial, reads: 0, writes: 0 }
  return {
    box,
    read () {
      box.reads++
      return box.value
    },
    write (config) {
      box.writes++
      box.value = config === null ? null : JSON.parse(JSON.stringify(config))
    }
  }
}

/** 假时钟：自动锁的到期全靠它，不需要真等一分钟 */
function fakeNow (start = 1000) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => { t += ms }
  }
}

function silentLog () {
  const lines = []
  return { lines, info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }
}

function make (opts = {}) {
  const store = opts.store || memStore()
  const clock = opts.clock || fakeNow()
  const log = opts.log || silentLog()
  const service = createVaultService({ store, now: clock.now, log, kdf: fastKdf })
  return { service, store, clock, log }
}

async function enabled (opts = {}) {
  const m = make(opts)
  const r = await m.service.run('enable', { masterPassword: opts.masterPassword || PASS, autoLockMin: opts.autoLockMin })
  assert.ok(r.ok, 'enable should succeed: ' + r.message)
  return { ...m, recoveryCode: r.recoveryCode }
}

describe('服务装配', () => {
  it('没有 store 就构建不起来（不允许静默退化成"没有库"）', () => {
    for (const store of [undefined, {}, { read: () => null }, { write () {} }]) {
      assert.throws(() => createVaultService({ store }), /needs a \{ read, write \} store/)
    }
    assert.doesNotThrow(() => createVaultService({ store: memStore() }))
  })

  it('未知 action 回原因，不抛异常', async () => {
    const { service } = make()
    for (const action of ['decrypt', 'getDek', 'constructor', '__proto__', '', null]) {
      const r = await service.run(action, {})
      assert.equal(r.ok, false, String(action))
      assert.equal(r.reason, 'unknown-action')
    }
  })

  it('参数缺省按空对象处理（渲染层传 null 也不炸）', async () => {
    const { service } = make()
    assert.equal((await service.run('status', null)).enabled, false)
    assert.equal((await service.run('unlock', undefined)).reason, 'no-vault')
    assert.equal((await service.run('enable', null)).reason, 'weak-password')
  })

  it('库里躺着半成品/别的 JSON 时不认作库（别把垃圾当配置解锁）', async () => {
    for (const junk of [undefined, null, 42, 'str', {}, { v: 1 }, { v: 1, salt: 'aa' }]) {
      const store = memStore(junk)
      const { service } = make({ store })
      const s = await service.run('status')
      assert.equal(s.ok, true)
      assert.equal(s.enabled, false)
      assert.equal((await service.run('unlock', { masterPassword: PASS })).reason, 'no-vault')
    }
  })

  it('读库失败要说成读库失败，不能说成"没启用"', async () => {
    const store = { read () { throw new Error('EIO: disk gone') }, write () {} }
    const { service } = make({ store })
    const s = await service.run('status')
    assert.equal(s.ok, false)
    assert.equal(s.reason, 'store-unavailable')
    assert.match(s.message, /disk gone/)
    assert.equal((await service.run('unlock', { masterPassword: PASS })).reason, 'store-unavailable')
    assert.equal((await service.run('enable', { masterPassword: PASS })).reason, 'store-unavailable')
  })

  it('写库失败不留半个库，也不留钥匙', async () => {
    let boom = true
    const store = {
      read: () => null,
      write: () => { if (boom) throw new Error('EROFS') }
    }
    const { service } = make({ store })
    const r = await service.run('enable', { masterPassword: PASS })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'store-unavailable')
    assert.equal(service.isUnlocked(), false)
    assert.equal(r.recoveryCode, undefined)
    boom = false
    assert.ok((await service.run('enable', { masterPassword: PASS })).ok)
  })
})

describe('建库 enable', () => {
  it('成功后是"已启用 + 已解锁"，恢复码只在这一次给出', async () => {
    const { service, store } = await enabled()
    const s = await service.run('status')
    assert.deepEqual({ enabled: s.enabled, unlocked: s.unlocked, autoLockMin: s.autoLockMin, hasRecovery: s.hasRecovery }, {
      enabled: true, unlocked: true, autoLockMin: DEFAULT_AUTO_LOCK_MIN, hasRecovery: true
    })
    assert.match(store.box.value.wrappedDek, /^vlt1:/)
    assert.equal(store.box.value.autoLockMin, DEFAULT_AUTO_LOCK_MIN)
    // 库里躺的是包好的东西，不是恢复码原文
    assert.equal(JSON.stringify(store.box.value).includes('recoveryCode'), false)
  })

  it('主密码与恢复码都不落盘、不进日志', async () => {
    const m = await enabled({ masterPassword: 'top-secret-pass' })
    assert.equal(JSON.stringify(m.store.box.value).includes('top-secret-pass'), false)
    assert.equal(JSON.stringify(m.store.box.value).includes(m.recoveryCode), false)
    const dump = m.log.lines.join('\n')
    assert.equal(dump.includes('top-secret-pass'), false)
    assert.equal(dump.includes(m.recoveryCode), false)
    const s = await m.service.run('status')
    assert.equal(JSON.stringify(s).includes('top-secret-pass'), false)
  })

  it('太短的主密码不建库（库里什么都不留）', async () => {
    const { service, store } = make()
    const r = await service.run('enable', { masterPassword: '123' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'weak-password')
    assert.equal(store.box.value, null)
    assert.equal(store.box.writes, 0)
    assert.equal((await service.run('status')).enabled, false)
  })

  it('自动锁范围外的值不建库：0 / 负数 / 超大 / 非数都不行', async () => {
    for (const autoLockMin of [0, -5, MAX_AUTO_LOCK_MIN + 1, 'abc', null, NaN]) {
      const { service, store } = make()
      const r = await service.run('enable', { masterPassword: PASS, autoLockMin })
      assert.equal(r.ok, false, JSON.stringify(autoLockMin))
      assert.equal(r.reason, 'bad-auto-lock')
      assert.equal(store.box.value, null)
    }
    const edge = await enabled({ autoLockMin: MIN_AUTO_LOCK_MIN })
    assert.equal((await edge.service.run('status')).autoLockMin, MIN_AUTO_LOCK_MIN)
    const edge2 = await enabled({ autoLockMin: MAX_AUTO_LOCK_MIN })
    assert.equal((await edge2.service.run('status')).autoLockMin, MAX_AUTO_LOCK_MIN)
  })

  it('已经建过库就不再建（换了密码也不能覆盖别人的库）', async () => {
    const m = await enabled()
    const before = JSON.stringify(m.store.box.value)
    const r = await m.service.run('enable', { masterPassword: 'another-password' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'already-enabled')
    assert.equal(JSON.stringify(m.store.box.value), before)
    assert.equal((await m.service.run('unlock', { masterPassword: 'another-password' })).reason, 'wrong-password')
  })

  it('建库参数不认渲染层传来的 kdf（否则等于把爆破成本交给调用方）', async () => {
    const { service, store } = make()
    const r = await service.run('enable', {
      masterPassword: PASS,
      kdf: { N: 2, r: 1, p: 1, maxmem: 1024 * 1024, keylen: 16 }
    })
    assert.ok(r.ok, r.message)
    // 落盘记的是实际用的那组参数（config 只留 N/r/p）
    assert.deepEqual(store.box.value.kdf, { N: fastKdf.N, r: fastKdf.r, p: fastKdf.p })
  })
})

describe('解锁与锁定', () => {
  it('口令错就是错：不给钥匙、不写状态、原话不泄漏', async () => {
    const m = await enabled()
    await m.service.run('lock')
    for (const masterPassword of ['', 'wrong-password', PASS + ' ', 42]) {
      const r = await m.service.run('unlock', { masterPassword })
      assert.equal(r.ok, false, JSON.stringify(masterPassword))
      assert.equal(r.dek, undefined)
      assert.equal(m.service.isUnlocked(), false)
    }
    assert.ok((await m.service.run('unlock', { masterPassword: PASS })).ok)
  })

  it('锁定就是把钥匙抹掉：withDek 立刻拿不到', async () => {
    const m = await enabled()
    assert.equal(m.service.isUnlocked(), true)
    const r = await m.service.run('lock')
    assert.equal(r.ok, true)
    assert.equal(r.unlocked, false)
    assert.equal(m.service.isUnlocked(), false)
    assert.throws(() => m.service.withDek(() => 'never'), /vault is locked/)
    assert.ok((await m.service.run('unlock', { masterPassword: PASS })).ok)
    assert.equal(m.service.withDek((d) => d.length), 32)
  })

  it('状态查询本身不改状态（重复 status 幂等）', async () => {
    const m = await enabled()
    const a = await m.service.run('status')
    const b = await m.service.run('status')
    assert.deepEqual(a, b)
    assert.equal(a.unlocked, true)
  })

  it('锁定后 status 说 unlocked:false，且不会再自己亮回 unlocked', async () => {
    const m = await enabled()
    await m.service.run('lock')
    for (let i = 0; i < 3; i++) {
      assert.equal((await m.service.run('status')).unlocked, false)
    }
  })
})

describe('自动锁（闲置到期）', () => {
  it('到点就锁：时间推进后 status 报 unlocked:false 且钥匙真没了', async () => {
    const m = await enabled({ autoLockMin: 2 })
    assert.equal(m.service.isUnlocked(), true)
    m.clock.advance(MIN_MS * 2 - 1000)
    assert.equal((await m.service.run('status')).unlocked, true, '还没到点不该先锁')
    m.clock.advance(MIN_MS * 2)
    assert.equal((await m.service.run('status')).unlocked, false)
    assert.throws(() => m.service.withDek(() => 1), /vault is locked/)
  })

  it('touch 把到期往后推；锁了之后 touch 推不回来', async () => {
    const m = await enabled({ autoLockMin: 1 })
    m.clock.advance(MIN_MS - 1000)
    const t = await m.service.run('touch')
    assert.equal(t.ok, true)
    assert.equal(t.unlocked, true)
    m.clock.advance(MIN_MS - 1000)
    assert.equal(m.service.isUnlocked(), true, 'touch 之后不该按老时间点到期')
    m.clock.advance(MIN_MS)
    assert.equal(m.service.isUnlocked(), false)
    assert.equal((await m.service.run('touch')).unlocked, false)
    assert.equal(m.service.isUnlocked(), false, 'touch 不是解锁')
  })

  it('解锁会重新武装计时器（不是从建库那一刻算起）', async () => {
    const m = await enabled({ autoLockMin: 1 })
    await m.service.run('lock')
    m.clock.advance(MIN_MS * 5)
    assert.equal(m.service.isUnlocked(), false)
    await m.service.run('unlock', { masterPassword: PASS })
    assert.equal(m.service.isUnlocked(), true)
    m.clock.advance(MIN_MS - 1)
    assert.equal(m.service.isUnlocked(), true)
  })

  it('改自动锁立刻生效（改小不会继续享受旧的宽限）', async () => {
    const m = await enabled({ autoLockMin: 30 })
    const r = await m.service.run('setAutoLock', { autoLockMin: 1 })
    assert.equal(r.ok, true)
    assert.equal((await m.service.run('status')).autoLockMin, 1)
    m.clock.advance(MIN_MS - 1)
    assert.equal(m.service.isUnlocked(), true)
    m.clock.advance(2)
    assert.equal(m.service.isUnlocked(), false)
    assert.equal(m.store.box.value.autoLockMin, 1)
  })

  it('范围外的自动锁不改库；没建库时改自动锁报 no-vault', async () => {
    const m = await enabled({ autoLockMin: 5 })
    for (const autoLockMin of [0, 'x', MAX_AUTO_LOCK_MIN + 1]) {
      assert.equal((await m.service.run('setAutoLock', { autoLockMin })).reason, 'bad-auto-lock')
    }
    assert.equal(m.store.box.value.autoLockMin, 5)
    const fresh = make()
    assert.equal((await fresh.service.run('setAutoLock', { autoLockMin: 5 })).reason, 'no-vault')
  })
})

describe('换主密码', () => {
  it('对旧口令才能换：换完新口令可用、旧口令失效', async () => {
    const m = await enabled({ masterPassword: 'old-pass-long' })
    assert.equal((await m.service.run('changePassword', { masterPassword: 'nope-not-old', newMasterPassword: 'new-pass-long' })).reason, 'wrong-password')
    assert.equal((await m.service.run('unlock', { masterPassword: 'new-pass-long' })).reason, 'wrong-password')
    const r = await m.service.run('changePassword', { masterPassword: 'old-pass-long', newMasterPassword: 'new-pass-long' })
    assert.equal(r.ok, true)
    await m.service.run('lock')
    assert.equal((await m.service.run('unlock', { masterPassword: 'old-pass-long' })).reason, 'wrong-password')
    assert.ok((await m.service.run('unlock', { masterPassword: 'new-pass-long' })).ok)
  })

  it('换密码不动 DEK：换之前封的凭据，换之后照样打得开', async () => {
    const m = await enabled()
    const sealed = m.service.withDek((d) => vc.sealSecret('the-real-secret', d))
    assert.ok((await m.service.run('changePassword', { masterPassword: PASS, newMasterPassword: 'brand-new-pass' })).ok)
    assert.equal(m.service.withDek((d) => vc.openSecret(sealed, d).value), 'the-real-secret')
  })

  it('新口令太短则整笔不做（库保持原样，旧口令仍可用）', async () => {
    const m = await enabled()
    const before = JSON.stringify(m.store.box.value)
    const r = await m.service.run('changePassword', { masterPassword: PASS, newMasterPassword: 'short' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'weak-password')
    assert.equal(JSON.stringify(m.store.box.value), before)
    assert.ok((await m.service.run('unlock', { masterPassword: PASS })).ok)
  })

  it('两者都不给就拒：解锁状态不等于免检', async () => {
    const m = await enabled()
    assert.equal(m.service.isUnlocked(), true, '此刻确实是解锁状态')
    const r = await m.service.run('changePassword', { newMasterPassword: 'new-pass-long' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'empty')
    assert.ok((await m.service.run('unlock', { masterPassword: 'new-pass-long' })).reason === 'wrong-password')
  })

  it('恢复码也能证明身份（忘口令时不必先把库停用）', async () => {
    const m = await enabled({ masterPassword: 'old-pass-long' })
    await m.service.run('lock')
    const r = await m.service.run('changePassword', { recoveryCode: m.recoveryCode, newMasterPassword: 'recovered-pass' })
    assert.equal(r.ok, true)
    assert.ok((await m.service.run('unlock', { masterPassword: 'recovered-pass' })).ok)
    // 恢复码这条路没被换密码挪走：手里那串仍然解得出同一把 DEK
    const byCode = await m.service.run('unlockWithRecovery', { recoveryCode: m.recoveryCode })
    assert.equal(byCode.ok, true)
    assert.equal(byCode.needsNewPassword, true)
  })
})

describe('恢复码解锁', () => {
  it('恢复码能独立解出同一把 DEK（不需要主密码）', async () => {
    const m = await enabled({ masterPassword: 'the-pass-word' })
    const before = m.service.withDek((d) => d.toString('hex'))
    await m.service.run('lock')
    const r = await m.service.run('unlockWithRecovery', { recoveryCode: m.recoveryCode })
    assert.equal(r.ok, true)
    assert.equal(r.needsNewPassword, true, '恢复码解出来要提示重设主密码')
    assert.equal(m.service.withDek((d) => d.toString('hex')), before)
  })

  it('抄错/缺段都只回原因，不给钥匙', async () => {
    const m = await enabled()
    await m.service.run('lock')
    const noDash = m.recoveryCode
    for (const recoveryCode of ['', 'A'.repeat(52), noDash.slice(0, 51) + 'B']) {
      const r = await m.service.run('unlockWithRecovery', { recoveryCode })
      assert.equal(r.ok, false, recoveryCode)
      assert.equal(m.service.isUnlocked(), false)
    }
    assert.equal((await m.service.run('unlockWithRecovery', { recoveryCode: noDash })).ok, true)
  })

  it('库没有 recovery 段时用不了恢复码路（说 no-vault 而不是崩）', async () => {
    const m = await enabled()
    const store = memStore({ ...m.store.box.value, recovery: undefined })
    const svc = createVaultService({ store, now: m.clock.now, log: silentLog(), kdf: fastKdf })
    const r = await svc.run('unlockWithRecovery', { recoveryCode: m.recoveryCode })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-vault')
  })
})

describe('停用 disable', () => {
  it('证明身份后抹掉库并锁定；口令错则库原封不动', async () => {
    const m = await enabled()
    assert.equal((await m.service.run('disable', { masterPassword: 'not-the-pass' })).reason, 'wrong-password')
    assert.notEqual(m.store.box.value, null)
    assert.equal((await m.service.run('disable', { masterPassword: PASS })).ok, true)
    assert.equal(m.store.box.value, null)
    assert.equal(m.service.isUnlocked(), false)
    assert.equal((await m.service.run('status')).enabled, false)
    assert.throws(() => m.service.withDek(() => 1), /vault is locked/)
  })

  it('恢复码也能停用（忘了主密码但想关掉）', async () => {
    const m = await enabled()
    await m.service.run('lock')
    assert.ok((await m.service.run('disable', { recoveryCode: m.recoveryCode })).ok)
    assert.equal(m.store.box.value, null)
  })

  it('没有库时停用是幂等的成功，不误报成失败', async () => {
    const { service } = make()
    const r = await service.run('disable', { masterPassword: PASS })
    assert.equal(r.ok, true)
    assert.equal(r.enabled, false)
  })

  it('停用后重新建库是一把新库（旧口令旧恢复码都不认）', async () => {
    const m = await enabled({ masterPassword: 'first-master' })
    const oldCode = m.recoveryCode
    await m.service.run('disable', { masterPassword: 'first-master' })
    const again = await m.service.run('enable', { masterPassword: 'second-master' })
    assert.ok(again.ok)
    assert.notEqual(again.recoveryCode, oldCode)
    assert.equal((await m.service.run('unlock', { masterPassword: 'first-master' })).reason, 'wrong-password')
    assert.equal((await m.service.run('unlockWithRecovery', { recoveryCode: oldCode })).reason, 'wrong-password')
    assert.ok((await m.service.run('unlock', { masterPassword: 'second-master' })).ok)
  })
})

describe('返回值与日志的泄漏面', () => {
  it('任何动作的返回都不含 DEK、主密码、恢复码原文（status/unlock/touch 全过一遍）', async () => {
    const masterPassword = 'leak-check-pass'
    const m = await enabled({ masterPassword })
    const dekHex = m.service.withDek((d) => d.toString('hex'))
    const results = []
    results.push(await m.service.run('status'))
    results.push(await m.service.run('touch'))
    results.push(await m.service.run('lock'))
    results.push(await m.service.run('unlock', { masterPassword }))
    results.push(await m.service.run('unlock', { masterPassword: 'wrong-one-here' }))
    results.push(await m.service.run('unlockWithRecovery', { recoveryCode: 'A'.repeat(52) }))
    results.push(await m.service.run('setAutoLock', { autoLockMin: 7 }))
    results.push(await m.service.run('changePassword', { masterPassword, newMasterPassword: 'next-leak-check' }))
    results.push(await m.service.run('enable', { masterPassword }))
    results.push(await m.service.run('disable', { masterPassword: 'wrong-one-here' }))
    results.push(await m.service.run('status'))
    const dump = JSON.stringify(results)
    assert.equal(dump.includes(dekHex), false)
    assert.equal(dump.includes(masterPassword), false)
    assert.equal(dump.includes(m.recoveryCode), false)
    assert.equal(dump.includes('vlt1:'), false, '包好的信封也不该随动作返回')
    // 失败消息里只有原因，没有口令
    assert.equal(dump.includes('wrong-one-here'), false)
  })

  it('日志只讲动作与结果，逐行都不含敏感串', async () => {
    const log = silentLog()
    const m = await enabled({ masterPassword: 'logged-pass-check', log })
    await m.service.run('unlock', { masterPassword: 'logged-pass-check' })
    await m.service.run('unlock', { masterPassword: 'nope-not-this' })
    await m.service.run('lock')
    const dump = log.lines.join('\n')
    assert.equal(dump.includes('logged-pass-check'), false)
    assert.equal(dump.includes('nope-not-this'), false)
    assert.equal(dump.includes(m.recoveryCode), false)
    assert.match(dump, /\[vault\] enable: ok/)
    assert.match(dump, /\[vault\] unlock: failed \(wrong-password\)/)
  })
})
