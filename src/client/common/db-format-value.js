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

// 本地日期/时间格式化的缓存：Intl 构造不便宜，网格每格都新建一遍会被放大成
// 虚拟渲染里的可见卡顿。key 固定为 'os'（本机区域），两个格式化器常驻即可。
const numberFmt = new Intl.NumberFormat()
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
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

/**
 * 格式化一个单元格值（展示层）。
 *
 * **不处理 null/undefined**：调用方有自己的 NULL 呈现，这里只管非空值。
 * **不处理对象**：JSON 序列化是渲染层既有行为，与本地化无关。
 *
 * @param {*} value 单元格原值
 * @param {string} dataType 该列的类型（F0 结构契约；SQL 结果集没有，传 '' 即可）
 * @param {'none'|'os'} mode 本地化模式
 * @returns {string} 展示文本
 */
export function formatCellValue (value, dataType, mode) {
  if (mode !== 'os') {
    return String(value)
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? numberFmt.format(value) : String(value)
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
  if (isNumberType(dt) && value.trim() !== '' && Number.isFinite(Number(value))) {
    return numberFmt.format(Number(value))
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
