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
    getReferences: 'getReferences',
    updateCell: 'updateCell',
    insertRow: 'insertRow',
    deleteRows: 'deleteRows',
    updateCells: 'updateCells',
    countRows: 'countRows',
    executeSql: 'executeSql',
    explainQuery: 'explainQuery',
    listColumns: 'listColumns',
    getObjectDdl: 'getObjectDdl'
  },
  postgres: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    describeTable: 'describeTable',
    getTableStructure: 'getTableStructure',
    getReferences: 'getReferences',
    updateCell: 'updateCell',
    insertRow: 'insertRow',
    deleteRows: 'deleteRows',
    updateCells: 'updateCells',
    countRows: 'countRows',
    executeSql: 'executeSql',
    explainQuery: 'explainQuery',
    listColumns: 'listColumns',
    getObjectDdl: 'getObjectDdl'
  },
  redis: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    // R1：键列表任意跳页（SCAN 从 cursor=0 前向步进到目标页）
    scanKeysToPage: 'scanKeysToPage',
    getKeyDetail: 'getKeyDetail',
    setKey: 'setKey',
    delKey: 'delKey',
    expireKey: 'expireKey',
    // D 批类型化写（T12）：hash/set/zset/list/key
    hashSetField: 'hashSetField',
    hashDelField: 'hashDelField',
    setAdd: 'setAdd',
    setRem: 'setRem',
    zsetAdd: 'zsetAdd',
    zsetRem: 'zsetRem',
    listPush: 'listPush',
    listSetAt: 'listSetAt',
    listRemAt: 'listRemAt',
    renameKeyNx: 'renameKeyNx'
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
  // EXPLAIN 属分析类：大表的计划生成同样可能超过 15s，跟随 executeSql 口径
  explainQuery: 120000,
  getPageData: 60000,
  // R1：键列表跳页需从 0 前向步进（深跳可能是多次 SCAN），给足与 getPageData 同档超时
  scanKeysToPage: 60000,
  countRows: 60000
}

// label 用于区分超时来源（connection/metadata/db op xxx），错误消息随 label 穿透到前端
// 结果落定时必须清掉定时器：否则每个 op 都会留下一个挂到超时点（最长 120s）的 timer，
// 高频 op（补全列查询、分页）下会持续堆积；单测进程也会被这些 timer 拖着等满超时。
// 错误消息统一带 ETIMEDOUT 标记：前端 CONN_ERR_RE 正是靠它识别"断连"。
// 断连场景下裸的 `${label} timeout` 不含任何关键词，会被误判为非连接错误——
// 顶栏一直保持绿色"已连接"（用户实测超时但状态未更新的直接原因）。
function withTimeout (promise, ms, label = 'connection', onTimeout) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') {
        try {
          onTimeout()
        } catch (e) {
          log.warn('[db-client] withTimeout onTimeout failed', e.message)
        }
      }
      reject(new Error(`${label} timeout (${Math.round(ms / 1000)}s) [ETIMEDOUT]`))
    }, ms)
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
  // 打开阶段超时同样销毁连接池：acquire 建连被服务端拒绝/静默丢弃时，残留的池下次复用仍是死的。
  // 用 inst.conn（buildConn 归一化后的签名）保证与 evict 内部 sig(conn) 的键一致；inst 后声明，
  // 但闭包只在超时（acquire/getMetadata 挂起）时才执行，彼时 inst 已赋值。
  let inst = null
  const evictOnTimeout = () => {
    if (adapter && typeof adapter.evict === 'function' && inst && inst.conn) {
      adapter.evict(inst.conn)
    }
  }
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
    // 超时只表示 openDbTab 不再等它：acquire 本身可能稍后仍然成功并占住一次引用计数，
    // 而 pending.acquired 此时仍是 false（下面的 catch 不会 release）——
    // 所以等它落地后立刻补一次 release，否则这次 +1 会永久占着连接
    let acquireP = null
    try {
      acquireP = adapter.acquire(inst.conn)
      await withTimeout(acquireP, OVERALL_TIMEOUT, 'connection', evictOnTimeout)
    } catch (e) {
      if (acquireP) {
        Promise.resolve(acquireP)
          .then(() => adapter.release(pending.conn))
          .catch(() => {})
      }
      throw e
    }
    pending.acquired = true
    log.debug('[db-client] openDbTab acquired', dbBookmark.id, 'aborted=', pending.aborted)
    if (pending.aborted) {
      log.debug('[db-client] openDbTab aborted after acquire', dbBookmark.id)
      throw new Error('db tab closed while opening')
    }
    // open metadata eagerly to surface metadata errors at tab open
    await withTimeout(adapter.getMetadata(inst.conn), OVERALL_TIMEOUT, 'metadata', evictOnTimeout)
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
// 合并成一次查询；失败不缓存，下次输入会重试。
// connOverride：F2 事务钉住期间传事务连接（否则默认 inst.conn 走共享池）
async function listColumnsCached (inst, adapter, args, opMs, onTimeout, connOverride) {
  const key = columnsCacheKey(args)
  const cache = inst.columnsCache || resetColumnsCache(inst)
  if (cache.values.has(key)) {
    return cache.values.get(key)
  }
  if (cache.inflight.has(key)) {
    return cache.inflight.get(key)
  }
  const p = withTimeout(adapter.listColumns(connOverride || inst.conn, args), opMs, 'db op listColumns', onTimeout).then(
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
// 老化阈值与条目上限：过期值不立即删，是为了查失败时还能兜住上次的成功结果；
// 但"不删"不能等于"永久保留" —— 缓存挂在 tab 实例上，长会话里翻过几千张表，
// 每张表的完整结构（列/索引/外键/注释）都会一直钉在内存里。真正长期存活的
// 都是"很久没再点开的表"，这部分只占内存不产生收益。
// 10 分钟没再成功查询过的条目直接丢弃；2000 条是单 tab 硬上限，超出按最后
// 成功时间淘汰最旧（values 的 Map 插入序不会因重复 set 更新，不能当 LRU 用）。
const STRUCTURE_STALE_MS = 10 * 60 * 1000
const STRUCTURE_CACHE_MAX = 2000

function pruneStructureCache (cache) {
  const now = Date.now()
  for (const [k, at] of cache.ts) {
    if (now - at > STRUCTURE_STALE_MS) {
      cache.ts.delete(k)
      cache.values.delete(k)
    }
  }
  if (cache.ts.size <= STRUCTURE_CACHE_MAX) {
    return
  }
  const oldest = Array.from(cache.ts.entries()).sort((a, b) => a[1] - b[1])
  for (let i = 0; i < oldest.length - STRUCTURE_CACHE_MAX; i++) {
    cache.ts.delete(oldest[i][0])
    cache.values.delete(oldest[i][0])
  }
}

function structureKey (args) {
  const a = args || {}
  return [a.database || '', a.schema || '', a.table || ''].join(COLUMNS_CACHE_SEP)
}

function resetStructureCache (inst) {
  inst.structureCache = { values: new Map(), inflight: new Map(), ts: new Map() }
  return inst.structureCache
}

// 同键并发去重：结构面板 + 表头提示可能同时问同一张表，合并成一次四条查询。
// connOverride：F2 事务钉住期间传事务连接（否则默认 inst.conn 走共享池）
async function structureCached (inst, adapter, args, opMs, onTimeout, connOverride) {
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
    'db op getTableStructure',
    onTimeout
  ).then(
    res => {
      cache.values.set(key, res)
      cache.ts.set(key, Date.now())
      pruneStructureCache(cache)
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

async function assertPageBoundary (inst, adapter, args, opMs, evictOnTimeout) {
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
    }, opMs, evictOnTimeout)
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
  // F2 事务 op 不走适配器方法表：连接生命周期由本模块掌握，
  // begin/commit/rollback 各自校验 tab 与 pinned 状态
  if (op === 'beginDbTx') {
    return beginDbTx(tabId)
  }
  if (op === 'commitDbTx') {
    return commitDbTx(tabId)
  }
  if (op === 'rollbackDbTx') {
    return rollbackDbTx(tabId)
  }
  if (op === 'getDbTxState') {
    return getDbTxState(tabId)
  }
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
  const pinned = inst.pinned
  if (pinned && pinned.closing) {
    // 提交/回滚在途：此时新 op 若走共享连接会读到还没提交的快照，
    // 明确拒绝比给出不一致结果好（前端在按钮 loading 期间不会发新语句）
    throw new Error('transaction is closing')
  }
  // F2：事务钉住期间所有 op 走专用事务连接（一致读 + 写入同一事务）；
  // 非事务 op 保持原连接，缓存与签名口径不变
  const opConn = pinned
    ? { ...inst.conn, __txClient: pinned.client }
    : inst.conn
  // 断连自愈：db op 超时大概率是连接已被服务端静默断开（死 socket 挂起直到 withTimeout 拒绝）。
  // 触发时销毁该签名的连接池（adapter.evict），下次操作自动重建——重建后即恢复，无需手动关 tab。
  // mysql 适配器实现了 evict；postgres/redis 无池（单连接）超时属"慢查询/对端不响应"，
  // 不销毁（避免把正常慢查询误判成断连），但错误已带 ETIMEDOUT 交给前端触发重连提示。
  // 事务连接不 evict：销毁签名池会连带杀掉池里钉住的连接，事务内超时按普通错误上抛。
  const evictOnTimeout = () => {
    if (!pinned && adapter && typeof adapter.evict === 'function') {
      adapter.evict(inst.conn)
    }
  }
  const runOp = async () => {
    if (op === 'getMetadata') {
      // 树刷新/切库后列与结构都可能已变，两套缓存必须跟着失效
      resetColumnsCache(inst)
      resetStructureCache(inst)
    }
    if (op === 'listColumns') {
      return listColumnsCached(inst, adapter, safeArgs, opMs, evictOnTimeout, opConn)
    }
    if (op === 'getTableStructure') {
      return structureCached(inst, adapter, safeArgs, opMs, evictOnTimeout, opConn)
    }
    if (op === 'getPageData' && DB_ADAPTER[inst.dbType] !== 'redis' &&
      needsPageBoundary(safeArgs)) {
      // redis 的 getPageData 是 SCAN 语义：没有 where、也没有 getTableStructure，
      // 误走校验会抛 unsupported op（而不是"条件不合法"），故整类跳过
      await assertPageBoundary(inst, adapter, safeArgs, opMs, evictOnTimeout, opConn)
    }
    if (op === 'executeSql') {
      // 执行完就丢结构缓存：用户可能刚跑过 ALTER/DDL，
      // 60s TTL 内还拿旧列会让表头与真实表对不上（DDL 不是高频操作，清空的代价可忽略）
      return withTimeout(adapter[method](opConn, safeArgs), opMs, `db op ${op}`, evictOnTimeout)
        .finally(() => resetStructureCache(inst))
    }
    return withTimeout(adapter[method](opConn, safeArgs), opMs, `db op ${op}`, evictOnTimeout)
  }
  if (!pinned) {
    return runOp()
  }
  // F2 事务内：串行排队（单连接不支持并发）+ 记变更清单 + 摸活（重置空闲回滚计时）
  // 批量改值自管 START TRANSACTION，在手动事务里会把外层隐式提交 —— 直接拒绝
  // （导入走 getDbTabContext，已在那边拦）
  if (op === 'updateCells') {
    throw new Error(`db op ${op} is not allowed inside a manual transaction (commit or rollback first)`)
  }
  const startedAt = Date.now()
  const text = txStatementText(op, safeArgs)
  const next = pinned.queue.then(runOp, runOp)
  pinned.queue = next.then(() => {}, () => {})
  try {
    const res = await next
    recordTxStatement(pinned, {
      at: startedAt,
      ms: Date.now() - startedAt,
      sql: text,
      affectedRows: txAffected(res)
    })
    return res
  } catch (e) {
    recordTxStatement(pinned, {
      at: startedAt,
      ms: Date.now() - startedAt,
      sql: text,
      error: e && e.message ? e.message : String(e)
    })
    throw e
  } finally {
    pinned.lastActiveAt = Date.now()
    armTxIdleTimer(inst)
  }
}

// 页面上切换只读模式：白名单以主进程实例为权威（渲染层传参不可信），
// 故前端改开关必须同步到这里，否则开关只是"看起来变了"而写操作仍被拦/仍放行
async function setDbReadOnly (tabId, readOnly) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  // F2：切只读前先回滚未提交事务（设计 §13.1）——只读白名单拦得住新语句，
  // 拦不住已在事务里待提交的变更，必须先了结再切
  if (readOnly !== false && inst.pinned) {
    await forceEndTx(inst, 'readonly', true)
  }
  inst.readOnly = readOnly !== false
  return { ok: true }
}

// ---------------------------------------------------------------- F2 事务安全带
// 设计 §13：手动事务 = 连接钉住。beginDbTx 从池取专用连接并开启事务，
// 期间该 tab 的所有 op 都走这条连接（一致读 + 写入同一事务）且串行执行；
// commit/rollback 释放连接。三条强制收口：空闲 10 分钟自动回滚、
// 关 tab/重连强制回滚（禁止静默提交）、开启只读前先回滚。
// 明确不做：SAVEPOINT、嵌套事务、跨 tab 共享事务、分布式事务。
const TX_IDLE_MS = 10 * 60 * 1000
// 连接池 connectionLimit=4：钉住 1 条 + 常规并发仍需余量，最多 2 个 tab 同时开手动事务
const TX_MAX_TABS = 2
// 变更清单保留上限：超长事务（跑批）只留最近 N 条，防主进程内存被列表撑大
const TX_STATEMENTS_KEEP = 500
// 状态查询返回给前端的清单条数上限（IPC 负载口径）
const TX_STATEMENTS_VIEW = 200

function countPinnedTabs () {
  return Object.values(instances).filter(i => i && i.pinned).length
}

// 变更清单里非 executeSql 的 op 用可读摘要（库名/表名），executeSql 用原文（截断）
function txStatementText (op, args) {
  const a = args || {}
  if (op === 'executeSql') {
    const s = String(a.sql || '')
    return s.length > 500 ? s.slice(0, 500) + '…' : s
  }
  const target = [a.database, a.schema, a.table].filter(Boolean).join('.')
  return target ? `${op} ${target}` : op
}

function txAffected (res) {
  const pick = o => {
    if (!o || typeof o !== 'object') {
      return undefined
    }
    const n = o.affectedRows !== undefined
      ? o.affectedRows
      : o.affected !== undefined
        ? o.affected
        : o.rowCount
    return typeof n === 'number' ? n : undefined
  }
  const direct = pick(res)
  if (direct !== undefined) {
    return direct
  }
  // executeSql 的影响行数在 results[0]（单语句场景，多条语句时取首条）
  if (res && Array.isArray(res.results)) {
    return pick(res.results[0])
  }
  return undefined
}

function recordTxStatement (pinned, st) {
  pinned.total += 1
  pinned.statements.push(st)
  if (pinned.statements.length > TX_STATEMENTS_KEEP) {
    pinned.statements.splice(0, pinned.statements.length - TX_STATEMENTS_KEEP)
  }
}

// 摸活：begin 与每次事务内 op 完成都重置空闲回滚计时
function armTxIdleTimer (inst) {
  const pinned = inst.pinned
  if (!pinned) {
    return
  }
  if (pinned.idleTimer) {
    clearTimeout(pinned.idleTimer)
  }
  pinned.idleTimer = setTimeout(() => {
    // 主动回滚并通知：前端轮询 getDbTxState 时经 lastTx(auto=true) 感知
    forceEndTx(inst, 'idle', true).catch(() => {})
  }, TX_IDLE_MS)
  // 主进程常驻无妨，但别让单测进程被这个 10 分钟 timer 挂着
  if (typeof pinned.idleTimer.unref === 'function') {
    pinned.idleTimer.unref()
  }
}

// 强制收口（空闲超时/关 tab/切只读）：先摘除 pinned（新 op 不再入队、走共享连接），
// 回滚排进既有 op 队列末尾 —— 已入队语句先在事务里跑完，再整体回滚，不会漏滚。
// 等回滚真正结束才返回，closeDbTab 才能保证"先回滚后释放连接"。
async function forceEndTx (inst, reason, auto) {
  const pinned = inst.pinned
  if (!pinned) {
    return null
  }
  pinned.closing = true
  inst.pinned = null
  if (pinned.idleTimer) {
    clearTimeout(pinned.idleTimer)
  }
  const summary = {
    reason,
    auto: !!auto,
    at: Date.now(),
    count: pinned.total
  }
  const adapter = getAdapter(inst.dbType)
  const run = () => adapter.rollbackTx(pinned.client)
  try {
    await pinned.queue.then(run, run)
  } catch (e) {
    // rollbackTx 内部已兜底（失败销毁连接），这里只防队列拒绝穿透
  }
  inst.lastTx = summary
  return summary
}

async function beginDbTx (tabId) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  if (inst.pinned) {
    throw new Error('transaction already active on this tab')
  }
  const adapter = getAdapter(inst.dbType)
  if (typeof adapter.beginTx !== 'function') {
    throw new Error(`transactions not supported for ${inst.dbType}`)
  }
  if (countPinnedTabs() >= TX_MAX_TABS) {
    throw new Error(`manual transaction limit reached (max ${TX_MAX_TABS})`)
  }
  // 建连阶段超时同样按断连自愈口径销毁池（与 openDbTab 一致）
  const evictOnTimeout = () => {
    if (typeof adapter.evict === 'function') {
      adapter.evict(inst.conn)
    }
  }
  const client = await withTimeout(
    adapter.beginTx(inst.conn), OVERALL_TIMEOUT, 'connection', evictOnTimeout
  )
  const pinned = {
    client,
    since: Date.now(),
    lastActiveAt: Date.now(),
    statements: [],
    total: 0,
    queue: Promise.resolve(),
    idleTimer: null
  }
  inst.pinned = pinned
  armTxIdleTimer(inst)
  return { ok: true, since: pinned.since }
}

async function commitDbTx (tabId) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  const pinned = inst.pinned
  if (!pinned) {
    throw new Error('no active transaction on this tab')
  }
  const adapter = getAdapter(inst.dbType)
  // 保留 pinned（标 closing）直到提交结束：期间新 op 会被 dbClientOp 拒绝，
  // 不会跑去共享连接读到未提交的快照
  pinned.closing = true
  if (pinned.idleTimer) {
    clearTimeout(pinned.idleTimer)
  }
  // 提交排在既有 op 队列末尾：队列中语句先在事务里跑完，再整体提交
  const run = () => adapter.commitTx(pinned.client)
  try {
    await pinned.queue.then(run, run)
  } catch (e) {
    if (inst.pinned === pinned) {
      inst.pinned = null
    }
    inst.lastTx = {
      reason: 'commit',
      auto: false,
      at: Date.now(),
      count: pinned.total,
      error: e && e.message ? e.message : String(e)
    }
    throw e
  }
  if (inst.pinned === pinned) {
    inst.pinned = null
  }
  const summary = { reason: 'commit', auto: false, at: Date.now(), count: pinned.total }
  inst.lastTx = summary
  return { ok: true, ...summary, statements: pinned.statements }
}

async function rollbackDbTx (tabId) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  const pinned = inst.pinned
  if (!pinned) {
    throw new Error('no active transaction on this tab')
  }
  const adapter = getAdapter(inst.dbType)
  pinned.closing = true
  if (pinned.idleTimer) {
    clearTimeout(pinned.idleTimer)
  }
  // 回滚排在既有 op 队列末尾（与 forceEndTx 同序），失败由 rollbackTx 内部兜底不上抛
  await pinned.queue.then(
    () => adapter.rollbackTx(pinned.client),
    () => adapter.rollbackTx(pinned.client)
  )
  if (inst.pinned === pinned) {
    inst.pinned = null
  }
  const summary = { reason: 'rollback', auto: false, at: Date.now(), count: pinned.total }
  inst.lastTx = summary
  return { ok: true, ...summary, statements: pinned.statements }
}

// 渲染层轮询的事务状态（只读快照，不产生副作用）；
// pinnedTabs 为全局计数，前端据此在达到上限时禁用「开启手动事务」开关
function getDbTxState (tabId) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    return {
      supported: false,
      active: false,
      statements: [],
      pendingCount: 0,
      pinnedTabs: 0,
      maxTabs: TX_MAX_TABS,
      lastTx: null
    }
  }
  const pinned = inst.pinned
  return {
    supported: typeof getAdapter(inst.dbType).beginTx === 'function',
    active: !!pinned,
    since: pinned ? pinned.since : undefined,
    idleMs: pinned ? Date.now() - pinned.lastActiveAt : undefined,
    statements: pinned ? pinned.statements.slice(-TX_STATEMENTS_VIEW) : [],
    pendingCount: pinned ? pinned.total : 0,
    pinnedTabs: countPinnedTabs(),
    maxTabs: TX_MAX_TABS,
    lastTx: inst.lastTx || null
  }
}

// ---------------------------------------------------------------- C 批：tab 上下文
// 流式导出（db-exporter）与 CSV 导入（db-importer）需要绕过 op 分发表直接调
// 适配器方法（insertRows / 循环 getPageData）。上下文一律从本模块取：
// - readOnly 以主进程实例为权威（与 dbClientOp 的 safeArgs 注入同源），
//   渲染层伪造 readOnly:false 到不了写入口
// - adapter 是适配器模块本体：调用方只能调它的方法，连接生命周期（release/close）
//   仍归 db-client 管理，调用方不得触碰
function getDbTabContext (tabId) {
  const inst = instances[tabId]
  if (!inst || inst.pending) {
    throw new Error('database tab not open')
  }
  // F2：导入/导出绕过 op 分发表直接调适配器，拿到的 conn 不走事务连接，
  // 既读不到未提交数据、insertRows 的 START TRANSACTION 还会把外层事务隐式提交
  if (inst.pinned) {
    throw new Error('import/export is not available inside a manual transaction (commit or rollback first)')
  }
  return {
    dbType: inst.dbType,
    adapter: getAdapter(inst.dbType),
    conn: inst.conn,
    readOnly: inst.readOnly
  }
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
  // F2：关 tab 先强制回滚再释放（禁止静默提交）——release 归还的是池连接，
  // 不回滚会把未提交变更留在会话里直到连接被复用
  if (inst.pinned) {
    await forceEndTx(inst, 'close', true)
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
  // F2 事务安全带：渲染层经 dbClientOp 调用，同时导出便于单测直接驱动
  beginDbTx,
  commitDbTx,
  rollbackDbTx,
  getDbTxState,
  getDbTabContext,
  closeDbTab,
  closeAllDbTabs
}
