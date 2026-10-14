/**
 * 关键字高亮的分组模型
 *
 * 配置里存的仍是一条扁平数组，靠规则自身的字段还原分组：
 *   { keyword, color, source: 'preset' | 'user', group?: string, off?: true }
 *   - source=preset + group=<预设名>    → 「预设 · 预设名」
 *   - source=user   + 无 group          → 「用户 · 手动添加」
 *   - source=user   + group=<子分组名>  → 「用户 · 子分组」（导入时创建）
 *   - off=true                          → 保留但不生效（取消勾选不丢规则）
 *
 * 老配置（无 source/group）一律按「用户 · 手动添加」处理：不迁移、不改写。
 * 组级操作用组名定位；单条操作用下标定位（同组内允许同名规则，不会误改）。
 */

// 带扩展名：单测用 node 原生 ESM 加载本文件（vite 侧同样可用）
import { keywordPresets } from './keyword-presets.js'

export const presetSource = 'preset'
export const userSource = 'user'

export const normalizeRule = (r) => {
  const rule = { ...(r || {}) }
  if (rule.source !== presetSource) {
    rule.source = userSource
  }
  return rule
}

export const isRuleOn = r => !!r && !!r.keyword && !r.off

// 传给终端 / 数据库页高亮的规则（跳过 off）
export const activeKeywords = list => (list || [])
  .map(normalizeRule)
  .filter(isRuleOn)
  .map(({ keyword, color }) => ({ keyword, color }))

const clone = list => (list || []).map(normalizeRule)

const resetOff = (rule, on) => {
  const next = { ...rule }
  if (on) {
    delete next.off
  } else {
    next.off = true
  }
  return next
}

/* ------------------------------------------------------------------ *
 * 视图
 * ------------------------------------------------------------------ */

// 预设组视图：entries 带下标，便于单条开关
export const presetGroupView = (list, preset) => {
  const entries = []
  clone(list).forEach((rule, index) => {
    if (rule.source === presetSource && rule.group === preset.name) {
      entries.push({ rule, index })
    }
  })
  const on = entries.filter(({ rule }) => isRuleOn(rule)).length
  return {
    name: preset.name,
    description: preset.description,
    total: preset.keywords.length,
    entries,
    on,
    checked: entries.length > 0 && on === entries.length,
    indeterminate: on > 0 && on < entries.length
  }
}

export const allPresetViews = list => keywordPresets.map(p => presetGroupView(list, p))

// 用户分组视图：name='' 为「手动添加」
export const userGroupViews = (list) => {
  const map = new Map()
  clone(list).forEach((rule, index) => {
    if (rule.source === presetSource) {
      return
    }
    const key = rule.group || ''
    if (!map.has(key)) {
      map.set(key, [])
    }
    map.get(key).push({ rule, index })
  })
  return [...map.entries()].map(([name, entries]) => {
    const on = entries.filter(({ rule }) => isRuleOn(rule)).length
    return {
      name,
      entries,
      on,
      checked: entries.length > 0 && on === entries.length,
      indeterminate: on > 0 && on < entries.length
    }
  })
}

export const userGroupNames = list => userGroupViews(list)
  .map(g => g.name)
  .filter(Boolean)

// 供 UI 显示「同 XXXX 预设」提示
export const presetKeywordIndex = () => {
  const map = new Map()
  for (const p of keywordPresets) {
    for (const k of p.keywords) {
      if (!map.has(k.keyword)) {
        map.set(k.keyword, p.name)
      }
    }
  }
  return map
}

export const countOn = rules => (rules || []).filter(isRuleOn).length

/* ------------------------------------------------------------------ *
 * 组级操作（按组名）
 * ------------------------------------------------------------------ */

/**
 * 勾选/取消整个预设组
 * 取消 = 只打 off 保留规则（重新勾选即恢复，不丢配置）
 */
export const setPresetGroupOn = (list, preset, on) => {
  const rules = clone(list)
  const mine = rules.filter(r => r.source === presetSource && r.group === preset.name)
  if (!mine.length) {
    if (!on) {
      return rules
    }
    for (const k of preset.keywords) {
      rules.push({
        keyword: k.keyword,
        color: k.color,
        source: presetSource,
        group: preset.name
      })
    }
    return rules
  }
  // 注意用替换而不是 Object.assign：恢复时要真正删掉 off 字段
  return rules.map(r => {
    if (r.source !== presetSource || r.group !== preset.name) {
      return r
    }
    return resetOff(r, on)
  })
}

// 用户分组（含手动添加 group=''）整体开关
export const setUserGroupOn = (list, group, on) => clone(list).map(r => {
  if (r.source === presetSource || (r.group || '') !== (group || '')) {
    return r
  }
  return resetOff(r, on)
})

export const renameUserGroup = (list, from, to) => clone(list).map(r => {
  if (r.source === presetSource || (r.group || '') !== (from || '')) {
    return r
  }
  return { ...r, group: to }
})

export const removeUserGroup = (list, group) => clone(list).filter(r => {
  return r.source === presetSource || (r.group || '') !== (group || '')
})

/* ------------------------------------------------------------------ *
 * 单条操作（按下标）
 * ------------------------------------------------------------------ */

export const setEntryOn = (list, index, on) => clone(list)
  .map((r, i) => (i === index ? resetOff(r, on) : r))

export const updateEntry = (list, index, patch) => clone(list)
  .map((r, i) => (i === index ? { ...r, ...patch } : r))

export const removeEntry = (list, index) => clone(list)
  .filter((r, i) => i !== index)

// 新增用户规则（group='' 即手动添加）
export const addUserRule = (list, { group = '', color = 'red' } = {}) => [
  ...clone(list),
  { keyword: '', color, source: userSource, group }
]

/**
 * 导入：把一批规则放进用户分组的某个子分组
 * 同组内同名（keyword 相同）规则跳过，避免重复导入越滚越多
 */
export const addImportedRules = (list, rules, group = '') => {
  const out = clone(list)
  const seen = new Set(
    out.filter(r => r.source === userSource && (r.group || '') === (group || ''))
      .map(r => r.keyword)
  )
  for (const r of rules || []) {
    if (!r || !r.keyword || seen.has(r.keyword)) {
      continue
    }
    seen.add(r.keyword)
    out.push({
      keyword: r.keyword,
      color: r.color || 'red',
      source: userSource,
      group: group || ''
    })
  }
  return out
}
