/**
 * G6-2 主进程 vault 单例：把 createVaultService 接到真磁盘上。
 *
 * vault config 单独落一个文件（users/<name>/vault.json），不放 userConfig 那条记录：
 * - 那条记录整体走 safeStorage（绑 OS 账号），而 vault 的意义正是"钥匙跟着
 *   主密码走，换机器还能解"，把 wrappedDek 塞进 OS 加密的壳里等于自己拆台；
 * - 文件里全是包好的东西（salt/wrappedDek/verifier/recovery），落盘不需要再加密。
 *
 * 目录口径跟 storage-key.js 一致：认 DATA_PATH，便携版跟着 appPath 走。
 */
const fs = require('fs')
const { resolve: pathResolve } = require('path')
const log = require('../common/log')
const { appPath, defaultUserName } = require('../common/app-props')
const { createVaultService } = require('./vault')

const appDataPath = process.env.DATA_PATH || pathResolve(appPath, 'electerm')
const userDir = pathResolve(appDataPath, 'users', defaultUserName)
const vaultFilePath = pathResolve(userDir, 'vault.json')

const store = {
  read () {
    if (!fs.existsSync(vaultFilePath)) {
      return null
    }
    // 解析失败要抛出去：service 会报 store-unavailable，
    // 而不是把"读不出来"当成"没启用"让用户以为一切正常
    return JSON.parse(fs.readFileSync(vaultFilePath, 'utf8'))
  },
  write (config) {
    if (!config) {
      fs.rmSync(vaultFilePath, { force: true })
      return
    }
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true })
    }
    fs.writeFileSync(vaultFilePath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}

let service = null

function getVaultService () {
  if (!service) {
    service = createVaultService({ store, log })
  }
  return service
}

/**
 * 渲染层唯一的 vault 入口（ipc.js 的 asyncGlobals 转发到这里）。
 * 返回值里没有 DEK、没有主密码、没有恢复码原文（enable 那一次除外）。
 */
exports.vaultOp = (action, arg) => getVaultService().run(action, arg)
exports.getVaultService = getVaultService
exports.vaultFilePath = vaultFilePath
