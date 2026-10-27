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
  // B1：SSL 开关进签名 —— 同一 host:port 上切换 SSL 后必须拿到新 client，
  // 否则旧 client（明文/TLS）会被继续复用，"改了不生效"
  const sslTag = conn.dbSsl ? '|ssl=1' : '|ssl=0'
  return `${conn.dbHost}:${conn.dbPort}:${conn.dbUser}:${conn.dbName || ''}${sslTag}`
}

// B1：连接级 TLS/SSL 选项。内部自签证书场景，
// 采用 rejectUnauthorized: false 跳过证书链校验（与设计一致）
function sslOptions (conn) {
  return conn.dbSsl ? { ssl: { rejectUnauthorized: false } } : {}
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
    connectionTimeoutMillis: 8000,
    // B1：SSL/TLS 开关（覆盖内部自签场景，采用 rejectUnauthorized: false 跳过证书校验）
    ...sslOptions(conn)
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
    connectionTimeoutMillis: 8000,
    // B1：测试连接必须与真实连接同参数，否则"测试通过"结论与实际连接不一致
    ...sslOptions(conn)
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
  // F0：pg_tables 只有表，视图要单独查（或改用 pg_class）——这里一次查 pg_class，
  // 表和视图同列，靠 relkind 区分，省掉两次往返
  const tblRes = await c.query(
    'SELECT n.nspname AS schemaname, c.relname AS relname, c.relkind ' +
    'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') " +
    "AND n.nspname NOT IN ('pg_catalog', 'information_schema') " +
    "AND n.nspname NOT LIKE 'pg\\_%' " +
    'ORDER BY n.nspname, c.relname'
  )
  const bySchema = new Map()
  for (const r of schRes.rows) {
    bySchema.set(r.nspname, [])
  }
  for (const r of tblRes.rows) {
    if (!bySchema.has(r.schemaname)) {
      bySchema.set(r.schemaname, [])
    }
    // 'v' 普通视图 / 'm' 物化视图：都按只读视图展示（物化视图能 REFRESH 但不能改数据）
    const isView = r.relkind === 'v' || r.relkind === 'm'
    bySchema.get(r.schemaname).push({
      name: r.relname,
      type: isView ? 'view' : 'table'
    })
  }
  // B2：函数/过程/触发器按 schema 分组挂到树里。两条查询各自吞错 ——
  // 某些托管实例限制 pg_proc 可见性，失败只该少一组、不该让整棵树打不开。
  const [fnRes, tgRes] = await Promise.all([
    c.query(
      'SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind, ' +
      'p.oid::regprocedure::text AS signature ' +
      'FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ' +
      "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') " +
      "AND n.nspname NOT LIKE 'pg\\_%' " +
      'ORDER BY n.nspname, p.proname'
    ).catch(() => ({ rows: [] })),
    c.query(
      'SELECT n.nspname AS schema, t.tgname AS name, c.relname AS tbl ' +
      'FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'WHERE NOT t.tgisinternal ' +
      "AND n.nspname NOT IN ('pg_catalog', 'information_schema') " +
      "AND n.nspname NOT LIKE 'pg\\_%' " +
      'ORDER BY n.nspname, t.tgname'
    ).catch(() => ({ rows: [] }))
  ])
  // prokind：'p' 过程，其余（'f' 普通函数 / 'a' 聚合 / 'w' 窗口）一律按函数展示
  const fnBySchema = new Map()
  for (const r of fnRes.rows || []) {
    // 驱动/代理返回意外行时（缺 schema 列）直接跳过：宁可少一组，
    // 也不能造出 name=undefined 的假 schema 节点
    if (!r || !r.schema) {
      continue
    }
    if (!fnBySchema.has(r.schema)) {
      fnBySchema.set(r.schema, [])
    }
    fnBySchema.get(r.schema).push({
      name: r.name,
      type: r.kind === 'p' ? 'procedure' : 'function',
      signature: r.signature || ''
    })
  }
  for (const [schema, children] of fnBySchema) {
    if (!bySchema.has(schema)) {
      bySchema.set(schema, [])
    }
    bySchema.get(schema).push({
      name: 'routines',
      type: 'group',
      group: 'routine',
      children
    })
  }
  const tgBySchema = new Map()
  for (const r of tgRes.rows || []) {
    if (!r || !r.schema) {
      continue
    }
    if (!tgBySchema.has(r.schema)) {
      tgBySchema.set(r.schema, [])
    }
    tgBySchema.get(r.schema).push({
      name: r.name,
      type: 'trigger',
      table: r.tbl || ''
    })
  }
  for (const [schema, children] of tgBySchema) {
    if (!bySchema.has(schema)) {
      bySchema.set(schema, [])
    }
    bySchema.get(schema).push({
      name: 'triggers',
      type: 'group',
      group: 'trigger',
      children
    })
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

// 排序标识符形状：只接受 [A-Za-z0-9_$]。
// 这是**设计一致性补丁，不是补漏洞** —— quoteIdent 已经兜住了注入面
// （QA 用 sqlite3 做对照实验：`id; DROP TABLE t` 被包成 `ORDER BY "id; DROP TABLE t"`
// 时报 no such table 且表还在；同一串不带引号时 DROP 真的执行了）。
// 补这一层的原因：口径上"主进程以列白名单为安全边界"，而旧 orderBy 这条路径
// 一次白名单都不查。本轮不改 db-client/index.js（该文件被 UI/存储两条线占用），
// 所以在这里做能做的对齐：形状不像列名就不参与排序。
// 选"忽略排序"而不是"报错"：现在脏 orderBy 会让整条查询失败，
// 忽略它至少还能看到数据 —— 失败方向是"少一个排序"，不是"放行一段 SQL"。
const SORT_IDENT_RE = /^[A-Za-z0-9_$]+$/

// 分页参数归一。LIMIT/OFFSET 是**拼进 SQL 的字面数字**（不能塞进 params：
// 值和占位符混在一起会让"第几个 $n 对应哪个值"取决于拼接顺序），
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

// 单值安全化：IPC 走结构化克隆，只有纯值能安全穿越；
// Date/bigint 先行处理，Buffer 转 __bin 信封，其余带原型的对象（numeric 实例等）
// 统一转字符串，避免 "An object could not be cloned" 导致整页数据丢失。
//
// F3 二进制传输修复（设计 §9.1）：二进制列不再原样返回 Buffer（渲染层 String() 会
// 得到逗号分隔的字节数字），改成携带 base64 前缀的 `__bin` 信封，导出/预览都能复用。
// 大字段只带前缀供预览，全量取回走独立 op getCellBinary，不进 getPageData。
// PG 的 pg 驱动把 bytea 默认返回 Buffer，与 MySQL 的 Uint8Array 同属二进制路径。
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
  // Buffer 继承自 Uint8Array（见 binEnvelope 注释），二进制一律走信封
  if (v instanceof Uint8Array) {
    return binEnvelope(v)
  }
  // 有 toJSON 的优先（驱动自定义类型）
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
      // pg 适配器不引 log（保持依赖最小），静默降级 + 注释说明即可
      return ''
    }
    const dir = order === 'descend' ? 'DESC' : 'ASC'
    return quoteIdent(name) + ' ' + dir
  }
  return ''
}

// E2：条件体（where，不含前导 WHERE）+ 多列排序 + 只取总数。
// pg 的占位符是 $n，参数数组顺序仍必须与编号一致；LIMIT/OFFSET 同样是拼进去的数字。
async function getPageData (
  conn,
  { database, schema, table, page, pageSize, orderBy, order, where, whereParams, orderClauses, count }
) {
  const c = await getClient(conn)
  // pg 连接绑定单一库，跨库查询不支持
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const whereSql = typeof where === 'string' ? where.trim() : ''
  const params = Array.isArray(whereParams) ? whereParams : []
  // 显式 schema 限定，避免依赖 search_path；默认 public 兼容旧书签
  const fullTable = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  // count：只回 total，不回 rows（列信息归 F0 结构缓存，这里不重复查）
  if (count === true) {
    const countSql = 'SELECT COUNT(*) AS c FROM ' + fullTable +
      (whereSql ? ' WHERE ' + whereSql : '')
    const res = whereSql ? await c.query(countSql, params) : await c.query(countSql)
    const cell = res.rows && res.rows[0] ? res.rows[0].c : 0
    return { total: Number(cell) || 0 }
  }
  // LIMIT/OFFSET 必须先是合法整数再拼（见 pageWindow 注释）
  const win = pageWindow(page, pageSize)
  let sql = 'SELECT * FROM ' + fullTable
  if (whereSql) {
    sql += ' WHERE ' + whereSql
  }
  const orderSql = buildOrderSql(orderClauses, orderBy, order)
  if (orderSql) {
    sql += ' ORDER BY ' + orderSql
  }
  // 多取 1 行判定是否还有下一页：末页恰好整页时 hasMore 不再误报 true
  sql += ' LIMIT ' + (win.pageSize + 1) + ' OFFSET ' + win.offset
  const res = whereSql ? await c.query(sql, params) : await c.query(sql)
  return {
    rows: rowToPlain(res.rows.slice(0, win.pageSize)),
    hasMore: res.rows.length > win.pageSize
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

// ---- F0 元数据契约 v2（列 + 注释 + 索引 + 外键 + 表注释 + 估算行数） ----
// 四条 catalog 查询**并行**发：远端库上串行就是 4 个 RTT，点一次表能等上半秒。
// 列一级的主键标记不单独查：索引查询里的 indisprimary 已经涵盖，
// finalizeStructure 会从 indexes 反推回列，少一条查询少一次 catalog 扫描。
const PG_STRUCT_COLUMNS = `
SELECT c.ordinal_position,
       c.column_name,
       c.data_type,
       c.udt_name,
       c.is_nullable,
       c.column_default,
       c.character_maximum_length,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       col_description(t.oid, a.attnum) AS comment
  FROM information_schema.columns c
  JOIN pg_namespace n ON n.nspname = c.table_schema
  JOIN pg_class t ON t.relname = c.table_name AND t.relnamespace = n.oid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = c.column_name AND a.attnum > 0
 WHERE c.table_schema = $1 AND c.table_name = $2
 ORDER BY c.ordinal_position`

// LEFT JOIN LATERAL + FILTER：表达式索引的列在 pg_attribute 里没有对应项，
// 用 LEFT 保留索引本身（columns 为空数组，前端仍能列出来），否则整个索引会凭空消失
const PG_STRUCT_INDEXES = `
SELECT i.relname AS index_name,
       ix.indisprimary AS is_primary,
       ix.indisunique AS is_unique,
       am.amname AS method,
       array_agg(a.attname ORDER BY k.ord) FILTER (WHERE a.attname IS NOT NULL) AS columns
  FROM pg_index ix
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_am am ON am.oid = i.relam
  LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
 WHERE n.nspname = $1 AND t.relname = $2
 GROUP BY i.relname, ix.indisprimary, ix.indisunique, am.amname
 ORDER BY ix.indisprimary DESC, i.relname`

// confupdtype/confdeltype 是单字符（a/r/c/n/d），映射在 structure-v2.js 统一做
const PG_STRUCT_FKS = `
SELECT con.conname AS name,
       con.confupdtype AS on_update_code,
       con.confdeltype AS on_delete_code,
       rn.nspname AS ref_schema,
       rc.relname AS ref_table,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rc ON rc.oid = con.confrelid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
 WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2
 ORDER BY con.conname`

// reltuples 未 analyze 时是 -1（structure-v2 会转成 null）；
// 'p' 是分区表父表，按表处理；'v'/'m' 是视图/物化视图
const PG_STRUCT_TABLE = `
SELECT c.relkind,
       obj_description(c.oid, 'pg_class') AS comment,
       c.reltuples AS estimated_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relname = $2
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`

async function getTableStructure (conn, { table, schema }) {
  // 惰性 require（与驱动一致）：顶层不引模块，vm + require 白名单的单测无需改桩
  const structureV2 = require('./structure-v2')
  const c = await getClient(conn)
  const sch = schema || 'public'
  const tbl = String(table)
  const [colRes, idxRes, fkRes, tblRes] = await Promise.all([
    c.query(PG_STRUCT_COLUMNS, [sch, tbl]),
    c.query(PG_STRUCT_INDEXES, [sch, tbl]),
    c.query(PG_STRUCT_FKS, [sch, tbl]),
    c.query(PG_STRUCT_TABLE, [sch, tbl])
  ])
  const tableRow = tblRes.rows[0]
  // 表不存在时四条查询都返回空行，直接给空结构会让前端把表画成"零列的空表"，
  // 看起来像权限问题；这里明确报错，与 getPageData 的失败路径一致
  if (!tableRow) {
    throw new Error(`table not found: ${sch}.${tbl}`)
  }
  return structureV2.fromPg({
    columns: colRes.rows,
    indexes: idxRes.rows,
    foreignKeys: fkRes.rows,
    table: tableRow
  })
}

// ---- F1 外键引用侧栏：反向查询"哪些表引用本表"（设计 §8） ----
// 复用例：前端用返回的引用清单调 getPageData 展示引用行，本 op 只负责把"指向本表的 FK"找出来。
// PG 走 pg_constraint（contype='f'）：confrelid 指向本表即"被引用方"。
// conkey/confkey 是列号数组，需要按序号聚合成本表 FK 列 / 本表被引用列。
const PG_REFERENCES = `
SELECT con.conname AS fkName,
       n.nspname AS schema,
       t.relname AS table,
       rc.relname AS refTable,
       rn.nspname AS refSchema,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
       (SELECT array_agg(a.attname ORDER BY k.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_columns
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rc ON rc.oid = con.confrelid
  JOIN pg_namespace rn ON rn.oid = rc.relnamespace
 WHERE con.contype = 'f'
   AND rn.nspname = $1 AND rc.relname = $2
 ORDER BY con.conname`

// 只读查询：失败时降级返回 degraded，不让"账号无权限"等异常把主流程（看数据）拖垮
// （验收：只读账号页签降级隐藏 + 一行提示）。
async function getReferences (conn, { schema, table, columns }) {
  const c = await getClient(conn)
  const sch = schema || 'public'
  const tbl = String(table)
  try {
    const res = await c.query(PG_REFERENCES, [sch, tbl])
    let refs = (res.rows || []).map(r => ({
      schema: r.schema,
      table: r.table,
      fkName: r.fkName,
      refSchema: r.refSchema,
      refTable: r.refTable,
      columns: Array.isArray(r.columns) ? r.columns : [],
      refColumns: Array.isArray(r.ref_columns) ? r.ref_columns : []
    }))
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

// -------------------------------------------------- C 批：分批 multi-row INSERT（导入）
// 与 mysql 适配器同构（切批逻辑共用 ./insert-batch，事务/占位符按 pg 方言）：
// - $n 占位符全批连续编号（表达式列不占号，编号与 params 顺序严格一致）
// - upsert 用 ON CONFLICT (pk...) DO UPDATE SET col = EXCLUDED.col
// - overwrite 先独立事务 DELETE FROM 清空目标表（失败中止整个导入）；rebuild 占位
//   报错（D 批实现），与 mysql 适配器口径一致
// - expressions：列名 → SQL 片段，必须先经 safe-clause.assertSafeClause 过列白名单
//   （db-importer 负责，见 mysql 适配器同段注释）

function buildInsertBatch ({
  fullTable,
  cols,
  batchRows,
  mode = 'append',
  pkColumns,
  updateColumns,
  expressions
}) {
  const exprMap = expressions && typeof expressions === 'object' ? expressions : {}
  const hasExpr = c => Object.prototype.hasOwnProperty.call(exprMap, c)
  let n = 0
  const rowSqls = batchRows.map(row => {
    const cells = cols.map(c => {
      if (hasExpr(c)) {
        return String(exprMap[c])
      }
      n++
      return '$' + n
    })
    return '(' + cells.join(', ') + ')'
  })
  let sql = 'INSERT INTO ' + fullTable +
    ' (' + cols.map(quoteIdent).join(', ') + ')' +
    ' VALUES ' + rowSqls.join(', ')
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
      upd.map(c => quoteIdent(c) + ' = EXCLUDED.' + quoteIdent(c)).join(', ')
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
  const cols = Object.keys(list[0]).filter(k => k)
  if (!cols.length) {
    throw new Error('insertRows requires at least one column')
  }
  const { planInsertBatches } = require('./insert-batch')
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const fullTable = quoteIdent(schema || 'public') + '.' + quoteIdent(table)
  const batches = planInsertBatches(list)
  let affected = 0
  const failures = []
  if (mode === 'overwrite') {
    // 清空与写入分事务：DELETE 本身可整批失败（权限/外键），失败则整个导入中止
    // （抛错，不继续批次）；已提交批次保留是导入的既定语义（止步不回滚），
    // 不在一条大事务里硬凑原子性。与 mysql 适配器 overwrite 分支口径一致。
    try {
      await c.query('BEGIN')
      await c.query('DELETE FROM ' + fullTable)
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw new Error('overwrite 清空目标表失败: ' + e.message)
    }
  }
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]
    const sql = buildInsertBatch({
      fullTable, cols, batchRows: batch.rows, mode, pkColumns, updateColumns, expressions
    })
    try {
      // 单客户端本来就是同一连接：BEGIN/COMMIT 直接发即可
      await c.query('BEGIN')
      const res = await c.query(sql, insertBatchParams(batch.rows, cols, expressions))
      await c.query('COMMIT')
      affected += res.rowCount || 0
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
  return { affected, batchCount: batches.length, failures }
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
      rows: rowToPlain(r.rows || []),
      affected: r.command && r.command !== 'SELECT' ? r.rowCount : undefined,
      fields: Array.isArray(r.fields) ? r.fields.map(f => f.name) : []
    }))
  }
}

// -------------------------------------------------- D 批：EXPLAIN (FORMAT JSON) ----
// explainQuery({database, schema, sql}) → { dialect, root, raw }：
// root 是统一节点树 { nodeType, table, rows, filtered, key, extra, cost, children }，
// raw 是 pg 返回的原始计划文档（前端折叠查看用）。redis 不注册本 op。
// pg 驱动已把 JSON 解析为 JS 对象：rows[0]['QUERY PLAN'] = [{ Plan: {...}, ... }]。
// schema 入参仅保持调用契约一致：EXPLAIN 作用于用户输入的完整 SQL，
// 表名已在 SQL 里（或依赖 search_path），无法（也无需）给 EXPLAIN 指定 schema。

// 词法掩码：把字符串、标识符引号、行注释与块注释替换成空格（保留换行），长度与原文一致。
// 与 mysql 适配器内联的同名函数同思路（极简版 maskSqlLiterals），供 containsAnalyze
// 与多语句检查使用（两适配器不互相依赖，简单可靠优先）。
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
    // 行注释 --（pg 不认 #，但裸 # 非法，多吞无害）
    if ((c === '-' && s[i + 1] === '-') || c === '#') {
      let j = s.indexOf('\n', i)
      if (j < 0) {
        j = n
      }
      blank(i, j)
      i = j
      continue
    }
    // 块注释 /* */
    if (c === '/' && s[i + 1] === '*') {
      const found = s.indexOf('*/', i + 2)
      const j = found < 0 ? n : found + 2
      blank(i, j)
      i = j
      continue
    }
    // dollar-quoted string：$$...$$ 或 $tag$...$tag$（tag 词法同标识符）。
    // pg 词法无嵌套：闭标签 = 首个同 tag。不掩掉它的话 `$$it's$$` 的撇号
    // 会被误当普通字符串起点，把后续文本（含分号）全吞掉，多语句闸门失守
    // （QA BUG-2）。$1/$2 占位符不受影响（数字不能开 tag）。
    // 无法配对闭合时保守掩到文末：悬空串后的文本全部不可信，掩掉等于
    // 拒绝 —— 分号不可见放行为单条，由服务端报未闭合串错，不会放大执行面。
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))
      if (m) {
        const close = s.indexOf(m[0], i + m[0].length)
        const end = close < 0 ? n : close + m[0].length
        blank(i, end)
        i = end
        continue
      }
    }
    // 字符串 '...' / 标识符 "..."：反斜杠转义（E'' 串）+ 双写转义
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (s[j] === '\\') {
          j += 2
          continue
        }
        if (s[j] === c) {
          if (s[j + 1] === c) {
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

// 递归抽取：pg 计划树挂在 Plan.Plans[] 下
function convertPgNode (p) {
  const children = (Array.isArray(p.Plans) ? p.Plans : []).map(convertPgNode)
  // 树视图只展示展示性字段：过滤/连接/回描条件合并进 extra，索引名进 key
  const extra = p.Filter || p['Index Cond'] || p['Join Filter'] || p['Recheck Cond'] || null
  return {
    nodeType: p['Node Type'] || 'Plan',
    table: p['Relation Name'] || null,
    rows: finiteOrNull(p['Plan Rows']),
    filtered: null,
    key: p['Index Name'] || null,
    extra,
    cost: finiteOrNull(p['Total Cost']),
    children
  }
}

// 纯函数（导出仅供单测）：EXPLAIN (FORMAT JSON) 计划文档（含 Plan 键的对象）→ 统一节点树
function parsePgPlan (planDoc) {
  if (!planDoc || typeof planDoc !== 'object' || Array.isArray(planDoc) || !planDoc.Plan) {
    throw new Error('无法解析 EXPLAIN 输出：缺少 Plan')
  }
  return convertPgNode(planDoc.Plan)
}

async function explainQuery (conn, { database, schema, sql }) {
  const s = String(sql || '').trim()
  if (!s) {
    throw new Error('explainQuery requires sql')
  }
  // 安全边界：EXPLAIN ANALYZE 会真实执行语句，词法级检查后一律拒绝
  if (containsAnalyze(s)) {
    throw new Error('EXPLAIN 拒绝 ANALYZE：EXPLAIN ANALYZE / EXPLAIN (ANALYZE 会真实执行语句')
  }
  // pg 无 multipleStatements，单条 query 多语句会直接语法错；这里同样拒绝
  // 多余分号，与 mysql 适配器口径一致（尾部孤立分号放行）
  const masked = maskSqlText(s.replace(/[;\s]+$/, ''))
  if (masked.includes(';')) {
    throw new Error('EXPLAIN 一次只接受一条语句（检测到多余分号）')
  }
  const c = await getClient(conn)
  if (database && database !== c.database) {
    throw new Error('cross-database query not supported for postgres, connect with that database')
  }
  const res = await c.query('EXPLAIN (FORMAT JSON) ' + s)
  const row = res.rows && res.rows[0]
  const list = row && row['QUERY PLAN']
  if (!list) {
    throw new Error('无法解析 EXPLAIN 输出：缺少 QUERY PLAN')
  }
  const planDoc = Array.isArray(list) ? list[0] : list
  return { dialect: 'postgres', root: parsePgPlan(planDoc), raw: planDoc }
}

// 无参全清（app 退出兜底）
async function closePostgresConnection () {
  for (const c of clients.values()) {
    await c.end().catch(() => {})
  }
  clients.clear()
  refs.clear()
}

// B2：对象 DDL（只读查看）。种类走白名单；
// 函数/过程用 regprocedure 签名定位（PG 允许重载，单靠名字会歧义或多结果），
// 触发器用 tgname + 表名定位（同名触发器可存在于不同表）。
async function getObjectDdl (conn, args) {
  const kind = String((args && args.objectType) || '').toLowerCase()
  if (kind !== 'function' && kind !== 'procedure') {
    if (kind === 'trigger') {
      const c = await getClient(conn)
      const r = await c.query(
        'SELECT pg_get_triggerdef(t.oid) AS ddl FROM pg_trigger t ' +
        'JOIN pg_class c ON c.oid = t.tgrelid ' +
        'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        "WHERE t.tgname = $1 AND ($2 = '' OR c.relname = $2) LIMIT 1",
        [String(args.name || ''), String(args.table || '')]
      )
      if (!r.rows.length) {
        throw new Error(`trigger not found: ${args.name}`)
      }
      return { name: args.name, objectType: kind, ddl: r.rows[0].ddl }
    }
    throw new Error(`unsupported object type: ${args && args.objectType}`)
  }
  const signature = String((args && (args.signature || args.name)) || '')
  if (!signature) {
    throw new Error('function signature required')
  }
  const c = await getClient(conn)
  // 签名来自元数据（regprocedure::text），直接查 pg_proc；查不到说明对象已被删
  const f = await c.query(
    'SELECT p.oid, p.proname FROM pg_proc p WHERE p.oid = $1::regprocedure',
    [signature]
  )
  if (!f.rows.length) {
    throw new Error(`${kind} not found: ${signature}`)
  }
  const d = await c.query('SELECT pg_get_functiondef($1) AS ddl', [f.rows[0].oid])
  return {
    name: f.rows[0].proname || args.name,
    objectType: kind,
    ddl: (d.rows[0] && d.rows[0].ddl) || ''
  }
}

module.exports = {
  testPostgresConnection,
  acquire,
  release,
  getMetadata,
  getObjectDdl,
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
  closePostgresConnection,
  // 纯函数导出仅供单测（列分组 / 反向外键查询 / 批量 INSERT 语句构建 /
  // EXPLAIN 计划解析 / ANALYZE 词法检查）
  groupColumns,
  getReferences,
  buildInsertBatch,
  insertBatchParams,
  parsePgPlan,
  containsAnalyze
}
