/**
 * A：acquire 引用计数回滚 —— 真实适配器源码 vm 跑（假驱动），openDbTab 超时补偿。
 *
 * acquire 在入口就 refs+1，而 openDbTab 只在 acquire 成功后置 acquired 标记、
 * 失败分支不会补 release。acquire 内部失败（ping/SELECT 1 失败、建连失败）必须
 * 自己把这次计数抹掉，归零时连半开 client/pool 一起清掉；acquire 超时后被
 * openDbTab 放弃、但稍后仍然成功的那一次，也要补一次 release。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { describe, test } = require('node:test')

const ROOT = path.join(__dirname, '../../..')
const INDEX = path.join(ROOT, 'src/app/lib/db-client/index.js')
const REDIS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const PG = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const MYSQL = path.join(ROOT, 'src/app/lib/db-client/mysql.js')

const logStub = { debug () {}, warn () {}, info () {}, error () {} }

function loadSource (file, fakeModules, extraSandbox = {}) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: name => {
      if (Object.prototype.hasOwnProperty.call(fakeModules, name)) {
        return fakeModules[name]
      }
      throw new Error('unexpected require: ' + name)
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    ...extraSandbox
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
  return mod.exports
}

const conn = {
  dbHost: 'h', dbPort: 3306, dbUser: 'u', dbName: 'db', dbPassword: 'p'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil (fn, ms = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) {
      throw new Error('timeout waiting for condition')
    }
    await sleep(5)
  }
}

// ---------------------------------------------------------------- redis ----

function loadRedis (state) {
  const made = []
  class Redis {
    constructor (opts) {
      this.opts = opts
      this.disconnected = 0
      this.pings = 0
      made.push(this)
    }

    on () {
      return this
    }

    async connect () {
      if (state.failConnect) {
        throw new Error('connect boom')
      }
    }

    async ping () {
      this.pings++
      if (state.failPing) {
        throw new Error('ping boom')
      }
      return 'PONG'
    }

    disconnect () {
      this.disconnected++
    }
  }
  return { adapter: loadSource(REDIS, { ioredis: Redis }), made }
}

// ------------------------------------------------------------- postgres ----

function loadPg (state) {
  const made = []
  class Client {
    constructor (opts) {
      this.opts = opts
      this.ended = 0
      this.queries = []
      made.push(this)
    }

    async connect () {
      if (state.failConnect) {
        throw new Error('connect boom')
      }
    }

    async query (sql) {
      this.queries.push(sql)
      if (state.failQuery) {
        throw new Error('query boom')
      }
      return { rows: [] }
    }

    async end () {
      this.ended++
    }
  }
  return { adapter: loadSource(PG, { pg: { Client } }), made }
}

// ---------------------------------------------------------------- mysql ----

function loadMysql (state) {
  const made = []
  const mysql2 = {
    createPool () {
      if (state.failCreate) {
        throw new Error('pool boom')
      }
      const pool = {
        ended: 0,
        end () {
          pool.ended++
          return Promise.resolve()
        },
        query: () => Promise.resolve([[], []]),
        execute: () => Promise.resolve([{}, undefined]),
        getConnection: () => Promise.resolve({
          query: () => Promise.resolve([[], []]),
          release () {}
        })
      }
      made.push(pool)
      return pool
    }
  }
  const adapter = loadSource(MYSQL, {
    '../../common/log': logStub,
    'mysql2/promise': mysql2
  })
  return { adapter, made }
}

// --------------------------------------------- index.js（openDbTab 超时） ----

function loadDbClient (adapter, { clampMs } = {}) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: name => {
      const stubs = {
        '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
        '../../common/log': logStub,
        './mysql': adapter,
        './postgres': { closePostgresConnection: async () => {} },
        './redis': { closeRedisConnection: async () => {} }
      }
      if (!stubs[name]) {
        throw new Error('unexpected require: ' + name)
      }
      return stubs[name]
    },
    console,
    // clampMs：把 withTimeout 的 15s 压到几十毫秒，用来跑"acquire 超时后被放弃"的路径
    setTimeout: clampMs ? (fn, ms) => setTimeout(fn, Math.min(ms, clampMs)) : setTimeout,
    clearTimeout,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(INDEX, 'utf8'), sandbox, { filename: INDEX })
  return mod.exports
}

function makeLifecycleAdapter () {
  const calls = { acquire: 0, release: 0, metadata: 0 }
  let gate = null
  let hanging = false
  return {
    calls,
    hang () { hanging = true },
    gated () { return hanging && !!gate },
    unhang () { if (gate) { const g = gate; gate = null; g() } hanging = false },
    async acquire () {
      calls.acquire++
      if (hanging) {
        await new Promise(resolve => { gate = resolve })
      }
    },
    async getMetadata () {
      calls.metadata++
    },
    async release () {
      calls.release++
    },
    async closeMysqlConnection () {}
  }
}

const bookmark = (id, dbType = 'mysql') => ({
  id,
  dbType,
  dbHost: '127.0.0.1',
  dbPort: 3306,
  name: 'repro'
})

describe('acquire refcount rollback: redis', () => {
  test('ping failure rolls back the +1 and closes the half-open client', async () => {
    const state = { failPing: true }
    const { adapter, made } = loadRedis(state)
    await assert.rejects(adapter.acquire(conn), /ping boom/)
    assert.equal(made.length, 1)
    assert.equal(made[0].disconnected, 1, 'failed client must be disconnected')

    state.failPing = false
    const c = await adapter.acquire(conn)
    assert.equal(made.length, 2, 'refs back to 0 → fresh client')
    assert.notEqual(c, made[0])
    await adapter.release(conn)
    assert.equal(made[1].disconnected, 1, 'last release closes the connection')
  })

  test('connect failure closes the client that never made it into the map', async () => {
    const state = { failConnect: true }
    const { adapter, made } = loadRedis(state)
    await assert.rejects(adapter.acquire(conn), /connect boom/)
    assert.equal(made[0].disconnected, 1, 'never-registered client is disconnected')

    state.failConnect = false
    await adapter.acquire(conn)
    assert.equal(made.length, 2)
    await adapter.release(conn)
    assert.equal(made[1].disconnected, 1)
  })
})

describe('acquire refcount rollback: postgres', () => {
  test('SELECT 1 failure rolls back the +1 and ends the client', async () => {
    const state = { failQuery: true }
    const { adapter, made } = loadPg(state)
    await assert.rejects(adapter.acquire(conn), /query boom/)
    assert.equal(made.length, 1)
    assert.equal(made[0].ended, 1, 'half-open client must be ended')

    state.failQuery = false
    const c = await adapter.acquire(conn)
    assert.equal(made.length, 2, 'refs back to 0 → fresh client')
    assert.notEqual(c, made[0])
    await adapter.release(conn)
    assert.equal(made[1].ended, 1)
  })

  test('connect failure ends the client that never made it into the map', async () => {
    const state = { failConnect: true }
    const { adapter, made } = loadPg(state)
    await assert.rejects(adapter.acquire(conn), /connect boom/)
    assert.equal(made[0].ended, 1)

    state.failConnect = false
    await adapter.acquire(conn)
    assert.equal(made.length, 2)
    await adapter.release(conn)
    assert.equal(made[1].ended, 1)
  })
})

describe('acquire refcount rollback: mysql', () => {
  test('pool creation failure rolls back the +1 (pool closes at next release)', async () => {
    const state = { failCreate: true }
    const { adapter, made } = loadMysql(state)
    await assert.rejects(adapter.acquire(conn), /pool boom/)
    assert.equal(made.length, 0)

    state.failCreate = false
    await adapter.acquire(conn)
    assert.equal(made.length, 1)
    await adapter.release(conn)
    assert.equal(made[0].ended, 1, 'refs must be 0 → pool is actually ended')
  })
})

describe('openDbTab: acquire timeout', () => {
  test('acquire that resolves after the timeout still gets a release', async () => {
    const adapter = makeLifecycleAdapter()
    const { openDbTab } = loadDbClient(adapter, { clampMs: 25 })
    adapter.hang()
    const p = openDbTab(bookmark('t-timeout'), null)
    await waitUntil(() => adapter.gated())
    await assert.rejects(p, /connection timeout/)
    // openDbTab 已放弃，但 acquire 稍后成功：必须补一次 release，否则计数永久 +1
    adapter.unhang()
    await waitUntil(() => adapter.calls.release === 1)
    assert.equal(adapter.calls.acquire, 1)
    assert.equal(adapter.calls.release, 1)
  })

  test('acquire rejecting normally does not double-release (adapter already rolled back)', async () => {
    const adapter = makeLifecycleAdapter()
    adapter.acquire = async () => {
      adapter.calls.acquire++
      throw new Error('acquire boom')
    }
    const { openDbTab } = loadDbClient(adapter, { clampMs: 25 })
    await assert.rejects(openDbTab(bookmark('t-fail'), null), /acquire boom/)
    await sleep(60)
    assert.equal(adapter.calls.release, 0, 'rollback lives inside the adapter, not openDbTab')
  })
})
