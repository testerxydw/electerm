/**
 * U2 文字对比度判据的**共用探针**（桩库 demo 与真库 realdb 共用一份）。
 *
 * 为什么单独成文件：这套 WCAG 相对亮度 + 多层半透明合成的算法如果抄两份，
 * 真库那份就会在桩库那份修过之后悄悄退化 —— 于是"真库也量过"变成假话。
 * 判据脚本换数据源可以，换算法不行。
 *
 * PROBE 是一段在渲染进程里跑的表达式：
 *   · 合成矩阵：角色（真实 class）× 底色，读 getComputedStyle，不写死色值
 *     —— 会随行走的格内角色量三档底（卡片/悬停/选中），只会待在卡片底的角色（详情 NULL、
 *     状态行、计数、字段名、执行计划类型）只量一档。给"盖不到"的组合打分是自造假案：
 *     真库那轮就在 悬停底/选中底 上报出 4.46/4.23 的"详情 NULL 不达标"，而那个面板自带
 *     background:var(--hover-bg)、且在表格里不随行变色，用户从来不会看到那一层。
 *   · 实机对照：网格里真实存在的 NULL 格 / 空串格 / 选中行正文，底色应与合成出来的那层一致
 * 依赖 window.__vis / window.__one（self-test/db-ui-helpers.js 的 buildHelpers 注入）。
 */

// 'rgb(r, g, b)' 逐通道比较（合成路径不同会有一两度舍入差），容 ±4
const rgbClose = (a, b) => {
  const pa = /(\d+),\s*(\d+),\s*(\d+)/.exec(String(a))
  const pb = /(\d+),\s*(\d+),\s*(\d+)/.exec(String(b))
  if (!pa || !pb) return false
  return [1, 2, 3].every(i => Math.abs(Number(pa[i]) - Number(pb[i])) <= 4)
}

// 正文（<18px 常规字重）的 WCAG 门槛
const AA = 4.5

const PROBE = `(() => {
  const parse = s => {
    s = String(s).trim()
    let m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*(?:\\/\\s*([\\d.]+))?\\s*\\)$/.exec(s)
    if (m) return [Math.round(m[1] * 255), Math.round(m[2] * 255), Math.round(m[3] * 255), m[4] === undefined ? 1 : Number(m[4])]
    m = /^rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)\\s*(?:[,/]\\s*([\\d.]+))?\\s*\\)$/.exec(s)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1]
    return null
  }
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1]
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const rgbStr = c => 'rgb(' + c.slice(0, 3).map(Math.round).join(', ') + ')'
  const resolve = expr => {
    const d = document.createElement('div')
    d.style.background = expr
    document.body.appendChild(d)
    const c = parse(getComputedStyle(d).backgroundColor)
    d.remove()
    return c
  }
  // 元素（含祖先）的 opacity 会整体压低文字，要乘进前景 alpha
  const alphaOf = el => {
    let a = 1
    let n = el
    while (n && a > 0) { a *= Number(getComputedStyle(n).opacity); n = n.parentElement }
    return a
  }
  const measure = (el, bg) => {
    const cs = getComputedStyle(el)
    const fg = parse(cs.color)
    if (!fg) return null
    let acc = bg
    const own = parse(cs.backgroundColor)
    if (own && own[3] > 0) acc = over(own, acc)
    const alpha = fg[3] * alphaOf(el)
    const solid = over([fg[0], fg[1], fg[2], alpha], acc)
    return {
      ratio: Number(ratio(solid, acc).toFixed(2)),
      font: cs.fontSize + '/' + cs.fontWeight + (alphaOf(el) < 1 ? ' op' + alphaOf(el).toFixed(2) : ''),
      color: cs.color,
      bgSolid: rgbStr(acc)
    }
  }
  const BG = [
    ['卡片底', ['var(--main)']],
    ['悬停底', ['var(--main)', 'var(--hover-bg)']],
    ['选中底', ['var(--main)', 'var(--active-bg)']]
  ]
  // 格内角色：三种底色都会遇到
  const GRID = [
    ['格内正文', ''],
    ['数值列', 'db-cell-num'],
    ['NULL 占位', 'db-cell-null'],
    ['空串占位', 'db-cell-empty']
  ]
  // 单底角色：只可能落在卡片底上，量三种底是自找假案
  //   · 详情 NULL：.db-row-detail-value 自带 background:var(--hover-bg)（db-session.styl:3425），
  //     且它在 db-row-detail.jsx:45 的面板/弹窗里，不在表格行内 —— 行悬停/选中底永远盖不到它。
  //     measure() 会把它自己的 hover-bg 叠在卡片底上，所以这一条量的就是用户真看到的那层
  //   · 壳层角色（状态行、计数、字段名、执行计划类型）同理
  const SINGLE = [
    ['详情 NULL', 'db-row-detail-value is-null'],
    ['状态行次级', 'db-grid-total'],
    ['已选计数', 'db-grid-selected'],
    ['详情字段名', 'db-row-detail-type'],
    ['执行计划类型', 'db-explain-type']
  ]
  const host = document.createElement('div')
  host.setAttribute('style', 'position:fixed;left:-9999px;top:0')
  document.body.appendChild(host)
  const matrix = []
  const run = (roles, bgs) => {
    for (const [roleName, cls] of roles) {
      for (const [bgName, layers] of bgs) {
        const el = document.createElement('span')
        if (cls) el.className = cls
        el.textContent = 'Aa 1234567890'
        host.appendChild(el)
        let acc = [0, 0, 0, 1]
        for (const l of layers) acc = over(resolve(l), acc)
        const m = measure(el, acc)
        if (m) matrix.push({ role: roleName, cls, bg: bgName, ...m })
        el.remove()
      }
    }
  }
  run(GRID, BG)
  run(SINGLE, BG.slice(0, 1))
  host.remove()

  // 实机对照：网格里真实的 NULL / 空串格与真实选中行，底色应与合成的卡片底/选中底一致
  const real = []
  const area = [...document.querySelectorAll('.db-grid-area')].filter(window.__vis)[0]
  const cardBg = resolve('var(--main)')
  const selBg = over(resolve('var(--active-bg)'), cardBg)
  // 从元素往上收集半透明层，遇到不透明层收尾，再从最底层往上叠
  const stackOf = el => {
    const layers = []
    let n = el
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0) {
        layers.push(c)
        if (c[3] >= 1) break
      }
      n = n.parentElement
    }
    let acc = layers[layers.length - 1]
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  for (const [label, sel, want] of [
    ['NULL 格', '.db-cell-null', cardBg],
    ['空串格', '.db-cell-empty', cardBg]
  ]) {
    const el = area && [...area.querySelectorAll(sel)].filter(window.__vis)[0]
    if (!el) { real.push({ label, miss: true }); continue }
    // 从父级开始叠：measure() 会把元素自己的 background 再叠一层
    const m = measure(el, stackOf(el.parentElement))
    real.push({ label, want: rgbStr(want), ...m })
  }
  const selRow = area && [...area.querySelectorAll('.ant-table-row.ant-table-row-selected')].filter(window.__vis)[0]
  if (selRow) {
    const cell = selRow.querySelector('.ant-table-cell')
    const m = measure(cell, stackOf(cell.parentElement))
    real.push({ label: '选中行正文', want: rgbStr(selBg), ...m })
  } else {
    real.push({ label: '选中行正文', miss: true })
  }
  return JSON.stringify({ matrix, real })
})()`

module.exports = { PROBE, rgbClose, AA }
