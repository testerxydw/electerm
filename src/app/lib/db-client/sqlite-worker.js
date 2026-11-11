/**
 * sqlite adapter worker entry（资源优化 D1）。
 *
 * 为什么存在：`node:sqlite` 只有同步 `DatabaseSync`，`./sqlite.js` 的每次
 * prepare/run/all 都阻塞调用方所在进程。历史上适配器跑在主进程，大查询 /
 * 大导入（executeSql 10000 行、insertRows 分批）会卡住所有 tab 包括终端，
 * 只能靠行数上限兜底。D1 把适配器整体搬进 worker_threads：本文件是 worker
 * 入口，用消息协议暴露 `./sqlite.js` 的 async 方法面；`./sqlite-async.js`
 * 是主进程侧的 proxy。`./sqlite.js` 本体保持为纯实现 ——
 * db-sql-risk / db-structure-v2 / db-sqlite-adapter 三条契约对它的源码
 * 文本断言因此零改动。
 *
 * F2 手动事务桥接：`DatabaseSync` 实例不能跨线程传，`beginTx` 在 worker 内
 * 打开独立连接后只回传一个 token；主进程把它包成 `{ __txToken }` 塞进
 * `conn.__txClient`（index.js F2 的注入形状不变），后续 op 到达这里时把
 * token 还原成真实连接；commit/rollback 后 token 失效。
 */

const { parentPort } = require('worker_threads')
const adapter = require('./sqlite')

// F2 独立事务连接注册表：token → DatabaseSync（worker 内私有，不出线程）
const txMap = new Map()
let txSeq = 0

// conn.__txClient 带回 token 时，还原成 worker 内的真实事务连接
function resolveConn (conn) {
  const tx = conn && conn.__txClient
  if (!tx) {
    return conn
  }
  const client = txMap.get(tx.__txToken)
  if (!client) {
    throw new Error('sqlite transaction client not found (already committed/rolled back?)')
  }
  return { ...conn, __txClient: client }
}

async function dispatch (fn, args) {
  // F2 事务三方法不直接路由：连接只活在 worker 内，跨线程传 token
  if (fn === 'beginTx') {
    const client = await adapter.beginTx(args[0])
    const token = 'tx-' + (++txSeq)
    txMap.set(token, client)
    return token
  }
  if (fn === 'commitTx' || fn === 'rollbackTx') {
    const token = args[0] && args[0].__txToken
    const client = txMap.get(token)
    if (!client) {
      // 幂等兜底：index.js 的超时路径可能对同一 client 补一次 rollback；
      // 真实连接已随 token 失效关闭，等价于已回滚
      return 0
    }
    txMap.delete(token)
    return adapter[fn](client)
  }
  const target = adapter[fn]
  if (typeof target !== 'function') {
    throw new Error(`sqlite worker: unknown method ${fn}`)
  }
  const conn = resolveConn(args[0])
  return conn !== args[0]
    ? target(conn, ...args.slice(1))
    : target(...args)
}

parentPort.on('message', async msg => {
  const { id, fn, args = [] } = msg
  try {
    const result = await dispatch(fn, args)
    parentPort.postMessage({ id, ok: true, result })
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: e && e.message,
      stack: e && e.stack
    })
  }
})
