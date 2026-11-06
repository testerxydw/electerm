const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// V3 信号家族契约（doc/设计-关键字高亮色板与密度-v3-2026-11-06.md §3）的可执行化。
// 这里断言的是「结构约束」，不是某条正则的行为：家族一旦标注缺失、跨组复用、
// 一族多色、rank 漏登记，立刻在这里失败——而不是等到用户在终端里看到 IP 变粉。

const loadPresets = () => import('../../client/common/keyword-presets.js')
const loadGroups = () => import('../../client/common/keyword-groups.js')
const loadCompile = () => import('../../client/common/keyword-compile.js')
const loadScan = () => import('../../client/common/keyword-scan.js')

// ANSI 语义名 = 主题映射，专门给「错误/警告/成功/信息/调试/空值」这类跨领域语义信号
// 用（white 留给用户自定义规则）。结构档占用它们就是「一个颜色两种语义」的开始。
const ansiNames = new Set(['red', 'yellow', 'green', 'blue', 'magenta', 'cyan', 'white'])

// sRGB → CIELAB → ΔE(1976)。终端底色是深色，配色是否"撞车"只能靠感知距离判断，
// 肉眼在等宽字体上对色相+明度的差别远比对 RGB 差值敏感。
const srgbToLab = (hex) => {
  const h = hex.replace('#', '')
  const lin = ([0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255))
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  const [r, g, b] = lin
  const xyz = [
    r * 0.4124 + g * 0.3576 + b * 0.1805,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    r * 0.0193 + g * 0.1192 + b * 0.9505
  ]
  const ref = [0.95047, 1, 1.08883]
  const f = xyz.map((v, i) => {
    const t = v / ref[i]
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  })
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])]
}
const deltaE76 = (a, b) => Math.hypot(...srgbToLab(a).map((v, i) => v - srgbToLab(b)[i]))
// ΔE(2000)：CIEDE2000。ΔE(1976) 在蓝段把距离报大了、绿段报小了，同一把尺卡全色板
// 会让淡蓝簇白跑一趟，所以可辨性闸用 CIEDE2000 复核一遍。
const deltaE00 = (hex1, hex2) => {
  const [L1, a1, b1] = srgbToLab(hex1)
  const [L2, a2, b2] = srgbToLab(hex2)
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2
  const T = 1 - 0.17 * Math.cos((hbp - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hbp * Math.PI / 180) +
    0.32 * Math.cos((3 * hbp + 6) * Math.PI / 180) - 0.2 * Math.cos((4 * hbp - 63) * Math.PI / 180)
  const dTh = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2))
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTh * Math.PI / 180) * Rc
  return Math.sqrt(Math.pow((L2 - L1) / Sl, 2) + Math.pow((C2p - C1p) / Sc, 2) +
    Math.pow(dHp / Sh, 2) + Rt * ((C2p - C1p) / Sc) * (dHp / Sh))
}

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

// ---- KU-4 一词一族 · 整词探测 ----
// 「一个关键字只能存在于一个配置里」的可执行化：先取出一条 signal 规则真正能
// 整词命中的字面词（用规则自身校验——括号拆出来的碎片命中不了就不算词，
// 所以 "reverse mapping checking" 这类需要上下文才成立的形状不会混进来），
// 再看同一个字面词被几条规则命中。跨组复制词表、或一个词两种颜色，在这里失败。
const signalRules = async () => {
  const { rules } = await familyIndex()
  return rules.filter(r => r.tier === 'signal')
    .map(r => ({ ...r, re: new RegExp(r.keyword, 'gi') }))
}
const literalCandidates = (src) => {
  const stripped = src
    .replace(/\(\?[=!<][^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ') // 环视：不参与命中文本
    .replace(/\(\?[a-z-]+/g, '(')
    .replace(/\\[bBdDwWsSnNpPvV]/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
  const out = new Set()
  for (const frag of stripped.split(/[|()]/)) {
    for (const m of frag.matchAll(/[A-Za-z][A-Za-z0-9_.+-]*(?:[ ][A-Za-z][A-Za-z0-9_.+-]*){0,3}/g)) {
      const tok = m[0].replace(/[-?+*]+$/, '')
      if (tok.length > 1) out.add(tok)
    }
  }
  return [...out]
}
// 规则命中候选串时，匹配文本必须就是这个候选本身（整词）
const matchesWholeWord = (re, tok) => {
  re.lastIndex = 0
  let m
  while ((m = re.exec(` ${tok} `))) {
    if (m[0].toLowerCase() === tok.toLowerCase()) return true
    re.lastIndex = m.index + 1
  }
  return false
}
// 词表：{ 词 -> 命中它的规则 }。候选来自所有规则的字面片段（宁滥勿缺），
// 每个候选再拿全部规则探测一遍——只有整词命中的才算这个词的归属，
// 所以「需要上下文才成立的形状」（如 [DROP]、Accepted password）不会被当成裸词。
const wordTable = async () => {
  const rs = await signalRules()
  const candidates = new Set()
  for (const r of rs) for (const tok of literalCandidates(r.keyword)) candidates.add(tok)
  const table = new Map()
  for (const tok of candidates) {
    const hits = rs.filter(r => matchesWholeWord(r.re, tok))
    if (hits.length) table.set(tok.toLowerCase(), { tok, hits })
  }
  return table
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
  // 多个配置里」的残留。批次 B（词表去重）已把 word-error / word-ok / word-warn
  // 三条收口（业务组的词表要么并进通用五档、要么挂上新的领域家族 id）；
  // 剩下 duration / host-port 是形状复用，归批次 C（形状边界）收。
  const CROSS_GROUP_FAMILIES = [
    'duration',
    'host-port'
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

  test('KU-4 一词一族 整词探测：同词多配置 = 0、同词异色 = 0', async () => {
    const table = await wordTable()
    // 探测本身不能是空跑：词表规模掉了就说明候选抽取或整词校验坏了
    assert.ok(table.size > 250, `整词探测只认出 ${table.size} 个词，候选抽取大概坏了`)
    const dup = [...table.values()].filter(v => v.hits.length > 1)
    const crossGroup = dup.filter(v => new Set(v.hits.map(h => h.group)).size > 1)
    const crossColor = dup.filter(v => new Set(v.hits.map(h => h.color)).size > 1)
    const show = (v) => `  "${v.tok}" -> ${v.hits.map(h => `${h.group} / ${h.family}(${h.color})`).join(' , ')}`
    assert.deepEqual(dup, [],
      `同词多规则 ${dup.length}（其中跨配置组 ${crossGroup.length}、同词异色 ${crossColor.length}）：\n` +
      `${dup.map(show).join('\n')}\n` +
      '判据：泛用状态词并进通用五档，领域独有词挂新的领域家族 id（不得复用 word-*）；' +
      '需要上下文才成立的形状（如 nft verdict）要加语境锚，不要和裸词抢同一个词。')
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

  test('KU-6 一色一语义：signal 档家族只用 ANSI 语义名（颜色即语义，跨主题稳定）', async () => {
    const { byFamily } = await familyIndex()
    for (const [family, list] of byFamily) {
      if (list[0].tier !== 'signal') continue
      assert.ok(ansiNames.has(list[0].color),
        `signal 家族 ${family} 用了真彩色 ${list[0].color}，语义色表被绕过`)
    }
  })

  // 批次 E·B-1 之后这条从棘轮变成硬约束：结构档一律真彩色，
  // 不再有任何结构家族住在 blue / magenta / cyan 上（原来 35 个）。
  test('KU-6 一色一语义：结构档家族不得占用 ANSI 语义名', async () => {
    const { byFamily } = await familyIndex()
    const offenders = []
    for (const [family, list] of byFamily) {
      if (list[0].tier === 'structure' && ansiNames.has(list[0].color)) offenders.push(family)
    }
    assert.deepEqual(offenders, [],
      `结构档仍在占用语义名：${offenders.join(' ')}。结构家族必须用 COLOR_GROUPS 里的真彩色。`)
  })

  test('KU-6 色板构造：规则的 color 只能由 FAMILY_COLOR 派生，且一色一色组', async () => {
    const { COLOR_GROUPS, FAMILY_GROUP, FAMILY_COLOR, FAMILY_RANK, keywordPresets } = await loadPresets()
    // 一色一色组：同一个颜色值不得出现在两个色组上
    const seen = new Map()
    for (const [group, def] of Object.entries(COLOR_GROUPS)) {
      assert.ok(def.label, `色组 ${group} 缺少说明`)
      const prev = seen.get(def.color)
      assert.equal(prev, undefined, `颜色 ${def.color} 同时属于色组 ${prev} 和 ${group}`)
      seen.set(def.color, group)
    }
    // 家族必须登记色组，且派生色就是色组色
    for (const family of Object.keys(FAMILY_GROUP)) {
      assert.equal(FAMILY_COLOR[family], COLOR_GROUPS[FAMILY_GROUP[family]].color)
      assert.ok(FAMILY_RANK[family] !== undefined, `家族 ${family} 未登记 FAMILY_RANK`)
    }
    // 预设规则的颜色一处不差（写死的手填色已经无法通过这里）
    for (const p of keywordPresets) {
      for (const k of p.keywords) {
        assert.equal(k.color, FAMILY_COLOR[k.family],
          `${p.name} 的规则颜色不是家族派生值：${k.color}`)
      }
    }
  })

  test('KU-6 取色器同步：色板里的每个色组颜色都必须在设置面板可选手色里', async () => {
    const { COLOR_GROUPS } = await loadPresets()
    const { keywordPalette } = await loadCompile()
    const values = new Set(keywordPalette.map(p => p.value))
    for (const [group, def] of Object.entries(COLOR_GROUPS)) {
      assert.ok(values.has(def.color), `色组 ${group} 的 ${def.color} 没有出现在 keywordPalette 里`)
    }
  })

  test('KU-6 色板无死色：每个色组至少被一个在用家族占用', async () => {
    const { COLOR_GROUPS, FAMILY_GROUP } = await loadPresets()
    const { byFamily } = await familyIndex()
    const usedGroups = new Set()
    for (const [family] of byFamily) usedGroups.add(FAMILY_GROUP[family])
    const dead = Object.keys(COLOR_GROUPS).filter(g => !usedGroups.has(g))
    assert.deepEqual(dead, [], `色组无人使用（死色，色板膨胀的来源）：${dead.join(' ')}`)
  })

  // 色板换了颜色，配置里存的那份是老色板的快照。预设行在面板里只读，所以读时按
  // 家族重新派生颜色就是无损升级；用户自定义规则的自选色必须原样保留。
  test('KU-6 零迁移：预设规则的旧色在读时被家族色覆盖，用户规则自选色不动', async () => {
    const { keywordPresets, FAMILY_COLOR } = await loadPresets()
    const { activeKeywords, ruleColorOf } = await loadGroups()
    const interfaceRule = keywordPresets
      .flatMap(p => p.keywords)
      .find(k => k.family === 'interface-name')
    const legacy = [
      // 老配置：同一条预设正则，颜色还是色板收紧前的 ANSI blue
      { keyword: interfaceRule.keyword, color: 'blue', source: 'preset', group: 'Networking' },
      // 用户手动写的同一条正则，自选红色 —— 合法诉求，不能被派生覆盖
      { keyword: interfaceRule.keyword, color: 'red', source: 'user' }
    ]
    assert.equal(ruleColorOf(legacy[0]), FAMILY_COLOR['interface-name'])
    assert.equal(ruleColorOf(legacy[1]), 'red')
    const active = activeKeywords(legacy)
    assert.deepEqual(active.map(r => r.color), [FAMILY_COLOR['interface-name'], 'red'],
      '预设条拿家族色、用户条拿自选色，两条都保留（这正是"同正则不同色"的合法场景）')
  })

  // ---- KU-6 色板几何闸（批次 E·B-2 定稿）----
  // 三条闸各自管一件事：色板内部不撞、色板内部一眼可辨、结构色长得不像信号词。
  // 数值口径见 keyword-presets.js 的 KU-6 注释块；求解脚本是一次性的，
  // 复算命令：node /tmp 无关，改色板后跑本文件即可（下面两条把违规对直接打出来）。
  // ΔE76 在蓝段把距离报大了、绿段报小了，所以两把尺一起用：只卡 ΔE76 会逼淡蓝簇
  // 无谓地跑远，只卡 ΔE00 又会放过绿段。
  const GATES = {
    // 实测 16.0（size↔path，B-2 前是 6.2）
    pairDeltaE76: 16,
    // 实测 8.5（time↔path，B-2 前是 4.5，同一对）
    pairDeltaE00: 8,
    // 实测 11.6（number↔主题 blue，B-2 前最低是 mac↔主题 magenta 7.4）
    themeDeltaE76: 11
  }
  const structureHexes = async () => {
    const { COLOR_GROUPS } = await loadPresets()
    return Object.entries(COLOR_GROUPS).filter(([, d]) => /^#/.test(d.color))
  }
  // 内置终端主题里 signal 档会真正发出的那批颜色（theme-defaults.js，不抄第二份表）。
  // 只取 normal 变体：colorToCode 发的是 SGR 31–37，bright* 需要加粗，高亮从不加粗。
  // ANSI 由主题控制，用户换主题就是换一组锚点，所以这条是"别把结构色配成我们自带主题的
  // 信号色"的参照闸，不是跨主题承诺。已知越界且不拦：number 与深色主题 brightBlue 只差 2.4
  // ——那是别的程序加粗的颜色，不在关键字高亮的语义空间里（详见 keyword-presets.js KU-6 注释）。
  const SIGNAL_ANSI_NAMES = ['red', 'yellow', 'green', 'blue', 'magenta', 'cyan']
  const themeSignalColors = async () => {
    const mod = await import('../../client/common/theme-defaults.js')
    return [mod.defaultTheme(), mod.defaultThemeLight()]
      .flatMap(t => SIGNAL_ANSI_NAMES.map(n => t.themeConfig[n]))
  }
  const nearestTheme = async (hex) => {
    const anchors = await themeSignalColors()
    return anchors
      .map(t => [deltaE76(hex, t), t])
      .sort((a, b) => a[0] - b[0])[0]
  }

  test('KU-6 色板几何：结构色两两 ΔE(1976) 不得低于闸', async () => {
    const hexes = await structureHexes()
    const offenders = []
    let min = Infinity
    for (let i = 0; i < hexes.length; i++) {
      for (let j = i + 1; j < hexes.length; j++) {
        const d = deltaE76(hexes[i][1].color, hexes[j][1].color)
        min = Math.min(min, d)
        if (d < GATES.pairDeltaE76) offenders.push(`${hexes[i][0]} ↔ ${hexes[j][0]} = ${d.toFixed(1)}`)
      }
    }
    assert.deepEqual(offenders, [],
      `结构色最小 ΔE(1976) ${min.toFixed(1)}，低于闸 ${GATES.pairDeltaE76}：${offenders.join('；')}。` +
      '新加/改色的结构家族和已有色撞车了——要么拉开，要么并组（一色一语义）。')
  })

  test('KU-6 色板几何：结构色两两 ΔE(2000) 不得低于闸（观感口径）', async () => {
    const hexes = await structureHexes()
    const offenders = []
    let min = Infinity
    for (let i = 0; i < hexes.length; i++) {
      for (let j = i + 1; j < hexes.length; j++) {
        const d = deltaE00(hexes[i][1].color, hexes[j][1].color)
        min = Math.min(min, d)
        if (d < GATES.pairDeltaE00) offenders.push(`${hexes[i][0]} ↔ ${hexes[j][0]} = ${d.toFixed(1)}`)
      }
    }
    assert.deepEqual(offenders, [],
      `结构色最小 ΔE(2000) ${min.toFixed(1)}，低于闸 ${GATES.pairDeltaE00}：${offenders.join('；')}。` +
      'ΔE(2000) 是"一眼看得出是两个颜色"的感知口径，比 ΔE(1976) 更贴近终端上的实际观感。')
  })

  test('KU-6 色板几何：结构色不得贴近内置主题的 signal ANSI 色', async () => {
    const hexes = await structureHexes()
    // 锚点为空时这条闸会静默通过，先把锚点本身锁住
    const anchors = await themeSignalColors()
    assert.equal(anchors.length, SIGNAL_ANSI_NAMES.length * 2, '主题 signal 锚点数量不对')
    assert.deepEqual(anchors.filter(a => !/^#[0-9a-fA-F]{6}$/.test(a)), [], '主题 signal 锚点不是 #rrggbb')
    const offenders = []
    for (const [group, def] of hexes) {
      const [d, theme] = await nearestTheme(def.color)
      if (d < GATES.themeDeltaE76) offenders.push(`${group}(${def.color}) ↔ 主题色 ${theme} = ${d.toFixed(1)}`)
    }
    assert.deepEqual(offenders, [],
      `结构色与主题的 signal 色太近（闸 ${GATES.themeDeltaE76}）：${offenders.join('；')}。` +
      '用户在屏幕上看到的就是"一个数值和一个信号词同色"，KU-6 一色一语义在观感上失效。')
  })

  // 色的语义身份 = 色相。重排色板只能在色相带内调整明度/彩度，不能把 ident 从绿相
  // 推成芥末金——那等于换了语义。这张表就是每个结构色组允许住着的色相弧。
  const HUE_BANDS = {
    time: [215, 250],
    duration: [165, 200],
    size: [245, 280],
    number: [250, 285],
    hexnum: [295, 330],
    flag: [75, 100],
    ip: [335, 360],
    mac: [0, 25],
    url: [30, 60],
    port: [140, 170],
    ident: [110, 140],
    artifact: [60, 85],
    diffmark: [100, 130],
    action: [150, 175],
    path: [215, 245],
    loc: [130, 160]
  }
  test('KU-6 色相带：每个结构色组必须留在自己的色相弧内（并组前不许换色族）', async () => {
    const hexes = await structureHexes()
    const drift = []
    for (const [group, def] of hexes) {
      const band = HUE_BANDS[group]
      assert.ok(band, `结构色组 ${group} 未登记 HUE_BANDS`)
      const [, a, b] = srgbToLab(def.color)
      const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
      if (hue < band[0] || hue > band[1]) drift.push(`${group} 色相 ${hue.toFixed(0)}° 越出 ${band[0]}–${band[1]}°`)
    }
    assert.deepEqual(drift, [], `色相带违规：${drift.join('；')}`)
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
    const { keywordPresets, COLOR_GROUPS } = await loadPresets()
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
    // 源文件属于路径层（20），赢过同起点的宽口径标识/数值规则。颜色跟色板走，
    // 所以断言取派生值，避免每次重排色板都要回来改这里。
    assert.equal(hitOf('/usr/src/app/main.c:42:5: error: ...', '/usr/src/app/main.c').color, COLOR_GROUPS.path.color)
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
