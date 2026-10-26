/**
 * 值呈现器注册表（F3 §9.2）
 *
 * 统一「文本格式 + 二进制呈现」的选取逻辑，让 DbValuePane 从「硬编码 detectFormats」
 * 升级为可扩展的注册表。呈现器分两类：
 *   - text：raw / json / python / xml / url，复用 db-value-format 的嗅探，可编辑；
 *   - binary：hex / base64 / image / blob-info，全部 readonly（BLOB 写回会破坏数据）。
 *
 * 真正渲染（高亮 / img / 元数据卡）仍由 DbValuePane 按 renderer.key 分派，
 * 本模块只负责「给哪些项、默认哪个、是否只读、预览上限」。
 */

import { detectFormats } from '../db-value-format'

// 注册表：register({ key, label, readonly, maxBytes, kind, detect })
const registry = []

export function register (spec) {
  registry.push(spec)
  return spec
}

export function getRenderers () {
  return registry.slice()
}

// 识别 F3 二进制信封（与主进程 binEnvelope、db-csv.isBinEnvelope 同源）。
// 仅当结构严格匹配才认作信封，避免与业务里恰好带 __bin 键的普通对象混淆。
export function isBinEnvelope (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return false
  }
  if (!('__bin' in v)) {
    return false
  }
  const b = v.__bin
  return !!b && typeof b === 'object' &&
    typeof b.size === 'number' && typeof b.b64 === 'string' &&
    typeof b.truncated === 'boolean'
}

// 二进制预览上限：信封只内联 4KB 前缀，超出的渲染器只给前 N 字节 + 复制/另存。
const BIN_MAX_PREVIEW = 4096

// ---------- 文本呈现器（复用 db-value-format 嗅探）----------

register({
  key: 'raw',
  label: 'raw',
  readonly: false,
  kind: 'text',
  detect: () => true // 兜底，永远可选
})

for (const key of ['json', 'python', 'xml', 'url']) {
  register({
    key,
    label: key,
    readonly: false,
    kind: 'text',
    detect: value => typeof value === 'string' && detectFormats(value).some(f => f.key === key)
  })
}

// ---------- 二进制呈现器（全部 readonly）----------

for (const key of ['hex', 'base64', 'image', 'blob-info']) {
  register({
    key,
    label: key,
    readonly: true,
    kind: 'binary',
    maxBytes: BIN_MAX_PREVIEW,
    // 值本身是任意二进制信封，或列类型为二进制（如 column.isBinary）都进二进制分支
    detect: (value, column) => isBinEnvelope(value) || column.isBinary === true
  })
}

/**
 * 选取可用呈现器。
 * @param {any} value 单元格值（可能是 __bin 信封对象或字符串）
 * @param {object} column 列元数据（含 isBinary）
 * @returns {{ isBinary: boolean, envelope: object|null, renderers: Array, defaultKey: string }}
 */
export function selectRenderers (value, column = {}) {
  const isBin = isBinEnvelope(value) || column.isBinary === true
  const envelope = isBinEnvelope(value) ? value.__bin : null
  const items = registry
    .filter(r => (isBin ? r.kind === 'binary' : r.kind === 'text'))
    .filter(r => r.detect(value, column))
    .map(r => ({ key: r.key, label: r.label, readonly: r.readonly, maxBytes: r.maxBytes }))
  let defaultKey = 'raw'
  if (items.length) {
    defaultKey = isBin
      ? 'hex'
      : (items[0].key === 'raw' && items[1] ? items[1].key : items[0].key)
  }
  return { isBinary: isBin, envelope, renderers: items, defaultKey }
}

// 取二进制列的前 maxBytes 字节（信封已截断到 BIN_PREFIX_LIMIT，可直接 decode）
export function binPreviewBytes (envelope) {
  if (!envelope || typeof envelope.b64 !== 'string') {
    return Buffer.alloc(0)
  }
  const buf = Buffer.from(envelope.b64, 'base64')
  return envelope.size > BIN_MAX_PREVIEW ? buf.subarray(0, BIN_MAX_PREVIEW) : buf
}
