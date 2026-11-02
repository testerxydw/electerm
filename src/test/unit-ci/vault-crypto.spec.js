/**
 * G6-1 主密码 Vault 的密钥层次（设计 阶段4 §14.7）
 *
 * 这里只验纯模块：主密码/恢复码 → KEK/REK → wrappedDek → DEK → 逐条凭据信封。
 * 三条验收口径各有一组用例：
 *   - 错误主密码不产生解密泄漏（拿不到明文，也拿不到 DEK）；
 *   - 恢复码能独立解出同一把 DEK；
 *   - config 里不含主密码、恢复码原文与裸 DEK。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

const v = require('../../app/common/vault-crypto')

// 单测统一用低成本 scrypt（N=1024）；默认参数的可用性另有专门一条用例
const fastKdf = { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 32 }

async function setup (opts = {}) {
  const masterPassword = opts.masterPassword === undefined ? 'correct horse' : opts.masterPassword
  const created = await v.createVault({
    masterPassword,
    recoveryCode: opts.recoveryCode,
    dek: opts.dek,
    kdf: fastKdf,
    autoLockMin: opts.autoLockMin
  })
  assert.ok(created.ok, 'createVault should succeed: ' + created.reason)
  return created
}

describe('KDF 参数', () => {
  it('用 §14.7 的 scrypt 参数，并把 maxmem 抬到能装下 N=2^15,r=8', () => {
    assert.equal(v.KDF.N, 32768)
    assert.equal(v.KDF.r, 8)
    assert.equal(v.KDF.p, 1)
    assert.equal(v.KDF.keylen, 32)
    // scrypt 内存约 128*N*r，Node 默认 maxmem 32MB 会直接抛错
    assert.ok(v.KDF.maxmem >= 128 * v.KDF.N * v.KDF.r)
  })

  it('默认参数真跑通一次（证明 maxmem 不是纸面数字）', async () => {
    const created = await v.createVault({ masterPassword: 'default-cost' })
    assert.ok(created.ok)
    const unlocked = await v.unlock('default-cost', created.config)
    assert.ok(unlocked.ok)
    assert.deepEqual(unlocked.dek, created.dek)
  })

  it('KDF 参数只给一部分也补齐（不让 undefined 进 crypto）', async () => {
    const created = await v.createVault({ masterPassword: 'partial-kdf', kdf: { N: 1024 } })
    assert.ok(created.ok, created.reason)
    const r = await v.unlock('partial-kdf', { ...created.config, kdf: { N: 1024 } })
    assert.ok(r.ok)
    assert.deepEqual(r.dek, created.dek)
  })
})

describe('信封 seal/open', () => {
  it('形状是 vlt1:<iv>:<tag>:<cipher>，能原样解回', () => {
    const key = crypto.randomBytes(32)
    const env = v.seal('postgres://u:p@h/db', key, v.AAD.dek)
    const parts = env.split(':')
    assert.equal(parts.length, 4)
    assert.equal(parts[0], v.PREFIX)
    assert.equal(parts[1].length, 24) // 12 字节 iv
    assert.equal(parts[2].length, 32) // 16 字节 tag
    assert.deepEqual(v.open(env, key, v.AAD.dek), { ok: true, value: 'postgres://u:p@h/db' })
  })

  it('同一明文同一把钥，两次信封不同（iv 每次随机）', () => {
    const key = crypto.randomBytes(32)
    assert.notEqual(v.seal('same', key, null), v.seal('same', key, null))
  })

  it('口令错：只回原因，不回任何明文', () => {
    const env = v.seal('secret-text', crypto.randomBytes(32), v.AAD.dek)
    const r = v.open(env, crypto.randomBytes(32), v.AAD.dek)
    assert.equal(r.ok, false)
    assert.equal(r.reason, v.FAIL.wrongPassword)
    assert.equal(r.value, undefined)
    assert.equal('value' in r, false)
  })

  it('密文被改过也解不出明文（GCM 认证挡住）', () => {
    const key = crypto.randomBytes(32)
    const env = v.seal('secret-text', key, v.AAD.dek)
    const parts = env.split(':')
    const body = parts[3]
    const flipped = (body[0] === '0' ? '1' : '0') + body.slice(1)
    const r = v.open([parts[0], parts[1], parts[2], flipped].join(':'), key, v.AAD.dek)
    assert.equal(r.ok, false)
    assert.equal(r.value, undefined)
  })

  it('结构不对判 corrupt，和"口令错"分开', () => {
    const key = crypto.randomBytes(32)
    const bad = [
      'not-an-envelope',
      'vlt1:ffff',
      'vlt1:ffff:ffff:ffff:ffff',
      'vlt1:zz:ffff:ffff:00',
      'vlt1:fff:ffff:ffff:ffff', // iv 奇数个 hex 字符
      'other:ffff:ffff:ffff:ffff'
    ]
    for (const s of bad) {
      const r = v.open(s, key, v.AAD.dek)
      assert.equal(r.ok, false, s)
      assert.equal(r.reason, v.FAIL.corrupt, s)
    }
    for (const s of [undefined, null, 42, {}]) {
      assert.equal(v.open(s, key, v.AAD.dek).reason, v.FAIL.corrupt)
    }
  })

  it('三个用途的 AAD 互不通用（同一条密文换不了用途）', () => {
    const key = crypto.randomBytes(32)
    const forDek = v.seal('wrapped-dek-payload', key, v.AAD.dek)
    assert.equal(v.open(forDek, key, v.AAD.verify).ok, false)
    assert.equal(v.open(forDek, key, v.AAD.rek).ok, false)
    assert.equal(v.open(forDek, key, null).ok, false)
    assert.deepEqual(v.open(forDek, key, v.AAD.dek), { ok: true, value: 'wrapped-dek-payload' })
    // 反过来：不带 AAD 封的也塞不进带 AAD 的位置
    const naked = v.seal('naked', key, null)
    assert.equal(v.open(naked, key, v.AAD.dek).ok, false)
  })

  it('AAD 域分隔：三种 AAD 值各不相同', () => {
    const set = new Set([v.AAD.dek.toString(), v.AAD.verify.toString(), v.AAD.rek.toString()])
    assert.equal(set.size, 3)
  })
})

describe('恢复码 Base32', () => {
  it('32 字节 → 52 个字符，能解回同一串字节', () => {
    const code = v.newRecoveryCode()
    assert.match(code, /^[A-Z2-7]+$/)
    assert.equal(code.length, 52)
    const bytes = v.base32Decode(code)
    assert.equal(bytes.length, 32)
    assert.equal(v.base32Encode(bytes), code)
  })

  it('用户怎么抄都认得：小写、空格、短横一律忽略', () => {
    const code = v.newRecoveryCode()
    const messy = code.toLowerCase().replace(/(.{5})(?=.)/g, '$1-')
    assert.equal(v.normalizeRecoveryCode(messy), code)
    assert.deepEqual(v.base32Decode(messy), v.base32Decode(code))
  })

  it('展示用每 5 个一组', () => {
    assert.equal(v.formatRecoveryCode('ABCDEFGHIJKLMNOPQRST'), 'ABCDE FGHIJ KLMNO PQRST')
    assert.equal(v.formatRecoveryCode(''), '')
    // 小写会归一成大写；1/8/9/0 不属于 Base32 字母表，也会被剔掉
    assert.equal(v.formatRecoveryCode('abcd1234EFGH'), 'ABCD2 34EFG H')
    assert.equal(v.formatRecoveryCode('abcdefg hijkl'), 'ABCDE FGHIJ KL')
    assert.equal(v.formatRecoveryCode(v.newRecoveryCode()).replace(/ /g, '').length, 52)
  })

  it('不是我们发出去的那串就拒绝', () => {
    const code = v.newRecoveryCode()
    assert.equal(v.base32Decode(''), null)
    assert.equal(v.base32Decode('!!!'), null)
    assert.equal(v.base32Decode(code.slice(0, 51)), null) // 少一位：凑不出整字节
    assert.equal(v.base32Decode(code.slice(0, 51) + 'B'), null) // 尾部余位非 0
    assert.equal(v.base32Decode(undefined), null)
    const longer = v.base32Decode(code + 'A') // 多一位：解出 33 字节，不是我们的库
    assert.equal(longer === null || longer.length !== 32, true)
  })
})

describe('建库 createVault', () => {
  it('config 里只有包好的东西：主密码、恢复码、裸 DEK 都不出现', async () => {
    const masterPassword = 'a-master-pass-123'
    const created = await setup({ masterPassword })
    const dump = JSON.stringify(created.config)
    assert.equal(dump.includes(masterPassword), false)
    assert.equal(dump.includes(created.recoveryCode), false)
    assert.equal(dump.includes(created.dek.toString('hex')), false)
    assert.equal(dump.includes(v.VERIFIER_PLAIN), false)
  })

  it('config 形态：v/salt/wrappedDek/verifier/recovery/autoLockMin 齐活', async () => {
    const created = await setup()
    assert.equal(created.config.v, v.VERSION)
    assert.equal(created.config.salt.length, 32)
    assert.ok(created.config.wrappedDek.startsWith(v.PREFIX + ':'))
    assert.ok(created.config.verifier.startsWith(v.PREFIX + ':'))
    assert.equal(created.config.recovery.salt.length, 32)
    assert.ok(created.config.recovery.wrappedDek.startsWith(v.PREFIX + ':'))
    assert.equal(created.config.autoLockMin, v.DEFAULT_AUTO_LOCK_MIN)
    assert.deepEqual(created.config.kdf, { N: fastKdf.N, r: fastKdf.r, p: fastKdf.p })
    assert.equal(v.isVaultConfig(created.config), true)
  })

  it('不传恢复码就自动生成，传了就用用户抄走的那一份', async () => {
    const code = v.newRecoveryCode()
    const a = await setup({ recoveryCode: code })
    assert.equal(a.recoveryCode, code)
    const b = await setup()
    assert.match(b.recoveryCode, /^[A-Z2-7]{52}$/)
  })

  it('太短的主密码直接拒，连 KDF 都不跑', async () => {
    for (const masterPassword of ['', 'abcdefg', 123, null]) {
      const r = await v.createVault({ masterPassword, kdf: fastKdf })
      assert.equal(r.ok, false)
      assert.equal(r.reason, v.FAIL.weakPassword)
      assert.equal(r.config, undefined)
    }
    assert.equal(v.MIN_MASTER_PASS, 8)
    assert.equal((await v.createVault({ masterPassword: '八个字符就足够了', kdf: fastKdf })).ok, true)
  })

  it('恢复码格式不对就拒（建库时校验，不等解锁才发现）', async () => {
    for (const recoveryCode of ['', 'abc', '!!!', v.newRecoveryCode().slice(0, 51)]) {
      const r = await v.createVault({ masterPassword: 'long-enough', recoveryCode, kdf: fastKdf })
      assert.equal(r.ok, false, JSON.stringify(recoveryCode))
      assert.equal(r.reason, v.FAIL.empty)
    }
  })

  it('每次建库的 salt 与 DEK 都是新的', async () => {
    const a = await setup()
    const b = await setup()
    assert.notEqual(a.config.salt, b.config.salt)
    assert.notEqual(a.config.recovery.salt, b.config.recovery.salt)
    assert.notEqual(a.dek.toString('hex'), b.dek.toString('hex'))
    assert.notEqual(a.config.wrappedDek, b.config.wrappedDek)
  })
})

describe('解锁 unlock', () => {
  it('对的主密码解出同一把 DEK', async () => {
    const created = await setup({ masterPassword: 'the-real-one' })
    const r = await v.unlock('the-real-one', created.config)
    assert.ok(r.ok)
    assert.deepEqual(r.dek, created.dek)
  })

  it('错的主密码：只回 wrong-password，DEK 一个字节都不给', async () => {
    const created = await setup({ masterPassword: 'the-real-one' })
    for (const wrong of ['', 'the-real-on', 'THE-REAL-ONE', 'the-real-one ', 42]) {
      const r = await v.unlock(wrong, created.config)
      assert.equal(r.ok, false, JSON.stringify(wrong))
      assert.equal(r.dek, undefined, JSON.stringify(wrong))
      assert.equal(r.reason, wrong === '' || wrong === 42 ? v.FAIL.empty : v.FAIL.wrongPassword)
    }
  })

  it('先看 verifier 再碰 wrappedDek：wrappedDek 坏了，错口令仍报 wrong-password', async () => {
    const created = await setup({ masterPassword: 'the-real-one' })
    const broken = { ...created.config, wrappedDek: 'vlt1:ffff:ffff:ffff:ffff' }
    assert.equal((await v.unlock('nope-not-it', broken)).reason, v.FAIL.wrongPassword)
    const good = await v.unlock('the-real-one', broken)
    assert.equal(good.ok, false)
    assert.equal(good.reason, v.FAIL.corrupt)
  })

  it('verifier 自己坏了判 corrupt（这库已经不可信）', async () => {
    const created = await setup()
    // 形状对（vlt1: 开头）但内里是碎的：这不能报成"口令错"，用户会一直试错口令
    const r = await v.unlock('correct horse', {
      ...created.config,
      verifier: v.PREFIX + ':ffff:ffff:ffff:ffff'
    })
    assert.equal(r.ok, false)
    assert.equal(r.reason, v.FAIL.corrupt)
  })

  it('verifier 解得出但不是那句固定串：照样判库不可信', async () => {
    const created = await setup()
    const kek = crypto.scryptSync('correct horse', Buffer.from(created.config.salt, 'hex'), 32, fastKdf)
    const forged = {
      ...created.config,
      verifier: v.seal('not-the-verifier-string', kek, v.AAD.verify)
    }
    const r = await v.unlock('correct horse', forged)
    assert.equal(r.ok, false)
    assert.equal(r.reason, v.FAIL.corrupt)
    // 把 dek 位上的信封塞进 verifier 位：认证不过。GCM 分不出"口令错"还是"被人挪了"，
    // 这里按口令错报（宁可对用户说"再试一次口令"，也不给攻击者一个区分信号）
    const cross = {
      ...created.config,
      verifier: v.seal(v.VERIFIER_PLAIN, kek, v.AAD.dek)
    }
    assert.equal((await v.unlock('correct horse', cross)).reason, v.FAIL.wrongPassword)
  })

  it('没有库/库形态不对：no-vault，不抛异常', async () => {
    for (const config of [undefined, null, {}, { v: 1 }, 'str', 42]) {
      const r = await v.unlock('correct horse', config)
      assert.equal(r.ok, false)
      assert.equal(r.reason, v.FAIL.noVault)
    }
    const created = await setup()
    const shapes = [
      { ...created.config, v: 2 },
      { ...created.config, salt: 'zz' },
      { ...created.config, salt: '' },
      { ...created.config, salt: undefined },
      { ...created.config, salt: 'g'.repeat(32) }, // 不是 hex
      { ...created.config, wrappedDek: 42 },
      { ...created.config, wrappedDek: '' },
      { ...created.config, verifier: null },
      { ...created.config, verifier: 'other:ffff:ffff:ffff:ffff' },
      { ...created.config, autoLockMin: 0 },
      { ...created.config, autoLockMin: 'abc' }
    ]
    for (const config of shapes) {
      assert.equal(v.isVaultConfig(config), false)
      assert.equal((await v.unlock('correct horse', config)).reason, v.FAIL.noVault)
    }
  })

  it('DEK 长度不对时不放行（hex 截断不是一把"短一点的密钥"）', async () => {
    const short = await setup({ dek: crypto.randomBytes(16) })
    assert.equal(v.isVaultConfig(short.config), true)
    const r = await v.unlock('correct horse', short.config)
    assert.equal(r.ok, false)
    assert.equal(r.reason, v.FAIL.corrupt)
  })

  it('换了 KDF 参数就解不出（参数记在 config 里，按 config 的来）', async () => {
    const created = await setup()
    const bumped = { ...created.config, kdf: { N: 2048, r: 8, p: 1 } }
    const r = await v.unlock('correct horse', bumped)
    assert.equal(r.ok, false)
    assert.equal(r.reason, v.FAIL.wrongPassword)
  })
})

describe('恢复码解锁 unlockWithRecovery', () => {
  it('恢复码独立解出同一把 DEK（不需要主密码）', async () => {
    const created = await setup({ masterPassword: 'the-real-one' })
    const r = await v.unlockWithRecovery(created.recoveryCode, created.config)
    assert.ok(r.ok)
    assert.deepEqual(r.dek, created.dek)
  })

  it('抄错的恢复码：wrong-password，不给 DEK', async () => {
    const created = await setup()
    const code = created.recoveryCode
    const typos = [code.slice(0, 51) + (code[51] === 'A' ? 'B' : 'A'), 'A'.repeat(52), 'a'.repeat(52)]
    for (const wrong of typos) {
      const r = await v.unlockWithRecovery(wrong, created.config)
      assert.equal(r.ok, false, wrong)
      assert.equal(r.reason, v.FAIL.wrongPassword)
      assert.equal(r.dek, undefined)
    }
  })

  it('长度不对先挡下：bad-recovery-code，不跑 scrypt 也不说成"主密码不对"', async () => {
    const created = await setup()
    const code = created.recoveryCode
    assert.equal(code.length, v.RECOVERY_CODE_LEN, '发出去的那串就是这个长度')
    // 走到 scrypt + GCM 只会回 wrong-password；回 bad-recovery-code 就是在这之前挡住了
    const short = code.slice(0, v.RECOVERY_CODE_LEN - 1)
    for (const recoveryCode of ['AAAAA-BBB', short, code + 'A']) {
      const r = await v.unlockWithRecovery(recoveryCode, created.config)
      assert.equal(r.ok, false, recoveryCode)
      assert.equal(r.reason, v.FAIL.badRecoveryCode, recoveryCode)
      assert.equal(r.dek, undefined)
    }
    // 只剩不可敲字符：归一完是空串，说的是"没填"而不是"长度不对"
    for (const recoveryCode of ['', '   ', '000000']) {
      assert.equal((await v.unlockWithRecovery(recoveryCode, created.config)).reason, v.FAIL.empty)
    }
  })

  it('空/没有 recovery 段：empty / no-vault', async () => {
    const created = await setup()
    assert.equal((await v.unlockWithRecovery('', created.config)).reason, v.FAIL.empty)
    assert.equal((await v.unlockWithRecovery('!!!', created.config)).reason, v.FAIL.empty)
    assert.equal(v.hasRecovery(created.config), true)
    const shapes = [
      undefined,
      { ...created.config, recovery: undefined },
      { ...created.config, recovery: {} },
      { ...created.config, recovery: { salt: 'zz', wrappedDek: created.config.recovery.wrappedDek } },
      { ...created.config, recovery: { salt: created.config.recovery.salt, wrappedDek: 'nope' } }
    ]
    for (const config of shapes) {
      assert.equal(v.hasRecovery(config), false)
      assert.equal((await v.unlockWithRecovery(created.recoveryCode, config)).reason, v.FAIL.noVault)
    }
    assert.equal((await v.unlockWithRecovery(created.recoveryCode, undefined)).reason, v.FAIL.noVault)
  })
})

describe('改主密码 changeMasterPassword', () => {
  it('新口令可解、旧口令失效，DEK 与恢复码那一份都不动', async () => {
    const created = await setup({ masterPassword: 'first-pass' })
    const changed = await v.changeMasterPassword('second-pass', created.config, created.dek)
    assert.ok(changed.ok)
    assert.notEqual(changed.config.salt, created.config.salt)
    assert.notEqual(changed.config.wrappedDek, created.config.wrappedDek)
    assert.notEqual(changed.config.verifier, created.config.verifier)
    assert.equal((await v.unlock('second-pass', changed.config)).dek.toString('hex'), created.dek.toString('hex'))
    assert.equal((await v.unlock('first-pass', changed.config)).reason, v.FAIL.wrongPassword)
    // 手里那串恢复码照样能用，不用重新抄
    assert.equal(changed.config.recovery, created.config.recovery)
    const byRecovery = await v.unlockWithRecovery(created.recoveryCode, changed.config)
    assert.equal(byRecovery.dek.toString('hex'), created.dek.toString('hex'))
  })

  it('换库后旧 DEK 信封失效，凭据要重新封（防止把新库配旧 DEK 用）', async () => {
    const created = await setup({ masterPassword: 'first-pass' })
    const other = crypto.randomBytes(32)
    const env = v.sealSecret('mysql://root@h/db', created.dek)
    assert.deepEqual(v.openSecret(env, created.dek), { ok: true, value: 'mysql://root@h/db' })
    assert.equal(v.openSecret(env, other).ok, false)
  })

  it('太短的新口令/没有库/DEK 来路不对都拒绝', async () => {
    const created = await setup()
    assert.equal((await v.changeMasterPassword('short', created.config, created.dek)).reason, v.FAIL.weakPassword)
    assert.equal((await v.changeMasterPassword('long-enough', undefined, created.dek)).reason, v.FAIL.noVault)
    for (const dek of [undefined, null, 'hex-string', crypto.randomBytes(16), crypto.randomBytes(33)]) {
      assert.equal((await v.changeMasterPassword('long-enough', created.config, dek)).reason, v.FAIL.corrupt)
    }
    const ok = await v.changeMasterPassword('long-enough', created.config, created.dek)
    assert.equal(ok.config.autoLockMin, created.config.autoLockMin)
    assert.equal(ok.config.v, v.VERSION)
  })
})

describe('逐条凭据 sealSecret/openSecret', () => {
  it('同一凭据两次加密的两个信封不同', async () => {
    const created = await setup()
    const plain = 'super-secret-password'
    const a = v.sealSecret(plain, created.dek)
    const b = v.sealSecret(plain, created.dek)
    assert.notEqual(a, b)
    assert.equal(v.openSecret(a, created.dek).value, plain)
    assert.equal(v.openSecret(b, created.dek).value, plain)
  })

  it('中文/特殊字符/空串都按 utf8 原样回来', async () => {
    const key = crypto.randomBytes(32)
    for (const plain of ['密码', 'p@ss:w0rd:with-colons', 'line1\nline2', '', 'emoji-\u{1F600}']) {
      assert.deepEqual(v.openSecret(v.sealSecret(plain, key), key), { ok: true, value: plain })
    }
  })

  it('拿别人的 DEK 打不开，也不吐明文', async () => {
    const a = await setup()
    const b = await setup()
    const env = v.sealSecret('tgfsom-prod-password', a.dek)
    const r = v.openSecret(env, b.dek)
    assert.equal(r.ok, false)
    assert.equal(r.value, undefined)
    assert.equal(String(JSON.stringify(r)).includes('tgfsom'), false)
  })

  it('解锁后的 DEK 直接可用于封凭据（端到端一条链）', async () => {
    const created = await setup({ masterPassword: 'chain-check' })
    const unlocked = await v.unlock('chain-check', created.config)
    const env = v.sealSecret('redis://:pw@host:6379', unlocked.dek)
    assert.notEqual(env, v.sealSecret('redis://:pw@host:6379', created.dek)) // 同一把钥，只是 iv 不同
    assert.equal(v.openSecret(env, created.dek).value, 'redis://:pw@host:6379')
  })
})

describe('zeroKey', () => {
  it('就地清零；非 Buffer 传进去不炸', () => {
    const buf = Buffer.from('deadbeef', 'hex')
    v.zeroKey(buf)
    assert.equal(buf.toString('hex'), '00000000')
    for (const x of [undefined, null, 'str', 42, {}]) {
      v.zeroKey(x)
    }
  })
})
