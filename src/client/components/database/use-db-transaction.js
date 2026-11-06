// F2 手动事务：连接钉住 + 待提交清单（cluster #6 of 设计-db-session拆分方案-N11a）。
// 从 db-session.jsx 的「F2 手动事务」段原样搬出，行为零变更：两个 useEffect 的依赖数组、
// 6 个 handler 函数体、2000/5000ms 轮询周期、消息文案与确认顺序全部不变。
//
// 句柄归属（AGENTS.md §5.2.4）：页面级 state / ref 由 owner（DbSession）持有并注入，
// hook 不自建、不回流。事务状态以主进程为权威，前端只负责轮询展示 + 操作入口。
import { useEffect } from 'react'
import { Modal } from 'antd'
import message from '../common/message'

const e = window.translate

export function useDbTransaction ({
  tabId,
  isRedis,
  onOpError,
  sel,
  grid,
  loadWithCount,
  txState,
  setTxState,
  setTxBusy,
  setTxListOpen,
  txNotifiedAtRef
}) {
  const txSupported = !isRedis
  const txActive = !!(txState && txState.active)
  const txPending = (txState && txState.pendingCount) || 0

  useEffect(() => {
    if (!txSupported || !tabId) {
      return undefined
    }
    let dead = false
    const tick = () => {
      window.pre.runGlobalAsync('dbClientOp', tabId, 'getDbTxState')
        .then(st => {
          if (!dead && st) {
            setTxState(st)
          }
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, txActive ? 2000 : 5000)
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [txSupported, tabId, txActive])

  // 空闲自动回滚只提示一次（lastTx 带 at 时间戳去重）
  useEffect(() => {
    const lt = txState && txState.lastTx
    if (!lt || !lt.auto || txNotifiedAtRef.current === lt.at) {
      return
    }
    txNotifiedAtRef.current = lt.at
    message.warning(e('dbTxAutoRolledBack').replace('{n}', String(lt.count || 0)))
  }, [txState])

  // 提交/回滚后当前页数据可能已变（回滚=改动作废），按当前条件重取
  const afterTxEnd = (msgKey) => {
    message.success(e(msgKey))
    setTxListOpen(false)
    setTxState(s => ({ ...(s || {}), active: false, pendingCount: 0, statements: [] }))
    if (sel) {
      loadWithCount(sel, grid.page)
    }
  }

  const runTxOp = (op, onOk) => {
    setTxBusy(true)
    window.pre.runGlobalAsync('dbClientOp', tabId, op)
      .then(onOk)
      .catch(err => onOpError(err))
      .finally(() => setTxBusy(false))
  }

  const beginTx = () => {
    runTxOp('beginDbTx', () => {
      message.success(e('dbTxBegun'))
      setTxState(s => ({ ...(s || {}), active: true, pendingCount: 0, statements: [] }))
    })
  }

  const commitTx = () => runTxOp('commitDbTx', () => afterTxEnd('dbTxCommitted'))
  const rollbackTx = () => runTxOp('rollbackDbTx', () => afterTxEnd('dbTxRolledBack'))

  const setManualTx = (on) => {
    if (on) {
      // 上限由主进程判定并报错，这里先按轮询到的全局计数给一次更早的提示
      if (txState && txState.pinnedTabs >= txState.maxTabs) {
        message.warning(e('dbTxLimit').replace('{max}', String(txState.maxTabs)))
        return
      }
      Modal.confirm({
        title: e('dbTxBeginTitle'),
        content: e('dbTxBeginContent'),
        okText: e('dbTxBegin'),
        cancelText: e('cancel'),
        onOk: beginTx
      })
      return
    }
    if (!txPending) {
      rollbackTx()
      return
    }
    Modal.confirm({
      title: e('dbTxRollbackTitle'),
      content: e('dbTxRollbackWarn').replace('{n}', String(txPending)),
      okText: e('dbTxRollback'),
      cancelText: e('cancel'),
      okButtonProps: { danger: true },
      onOk: rollbackTx
    })
  }

  return { txSupported, txActive, txPending, setManualTx, commitTx, rollbackTx }
}
