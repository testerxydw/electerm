/**
 * mysql connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: metadata / pagination / sql
 */

const pools = new Map()
// per-tab 引用计数：同签名连接被多个 tab 共享，最后一个 tab 关闭时才真正断开
const refs = new Map()

function sig (conn) {
  return `${conn.dbHost}:${conn.dbPort}:${conn.dbUser}:${conn.dbName || ''}`
}

// openDbTab 时调用：计数 +1 并确保连接建立（失败上抛）
function acquire (conn) {
  const key = sig(conn)
  refs.set(key, (refs.get(key) || 0) + 1)
  return getPool(conn)
}

// closeDbTab 时调用：计数 -1，归零才 end pool
async function release (conn) {
  const key = sig(conn)
  const n = (refs.get(key) || 0) - 1
  refs.set(key, n)
  if (n > 0) {
    return
  }
  refs.delete(key)
  const pool = pools.get(key)
  if (pool) {
    pools.delete(key)
    await pool.end().catch(() => {})
  }
}

async function getPool (conn) {
  const key = sig(conn)
  if (pools.has(key)) {
    return pools.get(key)
  }
  const mysql = require('mysql2/promise')
  const pool = mysql.createPool({
    host: conn.dbHost,
    port: conn.dbPort,
    user: conn.dbUser || 'root',
    password: conn.dbPassword || '',
    database: conn.dbName || undefined,
    connectTimeout: 8000,
    waitForConnections: true,
    connectionLimit: 4,
    enableKeepAlive: true
  })
  pools.set(key, pool)
  return pool
}

async function testMysqlConnection (conn) {
  const mysql = require('mysql2/promise')
  const c = await mysql.createConnection({
    host: conn.dbHost,
    port: conn.dbPort,
    user: conn.dbUser || 'root',
    password: conn.dbPassword || '',
    database: conn.dbName || undefined,
    connectTimeout: 8000
  })
  try {
    await c.ping()
    return 'mysql ok'
  } finally {
    await c.end().catch(() => {})
  }
}

// ---- Phase2 methods ----

function rowToPlain (rows) {
  return rows.map(r => {
    const o = {}
    for (const k of Object.keys(r)) {
      o[k] = (r[k] instanceof Date)
        ? r[k].toISOString()
        : (typeof r[k] === 'bigint' ? r[k].toString() : r[k])
    }
    return o
  })
}

async function getMetadata (conn) {
  const pool = await getPool(conn)
  const [dbs] = await pool.query('SHOW DATABASES')
  const list = []
  for (const d of dbs) {
    const dbName = d.Database
    const [tables] = await pool.query('SHOW TABLES FROM `' + dbName + '`')
    const tableKey = Object.keys(tables[0] || {})[0]
    list.push({
      name: dbName,
      type: 'database',
      children: (tables || []).map(t => ({
        name: t[tableKey],
        type: 'table'
      }))
    })
  }
  return list
}

function quoteIdent (name) {
  return '`' + String(name).replace(/[`]/g, '') + '`'
}

async function getPageData (conn, { database, table, page, pageSize, orderBy, order }) {
  const pool = await getPool(conn)
  pageSize = Math.min(Number(pageSize) || 100, 1000)
  const offset = ((Number(page) || 1) - 1) * pageSize
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  let sql = 'SELECT * FROM ' + fullTable
  if (orderBy) {
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    sql += ' ORDER BY ' + quoteIdent(orderBy) + ' ' + dir
  }
  sql += ' LIMIT ' + pageSize + ' OFFSET ' + offset
  const [rows] = await pool.query(sql)
  return {
    rows: rowToPlain(rows),
    hasMore: rows.length >= pageSize
  }
}

async function describeTable (conn, table) {
  const pool = await getPool(conn)
  const [cols] = await pool.query('DESC `' + table + '`')
  return rowToPlain(cols)
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

async function executeSql (conn, { sql, readOnly }) {
  // 先做只读校验（不触网），被拒时无需建立连接
  checkReadonly(sql, readOnly)
  const pool = await getPool(conn)
  const [rows, fields] = await pool.query(sql)
  return {
    rows: Array.isArray(rows) ? rowToPlain(rows) : [],
    affected: rows && typeof rows === 'object' && 'affectedRows' in rows ? rows.affectedRows : undefined,
    fields: Array.isArray(fields) ? fields.map(f => f.name) : []
  }
}

// 无参全清（app 退出兜底）；有参按引用计数释放
async function closeMysqlConnection (conn) {
  if (!conn) {
    for (const pool of pools.values()) {
      await pool.end().catch(() => {})
    }
    pools.clear()
    refs.clear()
    return
  }
  await release(conn)
}

module.exports = {
  testMysqlConnection,
  acquire,
  release,
  getMetadata,
  getPageData,
  describeTable,
  executeSql,
  closeMysqlConnection
}
