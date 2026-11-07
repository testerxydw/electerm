// #9 外键引用侧栏（cluster #9 of 设计-db-session拆分方案-N11b / 设计 §8 F1）。
//
// 这一簇是「当前单元格的两方向引用」这一个职责域：
//   refInfo     反向引用（"哪些表指向本表"）：按 表+列 懒拉并缓存，
//               换单元格但列不变时复用 —— 避免每次点单元格都打一次 catalog
//   refItems    两方向引用项：父行（本表外键 → 父表）本地可算；子记录依赖 refInfo
//   showRefTab  页签可见性：有本地外键 / 反向引用非空 / 降级提示时才显示
//
// 目录查询失败等同降级（页签隐藏 + 一行提示），不影响主流程。
//
// 行为零变更：整段逐字搬迁（原 387–454，68 行）。
//
// 不回流（仅本簇内部使用）：setRefInfo / refsKeyRef。
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildRefItems } from './db-ref-utils'

export function useDbForeignRefs ({
  isRedis,
  sel,
  selectedCell,
  tabId,
  grid,
  structureV2,
  dialect
}) {
  // ---- F1 外键引用侧栏（设计 §8） ----
  // 反向引用（"哪些表指向本表"）按 表+列 懒拉取并缓存：
  // 换单元格但列不变时复用结果，避免每次点单元格都打一次 catalog
  const [refInfo, setRefInfo] = useState({ loading: false, references: [], degraded: false })
  const refsKeyRef = useRef('')
  useEffect(() => {
    if (isRedis || !sel || !selectedCell || !selectedCell.col) {
      refsKeyRef.current = ''
      return undefined
    }
    const key = [sel.database || '', sel.schema || '', sel.table || '', selectedCell.col].join('\u0000')
    if (refsKeyRef.current === key) {
      return undefined
    }
    refsKeyRef.current = key
    let cancelled = false
    setRefInfo({ loading: true, references: [], degraded: false })
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getReferences', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      columns: [selectedCell.col]
    }).then(res => {
      if (cancelled) {
        return
      }
      setRefInfo({
        loading: false,
        references: (res && Array.isArray(res.references)) ? res.references : [],
        degraded: !!(res && res.degraded)
      })
    }).catch(() => {
      if (cancelled) {
        return
      }
      // 目录查询失败等同降级：页签隐藏 + 一行提示，不影响主流程
      setRefInfo({ loading: false, references: [], degraded: true })
    })
    return () => {
      cancelled = true
    }
  }, [isRedis, sel, selectedCell && selectedCell.col, tabId])
  // 两方向的引用项：父行（本表外键 → 父表）本地可算；子记录依赖 refInfo
  const refItems = useMemo(() => {
    if (isRedis || !selectedCell || !sel) {
      return []
    }
    const row = grid.rows[selectedCell.rowKey]
    if (!row) {
      return []
    }
    return buildRefItems({
      column: selectedCell.col,
      row,
      foreignKeys: structureV2.foreignKeys || [],
      references: refInfo.references,
      database: sel.database,
      schema: sel.schema || '',
      dialect
    })
  }, [isRedis, selectedCell, grid.rows, structureV2.foreignKeys, refInfo.references, sel, dialect])
  // 页签可见性：本表有外键（本地 FK 即刻可判）或反向引用非空时显示；
  // 两者皆无 → 隐藏；降级（目录不可读）且无本地外键 → 隐藏 + 一行提示
  const showRefTab = !isRedis && !!selectedCell && (
    (structureV2.foreignKeys || []).length > 0 ||
    refInfo.references.length > 0 ||
    refInfo.degraded
  )
  return {
    refInfo,
    refItems,
    showRefTab
  }
}
