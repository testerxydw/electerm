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

// 切走多久之后挂起。太短会让"切去看一眼就回来"变成重连，太长省不下内存。
export const suspendGraceMs = 30000

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
  constructor ({ onSuspend, onResume, graceMs = suspendGraceMs }) {
    this.onSuspend = onSuspend
    this.onResume = onResume
    this.graceMs = graceMs
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
    this.timer = setTimeout(() => {
      this.timer = null
      this.suspended = true
      this.onSuspend()
    }, this.graceMs)
  }

  stop () {
    clearTimeout(this.timer)
    this.timer = null
  }
}
