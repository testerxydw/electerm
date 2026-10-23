/**
 * E1 连接级安全带（设计：doc/设计-数据库阶段4-增量批次-2026-10-23.md §6.2 / §6.3）
 *
 * 这一层只做"要不要问人"的判定，不碰 DOM、不碰 store、不取系统时间：
 * - 时间一律由 `now` 参数注入 —— 5 分钟临时解除必须能用假时钟测（验收 §6.5 第 4 条）；
 * - 状态装在一个普通对象里（Set/Map），便于在单测里直接构造与断言。
 *
 * 三个状态的语义（别混）：
 * - `lowRiskMuted`：本会话该连接不再提示"低风险写"（write 级）。用户勾出来的，
 *   只活在内存里 —— 不改书签，重连/重启即失效（持久化一个"别提醒我"等于把安全带拆了）。
 * - `bypass`：临时解除，5 分钟自动到期。**按连接**记账（见 grantBypass 注释）。
 * - `asked`：一批多目标只问一次。上限 50（见 markAsked 注释）。
 */

/** 临时解除有效期：5 分钟（设计 §6.3） */
export const BYPASS_TTL_MS = 5 * 60 * 1000

/** asked 记忆上限：一批多目标最多记 50 个作用域，超出淘汰最旧 */
export const ASKED_LIMIT = 50

/**
 * 建立一个空的 guard 状态。
 * @returns {{lowRiskMuted: Set<string>, bypass: Map<string, number>, asked: Set<string>}}
 */
export function createGuardState () {
  return {
    lowRiskMuted: new Set(),
    bypass: new Map(),
    asked: new Set()
  }
}

/**
 * 连接身份键（mute 与 bypass 都以它为准）。
 * 含库名：electerm 里一个 database tab 就是一个连接，同一台服务器连不同库属于不同连接，
 * 在生产库上放开 5 分钟不应该连带放开旁边的测试库。
 * @param {Object} tab 会话 tab（读 dbType/dbHost/dbPort/dbUser/dbName）
 * @returns {string}
 */
export function dbConnKey (tab) {
  const t = tab || {}
  const pick = v => (v === null || v === undefined ? '' : String(v))
  return [
    pick(t.dbType),
    pick(t.dbHost),
    pick(t.dbPort),
    pick(t.dbUser),
    pick(t.dbName)
  ].join('|')
}

// 等级归一：外部传进来的脏值一律按 unknown 处理（宁可多问一次，不要静默放行）
const KNOWN_LEVELS = new Set([
  'read', 'transaction', 'write', 'ddl', 'dangerous', 'unknown'
])

/**
 * 归一化等级。
 * @param {string} level 等级
 * @returns {string}
 */
function normalizeLevel (level) {
  const v = String(level || '').toLowerCase()
  return KNOWN_LEVELS.has(v) ? v : 'unknown'
}

/**
 * 该等级需要确认时的理由（给弹窗/日志用的短句）。
 * @param {string} level 等级
 * @param {boolean} production 是否生产连接
 * @returns {string}
 */
function reasonOf (level, production) {
  if (production) {
    return '生产连接：非查询语句需输入库名确认'
  }
  if (level === 'write') {
    return '写操作：本会话该连接首次确认'
  }
  if (level === 'ddl') {
    return '结构变更：每次执行都要确认'
  }
  if (level === 'dangerous') {
    return '高危语句：每次执行都要确认'
  }
  return '无法识别语句类型，按需确认'
}

/**
 * 是否要弹确认。
 * @param {Object} opts 入参
 * @param {string} opts.level classifySql 给出的等级
 * @param {boolean} opts.production 连接是否标记为生产
 * @param {Object} opts.state createGuardState() 的产物
 * @param {string} opts.connKey 连接身份（dbConnKey）
 * @param {string} opts.scope 本次执行批次的作用域（一批多目标共享同一个 scope）
 * @param {number} opts.now 当前时间戳（毫秒）；必传，缺省 0（等价于"从未 grant 过"）
 * @returns {{need: boolean, requireDbName: boolean, reason: string}}
 */
export function shouldConfirm (opts) {
  const o = opts || {}
  const state = o.state && typeof o.state === 'object'
    ? o.state
    : createGuardState()
  const level = normalizeLevel(o.level)
  const production = o.production === true
  const connKey = String(o.connKey || '')
  const scope = String(o.scope || '')
  const now = Number.isFinite(o.now) ? o.now : 0
  const none = { need: false, requireDbName: false, reason: '' }

  // 只读：SHOW/DESC/EXPLAIN 不产生副作用
  if (level === 'read') {
    return none
  }
  // 事务控制（BEGIN/COMMIT/ROLLBACK）不改数据，且每次提交都可能出现在同一批里。
  // 设计 §6.2 明确"read / transaction 不弹"；§6.3 又说"production 下所有非 read 语句
  // 都要确认"——两处冲突时取"不弹"：如果每次 COMMIT 都要输库名，用户必然把 5 分钟
  // 临时解除长开，安全带反而形同虚设。
  if (level === 'transaction') {
    return none
  }
  // 同一批次已经问过一次（多目标执行只弹一次）
  if (scope && state.asked && state.asked.has(scope)) {
    return none
  }
  // 低风险写被静音：只对 write + 非生产生效。
  // 生产连接不允许静音 —— 那正是安全带要覆盖的场景
  if (!production && level === 'write' && state.lowRiskMuted.has(connKey)) {
    return none
  }
  // 临时解除按连接判定（见 grantBypass 注释）
  if (isBypassed(state, connKey, now)) {
    return none
  }
  return {
    need: true,
    // 生产连接：write / ddl / dangerous / unknown 全部要输库名（比非生产更严，设计 §6.3）
    requireDbName: production,
    reason: reasonOf(level, production)
  }
}

/**
 * 授予临时解除。
 * 为什么 scope 传的是"连接身份"而不是"本次执行批次"：
 * 用户的动作是"这条生产连接我先放开 5 分钟"，如果只对某一次执行生效，
 * 点完下一句又要重输库名，功能等于不存在。
 * @param {Object} state guard 状态
 * @param {string} scope 连接身份键
 * @param {number} now 当前时间戳
 * @returns {number} 到期时间戳
 */
export function grantBypass (state, scope, now) {
  const t = Number.isFinite(now) ? now : 0
  const expireAt = t + BYPASS_TTL_MS
  state.bypass.set(String(scope || ''), expireAt)
  return expireAt
}

/**
 * 主动撤销临时解除（用户再点一次按钮 / 手动恢复）。
 * @param {Object} state guard 状态
 * @param {string} scope 连接身份键
 * @returns {void}
 */
export function clearBypass (state, scope) {
  state.bypass.delete(String(scope || ''))
}

/**
 * 临时解除是否仍然有效（过期即失效，并顺手清掉过期项）。
 * @param {Object} state guard 状态
 * @param {string} scope 连接身份键
 * @param {number} now 当前时间戳
 * @returns {boolean}
 */
export function isBypassed (state, scope, now) {
  const key = String(scope || '')
  const expireAt = state.bypass.get(key)
  if (expireAt === undefined) {
    return false
  }
  const t = Number.isFinite(now) ? now : 0
  if (expireAt <= t) {
    state.bypass.delete(key)
    return false
  }
  return true
}

/**
 * 临时解除剩余毫秒（工具条倒计时用）。
 * @param {Object} state guard 状态
 * @param {string} scope 连接身份键
 * @param {number} now 当前时间戳
 * @returns {number} 0 表示未生效/已过期
 */
export function bypassLeftMs (state, scope, now) {
  const expireAt = state.bypass.get(String(scope || ''))
  if (expireAt === undefined) {
    return 0
  }
  const t = Number.isFinite(now) ? now : 0
  return expireAt > t ? expireAt - t : 0
}

/**
 * 临时解除剩余分钟（向上取整：还剩 1 秒也要显示"剩余 1 分钟"，
 * 显示 0 会让用户以为已经恢复）。
 * @param {Object} state guard 状态
 * @param {string} scope 连接身份键
 * @param {number} now 当前时间戳
 * @returns {number}
 */
export function bypassLeftMinutes (state, scope, now) {
  const ms = bypassLeftMs(state, scope, now)
  return ms > 0 ? Math.ceil(ms / 60000) : 0
}

/**
 * 登记"这批已经问过"。
 * 为什么会淘汰最旧：asked 是"一批多目标只问一次"的记忆，作用域按执行批次自增，
 * 长时间使用会无限增长；只保留最近 50 个足够覆盖并发批次，
 * 淘汰最旧的影响上限也只是"很多批之前的 scope 再也不会重复出现"。
 * @param {Object} state guard 状态
 * @param {string} scope 作用域
 * @returns {Set<string>} 更新后的 asked
 */
export function markAsked (state, scope) {
  const key = String(scope || '')
  if (!key) {
    return state.asked
  }
  // 先删后加：把刚用过的 scope 挪到 Set 迭代序的尾部，淘汰时总是丢最旧的
  state.asked.delete(key)
  state.asked.add(key)
  while (state.asked.size > ASKED_LIMIT) {
    const oldest = state.asked.values().next()
    if (oldest.done) {
      break
    }
    state.asked.delete(oldest.value)
  }
  return state.asked
}

/**
 * 静音"低风险写"（write 级不再提示），本会话内该连接有效。
 * @param {Object} state guard 状态
 * @param {string} connKey 连接身份键
 * @returns {Object} state
 */
export function muteLowWrite (state, connKey) {
  state.lowRiskMuted.add(String(connKey || ''))
  return state
}

/**
 * 取消静音。
 * @param {Object} state guard 状态
 * @param {string} connKey 连接身份键
 * @returns {Object} state
 */
export function unmuteLowWrite (state, connKey) {
  state.lowRiskMuted.delete(String(connKey || ''))
  return state
}

/**
 * 清空全部状态（断开重连 / 会话关闭时用，避免把上一连接的安全设置带到新连接）。
 * @param {Object} state guard 状态
 * @returns {Object} state
 */
export function resetGuardState (state) {
  state.lowRiskMuted.clear()
  state.bypass.clear()
  state.asked.clear()
  return state
}

/**
 * 取消一个挂起的确认闸门（关 tab / 组件卸载时用）。
 *
 * 为什么要单独抽出来：`askRiskConfirm` 返回的 promise 只能由 `settleRiskGate` 解决，
 * 而它只在用户点按钮时被调用。弹窗还开着的时候用户切走或关掉这个 tab，
 * 那次 `runSql` 的 `await` 就永远挂着 —— 闭包里握着 `sql` 与 `risk` 对象，
 * 在标签页多的会话里是可累积的泄漏，DevTools 里也会留一堆永不 resolve 的 promise。
 *
 * **一律解析为 `false`（取消），不要 `true`**：卸载时绝不能让"未确认的执行"继续跑。
 * 这正是"取消"的语义 —— 没得到人确认就走零执行分支，与用户点"取消"完全一致。
 *
 * 入参是 ref 风格的持有者（`{ current }`）而不是裸 promise resolver：
 * 调用点必须能把它清空，否则下一次 `askRiskConfirm` 会拿到一个已经 settle 的旧 resolve。
 *
 * @param {{current: (null|function(boolean): void)}} holder 形如 React useRef 的持有者
 * @returns {boolean} 是否真的取消了一个挂起的闸门（便于调用方/测试断言）
 */
export function cancelPendingGate (holder) {
  const h = holder && typeof holder === 'object' ? holder : { current: null }
  const resolve = h.current
  h.current = null
  if (typeof resolve !== 'function') {
    return false
  }
  resolve(false)
  return true
}
