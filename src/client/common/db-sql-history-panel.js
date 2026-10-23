/**
 * SQL 历史弹层的尺寸 / 分栏 / 键盘导航（纯函数零依赖，可直接单测）
 *
 * 为什么单独成文件：
 * - 弹层宽度是拖拽出来的连续值，夹取、持久化、分栏判定这些边界要能脱 DOM 验证
 * - jsx 里只留事件绑定与渲染，几何算错的地方集中在两三个函数里
 *
 * 历史面板的默认尺寸：原来固定 380×380 装不下一条多行 SQL（列表里被截成一行半），
 * 长语句只能靠"插回编辑器"才能看全，于是常有人误插一条把当前编辑内容顶掉。
 * 现在默认更宽更高，且可拖拽。
 */

/** 默认尺寸：够放"列表 + 预览"两栏，且能看 2~3 条多行语句 */
export const HIST_PANEL_DEF = { width: 720, height: 440 }

/** 最小尺寸：再窄预览栏就没意义了 */
export const HIST_PANEL_MIN = { width: 420, height: 240 }

/** 最大尺寸：再大就成遮罩了，反而不如去编辑器里看 */
export const HIST_PANEL_MAX = { width: 980, height: 720 }

/**
 * 低于这个宽度不左右分栏，改上下堆叠。
 * 600 = 列表 320 + 预览 260 + 间距：再窄下去两边都会折行折到不可读
 */
export const HIST_SPLIT_MIN_WIDTH = 600

const num = v => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && isFinite(n) ? n : null
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/**
 * 把尺寸夹到合法区间，同时受视口约束。
 *
 * 视口约束不是多余的：弹层挂在工具条下方，高度超过视口下沿就够不着列表底部，
 * 而 antd Popover 只会整体偏移、不会替内容滚动。
 *
 * @param {{width?:number|string, height?:number|string}} size 期望尺寸（可缺省/非法）
 * @param {{width?:number, height?:number}} viewport 视口尺寸（缺省按 1280×800 算）
 * @returns {{width:number, height:number}} 取整后的合法尺寸
 */
export function clampPanelSize (size, viewport) {
  const vw = num(viewport && viewport.width) || 1280
  const vh = num(viewport && viewport.height) || 800
  // 预留：横向给左右留白，纵向给工具条 + 结果区标题留白
  const maxW = Math.max(HIST_PANEL_MIN.width, Math.min(HIST_PANEL_MAX.width, Math.floor(vw - 48)))
  const maxH = Math.max(HIST_PANEL_MIN.height, Math.min(HIST_PANEL_MAX.height, Math.floor(vh - 220)))
  const w = num(size && size.width)
  const h = num(size && size.height)
  return {
    width: Math.round(clamp(w === null ? HIST_PANEL_DEF.width : w, HIST_PANEL_MIN.width, maxW)),
    height: Math.round(clamp(h === null ? HIST_PANEL_DEF.height : h, HIST_PANEL_MIN.height, maxH))
  }
}

/**
 * 从全局 config 读尺寸。只认数字（手改 config 写成 "700px" 或对象一律回落默认），
 * 读数一律再过一次 clampPanelSize，避免旧配置在更小的窗口上溢出。
 */
export function readHistoryPanelSize (cfg, viewport) {
  return clampPanelSize({
    width: cfg ? cfg.dbSqlHistoryWidth : undefined,
    height: cfg ? cfg.dbSqlHistoryHeight : undefined
  }, viewport)
}

/** 持久化补丁（只写这两个键，setConfig 是浅合并，不整份写回） */
export function sizePatch (size) {
  const s = clampPanelSize(size)
  return { dbSqlHistoryWidth: s.width, dbSqlHistoryHeight: s.height }
}

/** 分栏方向：够宽就左右，否则上下 */
export function splitMode (width) {
  const w = num(width)
  return w !== null && w >= HIST_SPLIT_MIN_WIDTH ? 'row' : 'col'
}

/**
 * 键盘上下移动选中项，越界回绕。
 * 回绕而不是停住：从最后一条按 ↓ 回到最新一条（列表顶部是最新的），符合"倒序浏览"直觉。
 *
 * @param {number|null} cur 当前下标（null = 还没选中）
 * @param {number} len 列表长度
 * @param {number} delta 位移（±1）
 */
export function moveHistoryIndex (cur, len, delta) {
  if (!len || len < 1) {
    return 0
  }
  if (cur === null || cur === undefined || cur < 0 || cur >= len) {
    return delta < 0 ? len - 1 : 0
  }
  return ((cur + delta) % len + len) % len
}

/** 下标夹取（列表刷新后原下标可能越界，比如清空后再追加） */
export function clampHistoryIndex (cur, len) {
  if (!len || len < 1) {
    return 0
  }
  const n = num(cur)
  if (n === null) {
    return 0
  }
  return clamp(Math.floor(n), 0, len - 1)
}

/**
 * 预览文本：去尾部空白、把 CRLF 收成 LF（保存的语句可能来自 Windows 剪贴板），
 * 保留内部换行与缩进——预览的价值就在于"原样长什么样"。
 */
export function previewText (sql) {
  if (typeof sql !== 'string') {
    return ''
  }
  return sql.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

/**
 * 按关键字筛选历史（只匹配语句文本）。
 *
 * 不匹配库名/时间：很多人筛历史是"我记得里面有个 tgfsom_hsm"，
 * 混进库名会给出大量看着命中、实际语句里没有该词的条目。
 * 空关键字返回原数组（不复制）：调用方可能对引用做比较。
 */
export function filterHistory (list, kw) {
  const arr = Array.isArray(list) ? list : []
  const q = typeof kw === 'string' ? kw.trim().toLowerCase() : ''
  if (!q) {
    return arr
  }
  return arr.filter(it => String((it && it.sql) || '').toLowerCase().includes(q))
}
