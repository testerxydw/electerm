/**
 * 会话录制引擎 (T5-4b)：asciinema v2 (cast) 格式
 *
 * 数据源与 T5-2b 同源：attach addon writeToTerminal 解码后的终端输出字符串
 * （suppressed 输出在 early-return 之前不进入录制，keepalive echo 等不落盘）。
 * 状态单源是 store.recState[tabId]（store/session.js toggleSessionRecord），
 * 本类是无状态消费者：onData 查询状态，active→inactive 转变时收尾落盘。
 * 默认仅记录输出 'o'，不记录键盘输入（隐私边界）。
 *
 * 缓冲与落盘：内存攒行，500ms 或 256KB 触发 flush，
 * 经 window.pre.runGlobalAsync('appendRecFile', path, content) 主进程追加写。
 * tab 关闭时 attach addon dispose 调 stop() 强制落盘尾部。
 */

// flush 定时窗口（毫秒）：长会话内存占用上限由该窗口兜底
export const REC_FLUSH_INTERVAL = 500
// flush 大小阈值（字符）：大流量输出不等定时器，立即落盘
export const REC_FLUSH_BYTES = 256 * 1024

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
export function buildCastLine (data, elapsedMs) {
  return JSON.stringify([Math.max(0, elapsedMs) / 1000, 'o', data])
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
    if (!this.active) {
      this.active = true
      this.path = rec.path
      this.startTime = rec.startTime
      this.append(buildCastHeader(rec) + '\n')
    }
    this.append(buildCastLine(str, Date.now() - this.startTime) + '\n')
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
    this.flush()
  }
}
