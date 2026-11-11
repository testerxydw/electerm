/**
 * ws 升级鉴权（/dbclient、/upgrade/:id、/common/s 共用）。
 *
 * 独立成模块的原因：dispatch-center 顶部 require db-client-ws（注册
 * /dbclient），而 db-client-ws 又需要 verify —— 若 verify 留在
 * dispatch-center，db-client-ws 顶部反向 require 拿到的是未完成导出的
 * 半成品（verifyWs undefined），运行时抛 TypeError → ws.close()，
 * 客户端全部 DB 操作报 "dbclient ws connection closed before replying"
 * （2026-11-11 D2 引入，最小复现实证）。
 */

const globalState = require('./global-state')

const { tokenElecterm } = process.env

function verify (req) {
  const { token: to } = req.query
  if (to !== tokenElecterm) {
    throw new Error('not valid request')
  }
  if (process.env.requireAuth === 'yes' && !globalState.authed) {
    throw new Error('auth required')
  }
}

module.exports = verify
