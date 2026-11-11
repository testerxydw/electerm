/**
 * N9-③ 稳定行标识（纯函数，零依赖）
 *
 * 为什么需要稳定 id：数据页主网格原先直接拿 `__rowKey`（页内数字下标）当 antd
 * `rowKey`。虚拟滚动 / 条件重渲会复用 DOM 节点，位置型 key 让 React 认为
 * "第 3 行还是第 3 行" —— 翻页、排序、页内过滤后勾选框、行内编辑态会短暂
 * 错到另一条记录上。DBX 类产品在虚拟列表之外还有 `virtualRowIdentifier`
 * 那层"行身份"，本模块把这一层补齐：按行内容（有主键时只按主键值）算指纹，
 * 跨页 / 排序 / 刷新都不变。
 *
 * 本轮刻意**不**改 selectedRowKeys 的数字语义：删除、批量改值、导出、反选等
 * 5 处消费都按页内下标定位（use-db-insert / use-db-bulk-edit / use-db-export），
 * 改语义会牵动删除 SQL 的主键 IN 列表。稳定 id 只做 React key；id ↔ 下标的
 * 转换在 db-session.jsx 侧包装一层 rowSelection 完成，同样不加
 * preserveSelectedRowKeys（重新取数仍清空勾选，避免跨页误删）。
 *
 * 设计约束：
 * - 零依赖、无模块状态、无 Date.now / Math.random，同一 (row, columns, opts)
 *   多次调用结果完全一致；
 * - namespace 只允许放 db.table 这类"表定位"信息做跨表隔离，**不得含页码或
 *   页内下标**（那等于把位置重新塞回身份里，稳定性就没了）；
 * - 逐列按传入 columns 数组顺序取值，行缺列按 undefined 处理；整体 O(rows × cols)，
 *   不在行循环里反复序列化整个大对象。
 */
export const ROW_ID_KEY = '__rowId'

// 单格进入哈希前的字符上限。BLOB / base64 单格可能上 MB，3 万行布局若把全量
// 内容喂进哈希就是 O(总字节数)；截到固定上限后每行成本恒定。
const DEFAULT_MAX_CELL_CHARS = 4096
// 对象递归上限：极端深的嵌套（或反序列化出来的怪结构）降级成固定标记，不爆栈
const MAX_OBJECT_DEPTH = 32

/**
 * 单字段编码：tag + 内容长度 + ':' + 内容。
 * 长度前缀让任何内容（含 ':'、'|'、'#'、分隔符本身）都伪造不出字段边界：
 * ['a|b', 'c'] 与 ['a', 'b|c'] 拼出的输入必然不同，列数不同也会因为多 / 少
 * 一段 `c<长度>:<列名>` 而不同 —— 这是分隔符注入的防护，不能改成简单 join('|')。
 */
function enc (tag, body) {
  return tag + body.length + ':' + body
}

// 超长内容截断：把原始长度并进内容，两段前 max 个字符相同、长度不同的长串
// 不会撞 id；用另一个 tag 标记"这是截断过的"，避免与恰好长成 "<数字>:..." 的
// 完整短串混淆。
function encCell (fullTag, cutTag, body, max) {
  if (body.length <= max) {
    return enc(fullTag, body)
  }
  return enc(cutTag, body.length + ':' + body.slice(0, max))
}

function numberText (v) {
  if (Number.isNaN(v)) {
    return 'NaN'
  }
  if (v === Infinity) {
    return 'Infinity'
  }
  if (v === -Infinity) {
    return '-Infinity'
  }
  // String(-0) 会写成 '0'；SQL 里 -0 与 0 未必落在同一分区，显式区分
  return Object.is(v, -0) ? '-0' : String(v)
}

function arrayBody (v, max, seen, depth) {
  const parts = [v.length + ':']
  for (let i = 0; i < v.length; i++) {
    parts.push(encodeValue(v[i], max, seen, depth + 1))
  }
  return parts.join('')
}

function objectBody (v, max, seen, depth) {
  // 键排序：{ a: 1, b: 2 } 与 { b: 2, a: 1 } 在 JS 里是同一行数据，属性顺序
  // 漂移不该让同一行算出两个 id。二进制信封对象不特判，按普通对象处理。
  let keys = []
  try {
    keys = Object.keys(v).sort()
  } catch (err) {
    keys = []
  }
  const parts = [keys.length + ':']
  for (const k of keys) {
    let val
    try {
      val = v[k]
    } catch (err) {
      val = undefined
    }
    parts.push(enc('k', k), encodeValue(val, max, seen, depth + 1))
  }
  return parts.join('')
}

/**
 * 值规范化：类型与空值都必须分开。null / undefined / '' / 字符串 'null' 若都
 * 走 String(v) 会混成一个指纹，刷新前后少一列就能让整行换 id。
 */
function encodeValue (v, max, seen, depth) {
  if (v === null) {
    return enc('z', '')
  }
  if (v === undefined) {
    return enc('u', '')
  }
  const t = typeof v
  if (t === 'boolean') {
    return enc('b', v ? '1' : '0')
  }
  if (t === 'number') {
    return enc('n', numberText(v))
  }
  if (t === 'bigint') {
    return enc('g', v.toString())
  }
  if (t === 'string') {
    return encCell('s', 'S', v, max)
  }
  if (t === 'symbol') {
    return enc('y', String(v))
  }
  if (t === 'function') {
    return enc('f', String(v.name || ''))
  }
  if (v instanceof Date) {
    const ms = v.getTime()
    return enc('d', Number.isNaN(ms) ? 'Invalid' : String(ms))
  }
  // 循环引用降级成固定标记：不抛错，且同一份输入每次都得到同一个结果
  if (seen.has(v)) {
    return enc('r', '')
  }
  if (depth >= MAX_OBJECT_DEPTH) {
    return enc('x', '')
  }
  seen.add(v)
  const isArr = Array.isArray(v)
  const body = isArr
    ? arrayBody(v, max, seen, depth)
    : objectBody(v, max, seen, depth)
  seen.delete(v)
  return encCell(isArr ? 'a' : 'o', isArr ? 'A' : 'O', body, max)
}

function cellAt (row, col) {
  if (!row) {
    return undefined
  }
  try {
    return row[col]
  } catch (err) {
    return undefined
  }
}

function normalizeOpts (opts) {
  const o = opts || {}
  const max = Number.isFinite(o.maxCellChars) && o.maxCellChars >= 1
    ? Math.floor(o.maxCellChars)
    : DEFAULT_MAX_CELL_CHARS
  const keyColumns = Array.isArray(o.keyColumns)
    ? o.keyColumns.filter(c => typeof c === 'string' && c.length > 0)
    : []
  const namespace = typeof o.namespace === 'string' ? o.namespace : ''
  return { max, keyColumns, namespace }
}

/**
 * 拼出哈希输入。优先主键：keyColumns 非空且该行确实带齐这些列时，只用主键值
 * （前缀 pk:），其余列不参与 —— 有主键的表跨页 / 排序 / 刷新都稳定；为空或
 * 缺列时回落整行内容指纹（前缀 h:）。两种模式前缀不同，输入也必然不同。
 */
function fingerprintInput (row, columns, cfg) {
  const hasRow = !!row && (typeof row === 'object' || typeof row === 'function')
  const usePk = cfg.keyColumns.length > 0 && hasRow &&
    cfg.keyColumns.every(c => Object.prototype.hasOwnProperty.call(row, c))
  const prefix = usePk ? 'pk:' : 'h:'
  const cols = usePk ? cfg.keyColumns : columns
  const parts = [prefix, enc('N', cfg.namespace)]
  // seen 复用到整行：单元格之间清一次即可，避免每行 × 每列都新建 Set
  const seen = new Set()
  for (const col of cols) {
    parts.push(enc('c', String(col)))
    seen.clear()
    parts.push(encodeValue(cellAt(row, col), cfg.max, seen, 0))
  }
  return { prefix, input: parts.join('') }
}

// FNV-1a 32bit：逐 UTF-16 码元做异或 + 质数乘，Math.imul 保证不溢出成浮点
function fnv1a (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  }
  return h >>> 0
}

// djb2 变体（乘 33 + 异或码元），与 FNV 的乘数 / 组合方式独立，拼成 64bit 指纹
function djb2Xor (s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

const hex8 = n => (n >>> 0).toString(16).padStart(8, '0')

function computeBase (row, columns, cfg) {
  const { prefix, input } = fingerprintInput(row, columns, cfg)
  // 16 位 hex = 两个独立 32bit 哈希；只截字符串前 N 位当 id 的碰撞率高得不可用
  return prefix + hex8(fnv1a(input)) + hex8(djb2Xor(input))
}

/**
 * 单行基础指纹（不含重复消歧后缀）。
 * @param {object} row 数据行；缺列按 undefined 处理
 * @param {string[]} columns 按此顺序取列的数据列名（不含 __rowKey / __rowId）
 * @param {object} [opts] { keyColumns, namespace, maxCellChars }
 * @returns {string} 'pk:' 或 'h:' 前缀 + 16 位 hex
 */
export function buildRowIdentity (row, columns, opts = {}) {
  const cols = Array.isArray(columns) ? columns : []
  return computeBase(row, cols, normalizeOpts(opts))
}

/**
 * 一批行的稳定 id，与 rows 等长。内容完全相同的两行按出现次序追加 #2 / #3…
 * 消歧；计数是本次调用内部的局部 Map，顺序确定且与调用次数无关。
 * @param {object[]} rows 数据行
 * @param {string[]} columns 数据列名
 * @param {object} [opts] 同 buildRowIdentity
 * @returns {string[]} 与 rows 等长的 id 数组
 */
export function buildRowIdentities (rows, columns, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const cols = Array.isArray(columns) ? columns : []
  const cfg = normalizeOpts(opts)
  const counts = new Map()
  const ids = new Array(list.length)
  for (let i = 0; i < list.length; i++) {
    const base = computeBase(list[i], cols, cfg)
    const n = counts.get(base) || 0
    counts.set(base, n + 1)
    ids[i] = n === 0 ? base : base + '#' + (n + 1)
  }
  return ids
}
