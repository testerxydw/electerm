const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/common/keyword-groups.js')
const loadPresets = () => import('../../client/common/keyword-presets.js')

const preset = { name: 'Demo', description: '', keywords: [{ keyword: 'aa', color: 'red' }, { keyword: 'bb', color: 'green' }] }

describe('keyword groups', () => {
  test('old flat config keeps working: unknown source counts as user, off rules are skipped', async () => {
    const { activeKeywords, userGroupViews, normalizeRule } = await load()
    const list = [
      { keyword: 'old', color: 'red' },
      { keyword: 'muted', color: 'green', off: true }
    ]
    // 用户规则没有家族可继承 → 落到 signal 档默认 rank 50
    assert.deepEqual(activeKeywords(list), [{ keyword: 'old', color: 'red', rank: 50 }])
    assert.equal(normalizeRule(list[0]).source, 'user')
    const groups = userGroupViews(list)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].name, '')
    assert.equal(groups[0].entries.length, 2)
    assert.equal(groups[0].on, 1)
    assert.equal(groups[0].indeterminate, true)
  })

  test('生效规则按「正则 + 颜色」去重：跨预设共用的规则只编译扫描一次', async () => {
    const { activeKeywords } = await load()
    const list = [
      { keyword: 'ipv4', color: 'cyan', source: 'preset', group: 'Networking' },
      { keyword: 'ipv4', color: 'cyan', source: 'preset', group: 'Docker & Kubernetes' },
      // 同正则不同颜色 = 两条真实意图不同的规则，不能去重
      { keyword: 'ipv4', color: 'red', source: 'user' },
      { keyword: 'ipv4', color: 'cyan', source: 'preset', group: 'HTTP & web logs', off: true }
    ]
    // 'ipv4' 这里只是字面量关键词，不是任何预设规则的正则 → 无家族 → 默认 rank 50
    assert.deepEqual(activeKeywords(list), [
      { keyword: 'ipv4', color: 'cyan', rank: 50 },
      { keyword: 'ipv4', color: 'red', rank: 50 }
    ])
  })

  test('全部应用：跨组唯一后工具栏条数 == 生效条数（无重复统计失真）', async () => {
    const { activeKeywords, setPresetGroupOn } = await load()
    const { keywordPresets } = await loadPresets()
    const applied = keywordPresets.reduce((acc, p) => setPresetGroupOn(acc, p, true), [])
    const active = activeKeywords(applied)

    // 跨组唯一：每条规则全仓只存一份 → 配置条数 == 生效条数 == 工具栏求和
    const toolbarTotal = keywordPresets.reduce((n, p) => n + p.keywords.length, 0)
    assert.equal(applied.length, toolbarTotal)
    assert.equal(active.length, toolbarTotal)
    assert.equal(new Set(active.map(r => r.keyword)).size, active.length)
    // 去重不改变颜色：每条仍取预设里的配色
    const colorOf = new Map()
    for (const p of keywordPresets) {
      for (const k of p.keywords) {
        colorOf.set(k.keyword, k.color)
      }
    }
    for (const r of active) {
      assert.equal(r.color, colorOf.get(r.keyword))
    }
  })

  test('applying a preset adds its rules with source/group, unchecking only mutes them', async () => {
    const { setPresetGroupOn, presetGroupView, activeKeywords } = await load()
    const on = setPresetGroupOn([], preset, true)
    assert.deepEqual(on.map(r => [r.keyword, r.source, r.group]), [['aa', 'preset', 'Demo'], ['bb', 'preset', 'Demo']])
    assert.deepEqual(activeKeywords(on).map(r => r.keyword), ['aa', 'bb'])
    assert.equal(presetGroupView(on, preset).checked, true)

    const off = setPresetGroupOn(on, preset, false)
    assert.equal(off.length, 2)
    assert.deepEqual(off.map(r => r.off), [true, true])
    assert.deepEqual(activeKeywords(off), [])
    const st = presetGroupView(off, preset)
    assert.equal(st.checked, false)
    assert.equal(st.indeterminate, false)
    assert.equal(st.on, 0)

    // 重新勾选恢复，不重复插入
    const again = setPresetGroupOn(off, preset, true)
    assert.equal(again.length, 2)
    assert.deepEqual(again.map(r => r.off), [undefined, undefined])
  })

  test('组级勾选在部分应用时补齐剩余规则（而不是只恢复已有的）', async () => {
    const { setPresetRuleOn, setPresetGroupOn, presetGroupView, activeKeywords } = await load()
    // 只应用了其中一条
    const partial = setPresetRuleOn([], preset, 'aa', true)
    assert.equal(partial.length, 1)
    assert.equal(presetGroupView(partial, preset).indeterminate, true)
    // 组级勾选 → 补齐成整组
    const full = setPresetGroupOn(partial, preset, true)
    assert.equal(full.length, 2)
    assert.deepEqual(activeKeywords(full).map(r => r.keyword), ['aa', 'bb'])
    assert.equal(presetGroupView(full, preset).checked, true)
    // 组级取消 → 保留规则只静音
    const muted = setPresetGroupOn(full, preset, false)
    assert.equal(muted.length, 2)
    assert.deepEqual(muted.map(r => r.off), [true, true])
  })

  test('single preset rule toggle leads to indeterminate group state', async () => {
    const { setPresetGroupOn, setEntryOn, presetGroupView } = await load()
    const on = setPresetGroupOn([], preset, true)
    const one = setEntryOn(on, 0, false)
    const st = presetGroupView(one, preset)
    assert.equal(st.on, 1)
    assert.equal(st.indeterminate, true)
    assert.equal(st.checked, false)
  })

  test('index based edits only touch the targeted rule even with identical keywords', async () => {
    const { addImportedRules, setEntryOn, updateEntry, removeEntry } = await load()
    let list = addImportedRules([], [{ keyword: 'dup', color: 'red' }], 'g1')
    list = addImportedRules(list, [{ keyword: 'dup', color: 'red' }], 'g2')
    assert.equal(list.length, 2)
    list = updateEntry(list, 1, { color: 'cyan' })
    assert.deepEqual(list.map(r => r.color), ['red', 'cyan'])
    list = setEntryOn(list, 1, false)
    assert.deepEqual(list.map(r => r.off), [undefined, true])
    list = removeEntry(list, 0)
    assert.equal(list.length, 1)
    assert.equal(list[0].group, 'g2')
  })

  test('user subgroups can be renamed / muted / deleted, manual group is group ""', async () => {
    const { addImportedRules, userGroupViews, userGroupNames, renameUserGroup, setUserGroupOn, removeUserGroup, activeKeywords } = await load()
    let list = addImportedRules([{ keyword: 'm', color: 'red' }], [{ keyword: 'x', color: 'blue' }], 'f1.json')
    assert.deepEqual(userGroupNames(list), ['f1.json'])
    assert.deepEqual(userGroupViews(list).map(g => g.name), ['', 'f1.json'])

    list = renameUserGroup(list, 'f1.json', 'server 日志')
    assert.deepEqual(userGroupNames(list), ['server 日志'])

    list = setUserGroupOn(list, 'server 日志', false)
    assert.deepEqual(activeKeywords(list).map(r => r.keyword), ['m'])

    list = removeUserGroup(list, 'server 日志')
    assert.deepEqual(userGroupNames(list), [])
    assert.equal(list.length, 1)
  })

  test('re-importing the same file does not duplicate rules in that subgroup', async () => {
    const { addImportedRules } = await load()
    const rules = [{ keyword: 'dup', color: 'red' }, { keyword: 'new', color: 'cyan' }]
    let list = addImportedRules([], rules, 'g1')
    list = addImportedRules(list, rules, 'g1')
    assert.equal(list.length, 2)
    // 换一个分组则允许同名（不同分组各自保留）
    list = addImportedRules(list, rules, 'g2')
    assert.equal(list.length, 4)
  })

  test('preset keyword index helps flag duplicated user rules', async () => {
    const { presetKeywordIndex } = await load()
    const { keywordPresets } = await loadPresets()
    const idx = presetKeywordIndex()
    const sample = keywordPresets[0].keywords[0].keyword
    assert.equal(idx.get(sample), keywordPresets[0].name)
  })

  test('all presets view keeps every fixed group even when nothing is applied', async () => {
    const { allPresetViews, activeKeywords, setPresetGroupOn } = await load()
    const { keywordPresets } = await loadPresets()
    const views = allPresetViews([])
    assert.equal(views.length, keywordPresets.length)
    assert.equal(views.every(v => v.on === 0 && !v.checked && !v.indeterminate), true)
    // 跨组唯一后工具栏求和 == 生效条数
    const applied = keywordPresets.reduce((acc, p) => setPresetGroupOn(acc, p, true), [])
    assert.equal(views.reduce((n, v) => n + v.total, 0), activeKeywords(applied).length)
  })

  test('勾选业务组自动点亮其 requires 的通用档', async () => {
    const { setPresetGroupOn, activeKeywords } = await load()
    const { keywordPresets } = await loadPresets()
    const networking = keywordPresets.find(p => p.name === 'Networking')
    const applied = setPresetGroupOn([], networking, true)
    const addressGroup = keywordPresets.find(p => p.name === '通用 · 地址与路径')
    const onAddress = applied.filter(r => r.group === '通用 · 地址与路径' && !r.off)
    assert.equal(onAddress.length, addressGroup.keywords.length)
    // 共享的 IP 规则实际生效（来自 requires 的通用档）
    assert.ok(activeKeywords(applied).some(r => r.keyword.includes('25[0-5]')))
  })

  test('两个业务组共赖一档时，取消其一不误关', async () => {
    const { setPresetGroupOn } = await load()
    const { keywordPresets } = await loadPresets()
    const sysgroup = keywordPresets.find(p => p.name === 'Syslog & systemd')
    const netgroup = keywordPresets.find(p => p.name === 'Networking')
    let list = setPresetGroupOn([], sysgroup, true)
    list = setPresetGroupOn(list, netgroup, true)
    list = setPresetGroupOn(list, sysgroup, false)
    const onAddress = list.filter(r => r.group === '通用 · 地址与路径' && !r.off)
    assert.ok(onAddress.length > 0, '地址与路径 仍被 Networking 依赖，不应关')
  })

  test('最后一个依赖者取消后，通用档才跟着关', async () => {
    const { setPresetGroupOn } = await load()
    const { keywordPresets } = await loadPresets()
    const sysgroup = keywordPresets.find(p => p.name === 'Syslog & systemd')
    const netgroup = keywordPresets.find(p => p.name === 'Networking')
    const address = keywordPresets.find(p => p.name === '通用 · 地址与路径')
    let list = setPresetGroupOn([], sysgroup, true)
    list = setPresetGroupOn(list, netgroup, true)
    list = setPresetGroupOn(list, sysgroup, false)
    list = setPresetGroupOn(list, netgroup, false)
    const onAddress = list.filter(r => r.group === address.name && !r.off)
    assert.equal(onAddress.length, 0, '无依赖者后通用档应关')
  })

  test('regroupSharedRules 幂等且把共享规则归到通用档', async () => {
    const { regroupSharedRules, setPresetGroupOn } = await load()
    const { keywordPresets } = await loadPresets()
    const legacy = setPresetGroupOn([], keywordPresets.find(p => p.name === 'Networking'), true)
    // 模拟旧版：Networking 组下重复挂了一条 IP 规则（与通用档同正则同色）
    const ipv4 = keywordPresets.find(p => p.name === '通用 · 地址与路径')
      .keywords.find(k => k.keyword.includes('25[0-5]'))
    legacy.push({ keyword: ipv4.keyword, color: ipv4.color, source: 'preset', group: 'Networking' })
    const migrated = regroupSharedRules(legacy)
    const again = regroupSharedRules(migrated)
    assert.equal(again.length, migrated.length, 'migration is idempotent')
    const ipRules = migrated.filter(r => r.keyword === ipv4.keyword)
    assert.equal(ipRules.length, 1, 'shared rule folded to a single copy')
    assert.equal(ipRules[0].group, '通用 · 地址与路径', 'folded into the universal group')
  })

  // ---- 自建分组 / 新增规则（keywords-form 新功能）----

  test('addUserRule in a named group creates the group with one empty editable rule', async () => {
    const { addUserRule, userGroupViews, userGroupNames, activeKeywords } = await load()
    const next = addUserRule([], { group: '我的组' })
    assert.deepEqual(next, [{ keyword: '', color: 'red', source: 'user', group: '我的组' }])
    // 分组按 rule.group 派生：空组不存在，建组即建一条空规则
    assert.deepEqual(userGroupNames(next), ['我的组'])
    const g = userGroupViews(next)[0]
    assert.equal(g.entries.length, 1)
    assert.equal(g.entries[0].keyword, '')
    // 空规则（keyword=''）不生效也不计入统计（组件 realEntries 同口径过滤）
    assert.deepEqual(activeKeywords(next), [])
    assert.equal(g.entries.filter(e => e.keyword).length, 0)
  })

  test('addUserRule without group lands in the manual group, existing groups untouched', async () => {
    const { addUserRule, userGroupViews } = await load()
    const existing = [{ keyword: 'x', color: 'red', source: 'user', group: 'g1' }]
    const next = addUserRule(existing, {})
    assert.equal(next.length, 2)
    assert.equal(next[1].group, '')
    assert.equal(next[1].keyword, '')
    assert.deepEqual(userGroupViews(next).map(g => g.name), ['g1', ''])
  })

  test('filling a created group empty rule turns it into a live keyword rule', async () => {
    const { addUserRule, updateEntry, activeKeywords, userGroupViews, setEntryOn } = await load()
    let list = addUserRule([], { group: 'db' })
    list = updateEntry(list, 0, { keyword: 'ERROR' })
    assert.deepEqual(activeKeywords(list).map(r => r.keyword), ['ERROR'])
    const g = userGroupViews(list).find(v => v.name === 'db')
    assert.equal(g.entries.length, 1)
    assert.equal(g.entries[0].keyword, 'ERROR')
    assert.equal(g.on, 1)
    // 静音后不再生效但规则保留
    list = setEntryOn(list, 0, false)
    assert.deepEqual(activeKeywords(list), [])
    assert.equal(userGroupViews(list).find(v => v.name === 'db').entries.length, 1)
  })

  test('group name validation inputs (duplicate / empty) are detectable from views', async () => {
    const { addUserRule, userGroupViews } = await load()
    let list = addUserRule([], { group: 'db' })
    list = addUserRule(list, { group: 'db' })
    // 同组两条空规则 → 组仍只有一个（重名校验基于 userGroupViews 的 name 集合）
    const names = userGroupViews(list).map(g => g.name)
    assert.deepEqual(names, ['db'])
    assert.equal(userGroupViews(list)[0].entries.length, 2)
  })

  test('未应用的预设也能展开出完整规则清单（点击单条即应用）', async () => {
    const { presetGroupView, setPresetRuleOn, activeKeywords } = await load()
    // 配置里一条该预设的规则都没有
    const view = presetGroupView([], preset)
    assert.equal(view.entries.length, 2)
    assert.deepEqual(view.entries.map(e => [e.keyword, e.index, e.on]), [['aa', -1, false], ['bb', -1, false]])
    assert.equal(view.on, 0)
    assert.equal(view.checked, false)

    // 点单条 → 加进配置并使用预设默认色
    const applied = setPresetRuleOn([], preset, 'bb', true)
    // 'bb' 不是任何预设规则的正则 → 无家族 → 默认 rank 50
    assert.deepEqual(activeKeywords(applied), [{ keyword: 'bb', color: 'green', rank: 50 }])
    const view2 = presetGroupView(applied, preset)
    assert.deepEqual(view2.entries.map(e => [e.keyword, e.index, e.on]), [['aa', -1, false], ['bb', 0, true]])
    assert.equal(view2.indeterminate, true)

    // 再点一次 → 只打 off 保留
    const muted = setPresetRuleOn(applied, preset, 'bb', false)
    assert.equal(muted.length, 1)
    assert.equal(muted[0].off, true)
    assert.deepEqual(activeKeywords(muted), [])
    const view3 = presetGroupView(muted, preset)
    assert.equal(view3.entries.find(e => e.keyword === 'bb').on, false)
    assert.equal(view3.entries.find(e => e.keyword === 'bb').index, 0)
  })

  test('同正则同色不同档：两条都在生效列表，signal 无 tier 字段且排在 structure 前', async () => {
    const { activeKeywords } = await load()
    const { keywordPresets, FAMILY_RANK } = await loadPresets()
    const universal = keywordPresets.find(p => p.name === '通用 · 时间与数值')
    const structureRule = universal.keywords.find(k =>
      k.tier === 'structure' && new RegExp(k.keyword, 'gi').test('233G'))
    assert.ok(structureRule, 'fixture 需要一条真实预设 structure 规则')
    const list = [
      {
        keyword: structureRule.keyword,
        color: structureRule.color,
        source: 'preset',
        group: universal.name,
        tier: 'structure'
      },
      { keyword: structureRule.keyword, color: structureRule.color, source: 'user' }
    ]
    const active = activeKeywords(list)
    assert.equal(active.length, 2, '档位纳入去重键后两条规则都应生效')
    assert.deepEqual(active[0], {
      keyword: structureRule.keyword,
      color: structureRule.color,
      rank: FAMILY_RANK[structureRule.family]
    }, 'signal 规则必须保持「无 tier 字段」形状、继承同正则的家族 rank，且排在 structure 前')
    assert.equal(active[1].tier, 'structure')
    assert.equal(active[0].keyword, active[1].keyword)
    assert.equal(active[0].color, active[1].color)
  })

  test('同正则不同档时 signal 赢下等长裁决，覆盖率闸不丢用户规则', async () => {
    const { activeKeywords } = await load()
    const { keywordPresets } = await loadPresets()
    const { compileKeywords, clearKeywordCache, hexToTruecolor } =
      await import('../../client/common/keyword-compile.js')
    const { buildScan, collectMatches, applyCoverageGate } =
      await import('../../client/common/keyword-scan.js')
    const { KeywordHighlighterAddon } =
      await import('../../client/components/terminal/highlight-addon.js')
    const universal = keywordPresets.find(p => p.name === '通用 · 时间与数值')
    const structureRule = universal.keywords.find(k =>
      k.tier === 'structure' && new RegExp(k.keyword, 'gi').test('233G'))
    const active = activeKeywords([
      { keyword: structureRule.keyword, color: structureRule.color, source: 'preset', group: universal.name, tier: 'structure' },
      { keyword: structureRule.keyword, color: structureRule.color, source: 'user' }
    ])
    const line = '233G '.repeat(30).trim()
    clearKeywordCache()
    const patterns = compileKeywords(active)
    const scan = buildScan(patterns)
    const hits = collectMatches(line, patterns, scan, 512)
    assert.ok(hits.length >= 20, 'fixture sanity：规则确实扫到大量命中')
    assert.ok(hits.every(h => h.tier === 'signal'), '等长裁决必须让 signal 赢')
    assert.equal(applyCoverageGate(line, hits), hits, '全是 signal 命中时闸走快路径原样返回')

    // 端到端：高占比行仍然看得见颜色
    const addon = new KeywordHighlighterAddon(active)
    assert.ok(addon.highlightKeywords(line).includes(hexToTruecolor(structureRule.color) + '233G'))

    // 反证：若 structure 排在前面（即不做 signal 前置），等长裁决会让它赢并被闸丢弃
    const reversed = compileKeywords([active[1], active[0]])
    const reversedScan = buildScan(reversed)
    const reversedHits = collectMatches(line, reversed, reversedScan, 512)
    assert.ok(reversedHits.every(h => h.tier === 'structure'))
    assert.ok(applyCoverageGate(line, reversedHits).length < reversedHits.length,
      '反证：structure 先到会被覆盖率闸丢掉，signal 前置是必需的')
  })
})
