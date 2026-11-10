/**
 * MCP client — stdio transport.
 *
 * One transport instance == one child process. Everything the user starts must
 * come back down again (M9), so `close()` is the important half of this file:
 * it detaches listeners first, then SIGTERM → grace → SIGKILL, and only
 * resolves once the process is actually gone.
 *
 * Spawn failures are translated into readable text before they reach the
 * session (`ENOENT` on `npx`-less machines is the common one) — the IPC
 * boundary must never see a raw stack.
 */

const { spawn } = require('node:child_process')
const { LineDecoder } = require('./line-decoder')
const { McpRpcError, ERR } = require('./rpc')

const STDERR_TAIL_LINES = 200
const SPAWN_TIMEOUT_MS = 10000
const DEFAULT_KILL_TIMEOUT_MS = 2000

/**
 * Turn a spawn error into something a user can act on.
 * @param {string} command
 * @param {*} err
 * @returns {string}
 */
function describeSpawnError (command, err) {
  const code = err && (err.code || (err.cause && err.cause.code))
  const hint = code === 'ENOENT'
    ? 'command not found — install it or fix the command path'
    : code === 'EACCES'
      ? 'command is not executable'
      : code === 'ENOTDIR'
        ? 'cwd is not a directory'
        : (err && err.message) || 'spawn failed'
  return `cannot start MCP server "${command}": ${hint}`
}

/**
 * Promise that never keeps the event loop alive.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep (ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })
}

class StdioTransport {
  /**
   * @param {{
   *   command: string, args?: string[], cwd?: string, env?: object,
   *   onMessage?: Function, onClose?: Function, onStderr?: Function,
   *   onProtocolError?: Function, spawnImpl?: Function,
   *   maxLineBytes?: number, killTimeoutMs?: number, label?: string
   * }} opts
   */
  constructor ({
    command,
    args = [],
    cwd = '',
    env = {},
    onMessage = null,
    onClose = null,
    onStderr = null,
    onProtocolError = null,
    spawnImpl = spawn,
    maxLineBytes = undefined,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    label = ''
  } = {}) {
    this.command = command
    this.args = Array.isArray(args) ? args : []
    this.cwd = cwd || ''
    this.env = env || {}
    this.onMessage = onMessage
    this.onClose = onClose
    this.onStderr = onStderr
    this.onProtocolError = onProtocolError
    this.spawnImpl = spawnImpl
    this.maxLineBytes = maxLineBytes
    this.killTimeoutMs = killTimeoutMs
    this.label = label
    this.child = null
    this.decoder = null
    this.stderrTail = []
    this.closed = false
    this.closeReason = ''
    this.exitInfo = null
    this._listeners = []
  }

  /** @returns {number|null} */
  get pid () {
    return (this.child && this.child.pid) || null
  }

  /** @returns {boolean} */
  get exited () {
    return this.closed || this.exitInfo !== null
  }

  /**
   * Spawn the process and wire up framing.
   * @returns {Promise<{pid: number|null}>}
   */
  async start () {
    if (this.child) {
      return { pid: this.pid }
    }
    if (this.closed) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, 'stdio transport was already closed')
    }
    let child
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd || undefined,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, describeSpawnError(this.command, err))
    }
    this.child = child
    this.decoder = new LineDecoder(
      this.maxLineBytes ? { maxLineBytes: this.maxLineBytes } : {}
    )

    const spawned = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new McpRpcError(
          ERR.TRANSPORT_CLOSED,
          `spawn of "${this.command}" did not complete within ${SPAWN_TIMEOUT_MS} ms`
        ))
      }, SPAWN_TIMEOUT_MS)
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      child.once('spawn', () => {
        clearTimeout(timer)
        resolve()
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(new McpRpcError(ERR.TRANSPORT_CLOSED, describeSpawnError(this.command, err)))
      })
    })

    this._wire(child)
    await spawned
    return { pid: this.pid }
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @private
   */
  _wire (child) {
    const onStdout = (chunk) => {
      let lines
      try {
        lines = this.decoder.push(chunk)
      } catch (err) {
        // oversized line == protocol error; the session closes the connection
        if (this.onProtocolError) {
          this.onProtocolError(new McpRpcError(ERR.PROTOCOL, err.message))
        }
        return
      }
      for (const line of lines) {
        let msg
        try {
          msg = JSON.parse(line)
        } catch (_) {
          if (this.onProtocolError) {
            this.onProtocolError(new McpRpcError(
              ERR.PROTOCOL,
              `server wrote a non-JSON line (${line.slice(0, 120)})`
            ))
          }
          continue
        }
        if (this.onMessage) {
          this.onMessage(msg)
        }
      }
    }

    const onStderr = (chunk) => {
      const text = chunk.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line) {
          continue
        }
        this.stderrTail.push(line)
        if (this.stderrTail.length > STDERR_TAIL_LINES) {
          this.stderrTail.shift()
        }
        if (this.onStderr) {
          this.onStderr(line)
        }
      }
    }

    const onExit = (code, signal) => {
      this.exitInfo = { code, signal }
      if (this.onClose) {
        this.onClose({ code, signal })
      }
    }

    const onError = (err) => {
      // Post-spawn errors (EPIPE on a dead child, EPERM on kill) mean the
      // connection is gone, not that start() failed.
      if (this.onProtocolError) {
        this.onProtocolError(new McpRpcError(
          ERR.TRANSPORT_CLOSED,
          describeSpawnError(this.command, err)
        ))
      }
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.on('exit', onExit)
    child.on('error', onError)
    this._listeners = [
      () => child.stdout && child.stdout.removeListener('data', onStdout),
      () => child.stderr && child.stderr.removeListener('data', onStderr),
      () => child.removeListener('exit', onExit),
      () => child.removeListener('error', onError)
    ]
  }

  /**
   * Write one JSON-RPC message as a single line.
   * @param {object} msg
   */
  send (msg) {
    const child = this.child
    if (this.closed || !child || !child.stdin || child.stdin.destroyed || this.exitInfo) {
      throw new McpRpcError(ERR.TRANSPORT_CLOSED, 'stdio transport is closed')
    }
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /**
   * Signal the child synchronously, without waiting for the event loop.
   *
   * `close()` is the correct way to stop a server (it awaits the real exit), but
   * it is async, and an app that is already in `will-quit` may never run another
   * microtask. This exists so that path cannot leave an orphan behind (M9).
   * @param {string} [signal]
   */
  killNow (signal = 'SIGTERM') {
    const child = this.child
    if (!child || this.exitInfo) {
      return
    }
    try {
      child.kill(signal)
    } catch (_) {
      // already dead
    }
  }

  /**
   * Stop the child process and wait until it is really gone.
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async close (reason = 'user') {
    if (this.closed) {
      return
    }
    this.closed = true
    this.closeReason = reason
    const child = this.child
    for (const detach of this._listeners) {
      try {
        detach()
      } catch (_) {
        // best effort: a listener may already be gone with the stream
      }
    }
    this._listeners = []
    if (child && child.stdin) {
      try {
        child.stdin.end()
      } catch (_) {
        // the pipe may already be broken; the kill below is what matters
      }
    }
    if (!child || this.exitInfo) {
      return
    }
    if (child.pid === undefined) {
      // The spawn never produced a process (ENOENT/EACCES). There is nothing to
      // kill and no 'exit' event will ever come, so waiting for the grace
      // period here would just delay the error by the full kill timeout.
      return
    }
    const exited = new Promise((resolve) => {
      child.once('exit', resolve)
    })
    try {
      child.kill('SIGTERM')
    } catch (_) {
      // already dead
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (_) {
        // already dead
      }
    }, this.killTimeoutMs)
    if (typeof killTimer.unref === 'function') {
      killTimer.unref()
    }
    await Promise.race([exited, sleep(this.killTimeoutMs + 1000)])
    clearTimeout(killTimer)
  }
}

module.exports = {
  StdioTransport,
  STDERR_TAIL_LINES,
  SPAWN_TIMEOUT_MS,
  describeSpawnError
}
