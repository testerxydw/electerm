/**
 * 不可信结果边界块（设计 SEC-1 / §3.4）· 纯函数，ESM，无 window。
 *
 * **T03 范围（M27）只有 `wrapUntrusted` + `truncateResult`**：包装本身。
 * `sanitizeUntrusted`（块内 `</untrusted-tool-result>` 插空格断链）是 T04
 * SEC-1 的活 —— 包装层在 T03 故意**不做二次转义**：入口校验已经拒绝了用户
 * 配置里的 `name` 含 `"` `<` `>`（`config-validate.js`），而 server 自报的
 * `serverInfo.name` 不进属性位（M27 取值来源判据：属性值取
 * `meta.serverName`，即主进程校验过的 `config.name`），所以此刻没有可注入
 * 的路径；把消毒提前做一半，T04 的判据就永远红不起来了。
 */

const DEFAULT_TAG = 'untrusted-tool-result'

// 64 KiB：一个工具结果不该占掉整个上下文窗口；超限截断并留痕。
const DEFAULT_MAX_BYTES = 64 * 1024

/**
 * 把外部工具结果包进不可信边界块。
 *
 * `serverLabel` 的取值来源（M27 取值来源判据，写死）：调用方必须传主进程
 * `meta.serverName` —— 即经过 `config-validate.js` name 字符集校验的
 * `config.name`。**不许**改用 `serverInfo.name`（server 自报、未校验）。
 * @param {string} text 工具结果文本
 * @param {{serverLabel?: string, toolName?: string, tag?: string}} [opts]
 * @returns {string}
 */
function wrapUntrusted (text, opts = {}) {
  const tag = (opts && opts.tag) || DEFAULT_TAG
  const serverLabel = (opts && opts.serverLabel) || ''
  const toolName = (opts && opts.toolName) || ''
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

export { DEFAULT_TAG, wrapUntrusted, truncateResult }
