/**
 * 导入任务执行（C 批 CSV/TSV + N4a JSONL/SQL，设计 §10 / §N4）
 *
 * 本文件只做"任务与执行"：源解析在 db-import/parsers.js（注册表），
 * 行→插入行的折算在 db-import/mapping.js。三层的关系：
 *   parsers 出"一行"（字段数组 / JSON 对象 / 一段脚本）
 *   mapping 把"一行" + 映射配置折成"待插入行"
 *   本文件负责流式喂块、分批提交、进度/取消/错误、任务表
 *
 * 任务生命周期（dbImportOp）：openFile / preview（选文件 + 样例预览）→
 * start（映射 + 分批写入 或 逐条执行脚本）→ status / cancel。
 * 任务上限 4；取消是"止步"不是回滚 —— 已提交批次保留，未提交的累积批次丢弃。
 *
 * 三种源，两条执行通道（按注册表的 kind / rowShape 分派）：
 * - csv/tsv（rowShape=array）：首行表头，按下标取值，走 insertRows 分批
 * - jsonl（rowShape=object）：每行一个 JSON 对象，按键名取值并还原类型，
 *   同样走 insertRows 分批 —— 与导出侧 JSONL 严格对称（见 parsers.js 头注释）
 * - xlsx（N4b，rowShape=array）：zip 二进制不走文本流，整簿解析后一次性喂入
 *   同一条 takeRows/feed/flush 分批管线（xlsx 空行过滤在 parsers 里）
 * - sql（kind=script）：不写映射、不分批，逐条 dbClientOp('executeSql')
 *
 * SQL 导入的三条口径为什么这样定：
 * 1. 切分在渲染层做（db-sql-risk.splitStatements），主进程只收语句数组。
 *    风险弹窗给用户看的语句必须就是数据库实际执行的语句 —— 判定与执行用
 *    同一个函数的输出，不存在"解析器认为一条、驱动认为两条"。
 * 2. 一次 op 只发一条语句。PG 拒绝多语句、MySQL 靠 multipleStatements、
 *    SQLite 自己再切一遍：三家行为都不同。逐条执行让三家一致，也让
 *    readOnly 白名单、主进程超时、语句级进度与取消粒度落在同一层。
 * 3. 脚本失败即止（fail fast）：语句之间常有依赖（建表 → 插数 → 建索引），
 *    继续跑会把一条错误放大成上千条；行导入的批次彼此独立，才用
 *    "失败批次记录后继续"。
 */

const log = require('../common/log')
const {
  resolveFormat,
  dialogFilters,
  createRowState,
  feedRows,
  finishRows,
  previewSample,
  previewXlsx,
  isEmptyRow
} = require('./db-import/parsers')
const {
  normalizeMapping,
  mapRowToInsert,
  mapObjectToInsert,
  assertExpressionsSafe
} = require('./db-import/mapping')

// 4KB 块流式解析：与 createReadStream highWaterMark 一致，块足够小让取消及时生效
const IMPORT_CHUNK_BYTES = 4096
const MAX_IMPORT_TASKS = 4
const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 5000
// 样例预览只读文件头部：列名识别 + 映射预览不需要整个文件
const SAMPLE_PREVIEW_BYTES = 256 * 1024
// SQL 脚本要整份交给渲染层切分（判定与执行同一口径），因此有上限：
// 8MB 语句文本约当十几万条 INSERT，再大应当用命令行工具而不是 GUI 导入
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024
// 渲染层切完再传回主进程：条数上限同时兜住 IPC 载荷与进度可读性
const MAX_IMPORT_STATEMENTS = 20000
const DONE_TTL_MS = 5 * 60 * 1000
const IMPORT_MODES = ['append', 'overwrite', 'upsert', 'rebuild']

// 任务表：importId → task
const tasks = new Map()
let importSeq = 0

// ================================ 预览 ================================

function readHead (filePath, limit, size) {
  const fs = require('fs')
  const fd = fs.openSync(filePath, 'r')
  try {
    const len = Math.min(limit, size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function openImportFile (arg = {}) {
  // 参照 ipc.js show-open-dialog-sync 的过滤写法；asyncGlobals 拿不到 webContents，
  // 这里用应用级模态打开
  const { dialog } = require('electron')
  const res = dialog.showOpenDialogSync({
    title: '选择要导入的文件',
    properties: ['openFile'],
    filters: dialogFilters()
  })
  if (!res || !res.length) {
    return { filePath: null }
  }
  return previewImportFile(res[0], arg)
}

function previewImportFile (filePath, arg = {}) {
  const fs = require('fs')
  const stat = fs.statSync(filePath)
  // 格式判定只在注册表做一次：旧版在预览与执行两处各猜一次定界符，
  // 界面显式选了格式而文件名扩展名不一致时，两处会给出不同答案
  const fmt = resolveFormat(filePath, arg.format)
  if (fmt.id === 'xlsx') {
    // xlsx 不是文本，不能 readHead：整簿解析由 parseXlsxSheets 完成（含双护栏），
    // 返回多 sheet 信息 + 选中 sheet 的列/样例。渲染层切 sheet 后带 sheetName 重预览
    const res = previewXlsx(filePath, arg)
    return {
      filePath,
      format: 'xlsx',
      kind: 'rows',
      delimiter: null,
      sheets: res.sheets,
      sheetName: res.sheetName,
      columns: res.columns,
      sampleRows: res.sampleRows,
      totalRows: res.totalRows,
      totalBytes: stat.size
    }
  }
  if (fmt.kind === 'script') {
    if (stat.size > MAX_SCRIPT_BYTES) {
      throw new Error(
        `SQL 脚本导入上限 ${Math.floor(MAX_SCRIPT_BYTES / 1024 / 1024)}MB（当前 ${Math.ceil(stat.size / 1024 / 1024)}MB），请用命令行工具执行`
      )
    }
    // 脚本没有"列"概念：预览给出全文，由渲染层切分（切出来的就是执行清单）
    const scriptText = stat.size > SAMPLE_PREVIEW_BYTES
      ? fs.readFileSync(filePath, 'utf8')
      : readHead(filePath, SAMPLE_PREVIEW_BYTES, stat.size)
    return {
      filePath,
      format: fmt.id,
      kind: 'script',
      scriptText,
      totalBytes: stat.size,
      columns: [],
      sampleRows: []
    }
  }
  const text = readHead(filePath, SAMPLE_PREVIEW_BYTES, stat.size)
  const { columns, sampleRows } = previewSample(text, {
    filePath,
    format: fmt.id
  })
  return {
    filePath,
    format: fmt.id,
    kind: 'rows',
    delimiter: fmt.delimiter || null,
    columns,
    sampleRows,
    totalBytes: stat.size
  }
}

// ================================ 行数据导入（csv/tsv/jsonl/xlsx） ================================

async function runRowImport (a, task, ctx, dialect, fmt) {
  const fs = require('fs')
  const { dbClientOp } = require('./db-client')
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
  // 定界符由注册表按格式给出，渲染层传的 delimiter 不参与判定（避免两个口径）
  const state = createRowState(fmt.id)
  const byIndex = fmt.rowShape === 'array'
  let headerCols = null
  let headerSkipped = false
  let batch = []
  let batchFirstRow = 0
  let dataRowNo = 0
  // overwrite 的清空只在任务首批做一次：适配器每次 insertRows 都可清空目标表，
  // 后续批次再清会把前面已提交的行删光（committedRows 与库内行数就此对不上）
  let clearTarget = mode === 'overwrite'

  // 提交一个批次：insertRows 内部还会按 500 行/1MB 二次切批（同口径），
  // 失败批次记录 文件数据行号（1-based，不含表头）后继续
  const flush = async () => {
    if (!batch.length) {
      return
    }
    // jsonl 的类型问题（截断的二进制信封）由 mapObjectToInsert 抛错，
    // 这里传批次首行号，让报错里的"第 N 行"落在文件而不是批次
    const rows = batch.map((fields, k) => byIndex
      ? mapRowToInsert(fields, setters, insertCols, headerCols)
      : mapObjectToInsert(fields, setters, insertCols, batchFirstRow + k))
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
      expressions,
      clearTarget
    })
    clearTarget = false
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
    // 空行判定只对定界符格式有意义（JSONL 的一行是对象，不存在"只有一个空字段"）
    let rows = byIndex ? chunkRows.filter(r => !isEmptyRow(r)) : chunkRows
    if (byIndex && !headerSkipped && rows.length) {
      headerCols = rows[0]
      headerSkipped = true
      rows = rows.slice(1)
    }
    return rows
  }

  if (fmt.id === 'xlsx') {
    // xlsx 是 zip 二进制，无法按字符块流式：整簿解析后一次性喂入同一条
    // takeRows/feed/flush 管线（takeRows 跳首行表头，feed 内部有取消检查与分批）。
    // sheetName 不传或匹配不到回落第一个 sheet（与预览选中逻辑一致）
    const { parseXlsxSheets, xlsxSheetRows, xlsxIsEmptyRow } = require('./db-import/parsers')
    const sheets = parseXlsxSheets(a.filePath)
    const sheet = sheets.find(s => s.name === a.sheetName) || sheets[0]
    if (!sheet || !sheet.data.length) {
      task.status = 'done'
      return
    }
    // 行折算必须走 xlsxSheetRows（预览同一条）：尾部补 null + Date→字符串
    // 都在那一个点。喂 raw sheet.data 的话，日期单元格的 Date 对象和缺失的
    // 尾部列会原样进映射层。空行过滤用 xlsxIsEmptyRow 而不是 isEmptyRow：
    // 补 null 后空行不再是"单个空字段"，takeRows 里那条判定对 xlsx 会漏
    // （所以喂入前自己滤）
    await feed(takeRows(xlsxSheetRows(sheet).filter(r => !xlsxIsEmptyRow(r))))
  } else {
    const stream = fs.createReadStream(a.filePath, {
      encoding: 'utf8',
      highWaterMark: IMPORT_CHUNK_BYTES
    })
    for await (const chunk of stream) {
      if (task.cancelRequested) {
        break
      }
      await feed(takeRows(feedRows(fmt.id, state, chunk)))
    }
    if (!task.cancelRequested) {
      // 收尾：最后一条无换行行 / 悬空引号的宽松收口。
      // xlsx 不走状态机，这句对它是 no-op（收尾分支只在文本路径执行）
      await feed(takeRows(finishRows(fmt.id, state)))
    }
  }
  if (task.cancelRequested) {
    task.status = 'cancelled'
  } else {
    await flush()
    task.status = 'done'
  }
}

// ================================ SQL 脚本导入 ================================

// executeSql 结果里的影响行数汇总（三家适配器统一为 results[].affected）
function affectedOf (res) {
  const list = (res && res.results) || []
  return list.reduce((n, r) => n + (Number(r && r.affected) || 0), 0)
}

// 语句数组校验（纯函数）：渲染层切分后送来，空串/非字符串一律拒绝
function normalizeStatements (statements) {
  const list = Array.isArray(statements) ? statements : []
  const out = []
  list.forEach((s, i) => {
    if (typeof s !== 'string' || !s.trim()) {
      throw new Error(`第 ${i + 1} 条语句为空或不是文本`)
    }
    out.push(s)
  })
  if (!out.length) {
    throw new Error('SQL 导入需要至少一条语句')
  }
  if (out.length > MAX_IMPORT_STATEMENTS) {
    throw new Error(`SQL 导入语句数上限 ${MAX_IMPORT_STATEMENTS} 条（当前 ${out.length} 条）`)
  }
  return out
}

// 让出一次宏任务：sqlite 的 exec 是同步的，await 只排一个微任务，上千条语句连起来
// 就是单个长任务，cancelImport / importStatus 的 IPC 会被饿死（取消与进度都读不到中间态）
const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * 逐条执行渲染层切好的语句。exec 由调用方注入（生产用 dbClientOp，单测用假函数）：
 * 本函数不碰连接、不拼 SQL，语句文本原样下发 —— 只读白名单、事务钉住、超时
 * 都在 dbClientOp/适配器那层，与 SQL 编辑器执行同一条语句时完全一致。
 */
async function runScriptImport (a, task, exec) {
  const statements = normalizeStatements(a.statements)
  task.totalStatements = statements.length
  for (let i = 0; i < statements.length; i++) {
    if (task.cancelRequested) {
      // 止步于语句边界：已执行的保留（脚本自带事务时由脚本自己负责回滚）
      task.status = 'cancelled'
      return
    }
    task.statementNo = i + 1
    try {
      const res = await exec(statements[i])
      task.executedStatements++
      task.committedRows += affectedOf(res)
    } catch (e) {
      task.failedStatements++
      task.errors.push({ no: i + 1, message: e.message })
      throw new Error(`第 ${i + 1} 条语句失败，导入已停止：${e.message}`)
    }
    // 每条之间让出一次：取消请求最多晚一条语句生效，仍在语句边界止步
    if (i + 1 < statements.length) {
      await tick()
    }
  }
  task.status = 'done'
}

// ================================ 任务入口 ================================

async function runImport (a, task, exec) {
  const { getDbTabContext, dialectOf } = require('./db-client')
  const ctx = getDbTabContext(a.tabId)
  // 方言来自 db-client.dialectOf：expression 列要过 safe-clause 的词法闸门，
  // sqlite 传成 mysql 会按"反斜杠转义 + # 注释"判，与主进程执行时的那套规则不是同一个
  const dialect = dialectOf(ctx)
  const fmt = resolveFormat(a.filePath, a.format)
  task.format = fmt.id
  if (fmt.kind === 'script') {
    await runScriptImport(a, task, exec)
    return
  }
  await runRowImport(a, task, ctx, dialect, fmt)
}

function startImport (a) {
  const args = a || {}
  if (!args.tabId) {
    throw new Error('startImport requires tabId')
  }
  if (!args.filePath || typeof args.filePath !== 'string') {
    throw new Error('startImport requires filePath (from dbImportOp openFile)')
  }
  let fmt = null
  try {
    fmt = resolveFormat(args.filePath, args.format)
  } catch (e) {
    throw new Error('startImport 无法识别导入格式: ' + e.message)
  }
  // 脚本导入没有目标表（表名写在语句里）；行导入必须有表
  if (fmt.kind === 'script') {
    if (!Array.isArray(args.statements) || !args.statements.length) {
      throw new Error('startImport requires statements (split in renderer by db-sql-risk)')
    }
  } else if (!args.table) {
    throw new Error('startImport requires table')
  }
  const running = [...tasks.values()].filter(t => t.status === 'running').length
  if (running >= MAX_IMPORT_TASKS) {
    throw new Error(`导入任务已达上限 ${MAX_IMPORT_TASKS} 个，请等待或取消后再试`)
  }
  const importId = 'imp-' + Date.now() + '-' + (++importSeq)
  const task = {
    importId,
    status: 'running',
    format: fmt.id,
    committedRows: 0,
    failedBatches: 0,
    // 脚本通道专用：总条数 / 已执行 / 失败 / 当前进行到第几条
    totalStatements: 0,
    executedStatements: 0,
    failedStatements: 0,
    statementNo: 0,
    errors: [],
    done: false,
    cancelRequested: false,
    error: null,
    completedAt: null
  }
  tasks.set(importId, task)
  const { dbClientOp } = require('./db-client')
  const exec = sql => dbClientOp(args.tabId, 'executeSql', {
    sql,
    database: args.database
  })
  runImport(args, task, exec).then(
    () => {
      // 成功路径同样要打点：sweep 只清 done 的任务，漏打会让任务表随导入次数增长
      task.done = true
      task.completedAt = Date.now()
    },
    e => {
      log.error('[db-importer] failed', importId, e.message)
      task.status = 'failed'
      task.error = e.message
      task.done = true
      task.completedAt = Date.now()
    }
  )
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
    format: t.format,
    committedRows: t.committedRows,
    failedBatches: t.failedBatches,
    totalStatements: t.totalStatements,
    executedStatements: t.executedStatements,
    failedStatements: t.failedStatements,
    statementNo: t.statementNo,
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
  if (action === 'preview') {
    return previewImportFile(a.filePath, a)
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
  // 仅供单测：脚本通道的语句校验 / 影响行数汇总 / 逐条执行，行通道的分批提交
  runRowImport,
  runScriptImport,
  normalizeStatements,
  affectedOf,
  // 常量
  IMPORT_CHUNK_BYTES,
  MAX_IMPORT_TASKS,
  DEFAULT_BATCH_SIZE,
  MAX_SCRIPT_BYTES,
  MAX_IMPORT_STATEMENTS,
  DONE_TTL_MS
}
