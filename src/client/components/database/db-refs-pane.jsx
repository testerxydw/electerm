/**
 * F1 外键引用侧栏（设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §8）
 *
 * 只读列表：两个方向分开命名（父行 / 子记录），每条引用单页 50 行预览 +
 * 「在标签页打开」跳主网格（openRefTable 由 db-session 注入）。
 * 数据获取发生在组件内（点击"查看"才拉一页），列表项由 db-ref-utils 纯函数计算。
 */
import React, { useMemo, useState } from 'react'
import { Button } from 'antd'
import { buildRefWhere } from './db-ref-utils'
import { isBinEnvelope } from './value-renderers'

const e = window.translate

// 设计边界：侧栏单页 50 行，完整列表走「在标签页打开」
const REF_PAGE_SIZE = 50

function cellText (v) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    return '<binary ' + v.__bin.size + ' bytes>'
  }
  if (typeof v === 'object') {
    return JSON.stringify(v)
  }
  return String(v)
}

function tableName (target) {
  if (!target) {
    return ''
  }
  return target.schema ? target.schema + '.' + target.table : String(target.table || '')
}

function RefItem ({ item, dialect, tabId, onOpen }) {
  const [state, setState] = useState({ loading: false, shown: false, rows: null, hasMore: false, error: '' })
  const where = useMemo(() => buildRefWhere(item, dialect), [item, dialect])
  const canQuery = !!where && !item.unusable
  const toggle = () => {
    if (!canQuery || state.loading) {
      return
    }
    if (state.shown) {
      setState({ loading: false, shown: false, rows: null, hasMore: false, error: '' })
      return
    }
    setState(s => ({ ...s, loading: true, shown: true, error: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      database: item.target.database,
      schema: item.target.schema || '',
      table: item.target.table,
      page: 1,
      pageSize: REF_PAGE_SIZE,
      where: where.where,
      whereParams: where.whereParams
    }).then(res => {
      setState({
        loading: false,
        shown: true,
        rows: (res && res.rows) || [],
        hasMore: !!(res && res.hasMore),
        error: ''
      })
    }).catch(err => {
      setState({
        loading: false,
        shown: true,
        rows: [],
        hasMore: false,
        error: (err && err.message) ? err.message : String(err)
      })
    })
  }
  const cols = state.rows && state.rows.length
    ? Object.keys(state.rows[0]).slice(0, 8)
    : []
  // 预览主体用普通 if/else 写（嵌套三元过缩进规则很拧巴）
  const renderBody = () => {
    if (!state.shown || state.loading) {
      return null
    }
    if (state.error) {
      return <div className='db-refs-error'>{e('dbRefFailed')}: {state.error}</div>
    }
    if (!state.rows.length) {
      return <div className='db-refs-empty'>{e('tableEmpty')}</div>
    }
    return (
      <div className='db-refs-table-wrap'>
        <table className='db-refs-table'>
          <thead>
            <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {
              state.rows.map((r, i) => (
                <tr key={i}>
                  {cols.map(c => <td key={c}>{cellText(r[c])}</td>)}
                </tr>
              ))
            }
          </tbody>
        </table>
        {
          state.hasMore
            ? <div className='db-refs-note'>{e('dbRefMore')}</div>
            : null
        }
      </div>
    )
  }
  return (
    <div className='db-refs-item'>
      <div className='db-refs-item-head'>
        <span className='db-refs-item-name'>{tableName(item.target)}</span>
        <span className='db-refs-item-fk' title={item.fkName}>{item.fkName}</span>
        <span className='db-refs-item-mapping' title={item.mapping}>{item.mapping}</span>
        <span className='db-refs-item-actions'>
          <Button
            size='small'
            loading={state.loading}
            disabled={!canQuery && !state.shown}
            onClick={toggle}
          >
            {state.shown ? e('close') : e('dbRefView')}
          </Button>
          <Button
            size='small'
            disabled={!!item.unusable}
            title={item.unusable ? e(item.unusable) : e('dbRefOpen')}
            onClick={() => onOpen(item)}
          >
            {e('dbRefOpen')}
          </Button>
        </span>
      </div>
      {
        item.unusable
          ? <div className='db-refs-note'>{e(item.unusable)}</div>
          : null
      }
      {renderBody()}
    </div>
  )
}

export default function DbRefsPane ({ items, dialect, tabId, degraded, loading, onOpen }) {
  const list = Array.isArray(items) ? items : []
  const parentItems = list.filter(i => i.dir === 'parent')
  const childItems = list.filter(i => i.dir === 'child')
  const renderGroup = (label, groupItems, extraNote, keyPrefix) => (
    <div className='db-refs-group'>
      <div className='db-refs-group-title'>{label}</div>
      {extraNote}
      {
        groupItems.length
          ? groupItems.map((item, i) => (
            <RefItem
              key={keyPrefix + ':' + item.key + ':' + i}
              item={item}
              dialect={dialect}
              tabId={tabId}
              onOpen={onOpen}
            />
          ))
          : <div className='db-refs-empty'>{e('dbRefNoFk')}</div>
      }
    </div>
  )
  return (
    <div className='db-refs-pane'>
      {renderGroup(e('dbRefParent'), parentItems, null, 'p')}
      {
        renderGroup(
          e('dbRefChild'),
          childItems,
          loading
            ? <div className='db-refs-note'>{e('loading')}</div>
            : (degraded ? <div className='db-refs-degraded'>{e('dbRefDegraded')}</div> : null),
          'c'
        )
      }
    </div>
  )
}
