/**
 * 元数据契约 v2（F0）：把 MySQL / PostgreSQL 的 catalog 原始行映射成同一份结构描述。
 *
 * 为什么单独成文件（纯函数、零依赖、不打库）：
 * - 契约是跨批次公共设施（E2 表头注释 / F1 外键侧栏 / F3 二进制呈现 / P2 数据字典），
 *   映射规则必须能脱驱动单测：fixture 进、契约出，两个引擎喂同一份 fixture 必须得到同构结果
 * - 两引擎的原始行差别很大：布尔是 'YES'/'NO' 还是 true/false、行数估算 -1 表示未统计、
 *   外键动作一个是 'CASCADE' 一个是单字符 'c'、索引列一个是多行一个是数组——
 *   归一化只写在这一处，适配器里就只剩 SQL
 *
 * 契约形状（超集，字段只增不改，老前端零改动）：
 * {
 *   type: 'table' | 'view',
 *   columns: [{ name, dataType, columnType, nullable, defaultValue, isPrimaryKey,
 *               ordinal, comment, maxLength, isBinary }],
 *   indexes: [{ name, unique, primary, columns: [name], method }],
 *   foreignKeys: [{ name, columns: [local], refSchema, refTable, refColumns: [ref],
 *                   onDelete, onUpdate }],
 *   comment: string | null,
 *   estimatedRows: number | null,
 * }
 */

// 二进制列判定：导出/呈现（F3）据此决定走裸字节通道还是文本
const BINARY_TYPES = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob',
  'bit', 'bytea', 'geometry', 'geography', 'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'
])

// 表头/侧栏展示用：这些是"看起来像文本其实要按二进制处理"的近亲
const BINARY_TYPE_PREFIX = ['geometry', 'geography']

function isBinaryType (dataType, udtName) {
  const t = String(dataType || '').toLowerCase()
  const u = String(udtName || '').toLowerCase()
  if (!t && !u) {
    return false
  }
  if (BINARY_TYPES.has(t) || BINARY_TYPES.has(u)) {
    return true
  }
  return BINARY_TYPE_PREFIX.some(p => t.startsWith(p) || u.startsWith(p))
}

// 'YES'/'NO'、true/false、1/0 三种写法都可能出现（information_schema 与 catalog 混用）
function yesNo (v) {
  if (typeof v === 'boolean') {
    return v
  }
  if (typeof v === 'number') {
    return v !== 0
  }
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1' || s === 't'
}

function strOrNull (v) {
  if (v === null || v === undefined) {
    return null
  }
  const s = String(v)
  return s
}

// 注释：MySQL 空注释是 ''、PG 无注释是 null，统一成 null（否则表头会出现一个空 tooltip）
function commentOrNull (v) {
  const s = strOrNull(v)
  if (s === null) {
    return null
  }
  const t = s.trim()
  return t === '' ? null : t
}

// maxLength：只认正数；-1/0/非数字一律 null（PG 的 numeric 无长度、MySQL 的 text 也是 null）
function lengthOrNull (v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

// 行数估算：PG 的 reltuples 未 analyze 时是 -1，MySQL 未统计是 null/0
// 0 保留（真空表是"0 行"，不是"未知"）
function rowsOrNull (v) {
  if (v === null || v === undefined) {
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    return null
  }
  return Math.floor(n)
}

function ordOf (v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// PG confupdtype/confdeltype 是单字符编码（a/r/c/n/d），MySQL 直接给 'CASCADE' 这样的词
const PG_FK_ACTION = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

function fkAction (v) {
  if (v === null || v === undefined || v === '') {
    return null
  }
  const s = String(v)
  if (s.length === 1) {
    return PG_FK_ACTION[s.toLowerCase()] || null
  }
  return s.toUpperCase().replace(/_/g, ' ')
}

function toArray (v) {
  if (Array.isArray(v)) {
    return v.filter(x => x !== null && x !== undefined).map(String)
  }
  if (v === null || v === undefined || v === '') {
    return []
  }
  return [String(v)]
}

function sortByOrdinal (cols) {
  return cols
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.ordinal - b.c.ordinal) || (a.i - b.i))
    .map(x => x.c)
}

/**
 * 每个列对象补齐全部字段。
 * 缺字段必须是"有默认值的完整对象"而不是 undefined：调用方（前端表头、F3 呈现器）
 * 直接读 c.isBinary / c.comment，少一个键就是运行时 undefined 参与判断。
 */
function normalizeColumn (c, i) {
  const name = String((c && c.name) || '')
  const dataType = String((c && c.dataType) || '').toLowerCase()
  return {
    name,
    dataType,
    // 完整类型定义（varchar(64) / int unsigned）：表头与插入表单要显示长度，dataType 只有基类
    columnType: strOrNull(c && c.columnType),
    nullable: yesNo(c && c.nullable),
    defaultValue: strOrNull(c && c.defaultValue),
    isPrimaryKey: (c && c.isPrimaryKey) === true,
    ordinal: ordOf(c && c.ordinal, i + 1),
    comment: commentOrNull(c && c.comment),
    maxLength: lengthOrNull(c && c.maxLength),
    isBinary: isBinaryType(dataType, c && c.udtName)
  }
}

// 索引/外键必须有名字：catalog 里缺名的行是脏数据，不编造 "index_1" 混进契约
function normalizeIndex (ix) {
  const name = String((ix && ix.name) || '')
  if (!name) {
    return null
  }
  return {
    name,
    unique: (ix && ix.unique) === true,
    primary: (ix && ix.primary) === true,
    columns: toArray(ix && ix.columns),
    method: strOrNull(ix && ix.method)
  }
}

function normalizeFk (fk) {
  const name = String((fk && fk.name) || '')
  if (!name) {
    return null
  }
  return {
    name,
    columns: toArray(fk && fk.columns),
    refSchema: strOrNull(fk && fk.refSchema),
    refTable: strOrNull(fk && fk.refTable),
    refColumns: toArray(fk && fk.refColumns),
    onDelete: fkAction(fk && fk.onDelete),
    onUpdate: fkAction(fk && fk.onUpdate)
  }
}

/**
 * 收口：保证形状完整、列按 ordinal 排序、主键信息与 indexes 对齐。
 *
 * 主键双写不是冗余：MySQL 的 COLUMN_KEY / PG 的 is_primary_key 是"列级标记"，
 * 前端补全与行定位读它；indexes 里的 primary 是"索引级视角"，F1 侧栏读它。
 * 引擎没给列级主键时（某些视图/分区表），从 indexes 反推补齐，避免前端两处判断不一致。
 */
function finalizeStructure (input) {
  const src = input || {}
  const columns = sortByOrdinal(
    (Array.isArray(src.columns) ? src.columns : [])
      .map(normalizeColumn)
      .filter(c => c.name)
  )
  const indexes = (Array.isArray(src.indexes) ? src.indexes : [])
    .map(normalizeIndex)
    // 表达式索引没有列名，但仍然是索引（PostgreSQL 允许 CREATE INDEX ON t (lower(x))）：
    // 不能因为 columns 为空就丢掉，否则结构面板会"少一条索引"
    .filter(ix => ix)
  const foreignKeys = (Array.isArray(src.foreignKeys) ? src.foreignKeys : [])
    .map(normalizeFk)
    .filter(fk => fk && fk.columns.length > 0)
  const pkFromIndex = new Set(
    (indexes.find(ix => ix.primary) || { columns: [] }).columns
  )
  if (pkFromIndex.size) {
    // 只补 true，不清 false：引擎明确说"不是主键"时不因为索引缺失就翻转
    columns.forEach(c => {
      if (pkFromIndex.has(c.name)) {
        c.isPrimaryKey = true
      }
    })
  }
  return {
    type: src.type === 'view' ? 'view' : 'table',
    columns,
    indexes,
    foreignKeys,
    comment: commentOrNull(src.comment),
    estimatedRows: rowsOrNull(src.estimatedRows)
  }
}

/**
 * PostgreSQL：pg_attribute/pg_index/pg_constraint 的行 → 契约。
 * 传进来的每一条都是 catalog 原始行，字段名见 postgres.js 里的 SQL 别名。
 */
function fromPg (raw) {
  const r = raw || {}
  const colRows = Array.isArray(r.columns) ? r.columns : []
  const idxRows = Array.isArray(r.indexes) ? r.indexes : []
  const fkRows = Array.isArray(r.foreignKeys) ? r.foreignKeys : []
  const table = r.table || {}
  return finalizeStructure({
    type: table.relkind === 'v' || table.relkind === 'm' ? 'view' : 'table',
    columns: colRows.map((c, i) => ({
      name: c.column_name,
      dataType: c.data_type || c.udt_name,
      columnType: c.column_type || c.udt_name || c.data_type,
      // PG 的 information_schema 给 'YES'/'NO'；pg_attribute 路线给布尔
      nullable: c.is_nullable !== undefined ? c.is_nullable : c.nullable,
      defaultValue: c.column_default,
      isPrimaryKey: c.is_primary_key === true || yesNo(c.is_primary_key),
      ordinal: c.ordinal_position !== undefined ? c.ordinal_position : c.ordinal,
      comment: c.comment,
      maxLength: c.character_maximum_length,
      // bytea 靠 udt_name 判定：data_type 在某些版本里也叫 bytea，但视图包装后会变成 USER-DEFINED
      udtName: c.udt_name
    })),
    indexes: idxRows.map(ix => ({
      name: ix.index_name,
      unique: ix.is_unique === true || yesNo(ix.is_unique),
      primary: ix.is_primary === true || yesNo(ix.is_primary),
      columns: ix.columns,
      method: ix.method
    })),
    foreignKeys: fkRows.map(fk => ({
      name: fk.name,
      columns: fk.columns,
      refSchema: fk.ref_schema,
      refTable: fk.ref_table,
      refColumns: fk.ref_columns,
      onDelete: fk.on_delete_code,
      onUpdate: fk.on_update_code
    })),
    comment: table.comment,
    estimatedRows: table.estimated_rows
  })
}

/**
 * MySQL：information_schema 的行 → 契约。
 * STATISTICS 是"一列一行"，所以索引要先按 INDEX_NAME 聚合（顺序由 SEQ_IN_INDEX 决定，
 * 顺序错会做出错误的复合索引判断）。
 */
function fromMysql (raw) {
  const r = raw || {}
  const colRows = Array.isArray(r.columns) ? r.columns : []
  const idxRows = Array.isArray(r.indexes) ? r.indexes : []
  const fkRows = Array.isArray(r.foreignKeys) ? r.foreignKeys : []
  const table = r.table || {}
  const isView = table.TABLE_TYPE === 'VIEW'

  const idxMap = new Map()
  for (const row of idxRows) {
    const name = String(row.INDEX_NAME || '')
    if (!name) {
      continue
    }
    if (!idxMap.has(name)) {
      idxMap.set(name, {
        name,
        unique: Number(row.NON_UNIQUE) === 0,
        primary: name === 'PRIMARY',
        columns: [],
        method: row.INDEX_TYPE || null,
        _rows: []
      })
    }
    const ix = idxMap.get(name)
    ix._rows.push({ seq: Number(row.SEQ_IN_INDEX) || 0, column: row.COLUMN_NAME })
  }
  for (const ix of idxMap.values()) {
    ix.columns = ix._rows
      .sort((a, b) => a.seq - b.seq)
      .map(x => x.column)
      .filter(Boolean)
    delete ix._rows
  }

  const fkMap = new Map()
  for (const row of fkRows) {
    const name = String(row.CONSTRAINT_NAME || '')
    if (!name) {
      continue
    }
    if (!fkMap.has(name)) {
      fkMap.set(name, {
        name,
        refSchema: row.REFERENCED_TABLE_SCHEMA,
        refTable: row.REFERENCED_TABLE_NAME,
        onDelete: row.DELETE_RULE,
        onUpdate: row.UPDATE_RULE,
        _rows: []
      })
    }
    const fk = fkMap.get(name)
    fk._rows.push({
      seq: Number(row.ORDINAL_POSITION) || 0,
      local: row.COLUMN_NAME,
      ref: row.REFERENCED_COLUMN_NAME
    })
  }
  for (const fk of fkMap.values()) {
    fk._rows.sort((a, b) => a.seq - b.seq)
    fk.columns = fk._rows.map(x => x.local).filter(Boolean)
    fk.refColumns = fk._rows.map(x => x.ref).filter(Boolean)
    delete fk._rows
  }

  return finalizeStructure({
    type: isView ? 'view' : 'table',
    columns: colRows.map(c => ({
      name: c.COLUMN_NAME,
      dataType: c.DATA_TYPE,
      columnType: c.COLUMN_TYPE,
      nullable: c.IS_NULLABLE,
      defaultValue: c.COLUMN_DEFAULT,
      // COLUMN_KEY 只有 PRIMARY/UNI/MUL 三种，只有 PRIMARY 算主键
      isPrimaryKey: String(c.COLUMN_KEY || '').toUpperCase() === 'PRI',
      ordinal: c.ORDINAL_POSITION,
      comment: c.COLUMN_COMMENT,
      // 字符列用字符数（utf8mb4 下 OCTET_LENGTH 是 4 倍，展示"长度"会误导）；
      // 二进制列没有字符长度，退到字节长度
      maxLength: c.CHARACTER_MAXIMUM_LENGTH !== null && c.CHARACTER_MAXIMUM_LENGTH !== undefined
        ? c.CHARACTER_MAXIMUM_LENGTH
        : c.CHARACTER_OCTET_LENGTH,
      udtName: c.DATA_TYPE
    })),
    indexes: Array.from(idxMap.values()),
    foreignKeys: Array.from(fkMap.values()),
    // 视图的 TABLE_COMMENT 是字面量 'VIEW'（MySQL 5.7/8 与 MariaDB 都如此），
    // 不是用户注释：直接透传会让表头/结构面板显示一个叫 "VIEW" 的注释。
    // 视图的真实注释 MySQL 侧本就无处可取（information_schema.VIEWS 没有注释列）→ null
    comment: isView ? null : table.TABLE_COMMENT,
    estimatedRows: table.TABLE_ROWS
  })
}

module.exports = {
  BINARY_TYPES,
  isBinaryType,
  yesNo,
  finalizeStructure,
  fromPg,
  fromMysql
}
