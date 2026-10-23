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
