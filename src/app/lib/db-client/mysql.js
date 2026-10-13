/**
 * mysql connection tester (lazy loaded driver)
 */

async function testMysqlConnection ({ dbHost, dbPort, dbUser, dbPassword, dbName }) {
  const mysql = require('mysql2/promise')
  const conn = await mysql.createConnection({
    host: dbHost,
    port: dbPort,
    user: dbUser || 'root',
    password: dbPassword || '',
    database: dbName || undefined,
    connectTimeout: 8000
  })
  try {
    await conn.ping()
    return 'mysql ok'
  } finally {
    await conn.end().catch(() => {})
  }
}

module.exports = {
  testMysqlConnection
}
