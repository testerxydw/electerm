/**
 * SQL 编辑器的六项可选能力（阶段4 A-8，设计 §4.2）
 *
 * 照 CloudBeaver flags 取的六项：行号 / 自动换行 / 自动补全 / 括号匹配 /
 * 高亮当前行 / 代码折叠。每项都能单独关掉——关掉是为了"目录服务也读得顺眼"，
 * 不是为了省事：折叠/换行在宽表场景会改变行高，行号在窄面板里占宽度。
 *
 * 为什么单独成文件（而不是写在编辑器里）：
 * - 编辑器是懒加载 chunk，主线程读配置不该把它拖进来
 * - 配置键、默认值、文案 key 需要被 UI（工具条弹层）和编辑器**共用同一份**，
 *   两边各写一份必然漂移
 * - 纯函数零依赖，可以直接单测（node 环境没有 DOM，挂不了 CM6）
 */

/**
 * 六项定义。`key` 是运行期字段名，`config` 是持久化键，`label` 是词条 key。
 * 默认值取"多数人第一眼就要"的组合：行号/补全/括号/当前行开，
 * 换行/折叠关（换行会让长 SQL 的行数不可预期，折叠在短句上只是噪音）。
 */
export const SQL_EDITOR_OPTIONS = [
  { key: 'lineNumbers', config: 'dbSqlLineNumbers', label: 'dbSqlOptLineNumbers', def: true },
  { key: 'lineWrap', config: 'dbSqlLineWrap', label: 'dbSqlOptLineWrap', def: false },
  { key: 'autoComplete', config: 'dbSqlAutoComplete', label: 'dbSqlOptAutoComplete', def: true },
  { key: 'bracketMatch', config: 'dbSqlBracketMatch', label: 'dbSqlOptBracketMatch', def: true },
  { key: 'activeLine', config: 'dbSqlActiveLine', label: 'dbSqlOptActiveLine', def: true },
  { key: 'fold', config: 'dbSqlFold', label: 'dbSqlOptFold', def: false }
]

export const SQL_EDITOR_DEFAULTS = SQL_EDITOR_OPTIONS.reduce((acc, o) => {
  acc[o.key] = o.def
  return acc
}, {})

/**
 * 从全局 config 读出六项。
 *
 * 只认布尔真值：历史配置里可能是 'true' / 1 / undefined（手改 config 文件很常见），
 * 一律按"没配过"回落到默认值，避免出现"开关显示关了但其实还开着"的错位。
 *
 * @param {object} cfg window.store._config
 * @returns {{lineNumbers:boolean,lineWrap:boolean,autoComplete:boolean,
 *            bracketMatch:boolean,activeLine:boolean,fold:boolean}}
 */
export function readSqlEditorOpts (cfg) {
  const out = {}
  for (const o of SQL_EDITOR_OPTIONS) {
    const v = cfg ? cfg[o.config] : undefined
    out[o.key] = typeof v === 'boolean' ? v : o.def
  }
  return out
}

/**
 * 补全调用方传进来的选项（编辑器内部再兜一次底：props 可能只给了几项，
 * 或传了 null）。未知字段忽略，不做透传。
 */
export function normalizeSqlEditorOpts (opts) {
  const out = {}
  for (const o of SQL_EDITOR_OPTIONS) {
    const v = opts ? opts[o.key] : undefined
    out[o.key] = typeof v === 'boolean' ? v : o.def
  }
  return out
}

/**
 * 翻转一项，返回新的持久化补丁（形如 `{ dbSqlFold: true }`）。
 * 返回补丁而不是整份配置：setConfig 是浅合并，整份写回会覆盖掉并发改的其他键。
 *
 * @returns {{key:string, config:string, value:boolean, patch:object}|null}
 */
export function toggleSqlEditorOpt (opts, key) {
  const meta = SQL_EDITOR_OPTIONS.find(o => o.key === key)
  if (!meta) {
    return null
  }
  const cur = normalizeSqlEditorOpts(opts)[key]
  const value = !cur
  return {
    key,
    config: meta.config,
    value,
    patch: { [meta.config]: value }
  }
}
