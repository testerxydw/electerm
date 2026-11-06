/**
 * 关键字高亮的分组模型
 *
 * 配置里存的仍是一条扁平数组，靠规则自身的字段还原分组：
 *   { keyword, color, source: 'preset' | 'user', group?: string, off?: true, tier?: 'signal' | 'structure' }
 *   - source=preset + group=<预设名>    → 「预设 · 预设名」
 *   - source=user   + 无 group          → 「用户 · 手动添加」
 *   - source=user   + group=<子分组名>  → 「用户 · 子分组」（导入时创建）
 *   - off=true                          → 保留但不生效（取消勾选不丢规则）
 *
 * V2（2026-11-05）起，业务组只存领域独有规则，共享形状（IP/时间戳/路径/数字…）
 * 收进三个「通用 · *」组，业务组用 `requires` 声明依赖。勾选业务组时连带点亮被
 * 依赖的通用档；取消时按依赖计数——最后一个依赖者关掉，通用档才跟着关。规则全仓
 * 只存一份（满足用户「共享的也不行」），面板条目数因此天然等于生效数。
 */

// 带扩展名：单测用 node 原生 ESM 加载本文件（vite 侧同样可用）
import { keywordPresets, FAMILY_COLOR, FAMILY_RANK, FAMILY_LAYERS } from './keyword-presets.js'

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

export const presetByName = (name) => keywordPresets.find(p => p.name === name)

// 预设表静态索引：V2 §5「一条正则全仓只出现一次」成立，按 keyword 即可唯一定位。
// 老配置（批次 1/2 之前写入）没有 tier 字段，且可能带旧组名，所以特意只用 keyword
// 建索引，不看 group —— 这样"零迁移"也能在读时派生出正确档位（只派生、不写回配置）。
const presetTierByKeyword = new Map()
for (const p of keywordPresets) {
  for (const k of (p.keywords || [])) {
    if (!presetTierByKeyword.has(k.keyword)) {
      presetTierByKeyword.set(k.keyword, (k.tier || 'signal'))
    }
  }
}

/**
 * 一条规则的生效档位（只读派生，零迁移）：
 *  - 显式写了 tier → 尊重它（用户自定义规则也可能自己标档）；
 *  - preset 规则没写 tier → 按预设表补（覆盖所有历史配置与旧组名）；
 *  - 其余（用户自定义规则）→ signal，永不被覆盖率闸丢弃。
 */
export const ruleTierOf = (rule) => {
  if (!rule) {
    return 'signal'
  }
  if (rule.tier) {
    return rule.tier
  }
  if (rule.source !== presetSource) {
    return 'signal'
  }
  return presetTierByKeyword.get(rule.keyword) || 'signal'
}

// 预设表静态索引：family 与 tier 同理，按 keyword 唯一定位（V2 跨组唯一）。
const presetFamilyByKeyword = new Map()
for (const p of keywordPresets) {
  for (const k of (p.keywords || [])) {
    if (k.family && !presetFamilyByKeyword.has(k.keyword)) {
      presetFamilyByKeyword.set(k.keyword, k.family)
    }
  }
}
/**
 * 一条规则的信号家族（只读派生，零迁移）：显式写了就用写的，preset 规则没写就按
 * 预设表补（覆盖批次 A 之前落盘的老配置），用户自定义规则没有家族。
 */
export const ruleFamilyOf = (rule) => {
  if (!rule || !rule.keyword) {
    return undefined
  }
  if (rule.family) {
    return rule.family
  }
  if (rule.source !== presetSource) {
    return undefined
  }
  return presetFamilyByKeyword.get(rule.keyword)
}

/**
 * 一条规则的生效颜色（只读派生，零迁移）：
 *  - 预设规则的颜色永远等于家族色。配置里存的那份是老色板留下的快照（色板收紧批次
 *    把结构档从 blue/magenta/cyan 迁到真彩色），预设行在面板里只读、用户改不到，
 *    所以按家族重派生不会覆盖任何人的选择，还能让老配置直接拿到新色板；
 *  - 用户自定义规则保留自选色（「同正则换颜色」这条合法诉求走的就是它）。
 */
export const ruleColorOf = (rule) => {
  if (!rule) {
    return undefined
  }
  if (rule.source !== presetSource) {
    return rule.color
  }
  const family = ruleFamilyOf(rule)
  return (family && FAMILY_COLOR[family]) || rule.color
}

// 用户规则（无家族）的兜底 rank：结构类落在「时间数值」层、语义类落在「状态词」层。
// 这样「用户的宽口径规则靠匹配得短来吃下 IP」不再成立，同跨度长度的既有行为不变。
const userRankByTier = {
  structure: FAMILY_LAYERS['num-time'],
  signal: FAMILY_LAYERS['signal-word']
}

/**
 * 重叠裁决用的优先级：数字越小越优先。
 *  - 有家族 → 查 FAMILY_RANK（发布契约）；
 *  - 用户规则写了和某条预设**一模一样**的正则 → 继承那个家族的 rank：rank 相同、
 *    跨度相同，胜负回到数组顺序，hoistSignalBeforeStructure 把用户 signal 前置，
 *    于是「同正则换颜色」这个合法诉求仍然由用户说了算（批次 A 前的行为不变）；
 *  - 其余用户规则 → 按档位兜底。宽口径用户规则不再靠"匹配得更短"吃下 IP/路径的
 *    头一段（那是旧的「同起点取最短」留下的副作用），精确形状按 rank 优先。
 */
export const ruleRankOf = (rule) => {
  const family = ruleFamilyOf(rule) ||
    (rule && rule.keyword ? presetFamilyByKeyword.get(rule.keyword) : undefined)
  const rank = family && FAMILY_RANK[family]
  if (typeof rank === 'number') {
    return rank
  }
  return userRankByTier[rule && rule.tier === 'structure' ? 'structure' : 'signal']
}

// 依赖图：组名 → 直接 requires（同步 keyword-presets.js 里的字段）
const requiresOf = (preset) => (preset && preset.requires) || []

// 传递闭包：name 自身 + 其全部（传递）requires
export const collectRequires = (name, acc = new Set()) => {
  if (acc.has(name)) return acc
  acc.add(name)
  const p = presetByName(name)
  for (const r of requiresOf(p)) {
    collectRequires(r, acc)
  }
  return acc
}

// 给定「组当前是否启用」，判断 target 组是否被某个仍启用的组（非 exclude 集合内、
// 且不是 target 自身）依赖
const isNeededByEnabled = (list, target, enabledSet, exclude) => {
  return keywordPresets.some(other => {
    if (other.name === target) return false
    if (exclude.has(other.name) || !enabledSet.has(other.name)) return false
    return collectRequires(other.name).has(target)
  })
}

// 组是否在配置里「启用」：该组至少有一条 on 的规则
const groupEnabled = (list, name) => list
  .filter(r => r.source === presetSource && r.group === name && !r.off)
  .length > 0

/**
 * 展开一个预设的有效规则列表（含其 requires 的通用档），按规则文本+颜色去重。
 * 用于测试与「按预设构建高亮器」——保证业务组虽然只存领域规则，着色时仍拿到
 * 共享的通用规则。
 */
export const resolvePresetKeywords = (preset) => {
  const names = collectRequires(preset.name)
  const out = []
  const seen = new Set()
  for (const name of names) {
    const p = presetByName(name)
    if (!p) continue
    // 预设展开只在「预设定义」内部去重：V2 跨组唯一保证同正则同色只会来自同一条
    // 规则（tier 必然相同），无需把 tier 纳入键。这里不是 activeKeywords 的
    // 「配置 → 生效」去重口径，不要跟着改。
    for (const k of p.keywords) {
      const key = k.keyword + '\u0000' + (k.color || 'red')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(k)
    }
  }
  return out
}

/**
 * 同一「正则 + 颜色」同时存在 signal 与 structure 时，把 signal 稳定前置。
 *
 * 扫描层 arbitrateAt 的裁决是「rank 小者胜 → 同 rank 取更长 → 等长先到先得」：两条
 * 规则正则相同就必然等长，rank 也相同（同正则 → 同家族，见 ruleRankOf 的第二条分支），
 * 于是胜负回到数组顺序，谁在前面谁赢。用户自定义规则（默认 signal）通常追加在预设
 * structure 规则之后，不调整顺序的话赢的会是 structure，覆盖率闸随后在高占比行
 * 把它整条丢掉 —— 用户规则明明生效却看不到颜色。
 *
 * 只在冲突键上做局部前置，其余规则顺序完全不变；无冲突时直接返回原数组（同一
 * 引用），对「跨组唯一 + 全量预设」这类正常配置零影响。
 *
 * @param {Array} rules activeKeywords 收集出的生效规则
 * @returns {Array} signal 先于同键 structure 的新数组（无冲突时返回原数组）
 */
const hoistSignalBeforeStructure = (rules) => {
  const keyOf = r => r.keyword + '\u0000' + (r.color || 'red')
  const tiersByKey = new Map()
  for (const r of rules) {
    const k = keyOf(r)
    if (!tiersByKey.has(k)) {
      tiersByKey.set(k, new Set())
    }
    tiersByKey.get(k).add(r.tier === 'structure' ? 'structure' : 'signal')
  }
  const conflictKeys = new Set()
  for (const [k, tiers] of tiersByKey) {
    if (tiers.size > 1) {
      conflictKeys.add(k)
    }
  }
  if (conflictKeys.size === 0) {
    return rules
  }
  const isConflictSignal = r => conflictKeys.has(keyOf(r)) && r.tier !== 'structure'
  const signals = rules.filter(isConflictSignal)
  const rest = rules.filter(r => !isConflictSignal(r))
  const firstStructure = rest.findIndex(r => conflictKeys.has(keyOf(r)) && r.tier === 'structure')
  if (firstStructure < 0) {
    return rules
  }
  return [...rest.slice(0, firstStructure), ...signals, ...rest.slice(firstStructure)]
}

/**
 * 传给终端 / 数据库页高亮的规则（跳过 off）
 *
 * 同一份预设规则被多个预设共用时，「全部应用」会按预设各写一条（分组标记不同，
 * 面板才能按组统计勾选），但生效规则里它就是同一条：同 keyword 同 color 的重复
 * 条目扫描结果完全一致（重叠区先到先得，第二条永远被丢弃），却要多编译一个
 * RegExp、多跑一轮 exec。这里按「正则 + 颜色 + 档位」去重。
 *
 * 跨组唯一（V2）之后，业务组与通用组的规则文本不再重叠，这里去重主要服务
 * 「用户自定义规则撞预设正则」这种合法场景（同正则不同色、或同色不同档都要保留）。
 */
export const activeKeywords = list => {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    const rule = normalizeRule(item)
    if (!isRuleOn(rule)) {
      continue
    }
    const { keyword } = rule
    const color = ruleColorOf(rule)
    // 档位必须在去重之前派生：同正则同色但不同档 = 两条语义不同的规则
    // （用户自定义 signal 撞预设 structure）。只按「正则 + 颜色」去重会让先到的
    // 那条遮蔽后一条的档位，覆盖率闸随后误丢 / 漏丢用户规则。
    // 档位只读派生：老配置（无 tier）也能拿到预设表里的档位，覆盖率闸才有东西可丢。
    // 只写 structure（或规则原本显式带的 tier）：signal 保持「无字段」形状，
    // 与老配置零迁移兼容，也让 compileKeywords 的缺省 signal 语义不被冗余字段污染。
    const tier = ruleTierOf(rule)
    const key = keyword + '\u0000' + (color || 'red') + '\u0000' + tier
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    // family / rank 一并带给扫描层：V3 的重叠裁决按 rank 决胜，rank 不在生效规则里
    // 就没法算。family 可能为空（用户自定义规则），rank 一定有值。
    const family = ruleFamilyOf(rule)
    out.push({
      keyword,
      color,
      ...((tier !== 'signal' || rule.tier) ? { tier } : {}),
      ...(family ? { family } : {}),
      rank: ruleRankOf({ ...rule, tier })
    })
  }
  return hoistSignalBeforeStructure(out)
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
      color: (hit && ruleColorOf(hit.rule)) || k.color,
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
 * 档位操作（V2 §7.2：全部应用 = 应用语义档，结构档默认关）
 *
 * 不能复用 setPresetGroupOn 做「全部应用」：它按组展开 requires，勾选业务组会连带
 * 点亮两个通用结构档，等于把最吵的 11 条结构规则又强塞回来。全选必须按 tier 逐条
 * 置位，才能做到「signal 全开 / structure 全关」，同时不动单组勾选的 requires 语义。
 * ------------------------------------------------------------------ */

// 预设表全量规则（跨组唯一），带上归属组，按 preset 定义顺序稳定输出
const allPresetRules = () => keywordPresets.flatMap(p => (p.keywords || []).map(k => ({
  keyword: k.keyword,
  color: k.color,
  source: presetSource,
  group: p.name,
  ...(k.tier ? { tier: k.tier } : {})
})))

/**
 * 把某一档的全部预设规则整体置 on/off。已存在的条目保留（不覆盖用户改过的色），
 * 缺失的按需补进；纯函数、幂等。用户自定义规则不在此列（由调用方单独处理）。
 *
 * 按 keyword 匹配而非 group+keyword：V2 §5 保证一条正则全仓只出现一次，而老配置
 * 可能还带着批次 1 之前的旧组名。用旧组名做键会让「结构档开关」找不到存量规则。
 * 命中时顺手回填 tier（渐进自愈；只读派生 ruleTierOf 仍是不点按钮时的兜底）。
 */
export const setTierOn = (list, tier, on) => {
  const rules = clone(list)
  const byKeyword = new Map()
  rules.forEach((r, i) => {
    if (r.source === presetSource && r.keyword) {
      if (!byKeyword.has(r.keyword)) {
        byKeyword.set(r.keyword, [])
      }
      byKeyword.get(r.keyword).push(i)
    }
  })
  for (const pr of allPresetRules()) {
    if (ruleTierOf(pr) !== tier) {
      continue
    }
    const hits = byKeyword.get(pr.keyword)
    if (hits && hits.length) {
      for (const i of hits) {
        rules[i] = { ...resetOff(rules[i], on), tier: pr.tier || 'signal' }
      }
    } else if (on) {
      byKeyword.set(pr.keyword, [rules.length])
      rules.push(pr)
    }
  }
  return rules
}

/** 「全部应用」：signal 全开 + structure 全关 + 用户自定义规则全开 */
export const applySemanticTier = (list) => {
  let rules = setTierOn(list, 'signal', true)
  rules = setTierOn(rules, 'structure', false)
  return rules.map(r => (r.source === presetSource ? r : resetOff(r, true)))
}

/** 「全部取消」：所有条目打 off，不删除规则（与原有逐组取消结论一致） */
export const setAllOff = list => clone(list).map(r => resetOff(r, false))

/**
 * 结构档开关的 checked 状态。口径必须与 activeKeywords 一致（只读派生），否则
 * 老配置（无 tier）会出现「UI 显示已勾选、实际闸却没生效」的假状态。
 */
export const isStructureTierOn = (list) => {
  const onStructure = new Set(activeKeywords(list)
    .filter(r => r.tier === 'structure')
    .map(r => r.keyword))
  const structure = allPresetRules().filter(r => ruleTierOf(r) === 'structure')
  return structure.length > 0 &&
    structure.every(r => onStructure.has(r.keyword))
}

/* ------------------------------------------------------------------ *
 * 组级操作（按组名）
 * ------------------------------------------------------------------ */

// 确保一组（及其传递 requires）的全部规则都存在并 on；已有则去 off，缺则补
const ensureGroupsOn = (list, rootPreset, names) => {
  let rules = clone(list)
  for (const name of names) {
    const p = (name === rootPreset.name) ? rootPreset : presetByName(name)
    if (!p) continue
    // 这是「配置层」去重（同一组内一条规则只存一份），不是 activeKeywords 的生效
    // 去重：不能把 tier 加进来，否则同正则同色不同档会被重复插入，违反 V2
    // 「一条正则全仓只存一份」。键里同样不带 color：预设色由家族派生、面板只读，
    // 色板收紧批次之后老配置里存的那份颜色已经过期，带上颜色会让同一条正则
    // 被再写一遍（旧色一条 + 新色一条）。
    const mine = rules.filter(r => r.source === presetSource && r.group === name)
    const have = new Set(mine.map(r => r.keyword))
    rules = rules.map(r => (r.source === presetSource && r.group === name ? resetOff(r, true) : r))
    for (const k of p.keywords) {
      if (have.has(k.keyword)) continue
      have.add(k.keyword)
      rules.push({
        keyword: k.keyword,
        color: k.color,
        source: presetSource,
        group: name,
        ...(k.tier ? { tier: k.tier } : {})
      })
    }
  }
  return rules
}

// 取消一组：先关它自身，再按依赖计数关掉不再被任何启用组需要的通用档（含传递）
const disableGroupWithDeps = (list, rootName) => {
  const toDisable = new Set([rootName])
  let changed = true
  while (changed) {
    changed = false
    for (const g of [...toDisable]) {
      const p = presetByName(g)
      for (const b of requiresOf(p)) {
        if (toDisable.has(b)) continue
        const enabled = new Set(
          keywordPresets
            .filter(other => other.name !== g && !toDisable.has(other.name) && groupEnabled(list, other.name))
            .map(o => o.name)
        )
        if (!isNeededByEnabled(list, b, enabled, toDisable)) {
          toDisable.add(b)
          changed = true
        }
      }
    }
  }
  return list.map(r => (toDisable.has(r.group) ? resetOff(r, false) : r))
}

/**
 * 勾选/取消整个预设组（含其 requires 依赖）
 * 勾选 = 该组及依赖的通用档全部生效；取消 = 关自身，依赖的通用档按计数兜底关。
 */
export const setPresetGroupOn = (list, preset, on) => {
  const names = collectRequires(preset.name)
  if (on) {
    return ensureGroupsOn(list, preset, names)
  }
  return disableGroupWithDeps(list, preset.name)
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
      group: preset.name,
      ...(lib.tier ? { tier: lib.tier } : {})
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

/* ------------------------------------------------------------------ *
 * 迁移：把老配置里跨组重复写入的共享规则折叠进通用档
 * regroupSharedRules(list) 幂等、纯函数：
 *   - 每条 preset 规则按「正则 + 颜色」归一到一个归属组（优先落入其 requires 的
 *     通用档，否则保留原组）；
 *   - 同正则同色在多个组重复出现的，只保留一份（归属组取 requires 里最通用的那个），
 *     其余删掉，不丢任何一条语义。
 * 迁移不做「保留用户改过的色」分支（预设条只读，UI 走不到改色状态）。
 * ------------------------------------------------------------------ */
export const regroupSharedRules = (list) => {
  const rules = clone(list)
  const out = []
  const seen = new Set()
  // 通用档优先级：requires 指向它们的业务组，其共享规则应归属通用档
  const universalNames = new Set(
    keywordPresets.filter(p => (p.name || '').startsWith('通用 · ')).map(p => p.name)
  )
  for (const r of rules) {
    if (r.source !== presetSource) {
      out.push(r)
      continue
    }
    const key = r.keyword
    if (seen.has(key)) continue
    seen.add(key)
    // 若原组是业务组但规则属于某通用档（文本命中通用档定义），则改挂通用档。
    // 只按正则匹配：预设色是家族派生值，老配置里存的颜色可能还是旧色板快照，
    // 拿颜色当条件会让这条折叠对老配置完全不生效。
    const owner = keywordPresets.find(p =>
      (p.keywords || []).some(k => k.keyword === r.keyword))
    if (owner && universalNames.has(owner.name) && !universalNames.has(r.group)) {
      out.push({ ...r, group: owner.name })
    } else {
      out.push(r)
    }
  }
  return out
}
