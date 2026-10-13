/**
 * database client factory
 * - testDbConnection: one-off connection test (phase1)
 * - openDbTab / dbClientOp: per-tab persistent client + op dispatch (phase2)
 * Drivers are lazy loaded inside each adapter.
 */

const { createDbTunnel } = require('../db-tunnel')
const log = require('../common/log')

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
  return withTimeout(adapter[method](inst.conn, args), OVERALL_TIMEOUT)
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
  closeDbTab,
  closeAllDbTabs
}
