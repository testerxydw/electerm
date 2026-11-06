/**
 * 数据页 / SQL 结果集的导出与复制（N11a 第 3 步，自 db-session.jsx 原样搬出）
 *
 * 这一块管三件事，口径必须一致，所以放在同一个 hook 里：
 * - 范围：有选中行只导选中，无选中导当前可见结果集（含 T1 过滤，所见即所得）
 * - 列序：数据页取 visibleColumnNames（隐藏列不导），SQL 结果取 fields
 * - 落地：导文件走 downloadCsv / downloadText，复制走 clipboard copy
 *
 * 依赖全部由会话页注入，这里不自建状态：grid / 选中行 / 可见列的 owner 都在页面上，
 * hook 只负责"把它们变成一份导出内容"。SQL 结果单元格的右键菜单（openSqlCellMenu）
 * 仍留在页面——它管的是浮层与"按值过滤"联动，只是共用这里的 sqlExportHeaders 列序。
 */
import { copy } from '../../common/clipboard'
import {
  downloadCsv,
  downloadText,
  buildCopyStatements,
  sqlQuoteModeOf,
  toTsv,
  toJsonl,
  toMarkdownTable
} from '../../common/db-csv'
import { tsName } from '../../common/db-session-const'

export function useDbExport ({
  grid,
  selectedRowKeys,
  filteredRows,
  sel,
  tab,
  pkColumn,
  visibleColumnNames
}) {
  // A4 导出范围（同 A1 拍板语义）：有选中行 = 仅选中行；无选中 = 当前可见结果集
  const gridExportRows = () => selectedRowKeys.length
    ? grid.rows.filter((_, i) => selectedRowKeys.includes(i))
    : filteredRows

  // 导出列集 = 当前可见列（§7.6 验收 4：隐藏列不导出，导出按当前可见列 + 当前条件）。
  // 复制为 INSERT/TSV 走同一条：隐藏列意味着用户此刻不关心它，
  // 但真去读 row[k] 仍是原值 —— 格式化只发生在 renderCell，从不回流到这里
  const gridExportHeaders = () => grid.rows.length
    ? visibleColumnNames(Object.keys(grid.rows[0]))
    : []

  // 网格导出：列取当前可见列（grid.rows 不含 __rowKey）
  const exportGridCsv = () => {
    if (!grid.rows.length) {
      return
    }
    downloadCsv(
      `db-${sel.database}-${sel.table}-${tsName()}.csv`,
      gridExportHeaders(),
      gridExportRows()
    )
  }

  // 网格导出 JSON / SQL INSERT（共用 A1 语句生成核心）
  const exportGridAs = (kind) => {
    if (!grid.rows.length || !sel) {
      return
    }
    const headers = gridExportHeaders()
    const base = `db-${sel.database}-${sel.table}-${tsName()}`
    if (kind === 'json') {
      const rows = gridExportRows().map(r => {
        const o = {}
        headers.forEach(h => {
          o[h] = r && r[h] !== undefined ? r[h] : null
        })
        return o
      })
      downloadText(`${base}.json`, 'application/json;charset=utf-8', JSON.stringify(rows, null, 2))
      return
    }
    downloadText(
      `${base}.sql`,
      'text/plain;charset=utf-8',
      buildCopyStatements('insert', {
        table: sel.table,
        database: sel.database,
        headers,
        rows: gridExportRows(),
        pkColumn,
        quote: sqlQuoteModeOf(tab.dbType)
      })
    )
  }

  // SQL 结果导出：列取 fields（缺省回退首行键），行取该结果集 rows
  const sqlExportHeaders = r => {
    const rows = (r && r.rows) || []
    return (r.fields && r.fields.length)
      ? r.fields
      : (rows.length ? Object.keys(rows[0]) : [])
  }
  const exportSqlCsv = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadCsv(`db-sql-result-${i + 1}-${tsName()}.csv`, sqlExportHeaders(r), rows)
  }

  // SQL 结果导出 JSON：直接序列化该结果集 rows
  const exportSqlJson = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.json`,
      'application/json;charset=utf-8',
      JSON.stringify(rows, null, 2)
    )
  }

  // SQL 结果导出 TSV：贴表格软件（Excel/剪贴板同款转义），制表/换行压成空格
  const exportSqlTsv = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.tsv`,
      'text/tab-separated-values;charset=utf-8',
      toTsv(sqlExportHeaders(r), rows)
    )
  }

  // SQL 结果导出 JSONL（ndjson）：一行一个 JSON 对象，流式工具逐行可读
  const exportSqlJsonl = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.jsonl`,
      'application/x-ndjson;charset=utf-8',
      toJsonl(sqlExportHeaders(r), rows)
    )
  }

  // SQL 结果导出 Markdown：直接贴进文档/issue 就是表格
  const exportSqlMarkdown = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.md`,
      'text/markdown;charset=utf-8',
      toMarkdownTable(sqlExportHeaders(r), rows)
    )
  }

  // A1 复制为 INSERT/UPDATE/JSON/TSV：有选中行 = 仅选中行；无选中 = 当前可见
  // 结果集（含 T1 过滤，所见即所得）。列序以 grid.rows 首行键为准（无 __rowKey）
  const copyGridAs = (kind) => {
    if (!grid.rows.length || !sel) {
      return
    }
    const rows = selectedRowKeys.length
      ? grid.rows.filter((_, i) => selectedRowKeys.includes(i))
      : filteredRows
    const text = buildCopyStatements(kind, {
      table: sel.table,
      database: sel.database,
      headers: gridExportHeaders(),
      rows,
      pkColumn,
      quote: sqlQuoteModeOf(tab.dbType)
    })
    copy(text)
  }

  // gridExportRows / gridExportHeaders 是簇内部helper（范围和列序各一处口径），不对外
  return {
    exportGridCsv,
    exportGridAs,
    sqlExportHeaders,
    exportSqlCsv,
    exportSqlJson,
    exportSqlTsv,
    exportSqlJsonl,
    exportSqlMarkdown,
    copyGridAs
  }
}
