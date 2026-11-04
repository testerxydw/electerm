/**
 * 挂起 / 重连间隙的"末帧冻结"覆盖层。
 *
 * 背景：远程标签被挂起（隐藏超过宽限期，或开启即时挂起）时要断开连接回收内存，
 * 但 noVNC / IronRDP / spice-html5 都没有"保留连接仅暂停渲染"的原生 API ——
 * 断连后画布会被清零或被协议重建（noVNC 的 new RFB 会新建 canvas 并摘掉旧的那张），
 * 于是切回标签时画面先空白 1~2 秒（重连 + 首帧到达）才"啪"地出现，观感很差。
 *
 * 这里在挂起瞬间把"当前帧"快照到一张独立覆盖 canvas 上，切回重连期间盖住下方的
 * 空白，连接成功后再撤掉 —— 用户看到的是"最后一帧 → 平滑更新"，而非黑屏闪烁。
 * 覆盖层是独立 DOM 节点，不受协议重建画布的影响，三端（VNC/RDP/SPICE）通用。
 *
 * 内存：覆盖层只持有一张末帧位图（约 9MB @ 2048x1152），相比断连回收掉的会话进程
 * （~115MB）与解码缓冲可以忽略；且 unfreezeFrame 会立即把覆盖层宽高归零释放。
 */

// 覆盖层 canvas 的样式：绝对定位铺满容器、默认隐藏、不拦截鼠标、等比 letterbox。
export const FROZEN_OVERLAY_STYLE = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  display: 'none',
  zIndex: 5,
  objectFit: 'contain',
  pointerEvents: 'none',
  background: '#000'
}

// 把源 canvas 的当前内容快照到 overlay（覆盖层 canvas）。返回是否成功。
// sourceOverlay 为 null / 源尺寸为 0 时视为无可快照帧，直接返回 false（不显示覆盖层）。
export function freezeFrame (sourceCanvas, overlay) {
  if (!sourceCanvas || !overlay) return false
  const w = sourceCanvas.width
  const h = sourceCanvas.height
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return false
  }
  try {
    overlay.width = w
    overlay.height = h
    const ctx = overlay.getContext('2d')
    if (!ctx) return false
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(sourceCanvas, 0, 0, w, h)
    overlay.style.display = 'block'
    return true
  } catch (e) {
    return false
  }
}

// 撤掉覆盖层并清空其内容，避免长期占用显存。
export function unfreezeFrame (overlay) {
  if (!overlay) return
  overlay.style.display = 'none'
  overlay.width = 0
  overlay.height = 0
}
