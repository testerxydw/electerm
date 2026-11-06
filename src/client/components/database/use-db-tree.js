// 元数据树 / 结构加载（cluster #2 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：原 DbSession 内的 loadTree / toggleSys / onSelectTree / loadStructure，
// 以及 treeFilter 状态、treeExpandedBeforeFilter ref、系统库显隐开关逻辑。
// 所有原先读取 DbSession 作用域的值（props、tabId、refs、store 取值、回调）一律注入，
// hook 不自建、不回流（见 AGENTS.md §5.2 句柄归属）。
import { useEffect, useRef, useState } from 'react'
import {
  EMPTY_STRUCTURE_V2,
  isDbObjectType,
  isLeafNode,
  nodeKey
} from '../../common/db-session-const'

export function useDbTree ({
  tabId,
  isRedis,
  metadata,
  hideSystemSchemas,
  setTreeLoading,
  setMetadata,
  setConnError,
  onOpError,
  expandedKeys,
  setExpandedKeys,
  // visibleMetadata 是 owner 里靠后的 useMemo：按值注入会在 hook 调用点 TDZ，
  // 故只注入 getter，在 effect 执行期（那时 const 已初始化）再解析
  getVisibleMetadata,
  // redis 树选择分支
  setRedisDb,
  setRedisKey,
  setRedisDetail,
  redisView,
  resetKeyTree,
  loadRedisKeys,
  loadRedisKeyTree,
  matchInput,
  // 非表对象 / 开表
  showObjectDdl,
  openTable,
  // 结构加载
  setStructure,
  setStructureV2,
  structureV2Ref,
  refreshViewParts
}) {
  // T2 元数据树过滤：仅前端过滤已加载节点；进入过滤前记录展开状态，清空后还原
  const [treeFilter, setTreeFilter] = useState('')
  const treeFilterKw = treeFilter.trim().toLowerCase()
  const treeExpandedBeforeFilter = useRef(null)

  // 系统库显示开关：默认显示（专业工具惯例），隐藏偏好持久化在 config
  const loadTree = (hideOverride) => {
    // hideOverride 供开关切换时显式传值（setConfig 异步生效，闭包读 config 可能拿到旧值）；
    // refresh 按钮等无参调用读 config。Button onClick 直传 event 的场景须用箭头包一层
    const hide = hideOverride === undefined ? hideSystemSchemas : hideOverride
    setTreeLoading(true)
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', { hideSystemSchemas: hide })
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

  // 切换后显式按 next 拉树：setConfig 异步生效，不能依赖闭包里的旧值
  const toggleSys = () => {
    const next = !(window.store._config.dbHideSystemSchemas === true)
    window.store.setConfig({ dbHideSystemSchemas: next })
    loadTree(next)
  }

  const onSelectTree = (keys, info) => {
    const node = info.node
    if (isRedis) {
      // redis 树：key = db index 字符串
      const dbIndex = parseInt(node.key, 10)
      setRedisDb(dbIndex)
      setRedisKey('')
      setRedisDetail(null)
      // 换 db = 换一整个键空间：在途的树抓取必须作废，否则旧 db 的键会混进新树
      const wasTree = redisView === 'tree'
      resetKeyTree()
      loadRedisKeys(dbIndex, '0', matchInput)
      if (wasTree) {
        loadRedisKeyTree(dbIndex, matchInput)
      }
      return
    }
    if (!node.isLeaf) {
      // 库 / schema 节点：点击标题切换展开/收起
      const k = String(node.key)
      setExpandedKeys(ks => (ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k]))
      return
    }
    // key 编码 [database, schema, table]；MySQL schema 为空串
    const [database, schema, table] = JSON.parse(node.key)
    // B2：非表对象（过程/函数/触发器/事件）没有数据网格，点开看 DDL
    if (isDbObjectType(node.nodeType)) {
      showObjectDdl({
        database,
        schema: schema || '',
        name: table,
        objectType: node.nodeType,
        ...(node.objMeta || {})
      })
      return
    }
    // nodeType: 'table' | 'view'。缺省按 table 处理（旧 metadata 无 type 时是表）
    openTable({ database, schema, table, nodeType: node.nodeType })
  }

  // 表结构（列定义）：MySQL 返回 Field/Type/Null/Key/Default/Extra，PG 返回 information_schema 列
  const loadStructure = (target) => {
    setStructure(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'describeTable', {
      database: target.database,
      schema: target.schema || '',
      table: target.table
    }).then(rows => {
      setStructure({ loading: false, rows: rows || [] })
    }).catch(err => {
      setStructure({ loading: false, rows: [] })
      onOpError(err)
    })
    // 视角条的列清单：与主进程校验同源（getTableStructure → structureCached），
    // 主进程侧有 60s TTL，这里几乎是免费的一次调用。
    // 失败静默置空：列拿不到时视角条只能退化（条件会被记为"未知列"），
    // 但结果集本身仍要能打开 —— 不能因为注释查不到就让人看不了数据
    setStructureV2(s => ({ ...s, loading: true }))
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getTableStructure', {
      database: target.database,
      schema: target.schema || '',
      table: target.table
    }).then(res => {
      const columns = (res && Array.isArray(res.columns)) ? res.columns : []
      const foreignKeys = (res && Array.isArray(res.foreignKeys)) ? res.foreignKeys : []
      structureV2Ref.current = { columns, foreignKeys }
      // H3a：整份 v2 契约留在 state 里（字典导出要索引/表注释/类型/行数估算）
      setStructureV2({
        loading: false,
        columns,
        foreignKeys,
        indexes: (res && Array.isArray(res.indexes)) ? res.indexes : [],
        type: (res && res.type) || 'table',
        comment: (res && res.comment) || null,
        estimatedRows: res && Number.isFinite(res.estimatedRows) ? res.estimatedRows : null
      })
      // 列清单晚到：重算"哪些条件引用了不存在的列"（列被删后旧视角要静默降级）
      refreshViewParts()
      return columns
    }).catch(() => {
      structureV2Ref.current = { columns: [] }
      setStructureV2(EMPTY_STRUCTURE_V2)
      refreshViewParts()
      return []
    })
  }

  // 进入过滤时记录原展开状态并展开命中的库 / schema；清空后还原（见下一个 effect）
  useEffect(() => {
    if (!treeFilterKw || isRedis) {
      return
    }
    if (treeExpandedBeforeFilter.current === null) {
      treeExpandedBeforeFilter.current = expandedKeys
    }
    const keys = []
    // 展开键必须与 treeData 里同一节点的 key 同一推导：
    // 分组节点（例程/触发器/事件）挂在「库[/schema] + 组名」三位形态上，
    // schema 节点才是「库 + schema」两位形态。少一位 → 分组永远不展开，
    // 计数条说命中 6 个节点、树里只画得出 4 个（真 MariaDB 实测踩到）
    const walk = (dbName, schema, nodes) => {
      (nodes || []).forEach(node => {
        if (isLeafNode(node)) {
          return
        }
        const isGroup = node.type === 'group'
        keys.push(isGroup ? nodeKey(dbName, schema, node.name) : nodeKey(dbName, node.name))
        walk(dbName, isGroup ? schema : node.name, node.children)
      })
    }
    getVisibleMetadata().forEach(db => {
      keys.push(nodeKey(db.name))
      walk(db.name, '', db.children)
    })
    setExpandedKeys(keys)
  }, [treeFilterKw, metadata, isRedis])

  useEffect(() => {
    if (treeFilterKw) {
      return
    }
    if (treeExpandedBeforeFilter.current !== null) {
      setExpandedKeys(treeExpandedBeforeFilter.current)
      treeExpandedBeforeFilter.current = null
    }
  }, [treeFilterKw])

  return {
    treeFilter,
    setTreeFilter,
    treeFilterKw,
    treeExpandedBeforeFilter,
    loadTree,
    toggleSys,
    onSelectTree,
    loadStructure
  }
}
