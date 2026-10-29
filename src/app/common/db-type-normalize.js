/**
 * SQL 结果列类型归一（H1a-3 · 字段类型契约）。
 *
 * 驱动其实**一直**知道每一列是什么类型（mysql2 的 `ColumnDefinition.columnType`、
 * node-postgres 的 `fields[].dataTypeID`），但适配层以前只取 `f.name` —— 类型在这一步
 * 被丢掉。后果不是"少个字段"而是**同一个值在两处呈现不一致**：数据页知道那列是
 * `datetime`（能按 locale 本地化、数值列右对齐），SQL 结果页一概不知，于是一屏
 * `2024-01-05T16:00:00.000Z` 和左对齐的金额。
 *
 * 这里把驱动的类型码翻译成**库里那一套类型名**（information_schema 的 `DATA_TYPE`
 * 口径，即 `structure-v2.js` 喂给数据页的那套），而不是自造第三套词表：
 * `db-format-value.js` 的 `NUMBER_TYPES` / `DATE_TYPES` 认什么，这里就吐什么，
 * 认不上的一律 `''`。
 *
 * 三条边界：
 *
 * 1) **只增不改**。适配层新增**并列**字段 `columns: [{ name, type }]`，`fields` 仍是
 *    字符串数组。列生成 / CSV 头 / 导出三处消费方都按字符串用 `fields`，把 `fields`
 *    改成对象数组会同时炸三处，还得为老数据写兼容层。
 * 2) **未知回落 `''`**。没进表的码（pg 的数组与自定义类型、MariaDB 扩展类型等）一律
 *    当字符串处理。宁可少做一点格式化，也不猜一个类型把文本列右对齐 —— 后者是
 *    "看起来像 bug 的显示错误"，用户没法和我讲道理。
 * 3) **不碰数据**。类型只影响渲染（对齐 / locale 格式化）。编辑框取原值、导出取原始行、
 *    UPDATE 拼原值，三条路径都不经过这里。
 *
 * 表来源（不是凭记忆写的，逐条对过驱动常量；`db-type-normalize.spec.js` 里有一条
 * 与驱动常量对表的用例，改错一个码就会红）：
 * - mysql：`node_modules/mysql2/lib/constants/types.js`（协议 `enum MYSQL_TYPE`）、
 *   `constants/field_flags.js`（`BLOB = 16`、`BINARY = 128`）、
 *   `constants/charset_encodings.js`（下标 63 = `'binary'`）。
 * - pg：`node_modules/pg-types/lib/builtins.js`（由 `SELECT typname, oid FROM pg_type`
 *   导出，只含 `typnamespace = pg_catalog AND typelem = 0` 的基础类型）。
 *   **数组类型不在这张表里**（数组有各自独立的 OID），所以 `int[]` 这类回落 `''` ——
 *   与"未知不猜"是同一条规则，不是漏了。
 */

// 协议 MYSQL_TYPE 码 → DATA_TYPE 口径名。只放**类型码自身就能确定**的码；
// 249~254 这六个"文本/二进制二合一"的码在下面的 MYSQL_LOB_TYPES 里分流。
// 名字必须与 `db-format-value.js` 里那两个 Set 对得上，否则格式化会静默不生效
// （数值列不认 → 不千分位、不右对齐；日期列不认 → 还是 ISO 串）
const MYSQL_TYPE_NAMES = {
  0: 'decimal', // DECIMAL
  1: 'tinyint', // TINY
  2: 'smallint', // SHORT
  3: 'int', // LONG
  4: 'float', // FLOAT
  5: 'double', // DOUBLE
  // 6 = NULL（只在预处理协议里出现），没有对应的 DATA_TYPE，故意不列 → 回落 ''
  7: 'timestamp', // TIMESTAMP
  8: 'bigint', // LONGLONG
  9: 'mediumint', // INT24
  10: 'date', // DATE
  11: 'time', // TIME
  12: 'datetime', // DATETIME
  13: 'year', // YEAR
  14: 'date', // NEWDATE
  15: 'varchar', // VARCHAR（5.x 遗留码，实际基本不发，与 253 同义）
  16: 'bit', // BIT
  17: 'timestamp', // TIMESTAMP2（MySQL 5.6+ 二进制协议）
  18: 'datetime', // DATETIME2
  19: 'time', // TIME2
  242: 'vector', // VECTOR（MySQL 9）
  245: 'json', // JSON
  246: 'decimal', // NEWDECIMAL
  247: 'enum', // ENUM
  248: 'set', // SET
  255: 'geometry' // GEOMETRY
}

// 这六个码是"一个码两种类型"：文本与二进制共用类型码，只有字符集能分开。
// MySQL 的老坑 —— TEXT 和 BLOB 都报 0xfc，VARBINARY 和 VARCHAR 都报 0xfd。
// 分流判据**只能**用字符集（63 = binary）：`BLOB` 标志位（16）对 TEXT 列也是置位的
// （mysql2 的注释 "Field is a blob" 就是指这一族），拿它当判据会把 TEXT 说成 BLOB。
const MYSQL_LOB_TYPES = {
  249: { text: 'tinytext', binary: 'tinyblob' }, // TINY_BLOB
  250: { text: 'mediumtext', binary: 'mediumblob' }, // MEDIUM_BLOB
  251: { text: 'longtext', binary: 'longblob' }, // LONG_BLOB
  252: { text: 'text', binary: 'blob' }, // BLOB
  253: { text: 'varchar', binary: 'varbinary' }, // VAR_STRING
  254: { text: 'char', binary: 'binary' } // STRING
}

const MYSQL_CHARSET_BINARY = 63
// 仅在字符集信息缺失时用作 253/254 的兜底判据（见 isBinaryMeta）
const MYSQL_FLAG_BLOB = 16

/**
 * 类型码 → 归一类型名
 * @param {number} columnType mysql2 `ColumnDefinition.columnType`
 * @param {Object} [meta] 同一份字段元数据（读 `characterSet` / `encoding` / `flags`）
 * @returns {string} 归一类型名；认不上返回 `''`（当字符串处理）
 */
function normalizeMysqlType (columnType, meta) {
  // 防御性拦截：null/undefined 不应被 Number(null) === 0 撞上 MYSQL_TYPE_DECIMAL(0)
  // 而误判为 'decimal'。真实驱动不会下发 null 类型码，但"认不上返回 ''"的契约要求显式拦截。
  if (columnType === null || columnType === undefined) {
    return ''
  }
  const code = Number(columnType)
  if (!Number.isInteger(code)) {
    return ''
  }
  const lob = MYSQL_LOB_TYPES[code]
  if (lob) {
    return isBinaryMeta(meta, code === 253 || code === 254) ? lob.binary : lob.text
  }
  return MYSQL_TYPE_NAMES[code] || ''
}

/**
 * 该字段是不是二进制列。
 *
 * 首选字符集：mysql2 给的名字是 `characterSet`（协议里叫 charsetnr，别的驱动/自建
 * stub 两种拼法都有，所以都读）。`encoding === 'binary'` 是 mysql2 自己对同一件事的
 * 另一种表达（`charset_encodings[63]`），一并认。
 *
 * `allowFlag` 决定能不能退回 `BLOB` 标志位。**只有 253/254 能**：VARCHAR/CHAR 不带
 * BLOB 位，所以那一族里标志位是可信的；而 249~252 上 TEXT 也带 BLOB 位，用它会把
 * 文本列误报成二进制列。字符集缺失（老服务端 / 退化包）是少数情况，不值得为此
 * 把 TEXT→BLOB 的误判常态化。
 */
function isBinaryMeta (meta, allowFlag) {
  if (!meta) {
    return false
  }
  const cs = meta.characterSet !== undefined ? meta.characterSet : meta.charsetnr
  if (cs !== undefined && cs !== null && cs !== '') {
    return Number(cs) === MYSQL_CHARSET_BINARY
  }
  if (typeof meta.encoding === 'string') {
    return meta.encoding.toLowerCase() === 'binary'
  }
  if (!allowFlag) {
    return false
  }
  const flags = Number(meta.flags)
  return Number.isInteger(flags) && (flags & MYSQL_FLAG_BLOB) !== 0
}

// pg 的 OID → `information_schema.data_type` 口径名（数据页 structure-v2 用的就是它，
// 见 structure-v2.js 的 `dataType: c.data_type || c.udt_name`）。
// 名字要写成 pg 的**全称**（'timestamp with time zone' 而不是 'timestamptz'）：
// 词表和数据页同源才不会出现"同一列在两页一个本地化一个不本地化"。
const PG_TYPE_NAMES = {
  16: 'boolean', // BOOL
  17: 'bytea', // BYTEA
  18: 'char', // CHAR（单字节 internal，pg 的 data_type 写作 '"char"'）
  19: 'name', // NAME
  20: 'bigint', // INT8：pg 默认把 int8 当**字符串**送回，类型名是右对齐的唯一依据
  21: 'smallint', // INT2
  23: 'integer', // INT4
  25: 'text', // TEXT
  26: 'oid', // OID
  114: 'json', // JSON
  142: 'xml', // XML
  700: 'real', // FLOAT4
  701: 'double precision', // FLOAT8
  790: 'money', // MONEY
  829: 'macaddr', // MACADDR
  869: 'inet', // INET
  1042: 'character', // BPCHAR
  1043: 'character varying', // VARCHAR
  1082: 'date', // DATE
  1083: 'time without time zone', // TIME
  1114: 'timestamp without time zone', // TIMESTAMP
  1184: 'timestamp with time zone', // TIMESTAMPTZ
  1186: 'interval', // INTERVAL
  1266: 'time with time zone', // TIMETZ
  1560: 'bit', // BIT
  1562: 'bit varying', // VARBIT
  1700: 'numeric', // NUMERIC
  2950: 'uuid', // UUID
  3802: 'jsonb' // JSONB
}

/**
 * 字段 OID → 归一类型名
 * @param {number} dataTypeID pg `result.fields[].dataTypeID`
 * @returns {string} 归一类型名；认不上返回 `''`（数组、扩展类型、自定义类型都走这里）
 */
function normalizePgType (dataTypeID) {
  const oid = Number(dataTypeID)
  if (!Number.isInteger(oid)) {
    return ''
  }
  return PG_TYPE_NAMES[oid] || ''
}

/**
 * 把驱动的字段元数据数组转成契约里的 `columns`。
 *
 * 与 `fields` **同长同序**是这条契约的唯一硬要求（前端按 `name` 查类型，但导出侧
 * 仍按 `fields` 的顺序生成表头；两者错一位就是"表头与列对不上"那种最难查的 bug）。
 *
 * @param {Array<{ name: string }>} driverFields 驱动给的字段元数据（可能不是数组）
 * @param {(field: any) => string} normalize 单个字段 → 类型名
 * @returns {Array<{ name: string, type: string }>}
 */
function toColumns (driverFields, normalize) {
  if (!Array.isArray(driverFields)) {
    return []
  }
  return driverFields.map(f => {
    const type = normalize(f)
    return {
      name: f && f.name !== undefined && f.name !== null ? String(f.name) : '',
      // type 恒为字符串：漏出 undefined 会让 columns[i] 少一个键，JSON 序列化后
      // 前端读到的是 undefined 而不是 ''，"同长同序"这条契约也变得没法比
      type: type ? String(type) : ''
    }
  })
}

module.exports = {
  MYSQL_TYPE_NAMES,
  MYSQL_LOB_TYPES,
  PG_TYPE_NAMES,
  normalizeMysqlType,
  normalizePgType,
  toColumns
}
