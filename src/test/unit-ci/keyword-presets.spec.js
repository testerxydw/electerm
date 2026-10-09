const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadAddon = () => import('../../client/components/terminal/highlight-addon.js')
const loadPresets = () => import('../../client/common/keyword-presets.js')

describe('keyword presets', () => {
  test('every Networking rule compiles with the flags the addon uses', async () => {
    const { keywordPresets } = await loadPresets()
    const preset = keywordPresets.find(p => p.name === 'Networking')
    assert.ok(preset)
    for (const { keyword, color } of preset.keywords) {
      assert.doesNotThrow(() => new RegExp(keyword, 'gi'), keyword)
      assert.ok(['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].includes(color))
    }
  })

  test('Networking preset colours typical switch output', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(keywordPresets.find(p => p.name === 'Networking').keywords)
    const out = addon.highlightKeywords('Gi1/0/3   notconnect   600   26.132.128.13   0011.2233.4455')

    assert.ok(out.includes('\u001b[34mGi1/0/3')) // interface: blue
    assert.ok(out.includes('\u001b[31mnotconnect')) // state: red
    assert.ok(out.includes('\u001b[36m26.132.128.13')) // IP: cyan
    assert.ok(out.includes('\u001b[35m0011.2233.4455')) // MAC: magenta
  })

  test('Networking preset covers other vendors and leaves plain words alone', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const addon = new KeywordHighlighterAddon(keywordPresets.find(p => p.name === 'Networking').keywords)
    const blue = '\u001b[34m'
    const interfaces = [
      'ge-0/0/0', 'irb.100', 'ae0', // Juniper
      'Et1', 'Ma1', // Arista
      '1/1/1', 'Trk1', // HPE Aruba CX, ProCurve
      'XGE1/0/1', 'Bridge-Aggregation1', // HP Comware
      'XGigabitEthernet0/0/1', '40GE1/0/1', 'Eth-Trunk1', 'Vlanif10', // Huawei
      'eth1.100', 'switch0', // Ubiquiti EdgeOS
      'ether1', 'sfp-sfpplus1' // MikroTik
    ]
    for (const name of interfaces) {
      assert.ok(addon.highlightKeywords(`port ${name} status`).includes(blue + name), name)
    }
    // EdgeOS state flags and Comware admin down
    assert.ok(addon.highlightKeywords('eth0 u/u').includes('\u001b[32mu/u'))
    assert.ok(addon.highlightKeywords('eth1 A/D').includes('\u001b[31mA/D'))
    assert.ok(addon.highlightKeywords('GE1/0/2 ADM').includes('\u001b[31mADM'))
    const prose = 'the page 5 says ether and ge stay plain on 10/08/26'
    assert.equal(addon.highlightKeywords(prose), prose)
  })

  test('every built-in preset rule compiles with the flags the addon uses', async () => {
    const { keywordPresets } = await loadPresets()
    assert.ok(keywordPresets.length >= 8, 'expected the built-in preset catalogue')
    const allowed = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
    for (const preset of keywordPresets) {
      assert.ok(preset.name && preset.description, `${preset.name || '?'} needs name + description`)
      assert.ok(preset.keywords.length, `${preset.name} has no rules`)
      for (const { keyword, color } of preset.keywords) {
        assert.doesNotThrow(() => new RegExp(keyword, 'gi'), `${preset.name}: ${keyword}`)
        assert.ok(allowed.includes(color), `${preset.name}: colour ${color} not in the addon map`)
      }
    }
  })

  test('presets highlight representative lines', async () => {
    const { keywordPresets } = await loadPresets()
    const { KeywordHighlighterAddon } = await loadAddon()
    const byName = n => keywordPresets.find(p => p.name === n)
    const out = (name, line) => new KeywordHighlighterAddon(byName(name).keywords).highlightKeywords(line)

    assert.ok(out('Log Levels', '2026-10-09 ERROR boom').includes('\u001b[31mERROR'))
    assert.ok(out('Timestamps', 'up since 2026-10-09T08:00:00Z').includes('\u001b[35m2026-10-09T08:00:00Z'))
    assert.ok(out('Exceptions & Stack Traces', 'java.lang.NullPointerException: x').includes('\u001b[31mjava.lang.NullPointerException'))
    assert.ok(out('Containers & Kubernetes', 'pod/web-0 CrashLoopBackOff').includes('\u001b[31mCrashLoopBackOff'))
    assert.ok(out('Git & VCS', '<<<<<<< HEAD').includes('\u001b[31m<<<<<<<'))
    assert.ok(out('Build & Test', '42 passed, 3 failed').includes('\u001b[32m42 passed'))
    assert.ok(out('Security & Auth', 'sudo: permission denied for x').includes('\u001b[31mpermission denied'))
    // plain prose stays untouched (negative control)
    const prose = 'the weather is fine today'
    assert.equal(out('Log Levels', prose), prose)
  })

  test('applying a preset keeps custom rules and skips duplicates', async () => {
    const { keywordPresets, mergeKeywordPreset } = await loadPresets()
    const preset = keywordPresets[0]
    const existing = [{ color: 'red' }, { keyword: 'mine', color: 'white' }, { ...preset.keywords[0] }]
    const merged = mergeKeywordPreset(existing, preset)

    assert.equal(merged[0].keyword, 'mine')
    assert.equal(merged.length, 1 + preset.keywords.length)
    assert.equal(mergeKeywordPreset(merged, preset).length, merged.length)
  })
})
