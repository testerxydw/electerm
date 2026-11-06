/**
 * db-session 拆出的第一段：会话页的纯常量与纯函数。
 *
 * N11a（工程债收口）的第一步：`db-session.jsx` 已 10228 行，后续每个批次都往同一个
 * 文件里堆。这一段是文件里唯一"零 React、零 JSX"的部分，先搬出去既给主文件止血，
 * 也给后面的拆分定下做法——**行为零变更**：每个值、每条注释都原样搬，
 * 判据不重写，只把源码契约测试的读取路径指过来。
 *
 * 边界：JSX 形状的东西留在组件里（DB_OBJECT_ICONS / DB_GROUP_ICONS 两张图标表、
 * RedisTypeChip / RedisTtlChip 两个芯片组件），因为它们 require 的是渲染层依赖；
 * 这里只放"常量表 + 纯函数"，单测可以直接 require 源码跑（与 common/db-*.js 同构）。
 *
 * 声明一律保持 `const NAME = ...` 不带 export 前缀、集中写在文件末尾导出：
 * 原有源码契约测试是按 `^const isLeafNode = .+$` 这类行首正则抽取真实源码执行的
 * （见 db-page-tree-filter.spec.js），改成 `export const` 会让它们抽不到函数体。
 */

import { isPgFamily } from './db-engine-family'

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
  label: window.translate('dbPerPage').replace('{n}', n)
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
// 计数徽标：分组/ schema 下有多少个可打开的对象（表/视图/过程/函数/触发器/事件）
const countTreeLeaves = nodes => (nodes || []).reduce(
  (n, node) => n + (isLeafNode(node) ? 1 : countTreeLeaves(node.children)),
  0
)
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
// sqlite 适配器把 PRAGMA table_info 归一成了 MySQL 那套字段名（含 Extra=auto_increment
// 对应 INTEGER PRIMARY KEY），所以这里只需两分支；isNumeric 的类型正则也覆盖
// INTEGER/REAL/NUMERIC/DECIMAL 这些 sqlite 亲和性名。
// 统一为 [{name, type, isPk, isAutoInc, isNumeric}] 供插入弹窗渲染与校验
const buildInsertFormColumns = (structureRows, dbType) => {
  const isPg = isPgFamily(dbType)
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

export {
  DB_PAGE_SIZE_DEFAULT,
  DB_PAGE_SIZE_MAX,
  getDbPageSize,
  SQL_RESULT_PAGE_SIZE,
  DB_PAGE_OPTIONS,
  dbPageSizeOptions,
  getSqlResultPageSize,
  VALUE_META_MIN,
  sqlPageIndex,
  getSqlKeywordCase,
  viewportSize,
  TREE_WIDTH_KEY,
  TREE_MIN_W,
  TREE_MAX_W,
  REDIS_SPLIT_KEY,
  CELL_SPLIT_KEY,
  SQL_VALUE_SPLIT_KEY,
  REDIS_VALUE_SPLIT_KEY,
  REDIS_DETAIL_PAGE,
  NA,
  dash,
  REDIS_KEY_JUMP_WARN_PAGES,
  REDIS_TREE_MAX_KEYS,
  REDIS_TREE_SCAN_COUNT,
  REDIS_TREE_AUTO_EXPAND_KEYS,
  buildKeyPathIndex,
  redisKeyPagesOf,
  SEL_COL_W,
  isLeafNode,
  DB_OBJECT_MARKS,
  isDbObjectType,
  countTreeLeaves,
  DB_GROUP_LABEL,
  nodeKey,
  HOME_TABLES_MAX,
  EMPTY_STRUCTURE_V2,
  buildInsertFormColumns,
  previewLiteral,
  writeTargetLabel
}
