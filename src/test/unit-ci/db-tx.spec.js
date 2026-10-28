// F2 事务安全带（设计 §13）：连接钉住 + 待提交清单 + 强制收口
//  - begin→op→commit / rollback / close / idle 五条生命周期路径
//  - pinned 期间 op 走事务连接且串行；第 3 个 tab 开启被拒
//  - 切只读先回滚；提交在途拒绝新 op；批量改值/导入在事务内被拒
// 真实源码 + vm 打桩适配器，不打真库、用可控时钟驱动空闲回滚
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { setTimeout: delay } = require('node:timers/promises')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

const plain = v => JSON.parse(JSON.stringify(v))

// 可控时钟：setTimeout 只登记不触发，测试里 fireAll() 手动触发（模拟 10 分钟空闲）
function makeClock () {
  let seq = 0
  const timers = new Map()
  return {
    setTimeout (fn) {
      const id = ++seq
      timers.set(id, fn)
      return { id, unref () {} }
    },
    clearTimeout (h) {
      if (h && h.id) {
        timers.delete(h.id)
      }
    },
    pending () {
      return timers.size
    },
    fireAll () {
      const fns = [...timers.values()]
      timers.clear()
      fns.forEach(fn => fn())
    }
  }
}

function makeAdapter (opts = {}) {
  const calls = {
    acquire: 0,
    release: 0,
    metadata: 0,
    beginTx: 0,
    commitTx: 0,
    rollbackTx: 0,
    ops: [],
    order: []
  }
  let gate = null
  let gated = false
  let commitGate = null
  const adapter = {
    calls,
    async acquire () { calls.acquire++ },
    async release () {
      calls.release++
      calls.order.push('release')
    },
    async getMetadata () { calls.metadata++; return [] },
    async listColumns () { return { tables: [] } },
    async beginTx () {
      calls.beginTx++
      return { txId: calls.beginTx }
    },
    async commitTx () {
      calls.commitTx++
      if (commitGate) {
        await commitGate
      }
      calls.order.push('commit')
    },
    async rollbackTx () {
      calls.rollbackTx++
      calls.order.push('rollback')
    },
    async getPageData (conn) {
      calls.ops.push({ op: 'getPageData', tx: !!(conn && conn.__txClient) })
      if (gated) {
        await new Promise(resolve => { gate = resolve })
      }
      return { rows: [], total: 0 }
    },
    async executeSql (conn, args) {
      calls.ops.push({ op: 'executeSql', tx: !!(conn && conn.__txClient), sql: args.sql })
      return { results: [{ affected: 2 }] }
    },
    async updateCells (conn) {
      calls.ops.push({ op: 'updateCells', tx: !!(conn && conn.__txClient) })
      return { affected: 1, failed: [] }
    },
    // 测试专用闸门控制
    gateOps (on) { gated = on; return () => { if (gate) { const g = gate; gate = null; g() } } },
    gateCommit () {
      return new Promise(resolve => { commitGate = resolve })
    },
    releaseCommit () { if (commitGate) { const g = commitGate; commitGate = null; g() } }
  }
  if (opts.noTx) {
    delete adapter.beginTx
    delete adapter.commitTx
    delete adapter.rollbackTx
  }
  return adapter
}

function loadDbClient (adapter, clock = makeClock()) {
  const stubs = {
    '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
    '../../common/log': { debug () {}, info () {}, error () {}, warn () {} },
    './mysql': adapter,
    './postgres': adapter,
    './redis': adapter
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    Promise
  }
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(JS, 'utf8'), sandbox, { filename: 'db-client/index.js' })
  return { mod: sandbox.module.exports, clock }
}

const bookmark = (id, dbType = 'mysql') => ({
  id,
  dbType,
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'u',
  dbName: 'db',
  dbPassword: 'p',
  name: id
})

async function openTabs (mod, ids, dbType) {
  for (const id of ids) {
    await mod.openDbTab(bookmark(id, dbType), null)
  }
}

describe('F2 事务：生命周期五条路径', () => {
  test('begin→op→commit：op 走事务连接、记清单、提交后状态清空', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])

    await mod.dbClientOp('t1', 'beginDbTx')
    assert.equal(adapter.calls.beginTx, 1)

    await mod.dbClientOp('t1', 'executeSql', { sql: 'update t set a = 1' })
    assert.equal(adapter.calls.ops[0].tx, true, 'op must run on pinned connection')

    const st = plain(mod.getDbTxState('t1'))
    assert.equal(st.active, true)
    assert.equal(st.pendingCount, 1)
    assert.equal(st.statements.length, 1)
    assert.equal(st.statements[0].sql, 'update t set a = 1')
    assert.equal(st.statements[0].affectedRows, 2)
    assert.equal(st.supported, true)
    assert.equal(st.maxTabs, 2)

    const res = plain(await mod.dbClientOp('t1', 'commitDbTx'))
    assert.equal(res.ok, true)
    assert.equal(res.count, 1)
    assert.equal(adapter.calls.commitTx, 1)

    const after = plain(mod.getDbTxState('t1'))
    assert.equal(after.active, false)
    assert.equal(after.pendingCount, 0)
    assert.equal(after.lastTx.reason, 'commit')
    await mod.closeDbTab('t1')
  })

  test('rollback：语句回滚后清空，返回清单', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await mod.dbClientOp('t1', 'getPageData', { table: 't', database: 'db' })
    const res = plain(await mod.dbClientOp('t1', 'rollbackDbTx'))
    assert.equal(adapter.calls.rollbackTx, 1)
    assert.equal(res.reason, 'rollback')
    assert.equal(res.statements.length, 1)
    assert.equal(res.statements[0].sql, 'getPageData db.t')
    assert.equal(plain(mod.getDbTxState('t1')).active, false)
    await mod.closeDbTab('t1')
  })

  test('closeDbTab：先回滚再释放（禁止静默提交）', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await mod.dbClientOp('t1', 'executeSql', { sql: 'delete from t' })
    await mod.closeDbTab('t1')
    assert.equal(adapter.calls.rollbackTx, 1, 'close must roll back')
    assert.deepEqual(adapter.calls.order, ['rollback', 'release'], 'rollback before release')
  })

  test('空闲 10 分钟自动回滚（假时钟）', async () => {
    const adapter = makeAdapter()
    const { mod, clock } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    assert.equal(clock.pending(), 1, 'idle timer armed on begin')

    clock.fireAll()
    for (let i = 0; i < 20 && adapter.calls.rollbackTx === 0; i++) {
      await delay(5)
    }
    assert.equal(adapter.calls.rollbackTx, 1)
    const st = plain(mod.getDbTxState('t1'))
    assert.equal(st.active, false)
    assert.equal(st.lastTx.reason, 'idle')
    assert.equal(st.lastTx.auto, true)
    await mod.closeDbTab('t1')
    assert.equal(adapter.calls.rollbackTx, 1, 'close after auto rollback must not roll back twice')
  })

  test('事务内 op 串行：前一条未完成时后一条不开始', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')

    const open = adapter.gateOps(true)
    const p1 = mod.dbClientOp('t1', 'getPageData', { table: 't' })
    const p2 = mod.dbClientOp('t1', 'getPageData', { table: 't' })
    await delay(20)
    assert.equal(adapter.calls.ops.length, 1, 'second op must wait for the first')
    adapter.gateOps(false)
    open()
    await Promise.all([p1, p2])
    assert.equal(adapter.calls.ops.length, 2)
    await mod.dbClientOp('t1', 'rollbackDbTx')
    await mod.closeDbTab('t1')
  })
})

describe('F2 事务：连接与边界', () => {
  test('第 3 个 tab 开启手动事务被拒（上限 2）', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1', 't2', 't3'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await mod.dbClientOp('t2', 'beginDbTx')
    await assert.rejects(
      mod.dbClientOp('t3', 'beginDbTx'),
      /manual transaction limit reached \(max 2\)/
    )
    assert.equal(plain(mod.getDbTxState('t3')).pinnedTabs, 2)
    await mod.closeDbTab('t1')
    await mod.closeDbTab('t2')
    await mod.closeDbTab('t3')
  })

  test('切只读前先回滚未提交事务', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await mod.dbClientOp('t1', 'executeSql', { sql: 'update t set a = 1' })
    await mod.setDbReadOnly('t1', true)
    assert.equal(adapter.calls.rollbackTx, 1)
    assert.equal(plain(mod.getDbTxState('t1')).active, false)
    await mod.closeDbTab('t1')
  })

  test('提交在途拒绝新 op（避免读取未提交快照）', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await mod.dbClientOp('t1', 'executeSql', { sql: 'update t set a = 1' })

    const commitP = mod.dbClientOp('t1', 'commitDbTx')
    await assert.rejects(
      mod.dbClientOp('t1', 'getPageData', { table: 't' }),
      /transaction is closing/
    )
    adapter.releaseCommit()
    await commitP
    await mod.closeDbTab('t1')
  })

  test('批量改值/导入在手动事务内被拒', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'beginDbTx')
    await assert.rejects(
      mod.dbClientOp('t1', 'updateCells', { table: 't', column: 'c', updates: [] }),
      /not allowed inside a manual transaction/
    )
    assert.throws(() => mod.getDbTabContext('t1'), /import\/export is not available/)
    await mod.closeDbTab('t1')
  })

  test('无事务能力的适配器（redis）不支持手动事务', async () => {
    const adapter = makeAdapter({ noTx: true })
    const { mod } = loadDbClient(adapter)
    await mod.openDbTab(bookmark('r1', 'redis'), null)
    await assert.rejects(mod.dbClientOp('r1', 'beginDbTx'), /transactions not supported/)
    assert.equal(plain(mod.getDbTxState('r1')).supported, false)
    await mod.closeDbTab('r1')
  })

  test('非事务 op 仍走共享连接', async () => {
    const adapter = makeAdapter()
    const { mod } = loadDbClient(adapter)
    await openTabs(mod, ['t1'])
    await mod.dbClientOp('t1', 'getPageData', { table: 't' })
    assert.equal(adapter.calls.ops[0].tx, false)
    await mod.closeDbTab('t1')
  })
})
