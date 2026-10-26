/**
 * F1 外键引用侧栏：纯计算（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §8）
 *
 * 两个方向（"谁引用谁"必须分开命名，避免歧义）：
 * - 被引用父行（dir=parent）：当前列属于本表外键 → 父表对应行（WHERE refPk = 本行fk值）；
 *   数据源是 getTableStructure 返回的 foreignKeys（本表外键，本地即可计算）。
 * - 引用子记录（dir=child）：其他表的外键指向本表 → 每条外键一个分组
 *   （WHERE 子表fk列 = 本行值）；数据源是 getReferences op 的反向查询结果。
 *
 * 复合外键只支持全列等值匹配：两方向的定位值都取自**当前选中行**，
 * 复合外键的每一列都能拿到值，因此天然支持全列等值；任一列值缺失/为 NULL/
 * 为二进制信封时该项标记 unusable（侧栏显示原因，不发起查询）。
 *
 * 目标表归一（与分页取数 getPageData 的入参对齐）：
 * - mysql 家族：database 承载库名，schema 恒为空串；
 * - postgres：database 为当前连接库，schema 为目标表所在 schema。
 */

export function isPlainValue (v) {
  if (v === null || v === undefined) {
    return false
  }
  if (typeof v === 'object') {
    return false
  }
  return true
}

// 值不可用于定位时的提示 key：NULL 与二进制分开说（原因不同，文案不同）
function unusableReason (v) {
  if (v === null || v === undefined) {
    return 'dbRefNull'
  }
  if (typeof v === 'object') {
    return 'dbRefBinary'
  }
  return ''
}

function hasOwn (row, key) {
  return !!row && Object.prototype.hasOwnProperty.call(row, key)
}

/**
 * 由当前选中行 + 本表外键 + 反向引用，算出「关联」侧栏的展示清单。
 * @param {Object} opts
 * @param {string} opts.column 当前选中列名
 * @param {Object} opts.row 当前选中行的完整数据（列名 → 值）
 * @param {Array} opts.foreignKeys 本表外键（getTableStructure → foreignKeys 契约）
 * @param {Array} opts.references 反向引用（getReferences → references）
 * @param {string} opts.database 当前库名（mysql 家族同时是 schema 名）
 * @param {string} opts.schema 当前 schema（pg）
 * @param {string} opts.dialect 'mysql' | 'postgres'
 * @returns {Array} [{ key, dir, fkName, target, whereColumns, whereValues, mapping, unusable }]
 */
export function buildRefItems ({
  column,
  row,
  foreignKeys = [],
  references = [],
  database = '',
  schema = '',
  dialect = 'mysql'
}) {
  const col = String(column || '')
  const items = []
  if (!col || !row) {
    return items
  }
  const isPg = dialect === 'postgres'
  const fks = Array.isArray(foreignKeys) ? foreignKeys : []
  const refs = Array.isArray(references) ? references : []

  // 方向一：被引用父行 —— 本表外键的本地列包含选中列
  for (const fk of fks) {
    const locals = Array.isArray(fk && fk.columns) ? fk.columns.map(String) : []
    const refCols = Array.isArray(fk && fk.refColumns) ? fk.refColumns.map(String) : []
    if (!locals.includes(col) || !refCols.length || locals.length !== refCols.length) {
      continue
    }
    const refTable = String((fk && fk.refTable) || '')
    if (!refTable) {
      continue
    }
    const pairs = locals.map((local, i) => ({ local, target: refCols[i] }))
    let reason = ''
    for (const p of pairs) {
      if (!hasOwn(row, p.local)) {
        reason = 'dbRefNull'
        break
      }
      const r = unusableReason(row[p.local])
      if (r) {
        reason = r
        break
      }
    }
    items.push({
      key: 'out:' + String((fk && fk.name) || '') + ':' + refTable,
      dir: 'parent',
      fkName: String((fk && fk.name) || ''),
      target: {
        database: isPg ? database : (fk.refSchema || database),
        schema: isPg ? (fk.refSchema || schema || 'public') : '',
        table: refTable
      },
      whereColumns: pairs.map(p => p.target),
      whereValues: pairs.map(p => row[p.local]),
      mapping: pairs.map(p => p.local + ' → ' + refTable + '.' + p.target).join(', '),
      unusable: reason
    })
  }

  // 方向二：引用子记录 —— 反向引用的 refColumns（本表列）包含选中列
  for (const ref of refs) {
    const childCols = Array.isArray(ref && ref.columns) ? ref.columns.map(String) : []
    const parentCols = Array.isArray(ref && ref.refColumns) ? ref.refColumns.map(String) : []
    if (!parentCols.includes(col) || !childCols.length || childCols.length !== parentCols.length) {
      continue
    }
    const childTable = String((ref && ref.table) || '')
    if (!childTable) {
      continue
    }
    const pairs = childCols.map((child, i) => ({ local: parentCols[i], target: child }))
    let reason = ''
    for (const p of pairs) {
      if (!hasOwn(row, p.local)) {
        reason = 'dbRefNull'
        break
      }
      const r = unusableReason(row[p.local])
      if (r) {
        reason = r
        break
      }
    }
    const childSchema = String((ref && ref.schema) || '')
    items.push({
      key: 'in:' + childSchema + '.' + childTable + '.' + String((ref && ref.fkName) || ''),
      dir: 'child',
      fkName: String((ref && ref.fkName) || ''),
      target: {
        database: isPg ? database : (childSchema || database),
        schema: isPg ? (childSchema || schema || 'public') : '',
        table: childTable
      },
      whereColumns: pairs.map(p => p.target),
      whereValues: pairs.map(p => row[p.local]),
      mapping: pairs.map(p => childTable + '.' + p.target + ' ← ' + p.local).join(', '),
      unusable: reason
    })
  }
  return items
}

/**
 * 组装反向查询的条件体（发给 getPageData，主进程 assertPageBoundary 以目标表结构兜底）。
 * 标识符按方言加引用符（mysql 反引号 / pg 双引号），值走绑定占位符。
 * @param {Object} item buildRefItems 的单项
 * @param {string} dialect 'mysql' | 'postgres'
 * @returns {{where: string, whereParams: Array}|null} 不可组装（列值含对象等）返回 null
 */
export function buildRefWhere (item, dialect) {
  const d = dialect === 'postgres' ? 'postgres' : 'mysql'
  const cols = Array.isArray(item && item.whereColumns) ? item.whereColumns : []
  const vals = Array.isArray(item && item.whereValues) ? item.whereValues : []
  if (!cols.length || cols.length !== vals.length) {
    return null
  }
  const parts = []
  const params = []
  for (let i = 0; i < cols.length; i++) {
    const name = String(cols[i])
    if (!name) {
      return null
    }
    const quoted = d === 'postgres'
      ? '"' + name.replace(/"/g, '""') + '"'
      : '`' + name.replace(/`/g, '``') + '`'
    if (vals[i] === null || vals[i] === undefined) {
      parts.push(quoted + ' IS NULL')
    } else if (typeof vals[i] === 'object') {
      // 二进制信封等对象不能当绑定参数：由调用方禁用查询，这里不硬造条件
      return null
    } else {
      parts.push(quoted + ' = ' + (d === 'postgres' ? '$' + (params.length + 1) : '?'))
      params.push(vals[i])
    }
  }
  return { where: parts.join(' AND '), whereParams: params }
}
