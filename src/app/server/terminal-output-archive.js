/**
 * 无损原始输出归档 —— 「一个字符都不丢」的唯一真源。
 *
 * 背景：屏幕受 scrollback 上限、\r 覆写、清屏、alternate buffer 切换等终端
 * 语义限制，不可能把 PTY 产出的每个字节同时呈现出来；过去那套 2MB 超限
 * 丢最旧数据的合批优化更是主动制造了「打印凭空消失」。
 * 因此在数据离开会话的第一现场（term 的 data 事件）无条件落盘原始字节，
 * 再做流控、合批、协议分发。归档失败只降级并上报，绝不吞数据、绝不杀会话。
 *
 * 归档保存的是**原始字节**（Buffer），不是解码后的字符串、也不是经过 VT
 * 解析的日志文本，所以 UTF-8 分片、非法字节、控制序列都能逐字节复原与对账。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// 单文件分片阈值：只换文件，不丢数据、不给归档设总量上限。
const MAX_PART_BYTES = 256 * 1024 * 1024

function safePartName (pid, index) {
  const safe = String(pid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return `lossless-${safe}-${Date.now()}-${String(index).padStart(3, '0')}.bin`
}

class TerminalOutputArchive {
  constructor ({ pid, dir, maxPartBytes = MAX_PART_BYTES, onError = null } = {}) {
    this.pid = pid || 'session'
    this.dir = dir || path.join(process.env.DATA_PATH || os.tmpdir(), 'electerm', 'lossless_output')
    this.maxPartBytes = maxPartBytes
    this.onError = typeof onError === 'function' ? onError : null
    this.bytes = 0 // 实际落盘且参与 hash 的字节（可逐字节对账）
    this.producedBytes = 0 // 会话产出的全部字节（含暂未落盘 / 已丢的）
    this.lostBytes = 0 // 因写流不可用而未能落盘的字节
    this.parts = []
    this.error = null
    this.failed = false // 彻底不可用（目录建不了 / 持续写失败）
    this._errorReported = false
    this._hash = crypto.createHash('sha256')
    this._index = 0
    this._partBytes = 0
    this._stream = null
    this._allStreams = []
    this._closed = false
    this._final = null
    this._ensureDir()
    this._openPart()
  }

  _ensureDir () {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (e) {
      this.error = `archive dir unavailable: ${e.message}`
    }
  }

  _openPart () {
    if (this._closed || this._stream || this.failed) {
      return
    }
    const file = path.join(this.dir, safePartName(this.pid, this._index))
    try {
      const stream = fs.createWriteStream(file, { flags: 'a' })
      // 没有 error 监听会把失败抛成 uncaughtException，连带整个会话被 cleanup。
      stream.on('error', (e) => this._handleStreamError(`archive write failed: ${e.message}`))
      this._stream = stream
      this._allStreams.push(stream)
      this.parts.push(file)
      this._index += 1
      this._partBytes = 0
    } catch (e) {
      this.error = `archive open failed: ${e.message}`
      this._stream = null
      this.failed = true
      this._reportError()
    }
  }

  _handleStreamError (msg) {
    this.error = msg
    this._stream = null
    this._reportError()
  }

  // 真正写一片；成功才记账 + 更新 hash，绝不把没落盘的字节算进账本。
  _writeOne (buf) {
    if (!this._stream) {
      return false
    }
    try {
      this._stream.write(buf)
      this.bytes += buf.length
      this._hash.update(buf)
      this._partBytes += buf.length
      // 达到单文件阈值就切到新分片：只换文件，不丢数据、不给归档设总量上限。
      if (this._partBytes >= this.maxPartBytes) {
        this._rotatePart()
      }
      return true
    } catch (e) {
      this._handleStreamError(`archive write failed: ${e.message}`)
      return false
    }
  }

  // 当前分片写满：先优雅结束旧流再开新文件，确保旧分片字节已被接管后才切换。
  _rotatePart () {
    if (this._stream) {
      try {
        this._stream.end()
      } catch (_) {}
      this._stream = null
    }
    this._openPart()
  }

  /**
   * 逐字节归档。任何写流不可用的情况都先记账丢失量并上报，绝不静默吞；
   * 随后尝试开新分片把这块补写回去（一次恢复）。彻底失败时 failed=true，
   * UI / 探针能立刻看到降级，而不是收到一份"看起来成功实则有空洞"的归档。
   */
  write (data) {
    if (this._closed || !data) {
      return
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (!buf.length) {
      return
    }
    this.producedBytes += buf.length
    if (this.failed) {
      this.lostBytes += buf.length
      this._reportError()
      return
    }
    if (this._writeOne(buf)) {
      return
    }
    // 当前写流不可用：记账丢失、上报，并尝试开新分片补写（恢复一次）。
    this.lostBytes += buf.length
    this._reportError()
    this._openPart()
    if (this._writeOne(buf)) {
      this.lostBytes -= buf.length
    }
  }

  _reportError () {
    if (this._errorReported || !this.onError) {
      return
    }
    this._errorReported = true
    try {
      this.onError(this.error || 'lossless output archive degraded')
    } catch (_) {}
  }

  stats () {
    return {
      bytes: this.bytes,
      producedBytes: this.producedBytes,
      lostBytes: this.lostBytes,
      parts: this.parts.slice(),
      error: this.error,
      failed: this.failed,
      dir: this.dir
    }
  }

  /** 结束时收尾；digest 只在 close 时取，避免终结增量 hash。 */
  close () {
    if (this._closed) {
      return this._final || this.stats()
    }
    this._closed = true
    const result = {
      ...this.stats(),
      sha256: this._hash.digest('hex')
    }
    for (const stream of this._allStreams) {
      try {
        stream.end()
      } catch (_) {}
    }
    this._stream = null
    this._final = result
    return result
  }

  /** 等所有分片真正落盘；探针/单测用它做逐字节对账，运行期不必等待。 */
  async drain () {
    await Promise.all(this._allStreams.map(stream => new Promise((resolve) => {
      if (stream.writableFinished || stream.destroyed) {
        return resolve()
      }
      stream.once('finish', resolve)
      stream.once('error', resolve)
      stream.once('close', resolve)
    })))
  }
}

module.exports = { TerminalOutputArchive, MAX_PART_BYTES }
