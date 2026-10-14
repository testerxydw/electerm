/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin, Tabs, Input, InputNumber, Tag, Popconfirm, Switch, Tooltip } from 'antd'
import { ReloadOutlined, LeftOutlined, RightOutlined, SwapOutlined, FullscreenOutlined } from '@ant-design/icons'
import { auto } from 'manate/react'
import message from '../common/message'
import DbConnError from './db-conn-error'
import RemoteFloatControl from '../common/remote-float-control'
import { highlightValue, useKeywordPatterns } from './db-highlight'
import { detectFormats, formatValue } from './db-value-format'
import clone from '../../common/to-simple-obj'
import { dbTypeLabelMap } from '../../common/constants'
import './db-session.styl'

const e = window.translate
const PAGE_SIZE = 100
// 元数据树宽度约束与持久化键
const TREE_WIDTH_KEY = 'electerm-db-tree-width'
const TREE_MIN_W = 160
const TREE_MAX_W = 600
// 树节点 key 用 JSON 数组编码，避免库/表名含 '.' 时拆解歧义
const nodeKey = (database, table) => JSON.stringify([database, table])
// 单元格编辑生成的 UPDATE（MySQL 系）：标识符反引号转义，值按类型决定是否加引号
const quoteIdent = (s) => '`' + String(s).replace(/`/g, '``') + '`'
const quoteVal = (v) => {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v)
  }
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

export default auto(function DbSession (props) {
  const { tab } = props
  const tabId = tab.id
  // 全屏状态直接读 store：auto 会订阅它，切换全屏时本页跟着重渲染
  // （props 里的 fullscreen 不订阅 store，切全屏时页面不会重渲染）
  const fullscreen = window.store.fullscreen
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
    totalRows: undefined,
    error: '',
    orderBy: '',
    order: 'ascend'
  })

  // 元数据树宽度（可拖拽；持久化到 localStorage，避免污染用户配置）
  const [treeWidth, setTreeWidth] = useState(() => {
    const v = Number(window.localStorage.getItem(TREE_WIDTH_KEY))
    return v >= TREE_MIN_W && v <= TREE_MAX_W ? v : 240
  })

  // 表结构（describetable）
  const [structure, setStructure] = useState({ loading: false, rows: [] })
  // 单元格编辑态：{ rowKey, col } + 输入框值（回车提交 / 失焦取消）
  const [editing, setEditing] = useState(null)
  const [editValue, setEditValue] = useState('')
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
  // 值预览格式：raw / json / python / xml / url（见 db-value-format.js）
  const [valueFormat, setValueFormat] = useState('raw')

  // 关键字高亮规则：与终端「关键字高亮」同一份配置（config.keywords）
  const keywordPatterns = useKeywordPatterns()
  // 高亮配色跟随终端主题（与终端里同一色名同一颜色）
  const themeConfig = window.store.getThemeConfig()

  // string 值可用的格式化格式（JSON / Python 字面量 / XML / URL），每次值变化重算；
  // 注意：必须放在下面那些提前 return 之前 —— hooks 数量不能在渲染间变化
  const stringValue = redisDetail && redisDetail.type === 'string'
    ? String(redisDetail.value ?? '')
    : ''
  const valueFormats = useMemo(
    () => (stringValue ? detectFormats(stringValue) : []),
    [stringValue]
  )
  // 只有一个切换按钮：原文 ⇄ 格式化（格式化自动取嗅探到的第一个格式，不再让用户选）
  const autoFormat = valueFormats[0]
  const activeFormat = valueFormat !== 'raw' && valueFormats.some(f => f.key === valueFormat)
    ? valueFormat
    : 'raw'
  const formatLabel = activeFormat === 'raw'
    ? e('rawText')
    : (valueFormats.find(f => f.key === activeFormat) || {}).label || activeFormat
  const toggleFormat = () => {
    setValueFormat(activeFormat === 'raw' ? (autoFormat ? autoFormat.key : 'raw') : 'raw')
  }

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
  // ioredis 掉线时抛的是 "Stream isn't writeable and enableOfflineQueue options is false" /
  // "Connection is closed."，而不是 errno，必须一并识别，否则掉线只会弹个 toast
  const CONN_ERR_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Server has gone away|Connection lost|connection is closed|Stream isn't writeable|enableOfflineQueue|socket hang up|Client has encountered|database tab not open/i
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

  // 重新建连：先释放旧连接（openDbTab 内部也会兜底关闭残留），再拉元数据
  const doConnect = () => window.pre.runGlobalAsync('closeDbTab', tabId)
    .catch(() => {})
    .then(() => window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark())))
    .then(() => window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {}))
    .then(data => {
      setMetadata(data || [])
      setConnError('')
      setReady(true)
      return null
    })

  // 掉线后重连：失败仍留在界面上（顶部横幅提示），便于继续排查
  const reconnect = () => doConnect()
    .catch(err => {
      setReady(true)
      setConnError(err && err.message ? err.message : String(err))
    })

  // 初次建连失败后的重试：失败则继续停留在失败卡片上（而非进入空界面）
  const retryConnect = () => doConnect()
    .catch(err => {
      setError(err && err.message ? err.message : String(err))
    })

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
      setValueFormat('raw')
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
    setGrid(g => ({ ...g, loading: true, error: '' }))
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
        totalRows: res ? res.totalRows : undefined,
        error: '',
        orderBy,
        order
      })
    }).catch(err => {
      // 失败必须落到表格区（而非仅 toast）：否则界面看起来像「表没有数据」
      setGrid(g => ({
        ...g,
        loading: false,
        rows: [],
        error: err && err.message ? err.message : String(err)
      }))
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

  // 只读模式（默认开，书签 readOnly !== false）。
  // 用本地 state 而非直接读 tab：本组件是普通函数组件，父级不读 readOnly，
  // tab 变更后不会重渲染，开关会停留在旧状态。
  const [isReadonly, setIsReadonly] = useState(tab.readOnly !== false)

  // 页面内切换只读：先同步主进程（白名单以主进程实例为权威），成功再改本地与 tab，
  // 否则主进程失败时界面会显示成"可写"但实际仍被拦
  const toggleReadonly = async (checked) => {
    try {
      await window.pre.runGlobalAsync('setDbReadOnly', tabId, checked)
      setIsReadonly(checked)
      window.store.updateTab(tabId, { readOnly: checked })
    } catch (err) {
      onOpError(err)
    }
  }

  // 行定位列：MySQL 的 DESC 结果含 Key='PRI'。取不到主键就不开单元格编辑，
  // 否则 UPDATE 的 WHERE 无法唯一定位行，可能一次改掉多行。
  const pkColumn = (structure.rows || [])
    .filter(r => r.Key === 'PRI')
    .map(r => r.Field)[0] || ''
  const canEditCell = !isReadonly && !isRedis && !!pkColumn

  const startEdit = (row, col) => {
    if (!canEditCell) {
      message.error(e('dbNoPrimaryKey'))
      return
    }
    setEditing({ rowKey: row.__rowKey, col })
    setEditValue(row[col] === null || row[col] === undefined ? '' : String(row[col]))
  }

  const cancelEdit = () => {
    setEditing(null)
  }

  const submitEdit = () => {
    const target = editing
    setEditing(null)
    if (!target || !sel) {
      return
    }
    const row = grid.rows[target.rowKey]
    const sql = `UPDATE ${quoteIdent(sel.database)}.${quoteIdent(sel.table)}` +
      ` SET ${quoteIdent(target.col)} = ${quoteVal(editValue)}` +
      ` WHERE ${quoteIdent(pkColumn)} = ${quoteVal(row[pkColumn])}`
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', { sql })
      .then(() => loadPage(sel, grid.page, grid.orderBy, grid.order))
      .catch(err => {
        setGrid(g => ({ ...g, loading: false }))
        onOpError(err)
      })
  }

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
      setKeyList(s => ({ ...s, loading: false, rows: [] }))
      // 与 loadPage 一致：断线要置顶提示（带重连），而不是只弹个 toast
      onOpError(err)
    })
  }

  const selectRedisKey = (key) => {
    setRedisKey(key)
    // 换键后回到原文，格式重新按新值嗅探
    setValueFormat('raw')
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
      // 键数变了 → 同步刷新左侧各 db 的键个数
      loadTree()
    }).catch(err => {
      message.error(err && err.message ? err.message : String(err))
    })
  }

  const renderCell = (v) => {
    if (v === null || v === undefined) {
      return <span className='db-cell-null'>NULL</span>
    }
    if (typeof v === 'object') {
      return highlightValue(JSON.stringify(v).slice(0, 200), keywordPatterns, themeConfig)
    }
    // 数字/布尔也一并走高亮：关键字规则常写成 `\b(0|1)\b` 这类
    return highlightValue(String(v), keywordPatterns, themeConfig)
  }

  const columns = grid.rows.length
    ? Object.keys(grid.rows[0]).map(k => ({
      title: k,
      dataIndex: k,
      key: k,
      width: 220,
      ellipsis: true,
      sorter: true,
      // 双击命中区放在整个单元格（td）上：值短时后面的空白也能双击进编辑态，
      // 之前挂在文字 span 上，只有精确双击到字符才生效
      onCell: canEditCell
        ? row => ({
          onDoubleClick: () => startEdit(row, k),
          className: 'db-cell-editable',
          title: 'double click to edit'
        })
        : undefined,
      render: (v, row) => {
        if (editing && editing.rowKey === row.__rowKey && editing.col === k) {
          return (
            <Input
              size='small'
              autoFocus
              className='db-cell-editor'
              value={editValue}
              onChange={ev => setEditValue(ev.target.value)}
              onPressEnter={submitEdit}
              onBlur={cancelEdit}
            />
          )
        }
        return renderCell(v)
      }
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
      // 键个数（来自 INFO keyspace）；空 db 显示 0，
      // 受管实例禁用 INFO 时后端不回 count → 此处不显示数字
      title: (
        <span className='db-tree-db'>
          <span className='db-tree-db-name'>{db.name}</span>
          {
            typeof db.count === 'number'
              ? <span className='db-tree-db-count'>{db.count}</span>
              : null
          }
        </span>
      ),
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

  // 拖拽调整左侧元数据树宽度（松手时持久化）
  const startResize = (ev) => {
    ev.preventDefault()
    const startX = ev.clientX
    const startW = treeWidth
    let last = startW
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    const onMove = (e) => {
      last = Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, startW + (e.clientX - startX)))
      setTreeWidth(last)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = prevSelect
      window.localStorage.setItem(TREE_WIDTH_KEY, String(last))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  if (error) {
    return (
      <div className='db-session-wrap db-session-error'>
        <DbConnError
          tab={tab}
          error={error}
          onRetry={retryConnect}
        />
        <RemoteFloatControl isFullScreen={!!fullscreen} />
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
        <RemoteFloatControl isFullScreen={!!fullscreen} />
      </div>
    )
  }

  const dataArea = (
    <div className='db-grid-area'>
      <div className='db-grid-head'>
        <span
          className='db-grid-title'
          title={sel ? `${sel.database}.${sel.table}` : ''}
        >
          {sel ? `${sel.database}.${sel.table}` : ''}
        </span>
        {
          sel && typeof grid.totalRows === 'number'
            ? (
              <span className='db-grid-total'>
                {e('approxRows')}: {grid.totalRows}
              </span>
              )
            : null
        }
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
        {
          // 刷新当前表：保持页码/排序，只重新取数
          sel
            ? (
              <Button
                size='small'
                icon={<ReloadOutlined />}
                loading={grid.loading}
                title={e('refresh')}
                onClick={() => loadPage(sel, grid.page, grid.orderBy, grid.order)}
              />
              )
            : null
        }
      </div>
      {
        grid.error
          ? (
            <Alert
              className='db-grid-error'
              type='error'
              showIcon
              message={e('queryFailed')}
              description={grid.error}
            />
            )
          : null
      }
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
        locale={{
          emptyText: grid.error
            ? e('queryFailed')
            : (
              <span className='db-empty-tip'>
                {e('tableEmpty')}
                {
                  typeof grid.totalRows === 'number'
                    ? ` (${e('approxRows')}: ${grid.totalRows})`
                    : ''
                }
              </span>
              )
        }}
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
      // 原文 / 格式化都走高亮渲染（<pre> 保留换行与缩进，可选中复制）
      const shown = activeFormat === 'raw'
        ? stringValue
        : formatValue(stringValue, activeFormat)
      body = (
        <pre className='db-value-pre'>
          {highlightValue(shown, keywordPatterns, themeConfig)}
        </pre>
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
          {
            // 值可格式化时（JSON / Python 字面量 / XML / URL）给一个切换按钮
            valueFormats.length
              ? (
                <Button
                  size='small'
                  icon={<SwapOutlined />}
                  title={e('kwToggleFormat')}
                  onClick={toggleFormat}
                >
                  {formatLabel}
                </Button>
                )
              : null
          }
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
                {/* 刷新放在翻页之后，与 MySQL 网格头一致 */}
                <Button
                  size='small'
                  icon={<ReloadOutlined />}
                  loading={keyList.loading}
                  title={e('refresh')}
                  onClick={() => loadRedisKeys(redisDb, keyList.cursor || '0', keyList.match, keyList.stack)}
                />
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
            label: e('tableStructure'),
            forceRender: true,
            children: structureArea
          }
        ]}
      />
      )

  // 顶部工具条：数据库页专有（终端那条 SessionControl 对数据库 tab 已关闭）。
  // 高度与 .terminal-control 一致(32px)，故高度口径不需要另加扣减。
  // 目标文本不带引擎名（引擎已由左侧徽标表达），避免"Redis Redis ·…"重复
  const target = [
    tab.dbHost ? `${tab.dbHost}:${tab.dbPort || ''}` : tab.title,
    tab.dbName,
    tab.dbUser
  ].filter(Boolean).join(' · ')
  const headBar = (
    <div className='db-head'>
      <span className='db-head-engine'>{dbTypeLabelMap[tab.dbType] || tab.dbType}</span>
      <span className='db-head-target elli' title={target}>{target}</span>
      <span className='db-head-state'>
        <i className={`db-head-dot ${connError ? 'err' : 'ok'}`} />
        {connError ? e('disconnected') : e('connected')}
      </span>
      {
        connError
          ? (
            <Button
              size='small'
              icon={<ReloadOutlined />}
              onClick={reconnect}
            >
              {e('reconnect')}
            </Button>
            )
          : null
      }
      <span className='db-head-right'>
        {/* 只读开关常驻工具条：切换后主进程白名单同步生效（不用重开连接） */}
        <Tooltip title={`${e('readOnly')} — ${e('readOnlyHint')}`}>
          <Switch
            size='small'
            checked={isReadonly}
            onChange={toggleReadonly}
          />
        </Tooltip>
        <Button
          type='text'
          size='small'
          icon={<ReloadOutlined />}
          loading={treeLoading}
          title={e('refresh')}
          onClick={loadTree}
        />
      </span>
      {/* 窗口级动作：与终端顶栏（SessionControl 右侧）同口径——全屏入口在这里，
          退出全屏由页面内浮层 RemoteFloatControl 提供 */}
      <span className='db-head-actions'>
        <Tooltip title={e('fullscreen')}>
          <Button
            type='text'
            size='small'
            icon={<FullscreenOutlined />}
            onClick={() => window.store.toggleSessFullscreen(true)}
          />
        </Tooltip>
      </span>
    </div>
  )

  return (
    <div className='db-session-wrap'>
      {headBar}
      <div className='db-body'>
        <div
          className='db-tree-panel'
          style={{ width: treeWidth }}
        >
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
        {/* 拖拽条：样式上用负 margin 让它骑跨在左侧容器右边框上，
            因此"拖的就是容器边缘"，而不是浮在面板与主区之间的独立竖条 */}
        <div
          className='db-tree-resizer'
          onMouseDown={startResize}
          title='drag to resize'
        />
        <div className='db-main-panel'>
          {
            connError
              ? (
                <DbConnError
                  banner
                  tab={tab}
                  error={connError}
                  title={e('connectionLost')}
                  onRetry={reconnect}
                />
                )
              : null
          }
          {mainArea}
        </div>
      </div>
      {/* 全屏时页面内唯一的退出入口（与终端相同：右上角 ⋮ → 退出全屏） */}
      <RemoteFloatControl isFullScreen={!!fullscreen} />
    </div>
  )
})
