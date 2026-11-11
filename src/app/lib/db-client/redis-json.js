/**
 * N5d · RedisJSON（ReJSON 模块）的类型识别与写入校验（纯函数，零依赖）
 *
 * 只加最常见一档（RedisJSON 的 JSON.GET/SET），Vector / Search / TS / Bloom
 * 后置（数据 TODO §1 N5d 口径）。单独一个文件的原因与 transfer-keys.js 相同：
 * redis.js 依赖 ioredis，node:test 的 spec 不能直接 require 连接层，
 * 纯函数收在这里才能独立单测。
 *
 * TYPE 形态：RedisJSON v2+（2021 起）是 'ReJSON-RL'；1.x 老版是 'ReJSON-RLType'。
 * 服务端键详情与写分发两个消费点共用同一口径，两个时代都认 —— 认不出就会把
 * 模块键当成 unsupported type 渲染成空白，用户看到的是"数据丢了"。
 */

const REJSON_TYPES = ['ReJSON-RL', 'ReJSON-RLType']

function isReJsonType (t) {
  return REJSON_TYPES.includes(String(t || ''))
}

/**
 * 校验用户编辑的 JSON 文本，合法则原样返回。
 * 故意不做 parse→stringify 往返：JS number 会把 >2^53 的整数吞掉精度
 * （9007199254740993 → 9007199254740992），原样透传才不写坏文档；
 * RedisJSON 存的是解析树，文本格式（缩进/空白）本来就不保留，无需规范化。
 */
function validateJsonText (text) {
  if (typeof text !== 'string') {
    throw new Error('JSON value must be a string')
  }
  try {
    JSON.parse(text)
  } catch (e) {
    throw new Error('invalid JSON: ' + ((e && e.message) || 'parse failed'))
  }
  return text
}

module.exports = {
  isReJsonType,
  validateJsonText,
  REJSON_TYPES
}
