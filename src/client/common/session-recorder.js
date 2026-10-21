/**
 * 会话录制引擎 (T5-4b/T5-4f)：asciinema v2 (cast) 格式
 *
 * 数据源与 T5-2b 同源：attach addon writeToTerminal 解码后的终端输出字符串
 * （suppressed 输出在 early-return 之前不进入录制，keepalive echo 等不落盘）。
 * 状态单源是 store.recState[tabId]（store/session.js toggleSessionRecord），
 * 本类是无状态消费者：onData 查询状态，active→inactive 转变时收尾落盘。
 *
 * T5-4f 增强：
 * - recordStripOsc=true 时剥离 shell 集成序列 (OSC 133/633)，减少不可读噪声；
 * - 输出按 REC_BATCH_MS 微批聚合，避免一行被拆成多条事件；
 * - recordInput=true 时记录 [t,"i",keys] 输入事件（asciinema --stdin 同款）；
 * - 密码提示期间内部避录（pause/resume），store.recState[tabId].paused 为用户暂停。
 *
 * 缓冲与落盘：内存攒行，500ms 或 256KB 触发 flush，
 * 经 window.pre.runGlobalAsync('appendRecFile', path, content) 主进程追加写。
 * tab 关闭时 attach addon dispose 调 stop() 强制落盘尾部。
 */

// flush 定时窗口（毫秒）：长会话内存占用上限由该窗口兜底
export const REC_FLUSH_INTERVAL = 500
// flush 大小阈值（字符）：大流量输出不等定时器，立即落盘
export const REC_FLUSH_BYTES = 256 * 1024
// 输出微批窗口（毫秒）：把逐 chunk 到达的碎片合并成一条 o 事件
export const REC_BATCH_MS = 80

// shell 集成序列 (electerm 注入的 OSC 133/633)，以 BEL 或 ST 结束
const SHELL_INTEGRATION_RE = /\x1b\](?:133|633);?[^\x07\x1b]*(?:\x07|\x1b\\)/g

// 剥离 shell 集成序列（OSC 133/633）；无匹配时原样返回
export function stripShellIntegration (str) {
  return str.replace(SHELL_INTEGRATION_RE, '')
}

// asciinema v2 首行 header（timestamp 为录制开始的 unix 秒）
export function buildCastHeader ({ width, height, timestamp }) {
  return JSON.stringify({
    version: 2,
    width,
    height,
    timestamp: Math.floor(timestamp / 1000)
  })
}

// asciinema v2 事件行：[相对开始秒, 事件类型, 数据]；elapsedMs 单调递增保证时间戳单调
export function buildCastLine (data, elapsedMs, type = 'o') {
  return JSON.stringify([Math.max(0, elapsedMs) / 1000, type, data])
}

export default class SessionRecorder {
  constructor (tabId) {
    this.tabId = tabId
    this.path = ''
    this.startTime = 0
    this.active = false
    this.buffer = []
    this.bufferBytes = 0
    this.timer = null
    // 输出微批：pending 为未成事件的输出，pendingAt 为其首个 chunk 的相对毫秒
    this.pending = ''
    this.pendingAt = 0
    this.batchTimer = null
    // 密码提示内部避录标志（不影响 UI 的暂停态）
    this.avoiding = false
  }

  config () {
    return window.store.config || {}
  }

  // attach addon 每个输出块调用；recState 无记录且本实例 active 说明 UI 侧已停录
  onData (str) {
    const { store } = window
    const rec = store.recState[this.tabId]
    if (!rec) {
      if (this.active) {
        this.stop()
      }
      return
    }
    // 用户暂停或密码避录期间：输出不入 cast
    if (rec.paused || this.avoiding) {
      return
    }
    if (!this.active) {
      this.active = true
      this.path = rec.path
      this.startTime = rec.startTime
      this.append(buildCastHeader(rec) + '\n')
    }
    this.queueOutput(str)
  }

  queueOutput (str) {
    const { recordStripOsc } = this.config()
    if (recordStripOsc !== false) {
      str = stripShellIntegration(str)
    }
    if (!str) {
      return
    }
    if (!this.pending) {
      this.pendingAt = Date.now() - this.startTime
    }
    this.pending += str
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(this.flushBatch, REC_BATCH_MS)
    }
  }

  // 把微批缓冲落成一条 o 事件
  flushBatch = () => {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    if (!this.pending) {
      return
    }
    const data = this.pending
    const at = this.pendingAt
    this.pending = ''
    this.append(buildCastLine(data, at) + '\n')
  }

  // 键盘输入（asciinema i 事件）；输出微批先落，保证事件顺序与时间一致
  onInput (keys) {
    const rec = window.store.recState[this.tabId]
    if (!rec || rec.paused || this.avoiding || !this.active) {
      return
    }
    if (!this.config().recordInput) {
      return
    }
    this.flushBatch()
    this.append(buildCastLine(keys, Date.now() - this.startTime, 'i') + '\n')
  }

  // 密码提示期间避录：落掉已有输出后暂停接收
  pause () {
    this.flushBatch()
    this.avoiding = true
  }

  resume () {
    this.avoiding = false
  }

  append (line) {
    this.buffer.push(line)
    this.bufferBytes += line.length
    if (!this.timer) {
      this.timer = setTimeout(this.flush, REC_FLUSH_INTERVAL)
    }
    if (this.bufferBytes >= REC_FLUSH_BYTES) {
      this.flush()
    }
  }

  flush = () => {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buffer.length) {
      return
    }
    const content = this.buffer.join('')
    this.buffer = []
    this.bufferBytes = 0
    window.pre.runGlobalAsync('appendRecFile', this.path, content)
      .catch(err => {
        console.error('[session-recorder] append failed', err)
      })
  }

  // 收尾：落盘尾部缓冲并复位（下次开录重新写 header）
  stop () {
    this.active = false
    this.avoiding = false
    this.flushBatch()
    this.flush()
  }
}
