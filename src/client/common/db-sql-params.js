/**
 * H6a：SQL 命名参数（`:name`）→ 驱动原生占位符
 *
 * 只做两件事：找出这条 SQL 里有哪些命名参数；把 `:name` 换成
 * MySQL 的 `?` / PG 的 `$1..$n`，并把值按占位符顺序排好。
 * 值的转义交给驱动（mysql2 的 `query(sql, params)`、pg 的 `values`），
 * 这里**不做任何字符串插值**——把这个模块当成唯一出口，就不会有人
 * 顺手拼一句 `sql.replace(':id', id)` 进去。
 *
 * 口径：
 * - 字符串字面量、注释、引号标识符里的 `:name` 不算参数（掩码后扫）；
 * - `::` 是 PG 的类型转换，不是参数分隔符；
 * - PG 已有的 `$1` 位置参数不与 `:name` 混用：两者编号会撞车，
 *   遇到就直接报错让人改，而不是猜一个编号；
 * - 同名参数重复出现时只取一个值，MySQL 侧按出现次数重复展开。
 */

const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/

// 逐字符分类：CODE（真代码）/ LITERAL（字符串与引号标识符）/ COMMENT。
// 与两个适配器里的 maskSqlText 同思路（那边要保长度替换空格，这里要分三类）：
// 语句计数要把字面量算进语句内容，注释不算
const CODE = 2
const LITERAL = 1
const COMMENT = 0

export const sqlMask = sql => {
  const s = String(sql || '')
  const n = s.length
  const kinds = new Array(n).fill(CODE)
  const blank = (from, to, kind) => {
    for (let k = from; k < to; k++) {
      kinds[k] = kind
    }
  }
  let i = 0
  while (i < n) {
    const c = s[i]
    if (c === '-' && s[i + 1] === '-') {
      let j = s.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      blank(i, j, COMMENT)
      i = j
      continue
    }
    if (c === '#') {
      let j = s.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      blank(i, j, COMMENT)
      i = j
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      const found = s.indexOf('*/', i + 2)
      const j = found < 0 ? n : found + 2
      blank(i, j, COMMENT)
      i = j
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (s[j] === '\\') {
          j += 2
          continue
        }
        if (s[j] === c) {
          // 双写引号是转义（'' / "" / ``），不是结束
          if (s[j + 1] === c) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      blank(i, Math.min(j, n), LITERAL)
      i = j
      continue
    }
    i++
  }
  return kinds
}

// 出现在 SQL 里的 `:name`（按首次出现排序，去重）
export const extractSqlParams = sql => {
  const s = String(sql || '')
  const kinds = sqlMask(s)
  const names = []
  const seen = new Set()
  for (let i = 0; i < s.length; i++) {
    if (kinds[i] !== CODE || s[i] !== ':') {
      continue
    }
    // `::` 是类型转换：`:x::int` 的第二个冒号不开始参数
    if (s[i + 1] === ':') {
      i++
      continue
    }
    if (!IDENT_START.test(s[i + 1] || '')) {
      continue
    }
    let j = i + 2
    while (j < s.length && IDENT_PART.test(s[j])) {
      j++
    }
    const name = s.slice(i + 1, j)
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
    i = j - 1
  }
  return names
}

// 代码区里是否有 $n 位置参数（PG）；有就不能再叠 `:name`
const hasDollarParam = sql => {
  const s = String(sql || '')
  const kinds = sqlMask(s)
  for (let i = 0; i < s.length - 1; i++) {
    if (kinds[i] === CODE && s[i] === '$' && /[0-9]/.test(s[i + 1])) {
      return true
    }
  }
  return false
}

// 代码区里真正的语句条数（空语句不计）：给"参数化只支持单条"用
export const countSqlStatements = sql => {
  const s = String(sql || '')
  const kinds = sqlMask(s)
  let count = 0
  let hasText = false
  for (let i = 0; i < s.length; i++) {
    if (kinds[i] === COMMENT) {
      continue
    }
    if (kinds[i] === CODE && s[i] === ';') {
      if (hasText) {
        count++
      }
      hasText = false
      continue
    }
    if (/\S/.test(s[i])) {
      hasText = true
    }
  }
  if (hasText) {
    count++
  }
  return count
}

// values: { [name]: any } 或按 names 顺序的数组；null 表示 SQL NULL（不是"没填"）
const valuesOf = (names, values) => {
  if (Array.isArray(values)) {
    if (values.length !== names.length) {
      throw new Error('parameter count mismatch: expected ' + names.length + ', got ' + values.length)
    }
    return values
  }
  const src = values || {}
  return names.map(n => {
    if (!Object.prototype.hasOwnProperty.call(src, n)) {
      throw new Error('missing value for :' + n)
    }
    return src[n]
  })
}

/**
 * `:name` → 驱动占位符
 * - mysql: `?`（同名重复出现就重复展开）
 * - postgres: `$1..$n`（同名复用同一个编号）
 * 返回的 values 与占位符一一对应。
 */
export const toPositional = (sql, values, dialect) => {
  const s = String(sql || '')
  const names = extractSqlParams(s)
  if (!names.length) {
    return { sql: s, values: [] }
  }
  if (hasDollarParam(s)) {
    throw new Error('$n positional parameters cannot be mixed with :name parameters')
  }
  const ordered = valuesOf(names, values)
  const byName = new Map(names.map((n, i) => [n, ordered[i]]))
  const slots = new Map(names.map((n, i) => [n, i]))
  const kinds = sqlMask(s)
  let out = ''
  const outValues = []
  for (let i = 0; i < s.length; i++) {
    if (kinds[i] !== CODE || s[i] !== ':') {
      out += s[i]
      continue
    }
    if (s[i + 1] === ':') {
      out += '::'
      i++
      continue
    }
    if (!IDENT_START.test(s[i + 1] || '')) {
      out += s[i]
      continue
    }
    let j = i + 2
    while (j < s.length && IDENT_PART.test(s[j])) {
      j++
    }
    const name = s.slice(i + 1, j)
    if (dialect === 'postgres') {
      const idx = slots.get(name)
      out += '$' + (idx + 1)
      if (outValues.length === idx) {
        outValues.push(byName.get(name))
      }
    } else {
      out += '?'
      outValues.push(byName.get(name))
    }
    i = j - 1
  }
  return { sql: out, values: outValues }
}
