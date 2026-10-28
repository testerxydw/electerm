/**
 * 网格列聚合（B3-1）：对「当前显示的行」按列算 count/sum/avg/min/max。
 *
 * 为什么在渲染层算而不发 SQL：
 * - 表格里看到的行已经是当前页 + 页内过滤后的结果，用户问的"合计"就是这一屏，
 *   再打一次 `SELECT SUM(...)` 会给出与屏幕不一致的数字（条件/分页/估算行数三方打架）；
 * - 聚合不该有写风险、也不该额外占连接池（4 个连接，大表并发查询会排队）。
 * 需要全表聚合的正确姿势是写 SQL（SQL 页签里有完整能力），这里明确定位为"本页聚合"。
 *
 * 数值口径（易错，单独列出）：
 * - DECIMAL/NUMERIC 经 IPC 后常是字符串（safeCell 把驱动包装转 String），
 *   所以纯数字字符串必须参与计算，否则金额列永远显示"非数值"；
 * - null/undefined/空串计 null 但不拉低平均值分母；
 * - 一旦出现无法解析为非数值的字符串，整列按"非数值"处理并停止累加 ——
 *   半个列求和比不求和更危险（用户会拿它当结论）。
 */

const isBlank = v => v === null || v === undefined || v === ''

// 字符串 → 数值：只认"整体是数字"的形态（'12', '3.5', '-1e3'），
// '12abc'、'0x10'、纯空格一律不算数值
export function toNumber (v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null
  }
  if (typeof v !== 'string') {
    return null
  }
  const s = v.trim()
  if (!s) {
    return null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {Array<object>} rows 屏幕上实际显示的行（已过滤/已分页）
 * @param {string} column 列名
 * @returns {{column:string, rows:number, nulls:number, numeric:boolean,
 *   count:number, sum?:number, avg?:number, min?:number, max?:number}}
 */
export function summarizeColumn (rows, column) {
  const list = Array.isArray(rows) ? rows : []
  const numbers = []
  let nulls = 0
  let nonNulls = 0
  let numeric = true
  for (const row of list) {
    const v = row ? row[column] : undefined
    if (isBlank(v)) {
      nulls += 1
      continue
    }
    nonNulls += 1
    const n = toNumber(v)
    if (n === null) {
      // 出现非数值：整列不再当数值列（半个列求和比不求和更危险），
      // 但仍继续数非空个数 —— 文本列的"计数"依然有意义
      numeric = false
      continue
    }
    if (numeric) {
      numbers.push(n)
    }
  }
  const base = {
    column,
    rows: list.length,
    nulls,
    // count 口径：非空行数（文本列也有意义）；sum/avg 仅 numeric 时有值
    count: nonNulls,
    // 全 null 的列不算数值列（sum 为 0 会让人误以为"合计是 0"）
    numeric: numeric && numbers.length > 0
  }
  if (!base.numeric) {
    return base
  }
  let sum = 0
  let min = numbers[0]
  let max = numbers[0]
  for (const n of numbers) {
    sum += n
    if (n < min) {
      min = n
    }
    if (n > max) {
      max = n
    }
  }
  return {
    ...base,
    sum,
    avg: sum / numbers.length,
    min,
    max
  }
}

// 展示用数字：整数原样、浮点最多两位（SUM(decimal) 会出现 0.30000000000000004）
export function formatNumber (n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '-'
  }
  if (Number.isInteger(n)) {
    return String(n)
  }
  return String(Number(n.toFixed(2)))
}

// 单行摘要文本：数值列给 Σ/⌀/n，非数值列只给 n（避免"字符串列也显示 0 合计"）
export function summaryText (s) {
  if (!s || !s.column) {
    return ''
  }
  if (!s.numeric) {
    return `n ${s.count}`
  }
  return `Σ ${formatNumber(s.sum)} · ⌀ ${formatNumber(s.avg)} · n ${s.count}`
}
