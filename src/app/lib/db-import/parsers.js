/**
 * 导入源解析器注册表（N4a，设计 §N4 实现要点 4）
 *
 * 为什么要有这一层：db-importer 原来只认"定界符"，格式判定散在预览与执行两处
 * （各自 `=== '\t'` 猜一次），要加 JSONL/SQL 就得在每个猜的地方再补一个 if。
 * 注册表把"这个格式怎么认、怎么切行、怎么出样例"收到一处，执行层只问格式 id。
 * 与渲染层 value-renderers 同构：一张表 + 按 id 取用，新增格式只加一个条目。
 *
 * 与导出侧的对应关系（闭环的依据，见 db-exporter.FORMATS）：
 *   导出 csv/tsv/jsonl/sql → 导入认同样的四种；json/markdown 导出的文件
 *   导入不认（json 是整文档数组、markdown 是给人看的，都不是导入源）。
 *
 * 两种行形态，执行层按 rowShape 分派：
 * - `array`（csv/tsv）：一行 = 字段字符串数组，靠表头下标取值
 * - `object`（jsonl）：一行 = JSON 对象，靠键名取值，值保留 JSON 原生类型
 *   （null 就是 NULL，数字就是数字 —— 导出侧 JSON.stringify 写了什么类型，
 *   这里就还原什么类型，这是"导出→导入内容一致"的前提）
 *
 * `script`（sql）不是行数据：它是一串待执行语句，走 db-importer 的脚本分支，
 * 不在这里解析语句（切分语句用渲染层 db-sql-risk.splitStatements 那一份，
 * 全项目唯一口径 —— 判定风险的切分与实际执行的切分必须是同一个函数，
 * 否则"用户确认的语句"和"数据库执行的语句"可能不是同一批）。
 *
 * 流式：csv/tsv/jsonl 的解析器都是 createState / feed(chunk) / finish() 三段，
 * 块边界任意切分都必须与整串一次喂入结果一致（单测差分验证）。
 * xlsx 是例外（见下方 XLSX 一节的头注释）：zip 容器无法按字符块流式，
 * 走整文件解析 + 双护栏，不参与 createState/feed/finish 契约。
 */

'use strict'

// ================================ CSV/TSV：RFC4180 状态机 ================================
// 从 db-importer.js 原样搬来（N4a 把它接进注册表），行为零变更。

/**
 * 解析状态。delimiter 只接受 ',' 或 '\t'（CSV/TSV 两种定界符，
 * 其他字符做定界符没有真实场景，收紧省得边界纠缠）。
 */
function createParserState (opts = {}) {
  const d = opts.delimiter === '\t' ? '\t' : ','
  return {
    delimiter: d,
    row: [], // 当前累积行（字段数组）
    field: '',
    fieldStarted: false, // 字段是否已开始（引号开定后也算）——决定 '"' 是开引号还是字面量
    inQuotes: false,
    // 引号内遇到 '"'：可能是 "" 转义（下一个字符还是 '"'）也可能是闭合引号。
    // 下一字符可能跨块到达，必须挂起等待而不是就地判定
    quotePending: false,
    // 非引号区遇到 '\r'：行已收尾；若下一字符是 '\n'（可能跨块）一并吞掉
    crPending: false,
    // 文件首字符 BOM 剥离标记（只在第一个 chunk 的第一个字符生效）
    fresh: true
  }
}

/**
 * 喂入一个字符串块，返回本块内**完成**的行（字段字符串数组）。
 * 未完成的行/字段留在 state 里，跨块续传。任意切块与整串解析结果一致（单测保障）。
 */
function feedChunk (state, str) {
  const out = []
  let s = String(str || '')
  if (state.fresh) {
    state.fresh = false
    if (s.startsWith('\uFEFF')) {
      s = s.slice(1)
    }
  }
  let pendingCr = state.crPending
  let pendingQuote = state.quotePending
  let inQuotes = state.inQuotes
  let field = state.field
  let fieldStarted = state.fieldStarted
  let row = state.row
  const d = state.delimiter
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (pendingCr) {
      // 上一块以 \r 结尾且行已收：紧跟 \n 则吞掉（CRLF），否则按普通字符处理
      pendingCr = false
      if (ch === '\n') {
        continue
      }
    }
    if (pendingQuote) {
      pendingQuote = false
      if (ch === '"') {
        // "" 双写转义：字面量引号
        field += '"'
        continue
      }
      // 闭合引号；引号后的字符（垃圾/定界符/行尾）按宽松语义继续处理
      inQuotes = false
    }
    if (inQuotes) {
      if (ch === '"') {
        pendingQuote = true
        continue
      }
      field += ch
      fieldStarted = true
      continue
    }
    if (ch === '"') {
      if (!fieldStarted && field === '') {
        // 字段起始的引号 = 开引号；字段中间的引号按字面量（宽松于 RFC，兼容脏数据）
        inQuotes = true
        fieldStarted = true
      } else {
        field += ch
      }
      continue
    }
    if (ch === d) {
      row.push(field)
      field = ''
      fieldStarted = false
      continue
    }
    if (ch === '\r') {
      row.push(field)
      out.push(row)
      row = []
      field = ''
      fieldStarted = false
      pendingCr = true
      continue
    }
    if (ch === '\n') {
      row.push(field)
      out.push(row)
      row = []
      field = ''
      fieldStarted = false
      continue
    }
    field += ch
    fieldStarted = true
  }
  state.crPending = pendingCr
  state.quotePending = pendingQuote
  state.inQuotes = inQuotes
  state.field = field
  state.fieldStarted = fieldStarted
  state.row = row
  return out
}

/**
 * 文件结束时调用：冲刷最后一条未收尾的行。
 * 悬空 \r（行已收，无尾随 \n 可吞）直接复位；未闭合引号按宽松语义把已积累
 * 内容当数据收下 —— 截断文件宁可收下半行也不让整个导入失败（严格校验属 UI 预览职责）。
 */
function finish (state) {
  const out = []
  state.crPending = false
  if (state.quotePending) {
    // 文件终止在 '"' 上：视为闭合引号
    state.quotePending = false
    state.inQuotes = false
  }
  if (state.inQuotes) {
    state.inQuotes = false
  }
  if (state.field !== '' || state.fieldStarted || state.row.length) {
    state.row.push(state.field)
    out.push(state.row)
    state.row = []
    state.field = ''
    state.fieldStarted = false
  }
  return out
}

// 整行仅一个空字段 = 空行（解析器忠实产出；导入执行层跳过）
function isEmptyRow (row) {
  return row.length === 1 && row[0] === ''
}

/**
 * 一次性解析样例文本：返回 { columns, sampleRows }。
 * 首条非空行为表头，其余为样例（最多 maxRows 条）。
 */
function parseSample (text, opts = {}) {
  const state = createParserState(opts)
  let rows = feedChunk(state, String(text || ''))
  rows = rows.concat(finish(state))
  const dataRows = rows.filter(r => !isEmptyRow(r))
  const columns = dataRows.length ? dataRows[0] : []
  const sampleRows = dataRows.slice(1, 1 + Math.max(0, Number(opts.maxRows) || 50))
  return { columns, sampleRows }
}

// ================================ JSONL：逐行 JSON ================================
// 与导出侧严格对称（db-exporter formatWriters('jsonl')：每行一个
// JSON.stringify(projectRow(row, headers))，'\n' 分隔，末行也有换行）。
// 所以这里只认"一行一个 JSON 值"，不认跨行美化 JSON —— 那是 json 格式，
// 导出侧就不把它列为导入源。

function createJsonlState () {
  return {
    buf: '',
    // 已完成的行号（含空行）：报错时要给出可定位的行号，只说"JSON 不合法"用户没法查
    lineNo: 0,
    fresh: true
  }
}

// 一行文本 → 对象。空行/纯空白行跳过（导出不会产生，但手写文件常见）
function jsonlLineToRow (state, line) {
  state.lineNo++
  const text = String(line).trim()
  if (!text) {
    return null
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`第 ${state.lineNo} 行不是合法 JSON：${err.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`第 ${state.lineNo} 行不是 JSON 对象（导出侧每行写一个对象）`)
  }
  return value
}

/**
 * 喂入一个块，返回本块内**完整行**解析出的对象数组。
 * 只按 '\n' 断行（JSON 字符串里的换行已被 JSON.stringify 转义，不可能出现裸换行），
 * '\r' 收尾按 CRLF 吞掉；未完成的尾行留在 state.buf 等下一块。
 */
function feedJsonlChunk (state, str) {
  const rows = []
  let s = String(str || '')
  if (state.fresh) {
    state.fresh = false
    if (s.startsWith('\uFEFF')) {
      s = s.slice(1)
    }
  }
  state.buf += s
  let idx = state.buf.indexOf('\n')
  while (idx !== -1) {
    const line = state.buf.slice(0, idx).replace(/\r$/, '')
    state.buf = state.buf.slice(idx + 1)
    const row = jsonlLineToRow(state, line)
    if (row) {
      rows.push(row)
    }
    idx = state.buf.indexOf('\n')
  }
  return rows
}

/** 文件结束：冲刷没有尾换行的最后一行 */
function finishJsonl (state) {
  const rest = state.buf
  state.buf = ''
  if (!rest) {
    return []
  }
  const row = jsonlLineToRow(state, rest.replace(/\r$/, ''))
  return row ? [row] : []
}

/**
 * JSON 值 → 待绑定值（对称还原导出侧写进去的类型）。
 * - null / undefined（键不存在）→ null
 * - 字符串/数字/布尔 → 原样（适配器按参数绑定）
 * - `__bin` 信封（F3 二进制列）→ Buffer：未截断的 base64 就是原字节，
 *   截断的信封只有前缀，导入它等于静默写坏数据 → 直接拒绝整次导入
 * - 其它对象/数组 → JSON 文本（json/jsonb 列的对称形态：导出写对象，
 *   这里把对象序列化回文本，由数据库自己按列类型存）
 */
function jsonValueToCell (value, lineNo) {
  if (value === null || value === undefined) {
    return null
  }
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return value
  }
  if (t === 'object') {
    const { isBinEnvelope } = require('../db-exporter')
    if (isBinEnvelope(value)) {
      const bin = value.__bin
      if (bin.truncated) {
        throw new Error(
          `第 ${lineNo} 行的二进制列是截断导出（原 ${bin.size} 字节，文件里只有前缀），无法还原完整数据`
        )
      }
      return Buffer.from(bin.b64, 'base64')
    }
    return JSON.stringify(value)
  }
  // 函数/symbol/bigint 出现在 JSON.parse 的结果里是不可能的，走到这里说明调用方传错
  throw new Error(`第 ${lineNo} 行含无法导入的值类型：${t}`)
}

/**
 * 样例预览：列名 = 前 maxRows 行里出现过的键（首次出现顺序），
 * sampleRows = 与列名对齐的**展示文本**数组（对象值显示成 JSON 文本，
 * null 显示空串 —— 预览是给人核对的，不是数据）。
 *
 * 预览不做类型还原（不走 jsonValueToCell）：截断的二进制信封在执行时才是
 * 必须拒绝的错误，在预览时只是"这列不完整"，报出来会让用户看不到其余列。
 */
function parseJsonlSample (text, opts = {}) {
  const state = createJsonlState()
  const rows = feedJsonlChunk(state, String(text || '')).concat(finishJsonl(state))
  const maxRows = Math.max(0, Number(opts.maxRows) || 50)
  const columns = []
  const seen = new Set()
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  const display = v => {
    if (v === null || v === undefined) {
      return ''
    }
    if (typeof v === 'object') {
      return JSON.stringify(v)
    }
    return String(v)
  }
  const sampleRows = rows
    .slice(0, maxRows)
    .map(row => columns.map(c => display(row[c])))
  return { columns, sampleRows }
}

// ================================ XLSX：整文件解析（不走文本流契约） ================================
// 为什么 xlsx 不走 createState/feed/finish：xlsx 是 zip 容器（二进制），无法像文本
// 那样按字符块切分流式喂入——块边界语义在 zip 里不存在。改为整文件解析，用两道
// 护栏替代流式的内存安全性：文件大小护栏（zip 解压前的第一道闸）与总单元格数
// 护栏（zip 炸弹的第二道闸：压缩包可以很小但解出天文数字的单元格）。

// 文件大小护栏：32MB 压缩包对表格文件已经非常宽裕（xlsx 压缩率通常 >2x）
const XLSX_MAX_BYTES = 32 * 1024 * 1024
// 总单元格数护栏：2000 万单元格约当 10 万行 x 200 列，再大解析的内存与时延
// 都不适合 GUI 交互，引导改用 CSV 流式导入
const XLSX_MAX_CELLS = 20 * 1000 * 1000

// 大小护栏（纯函数，spec 直接测）：超限报出上限与当前值，与 MAX_SCRIPT_BYTES 同款文案
function assertXlsxSize (size) {
  const n = Number(size) || 0
  if (n > XLSX_MAX_BYTES) {
    throw new Error(
      `xlsx 导入上限 ${Math.floor(XLSX_MAX_BYTES / 1024 / 1024)}MB（当前 ${Math.ceil(n / 1024 / 1024)}MB），请改用 CSV/TSV 导入`
    )
  }
}

// 单元格数护栏（纯函数，spec 直接测）：zip 炸弹表现为"文件很小、单元格很多"，
// 大小护栏拦不住，必须按 parseMetadata 估算的解压后规模再拦一道
function assertXlsxCells (count) {
  const n = Number(count) || 0
  if (n > XLSX_MAX_CELLS) {
    throw new Error(
      `xlsx 导入单元格数上限 ${XLSX_MAX_CELLS}（估算 ${n}），文件可能过大或异常，请改用 CSV 导入`
    )
  }
}

/**
 * 解析整个工作簿，返回 sheets 数组（[{ name, data }]，data 含表头行）。
 * node-xlsx 较大且只有 xlsx 路径用得到，懒 require（与 db-importer.js 的
 * 函数内 require 惯例一致），避免无关导入路径背上这个包。
 * 解析前先 statSync 过大小护栏、parseMetadata 估算总单元格过炸弹护栏：
 * parseMetadata 只读维度信息不解析单元格，代价远小于整簿 parse。
 */
function parseXlsxSheets (filePath) {
  const fs = require('fs')
  const stat = fs.statSync(filePath)
  assertXlsxSize(stat.size)
  const xlsx = require('node-xlsx')
  const metas = xlsx.parseMetadata(filePath)
  const totalCells = metas.reduce((n, m) => {
    const d = (m && m.data) || {}
    const rows = ((d.e && d.e.r) || 0) + 1
    const cols = ((d.e && d.e.c) || 0) + 1
    return n + rows * cols
  }, 0)
  assertXlsxCells(totalCells)
  // cellDates: true 必传 —— 缺省时真实日期单元格（非文本）还原成 Excel 序列号
  // 裸数字（如 2024-01-15 → 45306.33），按数字绑进 DATE/DATETIME 列要么报错
  // 要么存进脏数据。开了之后日期格还原成 Date，再由 xlsxSheetRows 统一折算成字符串
  return xlsx.parse(filePath, { cellDates: true })
}

/**
 * Date 单元格 → 字符串的折算（与 CSV 导入"日期是字符串、DB 折算"同体验）。
 * 为什么折算成字符串而不是保留 Date：绑定层跨方言兼容 —— sqlite 的绑定不收
 * Date 对象。为什么不是 toISOString()：ISO 串末尾的 'Z' 时区标记 MySQL 的
 * DATETIME 解析不认（8.0.19 起只认 ±HH:MM 偏移），'YYYY-MM-DD HH:mm:ss'
 * 空白分隔写法 mysql/pg/sqlite 三家通吃：
 * - 纯日期（UTC 零点）→ 'YYYY-MM-DD'
 * - 带时刻 → 'YYYY-MM-DD HH:mm:ss'
 * Excel 序列号是浮点秒，cellDates 还原的毫秒可能带漂移（08:30:05 读成 .999s），
 * 先就近取整到秒再格式化，否则秒级时刻会差 1 秒。
 */
function xlsxDateCell (d) {
  const ms = d.getUTCMilliseconds()
  const t = ms >= 500 ? d.getTime() + (1000 - ms) : d.getTime() - ms
  const iso = new Date(t).toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/**
 * xlsx 的格式坑在这里修（也是"解析值 → 行数据"的唯一折算点）：
 * ①尾部空单元格不落盘：xlsx 格式特性不是库 bug，解析 [null,2,null] 回来是
 *   [null,2]（长度 2）。按表头行长度把每行尾部缺失补 null，否则按下标取值的
 *   映射层会读到 undefined（与"缺列"语义混淆）。
 * ②行内 undefined → null。
 * ③Date 单元格（cellDates 还原）→ 数据库友好字符串（见 xlsxDateCell）。
 * 预览与执行两条路都必须经过这里（执行层喂 raw sheet.data 会漏掉全部折算）。
 * 空行不在这里过滤：纯函数只负责形状，空行判定交给 xlsxIsEmptyRow 由调用方过滤。
 */
function xlsxSheetRows (sheet) {
  const data = (sheet && sheet.data) || []
  // 期望列数 = 首行（表头）长度：短行补齐、长行截断（超出表头的列没有映射依据，
  // 按下标取值的映射层永远读不到它们，留在行里只会造成假象）
  const expect = data[0] ? data[0].length : 0
  return data.map(row => {
    const cells = Array.isArray(row) ? row : []
    const out = []
    for (let i = 0; i < expect; i++) {
      const v = cells[i]
      out.push(v === undefined
        ? null
        : (v instanceof Date ? xlsxDateCell(v) : v))
    }
    return out
  })
}

// 空行判定：整行每个单元格都是 null 或空串（与 csv 的"单个空字段"判定不同——
// 补 null 后的空行长度等于列数，isEmptyRow 那条判定对 xlsx 永远不成立）
function xlsxIsEmptyRow (row) {
  return (Array.isArray(row) ? row : []).every(c => c === null || c === '')
}

/**
 * xlsx 预览：返回多 sheet 信息 + 选中 sheet 的列与样例。
 * 选中逻辑：opts.sheetName 按名精确匹配，匹配不到回落第一个（与执行层一致）。
 * 样例/列名都是展示文本（预览是给人核对的，与 parseSample/parseJsonlSample 同口径）。
 */
function previewXlsx (filePath, opts = {}) {
  const sheets = parseXlsxSheets(filePath)
  const sheet = sheets.find(s => s.name === opts.sheetName) || sheets[0]
  const rows = sheet ? xlsxSheetRows(sheet) : []
  const display = v => {
    if (v === null || v === undefined) {
      return ''
    }
    return String(v)
  }
  const columns = rows.length ? rows[0].map(display) : []
  const maxRows = Math.max(0, Number(opts.maxRows) || 50)
  const sampleRows = rows
    .slice(1, 1 + maxRows)
    .map(r => r.map(display))
  return {
    format: 'xlsx',
    sheets: sheets.map(s => s.name),
    sheetName: sheet ? sheet.name : '',
    columns,
    sampleRows,
    totalRows: Math.max(0, rows.length - 1)
  }
}

// ================================ 注册表 ================================

/**
 * 格式表。字段：
 * - id / rowShape：执行层分派依据（array=按下标映射，object=按键名映射，
 *   script=不是数据而是语句）
 * - extensions：打开对话框的过滤与按文件名推断的依据
 * - delimiter：仅定界符格式有意义（csv/tsv 共用同一台状态机）
 * - hasHeader：csv/tsv/jsonl 都要求首行表头 / 每行带键名，映射界面按列名对齐；
 *   没有"无表头"入口（那是另一件事，本轮不做）
 */
const IMPORT_FORMATS = [
  { id: 'csv', rowShape: 'array', delimiter: ',', extensions: ['csv', 'txt'], kind: 'rows' },
  { id: 'tsv', rowShape: 'array', delimiter: '\t', extensions: ['tsv'], kind: 'rows' },
  { id: 'jsonl', rowShape: 'object', extensions: ['jsonl', 'ndjson'], kind: 'rows' },
  // xlsx：rowShape=array 但不走 createState/feed/finish（整文件解析，见 XLSX 一节）
  { id: 'xlsx', rowShape: 'array', extensions: ['xlsx'], kind: 'rows' },
  { id: 'sql', rowShape: 'script', extensions: ['sql'], kind: 'script' }
]

const FORMAT_BY_ID = IMPORT_FORMATS.reduce((m, f) => {
  m[f.id] = f
  return m
}, {})

const IMPORT_FORMAT_IDS = IMPORT_FORMATS.map(f => f.id)

function extOf (filePath) {
  const name = String(filePath || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1)
}

/**
 * 格式判定：显式 argFormat 优先（用户在界面上选了），否则按扩展名推断，
 * 都不中回落 csv（与旧行为一致：旧版只认 csv/tsv，其他一律按逗号切）。
 * 未知 id 一律拒绝 —— 静默回落会让"选了 JSONL 却按逗号切"这种事故无声发生。
 */
function resolveFormat (filePath, argFormat) {
  if (argFormat !== undefined && argFormat !== null && argFormat !== '') {
    const f = FORMAT_BY_ID[String(argFormat).toLowerCase()]
    if (!f) {
      throw new Error('unknown import format: ' + String(argFormat))
    }
    return f
  }
  const ext = extOf(filePath)
  const byExt = IMPORT_FORMATS.find(f => f.extensions.includes(ext))
  return byExt || FORMAT_BY_ID.csv
}

// 打开对话框的过滤器：一个"全部支持"条目 + 每格式一条。
// "全部支持"的名字从注册表动态拼——硬编码的话，加一个格式它就在撒谎了
function dialogFilters () {
  const all = IMPORT_FORMATS.reduce((acc, f) => acc.concat(f.extensions), [])
  const named = IMPORT_FORMATS.map(f => ({
    name: f.id.toUpperCase(),
    extensions: f.extensions
  }))
  return [{ name: IMPORT_FORMATS.map(f => f.id.toUpperCase()).join('/'), extensions: all }].concat(named)
}

/** 行解析器统一入口：按格式建状态 */
function createRowState (format, opts = {}) {
  const f = FORMAT_BY_ID[format] || FORMAT_BY_ID.csv
  if (f.rowShape === 'object') {
    return createJsonlState()
  }
  return createParserState({ delimiter: f.delimiter || (opts && opts.delimiter) })
}

/** 喂一块，返回行（csv/tsv → 字段数组；jsonl → 对象数组） */
function feedRows (format, state, chunk) {
  return FORMAT_BY_ID[format] && FORMAT_BY_ID[format].rowShape === 'object'
    ? feedJsonlChunk(state, chunk)
    : feedChunk(state, chunk)
}

/** 收尾冲刷 */
function finishRows (format, state) {
  return FORMAT_BY_ID[format] && FORMAT_BY_ID[format].rowShape === 'object'
    ? finishJsonl(state)
    : finish(state)
}

/** 样例预览统一入口 */
function previewSample (text, opts = {}) {
  const f = resolveFormat(opts.filePath, opts.format)
  if (f.kind === 'script') {
    // 脚本格式没有"列"概念：预览交给渲染层用 splitStatements 出语句清单
    return { format: f.id, columns: [], sampleRows: [] }
  }
  if (f.rowShape === 'object') {
    const { columns, sampleRows } = parseJsonlSample(text, opts)
    return { format: f.id, columns, sampleRows }
  }
  const { columns, sampleRows } = parseSample(text, { delimiter: f.delimiter, maxRows: opts.maxRows })
  return { format: f.id, columns, sampleRows }
}

module.exports = {
  IMPORT_FORMATS,
  IMPORT_FORMAT_IDS,
  resolveFormat,
  dialogFilters,
  createRowState,
  feedRows,
  finishRows,
  previewSample,
  // 单格式直用（单测与 db-importer 复用）
  createParserState,
  feedChunk,
  finish,
  isEmptyRow,
  parseSample,
  createJsonlState,
  feedJsonlChunk,
  finishJsonl,
  parseJsonlSample,
  jsonValueToCell,
  // xlsx（N4b）：护栏常量与整文件解析路径
  XLSX_MAX_BYTES,
  XLSX_MAX_CELLS,
  assertXlsxSize,
  assertXlsxCells,
  parseXlsxSheets,
  xlsxSheetRows,
  xlsxIsEmptyRow,
  previewXlsx
}
