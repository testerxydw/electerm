/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import React, { useEffect, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin } from 'antd'
import { ReloadOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import message from '../common/message'
import './db-session.styl'

const PAGE_SIZE = 100
// 树节点 key 用 JSON 数组编码，避免库/表名含 '.' 时拆解歧义
const nodeKey = (database, table) => JSON.stringify([database, table])

export default function DbSession (props) {
  const { tab } = props
  const tabId = tab.id
  const isRedis = tab.dbType === 'redis'
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [metadata, setMetadata] = useState([])
  const [treeLoading, setTreeLoading] = useState(false)
  // 当前选中表 {database, table}
  const [sel, setSel] = useState(null)
  // 数据网格状态
  const [grid, setGrid] = useState({
    loading: false,
    rows: [],
    page: 1,
    hasMore: false,
    orderBy: '',
    order: 'ascend'
  })

  // 解析 SSH 隧道书签（tab 建自书签时携带 sshTunnelBookmarkId）
  const getSshBookmark = () => {
    if (!tab.sshTunnelBookmarkId) {
      return null
    }
    return window.store.bookmarks.find(
      b => b.id === tab.sshTunnelBookmarkId
    ) || null
  }

  const loadTree = () => {
    setTreeLoading(true)
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {})
      .then(data => {
        setMetadata(data || [])
        setTreeLoading(false)
      })
      .catch(err => {
        setTreeLoading(false)
        message.error(err && err.message ? err.message : String(err))
      })
  }

  // 挂载建连 + 首次拉元数据；卸载断开连接
  useEffect(() => {
    let cancelled = false
    setReady(false)
    setError('')
    setMetadata([])
    setSel(null)
    setGrid({
      loading: false,
      rows: [],
      page: 1,
      hasMore: false,
      orderBy: '',
      order: 'ascend'
    })
    window.pre.runGlobalAsync('openDbTab', tab, getSshBookmark())
      .then(() => {
        if (cancelled) {
          return undefined
        }
        return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {})
      })
      .then(data => {
        if (!cancelled) {
          setMetadata(data || [])
          setReady(true)
        }
        return null
      })
      .catch(err => {
        if (!cancelled) {
          setError(err && err.message ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
      window.pre.runGlobalAsync('closeDbTab', tabId).catch(() => {})
    }
  }, [tabId])

  const onSelectTree = (keys, info) => {
    if (!info.node.isLeaf) {
      return
    }
    const [database, table] = JSON.parse(info.node.key)
    const next = { database, table }
    setSel(next)
    loadPage(next, 1, '', 'ascend')
  }

  const loadPage = (target, page, orderBy, order) => {
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      database: target.database,
      table: target.table,
      page,
      pageSize: PAGE_SIZE,
      orderBy,
      order
    }).then(res => {
      setGrid({
        loading: false,
        rows: (res && res.rows) || [],
        page,
        hasMore: !!(res && res.hasMore),
        orderBy,
        order
      })
    }).catch(err => {
      setGrid(g => ({ ...g, loading: false }))
      message.error(err && err.message ? err.message : String(err))
    })
  }

  const turnPage = (page) => {
    if (!sel) {
      return
    }
    loadPage(sel, page, grid.orderBy, grid.order)
  }

  // 列排序：antd sorter 回调 → 服务端 ORDER BY
  const onTableChange = (pagination, filters, sorter) => {
    if (!sel) {
      return
    }
    const orderBy = sorter && sorter.field ? sorter.field : ''
    const order = sorter && sorter.order ? sorter.order : 'ascend'
    loadPage(sel, grid.page, orderBy, order)
  }

  const renderCell = (v) => {
    if (v === null || v === undefined) {
      return <span className='db-cell-null'>NULL</span>
    }
    if (typeof v === 'object') {
      return JSON.stringify(v).slice(0, 200)
    }
    return String(v)
  }

  const columns = grid.rows.length
    ? Object.keys(grid.rows[0]).map(k => ({
      title: k,
      dataIndex: k,
      key: k,
      width: 220,
      ellipsis: true,
      sorter: true,
      render: renderCell
    }))
    : []

  const treeData = metadata.map(db => ({
    title: db.name,
    key: nodeKey(db.name, ''),
    selectable: false,
    children: (db.children || []).map(t => ({
      title: t.name,
      key: nodeKey(db.name, t.name),
      isLeaf: true
    }))
  }))

  if (error) {
    return (
      <div className='db-session-wrap'>
        <Alert type='error' showIcon message={error} />
      </div>
    )
  }

  if (!ready) {
    return (
      <div className='db-session-wrap'>
        <div className='db-session-loading'>
          <Spin />
          <span className='db-session-loading-text'>loading database...</span>
        </div>
      </div>
    )
  }

  const gridArea = isRedis
    ? <Empty description='redis keyspace browser (next step)' />
    : (
      <div className='db-grid-area'>
        <div className='db-grid-head'>
          <span className='db-grid-title'>
            {sel ? `${sel.database}.${sel.table}` : ''}
          </span>
          {
            sel
              ? (
                <div className='db-grid-pager'>
                  <Button
                    size='small'
                    icon={<LeftOutlined />}
                    disabled={grid.page <= 1 || grid.loading}
                    onClick={() => turnPage(grid.page - 1)}
                  />
                  <span className='db-grid-page-no'>page {grid.page}</span>
                  <Button
                    size='small'
                    icon={<RightOutlined />}
                    disabled={!grid.hasMore || grid.loading}
                    onClick={() => turnPage(grid.page + 1)}
                  />
                </div>
                )
              : null
          }
        </div>
        <Table
          size='small'
          loading={grid.loading}
          columns={columns}
          dataSource={grid.rows.map((r, i) => ({ ...r, __rowKey: i }))}
          rowKey='__rowKey'
          pagination={false}
          onChange={onTableChange}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
        />
      </div>
      )

  return (
    <div className='db-session-wrap'>
      <div className='db-tree-panel'>
        <div className='db-tree-head'>
          <span className='db-tree-title'>{tab.dbType}</span>
          <Button
            type='text'
            size='small'
            icon={<ReloadOutlined />}
            onClick={loadTree}
          />
        </div>
        <Spin spinning={treeLoading}>
          {
            treeData.length
              ? (
                <Tree
                  blockNode
                  treeData={treeData}
                  onSelect={onSelectTree}
                  defaultExpandAll={false}
                  className='db-tree'
                />
                )
              : <Empty description='no metadata' />
          }
        </Spin>
      </div>
      <div className='db-main-panel'>
        {gridArea}
      </div>
    </div>
  )
}
