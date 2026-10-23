/**
 * E2 结果集视角模型（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.1 / §7.3）
 *
 * 本模块只做一件事：把"用户在视角条里设的东西"翻译成 SQL 片段。
 * 它不连库、不读 store、不碰 i18n —— 纯函数才能被单测逐条钉死，
 * 也才能被主进程的二次校验（safe-clause.js）拿同一套白名单对照。
 *
 * 两条安全约定，写在这里是为了让后来的人不要"顺手优化"掉：
 *
 * 1) **值一律绑定，绝不拼字符串。**
 *    拼接意味着要自己做引号转义，而"转义写对"是历史上最容易被绕过的一类漏洞
 *    （走神漏一个引号就是注入）。绑定参数把转义责任交给驱动，我们只负责让
 *    占位符顺序与 params 顺序严格一一对应。因此本模块的返回值永远成对出现：
 *    { clause, params } —— 调用方拿到 clause 就必须把 params 一起传给驱动。
 *
 * 2) **列名走白名单 + 引用符加倍，二者缺一不可。**
 *    列名不能绑参数（占位符只能放值），只能拼进 SQL，所以它必须先被"确认是列"：
 *    大小写不敏感地查一遍真实列清单（MySQL 列名大小写不敏感），未命中直接丢弃并
 *    记入 rejected。确认之后仍然要加引用符，并把名字里出现的引用符自身成对加倍
 *    —— 反引号/双引号成对加倍是标准 SQL 的转义方式，只有这样含怪字符的列名
 *    才不会把语句结构撑破。白名单挡住"根本不存在的列"，引用符挡住"列名里的语法"。
 *
 * 归一化（normalizeView）是第三道兜底：view 可能来自老版本 JSON、可能被手改过、
 * 也可能是 null。它负责把脏数据裁成"能安全喂给上面两个函数"的形状，并且**只**
 * 输出约定的六个字段 —— 未知字段一律不透传，避免脏数据顺着 view 流到下游。
 *
 * 3) **"没生效"与"生效了但被裁剪"必须分开报。**
 *    buildWhere 返回 rejected 与 truncated 两个清单，不是把它们混成一个：
 *    rejected 里的条件**完全没有进 SQL**（未知列/未知算子/空值），UI 提示"N 个条件未生效"；
 *    truncated 里的条件**进了 SQL，只是取值被裁剪**（IN 超 200 项，只用了前 200 个），
 *    UI 要提示的是"条件已截断"。
 *    混在一起的后果是具体的：用户看到结果里筛选明明生效了，工具却说"1 个条件未生效" ——
 *    从此不再相信任何一条提示。"多问一次"和"少筛一条"是两种完全不同的用户预期，
 *    宁可多一个字段，也不要把它们压进同一个数组。
 */

// 支持的算子。顺序即 UI 下拉框顺序；新增算子必须同步 safe-clause.js 的语法词表，
// 否则主进程会把合法条件判成"不允许的标识符"。
export const FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'isNull',
  'notNull'
]

// 条件条数上限：再多就不是"看数据"而是"写查询"了，请用 SQL 模式
const MAX_CONDITIONS = 20
// IN 元素上限：超长 IN 在两种方言下都会退化成全表扫，且占位符会撑爆语句长度
const MAX_IN_VALUES = 200
// 排序列上限：3 列足够定位一行，再多索引也帮不上
const MAX_ORDER_COLUMNS = 3

// 无值算子：生成 IS NULL / IS NOT NULL，不产生占位符
const OPS_WITHOUT_VALUE = { isNull: true, notNull: true }
// 走 LIKE 的算子 → 通配符位置
const LIKE_OPS = { contains: true, startsWith: true, endsWith: true }
// 比较算子 → SQL 运算符
const COMPARE_SQL = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }

/**
 * 方言归一。tab.dbType 只有 mysql 家族与 postgres 两套词法，
 * 其他写法（postgresql/pg）一律当 pg 处理，避免调用方传错就静默变 mysql。
 * @param {string} dialect 方言名
 * @returns {'mysql'|'postgres'} 归一后的方言
 */
function normalizeDialect (dialect) {
  const d = String(dialect === null || dialect === undefined ? '' : dialect).toLowerCase()
  return d === 'postgres' || d === 'postgresql' || d === 'pg' ? 'postgres' : 'mysql'
}

/**
 * 加引用符。mysql 用反引号、pg 用双引号；名字里的引用符自身成对加倍。
 * 为什么不用"删掉引用符"的写法（app/lib/db-client/*.js 里的老实现）：
 * 那种写法会把含反引号的列名悄悄改成另一个名字，查出来是"列不存在"，
 * 而正确做法是照标准 SQL 把引用符加倍，名字仍是原名。
 * @param {string} name 列名/表名
 * @param {string} dialect 方言
 * @returns {string} 带引用符的标识符
 */
export function quoteIdent (name, dialect) {
  const s = String(name === null || name === undefined ? '' : name)
  if (normalizeDialect(dialect) === 'postgres') {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return '`' + s.replace(/`/g, '``') + '`'
}

/**
 * 把上游列清单归一成"名字数组"。
 * getTableStructure / describeTable 给的是 {name,dataType,...}，单测里直接给字符串更省事。
 * @param {Array<string|{name:string}>} columns 列清单
 * @returns {string[]} 去空后的列名（保持上游顺序）
 */
function columnNameList (columns) {
  const list = Array.isArray(columns) ? columns : []
  const out = []
  for (const item of list) {
    let name = ''
    if (typeof item === 'string') {
      name = item
    } else if (item && typeof item.name === 'string') {
      name = item.name
    }
    const t = name.trim()
    if (t) {
      out.push(t)
    }
  }
  return out
}

/**
 * 列白名单查找表：小写名 → 上游规范名。
 * 为什么保留规范名：用户/老 JSON 里可能是 `ID`、`Id`，SQL 里必须写回表里真实的 `id`，
 * 否则在某些严格模式下会被判成另一个字段或者报"列不存在"。
 * @param {Array<string|{name:string}>} columns 列清单
 * @returns {Map<string,string>} 小写名 → 规范名
 */
function columnLookup (columns) {
  const map = new Map()
  for (const name of columnNameList(columns)) {
    const key = name.toLowerCase()
    if (!map.has(key)) {
      map.set(key, name)
    }
  }
  return map
}

/**
 * 单值归一：数组取首元素（防御老 UI 把多选塞进标量算子），
 * 字符串 trim，对象视为空（不能把 [object Object] 当值绑进去）。
 * @param {*} value 原始值
 * @returns {*} 归一后的值
 */
function scalarValue (value) {
  if (Array.isArray(value)) {
    return value.length ? scalarValue(value[0]) : ''
  }
  if (value !== null && typeof value === 'object') {
    return ''
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  return value
}

/**
 * 空值判定。注意 0 与 false 不是空值 —— 它们是合法条件值，
 * 误判成空会静默丢掉"= 0"这种非常常见的筛选。
 * @param {*} value 归一后的值
 * @returns {boolean} 是否为空
 */
function isEmptyValue (value) {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === 'string') {
    return value.trim() === ''
  }
  return false
}

/**
 * IN 的取值归一：数组或逗号分隔字符串；元素转字符串并 trim，丢空。
 * 超上限时**截断而不是抛错** —— 300 个值里前 200 个仍然是有用的筛选，
 * 抛错会让用户完全看不到数据；截断由 buildWhere 记 tooManyValues 提示。
 * @param {*} value 原始值
 * @returns {{values: string[], truncated: boolean}} 归一结果
 */
function normalizeInValues (value) {
  let list = []
  if (Array.isArray(value)) {
    list = value
  } else if (typeof value === 'string') {
    list = value.split(',')
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    list = [value]
  }
  const out = []
  let truncated = false
  for (const item of list) {
    if (item === null || item === undefined) {
      continue
    }
    const s = typeof item === 'string' ? item.trim() : String(item)
    if (s === '') {
      continue
    }
    if (out.length >= MAX_IN_VALUES) {
      truncated = true
      break
    }
    out.push(s)
  }
  return { values: out, truncated }
}

/**
 * 条件归一。返回三份东西：
 * - list：能生成 SQL 的条件（已裁剪，附带原始下标 index 供 rejected/truncated 使用）
 * - rejected：**完全没生效**的条件（unknownOp / emptyValue / 空列名）
 * - truncated：**生效了但取值被裁剪**的条件（IN 超 200 项）
 * 为什么要带 index：UI 要能指出"第 2 行条件被忽略了"，而裁剪后下标会错位，
 * 所以 index 必须取它在**原始** conditions 数组里的位置。
 * @param {Array} input 原始 conditions
 * @returns {{list: Array, rejected: Array, truncated: Array}} 归一结果
 */
function normalizeConditions (input) {
  const arr = Array.isArray(input) ? input : []
  const list = []
  const rejected = []
  const truncated = []
  for (let index = 0; index < arr.length; index++) {
    if (list.length >= MAX_CONDITIONS) {
      // 超出上限的条件静默丢弃：枚举里的 reason 没有"超上限"这一项，
      // 而这时用户看到的是"前 20 条仍然生效"，不会误以为筛选坏了
      break
    }
    const raw = arr[index] && typeof arr[index] === 'object' ? arr[index] : {}
    const op = typeof raw.op === 'string' ? raw.op.trim() : ''
    const column = typeof raw.column === 'string' ? raw.column.trim() : ''
    if (FILTER_OPS.indexOf(op) === -1) {
      rejected.push({ index, column, op, reason: 'unknownOp' })
      continue
    }
    if (!column) {
      rejected.push({ index, column, op, reason: 'unknownColumn' })
      continue
    }
    if (OPS_WITHOUT_VALUE[op]) {
      list.push({ index, column, op })
      continue
    }
    if (op === 'in') {
      const inValues = normalizeInValues(raw.value)
      if (!inValues.values.length) {
        rejected.push({ index, column, op, reason: 'emptyValue' })
        continue
      }
      list.push({ index, column, op, value: inValues.values })
      if (inValues.truncated) {
        // 这条**生效了**（前 200 个值进了 SQL），所以进 truncated 而不是 rejected
        truncated.push({ index, column, op, reason: 'tooManyValues' })
      }
      continue
    }
    const value = scalarValue(raw.value)
    if (isEmptyValue(value)) {
      // 空值条件必须丢：留着会生成 `= ''`，看起来有筛选实际匹配全表，
      // 用户永远查不出"我明明筛了怎么还是全量"
      rejected.push({ index, column, op, reason: 'emptyValue' })
      continue
    }
    list.push({ index, column, op, value })
  }
  return { list, rejected, truncated }
}

/**
 * 排序归一：desc 只认严格 true（老 JSON 里可能是 'true' / 1），
 * 同列重复只留第一次（UI chips 拖拽会产生重复），最多 3 列。
 * @param {Array} input 原始 order
 * @returns {Array<{column:string, desc:boolean}>} 归一后的排序
 */
function normalizeOrder (input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    if (out.length >= MAX_ORDER_COLUMNS) {
      break
    }
    const raw = item && typeof item === 'object' ? item : {}
    const column = typeof raw.column === 'string' ? raw.column.trim() : ''
    if (!column) {
      continue
    }
    const key = column.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push({ column, desc: raw.desc === true })
  }
  return out
}

/**
 * 字符串数组归一：丢空、trim。用于 hiddenColumns / columnOrder。
 * @param {Array} input 原始数组
 * @returns {string[]} 归一后的名字数组
 */
function normalizeNameList (input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  for (const item of arr) {
    if (typeof item !== 'string') {
      continue
    }
    const s = item.trim()
    if (s) {
      out.push(s)
    }
  }
  return out
}

/**
 * 列宽归一：{列名: 正数}。非正数/非数字丢弃（宽度是没有意义的脏值）。
 * @param {Object} input 原始 columnWidths
 * @returns {Object<string, number>} 归一后的列宽表
 */
function normalizeWidths (input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const out = {}
  for (const key of Object.keys(src)) {
    const name = String(key).trim()
    if (!name) {
      continue
    }
    const n = Number(src[key])
    if (!Number.isFinite(n) || n <= 0) {
      continue
    }
    out[name] = n
  }
  return out
}

/**
 * 页大小归一：正整数才保留，否则 undefined。
 * 这里不填默认值：默认值属于 UI 偏好（用户上次选的 100/500），
 * 放在这里会让"没设过"和"设成默认值"变成同一件事，重置逻辑会失效。
 * @param {*} value 原始页大小
 * @returns {number|undefined} 归一后的页大小
 */
function normalizePageSize (value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    return undefined
  }
  return n
}

/**
 * 视角归一：返回固定六个字段，未知字段不透传。
 * @param {Object} view 原始视角（可能是 null / 老版本残缺对象）
 * @returns {Object} { conditions, order, pageSize, hiddenColumns, columnWidths, columnOrder }
 */
export function normalizeView (view) {
  const v = view && typeof view === 'object' ? view : {}
  const normalized = normalizeConditions(v.conditions)
  const conditions = normalized.list.map(cond => {
    if (cond.op === 'in') {
      // IN 的值数组要拷贝：直接暴露内部数组会被调用方 push 坏
      return { column: cond.column, op: cond.op, value: cond.value.slice() }
    }
    if (OPS_WITHOUT_VALUE[cond.op]) {
      return { column: cond.column, op: cond.op }
    }
    return { column: cond.column, op: cond.op, value: cond.value }
  })
  return {
    conditions,
    order: normalizeOrder(v.order),
    pageSize: normalizePageSize(v.pageSize),
    hiddenColumns: normalizeNameList(v.hiddenColumns),
    columnWidths: normalizeWidths(v.columnWidths),
    columnOrder: normalizeNameList(v.columnOrder)
  }
}

/**
 * 压入一个绑定值并返回它对应的占位符。
 * mysql 是位置型 `?`，pg 是编号型 `$n`：两者的序号都取"压入后的数组长度"，
 * 所以跨条件连续编号是天然成立的（第二个条件是三元素 IN 时，下一个必是 $5）。
 * @param {Array} params 参数数组（就地修改）
 * @param {*} value 绑定的值
 * @param {string} dialect 方言
 * @returns {string} 占位符文本
 */
function pushParam (params, value, dialect) {
  params.push(value)
  return dialect === 'postgres' ? '$' + params.length : '?'
}

/**
 * LIKE 通配符转义。
 * 顺序**必须**是先 `\` 再 `%` 再 `_`：反过来会把自己刚插入的转义符再转一次
 * （`a\b` → 先换 % 变成 `a\%b` 再换 \ 就成了 `a\\%b`，语义从"含 %"变成"含 \ 后跟任意"）。
 * 不生成 ESCAPE 子句：MySQL 与 PostgreSQL 的 LIKE 默认转义符都是反斜杠，
 * 显式写 ESCAPE 反而要处理"字面量里怎么表达反斜杠"的方言差异（pg 还有 standard_conforming_strings），
 * 多写一个子句只会多一处出错的机会。
 * @param {string} text 原值
 * @returns {string} 转义后的 LIKE 模式串
 */
function escapeLike (text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

/**
 * 按算子生成 LIKE 模式串（% 的位置决定"包含/前缀/后缀"）。
 * @param {string} op 算子
 * @param {*} value 原值
 * @returns {string} LIKE 模式串
 */
function likePattern (op, value) {
  const s = escapeLike(String(value))
  if (op === 'contains') {
    return '%' + s + '%'
  }
  if (op === 'startsWith') {
    return s + '%'
  }
  return '%' + s
}

/**
 * 条件体 → { clause, params, rejected, truncated }。
 * 返回的 clause **不含前导 WHERE**：调用方据此决定是否拼 WHERE，
 * 全条件被丢弃时 clause 是空串（空串拼进去会得到语法错误的 `WHERE `）。
 * rejected = 完全没生效的条件（unknownColumn / unknownOp / emptyValue）；
 * truncated = 生效了但取值被裁剪的条件（tooManyValues，IN 只用了前 200 项）。
 * 两个清单都按原始下标排序，UI 要按条件行号提示，乱序会指错行。
 * @param {Object} view 视角
 * @param {Array<string|{name:string}>} columns 列白名单（来自表结构）
 * @param {string} dialect 方言
 * @returns {{clause: string, params: Array, rejected: Array, truncated: Array}} 片段、参数与被丢弃/被裁剪的条件
 */
export function buildWhere (view, columns, dialect) {
  const d = normalizeDialect(dialect)
  const lookup = columnLookup(columns)
  const v = view && typeof view === 'object' ? view : {}
  const normalized = normalizeConditions(v.conditions)
  const rejected = normalized.rejected.slice()
  const truncated = normalized.truncated.slice()
  const parts = []
  const params = []
  for (const cond of normalized.list) {
    const canonical = lookup.get(cond.column.toLowerCase())
    if (!canonical) {
      rejected.push({
        index: cond.index,
        column: cond.column,
        op: cond.op,
        reason: 'unknownColumn'
      })
      continue
    }
    const quoted = quoteIdent(canonical, d)
    if (OPS_WITHOUT_VALUE[cond.op]) {
      parts.push(quoted + (cond.op === 'isNull' ? ' IS NULL' : ' IS NOT NULL'))
      continue
    }
    if (cond.op === 'in') {
      const slots = []
      for (const value of cond.value) {
        slots.push(pushParam(params, value, d))
      }
      parts.push(quoted + ' IN (' + slots.join(', ') + ')')
      continue
    }
    if (LIKE_OPS[cond.op]) {
      parts.push(quoted + ' LIKE ' + pushParam(params, likePattern(cond.op, cond.value), d))
      continue
    }
    parts.push(quoted + ' ' + COMPARE_SQL[cond.op] + ' ' + pushParam(params, cond.value, d))
  }
  // 按原始下标排序：UI 要按条件行号提示，乱序的 rejected 会指错行
  rejected.sort((a, b) => a.index - b.index)
  truncated.sort((a, b) => a.index - b.index)
  return {
    clause: parts.join(' AND '),
    params,
    rejected,
    truncated
  }
}

/**
 * 排序 → ORDER BY 列表文本（不含 ORDER BY 关键字）。
 * 只接受单列名：排序不参与"表达式"这回事，函数白名单在这里刻意不开放 ——
 * `ORDER BY RAND()`/`ORDER BY LENGTH(x)` 是最常见的"点一下卡死数据库"的写法。
 * @param {Object} view 视角
 * @param {Array<string|{name:string}>} columns 列白名单
 * @param {string} dialect 方言
 * @returns {string|null} 形如 "`id` DESC, `name` ASC"；无可排序列时 null
 */
export function buildOrderBy (view, columns, dialect) {
  const d = normalizeDialect(dialect)
  const lookup = columnLookup(columns)
  const v = view && typeof view === 'object' ? view : {}
  const parts = []
  for (const item of normalizeOrder(v.order)) {
    const canonical = lookup.get(item.column.toLowerCase())
    if (!canonical) {
      continue
    }
    parts.push(quoteIdent(canonical, d) + (item.desc === true ? ' DESC' : ' ASC'))
  }
  return parts.length ? parts.join(', ') : null
}

/**
 * 视角持久化键：`connectionId|dbName|schema|table`。
 * 不做 URL 编码、不做哈希 —— 这个键要能被人直接打开 db-grid-views.json 读懂，
 * 出问题时能一眼定位是哪张表的视角坏了。代价是表名里的 `|` 理论上会撞键，
 * 但那需要两张表的"拼接结果"完全一致，且此键只用于本地偏好存储，撞了也只是串视角。
 * @param {{connectionId:*, dbName:*, schema:*, table:*}} target 目标标识
 * @returns {string} 视角键
 */
export function viewKey (target) {
  const t = target && typeof target === 'object' ? target : {}
  const parts = [t.connectionId, t.dbName, t.schema, t.table]
  return parts
    .map(p => (p === null || p === undefined ? '' : String(p)))
    .join('|')
}

/* ------------------------------------------------------------------ *
 * 双模式（构建器 ⇄ SQL）：参数具体化 / 文本回解析
 *
 * 为什么需要这一对函数：buildWhere 产出的是**参数化**子句（`a` = ? / `a` = $1），
 * 那是发给驱动的形态，人看不懂也用不了 —— SQL 模式下用户要看到、要能改的是
 * 一条带字面量的文本。反过来，用户在 SQL 模式里改完想切回构建器，
 * 就得把文本还原成 conditions。
 *
 * 三条设计红线（都是为了"宁可不动，也不能悄悄改意思"）：
 *
 * 1) **具体化失败就原样返回子句。** 参数个数对不上、值不是标量、$n 越界 ——
 *    任何一种都说明这段文本与这组参数不是一对。这时生成一条"看起来能用"的 SQL
 *    是最坏的结果：用户会以为屏幕上那条就是自己的条件。
 *
 * 2) **解析只认自己产出的规范形态。** 这里不是 SQL 解析器，是"materializeClause 的逆函数"。
 *    遇到 OR / 函数调用 / 子查询 / BETWEEN / 未加引用符的列名 / 带通配符的中间 LIKE ——
 *    一律返回 null，让调用方留在 SQL 模式并提示"条件含手写表达式，无法结构化"。
 *    尽力猜的代价是用户的条件悄悄变意思（`a BETWEEN 1 AND 2` 猜成 `a >= 1`），
 *    这种错用户永远发现不了。
 *
 * 3) **引号区域内外必须分开看。** 列名 `` `a?b` `` 里的 `?` 不是占位符，
 *    字符串字面量里的 `;` 不是多语句。渲染层是 ESM、主进程那份 safe-clause.js 是 CJS，
 *    不能 require 过来，所以这里自带一份几十行的引号扫描（口径与 safe-clause 一致：
 *    mysql 单/双引号都认反斜杠转义，pg 只认 '' 双写，反引号/双引号标识符不掩码）。
 * ------------------------------------------------------------------ */

const PROBLEM_MAX_LEN = 4000
// 与 safe-clause.js 的 KEYWORD_BLACKLIST 保同：前端只用于"禁用应用按钮 + 提示"，
// 真正的闸门仍在主进程（那里会用列白名单再判一遍）
const CLAUSE_KEYWORD_RE = /(^|[^A-Za-z0-9_$])(select|insert|update|delete|drop|alter|create|truncate|union|exec|execute|call|grant|revoke|merge|replace|into|set|attach|detach|pragma|load|copy|vacuum)(?![A-Za-z0-9_$])/i

function isDigit (ch) {
  return ch >= '0' && ch <= '9'
}

function isWordChar (ch) {
  return typeof ch === 'string' && ch !== '' && /[A-Za-z0-9_$]/.test(ch)
}

/**
 * 从起始引号扫到闭合引号之后（未闭合时返回串尾）。
 * @param {string} src 原文
 * @param {number} start 起始引号下标
 * @param {string} quote 引号字符
 * @param {boolean} backslash 是否启用反斜杠转义（mysql 的单/双引号串、pg 的 E''）
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
 * pg 的 E'...'：E 必须是独立词（`name'x'` 里的 e 不算）
 * @param {string} src 原文
 * @param {number} i 单引号下标
 * @returns {boolean} 是否是 E 字符串
 */
function isEStringAt (src, i) {
  const prev = src[i - 1]
  if (prev !== 'E' && prev !== 'e') {
    return false
  }
  const before = i - 2 >= 0 ? src[i - 2] : ''
  return before === '' || !isWordChar(before)
}

/**
 * 扫出所有引号区域 [start, end)。
 * 占位符替换与危险字符判定都只做在区域之外 —— 否则 `LIKE '%?%'` 这种值会被当成占位符。
 * 括号/引号都按"区域"处理，不做语义判断。
 * @param {string} src 原文
 * @param {string} dialect 方言
 * @returns {Array<number[]>} 区域列表（按起点升序，互不重叠）
 */
function quotedRanges (src, dialect) {
  const d = normalizeDialect(dialect)
  const list = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === "'") {
      const eStr = d === 'postgres' && isEStringAt(src, i)
      const end = scanQuoted(src, i, "'", d === 'mysql' || eStr)
      list.push([eStr ? i - 1 : i, end])
      i = end
      continue
    }
    if (c === '"') {
      // mysql 的 "..." 是字符串字面量（认反斜杠）；pg 是标识符（只认 "" 双写）。
      // 两种都不替换占位符，所以差异只体现在扫描口径上
      const end = scanQuoted(src, i, '"', d === 'mysql')
      list.push([i, end])
      i = end
      continue
    }
    if (c === '`') {
      const end = scanQuoted(src, i, '`', false)
      list.push([i, end])
      i = end
      continue
    }
    i++
  }
  return list
}

/**
 * 标量 → SQL 字面量文本。
 * mysql 的字符串字面量里反斜杠是转义符，所以 `\` 必须再加倍一次 ——
 * 否则值 `a\b` 会被 mysql 读成 `a<退格>b`（这行注释就是这条规则存在的原因）。
 * pg 在 standard_conforming_strings=on（默认）下反斜杠是普通字符，不做处理，
 * 也不需要 E'' 前缀（多一层前缀只会多一处方言差异）。
 * @param {*} value 绑定值
 * @param {string} dialect 方言
 * @returns {string|null} 字面量文本；无法具体化时 null
 */
function literalText (value, dialect) {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  if (typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value !== 'string') {
    // 对象/数组/Date：不是 buildWhere 会产出的绑定值，硬转成字符串等于造一个新值
    return null
  }
  const escaped = dialect === 'mysql'
    ? value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    : value.replace(/'/g, "''")
  return "'" + escaped + "'"
}

/**
 * 参数化子句 → 可读可编辑的字面量文本。
 * 占位符按方言消费：mysql 顺序吃 `?`；pg 按 `$n` 的编号取 params[n-1]
 * （`$2` 写在 `$1` 前面时也不会错位 —— 编号是驱动认的，顺序无关）。
 * 任一占位符越界、值无法具体化、或用完/用不尽参数 → **原样返回子句**。
 * @param {string} clause 参数化子句
 * @param {Array} params 绑定值（与占位符一一对应）
 * @param {string} dialect 方言
 * @returns {string} 字面量化后的文本
 */
export function materializeClause (clause, params, dialect) {
  const text = typeof clause === 'string' ? clause : ''
  if (!text) {
    return text
  }
  const d = normalizeDialect(dialect)
  const list = Array.isArray(params) ? params : []
  const ranges = quotedRanges(text, d)
  const out = []
  const used = new Set()
  let seq = 0
  let ri = 0
  let i = 0
  while (i < text.length) {
    while (ri < ranges.length && ranges[ri][1] <= i) {
      ri++
    }
    if (ri < ranges.length && ranges[ri][0] <= i && i < ranges[ri][1]) {
      out.push(text.slice(i, ranges[ri][1]))
      i = ranges[ri][1]
      continue
    }
    const ch = text[i]
    if (ch === '?' && d === 'mysql') {
      if (seq >= list.length) {
        return text
      }
      const lit = literalText(list[seq], d)
      if (lit === null) {
        return text
      }
      out.push(lit)
      used.add(seq)
      seq++
      i++
      continue
    }
    if (ch === '$' && d === 'postgres' && isDigit(text[i + 1])) {
      let j = i + 1
      let num = ''
      while (j < text.length && isDigit(text[j])) {
        num += text[j]
        j++
      }
      const n = Number(num)
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        return text
      }
      const lit = literalText(list[n - 1], d)
      if (lit === null) {
        return text
      }
      out.push(lit)
      used.add(n - 1)
      i = j
      continue
    }
    out.push(ch)
    i++
  }
  // 参数必须被占位符"用完"：用不尽说明这组参数里有的值根本不在子句里，
  // 具体化出来的文本会悄悄少一个条件
  if (used.size !== list.length) {
    return text
  }
  return out.join('')
}

/**
 * 读一个带引用符的标识符（mysql `` `x` `` / pg `"x"`），引用符双写还原成自身。
 * @param {string} src 文本
 * @param {number} start 起点（必须是引用符）
 * @param {string} dialect 方言
 * @returns {{name: string, end: number}|null} 解析结果
 */
function readIdent (src, start, dialect) {
  const q = normalizeDialect(dialect) === 'postgres' ? '"' : '`'
  if (src[start] !== q) {
    return null
  }
  let i = start + 1
  let name = ''
  while (i < src.length) {
    const c = src[i]
    if (c === q) {
      if (src[i + 1] === q) {
        name += q
        i += 2
        continue
      }
      return { name, end: i + 1 }
    }
    name += c
    i++
  }
  return null
}

/**
 * 读一个字符串字面量，**必须占满整段文本**（后面还有内容就不是一个字面量）。
 * mysql：`''` 与 `\\` 是唯一的两种转义（别的 `\x` 直接判非规范形态）；
 * pg：只有 `''`（反斜杠是普通字符）。
 * @param {string} src 文本
 * @param {string} dialect 方言
 * @returns {string|null} 字面量内容；非规范形态返回 null
 */
function readStringLiteral (src, dialect) {
  const d = normalizeDialect(dialect)
  if (typeof src !== 'string' || src[0] !== "'") {
    return null
  }
  const n = src.length
  let out = ''
  let i = 1
  while (i < n) {
    const c = src[i]
    if (d === 'mysql' && c === '\\') {
      const next = src[i + 1]
      // 只认 materializeClause 会产出的两种转义；其余（\n、\% …）是手写表达式
      if (next !== '\\' && next !== "'") {
        return null
      }
      out += next
      i += 2
      continue
    }
    if (c === "'") {
      if (src[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      if (i !== n - 1) {
        return null
      }
      return out
    }
    out += c
    i++
  }
  return null
}

/**
 * 读一个字面量：NULL / TRUE / FALSE / 数字 / 字符串。
 * 数字保留**原文**（'007' 不会被规范化成 '7'），否则往返会悄悄改值。
 * @param {string} src 文本
 * @param {string} dialect 方言
 * @returns {{kind: string, value: *}|null} 字面量
 */
function readLiteral (src, dialect) {
  const t = typeof src === 'string' ? src.trim() : ''
  if (!t) {
    return null
  }
  if (/^NULL$/i.test(t)) {
    return { kind: 'null', value: null }
  }
  if (/^TRUE$/i.test(t)) {
    return { kind: 'bool', value: true }
  }
  if (/^FALSE$/i.test(t)) {
    return { kind: 'bool', value: false }
  }
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    return { kind: 'number', value: t }
  }
  const s = readStringLiteral(t, dialect)
  if (s !== null) {
    return { kind: 'string', value: s }
  }
  return null
}

/**
 * LIKE 模式串 → 算子 + 原值（escapeLike 的逆）。
 * 只认三种规范形态：`%x%` / `x%` / `%x`。中间还留着未转义 `%`/`_`
 * （如 `%a%b%`、`a_b`）→ null：那不是构建器能表达的形态。
 * @param {string} pattern 模式串
 * @returns {{op: string, value: string}|null} 算子与原值
 */
function parseLikePattern (pattern) {
  if (typeof pattern !== 'string' || !pattern) {
    return null
  }
  const head = pattern[0] === '%'
  let tail = false
  if (pattern.length > 1 && pattern[pattern.length - 1] === '%') {
    // 末尾的 % 必须未被反斜杠转义（数前面连续反斜杠的奇偶）
    let k = pattern.length - 2
    let slashes = 0
    while (k >= 0 && pattern[k] === '\\') {
      slashes++
      k--
    }
    tail = slashes % 2 === 0
  }
  const start = head ? 1 : 0
  const end = tail ? pattern.length - 1 : pattern.length
  if (start >= end) {
    return null
  }
  const core = pattern.slice(start, end)
  let value = ''
  for (let i = 0; i < core.length; i++) {
    const c = core[i]
    if (c === '\\') {
      const next = core[i + 1]
      if (next === '\\' || next === '%' || next === '_') {
        value += next
        i++
        continue
      }
      return null
    }
    if (c === '%' || c === '_') {
      return null
    }
    value += c
  }
  if (head && tail) {
    return { op: 'contains', value }
  }
  if (tail) {
    return { op: 'startsWith', value }
  }
  if (head) {
    return { op: 'endsWith', value }
  }
  return null
}

/**
 * 去掉包裹整段的最外层括号（可以多层）。
 * @param {string} text 文本
 * @param {string} dialect 方言
 * @returns {string} 去括号后的文本
 */
function stripOuterParens (text, dialect) {
  let t = text.trim()
  for (let guard = 0; guard < 32; guard++) {
    if (t[0] !== '(' || t[t.length - 1] !== ')') {
      return t
    }
    const ranges = quotedRanges(t, dialect)
    let depth = 0
    let ri = 0
    let close = -1
    for (let i = 0; i < t.length; i++) {
      while (ri < ranges.length && ranges[ri][1] <= i) {
        ri++
      }
      if (ri < ranges.length && ranges[ri][0] <= i && i < ranges[ri][1]) {
        i = ranges[ri][1] - 1
        continue
      }
      if (t[i] === '(') {
        depth++
      } else if (t[i] === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    // 首字符的 '(' 没有在末尾闭合 → 括号不是"包着整段"，不再剥
    if (close !== t.length - 1) {
      return t
    }
    t = t.slice(1, close).trim()
  }
  return t
}

/**
 * 顶层 AND 切分（引号内、括号内的 AND 不算）。
 * 出现顶层 OR → null（构建器没有 OR 概念，硬拆会让条件变意思）。
 * @param {string} text 文本
 * @param {string} dialect 方言
 * @returns {string[]|null} 片段列表
 */
function splitTopLevelAnd (text, dialect) {
  const ranges = quotedRanges(text, dialect)
  const parts = []
  let depth = 0
  let ri = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    while (ri < ranges.length && ranges[ri][1] <= i) {
      ri++
    }
    if (ri < ranges.length && ranges[ri][0] <= i && i < ranges[ri][1]) {
      i = ranges[ri][1]
      continue
    }
    const c = text[i]
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      if (depth < 0) {
        return null
      }
      i++
      continue
    }
    if (depth === 0 && (c === 'A' || c === 'a' || c === 'O' || c === 'o')) {
      const prev = i > 0 ? text[i - 1] : ''
      if (!isWordChar(prev)) {
        let j = i
        let word = ''
        while (j < text.length && isWordChar(text[j])) {
          word += text[j]
          j++
        }
        const up = word.toUpperCase()
        if (up === 'OR') {
          return null
        }
        if (up === 'AND') {
          const seg = text.slice(start, i).trim()
          if (!seg) {
            return null
          }
          parts.push(seg)
          start = j
          i = j
          continue
        }
        i = j
        continue
      }
    }
    i++
  }
  if (depth !== 0) {
    return null
  }
  const tail = text.slice(start).trim()
  if (!tail) {
    return null
  }
  parts.push(tail)
  return parts
}

/**
 * 单个条件片段 → condition 对象。
 * @param {string} part 片段（已切分，未剥括号）
 * @param {Map<string,string>} lookup 列白名单
 * @param {string} dialect 方言
 * @returns {Object|null} condition；非规范形态返回 null
 */
function parseCondition (part, lookup, dialect) {
  const t = stripOuterParens(part, dialect)
  const head = readIdent(t, 0, dialect)
  if (!head) {
    return null
  }
  const canonical = lookup.get(head.name.toLowerCase())
  if (!canonical) {
    return null
  }
  const rest = t.slice(head.end).trim()
  if (!rest) {
    return null
  }
  if (/^IS\s+NULL$/i.test(rest)) {
    return { column: canonical, op: 'isNull' }
  }
  if (/^IS\s+NOT\s+NULL$/i.test(rest)) {
    return { column: canonical, op: 'notNull' }
  }
  const like = /^LIKE\s+([\s\S]+)$/i.exec(rest)
  if (like) {
    const raw = readStringLiteral(like[1].trim(), dialect)
    if (raw === null) {
      return null
    }
    const pattern = parseLikePattern(raw)
    if (!pattern) {
      return null
    }
    return { column: canonical, op: pattern.op, value: pattern.value }
  }
  const inMatch = /^IN\s*\(([\s\S]*)\)$/i.exec(rest)
  if (inMatch) {
    const inner = inMatch[1]
    const ranges = quotedRanges(inner, dialect)
    const items = []
    let start = 0
    let ri = 0
    for (let i = 0; i <= inner.length; i++) {
      while (ri < ranges.length && ranges[ri][1] <= i) {
        ri++
      }
      const inRange = ri < ranges.length && ranges[ri][0] <= i && i < ranges[ri][1]
      if (inRange) {
        i = ranges[ri][1] - 1
        continue
      }
      if (i === inner.length || inner[i] === ',') {
        items.push(inner.slice(start, i).trim())
        start = i + 1
      }
    }
    if (!items.length || items.some(x => x === '')) {
      return null
    }
    const values = []
    for (const item of items) {
      const lit = readLiteral(item, dialect)
      // IN 里只收数字与字符串：布尔/NULL 在 IN 里是另一套语义（NULL 永不命中），
      // 转成构建器的 IN 值数组后意思会变
      if (!lit || (lit.kind !== 'number' && lit.kind !== 'string')) {
        return null
      }
      values.push(lit.value)
    }
    return { column: canonical, op: 'in', value: values }
  }
  const cmp = /^(<>|!=|>=|<=|=|>|<)\s*([\s\S]+)$/.exec(rest)
  if (cmp) {
    const lit = readLiteral(cmp[2].trim(), dialect)
    if (!lit || lit.kind === 'null') {
      return null
    }
    const opMap = {
      '=': 'eq',
      '<>': 'ne',
      '!=': 'ne',
      '>': 'gt',
      '>=': 'gte',
      '<': 'lt',
      '<=': 'lte'
    }
    return { column: canonical, op: opMap[cmp[1]], value: lit.value }
  }
  return null
}

/**
 * 字面量文本 → conditions（materializeClause 的逆）。
 * 只认本模块产出的规范形态：`col` = 'v' / `col` <> 5 / `col` LIKE 'x%' /
 * `col` IN (1, 2) / `col` IS NULL / `col` IS NOT NULL，多条件 ` AND ` 连接，
 * 允许每条外层多裹几层括号。其余一切形态（OR / 函数 / 子查询 / BETWEEN / 未加引号列名）
 * 返回 null —— 调用方据此"留在 SQL 模式并提示"，绝不静默丢条件。
 * 空文本 → `{ conditions: [] }`（等价于"无筛选"，这是合法的退化形态）。
 * 数字字面量回填成**字符串**（'7'）：materialize 只保留了文本，
 * 与 normalizeView 归一后的 IN 值同一口径。
 * @param {string} text 条件体文本
 * @param {Array<string|{name:string}>} columns 列白名单
 * @param {string} dialect 方言
 * @returns {{conditions: Array}|null} 条件体；无法结构化时 null
 */
export function parseClause (text, columns, dialect) {
  const src = typeof text === 'string' ? text.trim() : ''
  if (!src) {
    return { conditions: [] }
  }
  const d = normalizeDialect(dialect)
  const lookup = columnLookup(columns)
  if (!lookup.size) {
    // 没有列白名单时任何列名都无法确认，一律不可结构化
    return null
  }
  const parts = splitTopLevelAnd(src, d)
  if (!parts) {
    return null
  }
  const conditions = []
  for (const part of parts) {
    const cond = parseCondition(part, lookup, d)
    if (!cond) {
      return null
    }
    conditions.push(cond)
  }
  return { conditions }
}

/**
 * 条件体文本的"前端预检"：只回答"这条文本看起来能不能发给主进程"。
 * 返回空串表示没发现问题；否则返回原因码：
 * - tooLong：超过 4000 字符
 * - semicolon / comment：多语句 / 注释（**引号内的不算**）
 * - keyword：出现 SELECT/INSERT/DROP 等语句关键字（引号内的不算）
 * - unbalanced：括号不配平
 * 注意：这不是安全闸门（渲染层永远不是），主进程 assertSafeClause 会再判一遍，
 * 而且判据更严（列白名单、占位符编号连续性）。这里只为了让"应用"按钮能提前禁用，
 * 省掉一次必然失败的往返与一个弹窗。
 * @param {string} text 条件体文本
 * @param {string} dialect 方言
 * @returns {string} 原因码，'' 表示通过
 */
export function findClauseProblem (text, dialect) {
  const src = typeof text === 'string' ? text : ''
  if (!src.trim()) {
    return ''
  }
  if (src.length > PROBLEM_MAX_LEN) {
    return 'tooLong'
  }
  const ranges = quotedRanges(src, normalizeDialect(dialect))
  let skeleton = ''
  let last = 0
  for (const [from, to] of ranges) {
    skeleton += src.slice(last, from) + ' '
    last = to
  }
  skeleton += src.slice(last)
  if (skeleton.indexOf(';') !== -1) {
    return 'semicolon'
  }
  if (skeleton.indexOf('--') !== -1 || skeleton.indexOf('/*') !== -1 ||
    skeleton.indexOf('#') !== -1) {
    return 'comment'
  }
  if (CLAUSE_KEYWORD_RE.test(skeleton)) {
    return 'keyword'
  }
  let depth = 0
  for (const ch of skeleton) {
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
      if (depth < 0) {
        return 'unbalanced'
      }
    }
  }
  return depth === 0 ? '' : 'unbalanced'
}

/**
 * 排序 chips / 列头点击的**唯一**推进规则：升序 → 降序 → 移除（第三次点击），
 * 超过 3 列时丢掉最旧的一列（数组头部）。
 * 放在这里而不是组件里，是因为列头点击（db-session）与 chips 点击（db-view-bar）
 * 必须完全一致 —— 两处各写一份，一定会有一处忘了 3 列上限。
 * @param {Array<{column:string, desc:boolean}>} order 当前排序
 * @param {string} column 被点击的列
 * @param {number} max 最大列数
 * @returns {Array<{column:string, desc:boolean}>} 新的排序
 */
export function nextSortOrder (order, column, max) {
  const cur = Array.isArray(order) ? order : []
  const key = String(column === null || column === undefined ? '' : column).toLowerCase()
  if (!key) {
    return normalizeOrder(cur)
  }
  const rest = normalizeOrder(cur).filter(o => o.column.toLowerCase() !== key)
  const existing = normalizeOrder(cur).find(o => o.column.toLowerCase() === key)
  let next = rest
  if (!existing) {
    next = rest.concat([{ column, desc: false }])
  } else if (existing.desc === false) {
    next = rest.concat([{ column, desc: true }])
  }
  const cap = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_ORDER_COLUMNS) : MAX_ORDER_COLUMNS
  return next.length > cap ? next.slice(next.length - cap) : next
}
