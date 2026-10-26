/**
 * 分批计划（C 批导入，设计 §10）：把行数组切成 multi-row INSERT 批次。
 *
 * 纯函数、零依赖、无 IO：mysql/postgres 两个适配器共用同一份切批逻辑，
 * 保证「500 行上限 / 1MB 体积上限」在两种方言下口径一致，也便于 vm 单测。
 *
 * 为什么在适配器内部切批而不是只靠调用方：
 * 调用方（db-importer）按 batchSize 累积推送，但单批里可能有大字段行，
 * 500 行 × 4KB 文本也会逼近 MySQL 的 max_allowed_packet —— 体积上限是第二道闸。
 */

'use strict'

const DEFAULT_MAX_ROWS = 500
const DEFAULT_MAX_BYTES = 1024 * 1024

// 单行体积估算：绑定参数不占 SQL 文本，用该行 JSON 序列化字节数近似
// （导入场景字段都是字符串，误差只有引号转义级别，1MB 预算下可忽略）
function rowBytes (row) {
  let s = ''
  try {
    s = JSON.stringify(row || {})
  } catch (e) {
    s = String(row)
  }
  return Buffer.byteLength(s)
}

/**
 * 切批。
 * @param {Array<object>} rows 同构行对象数组（列键一致由调用方保证）
 * @param {{maxRows?:number, maxBytes?:number}} opts 行数/估算字节上限
 * @returns {Array<{firstRow:number, rows:Array<object>}>} 批次列表；
 *          firstRow 是该批首行在入参 rows 里的 0-based 下标（调用方换算文件行号用）
 */
function planInsertBatches (rows, opts) {
  const maxRows = Number((opts && opts.maxRows) || DEFAULT_MAX_ROWS) || DEFAULT_MAX_ROWS
  const maxBytes = Number((opts && opts.maxBytes) || DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES
  const list = Array.isArray(rows) ? rows : []
  const batches = []
  let cur = []
  let curBytes = 0
  let firstRow = 0
  for (let i = 0; i < list.length; i++) {
    const bytes = rowBytes(list[i])
    // 单行自身超限不再切（单行 INSERT 无法拆分）：照常成批，交由数据库侧报错
    if (cur.length && (cur.length >= maxRows || curBytes + bytes > maxBytes)) {
      batches.push({ firstRow, rows: cur })
      cur = []
      curBytes = 0
      firstRow = i
    }
    cur.push(list[i])
    curBytes += bytes
  }
  if (cur.length) {
    batches.push({ firstRow, rows: cur })
  }
  return batches
}

module.exports = {
  planInsertBatches,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_BYTES
}
