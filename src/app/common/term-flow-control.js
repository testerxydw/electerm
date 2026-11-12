/**
 * 终端输出 credit 流控状态机（纯函数，零副作用，供单测直接 require）。
 *
 * 与「丢最旧数据」相反：生产速度超过消费速度时暂停上游（PTY / ssh channel /
 * serial port 的 pause），把字节留在内核缓冲里，等渲染层解析完再继续发货。
 * 计数单位是**字节**：server 发的是 Buffer，renderer 回的 ACK 也是它收到的
 * 原始帧字节数，CJK / 非法字节不会让 credit 漂移。
 */
const protocol = require('./term-flow-protocol.json')
const { limits } = protocol

function createCreditState () {
  return {
    inflight: 0,
    paused: false,
    pausedAt: 0
  }
}

function applySend (state, bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  return { ...state, inflight: state.inflight + n }
}

function applyAck (state, bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  return { ...state, inflight: Math.max(0, state.inflight - n) }
}

/**
 * 是否应当暂停上游。带迟滞（windowBytes → resumeBytes），避免洪流边界抖动。
 * 超时兜底只解除暂停、不丢数据：ACK 永久丢失时宁可让队列暂时超过窗口，
 * 也不能让会话看起来像死机；所有字节在离开会话前已进无损归档。
 */
function shouldPause (state, now = Date.now()) {
  if (state.paused) {
    if (now - state.pausedAt >= limits.pauseTimeoutMs) {
      return false
    }
    return state.inflight > limits.resumeBytes
  }
  return state.inflight >= limits.windowBytes
}

function markPause (state, paused, now = Date.now()) {
  return {
    ...state,
    paused,
    pausedAt: paused ? now : 0
  }
}

module.exports = {
  limits,
  createCreditState,
  applySend,
  applyAck,
  shouldPause,
  markPause
}
