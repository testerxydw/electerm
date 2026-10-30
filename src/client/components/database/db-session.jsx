/**
 * Database browser session (phase2)
 * 左侧元数据树 + 右侧数据网格（MySQL）；连接生命周期：挂载建连、卸载断开
 * S5 将在此目录扩展 Redis 键空间形态，S4 增加 SQL 编辑器
 */

import { lazy, Suspense, useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { Tree, Table, Button, Alert, Empty, Spin, Tabs, Input, InputNumber, Tag, Popconfirm, Switch, Tooltip, Select, Modal, Popover, Checkbox, Dropdown, AutoComplete, Segmented, Progress } from 'antd'
import { ReloadOutlined, RightOutlined, SearchOutlined, DownloadOutlined, HistoryOutlined, DeleteOutlined, PlusOutlined, CopyOutlined, CloseOutlined, FormatPainterOutlined, DiffOutlined, SettingOutlined, MenuOutlined, UpOutlined, DownOutlined, UploadOutlined, EditOutlined, SwapOutlined, StarOutlined, CodeOutlined, NodeIndexOutlined, CheckOutlined, StarFilled, FolderOpenOutlined, FolderAddOutlined, ExportOutlined, ThunderboltOutlined, ColumnWidthOutlined, EyeOutlined, InfoCircleOutlined, DownOutlined as DownOutlinedIcon } from '@ant-design/icons'
import { auto } from 'manate/react'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import { refsStatic } from '../common/ref'
import DbConnError, { cleanDbError } from './db-conn-error'
import SessionBarActions from '../common/session-bar-actions'
import SearchBar from '../common/search-bar'
import DbSplitPane from './db-split-pane'
import DbValuePane from './db-value-pane'
import DbRefsPane from './db-refs-pane'
// H7a-4：Redis 服务器信息弹层（概览 / Keyspace / 原始 INFO）
import DbRedisInfoModal from './db-redis-info'
// H3b-3：ER 图（结构页工具条 → 全屏弹层；只读）
import DbErView from './db-er-view'
import DbStructureDiff from './db-structure-diff'
// H6a：命名参数（:name）填写面板。值以参数绑定发送，不拼进 SQL
import DbSqlParamsModal from './db-sql-params-modal'
import { ColHead, DbColMenu, useColMenu, useColWidths } from './db-col-resize'
// H1a-4（网格复用整合）：数据页 / SQL 结果页共用列工厂（差异全部参数化）
import { buildGridColumns, CELL_ELLIPSIS } from './db-grid-columns'
// H1a-4：工具行公共件 —— 分页条（数据页 / Redis 键列表 / SQL 结果三处同一结构）
// 与过滤输入（数据页 / SQL 结果同一外观，状态仍归各自页面）
import { DbGridPager, DbGridFilter } from './db-grid-pager'
import { DbCellMenu } from './db-cell-menu'
import { parseXinfoStream, parseXinfoGroups, parseXrangeEntries } from '../../common/db-redis-stream'
import { extractSqlParams, toPositional, countSqlStatements } from '../../common/db-sql-params'
// H1：行详情（SQL 结果 Modal 承载；H2 数据网格底部"行"页签复用同一渲染体）
import { DbRowDetail, DbRowDetailModal } from './db-row-detail'
import {
  fitColumnWidths,
  wideColumnWidth,
  cellText
} from '../../common/db-column-width'
import { buildRefItems } from './db-ref-utils'
import { isBinEnvelope } from './value-renderers'
import RemoteFloatControl from '../common/remote-float-control'
import { highlightValue, useKeywordPatterns } from './db-highlight'
import { hlText, hlNode, scanTextHits, cycleIndex } from './db-search'
import clone from '../../common/to-simple-obj'
import { downloadCsv, downloadText, buildCopyStatements, toTsv, toJsonl, toMarkdownTable } from '../../common/db-csv'
// H3a：数据字典（Markdown/CSV）纯函数，内容来自 structureV2 的 v2 契约
import { buildDataDictionary } from '../../common/db-dictionary'
import { summarizeColumn, summaryText } from '../../common/db-grid-summary'
import {
  planSameValue,
  planReplace,
  previewKeyList
} from '../../common/db-grid-replace'
import { copy } from '../../common/clipboard'
import { appendSqlHistory, listSqlHistory, clearSqlHistory, removeSqlHistory, exportSqlHistory as exportHistoryFile, SQL_HISTORY_MAX } from '../../common/db-sql-history'
// B 批：查询收藏（B-1~B-4）与 SQL 模板（B-3，同一份定义菜单/补全共用）
import {
  listFavorites,
  saveFavorite,
  removeFavorite,
  exportFavorites,
  importFavorites,
  listGroups,
  createFavoriteGroup,
  renameFavoriteGroup,
  deleteFavoriteGroup,
  normSql
} from '../../common/db-sql-favorite'
import { SQL_TEMPLATES, buildTemplateSql } from '../../common/db-sql-snippets'
import {
  clampPanelSize,
  readHistoryPanelSize,
  sizePatch,
  splitMode,
  moveHistoryIndex,
  clampHistoryIndex,
  previewText,
  filterHistory,
  filterFavorites
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
// E2-3b 命令面板：打分/分组是纯函数层（db-quick-open.js），组件只管展示与键盘
import DbQuickOpen from './db-quick-open'
// C 批：导出到文件（四步向导，走主进程流式导出）/ 导入 CSV/TSV（映射向导）
import DbExportDialog from './db-export-dialog'
import DbImportDialog from './db-import-dialog'
// U1c：无表选中时的数据页空态（连接摘要 + 快捷入口 + 最近表）
import DbWorkspaceHome from './db-workspace-home'
// D 批：EXPLAIN 执行计划弹窗（树/图/JSON 三视图 + SVG/PNG 导出）
import DbExplainDialog from './db-explain-tree'
// D 批：Redis 类型化写接口层（写失败/成功都刷新详情，绝不本地假更新）
import { redisWrite } from '../../common/db-redis-write'
// H7a：Redis 键树（平铺键名 → 分层节点的纯函数，边界处理全在那一层）
import {
  buildRedisKeyTree,
  collectFolderKeys,
  ancestorKeys,
  DEFAULT_SEPARATOR
} from '../../common/db-key-tree'
// H7b-3：批量删键的分批/预览（纯函数，零依赖；一批 500 只为进度可读）
import { chunkRedisKeys, delPreview, delPercent, delCommandText } from '../../common/db-redis-del'
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
import { formatCellValue, readFormatLocale, isBinaryType, isNumberType, FORMAT_LOCALE_KEY } from '../../common/db-format-value'
// H1：SQL 结果工具行的派生链（过滤 → 排序 → 切页）抽成纯函数，便于单测
import {
  filterRowIndexes, sortRowIndexes, sqlViewOf, patchSqlView, sqlSortOf, nextSqlSort,
  looksNumericColumn, visibleSqlKeys, toggleSqlHidden, SQL_FILTER_DEBOUNCE, SQL_SORT_BIG_ROWS
} from '../../common/db-sql-result'
import './db-session.styl'

// A-1：CM6 外壳懒加载 —— 只有这个 dynamic import 会牵出 @codemirror/*，
// 主 chunk 因此不含编辑器代码（构建断言见 src/build/bin/check-cm6-chunk.js）。
// 骨架屏沿用原 textarea 的尺寸与边框，避免首帧跳动。
const SqlCodeEditor = lazy(() => import('./db-sql-editor'))

const e = window.translate
// CELL_ELLIPSIS（截断列公共配置）随列工厂挪到 db-grid-columns.jsx，两页共用
// 每页行数：可经 config.dbPageSize 配置（10/20/50/100/200），默认 20；
// 服务端上限 1000 不变（mysql.js/redis.js），渲染侧上限见 DB_PAGE_SIZE_MAX
const DB_PAGE_SIZE_DEFAULT = 20
// 渲染侧硬上限：一页 200 行 × 宽表列数已经是可视区能处理的量级，
// 再大只是把 DOM/克隆成本线性放大（CDP 实测 1000 行/页是主要内存峰值来源之一）
const DB_PAGE_SIZE_MAX = 200
const getDbPageSize = () => {
  const v = Number(window.store._config && window.store._config.dbPageSize)
  return v >= 10 ? Math.min(v, DB_PAGE_SIZE_MAX) : DB_PAGE_SIZE_DEFAULT
}
// SQL 结果分页：一次执行返回的行全部留在 sqlResult 里（导出/复制要用全量），
// 但表格只渲染当前页，行键克隆也只做当前页 —— 整表渲染 + 全量克隆会让
// 30k 行结果在堆上翻倍（实测 +17MB）并挂出上万 DOM 节点
const SQL_RESULT_PAGE_SIZE = 50
// 结果页大小与数据页共用同一组候选；单独存 config.sqlResultPageSize，
// 改结果行数不影响数据网格的取数页大小
const DB_PAGE_OPTIONS = [10, 20, 50, 100, DB_PAGE_SIZE_MAX]
const dbPageSizeOptions = () => DB_PAGE_OPTIONS.map(n => ({
  value: n,
  label: e('dbPerPage').replace('{n}', n)
}))
const getSqlResultPageSize = () => {
  const v = Number(window.store._config && window.store._config.sqlResultPageSize)
  return Number.isInteger(v) && v >= 10 ? Math.min(v, DB_PAGE_SIZE_MAX) : SQL_RESULT_PAGE_SIZE
}
// 选中格的字符数只在"看不全"时才有意义：短值网格那一格本来就整行显示，
// 再挂一个"6 chars"是噪音。阈值取一格大致能显示的字符数（默认列宽 ~180px）。
// SQL 结果与 Redis 详情共用这一条 —— 两处都是"单击一格看完整值"
const VALUE_META_MIN = 60
const sqlPageIndex = (page, total, pageSize) => {
  const size = pageSize >= 10 ? pageSize : SQL_RESULT_PAGE_SIZE
  const pages = Math.max(1, Math.ceil(total / size))
  return Math.min(Math.max(1, page || 1), pages)
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
// H1a-4：SQL 结果"选中单元格 → 完整值面板"的展开高度持久化键（折叠时不读不写）
const SQL_VALUE_SPLIT_KEY = 'electerm-db-sql-value-split'
// Redis 详情"选中一格 → 值面板"的高度记忆键（与 SQL 那只分开：详情区里还有键信息栏，
// 同一条键会让两处互相把对方的比例带偏）
const REDIS_VALUE_SPLIT_KEY = 'electerm-db-redis-value-split'
// Redis hash/set 详情每页条数（后端 HSCAN/SSCAN 游标分页）
const REDIS_DETAIL_PAGE = 200
// 拿不到就出「—」，不冒充 0：INFO/慢日志/Stream 三处同一口径
// （0 在长度/组数/滞后量里都是合法值，混进"没拿到"就分不清）
const NA = '—'
const dash = v => (v === null || v === undefined ? NA : String(v))
// R1：键列表深跳阈值（页）。SCAN 无 offset，跳页要从 cursor=0 前向步进，
// 深跳前先弹确认，避免误触后长时间等待
const REDIS_KEY_JUMP_WARN_PAGES = 500
// H7a：键树一次全量遍历的键数上限与每轮 SCAN 的 COUNT。
// 上限存在的理由不是"怕慢"而是"不设上限时一个 500 万键的实例会把渲染进程整死"；
// 到量就停手并明说被截断，比卡住让用户自己猜强。COUNT 取后端允许的 1000 上限：
// 1 万键 = 10 轮 IPC，进度条也就有 10 格可跳。
const REDIS_TREE_MAX_KEYS = 10000
const REDIS_TREE_SCAN_COUNT = 1000
// 默认展开的键库规模上限：超过它就不自动展开任何目录。
// antd Tree 不传 height 时不是虚拟列表 —— 展开一个目录 = 把它的全部子节点一次性塞进 DOM，
// 而"整库只共享一个业务前缀、前缀下面挂上万键"正是最常见的键空间形状。
const REDIS_TREE_AUTO_EXPAND_KEYS = 500
// 键名 → 树节点路径。选中态在列表/树两边是同一个 `redisKey`（按名字，不按行下标），
// 树这边要知道"这个名字落在哪个节点"才能打勾并展开它那一支。
// 一次遍历建索引，比每次渲染都走树便宜（1 万键时是每次点击都走一遍的区别）。
const buildKeyPathIndex = (nodes) => {
  const map = new Map()
  const walk = (list) => {
    for (const n of list || []) {
      if (n.keyName) map.set(n.keyName, n.key)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return map
}
// 键列表「共几页」换算：SCAN 游标不透明，光看游标答不出总页数，但无过滤时
// INFO keyspace 的键数是现成的（左侧树已在用）。键数为 0 也算得出 1 页。
const redisKeyPagesOf = (count, pageSize) => (
  typeof count === 'number'
    ? Math.max(1, Math.ceil(count / Math.max(1, pageSize)))
    : 0
)
// B1 行选择列宽（与 db-session.styl 的 .ant-table-selection-column 同值）：
// 必须同时给 antd rowSelection.columnWidth（决定 colgroup）与 CSS（内边距），
// 只给 CSS 时表头那套 table 在列宽超容器后会把该列压成 1px
const SEL_COL_W = 36
// 树节点 key 用 JSON 数组编码，避免库/表名含 '.' 时拆解歧义
// F0：元数据契约 v2 起叶子多了 type:'view'。树的三处分支（过滤/展开/渲染）
// 原来只认 'table'，视图会被当成 schema 画成一个带 S 标记的空节点、点不开
// B2：叶子类型扩到非表对象（过程/函数/触发器/事件）—— 它们点开看 DDL、不进数据网格。
// 若仍按非叶子处理，会被画成带 S 标记的 schema 节点且点不开。
// 保持单行声明：db-page-tree-filter.spec.js 按 `^const isLeafNode = .+$` 抽取真实源码执行
const isLeafNode = node => ['table', 'view', 'procedure', 'function', 'trigger', 'event'].includes(node.type)
// B2：非表对象的单字母标记（与 view 的 V 共用一套视觉语言）
const DB_OBJECT_MARKS = {
  procedure: 'P',
  function: 'F',
  trigger: 'T',
  event: 'E'
}
const isDbObjectType = type => Object.prototype.hasOwnProperty.call(DB_OBJECT_MARKS, type)
// 分组节点标题走 i18n；组名本身是稳定英文 token（routines/triggers/events），
// 不随界面语言变化 —— 展开键与树过滤都按它匹配
const DB_GROUP_LABEL = {
  routine: 'dbRoutines',
  trigger: 'dbTriggers',
  event: 'dbEvents'
}
const nodeKey = (database, schema, table) => JSON.stringify([
  database,
  schema || '',
  table || ''
])

// U1c：空态"最近表"最多列几张 —— 再多就不是"快捷入口"，是另一棵树了
const HOME_TABLES_MAX = 8

// 列清单 v2 的空态：除 columns/foreignKeys 外，H3a 数据字典还要 indexes/表注释/
// 表类型/估算行数，所以整份契约一起留。只读常量，写入时用新对象覆盖
const EMPTY_STRUCTURE_V2 = {
  loading: false,
  columns: [],
  foreignKeys: [],
  indexes: [],
  type: 'table',
  comment: null,
  estimatedRows: null
}

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
  const [pagerH, setPagerH] = useState(0)
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
      // 非激活页签里 clientHeight / rect 高度都是 0。写回 0 会把 y 置 0 →
      // virtual=false → antd Table 退回全量渲染：3 万行页签切走后会挂出上万
      // DOM 节点、堆上多占几十 MB（CDP 实测），所以量到 0 时保留上次实测值
      const h = el.clientHeight
      if (h > 0) {
        setWrapH(h)
      }
      const hh = head ? Math.ceil(head.getBoundingClientRect().height) : 0
      if (hh > 0) {
        setHeadH(hh)
      }
      // 分页器占掉的纵向空间必须从 y 里扣掉，否则表体把分页器顶出可视区；
      // 结果不足一页时是真没有分页器，要如实写回 0
      const pager = el.querySelector('.ant-pagination')
      if (!pager) {
        setPagerH(0)
      } else {
        const ph = Math.ceil(pager.getBoundingClientRect().height)
        if (ph > 0) {
          setPagerH(ph)
        }
      }
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
  const y = wrapH > 0 && headH > 0 && wrapH > headH + pagerH ? wrapH - headH - pagerH : 0
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
      // H2：按"格子里看到的文本"匹配（cellText）。原来对象列走 String(v)
      // 得到 [object Object]，JSON 列的可见内容在过滤里根本查不到，
      // 右键"按此值过滤"落到 JSON 格上必然零命中
      return cellText(r[k])
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
  // F1：foreignKeys（本表外键）一并保留，供「关联」侧栏的"被引用父行"方向使用
  // H3a：indexes/comment/type/estimatedRows 也留在这里，数据字典导出与结构页同源
  const [structureV2, setStructureV2] = useState(EMPTY_STRUCTURE_V2)
  // 查询路径（loadPage/onColSort 里的异步回调）要读到最新列清单，state 在闭包里会过期
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
  // B3-1 列聚合：跟随"选中单元格所在列"算当前显示行的 count/sum/avg/min/max。
  // 依赖 filteredRows（不是 grid.rows）—— 页内过滤后用户看到的行才是"这一屏"，
  // 用原始页会给出与屏幕不一致的合计。selectedCell 为空时不显示。
  const cellSummary = useMemo(
    () => (selectedCell && selectedCell.col
      ? summarizeColumn(filteredRows, selectedCell.col)
      : null),
    [filteredRows, selectedCell]
  )
  // A-5：列补全用的列索引（由 listColumns 整成 {表名: 列[]}）
  const [sqlColumns, setSqlColumns] = useState({})
  // 面板值 = 选中单元格的原始值（编辑草稿在 DbValuePane 内部）。
  // F3：保留原始类型——二进制列现在是 __bin 信封对象，String() 会退化成
  // "[object Object]"，所以这里不做 String()，由 DbValuePane 按类型呈现。
  const panelValue = selectedCell && grid.rows[selectedCell.rowKey]
    ? grid.rows[selectedCell.rowKey][selectedCell.col]
    : ''
  // 选型侧栏 / 呈现器需要的列元数据（isBinary 等），按列名定位
  const panelColumn = useMemo(() => {
    if (!selectedCell) {
      return {}
    }
    const c = (structureV2.columns || []).find(col => col && col.name === selectedCell.col)
    return c || {}
  }, [selectedCell, structureV2.columns])
  // 元信息描述：二进制信封显示字节数，其余按字符长度。对象值（JSON 列）先转文本，
  // 与网格量宽同一来源；挂在选中值上 memo，避免每次重渲都序列化一遍大 JSON
  const panelMeta = useMemo(() => {
    if (isBinEnvelope(panelValue)) {
      return panelValue.__bin.size + ' bytes'
    }
    if (panelValue === null || panelValue === undefined) {
      return ''
    }
    return cellText(panelValue).length + ' chars'
  }, [panelValue])

  // ---- F1 外键引用侧栏（设计 §8） ----
  // 反向引用（"哪些表指向本表"）按 表+列 懒拉取并缓存：
  // 换单元格但列不变时复用结果，避免每次点单元格都打一次 catalog
  const [refInfo, setRefInfo] = useState({ loading: false, references: [], degraded: false })
  const refsKeyRef = useRef('')
  useEffect(() => {
    if (isRedis || !sel || !selectedCell || !selectedCell.col) {
      refsKeyRef.current = ''
      return undefined
    }
    const key = [sel.database || '', sel.schema || '', sel.table || '', selectedCell.col].join('\u0000')
    if (refsKeyRef.current === key) {
      return undefined
    }
    refsKeyRef.current = key
    let cancelled = false
    setRefInfo({ loading: true, references: [], degraded: false })
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getReferences', {
      database: sel.database,
      schema: sel.schema || '',
      table: sel.table,
      columns: [selectedCell.col]
    }).then(res => {
      if (cancelled) {
        return
      }
      setRefInfo({
        loading: false,
        references: (res && Array.isArray(res.references)) ? res.references : [],
        degraded: !!(res && res.degraded)
      })
    }).catch(() => {
      if (cancelled) {
        return
      }
      // 目录查询失败等同降级：页签隐藏 + 一行提示，不影响主流程
      setRefInfo({ loading: false, references: [], degraded: true })
    })
    return () => {
      cancelled = true
    }
  }, [isRedis, sel, selectedCell && selectedCell.col, tabId])
  // 两方向的引用项：父行（本表外键 → 父表）本地可算；子记录依赖 refInfo
  const refItems = useMemo(() => {
    if (isRedis || !selectedCell || !sel) {
      return []
    }
    const row = grid.rows[selectedCell.rowKey]
    if (!row) {
      return []
    }
    return buildRefItems({
      column: selectedCell.col,
      row,
      foreignKeys: structureV2.foreignKeys || [],
      references: refInfo.references,
      database: sel.database,
      schema: sel.schema || '',
      dialect
    })
  }, [isRedis, selectedCell, grid.rows, structureV2.foreignKeys, refInfo.references, sel, dialect])
  // 页签可见性：本表有外键（本地 FK 即刻可判）或反向引用非空时显示；
  // 两者皆无 → 隐藏；降级（目录不可读）且无本地外键 → 隐藏 + 一行提示
  const showRefTab = !isRedis && !!selectedCell && (
    (structureV2.foreignKeys || []).length > 0 ||
    refInfo.references.length > 0 ||
    refInfo.degraded
  )
  // T1 过滤变化会改变可见行：清掉选中/编辑，避免原索引指向另一行
  const resetPageFilter = () => {
    setPageFilter('')
    setSelectedCell(null)
    setEditing(null)
    // 右键菜单的项握着行快照与行下标：换表/清过滤后原来的行可能已经不在
    setCellMenu(null)
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
    // 整次执行的耗时 ms（主进程回传，多结果集共享；旧后端无此字段时为 null）
    elapsedMs: null,
    error: ''
  })
  // SQL 结果分页：每个结果集各自记住页码（多语句分栏时互不影响）
  const [sqlPages, setSqlPages] = useState({})
  // 跳页输入的草稿值（同样按结果集下标分栏）：分页条从 antd Pagination 换成
  // 共用 DbGridPager 后，跳页框的草稿归本组件持有
  const [sqlJumpDraft, setSqlJumpDraft] = useState({})
  // H1：每个结果集各自的视图状态（过滤 + 排序，列显隐随后接在同一份状态上）。
  // 与 sqlPages 同层、按 results 下标存 —— 多结果集分栏时"结果 1 筛过的词"
  // 不该影响"结果 2"
  const [sqlViews, setSqlViews] = useState({})
  // 输入框的即时值与生效值分开：只有防抖到点的才写进 sqlViews，
  // 否则 1 万行结果每敲一个字符就全量扫一遍
  const [sqlFilterDraft, setSqlFilterDraft] = useState({})
  const sqlFilterTimers = useRef({})
  // 上一次真正提交的过滤词。判据只能记在 ref 里：定时器回调里读到的 sqlViews
  // 是注册那一次的闭包，拿它比"变没变"会比出假结论
  const sqlFilterCommitted = useRef({})
  const onSqlFilterInput = (i, v) => {
    setSqlFilterDraft(prev => ({ ...prev, [i]: v }))
    const timers = sqlFilterTimers.current
    clearTimeout(timers[i])
    timers[i] = setTimeout(() => {
      const committed = sqlFilterCommitted.current
      if (committed[i] !== v) {
        // 换词就把页码写回第 1 页。不写的话页码只是被 sqlPageIndex **读时夹住**，
        // 实测很别扭：在第 6 页筛到 2 行（分页器没了、看着像只有这一屏），清空过滤
        // 却直接跳到第 1001 行 —— 用户不知道自己是"停在旧页码上"的
        committed[i] = v
        setSqlPages(prev => ({ ...prev, [i]: 1 }))
      }
      setSqlViews(prev => patchSqlView(prev, i, { filter: v }))
    }, SQL_FILTER_DEBOUNCE)
  }
  useEffect(() => {
    const timers = sqlFilterTimers.current
    return () => Object.values(timers).forEach(clearTimeout)
  }, [])
  // 表头点击：升序 → 降序 → 无排序。受控排序只改视图状态，不重新执行 SQL；
  // 换排序同样回第 1 页 —— 停在第 8 页看"换了个顺序的第 8 页"没法判断排序生效没有
  const onSqlSort = (i, key) => {
    const cur = sqlViewOf(sqlViews, i).sort
    const order = nextSqlSort(cur && cur.key === key ? cur.order : null)
    setSqlViews(prev => patchSqlView(prev, i, { sort: order ? { key, order } : null }))
    setSqlPages(prev => ({ ...prev, [i]: 1 }))
  }
  // 列显隐：勾掉最后一列的请求被 toggleSqlHidden 拒掉（返回 null）时原样保留。
  // 只改这一份视图状态，不重新执行 SQL，也不动过滤/排序
  const onSqlToggleCol = (i, keys, key, checked) => {
    const hidden = toggleSqlHidden(keys, sqlViewOf(sqlViews, i).hidden, key, checked)
    if (hidden) {
      setSqlViews(prev => patchSqlView(prev, i, { hidden }))
    }
  }
  // H1a-4：SQL 结果里选中的单元格 { rs, col, rowKey }。rowKey 是结果内的**绝对**
  // 下标（分页只切片不改下标），所以翻到第 2 页再翻回来，面板指的还是原来那一行。
  // SQL 结果是只读视图：不做行内编辑，也不写回
  const [sqlCell, setSqlCell] = useState(null)
  // 单元格右键菜单（全站单例浮层）：onCell 只写落点，菜单项由各自的
  // openSqlCellMenu / openDataCellMenu 按上下文生成。数据页与 SQL 结果共用
  // 同一份 state —— 两页不会同时可见，没必要各挂一个浮层
  const [cellMenu, setCellMenu] = useState(null)
  // H1 行详情：右键菜单"查看行详情"打开的那一行。存行对象快照而不是下标 ——
  // 行对象只在这一格被点击时生成一次，翻页/过滤不会把它指向别的行
  const [sqlRowDetail, setSqlRowDetail] = useState(null)
  // 页大小存 config（与数据页同一组候选），改后回第 1 页
  const sqlPageSize = getSqlResultPageSize()
  const changeSqlPageSize = v => {
    window.store.setConfig({ sqlResultPageSize: v })
    setSqlPages({})
  }
  // 新结果（含失败清空）一到位就回第 1 页；翻页只切片，不重新执行
  // H1a-4：同时清掉选中单元格 —— 老结果的行下标对新结果集没有意义（指错行比
  // 面板空着更糟）；面板跟着选中一起收起，不留半屏空气
  // H1：过滤也一起清 —— 老结果的筛词对新结果集基本等于"看起来空了"，
  // 而且输入框留着旧词会让人以为新结果真的只有这么几行
  useEffect(() => {
    setSqlPages({})
    setSqlCell(null)
    setSqlViews({})
    setSqlFilterDraft({})
    // 右键菜单也一起收：菜单项闭包握着旧结果的行对象与结果集下标，
    // 新结果到位后再点就会抄旧行/筛错结果集
    setCellMenu(null)
    // 行详情同样收：新结果的行对象快照已经不属于当前结果集
    setSqlRowDetail(null)
    sqlFilterCommitted.current = {}
  }, [sqlResult.results])

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
  // R1：键列表跳页输入（页码，1 基）与过期请求令牌
  const [keyJumpInput, setKeyJumpInput] = useState('')
  const keyJumpTokenRef = useRef(0)
  // H7b-3：键列表多选存**键名**而不是行下标 —— 翻页/改过滤后下标全指向别的键
  const [redisKeySel, setRedisKeySel] = useState([])
  // 批量删键弹层：keys 是"点开时冻结的那批"，done 只由 unlink 的实际删除数累加
  const [redisDel, setRedisDel] = useState({ open: false, keys: [], running: false, done: 0, error: '' })
  // H7a：键树视图。列表走游标分页（一页一次 IPC），树必须看到全部键名，
  // 所以是"渲染侧驱动的多轮 SCAN"（keysOnly 只要名字，不发 TYPE/TTL）。
  // scanned 是进度（已收唯一键数），truncated 表示撞到 REDIS_TREE_MAX_KEYS 就停手。
  const [redisView, setRedisView] = useState('list')
  const [treeSep, setTreeSep] = useState(DEFAULT_SEPARATOR)
  const [keyTree, setKeyTree] = useState({
    loading: false,
    scanned: 0,
    total: 0,
    truncated: false,
    names: [],
    match: '*'
  })
  const [treeExpanded, setTreeExpanded] = useState([])
  // 同一把令牌管"取消 + 丢弃在途响应"：主进程没有 SCAN 中断通道（dbClientOp 只有
  // 单次超时），能做的就是在渲染侧不再采纳这一轮之后的结果
  const keyTreeTokenRef = useRef(0)
  // H7a-4：服务器信息（INFO）。只在打开弹层时拉一次 + 手动刷新按钮再拉，不做轮询：
  // INFO 要遍历实例统计，常驻轮询等于给每台连着的 Redis 挂了个定时任务，
  // 而这份数据没人盯着看。令牌管"连点刷新时旧响应不覆盖新响应"。
  const [redisInfo, setRedisInfo] = useState({ open: false, loading: false, text: '', error: '' })
  const redisInfoTokenRef = useRef(0)
  // H3b-3：ER 图。图是整个库/schema 的一张快照，与"当前在看哪张表"无关，
  // 所以打开时按当前库拉一次即可；令牌管"连点刷新时旧响应不覆盖新响应"
  const [er, setEr] = useState({ open: false, loading: false, error: '', graph: null })
  const erTokenRef = useRef(0)
  // H4：结构对比。两张表的选择、取数与差异状态都在弹层里；这里只提供表清单、
  // 取数通道和"从哪张表开始比"
  const [structDiff, setStructDiff] = useState({ open: false, base: null })
  // H7b-2：慢日志与 INFO 同层弹层、不同命令，状态也分开：
  // INFO 失败不该让慢日志看起来失败，反之亦然。entries=null 是"从没拉过"，[] 是"拉过、空的"
  const [redisSlowlog, setRedisSlowlog] = useState({ loading: false, error: '', entries: null })
  const redisSlowlogTokenRef = useRef(0)
  const [redisKey, setRedisKey] = useState('')
  const [redisDetail, setRedisDetail] = useState(null)
  // Redis 详情四张表（hash/list/set/zset）"选中的那一格"：{ col, label, rowKey, rowNo }。
  // 悬停预览卡下线后，这里只剩双击进写路径这一条看全文的路（只读连接连这条都没有），
  // 所以按数据页/SQL 结果的同一交互补上：单击数据格 → 详情区下面展开只读值面板。
  // rowNo 单独存：zset 的 rowKey 是扁平数组下标（0/2/4），拿它 +1 报行号会错
  const [redisCell, setRedisCell] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ttlInput, setTtlInput] = useState(undefined)
  // D 批：EXPLAIN 弹窗（对当前选区/整段语句做只读计划分析）
  const [explainOpen, setExplainOpen] = useState(false)
  const [explainSql, setExplainSql] = useState('')
  // D 批 Redis 类型化写：行内编辑状态（{ rowKey, col, value }）+ 各类型"添加"输入
  const [redisEdit, setRedisEdit] = useState(null)
  const [redisAdd, setRedisAdd] = useState({
    field: '',
    value: '',
    member: '',
    score: '',
    listValue: ''
  })
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameInput, setRenameInput] = useState('')

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
  // 界面语言（原语）。`e()` 是模块级函数、每次调用现场取语言，但被 useMemo
  // 缓存下来的列定义（列头 tooltip / Redis 列头）不会自动跟着语言切 —— 把语言
  // 作为依赖带进这些 memo，切换界面语言时列定义才会重建
  const langCode = window.store._config.language || window.initLanguage || ''

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

  // 统一操作错误出口：连接类错误置顶提示（带重连按钮），其余走统一错误弹窗（带一键复制）
  const onOpError = (err) => {
    const msg = err && err.message ? err.message : String(err)
    if (isConnError(err)) {
      // 连接类：横幅自身带错误全文 + 复制 + 重连，无需再弹窗
      setConnError(msg)
      return
    }
    showErrorModal({ error: err })
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
    setStructureV2(EMPTY_STRUCTURE_V2)
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

  // U1c：空态"最近表"。直接取已加载 metadata 的前 8 张表 —— 不新增持久化键，
  // 也不发额外请求（设计 §4.2：最近表先用当前 metadata）。
  // 只收表：视图没有"导入目标"的语义，过程/函数点开是 DDL 不是网格
  const homeTables = useMemo(() => {
    const out = []
    const walk = (database, schema, nodes) => {
      for (const node of nodes || []) {
        if (out.length >= HOME_TABLES_MAX) {
          return
        }
        if (!node || !node.name) {
          continue
        }
        if (isLeafNode(node)) {
          if (node.type === 'table' || !node.type) {
            out.push({
              key: nodeKey(database, schema, node.name),
              database,
              schema,
              table: node.name,
              nodeType: 'table',
              label: schema ? `${schema}.${node.name}` : node.name,
              title: `${database}.${node.name}`
            })
          }
          continue
        }
        // 库内对象分组（过程/触发器/事件）里没有表
        if (node.type === 'group') {
          continue
        }
        walk(database, node.name || '', node.children)
      }
    }
    if (isRedis) {
      return out
    }
    for (const db of metadata || []) {
      if (out.length >= HOME_TABLES_MAX) {
        break
      }
      if (!db || !db.name) {
        continue
      }
      walk(db.name, '', db.children)
    }
    return out
  }, [isRedis, metadata])

  // H4：结构对比的候选表 —— 同连接、当前库里的表（v1 不比跨库）。走已加载的
  // metadata，零请求；只收表不收视图：视图没有索引/外键，比出来全是"仅在 A"
  const diffTables = useMemo(() => {
    if (isRedis) {
      return []
    }
    const out = []
    const walk = (database, schema, nodes) => {
      for (const node of nodes || []) {
        if (!node || !node.name) {
          continue
        }
        if (node.type === 'table' || !node.type) {
          out.push({ database, schema, table: node.name, nodeType: 'table' })
          continue
        }
        if (node.type === 'group') {
          continue
        }
        if (Array.isArray(node.children)) {
          walk(database, node.type === 'schema' ? node.name : schema, node.children)
        }
      }
    }
    for (const db of metadata || []) {
      if (!db || !db.name) {
        continue
      }
      if (sqlDbName && String(db.name).toLowerCase() !== String(sqlDbName).toLowerCase()) {
        continue
      }
      for (const child of db.children || []) {
        if (!child) {
          continue
        }
        if (child.type === 'schema') {
          walk(db.name, child.name, child.children)
        } else {
          walk(db.name, '', [child])
        }
      }
    }
    return out.sort((a, b) => {
      const x = [a.schema, a.table].filter(Boolean).join('.')
      const y = [b.schema, b.table].filter(Boolean).join('.')
      return x < y ? -1 : x > y ? 1 : 0
    })
  }, [isRedis, metadata, sqlDbName])

  // U1c：打开一张表（树点击 / 空态"最近表" / 空态"导入到…"共用同一条路径）。
  // 返回 promise：导入向导要等结构与首屏数据落定后再弹，否则列映射是空的
  const openTable = (target) => {
    // nodeType: 'table' | 'view'。缺省按 table 处理（旧 metadata 无 type 时是表）
    const next = {
      database: target.database,
      schema: target.schema || '',
      table: target.table,
      nodeType: target.nodeType || 'table'
    }
    resetPageFilter()
    resetExactRows()
    // 竞态令牌在**点击时**就取：结构查询是异步的，两次点击的完成顺序可能颠倒，
    // 用"恢复时"的序号会出现"后点的表被先点的结果覆盖"
    viewSeqRef.current += 1
    const seq = viewSeqRef.current
    // 顺序很关键：列清单 → 视角 → 第一次取页。
    // 先取页会先闪一页全量数据（条件还没恢复），而列清单晚到会让条件全被判"未知列"
    return loadStructure(next)
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
      viewKeyRef.current = viewIdOf(next)
      countKeyRef.current = ''
      setViewMode('builder')
      setWhereDraft('')
      setViewBarSeq(n => n + 1)
      applyView(normalizeView({ conditions: conds }))
      setSel(next)
      return loadQuery(next, 1)
    })
  }

  // 有效页大小：视角里存过就用它（换机器/重启后仍按上次的粒度看），
  // 否则回落全局配置。下限 10 与 getDbPageSize 一致，防脏数据把页大小写成 1
  const pageSizeOf = (v) => {
    const n = v && v.pageSize
    return Number.isInteger(n) && n >= 10 ? Math.min(n, DB_PAGE_SIZE_MAX) : getDbPageSize()
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
  // 视角条的 chips 走同一个函数，两处显示因此永远一致（各写一份必然打架）。
  // 箭头由 ColHead 自己画（与 SQL 结果同一套）：不再借 antd 的 col.sorter，
  // 它会把标题包进 .ant-table-column-sorters、挤掉列头右沿的拖宽热区，
  // 还带一个语言包里没有的英文 tooltip（"Click to sort ascending"）
  const onColSort = (field) => {
    if (!sel || !field) {
      return
    }
    applyView(normalizeView({
      ...viewRef.current,
      order: nextSortOrder(viewRef.current.order, String(field), 3)
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
  // redis 键详情分批渲染：每批 200，换键重置；行内编辑/添加输入随键切换作废
  const [detailLimit, setDetailLimit] = useState(200)
  useEffect(() => {
    setDetailLimit(200)
    setRedisEdit(null)
    setRedisAdd(s => ({ ...s, field: '', value: '', member: '', score: '', listValue: '' }))
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

  // ---- F2 手动事务：连接钉住 + 待提交清单 ----
  // 事务状态以主进程为权威（空闲超时/切只读/关 tab 都在主进程收口），前端只负责
  // 轮询展示 + 操作入口；不轮询就感知不到空闲自动回滚，所以 active 时快轮、空闲时慢轮
  const [txState, setTxState] = useState(null)
  const [txBusy, setTxBusy] = useState(false)
  const [txListOpen, setTxListOpen] = useState(false)
  const txNotifiedAtRef = useRef(0)
  const txSupported = !isRedis
  const txActive = !!(txState && txState.active)
  const txPending = (txState && txState.pendingCount) || 0

  useEffect(() => {
    if (!txSupported || !tabId) {
      return undefined
    }
    let dead = false
    const tick = () => {
      window.pre.runGlobalAsync('dbClientOp', tabId, 'getDbTxState')
        .then(st => {
          if (!dead && st) {
            setTxState(st)
          }
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, txActive ? 2000 : 5000)
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [txSupported, tabId, txActive])

  // 空闲自动回滚只提示一次（lastTx 带 at 时间戳去重）
  useEffect(() => {
    const lt = txState && txState.lastTx
    if (!lt || !lt.auto || txNotifiedAtRef.current === lt.at) {
      return
    }
    txNotifiedAtRef.current = lt.at
    message.warning(e('dbTxAutoRolledBack').replace('{n}', String(lt.count || 0)))
  }, [txState])

  // 提交/回滚后当前页数据可能已变（回滚=改动作废），按当前条件重取
  const afterTxEnd = (msgKey) => {
    message.success(e(msgKey))
    setTxListOpen(false)
    setTxState(s => ({ ...(s || {}), active: false, pendingCount: 0, statements: [] }))
    if (sel) {
      loadWithCount(sel, grid.page)
    }
  }

  const runTxOp = (op, onOk) => {
    setTxBusy(true)
    window.pre.runGlobalAsync('dbClientOp', tabId, op)
      .then(onOk)
      .catch(err => onOpError(err))
      .finally(() => setTxBusy(false))
  }

  const beginTx = () => {
    runTxOp('beginDbTx', () => {
      message.success(e('dbTxBegun'))
      setTxState(s => ({ ...(s || {}), active: true, pendingCount: 0, statements: [] }))
    })
  }

  const commitTx = () => runTxOp('commitDbTx', () => afterTxEnd('dbTxCommitted'))
  const rollbackTx = () => runTxOp('rollbackDbTx', () => afterTxEnd('dbTxRolledBack'))

  const setManualTx = (on) => {
    if (on) {
      // 上限由主进程判定并报错，这里先按轮询到的全局计数给一次更早的提示
      if (txState && txState.pinnedTabs >= txState.maxTabs) {
        message.warning(e('dbTxLimit').replace('{max}', String(txState.maxTabs)))
        return
      }
      Modal.confirm({
        title: e('dbTxBeginTitle'),
        content: e('dbTxBeginContent'),
        okText: e('dbTxBegin'),
        cancelText: e('cancel'),
        onOk: beginTx
      })
      return
    }
    if (!txPending) {
      rollbackTx()
      return
    }
    Modal.confirm({
      title: e('dbTxRollbackTitle'),
      content: e('dbTxRollbackWarn').replace('{n}', String(txPending)),
      okText: e('dbTxRollback'),
      cancelText: e('cancel'),
      okButtonProps: { danger: true },
      onOk: rollbackTx
    })
  }

  // 未提交时关 tab 必须确认（主进程无论如何都会先回滚，这里只防手滑丢数据）。
  // delTab 是关闭标签的唯一入口（✕ / Ctrl+W / 会话列表），把守卫挂在那条路径上
  useEffect(() => {
    if (!txSupported || !tabId || !window.store) {
      return undefined
    }
    const guards = window.store.txCloseGuards || (window.store.txCloseGuards = {})
    guards[tabId] = () => new Promise(resolve => {
      if (!txActive) {
        resolve(true)
        return
      }
      Modal.confirm({
        title: e('dbTxCloseTitle'),
        content: (txPending ? e('dbTxCloseWarn') : e('dbTxCloseEmpty'))
          .replace('{n}', String(txPending)),
        okText: e('dbTxRollback'),
        cancelText: e('cancel'),
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    return () => {
      delete guards[tabId]
    }
  }, [txSupported, tabId, txActive, txPending])

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

  // ---- B3-2 批量同列改值 / B3-3 表内查找替换 ----
  // 两者共用主进程 updateCells（同列、按主键定位、值全部绑定），区别只在
  // updates 的 value 是否一致：一致走单条 IN（快、原子），散值逐行（失败行可报）。
  // 范围都限定"本页可见行"——不碰全表，避免一次误操作重写整张表（与 deleteRows 同口径）。
  const [bulk, setBulk] = useState({ open: false, col: '', text: '', isNull: false })
  const [rep, setRep] = useState({ open: false, col: '', find: '', text: '', matchCase: true, wholeCell: false })

  // 可写列（用于两个弹窗的列下拉）：来自表结构缓存，含列名与类型
  const writeColumns = useMemo(
    () => (structureV2.columns || [])
      .filter(c => c && typeof c.name === 'string' && c.name)
      .map(c => ({ name: c.name, type: String(c.dataType || '') })),
    [structureV2.columns]
  )

  // 下拉项标出类型（'id (int)'）：查找替换只作用于文本单元格，
  // 选列时就该看得出这一列会不会参与，而不是等预览报"没有可替换的内容"
  const columnOptions = useMemo(
    () => writeColumns.map(c => ({
      value: c.name,
      label: c.type ? `${c.name} (${c.type})` : c.name
    })),
    [writeColumns]
  )

  // 取出当前勾选的原始行（grid.rows 才含主键，filteredRows 是过滤后的展示副本）
  const selectedRows = useMemo(
    () => grid.rows.filter((_, i) => selectedRowKeys.includes(i)),
    [grid.rows, selectedRowKeys]
  )

  const openBulk = () => {
    const def = selectedCell && selectedCell.col
      ? selectedCell.col
      : (writeColumns[0] || {}).name || ''
    setBulk({ open: true, col: def, text: '', isNull: false })
  }

  // 共用：把一批 updates 发给主进程并刷新（B3-2/B3-3 都走这里）
  const runUpdateCells = async (column, updates) => {
    if (!sel || !pkColumn || !updates.length) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    try {
      const res = await window.pre.runGlobalAsync('dbClientOp', tabId, 'updateCells', {
        database: sel.database,
        schema: sel.schema || '',
        table: sel.table,
        pkColumn,
        column,
        updates
      })
      message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
      const failed = (res && res.failed) || []
      if (failed.length) {
        message.warning(
          e('dbUpdateCellsFailed').replace('{n}', String(failed.length)) +
          ' ' + failed.slice(0, 3).map(f => `${f.pk}: ${f.message}`).join('; ')
        )
      }
      setSelectedRowKeys([])
      loadQuery(sel, grid.page)
    } catch (err) {
      setGrid(g => ({ ...g, loading: false }))
      onOpError(err)
    }
  }

  const submitBulk = async () => {
    if (!sel || !pkColumn || !bulk.col) {
      return
    }
    if (!selectedRows.length) {
      message.info(e('dbNeedSelection'))
      return
    }
    const value = bulk.isNull ? null : bulk.text
    const plan = planSameValue(selectedRows, { column: bulk.col, pkColumn, value })
    if (!plan.updates.length) {
      message.info(e('dbBulkNoChange'))
      return
    }
    const ok = await confirmRowWrite({
      level: 'write',
      text: 'UPDATE ' + writeTargetLabel(sel) +
        ' SET ' + bulk.col + ' = ' + previewLiteral(value) +
        ' WHERE ' + pkColumn + ' IN (' + previewKeyList(plan.updates.map(u => u.pk)) + ')',
      note: e('dbAffectedRows').replace('{n}', String(plan.updates.length))
    })
    if (!ok) {
      return
    }
    setBulk(b => ({ ...b, open: false }))
    await runUpdateCells(bulk.col, plan.updates)
  }

  // 查找替换的实时预览：随输入变化，告诉用户"会改几行"（范围=当前页可见行）
  const repPreview = useMemo(
    () => planReplace(filteredRows, {
      column: rep.col,
      pkColumn,
      find: rep.find,
      replace: rep.text,
      matchCase: rep.matchCase,
      wholeCell: rep.wholeCell
    }),
    [rep, filteredRows, pkColumn]
  )

  const openReplace = () => {
    const def = selectedCell && selectedCell.col
      ? selectedCell.col
      : (writeColumns[0] || {}).name || ''
    setRep({ open: true, col: def, find: '', text: '', matchCase: true, wholeCell: false })
  }

  // 预览文案三分支：可改 → 报单元格数；整列没有文本值（数值/日期/JSON 对象等）→
  // 说清"这列不参与替换"并指向批量改值/双击编辑；否则才是真的没匹配到。
  // 判据用单元格实际类型而不是列声明类型：planReplace 就是按 typeof 跳过的，
  // 声明类型和实际值在 JSON/二进制信封这类列上并不一致，按实际值说才不会反过来误导。
  const repHint = useMemo(() => {
    if (repPreview.updates.length) {
      return {
        text: e('dbReplacePreview').replace('{n}', String(repPreview.updates.length)),
        warn: false
      }
    }
    if (filteredRows.length && !repPreview.textCells) {
      const t = (writeColumns.find(c => c.name === rep.col) || {}).type || rep.col
      return {
        text: e('dbReplaceNonTextColumn').replace('{type}', t),
        warn: true
      }
    }
    return { text: e('dbReplaceNone'), warn: false }
  }, [repPreview, filteredRows, writeColumns, rep.col])

  const submitReplace = async () => {
    if (!sel || !pkColumn || !rep.col || !repPreview.updates.length) {
      return
    }
    const ok = await confirmRowWrite({
      level: 'write',
      text: 'UPDATE ' + writeTargetLabel(sel) +
        ' SET ' + rep.col + ' = replace(' + rep.col + ', ' +
        previewLiteral(rep.find) + ', ' + previewLiteral(rep.text) + ')' +
        ' WHERE ' + pkColumn + ' IN (' + previewKeyList(repPreview.updates.map(u => u.pk)) + ')',
      note: e('dbAffectedRows').replace('{n}', String(repPreview.updates.length))
    })
    if (!ok) {
      return
    }
    setRep(r => ({ ...r, open: false }))
    await runUpdateCells(rep.col, repPreview.updates)
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
  // 只读模式下执行入口本就被编辑器禁用、主进程白名单还会二次拦，这里不弹（验收 §6.5 第 5 条）。
  // Redis 写操作走独立的 confirmRedisWrite（同机制，库名用当前 db index 充当）
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

  // Redis 类型化写 / 删除 / 改名 / 过期，在 production 连接上再过一道确认。
  // 复用同一弹窗与判定（DbDangerConfirm + shouldConfirm）：Redis 没有"表"概念，
  // 库名用当前选中的 db index 充当（Redis 的 database 就是数字 db index，
  // 与生产 MySQL 输库名同语义）。非 production 直接放行，与 confirmRowWrite 同口径。
  const confirmRedisWrite = async payload => {
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('redis')
    const verdict = shouldConfirm({
      level: payload.level,
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    const ok = await askRiskConfirm({
      level: payload.level,
      requireDbName: verdict.requireDbName,
      dbName: String(redisDb),
      statements: [{ text: payload.text, level: payload.level, firstKeyword: '' }],
      reasons: [payload.note],
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

  // H6a：参数化开关（默认开）。关掉就是原来的纯文本执行，:name 原样发给服务端
  const [sqlParamMode, setSqlParamMode] = useState(true)
  const [sqlParams, setSqlParams] = useState({ open: false, names: [], initial: {}, sql: '', database: '' })
  // "记住本次值"只在当前 tab 内存里：刷新页面就没了，也不落盘
  const paramMemoRef = useRef({})

  // 真正执行：sql 可能是转换后的占位符文本（执行用），historySql 始终是用户原文
  const runSqlNow = async (sql, params, historySql) => {
    const database = (sel && sel.database) || tab.dbName || ''
    // 闸门必须在 executeSql 之前：取消 = 零执行（连 loading 都不该亮）。
    // 用原文判定：:name 只是普通 token，不改变语句类型
    if (!isRedis && !isReadonly) {
      const ok = await confirmSqlRisk(historySql || sql, database)
      if (!ok) {
        return
      }
    }
    setSqlResult(s => ({ ...s, loading: true, error: '' }))
    const payload = { sql }
    if (database) {
      payload.database = database
    }
    if (Array.isArray(params) && params.length) {
      payload.params = params
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'executeSql', payload)
      .then(res => {
        setSqlResult({
          loading: false,
          results: (res && res.results) || [],
          // 主进程回传的整次执行耗时（多结果集共享一份总耗时）；旧后端没有
          // 这个字段时为 null，状态行只显示行数
          elapsedMs: res && Number.isFinite(Number(res.elapsedMs))
            ? Number(res.elapsedMs)
            : null,
          error: ''
        })
        // H1a-2：重新执行 = 新一轮列宽（拖过的宽对新结果集没有意义）。
        // 翻页/本地过滤/换分页大小不走到这里，所以那些场景下列宽保持不变
        setSqlColWidths({})
        // S3-C：执行历史只存本地（语句/引擎/库），失败也记录。
        // 存原文（含 :name）：参数值是数据，不该进历史
        appendSqlHistory({
          sql: historySql || sql,
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
          sql: historySql || sql,
          dbType: tab.dbType,
          dbHost: tab.dbHost,
          dbName: currentDbName,
          ok: false
        })
      })
  }

  // H6a：执行入口。有 :name 就先收值（值以参数绑定发送，不拼 SQL）；
  // 没有参数或参数开关关掉时，与原来完全一致
  const runSql = async () => {
    const sql = sqlText.trim()
    if (!sql) {
      return
    }
    const names = !isRedis && sqlParamMode ? extractSqlParams(sql) : []
    if (!names.length) {
      return runSqlNow(sql, null, sql)
    }
    // 参数化模式只支持单条语句：多语句下占位符归属无法确定（后端也会拒）
    if (countSqlStatements(sql) > 1) {
      message.error(e('dbSqlParamsSingle'))
      return
    }
    const database = (sel && sel.database) || tab.dbName || ''
    setSqlParams({ open: true, names, initial: paramMemoRef.current, sql, database })
  }

  const submitSqlParams = values => {
    const { sql, names } = sqlParams
    // 先把这一轮填的值记下来（下一次同样的 :name 直接带出），再去做转换
    const memo = { ...paramMemoRef.current }
    names.forEach(n => {
      memo[n] = { value: values[n] === null ? '' : String(values[n]), isNull: values[n] === null }
    })
    paramMemoRef.current = memo
    let built
    try {
      built = toPositional(sql, values, dialect)
    } catch (err) {
      message.error(err && err.message ? err.message : String(err))
      return
    }
    setSqlParams(s => ({ ...s, open: false }))
    runSqlNow(built.sql, built.values, sql)
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
  const sqlExportHeaders = r => {
    const rows = (r && r.rows) || []
    return (r.fields && r.fields.length)
      ? r.fields
      : (rows.length ? Object.keys(rows[0]) : [])
  }

  // SQL 结果单元格右键菜单（设计 §2.3：结果网格 onCell 返回 onContextMenu，
  // 菜单项按上下文生成；复制的列序与导出同源 —— 都以 fields 为准）。
  // 复制值的口径与值面板一致：二进制信封复制 base64，其余复制 cellText
  const openSqlCellMenu = (ev, rs, col, row) => {
    ev.preventDefault()
    const r = (sqlResult.results || [])[rs]
    if (!r || !row) {
      return
    }
    const headers = sqlExportHeaders(r)
    const v = row[col]
    setCellMenu({
      x: ev.clientX,
      y: ev.clientY,
      head: col,
      items: [
        {
          key: 'value',
          text: e('dbCellCopyValue'),
          onClick: () => copy(isBinEnvelope(v) ? v.__bin.b64 : cellText(v))
        },
        {
          key: 'colname',
          text: e('dbCellCopyColName'),
          onClick: () => copy(col)
        },
        {
          key: 'rowTsv',
          text: e('dbCellCopyRowTsv'),
          onClick: () => copy(toTsv(headers, [row]))
        },
        {
          key: 'rowJson',
          text: e('dbCellCopyRowJson'),
          onClick: () => copy(buildCopyStatements('json', { headers, rows: [row] }))
        },
        {
          // H1：整行逐字段看（复制走 Modal 底部按钮）。行对象是快照，
          // 与菜单 closure 拿到的同一份，翻页后也还指向原来那一行
          key: 'rowDetail',
          text: e('dbCellRowDetail'),
          onClick: () => setSqlRowDetail({ rs, row })
        },
        {
          key: 'filter',
          text: e('dbCellFilterByValue'),
          // 与手动在过滤框输入同一个入口：防抖、命中口径、页码回第 1 页全走同一条路
          onClick: () => onSqlFilterInput(rs, cellText(v))
        }
      ]
    })
  }

  const exportSqlCsv = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadCsv(`db-sql-result-${i + 1}-${tsName()}.csv`, sqlExportHeaders(r), rows)
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

  // SQL 结果导出 TSV：贴表格软件（Excel/剪贴板同款转义），制表/换行压成空格
  const exportSqlTsv = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.tsv`,
      'text/tab-separated-values;charset=utf-8',
      toTsv(sqlExportHeaders(r), rows)
    )
  }

  // SQL 结果导出 JSONL（ndjson）：一行一个 JSON 对象，流式工具逐行可读
  const exportSqlJsonl = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.jsonl`,
      'application/x-ndjson;charset=utf-8',
      toJsonl(sqlExportHeaders(r), rows)
    )
  }

  // SQL 结果导出 Markdown：直接贴进文档/issue 就是表格
  const exportSqlMarkdown = (r, i) => {
    const rows = (r && r.rows) || []
    if (!rows.length) {
      return
    }
    downloadText(
      `db-sql-result-${i + 1}-${tsName()}.md`,
      'text/markdown;charset=utf-8',
      toMarkdownTable(sqlExportHeaders(r), rows)
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

  // ---- C 批：导出到文件 / 导入 CSV/TSV ----

  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // 发起导出时冻结的视角片段（C-12 所见即所导）：与网格同源的
  // where/whereParams/orderClauses 存 state 而不是渲染期重算，
  // 避免对话框打开期间视角变化悄悄改变导出范围
  const [exportParts, setExportParts] = useState(null)

  const openExportDialog = () => {
    if (!sel) {
      return
    }
    setExportParts(viewParts(viewRef.current))
    setExportOpen(true)
  }

  // 危险导入模式（overwrite/upsert）的 production 闸门：复用 E1 riskGate 弹窗
  // （shouldConfirm 决定要不要问、问几次；输库名那条路径由 DbDangerConfirm 承担）。
  // 取消 = 零调用：对话框收不到放行信号就不会发起 start
  const confirmImportRisk = async (mode) => {
    const note = mode === 'overwrite' ? e('dbImportModeOverwrite') : e('dbImportModeUpsert')
    if (!isProduction) {
      return true
    }
    const state = guardRef.current
    const scope = nextScope('import')
    const verdict = shouldConfirm({
      level: 'write',
      production: true,
      state,
      connKey,
      scope,
      now: Date.now()
    })
    if (!verdict.need) {
      return true
    }
    const target = `${mode} ${(sel && sel.database) || tab.dbName || ''}.${sel && sel.table}`
    const ok = await askRiskConfirm({
      level: 'write',
      requireDbName: verdict.requireDbName,
      dbName: (sel && sel.database) || tab.dbName || '',
      statements: [{ text: target, level: 'write', firstKeyword: '' }],
      reasons: [note],
      reason: verdict.reason,
      allowMute: false
    })
    if (ok) {
      markAsked(state, scope)
    }
    return ok
  }

  // ---- S3-C SQL 执行历史（主进程文件环形存储，上限见 SQL_HISTORY_MAX，仅本地，跨启动稳定） ----

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

  // ---- B 批：SQL 查询收藏（B-1~B-4）。与历史共用同一弹层（双 tab）， ----
  // 主进程文件存储（userData/db-sql-favorites.json，上限 500 条，白名单字段），
  // 重启保留；列表/删除失败静默降级，保存失败弹窗要感知（favSaving 状态回滚）

  // 弹层当前 tab：'history' | 'favorite'
  const [favTab, setFavTab] = useState('history')
  const [favList, setFavList] = useState([])
  const [favFilter, setFavFilter] = useState('')
  // 编辑弹窗：null 关闭；{ id?, title, sql, group }——id 缺省即新建（主进程生成 id）
  const [favEdit, setFavEdit] = useState(null)
  const [favSaving, setFavSaving] = useState(false)
  // 分组管理：groups = { 分组名: 条数 }（默认分组 key 为 ''）；folded = 已折叠的分组名集合；
  // groupDialog = null 关闭 | { mode:'new' } | { mode:'rename', name } | { mode:'del', name }
  const [favGroups, setFavGroups] = useState({})
  const [favFolded, setFavFolded] = useState(new Set())
  const [groupDialog, setGroupDialog] = useState(null)
  const [groupInput, setGroupInput] = useState('')
  // 一键收藏弹层：null 关闭 | { group }（group 为已选分组名，'' 默认分组）
  const [quickFav, setQuickFav] = useState(null)
  // 当前收藏视图分组：null = 全部 | '' = 仅默认分组 | 其他 = 该分组
  const [favGroupView, setFavGroupView] = useState(null)
  // 多选分组导出弹层：null 关闭 | 已勾选分组 key 数组（'' = 默认分组，默认全选）
  const [exportMulti, setExportMulti] = useState(null)
  // 已收藏语句集合（归一化 SQL）：历史页/SQL 框星标的"已收藏"态由此判定，
  // 与主进程去重同规则（normSql），收藏列表变化即重算
  const favSqlSet = useMemo(
    () => new Set(favList.filter(Boolean).map(x => normSql(x.sql))),
    [favList]
  )
  // 该语句是否已收藏（归一化匹配）——星标变色/文案切换共用
  const isFaved = (sql) => favSqlSet.has(normSql(sql))

  const favListShown = useMemo(
    () => filterFavorites(favList, favFilter),
    [favList, favFilter]
  )

  // 分组视图过滤：favGroupView 为 null 显示全部；否则只显示该分组（'' 即默认分组）。
  // 叠加在关键字过滤之上，分组 chips 与搜索结果互不干扰
  const favVisible = useMemo(() => {
    if (favGroupView === null) {
      return favListShown
    }
    const g = favGroupView || ''
    return favListShown.filter(x => (x.group || '') === g)
  }, [favListShown, favGroupView])

  // 按分组分桶（用于折叠/展开的分组标题渲染）：
  // 组名有序（默认分组'' 排最前），组内条目保持原顺序（最新在前）
  const favBuckets = useMemo(() => {
    const map = new Map()
    for (const x of favVisible) {
      const g = x.group || ''
      if (!map.has(g)) {
        map.set(g, [])
      }
      map.get(g).push(x)
    }
    return Array.from(map.entries())
  }, [favVisible])

  const refreshFavorites = () => {
    listFavorites()
      .then(setFavList)
      .catch(err => console.warn('load sql favorites failed:', err))
  }

  // 分组统计（供分组侧栏/导出粒度/一键收藏下拉）。失败静默（无分组信息也能用）
  const refreshFavGroups = () => {
    listGroups()
      .then(g => {
        if (g && typeof g === 'object') {
          setFavGroups(g)
        }
      })
      .catch(() => {})
  }

  // tab 切换：第一次进收藏 tab 时拉列表与分组（历史 tab 维持原行为不动）
  const switchPanelTab = (key) => {
    setFavTab(key)
    if (key === 'favorite') {
      refreshFavorites()
      refreshFavGroups()
    }
  }

  // B-1 插入光标：编辑器句柄 insertText（有选区替换选区，保留撤销栈）。
  // 句柄缺失（编辑器懒加载未就绪）退化为追加到文末，功能不缺席
  const insertToEditor = (text) => {
    const ok = sqlEditorRef.current && sqlEditorRef.current.insertText(text)
    if (!ok) {
      setSqlText(t => (t ? t + '\n' + text : text))
    }
  }

  const pickFavorite = (item) => {
    insertToEditor(item.sql)
    openSqlHistory(false)
  }

  // B-2 新建：默认取当前编辑器内容
  const newFavorite = () => {
    setFavEdit({ id: '', title: '', sql: sqlText || '', group: '' })
  }

  const editFavorite = (item) => {
    setFavEdit({ id: item.id, title: item.title || '', sql: item.sql || '', group: item.group || '' })
  }

  // 标题缺省取语句首个非注释行前 60 字符（与快速面板 firstLine 同思路）
  const favTitleFallback = (sql) => {
    const line = String(sql || '')
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('--') && !l.startsWith('#')) || ''
    return line.slice(0, 60)
  }

  const saveFavEdit = () => {
    if (!favEdit || !favEdit.sql.trim() || favSaving) {
      return
    }
    setFavSaving(true)
    saveFavorite({
      id: favEdit.id || '',
      title: favEdit.title.trim() || favTitleFallback(favEdit.sql),
      sql: favEdit.sql,
      dbType: tab.dbType,
      group: favEdit.group || ''
    })
      .then(res => {
        setFavSaving(false)
        const list = res && Array.isArray(res.list) ? res.list : null
        if (list) {
          setFavList(list)
        }
        // 内容去重提示：新建场景命中已存在的同语句收藏
        if (res && res.duplicate && !favEdit.id) {
          const dupGroup = res.duplicate.group || ''
          message.warning(
            dupGroup
              ? e('dbFavDupMoved').replace('{g}', dupGroup)
              : e('dbFavDupDefault')
          )
          return
        }
        setFavEdit(null)
      })
      .catch(err => {
        setFavSaving(false)
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  // 先本地移除（点击即刻消失），主进程落盘后以回包为准；失败不回滚——
  // 下次打开会重新出现，与历史删除同一策略
  const removeOneFavorite = (item) => {
    if (!item || !item.id) {
      return
    }
    setFavList(list => list.filter(x => x.id !== item.id))
    removeFavorite(item.id).then(list => {
      if (Array.isArray(list)) {
        setFavList(list)
      }
    })
  }

  // B-4 导出：三粒度由 exportFavScoped 处理（单组/多组/全选），见下方分组管理段。

  // B-4 导入：主进程读文件 + 按 id upsert（重复覆盖、新条追加），
  // 返回 { list, imported, overwritten } 供提示
  const importFav = () => {
    window.api.openDialog({
      title: e('dbFavImport'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
      .then(res => {
        const p = Array.isArray(res) ? res[0] : (res && res.filePaths && res.filePaths[0])
        if (!p) {
          return null
        }
        return importFavorites(p).then(r => {
          if (r && Array.isArray(r.list)) {
            setFavList(r.list)
          }
          if (r) {
            message.success(
              e('dbFavImported')
                .replace('{n}', String(r.imported))
                .replace('{m}', String(r.overwritten))
            )
          }
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavImportFailed'))
      })
  }

  // ---- 分组管理（B-5）：创建/重命名/删除分组 + 分组折叠 ----
  // 分组名取自收藏条目的 group 字段；新建分组 = 给收藏指定一个当前不存在的组名。
  // 这些函数只操作内存 favList + 调主进程落盘，随后统一 refreshFavGroups

  // 分组对话框确认：mode = 'new' 新建 | 'rename' 重命名 | 'del' 删除
  const submitGroupDialog = () => {
    const d = groupDialog
    if (!d) {
      return
    }
    const name = groupInput.trim()
    if (d.mode === 'del') {
      deleteFavoriteGroup(d.name).then(list => {
        if (Array.isArray(list)) {
          setFavList(list)
          refreshFavGroups()
          message.success(e('dbFavGroupDeleted').replace('{g}', d.name))
        }
      })
      setGroupDialog(null)
      setGroupInput('')
      return
    }
    if (!name) {
      message.error(e('dbFavGroupNameEmpty'))
      return
    }
    if (d.mode === 'rename') {
      renameFavoriteGroup(d.name, name).then(list => {
        if (Array.isArray(list)) {
          setFavList(list)
          refreshFavGroups()
          message.success(e('dbFavGroupRenamed').replace('{o}', d.name).replace('{n}', name))
        }
      })
    } else {
      // 新建：走主进程"空分组登记"持久化——否则空分组无条目归属，
      // 在列表/下拉里永远不可见（登记后 listGroups 会合并空分组，计 0）
      createFavoriteGroup(name)
        .then(() => {
          refreshFavGroups()
          message.success(e('dbFavGroupCreated').replace('{g}', name))
        })
        .catch(() => {})
    }
    setGroupDialog(null)
    setGroupInput('')
  }

  const toggleFavFold = (group) => {
    setFavFolded(prev => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  // 把某收藏移入指定分组（编辑弹窗内的分组下拉走 saveFavEdit）
  const moveFavoriteGroup = (item, group) => {
    saveFavorite({ ...item, group })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
      })
      .catch(err => message.error((err && err.message) || e('dbFavSaveFailed')))
  }

  // ---- 一键收藏（B-6）：执行页当前 SQL / 历史页每条 SQL ----
  // 复用编辑弹窗的保存路径（saveFavorite，含内容去重），但交互更轻。
  // 两条路径共用 saveFavorite：
  // - favoriteNow：立刻收藏到指定分组（星标按钮的直接动作，无弹窗）
  // - openQuickFav：打开确认弹窗选分组（"新建分组"等需要指定分组的场景）
  const favoriteNow = (sql, group) => {
    if (!sql || !sql.trim()) {
      message.warning(e('dbQuickFavEmpty'))
      return
    }
    saveFavorite({
      id: '',
      title: favTitleFallback(sql),
      sql,
      dbType: tab.dbType,
      group: group || ''
    })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
        if (res && res.duplicate) {
          const g = res.duplicate.group || ''
          message.warning(g ? e('dbFavDupMoved').replace('{g}', g) : e('dbFavDupDefault'))
        } else {
          message.success(e('dbFavSaved'))
        }
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  const openQuickFav = (sql, existing) => {
    if (!sql || !sql.trim()) {
      message.warning(e('dbQuickFavEmpty'))
      return
    }
    setQuickFav({
      sql,
      title: existing ? existing.title : '',
      id: existing ? existing.id : '',
      group: existing ? (existing.group || '') : ''
    })
  }

  const doQuickFav = (group) => {
    if (!quickFav) {
      return
    }
    saveFavorite({
      id: quickFav.id || '',
      title: quickFav.title || favTitleFallback(quickFav.sql),
      sql: quickFav.sql,
      dbType: tab.dbType,
      group: group || ''
    })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
        if (res && res.duplicate && !quickFav.id) {
          const g = res.duplicate.group || ''
          message.warning(g ? e('dbFavDupMoved').replace('{g}', g) : e('dbFavDupDefault'))
        } else {
          message.success(e('dbFavSaved'))
        }
        setQuickFav(null)
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  // ---- 收藏导出（B-4 三粒度）：单组 / 多选 / 全选 ----
  // 渲染层先按所选分组过滤 favList，再把子集交给主进程白名单写文件
  const doExportFavorites = (items) => {
    if (!items.length) {
      message.warning(e('dbFavExportEmpty'))
      return
    }
    window.api.saveDialog({
      title: e('dbFavExport'),
      defaultPath: 'db-sql-favorites.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
      .then(res => {
        if (!res || res.canceled || !res.filePath) {
          return null
        }
        return exportFavorites(res.filePath, items).then(n => {
          message.success(e('dbFavExported').replace('{n}', String(n)))
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavExportFailed'))
      })
  }

  const exportFavScoped = (group) => {
    // group 为 null 表示"全选"，字符串表示"仅该分组"
    const items = group === null
      ? favList
      : favList.filter(x => (x.group || '') === (group || ''))
    doExportFavorites(items)
  }

  // 多选分组导出：exportMulti = null 关闭 | 已勾选的分组 key 数组（'' = 默认分组）
  const submitExportMulti = () => {
    const checked = exportMulti || []
    if (!checked.length) {
      message.warning(e('dbFavExportMultiEmpty'))
      return
    }
    const set = new Set(checked)
    doExportFavorites(favList.filter(x => set.has(x.group || '')))
    setExportMulti(null)
  }

  // ---- 历史导出（S3-D）：全部或当前筛选结果 ----
  const exportSqlHistory = () => {
    const items = histFilter.trim() ? histList : sqlHistory
    if (!items.length) {
      message.warning(e('dbHistExportEmpty'))
      return
    }
    window.api.saveDialog({
      title: e('dbHistExport'),
      defaultPath: 'db-sql-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
      .then(res => {
        if (!res || res.canceled || !res.filePath) {
          return null
        }
        return exportHistoryFile(res.filePath, items).then(n => {
          message.success(e('dbHistExported').replace('{n}', String(n)))
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbHistExportFailed'))
      })
  }

  // ---- AI 联动（B-7）：把当前 SQL 交给右侧 AI 面板解释 ----
  // 复用既有 explainWithAi 的机制：refsStatic 里注册的 AIChat 暴露 setPrompt/handleSubmit，
  // 这里先打开 AI 面板、填充提示词，再触发提交。500/1200ms 两步是 state 更新
  // 与面板挂载的时序缓冲（explainWithAi 同款），保证 setPrompt 落地后再 submit
  const askAiAboutSql = (sql) => {
    const text = (sql || '').trim()
    if (!text) {
      message.warning(e('dbExplainEmptySql'))
      return
    }
    window.store.handleOpenAIPanel()
    setTimeout(() => {
      window.store.aiPendingSqlPrompt = `请解释以下 SQL 语句：\n\n${text}`
      refsStatic.get('AIChat')?.setPrompt(window.store.aiPendingSqlPrompt)
    }, 500)
    setTimeout(() => {
      refsStatic.get('AIChat')?.handleSubmit()
    }, 1200)
  }

  // B-3 模板插入：key 取 SQL_TEMPLATES；withTable 用当前选中表（列清单来自
  // structureV2——getTableStructure 的规范化列，与列白名单/补全同源已缓存，
  // 等价于设计所说 describeTable 列信息且更干净）。无选中表生成骨架
  const insertTemplate = (key, withTable) => {
    let ctx = { dialect: tab.dbType }
    if (withTable && sel) {
      ctx = {
        dialect: tab.dbType,
        schema: sel.schema || '',
        table: sel.table,
        columns: structureV2.columns || []
      }
    }
    const text = buildTemplateSql(key, ctx)
    if (!text) {
      return
    }
    insertToEditor(text)
  }

  const templateMenu = {
    items: [
      ...SQL_TEMPLATES.map(t => ({
        key: t.key,
        icon: <CodeOutlined />,
        label: e('dbTpl' + t.key.charAt(0).toUpperCase() + t.key.slice(1))
      })),
      { type: 'divider' },
      {
        key: 'genInsert',
        icon: <PlusOutlined />,
        label: e('dbTplGenInsert'),
        // 没选中表就没有列清单，禁用并提示（验收：无选中表禁用）
        disabled: !sel,
        title: sel ? '' : e('dbTplGenInsertNeedTable')
      }
    ],
    onClick: ({ key }) => insertTemplate(key, key === 'genInsert')
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
    // 顺序翻页/过滤/刷新都会作废在途的跳页请求，避免旧跳页结果覆盖新页
    keyJumpTokenRef.current++
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

  // H7b-3：换库/换过滤就清空勾选 —— 勾选是键名集合，跨库没有意义；
  // 同一过滤条件内跨页保留（否则一页最多 200 个键，"分批 500"永远只有一批）
  useEffect(() => {
    setRedisKeySel([])
  }, [redisDb, keyList.match])

  // R1：键列表跳到第 N 页（1 基）。SCAN 游标不透明，后端从 cursor=0 前向步进
  // target 次并回传沿途每页起始游标；用这条游标链重建 prev 栈，
  // 之后 prev/next 仍是顺序推进（不重复扫描）。目标页超出遍历范围时停在末页后。
  const jumpRedisKeysPage = (pageNo) => {
    const n = Math.floor(Number(pageNo))
    if (!Number.isInteger(n) || n < 1) {
      setKeyJumpInput('')
      return
    }
    const target = n - 1
    setKeyJumpInput('')
    const doJump = () => {
      const match = keyList.match || '*'
      keyJumpTokenRef.current++
      const token = keyJumpTokenRef.current
      setKeyList(s => ({ ...s, loading: true }))
      window.pre.runGlobalAsync('dbClientOp', tabId, 'scanKeysToPage', {
        dbIndex: redisDb,
        pageIndex: target,
        pageSize: getDbPageSize(),
        match
      }).then(res => {
        if (token !== keyJumpTokenRef.current) {
          return
        }
        const cursors = (res && res.cursors) || ['0']
        setKeyList({
          loading: false,
          rows: (res && res.rows) || [],
          cursor: cursors[cursors.length - 1] || '0',
          nextCursor: (res && res.nextCursor) || '0',
          hasMore: !!(res && res.hasMore),
          match,
          stack: cursors.slice(0, -1)
        })
      }).catch(err => {
        if (token !== keyJumpTokenRef.current) {
          return
        }
        setKeyList(s => ({ ...s, loading: false }))
        onOpError(err)
      })
    }
    if (target > REDIS_KEY_JUMP_WARN_PAGES) {
      Modal.confirm({
        title: e('dbKeyJumpWarnTitle'),
        content: e('dbKeyJumpWarn').replace('{n}', String(n)),
        okText: e('dbGo'),
        cancelText: e('cancel'),
        onOk: doJump
      })
      return
    }
    doJump()
  }

  // H7a：键树抓取。列表是"一页一次 IPC 的游标分页"，树必须看到全部键名才能分层，
  // 所以这里是渲染侧驱动的多轮 SCAN（keysOnly：只要名字，一键盘不发 TYPE/TTL）。
  // - 每轮 COUNT 1000，收完一段就更新 scanned —— 进度是真进度，不是转圈动画
  // - 撞 REDIS_TREE_MAX_KEYS 立即停手并标 truncated：不设上限时 500 万键的实例
  //   会把渲染进程整死，"截断但可用"好过"完整但卡住"
  // - 取消 = 令牌 +1：主进程没有 SCAN 中断通道（dbClientOp 只有单次超时），
  //   能做的是不再采纳这一轮之后的任何响应，最后一发请求自然跑完即弃
  const loadRedisKeyTree = (dbIndex, match = '*', sep = treeSep) => {
    keyTreeTokenRef.current++
    const token = keyTreeTokenRef.current
    const pattern = match || '*'
    setKeyTree(s => ({
      ...s, loading: true, scanned: 0, total: 0, truncated: false, match: pattern
    }))
    const names = []
    const seen = new Set()
    let cursor = '0'
    let truncated = false
    const finish = () => {
      setKeyTree({
        loading: false,
        scanned: names.length,
        total: names.length,
        truncated,
        names,
        match: pattern
      })
    }
    const step = () => {
      if (token !== keyTreeTokenRef.current) {
        return
      }
      window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
        dbIndex,
        cursor,
        pageSize: REDIS_TREE_SCAN_COUNT,
        match: pattern,
        keysOnly: true
      }).then(res => {
        if (token !== keyTreeTokenRef.current) {
          return
        }
        for (const r of (res && res.rows) || []) {
          const name = r && r.name
          // SCAN 只保证"至少一次"，重复键在这里先去重再计数，scanned 才是真实进度
          if (!name || seen.has(name)) {
            continue
          }
          seen.add(name)
          names.push(name)
        }
        cursor = String((res && res.nextCursor) || '0')
        setKeyTree(s => ({ ...s, scanned: names.length }))
        if (cursor === '0') {
          return finish()
        }
        if (names.length >= REDIS_TREE_MAX_KEYS) {
          truncated = true
          return finish()
        }
        step()
      }).catch(err => {
        if (token !== keyTreeTokenRef.current) {
          return
        }
        setKeyTree(s => ({ ...s, loading: false }))
        onOpError(err)
      })
    }
    step()
  }

  const cancelKeyTree = () => {
    keyTreeTokenRef.current++
    setKeyTree(s => ({ ...s, loading: false }))
  }

  // 换 db / 关 tab 都要作废在途抓取：否则旧 db 的键会混进新 db 的树里
  const resetKeyTree = () => {
    keyTreeTokenRef.current++
    setKeyTree({
      loading: false,
      scanned: 0,
      total: 0,
      truncated: false,
      names: [],
      match: '*'
    })
  }

  // 树只在"抓取结束时"重算，改分隔符不该重扫一遍上万键
  const keyTreeBuilt = useMemo(
    () => buildRedisKeyTree(keyTree.names, { separator: treeSep }),
    [keyTree.names, treeSep]
  )
  const keyPathIndex = useMemo(() => buildKeyPathIndex(keyTreeBuilt.nodes), [keyTreeBuilt])

  // 进树视图 / 换分隔符 / 新一次抓取结束 → 重算展开集。
  // 小键库默认把第一层目录摊开（省事）；大键库一个都不自动摊（见 REDIS_TREE_AUTO_EXPAND_KEYS）。
  // 选中键那一支是例外：不展开就看不见被选中的那一行。
  // 不跟 redisKey 走：用户在树里自己折叠过的，不该因为选了个键又被程序撑开。
  useEffect(() => {
    if (redisView !== 'tree') {
      return
    }
    const auto = keyTreeBuilt.total <= REDIS_TREE_AUTO_EXPAND_KEYS
      ? collectFolderKeys(keyTreeBuilt.nodes, 1)
      : []
    const exp = new Set(auto)
    const path = redisKey ? keyPathIndex.get(redisKey) : null
    if (path) {
      for (const a of ancestorKeys(path, treeSep)) {
        exp.add(a)
      }
    }
    setTreeExpanded([...exp])
  }, [redisView, keyTreeBuilt])

  const switchRedisView = (v) => {
    setRedisView(v)
    if (v !== 'tree') {
      return
    }
    // 已有结果且过滤条件没变 → 直接复用：来回切视图不该每次都把上万键重扫一遍
    const pattern = keyList.match || matchInput || '*'
    if (!keyTree.loading && (keyTree.match !== pattern || !keyTree.names.length)) {
      loadRedisKeyTree(redisDb, pattern)
    }
  }

  // 过滤条件两种视图共用（match 输入框只有一个）：在列表里改了过滤再切到树，
  // 树必须按新条件重扫，否则输入框写着 user:*、树里装的还是全库键名。
  // 树视图下按「过滤」同样要刷列表 —— 让两个视图的 match 始终一致，
  // 视图来回切才谈得上"复用已抓的键名"。
  const applyRedisFilter = () => {
    loadRedisKeys(redisDb, '0', matchInput)
    if (redisView === 'tree') {
      loadRedisKeyTree(redisDb, matchInput)
    }
  }

  const refreshRedisView = () => {
    if (redisView === 'tree') {
      loadRedisKeyTree(redisDb, keyTree.match || matchInput)
    } else {
      loadRedisKeys(redisDb, keyList.cursor || '0', keyList.match, keyList.stack)
    }
  }

  // H7a-4：INFO 全量原文 → 弹层。op 不 select db（实例级信息），所以换库不需要重拉，
  // 但"打开时拉一次"仍然保留：概览里最关键的是内存/客户端/命中率，都随写入在变。
  const loadRedisInfo = () => {
    redisInfoTokenRef.current++
    const token = redisInfoTokenRef.current
    setRedisInfo(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getRedisInfo', {}).then(res => {
      if (token !== redisInfoTokenRef.current) {
        return
      }
      // 只写数据、不动 open：弹层可能在请求回来之前就关了，响应不该把它重新打开
      setRedisInfo(s => ({
        ...s,
        loading: false,
        text: String(res || ''),
        error: ''
      }))
    }).catch(err => {
      if (token !== redisInfoTokenRef.current) {
        return
      }
      // 错误留在弹层内而不是走 onOpError：这里丢的只是"这一次查看"，
      // 键列表照常可用；置顶横幅会让人以为整条连接断了。
      // text 清空：留着上一份 INFO 会和"失败"并排显示，用户不知道看哪份。
      setRedisInfo(s => ({
        ...s,
        loading: false,
        text: '',
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }

  const openRedisInfo = () => {
    setRedisInfo(s => ({ ...s, open: true }))
    loadRedisInfo()
  }

  const closeRedisInfo = () => {
    // 关闭即作废在途请求：否则关掉再打开会先看到上一次请求的结果闪一下
    redisInfoTokenRef.current++
    redisSlowlogTokenRef.current++
    setRedisInfo({ open: false, loading: false, text: '', error: '' })
    // 慢日志一起清回"从没拉过"：重开时切进该页签会重新拉，
    // 留着上一次的条目会让人以为看到的是当前这段慢日志
    setRedisSlowlog({ loading: false, error: '', entries: null })
  }

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

  // H4：结构对比取数。refresh 让主进程跳过结构缓存 —— 刚 ALTER 过的表在 60s
  // TTL 内还会返回旧结构，拿它对比会得出看不出来的错误结论
  const loadDiffStructure = useCallback(target => window.pre.runGlobalAsync(
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

  // H7b-2：慢日志。与 INFO 同一个弹层、另一条命令 —— 只在第一次切进"慢日志"页签时拉，
  // 只看概览的用户不该为 SLOWLOG GET（整段日志拷回来）多付一次往返。
  const loadRedisSlowlog = () => {
    redisSlowlogTokenRef.current++
    const token = redisSlowlogTokenRef.current
    setRedisSlowlog(s => ({ ...s, loading: true }))
    // 不传 count：条数上限归后端定（0 在 RESP 里是"取全部"，前端不该有机会传出一个 0）
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getRedisSlowlog', {}).then(res => {
      if (token !== redisSlowlogTokenRef.current) {
        return
      }
      setRedisSlowlog(s => ({
        ...s,
        loading: false,
        entries: Array.isArray(res) ? res : [],
        error: ''
      }))
    }).catch(err => {
      if (token !== redisSlowlogTokenRef.current) {
        return
      }
      // entries 留 null：失败不该被记成"拉过、是空的"，否则切回该页签不会再试
      setRedisSlowlog(s => ({
        ...s,
        loading: false,
        entries: null,
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }

  const redisTreeNodes = useMemo(() => {
    const map = (list) => (list || []).map(n => ({
      key: n.key,
      title: n.title,
      keyName: n.keyName,
      count: n.count,
      // 纯目录不可选：点了没键可加载，只该展开/收起
      selectable: !!n.keyName,
      children: n.children ? map(n.children) : undefined
    }))
    return map(keyTreeBuilt.nodes)
  }, [keyTreeBuilt])

  const onRedisTreeSelect = (keys, info) => {
    const node = info && info.node
    // 目录节点 selectable=false 走不到这里，但 antd 的取消选中回调也会进这里
    if (!node || !node.keyName) {
      return
    }
    selectRedisKey(node.keyName)
  }

  const redisTreeStatus = keyTree.loading
    ? e('dbKeyTreeScanning').replace('{n}', keyTree.scanned)
    : e('dbKeysTotal').replace('{n}', keyTree.total)

  const redisTreeSelected = redisKey && keyPathIndex.has(redisKey)
    ? [keyPathIndex.get(redisKey)]
    : []

  // cursor/append 供 hash/set 服务端分页：append 时把新一页合并进已加载详情，
  // 不再把整个键一次性搬进内存
  const selectRedisKey = (key, cursor = '0', append = false) => {
    if (!append) {
      setRedisKey(key)
      // 换键 = 换一份详情，上一键那一格的选中必须清掉：面板标题写的是旧键的
      // 「列名 · 第 N 行」，行号在新键里指的是另一行数据
      setRedisCell(null)
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
      showErrorModal({ error: err })
    })
  }

  const applyTtl = async () => {
    if (!redisKey) {
      return
    }
    const seconds = Number(ttlInput) || 0
    const ok = await confirmRedisWrite({
      level: 'write',
      text: 'EXPIRE ' + redisKey + ' ' + seconds,
      note: e('dbTtlUpdated')
    })
    if (!ok) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'expireKey', {
      dbIndex: redisDb,
      key: redisKey,
      seconds
    }).then(() => {
      message.success(e('dbTtlUpdated'))
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      selectRedisKey(redisKey)
    }).catch(err => {
      showErrorModal({ error: err })
    })
  }

  const delSelectedKey = async () => {
    if (!redisKey) {
      return
    }
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: 'DEL ' + redisKey,
      note: e('dbDeleted')
    })
    if (!ok) {
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
      showErrorModal({ error: err })
    })
  }

  // ---- H7b-3 批量删键：预览 → 确认（生产再过 E1）→ 分批 UNLINK → 进度 ----

  // 弹层打开时冻结这批键名：随后后台刷新/翻页改了勾选，也不该让"确认时看到的"
  // 和"实际删掉的"对不上
  const openRedisDel = () => {
    const keys = redisKeySel.slice()
    if (!keys.length) {
      return
    }
    setRedisDel({ open: true, keys, running: false, done: 0, error: '' })
  }

  const closeRedisDel = () => {
    if (redisDel.running) {
      return
    }
    setRedisDel({ open: false, keys: [], running: false, done: 0, error: '' })
  }

  const runRedisDel = async () => {
    const targets = redisDel.keys
    // E1：生产连接多一道风险确认（非生产只有这个预览弹层本身）。
    // 命令文本只列前 10 个键 —— 500 个键名铺满一屏，谁都会直接点"仍要执行"
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: delCommandText(targets),
      note: e('dbRedisDelKeysBody')
    })
    if (!ok) {
      return
    }
    setRedisDel(d => ({ ...d, running: true, done: 0, error: '' }))
    let done = 0
    for (const chunk of chunkRedisKeys(targets)) {
      try {
        const n = await window.pre.runGlobalAsync('dbClientOp', tabId, 'delKeys', {
          dbIndex: redisDb,
          keys: chunk
        })
        done += Number(n) || 0
        setRedisDel(d => ({ ...d, done }))
      } catch (err) {
        // 前面几批已经删了、回滚不了：停在弹层里让人看到"删到哪儿"
        setRedisDel(d => ({
          ...d,
          running: false,
          done,
          error: cleanDbError(err && err.message ? err.message : err)
        }))
        return
      }
    }
    setRedisDel({ open: false, keys: [], running: false, done: 0, error: '' })
    setRedisKeySel([])
    // 删掉的正好是详情里选中的那个键 → 详情一起清掉，不留一个已不存在的键
    if (targets.includes(redisKey)) {
      setRedisKey('')
      setRedisDetail(null)
    }
    message.success(e('dbRedisDelKeysDone').replace('{n}', String(done)))
    // 原页重拉（不是回第一页）：删的是本页的键，用户还该站在这一页
    loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
    // 键数变了 → 同步左侧各 db 的键个数
    loadTree()
  }

  // ---- D 批：EXPLAIN（只读计划分析，设计 §12.1） ----

  // 「解释」入口：优先解释编辑器当前选区，无选区解释整段语句。
  // 库/schema 取当前树选中（与 runSql 同口径）；换行/分号的闸门在后端
  const openExplain = () => {
    const editor = sqlEditorRef.current
    const selected = editor && editor.getSelectionText
      ? editor.getSelectionText()
      : ''
    const text = (selected || sqlText).trim()
    if (!text) {
      message.warning(e('dbExplainEmptySql'))
      return
    }
    setExplainSql(text)
    setExplainOpen(true)
  }

  // ---- D 批：Redis 类型化写（T12） ----

  // 统一执行：成功/失败都刷新详情与键列表（redisWrite 纪律），这里只补
  // 成功提示与失败 toast。返回 { ok } 而不 rethrow，调用方按 ok 决定收尾。
  // gate 为 production 连接的生产闸门（{ level, text, note }）：非 production 时忽略，
  // 命中则先弹 confirmRedisWrite，取消 = 零执行（{ ok: false }）
  const runRedisWrite = (op, params, successMsg, gate) => {
    const doWrite = () => redisWrite(tabId, op, params, {
      refresh: () => {
        selectRedisKey(redisKey)
        loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      }
    }).then(res => {
      if (successMsg) {
        message.success(successMsg)
      }
      return { ok: true, res }
    }).catch(err => {
      showErrorModal({ error: err })
      return { ok: false }
    })
    if (gate && isProduction) {
      return confirmRedisWrite(gate).then(ok => (ok ? doWrite() : { ok: false }))
    }
    return doWrite()
  }

  const addHashField = () => {
    const field = redisAdd.field.trim()
    if (!field) {
      return
    }
    runRedisWrite('hashSetField', {
      dbIndex: redisDb, key: redisKey, field, value: redisAdd.value
    }, e('saved'), {
      level: 'write',
      text: 'HSET ' + redisKey + ' ' + field,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisAdd(s => ({ ...s, field: '', value: '' }))
      }
    })
  }

  const addMember = () => {
    const member = redisAdd.member.trim()
    if (!member) {
      return
    }
    if (redisDetail && redisDetail.type === 'zset') {
      runRedisWrite('zsetAdd', {
        dbIndex: redisDb, key: redisKey, score: redisAdd.score, member
      }, e('saved'), {
        level: 'write',
        text: 'ZADD ' + redisKey + ' ' + redisAdd.score + ' ' + member,
        note: e('saved')
      }).then(r => {
        if (r.ok) {
          setRedisAdd(s => ({ ...s, member: '', score: '' }))
        }
      })
    } else {
      runRedisWrite('setAdd', {
        dbIndex: redisDb, key: redisKey, members: [member]
      }, e('saved'), {
        level: 'write',
        text: 'SADD ' + redisKey + ' ' + member,
        note: e('saved')
      }).then(r => {
        if (r.ok) {
          setRedisAdd(s => ({ ...s, member: '' }))
        }
      })
    }
  }

  const pushList = (position) => {
    if (redisAdd.listValue === '') {
      return
    }
    runRedisWrite('listPush', {
      dbIndex: redisDb, key: redisKey, value: redisAdd.listValue, position
    }, e('saved'), {
      level: 'write',
      text: (position === 'left' ? 'LPUSH ' : 'RPUSH ') + redisKey,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisAdd(s => ({ ...s, listValue: '' }))
      }
    })
  }

  // hash 行内编辑保存：HSET 覆盖同字段
  const saveHashValue = (record) => {
    const value = redisEdit ? redisEdit.value : ''
    runRedisWrite('hashSetField', {
      dbIndex: redisDb, key: redisKey, field: record.field, value
    }, e('saved'), {
      level: 'write',
      text: 'HSET ' + redisKey + ' ' + record.field,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // zset 分值行内编辑：ZADD 同 member 天然覆盖
  const saveZsetScore = (record) => {
    const score = redisEdit ? redisEdit.value : ''
    runRedisWrite('zsetAdd', {
      dbIndex: redisDb, key: redisKey, score, member: record.member
    }, e('saved'), {
      level: 'write',
      text: 'ZADD ' + redisKey + ' ' + score + ' ' + record.member,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // list 行内编辑：LSET 按下标覆盖
  const saveListValue = (record) => {
    const value = redisEdit ? redisEdit.value : ''
    runRedisWrite('listSetAt', {
      dbIndex: redisDb, key: redisKey, index: record.index, value
    }, e('saved'), {
      level: 'write',
      text: 'LSET ' + redisKey + ' ' + record.index,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // set 成员编辑 = 删旧加新（成员是身份标识）：任一步失败都刷新详情
  const editSetMember = async (oldMember, newMember) => {
    const nm = String(newMember || '').trim()
    if (!nm || nm === oldMember) {
      setRedisEdit(null)
      return
    }
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: 'SREM ' + redisKey + ' ' + oldMember + ' / SADD ' + redisKey + ' ' + nm,
      note: e('saved')
    })
    if (!ok) {
      setRedisEdit(null)
      return
    }
    redisWrite(tabId, 'setRem', {
      dbIndex: redisDb, key: redisKey, members: [oldMember]
    }).then(() => redisWrite(tabId, 'setAdd', {
      dbIndex: redisDb, key: redisKey, members: [nm]
    })).then(() => {
      message.success(e('saved'))
      setRedisEdit(null)
      selectRedisKey(redisKey)
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
    }).catch(err => {
      // 中间态可能已删旧未加新：必须刷新详情拿真实状态
      selectRedisKey(redisKey)
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      showErrorModal({ error: err })
    })
  }

  // 重命名键（RENAMENX，不覆盖）：成功后切到新键；冲突由后端抛含 newKey 的
  // 可读错误，经 toast 展示。键名变化，刷新走 keyList，详情在新键上重拉
  const doRenameKeyNx = async () => {
    const newKey = renameInput.trim()
    if (!newKey || newKey === redisKey) {
      return
    }
    const ok = await confirmRedisWrite({
      level: 'write',
      text: 'RENAMENX ' + redisKey + ' ' + newKey,
      note: e('dbRenamed')
    })
    if (!ok) {
      return
    }
    redisWrite(tabId, 'renameKeyNx', {
      dbIndex: redisDb, key: redisKey, newKey
    }, {
      refresh: () => loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack),
      onSuccess: () => {
        setRedisKey(newKey)
        selectRedisKey(newKey)
      }
    }).then(() => {
      message.success(e('dbRenamed'))
      setRenameOpen(false)
      setRenameInput('')
    }).catch(err => {
      showErrorModal({ error: err })
    })
  }

  // dataType 来自 structureV2.columns（数据页）或结果集的 columns[].type（SQL 结果，
  // H1a-3）；两处都拿不到类型时传 '' —— 此时只格式化"驱动已经给出 JS number"的值，
  // 字符串不猜
  // A1：renderCell 提升为 useCallback，依赖其闭包引用的随渲染变化的值
  // （keywordPatterns/kw/themeConfig/formatLocale）；hlNode/highlightValue/
  // formatCellValue/isBinEnvelope 为模块级纯函数，稳定，不进依赖
  const renderCell = useCallback((v, cellFilterKw = '', dataType = '') => {
    // antd 的 render(text, record, index) 会把整行对象传进第二参。
    // 只认字符串关键字：否则 hlNode 会拿对象去 indexOf，靠"[object Object]" 永不命中
    // 蒙混过关（能跑，但语义是错的）
    const filterKw = typeof cellFilterKw === 'string' ? cellFilterKw : ''
    let node
    if (v === null || v === undefined) {
      node = <span className='db-cell-null'>NULL</span>
    } else if (v === '') {
      // H2：空串与 NULL 都是"格子空白"，肉眼分不出是哪一种。空串给一对引号
      // 占位（低对比细体），NULL 保持半透明 NULL —— 复制/导出/编辑仍取原值
      node = <span className='db-cell-empty'>''</span>
    } else if (isBinEnvelope(v)) {
      // F3：二进制列在网格里只显示大小占位（完整内容在下方值面板按呈现器解码）
      node = hlNode(
        highlightValue('<binary ' + v.__bin.size + ' bytes>', keywordPatterns, themeConfig),
        kw
      )
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
  }, [keywordPatterns, kw, themeConfig, formatLocale])

  // 长内容不再有悬停预览：悬停浮层在大结果上要维护观察者与高亮文本，
  // 实际使用里又经常挡住相邻格子。数据页保持"单击 → 下方值面板"，
  // SQL 结果改成同一套（点击格直接展开，不再先出现折叠工具条）。
  // 列仍用 CELL_ELLIPSIS（ellipsis 但不带 native title）：title 等于给每行每个值
  // 多一份字符串副本，而完整内容在下方面板里随时可看。

  // H1a-2：列头右键菜单是全站单例：给每列各挂一个 Dropdown 的话，
  // 200 列的数据页每次列 memo 重建都要挂/卸上百个 Trigger。
  // 各网格只负责在 onHeaderCell 里把"哪一列 + 属于哪个宽度状态 + 加宽到多少"报过来
  const colMenu = useColMenu()
  // JSX 侧解构成 handle*（包一层箭头就是每轮新引用，浮层会反复摘挂监听）
  const { target: colMenuTarget, hide: handleColMenuHide } = colMenu

  // 列宽按内容自适应（采样前 100 行取最长值）：固定 220 会让短值列
  // （如"一般"）出现大片空白；虚拟渲染是 fixed 布局，必须显式给宽。
  // 采样单独 memo：输入查找/过滤时不必重新扫描 100 行 × 所有列。
  // H1a-1：公式抽到 common/db-column-width（数据页与 SQL/Redis/结构页共用同一套
  // 90~360 上下限）。唯一行为差异：JSON/对象列按真实文本量宽，原实现走
  // String(v) 得到 "[object Object]"（15 字符），是量错了而不是刻意留窄
  const columnWidths = useMemo(
    () => (grid.rows.length ? fitColumnWidths(grid.rows, Object.keys(grid.rows[0])) : {}),
    [grid.rows]
  )

  // 列头排序箭头跟随 view.order（受控）：箭头由 ColHead 自己画，状态只有
  // view.order 一处来源，视角条 chips 一改（比如重置）箭头就跟着回位
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
  // H1a-4：hiddenColumns 的小写集合单独给出，列工厂的 isVisible 谓词用它
  const hiddenColumnSet = () => new Set((view.hiddenColumns || []).map(h => String(h).toLowerCase()))
  const visibleColumnNames = (keys) => {
    const hidden = hiddenColumnSet()
    return orderedColumnNames(keys)
      .filter(k => !hidden.has(String(k).toLowerCase()))
  }
  // 数据页行对象上的 __rowKey 是网格辅助键（选中/编辑/过滤定位），不是数据列：
  // 从 Object.keys(row) 取列时会跟着进来，复制整行/行详情必须剔掉，
  // 否则导出的那一列是一串与表结构无关的内部下标
  const rowColumnNames = (row) => visibleColumnNames(
    Object.keys(row || {}).filter(k => k !== '__rowKey')
  )

  // H2：数据页单元格右键菜单。落点与菜单项在这里生成，浮层本身是全站单例
  // （DbCellMenu）。列序与导出同源（visibleColumnNames）：复制整行拿到的
  // 就是屏幕上看到的那些列。
  // 外键项只算"本表外键 → 父表"这一向：本地即可判定，不依赖反向引用查询
  // 是否已经为该列返回（refInfo 属于"当前选中格"，右键的格未必就是它）
  const openDataCellMenu = (ev, row, k) => {
    ev.preventDefault()
    if (!sel || !row) {
      return
    }
    const v = row[k]
    const headers = rowColumnNames(row)
    // 过滤词用"格子里看到的文本"：本页过滤比的就是这个（cellText），
    // 复制值那套二进制 base64 在这里没有意义。空串/纯空白给不出词，不提供该项
    const filterText = cellText(v)
    const items = [
      {
        // 与值面板的复制同口径：二进制信封复制 base64，其余复制可读文本
        key: 'value',
        text: e('dbCellCopyValue'),
        onClick: () => copy(isBinEnvelope(v) ? v.__bin.b64 : cellText(v))
      },
      {
        key: 'colname',
        text: e('dbCellCopyColName'),
        onClick: () => copy(k)
      },
      {
        key: 'rowTsv',
        text: e('dbCellCopyRowTsv'),
        onClick: () => copy(toTsv(headers, [row]))
      },
      {
        key: 'rowJson',
        text: e('dbCellCopyRowJson'),
        onClick: () => copy(buildCopyStatements('json', { headers, rows: [row] }))
      },
      {
        // 选中该格 → 底部值面板展开（与单击同一入口，可编辑态也一致）
        key: 'valuePane',
        text: e('dbCellValuePane'),
        onClick: () => selectCell(row, k)
      }
    ]
    if (canEditCell) {
      items.push({
        key: 'edit',
        text: e('dbCellEdit'),
        onClick: () => startEdit(row, k)
      })
    }
    if (filterText.trim()) {
      items.push({
        // 写进现有本页过滤：命中口径、高亮、"清空过滤"按钮都走同一条路
        key: 'filter',
        text: e('dbCellFilterByValue'),
        onClick: () => setPageFilter(filterText)
      })
    }
    const parents = buildRefItems({
      column: k,
      row,
      foreignKeys: (structureV2Ref.current && structureV2Ref.current.foreignKeys) || [],
      references: [],
      database: sel.database,
      schema: sel.schema || '',
      dialect
    })
    for (const item of parents) {
      // NULL / 二进制定位值不能拼 WHERE：与关联页签同一判定，不给出点了没用的项
      if (item.unusable) {
        continue
      }
      items.push({
        key: item.key,
        text: e('dbCellOpenRef').replace('{table}', item.target.table),
        onClick: () => openRefTable(item)
      })
    }
    setCellMenu({ x: ev.clientX, y: ev.clientY, head: k, items })
  }

  // 列宽三源（拖拽中 > 手动 > 自适应 > 90）与拖拽机构抽到 useColWidths，
  // 5 处网格共用同一套。数据页把手动宽提交回**持久化视角**，所以 H1a-2 之后
  // 的行为与之前逐字一致（拖完落盘、切表回来还在）；差别只是实现换了地方 +
  // 起点改用 th 实测宽（不再有"按下第一帧跳回配置宽"的抖动）
  const dataWidths = useColWidths({
    manual: view.columnWidths,
    commit: (upd) => patchViewColumns({
      columnWidths: upd(viewRef.current.columnWidths || {})
    }),
    fitted: columnWidths
  })
  const { live: dataLive } = dataWidths

  // H1a-2：工具行的"自适应全部列"（4 处网格同一个形状）。只在有手动宽时可点：
  // 没拖过/加宽过时按下去不会有任何变化，禁用比"点了没反应"诚实
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

  // A1：主数据网格列定义提升为 useMemo。依赖穷举闭包引用的组件级量：
  // grid.rows（数据）、view（列序/隐藏/列宽/排序箭头）、dataLive（列宽拖拽中）、
  // renderCell（高亮/格式化）、editing/editValue（行内编辑态）、canEditCell（只读态）、
  // pageFilterKw（本页过滤高亮）、colTypeByName/colCommentByName（类型与注释）、
  // langCode（列内 e() 文案随语言切换）、sel/pkColumn（submitEdit → runCellUpdate
  // 的 UPDATE 目标与 WHERE 列；事件处理器本身是每轮新建的闭包，缓存后必须让
  // 它们依赖的数据变化时重建，否则会拿着上一个表的主键拼 UPDATE）
  // ⚠️ dataWidths 里的函数（widthOf/startResize）每轮渲染都是新引用，不进依赖：
  // 进了等于每轮重建列定义，memo 白做。要重建靠的是它们读的那三个量：
  // view（手动宽）/ columnWidths（自适应宽）/ dataLive（拖拽中）
  const columns = useMemo(() => (grid.rows.length
    ? buildGridColumns({
      // H1a-4：列显隐过滤统一走列工厂的 isVisible（排序仍按全部列算）
      keys: orderedColumnNames(Object.keys(grid.rows[0])),
      isVisible: k => !hiddenColumnSet().has(String(k).toLowerCase()),
      typeMap: colTypeByName,
      commentMap: colCommentByName,
      showComment: true,
      wg: dataWidths,
      colMenu,
      wideRows: grid.rows,
      // 数据页原来只说"单击预览/双击编辑"，拖宽这件事在这里等于没人告知——
      // 手柄 hover 才显形，看不到提示就不会有人去试，所以把拖拽提示并进来。
      // 排序提示补上：箭头不再走 antd 的 sorter，也就没有它那句内置 tooltip
      hint: `${canEditCell ? e('dbPreviewEditHint') : e('dbPreviewHint')} · ${e('dbColResizeHint')} · ${e('dbColSortHint')}`,
      filterKw: pageFilterKw,
      editable: true,
      // 排序与 SQL 结果同一套：箭头画在 ColHead，点击走 onColSort 重查（服务端 ORDER BY）
      sortable: true,
      sortOf: sortOrderOf,
      onSort: onColSort,
      keyboardAccessible: true,
      // H2：右键单元格出菜单（复制/编辑/值面板/外键跳转），与 SQL 结果共用一个浮层
      cellMenu: true,
      openCellMenu: openDataCellMenu,
      selectCell,
      cellBaseClass: 'db-cell-editable',
      canEditCell,
      startEdit,
      cancelEdit,
      submitEdit,
      editing,
      editValue,
      onEditValueChange: setEditValue,
      // Escape 同时清掉选中与编辑态（原数据页 onCell onKeyDown 逐字等价）
      onClearSelection: () => {
        setSelectedCell(null)
        setEditing(null)
      },
      renderCell
    })
    : []), [grid.rows, view, dataLive, renderCell, editing, editValue, canEditCell, pageFilterKw, colTypeByName, colCommentByName, langCode, sel, pkColumn])

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

  // H1a-2：SQL 结果列宽。自适应按**各结果集**各自量（同一份手动宽 map 以
  // "下标::列名"为键，多结果集各拖各的互不影响）；手动宽只进内存、不写表视角 ——
  // 结果集的列随查询变，存进视角只会攒脏宽（决策 11），所以重新执行即清空
  const [sqlColWidths, setSqlColWidths] = useState({})
  const sqlFitted = useMemo(() => {
    const out = {}
    for (const [i, r] of (sqlResult.results || []).entries()) {
      const keys = sqlColumnKeys(r)
      const w = fitColumnWidths((r && r.rows) || [], keys)
      for (const k of keys) {
        out[i + '::' + k] = w[k]
      }
    }
    return out
  }, [sqlResult.results])
  const sqlWidths = useColWidths({
    manual: sqlColWidths,
    commit: (upd) => setSqlColWidths(prev => upd(prev)),
    fitted: sqlFitted
  })
  const { live: sqlLive } = sqlWidths

  // H1a-3：SQL 结果的列类型表（每个结果集一份，键为小写列名）。
  // 数据源是适配层新增的并列字段 `columns: [{name, type}]`（主进程
  // app/common/db-type-normalize.js 把驱动的 columnType / dataTypeID 归一成
  // DATA_TYPE 口径名）。刻意与数据页的 colTypeByName **同一套词表**，因为
  // isNumberType/isDateType 认的就是这套名字；换一套就会静默不生效。
  // 老结果（没有 columns）、列名查不到、type 为 '' 都按"不知道类型"处理：
  // 不格式化、不右对齐 —— 宁可不格式化，也不能把 varchar 右对齐。
  const sqlColTypeMaps = useMemo(
    () => (sqlResult.results || []).map(r => {
      const out = Object.create(null)
      for (const c of (r && r.columns) || []) {
        if (c && typeof c.name === 'string' && c.name) {
          out[c.name.toLowerCase()] = String(c.type || '').toLowerCase()
        }
      }
      return out
    }),
    [sqlResult.results]
  )

  // SQL 结果网格列：优先 fields（列顺序稳定），否则从首行推断
  // A1：多结果集按 results 索引派生成「列数组的数组」，随 sqlResult.results 与
  // renderCell 一起 memo —— 否则每次 render（查询进度、无关 state）都会重建列，
  // antd Table 收不到同一份 columns 引用就会整表重渲
  const sqlResultColumns = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      const typeMap = sqlColTypeMaps[i] || {}
      return buildGridColumns({
        // H1a-4：列显隐过滤统一走列工厂的 isVisible（visibleSqlKeys 的
        // 大小写口径原样保留：单列集合复用同一纯函数）
        keys: sqlColumnKeys(r),
        isVisible: k => visibleSqlKeys([k], sqlViewOf(sqlViews, i).hidden).length > 0,
        typeMap,
        // H1a-2：原来是写死 220 —— 短值列一片空白、长值列看不全，两头都难受
        wg: sqlWidths,
        // 复合键只用于宽度：列的 dataIndex/key 仍是列名（每结果集各自一张表）
        widthKeyOf: k => i + '::' + k,
        colMenu,
        wideRows: rows,
        // 宽度用的是「结果集下标::列名」，菜单标题只显示列名
        headKeyOf: k => k,
        hint: `${e('dbColResizeHint')} · ${e('dbColSortHint')}`,
        sortable: true,
        sortOf: k => sqlSortOf(sqlViews, i, k),
        onSort: k => onSqlSort(i, k),
        // H1a-4：单击选中 → 底部完整值面板（与数据页同一套：点一格就展开面板，
        // 不再先出现"单击展开"的折叠工具条）。只标"当前面板在看的那一格"，
        // 不做键盘可达（SQL 结果只读，Enter 没有下一步动作），也不给双击编辑
        cellMenu: true,
        openCellMenu: (ev, row, k) => openSqlCellMenu(ev, i, k, row),
        selectCell: (row, k) => setSqlCell({ rs: i, col: k, rowKey: row.__rowKey }),
        selectedOf: (row, k) => !!(sqlCell && sqlCell.rs === i &&
          sqlCell.col === k && sqlCell.rowKey === row.__rowKey),
        renderCell
      })
    }),
    [sqlResult.results, renderCell, sqlFitted, sqlColWidths, sqlLive, sqlColTypeMaps, sqlCell, sqlViews]
  )

  // SQL 结果渲染：单结果集直接表格；多语句多结果集用 tab 分栏
  // H1：哪些列按数值比较。类型契约在的时候以 columns[].type 为准（varchar 里
  // 放 "10"/"9" 仍是文本序）；驱动没给 columns 时才用值兜底推断。
  // 与右对齐用的是同一条 isNumberType 判定 —— 右对齐的列点表头就该按数排
  const sqlSortNumeric = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      const typeMap = sqlColTypeMaps[i] || {}
      const set = new Set()
      for (const k of sqlColumnKeys(r)) {
        const dt = typeMap[String(k).toLowerCase()] || ''
        if (dt ? isNumberType(dt) : looksNumericColumn(rows, k)) {
          set.add(k)
        }
      }
      return set
    }),
    [sqlResult.results, sqlColTypeMaps]
  )

  // A2：SQL 结果集行键数组提升到组件顶层 useMemo（依赖组件级 sqlResult.results），
  // 避免传输进度等无关重渲触发 antd Table 全行重渲。
  // 分页后只克隆当前页的行（__rowKey 用结果内的绝对下标，翻页不重复也不冲突）
  // H1：过滤 → 排序 → 切页。matched 与 pageRows 同一次派生出来，所以"命中/总数"、
  // 分页器页数、网格里看到的行数永远同一口径（不会出现"共 3 页"而筛完只剩 5 行）
  const sqlResultViews = useMemo(
    () => (sqlResult.results || []).map((r, i) => {
      const rows = (r && r.rows) || []
      // 过滤只扫可见列：筛的是"看到的东西"，藏起来的列不再参与命中，
      // 否则会出现"筛出一堆行却看不出哪列命中的"假案
      const keys = visibleSqlKeys(sqlColumnKeys(r), sqlViewOf(sqlViews, i).hidden)
      const indexes = filterRowIndexes(rows, keys, sqlViewOf(sqlViews, i).filter)
      const ordered = sortRowIndexes(rows, indexes, sqlViewOf(sqlViews, i).sort, sqlSortNumeric[i])
      const start = (sqlPageIndex(sqlPages[i], ordered.length, sqlPageSize) - 1) * sqlPageSize
      return {
        total: rows.length,
        matched: ordered.length,
        pageRows: ordered.slice(start, start + sqlPageSize).map(idx => ({ ...rows[idx], __rowKey: idx }))
      }
    }),
    [sqlResult.results, sqlPages, sqlPageSize, sqlViews, sqlSortNumeric]
  )

  const renderSqlResults = () => {
    const results = sqlResult.results || []
    if (!results.length) {
      return null
    }
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
                    onChange={changeSqlPageSize}
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
              // H1：右侧状态行。行数用命中口径 —— 筛完显示"筛出来的行数"，
              // 与网格所见一致（总数在过滤框旁的命中/总数里）；耗时是整次执行的
              // 总耗时，多结果集共享一份（各页签旁另标"总 {n} ms"）
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
    if (results.length === 1) {
      return renderOne(results[0], 0)
    }
    return (
      <Tabs
        size='small'
        className='db-sql-results-tabs'
        items={results.map((r, i) => ({
          key: String(i),
          // 多结果集共享一份总耗时，标在每个页签旁（各结果集不单独计时）
          label: e('dbResultN').replace('{n}', i + 1) + (
            sqlResult.elapsedMs !== null
              ? ' · ' + e('dbSqlElapsedTotal').replace('{ms}', sqlResult.elapsedMs)
              : ''
          ),
          children: renderOne(r, i)
        }))}
      />
    )
  }

  // H1a-4：选中格的完整值面板数据。按 (rs, rowKey, col) 现取、不复制值 ——
  // 一次执行可能是 1 万行的大数组。行取不到（重新执行把结果换了、页码越界）就当
  // 没选中，工具条与面板一起消失，不留一个指向空气的标题
  const sqlCellInfo = useMemo(() => {
    if (!sqlCell) {
      return null
    }
    const results = sqlResult.results || []
    const r = results[sqlCell.rs]
    const row = r && Array.isArray(r.rows) ? r.rows[sqlCell.rowKey] : null
    if (!row) {
      return null
    }
    const value = row[sqlCell.col]
    const type = (sqlColTypeMaps[sqlCell.rs] || {})[String(sqlCell.col).toLowerCase()] || ''
    // 多结果集时必须标出是哪一集：页签在上面、面板在下面，只写列名会对不上号
    const head = results.length > 1
      ? e('dbResultN').replace('{n}', sqlCell.rs + 1) + ' · '
      : ''
    return {
      value,
      column: { name: sqlCell.col, type, isBinary: isBinaryType(type) },
      title: head + sqlCell.col + ' · ' + e('dbRowN').replace('{n}', Number(sqlCell.rowKey) + 1),
      meta: isBinEnvelope(value)
        ? value.__bin.size + ' bytes'
        : (typeof value === 'string' && value.length > VALUE_META_MIN ? value.length + ' chars' : '')
    }
  }, [sqlCell, sqlResult.results, sqlColTypeMaps])

  // 展开态：复用数据页那个 DbValuePane（editable=false → 没有编辑/保存入口，
  // 但格式切换、高亮、复制、选区右键复制都还在）。× = 取消选中、面板收起，
  // 与数据页点击打开下方预览框的交互对齐（点一格就展开，不再先出一行提示条）
  const sqlValuePane = sqlCellInfo
    ? (
      <DbValuePane
        title={sqlCellInfo.title}
        meta={sqlCellInfo.meta}
        value={sqlCellInfo.value}
        column={sqlCellInfo.column}
        patterns={keywordPatterns}
        themeConfig={themeConfig}
        editable={false}
        onClose={() => setSqlCell(null)}
      />
      )
    : null

  // "展开"要真的有东西可展：重新执行会清掉选中（sqlCellInfo 变 null），
  // 此时 bottom 必须是 null，否则半屏空容器会把网格压成一小条
  const sqlPaneShown = !!sqlCellInfo

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
        // B2：过程(P)/函数(F)/触发器(T)/事件(E) 同理，统一用「小方块 + 单字母」
        const mark = node.type === 'view' ? 'V' : (DB_OBJECT_MARKS[node.type] || '')
        return {
          title: mark
            ? (
              <span className='db-tree-view'>
                <span className='db-tree-view-mark'>{mark}</span>
                {treeTitle(node.name)}
              </span>
              )
            : treeTitle(node.name),
          key: nodeKey(dbName, schema, node.name),
          isLeaf: true,
          // 类型随节点走：后续按钮门控（视图不可插入行）要它
          nodeType: node.type,
          // B2：对象定位信息（PG 函数需签名区分重载、触发器需表名）——
          // 只挂在树节点上，不进 metadata 契约之外的持久化
          objMeta: isDbObjectType(node.type)
            ? { signature: node.signature || '', table: node.table || '' }
            : undefined
        }
      }
      // B2：库内对象分组（过程与函数 / 触发器 / 事件）。分组本身不可选中，
      // 只负责收起，避免几百个过程把表名挤出屏幕
      if (node.type === 'group') {
        return {
          title: (
            <span className='db-tree-schema'>
              <span className='db-tree-group-mark'>G</span>
              {treeTitle(e(DB_GROUP_LABEL[node.group] || 'dbRoutines'))}
            </span>
          ),
          key: nodeKey(dbName, schema, node.name),
          children: toTreeChildren(dbName, schema, node.children)
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
  const pageSizeOptions = dbPageSizeOptions()
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
  // （redis 走 SCAN 游标，没有服务端估算，总页数只在无过滤时按 INFO keyspace 键数
  // 换算，见下面 redisKeyPagesOf 与键列表分页条）
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

  // ---- E2-3b 命令面板（Ctrl/Cmd+K）：四类来源 ----

  const [quickOpen, setQuickOpen] = useState(false)
  // U1c：数据/SQL/结构主页签改受控 —— 空态的"打开 SQL"要能切页；
  // 三个 pane 都 forceRender，切页不重置各自的本地状态
  const [mainTab, setMainTab] = useState('data')

  // 快捷键挂在 window 上：焦点在 SQL 编辑器（CM6）或网格里时按键也要生效。
  // Ctrl/Cmd+P 一律不拦（那是打印/其他面板的键）；带 shift/alt 的组合不是本
  // 功能的键位，放行不抢 —— 判据只有 metaKey/ctrlKey + 纯 'k'
  useEffect(() => {
    const onKey = (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) {
        return
      }
      if (String(ev.key).toLowerCase() !== 'k') {
        return
      }
      ev.preventDefault()
      setQuickOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 面板打开时顺手刷新历史：历史走 IPC 异步读，不刷新就只会看到上一次
  // 打开历史弹层时的快照，面板里的"最近 SQL"永远是旧的
  useEffect(() => {
    if (quickOpen) {
      listSqlHistory()
        .then(setSqlHistory)
        .catch(err => console.warn('load sql history failed:', err))
    }
  }, [quickOpen])

  // 来源一（动作）：只挂"已存在"的功能入口，run 直接复用本文件里既有按钮的
  // 同一条闭包 —— 报错通道也是现成的（这些函数自己会 onOpError /
  // message.error），面板层不重复弹错。不在这里发明新动作。
  const quickActions = useMemo(() => [
    {
      kind: 'action',
      id: 'runSql',
      title: e('dbRun'),
      subtitle: '',
      hint: 'Ctrl/Cmd+Enter',
      run: runSql
    },
    {
      kind: 'action',
      id: 'formatSql',
      title: e('dbFormatSql'),
      subtitle: '',
      hint: 'Ctrl/Cmd+Shift+F',
      run: formatSqlEditor
    },
    {
      kind: 'action',
      id: 'toggleReadonly',
      title: e('readOnly'),
      subtitle: '',
      hint: '',
      // 与只读开关同一入口：先同步主进程成功再改本地，顺序在 toggleReadonly 里
      run: () => toggleReadonly(!isReadonly)
    },
    {
      kind: 'action',
      id: 'refreshTable',
      title: e('refresh'),
      subtitle: '',
      hint: '',
      // 与网格头"刷新"按钮同一条链路：清过滤/选中、清 count 指纹再按当前
      // 页码重取 —— 只调 loadWithCount 会留下过期的总数
      run: () => {
        if (!sel) {
          return
        }
        resetPageFilter()
        resetExactRows()
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      }
    },
    {
      kind: 'action',
      id: 'exportCsv',
      title: 'CSV',
      subtitle: '',
      hint: '',
      // 标题沿用导出菜单的裸格式名（那份菜单就没走词条），不加新文案
      run: exportGridCsv
    },
    {
      kind: 'action',
      id: 'exportJson',
      title: 'JSON',
      subtitle: '',
      hint: '',
      run: () => exportGridAs('json')
    }
  ], [runSql, formatSqlEditor, isReadonly, sel, grid.page, loadWithCount, exportGridCsv, exportGridAs])

  // 来源二（对象）：直接走 metadata（树的数据源）而不走 flattenTables ——
  // 那个只回表名，丢掉了"选表"要用的 库/schema 信息。run 复用树点击的
  // onSelectTree：选表 = 结构 → 视角 → 首页 的完整链路，竞态令牌、页面重置
  // 都在里面，面板自己再拼一遍必然漏。PG 同库可能有同名表（不同 schema），
  // subtitle 带上库名（或 schema）作定位
  const quickObjects = useMemo(() => {
    if (isRedis) {
      return []
    }
    const out = []
    for (const db of metadata || []) {
      if (!db || !db.name) {
        continue
      }
      const walk = (schema, nodes) => {
        for (const node of nodes || []) {
          if (isLeafNode(node)) {
            out.push({
              kind: 'object',
              id: nodeKey(db.name, schema, node.name),
              title: node.name,
              subtitle: schema ? `${db.name}.${schema}` : db.name,
              // 与树的视图标记共用同一视觉语言（小字 V/P/F/T/E），不算文案不进词条
              hint: node.type === 'view' ? 'V' : (DB_OBJECT_MARKS[node.type] || ''),
              run: () => onSelectTree(null, {
                node: {
                  key: nodeKey(db.name, schema, node.name),
                  isLeaf: true,
                  nodeType: node.type,
                  objMeta: isDbObjectType(node.type)
                    ? { signature: node.signature || '', table: node.table || '' }
                    : undefined
                }
              })
            })
          } else if (Array.isArray(node.children)) {
            // B2：分组节点（routines/triggers/events）不改变 schema 归属，
            // 否则 subtitle 会变成 db.routines 这种假 schema
            walk(node.type === 'group' ? schema : node.name, node.children)
          }
        }
      }
      walk('', db.children)
    }
    return out
  }, [isRedis, metadata, onSelectTree])

  // 来源三（历史前 20）：title 取 SQL 首行截断 —— 多行语句在面板里放不下，
  // 完整语句选中后回填编辑器可见。run 与历史弹层的 pickSqlHistory 同一条
  // 回填路径（setSqlText(item.sql)）
  const quickHistory = useMemo(() => (sqlHistory || [])
    .slice(0, 20)
    .map((h, i) => {
      const firstLine = previewText(h && h.sql).split('\n')[0].slice(0, 80)
      if (!firstLine) {
        return null
      }
      return {
        kind: 'history',
        id: `hist:${h.ts}:${i}`,
        title: firstLine,
        subtitle: '',
        hint: '',
        run: () => setSqlText(h.sql)
      }
    })
    .filter(Boolean), [sqlHistory])

  // 来源四（当前表相关）：structureV2.columns 的列名。kind 归入 object ——
  // 打分/分组只有三类，列本来就是"对象"的子集；与表在视觉上靠 hint（类型）
  // 区分，subtitle 放注释。只挂当前选中表的列：没有选中表时面板少一组而已
  const quickColumns = useMemo(() => {
    if (!sel || isRedis) {
      return []
    }
    return (structureV2.columns || [])
      .filter(c => c && typeof c.name === 'string' && c.name)
      .map(c => ({
        kind: 'object',
        id: `col:${c.name}`,
        title: c.name,
        subtitle: typeof c.comment === 'string' ? c.comment.trim() : '',
        hint: String(c.dataType || ''),
        // 编辑器句柄（db-sql-editor 的 useImperativeHandle）没暴露光标处插入
        // 的 API；为不动编辑器文件，退化为把列名追加到当前语句末尾
        run: () => setSqlText(t => {
          const base = typeof t === 'string' ? t : ''
          return base && !/\s$/.test(base) ? base + ' ' + c.name : base + c.name
        })
      }))
  }, [sel, isRedis, structureV2.columns])

  const quickItems = useMemo(() => [
    ...quickActions,
    ...quickObjects,
    ...quickHistory,
    ...quickColumns
  ], [quickActions, quickObjects, quickHistory, quickColumns])

  // ---- A1/A2 网格列定义与行数组 memo（集中放在这里，**不能**放到下面的
  // error/!ready 提前 return 之后）----
  // ⚠️ hooks 数量不能在渲染间变化：本组件有 `if (error) return` / `if (!ready) return`
  // 两条提前返回，连接建立（ready false → true）时渲染会从"少若干 hook"变成
  // "多若干 hook"，把 useMemo 写在提前返回之后会直接抛
  // "Rendered more hooks than during the previous render"。以下 memo 的依赖
  // （structure / keyList / redisDetail / detailLimit / renderCell / langCode）
  // 全部在本行之前已声明。

  // A2：表结构行键数组（依赖 structure.rows）
  const structureRows = useMemo(
    () => structure.rows.map((r, i) => ({ ...r, __rowKey: i })),
    [structure.rows]
  )

  // ---- H1a-2：表结构 / Redis 键列表的列宽（内存态，同 SQL 结果一个道理：
  // 这两处都不是"某张表的视角"，写进视角没有归属）----
  const [structColWidths, setStructColWidths] = useState({})
  const structFitted = useMemo(
    () => (structure.rows.length ? fitColumnWidths(structure.rows, Object.keys(structure.rows[0])) : {}),
    [structure.rows]
  )
  const structWidths = useColWidths({
    manual: structColWidths,
    commit: (upd) => setStructColWidths(prev => upd(prev)),
    fitted: structFitted
  })
  const { live: structLive, widthOf: structWidthOf } = structWidths

  const [redisColWidths, setRedisColWidths] = useState({})
  const commitRedisColWidths = (upd) => setRedisColWidths(prev => upd(prev))
  const redisKeysFitted = useMemo(
    () => fitColumnWidths(keyList.rows || [], ['name', 'type', 'ttl']),
    [keyList.rows]
  )
  const redisKeysWidths = useColWidths({
    manual: redisColWidths,
    commit: commitRedisColWidths,
    fitted: redisKeysFitted
  })
  const { live: redisKeysLive, widthOf: redisKeysWidthOf } = redisKeysWidths

  // A1：表结构列定义（列名随驱动动态生成，仅依赖 structure.rows 与 renderCell）
  const structColumns = useMemo(() => (structure.rows.length
    ? Object.keys(structure.rows[0]).map(k => ({
      // H1a-2：写死 200 → 按内容自适应 + 可拖 / 可加宽（注释、默认值这两列最常超长）
      title: (
        <ColHead
          label={k}
          colKey={k}
          wg={structWidths}
          hint={e('dbColResizeHint')}
        />
      ),
      dataIndex: k,
      key: k,
      width: structWidthOf(k),
      ellipsis: CELL_ELLIPSIS,
      onHeaderCell: () => ({
        onContextMenu: ev => colMenu.openColMenu(ev, {
          wg: structWidths,
          key: k,
          wide: wideColumnWidth(structure.rows, k)
        })
      }),
      // H1a-1：注释/默认值这类长文本列此前悬停什么都看不到
      // PG 主键列显示 PK 徽标；MySQL 沿用 DESC 的 Key=PRI 文本
      render: k === 'is_primary_key'
        ? v => (v === true ? <Tag className='db-pk-tag'>PK</Tag> : '')
        : renderCell
    }))
    : []), [structure.rows, renderCell, structFitted, structColWidths, structLive])

  // A1：Redis 键列表列定义（列头文案来自 e() → langCode 一并入依赖，
  // 切换界面语言时列头跟着变；其余仅依赖 renderCell）
  // H1a-2：三列都可拖/可加宽。键名列原来根本没有宽度（长键名只能靠运气），
  // 现在按内容量到 90~360，长键名再加宽到 720 或拖到手感合适
  const redisKeyColumns = useMemo(() => [
    {
      title: (
        <ColHead
          label={e('dbKey')}
          colKey='name'
          wg={redisKeysWidths}
          hint={e('dbColResizeHint')}
        />
      ),
      dataIndex: 'name',
      key: 'name',
      width: redisKeysWidthOf('name'),
      ellipsis: CELL_ELLIPSIS,
      onHeaderCell: () => ({
        onContextMenu: ev => colMenu.openColMenu(ev, {
          wg: redisKeysWidths,
          key: 'name',
          head: e('dbKey'),
          wide: wideColumnWidth(keyList.rows || [], 'name')
        })
      }),
      render: v => renderCell(v)
    },
    {
      title: (
        <ColHead
          label={e('type')}
          colKey='type'
          wg={redisKeysWidths}
          hint={e('dbColResizeHint')}
        />
      ),
      dataIndex: 'type',
      key: 'type',
      width: redisKeysWidthOf('type'),
      ellipsis: CELL_ELLIPSIS,
      onHeaderCell: () => ({
        onContextMenu: ev => colMenu.openColMenu(ev, {
          wg: redisKeysWidths,
          key: 'type',
          head: e('type'),
          wide: wideColumnWidth(keyList.rows || [], 'type')
        })
      }),
      render: v => renderCell(v)
    },
    {
      title: (
        <ColHead
          label={e('dbTtl')}
          colKey='ttl'
          wg={redisKeysWidths}
          hint={e('dbColResizeHint')}
        />
      ),
      dataIndex: 'ttl',
      key: 'ttl',
      width: redisKeysWidthOf('ttl'),
      ellipsis: CELL_ELLIPSIS,
      onHeaderCell: () => ({
        onContextMenu: ev => colMenu.openColMenu(ev, {
          wg: redisKeysWidths,
          key: 'ttl',
          head: e('dbTtl'),
          wide: wideColumnWidth(keyList.rows || [], 'ttl')
        })
      }),
      render: v => renderCell(v)
    }
  ], [renderCell, langCode, redisKeysFitted, redisColWidths, redisKeysLive, keyList.rows])

  // A2：Redis 键列表行键数组（依赖 keyList.rows），避免 SCAN 进度/详情加载等
  // 无关重渲触发 antd Table 全行重渲
  const redisKeyRows = useMemo(
    () => (keyList.rows || []).map((r, i) => ({ ...r, __rowKey: i })),
    [keyList.rows]
  )

  // H7b-3：行键改用键名，勾选才跟着键走（__rowKey 是下标，翻页后指向别的键）。
  // preserveSelectedRowKeys：翻页后行不在 dataSource 里，不保留就等于"只删得动本页"
  const redisKeyRowSelection = useMemo(() => ({
    selectedRowKeys: redisKeySel,
    preserveSelectedRowKeys: true,
    onChange: keys => setRedisKeySel(keys),
    // 与数据网格同一个坑：不给 columnWidth 时 colgroup 里没有宽度，
    // 表头/表体两套 table 会把勾选列撑成剩余宽（实测 1894px），键名被挤出视野
    columnWidth: SEL_COL_W,
    getCheckboxProps: () => ({ disabled: isReadonly })
  }), [redisKeySel, isReadonly])

  // 弹层里的键名预览（前 20 个 + 还有多少）
  const redisDelPreview = useMemo(() => delPreview(redisDel.keys), [redisDel.keys])

  // A2：Redis 各类型详情的行键数组（依赖 redisDetail / detailLimit）
  const redisHashRows = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'hash') {
      return []
    }
    const hashFields = d.fields || []
    return hashFields.map((f, i) => ({ field: f, value: d.rows[f], __rowKey: i }))
  }, [redisDetail])

  const redisListRows = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'list') {
      return []
    }
    const listRows = (d.rows || []).slice(0, detailLimit)
    return listRows.map((v, i) => ({ index: i, value: v, __rowKey: i }))
  }, [redisDetail, detailLimit])

  const redisSetRows = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'set') {
      return []
    }
    const setRows = d.rows || []
    return setRows.map((v, i) => ({ member: v, __rowKey: i }))
  }, [redisDetail])

  const redisZsetRows = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'zset') {
      return []
    }
    // zrange WITHSCORES 返回 [member, score, ...] 扁平数组
    const rows = (d.rows || []).slice(0, detailLimit * 2)
    const list = []
    for (let i = 0; i < rows.length; i += 2) {
      list.push({ member: rows[i], score: rows[i + 1], __rowKey: i })
    }
    return list
  }, [redisDetail, detailLimit])

  // H7b-4：stream 的三份派生数据 —— 元信息/消费组/条目都是原始回包，
  // 形状随 RESP 与 Redis 版本变，归一放在 common/db-redis-stream.js（可直测）
  const redisStreamInfo = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'stream') {
      return null
    }
    return parseXinfoStream(d.streamInfo)
  }, [redisDetail])

  const redisStreamGroups = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'stream') {
      return null
    }
    // null 与 [] 是两件事：null = 拿不到组列表（XINFO 被禁），[] = 真的没有组
    return d.streamGroups === null || d.streamGroups === undefined
      ? null
      : parseXinfoGroups(d.streamGroups)
  }, [redisDetail])

  const redisStreamEntries = useMemo(() => {
    const d = redisDetail
    if (!d || d.type !== 'stream') {
      return []
    }
    return parseXrangeEntries(d.rows)
  }, [redisDetail])

  // 当前详情类型对应的那份行数组（五张表各有一份 memo，值面板按 rowKey 回查用同一份，
  // 不复制值 —— 一个大 value 拷一次没必要）
  const redisDetailRows = useMemo(() => {
    const d = redisDetail
    if (!d) {
      return []
    }
    if (d.type === 'hash') {
      return redisHashRows
    }
    if (d.type === 'list') {
      return redisListRows
    }
    if (d.type === 'set') {
      return redisSetRows
    }
    if (d.type === 'zset') {
      return redisZsetRows
    }
    if (d.type === 'stream') {
      return redisStreamEntries
    }
    return []
  }, [redisDetail, redisHashRows, redisListRows, redisSetRows, redisZsetRows, redisStreamEntries])

  // H1a-2b：Redis 详情的列宽（内存态，与表结构/键列表同一处理：详情不是"某张表的视角"，
  // 写进视角没有归属）。手动宽按**键类型分桶**存（`{ hash: { value: 720 }, zset: { member: 400 } }`）：
  // 哈希的"值"和列表的"值"是同名字段，共用一份就会拖一处改另一处；分桶后
  // 列头菜单的"自适应全部列"也只清当前这一张表，不会把没在看的类型的宽度一起抹掉
  const [redisDetailColWidths, setRedisDetailColWidths] = useState({})
  const redisDetailType = redisDetail ? String(redisDetail.type || '') : ''
  const redisDetailFitted = useMemo(() => {
    if (!redisDetailRows.length) {
      return {}
    }
    return fitColumnWidths(redisDetailRows, Object.keys(redisDetailRows[0]).filter(k => k !== '__rowKey'))
  }, [redisDetailRows])
  const redisDetailWidths = useColWidths({
    manual: redisDetailColWidths[redisDetailType] || {},
    commit: (upd) => setRedisDetailColWidths(prev => {
      const cur = prev[redisDetailType] || {}
      return { ...prev, [redisDetailType]: upd(cur) }
    }),
    fitted: redisDetailFitted
  })
  // 详情列定义是渲染里就地重建的（列随键类型换），live 宽由 widthOf 直接读到，
  // 不像那 4 处 memo 化列定义要把 live 放进依赖数组
  const { widthOf: redisDetailWidthOf } = redisDetailWidths

  // 选中格的完整值面板数据。行按 rowKey 现取：详情换了（重新选键、类型不支持）
  // 就当作没选中，面板跟着收起，不留一个指向空气的标题
  const redisCellInfo = useMemo(() => {
    if (!redisCell) {
      return null
    }
    const row = redisDetailRows.find(r => r.__rowKey === redisCell.rowKey)
    if (!row) {
      return null
    }
    const value = row[redisCell.col]
    return {
      value,
      column: { name: redisCell.col, type: '', isBinary: isBinEnvelope(value) },
      title: redisCell.label + ' · ' + e('dbRowN').replace('{n}', redisCell.rowNo),
      meta: typeof value === 'string' && value.length > VALUE_META_MIN
        ? value.length + ' chars'
        : ''
    }
  }, [redisCell, redisDetailRows])

  // 单击那一格：与双击行内编辑共存（单击先开面板，双击仍进编辑），列标签由调用方给
  // （Redis 详情的列名是译文的"字段/值/成员/分数"，不是数据字段名）
  const redisCellProps = (col, label) => (record, index) => ({
    className: (redisCell && redisCell.col === col && redisCell.rowKey === record.__rowKey
      ? 'db-cell-selected'
      : ''),
    onClick: () => setRedisCell({ col, label, rowKey: record.__rowKey, rowNo: (index || 0) + 1 })
  })

  const redisValuePane = redisCellInfo
    ? (
      <DbValuePane
        title={redisCellInfo.title}
        meta={redisCellInfo.meta}
        value={redisCellInfo.value}
        column={redisCellInfo.column}
        patterns={keywordPatterns}
        themeConfig={themeConfig}
        editable={false}
        onClose={() => setRedisCell(null)}
      />
      )
    : null

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
  // 连接目标文本（顶部工具条与空态共用）。不带引擎名 —— 引擎已由左侧徽标表达，
  // 避免"Redis Redis ·…"重复
  const target = [
    tab.dbHost ? `${tab.dbHost}:${tab.dbPort || ''}` : tab.title,
    tab.dbName,
    tab.dbUser
  ].filter(Boolean).join(' · ')
  // 值预览面板：值/关联两处都要用，提出来避免重复 JSX
  const valuePaneEl = (
    <DbValuePane
      title={selectedCell ? selectedCell.col + ' · ' + e('dbRowN').replace('{n}', Number(selectedCell.rowKey) + 1) : ''}
      meta={panelMeta}
      value={panelValue}
      column={panelColumn}
      patterns={keywordPatterns}
      themeConfig={themeConfig}
      editable={canEditCell}
      editDisabledTitle={isReadonly ? e('dbErrReadOnly') : e('dbNoPrimaryKey')}
      saving={grid.loading}
      onSave={v => selectedCell && runCellUpdate(selectedCell.rowKey, selectedCell.col, v)}
      onClose={() => setSelectedCell(null)}
    />
  )
  // H2：底部"行"页签 —— 复用 H1 的行详情渲染体（DbRowDetail），与 SQL 结果的
  // 行详情 Modal 同一份字段/折叠/复制逻辑。字段序与"复制整行"同源（rowColumnNames），
  // 类型查 colTypeByName（小写键）。只读：改值仍走"值"页签里的编辑框
  const selectedRow = selectedCell ? grid.rows[selectedCell.rowKey] : null
  const rowPaneEl = selectedRow
    ? (
      <div className='db-row-tab'>
        <DbRowDetail
          columns={rowColumnNames(selectedRow)}
          row={selectedRow}
          types={colTypeByName}
        />
      </div>
      )
    : null
  // 值 + 行（+ 关联）：showRefTab 为 false 时不挂关联页签
  const detailTabItems = [
    {
      key: 'value',
      label: e('dbTabValue'),
      children: valuePaneEl
    },
    {
      key: 'row',
      label: e('dbTabRow'),
      children: rowPaneEl
    }
  ]
  if (showRefTab) {
    detailTabItems.push({
      key: 'refs',
      label: e('dbTabRefs'),
      children: (
        <DbRefsPane
          items={refItems}
          dialect={dialect}
          tabId={tabId}
          degraded={refInfo.degraded}
          loading={refInfo.loading}
          onOpen={openRefTable}
        />
      )
    })
  }
  const refTabsEl = (
    <Tabs
      size='small'
      className='db-pane-tabs'
      items={detailTabItems}
    />
  )
  const emptyPaneEl = (
    <div className='db-pane-empty'>
      <Empty description={e('dbSelectCell')} />
    </div>
  )
  const bottomEl = selectedCell && grid.rows[selectedCell.rowKey]
    ? refTabsEl
    : emptyPaneEl

  // U1d：数据页状态行文案。放在 dataArea 之前，让"总数为空时不画分隔点"只判一次
  const gridRowsText = e('dbGridPageRows').replace('{n}', String(grid.rows.length))
  const gridTotalText = exactRows.value !== null
    ? `${e('dbExactRows')}: ${exactRows.value}`
    : (typeof grid.totalRows === 'number' ? `${e('approxRows')}: ${grid.totalRows}` : '')
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
                {/* 本页行数与总数并排：只有"总行数（约）"说不清这一屏拿到多少行 */}
                <span className='db-grid-page-rows'>{gridRowsText}</span>
                {
                  gridTotalText
                    ? <span className='db-grid-dot'>·</span>
                    : null
                }
                {
                  exactRows.value === null
                    ? (gridTotalText ? <span>{gridTotalText}</span> : null)
                    : (
                      <>
                        <span>{gridTotalText}</span>
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
                {/* H1a-4：过滤输入与 SQL 结果页统一走 DbGridFilter（状态仍归本页） */}
                <DbGridFilter
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
                  count={pageFilterKw ? `${filteredRows.length} / ${grid.rows.length}` : null}
                />
                {
                  // B3-1：选中单元格即显示该列聚合（本页 = 当前显示行）。
                  // 只读展示，不写库、不发 SQL —— 需要全表聚合去 SQL 页签
                  cellSummary
                    ? (
                      <Tooltip
                        title={`${cellSummary.column} · ${e('dbAggHint')}`}
                      >
                        <span className='db-cell-summary'>
                          {summaryText(cellSummary)}
                          {
                            cellSummary.nulls
                              ? <span className='db-cell-summary-null'>NULL {cellSummary.nulls}</span>
                              : null
                          }
                        </span>
                      </Tooltip>
                      )
                    : null
                }
              </>
              )
            : null
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
          // H1a-2：一键回到"按内容自适应"（清掉这一张表拖过/加宽过的手动宽）
          sel && grid.rows.length
            ? colFitAllBtn(dataWidths)
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
          // A4 导出菜单：CSV/JSON/SQL INSERT（内存导当前页）+ 导出到文件（C 批流式导出），
          // 范围同 A1（选中为选中，无选中为当前页）
          sel && grid.rows.length
            ? (
              <Dropdown
                menu={{
                  items: [
                    { key: 'csv', label: 'CSV' },
                    { key: 'json', label: 'JSON' },
                    { key: 'sql', label: e('dbExportSql') },
                    { type: 'divider' },
                    { key: 'file', label: e('dbExportToFile') }
                  ],
                  onClick: ({ key }) => {
                    if (key === 'file') {
                      openExportDialog()
                    } else if (key === 'csv') {
                      exportGridCsv()
                    } else {
                      exportGridAs(key)
                    }
                  }
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
          // C 批导入入口：只读禁用（主进程 getDbTabContext.readOnly 兜底由阶段 1 保证）；
          // 视图同样不提供导入（INSERT INTO 视图两引擎都可能直接拒绝）
          sel && !isRedis
            ? (
              <Tooltip title={isReadonly ? e('dbImportReadonly') : e('dbImportTitle')}>
                <Button
                  size='small'
                  icon={<UploadOutlined />}
                  disabled={isReadonly || sel.nodeType === 'view'}
                  onClick={() => setImportOpen(true)}
                />
              </Tooltip>
              )
            : null
        }
        {
          // F2 手动事务：开关 + 待提交清单 + 提交/回滚。事务挂在连接上，
          // 不依赖当前选中表；只读模式没有写入口，不展示
          txSupported && !isReadonly
            ? (
              <span className='db-tx-bar'>
                <Tooltip title={txActive ? e('dbTxManualHint') : e('dbTxAutoHint')}>
                  <span className='db-tx-switch'>
                    <Switch
                      size='small'
                      checked={txActive}
                      loading={txBusy}
                      onChange={setManualTx}
                    />
                    <span className='db-tx-switch-label'>
                      {txActive ? e('dbTxManual') : e('dbTxAuto')}
                    </span>
                  </span>
                </Tooltip>
                {
                  txActive
                    ? (
                      <>
                        <Button
                          size='small'
                          className='db-tx-pending'
                          onClick={() => setTxListOpen(true)}
                        >
                          {e('dbTxPending').replace('{n}', String(txPending))}
                        </Button>
                        <Button
                          size='small'
                          type='primary'
                          className='db-tx-commit'
                          loading={txBusy}
                          onClick={commitTx}
                        >
                          {e('dbTxCommit')}
                        </Button>
                        <Button
                          size='small'
                          danger
                          className='db-tx-rollback'
                          loading={txBusy}
                          onClick={() => setManualTx(false)}
                        >
                          {e('dbTxRollback')}
                        </Button>
                      </>
                      )
                    : null
                }
              </span>
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
          // U1d：勾选后的一族动作合成一组——选中计数 + 反选 + 删除 + 批量改值 + 查找替换。
          // 门控（只读 + 主键 + 本页有行）原来在四段各写一遍，现在提到组首：
          // 计数原来只挂在删除/批量改值的按钮后缀上，光看按钮分不清"没选"还是"选了没显示"，
          // 所以把"已选 n 行"摆到组首；按钮后缀保留，破坏性动作在按下处仍能看到自己的范围。
          sel && !isReadonly && pkColumn && grid.rows.length
            ? (
              <span className='db-tool-group'>
                {
                  selectedRowKeys.length
                    ? (
                      <span className='db-grid-selected'>
                        {e('dbGridSelectedRows').replace('{n}', String(selectedRowKeys.length))}
                      </span>
                      )
                    : null
                }
                {
                  // B1 反选：表头勾选框已能正常渲染（columnWidth 修复列宽塌陷）负责全选/取消，
                  // 这里保留反选（无选中时等价全选，Tooltip 随状态切换）
                  <Tooltip title={selectedRowKeys.length ? e('dbInvertSelection') : e('dbSelectAllPage')}>
                    <Button
                      size='small'
                      icon={<DiffOutlined />}
                      onClick={invertSelection}
                    />
                  </Tooltip>
                }
                {
                  // B1 删除选中：门控 只读+主键（无主键无法安全定位行），常显禁用
                  // （避免选中后按钮突然出现在反选之前、鼠标下方被误点，用户拍板）
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
                }
                {
                  // B3-2 批量同列改值：门控与 deleteRows 同（只读 + 主键 + 有勾选 + 本页有行），
                  // 按钮常显禁用（与删除一致，避免选中后按钮位置跳动被误点）
                  <Tooltip title={selectedRowKeys.length ? e('dbBulkEdit') : e('dbNeedSelection')}>
                    <Button
                      size='small'
                      icon={<EditOutlined />}
                      disabled={!selectedRowKeys.length}
                      onClick={openBulk}
                    >
                      {e('dbBulkEdit')}{selectedRowKeys.length ? `(${selectedRowKeys.length})` : ''}
                    </Button>
                  </Tooltip>
                }
                {
                  // B3-3 查找替换：范围受"本页可见行"约束（见 repPreview 注释）；
                  // 不需要勾选（替换所有匹配单元格），但必须有主键才能逐行定位
                  <Tooltip title={e('dbReplace')}>
                    <Button
                      size='small'
                      icon={<SwapOutlined />}
                      onClick={openReplace}
                    >
                      {e('dbReplace')}
                    </Button>
                  </Tooltip>
                }
              </span>
              )
            : null
        }
        {/* U1：翻页 + 页大小独立成组放在行尾。宽屏时贴右端、和动作按钮同一行；
            窄屏时整组折到第二行 —— 翻页条不会被拆成两截，动作按钮也不会因为
            翻页条占住中间而被迫挤成一行半 */}
        {
          sel
            ? (
              <span className='db-grid-head-pager'>
                {/* H1a-4：分页条与 SQL 结果 / Redis 键列表统一走 DbGridPager */}
                <DbGridPager
                  prevDisabled={grid.page <= 1 || grid.loading}
                  onPrev={() => turnPage(grid.page - 1)}
                  nextDisabled={!grid.hasMore || grid.loading}
                  onNext={() => turnPage(grid.page + 1)}
                  pageTags={renderPageTags()}
                  pageNoText={e('dbPageLabel').replace('{n}', grid.page)}
                  // 直接跳转到某页（totalPages 为估算值，跳页时钳制到估算末页）
                  jump={{
                    numeric: true,
                    min: 1,
                    max: totalPages || undefined,
                    value: jumpPage,
                    onChange: v => setJumpPage(v),
                    onPressEnter: goPage,
                    placeholder: totalPages ? '1-' + totalPages : e('dbPagePlaceholder')
                  }}
                  goDisabled={!jumpPage}
                  onGo={goPage}
                />
                {renderPageSizeSelect()}
              </span>
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
            className='is-bordered'
            size='small'
            loading={grid.loading}
            columns={columns}
            dataSource={filteredRows}
            rowKey='__rowKey'
            pagination={false}
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
        bottom={bottomEl}
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
      {
        // B3-2 批量同列改值弹窗：选列 + 新值 + NULL 勾选；仅对"值变了"的行发 UPDATE
        bulk.open
          ? (
            <Modal
              open={bulk.open}
              title={e('dbBulkEditTitle')
                .replace('{column}', bulk.col)
                .replace('{n}', String(selectedRows.length))}
              onCancel={() => setBulk(b => ({ ...b, open: false }))}
              onOk={submitBulk}
              okText={e('dbAffected').replace('{n}', '→')}
              cancelText={e('cancel')}
              width={520}
            >
              <div className='db-bulk-form'>
                <div className='db-bulk-row'>
                  <span className='db-bulk-label'>{e('dbBulkColumn')}</span>
                  <Select
                    size='small'
                    value={bulk.col}
                    style={{ width: 280 }}
                    showSearch
                    optionFilterProp='label'
                    onChange={col => setBulk(b => ({ ...b, col }))}
                    options={columnOptions}
                  />
                </div>
                <div className='db-bulk-row'>
                  <span className='db-bulk-label'>{e('dbBulkValue')}</span>
                  <Input
                    size='small'
                    value={bulk.text}
                    disabled={bulk.isNull}
                    style={{ width: 280 }}
                    onChange={ev => setBulk(b => ({ ...b, text: ev.target.value }))}
                  />
                  <Checkbox
                    checked={bulk.isNull}
                    onChange={ev => setBulk(b => ({ ...b, isNull: ev.target.checked }))}
                  >
                    NULL
                  </Checkbox>
                </div>
                <div className='db-bulk-hint'>{e('dbBulkHint')}</div>
              </div>
            </Modal>
            )
          : null
      }
      {
        // B3-3 表内查找替换弹窗：范围=本页可见行，实时预览"会改几行"
        rep.open
          ? (
            <Modal
              open={rep.open}
              title={e('dbReplaceTitle').replace('{column}', rep.col)}
              onCancel={() => setRep(r => ({ ...r, open: false }))}
              onOk={submitReplace}
              okButtonProps={{ disabled: !repPreview.updates.length }}
              okText={e('dbReplace')}
              cancelText={e('cancel')}
              width={540}
            >
              <div className='db-replace-form'>
                <div className='db-replace-row'>
                  <span className='db-replace-label'>{e('dbReplaceColumn')}</span>
                  <Select
                    size='small'
                    value={rep.col}
                    style={{ width: 280 }}
                    showSearch
                    optionFilterProp='label'
                    onChange={col => setRep(r => ({ ...r, col }))}
                    options={columnOptions}
                  />
                </div>
                <div className='db-replace-row'>
                  <span className='db-replace-label'>{e('dbReplaceFind')}</span>
                  <Input
                    size='small'
                    value={rep.find}
                    style={{ width: 280 }}
                    onChange={ev => setRep(r => ({ ...r, find: ev.target.value }))}
                  />
                </div>
                <div className='db-replace-row'>
                  <span className='db-replace-label'>{e('dbReplaceWith')}</span>
                  <Input
                    size='small'
                    value={rep.text}
                    style={{ width: 280 }}
                    onChange={ev => setRep(r => ({ ...r, text: ev.target.value }))}
                  />
                </div>
                <div className='db-replace-opts'>
                  <Checkbox
                    checked={rep.matchCase}
                    onChange={ev => setRep(r => ({ ...r, matchCase: ev.target.checked }))}
                  >
                    {e('dbReplaceMatchCase')}
                  </Checkbox>
                  <Checkbox
                    checked={rep.wholeCell}
                    onChange={ev => setRep(r => ({ ...r, wholeCell: ev.target.checked }))}
                  >
                    {e('dbReplaceWholeCell')}
                  </Checkbox>
                </div>
                <div className={repHint.warn ? 'db-replace-preview is-warn' : 'db-replace-preview'}>
                  {e('dbReplaceScope').replace('{n}', String(filteredRows.length))}
                  {' · '}
                  {repHint.text}
                  {repPreview.noKey
                    ? ` · ${e('dbReplaceNoKey').replace('{n}', String(repPreview.noKey))}`
                    : ''}
                </div>
              </div>
            </Modal>
            )
          : null
      }
    </div>
  )

  // U1c：没选中表时数据页不再是一张空网格（表名为空、控件全隐藏，看起来像坏了），
  // 给工作台首页：连接摘要 + 四个快捷入口 + metadata 里的前几张表
  const workspaceHome = (
    <DbWorkspaceHome
      engine={dbTypeLabelMap[tab.dbType] || tab.dbType}
      target={target}
      readonly={isReadonly}
      production={isProduction}
      loading={treeLoading}
      tables={homeTables}
      onRefresh={() => loadTree()}
      onOpenSql={() => setMainTab('sql')}
      onQuickOpen={() => setQuickOpen(true)}
      onOpenTable={t => openTable(t)}
      // 导入向导第一步之后要用列清单做映射，所以先打开表、结构落定再弹向导
      onImportTable={t => {
        setMainTab('data')
        openTable(t).then(() => setImportOpen(true))
      }}
    />
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

  // 历史 tab 内容：从弹层抽出成变量，供「收藏/历史」双 tab 条件渲染（B-1）。
  // 收藏 tab 共用弹层的尺寸/拖拽把手，只换列表区
  const historyInnerEl = (
    <>
      <div className='db-history-head'>
        <span className='db-history-title'>
          {e('dbSqlHistory')}
          {sqlHistory.length ? <span className='db-history-count'>{sqlHistory.length}</span> : null}
        </span>
        {
          sqlHistory.length
            ? (
              <span className='db-history-headops'>
                {
                  // S3-D 历史导出：全部 / 当前筛选结果。悬浮才露（与条目操作一致）
                  <Button
                    className='db-history-star'
                    type='text'
                    size='small'
                    icon={<DownloadOutlined />}
                    title={e('dbHistExport')}
                    onClick={exportSqlHistory}
                  />
                }
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
              </span>
              )
            : null
        }
      </div>
      {
        // 历史条数有环形上限（SQL_HISTORY_MAX），找旧语句靠滚动太费劲；只匹配语句文本，不匹配库名/时间
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
                          {
                            // 一键收藏：星标 = 直接收藏到默认分组；右侧小箭头 = 选指定分组
                            !isRedis
                              ? (
                                <>
                                  <Button
                                    className='db-history-star'
                                    type='text'
                                    size='small'
                                    icon={<StarFilled />}
                                    // 已收藏态：金色实心星 + 文案切换；再点仍可收藏（合并刷新时间）
                                    style={isFaved(item.sql) ? { color: '#faad14' } : undefined}
                                    title={isFaved(item.sql) ? e('dbFavSaved') : e('dbSqlHistoryFav')}
                                    onClick={ev => {
                                      ev.stopPropagation()
                                      favoriteNow(item.sql, '')
                                    }}
                                  />
                                  <Dropdown
                                    menu={{
                                      items: [
                                        {
                                          key: 'fav-default',
                                          icon: <StarOutlined />,
                                          label: e('dbFavGroupDefault'),
                                          onClick: () => favoriteNow(item.sql, '')
                                        },
                                        ...Object.keys(favGroups)
                                          .filter(g => g !== '')
                                          .sort((a, b) => a.localeCompare(b))
                                          .map(g => ({
                                            key: 'fav:' + g,
                                            icon: <StarOutlined />,
                                            label: g,
                                            onClick: () => favoriteNow(item.sql, g)
                                          })),
                                        { type: 'divider' },
                                        {
                                          key: 'fav-new',
                                          icon: <FolderAddOutlined />,
                                          label: e('dbFavGroupNew'),
                                          onClick: () => openQuickFav(item.sql)
                                        }
                                      ]
                                    }}
                                    trigger={['click']}
                                    placement='bottomRight'
                                  >
                                    <Button
                                      className='db-history-star'
                                      type='text'
                                      size='small'
                                      icon={<DownOutlinedIcon />}
                                      title={e('dbFavMoveGroup')}
                                      onClick={ev => ev.stopPropagation()}
                                    />
                                  </Dropdown>
                                </>
                                )
                              : null
                            }
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
      <div className='db-history-note'>{e('dbSqlHistoryNote').replace('{n}', String(SQL_HISTORY_MAX))}</div>
    </>
  )

  // 收藏 tab 内容（B-1/B-2/B-4）：工具条（新建/导入/导出）+ 搜索 + 列表。
  // 条目操作：插光标/复制/编辑/删除；主标题行整块可点（插光标并关闭弹层）
  const favContentEl = (
    <div className='db-fav-body'>
      <div className='db-fav-toolbar'>
        <Button size='small' icon={<PlusOutlined />} onClick={newFavorite}>
          {e('dbFavNew')}
        </Button>
        <Button size='small' icon={<UploadOutlined />} onClick={importFav}>
          {e('dbFavImport')}
        </Button>
        {
          // 导出三粒度：单组 / 多组 / 全选。菜单项动态来自 favGroups
          favList.length
            ? (
              <Dropdown
                menu={{
                  items: [
                    // 全选（含所有分组）
                    {
                      key: '__all',
                      icon: <ExportOutlined />,
                      label: e('dbFavExportAll'),
                      onClick: () => exportFavScoped(null)
                    },
                    // 多选分组：弹勾选框，按所选分组的并集导出
                    {
                      key: '__multi',
                      icon: <FolderOpenOutlined />,
                      label: e('dbFavExportMulti'),
                      onClick: () => setExportMulti(Object.keys(favGroups))
                    },
                    { type: 'divider' },
                    // 每个分组单独导出
                    ...Object.keys(favGroups)
                      .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
                      .map(g => ({
                        key: 'g:' + g,
                        label: (
                          <span>
                            {g || e('dbFavGroupDefault')}
                            <span className='db-fav-groupcount'>（{favGroups[g]}）</span>
                          </span>
                        ),
                        onClick: () => exportFavScoped(g)
                      }))
                  ]
                }}
                trigger={['click']}
                placement='bottomLeft'
              >
                <Button size='small' icon={<DownloadOutlined />} disabled={!favList.length}>
                  {e('dbFavExport')}
                </Button>
              </Dropdown>
              )
            : (
              <Button size='small' icon={<DownloadOutlined />} disabled>
                {e('dbFavExport')}
              </Button>
              )
        }
        {
          // 分组管理：新建 / 重命名 / 删除
          <Dropdown
            menu={{
              items: [
                {
                  key: 'new',
                  icon: <FolderAddOutlined />,
                  label: e('dbFavGroupNew'),
                  onClick: () => { setGroupInput(''); setGroupDialog({ mode: 'new' }) }
                },
                { type: 'divider' },
                ...Object.keys(favGroups)
                  .filter(g => g !== '')
                  .sort((a, b) => a.localeCompare(b))
                  .map(g => ({
                    key: 'g:' + g,
                    label: g,
                    children: [
                      {
                        key: 'rename:' + g,
                        label: e('dbFavGroupRename'),
                        onClick: () => { setGroupInput(g); setGroupDialog({ mode: 'rename', name: g }) }
                      },
                      {
                        key: 'del:' + g,
                        label: e('dbFavGroupDel'),
                        danger: true,
                        onClick: () => setGroupDialog({ mode: 'del', name: g })
                      }
                    ]
                  }))
              ]
            }}
            trigger={['click']}
            placement='bottomLeft'
          >
            <Button size='small' icon={<FolderOpenOutlined />} title={e('dbFavGroupManage')}>
              {e('dbFavGroupManage')}
            </Button>
          </Dropdown>
        }
      </div>
      {
        favList.length
          ? (
            <Input
              className='db-history-filter'
              size='small'
              allowClear
              value={favFilter}
              placeholder={e('dbFavFilter')}
              onChange={ev => setFavFilter(ev.target.value)}
            />
            )
          : null
      }
      {
        // 分组 chips：全部 / 默认分组 / 各分组。点选切换视图，再次点击已选的分组回到全部
        Object.keys(favGroups).length
          ? (
            <div className='db-fav-grouprow'>
              <Button
                className='db-fav-groupchip'
                size='small'
                type={favGroupView === null ? 'primary' : 'text'}
                onClick={() => setFavGroupView(null)}
              >
                {e('dbFavGroupAll')}
              </Button>
              <Button
                className='db-fav-groupchip'
                size='small'
                type={favGroupView === '' ? 'primary' : 'text'}
                onClick={() => setFavGroupView(favGroupView === '' ? null : '')}
              >
                {e('dbFavGroupDefault')}（{favGroups[''] || 0}）
              </Button>
              {
                Object.keys(favGroups)
                  .filter(g => g !== '')
                  .sort((a, b) => a.localeCompare(b))
                  .map(g => (
                    <Button
                      key={g}
                      className='db-fav-groupchip'
                      size='small'
                      type={favGroupView === g ? 'primary' : 'text'}
                      onClick={() => setFavGroupView(favGroupView === g ? null : g)}
                    >
                      {g}（{favGroups[g]}）
                    </Button>
                  ))
              }
            </div>
            )
          : null
      }
      {
        favVisible.length
          ? (
            <div className='db-fav-list'>
              {
                // 按分组分桶渲染：每个非折叠分组一个标题 + 组内条目
                favBuckets.map(([g, items]) => {
                  const folded = favFolded.has(g)
                  return (
                    <div key={g}>
                      {
                        // 有多个分组时才显示分组标题（只有一个分组/未分组时保持简洁）
                        Object.keys(favGroups).length > 1
                          ? (
                            <div
                              className='db-fav-grouptitle'
                              onClick={() => toggleFavFold(g)}
                            >
                              {folded ? <RightOutlined /> : <DownOutlinedIcon />}
                              {g || e('dbFavGroupDefault')}
                              <span className='db-fav-groupcount'>{items.length}</span>
                            </div>
                            )
                          : null
                      }
                      {
                        folded
                          ? null
                          : items.map(item => (
                            <div key={item.id} className='db-fav-item'>
                              <div
                                className='db-fav-main'
                                title={previewText(item.sql)}
                                onClick={() => pickFavorite(item)}
                              >
                                <div className='db-fav-title'>{item.title || previewText(item.sql)}</div>
                                <div className='db-fav-meta'>
                                  <span>{dbTypeLabelMap[item.dbType] || item.dbType}</span>
                                  <span>{new Date(item.ts).toLocaleString()}</span>
                                  {
                                    g
                                      ? <span className='db-fav-groupcount'>{g}</span>
                                      : null
                                  }
                                </div>
                              </div>
                              <div className='db-fav-ops'>
                                {
                                  // 一键收藏（此处为"移入分组"）：点击弹分组下拉
                                  <Dropdown
                                    menu={{
                                      items: [
                                        {
                                          key: 'move-default',
                                          label: e('dbFavGroupDefault'),
                                          onClick: () => moveFavoriteGroup(item, '')
                                        },
                                        ...Object.keys(favGroups)
                                          .filter(x => x !== '' && x !== item.group)
                                          .sort((a, b) => a.localeCompare(b))
                                          .map(x => ({
                                            key: 'move:' + x,
                                            label: x,
                                            onClick: () => moveFavoriteGroup(item, x)
                                          }))
                                      ]
                                    }}
                                    trigger={['click']}
                                    placement='bottomRight'
                                  >
                                    <Button
                                      className='db-fav-star'
                                      type='text'
                                      size='small'
                                      icon={<FolderOpenOutlined />}
                                      title={e('dbFavMoveGroup')}
                                    />
                                  </Dropdown>
                                }
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<CopyOutlined />}
                                  title={e('dbFavCopy')}
                                  onClick={() => copy(item.sql)}
                                />
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<EditOutlined />}
                                  title={e('dbFavEdit')}
                                  onClick={() => editFavorite(item)}
                                />
                                <Popconfirm
                                  title={e('dbFavDelConfirm')}
                                  onConfirm={() => removeOneFavorite(item)}
                                >
                                  <Button
                                    type='text'
                                    size='small'
                                    danger
                                    icon={<DeleteOutlined />}
                                    title={e('dbFavDelete')}
                                    aria-label={e('dbFavDelete')}
                                  />
                                </Popconfirm>
                              </div>
                            </div>
                          ))
                      }
                    </div>
                  )
                })
              }
            </div>
            )
          : (
            <div className='db-history-note'>
              {favList.length ? e('dbFavNoMatch') : e('dbFavEmpty')}
            </div>
            )
      }
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
          onExplainSelection={openExplain}
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
          // H6a：参数化开关。开着时检测到 :name 会先收值，值走驱动绑定
          !isRedis
            ? (
              <Button
                size='small'
                type={sqlParamMode ? 'primary' : 'default'}
                ghost={sqlParamMode}
                title={e('dbSqlParamsHintShort')}
                onClick={() => setSqlParamMode(v => !v)}
              >
                {e('dbSqlParams')}
              </Button>
              )
            : null
        }
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
        {
          // B-3 SQL 模板：内置骨架菜单 + 按当前表生成 INSERT（无选中表禁用）。
          // Redis 无 SQL 编辑器，不显示
          !isRedis
            ? (
              <Dropdown
                menu={templateMenu}
                trigger={['click']}
                placement='bottomLeft'
              >
                <Button
                  size='small'
                  icon={<CodeOutlined />}
                  title={e('dbTplMenu')}
                />
              </Dropdown>
              )
            : null
        }
        {
          // D 批：解释（EXPLAIN 可视化）。只读分析，redis 无 SQL 不显示；
          // 优先解释编辑器选区，无选区解释整段语句
          !isRedis
            ? (
              <Button
                size='small'
                icon={<NodeIndexOutlined />}
                title={e('dbExplainBtn')}
                onClick={openExplain}
              />
              )
            : null
        }
        {
          // B-6：一键收藏当前 SQL 框内容。星标 = 默认分组（一键）；小箭头 = 选指定分组
          !isRedis
            ? (
              <>
                <Button
                  size='small'
                  icon={<StarFilled />}
                  disabled={!sqlText.trim()}
                  style={isFaved(sqlText) ? { color: '#faad14' } : undefined}
                  title={isFaved(sqlText) ? e('dbFavSaved') : e('dbQuickFavBtn')}
                  onClick={() => favoriteNow(sqlText, '')}
                />
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: 'fav-default',
                        label: e('dbFavGroupDefault'),
                        onClick: () => favoriteNow(sqlText, '')
                      },
                      ...Object.keys(favGroups)
                        .filter(g => g !== '')
                        .sort((a, b) => a.localeCompare(b))
                        .map(g => ({
                          key: 'fav:' + g,
                          label: g,
                          onClick: () => favoriteNow(sqlText, g)
                        })),
                      { type: 'divider' },
                      {
                        key: 'fav-new',
                        label: e('dbFavGroupNew'),
                        onClick: () => openQuickFav(sqlText)
                      }
                    ]
                  }}
                  trigger={['click']}
                  placement='bottomRight'
                >
                  <Button
                    size='small'
                    icon={<DownOutlinedIcon />}
                    disabled={!sqlText.trim()}
                    title={e('dbFavMoveGroup')}
                  />
                </Dropdown>
              </>
              )
            : null
        }
        {
          // B-7：AI 解释当前 SQL。接入既有 AI 面板（右侧栏），复用 explainWithAi 机制
          !isRedis
            ? (
              <Button
                size='small'
                icon={<ThunderboltOutlined />}
                disabled={!sqlText.trim()}
                title={e('dbAiExplain')}
                onClick={() => askAiAboutSql(sqlText)}
              />
              )
            : null
        }
        <Popover
          placement='bottomLeft'
          trigger='click'
          open={sqlHistoryOpen}
          onOpenChange={open => {
            openSqlHistory(open)
            // 打开即刷新（不限 tab）：收藏文件全局共享，其他连接 tab/历史会话
            // 的收藏变动也要在打开瞬间同步——否则按钮徽标(favList.length)
            // 与弹层内分组计数会对不上。列表 ≤500 条，文件读一次不贵
            if (open) {
              refreshFavorites()
              refreshFavGroups()
            }
          }}
          content={
            <div
              className='db-history-pop'
              data-split={splitMode(histSize.width)}
              style={{ width: histSize.width, height: histSize.height }}
            >
              <div className='db-history-tabbar'>
                <Button
                  size='small'
                  type={favTab === 'history' ? 'primary' : 'text'}
                  icon={<HistoryOutlined />}
                  onClick={() => switchPanelTab('history')}
                >
                  {e('dbSqlHistory')}
                </Button>
                <Button
                  size='small'
                  type={favTab === 'favorite' ? 'primary' : 'text'}
                  icon={<StarOutlined />}
                  onClick={() => switchPanelTab('favorite')}
                >
                  {e('dbFavTab')}
                </Button>
              </div>
              {favTab === 'favorite' ? favContentEl : null}
              {
                favTab === 'history' ? historyInnerEl : null
              }
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
          {/* 收藏数改为按钮内联小圆片：原骑角 Badge 的结构性问题是按钮上方仅 1px
              空隙（编辑器底部），徽标上移会顶进编辑器、不移就压"藏"字顶部，
              任何 offset 都两难 → 弃用绝对定位徽标，计数随文字排布永不遮挡 */}
          <Button
            size='small'
            icon={<HistoryOutlined />}
            // 打开时高亮；文案直接写明"历史 / 收藏"——纯图标曾导致用户找不到收藏入口
            type={sqlHistoryOpen ? 'primary' : 'default'}
            title={e('dbHistFavEntry')}
          >
            {e('dbHistFavEntry')}
            {favList.length > 0 && (
              <span className='db-hist-fav-count'>{favList.length}</span>
            )}
          </Button>
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
          {
            // H1a-4：选中一格就在网格下面打开完整值面板（与数据页点击打开下方
            // 预览框同一交互，没有中间提示条）。
            // 没有结果时不套 DbSplitPane：空态下多一层 flex 容器只会添乱。
            // 有结果时**永远**套着（哪怕没选中），配合 collapsed 保持网格在 DOM
            // 里的位置不变 —— 换树形会让表格整块重挂，虚拟滚动的滚动位置全丢。
            // collapsed 看 sqlPaneShown（= 有没有选中）：重新执行清掉选中后半屏
            // 是空气，必须回到占满
            (sqlResult.results || []).length
              ? (
                <DbSplitPane
                  storageKey={SQL_VALUE_SPLIT_KEY}
                  collapsed={!sqlPaneShown}
                  top={renderSqlResults()}
                  bottom={sqlValuePane}
                />
                )
              : renderSqlResults()
          }
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
  // A2/A1：structureRows / structColumns 见上方"A1/A2 网格列定义与行数组 memo"
  // 集中块（必须放在提前 return 之前，保证 hook 数量稳定）

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

  // B2：对象 DDL 查看（过程/函数/触发器/事件）。只读、复用表 DDL 的弹窗与复制能力。
  // 定位参数随对象类型变化：PG 函数用签名区分重载、触发器用表名区分同名
  const showObjectDdl = (target) => {
    setDdl({ open: true, loading: true, title: target.name, text: '' })
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getObjectDdl', {
      database: target.database,
      schema: target.schema || '',
      name: target.name,
      objectType: target.objectType,
      signature: target.signature || '',
      table: target.table || ''
    }).then(res => {
      const text = res && res.ddl ? res.ddl : ''
      setDdl(d => ({ ...d, loading: false, text: text || e('dbDdlNotFound') }))
    }).catch(err => {
      setDdl(d => ({
        ...d,
        loading: false,
        text: err && err.message ? err.message : String(err)
      }))
    })
  }

  // H3a：数据字典导出。内容与结构页同源（structureV2 = getTableStructure 的 v2 契约），
  // 不发额外查询；DDL 只有 mysql 系能给，字典两引擎通用，所以入口放在工具行最右
  const exportDictionary = (kind) => {
    if (!sel || !structureV2.columns.length) {
      return
    }
    const { markdown, csv } = buildDataDictionary({
      table: sel,
      structure: structureV2,
      dialect: tab.dbType
    })
    const base = `dictionary-${sel.database}-${sel.table}-${tsName()}`
    if (kind === 'csv') {
      downloadText(`${base}.csv`, 'text/csv;charset=utf-8', csv)
    } else {
      downloadText(`${base}.md`, 'text/markdown;charset=utf-8', markdown)
    }
  }

  const structureArea = (
    <div className='db-struct-area'>
      {
        // 工具行：只要结构表有行就留着。原来只在 mysql 系（有 DDL 按钮）时渲染，
        // 那样 PG 就没有任何地方点"自适应全部列"（H1a-2）—— 行集有列就该有列宽工具
        structure.rows.length
          ? (
            <div className='db-struct-tools'>
              {
                // A2 DDL 入口：仅 mysql 系显示
                !isPg
                  ? (
                    <Button
                      size='small'
                      icon={<SearchOutlined />}
                      loading={ddl.loading}
                      onClick={fetchDdl}
                    >
                      {e('dbViewDdl')}
                    </Button>
                    )
                  : null
              }
              {colFitAllBtn(structWidths)}
              {/* H3b-3：整库 ER 图。只读，不进 SQL 编辑器；图的范围是当前库/schema */}
              <Button
                size='small'
                icon={<NodeIndexOutlined />}
                loading={er.loading && er.open}
                onClick={openErGraph}
              >
                {e('dbErGraph')}
              </Button>
              {/* H4：两张表结构对比（同连接同库）。只读，不生成任何 DDL */}
              <Button
                size='small'
                icon={<DiffOutlined />}
                onClick={openStructureDiff}
              >
                {e('dbStructDiff')}
              </Button>
              <Dropdown
                trigger='click'
                disabled={!structureV2.columns.length}
                menu={{
                  items: [
                    { key: 'md', label: 'Markdown' },
                    { key: 'csv', label: 'CSV' }
                  ],
                  onClick: ({ key }) => exportDictionary(key)
                }}
              >
                <Button size='small' icon={<DownloadOutlined />}>
                  {e('dbDictExport')}
                </Button>
              </Dropdown>
            </div>
            )
          : null
      }
      <DbGridTable
        size='small'
        loading={structure.loading}
        columns={structColumns}
        dataSource={structureRows}
        rowKey='__rowKey'
        pagination={false}
      />
    </div>
  )

  // A1/A2：redisKeyColumns / redisKeyRows 见上方集中 memo 块

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

  // 行尾删除按钮（Popconfirm 包裹）：hash 删 field / set/zset 删 member / list 删下标
  const redisRowOps = (onConfirm) => (
    <Popconfirm title={e('dbRedisDelRowConfirm')} onConfirm={onConfirm}>
      <Button
        size='small'
        type='text'
        danger
        icon={<DeleteOutlined />}
        disabled={isReadonly}
        title={isReadonly ? e('dbErrReadOnly') : e('dbRedisDelRowConfirm')}
      />
    </Popconfirm>
  )

  // 行内可编辑单元格渲染：redisEdit 命中当前格 → Input(数字格用 InputNumber) + 确认/取消；
  // 否则走普通高亮渲染
  const renderRedisEditable = (record, col, value, onSave, numeric = false) => {
    const editing = redisEdit && redisEdit.rowKey === record.__rowKey && redisEdit.col === col
    if (!editing) {
      return renderCell(value)
    }
    const editor = numeric
      ? (
        <InputNumber
          size='small'
          autoFocus
          value={redisEdit.value === '' ? undefined : Number(redisEdit.value)}
          onChange={v => setRedisEdit(s => ({ ...s, value: v === undefined ? '' : String(v) }))}
        />
        )
      : (
        <Input
          size='small'
          autoFocus
          value={redisEdit.value}
          onChange={ev => setRedisEdit(s => ({ ...s, value: ev.target.value }))}
          onPressEnter={onSave}
        />
        )
    return (
      <span className='db-redis-cell-edit'>
        {editor}
        <Button size='small' type='text' icon={<CheckOutlined />} onClick={onSave} />
        <Button size='small' type='text' icon={<CloseOutlined />} onClick={() => setRedisEdit(null)} />
      </span>
    )
  }

  // 行内编辑入口（双击触发）；readOnly 时不进编辑态
  const editRedisCell = (record, col, value) => {
    if (!isReadonly) {
      setRedisEdit({ rowKey: record.__rowKey, col, value: String(value ?? '') })
    }
  }

  // A2：redisHash/List/Set/ZsetRows 见上方集中 memo 块（提前 return 之前）

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
          onSave={async v => {
            const ok = await confirmRedisWrite({
              level: 'write',
              text: 'SET ' + redisKey,
              note: e('saved')
            })
            if (!ok) {
              return
            }
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
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbField')}
                    colKey='field'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'field',
                key: 'field',
                width: redisDetailWidthOf('field'),
                ellipsis: CELL_ELLIPSIS,
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'field',
                    head: e('dbField'),
                    wide: wideColumnWidth(redisHashRows, 'field')
                  })
                }),
                onCell: redisCellProps('field', e('dbField')),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbValue')}
                    colKey='value'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'value',
                key: 'value',
                width: redisDetailWidthOf('value'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 value 行内编辑（HSET 覆盖同字段）；单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('value', e('dbValue'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'value', r.value)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'value',
                    head: e('dbValue'),
                    wide: wideColumnWidth(redisHashRows, 'value')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'value', v, () => saveHashValue(r))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('hashDelField', {
                  dbIndex: redisDb, key: redisKey, fields: [r.field]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'HDEL ' + redisKey + ' ' + r.field,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisHashRows}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'list') {
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'index', key: 'index', width: 80, render: v => renderCell(v) },
              {
                title: (
                  <ColHead
                    label={e('dbValue')}
                    colKey='value'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'value',
                key: 'value',
                width: redisDetailWidthOf('value'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 value 行内编辑（LSET 按下标）；单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('value', e('dbValue'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'value', r.value)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'value',
                    head: e('dbValue'),
                    wide: wideColumnWidth(redisListRows, 'value')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'value', v, () => saveListValue(r))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('listRemAt', {
                  dbIndex: redisDb, key: redisKey, index: r.index
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: '删除 ' + redisKey + '[' + r.index + ']',
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisListRows}
            rowKey='__rowKey'
          />
          {renderMoreBtn((d.rows || []).length)}
        </>
      )
    } else if (d.type === 'set') {
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbMember')}
                    colKey='member'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'member',
                key: 'member',
                width: redisDetailWidthOf('member'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击成员 = 删旧加新（成员是身份标识，不支持原地改）；
                // 单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('member', e('dbMember'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'member', r.member)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'member',
                    head: e('dbMember'),
                    wide: wideColumnWidth(redisSetRows, 'member')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'member', v, () => editSetMember(r.member, redisEdit ? redisEdit.value : ''))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('setRem', {
                  dbIndex: redisDb, key: redisKey, members: [r.member]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'SREM ' + redisKey + ' ' + r.member,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisSetRows}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'zset') {
      // zrange WITHSCORES 返回 [member, score, ...] 扁平数组，行键数组见顶层 redisZsetRows
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbMember')}
                    colKey='member'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'member',
                key: 'member',
                width: redisDetailWidthOf('member'),
                ellipsis: CELL_ELLIPSIS,
                // 成员是身份标识：双击提示不可编辑（改分值请双击 score 列）；
                // 单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('member', e('dbMember'))(r, i),
                  onDoubleClick: () => message.info(e('dbRedisMemberImmutable'))
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'member',
                    head: e('dbMember'),
                    wide: wideColumnWidth(redisZsetRows, 'member')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbScore')}
                    colKey='score'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'score',
                key: 'score',
                // 分数列原来写死 150：数字列占 150，成员列（真正会长的那一列）反而没宽
                width: redisDetailWidthOf('score'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 score 行内编辑（ZADD 同 member 覆盖）；单击 = 展开值面板
                onCell: (r, i) => ({
                  ...redisCellProps('score', e('dbScore'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'score', r.score)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'score',
                    head: e('dbScore'),
                    wide: wideColumnWidth(redisZsetRows, 'score')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'score', v, () => saveZsetScore(r), true)
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('zsetRem', {
                  dbIndex: redisDb, key: redisKey, members: [r.member]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'ZREM ' + redisKey + ' ' + r.member,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisZsetRows}
            rowKey='__rowKey'
          />
          {renderMoreBtn(Math.ceil((d.rows || []).length / 2))}
        </>
      )
    } else if (d.type === 'stream') {
      // H7b-4：只读 —— XINFO 给元信息与消费组，XRANGE 给条目。
      // 不提供 XADD/XDEL/XACK：stream 的写入语义（上游生产者、消费组 ack）
      // 不是"双击改一格"能表达的东西，给个半吊子入口比没有更糟。
      const info = redisStreamInfo || {}
      const groups = redisStreamGroups
      const groupCount = groups === null ? info.groups : groups.length
      const entriesTotal = typeof d.total === 'number' ? d.total : null
      body = (
        // 值面板打开时收起消费组：上下分区只剩一半高度，元信息 + 组表就能
        // 把条目表挤成 0 —— 组数是次要信息（元信息条里仍有"消费组 N"），
        // 正在看的条目才是主体
        <div className={'db-redis-stream' + (redisCellInfo ? ' db-redis-stream-compact' : '')}>
          <div className='db-redis-stream-meta'>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatLength')}</span>
              <span className='db-redis-stream-v'>{dash(info.length)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatFirst')}</span>
              <span className='db-redis-stream-v db-redis-stream-mono'>{dash(info.firstId)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatLast')}</span>
              <span className='db-redis-stream-v db-redis-stream-mono'>{dash(info.lastId)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatGroups')}</span>
              <span className='db-redis-stream-v'>{dash(groupCount)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatAdded')}</span>
              <span className='db-redis-stream-v'>{dash(info.entriesAdded)}</span>
            </span>
            <Button
              size='small'
              className='db-redis-stream-refresh'
              icon={<ReloadOutlined />}
              loading={detailLoading}
              onClick={() => selectRedisKey(redisKey)}
            >
              {e('dbRedisStreamRefresh')}
            </Button>
          </div>
          <div className='db-redis-stream-head db-redis-stream-groups-head'>
            <span className='db-redis-stream-title'>{e('dbRedisStreamGroupsTitle')}</span>
            {
              groups === null
                ? <span className='db-redis-stream-note'>{e('dbRedisStreamGroupsUnknown')}</span>
                : groups.length === 0
                  ? <span className='db-redis-stream-note'>{e('dbRedisStreamNoGroups')}</span>
                  : null
            }
          </div>
          {
            groups && groups.length
              ? (
                <DbGridTable
                  size='small'
                  pagination={false}
                  columns={[
                    {
                      title: e('dbRedisStreamGroupName'),
                      dataIndex: 'name',
                      key: 'name',
                      ellipsis: CELL_ELLIPSIS,
                      className: 'db-redis-stream-mono',
                      render: v => renderCell(v)
                    },
                    {
                      title: e('dbRedisStreamConsumers'),
                      dataIndex: 'consumers',
                      key: 'consumers',
                      width: 90,
                      render: v => dash(v)
                    },
                    {
                      title: e('dbRedisStreamPending'),
                      dataIndex: 'pending',
                      key: 'pending',
                      width: 90,
                      render: v => dash(v)
                    },
                    {
                      title: e('dbRedisStreamLastDelivered'),
                      dataIndex: 'lastDeliveredId',
                      key: 'lastDeliveredId',
                      width: 180,
                      className: 'db-redis-stream-mono',
                      ellipsis: CELL_ELLIPSIS,
                      render: v => renderCell(v)
                    },
                    {
                      title: e('dbRedisStreamLag'),
                      dataIndex: 'lag',
                      key: 'lag',
                      width: 80,
                      render: v => dash(v)
                    }
                  ]}
                  dataSource={groups}
                  rowKey='name'
                  className='db-redis-stream-groups-table'
                />
                )
              : null
          }
          <div className='db-redis-stream-head'>
            <span className='db-redis-stream-title'>{e('dbRedisStreamEntries')}</span>
            <span className='db-redis-stream-note'>
              {dash(redisStreamEntries.length) + (entriesTotal === null ? '' : ' / ' + entriesTotal)}
            </span>
          </div>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbRedisStreamId')}
                    colKey='id'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'id',
                key: 'id',
                width: redisDetailWidthOf('id'),
                ellipsis: CELL_ELLIPSIS,
                className: 'db-redis-stream-mono',
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'id',
                    head: e('dbRedisStreamId'),
                    wide: wideColumnWidth(redisStreamEntries, 'id')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbRedisStreamFields')}
                    colKey='preview'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'preview',
                key: 'preview',
                width: redisDetailWidthOf('preview'),
                ellipsis: CELL_ELLIPSIS,
                // 单击 = 完整字段（多行原文），网格里只放单行摘要
                onCell: redisCellProps('text', e('dbRedisStreamFields')),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'preview',
                    head: e('dbRedisStreamFields'),
                    wide: wideColumnWidth(redisStreamEntries, 'preview')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: e('dbRedisStreamFieldCount'),
                dataIndex: 'fieldCount',
                key: 'fieldCount',
                width: 90,
                render: v => dash(v)
              }
            ]}
            dataSource={redisStreamEntries}
            rowKey='__rowKey'
            className='db-redis-stream-entries-table'
          />
          {renderScanMore(d)}
        </div>
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
                {
                  // D 批 T12：按类型显隐的添加控件（只读全部禁用）
                  d.type === 'hash'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbField')}
                          value={redisAdd.field}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, field: ev.target.value }))}
                          onPressEnter={addHashField}
                        />
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbValue')}
                          value={redisAdd.value}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, value: ev.target.value }))}
                          onPressEnter={addHashField}
                        />
                        <Button
                          size='small'
                          icon={<PlusOutlined />}
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisAddField')}
                          disabled={isReadonly}
                          onClick={addHashField}
                        />
                      </>
                      )
                    : null
                }
                {
                  d.type === 'set' || d.type === 'zset'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbMember')}
                          value={redisAdd.member}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, member: ev.target.value }))}
                          onPressEnter={addMember}
                        />
                        {
                          d.type === 'zset'
                            ? (
                              <InputNumber
                                size='small'
                                className='db-redis-add-input'
                                placeholder={e('dbScore')}
                                value={redisAdd.score === '' ? undefined : Number(redisAdd.score)}
                                disabled={isReadonly}
                                onChange={v => setRedisAdd(s => ({ ...s, score: v === undefined ? '' : String(v) }))}
                              />
                              )
                            : null
                        }
                        <Button
                          size='small'
                          icon={<PlusOutlined />}
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisAddMember')}
                          disabled={isReadonly}
                          onClick={addMember}
                        />
                      </>
                      )
                    : null
                }
                {
                  d.type === 'list'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbValue')}
                          value={redisAdd.listValue}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, listValue: ev.target.value }))}
                        />
                        <Button
                          size='small'
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisInsertHead')}
                          disabled={isReadonly}
                          onClick={() => pushList('left')}
                        >
                          {e('dbRedisInsertHead')}
                        </Button>
                        <Button
                          size='small'
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisInsertTail')}
                          disabled={isReadonly}
                          onClick={() => pushList('right')}
                        >
                          {e('dbRedisInsertTail')}
                        </Button>
                      </>
                      )
                    : null
                }
                <InputNumber
                  size='small'
                  min={0}
                  placeholder={e('dbSeconds')}
                  value={ttlInput}
                  onChange={setTtlInput}
                />
                <Button size='small' disabled={isReadonly} onClick={applyTtl}>{e('dbSetTtl')}</Button>
                <Button
                  size='small'
                  disabled={isReadonly}
                  title={isReadonly ? e('dbErrReadOnly') : e('dbRedisRenameKey')}
                  onClick={() => {
                    setRenameInput('')
                    setRenameOpen(true)
                  }}
                >
                  {e('dbRedisRenameKey')}
                </Button>
                <Popconfirm title={e('dbDeleteKey')} onConfirm={delSelectedKey}>
                  <Button size='small' danger disabled={isReadonly}>{e('dbDelete')}</Button>
                </Popconfirm>
              </div>
              )
            : null
        }
        {
          // 详情四张表的"单击一格 → 底部值面板"：没选中时折叠（bottom 按内容高 = 0，
          // 不给拖拽手柄），选中才把表格压出一截 —— 与数据页/SQL 结果同一交互。
          // string 键的 body 本身就是那只面板，不再套一层分区容器
          d && d.type !== 'string'
            ? (
              <DbSplitPane
                storageKey={REDIS_VALUE_SPLIT_KEY}
                collapsed={!redisCellInfo}
                top={body}
                bottom={redisValuePane}
              />
              )
            : body
        }
      </div>
    )
  }

  // 键列表总页数：只有无过滤（match 为 *）时才给数字 —— 带 pattern 时命中数要
  // 全库扫完才知道，宁可不显示也不给假数字；受管实例禁用 INFO 时后端不回 count，
  // 同样回落到「第 N 页」。页大小与取数同源（Redis 用全局 dbPageSize，不走视角 pageSize）。
  const redisKeyDb = redisDb < 0
    ? null
    : metadata.find(d => d && d.name === 'db' + redisDb)
  const redisKeyTotal = redisKeyDb && (keyList.match || '*') === '*' && typeof redisKeyDb.count === 'number'
    ? redisKeyDb.count
    : undefined
  const redisKeyPages = redisKeyPagesOf(redisKeyTotal, getDbPageSize())
  // 到了真末页（hasMore=false）就以实测为准：INFO 是取元数据那一刻的快照，
  // 之后键被删掉的话估算会偏大，出现「第 3 / 5 页」但下一页已禁用的自相矛盾
  const redisKeyPageNo = keyList.stack.length + 1
  const redisKeyPagesShow = redisKeyPages && !keyList.loading && !keyList.hasMore
    ? redisKeyPageNo
    : redisKeyPages

  // H1a-4：Redis 键列表的页码文案（有换算总页数时显示"第 x / 共 y 页"）
  const redisPageNoText = redisKeyPagesShow
    ? e('dbPageOfLabel').replace('{n}', redisKeyPageNo).replace('{m}', redisKeyPagesShow)
    : e('dbPageLabel').replace('{n}', redisKeyPageNo)

  const redisArea = (
    <div className='db-redis-area'>
      {
        redisDb < 0
          ? <Empty description={e('dbSelectDb')} />
          : (
            <>
              <div className='db-redis-bar'>
                {/* H7a：同一份键空间两种看法。列表 = 游标分页（一页一次 IPC），
                    键树 = 全量抓取后分层；切换只换视图，不改任何数据写路径 */}
                <Segmented
                  size='small'
                  value={redisView}
                  onChange={switchRedisView}
                  options={[
                    { label: e('dbRedisViewList'), value: 'list' },
                    { label: e('dbRedisViewTree'), value: 'tree' }
                  ]}
                />
                <Input
                  size='small'
                  placeholder={e('dbMatchPlaceholder')}
                  value={matchInput}
                  onChange={ev => setMatchInput(ev.target.value)}
                  onPressEnter={applyRedisFilter}
                  className='db-redis-match'
                  allowClear
                />
                <Button
                  size='small'
                  onClick={applyRedisFilter}
                >
                  {e('filter')}
                </Button>
                {
                  redisView === 'tree'
                    ? (
                      <>
                        {/* 分隔符可配：改一下只重分层，不会重扫上万键（树在 useMemo 里算） */}
                        <span className='db-redis-tree-sep'>
                          <span className='db-redis-tree-sep-label'>{e('dbKeyTreeSep')}</span>
                          <Input
                            size='small'
                            className='db-redis-tree-sep-input'
                            value={treeSep}
                            maxLength={8}
                            onChange={ev => setTreeSep(ev.target.value)}
                          />
                        </span>
                        <span
                          className={'db-redis-tree-status' + (keyTree.truncated ? ' is-truncated' : '')}
                        >
                          {redisTreeStatus}
                          {
                            keyTree.truncated
                              ? ' · ' + e('dbKeyTreeTruncated').replace('{n}', REDIS_TREE_MAX_KEYS)
                              : ''
                          }
                        </span>
                        {
                          keyTree.loading
                            ? (
                              <Button size='small' onClick={cancelKeyTree}>
                                {e('cancel')}
                              </Button>
                              )
                            : null
                        }
                      </>
                      )
                    : (
                      <>
                        {/* H1a-4：分页条与数据页 / SQL 结果统一走 DbGridPager
                            （SCAN 无 offset：上一页走游标栈回退，下一页前向步进） */}
                        <DbGridPager
                          prevDisabled={keyList.stack.length === 0 || keyList.loading}
                          onPrev={() => {
                            const stack = keyList.stack
                            loadRedisKeys(
                              redisDb,
                              stack[stack.length - 1],
                              keyList.match,
                              stack.slice(0, -1)
                            )
                          }}
                          nextDisabled={!keyList.hasMore || keyList.loading}
                          onNext={() => loadRedisKeys(
                            redisDb,
                            keyList.nextCursor,
                            keyList.match,
                            [...keyList.stack, keyList.cursor]
                          )}
                          pageNoText={redisPageNoText}
                          // 页数是按键数换算的，把键数挂上去说明依据（键会随并发写入变化）
                          pageNoTitle={typeof redisKeyTotal === 'number'
                            ? e('dbKeysTotal').replace('{n}', redisKeyTotal)
                            : undefined}
                          // R1：键列表任意跳页（SCAN 无 offset，后端前向步进到目标页）
                          jump={{
                            numeric: false,
                            value: keyJumpInput,
                            onChange: ev => setKeyJumpInput(ev.target.value),
                            onPressEnter: () => jumpRedisKeysPage(keyJumpInput),
                            disabled: keyList.loading,
                            placeholder: redisKeyPagesShow ? '1-' + redisKeyPagesShow : e('dbPagePlaceholder')
                          }}
                          goDisabled={keyList.loading || !String(keyJumpInput).trim()}
                          onGo={() => jumpRedisKeysPage(keyJumpInput)}
                        />
                        {renderPageSizeSelect()}
                        {/* H1a-2：键名列宽工具（长键名加宽后一键回到按内容自适应） */}
                        {colFitAllBtn(redisKeysWidths)}
                        {/* H7b-3：跨页勾选后当前页可能一个都没选，需要常驻的"已选 N"提示
                            （否则翻一页就看不见自己选了什么，只剩按钮上的数字） */}
                        {
                          redisKeySel.length
                            ? (
                              <span className='db-redis-sel-chip'>
                                {e('dbRedisSelCount').replace('{n}', String(redisKeySel.length))}
                                <Button
                                  type='link'
                                  size='small'
                                  className='db-redis-sel-clear'
                                  onClick={() => setRedisKeySel([])}
                                >
                                  {e('dbRedisSelClear')}
                                </Button>
                              </span>
                              )
                            : null
                        }
                        {/* H7b-3：批量删键入口。只读时禁用并说明原因（主进程还会再拦一道） */}
                        <Tooltip title={isReadonly ? e('dbRedisDelKeysReadonly') : ''}>
                          <Button
                            size='small'
                            danger
                            icon={<DeleteOutlined />}
                            disabled={!redisKeySel.length || isReadonly || keyList.loading}
                            onClick={openRedisDel}
                          >
                            {e('dbRedisDelKeys')}{redisKeySel.length ? `(${redisKeySel.length})` : ''}
                          </Button>
                        </Tooltip>
                      </>
                      )
                }
                {/* 刷新放在翻页之后，与 MySQL 网格头一致；两种视图共用这一个入口 */}
                <Button
                  size='small'
                  icon={<ReloadOutlined />}
                  loading={redisView === 'tree' ? keyTree.loading : keyList.loading}
                  title={e('refresh')}
                  onClick={refreshRedisView}
                />
              </div>
              <DbSplitPane
                storageKey={REDIS_SPLIT_KEY}
                top={
                  redisView === 'tree'
                    ? (
                      <div className='db-redis-tree'>
                        {
                          redisTreeNodes.length
                            ? (
                              <Tree
                                blockNode
                                selectable
                                treeData={redisTreeNodes}
                                expandedKeys={treeExpanded}
                                onExpand={ks => setTreeExpanded(ks)}
                                selectedKeys={redisTreeSelected}
                                onSelect={onRedisTreeSelect}
                                titleRender={node => (
                                  <span
                                    className='db-redis-tree-node'
                                    title={node.keyName || node.title}
                                  >
                                    <span className='db-redis-tree-title'>{node.title}</span>
                                    <span className='db-redis-tree-count'>{node.count}</span>
                                  </span>
                                )}
                              />
                              )
                            : (
                              <div className='db-redis-tree-empty'>
                                <Empty description={keyTree.loading ? e('dbLoading') : e('noData')} />
                              </div>
                              )
                        }
                      </div>
                      )
                    : (
                      <DbGridTable
                        className='db-redis-keys'
                        size='small'
                        loading={keyList.loading}
                        columns={redisKeyColumns}
                        dataSource={redisKeyRows}
                        rowKey='name'
                        pagination={false}
                        rowSelection={redisKeyRowSelection}
                        onRow={r => ({ onClick: () => selectRedisKey(r.name) })}
                        rowClassName={r => (r.name === redisKey ? 'db-row-selected' : '')}
                      />
                      )
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
        activeKey={mainTab}
        onChange={setMainTab}
        items={[
          // U1c：没选中表时数据页显示工作台首页，而不是一张标题为空的网格
          { key: 'data', label: e('dbDataTab'), forceRender: true, children: sel ? dataArea : workspaceHome },
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
  const headBar = (
    <div className='db-head'>
      <span className='db-head-engine'>{dbTypeLabelMap[tab.dbType] || tab.dbType}</span>
      <span className='db-head-target elli' title={target}>{target}</span>
      <span className='db-head-state'>
        <i className={`db-head-dot ${connError ? 'err' : 'ok'}`} />
        {connError ? e('disconnected') : e('connected')}
      </span>
      <span className='db-head-right'>
        {/* U1：右侧按语义分三组，组间 1px 分隔线 —— 与左侧"引擎/目标/状态"的
            连接信息分开，风险开关不再和刷新按钮混成一排 */}
        <span className='db-tool-group'>
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
          {/* 只读开关常驻工具条：切换后主进程白名单同步生效（不用重开连接）。
              它与生产标记同属"风险"组：一个说连接本身危险，一个说当前是否允许写。
              文案与"系统库"同一个位置同一个样式，两个开关并排时不靠 tooltip 才分得清 */}
          <Tooltip title={`${e('readOnly')} — ${e('readOnlyHint')}`}>
            <span className='db-sys-toggle'>
              <span className='db-tool-label'>{e('readOnly')}</span>
              <Switch
                size='small'
                checked={isReadonly}
                onChange={toggleReadonly}
                aria-label={e('readOnly')}
              />
            </span>
          </Tooltip>
        </span>
        <span className='db-tool-sep' />
        {/* 系统库显示开关：默认显示，关闭即隐藏 information_schema 等（偏好持久化 config） */}
        <span className='db-tool-group'>
          <Tooltip title={`${e('systemSchemas')} — ${e('systemSchemasHint')}`}>
            <span className='db-sys-toggle'>
              <span className='db-tool-label'>{e('systemSchemas')}</span>
              <Switch
                size='small'
                checked={!hideSystemSchemas}
                onChange={toggleSys}
                aria-label={e('systemSchemas')}
              />
            </span>
          </Tooltip>
        </span>
        <span className='db-tool-sep' />
        <span className='db-tool-group'>
          {
            // H7a-4：Redis 独有入口，放顶栏而不是 Redis 工具条：弹层是"这个实例怎么样"，
            // 与当前在看的键无关，且顶栏是唯一跨 tab 都可见的位置
            isRedis
              ? (
                <Button
                  size='small'
                  icon={<InfoCircleOutlined />}
                  loading={redisInfo.loading && redisInfo.open}
                  onClick={openRedisInfo}
                >
                  {e('dbRedisInfo')}
                </Button>
                )
              : null
          }
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
          <Button
            type='text'
            size='small'
            icon={<ReloadOutlined />}
            loading={treeLoading}
            title={e('refresh')}
            aria-label={e('refresh')}
            onClick={() => loadTree()}
          />
        </span>
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
      {/* E2-3b 命令面板：Ctrl/Cmd+K，四类来源分组速选（open=false 时自身不渲染） */}
      <DbQuickOpen
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        items={quickItems}
        placeholder={e('dbQuickOpenPlaceholder')}
      />
      {/* C 批导出对话框：四步向导，执行参数与网格视角同源（C-12） */}
      <DbExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        tabId={tabId}
        database={sel ? sel.database : ''}
        schema={sel ? sel.schema : ''}
        table={sel ? sel.table : ''}
        columns={structureV2.columns || []}
        where={exportParts ? exportParts.where : ''}
        whereParams={exportParts ? exportParts.whereParams : []}
        orderClauses={exportParts ? exportParts.orderClauses : []}
      />
      {/* C 批导入向导：列映射/写入选型在渲染层，安全边界全部在主进程
          （只读门控、expression 白名单、danger 模式确认） */}
      <DbImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        tabId={tabId}
        database={sel ? sel.database : ''}
        schema={sel ? sel.schema : ''}
        table={sel ? sel.table : ''}
        columns={structureV2.columns || []}
        confirmRisk={confirmImportRisk}
      />
      {/* D 批：EXPLAIN 执行计划（选区/整段语句，只读分析；redis 不入口） */}
      <DbExplainDialog
        open={explainOpen}
        onClose={() => setExplainOpen(false)}
        tabId={tabId}
        database={(sel && sel.database) || tab.dbName || ''}
        schema={sel ? sel.schema : ''}
        sql={explainSql}
      />
      {/* D 批 Redis 重命名键（RENAMENX，不覆盖；冲突走后端可读错误） */}
      <Modal
        open={renameOpen}
        title={e('dbRedisRenameKey')}
        onCancel={() => setRenameOpen(false)}
        onOk={doRenameKeyNx}
        okText={e('dbRedisRenameKey')}
        cancelText={e('cancel')}
        width={420}
        destroyOnClose
      >
        <Input
          autoFocus
          value={renameInput}
          placeholder={e('dbRedisNewNamePh')}
          onChange={ev => setRenameInput(ev.target.value)}
          onPressEnter={doRenameKeyNx}
        />
      </Modal>
      {/* F2 待提交清单：主进程记录，前端只读展示（新的在前）。提交/回滚后自动关闭 */}
      <Modal
        open={txListOpen}
        title={e('dbTxStatementsTitle')}
        onCancel={() => setTxListOpen(false)}
        footer={null}
        width={780}
        destroyOnClose
      >
        {
          txState && txState.statements && txState.statements.length
            ? (
              <div className='db-tx-list'>
                <div className='db-tx-row db-tx-row-head'>
                  <span>{e('dbTxColTime')}</span>
                  <span>{e('dbTxColMs')}</span>
                  <span>{e('dbTxColAffected')}</span>
                  <span>{e('dbTxColSql')}</span>
                </div>
                {[...txState.statements].reverse().map((r, i) => (
                  <div
                    className='db-tx-row'
                    key={`${r.at}-${i}`}
                  >
                    <span>{new Date(r.at).toLocaleTimeString()}</span>
                    <span>{typeof r.ms === 'number' ? r.ms + 'ms' : ''}</span>
                    <span>{typeof r.affectedRows === 'number' ? r.affectedRows : '-'}</span>
                    <span
                      className={r.error ? 'db-tx-sql db-tx-sql-err' : 'db-tx-sql'}
                      title={r.error ? r.error : r.sql}
                    >
                      {r.sql}
                      {r.error ? ' · ' + r.error : ''}
                    </span>
                  </div>
                ))}
              </div>
              )
            : <p className='db-tx-empty'>{e('dbTxEmpty')}</p>
        }
      </Modal>
      {/* 分组管理弹窗：新建 / 重命名 / 删除 */}
      <Modal
        open={!!groupDialog}
        title={groupDialog && groupDialog.mode === 'del'
          ? e('dbFavGroupDelTitle')
          : (groupDialog && groupDialog.mode === 'rename' ? e('dbFavGroupRenameTitle') : e('dbFavGroupNewTitle'))}
        onCancel={() => { setGroupDialog(null); setGroupInput('') }}
        onOk={submitGroupDialog}
        okText={groupDialog && groupDialog.mode === 'del' ? e('dbFavGroupDel') : e('ok')}
        okButtonProps={groupDialog && groupDialog.mode === 'del' ? { danger: true } : undefined}
        cancelText={e('cancel')}
        destroyOnClose
      >
        {
          groupDialog && groupDialog.mode === 'del'
            ? (
              <p>{e('dbFavGroupDelConfirm').replace('{g}', groupDialog.name)}</p>
              )
            : (
              <Input
                value={groupInput}
                placeholder={e('dbFavGroupPh')}
                onChange={ev => setGroupInput(ev.target.value)}
                onPressEnter={submitGroupDialog}
                autoFocus
              />
              )
        }
      </Modal>
      {/* B-2 收藏编辑：标题 + 语句（复用 A 批编辑器组件，实例独立）。
          新建默认带当前编辑器内容（newFavorite 已填） */}
      <Modal
        open={!!favEdit}
        title={favEdit && favEdit.id ? e('dbFavEditTitle') : e('dbFavNewTitle')}
        onCancel={() => setFavEdit(null)}
        onOk={saveFavEdit}
        okText={e('dbFavSave')}
        cancelText={e('cancel')}
        confirmLoading={favSaving}
        width={680}
        destroyOnClose
      >
        <div className='db-fav-edit'>
          <Input
            value={favEdit ? favEdit.title : ''}
            placeholder={e('dbFavTitlePh')}
            onChange={ev => setFavEdit(s => ({ ...s, title: ev.target.value }))}
          />
          {
            // 收藏编辑：选择所属分组（含新建分组）
            <AutoComplete
              value={favEdit ? (favEdit.group || '') : ''}
              options={[
                { value: '', label: e('dbFavGroupDefault') },
                ...Object.keys(favGroups)
                  .filter(g => g !== '')
                  .sort((a, b) => a.localeCompare(b))
                  .map(g => ({ value: g, label: g }))
              ]}
              placeholder={e('dbFavGroupPh')}
              allowClear
              onChange={v => setFavEdit(s => ({ ...s, group: v }))}
              filterOption={(input, option) =>
                String((option && option.value) || '').toLowerCase().includes(String(input || '').toLowerCase())}
            />
          }
          <div className='db-fav-edit-sql'>
            <Suspense fallback={<div className='db-sql-editor db-sql-editor-skeleton' />}>
              <SqlCodeEditor
                value={favEdit ? favEdit.sql : ''}
                onChange={v => setFavEdit(s => ({ ...s, sql: v }))}
                dbType={tab.dbType}
              />
            </Suspense>
          </div>
        </div>
      </Modal>
      {
        // 一键收藏确认弹层：SQL 已定，选择分组（默认/已有/新建）后确认
        quickFav
          ? (
            <Modal
              open={!!quickFav}
              title={e('dbQuickFavTitle')}
              onCancel={() => setQuickFav(null)}
              onOk={() => doQuickFav(quickFav.group || '')}
              okText={e('dbFavSave')}
              cancelText={e('cancel')}
              width={520}
              destroyOnClose
            >
              <div className='db-fav-edit'>
                <AutoComplete
                  value={quickFav.group || ''}
                  options={[
                    { value: '', label: e('dbFavGroupDefault') },
                    ...Object.keys(favGroups)
                      .filter(g => g !== '')
                      .sort((a, b) => a.localeCompare(b))
                      .map(g => ({ value: g, label: g }))
                  ]}
                  placeholder={e('dbFavGroupPh')}
                  allowClear
                  onChange={v => setQuickFav(q => ({ ...q, group: v }))}
                />
                <pre className='db-history-preview-code'>{previewText(quickFav.sql)}</pre>
              </div>
            </Modal>
            )
          : null
      }
      {
        // 多选分组导出弹层：勾选若干分组（默认全选），按所选分组的并集导出
        exportMulti
          ? (
            <Modal
              open
              title={e('dbFavExportMulti')}
              onCancel={() => setExportMulti(null)}
              onOk={submitExportMulti}
              okText={e('dbFavExport')}
              cancelText={e('cancel')}
              width={360}
              destroyOnClose
            >
              <Checkbox.Group
                className='db-fav-export-multi'
                value={exportMulti}
                onChange={v => setExportMulti(v)}
                options={Object.keys(favGroups)
                  .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
                  .map(g => ({
                    value: g,
                    label: (
                      <span>
                        {g || e('dbFavGroupDefault')}
                        <span className='db-fav-groupcount'>（{favGroups[g] || 0}）</span>
                      </span>
                    )
                  }))}
              />
            </Modal>
            )
          : null
      }
      {/* H1a-2：列宽菜单。全站单例，5 处网格共用这一份浮层 */}
      <DbColMenu
        target={colMenuTarget}
        onHide={handleColMenuHide}
      />
      {/* 单元格右键菜单：数据页 / SQL 结果共用的全站单例浮层 */}
      <DbCellMenu
        target={cellMenu}
        onHide={() => setCellMenu(null)}
      />
      {/* H1 行详情：列序与导出同源（fields 为准），类型表按结果集下标取 */}
      <DbRowDetailModal
        open={!!sqlRowDetail}
        columns={
          sqlRowDetail && sqlResult.results && sqlResult.results[sqlRowDetail.rs]
            ? sqlExportHeaders(sqlResult.results[sqlRowDetail.rs])
            : []
        }
        row={sqlRowDetail ? sqlRowDetail.row : {}}
        types={sqlRowDetail ? (sqlColTypeMaps[sqlRowDetail.rs] || {}) : {}}
        onClose={() => setSqlRowDetail(null)}
      />
      {/* H7a-4：Redis 服务器信息（INFO 概览 / Keyspace / 原文） */}
      {
        isRedis
          ? (
            <DbRedisInfoModal
              open={redisInfo.open}
              loading={redisInfo.loading}
              error={redisInfo.error}
              text={redisInfo.text}
              onClose={closeRedisInfo}
              onRefresh={loadRedisInfo}
              slowlog={redisSlowlog}
              onLoadSlowlog={loadRedisSlowlog}
              onRefreshSlowlog={loadRedisSlowlog}
            />
            )
          : null
      }
      {/* H3b-3：ER 图（整库外键一览，只读） */}
      {
        !isRedis
          ? (
            <DbErView
              open={er.open}
              loading={er.loading}
              error={er.error}
              graph={er.graph}
              database={sel && sel.database}
              onClose={closeErGraph}
              onRefresh={loadErGraph}
              onOpenTable={openTable}
            />
            )
          : null
      }
      {/* H4：结构对比（同连接同库两张表，只读） */}
      {
        !isRedis
          ? (
            <DbStructureDiff
              open={structDiff.open}
              base={structDiff.base}
              tables={diffTables}
              dialect={dialect}
              loadStructure={loadDiffStructure}
              onClose={closeStructureDiff}
            />
            )
          : null
      }
      {/* H6a：命名参数填写（值只走参数绑定，不拼 SQL） */}
      {
        !isRedis
          ? (
            <DbSqlParamsModal
              open={sqlParams.open}
              names={sqlParams.names}
              initial={sqlParams.initial}
              onSubmit={submitSqlParams}
              onCancel={() => setSqlParams(s => ({ ...s, open: false }))}
            />
            )
          : null
      }
      {/* H7b-3：批量删键。弹层本身就是"预览 + 确认"；生产连接上 E1 还会再问一次。
          删除过程中不能取消：已经发出去的 UNLINK 收不回来，画一个"取消"只会骗人 */}
      {
        isRedis
          ? (
            <Modal
              className='db-redis-del-modal'
              open={redisDel.open}
              width={520}
              title={e('dbRedisDelKeysTitle').replace('{n}', String(redisDel.keys.length))}
              onCancel={closeRedisDel}
              footer={
                // 部分失败后只剩"关闭"：重试会把已经删掉的键再发一遍（unlink 回 0），
                // 进度会从 0 重来，看着像又删了一次；此时"取消"和"关闭"是同一个动作，
                // 留两个只会让人以为还有别的选择
                redisDel.error
                  ? [
                    <Button key='close' onClick={closeRedisDel}>
                      {e('dbRedisDelKeysClose')}
                    </Button>
                    ]
                  : [
                    <Button key='cancel' onClick={closeRedisDel} disabled={redisDel.running}>
                      {e('cancel')}
                    </Button>,
                    <Button
                      key='ok'
                      danger
                      loading={redisDel.running}
                      onClick={runRedisDel}
                    >
                      {e('dbRedisDelKeys')}
                    </Button>
                    ]
              }
            >
              <div className='db-redis-del'>
                <p className='db-redis-del-note'>
                  {e('dbRedisDelKeysBody')}
                </p>
                <div className='db-redis-del-list'>
                  {
                    redisDelPreview.shown.map(k => (
                      <div key={k} className='db-redis-del-key' title={k}>{k}</div>
                    ))
                  }
                </div>
                {
                  // "还有 N 个"放在滚动区外：列表本身会截到 220px 高，
                  // 塞在列表末尾时（600 个键时正好被截断）等于没写
                  redisDelPreview.rest
                    ? (
                      <div className='db-redis-del-more'>
                        {e('dbRedisDelKeysMore').replace('{n}', String(redisDelPreview.rest))}
                      </div>
                      )
                    : null
                }
                {
                  redisDel.running || redisDel.done
                    ? (
                      <div className='db-redis-del-prog'>
                        <Progress
                          percent={delPercent(redisDel.done, redisDel.keys.length)}
                          size='small'
                          status={redisDel.error ? 'exception' : 'active'}
                        />
                        <span className='db-redis-del-prog-text'>
                          {
                            e('dbRedisDelKeysProgress')
                              .replace('{done}', String(redisDel.done))
                              .replace('{total}', String(redisDel.keys.length))
                          }
                        </span>
                      </div>
                      )
                    : null
                }
                {
                  redisDel.error
                    ? (
                      <Alert
                        className='db-redis-del-err'
                        type='error'
                        showIcon
                        message={redisDel.error}
                        description={
                          e('dbRedisDelKeysPartial')
                            .replace('{done}', String(redisDel.done))
                            .replace('{total}', String(redisDel.keys.length))
                        }
                      />
                      )
                    : null
                }
              </div>
            </Modal>
            )
          : null
      }
      {/* 全屏时页面内唯一的退出入口（与终端相同：右上角 ⋮ → 退出全屏） */}
      <RemoteFloatControl isFullScreen={!!fullscreen} />
    </div>
  )
})
