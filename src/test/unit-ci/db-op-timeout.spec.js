// P2-19 操作级超时回归：dbClientOp 不再统一 15s
// 真实源码 + vm 跑 + node:test mock.timers 虚拟时钟（不真等超时）：
//  - executeSql 120s / getPageData 60s / 其余 op 15s
//  - 错误消息带 op 与秒数（`db op executeSql timeout (120s)`）
//  - 建连类消息区分（connection/metadata label）
const { describe, test, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

function makeAdapter () {
  return {
    acquire () {},
    getMetadata () {},
    release () {},
    // hang op：返回永不 settle 的 promise，只靠超时 reject
    executeSql () { return new Promise(() => {}) },
    getPageData () { return new Promise(() => {}) },
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
    // 运行时解析宿主 setTimeout：mock.timers.enable 后即被虚拟时钟接管
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

// 虚拟时钟下驱动超时并断言错误消息
async function assertTimeoutAt (p, tickSeq, msgRe) {
  const guard = assert.rejects(p, msgRe)
  for (const t of tickSeq) {
    mock.timers.tick(t)
  }
  await guard
}

describe('db-client op timeouts (P2-19)', () => {
  test('executeSql 120s（15s 时未炸，120s 报 db op executeSql timeout）', async () => {
    const adapter = makeAdapter()
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    // enable 须在 openDbTab 前：建连阶段的 15s 计时器也走虚拟时钟，
    // 否则真实 timer 挂住测试进程 ~15s 才退出
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'executeSql', { sql: 'select 1' }),
        [15000, 105000],
        /db op executeSql timeout \(120s\)/
      )
    } finally {
      mock.timers.reset()
    }
  })

  test('getPageData 60s', async () => {
    const adapter = makeAdapter()
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'getPageData', { page: 1, pageSize: 100 }),
        [59999, 1],
        /db op getPageData timeout \(60s\)/
      )
    } finally {
      mock.timers.reset()
    }
  })

  test('未特列 op（describeTable）保持默认 15s', async () => {
    const adapter = makeAdapter()
    const { openDbTab, dbClientOp } = loadDbClient(adapter)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      await openDbTab(bookmark(), null)
      await assertTimeoutAt(
        dbClientOp('t1', 'describeTable', {}),
        [14999, 1],
        /db op describeTable timeout \(15s\)/
      )
    } finally {
      mock.timers.reset()
    }
  })

  test('反向契约：dbClientOp 不得回退为固定 OVERALL_TIMEOUT', () => {
    const src = fs.readFileSync(JS, 'utf8')
    assert.match(src, /const opMs = OP_TIMEOUTS\[op\] \|\| OP_TIMEOUTS\.default/)
    assert.doesNotMatch(
      src,
      /withTimeout\(adapter\[method\]\(inst\.conn, safeArgs\), OVERALL_TIMEOUT\)/,
      'dbClientOp 不得再引用固定 15s'
    )
    assert.match(src, /executeSql: 120000/)
    assert.match(src, /getPageData: 60000/)
  })
})
