/**
 * mysql connection helper (lazy loaded driver)
 * Phase1: testConnection; Phase2: metadata / pagination / sql
 */

const log = require('../../common/log')

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
    enableKeepAlive: true,
    // 支持一次执行多条语句（分号分隔）→ 多结果集；
    // 只读模式下"全句写关键词扫描"会拦住 `SELECT 1; DROP TABLE t` 这类组合，故不放大写风险
    multipleStatements: true
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

// 系统库不入树（无业务表，白占树高）；过滤默认开
const DB_SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']
// 并发上限与 pool connectionLimit(4) 一致：串行 SHOW TABLES × N 库是元数据加载慢的主因
const METADATA_CONCURRENCY = 4

// 限并发 map（保序）：Promise.all 全并发会打满连接池排队，串行则 N+1 慢
async function mapLimit (list, limit, fn) {
  const ret = new Array(list.length)
  let i = 0
  async function worker () {
    while (i < list.length) {
      const idx = i++
      ret[idx] = await fn(list[idx])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, worker)
  )
  return ret
}

// 单值安全化：IPC 走结构化克隆，只有纯值能安全穿越；
// Date/bigint 先行处理，Buffer 摘要，其余带原型的对象（Decimal 实例、自定义类型等）
// 统一转字符串，避免 "An object could not be cloned" 导致整页数据丢失。
function safeCell (v) {
  if (v === null || v === undefined) {
    return null
  }
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return v
  }
  if (v instanceof Date) {
    return v.toISOString()
  }
  if (t === 'bigint') {
    return v.toString()
  }
  // 注意：不要用 Buffer.isBuffer —— 主进程经打包后 Buffer 可能被替换为
  // `buffer` polyfill，其 isBuffer 对「原生 Buffer 实例」返回 false；
  // Buffer 继承自 Uint8Array，用 instanceof 判断对两种实现都成立。
  if (v instanceof Uint8Array) {
    return `<binary ${v.length} bytes>`
  }
  // 有 toJSON 的优先（驱动自定义类型如 mysql2 的 DECIMAL 包装）
  if (typeof v.toJSON === 'function') {
    try {
      return safeCell(v.toJSON())
    } catch (e) {
      // fallthrough
    }
  }
  try {
    return String(v)
  } catch (e) {
    return null
  }
}

function rowToPlain (rows) {
  return rows.map(r => {
    const o = {}
    for (const k of Object.keys(r)) {
      o[k] = safeCell(r[k])
    }
    return o
  })
}

async function getMetadata (conn) {
  const pool = await getPool(conn)
  const [dbs] = await pool.query('SHOW DATABASES')
  const dbNames = dbs
    .map(d => d.Database)
    .filter(n => !DB_SYSTEM_SCHEMAS.includes(String(n).toLowerCase()))
  // per-db try/catch：单库失败（权限不足等）不再拖垮整棵树，
  // 降级为「库名在 + children 空 + error 标记」，前端提示后可点刷新重试
  return mapLimit(dbNames, METADATA_CONCURRENCY, async dbName => {
    try {
      const safe = String(dbName).replace(/[`]/g, '')
      const [tables] = await pool.query('SHOW TABLES FROM `' + safe + '`')
      const tableKey = Object.keys(tables[0] || {})[0]
      return {
        name: dbName,
        type: 'database',
        children: (tables || []).map(t => ({
          name: t[tableKey],
          type: 'table'
        }))
      }
    } catch (e) {
      log.warn('getMetadata db failed:', dbName, e.message)
      return {
        name: dbName,
        type: 'database',
        children: [],
        error: e.message
      }
    }
  })
}

function quoteIdent (name) {
  return '`' + String(name).replace(/[`]/g, '') + '`'
}

// 近似总行数（information_schema，瞬时完成，不扫全表）；
// 用于前端区分「表真的是空的」与「查询失败」。InnoDB 下是估算值。
async function getApproxRows (pool, database, table) {
  try {
    const [r] = await pool.execute(
      'SELECT TABLE_ROWS AS c FROM information_schema.TABLES ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [String(database), String(table)]
    )
    const n = r && r[0] && r[0].c
    return n === null || n === undefined ? undefined : Number(n)
  } catch (e) {
    return undefined
  }
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
  log.debug('getPageData sql:', sql)
  const [rows] = await pool.query(sql)
  const totalRows = database ? await getApproxRows(pool, database, table) : undefined
  return {
    rows: rowToPlain(rows),
    hasMore: rows.length >= pageSize,
    totalRows
  }
}

// 与 postgres 适配器统一为 ({ table, database }) 入参：
// dbClientOp 统一以对象透传 args，若此处收字符串会得到 `DESC \`[object Object]\``。
// 带库前缀可正确解析「当前连接库之外」的表。
async function describeTable (conn, { table, database }) {
  const pool = await getPool(conn)
  const full = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const [cols] = await pool.query('DESC ' + full)
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

// 把单个查询结果规范成 { rows, affected, fields }
function toResult (rows, fields) {
  const isRows = Array.isArray(rows)
  return {
    rows: isRows ? rowToPlain(rows) : [],
    affected: !isRows && rows && typeof rows === 'object' && 'affectedRows' in rows
      ? rows.affectedRows
      : undefined,
    fields: Array.isArray(fields) ? fields.map(f => f.name) : []
  }
}

// 多语句时 mysql2 返回 [results[], fields[]]（元素本身是数组），
// 统一规范为 results 数组，由前端按结果集数量决定渲染（1 个直接表格 / 多个用 tab）
function normalizeResults (rows, fields) {
  const isMulti = Array.isArray(fields) && Array.isArray(fields[0])
  if (!isMulti) {
    return [toResult(rows, fields)]
  }
  return rows.map((r, i) => toResult(r, fields[i]))
}

async function executeSql (conn, { sql, readOnly }) {
  // 先做只读校验（不触网），被拒时无需建立连接
  checkReadonly(sql, readOnly)
  const pool = await getPool(conn)
  const [rows, fields] = await pool.query(sql)
  return {
    results: normalizeResults(rows, fields)
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
