/**
 * database client factory
 * - testDbConnection: one-off connection test (phase1)
 * - openDbTab / dbClientOp: per-tab persistent client + op dispatch (phase2)
 * Drivers are lazy loaded inside each adapter.
 */

const { createDbTunnel } = require('../db-tunnel')
const log = require('../common/log')

const testers = {
  mysql: opts => require('./mysql').testMysqlConnection(opts),
  redis: opts => require('./redis').testRedisConnection(opts)
}

// per-tab client instances: { tabId: { dbType, conn, close, tunnel } }
const instances = {}

// ops routed to the driver method for a db type (single method dispatch)
const OP_MAP = {
  mysql: {
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

const OVERALL_TIMEOUT = 15000

function withTimeout (promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('connection timeout')), ms)
    })
  ])
}

function resolvePort (dbBookmark) {
  return dbBookmark.dbPort || (dbBookmark.dbType === 'mysql' ? 3306 : 6379)
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
  const inst = await buildConn(dbBookmark, sshBookmark)
  const opMap = OP_MAP[inst.dbType]
  if (!opMap) {
    if (inst.tunnel) {
      inst.tunnel.close()
    }
    throw new Error(`unsupported db type: ${inst.dbType}`)
  }
  // open metadata eagerly to surface connection errors at tab open
  const adapter = require('./' + inst.dbType)
  await withTimeout(adapter.getMetadata(inst.conn), OVERALL_TIMEOUT)
  instances[dbBookmark.tabId] = inst
  return { ok: true }
}

async function dbClientOp (tabId, op, args) {
  const inst = instances[tabId]
  if (!inst) {
    throw new Error('database tab not open')
  }
  const opMap = OP_MAP[inst.dbType]
  const method = opMap && opMap[op]
  if (!method) {
    throw new Error(`unsupported op for ${inst.dbType}: ${op}`)
  }
  const adapter = require('./' + inst.dbType)
  return withTimeout(adapter[method](inst.conn, args), OVERALL_TIMEOUT)
}

async function closeDbTab (tabId) {
  const inst = instances[tabId]
  if (!inst) {
    return
  }
  delete instances[tabId]
  const closeNames = {
    mysql: 'closeMysqlConnection',
    redis: 'closeRedisConnection'
  }
  const closeName = closeNames[inst.dbType]
  if (closeName) {
    try {
      await require('./' + inst.dbType)[closeName]()
    } catch (e) {
      // ignore close errors
    }
  }
  if (inst.tunnel) {
    inst.tunnel.close()
  }
}

async function closeAllDbTabs () {
  await Promise.all(
    Object.keys(instances).map(id => closeDbTab(id))
  )
}

module.exports = {
  testDbConnection,
  openDbTab,
  dbClientOp,
  closeDbTab,
  closeAllDbTabs
}
