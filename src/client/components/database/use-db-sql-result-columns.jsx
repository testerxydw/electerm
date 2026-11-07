// #23 SQL 结果列定义与派生视图（cluster #23 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「SQL 结果集怎么被看见」这一个职责域：
//   列名来源    sqlColumnKeys（fields 优先，否则首行推键）
//   列宽        sqlColWidths / sqlFitted / sqlWidths（useColWidths 拖拽机构）
//   列类型      sqlColTypeMaps（columns[].type 小写化，与数据页同一套词表）
//   列定义      sqlResultColumns（buildGridColumns 装配）
//   排序口径    sqlSortNumeric（哪些列按数值比较）
//   行派生      sqlResultViews（过滤 → 排序 → 切页，一次算出 matched/pageRows）
//   值面板      sqlCellInfo / sqlValuePane / sqlPaneShown
//
// 行为零变更：整段逐字搬迁（原 2341–2527，187 行），owner 侧改为单次调用。
//
// 为什么是 .jsx：sqlValuePane 直接构造 <DbValuePane />，vite 对 .js 不启用 JSX 解析。
//
// 不回流（仅本簇内部使用）：sqlColumnKeys / sqlColWidths / sqlFitted / sqlLive /
// sqlSortNumeric / sqlCellInfo。
import { useMemo, useState } from 'react'
import DbValuePane from './db-value-pane'
import { buildGridColumns } from './db-grid-columns'
import { useColWidths } from './db-col-resize'
import { fitColumnWidths } from '../../common/db-column-width'
import { isBinaryType, isNumberType } from '../../common/db-format-value'
import { isBinEnvelope } from './value-renderers'
import {
  filterRowIndexes,
  sortRowIndexes,
  sqlViewOf,
  sqlSortOf,
  looksNumericColumn,
  visibleSqlKeys
} from '../../common/db-sql-result'
import { VALUE_META_MIN, sqlPageIndex } from '../../common/db-session-const'

const e = window.translate

export function useDbSqlResultColumns ({
  sqlResult,
  sqlViews,
  sqlPages,
  sqlPageSize,
  sqlCell,
  setSqlCell,
  colMenu,
  renderCell,
  onSqlSort,
  openSqlCellMenu,
  keywordPatterns,
  themeConfig
}) {
  // 结果集的列名：优先 fields（列顺序稳定），否则从首行推断。
  // 量宽的 memo 与列定义 memo 必须用同一个来源，否则"量的列"和"渲染的列"会错位
  const sqlColumnKeys = (r) => {
    const fields = (r && r.fields) || []
    if (fields.length) {
      return fields
    }
    const rows = (r && r.rows) || []
    const first = rows[0]
    return first && typeof first === 'object' ? Object.keys(first) : []
  }

  // H1a-2：SQL 结果列宽。自适应按**各结果集**各自量（同一份手动宽 map 以
  // "下标::列名"为键，多结果集各拖各的互不影响）；手动宽只进内存、不写表视角 ——
  // 结果集的列随查询变，存进视角只会攒脏宽（决策 11），所以重新执行即清空
  const [sqlColWidths, setSqlColWidths] = useState({})
  const sqlFitted = useMemo(() => {
    const out = {}
    for (const [i, r] of (sqlResult.results || []).entries()) {
      const keys = sqlColumnKeys(r)
      const w = fitColumnWidths((r && r.rows) || [], keys)
      for (const k of keys) {
        out[i + '::' + k] = w[k]
      }
    }
    return out
  }, [sqlResult.results])
  const sqlWidths = useColWidths({
    manual: sqlColWidths,
    commit: (upd) => setSqlColWidths(prev => upd(prev)),
    fitted: sqlFitted
  })
  const { live: sqlLive } = sqlWidths

  // H1a-3：SQL 结果的列类型表（每个结果集一份，键为小写列名）。
  // 数据源是适配层新增的并列字段 `columns: [{name, type}]`（主进程
  // app/common/db-type-normalize.js 把驱动的 columnType / dataTypeID 归一成
  // DATA_TYPE 口径名）。刻意与数据页的 colTypeByName **同一套词表**，因为
  // isNumberType/isDateType 认的就是这套名字；换一套就会静默不生效。
  // 老结果（没有 columns）、列名查不到、type 为 '' 都按"不知道类型"处理：
  // 不格式化、不右对齐 —— 宁可不格式化，也不能把 varchar 右对齐。
  const sqlColTypeMaps = useMemo(
    () => (sqlResult.results || []).map(r => {
      const out = Object.create(null)
      for (const c of (r && r.columns) || []) {
        if (c && typeof c.name === 'string' && c.name) {
          out[c.name.toLowerCase()] = String(c.type || '').toLowerCase()
        }
      }
      return out
    }),
    [sqlResult.results]
  )

  // SQL 结果网格列：优先 fields（列顺序稳定），否则从首行推断
  // A1：多结果集按 results 索引派生成「列数组的数组」，随 sqlResult.results 与
  // renderCell 一起 memo —— 否则每次 render（查询进度、无关 state）都会重建列，
  // antd Table 收不到同一份 columns 引用就会整表重渲
  const sqlResultColumns = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      const typeMap = sqlColTypeMaps[i] || {}
      return buildGridColumns({
        // H1a-4：列显隐过滤统一走列工厂的 isVisible（visibleSqlKeys 的
        // 大小写口径原样保留：单列集合复用同一纯函数）
        keys: sqlColumnKeys(r),
        isVisible: k => visibleSqlKeys([k], sqlViewOf(sqlViews, i).hidden).length > 0,
        typeMap,
        // H1a-2：原来是写死 220 —— 短值列一片空白、长值列看不全，两头都难受
        wg: sqlWidths,
        // 复合键只用于宽度：列的 dataIndex/key 仍是列名（每结果集各自一张表）
        widthKeyOf: k => i + '::' + k,
        colMenu,
        wideRows: rows,
        // 宽度用的是「结果集下标::列名」，菜单标题只显示列名
        headKeyOf: k => k,
        hint: `${e('dbColResizeHint')} · ${e('dbColSortHint')}`,
        sortable: true,
        sortOf: k => sqlSortOf(sqlViews, i, k),
        onSort: k => onSqlSort(i, k),
        // H1a-4：单击选中 → 底部完整值面板（与数据页同一套：点一格就展开面板，
        // 不再先出现"单击展开"的折叠工具条）。只标"当前面板在看的那一格"，
        // 不做键盘可达（SQL 结果只读，Enter 没有下一步动作），也不给双击编辑
        cellMenu: true,
        openCellMenu: (ev, row, k) => openSqlCellMenu(ev, i, k, row),
        selectCell: (row, k) => setSqlCell({ rs: i, col: k, rowKey: row.__rowKey }),
        selectedOf: (row, k) => !!(sqlCell && sqlCell.rs === i &&
          sqlCell.col === k && sqlCell.rowKey === row.__rowKey),
        renderCell
      })
    }),
    [sqlResult.results, renderCell, sqlFitted, sqlColWidths, sqlLive, sqlColTypeMaps, sqlCell, sqlViews]
  )

  // SQL 结果渲染：单结果集直接表格；多语句多结果集用 tab 分栏
  // H1：哪些列按数值比较。类型契约在的时候以 columns[].type 为准（varchar 里
  // 放 "10"/"9" 仍是文本序）；驱动没给 columns 时才用值兜底推断。
  // 与右对齐用的是同一条 isNumberType 判定 —— 右对齐的列点表头就该按数排
  const sqlSortNumeric = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      const typeMap = sqlColTypeMaps[i] || {}
      const set = new Set()
      for (const k of sqlColumnKeys(r)) {
        const dt = typeMap[String(k).toLowerCase()] || ''
        if (dt ? isNumberType(dt) : looksNumericColumn(rows, k)) {
          set.add(k)
        }
      }
      return set
    }),
    [sqlResult.results, sqlColTypeMaps]
  )

  // A2：SQL 结果集行键数组提升到组件顶层 useMemo（依赖组件级 sqlResult.results），
  // 避免传输进度等无关重渲触发 antd Table 全行重渲。
  // 分页后只克隆当前页的行（__rowKey 用结果内的绝对下标，翻页不重复也不冲突）
  // H1：过滤 → 排序 → 切页。matched 与 pageRows 同一次派生出来，所以"命中/总数"、
  // 分页器页数、网格里看到的行数永远同一口径（不会出现"共 3 页"而筛完只剩 5 行）
  const sqlResultViews = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      // 过滤只扫可见列：筛的是"看到的东西"，藏起来的列不再参与命中，
      // 否则会出现"筛出一堆行却看不出哪列命中的"假案
      const keys = visibleSqlKeys(sqlColumnKeys(r), sqlViewOf(sqlViews, i).hidden)
      const indexes = filterRowIndexes(rows, keys, sqlViewOf(sqlViews, i).filter)
      const ordered = sortRowIndexes(rows, indexes, sqlViewOf(sqlViews, i).sort, sqlSortNumeric[i])
      const start = (sqlPageIndex(sqlPages[i], ordered.length, sqlPageSize) - 1) * sqlPageSize
      return {
        total: rows.length,
        matched: ordered.length,
        pageRows: ordered.slice(start, start + sqlPageSize).map(idx => ({ ...rows[idx], __rowKey: idx }))
      }
    }),
    [sqlResult.results, sqlPages, sqlPageSize, sqlViews, sqlSortNumeric]
  )

  // H1a-4：选中格的完整值面板数据。按 (rs, rowKey, col) 现取、不复制值 ——
  // 一次执行可能是 1 万行的大数组。行取不到（重新执行把结果换了、页码越界）就当
  // 没选中，工具条与面板一起消失，不留一个指向空气的标题
  const sqlCellInfo = useMemo(() => {
    if (!sqlCell) {
      return null
    }
    const results = sqlResult.results || []
    const r = results[sqlCell.rs]
    const row = r && Array.isArray(r.rows) ? r.rows[sqlCell.rowKey] : null
    if (!row) {
      return null
    }
    const value = row[sqlCell.col]
    const type = (sqlColTypeMaps[sqlCell.rs] || {})[String(sqlCell.col).toLowerCase()] || ''
    // 多结果集时必须标出是哪一集：页签在上面、面板在下面，只写列名会对不上号
    const head = results.length > 1
      ? e('dbResultN').replace('{n}', sqlCell.rs + 1) + ' · '
      : ''
    return {
      value,
      column: { name: sqlCell.col, type, isBinary: isBinaryType(type) },
      title: head + sqlCell.col + ' · ' + e('dbRowN').replace('{n}', Number(sqlCell.rowKey) + 1),
      meta: isBinEnvelope(value)
        ? value.__bin.size + ' bytes'
        : (typeof value === 'string' && value.length > VALUE_META_MIN ? value.length + ' chars' : '')
    }
  }, [sqlCell, sqlResult.results, sqlColTypeMaps])

  // 展开态：复用数据页那个 DbValuePane（editable=false → 没有编辑/保存入口，
  // 但格式切换、高亮、复制、选区右键复制都还在）。× = 取消选中、面板收起，
  // 与数据页点击打开下方预览框的交互对齐（点一格就展开，不再先出一行提示条）
  const sqlValuePane = sqlCellInfo
    ? (
      <DbValuePane
        title={sqlCellInfo.title}
        meta={sqlCellInfo.meta}
        value={sqlCellInfo.value}
        column={sqlCellInfo.column}
        patterns={keywordPatterns}
        themeConfig={themeConfig}
        editable={false}
        onClose={() => setSqlCell(null)}
      />
      )
    : null

  // "展开"要真的有东西可展：重新执行会清掉选中（sqlCellInfo 变 null），
  // 此时 bottom 必须是 null，否则半屏空容器会把网格压成一小条
  const sqlPaneShown = !!sqlCellInfo

  // H1a-2：重新执行 = 新一轮列宽（拖过的宽对新结果集没有意义）。翻页 / 本地过滤 /
  // 换分页大小都不走到这里，所以那些场景下列宽保持不变。
  // 原 owner 直接清空手动宽 map，这里包一层语义化出口，不外泄裸 setter
  // （全站唯一清空点，契约 db-column-width.spec.js 钉住它）
  const resetSqlColWidths = () => setSqlColWidths({})

  return {
    sqlWidths,
    sqlColTypeMaps,
    sqlResultColumns,
    sqlResultViews,
    sqlValuePane,
    sqlPaneShown,
    resetSqlColWidths
  }
}
