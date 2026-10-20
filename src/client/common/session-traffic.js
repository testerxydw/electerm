/**
 * 会话 ↑↓ 速率计数 (顶栏速率段唯一数据源):
 * - 挂接点仅 AttachAddonCustom 一处 (下行 onMsg / 上行 sendToServer),
 *   全部 session 类型 (ssh/local/telnet/serial) 自动生效
 * - 500ms 窗口计算字节速率写 store.sessionInfoMap[tabId].traffic,
 *   连续 2 个窗口无流量自动清零并停表 (无流量时段由组件隐藏)
 * - 字节口径: 字符串取 UTF-16 code unit 数 (str.length) 作为近似字节数,
 *   二进制帧取 byteLength/size; 速率展示场景无需精确 UTF-8 编码
 */

const DEFAULT_INTERVAL_MS = 500
// 连续无流量窗口数达到该值后清零并停表
const IDLE_WINDOWS_TO_CLEAR = 2

export function frameByteLength (data) {
  if (typeof data === 'string') {
    return data.length
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  if (data && typeof data.size === 'number') {
    return data.size
  }
  return 0
}

export default class SessionTrafficTracker {
  constructor ({ tabId, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.tabId = tabId
    this.intervalMs = intervalMs
    this.pendingUp = 0
    this.pendingDown = 0
    this.timer = null
    this.idleWindows = 0
  }

  countUp (data) {
    if (!this.tabId) {
      return
    }
    this.pendingUp += frameByteLength(data)
    this.ensureTimer()
  }

  countDown (data) {
    if (!this.tabId) {
      return
    }
    this.pendingDown += frameByteLength(data)
    this.ensureTimer()
  }

  ensureTimer () {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs)
  }

  tick () {
    const up = this.pendingUp
    const down = this.pendingDown
    this.pendingUp = 0
    this.pendingDown = 0
    const idle = up === 0 && down === 0
    this.idleWindows = idle ? this.idleWindows + 1 : 0
    if (this.idleWindows >= IDLE_WINDOWS_TO_CLEAR) {
      this.write({ up: 0, down: 0 })
      this.stopTimer()
      return
    }
    const seconds = this.intervalMs / 1000
    this.write({ up: Math.round(up / seconds), down: Math.round(down / seconds) })
  }

  write (traffic) {
    const { store } = window
    if (!store?.sessionInfoMap || !this.tabId) {
      return
    }
    store.sessionInfoMap[this.tabId] = {
      ...store.sessionInfoMap[this.tabId],
      traffic
    }
  }

  stopTimer () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  stop () {
    this.stopTimer()
    this.pendingUp = 0
    this.pendingDown = 0
  }
}
