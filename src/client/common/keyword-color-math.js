// 色板几何的感知距离数学（sRGB → CIELAB → ΔE）。
// 批次 F 从 keyword-family.spec.js 原样搬出：CI 闸与设置面板「色板体检」共用同一份
// 实现（SSOT），面板展示的数字与门禁判定逐字同源，不存在第二套近似实现。

// sRGB → CIELAB → ΔE(1976)。终端底色是深色，配色是否"撞车"只能靠感知距离判断，
// 肉眼在等宽字体上对色相+明度的差别远比对 RGB 差值敏感。
export const srgbToLab = (hex) => {
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

export const deltaE76 = (a, b) => Math.hypot(...srgbToLab(a).map((v, i) => v - srgbToLab(b)[i]))

// ΔE(2000)：CIEDE2000。ΔE(1976) 在蓝段把距离报大了、绿段报小了，同一把尺卡全色板
// 会让淡蓝簇白跑一趟，所以可辨性闸用 CIEDE2000 复核一遍。
export const deltaE00 = (hex1, hex2) => {
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
