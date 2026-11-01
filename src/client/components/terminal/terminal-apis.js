/**
 * terminal apis
 */

import fetch from '../../common/fetch-from-server'

export function createTerm (body) {
  return fetch({
    body,
    action: 'create-terminal'
  })
}

export function runCmd (pid, cmd, options) {
  return fetch({
    pid,
    cmd,
    action: 'run-cmd'
  }, options)
}

export function execCmd (pid, cmd, timeoutMs, options) {
  return fetch({
    pid,
    cmd,
    timeoutMs,
    action: 'exec-cmd'
  }, options)
}

// G9 隧道运行时启停：一个 action 带 op，只认 pid（= tab id）+ 该会话自己登记过的隧道 id
export function tunnelOp (pid, op, tunnelId, options) {
  return fetch({
    pid,
    op,
    tunnelId,
    action: 'tunnel-op'
  }, options)
}

export function resizeTerm (pid, cols, rows) {
  return fetch({
    pid,
    cols,
    rows,
    action: 'resize-terminal'
  })
}

export function toggleTerminalLog (pid) {
  return fetch({
    pid,
    action: 'toggle-terminal-log'
  })
}

export function toggleTerminalLogTimestamp (pid) {
  return fetch({
    pid,
    action: 'toggle-terminal-log-timestamp'
  })
}

export function setTerminalLogPath (pid, logPath) {
  return fetch({
    pid,
    logPath,
    action: 'set-terminal-log-path'
  })
}

export function startTerminalLogFile (pid, logFilePath, addTimeStampToTermLog) {
  return fetch({
    pid,
    logFilePath,
    addTimeStampToTermLog,
    action: 'start-terminal-log-file'
  })
}
