// #7 E1 执行闸门 / 危险 SQL 分级（cluster #7 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：把「执行前二次确认」这一件事收拢到一处 —— 危险 SQL 分级判定
// （classifySql）、连接级安全带状态（guardRef / 静音 / 临时解除 bypass）、
// 受控确认弹窗（riskGate + 挂起 promise）与四个闸门：
//   confirmSqlRisk   —— SQL 编辑器执行
//   confirmRowWrite  —— 行级写（单元格保存 / 插行 / 删行 / 变更集应用）
//   confirmRedisWrite—— Redis 类型化写 / 删键 / 改名 / 过期
//   confirmImportRisk—— 危险导入模式（overwrite / upsert）
// 四个闸门同源：shouldConfirm 决定"要不要问、问几次、要不要输库名"，
// askRiskConfirm 弹同一个 DbDangerConfirm，markAsked 记账。
// isProduction / connKey 是 tab 派生量，但只有本簇消费（connKey 另供 useDbView 记账），
// 随簇搬入并回流；redisDb 是 Redis 簇私有 state，用 getRedisDb 惰性取值避免 TDZ。
import { useEffect, useMemo, useRef, useState } from 'react'
import message from '../common/message'
import { classifySql } from '../../common/db-sql-risk'
import {
  BYPASS_TTL_MS,
  bypassLeftMinutes,
  cancelPendingGate,
  clearBypass,
  createGuardState,
  dbConnKey,
  grantBypass,
  isBypassed,
  markAsked,
  shouldConfirm
} from '../../common/db-safe-guard'

const e = window.translate

export function useDbGuard ({
  tab,
  sel,
  getRedisDb
}) {
  // ---- E1 危险 SQL 分级 + 连接级安全带 ----
  // guard 状态放 ref：lowRiskMuted / bypass / asked 都是内存开关，只在事件回调里读写，
  // 不需要参与渲染（倒计时另用 tick 触发重渲染）
  const guardRef = useRef(null)
  if (guardRef.current === null) {
    guardRef.current = createGuardState()
  }
  // 危险确认弹窗的受控状态：null = 不显示；非 null 时 riskResolveRef 里挂着等待中的 promise
  const [riskGate, setRiskGate] = useState(null)
  const riskResolveRef = useRef(null)
  // 卸载（关 tab / 切连接）时把挂起的闸门解析为 false。
  // 不清理的后果很具体：弹窗还开着的时候用户关掉这个 tab，`runSql` 里那次 `await`
  // 永远不 settle —— 闭包握着 sql 与 risk 对象，DevTools 里留一堆永不 resolve 的 promise，
  // 标签页多的会话里会累积。解析成 false（取消）而不是 true：卸载绝不能让
  // "用户还没确认的执行"继续跑，这与用户点"取消"是同一条零执行分支。
  useEffect(() => () => cancelPendingGate(riskResolveRef), [])
  // 生产标记来自书签（tab 由书签展开），只认严格 true：
  // 旧书签没有该字段时为 undefined，必须视为非生产
  const isProduction = tab.production === true
  // 连接身份：mute 与"临时解除"都按它记账（见 db-safe-guard 注释）
  const connKey = useMemo(
    () => dbConnKey(tab),
    [tab.dbType, tab.dbHost, tab.dbPort, tab.dbUser, tab.dbName, tab.dbFile]
  )

  // ---- E1 执行闸门（设计 §6.2 / §6.3 / §6.4）----

  // 每次执行都是一个新批次：scope 带自增序号，避免上一批的"已问过"吞掉本批弹窗
  const scopeSeqRef = useRef(0)
  const nextScope = kind => kind + ':' + (++scopeSeqRef.current)

  // 弹一次确认并等用户决定；取消/关闭都解析为 false（零执行）
  const askRiskConfirm = payload => {
    // 上一个闸门还没结束（用户连点两次"运行"）：先把旧的按取消处理，
    // 否则那次 runSql 的 promise 永远不 settle，一次执行挂在半路
    const prev = riskResolveRef.current
    if (prev) {
      riskResolveRef.current = null
      prev(false)
    }
    return new Promise(resolve => {
      riskResolveRef.current = resolve
      setRiskGate(payload)
    })
  }

  const settleRiskGate = ok => {
    const resolve = riskResolveRef.current
    riskResolveRef.current = null
    setRiskGate(null)
    if (resolve) {
      resolve(ok)
    }
  }

  // SQL 执行闸门：返回 true 才继续。
  // 只读模式下执行入口本就被编辑器禁用、主进程白名单还会二次拦，这里不弹（验收 §6.5 第 5 条）。
  // Redis 写操作走独立的 confirmRedisWrite（同机制，库名用当前 db index 充当）
  const confirmSqlRisk = async (sql, database) => {
    const risk = classifySql(sql, tab.dbType)
    const state = guardRef.current
    const scope = nextScope('sql')
    const verdict = shouldConfirm({
      level: risk.level,
      production: isProduction,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need || !risk.statements.length) {
      return true
    }
    const ok = await askRiskConfirm({
      level: risk.level,
      requireDbName: verdict.requireDbName,
      dbName: database,
      statements: risk.statements,
      reasons: risk.reasons,
      // shouldConfirm 已经算好"为什么拦"（生产 / 首次写 / ddl 每次 / 高危每次 / 认不出），
      // 不传下去它就只是白算：用户看到的弹窗在五种情形下长得一模一样，只会无脑点
      // "仍要执行" —— 安全带退化成确认噪音。reason 与 reasons 是两件事：
      // reason = 「为什么要问你」，reasons = 「这条 SQL 凭什么被判成这个级别」
      reason: verdict.reason,
      // 静音只对"非生产的低风险写"开放：生产连接正是安全带要覆盖的场景
      allowMute: !isProduction && risk.level === 'write'
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // 行级写（单元格保存 / 插行 / 删行）在 production 连接上再过一道确认。
  // 复用同一个弹窗：它表达的是"执行前给人看"，不是 SQL 编辑器专属 UI。
  // N2 之后一段批（变更集应用）也走这里：payload.texts 给多条语句，弹窗本来就是列表式的
  // （SQL 页一次执行多条语句用的就是它），按条数弹 N 次只会训练用户连点确认。
  const confirmRowWrite = async payload => {
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('row')
    const verdict = shouldConfirm({
      level: payload.level,
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need) {
      return true
    }
    const texts = payload.texts || [payload.text]
    const ok = await askRiskConfirm({
      level: payload.level,
      requireDbName: verdict.requireDbName,
      dbName: (sel && sel.database) || tab.dbName || '',
      statements: texts.map(text => ({ text, level: payload.level, firstKeyword: '' })),
      reasons: [payload.note],
      // 行级写同样要说清"为什么问你"：production 首次写 vs ddl 每次，用户的反应不一样
      reason: verdict.reason,
      allowMute: false
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // Redis 类型化写 / 删除 / 改名 / 过期，在 production 连接上再过一道确认。
  // 复用同一弹窗与判定（DbDangerConfirm + shouldConfirm）：Redis 没有"表"概念，
  // 库名用当前选中的 db index 充当（Redis 的 database 就是数字 db index，
  // 与生产 MySQL 输库名同语义）。非 production 直接放行，与 confirmRowWrite 同口径。
  const confirmRedisWrite = async payload => {
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('redis')
    const verdict = shouldConfirm({
      level: payload.level,
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    const ok = await askRiskConfirm({
      level: payload.level,
      requireDbName: verdict.requireDbName,
      dbName: String(getRedisDb()),
      statements: [{ text: payload.text, level: payload.level, firstKeyword: '' }],
      reasons: [payload.note],
      reason: verdict.reason,
      allowMute: false
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // 生产标记 + 临时解除倒计时。bumpBypass 只是"到点重渲染"的触发器（值本身不用，
  // 故解构丢弃）；只有生效期才起定时器，常态不空转
  const [, bumpBypass] = useState(0)
  const bypassMinutes = isProduction
    ? bypassLeftMinutes(guardRef.current, connKey, Date.now())
    : 0
  useEffect(() => {
    if (!isProduction || bypassMinutes <= 0) {
      return undefined
    }
    const timer = setInterval(() => bumpBypass(v => v + 1), 30000)
    return () => clearInterval(timer)
  }, [isProduction, bypassMinutes])

  const toggleProductionBypass = () => {
    const state = guardRef.current
    const now = Date.now()
    if (isBypassed(state, connKey, now)) {
      clearBypass(state, connKey)
    } else {
      grantBypass(state, connKey, now)
      message.warning(
        e('dbRiskBypassOn').replace('{n}', String(Math.round(BYPASS_TTL_MS / 60000)))
      )
    }
    bumpBypass(v => v + 1)
  }

  // 危险导入模式（overwrite/upsert）的 production 闸门：复用 E1 riskGate 弹窗
  // （shouldConfirm 决定要不要问、问几次；输库名那条路径由 DbDangerConfirm 承担）。
  // 取消 = 零调用：对话框收不到放行信号就不会发起 start
  const confirmImportRisk = async (mode) => {
    const note = mode === 'overwrite' ? e('dbImportModeOverwrite') : e('dbImportModeUpsert')
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('import')
    const verdict = shouldConfirm({
      level: 'write',
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need) {
      return true
    }
    const target = `${mode} ${(sel && sel.database) || tab.dbName || ''}.${sel && sel.table}`
    const ok = await askRiskConfirm({
      level: 'write',
      requireDbName: verdict.requireDbName,
      dbName: (sel && sel.database) || tab.dbName || '',
      statements: [{ text: target, level: 'write', firstKeyword: '' }],
      reasons: [note],
      reason: verdict.reason,
      allowMute: false
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  return {
    guardRef,
    riskGate,
    settleRiskGate,
    confirmSqlRisk,
    confirmRowWrite,
    confirmRedisWrite,
    confirmImportRisk,
    isProduction,
    connKey,
    bypassMinutes,
    toggleProductionBypass
  }
}
