/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin, Tabs, Input, InputNumber, Tag, Popconfirm, Switch, Tooltip, Select, Modal, Popover, Checkbox, Dropdown } from 'antd'
import { ReloadOutlined, LeftOutlined, RightOutlined, SearchOutlined, DownloadOutlined, HistoryOutlined, DeleteOutlined, PlusOutlined, CopyOutlined, CloseOutlined, FormatPainterOutlined, DiffOutlined, SettingOutlined, MenuOutlined, UpOutlined, DownOutlined } from '@ant-design/icons'
import { auto } from 'manate/react'
import message from '../common/message'
import DbConnError from './db-conn-error'
import SessionBarActions from '../common/session-bar-actions'
import SearchBar from '../common/search-bar'
import DbSplitPane from './db-split-pane'
import DbValuePane from './db-value-pane'
import RemoteFloatControl from '../common/remote-float-control'
import { highlightValue, useKeywordPatterns } from './db-highlight'
import { hlText, hlNode, scanTextHits, cycleIndex } from './db-search'
import clone from '../../common/to-simple-obj'
import { downloadCsv, downloadText, buildCopyStatements } from '../../common/db-csv'
import { copy } from '../../common/clipboard'
import { appendSqlHistory, listSqlHistory, clearSqlHistory, removeSqlHistory } from '../../common/db-sql-history'
import {
  clampPanelSize,
  readHistoryPanelSize,
  sizePatch,
  splitMode,
  moveHistoryIndex,
  clampHistoryIndex,
  previewText,
  filterHistory
} from '../../common/db-sql-history-panel'
import { formatSql } from '../../common/db-sql-format'
// 只取元数据整形函数：引擎主体仍只被懒加载的编辑器引用，
// 这里不会把任何编辑器代码拖进主 chunk
import { flattenTables, indexColumns } from '../../common/db-sql-complete'
import { SQL_EDITOR_OPTIONS, readSqlEditorOpts, toggleSqlEditorOpt } from '../../common/db-sql-opts'
import { dbTypeLabelMap } from '../../common/constants'
// E1：危险 SQL 分级 + 连接级安全带。两个模块都是零依赖纯函数（时间经 now 注入），
// 判定逻辑与 UI 解耦，单测可直接跑源码
import { classifySql } from '../../common/db-sql-risk'
import {
  BYPASS_TTL_MS,
  bypassLeftMinutes,
  cancelPendingGate,
  clearBypass,
  createGuardState,
  dbConnKey,
  grantBypass,
  isBypassed,
  markAsked,
  muteLowWrite,
  shouldConfirm
} from '../../common/db-safe-guard'
import DbDangerConfirm from './db-danger-confirm'
import DbViewBar from './db-view-bar'
// E2 结果集视角：条件体/排序的生成与解析都是纯函数（零依赖，单测逐条钉死）。
// 这里只消费，不在这里拼 SQL —— 渲染层拼字符串是注入的经典入口
import {
  normalizeView,
  buildWhere,
  parseClause,
  findClauseProblem,
  nextSortOrder,
  viewKey as gridViewKey
} from '../../common/db-grid-view'
// 视角持久化走主进程文件（userData/db-grid-views.json）：localStorage 会因
// UI server 动态端口导致 origin 漂移，跨启动读空
import {
  getGridView,
  saveGridView,
  removeGridView
} from '../../common/db-grid-views'
// E2-3b：展示层本地化（数值千分位/日期时间格式）。三条边界写在模块头注释里，
// 这里只消费：编辑框取原值、导出取原始行、UPDATE 拼原值，都不经过它
import { formatCellValue, readFormatLocale, FORMAT_LOCALE_KEY } from '../../common/db-format-value'
import './db-session.styl'

// A-1：CM6 外壳懒加载 —— 只有这个 dynamic import 会牵出 @codemirror/*，
// 主 chunk 因此不含编辑器代码（构建断言见 src/build/bin/check-cm6-chunk.js）。
// 骨架屏沿用原 textarea 的尺寸与边框，避免首帧跳动。
const SqlCodeEditor = lazy(() => import('./db-sql-editor'))

const e = window.translate
// 每页行数：可经 config.dbPageSize 配置（10/20/50/100/500），默认 20；
// 服务端上限 1000 不变（mysql.js/redis.js）
const DB_PAGE_SIZE_DEFAULT = 20
const getDbPageSize = () => {
  const v = Number(window.store._config && window.store._config.dbPageSize)
  return v >= 10 ? Math.min(v, 1000) : DB_PAGE_SIZE_DEFAULT
}
// A-7：SQL 补全关键字大小写（'lower' 默认 / 'upper'），非法值一律回落小写
const getSqlKeywordCase = () => {
  const v = window.store._config && window.store._config.dbSqlKeywordCase
  return v === 'upper' ? 'upper' : 'lower'
}
// 历史弹层的尺寸上限按视口算（弹层挂在工具条下方，超过视口下沿就够不着列表底部）
const viewportSize = () => ({
  width: window.innerWidth,
  height: window.innerHeight
})
// 元数据树宽度约束与持久化键
const TREE_WIDTH_KEY = 'electerm-db-tree-width'
const TREE_MIN_W = 160
const TREE_MAX_W = 600
// 上下分区比例持久化键（DbSplitPane 消费）：redis 键列表/详情、mysql 网格/单元格预览
const REDIS_SPLIT_KEY = 'electerm-db-redis-split'
const CELL_SPLIT_KEY = 'electerm-db-cell-split'
// Redis hash/set 详情每页条数（后端 HSCAN/SSCAN 游标分页）
const REDIS_DETAIL_PAGE = 200
// B1 行选择列宽（与 db-session.styl 的 .ant-table-selection-column 同值）：
// 必须同时给 antd rowSelection.columnWidth（决定 colgroup）与 CSS（内边距），
// 只给 CSS 时表头那套 table 在列宽超容器后会把该列压成 1px
const SEL_COL_W = 36
// 树节点 key 用 JSON 数组编码，避免库/表名含 '.' 时拆解歧义
// F0：元数据契约 v2 起叶子多了 type:'view'。树的三处分支（过滤/展开/渲染）
// 原来只认 'table'，视图会被当成 schema 画成一个带 S 标记的空节点、点不开
const isLeafNode = node => node.type === 'table' || node.type === 'view'
const nodeKey = (database, schema, table) => JSON.stringify([
  database,
  schema || '',
  table || ''
])

// B1 插入行表单列归一化：两引擎 describeTable 字段名不同
// （MySQL: Field/Type/Key/Extra；PG: column_name/data_type/is_primary_key/column_default），
// 统一为 [{name, type, isPk, isAutoInc, isNumeric}] 供插入弹窗渲染与校验
const buildInsertFormColumns = (structureRows, dbType) => {
  const isPg = dbType === 'postgres'
  return (structureRows || []).map(r => {
    const name = isPg ? r.column_name : r.Field
    const type = String(isPg ? r.data_type : (r.Type || '')).toLowerCase()
    const extra = String(r.Extra || '').toLowerCase()
    const isPk = isPg
      ? r.is_primary_key === true
      : String(r.Key || '').toUpperCase() === 'PRI'
    // 自增：MySQL 看 Extra=auto_increment；PG 看 column_default 含 nextval（serial/identity）
    const isAutoInc = isPg
      ? String(r.column_default || '').includes('nextval')
      : extra.includes('auto_increment')
    const isNumeric = /(int|decimal|numeric|float|double|real|number|serial)/.test(type)
    return { name, type, isPk, isAutoInc, isNumeric }
  }).filter(c => c.name)
}
// 展示用的字面量预览。**只用于确认弹窗的文案，永远不参与拼 SQL**：
// 主进程按参数化构造语句（前端只传值），这里拼字符串仅为让用户看清"要改成什么"。
// 超长值截断，避免一整段长文本/二进制把弹窗撑爆
const previewLiteral = (v) => {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  const s = String(v)
  return "'" + (s.length > 60 ? s.slice(0, 60) + '…' : s) + "'"
}
// 网格写操作的语句预览：库名可缺省（连接无默认库时只显示表名）
const writeTargetLabel = (sel) => {
  if (!sel) {
    return ''
  }
  return (sel.database ? sel.database + '.' : '') + sel.table
}
// 数据库网格统一包装（doc/已完成/数据库功能设计归档-2026-10-21.md）：
// 表体定高滚动（scroll.y）→ 横向滚动条常驻可视区底边、不再沉到全部行之下，表头随之吸顶。
// 容器/表头高度用 ResizeObserver 实测（覆盖窗口变化/分屏/树宽拖拽/数据渲染）；
// ResizeObserver 挂载时创建一次；数据/加载态变化时补测一次。
// 测量未就绪时不传 y，保持原有的外层容器滚动行为（优雅降级）
function DbGridTable (props) {
  const { className = '', style, ...rest } = props
  const wrapRef = useRef(null)
  const measureRef = useRef(() => {})
  const [wrapH, setWrapH] = useState(0)
  const [headH, setHeadH] = useState(0)
  // ResizeObserver 只在挂载时建一次：原实现每次 render 都新建/断开，
  // 输入查找、过滤等高频状态变化会带来无谓的观察器与同步测量开销。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) {
      return
    }
    const measure = () => {
      // scroll.y 生效后表头是独立渲染的 .ant-table-header 容器（含边框），
      // 必须用它的高度：用 thead 会少算边框/子像素 → 表头+表体总高超出 wrap
      // 一点 → 外层 .db-grid-table 出现竖向滚动条（双滚动条）。
      // 用 getBoundingClientRect（小数）+ ceil：不放大可用高度
      const head = el.querySelector('.ant-table-header') ||
        el.querySelector('.ant-table-thead')
      setWrapH(el.clientHeight)
      setHeadH(head ? Math.ceil(head.getBoundingClientRect().height) : 0)
    }
    measureRef.current = measure
    measure()
    const ob = new window.ResizeObserver(() => measureRef.current())
    ob.observe(el)
    // 表头单独观察：首次测量可能落在瞬时渲染态（拿到偏小的高度），数据渲染后表头才稳定
    const head = el.querySelector('.ant-table-header') ||
      el.querySelector('.ant-table-thead')
    if (head) {
      ob.observe(head)
    }
    return () => {
      measureRef.current = () => {}
      ob.disconnect()
    }
  }, [])
  // 数据/加载态变化后补测一次（列宽与行数变化可能改变表头高度）
  useEffect(() => {
    measureRef.current()
  }, [rest.dataSource, rest.loading])
  const y = wrapH > 0 && headH > 0 && wrapH > headH ? wrapH - headH : 0
  return (
    <div className={'db-grid-table-wrap' + (className ? ' ' + className : '')} ref={wrapRef} style={style}>
      <Table
        {...rest}
        className='db-grid-table'
        // 行虚拟渲染：DOM 行数与 pageSize 解耦（只渲染可视区），行少自动退化为全渲染
        virtual={y > 0}
        // y 生效后表体自己滚动，外层禁掉纵向滚动（子像素取整仍可能溢出 1px → 双滚动条）
        style={y > 0 ? { overflowY: 'hidden' } : undefined}
        scroll={{ x: 'max-content', ...(y > 0 ? { y } : {}) }}
      />
    </div>
  )
}

export default auto(function DbSession (props) {
  const { tab } = props
  const tabId = tab.id
  // 全屏状态直接读 store：auto 会订阅它，切换全屏时本页跟着重渲染
  // （props 里的 fullscreen 不订阅 store，切全屏时页面不会重渲染）
  const fullscreen = window.store.fullscreen
  const isRedis = tab.dbType === 'redis'
  const isPg = tab.dbType === 'postgres'
  // PG 一个连接只绑定一个库；当前库名按驱动默认值回退到用户名
  const currentDbName = tab.dbName || tab.dbUser || ''
  // 跨库连接弹窗目标库（null = 关闭）
  const [connectDb, setConnectDb] = useState(null)
  // 页面内查找（顶栏搜索）：搜索框开关 + 关键字 + 命中数（命中数由 DOM 统计）
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchHits, setSearchHits] = useState(0)
  // 当前命中序号（0 基）：上一个/下一个循环导航 + 当前命中两色/滚动定位。
  // ref 镜像供 recount（rAF 回调）与 goHit 读取最新值，避开 setState 闭包过期
  const [searchIndex, setSearchIndex] = useState(0)
  const searchIndexRef = useRef(0)
  // 命中清单 ref：DOM 标记数组 + textarea 文本命中 + SQL 编辑器命中数
  // （编辑器是 CM6，只有可视行在 DOM 里，命中数由编辑器自己按全文算，见 A-1）
  const hitsRef = useRef({ marks: [], taHits: [], sqlHits: 0 })
  // SQL 编辑器句柄（A-1 CM6）：page 查找与"清空/回填"都通过它操作编辑器
  const sqlEditorRef = useRef(null)

  const setIdx = (v) => {
    searchIndexRef.current = v
    setSearchIndex(v)
  }

  // 仅切换 DOM 当前命中的 .db-kw-cur 类（不滚动、不抢焦点；recount 与渲染后共用）
  const applyMarks = (index) => {
    const { marks } = hitsRef.current
    marks.forEach((el, i) => el.classList.toggle('db-kw-cur', i === index))
  }

  // 导航定位（仅 goHit 调用）：DOM 命中滚动到可视区；textarea 命中 focus +
  // setSelectionRange；SQL 编辑器命中交给编辑器自己 dispatch 选区（CM6 只渲染可视行，
  // 它是唯一能按全文偏移定位的人）
  const locateHit = (index) => {
    const { marks, taHits, sqlHits } = hitsRef.current
    applyMarks(index)
    if (index < marks.length) {
      const cur = marks[index]
      if (cur && cur.isConnected) {
        cur.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      return
    }
    const taIndex = index - marks.length
    if (taIndex < taHits.length) {
      const hit = taHits[taIndex]
      if (hit && hit.el.isConnected) {
        hit.el.focus()
        hit.el.setSelectionRange(hit.start, hit.end)
        hit.el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      return
    }
    const editor = sqlEditorRef.current
    if (editor && sqlHits && taIndex - taHits.length < sqlHits) {
      editor.setSearchKeyword(kw)
      editor.selectSearchHit(taIndex - taHits.length)
    }
  }
  const bodyRef = useRef(null)
  const kw = searchText.trim().toLowerCase()

  // 命中清单 = 页面 .db-kw-hit 标记 + textarea 内文本命中（值面板编辑态）+
  // SQL 编辑器命中（CM6 自己算全文，DOM 里只有可视行）。
  // 用 MutationObserver + input 事件委托跟随内容变化重算，计数与可定位位置永远一致。
  useEffect(() => {
    const root = bodyRef.current
    if (!root) {
      return
    }
    let raf = 0
    const recount = () => {
      window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => {
        const marks = Array.from(root.querySelectorAll('.db-kw-hit'))
        const taHits = []
        let sqlHits = 0
        if (kw) {
          root.querySelectorAll('textarea').forEach(ta => {
            scanTextHits(ta.value, kw).forEach(h => {
              taHits.push({ el: ta, start: h.start, end: h.end })
            })
          })
          // CM6 只把可视行渲染进 DOM，命中必须问编辑器要全文结果
          if (sqlEditorRef.current) {
            sqlHits = sqlEditorRef.current.getSearchHits(kw).length
          }
        }
        hitsRef.current = { marks, taHits, sqlHits }
        const total = marks.length + taHits.length + sqlHits
        setSearchHits(total)
        // 内容变化导致命中减少时收敛当前序号，避免越界；同步刷新当前命中标记
        const cur = total ? Math.min(searchIndexRef.current, total - 1) : 0
        setIdx(cur)
        applyMarks(cur)
      })
    }
    recount()
    const ob = new window.MutationObserver(recount)
    ob.observe(root, { childList: true, subtree: true, characterData: true })
    // textarea 的 value 变化不产生 DOM mutation，靠 input 事件委托补算
    root.addEventListener('input', recount, true)
    return () => {
      ob.disconnect()
      root.removeEventListener('input', recount, true)
      window.cancelAnimationFrame(raf)
    }
  }, [kw])

  // 换关键字时回到第一个命中
  useEffect(() => {
    setIdx(0)
  }, [kw])

  // 渲染后同步当前命中：DOM 标记类 + （仅 DOM 命中）滚动到可视区。
  // 切词瞬间 hitsRef 可能还是旧清单（rAF recount 未跑），但 detached 元素操作无害，
  // recount 回调会按新清单重标；textarea 定位只在 goHit 里做，避免切词时抢搜索框焦点
  useEffect(() => {
    const root = bodyRef.current
    if (!root) {
      return
    }
    const { marks } = hitsRef.current
    marks.forEach((el, i) => el.classList.toggle('db-kw-cur', i === searchIndex))
    const cur = marks[searchIndex]
    if (cur && cur.isConnected) {
      cur.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [searchIndex, searchHits, kw])

  // 上一个/下一个：循环导航（与终端查找同交互；命中含 textarea 与编辑器内文本）
  const goHit = (delta) => {
    const { marks, taHits, sqlHits } = hitsRef.current
    const n = marks.length + taHits.length + sqlHits
    if (!n) {
      return
    }
    const next = cycleIndex(searchIndexRef.current, delta, n)
    setIdx(next)
    locateHit(next)
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchText('')
    setIdx(0)
  }
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [metadata, setMetadata] = useState([])
  const [treeLoading, setTreeLoading] = useState(false)
  // 树展开状态（受控：点击库节点标题也可展开/收起）
  const [expandedKeys, setExpandedKeys] = useState([])
  // 当前选中表 {database, table}
  const [sel, setSel] = useState(null)
  // 数据网格状态。注意这里**没有** orderBy：排序的唯一数据源是 view.order
  // （视角条 chips 与列头箭头都从它渲染，再存一份一定会打架）
  const [grid, setGrid] = useState({
    loading: false,
    rows: [],
    page: 1,
    hasMore: false,
    totalRows: undefined,
    // 实测末页：估算总行数偏大时经二分探测得出（见 loadPage 空页回退）
    lastPage: undefined,
    error: ''
  })
  // T11 精确总行数：默认只显示服务端估算值，用户点击后才执行 COUNT(*)
  const [exactRows, setExactRows] = useState({ loading: false, value: null })
  const resetExactRows = () => setExactRows({ loading: false, value: null })
  // T1 当前页行过滤：仅前端过滤已加载的这一页，不触发 SQL / 分页变化
  const [pageFilter, setPageFilter] = useState('')
  const pageFilterKw = pageFilter.trim().toLowerCase()
  // B1 行选择（checkbox 列）：按 __rowKey（当前页原始索引）定位；
  // 任何重新取数（切表/翻页/排序/刷新）都会重排索引 → loadPage 里统一清空
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  // 过滤后的行保留原始 __rowKey（选中单元格 / 行内编辑 / UPDATE 仍按原页索引定位）
  const filteredRows = useMemo(() => {
    const rows = grid.rows.map((r, i) => ({ ...r, __rowKey: i }))
    if (!pageFilterKw) {
      return rows
    }
    return rows.filter(r => Object.keys(r).some(k => {
      if (k === '__rowKey') {
        return false
      }
      const v = r[k]
      return (v === null || v === undefined ? 'NULL' : String(v))
        .toLowerCase()
        .includes(pageFilterKw)
    }))
  }, [grid.rows, pageFilterKw])
  // T2 元数据树过滤：仅前端过滤已加载节点；进入过滤前记录展开状态，清空后还原
  const [treeFilter, setTreeFilter] = useState('')
  const treeFilterKw = treeFilter.trim().toLowerCase()
  const treeExpandedBeforeFilter = useRef(null)

  // 元数据树宽度（可拖拽；持久化到 localStorage，避免污染用户配置）
  const [treeWidth, setTreeWidth] = useState(() => {
    const v = Number(window.localStorage.getItem(TREE_WIDTH_KEY))
    return v >= TREE_MIN_W && v <= TREE_MAX_W ? v : 240
  })

  // 表结构（describetable）
  const [structure, setStructure] = useState({ loading: false, rows: [] })

  // ---- E2 结果集视角（设计 §7.2 / §7.4）----
  // 方言：只有 pg 与 mysql 两套词法（tidb/oceanbase 走 mysql 协议，词法同 mysql）
  const dialect = tab.dbType === 'postgres' ? 'postgres' : 'mysql'
  // 列清单 v2：**必须**来自 getTableStructure —— 主进程 assertPageBoundary 的列白名单
  // 判据就是它（structureCached）。用 describeTable 会出现"渲染层认为列合法、
  // 主进程判未知列"的错位（那份还是 DESC 两引擎字段名不同的原始行，且没有注释）。
  // 与现有 structure 并列而不是替换：行定位、插入表单、表结构 tab 仍在用 describeTable。
  const [structureV2, setStructureV2] = useState({ loading: false, columns: [] })
  // 查询路径（loadPage/onTableChange 里的异步回调）要读到最新列清单，state 在闭包里会过期
  const structureV2Ref = useRef({ columns: [] })
  // E2-3b：单元格展示层本地化开关。默认 'none'（原样 String(value)），
  // 要的人自己在网格头部打开。只影响 renderCell 的显示文本
  const [formatLocale, setFormatLocale] = useState(
    () => readFormatLocale(window.store._config)
  )
  // 当前视角：只有六个字段（normalizeView 裁过），排序/条件/页大小的**唯一**数据源
  const [view, setView] = useState(() => normalizeView(null))
  const viewRef = useRef(view)
  // 视角条模式与 SQL 草稿（构建器 ⇄ SQL 共用同一份草稿）
  const [viewMode, setViewMode] = useState('builder')
  const [whereDraft, setWhereDraft] = useState('')
  // 被丢弃（完全没生效）/被截断（生效了但取值被裁）的条件清单，两条文案必须分开
  const [viewRejected, setViewRejected] = useState([])
  const [viewTruncated, setViewTruncated] = useState([])
  // 视角条重挂载令牌：换表与"重置"都要把编辑中的行复位。
  // 本地行刻意不从 props 回灌（空值行不生效，回灌会让用户正在输入的行凭空消失）
  const [viewBarSeq, setViewBarSeq] = useState(0)
  // 当前视角的持久化键 / 上一次做过 count 的条件指纹（同条件不重复 count）
  const viewKeyRef = useRef('')
  const countKeyRef = useRef('')
  const viewSaveTimer = useRef(null)
  // 选表竞态序号：连点两张表时只允许最后一次恢复视角的结果生效
  const viewSeqRef = useRef(0)
  // 单元格编辑态：{ rowKey, col } + 输入框值（回车提交 / 失焦取消）
  const [editing, setEditing] = useState(null)
  const [editValue, setEditValue] = useState('')
  // 单元格预览面板（点击选中；完整值 + 复制/编辑/保存）
  const [selectedCell, setSelectedCell] = useState(null)
  // A-5：列补全用的列索引（由 listColumns 整成 {表名: 列[]}）
  const [sqlColumns, setSqlColumns] = useState({})
  // 面板值 = 选中单元格的原始值（编辑草稿在 DbValuePane 内部）
  const panelValue = selectedCell && grid.rows[selectedCell.rowKey]
    ? String(grid.rows[selectedCell.rowKey][selectedCell.col] ?? '')
    : ''
  // T1 过滤变化会改变可见行：清掉选中/编辑，避免原索引指向另一行
  const resetPageFilter = () => {
    setPageFilter('')
    setSelectedCell(null)
    setEditing(null)
  }
  const onPageFilterChange = (ev) => {
    setPageFilter(ev.target.value)
    setSelectedCell(null)
    setEditing(null)
  }
  // 连接层错误：用于顶部提示 + 重连按钮
  const [connError, setConnError] = useState('')

  // SQL 编辑器状态（MVP：textarea + Ctrl/Cmd+Enter 执行）
  const [sqlText, setSqlText] = useState('')
  // A-7：补全关键字大小写。照 dbPageSize 的先例走客户端 config，
  // 不进主进程默认表（那边没有数据库分区，加键要连带改设置面板结构）
  const [sqlKeywordCase, setSqlKeywordCase] = useState(getSqlKeywordCase)
  // A-8：编辑器六项开关（行号/换行/补全/括号/当前行/折叠），持久化在 config
  const [sqlEditorOpts, setSqlEditorOpts] = useState(
    () => readSqlEditorOpts(window.store._config)
  )
  const [sqlResult, setSqlResult] = useState({
    loading: false,
    // 多结果集：每项 { rows, fields, affected }（单条语句时只有 1 项）
    results: [],
    error: ''
  })

  // ---- E1 危险 SQL 分级 + 连接级安全带 ----
  // guard 状态放 ref：lowRiskMuted / bypass / asked 都是内存开关，只在事件回调里读写，
  // 不需要参与渲染（倒计时另用 tick 触发重渲染）
  const guardRef = useRef(null)
  if (guardRef.current === null) {
    guardRef.current = createGuardState()
  }
  // 危险确认弹窗的受控状态：null = 不显示；非 null 时 riskResolveRef 里挂着等待中的 promise
  const [riskGate, setRiskGate] = useState(null)
  const riskResolveRef = useRef(null)
  // 卸载（关 tab / 切连接）时把挂起的闸门解析为 false。
  // 不清理的后果很具体：弹窗还开着的时候用户关掉这个 tab，`runSql` 里那次 `await`
  // 永远不 settle —— 闭包握着 sql 与 risk 对象，DevTools 里留一堆永不 resolve 的 promise，
  // 标签页多的会话里会累积。解析成 false（取消）而不是 true：卸载绝不能让
  // "用户还没确认的执行"继续跑，这与用户点"取消"是同一条零执行分支。
  useEffect(() => () => cancelPendingGate(riskResolveRef), [])
  // 生产标记来自书签（tab 由书签展开），只认严格 true：
  // 旧书签没有该字段时为 undefined，必须视为非生产
  const isProduction = tab.production === true
  // 连接身份：mute 与"临时解除"都按它记账（见 db-safe-guard 注释）
  const connKey = useMemo(
    () => dbConnKey(tab),
    [tab.dbType, tab.dbHost, tab.dbPort, tab.dbUser, tab.dbName]
  )

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

  // 关键字高亮规则：与终端「关键字高亮」同一份配置（config.keywords）
  const keywordPatterns = useKeywordPatterns()
  // 高亮配色跟随终端主题（与终端里同一色名同一颜色）。
  // ⚠️ getThemeConfig 内部走 store.config getter（每次 deepCopy 整个配置）+ getSidebarList，
  // 每渲染调用会造成内存/CPU 波动 —— 以主题 id 为依赖缓存，主题切换才重算
  const themeId = window.store._config.theme
  const themeConfig = useMemo(
    () => window.store.getThemeConfig(),
    [themeId]
  )

  // string 键原始值（值预览面板渲染/编辑；格式化与高亮缓存内聚在 DbValuePane）
  // 注意：必须放在下面那些提前 return 之前 —— hooks 数量不能在渲染间变化
  const stringValue = redisDetail && redisDetail.type === 'string'
    ? String(redisDetail.value ?? '')
    : ''
  // 大 string 截断标记（后端 fields=['truncated']，total=完整字节数）：
  // 预览非全量，必须禁编辑防截断值覆盖写回真实键
  const stringTruncated = !!(redisDetail && redisDetail.type === 'string' &&
    (redisDetail.fields || []).includes('truncated'))

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

  // 系统库显示开关：默认显示（专业工具惯例），隐藏偏好持久化在 config
  const hideSystemSchemas = window.store._config.dbHideSystemSchemas === true

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

  // 重新建连：先释放旧连接（openDbTab 内部也会兜底关闭残留），再拉元数据
  const doConnect = () => window.pre.runGlobalAsync('closeDbTab', tabId)
    .catch(() => {})
    .then(() => window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark())))
    .then(() => window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', { hideSystemSchemas }))
    .then(data => {
      setMetadata(data || [])
      setConnError('')
      setReady(true)
      return null
    })

  // T4 跨库连接：复用当前连接的主机/端口/账号，目标库另开临时 tab（不写书签）
  const connectOtherDb = () => {
    if (!connectDb) {
      return
    }
    const next = clone(tab)
    delete next.id
    delete next.tabCount
    delete next.status
    delete next.title
    next.dbName = connectDb
    window.store.addTab(next)
    setConnectDb(null)
  }

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
      hasMore: false
    })
    // 换 tab 等于换了一张"表都没选"的空白页：视角、草稿、列清单必须一起复位，
    // 否则新 tab 的第一帧会带着上一个 tab 的条件去取数
    const fresh = normalizeView(null)
    viewRef.current = fresh
    viewKeyRef.current = ''
    countKeyRef.current = ''
    setView(fresh)
    setStructureV2({ loading: false, columns: [] })
    structureV2Ref.current = { columns: [] }
    setViewMode('builder')
    setWhereDraft('')
    setViewRejected([])
    setViewTruncated([])
    setViewBarSeq(n => n + 1)
    // tab/sshBookmark 来自 store（mobx proxy），IPC 结构化克隆前需转普通对象
    window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark()))
      .then(() => {
        if (cancelled) {
          return undefined
        }
        return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', { hideSystemSchemas })
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
      // 卸载时把待写盘的视角保存取消：定时器里引用的是旧 tab 的键，
      // 留到之后触发只会把"已经关掉的表"的视角再写一遍
      if (viewSaveTimer.current) {
        clearTimeout(viewSaveTimer.current)
        viewSaveTimer.current = null
      }
      window.pre.runGlobalAsync('closeDbTab', tabId).catch(() => {})
    }
  }, [tabId])

  // A-5：列补全的数据源。listColumns 一次拿全库列（MySQL 按库、PG 按整库），
  // 切表/切结果零请求；主进程侧 columnsCache 再做一层，切库来回也不打库。
  // 失败静默：补全退化为关键字，绝不能因为查不到列而打断打字。
  // metadata 变了说明刷新过（主进程缓存在 getMetadata 时已失效），跟着重取。
  const sqlDbName = (sel && sel.database) || currentDbName
  useEffect(() => {
    if (isRedis || !ready) {
      return undefined
    }
    let alive = true
    window.pre.runGlobalAsync(
      'dbClientOp', tabId, 'listColumns', sqlDbName ? { database: sqlDbName } : {}
    )
      .then(res => {
        if (alive) {
          setSqlColumns(indexColumns(res))
        }
      })
      .catch(() => {
        if (alive) {
          setSqlColumns({})
        }
      })
    return () => {
      alive = false
    }
  }, [isRedis, ready, sqlDbName, metadata, tabId])

  // A-4：补全用的表名。数据来自已加载的 metadata（**零请求**），
  // 优先跟随树里选中的库，没选中时用连接配置里的库；Redis 无表概念。
  // 注意必须留在 `if (!ready) return` 之前：hooks 顺序一旦与首帧不同，
  // 开发态直接抛 "Rendered more hooks"，生产态则静默重挂（状态/副作用全丢）
  const sqlTables = useMemo(() => {
    if (isRedis) {
      return []
    }
    return flattenTables(metadata, sqlDbName)
  }, [isRedis, metadata, sqlDbName])

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
      // 库 / schema 节点：点击标题切换展开/收起
      const k = String(node.key)
      setExpandedKeys(ks => (ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k]))
      return
    }
    // key 编码 [database, schema, table]；MySQL schema 为空串
    const [database, schema, table] = JSON.parse(node.key)
    // nodeType: 'table' | 'view'。缺省按 table 处理（旧 metadata 无 type 时是表）
    const next = { database, schema: schema || '', table, nodeType: node.nodeType || 'table' }
    resetPageFilter()
    resetExactRows()
    // 竞态令牌在**点击时**就取：结构查询是异步的，两次点击的完成顺序可能颠倒，
    // 用"恢复时"的序号会出现"后点的表被先点的结果覆盖"
    viewSeqRef.current += 1
    const seq = viewSeqRef.current
    // 顺序很关键：列清单 → 视角 → 第一次取页。
    // 先取页会先闪一页全量数据（条件还没恢复），而列清单晚到会让条件全被判"未知列"
    loadStructure(next)
      .then(() => restoreView(next, seq))
      .then(ok => {
        if (!ok) {
          // 恢复期间用户又点了别的表：这一次的结果整体作废
          return null
        }
        setSel(next)
        return loadQuery(next, 1)
      })
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
      structureV2Ref.current = { columns }
      setStructureV2({ loading: false, columns })
      // 列清单晚到：重算"哪些条件引用了不存在的列"（列被删后旧视角要静默降级）
      refreshViewParts()
      return columns
    }).catch(() => {
      structureV2Ref.current = { columns: [] }
      setStructureV2({ loading: false, columns: [] })
      refreshViewParts()
      return []
    })
  }

  // 选中态：叶子=当前表，redis=当前 db 节点
  const selectedKeys = isRedis
    ? (redisDb >= 0 ? [String(redisDb)] : [])
    : (sel ? [nodeKey(sel.database, sel.schema, sel.table)] : [])

  /* ---------------- E2 视角：键 / 片段 / 持久化 / 恢复 ---------------- */

  // 视角键：connectionId 用连接身份（dbConnKey，与连接级安全带同一口径）。
  // 不用 tabId：tabId 每次开 tab 都会变，重启后视角就再也对不上了
  const viewIdOf = target => gridViewKey({
    connectionId: connKey,
    dbName: target && target.database,
    schema: target && target.schema,
    table: target && target.table
  })

  // 视角 → 请求片段。三件事都在这里做，调用方不再各拼一份：
  // 1) 条件体与绑定参数由 buildWhere 生成（值永远走占位符，列名走白名单+引用符）；
  // 2) 排序先按列白名单过一遍 —— 主进程会为"排序引用了不存在的列"直接抛错，
  //    那会让整页取不出来（列被删掉后旧视角就变成一张打不开的表）；
  // 3) 被丢弃/被截断的条件原样带出来给状态行用。
  const viewParts = (v) => {
    const cols = structureV2Ref.current.columns
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
   * 列显示设置（隐藏/列宽/列序）补丁。与 onViewChange 分开是因为：
   * 这些改动**不改变结果集**，不该走"应用 → 回第 1 页 → 重新取数"那条路
   * （拖个列宽就重新查一次库是不可接受的）。落盘照走 400ms 防抖。
   * @param {Object} patch { hiddenColumns?, columnWidths?, columnOrder? }
   */
  const patchViewColumns = (patch) => {
    const cur = viewRef.current
    applyView(normalizeView({
      conditions: cur.conditions,
      order: cur.order,
      pageSize: cur.pageSize,
      hiddenColumns: patch.hiddenColumns !== undefined ? patch.hiddenColumns : cur.hiddenColumns,
      columnWidths: patch.columnWidths !== undefined ? patch.columnWidths : cur.columnWidths,
      columnOrder: patch.columnOrder !== undefined ? patch.columnOrder : cur.columnOrder
    }))
  }

  /**
   * 选表时恢复视角。**必须在第一次取页之前完成**，否则会先闪一页全量。
   * @param {Object} target 目标表
   * @param {number} seq 点击序号（与 onSelectTree 的令牌一致）
   * @returns {Promise<boolean>} 是否仍然是"最新一次点击"（false 表示结果作废）
   */
  const restoreView = (target, seq) => {
    const key = viewIdOf(target)
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

  // 有效页大小：视角里存过就用它（换机器/重启后仍按上次的粒度看），
  // 否则回落全局配置。下限 10 与 getDbPageSize 一致，防脏数据把页大小写成 1
  const pageSizeOf = (v) => {
    const n = v && v.pageSize
    return Number.isInteger(n) && n >= 10 ? Math.min(n, 1000) : getDbPageSize()
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
    const q = opts.query || viewParts(v)
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
    const q = opts.query || viewParts(viewRef.current)
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

  const turnPage = (page) => {
    if (!sel) {
      return
    }
    loadQuery(sel, page, { keepLastPage: true })
  }

  // 列头点击：**只负责把这次点击写进 view.order**，方向与 3 列上限由 nextSortOrder 决定。
  // 视角条的 chips 走同一个函数，两处显示因此永远一致（各写一份必然打架）
  const onTableChange = (pagination, filters, sorter) => {
    if (!sel) {
      return
    }
    const field = sorter && sorter.field ? String(sorter.field) : ''
    if (!field) {
      return
    }
    applyView(normalizeView({
      ...viewRef.current,
      order: nextSortOrder(viewRef.current.order, field, 3)
    }))
    resetPageFilter()
    // 换排序/换页大小都不改结果集大小：有生效条件时那个"精确行数"仍然成立，
    // 清掉它只会让表头退回"近似"（而近似值在带条件时根本不适用）
    if (!viewParts(viewRef.current).where) {
      resetExactRows()
    }
    loadQuery(sel, 1)
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

  /**
   * 应用视角：回第 1 页并重新取数（先 count 再取页）。
   * SQL 模式下手写条件体**不经过 buildWhere**（字面量已内联），
   * 但一样要好主进程那一道闸门 —— findClauseProblem 只是提前禁用按钮，
   * 真正的拒绝在 assertSafeClause。
   */
  const onViewApply = () => {
    if (!sel) {
      return
    }
    resetPageFilter()
    resetExactRows()
    if (viewMode === 'sql') {
      const text = String(whereDraft || '').trim()
      const problem = findClauseProblem(text, dialect)
      if (problem) {
        message.error(e('dbViewBlocked'))
        return
      }
      const q = {
        where: text,
        whereParams: [],
        orderClauses: viewParts(viewRef.current).orderClauses
      }
      // 能结构化的顺手同步回 conditions：这样持久化的是**等价条件**，
      // 重启后还能恢复；结构化不了的就只在本次会话生效（不写盘）
      const parsed = text
        ? parseClause(text, structureV2Ref.current.columns, dialect)
        : { conditions: [] }
      if (parsed) {
        applyView(normalizeView({ ...viewRef.current, conditions: parsed.conditions }))
      }
      loadWithCount(sel, 1, { query: q })
      return
    }
    loadWithCount(sel, 1)
  }

  // 重置：清条件与排序、删持久化键（页大小是显示偏好，不属于"筛选"，不动）
  const onViewReset = () => {
    if (viewSaveTimer.current) {
      clearTimeout(viewSaveTimer.current)
      viewSaveTimer.current = null
    }
    if (viewKeyRef.current) {
      removeGridView(viewKeyRef.current)
    }
    countKeyRef.current = ''
    resetPageFilter()
    resetExactRows()
    const fresh = normalizeView({ pageSize: viewRef.current.pageSize })
    viewRef.current = fresh
    setView(fresh)
    setViewMode('builder')
    setWhereDraft('')
    setViewRejected([])
    setViewTruncated([])
    setViewBarSeq(n => n + 1)
    if (sel) {
      loadQuery(sel, 1)
    }
  }

  // 只读模式（默认开，书签 readOnly !== false）。
  // 用本地 state 而非直接读 tab：本组件是普通函数组件，父级不读 readOnly，
  // tab 变更后不会重渲染，开关会停留在旧状态。
  const [isReadonly, setIsReadonly] = useState(tab.readOnly !== false)

  // 页码跳转输入（MySQL 网格；redis 为游标模式，不支持任意跳页）
  const [jumpPage, setJumpPage] = useState(null)
  // redis 键详情分批渲染：每批 200，换键重置
  const [detailLimit, setDetailLimit] = useState(200)
  useEffect(() => {
    setDetailLimit(200)
  }, [redisKey])

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

  // 行定位列：MySQL 的 DESC 结果含 Key='PRI'，PG 由 describeTable 补 is_primary_key。
  // 取不到主键就不开单元格编辑，否则 UPDATE 的 WHERE 无法唯一定位行，可能一次改掉多行。
  const pkColumn = (structure.rows || [])
    .filter(r => String(r.Key || '').toUpperCase() === 'PRI' || r.is_primary_key === true)
    .map(r => r.Field || r.column_name)[0] || ''
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

  // 单元格 UPDATE（行内双击编辑与预览面板共用）：主进程按引擎参数化构造 UPDATE，
  // 前端只传主键值定位，不拼接 SQL
  const runCellUpdate = async (rowKey, col, value) => {
    const row = grid.rows[rowKey]
    if (!row || !sel) {
      return
    }
    // E1：production 连接上改数据要二次确认（带表名/列名/主键定位与影响行数）
    const ok = await confirmRowWrite({
      level: 'write',
      text: 'UPDATE ' + writeTargetLabel(sel) +
        ' SET ' + col + ' = ' + previewLiteral(value) +
        ' WHERE ' + pkColumn + ' = ' + previewLiteral(row[pkColumn]),
      note: e('dbAffectedRows').replace('{n}', '1')
    })
    if (!ok) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'updateCell', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      pkColumn,
      pkValue: row[pkColumn],
      column: col,
      value
    })
      .then(() => loadQuery(sel, grid.page))
      .catch(err => {
        setGrid(g => ({ ...g, loading: false }))
        onOpError(err)
      })
  }

  const submitEdit = () => {
    const target = editing
    setEditing(null)
    if (!target || !sel) {
      return
    }
    runCellUpdate(target.rowKey, target.col, editValue)
  }

  // ---- B1 行级 INSERT / DELETE（主进程占位绑定构造 SQL，前端只传值） ----

  // 行选择透传 antd rowSelection（仅主数据网格使用；redis 无行概念）。
  // columnWidth 必须显式给：表头是独立 table（scroll.y 生效后 header/body 两套），
  // `table-layout: fixed` 下列宽总和超过容器时，没有显式宽度的列会被压到 1px
  // → 表头勾选框被挤没、且表头文字相对数据整体左移一列。CSS 里的同宽只是兜底，
  // 真正决定 colgroup 的是这里（见 db-session.styl 的 .ant-table-selection-column）
  const rowSelection = {
    selectedRowKeys,
    onChange: keys => setSelectedRowKeys(keys),
    columnWidth: SEL_COL_W
  }

  // 插入行弹窗：列清单来自 describeTable 缓存（structure.rows）
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertCols, setInsertCols] = useState([])
  // 每列编辑态：{ text, isNull }；勾选 NULL 后输入框禁用
  const [insertValues, setInsertValues] = useState({})
  // A2 DDL 查看：仅 mysql 系（SHOW CREATE TABLE 兼容视图，零后端改动走 executeSql）；
  // PG 隐藏入口（无对应等价语句，用户拍板）
  const [ddl, setDdl] = useState({ open: false, loading: false, title: '', text: '' })

  const openInsertModal = () => {
    const cols = buildInsertFormColumns(structure.rows, tab.dbType)
    const init = {}
    cols.forEach(c => {
      init[c.name] = { text: '', isNull: false }
    })
    setInsertCols(cols)
    setInsertValues(init)
    setInsertOpen(true)
  }

  const setInsertCol = (name, patch) => {
    setInsertValues(v => ({
      ...v,
      [name]: { ...(v[name] || { text: '', isNull: false }), ...patch }
    }))
  }

  // 至少一列有值（或勾 NULL），且数值列文本均可转数字
  const canSubmitInsert = insertCols.some(c => {
    const st = insertValues[c.name] || {}
    return st.isNull || st.text !== ''
  }) && insertCols.every(c => {
    const st = insertValues[c.name] || {}
    if (st.isNull || st.text === '' || !c.isNumeric) {
      return true
    }
    return !Number.isNaN(Number(st.text))
  })

  const submitInsert = async () => {
    if (!sel || !canSubmitInsert) {
      return
    }
    const values = {}
    const colList = []
    const valList = []
    insertCols.forEach(c => {
      const st = insertValues[c.name] || {}
      if (st.isNull) {
        values[c.name] = null
        colList.push(c.name)
        valList.push('NULL')
      } else if (st.text !== '') {
        // 数值列转数字传参，其余按文本；留空列不传（交给数据库默认值/自增）
        values[c.name] = c.isNumeric ? Number(st.text) : st.text
        colList.push(c.name)
        valList.push(previewLiteral(values[c.name]))
      }
    })
    // E1：production 连接上插行要二次确认（取消则插入弹窗保持打开，值不丢）
    const ok = await confirmRowWrite({
      level: 'write',
      text: 'INSERT INTO ' + writeTargetLabel(sel) +
        ' (' + colList.join(', ') + ') VALUES (' + valList.join(', ') + ')',
      note: e('dbAffectedRows').replace('{n}', '1')
    })
    if (!ok) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'insertRow', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      values
    })
      .then(res => {
        setInsertOpen(false)
        message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
        // 行数变了 → 总数必须重算，否则"精确行数"会停在上一次的值上
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      })
      .catch(err => {
        setGrid(g => ({ ...g, loading: false }))
        onOpError(err)
      })
  }

  // 批量删除选中行：仅主键 IN 定位（无主键表不显示入口），二次确认后执行。
  // 原有 Popconfirm 保留（轻量、就地确认），production 连接再叠一层库名确认 ——
  // 前者是"点了会不会误触"，后者是"确认这是生产库"，两道语义不同
  const runDeleteRows = async () => {
    if (!sel || !pkColumn) {
      return
    }
    const pkValues = grid.rows
      .filter((_, i) => selectedRowKeys.includes(i))
      .map(r => r[pkColumn])
    if (!pkValues.length) {
      return
    }
    const shownPk = pkValues.slice(0, 10).map(previewLiteral).join(', ') +
      (pkValues.length > 10 ? ', …' : '')
    // 删行定为 dangerous：批量删除不可撤销，按钮应以危险色呈现
    const ok = await confirmRowWrite({
      level: 'dangerous',
      text: 'DELETE FROM ' + writeTargetLabel(sel) +
        ' WHERE ' + pkColumn + ' IN (' + shownPk + ')',
      note: e('dbAffected').replace('{n}', String(pkValues.length))
    })
    if (!ok) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'deleteRows', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      pkColumn,
      pkValues
    })
      .then(res => {
        message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      })
      .catch(onOpError)
  }

  // 反选：按当前页可见行（filteredRows 的 __rowKey）反转勾选
  const invertSelection = () => {
    setSelectedRowKeys(keys => {
      const cur = new Set(keys)
      return filteredRows
        .map(r => r.__rowKey)
        .filter(k => !cur.has(k))
    })
  }

  // 预览面板：选中单元格 + 保存
  const selectCell = (row, col) => {
    setSelectedCell({ rowKey: row.__rowKey, col })
  }

  // ---- E1 执行闸门（设计 §6.2 / §6.3 / §6.4）----

  // 每次执行都是一个新批次：scope 带自增序号，避免上一批的"已问过"吞掉本批弹窗
  const scopeSeqRef = useRef(0)
  const nextScope = kind => kind + ':' + (++scopeSeqRef.current)

  // 弹一次确认并等用户决定；取消/关闭都解析为 false（零执行）
  const askRiskConfirm = payload => {
    // 上一个闸门还没结束（用户连点两次"运行"）：先把旧的按取消处理，
    // 否则那次 runSql 的 promise 永远不 settle，一次执行挂在半路
    const prev = riskResolveRef.current
    if (prev) {
      riskResolveRef.current = null
      prev(false)
    }
    return new Promise(resolve => {
      riskResolveRef.current = resolve
      setRiskGate(payload)
    })
  }

  const settleRiskGate = ok => {
    const resolve = riskResolveRef.current
    riskResolveRef.current = null
    setRiskGate(null)
    if (resolve) {
      resolve(ok)
    }
  }

  // SQL 执行闸门：返回 true 才继续。
  // redis 不经过本闸门（Redis 写操作不在 E1 范围）；只读模式下执行入口本就被编辑器禁用、
  // 主进程白名单还会二次拦，这里不弹（验收 §6.5 第 5 条）
  const confirmSqlRisk = async (sql, database) => {
    const risk = classifySql(sql, tab.dbType)
    const state = guardRef.current
    const scope = nextScope('sql')
    const verdict = shouldConfirm({
      level: risk.level,
      production: isProduction,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need || !risk.statements.length) {
      return true
    }
    const ok = await askRiskConfirm({
      level: risk.level,
      requireDbName: verdict.requireDbName,
      dbName: database,
      statements: risk.statements,
      reasons: risk.reasons,
      // shouldConfirm 已经算好"为什么拦"（生产 / 首次写 / ddl 每次 / 高危每次 / 认不出），
      // 不传下去它就只是白算：用户看到的弹窗在五种情形下长得一模一样，只会无脑点
      // "仍要执行" —— 安全带退化成确认噪音。reason 与 reasons 是两件事：
      // reason = 「为什么要问你」，reasons = 「这条 SQL 凭什么被判成这个级别」
      reason: verdict.reason,
      // 静音只对"非生产的低风险写"开放：生产连接正是安全带要覆盖的场景
      allowMute: !isProduction && risk.level === 'write'
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // 行级写（单元格保存 / 插行 / 删行）在 production 连接上再过一道确认。
  // 复用同一个弹窗：它表达的是"执行前给人看"，不是 SQL 编辑器专属 UI
  const confirmRowWrite = async payload => {
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('row')
    const verdict = shouldConfirm({
      level: payload.level,
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need) {
      return true
    }
    const ok = await askRiskConfirm({
      level: payload.level,
      requireDbName: verdict.requireDbName,
      dbName: (sel && sel.database) || tab.dbName || '',
      statements: [{ text: payload.text, level: payload.level, firstKeyword: '' }],
      reasons: [payload.note],
      // 行级写同样要说清"为什么问你"：production 首次写 vs ddl 每次，用户的反应不一样
      reason: verdict.reason,
      allowMute: false
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // 生产标记 + 临时解除倒计时。bumpBypass 只是"到点重渲染"的触发器（值本身不用，
  // 故解构丢弃）；只有生效期才起定时器，常态不空转
  const [, bumpBypass] = useState(0)
  const bypassMinutes = isProduction
    ? bypassLeftMinutes(guardRef.current, connKey, Date.now())
    : 0
  useEffect(() => {
    if (!isProduction || bypassMinutes <= 0) {
      return undefined
    }
    const timer = setInterval(() => bumpBypass(v => v + 1), 30000)
    return () => clearInterval(timer)
  }, [isProduction, bypassMinutes])

  const toggleProductionBypass = () => {
    const state = guardRef.current
    const now = Date.now()
    if (isBypassed(state, connKey, now)) {
      clearBypass(state, connKey)
    } else {
      grantBypass(state, connKey, now)
      message.warning(
        e('dbRiskBypassOn').replace('{n}', String(Math.round(BYPASS_TTL_MS / 60000)))
      )
    }
    bumpBypass(v => v + 1)
  }

  const runSql = async () => {
    const sql = sqlText.trim()
    if (!sql) {
      return
    }
    // 当前库随语句下传（连接无默认库时后端先 USE 再执行，避免 No database selected）：
    // 优先树选中表所在库，无选中回退连接库名
    const database = (sel && sel.database) || tab.dbName || ''
    // 闸门必须在 executeSql 之前：取消 = 零执行（连 loading 都不该亮）
    if (!isRedis && !isReadonly) {
      const ok = await confirmSqlRisk(sql, database)
      if (!ok) {
        return
      }
    }
    setSqlResult(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', database ? { sql, database } : { sql })
      .then(res => {
        setSqlResult({
          loading: false,
          results: (res && res.results) || [],
          error: ''
        })
        // S3-C：执行历史只存本地（语句/引擎/库），失败也记录
        appendSqlHistory({
          sql,
          dbType: tab.dbType,
          dbHost: tab.dbHost,
          dbName: currentDbName,
          ok: true
        })
      })
      .catch(err => {
        setSqlResult({
          loading: false,
          results: [],
          error: err && err.message ? err.message : String(err)
        })
        appendSqlHistory({
          sql,
          dbType: tab.dbType,
          dbHost: tab.dbHost,
          dbName: currentDbName,
          ok: false
        })
      })
  }

  // ---- S3-B CSV 导出（只导当前可见结果集，全表流式导出属二期） ----

  // 文件名时间戳：yyyymmdd-hhmmss
  const tsName = () => {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  // A4 导出范围（同 A1 拍板语义）：有选中行 = 仅选中行；无选中 = 当前可见结果集
  const gridExportRows = () => selectedRowKeys.length
    ? grid.rows.filter((_, i) => selectedRowKeys.includes(i))
    : filteredRows

  // 导出列集 = 当前可见列（§7.6 验收 4：隐藏列不导出，导出按当前可见列 + 当前条件）。
  // 复制为 INSERT/TSV 走同一条：隐藏列意味着用户此刻不关心它，
  // 但真去读 row[k] 仍是原值 —— 格式化只发生在 renderCell，从不回流到这里
  const gridExportHeaders = () => grid.rows.length
    ? visibleColumnNames(Object.keys(grid.rows[0]))
    : []

  // 网格导出：列取当前可见列（grid.rows 不含 __rowKey）
  const exportGridCsv = () => {
    if (!grid.rows.length) {
      return
    }
    downloadCsv(
      `db-${sel.database}-${sel.table}-${tsName()}.csv`,
      gridExportHeaders(),
      gridExportRows()
    )
  }

  // 网格导出 JSON / SQL INSERT（共用 A1 语句生成核心）
  const exportGridAs = (kind) => {
    if (!grid.rows.length || !sel) {
      return
    }
    const headers = gridExportHeaders()
    const base = `db-${sel.database}-${sel.table}-${tsName()}`
    if (kind === 'json') {
      const rows = gridExportRows().map(r => {
        const o = {}
        headers.forEach(h => {
          o[h] = r && r[h] !== undefined ? r[h] : null
        })
        return o
      })
      downloadText(`${base}.json`, 'application/json;charset=utf-8', JSON.stringify(rows, null, 2))
      return
    }
    downloadText(
      `${base}.sql`,
      'text/plain;charset=utf-8',
      buildCopyStatements('insert', {
        table: sel.table,
        database: sel.database,
        headers,
        rows: gridExportRows(),
        pkColumn,
        quote: isPg ? 'double' : 'backtick'
      })
    )
  }

  // SQL 结果导出：列取 fields（缺省回退首行键），行取该结果集 rows
  const exportSqlCsv = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    const headers = (r.fields && r.fields.length)
      ? r.fields
      : Object.keys(rows[0])
    downloadCsv(`db-sql-result-${i + 1}-${tsName()}.csv`, headers, rows)
  }

  // SQL 结果导出 JSON：直接序列化该结果集 rows
  const exportSqlJson = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.json`,
      'application/json;charset=utf-8',
      JSON.stringify(rows, null, 2)
    )
  }

  // A1 复制为 INSERT/UPDATE/JSON/TSV：有选中行 = 仅选中行；无选中 = 当前可见
  // 结果集（含 T1 过滤，所见即所得）。列序以 grid.rows 首行键为准（无 __rowKey）
  const copyGridAs = (kind) => {
    if (!grid.rows.length || !sel) {
      return
    }
    const rows = selectedRowKeys.length
      ? grid.rows.filter((_, i) => selectedRowKeys.includes(i))
      : filteredRows
    const text = buildCopyStatements(kind, {
      table: sel.table,
      database: sel.database,
      headers: gridExportHeaders(),
      rows,
      pkColumn,
      quote: isPg ? 'double' : 'backtick'
    })
    copy(text)
  }

  // ---- S3-C SQL 执行历史（主进程文件环形 200 条，仅本地，跨启动稳定） ----

  const [sqlHistoryOpen, setSqlHistoryOpen] = useState(false)
  const [sqlHistory, setSqlHistory] = useState([])
  // 弹层尺寸：拖拽出来的，落盘在 config（dbSqlHistoryWidth/Height），跨启动稳定。
  // 初值读 config 时就夹一次，旧配置在更小的窗口上不会溢出
  const [histSize, setHistSize] = useState(
    () => readHistoryPanelSize(window.store._config, viewportSize())
  )
  // 拖拽期间要的是"最新的"尺寸而不是本次渲染闭包里的，用 ref 兜住
  const histSizeRef = useRef(histSize)
  // 当前悬浮/键盘选中的条目（预览栏与高亮共用同一份状态，
  // 否则鼠标预览和键盘走查会指向两行）
  const [histIndex, setHistIndex] = useState(0)
  const histListRef = useRef(null)
  // 300 条上限里找一条旧语句全靠滚动太费劲，给个只看语句文本的筛选框
  const [histFilter, setHistFilter] = useState('')
  const histList = useMemo(
    () => filterHistory(sqlHistory, histFilter),
    [sqlHistory, histFilter]
  )

  const openSqlHistory = (open) => {
    setSqlHistoryOpen(open)
    // 每次打开刷新列表，避免读陈旧快照（listSqlHistory 已异步，失败静默返回 []）
    if (open) {
      setHistIndex(0)
      setHistFilter('')
      listSqlHistory()
        .then(setSqlHistory)
        .catch(err => console.warn('load sql history failed:', err))
      // 列表一出现就给焦点：否则打开后按 ↑↓ 没反应（要先用鼠标点一下）
      setTimeout(() => {
        const el = histListRef.current
        if (el && el.focus) {
          el.focus()
        }
      }, 60)
    }
  }
  const pickSqlHistory = (item) => {
    setSqlText(item.sql)
    openSqlHistory(false)
  }
  const clearAllSqlHistory = () => {
    clearSqlHistory()
    setSqlHistory([])
    setHistIndex(0)
  }
  // 单条删除（悬浮 X / Delete 键）：先本地移除，点击即刻消失不等 IPC 回包；
  // 同一 (sql, ts) 再交给主进程落盘，失败不回滚——下次打开会重新出现，
  // 但比"点了没反应"好。不按下标删：列表可能处于筛选状态，下标对不上存储位置
  const removeOneSqlHistory = (item) => {
    if (!item) {
      return
    }
    const next = sqlHistory.filter(
      x => !(x.ts === item.ts && x.sql === item.sql)
    )
    if (next.length === sqlHistory.length) {
      return
    }
    setSqlHistory(next)
    // 删最后一条时原下标越界，夹一次；删中间的停在原下标（正好是原位置的下一项）
    setHistIndex(clampHistoryIndex(histIndex, filterHistory(next, histFilter).length))
    removeSqlHistory(item).catch(() => {})
    // 按钮随条目一起被移除，焦点会掉回 body，键盘走查就断了——还回列表
    setTimeout(() => {
      const el = histListRef.current
      if (el && el.focus) {
        el.focus()
      }
    }, 0)
  }

  // 拖拽调整尺寸：右边缘改宽、右下角改宽高。
  // 监听挂在 window 上而不是用 pointer capture——弹层在 portal 里，
  // 指针一移出弹层，元素上的事件就断了
  const startHistResize = axis => ev => {
    ev.preventDefault()
    ev.stopPropagation()
    const from = histSizeRef.current
    const x0 = ev.clientX
    const y0 = ev.clientY
    const both = axis === 'both'
    const move = e => {
      const next = clampPanelSize({
        width: both || axis === 'width' ? from.width + (e.clientX - x0) : from.width,
        height: both || axis === 'height' ? from.height + (e.clientY - y0) : from.height
      }, viewportSize())
      histSizeRef.current = next
      setHistSize(next)
    }
    // 拖拽时全局禁选中，否则会把弹层里的语句文本刷成选中态
    document.body.classList.add('db-hist-resizing')
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('db-hist-resizing')
      // 松手才落盘：拖动过程中每帧刷 config 会把主进程写配置打满
      window.store.setConfig(sizePatch(histSizeRef.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 键盘走查：↑↓ 移动、Enter 插入编辑器、Delete 删除该条、Esc 关闭
  const moveHist = delta => {
    const next = moveHistoryIndex(histIndex, histList.length, delta)
    setHistIndex(next)
    const el = histListRef.current && histListRef.current.children[next]
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }
  const onHistKeyDown = ev => {
    if (!histList.length) {
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      moveHist(ev.key === 'ArrowDown' ? 1 : -1)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      const item = histList[clampHistoryIndex(histIndex, histList.length)]
      if (item) {
        pickSqlHistory(item)
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      openSqlHistory(false)
    } else if (ev.key === 'Delete') {
      // 键盘删除当前选中项（与悬浮 X 同一路径）。不回退成 Backspace：
      // 那个键在 macOS 上是删除字符的肌肉记忆，放这里容易误删
      ev.preventDefault()
      removeOneSqlHistory(histList[clampHistoryIndex(histIndex, histList.length)])
    }
  }

  // 预览取"当前选中项"；列表刷新/筛选后下标可能越界，过一次夹取
  const histCur = histList.length
    ? histList[clampHistoryIndex(histIndex, histList.length)]
    : null
  // 筛选框里按 ↓ 把焦点交给列表（否则筛完还得再点一下才能用键盘选）
  const onHistFilterKeyDown = ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
      ev.preventDefault()
      const el = histListRef.current
      if (el && el.focus) {
        el.focus()
      }
    }
  }

  // Ctrl/Cmd+Enter 执行、Ctrl/Cmd+Shift+F 格式化：键位已移进编辑器 keymap
  // （CM6 里必须用 keymap 扩展，不能再挂 DOM onKeyDown）

  // A3 SQL 格式化：格式化后回填编辑器
  const formatSqlEditor = () => {
    const formatted = formatSql(sqlText)
    if (formatted) {
      setSqlText(formatted)
    }
  }

  // ---- Redis 键空间 ----

  const loadRedisKeys = (dbIndex, cursor, match, stack = []) => {
    setKeyList(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      dbIndex,
      cursor: String(cursor || '0'),
      pageSize: getDbPageSize(),
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

  // cursor/append 供 hash/set 服务端分页：append 时把新一页合并进已加载详情，
  // 不再把整个键一次性搬进内存
  const selectRedisKey = (key, cursor = '0', append = false) => {
    if (!append) {
      setRedisKey(key)
    }
    setDetailLoading(true)
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getKeyDetail', {
      dbIndex: redisDb,
      key,
      cursor: String(cursor || '0'),
      pageSize: REDIS_DETAIL_PAGE
    }).then(res => {
      const next = res || null
      setRedisDetail(prev => {
        if (!append || !prev || !next) {
          return next
        }
        return {
          ...next,
          fields: [...(prev.fields || []), ...(next.fields || [])],
          rows: next.type === 'hash'
            ? { ...(prev.rows || {}), ...(next.rows || {}) }
            : [...(prev.rows || []), ...(next.rows || [])]
        }
      })
      if (!append) {
        setTtlInput(res && res.ttl > 0 ? res.ttl : undefined)
      }
      setDetailLoading(false)
    }).catch(err => {
      if (!append) {
        setRedisDetail(null)
      }
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
      message.success(e('dbTtlUpdated'))
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
      message.success(e('dbDeleted'))
      setRedisKey('')
      setRedisDetail(null)
      loadRedisKeys(redisDb, '0', keyList.match)
      // 键数变了 → 同步刷新左侧各 db 的键个数
      loadTree()
    }).catch(err => {
      message.error(err && err.message ? err.message : String(err))
    })
  }

  // dataType 来自 structureV2.columns（与主进程校验同源）；SQL 结果集没有类型
  // 信息，调用方传 '' —— 此时只格式化"驱动已经给出 JS number"的值，字符串不猜
  const renderCell = (v, cellFilterKw = '', dataType = '') => {
    // antd 的 render(text, record, index) 会把整行对象传进第二参。
    // 只认字符串关键字：否则 hlNode 会拿对象去 indexOf，靠"[object Object]" 永不命中
    // 蒙混过关（能跑，但语义是错的）
    const filterKw = typeof cellFilterKw === 'string' ? cellFilterKw : ''
    let node
    if (v === null || v === undefined) {
      node = <span className='db-cell-null'>NULL</span>
    } else if (typeof v === 'object') {
      node = hlNode(highlightValue(JSON.stringify(v).slice(0, 200), keywordPatterns, themeConfig), kw)
    } else {
      // 数字/布尔也一并走高亮：关键字规则常写成 `\b(0|1)\b` 这类。
      // 格式化只改这一处显示文本：编辑框取原值（见下方 Input 的 value）、
      // 导出取原始行、UPDATE 拼原值，三条都不经过 formatCellValue
      node = hlNode(highlightValue(formatCellValue(v, dataType, formatLocale), keywordPatterns, themeConfig), kw)
    }
    // T1 本页过滤高亮用独立 class，避免被顶栏查找计数/导航误收
    return filterKw ? hlNode(node, filterKw, 'db-page-hit') : node
  }

  // 列宽按内容自适应（采样前 100 行取最长值）：固定 220 会让短值列
  // （如"一般"）出现大片空白；虚拟渲染是 fixed 布局，必须显式给宽。
  // 采样单独 memo：输入查找/过滤时不必重新扫描 100 行 × 所有列。
  const columnWidths = useMemo(() => {
    if (!grid.rows.length) {
      return {}
    }
    const sample = grid.rows.slice(0, 100)
    const widths = {}
    for (const k of Object.keys(grid.rows[0])) {
      const maxLen = Math.max(
        k.length,
        ...sample.map(r => {
          const v = r[k]
          return v === null || v === undefined ? 4 : String(v).length
        })
      )
      widths[k] = Math.min(360, Math.max(90, maxLen * 12 + 32))
    }
    return widths
  }, [grid.rows])

  // 列头排序箭头跟随 view.order（受控）：不写 sortOrder 的话，antd 会自己维护一份
  // 排序状态，chips 一改（比如重置）箭头就停在旧方向上
  const sortOrderOf = (k) => {
    const key = String(k).toLowerCase()
    const hit = (view.order || []).find(o => String(o.column).toLowerCase() === key)
    return hit ? (hit.desc === true ? 'descend' : 'ascend') : null
  }

  // 列类型表（小写键）：renderCell 的格式化与表头注释都查它。
  // 与 structureV2.columns 同源（getTableStructure），SQL 结果集查不到就是空
  const colTypeByName = useMemo(() => {
    const out = Object.create(null)
    for (const c of structureV2.columns || []) {
      if (c && typeof c.name === 'string' && c.name) {
        out[c.name.toLowerCase()] = String(c.dataType || '')
      }
    }
    return out
  }, [structureV2.columns])

  // 列注释表（小写键）：表头第二行小字。无注释的列不占高度
  const colCommentByName = useMemo(() => {
    const out = Object.create(null)
    for (const c of structureV2.columns || []) {
      if (c && typeof c.name === 'string' && c.name) {
        const comment = typeof c.comment === 'string' ? c.comment.trim() : ''
        if (comment) {
          out[c.name.toLowerCase()] = comment
        }
      }
    }
    return out
  }, [structureV2.columns])

  // 全部列（含被隐藏的）的当前顺序：columnOrder 里点名的列先按那个顺序排，
  // 没提到的列按结果集顺序接在后面 —— 新加的列不能因为旧视角没提它
  // 就被排到看不见的位置。列被删后旧视角里的名字自然消失，静默降级
  const orderedColumnNames = (keys) => {
    const byLower = new Map(keys.map(k => [String(k).toLowerCase(), k]))
    const ordered = []
    const used = new Set()
    for (const name of view.columnOrder || []) {
      const real = byLower.get(String(name).toLowerCase())
      if (real !== undefined && !used.has(real)) {
        ordered.push(real)
        used.add(real)
      }
    }
    for (const k of keys) {
      if (!used.has(k)) {
        ordered.push(k)
      }
    }
    return ordered
  }

  // 可见列 = 全部列的顺序再过滤 hiddenColumns。渲染与导出共用这一个函数，
  // 保证"屏幕上看到的列"与"导出/复制出的列"永远一致（§7.6 验收 4）
  const visibleColumnNames = (keys) => {
    const hidden = new Set((view.hiddenColumns || []).map(h => String(h).toLowerCase()))
    return orderedColumnNames(keys)
      .filter(k => !hidden.has(String(k).toLowerCase()))
  }

  // 列宽三源优先级：拖拽中 > 视角里记的（用户拖过） > 按内容自适应。
  // 视角里的空值/脏值已被 normalizeWidths 丢掉，落到这里就是 undefined
  const widthOf = (k) => {
    if (liveWidth && liveWidth.col === k) {
      return liveWidth.width
    }
    return view.columnWidths[k] || columnWidths[k] || 90
  }

  // 显示/隐藏一列。hiddenColumns 存原名（不转小写）：渲染时大小写不敏感匹配，
  // 但存进去的保持用户看到的写法，重置后手改配置文件也能认出来
  const toggleColumnVisible = (name, checked) => {
    const lower = String(name).toLowerCase()
    const cur = (view.hiddenColumns || []).filter(h => String(h).toLowerCase() !== lower)
    if (!checked) {
      cur.push(name)
    }
    patchViewColumns({ hiddenColumns: cur })
  }

  // 上/下移动一列（列显示弹层里的箭头）。移动的是**全部列**的顺序，
  // 不只是可见列：否则"把第 3 列移到最前"会因为前面藏着隐藏列而错位一格
  const moveColumn = (name, dir) => {
    if (!grid.rows.length) {
      return
    }
    const order = orderedColumnNames(Object.keys(grid.rows[0]))
    const i = order.indexOf(name)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) {
      return
    }
    const next = order.slice()
    next.splice(i, 1)
    next.splice(j, 0, name)
    patchViewColumns({ columnOrder: next })
  }

  // 列宽拖拽：mousedown 记起点 → mousemove 只改本地 liveWidth（不写视角）→
  // mouseup 一次性提交。拖拽中不碰 view 的理由见 liveWidth 声明处
  const startColResize = (ev, col) => {
    // 别触发表头排序（点击事件会冒泡到 th）
    ev.preventDefault()
    ev.stopPropagation()
    const startX = ev.clientX
    const startW = widthOf(col)
    const move = (e) => {
      const w = Math.max(60, Math.min(1200, Math.round(startW + e.clientX - startX)))
      liveWidthRef.current = { col, width: w }
      setLiveWidth({ col, width: w })
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.classList.remove('db-col-resizing')
      const cur = liveWidthRef.current
      liveWidthRef.current = null
      setLiveWidth(null)
      if (cur) {
        patchViewColumns({
          columnWidths: { ...viewRef.current.columnWidths, [cur.col]: cur.width }
        })
      }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.classList.add('db-col-resizing')
  }

  const columns = grid.rows.length
    ? visibleColumnNames(Object.keys(grid.rows[0])).map(k => {
      const dataType = colTypeByName[String(k).toLowerCase()] || ''
      const comment = colCommentByName[String(k).toLowerCase()] || ''
      return {
        title: (
          <span className='db-col-title'>
            <span className='db-col-name'>{k}</span>
            {
              comment
                ? <span className='db-col-comment' title={comment}>{comment}</span>
                : null
            }
            {/* 列宽拖拽手柄：贴右边沿，和排序点击互不重叠 */}
            <span
              className='db-col-resizer'
              onMouseDown={ev => startColResize(ev, k)}
              onClick={ev => ev.stopPropagation()}
            />
          </span>
        ),
        dataIndex: k,
        key: k,
        width: widthOf(k),
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf(k),
        // 单击选中 → 下方预览面板；双击命中区放在整个单元格（td）上：
        // 值短时后面的空白也能双击进编辑态，之前挂在文字 span 上，
        // 只有精确双击到字符才生效
        onCell: row => ({
          onClick: () => selectCell(row, k),
          onDoubleClick: () => canEditCell && startEdit(row, k),
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
              setSelectedCell(null)
              setEditing(null)
            }
          },
          className: 'db-cell-editable',
          title: canEditCell ? e('dbPreviewEditHint') : e('dbPreviewHint')
        }),
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
          return renderCell(v, pageFilterKw, dataType)
        }
      }
    })
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
        <div className='db-sql-result-tools'>
          {
            (r.rows || []).length
              ? (
                <Dropdown
                  menu={{
                    items: [
                      { key: 'csv', label: 'CSV' },
                      { key: 'json', label: 'JSON' }
                    ],
                    onClick: ({ key }) => key === 'json'
                      ? exportSqlJson(r, i)
                      : exportSqlCsv(r, i)
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
        </div>
        {
          r.affected !== undefined
            ? <div className='db-sql-affected'>{e('dbAffectedRows').replace('{n}', r.affected)}</div>
            : null
        }
        <DbGridTable
          size='small'
          columns={columnsForResult(r)}
          dataSource={((r && r.rows) || []).map((x, j) => ({ ...x, __rowKey: j }))}
          rowKey='__rowKey'
          pagination={false}
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
          label: e('dbResultN').replace('{n}', i + 1),
          children: renderOne(r, i)
        }))}
      />
    )
  }

  // T2/T3：树过滤只作用于已加载的 metadata，不重新请求后端。
  // 递归支持 PG 的「库 → schema → 表」：节点自身命中时保留全部子节点，
  // 仅子节点命中时只保留命中的分支。
  const visibleMetadata = useMemo(() => {
    if (!treeFilterKw) {
      return metadata
    }
    const hit = name => String(name || '').toLowerCase().includes(treeFilterKw)
    const filterNode = node => {
      const nodeHit = hit(node.name)
      if (isLeafNode(node)) {
        return nodeHit ? node : null
      }
      const children = (node.children || []).map(filterNode).filter(Boolean)
      if (!nodeHit && !children.length) {
        return null
      }
      return { ...node, children: nodeHit ? (node.children || []) : children }
    }
    return metadata.map(db => (
      isRedis
        ? (hit(db.name) ? db : null)
        : filterNode(db)
    )).filter(Boolean)
  }, [metadata, isRedis, treeFilterKw])
  const countTreeNodes = nodes => (nodes || []).reduce(
    (n, node) => n + 1 + countTreeNodes(node.children),
    0
  )
  const treeFilterNodeCount = countTreeNodes(visibleMetadata)
  // 树过滤命中用 db-tree-hit（不复用 db-kw-hit，避免顶栏查找计数误收）；
  // 再套一层顶栏查找高亮，保留两套高亮叠加
  const treeTitle = (text) => hlNode(
    hlText(text, treeFilterKw, 'db-tree-hit'),
    kw
  )
  // 进入过滤时记录原展开状态并展开命中的库 / schema；清空后还原（见下一个 effect）
  useEffect(() => {
    if (!treeFilterKw || isRedis) {
      return
    }
    if (treeExpandedBeforeFilter.current === null) {
      treeExpandedBeforeFilter.current = expandedKeys
    }
    const keys = []
    const walk = (db, nodes) => {
      (nodes || []).forEach(node => {
        if (isLeafNode(node)) {
          return
        }
        keys.push(nodeKey(db.name, node.name))
        walk(db, node.children)
      })
    }
    visibleMetadata.forEach(db => {
      keys.push(nodeKey(db.name))
      walk(db, db.children)
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

  // 树数据只在元数据/过滤/查找关键字变化时重建：
  // 输入页筛选、编辑单元格等状态变化不再递归重建整棵树。
  const treeData = useMemo(() => {
    // 非 redis 树节点递归：MySQL 为「库 → 表」，PG 为「库 → schema → 表」
    const toTreeChildren = (dbName, schema, nodes) => (nodes || []).map(node => {
      if (isLeafNode(node)) {
        // F0：视图与表在树里同名同形，不给标记就分不出哪个是视图（点开也看不出）。
        // 与 PG schema 的 S 标记共用一套视觉语言（小方块 + 单字母）
        return {
          title: node.type === 'view'
            ? (
              <span className='db-tree-view'>
                <span className='db-tree-view-mark'>V</span>
                {treeTitle(node.name)}
              </span>
              )
            : treeTitle(node.name),
          key: nodeKey(dbName, schema, node.name),
          isLeaf: true,
          // 类型随节点走：后续按钮门控（视图不可插入行）要它
          nodeType: node.type
        }
      }
      // PG schema 节点：S 标记便于与库 / 表区分；空 schema 也保留
      return {
        title: (
          <span className='db-tree-schema'>
            <span className='db-tree-schema-mark'>S</span>
            {treeTitle(node.name)}
          </span>
        ),
        key: nodeKey(dbName, node.name),
        children: toTreeChildren(dbName, node.name, node.children)
      }
    })

    if (isRedis) {
      return visibleMetadata.map(db => {
        const i = metadata.indexOf(db)
        return {
          // 键个数（来自 INFO keyspace）；空 db 显示 0，
          // 受管实例禁用 INFO 时后端不回 count → 此处不显示数字
          title: (
            <span className='db-tree-db'>
              <span className='db-tree-db-name'>{treeTitle(db.name)}</span>
              {
                typeof db.count === 'number'
                  ? <span className='db-tree-db-count'>{db.count}</span>
                  : null
              }
            </span>
          ),
          key: String(i),
          isLeaf: false
        }
      })
    }
    return visibleMetadata.map(db => ({
      // 不复用 .db-tree-db（space-between 供 redis 计数用），错误标记须紧邻库名
      title: (
        <span className='db-tree-db-title'>
          {treeTitle(db.name)}
          {
            // per-db 元数据降级标记：单库 SHOW TABLES 失败（权限等），
            // 库名保留可重试（点顶栏刷新重拉）
            db.error
              ? <Tooltip title={db.error}><span className='db-tree-db-err'>!</span></Tooltip>
              : null
          }
          {
            // T4：PG 非当前库给「连接」入口，新开临时 tab（不写书签、不回显密码）
            isPg && db.name !== currentDbName
              ? (
                <Button
                  type='link'
                  size='small'
                  className='db-tree-connect'
                  onClick={ev => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    setConnectDb(db.name)
                  }}
                >
                  {e('dbConnect')}
                </Button>
                )
              : null
          }
        </span>
      ),
      key: nodeKey(db.name),
      children: toTreeChildren(db.name, '', db.children)
    }))
  }, [visibleMetadata, isRedis, metadata, treeFilterKw, kw, isPg, currentDbName])

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

  // 每页行数切换：写 config.dbPageSize 并回第 1 页重新取数（mysql/redis 共用）
  const pageSizeOptions = [10, 20, 50, 100, 300, 500, 1000].map(n => ({
    value: n,
    label: e('dbPerPage').replace('{n}', n)
  }))
  const changePageSize = (v) => {
    window.store.setConfig({ dbPageSize: v })
    if (isRedis) {
      if (redisDb >= 0) {
        loadRedisKeys(redisDb, '0', matchInput)
      }
    } else if (sel) {
      resetPageFilter()
      if (!viewParts(viewRef.current).where) {
        resetExactRows()
      }
      applyView(normalizeView({ ...viewRef.current, pageSize: v }))
      loadQuery(sel, 1)
    }
  }
  const renderPageSizeSelect = () => (
    <Select
      size='small'
      className='db-grid-pagesize'
      // 显示的是**生效**的页大小（视角里存过就用它），与实际取数同源
      value={pageSizeOf(viewRef.current)}
      options={pageSizeOptions}
      onChange={changePageSize}
      // 弹层宽度随内容自适应：默认与触发框同宽会把 "1000 / page" 截断
      popupMatchSelectWidth={false}
      title={e('dbRowsPerPage')}
    />
  )

  // 页码快速跳转：totalRows 为服务端估算值，totalPages 同为近似
  // （redis 为 SCAN 游标模式，无总页数概念，不渲染页码标签/跳页）
  // 页大小同样以视角为准（视角里存过就用它），否则页码估算会与实际页大小脱节
  const dbPageSize = pageSizeOf(view)
  const estimatePages = sel && typeof grid.totalRows === 'number'
    ? Math.max(1, Math.ceil(grid.totalRows / dbPageSize))
    : null
  // 实测末页优先（估算常偏大）；估算偏小则仍用估算（hasMore 兜底前进）
  const totalPages = grid.lastPage || estimatePages
  const goPage = () => {
    const p = Math.max(1, Number(jumpPage) || 0)
    if (!p) {
      return
    }
    setJumpPage(null)
    turnPage(totalPages ? Math.min(p, totalPages) : p)
  }
  // 页码标签窗口：当前页 ±1，两端显示首/末页，超界用省略号
  const renderPageTags = () => {
    if (!totalPages || totalPages <= 1) {
      return null
    }
    const page = grid.page
    const from = Math.max(1, page - 1)
    const to = Math.min(totalPages, page + 1)
    const tags = []
    const pushTag = pn => tags.push(
      pn === page
        ? (
          <Button key={pn} size='small' type='primary' disabled={grid.loading}>
            {pn}
          </Button>
          )
        : (
          <Button key={pn} size='small' disabled={grid.loading} onClick={() => turnPage(pn)}>
            {pn}
          </Button>
          )
    )
    if (from > 1) {
      pushTag(1)
      if (from > 2) {
        tags.push(<span key='e1' className='db-grid-page-no'>…</span>)
      }
    }
    for (let pn = from; pn <= to; pn++) {
      pushTag(pn)
    }
    if (to < totalPages) {
      if (to < totalPages - 1) {
        tags.push(<span key='e2' className='db-grid-page-no'>…</span>)
      }
      pushTag(totalPages)
    }
    return <div className='db-grid-page-tags'>{tags}</div>
  }

  // S6：数据面等宽字体与终端统一 —— tab 级字体优先，其次全局终端字体；
  // 都没有时 React 忽略 undefined 自定义属性，CSS 侧回落 --font-mono
  const dbCodeFontStyle = {
    '--db-code-font': tab.fontFamily || window.store._config?.fontFamily
  }

  if (error) {
    return (
      <div
        className='db-session-wrap db-session-error'
        style={dbCodeFontStyle}
      >
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
      <div
        className='db-session-wrap'
        style={dbCodeFontStyle}
      >
        <div className='db-session-loading'>
          <Spin />
          <span className='db-session-loading-text'>{e('dbLoading')}</span>
        </div>
        <RemoteFloatControl isFullScreen={!!fullscreen} />
      </div>
    )
  }

  // PG 选中表显示 schema.table；MySQL 显示 database.table
  const tableLabel = sel
    ? (sel.schema ? `${sel.schema}.${sel.table}` : `${sel.database}.${sel.table}`)
    : ''
  const dataArea = (
    <div className='db-grid-area'>
      <div className='db-grid-head'>
        <span
          className='db-grid-title'
          title={tableLabel}
        >
          {tableLabel}
        </span>
        {
          sel
            ? (
              <span className='db-grid-total'>
                {
                  exactRows.value === null
                    ? (typeof grid.totalRows === 'number'
                        ? `${e('approxRows')}: ${grid.totalRows}`
                        : null)
                    : (
                      <>
                        {e('dbExactRows')}: {exactRows.value}
                        <Tag className='db-exact-tag'>{e('dbExactTag')}</Tag>
                      </>
                      )
                }
                {
                  // 精确值已拿到后不再显示入口；切换表/排序/页大小/刷新会重置
                  exactRows.value === null
                    ? (
                      <Button
                        type='link'
                        size='small'
                        className='db-exact-btn'
                        loading={exactRows.loading}
                        onClick={countExactRows}
                      >
                        {e('dbExact')}
                      </Button>
                      )
                    : null
                }
              </span>
              )
            : null
        }
        {
          sel
            ? (
              <>
                <Input
                  size='small'
                  className='db-page-filter'
                  value={pageFilter}
                  onChange={onPageFilterChange}
                  onKeyDown={ev => {
                    if (ev.key === 'Escape') {
                      ev.preventDefault()
                      resetPageFilter()
                    }
                  }}
                  placeholder={e('dbFilterPage')}
                  title={e('dbFilterPageHint')}
                  allowClear
                />
                {
                  pageFilterKw
                    ? (
                      <span className='db-page-filter-count'>
                        {filteredRows.length} / {grid.rows.length}
                      </span>
                      )
                    : null
                }
              </>
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
                {renderPageTags()}
                <span className='db-grid-page-no'>{e('dbPageLabel').replace('{n}', grid.page)}</span>
                <Button
                  size='small'
                  icon={<RightOutlined />}
                  disabled={!grid.hasMore || grid.loading}
                  onClick={() => turnPage(grid.page + 1)}
                />
                {/* 直接跳转到某页（totalPages 为估算值，跳页时钳制到估算末页） */}
                <InputNumber
                  size='small'
                  min={1}
                  max={totalPages || undefined}
                  value={jumpPage}
                  onChange={v => setJumpPage(v)}
                  onPressEnter={goPage}
                  className='db-grid-jump'
                  placeholder={totalPages ? '1-' + totalPages : e('dbPagePlaceholder')}
                />
                <Button size='small' disabled={!jumpPage} onClick={goPage}>
                  {e('dbGo')}
                </Button>
              </div>
              )
            : null
        }
        {
          sel ? renderPageSizeSelect() : null
        }
        {
          // E2-3b：列显示弹层（隐藏 / 列序）。只改视角的列字段，不重新取数
          sel && grid.rows.length
            ? (
              <Popover
                trigger='click'
                placement='bottomRight'
                content={
                  <div className='db-cols-pop'>
                    <div className='db-cols-pop-head'>{e('dbColumns')}</div>
                    {
                      // 弹层里列的是**可见列**的当前顺序：隐藏的列不该占着一行
                      // 箭头让用户够不着。顺序本身按全部列算（见 moveColumn）
                      visibleColumnNames(Object.keys(grid.rows[0])).map((name, i, arr) => (
                        <div key={name} className='db-cols-pop-row'>
                          <Checkbox
                            checked
                            onChange={ev => toggleColumnVisible(name, ev.target.checked)}
                          >
                            <span className='db-cols-pop-name' title={name}>{name}</span>
                          </Checkbox>
                          <span className='db-cols-pop-btns'>
                            <Button
                              size='small'
                              type='text'
                              icon={<UpOutlined />}
                              disabled={i === 0}
                              title={e('dbColMoveUp')}
                              onClick={() => moveColumn(name, -1)}
                            />
                            <Button
                              size='small'
                              type='text'
                              icon={<DownOutlined />}
                              disabled={i === arr.length - 1}
                              title={e('dbColMoveDown')}
                              onClick={() => moveColumn(name, 1)}
                            />
                          </span>
                        </div>
                      ))
                    }
                    {
                      // 隐藏列也在这里列出（置勾选态为 false），否则隐藏过的列
                      // 除了"重置视角"没有任何途径恢复
                      orderedColumnNames(Object.keys(grid.rows[0]))
                        .filter(name => (view.hiddenColumns || [])
                          .some(h => String(h).toLowerCase() === String(name).toLowerCase()))
                        .map(name => (
                          <div key={'h-' + name} className='db-cols-pop-row'>
                            <Checkbox
                              checked={false}
                              onChange={ev => toggleColumnVisible(name, ev.target.checked)}
                            >
                              <span className='db-cols-pop-name' title={name}>{name}</span>
                            </Checkbox>
                          </div>
                        ))
                    }
                    <div className='db-cols-pop-note'>{e('dbColumnsHint')}</div>
                  </div>
                }
              >
                <Tooltip title={e('dbColumns')}>
                  <Button size='small' icon={<MenuOutlined />} />
                </Tooltip>
              </Popover>
              )
            : null
        }
        {
          // E2-3b：数值/日期本地化开关（默认关）。只改 renderCell 的显示文本，
          // 编辑框/导出/UPDATE 都取原值 —— 见 db-format-value 模块头注释
          sel && grid.rows.length
            ? (
              <Tooltip title={e('dbFormatLocaleHint')}>
                <span className='db-format-locale'>
                  <Switch
                    size='small'
                    checked={formatLocale === 'os'}
                    onChange={on => {
                      const v = on ? 'os' : 'none'
                      setFormatLocale(v)
                      // 写补丁而不是整份配置：setConfig 是浅合并，
                      // 整份写回会盖掉并发改的其他键
                      window.store.setConfig({ [FORMAT_LOCALE_KEY]: v })
                    }}
                  />
                  <span className='db-format-locale-label'>{e('dbFormatLocale')}</span>
                </span>
              </Tooltip>
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
                onClick={() => {
                  resetPageFilter()
                  resetExactRows()
                  // 刷新按当前条件与页码重取；表数据可能变了，总数也要重算
                  countKeyRef.current = ''
                  loadWithCount(sel, grid.page)
                }}
              />
              )
            : null
        }
        {
          // A4 导出菜单：CSV/JSON/SQL INSERT，范围同 A1（选中为选中，无选中为当前页）
          sel && grid.rows.length
            ? (
              <Dropdown
                menu={{
                  items: [
                    { key: 'csv', label: 'CSV' },
                    { key: 'json', label: 'JSON' },
                    { key: 'sql', label: e('dbExportSql') }
                  ],
                  onClick: ({ key }) => key === 'csv'
                    ? exportGridCsv()
                    : exportGridAs(key)
                }}
              >
                <Tooltip title={e('dbExportCsv')}>
                  <Button size='small' icon={<DownloadOutlined />} />
                </Tooltip>
              </Dropdown>
              )
            : null
        }
        {
          // A1 复制为 SQL/JSON/TSV：有选中行 = 仅选中行；无选中 = 当前可见结果集
          sel && grid.rows.length
            ? (
              <Dropdown
                menu={{
                  items: [
                    { key: 'insert', label: e('dbCopyInsert') },
                    {
                      key: 'update',
                      // 无主键表无法安全定位行 → 禁用（提示复用 dbNoPrimaryKey 语义）
                      label: (
                        <span title={pkColumn ? undefined : e('dbNoPrimaryKey')}>
                          {e('dbCopyUpdate')}
                        </span>
                      ),
                      disabled: !pkColumn
                    },
                    { key: 'json', label: 'JSON' },
                    { key: 'tsv', label: e('dbCopyTsv') }
                  ],
                  onClick: ({ key }) => copyGridAs(key)
                }}
              >
                <Tooltip title={e('dbCopyAs')}>
                  <Button size='small' icon={<CopyOutlined />} />
                </Tooltip>
              </Dropdown>
              )
            : null
        }
        {
          // B1 添加行：只读隐藏；无主键表仍可添加（INSERT 不依赖主键）；
          // 视图除外——INSERT INTO 视图 两引擎都可能直接拒绝（PG 要 INSTEAD OF 触发器）
          sel && !isReadonly && sel.nodeType !== 'view' && grid.rows.length
            ? (
              <Tooltip title={e('dbAddRow')}>
                <Button
                  size='small'
                  icon={<PlusOutlined />}
                  onClick={openInsertModal}
                />
              </Tooltip>
              )
            : null
        }
        {
          // B1 反选：表头勾选框已能正常渲染（columnWidth 修复列宽塌陷）负责全选/取消，
          // 这里保留反选（无选中时等价全选，Tooltip 随状态切换）
          sel && !isReadonly && pkColumn && grid.rows.length
            ? (
              <Tooltip title={selectedRowKeys.length ? e('dbInvertSelection') : e('dbSelectAllPage')}>
                <Button
                  size='small'
                  icon={<DiffOutlined />}
                  onClick={invertSelection}
                />
              </Tooltip>
              )
            : null
        }
        {
          // B1 删除选中：门控 只读+主键（无主键无法安全定位行），常显禁用
          // （避免选中后按钮突然出现在反选之前、鼠标下方被误点，用户拍板）
          sel && !isReadonly && pkColumn && grid.rows.length
            ? (
              <Popconfirm
                title={
                  e('dbDeleteRowsConfirm')
                    .replace('{table}', sel.table)
                    .replace('{n}', String(selectedRowKeys.length))
                }
                onConfirm={runDeleteRows}
              >
                <Button size='small' danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>
                  {e('dbDeleteRows')}{selectedRowKeys.length ? `(${selectedRowKeys.length})` : ''}
                </Button>
              </Popconfirm>
              )
            : null
        }
      </div>
      {
        // 视角条单独一行（不塞进 .db-grid-head）：那一行已经有标题/总数/本页过滤/
        // 翻页/页大小/刷新/导出，再塞进来会把控件挤成一团
        sel && !isRedis
          ? (
            <DbViewBar
              // 换表与"重置"都要复位编辑中的行：本地行不回灌 props（见组件注释）。
              // 键跟着**当前展示的表**（sel）走，不跟"正在恢复的键"走 ——
              // 否则切换表的过程中视角条会先按新表重挂、却拿到旧表的条件
              key={(sel ? viewIdOf(sel) : '') + '#' + viewBarSeq}
              columns={structureV2.columns}
              dialect={dialect}
              view={view}
              mode={viewMode}
              draft={whereDraft}
              rejected={viewRejected}
              truncated={viewTruncated}
              loading={grid.loading || structureV2.loading}
              disabled={!structureV2.columns.length}
              onChange={onViewChange}
              onApply={onViewApply}
              onReset={onViewReset}
            />
            )
          : null
      }
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
      <DbSplitPane
        storageKey={CELL_SPLIT_KEY}
        top={
          <DbGridTable
            size='small'
            loading={grid.loading}
            columns={columns}
            dataSource={filteredRows}
            rowKey='__rowKey'
            pagination={false}
            onChange={onTableChange}
            rowSelection={rowSelection}
            locale={{
              emptyText: grid.error
                ? e('queryFailed')
                : pageFilterKw
                  ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={e('dbFilterNoPageMatch')}
                    >
                      <Button size='small' onClick={resetPageFilter}>{e('dbFilterClear')}</Button>
                    </Empty>
                    )
                  : (
                    <span className='db-empty-tip'>
                      {
                        // 有生效条件时，"表是空的"和"没有命中"是两件事。
                        // 说成"空表"会让用户去怀疑数据，而其实只是条件写窄了
                        view.conditions.length
                          ? e('dbViewNoMatch')
                          : e('tableEmpty')
                      }
                      {
                        view.conditions.length
                          ? ''
                          : (typeof grid.totalRows === 'number'
                              ? ` (${e('approxRows')}: ${grid.totalRows})`
                              : '')
                      }
                    </span>
                    )
            }}
          />
        }
        bottom={
          selectedCell && grid.rows[selectedCell.rowKey]
            ? (
              <DbValuePane
                title={selectedCell.col + ' - row ' + (Number(selectedCell.rowKey) + 1)}
                meta={panelValue.length + ' chars'}
                value={panelValue}
                patterns={keywordPatterns}
                themeConfig={themeConfig}
                editable={canEditCell}
                editDisabledTitle={isReadonly ? e('dbErrReadOnly') : e('dbNoPrimaryKey')}
                saving={grid.loading}
                onSave={v => runCellUpdate(selectedCell.rowKey, selectedCell.col, v)}
                onClose={() => setSelectedCell(null)}
              />
              )
            : (
              <div className='db-pane-empty'>
                <Empty description={e('dbSelectCell')} />
              </div>
              )
        }
      />
      {
        // B1 插入行弹窗：每列 文本输入 + NULL 勾选；自增列留空（占位提示），
        // 提交前数值列校验（非法输入按钮禁用，不再弹文案）
        insertOpen
          ? (
            <Modal
              open={insertOpen}
              title={e('dbInsertRowTitle').replace('{table}', tableLabel)}
              onCancel={() => setInsertOpen(false)}
              onOk={submitInsert}
              okButtonProps={{ disabled: !canSubmitInsert }}
              cancelText={e('cancel')}
              okText={e('default')}
              width={560}
            >
              <div className='db-insert-form'>
                {
                  insertCols.map(c => {
                    const st = insertValues[c.name] || { text: '', isNull: false }
                    const invalid = c.isNumeric && !st.isNull && st.text !== '' &&
                      Number.isNaN(Number(st.text))
                    return (
                      <div className='db-insert-row' key={c.name}>
                        <span className='db-insert-col' title={c.name}>
                          <span className='db-insert-col-name'>{c.name}</span>
                          {
                            c.isPk
                              ? <Tag className='db-pk-tag'>PK</Tag>
                              : null
                          }
                          {
                            c.isAutoInc
                              ? <Tag className='db-exact-tag'>{e('dbAutoInc')}</Tag>
                              : null
                          }
                          <span className='db-insert-col-type'>{c.type}</span>
                        </span>
                        <Input
                          size='small'
                          value={st.text}
                          disabled={st.isNull}
                          status={invalid ? 'error' : undefined}
                          placeholder={c.isAutoInc ? e('dbAutoInc') : ''}
                          onChange={ev => setInsertCol(c.name, { text: ev.target.value })}
                        />
                        <Checkbox
                          checked={st.isNull}
                          onChange={ev => setInsertCol(c.name, { isNull: ev.target.checked })}
                        >
                          NULL
                        </Checkbox>
                      </div>
                    )
                  })
                }
              </div>
            </Modal>
            )
          : null
      }
    </div>
  )

  // A-7：切换补全关键字大小写。只影响候选插入，不改编辑器里已有文本
  const toggleSqlKeywordCase = () => {
    const v = sqlKeywordCase === 'upper' ? 'lower' : 'upper'
    setSqlKeywordCase(v)
    window.store.setConfig({ dbSqlKeywordCase: v })
  }

  // A-8：翻转一项。写补丁而不是整份配置（setConfig 是浅合并，整份写回会盖掉并发改的其他键）
  const toggleSqlOpt = key => {
    const r = toggleSqlEditorOpt(sqlEditorOpts, key)
    if (!r) {
      return
    }
    setSqlEditorOpts(prev => ({ ...prev, [key]: r.value }))
    window.store.setConfig(r.patch)
  }

  const sqlOptsPop = (
    <div className='db-sql-opts-pop'>
      <div className='db-sql-opts-head'>{e('dbSqlOpts')}</div>
      {SQL_EDITOR_OPTIONS.map(o => (
        // 整行可点：Switch 自己 stopPropagation，否则"行点击 + 开关点击"会翻转两次
        <div
          key={o.key}
          className='db-sql-opt-row'
          onClick={() => toggleSqlOpt(o.key)}
        >
          <Switch
            size='small'
            checked={sqlEditorOpts[o.key] === true}
            onChange={() => toggleSqlOpt(o.key)}
            onClick={ev => ev.stopPropagation()}
          />
          <span className='db-sql-opt-label'>{e(o.label)}</span>
        </div>
      ))}
      <div className='db-sql-opts-note'>{e('dbSqlOptsNote')}</div>
    </div>
  )

  const sqlArea = (
    <div className='db-sql-area'>
      <Suspense fallback={<div className='db-sql-editor db-sql-editor-skeleton' />}>
        <SqlCodeEditor
          ref={sqlEditorRef}
          value={sqlText}
          onChange={setSqlText}
          onRun={runSql}
          onFormat={formatSqlEditor}
          readOnly={isReadonly}
          dbType={tab.dbType}
          placeholder={e('dbSqlPlaceholder')}
          keywordCase={sqlKeywordCase}
          tables={sqlTables}
          columns={sqlColumns}
          opts={sqlEditorOpts}
        />
      </Suspense>
      <div className='db-sql-bar'>
        <Button
          type='primary'
          size='small'
          loading={sqlResult.loading}
          onClick={runSql}
        >
          {e('dbRun')}
        </Button>
        {
          // A3 格式化：Ctrl/Cmd+Shift+F 同功能
          sqlText.trim()
            ? (
              <Button
                size='small'
                icon={<FormatPainterOutlined />}
                onClick={formatSqlEditor}
                title={e('dbFormatSql')}
              />
              )
            : null
        }
        <Popover
          placement='bottomLeft'
          trigger='click'
          open={sqlHistoryOpen}
          onOpenChange={openSqlHistory}
          content={
            <div
              className='db-history-pop'
              data-split={splitMode(histSize.width)}
              style={{ width: histSize.width, height: histSize.height }}
            >
              <div className='db-history-head'>
                <span className='db-history-title'>
                  {e('dbSqlHistory')}
                  {sqlHistory.length ? <span className='db-history-count'>{sqlHistory.length}</span> : null}
                </span>
                {
                  sqlHistory.length
                    ? (
                      <Popconfirm
                        title={e('dbSqlHistoryClearConfirm')}
                        onConfirm={clearAllSqlHistory}
                      >
                        <Button
                          type='text'
                          size='small'
                          icon={<DeleteOutlined />}
                          title={e('dbSqlHistoryClear')}
                        />
                      </Popconfirm>
                      )
                    : null
                }
              </div>
              {
                // 环形上限 200 条，找旧语句靠滚动太费劲；只匹配语句文本，不匹配库名/时间
                sqlHistory.length
                  ? (
                    <Input
                      className='db-history-filter'
                      size='small'
                      allowClear
                      value={histFilter}
                      placeholder={e('dbSqlHistoryFilter')}
                      onChange={ev => {
                        setHistFilter(ev.target.value)
                        setHistIndex(0)
                      }}
                      onKeyDown={onHistFilterKeyDown}
                    />
                    )
                  : null
              }
              {
                histList.length
                  ? (
                    <div className='db-history-body'>
                      <div
                        className='db-history-list'
                        ref={histListRef}
                        tabIndex={0}
                        role='listbox'
                        aria-label={e('dbSqlHistory')}
                        onKeyDown={onHistKeyDown}
                      >
                        {
                          histList.map((item, i) => (
                            <div
                              key={i}
                              role='option'
                              aria-selected={i === histIndex}
                              className={
                                'db-history-item' +
                                (i === histIndex ? ' is-active' : '')
                              }
                              onClick={() => pickSqlHistory(item)}
                              onMouseEnter={() => setHistIndex(i)}
                            >
                              <div className='db-history-sql'>{previewText(item.sql)}</div>
                              <div className='db-history-meta'>
                                <span className='db-history-time'>
                                  {new Date(item.ts).toLocaleString()}
                                </span>
                                <span className='db-history-src'>
                                  {dbTypeLabelMap[item.dbType] || item.dbType}
                                  {item.dbName ? ' · ' + item.dbName : ''}
                                </span>
                                {
                                  item.ok === false
                                    ? <span className='db-history-fail'>{e('dbSqlHistoryFailed')}</span>
                                    : null
                                }
                                <span className='db-history-ops'>
                                  <Button
                                    className='db-history-copy'
                                    type='text'
                                    size='small'
                                    icon={<CopyOutlined />}
                                    title={e('dbSqlHistoryCopy')}
                                    onClick={ev => {
                                      // 只复制，不插回编辑器：想复用长语句又不想动当前编辑内容
                                      ev.stopPropagation()
                                      copy(previewText(item.sql))
                                    }}
                                  />
                                  <Button
                                    className='db-history-del'
                                    type='text'
                                    danger
                                    size='small'
                                    icon={<CloseOutlined />}
                                    title={e('dbSqlHistoryDelete')}
                                    aria-label={e('dbSqlHistoryDelete')}
                                    onClick={ev => {
                                      // 必须挡住冒泡：不挡住会同时把这条语句插回编辑器
                                      ev.stopPropagation()
                                      removeOneSqlHistory(item)
                                    }}
                                  />
                                </span>
                              </div>
                            </div>
                          ))
                        }
                      </div>
                      {
                        // 预览栏：悬浮/键盘选中项的完整语句。列表里只给两行，
                        // 因为一条语句可能几十行，全展开会把列表挤没
                        histCur
                          ? (
                            <div className='db-history-preview'>
                              <div className='db-history-preview-head'>
                                <span>{e('dbSqlHistoryPreview')}</span>
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<CopyOutlined />}
                                  title={e('dbSqlHistoryCopy')}
                                  onClick={() => copy(previewText(histCur.sql))}
                                />
                              </div>
                              <pre className='db-history-preview-code'>{previewText(histCur.sql)}</pre>
                            </div>
                            )
                          : null
                      }
                    </div>
                    )
                  : (
                    <div className='db-history-empty'>
                      {sqlHistory.length ? e('dbSqlHistoryNoMatch') : e('dbSqlHistoryEmpty')}
                    </div>
                    )
              }
              <div className='db-history-note'>{e('dbSqlHistoryNote')}</div>
              {
                // 拖拽把手：右边缘改宽、右下角改宽高。
                // 放在 body 之外、绝对定位贴边，列表滚动条靠 body 的 padding 让开
                sqlHistory.length
                  ? (
                    <div
                      className='db-history-rz db-history-rz-r'
                      onPointerDown={startHistResize('width')}
                      title={e('dbSqlHistoryResize')}
                    />
                    )
                  : null
              }
              <div
                className='db-history-rz db-history-rz-c'
                onPointerDown={startHistResize('both')}
                title={e('dbSqlHistoryResize')}
              />
            </div>
          }
        >
          <Button
            size='small'
            icon={<HistoryOutlined />}
            title={e('dbSqlHistory')}
          />
        </Popover>
        {
          // A-7：补全关键字大小写开关（Aa 小写 / AA 大写）。Redis 无 SQL 语法，不显示
          !isRedis
            ? (
              <Button
                size='small'
                onClick={toggleSqlKeywordCase}
                title={e('dbSqlKeywordCase')}
              >
                {sqlKeywordCase === 'upper' ? 'AA' : 'Aa'}
              </Button>
              )
            : null
        }
        {
          // A-8：六项编辑器能力开关。Redis 没有 SQL 编辑器入口，不显示
          !isRedis
            ? (
              <Popover
                placement='bottomRight'
                trigger='click'
                content={sqlOptsPop}
              >
                <Button
                  size='small'
                  icon={<SettingOutlined />}
                  title={e('dbSqlOpts')}
                />
              </Popover>
              )
            : null
        }
        {
          isReadonly
            ? <Tag>{e('dbReadOnly')}</Tag>
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
      {
        // A2 DDL 弹窗：等宽字体展示 SHOW CREATE TABLE 结果，一键复制
        ddl.open
          ? (
            <Modal
              open={ddl.open}
              title={`${e('dbViewDdl')} - ${ddl.title}`}
              onCancel={() => setDdl(d => ({ ...d, open: false }))}
              footer={[
                <Button key='copy' size='small' onClick={() => copy(ddl.text)}>
                  {e('copy')}
                </Button>,
                <Button key='close' size='small' type='primary' onClick={() => setDdl(d => ({ ...d, open: false }))}>
                  {e('ok')}
                </Button>
              ]}
              width={720}
            >
              {
                ddl.loading
                  ? (
                    <div className='db-pane-empty'>
                      <Spin />
                    </div>
                    )
                  : (
                    <pre className='db-ddl-pre'>{ddl.text}</pre>
                    )
              }
            </Modal>
            )
          : null
      }
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
      // PG 主键列显示 PK 徽标；MySQL 沿用 DESC 的 Key=PRI 文本
      render: k === 'is_primary_key'
        ? v => (v === true ? <Tag className='db-pk-tag'>PK</Tag> : '')
        : renderCell
    }))
    : []

  // A2 DDL 查看：SHOW CREATE TABLE 兼容视图，零后端改动走 executeSql
  const fetchDdl = () => {
    if (!sel) {
      return
    }
    // 反引号内嵌反引号会破坏语句，标识符注入面剔除
    const db = String(sel.database).replace(/`/g, '')
    const tb = String(sel.table).replace(/`/g, '')
    setDdl(d => ({ ...d, open: true, loading: true, title: tb, text: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', {
      sql: 'SHOW CREATE TABLE `' + db + '`.`' + tb + '`'
    })
      .then(res => {
        const row = res && res.results && res.results[0] && res.results[0].rows
          ? res.results[0].rows[0]
          : null
        // SHOW CREATE TABLE 返回 Create Table；对视图返回 Create View
        const text = row
          ? (row['Create Table'] || row['Create View'] || '')
          : ''
        if (!text) {
          setDdl(d => ({ ...d, loading: false, text: e('dbDdlNotFound') }))
          return
        }
        setDdl(d => ({ ...d, loading: false, text }))
      })
      .catch(err => {
        setDdl(d => ({
          ...d,
          loading: false,
          text: err && err.message ? err.message : String(err)
        }))
      })
  }

  const structureArea = (
    <div className='db-struct-area'>
      {
        // A2 DDL 入口：仅 mysql 系显示
        !isPg
          ? (
            <div className='db-struct-tools'>
              <Button
                size='small'
                icon={<SearchOutlined />}
                loading={ddl.loading}
                onClick={fetchDdl}
              >
                {e('dbViewDdl')}
              </Button>
            </div>
            )
          : null
      }
      <DbGridTable
        size='small'
        loading={structure.loading}
        columns={structColumns}
        dataSource={structure.rows.map((r, i) => ({ ...r, __rowKey: i }))}
        rowKey='__rowKey'
        pagination={false}
      />
    </div>
  )

  const redisKeyColumns = [
    { title: e('dbKey'), dataIndex: 'name', key: 'name', ellipsis: true, render: renderCell },
    { title: e('type'), dataIndex: 'type', key: 'type', width: 90, render: renderCell },
    { title: e('dbTtl'), dataIndex: 'ttl', key: 'ttl', width: 90, render: renderCell }
  ]

  // list/zset 详情「加载更多」：detailLimit 分批渲染，避免一次进 DOM
  const renderMoreBtn = (total) => {
    if (!total || total <= detailLimit) {
      return null
    }
    return (
      <Button
        size='small'
        className='db-redis-more'
        onClick={() => setDetailLimit(l => l + 200)}
      >
        {e('dbLoadMore')} ({e('dbLeft').replace('{n}', total - detailLimit)})
      </Button>
    )
  }

  // hash/set 详情「加载更多」：走服务端 HSCAN/SSCAN 游标，只拉下一页
  const renderScanMore = (d) => {
    if (!d || !d.nextCursor || d.nextCursor === '0') {
      return null
    }
    const loaded = d.type === 'hash' ? (d.fields || []).length : (d.rows || []).length
    const left = typeof d.total === 'number' ? Math.max(0, d.total - loaded) : null
    return (
      <Button
        size='small'
        className='db-redis-more'
        loading={detailLoading}
        onClick={() => selectRedisKey(redisKey, d.nextCursor, true)}
      >
        {e('dbLoadMore')}
        {left === null ? '' : ` (${e('dbLeft').replace('{n}', left)})`}
      </Button>
    )
  }

  // 键详情：按类型渲染（string 文本框；hash/list/set/zset 网格）
  const renderRedisDetail = () => {
    const d = redisDetail
    let body = null
    if (!d) {
      body = detailLoading ? <Spin size='small' /> : null
    } else if (d.type === 'string') {
      // 统一值面板：键信息（type/ttl/删除）与高亮/格式化/复制/编辑全部收进 DbValuePane
      // 单栏展示（编辑保存走 redis setKey，只读模式被主进程拦截）
      body = (
        <DbValuePane
          title={redisKey}
          meta={
            e('dbTypeMeta').replace('{type}', d.type) + ' - ' +
            e('dbTtlMeta').replace('{ttl}', d.ttl > 0 ? d.ttl + 's' : e('dbNone')) + ' - ' +
            e('dbChars').replace('{n}', stringValue.length) +
            (stringTruncated ? ` (preview truncated, ${d.total} bytes total)` : '')
          }
          value={stringValue}
          patterns={keywordPatterns}
          themeConfig={themeConfig}
          editable={!isReadonly && !stringTruncated}
          editDisabledTitle={stringTruncated
            ? 'value too large, preview only (truncated)'
            : e('dbErrReadOnly')}
          extra={(
            <>
              <InputNumber
                size='small'
                min={0}
                placeholder={e('dbSeconds')}
                value={ttlInput}
                onChange={setTtlInput}
              />
              <Button size='small' disabled={isReadonly} onClick={applyTtl}>{e('dbSetTtl')}</Button>
              <Popconfirm title={e('dbDeleteKey')} onConfirm={delSelectedKey}>
                <Button size='small' danger disabled={isReadonly}>{e('dbDelete')}</Button>
              </Popconfirm>
            </>
          )}
          onSave={v => {
            window.pre.runGlobalAsync('dbClientOp', tabId, 'setKey', {
              dbIndex: redisDb,
              key: redisKey,
              value: v
            }).then(() => {
              message.success(e('saved'))
              selectRedisKey(redisKey)
            }).catch(err => onOpError(err))
          }}
        />
      )
    } else if (d.type === 'hash') {
      const hashFields = d.fields || []
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: e('dbField'), dataIndex: 'field', key: 'field', ellipsis: true, render: renderCell },
              { title: e('dbValue'), dataIndex: 'value', key: 'value', ellipsis: true, render: renderCell }
            ]}
            dataSource={hashFields.map((f, i) => ({ field: f, value: d.rows[f], __rowKey: i }))}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'list') {
      const listRows = (d.rows || []).slice(0, detailLimit)
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'index', key: 'index', width: 80, render: renderCell },
              { title: e('dbValue'), dataIndex: 'value', key: 'value', ellipsis: true, render: renderCell }
            ]}
            dataSource={listRows.map((v, i) => ({ index: i, value: v, __rowKey: i }))}
            rowKey='__rowKey'
          />
          {renderMoreBtn((d.rows || []).length)}
        </>
      )
    } else if (d.type === 'set') {
      const setRows = d.rows || []
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: e('dbMember'), dataIndex: 'member', key: 'member', ellipsis: true, render: renderCell }
            ]}
            dataSource={setRows.map((v, i) => ({ member: v, __rowKey: i }))}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'zset') {
      const rows = (d.rows || []).slice(0, detailLimit * 2)
      const list = []
      // zrange WITHSCORES 返回 [member, score, ...] 扁平数组
      for (let i = 0; i < rows.length; i += 2) {
        list.push({ member: rows[i], score: rows[i + 1], __rowKey: i })
      }
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: e('dbMember'), dataIndex: 'member', key: 'member', ellipsis: true, render: renderCell },
              { title: e('dbScore'), dataIndex: 'score', key: 'score', width: 120, render: renderCell }
            ]}
            dataSource={list}
            rowKey='__rowKey'
          />
          {renderMoreBtn(Math.ceil((d.rows || []).length / 2))}
        </>
      )
    } else {
      body = <span className='db-cell-null'>{e('dbUnsupportedType').replace('{type}', d.type)}</span>
    }
    return (
      <div className='db-redis-detail'>
        {
          // string 键的信息栏已并入 DbValuePane 头部（extra），避免出现两条重复栏
          // d 可能为 null（详情加载中），沿用原空值守卫
          d && d.type !== 'string'
            ? (
              <div className='db-redis-detail-bar'>
                <span className='db-grid-title db-redis-key-name'>{redisKey}</span>
                <span className='db-grid-page-no'>{e('dbTypeMeta').replace('{type}', d.type)}</span>
                <span className='db-grid-page-no'>{e('dbTtlMeta').replace('{ttl}', d.ttl > 0 ? d.ttl + 's' : e('dbNone'))}</span>
                <InputNumber
                  size='small'
                  min={0}
                  placeholder={e('dbSeconds')}
                  value={ttlInput}
                  onChange={setTtlInput}
                />
                <Button size='small' disabled={isReadonly} onClick={applyTtl}>{e('dbSetTtl')}</Button>
                <Popconfirm title={e('dbDeleteKey')} onConfirm={delSelectedKey}>
                  <Button size='small' danger disabled={isReadonly}>{e('dbDelete')}</Button>
                </Popconfirm>
              </div>
              )
            : null
        }
        {body}
      </div>
    )
  }

  const redisArea = (
    <div className='db-redis-area'>
      {
        redisDb < 0
          ? <Empty description={e('dbSelectDb')} />
          : (
            <>
              <div className='db-redis-bar'>
                <Input
                  size='small'
                  placeholder={e('dbMatchPlaceholder')}
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
                  {e('filter')}
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
                  <span className='db-grid-page-no'>{e('dbPageLabel').replace('{n}', keyList.stack.length + 1)}</span>
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
                {renderPageSizeSelect()}
              </div>
              <DbSplitPane
                storageKey={REDIS_SPLIT_KEY}
                top={
                  <DbGridTable
                    className='db-redis-keys'
                    size='small'
                    loading={keyList.loading}
                    columns={redisKeyColumns}
                    dataSource={keyList.rows.map((r, i) => ({ ...r, __rowKey: i }))}
                    rowKey='__rowKey'
                    pagination={false}
                    onRow={r => ({ onClick: () => selectRedisKey(r.name) })}
                    rowClassName={r => (r.name === redisKey ? 'db-row-selected' : '')}
                  />
                }
                bottom={
                  redisKey
                    ? renderRedisDetail()
                    : (
                      <div className='db-redis-detail db-redis-detail-empty'>
                        <Empty description={e('dbSelectKey')} />
                      </div>
                      )
                }
              />
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
          { key: 'data', label: e('dbDataTab'), forceRender: true, children: dataArea },
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
        {
          // E1 生产连接常驻标记：顶部工具条是唯一跨 tab（数据/SQL/结构）都可见的位置，
          // 徽标放这里才算"常驻提醒"；临时解除生效期间按钮显示剩余分钟
          isProduction
            ? (
              <Tooltip title={e('dbProductionHint')}>
                <span className='db-prod-flag'>{e('dbRiskProduction')}</span>
              </Tooltip>
              )
            : null
        }
        {
          isProduction
            ? (
              // 只读模式下这个按钮必须禁用：写操作本来就由主进程截断，
              // 允许"临时解除 5 分钟"是纯误导 —— 用户点完以为放开了，实际什么都没变，
              // 下次仍然被拦，于是连这个开关也不再被相信。
              // Tooltip 挂在 span 上而不是 Button 上：disabled 的按钮不派发鼠标事件，
              // 挂在按钮自己的 Tooltip 永远不触发（antd 的已知行为）。
              <Tooltip title={isReadonly ? e('dbRiskBypassReadonly') : ''}>
                <span className='db-prod-bypass-wrap'>
                  <Button
                    className={'db-prod-bypass' + (bypassMinutes > 0 ? ' is-on' : '')}
                    size='small'
                    disabled={isReadonly}
                    onClick={toggleProductionBypass}
                  >
                    {
                      bypassMinutes > 0
                        ? e('dbRiskBypassLeft').replace('{n}', String(bypassMinutes))
                        : e('dbRiskBypass')
                    }
                  </Button>
                </span>
              </Tooltip>
              )
            : null
        }
        {/* 系统库显示开关：默认显示，关闭即隐藏 information_schema 等（偏好持久化 config） */}
        <Tooltip title={`${e('systemSchemas')} — ${e('systemSchemasHint')}`}>
          <span className='db-sys-toggle'>
            <span className='db-sys-toggle-label'>{e('systemSchemas')}</span>
            <Switch
              size='small'
              checked={!hideSystemSchemas}
              onChange={toggleSys}
            />
          </span>
        </Tooltip>
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
          onClick={() => loadTree()}
        />
      </span>
      {/* 窗口级动作：与终端顶栏（SessionControl 右侧）同口径——查找 + 全屏入口在这里，
          退出全屏由页面内浮层 RemoteFloatControl 提供 */}
      <span className='db-head-actions'>
        {
          searchOpen
            ? (
              // 统一查找条（common/search-bar）：计数 (i/n) + 上一个/下一个 + 关闭
              <SearchBar
                value={searchText}
                onChange={ev => setSearchText(ev.target.value)}
                onClose={closeSearch}
                onPrev={() => goHit(-1)}
                onNext={() => goHit(1)}
                matchIndex={searchIndex}
                matchCount={searchHits}
                placeholder={e('search')}
              />
              )
            : null
        }
        {/* S1：查找/全屏走共享动作组件，与终端顶栏同位置同口径 */}
        <SessionBarActions
          searchOpen={searchOpen}
          onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          onFullscreen={() => window.store.toggleSessFullscreen(true)}
        />
      </span>
    </div>
  )

  return (
    <div
      className='db-session-wrap'
      style={dbCodeFontStyle}
    >
      {headBar}
      <div className='db-body' ref={bodyRef}>
        <div
          className='db-tree-panel'
          style={{ width: treeWidth }}
        >
          <div className='db-tree-filter'>
            <Input
              size='small'
              prefix={<SearchOutlined />}
              placeholder={e('dbFilterTree')}
              value={treeFilter}
              onChange={ev => setTreeFilter(ev.target.value)}
              allowClear
              aria-label={e('dbFilterTree')}
            />
          </div>
          {
            treeFilterKw
              ? (
                <div className='db-tree-filter-count'>
                  {treeFilterNodeCount} {e('dbFilterNodes')}
                </div>
                )
              : null
          }
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
                : treeFilterKw
                  ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={e('dbFilterNoTreeMatch')}
                    >
                      <Button size='small' onClick={() => setTreeFilter('')}>
                        {e('dbFilterClear')}
                      </Button>
                    </Empty>
                    )
                  : <Empty description={e('dbNoMetadata')} />
            }
          </Spin>
        </div>
        {/* 拖拽条：样式上用负 margin 让它骑跨在左侧容器右边框上，
            因此"拖的就是容器边缘"，而不是浮在面板与主区之间的独立竖条 */}
        <div
          className='db-tree-resizer'
          onMouseDown={startResize}
          title={e('dbDragResize')}
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
      {/* T4：PG 跨库连接确认（凭据沿用当前连接，弹窗不回显密码） */}
      <Modal
        open={!!connectDb}
        title={e('dbConnectOther')}
        okText={e('dbConnect')}
        cancelText={e('cancel')}
        onOk={connectOtherDb}
        onCancel={() => setConnectDb(null)}
      >
        <div className='db-connect-rows'>
          <div className='db-connect-row'><span>{e('host')}</span><span>{tab.dbHost}</span></div>
          <div className='db-connect-row'><span>{e('port')}</span><span>{tab.dbPort}</span></div>
          <div className='db-connect-row'><span>{e('username')}</span><span>{tab.dbUser}</span></div>
          <div className='db-connect-row'><span>{e('dbName')}</span><span>{connectDb}</span></div>
        </div>
        <Alert
          className='db-connect-hint'
          type='info'
          showIcon
          description={e('dbConnectOtherHint')}
        />
      </Modal>
      {/* E1 危险语句确认：受控 Modal（production 下要带库名输入框，Modal.confirm 拿不到状态） */}
      <DbDangerConfirm
        open={!!riskGate}
        level={riskGate ? riskGate.level : 'unknown'}
        production={isProduction}
        statements={riskGate ? riskGate.statements : []}
        reasons={riskGate ? riskGate.reasons : []}
        reason={riskGate ? (riskGate.reason || '') : ''}
        dbName={riskGate ? riskGate.dbName : ''}
        requireDbName={!!(riskGate && riskGate.requireDbName)}
        allowMute={!!(riskGate && riskGate.allowMute)}
        onCancel={() => settleRiskGate(false)}
        onConfirm={result => {
          // 静音只在用户点"仍要执行"时生效：取消不该被理解成"以后别再问"
          if (result && result.mute) {
            muteLowWrite(guardRef.current, connKey)
          }
          settleRiskGate(true)
        }}
      />
      {/* 全屏时页面内唯一的退出入口（与终端相同：右上角 ⋮ → 退出全屏） */}
      <RemoteFloatControl isFullScreen={!!fullscreen} />
    </div>
  )
})
