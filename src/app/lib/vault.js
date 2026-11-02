/**
 * G6-2 主密码 Vault 的主进程服务（设计 阶段4 §14.7 阶段①：只读解锁）
 *
 * 这一层只管"库的状态"：建库、解锁、锁定、换主密码、自动锁、停用。
 * 阶段① 明确不动凭据的落盘路径（书签还是走 safeStorage 那套），所以这里
 * 既没有 sealSecret 也没有迁移——先把"能解锁/能锁/能校验"独立验掉，
 * 确认不破坏现有用户，阶段② 再把写入切过来（用 withDek 交钥匙）。
 *
 * 三条硬口径：
 * - DEK 只在内存：不进返回值、不进日志、不下给渲染层；锁定就是 zeroKey + 置空；
 * - 主密码/恢复码是渲染层传进来的字符串，本层只透传给密钥层次模块，
 *   绝不打印，也绝不拼进任何错误消息；
 * - 落盘的只有 config（全是"包好的东西"）；恢复码只在建库那一次返回，
 *   之后主进程不再留它的原文。
 */
const vc = require('../common/vault-crypto')

const DEFAULT_AUTO_LOCK_MIN = vc.DEFAULT_AUTO_LOCK_MIN
const MIN_AUTO_LOCK_MIN = 1
const MAX_AUTO_LOCK_MIN = 24 * 60
const STORE_FAIL = 'store-unavailable'

function fail (reason, message) {
  return { ok: false, reason, message }
}

/**
 * @param {object} deps
 * @param {{read: () => any, write: (config|null) => void}} deps.store vault config 的读写
 * @param {() => number} [deps.now] 注入时钟，自动锁的到期判定靠它
 * @param {object} [deps.log] 只记动作与原因，不记口令
 * @param {object} [deps.kdf] 建库时的 scrypt 参数（单测用低成本参数）
 */
function createVaultService (deps = {}) {
  const store = deps.store
  const now = deps.now || (() => Date.now())
  const log = deps.log || console
  const kdf = deps.kdf
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error('vault service needs a { read, write } store')
  }

  let dek = null
  let unlockedUntil = 0

  // 读库失败与"没有库"是两件事：前者必须报出来，不能让上层以为没启用就没事了
  function read () {
    let raw = null
    try {
      raw = store.read()
    } catch (e) {
      return { err: fail(STORE_FAIL, 'cannot read vault config: ' + e.message) }
    }
    return { config: vc.isVaultConfig(raw) ? raw : null }
  }

  function write (config) {
    try {
      store.write(config)
      return null
    } catch (e) {
      return fail(STORE_FAIL, 'cannot write vault config: ' + e.message)
    }
  }

  // 口令与恢复码只出现在参数里；这一行的全部职责是"别让它出现在输出里"
  function trace (action, result) {
    const tag = result && result.ok ? 'ok' : 'failed (' + (result && result.reason) + ')'
    log.info('[vault] ' + action + ': ' + tag)
  }

  function clearKey () {
    if (dek) {
      vc.zeroKey(dek)
    }
    dek = null
    unlockedUntil = 0
  }

  function armed () {
    return !!dek && now() < unlockedUntil
  }

  function arm () {
    const { config } = read()
    unlockedUntil = config ? now() + Number(config.autoLockMin) * 60 * 1000 : 0
  }

  // 到期不只是"读出来 locked"：顺手把钥匙抹掉，别让下一句 touch 又把它救回来
  function expireIfDue () {
    if (dek && !armed()) {
      clearKey()
    }
  }

  function status () {
    expireIfDue()
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return {
        ok: true,
        enabled: false,
        unlocked: false,
        autoLockMin: DEFAULT_AUTO_LOCK_MIN,
        hasRecovery: false,
        legacyWrite: false,
        migrating: false
      }
    }
    return {
      ok: true,
      enabled: true,
      unlocked: armed(),
      autoLockMin: Number(config.autoLockMin),
      hasRecovery: vc.hasRecovery(config),
      // 阶段②：legacyWrite 是回滚开关，migrating 表示迁移没跑完
      legacyWrite: !!config.legacyWrite,
      migrating: !!config.migrating
    }
  }

  function normalizeAutoLock (min) {
    const n = Number(min)
    if (!Number.isFinite(n)) {
      return { err: fail('bad-auto-lock', 'autoLockMin must be a number') }
    }
    const v = Math.floor(n)
    if (v < MIN_AUTO_LOCK_MIN || v > MAX_AUTO_LOCK_MIN) {
      return { err: fail('bad-auto-lock', 'autoLockMin must be between ' + MIN_AUTO_LOCK_MIN + ' and ' + MAX_AUTO_LOCK_MIN) }
    }
    return { value: v }
  }

  async function enable (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (config) {
      return traceOut('enable', fail('already-enabled', 'vault is already enabled'))
    }
    const lock = normalizeAutoLock(arg.autoLockMin === undefined ? DEFAULT_AUTO_LOCK_MIN : arg.autoLockMin)
    if (lock.err) {
      return traceOut('enable', lock.err)
    }
    // scrypt 参数只认这里（测试注入），绝不认渲染层传来的 arg.kdf：
    // 走 IPC 的东西都能被改，让调用方挑参数等于把暴力破解成本交到对面手里
    const created = await vc.createVault({
      masterPassword: arg.masterPassword,
      autoLockMin: lock.value,
      kdf
    })
    if (!created.ok) {
      return traceOut('enable', fail(created.reason, 'cannot create vault: ' + created.reason))
    }
    const w = write({ ...created.config, legacyWrite: false, migrating: false })
    if (w) {
      clearKey()
      return w
    }
    clearKey()
    dek = created.dek
    arm()
    // 恢复码只在这里出现一次：主进程不留原文，用户不抄就没有第二条解锁路
    return traceOut('enable', { ok: true, recoveryCode: created.recoveryCode, autoLockMin: lock.value })
  }

  async function unlock (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('unlock', fail('no-vault', 'vault is not enabled'))
    }
    const got = await vc.unlock(arg.masterPassword, config)
    if (!got.ok) {
      clearKey()
      return traceOut('unlock', fail(got.reason, 'unlock failed: ' + got.reason))
    }
    clearKey()
    dek = got.dek
    arm()
    return traceOut('unlock', { ok: true, unlocked: true })
  }

  async function unlockWithRecovery (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('unlockWithRecovery', fail('no-vault', 'vault is not enabled'))
    }
    const got = await vc.unlockWithRecovery(arg.recoveryCode, config)
    if (!got.ok) {
      clearKey()
      return traceOut('unlockWithRecovery', fail(got.reason, 'recovery unlock failed: ' + got.reason))
    }
    clearKey()
    dek = got.dek
    arm()
    // 恢复码解出来的是临时可用：主密码还是没设过，界面要照着这个提示走
    return traceOut('unlockWithRecovery', { ok: true, unlocked: true, needsNewPassword: true })
  }

  function lock () {
    clearKey()
    return traceOut('lock', { ok: true, unlocked: false })
  }

  /** 用户还在用（面板打开、新建连接）就把到期时间往后推；锁着推了也没用 */
  function touch () {
    expireIfDue()
    if (!armed()) {
      return { ok: true, unlocked: false }
    }
    arm()
    return { ok: true, unlocked: true }
  }

  /**
   * 换主密码。这里要求"当场证明自己是谁"（主密码或恢复码），
   * 不接受"已经解锁了就免检"——当前这点解锁状态可能来自恢复码那次临时解锁。
   */
  async function changePassword (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('changePassword', fail('no-vault', 'vault is not enabled'))
    }
    const current = await proveIdentity(config, arg)
    if (!current.ok) {
      return traceOut('changePassword', current)
    }
    const changed = await vc.changeMasterPassword(arg.newMasterPassword, config, current.dek)
    if (!changed.ok) {
      vc.zeroKey(current.dek)
      return traceOut('changePassword', fail(changed.reason, 'cannot change master password: ' + changed.reason))
    }
    const w = write(changed.config)
    if (w) {
      vc.zeroKey(current.dek)
      return w
    }
    // 换的只是包 DEK 的那层 KEK，DEK 本身没变：手里这把钥匙继续有效，会话不断
    if (dek !== current.dek) {
      clearKey()
      dek = current.dek
    }
    arm()
    return traceOut('changePassword', { ok: true, unlocked: armed() })
  }

  async function setAutoLock (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('setAutoLock', fail('no-vault', 'vault is not enabled'))
    }
    const lock = normalizeAutoLock(arg.autoLockMin)
    if (lock.err) {
      return traceOut('setAutoLock', lock.err)
    }
    const w = write({ ...config, autoLockMin: lock.value })
    if (w) {
      return w
    }
    // 改小了就立刻按新值重算，别等下一次动作才发现还按旧的宽限
    if (armed()) {
      arm()
    }
    return traceOut('setAutoLock', { ok: true, autoLockMin: lock.value })
  }

  /**
   * 阶段② 的回滚开关：打开后新凭据仍走旧格式（safeStorage），已有 `_vault` 不动。
   * 只改 config，不解锁也不碰钥匙。
   */
  function setLegacyWrite (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('setLegacyWrite', fail('no-vault', 'vault is not enabled'))
    }
    const value = !!arg.value
    const w = write({ ...config, legacyWrite: value })
    if (w) {
      return w
    }
    return traceOut('setLegacyWrite', { ok: true, legacyWrite: value })
  }

  /**
   * 迁移标记：真正搬数据由 vault-instance 做（服务层不碰 DB）。
   * 中断后重启靠这个标记让界面知道"还有批次没跑完"。
   */
  function markMigrating (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return traceOut('markMigrating', fail('no-vault', 'vault is not enabled'))
    }
    const value = !!arg.value
    const w = write({ ...config, migrating: value })
    if (w) {
      return w
    }
    return traceOut('markMigrating', { ok: true, migrating: value })
  }

  /**
   * 停用。阶段① 没有任何凭据写在库里，所以证明身份后抹掉 config 就是干净收场。
   * 阶段② 上了迁移以后，停用前必须先把 `_vault` 反解回旧格式，
   * 那一步由 vault-instance 在调用本方法前完成。
   */
  async function disable (arg = {}) {
    const { config, err } = read()
    if (err) {
      return err
    }
    if (!config) {
      return { ok: true, enabled: false, unlocked: false }
    }
    const current = await proveIdentity(config, arg)
    if (!current.ok) {
      return traceOut('disable', current)
    }
    const w = write(null)
    vc.zeroKey(current.dek)
    clearKey()
    if (w) {
      return w
    }
    return traceOut('disable', { ok: true, enabled: false, unlocked: false })
  }

  function proveIdentity (config, arg) {
    if (typeof arg.masterPassword === 'string' && arg.masterPassword) {
      return vc.unlock(arg.masterPassword, config)
    }
    if (typeof arg.recoveryCode === 'string' && arg.recoveryCode) {
      return vc.unlockWithRecovery(arg.recoveryCode, config)
    }
    return Promise.resolve(fail('empty', 'masterPassword or recoveryCode is required'))
  }

  function traceOut (action, result) {
    trace(action, result)
    return result
  }

  const handlers = {
    status,
    enable,
    unlock,
    unlockWithRecovery,
    lock,
    touch,
    changePassword,
    setAutoLock,
    setLegacyWrite,
    markMigrating,
    disable
  }

  // 渲染层唯一入口：action 必须是自己身上的方法名。
  // 不用 handlers[action] 直接取——'constructor' 这类原型链上的东西也是函数，
  // 取到就变成"能调用 Object(...)"，白名单要按 own property 判（同 ipc.js 的口径）。
  function run (action, arg) {
    const h = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null
    if (typeof h !== 'function') {
      return Promise.resolve(fail('unknown-action', 'unknown vault action: ' + String(action)))
    }
    return Promise.resolve(h(arg || {}))
  }

  return {
    run,
    status,
    isUnlocked () {
      expireIfDue()
      return armed()
    },
    /**
     * 阶段② 的写入路径从这里取钥匙；DEK 不出这个闭包、不过 IPC。
     * 锁定时抛错，调用方必须先解锁，不能"顺手降级成明文"。
     */
    withDek (fn) {
      expireIfDue()
      if (!armed()) {
        throw new Error('vault is locked')
      }
      return fn(dek)
    }
  }
}

module.exports = {
  createVaultService,
  DEFAULT_AUTO_LOCK_MIN,
  MIN_AUTO_LOCK_MIN,
  MAX_AUTO_LOCK_MIN
}
