/**
 * 条件体/排序列的主进程二次校验（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.3）
 *
 * 为什么必须在主进程再做一遍：
 * 渲染层的 buildWhere（client/common/db-grid-view.js）负责"生成**正确的**条件"，
 * 但渲染层不是安全边界 —— DevTools 里改一行就能直接把任意字符串当 where 传下来。
 * 所以主进程要做的是"拒绝**不认识的**条件"：只接受由列名、白名单函数、
 * 比较运算符和占位符构成的表达式。这是一张白名单，不是黑名单清洗。
 *
 * 为什么"不合规就抛错"而不是"清理干净再跑"：
 * 静默剥离注释/分号会让用户以为"我的条件生效了"，实际跑的是被改过的语句 ——
 * 这是最难查的一类问题（数据看起来对，但他筛的东西根本没进去）。这里的定位是闸门，
 * 看不懂就停，把原文和原因交回给用户改。
 *
 * 为什么要先掩码字符串字面量：
 * `a = 'x;--y'` 是完全合法的值匹配。先按 UTF-16 码元**等长**掩码（替换成空格），
 * 后续所有"扫字符"的判定（分号/注释/括号/关键词）就都只看结构，不看数据；
 * 等长保证偏移与原文一一对应，报错能指回原字符位置。
 *
 * 方言差异不是细节：mysql 的 `"..."` 是字符串字面量、反引号才是标识符；
 * pg 反过来（`"..."` 标识符），并且额外有 E'...' 与 $tag$...$tag$ 两种字面量写法。
 * 掩码搞错方言，就会出现"合法值被当成标识符拒绝"或"标识符被当值放过"。
 */

'use strict'

// 条件体长度上限：正常的 WHERE 不会超过这个量级；超了基本是拿它写查询，
// 请走 executeSql（那里有独立的危险分级与确认流程）
const MAX_CLAUSE_LENGTH = 4000
// 排序列上限，与 client/common/db-grid-view.js 的 MAX_ORDER_COLUMNS 保持一致
const MAX_ORDER_CLAUSES = 3

// 函数白名单：全部是标量/聚合只读函数，且两种方言都存在同名实现（或语义等价）
const FN_WHITELIST = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'coalesce',
  'cast',
  'ifnull',
  'now',
  'date',
  'lower',
  'upper',
  'round',
  'abs'
]

// 条件体里允许出现的语法词。NULL/TRUE/FALSE 是字面量，但在这里按"结构词"处理，
// 因为它们不绑定参数、也不可能是列名（真有列叫 null 就得加引用符，见 assertIdentAllowed）
const SYNTAX_WORDS = [
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'IS',
  'NULL',
  'BETWEEN',
  'ESCAPE',
  'TRUE',
  'FALSE'
]

// 语句关键字黑名单：出现在 WHERE 子句里没有任何合法用法
const KEYWORD_BLACKLIST = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'UNION',
  'EXEC',
  'EXECUTE',
  'CALL',
  'GRANT',
  'REVOKE',
  'MERGE',
  'REPLACE',
  'INTO',
  'SET',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'LOAD',
  'COPY',
  'VACUUM'
]

// 词边界按 [A-Za-z0-9_$] 判定（不能用 \b：\b 把 $ 当非单词字符，`x$INSERT` 会漏）
const KEYWORD_RE = new RegExp(
  '(^|[^A-Za-z0-9_$])(' + KEYWORD_BLACKLIST.join('|') + ')(?![A-Za-z0-9_$])',
  'i'
)

// $tag$ / $$ 开标签；$1 这类占位符不匹配（第二位必须是字母/下划线）
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

const WORD_CHAR_RE = /[A-Za-z0-9_$]/

function isWordChar (ch) {
  return typeof ch === 'string' && ch !== '' && WORD_CHAR_RE.test(ch)
}

function isDigit (ch) {
  return ch >= '0' && ch <= '9'
}

/**
 * 方言归一：只有 pg 与 mysql 两套词法，其他取值一律按 mysql 处理
 * （与 db-grid-view.js 的 normalizeDialect 口径一致）
 * @param {string} dialect 方言
 * @returns {'mysql'|'postgres'} 归一后的方言
 */
function normalizeDialect (dialect) {
  const d = String(dialect === null || dialect === undefined ? '' : dialect).toLowerCase()
  return d === 'postgres' || d === 'postgresql' || d === 'pg' ? 'postgres' : 'mysql'
}

/**
 * 把上游列清单归一成小写名集合。
 * @param {Array<string|{name:string}>} columns 列清单
 * @returns {Map<string,string>} 小写名 → 规范名
 */
function columnLookup (columns) {
  const list = Array.isArray(columns) ? columns : []
  const map = new Map()
  for (const item of list) {
    let name = ''
    if (typeof item === 'string') {
      name = item
    } else if (item && typeof item.name === 'string') {
      name = item.name
    }
    const t = name.trim()
    if (t && !map.has(t.toLowerCase())) {
      map.set(t.toLowerCase(), t)
    }
  }
  return map
}

/**
 * 从 start（引号本身）扫到闭合引号之后。
 * 处理 `''`/`""` 双写转义与（可选）反斜杠转义；未闭合时返回串尾 —
 * 掩码阶段绝不能因为"用户还没写完"而抛错，闭合与否交给后面的结构判定。
 * @param {string} src 原文
 * @param {number} start 起始引号下标
 * @param {string} quote 引号字符
 * @param {boolean} backslash 是否启用反斜杠转义
 * @returns {number} 闭合引号之后的下标
 */
function scanQuoted (src, start, quote, backslash) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    const c = src[j]
    if (backslash && c === '\\') {
      j += 2
      continue
    }
    if (c === quote) {
      if (src[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return n
}

/**
 * pg 的 E'...'：E 必须是独立词（不能是 name 的最后一个字母，否则 `name'x'` 会被误判）
 * @param {string} src 原文
 * @param {number} i 单引号下标
 * @returns {boolean} 是否是 E 字符串
 */
function isEString (src, i) {
  const prev = src[i - 1]
  if (prev !== 'E' && prev !== 'e') {
    return false
  }
  const before = i - 2 >= 0 ? src[i - 2] : ''
  return before === '' || !isWordChar(before)
}

/**
 * 读取 dollar-quote 开标签（`$$` / `$tag$`）
 * @param {string} src 原文
 * @param {number} i `$` 的下标
 * @returns {string} 开标签；不匹配返回空串
 */
function readDollarTag (src, i) {
  const head = src.slice(i, Math.min(i + 66, src.length))
  const m = DOLLAR_TAG_RE.exec(head)
  return m ? m[0] : ''
}

/**
 * 掩码字符串字面量（替换成等长空白，保留换行）。
 * mysql：'...'（反斜杠转义）与 "..."（同为字符串字面量）；反引号是标识符，**不掩码**。
 * pg：'...'（'' 转义）、E'...'（反斜杠转义）、$tag$...$tag$；"..." 是标识符，**不掩码**。
 * @param {string} sql 原文
 * @param {string} dialect 方言
 * @returns {string} 与原文等长的掩码串
 */
function maskLiterals (sql, dialect) {
  const d = normalizeDialect(dialect)
  const chars = sql.split('')
  const blank = (from, to) => {
    const end = Math.min(to, chars.length)
    for (let k = from; k < end; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') {
        chars[k] = ' '
      }
    }
  }
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      // E 前缀也要一起掩掉，否则剩下的 `E` 会被当成裸标识符而报"列不存在"
      const eStr = d === 'postgres' && isEString(sql, i)
      const end = scanQuoted(sql, i, "'", d === 'mysql' || eStr)
      blank(eStr ? i - 1 : i, end)
      i = end
      continue
    }
    if (ch === '"') {
      if (d === 'mysql') {
        const end = scanQuoted(sql, i, '"', true)
        blank(i, end)
        i = end
        continue
      }
      // pg：双引号是标识符，留给 tokenize 做白名单校验
      i++
      continue
    }
    if (d === 'mysql' && ch === '`') {
      // 反引号标识符不掩码，但跳过其内容，避免内部引号被误当字面量起点
      i = scanQuoted(sql, i, '`', false)
      continue
    }
    if (d === 'postgres' && ch === '$') {
      const tag = readDollarTag(sql, i)
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? sql.length : close + tag.length
        blank(i, end)
        i = end
        continue
      }
    }
    i++
  }
  return chars.join('')
}

/**
 * 切 token。同时产出 skeleton（引用标识符被抹成空白的副本）——
 * 分号/注释/关键词这三类判定只能在结构串上做：`` `a;b` `` 里的分号属于列名，
 * 该由标识符白名单去拒绝，不该冒充"多语句"。
 * @param {string} masked 掩码串
 * @returns {{tokens: Array, skeleton: string}} token 列表与结构串
 */
function tokenize (masked) {
  const tokens = []
  const chars = masked.split('')
  const n = masked.length
  let i = 0
  while (i < n) {
    const ch = masked[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (ch === '`' || ch === '"') {
      let j = i + 1
      let name = ''
      while (j < n) {
        if (masked[j] === ch) {
          if (masked[j + 1] === ch) {
            name += ch
            j += 2
            continue
          }
          j++
          break
        }
        name += masked[j]
        j++
      }
      tokens.push({ kind: 'ident', text: name, quoted: true })
      for (let k = i; k < j; k++) {
        chars[k] = ' '
      }
      i = j
      continue
    }
    if (ch === '?') {
      tokens.push({ kind: 'placeholder', text: ch })
      i++
      continue
    }
    if (ch === '$' && isDigit(masked[i + 1])) {
      let j = i + 1
      let num = ''
      while (j < n && isDigit(masked[j])) {
        num += masked[j]
        j++
      }
      tokens.push({ kind: 'param', text: num })
      i = j
      continue
    }
    if (isWordChar(ch)) {
      let j = i
      let word = ''
      while (j < n && isWordChar(masked[j])) {
        word += masked[j]
        j++
      }
      tokens.push({ kind: 'word', text: word })
      i = j
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: 'paren', text: ch })
      i++
      continue
    }
    tokens.push({ kind: 'punct', text: ch })
    i++
  }
  return { tokens, skeleton: chars.join('') }
}

/**
 * 结构串上禁止的字符：分号（多语句）、行注释、块注释、mysql 井号注释。
 * 不做剥离：注释出现在条件体里意味着用户在写查询，不是在设筛选条件。
 * @param {string} skeleton 结构串
 */
function assertNoForbiddenChars (skeleton) {
  if (skeleton.indexOf(';') !== -1) {
    throw new Error('条件体不允许包含分号（多语句）')
  }
  if (skeleton.indexOf('--') !== -1) {
    throw new Error('条件体不允许包含注释')
  }
  if (skeleton.indexOf('/*') !== -1) {
    throw new Error('条件体不允许包含注释')
  }
  if (skeleton.indexOf('#') !== -1) {
    throw new Error('条件体不允许包含注释')
  }
}

/**
 * 括号配平：从左到右扫，闭合多于开合立刻拒绝（`1=1)` 这种必然被拼进外层语句里搞坏结构）
 * @param {Array} tokens token 列表
 */
function assertBalanced (tokens) {
  let depth = 0
  for (const t of tokens) {
    if (t.kind !== 'paren') {
      continue
    }
    if (t.text === '(') {
      depth++
    } else {
      depth--
      if (depth < 0) {
        throw new Error('条件体括号不配平')
      }
    }
  }
  if (depth !== 0) {
    throw new Error('条件体括号不配平')
  }
}

/**
 * 语句关键字黑名单（词边界匹配）
 * @param {string} skeleton 结构串
 */
function assertNoKeyword (skeleton) {
  const m = KEYWORD_RE.exec(skeleton)
  if (m) {
    throw new Error('条件体包含不允许的关键词: ' + m[2].toUpperCase())
  }
}

/**
 * 单个标识符是否被允许：列白名单（大小写不敏感）→ 函数白名单 → 语法词
 * @param {{text:string, quoted:boolean}} token 标识符 token
 * @param {Map<string,string>} lookup 列白名单
 */
function assertIdentAllowed (token, lookup) {
  const text = token.text
  if (!text) {
    // 空的引用标识符（`` 或 ""）没有任何语义，直接拒绝而不是放行
    throw new Error('条件体包含空的标识符')
  }
  if (!token.quoted && /^[0-9]/.test(text)) {
    // 数字字面量（含 1e5 / 0x1f 这类），不是标识符
    return
  }
  const lower = text.toLowerCase()
  if (lookup.has(lower)) {
    return
  }
  if (FN_WHITELIST.indexOf(lower) !== -1) {
    return
  }
  if (!token.quoted && SYNTAX_WORDS.indexOf(text.toUpperCase()) !== -1) {
    return
  }
  throw new Error('条件体引用了不存在的列: ' + text)
}

/**
 * 统计占位符并校验形式与编号
 * mysql：只接受 `?`，返回个数；
 * pg：只接受 `$n`，返回最大 n，且要求 1..max 连续无缺号（缺号会让驱动少绑一个参数，
 * 报出来的错是语法错误，跟根因差十万八千里）
 * @param {Array} tokens token 列表
 * @param {string} dialect 方言
 * @returns {number} 占位符个数 / 最大编号
 */
function countPlaceholders (tokens, dialect) {
  const bare = tokens.filter(t => t.kind === 'placeholder')
  const numbered = tokens.filter(t => t.kind === 'param')
  if (normalizeDialect(dialect) === 'postgres') {
    if (bare.length) {
      throw new Error('条件体占位符必须写成 $n 形式: ?')
    }
    let max = 0
    for (const t of numbered) {
      const n = Number(t.text)
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('条件体占位符编号必须从 $1 开始: $' + t.text)
      }
      if (n > max) {
        max = n
      }
    }
    const seen = new Set(numbered.map(t => Number(t.text)))
    for (let k = 1; k <= max; k++) {
      if (!seen.has(k)) {
        throw new Error('条件体占位符编号不连续: 缺少 $' + k)
      }
    }
    return max
  }
  if (numbered.length) {
    throw new Error('条件体占位符必须写成 ? 形式: $' + numbered[0].text)
  }
  return bare.length
}

/**
 * 校验条件体（不含前导 WHERE 的字符串）。
 * @param {string} clause 条件体
 * @param {Array<string|{name:string}>} columns 列白名单（来自表结构）
 * @param {string} dialect 方言（mysql/postgres）
 * @returns {{placeholders: number}} 占位符个数；调用方据此与 whereParams.length 对比
 * @throws {Error} 任何一项校验不通过（错误信息可直接展示给用户）
 */
function assertSafeClause (clause, columns, dialect) {
  if (typeof clause !== 'string') {
    throw new Error('条件体必须是字符串')
  }
  if (clause.length > MAX_CLAUSE_LENGTH) {
    throw new Error('条件体过长（最大 ' + MAX_CLAUSE_LENGTH + ' 字符）')
  }
  const d = normalizeDialect(dialect)
  const masked = maskLiterals(clause, d)
  const { tokens, skeleton } = tokenize(masked)
  assertNoForbiddenChars(skeleton)
  assertBalanced(tokens)
  assertNoKeyword(skeleton)
  const lookup = columnLookup(columns)
  for (const t of tokens) {
    if (t.kind === 'word' || t.kind === 'ident') {
      assertIdentAllowed(t, lookup)
    }
  }
  return { placeholders: countPlaceholders(tokens, d) }
}

/**
 * 校验排序列。
 * 排序只接受单列名 —— 这里刻意不开放函数白名单：
 * ORDER BY RAND()/LENGTH(x) 既走不了索引，又是"点一下卡住数据库"的经典写法。
 * @param {Array<{column:string, desc:boolean}>|null|undefined} orderClauses 排序列表
 * @param {Array<string|{name:string}>} columns 列白名单
 * @param {string} dialect 方言
 * @throws {Error} 非数组、超上限、列不存在、或传了表达式
 */
function assertSafeOrderClauses (orderClauses, columns, dialect) {
  if (orderClauses === null || orderClauses === undefined) {
    return
  }
  if (!Array.isArray(orderClauses)) {
    throw new Error('排序列必须是数组')
  }
  if (orderClauses.length > MAX_ORDER_CLAUSES) {
    throw new Error('排序列最多 ' + MAX_ORDER_CLAUSES + ' 列')
  }
  const lookup = columnLookup(columns)
  for (const item of orderClauses) {
    let name = ''
    if (typeof item === 'string') {
      name = item
    } else if (item && typeof item.column === 'string') {
      name = item.column
    }
    const t = name.trim()
    if (!t) {
      throw new Error('排序列名不能为空')
    }
    // `a+1` / `a->>'x'` 这类一律拒绝：排序不接受表达式（方言差异太大，无法白名单化）
    if (!/^[A-Za-z0-9_$]+$/.test(t)) {
      throw new Error('排序只接受单列名，不能是表达式: ' + t)
    }
    if (!lookup.has(t.toLowerCase())) {
      throw new Error('排序引用了不存在的列: ' + t)
    }
  }
}

module.exports = {
  assertSafeClause,
  assertSafeOrderClauses,
  FN_WHITELIST
}
