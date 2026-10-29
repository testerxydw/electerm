/**
 * 远程文件只读预览的判定与编码（G3）。
 *
 * 现有 `readRemoteFile` 是"全量下载 → toString"，3MB 的编辑上限只是调用点的
 * 门，函数本身没有上限；拿它做预览会把 10MB 日志整份搬进主进程内存再塞过 ws。
 * 这里只做**纯函数**部分：读多少、算文本还是二进制、怎么编码，I/O 留给
 * `sftp-file.js` / `ftp-file.js` 与各自的会话类。
 *
 * 三条口径：
 *
 * 1) **先按扩展名分档再嗅探**。图片要整张才能给渲染层看（上限 10MB），文本/
 *    二进制只看前 2MB；先嗅探再决定读多少就得多读一轮，没必要。
 * 2) **二进制判定看 NUL 密度**，不看控制字符。UTF-8 文本里出现 0x00 的概率极低，
 *    而 Latin-1 的老日志里控制字符不少，按控制字符判会把它们全打成二进制。
 * 3) **SVG 按图片走 base64 但不在主进程渲染**。渲染层用 <img> 展示，脚本不会执行；
 *    这属于"预览"路径，和编辑器无关。
 */

const TEXT_PREVIEW_MAX = 2 * 1024 * 1024
const IMAGE_PREVIEW_MAX = 10 * 1024 * 1024
const HEX_PREVIEW_MAX = 4 * 1024
const SNIFF_BYTES = 8 * 1024
const BINARY_NUL_RATIO = 0.01

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

function extOf (name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

function imageMimeOf (name) {
  return IMAGE_MIME[extOf(name)] || ''
}

/**
 * 预览要读多少字节（从文件头开始）。
 *
 * 图片档与图片上限取小：10MB 的图整张读，12MB 的图只读前 10MB 并标 truncated
 * （再大也不该在预览里整张加载）。非图片一律 2MB。
 *
 * @param {string} name 文件名（只看扩展名）
 * @param {number} size 远端文件大小
 * @returns {number}
 */
function previewReadLimit (name, size) {
  const n = Math.max(0, Number(size) || 0)
  const cap = imageMimeOf(name) ? IMAGE_PREVIEW_MAX : TEXT_PREVIEW_MAX
  return Math.min(n, cap)
}

/**
 * 二进制嗅探：前 8KB 里 NUL 字节占比超过 1% 即判二进制。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinaryBuffer (buf) {
  const n = Math.min(buf.length, SNIFF_BYTES)
  if (!n) {
    return false
  }
  let nul = 0
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      nul++
    }
  }
  return nul / n > BINARY_NUL_RATIO
}

/**
 * 十六进制转储：每行 16 字节，`偏移  十六进制  |ASCII|`。
 *
 * @param {Buffer} buf
 * @param {number} [max]
 * @returns {string}
 */
function hexDump (buf, max = HEX_PREVIEW_MAX) {
  const b = buf.subarray(0, Math.min(buf.length, max))
  const lines = []
  for (let off = 0; off < b.length; off += 16) {
    const chunk = b.subarray(off, off + 16)
    const hex = Array.from(chunk)
      .map(x => x.toString(16).padStart(2, '0'))
      .join(' ')
    const ascii = Array.from(chunk)
      .map(x => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.'))
      .join('')
    lines.push(
      off.toString(16).padStart(8, '0') + '  ' +
      hex.padEnd(47, ' ') + '  |' + ascii + '|'
    )
  }
  return lines.join('\n')
}

/**
 * 组装预览数据（会话层调用）。
 *
 * buffer 可能只是文件头（受 previewReadLimit 限制），truncated 由"读到的字节
 * 数 < 文件大小"推出，调用方不必自己算。
 *
 * @param {Object} input
 * @param {string} input.name
 * @param {number} input.size 远端真实大小
 * @param {number} [input.mtime]
 * @param {number} [input.mode]
 * @param {Buffer} input.buffer 已读到的内容（文件头）
 * @returns {Object}
 */
function buildPreview ({ name, size, mtime, mode, buffer }) {
  const total = Number(size) || buffer.length
  const truncated = buffer.length < total
  const base = {
    size: total,
    mtime: mtime || 0,
    mode: typeof mode === 'number' ? mode : 0,
    truncated
  }
  const mime = imageMimeOf(name)
  if (mime && total <= IMAGE_PREVIEW_MAX) {
    return {
      ...base,
      kind: 'image',
      mime,
      bytes: buffer.length,
      base64: buffer.toString('base64')
    }
  }
  if (isBinaryBuffer(buffer)) {
    const shown = Math.min(buffer.length, HEX_PREVIEW_MAX)
    return {
      ...base,
      kind: 'binary',
      bytes: shown,
      hex: hexDump(buffer)
    }
  }
  return {
    ...base,
    kind: 'text',
    bytes: buffer.length,
    text: buffer.toString('utf8')
  }
}

module.exports = {
  TEXT_PREVIEW_MAX,
  IMAGE_PREVIEW_MAX,
  HEX_PREVIEW_MAX,
  SNIFF_BYTES,
  BINARY_NUL_RATIO,
  extOf,
  imageMimeOf,
  previewReadLimit,
  isBinaryBuffer,
  hexDump,
  buildPreview
}
