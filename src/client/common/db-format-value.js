/**
 * 单元格值的展示层格式化（设计 §7.5「数值/日期 locale 格式化」）。
 *
 * 三条边界，按重要性排：
 *
 * 1) **只影响渲染，绝不影响数据**。格式化结果只进 `renderCell` 的显示文本；
 *    编辑框取的是原值（`String(row[col])`）、导出取的是原始行、主进程 UPDATE 拼的是原值。
 *    一旦让格式化结果回流到其中任何一条，用户看到的"1,234"就会被当成字符串存回库里。
 * 2) **默认关**。`dbFormatLocale` 缺省 'none'，即 `String(value)` 原样显示。
 *    千分位分隔符会让"这一列到底是数字还是字符串"变得难以判断（前导零、超长整数），
 *    所以默认保持原样，要的人自己开。
 * 3) **日期不猜**。只对"类型已知为日期/时间"或"值本身就是 Date 对象"的单元格做日期格式化；
 *    纯字符串值即使长得像日期也不动 —— 那会把一个本来要做子串匹配的字符串改掉样子，
 *    而用户根本不知道它被解释成了时间。
 * 4) **分组不许动精度**。`Intl.NumberFormat()` 默认最大 3 位小数，且 `format()` 把入参过一遍
 *    Number：19 位 BIGINT 主键会被四舍五入到最近的偶数、DECIMAL 的 `0.10` 会掉成 `0.1`、
 *    `1234567.8901` 会变成 `1,234,567.89`。这类丢精度只出现在"显示"里，用户看不出问题，
 *    然后拿着显示值去库里查/去比对 —— 所以整数部分用 BigInt 分组、小数位逐位原样带上，
 *    只向 locale 借分隔符。
 */

const DATE_TYPES = new Set([
  'date',
  'datetime',
  'timestamp',
  'timestamptz',
  'timestamp with time zone',
  'timestamp without time zone',
  'time',
  'time without time zone',
  'time with time zone',
  'smalldatetime'
])

const NUMBER_TYPES = new Set([
  'int',
  'integer',
  'tinyint',
  'smallint',
  'mediumint',
  'bigint',
  'int unsigned',
  'bigint unsigned',
  'decimal',
  'numeric',
  'float',
  'double',
  'double precision',
  'real',
  'serial',
  'bigserial',
  'smallserial',
  'money',
  'bit',
  'year'
])

// 纯日期（无时刻）：按 UTC 解释并按 UTC 取日期部分。
// 否则 '2024-01-05' 会被解析成 UTC 午夜，在负偏移时区里本地显示成 01-04 ——
// 平白少一天，而且是"看起来差一天、查不出原因"的那种。
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
// 带时刻但不带时区：MySQL DATETIME 的典型形态，按本地时间解释（库里存的就是本地语义）
const NAIVE_DT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/
// 带时区信息（Z 或 ±HH:MM）：交给 Intl 自己处理
const ZONED_DT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

/**
 * 是否为日期/时间类型（大小写不敏感，含 PG 的 `timestamp with time zone` 这类全称）
 * @param {string} dataType 列类型（F0 结构契约里的 dataType，已归一为小写）
 * @returns {boolean}
 */
export function isDateType (dataType) {
  return DATE_TYPES.has(String(dataType || '').toLowerCase())
}

/**
 * 是否为数值类型
 * @param {string} dataType 列类型
 * @returns {boolean}
 */
export function isNumberType (dataType) {
  return NUMBER_TYPES.has(String(dataType || '').toLowerCase())
}

/**
 * 数值列的单元格 class（H1a-3）。数据页与 SQL 结果页共用这一条判定，
 * 同一列在两个网格里方向一致才是"读得下去"，各判一次就又是一处不一致。
 *
 * 为什么不用 antd 的 `column.align = 'right'`：它会把**表头**一起右对齐，
 * 而表头右边沿正是列宽拖拽手柄的热区（H1a-2 的几何契约：`right: 0` + `z-index: 2`）。
 * 列名压到那儿，鼠标划过文字就变成 col-resize 光标，看着像坏了。
 *
 * @param {string} dataType 列类型（'' 表示"没有类型信息"，不右对齐）
 * @returns {string} 单元格 class，非数值列返回 ''
 */
export function cellAlignClass (dataType) {
  return isNumberType(dataType) ? 'db-cell-num' : ''
}

// 本地日期/时间格式化的缓存：Intl 构造不便宜，网格每格都新建一遍会被放大成
// 虚拟渲染里的可见卡顿。key 固定为 'os'（本机区域），两个格式化器常驻即可。
// maximumFractionDigits 显式放开：默认 3 位就是上面第 4 条边界的来源。
const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 })
// 小数点符号只从格式化器读：写死 '.' 在 de/fr 等 locale 下会显示成错的符号
const DECIMAL_SEP = (() => {
  const parts = numberFmt.formatToParts(1.5)
  const found = parts.find(p => p.type === 'decimal')
  return found ? found.value : '.'
})()
// 纯日期专用：值按 UTC 午夜解释（见 DATE_ONLY_RE 分支），取日期部分就必须在 UTC 上取。
// 用本地时区会把那一天再挪回去 —— 负偏移时区显示成前一天，正是当初要修的那个症状。
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'utc'
})
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

/**
 * 把字符串值格式化成日期文本；不是可识别的日期形态时返回 null（调用方回落原样）。
 * @param {string} s 字符串值
 * @returns {string|null}
 */
function formatDateString (s) {
  if (DATE_ONLY_RE.test(s)) {
    const d = new Date(s + 'T00:00:00Z')
    return Number.isNaN(d.getTime()) ? null : dateFmt.format(d)
  }
  if (NAIVE_DT_RE.test(s)) {
    // 无时区：按本地时间构造，避免再被 UTC 解析挪动一天
    const d = new Date(s.replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? null : dateTimeFmt.format(d)
  }
  if (ZONED_DT_RE.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : dateTimeFmt.format(d)
  }
  return null
}

// 普通十进制形态：可选符号 + 整数 + 可选小数。指数（1e5）、纯小数（.5）、带空格的都落不进来
const PLAIN_DEC_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/

/**
 * 精确分组一个十进制字符串：整数部分走 BigInt（不过 Number，19 位以上不丢），
 * 小数位逐位原样接上（保住 DECIMAL 的 `0.10` 这类有效位），只向 locale 借分组符和小数点。
 * @param {string} sign '+' | '-' | ''
 * @param {string} intDigits 整数位数字串
 * @param {string} [fracDigits] 小数位数字串
 * @returns {string}
 */
function groupDecimal (sign, intDigits, fracDigits) {
  const head = sign === '-' ? '-' : ''
  return head + numberFmt.format(BigInt(intDigits)) + (fracDigits ? DECIMAL_SEP + fracDigits : '')
}

/**
 * 只能过 Number 的形态（JS number、'1e5' 这类非普通十进制串）。
 * 分组结果全是 0 而原值非 0 ⇒ 值被四舍五入没了，此时宁可原样：
 * 把非零显示成 0 比不打千分位更糟。
 * @param {number} num 数值
 * @param {string} raw 回落用的原文
 * @returns {string}
 */
function groupViaNumber (num, raw) {
  const text = numberFmt.format(num)
  const digits = text.replace(/[^0-9]/g, '')
  return num !== 0 && digits.length > 0 && /^0+$/.test(digits) ? raw : text
}

/**
 * 格式化一个单元格值（展示层）。
 *
 * **不处理 null/undefined**：调用方有自己的 NULL 呈现，这里只管非空值。
 * **不处理对象**：JSON 序列化是渲染层既有行为，与本地化无关。
 *
 * @param {*} value 单元格原值
 * @param {string} dataType 该列的类型（数据页取 F0 结构契约，SQL 结果取适配层的
 *   `columns[].type`；两处都没有时传 '' —— 只格式化驱动已给出 JS number 的值，字符串不猜）
 * @param {'none'|'os'} mode 本地化模式
 * @returns {string} 展示文本
 */
export function formatCellValue (value, dataType, mode) {
  if (mode !== 'os') {
    return String(value)
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? groupViaNumber(value, String(value)) : String(value)
  }
  if (typeof value !== 'string') {
    // 布尔、BigInt 等：不猜语义，原样
    return String(value)
  }
  const dt = String(dataType || '').toLowerCase()
  if (isDateType(dt)) {
    // PG 的 time 类型是 '10:30:00' 这种纯时刻，别往日期上套
    if (dt === 'time' || dt === 'time without time zone' || dt === 'time with time zone') {
      return formatTimeOnly(value) || value
    }
    return formatDateString(value) || value
  }
  if (isNumberType(dt)) {
    const s = value.trim()
    const m = PLAIN_DEC_RE.exec(s)
    if (m) {
      return groupDecimal(m[1], m[2], m[3])
    }
    if (s !== '' && Number.isFinite(Number(s))) {
      return groupViaNumber(Number(s), value)
    }
  }
  return value
}

// 纯时刻（'10:30:00' / '10:30'）→ 本地时间文本；不是就原样
function formatTimeOnly (s) {
  const m = /^(\d{1,2}):(\d{2})(:(\d{2}))?$/.exec(s.trim())
  if (!m) {
    return null
  }
  const d = new Date(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[4] || 0))
  return Number.isNaN(d.getTime()) ? null : timeFmt.format(d)
}

/**
 * 全局配置里的开关名。放这里（而不是散在 store/sync 的词条里）是为了让
 * "配置项名"与"读配置的代码"相邻：改名时编译不管、运行不报错，
 * 只会表现成"开关突然失效"，而这种 bug 极难查。
 */
export const FORMAT_LOCALE_KEY = 'dbFormatLocale'

/**
 * 从全局 config 读本地化开关。
 * 只认严格 'os'，其余（undefined / 'none' / 手改错的字符串）一律回落 'none' ——
 * 与 readSqlEditorOpts 同一条口径：配置文件可手改，显示状态必须与真实行为一致。
 * @param {object} cfg window.store._config
 * @returns {'none'|'os'}
 */
export function readFormatLocale (cfg) {
  return cfg && cfg[FORMAT_LOCALE_KEY] === 'os' ? 'os' : 'none'
}
