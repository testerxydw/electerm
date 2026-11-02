/**
 * G6 T4：跨组件的"请求解锁"通道（纯 ESM，无 React、无 electron）
 *
 * store 的连接入口不知道解锁弹窗挂在哪个组件上，只能发一句"该解锁了"，
 * 由底栏锁头弹窗负责问用户拿口令。这里只搬运"要不要解锁"这一个布尔结果。
 *
 * 为什么只允许一个 pending：连接入口可能被连点、被 MCP 批量触发，每次请求都
 * 开一个 Promise 会让同一次弹窗回三个方向的结果。后来的请求复用同一个 Promise，
 * 监听者也只收到一次（弹窗只需开一次）。
 *
 * 取消时 resolve(false) 而不是 reject：调用方 await 的是一句"解没解锁"，
 * 用户关掉弹窗是正常路径，不是异常；reject 会在 store 里制造没人接的失败。
 */
const listeners = new Set()

let pending = null
let resolvePending = null

export function onUnlockRequest (fn) {
  if (typeof fn !== 'function') {
    return () => false
  }
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function requestUnlock () {
  // 已有请求在等用户：同一次弹窗的所有调用方共用这一个结果
  if (pending) {
    return pending
  }
  if (!listeners.size) {
    return Promise.resolve(false)
  }
  pending = new Promise(resolve => {
    resolvePending = resolve
  })
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (err) {
      // 一个监听者抛错不能把"该弹窗了"的通知吞掉，调用方的 await 会永远挂着
      console.warn('vault unlock request listener failed:', err)
    }
  }
  return pending
}

export function settleUnlock (ok) {
  if (!pending) {
    return false
  }
  // 先摘掉 pending 再 resolve：结果回来那一刻如果又有人请求解锁，应该开新的一轮，
  // 而不是拿到一个已经 resolve 的旧 Promise
  const resolve = resolvePending
  pending = null
  resolvePending = null
  resolve(!!ok)
  return true
}
