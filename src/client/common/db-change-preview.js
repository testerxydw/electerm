/**
 * N2 变更预览：网格写操作"将要改成什么"的语句文本，一处构造、多处复用。
 *
 * 口径（与主进程真实语句的关系）：
 * - **只是预览文本，永远不参与执行**。真正写库由主进程按引擎参数化构造
 *   （前端只传值 + 主键定位），这里拼字符串是为了让人在点之前看清改动内容。
 *   所以标识符不引用、值用 previewLiteral（截断 + 单引号），与 E1 危险确认弹窗
 *   历史上显示的格式逐字一致 —— 搬过来是为了让"确认弹窗"和"变更面板"不再各写一份，
 *   同一条改动在两处显示成两种样子，用户就不知道该信哪个。
 * - WHERE 只含主键：无主键的行根本不允许进变更集（前端拦），这里也不为它兜底。
 * - 目标名沿用 writeTargetLabel（库.表），与既有确认文案同一口径。
 */

import { previewLiteral, writeTargetLabel } from './db-session-const.js'
import { previewKeyList } from './db-grid-replace.js'

// 单元格 UPDATE：一行一列，WHERE 只有主键等值
export function updateCellPreview (o) {
  const { sel, pkColumn, pkValue, column, value } = o || {}
  return 'UPDATE ' + writeTargetLabel(sel) +
    ' SET ' + column + ' = ' + previewLiteral(value) +
    ' WHERE ' + pkColumn + ' = ' + previewLiteral(pkValue)
}

// 整行 INSERT：列清单与值清单已由调用方按"留空列不传"筛过（自增/默认值交给库）
export function insertRowPreview (o) {
  const { sel, cols, vals } = o || {}
  return 'INSERT INTO ' + writeTargetLabel(sel) +
    ' (' + (cols || []).join(', ') + ') VALUES (' + (vals || []).join(', ') + ')'
}

// 批量删行：仅主键 IN 定位，主键清单最多显示 10 个（与危险确认原口径一致）
export function deleteRowsPreview (o) {
  const { sel, pkColumn, pkValues } = o || {}
  const list = Array.isArray(pkValues) ? pkValues : []
  const shown = list.slice(0, 10).map(previewLiteral).join(', ') +
    (list.length > 10 ? ', …' : '')
  return 'DELETE FROM ' + writeTargetLabel(sel) +
    ' WHERE ' + pkColumn + ' IN (' + shown + ')'
}

// 批量同列改值：一条 UPDATE ... WHERE 主键 IN (...)
export function bulkUpdatePreview (o) {
  const { sel, column, value, pkColumn, pks } = o || {}
  return 'UPDATE ' + writeTargetLabel(sel) +
    ' SET ' + column + ' = ' + previewLiteral(value) +
    ' WHERE ' + pkColumn + ' IN (' + previewKeyList(pks) + ')'
}

// 表内查找替换：显示成 replace() 形式（真实执行仍是逐行绑定值，
// 这里显示函数是为了说清"改的是替换后的结果"，不是整列覆盖）
export function replacePreview (o) {
  const { sel, column, find, replace, pkColumn, pks } = o || {}
  return 'UPDATE ' + writeTargetLabel(sel) +
    ' SET ' + column + ' = replace(' + column + ', ' +
    previewLiteral(find) + ', ' + previewLiteral(replace) + ')' +
    ' WHERE ' + pkColumn + ' IN (' + previewKeyList(pks) + ')'
}
