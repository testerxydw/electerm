/**
 * D1（资源优化 §4.2）：sqlite 适配器 worker 化契约。
 *
 * `db-client/sqlite.js` 的同步 `DatabaseSync` 会阻塞主进程，实现整体搬进
 * worker_threads 跑（`sqlite-worker.js`），主进程侧由 `sqlite-async.js`
 * proxy 提供完全一致的导出面。三条既有源码契约（db-sql-risk 的白名单扫描、
 * db-structure-v2、db-sqlite-adapter）继续对 `sqlite.js` 本体做文本断言，
 * 本 spec 锁住搬迁本身不破坏的三件事：
 *   1. `sqlite.js` 本体仍是唯一实现（worker require 它，文本契约不被绕开）；
 *   2. proxy 导出面与本体全等（纯函数/常量同步直出、async 方法走 RPC）；
 *   3. index.js 的三个 sqlite 解析点全部路由到 proxy（getAdapter 特判、
 *      testers 表、closeSqliteConnection 收尾）。
 * F2 事务：beginTx 跨线程只回 token（DatabaseSync 实例不可 structured
 * clone），proxy 返回 `{ __txToken }` 包装 —— 形状在这里钉死。
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..', '..', '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('sqlite.js 本体仍是唯一实现（worker require 它，纯函数/常量仍从本体出）', () => {
  const worker = read('src/app/lib/db-client/sqlite-worker.js')
  assert.ok(
    worker.includes("require('./sqlite')"),
    'worker entry must require the single implementation ./sqlite.js'
  )
  assert.ok(worker.includes('txMap'), 'F2 token registry must live in worker')
  // token 桥：连接不出线程
  assert.ok(
    worker.includes("'tx-' + (++txSeq)"),
    'beginTx must mint a token instead of leaking the DatabaseSync instance'
  )
  assert.doesNotMatch(worker, /postMessage\(\{[^}]*client/, 'raw client must not be posted back')
})

test('sqlite-async proxy 导出面与本体全等（async 方法走 RPC，纯函数直出）', () => {
  const proxy = read('src/app/lib/db-client/sqlite-async.js')
  assert.ok(
    proxy.includes('...adapter'),
    'proxy must re-export the whole core surface (pure fns stay sync)'
  )
  for (const fn of [
    'testSqliteConnection', 'acquire', 'release', 'evict',
    'getMetadata', 'getObjectDdl', 'getPageData', 'describeTable',
    'getTableStructure', 'getReferences', 'listForeignKeys',
    'updateCell', 'insertRow', 'insertRows', 'deleteRows', 'updateCells',
    'countRows', 'executeSql', 'explainQuery', 'listColumns',
    'closeSqliteConnection'
  ]) {
    assert.ok(proxy.includes(`'${fn}'`), `RPC method list must cover ${fn}`)
  }
  // F2 token 包装形状：index.js 把它当 pinned.client 原样收回
  assert.ok(proxy.includes('__txToken'), 'beginTx must return { __txToken } wrapper')
  assert.ok(proxy.includes('new Worker'), 'async methods must run in worker_threads')
})

test('index.js 的三个 sqlite 解析点全部路由到 proxy（dialectOf 方言名不动）', () => {
  const idx = read('src/app/lib/db-client/index.js')
  assert.ok(
    idx.includes("require(name === 'sqlite' ? './sqlite-async' : './' + name)"),
    'getAdapter must route sqlite to the worker proxy'
  )
  assert.ok(
    idx.includes("require('./sqlite-async').testSqliteConnection"),
    'testers table must use the proxy'
  )
  assert.ok(
    idx.includes("require('./sqlite-async').closeSqliteConnection"),
    'closeAll hook must use the proxy'
  )
  // DB_ADAPTER['sqlite'] 保持方言名（dialectOf 判 sqlite 词法用它）
  assert.ok(
    /sqlite:\s*'sqlite'/.test(idx),
    'DB_ADAPTER value must stay the dialect name, not the proxy module'
  )
})

test('运行时冒烟：proxy 纯函数同步直出 + beginTx 走 worker 回 token', async () => {
  // 不能在本进程 require proxy：全量 runner 的 NODE_ENV 下 runtime-constants
  // 的 package.json 解析在源码树布局本就不可加载（既有 spec 因此全用文本
  // 扫描）。冒烟走子进程，自设 NODE_ENV，断言退出码。
  const { execFileSync } = require('node:child_process')
  const script = `
    const assert = require('node:assert')
    const adapter = require('${path.join(ROOT, 'src/app/lib/db-client/sqlite-async.js')}')
    assert.equal(adapter.MAX_SQL_ROWS, 10000)
    assert.equal(adapter.quoteIdent('a"b'), '"a""b"')
    adapter.beginTx({ dbFile: ':memory:' }).then(
      () => { console.error('SMOKE-FAIL: :memory: tx must be rejected'); process.exit(1) },
      e => {
        assert.ok(/:memory:/.test(e.message), 'wrong rejection: ' + e.message)
        adapter.disposeAsyncWorker()
        console.log('SMOKE OK')
      }
    )
  `
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8',
    timeout: 30000
  })
  assert.ok(out.includes('SMOKE OK'), 'worker smoke did not complete: ' + out)
  // 收尾断言在子进程内完成；本进程无 worker 需要清理
})
