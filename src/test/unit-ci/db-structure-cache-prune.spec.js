/**
 * B：structureCache 老化 + 容量上限 —— 真实源码 vm 跑，假适配器 + 假时钟。
 *
 * "过期值保留（查失败兜底）"不能变成永久保留：10 分钟未再成功查询的条目
 * 老化丢弃，单 tab 最多 2000 条，超出按最后成功时间淘汰最旧。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { describe, test } = require('node:test')

const ROOT = path.join(__dirname, '../../..')
const INDEX = path.join(ROOT, 'src/app/lib/db-client/index.js')

const logStub = { debug () {}, warn () {}, info () {}, error () {} }

function loadDbClient (adapter, clock) {
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
    setTimeout,
    clearTimeout,
    Promise,
    // 源码只用 Date.now()，可注入的假时钟足以驱动 TTL / 老化判定
    Date: { now: () => clock.now }
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(INDEX, 'utf8'), sandbox, { filename: INDEX })
  return mod.exports
}

const bookmark = (id, dbType = 'mysql') => ({
  id,
  dbType,
  dbHost: '127.0.0.1',
  dbPort: 3306,
  name: 'repro'
})

function makeStructAdapter () {
  const calls = { structure: 0 }
  const st = { fail: false }
  return {
    calls,
    st,
    async acquire () {},
    async release () {},
    async getMetadata () {},
    async getTableStructure () {
      calls.structure++
      if (st.fail) {
        throw new Error('struct boom')
      }
      return { columns: [{ name: 'c' + calls.structure, type: 'int' }] }
    },
    async closeMysqlConnection () {}
  }
}

async function openStructTab (adapter, clock, id = 's1') {
  const mod = loadDbClient(adapter, clock)
  await mod.openDbTab(bookmark(id), null)
  return mod
}

describe('structureCache TTL / stale fallback', () => {
  test('within TTL served from cache, after TTL refetched', async () => {
    const clock = { now: 1000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock)
    const args = { database: 'd', table: 't1' }
    const r1 = await mod.dbClientOp('s1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 1)
    const r2 = await mod.dbClientOp('s1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 1, 'same key within TTL is cached')
    assert.equal(r2, r1, 'cached value is reused')

    clock.now += 61000
    await mod.dbClientOp('s1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 2, 'TTL expiry refetches')
  })

  test('refetch failure after TTL falls back to the last successful value', async () => {
    const clock = { now: 2000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock)
    const args = { database: 'd', table: 't2' }
    const r1 = await mod.dbClientOp('s1', 'getTableStructure', args)
    clock.now += 61000
    adapter.st.fail = true
    const r2 = await mod.dbClientOp('s1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 2)
    assert.equal(r2, r1, 'stale value still served on fetch error')
  })
})

describe('structureCache aging + cap', () => {
  test('entries untouched for STRUCTURE_STALE_MS are pruned on the next write', async () => {
    const clock = { now: 3000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock)
    const oldArgs = { database: 'd', table: 'old' }
    await mod.dbClientOp('s1', 'getTableStructure', oldArgs)
    assert.equal(adapter.calls.structure, 1)

    // 超过老化阈值后另一次成功写入触发清理：old 的旧值不再可用于兜底
    clock.now += 10 * 60 * 1000 + 1000
    await mod.dbClientOp('s1', 'getTableStructure', { database: 'd', table: 'fresh' })
    assert.equal(adapter.calls.structure, 2)

    adapter.st.fail = true
    await assert.rejects(
      mod.dbClientOp('s1', 'getTableStructure', oldArgs),
      /struct boom/,
      'aged-out entry must not resurrect as stale fallback'
    )
    assert.equal(adapter.calls.structure, 3)
  })

  test('cache is capped: oldest entry evicted once above STRUCTURE_CACHE_MAX', async () => {
    const clock = { now: 4000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock, 'cap')
    const MAX = 2000
    for (let i = 0; i <= MAX; i++) {
      await mod.dbClientOp('cap', 'getTableStructure', { database: 'd', table: 'k' + i })
    }
    assert.equal(adapter.calls.structure, MAX + 1)

    clock.now += 1000
    // k0 是最旧的，已被上限淘汰 → 重新查询
    await mod.dbClientOp('cap', 'getTableStructure', { database: 'd', table: 'k0' })
    assert.equal(adapter.calls.structure, MAX + 2, 'oldest entry was evicted')
    // 最近写入的仍在缓存
    await mod.dbClientOp('cap', 'getTableStructure', { database: 'd', table: 'k' + MAX })
    assert.equal(adapter.calls.structure, MAX + 2, 'recent entry still cached')
  })
})
