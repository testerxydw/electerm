/**
 * 数据库流式导出（C 批，设计 §10）
 *
 * 为什么不一次 SELECT *：几十万行的结果集会把主进程内存打爆，也没法在 IPC 上
 * 一次传给渲染层。这里按页（1000 行）循环取数、逐块写盘，全程只有一页数据驻留内存。
 *
 * 为什么复用 dbClientOp('getPageData') 而不是直连适配器：
 * dbClientOp 里挂着 E2 条件体/排序的列白名单校验（渲染层传参不可信），
 * 导出的 where 与页面浏览走同一道闸，避免出现"页面上被拒的条件导出时放行"。
 *
 * 稳定性：有主键时把主键列追加进 orderClauses（无主键不排序——分页导出在无
 * ORDER BY 时不保证行序，可能重/漏行；主键排序是导出能对账的前提，无主键表的
 * 风险提示属 UI 层职责）。用户排序列与主键合计受适配器 MAX_ORDER_COLUMNS=3
 * 硬上限约束：排序列已满 3 个时主键补不进去，退化为用户序，可接受。
 *
 * __bin 信封（F3）：非截断信封按 base64 写入 csv/tsv/markdown，json/jsonl 保留
 * 信封对象，sql 按 X'hex' / '\xhex' 输出；截断信封只有前缀，任何格式都不冒充
 * 完整数据 —— 文本格式输出显式标记（见 binCell / sqlQuoteVal 注释）。
 *
 * 取消/失败：块边界检查取消位；单块失败整体 failed；两种情况都保留已写文件
 * （取消后文件保留到块边界），收尾仍写格式尾巴（json 闭合数组 / sql 恢复外键
 * 开关），保证半截文件也是可解析的。
 */

const log = require('../common/log')

// 单页行数：与 OP_TIMEOUTS.getPageData(60s) 匹配；太小则大表导出往返次数成倍增加，
// 太大则单块内存与单次查询超时压力上升
const EXPORT_PAGE_SIZE = 1000
// 并发任务上限：导出吃同一个连接池（connectionLimit 4），任务再多也只是排队，
// 不如一开始就拒绝并让用户等待/取消
const MAX_RUNNING_EXPORTS = 4
// 完成任务保留时长：前端轮询 status 可能晚于任务结束，立即删除会报 unknown；
// 过期记录由 sweepDoneTasks 在 status 查询时惰性清理，不为清理单独挂定时器
const DONE_TTL_MS = 5 * 60 * 1000

const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'sql', 'markdown']

// 任务表：exportId → task（done 记录保留 DONE_TTL_MS 供查询，之后惰性清除）
const tasks = new Map()
let exportSeq = 0

// ---- F3 二进制信封判定与展示（与渲染层 db-csv.js 口径一致；那份是 ESM，
// ---- 主进程不能 require，改动时两边同步） ----

function isBinEnvelope (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return false
  }
  if (!('__bin' in v)) {
    return false
  }
  const bin = v.__bin
  return !!bin && typeof bin === 'object' &&
    typeof bin.size === 'number' && typeof bin.b64 === 'string' &&
    typeof bin.truncated === 'boolean'
}

// 信封 → 单元格文本：未截断给全量 base64（导出不丢数据）；
// 截断信封只有前缀，写成显式标记而不是 b64 前缀——静默导出残缺数据
// 比明确告知"这格没导全"危险得多（用户拿去做备份就是坏备份）
function binCell (v) {
  if (v === null || v === undefined) {
    return ''
  }
  if (isBinEnvelope(v)) {
    const bin = v.__bin
    return bin.truncated ? `<binary ${bin.size} bytes, truncated>` : bin.b64
  }
  return String(v)
}

// ---- 格式化纯函数（导出仅供单测；与 db-csv.js 转义规则对齐，RFC 4180） ----

// 单字段 CSV 转义：含 , " \r \n 包裹双引号、内部 " 翻倍；信封先转单元格文本
function csvEscapeField (v) {
  const s = binCell(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// TSV 是给人看的贴表格式：值内制表/换行压成空格，信封同 binCell
function tsvCell (v) {
  return binCell(v).replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ')
}

// markdown 表格单元格：竖线转义（表格定界符）、换行压成空格（表格内不允许裸换行）
function mdCell (v) {
  return binCell(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

// 标识符引用：mysql 系反引号，pg 双引号（与 db-csv.sqlQuoteIdent 口径一致）
function sqlQuoteIdent (name, dialect) {
  const s = String(name)
  return dialect === 'postgres'
    ? '"' + s.replace(/"/g, '') + '"'
    : '`' + s.replace(/`/g, '') + '`'
}

// 值字面量：null→NULL；number/boolean/bigint 原样；Date→ISO；字符串 ' 翻倍，
// mysql 系额外 \ 翻倍；信封 → X'hex'（mysql）/ '\xhex'（pg）。
// 字符串里的分号在引号内是普通数据（' 翻倍后不可能提前闭合字面量），
// 生成的 .sql 按字面 SQL 执行时不会被打断成多条 —— 这就是"分号转义"的落地方式。
// 截断信封：没有完整字节，输出显式标记字符串（与 binCell 同理由），不输出残缺 hex。
function sqlQuoteVal (v, dialect) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    const bin = v.__bin
    if (bin.truncated) {
      return `'<binary ${bin.size} bytes, truncated>'`
    }
    const hex = Buffer.from(bin.b64, 'base64').toString('hex')
    return dialect === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`
  }
  const t = typeof v
  if (t === 'number' || t === 'boolean' || t === 'bigint') {
    return String(v)
  }
  let s = Object.prototype.toString.call(v) === '[object Date]'
    ? v.toISOString()
    : String(v)
  s = s.replace(/'/g, "''")
  if (dialect !== 'postgres') {
    s = s.replace(/\\/g, '\\\\')
  }
  return "'" + s + "'"
}

// dump 头尾：FOREIGN_KEY_CHECKS 让含外键的数据可以乱序导入。
// pg 没有会话级外键开关（SET CONSTRAINTS 只对 DEFERRABLE 约束生效），
// 照抄会让 dump 在 pg 上第一句就报语法错：pg 输出空头尾。
function sqlHeader (dialect) {
  return dialect === 'postgres' ? '' : 'SET FOREIGN_KEY_CHECKS=0;\n'
}

function sqlTail (dialect) {
  return dialect === 'postgres' ? '' : 'SET FOREIGN_KEY_CHECKS=1;\n'
}

function fullTableName ({ database, schema, table }, dialect) {
  const q = n => sqlQuoteIdent(n, dialect)
  return dialect === 'postgres'
    ? q(schema || 'public') + '.' + q(table)
    : (database ? q(database) + '.' + q(table) : q(table))
}

function rowToInsertSql ({ fullTable, headers, row, dialect }) {
  const cols = headers.map(h => sqlQuoteIdent(h, dialect)).join(', ')
  const vals = headers.map(h => sqlQuoteVal(row ? row[h] : null, dialect)).join(', ')
  return `INSERT INTO ${fullTable} (${cols}) VALUES (${vals});`
}

// json/jsonl 行投影：以 headers 为准（列序稳定，隐藏列不导出），缺列补 null；
// 信封对象原样保留（json 消费方需要 size/truncated 元信息）
function projectRow (row, headers) {
  const o = {}
  headers.forEach(h => {
    o[h] = row && row[h] !== undefined ? row[h] : null
  })
  return o
}

// 每种格式的 头 / 行块 / 尾。json 特殊：'[\n' 头 + 行间 ',\n' + '\n]' 尾；
// 零行时 '[\n' + '\n]' 仍是合法空数组。所有块都以换行收尾，跨块拼接即整文件。
function formatWriters (format, dialect, { fullTable, headers }) {
  if (format === 'csv') {
    return {
      header: () => '\uFEFF' + headers.map(h => csvEscapeField(h)).join(',') + '\r\n',
      chunk: rows => rows
        .map(r => headers.map(h => csvEscapeField(r ? r[h] : null)).join(','))
        .join('\r\n') + '\r\n',
      tail: () => ''
    }
  }
  if (format === 'tsv') {
    return {
      header: () => headers.map(h => tsvCell(h)).join('\t') + '\n',
      chunk: rows => rows
        .map(r => headers.map(h => tsvCell(r ? r[h] : null)).join('\t'))
        .join('\n') + '\n',
      tail: () => ''
    }
  }
  if (format === 'json') {
    return {
      header: () => '[\n',
      chunk: (rows, first) => (first ? '' : ',\n') +
        rows.map(r => JSON.stringify(projectRow(r, headers))).join(',\n'),
      tail: () => '\n]'
    }
  }
  if (format === 'jsonl') {
    return {
      header: () => '',
      chunk: rows => rows
        .map(r => JSON.stringify(projectRow(r, headers)))
        .join('\n') + '\n',
      tail: () => ''
    }
  }
  if (format === 'sql') {
    return {
      header: () => sqlHeader(dialect),
      chunk: rows => rows
        .map(r => rowToInsertSql({ fullTable, headers, row: r, dialect }))
        .join('\n') + '\n',
      tail: () => sqlTail(dialect)
    }
  }
  // markdown
  return {
    header: () => '| ' + headers.map(h => mdCell(h)).join(' | ') + ' |\n' +
      '| ' + headers.map(() => '---').join(' | ') + ' |\n',
    chunk: rows => rows
      .map(r => '| ' + headers.map(h => mdCell(r ? r[h] : null)).join(' | ') + ' |')
      .join('\n') + '\n',
    tail: () => ''
  }
}

// ---- 任务状态机 ----

function newTask (exportId, filePath) {
  return {
    exportId,
    status: 'running',
    rowsWritten: 0,
    bytes: 0,
    filePath,
    error: null,
    cancelRequested: false,
    done: false,
    completedAt: null
  }
}

async function writeChunk (task, stream, text) {
  if (!text) {
    return
  }
  if (!stream.write(text)) {
    // 背压：内核缓冲区满时等 drain，避免大导出把主进程内存顶爆
    await new Promise(resolve => stream.once('drain', resolve))
  }
  task.bytes = stream.bytesWritten
}

function streamEnd (stream) {
  return new Promise(resolve => {
    if (stream.writableEnded) {
      resolve()
      return
    }
    stream.once('finish', resolve)
    stream.end()
  })
}

async function runExport (task, tabId, args) {
  const fs = require('fs')
  const { dbClientOp, getDbTabContext } = require('./db-client')
  const stream = fs.createWriteStream(args.targetPath, { flags: 'w' })
  // error 处理器必须先挂：写盘失败的 error 事件没人接会直接打崩主进程
  let streamError = null
  stream.on('error', e => {
    streamError = e
  })
  try {
    const ctx = getDbTabContext(tabId)
    const dialect = ctx.dbType === 'postgres' ? 'postgres' : 'mysql'
    // 表结构：主键排序 + 列序。拿不到不致命（降级：无 pk 排序、表头取首行键）
    let structure = null
    try {
      structure = await dbClientOp(tabId, 'getTableStructure', {
        database: args.database,
        schema: args.schema,
        table: args.table
      })
    } catch (e) {
      log.warn('[db-exporter] structure unavailable, no pk ordering:', args.table, e.message)
    }
    const columns = ((structure && structure.columns) || [])
      .map(c => c && c.name)
      .filter(n => typeof n === 'string' && n)
    const orderClauses = Array.isArray(args.orderClauses) ? args.orderClauses.slice() : []
    const pkCols = ((structure && structure.columns) || [])
      .filter(c => c && c.isPrimaryKey)
      .map(c => c.name)
    if (pkCols.length) {
      const ordered = new Set(orderClauses.map(o => o && o.column).filter(Boolean))
      for (const pk of pkCols) {
        if (orderClauses.length >= 3) {
          break
        }
        if (!ordered.has(pk)) {
          orderClauses.push({ column: pk, desc: false })
        }
      }
    }
    const baseArgs = {
      database: args.database,
      schema: args.schema,
      table: args.table,
      where: typeof args.where === 'string' ? args.where : undefined,
      whereParams: Array.isArray(args.whereParams) ? args.whereParams : undefined,
      orderClauses: orderClauses.length ? orderClauses : undefined
    }
    // 列序：显式 columns（结构内的子集）→ 结构列序 → 首行键（结构拿不到时）
    let headers = null
    if (Array.isArray(args.columns) && args.columns.length) {
      headers = columns.length ? args.columns.filter(h => columns.includes(h)) : args.columns.map(String)
      if (!headers.length) {
        headers = null
      }
    }
    if (!headers && columns.length) {
      headers = columns
    }
    let writer = null
    if (headers) {
      writer = formatWriters(args.format, dialect, {
        fullTable: fullTableName(args, dialect), headers
      })
      await writeChunk(task, stream, writer.header())
    }
    let page = 1
    let firstChunk = true
    while (true) {
      if (task.cancelRequested || streamError) {
        break
      }
      const res = await dbClientOp(tabId, 'getPageData', { ...baseArgs, page, pageSize: EXPORT_PAGE_SIZE })
      const rows = (res && res.rows) || []
      if (!rows.length) {
        break
      }
      if (!headers) {
        headers = Object.keys(rows[0])
        writer = formatWriters(args.format, dialect, {
          fullTable: fullTableName(args, dialect), headers
        })
        await writeChunk(task, stream, writer.header())
      }
      if (task.cancelRequested || streamError) {
        break
      }
      await writeChunk(task, stream, writer.chunk(rows, firstChunk))
      firstChunk = false
      task.rowsWritten += rows.length
      const hasMore = res.hasMore === true ||
        (res.hasMore === undefined && rows.length >= EXPORT_PAGE_SIZE)
      if (!hasMore) {
        break
      }
      page++
    }
    // 收尾（取消/失败也要）：json 闭合数组、sql 恢复外键开关，半截文件保持可解析
    if (writer) {
      await writeChunk(task, stream, writer.tail())
    }
    if (streamError) {
      throw streamError
    }
    await streamEnd(stream)
    if (streamError) {
      throw streamError
    }
    task.status = task.cancelRequested ? 'cancelled' : 'done'
  } catch (e) {
    task.status = 'failed'
    task.error = e.message
    log.error('[db-exporter] failed', task.exportId, e.message)
  } finally {
    task.done = true
    task.completedAt = Date.now()
    if (!stream.destroyed && !stream.writableEnded) {
      stream.end()
    }
  }
}

function startExport (tabId, args) {
  const a = args || {}
  if (!tabId) {
    throw new Error('startExport requires tabId')
  }
  if (!a.table) {
    throw new Error('startExport requires table')
  }
  if (!FORMATS.includes(a.format)) {
    throw new Error('unsupported export format: ' + a.format +
      ' (expected one of ' + FORMATS.join('/') + ')')
  }
  if (!a.targetPath || typeof a.targetPath !== 'string') {
    throw new Error('startExport requires targetPath')
  }
  if (Array.isArray(a.tables)) {
    // C-11：多表导出由前端逐表发起（任务表并发天然支持），本期不做单任务多表
    throw new Error('multi-table export not supported yet, start one task per table')
  }
  const running = [...tasks.values()].filter(t => t.status === 'running').length
  if (running >= MAX_RUNNING_EXPORTS) {
    throw new Error(`导出任务已达上限 ${MAX_RUNNING_EXPORTS} 个，请等待或取消后再试`)
  }
  const exportId = 'exp-' + Date.now() + '-' + (++exportSeq)
  const task = newTask(exportId, a.targetPath)
  tasks.set(exportId, task)
  runExport(task, tabId, a).catch(e => {
    // runExport 内部已兜底转 failed，这里是最后的保险丝（防漏接的 promise 拒绝）
    log.error('[db-exporter] unexpected failure', exportId, e.message)
    task.status = 'failed'
    task.error = e.message
    task.done = true
    task.completedAt = Date.now()
  })
  return { exportId }
}

function exportStatus (exportId) {
  sweepDoneTasks(Date.now())
  const t = tasks.get(exportId)
  if (!t) {
    throw new Error('unknown exportId: ' + exportId)
  }
  return {
    exportId: t.exportId,
    status: t.status,
    rowsWritten: t.rowsWritten,
    bytes: t.bytes,
    filePath: t.filePath,
    error: t.error
  }
}

function cancelExport (exportId) {
  const t = tasks.get(exportId)
  if (!t) {
    throw new Error('unknown exportId: ' + exportId)
  }
  if (t.status === 'running') {
    t.cancelRequested = true
  }
  return { ok: true, status: t.status }
}

// 惰性清理：status 查询时顺手执行；now 由调用方传入
// （生产 Date.now()，单测传未来时刻触发过期，避免真实等待 TTL）
function sweepDoneTasks (now = Date.now()) {
  for (const [id, t] of tasks) {
    if (t.done && t.completedAt !== null && now - t.completedAt > DONE_TTL_MS) {
      tasks.delete(id)
    }
  }
}

function dbExportOp (action, arg) {
  const a = arg || {}
  if (action === 'start') {
    return startExport(a.tabId, a)
  }
  if (action === 'status') {
    return exportStatus(a.exportId)
  }
  if (action === 'cancel') {
    return cancelExport(a.exportId)
  }
  throw new Error('unknown dbExportOp action: ' + action)
}

module.exports = {
  dbExportOp,
  startExport,
  exportStatus,
  cancelExport,
  sweepDoneTasks,
  // 常量（单测/前端提示用）
  FORMATS,
  EXPORT_PAGE_SIZE,
  MAX_RUNNING_EXPORTS,
  DONE_TTL_MS,
  // 纯函数导出仅供单测（格式化器 / 信封展示 / dump 头尾）
  isBinEnvelope,
  binCell,
  csvEscapeField,
  tsvCell,
  mdCell,
  sqlQuoteIdent,
  sqlQuoteVal,
  sqlHeader,
  sqlTail,
  fullTableName,
  rowToInsertSql,
  projectRow,
  formatWriters
}
