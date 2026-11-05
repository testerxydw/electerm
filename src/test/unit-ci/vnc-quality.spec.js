// 批次：VNC 顶栏画质档位 + 自定义滑杆（草图 2026-11-05 方案 A）
//
// 背景（草图 §四 / §七）：画质的首连取值 = 本机逐 host 记忆 > 书签 > 出厂默认 3/1，
// 与缩放开关完全同构；栏内改画质只写 noVNC 的 setter + 本机记忆，不回写 tab/书签。
// 上半是纯函数契约（remote-adapt.js 的 QUALITY_PRESETS / resolveQuality），
// 下半是源码字符串契约：纯函数对了但组件没接线，等于没做（照 vnc-screen-gate.spec.js）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const loadMod = () => import('../../client/common/remote-adapt.js')

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('VNC 画质档位常量', () => {
  test('五档映射与草图 §三 一致，balanced 等于书签默认 3/1', async () => {
    const { QUALITY_PRESETS, DEFAULT_QUALITY } = await loadMod()
    const table = QUALITY_PRESETS.map(p => [p.key, p.qualityLevel, p.compressionLevel])
    assert.deepEqual(table, [
      ['smooth', 2, 6],
      ['balanced', 3, 1],
      ['sharp', 6, 2],
      ['fine', 8, 2],
      ['narrowband', 5, 9]
    ])
    assert.deepEqual(DEFAULT_QUALITY, { qualityLevel: 3, compressionLevel: 1 })
  })

  test('每个档位都有词条 key 且数值落在 0-9', async () => {
    const { QUALITY_PRESETS } = await loadMod()
    for (const p of QUALITY_PRESETS) {
      assert.ok(typeof p.labelKey === 'string' && p.labelKey.length > 0, p.key + ' labelKey')
      assert.ok(Number.isInteger(p.qualityLevel) && p.qualityLevel >= 0 && p.qualityLevel <= 9, p.key + ' q')
      assert.ok(Number.isInteger(p.compressionLevel) && p.compressionLevel >= 0 && p.compressionLevel <= 9, p.key + ' c')
    }
  })

  test('记忆 key 按 host，与缩放开关同一命名口径', async () => {
    const { qualityLsKey } = await loadMod()
    assert.equal(qualityLsKey('192.168.25.7'), 'vnc-quality-192.168.25.7')
  })
})

describe('VNC 画质取值决策', () => {
  test('本机记忆优先于书签', async () => {
    const { resolveQuality } = await loadMod()
    const got = resolveQuality({ qualityLevel: 8, compressionLevel: 3 }, 6, 2)
    assert.deepEqual(got, { qualityLevel: 8, compressionLevel: 3 })
  })

  test('本机没设过才轮到书签', async () => {
    const { resolveQuality } = await loadMod()
    assert.deepEqual(resolveQuality(null, 6, 2), { qualityLevel: 6, compressionLevel: 2 })
    assert.deepEqual(resolveQuality(undefined, 6, 2), { qualityLevel: 6, compressionLevel: 2 })
  })

  test('书签也没有就落出厂默认 3/1', async () => {
    const { resolveQuality } = await loadMod()
    assert.deepEqual(resolveQuality(null, undefined, undefined), { qualityLevel: 3, compressionLevel: 1 })
    assert.deepEqual(resolveQuality(null, null, null), { qualityLevel: 3, compressionLevel: 1 })
  })

  test('记忆里的脏值（越界/字符串空档）单轴回落到书签，另一轴不牵连', async () => {
    const { resolveQuality } = await loadMod()
    // 记忆 qualityLevel=88 越界 → 回书签 6；compressionLevel=2 正常 → 保留
    assert.deepEqual(resolveQuality({ qualityLevel: 88, compressionLevel: 2 }, 6, 9), {
      qualityLevel: 6,
      compressionLevel: 2
    })
    // 字符串数字归一（历史书签存过 '8'）
    assert.deepEqual(resolveQuality(null, '8', 2), { qualityLevel: 8, compressionLevel: 2 })
    // 非数字串被丢
    assert.deepEqual(resolveQuality(null, 'abc', 2), { qualityLevel: 3, compressionLevel: 2 })
  })

  test('档位是 (Q,C) 的派生值：命中预设返回 key，否则自定义', async () => {
    const { presetKeyFor, QUALITY_CUSTOM } = await loadMod()
    assert.equal(presetKeyFor(3, 1), 'balanced')
    assert.equal(presetKeyFor(8, 2), 'fine')
    assert.equal(presetKeyFor(7, 4), QUALITY_CUSTOM)
  })
})

describe('VNC 画质组件接线（源码契约）', () => {
  const src = read('src/client/components/vnc/vnc-session.jsx')

  test('首连/重连/挂起恢复喂给 rfb 的画质来自 state 决策值，不读 tab 字段', () => {
    // 决策在 constructor 一次性算出进 state
    assert.ok(src.includes('const quality = resolveQuality('), 'constructor 用 resolveQuality 决策')
    assert.ok(/resolveQuality\(\s*\n\s*ls\.getItemJSON\(qualityLsKey\(props\.tab\?\.host\)/.test(src), '记忆按 host 读')
    assert.ok(src.includes('qualityLevel: quality.qualityLevel'), '决策值进 state')
    // tab 解构里不再带画质字段
    const tabDestruct = src.match(/const \{\n([\s\S]*?)\n {4}\} = tab/)
    assert.ok(tabDestruct, 'tab 解构存在')
    assert.ok(!tabDestruct[1].includes('qualityLevel'), 'tab 解构不该再读 qualityLevel')
    // remoteInit 里明确从 this.state 解出画质
    const stateRead = src.match(/const \{ qualityLevel, compressionLevel \} = this\.state/)
    assert.ok(stateRead, 'remoteInit 从 this.state 解出画质')
  })

  test('运行中改画质：setter 判等后才写，同值不重复发帧', () => {
    const commit = src.match(/handleQualityCommit = \(qualityLevel, compressionLevel\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(commit, 'handleQualityCommit 存在')
    assert.ok(commit[0].includes('prev.qualityLevel !== qualityLevel'), 'Q 判等')
    assert.ok(commit[0].includes('prev.compressionLevel !== compressionLevel'), 'C 判等')
    assert.ok(src.includes('this.appliedQuality = { qualityLevel, compressionLevel }'), '记录已应用值')
    assert.ok(src.includes('rfb.qualityLevel = qualityLevel'), '写 noVNC setter')
  })

  test('运行中改画质不回写 tab / 书签', () => {
    const commit = src.match(/handleQualityCommit = \(qualityLevel, compressionLevel\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(commit, 'handleQualityCommit 存在')
    assert.ok(!commit[0].includes('.tab.'), '不写 tab')
    assert.ok(!commit[0].includes('editTab'), '不写书签')
    assert.ok(commit[0].includes('qualityLsKey(this.props.tab?.host)'), '只写本机记忆（按 host）')
  })

  test('预设映射与滑杆共用同一份 QUALITY_PRESETS 常量，不各写一份', () => {
    assert.ok(src.includes('QUALITY_PRESETS.map(p =>'), '档位 Select 遍历常量')
    assert.ok(src.includes('DEFAULT_QUALITY.qualityLevel'), '恢复默认用常量')
  })

  test('未连接（loading/error）时 Select 与滑杆置灰', () => {
    const region = src.match(/renderDisplayItems = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(region, 'renderDisplayItems 存在')
    assert.ok(region[0].includes('const qualityDisabled = !connected || loading'), '未连接/加载中置灰')
    assert.ok(region[0].includes('disabled={qualityDisabled}'), 'Select 置灰')
    assert.ok(src.includes('disabled={!connected}'), '滑杆与恢复按钮置灰')
  })

  test('画质控件留在左栏 displayItems（P-7 口径），不进 ⋮', () => {
    assert.ok(src.includes('{this.renderQualityPanel()}'), '面板作为 Popover content 挂上')
    const displayItems = src.match(/renderDisplayItems = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(displayItems, 'renderDisplayItems 存在')
    assert.ok(displayItems[0].includes('<Select'), '画质档位 Select 在栏内条目里')
    assert.ok(displayItems[0].includes('<Popover'), '自定义面板锚在栏内')
  })
})
