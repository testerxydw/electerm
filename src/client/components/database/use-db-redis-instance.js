// #26 Redis / 结构视图弹层：ER 图 + 结构对比（cluster #26 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「整库快照类弹层」这一个职责域 —— 两个弹层都不属于哪张表，
// 打开时按当前库/schema 拉一次，关掉就作废在途请求：
//   ER 图      er / erTokenRef / loadErGraph / openErGraph / closeErGraph
//              取数走 listForeignKeys（MySQL information_schema / PG pg_constraint）
//   结构对比   structDiff / loadDiffStructure / openStructureDiff / closeStructureDiff
//              取数走 getTableStructure + refresh:true（跳过 60s 结构缓存，否则刚
//              ALTER 过的表会拿旧结构对比，得出看不出来的错误结论）
//
// 与 #25（Redis 键浏览）的边界：redisInfo / redisSlowlog 这次**不搬**。
// 那两块虽然也在这两段区间里，但它们的令牌 ref 被 useDbRedisKeys 直接 ++
// （use-db-redis-keys.js:358 关闭弹层时作废在途慢日志请求），属于双向依赖，
// 单独做会制造「一半在 hook、一半在形参」的中间态，并入 #25 一次处理。
//
// 行为零变更：两段逐字搬迁（state 原 645–651 共 7 行，handler 原 2027–2089 共 63 行）。
//
// 不回流（仅本簇内部使用）：setEr / setStructDiff / erTokenRef。
//
// 依赖只有两个：tabId、sel（都在 owner 第 260 行之前定义，所以本 hook 可以
// 紧贴原 state 位置调用，与搬迁前的 TDZ 处境完全一致）。
import { useCallback, useRef, useState } from 'react'
import { cleanDbError } from './db-conn-error'

export function useDbRedisInstance ({ tabId, sel }) {
  // H3b-3：ER 图。图是整个库/schema 的一张快照，与"当前在看哪张表"无关，
  // 所以打开时按当前库拉一次即可；令牌管"连点刷新时旧响应不覆盖新响应"
  const [er, setEr] = useState({ open: false, loading: false, error: '', graph: null })
  const erTokenRef = useRef(0)
  // H4：结构对比。两张表的选择、取数与差异状态都在弹层里；这里只提供表清单、
  // 取数通道和"从哪张表开始比"
  const [structDiff, setStructDiff] = useState({ open: false, base: null })

  // H3b-3：ER 图取数。只发 listForeignKeys（MySQL 走 information_schema，
  // PG 走 pg_constraint），范围是当前库/schema —— 图里的表与本页选中的表无关，
  // 换表不用重拉，换库才需要（关闭再打开就是新的一次）。
  const loadErGraph = () => {
    if (!sel || !sel.database) {
      return
    }
    const target = { database: sel.database, schema: sel.schema || '' }
    erTokenRef.current++
    const token = erTokenRef.current
    setEr(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'listForeignKeys', target).then(graph => {
      if (token !== erTokenRef.current) {
        return
      }
      setEr({ open: true, loading: false, error: '', graph: graph || null })
    }).catch(err => {
      if (token !== erTokenRef.current) {
        return
      }
      // 失败保留上一张图：刷新失败不该把还能看的东西一起收走，报错条会说明情况
      setEr(s => ({
        ...s,
        open: true,
        loading: false,
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }

  const openErGraph = () => {
    // 先清空旧图：换库后打开，上一张图闪一下再被顶掉会被当成"新库就长这样"
    setEr({ open: true, loading: true, error: '', graph: null })
    loadErGraph()
  }

  const closeErGraph = () => {
    // 关闭即作废在途请求：关掉再打开不该先看到上一次请求的结果
    erTokenRef.current++
    setEr({ open: false, loading: false, error: '', graph: null })
  }

  // H4：结构对比取数。refresh 让主进程跳过结构缓存 —— 刚 ALTER 过的表在 60s
  // TTL 内还会返回旧结构，拿它对比会得出看不出来的错误结论
  const loadDiffStructure = useCallback(target => window.pre.runGlobalAsync(
    'dbClientOp', tabId, 'getTableStructure', {
      database: target.database,
      schema: target.schema || '',
      table: target.table,
      refresh: true
    }
  ), [tabId])

  const openStructureDiff = () => {
    setStructDiff({
      open: true,
      base: sel ? { database: sel.database, schema: sel.schema || '', table: sel.table } : null
    })
  }

  const closeStructureDiff = () => {
    setStructDiff({ open: false, base: null })
  }
  return {
    er,
    loadErGraph,
    openErGraph,
    closeErGraph,
    structDiff,
    loadDiffStructure,
    openStructureDiff,
    closeStructureDiff
  }
}
