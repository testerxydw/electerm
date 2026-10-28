/**
 * B3-2/B3-3 网格内批量改值与查找替换的**纯计算**部分（不碰 DOM、不碰 IPC）。
 *
 * 前端只负责"算出哪些行要改成什么"，写库交给主进程 updateCells
 * （engines 层参数化 UPDATE + 只读闸门 + 行数上限）。
 *
 * 设计取向：
 * - 只对**值真的变了**的行发 UPDATE：MySQL 的 affectedRows 默认只计实际变更行，
 *   把没变的行也塞进去会让"影响 N 行"和勾选行数对不上，用户会以为漏改了。
 * - 查找替换只处理字符串单元格。数值/日期列上的"替换"语义不明确
 *   （'1' → '2' 对 int 列是合法改值，但 '1' → 'x' 是非法改值，前端不该替用户猜），
 *   非字符串单元格直接跳过（要改数值列请用批量改值）。
 * - 主键值参与定位，主键为空的行无法安全定位，直接跳过。
 */

const isBlank = v => v === null || v === undefined

// 正则元字符转义：查找串是**字面量**，'a.b' 不该匹配 'axb'
export function escapeRegExp (s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 主键值可用于定位：null/undefined 无法拼 WHERE，空串在部分引擎里也不等价（''≠NULL）
export const usableKey = pk => !isBlank(pk) && pk !== ''

/**
 * 单元格值是否算"已经等于目标值"（决定要不要发这次 UPDATE）。
 * 数值按数值比：网格里 DECIMAL 到前端是字符串 '12.50'，
 * 用户输入 12.5 时算同值，不发无意义的 UPDATE。
 */
export function sameCellValue (cur, next) {
  if (cur === next) {
    return true
  }
  if (isBlank(cur) || isBlank(next)) {
    return false
  }
  const cs = String(cur)
  const ns = String(next)
  if (cs === ns) {
    return true
  }
  const cn = Number(cs)
  const nn = Number(ns)
  if (cs.trim() !== '' && ns.trim() !== '' &&
    Number.isFinite(cn) && Number.isFinite(nn)) {
    return cn === nn
  }
  return false
}

/**
 * 批量同列改值：把 rows 的 column 列统一改成 value。
 * @returns {{ updates: {pk:any, value:any}[], unchanged: number, noKey: number }}
 */
export function planSameValue (rows, { column, pkColumn, value }) {
  const list = Array.isArray(rows) ? rows : []
  const updates = []
  let unchanged = 0
  let noKey = 0
  if (!column || !pkColumn) {
    return { updates, unchanged, noKey: list.length }
  }
  for (const row of list) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const pk = row[pkColumn]
    if (!usableKey(pk)) {
      noKey++
      continue
    }
    if (sameCellValue(row[column], value)) {
      unchanged++
      continue
    }
    updates.push({ pk, value })
  }
  return { updates, unchanged, noKey }
}

/**
 * 单个单元格的替换结果。返回值与输入同类型：非字符串输入原样返回。
 * wholeCell：整格匹配（整格等于查找串才替换），避免"把 name 里的 ana 全换掉"这类事故。
 */
export function replaceText (text, find, replace, opts) {
  const o = opts || {}
  if (typeof text !== 'string' || find === null || find === undefined || find === '') {
    return text
  }
  const whole = !!o.wholeCell
  const caseSensitive = o.matchCase !== false
  const next = String(replace == null ? '' : replace)
  if (whole) {
    const hit = caseSensitive
      ? text === find
      : text.toLowerCase() === String(find).toLowerCase()
    return hit ? next : text
  }
  if (caseSensitive) {
    // 字面量替换：用 split/join 而不是 RegExp，省掉转义与 $& 之类的替换模式解释
    return text.split(find).join(next)
  }
  const re = new RegExp(escapeRegExp(find), 'gi')
  // 用函数形式返回替换串：'$&' 在字符串形式里是"整个匹配"，用户输入会被误解
  return text.replace(re, () => next)
}

/**
 * 表内查找替换：在 rows 的 column 列上做字面替换。
 * 非字符串单元格（数值/二进制信封）不参与：数值列上的"替换"语义不明确，
 * 前端不该替用户猜（要改数值列请用批量改值）。
 * @returns {{ updates: {pk:any, value:string}[], matched: number, noKey: number }}
 */
export function planReplace (rows, opts) {
  const o = opts || {}
  const column = o.column
  const pkColumn = o.pkColumn
  const find = o.find
  const list = Array.isArray(rows) ? rows : []
  const updates = []
  let matched = 0
  let noKey = 0
  if (!column || !pkColumn || typeof find !== 'string' || find === '') {
    return { updates, matched, noKey }
  }
  for (const row of list) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const cur = row[column]
    if (typeof cur !== 'string') {
      continue
    }
    const next = replaceText(cur, find, o.replace, o)
    if (next === cur) {
      continue
    }
    matched++
    const pk = row[pkColumn]
    if (!usableKey(pk)) {
      noKey++
      continue
    }
    updates.push({ pk, value: next })
  }
  return { updates, matched, noKey }
}

// 确认弹窗里的主键清单：最多列 10 个，超出省略（与 deleteRows 的展示口径一致）
export function previewKeyList (keys, limit) {
  const n = typeof limit === 'number' && limit > 0 ? limit : 10
  const list = Array.isArray(keys) ? keys : []
  return list.slice(0, n).map(k => JSON.stringify(k === undefined ? null : k)).join(', ') +
    (list.length > n ? ', …' : '')
}
