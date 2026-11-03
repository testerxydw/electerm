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

/**
 * 传给终端 / 数据库页高亮的规则（跳过 off）
 *
 * 同一份预设规则被多个预设共用时，「全部应用」会按预设各写一条（分组标记不同，
 * 面板才能按组统计勾选），但生效规则里它就是同一条：同 keyword 同 color 的重复
 * 条目扫描结果完全一致（重叠区先到先得，第二条永远被丢弃），却要多编译一个
 * RegExp、多跑一轮 exec。这里按「正则 + 颜色」去重：136 条 → 102 条，
 * 渲染结果不变。
 *
 * 只去重「正则和颜色都相同」的：同一条正则配不同颜色是两条真实意图不同的规则
 * （用户自定义规则允许和预设撞正则，见面板的「同预设」提示），必须都保留。
 */
export const activeKeywords = list => {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    const rule = normalizeRule(item)
    if (!isRuleOn(rule)) {
      continue
    }
    const { keyword, color } = rule
    const key = keyword + '\u0000' + (color || 'red')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push({ keyword, color })
  }
  return out
}

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

/**
 * 预设组视图
 *
 * entries 一律按**预设自身的规则表**展开（而不是只看配置里已存在的规则）：
 * 没应用过的预设也能展开看到它到底有哪些规则，未应用的显示为未勾选、点击即应用。
 * 已应用的条目带配置下标（index>=0）用于单条静音/恢复；未应用的 index=-1、on=false。
 */
export const presetGroupView = (list, preset) => {
  const applied = new Map()
  clone(list).forEach((rule, index) => {
    if (rule.source === presetSource && rule.group === preset.name) {
      applied.set(rule.keyword, { rule, index })
    }
  })
  const entries = preset.keywords.map(k => {
    const hit = applied.get(k.keyword)
    return {
      keyword: k.keyword,
      color: (hit && hit.rule.color) || k.color,
      rule: hit
        ? hit.rule
        : { keyword: k.keyword, color: k.color, source: presetSource, group: preset.name },
      index: hit ? hit.index : -1,
      on: !!hit && isRuleOn(hit.rule)
    }
  })
  const on = entries.filter(e => e.on).length
  return {
    name: preset.name,
    description: preset.description,
    total: preset.keywords.length,
    entries,
    on,
    checked: on > 0 && on === entries.length,
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
  return [...map.entries()].map(([name, rawEntries]) => {
    const entries = rawEntries.map(({ rule, index }) => ({
      rule,
      index,
      on: isRuleOn(rule),
      keyword: rule.keyword,
      color: rule.color
    }))
    const on = entries.filter(e => e.on).length
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
 * 勾选 = 该预设**全量**生效：已有的去掉 off，缺的按预设默认色补齐
 *        （部分应用过时点组勾选，应补齐剩余规则，而不是只恢复已有的那几条）
 * 取消 = 只打 off 保留已有规则（没应用过的无需处理）
 */
export const setPresetGroupOn = (list, preset, on) => {
  const rules = clone(list)
  const mine = rules.filter(r => r.source === presetSource && r.group === preset.name)
  const isMine = r => r.source === presetSource && r.group === preset.name
  if (!on) {
    return rules.map(r => (isMine(r) ? resetOff(r, false) : r))
  }
  const have = new Set(mine.map(r => r.keyword))
  const missing = preset.keywords.filter(k => !have.has(k.keyword))
  return [
    ...rules.map(r => (isMine(r) ? resetOff(r, true) : r)),
    ...missing.map(k => ({
      keyword: k.keyword,
      color: k.color,
      source: presetSource,
      group: preset.name
    }))
  ]
}

/**
 * 预设组内单条开关（按关键字定位，因为它可能还没在配置里）
 * 勾选：不存在就按预设默认色加进来，存在则去掉 off
 * 取消：只打 off 保留（不存在则什么都不做）
 */
export const setPresetRuleOn = (list, preset, keyword, on) => {
  const rules = clone(list)
  const hit = rules.find(r => r.source === presetSource &&
    r.group === preset.name && r.keyword === keyword)
  if (hit) {
    return rules.map(r => (r === hit ? resetOff(r, on) : r))
  }
  if (!on) {
    return rules
  }
  const lib = preset.keywords.find(k => k.keyword === keyword) || {}
  return [
    ...rules,
    {
      keyword,
      color: lib.color || 'red',
      source: presetSource,
      group: preset.name
    }
  ]
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
