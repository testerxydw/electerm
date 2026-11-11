/**
 * db-client ws 端点（资源优化 D2 批次一）。
 *
 * db-client 全家（连接池/事务/隧道/结构对比等 CPU 密集后处理）从主进程迁到
 * 本子进程运行：主进程只留一条 WS RPC（lib/db-client-remote.js），事件循环
 * 不再被大查询/导入/结构对比卡住。渲染层零改动 —— runGlobalAsync 的六入口
 * （testDbConnection/openDbTab/dbClientOp/setDbReadOnly/closeDbTab/
 * closeAllDbTabs）签名不变，ipc.js 内部改走 db-client-remote。
 *
 * 协议：{ id, action, args } → { id, ok, result } / { id, ok: false, error }。
 * action 白名单严格对应 db-client 的六个公开入口；db tab 状态（instances）
 * 在本进程存活 —— 主进程侧 ws 断线重连不丢状态。
 */

const log = require('../common/log')
const wsDec = require('./ws-dec')
const { verifyWs } = require('./dispatch-center')

// db-client 惰性 require：本端点加载不等于数据库栈加载（P2 纪律延用）。
// dbExportOp/dbImportOp（D2 批次二）也在这里执行 —— exporter/importer 内部
// require('./db-client') 的 getDbTabContext/dialectOf 是同步读实例内存，
// 只有跟连接池同进程才成立；同机 fork 子进程写导出文件与主进程等价。
const actionsOf = () => {
  const dbClient = require('../lib/db-client')
  return {
    testDbConnection: dbClient.testDbConnection,
    openDbTab: dbClient.openDbTab,
    dbClientOp: dbClient.dbClientOp,
    setDbReadOnly: dbClient.setDbReadOnly,
    closeDbTab: dbClient.closeDbTab,
    closeAllDbTabs: dbClient.closeAllDbTabs,
    dbExportOp: require('../lib/db-exporter').dbExportOp,
    dbImportOp: require('../lib/db-importer').dbImportOp
  }
}

module.exports = (app) => {
  app.ws('/dbclient', (ws, req) => {
    try {
      verifyWs(req)
    } catch (e) {
      log.error('dbclient ws verify failed:', e.message)
      ws.close()
      return
    }
    wsDec(ws)
    ws.on('message', async (message) => {
      let id = null
      try {
        const msg = JSON.parse(message)
        id = msg.id
        const fn = actionsOf()[msg.action]
        if (typeof fn !== 'function') {
          throw new Error(`unknown dbclient action: ${msg.action}`)
        }
        const result = await fn(...(msg.args || []))
        ws.s({ id, ok: true, result })
      } catch (e) {
        log.error('dbclient ws op error:', e.message)
        ws.s({ id, ok: false, error: e.message })
      }
    })
  })
}
