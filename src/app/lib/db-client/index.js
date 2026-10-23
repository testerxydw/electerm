/**
 * database client factory
 * - testDbConnection: one-off connection test (phase1)
 * - openDbTab / dbClientOp: per-tab persistent client + op dispatch (phase2)
 * Drivers are lazy loaded inside each adapter.
 */

const { createDbTunnel } = require('../db-tunnel')
// db-client 在 lib 二级子目录，需向上两级到 src/app/common/log
const log = require('../../common/log')

// dbType → 适配器模块（tidb/oceanbase 兼容 mysql 协议，复用 mysql 适配器）
const DB_ADAPTER = {
  mysql: 'mysql',
  tidb: 'mysql',
  oceanbase: 'mysql',
  postgres: 'postgres',
  redis: 'redis'
}

const testers = {
  mysql: opts => require('./mysql').testMysqlConnection(opts),
  tidb: opts => require('./mysql').testMysqlConnection(opts),
  oceanbase: opts => require('./mysql').testMysqlConnection(opts),
  postgres: opts => require('./postgres').testPostgresConnection(opts),
  redis: opts => require('./redis').testRedisConnection(opts)
}

// per-tab client instances: { tabId: { dbType, conn, close, tunnel } }
const instances = {}

// ops routed to the driver method for an adapter (single method dispatch)
const OP_MAP = {
  mysql: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    describeTable: 'describeTable',
    getTableStructure: 'getTableStructure',
    updateCell: 'updateCell',
    insertRow: 'insertRow',
    deleteRows: 'deleteRows',
    countRows: 'countRows',
    executeSql: 'executeSql',
    listColumns: 'listColumns'
  },
  postgres: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    describeTable: 'describeTable',
    getTableStructure: 'getTableStructure',
    updateCell: 'updateCell',
    insertRow: 'insertRow',
    deleteRows: 'deleteRows',
    countRows: 'countRows',
    executeSql: 'executeSql',
    listColumns: 'listColumns'
  },
  redis: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    getKeyDetail: 'getKeyDetail',
    setKey: 'setKey',
    delKey: 'delKey',
    expireKey: 'expireKey'
  }
}

function getAdapter (dbType) {
  const name = DB_ADAPTER[dbType]
  if (!name) {
    throw new Error(`unsupported db type: ${dbType}`)
  }
  return require('./' + name)
}

// 建连/元数据/键操作走快路径；executeSql/getPageData 给足时间，
// 避免 24 万行大表扫描、深分页被统一 15s 误杀（P2-19）
const OVERALL_TIMEOUT = 15000
const OP_TIMEOUTS = {
  default: 15000,
  executeSql: 120000,
  getPageData: 60000,
  countRows: 60000
}

// label 用于区分超时来源（connection/metadata/db op xxx），错误消息随 label 穿透到前端
// 结果落定时必须清掉定时器：否则每个 op 都会留下一个挂到超时点（最长 120s）的 timer，
// 高频 op（补全列查询、分页）下会持续堆积；单测进程也会被这些 timer 拖着等满超时。
function withTimeout (promise, ms, label = 'connection') {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout (${Math.round(ms / 1000)}s)`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

const DEFAULT_PORTS = {
  mysql: 3306,
  tidb: 4000,
  oceanbase: 2881,
  postgres: 5432,
  redis: 6379
}

function resolvePort (dbBookmark) {
  return dbBookmark.dbPort || DEFAULT_PORTS[dbBookmark.dbType] || 3306
}

async function buildConn (dbBookmark, sshBookmark) {
  const dbType = dbBookmark.dbType
  const useTunnel = !!sshBookmark
  const dbHost = useTunnel ? '127.0.0.1' : (dbBookmark.dbHost || '127.0.0.1')
  let tunnel = null
  if (useTunnel) {
    tunnel = await createDbTunnel(
      sshBookmark,
      dbBookmark.dbHost || '127.0.0.1',
      resolvePort(dbBookmark)
    )
  }
  return {
    dbType,
    readOnly: dbBookmark.readOnly !== false,
    conn: {
      ...dbBookmark,
      dbHost,
      dbPort: useTunnel ? tunnel.port : resolvePort(dbBookmark)
    },
    tunnel
  }
}

async function testDbConnection (dbBookmark, sshBookmark) {
  const dbType = dbBookmark.dbType
  const tester = testers[dbType]
  if (!tester) {
    throw new Error(`unsupported db type: ${dbType}`)
  }
  const inst = await buildConn(dbBookmark, sshBookmark)
  try {
    const msg = await withTimeout(tester(inst.conn), OVERALL_TIMEOUT)
    return { ok: true, message: inst.tunnel ? `${msg} (via ssh tunnel)` : msg }
  } catch (e) {
    log.error('testDbConnection fails', e.message)
    throw e
  } finally {
    if (inst.tunnel) {
      inst.tunnel.close()
    }
  }
}

async function openDbTab (dbBookmark, sshBookmark) {
  const adapter = getAdapter(dbBookmark.dbType)
  // 同一 tabId 重复 open（如断线重连）时先释放旧连接与隧道，避免句柄泄漏
  if (instances[dbBookmark.id]) {
    await closeDbTab(dbBookmark.id)
  }
  // 竞态占位（P4 审计修复）：closeDbTab 在 open 完成前到达时 instances 无正式
  // 记录会变成 no-op，连接在 open 完成后无主滞留（慢连接 + 秒关 tab，实测可复现，
  // 见 doc/已完成/分析-性能热点与优化总案-2026-10-21.md）。
  // 占位记录 aborted 标记与中间产物：closeDbTab 置位，openDbTab 分步检查。
  log.debug('[db-client] openDbTab', dbBookmark.id)
  const pending = {
    pending: true,
    aborted: false,
    conn: null,
    tunnel: null,
    acquired: false
  }
  instances[dbBookmark.id] = pending
  let inst = null
  try {
    inst = await buildConn(dbBookmark, sshBookmark)
    pending.conn = inst.conn
    pending.tunnel = inst.tunnel
    if (pending.aborted) {
      // 还没 acquire，无引用计数需要回落，只关隧道
      log.debug('[db-client] openDbTab aborted before acquire', dbBookmark.id)
      throw new Error('db tab closed while opening')
    }
    // acquire: 建立真实连接并验证（失败上抛，tab 打开即暴露连接问题）
    await withTimeout(adapter.acquire(inst.conn), OVERALL_TIMEOUT)
    pending.acquired = true
    log.debug('[db-client] openDbTab acquired', dbBookmark.id, 'aborted=', pending.aborted)
    if (pending.aborted) {
      log.debug('[db-client] openDbTab aborted after acquire', dbBookmark.id)
      throw new Error('db tab closed while opening')
    }
    // open metadata eagerly to surface metadata errors at tab open
    await withTimeout(adapter.getMetadata(inst.conn), OVERALL_TIMEOUT, 'metadata')
    if (pending.aborted) {
      throw new Error('db tab closed while opening')
    }
  } catch (e) {
    // 只删自己的占位：重连竞态下可能已有新一轮 open 的占位/正式记录
    if (instances[dbBookmark.id] === pending) {
      delete instances[dbBookmark.id]
    }
    // 打开失败/打开中被关闭：释放已建立连接与隧道，防泄漏
    if (pending.acquired) {
      // acquire 内部先 +1 引用计数，只有 acquire 成功过才能对称 release
      try {
        await adapter.release(pending.conn)
      } catch (e2) {
        // ignore
      }
    }
    if (pending.tunnel) {
      pending.tunnel.close()
    }
    throw e
  }
  instances[dbBookmark.id] = inst
  return { ok: true }
}

// ---------------------------------------------------------------- 列元数据缓存
// 补全每次输入都会问列，不缓存就是「每敲一个键 → 一次 IPC → 一次 information_schema 查询」。
// 缓存在 per-tab 实例上，随 tab 关闭一起释放；键含 database + schema，切库天然不串。
// getMetadata（打开 tab / 手动刷新 / 切库重建树）时整体清空——新增或删掉列之后，
// 树已经是新的了，列缓存还留着旧列会补出已不存在的字段。
const COLUMNS_CACHE_SEP = '\u0000'

function columnsCacheKey (args) {
  const a = args || {}
  return String(a.database || '') + COLUMNS_CACHE_SEP + String(a.schema || '')
}

function resetColumnsCache (inst) {
  inst.columnsCache = { values: new Map(), inflight: new Map() }
  return inst.columnsCache
}

// 同键并发去重：补全可能在同一个键上连发几次（编辑器重建 source 时），
// 合并成一次查询；失败不缓存，下次输入会重试
async function listColumnsCached (inst, adapter, args, opMs) {
  const key = columnsCacheKey(args)
  const cache = inst.columnsCache || resetColumnsCache(inst)
  if (cache.values.has(key)) {
    return cache.values.get(key)
  }
  if (cache.inflight.has(key)) {
    return cache.inflight.get(key)
  }
  const p = withTimeout(adapter.listColumns(inst.conn, args), opMs, 'db op listColumns').then(
    res => {
      cache.values.set(key, res)
      cache.inflight.delete(key)
      return res
    },
    err => {
      cache.inflight.delete(key)
      throw err
    }
  )
  cache.inflight.set(key, p)
  return p
}

// ---------------------------------------------------------------- 表结构缓存
// F0 表结构（列/索引/外键/注释）比列缓存重得多：四条 catalog 查询 + 每列注释。
// 点一次表就全量查一遍，表头悬浮提示和列宽计算会反复触发，必须缓存。
// 与列缓存分开而不是复用：列缓存是"整库列清单"给补全用、键只有 database+schema；
// 这里是"单表结构"、键到表，且带 TTL —— 结构会因 ALTER 变化，
// 60s 是"刷新一次树就该看到新结构"与"别每点一次都打 catalog"之间的折中。
const STRUCTURE_TTL = 60000

function structureKey (args) {
  const a = args || {}
  return [a.database || '', a.schema || '', a.table || ''].join(COLUMNS_CACHE_SEP)
}

function resetStructureCache (inst) {
  inst.structureCache = { values: new Map(), inflight: new Map(), ts: new Map() }
  return inst.structureCache
}

// 同键并发去重：结构面板 + 表头提示可能同时问同一张表，合并成一次四条查询
async function structureCached (inst, adapter, args, opMs) {
  const key = structureKey(args)
  const cache = inst.structureCache || resetStructureCache(inst)
  if (cache.values.has(key)) {
    const at = cache.ts.get(key) || 0
    if (Date.now() - at < STRUCTURE_TTL) {
      return cache.values.get(key)
    }
    // 过期不先删：查失败时旧值还能兜住上一次的成功结果（见下面的 catch）
    // 这里只是不再直接返回，继续走下面的查询
  }
  if (cache.inflight.has(key)) {
    return cache.inflight.get(key)
  }
  const p = withTimeout(
    adapter.getTableStructure(inst.conn, args),
    opMs,
    'db op getTableStructure'
  ).then(
    res => {
      cache.values.set(key, res)
      cache.ts.set(key, Date.now())
      cache.inflight.delete(key)
      return res
    },
    err => {
      cache.inflight.delete(key)
      // 过期后重查失败（网络抖动/权限临时变化）：有旧值就继续用旧的，
      // 总比让表头整块变空好；TTL 会在下次请求时再试
      if (cache.values.has(key)) {
        return cache.values.get(key)
      }
      throw err
    }
  )
  cache.inflight.set(key, p)
  return p
}

// -------------------------------------------------- E2 条件体/排序的主进程校验
// 为什么在这里拦：db-grid-view.js 生成的 where 是渲染层的产出，DevTools 里改一行
// 就能换成任意字符串。真正的闸门必须在主进程，而且判据必须是**列白名单**
// （来自表结构），不是"把可疑字符删掉"。
// 为什么复用 structureCached 而不是自己查：同一个 60s TTL 正好覆盖"改条件连点几次"，
// 且结构面板/表头已经把它查热了，这里几乎不会多一次远端查询。

function dialectOf (inst) {
  // tidb/oceanbase 走 mysql 协议，词法与占位符都同 mysql
  return DB_ADAPTER[inst.dbType] === 'postgres' ? 'postgres' : 'mysql'
}

// 是否需要走校验：**同步**判定。
// 为什么必须同步：dbClientOp 里任何一次 await 都会把 withTimeout 的计时器挂到下一个
// 微任务里，而操作级超时的语义是"发起即计时"。不带条件/排序的分页（绝大多数翻页）
// 在这里直接短路返回 false，路径与加特性之前完全一致。
function needsPageBoundary (args) {
  const where = args.where
  // 类型不对也走校验：由 assertPageBoundary 报"条件体必须是字符串"，
  // 而不是让 [object Object] 一路拼进 SQL
  if (where !== undefined && where !== null && typeof where !== 'string') {
    return true
  }
  if (typeof where === 'string' && where.trim()) {
    return true
  }
  return Array.isArray(args.orderClauses) && args.orderClauses.length > 0
}

async function assertPageBoundary (inst, adapter, args, opMs) {
  const where = typeof args.where === 'string' ? args.where.trim() : ''
  if (args.where !== undefined && args.where !== null && typeof args.where !== 'string') {
    throw new Error('条件体必须是字符串')
  }
  const orderClauses = Array.isArray(args.orderClauses) ? args.orderClauses : null
  if (!where && !orderClauses) {
    return
  }
  // 按需加载：不带条件/排序的分页（绝大多数翻页）连这个模块都不需要进内存。
  // 与本文件其他依赖一致（适配器、驱动都是 lazy require），也避免给只读 op 增加启动成本。
  const { assertSafeClause, assertSafeOrderClauses } = require('./safe-clause')
  const dialect = dialectOf(inst)
  let structure = null
  try {
    structure = await structureCached(inst, adapter, {
      database: args.database,
      schema: args.schema || '',
      table: args.table
    }, opMs)
  } catch (e) {
    if (where) {
      // 有 where 就必须有列白名单：空白名单会把每条条件都判成未知列，
      // 报出来的"列不存在"对用户毫无意义，不如直说拿不到列信息
      throw new Error('无法获取列信息，条件查询已拒绝: ' + e.message)
    }
    // 只排序时取不到结构：放行 —— 排序片段由适配器加引用符，没有注入面，
    // 而让"读不到结构"连带着把数据也看不了是本轮之前没有的退步
    log.warn('[db-client] orderClauses skipped: no structure', args.table, e.message)
    return
  }
  const columns = ((structure && structure.columns) || [])
    .map(col => (col && col.name) || '')
    .filter(name => typeof name === 'string' && name)
  if (!columns.length) {
    if (where) {
      throw new Error('无法获取列信息，条件查询已拒绝')
    }
    return
  }
  if (where) {
    const { placeholders } = assertSafeClause(where, columns, dialect)
    const argCount = Array.isArray(args.whereParams) ? args.whereParams.length : 0
    if (placeholders !== argCount) {
      throw new Error(`占位符数量(${placeholders})与参数数量(${argCount})不一致`)
    }
  }
  assertSafeOrderClauses(orderClauses, columns, dialect)
}

async function dbClientOp (tabId, op, args) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    // pending 占位 = open 进行中，连接尚未可用
    throw new Error('database tab not open')
  }
  const adapter = getAdapter(inst.dbType)
  const opMap = OP_MAP[DB_ADAPTER[inst.dbType]]
  const method = opMap && opMap[op]
  if (!method) {
    throw new Error(`unsupported op for ${inst.dbType}: ${op}`)
  }
  // 只读开关以主进程侧连接配置为权威：不使用渲染层传入的 readOnly，
  // 否则渲染层只要传 readOnly:false 就能绕过写操作白名单（安全边界必须在主进程）。
  const safeArgs = {
    ...(args || {}),
    readOnly: inst.readOnly
  }
  const opMs = OP_TIMEOUTS[op] || OP_TIMEOUTS.default
  if (op === 'getMetadata') {
    // 树刷新/切库后列与结构都可能已变，两套缓存必须跟着失效
    resetColumnsCache(inst)
    resetStructureCache(inst)
  }
  if (op === 'listColumns') {
    return listColumnsCached(inst, adapter, safeArgs, opMs)
  }
  if (op === 'getTableStructure') {
    return structureCached(inst, adapter, safeArgs, opMs)
  }
  if (op === 'getPageData' && DB_ADAPTER[inst.dbType] !== 'redis' &&
    needsPageBoundary(safeArgs)) {
    // redis 的 getPageData 是 SCAN 语义：没有 where、也没有 getTableStructure，
    // 误走校验会抛 unsupported op（而不是"条件不合法"），故整类跳过
    await assertPageBoundary(inst, adapter, safeArgs, opMs)
  }
  if (op === 'executeSql') {
    // 执行完就丢结构缓存：用户可能刚跑过 ALTER/DDL，
    // 60s TTL 内还拿旧列会让表头与真实表对不上（DDL 不是高频操作，清空的代价可忽略）
    return withTimeout(adapter[method](inst.conn, safeArgs), opMs, `db op ${op}`)
      .finally(() => resetStructureCache(inst))
  }
  return withTimeout(adapter[method](inst.conn, safeArgs), opMs, `db op ${op}`)
}

// 页面上切换只读模式：白名单以主进程实例为权威（渲染层传参不可信），
// 故前端改开关必须同步到这里，否则开关只是"看起来变了"而写操作仍被拦/仍放行
async function setDbReadOnly (tabId, readOnly) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  inst.readOnly = readOnly !== false
  return { ok: true }
}

async function closeDbTab (tabId) {
  const inst = instances[tabId]
  log.debug('[db-client] closeDbTab', tabId, inst ? (inst.pending ? 'pending' : 'normal') : 'missing')
  if (!inst) {
    return
  }
  delete instances[tabId]
  // pending 占位（open 进行中）：无正式连接可释放，置中止标记，
  // openDbTab 完成各步骤前检查并自行释放（竞态滞留修复）
  if (inst.pending) {
    inst.aborted = true
    return
  }
  try {
    await getAdapter(inst.dbType).release(inst.conn)
  } catch (e) {
    // ignore close errors
  }
  if (inst.tunnel) {
    inst.tunnel.close()
  }
}

async function closeAllDbTabs () {
  await Promise.all(
    Object.keys(instances).map(id => closeDbTab(id))
  )
  // 兜底全清（防引用计数漏计导致的残留连接）
  await Promise.all([
    require('./mysql').closeMysqlConnection(),
    require('./postgres').closePostgresConnection(),
    require('./redis').closeRedisConnection()
  ].map(p => p.catch(() => {})))
}

module.exports = {
  testDbConnection,
  openDbTab,
  dbClientOp,
  setDbReadOnly,
  closeDbTab,
  closeAllDbTabs
}
