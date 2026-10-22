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

// 浏览器端下载：Blob + a[download]，Electron 渲染层走默认下载流程
export function downloadCsv (filename, headers, rows) {
  const blob = new window.Blob([toCsv(headers, rows)], {
    type: 'text/csv;charset=utf-8'
  })
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
