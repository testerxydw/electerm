/**
 * 不可信结果边界块（设计 SEC-1 / §3.4）· 纯函数，ESM，无 window。
 *
 * T03 落了 `wrapUntrusted` + `truncateResult`（M27：包装本身）。
 * **T04 补齐两半（M7 / M7-③）**：
 *   - `sanitizeUntrusted`：块**内**文本消毒——伪造的闭合标记（含大小写
 *     变体、嵌套、标签内带空白）统一插空格断链，模型无法提前关闭边界块。
 *   - `wrapUntrusted` 属性位转义：`server` / `tool` 属性值来自配置与工具
 *     名，属外部可控。入口校验（`config-validate.js` 的 name 字符集）已闭
 *     半边，这里是边界侧纵深防御：属性里的 `"` `<` `>` 转义、换行折叠，
 *     注入串无法借属性位提前闭合属性、伪造边界标记（M7-③）。
 *
 * **调用顺序必须是 `wrapUntrusted(sanitizeUntrusted(text), …)`**：先消毒
 * 文本再包装，我们自己的合法闭合标记才不会被消毒误伤。
 */

const DEFAULT_TAG = 'untrusted-tool-result'

// 64 KiB：一个工具结果不该占掉整个上下文窗口；超限截断并留痕。
const DEFAULT_MAX_BYTES = 64 * 1024

// 伪造边界标记（开/闭通吃）：任意大小写 + 标签内部任意空白。闭标记
// （`</untrusted-tool-result>` / `</ UNTRUSTED-TOOL-RESULT>`）用于提前关闭
// 边界块；开标记（`<untrusted-tool-result …>`）用于伪造嵌套块混淆模型。
// 后瞻断言限定了标签名边界（后面必须是空白 / `/` / `>` / 结尾），普通文本
// 里恰好含 "untrusted-tool-result" 字样的不受影响。
const FORGED_BOUNDARY_TAG = /<\s*\/?\s*untrusted-tool-result(?=[\s/>]|$)/gi

/**
 * 属性位转义（M7-③）：`&` 先行避免双重转义；换行折叠成空格，保证属性
 * 永不跨行（M7-③ 第 3 条：serverLabel 含换行时块仍是单行结构）。
 * @param {string} value
 * @returns {string}
 */
function escapeAttr (value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\n]/g, ' ')
}

/**
 * 块**内**文本消毒（T04 M7-①）：伪造的边界标记（开/闭、任意大小写变体、
 * 嵌套、标签内带空白）统一插空格断链——`</untrusted-tool-result>` 变成
 * `< /untrusted-tool-result>`，无法提前关闭边界块；伪造的开标记同样断链，
 * "块内开闭标记各恰好 1 个"对任意文本普遍成立（M7-③ 第 1 条）。文本位的
 * 其他内容（含引号、尖括号的普通文本）原样保留：它们不构成边界标记。
 * @param {string} text 工具结果原始文本
 * @returns {string} 消毒后的文本（边界标记已断链）
 */
function sanitizeUntrusted (text) {
  const s = String(text === undefined || text === null ? '' : text)
  return s.replace(FORGED_BOUNDARY_TAG, match => match.replace('<', '< '))
}

/**
 * 把外部工具结果包进不可信边界块。
 *
 * `serverLabel` 的取值来源（M27 取值来源判据，写死）：调用方必须传主进程
 * `meta.serverName` —— 即经过 `config-validate.js` name 字符集校验的
 * `config.name`。**不许**改用 `serverInfo.name`（server 自报、未校验）。
 *
 * 属性值经 `escapeAttr` 转义（T04 M7-③）：入口校验是第一道，这里是边界
 * 侧的第二道。文本位不在这里消毒——调用方先过 `sanitizeUntrusted`
 * （顺序判据见文件头），本函数只负责属性安全 + 包装。
 * @param {string} text 工具结果文本
 * @param {{serverLabel?: string, toolName?: string, tag?: string}} [opts]
 * @returns {string}
 */
function wrapUntrusted (text, opts = {}) {
  const tag = (opts && opts.tag) || DEFAULT_TAG
  const serverLabel = escapeAttr((opts && opts.serverLabel) || '')
  const toolName = escapeAttr((opts && opts.toolName) || '')
  return `<${tag} server="${serverLabel}" tool="${toolName}">\n${String(text)}\n</${tag}>`
}

/**
 * 结果截断：超预算时硬切并追加留痕，让模型（和读日志的人）知道文本不完整。
 * @param {string} text
 * @param {number} [maxBytes] 默认 64 KiB
 * @returns {string}
 */
function truncateResult (text, maxBytes = DEFAULT_MAX_BYTES) {
  const s = String(text === undefined || text === null ? '' : text)
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) {
    return s
  }
  // 按字符切再量字节，避免把多字节字符切出一半乱码
  let out = s
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
    out = out.slice(0, Math.max(1, Math.floor(out.length * 0.9)))
  }
  const dropped = Buffer.byteLength(s, 'utf8') - Buffer.byteLength(out, 'utf8')
  return out + `\n…[truncated ${dropped} bytes]`
}

export {
  DEFAULT_TAG,
  escapeAttr,
  sanitizeUntrusted,
  wrapUntrusted,
  truncateResult
}
