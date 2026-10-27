// MySQL 空闲断连自愈回归（方案 1/2/3）：
//  - 池配置：idleTimeout 60s / keepAliveInitialDelay 30s（防服务端静默断连滞留死连接）
//  - db op 超时：错误消息带 [ETIMEDOUT]（前端 CONN_ERR_RE 识别断连 → 顶栏状态实时降级）
//  - 超时触发 adapter.evict（销毁该签名池，下次操作自动重建 → 无需手动关 tab 重开）
//  - 正常完成不触发 evict（不能把慢查询误判成断连）
// 真实源码 + vm 跑 + node:test mock.timers 虚拟时钟（不真等超时）
const { describe, test, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')

function makeAdapter () {
  return {
    acquire () {},
    getMetadata () {},
    release () {},
    evict () {},
    // hang op：返回永不 settle 的 promise，只靠超时 reject
    executeSql () { return new Promise(() => {}) },
    describeTable () { return new Promise(() => {}) }
  }
}

function loadDbClient (adapter) {
  const src = fs.readFileSync(JS, 'utf8')
  const stubs = {
    '../db-tunnel': { createDbTunnel () { throw new Error('no tunnel in test') } },
    '../../common/log': { debug () {}, info () {}, warn () {}, error () {} },
    './redis': adapter,
    './mysql': adapter,
    './postgres': adapter
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'db-client/index.js' })
  return mod.exports
}

const bookmark = (id = 't1') => ({
  id,
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  name: 'repro'
})

// 先建 rejects 断言（pending），再 tick 虚拟时钟驱动超时，最后 await 断言
async function assertTimeoutAt (p, tickSeq, msgRe) {
  const guard = assert.rejects(p, msgRe)
  for (const t of tickSeq) {
    mock.timers.tick(t)
  }
  await guard
}

describe('db-client op timeout 自愈 (idle evict + ETIMEDOUT)', () => {
  test('超时错误消息带 [ETIMEDOUT]（前端 CONN_ERR_RE 可识别）', async () => {
    const adapter = makeAdapter()
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'describeTable', {}),
        [14999, 1],
        /\[ETIMEDOUT\]/
      )
    } finally {
      mock.timers.reset()
    }
  })

  test('db op 超时触发 adapter.evict（销毁死池自愈）', async () => {
    const adapter = makeAdapter()
    let evicted = 0
    adapter.evict = () => { evicted++ }
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'executeSql', { sql: 'select 1' }),
        [120000],
        /timeout/
      )
      assert.equal(evicted, 1, 'executeSql 超时应触发 evict 一次')
    } finally {
      mock.timers.reset()
    }
  })

  test('正常完成不触发 evict（慢查询不能被误判成断连）', async () => {
    const adapter = makeAdapter()
    let evicted = 0
    adapter.evict = () => { evicted++ }
    adapter.executeSql = async () => ({ rows: [] })
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      const res = await dbClientOp('t1', 'executeSql', { sql: 'select 1' })
      assert.deepEqual(res, { rows: [] })
      assert.equal(evicted, 0, '正常完成不得触发 evict')
      // 再 tick 满 executeSql 的超时窗口，确认定时器已清理、不触发 evict
      mock.timers.tick(120000)
      assert.equal(evicted, 0)
    } finally {
      mock.timers.reset()
    }
  })

  test('mysql.js 池配置含 idleTimeout 60s 与 keepAliveInitialDelay 30s', () => {
    const src = fs.readFileSync(MYSQL_JS, 'utf8')
    assert.match(src, /idleTimeout: 60000/)
    assert.match(src, /keepAliveInitialDelay: 30000/)
    assert.match(src, /module\.exports[\s\S]*evict,/)
  })

  test('无 evict 的适配器（postgres/redis 单连接）超时不抛错', async () => {
    const adapter = makeAdapter()
    delete adapter.evict
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'describeTable', {}),
        [14999, 1],
        /\[ETIMEDOUT\]/
      )
    } finally {
      mock.timers.reset()
    }
  })
})
