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
    assert.deepEqual(activeKeywords(list), [{ keyword: 'old', color: 'red' }])
    assert.equal(normalizeRule(list[0]).source, 'user')
    const groups = userGroupViews(list)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].name, '')
    assert.equal(groups[0].entries.length, 2)
    assert.equal(groups[0].on, 1)
    assert.equal(groups[0].indeterminate, true)
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

  test('all presets view keeps 11 fixed groups even when nothing is applied', async () => {
    const { allPresetViews } = await load()
    const views = allPresetViews([])
    assert.equal(views.length, 11)
    assert.equal(views.every(v => v.on === 0 && !v.checked && !v.indeterminate), true)
    assert.equal(views.reduce((n, v) => n + v.total, 0), 147)
  })
})
