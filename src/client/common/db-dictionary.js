/**
 * H3a：当前表的数据字典导出（设计 §6，纯前端、零依赖，可单测）
 *
 * 数据源是主进程 getTableStructure 的 v2 契约（列/索引/外键/表注释/估算行数），
 * 本模块只做"契约 → 文本"，不发任何查询、不猜缺失字段。
 *
 * 两种格式同一份内容：Markdown（贴文档/工单）与 CSV（进表格软件）。
 * CSV 用 `# 节名` 分节：表信息 / 列 / 索引 / 外键各一节，节标题行以 # 开头，
 * 大多数 CSV 导入器会当注释跳过；不合并成一张宽表是因为三种条目字段完全不同，
 * 硬拼会出现大量空列，反而更难读。
 *
 * 为什么文案是中文而不是 i18n key：本模块不能碰 window.translate（node 环境下
 * 没有 window，单测要能直接跑源码）。与 db-sql-risk.js 同一取舍，非中文界面下
 * 导出文件仍是中文表头，已知并接受——字典是给人看的归档物，不是 UI 控件。
 */
import { isPgFamily } from './db-engine-family.js'
import { csvEscape } from './db-csv.js'

// Markdown 表格单元格：竖线要转义（否则把表撑破），换行没法在单元格里表达 → <br>
export function escapeMdCell (v) {
  if (v === null || v === undefined) {
    return ''
  }
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
}

const csvRow = cells => cells.map(csvEscape).join(',')
const mdRow = cells => '| ' + cells.map(escapeMdCell).join(' | ') + ' |'

// 引用名：PG 家族的 schema 有意义（public 之外的库同名表靠它区分），MySQL 用库名
export function qualifyTable (table, dialect) {
  const t = table || {}
  const name = String(t.table || t.name || '')
  const prefix = isPgFamily(dialect) ? (t.schema || '') : (t.database || t.db || '')
  return prefix ? prefix + '.' + name : name
}

// 外键引用列：单列写 table.col，多列写 table(col1, col2) —— 后者不会被
// 误读成"另一张表的列"，也避免 table.a, b 那种歧义
const refText = (fk, dialect) => {
  const base = qualifyTable({ schema: fk.refSchema, table: fk.refTable }, dialect)
  const cols = (fk.refColumns || []).map(String)
  if (!cols.length) {
    return base
  }
  return cols.length === 1 ? base + '.' + cols[0] : base + '(' + cols.join(', ') + ')'
}

const COL_HEAD = ['序号', '列名', '类型', '可空', '默认值', '主键', '注释']
const IDX_HEAD = ['索引名', '唯一', '主键', '方法', '列']
const FK_HEAD = ['外键名', '列', '引用', '删除动作', '更新动作']

const yes = v => (v === true ? '是' : '否')
// 默认值的 null 与空串不同：NULL 写 NULL（与 SQL 语义一致），空串留空
const defText = v => (v === null || v === undefined ? '' : String(v))
// 列的类型展示用 columnType（含长度/无符号），没有才退 dataType
const colType = c => c.columnType || c.dataType || ''

const pad = n => String(n).padStart(2, '0')

/**
 * @param {Object}   input
 * @param {Object}   input.table      选中目标 { database, schema, table }
 * @param {Object}   input.structure  getTableStructure 的 v2 返回
 * @param {string}   [input.dialect]  'mysql' | 'postgres' | ...
 * @param {Date}     [input.now]      导出时间（测试传固定值，保证输出稳定）
 * @returns {{ markdown: string, csv: string }}
 */
export function buildDataDictionary ({ table, structure, dialect, now } = {}) {
  const s = structure || {}
  const columns = Array.isArray(s.columns) ? s.columns : []
  const indexes = Array.isArray(s.indexes) ? s.indexes : []
  const foreignKeys = Array.isArray(s.foreignKeys) ? s.foreignKeys : []
  const fullName = qualifyTable(table, dialect)
  const at = now instanceof Date ? now : new Date()
  const stamp = at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) +
    ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds())

  const tableInfo = [
    ['表', fullName],
    ['类型', s.type === 'view' ? '视图' : '表'],
    ['注释', s.comment || ''],
    ['估算行数', s.estimatedRows === null || s.estimatedRows === undefined ? '' : s.estimatedRows],
    ['导出时间', stamp]
  ]
  const colRows = columns.map((c, i) => [
    i + 1,
    c.name,
    colType(c),
    yes(c.nullable),
    defText(c.defaultValue),
    yes(c.isPrimaryKey),
    c.comment || ''
  ])
  const idxRows = indexes.map(ix => [
    ix.name,
    yes(ix.unique),
    yes(ix.primary),
    ix.method || '',
    (ix.columns || []).join(', ')
  ])
  const fkRows = foreignKeys.map(fk => [
    fk.name,
    (fk.columns || []).join(', '),
    refText(fk, dialect),
    fk.onDelete || '',
    fk.onUpdate || ''
  ])

  const mdTable = (head, rows) => [
    mdRow(head),
    mdRow(head.map(() => '---')),
    ...rows.map(mdRow)
  ]

  const markdown = [
    '# 数据字典：' + fullName,
    '',
    '## 表信息',
    '',
    ...mdTable(['属性', '值'], tableInfo),
    '',
    '## 列（' + columns.length + '）',
    '',
    ...mdTable(COL_HEAD, colRows),
    '',
    '## 索引（' + indexes.length + '）',
    '',
    ...mdTable(IDX_HEAD, idxRows),
    '',
    '## 外键（' + foreignKeys.length + '）',
    '',
    ...mdTable(FK_HEAD, fkRows),
    ''
  ].join('\n')

  // BOM 与 toCsv 一致：Excel/LibreOffice 打开中文表头不乱码
  const csv = '\uFEFF' + [
    '# 表信息',
    csvRow(['属性', '值']),
    ...tableInfo.map(([k, v]) => csvRow([k, v])),
    '',
    '# 列',
    csvRow(COL_HEAD),
    ...colRows.map(csvRow),
    '',
    '# 索引',
    csvRow(IDX_HEAD),
    ...idxRows.map(csvRow),
    '',
    '# 外键',
    csvRow(FK_HEAD),
    ...fkRows.map(csvRow),
    ''
  ].join('\r\n')

  return { markdown, csv }
}
