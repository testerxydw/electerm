/**
 * sqlite adapter (H8a) — node:sqlite DatabaseSync, lazy loaded.
 *
 * 为什么是同步 API：node:sqlite 只暴露 DatabaseSync（Node 22/24 均如此），
 * 所有调用都会阻塞主进程。约束放在**取数上限**上（分页 1000、executeSql 10000 行），
 * 避免一次大结果把整个应用卡住；后续若要彻底解决，需要把适配器挪进 worker。
 *
 * 连接模型：一个文件一条共享连接（同步调用天然串行，不需要连接池），
 * 按绝对路径做引用计数，最后一个 tab 关闭时 close。手动事务（F2）钉住的
 * 是一条**独立连接**（同一文件），commit/rollback 后关闭，不影响共享连接。
 *
 * 与 mysql/postgres 适配器的口径差异：
 * - 没有 database/schema 概念（main 即全部），入参 database/schema 一律忽略
 * - 表结构来自 PRAGMA（table_info/index_list/index_info/foreign_key_list）
 * - describeTable 归一到 MySQL 的 Field/Type/Null/Key/Default/Extra，
 *   渲染层的插入表单与结构网格因此不必再分一套引擎分支
 */

const fs = require('node:fs')
const path = require('node:path')
const log = require('../../common/log')
const { normalizeSqliteType, toColumns } = require('../../common/db-type-normalize')

const dbs = new Map()
const refs = new Map()

// executeSql 单结果集行数上限（设计 §15.1：同步 API 阻塞主进程，先用行数兜底）
const MAX_SQL_ROWS = 10000
// 与 mysql/postgres 同口径：一次最多改/删一屏勾选的行
const DELETE_ROWS_LIMIT = 200
const UPDATE_CELLS_LIMIT = 200
const MAX_ORDER_COLUMNS = 3
const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER

function fileOf (conn) {
  const f = String((conn && conn.dbFile) || '').trim()
  if (!f) {
    throw new Error('sqlite database file required')
  }
  return f === ':memory:' ? f : path.resolve(f)
}

function sig (conn) {
  return fileOf(conn)
}

function openDb (conn) {
  const file = fileOf(conn)
  if (file !== ':memory:' && !fs.existsSync(file)) {
    throw new Error(`SQLite 数据库文件不存在: ${file}`)
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  // 多 tab/外部进程同时写同一文件时，用 busy timeout 等待而不是立刻 SQLITE_BUSY
  try {
    db.exec('PRAGMA busy_timeout = 5000')
  } catch (e) {
    log.warn('[sqlite] busy_timeout failed', e.message)
  }
  return db
}

function getDb (conn) {
  // F2：事务钉住期间 db-client 注入 __txClient（beginTx 打开的专用连接）
  if (conn && conn.__txClient) {
    return conn.__txClient
  }
  const key = sig(conn)
  if (dbs.has(key)) {
    return dbs.get(key)
  }
  const db = openDb(conn)
  dbs.set(key, db)
  return db
}

async function acquire (conn) {
  const key = sig(conn)
  refs.set(key, (refs.get(key) || 0) + 1)
  try {
    getDb(conn)
  } catch (e) {
    await release(conn)
    throw e
  }
}

async function release (conn) {
  const key = sig(conn)
  const n = (refs.get(key) || 0) - 1
  if (n > 0) {
    refs.set(key, n)
    return
  }
  refs.delete(key)
  const db = dbs.get(key)
  if (db) {
    dbs.delete(key)
    try {
      db.close()
    } catch (e) {
      // ignore close errors
    }
  }
}

// 断连自愈：同步 sqlite 没有 socket，evict 只用于"文件被换掉/句柄坏掉"后重建
async function evict (conn) {
  const key = sig(conn)
  const db = dbs.get(key)
  if (db) {
    dbs.delete(key)
    try {
      db.close()
    } catch (e) {
      // ignore
    }
  }
}

// F2 事务安全带：同一文件的独立连接，事务内所有 op 走它
async function beginTx (conn) {
  if (fileOf(conn) === ':memory:') {
    throw new Error('manual transaction is not available for :memory: databases')
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(fileOf(conn))
  try {
    db.exec('BEGIN')
    return db
  } catch (e) {
    try {
      db.close()
    } catch (e2) {
      // ignore
    }
    throw e
  }
}

async function commitTx (db) {
  try {
    db.exec('COMMIT')
  } finally {
    try {
      db.close()
    } catch (e) {
      // ignore
    }
  }
}

async function rollbackTx (db) {
  try {
    db.exec('ROLLBACK')
  } catch (e) {
    // 连接已坏时 ROLLBACK 失败：关闭连接即可（未提交事务随句柄关闭回滚）
  } finally {
    try {
      db.close()
    } catch (e) {
      // ignore
    }
  }
}

async function testSqliteConnection (conn) {
  const file = fileOf(conn)
  if (file !== ':memory:' && !fs.existsSync(file)) {
    throw new Error(`SQLite 数据库文件不存在: ${file}`)
  }
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare('SELECT 1 AS ok').get()
    if (!row || Number(row.ok) !== 1) {
      throw new Error('sqlite connection test failed')
    }
    return 'sqlite ok'
  } finally {
    try {
      db.close()
    } catch (e) {
      // ignore
    }
  }
}

function quoteIdent (name) {
  return '"' + String(name || '').replace(/"/g, '""') + '"'
}

function bindValue (v) {
  if (v === undefined) {
    return null
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0
  }
  if (v instanceof Date) {
    return v.toISOString()
  }
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    // node:sqlite 只认原始值/BLOB；对象/数组按 JSON 文本存（与导入的 CSV 字段口径一致）
    try {
      return JSON.stringify(v)
    } catch (e) {
      return String(v)
    }
  }
  return v
}

function bindParams (params) {
  return (Array.isArray(params) ? params : []).map(bindValue)
}

// ---------------------------------------------------------------- 行/值归一
// 与 mysql/postgres 适配器同一套规则：Date/bigint 先行、Buffer 走 __bin 信封、
// 其余带原型的对象转字符串 —— 保证 IPC 结构化克隆不会因为某个驱动自定义对象整页失败。
const INLINE_LIMIT = 64 * 1024
const BIN_PREFIX_LIMIT = 4096

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
  if (v instanceof Uint8Array) {
    return binEnvelope(v)
  }
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
  return (rows || []).map(r => {
    const o = {}
    for (const k of Object.keys(r || {})) {
      o[k] = safeCell(r[k])
    }
    return o
  })
}

// ---------------------------------------------------------------- 分页/排序

function normalizePageValue (value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
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

const SORT_IDENT_RE = /^[A-Za-z0-9_$]+$/

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
    return quoteIdent(name) + (order === 'descend' ? ' DESC' : ' ASC')
  }
  return ''
}

function fullTable (table) {
  return quoteIdent(table)
}

// ---------------------------------------------------------------- 元数据

const SYSTEM_TABLE_RE = /^sqlite_/i

function listObjects (db) {
  return db.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name"
  ).all().filter(r => !SYSTEM_TABLE_RE.test(String(r.name || '')))
}

async function getMetadata (conn) {
  const db = getDb(conn)
  const children = listObjects(db).map(r => ({
    name: r.name,
    type: r.type === 'view' ? 'view' : 'table'
  }))
  return [{
    name: 'main',
    type: 'database',
    children
  }]
}

// 表/视图的原始定义。objectType 白名单，名称只做参数绑定
const DDL_TYPES = {
  table: 'table',
  view: 'view',
  index: 'index',
  trigger: 'trigger'
}

async function getObjectDdl (conn, args) {
  const a = args || {}
  const objectType = String(a.objectType || 'table').toLowerCase()
  const kind = DDL_TYPES[objectType]
  if (!kind) {
    throw new Error(`unsupported object type: ${a.objectType}`)
  }
  const name = String(a.name || '')
  if (!name) {
    throw new Error('object name required')
  }
  const db = getDb(conn)
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ? AND type = ?').get(name, kind)
  if (!row || !row.sql) {
    throw new Error(`object not found: ${name}`)
  }
  return {
    name,
    objectType,
    ddl: String(row.sql)
  }
}

// ---------------------------------------------------------------- 结构

function tableTypeOf (db, table) {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')").get(table)
  return row ? row.type : null
}

function tableInfoRows (db, table) {
  return db.prepare('PRAGMA table_info(' + quoteIdent(table) + ')').all()
}

function pkColumnsOf (db, table) {
  return tableInfoRows(db, table)
    .filter(c => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(c => c.name)
}

// 外键：PRAGMA foreign_key_list 每列一行，按 id 聚合成一条约束。
// SQLite 不给约束名（PRAGMA 没有这一列），用 fk_<id> 稳定标识；
// `to` 为空表示引用目标表的主键，按目标表解析成真实列名。
function foreignKeyGroupsOf (db, table) {
  const rows = db.prepare('PRAGMA foreign_key_list(' + quoteIdent(table) + ')').all()
  const byId = new Map()
  for (const r of rows) {
    const id = String(r.id)
    let g = byId.get(id)
    if (!g) {
      g = {
        id,
        table: r.table,
        onDelete: r.on_delete,
        onUpdate: r.on_update,
        pairs: []
      }
      byId.set(id, g)
    }
    g.pairs.push({ seq: Number(r.seq) || 0, from: r.from, to: r.to })
  }
  for (const g of byId.values()) {
    g.pairs.sort((a, b) => a.seq - b.seq)
    const missing = g.pairs.some(p => p.to === null || p.to === undefined)
    const refPk = missing ? pkColumnsOf(db, g.table) : []
    g.columns = g.pairs.map(p => p.from).filter(Boolean)
    g.refColumns = g.pairs
      .map((p, i) => (p.to === null || p.to === undefined ? refPk[i] : p.to))
      .filter(Boolean)
  }
  return Array.from(byId.values())
}

function indexesOf (db, table) {
  const rows = db.prepare('PRAGMA index_list(' + quoteIdent(table) + ')').all()
  const out = []
  for (const ix of rows) {
    const cols = db.prepare('PRAGMA index_info(' + quoteIdent(ix.name) + ')').all()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map(c => c.name)
      .filter(Boolean)
    out.push({
      name: ix.name,
      unique: Number(ix.unique) === 1,
      primary: ix.origin === 'pk',
      columns: cols,
      method: 'btree'
    })
  }
  // INTEGER PRIMARY KEY 是 rowid 别名，不会出现在 index_list 里；
  // 补一条合成 PRIMARY，结构面板与 mysql 的 PRIMARY 行对齐
  if (!out.some(ix => ix.primary)) {
    const pk = pkColumnsOf(db, table)
    if (pk.length) {
      out.unshift({
        name: 'PRIMARY',
        unique: true,
        primary: true,
        columns: pk,
        method: 'btree'
      })
    }
  }
  return out
}

function typeLength (declared) {
  const m = /\(\s*(\d+)/.exec(String(declared || ''))
  const n = m ? Number(m[1]) : 0
  return Number.isFinite(n) && n > 0 ? n : null
}

// INTEGER PRIMARY KEY 是 rowid 别名：没有显式 NOT NULL 也永远不可能为 NULL
// （写入 NULL 会被自动分配一个 rowid）。PRAGMA table_info 的 notnull 只反映声明，
// 所以这里单独补一条，否则结构面板与插入表单会把它当成可空列。
function isRowidAlias (info) {
  return Number(info && info.pk) > 0 && /^integer$/i.test(String((info && info.type) || '').trim())
}

function columnNullable (info) {
  return !(Number(info && info.notnull) === 1 || isRowidAlias(info))
}

async function getTableStructure (conn, { table }) {
  const structureV2 = require('./structure-v2')
  const db = getDb(conn)
  const tbl = String(table || '')
  if (!tbl) {
    throw new Error('getTableStructure requires table')
  }
  const type = tableTypeOf(db, tbl)
  if (!type) {
    throw new Error(`table not found: ${tbl}`)
  }
  const cols = tableInfoRows(db, tbl)
  const fks = foreignKeyGroupsOf(db, tbl)
  return structureV2.finalizeStructure({
    type: type === 'view' ? 'view' : 'table',
    columns: cols.map(c => ({
      name: c.name,
      // 声明类型可能为空（SQLite 允许无类型列）；空类型按 BLOB 亲和性处理
      dataType: String(c.type || '').split(/[\s(]/)[0].toLowerCase() || 'blob',
      columnType: c.type || null,
      nullable: columnNullable(c),
      defaultValue: c.dflt_value,
      isPrimaryKey: Number(c.pk) > 0,
      ordinal: Number(c.cid) + 1,
      comment: null,
      maxLength: typeLength(c.type),
      udtName: c.type
    })),
    indexes: indexesOf(db, tbl),
    foreignKeys: fks.map(fk => ({
      name: 'fk_' + fk.id,
      columns: fk.columns,
      refSchema: 'main',
      refTable: fk.table,
      refColumns: fk.refColumns,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate
    })),
    comment: null,
    estimatedRows: null
  })
}

// describeTable 归一到 MySQL 的 DESC 形状：渲染层插入表单/结构网格只认一套字段名。
// Extra=auto_increment 的判定：INTEGER PRIMARY KEY（rowid 别名）在列值为 NULL 时自动分配。
async function describeTable (conn, { table }) {
  const db = getDb(conn)
  const rows = tableInfoRows(db, String(table || ''))
  return rows.map(c => {
    const declared = String(c.type || '')
    return {
      Field: c.name,
      Type: declared,
      Null: columnNullable(c) ? 'YES' : 'NO',
      Key: Number(c.pk) > 0 ? 'PRI' : '',
      Default: c.dflt_value,
      Extra: isRowidAlias(c) ? 'auto_increment' : ''
    }
  })
}

// ---------------------------------------------------------------- 取数

async function getPageData (
  conn,
  { table, page, pageSize, orderBy, order, where, whereParams, orderClauses, count }
) {
  const db = getDb(conn)
  const tbl = fullTable(table)
  const whereSql = typeof where === 'string' ? where.trim() : ''
  const params = bindParams(whereParams)
  if (count === true) {
    const countSql = 'SELECT COUNT(*) AS c FROM ' + tbl + (whereSql ? ' WHERE ' + whereSql : '')
    log.debug('getPageData count sql:', countSql)
    const row = db.prepare(countSql).get(...params)
    return { total: Number(row && row.c) || 0 }
  }
  const win = pageWindow(page, pageSize)
  let sql = 'SELECT * FROM ' + tbl
  if (whereSql) {
    sql += ' WHERE ' + whereSql
  }
  const orderSql = buildOrderSql(orderClauses, orderBy, order)
  if (orderSql) {
    sql += ' ORDER BY ' + orderSql
  }
  sql += ' LIMIT ' + (win.pageSize + 1) + ' OFFSET ' + win.offset
  log.debug('getPageData sql:', sql)
  const rows = db.prepare(sql).all(...params)
  return {
    rows: rowToPlain(rows.slice(0, win.pageSize)),
    hasMore: rows.length > win.pageSize
  }
}

async function countRows (conn, { table }) {
  const db = getDb(conn)
  const row = db.prepare('SELECT COUNT(*) AS c FROM ' + fullTable(table)).get()
  return { count: Number(row && row.c) || 0 }
}

// ---------------------------------------------------------------- 外键

async function getReferences (conn, { table, columns }) {
  const db = getDb(conn)
  const target = String(table || '')
  if (!target) {
    throw new Error('getReferences requires table')
  }
  try {
    const refsOut = []
    for (const obj of listObjects(db)) {
      for (const fk of foreignKeyGroupsOf(db, obj.name)) {
        if (String(fk.table || '').toLowerCase() !== target.toLowerCase()) {
          continue
        }
        refsOut.push({
          schema: 'main',
          table: obj.name,
          fkName: 'fk_' + fk.id,
          refTable: target,
          columns: fk.columns,
          refColumns: fk.refColumns
        })
      }
    }
    let list = refsOut
    if (Array.isArray(columns) && columns.length) {
      const want = new Set(columns.map(c => String(c)))
      list = list.filter(r => (r.refColumns || []).some(c => want.has(String(c))))
    }
    return { references: list, degraded: false }
  } catch (e) {
    return { references: [], degraded: true, reason: e.message }
  }
}

async function listForeignKeys (conn) {
  const db = getDb(conn)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .filter(r => !SYSTEM_TABLE_RE.test(String(r.name || '')))
  const tableRows = tables.map(r => ({ name: r.name }))
  const fkRows = []
  for (const t of tableRows) {
    for (const fk of foreignKeyGroupsOf(db, t.name)) {
      fk.columns.forEach((col, i) => {
        fkRows.push({
          table_name: t.name,
          fk_name: 'fk_' + fk.id,
          column_name: col,
          ref_schema: 'main',
          ref_table: fk.table,
          ref_column: fk.refColumns[i] || null
        })
      })
    }
  }
  // 取不到就抛错，由前端降级提示（与 mysql/postgres 的 listForeignKeys 一致）
  return require('./er-graph').fromMysql({
    tables: tableRows,
    fkRows,
    database: 'main'
  })
}

// ---------------------------------------------------------------- 写操作

function checkWritable (readOnly) {
  if (readOnly) {
    throw new Error('read-only mode: cell update disabled')
  }
}

async function updateCell (conn, { table, pkColumn, pkValue, column, value, readOnly }) {
  checkWritable(readOnly)
  if (!column || !pkColumn) {
    throw new Error('updateCell requires column and pkColumn')
  }
  if (pkValue === null || pkValue === undefined) {
    throw new Error('updateCell requires a primary key value')
  }
  const db = getDb(conn)
  const stmt = db.prepare(
    'UPDATE ' + fullTable(table) +
    ' SET ' + quoteIdent(column) + ' = ?' +
    ' WHERE ' + quoteIdent(pkColumn) + ' = ?'
  )
  const res = stmt.run(bindValue(value), bindValue(pkValue))
  return { affected: toNumber(res.changes) }
}

async function insertRow (conn, { table, values, readOnly }) {
  checkWritable(readOnly)
  const cols = Object.keys(values || {}).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRow requires at least one column value')
  }
  const db = getDb(conn)
  const sql = 'INSERT INTO ' + fullTable(table) +
    ' (' + cols.map(quoteIdent).join(', ') + ')' +
    ' VALUES (' + cols.map(() => '?').join(', ') + ')'
  const res = db.prepare(sql).run(...cols.map(k => bindValue(values[k])))
  return {
    affected: toNumber(res.changes),
    insertId: toNumber(res.lastInsertRowid)
  }
}

const INSERT_MODES = ['append', 'overwrite', 'upsert']

// 单条 multi-row INSERT：append 直接插入；upsert 走 ON CONFLICT(pk) DO UPDATE
function buildInsertBatch ({
  table,
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
  let sql = 'INSERT INTO ' + fullTable(table) +
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
    sql += ' ON CONFLICT (' + pks.map(quoteIdent).join(', ') + ') DO UPDATE SET ' +
      upd.map(c => quoteIdent(c) + ' = excluded.' + quoteIdent(c)).join(', ')
  }
  return sql
}

function insertBatchParams (rows, cols, expressions) {
  const exprMap = expressions && typeof expressions === 'object' ? expressions : {}
  const bindCols = cols.filter(c => !Object.prototype.hasOwnProperty.call(exprMap, c))
  const params = []
  for (const row of rows) {
    for (const c of bindCols) {
      params.push(bindValue(row[c]))
    }
  }
  return params
}

async function insertRows (
  conn,
  { table, rows, readOnly, mode = 'append', pkColumns, updateColumns, expressions }
) {
  checkWritable(readOnly)
  if (!INSERT_MODES.includes(mode)) {
    throw new Error(`unsupported insertRows mode: ${mode}`)
  }
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : []
  if (!list.length) {
    return { affected: 0, batchCount: 0, failures: [] }
  }
  const cols = Object.keys(list[0]).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRows requires at least one column')
  }
  const { planInsertBatches } = require('./insert-batch')
  const db = getDb(conn)
  const batches = planInsertBatches(list)
  let affected = 0
  const failures = []
  if (mode === 'overwrite') {
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM ' + fullTable(table)).run()
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch (e2) {
        // ignore
      }
      throw new Error('overwrite 清空目标表失败: ' + e.message)
    }
  }
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const sql = buildInsertBatch({
      table, cols, rowCount: batch.rows.length, mode, pkColumns, updateColumns, expressions
    })
    try {
      db.exec('BEGIN')
      const res = db.prepare(sql).run(...insertBatchParams(batch.rows, cols, expressions))
      db.exec('COMMIT')
      affected += toNumber(res.changes) || 0
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch (e2) {
        // ignore
      }
      failures.push({
        batchNo: b + 1,
        firstRow: batch.firstRow,
        rowCount: batch.rows.length,
        message: e.message
      })
    }
  }
  return { affected, batchCount: batches.length, failures }
}

async function deleteRows (conn, { table, pkColumn, pkValues, readOnly }) {
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
  const db = getDb(conn)
  const sql = 'DELETE FROM ' + fullTable(table) +
    ' WHERE ' + quoteIdent(pkColumn) +
    ' IN (' + list.map(() => '?').join(', ') + ')'
  const res = db.prepare(sql).run(...list.map(bindValue))
  return { affected: toNumber(res.changes) }
}

async function updateCells (conn, { table, pkColumn, column, updates, readOnly }) {
  checkWritable(readOnly)
  if (!column || !pkColumn) {
    throw new Error('updateCells requires column and pkColumn')
  }
  const list = (Array.isArray(updates) ? updates : [])
    .filter(u => u && typeof u === 'object' && u.pk !== null && u.pk !== undefined)
  if (!list.length) {
    throw new Error('updateCells requires at least one target row')
  }
  if (list.length > UPDATE_CELLS_LIMIT) {
    throw new Error(`updateCells supports up to ${UPDATE_CELLS_LIMIT} rows at once`)
  }
  const db = getDb(conn)
  const valOf = v => bindValue(v === undefined ? null : v)
  const sameValue = list.every(u => u.value === list[0].value)
  if (sameValue) {
    const sql = 'UPDATE ' + fullTable(table) +
      ' SET ' + quoteIdent(column) + ' = ?' +
      ' WHERE ' + quoteIdent(pkColumn) +
      ' IN (' + list.map(() => '?').join(', ') + ')'
    const res = db.prepare(sql).run(valOf(list[0].value), ...list.map(u => bindValue(u.pk)))
    return { affected: toNumber(res.changes), failed: [] }
  }
  const sql = 'UPDATE ' + fullTable(table) +
    ' SET ' + quoteIdent(column) + ' = ?' +
    ' WHERE ' + quoteIdent(pkColumn) + ' = ?'
  let affected = 0
  const failed = []
  for (const u of list) {
    try {
      const res = db.prepare(sql).run(valOf(u.value), bindValue(u.pk))
      affected += toNumber(res.changes) || 0
    } catch (e) {
      failed.push({ pk: u.pk, message: e.message })
    }
  }
  return { affected, failed }
}

// ---------------------------------------------------------------- SQL 执行

// 只读白名单：首关键词允许集合 + 全句写关键词扫描（防 `WITH x AS (...) DELETE`）
const SQL_READONLY_RE = /^\s*(select|with|explain|pragma|values)\b/i
const SQL_WRITE_RE = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|rename|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i

function checkReadonly (sql, readOnly) {
  if (!readOnly) {
    return
  }
  const s = String(sql || '')
  if (!SQL_READONLY_RE.test(s)) {
    throw new Error('read-only mode: only SELECT/VALUES/PRAGMA/EXPLAIN are allowed')
  }
  if (SQL_WRITE_RE.test(s)) {
    throw new Error('read-only mode: statement contains a write keyword')
  }
  // PRAGMA 的读写之分靠 `=`：`PRAGMA user_version = 1` 会改库文件，
  // `PRAGMA journal_mode = WAL` 会改持久化模式；只读模式一律拒绝带等号的形式
  if (/^\s*pragma\b/i.test(s)) {
    if (s.includes('=') || /\bwritable_schema\b/i.test(s) || /\bwal_checkpoint\b/i.test(s)) {
      throw new Error('read-only mode: this PRAGMA form may modify the database')
    }
  }
}

// 引号/注释感知的语句切分：node:sqlite 的 prepare 只接受单条语句，
// 多语句要逐条执行并逐条收集结果。掩码串只用于判断"这段是否有内容"，
// 真正执行/展示的仍是原文。
function scanQuoted (src, start, quote) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    if (src[j] === quote) {
      if (src[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return n
}

function splitStatements (sql) {
  const src = String(sql === null || sql === undefined ? '' : sql)
  const n = src.length
  const parts = []
  const mask = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (mask[k] !== '\n' && mask[k] !== '\r') {
        mask[k] = ' '
      }
    }
  }
  const push = (from, to) => {
    let s = from
    let e = to
    while (s < e && /\s/.test(src[s])) {
      s++
    }
    while (e > s && /\s/.test(src[e - 1])) {
      e--
    }
    if (e <= s) {
      return
    }
    // 只有注释的段（`-- note`）没有可执行内容
    if (!mask.slice(s, e).join('').trim()) {
      return
    }
    parts.push(src.slice(s, e))
  }
  let i = 0
  let start = 0
  while (i < n) {
    const ch = src[i]
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = scanQuoted(src, i, ch)
      blank(i, end)
      i = end
      continue
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1)
      const end = close === -1 ? n : close + 1
      blank(i, end)
      i = end
      continue
    }
    if (ch === '-' && src[i + 1] === '-') {
      let j = src.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      blank(i, end)
      i = end
      continue
    }
    if (ch === ';') {
      push(start, i)
      start = i + 1
    }
    i++
  }
  push(start, n)
  return parts
}

function assertParamMode (sql, params) {
  if (params === undefined || params === null) {
    return
  }
  if (!Array.isArray(params)) {
    throw new Error('params must be an array')
  }
  if (splitStatements(sql).length > 1) {
    throw new Error('parameterized execution supports a single statement only')
  }
}

function toNumber (v) {
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isSafeInteger(n) ? n : v.toString()
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function statementColumns (stmt) {
  try {
    return stmt.columns() || []
  } catch (e) {
    return []
  }
}

function toResult (stmt, rows, info) {
  const meta = statementColumns(stmt)
  return {
    rows: rowToPlain(rows),
    affected: info ? toNumber(info.changes) : undefined,
    fields: meta.map(c => c.name),
    columns: toColumns(meta, c => normalizeSqliteType(c && c.type))
  }
}

async function executeSql (conn, { sql, readOnly, params }) {
  checkReadonly(sql, readOnly)
  assertParamMode(sql, params)
  const started = Date.now()
  const db = getDb(conn)
  const parts = splitStatements(sql)
  if (!parts.length) {
    return { results: [], elapsedMs: Date.now() - started }
  }
  const bound = Array.isArray(params) ? bindParams(params) : null
  const results = []
  for (const text of parts) {
    const stmt = db.prepare(text)
    const hasColumns = statementColumns(stmt).length > 0
    if (hasColumns) {
      // 用 iterate 而不是 all：all() 会先把整个结果集读进内存再截断，
      // 一条误写的 `SELECT * FROM 大表` 仍然能把主进程卡住、把内存吃满。
      // 这里读到上限就 break（for-of 会自动关闭迭代器），行数上限才真正生效。
      const rows = []
      let truncated = false
      const it = bound ? stmt.iterate(...bound) : stmt.iterate()
      for (const row of it) {
        if (rows.length >= MAX_SQL_ROWS) {
          truncated = true
          break
        }
        rows.push(row)
      }
      const res = toResult(stmt, rows, null)
      res.truncated = truncated
      res.rowLimit = MAX_SQL_ROWS
      results.push(res)
      continue
    }
    const info = bound ? stmt.run(...bound) : stmt.run()
    results.push(toResult(stmt, [], info))
  }
  return { results, elapsedMs: Date.now() - started }
}

// ---------------------------------------------------------------- EXPLAIN

const PLAN_TYPE_RE = /\b(SCAN|SEARCH|USE TEMP B-TREE|MULTI-INDEX OR|CO-ROUTINE|MATERIALIZE|SUBQUERY|COMPOUND QUERY|MERGE|BLOOM FILTER|CONSTANT ROW)\b/i

function planNodeOf (row) {
  const detail = String(row.detail || '')
  const typeMatch = PLAN_TYPE_RE.exec(detail)
  const tableMatch = /\b(?:SCAN|SEARCH)\s+(?:TABLE\s+)?([A-Za-z0-9_$."`[\]]+)/i.exec(detail)
  // `USING INTEGER PRIMARY KEY` 没有索引名，用 PRIMARY 占位（与索引面板的命名一致）
  const usingMatch = /USING\s+(?:COVERING\s+)?(?:INDEX\s+([^\s(]+)|INTEGER\s+PRIMARY\s+KEY)/i.exec(detail)
  const clean = v => (v === null || v === undefined ? null : String(v).replace(/^["`[]|["`\]]$/g, ''))
  return {
    nodeType: typeMatch ? typeMatch[1].toUpperCase() : 'PLAN',
    table: clean(tableMatch && tableMatch[1]),
    rows: null,
    filtered: null,
    key: usingMatch ? (usingMatch[1] ? clean(usingMatch[1]) : 'PRIMARY') : null,
    extra: detail || null,
    cost: null,
    children: []
  }
}

// 纯函数（导出仅供单测）：EXPLAIN QUERY PLAN 的行 → 统一节点树。
function parseSqlitePlan (rows) {
  const list = Array.isArray(rows) ? rows : []
  const nodes = new Map()
  for (const r of list) {
    nodes.set(String(r.id), planNodeOf(r))
  }
  const roots = []
  for (const r of list) {
    const node = nodes.get(String(r.id))
    const parent = nodes.get(String(r.parent))
    if (parent && parent !== node) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return {
    nodeType: 'QUERY PLAN',
    table: null,
    rows: null,
    filtered: null,
    key: null,
    extra: null,
    cost: null,
    children: roots
  }
}

async function explainQuery (conn, { sql }) {
  const s = String(sql || '').trim()
  if (!s) {
    throw new Error('explainQuery requires sql')
  }
  const parts = splitStatements(s)
  if (parts.length !== 1) {
    throw new Error('EXPLAIN 一次只接受一条语句（检测到多余分号）')
  }
  const db = getDb(conn)
  const rows = db.prepare('EXPLAIN QUERY PLAN ' + parts[0]).all()
  return {
    dialect: 'sqlite',
    root: parseSqlitePlan(rows),
    raw: rows.map(r => ({ ...r }))
  }
}

// ---------------------------------------------------------------- 列补全

async function listColumns (conn) {
  const db = getDb(conn)
  const tables = []
  for (const obj of listObjects(db)) {
    const cols = tableInfoRows(db, obj.name).map(c => ({
      name: c.name,
      type: c.type || '',
      pk: Number(c.pk) > 0
    }))
    tables.push({ table: obj.name, columns: cols })
  }
  return { tables }
}

async function closeSqliteConnection (conn) {
  if (!conn) {
    for (const db of dbs.values()) {
      try {
        db.close()
      } catch (e) {
        // ignore
      }
    }
    dbs.clear()
    refs.clear()
    return
  }
  await release(conn)
}

module.exports = {
  testSqliteConnection,
  acquire,
  release,
  evict,
  beginTx,
  commitTx,
  rollbackTx,
  getMetadata,
  getObjectDdl,
  getPageData,
  describeTable,
  getTableStructure,
  getReferences,
  listForeignKeys,
  updateCell,
  insertRow,
  insertRows,
  deleteRows,
  updateCells,
  countRows,
  executeSql,
  explainQuery,
  listColumns,
  closeSqliteConnection,
  // 纯函数导出仅供单测
  quoteIdent,
  splitStatements,
  bindValue,
  pageWindow,
  buildOrderSql,
  buildInsertBatch,
  insertBatchParams,
  checkReadonly,
  checkWritable,
  toResult,
  parseSqlitePlan,
  MAX_SQL_ROWS,
  DELETE_ROWS_LIMIT,
  UPDATE_CELLS_LIMIT
}
