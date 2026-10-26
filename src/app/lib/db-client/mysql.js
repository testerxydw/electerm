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

// 系统库名单：仅当调用方显式 hideSystemSchemas 时过滤。
// 默认全显（专业工具惯例，排查权限/性能常需 information_schema/mysql），
// 显示开关由前端持久化（config.dbHideSystemSchemas），后端不越权替用户做决定
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
// Date/bigint 先行处理，Buffer 转 __bin 信封，其余带原型的对象（Decimal 实例、自定义类型等）
// 统一转字符串，避免 "An object could not be cloned" 导致整页数据丢失。
//
// F3 二进制传输修复（设计 §9.1）：二进制列不再转 `<binary N bytes>` 占位字符串
// （那会直接丢掉数据），改成携带 base64 前缀的 `__bin` 信封，导出/预览都能复用。
// 大字段只带前缀供预览，全量取回走独立 op getCellBinary，不进 getPageData。
const INLINE_LIMIT = 64 * 1024
// 超限时只随信封带前 BIN_PREFIX_LIMIT 字节供预览（16KB base64，一页 400 行也不会拖垮渲染）
const BIN_PREFIX_LIMIT = 4096

// Buffer 继承自 Uint8Array；主进程经打包后 Buffer 可能被替换为 `buffer` polyfill，
// 其 isBuffer 对「原生 Buffer 实例」返回 false，故一律用 instanceof Uint8Array 判定，
// 再经 Buffer.from 归一后取 base64（对两种实现都成立）。
function binEnvelope (v) {
  const buf = Buffer.from(v)
  const size = buf.length
  if (size <= INLINE_LIMIT) {
    return { __bin: { size, b64: buf.toString('base64'), truncated: false } }
  }
  return {
    __bin: {
      size,
      b64: buf.subarray(0, BIN_PREFIX_LIMIT).toString('base64'),
      truncated: true
    }
  }
}

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
    return binEnvelope(v)
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

async function getMetadata (conn, args) {
  const pool = await getPool(conn)
  const [dbs] = await pool.query('SHOW DATABASES')
  const hideSys = args && args.hideSystemSchemas === true
  const dbNames = dbs
    .map(d => d.Database)
    .filter(n => !hideSys || !DB_SYSTEM_SCHEMAS.includes(String(n).toLowerCase()))
  // per-db try/catch：单库失败（权限不足等）不再拖垮整棵树，
  // 降级为「库名在 + children 空 + error 标记」，前端提示后可点刷新重试
  return mapLimit(dbNames, METADATA_CONCURRENCY, async dbName => {
    try {
      // F0：SHOW TABLES 改成 information_schema.TABLES —— 只有它给 TABLE_TYPE，
      // 视图必须与表并列出现在树里（且带 type:'view'，UI 侧据此只读）
      const [tables] = await pool.query(
        'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES ' +
        'WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [String(dbName)]
      )
      return {
        name: dbName,
        type: 'database',
        children: (tables || []).map(t => ({
          name: t.TABLE_NAME,
          type: t.TABLE_TYPE === 'VIEW' ? 'view' : 'table'
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

// 排序标识符形状：只接受 [A-Za-z0-9_$]。
// 这是**设计一致性补丁，不是补漏洞** —— quoteIdent 已经兜住了注入面
// （QA 用 sqlite3 做对照实验：`id; DROP TABLE t` 被包成 `ORDER BY \`id; DROP TABLE t\``
// 时报 no such table 且表还在；同一串不带引号时 DROP 真的执行了）。
// 补这一层的原因：口径上"主进程以列白名单为安全边界"，而旧 orderBy 这条路径
// 一次白名单都不查。本轮不改 db-client/index.js（该文件被 UI/存储两条线占用），
// 所以在这里做能做的对齐：形状不像列名就不参与排序。
// 选"忽略排序"而不是"报错"：现在脏 orderBy 会让整条查询失败，
// 忽略它至少还能看到数据 —— 失败方向是"少一个排序"，不是"放行一段 SQL"。
const SORT_IDENT_RE = /^[A-Za-z0-9_$]+$/

// 分页参数归一。LIMIT/OFFSET 是**拼进 SQL 的字面数字**（不能塞进 params：
// 值和占位符混在一起会让"第几个 ? 对应哪个值"取决于拼接顺序），
// 所以拼之前必须保证它一定是有限整数。QA 实测过的非法产物：
// OFFSET -120 / OFFSET Infinity / OFFSET 1e+24 / LIMIT 2.5 —— 全是数据库语法错，
// 报错停在解析层，离"页码传错了"这个根因很远（UI 的 pageSize 读自可手改的 config，
// 1.5 这种脏值真实存在）。
// - `Number(x) || 默认` 保持旧语义：'1;DROP' → NaN → 默认值
// - Math.trunc 而不是 floor：-1.5 取 -1 再被 max(1, …) 拉回 1；floor 会先变 -2
// - 超过安全整数的偏移钳到 MAX_SAFE_INTEGER：页码 1e21 会算出 1e+23 这种带指数的
//   字面量（非法），钳成合法大整数后查询自然返回空 —— 语义仍是"你要的那页没数据"
const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER

function normalizePageValue (value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  // trunc(0.5) === 0、trunc(-0.5) === -0：与 `Number(x) || 默认` 的旧语义一致
  return Math.trunc(n) || fallback
}

function pageWindow (page, pageSize) {
  const size = Math.min(1000, Math.max(1, normalizePageValue(pageSize, 100)))
  const num = Math.max(1, normalizePageValue(page, 1))
  const offset = (num - 1) * size
  return {
    page: num,
    pageSize: size,
    offset: Number.isSafeInteger(offset) ? offset : MAX_SAFE_OFFSET
  }
}

// ORDER BY 片段：orderClauses（多列）优先，为空时退回旧的单列 orderBy/order。
// 列名必须在这里加引用符：orderClauses 来自渲染层且**不绑参数**，是裸着的 SQL 片段。
// 上限 3 列是**不依赖表结构**的硬上限：主进程的 assertSafeOrderClauses 在没有 where、
// 又取不到表结构时会放行（排序片段加引用符后没有注入面），那种路径下只有这里的
// parts.length 判定还拦得住"5000 条排序"变成几十 KB 的 ORDER BY。
// 3 与 client/common/db-grid-view.js 的 MAX_ORDER_COLUMNS、safe-clause.js 的
// MAX_ORDER_CLAUSES 保持一致。
const MAX_ORDER_COLUMNS = 3

function buildOrderSql (orderClauses, orderBy, order) {
  if (Array.isArray(orderClauses) && orderClauses.length) {
    const parts = []
    for (const item of orderClauses) {
      if (parts.length >= MAX_ORDER_COLUMNS) {
        break
      }
      if (!item || typeof item.column !== 'string' || !item.column.trim()) {
        continue
      }
      parts.push(quoteIdent(item.column.trim()) + (item.desc === true ? ' DESC' : ' ASC'))
    }
    if (parts.length) {
      return parts.join(', ')
    }
  }
  if (orderBy) {
    const name = String(orderBy).trim()
    if (!SORT_IDENT_RE.test(name)) {
      log.warn('getPageData: non-identifier orderBy ignored:', name)
      return ''
    }
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    return quoteIdent(name) + ' ' + dir
  }
  return ''
}

// E2：条件体（where，不含前导 WHERE）+ 多列排序 + 只取总数。
// 参数顺序必须与 where 里的占位符严格一致，因此 LIMIT/OFFSET 仍然拼字符串：
// 把数字塞进 params 会让"第几个 ? 对应哪个值"取决于拼接顺序，极易错位。
async function getPageData (
  conn,
  { database, table, page, pageSize, orderBy, order, where, whereParams, orderClauses, count }
) {
  const pool = await getPool(conn)
  const whereSql = typeof where === 'string' ? where.trim() : ''
  const params = Array.isArray(whereParams) ? whereParams : []
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  // count：条件变更后先问总数（结果集大小）再取页，避免"条件一改表格先闪成空"。
  // 只回 total，不回 rows —— 调用方拿到 total 后照常发分页查询。
  if (count === true) {
    const countSql = 'SELECT COUNT(*) AS c FROM ' + fullTable +
      (whereSql ? ' WHERE ' + whereSql : '')
    log.debug('getPageData count sql:', countSql)
    const [rows] = whereSql ? await pool.query(countSql, params) : await pool.query(countSql)
    const cell = rows && rows[0] ? rows[0].c : 0
    return { total: Number(cell) || 0 }
  }
  // LIMIT/OFFSET 必须先是合法整数再拼（见 pageWindow 注释）
  const win = pageWindow(page, pageSize)
  page = win.page
  pageSize = win.pageSize
  let sql = 'SELECT * FROM ' + fullTable
  if (whereSql) {
    sql += ' WHERE ' + whereSql
  }
  const orderSql = buildOrderSql(orderClauses, orderBy, order)
  if (orderSql) {
    sql += ' ORDER BY ' + orderSql
  }
  // 多取 1 行判定是否还有下一页：末页恰好整页时 hasMore 不再误报 true
  sql += ' LIMIT ' + (pageSize + 1) + ' OFFSET ' + win.offset
  log.debug('getPageData sql:', sql)
  const [rows] = whereSql ? await pool.query(sql, params) : await pool.query(sql)
  // 近似行数只随表变化，翻页时沿用首页结果，避免每页都查 information_schema
  const totalRows = page === 1 && database
    ? await getApproxRows(pool, database, table)
    : undefined
  return {
    rows: rowToPlain(rows.slice(0, pageSize)),
    hasMore: rows.length > pageSize,
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

// ---- F0 元数据契约 v2（列 + 注释 + 索引 + 外键 + 表注释 + 估算行数） ----
// 四条 information_schema 查询并行发。information_schema 在 MySQL 8 走数据字典缓存，
// 四类查询各自单表过滤，比一条大 JOIN 更稳（大 JOIN 在 5.7 上容易被优化成坏计划）。
const MY_STRUCT_COLUMNS = `
SELECT ORDINAL_POSITION, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH, CHARACTER_OCTET_LENGTH,
       COLUMN_COMMENT, COLUMN_KEY
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
 ORDER BY ORDINAL_POSITION`

// STATISTICS 是一列一行：复合索引必须靠 SEQ_IN_INDEX 排序后聚合（顺序错就是错的索引定义）
const MY_STRUCT_INDEXES = `
SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
 ORDER BY INDEX_NAME, SEQ_IN_INDEX`

const MY_STRUCT_FKS = `
SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
       k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       rc.UPDATE_RULE, rc.DELETE_RULE
  FROM information_schema.KEY_COLUMN_USAGE k
  JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
    ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?
   AND k.REFERENCED_TABLE_NAME IS NOT NULL
 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`

const MY_STRUCT_TABLE = `
SELECT TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, ENGINE
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`

async function getTableStructure (conn, { table, database }) {
  // 惰性 require（与驱动一致）：适配器顶层不留模块依赖，
  // 否则所有用 vm + require 白名单加载本文件的单测都得跟着加桩
  const structureV2 = require('./structure-v2')
  const pool = await getPool(conn)
  const dbName = database || conn.dbName
  if (!dbName) {
    throw new Error('getTableStructure requires database')
  }
  const tbl = String(table)
  const [cols, idx, fks, tbls] = await Promise.all([
    pool.query(MY_STRUCT_COLUMNS, [dbName, tbl]),
    pool.query(MY_STRUCT_INDEXES, [dbName, tbl]),
    pool.query(MY_STRUCT_FKS, [dbName, tbl]),
    pool.query(MY_STRUCT_TABLE, [dbName, tbl])
  ])
  // pool.query 返回 [rows, fields]；这里只要 rows
  const tableRow = (tbls[0] || [])[0]
  if (!tableRow) {
    throw new Error(`table not found: ${dbName}.${tbl}`)
  }
  return structureV2.fromMysql({
    columns: cols[0] || [],
    indexes: idx[0] || [],
    foreignKeys: fks[0] || [],
    table: tableRow
  })
}

// ---- F1 外键引用侧栏：反向查询"哪些表引用本表"（设计 §8） ----
// 复用例：前端用返回的引用清单调 getPageData 展示引用行，本 op 只负责把"指向本表的 FK"找出来。
// MySQL 走 information_schema.KEY_COLUMN_USAGE：REFERENCED_TABLE_* 指向本表即"被引用方"。
const MY_REFERENCES = `
SELECT k.CONSTRAINT_NAME AS fkName,
       k.TABLE_SCHEMA AS schema,
       k.TABLE_NAME AS table,
       k.COLUMN_NAME AS column,
       k.REFERENCED_TABLE_NAME AS refTable,
       k.REFERENCED_COLUMN_NAME AS refColumn
  FROM information_schema.KEY_COLUMN_USAGE k
 WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
   AND k.REFERENCED_COLUMN_NAME IS NOT NULL
 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`

// 纯函数（导出仅供单测）：原始行 → 合并后的引用清单。
// 同 (schema, table, fkName) 的多列行按 ORDINAL_POSITION 顺序聚合成一条，
// columns（子表 FK 列）与 refColumns（本表被引用列）一一对应且顺序一致。
function groupReferences (rows) {
  const map = new Map()
  for (const r of rows || []) {
    const key = String(r.schema) + ' ' + String(r.table) + ' ' + String(r.fkName)
    let entry = map.get(key)
    if (!entry) {
      entry = {
        schema: r.schema,
        table: r.table,
        fkName: r.fkName,
        refTable: r.refTable,
        columns: [],
        refColumns: []
      }
      map.set(key, entry)
    }
    entry.columns.push(r.column)
    entry.refColumns.push(r.refColumn)
  }
  return Array.from(map.values())
}

// 只读查询：失败时降级返回 degraded，不让"账号无 information_schema 权限"等异常
// 把主流程（看数据）拖垮（验收：只读账号页签降级隐藏 + 一行提示）。
async function getReferences (conn, { database, table, columns }) {
  const dbName = database || conn.dbName
  if (!dbName) {
    throw new Error('getReferences requires database')
  }
  const tbl = String(table)
  const pool = await getPool(conn)
  try {
    const [rows] = await pool.query(MY_REFERENCES, [dbName, tbl])
    let refs = groupReferences(rows || [])
    // 按选中的本表列过滤（不传 columns 时返回全部引用本表的 FK）
    if (Array.isArray(columns) && columns.length) {
      const want = new Set(columns.map(c => String(c)))
      refs = refs.filter(r => (r.refColumns || []).some(c => want.has(String(c))))
    }
    return { references: refs, degraded: false }
  } catch (e) {
    return { references: [], degraded: true, reason: e.message }
  }
}

// 精确总行数（按需触发；大表会全扫描，故不默认执行）
async function countRows (conn, { database, table }) {
  const pool = await getPool(conn)
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM ' + fullTable)
  const n = rows && rows[0] ? rows[0].c : 0
  return { count: Number(n) || 0 }
}

// 单元格编辑写入门控：只读模式下由主进程直接拒绝（渲染层传参不可信）
function checkWritable (readOnly) {
  if (readOnly) {
    throw new Error('read-only mode: cell update disabled')
  }
}

// 单元格 UPDATE：值走占位符绑定，标识符按反引号引用；
// 前端只传主键值定位，避免拼接 SQL 带来的注入面
async function updateCell (conn, { database, table, pkColumn, pkValue, column, value, readOnly }) {
  checkWritable(readOnly)
  if (!column || !pkColumn) {
    throw new Error('updateCell requires column and pkColumn')
  }
  if (pkValue === null || pkValue === undefined) {
    throw new Error('updateCell requires a primary key value')
  }
  const pool = await getPool(conn)
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const [res] = await pool.execute(
    'UPDATE ' + fullTable +
    ' SET ' + quoteIdent(column) + ' = ?' +
    ' WHERE ' + quoteIdent(pkColumn) + ' = ?',
    [value === undefined ? null : value, pkValue]
  )
  return { affected: res.affectedRows }
}

// 整行 INSERT：列清单由 values keys 生成（至少 1 列），值全部占位符绑定，
// 标识符按反引号引用（注入面约束与 updateCell 一致）
async function insertRow (conn, { database, table, values, readOnly }) {
  checkWritable(readOnly)
  const cols = Object.keys(values || {}).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRow requires at least one column value')
  }
  const pool = await getPool(conn)
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const sql = 'INSERT INTO ' + fullTable +
    ' (' + cols.map(quoteIdent).join(', ') + ')' +
    ' VALUES (' + cols.map(() => '?').join(', ') + ')'
  const [res] = await pool.execute(
    sql,
    cols.map(k => (values[k] === undefined ? null : values[k]))
  )
  return { affected: res.affectedRows, insertId: res.insertId }
}

// -------------------------------------------------- C 批：分批 multi-row INSERT（导入）
// 与单行 insertRow 的差异（设计 §10）：
// - rows 是同构行对象数组，内部按 行数上限(500) + 估算 SQL 体积上限(1MB) 自动切批
//   （切批逻辑在 ./insert-batch，与 pg 适配器共用，口径一致）
// - 每批独立事务：一批失败记录 { batchNo, firstRow, rowCount, message } 后继续下一批，
//   不让单批坏数据拖垮整个导入（失败明细由 db-importer 聚合进任务状态）
// - expressions：列名 → SQL 片段（导入映射的 expression 模式）。片段必须先经
//   safe-clause.assertSafeClause 过列白名单（db-importer 负责），适配器按调用方契约内联
// - 全部非表达式值占位符绑定；标识符反引号引用
// - overwrite：先 DELETE FROM（不用 TRUNCATE：可回滚、不隐式提交、权限要求更窄）；
//   rebuild 本期占位报错（D 批实现）
// 注：mysql 适配器没有 schema 概念，入参里的 schema 仅保持与 pg 签名一致，忽略。

// 用文本协议 query 而不是 execute：每批占位符数量不同，execute 会为每种形状
// 各准备一次预处理语句，大批导入下纯属浪费
function buildInsertBatch ({
  fullTable,
  cols,
  rowCount,
  mode = 'append',
  pkColumns,
  updateColumns,
  expressions
}) {
  const exprMap = expressions && typeof expressions === 'object' ? expressions : {}
  const hasExpr = c => Object.prototype.hasOwnProperty.call(exprMap, c)
  const cells = cols.map(c => (hasExpr(c) ? String(exprMap[c]) : '?'))
  const valuesSql = Array.from({ length: rowCount }, () => '(' + cells.join(', ') + ')').join(', ')
  let sql = 'INSERT INTO ' + fullTable +
    ' (' + cols.map(quoteIdent).join(', ') + ')' +
    ' VALUES ' + valuesSql
  if (mode === 'upsert') {
    const pks = (Array.isArray(pkColumns) ? pkColumns : []).map(String)
    if (!pks.length) {
      throw new Error('upsert requires primary key columns')
    }
    const upd = (Array.isArray(updateColumns) && updateColumns.length
      ? updateColumns.map(String)
      : cols.filter(c => !pks.includes(c)))
    if (!upd.length) {
      throw new Error('upsert requires updatable columns besides the primary key')
    }
    // VALUES(col) 在 8.0.20 起标记废弃但仍受支持：为了兼容 5.7 保留写法
    sql += ' ON DUPLICATE KEY UPDATE ' +
      upd.map(c => quoteIdent(c) + ' = VALUES(' + quoteIdent(c) + ')').join(', ')
  }
  return sql
}

function insertBatchParams (rows, cols, expressions) {
  const exprMap = expressions && typeof expressions === 'object' ? expressions : {}
  const bindCols = cols.filter(c => !Object.prototype.hasOwnProperty.call(exprMap, c))
  const params = []
  for (const row of rows) {
    for (const c of bindCols) {
      params.push(row[c] === undefined ? null : row[c])
    }
  }
  return params
}

const INSERT_MODES = ['append', 'overwrite', 'upsert']

async function insertRows (
  conn,
  { database, schema, table, rows, readOnly, mode = 'append', pkColumns, updateColumns, expressions }
) {
  checkWritable(readOnly)
  if (!INSERT_MODES.includes(mode)) {
    throw new Error(`unsupported insertRows mode: ${mode}`)
  }
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : []
  if (!list.length) {
    return { affected: 0, batchCount: 0, failures: [] }
  }
  // 列清单取首行键：调用方（db-importer）保证同构，后继行多出的键忽略、缺失按 null
  const cols = Object.keys(list[0]).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRows requires at least one column')
  }
  const { planInsertBatches } = require('./insert-batch')
  const pool = await getPool(conn)
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const batches = planInsertBatches(list)
  let affected = 0
  const failures = []
  const runBatch = async (c, sql, params) => {
    await c.query('START TRANSACTION')
    const [res] = await c.query(sql, params)
    await c.query('COMMIT')
    return res.affectedRows || 0
  }
  const c = await pool.getConnection()
  try {
    if (mode === 'overwrite') {
      // 清空与写入分事务：DELETE 本身可整批失败（权限/外键），失败则整个导入中止；
      // 已提交批次保留是导入的既定语义（止步不回滚），不在一条大事务里硬凑原子性
      try {
        await runBatch(c, 'DELETE FROM ' + fullTable, [])
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw new Error('overwrite 清空目标表失败: ' + e.message)
      }
    }
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      const sql = buildInsertBatch({
        fullTable, cols, rowCount: batch.rows.length, mode, pkColumns, updateColumns, expressions
      })
      try {
        affected += await runBatch(c, sql, insertBatchParams(batch.rows, cols, expressions))
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        failures.push({
          batchNo: b + 1,
          firstRow: batch.firstRow,
          rowCount: batch.rows.length,
          message: e.message
        })
      }
    }
  } finally {
    c.release()
  }
  return { affected, batchCount: batches.length, failures }
}

// 整行 DELETE 批量上限：防误操作大范围删除 + IN 子句过长
const DELETE_ROWS_LIMIT = 200

// 整行 DELETE：仅主键 IN 定位；无主键表无法安全定位行，直接拒绝并引导走 SQL 页
async function deleteRows (conn, { database, table, pkColumn, pkValues, readOnly }) {
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
  const pool = await getPool(conn)
  const fullTable = database
    ? quoteIdent(database) + '.' + quoteIdent(table)
    : quoteIdent(table)
  const sql = 'DELETE FROM ' + fullTable +
    ' WHERE ' + quoteIdent(pkColumn) +
    ' IN (' + list.map(() => '?').join(', ') + ')'
  const [res] = await pool.execute(sql, list)
  return { affected: res.affectedRows }
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

// ---------------------------------------------------------------- 补全列元数据
// 阶段4 A-5 的列补全数据源（设计 §4.3）。
// 一次查整库所有表的列，而不是「每张表一次查询」：大库上百张表时后者是上百次 RTT，
// 而补全必须能在打字间隙内返回。整库查询结果按表分组后前端直接查表名即可。
const LIST_COLUMNS_SQL =
  'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k ' +
  'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ' +
  'ORDER BY TABLE_NAME, ORDINAL_POSITION'

// 纯函数（导出仅供单测）：查询行 → [{ table, columns: [{ name, type, pk }] }]
// 依赖 SQL 已按「表名, 列序号」排序，顺序分组；不在此处重新排序，
// 否则列会变成字典序，与表结构里的实际顺序不一致
function groupColumns (rows) {
  const out = []
  let cur = null
  for (const r of rows || []) {
    if (!cur || cur.table !== r.t) {
      cur = { table: r.t, columns: [] }
      out.push(cur)
    }
    cur.columns.push({
      name: r.c,
      // COLUMN_TYPE 带长度（varchar(64)/int unsigned），比 DATA_TYPE 更能说明取值
      type: r.ty || '',
      pk: r.k === 'PRI'
    })
  }
  return out
}

async function listColumns (conn, { database } = {}) {
  const db = database || conn.dbName
  if (!db) {
    // 连接未指定库（URI 快速连库外的场景）时无法圈定 information_schema 范围。
    // 返回空而不是抛错：补全侧按「没有列数据」降级，不影响打字
    return { tables: [] }
  }
  const pool = await getPool(conn)
  const [rows] = await pool.query(LIST_COLUMNS_SQL, [db])
  return { tables: groupColumns(rows) }
}

async function executeSql (conn, { sql, database, readOnly }) {
  // 先做只读校验（不触网），被拒时无需建立连接
  checkReadonly(sql, readOnly)
  const pool = await getPool(conn)
  // 必须同一连接先 USE 再执行：pool.query 两次可能拿到不同连接，USE 会失效；
  // 连接未指定默认库（如 URI 快速连接不带库名）时"库名.表名"裸表名会报 No database selected，
  // 前端把树当前选中库传入，这里补 USE（tidb/oceanbase 共用本适配器一并修复）
  const c = await pool.getConnection()
  try {
    if (database) {
      await c.query('USE ' + quoteIdent(database))
    }
    const [rows, fields] = await c.query(sql)
    return {
      results: normalizeResults(rows, fields)
    }
  } finally {
    c.release()
  }
}

// -------------------------------------------------- D 批：EXPLAIN FORMAT=JSON ----
// explainQuery({database, sql}) → { dialect, root, raw }：
// root 是统一节点树 { nodeType, table, rows, filtered, key, extra, cost, children }，
// raw 是服务端原始 JSON（前端折叠查看用）。redis 不注册本 op。

// 「实际行数」只在计划**真正执行过**时存在：mysql EXPLAIN ANALYZE 输出 r_rows，
// pg ANALYZE 输出 Actual Rows。本实现的 explainQuery 永远拒绝 ANALYZE，
// 正常返回里 actualRows 恒为 null —— 导出本函数仅供单测，防止未来放开 ANALYZE 时
// 把预估值（rows_examined_per_scan / Plan Rows）误当实际值。
function extractActualRows (plan) {
  if (!plan || typeof plan !== 'object') {
    return null
  }
  for (const k of ['r_rows', 'Actual Rows', 'actualRows']) {
    const v = plan[k]
    if (v !== undefined && v !== null) {
      const n = Number(v)
      if (Number.isFinite(n)) {
        return n
      }
    }
  }
  return null
}

// 词法掩码：把字符串（含 '' 双写与反斜杠转义）、反引号/双引号标识符、
// 行注释（-- 与 #）与块注释统一替换成空格（保留换行），长度与原文一致。
// 与 db-sql-complete.maskSqlLiterals 同思路的极简版，仅供本文件的
// containsAnalyze / 多语句检查使用（两个适配器各自内联，避免互相依赖）。
// 假设：默认 sql_mode（NO_BACKSHOASH_ESCAPES 未启用，反斜杠转义字符串成立）；
// 该模式开启时掩码的引号边界可能偏移——方向是"多掩"（吞掉更多文本），
// 分析类入口只会更保守，不会放大执行面。
function maskSqlText (text) {
  const s = String(text || '')
  const out = s.split('')
  const n = s.length
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') {
        out[k] = ' '
      }
    }
  }
  let i = 0
  while (i < n) {
    const c = s[i]
    // 行注释 --：MySQL 词法要求 -- 后跟空白/控制字符才算注释（`--1` 是双负号）。
    // 不满足时按普通文本跳过 —— 否则 `select 1 --x; DELETE FROM t` 的
    // `--x; DELETE...` 被吞到行尾，多语句闸门看不见分号（QA BUG-1）
    if (c === '-' && s[i + 1] === '-') {
      const next = s[i + 2]
      if (next === undefined || next === '\0' || /\s/.test(next)) {
        let j = s.indexOf('\n', i)
        if (j < 0) {
          j = n
        }
        blank(i, j)
        i = j
      } else {
        i += 1
      }
      continue
    }
    // 行注释 #（pg 只认 --，mysql 版多吞 # 无害：裸 # 在 pg SQL 里本就非法）
    if (c === '#') {
      let j = s.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      blank(i, j)
      i = j
      continue
    }
    // 块注释 /* */（不嵌套，与 mysql 行为一致）
    if (c === '/' && s[i + 1] === '*') {
      const found = s.indexOf('*/', i + 2)
      const j = found < 0 ? n : found + 2
      blank(i, j)
      i = j
      continue
    }
    // 字符串 '...' / 标识符 `...` "..."：反斜杠转义 + 单/双引号双写转义
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (s[j] === '\\') {
          j += 2
          continue
        }
        if (s[j] === c) {
          if (c !== '`' && s[j + 1] === c) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      const end = Math.min(j, n)
      blank(i, end)
      i = end
      continue
    }
    i += 1
  }
  return out.join('')
}

// EXPLAIN ANALYZE / EXPLAIN (ANALYZE 会**真实执行**语句，必须拒绝。
// 直接对原文做 /\banalyze\b/i 会把字符串/注释里的 "analyze" 误杀，故先掩码再匹配。
function containsAnalyze (sql) {
  return /\banalyze\b/i.test(maskSqlText(sql))
}

function finiteOrNull (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// mysql JSON 计划树里的操作包装键 → 统一节点类型名
const MYSQL_OP_LABELS = {
  ordering_operation: 'Sort',
  grouping_operation: 'Group',
  windowing_operation: 'Window',
  nested_loop: 'Nested Loop'
}

// table 节点 → 树视图展示字段（节点类型/表/预估 rows/filtered/key/Extra）
function extractMysqlTable (t) {
  const rows = t.rows_examined_per_scan !== undefined
    ? finiteOrNull(t.rows_examined_per_scan)
    : finiteOrNull(t.rows)
  return {
    table: t.table_name || t.table_label || null,
    accessType: t.access_type || null,
    rows,
    filtered: finiteOrNull(t.filtered),
    key: t.key || null,
    // 新版本把过滤条件放 attached_condition，老版本在 extra
    extra: t.extra || t.attached_condition || null
  }
}

// 递归抽取：mysql 的计划树藏在 query_block 下的
// ordering_operation/grouping_operation/nested_loop/table 等键里
function convertMysqlNode (node, opLabel) {
  const info = { table: null, accessType: null, rows: null, filtered: null, key: null, extra: null }
  let cost = null
  const children = []
  for (const key of Object.keys(node || {})) {
    const val = node[key]
    if (!val || typeof val !== 'object') {
      continue
    }
    if (key === 'table') {
      Object.assign(info, extractMysqlTable(val))
    } else if (key === 'cost_info') {
      cost = finiteOrNull(val.query_cost)
    } else if (key === 'nested_loop' && Array.isArray(val)) {
      for (const item of val) {
        children.push(convertMysqlNode(item, null))
      }
    } else if (/_operation$/.test(key)) {
      children.push(convertMysqlNode(val, MYSQL_OP_LABELS[key] || key))
    }
  }
  // 节点类型：操作包装用操作名；纯 table 节点用 access_type（ALL/ref/eq_ref/const…）
  const nodeType = opLabel || info.accessType || (info.table ? 'TABLE' : 'NODE')
  return {
    nodeType,
    table: info.table,
    rows: info.rows,
    filtered: info.filtered,
    key: info.key,
    extra: info.extra,
    cost,
    children
  }
}

// 纯函数（导出仅供单测）：EXPLAIN FORMAT=JSON 输出 → 统一节点树。
// 入参为已 parse 的对象（mysql2 拿到的是字符串，explainQuery 负责先 parse）
function parseMysqlPlan (json) {
  let doc = json
  if (typeof json === 'string') {
    try {
      doc = JSON.parse(json)
    } catch (e) {
      throw new Error('无法解析 EXPLAIN 输出：不是合法 JSON')
    }
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('无法解析 EXPLAIN 输出：不是 JSON 对象')
  }
  const root = doc.query_block
  if (!root || typeof root !== 'object') {
    throw new Error('无法解析 EXPLAIN 输出：缺少 query_block')
  }
  return convertMysqlNode(root, 'SELECT')
}

async function explainQuery (conn, { database, sql }) {
  const s = String(sql || '').trim()
  if (!s) {
    throw new Error('explainQuery requires sql')
  }
  // 安全边界：EXPLAIN ANALYZE 会真实执行语句，词法级检查后一律拒绝
  if (containsAnalyze(s)) {
    throw new Error('EXPLAIN 拒绝 ANALYZE：EXPLAIN ANALYZE / EXPLAIN (ANALYZE 会真实执行语句')
  }
  // 版本注释 /*! ... */ 会被服务端**当作 SQL 执行**（ /*!80000 SELECT 1 */ 是可执行体），
  // 且会被块注释掩码吞掉、掩不住里面的分号 —— 多语句防护语境下没有合法用途，
  // 含 /*! 即拒绝（宁可误杀字符串里的字面量，QA 低风险项拍板）
  if (s.includes('/*!')) {
    throw new Error('EXPLAIN 不接受版本注释（/*! ... */ 会真实执行）')
  }
  // EXPLAIN 本身"只解释不执行"，但 multipleStatements 开着，
  // `EXPLAIN FORMAT=JSON select 1; DELETE FROM t` 的第二条会真实执行 ——
  // 掩码字符串/注释后仍有分号即拒绝多语句；尾部孤立分号剥掉后再发送
  // （multipleStatements 下 `EXPLAIN ...;` 会被切成空语句，行为不定）
  const clean = s.replace(/[;\s]+$/, '')
  if (maskSqlText(clean).includes(';')) {
    throw new Error('EXPLAIN 一次只接受一条语句（检测到多余分号）')
  }
  const pool = await getPool(conn)
  const c = await pool.getConnection()
  try {
    // 与 executeSql 同一模式：同一连接先 USE 再执行，否则裸表名报 No database selected
    if (database) {
      await c.query('USE ' + quoteIdent(database))
    }
    const [rows] = await c.query('EXPLAIN FORMAT=JSON ' + clean)
    const first = rows && rows[0]
    if (!first) {
      throw new Error('无法解析 EXPLAIN 输出：结果为空')
    }
    const raw = first.EXPLAIN !== undefined
      ? first.EXPLAIN
      : first[Object.keys(first)[0]]
    let doc
    try {
      doc = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      throw new Error('无法解析 EXPLAIN 输出：不是合法 JSON')
    }
    return { dialect: 'mysql', root: parseMysqlPlan(doc), raw: doc }
  } finally {
    c.release()
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
  getTableStructure,
  updateCell,
  insertRow,
  insertRows,
  deleteRows,
  countRows,
  executeSql,
  explainQuery,
  listColumns,
  closeMysqlConnection,
  // 纯函数导出仅供单测（安全白名单 / 结果规范化 / 列分组 / 二进制信封阈值 / 引用分组 /
  // 批量 INSERT 语句构建 / EXPLAIN 计划解析 / ANALYZE 词法检查）
  checkReadonly,
  checkWritable,
  toResult,
  normalizeResults,
  groupColumns,
  groupReferences,
  getReferences,
  INLINE_LIMIT,
  buildInsertBatch,
  insertBatchParams,
  parseMysqlPlan,
  containsAnalyze,
  extractActualRows
}
