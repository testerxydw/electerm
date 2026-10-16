const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// P4 连接生命周期 + open/close 竞态滞留修复（2026-10-16）回归单测。
// 真实源码 + vm 跑（require 打桩），不依赖 electron/真实驱动：
//  - 常规 open→close acquire/release 对称
//  - open 进行中 close（acquire 挂起）→ 中止且对称释放（竞态滞留修复点）
//  - pending 期间 dbClientOp/setDbReadOnly 按未打开处理
//  - getMetadata 失败 → 上抛且对称释放
//  - 同 id 重开 → 先释放旧连接

function makeAdapter () {
  const calls = { acquire: 0, release: 0, metadata: 0 }
  let gate = null
  let hanging = false
  let metadataError = null
  return {
    calls,
    hang () { hanging = true },
    gated () { return hanging && !!gate },
    unhang () { if (gate) { const g = gate; gate = null; g() } hanging = false },
    failMetadata (err) { metadataError = err },
    async acquire () {
      calls.acquire++
      if (hanging) {
        await new Promise(resolve => { gate = resolve })
      }
    },
    async getMetadata () {
      calls.metadata++
      if (metadataError) {
        throw metadataError
      }
    },
    async release () {
      calls.release++
    }
  }
}

// 真实源码 + 打桩 require（../db-tunnel、log、./redis 适配器）
function loadDbClient (adapter) {
  const src = fs.readFileSync(JS, 'utf8')
  const stubs = {
    '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
    '../../common/log': { debug () {}, info () {}, error () {} },
    './redis': adapter,
    './mysql': { closeMysqlConnection: async () => {} },
    './postgres': { closePostgresConnection: async () => {} }
  }
  const fakeRequire = spec => {
    assert.ok(stubs[spec], 'unexpected require: ' + spec)
    return stubs[spec]
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: fakeRequire,
    console,
    setTimeout,
    clearTimeout,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'db-client/index.js' })
  return mod.exports
}

const bookmark = (id = 't1') => ({
  id,
  dbType: 'redis',
  dbHost: '127.0.0.1',
  dbPort: 6399,
  name: 'repro'
})

// 等 openDbTab 走到 acquire 的挂起点（异步推进，避免睡死等）
async function waitUntil (fn, ms = 1000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) {
      throw new Error('timeout waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('db-client lifecycle (real source via vm)', () => {
  test('normal open→close: acquire/release symmetric', async () => {
    const adapter = makeAdapter()
    const { openDbTab, closeDbTab } = loadDbClient(adapter)
    // vm 跨 realm 对象原型不同，不能用 deepEqual 比对
    const res = await openDbTab(bookmark(), null)
    assert.ok(res && res.ok === true)
    assert.equal(adapter.calls.acquire, 1)
    await closeDbTab(bookmark().id)
    assert.equal(adapter.calls.release, 1)
  })

  test('close while opening (acquire gated): aborted + symmetric release', async () => {
    const adapter = makeAdapter()
    const { openDbTab, closeDbTab } = loadDbClient(adapter)
    adapter.hang()
    const openP = openDbTab(bookmark('t2'), null)
    await waitUntil(() => adapter.gated())
    // 竞态：open 未完成时 close（修复前此处 no-op → 连接滞留）
    await closeDbTab('t2')
    adapter.unhang()
    await assert.rejects(openP, /db tab closed while opening/)
    assert.equal(adapter.calls.acquire, 1)
    assert.equal(adapter.calls.release, 1, 'release must be symmetric (no leak)')
  })

  test('ops during pending placeholder report "not open"', async () => {
    const adapter = makeAdapter()
    const { openDbTab, closeDbTab, dbClientOp, setDbReadOnly } = loadDbClient(adapter)
    adapter.hang()
    const openP = openDbTab(bookmark('t3'), null)
    await waitUntil(() => adapter.gated())
    await assert.rejects(dbClientOp('t3', 'getPageData', {}), /database tab not open/)
    await assert.rejects(setDbReadOnly('t3', false), /database tab not open/)
    await closeDbTab('t3')
    adapter.unhang()
    await openP.catch(() => {})
  })

  test('getMetadata failure: open rejects and release is symmetric', async () => {
    const adapter = makeAdapter()
    const { openDbTab } = loadDbClient(adapter)
    adapter.failMetadata(new Error('meta boom'))
    await assert.rejects(openDbTab(bookmark('t4'), null), /meta boom/)
    assert.equal(adapter.calls.acquire, 1)
    assert.equal(adapter.calls.release, 1)
  })

  test('same id re-open releases the old connection first', async () => {
    const adapter = makeAdapter()
    const { openDbTab, closeDbTab } = loadDbClient(adapter)
    await openDbTab(bookmark('t5'), null)
    await openDbTab(bookmark('t5'), null)
    assert.equal(adapter.calls.release, adapter.calls.acquire - 1, 'old connection released on re-open')
    await closeDbTab('t5')
    assert.equal(adapter.calls.release, adapter.calls.acquire, 'final close balances')
  })
})
