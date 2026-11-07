/**
 * 导入映射与行转换（N4a，设计 §N4 实现要点 4）
 *
 * 职责单一：把"映射配置 + 一行源数据"折算成"待插入行对象"。
 * 不碰文件、不碰解析、不碰数据库 —— 那些在 db-importer.js（任务执行）
 * 和 parsers.js（源解析）里。三层的接口就是 setters 数组。
 *
 * 映射：mapping = [{ fileCol, target }]，target:
 * - 列名字符串 → 该文件列的值按参数绑定进目标列
 * - null/'' → 跳过该文件列
 * - { mode:'constant', value, column? } → 常量绑定进 column（默认同名 fileCol）
 * - { mode:'null', column? } → NULL
 * - { mode:'expression', sql, column? } → SQL 片段内联进 VALUES 对应位置，
 *   拼接前必须过 safe-clause.assertSafeClause 的目标表列白名单（分号/注释/写关键词
 *   一律拒绝），且不允许占位符 —— 片段由数据库对每行求值，无可绑参数
 *
 * fileCol 的含义随源格式变化（这是 JSONL 导入不需要第二套映射规则的原因）：
 * - csv/tsv：表头里的列名（按下标取值）
 * - jsonl：JSON 对象的键名（按键名取值，值保留 JSON 原生类型）
 *
 * 为什么 expression 的闸门放在这里而不是适配器：片段来自渲染层映射配置（不可信），
 * 必须在主进程、SQL 拼接发生之前过列白名单；适配器 insertRows 只接受已校验片段
 * 并在注释里声明该契约。
 *
 * 空字段语义：CSV 空字段导入为空字符串（忠实），不做 '' → NULL 的静默转换 ——
 * 两种语义各有真实场景，猜错比让用户显式用 constant/null 映射更糟。
 */

'use strict'

const { jsonValueToCell } = require('./parsers')

/**
 * 映射归一（纯函数）。规则见文件头注释。
 * @returns {Array<{kind:'field'|'constant'|'null'|'expression', fileCol?, column, value?, sql?}>}
 */
function normalizeMapping (mapping) {
  const list = Array.isArray(mapping) ? mapping : []
  const setters = []
  for (const m of list) {
    if (!m || typeof m !== 'object' || m.fileCol === undefined || m.fileCol === null) {
      continue
    }
    const fileCol = String(m.fileCol)
    const t = m.target
    if (t === null || t === undefined || t === '') {
      continue
    }
    if (typeof t === 'string') {
      setters.push({ kind: 'field', fileCol, column: t })
      continue
    }
    if (typeof t === 'object') {
      const column = t.column !== undefined && t.column !== null && t.column !== ''
        ? String(t.column)
        : fileCol
      if (t.mode === 'constant') {
        setters.push({ kind: 'constant', column, value: t.value === undefined ? null : t.value })
      } else if (t.mode === 'null') {
        setters.push({ kind: 'null', column })
      } else if (t.mode === 'expression') {
        if (typeof t.sql !== 'string' || !t.sql.trim()) {
          throw new Error('expression 映射缺少 sql 片段: ' + fileCol)
        }
        setters.push({ kind: 'expression', column, sql: t.sql })
      } else {
        throw new Error('unknown mapping target mode: ' + String(t.mode))
      }
    } else {
      throw new Error('unknown mapping target: ' + String(t))
    }
  }
  if (!setters.length) {
    throw new Error('导入映射为空：至少需要一列 target')
  }
  return setters
}

/**
 * csv/tsv 行 → 待插入行对象（纯函数）。expression 列也要占键位（值置 undefined）：
 * insertRows 以首行 Object.keys 生成 INSERT 列清单，缺键会导致表达式列被静默丢弃
 * （buildInsertBatch 的 hasExpr 永远命不中）；undefined 值不会进绑定参数
 * （insertBatchParams 的 bindCols 本就跳过表达式列）。映射引用了表头不存在的
 * 文件列时按 null 处理（预览侧应拦，这里是兜底）。
 */
function mapRowToInsert (fields, setters, insertCols, headerCols) {
  const row = {}
  setters.forEach((s, i) => {
    const col = insertCols[i]
    if (s.kind === 'expression') {
      row[col] = undefined
      return
    }
    if (s.kind === 'constant') {
      row[col] = s.value
      return
    }
    if (s.kind === 'null') {
      row[col] = null
      return
    }
    const idx = headerCols ? headerCols.indexOf(s.fileCol) : -1
    row[col] = idx === -1 || fields[idx] === undefined ? null : fields[idx]
  })
  return row
}

/**
 * jsonl 行 → 待插入行对象（纯函数）。与 mapRowToInsert 同一套 setters/键位规则，
 * 区别只在取值方式：按下标 → 按键名，并且值过 jsonValueToCell 还原类型
 * （null 就是 NULL、数字就是数字、`__bin` 信封还原成 Buffer）—— 这是
 * "导出 JSONL → 导入 JSONL 内容一致"成立的地方。
 *
 * jsonValueToCell 抛错（截断的二进制信封）会让整次导入失败而不是静默写坏数据：
 * 半截字节串落库比导入中止难查得多。lineNo 用来把错误定位回文件的行。
 */
function mapObjectToInsert (obj, setters, insertCols, lineNo) {
  const row = {}
  setters.forEach((s, i) => {
    const col = insertCols[i]
    if (s.kind === 'expression') {
      row[col] = undefined
      return
    }
    if (s.kind === 'constant') {
      row[col] = s.value
      return
    }
    if (s.kind === 'null') {
      row[col] = null
      return
    }
    row[col] = jsonValueToCell(obj[s.fileCol], lineNo)
  })
  return row
}

// expression 片段闸门：目标表列白名单（assertSafeClause 同时拒绝分号/注释/
// 写关键词/黑名单函数）。列信息拿不到时宁可整单拒绝也不放行未校验片段。
function assertExpressionsSafe (setters, structure, dialect) {
  const { assertSafeClause } = require('../db-client/safe-clause')
  const columns = ((structure && structure.columns) || [])
    .map(c => c && c.name)
    .filter(n => typeof n === 'string' && n)
  for (const s of setters) {
    if (s.kind !== 'expression') {
      continue
    }
    if (!columns.length) {
      throw new Error('无法获取列信息，expression 映射已拒绝')
    }
    const { placeholders } = assertSafeClause(s.sql, columns, dialect)
    if (placeholders !== 0) {
      throw new Error('expression 不允许占位符: ' + s.sql)
    }
  }
}

module.exports = {
  normalizeMapping,
  mapRowToInsert,
  mapObjectToInsert,
  assertExpressionsSafe
}
