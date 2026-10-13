/**
 * database client factory
 * testDbConnection({ dbBookmark, sshBookmark? }) -> { ok, message }
 * Drivers are lazy loaded inside each adapter.
 */

const { createDbTunnel } = require('../db-tunnel')
const log = require('../common/log')

const testers = {
  mysql: opts => require('./mysql').testMysqlConnection(opts),
  redis: opts => require('./redis').testRedisConnection(opts)
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

/**
 * @param {Object} dbBookmark - database bookmark { dbType, dbHost, dbPort, dbUser, dbPassword, dbName, sshTunnelBookmarkId }
 * @param {Object} [sshBookmark] - decrypted ssh bookmark used as tunnel
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testDbConnection (dbBookmark, sshBookmark) {
  const dbType = dbBookmark.dbType
  const tester = testers[dbType]
  if (!tester) {
    throw new Error(`unsupported db type: ${dbType}`)
  }
  const useTunnel = !!sshBookmark
  const dbHost = useTunnel ? '127.0.0.1' : (dbBookmark.dbHost || '127.0.0.1')
  const dbPort = useTunnel
    ? null
    : (dbBookmark.dbPort || (dbType === 'mysql' ? 3306 : 6379))
  let tunnel = null
  try {
    if (useTunnel) {
      tunnel = await createDbTunnel(
        sshBookmark,
        dbBookmark.dbHost || '127.0.0.1',
        dbBookmark.dbPort || (dbType === 'mysql' ? 3306 : 6379)
      )
    }
    const msg = await withTimeout(tester({
      ...dbBookmark,
      dbHost,
      dbPort: useTunnel ? tunnel.port : dbPort
    }), OVERALL_TIMEOUT)
    return { ok: true, message: useTunnel ? `${msg} (via ssh tunnel)` : msg }
  } catch (e) {
    log.error('testDbConnection fails', e.message)
    throw e
  } finally {
    if (tunnel) {
      tunnel.close()
    }
  }
}

module.exports = {
  testDbConnection
}
