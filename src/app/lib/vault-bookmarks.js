/**
 * G6 阶段②：dbAction 的凭据读写包装（设计 阶段4 §14.7）
 *
 * 只包 bookmarks / profiles 两张表：
 * - 读：已解锁就把 `_vault` 解开合并成明文（渲染层契约不变）；锁定时
 *   去掉明文并标 `_sealed`，让界面知道"这条有凭据、要用时先解锁"。
 * - 写：提交里带明文敏感字段时，解锁态封存；锁定时拒绝（不能偷偷降级明文）。
 *   只改标题等非敏感字段的更新原样透传，保留已有 `_vault`。
 * - 旧格式（没有 `_vault`、带明文）一路透传：迁移中断时仍能连接。
 *
 * `legacyWrite=true` 时新写入回旧路径，对应设计 §14.7 的回滚开关。
 */
const {
  SECRET_TABLES,
  collectSecrets,
  stripSecrets,
  hasSealed,
  sealRow,
  openRow
} = require('./vault-secrets')

// 惰性取单例：db.js 在启动早期就被加载，此时 vault-instance 可能还没就绪
function defaultContext () {
  const getService = () => require('./vault-instance').getVaultService()
  return {
    state () {
      const s = getService().status()
      return {
        enabled: !!(s && s.ok !== false && s.enabled),
        unlocked: !!(s && s.ok !== false && s.unlocked),
        legacyWrite: !!(s && s.ok !== false && s.legacyWrite)
      }
    },
    withDek (fn) {
      return getService().withDek(fn)
    }
  }
}

function lockedError () {
  const err = new Error('vault is locked')
  err.reason = 'vault-locked'
  return err
}

function readOne (row, state, ctx) {
  if (!row || !hasSealed(row)) {
    return row
  }
  if (!state.unlocked) {
    return { ...stripSecrets(row), _sealed: true }
  }
  const { row: opened, error } = ctx.withDek(dek => openRow(row, dek))
  if (error) {
    // 解不开就按"有封套但读不出"处理：不回明文，也别让界面以为没有凭据
    return { ...stripSecrets(row), _sealed: true }
  }
  return opened
}

function writeOne (row, state, ctx) {
  if (!row) {
    return row
  }
  // 没有明文敏感字段（只改标题/端口，或锁定态回写原记录）：原样保留 _vault
  if (!collectSecrets(row)) {
    return row
  }
  if (!state.enabled || state.legacyWrite) {
    return row
  }
  if (!state.unlocked) {
    throw lockedError()
  }
  return ctx.withDek(dek => sealRow(row, dek))
}

/**
 * @param {Function} rawDbAction 原始 dbAction
 * @param {object} [ctx] 测试可注入 { state(), withDek(fn) }
 * @returns {Function} 包装后的 dbAction（签名不变）
 */
function wrapDbAction (rawDbAction, ctx) {
  const context = ctx || defaultContext()
  return async function dbAction (dbName, op, ...args) {
    if (!SECRET_TABLES.has(dbName)) {
      return rawDbAction(dbName, op, ...args)
    }
    const state = context.state()
    if (op === 'find' || op === 'findOne') {
      const res = await rawDbAction(dbName, op, ...args)
      if (!state.enabled) {
        return res
      }
      return Array.isArray(res)
        ? res.map(row => readOne(row, state, context))
        : readOne(res, state, context)
    }
    if (op === 'insert') {
      if (!state.enabled) {
        return rawDbAction(dbName, op, ...args)
      }
      const input = args[0]
      const mapped = Array.isArray(input)
        ? input.map(row => writeOne(row, state, context))
        : writeOne(input, state, context)
      return rawDbAction(dbName, op, mapped, ...args.slice(1))
    }
    if (op === 'update') {
      if (!state.enabled) {
        return rawDbAction(dbName, op, ...args)
      }
      const updateObj = args[1] || {}
      const set = updateObj.$set || updateObj
      const nextSet = writeOne(set, state, context)
      const nextUpdate = updateObj.$set ? { ...updateObj, $set: nextSet } : nextSet
      return rawDbAction(dbName, op, args[0], nextUpdate, ...args.slice(2))
    }
    return rawDbAction(dbName, op, ...args)
  }
}

module.exports = {
  wrapDbAction
}
