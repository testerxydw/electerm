/**
 * H3b：整库外键 → ER 图数据（纯函数，零依赖）
 *
 * 两个方言各自把 information_schema / pg_constraint 的行归一成同一形状，
 * 渲染侧只认一种：
 *   { schema, tables: [{ schema, name }],
 *     edges: [{ name, from: {schema,name}, to: {schema,name}, columns: [{from,to}] }] }
 *
 * 节点键一律是 `schema.name`：MySQL 的 schema 就是库名（database），PG 是当前 schema。
 * 跨库/跨 schema 的外键不出图（另一端不在这张图里，画出来就是断头边）。
 */

function nodeKey (schema, name) {
  return String(schema || '') + '\u0000' + String(name || '')
}

function nodeRef (schema, name) {
  return { schema: String(schema || ''), name: String(name || '') }
}

function assemble ({ tableRows, edgeList, schema }) {
  const tables = []
  const seen = new Set()
  for (const t of tableRows || []) {
    const name = String((t && t.name) || '')
    if (!name) {
      continue
    }
    const key = nodeKey(schema, name)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    tables.push(nodeRef(schema, name))
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const edges = edgeList
    .filter(e => seen.has(nodeKey(e.from.schema, e.from.name)) && seen.has(nodeKey(e.to.schema, e.to.name)))
    .sort((a, b) => {
      const ka = a.from.name + '\u0000' + a.to.name + '\u0000' + a.name
      const kb = b.from.name + '\u0000' + b.to.name + '\u0000' + b.name
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  return { schema: String(schema || ''), tables, edges }
}

/**
 * MySQL：KEY_COLUMN_USAGE 每列一行（复合外键拆成 N 行，按 ORDINAL_POSITION 排好）。
 * 同一 (表, 约束名) 的行聚成一条边，列对顺序与查询顺序一致。
 */
function fromMysql ({ tables, fkRows, database }) {
  const schema = String(database || '')
  const byEdge = new Map()
  for (const r of fkRows || []) {
    const refSchema = String(r.ref_schema || schema)
    if (refSchema !== schema) {
      continue
    }
    const from = nodeRef(schema, r.table_name)
    const to = nodeRef(schema, r.ref_table)
    const name = String(r.fk_name || '')
    const key = nodeKey(schema, r.table_name) + '\u0000' + name
    let edge = byEdge.get(key)
    if (!edge) {
      edge = { name, from, to, columns: [] }
      byEdge.set(key, edge)
    }
    edge.columns.push({ from: String(r.column_name || ''), to: String(r.ref_column || '') })
  }
  return assemble({ tableRows: tables, edgeList: Array.from(byEdge.values()), schema })
}

/**
 * PG：pg_constraint 一行一条外键，列对是两个 text[]（conkey/confkey 按序号对齐）。
 * 任一列缺失（无权限/系统目录被裁剪）就丢这条边 —— 半张列对画出来比没有更误导。
 */
function fromPg ({ tables, fkRows, schema }) {
  const sch = String(schema || '')
  const edgeList = []
  for (const r of fkRows || []) {
    const refSchema = String(r.ref_schema || sch)
    if (refSchema !== sch) {
      continue
    }
    const cols = Array.isArray(r.columns) ? r.columns : []
    const refCols = Array.isArray(r.ref_columns) ? r.ref_columns : []
    if (!cols.length || cols.length !== refCols.length) {
      continue
    }
    edgeList.push({
      name: String(r.fk_name || ''),
      from: nodeRef(sch, r.table_name),
      to: nodeRef(sch, r.ref_table),
      columns: cols.map((col, i) => ({ from: String(col || ''), to: String(refCols[i] || '') }))
    })
  }
  return assemble({ tableRows: tables, edgeList, schema: sch })
}

module.exports = { fromMysql, fromPg }
