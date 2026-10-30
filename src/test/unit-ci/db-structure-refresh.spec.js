/**
 * H4：getTableStructure 的 refresh 旁路 —— 真实源码 vm 跑，假适配器 + 假时钟。
 *
 * 对比弹层要"当下这一版结构"，而结构缓存有 60s TTL。refresh:true 必须跳过
 * 新鲜值直接查库；失败时不能拿旧值兜底（否则会拿过期结构比出假结论），
 * 但旧值仍要留给后续普通读方使用。
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
    Date: { now: () => clock.now }
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(INDEX, 'utf8'), sandbox, { filename: INDEX })
  return mod.exports
}

function makeStructAdapter () {
  const calls = { structure: 0 }
  const st = { fail: false, delay: 0 }
  return {
    calls,
    st,
    async acquire () {},
    async release () {},
    async getMetadata () {},
    async getTableStructure (conn, args) {
      calls.structure++
      if (st.delay) {
        await new Promise(resolve => setTimeout(resolve, st.delay))
      }
      if (st.fail) {
        throw new Error('struct boom')
      }
      return { columns: [{ name: 'c' + calls.structure, type: 'int' }], args }
    },
    async closeMysqlConnection () {}
  }
}

async function openStructTab (adapter, clock) {
  const mod = loadDbClient(adapter, clock)
  await mod.openDbTab({
    id: 'r1',
    dbType: 'mysql',
    dbHost: '127.0.0.1',
    dbPort: 3306,
    name: 'refresh'
  }, null)
  return mod
}

describe('getTableStructure refresh', () => {
  test('TTL 内 refresh 跳过缓存，并把新结果写回缓存', async () => {
    const clock = { now: 1000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock)
    const args = { database: 'd', table: 't1' }
    const r1 = await mod.dbClientOp('r1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 1)

    const r2 = await mod.dbClientOp('r1', 'getTableStructure', { ...args, refresh: true })
    assert.equal(adapter.calls.structure, 2, 'refresh must hit the adapter inside TTL')
    assert.notEqual(r2, r1, 'refresh returns the freshly fetched structure')

    // 刷新后的值顶替缓存：紧接着的普通读不再查库
    const r3 = await mod.dbClientOp('r1', 'getTableStructure', args)
    assert.equal(adapter.calls.structure, 2)
    assert.equal(r3, r2)
  })

  test('refresh 失败直接抛错，不拿旧值兜底；旧值仍留给普通读', async () => {
    const clock = { now: 2000000 }
    const adapter = makeStructAdapter()
    const mod = await openStructTab(adapter, clock)
    const args = { database: 'd', table: 't2' }
    const r1 = await mod.dbClientOp('r1', 'getTableStructure', args)
    clock.now += 61000
    adapter.st.fail = true
    await assert.rejects(
      mod.dbClientOp('r1', 'getTableStructure', { ...args, refresh: true }),
      /struct boom/,
      'refresh must not silently serve a stale structure'
    )
    // 普通读的兜底语义保持不变：查询仍失败时返回上一次成功的那份
    const r2 = await mod.dbClientOp('r1', 'getTableStructure', args)
    assert.equal(r2, r1, 'stale fallback still applies to non-refresh reads')
  })

  test('同键并发 refresh 合并成一次查询', async () => {
    const clock = { now: 3000000 }
    const adapter = makeStructAdapter()
    adapter.st.delay = 20
    const mod = await openStructTab(adapter, clock)
    const args = { database: 'd', table: 't3', refresh: true }
    const [a, b] = await Promise.all([
      mod.dbClientOp('r1', 'getTableStructure', args),
      mod.dbClientOp('r1', 'getTableStructure', args)
    ])
    assert.equal(adapter.calls.structure, 1, 'inflight dedupe still applies to refresh')
    assert.equal(a, b)
  })
})
