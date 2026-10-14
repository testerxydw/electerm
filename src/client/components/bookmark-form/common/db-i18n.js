/**
 * 数据库表单文案解析。
 *
 * 背景：语言包 @electerm/electerm-locales 是**外部 npm 依赖**，无法就地新增 key；
 * 而 window.translate(key) 在缺失时返回「首字母大写的 key 原文」（如 dbType -> "DbType"），
 * 会让界面暴露英文 key。这里为缺失项提供本地词条，语言包已有的键继续走语言包，
 * 从而在不 fork 依赖的前提下保持界面可读、且不破坏既有 i18n 行为。
 */

// 仅收录「语言包确实缺失」的键（新增前请先核对 zh_cn.lang）
const EXTRA = {
  dbType: {
    zh_cn: '数据库类型',
    en_us: 'Database type'
  },
  dbName: {
    zh_cn: '数据库名',
    en_us: 'Database name'
  },
  readOnly: {
    zh_cn: '只读模式',
    en_us: 'Read-only mode'
  },
  readOnlyHint: {
    zh_cn: '仅允许 SELECT / SHOW / DESC / EXPLAIN',
    en_us: 'Only SELECT / SHOW / DESC / EXPLAIN allowed'
  },
  tableStructure: {
    zh_cn: '表结构',
    en_us: 'Table structure'
  },
  reconnect: {
    zh_cn: '重连',
    en_us: 'Reconnect'
  },
  connectionLost: {
    zh_cn: '数据库连接可能已断开',
    en_us: 'Database connection may be lost'
  }
}

function currentLang () {
  const store = window.store
  return (store && store.config && store.config.language) ||
    window.initLanguage ||
    'en_us'
}

/**
 * @param {string} key 语言包键名
 * @returns {string} 已翻译文案；语言包缺失时回落到本地词条
 */
export default function dbT (key) {
  const v = window.translate(key)
  // translate 缺失时返回首字母大写的 key 本身，据此判断语言包是否已提供
  if (String(v).toLowerCase() !== String(key).toLowerCase()) {
    return v
  }
  const table = EXTRA[key]
  if (!table) {
    return v
  }
  const lang = currentLang()
  return table[lang] || table[lang.replace('-', '_')] || table.en_us
}
