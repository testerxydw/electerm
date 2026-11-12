/**
 * db-client 主进程侧 WS RPC 客户端（资源优化 D2 批次一）。
 *
 * db-client 全家已迁到 server 子进程运行（server/db-client-ws.js 提供
 * /dbclient 端点），主进程只留这条转发通道：导出面与 db-client/index.js
 * 完全一致（六个公开入口），ipc.js 六入口与其它主进程调用方把
 * require('./db-client') 换成本模块即可，签名零变化。
 *
 * 连接管理：
 * - 参数取 globalState 的 config（initAppServer 时已存 host/port/tokenElecterm）
 * - requireAuth 模式先 POST /auth（与渲染层同一鉴权口径）再开 ws
 * - 惰性连接 + 断线清 pending；db tab 状态（instances）在 server 进程，
 *   重连不丢状态
 * - 不设客户端级超时：长查询（OVERALL_TIMEOUT 15s、慢 op 60s）由 server
 *   侧 db-client 统一管，双重超时会误杀慢 op（P2-19 口径）
 */

const http = require('http')
const { dialog } = require('electron')
const WebSocket = require('ws')
const globalState = require('./glob-state')
// 只取 dialogFilters（纯 node 模块，主进程/子进程都能加载），不引 db-importer ——
// 那是子进程侧的模块，主进程引它会拖起整个导入任务栈
const { dialogFilters } = require('./db-import/parsers')

let conn = null
let connecting = null
let seq = 0
const pending = new Map()

function serverConf () {
  const config = globalState.get('config') || {}
  const { host, port, tokenElecterm, requireAuth } = config
  if (!host || !port || !tokenElecterm) {
    throw new Error('server config not ready (host/port/token missing)')
  }
  return { host, port, tokenElecterm, requireAuth }
}

function authOnce ({ host, port, tokenElecterm, requireAuth }) {
  if (requireAuth !== 'yes') {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token: tokenElecterm })
    const req = http.request({
      host,
      port,
      path: '/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, res => {
      res.resume()
      res.statusCode === 200
        ? resolve()
        : reject(new Error(`server /auth failed: ${res.statusCode}`))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('server /auth timeout')))
    req.end(body)
  })
}

function failAll (msg) {
  const ps = [...pending.values()]
  pending.clear()
  for (const p of ps) {
    p.reject(new Error(msg))
  }
}

async function getConnection () {
  if (conn) {
    return conn
  }
  if (connecting) {
    return connecting
  }
  const conf = serverConf()
  connecting = (async () => {
    await authOnce(conf)
    const ws = new WebSocket(
      `ws://${conf.host}:${conf.port}/dbclient?token=${encodeURIComponent(conf.tokenElecterm)}`
    )
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.on('message', data => {
      let msg = null
      try {
        msg = JSON.parse(data.toString())
      } catch (e) {
        return
      }
      const p = pending.get(msg.id)
      if (!p) {
        return
      }
      pending.delete(msg.id)
      if (msg.ok) {
        p.resolve(msg.result)
      } else {
        p.reject(new Error(msg.error || 'dbclient op failed'))
      }
    })
    const cleanup = () => {
      failAll('dbclient ws connection closed before replying')
      if (conn === ws) {
        conn = null
      }
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
    conn = ws
    return ws
  })()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

async function rpc (action, ...args) {
  const ws = await getConnection()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      ws.send(JSON.stringify({ id, action, args }))
    } catch (e) {
      pending.delete(id)
      reject(e)
    }
  })
}

const remote = {}
for (const action of [
  'testDbConnection',
  'openDbTab',
  'dbClientOp',
  'setDbReadOnly',
  'closeDbTab',
  'closeAllDbTabs',
  // D2 批次二：导出/导入任务循环整体在 server 进程执行（任务状态/文件 IO/
  // dbClientOp 与连接池同进程），主进程只转发
  'dbExportOp'
]) {
  remote[action] = (...args) => rpc(action, ...args)
}

// dbImportOp 不走通用转发：openFile 的 dialog 只能在主进程开 —— db-client
// 子进程是 fork 出来的纯 Node 环境（ELECTRON_RUN_AS_NODE），require('electron')
// 直接抛 Cannot find module（实机 /opt/electerm 验证过）。这里选完文件后把
// preview 连同 filePath 转发给子进程，渲染层 op 面（openFile/preview/...）不变
remote.dbImportOp = (action, arg) => {
  if (action === 'openFile') {
    const res = dialog.showOpenDialogSync({
      title: '选择要导入的文件',
      properties: ['openFile'],
      filters: dialogFilters()
    })
    if (!res || !res.length) {
      return Promise.resolve({ filePath: null })
    }
    return rpc('dbImportOp', 'preview', { ...(arg || {}), filePath: res[0] })
  }
  return rpc('dbImportOp', action, arg)
}

module.exports = remote
