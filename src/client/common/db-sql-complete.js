/**
 * SQL 补全引擎（阶段4 A 批，设计 §4.4 / §4.5 / §4.6）
 *
 * 三层，本文件全部覆盖但 L2 的源解析留到列补全那一格再启用：
 *   L1 词法   maskSqlLiterals / statementSpanAt / parseTrailingIdentifier
 *   L2 源解析 scanCtes / extractSources        —— 仅供 A-5/A-6 使用，本轮不参与出候选
 *   L3 场景   classifyContext / buildCompletions
 *
 * 三条铁律：
 * 1. **降级不抛错**：任何解析失败都退化为 `general`（关键字 + 内置函数），
 *    绝不允许"因为解析不了所以不弹菜单"——那比不准确更差。
 * 2. **零请求**：这里只吃调用方喂进来的 `tables` / `columns`，自己不发 IPC。
 * 3. **零依赖**：不 import 任何 CM6 模块，node 单测可直接加载（vm 沙箱）。
 *
 * 位置约定：所有 `from` / `to` 都是**文档绝对偏移**（不是 masked 后的相对偏移），
 * 因为 masked 与原文等长，索引可直接互用。
 */

// ---------------------------------------------------------------- L1 词法

const WORD_RE = /[A-Za-z0-9_$]/

function isWord (ch) {
  return ch !== undefined && WORD_RE.test(ch)
}

/**
 * 把注释与字符串/引号标识符替换成空格（保留换行，行号不变）。
 * 返回的 `literals` 用于"光标是否在字符串/注释内 → 不弹补全"的判定。
 *
 * @param {string} text
 * @param {object} dialect sql-dialects.js 的方言记录（可缺省）
 * @returns {{masked: string, literals: Array<{from:number,to:number,kind:string}>}}
 */
export function maskSqlLiterals (text, dialect) {
  const d = dialect || {}
  const quotes = d.quote ? [d.quote] : []
  const hashComment = !!d.hashComment
  const backslashEscapes = !!d.backslashEscapes
  const spaceAfterDashes = !!d.spaceAfterDashes
  const dollarQuote = !!d.dollarQuote

  const out = text.split('')
  const literals = []
  const n = text.length

  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') {
        out[k] = ' '
      }
    }
  }
  // `closed` 决定端点归属：闭合的字符串，pos === to 已经在字符串**外**；
  // 未闭合的（一直写到文末），pos === to 仍算在里面
  const push = (from, to, kind, closed) => {
    literals.push({ from, to, kind, closed: !!closed })
    blank(from, to)
  }

  let i = 0
  while (i < n) {
    const c = text[i]

    // 行注释 --：MySQL 要求后面跟空白（`--1` 是"减负数"，不是注释）
    if (
      c === '-' && text[i + 1] === '-' &&
      (!spaceAfterDashes || i + 2 >= n || /\s/.test(text[i + 2]))
    ) {
      let j = text.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      // 行注释不算"闭合"：游标停在换行符上仍在这条注释里
      push(i, j, 'comment', false)
      i = j
      continue
    }

    // 行注释 #：MySQL 有，PG 里 # 是非法字符 → 按方言开关
    if (c === '#' && hashComment) {
      let j = text.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      push(i, j, 'comment', false)
      i = j
      continue
    }

    // 块注释 /* */（不做嵌套：MySQL 不嵌套，PG 嵌套极少见，宁可少吞）
    if (c === '/' && text[i + 1] === '*') {
      const found = text.indexOf('*/', i + 2)
      const j = found < 0 ? n : found + 2
      push(i, j, 'comment', found >= 0)
      i = j
      continue
    }

    // 字符串 '...'：单引号双写转义恒定成立；反斜杠转义按方言
    if (c === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (backslashEscapes && text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          closed = true
          break
        }
        j += 1
      }
      push(i, Math.min(j, n), 'string', closed)
      i = Math.min(j, n)
      continue
    }

    // 引号标识符 `...` / "..."：内容也可能含 ; 或 --，必须一起掩掉
    if (quotes.includes(c)) {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) {
            j += 2
            continue
          }
          j += 1
          closed = true
          break
        }
        j += 1
      }
      push(i, Math.min(j, n), 'quotedIdent', closed)
      i = Math.min(j, n)
      continue
    }

    // PG 的 $tag$ ... $tag$（函数体）
    if (dollarQuote && c === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const found = text.indexOf(tag, i + tag.length)
        const j = found < 0 ? n : found + tag.length
        push(i, j, 'string', found >= 0)
        i = j
        continue
      }
    }

    i++
  }

  return { masked: out.join(''), literals }
}

/**
 * 光标是否落在字符串/注释/引号标识符内。
 * 端点规则见 push 处的注释——这一条错了会让"引号后立刻补全"整块失效。
 */
export function literalAt (literals, pos) {
  for (const l of literals) {
    if (pos > l.from && (pos < l.to || (pos === l.to && !l.closed))) {
      return l
    }
  }
  return null
}

/**
 * 光标所在语句的区间（按 masked 里的 `;` 切分，字符串内的分号已掩掉）。
 * @returns {{from:number, to:number}} to 为排他端点
 */
export function statementSpanAt (masked, cursor) {
  let from = 0
  for (let i = cursor - 1; i >= 0; i--) {
    if (masked[i] === ';') {
      from = i + 1
      break
    }
  }
  let to = masked.length
  for (let i = cursor; i < masked.length; i++) {
    if (masked[i] === ';') {
      to = i
      break
    }
  }
  return { from, to }
}

/**
 * 从 `end`（排他）向前读一个标识符段。
 * 支持三种形态：纯词、未闭合的引号标识符、已闭合的引号标识符。
 * @returns {{from:number,start:number,text:string,quoted:boolean,quoteChar:string,closed:boolean}|null}
 *   `from` 含引号，`start` 不含（= 补全替换的起点，见 §4.6 第 3 条的引号前缀坑）
 */
export function scanSegmentBackward (text, end, quotes) {
  if (end <= 0) {
    return null
  }
  const q = text[end - 1]

  // 已闭合的引号标识符：向前找配对引号
  if (quotes.includes(q)) {
    let k = end - 2
    while (k >= 0) {
      if (text[k] === q) {
        if (text[k - 1] === q) {
          k -= 2
          continue
        }
        break
      }
      k--
    }
    if (k < 0) {
      return null
    }
    return {
      from: k,
      start: k + 1,
      text: text.slice(k + 1, end - 1),
      quoted: true,
      quoteChar: q,
      closed: true
    }
  }

  if (!isWord(q)) {
    return null
  }
  let k = end - 1
  while (k > 0 && isWord(text[k - 1])) {
    k--
  }
  const quoted = quotes.includes(text[k - 1])
  return {
    from: quoted ? k - 1 : k,
    start: k,
    text: text.slice(k, end),
    quoted,
    quoteChar: quoted ? text[k - 1] : '',
    closed: false
  }
}

// 从 token 起点向前收集 `a.b.c` 链
function scanChain (text, tokenFrom, quotes) {
  const segs = []
  let from = tokenFrom
  while (from > 0 && text[from - 1] === '.') {
    const seg = scanSegmentBackward(text, from - 1, quotes)
    if (!seg) {
      break
    }
    segs.unshift(seg)
    from = seg.from
  }
  return segs
}

/**
 * 解析光标前的标识符（含 `alias.` / `schema.table.` 限定链）。
 *
 * 关键点（§4.6 第 3 条）：`from` 跳过开引号。若把替换起点放在引号上，
 * CM6 会用含引号的文档片段去匹配不含引号的 label，候选**全部被过滤、菜单空白**。
 * `tokenFrom` 才是含引号的起点，只用于"取前缀之前的上下文"。
 *
 * @returns {{prefix:string,from:number,tokenFrom:number,quoted:boolean,quoteChar:string,
 *            qualifier:string[],qualifierSegs:Array}|null}
 */
export function parseTrailingIdentifier (text, cursor, dialect) {
  const quotes = dialect && dialect.quote ? [dialect.quote] : []
  const seg = scanSegmentBackward(text, cursor, quotes)

  // `alias.` 之后：prefix 为空，限定链止于光标
  if (!seg) {
    if (cursor > 0 && text[cursor - 1] === '.') {
      const chain = scanChain(text, cursor, quotes)
      if (chain.length) {
        return {
          prefix: '',
          from: cursor,
          tokenFrom: cursor,
          quoted: false,
          quoteChar: '',
          qualifier: chain.map(s => s.text),
          qualifierSegs: chain
        }
      }
    }
    return null
  }

  const chain = scanChain(text, seg.from, quotes)
  return {
    prefix: seg.text,
    // 替换起点：不含引号
    from: seg.start,
    // 含引号的起点：仅用于切出 prefix 之前的上下文
    tokenFrom: seg.from,
    quoted: seg.quoted,
    quoteChar: seg.quoteChar,
    qualifier: chain.map(s => s.text),
    qualifierSegs: chain
  }
}

// ---------------------------------------------------------------- L2 源解析
// 列补全是后面那一格的事，这里先把**纯函数**定下来，避免届时改文件结构。

/**
 * 收集 WITH 定义的 CTE 名（不含列）。
 * 只认 `WITH [RECURSIVE] name AS (` 与 `, name AS (` 两种形态。
 */
export function scanCtes (maskedStatement) {
  const names = []
  const re = /(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*([A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?AS\s*\(/gi
  let m
  while ((m = re.exec(maskedStatement))) {
    names.push(m[1])
  }
  return names
}

/**
 * 从 FROM / JOIN 子句里抽源与别名（不含子查询列展开）。
 * @returns {Array<{name:string, alias:string, kind:'table'|'cte'|'subquery'}>}
 */
export function extractSources (maskedStatement, ctes) {
  const known = new Set((ctes || []).map(n => n.toLowerCase()))
  const sources = []
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi
  const reserved = new Set([
    'on', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union',
    'left', 'right', 'inner', 'outer', 'cross', 'join', 'full', 'using',
    'set', 'values', 'returning', 'for', 'lock'
  ])
  let m
  while ((m = re.exec(maskedStatement))) {
    const name = m[1]
    let alias = m[2] || ''
    if (alias && reserved.has(alias.toLowerCase())) {
      alias = ''
    }
    const base = name.split('.').pop().toLowerCase()
    sources.push({
      name,
      alias: alias || name.split('.').pop(),
      kind: known.has(base) ? 'cte' : 'table'
    })
  }
  return sources
}

// ---------------------------------------------------------------- 元数据整形

/**
 * 把 `getMetadata` 的树拍平成"补全用的表名数组"（A-4）。
 *
 * 树形（驱动原样返回，前端不重排）：
 *   MySQL: [{name:'db', type:'database', children:[{name:'t', type:'table'}]}]
 *   PG:    [{name:'db', type:'database', children:[{name:'public', type:'schema',
 *             children:[{name:'t', type:'table'}]}]}]
 *
 * @param {Array} metadata
 * @param {string} [database] 只取这个库；缺省取全部库（跨库查询很常见）
 * @returns {string[]} 去重排序后的表名
 */
export function flattenTables (metadata, database) {
  const out = new Set()
  const pick = nodes => {
    for (const node of nodes || []) {
      if (!node || !node.name) {
        continue
      }
      // F0：视图同样能出现在 FROM 里，补全表名时要一起收
      if (node.type === 'table' || node.type === 'view') {
        out.add(node.name)
      } else if (Array.isArray(node.children)) {
        pick(node.children)
      }
    }
  }
  for (const db of metadata || []) {
    if (!db || !db.name) {
      continue
    }
    // 库名大小写：MySQL 在部分平台上大小写敏感，这里宽松比较，
    // 避免"选了库却补不出表"这种看起来像 bug 的空菜单
    if (database && String(db.name).toLowerCase() !== String(database).toLowerCase()) {
      continue
    }
    pick(db.children)
  }
  return Array.from(out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ---------------------------------------------------------------- 列元数据索引（A-5）

function baseName (name) {
  return String(name || '').split('.').pop()
}

/**
 * 把 `listColumns` 的返回整成"补全用的列索引"（A-5）。
 *
 * 契约（§4.3）：`{ tables: [{ table, schema?, columns: [{name,type,pk}] }] }`，
 * MySQL 只有 table，PG 带 schema（同库下可能有同名表）。
 *
 * 一张表挂多个键：`users` / `public.users` / `shop.users` —— 用户可能写
 * `SELECT * FROM shop.users`，也可能只写 `users`。键统一小写，SQL 里标识符
 * 大小写不敏感，不该因为大小写对不上就补不出列。
 */
export function indexColumns (res) {
  const out = {}
  for (const t of (res && res.tables) || []) {
    if (!t || !t.table) {
      continue
    }
    const cols = Array.isArray(t.columns) ? t.columns : []
    if (!cols.length) {
      continue
    }
    const name = String(t.table).toLowerCase()
    out[name] = cols
    for (const scope of [t.schema, t.database]) {
      if (scope) {
        out[String(scope).toLowerCase() + '.' + name] = cols
      }
    }
  }
  return out
}

// 键查表：容忍前端把带引号的标识符（`users` / "users"）当键传进来
function columnBucket (columns, key) {
  if (!key) {
    return null
  }
  const k = String(key).toLowerCase()
  if (columns[k]) {
    return columns[k]
  }
  const bare = k.replace(/^[`"]/, '').replace(/[`"]$/, '')
  return columns[bare] || null
}

/**
 * 解析限定链对应的列桶。顺序即优先级：
 * 1. 直接当别名/表名（老调用方按 alias 建索引，也命中 `users.` 这种纯表名）
 * 2. 别名 → L2 源解析出的表名（`FROM users u WHERE u.`）
 * 3. 整条链（`shop.users` / `schema.table.`）
 *
 * 返回空数组**不是错误**：调用方据此退化为"全库列 + 标注"或关键字（§4.4 降级原则）。
 *
 * @returns {Array<Array<{name:string,type?:string,pk?:boolean}>>}
 */
export function resolveColumnBuckets (qualifier, columns, sources) {
  const cols = columns || {}
  const keys = (qualifier || []).map(s => String(s).toLowerCase())
  const out = []
  const push = b => {
    if (b && out.indexOf(b) < 0) {
      out.push(b)
    }
  }
  if (!keys.length) {
    for (const k of Object.keys(cols)) {
      push(cols[k])
    }
    return out
  }
  const last = keys[keys.length - 1]
  push(columnBucket(cols, last))
  for (const src of sources || []) {
    if (String(src.alias || '').toLowerCase() !== last) {
      continue
    }
    push(columnBucket(cols, baseName(src.name)))
    push(columnBucket(cols, src.name))
  }
  if (keys.length > 1) {
    push(columnBucket(cols, keys.join('.')))
  }
  return out
}

// ---------------------------------------------------------------- L3 场景

// 光标前以这些词结尾 → 期待表名（`DELETE FROM` 因 FROM 尾部命中而被覆盖）
const TABLE_TAIL = /\b(from|join|update|into|table|using|truncate)\s*$/i
// ORDER BY / GROUP BY / PARTITION BY 之后
const ALIAS_TAIL = /\b(order|group|partition)\s+by\s+[^)]*$/i

/**
 * 剥掉末尾的 `ident.` 限定前缀（可多级），只留子句部分。
 * `SELECT * FROM db.` → `SELECT * FROM `；`... WHERE u.` → `... WHERE `
 */
function stripTrailingQualifier (before) {
  let s = before
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const next = s.replace(/(?:[A-Za-z_][\w$]*|`[^`]*`|"[^"]*")\s*\.\s*$/, '')
    if (next === s) {
      return s
    }
    s = next
  }
}

/**
 * CREATE TABLE / ALTER TABLE 的列定义括号内，判断当前槽位。
 * @returns {'name'|'type'|'constraint'|null}
 */
function createTableSlot (before) {
  if (!/^\s*(?:CREATE|ALTER)\s+TABLE\b/i.test(before)) {
    return null
  }
  const open = before.lastIndexOf('(')
  if (open >= 0) {
    const group = before.slice(open + 1)
    // 只看最后一个逗号之后的那一列：`(id int, name ` 光标在第二列列名上，
    // 若按整个 group 数 token 会把"第二个列名"误判成类型位
    const seg = group.slice(group.lastIndexOf(',') + 1)
    const trimmed = seg.trim()
    if (!trimmed) {
      return 'name'
    }
    if (/^(primary|unique|foreign|constraint|key|index|check|fulltext|spatial|like)\b/i.test(trimmed)) {
      return 'constraint'
    }
    // 列名 typed 之后（有尾随空白或已经两个 token）→ 类型位
    const toks = trimmed.split(/\s+/)
    if (toks.length >= 2) {
      return 'type'
    }
    return /\s$/.test(seg) ? 'type' : 'name'
  }
  // 括号外的类型位：ADD [COLUMN] c <type> / MODIFY c <type> / TYPE
  if (/\b(?:add|modify)\s+(?:column\s+)?[A-Za-z_`"][\w$`"]*\s+$/i.test(before)) {
    return 'type'
  }
  if (/\btype\s+$/i.test(before)) {
    return 'type'
  }
  return null
}

/**
 * `INSERT INTO t (` 里取目标表名（含 `db.t` / `schema.t`）。
 * 只在括号未闭合时命中——括号闭合后光标已不在列位。
 * @returns {string|null}
 */
function detectInsertTarget (before) {
  const m = /\binsert\s+into\s+((?:[A-Za-z_`"][\w$`"]*\s*\.\s*)*[A-Za-z_`"][\w$`"]*)\s*\([^()]*$/i.exec(before)
  if (!m) {
    return null
  }
  return m[1].replace(/[`"]/g, '')
}

// ON 之后一旦出现这些词，说明光标已离开连接条件（`ON a.x = b.y WHERE ...`）
const JOIN_BREAK = /\b(where|having|group|order|limit|offset|union|set|returning)\b/i

/**
 * `ON o.user_id = ` → 建议另一侧源的列（§4.5 "成对建议"）。
 *
 * 只认 `qualifier.column =` 形态：不带限定的 `WHERE status = ` 属于值位，
 * 不该弹列名。要求已引用 ≥2 个源，单表 ON 没有"另一侧"。
 *
 * @returns {{alias:string, column:string}|null}
 */
function detectJoinCondition (before, sources) {
  if (!sources || sources.length < 2) {
    return null
  }
  const re = /\bON\b/gi
  let m
  let tail = -1
  while ((m = re.exec(before))) {
    tail = m.index + m[0].length
  }
  if (tail < 0) {
    return null
  }
  const seg = before.slice(tail)
  if (JOIN_BREAK.test(seg) || !/=\s*$/.test(seg)) {
    return null
  }
  const left = /([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*=\s*$/.exec(seg)
  return left ? { alias: left[1], column: left[2] } : null
}

/**
 * 判定光标处的补全场景（§4.5 判定表）。
 *
 * @param {string} text 全文
 * @param {number} cursor 光标偏移
 * @param {{dialect?:object}} opts
 * @returns {{kind:string, prefix:string, from:number, exclusive:boolean,
 *            token:object|null, qualifier:string[], nextChar:string,
 *            statementFrom:number, statementTo:number}}
 */
export function classifyContext (text, cursor, opts) {
  const dialect = (opts && opts.dialect) || null
  const { masked, literals } = maskSqlLiterals(text, dialect)

  const base = {
    kind: 'general',
    prefix: '',
    from: cursor,
    exclusive: false,
    token: null,
    qualifier: [],
    nextChar: text[cursor] || '',
    statementFrom: 0,
    statementTo: text.length
  }

  // 注释与字符串内不弹。**引号标识符例外**：``FROM `us`` 正是要补表名（验收第 7 条），
  // 若把 quotedIdent 也拦掉，带反引号的库根本用不了补全
  const lit = literalAt(literals, cursor)
  if (lit && (lit.kind === 'comment' || lit.kind === 'string')) {
    return { ...base, kind: 'literal' }
  }

  const span = statementSpanAt(masked, cursor)
  const token = parseTrailingIdentifier(text, cursor, dialect)
  const from = token ? token.from : cursor
  // before 用 masked：注释/字符串已抹平，不会出现"-- from us"误导判定
  const before = masked.slice(span.from, token ? token.tokenFrom : cursor)
  // L2 源解析：只在当前语句里解析（多语句时"只按第二条解析"，验收第 8 条）。
  // 解析失败不抛错——正则匹配不到就是空数组，下游退化为关键字
  const statement = masked.slice(span.from, span.to)
  const sources = extractSources(statement, scanCtes(statement))
  const ctx = {
    ...base,
    prefix: token ? token.prefix : '',
    // 替换起点跳过引号，避免"候选全被过滤"（§4.6 第 3 条）
    from,
    token,
    qualifier: token ? token.qualifier : [],
    statementFrom: span.from,
    statementTo: span.to,
    masked,
    before,
    sources
  }

  // `alias.` / `schema.table.` → 列；但 `FROM db.` 补的是表，所以先判定子句尾巴。
  // 尾巴要剥掉末尾的 `ident.` 链再判定，否则 "FROM db." 永远匹配不到 FROM。
  const clauseTail = stripTrailingQualifier(before)
  if (TABLE_TAIL.test(clauseTail) && ctx.qualifier.length <= 1) {
    return { ...ctx, kind: 'table', exclusive: true }
  }
  if (ctx.qualifier.length) {
    return { ...ctx, kind: 'column', exclusive: true }
  }

  const slot = createTableSlot(before)
  if (slot === 'type') {
    return { ...ctx, kind: 'type', exclusive: true }
  }
  if (slot === 'name' || slot === 'constraint') {
    // 列名/约束位：没有值得补的对象，只给关键字，不排他
    return { ...ctx, kind: 'general', exclusive: false }
  }

  if (ALIAS_TAIL.test(before)) {
    return { ...ctx, kind: 'alias', exclusive: false }
  }

  // INSERT INTO t ( → 该表列（列元数据没到位时由 buildCompletions 降级）
  const insertTable = detectInsertTarget(before)
  if (insertTable) {
    return { ...ctx, kind: 'column', exclusive: true, insertTarget: true, insertTable }
  }

  // `ON a.x = ` → 另一侧源的列，且同名列排最前
  const joinCondition = detectJoinCondition(before, sources)
  if (joinCondition) {
    return { ...ctx, kind: 'joinCondition', exclusive: true, joinCondition }
  }

  // CALL / EXEC 之后：本期没有过程元数据，按表名兜底（§4.5 最后一行）
  if (/\b(?:call|exec(?:ute)?)\s*$/i.test(before)) {
    return { ...ctx, kind: 'table', exclusive: true, callTarget: true }
  }

  return ctx
}

// §4.5 评分表：数值越小越靠前
export const KIND_PRIORITY = {
  joinCondition: 0,
  column: 100,
  selectAlias: 120,
  relatedTable: 150,
  table: 200,
  cte: 200,
  subqueryAlias: 200,
  type: 300,
  // electerm 扩展：内置函数略微优于关键字（敲 count 时不想先看到 CASE）
  function: 350,
  keyword: 400,
  pseudoColumn: 500
}

// 大小写只作用于 SQL 词（关键字/函数/类型）；表名列名保持原样
const SQL_WORD_KINDS = new Set(['keyword', 'function', 'type'])

function matchRank (label, prefix) {
  if (!prefix) {
    return 0
  }
  const l = label.toLowerCase()
  const p = prefix.toLowerCase()
  if (l.startsWith(p)) {
    return 0
  }
  if (l.includes(p)) {
    return 1
  }
  // 子序列：usr → user_id
  let i = 0
  for (const ch of l) {
    if (ch === p[i]) {
      i++
      if (i === p.length) {
        return 2
      }
    }
  }
  return 3
}

function applyCase (word, mode) {
  return mode === 'upper' ? word.toUpperCase() : word.toLowerCase()
}

/**
 * 前缀已经明确表达了大小写意图时，跟用户走（敲 `SEL` 就是要大写）。
 * 只有全大写或全小写才视为"有意"，混合大小写按配置。
 */
function resolveCase (prefix, mode) {
  // 只有全大写是有意信号（`SEL` 明确要 SELECT）；
  // 全小写是最常见的输入习惯，不能据此覆盖 upper 配置
  if (prefix && /[A-Z]/.test(prefix) && prefix === prefix.toUpperCase()) {
    return 'upper'
  }
  return mode
}

/**
 * 产出补全候选（§4.5 评分 + §4.6 模型）。
 *
 * @param {object} ctx classifyContext 的返回值
 * @param {{dialect?:object, keywordCase?:string, tables?:string[],
 *          columns?:object, max?:number}} opts
 *   tables: 当前库已加载的表名（A-4 接 metadata）
 *   columns: { [tableOrAliasLower]: Array<{name,type,pk}> }（A-5 接 listColumns）
 * @returns {{from:number, options:Array, exclusive:boolean}|null}
 */
export function buildCompletions (ctx, opts) {
  const o = opts || {}
  const dialect = o.dialect
  if (!ctx || ctx.kind === 'literal' || !dialect) {
    return null
  }

  const max = o.max || 50
  const mode = resolveCase(ctx.prefix || '', o.keywordCase === 'upper' ? 'upper' : 'lower')
  const tables = Array.isArray(o.tables) ? o.tables : []
  const columns = o.columns || {}

  const items = []
  const seen = new Set()

  const add = (raw, kind, type, detail) => {
    // SQL 词按词面去重：IF / LEFT / TRUNCATE 同时挂在关键字与内置函数表里，
    // 不去重会在菜单里出现两条一模一样的项
    const bucket = SQL_WORD_KINDS.has(kind) ? 'word' : kind
    const key = bucket + ':' + String(raw).toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    const word = SQL_WORD_KINDS.has(kind) ? applyCase(raw, mode) : raw
    const option = {
      label: word,
      apply: word,
      type,
      kind,
      priority: KIND_PRIORITY[kind] === undefined ? 400 : KIND_PRIORITY[kind]
    }
    if (detail) {
      option.detail = detail
    }
    items.push(option)
  }

  const addStatic = () => {
    for (const kw of dialect.keywords) {
      add(kw, 'keyword', 'keyword')
    }
    for (const fn of dialect.builtin) {
      add(fn, 'function', 'function', '()')
    }
  }
  const addTypes = () => {
    for (const t of dialect.types) {
      add(t, 'type', 'type')
    }
  }
  const addTables = () => {
    for (const t of tables) {
      add(t, 'table', 'class')
    }
  }
  const colDetail = col => typeof col === 'string'
    ? ''
    : [col.type, col.pk ? 'PK' : ''].filter(Boolean).join(' · ')

  // prefix 给了就产出 `alias.column`：多表 JOIN 时只给裸列名，用户分不清来自哪张表
  const addColumnBuckets = (buckets, prefix) => {
    for (const bucket of buckets || []) {
      for (const col of bucket || []) {
        const name = typeof col === 'string' ? col : col.name
        if (!name) {
          continue
        }
        add(prefix ? prefix + '.' + name : name, 'column', 'property', colDetail(col))
      }
    }
    return (buckets || []).length > 0
  }

  const addColumns = (qualifier) => addColumnBuckets(
    resolveColumnBuckets(qualifier, columns, ctx.sources)
  )

  // 源没命中（表名拼错 / 元数据未到）时的兜底：全库列 + detail 标出来源表，
  // 比直接掉到关键字有用得多，也不会出现空菜单（§4.4 降级原则）
  const addAllColumns = () => {
    let any = false
    for (const key of Object.keys(columns)) {
      for (const col of columns[key] || []) {
        const name = typeof col === 'string' ? col : col.name
        if (!name) {
          continue
        }
        const detail = [colDetail(col), key].filter(Boolean).join(' · ')
        add(name, 'column', 'property', detail)
        any = true
      }
    }
    return any
  }

  let exclusive = !!ctx.exclusive
  switch (ctx.kind) {
    case 'type':
      addTypes()
      break
    case 'table':
      addTables()
      break
    case 'column': {
      // INSERT INTO t ( 只要 t 的列；其余按限定链解析（别名经 L2 源解析映射到表名）
      const q = (ctx.insertTarget && !ctx.qualifier.length)
        ? [ctx.insertTable].filter(Boolean)
        : ctx.qualifier
      if (addColumnBuckets(resolveColumnBuckets(q, columns, ctx.sources))) {
        break
      }
      if (addAllColumns()) {
        break
      }
      // 连列元数据都没有：退化为关键字，并取消排他
      addStatic()
      exclusive = false
      break
    }
    case 'joinCondition': {
      const j = ctx.joinCondition || {}
      const left = String(j.alias || '').toLowerCase()
      const others = (ctx.sources || []).filter(
        s => String(s.alias || '').toLowerCase() !== left
      )
      let any = false
      for (const src of others) {
        const alias = String(src.alias || '')
        if (!alias) {
          continue
        }
        for (const bucket of resolveColumnBuckets([alias], columns, ctx.sources)) {
          for (const col of bucket || []) {
            const name = typeof col === 'string' ? col : col.name
            if (!name) {
              continue
            }
            // 同名列（典型的 user_id = user_id）排最前：joinCondition priority 0
            const same = name.toLowerCase() === String(j.column || '').toLowerCase()
            add(alias + '.' + name, same ? 'joinCondition' : 'column',
              'property', colDetail(col))
            any = true
          }
        }
      }
      if (!any) {
        // 没有列元数据：退到表名 + 关键字，`= ` 后面绝不弹空菜单
        addTables()
        addStatic()
        exclusive = false
      }
      break
    }
    case 'alias':
      addColumns([])
      addStatic()
      break
    default: {
      addStatic()
      addTables()
      // A-5 默认态：把已引用源的列以 `alias.column` 形式摆出来
      const done = new Set()
      for (const src of ctx.sources || []) {
        const alias = String(src.alias || '')
        const key = alias.toLowerCase()
        if (!alias || done.has(key)) {
          continue
        }
        done.add(key)
        addColumnBuckets(resolveColumnBuckets([alias], columns, ctx.sources), alias)
      }
    }
  }

  // 排他类目为空 → 退化为全量静态候选，绝不返回空菜单
  if (!items.length) {
    addStatic()
    exclusive = false
  }

  const prefix = ctx.prefix || ''
  const filtered = items.filter(it => matchRank(it.label, prefix) < 3)
  const pool = filtered.length ? filtered : items
  pool.sort((a, b) => (
    a.priority - b.priority ||
    matchRank(a.label, prefix) - matchRank(b.label, prefix) ||
    a.label.length - b.label.length ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
  ))

  const token = ctx.token
  const quoted = !!(token && token.quoted)
  // 带引号的候选在插入时补回引号；已闭合则不再补
  const options = pool.slice(0, max).map(it => {
    const out = { ...it }
    if (quoted && token.quoteChar) {
      out.apply = it.apply + token.quoteChar
    } else if (it.kind === 'function' && ctx.nextChar !== '(') {
      out.apply = it.apply + '()'
    }
    return out
  })

  return {
    from: ctx.from,
    options,
    exclusive
  }
}
