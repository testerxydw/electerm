import { debounce } from 'lodash-es'
import { refsStatic } from '../../common/ref.js'

/**
 * Lines that end the shell on purpose. `userTypeExit` decides whether a closed
 * socket closes the tab straight away or shows the "session stopped" notice,
 * so anything a user would type to leave has to be listed here.
 */
const exitCommandReg = /^(?:exit|logout)(?:\s|$)/

// 终端提示符结束标记（含尾部空格）：从行文本中提取用户键入命令时
// 定位命令起点用，getCurrentInput / 键入缓冲回退读 buffer 共用
const PROMPT_ENDINGS = ['$ ', '# ', '> ', '% ', '] ', ') ']

/**
 * Command suggestions: reading the current input straight from the terminal
 * buffer, positioning the dropdown at the cursor, and the password prompt
 * variant triggered by the shell integration OSC sequences.
 */
export const suggestionsMixin = {
  getCursorPosition () {
    if (!this.term) return null

    // Get the active buffer and cursor position
    const buffer = this.term.buffer.active
    const cursorRow = buffer.cursorY
    const cursorCol = buffer.cursorX

    // Get dimensions from term element
    const termElement = this.term.element
    if (!termElement) return null

    // Get the exact position of the terminal element
    const termRect = termElement.getBoundingClientRect()

    // Calculate cell dimensions
    const cellWidth = termRect.width / this.term.cols
    const cellHeight = termRect.height / this.term.rows

    // Calculate absolute position relative to terminal element
    const left = Math.floor(termRect.left + (cursorCol * cellWidth))
    const top = Math.floor(termRect.top + ((cursorRow + 1) * cellHeight))

    return {
      cellWidth,
      cellHeight,
      left,
      top
    }
  },

  closeSuggestions () {
    refsStatic
      .get('terminal-suggestions')
      ?.closeSuggestions()
  },

  openSuggestions (cursorPos, data) {
    refsStatic
      .get('terminal-suggestions')
      ?.openSuggestions(cursorPos, data)
  },

  /**
   * Read current input directly from terminal buffer
   * This is more reliable than tracking character-by-character
   */
  getCurrentInput () {
    if (!this.term) return ''

    const buffer = this.term.buffer.active
    const cursorY = buffer.cursorY
    const cursorX = buffer.cursorX

    // Get the current line from buffer (baseY + cursorY gives absolute position)
    const absoluteY = buffer.baseY + cursorY
    const line = buffer.getLine(absoluteY)
    if (!line) return ''

    // Get text from start of line up to cursor position
    const lineText = line.translateToString(true, 0, cursorX)

    // Try to extract command after prompt
    let commandStart = 0
    for (const ending of PROMPT_ENDINGS) {
      const idx = lineText.lastIndexOf(ending)
      if (idx !== -1 && idx + ending.length > commandStart) {
        commandStart = idx + ending.length
      }
    }

    return lineText.slice(commandStart)
  },

  setCurrentInput (value) {
    this.currentInput = value
  },

  /**
   * Maintain the client-side typed-input buffer used for manual command
   * history. Reading the terminal buffer at Enter time loses commands over
   * SSH: onData fires synchronously while the echo comes from the remote
   * side, so the just-typed characters are not in the buffer yet. Local
   * echo (local pty) is immediate, which is why local terminals record
   * history fine while remote ones silently lose it.
   *
   * Best-effort rules: printable characters accumulate, backspace deletes,
   * Ctrl+C / Enter clear the line, any escape sequence (arrow keys, history
   * navigation) invalidates the buffer — after navigation the buffer read
   * fallback below is used instead, since the remote has echoed the full
   * command line by then.
   */
  handleKeyBuffer (d) {
    if (!this._keyBuf) {
      this._keyBuf = ''
    }
    this._pendingSubmit = []
    for (const ch of d) {
      if (this._escSeq) {
        if (/[a-zA-Z~]/.test(ch)) {
          this._escSeq = false
        }
        continue
      }
      if (ch === '\x1b') {
        this._escSeq = true
        this._keyBuf = ''
        continue
      }
      if (ch === '\r' || ch === '\n') {
        // 行提交（单键回车或粘贴段内换行）：攒下的缓冲是一条完整命令
        if (this._keyBuf.trim()) {
          this._pendingSubmit.push(this._keyBuf.trim())
        }
        this._keyBuf = ''
      } else if (ch === '\x03') {
        this._keyBuf = ''
      } else if (ch === '\x7f' || ch === '\b') {
        this._keyBuf = this._keyBuf.slice(0, -1)
      } else if (ch >= ' ') {
        this._keyBuf += ch
      }
    }
  },

  /**
   * Handle special input events for command history tracking
   */
  handleInputEvent (d) {
    // Ctrl+D on an empty line is EOF, which ends the shell like `exit`. Typed
    // anywhere else it is delete-char, so only an empty line counts.
    if (d === '\x04') {
      this.userTypeExit = !this.getCurrentInput().trim()
    }
    if (!d.includes('\r') && !d.includes('\n')) {
      return
    }
    const manual = this.shouldUseManualHistory()
    if (manual) {
      // 键入缓冲攒下的行（单键回车或粘贴多行段）；单键回车但缓冲为空
      // （方向键导航历史后）回退读 buffer —— 远端已回显完整命令行
      const submits = this._pendingSubmit || []
      if (!submits.length && (d === '\r' || d === '\n')) {
        const fb = this._keyBuf || this.getCurrentInput()
        if (fb && fb.trim()) {
          submits.push(fb.trim())
        }
      }
      submits.forEach(cmd => window.store.addCmdHistory(cmd))
    }
    this._pendingSubmit = []
    // Recomputed on every submitted line rather than only ever set: an
    // `exit` that did not actually end the shell must not silence the next
    // real disconnect.
    const currentCmd = this._keyBuf || this.getCurrentInput()
    this.userTypeExit = !!currentCmd && exitCommandReg.test(currentCmd.trim())
    this.closeSuggestions()
  },

  onData (d) {
    this.handleKeyBuffer(d)
    this.handleInputEvent(d)
    if (window.store.qmRecording) {
      window.store.recordQuickCommandInput(this.props.tab.id, d)
    }
    // Skip normal suggestion logic when in password mode
    const suggestions = refsStatic.get('terminal-suggestions')
    if (suggestions?.state?.passwordMode) {
      if (d === '\r' || d === '\n') {
        this.closeSuggestions()
      }
      return
    }
    if (this.props.config.showCmdSuggestions) {
      if (d === '\r' || d === '\n') {
        this.closeSuggestions()
        return
      }
      // Debounce the suggestion opening to avoid expensive work
      // (buffer read + getBoundingClientRect + React re-render) on every keystroke
      this._debouncedOpenSuggestions()
    } else {
      this.closeSuggestions()
    }
  },

  /**
   * Called by AttachAddonCustom after data is written to the terminal buffer.
   * This fires after server echo arrives, so getCurrentInput() reflects the
   * latest state. We trigger a debounced suggestion refresh so the dropdown
   * updates correctly after backspace, delete, and other edits that rely on
   * server-side echo to update the buffer.
   */
  onTerminalWrite () {
    if (!this.props.config.showCmdSuggestions) {
      return
    }
    const suggestions = refsStatic.get('terminal-suggestions')
    if (suggestions?.state?.showSuggestions && !suggestions?.state?.passwordMode) {
      this._debouncedOpenSuggestions()
    }
  },

  // One debounced runner per terminal, so a keystroke does not trigger a
  // buffer read + layout + re-render for every character.
  _debouncedOpenSuggestions () {
    if (!this._openSuggestionsDebounced) {
      this._openSuggestionsDebounced = debounce(() => {
        const data = this.getCurrentInput()
        if (!data) {
          this.closeSuggestions()
          return
        }
        const cursorPos = this.getCursorPosition()
        this.openSuggestions(cursorPos, data)
      }, 80)
    }
    this._openSuggestionsDebounced()
  },

  onPasswordPromptDetected () {
    window.store.notifyTabPasswordPrompt(this.props.tab.id)
    if (!this.props.config.showCmdSuggestions) {
      return
    }
    const cursorPos = this.getCursorPosition()
    if (cursorPos) {
      refsStatic
        .get('terminal-suggestions')
        ?.openPasswordSuggestions(cursorPos)
    }
  },

  onPasswordPromptCancelled () {
    window.store.clearTabPasswordPrompt(this.props.tab.id)
    const suggestions = refsStatic.get('terminal-suggestions')
    if (suggestions?.state?.passwordMode) {
      suggestions.closeSuggestions()
    }
  },

  getCmd () {
    return this.cmdAddon.getCurrentCommand()
  },

  getCwd () {
    // Use shell integration CWD if available
    if (this.cmdAddon && this.cmdAddon.hasShellIntegration()) {
      const cwd = this.cmdAddon.getCwd()
      if (cwd) {
        this.setCwd(cwd)
        return cwd
      }
    }
    // Fallback: no longer needed with shell integration
    return ''
  },

  setCwd (cwd) {
    this.props.setCwd(cwd, this.state.id)
  },

  shouldUseManualHistory () {
    // 633;A 激活信号可能假阳性（注入回显字面序列/部分注入成功），
    // manual 键入缓冲只有在集成真的上报过命令(633;E)后才让位，
    // 避免激活信号假阳性时 manual 与 OSC 两头全空导致历史全丢
    return !this.cmdAddon || !this.cmdAddon.hasShellIntegration() ||
      !this.cmdAddon.reportedCommand
  },

  parse (rawText) {
    let result = ''
    const len = rawText.length
    for (let i = 0; i < len; i++) {
      if (rawText[i] === '\b') {
        result = result.slice(0, -1)
      } else {
        result += rawText[i]
      }
    }
    return result
  }
}
