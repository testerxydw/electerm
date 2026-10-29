// SQL 结果工具行的派生链（过滤 → 排序 → 切页），纯函数，组件里只留状态与接线。
//
// 为什么全程走"下标数组"而不是先 filter 再 slice：一次执行可能是 1 万行的大数组，
// 为了切出 200 行而克隆整份行对象是白扔的内存；下标数组每行只占一个数，
// 且 __rowKey 直接就是**结果内绝对下标** —— 选中单元格、翻页回来指的还是同一行。
import { cellText } from './db-column-width'

// 过滤输入防抖：每敲一个字符就把全量结果扫一遍没必要，150ms 是"手感不断、扫描不堆"
export const SQL_FILTER_DEBOUNCE = 150

// 结果超过这个行数时，工具行额外说明"排序只作用于当前结果集"：
// 大结果下用户容易把它当成重新执行了一次带 ORDER BY 的 SQL
export const SQL_SORT_BIG_ROWS = 50000

// 每个结果集一份视图状态（按 results 下标存），切换结果页签互不影响
export function emptySqlView () {
  return { filter: '', sort: null, hidden: [] }
}

export function sqlViewOf (views, i) {
  return (views && views[i]) || emptySqlView()
}

// 补丁式更新某一份视图状态；其余结果集的状态原样保留
export function patchSqlView (views, i, patch) {
  return { ...(views || {}), [i]: { ...sqlViewOf(views, i), ...patch } }
}

export function allRowIndexes (rows) {
  const out = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) {
    out[i] = i
  }
  return out
}

// 任意列子串匹配（大小写不敏感）。匹配的是"格子里看到的文本"（cellText），
// 所以 NULL 能按 null 筛、JSON 列能按里面的键名筛 —— 与网格里所见一致。
// 空查询是"没过滤"，返回全量下标而不是空数组。
export function filterRowIndexes (rows, keys, filter) {
  const list = Array.isArray(rows) ? rows : []
  const q = String(filter || '').trim().toLowerCase()
  if (!q) {
    return allRowIndexes(list)
  }
  const cols = Array.isArray(keys) ? keys : []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    if (!row || typeof row !== 'object') {
      continue
    }
    for (const k of cols) {
      if (cellText(row[k]).toLowerCase().includes(q)) {
        out.push(i)
        break
      }
    }
  }
  return out
}

// 表头点击的三档循环：升序 → 降序 → 无排序。第一次点给升序（与常见表格一致），
// 第三次点回到"原始顺序"，用户不必刷新结果才能回到执行时的样子
export function nextSqlSort (order) {
  if (order === 'ascend') {
    return 'descend'
  }
  if (order === 'descend') {
    return null
  }
  return 'ascend'
}

// 当前结果集在这一列上的受控排序状态（antd 口径：'ascend' / 'descend' / null）。
// 列名与状态里的 key 不同就是"这一列没排序"，否则切列时箭头会留在旧列上
export function sqlSortOf (views, i, key) {
  const s = sqlViewOf(views, i).sort
  if (!s || s.key !== key || (s.order !== 'ascend' && s.order !== 'descend')) {
    return null
  }
  return s.order
}

// 列显隐：可见列 = 全部列按原顺序滤掉 hidden。过滤与渲染共用这一个函数，
// 保证"筛的列"和"屏幕上看到的列"永远同一份（隐藏列里的值不再参与命中，
// 否则会出现"筛出一堆行却看不出哪列命中的"假案）。
export function visibleSqlKeys (keys, hidden) {
  const cols = Array.isArray(keys) ? keys : []
  const hid = Array.isArray(hidden) ? hidden : []
  if (!hid.length) {
    return cols
  }
  const set = new Set(hid.map(String))
  return cols.filter(k => !set.has(String(k)))
}

// 勾掉/勾回一列，返回新的 hidden 数组；不给勾掉最后一列 —— 全隐藏的结果集
// 等于"查询跑了但什么都没有"，用户只会以为坏了。返回 null 表示这次操作不成立，
// 调用方原样保留旧状态
export function toggleSqlHidden (keys, hidden, key, checked) {
  const cols = Array.isArray(keys) ? keys : []
  const hid = Array.isArray(hidden) ? hidden : []
  if (!cols.some(k => String(k) === String(key))) {
    return null
  }
  if (!checked) {
    if (cols.length - visibleSqlKeys(cols, hid).length >= cols.length - 1) {
      return null
    }
    return [...hid.filter(k => String(k) !== String(key)), key]
  }
  return hid.filter(k => String(k) !== String(key))
}

// 数值判定：列类型已知时由调用方（isNumberType）决定；驱动没给 columns 时，
// 用值兜底推断 —— 前 sample 个非空值全是 number/bigint/数字串才算数值列。
// 一个非空值都没有的列返回 false：全 NULL 的列用什么比较都看不出差别，
// 但要是当成数值列，下一批数据变成文本就会被排错。
const NUMERIC_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
export function looksNumericColumn (rows, key, sample = 100) {
  const list = Array.isArray(rows) ? rows : []
  let seen = 0
  for (let i = 0; i < list.length && seen < sample; i++) {
    const row = list[i]
    if (!row || typeof row !== 'object') {
      continue
    }
    const v = row[key]
    if (v === null || v === undefined) {
      continue
    }
    seen++
    if (typeof v === 'number' || typeof v === 'bigint') {
      continue
    }
    if (typeof v === 'string' && NUMERIC_TEXT.test(v.trim())) {
      continue
    }
    return false
  }
  return seen > 0
}

// 把"过滤后的下标数组"按一列排序，返回新数组（不改入参）。
// NULL 恒排最后，与升降方向无关 —— 这是表格工具的通用约定：升序时 NULL 在最前
// 会把"没有值"当成"最小值"，用户第一眼看到的就是一片 NULL。
// 同值按结果内原始顺序稳定排列（否则每次点表头，同值行都会互相换位）。
export function sortRowIndexes (rows, indexes, sort, numericKeys) {
  if (!sort || !sort.key || !sort.order) {
    return indexes
  }
  const key = sort.key
  const dir = sort.order === 'descend' ? -1 : 1
  const isNum = !!(numericKeys && (typeof numericKeys.has === 'function'
    ? numericKeys.has(key)
    : Array.isArray(numericKeys) && numericKeys.includes(key)))
  const list = Array.isArray(rows) ? rows : []
  return indexes.slice().sort((ia, ib) => {
    const ra = list[ia]
    const rb = list[ib]
    const a = ra && typeof ra === 'object' ? ra[key] : undefined
    const b = rb && typeof rb === 'object' ? rb[key] : undefined
    const an = a === null || a === undefined
    const bn = b === null || b === undefined
    if (an || bn) {
      return an && bn ? ia - ib : (an ? 1 : -1)
    }
    let r
    if (isNum) {
      const na = Number(a)
      const nb = Number(b)
      r = Number.isFinite(na) && Number.isFinite(nb)
        ? na - nb
        : String(a).localeCompare(String(b))
    } else {
      r = String(a).localeCompare(String(b))
    }
    return r === 0 ? ia - ib : r * dir
  })
}
