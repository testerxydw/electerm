/**
 * sqlite adapter async proxy（资源优化 D1）。
 *
 * `./sqlite.js` 是纯实现（node:sqlite 同步 API），直接在主进程跑会阻塞整个
 * 应用（大查询/导入期间所有 tab 包括终端都卡）。本模块保持与它**完全相同的
 * 导出面**，但 async 方法全部经 `sqlite-worker.js` 在 worker_threads 里执行，
 * 主进程只承担消息往返；纯函数与常量（quoteIdent/pageWindow/…/MAX_SQL_ROWS）
 * 是无 IO 的本地计算，保持同步直出，单测与调用方零感知。
 *
 * db-client/index.js 是唯一消费方（getAdapter 的 `require('./'+name)`、
 * testers 表、closeSqliteConnection 收尾），从 `./sqlite` 换成本模块即可，
 * 其余接线（含 F2 的 `conn.__txClient` 注入形状）不变。
 *
 * F2 事务：worker 内 beginTx 打开独立连接后只回传 token，这里包成
 * `{ __txToken }` 返回 —— index.js 把它当 pinned.client 存进 tab 状态并在
 * 事务期注入每个 op 的 conn，形状与旧的 DatabaseSync 实例同构（都是被
 * commitTx/rollbackTx 原样收回的不透明句柄）。
 */

const path = require('path')
const { Worker } = require('worker_threads')
const adapter = require('./sqlite')

const RPC_METHODS = [
  'testSqliteConnection',
  'acquire',
  'release',
  'evict',
  'getMetadata',
  'getObjectDdl',
  'getPageData',
  'describeTable',
  'getTableStructure',
  'getReferences',
  'listForeignKeys',
  'updateCell',
  'insertRow',
  'insertRows',
  'deleteRows',
  'updateCells',
  'countRows',
  'executeSql',
  'explainQuery',
  'listColumns',
  'closeSqliteConnection'
]

let worker = null
let seq = 0
const pending = new Map()

// worker 常驻单例：适配器的 dbs/refs 缓存（按文件路径的连接池）因此跨 op
// 存活，与旧实现同一个 Map 语义。崩溃时清 pending 并置 null，下次调用懒重建。
function getWorker () {
  if (worker) {
    return worker
  }
  const w = new Worker(path.join(__dirname, 'sqlite-worker.js'))
  w.on('message', msg => {
    const { id, ok, result, error, stack } = msg
    const p = pending.get(id)
    if (!p) {
      return
    }
    pending.delete(id)
    if (ok) {
      p.resolve(result)
    } else {
      const err = new Error(error || 'sqlite worker call failed')
      err.stack = stack || err.stack
      p.reject(err)
    }
  })
  const failAll = () => {
    const ps = [...pending.values()]
    pending.clear()
    for (const p of ps) {
      p.reject(new Error('sqlite worker exited before replying'))
    }
    if (worker === w) {
      worker = null
    }
  }
  w.on('error', failAll)
  w.on('exit', failAll)
  worker = w
  return w
}

function rpc (fn, ...args) {
  const w = getWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, fn, args })
  })
}

const proxied = {}
for (const fn of RPC_METHODS) {
  proxied[fn] = (...args) => rpc(fn, ...args)
}

// F2：beginTx 在 worker 内打开独立连接，跨线程只传 token；
// commitTx/rollbackTx 收回的 client 就是这里返回的 token 包装
async function beginTx (conn) {
  const token = await rpc('beginTx', conn)
  return { __txToken: token }
}

// 显式销毁 worker：测试收尾（node:test 事件循环会被常驻 worker 撑住）、
// 以及未来的应用退出清理。调用后 pending 全拒、下次 op 懒重建（dbs/refs
// 连接池随 worker 一起销毁，语义等价 closeSqliteConnection() 后再重建）。
function disposeAsyncWorker () {
  const w = worker
  worker = null
  const ps = [...pending.values()]
  pending.clear()
  for (const p of ps) {
    p.reject(new Error('sqlite worker disposed'))
  }
  if (w) {
    w.terminate()
  }
}

const sqliteAsync = {
  // 纯函数/常量：无 IO，同步直出（单测与源码契约的消费面不变）
  ...adapter,
  ...proxied,
  beginTx,
  // commitTx/rollbackTx 的入参是 beginTx 返回的 token 包装，
  // worker 端按 __txToken 还原真实连接
  commitTx: (...args) => rpc('commitTx', ...args),
  rollbackTx: (...args) => rpc('rollbackTx', ...args),
  disposeAsyncWorker
}

module.exports = sqliteAsync
