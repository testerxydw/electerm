/**
 * N3b 受限表设计器 —— 草稿模型与候选 DDL 预览（纯函数，零 React、零 IPC）
 *
 * 边界照设计文档 §7 N3 要点 3：**只做**列（增 / 改类型 / 注释 / 可空 / 默认）、
 * 索引（增 / 删）、表注释。**不做**建表向导、分区、外键编辑、存储过程 ——
 * 那些一进来就变成第二套 DDL 引擎。外键在这里只透传展示、没有编辑入口，
 * 免得设计器显示出一副"能改外键"的样子。
 *
 * 关键决定：**生成语句这一段完全不新写**。草稿 → v2 结构 → 复用 N3a 的
 * `diffTableStructure` + `diffToDdl`（类型白名单、默认值不可回读、主键不生成
 * 这些护栏全是现成的），表注释不在那三段里，单独走 `tableCommentDdl`。
 * 于是"改哪列生成什么"只有一处定义，不会出现这边改完那边忘。
 *
 * 方向固定：**当前库结构是 base，草稿是 target**，生成的语句作用在当前表上、
 * 把它对齐成草稿。反过来的话"删一列"会生成 ADD COLUMN，整件事就拧了。
 *
 * 草稿尽量原样携带契约字段（不重新推导 maxLength 之类）：没动过的行必须比出
 * 零差异，否则一打开设计器就冒一堆假变更。
 */
import { diffTableStructure } from './db-structure-diff.js'
import { diffToDdl, tableCommentDdl, createTableDdl } from './db-ddl-generate.js'

let seq = 0
const nextKey = () => 'd' + (++seq)

// 空串 / 全空白 → null，与 db-structure-diff 的 commentOrNull 同一口径：
// 否则"注释框里只剩一个空格"会被比成一次真变更
const blankToNull = v => {
  if (v === null || v === undefined) {
    return null
  }
  const t = String(v).trim()
  return t === '' ? null : t
}

const text = v => String(v === null || v === undefined ? '' : v)

// 草稿列 = 原列的契约字段 + 界面可改的那几项。src 原样留着，draftToStructure
// 先铺 src 再覆盖，保证没改的字段逐字不变。
function toDraftColumn (c) {
  return {
    key: nextKey(),
    origName: text(c.name),
    name: text(c.name),
    // columnType 带长度（varchar(64)），dataType 只有基类：编辑框显示带长度的那个，
    // 生成语句也用它，改起来不会出现"界面上 64、生成的 SQL 没长度"
    type: text(c.columnType || c.dataType),
    nullable: c.nullable === true || c.nullable === 1 || c.nullable === 'YES' || c.nullable === 'yes' || c.nullable === 't',
    // 有没有默认值必须单独记：只留 defaultValue 的话 null 和 '' 会塌成一回事，
    // 而 DEFAULT '' 和"没有默认"在库里是两个意思
    hasDefault: c.defaultValue !== null && c.defaultValue !== undefined,
    defaultValue: c.defaultValue === null || c.defaultValue === undefined ? '' : String(c.defaultValue),
    comment: text(c.comment),
    src: c
  }
}

function toDraftIndex (ix) {
  return {
    key: nextKey(),
    origName: text(ix.name),
    name: text(ix.name),
    columns: (Array.isArray(ix.columns) ? ix.columns : []).map(String),
    unique: ix.unique === true,
    primary: ix.primary === true,
    method: ix.method === null || ix.method === undefined ? null : String(ix.method),
    src: ix
  }
}

/**
 * v2 结构 → 可编辑草稿。
 * @param {object} structure getTableStructure 的返回（v2 契约）
 * @returns {{comment: string, columns: Array, indexes: Array, foreignKeys: Array}}
 */
export function createDraft (structure) {
  const src = structure || {}
  return {
    comment: text(blankToNull(src.comment)),
    columns: (Array.isArray(src.columns) ? src.columns : []).filter(Boolean).map(toDraftColumn),
    indexes: (Array.isArray(src.indexes) ? src.indexes : []).filter(ix => ix && ix.name).map(toDraftIndex),
    // 外键只透传展示，没有任何入口改它
    foreignKeys: Array.isArray(src.foreignKeys) ? src.foreignKeys.filter(Boolean) : []
  }
}

export function newColumn () {
  return {
    key: nextKey(),
    origName: '',
    name: '',
    type: '',
    nullable: true,
    hasDefault: false,
    defaultValue: '',
    comment: '',
    src: null
  }
}

export function newIndex () {
  return {
    key: nextKey(),
    origName: '',
    name: '',
    columns: [],
    unique: false,
    primary: false,
    method: null,
    src: null
  }
}

/**
 * 新建 / 复制表的空基准草稿（方案 B：草稿形状只有 createDraft 一个出口）。
 *
 * 空结构也过一次 createDraft，形状永远与"从真实表复制来的草稿"一致 —— 不再
 * 在组件里手写一份字面量。N7 首版手写 emptyDraft 漏了 foreignKeys，渲染层读
 * `.length` 直接把弹层炸掉，就是两处形状手工对齐的代价。
 * 预置一个空列行：让用户看到编辑行的形状，而不是对着空屏猜。
 */
export function emptyDraft () {
  const d = createDraft({ columns: [], indexes: [], foreignKeys: [] })
  return { ...d, columns: [newColumn()] }
}

/**
 * 把"从别的表读来的草稿"重基线成一张全新表的草稿（复制表功能）。
 *
 * 直接用 createDraft(源结构) 的话，每行都带着 origName/src：渲染层会把列名判成
 * "已有列"而禁用输入（那是改表语义），draftToStructure 还会把源表的契约字段
 * 一起铺进目标结构。新建表里所有列/索引都该可编辑，所以逐行按 newColumn /
 * newIndex 重建，只搬用户看得见的字段；foreignKeys 只留作只读展示。
 */
export function draftAsNew (draft) {
  const d = draft || {}
  return {
    comment: text(d.comment),
    columns: (d.columns || []).filter(Boolean).map(c => ({
      ...newColumn(),
      name: text(c.name),
      type: text(c.type),
      nullable: c.nullable !== false,
      hasDefault: !!c.hasDefault,
      defaultValue: text(c.defaultValue),
      comment: text(c.comment)
    })),
    indexes: (d.indexes || []).filter(Boolean).map(ix => ({
      ...newIndex(),
      name: text(ix.name),
      columns: (ix.columns || []).map(String),
      unique: ix.unique === true,
      primary: ix.primary === true,
      method: ix.method === null || ix.method === undefined ? null : String(ix.method)
    })),
    // 外键只读展示：CREATE 生成器不产外键，留着是让用户看见"源表挂着外键"
    foreignKeys: Array.isArray(d.foreignKeys) ? d.foreignKeys.filter(Boolean) : []
  }
}

const name = v => String(v === null || v === undefined ? '' : v).trim()
const fold = v => name(v).toLowerCase()

/**
 * 草稿 → v2 结构（喂给 diffTableStructure 当 target）。
 * 先铺原契约字段再覆盖可改项：这样"只改了注释"的行不会顺带把 maxLength 弄没，
 * 比较结果就只剩真改过的那一项。
 */
export function draftToStructure (draft) {
  const d = draft || {}
  return {
    type: 'table',
    comment: blankToNull(d.comment),
    columns: (d.columns || []).filter(c => name(c.name)).map(c => ({
      ...(c.src || {}),
      name: name(c.name),
      columnType: name(c.type),
      nullable: c.nullable !== false,
      defaultValue: c.hasDefault ? c.defaultValue : null,
      comment: blankToNull(c.comment)
    })),
    indexes: (d.indexes || []).filter(ix => name(ix.name)).map(ix => ({
      ...(ix.src || {}),
      name: name(ix.name),
      columns: (ix.columns || []).map(String),
      unique: ix.unique === true,
      primary: ix.primary === true,
      method: ix.method === null || ix.method === undefined ? null : String(ix.method)
    })),
    // 外键原样透传：设计器没有任何改它的入口，比出一个"外键被删了"纯属凭空多出来
    // 的噪声（而且那条还是不给语句的，用户只会看到一条说不清的差异）
    foreignKeys: (d.foreignKeys || []).filter(Boolean)
  }
}

/**
 * 草稿自身的硬错误：空名 / 重名 / 改了已有列的名 / 索引没列。
 *
 * 改名这一条界面上本就没有入口（名列只读），这里仍然拦：按名字配对的比较会把
 * "改名"读成"删一列再加一列"，落到真库就是**整列数据没了**。破坏性这么高的误判
 * 不能只靠 UI 不出按钮来兜。
 *
 * @param {object} draft
 * @returns {Array<{code: string, name: string}>} 空数组 = 草稿可用
 */
export function designIssues (draft) {
  const d = draft || {}
  const out = []
  const seenCol = new Set()
  for (const c of d.columns || []) {
    const n = name(c.name)
    if (!n) {
      out.push({ code: 'unnamed-column', name: '' })
      continue
    }
    if (seenCol.has(fold(n))) {
      out.push({ code: 'duplicate-column', name: n })
    }
    seenCol.add(fold(n))
    if (name(c.origName) && fold(c.origName) !== fold(n)) {
      out.push({ code: 'renamed-column', name: n })
    }
  }
  const seenIx = new Set()
  for (const ix of d.indexes || []) {
    const n = name(ix.name)
    if (!n) {
      out.push({ code: 'unnamed-index', name: '' })
      continue
    }
    if (!(ix.columns || []).length) {
      out.push({ code: 'empty-index-columns', name: n })
    }
    if (seenIx.has(fold(n))) {
      out.push({ code: 'duplicate-index', name: n })
    }
    seenIx.add(fold(n))
    if (name(ix.origName) && fold(ix.origName) !== fold(n)) {
      out.push({ code: 'renamed-index', name: n })
    }
  }
  return out
}

/**
 * 草稿 → 候选语句（方案 B：新建/改表共用的唯一预览入口）。
 *
 * 一条流水线、三个基准：
 * - alter  base = 当前表结构，target = 当前表 → 逐条 ALTER（差异）
 * - create  base = 空结构 / 复制来的别的表结构，target = 新表 → 一条 CREATE（全量）
 * 两条分支都先过 designIssues（同一套草稿校验），再过 draftToStructure（唯一
 * 归一化出口），方言拼串各交给 diffToDdl / createTableDdl，但列定义共用
 * colDefTail。组件里不再有"create 模式另算一套预览"的分支。
 *
 * @param {object} opts
 * @param {'alter'|'create'} opts.mode 缺省 alter（兼容既有调用）
 * @param {object} opts.current 当前 v2 结构（仅 alter 用）
 * @param {object} opts.draft 设计器草稿
 * @param {string} opts.dialect 引擎名
 * @param {object} opts.loc 表定位（alter 的基准表）
 * @param {object} opts.target create 的目标 { database, schema, table }
 * @returns {{diff: object|null, items: Array, issues: Array}}
 *   issues 非空时 items=[] —— 草稿本身不合法就不该给语句。
 */
export function designPreview ({ mode, current, draft, dialect, loc, target }) {
  const issues = designIssues(draft)
  if (issues.length) {
    return { diff: null, items: [], issues }
  }
  if (mode === 'create') {
    // 方言能力 / 表名 / 列名 / 类型 / 索引列引用的拒绝理由由生成器给 reason，
    // 渲染层与 ALTER 的 item.reason 共用 ddlReasonKey 一套文案，不再有两套口径。
    const res = createTableDdl(draftToStructure(draft), dialect, target || loc)
    return {
      diff: null,
      items: [{
        id: 'create-table',
        entry: null,
        sqls: res.sqls,
        supported: res.supported,
        reason: res.reason
      }],
      issues: []
    }
  }
  const diff = diffTableStructure(current || {}, draftToStructure(draft), { dialect })
  const items = diffToDdl(diff, dialect, loc)
  const cmt = tableCommentDdl((draft || {}).comment, (current || {}).comment, dialect, loc)
  if (cmt.reason !== 'equal') {
    items.unshift({
      id: 'table:comment',
      entry: { kind: 'table', name: 'comment', status: 'changed' },
      ...cmt
    })
  }
  return { diff, items, issues }
}
