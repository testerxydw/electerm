/**
 * 远程会话（RDP / VNC / SPICE）窗口自适应与画质的决策纯函数。
 *
 * 这些判断原来散在组件里，只能靠真机看效果；抽出来后可被 unit-ci 直接覆盖
 * （照 session-end.js / db-column-width.js 的既有范式）。
 *
 * 资源口径（详见 doc/分析-RDP-VNC窗口自适应与资源开销-2026-10-30.md §3.2）：
 * RDP 位图面积 ∝ 宽 × 高，1920x1080 的单帧缓冲约为 1024x768 的 2.6 倍，
 * 2560x1440 已是 4.7 倍，所以"跟随窗口"必须有上限，超出部分交给 CSS 缩放。
 */
export const MIN_DESKTOP = { width: 800, height: 600 }
export const MAX_DESKTOP = { width: 1920, height: 1080 }
// 用户在下拉里显式选中的尺寸不受 MAX_DESKTOP 约束（那是他的明确选择），
// 只挡到 8K 这个荒谬值上限，避免把脏数据喂给 wasm
export const MAX_MANUAL_DESKTOP = { width: 7680, height: 4320 }
// 首帧量不到视口时的占位尺寸（连接期真机协商前不会长时间停留在这里）
export const FALLBACK_DESKTOP = { width: 1024, height: 768 }
// 视口变化合并窗口：拖窗 / 侧栏动画期间每帧都会回调，只认停止后的那一次
export const RESIZE_MERGE_MS = 200
// 小于这个像素差的抖动不触发重排（滚动条、DPR 取整、1px 布局误差）
export const VIEWPORT_EPSILON = 2

/**
 * 宽高都是有限正数才算"数值尺寸"。
 * resolutions.js 里 res-auto 的宽高是字符串 'auto'，历史 localStorage 可能存到它，
 * 直接喂给 wasm 的 DesktopSize 就是类型污染 —— 这里负责把它挡掉。
 */
export const isNumericSize = (size) => {
  if (!size) {
    return false
  }
  const { width, height } = size
  return Number.isFinite(Number(width)) &&
    Number.isFinite(Number(height)) &&
    Number(width) > 0 &&
    Number(height) > 0
}

/**
 * 内置分辨率项里是否"跟随窗口"（res-auto 或任何形式的非数值宽高）
 */
export const isAutoRes = (res) => !!res && !isNumericSize(res)

/**
 * 把尺寸夹到 [min, max] 区间，并取整（wasm 只接受整数宽高）
 */
export const clampDesktopSize = (size, min = MIN_DESKTOP, max = MAX_DESKTOP) => {
  const width = Math.round(Math.min(Math.max(Number(size.width), min.width), max.width))
  const height = Math.round(Math.min(Math.max(Number(size.height), min.height), max.height))
  return { width, height }
}

/**
 * 手选尺寸：只保底不封顶（到 8K），因为"用户点了 3840x2160"不该被我们改成 1920x1080
 */
export const clampManualSize = (size) => clampDesktopSize(size, MIN_DESKTOP, MAX_MANUAL_DESKTOP)

/**
 * 首连位图尺寸：
 * 1. manual —— 用户在分辨率下拉里显式选过数值尺寸，尊重它（仅保底）；
 * 2. measured —— SessionShell 实测视口（跟随窗口，这就是"无需手动调整"的落点）；
 * 3. fallback —— 量不到时的占位。
 * source 一并返回，便于单测断言与界面提示。
 */
export const resolveInitialSize = ({
  measured,
  manual,
  fallback = FALLBACK_DESKTOP,
  min = MIN_DESKTOP,
  max = MAX_DESKTOP
} = {}) => {
  if (isNumericSize(manual)) {
    return { ...clampManualSize(manual), source: 'manual' }
  }
  if (isNumericSize(measured)) {
    return { ...clampDesktopSize(measured, min, max), source: 'viewport' }
  }
  return { ...clampDesktopSize(fallback, min, max), source: 'fallback' }
}

/**
 * 缩放（fit）开关的取值优先级：
 *   本机记忆（localStorage，按 host）> 书签字段（可同步/可进 profile）> 默认开。
 * localOverride 为 null/undefined 表示"本机从没设过"，这时才轮到书签字段。
 * 书签字段缺失（旧书签）也归为开 —— 与 vnc/spice 的书签默认值一致。
 */
export const resolveScaleViewport = (localOverride, tabValue) => (
  localOverride === null || localOverride === undefined
    ? tabValue !== false
    : !!localOverride
)

/**
 * VNC 画质档位（写进 noVNC 的 qualityLevel / compressionLevel 伪编码）。
 *
 * 两个轴的语义：Q 越高越清晰、数据量越大；C 越高越省带宽、越耗 CPU。
 * 数值与命名见 doc/草图-VNC顶栏画质设置-2026-11-05.html §三，balanced 特意等于
 * 书签默认（fix-bookmark-default.js），这样"打开顶栏什么都不点"行为零变化。
 * 常量单点：界面、单测、实机脚本都从这里取，不再各写一份 0-9。
 */
export const QUALITY_CUSTOM = 'custom'
export const QUALITY_LEVEL_MIN = 0
export const QUALITY_LEVEL_MAX = 9
export const QUALITY_PRESETS = [
  { key: 'smooth', qualityLevel: 2, compressionLevel: 6, labelKey: 'vncQualitySmooth' },
  { key: 'balanced', qualityLevel: 3, compressionLevel: 1, labelKey: 'vncQualityBalanced' },
  { key: 'sharp', qualityLevel: 6, compressionLevel: 2, labelKey: 'vncQualitySharp' },
  { key: 'fine', qualityLevel: 8, compressionLevel: 2, labelKey: 'vncQualityFine' },
  { key: 'narrowband', qualityLevel: 5, compressionLevel: 9, labelKey: 'vncQualityNarrowband' }
]
export const DEFAULT_QUALITY = { qualityLevel: 3, compressionLevel: 1 }

/**
 * 本机逐 host 的画质记忆键（与 vnc-scale-view- 同一命名与同一口径：
 * 只进本机，不回写书签）
 */
export const qualityLsKey = (host) => `vnc-quality-${host}`

/**
 * 只接受 0-9 整数：noVNC 的 setter 对非整数直接 Log.Error 后丢弃，
 * 字符串（历史书签 / ls 里的 '8'）在这里先归一，越界与脏值交给下一层兜底。
 * 非法返回 null，由调用方决定回退到哪一档。
 */
export const normalizeQualityLevel = (v) => {
  if (v === null || v === undefined || v === '') {
    return null
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n < QUALITY_LEVEL_MIN || n > QUALITY_LEVEL_MAX) {
    return null
  }
  return n
}

/**
 * 画质的取值优先级，与 resolveScaleViewport 完全同构：
 *   本机记忆（按 host）> 书签字段（可同步/可进 profile）> 出厂默认 3/1。
 * 本机记忆里某一轴脏了（越界）时，那一轴单独回落到书签，另一轴不受牵连。
 */
export const resolveQuality = (localOverride, tabQuality, tabCompression) => {
  const local = localOverride && typeof localOverride === 'object' ? localOverride : {}
  return {
    qualityLevel: normalizeQualityLevel(local.qualityLevel) ??
      normalizeQualityLevel(tabQuality) ?? DEFAULT_QUALITY.qualityLevel,
    compressionLevel: normalizeQualityLevel(local.compressionLevel) ??
      normalizeQualityLevel(tabCompression) ?? DEFAULT_QUALITY.compressionLevel
  }
}

/**
 * 档位是 (Q, C) 的派生值，不单独记忆：滑杆停到非预设组合，顶栏就读"自定义"。
 */
export const presetKeyFor = (qualityLevel, compressionLevel) => {
  const hit = QUALITY_PRESETS.find(p =>
    p.qualityLevel === qualityLevel && p.compressionLevel === compressionLevel
  )
  return hit ? hit.key : QUALITY_CUSTOM
}

/**
 * 视口是否真的变了：任一维度差值超过 epsilon 才算。
 * prev 为空（首次）时，只要 next 有效就返回真。
 */
export const shouldReLayout = (prev, next, epsilon = VIEWPORT_EPSILON) => {
  if (!isNumericSize(next)) {
    return false
  }
  if (!isNumericSize(prev)) {
    return true
  }
  return Math.abs(Number(next.width) - Number(prev.width)) > epsilon ||
    Math.abs(Number(next.height) - Number(prev.height)) > epsilon
}
