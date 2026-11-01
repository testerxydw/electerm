/**
 * G6-3 主密码 Vault 的界面判据（纯函数）
 *
 * 界面只回答三件事：现在是什么状态、主进程回的原因该翻成哪句人话、什么时候
 * 该给主进程续期。口令强度、自动锁范围这些"安全口径"一律留在主进程：同一条
 * 规则在渲染层再写一遍，将来只会有一遍是对的。
 */

export const vaultStates = {
  error: 'error',
  off: 'off',
  locked: 'locked',
  unlocked: 'unlocked'
}

/** 主进程按 reason 回错，界面按 reason 找词条；认不出的把原文贴出来，别编一句"操作失败"盖掉真因 */
const errorKeyMap = {
  'wrong-password': 'vaultWrongPassword',
  'no-vault': 'vaultNoVault',
  corrupt: 'vaultCorrupt',
  'store-unavailable': 'vaultStoreUnavailable',
  'weak-password': 'vaultWeakPassword',
  'bad-auto-lock': 'vaultBadAutoLock',
  'already-enabled': 'vaultAlreadyEnabled',
  empty: 'vaultNeedCredential'
}

/**
 * 读库失败是第四种状态，不能并进"没启用"：
 * 并进 off 会让用户以为保险库从没开过，而真实情况是库在磁盘上但打不开。
 */
export function vaultState (status) {
  if (!status || status.ok === false) {
    return vaultStates.error
  }
  if (!status.enabled) {
    return vaultStates.off
  }
  return status.unlocked ? vaultStates.unlocked : vaultStates.locked
}

export function vaultStateKey (status) {
  const s = vaultState(status)
  if (s === vaultStates.error) {
    return 'vaultStateError'
  }
  return 'vaultState' + s.charAt(0).toUpperCase() + s.slice(1)
}

export function vaultErrorKey (reason) {
  return errorKeyMap[reason] || ''
}

/** translate 由调用方注入，界面里不留 window.translate */
export function vaultErrorText (result, translate) {
  if (!result || result.ok) {
    return ''
  }
  const key = errorKeyMap[result.reason]
  return key ? translate(key) : (result.message || String(result.reason))
}

/** 换密码/停用要先证明自己是谁；两个都不给就别发请求（主进程也会拒，但按钮该先置灰） */
export function hasCredential (value) {
  return !!(value && (value.masterPassword || value.recoveryCode))
}

/** 两次输入不一致是打错字，不是安全问题：只在离开输入框/提交前判这一条 */
export function passwordsAgree (a, b) {
  return !!a && a === b
}

/**
 * 恢复码按 5 个一组显示（跟主进程 formatRecoveryCode 同一口径）。
 * 字母表只有 A–Z2–7：0/1/8/9 在这套编码里不存在，抄错了也归不进组。
 */
export function groupRecoveryCode (code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  if (!clean) {
    return ''
  }
  return (clean.match(/.{1,5}/g) || []).join(' ')
}

/** 闲置计时是分钟级，60s 续一次就够；锁着不发，发了也只是让主进程回一句 unlocked:false */
export const touchIntervalMs = 60 * 1000

export function shouldTouch ({ unlocked, now, last, intervalMs = touchIntervalMs }) {
  if (!unlocked) {
    return false
  }
  if (typeof now !== 'number') {
    return false
  }
  return typeof last !== 'number' || now - last >= intervalMs
}

/** 没建库就不轮询：每 60s 读一次磁盘只为确认"还是没开"，是白烧 */
export const statusPollMs = 60 * 1000

export function shouldPoll (status) {
  return vaultState(status) !== vaultStates.off
}

/**
 * 启动时该不该弹解锁：建了库且正锁着（设计 §14.7）。
 * 阶段① 弹了也允许取消——此刻还没有任何凭据走 vault，拦住整个应用只是讨打；
 * 阶段② 上了迁移再收紧成"不解锁不能新建连接"。
 */
export function shouldPromptAtStart (status) {
  return vaultState(status) === vaultStates.locked
}

/** 自动锁的可选档（分钟）；超出这些档就走输入框，主进程才是权威 */
export const autoLockPresets = [5, 15, 30, 60, 240, 1440]
