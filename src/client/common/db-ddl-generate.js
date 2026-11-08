/**
 * N3a 结构比较 → 生成候选 DDL（纯函数，node 单测可直接 import）
 *
 * 把 diffTableStructure 的**单条差异**转成方言的候选语句。生成规则集中在这里
 * （mysql 系 / pg 系两族），**禁止**在组件里散落拼字符串 —— 组件只负责勾选、
 * 预览与"落编辑器不执行"。
 *
 * 三条安全边界（设计 N3a 的验收就靠它们撑着）：
 * - **只生成不自动执行**：产出是 SQL 文本，落编辑器（复用 AI 的插入通道），执行仍
 *   由用户按运行触发、过 E1 危险分级 + 生产确认。
 * - **首版只放类型白名单**：列类型变更落在白名单外时只报差异、不给语句
 *   （supported=false）。类型映射不全会生成错 DDL，宁可少给。
 * - **逐列回写按能力位放行**：`alterDdl` 没声明成 true 的方言一律只读预览。
 *   SQLite 是这里的主要用户（它的 ALTER 只有四形，删列/改类型要重建整表搬数据，
 *   盲生成的风险不对等），但判定看声明而不是认引擎名。
 *
 * 方向固定：A(base) 是基准、B(target) 是对比。生成的语句**作用在 A 表上**，把 A
 * 对齐成 B；表名取 A 的定位 —— 改哪张表由用户的选择决定，不能写成 B 的名字。
 *
 * 一条差异可能产出多条语句（PG 的列注释必须走 COMMENT ON COLUMN，并不进
 * ALTER TABLE），所以 entryToDdl 返回 sqls 数组；勾选以"差异条目"为单位，
 * 勾 1 条得它的全部语句。
 */
import { getDialect, capabilityOf } from './sql-dialects.js'
import { normalizeType, normalizeDefault } from './db-structure-diff.js'

// 首版放行的基类型白名单（normalizeType 归一、去括号、小写后比对）。
// 不收二进制 / 空间 / 几何 / ENUM / SET —— 那些类型族内写法差异大，盲生成最容易错；
// 报差异让人手改，比给一条可能错的语句更安全。
const COLUMN_TYPE_WHITELIST = new Set([
  'int', 'integer', 'smallint', 'bigint', 'tinyint', 'mediumint',
  'decimal', 'numeric', 'float', 'double', 'double precision', 'real',
  'varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext',
  'date', 'datetime', 'timestamp', 'timestamptz', 'time', 'year',
  'boolean', 'bool',
  'json', 'jsonb',
  'uuid'
])

// 统一的"这条差异只报不给语句"形状：reason 是机器码，界面按码出文案
const unsupported = reason => ({ sqls: [], supported: false, reason })

const strLit = v => "'" + String(v).replace(/'/g, "''") + "'"

// 标识符引号按方言（mysql 反引号 / pg 双引号），内部同种引号双写转义
function quoteIdent (name, dialect) {
  const d = getDialect(dialect)
  if (!d) {
    // 非 SQL 方言没有标识符引号可言；调用方已在生成前拦掉，这里不抛错
    return String(name)
  }
  const q = d.quote
  return q + String(name).split(q).join(q + q) + q
}

// 表名：mysql 用 db.table，pg 用 schema.table（pg 一个连接只绑一个库，database 段无意义）
function tableRef (loc, dialect) {
  const parts = dialect === 'postgres'
    ? [loc.schema, loc.table]
    : [loc.database, loc.table]
  return parts.filter(Boolean).map(p => quoteIdent(p, dialect)).join('.')
}

// 差异条目里的列类型。diff 的 base/target 是 normalizeStructure 的产物，
// 类型只落在 type 一个字段上（columnType/dataType 在归一时已合并）。
const colType = col => String((col && col.type) || '')

// 归一化基类型是否在白名单里
function typeAllowed (type, dialect) {
  const norm = normalizeType(type, dialect).replace(/\(.*$/, '').trim()
  return COLUMN_TYPE_WHITELIST.has(norm)
}

// 默认值形态：'null:' | 'empty:' | 'expr:' | 'lit-safe' | 'lit-unsafe'。
// 四态判定复用 normalizeDefault（那是唯一定义处），这里只回答"能不能进 DDL"：
// 带 :: 转换、引号、反斜杠或括号表达式的字面量不安全 —— catalog 回读的写法各引擎
// 不同，再包一层引号会把表达式弄成字符串字面量，这类条目只报差异不给语句。
function defaultKind (col) {
  const state = normalizeDefault(col.defaultValue)
  if (state === 'null:' || state === 'empty:') {
    return state
  }
  if (state.startsWith('expr:')) {
    return 'expr:'
  }
  const lit = state.slice(4)
  return /::|['"\\]/.test(lit) || /^[[({]/.test(lit) ? 'lit-unsafe' : 'lit-safe'
}

// DEFAULT 片段（不带前导空格，由调用方 join）。调用前必须先过 defaultKind，
// 'lit-unsafe' 不允许走到这里。空串默认要写成 DEFAULT ''，不能当"没有默认"丢掉；
// 数字字面量裸写（catalog 回读就是 0 / 1.5，包引号语义没错但读起来像字符串）。
function defaultClause (col) {
  const kind = defaultKind(col)
  if (kind === 'null:') {
    return ''
  }
  if (kind === 'empty:') {
    return "DEFAULT ''"
  }
  if (kind === 'expr:') {
    // 表达式（now() / CURRENT_TIMESTAMP）原样裸写，改大小写或补括号都是多事
    return 'DEFAULT ' + String(col.defaultValue).trim()
  }
  const lit = String(col.defaultValue).trim()
  return 'DEFAULT ' + (/^-?\d+(\.\d+)?$/.test(lit) ? lit : strLit(lit))
}

// 列定义尾串（MySQL 的 ADD/MODIFY 用全定义：类型 + 可空 + 默认 + 注释一条覆盖）
function colDefTail (col) {
  const bits = [colType(col)]
  if (col.nullable === false) {
    bits.push('NOT NULL')
  }
  bits.push(defaultClause(col))
  if (col.comment) {
    bits.push('COMMENT ' + strLit(col.comment))
  }
  return bits.filter(Boolean).join(' ')
}

const changedKeys = entry => new Set((entry.fields || []).map(f => f.key))

// MySQL 的列变更：MODIFY COLUMN 一条搞定（注释也在全定义里）
function mysqlColumnChange (entry, tbl, col) {
  return ['ALTER TABLE ' + tbl + ' MODIFY COLUMN ' + col + ' ' + colDefTail(entry.target)]
}

// PG 的列变更：一条 ALTER TABLE 并多个 action；注释只能另起一条 COMMENT ON COLUMN。
// 按"哪些字段真变了"逐个发，不做全量重写 —— 只改了注释却带 TYPE 会把整列重建。
function pgColumnChange (entry, tbl, col) {
  const t = entry.target
  const keys = changedKeys(entry)
  const actions = []
  if (keys.has('type') || keys.has('length')) {
    actions.push('ALTER COLUMN ' + col + ' TYPE ' + colType(t))
  }
  if (keys.has('nullable')) {
    actions.push('ALTER COLUMN ' + col + (t.nullable === false ? ' SET NOT NULL' : ' DROP NOT NULL'))
  }
  if (keys.has('default')) {
    const d = defaultClause(t)
    actions.push('ALTER COLUMN ' + col + (d ? ' SET ' + d : ' DROP DEFAULT'))
  }
  const sqls = []
  if (actions.length) {
    sqls.push('ALTER TABLE ' + tbl + ' ' + actions.join(', '))
  }
  if (keys.has('comment')) {
    sqls.push('COMMENT ON COLUMN ' + tbl + '.' + col + ' IS ' +
      (t.comment ? strLit(t.comment) : 'NULL'))
  }
  return sqls
}

// 差异条目名：diff 在顶层给了 name（removed 取基准名、added 取目标名），
// 兜底再从 base/target 里找，保证单条构造的条目也能生成
function entryName (entry) {
  const t = entry.target
  const b = entry.base
  return String(entry.name || (t && t.name) || (b && b.name) || '')
}

// MySQL 加列：一条全定义（注释内联）
function mysqlAddColumn (tbl, col, name) {
  return ['ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + colDefTail(name)]
}

// PG 加列：ADD COLUMN 不认内联 COMMENT，注释必须另起一条
function pgAddColumn (tbl, col, name) {
  const parts = [colType(name)]
  if (name.nullable === false) {
    parts.push('NOT NULL')
  }
  parts.push(defaultClause(name))
  const sqls = ['ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + parts.filter(Boolean).join(' ')]
  if (name.comment) {
    sqls.push('COMMENT ON COLUMN ' + tbl + '.' + col + ' IS ' + strLit(name.comment))
  }
  return sqls
}

// 加索引：MySQL 走 ALTER TABLE ADD INDEX，PG 根本没有这个语法，只有 CREATE INDEX
function mysqlAddIndex (tbl, ix) {
  const cols = ix.columns.map(c => quoteIdent(c, 'mysql')).join(', ')
  return ['ALTER TABLE ' + tbl + ' ADD' + (ix.unique ? ' UNIQUE' : '') + ' INDEX ' +
    quoteIdent(ix.name, 'mysql') + ' (' + cols + ')']
}

function pgAddIndex (tbl, ix) {
  const cols = ix.columns.map(c => quoteIdent(c, 'postgres')).join(', ')
  return ['CREATE' + (ix.unique ? ' UNIQUE' : '') + ' INDEX ' +
    quoteIdent(ix.name, 'postgres') + ' ON ' + tbl + ' (' + cols + ')']
}

/**
 * 把单条差异条目转成候选 DDL。
 * @param {object} entry diffTableStructure 的某个条目（column/index/foreignKey）
 * @param {string} dialect 引擎名（mysql / postgres / sqlite，也接受同族的 mariadb 等）
 * @param {object} baseLoc 基准表定位 { database, schema, table }
 * @returns {{sqls: string[], supported: boolean, reason: string}}
 *   supported=false 表示"只报差异不给语句"，reason 说明原因（type-whitelist /
 *   alter-unsupported / missing-target-loc / index-changed / fk-not-generated …）。
 *   sqls 为空时 supported 必为 false。
 */
export function entryToDdl (entry, dialect, baseLoc) {
  const kind = entry && entry.kind
  if (!entry || !kind) {
    return unsupported('no-entry')
  }
  if (entry.status === 'equal') {
    return unsupported('equal')
  }
  const d = getDialect(dialect)
  if (!d) {
    return unsupported('unknown-dialect')
  }
  // 能力位闸而不是引擎名闸：新方言只要在 dialectMap 里声明 alterDdl 就能进来，
  // 不用回来加 if；没声明的一律只读预览（保守降级）。
  if (!capabilityOf(d.id, 'alterDdl')) {
    return unsupported('alter-unsupported')
  }
  if (!baseLoc || !baseLoc.table) {
    return unsupported('missing-target-loc')
  }
  const isPg = d.id === 'postgres'
  const tbl = tableRef(baseLoc, d.id)
  const name = quoteIdent(entryName(entry), d.id)

  // 列级护栏：只拦"这条语句真的碰到的东西"。
  // - 类型在白名单外 → 只有当语句里真的出现类型时才拦（MySQL 的 changed 走
  //   MODIFY 全定义，必然带类型；PG 的 changed 只在 type/length 真变时带 TYPE）
  // - 默认值形态不可安全回写 → 同理，只在语句真的写 DEFAULT 时拦
  const guardColumn = (c, keys) => {
    const touchesType = keys === null || keys.has('type') || keys.has('length')
    const touchesDefault = keys === null || keys.has('default')
    if (touchesType && !typeAllowed(colType(c), d.id)) {
      return 'type-whitelist'
    }
    if (touchesDefault && defaultKind(c) === 'lit-unsafe') {
      return 'default-expression'
    }
    return ''
  }

  if (kind === 'column') {
    if (entry.status === 'added') {
      const blocked = guardColumn(entry.target, null)
      if (blocked) {
        return unsupported(blocked)
      }
      const sqls = isPg
        ? pgAddColumn(tbl, name, entry.target)
        : mysqlAddColumn(tbl, name, entry.target)
      return sqls.length ? { sqls, supported: true, reason: '' } : unsupported('nothing-to-generate')
    }
    if (entry.status === 'removed') {
      return { sqls: ['ALTER TABLE ' + tbl + ' DROP COLUMN ' + name], supported: true, reason: '' }
    }
    // changed：MySQL 的 MODIFY 是全定义重写（碰类型也碰默认），PG 按变化字段逐条发
    const blocked = guardColumn(entry.target, isPg ? changedKeys(entry) : null)
    if (blocked) {
      return unsupported(blocked)
    }
    const sqls = isPg
      ? pgColumnChange(entry, tbl, name)
      : mysqlColumnChange(entry, tbl, name)
    return sqls.length ? { sqls, supported: true, reason: '' } : unsupported('nothing-to-generate')
  }

  if (kind === 'index') {
    if (entry.status === 'changed') {
      // 列序/唯一性变更难以安全表达（PG 的 CREATE INDEX 不能原地改），只报差异
      return unsupported('index-changed')
    }
    if (entry.status === 'added') {
      const ix = entry.target
      if (ix.primary) {
        // 主键变更涉及既有数据唯一性，不给盲生成语句
        return unsupported('primary-index')
      }
      if (!Array.isArray(ix.columns) || !ix.columns.length) {
        return unsupported('index-no-columns')
      }
      const sqls = isPg ? pgAddIndex(tbl, ix) : mysqlAddIndex(tbl, ix)
      return { sqls, supported: true, reason: '' }
    }
    // removed：索引名即条目名（MySQL 从表上删，PG 的索引是独立对象、不带表名）。
    // 主键不给删：MySQL 的 DROP INDEX 碰 PRIMARY 直接报错，PG 的主键是约束不是索引，
    // 真删掉等于摘走整张表的唯一性标识 —— 只报差异。
    if (entry.base && entry.base.primary) {
      return unsupported('primary-index')
    }
    return {
      sqls: [isPg ? 'DROP INDEX IF EXISTS ' + name : 'ALTER TABLE ' + tbl + ' DROP INDEX ' + name],
      supported: true,
      reason: ''
    }
  }

  if (kind === 'foreignKey') {
    // 外键变更：本轮不生成（级联动作/引用列差异盲生成风险高），只报差异
    return unsupported('fk-not-generated')
  }

  return unsupported('unknown-kind')
}

/**
 * 把整个差异按 base→target 对齐方向，逐条生成候选 DDL（保持 diff 条目顺序：
 * 列 → 索引 → 外键；equal 的不进列表）。
 * 幂等展示：同一对结构再比一次，生成结果逐字一致。
 * @param {object} diff diffTableStructure 的返回值
 * @param {string} dialect
 * @param {object} baseLoc 基准表定位（生成的语句作用在它上面）
 * @returns {Array<{id, entry, sqls, supported, reason}>}
 */
export function diffToDdl (diff, dialect, baseLoc) {
  const sections = [
    ...(diff && diff.columns ? diff.columns : []),
    ...(diff && diff.indexes ? diff.indexes : []),
    ...(diff && diff.foreignKeys ? diff.foreignKeys : [])
  ]
  return sections
    .filter(entry => entry.status !== 'equal')
    .map(entry => ({
      id: entry.kind + ':' + entryName(entry),
      entry,
      ...entryToDdl(entry, dialect, baseLoc)
    }))
}

// 表注释：MySQL 有内联 COMMENT（清空写 ''），PG 没有内联形态、只能 COMMENT ON（清空写 NULL）
function tableCommentSql (tbl, comment, isPg) {
  if (isPg) {
    return ['COMMENT ON TABLE ' + tbl + ' IS ' + (comment ? strLit(comment) : 'NULL')]
  }
  return ['ALTER TABLE ' + tbl + ' COMMENT ' + (comment ? strLit(comment) : "''")]
}

/**
 * 表注释变更 → 候选语句（N3b 表设计器用）。
 *
 * 为什么不并进 diffToDdl：db-structure-diff 只比列/索引/外键三段，表注释是个标量，
 * 塞进那套按名字配对的机器里只会让它多一个特例。这里单独出一条、返回和 entryToDdl
 * 同形状的结果，调用方拼进同一份勾选列表即可 —— 拼串仍然只在本模块，设计器不碰方言。
 *
 * @param {string} draftComment 草稿里的表注释
 * @param {string} currentComment 当前库里的表注释
 * @param {string} dialect 引擎名（mysql / postgres / …）
 * @param {object} baseLoc 表定位 { database, schema, table }，语句作用在它上面
 * @returns {{sqls: string[], supported: boolean, reason: string}}
 *   两边注释相同（含都为空）时 reason='equal'、supported=false，调用方不入列表。
 */
export function tableCommentDdl (draftComment, currentComment, dialect, baseLoc) {
  // 空注释与无注释同一个意思，首尾空白也不算改过：否则设计器只是焦点进出一次输入框，
  // 预览里就冒出一条假变更
  const norm = v => String(v === null || v === undefined ? '' : v).trim()
  const next = norm(draftComment)
  if (next === norm(currentComment)) {
    return unsupported('equal')
  }
  // 三道闸与 entryToDdl 同序：认不出的方言、没能力的方言、不知道改哪张表
  const d = getDialect(dialect)
  if (!d) {
    return unsupported('unknown-dialect')
  }
  if (!capabilityOf(d.id, 'alterDdl')) {
    return unsupported('alter-unsupported')
  }
  if (!baseLoc || !baseLoc.table) {
    return unsupported('missing-target-loc')
  }
  return {
    sqls: tableCommentSql(tableRef(baseLoc, d.id), next, d.id === 'postgres'),
    supported: true,
    reason: ''
  }
}

/**
 * 把勾选的差异条目拼成一段脚本文本。
 * - 只收 supported 的条目（未生成的差异在 UI 上以 reason 呈现，不混进脚本）
 * - 一条语句一行，行尾分号 —— 落到编辑器后用户可以再挑单句执行
 * @param {Array} items diffToDdl 的返回值
 * @param {Array<string>} selectedIds 勾选的条目 id
 * @returns {string} 无勾选项时返回空串
 */
export function buildScript (items, selectedIds) {
  const picked = items || []
  const ids = selectedIds || []
  const lines = []
  for (const item of picked) {
    if (!item.supported || !ids.includes(item.id)) {
      continue
    }
    for (const sql of item.sqls) {
      lines.push(sql.replace(/;$/, '') + ';')
    }
  }
  return lines.join('\n')
}
