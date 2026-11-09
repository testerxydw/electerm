/**
 * N10a（语义层数据词典）：连接级可编辑的"业务术语 → 真实含义"映射。
 *
 * 词典内容（表/列的业务别名、Redis 键前缀含义、内部黑话）由用户为每个数据库
 * 连接（书签）维护，在 AI 生成/解释 SQL 时自动附带进 <glossary> 块
 * （渲染在 db-sql-ai.js 的 buildSqlAiPrompt 里，这里只管编辑器侧的文本契约）。
 *
 * 文本格式（textarea 编辑契约，一行一条）：
 *   term = meaning
 * - `=` 首次出现处分隔，term/meaning 两端空白剔除；
 * - `#` 开头的行是注释；空行跳过；没有 `=` 的行跳过（不猜语义）。
 *
 * 纪律：本模块零 React 依赖；localStorage 仅在浏览器环境使用（node 单测传 fake storage）。
 */

/** 词典条目上限：prompt 预算有限，超出截断（buildSqlAiPrompt 侧另有声明） */
export const MAX_DICT_ITEMS = 100

/** 单条含义长度上限：对齐 schema 注释的 120 字符裁剪口径 */
export const MAX_DICT_MEANING_CHARS = 120

/** localStorage 键前缀；连接级 = 书签 id */
const DICT_KEY_PREFIX = 'dbAiDict_'

/**
 * 多行文本 → 词条数组。容错：没有 `=` 的行、注释、空行直接跳过。
 * @param {string} text 编辑器全文
 * @returns {Array<{term: string, meaning: string}>}
 */
export function parseDictionaryText (text) {
  const out = []
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) {
      continue
    }
    const idx = t.indexOf('=')
    if (idx <= 0) {
      continue
    }
    const term = t.slice(0, idx).trim()
    const meaning = t.slice(idx + 1).trim()
    if (!term || !meaning) {
      continue
    }
    out.push({ term, meaning })
  }
  return out
}

/**
 * 词条数组 → 多行文本（编辑器回显用）。
 * @param {Array<{term: string, meaning: string}>} entries
 * @returns {string}
 */
export function serializeDictionary (entries) {
  if (!Array.isArray(entries)) {
    return ''
  }
  return entries
    .filter(e => e && e.term && e.meaning)
    .map(e => e.term + ' = ' + e.meaning)
    .join('\n')
}

/** 浏览器侧 storage：node 单测可注入 fake（同 localStorage 接口） */
function dictStorage () {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/**
 * 读某连接的词典原文。无 storage（node）或无值返回空串。
 * @param {string} bookmarkId 数据库书签 id（tab.id）
 * @param {Storage} [storage] 可注入（测试用）
 * @returns {string}
 */
export function loadDictionaryText (bookmarkId, storage) {
  if (!bookmarkId) {
    return ''
  }
  const st = storage || dictStorage()
  if (!st) {
    return ''
  }
  try {
    return String(st.getItem(DICT_KEY_PREFIX + bookmarkId) || '')
  } catch (_) {
    return ''
  }
}

/**
 * 存某连接的词典原文。无 storage（node）时静默跳过。
 * @param {string} bookmarkId
 * @param {string} text
 * @param {Storage} [storage] 可注入（测试用）
 */
export function saveDictionaryText (bookmarkId, text, storage) {
  if (!bookmarkId) {
    return
  }
  const st = storage || dictStorage()
  if (!st) {
    return
  }
  try {
    st.setItem(DICT_KEY_PREFIX + bookmarkId, String(text == null ? '' : text))
  } catch (_) {}
}
