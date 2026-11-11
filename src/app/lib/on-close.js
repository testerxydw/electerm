/**
 * on close app
 */

const { dbAction } = require('./db')
const log = require('../common/log')
const globalState = require('./glob-state')

exports.getExitStatus = async () => {
  const res = await dbAction('data', 'findOne', {
    _id: 'exitStatus'
  })
  return res && res.value ? res.value : ''
}

exports.onClose = async function (e) {
  const config = globalState.get('config')
  if (config.confirmBeforeExit && globalState.get('closeAction')) {
    const win = globalState.get('win')
    win?.webContents.send(
      'confirm-exit',
      globalState.get('closeAction')
    )
    globalState.set('closeAction', '')
    return e.preventDefault()
  }
  log.debug('Closing app')
  // 关闭所有数据库连接（如有），await 确保连接池清理完成后才退出。
  // D2：db-client 在 server 子进程，清理经 WS RPC 执行——
  // server 侧执行完才回 ok，随后才 kill childPid，清理时序与迁移前一致。
  // 开过 db tab 才会有这条 ws 连接；没开过则 RPC 会因 server config 缺失
  // 或连接失败抛错，由下面的 catch 忽略（本就没有要清理的连接）。
  try {
    await require('./db-client-remote').closeAllDbTabs()
  } catch (err) {
    // ignore db client cleanup errors
  }
  const childPid = globalState.get('childPid')
  childPid && process.kill(childPid)
  globalState.set('serverInited', false)
  process.on('uncaughtException', function () {
    const childPid = globalState.get('childPid')
    childPid && process.kill(childPid)
    process.exit(0)
  })
  log.debug('Child process killed')
  // await dbAction('data', 'update', {
  //   _id: 'exitStatus'
  // }, {
  //   value: 'ok',
  //   _id: 'exitStatus'
  // }, {
  //   upsert: true
  // })
  // await dbAction('data', 'update', {
  //   _id: 'sessions'
  // }, {
  //   value: null,
  //   _id: 'sessions'
  // }, {
  //   upsert: true
  // })
  // log.debug('session saved')
  clearTimeout(globalState.get('timer'))
  globalState.set('win', null)
  const app = globalState.get('app')
  app.quit && app.quit()
}
