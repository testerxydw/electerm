/**
 * postgres connection helper (lazy loaded driver)
 * PostgreSQL 无法跨库查询（一个连接一个库）：
 * 元数据树列出所有库，但仅当前连接库展开表列表；
 * 浏览其他库需新建指向该库的书签连接
 */

const clients = new Map()
// per-tab 引用计数：同签名连接被多个 tab 共享，最后一个 tab 关闭时才真正断开
const refs = new Map()

function sig (conn) {
  return `${conn.dbHost}:${conn.dbPort}:${conn.dbUser}:${conn.dbName || ''}`
}

async function getClient (conn) {
  const key = sig(conn)
  if (clients.has(key)) {
    return clients.get(key)
  }
  const { Client } = require('pg')
  const c = new Client({
    host: conn.dbHost,
    port: conn.dbPort,
    user: conn.dbUser,
    password: conn.dbPassword || undefined,
    database: conn.dbName || conn.dbUser,
    connectionTimeoutMillis: 8000
  })
  await c.connect()
  clients.set(key, c)
  return c
}

// openDbTab 时调用：计数 +1 并确保连接建立（SELECT 1 验证，失败上抛）
async function acquire (conn) {
  const key = sig(conn)
  refs.set(key, (refs.get(key) || 0) + 1)
  const c = await getClient(conn)
  await c.query('SELECT 1')
  return c
}

// closeDbTab 时调用：计数 -1，归零才 end client
async function release (conn) {
  const key = sig(conn)
  const n = (refs.get(key) || 0) - 1
  refs.set(key, n)
  if (n > 0) {
    return
  }
  refs.delete(key)
  const c = clients.get(key)
  if (c) {
    clients.delete(key)
    await c.end().catch(() => {})
  }
}

function quoteIdent (name) {
  return '"' + String(name).replace(/"/g, '') + '"'
}

async function testPostgresConnection (conn) {
  const { Client } = require('pg')
  const c = new Client({
    host: conn.dbHost,
    port: conn.dbPort,
    user: conn.dbUser,
    password: conn.dbPassword || undefined,
    database: conn.dbName || conn.dbUser,
    connectionTimeoutMillis: 8000
  })
  try {
    await c.connect()
    await c.query('SELECT 1')
    return 'postgres ok'
  } finally {
    await c.end().catch(() => {})
  }
}

// ---- Phase2 methods ----

async function getMetadata (conn) {
  const c = await getClient(conn)
  const dbRes = await c.query(
    'SELECT datname FROM pg_database ' +
    'WHERE datistemplate = false AND datallowconn = true ORDER BY datname'
  )
  // 当前库的 schema 层级：排除系统 schema，空 schema 也保留
  const schRes = await c.query(
    'SELECT nspname FROM pg_namespace ' +
    'WHERE nspname NOT LIKE \'pg\\_%\' AND nspname <> \'information_schema\' ' +
    'ORDER BY nspname'
  )
  const tblRes = await c.query(
    'SELECT schemaname, tablename FROM pg_tables ' +
    "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') " +
    'ORDER BY schemaname, tablename'
  )
  const bySchema = new Map()
  for (const r of schRes.rows) {
    bySchema.set(r.nspname, [])
  }
  for (const r of tblRes.rows) {
    if (!bySchema.has(r.schemaname)) {
      bySchema.set(r.schemaname, [])
    }
    bySchema.get(r.schemaname).push({ name: r.tablename, type: 'table' })
  }
  const current = c.database
  return dbRes.rows.map(row => ({
    name: row.datname,
    type: 'database',
    children: row.datname === current
      ? Array.from(bySchema.keys()).sort().map(name => ({
        name,
        type: 'schema',
        children: bySchema.get(name)
      }))
      : []
  }))
}

async function getPageData (conn, { database, schema, table, page, pageSize, orderBy, order }) {
  const c = await getClient(conn)
  // pg 连接绑定单一库，跨库查询不支持
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  pageSize = Math.min(Number(pageSize) || 100, 1000)
  const offset = ((Number(page) || 1) - 1) * pageSize
  // 显式 schema 限定，避免依赖 search_path；默认 public 兼容旧书签
  let sql = 'SELECT * FROM ' + quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  if (orderBy) {
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    sql += ' ORDER BY ' + quoteIdent(orderBy) + ' ' + dir
  }
  // 多取 1 行判定是否还有下一页：末页恰好整页时 hasMore 不再误报 true
  sql += ' LIMIT ' + (pageSize + 1) + ' OFFSET ' + offset
  const res = await c.query(sql)
  return {
    rows: res.rows.slice(0, pageSize),
    hasMore: res.rows.length > pageSize
  }
}

async function describeTable (conn, { table, schema }) {
  const c = await getClient(conn)
  const sch = schema || 'public'
  const res = await c.query(
    'SELECT column_name, data_type, is_nullable, column_default ' +
    'FROM information_schema.columns ' +
    'WHERE table_schema = $1 AND table_name = $2 ' +
    'ORDER BY ordinal_position',
    [sch, String(table)]
  )
  // 主键列标记：前端据此决定单元格能否安全定位行
  const pkRes = await c.query(
    'SELECT a.attname AS column_name FROM pg_index i ' +
    'JOIN pg_class t ON t.oid = i.indrelid ' +
    'JOIN pg_namespace n ON n.oid = t.relnamespace ' +
    'JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey) ' +
    'WHERE i.indisprimary AND n.nspname = $1 AND t.relname = $2',
    [sch, String(table)]
  )
  const pkSet = new Set(pkRes.rows.map(r => r.column_name))
  return res.rows.map(r => ({
    ...r,
    is_primary_key: pkSet.has(r.column_name)
  }))
}

// 精确总行数（按需触发；大表会全扫描，故不默认执行）
async function countRows (conn, { database, schema, table }) {
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const full = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  const res = await c.query('SELECT COUNT(*) AS c FROM ' + full)
  const n = res.rows && res.rows[0] ? res.rows[0].c : 0
  return { count: Number(n) || 0 }
}

// 单元格编辑写入门控：只读模式下由主进程直接拒绝（渲染层传参不可信）
function checkWritable (readOnly) {
  if (readOnly) {
    throw new Error('read-only mode: cell update disabled')
  }
}

// 单元格 UPDATE：值走 $1/$2 占位符绑定，标识符按双引号引用
async function updateCell (conn, { database, schema, table, pkColumn, pkValue, column, value, readOnly }) {
  checkWritable(readOnly)
  if (!column || !pkColumn) {
    throw new Error('updateCell requires column and pkColumn')
  }
  if (pkValue === null || pkValue === undefined) {
    throw new Error('updateCell requires a primary key value')
  }
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const full = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  const res = await c.query(
    'UPDATE ' + full +
    ' SET ' + quoteIdent(column) + ' = $1' +
    ' WHERE ' + quoteIdent(pkColumn) + ' = $2',
    [value === undefined ? null : value, pkValue]
  )
  return { affected: res.rowCount }
}

// 整行 INSERT：列清单由 values keys 生成（至少 1 列），值走 $n 占位符绑定，
// 标识符按双引号引用（约束与 updateCell 一致）
async function insertRow (conn, { database, schema, table, values, readOnly }) {
  checkWritable(readOnly)
  const cols = Object.keys(values || {}).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRow requires at least one column value')
  }
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const full = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  const sql = 'INSERT INTO ' + full +
    ' (' + cols.map(quoteIdent).join(', ') + ')' +
    ' VALUES (' + cols.map((_, i) => '$' + (i + 1)).join(', ') + ')'
  const res = await c.query(
    sql,
    cols.map(k => (values[k] === undefined ? null : values[k]))
  )
  return { affected: res.rowCount }
}

// 整行 DELETE 批量上限：防误操作大范围删除 + IN 子句过长
const DELETE_ROWS_LIMIT = 200

// 整行 DELETE：仅主键 IN 定位；无主键表无法安全定位行，直接拒绝并引导走 SQL 页
async function deleteRows (conn, { database, schema, table, pkColumn, pkValues, readOnly }) {
  checkWritable(readOnly)
  if (!pkColumn) {
    throw new Error('deleteRows requires a primary key column (no-pk table, use SQL page instead)')
  }
  const list = Array.isArray(pkValues) ? pkValues : []
  if (!list.length) {
    throw new Error('deleteRows requires at least one primary key value')
  }
  if (list.length > DELETE_ROWS_LIMIT) {
    throw new Error(`deleteRows supports up to ${DELETE_ROWS_LIMIT} rows at once`)
  }
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const full = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  const sql = 'DELETE FROM ' + full +
    ' WHERE ' + quoteIdent(pkColumn) +
    ' IN (' + list.map((_, i) => '$' + (i + 1)).join(', ') + ')'
  const res = await c.query(sql, list)
  return { affected: res.rowCount }
}

// 只读白名单：首关键词必须在允许集合内，且全句不得出现写关键词。
// 只校验首关键词会被 `WITH x AS (...) DELETE FROM t` 绕过（MySQL 8 / PG 均支持该写语法），
// 故追加一次全句写关键词扫描；宁可误拒（如 EXPLAIN DELETE），也不放行写操作。
const SQL_READONLY_RE = /^\s*(select|show|desc|describe|explain|with)\b/i
const SQL_WRITE_RE = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|rename|merge|call|exec|execute|lock|unlock|attach|detach|vacuum|copy|load|set|into)\b/i

function checkReadonly (sql, readOnly) {
  if (!readOnly) {
    return
  }
  const s = String(sql || '')
  if (!SQL_READONLY_RE.test(s)) {
    throw new Error('read-only mode: only SELECT/SHOW/DESC/EXPLAIN are allowed')
  }
  if (SQL_WRITE_RE.test(s)) {
    throw new Error('read-only mode: statement contains a write keyword')
  }
}

// ---------------------------------------------------------------- 补全列元数据
// 阶段4 A-5 的列补全数据源（设计 §4.3）。
// 主键不在 information_schema.columns 上，需 join 约束视图；用 LEFT JOIN 而不是
// 两次查询，避免"有表但没有主键"时丢行。PG 无法跨库查询，table_catalog 恒为当前库，
// 这里仍显式带上（切库连接的唯一性由 sig() 保证）。
const LIST_COLUMNS_SQL =
  'SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, ' +
  'c.udt_name AS ty, (pk.column_name IS NOT NULL) AS is_pk ' +
  'FROM information_schema.columns c ' +
  'LEFT JOIN ( ' +
  '  SELECT kcu.table_schema, kcu.table_name, kcu.column_name ' +
  '  FROM information_schema.table_constraints tc ' +
  '  JOIN information_schema.key_column_usage kcu ' +
  '    ON kcu.constraint_name = tc.constraint_name ' +
  '   AND kcu.table_schema = tc.table_schema ' +
  "  WHERE tc.constraint_type = 'PRIMARY KEY' " +
  ') pk ON pk.table_schema = c.table_schema ' +
  '  AND pk.table_name = c.table_name ' +
  '  AND pk.column_name = c.column_name ' +
  'WHERE c.table_catalog = $1 ' +
  'ORDER BY c.table_schema, c.table_name, c.ordinal_position'

// 纯函数（导出仅供单测）：查询行 → [{ schema, table, columns: [{ name, type, pk }] }]
// 与 MySQL 的差异：PG 有 schema 层，同名表在不同 schema 下必须区分，故多带一个字段；
// type 用 udt_name（varchar/int4/timestamptz）而非 data_type（character varying）——
// 前者是用户写 DDL 时的写法，补全候选里更贴近实际输入
function groupColumns (rows) {
  const out = []
  let cur = null
  for (const r of rows || []) {
    if (!cur || cur.schema !== r.s || cur.table !== r.t) {
      cur = { schema: r.s, table: r.t, columns: [] }
      out.push(cur)
    }
    cur.columns.push({
      name: r.c,
      type: r.ty || '',
      pk: r.is_pk === true
    })
  }
  return out
}

async function listColumns (conn, { schema } = {}) {
  const c = await getClient(conn)
  const dbName = conn.dbName || conn.dbUser
  if (!dbName) {
    return { tables: [] }
  }
  // schema 过滤放在 SQL 外的参数上：这里只按库圈定，schema 由调用方在前端筛
  // （一次取全库，切 schema 不用重新请求）
  const res = await c.query(LIST_COLUMNS_SQL, [dbName])
  const tables = groupColumns(res.rows)
  return {
    tables: schema ? tables.filter(t => t.schema === schema) : tables
  }
}

async function executeSql (conn, { sql, readOnly }) {
  // 先做只读校验（不触网），被拒时无需建立连接
  checkReadonly(sql, readOnly)
  const c = await getClient(conn)
  const res = await c.query(sql)
  // pg 执行多语句时返回结果数组（每条语句一个 result），统一为 results
  const list = Array.isArray(res) ? res : [res]
  return {
    results: list.map(r => ({
      rows: r.rows || [],
      affected: r.command && r.command !== 'SELECT' ? r.rowCount : undefined,
      fields: Array.isArray(r.fields) ? r.fields.map(f => f.name) : []
    }))
  }
}

// 无参全清（app 退出兜底）
async function closePostgresConnection () {
  for (const c of clients.values()) {
    await c.end().catch(() => {})
  }
  clients.clear()
  refs.clear()
}

module.exports = {
  testPostgresConnection,
  acquire,
  release,
  getMetadata,
  getPageData,
  describeTable,
  updateCell,
  insertRow,
  deleteRows,
  countRows,
  executeSql,
  listColumns,
  closePostgresConnection,
  // 纯函数导出仅供单测（列分组）
  groupColumns
}
