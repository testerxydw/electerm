/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import React, { useEffect, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin, Tabs, Input, InputNumber, Tag, Popconfirm } from 'antd'
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

  // SQL 编辑器状态（MVP：textarea + Ctrl/Cmd+Enter 执行）
  const [sqlText, setSqlText] = useState('')
  const [sqlResult, setSqlResult] = useState({
    loading: false,
    rows: [],
    fields: [],
    affected: undefined,
    error: ''
  })

  // Redis 键空间状态（db 节点 → SCAN 键列表 → 类型化键详情）
  const [redisDb, setRedisDb] = useState(-1)
  const [keyList, setKeyList] = useState({
    loading: false,
    rows: [],
    page: 1,
    hasMore: false,
    match: '*'
  })
  const [matchInput, setMatchInput] = useState('')
  const [redisKey, setRedisKey] = useState('')
  const [redisDetail, setRedisDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ttlInput, setTtlInput] = useState(undefined)

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
    const node = info.node
    if (isRedis) {
      // redis 树：key = db index 字符串
      const dbIndex = parseInt(node.key, 10)
      setRedisDb(dbIndex)
      setRedisKey('')
      setRedisDetail(null)
      loadRedisKeys(dbIndex, 1, matchInput)
      return
    }
    if (!node.isLeaf) {
      return
    }
    const [database, table] = JSON.parse(node.key)
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

  // 只读模式（默认开，书签 readOnly !== false）
  const isReadonly = tab.readOnly !== false

  const runSql = () => {
    const sql = sqlText.trim()
    if (!sql) {
      return
    }
    setSqlResult(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', { sql })
      .then(res => {
        setSqlResult({
          loading: false,
          rows: (res && res.rows) || [],
          fields: (res && res.fields) || [],
          affected: res ? res.affected : undefined,
          error: ''
        })
      })
      .catch(err => {
        setSqlResult({
          loading: false,
          rows: [],
          fields: [],
          affected: undefined,
          error: err && err.message ? err.message : String(err)
        })
      })
  }

  // Ctrl/Cmd+Enter 执行
  const onSqlKeyDown = (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      runSql()
    }
  }

  // ---- Redis 键空间 ----

  const loadRedisKeys = (dbIndex, page, match) => {
    setKeyList(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      dbIndex,
      page,
      pageSize: PAGE_SIZE,
      match: match || '*'
    }).then(res => {
      setKeyList({
        loading: false,
        rows: (res && res.rows) || [],
        page,
        hasMore: !!(res && res.hasMore),
        match: match || '*'
      })
    }).catch(err => {
      setKeyList(s => ({ ...s, loading: false }))
      message.error(err && err.message ? err.message : String(err))
    })
  }

  const selectRedisKey = (key) => {
    setRedisKey(key)
    setDetailLoading(true)
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getKeyDetail', {
      dbIndex: redisDb,
      key
    }).then(res => {
      setRedisDetail(res || null)
      setTtlInput(res && res.ttl > 0 ? res.ttl : undefined)
      setDetailLoading(false)
    }).catch(err => {
      setRedisDetail(null)
      setDetailLoading(false)
      message.error(err && err.message ? err.message : String(err))
    })
  }

  const applyTtl = () => {
    if (!redisKey) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'expireKey', {
      dbIndex: redisDb,
      key: redisKey,
      seconds: Number(ttlInput) || 0
    }).then(() => {
      message.success('ttl updated')
      loadRedisKeys(redisDb, keyList.page, keyList.match)
      selectRedisKey(redisKey)
    }).catch(err => {
      message.error(err && err.message ? err.message : String(err))
    })
  }

  const delSelectedKey = () => {
    if (!redisKey) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'delKey', {
      dbIndex: redisDb,
      key: redisKey
    }).then(() => {
      message.success('key deleted')
      setRedisKey('')
      setRedisDetail(null)
      loadRedisKeys(redisDb, 1, keyList.match)
    }).catch(err => {
      message.error(err && err.message ? err.message : String(err))
    })
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

  // SQL 结果网格列：优先 fields（列顺序稳定），否则从首行推断
  const sqlColumns = sqlResult.fields.length
    ? sqlResult.fields.map(f => ({
      title: f,
      dataIndex: f,
      key: f,
      width: 220,
      ellipsis: true,
      render: renderCell
    }))
    : (sqlResult.rows.length
        ? Object.keys(sqlResult.rows[0]).map(k => ({
          title: k,
          dataIndex: k,
          key: k,
          width: 220,
          ellipsis: true,
          render: renderCell
        }))
        : [])

  const treeData = isRedis
    ? metadata.map((db, i) => ({
      title: db.name,
      key: String(i),
      isLeaf: false
    }))
    : metadata.map(db => ({
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

  const dataArea = (
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

  const sqlArea = (
    <div className='db-sql-area'>
      <Input.TextArea
        value={sqlText}
        onChange={ev => setSqlText(ev.target.value)}
        onKeyDown={onSqlKeyDown}
        placeholder='SELECT * FROM db.table LIMIT 10   (Ctrl/Cmd+Enter to run)'
        autoSize={{ minRows: 4, maxRows: 12 }}
        className='db-sql-editor'
      />
      <div className='db-sql-bar'>
        <Button
          type='primary'
          size='small'
          loading={sqlResult.loading}
          onClick={runSql}
        >
          run
        </Button>
        {
          isReadonly
            ? <Tag>read-only</Tag>
            : null
        }
      </div>
      <div className='db-sql-result'>
        {
          sqlResult.error
            ? <Alert type='error' showIcon message={sqlResult.error} />
            : null
        }
        {
          sqlResult.affected !== undefined
            ? <div className='db-sql-affected'>affected rows: {sqlResult.affected}</div>
            : null
        }
        <Table
          size='small'
          loading={sqlResult.loading}
          columns={sqlColumns}
          dataSource={sqlResult.rows.map((r, i) => ({ ...r, __rowKey: i }))}
          rowKey='__rowKey'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
        />
      </div>
    </div>
  )

  const redisKeyColumns = [
    { title: 'key', dataIndex: 'name', key: 'name', ellipsis: true, render: renderCell },
    { title: 'type', dataIndex: 'type', key: 'type', width: 90, render: renderCell },
    { title: 'ttl', dataIndex: 'ttl', key: 'ttl', width: 90, render: renderCell }
  ]

  // 键详情：按类型渲染（string 文本框；hash/list/set/zset 网格）
  const renderRedisDetail = () => {
    const d = redisDetail
    let body = null
    if (!d) {
      body = detailLoading ? <Spin size='small' /> : null
    } else if (d.type === 'string') {
      body = (
        <Input.TextArea
          value={String(d.value ?? '')}
          readOnly
          autoSize={{ minRows: 3, maxRows: 10 }}
          className='db-sql-editor'
        />
      )
    } else if (d.type === 'hash') {
      body = (
        <Table
          size='small'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
          columns={[
            { title: 'field', dataIndex: 'field', key: 'field', ellipsis: true, render: renderCell },
            { title: 'value', dataIndex: 'value', key: 'value', ellipsis: true, render: renderCell }
          ]}
          dataSource={(d.fields || []).map((f, i) => ({ field: f, value: d.rows[f], __rowKey: i }))}
          rowKey='__rowKey'
        />
      )
    } else if (d.type === 'list') {
      body = (
        <Table
          size='small'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
          columns={[
            { title: '#', dataIndex: 'index', key: 'index', width: 80, render: renderCell },
            { title: 'value', dataIndex: 'value', key: 'value', ellipsis: true, render: renderCell }
          ]}
          dataSource={(d.rows || []).map((v, i) => ({ index: i, value: v, __rowKey: i }))}
          rowKey='__rowKey'
        />
      )
    } else if (d.type === 'set') {
      body = (
        <Table
          size='small'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
          columns={[
            { title: 'member', dataIndex: 'member', key: 'member', ellipsis: true, render: renderCell }
          ]}
          dataSource={(d.rows || []).map((v, i) => ({ member: v, __rowKey: i }))}
          rowKey='__rowKey'
        />
      )
    } else if (d.type === 'zset') {
      const list = []
      const rows = d.rows || []
      // zrange WITHSCORES 返回 [member, score, ...] 扁平数组
      for (let i = 0; i < rows.length; i += 2) {
        list.push({ member: rows[i], score: rows[i + 1], __rowKey: i })
      }
      body = (
        <Table
          size='small'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
          columns={[
            { title: 'member', dataIndex: 'member', key: 'member', ellipsis: true, render: renderCell },
            { title: 'score', dataIndex: 'score', key: 'score', width: 120, render: renderCell }
          ]}
          dataSource={list}
          rowKey='__rowKey'
        />
      )
    } else {
      body = <span className='db-cell-null'>unsupported type: {d.type}</span>
    }
    return (
      <div className='db-redis-detail'>
        <div className='db-redis-detail-bar'>
          <span className='db-grid-title db-redis-key-name'>{redisKey}</span>
          <span className='db-grid-page-no'>type: {d ? d.type : '...'}</span>
          <span className='db-grid-page-no'>ttl: {d && d.ttl > 0 ? d.ttl + 's' : 'none'}</span>
          <InputNumber
            size='small'
            min={0}
            placeholder='seconds'
            value={ttlInput}
            onChange={setTtlInput}
          />
          <Button size='small' disabled={isReadonly} onClick={applyTtl}>set ttl</Button>
          <Popconfirm title='delete this key?' onConfirm={delSelectedKey}>
            <Button size='small' danger disabled={isReadonly}>delete</Button>
          </Popconfirm>
        </div>
        {body}
      </div>
    )
  }

  const redisArea = (
    <div className='db-redis-area'>
      {
        redisDb < 0
          ? <Empty description='select a db node' />
          : (
            <>
              <div className='db-redis-bar'>
                <Input
                  size='small'
                  placeholder='match pattern, e.g. user:*'
                  value={matchInput}
                  onChange={ev => setMatchInput(ev.target.value)}
                  onPressEnter={() => loadRedisKeys(redisDb, 1, matchInput)}
                  className='db-redis-match'
                  allowClear
                />
                <Button
                  size='small'
                  onClick={() => loadRedisKeys(redisDb, 1, matchInput)}
                >
                  filter
                </Button>
                <div className='db-grid-pager'>
                  <Button
                    size='small'
                    icon={<LeftOutlined />}
                    disabled={keyList.page <= 1 || keyList.loading}
                    onClick={() => loadRedisKeys(redisDb, keyList.page - 1, keyList.match)}
                  />
                  <span className='db-grid-page-no'>page {keyList.page}</span>
                  <Button
                    size='small'
                    icon={<RightOutlined />}
                    disabled={!keyList.hasMore || keyList.loading}
                    onClick={() => loadRedisKeys(redisDb, keyList.page + 1, keyList.match)}
                  />
                </div>
              </div>
              <Table
                size='small'
                loading={keyList.loading}
                columns={redisKeyColumns}
                dataSource={keyList.rows.map((r, i) => ({ ...r, __rowKey: i }))}
                rowKey='__rowKey'
                pagination={false}
                onRow={r => ({ onClick: () => selectRedisKey(r.name) })}
                rowClassName={r => (r.name === redisKey ? 'db-row-selected' : '')}
                scroll={{ x: 'max-content' }}
                className='db-grid-table db-redis-keys'
              />
              {
                redisKey ? renderRedisDetail() : null
              }
            </>
            )
      }
    </div>
  )

  const mainArea = isRedis
    ? redisArea
    : (
      <Tabs
        className='db-tabs'
        items={[
          { key: 'data', label: 'data', forceRender: true, children: dataArea },
          { key: 'sql', label: 'SQL', forceRender: true, children: sqlArea }
        ]}
      />
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
        {mainArea}
      </div>
    </div>
  )
}
