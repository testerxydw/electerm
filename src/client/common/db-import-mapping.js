/**
 * C 批导入映射的纯逻辑层（db-import-dialog 的可测部分，设计 §10）
 *
 * 对话框里的映射行是 UI 形态（下拉选模式 + 各模式的输入框），发往主进程前
 * 要折算成 db-importer.normalizeMapping 认的 mapping 数组。折算与校验规则
 * 放在这里（零依赖纯函数），单测跑真实源码，UI 层只消费。
 *
 * 映射行（UI）：
 *   { fileCol, mode: 'field'|'ignore'|'constant'|'expression'|'null',
 *     target: '目标列名'（field 模式）, objCol: '目标列名'（constant/expression/null）,
 *     constVal: '常量值', exprSql: 'SQL 片段' }
 *
 * 后端 mapping（db-importer 约定）：
 *   { fileCol, target: '列名' | null | {mode,value?,sql?,column?} }
 */

// 表单形态 → 后端 mapping。折算即校验：结构不完整直接抛错（消息即 UI 提示文案 key）
export function buildImportMapping (rows) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  for (const r of list) {
    if (!r || r.fileCol === undefined || r.fileCol === null) {
      continue
    }
    const fileCol = String(r.fileCol)
    if (r.mode === 'ignore' || r.mode === undefined) {
      continue
    }
    if (r.mode === 'field') {
      if (!r.target) {
        throw new Error('dbImportMappingNoTarget')
      }
      out.push({ fileCol, target: String(r.target) })
      continue
    }
    if (r.mode === 'constant') {
      const column = r.objCol ? String(r.objCol) : fileCol
      if (!column) {
        throw new Error('dbImportMappingNoTarget')
      }
      out.push({
        fileCol,
        target: { mode: 'constant', value: r.constVal === undefined ? null : r.constVal, column }
      })
      continue
    }
    if (r.mode === 'expression') {
      const column = r.objCol ? String(r.objCol) : fileCol
      if (!column) {
        throw new Error('dbImportMappingNoTarget')
      }
      const sql = String(r.exprSql || '').trim()
      if (!sql) {
        throw new Error('dbImportMappingNoExpr')
      }
      out.push({ fileCol, target: { mode: 'expression', sql, column } })
      continue
    }
    if (r.mode === 'null') {
      const column = r.objCol ? String(r.objCol) : fileCol
      if (!column) {
        throw new Error('dbImportMappingNoTarget')
      }
      out.push({ fileCol, target: { mode: 'null', column } })
      continue
    }
    throw new Error('dbImportMappingUnknownMode')
  }
  if (!out.length) {
    throw new Error('dbImportMappingEmpty')
  }
  return out
}

// 折算失败时的消息（文案 key），成功返回 null —— UI 据此禁用"开始导入"
export function mappingProblem (rows) {
  try {
    buildImportMapping(rows)
    return null
  } catch (err) {
    return err.message
  }
}

// upsert 前置条件：目标表有主键，且全部主键列都被 field 形态映射覆盖
// （缺主键的行没法写 ON CONFLICT，缺映射的 pk 列会让冲突判定落空）
export function pkCovered (pkColumns, rows) {
  const pks = (Array.isArray(pkColumns) ? pkColumns : [])
    .map(p => String(p).trim().toLowerCase())
    .filter(Boolean)
  if (!pks.length) {
    return false
  }
  const mapped = new Set(
    (Array.isArray(rows) ? rows : [])
      .filter(r => r && r.mode === 'field' && r.target)
      .map(r => String(r.target).trim().toLowerCase())
  )
  return pks.every(p => mapped.has(p))
}
