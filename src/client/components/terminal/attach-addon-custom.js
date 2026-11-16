import { loadAttachAddon } from './xterm-loader.js'
import { handleSessionControlMessage } from '../../common/session-bar-data.js'
import SessionTrafficTracker from '../../common/session-traffic.js'
import SessionRecorder from '../../common/session-recorder.js'
import { FLOW_ACTIONS, bytesOf } from '../../common/term-flow.js'
import {
  registerBroadcastAddon,
  unregisterBroadcastAddon,
  mirrorInput
} from '../../common/term-broadcast.js'

// 零丢弃写入通道（2026-11-12 重新设计）：
// 旧实现在 normal screen 洪流时按 2MB 上限丢最旧数据，alternate screen 只
// 用「直写」打补丁绕过；抑制窗口、200K 缓冲上限、zmodem 早退又各自吞数据。
// 现在只有一条 FIFO：ws 帧解码后入队，一次只把一个批次交给 xterm，
// term.write 的回调（xterm 已解析完该批）回 ACK 驱动下一批并给服务端回补
// credit。没有截断、没有「丢最旧」、没有 truncated 标记，也不再有
// alternate screen 特判 —— 不丢帧，TUI 增量重绘自然不会错乱。
const ESC = String.fromCharCode(27)

// #4628 保活探针。保活过去让服务端往 PTY 写 '\n\r\x1b[K' 去唤醒 bash
// （防 TMOUT 登出），那等于替用户按键：回车会提交半截命令、自动应答
// read/确认提示，ESC[K 在没有 readline 的 sh/dash 里留在行缓冲，用户下次
// 回车才带出隐形字节。现在改成一次 DSR 往返：服务端只把"该探了"这个信号
// 发回渲染层，查询由渲染层自己写进 xterm 的显示流（一个字节都不进 PTY），
// xterm 的应答必须在这里吞掉 —— 它是终端生成的，不是用户敲的，回给服务端
// 就会被写进 PTY。
const DSR_PROBE = ESC + '[5n'
const DSR_REPLY = ESC + '[0n'
// 查询发下去后等应答的窗口；超时只丢掉这次探针，不重试。
const DSR_REPLY_TIMEOUT = 1000

// 旧通道的纯函数（ansiSequenceEnd / stripLeadingCursorOps /
// truncateTerminalOutput / startAfterPartialAnsi / findAltBufferSwitch）全部随
// 「丢帧」一起移除：它们存在的唯一理由是「丢了数据之后尽量少错乱」。零丢弃后
// FIFO 天然保序，xterm 自己的 parser 会跨 term.write 调用保持转义序列状态，
// 不需要再手工拼接被 chunk 边界截断的尾巴。

/**
 * 注入窗口回放过滤：只剥掉注入命令自身的回显行，其余字节原样保留。
 * chunks 是抑制窗口内按序缓冲的 {str, bytes}；needle 是 typed 注入命令
 * 原文（去尾部 \r）。回显在 pty 输出里是 needle 后跟换行；找不到 needle
 * （回显形式异常）时不剥——宁可多显示一行，也不误删其他输出。
 * bytes 全额保留：流控按原 ws 帧 ACK，剥离只影响写屏内容；归档/录制
 * 已在缓冲时收下全量字节，不受影响。
 */
export function filterSuppressedEcho (chunks, needle) {
  if (!needle || !Array.isArray(chunks) || !chunks.length) {
    return chunks
  }
  const total = chunks.map(c => c.str).join('')
  const idx = total.indexOf(needle)
  if (idx === -1) {
    return chunks
  }
  // 回显行尾：优先 \n（typed \r 在 pty 里回显为换行），退化 \r，
  // 缓冲里两者都没有时剥到缓冲尾（行尾必然先于首个 OSC 633 到达，
  // 走到这一支说明窗口恰在回显行中途关闭，多剥的只有行尾碎片）
  let end = total.indexOf('\n', idx + needle.length)
  if (end === -1) {
    const cr = total.indexOf('\r', idx + needle.length)
    end = cr === -1 ? total.length : cr + 1
  } else {
    end += 1
  }
  const keeps = [
    [0, idx],
    [end, total.length]
  ].filter(([a, b]) => b > a)
  const out = []
  let off = 0
  for (const chunk of chunks) {
    const start = off
    off += chunk.str.length
    let visible = ''
    for (const [a, b] of keeps) {
      const s = Math.max(a, start)
      const e = Math.min(b, start + chunk.str.length)
      if (e > s) {
        visible += chunk.str.slice(s - start, e - start)
      }
    }
    out.push({ str: visible, bytes: chunk.bytes })
  }
  return out
}

export default class AttachAddonCustom {
  constructor (term, socket, isWindowsShell, infoTabId = '') {
    this.term = term
    this.socket = socket
    this.isWindowsShell = isWindowsShell
    // session socket 上报的控制消息 (ssh-handshake-info 等) 归属的 tab
    this.infoTabId = infoTabId
    // 顶栏 ↑↓ 速率计数 (common/session-traffic.js), 全类型 session 一处生效
    this.trafficTracker = infoTabId
      ? new SessionTrafficTracker({ tabId: infoTabId })
      : null
    // 会话录制 (common/session-recorder.js), 状态源 store.recState, dispose 时收尾落盘
    this.recorder = infoTabId ? new SessionRecorder(infoTabId) : null
    this.outputSuppressed = false
    this.suppressedData = []
    this.suppressedChars = 0
    this.suppressTimeout = null
    this.onSuppressionEndCallback = null
    // 注入命令原文（去尾 \r），抑制窗口回放时剥它自己的回显
    this._injectionEcho = null
    this.hasReceivedInitialData = false
    this.onInitialDataCallback = null
    this._bidirectional = true
    this._disposables = []
    this._socket = socket
    // 同步设置 binaryType：@xterm/addon-attach 的构造函数也会设，但它要等
    // loadAttachAddon 动态 import 完成（activate 里的 await）才开始。趁早设好，
    // 避免连接建立到 addon 就绪之间到达的二进制帧（登录 banner）被当成 Blob 丢弃。
    if (socket && typeof socket.binaryType !== 'undefined') {
      try { socket.binaryType = 'arraybuffer' } catch (_) {}
    }
    this.decoder = new TextDecoder('utf-8')
    this._lastDataTime = Date.now()
    this._lastInputTime = Date.now()
    // Set for the lifetime of the connection; every async helper below
    // bails out on it so a disposed addon can never leave a pending promise
    // (and the startup queue waiting on it) hanging.
    this.disposed = false
    this._keepaliveTimer = null
    this._keepaliveInterval = 3000
    // Set while a DSR keepalive probe awaits its answer (see _startDsrProbe).
    this._dsrReplyExpected = false
    this._dsrReplyTimer = null
    // Characters typed on the current command line and not yet submitted.
    // Only a hint: the keepalive decision is made against the terminal buffer
    // (see _lineHasUnsubmittedInput), because escape sequences put text on the
    // line without sending a printable character.
    this._pendingInputLength = 0
    // Set by an escape sequence (cursor keys, history recall, bracketed paste)
    // until the line is submitted or cleared: from then on the byte count above
    // can not be trusted, because Up can recall a whole command.
    this._pendingInputUnknown = false
    // The command line as the shell last drew it with nothing typed on it:
    // { row, length }. Captured after output is parsed, so the keepalive can
    // ask the screen "is there anything past the prompt?" instead of guessing
    // from keystrokes.
    this._lineBaseline = null
    this._lastOutputLine = ''
    this._passwordPromptDetected = false
    this._pendingEchoCheck = null
    this._echoCheckTimer = null
    // 零丢弃 FIFO：ws 帧解码后进队，一次只有一个批次交给 xterm，
    // term.write 的回调（xterm 已解析完该批）回 ACK 并驱动下一批。
    // 无上限截断、无「丢最旧」、无 truncated 标记。credit 窗口由服务端管，
    // 已发未 ACK 的字节有界，因此 xterm 的 50MB 写缓冲永远够不到。
    this._pending = []
    this._pendingBytes = 0
    this._writeInFlight = false
    this._inflightBytes = 0
    this._flushTimer = null
    this._flushScheduled = false
    this._retryTimer = null
    this._flushIntervalMs = 16
    this._lastFlushTime = 0
    // 单批写入上限：远低于 xterm 50MB 写缓冲硬阈值，从源头杜绝
    // "write data discarded, use flow control..." 抛错（该抛错在回调入队前同步
    // 发生，会让 _writeInFlight 永不复位、FIFO 永久停摆）。
    this._maxFlushBytes = 4 * 1024 * 1024
    // 在途批次令牌 + 看门狗：回调丢失时 10s 后把批次回队重发并复位推进位，
    // 避免 FIFO 冻结；迟到的旧回调凭令牌被丢弃，不会双写 / 双 ACK。
    this._inflightToken = 0
    this._inflightBatch = null
    this._retryCount = 0
    this._writeWatchdog = null
    // 逐字节账本：received（ws 帧）/ written（进 xterm）/ acked（解析完）
    // 三者应收敛到同一数值；droppedBytes 恒为 0。
    this._receivedBytes = 0
    this._writtenBytes = 0
    this._ackedBytes = 0
    this._suppressedBytes = 0
    this._droppedBytes = 0
    this._archivePath = null
    this._archiveParts = []
    // Automation taps: 解码后的字符串，抑制窗口的输出也会送到（不再静默吞）。
    this._dataTaps = new Set()
    // CDP 探针 / UI 读取逐字节账本的唯一入口。
    if (typeof window !== 'undefined' && infoTabId) {
      window.__termFlowStats = window.__termFlowStats || {}
      window.__termFlowStats[infoTabId] = () => this.getLosslessStats()
    }
    // G1 广播输入：>0 表示本次 sendToServer 是别的终端镜像过来的，不再二次扇出
    this._broadcastDepth = 0
  }

  addDataTap = (fn) => {
    this._dataTaps.add(fn)
    return () => {
      this._dataTaps.delete(fn)
    }
  }

  _initBase = async () => {
    const AttachAddon = await loadAttachAddon()
    const base = new AttachAddon(this._socket, { bidirectional: this._bidirectional })
    this._sendData = base._sendData.bind(base)
  }

  onInitialData = (callback) => {
    if (this.disposed) {
      // Never let a caller wait on a dead connection.
      return
    }
    if (this.hasReceivedInitialData) {
      callback()
    } else {
      this.onInitialDataCallback = callback
    }
  }

  // Timestamp of the last chunk that arrived from the shell, updated even
  // while output is suppressed. This is what "has the terminal gone quiet?"
  // is measured against.
  getLastOutputTime = () => {
    return this._lastDataTime
  }

  /**
   * Resolve once the shell has produced no output for `idleMs`.
   * Used to pace queued startup work (shell integration injection, run
   * scripts) so the next command is never typed into a shell that is still
   * drawing the previous prompt - that race is what made run scripts get
   * dropped when sftp path following was on.
   * Never rejects and never hangs: resolves false on timeout or when the
   * connection is gone.
   */
  waitForOutputIdle = ({ idleMs = 400, timeoutMs = 3000 } = {}) => {
    if (this.disposed || !this.term) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      let done = false
      const finish = (result) => {
        if (done) {
          return
        }
        done = true
        clearInterval(pollTimer)
        clearTimeout(capTimer)
        resolve(result)
      }
      const step = Math.max(50, Math.min(idleMs, 200))
      const pollTimer = setInterval(() => {
        if (this.disposed || !this.term) {
          return finish(false)
        }
        if (Date.now() - this._lastDataTime >= idleMs) {
          finish(true)
        }
      }, step)
      const capTimer = setTimeout(() => finish(false), Math.max(idleMs, timeoutMs))
    })
  }

  /**
   * 记录本次注入的命令原文（去尾部 \r），供抑制窗口回放时剥掉它自己的
   * 回显。只影响写屏：taps / 录制 / 服务端归档在缓冲时已收下全量字节。
   */
  setInjectionEcho = (cmd) => {
    const s = String(cmd || '')
    this._injectionEcho = s ? s.replace(/\r+$/, '') : null
  }

  /**
   * 输出抑制窗口：只延后显示，不丢字节。注入期间到达的每个字节都进
   * taps / 录制 / 服务端归档，窗口结束时按序补写进 xterm——注入命令
   * 自己的回显行除外（setInjectionEcho + filterSuppressedEcho 只剥这一行，
   * 其余回显照常上屏）；找不到回显时不剥，宁可多显示不误删。
   */
  startOutputSuppression = (timeout = 3000, onEnd = null) => {
    if (this.disposed) {
      onEnd?.()
      return
    }
    // A suppression may already be running (e.g. the 500ms keepalive one).
    // Starting another must end it first, otherwise its timer stays armed and
    // fires in the middle of the new window, flushing half-collected output.
    if (this.outputSuppressed) {
      const previous = this.onSuppressionEndCallback
      this.onSuppressionEndCallback = null
      if (this.suppressTimeout) {
        clearTimeout(this.suppressTimeout)
        this.suppressTimeout = null
      }
      this.outputSuppressed = false
      previous?.()
    }
    this.outputSuppressed = true
    this.suppressedData = []
    this.suppressedChars = 0
    this.onSuppressionEndCallback = onEnd
    this.suppressTimeout = setTimeout(() => {
      this.stopOutputSuppression()
    }, timeout)
  }

  stopOutputSuppression = () => {
    if (this.suppressTimeout) {
      clearTimeout(this.suppressTimeout)
      this.suppressTimeout = null
    }
    this.outputSuppressed = false
    const needle = this._injectionEcho
    this._injectionEcho = null
    const pending = filterSuppressedEcho(this.suppressedData, needle)
    this.suppressedData = []
    this.suppressedChars = 0
    // 按序补写：窗口内每个字节交给 xterm，注入回显行除外——其空片段
    // （str='' + bytes>0）走 _enqueueWrite 的纯 ACK 通道，账目按原帧全额
    // 记，只是不写屏。连接已关闭时不再写屏幕（term 即将销毁），字节仍在
    // 服务端无损归档里。
    if (!this.disposed) {
      for (const item of pending) {
        this._enqueueWrite(item.str, item.bytes)
      }
    }
    if (this.onSuppressionEndCallback) {
      const callback = this.onSuppressionEndCallback
      this.onSuppressionEndCallback = null
      callback()
    }
  }

  activate = async (terminal = this.term) => {
    // 消息监听必须在 await loadAttachAddon 之前挂上：动态 import 期间到达的帧
    // 仍能被接收，避免首屏 banner 在监听就绪前丢失。
    this.addSocketListener(this._socket, 'message', this.onMsg)
    await this._initBase()
    // 广播目标按 tab 查找真实连接：注册点在 activate，未连上的 tab 天然收不到
    registerBroadcastAddon(this.infoTabId, this)

    if (this._bidirectional) {
      this._disposables.push(terminal.onData((data) => this.sendToServer(data)))
      this._disposables.push(terminal.onBinary((data) => this.sendToServer(new Uint8Array(data))))
    }

    this._disposables.push(this.addSocketListener(this._socket, 'close', () => this.dispose()))
    this._disposables.push(this.addSocketListener(this._socket, 'error', () => this.dispose()))
  }

  onMsg = (ev) => {
    this._lastDataTime = Date.now()
    this.trafficTracker?.countDown(ev.data)
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data)
        const controlActions = [
          'zmodem-event',
          'trzsz-event',
          'xmodem-event',
          // serial line status, see session/serial-control.jsx
          'serial-event',
          // how the pty ended, consumed by the terminal component
          'session-exit'
        ]
        if (msg.action === 'keepalive-probe') {
          this._startDsrProbe()
          return
        }
        // 服务端告知本会话无损归档文件位置；该消息不是终端输出。
        if (msg.action === FLOW_ACTIONS.archive) {
          this._archivePath = typeof msg.dir === 'string' ? msg.dir : (typeof msg.path === 'string' ? msg.path : null)
          this._archiveParts = Array.isArray(msg.parts) ? msg.parts : (msg.path ? [msg.path] : [])
          return
        }
        // 无损归档降级（磁盘不可用 / 写失败）：已在服务端记账，这里只提示用户，
        // 屏幕输出不受影响。
        if (msg.action === 'output-archive-error') {
          console.warn('[AttachAddon] lossless output archive degraded:', msg.message)
          window.store?.onTerminalArchiveError?.(this.infoTabId, msg.message)
          return
        }
        if (controlActions.includes(msg.action)) {
          return
        }
        // 会话顶栏控制消息 (ssh-handshake-info 等): 交给公共模块写入 store
        if (handleSessionControlMessage(msg, this.infoTabId)) {
          return
        }
      } catch (e) {
        // 控制消息解析失败降级为普通终端写入，属预期兜底；高频路径用 debug 防刷屏
        console.debug('[AttachAddon] session control msg parse fails:', e.message)
      }
    }

    this.writeToTerminal(ev.data)
  }

  static passwordPromptPatterns = [
    /password\s*[:\]>]\s*$/i,
    /\[sudo\]\s*password\s+for\s+\S+\s*:\s*$/i,
    /enter\s+passphrase/i,
    /enter\s+password/i,
    /密码[：:]\s*$/,
    /パスワード[：:]\s*$/,
    /mot de passe\s*[:\]]\s*$/i,
    /passwort[:\]]\s*$/i,
    /contraseña[:\]]\s*$/i
  ]

  _checkPasswordPrompt = (str) => {
    // Extract last non-empty line from the output
    const lines = str.split(/\r?\n|\r/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line) {
        this._lastOutputLine = line
        break
      }
    }
    return AttachAddonCustom.passwordPromptPatterns.some(
      p => p.test(this._lastOutputLine)
    )
  }

  _onEchoCheckTimeout = () => {
    // No echo received within timeout → confirms password mode
    this._pendingEchoCheck = null
  }

  _handleEchoDetection = (str) => {
    if (this._pendingEchoCheck) {
      // Server sent data back while we were waiting → echo is ON → not password
      if (str.includes(this._pendingEchoCheck.char)) {
        this._passwordPromptDetected = false
        clearTimeout(this._echoCheckTimer)
        this._pendingEchoCheck = null
        this._echoCheckTimer = null
        // 有回显说明不是密码提示: 恢复录制
        this.recorder?.resume()
        // 广播红条同步解除"已暂停"
        window.store?.clearBroadcastBlocked?.()
        // Cancel the password dropdown if it was shown
        this.term?.parent?.onPasswordPromptCancelled?.()
      }
    }
  }

  // Index of the first OSC 633 sequence in the chunk, or -1.
  indexOfShellIntegration = (str) => {
    const ESC = String.fromCharCode(27)
    return str.indexOf(ESC + ']633;')
  }

  /** 解码后的字符串与原始字节一起进完整账本：taps / 录制一个不落。 */
  _notifyDataConsumers = (str) => {
    if (this._dataTaps.size) {
      for (const fn of this._dataTaps) {
        try {
          fn(str)
        } catch (e) {
          console.error('[dataTap]', e)
        }
      }
    }
    this.recorder?.onData(str)
  }

  writeToTerminal = (data) => {
    const bytes = bytesOf(data)
    this._receivedBytes += bytes
    if (this.disposed || !this.term) {
      // 连接已关闭：字节在服务端无损归档里，账本照记，绝不静默吞。
      return
    }
    // term.parent.onZmodem 早退已删除：全仓从未给它赋值，这个死分支
    // 过去会静默吞掉整段输出。

    if (!this.hasReceivedInitialData) {
      this.hasReceivedInitialData = true
      if (this.onInitialDataCallback) {
        const callback = this.onInitialDataCallback
        this.onInitialDataCallback = null
        setTimeout(callback, 0)
      }
    }

    // Decode once, synchronously, in streaming mode: a multi-byte UTF-8 char
    // split across TCP segments must be carried over, not turned into U+FFFD.
    let str = data
    if (typeof data !== 'string') {
      try {
        str = this.decoder.decode(
          data instanceof ArrayBuffer ? data : new Uint8Array(data),
          { stream: true }
        )
      } catch (e) {
        str = ''
      }
    }

    // 抑制窗口只「延后显示」，不再丢弃。窗口内每个字节都进 taps / 录制 /
    // 服务端归档，窗口结束（OSC 633 或超时）时按序补写进 xterm。
    if (this.outputSuppressed) {
      if (this.indexOfShellIntegration(str) !== -1) {
        this.stopOutputSuppression()
      } else {
        this._notifyDataConsumers(str)
        this.suppressedData.push({ str, bytes })
        this.suppressedChars += str.length
        this._suppressedBytes += bytes
        return
      }
    }

    this._notifyDataConsumers(str)
    this._handleEchoDetection(str)
    if (this._checkPasswordPrompt(str) && !this._passwordPromptDetected) {
      this._passwordPromptDetected = true
      window.store?.setBroadcastBlocked?.('password')
      if (window.store?.config?.recordAvoidPassword !== false) {
        this.recorder?.pause()
      }
      setTimeout(() => {
        this.term?.parent?.onPasswordPromptDetected?.()
      }, 100)
    }
    this._enqueueWrite(str, bytes)
  }

  /**
   * 唯一写入入口。bytes 是 ws 帧原始字节数；解码得到空串（UTF-8 分片被
   * TextDecoder 暂时吞下）时字节不能从账本消失，直接回 ACK —— 该字节已在
   * decoder 里被消费，补齐后会出现在下一个非空 chunk 中。
   */
  _enqueueWrite = (str, bytes = 0) => {
    if (this.disposed) {
      return
    }
    if (!str) {
      if (bytes > 0) {
        this._ackedBytes += bytes
        this._sendAck(bytes)
      }
      return
    }
    this._pending.push({ str, bytes })
    this._pendingBytes += bytes
    this._pump()
  }

  _pump = () => {
    if (this.disposed || this._writeInFlight || !this._pending.length) {
      return
    }
    // 隐藏窗口的定时器被 Chromium 节流，等 16ms 没有意义：直接写，
    // 由 term.write 回调继续驱动，绝不靠丢数据追平。
    if (typeof document !== 'undefined' && document.hidden) {
      this._flushWrites()
      return
    }
    const elapsed = Date.now() - this._lastFlushTime
    if (elapsed >= this._flushIntervalMs) {
      this._flushWrites()
      return
    }
    if (!this._flushScheduled) {
      this._flushScheduled = true
      this._flushTimer = setTimeout(this._flushWrites, this._flushIntervalMs - elapsed)
    }
  }

  _flushWrites = () => {
    this._flushScheduled = false
    clearTimeout(this._flushTimer)
    this._flushTimer = null
    if (this._writeInFlight || !this._pending.length || !this.term) {
      return
    }
    // 取出不超过上限的前缀；其余留队下次发，严格保序，绝不丢。
    let batch
    let bytes
    if (this._pendingBytes > this._maxFlushBytes) {
      batch = []
      let acc = 0
      while (this._pending.length && acc < this._maxFlushBytes) {
        const item = this._pending.shift()
        batch.push(item)
        acc += item.bytes
      }
      this._pendingBytes -= acc
      bytes = acc
    } else {
      batch = this._pending
      this._pending = []
      this._pendingBytes = 0
      bytes = batch.reduce((n, b) => n + b.bytes, 0)
    }
    const data = batch.length === 1 ? batch[0].str : batch.map(b => b.str).join('')
    const { term } = this
    const token = ++this._inflightToken
    this._lastFlushTime = Date.now()
    this._writeInFlight = true
    this._inflightBytes = bytes
    this._writtenBytes += bytes
    this._inflightBatch = { data, bytes, token }
    this._armWriteWatchdog()
    const onDone = () => {
      // 批次已被看门狗接管重发：忽略迟到的旧回调，避免双 ACK / 双推进。
      if (this._inflightToken !== token) {
        return
      }
      this._clearWriteWatchdog()
      this._writeInFlight = false
      this._inflightBytes = 0
      this._inflightBatch = null
      this._retryCount = 0
      // xterm 已解析完这一批 —— 这才是「消费完成」的可靠信号。
      this._recordLineBaseline()
      this._ackedBytes += bytes
      this._sendAck(bytes)
      term?.parent?.notifyOnData?.()
      term?.parent?.onTerminalWrite?.()
      this._pump()
    }
    try {
      term.write(data, onDone)
    } catch (e) {
      // xterm 内部写缓冲抛错（理论上已被 _maxFlushBytes 杜绝）：整批原样回队
      // 重试，带退避上限，绝不丢。
      this._clearWriteWatchdog()
      this._writeInFlight = false
      this._inflightBytes = 0
      this._writtenBytes -= bytes
      this._inflightBatch = null
      this._pending.unshift({ str: data, bytes })
      this._pendingBytes += bytes
      this._retryCount += 1
      if (this._retryCount > 100) {
        // 降级：绕过可能出问题的 wrapper，直接交原始 write 尝试写屏，仍不丢批。
        console.error('[AttachAddon] term.write repeatedly failed; last-resort direct write', e)
        this._retryCount = 0
        try {
          (term.__originalWrite || term.write)(data, onDone)
        } catch (_) {}
        return
      }
      console.error('[AttachAddon] term.write failed, output kept queued:', e)
      clearTimeout(this._retryTimer)
      this._retryTimer = setTimeout(this._pump, 100)
    }
  }

  // 兜底看门狗：正常路径下 term.write 回调毫秒级触发；若某批回调长时间未到
  // （极端回调丢失），10s 后把该批回队重发并复位 _writeInFlight，防止 FIFO 冻结。
  _armWriteWatchdog = () => {
    this._clearWriteWatchdog()
    this._writeWatchdog = setTimeout(() => {
      if (!this._writeInFlight || this.disposed) {
        return
      }
      const stuck = this._inflightBatch
      console.error('[AttachAddon] term.write callback stalled >10s; re-queuing batch', stuck && stuck.bytes)
      this._writeInFlight = false
      this._inflightBytes = 0
      this._writtenBytes -= (stuck ? stuck.bytes : 0)
      if (stuck) {
        this._inflightBatch = null
        this._pending.unshift({ str: stuck.data, bytes: stuck.bytes })
        this._pendingBytes += stuck.bytes
      }
      this._pump()
    }, 10000)
  }

  _clearWriteWatchdog = () => {
    if (this._writeWatchdog) {
      clearTimeout(this._writeWatchdog)
      this._writeWatchdog = null
    }
  }

  _sendAck = (bytes) => {
    const sock = this._socket
    if (bytes <= 0 || !sock || sock.readyState !== 1 /* OPEN */) {
      return
    }
    try {
      sock.send(JSON.stringify({ action: FLOW_ACTIONS.ack, n: bytes }))
    } catch (e) {
      console.debug('[AttachAddon] flow ack failed:', e.message)
    }
  }

  /** 逐字节账本：droppedBytes 恒为 0；CDP 探针据此做零丢弃验收。 */
  getLosslessStats = () => ({
    receivedBytes: this._receivedBytes,
    writtenBytes: this._writtenBytes,
    ackedBytes: this._ackedBytes,
    pendingBytes: this._pendingBytes,
    inflightBytes: this._inflightBytes,
    suppressedBytes: this._suppressedBytes,
    droppedBytes: this._droppedBytes,
    archivePath: this._archivePath,
    archiveParts: this._archiveParts.slice()
  })

  // Best-effort bookkeeping of what sits on the current command line. Only
  // answers "could there be input we saw no printable character for?"; whether
  // a newline is safe to send is decided by _lineHasUnsubmittedInput.
  _trackPendingInput = (data) => {
    if (typeof data !== 'string') {
      // Mouse reports in the default (X10) encoding arrive through
      // terminal.onBinary as a Uint8Array. They never type a character, and
      // this runs before _sendData, so throwing here would swallow the click.
      return
    }
    if (data.startsWith(ESC)) {
      // Cursor keys, history recall, bracketed paste: the resulting line
      // content is unknown (Up can put a whole command on the line).
      this._pendingInputUnknown = true
      return
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
        this._pendingInputLength = 0
        this._pendingInputUnknown = false
      } else if (ch === '\x7f' || ch === '\b') {
        this._pendingInputLength = Math.max(0, this._pendingInputLength - 1)
        // Backspacing back to an empty line means the content is known again,
        // so a later idle probe is safe to run.
        if (this._pendingInputLength === 0) {
          this._pendingInputUnknown = false
        }
      } else if (ch >= ' ') {
        this._pendingInputLength += 1
      }
    }
  }

  sendToServer = (data) => {
    if (this._isDsrReply(data)) {
      // Terminal-generated answer to our keepalive probe - see _startDsrProbe.
      this._dsrReplyExpected = false
      clearTimeout(this._dsrReplyTimer)
      this._dsrReplyTimer = null
      return
    }
    this._lastInputTime = Date.now()
    this.trafficTracker?.countUp(data)
    // 密码提示状态在本次输入处理中可能被重置（回车结束密码输入），
    // 镜像判定必须用"处理前"的快照，否则提交密码的那个回车会被打到所有目标上。
    const wasPasswordPrompt = this._passwordPromptDetected
    // Track half-typed input so the keepalive probe knows the line is not
    // readable (see _trackPendingInput)
    this._trackPendingInput(data)
    // Start echo detection when password prompt is suspected
    if (this._passwordPromptDetected && !this._pendingEchoCheck && data !== '\r' && data !== '\n' && data !== '\x03') {
      this._pendingEchoCheck = { char: data, time: Date.now() }
      clearTimeout(this._echoCheckTimer)
      this._echoCheckTimer = setTimeout(this._onEchoCheckTimeout, 200)
    }
    // Reset password state on Enter or Ctrl+C
    if (data === '\r' || data === '\n' || data === '\x03') {
      if (this._passwordPromptDetected) {
        this.term?.parent?.onPasswordPromptCancelled?.()
        // 密码输入结束: 恢复录制 (输入密码期间 recorder.pause 避录)
        this.recorder?.resume()
        // 广播红条从"已暂停"恢复（非主控时 store 侧 no-op）
        window.store?.clearBroadcastBlocked?.()
      }
      this._passwordPromptDetected = false
      this._lastOutputLine = ''
      this._pendingEchoCheck = null
      clearTimeout(this._echoCheckTimer)
      this._echoCheckTimer = null
    }
    // 输入录制 (asciinema i 事件): 与输出同源单点挂接, 受 recordInput 配置控制
    if (typeof data === 'string') {
      this.recorder?.onInput(data)
    }
    this._sendData(data)
    this._mirrorBroadcast(data, wasPasswordPrompt)
  }

  // G1 广播输入：在唯一输入汇聚点做扇出。密码期/OSC 应答/防环判定都在
  // term-broadcast.js（纯函数），这里只负责读 store 状态与上报"暂停"。
  _mirrorBroadcast = (data, wasPasswordPrompt) => {
    const store = typeof window === 'undefined' ? null : window.store
    const state = store && store.broadcast
    if (!this.infoTabId || !state || !state.on || state.sourceTabId !== this.infoTabId) {
      return
    }
    if (wasPasswordPrompt) {
      // 主控正在输密码：不镜像（否则 sudo 密码会打到所有目标机）
      // 结束密码的 Enter/Ctrl+C 不再置回 blocked —— sendToServer 已经清掉，
      // 再置回来会让广播永久卡在"已暂停"（后续输入全被闸门拦掉）
      if (data !== '\r' && data !== '\n' && data !== '\x03') {
        store.setBroadcastBlocked?.('password')
      }
      return
    }
    mirrorInput({
      state,
      sourceTabId: this.infoTabId,
      data,
      passwordPrompt: wasPasswordPrompt,
      depth: this._broadcastDepth
    })
  }

  _startKeepalive = () => {
    this._stopKeepalive()
    this._keepaliveTimer = setInterval(this._checkKeepalive, this._keepaliveInterval)
  }

  _stopKeepalive = () => {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
    }
  }

  // The input line as the terminal renders it: absolute buffer row plus text,
  // trailing blanks trimmed. null when there is nothing to read (no terminal,
  // or a full-screen app owns the alternate screen).
  _readInputLine = () => {
    const buf = this.term?.buffer?.active
    if (!buf || buf.type === 'alternate' || typeof buf.getLine !== 'function') {
      return null
    }
    const row = (buf.baseY || 0) + (buf.cursorY || 0)
    const line = buf.getLine(row)
    return line ? { row, text: line.translateToString(true) } : null
  }

  // Sample the input line once xterm has parsed a chunk. While nothing is
  // pending this is a prompt with an empty line - the state a keepalive probe
  // is worth running in - so it becomes the reference to compare against.
  // Skipped while input is pending or of unknown length, so the echo of what
  // the user typed (or a recalled command) never becomes the new reference.
  _recordLineBaseline = () => {
    if (this.disposed || this._pendingInputLength > 0 || this._pendingInputUnknown) {
      return
    }
    const info = this._readInputLine()
    this._lineBaseline = info ? { row: info.row, length: info.text.length } : null
  }

  // Is there anything on the input line we can not account for? The keepalive
  // probe holds off while the answer is yes - a full-screen app owns the escape
  // traffic and may be running its own queries, a hidden prompt can not be read
  // back, and an unexpected line means the screen is not the bare prompt we
  // think it is. Holding off only delays a probe; nothing is ever typed for the
  // user (that was #4628).
  _lineHasUnsubmittedInput = () => {
    // A password prompt hides what it reads, so the screen tells us nothing
    // about the state we would be probing into.
    if (this._passwordPromptDetected) {
      return true
    }
    // Typed characters with no echo back (read -s, a hidden prompt in a nested
    // program): the screen can not show them, only the byte count knows.
    if (this._pendingInputLength > 0) {
      return true
    }
    const buf = this.term?.buffer?.active
    if (buf && buf.type === 'alternate') {
      // vim/less/top own the screen and its escape sequences.
      return true
    }
    const info = this._readInputLine()
    const base = this._lineBaseline
    if (!info || !base) {
      // No readable line yet: fall back to the keystroke tracking alone.
      return this._pendingInputUnknown
    }
    // A longer line than the bare prompt - or a line on a different row, which
    // is what a wrapped or recalled command looks like - means content.
    return info.row !== base.row || info.text.length > base.length
  }

  // The answer to our own query is terminal-generated, so it must never leave
  // the renderer: forwarded, it becomes keystrokes in the PTY (and, worse, an
  // escape sequence that latches _pendingInputUnknown and silences every later
  // keepalive). Only an exact ESC[0n is swallowed, and only while a probe is
  // outstanding: a program that queries the cursor position answers with a
  // different sequence (ESC[<row>;<col>R), so its reply still reaches the
  // reader it belongs to.
  _startDsrProbe = () => {
    if (this.disposed || !this.term || this._dsrReplyExpected) {
      return
    }
    this._dsrReplyExpected = true
    this._dsrReplyTimer = setTimeout(() => {
      this._dsrReplyExpected = false
      this._dsrReplyTimer = null
    }, DSR_REPLY_TIMEOUT)
    // term.write is the display stream: the query never reaches the PTY.
    this.term.write(DSR_PROBE)
  }

  _isDsrReply = (data) => {
    return this._dsrReplyExpected && data === DSR_REPLY
  }

  _checkKeepalive = () => {
    if (this.outputSuppressed) {
      return
    }
    // Don't probe while the screen belongs to someone else: a full-screen app
    // owns the escape traffic, a password prompt can not show us its line, and
    // a half-typed command means we cannot tell an idle prompt from an idle
    // reader. Skipping only delays the probe - nothing is ever typed for the
    // user, which is the whole point of #4628.
    if (this._lineHasUnsubmittedInput()) {
      return
    }
    const now = Date.now()
    const idleSinceData = now - this._lastDataTime
    const idleSinceInput = now - this._lastInputTime
    if (idleSinceData >= this._keepaliveInterval && idleSinceInput >= this._keepaliveInterval) {
      // Ask the server whether the session is still there; it answers with a
      // keepalive-probe control message that arms the DSR round trip above.
      // Connection-level keepalive is ssh2's own job (keepaliveInterval in the
      // connect options), so nothing here touches the PTY any more - see
      // session-server.js. The side effect this used to have, an echoed
      // newline and a 500ms window of discarded output, is gone with it; the
      // trade-off is that a shell with TMOUT set will no longer be woken up.
      const sock = this._socket
      if (sock && sock.readyState === 1 /* OPEN */) {
        sock.send(JSON.stringify({ action: 'keepalive' }))
      }
    }
  }

  setKeepalive = (enabled) => {
    if (enabled) {
      this._startKeepalive()
    } else {
      this._stopKeepalive()
    }
  }

  addSocketListener = (socket, type, handler) => {
    socket.addEventListener(type, handler)
    return {
      dispose: () => {
        if (!handler) {
          return
        }
        socket.removeEventListener(type, handler)
      }
    }
  }

  dispose = () => {
    if (this.disposed) {
      return
    }
    this.disposed = true
    // 广播：注销连接并让 store 把该 tab 移出目标（tab 已关闭时 store 侧静默）
    unregisterBroadcastAddon(this.infoTabId, this)
    if (this.infoTabId) {
      window.store?.onBroadcastAddonClosed?.(this.infoTabId)
    }
    this.trafficTracker?.stop()
    this.trafficTracker = null
    // tab 关闭兜底停录: 落盘尾部缓冲
    this.recorder?.stop()
    this.recorder = null
    this._stopKeepalive()
    this._clearWriteWatchdog()
    clearTimeout(this._echoCheckTimer)
    this._echoCheckTimer = null
    // A probe awaiting its answer dies with the connection.
    clearTimeout(this._dsrReplyTimer)
    this._dsrReplyTimer = null
    this._dsrReplyExpected = false
    // End any pending suppression *before* dropping `term`, so the callback
    // (and the promise the startup queue is awaiting) is released instead of
    // hanging forever on a connection that is already gone. 连接已断时窗口内
    // 的字节不再补写屏幕，但服务端无损归档已逐字节收下，不是静默丢弃。
    this.stopOutputSuppression()
    this.onInitialDataCallback = null
    clearTimeout(this._flushTimer)
    this._flushTimer = null
    clearTimeout(this._retryTimer)
    this._retryTimer = null
    this._flushScheduled = false
    if (this._pendingBytes || this._inflightBytes) {
      console.warn(`[AttachAddon] connection closed with ${this._pendingBytes + this._inflightBytes} output bytes still queued; full stream is in the lossless archive: ${this._archivePath || '(path not reported)'}`)
    }
    this._pending = []
    this._pendingBytes = 0
    this._writeInFlight = false
    this._inflightBytes = 0
    this._dataTaps.clear()
    if (typeof window !== 'undefined' && window.__termFlowStats && this.infoTabId) {
      delete window.__termFlowStats[this.infoTabId]
    }
    // Reset the streaming decoder so any partial multi-byte sequence held
    // over from this connection can not leak into a reused instance.
    this.decoder = new TextDecoder('utf-8')
    this.term = null
    this._disposables.forEach(d => d.dispose())
    this._disposables.length = 0
  }
}
