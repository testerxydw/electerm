/**
 * mysql connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: metadata / pagination / sql
 */

const pools = new Map()

function sig (conn) {
  return `${conn.dbHost}:${conn.dbPort}:${conn.dbUser}:${conn.dbName || ''}`
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

async function getPageData (conn, { table, page, pageSize, orderBy, order }) {
  const pool = await getPool(conn)
  pageSize = Math.min(Number(pageSize) || 100, 1000)
  const offset = ((Number(page) || 1) - 1) * pageSize
  let sql = 'SELECT * FROM `' + table + '`'
  if (orderBy) {
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    sql += ' ORDER BY `' + String(orderBy).replace(/[`]/g, '') + '` ' + dir
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

// read-only whitelist: only allow SELECT/SHOW/DESC/EXPLAIN/with SELECT
const SQL_READONLY_RE = /^\s*(select|show|desc|describe|explain|with)\b/i

function checkReadonly (sql, readOnly) {
  if (readOnly && !SQL_READONLY_RE.test(sql)) {
    throw new Error('read-only mode: only SELECT/SHOW/DESC/EXPLAIN allowed')
  }
}

async function executeSql (conn, { sql, readOnly }) {
  const pool = await getPool(conn)
  checkReadonly(sql, readOnly)
  const [rows, fields] = await pool.query(sql)
  return {
    rows: Array.isArray(rows) ? rowToPlain(rows) : [],
    affected: rows && typeof rows === 'object' && 'affectedRows' in rows ? rows.affectedRows : undefined,
    fields: Array.isArray(fields) ? fields.map(f => f.name) : []
  }
}

async function closeMysqlConnection () {
  for (const pool of pools.values()) {
    await pool.end().catch(() => {})
  }
  pools.clear()
}

module.exports = {
  testMysqlConnection,
  getMetadata,
  getPageData,
  describeTable,
  executeSql,
  closeMysqlConnection
}
