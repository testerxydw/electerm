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
  const tblRes = await c.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  )
  const current = c.database
  return dbRes.rows.map(row => ({
    name: row.datname,
    type: 'database',
    children: row.datname === current
      ? tblRes.rows.map(r => ({ name: r.tablename, type: 'table' }))
      : []
  }))
}

async function getPageData (conn, { database, table, page, pageSize, orderBy, order }) {
  const c = await getClient(conn)
  // pg 连接绑定单一库，跨库查询不支持
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  pageSize = Math.min(Number(pageSize) || 100, 1000)
  const offset = ((Number(page) || 1) - 1) * pageSize
  let sql = 'SELECT * FROM ' + quoteIdent(table)
  if (orderBy) {
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    sql += ' ORDER BY ' + quoteIdent(orderBy) + ' ' + dir
  }
  sql += ' LIMIT ' + pageSize + ' OFFSET ' + offset
  const res = await c.query(sql)
  return {
    rows: res.rows,
    hasMore: res.rows.length >= pageSize
  }
}

async function describeTable (conn, { table }) {
  const c = await getClient(conn)
  const res = await c.query(
    'SELECT column_name, data_type, is_nullable, column_default ' +
    'FROM information_schema.columns ' +
    "WHERE table_schema = 'public' AND table_name = $1 " +
    'ORDER BY ordinal_position',
    [String(table)]
  )
  return res.rows
}

// read-only whitelist: only allow SELECT/SHOW/DESC/EXPLAIN/with SELECT
const SQL_READONLY_RE = /^\s*(select|show|desc|describe|explain|with)\b/i

function checkReadonly (sql, readOnly) {
  if (readOnly && !SQL_READONLY_RE.test(sql)) {
    throw new Error('read-only mode: only SELECT/SHOW/DESC/EXPLAIN allowed')
  }
}

async function executeSql (conn, { sql, readOnly }) {
  const c = await getClient(conn)
  checkReadonly(sql, readOnly)
  const res = await c.query(sql)
  return {
    rows: res.rows || [],
    affected: res.command && res.command !== 'SELECT' ? res.rowCount : undefined,
    fields: Array.isArray(res.fields) ? res.fields.map(f => f.name) : []
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
  executeSql,
  closePostgresConnection
}
