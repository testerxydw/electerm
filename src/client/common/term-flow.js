/**
 * 渲染层输出流控协议。
 *
 * 常量值由 src/app/common/term-flow-protocol.json 单点定义；本文件是 ESM
 * 镜像（渲染层不跨包 require CommonJS），逐字一致性由
 * src/test/unit-ci/term-flow-contract.spec.js 锁定，任何一侧改动都会红。
 *
 * 零丢弃约定：渲染层不再有「超限丢弃」，只有 FIFO + term.write 回调驱动的
 * 逐批消费，消费完按原始字节数回 ACK，让服务端回补 credit。
 */

export const FLOW_ACTIONS = Object.freeze({
  ack: 'output-ack',
  archive: 'output-archive'
})

export const FLOW_LIMITS = Object.freeze({
  windowBytes: 8388608,
  resumeBytes: 2097152,
  pauseTimeoutMs: 30000,
  maxBatchBytes: 524288
})

const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder()

/** ws 帧的原始字节数，与服务端 Buffer.length 同口径。 */
export function bytesOf (data) {
  if (typeof data === 'string') {
    return encoder ? encoder.encode(data).length : data.length
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
  }
  return 0
}
