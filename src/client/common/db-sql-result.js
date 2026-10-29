// SQL 结果工具行的派生链（过滤 → 排序 → 切页），纯函数，组件里只留状态与接线。
//
// 为什么全程走"下标数组"而不是先 filter 再 slice：一次执行可能是 1 万行的大数组，
// 为了切出 200 行而克隆整份行对象是白扔的内存；下标数组每行只占一个数，
// 且 __rowKey 直接就是**结果内绝对下标** —— 选中单元格、翻页回来指的还是同一行。
import { cellText } from './db-column-width'

// 过滤输入防抖：每敲一个字符就把全量结果扫一遍没必要，150ms 是"手感不断、扫描不堆"
export const SQL_FILTER_DEBOUNCE = 150

// 每个结果集一份视图状态（按 results 下标存），切换结果页签互不影响
export function emptySqlView () {
  return { filter: '' }
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
