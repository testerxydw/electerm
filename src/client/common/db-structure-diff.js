/**
 * H4：属性级结构对比（纯函数、零依赖，可单测）
 *
 * 输入是主进程 getTableStructure 的 v2 契约（structure-v2.js），两份结构进、一份
 * 差异出。比对口径从设计 §11.2 来：
 * - 名称：MySQL 大小写不敏感，PG 敏感（引号标识符 "Users" 与 users 是两张表）
 * - 类型：先按方言把别名折叠（int/integer、character varying/varchar），再比
 *   完整类型串（长度/无符号参与比较）——只收文档里的同义词，不做跨类型等价，
 *   否则 "int vs bigint" 会被吃成一致
 * - 默认值：null 与空串不是一回事；CURRENT_TIMESTAMP / now() 这类函数默认值
 *   大小写与尾括号写法不一，归一到大写词干再比
 * - 索引/外键：按名称匹配，列顺序参与比较（(a,b) 与 (b,a) 不是同一个索引）
 *
 * 输出方向：base 是基准，target 是对比。added = 只在 target（新增）、
 * removed = 只在 base（删除）、changed = 两边都有但属性不同、equal = 一致。
 * 原始值原样带在 base/target 里，报告与界面都显示原始值，不显示归一化结果。
 *
 * 报告文案是中文而非 i18n key：与 db-dictionary.js 同一取舍 —— 本模块在 node
 * 下直接跑单测，不能碰 window.translate；导出物是贴工单的归档文本，不是 UI 控件。
 */
import { escapeMdCell } from './db-dictionary.js'

const STATUS_RANK = { added: 0, removed: 1, changed: 2, equal: 3 }

// 同义词表：只收"同一个类型的不同写法"。跨类型（int/bigint、char/varchar）必须报差异
const TYPE_ALIAS = {
  mysql: {
    integer: 'int',
    middleint: 'mediumint',
    dec: 'decimal',
    numeric: 'decimal',
    fixed: 'decimal',
    character: 'char',
    'double precision': 'double'
  },
  postgres: {
    int: 'integer',
    int4: 'integer',
    int2: 'smallint',
    int8: 'bigint',
    bool: 'boolean',
    float4: 'real',
    float8: 'double precision',
    'character varying': 'varchar',
    character: 'char',
    'bit varying': 'varbit',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz'
  }
}

function dialectOf (d) {
  return d === 'postgres' || d === 'pg' ? 'postgres' : 'mysql'
}

// MySQL 标识符大小写不敏感；PG 的引号标识符区分大小写，原样比
export function foldName (name, dialect) {
  const s = String(name === null || name === undefined ? '' : name)
  return dialectOf(dialect) === 'mysql' ? s.toLowerCase() : s
}

/**
 * 类型归一：小写、折叠空白、基类型走同义词表，修饰符（长度/精度/unsigned）
 * 去空白后原样保留 —— varchar(64) 与 varchar(32) 必须报差异。
 */
export function normalizeType (type, dialect) {
  const raw = String(type === null || type === undefined ? '' : type)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (!raw) {
    return ''
  }
  const i = raw.indexOf('(')
  const base = (i === -1 ? raw : raw.slice(0, i)).trim()
  const rest = i === -1 ? '' : raw.slice(i).replace(/\s+/g, '')
  const alias = TYPE_ALIAS[dialectOf(dialect)] || {}
  return (alias[base] || base) + rest
}

// 无括号也能当默认值的函数：只有这张表里的词按函数归一，其余裸词当字符串字面量
const FUNC_DEFAULTS = new Set([
  'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_USER',
  'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_ROLE', 'CURRENT_SCHEMA',
  'USER', 'SESSION_USER', 'SYSTEM_USER'
])

/**
 * 默认值归一。四种形态各自成键，互不相等：
 * null（无默认）/ 空串（DEFAULT ''）/ 字面量 / 函数（大小写与尾括号不敏感）。
 * 字面量保持大小写：'Admin' 与 'admin' 是两个不同的默认值 —— 所以裸词不能
 * 一律当函数（DEFAULT 'admin' 从 catalog 读回来就是 admin，没有引号）。
 */
export function normalizeDefault (v) {
  if (v === null || v === undefined) {
    return 'null:'
  }
  const s = String(v)
  if (s.trim() === '') {
    return 'empty:'
  }
  const t = s.trim()
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(t)) {
    return 'expr:' + t.replace(/\(\)$/, '').toUpperCase()
  }
  if (FUNC_DEFAULTS.has(t.toUpperCase())) {
    return 'expr:' + t.toUpperCase()
  }
  return 'lit:' + t
}

// 注释：空注释与无注释是同一个意思（契约里已被 commentOrNull 收口，这里防御脏输入）
function commentOrNull (v) {
  if (v === null || v === undefined) {
    return null
  }
  const t = String(v).trim()
  return t === '' ? null : t
}

function yesNo (v) {
  if (typeof v === 'boolean') {
    return v
  }
  if (typeof v === 'number') {
    return v !== 0
  }
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1' || s === 't'
}

function strArray (v) {
  if (!Array.isArray(v)) {
    return v === null || v === undefined || v === '' ? [] : [String(v)]
  }
  return v.filter(x => x !== null && x !== undefined).map(String)
}

function actionOrNull (v) {
  if (v === null || v === undefined) {
    return null
  }
  const s = String(v).trim().toUpperCase().replace(/_/g, ' ')
  return s === '' ? null : s
}

function lengthOrNull (v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * v2 契约 → 只保留"参与比较"的字段。未知字段一律不进差异（结构缓存的
 * estimatedRows 会随 analyze 变化，拿它比会让每次对比都报一条假差异）。
 */
export function normalizeStructure (structure, opts = {}) {
  const dialect = dialectOf(opts.dialect)
  const src = structure || {}
  const columns = (Array.isArray(src.columns) ? src.columns : [])
    .filter(Boolean)
    .map(c => ({
      name: String(c.name || ''),
      // columnType 含长度/无符号；没有时退 dataType（视图或老引擎只给基类）
      type: String(c.columnType || c.dataType || ''),
      maxLength: lengthOrNull(c.maxLength),
      nullable: yesNo(c.nullable),
      defaultValue: c.defaultValue === undefined ? null : c.defaultValue,
      comment: commentOrNull(c.comment)
    }))
    .filter(c => c.name)
  const indexes = (Array.isArray(src.indexes) ? src.indexes : [])
    .filter(ix => ix && ix.name)
    .map(ix => ({
      name: String(ix.name),
      unique: ix.unique === true,
      primary: ix.primary === true,
      columns: strArray(ix.columns),
      method: ix.method === null || ix.method === undefined ? null : String(ix.method)
    }))
  const foreignKeys = (Array.isArray(src.foreignKeys) ? src.foreignKeys : [])
    .filter(fk => fk && fk.name)
    .map(fk => ({
      name: String(fk.name),
      columns: strArray(fk.columns),
      refTable: fk.refTable === null || fk.refTable === undefined ? null : String(fk.refTable),
      refColumns: strArray(fk.refColumns),
      onDelete: actionOrNull(fk.onDelete),
      onUpdate: actionOrNull(fk.onUpdate)
    }))
  return { dialect, columns, indexes, foreignKeys }
}

/* ------------------------------------------------------------------ 字段比较 */

const COL_FIELDS = [
  ['type', (c, d) => normalizeType(c.type, d), c => c.type],
  ['length', (c) => String(c.maxLength === null ? '' : c.maxLength), c => c.maxLength],
  ['nullable', c => String(c.nullable), c => c.nullable],
  ['default', c => normalizeDefault(c.defaultValue), c => c.defaultValue],
  ['comment', c => String(c.comment === null ? '' : c.comment), c => c.comment]
]

const IDX_FIELDS = [
  ['unique', ix => String(ix.unique), ix => ix.unique],
  ['primary', ix => String(ix.primary), ix => ix.primary],
  ['columns', ix => ix.columns.join('\u0000'), ix => ix.columns],
  ['method', ix => String(ix.method === null ? '' : ix.method).toUpperCase(), ix => ix.method]
]

const FK_FIELDS = [
  ['columns', fk => fk.columns.join('\u0000'), fk => fk.columns],
  // 引用表名按方言折叠：MySQL 下 Orders / orders 是同一张表
  ['refTable', (fk, d) => foldName(fk.refTable, d), fk => fk.refTable],
  ['refColumns', fk => fk.refColumns.join('\u0000'), fk => fk.refColumns],
  ['onDelete', fk => String(fk.onDelete || ''), fk => fk.onDelete],
  ['onUpdate', fk => String(fk.onUpdate || ''), fk => fk.onUpdate]
]

function diffFields (a, b, fields, dialect) {
  const out = []
  for (const [key, canon, raw] of fields) {
    if (canon(a, dialect) !== canon(b, dialect)) {
      out.push({ key, base: raw(a), target: raw(b) })
    }
  }
  return out
}

function byStatusThenName (dialect) {
  return (x, y) => {
    const r = STATUS_RANK[x.status] - STATUS_RANK[y.status]
    if (r !== 0) {
      return r
    }
    const a = foldName(x.name, dialect)
    const b = foldName(y.name, dialect)
    return a < b ? -1 : a > b ? 1 : 0
  }
}

function diffSection (kind, baseList, targetList, fields, dialect) {
  const keyOf = x => foldName(x.name, dialect)
  const baseMap = new Map(baseList.map(x => [keyOf(x), x]))
  const targetMap = new Map(targetList.map(x => [keyOf(x), x]))
  const keys = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()]))
  const entries = keys.map(k => {
    const a = baseMap.get(k) || null
    const b = targetMap.get(k) || null
    if (!a) {
      return { kind, name: b.name, status: 'added', base: null, target: b, fields: [] }
    }
    if (!b) {
      return { kind, name: a.name, status: 'removed', base: a, target: null, fields: [] }
    }
    const changed = diffFields(a, b, fields, dialect)
    return {
      kind,
      name: a.name,
      status: changed.length ? 'changed' : 'equal',
      base: a,
      target: b,
      fields: changed
    }
  })
  entries.sort(byStatusThenName(dialect))
  return entries
}

function tally (entries) {
  const out = { added: 0, removed: 0, changed: 0, equal: 0, total: entries.length }
  for (const e of entries) {
    out[e.status]++
  }
  return out
}

/**
 * 结构差异。返回的每个条目都带原始 base/target 对象与"哪些字段不同"，
 * 界面/报告都能落到字段级。
 */
export function diffTableStructure (base, target, opts = {}) {
  const dialect = dialectOf(opts.dialect)
  const a = normalizeStructure(base, { dialect })
  const b = normalizeStructure(target, { dialect })
  const columns = diffSection('column', a.columns, b.columns, COL_FIELDS, dialect)
  const indexes = diffSection('index', a.indexes, b.indexes, IDX_FIELDS, dialect)
  const foreignKeys = diffSection('foreignKey', a.foreignKeys, b.foreignKeys, FK_FIELDS, dialect)
  const sections = {
    columns: tally(columns),
    indexes: tally(indexes),
    foreignKeys: tally(foreignKeys)
  }
  const summary = { added: 0, removed: 0, changed: 0, equal: 0, total: 0 }
  for (const s of Object.values(sections)) {
    summary.added += s.added
    summary.removed += s.removed
    summary.changed += s.changed
    summary.equal += s.equal
    summary.total += s.total
  }
  return { columns, indexes, foreignKeys, sections, summary }
}

/* ------------------------------------------------------------------ 报告 */

const SECTION_LABEL = {
  columns: '列',
  indexes: '索引',
  foreignKeys: '外键'
}

const FIELD_LABEL = {
  type: '类型',
  length: '长度',
  nullable: '可空',
  default: '默认值',
  comment: '注释',
  unique: '唯一',
  primary: '主键',
  columns: '列',
  method: '方法',
  refTable: '引用表',
  refColumns: '引用列',
  onDelete: 'ON DELETE',
  onUpdate: 'ON UPDATE'
}

function fmt (v) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (typeof v === 'boolean') {
    return v ? '是' : '否'
  }
  if (Array.isArray(v)) {
    return v.length ? '(' + v.join(', ') + ')' : ''
  }
  return String(v)
}

const mdRow = cells => '| ' + cells.map(escapeMdCell).join(' | ') + ' |'

function entryCells (kind, e, status) {
  const it = status === 'onlyBase' ? e.base : e.target
  if (kind === 'column') {
    return [e.name, fmt(it.type), fmt(it.nullable), fmt(it.defaultValue), fmt(it.comment)]
  }
  if (kind === 'index') {
    return [e.name, fmt(it.columns), fmt(it.unique), fmt(it.primary), fmt(it.method)]
  }
  return [
    e.name,
    fmt(it.columns),
    [it.refTable, fmt(it.refColumns)].filter(Boolean).join(' '),
    fmt(it.onDelete),
    fmt(it.onUpdate)
  ]
}

function sectionHead (kind) {
  if (kind === 'column') {
    return ['列名', '类型', '可空', '默认值', '注释']
  }
  if (kind === 'index') {
    return ['索引名', '列', '唯一', '主键', '方法']
  }
  return ['外键名', '列', '引用', 'ON DELETE', 'ON UPDATE']
}

function sectionReport (title, kind, entries) {
  const lines = ['## ' + title]
  const changed = entries.filter(e => e.status === 'changed')
  const added = entries.filter(e => e.status === 'added')
  const removed = entries.filter(e => e.status === 'removed')
  if (!changed.length && !added.length && !removed.length) {
    lines.push('', '无差异')
    return lines
  }
  if (added.length) {
    lines.push('', '### 仅在 B（新增）', '', mdRow(sectionHead(kind)))
    lines.push(mdRow(sectionHead(kind).map(() => '---')))
    for (const e of added) {
      lines.push(mdRow(entryCells(kind, e, 'onlyTarget')))
    }
  }
  if (removed.length) {
    lines.push('', '### 仅在 A（删除）', '', mdRow(sectionHead(kind)))
    lines.push(mdRow(sectionHead(kind).map(() => '---')))
    for (const e of removed) {
      lines.push(mdRow(entryCells(kind, e, 'onlyBase')))
    }
  }
  if (changed.length) {
    lines.push('', '### 有差异', '', mdRow(['名称', '字段', 'A', 'B']))
    lines.push(mdRow(['---', '---', '---', '---']))
    for (const e of changed) {
      for (const f of e.fields) {
        lines.push(mdRow([e.name, FIELD_LABEL[f.key] || f.key, fmt(f.base), fmt(f.target)]))
      }
    }
  }
  return lines
}

/**
 * Markdown 报告。baseLabel/targetLabel 是"库.表"这样的展示名（调用方拼）。
 * 报告只写差异与原始值，不生成任何 ALTER —— 这是纯描述物。
 */
export function diffToMarkdown ({ baseLabel, targetLabel, diff, base, target } = {}) {
  const d = diff || { columns: [], indexes: [], foreignKeys: [], sections: null, summary: null }
  const sections = d.sections || {
    columns: tally(d.columns || []),
    indexes: tally(d.indexes || []),
    foreignKeys: tally(d.foreignKeys || [])
  }
  const summary = d.summary || (() => {
    const s = { added: 0, removed: 0, changed: 0, equal: 0, total: 0 }
    for (const k of Object.values(sections)) {
      s.added += k.added
      s.removed += k.removed
      s.changed += k.changed
      s.equal += k.equal
      s.total += k.total
    }
    return s
  })()
  const lines = [
    '# 结构对比',
    '',
    '- A（基准）：`' + String(baseLabel || '') + '`',
    '- B（对比）：`' + String(targetLabel || '') + '`'
  ]
  const commentA = base && base.comment ? String(base.comment) : ''
  const commentB = target && target.comment ? String(target.comment) : ''
  if (commentA || commentB) {
    lines.push('- 表注释：A = ' + (commentA || '（无）') + '；B = ' + (commentB || '（无）'))
  }
  lines.push(
    '',
    '## 概览',
    '',
    mdRow(['项', '仅在 A', '仅在 B', '有差异', '相同']),
    mdRow(['---', '---', '---', '---', '---'])
  )
  for (const [key, label] of [['columns', '列'], ['indexes', '索引'], ['foreignKeys', '外键']]) {
    const s = sections[key] || { added: 0, removed: 0, changed: 0, equal: 0 }
    lines.push(mdRow([label, s.removed, s.added, s.changed, s.equal]))
  }
  lines.push(mdRow(['合计', summary.removed, summary.added, summary.changed, summary.equal]))
  lines.push('', sectionReport(SECTION_LABEL.columns, 'column', d.columns || []).join('\n'))
  lines.push('', sectionReport(SECTION_LABEL.indexes, 'index', d.indexes || []).join('\n'))
  lines.push('', sectionReport(SECTION_LABEL.foreignKeys, 'foreignKey', d.foreignKeys || []).join('\n'))
  return lines.join('\n') + '\n'
}
