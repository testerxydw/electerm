// #26 Redis / 结构视图弹层：ER 图 + 结构对比（cluster #26 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「整库快照类弹层」这一个职责域 —— 两个弹层都不属于哪张表，
// 打开时按当前库/schema 拉一次，关掉就作废在途请求：
//   ER 图      er / erTokenRef / loadErGraph / openErGraph / closeErGraph
//              取数走 listForeignKeys（MySQL information_schema / PG pg_constraint）
//   结构对比   structDiff / openStructureDiff / closeStructureDiff
//   表设计器   structDesign / openTableDesign / closeTableDesign   （N3b，同一张表）
//              两个弹层的取数共用 loadFreshStructure（都是 getTableStructure + refresh）
//              取数走 getTableStructure + refresh:true（跳过 60s 结构缓存，否则刚
//              ALTER 过的表会拿旧结构对比，得出看不出来的错误结论）
//
// 与 #25（Redis 键浏览）的边界：redisInfo / redisSlowlog 这次**不搬**。
// 那两块虽然也在这两段区间里，但它们的令牌 ref 被 useDbRedisKeys 直接 ++
// （use-db-redis-keys.js:358 关闭弹层时作废在途慢日志请求），属于双向依赖，
// 单独做会制造「一半在 hook、一半在形参」的中间态，并入 #25 一次处理。
//
// 行为零变更：两段逐字搬迁（state 原 645–651 共 7 行，handler 原 2027–2089 共 63 行）。
//
// 不回流（仅本簇内部使用）：setEr / setStructDiff / erTokenRef。
//
// 依赖只有两个：tabId、sel（都在 owner 第 260 行之前定义，所以本 hook 可以
// 紧贴原 state 位置调用，与搬迁前的 TDZ 处境完全一致）。
import { useCallback, useRef, useState } from 'react'
import { cleanDbError } from './db-conn-error'
import message from '../common/message'

// 打开新建表弹层时一次拉齐「可复制的源表」（本库 + 外库）。只查
// information_schema：跨库、不切连接、一次往返；排除系统库与视图（视图没有
// 可复制的 BASE TABLE 结构）。MySQL 系专用 —— createTableDdl 能力位只对 mysql
// 放行，PG / SQLite 的入口根本不渲染，不会拿到这条 SQL。
const CREATE_SOURCE_TABLES_SQL = `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl
  FROM information_schema.TABLES
 WHERE TABLE_TYPE = 'BASE TABLE'
   AND TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'sys', 'mysql')
 ORDER BY TABLE_SCHEMA, TABLE_NAME`

export function useDbRedisInstance ({ tabId, sel, defaultDatabase }) {
  // H3b-3：ER 图。图是整个库/schema 的一张快照，与"当前在看哪张表"无关，
  // 所以打开时按当前库拉一次即可；令牌管"连点刷新时旧响应不覆盖新响应"
  const [er, setEr] = useState({ open: false, loading: false, error: '', graph: null })
  const erTokenRef = useRef(0)
  // H4：结构对比。两张表的选择、取数与差异状态都在弹层里；这里只提供表清单、
  // 取数通道和"从哪张表开始比"
  const [structDiff, setStructDiff] = useState({ open: false, base: null })
  // N3b / N7 表设计器：owner 只记「给哪张表、以什么模式做设计」——
  // mode: 'alter'（改当前表）| 'create'（新建 / 复制表）
  // target: 目标定位。alter 是当前表 {db,schema,table}；create 是
  //         {database,table:''}，表名由弹层输入，目标库可在弹层里换
  // databases/sourceTables: create 打开时一次拉好的目标库与复制源清单
  // 草稿、预览、勾选、复制取数全在弹层内部，不回流到 owner。
  const [structDesign, setStructDesign] = useState({
    open: false,
    mode: 'alter',
    target: null,
    databases: [],
    sourceTables: []
  })

  // H3b-3：ER 图取数。只发 listForeignKeys（MySQL 走 information_schema，
  // PG 走 pg_constraint），范围是当前库/schema —— 图里的表与本页选中的表无关，
  // 换表不用重拉，换库才需要（关闭再打开就是新的一次）。
  const loadErGraph = () => {
    if (!sel || !sel.database) {
      return
    }
    const target = { database: sel.database, schema: sel.schema || '' }
    erTokenRef.current++
    const token = erTokenRef.current
    setEr(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'listForeignKeys', target).then(graph => {
      if (token !== erTokenRef.current) {
        return
      }
      setEr({ open: true, loading: false, error: '', graph: graph || null })
    }).catch(err => {
      if (token !== erTokenRef.current) {
        return
      }
      // 失败保留上一张图：刷新失败不该把还能看的东西一起收走，报错条会说明情况
      setEr(s => ({
        ...s,
        open: true,
        loading: false,
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }

  const openErGraph = () => {
    // 先清空旧图：换库后打开，上一张图闪一下再被顶掉会被当成"新库就长这样"
    setEr({ open: true, loading: true, error: '', graph: null })
    loadErGraph()
  }

  const closeErGraph = () => {
    // 关闭即作废在途请求：关掉再打开不该先看到上一次请求的结果
    erTokenRef.current++
    setEr({ open: false, loading: false, error: '', graph: null })
  }

  // H4 / N3b：结构对比与表设计器共用的取数。refresh 让主进程跳过结构缓存 ——
  // 刚 ALTER 过的表在 60s TTL 内还会返回旧结构，拿它当基准会得出看不出来的错误结论
  // （设计器尤其吃这一条：基准错了，生成的 ALTER 就是照着旧表写的）
  const loadFreshStructure = useCallback(target => window.pre.runGlobalAsync(
    'dbClientOp', tabId, 'getTableStructure', {
      database: target.database,
      schema: target.schema || '',
      table: target.table,
      refresh: true
    }
  ), [tabId])

  const openStructureDiff = () => {
    setStructDiff({
      open: true,
      base: sel ? { database: sel.database, schema: sel.schema || '', table: sel.table } : null
    })
  }

  const closeStructureDiff = () => {
    setStructDiff({ open: false, base: null })
  }

  const openTableDesign = () => {
    setStructDesign({
      open: true,
      mode: 'alter',
      target: sel
        ? { database: sel.database, schema: sel.schema || '', table: sel.table }
        : null,
      databases: [],
      sourceTables: []
    })
  }

  // N7 新建表 / 复制表：设计器的 create 模式。
  //
  // 目标库降级链：打开的表所在库 → 连接默认库（tab.dbName）→ 库清单首项。
  // 不再要求「先打开一张表」—— sel 只在 openTable 成功后才有值，空库里一张表
  // 都没有时恰恰最需要新建表，旧实现只会弹一条 warning 把人挡在外面。
  // 库清单与可复制的源表清单一次并发拉齐；任一失败都不拦着开弹层：目标库退回
  // 连接默认库，复制选择器显示"清单不可用"，空白新建完全不受影响。
  const openCreateTable = async () => {
    const seedDb = (sel && sel.database) || defaultDatabase || ''
    let databases = []
    let sourceTables = []
    try {
      const [dbs, tbls] = await Promise.all([
        window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', {
          sql: 'show databases', database: seedDb || 'mysql'
        }),
        window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', {
          sql: CREATE_SOURCE_TABLES_SQL, database: seedDb || 'mysql'
        })
      ])
      databases = ((dbs && dbs.results && dbs.results[0] && dbs.results[0].rows) || [])
        .map(row => String(Object.values(row)[0]))
        .filter(n => !/^(information_schema|performance_schema|sys|mysql)$/i.test(n))
      sourceTables = ((tbls && tbls.results && tbls.results[0] && tbls.results[0].rows) || [])
        .map(row => {
          const v = Object.values(row)
          return { database: String(v[0]), table: String(v[1]) }
        })
        .filter(t => t.database && t.table)
    } catch (err) {
      databases = []
      sourceTables = []
    }
    const database = seedDb || databases[0] || ''
    if (!database) {
      // 连库清单都看不到（权限极窄）且连接没带默认库：真给不出目标库，
      // 这时才提示，文案是可行动的"选一个库"而不是"先打开一张表"
      message.warning(window.translate('dbCreateTableNeedDb'))
      return
    }
    if (!databases.includes(database)) {
      databases.unshift(database)
    }
    // 复制源可能在外库：把清单里出现过的库也补进目标库候选，
    // 免得"想复制到那个库"却选不到它
    for (const t of sourceTables) {
      if (!databases.includes(t.database)) {
        databases.push(t.database)
      }
    }
    setStructDesign({
      open: true,
      mode: 'create',
      target: { database, schema: '', table: '' },
      databases,
      sourceTables
    })
  }

  const closeTableDesign = () => {
    setStructDesign({
      open: false,
      mode: 'alter',
      target: null,
      databases: [],
      sourceTables: []
    })
  }
  return {
    er,
    loadErGraph,
    openErGraph,
    closeErGraph,
    structDiff,
    structDesign,
    loadFreshStructure,
    openStructureDiff,
    closeStructureDiff,
    openTableDesign,
    openCreateTable,
    closeTableDesign
  }
}
