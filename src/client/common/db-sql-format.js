// A3 SQL 格式化（数据库页 SQL 编辑器，设计 §7.5）
// 轻量 tokenizer：跳过字符串/反引号/双引号/注释字面量，关键字大写、
// 主子句前换行、子句内片段 2 空格缩进。仅辅助阅读，不保证语义等价的极端场景。

// 主子句：出现时换行顶格
const MAJOR = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT',
  'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'UNION ALL', 'UNION', 'CREATE TABLE', 'CREATE VIEW', 'ALTER TABLE',
  'DROP TABLE', 'TRUNCATE TABLE'
]

// 关键字大小写表：多词主子句 + 常见单词（IN/AS/AND/OR/NOT NULL/...）
const KEYWORDS = [
  ...MAJOR,
  'AND', 'OR', 'NOT', 'NULL', 'IN', 'AS', 'ASC', 'DESC', 'DISTINCT',
  'BETWEEN', 'LIKE', 'EXISTS', 'IS', 'BY', 'ON', 'ALL', 'ANY', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'JOIN'
]

// 词元切分：字符串、反引号标识符、双引号标识符、行注释、块注释、词、其余单字符
function tokenize (sql) {
  const tokens = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    // 字符串/标识符字面量：整体保留原样
    if (ch === "'" || ch === '`' || ch === '"') {
      let j = i + 1
      while (j < n) {
        // 单引号翻倍转义（''）、反引号/双引号翻倍转义
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2
            continue
          }
          break
        }
        // 反斜杠转义（mysql 字符串）
        if (ch === "'" && sql[j] === '\\') {
          j += 2
          continue
        }
        j++
      }
      tokens.push({ t: 'lit', v: sql.slice(i, j + 1) })
      i = j + 1
      continue
    }
    // 行注释 -- 与 #（mysql）：作为 lit 原样输出（内部含换行）
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      let j = sql.indexOf('\n', i)
      j = j === -1 ? n : j
      tokens.push({ t: 'lit', v: sql.slice(i, j) })
      i = j
      continue
    }
    // 块注释
    if (ch === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i + 2)
      j = j === -1 ? n : j + 2
      tokens.push({ t: 'lit', v: sql.slice(i, j) })
      i = j
      continue
    }
    // 空白归并为一个 ws 词元
    if (/\s/.test(ch)) {
      let j = i
      while (j < n && /\s/.test(sql[j])) {
        j++
      }
      tokens.push({ t: 'ws', v: ' ' })
      i = j
      continue
    }
    // 词（字母数字下划线 $）
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) {
        j++
      }
      tokens.push({ t: 'word', v: sql.slice(i, j) })
      i = j
      continue
    }
    // 其余（括号/逗号/运算符）单字符
    tokens.push({ t: 'sym', v: ch })
    i++
  }
  return tokens
}

export function formatSql (sql) {
  const src = String(sql || '').trim()
  if (!src) {
    return ''
  }
  const tokens = tokenize(src)
  const out = []
  let indent = ''
  // 输出末尾字符（跳过空元素），用于决定词间是否补空格
  const tail = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const s = out[k]
      if (s.length) {
        return s[s.length - 1]
      }
    }
    return ''
  }
  // '(' 与 '.' 之后紧贴；换行/空格后不再补空格
  const needSpace = () => {
    const t = tail()
    return !!t && t !== '\n' && t !== ' ' && t !== '(' && t !== '.'
  }

  const isMajorHere = (idx) => {
    // 从当前 word 起尝试匹配多词主子句（如 GROUP BY）
    const w0 = tokens[idx]
    if (!w0 || w0.t !== 'word') {
      return null
    }
    const up0 = w0.v.toUpperCase()
    // 单词主子句
    if (MAJOR.includes(up0)) {
      return up0
    }
    // 两词主子句
    const w1 = tokens[idx + 2] // 跳过 ws
    if (w1 && w1.t === 'word') {
      const two = up0 + ' ' + w1.v.toUpperCase()
      if (MAJOR.includes(two)) {
        return two
      }
    }
    return null
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const tk = tokens[idx]
    if (tk.t === 'ws') {
      // 空白词元在输出时按需重建（逗号后换行 / 词间单空格），跳过
      continue
    }

    if (tk.t === 'sym' && tk.v === ',') {
      // 逗号后换行保持缩进（列表纵向对齐）
      out.push(',\n' + indent)
      continue
    }
    if (tk.t === 'sym' && tk.v === ')') {
      indent = indent.slice(2)
      // 闭合括号前去掉可能残留的换行缩进
      const last = out[out.length - 1] || ''
      if (/\n[ ]*$/.test(last)) {
        out[out.length - 1] = last.replace(/\n[ ]*$/, '')
      }
      out.push(')')
      continue
    }
    if (tk.t === 'sym' && tk.v === '(') {
      indent += '  '
      out.push(needSpace() ? ' (' : '(')
      continue
    }
    if (tk.t === 'sym' && tk.v === '.') {
      // 点号紧贴：a.id
      out.push('.')
      continue
    }
    if (tk.t === 'sym') {
      // 分号紧贴前词；其余运算符前后留空格（'(' 后紧贴）
      const t = tail()
      out.push(tk.v === ';' || t === '(' ? tk.v : ' ' + tk.v)
      continue
    }
    if (tk.t === 'word') {
      const major = isMajorHere(idx)
      if (major) {
        // 主子句顶格换行
        if (out.length) {
          out.push('\n')
        }
        indent = ''
        // 多词主子句一并处理第二个词
        const parts = major.split(' ')
        out.push(parts[0])
        if (parts[1]) {
          out.push(' ' + parts[1])
          idx += 2 // 跳过 ws + 第二个 word
        }
        continue
      }
      const up = tk.v.toUpperCase()
      out.push(needSpace() ? ' ' + (KEYWORDS.includes(up) ? up : tk.v) : (KEYWORDS.includes(up) ? up : tk.v))
      continue
    }
    // lit：字符串/标识符字面量原样
    out.push(needSpace() ? ' ' + tk.v : tk.v)
  }

  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim()
}
