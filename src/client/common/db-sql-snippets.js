/**
 * SQL 模板定义（B 批 B-3）。纯函数零依赖。
 *
 * 关键纪律（设计 §11）：模板不单独维护一套 SQL 字符串——本文件是唯一模板源，
 * 菜单插入的模板从这里 build，补全引擎（A 批 snippetCompletion）要接片段时
 * 也引用这里的骨架定义，保证两处插入内容永远一致。
 *
 * 骨架（无表上下文）用占位表名 table_name；带表上下文（当前选中表）时
 * 生成可直接执行的完整语句，INSERT 用 describeTable 同源的列清单。
 * 引号按方言：mysql 反引号（双写转义）、pg 双引号（双写转义）。
 */

// 占位表名：无上下文时的骨架可读占位，用户改一个词即可执行
export const PLACEHOLDER_TABLE = 'table_name'

/**
 * 标识符引用。非法输入原样返回（调用方保证来自结构元数据，
 * 这里不抛错——模板生成属辅助功能，任何失败都降级为"给个骨架"）
 */
export function quoteIdent (name, dialect) {
  const s = String(name || '')
  if (!s) {
    return s
  }
  if (dialect === 'postgres') {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  // mysql 及其余方言统一反引号（占位表名 table_name 是合法标识符，引用无害）
  return '`' + s.replace(/`/g, '``') + '`'
}

// 带库/schema 前缀的表引用：prefix 有值才拼，避免出现空前缀点号
function tableRef (ctx) {
  const d = ctx && ctx.dialect
  const parts = []
  if (ctx && ctx.schema) {
    parts.push(quoteIdent(ctx.schema, d))
  }
  parts.push(quoteIdent((ctx && ctx.table) || PLACEHOLDER_TABLE, d))
  return parts.join('.')
}

// 列名数组：过滤空值，全空回 null（调用方降级为骨架）
function colNames (ctx) {
  const cols = (ctx && ctx.columns) || []
  const names = cols
    .map(c => (typeof c === 'string' ? c : c && c.name))
    .filter(n => typeof n === 'string' && n)
  return names.length ? names : null
}

function selectTpl (ctx) {
  const cols = colNames(ctx)
  const sel = cols
    ? cols.map(n => quoteIdent(n, ctx.dialect)).join(', ')
    : '*'
  return 'SELECT ' + sel + '\nFROM ' + tableRef(ctx) + '\nLIMIT 100'
}

function insertTpl (ctx) {
  const cols = colNames(ctx)
  if (!cols) {
    return 'INSERT INTO ' + tableRef(ctx) + ' (col1, col2)\nVALUES (value1, value2)'
  }
  const colList = cols.map(n => quoteIdent(n, ctx.dialect)).join(', ')
  // 占位符按方言：mysql 全 ?；pg 序号 $1..$n（原生驱动绑定语法）
  const row = ctx.dialect === 'postgres'
    ? cols.map((c, i) => '$' + (i + 1)).join(', ')
    : cols.map(() => '?').join(', ')
  return 'INSERT INTO ' + tableRef(ctx) + ' (' + colList + ')\nVALUES (' + row + ')'
}

function updateTpl (ctx) {
  const cols = colNames(ctx)
  const sets = cols && cols.length > 1
    ? cols.slice(1).map(n => quoteIdent(n, ctx.dialect) + ' = ?').join(', ')
    : 'col1 = ?'
  return 'UPDATE ' + tableRef(ctx) + '\nSET ' + sets + '\nWHERE <condition>'
}

function deleteTpl (ctx) {
  return 'DELETE FROM ' + tableRef(ctx) + '\nWHERE <condition>'
}

function countTpl (ctx) {
  return 'SELECT COUNT(*) AS total\nFROM ' + tableRef(ctx)
}

/**
 * 模板注册表：key 稳定（菜单/补全共用），build(ctx) → 可插入文本。
 * 顺序即菜单顺序：最常用的 SELECT 在前
 */
export const SQL_TEMPLATES = [
  { key: 'select', build: selectTpl },
  { key: 'insert', build: insertTpl },
  { key: 'update', build: updateTpl },
  { key: 'delete', build: deleteTpl },
  { key: 'count', build: countTpl }
]

// 按 key 取模板文本；未知 key 返回 null（调用方不插任何东西）
export function buildTemplateSql (key, ctx) {
  const t = SQL_TEMPLATES.find(x => x.key === key)
  if (!t) {
    return null
  }
  try {
    return t.build(ctx || {})
  } catch (e) {
    // 模板生成绝不抛错：失败降级为最简骨架
    return 'SELECT *\nFROM ' + PLACEHOLDER_TABLE + '\nLIMIT 100'
  }
}
