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

function fail (reason, message) {
  return { ok: false, reason, message }
}

function rawDbAction () {
  // 惰性取：db.js 的 dbAction 已被 vault-bookmarks 包装，这里要的是未包装的原入口
  return require('./db').rawDbAction
}

function vaultBookmarks () {
  return require('./vault-bookmarks')
}

/**
 * 迁移一批。标记写在服务层（config），搬数据在这里做 —— 服务层不碰 DB。
 */
async function migrate (arg) {
  const service = getVaultService()
  const status = service.status()
  if (!status.ok) {
    return status
  }
  if (!status.enabled) {
    return fail('no-vault', 'vault is not enabled')
  }
  if (!service.isUnlocked()) {
    return fail('vault-locked', 'unlock vault before migrating')
  }
  await service.run('markMigrating', { value: true })
  const res = await vaultBookmarks().migrateBatch(rawDbAction(), { limit: arg.limit })
  // 只剩 0 行才算跑完；中途出错/自己停下的保持标记，界面下一轮能继续
  if (res.ok && res.remaining === 0) {
    await service.run('markMigrating', { value: false })
  }
  return res
}

/**
 * 停用前置步骤：先把 `_vault` 反解回旧格式，再走服务层删 config。
 * 顺序不能反：口令错时不能先把密文摊成明文。
 */
async function disableVault (arg) {
  const service = getVaultService()
  const status = service.status()
  if (!status.ok) {
    return status
  }
  if (!status.enabled) {
    return service.run('disable', arg)
  }
  const counts = await vaultBookmarks().migrateStatus(rawDbAction())
  if (!counts.ok || counts.sealed === 0) {
    return service.run('disable', arg)
  }
  if (!service.isUnlocked()) {
    const byRecovery = typeof arg.recoveryCode === 'string' && arg.recoveryCode !== ''
    const unlocked = await service.run(byRecovery ? 'unlockWithRecovery' : 'unlock', byRecovery
      ? { recoveryCode: arg.recoveryCode }
      : { masterPassword: arg.masterPassword })
    if (!unlocked || !unlocked.ok) {
      return unlocked || fail('vault-locked', 'unlock vault before disabling')
    }
  }
  const un = await vaultBookmarks().unsealAll(rawDbAction())
  if (!un.ok) {
    return un
  }
  if (un.failed > 0) {
    return fail('unseal-failed', 'cannot unseal ' + un.failed + ' record(s)')
  }
  return service.run('disable', arg)
}

/**
 * 渲染层唯一的 vault 入口（ipc.js 的 asyncGlobals 转发到这里）。
 * 返回值里没有 DEK、没有主密码、没有恢复码原文（enable 那一次除外）。
 */
exports.vaultOp = (action, arg) => {
  const a = arg || {}
  if (action === 'migrate') {
    return migrate(a)
  }
  if (action === 'migrateStatus') {
    return vaultBookmarks().migrateStatus(rawDbAction())
  }
  if (action === 'unsealAll') {
    if (!getVaultService().isUnlocked()) {
      return Promise.resolve(fail('vault-locked', 'unlock vault before unsealing'))
    }
    return vaultBookmarks().unsealAll(rawDbAction())
  }
  if (action === 'revealBookmark') {
    return vaultBookmarks().revealSecrets(rawDbAction(), a.id)
  }
  if (action === 'disable') {
    return disableVault(a)
  }
  return getVaultService().run(action, a)
}
exports.getVaultService = getVaultService
exports.vaultFilePath = vaultFilePath
