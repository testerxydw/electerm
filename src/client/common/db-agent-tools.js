/**
 * AI Agent 数据库只读工具集的整形层（设计 §5.5 / 台账 S2-1）
 *
 * 为什么单独成文件：agent 工具返回的 JSON 会原样进上下文窗口，"把结果集整个
 * stringify"一轮就能吃掉大半窗口，而且把二进制列、超长文本一起拖进去。行数上限、
 * 单元格截断、截断标记在这里定死，store 侧只负责取数——纯函数、零依赖、脱组件脱库单测。
 *
 * 这一层刻意不含任何"执行"能力：五个工具里最接近写的是 db_insert_sql，而它只把文本
 * 落进 SQL 编辑器（人按运行、并照旧过危险 SQL 确认闸门），所以这里连 executeSql 的
 * 影子都没有。
 */

export const DB_AGENT_TAB_TYPE = 'database'
export const DB_AGENT_ROW_LIMIT_DEFAULT = 20
export const DB_AGENT_ROW_LIMIT_MAX = 50
export const DB_AGENT_CELL_MAX_CHARS = 200
export const DB_AGENT_TABLE_LIMIT_DEFAULT = 200
export const DB_AGENT_TABLE_LIMIT_MAX = 500
export const DB_AGENT_COLUMN_LIMIT = 120

function text (value) {
  return value === undefined || value === null ? '' : String(value)
}

function clampInt (value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return fallback
  }
  return Math.min(Math.floor(n), max)
}

// 缺省值不能当成 0：`Number(null)` 是 0，于是"没统计行数"会被读成"这表是空的"，
// "后端没回耗时"会被读成"1ms 就跑完了"
function numOr (value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 选出这次工具调用作用在哪个数据库页签。
 * 规则与 SFTP 侧的 mcpGetSshSftpRef 同口径：显式 tabId > 活动页签 > 唯一的那个数据库页签；
 * 有歧义时报错并把候选列出来，让模型改口而不是我们猜。
 */
export function resolveDbTab ({ tabs, activeTabId, requested } = {}) {
  const list = Array.isArray(tabs) ? tabs.filter(t => t && t.id) : []
  const dbTabs = list.filter(t => t.type === DB_AGENT_TAB_TYPE)
  if (!dbTabs.length) {
    throw new Error(
      'No database tab is open. Open one first with open_tab or open_bookmark (type "database"), then retry.'
    )
  }
  const id = text(requested)
  if (id) {
    const hit = list.find(t => t.id === id)
    if (!hit) {
      throw new Error(`Database tab not found: ${id}`)
    }
    if (hit.type !== DB_AGENT_TAB_TYPE) {
      throw new Error(`Tab "${id}" is not a database tab (type: ${hit.type || 'local'})`)
    }
    return { tab: hit, tabId: hit.id }
  }
  const active = activeTabId === undefined || activeTabId === null
    ? null
    : dbTabs.find(t => t.id === activeTabId)
  if (active) {
    return { tab: active, tabId: active.id }
  }
  if (dbTabs.length === 1) {
    return { tab: dbTabs[0], tabId: dbTabs[0].id }
  }
  const candidates = dbTabs.map(t => `${t.id} (${text(t.title) || text(t.dbName) || 'untitled'})`)
  throw new Error(
    `${dbTabs.length} database tabs are open and the active tab is not one of them; pass tabId. Open: ${candidates.join(', ')}`
  )
}

/**
 * 归一"现在连的是哪个库、选的是哪张表"。
 * 页签对象给连接级信息（host/port/只读/生产），会话页登记的上下文给运行时选择
 * （当前库/schema/表/已加载的列数）——后者缺省时退回页签上的默认库。
 */
export function buildDbContext ({ tab, tabId, context, hasSqlEditor = false } = {}) {
  const t = tab || {}
  const c = context || {}
  const dbType = text(c.dbType || t.dbType).toLowerCase()
  const readOnly = c.readOnly === undefined || c.readOnly === null
    ? !!t.readOnly
    : !!c.readOnly
  return {
    tabId: tabId === undefined ? t.id : tabId,
    title: text(t.title),
    dbType,
    // redis 没有 SQL 表/编辑器，模型据此换路子（而不是对着 redis 页签要表清单）
    supportsSql: dbType !== 'redis',
    host: text(t.dbHost),
    port: t.dbPort === undefined ? null : t.dbPort,
    file: text(t.dbFile),
    user: text(t.dbUser),
    database: text(c.database) || text(t.dbName) || text(t.dbUser),
    schema: text(c.schema),
    table: text(c.table),
    loadedColumns: Array.isArray(c.columns) ? c.columns.length : 0,
    readOnly,
    production: !!t.production,
    hasSqlEditor: !!hasSqlEditor
  }
}

/**
 * `getMetadata` 的树 → 表清单（带 table/view 区分与 schema 归属）。
 * 与补全用的 flattenTables 不同：那边只要不重复的表名，这边模型要分清视图和基表，
 * PG 还要知道表挂在哪个 schema 下。库名匹配同样宽松（大小写不敏感）。
 */
export function collectTables (metadata, database, { limit = DB_AGENT_TABLE_LIMIT_DEFAULT } = {}) {
  const want = text(database).toLowerCase()
  const out = []
  const seen = new Set()
  const databases = []
  const pushNodes = (nodes, schemaName) => {
    for (const node of nodes || []) {
      if (!node || !node.name) {
        continue
      }
      const kind = text(node.type)
      if (kind === 'table' || kind === 'view') {
        const key = `${schemaName}.${String(node.name).toLowerCase()}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ name: String(node.name), kind, schema: schemaName })
        }
      } else if (Array.isArray(node.children)) {
        // schema 分组节点（PG）把名字带下去；其它分组层（MySQL 的 table/view 归组）原样穿透
        pushNodes(node.children, kind === 'schema' ? String(node.name) : schemaName)
      }
    }
  }
  for (const db of metadata || []) {
    if (!db || !db.name) {
      continue
    }
    databases.push(String(db.name))
    if (want && String(db.name).toLowerCase() !== want) {
      continue
    }
    if (db.error) {
      throw new Error(`Metadata for database "${db.name}" failed: ${text(db.error)}`)
    }
    pushNodes(db.children, '')
  }
  if (want && !databases.some(d => d.toLowerCase() === want)) {
    throw new Error(
      `Database "${database}" is not visible on this connection. Available: ${databases.join(', ') || 'none'}`
    )
  }
  out.sort((a, b) => {
    const ka = `${a.schema}.${a.name}`.toLowerCase()
    const kb = `${b.schema}.${b.name}`.toLowerCase()
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  const max = clampInt(limit, DB_AGENT_TABLE_LIMIT_DEFAULT, DB_AGENT_TABLE_LIMIT_MAX)
  return {
    database: want || '',
    tables: out.slice(0, max),
    totalTables: out.length,
    truncated: out.length > max,
    databases
  }
}

/**
 * 元数据契约 v2（`getTableStructure`）→ 给模型看的紧凑描述。
 * 索引与外键全量给（这两样是写 SQL 真正需要的），列按上限截断并标 truncated。
 */
export function summarizeStructure (structure, { table = '', database = '', schema = '', limit = DB_AGENT_COLUMN_LIMIT } = {}) {
  const s = structure || {}
  const allColumns = Array.isArray(s.columns) ? s.columns : []
  const columns = allColumns.slice(0, limit).map(col => {
    const c = col || {}
    const out = {
      name: text(c.name),
      type: text(c.columnType || c.dataType),
      nullable: !!c.nullable,
      primaryKey: !!c.isPrimaryKey
    }
    if (c.defaultValue !== undefined && c.defaultValue !== null) {
      out.defaultValue = text(c.defaultValue)
    }
    if (c.comment) {
      out.comment = text(c.comment)
    }
    return out
  })
  return {
    database: text(database),
    schema: text(schema),
    table: text(table),
    objectType: text(s.type) || 'table',
    comment: text(s.comment),
    estimatedRows: numOr(s.estimatedRows, null),
    columns,
    totalColumns: allColumns.length,
    truncatedColumns: allColumns.length > columns.length,
    indexes: (Array.isArray(s.indexes) ? s.indexes : []).map(idx => ({
      name: text((idx || {}).name),
      unique: !!(idx || {}).unique,
      primary: !!(idx || {}).primary,
      columns: (((idx || {}).columns) || []).map(text)
    })),
    foreignKeys: (Array.isArray(s.foreignKeys) ? s.foreignKeys : []).map(fk => {
      const f = fk || {}
      const ref = text(f.refSchema) ? `${f.refSchema}.${text(f.refTable)}` : text(f.refTable)
      return {
        name: text(f.name),
        columns: (f.columns || []).map(text),
        references: `${ref}(${(f.refColumns || []).map(text).join(', ')})`,
        onDelete: text(f.onDelete),
        onUpdate: text(f.onUpdate)
      }
    })
  }
}

// 单元格：NULL 保持 JSON null（与空字符串区分，同 H2 的口径），二进制只报长度，
// 超长文本截断并计数——否则一个 longtext 列就能把整轮上下文顶掉
function toCell (value, maxCellChars, stats) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) {
      stats.binaryCells += 1
      return `<binary ${value.byteLength} bytes>`
    }
    let json
    try {
      json = JSON.stringify(value)
    } catch (err) {
      json = String(value)
    }
    return clip(json, maxCellChars, stats)
  }
  return clip(String(value), maxCellChars, stats)
}

function clip (str, maxCellChars, stats) {
  if (str.length <= maxCellChars) {
    return str
  }
  stats.truncatedCells += 1
  return str.slice(0, maxCellChars) + '…'
}

function columnNames (set, rows) {
  const declared = set && Array.isArray(set.columns) && set.columns.length
    ? set.columns
    : set && Array.isArray(set.fields) ? set.fields : null
  if (declared) {
    return declared.map(c => (c && typeof c === 'object' ? text(c.name) : text(c)))
  }
  // 网格分页（getPageData）只回行数据，列名从第一行取——与会话页表头同一口径
  return rows.length && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : []
}

/**
 * 屏幕上那份结果集 → 前 N 行。
 * snapshot 由会话页登记（source='sql-result' 是人刚跑出来的 SQL 结果，
 * 'grid' 是数据网格当前页），这里只切片与截断，不产生任何新查询。
 */
export function summarizeResultSnapshot (snapshot, {
  resultIndex = 0,
  offset = 0,
  limit = DB_AGENT_ROW_LIMIT_DEFAULT,
  maxCellChars = DB_AGENT_CELL_MAX_CHARS
} = {}) {
  if (!snapshot) {
    return null
  }
  const results = Array.isArray(snapshot.results) ? snapshot.results : []
  const idx = Math.min(Math.max(Number(resultIndex) || 0, 0), Math.max(results.length - 1, 0))
  const set = results[idx] || {}
  const rows = Array.isArray(set.rows) ? set.rows : []
  const from = Math.max(Number(offset) || 0, 0)
  const take = clampInt(limit, DB_AGENT_ROW_LIMIT_DEFAULT, DB_AGENT_ROW_LIMIT_MAX)
  const stats = { truncatedCells: 0, binaryCells: 0 }
  const cols = columnNames(set, rows)
  const page = rows.slice(from, from + take).map(row => {
    if (!row || typeof row !== 'object') {
      return { value: toCell(row, maxCellChars, stats) }
    }
    const out = {}
    for (const name of cols) {
      out[name] = toCell(row[name], maxCellChars, stats)
    }
    return out
  })
  return {
    source: text(snapshot.source) || 'sql-result',
    resultIndex: idx,
    resultCount: results.length,
    columns: cols,
    offset: from,
    returnedRows: page.length,
    totalRows: rows.length,
    hasMoreRows: from + page.length < rows.length,
    // 网格当前页之外还有没有下一页（SQL 结果集没有分页概念，恒为 false）
    hasMorePages: snapshot.hasMore === true,
    truncatedCells: stats.truncatedCells,
    binaryCells: stats.binaryCells,
    maxCellChars,
    rows: page,
    elapsedMs: numOr(snapshot.elapsedMs, null),
    error: text(snapshot.error),
    affected: numOr(set.affected, undefined),
    table: text(snapshot.table),
    page: numOr(snapshot.page, undefined),
    totalRowsEstimate: numOr(snapshot.totalRows, undefined)
  }
}
