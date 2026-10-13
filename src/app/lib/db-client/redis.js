/**
 * redis connection tester (lazy loaded driver)
 */

async function testRedisConnection ({ dbHost, dbPort, dbPassword }) {
  const Redis = require('ioredis')
  const redis = new Redis({
    host: dbHost,
    port: dbPort,
    password: dbPassword || undefined,
    connectTimeout: 8000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
    enableOfflineQueue: false
  })
  redis.on('error', () => {})
  try {
    await redis.connect()
    const res = await redis.ping()
    return `redis ${res}`
  } finally {
    redis.disconnect()
  }
}

module.exports = {
  testRedisConnection
}
