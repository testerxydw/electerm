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
    executeSql: 'executeSql'
  },
  postgres: {
    getMetadata: 'getMetadata',
    getPageData: 'getPageData',
    describeTable: 'describeTable',
    executeSql: 'executeSql'
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

const OVERALL_TIMEOUT = 15000

function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('connection timeout')), ms)
    })
  ])
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
  const inst = await buildConn(dbBookmark, sshBookmark)
  try {
    // acquire: 建立真实连接并验证（失败上抛，tab 打开即暴露连接问题）
    await withTimeout(adapter.acquire(inst.conn), OVERALL_TIMEOUT)
    // open metadata eagerly to surface metadata errors at tab open
    await withTimeout(adapter.getMetadata(inst.conn), OVERALL_TIMEOUT)
  } catch (e) {
    // 打开失败：释放已建立连接与隧道，防泄漏
    try {
      await adapter.release(inst.conn)
    } catch (e2) {
      // ignore
    }
    if (inst.tunnel) {
      inst.tunnel.close()
    }
    throw e
  }
  instances[dbBookmark.id] = inst
  return { ok: true }
}

async function dbClientOp (tabId, op, args) {
  const inst = instances[tabId]
  if (!inst) {
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
  return withTimeout(adapter[method](inst.conn, safeArgs), OVERALL_TIMEOUT)
}

// 页面上切换只读模式：白名单以主进程实例为权威（渲染层传参不可信），
// 故前端改开关必须同步到这里，否则开关只是"看起来变了"而写操作仍被拦/仍放行
async function setDbReadOnly (tabId, readOnly) {
  const inst = instances[tabId]
  if (!inst) {
    throw new Error('database tab not open')
  }
  inst.readOnly = readOnly !== false
  return { ok: true }
}

async function closeDbTab (tabId) {
  const inst = instances[tabId]
  if (!inst) {
    return
  }
  delete instances[tabId]
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
