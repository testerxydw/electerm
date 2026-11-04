/**
 * 隐藏远程 tab 的挂起器（VNC / RDP / SPICE 共用）。
 *
 * 为什么要挂起：这三类会话在 tab 被切走后并不会停 —— `session-wrap` 只是
 * `display:none`（`src/client/components/session/session.styl`），组件不卸载，
 * ws 继续全速推帧。实测（`self-test/vnc-mem-probe.js`，见分析文档 §7）：
 * 3.3MB/s 的 336 tile/帧 JPEG 流 4 秒就能把 noVNC 的接收缓冲顶到 40MiB 上限，
 * 之后 `_flushing` 恒为真、瓦片解码队列 314 条永不排空 —— 也就是说"看不见的画面"
 * 和"看得见的画面"一样贵。
 *
 * 所以：切走超过宽限期就断掉连接并归零画布，切回来时自动重连。
 * 宽限期是权衡的结果 —— 用户来回切 tab（查终端、看文件）不该触发 1–2 秒的重连。
 */

// 切走多久之后挂起（毫秒）的默认值。太短会让"切去看一眼就回来"变成重连，
// 太长省不下内存。默认 5 分钟：覆盖"去查别的 tab、回个消息"这类常见离开，
// 又不会让隐藏的 VNC/RDP/SPICE 空转太久（M6 实测：隐藏也在全速收帧）。
export const suspendGraceDefaultMs = 5 * 60 * 1000

// 读当前配置的挂起宽限期（秒）。config 没有这个键时回到默认 5 分钟。
// 三端 remote 组件不在 manate 订阅范围内，不会随 config 版本自动重渲染，
// 所以宽限期必须在这里"到点才读"，而不是构造时读一次写死 ——
// 用户改完档位，下一次切走就用新值。
export function suspendGraceMs () {
  const sec = window.store?.config?.remoteSuspendSeconds
  // 0/负数是异常值（setTimeout(fn, 0) 会立即挂起），与缺失同样回默认
  return (!Number.isFinite(sec) || sec <= 0)
    ? suspendGraceDefaultMs
    : sec * 1000
}

/**
 * 这个 tab 现在是不是它所在批次的当前 tab。
 *
 * 信号缺失（`currentBatchTabId` 没下发到这一层）时必须当成"激活"：
 * 否则 props 管道一旦断，正在看的会话会被静默挂起，比泄漏更难查。
 */
export function isTabActive (props) {
  const { currentBatchTabId, tab } = props || {}
  if (currentBatchTabId === undefined || currentBatchTabId === null) {
    return true
  }
  return tab?.id === currentBatchTabId
}

export default class RemoteSuspend {
  constructor ({ onSuspend, onResume }) {
    this.onSuspend = onSuspend
    this.onResume = onResume
    this.timer = null
    this.suspended = false
  }

  update (active) {
    clearTimeout(this.timer)
    this.timer = null
    if (active) {
      if (this.suspended) {
        this.suspended = false
        this.onResume()
      }
      return
    }
    if (this.suspended) {
      return
    }
    // 到点才读当前宽限期：见 suspendGraceMs 的注释
    this.timer = setTimeout(() => {
      this.timer = null
      this.suspended = true
      this.onSuspend()
    }, suspendGraceMs())
  }

  stop () {
    clearTimeout(this.timer)
    this.timer = null
  }
}
