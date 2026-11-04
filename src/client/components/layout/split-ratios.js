// 分屏分隔条的比例模型（S2-4 / #4549）：布局算法、会话尺寸、拖动都在这里，
// 存的是"边界占比"而不是像素——窗口缩放、侧栏开合后比例仍然成立。
//
// 每个布局的边界含义固定（见 HANDLES）：
//   c2/c3/r2/r3  单轴多列/多行，按顺序累积分界
//   c2x2         先竖后横
//   c1r2         先左列宽、再右列内部横分
//   r1c2         先上行高、再下行内部竖分

// 一格的硬下限：拖到这个宽度就不再让，避免把手把某一格拖成 0 宽
export const MIN_PANE_PX = 80

const HANDLES = {
  c1: [],
  c2: [{ axis: 'x', index: 0 }],
  c3: [{ axis: 'x', index: 0 }, { axis: 'x', index: 1 }],
  r2: [{ axis: 'y', index: 0 }],
  r3: [{ axis: 'y', index: 0 }, { axis: 'y', index: 1 }],
  c2x2: [{ axis: 'x', index: 0 }, { axis: 'y', index: 1 }],
  c1r2: [{ axis: 'x', index: 0 }, { axis: 'y', index: 1 }],
  r1c2: [{ axis: 'y', index: 0 }, { axis: 'x', index: 1 }]
}

// 同一条轴上有两个边界的布局：第二个边界不能越过第一个
const SHARED_AXIS = { c3: true, r3: true }

export const defaultRatios = {
  c1: [],
  c2: [0.5],
  c3: [1 / 3, 2 / 3],
  r2: [0.5],
  r3: [1 / 3, 2 / 3],
  c2x2: [0.5, 0.5],
  c1r2: [0.5, 0.5],
  r1c2: [0.5, 0.5]
}

export function handleAxis (layout, index) {
  const h = HANDLES[layout] && HANDLES[layout][index]
  return h ? h.axis : null
}

// 存的可能是旧版本的畸形值（手改 localStorage、footer 改了布局枚举），
// 这里统一校验：长度对、全在 (0,1)、同轴递增，否则退回默认值。
export function normalizeRatios (layout, stored) {
  const def = defaultRatios[layout] || []
  const count = (HANDLES[layout] || []).length
  if (!Array.isArray(stored) || stored.length !== count) {
    return def.slice()
  }
  const out = []
  for (let i = 0; i < count; i++) {
    const v = Number(stored[i])
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      return def.slice()
    }
    out.push(v)
  }
  if (SHARED_AXIS[layout]) {
    for (let i = 1; i < out.length; i++) {
      if (out[i] <= out[i - 1]) {
        return def.slice()
      }
    }
  }
  return out
}

// 拖一根把手：deltaPx 是从按下开始的总位移，base 是该轴的总像素。
// 返回新的比例数组（不与入参共享），调用方负责写回 store。
export function dragRatio (layout, index, ratios, deltaPx, { width, height }) {
  const spec = HANDLES[layout] && HANDLES[layout][index]
  if (!spec) {
    return normalizeRatios(layout, ratios)
  }
  const base = spec.axis === 'x' ? width : height
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(deltaPx)) {
    return normalizeRatios(layout, ratios)
  }
  const arr = normalizeRatios(layout, ratios).slice()
  const minFrac = Math.min(MIN_PANE_PX / base, 0.5)
  let lo = minFrac
  let hi = 1 - minFrac
  if (SHARED_AXIS[layout]) {
    // 相邻边界之间也得留一格
    if (spec.index > 0) {
      lo = Math.max(lo, arr[spec.index - 1] + minFrac)
    }
    if (spec.index < arr.length - 1) {
      hi = Math.min(hi, arr[spec.index + 1] - minFrac)
    }
  }
  if (hi < lo) {
    hi = lo
  }
  const next = arr[spec.index] + deltaPx / base
  arr[spec.index] = Math.max(lo, Math.min(hi, next))
  return arr
}
