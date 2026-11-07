// 色板体检（批次 F，V7 §6 第 3 条）：KU-6 四条几何闸的实测值，纯展示、不参与裁决。
// 闸值 / 色相带 / 主题锚点在这里是唯一真源：CI（keyword-family.spec.js）与设置面板
// 都从本模块取数，改色板后两边看到的数字与判定逐字一致。
import { COLOR_GROUPS } from './keyword-presets.js'
import { defaultTheme, defaultThemeLight } from './theme-defaults.js'
import { srgbToLab, deltaE76, deltaE00 } from './keyword-color-math.js'

// 三条距离闸（批次 E·B-2 定稿，数值口径见 keyword-presets.js 的 KU-6 注释块）：
// ΔE76 在蓝段把距离报大了、绿段报小了，所以两把尺一起用——只卡 ΔE76 会逼淡蓝簇
// 无谓地跑远，只卡 ΔE00 又会放过绿段。
export const PALETTE_GATES = {
  // 实测 16.0（size↔path，B-2 前是 6.2）
  pairDeltaE76: 16,
  // 实测 8.5（time↔path，B-2 前是 4.5，同一对）
  pairDeltaE00: 8,
  // 实测 11.6（number↔主题 blue，B-2 前最低是 mac↔主题 magenta 7.4）
  themeDeltaE76: 11
}

// 色的语义身份 = 色相。重排色板只能在色相带内调整明度/彩度，不能把 ident 从绿相
// 推成芥末金——那等于换了语义。这张表就是每个结构色组允许住着的色相弧。
// 批次 D 删组后 diffmark/action 两条登记随之撤销（色组已不存在）。
export const HUE_BANDS = {
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
  path: [215, 245],
  loc: [130, 160]
}

// 内置终端主题里 signal 档会真正发出的那批颜色（theme-defaults.js，不抄第二份表）。
// 只取 normal 变体：colorToCode 发的是 SGR 31–37，bright* 需要加粗，高亮从不加粗。
// ANSI 由主题控制，用户换主题就是换一组锚点，所以这条是"别把结构色配成我们自带主题的
// 信号色"的参照闸，不是跨主题承诺。已知越界且不拦：number 与深色主题 brightBlue 只差 2.4
// ——那是别的程序加粗的颜色，不在关键字高亮的语义空间里（详见 keyword-presets.js KU-6 注释）。
export const SIGNAL_ANSI_NAMES = ['red', 'yellow', 'green', 'blue', 'magenta', 'cyan']

export const themeSignalColors = () => [defaultTheme(), defaultThemeLight()]
  .flatMap(t => SIGNAL_ANSI_NAMES.map(n => t.themeConfig[n]))

export const structureColorGroups = () => Object.entries(COLOR_GROUPS)
  .filter(([, d]) => /^#/.test(d.color))

export const hueOf = (hex) => {
  const [, a, b] = srgbToLab(hex)
  return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
}

// 四条闸的实测值 + 最近对/最近锚点，供面板「色板体检」展示；CI 闸用同一批常量判定。
export const paletteHealth = () => {
  const hexes = structureColorGroups()
  const anchors = themeSignalColors()
  const g1 = { min: Infinity, pair: [] }
  const g2 = { min: Infinity, pair: [] }
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const [na, da] = hexes[i]
      const [nb, db] = hexes[j]
      const d76 = deltaE76(da.color, db.color)
      if (d76 < g1.min) {
        g1.min = d76
        g1.pair = [na, nb]
      }
      const d00 = deltaE00(da.color, db.color)
      if (d00 < g2.min) {
        g2.min = d00
        g2.pair = [na, nb]
      }
    }
  }
  const g3 = { min: Infinity, group: '', theme: '' }
  for (const [name, def] of hexes) {
    for (const t of anchors) {
      const d = deltaE76(def.color, t)
      if (d < g3.min) {
        g3.min = d
        g3.group = name
        g3.theme = t
      }
    }
  }
  const g4 = { violations: [] }
  for (const [name, def] of hexes) {
    const band = HUE_BANDS[name]
    const hue = hueOf(def.color)
    if (!band || hue < band[0] || hue > band[1]) {
      g4.violations.push({ group: name, hue, band: band || null })
    }
  }
  return {
    groupCount: Object.keys(COLOR_GROUPS).length,
    structureCount: hexes.length,
    anchorCount: anchors.length,
    gates: PALETTE_GATES,
    g1,
    g2,
    g3,
    g4
  }
}
