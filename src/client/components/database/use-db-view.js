/**
 * 数据库会话页的"视图 / 过滤"簇 —— 从 db-session.jsx 拆出的第三段（N11a 第 3 步，cluster #3）。
 *
 * 覆盖范围（db-session.jsx 原 E2 视角段）：viewParts / applyView / scheduleViewSave /
 * restoreView / onViewChange / findLastPage / loadPage / loadQuery / loadWithCount /
 * countExactRows / viewIdOf / pageSizeOf / refreshViewParts / openRefTable。
 *
 * 边界：页面级 ref/state 由 owner（DbSession）注入，本 hook 不自建、不回流
 * （见 AGENTS.md §5.2 句柄归属）。行为零变更：整段是从 db-session.jsx 原样搬过来的
 * （连 2 空格缩进层级都一样），判据与注释没重写。
 *
 * 注入约定：所有来自 DbSession 作用域的值（props、tab、ref、dialect、回调、store 读取）
 * 都通过 params 显式传入；模块级纯函数/常量（buildWhere / normalizeView / gridViewKey /
 * getGridView / saveGridView / removeGridView / DB_PAGE_SIZE_MAX / getDbPageSize /
 * message / window.translate）直接在本文件 import，不走注入。
 */

import {
  buildWhere,
  normalizeView,
  viewKey as gridViewKey
} from '../../common/db-grid-view'
import {
  getGridView,
  saveGridView,
  removeGridView
} from '../../common/db-grid-views'
import {
  DB_PAGE_SIZE_MAX,
  getDbPageSize
} from '../../common/db-session-const'
import message from '../common/message'

// window.translate 在模块内即时调用（不加载时取值），切语言后文案不钉死
const e = window.translate

// 视角键：connectionId 用连接身份（dbConnKey，与连接级安全带同一口径）。
// 不用 tabId：tabId 每次开 tab 都会变，重启后视角就再也对不上了
export function viewIdOf (target, connKey) {
  return gridViewKey({
    connectionId: connKey,
    dbName: target && target.database,
    schema: target && target.schema,
    table: target && target.table
  })
}

// 视角 → 请求片段。三件事都在这里做，调用方不再各拼一份：
// 1) 条件体与绑定参数由 buildWhere 生成（值永远走占位符，列名走白名单+引用符）；
// 2) 排序先按列白名单过一遍 —— 主进程会为"排序引用了不存在的列"直接抛错，
//    那会让整页取不出来（列被删掉后旧视角就变成一张打不开的表）；
// 3) 被丢弃/被截断的条件原样带出来给状态行用。
export function viewParts (v, cols, dialect) {
  const built = buildWhere(v, cols, dialect)
  const known = new Set(cols.map(c => String(c.name).toLowerCase()))
  const orderClauses = ((v && Array.isArray(v.order)) ? v.order : [])
    .filter(o => o && o.column && known.has(String(o.column).toLowerCase()))
    .map(o => ({ column: o.column, desc: o.desc === true }))
  return {
    where: built.clause,
    whereParams: built.params,
    orderClauses,
    rejected: built.rejected,
    truncated: built.truncated
  }
}

// 有效页大小：视角里存过就用它（换机器/重启后仍按上次的粒度看），
// 否则回落全局配置。下限 10 与 getDbPageSize 一致，防脏数据把页大小写成 1
export function pageSizeOf (v) {
  const n = v && v.pageSize
  return Number.isInteger(n) && n >= 10 ? Math.min(n, DB_PAGE_SIZE_MAX) : getDbPageSize()
}

export function useDbView (params) {
  const {
    connKey,
    dialect,
    tabId,
    sel,
    structureV2Ref,
    viewRef,
    viewKeyRef,
    viewSaveTimer,
    viewSeqRef,
    countKeyRef,
    setView,
    setViewMode,
    setWhereDraft,
    setViewBarSeq,
    setViewRejected,
    setViewTruncated,
    setGrid,
    setSelectedRowKeys,
    setExactRows,
    setSel,
    loadStructure,
    resetPageFilter,
    resetExactRows,
    onOpError,
    isConnError
  } = params

  const refreshViewParts = () => {
    const parts = buildWhere(viewRef.current, structureV2Ref.current.columns, dialect)
    setViewRejected(parts.rejected)
    setViewTruncated(parts.truncated)
  }

  // 视角落盘：400ms 防抖（连点排序 chips 时不该每点一次写一次文件）
  const scheduleViewSave = (v) => {
    const key = viewKeyRef.current
    if (!key) {
      return
    }
    if (viewSaveTimer.current) {
      clearTimeout(viewSaveTimer.current)
    }
    viewSaveTimer.current = setTimeout(() => {
      viewSaveTimer.current = null
      // 空视角不写盘而是删键：否则"重置"刚删掉的键会被下一次自动保存在 400ms 后复活。
      // 列显示设置（宽/序/隐藏）也算"非空"：用户只拖过列宽时这份视角必须留得住
      const empty = !v.conditions.length && !v.order.length && v.pageSize === undefined &&
        !v.hiddenColumns.length && !v.columnOrder.length &&
        Object.keys(v.columnWidths).length === 0
      // 空视角不写盘而是删键：否则"重置"刚删掉的键会被下一次自动保存在 400ms 后复活
      if (empty) {
        removeGridView(key)
        return
      }
      saveGridView(key, v)
    }, 400)
  }

  const applyView = (next, opts = {}) => {
    viewRef.current = next
    setView(next)
    refreshViewParts()
    if (opts.persist !== false) {
      scheduleViewSave(next)
    }
  }

  /**
   * 选表时恢复视角。**必须在第一次取页之前完成**，否则会先闪一页全量。
   * @param {Object} target 目标表
   * @param {number} seq 点击序号（与 onSelectTree 的令牌一致）
   * @returns {Promise<boolean>} 是否仍然是"最新一次点击"（false 表示结果作废）
   */
  const restoreView = (target, seq) => {
    const key = viewIdOf(target, connKey)
    viewKeyRef.current = key
    countKeyRef.current = ''
    if (seq !== viewSeqRef.current) {
      return Promise.resolve(false)
    }
    return getGridView(key).then(saved => {
      if (seq !== viewSeqRef.current) {
        return false
      }
      const v = normalizeView(saved)
      viewRef.current = v
      setView(v)
      setViewMode('builder')
      setWhereDraft('')
      setViewBarSeq(n => n + 1)
      refreshViewParts()
      return true
    })
  }

  // F1：关联行"在标签页打开"——主网格切到目标表并按外键等值条件过滤。
  // 不恢复该表的历史视角（restoreView）：用户要的是"带着这个值跳过去"。
  // 条件里的列名来自 catalog（目标表真实列），值来自当前选中行；
  // 主进程 assertPageBoundary 会用目标表结构兜底校验，值全部走绑定参数。
  const openRefTable = (item) => {
    if (!item || !item.target || !item.target.table || item.unusable) {
      return
    }
    const conds = item.whereColumns.map((c, i) => ({
      column: c,
      op: 'eq',
      value: item.whereValues[i]
    }))
    const next = {
      database: item.target.database,
      schema: item.target.schema || '',
      table: item.target.table,
      nodeType: 'table'
    }
    resetPageFilter()
    resetExactRows()
    viewSeqRef.current += 1
    const seq = viewSeqRef.current
    loadStructure(next).then(() => {
      if (seq !== viewSeqRef.current) {
        return null
      }
      viewKeyRef.current = viewIdOf(next, connKey)
      countKeyRef.current = ''
      setViewMode('builder')
      setWhereDraft('')
      setViewBarSeq(n => n + 1)
      applyView(normalizeView({ conditions: conds }))
      setSel(next)
      return loadQuery(next, 1)
    })
  }

  // 空页回退：totalRows 来自 information_schema 估算，常偏大 → 尾部页可能无数据。
  // 用 pageSize=1 探测二分查找真实末页（log2(页数) 次轻量查询）。
  // 探测必须带上与取页**完全相同**的条件与排序，否则"有没有数据"和用户看到的不是一回事
  const findLastPage = (target, page, q) => {
    const size = pageSizeOf(viewRef.current)
    // 探测第 p 页是否有数据 = 查「行偏移 (p-1)*size」处 1 行
    // （probe 的 page 单位是行：page=(p-1)*size+1 → OFFSET (p-1)*size）
    const probe = (p) => {
      const args = {
        database: target.database,
        schema: target.schema || '',
        table: target.table,
        page: (p - 1) * size + 1,
        pageSize: 1
      }
      if (q && q.where) {
        args.where = q.where
        args.whereParams = q.whereParams
      }
      if (q && q.orderClauses && q.orderClauses.length) {
        args.orderClauses = q.orderClauses
      }
      return window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', args)
        .then(res => ((res && res.rows) || []).length > 0)
    }
    let lo = 1
    let hi = page - 1
    let ans = 1
    const step = () => {
      if (lo > hi) {
        return Promise.resolve(ans)
      }
      const mid = Math.floor((lo + hi) / 2)
      return probe(mid).then(ok => {
        if (ok) {
          ans = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
        return step()
      })
    }
    return step()
  }

  /**
   * 取一页数据。**签名刻意保持原样**（target, page, orderBy, order, opts）：
   * 调用点统一走下面的 loadQuery，orderBy/order 两个参数只为兼容保留，**已不再使用**
   * —— 排序的唯一数据源是视角（view.order），再存一份 grid.orderBy 迟早会与 chips 打架。
   * @param {Object} target 目标表
   * @param {number} page 页码
   * @param {*} orderBy 兼容参数，忽略
   * @param {*} order 兼容参数，忽略
   * @param {Object} opts { query, view, skipEmptyCheck, keepLastPage }
   * @returns {Promise} 取数 promise
   */
  const loadPage = (target, page, orderBy, order, opts = {}) => {
    // 行选择挂在当前页索引上，重新取数后索引必然重排 → 先清空
    setSelectedRowKeys([])
    setGrid(g => ({ ...g, loading: true, error: '' }))
    const v = opts.view || viewRef.current
    const q = opts.query || viewParts(v, structureV2Ref.current.columns, dialect)
    const args = {
      database: target.database,
      schema: target.schema || '',
      table: target.table,
      page,
      pageSize: pageSizeOf(v)
    }
    // where 只发给 getPageData，不进 SQL tab 的手写执行路径（那条有自己的分级与确认）
    if (q.where) {
      args.where = q.where
      args.whereParams = q.whereParams
    }
    if (q.orderClauses && q.orderClauses.length) {
      args.orderClauses = q.orderClauses
    }
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', args).then(res => {
      const rows = (res && res.rows) || []
      // 跳到的页无数据且非首页：二分回退到真实末页（估算总行数偏大场景）
      if (!rows.length && page > 1 && !opts.skipEmptyCheck) {
        return findLastPage(target, page, q).then(last => {
          setGrid(g => ({ ...g, loading: true, lastPage: last }))
          return loadPage(target, last, null, null, {
            ...opts,
            query: q,
            skipEmptyCheck: true,
            keepLastPage: true
          })
        })
      }
      setGrid(g => ({
        loading: false,
        rows,
        page,
        hasMore: !!(res && res.hasMore),
        // 服务端只在首页返回近似行数（information_schema 估算，**不带条件**）。
        // 带条件时那个数字与屏幕上的结果集无关，必须用 count 的精确值，
        // 否则"筛出 3 行"的表会显示"约 12 万行"
        // 空表被估算说成 1 的事实在主进程取数时就复核掉了（mysql.js confirmEmpty），
        // 这里只翻译服务端回传的数，界面不再自己推断
        totalRows: q.where
          ? (typeof g.totalRows === 'number' ? g.totalRows : undefined)
          : (res && res.totalRows !== undefined
              ? res.totalRows
              : (page > 1 ? g.totalRows : undefined)),
        // 换表/换排序/换页大小会重置；二分回退与常规翻页保留
        lastPage: opts.keepLastPage ? g.lastPage : undefined,
        error: ''
      }))
      return rows
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

  // 取页的统一入口：条件与排序都来自当前视角
  const loadQuery = (target, page, opts = {}) =>
    loadPage(target, page, null, null, opts)

  /**
   * 条件变更后的取数：先 count 再取页（验收 6：不闪烁空表）。
   * 为什么不能直接取页：条件一变就要知道"结果集多大"才能算页数、才能把页码钳住；
   * 先取页再补 count，中途表格会因为 totalRows 还是旧值而闪一下空表。
   * 为什么 count 期间不清 rows：表格保留上一批行 + loading 遮罩，视觉上是"在算"，
   * 而不是"没了"。
   * 条件没变（只是翻页/换排序）时不重复 count —— COUNT(*) 在大表上不便宜。
   * @param {Object} target 目标表
   * @param {number} page 页码
   * @param {Object} opts 透传给 loadPage（可带 query 覆盖条件体）
   * @returns {Promise} 取数 promise
   */
  const loadWithCount = (target, page, opts = {}) => {
    const q = opts.query || viewParts(viewRef.current, structureV2Ref.current.columns, dialect)
    const key = JSON.stringify([q.where, q.whereParams])
    if (!q.where || key === countKeyRef.current) {
      return loadPage(target, page, null, null, { ...opts, query: q })
    }
    countKeyRef.current = key
    setGrid(g => ({ ...g, loading: true, error: '' }))
    return window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      database: target.database,
      schema: target.schema || '',
      table: target.table,
      page: 1,
      pageSize: 1,
      where: q.where,
      whereParams: q.whereParams,
      count: true
    }).then(res => {
      const total = Number(res && res.total) || 0
      // 带条件的总数是**精确**的（COUNT(*) 走了同一套条件），复用 exactRows 那套文案，
      // 让"精确"与"估算"在界面上始终是两种不同的标签
      setExactRows({ loading: false, value: total })
      setGrid(g => ({ ...g, totalRows: total, lastPage: undefined }))
      return null
    }).catch(err => {
      // 计数失败不阻断取页：清掉指纹，下次还能重试
      countKeyRef.current = ''
      if (isConnError(err)) {
        onOpError(err)
      }
      return null
    }).then(() => loadPage(target, page, null, null, { ...opts, query: q }))
  }

  // T11：按需精确计数；失败只提示，不影响已加载的页面数据
  const countExactRows = () => {
    if (!sel) {
      return
    }
    setExactRows(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'countRows', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table
    }).then(res => {
      setExactRows({ loading: false, value: Number(res && res.count) || 0 })
    }).catch(() => {
      setExactRows(s => ({ ...s, loading: false }))
      message.error(e('dbCountFailed'))
    })
  }

  /**
   * 视角条的统一入口：只接受"补丁"，不接整份 view。
   * 分成两条通道是因为其中两条**不改查询**：
   * - mode / draft：纯 UI 状态；
   * - conditions / order / pageSize：改查询，由 onViewApply 决定何时取数。
   * @param {Object} patch 补丁
   */
  const onViewChange = (patch) => {
    if (!patch || typeof patch !== 'object') {
      return
    }
    if (patch.mode !== undefined) {
      setViewMode(patch.mode === 'sql' ? 'sql' : 'builder')
    }
    if (patch.draft !== undefined) {
      setWhereDraft(String(patch.draft === null || patch.draft === undefined ? '' : patch.draft))
    }
    const touchesQuery = patch.conditions !== undefined ||
      patch.order !== undefined ||
      patch.pageSize !== undefined
    if (!touchesQuery) {
      return
    }
    const cur = viewRef.current
    applyView(normalizeView({
      conditions: patch.conditions !== undefined ? patch.conditions : cur.conditions,
      order: patch.order !== undefined ? patch.order : cur.order,
      pageSize: patch.pageSize !== undefined ? patch.pageSize : cur.pageSize,
      hiddenColumns: cur.hiddenColumns,
      columnWidths: cur.columnWidths,
      columnOrder: cur.columnOrder
    }))
  }

  return {
    // 纯导出（与模块级 viewIdOf/viewParts/pageSizeOf 同签名，仅补上注入的 cols/dialect）
    viewIdOf: (target) => viewIdOf(target, connKey),
    viewParts: (v) => viewParts(v, structureV2Ref.current.columns, dialect),
    pageSizeOf,
    // 带状态/ref 的方法（句柄由 owner 注入）
    refreshViewParts,
    scheduleViewSave,
    applyView,
    restoreView,
    openRefTable,
    findLastPage,
    loadPage,
    loadQuery,
    loadWithCount,
    countExactRows,
    onViewChange
  }
}
