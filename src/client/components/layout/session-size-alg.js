import { normalizeRatios } from './split-ratios.js'

// 与 layout-alg 共用同一份比例：格子的像素尺寸必须和 wrapStyles 的分界线
// 严丝合缝，否则终端 fit 算出来的列数会比实际可见区域差一两列。
const layoutConfigs = {
  c1: { cols: 1, rows: 1 },
  c2: { cols: 2, rows: 1 },
  c3: { cols: 3, rows: 1 },
  r2: { cols: 1, rows: 2 },
  r3: { cols: 1, rows: 3 },
  c2x2: { cols: 2, rows: 2 },
  c1r2: { cols: 2, rows: 2, special: 'right', length: 3 },
  r1c2: { cols: 2, rows: 2, special: 'bottom', length: 3 }
}

export default function calcSessionSize (layout, w, h, ratios) {
  const conf = layoutConfigs[layout] || layoutConfigs.c1
  const { cols, rows, special, length = cols * rows } = conf
  const r = normalizeRatios(layout, ratios)

  let colWidths = new Array(cols).fill(w / cols)
  let rowHeights = new Array(rows).fill(h / rows)

  if (layout === 'c2' || layout === 'c3') {
    colWidths = layout === 'c2'
      ? [w * r[0], w * (1 - r[0])]
      : [w * r[0], w * (r[1] - r[0]), w * (1 - r[1])]
  } else if (layout === 'r2' || layout === 'r3') {
    rowHeights = layout === 'r2'
      ? [h * r[0], h * (1 - r[0])]
      : [h * r[0], h * (r[1] - r[0]), h * (1 - r[1])]
  } else if (layout === 'c2x2') {
    colWidths = [w * r[0], w * (1 - r[0])]
    rowHeights = [h * r[1], h * (1 - r[1])]
  }

  const sessions = new Array(length).fill(0).map(() => ({ width: 0, height: 0 }))

  if (special === 'right') {
    // 左列整高，右列按 r[1] 再分两行
    sessions[0].width = w * r[0]
    sessions[0].height = h
    sessions[1].width = sessions[2].width = w * (1 - r[0])
    sessions[1].height = h * r[1]
    sessions[2].height = h * (1 - r[1])
  } else if (special === 'bottom') {
    // 上行整宽，下行按 r[1] 再分两列
    sessions[0].width = w
    sessions[0].height = h * r[0]
    sessions[1].height = sessions[2].height = h * (1 - r[0])
    sessions[1].width = w * r[1]
    sessions[2].width = w * (1 - r[1])
  } else {
    let i = 0
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        sessions[i].width = colWidths[col]
        sessions[i].height = rowHeights[row]
        i += 1
      }
    }
  }

  return sessions
}
