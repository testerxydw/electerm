#!/usr/bin/env node
/**
 * T9 真实数据库 E2E 冒烟（手动触发，不进入 test-unit-ci）
 *
 * 用法：
 *   docker compose -f src/test/e2e-db/docker-compose.yml up -d
 *   npm run test-db-e2e
 *
 * 只跑部分引擎：DB_E2E_ONLY=mysql,redis npm run test-db-e2e
 * 连接参数可用环境变量覆盖：
 *   DB_E2E_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE
 *   DB_E2E_PG_HOST/PORT/USER/PASSWORD/DATABASE
 *   DB_E2E_REDIS_HOST/PORT
 *
 * 每个引擎独立连接；端口不可达时标记 skipped 而不是失败（方便本地无服务时跑）。
 * 适配器经 vm 加载并注入 log 桩，避免依赖 electron 运行时。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const DB_CLIENT = path.join(ROOT, 'src/app/lib/db-client')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
const SKIP_RE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect timeout|timeout|Connection is closed/i

function loadAdapter (name, stubs) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (stubs[spec]) {
        return stubs[spec]
      }
      return require(spec)
    },
    console,
    Promise,
    setTimeout,
    clearTimeout,
    Buffer,
    Date,
    Map,
    Set
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync(path.join(DB_CLIENT, name + '.js'), 'utf8'),
    sandbox,
    { filename: name + '.js' }
  )
  return mod.exports
}

const loadMysql = () => loadAdapter('mysql', {
  '../../common/log': LOG_STUB,
  'mysql2/promise': require('mysql2/promise')
})
const loadPostgres = () => loadAdapter('postgres', { pg: require('pg') })
const loadRedis = () => loadAdapter('redis', { ioredis: require('ioredis') })

const env = (name, fallback) => process.env[name] || fallback

function engineConfig () {
  return {
    mysql: {
      dbHost: env('DB_E2E_MYSQL_HOST', '127.0.0.1'),
      dbPort: Number(env('DB_E2E_MYSQL_PORT', 3306)),
      dbUser: env('DB_E2E_MYSQL_USER', 'root'),
      dbPassword: env('DB_E2E_MYSQL_PASSWORD', 'electerm'),
      dbName: env('DB_E2E_MYSQL_DATABASE', 'electerm_test')
    },
    postgres: {
      dbHost: env('DB_E2E_PG_HOST', '127.0.0.1'),
      dbPort: Number(env('DB_E2E_PG_PORT', 5432)),
      dbUser: env('DB_E2E_PG_USER', 'postgres'),
      dbPassword: env('DB_E2E_PG_PASSWORD', 'electerm'),
      dbName: env('DB_E2E_PG_DATABASE', 'electerm_test')
    },
    redis: {
      dbHost: env('DB_E2E_REDIS_HOST', '127.0.0.1'),
      dbPort: Number(env('DB_E2E_REDIS_PORT', 6379))
    }
  }
}

const logStep = msg => console.log('  ✓ ' + msg)

async function runMysql (conn) {
  const mod = loadMysql()
  const table = 'electerm_e2e'
  await mod.acquire(conn)
  try {
    const meta = await mod.getMetadata(conn)
    assert.ok(meta.some(d => d.name === conn.dbName), 'metadata should list target database')
    logStep('metadata')

    await mod.executeSql(conn, {
      sql: `DROP TABLE IF EXISTS \`${table}\`; ` +
        `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, name VARCHAR(64)); ` +
        `INSERT INTO \`${table}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
      readOnly: false
    })
    logStep('create table + seed rows')

    const page1 = await mod.getPageData(conn, {
      database: conn.dbName, table, page: 1, pageSize: 2, orderBy: 'id', order: 'ascend'
    })
    assert.equal(page1.rows.length, 2)
    assert.equal(page1.hasMore, true, 'two of three rows should have more')
    const page2 = await mod.getPageData(conn, {
      database: conn.dbName, table, page: 2, pageSize: 2, orderBy: 'id', order: 'ascend'
    })
    assert.equal(page2.rows.length, 1)
    assert.equal(page2.hasMore, false, 'last partial page must not claim more')
    logStep('pagination + hasMore boundary')

    const desc = await mod.describeTable(conn, { database: conn.dbName, table })
    assert.ok(desc.some(c => String(c.Key).toUpperCase() === 'PRI'), 'primary key detection')
    logStep('describeTable primary key')

    const upd = await mod.updateCell(conn, {
      database: conn.dbName,
      table,
      pkColumn: 'id',
      pkValue: 2,
      column: 'name',
      value: 'updated',
      readOnly: false
    })
    assert.equal(upd.affected, 1)
    const after = await mod.getPageData(conn, {
      database: conn.dbName, table, page: 1, pageSize: 10, orderBy: 'id', order: 'ascend'
    })
    assert.equal(after.rows[1].name, 'updated')
    logStep('parameterized cell update')

    const count = await mod.countRows(conn, { database: conn.dbName, table })
    assert.equal(count.count, 3)
    logStep('exact row count')

    const multi = await mod.executeSql(conn, {
      sql: 'SELECT 1 AS a; SELECT 2 AS b',
      readOnly: true
    })
    assert.equal(multi.results.length, 2, 'multi-statement results')
    logStep('multi-statement SQL')

    await assert.rejects(
      mod.updateCell(conn, {
        database: conn.dbName, table, pkColumn: 'id', pkValue: 2, column: 'name', value: 'x', readOnly: true
      }),
      /read-only mode/
    )
    logStep('read-only guard')
  } finally {
    await mod.executeSql(conn, { sql: `DROP TABLE IF EXISTS \`${table}\``, readOnly: false })
      .catch(() => {})
    await mod.release(conn)
  }
}

async function runPostgres (conn) {
  const mod = loadPostgres()
  const table = 'electerm_e2e'
  await mod.acquire(conn)
  try {
    const meta = await mod.getMetadata(conn)
    const current = meta.find(d => d.name === conn.dbName)
    assert.ok(current, 'metadata should list current database')
    assert.ok(current.children.some(s => s.name === 'public' && s.type === 'schema'), 'public schema node')
    logStep('metadata with schema hierarchy')

    await mod.executeSql(conn, {
      sql: `DROP TABLE IF EXISTS public.${table}; ` +
        `CREATE TABLE public.${table} (id INT PRIMARY KEY, name TEXT); ` +
        `INSERT INTO public.${table} VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
      readOnly: false
    })
    logStep('create table + seed rows')

    const page1 = await mod.getPageData(conn, {
      database: conn.dbName, schema: 'public', table, page: 1, pageSize: 2, orderBy: 'id', order: 'ascend'
    })
    assert.equal(page1.rows.length, 2)
    assert.equal(page1.hasMore, true)
    const page2 = await mod.getPageData(conn, {
      database: conn.dbName, schema: 'public', table, page: 2, pageSize: 2, orderBy: 'id', order: 'ascend'
    })
    assert.equal(page2.rows.length, 1)
    assert.equal(page2.hasMore, false)
    logStep('pagination + schema-qualified query')

    const desc = await mod.describeTable(conn, { schema: 'public', table })
    assert.ok(desc.some(c => c.is_primary_key === true), 'primary key marker')
    logStep('describeTable primary key marker')

    const upd = await mod.updateCell(conn, {
      database: conn.dbName,
      schema: 'public',
      table,
      pkColumn: 'id',
      pkValue: 2,
      column: 'name',
      value: 'updated',
      readOnly: false
    })
    assert.equal(upd.affected, 1)
    const after = await mod.getPageData(conn, {
      database: conn.dbName, schema: 'public', table, page: 1, pageSize: 10, orderBy: 'id', order: 'ascend'
    })
    assert.equal(after.rows[1].name, 'updated')
    logStep('parameterized cell update')

    const count = await mod.countRows(conn, { database: conn.dbName, schema: 'public', table })
    assert.equal(count.count, 3)
    logStep('exact row count')

    const multi = await mod.executeSql(conn, {
      sql: 'SELECT 1 AS a; SELECT 2 AS b',
      readOnly: true
    })
    assert.equal(multi.results.length, 2, 'multi-statement results')
    logStep('multi-statement SQL')
  } finally {
    await mod.executeSql(conn, { sql: `DROP TABLE IF EXISTS public.${table}`, readOnly: false })
      .catch(() => {})
    await mod.release(conn)
  }
}

async function runRedis (conn) {
  const mod = loadRedis()
  const key = 'electerm:e2e:key'
  await mod.acquire(conn)
  try {
    const meta = await mod.getMetadata(conn)
    assert.ok(meta.length >= 16, 'redis db nodes')
    logStep('metadata db nodes')

    await mod.setKey(conn, { dbIndex: 0, key, value: 'v1', readOnly: false })
    const detail = await mod.getKeyDetail(conn, { dbIndex: 0, key })
    assert.equal(detail.type, 'string')
    assert.equal(detail.value, 'v1')
    logStep('setKey + getKeyDetail')

    const page = await mod.getPageData(conn, { dbIndex: 0, match: 'electerm:e2e:*', cursor: '0', pageSize: 100 })
    assert.ok(page.rows.some(r => r.name === key), 'key list should include the seed key')
    logStep('SCAN key list')

    assert.equal(await mod.expireKey(conn, { dbIndex: 0, key, seconds: 60, readOnly: false }), 1)
    assert.equal(await mod.delKey(conn, { dbIndex: 0, key, readOnly: false }), 1)
    logStep('expire + delete')
  } finally {
    await mod.delKey(conn, { dbIndex: 0, key, readOnly: false }).catch(() => {})
    await mod.release(conn)
  }
}

const ENGINES = {
  mysql: runMysql,
  postgres: runPostgres,
  redis: runRedis
}

async function main () {
  const only = env('DB_E2E_ONLY', 'mysql,postgres,redis')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const configs = engineConfig()
  const results = []
  for (const name of only) {
    const run = ENGINES[name]
    if (!run) {
      console.log(`[${name}] unknown engine, skipped`)
      continue
    }
    console.log(`[${name}] ${configs[name].dbHost}:${configs[name].dbPort}`)
    try {
      await run(configs[name])
      results.push({ name, status: 'ok' })
      console.log(`[${name}] OK`)
    } catch (e) {
      if (SKIP_RE.test(String(e && e.message))) {
        results.push({ name, status: 'skipped' })
        console.log(`[${name}] SKIPPED (${e.message})`)
      } else {
        results.push({ name, status: 'failed' })
        console.error(`[${name}] FAILED:`, e && e.stack ? e.stack : e)
      }
    }
  }
  const failed = results.filter(r => r.status === 'failed')
  console.log('summary:', results.map(r => `${r.name}=${r.status}`).join(' '))
  if (failed.length) {
    process.exitCode = 1
  }
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e)
  process.exitCode = 1
})
