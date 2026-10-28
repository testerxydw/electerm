// H1a-1/H1a-2：5 处网格共用的单元格展示层 + 列宽决策纯函数
// （SQL 结果 / 数据页 / 表结构页 / Redis 键列表 / Redis 详情）
//
// 为什么不 import value-renderers 的 isBinEnvelope：那个模块属于组件层（带呈现器
// 注册表与 JSX 依赖），这里是可单测的 common 纯模块，只做形状判断即可。
export const COL_W_MIN = 90
export const COL_W_MAX = 360
export const COL_W_FALLBACK = 90
// H1a-2 列宽可控：
// - COL_W_WIDE：列头菜单"加宽到 720"的上限。自适应默认 360 封顶是给"很多列一屏看"
//   留的；用户明确点"加宽"就是要给单列更多空间，720 约为两列自适应的宽度，
//   再宽就要靠拖拽了（拖拽上限 1200，见下）。
// - 拖拽区间比自适应宽：拖是用户手工决定的，60 让他能收到一列只放数字，
//   1200 让他能把长 JSON 拉到小半屏；这两个边界与"量宽"无关，所以不复用 90/360。
export const COL_W_WIDE = 720
export const COL_W_DRAG_MIN = 60
export const COL_W_DRAG_MAX = 1200
const CHAR_W = 12
const PAD = 32
const SAMPLE_ROWS = 100
const NULL_TEXT_LEN = 4

// 宽度只认正数：0 / NaN / 负数 / 数字字符串都当"没有这一源"，脏值可能来自用户
// 配置文件（视角里的 columnWidths）也可能来自后端，照写进 style 会把布局算崩
const positive = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

export function isBinEnvelope (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('__bin' in v)) {
    return false
  }
  const b = v.__bin
  return !!b && typeof b === 'object' &&
    typeof b.size === 'number' && typeof b.b64 === 'string' &&
    typeof b.truncated === 'boolean'
}

// 单元格文本（悬停预览 / 原生 title 的唯一来源）：与网格里"看到的"一致，
// 但对象不再截 200 字符 —— 预览存在的意义就是看全，截断由展示层决定
export function cellText (v) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    return '<binary ' + v.__bin.size + ' bytes>'
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch (e) {
      // 循环引用等序列化失败：回落 String，绝不抛（title 不该让表格崩）
      return String(v)
    }
  }
  return String(v)
}

// 采样量长度 → 像素宽：沿用数据页既有公式（90~360），只是抽成共用函数，
// 保证抽函数前后数据页列宽逐列一致
export function fitColumnWidths (rows, keys, opts = {}) {
  const {
    sample = SAMPLE_ROWS,
    min = COL_W_MIN,
    max = COL_W_MAX
  } = opts
  const list = rows || []
  const names = keys && keys.length
    ? keys
    : (list.length ? Object.keys(list[0]) : [])
  if (!list.length || !names.length) {
    return {}
  }
  const head = list.slice(0, sample)
  const widths = {}
  for (const k of names) {
    let maxLen = String(k).length
    for (const r of head) {
      const v = r ? r[k] : null
      const len = v === null || v === undefined ? NULL_TEXT_LEN : cellText(v).length
      if (len > maxLen) {
        maxLen = len
      }
    }
    widths[k] = Math.min(max, Math.max(min, maxLen * CHAR_W + PAD))
  }
  return widths
}

// "加宽到 720"与"自适应全部列"用的宽版量宽：同一条公式，只换上限。
// 换上限而不是加新公式，是为了让"自适应"和"加宽"这两档对同一列的结果可比
// （加宽一定 ≥ 自适应），不会出现点一下反而变窄的怪事
export function wideFitColumnWidths (rows, keys, opts = {}) {
  return fitColumnWidths(rows, keys, { max: COL_W_WIDE, ...opts })
}

// 单列"加宽到 720"的目标宽：只量这一列（菜单里显示的数字就是点下去的宽度）。
// 量不到（空行集 / 行里没有这一列）才给整 720 —— 这时候用户要的本来就是"给空间"
export function wideColumnWidth (rows, key) {
  return wideFitColumnWidths(rows, [key])[key] || COL_W_WIDE
}

// 拖拽：起点宽 + 水平位移 → 夹进 [60, 1200] 取整。
// 位移而不是绝对坐标：手柄贴 th 右边沿，从表格中部起拖也会按增量走，
// 不会出现"一按下就跳到指针位置"的抖动感
export function clampDragWidth (startWidth, dx) {
  const base = positive(startWidth) || COL_W_FALLBACK
  const d = Number(dx)
  const delta = Number.isFinite(d) ? d : 0
  return Math.max(COL_W_DRAG_MIN, Math.min(COL_W_DRAG_MAX, Math.round(base + delta)))
}

// 宽度四源优先级：拖拽中 > 手动（拖过 / 加宽过） > 自适应 > 兜底。
// 兜底也走 positive：调用方传 0/脏值时仍落到 COL_W_FALLBACK，不会给出 0 宽列
export function pickColumnWidth (src) {
  const s = src || {}
  return positive(s.live) || positive(s.manual) || positive(s.fitted) ||
    positive(s.fallback) || COL_W_FALLBACK
}

// 手动宽增删（返回新 map，不改入参 —— commit 出去的对象的宿主可能是持久化视角）
export function withManualWidth (map, key, width) {
  const w = positive(width)
  if (!w) {
    return withoutManualWidth(map, key)
  }
  return { ...(map || {}), [key]: w }
}

export function withoutManualWidth (map, key) {
  const next = { ...(map || {}) }
  delete next[key]
  return next
}
