/**
 * MCP client — server list validation and normalization.
 *
 * Every rule here exists because the alternative is a runtime failure that the
 * user cannot act on: a server that never connects (empty command), a process
 * that dies on spawn (env values that are not strings), a silent downgrade to
 * plain text (non-http(s) URL), or a fork bomb (unbounded enabled servers).
 *
 * Contract: **no invalid input is ever dropped silently.** Each problem becomes
 * one entry in `errors`, tagged with the index of the offending record and the
 * field name, so the settings UI can highlight exactly what to fix and the save
 * can be refused.
 */

const uid = require('../../common/uid')

const TRANSPORTS = ['stdio', 'http']
const TRUST_LEVELS = ['readonly', 'ask', 'auto']
const MAX_SERVERS = 8
const TIMEOUT_MIN_MS = 5000
const TIMEOUT_MAX_MS = 300000
const DEFAULT_TIMEOUT_MS = 30000
const MAX_COMMAND_LENGTH = 512
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 2048
const MAX_CWD_LENGTH = 4096
const MAX_NAME_LENGTH = 128
const MAX_HEADER_VALUE_LENGTH = 4096

// Process-hijack keys: a stdio server is already "code execution as you", but a
// user pasting a config from the internet should not be able to turn "add a
// server" into "make every child process load a preload library".
const ENV_BLACKLIST = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_ENABLE_LOGGING',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH'
]

const ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * @param {number} index
 * @param {string} field
 * @param {string} message
 * @returns {{index: number, field: string, message: string}}
 */
function errorOf (index, field, message) {
  return { index, field, message }
}

/**
 * Is this a plain object (not an array, not null)?
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reject CR/LF in anything that ends up in an HTTP header or a shell argv.
 * @param {string} value
 * @returns {boolean}
 */
function hasControlChars (value) {
  return /[\r\n\0]/.test(String(value))
}

/**
 * True when the string has no C0/C1 control characters at all (tab, newline,
 * ESC …). Written as a loop instead of a regex range because an explicit
 * `[\u0000-\u001f]` literal trips `no-control-regex`, and silencing that rule
 * for a security-relevant check is how the check eventually gets deleted.
 * @param {string} value
 * @returns {boolean}
 */
function hasPrintableCharsOnly (value) {
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return false
    }
  }
  return true
}

/**
 * Normalize one record.
 * @param {*} raw
 * @param {number} index
 * @param {{generateId?: Function}} [opts]
 * @returns {{server: object, errors: Array, warnings: Array}}
 */
function normalizeServer (raw, index, opts = {}) {
  const generateId = opts.generateId || uid
  const errors = []
  const warnings = []
  if (!isPlainObject(raw)) {
    errors.push(errorOf(index, 'server', 'server must be an object'))
    return { server: null, errors, warnings }
  }

  const server = {
    id: '',
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    cwd: '',
    env: {},
    url: '',
    headers: {},
    timeoutMs: DEFAULT_TIMEOUT_MS,
    autoConnect: true,
    trust: 'ask'
  }

  // id — created when absent, never rewritten when present (aliases depend on it)
  if (raw.id === undefined || raw.id === null || raw.id === '') {
    server.id = String(generateId())
  } else if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    errors.push(errorOf(index, 'id', 'id must be 3-32 characters of [A-Za-z0-9_-]'))
  } else {
    server.id = raw.id
  }

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') {
      errors.push(errorOf(index, 'name', 'name must be a string'))
    } else if (raw.name.length > MAX_NAME_LENGTH) {
      errors.push(errorOf(index, 'name', `name must be at most ${MAX_NAME_LENGTH} characters`))
    } else if (!hasPrintableCharsOnly(raw.name)) {
      // A newline/tab in a name breaks the single-line UI and lets the name
      // forge an extra log line. (Stricter than hasControlChars(), which only
      // screens CR/LF/NUL because argv and header values may legitimately
      // contain other control bytes.)
      errors.push(errorOf(index, 'name', 'name must not contain control characters (newlines, tabs)'))
    } else if (/[<>"]/.test(raw.name)) {
      // The name is rendered into the untrusted-result boundary marker
      // (`<untrusted-tool-result server="…">`). A quote or an angle bracket
      // there closes the attribute early and moves the attack surface from the
      // wrapped text onto our own boundary — which is the ground `sanitizeUntrusted`
      // stands on (design §2.8 SEC-1). Escape at the boundary too (T04); this is
      // the entry half, so the user gets a readable error instead of a config
      // that silently deforms the marker.
      errors.push(errorOf(index, 'name', 'name must not contain quotes or angle brackets (" < >)'))
    } else {
      server.name = raw.name
    }
  }
  if (!server.name) {
    server.name = server.id
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push(errorOf(index, 'enabled', 'enabled must be a boolean'))
    } else {
      server.enabled = raw.enabled
    }
  }

  if (raw.transport === undefined) {
    errors.push(errorOf(index, 'transport', `transport is required, one of: ${TRANSPORTS.join(', ')}`))
  } else if (!TRANSPORTS.includes(raw.transport)) {
    errors.push(errorOf(index, 'transport', `transport must be one of: ${TRANSPORTS.join(', ')}`))
  } else {
    server.transport = raw.transport
  }

  if (raw.timeoutMs !== undefined) {
    if (!Number.isInteger(raw.timeoutMs) ||
      raw.timeoutMs < TIMEOUT_MIN_MS || raw.timeoutMs > TIMEOUT_MAX_MS) {
      errors.push(errorOf(index, 'timeoutMs', `timeoutMs must be an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`))
    } else {
      server.timeoutMs = raw.timeoutMs
    }
  }

  if (raw.trust !== undefined) {
    if (!TRUST_LEVELS.includes(raw.trust)) {
      errors.push(errorOf(index, 'trust', `trust must be one of: ${TRUST_LEVELS.join(', ')}`))
    } else {
      server.trust = raw.trust
    }
  }

  if (raw.autoConnect !== undefined) {
    if (typeof raw.autoConnect !== 'boolean') {
      errors.push(errorOf(index, 'autoConnect', 'autoConnect must be a boolean'))
    } else {
      server.autoConnect = raw.autoConnect
    }
  }

  if (server.transport === 'stdio') {
    if (raw.command === undefined || typeof raw.command !== 'string' || !raw.command.trim()) {
      errors.push(errorOf(index, 'command', 'stdio server requires a non-empty command'))
    } else if (raw.command.length > MAX_COMMAND_LENGTH) {
      errors.push(errorOf(index, 'command', `command must be at most ${MAX_COMMAND_LENGTH} characters`))
    } else if (hasControlChars(raw.command)) {
      errors.push(errorOf(index, 'command', 'command must not contain newlines'))
    } else {
      server.command = raw.command
    }

    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args)) {
        errors.push(errorOf(index, 'args', 'args must be an array of strings'))
      } else if (raw.args.length > MAX_ARGS) {
        errors.push(errorOf(index, 'args', `args must have at most ${MAX_ARGS} entries`))
      } else {
        const badIndex = raw.args.findIndex(arg => typeof arg !== 'string')
        if (badIndex !== -1) {
          errors.push(errorOf(index, 'args', `args[${badIndex}] must be a string`))
        } else {
          const tooLong = raw.args.findIndex(arg => arg.length > MAX_ARG_LENGTH)
          if (tooLong !== -1) {
            errors.push(errorOf(index, 'args', `args[${tooLong}] must be at most ${MAX_ARG_LENGTH} characters`))
          } else {
            server.args = raw.args.slice()
          }
        }
      }
    }

    if (raw.cwd !== undefined && raw.cwd !== null) {
      if (typeof raw.cwd !== 'string' || raw.cwd.length > MAX_CWD_LENGTH) {
        errors.push(errorOf(index, 'cwd', `cwd must be a string of at most ${MAX_CWD_LENGTH} characters`))
      } else {
        server.cwd = raw.cwd
      }
    }

    if (raw.env !== undefined && raw.env !== null) {
      if (!isPlainObject(raw.env)) {
        errors.push(errorOf(index, 'env', 'env must be an object of string values'))
      } else {
        for (const key of Object.keys(raw.env)) {
          const value = raw.env[key]
          if (!ENV_KEY_PATTERN.test(key)) {
            errors.push(errorOf(index, 'env', `env key "${key}" is not a valid environment variable name`))
            continue
          }
          if (ENV_BLACKLIST.includes(key)) {
            errors.push(errorOf(index, 'env', `env key "${key}" is not allowed: it lets a server hijack every process electerm starts`))
            warnings.push({ index, field: 'env', message: `rejected process-hijack env key: ${key}` })
            continue
          }
          if (typeof value !== 'string') {
            errors.push(errorOf(index, 'env', `env.${key} must be a string`))
            continue
          }
          if (hasControlChars(value)) {
            errors.push(errorOf(index, 'env', `env.${key} must not contain newlines`))
            continue
          }
          server.env[key] = value
        }
      }
    }
  }

  if (server.transport === 'http') {
    if (raw.url === undefined || typeof raw.url !== 'string' || !raw.url.trim()) {
      errors.push(errorOf(index, 'url', 'http server requires a non-empty url'))
    } else {
      let parsed = null
      try {
        parsed = new URL(raw.url)
      } catch (_) {
        parsed = null
      }
      if (!parsed) {
        errors.push(errorOf(index, 'url', 'url must be a valid absolute URL'))
      } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(errorOf(index, 'url', `url protocol must be http: or https:, got ${parsed.protocol}`))
      } else {
        server.url = raw.url
      }
    }

    if (raw.headers !== undefined && raw.headers !== null) {
      if (!isPlainObject(raw.headers)) {
        errors.push(errorOf(index, 'headers', 'headers must be an object of string values'))
      } else {
        for (const key of Object.keys(raw.headers)) {
          const value = raw.headers[key]
          if (!/^[A-Za-z0-9-]+$/.test(key)) {
            errors.push(errorOf(index, 'headers', `header name "${key}" is not valid`))
            continue
          }
          if (typeof value !== 'string') {
            errors.push(errorOf(index, 'headers', `headers.${key} must be a string`))
            continue
          }
          if (value.length > MAX_HEADER_VALUE_LENGTH || hasControlChars(value)) {
            errors.push(errorOf(index, 'headers', `headers.${key} is too long or contains a newline`))
            continue
          }
          server.headers[key] = value
        }
      }
    }
  }

  return { server, errors, warnings }
}

/**
 * Validate a whole server list.
 * @param {*} input raw `mcpServersAI` value
 * @param {{generateId?: Function}} [opts]
 * @returns {{ok: boolean, servers: Array<object>, errors: Array, warnings: Array}}
 */
function validateMcpServers (input, opts = {}) {
  if (input === undefined || input === null) {
    return { ok: true, servers: [], errors: [], warnings: [] }
  }
  if (!Array.isArray(input)) {
    return {
      ok: false,
      servers: [],
      errors: [errorOf(-1, 'mcpServersAI', 'mcpServersAI must be an array')],
      warnings: []
    }
  }

  const servers = []
  const errors = []
  const warnings = []
  const seenIds = new Set()

  input.forEach((raw, index) => {
    const res = normalizeServer(raw, index, opts)
    errors.push(...res.errors)
    warnings.push(...res.warnings)
    if (!res.server) {
      return
    }
    if (res.errors.length) {
      // A record with any error stays **out** of `servers`: the manager would
      // otherwise connect it as-is — an empty `command` means every attempt
      // waits out the initialize timeout, so eight broken records turn "save
      // settings" into an 80-second freeze. The errors still carry the index,
      // so the UI can highlight exactly which row to fix; nothing is dropped
      // silently.
      return
    }
    if (seenIds.has(res.server.id)) {
      errors.push(errorOf(index, 'id', `duplicate server id "${res.server.id}"`))
      return
    }
    seenIds.add(res.server.id)
    servers.push(res.server)
  })

  const enabledCount = servers.filter(server => server.enabled).length
  if (enabledCount > MAX_SERVERS) {
    errors.push(errorOf(-1, 'enabled', `at most ${MAX_SERVERS} MCP servers can be enabled, got ${enabledCount}`))
  }

  return { ok: errors.length === 0, servers, errors, warnings }
}

/**
 * Stable signature of everything that requires a reconnect when it changes.
 * `name`/`enabled`/`trust` are deliberately absent: renaming a server or
 * tightening its trust level must not kill a healthy child process.
 * @param {object} server
 * @returns {string}
 */
function connectionSignature (server) {
  if (!server) {
    return ''
  }
  return JSON.stringify([
    server.transport,
    server.command || '',
    server.args || [],
    server.cwd || '',
    Object.keys(server.env || {}).sort().map(key => [key, server.env[key]]),
    server.url || '',
    Object.keys(server.headers || {}).sort().map(key => [key, server.headers[key]])
  ])
}

module.exports = {
  TRANSPORTS,
  TRUST_LEVELS,
  MAX_SERVERS,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_COMMAND_LENGTH,
  MAX_ARGS,
  MAX_ARG_LENGTH,
  ENV_BLACKLIST,
  normalizeServer,
  validateMcpServers,
  connectionSignature
}
