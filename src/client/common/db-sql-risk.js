/**
 * E1 危险 SQL 分级器（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §6.1）
 *
 * 为什么是"纯函数 + 零依赖"：
 * - 分级结论要能被单测逐条钉死（node:test 用 vm 直接跑源码，用 data: URL 加载），
 *   任何 window/store/i18n 依赖都会让它不可测；
 * - 同一份判定将来要能被主进程的二次校验复用，不能绑死渲染层。
 *
 * 边界声明：分级是**给人看的闸门**，不是安全边界。它只回答"这条语句会不会无意
 * 改到大片数据或结构"，真正的写权限仍由主进程白名单（checkWritable）决定。
 *
 * 为什么 reasons 是中文人话而不是 i18n key：
 * 弹窗的主要目的就是"让人看懂为什么拦我"，而本模块不能碰 window.translate
 * （node 环境下没有 window）。代价是非中文界面下理由行仍显示中文，
 * 已记入批次遗留项（见汇报"遗留/风险"）。
 */

// 等级枚举：按严重度递增（rank 见 LEVEL_RANK）
export const RISK_READ = 'read'
export const RISK_TRANSACTION = 'transaction'
export const RISK_WRITE = 'write'
export const RISK_DDL = 'ddl'
export const RISK_DANGEROUS = 'dangerous'
export const RISK_UNKNOWN = 'unknown'

export const RISK_LEVELS = [
  RISK_READ,
  RISK_TRANSACTION,
  RISK_WRITE,
  RISK_UNKNOWN,
  RISK_DDL,
  RISK_DANGEROUS
]

// 多语句取最高级时的偏序。
// 为什么 unknown(3) 排在 write(2) 之上、ddl(4) 之上再放 dangerous：
// unknown 意味着"我没看懂"，必须每次都问（不可被"低风险写"静音），所以它得压过 write；
// 但 ddl/dangerous 是已经认出来的高危类型，理由更具体，应压过 unknown —— 否则
// `ALTER TABLE x; ??garbage` 这种批次会退化成"无法识别"，把真正的结构变更理由吞掉。
const LEVEL_RANK = {
  read: 0,
  transaction: 1,
  write: 2,
  unknown: 3,
  ddl: 4,
  dangerous: 5
}

export function levelRank (level) {
  const v = LEVEL_RANK[level]
  return typeof v === 'number' ? v : LEVEL_RANK.unknown
}

// ---- 方言差异 ----

const PG_NAMES = ['postgres', 'postgresql', 'pg']

/**
 * 方言能力表。
 * mysql 家族（mysql / tidb / oceanbase / mariadb）共享同一套词法约定；
 * 其余一律按 PG 处理（本仓库只有 mysql / postgres / redis 三个引擎走本模块，
 * redis 由调用方跳过）。
 * @param {string} dialect 引擎标识
 * @returns {{pg: boolean, backslashEscape: boolean, backtick: boolean,
 *   hashComment: boolean, dollarQuote: boolean, nestedBlockComment: boolean,
 *   versionComment: boolean, dashCommentNeedsSpace: boolean}}
 */
function dialectFlags (dialect) {
  const d = String(dialect || 'mysql').toLowerCase()
  const pg = PG_NAMES.includes(d)
  return {
    pg,
    // MySQL 默认开 NO_BACKSLASH_ESCAPES=off，`'a\'b'` 是一个字符串；
    // PG 标准字符串里 `\` 不是转义符（standard_conforming_strings=on），
    // 只有 E'...' 才启用反斜杠转义
    backslashEscape: !pg,
    // 反引号标识符只有 MySQL 系有
    backtick: !pg,
    // `#` 行注释只有 MySQL 系有；PG 里 `#` 是运算符（几何/位运算），当注释吃会吞掉真语句
    hashComment: !pg,
    // 美元引用只有 PG 有
    dollarQuote: pg,
    // PG 的块注释可以嵌套：`/* a /* b */ c */`，mysql 遇到第一个 */ 就结束
    nestedBlockComment: pg,
    // MySQL/MariaDB 的 `/*!...*/`、`/*M!...*/` 是会被服务端**执行**的版本注释
    // （PG 里同样写法只是普通注释），见 scanSql 里的处理
    versionComment: !pg,
    // MySQL 的 `--` 必须后跟空白才是注释：`SELECT 1--1` 是两个减号，
    // 当成注释会把这条语句后半段整段吃掉（连带吃掉可能的 DELETE）
    dashCommentNeedsSpace: !pg
  }
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/
const WHITE = /\s/

function isWordStart (ch) {
  return !!ch && WORD_START.test(ch)
}

function isWordPart (ch) {
  return !!ch && WORD_PART.test(ch)
}

// $tag$ / $$（tag 可为空）。$1 这类位置参数不匹配（首字符必须是字母/下划线）
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

/**
 * 扫描引号/注释区间，返回与输入**等长**的掩码串。
 * 等长是关键：所有偏移（start/end/WHERE 位置）在掩码与原文之间可以直接互用。
 * @param {string} sql 原始 SQL
 * @param {string} dialect 引擎
 * @param {boolean} keepLiterals true=只屏蔽注释（保留字符串原文，供 WHERE 恒真判定）；
 *   false=注释与字符串/标识符一起屏蔽（供关键字识别）
 * @returns {string}
 */
function scanSql (sql, dialect, keepLiterals) {
  const src = String(sql === null || sql === undefined ? '' : sql)
  const n = src.length
  const flags = dialectFlags(dialect)
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = src[i]
  }
  // 替换为空格但保留换行：偏移不变，且任何按行做的后续处理不会错位
  const blank = (from, to) => {
    const stop = to > n ? n : to
    for (let k = from; k < stop; k++) {
      const c = src[k]
      out[k] = c === '\n' || c === '\r' ? c : ' '
    }
  }
  let i = 0
  while (i < n) {
    const ch = src[i]
    const nx = i + 1 < n ? src[i + 1] : ''
    // 行注释 --
    if (ch === '-' && nx === '-') {
      const after = i + 2 < n ? src[i + 2] : ''
      const isComment = flags.dashCommentNeedsSpace
        ? after === '' || WHITE.test(after)
        : true
      if (isComment) {
        let j = i + 2
        while (j < n && src[j] !== '\n' && src[j] !== '\r') {
          j++
        }
        blank(i, j)
        i = j
        continue
      }
      i++
      continue
    }
    // # 行注释（仅 mysql 家族）
    if (flags.hashComment && ch === '#') {
      let j = i + 1
      while (j < n && src[j] !== '\n' && src[j] !== '\r') {
        j++
      }
      blank(i, j)
      i = j
      continue
    }
    // 块注释 /* ... */
    if (ch === '/' && nx === '*') {
      // MySQL 的版本注释 /*!50000 ... */ 与 MariaDB 的 /*M!100100 ... */ 是**会被执行**的
      // SQL（mysqldump 产物里全是 `/*!40000 ALTER TABLE t DISABLE KEYS */`）。
      // 若按普通注释掩掉，粘一份 dump 就会静默跑 DDL —— 只读模式下主进程白名单能拦，
      // 但用户关掉只读后这里就是唯一一道闸门。
      // 做法：只掩开标签（`/*!` / `/*M!` 连版本号），内容照常参与词法分析；
      // 结尾的 `*/` 留成两个普通字符（不是词首，不影响定级）。
      // 已知取舍：内容里若含 `;`，切分会在那里断开（mysqldump 的存储过程体），
      // 断错只会让判定更保守（多问一次），不会少拦。
      if (flags.versionComment) {
        const c2 = src[i + 2] || ''
        const c3 = src[i + 3] || ''
        if (c2 === '!' || (c2 === 'M' && c3 === '!')) {
          let k = i + 2
          if (src[k] === 'M') {
            k++
          }
          if (src[k] === '!') {
            k++
          }
          while (k < n && src[k] >= '0' && src[k] <= '9') {
            k++
          }
          blank(i, k)
          i = k
          continue
        }
      }
      let j = i + 2
      let depth = 1
      while (j < n) {
        if (flags.nestedBlockComment && src[j] === '/' && src[j + 1] === '*') {
          depth++
          j += 2
          continue
        }
        if (src[j] === '*' && src[j + 1] === '/') {
          depth--
          j += 2
          if (depth === 0) {
            break
          }
          continue
        }
        j++
      }
      blank(i, Math.min(j, n))
      i = Math.min(j, n)
      continue
    }
    // 版本注释的**结束**标记 `*/`：开标签被单独掩掉了（见上面的版本注释分支），
    // 这个尾巴如果留在掩码里，会把 WHERE 条件的文本污染成 ` 1=1 */`，
    // 恒真判定（NUMBER_CMP / TRUE_LITERAL）就匹配不上，dangerous 会降级成 write。
    // 注释外的 `*/` 只可能来自这种"半掩"的版本注释（非法 SQL 才有别的来源），
    // 所以在掩码里一律抹平，不影响原文与展示。
    if (ch === '*' && nx === '/') {
      blank(i, i + 2)
      i += 2
      continue
    }
    // 字符串 / 标识符引用
    if (ch === "'" || ch === '`' || ch === '"') {
      if (ch === '`' && !flags.backtick) {
        // PG 没有反引号标识符，当成普通字符交给后续逻辑
        i++
        continue
      }
      let backslash = flags.backslashEscape
      // PG 的 E'...'：E 必须是独立词（不能是 name 的最后一个字母）
      if (ch === "'" && flags.pg && i > 0 && (src[i - 1] === 'E' || src[i - 1] === 'e')) {
        const before = i - 2 >= 0 ? src[i - 2] : ''
        backslash = before === '' || !isWordPart(before)
      }
      const end = scanQuoted(src, i, ch, backslash)
      if (!keepLiterals) {
        blank(i, end)
      }
      i = end
      continue
    }
    // 美元引用 $tag$ ... $tag$（PG）
    if (flags.dollarQuote && ch === '$') {
      const tag = readDollarTag(src, i)
      if (tag) {
        const close = src.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        if (!keepLiterals) {
          blank(i, end)
        }
        i = end
        continue
      }
    }
    i++
  }
  return out.join('')
}

/**
 * 从 start（引号本身）扫到闭合引号之后。
 * 处理 `''` / `""` / ``` `` ``` 双写转义与（可选）反斜杠转义；
 * 未闭合时返回串尾（宽松策略：SQL 还没写完时不能抛错）。
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
 * 读取起始位置的美元引用开标签（如 `$tag$`、`$$`）。
 * @param {string} src 原文
 * @param {number} i `$` 的下标
 * @returns {string} 开标签（含两侧 $），不匹配返回空串
 */
function readDollarTag (src, i) {
  // 标签长度有限（PG 允许长标签，但实际不会超过几十字符），截 64 字符足够且避免整串正则
  const head = src.slice(i, Math.min(i + 64, src.length))
  const m = DOLLAR_TAG.exec(head)
  return m ? m[0] : ''
}

/**
 * 把注释与字符串字面量替换成等长空格（保留换行），防止"注释藏语句"与
 * `SELECT 'DROP TABLE x'` 这类字面量误判。
 * @param {string} sql 原始 SQL
 * @param {string} dialect 引擎（mysql/postgres；缺省按 mysql 处理）
 * @returns {string} 与输入等长的掩码串
 */
export function maskSqlLiterals (sql, dialect) {
  return scanSql(sql, dialect, false)
}

// 只屏蔽注释、保留字面量（WHERE 恒真判定要用字面量本身）
function maskCommentsOnly (sql, dialect) {
  return scanSql(sql, dialect, true)
}

// ---- 切分 ----

/**
 * 引号/转义感知的语句切分。
 * 实现要点：切分点取自**掩码串**里的分号，切片取自**原文** —— 这样注释/字符串里的
 * 分号不会误切，而返回的 text 仍是用户原样输入的语句（可以拿去展示）。
 * @param {string} sql 原始 SQL
 * @param {string} dialect 引擎
 * @returns {Array<{text: string, start: number, end: number}>} 空语句（含只有注释/空白的段）被丢弃
 */
export function splitStatements (sql, dialect) {
  const src = String(sql === null || sql === undefined ? '' : sql)
  const mask = maskSqlLiterals(src, dialect)
  const out = []
  let from = 0
  for (let i = 0; i <= mask.length; i++) {
    const atEnd = i === mask.length
    if (atEnd || mask[i] === ';') {
      pushStatement(out, src, mask, from, i)
      from = i + 1
    }
  }
  return out
}

/**
 * 归一化单段并压入结果（去掉首尾空白与"只有注释"的段）。
 * @param {Array} out 结果数组
 * @param {string} src 原文
 * @param {string} mask 掩码串（与原文等长）
 * @param {number} from 段起点
 * @param {number} to 段终点（不含）
 */
function pushStatement (out, src, mask, from, to) {
  let s = from
  let e = to
  while (s < e && WHITE.test(src[s])) {
    s++
  }
  while (e > s && WHITE.test(src[e - 1])) {
    e--
  }
  if (e <= s) {
    return
  }
  // 整段被掩码成空白 = 只有注释（`/* note */;`）：没有可执行内容，
  // 若保留会被判成 unknown 而白弹一次确认
  if (!mask.slice(s, e).trim()) {
    return
  }
  out.push({ text: src.slice(s, e), start: s, end: e })
}

// ---- 词法 ----

/**
 * 扫出所有"词"（标识符/关键字）及其括号深度。
 * 只在掩码串上做：注释与字符串已变成空白，所以字符串里的 `WHERE`/`(` 不会干扰深度。
 * @param {string} mask 掩码串
 * @returns {Array<{v: string, upper: string, start: number, end: number, depth: number}>}
 */
function scanWords (mask) {
  const out = []
  const n = mask.length
  let depth = 0
  let i = 0
  while (i < n) {
    const ch = mask[i]
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = depth > 0 ? depth - 1 : 0
      i++
      continue
    }
    if (isWordStart(ch)) {
      let j = i
      while (j < n && isWordPart(mask[j])) {
        j++
      }
      const v = mask.slice(i, j)
      out.push({ v, upper: v.toUpperCase(), start: i, end: j, depth })
      i = j
      continue
    }
    i++
  }
  return out
}

/**
 * 取顶层（深度 0）的词；整体被括号包住的语句（`(SELECT 1)`）没有顶层词，
 * 退回全量，避免被判成 unknown。
 * @param {Array} words scanWords 结果
 * @returns {Array}
 */
function topWords (words) {
  const top = words.filter(w => w.depth === 0)
  return top.length ? top : words
}

// ---- 恒真条件判定 ----

const TRUE_LITERAL = /^(true|t|1)$/i
const FALSE_LITERAL = /^(false|f|0)$/i
const NUMBER_CMP = /^([+-]?\d+(?:\.\d+)?)\s*(=|<>|!=|>=|<=|>|<)\s*([+-]?\d+(?:\.\d+)?)$/
// 字符串字面量比较：只认"同引号、内容全等"的简单形态。
// `'a''b'='a''b'` 这类双写转义会落到下面 return false（判 write 而非 dangerous）——
// 这条路径只在用户手写恒真条件时才出现，真实场景近乎不存在，且误判方向是
// "少拦一层"而非"多拦"，可接受
const STRING_CMP = /^('([^']*)'|"([^"]*)")\s*(=|<>|!=)\s*('([^']*)'|"([^"]*)")$/

/**
 * 比较两侧数值（供 `2>1` 这类恒真条件判定）。
 * @param {number} a 左值
 * @param {string} op 运算符
 * @param {number} b 右值
 * @returns {boolean}
 */
function compareNumber (a, op, b) {
  switch (op) {
    case '=': return a === b
    case '<>':
    case '!=': return a !== b
    case '>': return a > b
    case '<': return a < b
    case '>=': return a >= b
    case '<=': return a <= b
    default: return false
  }
}

/**
 * 判断 `( ... )` 是否"外层括号真的一直包到底"（而不是 `(a) AND (b)` 这种）。
 * @param {string} s 已 trim 的串
 * @returns {boolean}
 */
function isWrapped (s) {
  if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') {
    return false
  }
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0 && i !== s.length - 1) {
        return false
      }
    }
  }
  return depth === 0
}

/**
 * 去掉外层括号与多余空白。
 * @param {string} s 条件片段
 * @returns {string}
 */
function unwrap (s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim()
  while (isWrapped(t)) {
    t = t.slice(1, -1).replace(/\s+/g, ' ').trim()
  }
  return t
}

/**
 * 按顶层关键字切分（跳过括号内与词内匹配）。
 * @param {string} s 条件片段
 * @param {string} kw 大写关键字（AND / OR）
 * @returns {Array<string>}
 */
function splitTopLevel (s, kw) {
  const up = s.toUpperCase()
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = depth > 0 ? depth - 1 : 0
      i++
      continue
    }
    if (depth === 0 && up.startsWith(kw, i)) {
      const before = i === 0 ? '' : s[i - 1]
      const after = s[i + kw.length] || ''
      const leftOk = !before || !isWordPart(before)
      const rightOk = !after || !isWordPart(after)
      if (leftOk && rightOk) {
        parts.push(s.slice(start, i))
        i += kw.length
        start = i
        continue
      }
    }
    i++
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * 单个比较式是否恒真。
 * @param {string} cond 已经过 unwrap 的条件
 * @returns {boolean}
 */
function isAlwaysTrueLeaf (cond) {
  const t = unwrap(cond)
  if (!t) {
    return false
  }
  if (TRUE_LITERAL.test(t)) {
    return true
  }
  if (FALSE_LITERAL.test(t)) {
    return false
  }
  const num = NUMBER_CMP.exec(t)
  if (num) {
    return compareNumber(Number(num[1]), num[2], Number(num[3]))
  }
  const str = STRING_CMP.exec(t)
  if (str) {
    // 分组：1=左字面量整体 2=左单引号内容 3=左双引号内容 4=运算符
    //       5=右字面量整体 6=右单引号内容 7=右双引号内容
    const leftSingle = str[2] !== undefined
    const rightSingle = str[6] !== undefined
    let equal = false
    if (leftSingle && rightSingle) {
      equal = str[2] === str[6]
    } else if (!leftSingle && !rightSingle) {
      equal = str[3] === str[7]
    }
    // 引号类型不同（'a' = "a"）不做恒真判定：PG 里双引号是标识符、
    // MySQL 里是字符串，语义不一致，宁可当普通条件（判 write）也不误报
    return str[4] === '=' ? equal : !equal
  }
  return false
}

/**
 * WHERE 条件是否恒真（`1=1` / `true` / `1` / `'a'='a'` / `2>1`，含 AND/OR 组合）。
 * 只做保守判定：认不出来的一律当"非常量"（判 write），
 * 因为误判 dangerous 会逼用户把安全带关掉，代价比漏判更大。
 * @param {string} cond 条件原文（注释已屏蔽）
 * @returns {boolean}
 */
export function isAlwaysTrueCondition (cond) {
  const t = unwrap(cond)
  if (!t) {
    return false
  }
  const ors = splitTopLevel(t, 'OR')
  if (ors.length > 1) {
    // OR 任一侧恒真即整体恒真（`id=1 OR 1=1` 会命中全表）
    return ors.some(isAlwaysTrueCondition)
  }
  const ands = splitTopLevel(t, 'AND')
  if (ands.length > 1) {
    return ands.every(isAlwaysTrueCondition)
  }
  return isAlwaysTrueLeaf(t)
}

// ---- 分类 ----

// 决定语义的首词（WITH 已解析后的"主语句"）
const MAIN_STATEMENT_WORDS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'VALUES', 'TABLE'
])

// 只读语句
const READ_WORDS = new Set([
  'SELECT', 'EXPLAIN', 'SHOW', 'DESC', 'DESCRIBE', 'VALUES', 'TABLE', 'ANALYZE',
  'HELP', 'PRAGMA'
])

// 事务控制：不改数据、且高频（每条 BEGIN/COMMIT 都弹一次输库名等于逼用户长开 bypass）。
// 刻意不收 PREPARE/EXECUTE：`PREPARE s FROM 'DELETE FROM t'` 能把高危语句藏进字符串，
// 这类语句落到 unknown 反而更安全
const TRANSACTION_WORDS = new Set([
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'END', 'ABORT'
])

// 结构变更
const DDL_WORDS = new Set(['CREATE', 'ALTER', 'RENAME', 'COMMENT'])

// 高危：不可回滚 / 影响实例或权限
const DANGEROUS_WORDS = new Set([
  'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'FLUSH', 'SHUTDOWN', 'KILL', 'RESET',
  'INSTALL', 'UNINSTALL', 'PURGE'
])

// 补全"语句是 DROP TABLE"里的第二个词（只用于展示，不参与定级）
const OBJECT_WORDS = new Set([
  'TABLE', 'TABLES', 'DATABASE', 'DATABASES', 'SCHEMA', 'INDEX', 'VIEW', 'COLUMN',
  'TRIGGER', 'PROCEDURE', 'FUNCTION', 'SEQUENCE', 'TYPE', 'USER', 'ROLE',
  'PRIVILEGES', 'GLOBAL', 'PERSIST', 'SESSION', 'SAVEPOINT', 'TRANSACTION', 'LOG'
])

// WHERE 之后表示"条件结束"的顶层子句
const STOP_AFTER_WHERE = new Set([
  'ORDER', 'LIMIT', 'OFFSET', 'RETURNING', 'FOR', 'PROCEDURE', 'INTO', 'WINDOW',
  'FETCH', 'LOCK'
])

const DANGEROUS_HINTS = {
  DROP: '会删除数据库对象，且不可回滚',
  TRUNCATE: '会清空整表数据，且不可回滚',
  GRANT: '会改变账号权限',
  REVOKE: '会收回账号权限',
  FLUSH: '会刷新/清空服务端缓存与状态',
  SHUTDOWN: '会关闭数据库服务',
  KILL: '会中断其它会话',
  RESET: '会重置服务端状态',
  PURGE: '会物理清除日志/数据',
  INSTALL: '会安装服务端组件',
  UNINSTALL: '会卸载服务端组件'
}

/**
 * 拼出展示用的语句名（`DROP TABLE` / `SET GLOBAL` / `ALTER TABLE`）。
 * @param {Array} tops 顶层词
 * @param {number} idx 首词下标
 * @returns {string}
 */
function displayName (tops, idx) {
  const first = tops[idx]
  if (!first) {
    return ''
  }
  const next = tops[idx + 1]
  if (next && OBJECT_WORDS.has(next.upper)) {
    return first.upper + ' ' + next.upper
  }
  return first.upper
}

/**
 * 在顶层词里找 WHERE 的位置。
 * @param {Array} tops 顶层词
 * @param {number} from 从第几个词开始找（UPDATE 要跳过 SET 之前可能出现的 WHERE）
 * @returns {number} 下标，找不到返回 -1
 */
function findTopWord (tops, word, from) {
  const start = from || 0
  for (let i = start; i < tops.length; i++) {
    if (tops[i].upper === word) {
      return i
    }
  }
  return -1
}

/**
 * 判定 UPDATE / DELETE 的 WHERE 情况。
 * @param {string} text 语句原文
 * @param {string} dialect 引擎
 * @param {Array} tops 顶层词
 * @param {string} keyword UPDATE / DELETE
 * @returns {{level: string, reasons: Array<string>}}
 */
function classifyWhere (text, dialect, tops, keyword) {
  const wi = findTopWord(tops, 'WHERE', 1)
  if (wi === -1) {
    return {
      level: RISK_DANGEROUS,
      reasons: [keyword + ' 没有 WHERE 子句，会命中全表']
    }
  }
  const whereWord = tops[wi]
  const rest = tops.slice(wi + 1)
  const stop = rest.find(w => STOP_AFTER_WHERE.has(w.upper))
  const condEnd = stop ? stop.start : text.length
  // 条件切片取自"只屏蔽注释"的文本：字面量必须保留，否则 `WHERE 'a'='a'` 里
  // 两侧的值都变成空白，恒真条件就判不出来了。
  // 末尾再兜一次 `*/`：`/*!50000 DELETE … WHERE 1=1 */` 这种版本注释，开标签被掩掉了，
  // 收尾的 `*/` 曾经留在条件文本里（`" 1=1 */"`）让恒真判定失效、dangerous 降级成 write。
  // scanSql 已经在掩码层抹平散落的 `*/`，这里是消费点的第二道防线：
  // 真 SQL 的条件末尾不会自然出现 `*/`（块注释已掩成空格，字符串里的也已被掩掉），
  // 所以这条 strip 不会误伤任何正常条件。
  const condText = maskCommentsOnly(text, dialect)
    .slice(whereWord.end, condEnd)
    .replace(/\s*\*\/\s*$/, ' ')
  if (!condText.trim()) {
    return {
      level: RISK_DANGEROUS,
      reasons: [keyword + ' 的 WHERE 子句为空，等价于全表操作']
    }
  }
  if (isAlwaysTrueCondition(condText)) {
    return {
      level: RISK_DANGEROUS,
      reasons: [keyword + ' 的 WHERE 条件恒为真（如 1=1），会命中全表']
    }
  }
  return {
    level: RISK_WRITE,
    reasons: [keyword + ' 会修改数据（带 WHERE 条件）']
  }
}

// EXPLAIN 的选项词：用来在 `EXPLAIN … 真语句` 之间找到真正的语句起点。
// 括号形式的选项（`EXPLAIN (ANALYZE, BUFFERS) DELETE …`）靠 depth 跳过，不在这里列
const EXPLAIN_OPTION_WORDS = new Set([
  'ANALYZE', 'ANALYSE', 'VERBOSE', 'COSTS', 'SETTINGS', 'BUFFERS', 'WAL',
  'TIMING', 'SUMMARY', 'FORMAT', 'TRUE', 'FALSE', 'ON', 'OFF', 'JSON', 'TEXT',
  'XML', 'YAML', 'GENERIC_PLAN',
  // TREE 是 `FORMAT=TREE` 的取值，也是 MySQL `EXPLAIN ANALYZE` 的默认格式。
  // 这里的词表只用来"跳过选项、找到真正的主语句"，所以 FORMAT 的取值词都必须列全，
  // 少一个就会把该取值当成主语句（`… FORMAT=TREE DELETE` 会被误判成 read）。
  'TREE'
])

/**
 * 解析 EXPLAIN 语句：是否 ANALYZE 模式 + 被解释的主语句词。
 *
 * 为什么要专门处理：PG 的 `EXPLAIN ANALYZE DELETE FROM t` **会真正执行**这条 DELETE
 * （ANALYZE 只是附加执行统计），设计表把 EXPLAIN 一律当 read 在这一点上不成立。
 *
 * 主语句的取法：EXPLAIN 之后第一个**深度 0 且不是选项词**的词。
 * 早先版本用"第一个主语句关键字"，漏掉了 `EXPLAIN ANALYZE EXECUTE p`、
 * `EXPLAIN ANALYZE CREATE TABLE n AS SELECT 1`（PG 会真建表，旧版还会被里面的
 * SELECT 骗成 read）—— 改成"第一个非选项词"后这两种都能落到各自的分支。
 * @param {Array} words scanWords 结果
 * @returns {{analyze: boolean, target: Object|null}}
 *   analyze=true 表示语句会被真正执行；target=null 表示 ANALYZE 了但认不出主语句
 */
function explainAnalyzeInfo (words) {
  const exIdx = words.findIndex(w => w.upper === 'EXPLAIN')
  if (exIdx === -1) {
    return { analyze: false, target: null }
  }
  let targetIdx = -1
  for (let k = exIdx + 1; k < words.length; k++) {
    const w = words[k]
    // 括号里的选项（含 `(ANALYZE, BUFFERS)`）不参与"主语句起点"的判定
    if (w.depth !== 0) {
      continue
    }
    if (EXPLAIN_OPTION_WORDS.has(w.upper)) {
      continue
    }
    targetIdx = k
    break
  }
  const stop = targetIdx === -1 ? words.length : targetIdx
  let analyze = false
  for (let k = exIdx + 1; k < stop; k++) {
    const u = words[k].upper
    if (u === 'ANALYZE' || u === 'ANALYSE') {
      analyze = true
      break
    }
  }
  return {
    analyze,
    target: targetIdx === -1 ? null : words[targetIdx]
  }
}

/**
 * 单条语句分级。
 * @param {string|{text: string}} stmt 语句（字符串或 splitStatements 的元素）
 * @param {string} dialect 引擎
 * @returns {{level: string, firstKeyword: string, reasons: Array<string>}}
 */
export function classifyStatement (stmt, dialect) {
  const raw = typeof stmt === 'string'
    ? stmt
    : String((stmt && stmt.text) || '')
  const text = raw.trim()
  if (!text) {
    // 空语句没有可执行内容：判 read（不触发确认），由调用方按空批次处理
    return { level: RISK_READ, firstKeyword: '', reasons: [] }
  }
  const mask = maskSqlLiterals(text, dialect)
  const words = scanWords(mask)
  if (!words.length) {
    return { level: RISK_READ, firstKeyword: '', reasons: [] }
  }
  const tops = topWords(words)
  let idx = 0
  let keyword = tops[0].upper
  // WITH：CTE 体在括号里（深度 > 0），顶层第一个主语句词就是真正决定语义的那个
  if (keyword === 'WITH') {
    const mainIdx = tops.findIndex((w, i) => i > 0 && MAIN_STATEMENT_WORDS.has(w.upper))
    if (mainIdx === -1) {
      return {
        level: RISK_UNKNOWN,
        firstKeyword: keyword,
        reasons: ['WITH 之后找不到可识别的主语句']
      }
    }
    idx = mainIdx
    keyword = tops[mainIdx].upper
  }
  // EXPLAIN ANALYZE：按被解释的语句定级（见 explainAnalyzeInfo 注释）
  let explained = null
  if (keyword === 'EXPLAIN') {
    const info = explainAnalyzeInfo(words)
    const tIdx = info.target ? tops.indexOf(info.target) : -1
    if (info.analyze && tIdx !== -1) {
      idx = tIdx
      keyword = info.target.upper
      explained = keyword
    } else if (info.analyze) {
      // ANALYZE 了但认不出主语句（`EXPLAIN ANALYZE EXECUTE p` 等）：
      // 不能回落 read —— 它可能真的执行了一条我们没认出来的语句
      return {
        level: RISK_UNKNOWN,
        firstKeyword: 'EXPLAIN',
        reasons: ['EXPLAIN ANALYZE 后没有可识别的主语句，无法判断是否会改动数据']
      }
    }
  }
  const shown = displayName(tops, idx)
  // 统一出口：ANALYZE 模式下把"这条会被真正执行"顶在理由最前面，
  // 否则用户看到"DELETE 没有 WHERE"会以为工具认错了自己的 EXPLAIN
  const result = (level, reasons) => ({
    level,
    firstKeyword: keyword,
    reasons: explained && reasons.length
      ? ['EXPLAIN ANALYZE 会真正执行：' + reasons[0]].concat(reasons.slice(1))
      : reasons
  })

  if (READ_WORDS.has(keyword)) {
    return result(RISK_READ, [])
  }

  if (TRANSACTION_WORDS.has(keyword)) {
    // START 只有 `START TRANSACTION` 才是事务；`START REPLICA` 之类属其它语义，按 unknown
    if (keyword === 'START') {
      const next = tops[idx + 1]
      if (!next || next.upper !== 'TRANSACTION') {
        return result(RISK_UNKNOWN, ['无法识别的语句类型：' + shown])
      }
    }
    return result(RISK_TRANSACTION, [])
  }

  if (keyword === 'INSERT' || keyword === 'REPLACE') {
    return result(RISK_WRITE, [keyword + ' 会写入数据'])
  }

  if (keyword === 'UPDATE' || keyword === 'DELETE' || keyword === 'MERGE') {
    const r = classifyWhere(text, dialect, tops, keyword)
    return result(r.level, r.reasons)
  }

  if (DDL_WORDS.has(keyword)) {
    return result(RISK_DDL, ['语句是 ' + shown + '，属于结构变更'])
  }

  if (DANGEROUS_WORDS.has(keyword)) {
    const hint = DANGEROUS_HINTS[keyword]
    return result(RISK_DANGEROUS, ['语句是 ' + shown + (hint ? '，' + hint : '')])
  }

  // SET 只有动到全局/持久化才算高危：`SET GLOBAL max_connections=...` 会改整个实例，
  // 而 `SET NAMES utf8` 只是会话设置（落到 unknown 由用户按需确认）
  if (keyword === 'SET') {
    const tail = tops.slice(idx + 1, idx + 4).map(w => w.upper)
    if (tail.includes('GLOBAL') || tail.includes('PERSIST')) {
      const shownSet = tail.includes('PERSIST') ? 'SET PERSIST' : 'SET GLOBAL'
      return result(RISK_DANGEROUS, ['语句是 ' + shownSet + '，会影响整个实例'])
    }
    return result(RISK_UNKNOWN, [
      '无法识别的语句类型：' + shown + '（会话级设置不在已知分类内）'
    ])
  }

  return result(RISK_UNKNOWN, ['无法识别的语句类型：' + shown])
}

/**
 * 多条语句分级：取最高级，理由带语句序号（用户要能对上编辑器里的第几条）。
 * @param {string} sql 原始 SQL
 * @param {string} dialect 引擎
 * @returns {{level: string, statements: Array, reasons: Array<string>}}
 */
export function classifySql (sql, dialect) {
  const parts = splitStatements(sql, dialect)
  const statements = parts.map(part => {
    const r = classifyStatement(part, dialect)
    return {
      text: part.text,
      start: part.start,
      end: part.end,
      level: r.level,
      firstKeyword: r.firstKeyword,
      reasons: r.reasons
    }
  })
  let level = RISK_READ
  const reasons = []
  statements.forEach((st, i) => {
    if (levelRank(st.level) > levelRank(level)) {
      level = st.level
    }
    st.reasons.forEach(r => {
      reasons.push('第 ' + (i + 1) + ' 条 ' + r)
    })
  })
  return { level, statements, reasons }
}
