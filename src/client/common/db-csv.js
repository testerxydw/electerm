/**
 * CSV 生成与下载（数据库页 S3-B，设计见 doc/已完成/设计-数据库阶段3-2026-10-22--已完成.md）
 * 只导出"当前可见结果集"（网格当前页含 T1 过滤结果 / SQL 单个结果集），
 * 全表流式导出属二期独立项。
 * 格式：RFC 4180 —— 含 , " 换行回车的字段双引号包裹、内部 " 翻倍；
 * 文件头写 BOM（\uFEFF）保证 Excel/LibreOffice 打开中文不乱码；行间 \r\n。
 */

import { isPgFamily, isSqliteFamily } from './db-engine-family.js'

// 识别 F3 二进制信封（src/app/lib/db-client/{mysql,postgres}.js 的 binEnvelope 输出）。
// 仅当结构严格匹配才认作信封，避免与业务里恰好带 __bin 键的普通对象混淆。
export function isBinEnvelope (v) {
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

// 单字段转义：null/undefined 输出空串，其余 String() 化后按需包裹
export function csvEscape (v) {
  if (v === null || v === undefined) {
    return ''
  }
  if (isBinEnvelope(v)) {
    const bin = v.__bin
    if (bin.truncated) {
      // 截断的二进制不能导出残缺数据：宁可让整个导出失败，
      // 也比静默写出"看起来完整其实被截"的文件安全。
      throw new Error(
        `含二进制大字段（${bin.size} 字节，已截断），请用 SQL 模式导出`
      )
    }
    return bin.b64
  }
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// headers 决定列顺序；rows 为对象数组（键与 headers 对应）
export function toCsv (headers, rows) {
  const heads = Array.isArray(headers) ? headers : []
  const lines = [heads.map(csvEscape).join(',')]
  for (const row of (rows || [])) {
    lines.push(heads.map(h => csvEscape(row ? row[h] : '')).join(','))
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

// 通用文本下载（A4）：CSV/JSON/SQL 导出共用
export function downloadText (filename, mime, text) {
  const blob = new window.Blob([text], { type: mime })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 释放 URL：延迟给下载进程留读取窗口
  setTimeout(() => window.URL.revokeObjectURL(url), 3000)
}

// 浏览器端下载：Blob + a[download]，Electron 渲染层走默认下载流程
export function downloadCsv (filename, headers, rows) {
  downloadText(filename, 'text/csv;charset=utf-8', toCsv(headers, rows))
}

// ---- A1 复制为 SQL/JSON/TSV（数据库页，设计 §7.2）----
// 仅辅助用途文本：值转义单引号翻倍，mysql 系反斜杠翻倍；不做隐式可信声明

// 引用符口径（H8a 起三种）：
//   backtick —— mysql 家族：反引号标识符，字符串里 `\` 是转义符所以要加倍；
//   double   —— pg 家族：双引号标识符，二进制用 '\x..' 十六进制串；
//   sqlite   —— 双引号标识符 + X'hex' 二进制串（SQLite 两者都支持），
//               且**不**加倍反斜杠：SQLite 的字符串字面量里 `\` 就是普通字符，
//               加倍会把复制出来的 INSERT 值变成另一个值。
export function sqlQuoteModeOf (dbType) {
  // 收的是 tab.dbType（引擎名，不是归一后的方言），所以必须走家族表：
  // PG 兼容引擎落到 backtick，导出的 INSERT 在目标库上是语法错误
  if (isPgFamily(dbType)) {
    return 'double'
  }
  return isSqliteFamily(dbType) ? 'sqlite' : 'backtick'
}

// 标识符引用：mysql 家族反引号，pg 家族与 sqlite 双引号（quote='double'/'sqlite'）
export function sqlQuoteIdent (name, quote) {
  const s = String(name)
  return quote === 'double' || quote === 'sqlite'
    ? '"' + s.replace(/"/g, '') + '"'
    : '`' + s.replace(/`/g, '') + '`'
}

// 值字面量：null→NULL；number/boolean/bigint 原样；Date→ISO 字符串；
// 字符串单引号包裹，内部 ' 翻倍，mysql 系（既不是 'double' 也不是 'sqlite'）额外 \ 翻倍
export function sqlQuoteVal (v, quote) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    // 二进制列：小字段用十六进制字面量（mysql/sqlite X'..' / pg '\x..'）尽量可写回；
    // 截断的大字段无法无损还原，显式抛错，不让复制 SQL 静默写出残缺数据。
    const bin = v.__bin
    if (bin.truncated) {
      throw new Error(
        `含二进制大字段（${bin.size} 字节，已截断），请用 SQL 模式导出`
      )
    }
    // 渲染进程没有 Buffer（nodeIntegration 关闭），base64 只能用 atob 解
    const bin64 = atob(bin.b64)
    let hex = ''
    for (let i = 0; i < bin64.length; i++) {
      const h = bin64.charCodeAt(i).toString(16)
      hex += h.length < 2 ? '0' + h : h
    }
    return quote === 'double' ? `'\\x${hex}'` : `X'${hex}'`
  }
  const t = typeof v
  if (t === 'number' || t === 'boolean' || t === 'bigint') {
    return String(v)
  }
  let s = Object.prototype.toString.call(v) === '[object Date]'
    ? v.toISOString()
    : String(v)
  s = s.replace(/'/g, "''")
  if (quote !== 'double' && quote !== 'sqlite') {
    s = s.replace(/\\/g, '\\\\')
  }
  return "'" + s + "'"
}

// TSV：\t 分隔（值内制表/换行替换为空格），首行列名，null → 空串，贴表格软件
export function toTsv (headers, rows) {
  const clean = s => String(s).replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ')
  const heads = Array.isArray(headers) ? headers : []
  const lines = [heads.map(h => clean(h)).join('\t')]
  for (const row of (rows || [])) {
    lines.push(heads.map(h => {
      const v = row ? row[h] : ''
      if (v === null || v === undefined) {
        return ''
      }
      if (isBinEnvelope(v)) {
        return `<binary ${v.__bin.size} bytes>`
      }
      return clean(v)
    }).join('\t'))
  }
  return lines.join('\n')
}

// JSONL（ndjson）：每行一个独立的 JSON 对象，流式工具（jq/Spark/日志管道）逐行可读。
// 列序与取值以 headers 为准（顺带滤掉 __rowKey 这类辅助键）；
// 二进制信封不进 JSON —— 直接序列化会暴露 b64 信封结构，被误当成完整数据
export function toJsonl (headers, rows) {
  const heads = Array.isArray(headers) ? headers : []
  const lines = []
  for (const row of (rows || [])) {
    const o = {}
    heads.forEach(h => {
      const v = row && row[h] !== undefined ? row[h] : null
      o[h] = isBinEnvelope(v) ? `<binary ${v.__bin.size} bytes>` : v
    })
    lines.push(JSON.stringify(o))
  }
  return lines.join('\n')
}

// Markdown 表格：表头行 + 分隔行 + 数据行。单元格里竖线、换行、反引号必须转义，
// 否则一列长文本就能把整张表的结构撑破；二进制信封显示占位串
export function toMarkdownTable (headers, rows) {
  const clean = s => String(s)
    .replace(/\|/g, '\\|')
    .replace(/\r\n/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\r/g, '<br>')
    .replace(/`/g, '\\`')
  const heads = Array.isArray(headers) ? headers : []
  const cell = v => {
    if (v === null || v === undefined) {
      return ''
    }
    if (isBinEnvelope(v)) {
      return `<binary ${v.__bin.size} bytes>`
    }
    return clean(v)
  }
  const line = cells => `| ${cells.join(' | ')} |`
  const lines = [
    line(heads.map(clean)),
    line(heads.map(() => '---')),
    ...((rows || []).map(row => line(heads.map(h => cell(row ? row[h] : null)))))
  ]
  return lines.join('\n')
}

// 行集合 → 文本：kind = insert / update / json / tsv
// 列顺序与取值均以 headers 为准（过滤 __rowKey 等辅助键）；
// update 依赖 pkColumn 定位（无主键返回空串，UI 侧禁用入口）；
// database 非空时表名带库限定（db.table）——连接无默认库时裸表名会报 No database selected
export function buildCopyStatements (kind, { table, database, headers, rows, pkColumn, quote = 'backtick' }) {
  const heads = Array.isArray(headers) ? headers : []
  const list = Array.isArray(rows) ? rows : []
  if (kind === 'json') {
    const plain = list.map(r => {
      const o = {}
      heads.forEach(h => {
        const v = r && r[h] !== undefined ? r[h] : null
        // 二进制信封直接序列化会暴露 b64 前缀，易误以为是完整数据；
        // 改成明确的提示串，不泄露也不误导。
        o[h] = isBinEnvelope(v) ? `<binary ${v.__bin.size} bytes>` : v
      })
      return o
    })
    return JSON.stringify(plain, null, 2)
  }
  if (kind === 'tsv') {
    return toTsv(heads, list)
  }
  const q = n => sqlQuoteIdent(n, quote)
  const target = database ? `${q(database)}.${q(table)}` : q(table)
  const lines = []
  for (const row of list) {
    const val = h => sqlQuoteVal(row ? row[h] : null, quote)
    if (kind === 'insert') {
      const cols = heads.map(q).join(', ')
      const vals = heads.map(val).join(', ')
      lines.push(`INSERT INTO ${target} (${cols}) VALUES (${vals});`)
    } else if (kind === 'update') {
      if (!pkColumn) {
        continue
      }
      const sets = heads
        .filter(h => h !== pkColumn)
        .map(h => `${q(h)} = ${val(h)}`)
        .join(', ')
      if (!sets) {
        continue
      }
      lines.push(`UPDATE ${target} SET ${sets} WHERE ${q(pkColumn)} = ${val(pkColumn)};`)
    }
  }
  return lines.join('\n')
}
