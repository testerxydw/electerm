/**
 * 结果集视角配置（数据库页 E2）主进程文件存储。
 *
 * 三件必须先说清的事：
 *
 * 1) 为何不用渲染层 localStorage：UI 经 http://127.0.0.1:<动态端口> 加载，
 *    端口每次启动都变，origin 随之漂移，localStorage 按 origin 隔离——
 *    视角配置跨启动直接读空（同一条教训记在 db-sql-history.js 头部注释里）。
 *    改存 userData 下固定 JSON 文件，与 origin 无关。
 * 2) 为何 updatedAt 只能由主进程写：该字段是 LRU 淘汰排序的唯一依据。
 *    若容许调用方传入，一次 `updatedAt: 0` 就能伪造出"永不淘汰"或
 *    "立刻淘汰别人"的顺序，缓存上限失守但表面无异常，排障极难。
 * 3) 为何存的是条件而不是查询结果：结果集无界（十万行 JSON 撑爆文件）、
 *    会过期（重开标签页时数据早已变化）、且可能含敏感行数据；
 *    视角的本质是"怎么查"（条件/排序/列布局），不是"查到了什么"。
 *
 * 键格式 `<conn>|<db>|<schema>|<table>`（四段，undefined/null 归一成空串），
 * 由渲染层 `db-grid-view.js` 的 `viewKey` 生成，本模块只当不透明字符串用，
 * 两边必须逐字符一致——不要在这里重新设计键格式。
 *
 * filePath 由调用方（ipc.js）传入，便于测试用临时目录隔离。
 */

const fs = require('fs')
const path = require('path')

const VERSION = 1
// 视角条数上限：200（LRU 淘汰上限，常量只此一处，别在别处再写死一个数）
const MAX_VIEWS = 200
// 单视角字段裁剪上限（存储侧兜底，防止渲染层塞进撑爆文件的数组）
const MAX_CONDITIONS = 20
const MAX_CONDITION_VALUES = 200
const MAX_ORDER = 3
const MAX_COLUMNS = 500

function isPlainObject (v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isPositiveNumber (v) {
  // 只认有限正数：NaN/Infinity/负数/字符串经 JSON 落盘后会变成 null 或怪值，
  // 布局阶段拿它算宽度会得到负宽或 NaN，属于"存进去时才发现"的坑
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function emptyStore () {
  return { version: VERSION, views: {} }
}

function readStore (filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw || '{}')
    // 文件缺失/损坏/半截写/版本不认识：一律视作空（视角属辅助功能，
    // 读不出来就退回默认视图，不能打断结果集渲染）
    if (!isPlainObject(data) || !isPlainObject(data.views)) {
      return emptyStore()
    }
    const views = {}
    for (const key of Object.keys(data.views)) {
      const item = data.views[key]
      // 手改过的文件里可能有非对象值，丢弃而不是让下游拿 NaN
      if (isPlainObject(item)) {
        views[key] = item
      }
    }
    return { version: VERSION, views }
  } catch (e) {
    return emptyStore()
  }
}

function writeStore (filePath, store) {
  // 原子写：先写临时文件再 rename，避免写一半崩溃留半截 JSON
  // （半截 JSON 会被 readStore 当空文件处理，等于视角全丢）
  const tmp = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(store))
  fs.renameSync(tmp, filePath)
}

function isValidKey (key) {
  if (typeof key !== 'string') {
    return false
  }
  // 空键（含纯空白）落盘后无法与"四段全空"的合法形态区分；
  // 换行会污染日志并按行解析的排查脚本，一并拒掉
  if (!key.trim()) {
    return false
  }
  return !/[\r\n]/.test(key)
}

function clipScalar (v) {
  const t = typeof v
  if (t === 'string' || t === 'boolean') {
    return v
  }
  if (t === 'number') {
    return Number.isFinite(v) ? v : null
  }
  // null/undefined/对象/函数：条件值只可能是标量或标量数组，
  // 其余形态（特别是大对象）不接受，落 null 占位而不是原样存
  return null
}

function clipValue (v) {
  if (Array.isArray(v)) {
    return v.slice(0, MAX_CONDITION_VALUES).map(clipScalar)
  }
  return clipScalar(v)
}

// 条件：最多 20 条，每条只留 column/op/value（多余的 UI 状态字段不进存储）
function clipConditions (list) {
  const out = []
  if (!Array.isArray(list)) {
    return out
  }
  for (const item of list) {
    if (out.length >= MAX_CONDITIONS) {
      break
    }
    if (!isPlainObject(item)) {
      continue
    }
    out.push({
      column: typeof item.column === 'string' ? item.column : '',
      op: typeof item.op === 'string' ? item.op : '',
      value: clipValue(item.value)
    })
  }
  return out
}

// 排序：最多 3 条，desc 只认严格 true（'false' 字符串是陷阱，不当真值用）
function clipOrder (list) {
  const out = []
  if (!Array.isArray(list)) {
    return out
  }
  for (const item of list) {
    if (out.length >= MAX_ORDER) {
      break
    }
    if (!isPlainObject(item)) {
      continue
    }
    out.push({
      column: typeof item.column === 'string' ? item.column : '',
      desc: item.desc === true
    })
  }
  return out
}

function clipStrings (list) {
  if (!Array.isArray(list)) {
    return []
  }
  return list
    .filter(x => typeof x === 'string')
    .slice(0, MAX_COLUMNS)
}

// 列宽：兼容 `{列名: 宽度}` 映射与 `[宽度...]` 数组两种形态，只留有限正数
function clipWidths (widths) {
  if (Array.isArray(widths)) {
    return widths.filter(isPositiveNumber).slice(0, MAX_COLUMNS)
  }
  if (!isPlainObject(widths)) {
    return {}
  }
  const out = {}
  for (const col of Object.keys(widths).slice(0, MAX_COLUMNS)) {
    if (isPositiveNumber(widths[col])) {
      out[col] = widths[col]
    }
  }
  return out
}

function clipPageSize (v) {
  // 只认正整数；不发明默认值——undefined 会被 JSON.stringify 省掉该键，
  // 恰好等于渲染层 normalizePageSize 的"未设置"语义（写成 0 会被当成"设过 0"）
  if (typeof v !== 'number' && typeof v !== 'string') {
    return undefined
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) {
    return undefined
  }
  return n
}

// 白名单字段过滤：只保留视角本身需要的七个字段。
// 防的是渲染层把整个 dragger 状态/连接对象/凭据顺手塞进来——
// 一旦落盘就是明文密码长期躺在 userData 里，且文件体积不可控
function pickView (view) {
  const src = isPlainObject(view) ? view : {}
  return {
    conditions: clipConditions(src.conditions),
    order: clipOrder(src.order),
    pageSize: clipPageSize(src.pageSize),
    hiddenColumns: clipStrings(src.hiddenColumns),
    columnWidths: clipWidths(src.columnWidths),
    columnOrder: clipStrings(src.columnOrder)
  }
}

// LRU 淘汰：条数超限时按 updatedAt 升序（最旧在前）删到上限。
// updatedAt 由主进程保证单调可比较，此处无需再兜 NaN——但仍用 `|| 0` 兜住
// 手改文件里缺字段的条目，避免排序退化为 NaN 比较导致的随机淘汰
function evictOldest (views) {
  const keys = Object.keys(views)
  if (keys.length <= MAX_VIEWS) {
    return views
  }
  const ordered = keys.slice().sort((a, b) => {
    const ta = Number(views[a].updatedAt) || 0
    const tb = Number(views[b].updatedAt) || 0
    return ta - tb
  })
  for (const key of ordered.slice(0, keys.length - MAX_VIEWS)) {
    delete views[key]
  }
  return views
}

// 全量读取：返回 { '<conn>|<db>|<schema>|<table>': view }
function listGridViews (filePath) {
  return readStore(filePath).views
}

// 单条读取：命中返回 view（含 updatedAt），未命中/键非法返回 null
function getGridView (key, filePath) {
  if (!isValidKey(key)) {
    return null
  }
  const views = readStore(filePath).views
  const view = views[key]
  return isPlainObject(view) ? view : null
}

// 保存：返回落盘后的 view（含主进程写的 updatedAt）；键非法或写盘失败返回 null
function saveGridView (key, view, filePath) {
  if (!isValidKey(key)) {
    // 键非法直接不写盘：写进去也读不出来，只会占 LRU 名额挤掉真实视角
    return null
  }
  const store = readStore(filePath)
  const saved = Object.assign(pickView(view), { updatedAt: Date.now() })
  store.views[key] = saved
  const views = evictOldest(store.views)
  try {
    writeStore(filePath, { version: VERSION, views })
  } catch (e) {
    // 磁盘满/权限等：视角属辅助功能，静默降级为"这次没记住"，不打断主流程
    console.warn('save db grid view failed:', e)
    return null
  }
  return saved
}

// 删除：返回是否真的删掉了（幂等——键不存在时返回 false 且不抛、不写盘）
function removeGridView (key, filePath) {
  if (!isValidKey(key)) {
    return false
  }
  const store = readStore(filePath)
  if (!Object.prototype.hasOwnProperty.call(store.views, key)) {
    return false
  }
  delete store.views[key]
  try {
    writeStore(filePath, store)
  } catch (e) {
    console.warn('remove db grid view failed:', e)
    // 没写成盘就等于没删掉，不能报成功（下次启动视角会"复活"）
    return false
  }
  return true
}

module.exports = {
  listGridViews,
  getGridView,
  saveGridView,
  removeGridView
}
