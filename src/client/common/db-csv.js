/**
 * CSV 生成与下载（数据库页 S3-B，设计见 doc/设计-数据库阶段3-2026-10-22.md）
 * 只导出"当前可见结果集"（网格当前页含 T1 过滤结果 / SQL 单个结果集），
 * 全表流式导出属二期独立项。
 * 格式：RFC 4180 —— 含 , " 换行回车的字段双引号包裹、内部 " 翻倍；
 * 文件头写 BOM（\uFEFF）保证 Excel/LibreOffice 打开中文不乱码；行间 \r\n。
 */

// 单字段转义：null/undefined 输出空串，其余 String() 化后按需包裹
export function csvEscape (v) {
  if (v === null || v === undefined) {
    return ''
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
      return clean(v === null || v === undefined ? '' : v)
    }).join('\t'))
  }
  return lines.join('\n')
}

// 行集合 → 文本：kind = insert / update / json / tsv
// 列顺序与取值均以 headers 为准（过滤 __rowKey 等辅助键）；
// update 依赖 pkColumn 定位（无主键返回空串，UI 侧禁用入口）
export function buildCopyStatements (kind, { table, headers, rows, pkColumn, quote = 'backtick' }) {
  const heads = Array.isArray(headers) ? headers : []
  const list = Array.isArray(rows) ? rows : []
  if (kind === 'json') {
    const plain = list.map(r => {
      const o = {}
      heads.forEach(h => {
        o[h] = r && r[h] !== undefined ? r[h] : null
      })
      return o
    })
    return JSON.stringify(plain, null, 2)
  }
  if (kind === 'tsv') {
    return toTsv(heads, list)
  }
  const q = n => sqlQuoteIdent(n, quote)
  const lines = []
  for (const row of list) {
    const val = h => sqlQuoteVal(row ? row[h] : null, quote)
    if (kind === 'insert') {
      const cols = heads.map(q).join(', ')
      const vals = heads.map(val).join(', ')
      lines.push(`INSERT INTO ${q(table)} (${cols}) VALUES (${vals});`)
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
      lines.push(`UPDATE ${q(table)} SET ${sets} WHERE ${q(pkColumn)} = ${val(pkColumn)};`)
    }
  }
  return lines.join('\n')
}
