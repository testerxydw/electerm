/**
 * db loader
 * Provides electron-related environment to nedb/sqlite modules
 */

const { appPath, defaultUserName } = require('../common/app-props')
const { safeEncrypt, safeDecrypt } = require('./safe-storage')

const encOpts = { enc: safeEncrypt, dec: safeDecrypt }

let db = null
if (process.versions.node < '22.0.0') {
  const { createDb } = require('./nedb')
  db = createDb(appPath, defaultUserName, encOpts)
} else {
  const { createDb } = require('./sqlite')
  db = createDb(appPath, defaultUserName, encOpts)
}

// G6 阶段②：书签/配置表的凭据读写要过保险库（见 vault-bookmarks.js）。
// rawDbAction 只给主进程内部（迁移/停用反解）用，渲染层永远走包装后的入口。
module.exports = Object.assign({}, db, {
  rawDbAction: db.dbAction,
  dbAction: require('./vault-bookmarks').wrapDbAction(db.dbAction)
})
