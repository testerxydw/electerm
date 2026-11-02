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
  openRow,
  rowState
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

function withoutId (row) {
  const copy = { ...row }
  delete copy._id
  return copy
}

function normalizeLimit (value, fallback = 50) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    return fallback
  }
  return Math.min(Math.floor(n), 500)
}

async function collectByState (rawDbAction) {
  let total = 0
  let sealed = 0
  let plain = 0
  const plainRows = []
  const sealedRows = []
  for (const table of SECRET_TABLES) {
    const rows = await rawDbAction(table, 'find', {}) || []
    for (const row of rows) {
      const state = rowState(row)
      if (state === 'sealed') {
        total++
        sealed++
        sealedRows.push({ table, row })
      } else if (state === 'plain') {
        total++
        plain++
        plainRows.push({ table, row })
      }
    }
  }
  return { total, sealed, plain, plainRows, sealedRows }
}

/**
 * 只读统计：给设置页显示"还有多少旧格式行"。
 * 不需要钥匙，锁定态也能算（只看 `_vault` 在不在）。
 */
async function migrateStatus (rawDbAction) {
  const { total, sealed, plain } = await collectByState(rawDbAction)
  return { ok: true, total, sealed, plain }
}

/**
 * 分批迁移：把旧格式明文行封存。每批最多 limit 行。
 * 中断安全：已封存的行不会再被扫到；剩下的行仍是旧格式、照样能连接。
 */
async function migrateBatch (rawDbAction, options = {}, ctx) {
  const context = ctx || defaultContext()
  const state = context.state()
  if (!state.enabled) {
    return { ok: false, reason: 'no-vault', message: 'vault is not enabled' }
  }
  if (!state.unlocked) {
    return { ok: false, reason: 'vault-locked', message: 'unlock vault before migrating' }
  }
  const limit = normalizeLimit(options.limit)
  const { total, sealed, plain, plainRows } = await collectByState(rawDbAction)
  const targets = plainRows.slice(0, limit)
  // 封存在钥匙生命周期内一次做完，写库放到锁外，避免持锁等待 IO
  const prepared = context.withDek(dek =>
    targets.map(target => ({ ...target, next: sealRow(target.row, dek) }))
  )
  let migrated = 0
  for (const item of prepared) {
    try {
      await rawDbAction(item.table, 'update', { _id: item.row._id }, { $set: withoutId(item.next) }, {})
      migrated++
    } catch (e) {
      // 单行写失败不拖垮整批：下一轮还会扫到它
    }
  }
  return {
    ok: true,
    total,
    sealed: sealed + migrated,
    done: sealed + migrated,
    remaining: plain - migrated,
    migrated
  }
}

/**
 * 停用前反解：把所有 `_vault` 行还原成旧格式明文。
 * 需要已解锁；单行解不开或写失败都计入 failed，绝不静默删 config。
 */
async function unsealAll (rawDbAction, ctx) {
  const context = ctx || defaultContext()
  const state = context.state()
  if (!state.enabled) {
    return { ok: false, reason: 'no-vault', message: 'vault is not enabled' }
  }
  if (!state.unlocked) {
    return { ok: false, reason: 'vault-locked', message: 'unlock vault before disabling' }
  }
  const { sealedRows } = await collectByState(rawDbAction)
  const prepared = context.withDek(dek =>
    sealedRows.map(target => ({ ...target, opened: openRow(target.row, dek) }))
  )
  let unsealed = 0
  let failed = 0
  for (const item of prepared) {
    if (item.opened.error || !item.opened.row) {
      failed++
      continue
    }
    try {
      await rawDbAction(item.table, 'update', { _id: item.row._id }, { $set: withoutId(item.opened.row) }, {})
      unsealed++
    } catch (e) {
      failed++
    }
  }
  return { ok: true, total: sealedRows.length, unsealed, failed }
}

/**
 * 按 id 取回一条书签的敏感字段明文（只回凭据，不回其它字段）。
 * 锁定态拒绝，旧格式行也能取（明文本来就在行里）。
 * @returns {{ok: true, secrets: {top, hoppings}} | {ok: false, reason}}
 */
async function revealSecrets (rawDbAction, id, ctx) {
  const context = ctx || defaultContext()
  const state = context.state()
  if (!state.enabled) {
    return { ok: false, reason: 'no-vault' }
  }
  if (typeof id !== 'string' || !id) {
    return { ok: false, reason: 'bad-id' }
  }
  const row = await rawDbAction('bookmarks', 'findOne', { _id: id })
  if (!row) {
    return { ok: false, reason: 'not-found' }
  }
  const empty = { top: {}, hoppings: [] }
  if (!hasSealed(row)) {
    return { ok: true, secrets: collectSecrets(row) || empty }
  }
  if (!state.unlocked) {
    return { ok: false, reason: 'vault-locked' }
  }
  const { row: opened, error } = context.withDek(dek => openRow(row, dek))
  if (error) {
    return { ok: false, reason: 'open-failed' }
  }
  return { ok: true, secrets: collectSecrets(opened) || empty }
}

module.exports = {
  wrapDbAction,
  migrateStatus,
  migrateBatch,
  unsealAll,
  revealSecrets
}
