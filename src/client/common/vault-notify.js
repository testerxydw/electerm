/**
 * 保险库"状态变了"的通知（G6-3）
 *
 * 只递一句话——"你该重新问主进程"，不搬状态本身：主进程才是唯一权威。
 * source 是发通知的组件自己挑的串，接收方拿它避免"自己通知自己再读一遍"。
 * 设置页和底栏锁头是两个各自读 status 的组件，而 'off' 态不轮询（每 60s 读盘
 * 只为确认"还是没开"，是白烧）。没有这条通知，建完库底栏要等应用重启才出现锁头。
 */
const listeners = new Set()

export function onVaultChange (fn) {
  if (typeof fn !== 'function') {
    return () => false
  }
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyVaultChange (source) {
  for (const fn of [...listeners]) {
    try {
      fn(source)
    } catch (err) {
      // 一个监听者读盘失败不能带走别的监听者，更不能把发起动作的那次提交拖崩
      console.warn('vault notify listener failed:', err)
    }
  }
  return listeners.size
}
