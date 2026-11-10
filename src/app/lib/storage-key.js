const log = require('../common/log')
const { appPath, defaultUserName } = require('../common/app-props')
const { safeEncrypt, safeDecrypt } = require('./safe-storage')
const { resolve: pathResolve } = require('path')
const fs = require('fs')
const { randomBytes } = require('crypto')

const appDataPath = process.env.DATA_PATH || pathResolve(appPath, 'electerm')
const keyFilePath = pathResolve(appDataPath, 'users', defaultUserName, 'storage-key.enc')

let _cachedStorageKey = null

function getStorageKey () {
  if (_cachedStorageKey) return _cachedStorageKey
  let key = null
  try {
    if (fs.existsSync(keyFilePath)) {
      const enc = fs.readFileSync(keyFilePath, 'utf8').trim()
      const dec = safeDecrypt(enc)
      // safeDecrypt 现在是 fail-closed（解不开就返回 ''），存储密钥解不开时下面
      // 会重新生成一把新钥匙 —— 那意味着用旧钥匙加密的 vault 条目再也读不出来。
      // 这里只加一条可见告警，分支行为保持不变。
      if (!dec && enc.startsWith('v2:safe:')) {
        console.warn('[storage-key] stored key cannot be decrypted on this machine (keyring changed?) — generating a new key; vault entries encrypted with the old key will be unreadable')
      }
      if (dec && dec !== enc) {
        key = dec
      } else if (dec && !enc.startsWith('v2:safe:')) {
        key = dec
      }
    }
  } catch (e) {
    log.error('[storage-key] read error:', e.message)
  }
  if (!key) {
    key = randomBytes(32).toString('base64')
    try {
      const dir = pathResolve(appDataPath, 'users', defaultUserName)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const enc = safeEncrypt(key)
      fs.writeFileSync(keyFilePath, enc, 'utf8')
    } catch (e) {
      log.error('[storage-key] write error:', e.message)
    }
  }
  _cachedStorageKey = key
  return key
}

module.exports = { getStorageKey }
