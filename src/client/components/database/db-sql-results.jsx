// SQL 结果区渲染（N11a 拆分 #14）：把 db-session.jsx 里的 renderSqlResults /
// renderOne 提升为不依赖 DbSession 闭包的可复用展示组件。
//
// 行为零变更：JSX 与逻辑与原文逐字一致，仅把从 DbSession 作用域读取的
// 状态 / 回调 / 派生值改为显式 props 注入（句柄归属：owner 持有状态与 setter，
// 这里只渲染）。下列值由 owner 注入：
//   sqlResult          执行结果对象 { results, elapsedMs, error }
//   sqlResultViews     各结果集的派生视图（total/matched/pageRows），owner 已 memo
//   sqlResultColumns   各结果集的 antd 列定义数组，owner 已 memo（内含 renderCell）
//   sqlViews           各结果集的视图态数组（供 sqlViewOf 取 filter/sort/hidden）
//   sqlPages           各结果集当前页码
//   sqlPageSize        每页行数
//   sqlJumpDraft       页码跳转输入框草稿
//   sqlWidths          列宽状态（含 live / hasManual / clearAllCols）
//   sqlFilterDraft     结果过滤输入框草稿
//   setSqlJumpDraft / setSqlPages / setSqlViews   对应的 state setter
//   onChangeSqlPageSize / onSqlFilterInput / onSqlToggleCol  交互回调
//   exportSqlJson / exportSqlCsv / exportSqlTsv / exportSqlJsonl / exportSqlMarkdown
//                     各格式导出回调
//
// 模块级纯函数 sqlColumnKeys / colFitAllBtn 与原文逐字一致（不依赖 DbSession 闭包）。

import React from 'react'
import { Select, Checkbox, Dropdown, Tooltip, Button, Tabs } from 'antd'
import { SearchOutlined, EyeOutlined, DownloadOutlined, ColumnWidthOutlined } from '@ant-design/icons'
import { DbGridPager, DbGridFilter } from './db-grid-pager'
import DbGridTable from './db-grid-table'
import {
  sqlViewOf, patchSqlView, sqlRowLimitNote, SQL_SORT_BIG_ROWS
} from '../../common/db-sql-result'
import { dbPageSizeOptions, sqlPageIndex } from '../../common/db-session-const'

// 与 db-session.jsx 一致：模块加载时绑定 window.translate 函数引用（调用时才取值，
// 切语言后文案随之更新；不在此缓存翻译后的字符串）
const e = window.translate

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

// H1a-2：结果集列宽"自适应全部列"按钮（与列头右键菜单同一动作）。
// wg 即 sqlWidths：hasManual 决定可否点，clearAllCols 清掉手动宽
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

export default function DbSqlResults (props) {
  const {
    sqlResult,
    sqlResultViews,
    sqlResultColumns,
    sqlViews,
    sqlPages,
    sqlPageSize,
    sqlJumpDraft,
    sqlWidths,
    sqlFilterDraft,
    setSqlJumpDraft,
    setSqlPages,
    setSqlViews,
    onChangeSqlPageSize,
    onSqlFilterInput,
    onSqlToggleCol,
    exportSqlJson,
    exportSqlCsv,
    exportSqlTsv,
    exportSqlJsonl,
    exportSqlMarkdown
  } = props

  const renderOne = (r, i) => {
    const view = sqlResultViews[i] || { total: 0, matched: 0, pageRows: [] }
    const filter = sqlViewOf(sqlViews, i).filter
    const sort = sqlViewOf(sqlViews, i).sort
    const keys = sqlColumnKeys(r)
    const hidden = sqlViewOf(sqlViews, i).hidden || []
    // 超过一页才出分页器（单行结果保持原样）。
    // 分页器放表格上方 tools 行（与导出同排、靠左）：放表尾会被底部快捷命令栏遮住
    // H1：分页按**过滤后**的行数算，筛完不足一页就不再有分页器
    // H1a-4：从 antd Pagination 换成与数据页同一份 DbGridPager —— 功能不缩水
    // （跳页 + 总数都在；页大小选择器本来就在旁边一行），页码展示口径也对齐
    const page = sqlPageIndex(sqlPages[i], view.matched, sqlPageSize)
    const sqlTotalPages = Math.max(1, Math.ceil(view.matched / sqlPageSize))
    const jumpSqlPage = () => {
      const p = Math.max(1, Number(sqlJumpDraft[i]) || 0)
      if (!p) {
        return
      }
      setSqlJumpDraft(prev => ({ ...prev, [i]: null }))
      setSqlPages(prev => ({ ...prev, [i]: Math.min(p, sqlTotalPages) }))
    }
    const pager = view.matched > sqlPageSize
      ? (
        <DbGridPager
          prevDisabled={page <= 1}
          onPrev={() => setSqlPages(prev => ({ ...prev, [i]: page - 1 }))}
          nextDisabled={page >= sqlTotalPages}
          onNext={() => setSqlPages(prev => ({ ...prev, [i]: page + 1 }))}
          pageNoText={e('dbPageLabel').replace('{n}', page)}
          jump={{
            numeric: true,
            min: 1,
            max: sqlTotalPages,
            value: sqlJumpDraft[i] || null,
            onChange: v => setSqlJumpDraft(prev => ({ ...prev, [i]: v })),
            onPressEnter: jumpSqlPage,
            placeholder: '1-' + sqlTotalPages
          }}
          goDisabled={!sqlJumpDraft[i]}
          onGo={jumpSqlPage}
          totalText={e('dbResultTotal').replace('{n}', view.matched)}
        />
        )
      : null
    return (
      <div key={i} className='db-sql-result-one'>
        <div className='db-sql-result-tools'>
          {pager}
          {
            view.total
              ? (
                <Select
                  size='small'
                  className='db-grid-pagesize'
                  value={sqlPageSize}
                  options={dbPageSizeOptions()}
                  onChange={onChangeSqlPageSize}
                  popupMatchSelectWidth={false}
                  title={e('dbRowsPerPage')}
                />
                )
              : null
          }
          {
            // H1：本页过滤 —— 匹配的是**整份结果**（不是当前页），与数据页那个
            // "筛选当前页"是两件事，所以文案与状态都各归各的。
            // H1a-4：输入框外观与数据页统一走 DbGridFilter（防抖逻辑留在
            // onSqlFilterInput —— 语义是"整份结果"扫描，与数据页的即时高亮不同）
            view.total
              ? (
                <DbGridFilter
                  className='db-sql-filter'
                  suffix={<SearchOutlined />}
                  value={sqlFilterDraft[i] === undefined ? filter : sqlFilterDraft[i]}
                  placeholder={e('dbFilterResult')}
                  onChange={ev => onSqlFilterInput(i, ev.target.value)}
                  count={filter
                    ? e('dbFilterHit').replace('{m}', view.matched).replace('{t}', view.total)
                    : null}
                  countClass={'db-sql-filter-hit' + (view.matched ? '' : ' db-sql-filter-hit-empty')}
                />
                )
              : null
          }
          {
            sort && view.total > SQL_SORT_BIG_ROWS
              ? (
                <span className='db-sql-sort-hint'>
                  {e('dbSortLocal').replace('{n}', view.total)}
                </span>
                )
              : null
          }
          {
            // H1：列显隐。每列一个 Checkbox 项 + "显示全部"，藏在同一个下拉里
            // （列多时弹层自己滚，见 .db-sql-cols-menu）。单列结果没有可藏的，
            // 不出这个按钮。trigger 用 click：勾选列表配 hover 会跟着鼠标走丢
            view.total && keys.length > 1
              ? (
                <Dropdown
                  overlayClassName='db-sql-cols-menu'
                  trigger='click'
                  menu={{
                    items: [
                      ...keys.map(k => ({
                        key: 'col::' + k,
                        label: (
                          <Checkbox checked={!hidden.includes(k)}>
                            <span className='db-sql-cols-item' title={k}>{k}</span>
                          </Checkbox>
                        )
                      })),
                      { type: 'divider' },
                      { key: 'all', label: e('dbShowAllCols'), disabled: !hidden.length }
                    ],
                    // 勾选态走 Checkbox 纯展示，切换统一在菜单 onClick 里做 ——
                    // 两处都接会互相抵消（点一下 = 勾上又勾掉）
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation()
                      if (key === 'all') {
                        setSqlViews(prev => patchSqlView(prev, i, { hidden: [] }))
                        return
                      }
                      if (key.startsWith('col::')) {
                        const k = key.slice(5)
                        onSqlToggleCol(i, keys, k, hidden.includes(k))
                      }
                    }
                  }}
                >
                  <Tooltip title={e('dbShowHideCols')}>
                    <Button size='small' icon={<EyeOutlined />} />
                  </Tooltip>
                </Dropdown>
                )
              : null
          }
          {
            // H1：右侧状态行。行数用命中口径 —— 筛完显示"筛出来的行数"，
            // 与网格所见一致（总数在过滤框旁的命中/总数里）；耗时是整次执行的
            // 总耗时，多结果集共享一份（各页签旁另标"总 {n} ms"）
            view.total
              ? (
                // trigger='click'：同一行里列显隐菜单是点击展开，相邻两个菜单
                // 一只 hover 一只点击手感打架；点击展开对键盘操作也更明确
                <Dropdown
                  trigger='click'
                  menu={{
                    items: [
                      { key: 'csv', label: 'CSV' },
                      { key: 'json', label: 'JSON' },
                      { key: 'tsv', label: 'TSV' },
                      { key: 'jsonl', label: 'JSONL' },
                      { key: 'markdown', label: 'Markdown' }
                    ],
                    // 导出始终是整份结果（不受当前页限制）；导出的是结果集
                    // 原始行（不过滤/不排序视图态 —— 要当前筛选请去数据页）
                    onClick: ({ key }) => {
                      if (key === 'json') {
                        return exportSqlJson(r, i)
                      }
                      if (key === 'tsv') {
                        return exportSqlTsv(r, i)
                      }
                      if (key === 'jsonl') {
                        return exportSqlJsonl(r, i)
                      }
                      if (key === 'markdown') {
                        return exportSqlMarkdown(r, i)
                      }
                      return exportSqlCsv(r, i)
                    }
                  }}
                >
                  <Tooltip title={e('dbExportCsv')}>
                    <Button
                      size='small'
                      icon={<DownloadOutlined />}
                    />
                  </Tooltip>
                </Dropdown>
                )
              : null
          }
          {
            // H1a-2：结果集列宽工具（与列头右键菜单同一动作，多个结果集共用一份手动宽，
            // 按的是"这次执行的所有列"）
            view.total
              ? colFitAllBtn(sqlWidths)
              : null
          }
          {
            view.total
              ? (
                <span className='db-sql-elapsed'>
                  {
                    sqlResult.elapsedMs === null
                      ? e('dbSqlRows').replace('{rows}', view.matched)
                      : e('dbSqlRowsElapsed')
                        .replace('{rows}', view.matched)
                        .replace('{ms}', sqlResult.elapsedMs)
                  }
                </span>
                )
              : null
          }
        </div>
        {
          r.affected !== undefined
            ? <div className='db-sql-affected'>{e('dbAffectedRows').replace('{n}', r.affected)}</div>
            : null
        }
        {
          // 撞行数上限 = 结果不完整，必须在这一屏说出来：过滤/排序/导出都只在这前 N 行里做
          r.affected === undefined && sqlRowLimitNote(r, e)
            ? <div className='db-sql-row-limit'>{sqlRowLimitNote(r, e)}</div>
            : null
        }
        <DbGridTable
          className='db-sql-result-grid is-bordered'
          size='small'
          columns={sqlResultColumns[i] || []}
          dataSource={view.pageRows}
          rowKey='__rowKey'
          pagination={false}
        />
      </div>
    )
  }

  // SQL 结果渲染：单结果集直接表格；多语句多结果集用 tab 分栏
  const results = (sqlResult && sqlResult.results) || []
  if (!results.length) {
    return null
  }
  if (results.length === 1) {
    return renderOne(results[0], 0)
  }
  return (
    <Tabs
      size='small'
      className='db-sql-results-tabs'
      items={results.map((r, i) => {
        // 页签在下面、正文在上面，切走后只剩标题可认；行数取该结果集原始口径
        // （过滤后的命中数随激活页签，写进标题会在切换时来回跳）
        const labelParts = [e('dbResultN').replace('{n}', i + 1)]
        const nRows = Array.isArray(r.rows) ? r.rows.length : 0
        if (nRows > 0) {
          labelParts.push(e('dbSqlRows').replace('{rows}', nRows))
        }
        // 多结果集共享一份总耗时，标在每个页签旁（各结果集不单独计时）
        if (sqlResult.elapsedMs !== null) {
          labelParts.push(e('dbSqlElapsedTotal').replace('{ms}', sqlResult.elapsedMs))
        }
        return {
          key: String(i),
          label: labelParts.join(' · '),
          children: renderOne(r, i)
        }
      })}
    />
  )
}
