// #22 数据网格列定义与单元格交互（cluster #22 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「数据网格的列」这一个职责域的全部内容：
//   - 单元格渲染      renderCell（NULL/空串/二进制/对象/格式化 + 关键字高亮）
//   - 列宽            columnWidths（按内容自适应）/ dataWidths（拖拽机构 + 持久化视角）
//   - 列序与显隐      orderedColumnNames / hiddenColumnSet / visibleColumnNames / moveColumn / toggleColumnVisible
//   - 列头菜单        colMenu / colMenuTarget / handleColMenuHide / sortOrderOf
//   - 列类型与注释    colTypeByName / colCommentByName
//   - 单元格右键菜单  openDataCellMenu（复制值/列名/整行、值面板、编辑、按值过滤、外键跳转）
//   - 列定义装配      columns（buildGridColumns）
//
// 行为零变更：三段逐字搬迁，中间只把 useDbExport 的接线留在 owner
// （它按渲染期取值读 visibleColumnNames，必须排在本 hook 之后 —— 原注释已写明这是 TDZ 硬约束）。
// 行复制列序 rowColumnNames 与 openDataCellMenu 同源（都取"屏幕上看到的列"），随簇搬入。
//
// 不回流（仅本簇内部使用）：columnWidths / colCommentByName / hiddenColumnSet /
// sortOrderOf / openDataCellMenu / dataLive。
import { useCallback, useMemo } from 'react'
import { Button, Tooltip } from 'antd'
import { ColumnWidthOutlined } from '@ant-design/icons'
import { buildGridColumns } from './db-grid-columns'
import { useColMenu, useColWidths } from './db-col-resize'
import { buildRefItems } from './db-ref-utils'
import { isBinEnvelope } from './value-renderers'
import { hlNode } from './db-search'
import { highlightValue } from './db-highlight'
import { fitColumnWidths, cellText } from '../../common/db-column-width'
import { buildCopyStatements, toTsv } from '../../common/db-csv'
import { copy } from '../../common/clipboard'
import { formatCellValue } from '../../common/db-format-value'

const e = window.translate

export function useDbGridColumns ({
  keywordPatterns,
  kw,
  themeConfig,
  formatLocale,
  grid,
  view,
  viewRef,
  structureV2,
  structureV2Ref,
  patchViewColumns,
  sel,
  pkColumn,
  editing,
  editValue,
  setEditValue,
  setEditing,
  setSelectedCell,
  canEditCell,
  langCode,
  pageFilterKw,
  startEdit,
  cancelEdit,
  submitEdit,
  selectCell,
  onColSort,
  setPageFilter,
  setCellMenu,
  openRefTable,
  dialect
}) {
  // dataType 来自 structureV2.columns（数据页）或结果集的 columns[].type（SQL 结果，
  // H1a-3）；两处都拿不到类型时传 '' —— 此时只格式化"驱动已经给出 JS number"的值，
  // 字符串不猜
  // A1：renderCell 提升为 useCallback，依赖其闭包引用的随渲染变化的值
  // （keywordPatterns/kw/themeConfig/formatLocale）；hlNode/highlightValue/
  // formatCellValue/isBinEnvelope 为模块级纯函数，稳定，不进依赖
  const renderCell = useCallback((v, cellFilterKw = '', dataType = '') => {
    // antd 的 render(text, record, index) 会把整行对象传进第二参。
    // 只认字符串关键字：否则 hlNode 会拿对象去 indexOf，靠"[object Object]" 永不命中
    // 蒙混过关（能跑，但语义是错的）
    const filterKw = typeof cellFilterKw === 'string' ? cellFilterKw : ''
    let node
    if (v === null || v === undefined) {
      node = <span className='db-cell-null'>NULL</span>
    } else if (v === '') {
      // H2：空串与 NULL 都是"格子空白"，肉眼分不出是哪一种。空串给一对引号
      // 占位（低对比细体），NULL 保持半透明 NULL —— 复制/导出/编辑仍取原值
      node = <span className='db-cell-empty'>''</span>
    } else if (isBinEnvelope(v)) {
      // F3：二进制列在网格里只显示大小占位（完整内容在下方值面板按呈现器解码）
      node = hlNode(
        highlightValue('<binary ' + v.__bin.size + ' bytes>', keywordPatterns, themeConfig),
        kw
      )
    } else if (typeof v === 'object') {
      node = hlNode(highlightValue(JSON.stringify(v).slice(0, 200), keywordPatterns, themeConfig), kw)
    } else {
      // 数字/布尔也一并走高亮：关键字规则常写成 `\b(0|1)\b` 这类。
      // 格式化只改这一处显示文本：编辑框取原值（见下方 Input 的 value）、
      // 导出取原始行、UPDATE 拼原值，三条都不经过 formatCellValue
      node = hlNode(highlightValue(formatCellValue(v, dataType, formatLocale), keywordPatterns, themeConfig), kw)
    }
    // T1 本页过滤高亮用独立 class，避免被顶栏查找计数/导航误收
    return filterKw ? hlNode(node, filterKw, 'db-page-hit') : node
  }, [keywordPatterns, kw, themeConfig, formatLocale])

  // 长内容不再有悬停预览：悬停浮层在大结果上要维护观察者与高亮文本，
  // 实际使用里又经常挡住相邻格子。数据页保持"单击 → 下方值面板"，
  // SQL 结果改成同一套（点击格直接展开，不再先出现折叠工具条）。
  // 列仍用 CELL_ELLIPSIS（ellipsis 但不带 native title）：title 等于给每行每个值
  // 多一份字符串副本，而完整内容在下方面板里随时可看。

  // H1a-2：列头右键菜单是全站单例：给每列各挂一个 Dropdown 的话，
  // 200 列的数据页每次列 memo 重建都要挂/卸上百个 Trigger。
  // 各网格只负责在 onHeaderCell 里把"哪一列 + 属于哪个宽度状态 + 加宽到多少"报过来
  const colMenu = useColMenu()
  // JSX 侧解构成 handle*（包一层箭头就是每轮新引用，浮层会反复摘挂监听）
  const { target: colMenuTarget, hide: handleColMenuHide } = colMenu

  // 列宽按内容自适应（采样前 100 行取最长值）：固定 220 会让短值列
  // （如"一般"）出现大片空白；虚拟渲染是 fixed 布局，必须显式给宽。
  // 采样单独 memo：输入查找/过滤时不必重新扫描 100 行 × 所有列。
  // H1a-1：公式抽到 common/db-column-width（数据页与 SQL/Redis/结构页共用同一套
  // 90~360 上下限）。唯一行为差异：JSON/对象列按真实文本量宽，原实现走
  // String(v) 得到 "[object Object]"（15 字符），是量错了而不是刻意留窄
  const columnWidths = useMemo(
    () => (grid.rows.length ? fitColumnWidths(grid.rows, Object.keys(grid.rows[0])) : {}),
    [grid.rows]
  )

  // 列头排序箭头跟随 view.order（受控）：箭头由 ColHead 自己画，状态只有
  // view.order 一处来源，视角条 chips 一改（比如重置）箭头就跟着回位
  const sortOrderOf = (k) => {
    const key = String(k).toLowerCase()
    const hit = (view.order || []).find(o => String(o.column).toLowerCase() === key)
    return hit ? (hit.desc === true ? 'descend' : 'ascend') : null
  }

  // 列类型表（小写键）：renderCell 的格式化与表头注释都查它。
  // 与 structureV2.columns 同源（getTableStructure），SQL 结果集查不到就是空
  const colTypeByName = useMemo(() => {
    const out = Object.create(null)
    for (const c of structureV2.columns || []) {
      if (c && typeof c.name === 'string' && c.name) {
        out[c.name.toLowerCase()] = String(c.dataType || '')
      }
    }
    return out
  }, [structureV2.columns])

  // 列注释表（小写键）：表头第二行小字。无注释的列不占高度
  const colCommentByName = useMemo(() => {
    const out = Object.create(null)
    for (const c of structureV2.columns || []) {
      if (c && typeof c.name === 'string' && c.name) {
        const comment = typeof c.comment === 'string' ? c.comment.trim() : ''
        if (comment) {
          out[c.name.toLowerCase()] = comment
        }
      }
    }
    return out
  }, [structureV2.columns])

  // 全部列（含被隐藏的）的当前顺序：columnOrder 里点名的列先按那个顺序排，
  // 没提到的列按结果集顺序接在后面 —— 新加的列不能因为旧视角没提它
  // 就被排到看不见的位置。列被删后旧视角里的名字自然消失，静默降级
  const orderedColumnNames = (keys) => {
    const byLower = new Map(keys.map(k => [String(k).toLowerCase(), k]))
    const ordered = []
    const used = new Set()
    for (const name of view.columnOrder || []) {
      const real = byLower.get(String(name).toLowerCase())
      if (real !== undefined && !used.has(real)) {
        ordered.push(real)
        used.add(real)
      }
    }
    for (const k of keys) {
      if (!used.has(k)) {
        ordered.push(k)
      }
    }
    return ordered
  }

  // 可见列 = 全部列的顺序再过滤 hiddenColumns。渲染与导出共用这一个函数，
  // 保证"屏幕上看到的列"与"导出/复制出的列"永远一致（§7.6 验收 4）
  // H1a-4：hiddenColumns 的小写集合单独给出，列工厂的 isVisible 谓词用它
  const hiddenColumnSet = () => new Set((view.hiddenColumns || []).map(h => String(h).toLowerCase()))
  const visibleColumnNames = (keys) => {
    const hidden = hiddenColumnSet()
    return orderedColumnNames(keys)
      .filter(k => !hidden.has(String(k).toLowerCase()))
  }

  // 数据页行对象上的 __rowKey 是网格辅助键（选中/编辑/过滤定位），不是数据列：
  // 从 Object.keys(row) 取列时会跟着进来，复制整行/行详情必须剔掉，
  // 否则导出的那一列是一串与表结构无关的内部下标
  const rowColumnNames = (row) => visibleColumnNames(
    Object.keys(row || {}).filter(k => k !== '__rowKey')
  )

  // H2：数据页单元格右键菜单。落点与菜单项在这里生成，浮层本身是全站单例
  // （DbCellMenu）。列序与导出同源（visibleColumnNames）：复制整行拿到的
  // 就是屏幕上看到的那些列。
  // 外键项只算"本表外键 → 父表"这一向：本地即可判定，不依赖反向引用查询
  // 是否已经为该列返回（refInfo 属于"当前选中格"，右键的格未必就是它）
  const openDataCellMenu = (ev, row, k) => {
    ev.preventDefault()
    if (!sel || !row) {
      return
    }
    const v = row[k]
    const headers = rowColumnNames(row)
    // 过滤词用"格子里看到的文本"：本页过滤比的就是这个（cellText），
    // 复制值那套二进制 base64 在这里没有意义。空串/纯空白给不出词，不提供该项
    const filterText = cellText(v)
    const items = [
      {
        // 与值面板的复制同口径：二进制信封复制 base64，其余复制可读文本
        key: 'value',
        text: e('dbCellCopyValue'),
        onClick: () => copy(isBinEnvelope(v) ? v.__bin.b64 : cellText(v))
      },
      {
        key: 'colname',
        text: e('dbCellCopyColName'),
        onClick: () => copy(k)
      },
      {
        key: 'rowTsv',
        text: e('dbCellCopyRowTsv'),
        onClick: () => copy(toTsv(headers, [row]))
      },
      {
        key: 'rowJson',
        text: e('dbCellCopyRowJson'),
        onClick: () => copy(buildCopyStatements('json', { headers, rows: [row] }))
      },
      {
        // 选中该格 → 底部值面板展开（与单击同一入口，可编辑态也一致）
        key: 'valuePane',
        text: e('dbCellValuePane'),
        onClick: () => selectCell(row, k)
      }
    ]
    if (canEditCell) {
      items.push({
        key: 'edit',
        text: e('dbCellEdit'),
        onClick: () => startEdit(row, k)
      })
    }
    if (filterText.trim()) {
      items.push({
        // 写进现有本页过滤：命中口径、高亮、"清空过滤"按钮都走同一条路
        key: 'filter',
        text: e('dbCellFilterByValue'),
        onClick: () => setPageFilter(filterText)
      })
    }
    const parents = buildRefItems({
      column: k,
      row,
      foreignKeys: (structureV2Ref.current && structureV2Ref.current.foreignKeys) || [],
      references: [],
      database: sel.database,
      schema: sel.schema || '',
      dialect
    })
    for (const item of parents) {
      // NULL / 二进制定位值不能拼 WHERE：与关联页签同一判定，不给出点了没用的项
      if (item.unusable) {
        continue
      }
      items.push({
        key: item.key,
        text: e('dbCellOpenRef').replace('{table}', item.target.table),
        onClick: () => openRefTable(item)
      })
    }
    setCellMenu({ x: ev.clientX, y: ev.clientY, head: k, items })
  }

  // 列宽三源（拖拽中 > 手动 > 自适应 > 90）与拖拽机构抽到 useColWidths，
  // 5 处网格共用同一套。数据页把手动宽提交回**持久化视角**，所以 H1a-2 之后
  // 的行为与之前逐字一致（拖完落盘、切表回来还在）；差别只是实现换了地方 +
  // 起点改用 th 实测宽（不再有"按下第一帧跳回配置宽"的抖动）
  const dataWidths = useColWidths({
    manual: view.columnWidths,
    commit: (upd) => patchViewColumns({
      columnWidths: upd(viewRef.current.columnWidths || {})
    }),
    fitted: columnWidths
  })
  const { live: dataLive } = dataWidths

  // H1a-2：工具行的"自适应全部列"（4 处网格同一个形状）。只在有手动宽时可点：
  // 没拖过/加宽过时按下去不会有任何变化，禁用比"点了没反应"诚实
  const colFitAllBtn = (wg) => {
    const handleFitAll = () => wg.clearAllCols()
    return (
      <Tooltip title={e('dbColAutoFitAll')}>
        <Button
          size='small'
          className='db-col-fitall'
          icon={<ColumnWidthOutlined />}
          disabled={!wg.hasManual}
          onClick={handleFitAll}
        />
      </Tooltip>
    )
  }

  // 显示/隐藏一列。hiddenColumns 存原名（不转小写）：渲染时大小写不敏感匹配，
  // 但存进去的保持用户看到的写法，重置后手改配置文件也能认出来
  const toggleColumnVisible = (name, checked) => {
    const lower = String(name).toLowerCase()
    const cur = (view.hiddenColumns || []).filter(h => String(h).toLowerCase() !== lower)
    if (!checked) {
      cur.push(name)
    }
    patchViewColumns({ hiddenColumns: cur })
  }

  // 上/下移动一列（列显示弹层里的箭头）。移动的是**全部列**的顺序，
  // 不只是可见列：否则"把第 3 列移到最前"会因为前面藏着隐藏列而错位一格
  const moveColumn = (name, dir) => {
    if (!grid.rows.length) {
      return
    }
    const order = orderedColumnNames(Object.keys(grid.rows[0]))
    const i = order.indexOf(name)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) {
      return
    }
    const next = order.slice()
    next.splice(i, 1)
    next.splice(j, 0, name)
    patchViewColumns({ columnOrder: next })
  }

  // A1：主数据网格列定义提升为 useMemo。依赖穷举闭包引用的组件级量：
  // grid.rows（数据）、view（列序/隐藏/列宽/排序箭头）、dataLive（列宽拖拽中）、
  // renderCell（高亮/格式化）、editing/editValue（行内编辑态）、canEditCell（只读态）、
  // pageFilterKw（本页过滤高亮）、colTypeByName/colCommentByName（类型与注释）、
  // langCode（列内 e() 文案随语言切换）、sel/pkColumn（submitEdit → runCellUpdate
  // 的 UPDATE 目标与 WHERE 列；事件处理器本身是每轮新建的闭包，缓存后必须让
  // 它们依赖的数据变化时重建，否则会拿着上一个表的主键拼 UPDATE）
  // ⚠️ dataWidths 里的函数（widthOf/startResize）每轮渲染都是新引用，不进依赖：
  // 进了等于每轮重建列定义，memo 白做。要重建靠的是它们读的那三个量：
  // view（手动宽）/ columnWidths（自适应宽）/ dataLive（拖拽中）
  const columns = useMemo(() => (grid.rows.length
    ? buildGridColumns({
      // H1a-4：列显隐过滤统一走列工厂的 isVisible（排序仍按全部列算）
      keys: orderedColumnNames(Object.keys(grid.rows[0])),
      isVisible: k => !hiddenColumnSet().has(String(k).toLowerCase()),
      typeMap: colTypeByName,
      commentMap: colCommentByName,
      showComment: true,
      wg: dataWidths,
      colMenu,
      wideRows: grid.rows,
      // 数据页原来只说"单击预览/双击编辑"，拖宽这件事在这里等于没人告知——
      // 手柄 hover 才显形，看不到提示就不会有人去试，所以把拖拽提示并进来。
      // 排序提示补上：箭头不再走 antd 的 sorter，也就没有它那句内置 tooltip
      hint: `${canEditCell ? e('dbPreviewEditHint') : e('dbPreviewHint')} · ${e('dbColResizeHint')} · ${e('dbColSortHint')}`,
      filterKw: pageFilterKw,
      editable: true,
      // 排序与 SQL 结果同一套：箭头画在 ColHead，点击走 onColSort 重查（服务端 ORDER BY）
      sortable: true,
      sortOf: sortOrderOf,
      onSort: onColSort,
      keyboardAccessible: true,
      // H2：右键单元格出菜单（复制/编辑/值面板/外键跳转），与 SQL 结果共用一个浮层
      cellMenu: true,
      openCellMenu: openDataCellMenu,
      selectCell,
      cellBaseClass: 'db-cell-editable',
      canEditCell,
      startEdit,
      cancelEdit,
      submitEdit,
      editing,
      editValue,
      onEditValueChange: setEditValue,
      // Escape 同时清掉选中与编辑态（原数据页 onCell onKeyDown 逐字等价）
      onClearSelection: () => {
        setSelectedCell(null)
        setEditing(null)
      },
      renderCell
    })
    : []), [grid.rows, view, dataLive, renderCell, editing, editValue, canEditCell, pageFilterKw, colTypeByName, colCommentByName, langCode, sel, pkColumn])

  return {
    renderCell,
    colMenu,
    colMenuTarget,
    handleColMenuHide,
    colTypeByName,
    orderedColumnNames,
    visibleColumnNames,
    rowColumnNames,
    dataWidths,
    colFitAllBtn,
    toggleColumnVisible,
    moveColumn,
    columns
  }
}
