// G6-3：Vault 界面判据（纯函数）
//
// 钉的是"界面不许替主进程猜"：读库失败不能显示成"没启用"，错误原因认不出
// 不能编一句"操作失败"盖掉真因，锁着的时候不许发续期请求，没建库不许轮询磁盘。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MOD = path.join(__dirname, '../../client/common/vault-ui.js')

let mod
const load = async () => {
  if (!mod) {
    mod = await import(pathToFileURL(MOD).href)
  }
  return mod
}

/** 假 translate：命不中就回 key 本身，断言能直接看出漏了哪个词条 */
const tr = (key) => '[' + key + ']'

describe('状态判定', () => {
  it('没建库 / 建了但锁着 / 已解锁三种状态各自成立', async () => {
    const { vaultState, vaultStates, vaultStateKey } = await load()
    assert.equal(vaultState({ ok: true, enabled: false, unlocked: false }), vaultStates.off)
    assert.equal(vaultState({ ok: true, enabled: true, unlocked: false }), vaultStates.locked)
    assert.equal(vaultState({ ok: true, enabled: true, unlocked: true }), vaultStates.unlocked)
    assert.equal(vaultStateKey({ ok: true, enabled: true, unlocked: false }), 'vaultStateLocked')
    assert.equal(vaultStateKey({ ok: true, enabled: false }), 'vaultStateOff')
  })

  it('读库失败是"出错"，不是"没启用"（别把打不开说成没开过）', async () => {
    const { vaultState, vaultStateKey, vaultStates } = await load()
    const err = { ok: false, reason: 'store-unavailable', message: 'cannot read vault config' }
    assert.equal(vaultState(err), vaultStates.error)
    assert.equal(vaultStateKey(err), 'vaultStateError')
    assert.equal(vaultState(null), vaultStates.error)
    assert.equal(vaultState(undefined), vaultStates.error)
  })

  it('status 里 enabled 与 unlocked 互相矛盾时以 enabled 为准（锁着的库不可能没启用）', async () => {
    const { vaultState, vaultStates } = await load()
    assert.equal(vaultState({ ok: true, enabled: false, unlocked: true }), vaultStates.off)
  })
})

describe('错误原因翻译', () => {
  it('主进程回每个 reason 都有对应词条', async () => {
    const { vaultErrorText } = await load()
    const reasons = [
      'wrong-password', 'no-vault', 'corrupt', 'store-unavailable',
      'weak-password', 'bad-auto-lock', 'already-enabled', 'empty'
    ]
    for (const reason of reasons) {
      const text = vaultErrorText({ ok: false, reason, message: 'raw english' }, tr)
      assert.notEqual(text, 'raw english', reason + ' should be translated')
      assert.ok(text.startsWith('['), reason)
      assert.notEqual(text, '[vaultErrorGeneric]', reason)
    }
  })

  it('认不出的 reason 把主进程原文贴出来，不编一句"操作失败"', async () => {
    const { vaultErrorText, vaultErrorKey } = await load()
    assert.equal(vaultErrorKey('brand-new-reason'), '')
    assert.equal(
      vaultErrorText({ ok: false, reason: 'brand-new-reason', message: 'the real reason' }, tr),
      'the real reason'
    )
    // 连 message 都没有时至少要说清是哪条原因，不能回空串让界面显示一片空白
    assert.equal(vaultErrorText({ ok: false, reason: 'brand-new-reason' }, tr), 'brand-new-reason')
  })

  it('成功没有错误文案（空串，不是 undefined）', async () => {
    const { vaultErrorText } = await load()
    assert.equal(vaultErrorText({ ok: true }, tr), '')
    assert.equal(vaultErrorText(null, tr), '')
  })
})

describe('输入是否值得发出去', () => {
  it('换密码/停用要先有凭据：口令和恢复码都没有就置灰', async () => {
    const { hasCredential } = await load()
    assert.equal(hasCredential({ masterPassword: 'p' }), true)
    assert.equal(hasCredential({ recoveryCode: 'AAAAA' }), true)
    assert.equal(hasCredential({ masterPassword: '' }), false)
    assert.equal(hasCredential({ masterPassword: '', recoveryCode: '' }), false)
    assert.equal(hasCredential({}), false)
    assert.equal(hasCredential(null), false)
  })

  it('两次输入要一致才算数：空串不算"一致"（否则没填也能提交）', async () => {
    const { passwordsAgree } = await load()
    assert.equal(passwordsAgree('abc', 'abc'), true)
    assert.equal(passwordsAgree('abc', 'abd'), false)
    assert.equal(passwordsAgree('', ''), false)
    assert.equal(passwordsAgree(undefined, undefined), false)
  })
})

describe('恢复码展示', () => {
  it('五个一组、空格分隔；大小写与分隔符都先归一', async () => {
    const { groupRecoveryCode } = await load()
    assert.equal(groupRecoveryCode('ABCDE FGHIJ KLMNO'), 'ABCDE FGHIJ KLMNO')
    assert.equal(groupRecoveryCode('abcdefghijklmno'), 'ABCDE FGHIJ KLMNO')
    assert.equal(groupRecoveryCode('abcdefghijklmnop'), 'ABCDE FGHIJ KLMNO P')
    assert.equal(groupRecoveryCode('ABCD234EFGH'), 'ABCD2 34EFG H')
  })

  it('字母表外（0/1/8/9）不属于这套编码：归一后剩什么展示什么，不假装它是合法码', async () => {
    const { groupRecoveryCode } = await load()
    assert.equal(groupRecoveryCode('1890'), '')
    assert.equal(groupRecoveryCode(''), '')
    assert.equal(groupRecoveryCode(null), '')
    assert.equal(groupRecoveryCode('AB1CD'), 'ABCD')
  })
})

describe('续期与轮询时机', () => {
  it('锁着不发 touch；解锁后才发，且两次至少隔 60s', async () => {
    const { shouldTouch, touchIntervalMs } = await load()
    assert.equal(shouldTouch({ unlocked: false, now: 0 }), false)
    assert.equal(shouldTouch({ unlocked: true, now: 0 }), true)
    assert.equal(shouldTouch({ unlocked: true, now: 1000, last: 1000 }), false)
    assert.equal(shouldTouch({ unlocked: true, now: 1000 + touchIntervalMs - 1, last: 1000 }), false)
    assert.equal(shouldTouch({ unlocked: true, now: 1000 + touchIntervalMs, last: 1000 }), true)
    assert.equal(touchIntervalMs, 60 * 1000)
  })

  it('时间不可用（NaN/undefined）时不发，也不抛', async () => {
    const { shouldTouch } = await load()
    assert.equal(shouldTouch({ unlocked: true, now: undefined, last: 0 }), false)
    assert.equal(shouldTouch({ unlocked: true }), false)
  })

  it('没建库不轮询；建了库（含读库失败）才轮询', async () => {
    const { shouldPoll, statusPollMs } = await load()
    assert.equal(shouldPoll({ ok: true, enabled: false }), false)
    assert.equal(shouldPoll({ ok: true, enabled: true, unlocked: true }), true)
    assert.equal(shouldPoll({ ok: false, reason: 'store-unavailable' }), true)
    assert.equal(statusPollMs, 60 * 1000)
  })

  it('启动只在"建了库且锁着"时弹解锁；没建库和已解锁都不弹', async () => {
    const { shouldPromptAtStart } = await load()
    assert.equal(shouldPromptAtStart({ ok: true, enabled: true, unlocked: false }), true)
    assert.equal(shouldPromptAtStart({ ok: true, enabled: true, unlocked: true }), false)
    assert.equal(shouldPromptAtStart({ ok: true, enabled: false }), false)
    // 读库失败也不算"锁着"：那时口令解不了任何东西，弹窗只是误导
    assert.equal(shouldPromptAtStart({ ok: false, reason: 'store-unavailable' }), false)
  })

  it('自动锁档位都是主进程认可范围内的整数分钟', async () => {
    const { autoLockPresets } = await load()
    const { MIN_AUTO_LOCK_MIN, MAX_AUTO_LOCK_MIN } = require('../../app/lib/vault')
    for (const m of autoLockPresets) {
      assert.ok(Number.isInteger(m), String(m))
      assert.ok(m >= MIN_AUTO_LOCK_MIN && m <= MAX_AUTO_LOCK_MIN, String(m))
    }
    assert.ok(autoLockPresets.includes(15), 'default 15 should be a preset')
  })
})

describe('控件取值', () => {
  // 这一条钉的是真机上的"主密码打不进字"：antd 输入框 onChange 给事件，
  // rc-input 还会把事件的 target 换成克隆节点；取 value 只能剥一层，
  // 剥到第二层拿到 undefined → state 永远空 → 受控 input 立刻被 React 还原成 ''。
  it('事件只剥一层：e.target.value 就是控件的值', async () => {
    const { fieldValue } = await load()
    const target = { value: 'master-pass', target: undefined }
    assert.equal(fieldValue({ type: 'change', target }), 'master-pass')
  })

  it('rc-input 的克隆 target（target 上没有再一层 target）也照样取到', async () => {
    const { fieldValue } = await load()
    // resolveOnChange 造的新事件：target 是克隆出来的 input 节点，本身没有 .target
    const cloned = { value: 'abcdef', tagName: 'INPUT' }
    assert.equal(fieldValue({ target: cloned }), 'abcdef')
  })

  it('非事件控件原样返回：数字、布尔、空串、0 都不许被吞', async () => {
    const { fieldValue } = await load()
    assert.equal(fieldValue(30), 30)
    assert.equal(fieldValue(0), 0)
    assert.equal(fieldValue(false), false)
    assert.equal(fieldValue(''), '')
    assert.equal(fieldValue(undefined), undefined)
    assert.equal(fieldValue(null), null)
  })
})
