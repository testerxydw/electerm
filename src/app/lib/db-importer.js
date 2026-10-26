/**
 * CSV/TSV 导入（C 批，设计 §10）
 *
 * 组成：
 * 1. 零依赖 RFC4180 解析器（纯函数：createParserState / feedChunk / finish /
 *    parseSample）：4KB 块流式喂入，状态机跨块保持（引号内换行、CRLF 被块边界
 *    切断、" 双写转义跨块都正确）。解析器忠实：空行产出 ['']，导入执行层跳过。
 * 2. 任务执行（dbImportOp）：openFile（选文件 + 样例预览）→ start（映射 + 分批
 *    写入）→ status / cancel。任务上限 4；取消是"止步"不是回滚 —— 已提交批次保留，
 *    未提交的累积批次丢弃。
 *
 * 映射：mapping = [{ fileCol, target }]，target:
 * - 列名字符串 → 该文件列的值按参数绑定进目标列
 * - null/'' → 跳过该文件列
 * - { mode:'constant', value, column? } → 常量绑定进 column（默认同名 fileCol）
 * - { mode:'null', column? } → NULL
 * - { mode:'expression', sql, column? } → SQL 片段内联进 VALUES 对应位置，
 *   拼接前必须过 safe-clause.assertSafeClause 的目标表列白名单（分号/注释/写关键词
 *   一律拒绝），且不允许占位符 —— 片段由数据库对每行求值，无可绑参数
 *
 * 为什么 expression 的闸门放在本文件而不是适配器：片段来自渲染层映射配置（不可信），
 * 必须在主进程、SQL 拼接发生之前过列白名单；适配器 insertRows 只接受已校验片段
 * 并在注释里声明该契约。
 *
 * 空字段语义：CSV 空字段导入为空字符串（忠实），不做 '' → NULL 的静默转换 ——
 * 两种语义各有真实场景，猜错比让用户显式用 constant/null 映射更糟。
 */

const log = require('../common/log')

// 4KB 块流式解析：与 createReadStream highWaterMark 一致，块足够小让取消及时生效
const IMPORT_CHUNK_BYTES = 4096
const MAX_IMPORT_TASKS = 4
const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 5000
// 样例预览只读文件头部：列名识别 + 映射预览不需要整个文件
const SAMPLE_PREVIEW_BYTES = 256 * 1024
const DONE_TTL_MS = 5 * 60 * 1000
const IMPORT_MODES = ['append', 'overwrite', 'upsert', 'rebuild']

// 任务表：importId → task
const tasks = new Map()
let importSeq = 0

// ================================ RFC4180 解析器（纯函数） ================================

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

// ================================ 映射与执行 ================================

/**
 * 映射归一（纯函数，导出仅供单测）。规则见文件头注释。
 * @returns {Array<{kind:'field'|'constant'|'null'|'expression', fileCol?, column, value?, sql?}>}
 */
function normalizeMapping (mapping) {
  const list = Array.isArray(mapping) ? mapping : []
  const setters = []
  for (const m of list) {
    if (!m || typeof m !== 'object' || m.fileCol === undefined || m.fileCol === null) {
      continue
    }
    const fileCol = String(m.fileCol)
    const t = m.target
    if (t === null || t === undefined || t === '') {
      continue
    }
    if (typeof t === 'string') {
      setters.push({ kind: 'field', fileCol, column: t })
      continue
    }
    if (typeof t === 'object') {
      const column = t.column !== undefined && t.column !== null && t.column !== ''
        ? String(t.column)
        : fileCol
      if (t.mode === 'constant') {
        setters.push({ kind: 'constant', column, value: t.value === undefined ? null : t.value })
      } else if (t.mode === 'null') {
        setters.push({ kind: 'null', column })
      } else if (t.mode === 'expression') {
        if (typeof t.sql !== 'string' || !t.sql.trim()) {
          throw new Error('expression 映射缺少 sql 片段: ' + fileCol)
        }
        setters.push({ kind: 'expression', column, sql: t.sql })
      } else {
        throw new Error('unknown mapping target mode: ' + String(t.mode))
      }
    } else {
      throw new Error('unknown mapping target: ' + String(t))
    }
  }
  if (!setters.length) {
    throw new Error('导入映射为空：至少需要一列 target')
  }
  return setters
}

/**
 * 文件行 → 待插入行对象（纯函数）。expression 列也要占键位（值置 undefined）：
 * insertRows 以首行 Object.keys 生成 INSERT 列清单，缺键会导致表达式列被静默丢弃
 * （buildInsertBatch 的 hasExpr 永远命不中）；undefined 值不会进绑定参数
 * （insertBatchParams 的 bindCols 本就跳过表达式列）。映射引用了表头不存在的
 * 文件列时按 null 处理（预览侧应拦，这里是兜底）。
 */
function mapRowToInsert (fields, setters, insertCols, headerCols) {
  const row = {}
  setters.forEach((s, i) => {
    const col = insertCols[i]
    if (s.kind === 'expression') {
      row[col] = undefined
      return
    }
    if (s.kind === 'constant') {
      row[col] = s.value
      return
    }
    if (s.kind === 'null') {
      row[col] = null
      return
    }
    const idx = headerCols ? headerCols.indexOf(s.fileCol) : -1
    row[col] = idx === -1 || fields[idx] === undefined ? null : fields[idx]
  })
  return row
}

// expression 片段闸门：目标表列白名单（assertSafeClause 同时拒绝分号/注释/
// 写关键词/黑名单函数）。列信息拿不到时宁可整单拒绝也不放行未校验片段。
function assertExpressionsSafe (setters, structure, dialect) {
  const { assertSafeClause } = require('./db-client/safe-clause')
  const columns = ((structure && structure.columns) || [])
    .map(c => c && c.name)
    .filter(n => typeof n === 'string' && n)
  for (const s of setters) {
    if (s.kind !== 'expression') {
      continue
    }
    if (!columns.length) {
      throw new Error('无法获取列信息，expression 映射已拒绝')
    }
    const { placeholders } = assertSafeClause(s.sql, columns, dialect)
    if (placeholders !== 0) {
      throw new Error('expression 不允许占位符: ' + s.sql)
    }
  }
}

function openImportFile (arg = {}) {
  // 参照 ipc.js show-open-dialog-sync 的过滤写法；asyncGlobals 拿不到 webContents，
  // 这里用应用级模态打开
  const { dialog } = require('electron')
  const res = dialog.showOpenDialogSync({
    title: '选择要导入的 CSV/TSV 文件',
    properties: ['openFile'],
    filters: [
      { name: 'CSV/TSV', extensions: ['csv', 'tsv', 'txt'] }
    ]
  })
  if (!res || !res.length) {
    return { filePath: null }
  }
  return previewImportFile(res[0], arg)
}

function previewImportFile (filePath, arg = {}) {
  const fs = require('fs')
  const stat = fs.statSync(filePath)
  const delimiter = arg.delimiter === '\t'
    ? '\t'
    : (String(filePath).toLowerCase().endsWith('.tsv') ? '\t' : ',')
  const fd = fs.openSync(filePath, 'r')
  let text = ''
  try {
    const len = Math.min(SAMPLE_PREVIEW_BYTES, stat.size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    text = buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
  const { columns, sampleRows } = parseSample(text, { delimiter })
  return { filePath, delimiter, columns, sampleRows, totalBytes: stat.size }
}

async function runImport (a, task) {
  const fs = require('fs')
  const { getDbTabContext, dbClientOp } = require('./db-client')
  const ctx = getDbTabContext(a.tabId)
  const dialect = ctx.dbType === 'postgres' ? 'postgres' : 'mysql'
  const mode = a.mode || 'append'
  if (!IMPORT_MODES.includes(mode)) {
    throw new Error('unsupported import mode: ' + mode)
  }
  if (mode === 'rebuild') {
    // D 批实现（清表重建），本期明确占位，不做任何破坏性操作
    throw new Error('rebuild 模式暂不支持（D 批实现）')
  }
  const setters = normalizeMapping(a.mapping)
  // 表结构：expression 列白名单 + upsert 主键来源。拿不到直接失败：
  // expression 无白名单不能放行，upsert 无主键写不了冲突子句
  let structure = null
  try {
    structure = await dbClientOp(a.tabId, 'getTableStructure', {
      database: a.database,
      schema: a.schema,
      table: a.table
    })
  } catch (e) {
    throw new Error('无法获取目标表结构，导入已拒绝: ' + e.message)
  }
  assertExpressionsSafe(setters, structure, dialect)
  const pkColumns = ((structure && structure.columns) || [])
    .filter(c => c && c.isPrimaryKey)
    .map(c => c.name)
  const expressions = {}
  for (const s of setters) {
    if (s.kind === 'expression') {
      expressions[s.column] = s.sql
    }
  }
  const insertCols = setters.map(s => s.column)
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.trunc(Number(a.batchSize) || DEFAULT_BATCH_SIZE))
  )
  const delimiter = a.delimiter === '\t' ? '\t' : ','
  const stream = fs.createReadStream(a.filePath, {
    encoding: 'utf8',
    highWaterMark: IMPORT_CHUNK_BYTES
  })
  const state = createParserState({ delimiter })
  let headerCols = null
  let headerSkipped = false
  let batch = []
  let batchFirstRow = 0
  let dataRowNo = 0

  // 提交一个批次：insertRows 内部还会按 500 行/1MB 二次切批（同口径），
  // 失败批次记录 文件数据行号（1-based，不含表头）后继续
  const flush = async () => {
    if (!batch.length) {
      return
    }
    const rows = batch.map(fields => mapRowToInsert(fields, setters, insertCols, headerCols))
    const firstRow = batchFirstRow
    batch = []
    const res = await ctx.adapter.insertRows(ctx.conn, {
      database: a.database,
      schema: a.schema,
      table: a.table,
      rows,
      readOnly: ctx.readOnly,
      mode,
      pkColumns: mode === 'upsert' ? pkColumns : undefined,
      expressions
    })
    task.committedRows += (res && res.affected) || 0
    for (const f of ((res && res.failures) || [])) {
      task.failedBatches++
      task.errors.push({
        batchNo: f.batchNo,
        firstRow: firstRow + f.firstRow,
        message: f.message
      })
    }
  }

  const feed = async rows => {
    for (const fields of rows) {
      if (task.cancelRequested) {
        // 止步：未提交的累积批次直接丢弃（不回滚已提交批次）
        return
      }
      dataRowNo++
      if (!batch.length) {
        batchFirstRow = dataRowNo
      }
      batch.push(fields)
      if (batch.length >= batchSize) {
        await flush()
      }
    }
  }

  const takeRows = chunkRows => {
    let rows = chunkRows.filter(r => !isEmptyRow(r))
    if (!headerSkipped && rows.length) {
      headerCols = rows[0]
      headerSkipped = true
      rows = rows.slice(1)
    }
    return rows
  }

  for await (const chunk of stream) {
    if (task.cancelRequested) {
      break
    }
    await feed(takeRows(feedChunk(state, chunk)))
  }
  if (!task.cancelRequested) {
    // 收尾：最后一条无换行行 / 悬空引号的宽松收口
    await feed(takeRows(finish(state)))
    await flush()
    task.status = 'done'
  } else {
    task.status = 'cancelled'
  }
}

function startImport (a) {
  const args = a || {}
  if (!args.tabId) {
    throw new Error('startImport requires tabId')
  }
  if (!args.table) {
    throw new Error('startImport requires table')
  }
  if (!args.filePath || typeof args.filePath !== 'string') {
    throw new Error('startImport requires filePath (from dbImportOp openFile)')
  }
  const running = [...tasks.values()].filter(t => t.status === 'running').length
  if (running >= MAX_IMPORT_TASKS) {
    throw new Error(`导入任务已达上限 ${MAX_IMPORT_TASKS} 个，请等待或取消后再试`)
  }
  const importId = 'imp-' + Date.now() + '-' + (++importSeq)
  const task = {
    importId,
    status: 'running',
    committedRows: 0,
    failedBatches: 0,
    errors: [],
    done: false,
    cancelRequested: false,
    error: null,
    completedAt: null
  }
  tasks.set(importId, task)
  runImport(args, task).catch(e => {
    log.error('[db-importer] failed', importId, e.message)
    task.status = 'failed'
    task.error = e.message
    task.done = true
    task.completedAt = Date.now()
  })
  return { importId }
}

function importStatus (importId) {
  sweepDoneTasks(Date.now())
  const t = tasks.get(importId)
  if (!t) {
    throw new Error('unknown importId: ' + importId)
  }
  return {
    importId: t.importId,
    status: t.status,
    committedRows: t.committedRows,
    failedBatches: t.failedBatches,
    errors: t.errors,
    done: t.done,
    error: t.error
  }
}

function cancelImport (importId) {
  const t = tasks.get(importId)
  if (!t) {
    throw new Error('unknown importId: ' + importId)
  }
  if (t.status === 'running') {
    t.cancelRequested = true
  }
  return { ok: true, status: t.status }
}

// 惰性清理（与 db-exporter 同一套口径；now 由调用方传入便于单测）
function sweepDoneTasks (now = Date.now()) {
  for (const [id, t] of tasks) {
    if (t.done && t.completedAt !== null && now - t.completedAt > DONE_TTL_MS) {
      tasks.delete(id)
    }
  }
}

function dbImportOp (action, arg) {
  const a = arg || {}
  if (action === 'openFile') {
    return openImportFile(a)
  }
  if (action === 'start') {
    return startImport(a)
  }
  if (action === 'status') {
    return importStatus(a.importId)
  }
  if (action === 'cancel') {
    return cancelImport(a.importId)
  }
  throw new Error('unknown dbImportOp action: ' + action)
}

module.exports = {
  dbImportOp,
  // 纯函数导出仅供单测（RFC4180 解析器 / 映射归一 / 行映射）
  createParserState,
  feedChunk,
  finish,
  parseSample,
  isEmptyRow,
  normalizeMapping,
  mapRowToInsert,
  // 常量
  IMPORT_CHUNK_BYTES,
  MAX_IMPORT_TASKS,
  DEFAULT_BATCH_SIZE,
  DONE_TTL_MS
}
