/**
 * CommandTrackerAddon - Tracks the current command in the terminal
 *
 * This addon uses Shell Integration via OSC 633 escape sequences for reliable
 * command tracking. The shell emits special sequences that tell us:
 * - OSC 633 ; A - Prompt started
 * - OSC 633 ; B - Command input started (ready for typing)
 * - OSC 633 ; C - Command execution started (output begins)
 * - OSC 633 ; D ; <exitCode> - Command finished
 * - OSC 633 ; E ; <command> - The command line being executed
 * - OSC 633 ; P ; Cwd=<path> - Current working directory
 *
 * This properly handles:
 * - Command history (arrow up/down)
 * - Tab completion
 * - Paste operations
 * - Shell-side editing (readline, vi-mode)
 * - Multi-line commands
 * - Any custom prompt
 */

export class CommandTrackerAddon {
  constructor () {
    this.terminal = undefined
    this._disposables = []

    // Shell integration state
    this.currentCommand = '' // Command being typed
    this.executedCommand = '' // Last executed command
    this.lastExitCode = null
    this.cwd = ''
    this.shellIntegrationActive = false
    // 是否收到过真实的 OSC 633;E 命令上报。633;A 激活信号可能假阳性
    // （注入回显字面序列等），历史记录的 manual 兜底只有在确认
    // 集成真的在上报命令后才让位，避免两头全空导致历史全丢
    this.reportedCommand = false

    // Event callbacks for shell integration events
    this._onCommandExecuted = null // Called when OSC 633;E is received
    this._onCwdChanged = null // Called when OSC 633;P;Cwd= is received
    // Multi-subscriber "a fresh prompt was drawn" signal. Used to pace
    // scripted input: OSC 633;A means the previous command has finished and
    // the shell is ready for the next one.
    this._promptListeners = new Set()
  }

  /**
   * Subscribe to "prompt started" (OSC 633;A).
   * @param {function} callback
   * @returns {function} unsubscribe
   */
  onPrompt (callback) {
    if (typeof callback !== 'function') {
      return () => {}
    }
    this._promptListeners.add(callback)
    return () => {
      this._promptListeners.delete(callback)
    }
  }

  /**
   * Register callback for when a command is executed (received via OSC 633;E)
   * @param {function} callback - Called with (command: string)
   */
  onCommandExecuted (callback) {
    this._onCommandExecuted = callback
  }

  /**
   * Register callback for when CWD changes (received via OSC 633;P;Cwd=)
   * @param {function} callback - Called with (cwd: string)
   */
  onCwdChanged (callback) {
    this._onCwdChanged = callback
  }

  activate (terminal) {
    this.terminal = terminal

    // Register OSC 633 handler for shell integration
    // OSC 633 is the VS Code / modern terminal shell integration protocol
    if (terminal.parser && terminal.parser.registerOscHandler) {
      const oscHandler = terminal.parser.registerOscHandler(633, (data) => {
        return this._handleOsc633(data)
      })
      this._disposables.push(oscHandler)
    }
  }

  dispose () {
    this.terminal = null
    this._promptListeners.clear()
    this._onCommandExecuted = null
    this._onCwdChanged = null
    if (this._disposables) {
      this._disposables.forEach(d => d.dispose())
      this._disposables.length = 0
    }
  }

  /**
   * Handle OSC 633 shell integration sequences
   * @param {string} data - The OSC data after "633;"
   * @returns {boolean} Whether the sequence was handled
   */
  _handleOsc633 (data) {
    if (!data) return false

    // Parse the sequence: first char is the command type
    const command = data.charAt(0)
    const args = data.length > 1 ? data.substring(2) : '' // Skip "X;" part

    switch (command) {
      case 'A': { // Prompt started — the previous command is done
        this.shellIntegrationActive = true
        // Reset current command when new prompt appears
        this.currentCommand = ''
        for (const cb of this._promptListeners) {
          try {
            cb()
          } catch (e) {
            console.error('[CommandTracker] prompt listener failed', e)
          }
        }
        return true
      }

      case 'B': // Command input started (after prompt)
        return true

      case 'C': // Command execution started
        return true

      case 'D': // Command finished
        // Parse exit code if provided
        if (args) {
          this.lastExitCode = parseInt(args, 10)
        } else {
          this.lastExitCode = null
        }
        return true

      case 'E': // Command line
        // The actual command being executed
        this.executedCommand = this._deserializeOscValue(args)
        this.currentCommand = this.executedCommand
        // Call the callback if registered
        if (this._onCommandExecuted && this.executedCommand) {
          // 真实上报才翻转标志：坏解析产生的空 E（或手动测试注入）
          // 不能关闭 manual 兜底，否则 OSC 记不到、manual 又让位，两头全空
          this.reportedCommand = true
          this._onCommandExecuted(this.executedCommand)
        }
        return true

      case 'P': // Property (e.g., Cwd=<path>)
        this._handleProperty(args)
        return true

      default:
        return false
    }
  }

  /**
   * Handle OSC 633 ; P property sequences
   * @param {string} data - Property data like "Cwd=/path/to/dir"
   */
  _handleProperty (data) {
    const eqIndex = data.indexOf('=')
    if (eqIndex === -1) return

    const key = data.substring(0, eqIndex)
    const value = this._deserializeOscValue(data.substring(eqIndex + 1))

    switch (key) {
      case 'Cwd': {
        const oldCwd = this.cwd
        this.cwd = value
        // Call the callback if registered and CWD actually changed
        if (this._onCwdChanged && oldCwd !== value) {
          this._onCwdChanged(value)
        }
        break
      }
      // Add more properties as needed
    }
  }

  /**
   * Deserialize OSC 633 escaped values
   * Handles: \\ -> \, \x3b -> ;
   * @param {string} value - Escaped value
   * @returns {string} Unescaped value
   */
  _deserializeOscValue (value) {
    if (!value) return ''
    return value
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\\/g, '\\')
  }

  /**
   * Get the current command (from shell integration)
   */
  getCurrentCommand () {
    return this.executedCommand || this.currentCommand || ''
  }

  /**
   * Get the last exit code (if available via shell integration)
   */
  getLastExitCode () {
    return this.lastExitCode
  }

  /**
   * Get current working directory (if available via shell integration)
   */
  getCwd () {
    return this.cwd
  }

  /**
   * Check if shell integration is active
   */
  hasShellIntegration () {
    return this.shellIntegrationActive
  }
}
