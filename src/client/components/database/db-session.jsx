/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import React, { useEffect, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin, Tabs, Input, InputNumber, Tag, Popconfirm } from 'antd'
import { ReloadOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import message from '../common/message'
import clone from '../../common/to-simple-obj'
import dbT from '../bookmark-form/common/db-i18n.js'
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
  // 树展开状态（受控：点击库节点标题也可展开/收起）
  const [expandedKeys, setExpandedKeys] = useState([])
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

  // 表结构（describetable）
  const [structure, setStructure] = useState({ loading: false, rows: [] })
  // 连接层错误：用于顶部提示 + 重连按钮
  const [connError, setConnError] = useState('')

  // SQL 编辑器状态（MVP：textarea + Ctrl/Cmd+Enter 执行）
  const [sqlText, setSqlText] = useState('')
  const [sqlResult, setSqlResult] = useState({
    loading: false,
    // 多结果集：每项 { rows, fields, affected }（单条语句时只有 1 项）
    results: [],
    error: ''
  })

  // Redis 键空间状态（db 节点 → SCAN 键列表 → 类型化键详情）
  const [redisDb, setRedisDb] = useState(-1)
  // SCAN 用「游标」分页：cursor 为当前页游标，nextCursor 用于推进；
  // stack 记录已访问的游标，用于回退上一页（长度即当前页序号）。
  const [keyList, setKeyList] = useState({
    loading: false,
    rows: [],
    cursor: '0',
    nextCursor: '0',
    hasMore: false,
    match: '*',
    stack: []
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

  // 连接类错误识别（触发顶部断线提示，而非仅 toast）
  const CONN_ERR_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Server has gone away|Connection lost|connection is closed|Client has encountered|database tab not open/i
  const isConnError = (err) => CONN_ERR_RE.test(
    String(err && err.message ? err.message : err)
  )

  // 统一操作错误出口：连接类错误置顶提示（带重连按钮），其余仅 toast
  const onOpError = (err) => {
    const msg = err && err.message ? err.message : String(err)
    if (isConnError(err)) {
      setConnError(msg)
    }
    message.error(msg)
  }

  const loadTree = () => {
    setTreeLoading(true)
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {})
      .then(data => {
        setMetadata(data || [])
        setTreeLoading(false)
        setConnError('')
      })
      .catch(err => {
        setTreeLoading(false)
        onOpError(err)
      })
  }

  // 断线重连：先释放旧连接，再重新建连并刷新元数据（openDbTab 内部也会兜底关闭残留）
  const reconnect = () => {
    setConnError('')
    setReady(false)
    return window.pre.runGlobalAsync('closeDbTab', tabId)
      .catch(() => {})
      .then(() => window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark())))
      .then(() => window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {}))
      .then(data => {
        setMetadata(data || [])
        setReady(true)
      })
      .catch(err => {
        setReady(true)
        setConnError(err && err.message ? err.message : String(err))
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
    // tab/sshBookmark 来自 store（mobx proxy），IPC 结构化克隆前需转普通对象
    window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark()))
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
      loadRedisKeys(dbIndex, '0', matchInput)
      return
    }
    if (!node.isLeaf) {
      // mysql 库节点：点击标题切换展开/收起
      const k = String(node.key)
      setExpandedKeys(ks => (ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k]))
      return
    }
    const [database, table] = JSON.parse(node.key)
    const next = { database, table }
    setSel(next)
    loadPage(next, 1, '', 'ascend')
    loadStructure(next)
  }

  // 表结构（列定义）：MySQL 返回 Field/Type/Null/Key/Default/Extra，PG 返回 information_schema 列
  const loadStructure = (target) => {
    setStructure(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'describeTable', {
      database: target.database,
      table: target.table
    }).then(rows => {
      setStructure({ loading: false, rows: rows || [] })
    }).catch(err => {
      setStructure({ loading: false, rows: [] })
      onOpError(err)
    })
  }

  // 选中态：叶子=当前表，redis=当前 db 节点
  const selectedKeys = isRedis
    ? (redisDb >= 0 ? [String(redisDb)] : [])
    : (sel ? [nodeKey(sel.database, sel.table)] : [])

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
      onOpError(err)
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
          results: (res && res.results) || [],
          error: ''
        })
      })
      .catch(err => {
        setSqlResult({
          loading: false,
          results: [],
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

  const loadRedisKeys = (dbIndex, cursor, match, stack = []) => {
    setKeyList(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      dbIndex,
      cursor: String(cursor || '0'),
      pageSize: PAGE_SIZE,
      match: match || '*'
    }).then(res => {
      setKeyList({
        loading: false,
        rows: (res && res.rows) || [],
        cursor: String(cursor || '0'),
        nextCursor: (res && res.nextCursor) || '0',
        hasMore: !!(res && res.hasMore),
        match: match || '*',
        stack
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
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
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
      loadRedisKeys(redisDb, '0', keyList.match)
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
  const columnsForResult = (r) => {
    const rows = (r && r.rows) || []
    const fields = (r && r.fields) || []
    const keys = fields.length ? fields : (rows.length ? Object.keys(rows[0]) : [])
    return keys.map(k => ({
      title: k,
      dataIndex: k,
      key: k,
      width: 220,
      ellipsis: true,
      render: renderCell
    }))
  }

  // SQL 结果渲染：单结果集直接表格；多语句多结果集用 tab 分栏
  const renderSqlResults = () => {
    const results = sqlResult.results || []
    if (!results.length) {
      return null
    }
    const renderOne = (r, i) => (
      <div key={i} className='db-sql-result-one'>
        {
          r.affected !== undefined
            ? <div className='db-sql-affected'>affected rows: {r.affected}</div>
            : null
        }
        <Table
          size='small'
          columns={columnsForResult(r)}
          dataSource={((r && r.rows) || []).map((x, j) => ({ ...x, __rowKey: j }))}
          rowKey='__rowKey'
          pagination={false}
          scroll={{ x: 'max-content' }}
          className='db-grid-table'
        />
      </div>
    )
    if (results.length === 1) {
      return renderOne(results[0], 0)
    }
    return (
      <Tabs
        size='small'
        className='db-sql-results-tabs'
        items={results.map((r, i) => ({
          key: String(i),
          label: `result ${i + 1}`,
          children: renderOne(r, i)
        }))}
      />
    )
  }

  const treeData = isRedis
    ? metadata.map((db, i) => ({
      title: db.name,
      key: String(i),
      isLeaf: false
    }))
    : metadata.map(db => ({
      title: db.name,
      key: nodeKey(db.name, ''),
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
        <Spin spinning={sqlResult.loading}>
          {renderSqlResults()}
        </Spin>
      </div>
    </div>
  )

  // 表结构：列定义网格（列名随驱动而异 —— MySQL 为 Field/Type/Null/…，PG 为 column_name/data_type/…
  // 故直接按首行键动态生成列，避免写死）
  const structColumns = structure.rows.length
    ? Object.keys(structure.rows[0]).map(k => ({
      title: k,
      dataIndex: k,
      key: k,
      width: 200,
      ellipsis: true,
      render: renderCell
    }))
    : []
  const structureArea = (
    <div className='db-struct-area'>
      <Table
        size='small'
        loading={structure.loading}
        columns={structColumns}
        dataSource={structure.rows.map((r, i) => ({ ...r, __rowKey: i }))}
        rowKey='__rowKey'
        pagination={false}
        scroll={{ x: 'max-content' }}
        className='db-grid-table'
      />
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
                  onPressEnter={() => loadRedisKeys(redisDb, '0', matchInput)}
                  className='db-redis-match'
                  allowClear
                />
                <Button
                  size='small'
                  onClick={() => loadRedisKeys(redisDb, '0', matchInput)}
                >
                  filter
                </Button>
                <div className='db-grid-pager'>
                  <Button
                    size='small'
                    icon={<LeftOutlined />}
                    disabled={keyList.stack.length === 0 || keyList.loading}
                    onClick={() => {
                      const stack = keyList.stack
                      loadRedisKeys(
                        redisDb,
                        stack[stack.length - 1],
                        keyList.match,
                        stack.slice(0, -1)
                      )
                    }}
                  />
                  <span className='db-grid-page-no'>page {keyList.stack.length + 1}</span>
                  <Button
                    size='small'
                    icon={<RightOutlined />}
                    disabled={!keyList.hasMore || keyList.loading}
                    onClick={() => loadRedisKeys(
                      redisDb,
                      keyList.nextCursor,
                      keyList.match,
                      [...keyList.stack, keyList.cursor]
                    )}
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
          { key: 'sql', label: 'SQL', forceRender: true, children: sqlArea },
          {
            key: 'structure',
            label: dbT('tableStructure'),
            forceRender: true,
            children: structureArea
          }
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
                  expandedKeys={expandedKeys}
                  onExpand={keys => setExpandedKeys(keys.map(String))}
                  selectedKeys={selectedKeys}
                  onSelect={onSelectTree}
                  className='db-tree'
                />
                )
              : <Empty description='no metadata' />
          }
        </Spin>
      </div>
      <div className='db-main-panel'>
        {
          connError
            ? (
              <Alert
                className='db-conn-error'
                type='error'
                showIcon
                message={`${dbT('connectionLost')}: ${connError}`}
                action={
                  <Button size='small' onClick={reconnect}>
                    {dbT('reconnect')}
                  </Button>
                }
              />
              )
            : null
        }
        {mainArea}
      </div>
    </div>
  )
}
