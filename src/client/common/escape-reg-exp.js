/**
 * 正则元字符转义：把用户输入当作**字面量**而非模式（'a.b' 不该匹配 'axb'）。
 *
 * 终端触发器（components/terminal/automation/keys.js）与网格查找替换
 * （common/db-grid-replace.js）过去各写一份，转义字符表容易漂移。这里做单一真源，
 * 两处 re-export 保持既有 API。空值统一回空串，调用方无需自行判空。
 */
export function escapeRegExp (s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
