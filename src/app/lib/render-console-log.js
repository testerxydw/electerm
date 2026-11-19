/**
 * Mirror the renderer's `[terminal-render]` diagnostics into main.log.
 *
 * terminal-render-diagnostics.mjs and the byte ledger in attach-addon-custom.js
 * write through console.info, which in a packaged renderer exists only in
 * devtools -- and a reload or crash takes it with it, exactly when the evidence
 * is needed. Only the diagnostic prefix is copied; the rest of the renderer
 * console is never touched, so main.log stays small enough to attach.
 *
 * `warn` is deliberate: the packaged file transport runs at `warn`
 * (see common/log.js), so log.info would be filtered out.
 */
const log = require('../common/log')

const prefix = '[terminal-render] '

module.exports = function attachRenderConsoleLog (wc) {
  if (!wc || typeof wc.on !== 'function') {
    return
  }
  wc.on('console-message', (details, level, message) => {
    // Electron >= 35 passes { message, level, ... } as the first argument and
    // keeps the positional ones only for compatibility; read both.
    const text = (details && typeof details === 'object' && typeof details.message === 'string')
      ? details.message
      : (typeof message === 'string' ? message : '')
    if (text.startsWith(prefix)) {
      log.warn(text)
    }
  })
}
