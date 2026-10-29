/**
 * H1a-4（网格复用整合）：数据页与 SQL 结果页共用的网格列定义工厂。
 *
 * 为什么抽到这里：两页的列定义 ~80% 重复 —— 都是 ColHead 标题、width、
 * ellipsis、onHeaderCell 右键列宽菜单、onCell 点击选中、数值右对齐、
 * render 走 renderCell。合法差异只有能力开关：数据页是服务端排序 +
 * 双击编辑 + 键盘可达 + 列头注释；SQL 页是客户端排序 + 单元格右键菜单 +
 * 「结果集下标::列名」复合宽度键 + 只读。
 *
 * 设计取舍：做成**纯函数**而不是 hook —— 工厂不持有任何状态，列 memo 的
 * 依赖数组仍由调用点控制（与 db-session 现在的 memo 依赖逐字一致，
 * widthOf/startResize 这类每轮新引用的函数依旧不进依赖）。
 * db-col-resize.jsx 的 hooks 只包"状态"，这里只做"配置 → 列定义"的映射。
 *
 * ⚠️ 行为契约：重构前后用户可见行为必须逐字节一致。两页的差异全部参数化：
 * - editable / serverSort / keyboardAccessible / showComment：数据页能力
 * - clientSort / cellMenu / widthKeyOf / headKeyOf：SQL 结果页能力
 */
import React from 'react'
import { Input } from 'antd'
import { ColHead } from './db-col-resize'
import { wideColumnWidth } from '../../common/db-column-width'
import { cellAlignClass } from '../../common/db-format-value'

// 截断列的公共配置。showTitle: false 是刻意的：rc-table 在 ellipsis 为真时会把
// 格子里显示的那段文本塞进原生 title，等于给每格的每个值多一份字符串副本；
// 长内容改由"单击格子 → 下方完整值面板"承接，悬停不再弹任何浮层。
export const CELL_ELLIPSIS = { showTitle: false }

/**
 * 生成一份网格列定义。
 *
 * @param {Object}   options
 * @param {Array}    options.keys               列名数组（已按调用方的列序规则排好）
 * @param {Function} [options.isVisible]        可见性谓词 (k) => bool；缺省全部可见。
 *                                               过滤统一在本函数内做（两页一个口径）
 * @param {Object}   [options.typeMap]          小写列名 → 类型名（查不到按 '' 处理）
 * @param {Object}   [options.commentMap]       小写列名 → 注释；showComment 为 false 时可缺省
 * @param {boolean}  [options.showComment]      列头是否展示注释第二行（数据页 true）
 * @param {Object}   options.wg                 useColWidths 返回的宽度系统（ColHead 手柄 + widthOf）
 * @param {Function} [options.widthKeyOf]       宽度键映射，默认 k => k；SQL 结果传 `下标::列名` 复合键
 * @param {Object}   options.colMenu            useColMenu 返回值（openColMenu 挂在 onHeaderCell 上）
 * @param {Array}    [options.wideRows]         量 wideColumnWidth 用的行（数据页全量行 / SQL 各结果集）
 * @param {string}   [options.headClassName]    ColHead 的 className（数据页 'db-col-title'，SQL 缺省）
 * @param {Function} [options.headKeyOf]        列头菜单标题映射；SQL 传列名本身，菜单不露复合键
 * @param {string}   [options.hint]             列头提示文案（调用方按自身能力拼好）
 * @param {string}   [options.filterKw]         renderCell 高亮关键字（数据页本页过滤词，SQL 传 ''）
 * @param {boolean}  [options.editable]         双击编辑 + 编辑态 Input 分支（数据页）
 * @param {boolean}  [options.serverSort]       服务端排序（sorter:true + sortOrder）
 * @param {boolean}  [options.clientSort]       客户端排序（ColHead 受控 sort + onSort）
 * @param {boolean}  [options.cellMenu]         单元格右键菜单（SQL 结果页）
 * @param {boolean}  [options.keyboardAccessible] 键盘可达（Tab/Enter/F2/Escape，数据页）
 * @param {Function} [options.sortOrderOf]      serverSort: k => 'ascend' | 'descend' | null
 * @param {Function} [options.sortOf]           clientSort: k => 'ascend' | 'descend' | null
 * @param {Function} [options.onSort]           clientSort: (k) => void
 * @param {Function} options.selectCell         (row, k) => void，单击选中
 * @param {Function} [options.selectedOf]       (row, k) => bool，选中格高亮（SQL 结果面板联动）
 * @param {string}   [options.cellBaseClass]    单元格基础 class（数据页 'db-cell-editable'，SQL 缺省）
 * @param {Function} [options.openCellMenu]     cellMenu: (ev, row, k) => void
 * @param {boolean}  [options.canEditCell]      editable: 当前表是否可编辑（只读态不进编辑）
 * @param {Function} [options.startEdit]        editable: (row, k) => void
 * @param {Function} [options.cancelEdit]       editable: 退出编辑态
 * @param {Function} [options.submitEdit]       editable: 提交编辑（Input onPressEnter）
 * @param {Object}   [options.editing]          editable: 编辑态 { rowKey, col } | null
 * @param {string}   [options.editValue]        editable: 编辑框当前值
 * @param {Function} [options.onEditValueChange] editable: (text) => void
 * @param {Function} [options.onClearSelection] keyboardAccessible: Escape 时清选中/编辑
 * @param {Function} options.renderCell         (v, filterKw, dataType) => ReactNode
 * @returns {Array} antd Table columns
 */
export function buildGridColumns (options) {
  const {
    keys,
    isVisible = null,
    typeMap = {},
    commentMap = null,
    showComment = false,
    wg,
    widthKeyOf = k => k,
    colMenu,
    wideRows = [],
    headClassName,
    headKeyOf = null,
    hint = '',
    filterKw = '',
    editable = false,
    serverSort = false,
    clientSort = false,
    cellMenu = false,
    keyboardAccessible = false,
    sortOrderOf = () => null,
    sortOf = () => null,
    onSort,
    selectCell,
    selectedOf = null,
    cellBaseClass = '',
    openCellMenu,
    canEditCell = false,
    startEdit,
    cancelEdit,
    submitEdit,
    editing = null,
    editValue = '',
    onEditValueChange,
    onClearSelection,
    renderCell
  } = options

  // 可见性过滤统一收在这里：调用点只给"全部列（已排好序）+ 可见性谓词"，
  // 数据页（hiddenColumns 大小写不敏感）与 SQL 结果（visibleSqlKeys）各自传谓词
  const list = isVisible ? keys.filter(isVisible) : keys
  return list.map(k => {
    const dataType = typeMap[String(k).toLowerCase()] || ''
    const comment = showComment && commentMap
      ? (commentMap[String(k).toLowerCase()] || '')
      : ''
    // H1a-3：数值列右对齐。按列定一次 class，不在每格的 render 里判 ——
    // 200 行 × 20 列就是 4000 次判定，而这一列的类型根本不会变
    const numCls = cellAlignClass(dataType)
    // 复合键只用于宽度（SQL 结果集）；数据页 widthKeyOf 缺省，宽度键就是列名。
    // 列的 dataIndex/key 永远是列名本身（每结果集各自一张表，不冲突）
    const wk = widthKeyOf(k)
    const col = {
      // H1a-1：操作提示挪到列头，td 不再被"提示语"占用（td 现在只负责悬停预览）
      // H1a-2：表头结构与其余网格统一走 ColHead（列名 + 注释 + 拖拽手柄 + 可选排序）
      title: (
        <ColHead
          label={k}
          colKey={wk}
          wg={wg}
          comment={showComment ? comment : undefined}
          hint={hint}
          className={headClassName}
          sort={clientSort ? sortOf(k) : null}
          onSort={clientSort && onSort ? () => onSort(k) : undefined}
        />
      ),
      dataIndex: k,
      key: k,
      width: wg.widthOf(wk),
      ellipsis: CELL_ELLIPSIS,
      // H1a-2：右键列头出列宽菜单（自适应本列 / 加宽到 N / 自适应全部列）。
      // 加宽目标宽在按下时才量（右键是低频动作），菜单上显示的数字即结果
      onHeaderCell: () => ({
        onContextMenu: ev => colMenu.openColMenu(ev, {
          wg,
          key: wk,
          // SQL 结果的宽度键带「结果集下标::」前缀，菜单标题只显示列名
          ...(headKeyOf ? { head: headKeyOf(k) } : {}),
          wide: wideColumnWidth(wideRows, k)
        })
      }),
      // 数据页：单击选中 → 下方预览面板；双击命中区放在整个单元格（td）上：
      // 值短时后面的空白也能双击进编辑态。SQL 页：单击 → 底部完整值面板，
      // 只读，无双击编辑、无键盘可达，右键出单元格菜单（差异由开关参数化）
      onCell: row => {
        const selected = selectedOf ? selectedOf(row, k) : false
        // class 组合顺序两页原本就不同（数据页 base 在前、SQL 页 numCls 在前），
        // 空段过滤后拼接，与原实现逐字一致
        const cls = [cellBaseClass, numCls, selected ? 'db-cell-selected' : '']
          .filter(Boolean)
          .join(' ')
        return {
          onClick: () => selectCell(row, k),
          ...(cellMenu
            ? { onContextMenu: ev => openCellMenu(ev, row, k) }
            : {}),
          ...(editable
            ? { onDoubleClick: () => canEditCell && startEdit(row, k) }
            : {}),
          ...(keyboardAccessible
            ? {
                // 键盘可达：Tab 进入单元格，Enter 预览/编辑，F2 直接编辑，Esc 退出
                tabIndex: 0,
                'aria-label': k,
                onKeyDown: ev => {
                  // 编辑框内的按键会冒泡到 td：只处理单元格自身获得焦点时的按键
                  if (ev.target !== ev.currentTarget) {
                    return
                  }
                  if (ev.key === 'Enter') {
                    ev.preventDefault()
                    selectCell(row, k)
                    if (canEditCell) {
                      startEdit(row, k)
                    }
                  } else if (ev.key === 'F2' && canEditCell) {
                    ev.preventDefault()
                    startEdit(row, k)
                  } else if (ev.key === 'Escape') {
                    onClearSelection()
                  }
                }
              }
            : {}),
          className: cls
        }
      },
      render: editable
        ? (v, row) => {
            if (editing && editing.rowKey === row.__rowKey && editing.col === k) {
              return (
                <Input
                  size='small'
                  autoFocus
                  className='db-cell-editor'
                  value={editValue}
                  onChange={ev => onEditValueChange(ev.target.value)}
                  onPressEnter={submitEdit}
                  onKeyDown={ev => {
                    if (ev.key === 'Escape') {
                      ev.preventDefault()
                      cancelEdit()
                    }
                  }}
                  onBlur={cancelEdit}
                />
              )
            }
            return renderCell(v, filterKw, dataType)
          }
        // H1a-3：以前这里直接写 `render: renderCell`，antd 传的 (值, 整行, 下标)
        // 会把**行下标**当成 dataType —— 类型必须显式传，关键字不预留就传 ''
        : v => renderCell(v, filterKw, dataType)
    }
    // 服务端排序走 antd 的 sorter 标记（数据页 onTableChange 重新查询）；
    // 客户端排序走 ColHead 受控箭头（SQL 结果，不重新执行 SQL）。两页互斥
    if (serverSort) {
      col.sorter = true
      col.sortOrder = sortOrderOf(k)
    }
    return col
  })
}
