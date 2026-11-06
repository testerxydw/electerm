const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// V3 信号家族契约（doc/设计-关键字高亮色板与密度-v3-2026-11-06.md §3）的可执行化。
// 这里断言的是「结构约束」，不是某条正则的行为：家族一旦标注缺失、跨组复用、
// 一族多色、rank 漏登记，立刻在这里失败——而不是等到用户在终端里看到 IP 变粉。

const loadPresets = () => import('../../client/common/keyword-presets.js')
const loadGroups = () => import('../../client/common/keyword-groups.js')
const loadCompile = () => import('../../client/common/keyword-compile.js')
const loadScan = () => import('../../client/common/keyword-scan.js')

// 七个 ANSI 语义名 = 主题映射，专门给「错误/警告/成功/信息/调试/空值/杂项」这类
// 跨领域语义信号用。结构档占用它们就是「一个颜色两种语义」的开始。
const ansiNames = new Set(['red', 'yellow', 'green', 'blue', 'magenta', 'cyan', 'white'])

// 家族 → 规则列表（全量预设展开，按 family 归组）
const familyIndex = async () => {
  const { keywordPresets } = await loadPresets()
  const byFamily = new Map()
  const rules = []
  for (const p of keywordPresets) {
    for (const k of p.keywords) {
      rules.push({ ...k, group: p.name })
      if (!byFamily.has(k.family)) byFamily.set(k.family, [])
      byFamily.get(k.family).push({ ...k, group: p.name })
    }
  }
  return { byFamily, rules, keywordPresets }
}

describe('V3 信号家族契约', () => {
  test('家族登记表（§4）：每条预设规则都声明 family，且 family 已登记 rank / 归属组', async () => {
    const { keywordPresets, FAMILY_RANK, FAMILY_HOME, FAMILY_LAYERS } = await loadPresets()
    const layers = new Set(Object.values(FAMILY_LAYERS))
    const declared = new Set()
    for (const p of keywordPresets) {
      for (const k of p.keywords) {
        declared.add(`${k.family}\u0000${p.name}`)
      }
    }
    for (const p of keywordPresets) {
      for (const k of p.keywords) {
        assert.ok(k.family, `${p.name} 的规则缺少 family：${k.keyword}`)
        assert.ok(k.family in FAMILY_RANK, `家族 ${k.family} 未登记 FAMILY_RANK`)
        assert.ok(layers.has(FAMILY_RANK[k.family]), `家族 ${k.family} 的 rank ${FAMILY_RANK[k.family]} 不在层级表里`)
        assert.ok(declared.has(`${k.family}\u0000${FAMILY_HOME[k.family]}`),
          `FAMILY_HOME[${k.family}] = ${FAMILY_HOME[k.family]} 并没有声明这个家族`)
      }
    }
  })

  // 棘轮：同一个家族在多个配置组里各存一份词表/形状 —— 这正是「一个关键字散落在
  // 多个配置里」的残留。批次 B（词表去重）收 word-* 三条，批次 C（形状边界）收
  // duration / host-port 两条；收一条就从这里删一条，清空后改成硬断言。
  const CROSS_GROUP_FAMILIES = [
    'duration',
    'host-port',
    'word-error',
    'word-ok',
    'word-warn'
  ]
  test('KU-2 一归属 棘轮：跨组复用的家族清单不得增加（批次 B/C 逐个收口）', async () => {
    const { byFamily } = await familyIndex()
    const offenders = []
    for (const [family, list] of byFamily) {
      if (new Set(list.map(r => r.group)).size > 1) offenders.push(family)
    }
    offenders.sort()
    assert.deepEqual(offenders, CROSS_GROUP_FAMILIES,
      `跨组复用的家族与棘轮基线不一致：${offenders.join(' ')}。新增跨组家族必须先给它一个唯一归属组。`)
  })

  test('KU-1 一色：一个家族一种颜色（同族多条异形规则也同色）', async () => {
    const { byFamily } = await familyIndex()
    for (const [family, list] of byFamily) {
      const colors = new Set(list.map(r => r.color))
      assert.equal(colors.size, 1, `家族 ${family} 有 ${colors.size} 种颜色：${[...colors].join(' / ')}`)
    }
  })

  test('KU-1 推论：一个家族一个档位（signal/structure 不混用）', async () => {
    const { byFamily } = await familyIndex()
    for (const [family, list] of byFamily) {
      const tiers = new Set(list.map(r => r.tier))
      assert.equal(tiers.size, 1, `家族 ${family} 混用了档位：${[...tiers].join(' / ')}`)
    }
  })

  test('KU-6 一色一语义：signal 档家族只用七个 ANSI 语义名（颜色即语义，跨主题稳定）', async () => {
    const { byFamily } = await familyIndex()
    for (const [family, list] of byFamily) {
      if (list[0].tier !== 'signal') continue
      assert.ok(ansiNames.has(list[0].color),
        `signal 家族 ${family} 用了真彩色 ${list[0].color}，语义色表被绕过`)
    }
  })

  // 棘轮：结构档占用 ANSI 语义名的家族数。这些家族应当逐个迁到真彩色
  // （批次 E「色板收紧 KU-6」），只许降不许升；降到 0 后把基线改成 0 变成硬约束。
  const STRUCTURE_ON_ANSI_BASELINE = 35
  test('KU-6 棘轮：结构档占用 ANSI 语义名的家族数不得增加', async () => {
    const { byFamily } = await familyIndex()
    const offenders = []
    for (const [family, list] of byFamily) {
      if (list[0].tier === 'structure' && ansiNames.has(list[0].color)) offenders.push(family)
    }
    assert.ok(offenders.length <= STRUCTURE_ON_ANSI_BASELINE,
      `结构档占用 ANSI 语义名的家族数 ${offenders.length} > 基线 ${STRUCTURE_ON_ANSI_BASELINE}：${offenders.join(' ')}。` +
      '新增结构家族必须用真彩色（keywordPalette 里的 hex），不要挤进七个语义名。')
  })

  test('KU-5 裁决：rank 由家族派生：用户规则无家族走档位默认，与预设正则逐字相同则继承家族 rank', async () => {
    const { keywordPresets, FAMILY_RANK } = await loadPresets()
    const { ruleRankOf, ruleFamilyOf } = await loadGroups()
    const sizeRule = keywordPresets
      .find(p => p.name === '通用 · 时间与数值')
      .keywords.find(k => k.family === 'size')
    // 预设原样 → 家族 rank
    assert.equal(ruleFamilyOf(sizeRule), 'size')
    assert.equal(ruleRankOf(sizeRule), FAMILY_RANK.size)
    // 用户改了颜色的同正则 → 仍继承家族 rank（"同正则、我的色"这条老行为不变）
    assert.equal(ruleRankOf({ keyword: sizeRule.keyword, color: 'red' }), FAMILY_RANK.size)
    // 用户自定义正则：structure 落到数值时间层，signal 落到状态词层
    assert.equal(ruleRankOf({ keyword: 'mything', color: 'red', tier: 'structure' }), 40)
    assert.equal(ruleRankOf({ keyword: 'mything', color: 'red' }), 50)
    assert.equal(ruleFamilyOf({ keyword: 'mything', color: 'red' }), undefined)
    // 显式声明 family 优先于按正则反查
    assert.equal(ruleRankOf({ keyword: 'whatever', family: 'ipv4' }), FAMILY_RANK.ipv4)
  })

  test('KU-5 裁决：rank 进入编译摘要：只改档位/家族不会命中旧缓存', async () => {
    const { compileKeywords, clearKeywordCache, keywordsSignature } = await loadCompile()
    clearKeywordCache()
    const a = compileKeywords([{ keyword: 'x', color: 'red', rank: 10 }])
    const b = compileKeywords([{ keyword: 'x', color: 'red', rank: 60 }])
    assert.notEqual(a[0].rank, b[0].rank)
    assert.equal(a[0].rank, 10)
    assert.equal(b[0].rank, 60)
    assert.notEqual(keywordsSignature([{ keyword: 'x', rank: 10 }]), keywordsSignature([{ keyword: 'x', rank: 60 }]))
  })

  test('KU-5 裁决：生效规则带上派生 rank，全量预设的家族色/档一处不差', async () => {
    const { keywordPresets, FAMILY_RANK } = await loadPresets()
    const { activeKeywords, setPresetGroupOn } = await loadGroups()
    const applied = keywordPresets.reduce((acc, p) => setPresetGroupOn(acc, p, true), [])
    const active = activeKeywords(applied)
    assert.equal(active.length, keywordPresets.reduce((n, p) => n + p.keywords.length, 0))
    for (const r of active) {
      assert.equal(r.rank, FAMILY_RANK[r.family], `${r.keyword} 的 rank 必须等于家族 rank`)
    }
  })

  test('KU-5 裁决（端到端）：精确地址/路径/标识层压在数值与状态词之上', async () => {
    const { keywordPresets } = await loadPresets()
    const { activeKeywords } = await loadGroups()
    const { compileKeywords } = await loadCompile()
    const { buildScan, collectMatches } = await loadScan()
    const active = activeKeywords(keywordPresets.reduce((acc, p) => acc.concat(p.keywords.map(k => ({ ...k, source: 'preset', group: p.name }))), []))
    const patterns = compileKeywords(active)
    const scan = buildScan(patterns)
    const hitOf = (line, text) => {
      const hit = collectMatches(line, patterns, scan, 512).find(h => h.text === text)
      assert.ok(hit, `未命中 ${text}：${line}`)
      return hit
    }
    // 源文件属于路径层（20），赢过同起点的宽口径标识/数值规则
    assert.equal(hitOf('/usr/src/app/main.c:42:5: error: ...', '/usr/src/app/main.c').color, '#9CDCFE')
    // 镜像名 vs pod 名同为 30 层，但镜像名的正则更长 → 同层取更长
    assert.equal(hitOf('nginx-7d9f8c6b5-x2k4p CrashLoopBackOff', 'nginx-7d9f8c6b5-x2k4p').rank, 30)
    // unit 名（30）压过状态词（50）里的动词，两者各染各的、互不吞并
    const started = hitOf('Starting nginx.service...', 'Starting')
    const unit = hitOf('Starting nginx.service...', 'nginx.service')
    assert.equal(started.rank, 50)
    assert.equal(unit.rank, 30)
    assert.ok(started.end <= unit.start, '两个家族的命中必须互不重叠')
    // PCI 地址是精确地址层（10），不会被端口/数字层抢走
    assert.equal(hitOf('lspci 0000:3b:00.0 VGA compatible controller', '0000:3b:00.0').rank, 10)
  })
})
