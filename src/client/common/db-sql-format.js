// A3 SQL 格式化（数据库页 SQL 编辑器，设计 §7.5）
// 轻量 tokenizer：跳过字符串/反引号/双引号/注释字面量，关键字大写、
// 主子句前换行、子句内片段 2 空格缩进。仅辅助阅读，不保证语义等价的极端场景。
// N12e：嵌套结构缩进规则化——主子句在括号内（子查询/CTE/窗口）保留缩进层级；
// 最内层"简单块"（IN 列表/函数参数/VALUES 元组/短列清单）折叠回单行。

// 主子句：出现时换行（顶层顶格、括号内按层级缩进）
const MAJOR = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT',
  'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'UNION ALL', 'UNION', 'CREATE TABLE', 'CREATE VIEW', 'ALTER TABLE',
  'DROP TABLE', 'TRUNCATE TABLE',
  // N12e：CTE 与窗口函数的两根支架
  'WITH', 'PARTITION BY'
]

// 关键字大小写表：多词主子句 + 常见单词（IN/AS/AND/OR/NOT NULL/...）
const KEYWORDS = [
  ...MAJOR,
  'AND', 'OR', 'NOT', 'NULL', 'IN', 'AS', 'ASC', 'DESC', 'DISTINCT',
  'BETWEEN', 'LIKE', 'EXISTS', 'IS', 'BY', 'ON', 'ALL', 'ANY', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'JOIN', 'OVER'
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

// N12e：最内层"简单块"折叠回单行。主子句换行规则对 IN (1, 2, 3)、函数参数、
// VALUES 元组这类短列表同样生效，会把它们拆成竖排——反而更难读。
// 折叠条件：内部无嵌套括号、单行化后 ≤ 80 字符、确实因此变短；含注释的块
// 不折（行注释并行会吞掉后续内容）；字符串/标识符字面量内部的括号与换行不参与。
const INLINE_BLOCK_MAX = 80

// 结构块识别：内部含主子句关键字（SELECT/FROM/WHERE/PARTITION BY...）的括号块
// 是子查询/CTE/窗口 —— 无论多短都不折叠，保持层级缩进（N12e 的核心诉求）
const MAJOR_WORD_RES = MAJOR.map(m =>
  new RegExp('(^|[^A-Za-z0-9_$])' + m.split(' ').join('\\s+') + '($|[^A-Za-z0-9_$])', 'i')
)

function isStructuralBlock (inner) {
  return MAJOR_WORD_RES.some(re => re.test(inner))
}

function collapseInlineBlocks (s) {
  for (let pass = 0; pass < 20; pass++) {
    let changed = false
    let out = ''
    let i = 0
    const n = s.length
    while (i < n) {
      const ch = s[i]
      // 字符串/标识符字面量：整体原样保留
      if (ch === "'" || ch === '`' || ch === '"') {
        let j = i + 1
        while (j < n) {
          if (s[j] === ch) {
            if (s[j + 1] === ch) {
              j += 2
              continue
            }
            break
          }
          if (ch === "'" && s[j] === '\\') {
            j += 2
            continue
          }
          j++
        }
        out += s.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (ch === '(') {
        const close = s.indexOf(')', i + 1)
        if (close === -1) {
          out += s.slice(i)
          break
        }
        const inner = s.slice(i + 1, close)
        const commentFree = !inner.includes('--') && !inner.includes('#') &&
          !inner.includes('/*')
        if (!inner.includes('(') && commentFree && !isStructuralBlock(inner)) {
          const oneLine = inner.replace(/\s*\n\s*/g, ' ').trim()
          if (oneLine.length <= INLINE_BLOCK_MAX && oneLine.length < inner.length) {
            out += '(' + oneLine + ')'
            changed = true
            i = close + 1
            continue
          }
        }
        out += '('
        i++
        continue
      }
      out += ch
      i++
    }
    s = out
    if (!changed) {
      break
    }
  }
  return s
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
  // 输出末尾的标识符词（大写），用于函数名判定：greatest( / row_number(
  // 不留空格；SQL 关键字后的 '('（IN ( / VALUES (）保留空格
  const tailWord = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const s = out[k]
      if (s.length) {
        const m = s.match(/[A-Za-z0-9_$]+$/)
        return m ? m[0].toUpperCase() : ''
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
      const tw = tailWord()
      // 函数名后紧贴（greatest(a, b)）；关键字后留空格（IN ( / VALUES (）
      out.push(needSpace() && (!tw || KEYWORDS.includes(tw)) ? ' (' : '(')
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
        // 主子句换行：顶层顶格（indent 恒为 ''），括号内保留当前层级 ——
        // 旧行为 indent = '' 会把子查询/CTE/窗口函数拍平到第 0 列（I4）
        if (out.length) {
          out.push('\n' + indent)
        }
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

  return collapseInlineBlocks(out.join(''))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim()
}
