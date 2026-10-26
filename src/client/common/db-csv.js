/**
 * CSV 生成与下载（数据库页 S3-B，设计见 doc/设计-数据库阶段3-2026-10-22.md）
 * 只导出"当前可见结果集"（网格当前页含 T1 过滤结果 / SQL 单个结果集），
 * 全表流式导出属二期独立项。
 * 格式：RFC 4180 —— 含 , " 换行回车的字段双引号包裹、内部 " 翻倍；
 * 文件头写 BOM（\uFEFF）保证 Excel/LibreOffice 打开中文不乱码；行间 \r\n。
 */

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

// 标识符引用：mysql/tidb/oceanbase 反引号，pg 双引号（quote='double'）
export function sqlQuoteIdent (name, quote) {
  const s = String(name)
  return quote === 'double'
    ? '"' + s.replace(/"/g, '') + '"'
    : '`' + s.replace(/`/g, '') + '`'
}

// 值字面量：null→NULL；number/boolean/bigint 原样；Date→ISO 字符串；
// 字符串单引号包裹，内部 ' 翻倍，mysql 系（非 'double'）额外 \ 翻倍
export function sqlQuoteVal (v, quote) {
  if (v === null || v === undefined) {
    return 'NULL'
  }
  if (isBinEnvelope(v)) {
    // 二进制列：小字段用十六进制字面量（mysql X'..' / pg '\x..'）尽量可写回；
    // 截断的大字段无法无损还原，显式抛错，不让复制 SQL 静默写出残缺数据。
    const bin = v.__bin
    if (bin.truncated) {
      throw new Error(
        `含二进制大字段（${bin.size} 字节，已截断），请用 SQL 模式导出`
      )
    }
    const hex = Buffer.from(bin.b64, 'base64').toString('hex')
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
  if (quote !== 'double') {
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
