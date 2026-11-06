/**
 * N2 暂存变更（变更集）与统一应用的页面侧接线。
 *
 * 分工：变更集的算法与预览语句都在纯模块（db-change-set / db-change-preview），
 * 这个 hook 只做三件事 —— 持有状态、把意图转成 op 调用、把结果讲给人听。
 *
 * 为什么"应用"仍走既有 op（updateCell/updateCells/insertRow/deleteRows）而不是
 * 拼一批 SQL 交给 executeSql：op 的参数化构造、只读闸门、行数上限都在主进程，
 * 前端另写一条执行路径就会出现"预览是 A、执行是 B"（设计 N2 要点 1 要避免的正是这个）。
 *
 * 与 F2 手动事务的叠加规则（本项最大设计风险，代码里必须看得见）：
 * - 手动事务开着 → 应用就是把语句发进那个事务，主进程事务清单成为权威，
 *   变更集只负责"还没发出去的部分"；
 * - 手动事务没开且多于一条 → 我们自己 begin/commit 包一层（失败整体回滚，
 *   变更集原样留着可重试）；
 * - 只有单条 / 引擎不支持事务 → 直接执行，成功即从变更集收干。
 */
import { useMemo, useState } from 'react'
import { Modal } from 'antd'
import message from '../common/message'
import {
  createChangeSet,
  stageCell,
  stageCells,
  stageInsert,
  stageDelete,
  dropChange,
  dropChanges,
  dropGroup,
  clearChangeSet,
  countChanges,
  listChanges,
  planSubmit,
  canStage
} from '../../common/db-change-set'

const e = window.translate

export function useDbChanges (deps) {
  const {
    tabId,
    sel,
    pkColumn,
    isReadonly,
    isRedis,
    txSupported,
    txActive,
    refresh,
    confirmBatch,
    onError
  } = deps

  const [stageOn, setStageOn] = useState(false)
  const [staged, setStaged] = useState(createChangeSet)
  const [applying, setApplying] = useState(false)

  const stageEnabled = canStage({ readOnly: isReadonly, pkColumn, isRedis })
  const count = useMemo(() => countChanges(staged), [staged])
  const groups = useMemo(() => listChanges(staged), [staged])

  // 暂存只在"开关打开 + 引擎可暂存"时接管写操作；否则调用方继续走即时执行
  const staging = stageOn && stageEnabled
  const target = sel ? { database: sel.database, schema: sel.schema || '', table: sel.table } : null

  const run = (op, args) => window.pre.runGlobalAsync('dbClientOp', tabId, op, args)

  const sayStaged = () => {
    message.success(e('dbChangesStaged'))
  }

  const toggleStage = (on) => {
    setStageOn(on)
    message.info(e(on ? 'dbStageOn' : 'dbStageOff'))
  }

  /** 单元格改动：true = 已消费（调用方不要再执行） */
  const stageCellEdit = (o) => {
    if (!staging || !target) {
      return false
    }
    const r = stageCell(staged, {
      target,
      pkColumn,
      pkValue: o.pkValue,
      column: o.column,
      value: o.value
    })
    if (!r.ok) {
      if (r.reason === 'deleted') {
        message.warning(e('dbChangesDeletedRow'))
      }
      return false
    }
    setStaged(r.set)
    sayStaged()
    return true
  }

  /** 批量改值 / 查找替换产出的一批 { pk, value } */
  const stageUpdates = (o) => {
    if (!staging || !target) {
      return false
    }
    const r = stageCells(staged, {
      target,
      pkColumn,
      column: o.column,
      updates: o.updates
    })
    if (!r.added) {
      message.warning(e('dbChangesDeletedRow'))
      return false
    }
    setStaged(r.set)
    message.success(e('dbChangesStagedN').replace('{n}', String(r.added)))
    return true
  }

  /** 新增行（payload = buildInsertPayload 的产出） */
  const stageInsertRow = (payload) => {
    if (!staging || !target) {
      return false
    }
    const r = stageInsert(staged, { target, payload })
    if (!r.ok) {
      return false
    }
    setStaged(r.set)
    sayStaged()
    return true
  }

  /** 删除选中行 */
  const stageDeleteRows = (pkValues) => {
    if (!staging || !target) {
      return false
    }
    const r = stageDelete(staged, { target, pkColumn, pkValues })
    if (!r.ok) {
      return false
    }
    setStaged(r.set)
    if (r.droppedCells) {
      message.warning(e('dbChangesVoidedByDelete').replace('{n}', String(r.droppedCells)))
    }
    message.success(e('dbChangesStagedN').replace('{n}', String(r.count)))
    return true
  }

  const revert = (id) => setStaged(s => dropChange(s, id))
  const revertTable = (key) => setStaged(s => dropGroup(s, key))

  const discardAll = () => {
    if (!count) {
      return
    }
    Modal.confirm({
      title: e('dbChangesCloseTitle'),
      content: e('dbChangesCloseWarn').replace('{n}', String(count)),
      okText: e('dbChangesDiscard'),
      cancelText: e('cancel'),
      okButtonProps: { danger: true },
      onOk: () => setStaged(s => clearChangeSet(s))
    })
  }

  /**
   * 应用：先给一次批量确认（E1 闸门按批而不是按条 —— 10 条改动弹 10 次窗只会训练用户
   * 连点确认），再按 planSubmit 的顺序逐条走 op。
   */
  const apply = async () => {
    const items = []
    listChanges(staged).forEach(g => g.items.forEach(it => items.push(it)))
    if (!items.length) {
      message.info(e('dbChangesNothing'))
      return
    }
    const hasDelete = items.some(it => it.kind === 'delete')
    const ok = await confirmBatch({
      // 含删除的批次定为 dangerous：一次应用可能同时改值又删行，
      // 按最狠的那条定级，不按条数稀释
      level: hasDelete ? 'dangerous' : 'write',
      texts: items.map(it => it.sql),
      note: e('dbChangesConfirmWarn').replace('{n}', String(items.length))
    })
    if (!ok) {
      return
    }
    // 自己包事务的条件：引擎支持 + 当前没开手动事务 + 多于一条（单条包事务纯属多余，
    // 还会把连接钉住 10 分钟）
    const wrap = txSupported && !txActive && items.length > 1
    const inTx = txActive || wrap
    const plan = planSubmit(staged, { inTransaction: inTx })
    setApplying(true)
    let opened = false
    let doneIds = []
    const failedIds = []
    try {
      if (wrap) {
        await run('beginDbTx')
        opened = true
      }
      for (const step of plan) {
        const res = await run(step.op, step.args)
        doneIds = doneIds.concat(step.ids)
        // updateCells 的散值路径不抛错，逐行失败在 res.failed 里：
        // 失败的那些行没有落库，必须留在变更集里（ids 与 updates 同序，按 pk 对齐）
        const failed = (res && res.failed) || []
        if (failed.length) {
          const bad = new Set(failed.map(f => JSON.stringify(f.pk)))
          step.ids.forEach((id, i) => {
            const pk = (step.args.updates[i] || {}).pk
            if (bad.has(JSON.stringify(pk))) {
              failedIds.push(id)
            }
          })
          break
        }
      }
      if (opened) {
        try {
          await run('commitDbTx')
        } catch (err2) {
          // COMMIT 自己失败：语句已经在事务里执行过，提交结果未定 —— 这里**不**回滚也
          // **不**收干变更集，权威交给 F2 事务清单（连接还钉着，用事务开关去提交或回滚）
          message.error(e('dbChangesCommitFailed'))
          onError(err2)
          refresh()
          return
        }
      }
      setStaged(s => dropChanges(s, doneIds))
      message.success(e('dbChangesApplied').replace('{n}', String(doneIds.length - failedIds.length)))
      if (failedIds.length) {
        message.warning(e('dbChangesPartial').replace('{ok}', String(doneIds.length - failedIds.length))
          .replace('{left}', String(count - doneIds.length + failedIds.length)))
      }
      refresh()
    } catch (err) {
      if (opened) {
        // 我们包的事务：中途抛错就整体回滚，数据库回到应用前，变更集原样留着可重试
        await run('rollbackDbTx').catch(() => {})
        message.warning(e('dbChangesRolledBack'))
      } else if (doneIds.length) {
        // 已经真的执行掉的部分要从变更集收干，否则重试会二次执行（改值幂等，删行/插行不是）
        setStaged(s => dropChanges(s, doneIds.filter(id => !failedIds.includes(id))))
        message.warning(e('dbChangesPartial').replace('{ok}', String(doneIds.length - failedIds.length))
          .replace('{left}', String(count - doneIds.length + failedIds.length)))
      }
      onError(err)
      refresh()
    } finally {
      setApplying(false)
    }
  }

  return {
    stageEnabled,
    stageOn,
    toggleStage,
    count,
    groups,
    stageCellEdit,
    stageUpdates,
    stageInsertRow,
    stageDeleteRows,
    revert,
    revertTable,
    discardAll,
    apply,
    applying,
    hasStaged: count > 0
  }
}
